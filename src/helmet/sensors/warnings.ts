// Warning rules for the helmet HUD (docs/helmet/PLAN.md §7.1). Pure: the HUD gathers the inputs, this file
// decides which warnings show, how severe they are, and names the data source of each one.
import type { Detection } from '../contracts.ts'
import { MOBILITY } from '../../lib/mobility.ts'
import { WALK_BACK_RESERVE_MIN } from '../../lib/safety.ts'

export type Severity = 'info' | 'caution' | 'danger'

export interface Warning {
  /** Stable per rule, for React keys and to avoid flicker. */
  id: 'hazard-ahead' | 'slope' | 'walk-back' | 'daylight' | 'dose' | 'cold'
  severity: Severity
  /** One line for the HUD. */
  text: string
  /** Where the number comes from, for the tooltip/help. */
  source: string
}

/** Any input may be null when unknown; its rule is then skipped. */
export interface WarningInput {
  /** Distance to the nearest hazard on the guide path ahead, metres. */
  nearestHazardM: number | null
  nearestHazardKind?: Detection['kind'] | null
  /** Slope of the ground under the astronaut's feet, degrees. */
  slopeUnderFootDeg: number | null
  /** Minutes of walking back to the habitat from here. */
  walkBackMin: number | null
  /** Minutes of daylight left (see weather.ts daylightLeftMin). */
  daylightLeftMin: number | null
  /** Dose so far and the dose the planned EVA was expected to take, mSv. */
  doseMsv: number | null
  plannedDoseMsv: number | null
  /** Air temperature at departure, °C (see weather.ts airTempAt). */
  airTempC: number | null
  /** MEDA sol the weather numbers come from, for the source line. */
  weatherSol?: number | null
}

/** A hazard closer than this on the guide path is announced. */
export const HAZARD_AHEAD_M = 15
/** Closer than this, any hazard is a danger. */
export const HAZARD_CLOSE_M = 5
/** Slope under foot above this: caution. Above MOBILITY.walk.maxSlopeDeg (20°): danger, the no-go limit. */
export const SLOPE_CAUTION_DEG = 15
export const SLOPE_NO_GO_DEG = MOBILITY.walk.maxSlopeDeg
/** Daylight must cover the walk back plus this margin, minutes. */
export const DAYLIGHT_MARGIN_MIN = 30
/** Colder than this at departure: caution. */
export const COLD_C = -70

const HAZARD_NAME: Record<Detection['kind'], string> = {
  rock: 'Rock',
  sand: 'Loose sand',
  steep: 'Steep ground',
  drop: 'Drop-off',
}

const RANK: Record<Severity, number> = { danger: 0, caution: 1, info: 2 }

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/** All warnings that apply, most severe first (rule order breaks ties). */
export function evaluateWarnings(input: WarningInput): Warning[] {
  const out: Warning[] = []
  const meda = ok(input.weatherSol) ? `Perseverance MEDA, sol ${input.weatherSol}` : 'Perseverance MEDA'

  if (ok(input.nearestHazardM) && input.nearestHazardM <= HAZARD_AHEAD_M) {
    const kind = input.nearestHazardKind ?? 'rock'
    const severity: Severity = kind === 'drop' || input.nearestHazardM <= HAZARD_CLOSE_M ? 'danger' : 'caution'
    out.push({
      id: 'hazard-ahead',
      severity,
      text: `${HAZARD_NAME[kind]} ahead, ${Math.round(input.nearestHazardM)} m`,
      source: 'Helmet hazard map (stereo cameras), on the guide path',
    })
  }

  if (ok(input.slopeUnderFootDeg) && input.slopeUnderFootDeg > SLOPE_CAUTION_DEG) {
    const noGo = input.slopeUnderFootDeg > SLOPE_NO_GO_DEG
    out.push({
      id: 'slope',
      severity: noGo ? 'danger' : 'caution',
      text: noGo
        ? `Slope ${Math.round(input.slopeUnderFootDeg)}°: over the ${SLOPE_NO_GO_DEG}° walking limit`
        : `Slope ${Math.round(input.slopeUnderFootDeg)}° underfoot`,
      source: `Ground under foot (HiRISE 1 m elevation model); ${SLOPE_NO_GO_DEG}° limit is a planning assumption (src/lib/mobility.ts)`,
    })
  }

  if (ok(input.walkBackMin) && input.walkBackMin > WALK_BACK_RESERVE_MIN) {
    out.push({
      id: 'walk-back',
      severity: 'danger',
      text: `Walk back ${Math.round(input.walkBackMin)} min: beyond the ${WALK_BACK_RESERVE_MIN} min reserve`,
      source: `Walking time to the habitat from the route planner; ${WALK_BACK_RESERVE_MIN} min reserve is a planning assumption (src/lib/safety.ts)`,
    })
  }

  if (ok(input.daylightLeftMin) && ok(input.walkBackMin) && input.daylightLeftMin < input.walkBackMin + DAYLIGHT_MARGIN_MIN) {
    const dark = input.daylightLeftMin < input.walkBackMin
    out.push({
      id: 'daylight',
      severity: dark ? 'danger' : 'caution',
      text: dark
        ? `Sunset before you can walk back (${Math.round(input.daylightLeftMin)} min of light)`
        : `${Math.round(input.daylightLeftMin)} min of daylight: turn back soon`,
      source: `Sunset time from ${meda}; walk-back time from the route planner`,
    })
  }

  if (ok(input.doseMsv) && ok(input.plannedDoseMsv) && input.doseMsv > input.plannedDoseMsv) {
    out.push({
      id: 'dose',
      severity: 'caution',
      text: `Dose ${input.doseMsv.toFixed(2)} mSv: over the planned ${input.plannedDoseMsv.toFixed(2)} mSv`,
      source: 'Dose rate 0.64 mSv/day, Curiosity RAD (Hassler et al. 2014), quiet space weather (src/lib/safety.ts)',
    })
  }

  if (ok(input.airTempC) && input.airTempC < COLD_C) {
    out.push({
      id: 'cold',
      severity: 'caution',
      text: `Air ${Math.round(input.airTempC)} °C at departure: below ${COLD_C} °C`,
      source: `${meda} minimum and maximum air temperature, diurnal model (src/helmet/sensors/weather.ts)`,
    })
  }

  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => RANK[a.w.severity] - RANK[b.w.severity] || a.i - b.i)
    .map(({ w }) => w)
}
