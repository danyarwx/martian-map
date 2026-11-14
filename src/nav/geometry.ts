// Small geometry helpers for navigation on Mars. Routes span a few kilometres, so a flat
// (equirectangular) projection around a nearby point is accurate to well under a metre.
import type { LatLon } from '../types.ts'
import { MARS_RADIUS_M } from '../lib/geo.ts'

const RAD = Math.PI / 180

/** Metres east (x) and north (y) of a projection origin. */
export interface XY {
  x: number
  y: number
}

/** A flat map around `origin`: good for distances and angles within a few kilometres of it. */
export interface Projection {
  toXY(p: LatLon): XY
  toLatLon(xy: XY): LatLon
}

export function localProjection(origin: LatLon): Projection {
  const kx = MARS_RADIUS_M * RAD * Math.cos(origin.lat * RAD)
  const ky = MARS_RADIUS_M * RAD
  return {
    toXY: (p) => ({ x: (p.lon - origin.lon) * kx, y: (p.lat - origin.lat) * ky }),
    toLatLon: ({ x, y }) => ({ lat: origin.lat + y / ky, lon: origin.lon + x / kx }),
  }
}

/** Compass bearing from `a` to `b`, degrees clockwise from north, in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const p = localProjection(a).toXY(b)
  const deg = Math.atan2(p.x, p.y) / RAD
  return (deg + 360) % 360
}

/**
 * Signed change of direction from bearing `from` to bearing `to`, degrees in (-180, 180].
 * Positive is a turn to the right (clockwise), negative to the left.
 */
export function turnAngle(from: number, to: number): number {
  let d = (((to - from) % 360) + 360) % 360
  if (d > 180) d -= 360
  return d
}

/** Distance along a path at each of its points, metres, starting at 0. */
export function cumulativeM(path: LatLon[]): number[] {
  const out = [0]
  for (let k = 1; k < path.length; k++) {
    const a = localProjection(path[k - 1]).toXY(path[k])
    out.push(out[k - 1] + Math.hypot(a.x, a.y))
  }
  return out
}

/** Where a position falls on a path. */
export interface PathProjection {
  /** Index of the segment from path[segmentIndex] to path[segmentIndex + 1]. */
  segmentIndex: number
  /** Share of that segment before the projected point, 0 to 1. */
  t: number
  /** Distance along the path to the projected point, metres. */
  alongM: number
  /** Distance from the position to the path, metres. */
  offsetM: number
  /** Which side of the path the position is on, looking along the path. */
  side: 'left' | 'right' | 'on'
  pointOnLine: LatLon
}

/**
 * Nearest point of the path to `p`, looking only at segments `fromSegment` to `toSegment` (inclusive).
 * `cum` is `cumulativeM(path)`; pass it in when projecting many positions onto the same path.
 */
export function projectOntoPath(
  path: LatLon[],
  p: LatLon,
  cum: number[] = cumulativeM(path),
  fromSegment = 0,
  toSegment = path.length - 2,
): PathProjection {
  const proj = localProjection(p)
  if (path.length === 1) {
    const a = proj.toXY(path[0])
    return { segmentIndex: 0, t: 0, alongM: 0, offsetM: Math.hypot(a.x, a.y), side: 'on', pointOnLine: path[0] }
  }
  const lo = Math.max(0, fromSegment)
  const hi = Math.min(path.length - 2, toSegment)
  let best: PathProjection | null = null
  let bestCross = 0
  for (let k = lo; k <= hi; k++) {
    const a = proj.toXY(path[k])
    const b = proj.toXY(path[k + 1])
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    // The position is the origin of the projection, so p - a is simply -a.
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (-a.x * dx - a.y * dy) / len2))
    const qx = a.x + t * dx
    const qy = a.y + t * dy
    const offsetM = Math.hypot(qx, qy)
    if (best && offsetM >= best.offsetM) continue
    best = {
      segmentIndex: k,
      t,
      alongM: cum[k] + t * (cum[k + 1] - cum[k]),
      offsetM,
      side: 'on',
      pointOnLine: proj.toLatLon({ x: qx, y: qy }),
    }
    // Cross product of the segment direction and (p - a): positive when p lies to the left.
    bestCross = dx * -a.y - dy * -a.x
  }
  const out = best!
  if (out.offsetM > 0.01) out.side = bestCross > 0 ? 'left' : 'right'
  return out
}

/** The point at `alongM` metres along the path, clamped to its ends. */
export function pointAlong(path: LatLon[], cum: number[], alongM: number): LatLon {
  if (alongM <= 0) return path[0]
  const last = path.length - 1
  if (alongM >= cum[last]) return path[last]
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= alongM) lo = mid
    else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const t = span === 0 ? 0 : (alongM - cum[lo]) / span
  return {
    lat: path[lo].lat + t * (path[hi].lat - path[lo].lat),
    lon: path[lo].lon + t * (path[hi].lon - path[lo].lon),
  }
}

/** Bearing of the path between two distances along it, degrees. Smooths out small wiggles. */
export function bearingAlong(path: LatLon[], cum: number[], fromM: number, toM: number): number {
  return bearingDeg(pointAlong(path, cum, fromM), pointAlong(path, cum, toM))
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

/** Bearing as one of eight compass directions, e.g. "north-east". */
export function compassName(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

/**
 * Douglas–Peucker simplification: keeps the points needed to stay within `toleranceM` of the path.
 * Returns the indices of the kept points, always including the first and the last.
 */
export function simplifyPath(path: LatLon[], toleranceM: number): number[] {
  if (path.length <= 2) return path.map((_, i) => i)
  const proj = localProjection(path[0])
  const xy = path.map((p) => proj.toXY(p))
  const keep = new Uint8Array(path.length)
  keep[0] = 1
  keep[path.length - 1] = 1
  const stack: [number, number][] = [[0, path.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    const dx = xy[b].x - xy[a].x
    const dy = xy[b].y - xy[a].y
    const len = Math.hypot(dx, dy)
    let far = -1
    let farD = toleranceM
    for (let k = a + 1; k < b; k++) {
      const px = xy[k].x - xy[a].x
      const py = xy[k].y - xy[a].y
      const d = len === 0 ? Math.hypot(px, py) : Math.abs(dx * py - dy * px) / len
      if (d > farD) {
        farD = d
        far = k
      }
    }
    if (far < 0) continue
    keep[far] = 1
    stack.push([a, far], [far, b])
  }
  const out: number[] = []
  keep.forEach((v, i) => v && out.push(i))
  return out
}
