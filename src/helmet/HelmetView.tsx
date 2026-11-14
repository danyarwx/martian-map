import { useEffect, useMemo, useRef, useState } from 'react'
import { JEZERO } from '../data/jezero.ts'
import { loadTerrain } from '../lib/terrain.ts'
import type { RoutePlan } from '../types.ts'
import type { HelmetEntry, HelmetExit } from './contracts.ts'
import { evaDoseMsv } from '../lib/safety.ts'
import { Gauges, HeadingTape, NextStop, VisorGlass, Warnings, type VisorWarning } from './hud/Visor.tsx'
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
  ['Tab (hold)', 'full readout: suit, weather, large hazard map'],
  ['M', 'hazard map on / off'],
  ['R', 'the same detector on a real Perseverance stereo photo'],
  ['P', 'pause'],
  ['I', 'developer numbers (CV time, frames per second)'],
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
  const [showMap, setShowMap] = useState(false)
  const [readout, setReadout] = useState(false)
  const [realPhoto, setRealPhoto] = useState(false)
  const [debug, setDebug] = useState(false)
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
        else if (realPhoto) setRealPhoto(false)
        else if (cvView) setCvView(false)
        else exitRef.current(session.current?.exit() ?? { seen: null, hazards: [], plan: null })
      } else if (k === 'j') setMenu((m) => (m === 'jump' ? null : 'jump'))
      else if (k === 'h') setMenu((m) => (m === 'help' ? null : 'help'))
      else if (k === 'p') setPaused((p) => !p)
      else if (k === 'v') setCvView((v) => !v)
      else if (k === 'm') setShowMap((v) => !v)
      else if (k === 'tab') {
        e.preventDefault()
        setReadout(true)
      }
      else if (k === 'r') setRealPhoto((v) => !v)
      else if (k === 'i') setDebug((v) => !v)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Tab') setReadout(false)
    }
    const onBlur = () => setReadout(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [menu, realPhoto, cvView])

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
        airTempC: wx?.airTempC ?? null,
        weatherSol: wx?.sol ?? null,
      })
    : []
  const rerouted = nav?.rerouted && now - nav.rerouted.at < 12000 ? nav.rerouted : null
  // steering arrow: where to turn, relative to where the astronaut looks
  const turn = nav && nav.steerDeg !== null && hud ? ((nav.steerDeg - hud.pose.headingDeg + 540) % 360) - 180 : null

  const alerts: VisorWarning[] = []
  if (rerouted)
    alerts.push({
      id: 'rerouted',
      severity: 'info',
      text: `Route updated: ${rerouted.deltaMin >= 0.5 ? `+${Math.round(rerouted.deltaMin)} min` : rerouted.deltaMin <= -0.5 ? `${Math.round(rerouted.deltaMin)} min` : 'under 1 min longer'} · hazard on the planned route`,
    })
  if (nav?.replanning) alerts.push({ id: 'replanning', severity: 'info', text: 'Re-routing round the hazard…' })
  if (nav?.blocked && !nav.replanning) alerts.push({ id: 'blocked', severity: 'danger', text: 'No way through ahead' })
  if (nav?.sandAhead)
    alerts.push({
      id: 'sand',
      severity: 'caution',
      text: 'Loose sand ahead on the route: slow down, watch your footing',
      source: 'Helmet hazard map (camera): ground classified as loose sand. The classifier is trained on the simulated sand look',
    })
  for (const w of warnings) alerts.push(w)
  const flags: string[] = []
  if ((!hud || hud.loading) && !error) flags.push('loading terrain')
  if (hud?.coarse && !hud.loading) flags.push('coarse terrain')
  if (hud?.fast) flags.push('time ×4')
  if (hud?.blocked === 'rock') flags.push('rock in the way')
  if (hud?.blocked === 'slope') flags.push('too steep to climb')
  if (paused) flags.push('paused')
  if (hud?.cv.error) flags.push('CV error')
  if (error) flags.push(error)
  const mapOpen = showMap || readout

  return (
    <div className="helmet">
      <div ref={host} className="helmet-canvas" />
      <VisorGlass />
      <div className="visor-status" aria-live="polite">
        <span>{planLabel}</span>
        {hud && <span>slope {hud.slopeDeg.toFixed(0)}°</span>}
        {flags.map((f) => (
          <span key={f} className="visor-flag">
            {f}
          </span>
        ))}
        {debug && hud && hud.cv.frames > 0 && (
          <span title="Live computer vision: worker time per frame and frames per second">
            CV {hud.cv.ms.toFixed(0)} ms · {hud.cv.hz.toFixed(1)} Hz · {hud.fps} fps
          </span>
        )}
      </div>

      {hud && <HeadingTape headingDeg={hud.pose.headingDeg} stopBearingDeg={nav && !nav.arrived ? nav.stopBearingDeg : null} steerDeg={nav?.steerDeg ?? null} />}
      <Warnings items={alerts} />
      {nav && plan && <NextStop name={stopName(nav.toId)} arrived={nav.arrived} remainingM={nav.remainingM} offRouteM={nav.offRouteM} turnDeg={turn} />}
      {hud && <Gauges elapsedMin={hud.elapsedMin} />}

      {hud && readout && <SuitPanel elapsedMin={hud.elapsedMin} lstHours={lst} weather={weather} walkBackMin={nav?.walkBackMin ?? null} />}
      {realPhoto && <RealPhotoTest />}
      {hud && session.current && cvView && !realPhoto && <CvView session={session.current} hud={hud} />}
      {hud && session.current && mapOpen && <MiniMap session={session.current} hud={hud} large={readout} />}

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

      <p className="visor-touch-note">The helmet view needs a keyboard and a mouse: W A S D to walk, drag to look, Esc to go back.</p>
      <p className="visor-keys">W A S D walk · Shift hurry · drag look · Tab readout · M map · V computer vision · R real photo · J jump · H keys · Esc back</p>
    </div>
  )
}
