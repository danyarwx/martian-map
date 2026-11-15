// When to leave the habitat, and the clock time of every step of the excursion.
// Times are minutes of local mean solar time (LMST) since midnight; a "minute" here is 1/1440 of a sol.
// The day is a typical sol measured by Perseverance's MEDA weather station (src/data/medaSol.ts, built by
// scripts/fetch_meda.py from NASA PDS data). It is a typical day, not a forecast. Sources:
// - Air temperature and wind: MEDA medians per half hour over sols 120-129.
// - Gust hours: the daytime half hours whose 95th-percentile wind reaches MEDA_GUST_MS. Dust devils are most
//   frequent in the same hours (Newman et al. 2022, Science Advances 8, eabn3783).
// - Daylight: about 12 h at Jezero's latitude (18.4 N); sunrise and sunset shift by under an hour over the year.
// Radiation from galactic cosmic rays does not depend on the time of day, so it plays no part in the choice.
import { MEDA_BIN_MIN, MEDA_GUST_MS, MEDA_SOL, type MedaBin } from '../data/medaSol.ts'
import type { RoutePlan } from '../types.ts'
import { MOBILITY } from './mobility.ts'
import { WALK_BACK_RESERVE_MIN } from './safety.ts'

const SUNRISE = 6 * 60
const SUNSET = 18 * 60
/** Middle of a measured half hour: where its value is placed on the clock. */
const centre = (b: MedaBin) => b.lmst + MEDA_BIN_MIN / 2
const coldest = MEDA_SOL.reduce((a, b) => (b.airC < a.airC ? b : a))
const warmest = MEDA_SOL.reduce((a, b) => (b.airC > a.airC ? b : a))
const gusty = MEDA_SOL.filter((b) => b.gustMs >= MEDA_GUST_MS && b.lmst >= SUNRISE && b.lmst < SUNSET)

export const DAY = {
  sunrise: SUNRISE,
  sunset: SUNSET,
  /** Coldest moment, just before sunrise, and its temperature (measured). */
  coldestAt: centre(coldest),
  coldestC: coldest.airC,
  /** Warmest moment and its temperature (measured). */
  warmestAt: centre(warmest),
  warmestC: warmest.airC,
  /** Hours when gusts and dust devils are most frequent: first to last gusty half hour in daylight. */
  gustsFrom: gusty.length ? gusty[0].lmst : 11 * 60,
  gustsTo: gusty.length ? gusty[gusty.length - 1].lmst + MEDA_BIN_MIN : 15 * 60,
}

/** Leave no earlier than this long after sunrise: light for the first steps. */
const AFTER_SUNRISE_MIN = 30
/** Be back at least this long before sunset: the emergency walk home must also be in daylight. */
const BEFORE_SUNSET_MIN = WALK_BACK_RESERVE_MIN
/** Candidate departure times are this far apart. */
const STEP_MIN = 15

/** A typical-sol value at a time of day: the measured half-hour medians, joined by straight lines. */
function medaAt(minute: number, key: 'airC' | 'windMs' | 'gustMs'): number {
  const day = 24 * 60
  const n = MEDA_SOL.length
  // Position in half hours from the first bin's centre, wrapping around midnight.
  const pos = ((((minute - centre(MEDA_SOL[0])) % day) + day) % day) / MEDA_BIN_MIN
  const i = Math.floor(pos) % n
  const share = pos - Math.floor(pos)
  return MEDA_SOL[i][key] + (MEDA_SOL[(i + 1) % n][key] - MEDA_SOL[i][key]) * share
}

/** Typical air temperature at a time of day, C. */
export function temperatureC(minute: number): number {
  return medaAt(minute, 'airC')
}

/** Typical wind at a time of day, m/s: the half-hour median, and the gusts (95th percentile). */
export function windAt(minute: number): { windMs: number; gustMs: number } {
  return { windMs: medaAt(minute, 'windMs'), gustMs: medaAt(minute, 'gustMs') }
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
