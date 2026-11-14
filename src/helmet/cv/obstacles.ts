// Rocks from height above ground (docs/helmet/PLAN.md §5.3, FIXLIST A2).
//
// Every pixel with a depth gets its height above the fitted ground. Pixels more than 0.10 m above it are "rock
// pixels"; they are grouped in the IMAGE (4-connected, and only across small depth steps, so a rock in front of
// another one stays separate), and a group that is several rocks side by side is cut at the dips of its height
// profile. That gives one detection per rock, with its own outline.
//
// Two levels (decision of 14 Nov 2026):
// - 'hazard': taller than 0.30 m, the step a suited astronaut carrying gear can take safely (a planning assumption
//   of PLAN §5.3, not a measurement). Its cells become HAZARD.rock in the frame's patch: the route goes round it.
// - 'small': 0.10–0.30 m, a trip risk. Reported within 8 m only (beyond that the height noise is as large as the
//   rock) and never painted into the patch, so the planner does not avoid pebbles.
// A rock stands on the ground: a group without pixels in its lower part (0.10–0.30 m) floats in the air and is a
// stereo mismatch (the sky just above the horizon, for one). Cells where ground was seen and nothing stands become
// HAZARD.safe. Cells with points above the step that did not make a rock stay unseen: one frame cannot tell.
import { HAZARD, type Detection, type Pose, type StereoIntrinsics } from '../contracts.ts'
import { groundAt, type GroundContext } from './ground.ts'
import { cameraAxes, projectToImage, type PointCloud } from './points.ts'
import { DEPTH_MAX_M, DEPTH_MIN_M } from './stereo.ts'

export interface ObstacleOptions {
  /** Height above ground that a suited astronaut cannot step over, metres (assumption, see above). */
  stepM: number
  /** Cloud points above stepM that keep a cell from being called safe. */
  minPoints: number
  /**
   * A rock measured this much under stepM still counts as a hazard, metres: stereo smooths the top of a small
   * rock, so heights read a few centimetres low, and the safe side is to call a borderline rock a hazard.
   */
  hazardMarginM: number
  /** Pixels above stepM − hazardMarginM needed for a hazard rock. */
  minPixels: number
  /** Pixels in the lower part (rockMinHagM..stepM) needed: a rock stands on the ground. */
  minLowPixels: number
  /** Pixels above rockMinHagM needed for a small rock. */
  minSmallPixels: number
  /** Small rocks are reported up to this range, metres. */
  smallMaxRangeM: number
  /** A small rock is at most this wide, metres: wider low shapes are ground the plane fit missed. */
  smallMaxWidthM: number
  /** A small rock's height above the ground right around it must reach this, metres (a bump of the ground does not). */
  smallMinHeightM: number
  /** A group that made no rock is looked at again above a level this much higher, metres, … */
  retryStepM: number
  /** … and its pieces then need this height above the ground in the ring round them, metres. */
  retryMinHeightM: number
  /** Take heights from the local floor where it lies below the fitted plane (see step 2b). */
  floorCorrection: boolean
  /** … but only where it lies at least this far below, metres (less is stereo noise). */
  floorMinM: number
  /** … and only this near, metres: farther away the heights are too noisy to move. */
  floorMaxRangeM: number
  /** Neighbouring rock pixels belong together when their depths differ by less than linkM + linkRel · depth. */
  linkM: number
  linkRel: number
  /** A group is cut where its height profile dips below this share of the peaks on both sides. */
  splitRatio: number
  /** Points within this of the ground are ground: a cell with one is seen ground. */
  groundTolM: number
  /** Pixels above this height belong to a rock, metres. Also the lower limit of a small rock. */
  rockMinHagM: number
  /** Height percentile reported as the rock's height, 0..1. */
  heightPercentile: number
  /** Detections farther than this are dropped, metres (depth beyond it is not trusted). */
  maxRangeM: number
}

export const OBSTACLE_DEFAULTS: ObstacleOptions = {
  stepM: 0.3,
  hazardMarginM: 0.04,
  minPoints: 3,
  minPixels: 5,
  minLowPixels: 3,
  minSmallPixels: 10,
  smallMaxRangeM: 8,
  smallMaxWidthM: 1.2,
  smallMinHeightM: 0.11,
  retryStepM: 0.04,
  retryMinHeightM: 0.05,
  floorCorrection: true,
  floorMinM: 0.12,
  floorMaxRangeM: 6,
  linkM: 0.2,
  linkRel: 0.05,
  splitRatio: 0.6,
  groundTolM: 0.1,
  rockMinHagM: 0.1,
  heightPercentile: 0.95,
  maxRangeM: DEPTH_MAX_M,
}

/** Per-pixel buffers, sized for one image size. */
interface PixelBuffers {
  n: number
  /** Height above ground, NaN = no depth or no ground. */
  hag: Float32Array
  depth: Float32Array
  wx: Float32Array
  wy: Float32Array
  label: Int32Array
  /** Flood-fill queue; holds the pixels of the current group. */
  queue: Int32Array
  heights: Float32Array
  /** Per image column: tallest rock pixel of the current group, and the piece the column belongs to. */
  colMax: Float32Array
  colPiece: Int32Array
  /** Pixels waiting for a second look at a higher level. */
  pending: Int32Array
}

export interface ObstacleContext {
  readonly opts: ObstacleOptions
  /** Per cell: cloud points above stepM, and on the ground. */
  readonly highCount: Int32Array
  readonly groundCount: Int32Array
  /** Per cell: rock pixels of the current rock, and the cells it touched. */
  readonly cellPix: Int32Array
  readonly touched: Int32Array
  readonly proj: Float64Array
  px: PixelBuffers | null
  floor?: { floorHist: Uint16Array; floorCell: Float32Array; floorCount: Int32Array }
}

export function createObstacleContext(ground: GroundContext, opts: Partial<ObstacleOptions> = {}): ObstacleContext {
  const n = ground.nCells
  return {
    opts: { ...OBSTACLE_DEFAULTS, ...opts },
    highCount: new Int32Array(n),
    groundCount: new Int32Array(n),
    cellPix: new Int32Array(n),
    touched: new Int32Array(n),
    proj: new Float64Array(3),
    px: null,
  }
}

const FLOOR_BINS = 16
const FLOOR_BIN_M = 0.05
const FLOOR_RANGE_M = 0.4

function floorBuffers(ctx: ObstacleContext, nCells: number) {
  ctx.floor ??= { floorHist: new Uint16Array(nCells * FLOOR_BINS), floorCell: new Float32Array(nCells), floorCount: new Int32Array(nCells) }
  return ctx.floor
}

function pixelBuffers(ctx: ObstacleContext, width: number, height: number): PixelBuffers {
  const n = width * height
  if (ctx.px?.n === n && ctx.px.colMax.length === width) return ctx.px
  ctx.px = {
    n,
    hag: new Float32Array(n),
    depth: new Float32Array(n),
    wx: new Float32Array(n),
    wy: new Float32Array(n),
    label: new Int32Array(n),
    queue: new Int32Array(n),
    heights: new Float32Array(n),
    colMax: new Float32Array(width),
    colPiece: new Int32Array(width),
    pending: new Int32Array(n * 3),
  }
  return ctx.px
}

/** Convex hull (monotone chain) of points given as [u, v] pairs in `pts[0..n)`; returns a flat polygon. */
function hull(pts: number[]): number[] {
  const n = pts.length / 2
  if (n < 3) return pts.slice()
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1])
  const cross = (o: number, a: number, b: number) =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2])
  const h: number[] = []
  for (const i of idx) {
    while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], i) <= 0) h.pop()
    h.push(i)
  }
  const lower = h.length + 1
  for (let k = n - 2; k >= 0; k--) {
    const i = idx[k]
    while (h.length >= lower && cross(h[h.length - 2], h[h.length - 1], i) <= 0) h.pop()
    h.push(i)
  }
  h.pop()
  const out: number[] = []
  for (const i of h) out.push(pts[i * 2], pts[i * 2 + 1])
  return out
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
 * Find the rocks in the frame after fitGround: returns their Detections (hazard rocks first come as found, each
 * with `level` and an image `outline`) and writes HAZARD.rock / HAZARD.safe (with confidences) into `ground.patch`.
 * `disparity` is the frame's full disparity map: the rocks are found per pixel, not from the thinned cloud.
 */
export function detectObstacles(
  ctx: ObstacleContext,
  ground: GroundContext,
  cloud: PointCloud,
  intr: StereoIntrinsics,
  pose: Pose,
  disparity: Float32Array,
): Detection[] {
  const { opts, highCount, groundCount, cellPix, touched, proj } = ctx
  const { cols, rows, nCells, patch, cellOf, hag: cloudHag } = ground
  const { cellM } = ground.opts
  const { width: W, height: H, fx, fy, cx, cy, baselineM } = intr
  const px = pixelBuffers(ctx, W, H)
  const { hag, depth, wx, wy, label, queue, heights, colMax, colPiece, pending } = px
  const out: Detection[] = []

  // 1. Per-cell counts from the cloud: which cells show ground, which show something above the step.
  highCount.fill(0)
  groundCount.fill(0)
  for (let i = 0; i < cloud.n; i++) {
    const c = cellOf[i]
    const h = cloudHag[i]
    if (c < 0 || !Number.isFinite(h)) continue
    if (h > opts.stepM) highCount[c]++
    else if (Math.abs(h) <= opts.groundTolM) groundCount[c]++
  }

  // 2. Height above ground for every pixel with a depth.
  const axes = cameraAxes(pose)
  const fb = fx * baselineM
  const dMin = fb / DEPTH_MAX_M
  const dMax = fb / DEPTH_MIN_M
  for (let v = 0; v < H; v++) {
    const yc = (v - cy) / fy
    for (let u = 0; u < W; u++) {
      const i = v * W + u
      const d = disparity[i]
      label[i] = 0
      if (!(d >= dMin && d <= dMax)) {
        hag[i] = NaN
        continue
      }
      const Z = fb / d
      const X = ((u - cx) / fx) * Z
      const Y = yc * Z
      const x = pose.x + X * axes.rx + Y * axes.dx + Z * axes.fx
      const y = pose.y + X * axes.ry + Y * axes.dy + Z * axes.fy
      const z = pose.z + X * axes.rz + Y * axes.dz + Z * axes.fz
      hag[i] = z - groundAt(ground, x, y) // NaN where no ground was fitted
      depth[i] = Z
      wx[i] = x
      wy[i] = y
    }
  }

  const cellAt = (i: number) => {
    const col = Math.floor((wx[i] - patch.x0) / cellM)
    const row = Math.floor((patch.y0 - wy[i]) / cellM)
    return col >= 0 && col < cols && row >= 0 && row < rows ? row * cols + col : -1
  }

  // 2b. Where the fitted plane rides above the real ground (a bed of stones pulls it up, or a near block has to
  //     borrow its neighbours' planes), heights read too low and rocks vanish. Find the local floor: per 0.5 m
  //     cell the 20th percentile of the heights (5 cm bins), then the lowest floor in the 3 × 3 cells around.
  //     Where that is below the plane, heights are taken from it instead. It only ever raises a height.
  if (opts.floorCorrection) {
    const { floorHist, floorCell, floorCount } = floorBuffers(ctx, nCells)
    floorHist.fill(0)
    floorCount.fill(0)
    for (let i = 0; i < px.n; i++) {
      const h = hag[i]
      if (!(h === h)) continue
      const c = cellAt(i)
      if (c < 0) continue
      const bin = Math.min(FLOOR_BINS - 1, Math.max(0, Math.floor((h + FLOOR_RANGE_M) / FLOOR_BIN_M)))
      floorHist[c * FLOOR_BINS + bin]++
      floorCount[c]++
    }
    for (let c = 0; c < nCells; c++) {
      const n = floorCount[c]
      if (n < 20) {
        floorCell[c] = NaN
        continue
      }
      const need = Math.max(6, n * 0.2)
      let acc = 0
      let bin = 0
      for (; bin < FLOOR_BINS; bin++) {
        acc += floorHist[c * FLOOR_BINS + bin]
        if (acc >= need) break
      }
      floorCell[c] = bin * FLOOR_BIN_M - FLOOR_RANGE_M + FLOOR_BIN_M / 2
    }
    for (let i = 0; i < px.n; i++) {
      if (!(hag[i] === hag[i]) || depth[i] > opts.floorMaxRangeM) continue
      const c = cellAt(i)
      if (c < 0) continue
      const r = (c / cols) | 0
      const col = c - r * cols
      let low = 0
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= cols) continue
          const f = floorCell[rr * cols + cc]
          if (f < low) low = f
        }
      }
      if (depth[i] <= opts.floorMaxRangeM && low < -opts.floorMinM) hag[i] -= low
    }
  }

  // 3. Groups of rock pixels, 4-connected across small depth steps.
  const minH = opts.rockMinHagM
  const hazardM = opts.stepM - opts.hazardMarginM
  let next = 1
  let pendEnd = 0
  const stack: [number, number, number][] = []
  const group = (seed: number, thr: number): void => {
    if (label[seed] || !(hag[seed] > thr)) return
    const id = next++
    let qe = 0
    queue[qe++] = seed
    label[seed] = id
    let gu0 = W, gu1 = -1
    for (let qs = 0; qs < qe; qs++) {
      const i = queue[qs]
      const u = i % W
      if (u < gu0) gu0 = u
      if (u > gu1) gu1 = u
      const tol = opts.linkM + opts.linkRel * depth[i]
      const tryPixel = (j: number) => {
        if (label[j] || !(hag[j] > thr) || Math.abs(depth[j] - depth[i]) > tol) return
        label[j] = id
        queue[qe++] = j
      }
      if (u > 0) tryPixel(i - 1)
      if (u < W - 1) tryPixel(i + 1)
      if (i >= W) tryPixel(i - W)
      if (i < px.n - W) tryPixel(i + W)
    }
    if (qe < Math.min(opts.minPixels, opts.minSmallPixels)) return
    let emitted = 0
    let groupDepth = 0

    // 4. Cut the group where its height profile dips: rocks standing side by side.
    for (let u = gu0; u <= gu1; u++) colMax[u] = 0
    for (let q = 0; q < qe; q++) {
      const i = queue[q]
      const u = i % W
      if (hag[i] > colMax[u]) colMax[u] = hag[i]
    }
    let pieces = 1
    {
      let peak = colMax[gu0]
      let valley = peak
      let valleyU = gu0
      let piece = 0
      let start = gu0
      for (let u = gu0; u <= gu1; u++) {
        const h = colMax[u]
        if (h < valley) {
          valley = h
          valleyU = u
        } else if (valley < opts.splitRatio * peak && valley < opts.splitRatio * h && h > opts.rockMinHagM * 1.5) {
          for (let k = start; k < valleyU; k++) colPiece[k] = piece
          piece++
          start = valleyU
          peak = h
          valley = h
          valleyU = u
        } else if (h > peak) {
          peak = h
          valley = h
          valleyU = u
        }
      }
      for (let k = start; k <= gu1; k++) colPiece[k] = piece
      pieces = piece + 1
    }

    // 5. Describe each piece: footprint, image outline, height, level.
    for (let piece = 0; piece < pieces; piece++) {
      let m = 0
      let nHigh = 0
      let nLow = 0
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
      let nearest = -1
      let nearestD2 = Infinity
      let depthSum = 0
      let sumX = 0
      let sumY = 0
      // left- and rightmost pixel of every image row, for the outline
      const rowMin = new Map<number, number>()
      const rowMax = new Map<number, number>()
      for (let q = 0; q < qe; q++) {
        const i = queue[q]
        const u = i % W
        if (pieces > 1 && colPiece[u] !== piece) continue
        const v = (i - u) / W
        const h = hag[i]
        heights[m++] = h
        if (h > hazardM) nHigh++
        else nLow++
        depthSum += depth[i]
        const x = wx[i]
        const y = wy[i]
        sumX += x
        sumY += y
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        const d2 = (x - pose.x) ** 2 + (y - pose.y) ** 2
        if (d2 < nearestD2) {
          nearestD2 = d2
          nearest = i
        }
        if (u < u0) u0 = u
        if (u > u1) u1 = u
        if (v < v0) v0 = v
        if (v > v1) v1 = v
        const lo = rowMin.get(v)
        if (lo === undefined || u < lo) rowMin.set(v, u)
        const hi = rowMax.get(v)
        if (hi === undefined || u > hi) rowMax.set(v, u)
      }
      if (m === 0) continue
      const heightM = select(heights, m, Math.floor(opts.heightPercentile * (m - 1)))
      const meanDepth = depthSum / m
      const hazard = heightM > hazardM && nHigh >= opts.minPixels && nLow >= opts.minLowPixels
      // height of the ground in a 3-pixel ring round the piece: a rock stands out of it, a bump does not
      let ringSum = 0
      let ringN = 0
      if (!hazard) {
        const a0 = Math.max(0, u0 - 3), a1 = Math.min(W - 1, u1 + 3)
        const b0 = Math.max(0, v0 - 3), b1 = Math.min(H - 1, v1 + 3)
        for (let v = b0; v <= b1; v++)
          for (let u = a0; u <= a1; u++) {
            const j = v * W + u
            if (label[j] === id || !(hag[j] === hag[j]) || Math.abs(depth[j] - meanDepth) > 1) continue
            ringSum += hag[j]
            ringN++
          }
      }
      const small =
        !hazard &&
        ringN >= 6 &&
        heightM - ringSum / ringN >= (thr > minH ? opts.retryMinHeightM : opts.smallMinHeightM) &&
        heightM <= opts.stepM + 0.1 &&
        m >= opts.minSmallPixels &&
        meanDepth <= opts.smallMaxRangeM &&
        ((u1 - u0 + 1) * meanDepth) / fx <= opts.smallMaxWidthM
      groupDepth = meanDepth
      if (!hazard && !small) continue
      emitted++
      // Centre = mean of the rock's pixels (its visible face); the extent comes from the image width, because stray
      // pixels at a rock's edge (stereo smears a little there) stretch a world-space box.
      const centreX = sumX / m
      const centreY = sumY / m
      const widthM = ((u1 - u0 + 1) * meanDepth) / fx
      const distanceM = Math.hypot(centreX - pose.x, centreY - pose.y)
      if (distanceM > opts.maxRangeM) continue
      const radiusM = Math.max(Math.min(widthM, Math.hypot(x1 - x0, y1 - y0)) / 2, hazard ? cellM / 2 : 0.1)
      // The bottom rockMinHagM of the rock has no pixels of its own: extend the outline down to the ground
      // under the rock's nearest point.
      const gz = groundAt(ground, wx[nearest], wy[nearest])
      let foot = v1
      if (Number.isFinite(gz)) {
        projectToImage(wx[nearest], wy[nearest], gz, intr, axes, pose, proj)
        if (proj[2] > 0 && proj[1] > v1) foot = Math.min(H - 1, Math.round(proj[1]))
      }
      const pts: number[] = []
      for (const [v, u] of rowMin) pts.push(u, v, rowMax.get(v)!, v)
      if (foot > v1) pts.push(rowMin.get(v1)!, foot, rowMax.get(v1)!, foot)
      // More pixels and more height above the step limit make a surer rock (3 pixels ≈ 1 cloud point).
      const confidence = hazard
        ? Math.min(1, 0.3 + 0.023 * nHigh) * Math.min(1, 0.6 + (heightM - hazardM))
        : Math.min(0.6, 0.2 + 0.01 * m)
      if (hazard) {
        let nt = 0
        let best = -1
        for (let q = 0; q < qe; q++) {
          const i = queue[q]
          if (!(hag[i] > hazardM) || (pieces > 1 && colPiece[i % W] !== piece)) continue
          const c = cellAt(i)
          if (c < 0) continue
          if (cellPix[c]++ === 0) touched[nt++] = c
          if (best < 0 || cellPix[c] > cellPix[best]) best = c
        }
        for (let k = 0; k < nt; k++) {
          const c = touched[k]
          if (cellPix[c] >= opts.minPoints || c === best) {
            patch.cls[c] = HAZARD.rock
            patch.conf[c] = Math.max(patch.conf[c], confidence)
          }
          cellPix[c] = 0
        }
      }
      out.push({
        kind: 'rock',
        level: hazard ? 'hazard' : 'small',
        x: centreX,
        y: centreY,
        radiusM,
        heightM,
        distanceM,
        confidence,
        bbox: [u0, v0, u1 - u0 + 1, foot - v0 + 1],
        outline: hull(pts),
        groundZ: Number.isFinite(gz) ? gz : undefined,
      })
    }
    // 6. A low, wide group that made no rock (a bed of stones, their bases touching): look at it again above a
    //    higher level, where each stone's top is its own group.
    const up = thr + opts.retryStepM
    if (!emitted && qe >= opts.minSmallPixels && up <= opts.stepM - opts.retryStepM && groupDepth <= opts.smallMaxRangeM && pendEnd + qe <= pending.length) {
      const start = pendEnd
      for (let q = 0; q < qe; q++) {
        const i = queue[q]
        if (!(hag[i] > up)) continue
        label[i] = 0
        pending[pendEnd++] = i
      }
      if (pendEnd > start) stack.push([start, pendEnd, up])
    }
  }
  for (let seed = 0; seed < px.n; seed++) group(seed, minH)
  while (stack.length) {
    const [a, b, thr] = stack.pop()!
    for (let k = a; k < b; k++) group(pending[k], thr)
  }

  // 7. Seen ground with nothing on it is safe. More ground points, surer.
  for (let c = 0; c < nCells; c++) {
    if (patch.cls[c] !== HAZARD.unseen || highCount[c] >= opts.minPoints || !groundCount[c]) continue
    patch.cls[c] = HAZARD.safe
    patch.conf[c] = Math.min(1, groundCount[c] / 4)
  }
  return out
}
