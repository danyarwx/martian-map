import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slopeSpeedFactor } from '../../lib/mobility.ts'
import type { Pose } from '../contracts.ts'
import { EYE_M, WALK_MPS, stepPlayer, type Ground, type RockLike } from './player.ts'

const RAD = Math.PI / 180

function ground(height: (x: number, y: number) => number, rocks: RockLike[] = []): Ground {
  return {
    heightAt: height,
    slopeAt: (x, y) => {
      const gx = (height(x + 1, y) - height(x - 1, y)) / 2
      const gy = (height(x, y + 1) - height(x, y - 1)) / 2
      return Math.atan(Math.hypot(gx, gy)) / RAD
    },
    rocksNear: (x, y, r) => rocks.filter((k) => Math.hypot(k.x - x, k.y - y) <= r + k.d / 2),
  }
}

const start = (headingDeg = 0): Pose => ({ x: 0, y: 0, z: 0, headingDeg, pitchDeg: 0 })
const walk = (pose: Pose, g: Ground, seconds: number, inp = { fwd: 1, side: 0, fast: false }) => {
  let last = stepPlayer(pose, inp, 0, g)
  for (let t = 0; t < seconds * 20; t++) last = stepPlayer(pose, inp, 0.05, g)
  return last
}

test('walks at WALK_MPS north on the level, four times that with Shift, eye 1.65 m above the ground', () => {
  const g = ground(() => 100)
  const p = start()
  walk(p, g, 10)
  assert.ok(Math.abs(p.y - 10 * WALK_MPS) < 1e-6 && Math.abs(p.x) < 1e-9)
  assert.equal(p.z, 100 + EYE_M)
  const q = start(90)
  walk(q, g, 10, { fwd: 1, side: 0, fast: true })
  assert.ok(Math.abs(q.x - 40 * WALK_MPS) < 1e-6)
})

test('slows down on a slope like the planner does', () => {
  const g = ground((_x, y) => y * Math.tan(10 * RAD))
  const p = start()
  walk(p, g, 10)
  assert.ok(Math.abs(p.y - 10 * WALK_MPS * slopeSpeedFactor(10)) < 0.1)
})

test('cannot climb ground steeper than 25°, but can walk down it and along its foot', () => {
  // level until y = 5, then a 35° ramp up
  const g = ground((_x, y) => Math.max(0, y - 5) * Math.tan(35 * RAD))
  const p = start()
  const res = walk(p, g, 30)
  assert.ok(p.y < 5.5, `stopped at y = ${p.y.toFixed(2)}`)
  assert.equal(res.blocked, 'slope')
  // diagonal input slides along the foot of the ramp
  const q = start(45)
  walk(q, g, 30)
  assert.ok(q.y < 5.5 && q.x > 4, `slid to x = ${q.x.toFixed(1)}`) // slow: the foot of the ramp already counts as a slope
  // from the top, walking down is allowed
  const d: Pose = { x: 0, y: 12, z: 0, headingDeg: 180, pitchDeg: 0 }
  walk(d, g, 60)
  assert.ok(d.y < 4)
})

test('stops at a rock taller than a step, slides round it, and steps over a small one', () => {
  const big: RockLike = { x: 0, y: 5, d: 1, h: 0.8 } // stands 0.56 m
  const p = start()
  const res = walk(p, ground(() => 0, [big]), 10)
  assert.equal(res.blocked, 'rock')
  assert.ok(p.y < 5 - 0.5 * 0.85 - 0.3 + 0.06, `stopped at y = ${p.y.toFixed(2)}`)
  // heading slightly east of north: slides past the rock and carries on
  const q = start(15)
  walk(q, ground(() => 0, [big]), 14)
  assert.ok(q.y > 7, `got to y = ${q.y.toFixed(2)}`)
  assert.ok(Math.hypot(q.x - big.x, q.y - big.y) > 0.7)
  // a 0.25 m high rock (stands 0.175 m) is stepped over
  const s = start()
  walk(s, ground(() => 0, [{ x: 0, y: 5, d: 0.4, h: 0.25 }]), 10)
  assert.ok(Math.abs(s.y - 10 * WALK_MPS) < 1e-6)
})

test('a player dropped inside a rock (after a jump) can walk out', () => {
  const p: Pose = { x: 0.1, y: 5, z: 0, headingDeg: 90, pitchDeg: 0 }
  walk(p, ground(() => 0, [{ x: 0, y: 5, d: 1.2, h: 1 }]), 5)
  assert.ok(p.x > 3)
})

test('walking nearly head-on into a wide rock: reports the rock and slides round its edge at walking speed', () => {
  const wide: RockLike = { x: 0, y: 5, d: 2, h: 1 }
  const g = ground(() => 0, [wide])
  const p = start(5) // 5° east of north: the step barely has a part along the rock's edge
  let first: ReturnType<typeof stepPlayer> | null = null
  for (let t = 0; t < 3 * 20; t++) {
    const res = stepPlayer(p, { fwd: 1, side: 0, fast: false }, 0.05, g)
    if (res.hit && !first) first = res
  }
  assert.equal(first?.hit, wide)
  assert.equal(first?.blocked, 'rock')
  // 3 s at 4 m/s: round the 2 m rock and on, not creeping along it a few centimetres per step
  assert.ok(p.y > 6.5, `got to y = ${p.y.toFixed(2)}`)
  assert.ok(Math.hypot(p.x - wide.x, p.y - wide.y) > 1.0)
})
