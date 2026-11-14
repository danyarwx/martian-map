// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARS_RADIUS_M } from '../../lib/geo.ts'
import type { ReplanRequest, ReplanResponse } from '../../lib/planner.worker.ts'
import type { LatLon, RouteLeg, RoutePlan, Target, TerrainMeta } from '../../types.ts'
import { HAZARD, type HazardClass } from '../contracts.ts'
import { toLatLon } from '../frames.ts'
import { HazardGrid } from '../mapping/hazardGrid.ts'
import {
  ReplanClient,
  ReplanDecider,
  remainingMinutes,
  remainingPath,
  remainingStops,
  type ReplanJob,
  type ReplanWorkerLike,
} from './replan.ts'

const ORIGIN: LatLon = { lat: 18.45886, lon: 77.4061 }
const RAD = Math.PI / 180

/**
 * A 1 km × 1 km planner grid of 10 m cells with the session origin on a cell corner in its middle:
 * local (x, y) is in column floor((x + 500) / 10), row floor((500 − y) / 10).
 */
const META: TerrainMeta = (() => {
  const dLat = 500 / MARS_RADIUS_M / RAD
  const dLon = 500 / (MARS_RADIUS_M * Math.cos(ORIGIN.lat * RAD)) / RAD
  return {
    source: 'test',
    west: ORIGIN.lon - dLon,
    east: ORIGIN.lon + dLon,
    south: ORIGIN.lat - dLat,
    north: ORIGIN.lat + dLat,
    width: 100,
    height: 100,
    cellMetersX: 10,
    cellMetersY: 10,
  }
})()

/** Planner cell index of local (x, y), computed by hand (see META). */
const cell = (x: number, y: number) => Math.floor((500 - y) / 10) * 100 + Math.floor((x + 500) / 10)
const at = (x: number, y: number) => toLatLon(x, y, ORIGIN)

/** The route: north along x = 5 from y = 5 to y = 195, a vertex every 10 m (the centres of planner cells). */
const ROUTE: LatLon[] = Array.from({ length: 20 }, (_, k) => at(5, 5 + 10 * k))

/** Paints a hazard rectangle, x in [x0, x1), y in (y0, y1] metres, into the grid. */
function paint(g: HazardGrid, x0: number, x1: number, y0: number, y1: number, cls: HazardClass = HAZARD.rock): void {
  const cols = Math.round((x1 - x0) / 0.5)
  const rows = Math.round((y1 - y0) / 0.5)
  g.update({ x0, y0: y1, cols, rows, cls: new Uint8Array(cols * rows).fill(cls), conf: new Float32Array(cols * rows).fill(0.9) }, 1)
}

function decider(options = {}): ReplanDecider {
  const d = new ReplanDecider(META, ORIGIN, options)
  d.setRoute(ROUTE)
  return d
}

test('a planner cell on the route covered 30 % or more by rock triggers a re-route with that cell', () => {
  const g = new HazardGrid()
  paint(g, 2, 8, 42, 48) // 36 m² of the cell x 0..10, y 40..50
  const d = decider()
  const r = d.check({ grid: g, at: at(5, 5), localBlocked: false, nowMs: 1000 })
  assert.equal(r.replan, true)
  assert.equal(r.reason, 'hazard-on-route')
  assert.deepEqual(r.newCells, [cell(5, 45)])
  assert.equal(d.blocked[cell(5, 45)], 1)
  assert.deepEqual(d.blockedCells(), [cell(5, 45)])
  assert.equal(d.blocked.length, META.width * META.height)
})

test('steep ground and drop-offs block like rock; sand and thin cover do not', () => {
  for (const cls of [HAZARD.steep, HAZARD.drop] as const) {
    const g = new HazardGrid()
    paint(g, 2, 8, 42, 48, cls)
    assert.equal(decider().check({ grid: g, at: at(5, 5), localBlocked: false, nowMs: 0 }).replan, true)
  }
  const sand = new HazardGrid()
  paint(sand, 0, 10, 40, 50, HAZARD.sand)
  assert.equal(decider().check({ grid: sand, at: at(5, 5), localBlocked: false, nowMs: 0 }).replan, false)
  const thin = new HazardGrid()
  paint(thin, 3, 7, 43, 47) // 16 %
  const d = decider()
  assert.equal(d.check({ grid: thin, at: at(5, 5), localBlocked: false, nowMs: 0 }).replan, false)
  assert.deepEqual(d.blockedCells(), [])
})

test('a hazard far off the route is remembered but triggers nothing', () => {
  const g = new HazardGrid()
  paint(g, 100, 110, 40, 50)
  const d = decider()
  const r = d.check({ grid: g, at: at(5, 5), localBlocked: false, nowMs: 0 })
  assert.deepEqual(r, { replan: false, reason: null, newCells: [] })
  assert.deepEqual(d.blockedCells(), [cell(105, 45)]) // goes out with the next re-route
})

test('a blocked cell next to the route counts as on it (nearCells 1), two cells away does not', () => {
  const beside = new HazardGrid()
  paint(beside, 10, 20, 40, 50)
  assert.equal(decider().check({ grid: beside, at: at(5, 5), localBlocked: false, nowMs: 0 }).replan, true)
  assert.equal(decider({ nearCells: 0 }).check({ grid: beside, at: at(5, 5), localBlocked: false, nowMs: 0 }).replan, false)
  const twoAway = new HazardGrid()
  paint(twoAway, 20, 30, 40, 50)
  assert.equal(decider().check({ grid: twoAway, at: at(5, 5), localBlocked: false, nowMs: 0 }).replan, false)
})

test('a hazard on the part of the route already walked triggers nothing', () => {
  const g = new HazardGrid()
  paint(g, 0, 10, 40, 50)
  const d = decider()
  assert.equal(d.check({ grid: g, at: at(5, 105), localBlocked: false, nowMs: 0 }).replan, false)
  assert.equal(d.blocked[cell(5, 45)], 1)
})

test('at most one re-route per 5 s; cells found meanwhile are picked up afterwards', () => {
  const g = new HazardGrid()
  paint(g, 0, 10, 40, 50)
  const d = decider()
  assert.equal(d.check({ grid: g, at: at(5, 5), localBlocked: false, nowMs: 1000 }).replan, true)
  // the same hazard again: nothing new
  assert.equal(d.check({ grid: g, at: at(5, 6), localBlocked: false, nowMs: 1200 }).replan, false)
  // a new hazard on the route 2 s later: too soon
  paint(g, 0, 10, 80, 90)
  assert.equal(d.check({ grid: g, at: at(5, 8), localBlocked: false, nowMs: 3000 }).replan, false)
  assert.equal(d.check({ grid: g, at: at(5, 9), localBlocked: true, localBlockedAt: at(5, 80), nowMs: 5900 }).replan, false)
  // 5 s after the first one: now
  const r = d.check({ grid: g, at: at(5, 10), localBlocked: false, nowMs: 6000 })
  assert.equal(r.replan, true)
  assert.deepEqual(r.newCells, [cell(5, 85)])
  assert.deepEqual(d.blockedCells().sort((a, b) => a - b), [cell(5, 85), cell(5, 45)])
  // and nothing new after that, however long we wait
  assert.equal(d.check({ grid: g, at: at(5, 10), localBlocked: false, nowMs: 60000 }).replan, false)
})

test('local planner blocked: nearby planner cells holding a thin wall are blocked', () => {
  // A wall 0.5 m thick and 30 m long across the route: 5 % of each planner cell it crosses fully.
  const g = new HazardGrid()
  paint(g, -15, 15, 62, 62.5)
  const d = decider()
  assert.equal(d.check({ grid: g, at: at(5, 50), localBlocked: false, nowMs: 0 }).replan, false) // far below 30 %
  const r = d.check({ grid: g, at: at(5, 50), localBlocked: true, localBlockedAt: at(5, 61.5), nowMs: 100 })
  assert.equal(r.replan, true)
  assert.equal(r.reason, 'local-blocked')
  // x −10..0 and 0..10 hold 20 wall cells each (5 %); the ends hold 10 (2.5 %, under localCoverage).
  assert.deepEqual([...r.newCells].sort((a, b) => a - b), [cell(-5, 62), cell(5, 62)])
})

test('local planner blocked with nothing to blame: the place the route is shut, else the next route cell', () => {
  const empty = new HazardGrid()
  const d = decider()
  const r = d.check({ grid: empty, at: at(5, 52), localBlocked: true, localBlockedAt: at(5, 71), nowMs: 0 })
  assert.equal(r.reason, 'local-blocked')
  assert.deepEqual(r.newCells, [cell(5, 71)])

  const d2 = decider()
  const r2 = d2.check({ grid: empty, at: at(5, 52), localBlocked: true, nowMs: 0 })
  assert.deepEqual(r2.newCells, [cell(5, 65)]) // not the astronaut's own cell (y 50..60)
  // the astronaut's own cell is never blocked this way, even when the route is shut inside it
  const d3 = decider()
  const r3 = d3.check({ grid: empty, at: at(5, 52), localBlocked: true, localBlockedAt: at(5, 58), nowMs: 0 })
  assert.deepEqual(r3.newCells, [cell(5, 65)])
  assert.equal(d3.blocked[cell(5, 52)], 0)
})

test('a new route keeps the blocked cells and resets progress', () => {
  const g = new HazardGrid()
  paint(g, 0, 10, 40, 50)
  const d = decider()
  d.check({ grid: g, at: at(5, 5), localBlocked: false, nowMs: 0 })
  d.setRoute([at(25, 5), at(25, 15), at(25, 25)])
  assert.deepEqual(d.blockedCells(), [cell(5, 45)])
  paint(g, 20, 30, 10, 20)
  const r = d.check({ grid: g, at: at(25, 5), localBlocked: false, nowMs: 10000 })
  assert.deepEqual(r.newCells, [cell(25, 15)])
})

// ---- what is left of a plan

function leg(fromId: string, toId: string, path: LatLon[], minutes: number): RouteLeg {
  return {
    fromId, toId, path, minutes,
    distanceM: 0, ascentM: 0, descentM: 0, maxSlopeDeg: 0, steepM: 0, notes: [], sections: [], elev: [], walkHomeMin: [],
  }
}

/** Habitat → A → B → habitat, 20 min of work per stop. */
const PLAN: RoutePlan = {
  mobility: 'walk',
  profile: 'gentle',
  order: ['habitat', 'a', 'b', 'habitat'],
  legs: [
    leg('habitat', 'a', [at(0, 0), at(0, 10), at(0, 20)], 10),
    leg('a', 'b', [at(0, 20), at(10, 20), at(20, 20), at(30, 20)], 30),
    leg('b', 'habitat', [at(30, 20), at(15, 10), at(0, 0)], 20),
  ],
  unreachable: [],
  unreachableWhy: {},
  habitatNoFooting: false,
  distanceM: 0,
  travelMinutes: 60,
  stopMinutes: 40,
  totalMinutes: 100,
  ascentM: 0,
  maxSlopeDeg: 0,
  steepM: 0,
  fitsOneEva: true,
}

test('remainingPath starts at the vertex nearest the astronaut on the active leg', () => {
  assert.equal(remainingPath(PLAN, 0).length, 10)
  const p = remainingPath(PLAN, 1, at(12, 21))
  assert.equal(p.length, 3 + 3)
  assert.deepEqual(p[0], at(10, 20))
  assert.deepEqual(p[p.length - 1], at(0, 0))
  assert.deepEqual(remainingPath(PLAN, 5), [])
})

test('remainingStops lists the stops ahead in order, then the habitat', () => {
  const r = remainingStops(PLAN, 0)
  assert.deepEqual(r.stops.map((s) => s.id), ['a', 'b'])
  assert.equal(r.habitat.id, 'habitat')
  // rebuilt from the leg ends
  assert.deepEqual({ lat: r.stops[1].lat, lon: r.stops[1].lon }, at(30, 20))
  assert.deepEqual({ lat: r.habitat.lat, lon: r.habitat.lon }, at(0, 0))
  // on the last leg only the habitat is left
  assert.deepEqual(remainingStops(PLAN, 2).stops, [])
  // the site's own targets are used when given
  const b: Target = { id: 'b', name: 'Stop B', summary: 's', science: 'sc', task: 't', ...at(31, 22) }
  const habitat: Target = { id: 'habitat', name: 'Habitat', summary: '', science: '', task: '', ...at(1, 1) }
  const named = remainingStops(PLAN, 1, { habitat, targets: [b] })
  assert.deepEqual(named.stops, [b])
  assert.equal(named.habitat, habitat)
})

test('remainingMinutes counts the rest of the leg, later legs and the work at stops ahead', () => {
  assert.equal(remainingMinutes(PLAN, 0), 100)
  assert.equal(remainingMinutes(PLAN, 0, 0.5), 95)
  assert.equal(remainingMinutes(PLAN, 1, 0.5), 15 + 20 + 20) // half of leg 2, leg 3, work at B
  assert.equal(remainingMinutes(PLAN, 2, 0.25), 15)
  assert.equal(remainingMinutes(PLAN, 3), 0)
})

// ---- the worker bridge

class FakeWorker implements ReplanWorkerLike {
  onmessage: ((e: MessageEvent<ReplanResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  sent: ReplanRequest[] = []
  terminated = false
  postMessage(msg: ReplanRequest): void {
    this.sent.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  answer(res: ReplanResponse | object): void {
    this.onmessage?.({ data: res } as MessageEvent<ReplanResponse>)
  }
}

const TERRAIN = { meta: '/data/t.json', slope: '/data/t.slope.bin', elev: '/data/t.elev.bin', overlay: '/data/t.png' }

function job(): ReplanJob {
  const { stops, habitat } = remainingStops(PLAN, 1)
  return { mobility: PLAN.mobility, profile: PLAN.profile, from: at(12, 21), stops, habitat, blocked: [7, 42], remainingMinutes: 55 }
}

test('ReplanClient sends the worker its replan message and resolves with the plan and the time difference', async () => {
  const w = new FakeWorker()
  const client = new ReplanClient(TERRAIN, () => w)
  assert.equal(client.busy, false)
  const j = job()
  const promise = client.replan(j)
  assert.equal(client.busy, true)
  assert.equal(w.sent.length, 1)
  assert.deepEqual(w.sent[0], {
    type: 'replan',
    id: w.sent[0].id,
    terrain: TERRAIN,
    mobility: 'walk',
    from: at(12, 21),
    stops: j.stops,
    habitat: j.habitat,
    blocked: [7, 42],
    profile: 'gentle',
  })
  // a second request while one runs is refused
  await assert.rejects(client.replan(j), /already running/)
  // answers to other requests and plan responses (no type) are ignored
  w.answer({ type: 'replan', id: w.sent[0].id + 99, ok: false, error: 'other' })
  w.answer({ id: w.sent[0].id, ok: true, plans: {} })
  assert.equal(client.busy, true)

  const newPlan: RoutePlan = { ...PLAN, order: ['start', 'b', 'habitat'], legs: PLAN.legs.slice(1), totalMinutes: 63.5 }
  w.answer({ type: 'replan', id: w.sent[0].id, ok: true, plan: newPlan })
  const result = await promise
  assert.equal(result.plan, newPlan)
  assert.equal(result.deltaMinutes, 8.5)
  assert.equal(client.busy, false)
})

test('ReplanClient rejects when the planner fails, finds nothing, crashes, or the client is disposed', async () => {
  const w = new FakeWorker()
  const client = new ReplanClient(TERRAIN, () => w)

  let p = client.replan(job())
  w.answer({ type: 'replan', id: w.sent[0].id, ok: false, error: 'Error: No passable ground near the start point' })
  await assert.rejects(p, /No passable ground/)
  assert.equal(client.busy, false)

  p = client.replan(job())
  assert.notEqual(w.sent[1].id, w.sent[0].id)
  w.answer({ type: 'replan', id: w.sent[1].id, ok: true, plan: { ...PLAN, legs: [], totalMinutes: 0 } })
  await assert.rejects(p, /No safe route/)

  p = client.replan(job())
  w.onerror?.({ message: 'boom' } as ErrorEvent)
  await assert.rejects(p, /boom/)

  p = client.replan(job())
  client.dispose()
  await assert.rejects(p, /disposed/)
  assert.equal(w.terminated, true)
  await assert.rejects(client.replan(job()), /disposed/)
  client.dispose() // twice is fine
})
