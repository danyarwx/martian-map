import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cameraAxes } from '../cv/points.ts'
import { CV_BASELINE_M, cvIntrinsics, eyePoses } from './cvRig.ts'

test('CV camera intrinsics: 70° across 256 px, principal point at the centre of the pixel grid', () => {
  const i = cvIntrinsics()
  assert.equal(i.width, 256)
  assert.equal(i.height, 192)
  assert.ok(Math.abs(2 * Math.atan(128 / i.fx) * (180 / Math.PI) - 70) < 1e-9)
  assert.equal(i.fx, i.fy)
  assert.equal(i.cx, 127.5)
  assert.equal(i.cy, 95.5)
  assert.equal(i.baselineM, 0.3)
})

test('the two eyes sit one baseline apart along the camera\'s right axis, the left one on the left', () => {
  for (const headingDeg of [0, 37, 180, 270]) {
    const head = { x: 10, y: -4, z: 3, headingDeg, pitchDeg: -12 }
    const { left, right } = eyePoses(head)
    const a = cameraAxes(left)
    const dx = right.x - left.x
    const dy = right.y - left.y
    assert.ok(Math.abs(dx * a.rx + dy * a.ry - CV_BASELINE_M) < 1e-9)
    assert.ok(Math.abs(Math.hypot(dx, dy) - CV_BASELINE_M) < 1e-9)
    assert.equal(left.z, head.z)
    assert.equal(left.pitchDeg, head.pitchDeg)
    assert.ok(Math.abs((left.x + right.x) / 2 - head.x) < 1e-12)
  }
})
