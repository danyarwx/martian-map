import type { Mobility, MobilityId, RouteProfile } from '../types.ts'

/** Names of the two routes offered for one trip. */
export const ROUTE_LABELS: Record<RouteProfile, string> = { fast: 'Fastest', gentle: 'Gentlest' }

// Planning assumptions, not measurements. Sources for the starting points:
// - Walking: Apollo crews averaged roughly 2-2.5 km/h on foot and worked on slopes up to about 20 degrees
//   with difficulty (Apollo 15-17 mission reports). We take 2.5 km/h and a 20 degree limit.
// - Rover: the Apollo Lunar Roving Vehicle averaged 8-10 km/h and was rated for 20-25 degree slopes.
//   We take 10 km/h and a cautious 15 degree limit.
// - Time outside: 8 h is the usual upper bound for one suited excursion (ISS EVAs run 6.5-8 h).
export const MOBILITY: Record<MobilityId, Mobility> = {
  walk: {
    id: 'walk',
    label: 'On foot',
    flatSpeedKmh: 2.5,
    maxSlopeDeg: 20,
    stopMinutes: 30,
    maxEvaHours: 8,
  },
  rover: {
    id: 'rover',
    label: 'Crew rover',
    flatSpeedKmh: 10,
    maxSlopeDeg: 15,
    stopMinutes: 30,
    maxEvaHours: 8,
  },
}

/**
 * Share of flat-ground speed kept on a slope, 1 on the level down to about 0.28 at 20 degrees.
 * Same shape as Tobler's hiking function, without its downhill bonus: a suited astronaut
 * does not go faster downhill.
 */
export function slopeSpeedFactor(slopeDeg: number): number {
  return Math.exp(-3.5 * Math.tan((slopeDeg * Math.PI) / 180))
}

/** Seconds to cross one metre of ground with this slope, or Infinity when it is a no-go cell. */
export function secondsPerMetre(m: Mobility, slopeDeg: number): number {
  if (slopeDeg > m.maxSlopeDeg) return Infinity
  const metresPerSecond = (m.flatSpeedKmh / 3.6) * slopeSpeedFactor(slopeDeg)
  return 1 / metresPerSecond
}
