// Walking along a route polyline: lengths, the point at a distance, the heading there. Pure: no three.js.
import { distanceM } from '../../lib/geo.ts'
import type { LatLon } from '../../types.ts'
import { dirToHeading, toLocal } from '../frames.ts'

/** Distance from the start to each vertex, metres (great circle per segment). */
export function cumulativeM(path: readonly LatLon[]): number[] {
  const cum = new Array<number>(path.length)
  let d = 0
  for (let k = 0; k < path.length; k++) {
    if (k > 0) d += distanceM(path[k - 1], path[k])
    cum[k] = d
  }
  return cum
}

export function pathLengthM(path: readonly LatLon[]): number {
  return path.length ? cumulativeM(path)[path.length - 1] : 0
}

export interface PathPoint {
  at: LatLon
  /** Direction of travel at that point, degrees clockwise from north. */
  headingDeg: number
  /** Index of the segment (path[segment] → path[segment + 1]) the point is on. */
  segment: number
  /** Distance from the start actually used, after clamping to the path. */
  distanceM: number
}

/** Heading from a to b, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const d = toLocal(b, a)
  return dirToHeading(d.x, d.y)
}

/** The point `d` metres along the path from its start, clamped to the path. */
export function pointAtDistance(path: readonly LatLon[], d: number, cum: readonly number[] = cumulativeM(path)): PathPoint {
  if (path.length === 0) throw new Error('empty path')
  if (path.length === 1) return { at: { ...path[0] }, headingDeg: 0, segment: 0, distanceM: 0 }
  const total = cum[cum.length - 1]
  const dd = Math.min(total, Math.max(0, d))
  // binary search for the segment
  let lo = 0
  let hi = path.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= dd) lo = mid
    else hi = mid
  }
  // skip zero-length segments for the heading
  let a = lo
  let b = lo + 1
  while (b < path.length - 1 && cum[b] - cum[a] < 1e-6) b++
  while (a > 0 && cum[b] - cum[a] < 1e-6) a--
  const segLen = cum[lo + 1] - cum[lo]
  const t = segLen > 0 ? (dd - cum[lo]) / segLen : 0
  const p = path[lo]
  const q = path[lo + 1]
  return {
    at: { lat: p.lat + (q.lat - p.lat) * t, lon: p.lon + (q.lon - p.lon) * t },
    headingDeg: bearingDeg(path[a], path[b]),
    segment: lo,
    distanceM: dd,
  }
}

/** The point `m` metres before the end of the path (its start when the path is shorter). */
export function pointBeforeEnd(path: readonly LatLon[], m: number): PathPoint {
  const cum = cumulativeM(path)
  return pointAtDistance(path, cum[cum.length - 1] - m, cum)
}

/** Index of the path vertex nearest to `p`. */
export function nearestVertex(path: readonly LatLon[], p: LatLon): number {
  let best = 0
  let bestD = Infinity
  for (let k = 0; k < path.length; k++) {
    const d = toLocal(path[k], p)
    const dd = d.x * d.x + d.y * d.y
    if (dd < bestD) {
      bestD = dd
      best = k
    }
  }
  return best
}

/** Heading from `p` toward the route ahead: the first vertex after the nearest one that is at least `aheadM` away. */
export function headingAlong(path: readonly LatLon[], p: LatLon, aheadM = 10): number {
  if (path.length < 2) return 0
  for (let k = nearestVertex(path, p); k < path.length; k++) {
    const d = toLocal(path[k], p)
    if (Math.hypot(d.x, d.y) >= aheadM) return dirToHeading(d.x, d.y)
  }
  return bearingDeg(path[path.length - 2], path[path.length - 1])
}
