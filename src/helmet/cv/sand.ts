// Sand / loose ground from the left colour image (docs/helmet/PLAN.md §5.5, T5.2).
//
// The left image is cut into 16 × 16 pixel patches. A patch is judged when the frame's own point cloud says it
// shows ground at 2–14 m (enough points, most of them within 0.3 m of the local ground from ground.ts). For
// such a patch seven numbers are measured:
//   lumRel      mean luminance / the frame's median ground luminance − 1   (dark sheets, bright dust)
//   contrast    standard deviation of the luminance / that median          (pebbles and shadows make contrast)
//   gradEnergy  RMS luminance gradient / that median                       (fine texture)
//   coherence   structure-tensor coherence of the gradients, 0..1          (parallel ripples point one way)
//   redness     r / (r + g + b) over the patch
//   roughness   RMS height above the local ground of the patch's points, metres (sand lies flat)
//   logRange    ln of the patch's mean ground distance, metres: texture looks finer further away, so the
//               other numbers mean different things at 3 m and at 12 m
// and a logistic regression (7 weights + a bias, sandWeights.ts) turns them into a probability of sand.
//
// The weights were fitted by the eval harness (src/helmet/eval) on rendered frames, with labels from the
// simulated world's sand mask. That is training only: nothing here reads the world. Inference uses the
// pixels and the point cloud of the same frame.
//
// From patches to the hazard patch: every ground point carries its patch's probability into its 0.5 m cell;
// a cell whose mean probability is above 0.6 is a sand candidate. A candidate becomes HAZARD.sand once it
// has been a candidate in `persistFrames` frames in a row (2: PLAN "over ≥ 2 frames"), and only where the
// cell was seen as safe ground: rock, steep and drop cells are never overwritten. Its confidence is the mean
// probability, so the hazard grid's log-odds fusion weighs a sure patch more than a doubtful one.
// 8-connected groups of sand cells of at least `minCells` cells give one 'sand' Detection each.
import { HAZARD, type Detection, type Pose, type StereoIntrinsics } from '../contracts.ts'
import type { GroundContext } from './ground.ts'
import type { SandHook } from './pipeline.ts'
import type { PointCloud } from './points.ts'
import { SAND_WEIGHTS } from './sandWeights.ts'

export const SAND_FEATURES = ['lumRel', 'contrast', 'gradEnergy', 'coherence', 'redness', 'roughness', 'logRange'] as const
/** Features per patch. The classifier has one weight each plus a bias: 8 numbers. */
export const SAND_NF = SAND_FEATURES.length

export interface SandOptions {
  /** Patch side, pixels. */
  patchPx: number
  /** Points within this of the local ground belong to the ground surface of a patch (pebbles included), metres. */
  groundTolM: number
  /** A patch needs this many cloud points... */
  minPoints: number
  /** ...and this share of them on the ground surface. */
  minGroundShare: number
  /** Patches nearer or further than this are not judged, metres. */
  minRangeM: number
  maxRangeM: number
  /** A cell is a sand candidate above this mean probability. */
  threshold: number
  /** Frames in a row a cell must be a candidate before it is painted. */
  persistFrames: number
  /** Smallest group of sand cells reported as a Detection (12 cells = 3 m²). */
  minCells: number
  /** SAND_NF weights, then the bias. */
  weights: readonly number[]
}

export const SAND_DEFAULTS: SandOptions = {
  patchPx: 16,
  groundTolM: 0.3,
  minPoints: 8,
  minGroundShare: 0.7,
  minRangeM: 2,
  maxRangeM: 14,
  threshold: 0.6,
  persistFrames: 2,
  minCells: 12,
  weights: SAND_WEIGHTS,
}

export interface SandContext {
  readonly opts: SandOptions
  readonly width: number
  readonly height: number
  /** Patches across and down, and in all. */
  readonly pw: number
  readonly ph: number
  readonly n: number
  /** Luminance of the left image, 0..255. */
  readonly lum: Uint8Array
  /** Per patch: SAND_NF features (valid where ok = 1). */
  readonly feat: Float32Array
  /** Per patch: 1 when it shows ground in range and was judged. */
  readonly ok: Uint8Array
  /** Per patch: probability of sand (0 where not ok). */
  readonly prob: Float32Array
  /** Per patch: mean local ENU position of its ground points, and their count. */
  readonly px: Float32Array
  readonly py: Float32Array
  readonly groundPts: Int32Array
  /** Median ground luminance of the last frame. */
  median: number
  // scratch
  readonly allPts: Int32Array
  readonly sumH2: Float64Array
  readonly sumRange: Float64Array
  readonly sumX: Float64Array
  readonly sumY: Float64Array
  readonly hist: Int32Array
  readonly cellSum: Float32Array
  readonly cellN: Int32Array
  /** Per cell of the hazard patch: mean sand probability of the last frame, NaN where no judged point fell. */
  readonly cellProb: Float32Array
  readonly label: Uint8Array
  readonly queue: Int32Array
  /** Candidate streak per absolute grid cell, this frame and the one before. */
  streak: Map<number, number>
  prevStreak: Map<number, number>
}

export function createSandContext(size: Pick<StereoIntrinsics, 'width' | 'height'>, nCells: number, opts: Partial<SandOptions> = {}): SandContext {
  const o = { ...SAND_DEFAULTS, ...opts }
  if (o.weights.length !== SAND_NF + 1) throw new Error(`sand weights: expected ${SAND_NF + 1} numbers, got ${o.weights.length}`)
  const pw = Math.floor(size.width / o.patchPx)
  const ph = Math.floor(size.height / o.patchPx)
  const n = pw * ph
  return {
    opts: o,
    width: size.width,
    height: size.height,
    pw,
    ph,
    n,
    lum: new Uint8Array(size.width * size.height),
    feat: new Float32Array(n * SAND_NF),
    ok: new Uint8Array(n),
    prob: new Float32Array(n),
    px: new Float32Array(n),
    py: new Float32Array(n),
    groundPts: new Int32Array(n),
    median: 0,
    allPts: new Int32Array(n),
    sumH2: new Float64Array(n),
    sumRange: new Float64Array(n),
    sumX: new Float64Array(n),
    sumY: new Float64Array(n),
    hist: new Int32Array(256),
    cellSum: new Float32Array(nCells),
    cellN: new Int32Array(nCells),
    cellProb: new Float32Array(nCells),
    label: new Uint8Array(nCells),
    queue: new Int32Array(nCells),
    streak: new Map(),
    prevStreak: new Map(),
  }
}

/** Patch index of left-image pixel `pix` (v · width + u), or −1 in the margin right of / below the last full patch. */
export function patchOfPixel(ctx: Pick<SandContext, 'width' | 'pw' | 'ph' | 'opts'>, pix: number): number {
  const u = pix % ctx.width
  const v = (pix - u) / ctx.width
  const pc = (u / ctx.opts.patchPx) | 0
  const pr = (v / ctx.opts.patchPx) | 0
  return pc < ctx.pw && pr < ctx.ph ? pr * ctx.pw + pc : -1
}

/** Probability of sand for one feature vector (SAND_NF numbers at `o` in `feat`). */
export function sandProbability(feat: ArrayLike<number>, o: number, weights: readonly number[]): number {
  let z = weights[SAND_NF]
  for (let k = 0; k < SAND_NF; k++) z += weights[k] * feat[o + k]
  return 1 / (1 + Math.exp(-z))
}

/**
 * Measure every patch of the frame after fitGround: fills `ok`, `feat`, `prob`, `px`, `py`, `groundPts`.
 * `rgb` is the left image, 3 bytes per pixel, row 0 at the top.
 */
export function sandFeatures(ctx: SandContext, rgb: Uint8Array, cloud: PointCloud, ground: GroundContext, pose: Pose): void {
  const { opts, width: W, height: H, pw, n, lum, feat, ok, prob, px, py, groundPts, allPts, sumH2, sumRange, sumX, sumY, hist } = ctx
  const P = opts.patchPx
  const { hag, cellOf } = ground
  const xyz = cloud.xyz

  for (let i = 0, o = 0; i < W * H; i++, o += 3) lum[i] = (rgb[o] * 77 + rgb[o + 1] * 150 + rgb[o + 2] * 29) >> 8

  // 1. The cloud's points per patch: how many, how many on the ground surface, their roughness, range and place.
  allPts.fill(0)
  groundPts.fill(0)
  sumH2.fill(0)
  sumRange.fill(0)
  sumX.fill(0)
  sumY.fill(0)
  hist.fill(0)
  let nGround = 0
  for (let i = 0; i < cloud.n; i++) {
    const p = patchOfPixel(ctx, cloud.pix[i])
    if (p < 0) continue
    allPts[p]++
    const h = hag[i]
    if (cellOf[i] < 0 || !(Math.abs(h) <= opts.groundTolM)) continue
    const x = xyz[i * 3]
    const y = xyz[i * 3 + 1]
    groundPts[p]++
    sumH2[p] += h * h
    sumRange[p] += Math.hypot(x - pose.x, y - pose.y)
    sumX[p] += x
    sumY[p] += y
    hist[lum[cloud.pix[i]]]++
    nGround++
  }

  // 2. Median luminance of the ground: exposure and sun angle drop out of the luminance features.
  let median = 1
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v]
    if (acc * 2 >= nGround) {
      median = Math.max(1, v)
      break
    }
  }
  ctx.median = median

  // 3. Features of the patches that show ground in range.
  for (let p = 0; p < n; p++) {
    ok[p] = 0
    prob[p] = 0
    const g = groundPts[p]
    if (allPts[p] < opts.minPoints || g < opts.minGroundShare * allPts[p]) continue
    const range = sumRange[p] / g
    if (!(range >= opts.minRangeM && range <= opts.maxRangeM)) continue
    const pr = (p / pw) | 0
    const u0 = (p - pr * pw) * P
    const v0 = pr * P
    let s = 0, s2 = 0, sr = 0, sg = 0, sb = 0, jxx = 0, jyy = 0, jxy = 0
    for (let v = v0; v < v0 + P; v++) {
      const vm = v > 0 ? v - 1 : v
      const vp = v < H - 1 ? v + 1 : v
      for (let u = u0; u < u0 + P; u++) {
        const i = v * W + u
        const l = lum[i]
        s += l
        s2 += l * l
        sr += rgb[i * 3]
        sg += rgb[i * 3 + 1]
        sb += rgb[i * 3 + 2]
        const gx = (lum[v * W + (u < W - 1 ? u + 1 : u)] - lum[v * W + (u > 0 ? u - 1 : u)]) / 2
        const gy = (lum[vp * W + u] - lum[vm * W + u]) / 2
        jxx += gx * gx
        jyy += gy * gy
        jxy += gx * gy
      }
    }
    const N = P * P
    const mean = s / N
    const o = p * SAND_NF
    feat[o] = mean / median - 1
    feat[o + 1] = Math.sqrt(Math.max(0, s2 / N - mean * mean)) / median
    feat[o + 2] = Math.sqrt((jxx + jyy) / N) / median
    feat[o + 3] = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / (jxx + jyy + 1e-6)
    feat[o + 4] = sr / Math.max(1, sr + sg + sb)
    feat[o + 5] = Math.sqrt(sumH2[p] / g)
    feat[o + 6] = Math.log(range)
    px[p] = sumX[p] / g
    py[p] = sumY[p] / g
    ok[p] = 1
    prob[p] = sandProbability(feat, o, opts.weights)
  }
}

/** Key of an absolute 0.5 m grid cell (the same cell in every frame). */
function cellKey(col: number, row: number): number {
  return (col + 1048576) * 2097152 + (row + 1048576)
}

/**
 * Find sand in the frame after fitGround, detectObstacles and detectSlopes: paints HAZARD.sand into
 * `ground.patch` (only over safe cells, only after `persistFrames` frames) and returns the 'sand' Detections.
 */
export function detectSand(ctx: SandContext, rgb: Uint8Array, cloud: PointCloud, ground: GroundContext, pose: Pose): Detection[] {
  sandFeatures(ctx, rgb, cloud, ground, pose)
  const { opts, ok, prob, cellSum, cellN, cellProb, label, queue } = ctx
  const { cols, rows, nCells, patch, cellOf, hag } = ground
  const { cellM } = ground.opts

  // 1. Mean probability per cell, from the judged patches' ground points.
  cellSum.fill(0)
  cellN.fill(0)
  for (let i = 0; i < cloud.n; i++) {
    const c = cellOf[i]
    if (c < 0 || !(Math.abs(hag[i]) <= opts.groundTolM)) continue
    const p = patchOfPixel(ctx, cloud.pix[i])
    if (p < 0 || !ok[p]) continue
    cellSum[c] += prob[p]
    cellN[c]++
  }

  // 2. Candidates, their streaks, and the cells painted this frame.
  const streak = ctx.prevStreak
  streak.clear()
  const before = ctx.streak
  const col0 = Math.round(patch.x0 / cellM)
  const row0 = Math.round(-patch.y0 / cellM)
  label.fill(0)
  for (let c = 0; c < nCells; c++) {
    cellProb[c] = cellN[c] ? cellSum[c] / cellN[c] : NaN
    if (!(cellProb[c] > opts.threshold)) continue
    const r = (c / cols) | 0
    const key = cellKey(col0 + c - r * cols, row0 + r)
    const run = (before.get(key) ?? 0) + 1
    streak.set(key, run)
    if (run < opts.persistFrames || patch.cls[c] !== HAZARD.safe) continue // never over rock, steep or drop
    patch.cls[c] = HAZARD.sand
    patch.conf[c] = cellProb[c]
    label[c] = 1
  }
  ctx.streak = streak
  ctx.prevStreak = before

  // 3. Groups of sand cells.
  const out: Detection[] = []
  for (let seed = 0; seed < nCells; seed++) {
    if (label[seed] !== 1) continue
    let qe = 0
    queue[qe++] = seed
    label[seed] = 2
    let sx = 0, sy = 0, sp = 0
    let nearest = Infinity
    for (let qs = 0; qs < qe; qs++) {
      const c = queue[qs]
      const r = (c / cols) | 0
      const col = c - r * cols
      const x = patch.x0 + (col + 0.5) * cellM
      const y = patch.y0 - (r + 0.5) * cellM
      sx += x
      sy += y
      sp += cellProb[c]
      nearest = Math.min(nearest, Math.hypot(x - pose.x, y - pose.y))
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= cols) continue
          const nb = rr * cols + cc
          if (label[nb] === 1) {
            label[nb] = 2
            queue[qe++] = nb
          }
        }
      }
    }
    if (qe < opts.minCells) continue
    const cx = sx / qe
    const cy = sy / qe
    let r2 = 0
    for (let q = 0; q < qe; q++) {
      const c = queue[q]
      const r = (c / cols) | 0
      const dx = patch.x0 + (c - r * cols + 0.5) * cellM - cx
      const dy = patch.y0 - (r + 0.5) * cellM - cy
      r2 = Math.max(r2, dx * dx + dy * dy)
    }
    out.push({ kind: 'sand', x: cx, y: cy, radiusM: Math.sqrt(r2) + cellM / 2, distanceM: nearest, confidence: sp / qe })
  }
  return out
}

/** True when the image has no colour at all (r = g = b in every sampled pixel): a grayscale camera. */
export function isGray(rgb: Uint8Array): boolean {
  const n = (rgb.length / 3) | 0
  const step = Math.max(1, (n / 512) | 0)
  for (let i = 0; i < n; i += step) if (rgb[i * 3] !== rgb[i * 3 + 1] || rgb[i * 3 + 1] !== rgb[i * 3 + 2]) return false
  return true
}

/**
 * The pipeline's sand stage. One hook per pipeline (it remembers the last frame's candidates). Frames without
 * a colour image, or with a gray one (the real rover pair), give no sand: the classifier leans on colour.
 */
export function createSandHook(opts: Partial<SandOptions> = {}): SandHook & { context(): SandContext | null } {
  let ctx: SandContext | null = null
  const hook = ((frame, p) => {
    if (!frame.rgbLeft || isGray(frame.rgbLeft)) return []
    const { width, height } = frame.intr
    if (!ctx || ctx.width !== width || ctx.height !== height || ctx.cellSum.length !== p.ground.nCells) ctx = createSandContext(frame.intr, p.ground.nCells, opts)
    return detectSand(ctx, frame.rgbLeft, p.cloud, p.ground, frame.pose)
  }) as SandHook & { context(): SandContext | null }
  hook.context = () => ctx
  return hook
}
