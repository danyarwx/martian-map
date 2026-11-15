// Follows the crew along the route: where they are on it, what comes next, when they arrive, and what
// to do when they leave it. Feeds the announcer and publishes everything on the navigation bus.
import type { LatLon, Mobility, RoutePlan, Target } from '../types.ts'
import { HAZARD_EVENTS, WALK_BACK_RESERVE_MIN, type HazardKind } from '../lib/safety.ts'
import { distanceM } from '../lib/geo.ts'
import { saidDuration, timeAlertsBetween } from './alerts.ts'
import { createAnnouncer } from './announcer.ts'
import type { NavBus, NavEventType, NavPriority, NavState, NavStatus, UpcomingManeuver } from './events.ts'
import { bearingAlong, cumulativeM, projectOntoPath, type PathProjection } from './geometry.ts'
import { buildManeuvers, saidDistance, type Maneuver } from './instructions.ts'
import type { PositionFix } from './position.ts'

/** Farther than this from the route counts as off it, metres. */
export const OFF_ROUTE_M = 25
/** Up to this far off, the crew is guided back; beyond it the route is planned again, metres. */
export const REROUTE_M = 50
/** Back under this distance counts as back on the route, metres. */
export const BACK_ON_ROUTE_M = 15
/** Off the route for this long before anything is said, milliseconds. Brief wobbles are ignored. */
export const OFF_ROUTE_DELAY_MS = 5000
/** Drift cue: this far off the line, metres, on foot and by rover; held this long; re-armed below DRIFT_RESET_M. */
export const DRIFT_M = { walk: 10, rover: 20 } as const
export const DRIFT_DELAY_MS = 3000
export const DRIFT_RESET_M = 5
/** The direction to walk is measured over this much route ahead, metres. */
const HEADING_AHEAD_M = 30
/** The crew has arrived when this close to the stop, metres. */
export const ARRIVE_M = 15

/** Positions are matched to the route this far behind and ahead of the last known progress, metres. */
const SEARCH_BACK_M = 50
const SEARCH_AHEAD_M = 400
/** "Head back to the route" is repeated this often while off it, milliseconds. */
const GUIDE_REPEAT_MS = 30000
/** A passed departure or "keep going" line may still be said this far after it, metres. */
const SAY_AFTER_M = 30
/** After a failed reroute, wait this long before trying again, milliseconds. */
const REROUTE_RETRY_MS = 30000
/** The walk-back caution is said again only after the crew came back this far inside the reserve, minutes. */
export const WALKBACK_REARM_MIN = 5
/** After the crew chose to continue despite a hazard warning, it is said again this often (mission time), ms. */
export const HAZARD_REMINDER_MS = 15 * 60_000

export interface NavigatorOptions {
  plan: RoutePlan
  /** The habitat and the targets by id, for names and tasks. */
  stops: Record<string, Target>
  mobility: Mobility
  bus: NavBus
  /**
   * Plans a new route from `from` through `stopIds` (targets still to visit, in this order; the habitat
   * is always the end and is not listed). Without it, a crew far off the route is only guided back.
   */
  requestReroute?: (from: LatLon, stopIds: string[]) => Promise<RoutePlan>
  /** Date.now() milliseconds of the latest time to turn back, if the schedule has one. */
  turnBackAtMs?: number
  /**
   * Mars time of day (LMST minutes) when navigation starts. With it, gust and daylight warnings are said
   * as the mission clock passes them.
   */
  departLmst?: number
  /** Clock for the ETA. Positions carry their own time. Default Date.now. */
  now?: () => number
}

export interface Navigator {
  /** Starts navigating. Instructions begin with the first position. */
  start(): void
  /** Feed every position here. */
  update(fix: PositionFix): void
  /** Leaves the stop the crew is at and starts the next leg. */
  continueFromStop(): void
  /**
   * A dust storm or solar flare: the warning is said and `NavState.hazard` is set, so the screen can ask
   * the crew to return. The route does not change until `returnToBase`. Returns whether it did anything.
   */
  warnHazard(kind: HazardKind): boolean
  /**
   * Plans the fastest route straight back to the habitat from here, skipping the stops left, for a hazard
   * or by the crew's choice ('crew'). Only the first call counts. Returns whether it did anything.
   */
  returnToBase(reason: HazardKind | 'crew'): boolean
  /** The crew keeps going despite the hazard warning; a reminder is said every 15 Mars minutes. */
  continueDespiteHazard(): void
  /** `warnHazard` and `returnToBase` at once: the hazard ends the excursion. */
  abortToHabitat(kind: HazardKind): boolean
  /** Ends navigation. */
  stop(): void
  getState(): NavState
  /** The route being followed. Changes after a reroute; its first stop is then 'here'. */
  getPlan(): RoutePlan
  getManeuvers(): Maneuver[]
}

export function createNavigator(options: NavigatorOptions): Navigator {
  const { stops, mobility, bus, requestReroute, turnBackAtMs, departLmst } = options
  const clock = options.now ?? Date.now
  const announcer = createAnnouncer(bus, mobility.id)

  let plan = options.plan
  let maneuvers: Maneuver[] = []
  let cums: number[][] = []
  /** Distance from the route start to the start of each leg, metres. */
  let legStart: number[] = []
  let legIndex = 0
  let legAlong = 0
  let status: NavStatus = 'idle'
  let position: PositionFix | null = null
  let offsetM = 0
  let walkHomeMin: number | null = null
  const visited: string[] = []
  let offSince: number | null = null
  let guidedAt = -Infinity
  let rerouteCount = 0
  let rerouteToken = 0
  let rerouteBlockedUntil = -Infinity
  let walkBackWarned = false
  let turnBackSaid = false
  let abort: HazardKind | 'crew' | null = null
  let hazard: HazardKind | null = null
  let hazardDismissed = false
  /** Mission time of the last hazard reminder, after the crew chose to continue. */
  let hazardRemindedAt = 0
  let skipped: string[] = []
  let lastNow = clock()
  /** Mission time when navigation started, and the Mars time already checked for time-of-day warnings. */
  let startedAt = lastNow
  let checkedLmst = departLmst ?? 0
  /** Which side the route is on, from the last position: for "head back to the route ... to your left". */
  let lastSide: 'left' | 'right' = 'left'
  /** Drift cue: since when the crew is a few metres off, whether it was said, and to which side. */
  let driftSince: number | null = null
  let driftSaid = false
  let drifting: 'left' | 'right' | null = null

  function load(p: RoutePlan, idPrefix: string) {
    plan = p
    maneuvers = buildManeuvers(p, stops, idPrefix)
    cums = p.legs.map((l) => cumulativeM(l.path))
    legStart = []
    let a = 0
    for (const c of cums) {
      legStart.push(a)
      a += c[c.length - 1]
    }
    legIndex = 0
    legAlong = 0
    announcer.resetNext()
  }
  load(plan, '')

  const legLength = (i: number) => cums[i][cums[i].length - 1]
  const homeId = () => plan.order[plan.order.length - 1]
  const name = (id: string) => stops[id]?.name ?? id

  function emit(type: NavEventType, id: string, text: string, priority: NavPriority, extra: { stopId?: string } = {}) {
    bus.emit({ id, type, text, priority, at: lastNow, ...extra })
    announcer.noteSpoken(lastNow)
  }

  /**
   * Maneuvers still ahead, with distances along the route from the current progress. A departure or a
   * "keep going" line stays in the list for a few metres after it is passed, so it can still be said
   * when another announcement held it back.
   */
  function upcoming(): UpcomingManeuver[] {
    const here = legStart[legIndex] + legAlong
    const ahead = (m: Maneuver) =>
      m.legAlongM >= legAlong - 0.01 || ((m.kind === 'depart' || m.kind === 'continue') && legAlong - m.legAlongM <= SAY_AFTER_M)
    return maneuvers
      .filter((m) =>
        status === 'at_stop' || status === 'finished'
          ? m.legIndex > legIndex
          : m.legIndex > legIndex || (m.legIndex === legIndex && ahead(m)),
      )
      .map((m) => ({ maneuver: m, distanceM: Math.max(0, m.alongM - here) }))
  }

  function state(ahead: UpcomingManeuver[]): NavState {
    const leg = plan.legs[legIndex]
    const legLen = legLength(legIndex)
    const legRemainingM = status === 'at_stop' || status === 'finished' ? 0 : Math.max(0, legLen - legAlong)
    const legRemainingMin = leg && legLen > 0 ? (leg.minutes * legRemainingM) / legLen : 0
    let routeRemainingM = legRemainingM
    let routeRemainingMin = legRemainingMin
    for (let i = legIndex + 1; i < plan.legs.length; i++) {
      routeRemainingM += legLength(i)
      routeRemainingMin += plan.legs[i].minutes
    }
    // Work time at every stop still to reach (the habitat needs none).
    const stopsLeft = plan.legs.slice(status === 'at_stop' ? legIndex + 1 : legIndex).filter((l) => l.toId !== homeId())
    routeRemainingMin += stopsLeft.length * mobility.stopMinutes
    const next = ahead.find((u) => u.maneuver.kind !== 'hazard') ?? null
    return {
      status,
      position: position ? { lat: position.lat, lon: position.lon } : null,
      headingDeg: position?.headingDeg ?? null,
      speedMps: position?.speedMps ?? 0,
      onRoute: offsetM <= OFF_ROUTE_M,
      offsetM: Math.round(offsetM),
      legIndex,
      legCount: plan.legs.length,
      nextStopId: status === 'finished' ? null : (plan.legs[status === 'at_stop' ? legIndex + 1 : legIndex]?.toId ?? null),
      visited: [...visited],
      legAlongM: Math.round(legAlong),
      next,
      legRemainingM: Math.round(legRemainingM),
      legRemainingMin,
      routeRemainingM: Math.round(routeRemainingM),
      routeRemainingMin,
      etaMs: status === 'idle' ? null : lastNow + routeRemainingMin * 60000,
      walkHomeMin,
      rerouteCount,
      abort,
      hazard: abort ? null : hazard,
      hazardDismissed,
      skipped: [...skipped],
      routeHeadingDeg:
        leg && (status === 'navigating' || status === 'off_route')
          ? bearingAlong(leg.path, cums[legIndex], legAlong, Math.min(legLen, legAlong + HEADING_AHEAD_M))
          : null,
      drifting,
    }
  }

  function publish() {
    const ahead = upcoming()
    bus.publishState(state(ahead), ahead)
  }

  /** Where `p` lies on the current leg, searching near the last progress first so a parallel stretch never wins. */
  function snap(p: LatLon): PathProjection {
    const path = plan.legs[legIndex].path
    const cum = cums[legIndex]
    let lo = 0
    while (lo + 1 < path.length - 1 && cum[lo + 1] < legAlong - SEARCH_BACK_M) lo++
    let hi = lo
    while (hi + 1 < path.length - 1 && cum[hi + 1] <= legAlong + SEARCH_AHEAD_M) hi++
    const near = projectOntoPath(path, p, cum, lo, hi)
    if (near.offsetM <= REROUTE_M || hi >= path.length - 2) return near
    // Far from the expected stretch: maybe the crew skipped ahead (a gap in positions). Only accept a clear match.
    const wide = projectOntoPath(path, p, cum, lo, path.length - 2)
    return wide.offsetM <= OFF_ROUTE_M ? wide : near
  }

  /** "to your left" or "to your right": where the route is, seen by someone facing along it. */
  function routeSide(s: PathProjection): 'left' | 'right' {
    return s.side === 'right' ? 'left' : 'right'
  }

  function arrive() {
    const leg = plan.legs[legIndex]
    const last = legIndex === plan.legs.length - 1
    const m = maneuvers.find((x) => x.legIndex === legIndex && (x.kind === 'arrive' || x.kind === 'arrive_home'))
    visited.push(leg.toId)
    status = last ? 'finished' : 'at_stop'
    legAlong = legLength(legIndex)
    emit('arrive', m?.id ?? `arrive-${legIndex}`, m?.text ?? `${name(leg.toId)} reached.`, 'high', {
      stopId: leg.toId,
    })
    const science = stops[leg.toId]?.science
    if (!last && science) {
      emit('stop_briefing', `briefing-${rerouteCount}-${legIndex}`, science, 'normal', { stopId: leg.toId })
    }
    if (last) emit('nav_ended', 'nav-ended', 'Navigation ended.', 'low')
  }

  /**
   * Plans a new route from `fix`. Off the route, it goes through the stops still ahead; for a hazard
   * abort (`home`), straight back to the habitat.
   */
  function reroute(fix: PositionFix, home = false) {
    if (!requestReroute) return
    status = 'rerouting'
    const token = ++rerouteToken
    const remaining = home ? [] : plan.legs.slice(legIndex).map((l) => l.toId).filter((id) => id !== homeId())
    if (!home) emit('off_route', `reroute-${token}-${fix.t}`, 'Off route. Replanning.', 'high')
    requestReroute({ lat: fix.lat, lon: fix.lon }, remaining).then(
      (p) => {
        if (token !== rerouteToken || status !== 'rerouting') return
        if (p.legs.length === 0) throw new Error('empty plan')
        rerouteCount++
        load(p, `r${rerouteCount}-`)
        status = 'navigating'
        offSince = null
        const first = p.legs[0]
        const skipped = p.unreachable.map(name)
        const skipText = skipped.length ? ` ${skipped.join(', ')} can no longer be reached and ${skipped.length > 1 ? 'are' : 'is'} skipped.` : ''
        emit(
          'rerouted',
          `rerouted-${rerouteCount}`,
          home
            ? `${abort === 'crew' ? 'Returning to base. ' : ''}Return route: ${saidDistance(first.distanceM)} to ${name(first.toId)}, about ${saidDuration(first.minutes)}.`
            : `New route: ${saidDistance(first.distanceM)} to ${name(first.toId)}.${skipText}`,
          home ? 'high' : 'normal',
        )
        publish()
      },
    ).catch(() => {
      if (token !== rerouteToken || status !== 'rerouting') return
      status = 'off_route'
      rerouteBlockedUntil = lastNow + REROUTE_RETRY_MS
      guidedAt = lastNow
      emit(
        'off_route',
        `reroute-failed-${token}`,
        home
          ? 'No safe return route found from here. Follow the planned route back.'
          : `No safe route. Head back to the route, ${saidDistance(offsetM)} to your ${lastSide}.`,
        'high',
      )
      publish()
    })
  }

  return {
    start() {
      if (status !== 'idle') return
      lastNow = clock()
      startedAt = lastNow
      status = 'navigating'
      const targets = plan.legs.filter((l) => l.toId !== homeId()).length
      emit(
        'nav_started',
        'nav-started',
        `Navigation started. ${targets} stop${targets === 1 ? '' : 's'}, ${saidDistance(plan.distanceM)}, about ${saidDuration(plan.totalMinutes)}.`,
        'normal',
      )
    },

    update(fix) {
      if (status === 'idle' || status === 'finished') return
      position = fix
      lastNow = fix.t
      const leg = plan.legs[legIndex]

      if (status === 'at_stop') {
        offsetM = 0
        publish()
        return
      }

      const s = snap(fix)
      offsetM = s.offsetM
      lastSide = routeSide(s)
      if (status !== 'rerouting') legAlong = s.alongM
      // Walk-back time between the two path points around the position.
      const [h0, h1] = [leg.walkHomeMin[s.segmentIndex], leg.walkHomeMin[s.segmentIndex + 1]]
      walkHomeMin = h0 === undefined ? null : h1 === undefined ? h0 : h0 + (h1 - h0) * s.t

      // Arrival: close to the stop, or matched to the end of the leg while on the route.
      const end = leg.path[leg.path.length - 1]
      if (
        status !== 'rerouting' &&
        (distanceM(fix, end) <= ARRIVE_M || (legLength(legIndex) - legAlong <= ARRIVE_M && offsetM <= OFF_ROUTE_M))
      ) {
        arrive()
        publish()
        return
      }

      // Off the route: wait a few seconds, then guide back, or plan again when far off.
      if (offsetM > OFF_ROUTE_M) {
        offSince ??= fix.t
        if (status !== 'rerouting' && fix.t - offSince >= OFF_ROUTE_DELAY_MS) {
          if (offsetM > REROUTE_M && requestReroute && fix.t >= rerouteBlockedUntil) {
            reroute(fix)
          } else if (status !== 'off_route' || fix.t - guidedAt >= GUIDE_REPEAT_MS) {
            status = 'off_route'
            guidedAt = fix.t
            emit(
              'off_route',
              `off-route-${fix.t}`,
              `Head back to the route, ${saidDistance(offsetM)} to your ${lastSide}.`,
              'high',
            )
          }
        }
      } else {
        offSince = null
        if (status === 'off_route' && offsetM < BACK_ON_ROUTE_M) {
          status = 'navigating'
          announcer.resetNext()
          emit('back_on_route', `back-on-route-${fix.t}`, 'Back on route.', 'normal')
        }
      }

      // Drift cue: a few metres off the line for a few seconds, before it counts as off the route. Said once;
      // said again only after coming back close to the line and drifting again.
      if (status === 'navigating' && offsetM >= DRIFT_M[mobility.id] && offsetM <= OFF_ROUTE_M) {
        driftSince ??= fix.t
        if (fix.t - driftSince >= DRIFT_DELAY_MS) {
          // lastSide is where the route is; the crew drifted to the other side.
          drifting = lastSide === 'left' ? 'right' : 'left'
          if (!driftSaid) {
            driftSaid = true
            emit('drift', `drift-${fix.t}`, `Drifting ${drifting}. Correct ${lastSide}.`, 'normal')
          }
        }
      } else {
        driftSince = null
        drifting = null
        if (offsetM < DRIFT_RESET_M) driftSaid = false
      }

      // A caution, not an alarm: said once each time the crew goes out past the reserve, again only after
      // coming back well inside it (WALKBACK_REARM_MIN), so walking along the line does not repeat it.
      if (!walkBackWarned && walkHomeMin !== null && walkHomeMin > WALK_BACK_RESERVE_MIN) {
        walkBackWarned = true
        emit(
          'walkback_warning',
          `walkback-warning-${fix.t}`,
          `Caution. Habitat is more than ${WALK_BACK_RESERVE_MIN} minutes away on foot. Beyond the emergency reserve.`,
          'normal',
        )
      } else if (walkBackWarned && walkHomeMin !== null && walkHomeMin < WALK_BACK_RESERVE_MIN - WALKBACK_REARM_MIN) {
        walkBackWarned = false
      }
      if (departLmst !== undefined) {
        const lmst = departLmst + (fix.t - startedAt) / 60000
        for (const a of timeAlertsBetween(checkedLmst, lmst)) emit('time_alert', a.id, a.text, a.priority)
        checkedLmst = Math.max(checkedLmst, lmst)
      }
      if (!turnBackSaid && !abort && turnBackAtMs !== undefined && fix.t >= turnBackAtMs) {
        turnBackSaid = true
        emit('turn_back_time', 'turn-back-time', 'Turn-back time reached. Head back to the habitat now.', 'high')
      }
      if (hazard && hazardDismissed && !abort && fix.t - hazardRemindedAt >= HAZARD_REMINDER_MS) {
        hazardRemindedAt = fix.t
        emit(
          'hazard_event',
          `hazard-reminder-${fix.t}`,
          `Reminder: ${HAZARD_EVENTS[hazard].label.toLowerCase()} warning active. Return to base when you can.`,
          'normal',
        )
      }

      const ahead = upcoming()
      if (status === 'navigating') {
        announcer.update(
          ahead.filter((u) => u.maneuver.legIndex === legIndex),
          fix.t,
        )
      }
      bus.publishState(state(ahead), ahead)
    },

    continueFromStop() {
      if (status !== 'at_stop') return
      legIndex++
      legAlong = 0
      offSince = null
      status = 'navigating'
      announcer.resetNext()
      publish()
    },

    warnHazard(kind) {
      if (abort || status === 'idle' || status === 'finished') return false
      hazard = kind
      hazardDismissed = false
      emit('hazard_event', `hazard-${kind}-${lastNow}`, HAZARD_EVENTS[kind].text, 'high')
      publish()
      return true
    },

    returnToBase(reason) {
      if (abort || status === 'idle' || status === 'finished') return false
      abort = reason
      const ahead = plan.legs.slice(status === 'at_stop' ? legIndex + 1 : legIndex).map((l) => l.toId)
      skipped = ahead.filter((id) => id !== homeId() && !visited.includes(id))
      if (position) reroute(position, true)
      publish()
      return true
    },

    continueDespiteHazard() {
      if (!hazard || abort) return
      hazardDismissed = true
      hazardRemindedAt = lastNow
      publish()
    },

    abortToHabitat(kind) {
      if (!this.warnHazard(kind)) return false
      return this.returnToBase(kind)
    },

    stop() {
      if (status === 'idle') return
      lastNow = clock()
      rerouteToken++
      const wasFinished = status === 'finished'
      status = 'idle'
      // Ended by the crew: the event is kept for listeners, but there is nothing to say (silence on End).
      if (!wasFinished) emit('nav_ended', 'nav-ended', '', 'low')
      publish()
    },

    getState: () => state(upcoming()),
    getPlan: () => plan,
    getManeuvers: () => maneuvers,
  }
}
