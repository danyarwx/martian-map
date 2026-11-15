import { useEffect, useState, type ReactNode } from 'react'
import type { MobilityId, RoutePlan, RoutePlans, RouteProfile, Target } from '../types.ts'
import { duration, km } from '../lib/format.ts'
import { MOBILITY, ROUTE_LABELS } from '../lib/mobility.ts'
import { evaDoseMsv, HAZARD_EVENTS, WALK_BACK_RESERVE_MIN, type HazardKind } from '../lib/safety.ts'
import { farthestWalkHome } from '../lib/schedule.ts'
import type { NavState, UpcomingManeuver } from '../nav/events.ts'
import { GPS_WARN_ACCURACY_M, type GpsStatus } from '../nav/gps.ts'
import { compassShort } from '../nav/geometry.ts'
import { spokenDistance, type Maneuver } from '../nav/instructions.ts'
import { conditions } from '../nav/conditions.ts'
import type { NavRunControls, NavRunView } from './useNavRun.ts'

/** Clock time of a Date.now() value, hh:mm. */

const TURN_ANGLE: Record<string, number> = {
  slight_left: -25, bear_left: -45, left: -90, sharp_left: -135,
  slight_right: 25, bear_right: 45, right: 90, sharp_right: 135,
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

/** What the banner shows for a maneuver: arrivals without their task (the voice and the stop card have it). */
const bannerText = (m: Maneuver) => (m.kind === 'arrive' ? m.text.split(' Task:')[0] : m.text)

/** The big instruction across the top of the map, and the one after it. */
/**
 * The turn banner. While a hazard warning is active and the crew chose to continue, a red strip under it
 * ("⚠ Dust storm · Go to base") reopens the hazard popup.
 */
export function Banner({ upcoming, state, onHazard }: { upcoming: UpcomingManeuver[]; state: NavState; onHazard?: () => void }) {
  const strip =
    state.hazard && state.hazardDismissed ? (
      <button type="button" className="hazard-strip" onClick={onHazard}>
        ⚠ {HAZARD_EVENTS[state.hazard].label} · Go to base
      </button>
    ) : null
  return <BannerBody upcoming={upcoming} state={state} strip={strip} />
}

function BannerBody({ upcoming, state, strip }: { upcoming: UpcomingManeuver[]; state: NavState; strip: ReactNode }) {
  const actionable = upcoming.filter((u) => u.maneuver.kind !== 'hazard')
  const next = actionable[0]
  const then = actionable[1]
  if (state.status === 'rerouting') return <div className="banner banner--warn">Planning a new route…{strip}</div>
  if (state.status === 'off_route') {
    return <div className="banner banner--bad">Off route by {spokenDistance(state.offsetM)}. Head back to the line.{strip}</div>
  }
  if (!next || state.status === 'at_stop' || state.status === 'finished') {
    return strip && state.status !== 'finished' ? <div className="banner banner--bad">{strip}</div> : null
  }
  const heading = state.routeHeadingDeg === null ? null : Math.round(state.routeHeadingDeg) % 360
  return (
    <div className={`banner${state.drifting ? ' banner--warn' : ''}`} role="status">
      {heading !== null && (
        <div className="banner-heading num">
          Head {heading}° {compassShort(heading)}
          {state.drifting && <span> · drifting {state.drifting}, correct {state.drifting === 'left' ? 'right' : 'left'}</span>}
        </div>
      )}
      <div className="banner-main">
        <ManeuverIcon m={next.maneuver} />
        <div>
          {/* Departures and "keep going" lines carry their distance in the text. */}
          {next.maneuver.kind !== 'depart' && next.maneuver.kind !== 'continue' && (
            <div className="banner-dist num">{spokenDistance(next.distanceM)}</div>
          )}
          <div className="banner-text">{bannerText(next.maneuver)}</div>
        </div>
      </div>
      {then && (
        <div className="banner-then">
          <ManeuverIcon m={then.maneuver} size={28} />
          Then: {bannerText(then.maneuver)}
        </div>
      )}
      {strip}
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
      <button type="button" className="big big--primary" disabled={!routed || p.planning} onClick={p.onStart}>
        Start navigation
      </button>
    </div>
  )
}

interface NavPanelProps {
  view: NavRunView
  stops: Record<string, Target>
}

/** One "how far, how long" row of the navigation panel. */
function TripRow({ label, name, metres, minutes, bad, warn, note, children }: {
  label: string
  name?: string
  metres: number | null
  minutes: number | null
  bad?: boolean
  /** A caution (amber), e.g. beyond the walk-back reserve. */
  warn?: boolean
  note?: string
  children?: ReactNode
}) {
  return (
    <section className={`trip-row${bad ? ' is-bad' : warn ? ' is-warn' : ''}`}>
      <span className="label">{label}</span>
      {name && <strong className="trip-name">{name}</strong>}
      <div className="trip-line">
        <p className="trip-figures num">
          <span>{metres === null ? '…' : km(metres)}</span>
          <span>{minutes === null ? '…' : duration(minutes)}</span>
        </p>
        {children}
      </div>
      {note && <p className="trip-note">{note}</p>}
    </section>
  )
}

/** Time limits and typical conditions, as small tiles. Only the time limits turn amber or red. */
function ConditionsGrid({ view, returning }: { view: NavRunView; returning: boolean }) {
  const { state } = view
  const tiles = conditions({
    lmst: view.lmst,
    minutesOut: (view.missionNow - view.missionStart) / 60000,
    routeRemainingMin: state.routeRemainingMin,
    turnBackLmst: view.turnBackLmst,
    returning,
    finished: state.status === 'finished',
  })
  return (
    <section aria-label="Conditions" title="Typical sol from Perseverance MEDA data, not a forecast">
      <div className="cond-grid">
        {tiles.map((t) => (
          <div key={t.id} className={`cond-tile is-${t.level}`}>
            <span className="label">{t.label}</span>
            <strong className="num">{t.value}</strong>
            {t.note && <span className="cond-note num">{t.note}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}

/** "Go to base" in the Back-to-base row, with a confirm step: a glove tap must not drop the stops left. */
function GoToBase({ onReturn }: { onReturn: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <button type="button" className="big big--danger base-go" aria-expanded={confirming} onClick={() => setConfirming((c) => !c)}>
        Go to base
      </button>
      {confirming && (
        <div className="base-confirm" role="dialog" aria-label="Return to base?">
          <strong>Return to base now?</strong>
          <p>The stops left are skipped.</p>
          <div className="confirm">
            <button type="button" className="big big--danger" onClick={onReturn}>Yes, return</button>
            <button type="button" className="big" onClick={() => setConfirming(false)}>Keep going</button>
          </div>
        </div>
      )}
    </>
  )
}

/** While navigating: the next stop, all stops and back, and the way straight back to base. */
export function NavPanel({ view, stops, onReturn }: NavPanelProps & { onReturn?: () => void }) {
  const { state } = view
  const nextStop = state.nextStopId ? stops[state.nextStopId] : null
  const far = state.walkHomeMin !== null && state.walkHomeMin > WALK_BACK_RESERVE_MIN
  const returning = state.abort !== null
  const homeNext = state.nextStopId === view.plan.order[view.plan.order.length - 1]
  const canReturn = !!onReturn && !returning && !homeNext && state.status !== 'finished' && state.status !== 'idle'
  return (
    <div className="nav-scroll nav-scroll--run">
      <TripRow label="Next stop" name={nextStop?.name ?? '—'} metres={state.legRemainingM} minutes={state.legRemainingMin} />
      <TripRow label="All stops and back" metres={state.routeRemainingM} minutes={state.routeRemainingMin} />
      <TripRow
        label={returning ? 'Returning to base' : 'Back to base now'}
        metres={view.base?.distanceM ?? null}
        minutes={view.base?.minutes ?? null}
        warn={far}
        note={far && state.walkHomeMin !== null ? `Caution · walk home ${duration(state.walkHomeMin)}, reserve ${WALK_BACK_RESERVE_MIN} min` : undefined}
      >
        {canReturn && <GoToBase onReturn={onReturn} />}
      </TripRow>
      <ConditionsGrid view={view} returning={returning || homeNext} />
    </div>
  )
}

/** Floating on the map while the panel is hidden: the next stop, how far and how long. */
export function NextStopCard({ view, stops }: NavPanelProps) {
  const { state } = view
  const nextStop = state.nextStopId ? stops[state.nextStopId] : null
  return (
    <section className="next-card" aria-label="Next stop">
      <span className="label">Next stop</span>
      <strong>{nextStop?.name ?? '—'}</strong>
      <p className="num">{km(state.legRemainingM)} · {duration(state.legRemainingMin)}</p>
    </section>
  )
}

/** End navigation: a red icon on the map, with a confirm step in a bubble next to it. */
export function EndOnMap({ onEnd }: { onEnd: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <button
        type="button"
        className="map-fab end-fab"
        aria-expanded={confirming}
        aria-label="End navigation"
        title="End navigation"
        onClick={() => setConfirming((c) => !c)}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path d="M6 6 18 18M18 6 6 18" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </button>
      {confirming && (
        <div className="end-bubble" role="dialog" aria-label="End navigation?">
          <strong>End navigation?</strong>
          <div className="confirm">
            <button type="button" className="big big--danger" onClick={onEnd}>Yes, end</button>
            <button type="button" className="big" onClick={() => setConfirming(false)}>Keep going</button>
          </div>
        </div>
      )}
    </>
  )
}

const SPEEDS = [1, 10, 60]

/**
 * Demo controls for the simulated walker, floating on the map. Clearly marked as simulation,
 * and folds into a small pill so it never hides the route for long.
 */
/** What the GPS is doing, for the SIMULATION bar. */
function gpsLabel(g: GpsStatus | null): { text: string; warn: boolean } {
  if (!g || g.kind === 'waiting') return { text: 'GPS: waiting for a fix…', warn: true }
  if (g.kind === 'error') return { text: `GPS: ${g.message}`, warn: true }
  const m = Math.round(g.accuracyM)
  if (g.kind === 'weak') return { text: `GPS weak ±${m} m, not used`, warn: true }
  return { text: `GPS ±${m} m`, warn: g.accuracyM > GPS_WARN_ACCURACY_M }
}

export function SimBar({ view, controls }: { view: NavRunView; controls: NavRunControls }) {
  const [open, setOpen] = useState(true)
  if (!open) {
    return (
      <button type="button" className="sim-pill" onClick={() => setOpen(true)} aria-label="Show simulation controls">
        {view.source === 'gps' ? 'EARTH GPS' : `SIMULATION · ${view.speed}×`}
      </button>
    )
  }
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(view.speed) + 1) % SPEEDS.length]
  const gps = view.source === 'gps' ? gpsLabel(view.gps) : null
  return (
    <section className="sim-bar" aria-label="Simulation">
      <button type="button" className="sim-fold" onClick={() => setOpen(false)} aria-label="Hide simulation controls">
        {gps ? 'EARTH GPS ▾' : 'SIMULATION ▾'}
      </button>
      {gps ? (
        <>
          <span className={`sim-gps${gps.warn ? ' sim-gps--warn' : ''}`} role="status">{gps.text}</span>
          <button type="button" onClick={() => controls.setSource('sim')}>Simulation</button>
        </>
      ) : (
        <>
          <button type="button" onClick={view.playing ? controls.pause : controls.play}>
            {view.playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={() => controls.setSpeed(nextSpeed)} aria-label={`Speed ${view.speed}×, tap for ${nextSpeed}×`}>
            {view.speed}×
          </button>
          <button type="button" onClick={() => controls.drift(40)}>Drift 40</button>
          <button type="button" onClick={() => controls.drift(90)}>Drift 90</button>
          <button type="button" onClick={controls.backToRoute}>Back</button>
          <button
            type="button"
            onClick={() => controls.setSource('gps')}
            title="Walk outside: 1 metre on Earth = 1 metre on Mars, starting where the arrow is now"
          >
            Real GPS
          </button>
        </>
      )}
      {(Object.keys(HAZARD_EVENTS) as HazardKind[]).map((kind) => (
        <button
          key={kind}
          type="button"
          className="sim-hazard"
          disabled={view.state.abort !== null || view.state.hazard !== null}
          onClick={() => controls.hazard(kind)}
        >
          {HAZARD_EVENTS[kind].label}
        </button>
      ))}
    </section>
  )
}

/** Full-height card while the crew works at a stop. */
export function StopCard({ view, stop, onContinue }: {
  view: NavRunView
  stop: Target | undefined
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
      <span className="label">At stop</span>
      <h1 className="nav-title">{stop?.name ?? 'Stop'}</h1>
      {stop?.task && (
        <section className="trip-row">
          <span className="label">Task</span>
          <p className="stop-text">{stop.task}</p>
        </section>
      )}
      {stop?.science && (
        <section className="trip-row">
          <span className="label">Why here</span>
          <p className="stop-text">{stop.science}</p>
        </section>
      )}
      <section className="trip-row">
        <span className="label">Time at the stop</span>
        <p className="countdown num" aria-live="off">
          {leftMs > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : 'Time is up'}
        </p>
        <p className="stop-text muted">{minutes} min planned</p>
      </section>
      <button type="button" className="big big--primary" onClick={onContinue}>Done — continue</button>
    </div>
  )
}

/** Back at the habitat. */
/**
 * Dust storm or solar flare: a large card on the map. The crew chooses: the fastest route home, or keep
 * going (a red strip in the banner and spoken reminders follow).
 */
export function HazardPopup({ view, onGo, onContinue }: { view: NavRunView; onGo: () => void; onContinue: () => void }) {
  const kind = view.state.hazard
  if (!kind) return null
  return (
    <div className="hazard-popup" role="alertdialog" aria-label={`${HAZARD_EVENTS[kind].label} warning`}>
      <h2>⚠ {HAZARD_EVENTS[kind].label}</h2>
      <p className="stop-text">{HAZARD_EVENTS[kind].text}</p>
      <p className="hazard-home num">
        Base: {view.base ? `${km(view.base.distanceM)} · ${duration(view.base.minutes)}` : '…'}
      </p>
      <div className="confirm">
        <button type="button" className="big big--danger-solid" onClick={onGo}>Go to base</button>
        <button type="button" className="big" onClick={onContinue}>Continue route</button>
      </div>
    </div>
  )
}

export function FinishedCard({ view, stops, onAgain }: { view: NavRunView; stops: Record<string, Target>; onAgain: () => void }) {
  const { skipped, abort } = view.state
  const why = abort === 'crew' ? 'returned early' : abort ? HAZARD_EVENTS[abort].label.toLowerCase() : ''
  return (
    <div className="overlay-card">
      <h1 className="nav-title">Excursion complete</h1>
      <div className="figures-big">
        <div><span>Time taken</span><strong className="num">{duration((view.missionNow - view.missionStart) / 60000)}</strong></div>
        <div><span>Distance</span><strong className="num">{km(view.walkedM)}</strong></div>
        <div><span>Reroutes</span><strong className="num">{view.state.rerouteCount}</strong></div>
      </div>
      {skipped.length > 0 && (
        <p className="stop-text">
          <span className="label">Not visited</span>
          <br />
          {skipped.map((id) => stops[id]?.name ?? id).join(', ')} — {why}
        </p>
      )}
      <p className="muted">Times use the simulated mission clock.</p>
      <button type="button" className="big big--primary" onClick={onAgain}>Plan another</button>
    </div>
  )
}
