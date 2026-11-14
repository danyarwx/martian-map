// The scripted demo walk for the helmet view: habitat → two rover stops → Cheyava Falls.
// Stop positions and panoramas are real Perseverance data from public/data/M20_waypoints.json.
// The habitat and the boulder field are invented for the demo story.
import type { Hazard, LatLon, Stop, SuitStatus } from '../types'
import { distanceM, offsetM, pathLengthM, pointAlong, toLocalM } from './geo'

const PANO_BASE = 'https://mars.nasa.gov/mmgis-maps/M20/'

export const HABITAT: Stop = { id: 'hab', name: 'Habitat', kind: 'habitat', lat: 18.4905, lon: 77.3072 } // invented

export const STOP_1: Stop = {
  id: 'sol-1224', name: 'Stop 1', kind: 'stop', sol: 1224, tiltDeg: 3.5,
  lat: 18.49299917, lon: 77.30323824,
  panorama: { url: 'Layers/mosaics/N_LRGB_1224_RZS_0561998_CYL_L_AUTOGENJ01.jpg', columns: 9292, rows: 2073, elZeroRow: 351.25 },
}

export const STOP_2: Stop = {
  id: 'sol-1219', name: 'Stop 2', kind: 'stop', sol: 1219, tiltDeg: 1.1,
  lat: 18.4959853, lon: 77.30369792,
  panorama: { url: 'Layers/mosaics/N_LRGB_1219_RZS_0560784_CYL_L_AUTOGENJ02.jpg', columns: 9292, rows: 2033, elZeroRow: 310.701 },
}

export const CHEYAVA_FALLS: Stop = {
  id: 'sol-1210', name: 'Cheyava Falls', kind: 'target', sol: 1210, tiltDeg: 17.0,
  lat: 18.49748444, lon: 77.30519089,
  panorama: { url: 'Layers/mosaics/N_LRGB_1210_RZS_0560000_CYL_L_AUTOGENJ03.jpg', columns: 9292, rows: 2542, elZeroRow: 543.438 },
}

export const STOPS: Stop[] = [HABITAT, STOP_1, STOP_2, CHEYAVA_FALLS]
export const PLANNED_ROUTE: LatLon[] = STOPS.map(({ lat, lon }) => ({ lat, lon }))

/** The boulder field the helmet "sees": 55% of the way from Stop 1 to Stop 2. Invented for the demo. */
export const SCRIPTED_HAZARD: Hazard = {
  id: 'helmet-boulders-1',
  ...interpolate(STOP_1, STOP_2, 0.55),
  radiusM: 18,
  kind: 'rock',
  source: 'helmet',
  confidence: 0.8,
  label: 'Boulder field, not on the orbital map',
}

/** The helmet notices the boulders when it is this close. */
export const DETECTION_RANGE_M = 32

/** Panorama files: local copy first (scripts/fetch_panoramas.sh), then NASA's server. */
export function panoramaSources(stop: Stop): string[] {
  if (!stop.panorama) return []
  const file = stop.panorama.url.split('/').pop()
  return [`/data/panoramas/${file}`, PANO_BASE + stop.panorama.url]
}

/** The rover stop with a panorama nearest to a point. */
export function nearestPanoramaStop(p: LatLon): Stop {
  let best = STOP_1
  for (const s of STOPS) if (s.panorama && distanceM(p, s) < distanceM(p, best)) best = s
  return best
}

/**
 * Simple stand-in for the real route planner: walk around a hazard on its east side,
 * keeping the path already walked. Returns the new full route (same start, same end).
 */
export function detourAround(route: LatLon[], walkedM: number, hazard: Hazard): LatLon[] {
  const here = pointAlong(route, walkedM)
  const rejoin = route[here.nextIndex]
  const ref = here
  const a = toLocalM(here, ref)
  const b = toLocalM(rejoin, ref)
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  // right-hand normal of the walking direction (east-ish when walking north)
  const nx = uy
  const ny = -ux
  const clear = hazard.radiusM + 25
  const h = toLocalM(hazard, ref)
  const p1 = offsetM(ref, h.x + nx * clear - ux * clear * 0.4, h.y + ny * clear - uy * clear * 0.4)
  const p2 = offsetM(ref, h.x + nx * clear + ux * clear * 0.8, h.y + ny * clear + uy * clear * 0.8)
  return [...route.slice(0, here.nextIndex), { lat: here.lat, lon: here.lon }, p1, p2, ...route.slice(here.nextIndex)]
}

// ---- suit model (example values, except the radiation rate) ----

/** Suited walking pace in m/s (about 3.2 km/h). Example value. */
export const WALK_SPEED_MPS = 0.9
/** EVA length and oxygen supply. Example values. */
export const EVA_SECONDS = 6 * 3600
export const OXYGEN_SECONDS = 8 * 3600
/**
 * Surface dose-equivalent rate measured by Curiosity's RAD: 0.64 mSv/day
 * (Hassler et al., Science 2014). In µSv per hour that is 640 / 24 ≈ 26.7.
 */
export const DOSE_RATE_USV_PER_H = 640 / 24
/** Example one-way light delay to Earth. It really varies from about 4 to 24 minutes. */
export const EARTH_DELAY_MIN = 13

export function suitStatusAt(simSeconds: number): SuitStatus {
  return {
    oxygenPct: Math.max(0, 100 - (simSeconds / OXYGEN_SECONDS) * 100),
    evaSecondsLeft: Math.max(0, EVA_SECONDS - simSeconds),
    doseMicroSv: (DOSE_RATE_USV_PER_H * simSeconds) / 3600,
  }
}

export const PLANNED_LENGTH_M = pathLengthM(PLANNED_ROUTE)

function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }
}
