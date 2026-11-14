// T3.1: census stereo on synthetic pairs with known disparity. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CENSUS_BITS, censusTransform, hamming24 } from './census.ts'
import { computeDisparity, createStereoContext, depthFromDisparity, disparityFromDepth } from './stereo.ts'
import { image, intrinsics, makeTexture, median, sample } from './testScenes.ts'

const W = 256
const H = 192
/** Census radius + aggregation radius: pixels nearer the border see a clipped window. */
const MARGIN = 6

interface Score {
  medianErr: number
  validFrac: number
  n: number
}

/** Error statistics over the textured interior, where the true match lies inside the right image. */
function score(disp: Float32Array, truth: (x: number, y: number) => number): Score {
  const errs: number[] = []
  let n = 0
  for (let y = MARGIN; y < H - MARGIN; y++)
    for (let x = MARGIN; x < W - MARGIN; x++) {
      const t = truth(x, y)
      if (x - t < MARGIN) continue // the match falls off the right image
      n++
      const d = disp[y * W + x]
      if (Number.isFinite(d)) errs.push(Math.abs(d - t))
    }
  return { medianErr: median(errs), validFrac: errs.length / n, n }
}

test('census: Hamming distance, flat images give zero codes, brightness offsets do not matter', () => {
  assert.equal(hamming24(0, 0xffffff), 24)
  assert.equal(hamming24(0b1011, 0b0001), 2)
  const flat = new Uint32Array(64)
  censusTransform(new Uint8Array(64).fill(90), 8, 8, flat)
  assert.ok(flat.every((c) => c === 0))
  const tex = makeTexture(32, 32, 7)
  const a = image(32, 32, (x, y) => sample(tex, x, y) * 0.6)
  const b = image(32, 32, (x, y) => sample(tex, x, y) * 0.6 + 40)
  const ca = censusTransform(a, 32, 32, new Uint32Array(1024))
  const cb = censusTransform(b, 32, 32, new Uint32Array(1024))
  assert.deepEqual(ca, cb)
  assert.ok(ca.every((c) => c < 1 << CENSUS_BITS))
})

test('constant disparity 10 px: median error < 0.25 px, ≥ 90 % valid', () => {
  const tex = makeTexture(512, 256, 1)
  const left = image(W, H, (x, y) => sample(tex, x, y))
  const right = image(W, H, (x, y) => sample(tex, x + 10, y))
  const ctx = createStereoContext({ width: W, height: H })
  const s = score(computeDisparity(ctx, left, right), () => 10)
  console.log(`  d=10: median |err| ${s.medianErr.toFixed(3)} px, valid ${(100 * s.validFrac).toFixed(1)} %`)
  assert.ok(s.medianErr < 0.25, `median error ${s.medianErr}`)
  assert.ok(s.validFrac >= 0.9, `valid ${s.validFrac}`)
})

test('slanted plane (6 → 31 px, sub-pixel everywhere): median error < 0.25 px, ≥ 90 % valid', () => {
  // Disparity in left coordinates, linear like a ground plane seen from eye height.
  const ax = 3 / (W - 1)
  const truth = (x: number, y: number) => 6 + (22 * y) / (H - 1) + ax * x
  const tex = makeTexture(512, 256, 2)
  const left = image(W, H, (x, y) => sample(tex, x, y))
  // Right pixel xr sees left pixel x = xr + d(x, y); solve the linear equation for d.
  const right = image(W, H, (xr, y) => {
    const d = (6 + (22 * y) / (H - 1) + ax * xr) / (1 - ax)
    return sample(tex, xr + d, y)
  })
  const ctx = createStereoContext({ width: W, height: H })
  const s = score(computeDisparity(ctx, left, right), truth)
  console.log(`  slanted: median |err| ${s.medianErr.toFixed(3)} px, valid ${(100 * s.validFrac).toFixed(1)} %`)
  assert.ok(s.medianErr < 0.25, `median error ${s.medianErr}`)
  assert.ok(s.validFrac >= 0.9, `valid ${s.validFrac}`)
})

/** Wrong pixels per row (valid but > 1 px off) around a vertical step edge at x = 128. */
function stepBlur(fgOnRight: boolean): { medianWrong: number; p90Wrong: number; validFg: number } {
  const EDGE = 128
  const dBg = 8
  const dFg = 20
  const bg = makeTexture(512, 256, 3)
  const fg = makeTexture(512, 256, 4)
  const isFg = (xLeft: number) => (fgOnRight ? xLeft >= EDGE : xLeft < EDGE)
  const left = image(W, H, (x, y) => (isFg(x) ? sample(fg, x, y) : sample(bg, x, y)))
  // The nearer surface wins where both would be visible in the right image.
  const right = image(W, H, (xr, y) => (isFg(xr + dFg) ? sample(fg, xr + dFg, y) : sample(bg, xr + dBg, y)))
  const ctx = createStereoContext({ width: W, height: H })
  const disp = computeDisparity(ctx, left, right)
  const wrong: number[] = []
  let fgValid = 0
  let fgN = 0
  for (let y = MARGIN; y < H - MARGIN; y++) {
    let w = 0
    for (let x = EDGE - 24; x < EDGE + 24; x++) {
      const d = disp[y * W + x]
      const t = isFg(x) ? dFg : dBg
      if (Number.isFinite(d) && Math.abs(d - t) > 1) w++
      if (isFg(x)) {
        fgN++
        if (Number.isFinite(d)) fgValid++
      }
    }
    wrong.push(w)
  }
  wrong.sort((a, b) => a - b)
  return { medianWrong: median(wrong), p90Wrong: wrong[Math.floor(0.9 * (wrong.length - 1))], validFg: fgValid / fgN }
}

test('step edge between 8 and 20 px stays sharp (≤ 2 px blur)', () => {
  for (const fgOnRight of [true, false]) {
    const s = stepBlur(fgOnRight)
    console.log(
      `  step (near side ${fgOnRight ? 'right' : 'left'}): wrong px per row median ${s.medianWrong}, ` +
        `90th pct ${s.p90Wrong}; near side valid ${(100 * s.validFg).toFixed(1)} %`,
    )
    assert.ok(s.medianWrong <= 2, `median blur ${s.medianWrong} px`)
    assert.ok(s.validFg > 0.8, `near side valid ${s.validFg}`)
  }
})

test('textureless areas are rejected, not guessed', () => {
  const tex = makeTexture(512, 256, 5)
  const left = image(W, H, (x, y) => (x < 128 ? sample(tex, x, y) : 120))
  const right = image(W, H, (x, y) => (x + 10 < 128 ? sample(tex, x + 10, y) : 120))
  const ctx = createStereoContext({ width: W, height: H })
  const disp = computeDisparity(ctx, left, right)
  let valid = 0
  let n = 0
  for (let y = MARGIN; y < H - MARGIN; y++)
    for (let x = 150; x < W - MARGIN; x++) {
      n++
      if (Number.isFinite(disp[y * W + x])) valid++
    }
  assert.ok(valid / n < 0.02, `${valid}/${n} flat pixels got a disparity`)
})

test('depth helpers: Z = fx·B/d, valid 1–25 m', () => {
  const intr = intrinsics()
  const d5 = disparityFromDepth(5, intr)
  assert.ok(Math.abs(depthFromDisparity(d5, intr) - 5) < 1e-9)
  assert.ok(Number.isNaN(depthFromDisparity(disparityFromDepth(30, intr), intr)))
  assert.ok(Number.isNaN(depthFromDisparity(disparityFromDepth(0.9, intr), intr)))
  assert.ok(Number.isNaN(depthFromDisparity(NaN, intr)))
  assert.ok(Number.isNaN(depthFromDisparity(0, intr)))
})

test('timing: 256 × 192 × 48 disparities (warns above 60 ms, never fails)', () => {
  const tex = makeTexture(512, 256, 6)
  const left = image(W, H, (x, y) => sample(tex, x, y))
  const right = image(W, H, (x, y) => sample(tex, x + 12.4, y))
  const ctx = createStereoContext({ width: W, height: H }, { maxDisp: 48 })
  computeDisparity(ctx, left, right) // warm up the JIT
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    computeDisparity(ctx, left, right)
    times.push(performance.now() - t0)
  }
  const ms = median(times)
  console.log(`  stereo 256×192×48: median ${ms.toFixed(1)} ms over 5 runs (min ${Math.min(...times).toFixed(1)})`)
  if (ms > 60) console.warn(`  WARNING: stereo takes ${ms.toFixed(1)} ms, over the 60 ms budget`)
})
