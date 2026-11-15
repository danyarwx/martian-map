// Steep ground from one frame's ground points (docs/helmet/PLAN.md §5.4).
//
// Per 1 m block of the hazard patch, a least-squares plane through the ground points (points within
// 0.10 m of the local ground from ground.ts, so rocks do not tilt it); slope = angle of the plane's normal
// from the vertical. Above MOBILITY.walk.maxSlopeDeg (20°, the planner's no-go limit for walking) the
// block's cells become HAZARD.steep. 15–20° is only a warning: walkable but slow and tiring, so it is
// reported as a lower-confidence 'steep' Detection and the cells stay as they are. Blocks of 15° and more
// are grouped (8-connected); each group of at least 2 blocks gives one Detection whose median slope
// decides between the no-go and the warning case.
//
// Stereo noise grows with the square of the distance, so a block's slope is kept only when its standard
// error (fit residual over the points' spread) is small, and the kept slopes are then median-filtered
// over 3 × 3 blocks: a lone noisy block cannot raise a warning or paint cells on its own.
import { HAZARD, type Detection, type Pose } from '../contracts.ts'
import { MOBILITY } from '../../lib/mobility.ts'
import { solve3, type GroundContext } from './ground.ts'
import type { PointCloud } from './points.ts'

export interface SlopeOptions {
  /** Block size, metres (a whole number of cells). */
  blockM: number
  /** Warning from this slope, degrees. */
  warnDeg: number
  /** No-go above this slope, degrees. */
  maxDeg: number
  /** Points within this of the local ground are ground points, metres. */
  groundTolM: number
  /** Ground points a block needs for a slope. */
  minPoints: number
  /** Their smallest horizontal standard deviation, metres (a full 1 m block has 0.29). */
  minSpreadM: number
  /** Planes that fit worse than this (RMS, metres) are rough ground or rubble, not a slope. */
  maxResidualM: number
  /** Blocks further than this from the camera are too noisy to judge, metres. */
  maxRangeM: number
  /** Largest standard error of a block's slope, degrees. */
  maxSlopeErrDeg: number
  /** Smallest group of blocks reported. */
  minBlocks: number
}

export const SLOPE_DEFAULTS: SlopeOptions = {
  blockM: 1,
  warnDeg: 15,
  maxDeg: MOBILITY.walk.maxSlopeDeg,
  groundTolM: 0.1,
  minPoints: 6,
  minSpreadM: 0.15,
  maxResidualM: 0.06,
  maxRangeM: 15,
  maxSlopeErrDeg: 2.5,
  minBlocks: 2,
}

/** Sums per block: n, x, y, z, xx, xy, yy, xz, yz, zz (coordinates about the block centre). */
const NS = 10

export interface SlopeContext {
  readonly opts: SlopeOptions
  /** Cells per block side. */
  readonly cpb: number
  readonly blocksX: number
  readonly blocksY: number
  readonly sums: Float64Array
  /** Per block: least-squares slope in degrees, NaN where it could not be measured. */
  readonly slopeRaw: Float32Array
  /** Per block: 3 × 3 median of slopeRaw (NaN with fewer than 5 measured blocks in the window). Used for the hazards. */
  readonly slope: Float32Array
  readonly label: Int32Array
  readonly queue: Int32Array
  readonly scratch: Float32Array
  readonly nine: Float32Array
  readonly sol: Float64Array
}

export function createSlopeContext(ground: GroundContext, opts: Partial<SlopeOptions> = {}): SlopeContext {
  const o = { ...SLOPE_DEFAULTS, ...opts }
  const cpb = Math.round(o.blockM / ground.opts.cellM)
  if (cpb < 1 || Math.abs(cpb * ground.opts.cellM - o.blockM) > 1e-9 || ground.cols % cpb)
    throw new Error('slope blockM must be a whole number of cells dividing the patch')
  const blocksX = ground.cols / cpb
  const blocksY = ground.rows / cpb
  const n = blocksX * blocksY
  return {
    opts: o,
    cpb,
    blocksX,
    blocksY,
    sums: new Float64Array(n * NS),
    slopeRaw: new Float32Array(n),
    slope: new Float32Array(n),
    label: new Int32Array(n),
    queue: new Int32Array(n),
    scratch: new Float32Array(n),
    nine: new Float32Array(9),
    sol: new Float64Array(3),
  }
}

/**
 * Measure the slope of every 1 m block after fitGround; marks cells HAZARD.steep (never over a rock) in
 * `ground.patch` and returns one 'steep' Detection per group of blocks of 15° or more.
 */
export function detectSlopes(ctx: SlopeContext, ground: GroundContext, cloud: PointCloud, pose: Pose): Detection[] {
  const { opts, cpb, blocksX, blocksY, sums, slopeRaw, slope, label, queue, scratch, nine, sol } = ctx
  const { cols, patch, cellOf, hag } = ground
  const { x0, y0 } = patch
  const B = opts.blockM
  const xyz = cloud.xyz
  const nBlocks = blocksX * blocksY

  // 1. Accumulate the ground points per block.
  sums.fill(0)
  for (let i = 0; i < cloud.n; i++) {
    const c = cellOf[i]
    if (c < 0 || !(Math.abs(hag[i]) <= opts.groundTolM)) continue
    const row = (c / cols) | 0
    const bc = ((c - row * cols) / cpb) | 0
    const br = (row / cpb) | 0
    const x = xyz[i * 3] - (x0 + (bc + 0.5) * B)
    const y = xyz[i * 3 + 1] - (y0 - (br + 0.5) * B)
    const z = xyz[i * 3 + 2]
    const o = (br * blocksX + bc) * NS
    sums[o] += 1
    sums[o + 1] += x
    sums[o + 2] += y
    sums[o + 3] += z
    sums[o + 4] += x * x
    sums[o + 5] += x * y
    sums[o + 6] += y * y
    sums[o + 7] += x * z
    sums[o + 8] += y * z
    sums[o + 9] += z * z
  }

  // 2. Least-squares plane per block, kept when well determined.
  const maxRange2 = opts.maxRangeM * opts.maxRangeM
  const maxErr = Math.tan((opts.maxSlopeErrDeg * Math.PI) / 180)
  for (let b = 0; b < nBlocks; b++) {
    slopeRaw[b] = NaN
    const o = b * NS
    const n = sums[o]
    if (n < opts.minPoints) continue
    const br = (b / blocksX) | 0
    const bc = b - br * blocksX
    const cx = x0 + (bc + 0.5) * B
    const cy = y0 - (br + 0.5) * B
    if ((cx - pose.x) ** 2 + (cy - pose.y) ** 2 > maxRange2) continue
    const sx = sums[o + 1], sy = sums[o + 2], sz = sums[o + 3]
    const sxx = sums[o + 4], sxy = sums[o + 5], syy = sums[o + 6]
    const sxz = sums[o + 7], syz = sums[o + 8], szz = sums[o + 9]
    const mx = sx / n
    const my = sy / n
    const cxx = sxx / n - mx * mx
    const cyy = syy / n - my * my
    const cxy = sxy / n - mx * my
    const lambdaMin = (cxx + cyy) / 2 - Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy)
    if (lambdaMin < opts.minSpreadM * opts.minSpreadM) continue
    if (!solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, n, sxz, syz, sz, sol, 0)) continue
    const a = sol[0], bb = sol[1], c = sol[2]
    // Σ(z − a·x − b·y − c)² expanded over the sums.
    const sse =
      szz - 2 * (a * sxz + bb * syz + c * sz) + a * a * sxx + 2 * a * bb * sxy + bb * bb * syy +
      2 * a * c * sx + 2 * bb * c * sy + c * c * n
    const rms = Math.sqrt(Math.max(0, sse) / n)
    if (rms > opts.maxResidualM) continue
    // Standard error of the gradient along the points' narrowest direction.
    if (rms / Math.sqrt(n * lambdaMin) > maxErr) continue
    slopeRaw[b] = (Math.atan(Math.hypot(a, bb)) * 180) / Math.PI
  }

  // 3. 3 × 3 median of the measured slopes.
  for (let br = 0; br < blocksY; br++)
    for (let bc = 0; bc < blocksX; bc++) {
      const b = br * blocksX + bc
      slope[b] = NaN
      if (!Number.isFinite(slopeRaw[b])) continue
      let m = 0
      for (let dr = -1; dr <= 1; dr++) {
        const rr = br + dr
        if (rr < 0 || rr >= blocksY) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = bc + dc
          if (cc < 0 || cc >= blocksX) continue
          const v = slopeRaw[rr * blocksX + cc]
          if (!Number.isFinite(v)) continue
          // Insertion into the sorted run nine[0..m).
          let k = m++
          while (k > 0 && nine[k - 1] > v) {
            nine[k] = nine[k - 1]
            k--
          }
          nine[k] = v
        }
      }
      if (m >= 5) slope[b] = m % 2 ? nine[m >> 1] : (nine[(m >> 1) - 1] + nine[m >> 1]) / 2
    }

  // 4. Steep cells: every cell of a block above the limit, unless a rock is already there.
  for (let b = 0; b < nBlocks; b++) {
    if (!(slope[b] > opts.maxDeg)) continue
    const br = (b / blocksX) | 0
    const bc = b - br * blocksX
    const conf = Math.min(1, 0.6 + (slope[b] - opts.maxDeg) / 10)
    for (let r = br * cpb; r < (br + 1) * cpb; r++)
      for (let cc = bc * cpb; cc < (bc + 1) * cpb; cc++) {
        const cell = r * cols + cc
        if (patch.cls[cell] === HAZARD.rock) continue
        patch.cls[cell] = HAZARD.steep
        patch.conf[cell] = conf
      }
  }

  // 5. Groups of blocks at or above the warning slope.
  const out: Detection[] = []
  label.fill(0)
  let next = 1
  for (let seed = 0; seed < nBlocks; seed++) {
    if (label[seed] || !(slope[seed] >= opts.warnDeg)) continue
    const id = next++
    let qe = 0
    queue[qe++] = seed
    label[seed] = id
    for (let qs = 0; qs < qe; qs++) {
      const b = queue[qs]
      const br = (b / blocksX) | 0
      const bc = b - br * blocksX
      for (let dr = -1; dr <= 1; dr++) {
        const rr = br + dr
        if (rr < 0 || rr >= blocksY) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = bc + dc
          if (cc < 0 || cc >= blocksX) continue
          const nb = rr * blocksX + cc
          if (!label[nb] && slope[nb] >= opts.warnDeg) {
            label[nb] = id
            queue[qe++] = nb
          }
        }
      }
    }
    if (qe < opts.minBlocks) continue
    let sx = 0
    let sy = 0
    let nearest = Infinity
    for (let q = 0; q < qe; q++) {
      const b = queue[q]
      const br = (b / blocksX) | 0
      const bx = x0 + (b - br * blocksX + 0.5) * B
      const by = y0 - (br + 0.5) * B
      sx += bx
      sy += by
      nearest = Math.min(nearest, Math.hypot(bx - pose.x, by - pose.y))
      scratch[q] = slope[b]
    }
    const cx = sx / qe
    const cy = sy / qe
    let r2 = 0
    for (let q = 0; q < qe; q++) {
      const b = queue[q]
      const br = (b / blocksX) | 0
      const dx = x0 + (b - br * blocksX + 0.5) * B - cx
      const dy = y0 - (br + 0.5) * B - cy
      r2 = Math.max(r2, dx * dx + dy * dy)
    }
    const s = scratch.subarray(0, qe).sort()
    const slopeDeg = qe % 2 ? s[qe >> 1] : (s[(qe >> 1) - 1] + s[qe >> 1]) / 2
    const noGo = slopeDeg > opts.maxDeg
    // A warning is advice, not a hazard: keep its confidence below the no-go case. Bigger groups, surer.
    const size = Math.min(1, qe / 8)
    out.push({
      kind: 'steep',
      x: cx,
      y: cy,
      radiusM: Math.sqrt(r2) + B / 2,
      slopeDeg,
      // Nearest block: "steep ground in 6 m" matters more than the distance to the group's middle.
      distanceM: nearest,
      confidence: noGo ? 0.6 + 0.4 * size : 0.3 + 0.2 * size,
    })
  }
  return out
}
