// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toLatLon } from '../frames.ts'
import { buildTrack, buildTrackLocal, locate, pointAhead, pointAt, remainingM } from './follow.ts'

const ORIGIN = { lat: 18.45886, lon: 77.4061 }
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`)

/** 30 m north, then 20 m east: an L with its corner at (0, 30). */
const L = [
  { x: 0, y: 0 },
  { x: 0, y: 10 },
  { x: 0, y: 20 },
  { x: 0, y: 30 },
  { x: 10, y: 30 },
  { x: 20, y: 30 },
]

test('a route is resampled to one point per metre, keeping its start, end and length', () => {
  const t = buildTrackLocal(L)
  assert.equal(t.n, 51)
  near(t.lengthM, 50)
  assert.deepEqual([t.x[0], t.y[0]], [0, 0])
  assert.deepEqual([t.x[50], t.y[50]], [20, 30])
  for (let k = 1; k < t.n; k++) {
    near(Math.hypot(t.x[k] - t.x[k - 1], t.y[k] - t.y[k - 1]), 1)
    near(t.s[k], k)
  }
  // the corner is a sample
  near(t.x[30], 0)
  near(t.y[30], 30)
})

test('a length that is not a whole number of steps ends with a shorter last step', () => {
  const t = buildTrackLocal([{ x: 0, y: 0 }, { x: 0, y: 10.4 }])
  assert.equal(t.n, 12)
  near(t.lengthM, 10.4)
  near(t.s[10], 10)
  near(t.s[11], 10.4)
  near(t.y[11], 10.4)
  // repeated points and a single point do not break it
  assert.equal(buildTrackLocal([{ x: 1, y: 1 }, { x: 1, y: 1 }]).n, 1)
  const one = buildTrackLocal([{ x: 3, y: 4 }])
  assert.equal(one.lengthM, 0)
  assert.equal(locate(one, 3, 9).distM, 5)
})

test('a LatLon path lands in local metres around the origin', () => {
  const path = [toLatLon(0, 0, ORIGIN), toLatLon(0, 10, ORIGIN), toLatLon(10, 20, ORIGIN)]
  const t = buildTrack(path, ORIGIN)
  near(t.lengthM, 10 + Math.hypot(10, 10), 1e-6)
  near(t.x[t.n - 1], 10, 1e-6)
  near(t.y[t.n - 1], 20, 1e-6)
})

test('pointAt and pointAhead interpolate along the track and clamp to its ends', () => {
  const t = buildTrackLocal(L)
  const p = pointAt(t, 12.5)
  near(p.x, 0)
  near(p.y, 12.5)
  near(p.headingDeg, 0)
  const q = pointAhead(t, 12.5, 30) // 17.5 m to the corner, then 12.5 m east
  near(q.x, 12.5)
  near(q.y, 30)
  near(q.headingDeg, 90)
  near(q.s, 42.5)
  const end = pointAhead(t, 40, 30)
  near(end.x, 20)
  near(end.s, 50)
  near(end.headingDeg, 90)
  near(pointAt(t, -5).s, 0)
})

test('locate gives the nearest route point, arc length and signed side', () => {
  const t = buildTrackLocal(L)
  const right = locate(t, 2, 12.3) // heading north, 2 m to the east = right
  near(right.s, 12.3)
  near(right.x, 0)
  near(right.y, 12.3)
  near(right.distM, 2)
  near(right.lateralM, 2)
  near(right.headingDeg, 0)
  const left = locate(t, -3, 5)
  near(left.lateralM, -3)
  // on the east-going part, north of the route is its left
  const north = locate(t, 14.2, 31)
  near(north.s, 44.2)
  near(north.lateralM, -1)
  near(north.headingDeg, 90)
  // beyond the end: clamped to the end point
  const past = locate(t, 25, 30)
  near(past.s, 50)
  near(past.distM, 5)
})

test('remaining distance to the stop', () => {
  const t = buildTrackLocal(L)
  near(remainingM(t, locate(t, 0.5, 12).s), 38)
  near(remainingM(t, 0), 50)
  near(remainingM(t, 50), 0)
  near(remainingM(t, 80), 0)
})

test('a hint keeps the fix on the part of the route being walked; a jump searches everywhere', () => {
  // Out 40 m north, 2 m east, back 40 m south: the two long parts run 2 m apart.
  const hairpin = buildTrackLocal([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 2, y: 40 }, { x: 2, y: 0 }])
  // At (1.2, 10) the return part is nearer, but the walker is on the way out.
  assert.ok(locate(hairpin, 1.2, 10).s > 60)
  const out = locate(hairpin, 1.2, 10, 9.5)
  near(out.s, 10)
  near(out.lateralM, 1.2)
  // A hint far from where the walker is: falls back to the whole track.
  const t = buildTrackLocal([{ x: 0, y: 0 }, { x: 0, y: 500 }])
  near(locate(t, 1, 400, 20).s, 400)
})
