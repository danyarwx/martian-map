// Run with `npm test` (Node 24 runs TypeScript directly).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LatLon, RouteLeg, RoutePlan, Target } from '../types.ts'
import { MOBILITY } from '../lib/mobility.ts'
import { DAY } from '../lib/schedule.ts'
import { saidDuration, statusText, timeAlertsBetween } from './alerts.ts'
import { createAnnouncer } from './announcer.ts'
import { createNavBus, type NavEvent } from './events.ts'
import { localProjection, projectOntoPath, turnAngle } from './geometry.ts'
import { MAX_FAILURES, RETRY_AFTER_MS, withFallback } from '../nav-ui/voice/fallback.ts'
import { createSpeechQueue, STALE_MS } from '../nav-ui/voice/queue.ts'
import { buildManeuvers, classifyTurn, saidDistance, spokenDistance, type Maneuver } from './instructions.ts'
import { EARTH_RADIUS_M, earthToMars, GpsSource } from './gps.ts'
import { SimulatedSource } from './position.ts'
import { createNavigator } from './tracker.ts'

const origin = { lat: 18.44, lon: 77.4 }
const proj = localProjection(origin)
/** A point `x` metres east and `y` metres north of the origin. */
const at = (x: number, y: number): LatLon => proj.toLatLon({ x, y })

/** A path through the given corners (metres), with a point every 10 m like a terrain-cell path. */
function path(...corners: [number, number][]): LatLon[] {
  const out: LatLon[] = [at(...corners[0])]
  for (let k = 1; k < corners.length; k++) {
    const [ax, ay] = corners[k - 1]
    const [bx, by] = corners[k]
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 10))
    for (let i = 1; i <= n; i++) out.push(at(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n))
  }
  return out
}

function leg(fromId: string, toId: string, p: LatLon[]): RouteLeg {
  return {
    fromId, toId, path: p, distanceM: 0, minutes: 10, ascentM: 0, descentM: 0, maxSlopeDeg: 0, steepM: 0,
    notes: [], sections: [], elev: p.map(() => 0), walkHomeMin: [],
  }
}

function plan(...legs: RouteLeg[]): RoutePlan {
  return {
    mobility: 'walk', profile: 'fast', order: [legs[0].fromId, ...legs.map((l) => l.toId)], legs,
    unreachable: [], unreachableWhy: {}, habitatNoFooting: false, distanceM: 0, travelMinutes: 0,
    stopMinutes: 0, totalMinutes: 0, ascentM: 0, maxSlopeDeg: 0, steepM: 0, fitsOneEva: true,
  }
}

const stop = (id: string, name: string): Target => ({ id, name, summary: '', science: '', task: 'Take a sample.', ...origin })
const stops = { habitat: stop('habitat', 'Habitat'), a: stop('a', 'Rock A') }

test('turn angles are signed and classed by size', () => {
  assert.equal(turnAngle(350, 10), 20)
  assert.equal(turnAngle(10, 350), -20)
  assert.equal(classifyTurn(20), null)
  assert.equal(classifyTurn(45), 'slight_right')
  assert.equal(classifyTurn(-90), 'left')
  assert.equal(classifyTurn(150), 'sharp_right')
  assert.equal(spokenDistance(43), '40 m')
  assert.equal(spokenDistance(380), '400 m')
  assert.equal(spokenDistance(1240), '1.2 km')
  assert.equal(saidDistance(43), '40 meters')
  assert.equal(saidDistance(1240), '1.2 kilometers')
})

test('a position is projected onto the path with its distance along, offset and side', () => {
  const p = path([0, 0], [100, 0])
  const s = projectOntoPath(p, at(50, 20))
  assert.ok(Math.abs(s.alongM - 50) < 0.5, `${s.alongM}`)
  assert.ok(Math.abs(s.offsetM - 20) < 0.5, `${s.offsetM}`)
  assert.equal(s.side, 'left') // north of a path going east
  assert.equal(projectOntoPath(p, at(50, -5)).side, 'right')
})

test('an L-shaped path gives depart, one left turn, a long straight and arrival', () => {
  const ms = buildManeuvers(plan(leg('habitat', 'a', path([0, 0], [300, 0], [300, 500]))), stops)
  assert.deepEqual(ms.map((m) => m.kind), ['depart', 'turn', 'continue', 'arrive_home'])
  assert.equal(ms[0].text, 'Head east for 300 meters')
  assert.equal(ms[1].modifier, 'left')
  assert.ok(Math.abs(ms[1].alongM - 300) < 15, `${ms[1].alongM}`)
  assert.equal(ms[2].text, 'Walk straight for 500 meters')
})

test('cell-scale zig-zags give no turns', () => {
  // Alternating 10 m steps east and north-east, and east and north: both are straight lines at walking scale.
  const corners: [number, number][] = [[0, 0]]
  const stairs: [number, number][] = [[0, 0]]
  for (let k = 1; k <= 60; k++) {
    const [x, y] = corners[k - 1]
    corners.push(k % 2 ? [x + 10, y] : [x + 7.07, y + 7.07])
    const [sx, sy] = stairs[k - 1]
    stairs.push(k % 2 ? [sx + 10, sy] : [sx, sy + 10])
  }
  for (const c of [corners, stairs]) {
    const ms = buildManeuvers(plan(leg('habitat', 'a', path(...c))), stops)
    assert.deepEqual(ms.map((m) => m.kind), ['depart', 'arrive_home'])
  }
})

test('two stops: each leg departs, and the stop is announced with its task', () => {
  const ms = buildManeuvers(
    plan(leg('habitat', 'a', path([0, 0], [200, 0])), leg('a', 'habitat', path([200, 0], [0, 0]))),
    stops,
  )
  assert.deepEqual(ms.map((m) => m.kind), ['depart', 'arrive', 'depart', 'arrive_home'])
  assert.equal(ms[1].text, 'Rock A reached. Task: Take a sample.')
  assert.equal(ms[2].text, 'Head west for 200 meters')
  assert.ok(Math.abs(ms[3].alongM - 400) < 1)
})

test('a turn is announced far, near and now, each once; one that comes up close skips the far one', () => {
  const bus = createNavBus({ channel: false })
  const said: NavEvent[] = []
  bus.subscribe('instruction', (e) => said.push(e))
  const announcer = createAnnouncer(bus, 'walk')
  const turn = { id: 't1', kind: 'turn', modifier: 'left', text: 'Turn left' } as Maneuver
  let now = 0
  for (const d of [300, 250, 199, 150, 100, 60, 49, 30, 11, 8, 5, 1]) {
    announcer.update([{ maneuver: turn, distanceM: d }], (now += 3000))
  }
  assert.deepEqual(said.map((e) => e.text), ['Turn left in 200 meters.', 'Turn left in 50 meters.', 'Turn left.'])
  assert.deepEqual(said.map((e) => e.priority), ['low', 'normal', 'high'])

  said.length = 0
  const close = { ...turn, id: 't2', text: 'Turn right', modifier: 'right' } as Maneuver
  for (const d of [120, 80, 45, 10]) announcer.update([{ maneuver: close, distanceM: d }], (now += 3000))
  assert.deepEqual(said.map((e) => e.text), ['Turn right in 50 meters.', 'Turn right.'])
})

test('announcements are at least 2 s apart unless urgent', () => {
  const bus = createNavBus({ channel: false })
  const said: NavEvent[] = []
  bus.subscribe('*', (e) => said.push(e))
  const announcer = createAnnouncer(bus, 'walk')
  const hazard = { id: 'h', kind: 'hazard', text: 'Steep ground ahead, 16 degrees, 40 meters. Slow down.' } as Maneuver
  const turn = { id: 't', kind: 'turn', modifier: 'left', text: 'Turn left' } as Maneuver
  announcer.update([{ maneuver: hazard, distanceM: 70 }, { maneuver: turn, distanceM: 45 }], 0)
  assert.deepEqual(said.map((e) => e.type), ['hazard'])
  announcer.update([{ maneuver: hazard, distanceM: 69 }, { maneuver: turn, distanceM: 44 }], 1000)
  assert.equal(said.length, 1, 'the turn waits')
  announcer.update([{ maneuver: turn, distanceM: 10 }], 1500)
  assert.equal(said.at(-1)?.text, 'Turn left.', 'the "now" call does not wait')
})

/** A navigator on a straight 1 km leg east, with a fake reroute, and the events it sends. */
function straightNav(reroute?: (from: LatLon, ids: string[]) => Promise<RoutePlan>) {
  const bus = createNavBus({ channel: false })
  const events: NavEvent[] = []
  bus.subscribe('*', (e) => e.type !== 'state' && events.push(e))
  const nav = createNavigator({
    plan: plan(leg('habitat', 'a', path([0, 0], [1000, 0])), leg('a', 'habitat', path([1000, 0], [0, 0]))),
    stops,
    mobility: MOBILITY.walk,
    bus,
    requestReroute: reroute,
    now: () => 0,
  })
  nav.start()
  const fix = (x: number, y: number, t: number) =>
    nav.update({ ...at(x, y), headingDeg: 90, speedMps: 0.7, accuracyM: 1, t })
  return { nav, events, fix, types: () => events.map((e) => e.type) }
}

test('off the route by 25-50 m for 5 s: guided back, then back on the route', () => {
  const { nav, events, fix, types } = straightNav()
  fix(100, 0, 0)
  fix(110, 35, 1000)
  fix(115, 35, 5000)
  assert.ok(!types().includes('off_route'), 'not before 5 s')
  fix(120, 35, 6500)
  assert.equal(nav.getState().status, 'off_route')
  const off = events.find((e) => e.type === 'off_route')!
  assert.equal(off.text, 'Head back to the route, 40 meters to your right.')
  fix(130, 20, 8000)
  assert.equal(nav.getState().status, 'off_route', 'still farther than 15 m')
  fix(140, 5, 9000)
  assert.equal(nav.getState().status, 'navigating')
  assert.equal(types().filter((t) => t === 'back_on_route').length, 1)
})

test('off the route by more than 50 m: replans through the stops still ahead', async () => {
  const calls: string[][] = []
  const detour = plan(leg('here', 'a', path([200, 80], [1000, 0])), leg('a', 'habitat', path([1000, 0], [0, 0])))
  const { nav, fix, types } = straightNav(async (_from, ids) => {
    calls.push(ids)
    return detour
  })
  fix(100, 0, 0)
  fix(150, 80, 1000)
  fix(160, 80, 4000)
  assert.equal(calls.length, 0, 'not before 5 s')
  fix(170, 80, 6500)
  assert.deepEqual(calls, [['a']])
  assert.equal(nav.getState().status, 'rerouting')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nav.getState().status, 'navigating')
  assert.equal(nav.getPlan(), detour)
  assert.ok(types().includes('rerouted'))
  assert.equal(nav.getState().rerouteCount, 1)
})

test('the simulated walker stops at the stop, and drifting off is noticed', () => {
  let clock = 0
  const legs = [leg('habitat', 'a', path([0, 0], [300, 0])), leg('a', 'habitat', path([300, 0], [0, 0]))]
  const sim = new SimulatedSource({ legs, mobility: MOBILITY.walk, now: () => clock, autoTick: false })
  const bus = createNavBus({ channel: false })
  const types: string[] = []
  bus.subscribe('*', (e) => e.type !== 'state' && types.push(e.type))
  const nav = createNavigator({ plan: plan(...legs), stops, mobility: MOBILITY.walk, bus, now: () => clock })
  nav.start()
  sim.start((f) => nav.update(f))
  sim.setSpeedMultiplier(10)
  sim.driftOffRoute(35)
  for (let i = 0; i < 200 && !types.includes('off_route'); i++) {
    clock += 200
    sim.step(0.2)
  }
  assert.ok(types.includes('off_route'))
  sim.driftOffRoute(0)
  for (let i = 0; i < 1000 && !sim.atStop; i++) {
    clock += 200
    sim.step(0.2)
  }
  assert.ok(sim.atStop)
  assert.equal(nav.getState().status, 'at_stop')
  assert.ok(types.includes('back_on_route'))
  assert.ok(types.includes('arrive'))
  sim.continueFromStop()
  nav.continueFromStop()
  clock += 200
  sim.step(0.2)
  assert.equal(nav.getState().status, 'navigating')
  assert.equal(nav.getState().legIndex, 1)
})

// The speech queue lives with the tablet UI, but its rules are pure logic and are tested here.
function fakeEngine() {
  const spoken: string[] = []
  let end: (() => void) | null = null
  return {
    spoken,
    /** Ends the line being spoken, as the engine does when the audio is over. */
    finish: async () => {
      end?.()
      await new Promise((r) => setTimeout(r, 0))
    },
    engine: {
      speak: (text: string) => new Promise<void>((resolve) => {
        spoken.push(text)
        end = () => { end = null; resolve() }
      }),
      cancel: () => end?.(),
    },
  }
}

test('speech queue: normal lines wait their turn, a high one interrupts and clears the rest', async () => {
  const f = fakeEngine()
  const q = createSpeechQueue(f.engine, () => 0)
  q.push('one', 'normal')
  q.push('two', 'normal')
  assert.deepEqual(f.spoken, ['one'])
  q.push('Turn left.', 'high')
  await f.finish()
  assert.deepEqual(f.spoken, ['one', 'Turn left.'], '"two" was dropped by the urgent line')
})

test('speech queue: a line that waited too long is dropped, and nothing is said while muted', async () => {
  const f = fakeEngine()
  let now = 0
  const q = createSpeechQueue(f.engine, () => now)
  q.push('long line', 'normal')
  q.push('keep going', 'low')
  q.push('still useful', 'normal')
  now = STALE_MS.low + 1
  await f.finish()
  assert.deepEqual(f.spoken, ['long line', 'still useful'])
  q.setMuted(true)
  q.push('silent', 'high')
  await f.finish()
  assert.equal(f.spoken.length, 2)
  q.setMuted(false)
  q.push('back', 'normal')
  assert.equal(f.spoken.at(-1), 'back')
})

test('voice fallback: the browser voice speaks when the cloud voice cannot, and the cloud voice is rested after repeated failures', async () => {
  const said: string[] = []
  let works = true
  let online = true
  let now = 0
  let tries = 0
  let slow = false
  const primary = {
    trySpeak: async (t: string) => {
      tries++
      if (slow) return 'slow' as const
      if (works) said.push(`cloud:${t}`)
      return works ? ('spoken' as const) : ('failed' as const)
    },
    cancel() {},
  }
  const fallback = { speak: async (t: string) => { said.push(`browser:${t}`) }, cancel() {} }
  const voice = withFallback(primary, fallback, { available: () => online, now: () => now })

  await voice.speak('a')
  works = false
  for (let i = 0; i < MAX_FAILURES; i++) await voice.speak('b')
  await voice.speak('c')
  assert.deepEqual(said, ['cloud:a', ...Array(MAX_FAILURES).fill('browser:b'), 'browser:c'])
  assert.equal(tries, 1 + MAX_FAILURES, 'not tried again while resting')

  works = true
  now = RETRY_AFTER_MS + 1
  await voice.speak('d')
  assert.equal(said.at(-1), 'cloud:d')
  online = false
  await voice.speak('e')
  assert.equal(said.at(-1), 'browser:e', 'offline goes straight to the browser voice')

  // Slow lines are said by the browser voice, but the cloud voice is not rested for them.
  online = true
  slow = true
  const before = tries
  for (let i = 0; i < MAX_FAILURES + 1; i++) await voice.speak('slow')
  assert.equal(tries - before, MAX_FAILURES + 1, 'tried every time')
  slow = false
  await voice.speak('f')
  assert.equal(said.at(-1), 'cloud:f')
})

test('time-of-day alerts: gust hours and daylight are said once, as the Mars clock passes them', () => {
  assert.deepEqual(timeAlertsBetween(DAY.gustsFrom - 20, DAY.gustsFrom - 10).map((a) => a.id), ['gusts-soon'])
  assert.deepEqual(timeAlertsBetween(DAY.gustsFrom - 10, DAY.gustsFrom - 5), [])
  const evening = timeAlertsBetween(DAY.sunset - 61, DAY.sunset - 29).map((a) => a.id)
  assert.deepEqual(evening.filter((id) => id.startsWith('daylight')), ['daylight-60', 'daylight-30'])

  const bus = createNavBus({ channel: false })
  const said: string[] = []
  bus.subscribe('time_alert', (e) => said.push(e.id))
  const nav = createNavigator({
    plan: plan(leg('habitat', 'a', path([0, 0], [1000, 0])), leg('a', 'habitat', path([1000, 0], [0, 0]))),
    stops, mobility: MOBILITY.walk, bus, now: () => 0, departLmst: DAY.gustsFrom - 20,
  })
  nav.start()
  const minute = 60000
  nav.update({ ...at(10, 0), headingDeg: 90, speedMps: 0.7, accuracyM: 1, t: 4 * minute })
  assert.deepEqual(said, [])
  nav.update({ ...at(20, 0), headingDeg: 90, speedMps: 0.7, accuracyM: 1, t: 6 * minute })
  nav.update({ ...at(30, 0), headingDeg: 90, speedMps: 0.7, accuracyM: 1, t: 7 * minute })
  assert.deepEqual(said, ['gusts-soon'])
})

test('the status readout spells out what a voice needs', () => {
  assert.equal(saidDuration(80), '1 hour 20 minutes')
  assert.equal(saidDuration(120), '2 hours')
  assert.equal(
    statusText({ minutesOut: 80, walkHomeMin: 35.2, lmst: 10 * 60 + 45, tempC: -31.6, doseMsv: 0.0356 }),
    'Status. Mars time 10:45. Out 1 hour 20 minutes. Habitat 35 minutes on foot. Air minus 32 degrees. Dose 0.04 millisieverts.',
  )
})

test('a hazard aborts the excursion: warning first, then a route straight home; only once', async () => {
  const calls: string[][] = []
  const home = plan(leg('here', 'habitat', path([100, 0], [0, 0])))
  const { nav, events, fix } = straightNav(async (_from, ids) => {
    calls.push(ids)
    return home
  })
  fix(100, 0, 0)
  assert.equal(nav.abortToHabitat('dust_storm'), true)
  assert.deepEqual(calls, [[]], 'no stops: straight to the habitat')
  assert.equal(nav.getState().abort, 'dust_storm')
  assert.equal(nav.abortToHabitat('solar_particle_event'), false)
  await new Promise((r) => setTimeout(r, 0))
  const order = events.map((e) => e.type).filter((t) => t === 'hazard_event' || t === 'rerouted')
  assert.deepEqual(order, ['hazard_event', 'rerouted'])
  assert.match(events.find((e) => e.type === 'rerouted')!.text, /^Return route: .+ to Habitat, about 10 minutes\.$/)
  assert.equal(nav.getPlan(), home)
})

test('on arrival the science reason follows the task', () => {
  const bus = createNavBus({ channel: false })
  const said: NavEvent[] = []
  bus.subscribe('*', (e) => e.type !== 'state' && said.push(e))
  const science = { ...stops, a: { ...stops.a, science: 'Lake mud keeps organics.' } }
  const nav = createNavigator({
    plan: plan(leg('habitat', 'a', path([0, 0], [100, 0])), leg('a', 'habitat', path([100, 0], [0, 0]))),
    stops: science, mobility: MOBILITY.walk, bus, now: () => 0,
  })
  nav.start()
  nav.update({ ...at(100, 0), headingDeg: 90, speedMps: 0.7, accuracyM: 1, t: 1000 })
  const i = said.findIndex((e) => e.type === 'arrive')
  assert.equal(said[i + 1]?.type, 'stop_briefing')
  assert.equal(said[i + 1]?.text, 'Lake mud keeps organics.')
})

test('Earth GPS: metres walked on Earth become the same metres on Mars, north stays north', () => {
  const earth = { lat: 52.37, lon: 4.9 }
  const toMars = earthToMars(earth, origin)
  const k = (EARTH_RADIUS_M * Math.PI) / 180
  // 100 m north and 50 m east on Earth.
  const p = proj.toXY(toMars({ lat: earth.lat + 100 / k, lon: earth.lon + 50 / (k * Math.cos((earth.lat * Math.PI) / 180)) }))
  assert.ok(Math.abs(p.y - 100) < 0.01 && Math.abs(p.x - 50) < 0.01, JSON.stringify(p))
  assert.deepEqual(toMars(earth), origin)
})

test('Earth GPS: the first fix lands on the anchor, inaccurate fixes are skipped, heading comes from movement', () => {
  type Ok = (p: GeolocationPosition) => void
  let send: Ok = () => {}
  const geo = { watchPosition: (ok: Ok) => ((send = ok), 1), clearWatch: () => {} }
  const anchor = at(200, 0)
  const statuses: string[] = []
  const fixes: { lat: number; lon: number; headingDeg: number }[] = []
  const src = new GpsSource({ anchor, geolocation: geo, onStatus: (s) => statuses.push(s.kind) })
  src.start((f) => fixes.push(f))
  const k = (EARTH_RADIUS_M * Math.PI) / 180
  const pos = (northM: number, accuracy: number) =>
    ({ timestamp: 0, coords: { latitude: 10 + northM / k, longitude: 20, accuracy, heading: null, speed: null } }) as unknown as GeolocationPosition
  send(pos(0, 5))
  send(pos(10, 120))
  send(pos(10, 5))
  assert.deepEqual(statuses, ['waiting', 'ok', 'weak', 'ok'])
  assert.equal(fixes.length, 2)
  const first = proj.toXY(fixes[0])
  assert.ok(Math.abs(first.x - 200) < 0.01 && Math.abs(first.y) < 0.01)
  const second = proj.toXY(fixes[1])
  assert.ok(Math.abs(second.y - 10) < 0.01)
  assert.ok(fixes[1].headingDeg < 1 || fixes[1].headingDeg > 359, 'walking north')
})

test('the simulated walker can be put back on the route at the navigator position', () => {
  const legs = [leg('habitat', 'a', path([0, 0], [300, 0])), leg('a', 'habitat', path([300, 0], [0, 0]))]
  const sim = new SimulatedSource({ legs, mobility: MOBILITY.walk, now: () => 0, autoTick: false })
  const fixes: LatLon[] = []
  sim.start((f) => fixes.push(f))
  sim.placeAt(1, 100)
  const p = proj.toXY(fixes[fixes.length - 1])
  assert.ok(Math.abs(p.x - 200) < 0.5, JSON.stringify(p))
  sim.placeAt(0, 1000)
  assert.equal(sim.atStop, true)
})
