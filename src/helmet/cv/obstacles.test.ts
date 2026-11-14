// T3.3: rocks from height above ground. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type Detection, type Pose } from '../contracts.ts'
import { gridIndex } from '../frames.ts'
import { createGroundContext, fitGround } from './ground.ts'
import { createObstacleContext, detectObstacles } from './obstacles.ts'
import { backProject, createPointCloud } from './points.ts'
import { computeDisparity, createStereoContext } from './stereo.ts'
import {
  cast,
  intrinsics,
  makeTexture,
  pixelRay,
  renderStereo,
  tiltedPlane,
  trueDisparity,
  type Box,
  type Scene,
} from './testScenes.ts'

const intr = intrinsics()
const pose: Pose = { x: 0.13, y: -0.21, z: 1.65, headingDeg: 0, pitchDeg: -15 }

/** Box with a 0.6 m square footprint centred on (x, y), standing on z = 0. */
const box = (x: number, y: number, h: number): Box => ({ min: { x: x - 0.3, y: y - 0.3, z: 0 }, max: { x: x + 0.3, y: y + 0.3, z: h } })
const BOXES = [box(-1.6, 5.3, 0.2), box(0.1, 6.1, 0.4), box(1.9, 7.2, 0.8)]
const scene: Scene = { ground: tiltedPlane(0), boxes: BOXES }

/** Pixel box [x, y, w, h] of everything a box covers in the left image. */
function silhouette(i: number): [number, number, number, number] {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
  for (let v = 0; v < intr.height; v++)
    for (let u = 0; u < intr.width; u++)
      if (cast(scene, pose, pixelRay(intr, pose, u, v))?.surface === i) {
        u0 = Math.min(u0, u), u1 = Math.max(u1, u), v0 = Math.min(v0, v), v1 = Math.max(v1, v)
      }
  return [u0, v0, u1 - u0 + 1, v1 - v0 + 1]
}

function iou(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  return inter / (a[2] * a[3] + b[2] * b[3] - inter)
}

function detect(disp: Float32Array) {
  const cloud = createPointCloud()
  backProject(disp, intr, pose, cloud)
  const g = createGroundContext(cloud.capacity)
  fitGround(g, cloud, pose)
  const o = createObstacleContext(g)
  return { dets: detectObstacles(o, g, cloud, intr, pose), patch: g.patch }
}

const near = (dets: Detection[], b: Box) =>
  dets.find((d) => Math.hypot(d.x - (b.min.x + b.max.x) / 2, d.y - (b.min.y + b.max.y) / 2) < 0.5)

test('boxes of 0.2 / 0.4 / 0.8 m: the 0.2 m one is stepped over, the others are rocks with the right height and bbox', () => {
  const { dets, patch } = detect(trueDisparity(intr, pose, scene))
  assert.equal(near(dets, BOXES[0]), undefined, '0.2 m is below the 0.30 m step limit')
  for (const i of [1, 2]) {
    const b = BOXES[i]
    const d = near(dets, b)
    assert.ok(d, `box ${b.max.z} m not found`)
    const truth = silhouette(i)
    const overlap = iou(d.bbox!, truth)
    console.log(
      `  ${b.max.z} m box: height ${d.heightM!.toFixed(3)} m, radius ${d.radiusM.toFixed(2)} m, ` +
        `distance ${d.distanceM.toFixed(2)} m, conf ${d.confidence.toFixed(2)}, bbox ${d.bbox} vs ${truth} (IoU ${overlap.toFixed(2)})`,
    )
    assert.equal(d.kind, 'rock')
    assert.ok(Math.abs(d.heightM! - b.max.z) <= 0.1, `height ${d.heightM}`)
    assert.ok(d.radiusM > 0.2 && d.radiusM < 0.6, `radius ${d.radiusM}`)
    assert.ok(Math.abs(d.distanceM - Math.hypot((b.min.x + b.max.x) / 2 - pose.x, (b.min.y + b.max.y) / 2 - pose.y)) < 0.3)
    assert.ok(overlap > 0.7, `bbox IoU ${overlap}`)
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(d.bbox![k] - truth[k]) <= 4, `bbox ${d.bbox} vs ${truth}`)
    // The box's own cell is painted rock.
    const { col, row } = gridIndex((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, patch.x0, patch.y0)
    assert.equal(patch.cls[row * patch.cols + col], HAZARD.rock)
  }
  assert.equal(dets.length, 2, `unexpected detections ${JSON.stringify(dets)}`)
})

test('patch: open ground seen is safe, ground out of view is unseen, nothing else is rock', () => {
  const { patch } = detect(trueDisparity(intr, pose, scene))
  const at = (x: number, y: number) => {
    const { col, row } = gridIndex(x, y, patch.x0, patch.y0)
    return patch.cls[row * patch.cols + col]
  }
  assert.equal(at(0.1, 3.5), HAZARD.safe) // in front, open
  assert.equal(at(-3, 10), HAZARD.safe)
  assert.equal(at(0.1, -3), HAZARD.unseen) // behind the camera
  assert.equal(at(20, 5), HAZARD.unseen) // outside the field of view
  let rock = 0
  let safe = 0
  for (let c = 0; c < patch.cls.length; c++) {
    if (patch.cls[c] === HAZARD.rock) rock++
    if (patch.cls[c] === HAZARD.safe) {
      safe++
      assert.ok(patch.conf[c] > 0 && patch.conf[c] <= 1)
    }
  }
  assert.ok(rock >= 4 && rock <= 12, `${rock} rock cells`)
  assert.ok(safe > 500, `${safe} safe cells`)
})

test('end to end through stereo: rendered boxes are found, the 0.2 m one is not', () => {
  const { left, right } = renderStereo(intr, pose, scene, makeTexture(256, 256, 21))
  const disp = computeDisparity(createStereoContext(intr), left, right)
  const { dets } = detect(disp)
  assert.equal(near(dets, BOXES[0]), undefined)
  for (const i of [1, 2]) {
    const d = near(dets, BOXES[i])
    assert.ok(d, `box ${BOXES[i].max.z} m not found in stereo`)
    console.log(`  stereo ${BOXES[i].max.z} m box: height ${d.heightM!.toFixed(3)} m, bbox ${d.bbox}, IoU ${iou(d.bbox!, silhouette(i)).toFixed(2)}`)
    assert.ok(Math.abs(d.heightM! - BOXES[i].max.z) <= 0.15, `height ${d.heightM}`)
  }
  assert.equal(dets.length, 2, `unexpected detections ${JSON.stringify(dets.map((d) => [d.x, d.y, d.heightM]))}`)
})

test('a single tall cell is kept (> 0.5 m), a single low one is noise', () => {
  const thin = (x: number, y: number, h: number): Box => ({ min: { x: x - 0.1, y: y - 0.1, z: 0 }, max: { x: x + 0.1, y: y + 0.1, z: h } })
  // Centred in a cell so each post covers exactly one cell.
  const s: Scene = { ground: tiltedPlane(0), boxes: [thin(-0.75, 4.25, 0.9), thin(1.25, 4.25, 0.4)] }
  const { dets } = detect(trueDisparity(intr, pose, s))
  assert.ok(near(dets, s.boxes[0]), '0.9 m post')
  assert.equal(near(dets, s.boxes[1]), undefined, '0.4 m single-cell post is dropped')
})

test('a cluster floating in the air (a mismatch, not a rock) is not reported', () => {
  const s: Scene = { ground: tiltedPlane(0), boxes: [{ min: { x: -0.4, y: 5.5, z: 1.1 }, max: { x: 0.4, y: 6.3, z: 1.5 } }] }
  const { dets } = detect(trueDisparity(intr, pose, s))
  assert.equal(dets.length, 0, JSON.stringify(dets))
})
