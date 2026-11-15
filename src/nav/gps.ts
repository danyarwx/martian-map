// Earth GPS mode: the tablet's real GPS drives the crew arrow, so a walk outside on Earth can be followed
// on the Mars route. Metres walked on Earth become the same metres on Mars: the first fix lands on the
// crew's position at the moment GPS is switched on (the habitat when switched on at the start), and
// north on Earth is north on Mars.
import type { LatLon } from '../types.ts'
import { bearingDeg, localProjection } from './geometry.ts'
import type { PositionFix, PositionSource } from './position.ts'

/** Mean Earth radius, metres (IUGG). */
export const EARTH_RADIUS_M = 6371008.8
/** Fixes less accurate than this are not used, metres: the navigator would think the crew is off route. */
export const GPS_MAX_ACCURACY_M = 50
/** Accuracy worse than this is shown as a warning, metres. */
export const GPS_WARN_ACCURACY_M = 25
/** Below this speed the GPS heading is noise; the direction comes from positions instead, m/s. */
const MIN_HEADING_SPEED = 0.5
/** Positions this far apart give a usable direction of travel, metres. */
const MIN_HEADING_MOVE_M = 3

const RAD = Math.PI / 180

/**
 * Maps Earth positions onto Mars: metres east and north of `earthOrigin` become the same metres east and
 * north of `marsOrigin`. Flat-ground approximation, fine over a few kilometres.
 */
export function earthToMars(earthOrigin: LatLon, marsOrigin: LatLon): (p: LatLon) => LatLon {
  const ky = EARTH_RADIUS_M * RAD
  const kx = ky * Math.cos(earthOrigin.lat * RAD)
  const mars = localProjection(marsOrigin)
  return (p) => mars.toLatLon({ x: (p.lon - earthOrigin.lon) * kx, y: (p.lat - earthOrigin.lat) * ky })
}

export type GpsStatus =
  | { kind: 'waiting' }
  | { kind: 'ok'; accuracyM: number }
  /** Fix received but too inaccurate to use. */
  | { kind: 'weak'; accuracyM: number }
  | { kind: 'error'; message: string }

export interface GpsSourceOptions {
  /** The point on Mars the first Earth fix maps to. */
  anchor: LatLon
  onStatus?: (s: GpsStatus) => void
  /** For tests. Default `navigator.geolocation`. */
  geolocation?: Pick<Geolocation, 'watchPosition' | 'clearWatch'>
}

/** Position source backed by the browser's GPS. Needs HTTPS and the user's permission. */
export class GpsSource implements PositionSource {
  private readonly opts: GpsSourceOptions
  private watchId: number | null = null
  private map: ((p: LatLon) => LatLon) | null = null
  private headingFrom: LatLon | null = null
  private heading = 0

  constructor(opts: GpsSourceOptions) {
    this.opts = opts
  }

  start(cb: (fix: PositionFix) => void): void {
    const geo = this.opts.geolocation ?? globalThis.navigator?.geolocation
    const status = this.opts.onStatus ?? (() => {})
    if (!geo) {
      status({ kind: 'error', message: 'No GPS in this browser' })
      return
    }
    status({ kind: 'waiting' })
    this.watchId = geo.watchPosition(
      (pos) => {
        const c = pos.coords
        if (c.accuracy > GPS_MAX_ACCURACY_M) {
          status({ kind: 'weak', accuracyM: c.accuracy })
          return
        }
        status({ kind: 'ok', accuracyM: c.accuracy })
        const earth = { lat: c.latitude, lon: c.longitude }
        this.map ??= earthToMars(earth, this.opts.anchor)
        const here = this.map(earth)
        const speed = c.speed ?? 0
        if (c.heading !== null && Number.isFinite(c.heading) && speed >= MIN_HEADING_SPEED) {
          this.heading = c.heading
          this.headingFrom = here
        } else if (!this.headingFrom) {
          this.headingFrom = here
        } else if (localDistance(this.headingFrom, here) >= MIN_HEADING_MOVE_M) {
          this.heading = bearingDeg(this.headingFrom, here)
          this.headingFrom = here
        }
        cb({ ...here, headingDeg: this.heading, speedMps: speed, accuracyM: c.accuracy, t: pos.timestamp })
      },
      (err) =>
        status({
          kind: 'error',
          message: err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'No GPS signal',
        }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    )
  }

  stop(): void {
    const geo = this.opts.geolocation ?? globalThis.navigator?.geolocation
    if (this.watchId !== null) geo?.clearWatch(this.watchId)
    this.watchId = null
  }
}

function localDistance(a: LatLon, b: LatLon): number {
  const p = localProjection(a).toXY(b)
  return Math.hypot(p.x, p.y)
}
