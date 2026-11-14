// Rocks and other obstacles from height above ground (docs/helmet/PLAN.md §5.3).
//
// A 0.5 m cell is an obstacle when at least 3 of its points rise more than 0.30 m above the local ground:
// 0.30 m is the step a suited astronaut carrying gear can take safely (a planning assumption of PLAN §5.3,
// not a measurement). Obstacle cells are grouped into 8-connected components. A component of a single
// cell is dropped as noise unless it is taller than 0.5 m, and so is a component without points in its
// lower part (between 0.10 and 0.30 m): rocks stand on the ground, while stereo mismatches (the sky just
// above the horizon, for one) float in the air. Each kept component becomes one 'rock' Detection and paints its cells HAZARD.rock in
// the frame's patch; cells where ground was seen and nothing stands become HAZARD.safe. Cells of a dropped
// component stay unseen: one frame cannot tell noise from a small rock, so it makes no claim either way.
import { HAZARD, type Detection, type Pose, type StereoIntrinsics } from '../contracts.ts'
import { groundAt, type GroundContext } from './ground.ts'
import { cameraAxes, projectToImage, type PointCloud } from './points.ts'

export interface ObstacleOptions {
  /** Height above ground that a suited astronaut cannot step over, metres (assumption, see above). */
  stepM: number
  /** Points above stepM needed to call a cell an obstacle. */
  minPoints: number
  /** Smallest component kept... */
  minCells: number
  /** ...unless it is taller than this, metres. */
  bigHeightM: number
  /** Points within this of the ground are ground: a cell with one is seen ground. */
  groundTolM: number
  /** Points of a component's cells above this height belong to the rock (centre, radius, height, bbox). */
  rockMinHagM: number
  /** Height percentile reported as the rock's height, 0..1. */
  heightPercentile: number
}

export const OBSTACLE_DEFAULTS: ObstacleOptions = {
  stepM: 0.3,
  minPoints: 3,
  minCells: 2,
  bigHeightM: 0.5,
  groundTolM: 0.1,
  rockMinHagM: 0.1,
  heightPercentile: 0.95,
}

export interface ObstacleContext {
  readonly opts: ObstacleOptions
  /** Per cell: points above stepM, and points on the ground. */
  readonly highCount: Int32Array
  readonly groundCount: Int32Array
  /** Per cell: component label (0 none). */
  readonly label: Int32Array
  /** BFS queue; also holds the cells of the current component. */
  readonly queue: Int32Array
  /** Heights of the current component's rock points. */
  readonly heights: Float32Array
  readonly proj: Float64Array
}

export function createObstacleContext(ground: GroundContext, opts: Partial<ObstacleOptions> = {}): ObstacleContext {
  const n = ground.nCells
  return {
    opts: { ...OBSTACLE_DEFAULTS, ...opts },
    highCount: new Int32Array(n),
    groundCount: new Int32Array(n),
    label: new Int32Array(n),
    queue: new Int32Array(n),
    heights: new Float32Array(ground.hag.length),
    proj: new Float64Array(3),
  }
}

/** In-place quickselect: afterwards a[k] is the k-th smallest of a[0..n). */
function select(a: Float32Array, n: number, k: number): number {
  let lo = 0
  let hi = n - 1
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1]
    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        const t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  return a[k]
}

/**
 * Find the rocks in the frame after fitGround: returns their Detections and writes HAZARD.rock / HAZARD.safe
 * (with confidences) into `ground.patch`.
 */
export function detectObstacles(
  ctx: ObstacleContext,
  ground: GroundContext,
  cloud: PointCloud,
  intr: StereoIntrinsics,
  pose: Pose,
): Detection[] {
  const { opts, highCount, groundCount, label, queue, heights, proj } = ctx
  const { cols, rows, nCells, patch, cellStart, order, cellOf, hag } = ground
  const { cellM } = ground.opts
  const xyz = cloud.xyz
  const out: Detection[] = []

  // 1. Per-cell counts.
  highCount.fill(0)
  groundCount.fill(0)
  for (let i = 0; i < cloud.n; i++) {
    const c = cellOf[i]
    const h = hag[i]
    if (c < 0 || !Number.isFinite(h)) continue
    if (h > opts.stepM) highCount[c]++
    else if (Math.abs(h) <= opts.groundTolM) groundCount[c]++
  }

  // 2. 8-connected components of obstacle cells.
  label.fill(0)
  const axes = cameraAxes(pose)
  let next = 1
  for (let seed = 0; seed < nCells; seed++) {
    if (label[seed] || highCount[seed] < opts.minPoints) continue
    const id = next++
    let qe = 0
    queue[qe++] = seed
    label[seed] = id
    for (let qs = 0; qs < qe; qs++) {
      const c = queue[qs]
      const r = (c / cols) | 0
      const col = c - r * cols
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= cols) continue
          const nb = rr * cols + cc
          if (!label[nb] && highCount[nb] >= opts.minPoints) {
            label[nb] = id
            queue[qe++] = nb
          }
        }
      }
    }

    // 3. Describe the component from its rock points: footprint, image box, height.
    let m = 0
    let nHigh = 0
    let nLow = 0
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
    let nearest = -1
    let nearestD2 = Infinity
    for (let q = 0; q < qe; q++) {
      const c = queue[q]
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const i = order[k]
        const h = hag[i]
        if (!(h > opts.rockMinHagM)) continue
        heights[m++] = h
        if (h > opts.stepM) nHigh++
        else nLow++
        const x = xyz[i * 3]
        const y = xyz[i * 3 + 1]
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        const d2 = (x - pose.x) ** 2 + (y - pose.y) ** 2
        if (d2 < nearestD2) {
          nearestD2 = d2
          nearest = i
        }
        const u = cloud.pix[i] % intr.width
        const v = (cloud.pix[i] - u) / intr.width
        if (u < u0) u0 = u
        if (u > u1) u1 = u
        if (v < v0) v0 = v
        if (v > v1) v1 = v
      }
    }
    const heightM = select(heights, m, Math.floor(opts.heightPercentile * (m - 1)))
    if (qe < opts.minCells && !(heightM > opts.bigHeightM)) continue // noise: leave its cells unseen
    // A rock stands on the ground: its lower part (between rockMinHagM and stepM) shows too. A cluster
    // that floats in the air is a mismatch (typically the sky just above the horizon).
    if (nLow < opts.minPoints) continue
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const radiusM = Math.max(Math.hypot(x1 - x0, y1 - y0) / 2, cellM / 2)
    const distanceM = Math.hypot(cx - pose.x, cy - pose.y)
    // The bottom rockMinHagM of the rock has no points of its own: extend the box down to the ground
    // under the rock's nearest point.
    const gz = groundAt(ground, xyz[nearest * 3], xyz[nearest * 3 + 1])
    if (Number.isFinite(gz)) {
      projectToImage(xyz[nearest * 3], xyz[nearest * 3 + 1], gz, intr, axes, pose, proj)
      if (proj[2] > 0 && proj[1] > v1) v1 = Math.min(intr.height - 1, Math.round(proj[1]))
    }
    // More points and more height above the step limit make a surer rock.
    const confidence = Math.min(1, 0.3 + 0.07 * nHigh) * Math.min(1, 0.6 + (heightM - opts.stepM))
    for (let q = 0; q < qe; q++) {
      patch.cls[queue[q]] = HAZARD.rock
      patch.conf[queue[q]] = confidence
    }
    out.push({
      kind: 'rock',
      x: cx,
      y: cy,
      radiusM,
      heightM,
      distanceM,
      confidence,
      bbox: [u0, v0, u1 - u0 + 1, v1 - v0 + 1],
    })
  }

  // 4. Seen ground with nothing on it is safe. More ground points, surer.
  for (let c = 0; c < nCells; c++) {
    if (patch.cls[c] !== HAZARD.unseen || label[c] || !groundCount[c]) continue
    patch.cls[c] = HAZARD.safe
    patch.conf[c] = Math.min(1, groundCount[c] / 4)
  }
  return out
}
