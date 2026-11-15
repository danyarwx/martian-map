// Every line the voice will say on a route that can be known in advance, so its audio can be fetched in
// the background at Start and is ready the moment it is needed. Lines with live numbers ("New route: 2.7
// kilometers…", answers to questions) cannot be known; they are fetched when said.
import type { MobilityId, Target } from '../types.ts'
import { HAZARD_EVENTS, type HazardKind } from '../lib/safety.ts'
import { TIME_ALERTS } from './alerts.ts'
import { ANNOUNCE_M } from './announcer.ts'
import { phrase, type Maneuver } from './instructions.ts'
import { LINES } from './tracker.ts'

/** The route's own lines, in the order they will be said (first ones first). No duplicates. */
export function predictableLines(maneuvers: Maneuver[], stops: Record<string, Target>, mobility: MobilityId): string[] {
  const at = ANNOUNCE_M[mobility]
  const out: string[] = []
  for (const m of maneuvers) {
    switch (m.kind) {
      case 'turn':
        // The heads-ups at their usual distances; said closer when the turn became next late.
        out.push(phrase(m, 'far', at.far), phrase(m, 'near', at.near), phrase(m, 'now', 0))
        break
      case 'depart':
      case 'continue':
      case 'hazard':
        out.push(phrase(m, 'now', 0))
        break
      case 'arrive':
      case 'arrive_home': {
        out.push(phrase(m, 'near', at.near), m.text)
        const science = m.kind === 'arrive' && m.stopId ? stops[m.stopId]?.science : undefined
        if (science) out.push(science)
        break
      }
    }
  }
  return [...new Set(out.filter(Boolean))]
}

/** Lines that do not depend on the route: alerts, cautions, drift cues. */
export function fixedLines(): string[] {
  const kinds = Object.keys(HAZARD_EVENTS) as HazardKind[]
  return [
    ...TIME_ALERTS.map((a) => a.text),
    ...kinds.map((k) => HAZARD_EVENTS[k].text),
    ...kinds.map(LINES.hazardReminder),
    LINES.drift('left'),
    LINES.drift('right'),
    LINES.offRoute,
    LINES.backOnRoute,
    LINES.walkBack,
    LINES.turnBack,
  ]
}
