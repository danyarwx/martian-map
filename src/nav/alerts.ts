// Spoken safety lines that depend on the Mars time of day, and the status readout.
// Times are minutes of local mean solar time (LMST) since midnight, as in src/lib/schedule.ts.
import { clock, DAY } from '../lib/schedule.ts'
import type { NavPriority } from './events.ts'

export interface TimeAlert {
  id: string
  /** Minute of the day at which it is said. */
  at: number
  text: string
  priority: NavPriority
}

/** The day's alerts, in time order. Gust hours and sunset come from the typical-sol model in schedule.ts. */
export const TIME_ALERTS: TimeAlert[] = [
  {
    id: 'gusts-soon',
    at: DAY.gustsFrom - 15,
    text: `Gust hours start in 15 minutes. Expect strong gusts and dust devils until ${clock(DAY.gustsTo)}.`,
    priority: 'normal',
  },
  {
    id: 'gusts-now',
    at: DAY.gustsFrom,
    text: 'Gust hours now. Watch your footing and keep clear of dust devils.',
    priority: 'normal',
  },
  { id: 'gusts-over', at: DAY.gustsTo, text: 'Gust hours over.', priority: 'low' },
  { id: 'daylight-60', at: DAY.sunset - 60, text: 'One hour of daylight left.', priority: 'normal' },
  {
    id: 'daylight-30',
    at: DAY.sunset - 30,
    text: 'Thirty minutes of daylight left. Head for the habitat.',
    priority: 'high',
  },
]

/** Alerts whose time falls after `fromLmst` and up to `toLmst`. */
export function timeAlertsBetween(fromLmst: number, toLmst: number): TimeAlert[] {
  return TIME_ALERTS.filter((a) => a.at > fromLmst && a.at <= toLmst)
}

/** A duration as a voice says it: "45 minutes", "1 hour 20 minutes", "2 hours". */
export function saidDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  const hours = h === 0 ? '' : `${h} hour${h === 1 ? '' : 's'}`
  const mins = m === 0 && h > 0 ? '' : `${m} minute${m === 1 ? '' : 's'}`
  return [hours, mins].filter(Boolean).join(' ')
}

export interface StatusInput {
  /** Minutes since leaving the habitat (mission time). */
  minutesOut: number
  /** Minutes on foot straight back to the habitat, null when unknown. */
  walkHomeMin: number | null
  lmst: number
  /** Air temperature now, C (typical-sol model). */
  tempC: number
  /** Radiation dose picked up so far, mSv. */
  doseMsv: number
}

/** The status readout: "Status. Mars time 10:45. Out 1 hour 20 minutes. ..." */
export function statusText(s: StatusInput): string {
  const t = Math.round(s.tempC)
  const air = t < 0 ? `minus ${-t}` : `${t}`
  const dose = s.doseMsv < 0.01 ? 'under 0.01' : s.doseMsv.toFixed(2)
  const home = s.walkHomeMin === null ? '' : ` Habitat ${saidDuration(s.walkHomeMin)} on foot.`
  return `Status. Mars time ${clock(s.lmst)}. Out ${saidDuration(s.minutesOut)}.${home} Air ${air} degrees. Dose ${dose} millisieverts.`
}
