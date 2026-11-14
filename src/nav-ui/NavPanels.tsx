import { useEffect, useState, type ReactNode } from 'react'
import type { MobilityId, RoutePlan, RoutePlans, RouteProfile, StopView, Target } from '../types.ts'
import { duration, km } from '../lib/format.ts'
import { MOBILITY, ROUTE_LABELS } from '../lib/mobility.ts'
import { evaDoseMsv, HAZARD_EVENTS, WALK_BACK_RESERVE_MIN, type HazardKind } from '../lib/safety.ts'
import { clock, farthestWalkHome } from '../lib/schedule.ts'
import type { NavState, UpcomingManeuver } from '../nav/events.ts'
import { spokenDistance, type Maneuver } from '../nav/instructions.ts'
import type { NavRunControls, NavRunView } from './useNavRun.ts'

/** Clock time of a Date.now() value, hh:mm. */

const TURN_ANGLE: Record<string, number> = {
  slight_left: -45, left: -90, sharp_left: -135, slight_right: 45, right: 90, sharp_right: 135,
}

/** Arrow for a turn or "go straight", a flag for arrival, a triangle for a hazard. */
export function ManeuverIcon({ m, size = 64 }: { m: Maneuver | undefined; size?: number }) {
  if (!m) return null
  if (m.kind === 'hazard') {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 5 L45 42 H3 Z" fill="var(--warn)" />
        <path d="M24 18 V30 M24 35 V36" stroke="#1a0e06" strokeWidth="4.5" strokeLinecap="round" />
      </svg>
    )
  }
  if (m.kind === 'arrive' || m.kind === 'arrive_home') {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 44 V6" />
        <path d="M12 8 H38 L32 16 L38 24 H12" fill="currentColor" />
      </svg>
    )
  }
  const angle = m.modifier ? TURN_ANGLE[m.modifier] : 0
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M24 44 V26" />
      <g transform={`rotate(${angle} 24 26)`}>
        <path d="M24 26 V6" />
        <path d="M14 15 L24 5 L34 15" />
      </g>
    </svg>
  )
}

/** The big instruction across the top of the map, and the one after it. */
export function Banner({ upcoming, state }: { upcoming: UpcomingManeuver[]; state: NavState }) {
  const actionable = upcoming.filter((u) => u.maneuver.kind !== 'hazard')
  const next = actionable[0]
  const then = actionable[1]
  if (state.status === 'rerouting') return <div className="banner banner--warn">Planning a new route…</div>
  if (state.status === 'off_route') {
    return <div className="banner banner--bad">Off route by {spokenDistance(state.offsetM)}. Head back to the line.</div>
  }
  if (!next || state.status === 'at_stop' || state.status === 'finished') return null
  return (
    <div className="banner" role="status">
      <div className="banner-main">
        <ManeuverIcon m={next.maneuver} />
        <div>
          {/* Departures and "keep going" lines carry their distance in the text. */}
          {next.maneuver.kind !== 'depart' && next.maneuver.kind !== 'continue' && (
            <div className="banner-dist num">{spokenDistance(next.distanceM)}</div>
          )}
          <div className="banner-text">{next.maneuver.text}</div>
        </div>
      </div>
      {then && (
        <div className="banner-then">
          <ManeuverIcon m={then.maneuver} size={28} />
          Then: {then.maneuver.text}
        </div>
      )}
    </div>
  )
}

interface PlanPanelProps {
  targets: Target[]
  selected: string[]
  maxSelected: number
  mobility: MobilityId
  profile: RouteProfile
  plans: RoutePlans | null
  plan: RoutePlan | null
  planning: boolean
  error: string | null
  onToggle: (id: string) => void
  onMobility: (m: MobilityId) => void
  onProfile: (p: RouteProfile) => void
  onStart: () => void
  /** The offline download panel, shown above the start button. */
  offline?: ReactNode
}

/** Before departure: what to visit, how, and whether it is safe. */
export function PlanPanel(p: PlanPanelProps) {
  const m = MOBILITY[p.mobility]
  const routed = p.plan !== null && p.plan.legs.length > 0
  const farthest = routed ? farthestWalkHome(p.plan!) : null
  const full = p.selected.length >= p.maxSelected
  return (
    <div className="nav-scroll">
      <h1 className="nav-title">Plan the excursion</h1>
      <div className="seg" role="group" aria-label="How the crew moves">
        {(['walk', 'rover'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={p.mobility === id} onClick={() => p.onMobility(id)}>
            {MOBILITY[id].label}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Which route">
        {(['fast', 'gentle'] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={p.profile === id}
            disabled={id === 'gentle' && p.plans?.gentleIsSame}
            onClick={() => p.onProfile(id)}
          >
            {ROUTE_LABELS[id]}
          </button>
        ))}
      </div>
      <ul className="targets">
        {p.targets.map((t) => {
          const on = p.selected.includes(t.id)
          const order = p.plan?.order.indexOf(t.id) ?? -1
          return (
            <li key={t.id}>
              <button type="button" aria-pressed={on} disabled={!on && full} onClick={() => p.onToggle(t.id)}>
                <span className="tick">{on ? (order > 0 ? order : '✓') : '+'}</span>
                <span>
                  <strong>{t.name}</strong>
                  <small>{t.summary}</small>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="plan-summary" aria-live="polite">
        {p.planning && <p className="chip chip--warn">Planning the route…</p>}
        {p.error && <p className="chip chip--bad">Route planning failed. {p.error}</p>}
        {!p.planning && p.selected.length === 0 && <p className="muted">Pick at least one stop.</p>}
        {routed && (
          <div className="figures-big">
            <div><span>Time outside</span><strong className="num">{duration(p.plan!.totalMinutes)}</strong></div>
            <div><span>Distance</span><strong className="num">{km(p.plan!.distanceM)}</strong></div>
            <div><span>Dose</span><strong className="num">{evaDoseMsv(p.plan!.totalMinutes / 60).toFixed(2)} mSv</strong></div>
          </div>
        )}
        {routed && !p.plan!.fitsOneEva && (
          <p className="chip chip--bad">Too long for one excursion: over the {m.maxEvaHours} h limit.</p>
        )}
        {farthest && farthest.minutes > WALK_BACK_RESERVE_MIN && (
          <p className="chip chip--warn">
            Farthest point is {duration(farthest.minutes)} on foot from the habitat, beyond the {WALK_BACK_RESERVE_MIN} min reserve.
          </p>
        )}
        {p.plan && p.plan.unreachable.length > 0 && (
          <p className="chip chip--bad">No safe path to {p.plan.unreachable.length} stop(s); they are left out.</p>
        )}
      </div>
      {p.offline}
      <button type="button" className="big big--primary" disabled={!routed || p.planning} onClick={p.onStart}>
        Start navigation
      </button>
    </div>
  )
}

function StatusChip({ state }: { state: NavState }) {
  if (state.status === 'rerouting') return <span className="chip chip--warn">Rerouting…</span>
  if (state.status === 'at_stop') return <span className="chip chip--ok">At stop</span>
  if (state.status === 'finished') return <span className="chip chip--ok">Finished</span>
  if (state.status === 'off_route' || !state.onRoute) {
    return <span className="chip chip--bad">Off route {state.offsetM} m</span>
  }
  return <span className="chip chip--ok">On route</span>
}

interface NavPanelProps {
  view: NavRunView
  stops: Record<string, Target>
}

/** While navigating: what is next, how far, how safe, and what was said. */
export function NavPanel({ view, stops }: NavPanelProps) {
  const { state } = view
  const nextStop = state.nextStopId ? stops[state.nextStopId] : null
  const far = state.walkHomeMin !== null && state.walkHomeMin > WALK_BACK_RESERVE_MIN
  return (
    <div className="nav-scroll">
      <div className="nav-head">
        <StatusChip state={state} />
        <span className="muted num" title="Local mean solar time at Jezero">Mars time {clock(view.lmst)}</span>
      </div>
      <section className="next-stop">
        <span className="label">Next stop</span>
        <strong>{nextStop?.name ?? '—'}</strong>
        <p className="num">
          {km(state.legRemainingM)} · ETA {clock(view.lmst + state.legRemainingMin)}
        </p>
      </section>
      <div className="figures-big">
        <div><span>Route left</span><strong className="num">{km(state.routeRemainingM)}</strong></div>
        <div><span>Time left</span><strong className="num">{duration(state.routeRemainingMin)}</strong></div>
        <div className={far ? 'is-bad' : ''}>
          <span>Walk home</span>
          <strong className="num">{state.walkHomeMin === null ? '—' : duration(state.walkHomeMin)}</strong>
        </div>
      </div>
      <section>
        <h2 className="label">Captions</h2>
        <ol className="captions" aria-live="polite">
          {view.log.map((e) => (
            <li key={`${e.id}-${e.at}`} className={`cap cap--${e.priority}`}>{e.text}</li>
          ))}
        </ol>
      </section>
      <section>
        <h2 className="label">Ahead</h2>
        <ol className="ahead">
          {view.upcoming.slice(0, 12).map((u) => (
            <li key={u.maneuver.id}>
              <ManeuverIcon m={u.maneuver} size={28} />
              <span className="num">{spokenDistance(u.distanceM)}</span>
              <span>{u.maneuver.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

/** End navigation, with a confirm step. Sits below the panel, so stop cards never cover it. */
export function EndControl({ onEnd }: { onEnd: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return confirming ? (
    <div className="confirm">
      <button type="button" className="big big--danger" onClick={onEnd}>Yes, end</button>
      <button type="button" className="big" onClick={() => setConfirming(false)}>Keep going</button>
    </div>
  ) : (
    <button type="button" className="big" onClick={() => setConfirming(true)}>End navigation</button>
  )
}

const SPEEDS = [1, 10, 60]

/**
 * Demo controls for the simulated walker, floating on the map. Clearly marked as simulation,
 * and folds into a small pill so it never hides the route for long.
 */
export function SimBar({ view, controls }: { view: NavRunView; controls: NavRunControls }) {
  const [open, setOpen] = useState(true)
  if (!open) {
    return (
      <button type="button" className="sim-pill" onClick={() => setOpen(true)} aria-label="Show simulation controls">
        SIMULATION · {view.speed}×
      </button>
    )
  }
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(view.speed) + 1) % SPEEDS.length]
  return (
    <section className="sim-bar" aria-label="Simulation">
      <button type="button" className="sim-fold" onClick={() => setOpen(false)} aria-label="Hide simulation controls">
        SIMULATION ▾
      </button>
      <button type="button" onClick={view.playing ? controls.pause : controls.play}>
        {view.playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" onClick={() => controls.setSpeed(nextSpeed)} aria-label={`Speed ${view.speed}×, tap for ${nextSpeed}×`}>
        {view.speed}×
      </button>
      <button type="button" onClick={() => controls.drift(40)}>Drift 40</button>
      <button type="button" onClick={() => controls.drift(90)}>Drift 90</button>
      <button type="button" onClick={controls.backToRoute}>Back</button>
      {(Object.keys(HAZARD_EVENTS) as HazardKind[]).map((kind) => (
        <button
          key={kind}
          type="button"
          className="sim-hazard"
          disabled={view.state.abort !== null}
          onClick={() => controls.hazard(kind)}
        >
          {HAZARD_EVENTS[kind].label}
        </button>
      ))}
    </section>
  )
}

/** Full-height card while the crew works at a stop. */
export function StopCard({ view, stop, photo, onContinue }: {
  view: NavRunView
  stop: Target | undefined
  photo: StopView | undefined
  onContinue: () => void
}) {
  const minutes = MOBILITY[view.plan.mobility].stopMinutes
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const leftMs = Math.max(0, minutes * 60000 - (view.missionNow - (view.arrivedAt ?? view.missionNow)))
  const mm = Math.floor(leftMs / 60000)
  const ss = Math.floor((leftMs % 60000) / 1000)
  return (
    <div className="overlay-card">
      {photo && <img src={photo.file} alt={`Ground view near ${stop?.name ?? 'the stop'}`} />}
      {photo && <p className="source">{photo.camera}, sol {photo.sol} · {photo.credit}</p>}
      <h1 className="nav-title">{stop?.name ?? 'Stop'}</h1>
      {stop?.task && <p className="task"><span className="label">Task</span>{stop.task}</p>}
      {stop?.science && <p className="muted">{stop.science}</p>}
      <p className="countdown num" aria-live="off">
        {leftMs > 0 ? `${mm}:${String(ss).padStart(2, '0')} of ${minutes} min planned` : 'Planned time is up'}
      </p>
      <button type="button" className="big big--primary" onClick={onContinue}>Done — continue</button>
    </div>
  )
}

/** Back at the habitat. */
export function FinishedCard({ view, onAgain }: { view: NavRunView; onAgain: () => void }) {
  return (
    <div className="overlay-card">
      <h1 className="nav-title">Excursion complete</h1>
      <div className="figures-big">
        <div><span>Time taken</span><strong className="num">{duration((view.missionNow - view.missionStart) / 60000)}</strong></div>
        <div><span>Distance</span><strong className="num">{km(view.walkedM)}</strong></div>
        <div><span>Reroutes</span><strong className="num">{view.state.rerouteCount}</strong></div>
      </div>
      <p className="muted">Times use the simulated mission clock.</p>
      <button type="button" className="big big--primary" onClick={onAgain}>Plan another</button>
    </div>
  )
}
