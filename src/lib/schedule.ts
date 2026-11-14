// When to leave the habitat, and the clock time of every step of the excursion.
// Times are minutes of local mean solar time (LMST) since midnight; a "minute" here is 1/1440 of a sol.
// The day model is built from typical published values and is not live. Sources:
// - Daylight: about 12 h at Jezero's latitude (18.4 N); sunrise and sunset shift by under an hour over the year.
// - Air temperature: about -80 C before sunrise to about -20 C in the early afternoon
//   (Perseverance MEDA, Rodriguez-Manfredi et al. 2023, Nature Geoscience 16).
// - Gusts and dust devils: most frequent around midday, when the ground is hottest
//   (Perseverance MEDA, Newman et al. 2022, Science Advances 8, eabn3783).
// Radiation from galactic cosmic rays does not depend on the time of day, so it plays no part in the choice.
import type { RoutePlan } from '../types.ts'
import { MOBILITY } from './mobility.ts'
import { WALK_BACK_RESERVE_MIN } from './safety.ts'

export const DAY = {
  sunrise: 6 * 60,
  sunset: 18 * 60,
  /** Coldest moment, just before sunrise, and its temperature. */
  coldestAt: 5.5 * 60,
  coldestC: -80,
  /** Warmest moment and its temperature. */
  warmestAt: 14 * 60,
  warmestC: -20,
  /** Hours when gusts and dust devils are most frequent. */
  gustsFrom: 11 * 60,
  gustsTo: 15 * 60,
}

/** Leave no earlier than this long after sunrise: light for the first steps. */
const AFTER_SUNRISE_MIN = 30
/** Be back at least this long before sunset: the emergency walk home must also be in daylight. */
const BEFORE_SUNSET_MIN = WALK_BACK_RESERVE_MIN
/** Candidate departure times are this far apart. */
const STEP_MIN = 15

/** Typical air temperature at a time of day, C: a smooth rise to the afternoon peak and a slower fall through the night. */
export function temperatureC(minute: number): number {
  const day = 24 * 60
  const t = ((minute % day) + day) % day
  const { coldestAt, coldestC, warmestAt, warmestC } = DAY
  const rising = t >= coldestAt && t <= warmestAt
  const span = rising ? warmestAt - coldestAt : day - (warmestAt - coldestAt)
  const into = rising ? t - coldestAt : (t - warmestAt + day) % day
  const share = (1 - Math.cos((Math.PI * into) / span)) / 2 // 0 at the start of the stretch, 1 at its end
  return rising ? coldestC + (warmestC - coldestC) * share : warmestC + (coldestC - warmestC) * share
}

export interface DepartureOption {
  /** Minute of the day the crew leaves the habitat. */
  start: number
  end: number
  /** False when the excursion does not fit between sunrise and sunset with the margins. */
  inDaylight: boolean
  /** Minutes of the excursion inside the midday gust hours. */
  gustMinutes: number
  /** Mean air temperature over the excursion, C. */
  meanC: number
  /** Coldest and warmest air temperature met, C. */
  minC: number
  maxC: number
  /** Daylight left after getting back, minutes. May be negative. */
  daylightLeft: number
  /** Lower is better. Only comparable between options for the same excursion. */
  score: number
}

/** What one departure time means for an excursion of this length. */
export function assessDeparture(start: number, durationMin: number): DepartureOption {
  const end = start + durationMin
  const gustMinutes = Math.max(0, Math.min(end, DAY.gustsTo) - Math.max(start, DAY.gustsFrom))
  let sum = 0
  let minC = Infinity
  let maxC = -Infinity
  let n = 0
  for (let t = start; t <= end; t += 5) {
    const c = temperatureC(t)
    sum += c
    minC = Math.min(minC, c)
    maxC = Math.max(maxC, c)
    n++
  }
  const meanC = sum / n
  const daylightLeft = DAY.sunset - end
  const inDaylight = start >= DAY.sunrise + AFTER_SUNRISE_MIN && daylightLeft >= BEFORE_SUNSET_MIN
  // Three things to keep small, each scaled to 0..1: time in the gust hours (weighs most, it is the
  // one hazard that changes with the hour), how cold the suit has to work, and a thin daylight margin.
  const gusts = durationMin > 0 ? gustMinutes / durationMin : 0
  const cold = (DAY.warmestC - meanC) / (DAY.warmestC - DAY.coldestC)
  const margin = 1 - Math.min(Math.max(daylightLeft, 0), 240) / 240
  const score = 0.5 * gusts + 0.3 * cold + 0.2 * margin + (inDaylight ? 0 : 10)
  return { start, end, inDaylight, gustMinutes, meanC, minC, maxC, daylightLeft, score }
}

/** The best time to leave for an excursion of this length, among times every quarter of an hour. */
export function bestDeparture(durationMin: number): DepartureOption {
  let best = assessDeparture(DAY.sunrise + AFTER_SUNRISE_MIN, durationMin)
  for (let start = DAY.sunrise + AFTER_SUNRISE_MIN; start + durationMin <= DAY.sunset; start += STEP_MIN) {
    const option = assessDeparture(start, durationMin)
    if (option.score < best.score) best = option
  }
  return best
}

export interface TimelineStep {
  /** Minute of the day. */
  at: number
  kind: 'leave' | 'arrive' | 'return'
  /** Stop reached, for 'arrive'. */
  stopId?: string
  /** For 'arrive': when the crew moves on. */
  leaveAt?: number
}

/** Clock times of the plan when the crew leaves the habitat at `start`. */
export function timeline(plan: RoutePlan, start: number): TimelineStep[] {
  const work = MOBILITY[plan.mobility].stopMinutes
  const steps: TimelineStep[] = [{ at: start, kind: 'leave' }]
  let t = start
  plan.legs.forEach((leg, i) => {
    t += leg.minutes
    if (i === plan.legs.length - 1) {
      steps.push({ at: t, kind: 'return' })
      return
    }
    steps.push({ at: t, kind: 'arrive', stopId: leg.toId, leaveAt: t + work })
    t += work
  })
  return steps
}

/** The farthest point of the route from the habitat by walking time, or null when that was not computed. */
export function farthestWalkHome(plan: RoutePlan): { minutes: number; legIndex: number } | null {
  let best: { minutes: number; legIndex: number } | null = null
  plan.legs.forEach((leg, legIndex) => {
    for (const minutes of leg.walkHomeMin) {
      if (Number.isFinite(minutes) && (!best || minutes > best.minutes)) best = { minutes, legIndex }
    }
  })
  return best
}

/**
 * Latest minute of the day to turn back from the farthest point and still be home in time: by the end of
 * the longest allowed excursion and by sunset. Null when the walk-back times were not computed.
 */
export function turnBackBy(plan: RoutePlan, start: number): number | null {
  const farthest = farthestWalkHome(plan)
  if (!farthest) return null
  const homeBy = Math.min(start + MOBILITY[plan.mobility].maxEvaHours * 60, DAY.sunset)
  return homeBy - farthest.minutes
}

/** Minute of the day as HH:MM. */
export function clock(minute: number): string {
  const day = 24 * 60
  const t = ((Math.round(minute) % day) + day) % day
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}
