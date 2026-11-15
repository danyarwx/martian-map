// T3.4: steep slopes from ground points. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type Detection, type HazardPatch, type Pose } from '../contracts.ts'
import { MOBILITY } from '../../lib/mobility.ts'
import { createGroundContext, fitGround } from './ground.ts'
import { createObstacleContext, detectObstacles } from './obstacles.ts'
import { backProject, createPointCloud } from './points.ts'
import { createSlopeContext, detectSlopes, SLOPE_DEFAULTS } from './slope.ts'
import { computeDisparity, createStereoContext } from './stereo.ts'
import { intrinsics, makeTexture, median, planeZ, renderStereo, rng, tiltedPlane, trueDisparity, type Scene } from './testScenes.ts'

const intr = intrinsics()

function poseOn(scene: Scene, headingDeg: number, pitchDeg = -15): Pose {
  return { x: 1.1, y: -0.7, z: planeZ(scene.ground, 1.1, -0.7) + 1.65, headingDeg, pitchDeg }
}

function noisy(disp: Float32Array, sigma: number, seed: number): Float32Array {
  const r = rng(seed)
  return disp.map((d) => d + sigma * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()))
}

/** The whole per-frame chain after stereo, as the worker will run it. */
function pipeline(disp: Float32Array, pose: Pose) {
  const cloud = createPointCloud()
  backProject(disp, intr, pose, cloud)
  const g = createGroundContext(cloud.capacity)
  fitGround(g, cloud, pose)
  const rocks = detectObstacles(createObstacleContext(g), g, cloud, intr, pose, disp)
  const s = createSlopeContext(g)
  const slopes = detectSlopes(s, g, cloud, pose)
  const measured = Array.from(s.slope).filter(Number.isFinite)
  return { rocks, slopes, patch: g.patch, measured }
}

const count = (p: HazardPatch, cls: number) => p.cls.reduce((n, c) => n + (c === cls ? 1 : 0), 0)

function describe(name: string, r: { slopes: Detection[]; patch: HazardPatch; measured: number[] }): string {
  return (
    `  ${name}: ${r.measured.length} blocks, median slope ${median(r.measured).toFixed(2)}°, ` +
    `${count(r.patch, HAZARD.steep)} steep cells, detections ` +
    JSON.stringify(r.slopes.map((d) => ({ slope: +d.slopeDeg!.toFixed(1), conf: +d.confidence.toFixed(2), dist: +d.distanceM.toFixed(1) })))
  )
}

test('the no-go limit is the planner walking limit (20°), warnings from 15°', () => {
  assert.equal(SLOPE_DEFAULTS.maxDeg, MOBILITY.walk.maxSlopeDeg)
  assert.equal(SLOPE_DEFAULTS.maxDeg, 20)
  assert.equal(SLOPE_DEFAULTS.warnDeg, 15)
})

for (const sigma of [0, 0.1]) {
  const label = sigma ? `, ${sigma} px disparity noise` : ''

  test(`12° slope${label}: no steep cells, no warning`, () => {
    const scene: Scene = { ground: tiltedPlane(12, 0), boxes: [] }
    const pose = poseOn(scene, 0)
    const r = pipeline(noisy(trueDisparity(intr, pose, scene), sigma, 1), pose)
    console.log(describe(`12°${label}`, r))
    assert.ok(Math.abs(median(r.measured) - 12) < 1)
    assert.equal(count(r.patch, HAZARD.steep), 0)
    assert.deepEqual(r.slopes, [])
    assert.deepEqual(r.rocks, [])
  })

  test(`17° slope${label}: warning only, cells not steep`, () => {
    const scene: Scene = { ground: tiltedPlane(17, 40), boxes: [] }
    const pose = poseOn(scene, 10)
    const r = pipeline(noisy(trueDisparity(intr, pose, scene), sigma, 2), pose)
    console.log(describe(`17°${label}`, r))
    assert.equal(count(r.patch, HAZARD.steep), 0)
    assert.ok(r.slopes.length >= 1, 'a warning')
    const main = r.slopes.reduce((a, b) => (b.radiusM > a.radiusM ? b : a))
    assert.equal(main.kind, 'steep')
    assert.ok(Math.abs(main.slopeDeg! - 17) < 1, `slope ${main.slopeDeg}`)
    assert.ok(main.confidence <= 0.5, 'warnings carry a lower confidence')
    for (const d of r.slopes) assert.ok(d.slopeDeg! <= 20, `no no-go group: ${d.slopeDeg}`)
    assert.ok(main.distanceM < 4, `nearest steep ground is close: ${main.distanceM}`)
  })

  test(`25° slope${label}: steep cells and a no-go detection`, () => {
    const scene: Scene = { ground: tiltedPlane(25, 300), boxes: [] }
    const pose = poseOn(scene, 280)
    const r = pipeline(noisy(trueDisparity(intr, pose, scene), sigma, 3), pose)
    console.log(describe(`25°${label}`, r))
    assert.ok(count(r.patch, HAZARD.steep) > 100, `${count(r.patch, HAZARD.steep)} steep cells`)
    const main = r.slopes.reduce((a, b) => (b.radiusM > a.radiusM ? b : a))
    assert.ok(Math.abs(main.slopeDeg! - 25) < 1, `slope ${main.slopeDeg}`)
    assert.ok(main.confidence > 0.6)
    assert.deepEqual(r.rocks, [], 'a slope is not a rock')
  })
}

test('a rock on steep ground stays a rock cell', () => {
  const ground = tiltedPlane(25, 0)
  const zAt = planeZ(ground, 0.3, 6)
  const scene: Scene = { ground, boxes: [{ min: { x: 0, y: 5.7, z: zAt - 0.3 }, max: { x: 0.6, y: 6.3, z: zAt + 0.9 } }] }
  const pose = poseOn(scene, 0, 5) // looking up the slope
  const r = pipeline(trueDisparity(intr, pose, scene), pose)
  assert.ok(r.rocks.length === 1, JSON.stringify(r.rocks))
  assert.ok(count(r.patch, HAZARD.rock) >= 2)
  assert.ok(count(r.patch, HAZARD.steep) > 100)
})

test('end to end: rendered 17° and 25° slopes through stereo', () => {
  const stereo = createStereoContext(intr)
  for (const [deg, steep] of [[17, false], [25, true]] as const) {
    const scene: Scene = { ground: tiltedPlane(deg, 0), boxes: [] }
    const pose = poseOn(scene, 0)
    const { left, right } = renderStereo(intr, pose, scene, makeTexture(256, 256, 30 + deg))
    const r = pipeline(computeDisparity(stereo, left, right), pose)
    console.log(describe(`stereo ${deg}°`, r))
    assert.ok(Math.abs(median(r.measured) - deg) < 1, `median ${median(r.measured)}`)
    assert.equal(count(r.patch, HAZARD.steep) > 50, steep)
    assert.ok(r.slopes.some((d) => Math.abs(d.slopeDeg! - deg) < 1.5))
  }
})

test('timing: stereo + points + ground + obstacles + slope for one frame (logs only)', () => {
  const scene: Scene = { ground: tiltedPlane(8, 0), boxes: [{ min: { x: 0, y: 5, z: 0 }, max: { x: 0.6, y: 5.6, z: 1.3 } }] }
  const pose = poseOn(scene, 0)
  const { left, right } = renderStereo(intr, pose, scene, makeTexture(256, 256, 40))
  const stereo = createStereoContext(intr)
  const cloud = createPointCloud()
  const g = createGroundContext(cloud.capacity)
  const o = createObstacleContext(g)
  const s = createSlopeContext(g)
  const t: number[][] = []
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now()
    const disp = computeDisparity(stereo, left, right)
    const t1 = performance.now()
    backProject(disp, intr, pose, cloud)
    fitGround(g, cloud, pose)
    detectObstacles(o, g, cloud, intr, pose, disp)
    detectSlopes(s, g, cloud, pose)
    t.push([t1 - t0, performance.now() - t1])
  }
  const st = median(t.slice(1).map((x) => x[0]))
  const rest = median(t.slice(1).map((x) => x[1]))
  console.log(`  frame: stereo ${st.toFixed(1)} ms + points/ground/obstacles/slope ${rest.toFixed(1)} ms = ${(st + rest).toFixed(1)} ms`)
  if (st + rest > 60) console.warn(`  WARNING: the CV frame takes ${(st + rest).toFixed(1)} ms, over 60 ms`)
})
