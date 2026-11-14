// What the helmet opens on when nobody passed a plan (#helmet, for the presenter and screenshots).
//
// STAND-IN until "Go outside" (T2.5) hands over the real RoutePlan from Mission control: a minimal plan with one
// leg, routes.json's "habitat>three-forks", and the start point 300 m before Three Forks. Fields the helmet does
// not use yet (notes, sections, elevation profile, walk-back times) are filled with neutral values.
import { MOBILITY } from '../../lib/mobility.ts'
import type { RouteLeg, RoutePlan } from '../../types.ts'
import type { HelmetEntry } from '../contracts.ts'
import { pointBeforeEnd } from '../world/path.ts'
import { legPath, ROUTES_URL, type RoutesFile, type RoutesFileLeg } from '../world/routes.ts'

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

export function defaultEntry(routes: RoutesFile): HelmetEntry {
  const leg = routes.legs.find((l) => l.id === DEFAULT_LEG_ID)
  if (!leg) throw new Error(`routes.json has no leg ${DEFAULT_LEG_ID}`)
  const plan = standInPlan([routeLegFromFile(leg)])
  const start = pointBeforeEnd(plan.legs[0].path, START_BEFORE_STOP_M)
  return { plan, startAt: start.at, legIndex: 0 }
}

export async function loadRoutes(): Promise<RoutesFile> {
  const r = await fetch(ROUTES_URL)
  if (!r.ok) throw new Error(`${ROUTES_URL}: HTTP ${r.status}`)
  return (await r.json()) as RoutesFile
}
