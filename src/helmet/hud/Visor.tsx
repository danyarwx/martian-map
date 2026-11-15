// The visor HUD (FIXLIST C1, C2): thin glowing line symbols as if projected on the helmet glass. No panels.
// On screen all the time: heading tape, warnings (two at most), next stop with distance and turn, and two small
// gauges (oxygen, time left outside). Everything else opens with a key (HelmetView).
import type { ReactNode } from 'react'
import { EVA_LIMIT_MIN, suitState } from '../sensors/suit.ts'
import type { Severity } from '../sensors/warnings.ts'

const NAMES: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
/** Degrees shown either side of the heading, and the tape's size in SVG units. */
const SPAN = 50
const TAPE_W = 460
const TAPE_H = 66

const rel = (deg: number, heading: number) => ((deg - heading + 540) % 360) - 180
const tapeX = (r: number) => TAPE_W / 2 + (r / SPAN) * (TAPE_W / 2 - 14)
/** The tape bends down toward its ends, like a line on curved glass. */
const tapeY = (r: number) => 22 + (r / SPAN) ** 2 * 7

interface TapeProps {
  headingDeg: number
  /** Bearing of the next stop, degrees clockwise from north, or null. */
  stopBearingDeg: number | null
  /** Heading the guide says to follow, or null. */
  steerDeg: number | null
}

/** Heading tape: a tick every 5°, a label every 15°, a diamond for the next stop, a chevron for the guide. */
export function HeadingTape({ headingDeg, stopBearingDeg, steerDeg }: TapeProps) {
  const ticks: ReactNode[] = []
  const first = Math.ceil((headingDeg - SPAN) / 5) * 5
  for (let d = first; d <= headingDeg + SPAN; d += 5) {
    const r = d - headingDeg
    const deg = ((d % 360) + 360) % 360
    const x = tapeX(r)
    const y = tapeY(r)
    const major = deg % 15 === 0
    const fade = 1 - (Math.abs(r) / SPAN) ** 3
    ticks.push(<line key={`t${d}`} x1={x} y1={y} x2={x} y2={y + (major ? 9 : 5)} opacity={fade} />)
    if (major)
      ticks.push(
        <text key={`l${d}`} x={x} y={y + 22} opacity={fade} className={NAMES[deg] ? 'is-named' : undefined}>
          {NAMES[deg] ?? String(deg).padStart(3, '0')}
        </text>,
      )
  }
  const mark = (deg: number | null, kind: 'stop' | 'guide') => {
    if (deg === null) return null
    const r = rel(deg, headingDeg)
    const c = Math.max(-SPAN, Math.min(SPAN, r))
    const x = tapeX(c)
    const y = tapeY(c) - 4
    if (c !== r) {
      // off the tape: an arrowhead at the end, pointing that way
      const s = r < 0 ? -1 : 1
      return <path className={`visor-mark is-${kind}`} d={`M${x + s * 8} ${y - 3} L${x + s * 14} ${y + 2} L${x + s * 8} ${y + 7}`} />
    }
    return kind === 'stop' ? (
      <path className="visor-mark is-stop" d={`M${x} ${y - 9} L${x + 5} ${y - 4} L${x} ${y + 1} L${x - 5} ${y - 4} Z`} />
    ) : (
      <path className="visor-mark is-guide" d={`M${x - 6} ${y - 7} L${x} ${y - 1} L${x + 6} ${y - 7}`} />
    )
  }
  const hdg = String(Math.round(headingDeg) % 360).padStart(3, '0')
  return (
    <svg className="visor-tape" viewBox={`0 0 ${TAPE_W} ${TAPE_H}`} role="img" aria-label={`Heading ${hdg} degrees`}>
      <path className="visor-tape-line" d={`M${tapeX(-SPAN)} ${tapeY(-SPAN)} Q${TAPE_W / 2} ${22 - 7} ${tapeX(SPAN)} ${tapeY(SPAN)}`} />
      {ticks}
      {mark(stopBearingDeg, 'stop')}
      {mark(steerDeg, 'guide')}
      <path className="visor-tape-caret" d={`M${TAPE_W / 2 - 5} 4 L${TAPE_W / 2} 11 L${TAPE_W / 2 + 5} 4`} />
      <text className="visor-tape-heading" x={TAPE_W / 2} y={TAPE_H - 3}>
        {hdg}
      </text>
    </svg>
  )
}

export interface VisorWarning {
  id: string
  severity: Severity
  text: string
  source?: string
}

/** Warnings under the tape: most severe first, two at most (a wall of alerts teaches people to ignore them). */
export function Warnings({ items }: { items: VisorWarning[] }) {
  const rank: Record<Severity, number> = { danger: 0, caution: 1, info: 2 }
  const shown = [...items].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 2)
  return (
    <div className="visor-warnings" aria-live="assertive">
      {shown.map((w) => (
        <p key={w.id} className={`is-${w.severity}`} title={w.source}>
          {w.severity !== 'info' && (
            <svg viewBox="0 0 16 14" width="13" height="12" aria-hidden="true">
              <path d="M8 1.5 L15 12.5 H1 Z M8 5.5 V9 M8 10.6 V11" />
            </svg>
          )}
          {w.text}
        </p>
      ))}
      {items.length > shown.length && <p className="visor-more">+{items.length - shown.length} more · hold Tab</p>}
    </div>
  )
}

interface NextStopProps {
  name: string
  arrived: boolean
  remainingM: number
  offRouteM: number
  /** Where to turn relative to where the astronaut looks, degrees (negative = left), or null. */
  turnDeg: number | null
}

/** Next stop, distance, and which way to turn. */
export function NextStop({ name, arrived, remainingM, offRouteM, turnDeg }: NextStopProps) {
  const dist = remainingM >= 1000 ? `${(remainingM / 1000).toFixed(2)} km` : `${Math.round(remainingM)} m`
  return (
    <div className="visor-next">
      <span className="visor-label">{arrived ? 'Arrived' : 'Next stop'}</span>
      <span className="visor-next-name">{name}</span>
      <span className="visor-next-row">
        <strong>{dist}</strong>
        {turnDeg !== null && !arrived && (
          <span className="visor-turn" aria-label={`Guide: turn ${Math.round(Math.abs(turnDeg))} degrees ${turnDeg < 0 ? 'left' : 'right'}`}>
            <svg viewBox="0 0 20 28" width="12" height="17" style={{ transform: `rotate(${turnDeg}deg)` }} aria-hidden="true">
              <path d="M10 2 L17 12 M10 2 L3 12 M10 2 V26" />
            </svg>
            {Math.abs(turnDeg) < 8 ? 'on the guide' : `${Math.round(Math.abs(turnDeg))}° ${turnDeg < 0 ? 'left' : 'right'}`}
          </span>
        )}
      </span>
      {offRouteM > 15 && <span className="visor-off">{Math.round(offRouteM)} m off the route</span>}
    </div>
  )
}

interface GaugeProps {
  /** 0..1 of the arc filled. */
  fraction: number
  value: string
  label: string
  title: string
  side: 'left' | 'right'
}

/** A 240° arc with one number in it. Amber under 30 %, red under 15 %. */
function Gauge({ fraction, value, label, title, side }: GaugeProps) {
  const f = Math.max(0, Math.min(1, fraction))
  const R = 34
  const sweep = 240
  const a0 = 150
  const pt = (deg: number) => [50 + R * Math.cos((deg * Math.PI) / 180), 50 + R * Math.sin((deg * Math.PI) / 180)]
  const arc = (to: number) => {
    const [x0, y0] = pt(a0)
    const [x1, y1] = pt(a0 + to)
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${to > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
  }
  const level = f < 0.15 ? 'is-danger' : f < 0.3 ? 'is-caution' : ''
  return (
    <div className={`visor-gauge is-${side} ${level}`} title={title}>
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${value}`}>
        <path className="visor-gauge-track" d={arc(sweep)} />
        {f > 0.004 && <path className="visor-gauge-fill" d={arc(sweep * f)} />}
        <text x="50" y="55" className="visor-gauge-value">
          {value}
        </text>
        <text x="50" y="74" className="visor-gauge-label">
          {label}
        </text>
      </svg>
    </div>
  )
}

/** Oxygen and time left outside. Both are a planning model, not a measurement (sensors/suit.ts). */
export function Gauges({ elapsedMin }: { elapsedMin: number }) {
  const suit = suitState(elapsedMin)
  const left = Math.max(0, Math.round(suit.evaLeftMin))
  return (
    <>
      <Gauge side="left" fraction={suit.o2Pct / 100} value={suit.o2Pct.toFixed(0)} label="O₂ %" title="Oxygen left: a planning model, not a measurement" />
      <Gauge
        side="right"
        fraction={suit.evaLeftMin / EVA_LIMIT_MIN}
        value={`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
        label="EVA left"
        title="Time left outside (hours:minutes): a planning model, not a measurement"
      />
    </>
  )
}

/** The glass itself: a vignette, a faint reflection and two thin frame arcs. */
export function VisorGlass() {
  return (
    <div className="visor-glass" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M3 10 Q50 2.5 97 10" />
        <path d="M3 91 Q50 98 97 91" />
      </svg>
    </div>
  )
}
