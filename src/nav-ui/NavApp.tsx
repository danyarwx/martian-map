// Tablet navigation screen at /nav: plan the excursion, then follow it turn by turn.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { JEZERO } from '../data/jezero.ts'
import { MOBILITY } from '../lib/mobility.ts'
import { usePlanner } from '../lib/usePlanner.ts'
import { useTerrainMeta } from '../lib/useTerrainMeta.ts'
import { displayPlan } from '../nav/display.ts'
import { getNavBus } from '../nav/events.ts'
import type { MobilityId, RouteProfile, StopView, Target } from '../types.ts'
import { canSpeak, startBrowserVoice } from './browserVoice.ts'
import NavMap, { type NavProgress } from './NavMap.tsx'
import { Banner, EndControl, FinishedCard, NavPanel, PlanPanel, SimBar, StopCard } from './NavPanels.tsx'
import { OfflineDownload } from './OfflineDownload.tsx'
import { parseNavParams } from './params.ts'
import { useNavRun, type NavRunInput } from './useNavRun.ts'
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
  const [selected, setSelected] = useState<string[]>(initial.stopIds)
  const [mobility, setMobility] = useState<MobilityId>(initial.mobility)
  const [profile, setProfile] = useState<RouteProfile>(initial.profile)
  const [views, setViews] = useState<Record<string, StopView>>({})
  const [run, setRun] = useState<NavRunInput | null>(null)
  const [follow, setFollow] = useState(true)
  const [autoZoom, setAutoZoom] = useState(true)
  const [speak, setSpeak] = useState(false)
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

  useEffect(() => (speak ? startBrowserVoice(getNavBus()) : undefined), [speak])

  const toggle = useCallback(
    (id: string) =>
      setSelected((list) =>
        list.includes(id) ? list.filter((x) => x !== id) : list.length >= MAX_SELECTED ? list : [...list, id],
      ),
    [],
  )

  const start = useCallback(() => {
    if (!plan) return
    setFollow(true)
    setAutoZoom(true)
    setRun({ site, plan, habitat, stops: stopsById, mobility: MOBILITY[plan.mobility] })
  }, [plan, habitat, stopsById])

  const end = useCallback(() => setRun(null), [])

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
  }, [])
  const userZoom = useCallback(() => setAutoZoom(false), [])

  const atStopId = s?.status === 'at_stop' ? s.visited[s.visited.length - 1] : null

  return (
    <div className="nav-app">
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
        />
        {run && view && <Banner upcoming={view.upcoming} state={view.state} />}
        {run && view && s?.status !== 'finished' && <SimBar view={view} controls={controls} />}
        {run && (!follow || !autoZoom) && (
          <button type="button" className="big recentre" onClick={recentre}>
            Re-centre
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
        <div className="nav-foot">
          {run && s?.status !== 'finished' && <EndControl onEnd={end} />}
          {canSpeak() && (
            <label className="voice">
              <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} />
              Speak (browser TTS)
            </label>
          )}
        </div>
      </aside>
    </div>
  )
}
