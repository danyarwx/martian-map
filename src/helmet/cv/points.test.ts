// T3.2: back-projection of disparity into local ENU. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pose } from '../contracts.ts'
import { backProject, cameraAxes, createPointCloud, MAX_POINTS, projectToImage } from './points.ts'
import {
  cameraBasis,
  cast,
  intrinsics,
  pixelRay,
  planeZ,
  rng,
  tiltedPlane,
  trueDisparity,
  type Scene,
} from './testScenes.ts'

const intr = intrinsics()

test('camera axes match an independent construction (right, down = −up, forward)', () => {
  for (const [h, p] of [[0, 0], [90, -15], [217, -30], [333, 10]]) {
    const pose: Pose = { x: 0, y: 0, z: 1.65, headingDeg: h, pitchDeg: p }
    const a = cameraAxes(pose)
    const b = cameraBasis(pose)
    const close = (u: number, v: number) => assert.ok(Math.abs(u - v) < 1e-12, `${h}/${p}: ${u} vs ${v}`)
    close(a.rx, b.r.x), close(a.ry, b.r.y), close(a.rz, b.r.z)
    close(a.dx, -b.u.x), close(a.dy, -b.u.y), close(a.dz, -b.u.z)
    close(a.fx, b.f.x), close(a.fy, b.f.y), close(a.fz, b.f.z)
  }
})

test('points from the true disparity of a 10° slope lie on it: within 5 cm at 5 m, also with ±0.05 px error', () => {
  const ground = tiltedPlane(10, 30)
  const pose: Pose = { x: 3, y: -2, z: planeZ(ground, 3, -2) + 1.65, headingDeg: 20, pitchDeg: -15 }
  const scene: Scene = { ground, boxes: [] }
  const exact = trueDisparity(intr, pose, scene)
  const r = rng(11)
  const noisy = exact.map((d) => d + (r() - 0.5) * 0.1)
  for (const [name, disp] of [['exact', exact], ['±0.05 px', noisy]] as const) {
    const cloud = createPointCloud(intr.width * intr.height)
    const n = backProject(disp, intr, pose, cloud)
    let worst = 0
    let near5 = 0
    for (let i = 0; i < n; i++) {
      const u = cloud.pix[i] % intr.width
      const v = Math.floor(cloud.pix[i] / intr.width)
      const hit = cast(scene, pose, pixelRay(intr, pose, u, v))!
      const x = cloud.xyz[i * 3], y = cloud.xyz[i * 3 + 1], z = cloud.xyz[i * 3 + 2]
      if (Math.abs(hit.t - 5) > 0.5) continue
      near5++
      worst = Math.max(worst, Math.hypot(x - hit.p.x, y - hit.p.y, z - hit.p.z))
    }
    console.log(`  ${name}: ${near5} points at 4.5–5.5 m, worst error ${(100 * worst).toFixed(2)} cm`)
    assert.ok(near5 > 500)
    assert.ok(worst < 0.05, `${name}: ${worst} m`)
  }
})

test('projectToImage inverts backProject', () => {
  const ground = tiltedPlane(0)
  const pose: Pose = { x: 0, y: 0, z: 1.65, headingDeg: 135, pitchDeg: -20 }
  const disp = trueDisparity(intr, pose, { ground, boxes: [] })
  const cloud = createPointCloud(2000)
  const n = backProject(disp, intr, pose, cloud)
  const axes = cameraAxes(pose)
  const out = new Float64Array(3)
  for (let i = 0; i < n; i += 37) {
    projectToImage(cloud.xyz[i * 3], cloud.xyz[i * 3 + 1], cloud.xyz[i * 3 + 2], intr, axes, pose, out)
    assert.ok(Math.abs(out[0] - (cloud.pix[i] % intr.width)) < 1e-2)
    assert.ok(Math.abs(out[1] - Math.floor(cloud.pix[i] / intr.width)) < 1e-2)
  }
})

test('subsampling keeps at most 15 k points, spread over the image, deterministically', () => {
  const pose: Pose = { x: 0, y: 0, z: 1.65, headingDeg: 0, pitchDeg: -25 }
  const disp = trueDisparity(intr, pose, { ground: tiltedPlane(0), boxes: [] })
  const a = createPointCloud()
  const b = createPointCloud()
  const n = backProject(disp, intr, pose, a)
  backProject(disp, intr, pose, b)
  assert.ok(n <= MAX_POINTS && n > MAX_POINTS * 0.6, `${n}`)
  assert.deepEqual(a.pix.subarray(0, n), b.pix.subarray(0, n))
  const lastRow = Math.floor(a.pix[n - 1] / intr.width)
  assert.ok(lastRow > intr.height - 5, 'points reach the bottom of the image')
})
