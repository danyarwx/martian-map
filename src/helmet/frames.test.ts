// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { distanceM } from '../lib/geo.ts'
import {
  dirToHeading,
  gridCellCenter,
  gridIndex,
  headingToDir,
  localToThree,
  threeToLocal,
  toLatLon,
  toLocal,
} from './frames.ts'

const ORIGIN = { lat: 18.45886, lon: 77.4061 } // delta front

test('local ↔ lat/lon round trip stays within 1 mm over 2 km', () => {
  for (const [x, y] of [[0, 0], [2000, 0], [0, -2000], [-1414, 1414], [1234.5, 987.6]]) {
    const p = toLatLon(x, y, ORIGIN)
    const back = toLocal(p, ORIGIN)
    assert.ok(Math.abs(back.x - x) < 1e-3 && Math.abs(back.y - y) < 1e-3, `${x},${y} → ${back.x},${back.y}`)
  }
})

test('local distances agree with the great-circle distance', () => {
  const p = toLatLon(1500, -800, ORIGIN)
  assert.ok(Math.abs(distanceM(ORIGIN, p) - Math.hypot(1500, 800)) < 0.5)
})

test('axes: east is +x, north is +y, and north is −z in three.js', () => {
  const east = toLocal({ lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001 }, ORIGIN)
  const north = toLocal({ lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon }, ORIGIN)
  assert.ok(east.x > 0 && Math.abs(east.y) < 1e-9)
  assert.ok(north.y > 0 && Math.abs(north.x) < 1e-9)
  const t = localToThree({ x: 0, y: 10, z: 2 })
  assert.deepEqual(t, { x: 0, y: 2, z: -10 })
  assert.deepEqual(threeToLocal(t), { x: 0, y: 10, z: 2 })
})

test('heading directions', () => {
  const n = headingToDir(0)
  const e = headingToDir(90)
  assert.ok(Math.abs(n.y - 1) < 1e-12 && Math.abs(n.x) < 1e-12)
  assert.ok(Math.abs(e.x - 1) < 1e-12 && Math.abs(e.y) < 1e-12)
  assert.ok(Math.abs(headingToDir(0, 90).z - 1) < 1e-12)
  assert.ok(Math.abs(dirToHeading(1, 0) - 90) < 1e-9)
  assert.ok(Math.abs(dirToHeading(0, -1) - 180) < 1e-9)
  assert.ok(Math.abs(dirToHeading(-1, 0) - 270) < 1e-9)
})

test('hazard grid cells: row 0 is north, centres round-trip', () => {
  assert.deepEqual(gridIndex(0.1, -0.1, 0, 0), { col: 0, row: 0 })
  assert.deepEqual(gridIndex(1.2, -2.6, 0, 0), { col: 2, row: 5 })
  const c = gridCellCenter(2, 5, 0, 0)
  assert.deepEqual(c, { x: 1.25, y: -2.75 })
  assert.deepEqual(gridIndex(c.x, c.y, 0, 0), { col: 2, row: 5 })
})
