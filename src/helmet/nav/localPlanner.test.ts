// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type HazardClass } from '../contracts.ts'
import { HazardGrid } from '../mapping/hazardGrid.ts'
import { buildTrackLocal } from './follow.ts'
import { LocalPlanner, type LocalPlan } from './localPlanner.ts'

/** A rectangle of hazard in local metres: x in [x0, x1), y in (y0, y1]. */
interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
  cls: HazardClass
}

/** A hazard grid seen as safe over x −40..40, y −20..80, with the boxes painted on top. */
function world(boxes: Box[], base: HazardClass = HAZARD.safe): HazardGrid {
  const X0 = -40
  const Y0 = 80
  const cols = 160
  const rows = 200
  const cls = new Uint8Array(cols * rows).fill(base)
  for (const b of boxes) {
    for (let r = 0; r < rows; r++) {
      const y = Y0 - (r + 0.5) * 0.5
      if (y <= b.y0 || y > b.y1) continue
      for (let c = 0; c < cols; c++) {
        const x = X0 + (c + 0.5) * 0.5
        if (x >= b.x0 && x < b.x1) cls[r * cols + c] = b.cls
      }
    }
  }
  const g = new HazardGrid()
  g.update({ x0: X0, y0: Y0, cols, rows, cls, conf: new Float32Array(cols * rows).fill(0.9) }, 1)
  return g
}

/** The route: 100 m straight north from the origin. */
const NORTH = buildTrackLocal([{ x: 0, y: 0 }, { x: 0, y: 100 }])

/** Classes under the path, sampled every 10 cm. */
function classesUnder(g: HazardGrid, plan: LocalPlan): Set<HazardClass> {
  const seen = new Set<HazardClass>()
  for (let k = 1; k < plan.path.length; k++) {
    const a = plan.path[k - 1]
    const b = plan.path[k]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1))
    for (let j = 0; j <= n; j++) seen.add(g.classAt(a.x + ((b.x - a.x) * j) / n, a.y + ((b.y - a.y) * j) / n))
  }
  return seen
}

function lengthOf(plan: LocalPlan): number {
  let d = 0
  for (let k = 1; k < plan.path.length; k++) d += Math.hypot(plan.path[k].x - plan.path[k - 1].x, plan.path[k].y - plan.path[k - 1].y)
  return d
}

test('on clear ground the guide is the straight route to the point 30 m ahead', () => {
  const p = new LocalPlanner().plan(world([]), NORTH, 0.2, 5)
  assert.equal(p.blocked, false)
  assert.equal(p.hazardAheadM, null)
  assert.deepEqual(p.path[0], { x: 0.2, y: 5 })
  assert.deepEqual(p.goal, { x: 0, y: 35 })
  assert.deepEqual(p.path[p.path.length - 1], { x: 0, y: 35 })
  assert.ok(lengthOf(p) < 30.2, `length ${lengthOf(p)}`)
  assert.ok(p.steerDeg > 355 || p.steerDeg < 5, `steer ${p.steerDeg}`)
  for (let k = 1; k < p.path.length; k++) {
    assert.ok(Math.hypot(p.path[k].x - p.path[k - 1].x, p.path[k].y - p.path[k - 1].y) <= 1 + 1e-9)
  }
  assert.ok(Math.abs(p.fix.s - 5) < 1e-9)
})

test('a rock wall with a gap: the path goes through the gap and never touches rock', () => {
  // Wall across the route 12–13 m ahead, 60 m wide, with a 3 m gap at x 6..9.
  const g = world([
    { x0: -30, x1: 6, y0: 12, y1: 13, cls: HAZARD.rock },
    { x0: 9, x1: 30, y0: 12, y1: 13, cls: HAZARD.rock },
  ])
  const p = new LocalPlanner().plan(g, NORTH, 0, 0)
  assert.equal(p.blocked, false)
  assert.deepEqual(p.goal, { x: 0, y: 30 })
  assert.ok(!classesUnder(g, p).has(HAZARD.rock), 'path crosses rock')
  const crossing = p.path.filter((q) => q.y > 11.5 && q.y <= 13.5)
  assert.ok(crossing.length > 0)
  // Hazards are grown by one cell, so the path keeps at least 0.5 m from the gap's edges.
  for (const q of crossing) assert.ok(q.x >= 6.5 && q.x <= 8.5, `crosses the wall at x ${q.x}`)
  // The warning: the wall is on the route line 12 m ahead.
  assert.ok(p.hazardAheadM !== null && Math.abs(p.hazardAheadM - 12) <= 0.5, `hazardAheadM ${p.hazardAheadM}`)
  assert.equal(p.hazardAheadKind, 'rock')
  // Steering turns right, toward the gap.
  assert.ok(p.steerDeg > 10 && p.steerDeg < 80, `steer ${p.steerDeg}`)
  // No point of the path is closer than one cell to a rock cell.
  for (const q of p.path) {
    for (const [dx, dy] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
      assert.notEqual(g.classAt(q.x + dx, q.y + dy), HAZARD.rock, `(${q.x}, ${q.y}) grazes rock`)
    }
  }
})

test('a gap narrower than the suit margin does not count', () => {
  // 1 m gap = 2 cells: both are margin cells.
  const g = world([
    { x0: -30, x1: 6, y0: 12, y1: 13, cls: HAZARD.rock },
    { x0: 7, x1: 30, y0: 12, y1: 13, cls: HAZARD.rock },
  ])
  assert.equal(new LocalPlanner().plan(g, NORTH, 0, 0).blocked, true)
})

test('a wall right across the window: blocked, with the place where the route is shut', () => {
  const g = world([{ x0: -30, x1: 30, y0: 12, y1: 13, cls: HAZARD.rock }])
  const p = new LocalPlanner().plan(g, NORTH, 0, 0)
  assert.equal(p.blocked, true)
  assert.deepEqual(p.path, [])
  assert.ok(p.blockedAt !== null)
  assert.ok(Math.abs(p.blockedAt.x) < 1e-9 && p.blockedAt.y >= 11 && p.blockedAt.y <= 12.5, `blockedAt y ${p.blockedAt.y}`)
  assert.ok(p.hazardAheadM !== null && Math.abs(p.hazardAheadM - 12) <= 0.5)
  assert.ok(p.steerDeg > 355 || p.steerDeg < 5)
  // steep ground and drop-offs shut cells like rock does
  for (const cls of [HAZARD.steep, HAZARD.drop] as const) {
    assert.equal(new LocalPlanner().plan(world([{ x0: -30, x1: 30, y0: 12, y1: 13, cls }]), NORTH, 0, 0).blocked, true)
  }
})

test('sand is walked round when clean ground is a little longer, and crossed when there is no other way', () => {
  // A sand patch 10 m wide on the route: round it is about 3 m longer.
  const patch = world([{ x0: -5, x1: 5, y0: 10, y1: 20, cls: HAZARD.sand }])
  const planner = new LocalPlanner()
  const round = planner.plan(patch, NORTH, 0, 0)
  assert.equal(round.blocked, false)
  assert.ok(!classesUnder(patch, round).has(HAZARD.sand), 'path crosses sand')
  assert.ok(lengthOf(round) > 30.5 && lengthOf(round) < 36, `length ${lengthOf(round)}`)
  assert.equal(round.hazardAheadM, null) // sand is not a stop-and-look hazard

  // A sand belt right across the window: through it, straight.
  const belt = world([{ x0: -40, x1: 40, y0: 10, y1: 14, cls: HAZARD.sand }])
  const through = planner.plan(belt, NORTH, 0, 0)
  assert.equal(through.blocked, false)
  assert.ok(classesUnder(belt, through).has(HAZARD.sand))
  assert.ok(lengthOf(through) < 31, `length ${lengthOf(through)}`)
})

test('ground already seen as safe is preferred to ground not seen yet', () => {
  // Nothing seen except a safe corridor that bends east around an unseen block on the route.
  const g = new HazardGrid()
  const seen = (x0: number, y0: number, cols: number, rows: number) =>
    g.update({ x0, y0, cols, rows, cls: new Uint8Array(cols * rows).fill(HAZARD.safe), conf: new Float32Array(cols * rows).fill(0.9) }, 1)
  seen(-2, 10, 4, 24) // x −2..0, y −2..10
  seen(-2, 32, 4, 8) // x −2..0, y 28..32
  seen(0, 32, 8, 68) // x 0..4, y −2..32
  const p = new LocalPlanner().plan(g, NORTH, -1, 0)
  assert.equal(p.blocked, false)
  assert.ok(!classesUnder(g, p).has(HAZARD.unseen), 'path leaves the seen corridor')
})

test('a goal inside a hazard moves to the first free route point beyond it', () => {
  // Rock on the route 29–31 m ahead (plus its margin: 28.5–31.5).
  const g = world([{ x0: -1, x1: 1, y0: 29, y1: 31, cls: HAZARD.rock }])
  const p = new LocalPlanner().plan(g, NORTH, 0, 0)
  assert.equal(p.blocked, false)
  assert.ok(p.goal !== null && p.goal.y > 31.5 && p.goal.y <= 33, `goal y ${p.goal?.y}`)
  assert.ok(!classesUnder(g, p).has(HAZARD.rock))
})

test('near the end of the leg the goal is the stop itself', () => {
  const p = new LocalPlanner().plan(world([]), NORTH, 0, 92)
  assert.deepEqual(p.goal, { x: 0, y: 100 })
  assert.ok(Math.abs(lengthOf(p) - 8) < 0.2)
})

test('a rock right beside the astronaut does not block the plan', () => {
  const g = world([{ x0: 0.5, x1: 1.5, y0: 0, y1: 1, cls: HAZARD.rock }])
  const p = new LocalPlanner().plan(g, NORTH, 0.2, 0.6) // inside the rock's margin
  assert.equal(p.blocked, false)
  assert.ok(!classesUnder(g, p).has(HAZARD.rock))
})

test('far off the route the guide leads back toward it', () => {
  const p = new LocalPlanner().plan(world([]), NORTH, 39, 50)
  assert.equal(p.blocked, false)
  assert.ok(p.steerDeg > 260 && p.steerDeg < 280, `steer ${p.steerDeg}`) // west, back to the route
})

test('one call takes well under 5 ms', () => {
  // A boulder field: 400 rocks of 1 m scattered over the window area, plus sand patches. Deterministic.
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const boxes: Box[] = []
  for (let k = 0; k < 400; k++) {
    const x = -30 + rnd() * 60
    const y = 4 + rnd() * 70
    boxes.push({ x0: x, x1: x + 1, y0: y, y1: y + 1, cls: rnd() < 0.8 ? HAZARD.rock : HAZARD.sand })
  }
  const g = world(boxes)
  const planner = new LocalPlanner()
  for (let k = 0; k < 20; k++) planner.plan(g, NORTH, 0, k) // warm up
  const times: number[] = []
  let blocked = 0
  let hint: number | undefined
  for (let k = 0; k < 300; k++) {
    const y = (k * 0.2) % 60
    const x = Math.sin(k) * 1.5
    const t0 = performance.now()
    const p = planner.plan(g, NORTH, x, y, hint)
    times.push(performance.now() - t0)
    hint = p.fix.s
    if (k === 299) hint = undefined
    if (p.blocked) blocked++
    else {
      // The walker's own straight line crosses rocks here; beyond the first 1.5 m the guide must be clean.
      const rest = { ...p, path: p.path.filter((q) => Math.hypot(q.x - x, q.y - y) > 1.5) }
      assert.ok(!classesUnder(g, rest).has(HAZARD.rock))
    }
  }
  // The worst case for A*: no way through, so the whole reachable window is searched.
  const wall = world([{ x0: -30, x1: 30, y0: 28, y1: 29, cls: HAZARD.rock }])
  const wallTimes: number[] = []
  for (let k = 0; k < 100; k++) {
    const t0 = performance.now()
    assert.equal(planner.plan(wall, NORTH, 0, 0).blocked, true)
    wallTimes.push(performance.now() - t0)
  }
  const stats = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q)
    return { mean: a.reduce((p, q) => p + q, 0) / a.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] }
  }
  const field = stats(times)
  const full = stats(wallTimes)
  const f = (v: number) => v.toFixed(2)
  console.log(
    `local planner: boulder field mean ${f(field.mean)} ms, p95 ${f(field.p95)} ms, max ${f(field.max)} ms (${blocked}/300 blocked); ` +
      `no way through (whole window searched) mean ${f(full.mean)} ms, p95 ${f(full.p95)} ms, max ${f(full.max)} ms`,
  )
  assert.ok(field.p95 < 5, `p95 ${field.p95} ms`)
  assert.ok(full.p95 < 5, `p95 ${full.p95} ms`)
})
