// Turns a planned route into turn-by-turn instructions, the way a car navigator does.
// Route paths are chains of 10 m terrain cells, so they zig-zag at the cell scale. The path is first
// simplified like the line drawn on the map, and every corner of 20 degrees or more becomes a turn: on open
// ground there is no visible path, so each bend the crew has to make is announced.
import type { LatLon, MobilityId, RouteLeg, RouteNote, RoutePlan, Target } from '../types.ts'
import { DISPLAY_TOLERANCE_M } from './display.ts'
import {
  bearingAlong,
  bearingDeg,
  compassName,
  cumulativeM,
  pointAlong,
  projectOntoPath,
  simplifyPath,
  turnAngle,
} from './geometry.ts'

/** Douglas–Peucker tolerance, metres: the same as the drawn line, so turns sit at its corners. */
const SIMPLIFY_M = DISPLAY_TOLERANCE_M
/** The direction of departure is measured over this distance, metres. */
const LOOK_M = 30
/** Two opposite turns at most this far apart (metres) that shift the path less than JOG_SIDE_M sideways are dropped. */
const JOG_MAX_M = 100
const JOG_SIDE_M = 20
/** No turn this close to the start or end of a leg: departing and arriving cover it, metres. */
const LEG_END_MARGIN_M = 20
/** After a turn, "go straight for ..." is said only when the next maneuver is farther than this, metres. */
const CONTINUE_MIN_M = 300
/** ... and that line sits this far past the turn, metres. */
const CONTINUE_AFTER_M = 15
/** A detour note explains the turn nearest to it within this distance along the path, metres. */
const NOTE_TO_TURN_M = 80

/**
 * Turn classes by angle, degrees: from `slight` a slight turn, from `bear` a bear, from `normal` a turn, above
 * `sharp` a sharp turn. Below `slight`, no turn: the drawn line's corners are 5-47 degrees, and the smallest
 * wiggles are covered by the heading on screen and the drift cue.
 */
const TURN_LIMITS = { slight: 20, bear: 35, normal: 60, sharp: 120 }

export type ManeuverKind = 'depart' | 'turn' | 'continue' | 'hazard' | 'arrive' | 'arrive_home'
export type TurnModifier =
  | 'slight_left' | 'bear_left' | 'left' | 'sharp_left'
  | 'slight_right' | 'bear_right' | 'right' | 'sharp_right'

/** One instruction on the route, with the data behind it so a voice can phrase it its own way. */
export interface Maneuver {
  /** Stable id: the same route gives the same ids. */
  id: string
  kind: ManeuverKind
  /** Only on turns. */
  modifier?: TurnModifier
  /** Signed turn angle, degrees, positive to the right. Only on turns. */
  angleDeg?: number
  /** Compass heading after the maneuver, degrees. On depart, turn and continue. */
  headingDeg?: number
  /** Index of the leg in the plan. */
  legIndex: number
  at: LatLon
  /** Distance from the start of the route, metres. */
  alongM: number
  /** Distance from the start of its leg, metres. */
  legAlongM: number
  /** Distance to the next maneuver of the route, metres. 0 for the last one. */
  distanceToNextM: number
  /**
   * The instruction itself, without a distance in front: "Turn left to avoid a 24° slope",
   * "Head north-east for 400 m", "Steep stretch ahead: 14°, about 80 m. Slow down."
   */
  text: string
  /** Why the route turns here, when a route note explains it: "to avoid a 24° slope". */
  reason?: string
  /** On arrive and arrive_home: the stop reached. On depart: the stop left. */
  stopId?: string
  /** Name of `stopId`, as shown to the crew. */
  stopName?: string
  /** On hazards: steepest slope and length of the stretch. */
  slopeDeg?: number
  lengthM?: number
}

/** Distance as it is spoken: "40 m", "350 m", "1.2 km". */
export function spokenDistance(m: number): string {
  if (m < 100) return `${Math.max(10, Math.round(m / 10) * 10)} m`
  if (m < 950) return `${Math.round(m / 50) * 50} m`
  const km = Math.round(m / 100) / 10
  return `${Number.isInteger(km) ? km.toFixed(0) : km.toFixed(1)} km`
}

/** Distance as a voice says it, without abbreviations a speech engine would misread: "40 meters", "1.2 kilometers". */
export function saidDistance(m: number): string {
  return spokenDistance(m).replace(/ m$/, ' meters').replace(/ km$/, ' kilometers')
}

/** Turn class for a signed angle, or null when it is straight on. */
export function classifyTurn(angleDeg: number): TurnModifier | null {
  const a = Math.abs(angleDeg)
  if (a < TURN_LIMITS.slight) return null
  const side = angleDeg > 0 ? 'right' : 'left'
  if (a < TURN_LIMITS.bear) return `slight_${side}`
  if (a < TURN_LIMITS.normal) return `bear_${side}`
  if (a <= TURN_LIMITS.sharp) return side
  return `sharp_${side}`
}

const TURN_WORDS: Record<TurnModifier, string> = {
  slight_left: 'Slight left',
  bear_left: 'Bear left',
  left: 'Turn left',
  sharp_left: 'Turn sharp left',
  slight_right: 'Slight right',
  bear_right: 'Bear right',
  right: 'Turn right',
  sharp_right: 'Turn sharp right',
}

const verb = (m: MobilityId) => (m === 'rover' ? 'Drive' : 'Walk')

/** Why the route turns, in a few words, from a detour note. */
function reasonFor(note: RouteNote, profile: RoutePlan['profile']): string {
  if (note.kind === 'no-go') {
    return note.slopeDeg ? `to avoid a ${note.slopeDeg}° slope` : 'to stay off unmapped ground'
  }
  return profile === 'gentle' ? 'to stay on gentler ground' : 'to go around slower ground'
}

/** A change of direction found on the simplified path, before it is turned into a maneuver. */
interface Bend {
  legAlongM: number
  angleDeg: number
  /** Compass bearing of the segment after the bend. */
  outDeg: number
}

/**
 * Changes of direction along one path: every corner of the line drawn on the map (the path simplified the
 * same way as the drawn line), measured from the segment coming in to the segment going out. No merging:
 * on open ground with no visible path, each bend the crew has to make gets its own instruction.
 */
function findBends(path: LatLon[], cum: number[]): Bend[] {
  const length = cum[cum.length - 1]
  const kept = simplifyPath(path, SIMPLIFY_M)
  const bends: Bend[] = []
  for (let k = 1; k + 1 < kept.length; k++) {
    const [a, b, c] = [path[kept[k - 1]], path[kept[k]], path[kept[k + 1]]]
    const along = cum[kept[k]]
    if (along <= LEG_END_MARGIN_M || along >= length - LEG_END_MARGIN_M) continue
    const outDeg = bearingDeg(b, c)
    bends.push({ legAlongM: along, angleDeg: turnAngle(bearingDeg(a, b), outDeg), outDeg })
  }
  const turns = bends.filter((t) => classifyTurn(t.angleDeg) !== null)
  // A jog: two opposite turns close together that shift the path only a little sideways. Walking
  // straight through stays near the line, so neither is worth an instruction.
  const out: Bend[] = []
  for (let k = 0; k < turns.length; k++) {
    const a = turns[k]
    const b = turns[k + 1]
    if (b && Math.sign(a.angleDeg) !== Math.sign(b.angleDeg)) {
      const gap = b.legAlongM - a.legAlongM
      const shift = gap * Math.sin((Math.min(Math.abs(a.angleDeg), Math.abs(b.angleDeg)) * Math.PI) / 180)
      if (gap <= JOG_MAX_M && shift < JOG_SIDE_M && Math.abs(a.angleDeg + b.angleDeg) < TURN_LIMITS.slight) {
        k++
        continue
      }
    }
    out.push(a)
  }
  return out
}

/** Maneuvers of one leg, with distances from the start of the leg. Distances to the next are filled in later. */
function legManeuvers(
  plan: RoutePlan,
  leg: RouteLeg,
  legIndex: number,
  stops: Record<string, Target>,
  idPrefix: string,
): Maneuver[] {
  const path = leg.path
  const cum = cumulativeM(path)
  const length = cum[cum.length - 1]
  // Points are looked up on the path, so maneuvers sit exactly on the line drawn on the map.
  const at = (a: number) => pointAlong(path, cum, a)
  const id = (kind: string, a: number) => `${idPrefix}${legIndex}-${kind}-${Math.round(a)}`
  const out: Maneuver[] = []

  const heading = bearingAlong(path, cum, 0, Math.min(length, LOOK_M))
  out.push({
    id: id('depart', 0),
    kind: 'depart',
    headingDeg: heading,
    legIndex,
    at: path[0],
    alongM: 0,
    legAlongM: 0,
    distanceToNextM: 0,
    text: `Head ${compassName(heading)}`,
    stopId: leg.fromId,
    stopName: stops[leg.fromId]?.name,
  })

  // Detour notes become the reason of the nearest turn; steep notes become hazards.
  const notes = leg.notes.map((n) => ({ note: n, alongM: projectOntoPath(path, n.at, cum).alongM }))
  const turns: Maneuver[] = findBends(path, cum).map((b) => {
    const modifier = classifyTurn(b.angleDeg)!
    return {
      id: id('turn', b.legAlongM),
      kind: 'turn',
      modifier,
      angleDeg: Math.round(b.angleDeg),
      headingDeg: b.outDeg,
      legIndex,
      at: at(b.legAlongM),
      alongM: 0,
      legAlongM: b.legAlongM,
      distanceToNextM: 0,
      text: TURN_WORDS[modifier],
    }
  })
  for (const { note, alongM } of notes) {
    if (note.kind === 'steep') continue
    let nearest: Maneuver | null = null
    for (const t of turns) {
      const d = Math.abs(t.legAlongM - alongM)
      if (d <= NOTE_TO_TURN_M && (!nearest || d < Math.abs(nearest.legAlongM - alongM))) nearest = t
    }
    if (nearest && !nearest.reason) {
      nearest.reason = reasonFor(note, plan.profile)
      nearest.text = `${nearest.text} ${nearest.reason}`
    }
  }
  out.push(...turns)

  for (const { note, alongM } of notes) {
    if (note.kind !== 'steep') continue
    const lengthM = note.lengthM ?? 0
    const startM = Math.max(0, alongM - lengthM / 2)
    const deg = note.slopeDeg ?? 0
    out.push({
      id: id('hazard', startM),
      kind: 'hazard',
      legIndex,
      at: at(startM),
      alongM: 0,
      legAlongM: startM,
      distanceToNextM: 0,
      text: `Steep ground ahead, ${deg} degrees, ${saidDistance(lengthM)}. Slow down.`,
      slopeDeg: deg,
      lengthM,
    })
  }

  const home = legIndex === plan.legs.length - 1
  const stop = stops[leg.toId]
  const name = stop?.name ?? leg.toId
  out.push({
    id: id(home ? 'home' : 'arrive', length),
    kind: home ? 'arrive_home' : 'arrive',
    legIndex,
    at: path[path.length - 1],
    alongM: 0,
    legAlongM: length,
    distanceToNextM: 0,
    text: home
      ? `${name} reached. Excursion complete.`
      : `${name} reached.${stop?.task ? ` Task: ${stop.task}` : ''}`,
    stopId: leg.toId,
    stopName: name,
  })
  return out.sort((p, q) => p.legAlongM - q.legAlongM)
}

/**
 * Every maneuver of the route, in route order, with distances from the route start.
 * `stops` holds the habitat and the targets by id, for names and tasks.
 * `idPrefix` keeps ids of a rerouted plan apart from the ones already announced.
 */
export function buildManeuvers(plan: RoutePlan, stops: Record<string, Target>, idPrefix = ''): Maneuver[] {
  const all: Maneuver[] = []
  let offset = 0
  plan.legs.forEach((leg, i) => {
    const ms = legManeuvers(plan, leg, i, stops, idPrefix)
    for (const m of ms) m.alongM = offset + m.legAlongM
    all.push(...ms)
    offset += ms[ms.length - 1].legAlongM
  })

  // Distances to the next maneuver, then "keep going" lines after turns with a long way to the next one.
  const actionable = (m: Maneuver) => m.kind !== 'hazard'
  const out: Maneuver[] = []
  for (let k = 0; k < all.length; k++) {
    const m = all[k]
    const next = all.slice(k + 1).find(actionable)
    if (next) m.distanceToNextM = next.alongM - m.alongM
    out.push(m)
    if (m.kind === 'depart' && next) {
      m.text = `${m.text} for ${saidDistance(m.distanceToNextM)}`
    }
    if (m.kind === 'turn' && next && m.distanceToNextM > CONTINUE_MIN_M) {
      // Placed just after the turn, so it is said once the turn is done.
      const leg = plan.legs[m.legIndex]
      const legAlongM = m.legAlongM + CONTINUE_AFTER_M
      const left = m.distanceToNextM - CONTINUE_AFTER_M
      out.push({
        id: `${m.id}-continue`,
        kind: 'continue',
        headingDeg: m.headingDeg,
        legIndex: m.legIndex,
        at: pointAlong(leg.path, cumulativeM(leg.path), legAlongM),
        alongM: m.alongM + CONTINUE_AFTER_M,
        legAlongM,
        distanceToNextM: left,
        text: `${verb(plan.mobility)} straight for ${saidDistance(left)}`,
      })
    }
  }
  return out
}

/** How far ahead an announcement is made. */
export type AnnounceStage = 'far' | 'near' | 'now'

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

/** "Turn left in 200 meters, to avoid a 24° slope": the distance goes right after the action, the reason last. */
function inDistance(m: Maneuver, distanceM: number): string {
  const action = m.reason ? m.text.slice(0, -m.reason.length).trim() : m.text
  return `${action} in ${saidDistance(distanceM)}${m.reason ? `, ${m.reason}` : ''}`
}

/**
 * The sentence to speak for a maneuver at one stage: "In 200 m, turn left to avoid a 24° slope."
 * `then` is the maneuver right after it, named when it follows closely ("..., then bear right.").
 */
export function phrase(m: Maneuver, stage: AnnounceStage, distanceM: number, then?: Maneuver): string {
  const tail = then && (then.kind === 'turn' || then.kind === 'arrive' || then.kind === 'arrive_home')
    ? `, then ${then.kind === 'turn' ? lowerFirst(then.text) : 'stop'}`
    : ''
  switch (m.kind) {
    case 'turn':
      return stage === 'now'
        ? sentence(`${m.text}${tail}`)
        : sentence(inDistance(m, distanceM))
    case 'arrive':
    case 'arrive_home': {
      if (stage === 'now') return m.text
      const name = m.stopName ?? (m.kind === 'arrive_home' ? 'Habitat' : 'Stop')
      return `${name} in ${saidDistance(distanceM)}.`
    }
    case 'depart':
    case 'continue':
    case 'hazard':
      return sentence(`${m.text}${m.kind === 'hazard' ? '' : tail}`)
  }
}
