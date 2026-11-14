// When to say what, the way a car navigator does: a turn is announced from afar, again close by, and once
// more when it is time to act. Each announcement is made once per maneuver.
import type { MobilityId } from '../types.ts'
import type { NavBus, NavPriority, UpcomingManeuver } from './events.ts'
import { phrase, type AnnounceStage, type Maneuver } from './instructions.ts'

/** Distances at which a turn is announced, metres. Faster rover, earlier warnings. */
export const ANNOUNCE_M: Record<MobilityId, Record<AnnounceStage, number> & { hazard: number }> = {
  walk: { far: 200, near: 50, now: 12, hazard: 75 },
  rover: { far: 400, near: 100, now: 15, hazard: 150 },
}

/** Two announcements are at least this far apart, unless the second one is high priority, milliseconds. */
export const MIN_GAP_MS = 2000

/** A turn this close after another is named with it: "Turn left, then bear right." Metres. */
const THEN_WITHIN_M = 40

/** Departures and "keep going" lines are said when the crew is this close to them, metres. */
const ONCE_WITHIN_M = 30

const STAGES_OUTWARD: AnnounceStage[] = ['now', 'near', 'far']

const STAGE_PRIORITY: Record<AnnounceStage, NavPriority> = { far: 'low', near: 'normal', now: 'high' }

/**
 * Stages said for a maneuver, closest first. Turns get all three; departures and "keep going" lines are
 * said once, when reached; arrivals get only the close warning (the navigator announces the arrival itself).
 */
function stagesOf(m: Maneuver): AnnounceStage[] {
  if (m.kind === 'turn') return STAGES_OUTWARD
  return m.kind === 'depart' || m.kind === 'continue' ? ['now'] : ['near']
}

export interface Announcer {
  /** Looks at what is ahead and emits whatever is due. `upcoming` is in route order, distances ≥ 0. */
  update(upcoming: UpcomingManeuver[], now: number): void
  /** Forgets the current "next" maneuver, e.g. after a stop or a reroute. Fired announcements stay fired. */
  resetNext(): void
  /** Tells the announcer something else was just said (an arrival, an off-route warning), for the 2 s gap. */
  noteSpoken(now: number): void
}

export function createAnnouncer(bus: NavBus, mobility: MobilityId): Announcer {
  const limits = ANNOUNCE_M[mobility]
  /** `${maneuver id}@${stage}` for every announcement made or skipped. */
  const done = new Set<string>()
  let nextId: string | null = null
  let lastAt = -Infinity

  /** Emits unless another announcement went out too recently. Returns whether it went out. */
  function say(m: Maneuver, stage: AnnounceStage | 'hazard', distanceM: number, text: string, priority: NavPriority, now: number) {
    if (priority !== 'high' && now - lastAt < MIN_GAP_MS) return false
    done.add(`${m.id}@${stage}`)
    lastAt = now
    bus.emit({
      id: `${m.id}@${stage}`,
      type: m.kind === 'hazard' ? 'hazard' : 'instruction',
      text,
      priority,
      maneuver: m,
      distanceM: Math.round(distanceM),
      stopId: m.stopId,
      at: now,
    })
    return true
  }

  return {
    resetNext() {
      nextId = null
    },
    noteSpoken(now) {
      lastAt = Math.max(lastAt, now)
    },
    update(upcoming, now) {
      // Hazards: once, shortly before the steep stretch starts.
      for (const { maneuver: m, distanceM } of upcoming) {
        if (m.kind !== 'hazard' || distanceM > limits.hazard || done.has(`${m.id}@hazard`)) continue
        say(m, 'hazard', distanceM, phrase(m, 'now', distanceM), 'normal', now)
      }

      // The next maneuver is the first one with something left to say.
      const actionable = upcoming.filter(
        (u) => u.maneuver.kind !== 'hazard' && !stagesOf(u.maneuver).every((s) => done.has(`${u.maneuver.id}@${s}`)),
      )
      const first = actionable[0]
      if (!first) return
      const { maneuver: m, distanceM } = first

      // A maneuver that becomes next already inside a threshold skips the announcements it is too close for.
      if (m.id !== nextId) {
        nextId = m.id
        if (distanceM < limits.far) done.add(`${m.id}@far`)
        if (distanceM <= limits.now) done.add(`${m.id}@near`)
      }

      const stages = stagesOf(m)
      const reach = (stage: AnnounceStage) => (m.kind !== 'turn' && stage === 'now' ? ONCE_WITHIN_M : limits[stage])
      const then = actionable[1]
      const follows = then && then.distanceM - distanceM <= THEN_WITHIN_M ? then.maneuver : undefined
      // Say the closest stage that is due. Once it is said, the farther ones are pointless.
      const due = stages.find((s) => !done.has(`${m.id}@${s}`) && distanceM <= reach(s))
      if (!due) return
      const priority = m.kind === 'turn' ? STAGE_PRIORITY[due] : 'normal'
      if (say(m, due, distanceM, phrase(m, due, distanceM, due === 'now' ? follows : undefined), priority, now)) {
        for (const s of STAGES_OUTWARD.slice(STAGES_OUTWARD.indexOf(due))) done.add(`${m.id}@${s}`)
      }
    },
  }
}
