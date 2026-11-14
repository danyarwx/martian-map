// Top-down hazard map the helmet builds as it walks (docs/helmet/PLAN.md §5.7).
//
// 0.5 m cells in local ENU (frames.ts), anchored at the session origin: cell (col, row) covers
// x in [col·0.5, (col+1)·0.5) and y in (−(row+1)·0.5, −row·0.5], so row 0 is north and indices may be
// negative. Memory is allocated in 64 m blocks (128 × 128 cells) on first write, so the map grows
// with the walk and costs nothing where the astronaut has not looked.
//
// Fusion: every cell keeps one log-odds value per class ("this cell is safe / rock / sand / steep / drop").
// An observation of class k with confidence p adds log(p/(1−p)) to L[k] and lets the other classes decay
// toward 0 (unknown). A safe observation also counts as evidence against every hazard, at half weight,
// so a rock that was a false detection fades after a few clear views, but more slowly than it appeared:
// for a walker a missed rock is worse than a false one. Every L stays within ±4 (p 0.018..0.982).
import type { LatLon, TerrainMeta } from '../../types.ts'
import { inGrid, toCell } from '../../lib/geo.ts'
import { HAZARD, type Detection, type HazardClass, type HazardPatch } from '../contracts.ts'
import { GRID_CELL_M, gridCellCenter, gridIndex, toLatLon } from '../frames.ts'

/** Cells along one side of a block: 128 × 0.5 m = 64 m. */
export const BLOCK_CELLS = 128
const BLOCK_N = BLOCK_CELLS * BLOCK_CELLS
/** Log-odds stay within ±this. */
export const L_MAX = 4
/** Factor applied each update to the classes a cell was not observed as. */
export const DECAY = 0.98
/** Share of a safe observation's log-odds taken off every hazard class of the cell. */
export const SAFE_CLEARS = 0.5
const P_MIN = 0.05
const P_MAX = 0.95
/** Weight of a new ground height against the fused one. */
const GROUND_BLEND = 0.3

/** Classes with a log-odds slot, in slot order (slot = class − 1). */
const CLASSES = [HAZARD.safe, HAZARD.rock, HAZARD.sand, HAZARD.steep, HAZARD.drop] as const
/** Hazard classes in the order ties are broken (first wins). */
const HAZARDS = [HAZARD.drop, HAZARD.rock, HAZARD.steep, HAZARD.sand] as const
const KIND: Record<number, Detection['kind']> = {
  [HAZARD.rock]: 'rock',
  [HAZARD.sand]: 'sand',
  [HAZARD.steep]: 'steep',
  [HAZARD.drop]: 'drop',
}

/** RGBA per HazardClass (PLAN §7.3, same as the --hz-* tokens in helmet.css). Unseen is transparent. */
export const HAZARD_RGBA: Record<HazardClass, readonly [number, number, number, number]> = {
  0: [0, 0, 0, 0],
  1: [143, 227, 214, 89], // rgba(143,227,214,0.35)
  2: [255, 90, 78, 255], // #ff5a4e
  3: [232, 176, 74, 255], // #e8b04a
  4: [255, 138, 61, 255], // #ff8a3d
  5: [176, 74, 255, 255], // #b04aff
}

/** Rectangle in local ENU metres. */
export interface LocalBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The grid as a picture: one pixel per 0.5 m cell, row 0 north. (x0, y0) is the local NW corner. */
export interface HazardImage {
  width: number
  height: number
  rgba: Uint8ClampedArray
  x0: number
  y0: number
}

/** A merged patch of one hazard class. Centre in local ENU metres; the circle covers every cell of it. */
export interface HazardCluster {
  x: number
  y: number
  radiusM: number
  kind: Detection['kind']
  cells: number
}

interface Block {
  /** Log-odds per class slot (see CLASSES), BLOCK_N each. */
  L: Float32Array[]
  /** Fused ground height, metres, NaN unknown. */
  groundZ: Float32Array
  /** Frame id of the last observation, −1 never seen. */
  seenAt: Int32Array
}

const blockKey = (bc: number, br: number) => (bc + 32768) * 65536 + (br + 32768)
const clampL = (v: number) => (v > L_MAX ? L_MAX : v < -L_MAX ? -L_MAX : v)
const sigmoid = (l: number) => 1 / (1 + Math.exp(-l))

/** Lat/lon rectangle of a hazard image, for a Leaflet ImageOverlay or HelmetExit.seen. */
export function toLatLonBounds(
  img: Pick<HazardImage, 'width' | 'height' | 'x0' | 'y0'>,
  origin: LatLon,
): { west: number; south: number; east: number; north: number } {
  const nw = toLatLon(img.x0, img.y0, origin)
  const se = toLatLon(img.x0 + img.width * GRID_CELL_M, img.y0 - img.height * GRID_CELL_M, origin)
  return { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat }
}

export class HazardGrid {
  private blocks = new Map<number, Block>()
  /** Seen extent in cells, inclusive. Empty while minCol > maxCol. */
  private minCol = Infinity
  private maxCol = -Infinity
  private minRow = Infinity
  private maxRow = -Infinity

  /** Number of allocated 64 m blocks. */
  get blockCount(): number {
    return this.blocks.size
  }

  /** Seen extent in local ENU metres (cell edges), or null before the first observation. */
  extent(): LocalBounds | null {
    if (this.minCol > this.maxCol) return null
    return {
      minX: this.minCol * GRID_CELL_M,
      maxX: (this.maxCol + 1) * GRID_CELL_M,
      maxY: -this.minRow * GRID_CELL_M + 0,
      minY: -(this.maxRow + 1) * GRID_CELL_M + 0,
    }
  }

  /**
   * Fuses one CV patch. Cells with class 0 in the patch were not observed and are left alone.
   * `groundZ` (optional, one value per patch cell, NaN unknown) updates the fused ground height.
   */
  update(patch: HazardPatch, frameId: number, groundZ?: Float32Array): void {
    const { cols, rows, cls, conf } = patch
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c
        const observed = cls[k]
        if (observed === HAZARD.unseen || observed > HAZARD.drop) continue
        // Locate by the cell centre, so a patch a hair off the 0.5 m lattice still lands in the right cell.
        const cx = patch.x0 + (c + 0.5) * GRID_CELL_M
        const cy = patch.y0 - (r + 0.5) * GRID_CELL_M
        const { col, row } = gridIndex(cx, cy, 0, 0)
        const b = this.blockFor(col, row, true)!
        const i = this.local(col, row)

        const p = Math.min(P_MAX, Math.max(P_MIN, conf[k]))
        const l = Math.log(p / (1 - p))
        for (let s = 0; s < CLASSES.length; s++) {
          const arr = b.L[s]
          if (CLASSES[s] === observed) arr[i] = clampL(arr[i] + l)
          else {
            let v = arr[i] * DECAY
            if (observed === HAZARD.safe && l > 0) v -= SAFE_CLEARS * l
            arr[i] = clampL(v)
          }
        }
        b.seenAt[i] = frameId

        if (groundZ) {
          const z = groundZ[k]
          if (Number.isFinite(z)) {
            const old = b.groundZ[i]
            b.groundZ[i] = Number.isNaN(old) ? z : old + GROUND_BLEND * (z - old)
          }
        }
        if (col < this.minCol) this.minCol = col
        if (col > this.maxCol) this.maxCol = col
        if (row < this.minRow) this.minRow = row
        if (row > this.maxRow) this.maxRow = row
      }
    }
  }

  /** Class of the cell holding local point (x, y). */
  classAt(x: number, y: number): HazardClass {
    const { col, row } = gridIndex(x, y, 0, 0)
    return this.classAtCell(col, row)
  }

  /** Probability of the cell's class (0 for unseen). */
  confAt(x: number, y: number): number {
    const { col, row } = gridIndex(x, y, 0, 0)
    const b = this.blockFor(col, row, false)
    if (!b) return 0
    const i = this.local(col, row)
    const cls = this.classOf(b, i)
    return cls === HAZARD.unseen ? 0 : sigmoid(b.L[cls - 1][i])
  }

  /** Fused ground height at (x, y), metres, NaN when unknown. */
  groundAt(x: number, y: number): number {
    const { col, row } = gridIndex(x, y, 0, 0)
    const b = this.blockFor(col, row, false)
    return b ? b.groundZ[this.local(col, row)] : NaN
  }

  /** Frame id of the last observation of the cell holding (x, y), −1 never. */
  seenAtXY(x: number, y: number): number {
    const { col, row } = gridIndex(x, y, 0, 0)
    const b = this.blockFor(col, row, false)
    return b ? b.seenAt[this.local(col, row)] : -1
  }

  /** Class of grid cell (col, row): unseen until observed; else the likeliest hazard above 0.5, else safe. */
  classAtCell(col: number, row: number): HazardClass {
    const b = this.blockFor(col, row, false)
    return b ? this.classOf(b, this.local(col, row)) : HAZARD.unseen
  }

  /** The grid as RGBA (PLAN §7.3 colours), over `bounds` in local metres or the seen extent. */
  toImage(bounds?: LocalBounds): HazardImage {
    const b = bounds ?? this.extent()
    if (!b) return { width: 0, height: 0, rgba: new Uint8ClampedArray(0), x0: 0, y0: 0 }
    const c0 = Math.floor(b.minX / GRID_CELL_M)
    const c1 = Math.ceil(b.maxX / GRID_CELL_M)
    const r0 = Math.floor(-b.maxY / GRID_CELL_M)
    const r1 = Math.ceil(-b.minY / GRID_CELL_M)
    const width = Math.max(0, c1 - c0)
    const height = Math.max(0, r1 - r0)
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const cls = this.classAtCell(c0 + c, r0 + r)
        if (cls === HAZARD.unseen) continue
        const o = (r * width + c) * 4
        const rgb = HAZARD_RGBA[cls]
        rgba[o] = rgb[0]
        rgba[o + 1] = rgb[1]
        rgba[o + 2] = rgb[2]
        rgba[o + 3] = rgb[3]
      }
    }
    return { width, height, rgba, x0: c0 * GRID_CELL_M + 0, y0: -r0 * GRID_CELL_M + 0 } // + 0 turns −0 into 0
  }

  /** Hazard cells merged into 8-connected clusters of one class, those of at least `minCells` cells. */
  hazardsList(minCells = 2): HazardCluster[] {
    const out: HazardCluster[] = []
    const visited = new Map<number, Uint8Array>()
    const mark = (col: number, row: number): boolean => {
      const key = blockKey(Math.floor(col / BLOCK_CELLS), Math.floor(row / BLOCK_CELLS))
      let v = visited.get(key)
      if (!v) visited.set(key, (v = new Uint8Array(BLOCK_N)))
      const i = this.local(col, row)
      if (v[i]) return false
      v[i] = 1
      return true
    }
    for (const [key, block] of this.blocks) {
      const bc = Math.floor(key / 65536) - 32768
      const br = (key % 65536) - 32768
      for (let i = 0; i < BLOCK_N; i++) {
        const cls = this.classOf(block, i)
        if (cls < HAZARD.rock) continue
        const col = bc * BLOCK_CELLS + (i % BLOCK_CELLS)
        const row = br * BLOCK_CELLS + ((i / BLOCK_CELLS) | 0)
        if (!mark(col, row)) continue
        // Flood fill this cluster.
        const cells: number[] = [col, row]
        const stack = [col, row]
        while (stack.length > 0) {
          const r = stack.pop()!
          const c = stack.pop()!
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dc === 0 && dr === 0) continue
              const nc = c + dc
              const nr = r + dr
              if (this.classAtCell(nc, nr) !== cls || !mark(nc, nr)) continue
              cells.push(nc, nr)
              stack.push(nc, nr)
            }
          }
        }
        const n = cells.length / 2
        if (n < minCells) continue
        let sx = 0
        let sy = 0
        for (let k = 0; k < cells.length; k += 2) {
          const p = gridCellCenter(cells[k], cells[k + 1], 0, 0)
          sx += p.x
          sy += p.y
        }
        const x = sx / n
        const y = sy / n
        let far = 0
        for (let k = 0; k < cells.length; k += 2) {
          const p = gridCellCenter(cells[k], cells[k + 1], 0, 0)
          far = Math.max(far, Math.hypot(p.x - x, p.y - y))
        }
        out.push({ x, y, radiusM: far + GRID_CELL_M / 2, kind: KIND[cls], cells: n })
      }
    }
    return out
  }

  /**
   * Planner-grid cells (index row·width + col of `meta`, see src/lib/geo.ts toCell) whose area is covered
   * by rock, steep or drop cells to at least `coverage` (0..1). Each 0.5 m cell counts for the planner cell
   * holding its centre. `origin` is the session origin of the local frame.
   */
  blockedPlannerCells(meta: TerrainMeta, origin: LatLon, coverage = 0.3): Set<number> {
    const counts = new Map<number, number>()
    for (const [key, block] of this.blocks) {
      const bc = Math.floor(key / 65536) - 32768
      const br = (key % 65536) - 32768
      for (let i = 0; i < BLOCK_N; i++) {
        const cls = this.classOf(block, i)
        if (cls !== HAZARD.rock && cls !== HAZARD.steep && cls !== HAZARD.drop) continue
        const p = gridCellCenter(bc * BLOCK_CELLS + (i % BLOCK_CELLS), br * BLOCK_CELLS + ((i / BLOCK_CELLS) | 0), 0, 0)
        const { col, row } = toCell(meta, toLatLon(p.x, p.y, origin))
        if (!inGrid(meta, col, row)) continue
        const idx = row * meta.width + col
        counts.set(idx, (counts.get(idx) ?? 0) + 1)
      }
    }
    const need = (coverage * meta.cellMetersX * meta.cellMetersY) / (GRID_CELL_M * GRID_CELL_M)
    const out = new Set<number>()
    for (const [idx, n] of counts) if (n >= need) out.add(idx)
    return out
  }

  private classOf(b: Block, i: number): HazardClass {
    if (b.seenAt[i] < 0) return HAZARD.unseen
    let best: HazardClass = HAZARD.safe
    let bestL = 0 // a hazard needs probability above 0.5
    for (const h of HAZARDS) {
      const l = b.L[h - 1][i]
      if (l > bestL) {
        bestL = l
        best = h
      }
    }
    return best
  }

  /** Index of (col, row) inside its block. */
  private local(col: number, row: number): number {
    const lc = col - Math.floor(col / BLOCK_CELLS) * BLOCK_CELLS
    const lr = row - Math.floor(row / BLOCK_CELLS) * BLOCK_CELLS
    return lr * BLOCK_CELLS + lc
  }

  private blockFor(col: number, row: number, create: boolean): Block | undefined {
    const key = blockKey(Math.floor(col / BLOCK_CELLS), Math.floor(row / BLOCK_CELLS))
    let b = this.blocks.get(key)
    if (!b && create) {
      b = {
        L: CLASSES.map(() => new Float32Array(BLOCK_N)),
        groundZ: new Float32Array(BLOCK_N).fill(NaN),
        seenAt: new Int32Array(BLOCK_N).fill(-1),
      }
      this.blocks.set(key, b)
    }
    return b
  }
}
