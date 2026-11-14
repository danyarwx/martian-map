import { useState, type ReactNode } from 'react'
import type { LatLon, MobilityId, RoutePlan, RouteProfile, SiteConfig, StopView, Target } from '../types.ts'
import type { PlannerState } from '../lib/usePlanner.ts'
import { NOTE_SIGNS } from '../lib/explain.ts'
import { distanceM, parsePoint, type Bounds } from '../lib/geo.ts'
import { duration, km } from '../lib/format.ts'
import { MOBILITY, ROUTE_LABELS } from '../lib/mobility.ts'
import {
  CAREER_LIMIT_MSV,
  EARTH_BACKGROUND_MSV_PER_DAY,
  evaDoseMsv,
  JEZERO_CONDITIONS,
  SURFACE_DOSE_MSV_PER_DAY,
  WALK_BACK_RESERVE_MIN,
} from '../lib/safety.ts'
import {
  assessDeparture,
  bestDeparture,
  clock,
  DAY,
  farthestWalkHome,
  temperatureC,
  timeline,
  type DepartureOption,
  type TimelineStep,
} from '../lib/schedule.ts'

/** The clock side of the plan: when the crew leaves, and what follows from that. */
interface Schedule {
  /** The departure the model suggests. */
  best: DepartureOption
  /** The departure in use: the suggested one unless the user chose another. */
  chosen: DepartureOption
  steps: TimelineStep[]
  /** Farthest point of the route from the habitat on foot, when known. */
  farthest: { minutes: number; legIndex: number } | null
  /** Latest moment to head straight home from the farthest point and be in before the limit and before dark. */
  turnBackBy: number | null
}

/** A refused action, shown next to the control that caused it. */
export interface Notice {
  text: string
  at: 'habitat' | 'point'
}

interface Props {
  site: SiteConfig
  /** The habitat where it stands now. */
  habitat: Target
  /** True when the habitat is no longer at the site's landing point. */
  habitatMoved: boolean
  /** Destinations the user added. */
  custom: Target[]
  /** Area with elevation data, null until its header has loaded. */
  bounds: Bounds | null
  mobility: MobilityId
  selected: ReadonlySet<string>
  focusId: string | null
  planner: PlannerState
  /** The route the user chose, shown in the summary, Route and Safety panels. */
  plan: RoutePlan | null
  profile: RouteProfile
  views: Record<string, StopView>
  /** True while the next click on the map adds a point. */
  adding: boolean
  notice: Notice | null
  maxSelected: number
  onMobility: (m: MobilityId) => void
  onToggle: (id: string) => void
  onFocus: (id: string | null) => void
  onAdding: (on: boolean) => void
  /** These two return null when done, or the reason the spot was refused. */
  onMoveHabitat: (p: LatLon) => string | null
  onAddPoint: (p: LatLon) => string | null
  onResetHabitat: () => void
  onRemovePoint: (id: string) => void
  onProfile: (profile: RouteProfile) => void
  /** Back to the route the first screen shows. */
  onDemo: () => void
  /** Opens the helmet view on this route, 300 m before the given stop (the first stop when none is given). Absent when the crew is not on foot. */
  onGoOutside?: (stopId?: string) => void
}

export default function Sidebar(p: Props) {
  const { site } = p
  const stops = new Map<string, Target>([p.habitat, ...site.targets, ...p.custom].map((s) => [s.id, s]))
  const focus = p.focusId ? stops.get(p.focusId) : undefined
  /** Departure time the user picked, or null to follow the suggestion. */
  const [startAt, setStartAt] = useState<number | null>(null)
  const plan = p.plan
  let schedule: Schedule | null = null
  if (plan && plan.legs.length > 0) {
    const best = bestDeparture(plan.totalMinutes)
    const chosen = startAt === null ? best : assessDeparture(startAt, plan.totalMinutes)
    const farthest = farthestWalkHome(plan)
    const homeBy = Math.min(chosen.start + MOBILITY[p.mobility].maxEvaHours * 60, DAY.sunset)
    schedule = {
      best,
      chosen,
      steps: timeline(plan, chosen.start),
      farthest,
      turnBackBy: farthest ? homeBy - farthest.minutes : null,
    }
  }

  return (
    <aside className="sidebar" aria-label="Excursion plan">
      {focus ? (
        <StopCard
          stop={focus}
          isHabitat={focus.id === p.habitat.id}
          isCustom={p.custom.some((t) => t.id === focus.id)}
          selected={p.selected.has(focus.id)}
          // The cached habitat photo was taken at the landing site, so it is not shown once the habitat has moved.
          view={focus.id === p.habitat.id && p.habitatMoved ? undefined : p.views[focus.id]}
          plan={p.plan}
          stops={stops}
          mobility={p.mobility}
          schedule={schedule}
          onFocus={p.onFocus}
          onGoOutside={p.onGoOutside}
          onToggle={p.onToggle}
          onRemovePoint={p.onRemovePoint}
        />
      ) : (
        <>
          <Summary {...p} schedule={schedule} />
          <div className="sidebar-scroll">
            <MobilityPanel mobility={p.mobility} onMobility={p.onMobility} />
            <StopsPanel {...p} />
            {schedule && <DeparturePanel schedule={schedule} custom={startAt !== null} onStart={setStartAt} />}
            <RoutePanel
              plan={p.plan}
              mobility={p.mobility}
              stops={stops}
              schedule={schedule}
              terrainSource={p.planner.terrainSource}
            />
            <SafetyPanel plan={p.plan} />
          </div>
        </>
      )}
    </aside>
  )
}

const Check = ({ color }: { color: string }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
)
const Alert = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff8b84" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5v.5" />
  </svg>
)
const Caution = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd166" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v5M12 18v.5" />
  </svg>
)
const Chevron = () => (
  <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
)

/** A panel that stays closed until asked for: its header says what is inside and the one value worth seeing closed. */
function Fold({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <details className="panel fold">
      <summary>
        <h2 className="step">{title}</h2>
        {hint && <span className="fold-hint num">{hint}</span>}
        <Chevron />
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  )
}

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

/** Pinned at the top: does the trip work, the three numbers that matter, the route choice and the one main action. */
function Summary(p: Props & { schedule: Schedule | null }) {
  const { planner, plan, mobility } = p
  const { plans, planning, error } = planner
  const m = MOBILITY[mobility]
  const routed = plan !== null && plan.legs.length > 0
  const hours = (plan?.totalMinutes ?? 0) / 60
  const firstStop = plan?.order[1]

  if (!planning && !error && (p.selected.size === 0 || (plan && !routed && !plan.habitatNoFooting && plan.unreachable.length === 0))) {
    return (
      <section className="summary" aria-live="polite">
        <div className="empty">
          <strong>No stops yet</strong>
          <p className="muted">Tick a target below, or add your own point on the map.</p>
          <button type="button" className="btn btn--primary" onClick={p.onDemo}>
            Use the demo route (3 stops)
          </button>
        </div>
      </section>
    )
  }

  let status: ReactNode = null
  if (planning) {
    status = (
      <div className="status status--busy" role="status">
        <span>Finding the safest order for {p.selected.size} {p.selected.size === 1 ? 'stop' : 'stops'}…</span>
      </div>
    )
  } else if (error) {
    status = (
      <div className="status status--bad" role="alert">
        <Alert />
        <span><strong>Route planning failed.</strong> {error}</span>
      </div>
    )
  } else if (plan?.habitatNoFooting) {
    status = (
      <div className="status status--bad" role="alert">
        <Alert />
        <span>
          <strong>No safe ground at the habitat.</strong> It stands on slopes over {m.maxSlopeDeg}° or outside the
          elevation data. Move it.
        </span>
      </div>
    )
  } else if (routed && !plan.fitsOneEva) {
    status = (
      <div className="status status--bad" role="alert">
        <Alert />
        <span>
          <strong>Too long for one excursion.</strong> <span className="num">{duration(plan.totalMinutes)}</span> outside
          against a {m.maxEvaHours} h limit.
        </span>
      </div>
    )
  } else if (routed) {
    status = (
      <div className="status status--ok">
        <Check color="#7ee2a0" />
        <span>
          Fits one excursion · <strong>{duration(m.maxEvaHours * 60 - plan.totalMinutes)}</strong> to spare
        </span>
      </div>
    )
  }

  const unreachable =
    plan && !plan.habitatNoFooting && plan.unreachable.length > 0
      ? plan.unreachable
          .map((id) => {
            const name = p.custom.concat(p.site.targets).find((t) => t.id === id)?.name ?? id
            return plan.unreachableWhy[id] === 'no-footing'
              ? `${name} stands on ground steeper than ${m.maxSlopeDeg}°.`
              : `No safe path to ${name}: slopes on the way exceed ${m.maxSlopeDeg}°.`
          })
          .join(' ')
      : null

  return (
    <section className="summary" aria-live="polite">
      {status}
      {planning && <div className="progress" aria-hidden="true" />}
      {unreachable && (
        <div className="status status--bad">
          <Alert />
          <span>{unreachable}</span>
        </div>
      )}
      {routed && !planning && p.schedule?.farthest && p.schedule.farthest.minutes > WALK_BACK_RESERVE_MIN && (
        <details className="status status--warn more">
          <summary>
            <Caution />
            <span>
              <strong>Beyond walk-back reserve</strong> · <span className="num">{duration(p.schedule.farthest.minutes)}</span>
            </span>
            <Chevron />
          </summary>
          <p>
            The farthest point of the route is <span className="num">{duration(p.schedule.farthest.minutes)}</span> on
            foot from the habitat. The emergency reserve is {WALK_BACK_RESERVE_MIN} min: the green line on the map.
          </p>
        </details>
      )}
      {routed && !planning && p.schedule && !p.schedule.chosen.inDaylight && (
        <div className="status status--bad" role="alert">
          <Alert />
          <span>
            <strong>Not enough daylight</strong> for a {clock(p.schedule.chosen.start)} departure. Pick an earlier time
            in step 3.
          </span>
        </div>
      )}
      {routed && (
        <div className={`figures${planning ? ' is-stale' : ''}`}>
          <div className="figure">
            <span>Time outside</span>
            <strong>{duration(plan.totalMinutes).replace(' min', '')}</strong>
          </div>
          <div className="figure">
            <span>Distance</span>
            <strong>{km(plan.distanceM)}</strong>
          </div>
          <div className="figure">
            <span>Dose</span>
            <strong>{evaDoseMsv(hours).toFixed(2)} mSv</strong>
          </div>
        </div>
      )}
      {routed && p.schedule && (
        <p className="when">
          Leave <strong className="num">{clock(p.schedule.chosen.start)}</strong> · back{' '}
          <strong className="num">{clock(p.schedule.chosen.end)}</strong> <span className="muted">local solar time</span>
        </p>
      )}
      {plans && routed && !plans.gentleIsSame && (
        <div className="choice choice--inset" role="group" aria-label="Which route">
          {(['fast', 'gentle'] as const).map((id) => {
            const option = plans[id]
            return (
              <button key={id} type="button" aria-pressed={id === p.profile} onClick={() => p.onProfile(id)}>
                {!option.fitsOneEva && <em className="tag">over {m.maxEvaHours} h</em>}
                <strong>{ROUTE_LABELS[id]}</strong>
                <small>
                  {duration(option.totalMinutes)} · {Math.round(option.steepM / 10) * 10} m steep
                </small>
              </button>
            )
          })}
        </div>
      )}
      {routed && !planning && !plan.fitsOneEva ? (
        <div className="status-actions">
          {mobility === 'walk' && (
            <button type="button" className="btn btn--primary" onClick={() => p.onMobility('rover')}>
              Switch to the crew rover
            </button>
          )}
          <button type="button" className={`btn btn--block${mobility === 'walk' ? '' : ' btn--primary'}`} onClick={() => firstStop && p.onFocus(firstStop)}>
            Review stops to drop one
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          disabled={!routed || planning}
          onClick={() => firstStop && p.onFocus(firstStop)}
        >
          Walk through stops <Arrow />
        </button>
      )}
      {p.onGoOutside && routed && !planning && (
        <button type="button" className="btn btn--block" onClick={() => p.onGoOutside?.()} title="Helmet view: walk the route in 3D with live hazard detection">
          Go outside (helmet view)
        </button>
      )}
    </section>
  )
}

function MobilityPanel({ mobility, onMobility }: { mobility: MobilityId; onMobility: (m: MobilityId) => void }) {
  return (
    <section className="panel">
      <h2 className="step">1 · How the crew moves</h2>
      <div className="choice" role="group" aria-label="How the crew moves">
        {Object.values(MOBILITY).map((m) => (
          <button key={m.id} type="button" aria-pressed={m.id === mobility} onClick={() => onMobility(m.id)}>
            <strong>{m.label}</strong>
            <small className="num">
              {m.flatSpeedKmh} km/h · ≤{m.maxSlopeDeg}°
            </small>
          </button>
        ))}
      </div>
    </section>
  )
}

function StopsPanel(p: Props) {
  const [moving, setMoving] = useState(false)
  const [typing, setTyping] = useState(false)
  const { plan } = p
  const visitNo = new Map<string, number>()
  plan?.order.slice(1, -1).forEach((id, i) => visitNo.set(id, i + 1))
  const blocked = new Set(plan?.unreachable ?? [])

  const row = (t: Target, custom: boolean) => {
    const on = p.selected.has(t.id)
    const no = visitNo.get(t.id)
    const badge = blocked.has(t.id) && on ? 'badge badge--blocked' : custom ? 'badge badge--custom' : on ? 'badge' : 'badge badge--off'
    return (
      <li key={t.id} className={`stop-row${p.focusId === t.id ? ' is-focus' : ''}`}>
        <span className={badge} aria-hidden="true">
          {blocked.has(t.id) && on ? '!' : on && no ? no : ''}
        </span>
        <button type="button" className="info" onClick={() => p.onFocus(t.id)}>
          <strong>{t.name}</strong>
          <small>{t.summary}</small>
        </button>
        <input type="checkbox" checked={on} onChange={() => p.onToggle(t.id)} aria-label={`${t.name} on the route`} />
      </li>
    )
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="step">
          2 · Stops <span className="num">{p.selected.size}/{p.maxSelected}</span>
        </h2>
        <button
          type="button"
          className={`btn btn--sm${p.adding ? ' btn--active' : ''}`}
          aria-pressed={p.adding}
          onClick={() => p.onAdding(!p.adding)}
        >
          {p.adding ? 'Cancel' : '+ Add point'}
        </button>
      </div>
      {p.adding && <p className="adding-hint">Click the map to place the point. Esc cancels.</p>}
      {p.notice?.at === 'point' && <p className="field-error" role="alert">{p.notice.text}</p>}

      <ul className="stops">
        <li className={`stop-row${p.focusId === p.habitat.id ? ' is-focus' : ''}`}>
          <span className="badge badge--habitat" aria-hidden="true">H</span>
          <button type="button" className="info" onClick={() => p.onFocus(p.habitat.id)}>
            <strong>Habitat</strong>
            <small>{p.habitatMoved ? 'Moved from the landing site · start and end' : 'Octavia E. Butler Landing · start and end'}</small>
          </button>
          <button type="button" className={`btn btn--sm${moving ? ' btn--active' : ''}`} aria-expanded={moving} onClick={() => setMoving(!moving)}>
            Move
          </button>
        </li>
      </ul>
      {moving && (
        <>
          <p className="muted">Drag the H marker on the map, or enter coordinates.</p>
          <CoordForm
            key={`${p.habitat.lat},${p.habitat.lon}`}
            bounds={p.bounds}
            start={p.habitat}
            submit="Apply"
            refusal={p.notice?.at === 'habitat' ? p.notice.text : null}
            onSubmit={p.onMoveHabitat}
          />
          <button type="button" className="btn btn--sm" disabled={!p.habitatMoved} onClick={p.onResetHabitat}>
            Reset to landing site
          </button>
        </>
      )}

      <ul className="stops">
        {p.site.targets.map((t) => row(t, false))}
        {p.custom.map((t) => row(t, true))}
      </ul>

      <button type="button" className="btn btn--sm" aria-expanded={typing} onClick={() => setTyping(!typing)} style={{ alignSelf: 'flex-start' }}>
        {typing ? 'Hide coordinates' : 'Add by coordinates'}
      </button>
      {typing && <CoordForm bounds={p.bounds} submit="Add" clearOnDone refusal={null} onSubmit={p.onAddPoint} />}
    </section>
  )
}

/** Latitude and longitude inputs with one button. Errors sit under the inputs. */
function CoordForm(p: {
  bounds: Bounds | null
  start?: LatLon
  submit: string
  /** Empty the inputs after a successful submit. */
  clearOnDone?: boolean
  /** Why the last submitted spot was refused by the app, if it was. */
  refusal: string | null
  /** Returns null when done, or the reason the point was refused. */
  onSubmit: (point: LatLon) => string | null
}) {
  const [lat, setLat] = useState(p.start ? p.start.lat.toFixed(5) : '')
  const [lon, setLon] = useState(p.start ? p.start.lon.toFixed(5) : '')
  const [error, setError] = useState<string | null>(null)
  const shown = error ?? p.refusal
  return (
    <form
      className="coords"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        const parsed = parsePoint(p.bounds, lat, lon)
        const problem = parsed.ok ? p.onSubmit(parsed.point) : parsed.error
        setError(problem)
        if (!problem && p.clearOnDone) {
          setLat('')
          setLon('')
        }
      }}
    >
      <label>
        Lat °N
        <input type="number" step="any" inputMode="decimal" value={lat} aria-invalid={shown !== null} onChange={(e) => setLat(e.target.value)} />
      </label>
      <label>
        Lon °E
        <input type="number" step="any" inputMode="decimal" value={lon} aria-invalid={shown !== null} onChange={(e) => setLon(e.target.value)} />
      </label>
      <button type="submit" className="btn">
        {p.submit}
      </button>
      {shown && <p className="field-error" role="alert">{shown}</p>}
    </form>
  )
}

/** Hours shown on the day strip. */
const STRIP_FROM = 4 * 60
const STRIP_TO = 20 * 60

/** When to leave: the suggested time with its reasons, a picture of the day, and a slider to try another time. */
function DeparturePanel({
  schedule,
  custom,
  onStart,
}: {
  schedule: Schedule
  custom: boolean
  onStart: (minute: number | null) => void
}) {
  const { best, chosen } = schedule
  const W = 372
  const H = 96
  const x = (minute: number) => ((minute - STRIP_FROM) / (STRIP_TO - STRIP_FROM)) * W
  const y = (c: number) => 12 + ((DAY.warmestC - c) / (DAY.warmestC - DAY.coldestC)) * 44
  const curve: string[] = []
  for (let t = STRIP_FROM; t <= STRIP_TO; t += 15) curve.push(`${x(t).toFixed(1)},${y(temperatureC(t)).toFixed(1)}`)
  const isBest = chosen.start === best.start
  return (
    <Fold title="3 · When to leave" hint={`${clock(chosen.start)} → ${clock(chosen.end)}`}>
      <div className="panel-head">
        <p>
          {isBest ? 'Best departure' : 'Your departure'}: <strong className="num">{clock(chosen.start)}</strong>, back at{' '}
          <strong className="num">{clock(chosen.end)}</strong>.
        </p>
        {custom && !isBest && (
          <button type="button" className="btn btn--sm" onClick={() => onStart(null)}>
            Use best · {clock(best.start)}
          </button>
        )}
      </div>
      <svg className="day" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Day chart: excursion from ${clock(chosen.start)} to ${clock(chosen.end)}, daylight ${clock(DAY.sunrise)} to ${clock(DAY.sunset)}, gust hours ${clock(DAY.gustsFrom)} to ${clock(DAY.gustsTo)}`}>
        <rect x="0" y="0" width={W} height="64" fill="var(--bg)" rx="6" />
        <rect x={x(DAY.sunrise)} y="0" width={x(DAY.sunset) - x(DAY.sunrise)} height="64" fill="var(--surface-2)" />
        <rect x={x(DAY.gustsFrom)} y="0" width={x(DAY.gustsTo) - x(DAY.gustsFrom)} height="64" fill="var(--warn)" opacity="0.16" />
        <text x={x((DAY.gustsFrom + DAY.gustsTo) / 2)} y="11" textAnchor="middle" className="day-label" fill="var(--warn)">gusts</text>
        <polyline points={curve.join(' ')} fill="none" stroke="var(--text-2)" strokeWidth="1.5" />
        <text x={x(DAY.gustsTo) + 4} y={y(DAY.warmestC) + 8} className="day-label">{DAY.warmestC} °C</text>
        <text x={x(DAY.coldestAt) + 4} y={y(DAY.coldestC) + 4} className="day-label">{DAY.coldestC} °C</text>
        <rect x={x(chosen.start)} y="52" width={Math.max(2, x(chosen.end) - x(chosen.start))} height="8" rx="4" fill={chosen.inDaylight ? 'var(--accent)' : 'var(--danger-line)'} />
        {[6, 9, 12, 15, 18].map((h) => (
          <g key={h}>
            <line x1={x(h * 60)} x2={x(h * 60)} y1="64" y2="68" stroke="var(--control-border)" />
            <text x={x(h * 60)} y="80" textAnchor="middle" className="day-label">{String(h).padStart(2, '0')}:00</text>
          </g>
        ))}
        <text x={x(DAY.sunrise)} y="93" textAnchor="middle" className="day-label">sunrise</text>
        <text x={x(DAY.sunset)} y="93" textAnchor="middle" className="day-label">sunset</text>
      </svg>
      <label className="slider">
        <span className="visually-hidden">Departure time</span>
        <input
          type="range"
          min={DAY.sunrise}
          max={DAY.sunset - 60}
          step={15}
          value={chosen.start}
          aria-valuetext={clock(chosen.start)}
          onChange={(e) => onStart(Number(e.target.value))}
        />
      </label>
      {!chosen.inDaylight && (
        <div className="status status--bad" role="alert">
          <Alert />
          <span>
            <strong>Not enough daylight.</strong>{' '}
            {chosen.daylightLeft < WALK_BACK_RESERVE_MIN
              ? `Back ${chosen.daylightLeft < 0 ? 'after' : 'only ' + duration(chosen.daylightLeft) + ' before'} sunset; keep ${WALK_BACK_RESERVE_MIN} min for an emergency walk home.`
              : 'Leave at least 30 min after sunrise.'}
          </span>
        </div>
      )}
      <ul className="reasons">
        <li>
          <i className={chosen.gustMinutes === 0 ? 'dot dot--ok' : chosen.gustMinutes > chosen.end - chosen.start - chosen.gustMinutes ? 'dot dot--bad' : 'dot dot--warn'} />
          {chosen.gustMinutes === 0
            ? 'Outside the midday gust hours the whole time.'
            : `${duration(chosen.gustMinutes)} inside the midday gust hours (${clock(DAY.gustsFrom)}–${clock(DAY.gustsTo)}, dust devils most frequent).`}
        </li>
        <li>
          <i className={chosen.minC < -70 ? 'dot dot--warn' : 'dot dot--ok'} />
          Air {Math.round(chosen.minC)} to {Math.round(chosen.maxC)} °C, mean{' '}
          {Math.round(chosen.meanC)} °C.
        </li>
        <li>
          <i className={chosen.daylightLeft >= 120 ? 'dot dot--ok' : chosen.daylightLeft >= WALK_BACK_RESERVE_MIN ? 'dot dot--warn' : 'dot dot--bad'} />
          {chosen.daylightLeft >= 0 ? `${duration(chosen.daylightLeft)} of daylight left after return.` : 'Return is after sunset.'}
        </li>
      </ul>
      <p className="source">
        A model of a typical sol, not a forecast: daylight for 18° N, air temperature and gust hours from Perseverance
        MEDA (Rodriguez-Manfredi et al. 2023; Newman et al. 2022). Cosmic-ray dose does not depend on the hour.
      </p>
    </Fold>
  )
}

/** Height along the route, coloured by slope class like the line on the map, with the stops marked. */
function Profile({ plan }: { plan: RoutePlan }) {
  const W = 372
  const H = 112
  const top = 22
  const bottom = 92
  // One point per path point: distance from the start, height, slope class, and whether a stop is reached.
  const pts: { d: number; z: number | null; level: number }[] = []
  const stopsAt: number[] = []
  let d = 0
  for (const leg of plan.legs) {
    const levels: number[] = []
    leg.sections.forEach((s, k) => s.path.forEach((_, i) => (k === 0 || i > 0) && levels.push(s.level)))
    leg.path.forEach((q, i) => {
      if (i > 0) d += distanceM(leg.path[i - 1], q)
      pts.push({ d, z: leg.elev[i] ?? null, level: levels[i] ?? 0 })
    })
    stopsAt.push(d)
  }
  const heights = pts.flatMap((q) => (q.z === null ? [] : [q.z]))
  if (heights.length < 2 || d === 0) return null
  const lo = Math.min(...heights)
  const hi = Math.max(...heights)
  const x = (m: number) => (m / d) * W
  const y = (z: number) => bottom - ((z - lo) / Math.max(hi - lo, 1)) * (bottom - top)
  // Runs of equal slope class, each starting at the last point of the run before it.
  const runs: { level: number; points: string[] }[] = []
  let area = ''
  let last: string | null = null
  for (const q of pts) {
    if (q.z === null) continue
    const xy = `${x(q.d).toFixed(1)},${y(q.z).toFixed(1)}`
    const run = runs[runs.length - 1]
    if (!run || run.level !== q.level) runs.push({ level: q.level, points: last ? [last, xy] : [xy] })
    else run.points.push(xy)
    area += `${area ? 'L' : 'M'}${xy}`
    last = xy
  }
  const colors = ['var(--slope-low)', 'var(--slope-mid)', 'var(--slope-high)']
  return (
    <svg className="profile" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Elevation along the route: from ${Math.round(lo)} to ${Math.round(hi)} m over ${km(d)}`}>
      <path d={`${area}L${W},${bottom}L0,${bottom}Z`} fill="var(--surface-2)" />
      {runs.map((r, i) => (
        <polyline key={i} points={r.points.join(' ')} fill="none" stroke={colors[r.level]} strokeWidth="2" strokeLinejoin="round" />
      ))}
      {stopsAt.slice(0, -1).map((m, i) => (
        <g key={i}>
          <line x1={x(m)} x2={x(m)} y1={top - 4} y2={bottom} stroke="var(--control-border)" strokeDasharray="2 3" />
          <circle cx={x(m)} cy="9" r="8" fill="#fff" />
          <text x={x(m)} y="13" textAnchor="middle" className="profile-stop">{i + 1}</text>
        </g>
      ))}
      <text x="0" y={top - 6} className="day-label">{Math.round(hi)} m</text>
      <text x="0" y={H - 4} className="day-label">{Math.round(lo)} m · 0 km</text>
      <text x={W} y={H - 4} textAnchor="end" className="day-label">{km(d)}</text>
    </svg>
  )
}

function RoutePanel({
  plan,
  mobility,
  stops,
  schedule,
  terrainSource,
}: {
  plan: RoutePlan | null
  mobility: MobilityId
  stops: Map<string, Target>
  schedule: Schedule | null
  terrainSource: string | null
}) {
  if (!plan || plan.legs.length === 0) return null
  return (
    <Fold title="4 · Route, leg by leg" hint={`${plan.legs.length} legs · climb ${Math.round(plan.ascentM)} m`}>
      <Profile plan={plan} />
      <p className="muted">
        {duration(plan.travelMinutes)} moving, {duration(plan.stopMinutes)} working at stops. Climb{' '}
        <span className="num">{Math.round(plan.ascentM)} m</span>, steepest{' '}
        <span className="num">{plan.maxSlopeDeg.toFixed(0)}°</span> (limit {MOBILITY[mobility].maxSlopeDeg}°).
      </p>
      <ol className="legs">
        {plan.legs.map((leg, i) => {
          const last = i === plan.legs.length - 1
          return (
            <li key={i}>
              <span className="at num">{schedule ? clock(schedule.steps[i + 1].at) : last ? 'H' : i + 1}</span>
              <div>
                <div className="name">{last ? 'Back to habitat' : `${i + 1} · ${stops.get(leg.toId)?.name}`}</div>
                <div className="meta num">
                  {km(leg.distanceM)} · {duration(leg.minutes)} · max {leg.maxSlopeDeg.toFixed(0)}°
                </div>
                {leg.notes.length > 0 && (
                  <ul className="leg-notes">
                    {leg.notes.map((note, k) => (
                      <li key={k}>
                        <i className={`note note--${note.kind}`} aria-hidden="true">
                          {NOTE_SIGNS[note.kind]}
                        </i>
                        {note.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {schedule?.farthest && schedule.turnBackBy !== null && (
        <p className="turn-back">
          <Caution />
          <span>
            Latest turn-back: <strong className="num">{clock(schedule.turnBackBy)}</strong>. From the farthest point (on
            the way to {schedule.farthest.legIndex === plan.legs.length - 1 ? 'the habitat' : stops.get(plan.legs[schedule.farthest.legIndex].toId)?.name}) it is{' '}
            <span className="num">{duration(schedule.farthest.minutes)}</span> on foot straight home, to be in before the{' '}
            {MOBILITY[mobility].maxEvaHours} h limit and sunset.
          </span>
        </p>
      )}
      {terrainSource && <p className="source">Terrain: {terrainSource}</p>}
    </Fold>
  )
}

function SafetyPanel({ plan }: { plan: RoutePlan | null }) {
  const hours = (plan?.totalMinutes ?? 0) / 60
  const dose = evaDoseMsv(hours)
  return (
    <Fold title="5 · Safety and conditions" hint={hours > 0 ? `${dose.toFixed(2)} mSv` : undefined}>
      <p>
        {hours > 0 && (
          <>
            <span className="num">{dose.toFixed(2)} mSv</span> outside, equal to{' '}
            {Math.round(dose / EARTH_BACKGROUND_MSV_PER_DAY)} days of natural background on Earth and{' '}
            {((dose / CAREER_LIMIT_MSV) * 100).toFixed(2)}% of NASA’s {CAREER_LIMIT_MSV} mSv career limit.{' '}
          </>
        )}
        Surface dose rate <span className="num">{SURFACE_DOSE_MSV_PER_DAY} mSv/day</span>. Assumes quiet space weather: a
        solar particle event can raise the dose sharply, so check the forecast before leaving the habitat.
      </p>
      <table className="conditions">
        <tbody>
          {JEZERO_CONDITIONS.map((c) => (
            <tr key={c.label}>
              <th>{c.label}</th>
              <td>
                {c.value} <small>{c.note}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="source">
        Typical values, not live. Radiation: Curiosity RAD, Gale crater (Hassler et al. 2014). Weather: Perseverance
        MEDA, Jezero (Rodriguez-Manfredi et al. 2023).
      </p>
    </Fold>
  )
}

/** One stop in full. Steps through the route in visiting order. */
function StopCard(p: {
  stop: Target
  isHabitat: boolean
  isCustom: boolean
  selected: boolean
  view?: StopView
  plan: RoutePlan | null
  stops: Map<string, Target>
  mobility: MobilityId
  schedule: Schedule | null
  onFocus: (id: string | null) => void
  onGoOutside?: (stopId?: string) => void
  onToggle: (id: string) => void
  onRemovePoint: (id: string) => void
}) {
  const { stop, view, plan } = p
  const route = plan && plan.legs.length > 0 ? plan.order.slice(1, -1) : []
  const at = route.indexOf(stop.id)
  const inRoute = at >= 0
  const prev = inRoute ? (at === 0 ? plan!.order[0] : route[at - 1]) : null
  const next = inRoute && at < route.length - 1 ? route[at + 1] : null
  const leg = inRoute ? plan!.legs[at] : undefined
  // Time from leaving the habitat until arriving here: the legs before plus the work at earlier stops.
  const arrive = inRoute
    ? plan!.legs.slice(0, at + 1).reduce((t, l) => t + l.minutes, 0) + at * MOBILITY[p.mobility].stopMinutes
    : 0
  const walkHome = leg && leg.walkHomeMin.length > 0 ? leg.walkHomeMin[leg.walkHomeMin.length - 1] : null
  const arriveAt = inRoute && p.schedule ? p.schedule.steps[at + 1].at : null
  const eyebrow = p.isHabitat ? 'Start and end' : inRoute ? `Stop ${at + 1} · ${p.isCustom ? 'your point' : 'science target'}` : 'Not on the route'

  return (
    <>
      <div className="card-head">
        <button type="button" className="back" onClick={() => p.onFocus(null)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Route overview
        </button>
        {inRoute && (
          <span className="pager" aria-label={`Stop ${at + 1} of ${route.length}`}>
            {route.map((id, i) => (
              <i key={id} className={i === at ? 'is-on' : ''} />
            ))}
          </span>
        )}
      </div>
      <div className="sidebar-scroll">
        <div className="card">
          {view && (
            <figure>
              <img src={view.file} alt={`Ground view near ${stop.name}`} />
              <figcaption>
                {view.camera}, sol {view.sol}
                {view.distanceM > 20 ? `, taken ${view.distanceM} m from this spot` : ''} · {view.credit}
              </figcaption>
            </figure>
          )}
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h1>{stop.name}</h1>
          </div>
          {leg && (
            <div className="tiles">
              <div className="tile">
                <span>{arriveAt !== null ? 'Arrive' : 'Arrive after'}</span>
                <strong>{arriveAt !== null ? clock(arriveAt) : duration(arrive)}</strong>
              </div>
              <div className="tile">
                <span>Work here</span>
                <strong>{MOBILITY[p.mobility].stopMinutes} min</strong>
              </div>
              <div className="tile">
                <span>Max slope</span>
                <strong>{leg.maxSlopeDeg.toFixed(0)}°</strong>
              </div>
            </div>
          )}
          <dl>
            {!p.isHabitat && (
              <>
                <dt>Why</dt>
                <dd>{stop.science}</dd>
              </>
            )}
            {p.isHabitat && (
              <>
                <dt>Where</dt>
                <dd>{stop.summary}</dd>
              </>
            )}
            {stop.task && (
              <>
                <dt>Task</dt>
                <dd>{stop.task}</dd>
              </>
            )}
            {leg && leg.notes.length > 0 && (
              <>
                <dt>Way in</dt>
                <dd>
                  <ul className="leg-notes" style={{ marginTop: 0 }}>
                    {leg.notes.map((note, k) => (
                      <li key={k}>
                        <i className={`note note--${note.kind}`} aria-hidden="true">
                          {NOTE_SIGNS[note.kind]}
                        </i>
                        {note.text}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {walkHome !== null && Number.isFinite(walkHome) && (
              <>
                <dt>Bail-out</dt>
                <dd>
                  <span className="num">{duration(walkHome)}</span> on foot straight back to the habitat
                  {walkHome > WALK_BACK_RESERVE_MIN ? (
                    <span className="over"> — beyond the {WALK_BACK_RESERVE_MIN} min emergency reserve.</span>
                  ) : (
                    `, inside the ${WALK_BACK_RESERVE_MIN} min emergency reserve.`
                  )}
                </dd>
              </>
            )}
            <dt>Position</dt>
            <dd className="num" style={{ fontSize: 13 }}>
              {stop.lat.toFixed(5)}° N, {stop.lon.toFixed(5)}° E
            </dd>
          </dl>
        </div>
      </div>
      <div className="card-foot">
        {inRoute && (
          <button type="button" className="btn btn--primary" onClick={() => p.onFocus(next ?? plan!.order[0])}>
            {next ? `Next: ${p.stops.get(next)?.name}` : 'Back to habitat'} <Arrow />
          </button>
        )}
        {inRoute && p.onGoOutside && (
          <button type="button" className="btn btn--block" onClick={() => p.onGoOutside?.(stop.id)} title="Helmet view: start 300 m before this stop">
            Go outside here (helmet view)
          </button>
        )}
        {!inRoute && !p.isHabitat && !p.selected && (
          <button type="button" className="btn btn--primary" onClick={() => p.onToggle(stop.id)}>
            Add to the route
          </button>
        )}
        {!p.isHabitat && (
          <div className="pair">
            <button type="button" className="btn" disabled={!prev} onClick={() => prev && p.onFocus(prev)}>
              ← {prev ? (prev === plan?.order[0] ? 'Habitat' : 'Previous') : 'Previous'}
            </button>
            {p.isCustom ? (
              <button type="button" className="btn btn--danger" onClick={() => p.onRemovePoint(stop.id)}>
                Delete point
              </button>
            ) : (
              <button type="button" className="btn btn--danger" disabled={!p.selected} onClick={() => p.onToggle(stop.id)}>
                Remove from route
              </button>
            )}
          </div>
        )}
        {p.isHabitat && route.length > 0 && (
          <button type="button" className="btn btn--primary" onClick={() => p.onFocus(route[0])}>
            First stop: {p.stops.get(route[0])?.name} <Arrow />
          </button>
        )}
      </div>
    </>
  )
}
