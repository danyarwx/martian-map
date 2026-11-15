// Route following (docs/helmet/PLAN.md §5.8): the active leg's path (LatLon, about 10 m apart) turned into
// a track in local ENU metres with a point every metre, and the questions the helmet asks of it: where on
// the route am I, how far off it, what is the route point N metres ahead, how far to the stop.
// Pure: no three.js, no DOM.
import type { LatLon } from '../../types.ts'
import { dirToHeading, toLocal } from '../frames.ts'

/** A route resampled to a fixed step. Points are local ENU metres (x east, y north). */
export interface RouteTrack {
  /** Number of points. */
  n: number
  x: Float64Array
  y: Float64Array
  /** Distance from the start to each point, metres. `s[k] = k · stepM`, except the last point, which is the route's end. */
  s: Float64Array
  stepM: number
  lengthM: number
}

/** A position on the track. */
export interface TrackPoint {
  x: number
  y: number
  /** Distance from the start of the track, metres (clamped to the track). */
  s: number
  /** Direction of travel there, degrees clockwise from north. */
  headingDeg: number
}

/** Where a position is relative to the track. */
export interface TrackFix extends TrackPoint {
  /** Distance from the position to the nearest point of the track (x, y), metres. */
  distM: number
  /** The same with a sign: positive when the position is to the RIGHT of the direction of travel. */
  lateralM: number
}

/** Resamples a polyline in local ENU metres to one point every `stepM`, plus its exact end. */
export function buildTrackLocal(points: readonly { x: number; y: number }[], stepM = 1): RouteTrack {
  if (points.length === 0) throw new Error('empty route')
  if (!(stepM > 0)) throw new Error('stepM must be positive')
  const xs: number[] = [points[0].x]
  const ys: number[] = [points[0].y]
  const ss: number[] = [0]
  let walked = 0 // length of the polyline before the current segment
  let next = stepM // arc length of the next sample
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]
    const b = points[k]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    while (next <= walked + len) {
      const t = (next - walked) / len
      xs.push(a.x + (b.x - a.x) * t)
      ys.push(a.y + (b.y - a.y) * t)
      ss.push(next)
      next += stepM
    }
    walked += len
  }
  const last = points[points.length - 1]
  if (walked - ss[ss.length - 1] > 1e-6) {
    xs.push(last.x)
    ys.push(last.y)
    ss.push(walked)
  } else {
    // The end falls on a sample: make it the exact end point.
    xs[xs.length - 1] = last.x
    ys[ys.length - 1] = last.y
  }
  return { n: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), s: Float64Array.from(ss), stepM, lengthM: walked }
}

/** The track of a leg path (`RouteLeg.path`) around the session origin. */
export function buildTrack(path: readonly LatLon[], origin: LatLon, stepM = 1): RouteTrack {
  return buildTrackLocal(path.map((p) => toLocal(p, origin)), stepM)
}

/** Heading of the track's segment `k` → `k + 1` (the nearest segment of non-zero length). */
function segmentHeading(t: RouteTrack, k: number): number {
  if (t.n < 2) return 0
  const i = Math.min(Math.max(k, 0), t.n - 2)
  return dirToHeading(t.x[i + 1] - t.x[i], t.y[i + 1] - t.y[i])
}

/** The point `s` metres from the start of the track, clamped to the track. */
export function pointAt(t: RouteTrack, s: number): TrackPoint {
  if (t.n === 1) return { x: t.x[0], y: t.y[0], s: 0, headingDeg: 0 }
  const ss = Math.min(t.lengthM, Math.max(0, s))
  const i = Math.min(t.n - 2, Math.floor(ss / t.stepM))
  const span = t.s[i + 1] - t.s[i]
  const f = span > 0 ? (ss - t.s[i]) / span : 0
  return {
    x: t.x[i] + (t.x[i + 1] - t.x[i]) * f,
    y: t.y[i] + (t.y[i + 1] - t.y[i]) * f,
    s: ss,
    headingDeg: segmentHeading(t, i),
  }
}

/** How far around the hint `locate` looks, metres. */
export const LOCATE_SEARCH_M = 25
/** A hinted fix farther than this from the track is not trusted; the whole track is searched instead. */
export const LOCATE_RETRY_M = 15

/**
 * The point of the track nearest to (x, y).
 *
 * Pass the previous fix's `s` as `hintS` while walking: only the track within ±`searchM` of it is then
 * searched, so the fix cannot jump to another part of a route that comes back near itself, and the call
 * is cheap. Without a hint, or when the hinted search ends more than LOCATE_RETRY_M from the track
 * (a jump), the whole track is searched.
 */
export function locate(t: RouteTrack, x: number, y: number, hintS?: number, searchM = LOCATE_SEARCH_M): TrackFix {
  if (t.n === 1) {
    const d = Math.hypot(x - t.x[0], y - t.y[0])
    return { x: t.x[0], y: t.y[0], s: 0, headingDeg: 0, distM: d, lateralM: d }
  }
  let from = 0
  let to = t.n - 2
  if (hintS !== undefined && Number.isFinite(hintS)) {
    from = Math.max(0, Math.floor((hintS - searchM) / t.stepM))
    to = Math.min(t.n - 2, Math.ceil((hintS + searchM) / t.stepM))
    if (from > to) from = to
  }
  let best = -1
  let bestF = 0
  let bestD2 = Infinity
  for (let i = from; i <= to; i++) {
    const ax = t.x[i]
    const ay = t.y[i]
    const dx = t.x[i + 1] - ax
    const dy = t.y[i + 1] - ay
    const len2 = dx * dx + dy * dy
    let f = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0
    f = f < 0 ? 0 : f > 1 ? 1 : f
    const ex = ax + dx * f - x
    const ey = ay + dy * f - y
    const d2 = ex * ex + ey * ey
    if (d2 < bestD2) {
      bestD2 = d2
      best = i
      bestF = f
    }
  }
  if (hintS !== undefined && (from > 0 || to < t.n - 2) && bestD2 > LOCATE_RETRY_M * LOCATE_RETRY_M) {
    return locate(t, x, y)
  }
  const dx = t.x[best + 1] - t.x[best]
  const dy = t.y[best + 1] - t.y[best]
  const px = t.x[best] + dx * bestF
  const py = t.y[best] + dy * bestF
  const len = Math.hypot(dx, dy) || 1
  // Right of the direction of travel (dx, dy) is (dy, −dx).
  const lateralM = ((x - px) * dy - (y - py) * dx) / len
  return {
    x: px,
    y: py,
    s: t.s[best] + (t.s[best + 1] - t.s[best]) * bestF,
    headingDeg: segmentHeading(t, best),
    distM: Math.sqrt(bestD2),
    lateralM,
  }
}

/** The route point `aheadM` metres farther along the track than `s` (the end of the track when it is nearer). */
export function pointAhead(t: RouteTrack, s: number, aheadM: number): TrackPoint {
  return pointAt(t, s + aheadM)
}

/** Metres of track left after `s`: the distance still to walk to the stop at the end of the leg. */
export function remainingM(t: RouteTrack, s: number): number {
  return Math.max(0, t.lengthM - Math.max(0, s))
}
