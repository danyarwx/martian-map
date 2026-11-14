// public/data/helmet/routes.json (scripts/export_routes.ts): every leg between the habitat and the six targets,
// as planned for walking. Pure: no three.js.
import type { LatLon } from '../../types.ts'

export interface RoutesFileLeg {
  /** "fromId>toId". */
  id: string
  fromId: string
  toId: string
  /** [lat, lon] pairs. */
  path: [number, number][]
  distanceM: number
}

export interface RoutesFile {
  mobility: string
  legs: RoutesFileLeg[]
}

export const ROUTES_URL = '/data/helmet/routes.json'

export function legPath(leg: RoutesFileLeg): LatLon[] {
  return leg.path.map(([lat, lon]) => ({ lat, lon }))
}

/**
 * The demo excursion (App's first route: habitat → Three Forks → delta front → Séítah → habitat). Its legs decide
 * which approach a demo window uses, so the boulder field sits on the path the presenter walks.
 */
export const DEMO_ORDER = ['habitat', 'three-forks', 'delta-front', 'seitah', 'habitat'] as const

/**
 * The leg that arrives at `stopId`, as a path ending at the stop: the demo excursion's leg into it when the stop
 * is on that excursion, else the leg from the habitat. routes.json stores each pair once (from the stop listed
 * first), so a leg may be used reversed.
 */
export function approachPath(stopId: string, legs: readonly RoutesFileLeg[]): { legId: string; path: LatLon[] } | null {
  const k = DEMO_ORDER.lastIndexOf(stopId as (typeof DEMO_ORDER)[number])
  const from = k > 0 ? DEMO_ORDER[k - 1] : 'habitat'
  if (from === stopId) return null
  const fwd = legs.find((l) => l.fromId === from && l.toId === stopId)
  if (fwd) return { legId: fwd.id, path: legPath(fwd) }
  const rev = legs.find((l) => l.fromId === stopId && l.toId === from)
  if (rev) return { legId: rev.id, path: legPath(rev).reverse() }
  return null
}
