// T5.2: the sand classifier on synthetic patches, through the real pipeline, in Node. Run with `npm test`.
// The geometry (point cloud, ground) comes from a rendered flat scene; the colour image is made here, so each
// test decides what the ground "looks like": smooth and dark on one side, textured on the other.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type CvFrame, type HazardPatch, type Pose } from '../contracts.ts'
import { gridIndex } from '../frames.ts'
import { createCvPipeline, runFrame } from './pipeline.ts'
import { createSandHook, isGray, SAND_FEATURES, SAND_NF, sandProbability } from './sand.ts'
import { SAND_WEIGHTS } from './sandWeights.ts'
import { intrinsics, makeTexture, renderStereo, rng, tiltedPlane, type Box, type Scene } from './testScenes.ts'

const intr = intrinsics()
const W = intr.width
const H = intr.height
const pose: Pose = { x: 0.2, y: 0.1, z: 1.65, headingDeg: 0, pitchDeg: -15 }
const flat: Scene = { ground: tiltedPlane(0), boxes: [] }
const flatPair = renderStereo(intr, pose, flat, makeTexture(256, 256, 31))

/** Hand-set weights for the tests: sand is what has little contrast and little gradient. */
const SMOOTH_IS_SAND = [0, -60, -60, 0, 0, 0, 0, 4]
const F = Object.fromEntries(SAND_FEATURES.map((name, k) => [name, k])) as Record<(typeof SAND_FEATURES)[number], number>

/** A colour image: `f` gives [r, g, b] for pixel (u, v). */
function rgbImage(f: (u: number, v: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(W * H * 3)
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const c = f(u, v)
      const o = (v * W + u) * 3
      out[o] = c[0]
      out[o + 1] = c[1]
      out[o + 2] = c[2]
    }
  return out
}

/** Left half (west of the camera, which looks north): smooth and dark. Right half: bright speckle. */
function halfSmoothHalfTextured(): Uint8Array {
  const r = rng(9)
  const noise = new Float32Array(W * H)
  for (let i = 0; i < noise.length; i++) noise[i] = (r() - 0.5) * 90
  return rgbImage((u, v) => {
    if (u < W / 2) return [96, 80, 66]
    const n = noise[v * W + u]
    return [150 + n, 100 + n * 0.8, 62 + n * 0.6]
  })
}

const frame = (id: number, rgbLeft: Uint8Array | undefined, pair = flatPair): CvFrame => ({ id, left: pair.left, right: pair.right, rgbLeft, intr, pose })

function clsAt(patch: HazardPatch, x: number, y: number): number {
  const { col, row } = gridIndex(x, y, patch.x0, patch.y0)
  return patch.cls[row * patch.cols + col]
}
const count = (patch: HazardPatch, cls: number) => patch.cls.reduce((n, c) => n + (c === cls ? 1 : 0), 0)

test('features: smooth patches have no contrast or gradient, speckle has both; stripes point one way', () => {
  const hook = createSandHook({ weights: SMOOTH_IS_SAND })
  const p = createCvPipeline(intr, { sandHook: hook })
  runFrame(p, frame(1, halfSmoothHalfTextured()))
  const ctx = hook.context()!
  assert.equal(ctx.pw, 16)
  assert.equal(ctx.ph, 12)
  let smooth = 0
  let rough = 0
  for (let k = 0; k < ctx.n; k++) {
    if (!ctx.ok[k]) continue
    const pc = k % ctx.pw
    if (pc === 7 || pc === 8) continue // the patches next to the border see the other side in their gradients
    const o = k * SAND_NF
    if (pc < 7) {
      smooth++
      assert.ok(ctx.feat[o + F.contrast] < 0.01 && ctx.feat[o + F.gradEnergy] < 0.01, `smooth patch ${k}`)
      assert.ok(Math.abs(ctx.feat[o + F.redness] - 96 / (96 + 80 + 66)) < 0.005)
      assert.ok(ctx.prob[k] > 0.9, `smooth patch ${k}: p ${ctx.prob[k]}`)
    } else {
      rough++
      assert.ok(ctx.feat[o + F.contrast] > 0.08 && ctx.feat[o + F.gradEnergy] > 0.08, `speckled patch ${k}`)
      assert.ok(ctx.feat[o + F.coherence] < 0.45, `speckle has no direction: ${ctx.feat[o + F.coherence]}`)
      assert.ok(ctx.prob[k] < 0.1, `speckled patch ${k}: p ${ctx.prob[k]}`)
    }
    assert.ok(ctx.feat[o + F.roughness] < 0.2, `flat ground: roughness ${ctx.feat[o + F.roughness]}`) // stereo noise grows with range
    const range = Math.exp(ctx.feat[o + F.logRange])
    assert.ok(range >= 2 && range <= 14, `range ${range}`)
  }
  assert.ok(smooth >= 20 && rough >= 20, `${smooth} smooth and ${rough} speckled patches judged`)

  // vertical stripes: every gradient points across them
  const stripes = createSandHook({ weights: SMOOTH_IS_SAND })
  runFrame(createCvPipeline(intr, { sandHook: stripes }), frame(2, rgbImage((u) => (u % 8 < 4 ? [170, 120, 80] : [110, 78, 52]))))
  const sc = stripes.context()!
  let judged = 0
  for (let k = 0; k < sc.n; k++) {
    if (!sc.ok[k]) continue
    judged++
    assert.ok(sc.feat[k * SAND_NF + F.coherence] > 0.95, `stripes: coherence ${sc.feat[k * SAND_NF + F.coherence]}`)
  }
  assert.ok(judged >= 40)
})

test('sand cells appear on the smooth side only, and only from the second frame', () => {
  const p = createCvPipeline(intr, { sandHook: createSandHook({ weights: SMOOTH_IS_SAND }) })
  const first = runFrame(p, frame(1, halfSmoothHalfTextured()))
  assert.equal(count(first.patch, HAZARD.sand), 0, 'one frame is not enough')
  assert.equal(first.detections.filter((d) => d.kind === 'sand').length, 0)

  const second = runFrame(p, frame(2, halfSmoothHalfTextured()))
  for (const [x, y] of [[-1.5, 4], [-2, 6], [-3, 8]]) assert.equal(clsAt(second.patch, x, y), HAZARD.sand, `(${x}, ${y})`)
  for (const [x, y] of [[1.5, 4], [2, 6], [3, 8]]) assert.equal(clsAt(second.patch, x, y), HAZARD.safe, `(${x}, ${y})`)
  const sand = second.detections.filter((d) => d.kind === 'sand')
  assert.equal(sand.length, 1, JSON.stringify(sand))
  assert.ok(sand[0].x < -0.5 && sand[0].confidence > 0.6 && sand[0].radiusM > 1, JSON.stringify(sand[0]))
  // every sand cell lies west of the camera (a cell of slack for the patches on the border)
  const { patch } = second
  for (let k = 0; k < patch.cls.length; k++) {
    if (patch.cls[k] !== HAZARD.sand) continue
    const col = k % patch.cols
    assert.ok(patch.x0 + (col + 0.5) * 0.5 < pose.x + 1, `sand cell at x ${patch.x0 + (col + 0.5) * 0.5}`)
    assert.ok(patch.conf[k] > 0.6 && patch.conf[k] <= 1)
  }

  // a frame that no longer looks like sand ends the streak
  const third = runFrame(p, frame(3, rgbImage(() => [150, 100, 62]).map((v, i) => v + ((i * 7919) % 61) - 30) as Uint8Array))
  assert.equal(count(third.patch, HAZARD.sand), 0)
})

test('sand never overwrites a rock', () => {
  const box: Box = { min: { x: -0.3, y: 5.7, z: 0 }, max: { x: 0.3, y: 6.3, z: 0.6 } }
  const pair = renderStereo(intr, pose, { ground: tiltedPlane(0), boxes: [box] }, makeTexture(256, 256, 21))
  const smoothEverywhere = () => rgbImage(() => [96, 80, 66])
  const plain = createCvPipeline(intr)
  const want = runFrame(plain, frame(1, undefined, pair))
  const p = createCvPipeline(intr, { sandHook: createSandHook({ weights: SMOOTH_IS_SAND }) })
  runFrame(p, frame(1, smoothEverywhere(), pair))
  const got = runFrame(p, frame(2, smoothEverywhere(), pair))
  assert.ok(count(want.patch, HAZARD.rock) >= 2)
  for (let k = 0; k < want.patch.cls.length; k++) {
    if (want.patch.cls[k] === HAZARD.rock) assert.equal(got.patch.cls[k], HAZARD.rock, `rock cell ${k} kept`)
    if (want.patch.cls[k] === HAZARD.unseen) assert.equal(got.patch.cls[k], HAZARD.unseen, `unseen cell ${k} stays unseen`)
  }
  assert.ok(count(got.patch, HAZARD.sand) > 50, 'the ground around the rock is sand')
  assert.equal(got.detections.filter((d) => d.kind === 'rock').length, 1)
})

test('deterministic: the same frames give the same cells, confidences and detections', () => {
  const run = () => {
    const p = createCvPipeline(intr, { sandHook: createSandHook({ weights: SMOOTH_IS_SAND }) })
    runFrame(p, frame(1, halfSmoothHalfTextured()))
    return runFrame(p, frame(2, halfSmoothHalfTextured()))
  }
  const a = run()
  const b = run()
  assert.deepEqual(a.patch.cls, b.patch.cls)
  assert.deepEqual(a.patch.conf, b.patch.conf)
  assert.deepEqual(a.detections, b.detections)
})

test('a gray image or no colour image gives no sand; the shipped weights are eight finite numbers', () => {
  const p = createCvPipeline(intr, { sandHook: createSandHook({ weights: [0, 0, 0, 0, 0, 0, 0, 10] }) }) // "everything is sand"
  const gray = () => rgbImage((u, v) => [flatPair.left[v * W + u], flatPair.left[v * W + u], flatPair.left[v * W + u]])
  assert.ok(isGray(gray()))
  assert.ok(!isGray(halfSmoothHalfTextured()))
  runFrame(p, frame(1, gray()))
  assert.equal(count(runFrame(p, frame(2, gray())).patch, HAZARD.sand), 0)
  runFrame(p, frame(3, undefined))
  assert.equal(count(runFrame(p, frame(4, undefined)).patch, HAZARD.sand), 0)
  runFrame(p, frame(5, halfSmoothHalfTextured()))
  assert.ok(count(runFrame(p, frame(6, halfSmoothHalfTextured())).patch, HAZARD.sand) > 100, 'with colour the same weights paint sand')

  assert.equal(SAND_WEIGHTS.length, SAND_NF + 1)
  assert.ok(SAND_WEIGHTS.every((w) => Number.isFinite(w)))
  const p0 = sandProbability(new Float32Array(SAND_NF), 0, [0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(p0, 0.5)
})
