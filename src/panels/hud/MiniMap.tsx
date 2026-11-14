import type { AstronautPose, Hazard, LatLon, Stop } from '../../types'
import { toLocalM } from '../geo'

type Props = {
  stops: Stop[]
  route: LatLon[]
  walked: LatLon[]
  /** The stretch of planned route that a hazard made unusable. */
  abandoned: LatLon[] | null
  hazards: Hazard[]
  pose: AstronautPose
}

const SIZE = 100

/**
 * Small north-up map in the corner of the visor. Drawn as SVG in local metres so it works
 * without tiles or network.
 */
export default function MiniMap({ stops, route, walked, abandoned, hazards, pose }: Props) {
  const ref = stops[0]
  const pts = [...stops, ...hazards].map((p) => toLocalM(p, ref))
  const minX = Math.min(...pts.map((p) => p.x)) - 40
  const maxX = Math.max(...pts.map((p) => p.x)) + 40
  const minY = Math.min(...pts.map((p) => p.y)) - 30
  const maxY = Math.max(...pts.map((p) => p.y)) + 30
  const span = Math.max(maxX - minX, maxY - minY)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const k = (SIZE * 0.9) / span

  const xy = (p: LatLon) => {
    const m = toLocalM(p, ref)
    return [SIZE / 2 + (m.x - cx) * k, SIZE / 2 - (m.y - cy) * k] as const
  }
  const line = (path: LatLon[]) => path.map((p) => xy(p).join(',')).join(' ')
  const [mx, my] = xy(pose)

  return (
    <div className="hud-panel hud-mini" aria-label="Mini-map">
      <span className="hud-mini-cap">N↑ · {Math.round(span)} m</span>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} preserveAspectRatio="xMidYMid meet">
        {abandoned && <polyline points={line(abandoned)} className="hud-mini-abandoned" />}
        <polyline points={line(route)} className="hud-mini-route" />
        <polyline points={line(walked)} className="hud-mini-walked" />
        {hazards.map((h) => {
          const [x, y] = xy(h)
          return <circle key={h.id} cx={x} cy={y} r={Math.max(3, h.radiusM * k)} className="hud-mini-hazard" />
        })}
        {stops.map((s) => {
          const [x, y] = xy(s)
          if (s.kind === 'habitat') return <rect key={s.id} x={x - 3} y={y - 3} width={6} height={6} className="hud-mini-hab" />
          return <circle key={s.id} cx={x} cy={y} r={s.kind === 'target' ? 3.5 : 2.2} className={s.kind === 'target' ? 'hud-mini-target' : 'hud-mini-stop'} />
        })}
        <path d="M0,-6 L4,4 L0,2 L-4,4 Z" transform={`translate(${mx},${my}) rotate(${pose.headingDeg})`} className="hud-mini-me" />
      </svg>
    </div>
  )
}
