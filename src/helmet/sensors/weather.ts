// Weather for the helmet: Perseverance MEDA readings cached by scripts/fetch_weather.py
// (public/data/helmet/weather.json, served at /data/helmet/weather.json), and pure helpers for
// daylight left and the air temperature at an hour of the sol.
import { DAY, temperatureC } from '../../lib/schedule.ts'

/** One sol of MEDA readings, as cached. Only sols with numeric temperatures and pressure are kept. */
export interface WeatherSol {
  sol: number
  /** Earth date, YYYY-MM-DD. */
  terrestrial_date: string
  /** Air temperature, °C. */
  min_temp: number
  max_temp: number
  /** Pa (about 7–9 hPa at Jezero). */
  pressure: number
  /** Local Mars time, "hh:mm:ss", as given by the feed. */
  sunrise: string
  sunset: string
  season: string
  /** Solar longitude, degrees. */
  ls: number | null
}

export interface WeatherCache {
  /** When the cache was written, ISO time. */
  fetched: string
  /** Feed URL. */
  source: string
  credit?: string
  units?: Record<string, string>
  sols: WeatherSol[]
  /** The most recent sol in `sols`. */
  latest: WeatherSol
}

export const WEATHER_URL = '/data/helmet/weather.json'

/** Loads the cached weather. Throws when the file is missing or has no usable sol. */
export async function loadWeather(url: string = WEATHER_URL): Promise<WeatherCache> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`weather: ${url} returned ${res.status}`)
  const data = (await res.json()) as WeatherCache
  if (!data.latest || !Array.isArray(data.sols) || data.sols.length === 0) throw new Error(`weather: ${url} has no sols`)
  return data
}

/** "hh:mm[:ss]" → minutes since midnight. A number is taken as minutes already. NaN if unreadable. */
export function clockToMin(t: string | number): number {
  if (typeof t === 'number') return t
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(t.trim())
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0)
}

/**
 * Minutes of daylight left from `localSolarTime` until sunset; 0 after sunset. Before sunrise it counts
 * the whole coming day (sunrise to sunset). Times are local Mars time, as "hh:mm[:ss]" or minutes since midnight.
 */
export function daylightLeftMin(localSolarTime: string | number, sunrise: string | number, sunset: string | number): number {
  const now = clockToMin(localSolarTime)
  const rise = clockToMin(sunrise)
  const set = clockToMin(sunset)
  return Math.max(0, set - Math.max(now, rise))
}

/**
 * Air temperature at a time of the sol, °C, from the sol's measured minimum and maximum.
 * Same diurnal shape as `temperatureC` in src/lib/schedule.ts (the MEDA typical sol), scaled so the measured
 * extremes can be plugged in: coldest at DAY.coldestAt (just before sunrise), warmest at DAY.warmestAt (mid
 * afternoon). A model, not a reading: MEDA's feed gives only the sol's extremes.
 * @param hour local time in hours (decimal, e.g. 10.5 = 10:30)
 */
export function airTempAt(hour: number, minC: number, maxC: number): number {
  const day = 24 * 60
  const t = (((hour * 60) % day) + day) % day
  // The planner's typical sol (MEDA half-hour medians), stretched so its coldest and warmest points land on
  // this sol's measured minimum and maximum. The helmet and the planner then agree on the shape of the day.
  const share = (temperatureC(t) - DAY.coldestC) / (DAY.warmestC - DAY.coldestC) // 0 coldest, 1 warmest
  return minC + (maxC - minC) * share
}

/** Pressure in hPa, for display. */
export function pressureHpa(pa: number): number {
  return pa / 100
}
