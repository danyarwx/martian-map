// What the helmet opens on when nobody passed a plan (#helmet, for the presenter and screenshots).
//
// STAND-IN until "Go outside" (T2.5) hands over the real RoutePlan from Mission control: the demo excursion
// (habitat → Three Forks → delta front → Séítah → habitat) from routes.json's legs, starting 300 m before Three Forks. Fields the helmet does
// not use yet (notes, sections, elevation profile, walk-back times) are filled with neutral values.
import { MOBILITY } from '../../lib/mobility.ts'
import type { RouteLeg, RoutePlan } from '../../types.ts'
import type { HelmetEntry } from '../contracts.ts'
import { pointBeforeEnd } from '../world/path.ts'
import { DEMO_ORDER, legPath, ROUTES_URL, type RoutesFile, type RoutesFileLeg } from '../world/routes.ts'

export const DEFAULT_LEG_ID = 'habitat>three-forks'
/** How far before the stop the astronaut starts, metres. */
export const START_BEFORE_STOP_M = 300

/** A RouteLeg from a routes.json leg. Only `path`, ids and distance are real; the rest are neutral fillers. */
export function routeLegFromFile(l: RoutesFileLeg): RouteLeg {
  const path = legPath(l)
  const mps = MOBILITY.walk.flatSpeedKmh / 3.6
  return {
    fromId: l.fromId,
    toId: l.toId,
    path,
    distanceM: l.distanceM,
    minutes: l.distanceM / mps / 60,
    ascentM: 0,
    descentM: 0,
    maxSlopeDeg: 0,
    steepM: 0,
    notes: [],
    sections: [{ path, level: 0 }],
    elev: path.map(() => null),
    walkHomeMin: [],
  }
}

/** A RoutePlan-shaped stand-in made of the given legs, in order. */
export function standInPlan(legs: RouteLeg[]): RoutePlan {
  const distanceM = legs.reduce((s, l) => s + l.distanceM, 0)
  const travelMinutes = legs.reduce((s, l) => s + l.minutes, 0)
  const stopMinutes = MOBILITY.walk.stopMinutes * legs.filter((l) => l.toId !== 'habitat').length
  return {
    mobility: 'walk',
    profile: 'fast',
    order: legs.length ? [legs[0].fromId, ...legs.map((l) => l.toId)] : [],
    legs,
    unreachable: [],
    unreachableWhy: {},
    habitatNoFooting: false,
    distanceM,
    travelMinutes,
    stopMinutes,
    totalMinutes: travelMinutes + stopMinutes,
    ascentM: 0,
    maxSlopeDeg: 0,
    steepM: 0,
    fitsOneEva: travelMinutes + stopMinutes <= MOBILITY.walk.maxEvaHours * 60,
  }
}

/** A routes.json leg between two stops, turned round when the file stores it the other way. */
function legBetween(routes: RoutesFile, from: string, to: string): RoutesFileLeg | null {
  const fwd = routes.legs.find((l) => l.fromId === from && l.toId === to)
  if (fwd) return fwd
  const rev = routes.legs.find((l) => l.fromId === to && l.toId === from)
  return rev ? { ...rev, id: `${from}>${to}`, fromId: from, toId: to, path: [...rev.path].reverse() as [number, number][] } : null
}

/** The demo excursion (DEMO_ORDER) as a stand-in plan, starting 300 m before its first stop. */
export function defaultEntry(routes: RoutesFile): HelmetEntry {
  const legs: RouteLeg[] = []
  for (let k = 0; k + 1 < DEMO_ORDER.length; k++) {
    const leg = legBetween(routes, DEMO_ORDER[k], DEMO_ORDER[k + 1])
    if (!leg) throw new Error(`routes.json has no leg ${DEMO_ORDER[k]}>${DEMO_ORDER[k + 1]}`)
    legs.push(routeLegFromFile(leg))
  }
  const plan = standInPlan(legs)
  const start = pointBeforeEnd(plan.legs[0].path, START_BEFORE_STOP_M)
  return { plan, startAt: start.at, legIndex: 0 }
}

export async function loadRoutes(): Promise<RoutesFile> {
  const r = await fetch(ROUTES_URL)
  if (!r.ok) throw new Error(`${ROUTES_URL}: HTTP ${r.status}`)
  return (await r.json()) as RoutesFile
}
