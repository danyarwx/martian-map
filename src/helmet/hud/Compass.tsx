interface Props {
  headingDeg: number
  /** Bearing of the next stop, degrees clockwise from north, or null. */
  stopBearingDeg: number | null
  /** Heading the guide says to follow, or null. */
  steerDeg: number | null
}

/** Degrees shown either side of the heading, and the tape's width in pixels. */
const SPAN = 60
const WIDTH = 360
const NAMES: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }

const rel = (deg: number, heading: number) => ((deg - heading + 540) % 360) - 180
const px = (r: number) => WIDTH / 2 + (r / SPAN) * (WIDTH / 2)

/** Compass tape (PLAN §7.1): the heading, with markers for the next stop and the guide. */
export default function Compass({ headingDeg, stopBearingDeg, steerDeg }: Props) {
  const ticks: { deg: number; r: number }[] = []
  for (let d = 0; d < 360; d += 15) {
    const r = rel(d, headingDeg)
    if (Math.abs(r) <= SPAN) ticks.push({ deg: d, r })
  }
  const marker = (deg: number | null, cls: string, label: string) => {
    if (deg === null) return null
    const r = rel(deg, headingDeg)
    const clamped = Math.max(-SPAN, Math.min(SPAN, r))
    return (
      <span className={`helmet-compass-mark ${cls}${clamped !== r ? ' is-off' : ''}`} style={{ left: px(clamped) }} title={label}>
        {clamped !== r ? (r < 0 ? '◀' : '▶') : '▼'}
      </span>
    )
  }
  return (
    <div className="helmet-compass" style={{ width: WIDTH }} role="img" aria-label={`Heading ${Math.round(headingDeg)} degrees`}>
      {ticks.map((t) => (
        <span key={t.deg} className={`helmet-compass-tick${NAMES[t.deg] ? ' is-named' : ''}`} style={{ left: px(t.r) }}>
          {NAMES[t.deg] ?? t.deg}
        </span>
      ))}
      {marker(stopBearingDeg, 'is-stop', 'Next stop')}
      {marker(steerDeg, 'is-guide', 'Guide')}
      <span className="helmet-compass-heading">{String(Math.round(headingDeg) % 360).padStart(3, '0')}°</span>
    </div>
  )
}
