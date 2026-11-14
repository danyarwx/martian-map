import { useEffect, useMemo, useRef, useState } from 'react'
import { JEZERO } from '../data/jezero.ts'
import { loadTerrain } from '../lib/terrain.ts'
import type { RoutePlan } from '../types.ts'
import type { HelmetEntry, HelmetExit } from './contracts.ts'
import { evaDoseMsv } from '../lib/safety.ts'
import Compass from './hud/Compass.tsx'
import CvView from './hud/CvView.tsx'
import RealPhotoTest from './hud/RealPhotoTest.tsx'
import SuitPanel, { weatherNow } from './hud/SuitPanel.tsx'
import { doseSoFarMsv } from './sensors/suit.ts'
import { loadWeather, type WeatherCache } from './sensors/weather.ts'
import MiniMap from './hud/MiniMap.tsx'
import { evaluateWarnings } from './sensors/warnings.ts'
import { HelmetSession, type HudState } from './session.ts'
import { defaultEntry, loadRoutes } from './sim/defaultEntry.ts'
import { jumpTargets, routeLengths, routePoint, type JumpTarget } from './sim/jump.ts'
import { loadTileIndex } from './world/tiles.ts'
import './helmet.css'

interface Props {
  /** The plan and the jump point from Mission control. Null opens the helmet on its own (#helmet). */
  entry: HelmetEntry | null
  onExit: (exit: HelmetExit) => void
}

type Menu = 'jump' | 'help' | null

/** Local solar time when the helmet opens, hours (the sun in world/sky.ts stands at 10:30). */
const DEPARTURE_LST_H = 10.5

const KEYS: [string, string][] = [
  ['W A S D / arrows', 'walk'],
  ['Shift', 'hurry (time ×4)'],
  ['Drag', 'look around'],
  ['J', 'jump to a point of the route'],
  ['V', 'computer vision view: what the helmet computes'],
  ['M', 'hazard map small / large'],
  ['R', 'the same detector on a real Perseverance stereo photo'],
  ['P', 'pause'],
  ['H', 'this help'],
  ['Esc', 'back to Mission control'],
]

/** Name of a stop for labels. */
function stopName(id: string): string {
  if (id === JEZERO.habitat.id) return JEZERO.habitat.name
  if (id === 'start') return 'where the route changed'
  return JEZERO.targets.find((t) => t.id === id)?.name ?? id
}

/**
 * Full-screen helmet view: the real terrain around the planned route, walkable with W/A/S/D or the arrow keys,
 * mouse drag to look, J to jump along the route, Esc to go back.
 */
export default function HelmetView({ entry, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const session = useRef<HelmetSession | null>(null)
  const [active, setActive] = useState<HelmetEntry | null>(entry)
  const [plan, setPlan] = useState<RoutePlan | null>(entry?.plan ?? null)
  const [now, setNow] = useState(0)
  const [hud, setHud] = useState<HudState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu>(null)
  const [paused, setPaused] = useState(false)
  const [km, setKm] = useState(0)
  const [cvView, setCvView] = useState(false)
  const [bigMap, setBigMap] = useState(false)
  const [realPhoto, setRealPhoto] = useState(false)
  const [weather, setWeather] = useState<WeatherCache | null>(null)
  useEffect(() => {
    let live = true
    loadWeather()
      .then((w) => live && setWeather(w))
      .catch((err) => console.warn('helmet: no weather data', err))
    return () => {
      live = false
    }
  }, [])
  const startMin = useRef<number | null>(null)
  const exitRef = useRef(onExit)
  exitRef.current = onExit
  const entryRef = useRef(entry)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const abort = new AbortController()
    let s: HelmetSession | null = null
    Promise.all([loadTileIndex(abort.signal), loadTerrain(JEZERO.terrain), loadRoutes()])
      .then(([index, terrain, routes]) => {
        if (abort.signal.aborted) return
        const e = entryRef.current ?? defaultEntry(routes)
        s = new HelmetSession(
          el,
          e,
          { index, terrain, routes },
          (h) => {
            setHud(h)
            setNow(performance.now())
          },
          setPlan,
          entryRef.current === null,
        )
        setPlan(e.plan)
        session.current = s
        setActive(e)
        if (import.meta.env.DEV) {
          const live = s
          ;(window as unknown as Record<string, unknown>).__helmet = {
            session: live,
            pose: live.pose,
            ready: () => live.world.readyAround(live.pose.x, live.pose.y),
            info: () => ({
              calls: live.renderer.info.render.calls,
              triangles: live.renderer.info.render.triangles,
              pending: live.world.tiles.pending,
              tiles: live.world.tiles.loaded,
              coarse: live.world.coarseAt(live.pose.x, live.pose.y),
              rocks: live.world.rocks.field.count,
              rocksDrawn: live.world.rocks.drawn,
            }),
          }
        }
      })
      .catch((err) => {
        if (abort.signal.aborted) return
        console.error(err)
        setError(String(err?.message ?? err))
      })
    return () => {
      abort.abort()
      s?.dispose()
      session.current = null
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__helmet
    }
  }, [])

  // one-shot keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) {
        if (e.key === 'Escape') setMenu(null)
        return
      }
      const k = e.key.toLowerCase()
      if (k === 'escape') {
        if (menu) setMenu(null)
        else exitRef.current(session.current?.exit() ?? { seen: null, hazards: [], plan: null })
      } else if (k === 'j') setMenu((m) => (m === 'jump' ? null : 'jump'))
      else if (k === 'h') setMenu((m) => (m === 'help' ? null : 'help'))
      else if (k === 'p') setPaused((p) => !p)
      else if (k === 'v') setCvView((v) => !v)
      else if (k === 'm') setBigMap((v) => !v)
      else if (k === 'r') setRealPhoto((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  useEffect(() => {
    const s = session.current
    if (!s) return
    s.paused = paused
    s.controls.enabled = !paused && menu === null
  }, [paused, menu, active])

  const jumps = useMemo(() => (plan ? jumpTargets(plan, stopName) : []), [plan])
  const totalKm = useMemo(() => (plan ? routeLengths(plan).total / 1000 : 0), [plan])
  const jump = (t: JumpTarget) => {
    session.current?.jumpTo(t)
    setMenu(null)
  }

  const planLabel = !plan || !hud ? 'Helmet' : `${entry ? '' : 'Demo route · '}leg ${Math.min(hud.legIndex, plan.legs.length - 1) + 1} of ${plan.legs.length}`
  const nav = hud?.nav ?? null
  // local solar time: the sky's sun stands at 10:30 when the helmet opens
  const lst = DEPARTURE_LST_H + (hud ? hud.elapsedMin - (startMin.current ??= hud.elapsedMin) : 0) / 60
  const wx = weatherNow(weather, lst)
  const warnings = hud
    ? evaluateWarnings({
        nearestHazardM: nav?.hazardAheadM ?? null,
        nearestHazardKind: nav?.hazardAheadKind ?? null,
        slopeUnderFootDeg: hud.slopeDeg,
        walkBackMin: nav?.walkBackMin ?? null,
        daylightLeftMin: wx?.daylightLeftMin ?? null,
        doseMsv: doseSoFarMsv(hud.elapsedMin),
        plannedDoseMsv: plan ? evaDoseMsv(plan.totalMinutes / 60) : null,
        airTempC: weather ? weatherNow(weather, DEPARTURE_LST_H)?.airTempC ?? null : null,
        weatherSol: wx?.sol ?? null,
      })
    : []
  const rerouted = nav?.rerouted && now - nav.rerouted.at < 12000 ? nav.rerouted : null
  // steering arrow: where to turn, relative to where the astronaut looks
  const turn = nav && nav.steerDeg !== null && hud ? ((nav.steerDeg - hud.pose.headingDeg + 540) % 360) - 180 : null

  return (
    <div className="helmet">
      <div ref={host} className="helmet-canvas" />
      <div className="helmet-status" aria-live="polite">
        <span>{planLabel}</span>
        {(!hud || hud.loading) && !error && <span>Loading terrain…</span>}
        {hud?.coarse && !hud.loading && <span className="helmet-flag">coarse terrain</span>}
        {hud?.fast && <span className="helmet-flag">time ×4</span>}
        {hud?.blocked === 'rock' && <span className="helmet-flag">rock in the way</span>}
        {hud?.blocked === 'slope' && <span className="helmet-flag">too steep to climb</span>}
        {paused && <span className="helmet-flag">paused</span>}
        {error && <span className="helmet-flag">{error}</span>}
        {hud && <span>slope {hud.slopeDeg.toFixed(0)}°</span>}
        {hud && hud.cv.frames > 0 && (
          <span title="Live computer vision: worker time per frame and frames per second">
            CV {hud.cv.ms.toFixed(0)} ms · {hud.cv.hz.toFixed(1)} Hz
          </span>
        )}
        {hud?.cv.error && <span className="helmet-flag">CV error</span>}
        <span>{hud?.fps ?? 0} fps</span>
      </div>

      <div className="helmet-alerts" aria-live="assertive">
        {rerouted && (
          <p className="is-info">
            Route updated: {rerouted.deltaMin >= 0.5 ? `+${Math.round(rerouted.deltaMin)} min` : rerouted.deltaMin <= -0.5 ? `${Math.round(rerouted.deltaMin)} min` : 'under 1 min longer'} · hazard on the planned route
          </p>
        )}
        {nav?.replanning && <p className="is-info">Re-routing round the hazard…</p>}
        {nav?.blocked && !nav.replanning && <p className="is-danger">No way through ahead</p>}
        {nav?.sandAhead && (
          <p className="is-caution" title="Helmet hazard map (camera): ground classified as loose sand. The classifier is trained on the simulated sand look">
            Loose sand ahead: the guide keeps to firm ground
          </p>
        )}
        {warnings.map((w) => (
          <p key={w.id} className={`is-${w.severity}`} title={w.source}>
            {w.text}
          </p>
        ))}
      </div>

      {nav && plan && (
        <div className="helmet-nav">
          <span className="helmet-nav-label">{nav.arrived ? 'Arrived' : 'Next stop'}</span>
          <strong>{stopName(nav.toId)}</strong>
          <span>
            {nav.remainingM >= 1000 ? `${(nav.remainingM / 1000).toFixed(2)} km` : `${Math.round(nav.remainingM)} m`}
            {nav.offRouteM > 15 ? ` · ${Math.round(nav.offRouteM)} m off route` : ''}
          </span>
          {turn !== null && !nav.arrived && (
            <span className="helmet-steer" aria-label={`Guide: turn ${Math.round(Math.abs(turn))} degrees ${turn < 0 ? 'left' : 'right'}`}>
              <span className="helmet-steer-arrow" style={{ transform: `rotate(${turn}deg)` }} aria-hidden="true">
                ▲
              </span>
              {Math.abs(turn) < 8 ? 'on the guide' : `${Math.round(Math.abs(turn))}° ${turn < 0 ? 'left' : 'right'}`}
            </span>
          )}
        </div>
      )}

      {hud && <Compass headingDeg={hud.pose.headingDeg} stopBearingDeg={nav && !nav.arrived ? nav.stopBearingDeg : null} steerDeg={nav?.steerDeg ?? null} />}
      {hud && <SuitPanel elapsedMin={hud.elapsedMin} lstHours={lst} weather={weather} walkBackMin={nav?.walkBackMin ?? null} />}
      {realPhoto && <RealPhotoTest />}
      {hud && session.current && cvView && !realPhoto && <CvView session={session.current} hud={hud} />}
      {hud && session.current && <MiniMap session={session.current} hud={hud} large={bigMap} />}

      {menu === 'jump' && plan && (
        <div className="helmet-menu" role="dialog" aria-label="Jump to a point of the route">
          <h2>Jump to</h2>
          <ul>
            {jumps.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => jump(t)}>
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
          <label className="helmet-menu-slider">
            <span>Point on the route: {km.toFixed(2)} km of {totalKm.toFixed(2)} km</span>
            <input type="range" min={0} max={totalKm} step={0.01} value={Math.min(km, totalKm)} onChange={(e) => setKm(Number(e.target.value))} />
          </label>
          <button type="button" onClick={() => jump(routePoint(plan, km * 1000))}>
            Jump to {km.toFixed(2)} km
          </button>
          <p className="helmet-menu-note">Rocks under ~1.5 m are simulated; the ground is the HiRISE 1 m elevation model.</p>
        </div>
      )}
      {menu === 'help' && (
        <div className="helmet-menu" role="dialog" aria-label="Keys">
          <h2>Keys</h2>
          <dl>
            {KEYS.map(([k, what]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <p className="helmet-help">W A S D walk · Shift hurry · drag look · J jump · V computer vision · R real photo · M map · H help · Esc back</p>
    </div>
  )
}
