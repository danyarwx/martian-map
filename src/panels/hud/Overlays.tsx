import type { ReactElement } from 'react'
import type { Hazard, LatLon, Stop, SuitStatus } from '../../types'
import { angleDiff, bearingDeg, distanceM, normDeg } from '../geo'
import { DOSE_RATE_USV_PER_H, EARTH_DELAY_MIN } from '../walkScript'

type View = { headingDeg: number; fovDeg: number; width: number; height: number; horizonY: number }

const CARDINALS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }

/** Screen x of a bearing, or null when it is outside the visor. */
function screenX(bearing: number, v: View, margin = 0): number | null {
  const d = angleDiff(bearing, v.headingDeg)
  if (Math.abs(d) > v.fovDeg / 2 - margin) return null
  return v.width / 2 + (d / v.fovDeg) * v.width
}

/** Heading tape along the top of the visor. */
export function Compass(v: View) {
  const ticks: ReactElement[] = []
  const start = Math.ceil((v.headingDeg - v.fovDeg / 2) / 5) * 5
  for (let a = start; a <= v.headingDeg + v.fovDeg / 2; a += 5) {
    const n = normDeg(a)
    const x = v.width / 2 + ((a - v.headingDeg) / v.fovDeg) * v.width
    const major = n % 45 === 0
    ticks.push(
      <g key={a}>
        <line x1={x} x2={x} y1={major ? 22 : 28} y2={34} />
        {major && <text x={x} y={15} textAnchor="middle">{CARDINALS[n]}</text>}
      </g>,
    )
  }
  return (
    <g className="hud-compass">
      <rect x={0} y={0} width={v.width} height={34} className="hud-compass-bg" />
      {ticks}
      <path d={`M${v.width / 2 - 6},42 L${v.width / 2 + 6},42 L${v.width / 2},35 Z`} className="hud-fill-fg" />
      <text x={v.width / 2} y={56} textAnchor="middle" className="hud-compass-heading">
        {String(Math.round(normDeg(v.headingDeg))).padStart(3, '0')}°
      </text>
    </g>
  )
}

/** Diamond markers for the target and the next stop; an edge arrow when they are behind or to the side. */
export function WorldMarkers({ view, pose, target, next }: { view: View; pose: LatLon; target: Stop; next: Stop | null }) {
  const items = [{ stop: target, big: true }, ...(next && next.id !== target.id ? [{ stop: next, big: false }] : [])]
  return (
    <g>
      {items.map(({ stop, big }) => {
        const b = bearingDeg(pose, stop)
        const d = Math.round(distanceM(pose, stop))
        const y = view.horizonY - (big ? 48 : 24)
        const label = `${stop.name.toUpperCase()} · ${d} m`
        const cls = big ? 'hud-marker hud-marker--target' : 'hud-marker'
        const x = screenX(b, view, 2)
        if (x === null) {
          const left = angleDiff(b, view.headingDeg) < 0
          const ex = left ? 16 : view.width - 16
          const y = view.horizonY - (big ? 76 : 24) // keep clear of on-screen marker labels
          return (
            <g key={stop.id} className={cls}>
              <path d={left ? `M${ex - 8},${y} L${ex + 4},${y - 7} L${ex + 4},${y + 7} Z` : `M${ex + 8},${y} L${ex - 4},${y - 7} L${ex - 4},${y + 7} Z`} />
              <text x={left ? ex + 10 : ex - 10} y={y + 4} textAnchor={left ? 'start' : 'end'}>{label}</text>
            </g>
          )
        }
        const s = big ? 8 : 6
        return (
          <g key={stop.id} className={cls}>
            <path d={`M${x},${y - s} L${x + s},${y} L${x},${y + s} L${x - s},${y} Z`} className={big ? '' : 'hud-hollow'} />
            <line x1={x} x2={x} y1={y + s} y2={view.horizonY + 4} strokeDasharray="2 3" />
            <text x={Math.min(Math.max(x, 90), view.width - 90)} y={y - s - 6} textAnchor="middle">{label}</text>
          </g>
        )
      })}
    </g>
  )
}

/** Red corner brackets around a detected hazard, sized by distance. */
export function HazardBrackets({ view, pose, hazard }: { view: View; pose: LatLon; hazard: Hazard }) {
  const d = distanceM(pose, hazard)
  if (d > 80) return null
  const x = screenX(bearingDeg(pose, hazard), view)
  if (x === null) return null
  const near = 1 - Math.min(1, d / 80)
  const w = (0.25 + near * 0.45) * view.width
  const h = w * 0.22
  const top = view.horizonY + 8 + near * view.height * 0.12
  const left = x - w / 2
  const c = 14
  const corners = [
    [left, top, 1, 1],
    [left + w, top, -1, 1],
    [left, top + h, 1, -1],
    [left + w, top + h, -1, -1],
  ]
  return (
    <g className="hud-hazard">
      {corners.map(([px, py, sx, sy], i) => (
        <path key={i} d={`M${px + sx * c},${py} L${px},${py} L${px},${py + sy * c}`} />
      ))}
      <text x={left} y={top - 6}>BOULDERS · {Math.round(d)} m</text>
    </g>
  )
}

function clock(s: number): string {
  const t = Math.max(0, Math.round(s))
  return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export function SuitPanel({ suit }: { suit: SuitStatus }) {
  return (
    <div className="hud-panel hud-suit" aria-label="Suit status">
      <div className="hud-row"><span>Oxygen</span><b>{suit.oxygenPct.toFixed(1)}%</b></div>
      <div className="hud-bar"><i style={{ width: `${suit.oxygenPct}%` }} /></div>
      <div className="hud-row"><span>EVA left</span><b>{clock(suit.evaSecondsLeft)}</b></div>
      <div className="hud-row"><span>Dose</span><b>{suit.doseMicroSv.toFixed(1)} µSv</b></div>
      <div className="hud-row hud-opt"><span>Rate</span><b>{Math.round(DOSE_RATE_USV_PER_H)} µSv/h</b></div>
      <div className="hud-row hud-opt"><span>Earth delay</span><b>{EARTH_DELAY_MIN} min</b></div>
    </div>
  )
}

export function NavPanel({ next, nextM, toGoM, slopeDeg }: { next: Stop; nextM: number; toGoM: number; slopeDeg: number | null }) {
  return (
    <div className="hud-panel hud-nav" aria-label="Navigation">
      <div className="hud-row"><span>Next</span><b>{next.kind === 'target' ? 'Target' : next.name}</b></div>
      <div className="hud-big">{Math.round(nextM)} m</div>
      <div className="hud-row"><span>Target</span><b>Cheyava F.</b></div>
      <div className="hud-row"><span>To go</span><b>{Math.round(toGoM)} m</b></div>
      {slopeDeg !== null && <div className="hud-row hud-opt"><span>Rover tilt</span><b>{slopeDeg.toFixed(0)}°</b></div>}
    </div>
  )
}

export type Alert = { tone: 'danger' | 'ok'; title: string; text: string }

export function AlertBanner({ alert }: { alert: Alert | null }) {
  if (!alert) return null
  return (
    <div className={`hud-alert hud-alert--${alert.tone}`} role="status" aria-live="assertive">
      <b>{alert.title}</b> · {alert.text}
    </div>
  )
}
