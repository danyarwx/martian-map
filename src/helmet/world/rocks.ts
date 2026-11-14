// Rocks too small for orbit to see, scattered with published statistics (docs/helmet/PLAN.md §6.2).
// Pure: no three.js, so collision, the eval harness and Node tests see exactly the rocks that are drawn.
//
// Size-frequency: Golombek & Rapp (1997), cumulative fractional area covered by rocks of diameter ≥ D:
//   F(D) = k·exp(−q·D),  q = 1.79 + 0.152/k
// which gives a number density per m² per metre of diameter of n(D) = (4kq/π)·exp(−q·D)/D².
// Diameters 0.15–1.5 m (HiRISE resolves boulders from ~1.5 m, so bigger ones would already be in the DTM/ortho).
//
// Rock abundance k, per 8 m × 8 m cell of a tile:
//   k = 0.12 ("rough", bedrock / rocky) where the 25 cm ortho is rough: standard deviation of the gray values in the
//            cell's 32 × 32 pixels above ROUGH_STD (20 of 255, about the 75th percentile over all demo tiles);
//   k = 0.05 (smooth crater floor) elsewhere and on coarse tiles (no ortho).
// No rock is placed where the tile's sand mask says sand. Placement is deterministic: the generator is seeded from
// the tile id, so every session, the collision code and the eval harness get the same rocks.
//
// Demo boulder field ("placed for the demo", not from statistics): for each demo window, 8–14 rocks of 0.5–1.2 m
// (tall for their width, so every one stands more than a step high) in a band across the planned path 240 m before the stop (60 % into the last 600 m), so the CV sees an obstacle
// on the route and the re-route moment always happens. The path is the active plan's leg into that stop when the
// helmet was opened from Mission control, else the demo excursion's (routes.ts).
import type { LatLon } from '../../types.ts'
import { headingToDir, toLatLon, toLocal } from '../frames.ts'
import { hashString, mulberry32 } from './noise.ts'
import { cumulativeM, pointAtDistance } from './path.ts'
import { approachPath, type RoutesFileLeg } from './routes.ts'
import { bilinear129, CELLS, tileBounds, tileId, tileOf, type TileGridSpec, type TileWindow } from './tileGrid.ts'

export const D_MIN = 0.15
export const D_MAX = 1.5
export const K_SMOOTH = 0.05
export const K_ROUGH = 0.12
/** Share of a rock's height below the ground. */
export const BURY = 0.3
/** Size of the cells k is decided on, metres. */
export const ROUGH_CELL_M = 8
/** Gray-value standard deviation (0..255) above which an 8 m cell of the ortho counts as rough. */
export const ROUGH_STD = 20

/** Golombek & Rapp (1997) q for a rock abundance k. */
export function qFor(k: number): number {
  return 1.79 + 0.152 / k
}

/** Cumulative fractional area covered by rocks of diameter ≥ D. */
export function cumulativeArea(k: number, D: number): number {
  return k * Math.exp(-qFor(k) * D)
}

interface SizeTable {
  /** Rocks per m² with D_MIN ≤ D ≤ D_MAX. */
  density: number
  /** Inverse CDF samples: diameter at u = i / (N − 1). */
  inv: Float64Array
}

const tables = new Map<number, SizeTable>()

/** Number density and an inverse-CDF table for the diameters, for abundance k. */
export function sizeTable(k: number): SizeTable {
  const cached = tables.get(k)
  if (cached) return cached
  const q = qFor(k)
  const N = 4096
  const ds = new Float64Array(N)
  const cdf = new Float64Array(N)
  const pdf = (D: number) => Math.exp(-q * D) / (D * D)
  for (let i = 0; i < N; i++) ds[i] = D_MIN + ((D_MAX - D_MIN) * i) / (N - 1)
  for (let i = 1; i < N; i++) cdf[i] = cdf[i - 1] + ((pdf(ds[i - 1]) + pdf(ds[i])) / 2) * (ds[i] - ds[i - 1])
  const integral = cdf[N - 1]
  const M = 2048
  const inv = new Float64Array(M)
  let j = 0
  for (let m = 0; m < M; m++) {
    const u = (m / (M - 1)) * integral
    while (j < N - 2 && cdf[j + 1] < u) j++
    const t = cdf[j + 1] > cdf[j] ? (u - cdf[j]) / (cdf[j + 1] - cdf[j]) : 0
    inv[m] = ds[j] + Math.min(1, Math.max(0, t)) * (ds[j + 1] - ds[j])
  }
  const table = { density: ((4 * k * q) / Math.PI) * integral, inv }
  tables.set(k, table)
  return table
}

function sampleDiameter(t: SizeTable, u: number): number {
  const f = u * (t.inv.length - 1)
  const i = Math.min(t.inv.length - 2, Math.floor(f))
  return t.inv[i] + (t.inv[i + 1] - t.inv[i]) * (f - i)
}

function poisson(lambda: number, rnd: () => number): number {
  const L = Math.exp(-lambda)
  let k = 0
  let p = rnd()
  while (p > L) {
    k++
    p *= rnd()
  }
  return k
}

/**
 * Rough-cell grid of a tile from its ortho pixels (512 × 512, any channel count, gray in channel 0):
 * 16 × 16 cells of 8 m, 1 = rough (k = K_ROUGH). Row 0 north.
 */
export function roughGrid(pixels: ArrayLike<number>, size = 512, channels = 4): Uint8Array {
  const cells = Math.round(128 / ROUGH_CELL_M)
  const px = size / cells
  const out = new Uint8Array(cells * cells)
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      let s = 0
      let s2 = 0
      for (let y = r * px; y < (r + 1) * px; y++) {
        for (let x = c * px; x < (c + 1) * px; x++) {
          const v = pixels[(y * size + x) * channels]
          s += v
          s2 += v * v
        }
      }
      const n = px * px
      const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2))
      out[r * cells + c] = std > ROUGH_STD ? 1 : 0
    }
  }
  return out
}

/** One rock, in local ENU of the session. */
export interface Rock {
  x: number
  y: number
  /** Ground height under the centre (areoid metres). The rock's base is BURY·h below it. */
  z: number
  /** Diameter (longest horizontal axis), metres. */
  d: number
  /** Full height, metres. */
  h: number
  /** Second horizontal axis as a share of d (0.7..1). */
  w: number
  /** Rotation about the vertical, radians. */
  rot: number
  /** Small lean, radians. */
  tilt: number
  /** Which of the mesh variants. */
  variant: number
  /** Placed for the demo (boulder field), not from the statistics. */
  demo: boolean
}

/** A demo boulder, in geographic coordinates so it does not depend on the session origin. */
export interface DemoRock {
  lat: number
  lon: number
  d: number
  h: number
  w: number
  rot: number
  variant: number
}

export interface DemoField {
  stopId: string
  /** routes.json leg used (may be walked reversed). */
  legId: string
  /** Middle of the band, on the path, and the direction of travel there. */
  center: LatLon
  headingDeg: number
  rocks: DemoRock[]
}

/** Metres before the stop where the boulder field sits: 60 % into the last 600 m. */
export const DEMO_BEFORE_STOP_M = 240
/** Half-width of the band across the path, metres. */
export const DEMO_HALF_WIDTH_M = 6

/** One demo boulder field per window (see the header). Deterministic. */
export function demoBoulderFields(
  windows: readonly TileWindow[],
  legs: readonly RoutesFileLeg[],
  /** The path the crew really walks into a stop (from the active plan); wins over the routes.json approach. */
  planned?: (stopId: string) => { legId: string; path: LatLon[] } | null,
): DemoField[] {
  const out: DemoField[] = []
  for (const w of windows) {
    const ap = planned?.(w.id) ?? approachPath(w.id, legs)
    if (!ap || ap.path.length < 2) continue
    const cum = cumulativeM(ap.path)
    const at = pointAtDistance(ap.path, cum[cum.length - 1] - DEMO_BEFORE_STOP_M, cum)
    const rnd = mulberry32(hashString('demo:' + w.id))
    const count = 8 + Math.floor(rnd() * 7)
    const fwd = headingToDir(at.headingDeg)
    const right = headingToDir(at.headingDeg + 90)
    const rocks: DemoRock[] = []
    for (let k = 0; k < count; k++) {
      const across = -DEMO_HALF_WIDTH_M + (2 * DEMO_HALF_WIDTH_M * (k + 0.5)) / count + (rnd() - 0.5) * 0.6
      const along = (rnd() - 0.5) * 4
      const d = 0.5 + 0.7 * rnd()
      const p = toLatLon(right.x * across + fwd.x * along, right.y * across + fwd.y * along, at.at)
      rocks.push({ lat: p.lat, lon: p.lon, d, h: d * (0.9 + 0.1 * rnd()), w: 0.75 + 0.25 * rnd(), rot: rnd() * Math.PI * 2, variant: Math.floor(rnd() * VARIANTS) })
    }
    out.push({ stopId: w.id, legId: ap.legId, center: at.at, headingDeg: at.headingDeg, rocks })
  }
  return out
}

/** Number of rock mesh variants. */
export const VARIANTS = 4

export interface TileRockInput {
  row: number
  col: number
  grid: TileGridSpec
  origin: LatLon
  /** 129 × 129 ground heights (metres); without them z = 0. */
  heights?: Float32Array | null
  /** 256 × 256 sand mask at 0.5 m, 1 = sand. */
  sand?: Uint8Array | null
  /** 16 × 16 rough cells (roughGrid), 1 = rough. Without it the whole tile is smooth floor. */
  rough?: Uint8Array | null
  /** Demo boulders that fall inside this tile. */
  demo?: readonly DemoRock[]
}

/** All rocks of one tile, natural ones first, then the demo boulders. Deterministic for a tile id. */
export function rocksInTile(id: string, inp: TileRockInput): Rock[] {
  const b = tileBounds(inp.row, inp.col, inp.grid)
  const nw = toLocal({ lat: b.north, lon: b.west }, inp.origin)
  const se = toLocal({ lat: b.south, lon: b.east }, inp.origin)
  const sx = (se.x - nw.x) / CELLS // local metres per tile metre, east
  const sy = (nw.y - se.y) / CELLS
  const groundAt = (e: number, s: number) => (inp.heights ? bilinear129(inp.heights, s, e) : 0)

  // demo boulders first (they push natural rocks out of their way)
  const demo: Rock[] = []
  for (const r of inp.demo ?? []) {
    const p = toLocal(r, inp.origin)
    const e = (p.x - nw.x) / sx
    const s = (nw.y - p.y) / sy
    demo.push({ x: p.x, y: p.y, z: groundAt(e, s), d: r.d, h: r.h, w: r.w, rot: r.rot, tilt: 0, variant: r.variant, demo: true })
  }

  const rnd = mulberry32(hashString('rocks:' + id))
  const cells = Math.round(128 / ROUGH_CELL_M)
  const smooth = sizeTable(K_SMOOTH)
  const rocky = sizeTable(K_ROUGH)
  const cellArea = ROUGH_CELL_M * ROUGH_CELL_M
  const sandPx = inp.sand ? Math.round(Math.sqrt(inp.sand.length)) : 0
  const out: Rock[] = []
  for (let cr = 0; cr < cells; cr++) {
    for (let cc = 0; cc < cells; cc++) {
      const t = inp.rough && inp.rough[cr * cells + cc] ? rocky : smooth
      const n = poisson(t.density * cellArea, rnd)
      for (let k = 0; k < n; k++) {
        // draw every number even for rejected rocks, so one rejection does not reshuffle the rest of the tile
        const e = (cc + rnd()) * ROUGH_CELL_M
        const s = (cr + rnd()) * ROUGH_CELL_M
        const d = sampleDiameter(t, rnd())
        const hr = 0.45 + 0.35 * rnd()
        const w = 0.7 + 0.3 * rnd()
        const rot = rnd() * Math.PI * 2
        const tilt = (rnd() - 0.5) * 0.4
        const variant = Math.floor(rnd() * VARIANTS)
        if (inp.sand) {
          const pc = Math.min(sandPx - 1, Math.floor((e / 128) * sandPx))
          const pr = Math.min(sandPx - 1, Math.floor((s / 128) * sandPx))
          if (inp.sand[pr * sandPx + pc]) continue
        }
        const x = nw.x + e * sx
        const y = nw.y - s * sy
        let clash = false
        for (const r of demo) {
          if (Math.hypot(r.x - x, r.y - y) < (r.d + d) / 2) {
            clash = true
            break
          }
        }
        if (clash) continue
        out.push({ x, y, z: groundAt(e, s), d, h: d * hr, w, rot, tilt, variant, demo: false })
      }
    }
  }
  return out.concat(demo)
}

/** Demo boulders grouped by the id of the tile holding them. */
export function demoRocksByTile(fields: readonly DemoField[], grid: TileGridSpec): Map<string, DemoRock[]> {
  const m = new Map<string, DemoRock[]>()
  for (const f of fields) {
    for (const r of f.rocks) {
      const t = tileOf(r.lat, r.lon, grid)
      const id = tileId(t.row, t.col)
      const list = m.get(id)
      if (list) list.push(r)
      else m.set(id, [r])
    }
  }
  return m
}

/** Bucket size for the per-tile spatial index, metres. */
const BUCKET_M = 8

interface TileRocks {
  id: string
  rocks: Rock[]
  x0: number
  y1: number
  /** Rock indices sorted by bucket; bucketStart[b]..bucketStart[b+1] are bucket b's. */
  order: Uint32Array
  bucketStart: Uint32Array
  nb: number
  /** Index of the first rock of each size class in `bySize` (small < 0.3 m ≤ medium < 0.6 m ≤ large, demo last). */
  bySize: { small: Uint32Array; medium: Uint32Array; large: Uint32Array }
}

/** Largest rock radius, for search margins. */
const MAX_R = D_MAX / 2

/** All rocks of the loaded tiles, with a fast neighbourhood query. */
export class RockField {
  private tiles = new Map<string, TileRocks>()
  /** Bumped on every change, so renderers know to refresh. */
  version = 0

  setTile(id: string, rocks: Rock[]): void {
    let x0 = Infinity
    let y1 = -Infinity
    let x1 = -Infinity
    let y0 = Infinity
    for (const r of rocks) {
      x0 = Math.min(x0, r.x)
      x1 = Math.max(x1, r.x)
      y0 = Math.min(y0, r.y)
      y1 = Math.max(y1, r.y)
    }
    if (!rocks.length) x0 = y1 = x1 = y0 = 0
    const nbx = Math.max(1, Math.ceil((x1 - x0) / BUCKET_M) + 1)
    const nby = Math.max(1, Math.ceil((y1 - y0) / BUCKET_M) + 1)
    const nb = Math.max(nbx, nby)
    const bucketOf = (r: Rock) => Math.floor((y1 - r.y) / BUCKET_M) * nb + Math.floor((r.x - x0) / BUCKET_M)
    const counts = new Uint32Array(nb * nb + 1)
    for (const r of rocks) counts[bucketOf(r) + 1]++
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1]
    const fill = counts.slice()
    const order = new Uint32Array(rocks.length)
    rocks.forEach((r, i) => {
      order[fill[bucketOf(r)]++] = i
    })
    const small: number[] = []
    const medium: number[] = []
    const large: number[] = []
    rocks.forEach((r, i) => (r.demo || r.d >= 0.6 ? large : r.d >= 0.3 ? medium : small).push(i))
    this.tiles.set(id, {
      id,
      rocks,
      x0,
      y1,
      order,
      bucketStart: counts,
      nb,
      bySize: { small: Uint32Array.from(small), medium: Uint32Array.from(medium), large: Uint32Array.from(large) },
    })
    this.version++
  }

  removeTile(id: string): void {
    if (this.tiles.delete(id)) this.version++
  }

  hasTile(id: string): boolean {
    return this.tiles.has(id)
  }

  /** Rocks whose edge is within `r` metres of local (x, y) (centre distance ≤ r + d/2). */
  rocksNear(x: number, y: number, r: number): Rock[] {
    const out: Rock[] = []
    const reach = r + MAX_R
    for (const t of this.tiles.values()) {
      const c0 = Math.floor((x - reach - t.x0) / BUCKET_M)
      const c1 = Math.floor((x + reach - t.x0) / BUCKET_M)
      const r0 = Math.floor((t.y1 - (y + reach)) / BUCKET_M)
      const r1 = Math.floor((t.y1 - (y - reach)) / BUCKET_M)
      if (c1 < 0 || r1 < 0 || c0 >= t.nb || r0 >= t.nb) continue
      for (let br = Math.max(0, r0); br <= Math.min(t.nb - 1, r1); br++) {
        for (let bc = Math.max(0, c0); bc <= Math.min(t.nb - 1, c1); bc++) {
          const b = br * t.nb + bc
          for (let k = t.bucketStart[b]; k < t.bucketStart[b + 1]; k++) {
            const rock = t.rocks[t.order[k]]
            if (Math.hypot(rock.x - x, rock.y - y) <= r + rock.d / 2) out.push(rock)
          }
        }
      }
    }
    return out
  }

  /** Every loaded tile's rocks (for renderers). */
  *tileRocks(): IterableIterator<{ id: string; rocks: Rock[]; bySize: TileRocks['bySize']; x0: number; y1: number }> {
    yield* this.tiles.values()
  }

  /** Demo boulders currently loaded. */
  demoRocks(): Rock[] {
    const out: Rock[] = []
    for (const t of this.tiles.values()) for (const k of t.bySize.large) if (t.rocks[k].demo) out.push(t.rocks[k])
    return out
  }

  get count(): number {
    let n = 0
    for (const t of this.tiles.values()) n += t.rocks.length
    return n
  }
}
