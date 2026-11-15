// T3.2: local ground planes from one frame. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pose } from '../contracts.ts'
import { gridIndex } from '../frames.ts'
import { blockSlopeDeg, createGroundContext, fitGround, groundAt, type GroundContext } from './ground.ts'
import { backProject, createPointCloud, type PointCloud } from './points.ts'
import { computeDisparity, createStereoContext } from './stereo.ts'
import {
  intrinsics,
  makeTexture,
  median,
  planeZ,
  renderStereo,
  rng,
  tiltedPlane,
  trueDisparity,
  type Plane,
  type Scene,
} from './testScenes.ts'

const intr = intrinsics()
const EYE = 1.65

function poseOn(ground: Plane, x: number, y: number, headingDeg: number, pitchDeg = -15): Pose {
  return { x, y, z: planeZ(ground, x, y) + EYE, headingDeg, pitchDeg }
}

function run(disp: Float32Array, pose: Pose): { g: GroundContext; cloud: PointCloud } {
  const cloud = createPointCloud()
  backProject(disp, intr, pose, cloud)
  const g = createGroundContext(cloud.capacity)
  fitGround(g, cloud, pose)
  return { g, cloud }
}

/** Slope (degrees) and uphill heading of every block with a plane. */
function blockSlopes(g: GroundContext): { slopes: number[]; uphill: number[] } {
  const slopes: number[] = []
  const uphill: number[] = []
  for (let b = 0; b < g.blocksX * g.blocksY; b++) {
    if (!g.planeOk[b]) continue
    slopes.push(blockSlopeDeg(g, b))
    // z = a·x + b·y + c rises along (a, b).
    uphill.push(((Math.atan2(g.plane[b * 3], g.plane[b * 3 + 1]) * 180) / Math.PI + 360) % 360)
  }
  return { slopes, uphill }
}

/** Gaussian noise added to every valid disparity (Box–Muller, seeded). */
function addNoise(disp: Float32Array, sigma: number, seed: number): Float32Array {
  const r = rng(seed)
  return disp.map((d) => d + sigma * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()))
}

test('10° slope from exact disparity: every block within 1°, uphill direction right, ground under the feet', () => {
  for (const [upDir, heading] of [[0, 0], [30, 20], [250, 90]]) {
    const ground = tiltedPlane(10, upDir)
    const pose = poseOn(ground, 5, -7, heading)
    const { g, cloud } = run(trueDisparity(intr, pose, { ground, boxes: [] }), pose)
    const { slopes, uphill } = blockSlopes(g)
    assert.ok(slopes.length >= 15, `${slopes.length} blocks`)
    for (const s of slopes) assert.ok(Math.abs(s - 10) < 1, `block slope ${s}`)
    const dir = median(uphill.map((h) => ((h - upDir + 540) % 360) - 180))
    assert.ok(Math.abs(dir) < 2, `uphill ${dir}° off`)
    const foot = groundAt(g, pose.x + 3 * Math.sin((heading * Math.PI) / 180), pose.y + 3 * Math.cos((heading * Math.PI) / 180))
    const truth = planeZ(ground, pose.x + 3 * Math.sin((heading * Math.PI) / 180), pose.y + 3 * Math.cos((heading * Math.PI) / 180))
    assert.ok(Math.abs(foot - truth) < 0.02, `ground 3 m ahead ${foot} vs ${truth}`)
    const hag = Array.from(g.hag.subarray(0, cloud.n)).filter(Number.isFinite)
    assert.ok(hag.length > 0.95 * cloud.n)
    assert.ok(Math.max(...hag.map(Math.abs)) < 0.02, 'every point sits on the ground')
  }
})

test('10° slope with 0.1 px disparity noise: median slope within 1°', () => {
  const ground = tiltedPlane(10, 0)
  const pose = poseOn(ground, 0, 0, 0)
  const { g } = run(addNoise(trueDisparity(intr, pose, { ground, boxes: [] }), 0.1, 3), pose)
  const m = median(blockSlopes(g).slopes)
  console.log(`  0.1 px noise: median block slope ${m.toFixed(2)}° (true 10°)`)
  assert.ok(Math.abs(m - 10) < 1, `${m}`)
})

test('end to end: rendered 10° slope → stereo → points → ground, slope within 1°, points within 5 cm at 5 m', () => {
  const ground = tiltedPlane(10, 0)
  const pose = poseOn(ground, 0, 0, 0)
  const scene: Scene = { ground, boxes: [] }
  const { left, right } = renderStereo(intr, pose, scene, makeTexture(256, 256, 9))
  const stereo = createStereoContext(intr)
  const disp = computeDisparity(stereo, left, right)
  const { g, cloud } = run(disp, pose)
  const m = median(blockSlopes(g).slopes)
  // Distance of the points at ~5 m to the true plane, along the vertical.
  const errs: number[] = []
  for (let i = 0; i < cloud.n; i++) {
    const x = cloud.xyz[i * 3], y = cloud.xyz[i * 3 + 1], z = cloud.xyz[i * 3 + 2]
    const range = Math.hypot(x - pose.x, y - pose.y, z - pose.z)
    if (Math.abs(range - 5) < 0.5) errs.push(Math.abs(z - planeZ(ground, x, y)))
  }
  const valid = stereo.validCount / (intr.width * intr.height)
  console.log(
    `  end to end: valid ${(100 * valid).toFixed(1)} %, median block slope ${m.toFixed(2)}°, ` +
      `height error at 5 m median ${(100 * median(errs)).toFixed(2)} cm`,
  )
  assert.ok(Math.abs(m - 10) < 1, `${m}`)
  assert.ok(median(errs) < 0.05)
})

test('a boulder on flat ground does not lift the ground under it', () => {
  const ground = tiltedPlane(0)
  const pose = poseOn(ground, 0, 0, 0)
  const scene: Scene = { ground, boxes: [{ min: { x: -0.6, y: 5, z: 0 }, max: { x: 0.6, y: 6.2, z: 0.9 } }] }
  const { g } = run(trueDisparity(intr, pose, scene), pose)
  for (const [x, y] of [[0, 5.2], [0, 5.6], [-0.4, 5.1], [0.5, 6]]) {
    const z = groundAt(g, x, y)
    assert.ok(Math.abs(z) < 0.03, `ground under the boulder at ${x},${y}: ${z}`)
  }
})

test('cells follow frames.gridIndex, the patch snaps to the 4 m lattice, and fits are deterministic', () => {
  const ground = tiltedPlane(6, 120)
  const pose = poseOn(ground, 13.3, -21.7, 200)
  const disp = addNoise(trueDisparity(intr, pose, { ground, boxes: [] }), 0.2, 5)
  const a = run(disp, pose)
  const b = run(disp, pose)
  assert.deepEqual(a.g.plane, b.g.plane)
  const { patch } = a.g
  assert.ok(patch.x0 % 4 === 0 && patch.y0 % 4 === 0, `${patch.x0}, ${patch.y0}`)
  assert.ok(patch.x0 < pose.x - 30 && patch.x0 + patch.cols * 0.5 > pose.x + 30)
  assert.ok(patch.y0 > pose.y + 30 && patch.y0 - patch.rows * 0.5 < pose.y - 30)
  for (let i = 0; i < a.cloud.n; i += 101) {
    const { col, row } = gridIndex(a.cloud.xyz[i * 3], a.cloud.xyz[i * 3 + 1], patch.x0, patch.y0)
    assert.equal(a.g.cellOf[i], row * patch.cols + col)
  }
})

test('timing: back-projection + ground fit for one frame (logs only)', () => {
  const ground = tiltedPlane(5, 45)
  const pose = poseOn(ground, 0, 0, 10)
  const disp = addNoise(trueDisparity(intr, pose, { ground, boxes: [] }), 0.1, 8)
  const cloud = createPointCloud()
  const g = createGroundContext(cloud.capacity)
  const times: number[] = []
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now()
    backProject(disp, intr, pose, cloud)
    fitGround(g, cloud, pose)
    times.push(performance.now() - t0)
  }
  console.log(`  points + ground: ${cloud.n} points, median ${median(times.slice(1)).toFixed(1)} ms`)
})
