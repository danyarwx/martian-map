// Routes as the crew sees them. A leg's path runs through 10 m terrain cell centres, so even a straight
// stretch is a fine staircase at walking zoom. Navigation draws, walks and measures against a simplified
// copy instead; the planner's own paths stay as they are.
import type { LatLon, RouteLeg, RoutePlan } from '../types.ts'
import { simplifyPath } from './geometry.ts'

/** How far the drawn line may stray from the cell path, metres. Under a cell, so it never crosses into another. */
export const DISPLAY_TOLERANCE_M = 7

/** The points of a line worth drawing: the cell staircase becomes straight runs. */
export function displayLine(path: LatLon[], toleranceM = DISPLAY_TOLERANCE_M): LatLon[] {
  return simplifyPath(path, toleranceM).map((i) => path[i])
}

/** One leg with its path simplified; elevation and walk-back times are kept at the points that stay. */
function displayLeg(leg: RouteLeg, toleranceM: number): RouteLeg {
  const keep = simplifyPath(leg.path, toleranceM)
  return {
    ...leg,
    path: keep.map((i) => leg.path[i]),
    elev: keep.map((i) => leg.elev[i] ?? null),
    walkHomeMin: leg.walkHomeMin.length ? keep.map((i) => leg.walkHomeMin[i]) : [],
  }
}

/**
 * The plan navigation works with: same legs, stops, notes and totals, simplified paths.
 * The tracker projects onto these paths, so "off the route" is measured against the line on the screen.
 */
export function displayPlan(plan: RoutePlan, toleranceM = DISPLAY_TOLERANCE_M): RoutePlan {
  return { ...plan, legs: plan.legs.map((l) => displayLeg(l, toleranceM)) }
}
