// Tablet navigation screen at /nav: plan the excursion, then follow it turn by turn.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JEZERO } from '../data/jezero.ts'
import { MOBILITY } from '../lib/mobility.ts'
import { usePlanner } from '../lib/usePlanner.ts'
import { useTerrainMeta } from '../lib/useTerrainMeta.ts'
import { displayPlan } from '../nav/display.ts'
import { getNavBus } from '../nav/events.ts'
import type { MobilityId, RouteProfile, StopView, Target } from '../types.ts'
import NavMap, { type NavProgress } from './NavMap.tsx'
import { Banner, EndOnMap, FinishedCard, NavPanel, NextStopCard, PlanPanel, SimBar, StopCard } from './NavPanels.tsx'
import { OfflineDownload } from './OfflineDownload.tsx'
import { DEMO_RUN, isDemo, parseNavParams } from './params.ts'
import { useNavRun, type NavRunInput } from './useNavRun.ts'
import { startVoice, type Voice } from './voice/index.ts'
import './nav.css'

const site = JEZERO
const MAX_SELECTED = 8
const NO_ORDER: string[] = []

/**
 * The service worker makes /nav work without a network. It is registered from here only; vite.config.ts says
 * why its scope is / and how the planning web app at / stays served from the network.
 */
function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('No offline support:', err))
}

/** True while the browser reports a network connection. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
/** While following, the map shows about this far ahead, metres: walking pace, and the faster rover. */
const AHEAD_WALK_M = 500
const AHEAD_ROVER_M = 1000

export default function NavApp() {
  const initial = useMemo(() => parseNavParams(window.location.search, site.targets.map((t) => t.id)), [])
  const demo = useMemo(() => isDemo(window.location.search), [])
  const [selected, setSelected] = useState<string[]>(initial.stopIds)
  const [mobility, setMobility] = useState<MobilityId>(initial.mobility)
  const [profile, setProfile] = useState<RouteProfile>(initial.profile)
  const [views, setViews] = useState<Record<string, StopView>>({})
  const [run, setRun] = useState<NavRunInput | null>(null)
  const [follow, setFollow] = useState(true)
  const [autoZoom, setAutoZoom] = useState(true)
  /** The crew chose north-up with the compass. Heading-up is the default while following. */
  const [northUp, setNorthUp] = useState(false)
  /** The side panel can be hidden while navigating, giving the map the whole screen. */
  const [panelOpen, setPanelOpen] = useState(true)
  const [muted, setMuted] = useState(false)
  const voice = useRef<Voice | null>(null)
  const online = useOnline()
  const terrainMeta = useTerrainMeta(site)
  useEffect(registerServiceWorker, [])

  const habitat = useMemo<Target>(
    () => (initial.home ? { ...site.habitat, ...initial.home, name: 'Habitat (moved)' } : site.habitat),
    [initial],
  )
  const allTargets = useMemo(() => [...site.targets, ...initial.points], [initial])
  const stopsById = useMemo<Record<string, Target>>(
    () => Object.fromEntries([habitat, ...allTargets].map((s) => [s.id, s])),
    [habitat, allTargets],
  )
  const targets = useMemo(() => allTargets.filter((t) => selected.includes(t.id)), [allTargets, selected])
  const planner = usePlanner(site, mobility, habitat, targets)
  const shown: RouteProfile = planner.plans?.gentleIsSame ? 'fast' : profile
  const plan = planner.plans ? planner.plans[shown] : null

  const { view, controls } = useNavRun(run)

  useEffect(() => {
    fetch(site.views)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setViews)
      .catch(() => setViews({}))
  }, [])

  // The voice listens to the bus for the whole session; muting only silences it.
  useEffect(() => {
    const v = startVoice(getNavBus())
    voice.current = v
    return () => {
      voice.current = null
      v.stop()
    }
  }, [])
  useEffect(() => voice.current?.setMuted(muted), [muted])

  const toggle = useCallback(
    (id: string) =>
      setSelected((list) =>
        list.includes(id) ? list.filter((x) => x !== id) : list.length >= MAX_SELECTED ? list : [...list, id],
      ),
    [],
  )

  const start = useCallback(() => {
    if (!plan) return
    voice.current?.radioCheck() // this tap is what unlocks audio in the browser
    setFollow(true)
    setAutoZoom(true)
    setNorthUp(false)
    setPanelOpen(true)
    setRun({ site, plan, habitat, stops: stopsById, mobility: MOBILITY[plan.mobility], demo: demo ? DEMO_RUN : undefined })
  }, [plan, habitat, stopsById, demo])

  const end = useCallback(() => {
    setRun(null)
    setPanelOpen(true)
  }, [])

  // What the map draws: the route being followed while navigating, else the planned one.
  const shownPlan = useMemo(() => (plan ? displayPlan(plan) : null), [plan])
  const mapPlan = run ? (view?.plan ?? null) : shownPlan
  const numbering = run ? run.plan.order : (plan?.order ?? NO_ORDER)
  // Joined into a string so the markers are rebuilt when a stop is reached, not on every position.
  const visitedKey = view?.state.visited.join(',') ?? ''
  const mapStops = useMemo(() => {
    const visited = visitedKey.split(',')
    return [
      { stop: habitat, label: 'H', done: false },
      ...numbering.slice(1, -1).map((id, i) => ({ stop: stopsById[id], label: String(i + 1), done: visited.includes(id) })),
    ].filter((s) => s.stop)
  }, [numbering, habitat, stopsById, visitedKey])
  const maneuvers = view?.maneuvers
  const hazards = useMemo(() => (maneuvers ?? []).filter((m) => m.kind === 'hazard').map((m) => m.at), [maneuvers])
  const s = view?.state
  const progress = useMemo<NavProgress | null>(
    () =>
      s && run
        ? { position: s.position, headingDeg: s.headingDeg, legIndex: s.legIndex, legAlongM: s.legAlongM }
        : null,
    [s, run],
  )

  const nextTurn = view?.upcoming.find((u) => u.maneuver.kind === 'turn')
  const nextTurnM = nextTurn ? Math.round(nextTurn.distanceM / 25) * 25 : null // coarse, so the zoom does not flicker
  const recentre = useCallback(() => {
    setFollow(true)
    setAutoZoom(true)
    setNorthUp(false)
  }, [])
  // Back to heading-up also follows the crew again; north-up keeps the map where it is.
  const compass = useCallback(() => (northUp ? recentre() : setNorthUp(true)), [northUp, recentre])
  // Heading-up stays on while browsing the map; the turn just holds still until re-centre.
  const headingUp = !!run && !northUp
  const userZoom = useCallback(() => setAutoZoom(false), [])

  const atStopId = s?.status === 'at_stop' ? s.visited[s.visited.length - 1] : null
  // The stop card and the finished card live in the panel: open it when either appears.
  const finished = s?.status === 'finished'
  useEffect(() => {
    if (atStopId || finished) setPanelOpen(true)
  }, [atStopId, finished])

  return (
    <div className={`nav-app${run && !panelOpen ? ' nav-app--panel-hidden' : ''}`}>
      <div className="nav-map-wrap">
        <NavMap
          site={site}
          stops={mapStops}
          plan={mapPlan}
          hazards={hazards}
          progress={progress}
          follow={follow}
          autoZoom={autoZoom}
          nextTurnM={nextTurnM}
          aheadM={run?.mobility.id === 'rover' ? AHEAD_ROVER_M : AHEAD_WALK_M}
          onFollow={setFollow}
          onUserZoom={userZoom}
          headingUp={headingUp}
          holdTurn={!follow}
          onCompass={compass}
        />
        {run && view && <Banner upcoming={view.upcoming} state={view.state} />}
        {run && view && s?.status !== 'finished' && <SimBar view={view} controls={controls} />}
        {run && (
          <button
            type="button"
            className="map-fab panel-toggle"
            aria-expanded={panelOpen}
            aria-label={panelOpen ? 'Hide panel' : 'Show panel'}
            title={panelOpen ? 'Hide panel' : 'Show panel'}
            onClick={() => setPanelOpen((o) => !o)}
          >
            <span aria-hidden="true">{panelOpen ? '›' : '‹'}</span>
          </button>
        )}
        {run && view && !panelOpen && s?.status !== 'finished' && <NextStopCard view={view} stops={stopsById} />}
        {run && (
          <button
            type="button"
            className="map-fab sound-toggle"
            aria-pressed={muted}
            aria-label={muted ? 'Voice muted, tap to unmute' : 'Voice on, tap to mute'}
            title={muted ? 'Voice muted · tap to unmute' : 'Voice on · tap to mute'}
            onClick={() => setMuted((m) => !m)}
          >
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
              {muted ? (
                <path d="M3 3 21 21" stroke="#ff5b5b" strokeWidth="2.5" strokeLinecap="round" />
              ) : (
                <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              )}
            </svg>
          </button>
        )}
        {run && s?.status !== 'finished' && <EndOnMap onEnd={end} />}
        {run && (!follow || !autoZoom) && (
          <button type="button" className="map-fab recentre-fab" onClick={recentre} aria-label="Re-centre" title="Re-centre">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path d="M12 3 19 20 12 16 5 20Z" fill="#2f81f7" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <aside className="nav-panel" aria-label={run ? 'Navigation' : 'Excursion plan'}>
        {!online && <p className="offline-chip" role="status">Offline · using saved map and data</p>}
        <div className="nav-body">
          {run && view ? (
            <NavPanel view={view} stops={stopsById} />
          ) : run ? (
            <div className="nav-scroll"><p className="muted">Starting navigation…</p></div>
          ) : (
            <PlanPanel
              targets={allTargets}
              selected={selected}
              maxSelected={MAX_SELECTED}
              mobility={mobility}
              profile={shown}
              plans={planner.plans}
              plan={plan}
              planning={planner.planning}
              error={planner.error}
              onToggle={toggle}
              onMobility={setMobility}
              onProfile={setProfile}
              onStart={start}
              offline={<OfflineDownload bounds={terrainMeta} plan={shownPlan} />}
            />
          )}
          {view && atStopId && (
            <StopCard
              view={view}
              stop={stopsById[atStopId]}
              photo={atStopId === habitat.id && initial.home ? undefined : views[atStopId]}
              onContinue={controls.continueFromStop}
            />
          )}
          {view && s?.status === 'finished' && <FinishedCard view={view} onAgain={end} />}
        </div>
        {/* Empty for now, kept for later. */}
        <div className="nav-foot" />
      </aside>
    </div>
  )
}
