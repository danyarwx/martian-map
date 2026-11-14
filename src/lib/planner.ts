import type { LatLon, Mobility, RouteLeg, RoutePlan, Target, Terrain } from '../types.ts'
import { buildCostGrid, findPath, snapToPassable } from './astar.ts'
import { explainLeg } from './explain.ts'
import { cellCenter, toCell } from './geo.ts'
import { secondsPerMetre } from './mobility.ts'

const ELEV_NO_DATA = -32768

/** Turns a chain of grid cells into a leg with its distance, climb and steepest cell. */
function legFromCells(t: Terrain, m: Mobility, cells: number[], seconds: number, fromId: string, toId: string): RouteLeg {
  const path: LatLon[] = []
  let distanceM = 0
  let ascentM = 0
  let descentM = 0
  let maxSlope = 0
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k]
    const col = i % t.width
    const row = (i / t.width) | 0
    path.push(cellCenter(t, col, row))
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
  const { notes, sections } = explainLeg(t, m, cells)
  return { fromId, toId, path, distanceM, minutes: seconds / 60, ascentM, descentM, maxSlopeDeg: maxSlope, notes, sections }
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

/**
 * Plans a round trip from the habitat through the chosen targets and back.
 * Each leg is the fastest safe path over the terrain for this mobility; the visiting order
 * is the one with the least total travel time. Targets with no safe path are reported, not visited.
 */
export function planRoute(t: Terrain, m: Mobility, habitat: Target, targets: Target[]): RoutePlan {
  const cost = buildCostGrid(t, m)
  const fastest = secondsPerMetre(m, 0)
  const stops = [habitat, ...targets]
  const cells = stops.map((s) => {
    const { col, row } = toCell(t, s)
    return snapToPassable(cost, t.width, t.height, col, row)
  })

  // Fastest leg between every pair of stops. Cost is symmetric, so one search serves both directions.
  const legs = new Map<string, RouteLeg>()
  const key = (a: number, b: number) => `${a}>${b}`
  for (let a = 0; a < stops.length; a++) {
    for (let b = a + 1; b < stops.length; b++) {
      if (cells[a] < 0 || cells[b] < 0) continue
      const found = findPath(cost, t.width, t.height, t.cellMetersX, t.cellMetersY, cells[a], cells[b], fastest)
      if (!found) continue
      const leg = legFromCells(t, m, found.cells, found.seconds, stops[a].id, stops[b].id)
      legs.set(key(a, b), leg)
      legs.set(key(b, a), reverseLeg(leg))
    }
  }

  const reachable: number[] = []
  const unreachable: string[] = []
  for (let i = 1; i < stops.length; i++) {
    if (legs.has(key(0, i))) reachable.push(i)
    else unreachable.push(stops[i].id)
  }

  let bestOrder: number[] = []
  let bestMinutes = Infinity
  for (const perm of permutations(reachable)) {
    const tour = [0, ...perm, 0]
    let minutes = 0
    for (let k = 1; k < tour.length && minutes < bestMinutes; k++) {
      minutes += legs.get(key(tour[k - 1], tour[k]))?.minutes ?? Infinity
    }
    if (minutes < bestMinutes) {
      bestMinutes = minutes
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
    order: bestOrder.map((i) => stops[i].id),
    legs: routeLegs,
    unreachable,
    distanceM: sum((l) => l.distanceM),
    travelMinutes,
    stopMinutes,
    totalMinutes,
    ascentM: sum((l) => l.ascentM),
    maxSlopeDeg: routeLegs.reduce((s, l) => Math.max(s, l.maxSlopeDeg), 0),
    fitsOneEva: totalMinutes <= m.maxEvaHours * 60,
  }
}
