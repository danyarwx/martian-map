import type {
  LatLon,
  Mobility,
  RouteLeg,
  RoutePlan,
  RoutePlans,
  RouteProfile,
  Target,
  Terrain,
  UnreachableReason,
} from '../types.ts'
import { buildCostGrid, findPath, snapToPassable } from './astar.ts'
import { explainLeg } from './explain.ts'
import { cellCenter, toCell } from './geo.ts'
import { secondsPerMetre } from './mobility.ts'

const ELEV_NO_DATA = -32768

/** How strongly the gentle route avoids slope: ground at the slope limit counts as 1 + this times slower. */
const GENTLE_WEIGHT = 8
/** The gentle route is "the same" as the fast one when its total time differs by no more than this, minutes, */
const SAME_WITHIN_MINUTES = 2
/** and its steepest slope by no more than this, degrees, */
const SAME_WITHIN_DEG = 1
/** and its distance on steep ground by no more than this, metres. */
const SAME_WITHIN_STEEP_M = 20

/** Factor the gentle route search puts on a cell's travel time: 1 on the level, growing with the square of the slope. */
function gentlePenalty(m: Mobility, slopeDeg: number): number {
  return 1 + GENTLE_WEIGHT * (slopeDeg / m.maxSlopeDeg) ** 2
}

/** Real travel time along a chain of cells, seconds: each step is its length times the mean of the two cells. */
function travelSeconds(t: Terrain, secPerM: Float32Array, cells: number[]): number {
  let seconds = 0
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1]
    const b = cells[k]
    const dc = Math.abs((a % t.width) - (b % t.width))
    const dr = Math.abs(((a / t.width) | 0) - ((b / t.width) | 0))
    seconds += Math.hypot(dc * t.cellMetersX, dr * t.cellMetersY) * 0.5 * (secPerM[a] + secPerM[b])
  }
  return seconds
}

/** Turns a chain of grid cells into a leg with its distance, climb and steepest cell. `seconds` is real travel time. */
function legFromCells(
  t: Terrain,
  m: Mobility,
  profile: RouteProfile,
  cells: number[],
  seconds: number,
  fromId: string,
  toId: string,
  homeSec: Float32Array | null,
): RouteLeg {
  const path: LatLon[] = []
  const elev: (number | null)[] = []
  const walkHomeMin: number[] = []
  let distanceM = 0
  let ascentM = 0
  let descentM = 0
  let maxSlope = 0
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k]
    const col = i % t.width
    const row = (i / t.width) | 0
    path.push(cellCenter(t, col, row))
    elev.push(t.elev[i] === ELEV_NO_DATA ? null : t.elev[i] / 10)
    if (homeSec) walkHomeMin.push(Math.round(homeSec[i] / 6) / 10)
    if (t.slope[i] !== 255) maxSlope = Math.max(maxSlope, t.slope[i] / 2)
    if (k === 0) continue
    const p = cells[k - 1]
    const dc = Math.abs(col - (p % t.width))
    const dr = Math.abs(row - ((p / t.width) | 0))
    distanceM += Math.hypot(dc * t.cellMetersX, dr * t.cellMetersY)
    if (t.elev[i] !== ELEV_NO_DATA && t.elev[p] !== ELEV_NO_DATA) {
      const dz = (t.elev[i] - t.elev[p]) / 10
      if (dz > 0) ascentM += dz
      else descentM -= dz
    }
  }
  const { notes, sections, steepM } = explainLeg(t, m, cells, profile)
  return {
    fromId,
    toId,
    path,
    distanceM,
    minutes: seconds / 60,
    ascentM,
    descentM,
    maxSlopeDeg: maxSlope,
    steepM,
    notes,
    sections,
    elev,
    walkHomeMin,
  }
}

function reverseLeg(l: RouteLeg): RouteLeg {
  return {
    ...l,
    fromId: l.toId,
    toId: l.fromId,
    path: [...l.path].reverse(),
    ascentM: l.descentM,
    descentM: l.ascentM,
    notes: [...l.notes].reverse(),
    elev: [...l.elev].reverse(),
    walkHomeMin: [...l.walkHomeMin].reverse(),
    sections: l.sections.map((s) => ({ ...s, path: [...s.path].reverse() })).reverse(),
  }
}

/** Every ordering of `items`. Fine for the handful of targets one excursion can hold. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  const out: T[][] = []
  items.forEach((x, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const p of permutations(rest)) out.push([x, ...p])
  })
  return out
}

/** The stops of one request, snapped to ground the crew can stand on. Shared by both route profiles. */
interface Footing {
  stops: Target[]
  /** Grid cell per stop, -1 when nothing passable is within reach of it. */
  cells: number[]
  /** Real seconds per metre per cell for this mobility. */
  secPerM: Float32Array
  /** Seconds on foot back to the habitat per cell, or null when not asked for. */
  homeSec: Float32Array | null
}

/** A stop on no-go ground is moved to the nearest passable cell within about 50 m. */
function findFooting(
  t: Terrain,
  m: Mobility,
  habitat: Target,
  targets: Target[],
  homeSec: Float32Array | null = null,
): Footing {
  const secPerM = buildCostGrid(t, m)
  const stops = [habitat, ...targets]
  const cells = stops.map((s) => {
    const { col, row } = toCell(t, s)
    return snapToPassable(secPerM, t.width, t.height, col, row)
  })
  return { stops, cells, secPerM, homeSec }
}

/**
 * Plans the round trip for one profile. Each leg is the best safe path for that profile (least time,
 * or least slope-weighted time) and the visiting order minimises the same thing over the whole trip.
 * The plan reports real times either way.
 */
function planOn(t: Terrain, m: Mobility, profile: RouteProfile, { stops, cells, secPerM, homeSec }: Footing): RoutePlan {
  const cost = profile === 'fast' ? secPerM : buildCostGrid(t, m, (deg) => gentlePenalty(m, deg))
  const fastest = secondsPerMetre(m, 0)

  // Best leg between every pair of stops. Cost is symmetric, so one search serves both directions.
  const legs = new Map<string, RouteLeg>()
  /** What the search minimised per leg: minutes, slope-weighted for the gentle profile. */
  const weight = new Map<string, number>()
  const key = (a: number, b: number) => `${a}>${b}`
  for (let a = 0; a < stops.length; a++) {
    for (let b = a + 1; b < stops.length; b++) {
      if (cells[a] < 0 || cells[b] < 0) continue
      const found = findPath(cost, t.width, t.height, t.cellMetersX, t.cellMetersY, cells[a], cells[b], fastest)
      if (!found) continue
      const seconds = profile === 'fast' ? found.seconds : travelSeconds(t, secPerM, found.cells)
      const leg = legFromCells(t, m, profile, found.cells, seconds, stops[a].id, stops[b].id, homeSec)
      legs.set(key(a, b), leg)
      legs.set(key(b, a), reverseLeg(leg))
      weight.set(key(a, b), found.seconds / 60)
      weight.set(key(b, a), found.seconds / 60)
    }
  }

  const reachable: number[] = []
  const unreachable: string[] = []
  const unreachableWhy: Record<string, UnreachableReason> = {}
  for (let i = 1; i < stops.length; i++) {
    if (legs.has(key(0, i))) {
      reachable.push(i)
      continue
    }
    unreachable.push(stops[i].id)
    unreachableWhy[stops[i].id] = cells[i] < 0 ? 'no-footing' : 'no-path'
  }

  let bestOrder: number[] = []
  let bestWeight = Infinity
  for (const perm of permutations(reachable)) {
    const tour = [0, ...perm, 0]
    let total = 0
    for (let k = 1; k < tour.length && total < bestWeight; k++) {
      total += weight.get(key(tour[k - 1], tour[k])) ?? Infinity
    }
    if (total < bestWeight) {
      bestWeight = total
      bestOrder = tour
    }
  }

  const routeLegs: RouteLeg[] = []
  for (let k = 1; k < bestOrder.length; k++) {
    if (bestOrder[k - 1] === bestOrder[k]) continue
    routeLegs.push(legs.get(key(bestOrder[k - 1], bestOrder[k]))!)
  }
  const sum = (f: (l: RouteLeg) => number) => routeLegs.reduce((s, l) => s + f(l), 0)
  const travelMinutes = sum((l) => l.minutes)
  const stopMinutes = reachable.length * m.stopMinutes
  const totalMinutes = travelMinutes + stopMinutes

  return {
    mobility: m.id,
    profile,
    order: bestOrder.map((i) => stops[i].id),
    legs: routeLegs,
    unreachable,
    unreachableWhy,
    habitatNoFooting: cells[0] < 0,
    distanceM: sum((l) => l.distanceM),
    travelMinutes,
    stopMinutes,
    totalMinutes,
    ascentM: sum((l) => l.ascentM),
    maxSlopeDeg: routeLegs.reduce((s, l) => Math.max(s, l.maxSlopeDeg), 0),
    steepM: sum((l) => l.steepM),
    fitsOneEva: totalMinutes <= m.maxEvaHours * 60,
  }
}

/**
 * Plans a round trip from the habitat through the chosen targets and back.
 * 'fast' takes the least time; 'gentle' keeps to gentler ground under the same slope limit, even when
 * that takes longer. Targets with no safe path are reported, not visited.
 */
export function planRoute(
  t: Terrain,
  m: Mobility,
  habitat: Target,
  targets: Target[],
  profile: RouteProfile = 'fast',
): RoutePlan {
  return planOn(t, m, profile, findFooting(t, m, habitat, targets))
}

/**
 * Plans the fastest and the gentlest round trip together, and says whether they differ enough to offer a choice.
 * With `homeSec` (see walkback.ts) every leg also carries the walking time straight back to the habitat.
 */
export function planRoutes(
  t: Terrain,
  m: Mobility,
  habitat: Target,
  targets: Target[],
  homeSec: Float32Array | null = null,
): RoutePlans {
  const footing = findFooting(t, m, habitat, targets, homeSec)
  const fast = planOn(t, m, 'fast', footing)
  let gentle = planOn(t, m, 'gentle', footing)
  // A round trip costs the same in both directions: show both routes in the same direction so they compare stop by stop.
  if (gentle.order.length > 3 && gentle.order.every((id, i) => id === fast.order[fast.order.length - 1 - i])) {
    gentle = {
      ...gentle,
      order: [...gentle.order].reverse(),
      legs: gentle.legs.map(reverseLeg).reverse(),
      ascentM: gentle.legs.reduce((s, l) => s + l.descentM, 0),
    }
  }
  const gentleIsSame =
    Math.abs(gentle.totalMinutes - fast.totalMinutes) <= SAME_WITHIN_MINUTES &&
    Math.abs(gentle.maxSlopeDeg - fast.maxSlopeDeg) <= SAME_WITHIN_DEG &&
    Math.abs(gentle.steepM - fast.steepM) <= SAME_WITHIN_STEEP_M
  return { fast, gentle, gentleIsSame }
}
