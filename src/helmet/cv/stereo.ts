// Dense stereo depth from a rectified grayscale pair (docs/helmet/PLAN.md §5.1).
//
// census 5 × 5 on both images → Hamming cost for every disparity 0..maxDisp−1 → 9 × 9 box aggregation →
// winner-takes-all → sub-pixel parabola → left-right consistency → uniqueness check.
//
// The box filter is separable and uses running sums: a column sum per (x, d) slides down the image and a
// row sum per d slides along each row, so the work is O(W·H·D) whatever the window size. Only one row of
// the aggregated cost volume exists at a time, which keeps the memory small (W·D values) and the cache
// warm. All buffers live in a StereoContext created once per image size: nothing is allocated per frame,
// so the same code can run in the CV worker at the CV tick rate.
import type { StereoIntrinsics } from '../contracts.ts'
import { CENSUS_BITS, POPCOUNT12, censusTransform } from './census.ts'

export interface StereoOptions {
  /** Number of disparities searched: 0..maxDisp−1 pixels. */
  maxDisp: number
  /** Half size of the box aggregation window: 4 = 9 × 9. */
  aggRadius: number
  /**
   * Reject a pixel when best cost ≥ uniqueness × second-best cost (second best taken away from the
   * best's direct neighbours). Lower is stricter. PLAN §5.1 starts from 0.95, which only rejects flat,
   * textureless curves; on a rendered scene (obstacles.test.ts) it let through ~450 wrong pixels along the
   * sky/horizon edge, 0.8 cut them to ~70 and kept the valid share of the synthetic tests (≥ 98.8 %).
   * Tune it on rendered frames in the eval harness (T4.4).
   */
  uniqueness: number
  /** Largest allowed difference between the left and the right disparity map, pixels. */
  lrMaxDiff: number
}

export const STEREO_DEFAULTS: StereoOptions = { maxDisp: 48, aggRadius: 4, uniqueness: 0.8, lrMaxDiff: 1 }

/** Valid depth range for the helmet's CV, metres. Nearer than this is beyond maxDisp anyway. */
export const DEPTH_MIN_M = 1
export const DEPTH_MAX_M = 25

export interface StereoContext {
  readonly width: number
  readonly height: number
  readonly opts: StereoOptions
  readonly censusL: Uint32Array
  readonly censusR: Uint32Array
  /** Vertical window sums of the raw cost, per (x, d). */
  readonly colSum: Int32Array
  /** Running horizontal sum per d. */
  readonly rowSum: Int32Array
  /** One row of the aggregated cost volume, per (x, d). */
  readonly aggRow: Int32Array
  /** Integer winner of the right image's disparity map, one row. */
  readonly dispRightRow: Int16Array
  /** Output: disparity of the left image in pixels, NaN where invalid. Reused by every call. */
  readonly disparity: Float32Array
  /** Valid pixels of the last call. */
  validCount: number
}

export function createStereoContext(
  size: Pick<StereoIntrinsics, 'width' | 'height'>,
  opts: Partial<StereoOptions> = {},
): StereoContext {
  const o = { ...STEREO_DEFAULTS, ...opts }
  const { width, height } = size
  if (o.maxDisp < 3 || o.maxDisp > width) throw new Error(`maxDisp ${o.maxDisp} out of range`)
  // Largest aggregated cost: (2r+1)² × 24 bits. Int32 holds it for any sane window.
  return {
    width,
    height,
    opts: o,
    censusL: new Uint32Array(width * height),
    censusR: new Uint32Array(width * height),
    colSum: new Int32Array(width * o.maxDisp),
    rowSum: new Int32Array(o.maxDisp),
    aggRow: new Int32Array(width * o.maxDisp),
    dispRightRow: new Int16Array(width),
    disparity: new Float32Array(width * height),
    validCount: 0,
  }
}

/**
 * Add (sign = 1) or remove (sign = −1) the raw census costs of image row `y` to the column sums.
 * Disparities that point outside the right image cost the maximum, so they never win.
 */
function accumulateRow(ctx: StereoContext, y: number, sign: number): void {
  const { width: W, censusL, censusR, colSum } = ctx
  const D = ctx.opts.maxDisp
  const base = y * W
  for (let x = 0; x < W; x++) {
    const cl = censusL[base + x]
    const o = x * D
    const dMax = x < D - 1 ? x : D - 1
    for (let d = 0; d <= dMax; d++) {
      const v = cl ^ censusR[base + x - d]
      colSum[o + d] += sign * (POPCOUNT12[v & 4095] + POPCOUNT12[v >>> 12])
    }
    for (let d = dMax + 1; d < D; d++) colSum[o + d] += sign * CENSUS_BITS
  }
}

/** Column sums += raw costs of row `yAdd` − raw costs of row `ySub`, in one pass. */
function slideRows(ctx: StereoContext, yAdd: number, ySub: number): void {
  const { width: W, censusL, censusR, colSum } = ctx
  const D = ctx.opts.maxDisp
  const a = yAdd * W
  const b = ySub * W
  for (let x = 0; x < W; x++) {
    const ca = censusL[a + x]
    const cb = censusL[b + x]
    const o = x * D
    // Disparities past the left edge cost the maximum in both rows: they cancel.
    const dMax = x < D - 1 ? x : D - 1
    for (let d = 0; d <= dMax; d++) {
      const va = ca ^ censusR[a + x - d]
      const vb = cb ^ censusR[b + x - d]
      colSum[o + d] += POPCOUNT12[va & 4095] + POPCOUNT12[va >>> 12] - POPCOUNT12[vb & 4095] - POPCOUNT12[vb >>> 12]
    }
  }
}

/**
 * Disparity of the left image (pixels, NaN = invalid) for a rectified grayscale pair. Returns
 * `ctx.disparity`, which the next call overwrites: copy it before transferring it to another thread.
 */
export function computeDisparity(ctx: StereoContext, left: Uint8Array, right: Uint8Array): Float32Array {
  const { width: W, height: H, colSum, rowSum, aggRow, dispRightRow, disparity } = ctx
  const { maxDisp: D, aggRadius: r, uniqueness, lrMaxDiff } = ctx.opts
  if (left.length < W * H || right.length < W * H) throw new Error('image smaller than the stereo context')

  censusTransform(left, W, H, ctx.censusL)
  censusTransform(right, W, H, ctx.censusR)

  // Column sums for row 0: window rows −r..r, edge rows repeated.
  colSum.fill(0)
  for (let dy = -r; dy <= r; dy++) accumulateRow(ctx, Math.min(H - 1, Math.max(0, dy)), 1)

  let valid = 0
  for (let y = 0; y < H; y++) {
    // 1. Horizontal running sum of the column sums → aggregated cost row, edge columns repeated.
    for (let d = 0; d < D; d++) {
      let s = 0
      for (let dx = -r; dx <= r; dx++) s += colSum[Math.min(W - 1, Math.max(0, dx)) * D + d]
      rowSum[d] = s
    }
    for (let x = 0; x < W; x++) {
      const o = x * D
      const addO = Math.min(W - 1, x + r + 1) * D
      const subO = Math.max(0, x - r) * D
      for (let d = 0; d < D; d++) {
        aggRow[o + d] = rowSum[d]
        rowSum[d] += colSum[addO + d] - colSum[subO + d]
      }
    }

    // 2. Right image's winners, for the left-right check: right pixel xr sees left pixel xr + d.
    for (let xr = 0; xr < W; xr++) {
      let best = 0x7fffffff
      let bd = 0
      const dMax = Math.min(D - 1, W - 1 - xr)
      for (let d = 0; d <= dMax; d++) {
        const c = aggRow[(xr + d) * D + d]
        if (c < best) {
          best = c
          bd = d
        }
      }
      dispRightRow[xr] = bd
    }

    // 3. Left winners with sub-pixel refinement and the two rejection tests.
    const rowOut = y * W
    for (let x = 0; x < W; x++) {
      const o = x * D
      let best = 0x7fffffff
      let bd = 0
      for (let d = 0; d < D; d++) {
        const c = aggRow[o + d]
        if (c < best) {
          best = c
          bd = d
        }
      }
      // Ends of the search range: no parabola, and d = maxDisp−1 may just be clipped. d = 0 is infinitely far.
      if (bd === 0 || bd === D - 1) {
        disparity[rowOut + x] = NaN
        continue
      }
      // Left-right consistency: the right image must pick (nearly) the same disparity back.
      const xr = x - bd
      if (xr < 0 || Math.abs(dispRightRow[xr] - bd) > lrMaxDiff) {
        disparity[rowOut + x] = NaN
        continue
      }
      // Uniqueness: second best away from the winner's neighbours must be clearly worse.
      let second = 0x7fffffff
      for (let d = 0; d < D; d++) {
        if (d >= bd - 1 && d <= bd + 1) continue
        const c = aggRow[o + d]
        if (c < second) second = c
      }
      if (best >= uniqueness * second) {
        disparity[rowOut + x] = NaN
        continue
      }
      const c0 = aggRow[o + bd - 1]
      const c2 = aggRow[o + bd + 1]
      const denom = c0 - 2 * best + c2
      let off = denom > 0 ? (c0 - c2) / (2 * denom) : 0
      if (off > 0.5) off = 0.5
      else if (off < -0.5) off = -0.5
      disparity[rowOut + x] = bd + off
      valid++
    }

    // 4. Slide the vertical window down one row.
    if (y + 1 < H) {
      const yAdd = Math.min(H - 1, y + 1 + r)
      const ySub = Math.max(0, y - r)
      if (yAdd !== ySub) slideRows(ctx, yAdd, ySub)
    }
  }
  ctx.validCount = valid
  return disparity
}

/** Depth along the optical axis, metres, or NaN when the disparity is invalid or outside 1–25 m. */
export function depthFromDisparity(d: number, intr: Pick<StereoIntrinsics, 'fx' | 'baselineM'>): number {
  if (!(d > 0)) return NaN
  const z = (intr.fx * intr.baselineM) / d
  return z >= DEPTH_MIN_M && z <= DEPTH_MAX_M ? z : NaN
}

/** Disparity, pixels, of a point at depth `z` metres. */
export function disparityFromDepth(z: number, intr: Pick<StereoIntrinsics, 'fx' | 'baselineM'>): number {
  return (intr.fx * intr.baselineM) / z
}
