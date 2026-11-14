import { useState, type ReactNode } from 'react'
import type { LatLon, MobilityId, RoutePlan, RouteProfile, SiteConfig, StopView, Target } from '../types.ts'
import type { PlannerState } from '../lib/usePlanner.ts'
import { NOTE_SIGNS } from '../lib/explain.ts'
import { parsePoint, type Bounds } from '../lib/geo.ts'
import { duration, km } from '../lib/format.ts'
import { MOBILITY, ROUTE_LABELS } from '../lib/mobility.ts'
import {
  CAREER_LIMIT_MSV,
  EARTH_BACKGROUND_MSV_PER_DAY,
  evaDoseMsv,
  JEZERO_CONDITIONS,
  SURFACE_DOSE_MSV_PER_DAY,
} from '../lib/safety.ts'

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
}

export default function Sidebar(p: Props) {
  const { site } = p
  const stops = new Map<string, Target>([p.habitat, ...site.targets, ...p.custom].map((s) => [s.id, s]))
  const focus = p.focusId ? stops.get(p.focusId) : undefined

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
          onFocus={p.onFocus}
          onToggle={p.onToggle}
          onRemovePoint={p.onRemovePoint}
        />
      ) : (
        <>
          <Summary {...p} />
          <div className="sidebar-scroll">
            <MobilityPanel mobility={p.mobility} onMobility={p.onMobility} />
            <StopsPanel {...p} />
            <RoutePanel plan={p.plan} mobility={p.mobility} stops={stops} terrainSource={p.planner.terrainSource} />
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
const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

/** Pinned at the top: does the trip work, the three numbers that matter, the route choice and the one main action. */
function Summary(p: Props) {
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

function RoutePanel({
  plan,
  mobility,
  stops,
  terrainSource,
}: {
  plan: RoutePlan | null
  mobility: MobilityId
  stops: Map<string, Target>
  terrainSource: string | null
}) {
  if (!plan || plan.legs.length === 0) return null
  return (
    <section className="panel">
      <h2 className="step">3 · Route, leg by leg</h2>
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
              <span className="idx num">{last ? 'H' : i + 1}</span>
              <div>
                <div className="name">{last ? 'Back to habitat' : stops.get(leg.toId)?.name}</div>
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
      {terrainSource && <p className="source">Terrain: {terrainSource}</p>}
    </section>
  )
}

function SafetyPanel({ plan }: { plan: RoutePlan | null }) {
  const hours = (plan?.totalMinutes ?? 0) / 60
  const dose = evaDoseMsv(hours)
  return (
    <section className="panel">
      <h2 className="step">4 · Safety</h2>
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
    </section>
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
  onFocus: (id: string | null) => void
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
                <span>Arrive after</span>
                <strong>{duration(arrive)}</strong>
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
