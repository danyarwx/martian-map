// Holes and drop-offs from ground heights (docs/helmet/PLAN.md §5.6).
//
// Input: a height grid of 0.5 m cells (row 0 north, NaN = unknown), either the hazard grid's fused
// heights around the astronaut (wired in T4.2) or one frame's per-cell ground heights (`groundCellHeights`).
//
// Rule (scarp edge): a known cell is a drop LIP when, in one of the 8 directions, the ground falls by more
// than 1.0 m within 1.5 m horizontally (3 cells straight, 2 cells diagonally), looking at known cells only,
// and the first known cell in that direction is already lower by more than 0.30 m. The second condition
// keeps the lip one cell wide: the plateau cells behind the edge also "see" the fall within 1.5 m, but
// their next cell is the lip itself, at the same height. The lip (the HIGH side) is the hazard: it is
// where the astronaut must not walk. Unknown cells between the lip and the low cell it falls to (the
// scarp face, usually hidden) are marked drop too. Ground that falls 1 m within 1.5 m is a slope of more
// than ~34°, so a very steep face counts as a drop all the way down, which is what a walker needs.
//
// Lip cells are grouped into 8-connected segments; one Detection {kind: 'drop'} per segment, located at
// the segment's cell NEAREST TO THE CAMERA (the point that matters for "drop-off in 4 m"), radiusM = half
// its length, heightM = the largest fall. A one-cell segment is dropped as noise unless it falls > 2 m.
//
// Not implemented: the second rule of §5.6 (valid ground disappearing beyond a lip along camera rays,
// i.e. an occlusion shadow). From a single frame it cannot tell a cliff from a rock's shadow, a convex
// crest whose back slope is steeper than the line of sight, a low-texture patch or the depth limit, so it
// would paint false drops on ordinary terrain. The scarp rule on fused heights covers the demo case once
// T4.2 feeds the grid heights in; the occlusion rule can be revisited with the eval harness (T4.4).
import { HAZARD, type Detection, type HazardPatch, type HeightGrid, type Pose } from '../contracts.ts'
import { GRID_CELL_M } from '../frames.ts'
import type { GroundContext } from './ground.ts'
import type { PointCloud } from './points.ts'

export type { HeightGrid }

/**
 * Fill the unknown cells of `frame` (this frame's heights) from `fused` (heights from earlier frames), looked up
 * at each cell's centre. Cells this frame saw keep their own value. Returns the number of cells filled.
 */
export function fillFromFused(frame: HeightGrid, fused: HeightGrid, cellM = GRID_CELL_M): number {
  let n = 0
  for (let r = 0; r < frame.rows; r++) {
    const fr = Math.floor((fused.y0 - (frame.y0 - (r + 0.5) * cellM)) / cellM)
    if (fr < 0 || fr >= fused.rows) continue
    for (let c = 0; c < frame.cols; c++) {
      const i = r * frame.cols + c
      if (frame.z[i] === frame.z[i]) continue
      const fc = Math.floor((frame.x0 + (c + 0.5) * cellM - fused.x0) / cellM)
      if (fc < 0 || fc >= fused.cols) continue
      const z = fused.z[fr * fused.cols + fc]
      if (z === z) {
        frame.z[i] = z
        n++
      }
    }
  }
  return n
}

export interface DropOptions {
  cellM: number
  /** Ground must fall more than this... (metres) */
  minFallM: number
  /** ...within this horizontal distance (metres). */
  reachM: number
  /** The first known cell past a lip must be lower by more than this (metres): keeps the lip one cell wide. */
  edgeStepM: number
  /** Smallest segment kept... */
  minCells: number
  /** ...unless it falls more than this (metres). */
  bigFallM: number
  /** groundCellHeights: cells need this many points for a height. */
  frameMinPoints: number
  /** groundCellHeights: cells further than this from the camera stay unknown (stereo noise, horizon mismatches). */
  frameMaxRangeM: number
}

export const DROP_DEFAULTS: DropOptions = {
  cellM: GRID_CELL_M,
  minFallM: 1.0,
  reachM: 1.5,
  edgeStepM: 0.3,
  minCells: 2,
  bigFallM: 2.0,
  frameMinPoints: 2,
  frameMaxRangeM: 15,
}

/** Per-cell marks of the last detectDrops call. */
export const DROP_MARK = { none: 0, lip: 1, gap: 2 } as const

export interface DropContext {
  readonly opts: DropOptions
  /** Largest grid (cells) this context can take. */
  readonly capacity: number
  /** DROP_MARK per cell of the last grid. */
  readonly mark: Uint8Array
  /** Per lip cell: bit d set when it falls in direction d (see DIR_DC / DIR_DR). */
  readonly dirs: Uint8Array
  /** Per lip cell: the largest fall, metres. */
  readonly fall: Float32Array
  /** Per marked cell: its segment's confidence. */
  readonly conf: Float32Array
  readonly label: Int32Array
  readonly queue: Int32Array
}

export function createDropContext(capacity: number, opts: Partial<DropOptions> = {}): DropContext {
  return {
    opts: { ...DROP_DEFAULTS, ...opts },
    capacity,
    mark: new Uint8Array(capacity),
    dirs: new Uint8Array(capacity),
    fall: new Float32Array(capacity),
    conf: new Float32Array(capacity),
    label: new Int32Array(capacity),
    queue: new Int32Array(capacity),
  }
}

/** The 8 directions as (column, row) steps: E, SE, S, SW, W, NW, N, NE (rows grow southwards). */
const DIR_DC = [1, 1, 0, -1, -1, -1, 0, 1]
const DIR_DR = [0, 1, 1, 1, 0, -1, -1, -1]

/**
 * Find drop lips in `grid`: fills ctx.mark / ctx.conf and returns one Detection per segment.
 * `from` is the camera (or astronaut) position, local ENU, for the nearest point and the distance.
 */
export function detectDrops(ctx: DropContext, grid: HeightGrid, from: Pick<Pose, 'x' | 'y'>): Detection[] {
  const { opts, mark, dirs, fall, conf, label, queue } = ctx
  const { cols, rows, z, x0, y0 } = grid
  const N = cols * rows
  if (N > ctx.capacity) throw new Error(`height grid of ${N} cells is larger than the drop context (${ctx.capacity})`)
  const cell = opts.cellM
  const kStraight = Math.floor(opts.reachM / cell + 1e-9)
  const kDiag = Math.floor(opts.reachM / (cell * Math.SQRT2) + 1e-9)
  mark.fill(0, 0, N)
  dirs.fill(0, 0, N)
  fall.fill(0, 0, N)
  conf.fill(0, 0, N)
  label.fill(0, 0, N)

  // 1. Lip cells.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const z0 = z[i]
      if (z0 !== z0) continue // unknown
      let bits = 0
      let best = 0
      for (let d = 0; d < 8; d++) {
        const dc = DIR_DC[d]
        const dr = DIR_DR[d]
        const K = dc !== 0 && dr !== 0 ? kDiag : kStraight
        let first = NaN
        let maxFall = 0
        for (let k = 1; k <= K; k++) {
          const cc = c + k * dc
          const rr = r + k * dr
          if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) break
          const zn = z[rr * cols + cc]
          if (zn !== zn) continue
          if (first !== first) first = zn
          if (z0 - zn > maxFall) maxFall = z0 - zn
        }
        if (maxFall > opts.minFallM && z0 - first > opts.edgeStepM) {
          bits |= 1 << d
          if (maxFall > best) best = maxFall
        }
      }
      if (bits) {
        mark[i] = DROP_MARK.lip
        dirs[i] = bits
        fall[i] = best
      }
    }

  // 2. Segments of lip cells, 8-connected.
  const out: Detection[] = []
  let next = 1
  for (let seed = 0; seed < N; seed++) {
    if (mark[seed] !== DROP_MARK.lip || label[seed]) continue
    const id = next++
    let qe = 0
    queue[qe++] = seed
    label[seed] = id
    for (let qs = 0; qs < qe; qs++) {
      const q = queue[qs]
      const r = (q / cols) | 0
      const c = q - r * cols
      for (let d = 0; d < 8; d++) {
        const cc = c + DIR_DC[d]
        const rr = r + DIR_DR[d]
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue
        const nb = rr * cols + cc
        if (mark[nb] === DROP_MARK.lip && !label[nb]) {
          label[nb] = id
          queue[qe++] = nb
        }
      }
    }
    let sumFall = 0
    let maxFall = 0
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity
    let nearest = -1
    let nearestD2 = Infinity
    for (let k = 0; k < qe; k++) {
      const q = queue[k]
      const r = (q / cols) | 0
      const c = q - r * cols
      sumFall += fall[q]
      if (fall[q] > maxFall) maxFall = fall[q]
      if (c < c0) c0 = c
      if (c > c1) c1 = c
      if (r < r0) r0 = r
      if (r > r1) r1 = r
      const d2 = (x0 + (c + 0.5) * cell - from.x) ** 2 + (y0 - (r + 0.5) * cell - from.y) ** 2
      if (d2 < nearestD2) {
        nearestD2 = d2
        nearest = q
      }
    }
    if (qe < opts.minCells && !(maxFall > opts.bigFallM)) {
      for (let k = 0; k < qe; k++) mark[queue[k]] = DROP_MARK.none // noise
      continue
    }
    // A deeper fall and a longer edge make a surer drop: 1 m → 0.5, 2 m → 1; 2 cells → 0.85, 3+ → 1.
    const meanFall = sumFall / qe
    const confidence =
      Math.min(1, 0.5 + (0.5 * (meanFall - opts.minFallM)) / opts.minFallM) * Math.min(1, 0.55 + 0.15 * qe)
    for (let k = 0; k < qe; k++) conf[queue[k]] = confidence
    const nr = (nearest / cols) | 0
    const nc = nearest - nr * cols
    const nx = x0 + (nc + 0.5) * cell
    const ny = y0 - (nr + 0.5) * cell
    out.push({
      kind: 'drop',
      x: nx,
      y: ny,
      radiusM: (Math.hypot(c1 - c0, r1 - r0) * cell + cell) / 2,
      heightM: maxFall,
      distanceM: Math.sqrt(nearestD2),
      confidence,
    })
  }

  // 3. Unknown cells between a kept lip and the lower ground it falls to.
  for (let i = 0; i < N; i++) {
    if (mark[i] !== DROP_MARK.lip) continue
    const r = (i / cols) | 0
    const c = i - r * cols
    for (let d = 0; d < 8; d++) {
      if (!(dirs[i] & (1 << d))) continue
      const dc = DIR_DC[d]
      const dr = DIR_DR[d]
      const K = dc !== 0 && dr !== 0 ? kDiag : kStraight
      for (let k = 1; k <= K; k++) {
        const nb = (r + k * dr) * cols + (c + k * dc) // in bounds: the lip found a known cell this way
        if (z[nb] === z[nb]) break // the first known cell ends the gap
        if (mark[nb] === DROP_MARK.none) mark[nb] = DROP_MARK.gap
        if (conf[i] > conf[nb]) conf[nb] = conf[i]
      }
    }
  }
  return out
}

/**
 * Paint the drop cells of the last detectDrops call (on `grid`) into `patch` as HAZARD.drop, matching
 * cells by position (both on the 0.5 m lattice). Rock cells are never overwritten. Returns cells painted.
 */
export function mergeDrops(ctx: DropContext, grid: HeightGrid, patch: HazardPatch): number {
  const { mark, conf } = ctx
  const cell = ctx.opts.cellM
  const dc = Math.round((grid.x0 - patch.x0) / cell)
  const dr = Math.round((patch.y0 - grid.y0) / cell)
  let n = 0
  for (let r = 0; r < grid.rows; r++) {
    const pr = r + dr
    if (pr < 0 || pr >= patch.rows) continue
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c
      if (mark[i] === DROP_MARK.none) continue
      const pc = c + dc
      if (pc < 0 || pc >= patch.cols) continue
      const k = pr * patch.cols + pc
      if (patch.cls[k] === HAZARD.rock) continue
      patch.cls[k] = HAZARD.drop
      patch.conf[k] = conf[i]
      n++
    }
  }
  return n
}

/**
 * One frame's ground height per patch cell, for detectDrops: the cell's ground-candidate point (20th
 * height percentile, ground.ts) where the cell has enough points, is within range and is not a rock
 * (a rock's top over the ground next to it is not a drop). Run after detectObstacles. Writes into `out`
 * (whose `z` must hold ground.nCells values) and returns it.
 */
export function groundCellHeights(
  ground: GroundContext,
  cloud: PointCloud,
  pose: Pick<Pose, 'x' | 'y'>,
  out: HeightGrid,
  opts: Pick<DropOptions, 'frameMinPoints' | 'frameMaxRangeM'> = DROP_DEFAULTS,
): HeightGrid {
  const { cols, rows, patch, candidate, cellStart } = ground
  const cell = ground.opts.cellM
  const z = out.z
  if (z.length < cols * rows) throw new Error('height grid buffer smaller than the ground patch')
  const range2 = opts.frameMaxRangeM * opts.frameMaxRangeM
  for (let r = 0; r < rows; r++) {
    const dy = patch.y0 - (r + 0.5) * cell - pose.y
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const p = candidate[i]
      const dx = patch.x0 + (c + 0.5) * cell - pose.x
      z[i] =
        p < 0 || cellStart[i + 1] - cellStart[i] < opts.frameMinPoints || patch.cls[i] === HAZARD.rock || dx * dx + dy * dy > range2
          ? NaN
          : cloud.xyz[p * 3 + 2]
    }
  }
  out.x0 = patch.x0
  out.y0 = patch.y0
  out.cols = cols
  out.rows = rows
  return out
}
