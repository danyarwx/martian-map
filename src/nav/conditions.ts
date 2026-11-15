// The conditions tiles on the tablet panel: time limits (turn-back, daylight, gust hours) and the
// typical conditions (dose, air, wind). Only the time limits turn amber or red; the thresholds match the
// spoken alerts in alerts.ts. All values come from the typical sol (schedule.ts), not a forecast.
import { evaDoseMsv } from '../lib/safety.ts'
import { clock, DAY, temperatureC, windAt } from '../lib/schedule.ts'
import { duration } from '../lib/format.ts'

/** Turn-back closer than this is amber, minutes. */
export const TURN_BACK_WARN_MIN = 30
/** Daylight left under this is amber, and under the second red, minutes (the spoken daylight alerts). */
export const DAYLIGHT_WARN_MIN = 60
export const DAYLIGHT_BAD_MIN = 30
/** Air changing less than this over the next half hour is "steady", C. */
const STEADY_C = 1
const TREND_AHEAD_MIN = 30

export type ConditionLevel = 'ok' | 'warn' | 'bad'

export interface ConditionTile {
  id: 'turnback' | 'daylight' | 'gusts' | 'dose' | 'air' | 'wind'
  label: string
  value: string
  note?: string
  level: ConditionLevel
}

export interface ConditionsInput {
  /** Mars time now, LMST minutes since midnight. */
  lmst: number
  minutesOut: number
  /** Time still to go, stops included, minutes. */
  routeRemainingMin: number
  /** Latest time to turn back, LMST minutes, null when unknown. */
  turnBackLmst: number | null
  /** On the way home already (the habitat is the next stop, or the crew returned early). */
  returning: boolean
  finished: boolean
}

const celsius = (c: number) => `${c < 0 ? '−' : ''}${Math.abs(Math.round(c))} °C`

export function conditions(i: ConditionsInput): ConditionTile[] {
  const tiles: ConditionTile[] = []

  // Turn back.
  if (i.returning || i.finished) {
    tiles.push({ id: 'turnback', label: 'Turn back', value: i.finished ? 'Home' : 'Heading home', level: 'ok' })
  } else if (i.turnBackLmst === null) {
    tiles.push({ id: 'turnback', label: 'Turn back', value: '—', level: 'ok' })
  } else {
    const left = i.turnBackLmst - i.lmst
    tiles.push({
      id: 'turnback',
      label: 'Turn back',
      value: left > 0.5 ? `in ${duration(left)}` : 'now',
      note: `by ${clock(i.turnBackLmst)}`,
      level: left <= 0.5 ? 'bad' : left < TURN_BACK_WARN_MIN ? 'warn' : 'ok',
    })
  }

  // Daylight.
  const daylight = DAY.sunset - i.lmst
  tiles.push({
    id: 'daylight',
    label: 'Daylight',
    value: daylight > 0 ? duration(daylight) : 'none',
    note: `sunset ${clock(DAY.sunset)}`,
    level: daylight < DAYLIGHT_BAD_MIN ? 'bad' : daylight < DAYLIGHT_WARN_MIN ? 'warn' : 'ok',
  })

  // Gust hours.
  const before = i.lmst < DAY.gustsFrom
  const during = !before && i.lmst < DAY.gustsTo
  tiles.push({
    id: 'gusts',
    label: 'Gust hours',
    value: before ? `in ${duration(DAY.gustsFrom - i.lmst)}` : during ? 'now' : 'over',
    note: `${clock(DAY.gustsFrom)}–${clock(DAY.gustsTo)}`,
    level: during ? 'warn' : 'ok',
  })

  // Radiation: so far and for the whole excursion.
  const tripMin = i.minutesOut + (i.finished ? 0 : i.routeRemainingMin)
  tiles.push({
    id: 'dose',
    label: 'Dose',
    value: `${evaDoseMsv(i.minutesOut / 60).toFixed(2)} mSv`,
    note: `trip ${evaDoseMsv(tripMin / 60).toFixed(2)} mSv`,
    level: 'ok',
  })

  // Air temperature and where it is heading.
  const now = temperatureC(i.lmst)
  const change = temperatureC(i.lmst + TREND_AHEAD_MIN) - now
  tiles.push({
    id: 'air',
    label: 'Air',
    value: celsius(now),
    note: Math.abs(change) < STEADY_C ? 'steady' : change > 0 ? 'rising' : 'falling',
    level: 'ok',
  })

  // Wind.
  const w = windAt(i.lmst)
  tiles.push({ id: 'wind', label: 'Wind', value: `${Math.round(w.windMs)} m/s`, note: `gusts ${Math.round(w.gustMs)} m/s`, level: 'ok' })

  return tiles
}
