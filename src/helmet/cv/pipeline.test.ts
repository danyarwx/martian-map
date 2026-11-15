// T3.5 (worker half): the whole CV chain on one frame, in Node (no worker). Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type CvFrame, type HazardPatch, type Pose } from '../contracts.ts'
import { gridIndex } from '../frames.ts'
import { detectDrops, groundCellHeights, mergeDrops } from './drop.ts'
import { createCvPipeline, runFrame, type SandHook } from './pipeline.ts'
import { intrinsics, makeTexture, planeZ, renderStereo, tiltedPlane, type Box, type Scene } from './testScenes.ts'

const intr = intrinsics()
const pose: Pose = { x: 0.13, y: -0.21, z: 1.65, headingDeg: 0, pitchDeg: -15 }
/** 0.6 m box, 6 m ahead of the camera. */
const BOX: Box = { min: { x: -0.3, y: 5.7, z: 0 }, max: { x: 0.3, y: 6.3, z: 0.6 } }
const boxScene: Scene = { ground: tiltedPlane(0), boxes: [BOX] }
const boxPair = renderStereo(intr, pose, boxScene, makeTexture(256, 256, 21))

const frame = (id: number, pair: { left: Uint8Array; right: Uint8Array }, p: Pose, i = intr): CvFrame => ({
  id,
  left: pair.left,
  right: pair.right,
  intr: i,
  pose: p,
})

function clsAt(patch: HazardPatch, x: number, y: number): number {
  const { col, row } = gridIndex(x, y, patch.x0, patch.y0)
  return patch.cls[row * patch.cols + col]
}
const count = (patch: HazardPatch, cls: number) => patch.cls.reduce((n, c) => n + (c === cls ? 1 : 0), 0)

test('flat ground with a 0.6 m box 6 m ahead: one rock in the right place, rock cells there, safe around', () => {
  const p = createCvPipeline(intr)
  const res = runFrame(p, frame(7, boxPair, pose))
  assert.equal(res.id, 7)
  assert.ok(res.ms > 0)
  assert.equal(res.disparity.length, intr.width * intr.height)
  const rocks = res.detections.filter((d) => d.kind === 'rock' && d.level !== 'small')
  console.log(`  box frame: ${res.ms.toFixed(1)} ms, detections ${JSON.stringify(res.detections.map((d) => ({ kind: d.kind, x: +d.x.toFixed(2), y: +d.y.toFixed(2), h: d.heightM && +d.heightM.toFixed(2) })))}`)
  assert.equal(rocks.length, 1, JSON.stringify(res.detections))
  const r = rocks[0]
  assert.ok(Math.hypot(r.x - 0, r.y - 6) < 0.5, `rock at (${r.x}, ${r.y})`)
  assert.ok(Math.abs(r.heightM! - 0.6) < 0.15, `height ${r.heightM}`)
  assert.ok(Math.abs(r.distanceM - Math.hypot(0 - pose.x, 6 - pose.y)) < 0.5)
  assert.equal(res.detections.length, 1, 'no slope, sand or drop on flat ground')

  const { patch } = res
  assert.equal(clsAt(patch, 0, 6), HAZARD.rock)
  for (const [x, y] of [[0, 3], [0, 4.5], [-1.5, 6], [1.5, 6], [-2.5, 9]]) assert.equal(clsAt(patch, x, y), HAZARD.safe, `(${x}, ${y})`)
  assert.equal(clsAt(patch, 0, -3), HAZARD.unseen, 'behind the camera')
  const rockCells = count(patch, HAZARD.rock)
  assert.ok(rockCells >= 2 && rockCells <= 9, `${rockCells} rock cells`)
  assert.equal(count(patch, HAZARD.steep) + count(patch, HAZARD.drop) + count(patch, HAZARD.sand), 0)
})

test('25° slope: steep cells and a no-go steep detection, no drop', () => {
  const scene: Scene = { ground: tiltedPlane(25, 0), boxes: [] }
  const p0: Pose = { x: 1.1, y: -0.7, z: planeZ(scene.ground, 1.1, -0.7) + 1.65, headingDeg: 0, pitchDeg: -15 }
  const res = runFrame(createCvPipeline(intr), frame(1, renderStereo(intr, p0, scene, makeTexture(256, 256, 55)), p0))
  const steep = res.detections.filter((d) => d.kind === 'steep')
  console.log(`  25° frame: ${res.ms.toFixed(1)} ms, ${count(res.patch, HAZARD.steep)} steep cells, slopes ${steep.map((d) => d.slopeDeg!.toFixed(1))}`)
  assert.ok(count(res.patch, HAZARD.steep) > 50, 'same bar as slope.test.ts through stereo')
  assert.ok(steep.some((d) => Math.abs(d.slopeDeg! - 25) < 1.5 && d.confidence > 0.6))
  assert.equal(res.detections.filter((d) => d.kind !== 'steep').length, 0)
})

test('the result owns its buffers: later frames and context writes do not change it', () => {
  const p = createCvPipeline(intr)
  const res = runFrame(p, frame(1, boxPair, pose))
  assert.notEqual(res.disparity.buffer, p.stereo.disparity.buffer)
  assert.notEqual(res.patch.cls.buffer, p.ground.patch.cls.buffer)
  assert.notEqual(res.patch.conf.buffer, p.ground.patch.conf.buffer)
  const disp = Array.from(res.disparity)
  const cls = Array.from(res.patch.cls)
  const conf = Array.from(res.patch.conf)
  // Another scene through the same pipeline, then scribble over the contexts.
  const scene: Scene = { ground: tiltedPlane(25, 0), boxes: [] }
  const p1: Pose = { ...pose, z: planeZ(scene.ground, pose.x, pose.y) + 1.65 }
  runFrame(p, frame(2, renderStereo(intr, p1, scene, makeTexture(256, 256, 3)), p1))
  p.stereo.disparity.fill(3)
  p.ground.patch.cls.fill(HAZARD.drop)
  p.ground.patch.conf.fill(0.5)
  assert.deepEqual(Array.from(res.disparity), disp)
  assert.deepEqual(Array.from(res.patch.cls), cls)
  assert.deepEqual(Array.from(res.patch.conf), conf)
})

test('new intrinsics rebuild the contexts', () => {
  const p = createCvPipeline(intr)
  runFrame(p, frame(1, boxPair, pose))
  const small = intrinsics(128, 96)
  const res = runFrame(p, frame(2, renderStereo(small, pose, boxScene, makeTexture(256, 256, 21)), pose, small))
  assert.equal(p.stereo.width, 128)
  assert.equal(res.disparity.length, 128 * 96)
  assert.equal(p.frames, 2)
  // Back to the first size: still right.
  const again = runFrame(p, frame(3, boxPair, pose))
  assert.equal(again.detections.filter((d) => d.kind === 'rock').length, 1)
})

test('the sand hook runs between slopes and drops and its detections are returned', () => {
  let calls = 0
  const sandHook: SandHook = (f, p) => {
    calls++
    assert.equal(f.id, 5)
    const { col, row } = gridIndex(-2, 4, p.ground.patch.x0, p.ground.patch.y0)
    p.ground.patch.cls[row * p.ground.patch.cols + col] = HAZARD.sand
    p.ground.patch.conf[row * p.ground.patch.cols + col] = 0.7
    return [{ kind: 'sand', x: -2, y: 4, radiusM: 0.25, distanceM: 4.6, confidence: 0.7 }]
  }
  const res = runFrame(createCvPipeline(intr, { sandHook }), frame(5, boxPair, pose))
  assert.equal(calls, 1)
  assert.equal(res.detections.filter((d) => d.kind === 'sand').length, 1)
  assert.equal(clsAt(res.patch, -2, 4), HAZARD.sand)
})

test('timing: whole pipeline per 256 × 192 frame (reported; warns above the 60 ms budget)', () => {
  const p = createCvPipeline(intr)
  runFrame(p, frame(0, boxPair, pose)) // warm-up (JIT)
  const N = 8
  let total = 0
  let worst = 0
  for (let i = 1; i <= N; i++) {
    const t0 = performance.now()
    const res = runFrame(p, frame(i, boxPair, pose))
    const wall = performance.now() - t0
    total += res.ms
    worst = Math.max(worst, wall)
  }
  const mean = total / N
  // The drop stage alone, on the last frame's ground (heights + lips + merge).
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    groundCellHeights(p.ground, p.cloud, pose, p.heights, p.drop.opts)
    detectDrops(p.drop, p.heights, pose)
    mergeDrops(p.drop, p.heights, p.ground.patch)
  }
  const dropMs = (performance.now() - t0) / N
  console.log(`  pipeline: ${mean.toFixed(1)} ms/frame mean, ${worst.toFixed(1)} ms worst, over ${N} frames (Node, one thread); drop stage ${dropMs.toFixed(2)} ms`)
  if (mean > 60) console.warn(`  WARNING: ${mean.toFixed(1)} ms/frame is above the 60 ms budget (PLAN §5.1)`)
})
