import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JEZERO } from './data/jezero.ts'
import { inBounds } from './lib/geo.ts'
import { usePlanner } from './lib/usePlanner.ts'
import { useTerrainMeta } from './lib/useTerrainMeta.ts'
import MarsMap from './map/MarsMap.tsx'
import Sidebar, { type Notice } from './panels/Sidebar.tsx'
import type { LatLon, MobilityId, RouteProfile, StopView, Target } from './types.ts'

const site = JEZERO
// A walk that fits one excursion, so the first screen already shows a planned route.
const INITIAL = ['three-forks', 'delta-front', 'seitah']
/** Most targets on one route. The visiting order is found by trying every order, which grows fast. */
const MAX_SELECTED = 8

const OUTSIDE = 'That spot is outside the area with elevation data.'
const TOO_MANY = `A route can have at most ${MAX_SELECTED} targets. Untick one first.`

const coordinates = (p: LatLon) => `${p.lat.toFixed(5)}° N, ${p.lon.toFixed(5)}° E`

export default function App() {
  const [mobility, setMobility] = useState<MobilityId>('walk')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(INITIAL))
  const [focusId, setFocusId] = useState<string | null>(null)
  const [views, setViews] = useState<Record<string, StopView>>({})
  /** Where the habitat was moved to, or null while it stands at the site's landing point. */
  const [habitatAt, setHabitatAt] = useState<LatLon | null>(null)
  /** Destinations the user added. */
  const [custom, setCustom] = useState<Target[]>([])
  /** True while the next click on the map adds a point. */
  const [adding, setAdding] = useState(false)
  /** One line about the last action that was refused. */
  const [notice, setNotice] = useState<Notice | null>(null)
  const pointNo = useRef(0)
  const terrainMeta = useTerrainMeta(site)

  const habitat = useMemo<Target>(
    () =>
      habitatAt
        ? { ...site.habitat, ...habitatAt, name: 'Habitat (moved)', summary: coordinates(habitatAt) }
        : site.habitat,
    [habitatAt],
  )
  const targets = useMemo(
    () => [...site.targets, ...custom].filter((t) => selected.has(t.id)),
    [custom, selected],
  )
  const planner = usePlanner(site, mobility, habitat, targets)
  /** Which of the two routes the user wants. Kept across re-planning. */
  const [profile, setProfile] = useState<RouteProfile>('fast')
  const { plans } = planner
  const choice = plans !== null && !plans.gentleIsSame
  const shown: RouteProfile = choice ? profile : 'fast'
  const plan = plans ? plans[shown] : null
  const otherPlan = plans && choice ? plans[shown === 'fast' ? 'gentle' : 'fast'] : null

  // With no gentler route to offer, the choice falls back to the fastest one.
  useEffect(() => {
    if (plans?.gentleIsSame) setProfile('fast')
  }, [plans])

  useEffect(() => {
    fetch(site.views)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setViews)
      .catch(() => setViews({}))
  }, [])

  useEffect(() => {
    if (!adding) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAdding(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [adding])

  /** Says why a spot cannot be used, or null when it can. Before the terrain header loads, anything goes. */
  const refusal = useCallback(
    (p: LatLon) => (terrainMeta && !inBounds(terrainMeta, p) ? OUTSIDE : null),
    [terrainMeta],
  )

  const toggle = useCallback(
    (id: string) => {
      if (!selected.has(id) && selected.size >= MAX_SELECTED) {
        setNotice({ text: TOO_MANY, at: 'point' })
        return
      }
      setNotice(null)
      const next = new Set(selected)
      if (!next.delete(id)) next.add(id)
      setSelected(next)
    },
    [selected],
  )

  /** Each of these returns null when done, or the reason it was refused. */
  const moveHabitat = useCallback(
    (p: LatLon) => {
      const why = refusal(p)
      setNotice(why ? { text: why, at: 'habitat' } : null)
      if (!why) setHabitatAt(p)
      return why
    },
    [refusal],
  )

  const addPoint = useCallback(
    (p: LatLon) => {
      const why = refusal(p) ?? (selected.size >= MAX_SELECTED ? TOO_MANY : null)
      setNotice(why ? { text: why, at: 'point' } : null)
      if (why) return why
      const no = ++pointNo.current
      const point: Target = {
        id: `custom-${no}`,
        name: `Point ${no}`,
        summary: coordinates(p),
        science: 'Custom destination.',
        task: '',
        ...p,
      }
      setCustom((list) => [...list, point])
      setSelected(new Set(selected).add(point.id))
      setFocusId(point.id)
      return null
    },
    [refusal, selected],
  )

  const movePoint = useCallback(
    (id: string, p: LatLon) => {
      const why = refusal(p)
      setNotice(why ? { text: why, at: 'point' } : null)
      if (!why) setCustom((list) => list.map((t) => (t.id === id ? { ...t, ...p, summary: coordinates(p) } : t)))
      return why
    },
    [refusal],
  )

  const removePoint = useCallback((id: string) => {
    setNotice(null)
    setCustom((list) => list.filter((t) => t.id !== id))
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setFocusId((f) => (f === id ? null : f))
  }, [])

  const demo = useCallback(() => {
    setNotice(null)
    setSelected(new Set(INITIAL))
  }, [])

  const resetHabitat = useCallback(() => {
    setNotice(null)
    setHabitatAt(null)
  }, [])

  /** A click on the map while "Add point on map" is on. A refused spot leaves the mode on for another try. */
  const pickOnMap = useCallback(
    (p: LatLon) => {
      if (!addPoint(p)) setAdding(false)
    },
    [addPoint],
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a0e06" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 20l6-12 4 7 3-4 5 9z" />
            </svg>
          </span>
          <strong>Martian Map</strong>
        </div>
        <span className="crumb">Excursion planner</span>
        <span className="sep" aria-hidden="true">/</span>
        <span>{site.name}</span>
        <span className="spacer" />
        <span className="hint">{site.scienceGoal}</span>
      </header>
      <div className="workspace">
        <MarsMap
          site={site}
          habitat={habitat}
          custom={custom}
          terrainMeta={terrainMeta}
          selected={selected}
          plan={plan}
          otherPlan={otherPlan}
          focusId={focusId}
          adding={adding}
          onFocus={setFocusId}
          onMoveHabitat={moveHabitat}
          onMovePoint={movePoint}
          onPick={pickOnMap}
          onProfile={setProfile}
        />
        <Sidebar
          site={site}
          habitat={habitat}
          habitatMoved={habitatAt !== null}
          custom={custom}
          bounds={terrainMeta}
          mobility={mobility}
          selected={selected}
          focusId={focusId}
          planner={planner}
          plan={plan}
          profile={shown}
          views={views}
          adding={adding}
          notice={notice}
          maxSelected={MAX_SELECTED}
          onDemo={demo}
          onMobility={setMobility}
          onToggle={toggle}
          onFocus={setFocusId}
          onAdding={setAdding}
          onMoveHabitat={moveHabitat}
          onResetHabitat={resetHabitat}
          onAddPoint={addPoint}
          onRemovePoint={removePoint}
          onProfile={setProfile}
        />
      </div>
    </div>
  )
}
