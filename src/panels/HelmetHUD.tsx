import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { Hazard, LatLon, Stop } from '../types'
import { angleDiff, bearingDeg, distanceM, normDeg, pathLengthM, pointAlong } from './geo'
import {
  CHEYAVA_FALLS,
  DETECTION_RANGE_M,
  HABITAT,
  PLANNED_LENGTH_M,
  PLANNED_ROUTE,
  SCRIPTED_HAZARD,
  STOPS,
  STOP_1,
  WALK_SPEED_MPS,
  detourAround,
  nearestPanoramaStop,
  suitStatusAt,
} from './walkScript'
import Panorama from './hud/Panorama'
import MiniMap from './hud/MiniMap'
import { AlertBanner, Compass, HazardBrackets, NavPanel, SuitPanel, WorldMarkers, type Alert } from './hud/Overlays'
import './hud.css'

type Props = {
  /** Called when the helmet finds a hazard that is not on the orbital map. Wire this to the shared map. */
  onHazard?: (hazard: Hazard) => void
  /** Route planner to call after a new hazard. Defaults to a simple detour until the real planner exists. */
  replan?: (route: LatLon[], walkedM: number, hazard: Hazard) => LatLon[]
}

/** The whole walk plays in about this many real seconds. */
const DEMO_SECONDS = 25
const DEMO_MPS = PLANNED_LENGTH_M / DEMO_SECONDS
/** After the user looks around, wait this long before turning back to face the route. */
const LOOK_HOLD_MS = 2500
const ALERT_MS = 5000
/** The astronaut stops this long when the hazard alert fires, looking at the boulders. */
const HAZARD_STOP_MS = 2500
const ARRIVE_M = 3
const PASS_M = 8

type Sim = {
  playing: boolean
  walkedM: number
  route: LatLon[]
  abandoned: LatLon[] | null
  hazards: Hazard[]
  passed: Set<string>
  arrived: boolean
  headingDeg: number
  lookUntil: number
  stopUntil: number
  alert: Alert | null
  alertUntil: number
}

function freshSim(): Sim {
  return {
    playing: false,
    walkedM: 0,
    route: PLANNED_ROUTE,
    abandoned: null,
    hazards: [],
    passed: new Set([HABITAT.id]),
    arrived: false,
    headingDeg: bearingDeg(HABITAT, STOP_1),
    lookUntil: 0,
    stopUntil: 0,
    alert: null,
    alertUntil: 0,
  }
}

const WAYPOINTS = STOPS.filter((s) => s.kind !== 'habitat')

export default function HelmetHUD({ onHazard, replan = detourAround }: Props) {
  const sim = useRef<Sim>(freshSim())
  const [, render] = useReducer((n: number) => n + 1, 0)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [realImagery, setRealImagery] = useState(true)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the latest callbacks without restarting the animation loop.
  const cb = useRef({ onHazard, replan })
  cb.current = { onHazard, replan }

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const s = sim.current
      let changed = false

      if (s.playing && !s.arrived) {
        changed = true
        if (now > s.stopUntil) s.walkedM += DEMO_MPS * dt
        const here = pointAlong(s.route, s.walkedM)

        for (const w of WAYPOINTS) if (!s.passed.has(w.id) && distanceM(here, w) < PASS_M) s.passed.add(w.id)

        const hz = SCRIPTED_HAZARD
        if (!s.hazards.some((h) => h.id === hz.id) && distanceM(here, hz) < DETECTION_RANGE_M) {
          const before = pathLengthM(s.route)
          s.abandoned = [{ lat: here.lat, lon: here.lon }, s.route[here.nextIndex]]
          s.route = cb.current.replan(s.route, s.walkedM, hz)
          s.hazards = [...s.hazards, hz]
          const extraMin = Math.max(1, Math.round((pathLengthM(s.route) - before) / WALK_SPEED_MPS / 60))
          s.alert = {
            tone: 'danger',
            title: 'HAZARD',
            text: `Boulder field ${Math.round(distanceM(here, hz))} m ahead, not on the orbital map. Added to map. Route updated, +${extraMin} min.`,
          }
          s.alertUntil = now + ALERT_MS
          // stop and look at the boulders, facing them
          s.stopUntil = now + HAZARD_STOP_MS
          s.lookUntil = now + HAZARD_STOP_MS
          s.headingDeg = bearingDeg(here, hz)
          cb.current.onHazard?.(hz)
        }

        const total = pathLengthM(s.route)
        if (s.walkedM >= total - ARRIVE_M) {
          s.walkedM = total
          s.arrived = true
          s.playing = false
          s.passed.add(CHEYAVA_FALLS.id)
          s.alert = { tone: 'ok', title: 'ARRIVED', text: 'Cheyava Falls. Photograph the "leopard spots", then collect 3 rock samples.' }
          s.alertUntil = Infinity
        }
      }

      if (s.alert && now > s.alertUntil) {
        s.alert = null
        changed = true
      }

      // Face the walking direction unless the user is looking around.
      if (s.playing && now > s.lookUntil) {
        const here = pointAlong(s.route, s.walkedM)
        const ahead = pointAlong(s.route, s.walkedM + 25)
        if (distanceM(here, ahead) > 1) {
          s.headingDeg = normDeg(s.headingDeg + angleDiff(bearingDeg(here, ahead), s.headingDeg) * Math.min(1, dt * 3))
        }
      }

      if (changed || s.playing) render()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const turn = useCallback((deg: number) => {
    const s = sim.current
    s.headingDeg = normDeg(s.headingDeg + deg)
    s.lookUntil = performance.now() + LOOK_HOLD_MS
    render()
  }, [])

  const togglePlay = useCallback(() => {
    const s = sim.current
    if (s.arrived) sim.current = freshSim()
    sim.current.playing = !sim.current.playing
    sim.current.lookUntil = 0
    render()
  }, [])

  const reset = useCallback(() => {
    sim.current = freshSim()
    render()
  }, [])

  // Drag to look around.
  const dragX = useRef<number | null>(null)
  const fovDeg = size.w >= size.h ? 70 : 50
  const onPointerDown = (e: React.PointerEvent) => {
    dragX.current = e.clientX
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragX.current === null || size.w === 0) return
    turn(-((e.clientX - dragX.current) * fovDeg) / size.w)
    dragX.current = e.clientX
  }
  const endDrag = () => {
    dragX.current = null
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') turn(-8)
    else if (e.key === 'ArrowRight') turn(8)
    else if (e.key === ' ') togglePlay()
    else return
    e.preventDefault()
  }

  // ---- derived view state ----
  const s = sim.current
  const here = pointAlong(s.route, s.walkedM)
  const pose = { lat: here.lat, lon: here.lon, headingDeg: s.headingDeg }
  const next: Stop = WAYPOINTS.find((w) => !s.passed.has(w.id)) ?? CHEYAVA_FALLS
  const panoStop = nearestPanoramaStop(here)
  const view = { headingDeg: s.headingDeg, fovDeg, width: size.w, height: size.h, horizonY: size.h * 0.42 }
  const walked = [...s.route.slice(0, here.nextIndex), { lat: here.lat, lon: here.lon }]
  const helmetHazards = s.hazards.filter((h) => h.source === 'helmet')

  return (
    <div className="hud-wrap">
      <div
        ref={box}
        className="hud"
        tabIndex={0}
        aria-label="Helmet view. Drag or use the left and right arrow keys to look around. Space plays or pauses the walk."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <Panorama
          stop={panoStop}
          headingDeg={s.headingDeg}
          fovDeg={fovDeg}
          width={size.w}
          height={size.h}
          horizonY={view.horizonY}
          onSource={setRealImagery}
        />

        {size.w > 0 && (
          <svg className="hud-svg" width={size.w} height={size.h} aria-hidden="true">
            {s.hazards.map((h) => (
              <HazardBrackets key={h.id} view={view} pose={pose} hazard={h} />
            ))}
            <WorldMarkers view={view} pose={pose} target={CHEYAVA_FALLS} next={next} />
            <Compass {...view} />
          </svg>
        )}

        <SuitPanel suit={suitStatusAt(s.walkedM / WALK_SPEED_MPS)} />
        <NavPanel
          next={next}
          nextM={distanceM(here, next)}
          toGoM={Math.max(0, pathLengthM(s.route) - s.walkedM)}
          slopeDeg={panoStop.tiltDeg ?? null}
        />
        <MiniMap stops={STOPS} route={s.route} walked={walked} abandoned={s.abandoned} hazards={s.hazards} pose={pose} />
        <AlertBanner alert={s.alert} />
        {!s.alert && helmetHazards.length > 0 && (
          <div className="hud-chip">{helmetHazards.length} hazard from helmet added to map</div>
        )}
        <div className="hud-credit">
          {realImagery
            ? `View: NASA/JPL-Caltech, Perseverance Navcam, sol ${panoStop.sol}`
            : 'Drawn scenery (rover image unavailable)'}
        </div>
      </div>

      <div className="hud-controls">
        <button type="button" className="hud-btn" onClick={togglePlay}>
          {s.playing ? 'Pause' : s.arrived ? 'Play again' : 'Play walk'}
        </button>
        <button type="button" className="hud-btn hud-btn--quiet" onClick={reset}>
          Reset
        </button>
        <span className="hud-hint">Drag the view or use ← → to look around. Space plays or pauses.</span>
      </div>
    </div>
  )
}
