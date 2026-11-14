import { evaDoseMsv } from '../../lib/safety.ts'
import { suitState } from '../sensors/suit.ts'
import { airTempAt, daylightLeftMin, pressureHpa, type WeatherCache } from '../sensors/weather.ts'

interface Props {
  /** Minutes outside so far. */
  elapsedMin: number
  /** Local solar time now, hours. */
  lstHours: number
  weather: WeatherCache | null
  /** Walking minutes back to the habitat from here, or null when unknown. */
  walkBackMin: number | null
}

const hm = (min: number) => {
  const t = Math.round(min)
  return `${Math.floor(t / 60)} h ${String(t % 60).padStart(2, '0')}`
}
const clock = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`

/** What the sensor panel and the warning rules both need from the weather cache at a local solar time. */
export function weatherNow(weather: WeatherCache | null, lstHours: number) {
  const w = weather?.latest
  if (!w) return null
  return {
    sol: w.sol,
    date: w.terrestrial_date,
    airTempC: airTempAt(lstHours, w.min_temp, w.max_temp),
    pressureHpa: pressureHpa(w.pressure),
    daylightLeftMin: daylightLeftMin(lstHours * 60, w.sunrise, w.sunset),
  }
}

/** Suit and sensors (PLAN §7.1). The suit numbers are a model; the weather is Perseverance's latest cached sol. */
export default function SuitPanel({ elapsedMin, lstHours, weather, walkBackMin }: Props) {
  const suit = suitState(elapsedMin)
  const now = weatherNow(weather, lstHours)
  return (
    <div className="helmet-suit">
      <span className="helmet-nav-label" title="Oxygen and EVA time are a planning model, not a measurement (src/helmet/sensors/suit.ts)">
        Suit (simulated)
      </span>
      <dl>
        <div>
          <dt>O₂</dt>
          <dd>{suit.o2Pct.toFixed(0)} %</dd>
        </div>
        <div>
          <dt>EVA left</dt>
          <dd>{hm(suit.evaLeftMin)}</dd>
        </div>
        <div title={`Curiosity RAD surface dose rate, ${evaDoseMsv(24).toFixed(2)} mSv per day`}>
          <dt>Dose</dt>
          <dd>{suit.doseMsv.toFixed(3)} mSv</dd>
        </div>
        <div title="Walking time back to the habitat, from the route planner's slope grid">
          <dt>Walk back</dt>
          <dd>{walkBackMin === null ? 'n/a' : `${Math.round(walkBackMin)} min`}</dd>
        </div>
      </dl>
      <span className="helmet-nav-label" title="Perseverance MEDA, latest sol in the public feed with full readings. Temperature now is modelled between that sol's minimum and maximum">
        {now ? `Weather · MEDA sol ${now.sol} (${now.date})` : 'Weather · no data'}
      </span>
      {now && (
        <dl>
          <div>
            <dt>Local time</dt>
            <dd>{clock(lstHours)}</dd>
          </div>
          <div>
            <dt>Air</dt>
            <dd>{now.airTempC.toFixed(0)} °C</dd>
          </div>
          <div>
            <dt>Pressure</dt>
            <dd>{now.pressureHpa.toFixed(1)} hPa</dd>
          </div>
          <div>
            <dt>Daylight</dt>
            <dd>{hm(Math.max(0, now.daylightLeftMin))}</dd>
          </div>
        </dl>
      )}
    </div>
  )
}
