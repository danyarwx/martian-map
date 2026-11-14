import type { MobilityId, SiteConfig, StopView, Target } from '../types.ts'
import type { PlannerState } from '../lib/usePlanner.ts'
import { NOTE_SIGNS } from '../lib/explain.ts'
import { MOBILITY } from '../lib/mobility.ts'
import {
  CAREER_LIMIT_MSV,
  EARTH_BACKGROUND_MSV_PER_DAY,
  evaDoseMsv,
  JEZERO_CONDITIONS,
  SURFACE_DOSE_MSV_PER_DAY,
} from '../lib/safety.ts'

interface Props {
  site: SiteConfig
  mobility: MobilityId
  selected: ReadonlySet<string>
  focusId: string | null
  planner: PlannerState
  views: Record<string, StopView>
  onMobility: (m: MobilityId) => void
  onToggle: (id: string) => void
  onFocus: (id: string | null) => void
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`
function duration(minutes: number) {
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')} min`
}

export default function Sidebar(p: Props) {
  const { site, planner } = p
  const stops = new Map<string, Target>([site.habitat, ...site.targets].map((s) => [s.id, s]))
  const focus = p.focusId ? stops.get(p.focusId) : undefined

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
        <h2>Targets</h2>
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

      {focus && <StopCard stop={focus} view={p.views[focus.id]} onClose={() => p.onFocus(null)} />}

      <RoutePanel {...p} stops={stops} />
      <SafetyPanel planner={planner} />
    </aside>
  )
}

function StopCard({ stop, view, onClose }: { stop: Target; view?: StopView; onClose: () => void }) {
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
        <dt>Task</dt>
        <dd>{stop.task}</dd>
        <dt>Position</dt>
        <dd>
          {stop.lat.toFixed(5)}° N, {stop.lon.toFixed(5)}° E
        </dd>
      </dl>
    </section>
  )
}

function RoutePanel({ planner, mobility, stops }: Props & { stops: Map<string, Target> }) {
  const { plan, planning, error } = planner
  const m = MOBILITY[mobility]
  return (
    <section className="panel">
      <h2>Route {planning && <small className="muted">calculating…</small>}</h2>
      {error && <p className="alert alert--bad">Route planning failed: {error}</p>}
      {!plan && !error && !planning && <p className="muted">Choose at least one target.</p>}
      {plan && (
        <>
          {plan.unreachable.length > 0 && (
            <p className="alert alert--bad">
              No safe path for {m.label.toLowerCase()} to: {plan.unreachable.map((id) => stops.get(id)?.name).join(', ')}.
              Slopes on the way exceed {m.maxSlopeDeg}°.
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

function SafetyPanel({ planner }: { planner: PlannerState }) {
  const hours = (planner.plan?.totalMinutes ?? 0) / 60
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
