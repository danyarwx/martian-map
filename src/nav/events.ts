/**
 * Navigation events: the public API for anything that speaks or shows navigation, such as a voice (TTS) model.
 *
 * Three ways to listen, pick one:
 * 1. In the app: `getNavBus().subscribe('*', (e) => speak(e.text))`. Also on `window.marsNav` for the console.
 * 2. From another tab or window of the same origin: `listenNavChannel((e) => ...)`; every event is mirrored
 *    on `BroadcastChannel('mars-nav')`.
 * 3. Poll: `getNavBus().getState()` and `getNavBus().getUpcoming(3)`.
 *
 * Every event except 'state' carries `text`, a finished English sentence ready to speak, and its `priority`:
 * 'high' should interrupt whatever is being spoken, 'normal' and 'low' wait their turn (a 'low' one may be
 * dropped if it is stale). Instruction events also carry the `maneuver`, so a voice can phrase it its own way.
 * 'state' events come with every position update (about 5 per second) and are not meant to be spoken.
 * @module
 */
import type { HazardKind } from '../lib/safety.ts'
import type { LatLon } from '../types.ts'
import type { Maneuver } from './instructions.ts'

export type NavEventType =
  /** A turn, departure, "keep going" or approach to a stop. */
  | 'instruction'
  /** Steep ground ahead on the route. */
  | 'hazard'
  /** The crew reached a stop or the habitat. */
  | 'arrive'
  /** The crew left the route; the text says which way it is. */
  | 'off_route'
  /** A new route from the current position was planned. */
  | 'rerouted'
  | 'back_on_route'
  /** The crew is now farther than the emergency walk-back reserve from the habitat. */
  | 'walkback_warning'
  /** The latest time to turn back has come. */
  | 'turn_back_time'
  /** A time-of-day warning: gust hours ahead, daylight running out. */
  | 'time_alert'
  /** A hazard (dust storm, solar particle event) ends the excursion; a 'rerouted' home follows. */
  | 'hazard_event'
  /** The status readout, on request. */
  | 'status'
  /** The science reason of the stop just reached, said after the arrival. */
  | 'stop_briefing'
  /** A few metres off the line (before 'off_route'): "Drifting left. Correct right." */
  | 'drift'
  | 'nav_started'
  | 'nav_ended'
  /** A NavState snapshot, sent with every position update. Not for speaking. */
  | 'state'

export type NavPriority = 'low' | 'normal' | 'high'

export interface NavEvent {
  /** Unique and stable per announcement: the same announcement never comes twice with different ids. */
  id: string
  type: NavEventType
  /** Ready-to-speak English sentence. Empty for 'state'. */
  text: string
  /** 'high' = interrupt current speech. */
  priority: NavPriority
  /** Structured data behind an instruction or hazard. */
  maneuver?: Maneuver
  /** Distance to the maneuver when announced, metres. */
  distanceM?: number
  /** The stop this event is about, for 'arrive'. */
  stopId?: string
  /** Only on 'state' events. */
  state?: NavState
  /** Date.now() when emitted. */
  at: number
}

export type NavStatus = 'idle' | 'navigating' | 'at_stop' | 'off_route' | 'rerouting' | 'finished'

/** A maneuver still ahead, with the distance to it from the current position along the route. */
export interface UpcomingManeuver {
  maneuver: Maneuver
  distanceM: number
}

/** Snapshot of the navigation, updated with every position. */
export interface NavState {
  status: NavStatus
  /** Last reported position, null before the first one. */
  position: LatLon | null
  /** Direction of travel, degrees from north. */
  headingDeg: number | null
  speedMps: number
  /** False while the crew is more than 25 m from the route. */
  onRoute: boolean
  /** Distance from the route, metres. */
  offsetM: number
  /** Index of the current leg in the active plan, and how many legs it has. A reroute starts a new plan. */
  legIndex: number
  legCount: number
  /** Stop the current leg leads to. */
  nextStopId: string | null
  /** Stops reached so far, in order, the habitat included at the end. */
  visited: string[]
  /** Distance along the current leg's path to where the crew is matched on it, metres. */
  legAlongM: number
  /** Next maneuver and the distance to it along the route. */
  next: UpcomingManeuver | null
  /** What is left of the current leg and of the whole route. Minutes are moving time; route minutes include stops. */
  legRemainingM: number
  legRemainingMin: number
  routeRemainingM: number
  routeRemainingMin: number
  /** Expected return to the habitat, Date.now() milliseconds, or null when unknown. */
  etaMs: number | null
  /** Minutes on foot straight back to the habitat from here, null when not known. */
  walkHomeMin: number | null
  /** How many times the route has been replanned during this navigation. */
  rerouteCount: number
  /** The hazard that ended the excursion early, or null. */
  abort: HazardKind | null
  /** Compass direction of the route where the crew is, degrees: the way to walk. Null when not moving on a leg. */
  routeHeadingDeg: number | null
  /** The crew has drifted a few metres off the line to this side (drift cue), else null. */
  drifting: 'left' | 'right' | null
}

export const IDLE_STATE: NavState = {
  status: 'idle',
  position: null,
  headingDeg: null,
  speedMps: 0,
  onRoute: true,
  offsetM: 0,
  legIndex: 0,
  legCount: 0,
  nextStopId: null,
  visited: [],
  legAlongM: 0,
  next: null,
  legRemainingM: 0,
  legRemainingMin: 0,
  routeRemainingM: 0,
  routeRemainingMin: 0,
  etaMs: null,
  walkHomeMin: null,
  rerouteCount: 0,
  abort: null,
  routeHeadingDeg: null,
  drifting: null,
}

/** What `emit` takes: an event without its timestamp, which the bus adds. */
export type NavEventInput = Omit<NavEvent, 'at'> & { at?: number }

export interface NavBus {
  /** Calls `cb` for every event of `type`, or of every type with '*'. Returns the function that stops it. */
  subscribe(type: NavEventType | '*', cb: (e: NavEvent) => void): () => void
  /** Sends an event to every subscriber and to the BroadcastChannel. Returns it with its timestamp. */
  emit(e: NavEventInput): NavEvent
  /** The latest navigation state. */
  getState(): NavState
  /** The next `n` maneuvers with their distances from the current position. */
  getUpcoming(n?: number): UpcomingManeuver[]
  /** Called by the navigator with every position: stores the state and emits a 'state' event. */
  publishState(state: NavState, upcoming: UpcomingManeuver[]): void
}

/** Name of the BroadcastChannel that mirrors every event. */
export const NAV_CHANNEL = 'mars-nav'

export interface NavBusOptions {
  /** Mirror events on this BroadcastChannel, or false for none. Default: 'mars-nav' in a browser, none elsewhere. */
  channel?: string | false
}

/** A new, independent bus. The app uses the shared one from `getNavBus()`. */
export function createNavBus(options: NavBusOptions = {}): NavBus {
  const listeners = new Map<NavEventType | '*', Set<(e: NavEvent) => void>>()
  let state: NavState = IDLE_STATE
  let upcoming: UpcomingManeuver[] = []
  const name = options.channel ?? (typeof window !== 'undefined' ? NAV_CHANNEL : false)
  const channel = name && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null

  const bus: NavBus = {
    subscribe(type, cb) {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(cb)
      return () => set.delete(cb)
    },
    emit(input) {
      const e: NavEvent = { ...input, at: input.at ?? Date.now() }
      for (const key of [e.type, '*'] as const) {
        for (const cb of listeners.get(key) ?? []) {
          try {
            cb(e)
          } catch (err) {
            console.error('mars-nav listener failed', err) // one broken listener must not stop navigation
          }
        }
      }
      try {
        channel?.postMessage(e)
      } catch {
        // A closed channel or an uncloneable value: listeners in this window already have the event.
      }
      return e
    },
    getState: () => state,
    getUpcoming: (n = 3) => upcoming.slice(0, n),
    publishState(s, list) {
      state = s
      upcoming = list
      bus.emit({ id: 'state', type: 'state', text: '', priority: 'low', state: s })
    },
  }
  return bus
}

declare global {
  interface Window {
    /** The app's navigation bus, for the console and for scripts on the same page. */
    marsNav?: NavBus
  }
}

let shared: NavBus | undefined

/** The app's one navigation bus. Created on first use and put on `window.marsNav`. */
export function getNavBus(): NavBus {
  if (!shared) {
    shared = createNavBus()
    if (typeof window !== 'undefined') window.marsNav = shared
  }
  return shared
}

/**
 * Listens to navigation events from another tab or window of the same site (for a voice running elsewhere).
 * Returns the function that stops listening.
 */
export function listenNavChannel(cb: (e: NavEvent) => void, name = NAV_CHANNEL): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(name)
  channel.onmessage = (msg: MessageEvent<NavEvent>) => cb(msg.data)
  return () => channel.close()
}
