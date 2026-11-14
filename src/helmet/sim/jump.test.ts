import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARS_RADIUS_M } from '../../lib/geo.ts'
import type { RoutePlan } from '../../types.ts'
import { toLocal } from '../frames.ts'
import { routeLegFromFile, standInPlan } from './defaultEntry.ts'
import { jumpTargets, routeLengths, routePoint } from './jump.ts'

const DEG_M = (MARS_RADIUS_M * Math.PI) / 180
const A = { lat: 18.44, lon: 77.45 }

/** habitat → 1000 m north → a, then a → 500 m east → b. */
function plan(): RoutePlan {
  const north: [number, number][] = []
  for (let m = 0; m <= 1000; m += 10) north.push([A.lat + m / DEG_M, A.lon])
  const top = north[north.length - 1]
  const east: [number, number][] = []
  for (let m = 0; m <= 500; m += 10) east.push([top[0], top[1] + m / (DEG_M * Math.cos((top[0] * Math.PI) / 180))])
  return standInPlan([
    routeLegFromFile({ id: 'habitat>a', fromId: 'habitat', toId: 'a', path: north, distanceM: 1000 }),
    routeLegFromFile({ id: 'a>b', fromId: 'a', toId: 'b', path: east, distanceM: 500 }),
  ])
}

test('route lengths add up', () => {
  const l = routeLengths(plan())
  assert.ok(Math.abs(l.legs[0] - 1000) < 0.5 && Math.abs(l.legs[1] - 500) < 0.5)
  assert.ok(Math.abs(l.total - 1500) < 1)
})

test('fixed jump points: the start and 300 m before every stop, facing along the route', () => {
  const t = jumpTargets(plan(), (id) => id.toUpperCase())
  assert.deepEqual(
    t.map((j) => j.id),
    ['start', 'approach-0', 'approach-1'],
  )
  assert.equal(t[0].label, 'Start: HABITAT')
  assert.equal(t[1].label, '300 m before A')
  const p1 = toLocal(t[1].at, A)
  assert.ok(Math.abs(p1.y - 700) < 0.5 && Math.abs(p1.x) < 0.01)
  assert.ok(Math.abs(t[1].headingDeg) < 0.01 && t[1].legIndex === 0)
  const p2 = toLocal(t[2].at, A)
  assert.ok(Math.abs(p2.x - 200) < 0.5 && Math.abs(p2.y - 1000) < 0.5)
  assert.ok(Math.abs(t[2].headingDeg - 90) < 0.5 && t[2].legIndex === 1)
  assert.ok(Math.abs(t[2].routeM - 1200) < 1)
})

test('a point on the route by distance crosses legs and clamps', () => {
  const p = plan()
  const mid = routePoint(p, 1250)
  assert.equal(mid.legIndex, 1)
  assert.ok(Math.abs(toLocal(mid.at, A).x - 250) < 0.5)
  assert.equal(routePoint(p, -5).routeM, 0)
  assert.ok(Math.abs(routePoint(p, 99999).routeM - 1500) < 1)
  assert.equal(routePoint(p, 99999).legIndex, 1)
})
