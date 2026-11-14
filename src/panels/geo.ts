// Distance and direction on Mars. Pure functions, no DOM, so they are easy to test.
import type { LatLon } from '../types'

/** Mean Mars radius in metres (IAU). */
export const MARS_RADIUS_M = 3_389_500

const RAD = Math.PI / 180

/** Great-circle distance in metres (haversine on a sphere with Mars's radius). */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a to b, degrees clockwise from north, 0–360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * RAD
  const φ2 = b.lat * RAD
  const Δλ = (b.lon - a.lon) * RAD
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return normDeg(Math.atan2(y, x) / RAD)
}

export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360
}

/** Signed smallest difference a − b, in −180..180. */
export function angleDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

/** Move a point by metres east and north. Accurate over the few km of a Marswalk. */
export function offsetM(p: LatLon, eastM: number, northM: number): LatLon {
  return {
    lat: p.lat + (northM / MARS_RADIUS_M) / RAD,
    lon: p.lon + (eastM / (MARS_RADIUS_M * Math.cos(p.lat * RAD))) / RAD,
  }
}

/** Local flat coordinates in metres (x east, y north) around a reference point. */
export function toLocalM(p: LatLon, ref: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - ref.lon) * RAD * MARS_RADIUS_M * Math.cos(ref.lat * RAD),
    y: (p.lat - ref.lat) * RAD * MARS_RADIUS_M,
  }
}

export function pathLengthM(path: LatLon[]): number {
  let s = 0
  for (let i = 1; i < path.length; i++) s += distanceM(path[i - 1], path[i])
  return s
}

/** The point `d` metres along a path, plus the index of the vertex that comes next. */
export function pointAlong(path: LatLon[], d: number): LatLon & { nextIndex: number } {
  let left = Math.max(0, d)
  for (let i = 1; i < path.length; i++) {
    const seg = distanceM(path[i - 1], path[i])
    if (left <= seg) {
      const t = seg > 0 ? left / seg : 0
      return {
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
        lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * t,
        nextIndex: i,
      }
    }
    left -= seg
  }
  const last = path[path.length - 1]
  return { ...last, nextIndex: path.length - 1 }
}
