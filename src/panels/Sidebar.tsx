import { useState } from 'react'
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
  /** The route the user chose, shown in the Route and Safety panels. */
  plan: RoutePlan | null
  profile: RouteProfile
  views: Record<string, StopView>
  /** True while the next click on the map adds a point. */
  adding: boolean
  /** One line about the last action that was refused. */
  notice: string | null
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
}


export default function Sidebar(p: Props) {
  const { site, planner } = p
  const stops = new Map<string, Target>([p.habitat, ...site.targets, ...p.custom].map((s) => [s.id, s]))
  const focus = p.focusId ? stops.get(p.focusId) : undefined
  const focusIsCustom = p.custom.some((t) => t.id === focus?.id)
  // The cached habitat photo was taken at the landing site, so it is not shown once the habitat has moved.
  const focusView = focus && !(focus.id === p.habitat.id && p.habitatMoved) ? p.views[focus.id] : undefined

  return (
    <aside className="sidebar">
      <section className="panel">
        <h2>Mission</h2>
        <p className="goal">{site.scienceGoal}</p>
        <div className="segmented" role="group" aria-label="How the crew moves">
          {Object.values(MOBILITY).map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === p.mobility ? 'is-active' : ''}
              aria-pressed={m.id === p.mobility}
              onClick={() => p.onMobility(m.id)}
            >
              {m.label}
              <small>
                {m.flatSpeedKmh} km/h · up to {m.maxSlopeDeg}°
              </small>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Habitat</h2>
        <p className="muted">
          {p.habitatMoved ? 'Moved from the landing site.' : p.habitat.summary} Drag the H marker on the map, or
          enter coordinates.
        </p>
        <CoordForm
          key={`${p.habitat.lat},${p.habitat.lon}`}
          bounds={p.bounds}
          start={p.habitat}
          submit="Apply"
          onSubmit={p.onMoveHabitat}
        />
        <button type="button" className="link" disabled={!p.habitatMoved} onClick={p.onResetHabitat}>
          Reset to landing site
        </button>
      </section>

      <section className="panel">
        <h2>Suggested targets</h2>
        <ul className="targets">
          {site.targets.map((t) => (
            <li key={t.id} className={p.focusId === t.id ? 'is-focus' : ''}>
              <label>
                <input type="checkbox" checked={p.selected.has(t.id)} onChange={() => p.onToggle(t.id)} />
                <span>
                  <strong>{t.name}</strong>
                  <small>{t.summary}</small>
                </span>
              </label>
              <button type="button" className="link" onClick={() => p.onFocus(t.id)}>
                View
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Your points</h2>
        {p.custom.length > 0 && (
          <ul className="targets">
            {p.custom.map((t) => (
              <li key={t.id} className={p.focusId === t.id ? 'is-focus' : ''}>
                <label>
                  <input type="checkbox" checked={p.selected.has(t.id)} onChange={() => p.onToggle(t.id)} />
                  <span>
                    <strong>{t.name}</strong>
                    <small>{t.summary}</small>
                  </span>
                </label>
                <button type="button" className="link" onClick={() => p.onFocus(t.id)}>
                  View
                </button>
                <button type="button" className="link" onClick={() => p.onRemovePoint(t.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={`toggle${p.adding ? ' is-active' : ''}`}
          aria-pressed={p.adding}
          onClick={() => p.onAdding(!p.adding)}
        >
          {p.adding ? 'Click the map to place the point (Esc cancels)' : 'Add point on map'}
        </button>
        <CoordForm bounds={p.bounds} submit="Add" clearOnDone onSubmit={p.onAddPoint} />
        {p.notice && <p className="alert alert--bad">{p.notice}</p>}
      </section>

      {focus && (
        <StopCard
          stop={focus}
          view={focusView}
          onClose={() => p.onFocus(null)}
          onRemove={focusIsCustom ? () => p.onRemovePoint(focus.id) : undefined}
        />
      )}

      <RoutePanel
        planner={planner}
        plan={p.plan}
        profile={p.profile}
        mobility={p.mobility}
        stops={stops}
        onProfile={p.onProfile}
      />
      <SafetyPanel plan={p.plan} />
    </aside>
  )
}

/** Latitude and longitude inputs with one button. Says under the inputs why a typed value is not accepted. */
function CoordForm(p: {
  bounds: Bounds | null
  start?: LatLon
  submit: string
  /** Empty the inputs after a successful submit. */
  clearOnDone?: boolean
  /** Returns null when done, or the reason the point was refused. */
  onSubmit: (point: LatLon) => string | null
}) {
  const [lat, setLat] = useState(p.start ? p.start.lat.toFixed(5) : '')
  const [lon, setLon] = useState(p.start ? p.start.lon.toFixed(5) : '')
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="coords"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        const parsed = parsePoint(p.bounds, lat, lon)
        // A refusal from `onSubmit` is shown by the caller; here only what is wrong with the typed values.
        setError(parsed.ok ? null : parsed.error)
        const problem = parsed.ok ? p.onSubmit(parsed.point) : parsed.error
        if (!problem && p.clearOnDone) {
          setLat('')
          setLon('')
        }
      }}
    >
      <label>
        Lat °N
        <input type="number" step="any" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
      </label>
      <label>
        Lon °E
        <input type="number" step="any" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
      </label>
      <button type="submit">{p.submit}</button>
      {error && <p className="coords-error">{error}</p>}
    </form>
  )
}

function StopCard(p: { stop: Target; view?: StopView; onClose: () => void; onRemove?: () => void }) {
  const { stop, view, onClose } = p
  return (
    <section className="panel card">
      <header>
        <h2>{stop.name}</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>
      {view && (
        <figure>
          <img src={view.file} alt={`Ground view near ${stop.name}`} />
          <figcaption>
            {view.camera}, sol {view.sol}
            {view.distanceM > 20 ? `, taken ${view.distanceM} m from this spot` : ''}. {view.credit}
          </figcaption>
        </figure>
      )}
      <dl>
        <dt>Why</dt>
        <dd>{stop.science}</dd>
        {stop.task && (
          <>
            <dt>Task</dt>
            <dd>{stop.task}</dd>
          </>
        )}
        <dt>Position</dt>
        <dd>
          {stop.lat.toFixed(5)}° N, {stop.lon.toFixed(5)}° E
        </dd>
      </dl>
      {p.onRemove && (
        <button type="button" className="link" onClick={p.onRemove}>
          Remove point
        </button>
      )}
    </section>
  )
}

function RoutePanel({
  planner,
  plan,
  profile,
  mobility,
  stops,
  onProfile,
}: Pick<Props, 'planner' | 'plan' | 'profile' | 'mobility' | 'onProfile'> & { stops: Map<string, Target> }) {
  const { plans, planning, error } = planner
  const m = MOBILITY[mobility]
  const routed = plan !== null && plan.legs.length > 0
  return (
    <section className="panel">
      <h2>Route {planning && <small className="muted">calculating…</small>}</h2>
      {error && <p className="alert alert--bad">Route planning failed: {error}</p>}
      {!plan && !error && !planning && <p className="muted">Choose at least one target.</p>}
      {plans && routed && plans.gentleIsSame && (
        <p className="muted">No gentler route here: the fastest one already keeps to the easiest ground.</p>
      )}
      {plans && routed && !plans.gentleIsSame && (
        <div className="segmented options" role="group" aria-label="Which route">
          {(['fast', 'gentle'] as const).map((id) => {
            const option = plans[id]
            return (
              <button
                key={id}
                type="button"
                className={id === profile ? 'is-active' : ''}
                aria-pressed={id === profile}
                onClick={() => onProfile(id)}
              >
                {ROUTE_LABELS[id]}
                {!option.fitsOneEva && <em className="tag">over {m.maxEvaHours} h</em>}
                <small>{duration(option.totalMinutes)} outside</small>
                <small>
                  {km(option.distanceM)} · steepest {option.maxSlopeDeg.toFixed(0)}°
                </small>
                <small>{Math.round(option.steepM / 10) * 10} m on steep ground</small>
              </button>
            )
          })}
        </div>
      )}
      {plan && (
        <>
          {plan.habitatNoFooting && (
            <p className="alert alert--bad">
              The habitat stands on ground steeper than {m.maxSlopeDeg}° (or without elevation data). Move it.
            </p>
          )}
          {!plan.habitatNoFooting && plan.unreachable.length > 0 && (
            <p className="alert alert--bad">
              {plan.unreachable
                .map((id) => {
                  const name = stops.get(id)?.name ?? id
                  return plan.unreachableWhy[id] === 'no-footing'
                    ? `${name} stands on ground steeper than ${m.maxSlopeDeg}° (or without elevation data).`
                    : `No safe path to ${name}: slopes on the way exceed ${m.maxSlopeDeg}°.`
                })
                .join(' ')}
            </p>
          )}
          {plan.legs.length > 0 && !plan.fitsOneEva && (
            <p className="alert alert--bad">
              Too long for one excursion: {duration(plan.totalMinutes)} against a {m.maxEvaHours} h limit. Remove
              stops{mobility === 'walk' ? ' or take the crew rover' : ''}.
            </p>
          )}
          {plan.legs.length > 0 && plan.fitsOneEva && (
            <p className="alert alert--ok">
              Fits one excursion with {duration(m.maxEvaHours * 60 - plan.totalMinutes)} to spare.
            </p>
          )}
          {plan.legs.length > 0 && (
            <>
              <div className="stats">
                <Stat label="Distance" value={km(plan.distanceM)} />
                <Stat label="Time outside" value={duration(plan.totalMinutes)} />
                <Stat label="Climb" value={`${Math.round(plan.ascentM)} m`} />
                <Stat label="Steepest" value={`${plan.maxSlopeDeg.toFixed(1)}°`} />
              </div>
              <p className="muted">
                {duration(plan.travelMinutes)} moving, {duration(plan.stopMinutes)} working at stops.
              </p>
              <ol className="legs">
                {plan.legs.map((leg, i) => (
                  <li key={i}>
                    <span>{stops.get(leg.toId)?.name}</span>
                    <small>
                      {km(leg.distanceM)} · {duration(leg.minutes)} · max {leg.maxSlopeDeg.toFixed(0)}°
                    </small>
                    {leg.notes.length > 0 && (
                      <ul className="leg-notes">
                        {leg.notes.map((note, k) => (
                          <li key={k}>
                            <i className={`note note--${note.kind}`}>{NOTE_SIGNS[note.kind]}</i>
                            {note.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
          {planner.terrainSource && <p className="source">Terrain: {planner.terrainSource}</p>}
        </>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SafetyPanel({ plan }: { plan: RoutePlan | null }) {
  const hours = (plan?.totalMinutes ?? 0) / 60
  const dose = evaDoseMsv(hours)
  return (
    <section className="panel">
      <h2>Safety</h2>
      <div className="stats">
        <Stat label="Dose this excursion" value={hours > 0 ? `${dose.toFixed(2)} mSv` : '—'} />
        <Stat label="Surface dose rate" value={`${SURFACE_DOSE_MSV_PER_DAY} mSv/day`} />
      </div>
      <p className="muted">
        {hours > 0 && (
          <>
            Equal to {Math.round(dose / EARTH_BACKGROUND_MSV_PER_DAY)} days of natural background on Earth, and{' '}
            {((dose / CAREER_LIMIT_MSV) * 100).toFixed(2)}% of NASA’s {CAREER_LIMIT_MSV} mSv career limit.{' '}
          </>
        )}
        Assumes quiet space weather. A solar particle event can raise the dose sharply: check the forecast before
        leaving the habitat.
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
