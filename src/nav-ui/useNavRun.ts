// One navigation run: the navigator, the simulated walker and the replanning worker, wired together.
// Positions come from the simulator, or the tablet's GPS in Earth GPS mode; everything the screen shows comes
// from the navigation bus.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Mobility, RoutePlan, SiteConfig, Target } from '../types.ts'
import { distanceM } from '../lib/geo.ts'
import { evaDoseMsv, type HazardKind } from '../lib/safety.ts'
import { bestDeparture, temperatureC, turnBackBy } from '../lib/schedule.ts'
import { statusText } from '../nav/alerts.ts'
import { getNavBus, IDLE_STATE, type NavEvent, type NavState, type UpcomingManeuver } from '../nav/events.ts'
import type { Maneuver } from '../nav/instructions.ts'
import { GpsSource, type GpsStatus } from '../nav/gps.ts'
import { SimulatedSource, type PositionFix } from '../nav/position.ts'
import { createWorkerRerouter } from '../nav/reroute.ts'
import { displayPlan } from '../nav/display.ts'
import { createNavigator, type Navigator } from '../nav/tracker.ts'

export interface NavRunInput {
  site: SiteConfig
  plan: RoutePlan
  habitat: Target
  /** The habitat and every target by id. */
  stops: Record<string, Target>
  mobility: Mobility
  /** Scripted demo: Mars time of departure (LMST minutes) and simulation speed, instead of the defaults. */
  demo?: { departLmst: number; speed: number }
}

export interface NavRunView {
  state: NavState
  upcoming: UpcomingManeuver[]
  /** Last spoken announcements, newest last. Not shown on screen; kept for debugging and future use. */
  log: NavEvent[]
  /** The route being followed: the planned one, or the latest replan. */
  plan: RoutePlan
  maneuvers: Maneuver[]
  /** Mission clock, Date.now() milliseconds. Runs faster than real time with the simulation speed-up. */
  missionNow: number
  missionStart: number
  /** Mars time of day now, LMST minutes since midnight. The excursion leaves at the suggested departure. */
  lmst: number
  /** Mission time of the arrival at the current stop, null when not at a stop. */
  arrivedAt: number | null
  /** Distance actually covered, metres. */
  walkedM: number
  playing: boolean
  speed: number
  /** Where positions come from: the simulated walker or the tablet's GPS. */
  source: PositionKind
  /** GPS state while `source` is 'gps', else null. */
  gps: GpsStatus | null
}

export type PositionKind = 'sim' | 'gps'

export interface NavRunControls {
  play(): void
  pause(): void
  setSpeed(x: number): void
  /** Pushes the simulated walker this many metres to the right of the route (negative: left). */
  drift(metres: number): void
  backToRoute(): void
  continueFromStop(): void
  /** Simulates a hazard that ends the excursion: warning, then the route home. */
  hazard(kind: HazardKind): void
  /** Says the status readout: Mars time, time out, walk home, air temperature, dose so far. */
  status(): void
  /** Switches between the simulated walker and the tablet's GPS. GPS runs the clock in real time. */
  setSource(kind: PositionKind): void
}

/** Screen updates per second at most. */
const UPDATES_HZ = 5
/** Spoken lines kept in the caption log. */
const LOG_SIZE = 6
/** Default simulation speed-up. */
const START_SPEED = 10
/** A jump longer than this between two positions is a reroute restart, not walking, metres. */
const JUMP_M = 150

type WakeLock = { release(): Promise<void> }

export function useNavRun(input: NavRunInput | null): { view: NavRunView | null; controls: NavRunControls } {
  const [view, setView] = useState<NavRunView | null>(null)
  const nav = useRef<Navigator | null>(null)
  const sim = useRef<SimulatedSource | null>(null)
  const clock = useRef({ playing: true, speed: START_SPEED })
  /** Reads the mission clock for the Status button. */
  const mission = useRef<{ start: number; now: () => number; departLmst: number } | null>(null)
  const switchSource = useRef<((kind: PositionKind) => void) | null>(null)

  useEffect(() => {
    if (!input) {
      setView(null)
      return
    }
    const bus = getNavBus()
    const missionStart = Date.now()
    let missionNow = missionStart
    let lastReal = missionStart
    const startSpeed = input.demo?.speed ?? START_SPEED
    clock.current = { playing: true, speed: startSpeed }
    // The Mars clock: the excursion leaves at the planner's suggested departure, as on the planning screen.
    const departLmst = input.demo?.departLmst ?? bestDeparture(input.plan.totalMinutes).start
    const turnBack = turnBackBy(input.plan, departLmst)
    const lmstAt = (t: number) => departLmst + (t - missionStart) / 60000
    mission.current = { start: missionStart, now: () => missionNow, departLmst }

    const rerouter = createWorkerRerouter({
      site: input.site,
      mobility: input.mobility.id,
      profile: input.plan.profile,
      habitat: input.habitat,
      stops: input.stops,
    })
    // Everything below works on the drawn line, not on the terrain-cell staircase (see nav/display.ts).
    const plan = displayPlan(input.plan)
    const tracker = createNavigator({
      plan,
      stops: input.stops,
      mobility: input.mobility,
      bus,
      requestReroute: (from, ids) => rerouter.requestReroute(from, ids).then((p) => displayPlan(p)),
      now: () => missionNow,
      departLmst,
      turnBackAtMs: turnBack === null ? undefined : missionStart + (turnBack - departLmst) * 60000,
    })
    const walker = new SimulatedSource({ legs: plan.legs, mobility: input.mobility })
    walker.setSpeedMultiplier(startSpeed)
    nav.current = tracker
    sim.current = walker

    let latest: { state: NavState; upcoming: UpcomingManeuver[] } = { state: IDLE_STATE, upcoming: [] }
    let log: NavEvent[] = []
    let arrivedAt: number | null = null
    let walkedM = 0
    let last: { lat: number; lon: number } | null = null
    let dirty = true
    let source: PositionKind = 'sim'
    let gps: GpsSource | null = null
    let gpsStatus: GpsStatus | null = null

    const offs = [
      bus.subscribe('state', (e) => {
        if (!e.state) return
        latest = { state: e.state, upcoming: bus.getUpcoming(50) }
        dirty = true
      }),
      bus.subscribe('*', (e) => {
        if (e.type === 'state') return
        if (e.text) log = [...log, e].slice(-LOG_SIZE)
        if (e.type === 'rerouted') walker.setPath(tracker.getPlan().legs)
        if (e.type === 'arrive') arrivedAt = e.at
        dirty = true
      }),
    ]

    const onFix = (fix: PositionFix) => {
      // The mission clock runs at the simulation speed, so stops, off-route timers and ETAs stay consistent.
      const real = Date.now()
      if (clock.current.playing) missionNow += (real - lastReal) * clock.current.speed
      lastReal = real
      if (last) {
        const d = distanceM(last, fix)
        if (d < JUMP_M) walkedM += d
      }
      last = fix
      tracker.update({ ...fix, t: missionNow })
    }
    tracker.start()
    walker.start(onFix)

    switchSource.current = (kind) => {
      if (kind === source) return
      if (kind === 'gps') {
        // Real walking runs in real time. The first fix lands where the crew is now.
        walker.stop()
        clock.current = { playing: true, speed: 1 }
        walker.setSpeedMultiplier(1)
        gps = new GpsSource({
          anchor: last ?? input.habitat,
          onStatus: (st) => {
            gpsStatus = st
            dirty = true
          },
        })
        gps.start(onFix)
      } else {
        // The walker takes over on the route, at the navigator's position.
        gps?.stop()
        gps = null
        gpsStatus = null
        const st = tracker.getState()
        walker.setPath(tracker.getPlan().legs)
        walker.placeAt(st.legIndex, st.legAlongM)
        walker.start(onFix)
      }
      source = kind
      dirty = true
    }

    const timer = setInterval(() => {
      if (!dirty) return
      dirty = false
      setView({
        ...latest,
        log,
        plan: tracker.getPlan(),
        maneuvers: tracker.getManeuvers(),
        missionNow,
        missionStart,
        lmst: lmstAt(missionNow),
        arrivedAt: latest.state.status === 'at_stop' ? arrivedAt : null,
        walkedM,
        ...clock.current,
        source,
        gps: gpsStatus,
      })
    }, 1000 / UPDATES_HZ)

    // Keep the tablet screen on while navigating, where the browser allows it.
    let wake: WakeLock | null = null
    const wakeApi = (globalThis.navigator as { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } } | undefined)
      ?.wakeLock
    wakeApi
      ?.request('screen')
      .then((w) => (wake = w))
      .catch(() => {})

    return () => {
      clearInterval(timer)
      offs.forEach((off) => off())
      walker.stop()
      gps?.stop()
      switchSource.current = null
      tracker.stop()
      rerouter.dispose()
      wake?.release().catch(() => {})
      nav.current = null
      sim.current = null
      mission.current = null
    }
  }, [input])

  const controls: NavRunControls = {
    play: useCallback(() => {
      clock.current.playing = true
      sim.current?.resume()
    }, []),
    pause: useCallback(() => {
      clock.current.playing = false
      sim.current?.pause()
    }, []),
    setSpeed: useCallback((x: number) => {
      clock.current.speed = x
      sim.current?.setSpeedMultiplier(x)
    }, []),
    drift: useCallback((m: number) => sim.current?.driftOffRoute(m), []),
    backToRoute: useCallback(() => sim.current?.driftOffRoute(0), []),
    continueFromStop: useCallback(() => {
      nav.current?.continueFromStop()
      sim.current?.continueFromStop()
    }, []),
    hazard: useCallback((kind: HazardKind) => {
      nav.current?.abortToHabitat(kind)
    }, []),
    status: useCallback(() => {
      const m = mission.current
      const n = nav.current
      if (!m || !n) return
      const now = m.now()
      const minutesOut = (now - m.start) / 60000
      const lmst = m.departLmst + minutesOut
      const text = statusText({
        minutesOut,
        walkHomeMin: n.getState().walkHomeMin,
        lmst,
        tempC: temperatureC(lmst),
        doseMsv: evaDoseMsv(minutesOut / 60),
      })
      getNavBus().emit({ id: `status-${now}`, type: 'status', text, priority: 'normal', at: now })
    }, []),
    setSource: useCallback((kind: PositionKind) => switchSource.current?.(kind), []),
  }
  return { view, controls }
}
