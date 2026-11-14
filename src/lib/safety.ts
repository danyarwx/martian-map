// Static "typical conditions" for the safety panel. Each number names its source; none is live.

/**
 * Dose equivalent rate on the Martian surface from galactic cosmic rays, mSv per day.
 * Measured by Curiosity's RAD in Gale crater, 2012-2013: 0.64 +/- 0.12 mSv/day
 * (Hassler et al. 2014, Science 343, 1244797). Jezero has no radiation detector, so the Gale value is used.
 */
export const SURFACE_DOSE_MSV_PER_DAY = 0.64

/** World average natural background dose on Earth, mSv per day (UNSCEAR 2008: 2.4 mSv/year). */
export const EARTH_BACKGROUND_MSV_PER_DAY = 2.4 / 365

/** NASA career limit for astronauts, mSv (NASA-STD-3001 Vol. 1, 2022 revision). */
export const CAREER_LIMIT_MSV = 600

/** Dose picked up during time outside, mSv. Assumes quiet space weather (no solar particle event). */
export function evaDoseMsv(hoursOutside: number): number {
  return (SURFACE_DOSE_MSV_PER_DAY * hoursOutside) / 24
}

/**
 * How long the crew can walk on emergency reserves after a suit or rover failure, minutes.
 * A planning assumption, not a measured Mars value: Apollo's emergency oxygen pack lasted about 30 min
 * at full flow, and current exploration-suit designs aim for about an hour. Apollo planned every traverse
 * so that the crew could always walk back to the lander (the "walk-back limit"); this is the same rule.
 */
export const WALK_BACK_RESERVE_MIN = 60

/** Typical surface conditions at Jezero from Perseverance's MEDA weather station
 * (Rodriguez-Manfredi et al. 2023, Nature Geoscience 16, 19-28). */
export const JEZERO_CONDITIONS = [
  { label: 'Air temperature', value: '−80 to −20 °C', note: 'night to early afternoon' },
  { label: 'Pressure', value: '≈ 7 hPa', note: 'under 1% of Earth sea level' },
  { label: 'Wind', value: '2–10 m/s', note: 'afternoon gusts above 20 m/s' },
  { label: 'Daylight', value: '≈ 12 h', note: 'one sol lasts 24 h 39 min' },
]
