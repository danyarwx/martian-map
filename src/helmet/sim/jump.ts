// "Jump to any point of the planned route" (docs/helmet/PLAN.md §2.6, §6.3). Pure: no three.js, no DOM.
import type { LatLon, RoutePlan } from '../../types.ts'
import { cumulativeM, pointAtDistance } from '../world/path.ts'

/** How far before a stop the "approach" jump lands, metres. */
export const APPROACH_M = 300

export interface JumpTarget {
  id: string
  label: string
  at: LatLon
  /** Direction of travel there, degrees clockwise from north. */
  headingDeg: number
  /** Leg of the plan the point is on. */
  legIndex: number
  /** Distance from the start of the whole route, metres. */
  routeM: number
}

/** Length of every leg and of the whole route, metres. */
export function routeLengths(plan: RoutePlan): { legs: number[]; total: number } {
  const legs = plan.legs.map((l) => {
    const c = cumulativeM(l.path)
    return c.length ? c[c.length - 1] : 0
  })
  return { legs, total: legs.reduce((s, v) => s + v, 0) }
}

/** The point `m` metres from the start of the whole route (clamped). */
export function routePoint(plan: RoutePlan, m: number, id = 'route', label?: string): JumpTarget {
  const { legs, total } = routeLengths(plan)
  if (!plan.legs.length) throw new Error('the plan has no legs')
  let rest = Math.min(total, Math.max(0, m))
  let k = 0
  while (k < legs.length - 1 && rest > legs[k]) rest -= legs[k++]
  const p = pointAtDistance(plan.legs[k].path, rest)
  const routeM = legs.slice(0, k).reduce((s, v) => s + v, 0) + p.distanceM
  return { id, label: label ?? `${(routeM / 1000).toFixed(2)} km along the route`, at: p.at, headingDeg: p.headingDeg, legIndex: k, routeM }
}

/** The fixed jump points: the start of the route and the approach to every stop. */
export function jumpTargets(plan: RoutePlan, nameOf: (id: string) => string = (id) => id): JumpTarget[] {
  const { legs } = routeLengths(plan)
  const out: JumpTarget[] = []
  if (!plan.legs.length) return out
  out.push(routePoint(plan, 0, 'start', `Start: ${nameOf(plan.legs[0].fromId)}`))
  let before = 0
  plan.legs.forEach((leg, k) => {
    const end = before + legs[k]
    const m = Math.max(before, end - APPROACH_M)
    out.push(routePoint(plan, m, `approach-${k}`, `${Math.round(end - m)} m before ${nameOf(leg.toId)}`))
    before = end
  })
  return out
}
