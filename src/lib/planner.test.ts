// Run with `npm test` (Node 24 runs TypeScript directly).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Target, Terrain } from '../types.ts'
import { distanceM, parsePoint } from './geo.ts'
import { MOBILITY, secondsPerMetre } from './mobility.ts'
import { planRoute, planRoutes } from './planner.ts'

const W = 60
const H = 40

/** 60 x 40 grid of 10 m cells, flat unless `slopeAt` says otherwise. Row 0 is north. */
function terrain(slopeAt: (col: number, row: number) => number = () => 0): Terrain {
  const slope = new Uint8Array(W * H)
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) slope[r * W + c] = slopeAt(c, r) * 2
  return {
    source: 'test',
    west: 0, east: W, south: 0, north: H, // one degree per cell keeps the test coordinates readable
    width: W, height: H,
    cellMetersX: 10, cellMetersY: 10,
    slope,
    elev: new Int16Array(W * H),
  }
}

/** A stop at the centre of grid cell (col, row). */
function stop(id: string, col: number, row: number): Target {
  return { id, name: id, summary: '', science: '', task: '', lon: col + 0.5, lat: H - row - 0.5 }
}

const habitat = stop('habitat', 5, 20)

test('one degree of latitude on Mars is about 59.2 km', () => {
  const d = distanceM({ lat: 18, lon: 77 }, { lat: 19, lon: 77 })
  assert.ok(Math.abs(d - 59158) < 5, `${d}`)
})

test('steeper ground is slower, and ground past the limit is no-go', () => {
  const walk = MOBILITY.walk
  assert.ok(secondsPerMetre(walk, 10) > secondsPerMetre(walk, 0))
  assert.equal(secondsPerMetre(walk, walk.maxSlopeDeg + 0.5), Infinity)
})

test('flat ground: straight out and back', () => {
  const plan = planRoute(terrain(), MOBILITY.walk, habitat, [stop('a', 45, 20)])
  assert.deepEqual(plan.order, ['habitat', 'a', 'habitat'])
  assert.equal(plan.distanceM, 800)
  // 800 m at 2.5 km/h is 19.2 min, plus one 30 min stop
  assert.ok(Math.abs(plan.totalMinutes - 49.2) < 0.01, `${plan.totalMinutes}`)
  assert.equal(plan.fitsOneEva, true)
})

test('route goes around a steep wall through the only gap', () => {
  // 30 degree wall across column 25, open only at rows 2-3
  const t = terrain((c, r) => (c === 25 && r > 3 ? 30 : c === 25 && r < 2 ? 30 : 0))
  const plan = planRoute(t, MOBILITY.walk, habitat, [stop('a', 45, 20)])
  assert.deepEqual(plan.unreachable, [])
  assert.ok(plan.distanceM > 800, 'detour is longer than the straight line')
  assert.ok(plan.maxSlopeDeg <= MOBILITY.walk.maxSlopeDeg)
  const crossing = plan.legs[0].path.filter((p) => Math.floor(p.lon) === 25)
  assert.ok(crossing.length > 0 && crossing.every((p) => H - p.lat < 4), 'crosses the wall inside the gap')
})

test('a target behind a closed wall is reported, not visited', () => {
  const t = terrain((c) => (c === 25 ? 30 : 0))
  const plan = planRoute(t, MOBILITY.walk, habitat, [stop('near', 15, 20), stop('far', 45, 20)])
  assert.deepEqual(plan.unreachable, ['far'])
  assert.deepEqual(plan.unreachableWhy, { far: 'no-path' })
  assert.equal(plan.habitatNoFooting, false)
  assert.deepEqual(plan.order, ['habitat', 'near', 'habitat'])
})

test('visiting order is the shortest round trip, not the order given', () => {
  const targets = [stop('far', 50, 20), stop('near', 15, 20), stop('mid', 30, 20)]
  const plan = planRoute(terrain(), MOBILITY.walk, habitat, targets)
  assert.equal(plan.distanceM, 900) // out to the far one and back, passing the others
  assert.equal(plan.stopMinutes, 90)
})

test('a slope the walker accepts can stop the rover', () => {
  const t = terrain((c) => (c === 25 ? 18 : 0))
  const target = [stop('a', 45, 20)]
  assert.deepEqual(planRoute(t, MOBILITY.walk, habitat, target).unreachable, [])
  assert.deepEqual(planRoute(t, MOBILITY.rover, habitat, target).unreachable, ['a'])
})

test('flat ground needs no explanation and is one easy section', () => {
  const leg = planRoute(terrain(), MOBILITY.walk, habitat, [stop('a', 45, 20)]).legs[0]
  assert.deepEqual(leg.notes, [])
  assert.equal(leg.sections.length, 1)
  assert.equal(leg.sections[0].level, 0)
  assert.equal(leg.sections[0].path.length, leg.path.length)
})

test('a detour around a wall says how steep the wall is and what the limit is', () => {
  const t = terrain((c, r) => (c === 25 && r > 3 ? 30 : c === 25 && r < 2 ? 30 : 0))
  const leg = planRoute(t, MOBILITY.walk, habitat, [stop('a', 45, 20)]).legs[0]
  assert.equal(leg.notes.length, 1)
  assert.equal(leg.notes[0].kind, 'no-go')
  const note = leg.notes[0]
  assert.match(note.text, /^Turns here: 30° slope \d+0 m away on the direct line \(limit 20°\)\.$/)
  assert.equal(Math.floor(note.obstacle!.lon), 25, 'the obstacle is on the wall')
  const turnCell = Math.floor(H - note.at.lat) * W + Math.floor(note.at.lon)
  assert.ok(t.slope[turnCell] / 2 <= MOBILITY.walk.maxSlopeDeg, 'the turn itself is on passable ground')
})

test('a detour around passable but slow ground says how much time it saves', () => {
  // 12 degree band, 260 m wide, lying across the straight line; going round it is about 3 min faster
  const t = terrain((c, r) => (c >= 15 && c <= 40 && r >= 12 && r <= 28 ? 12 : 0))
  const leg = planRoute(t, MOBILITY.walk, habitat, [stop('a', 50, 20)]).legs[0]
  assert.equal(leg.notes.length, 1)
  assert.equal(leg.notes[0].kind, 'slow')
  assert.match(leg.notes[0].text, /^Turns here: up to 12° on the direct line\. This way saves [1-9] min\.$/)
})

test('two obstacles on one leg get a note each, next to the obstacle', () => {
  // 30 degree wall at column 18 open to the south, 35 degree wall at column 42 open to the north
  const t = terrain((c, r) => (c === 18 && r < 25 ? 30 : c === 42 && r > 15 ? 35 : 0))
  const leg = planRoute(t, MOBILITY.walk, habitat, [stop('a', 55, 20)]).legs[0]
  assert.equal(leg.notes.length, 2)
  assert.match(leg.notes[0].text, /^Turns here: 30° slope /)
  assert.match(leg.notes[1].text, /^Turns here: 35° slope /)
  assert.ok(Math.abs(leg.notes[0].at.lon - 18.5) < 3, `${leg.notes[0].at.lon}`)
  assert.ok(Math.abs(leg.notes[1].at.lon - 42.5) < 3, `${leg.notes[1].at.lon}`)
})

test('a steep stretch the route has to cross is called out', () => {
  // 16 degree band across the whole grid, 40 m wide: passable on foot, but in the top slope class
  const t = terrain((c) => (c >= 25 && c <= 28 ? 16 : 0))
  const leg = planRoute(t, MOBILITY.walk, habitat, [stop('a', 45, 20)]).legs[0]
  assert.deepEqual(leg.notes.map((n) => n.kind), ['steep'])
  assert.equal(leg.notes[0].text, 'Steep stretch: up to 16° for 40 m. Slow down.')
  assert.deepEqual(leg.sections.map((s) => s.level), [0, 2, 0])
})

test('a target on a no-go cell is reached at the nearest passable ground', () => {
  // 30 m wide block of 30 degree ground: the target in its middle is 20 m from ground that can be walked on
  const t = terrain((c, r) => (c >= 44 && c <= 46 && r >= 19 && r <= 21 ? 30 : 0))
  const plan = planRoute(t, MOBILITY.walk, habitat, [stop('a', 45, 20)])
  assert.deepEqual(plan.unreachable, [])
  assert.deepEqual(plan.order, ['habitat', 'a', 'habitat'])
})

test('a target deep inside no-go ground has nowhere to stand', () => {
  // 210 m wide block: nothing passable within 50 m of its centre
  const t = terrain((c, r) => (c >= 35 && c <= 55 && r >= 10 && r <= 30 ? 30 : 0))
  const plan = planRoute(t, MOBILITY.walk, habitat, [stop('a', 45, 20)])
  assert.deepEqual(plan.unreachableWhy, { a: 'no-footing' })
})

test('typed coordinates are accepted only as numbers inside the elevation data', () => {
  const b = { west: 77.2229, east: 77.48, south: 18.400009, north: 18.52001 }
  assert.deepEqual(parsePoint(b, '18.45', ' 77.4 '), { ok: true, point: { lat: 18.45, lon: 77.4 } })
  assert.deepEqual(parsePoint(b, '18.6', '77.4'), { ok: false, error: 'Latitude must be between 18.401 and 18.520.' })
  assert.deepEqual(parsePoint(b, '18.45', 'east'), { ok: false, error: 'Longitude must be a number.' })
  assert.deepEqual(parsePoint(b, '', '77.4'), { ok: false, error: 'Latitude must be a number.' })
})

/** A 16 degree band, 30 m wide, across the grid except for a flat gap at its northern end. */
const steepBand = () => terrain((c, r) => (c >= 25 && c <= 27 && r >= 5 ? 16 : 0))

test('the fastest route crosses a short steep band, the gentlest goes around and reports real time', () => {
  const { fast, gentle, gentleIsSame } = planRoutes(steepBand(), MOBILITY.walk, habitat, [stop('a', 45, 20)])
  assert.equal(fast.maxSlopeDeg, 16)
  assert.equal(gentle.maxSlopeDeg, 0)
  assert.equal(gentle.steepM, 0)
  assert.ok(fast.steepM >= 30, `${fast.steepM}`)
  assert.ok(gentle.travelMinutes > fast.travelMinutes)
  // all of the gentle route is level ground, so its time is simply distance at 2.5 km/h
  assert.ok(Math.abs(gentle.travelMinutes - (gentle.distanceM / 2500) * 60) < 0.01, `${gentle.travelMinutes}`)
  assert.equal(gentleIsSame, false)
})

test('on flat ground there is no gentler route to offer', () => {
  assert.equal(planRoutes(terrain(), MOBILITY.walk, habitat, [stop('a', 45, 20)]).gentleIsSame, true)
})

test('the gentlest route explains a detour by the slope it stays under', () => {
  const leg = planRoute(steepBand(), MOBILITY.walk, habitat, [stop('a', 45, 20)], 'gentle').legs[0]
  assert.deepEqual(
    leg.notes.map((n) => n.text),
    ['Turns here: up to 16° on the direct line. This way stays under 1°.'],
  )
})
