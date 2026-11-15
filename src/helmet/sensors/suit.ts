// Suit model for the helmet's sensor panel: oxygen, EVA time left and radiation dose from the minutes spent
// outside. The suit is simulated: every constant below is a PLANNING ASSUMPTION, not a measurement, and the
// panel must say so. The dose uses the measured surface dose rate from src/lib/safety.ts.
import { MOBILITY } from '../../lib/mobility.ts'
import { evaDoseMsv } from '../../lib/safety.ts'

/**
 * ASSUMPTION. Longest planned time outside, minutes: 8 h, the usual upper bound for one suited excursion
 * (ISS EVAs run 6.5–8 h), the same value the route planner uses (`MOBILITY.walk.maxEvaHours`).
 */
export const EVA_LIMIT_MIN = MOBILITY.walk.maxEvaHours * 60

/**
 * ASSUMPTION. Minutes of oxygen in a full primary tank at the planning workload: enough for the 8 h EVA
 * plus a 30 min margin, in the spirit of NASA's EMU (primary O₂ sized for an 8 h EVA with reserve).
 */
export const O2_CAPACITY_MIN = EVA_LIMIT_MIN + 30

/**
 * ASSUMPTION. Oxygen kept back for getting inside, minutes: never planned into the EVA. Same order as
 * the EMU's 30 min secondary oxygen pack.
 */
export const O2_RESERVE_MIN = 30

export interface SuitState {
  /** Primary oxygen left, percent of a full tank (0–100). */
  o2Pct: number
  /** Minutes until the crew must be back inside: the EVA limit or the oxygen above the reserve, whichever ends first. */
  evaLeftMin: number
  /** Dose picked up so far, mSv (quiet space weather). */
  doseMsv: number
}

/**
 * Oxygen left, percent, after `elapsedMin` outside.
 * @param workload oxygen use relative to the planning workload (1 = plan; 1.3 = heavy work)
 */
export function o2Percent(elapsedMin: number, workload = 1): number {
  const used = (Math.max(0, elapsedMin) * workload) / O2_CAPACITY_MIN
  return Math.min(100, Math.max(0, 100 * (1 - used)))
}

/** Minutes left outside: the EVA limit, or the oxygen above the reserve at this workload, whichever comes first. */
export function evaTimeLeftMin(elapsedMin: number, workload = 1): number {
  const t = Math.max(0, elapsedMin)
  const o2LeftMin = (O2_CAPACITY_MIN * o2Percent(t, workload)) / 100 / workload // at the same workload
  return Math.max(0, Math.min(EVA_LIMIT_MIN - t, o2LeftMin - O2_RESERVE_MIN))
}

/** Dose so far, mSv, from the measured surface dose rate (src/lib/safety.ts, Curiosity RAD). */
export function doseSoFarMsv(elapsedMin: number): number {
  return evaDoseMsv(Math.max(0, elapsedMin) / 60)
}

export function suitState(elapsedMin: number, workload = 1): SuitState {
  return {
    o2Pct: o2Percent(elapsedMin, workload),
    evaLeftMin: evaTimeLeftMin(elapsedMin, workload),
    doseMsv: doseSoFarMsv(elapsedMin),
  }
}
