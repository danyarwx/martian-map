// The facts a voice question is answered from. The tablet sends them with the recorded question to
// api/ask.js, where a language model picks the ones that answer it. The model is told to use nothing else,
// so everything the crew may ask about has to be written here, in plain words with units spelled out.
import { evaDoseMsv, HAZARD_EVENTS, WALK_BACK_RESERVE_MIN } from '../lib/safety.ts'
import { clock, DAY, temperatureC } from '../lib/schedule.ts'
import type { Mobility, RoutePlan, Target } from '../types.ts'
import { saidDuration } from './alerts.ts'
import type { NavState, UpcomingManeuver } from './events.ts'
import { compassName } from './geometry.ts'
import { saidDistance } from './instructions.ts'

/** The snapshot is cut at this length; api/ask.js refuses longer ones. */
export const ASK_CONTEXT_MAX_CHARS = 4000

export interface AskContextInput {
  state: NavState
  upcoming: UpcomingManeuver[]
  /** The route being followed: the planned one, or the latest replan. */
  plan: RoutePlan
  mobility: Mobility
  stops: Record<string, Target>
  /** Minutes since leaving the habitat (mission time). */
  minutesOut: number
  /** Mars time of day now, LMST minutes since midnight. */
  lmst: number
  /** Latest time to turn back, LMST minutes, null when unknown. */
  turnBackLmst: number | null
  /** The route straight back to the habitat from here, with the run's mobility. Null until planned. */
  base: { distanceM: number; minutes: number } | null
}

const degreesC = (c: number) => {
  const t = Math.round(c)
  return t < 0 ? `minus ${-t} degrees Celsius` : `${t} degrees Celsius`
}

/** One fact per line, about 25 lines. */
export function askContext(i: AskContextInput): string {
  const s = i.state
  const lines: string[] = []
  const moving = i.mobility.id === 'rover' ? 'driving' : 'on foot'
  const name = (id: string | null | undefined) => (id ? (i.stops[id]?.name ?? id) : 'unknown')
  const habitatId = i.plan.order[i.plan.order.length - 1]

  lines.push(`Travel mode: ${i.mobility.id === 'rover' ? 'crew rover' : 'on foot'}.`)
  lines.push(`Mars time now: ${clock(i.lmst)} local mean solar time. Out of the habitat for ${saidDuration(i.minutesOut)}.`)

  // Where the excursion stands.
  if (s.abort) {
    const why = s.abort === 'crew' ? 'the crew chose to return early' : `${HAZARD_EVENTS[s.abort].label.toLowerCase()} warning`
    lines.push(`Returning to base on the fastest safe route: ${why}.`)
  }
  if (s.hazard) {
    lines.push(
      `Active warning: ${HAZARD_EVENTS[s.hazard].text} ${s.hazardDismissed ? 'The crew chose to continue the route for now.' : 'Waiting for the crew to choose: go to base or continue.'}`,
    )
  }
  if (s.skipped.length) lines.push(`Stops skipped by returning early: ${s.skipped.map(name).join(', ')}.`)
  const status: Record<NavState['status'], string> = {
    idle: 'Navigation not started.',
    navigating: 'On the way to the next stop.',
    at_stop: `At the stop ${name(s.visited[s.visited.length - 1])}, working.`,
    off_route: `Off the route, ${saidDistance(s.offsetM)} from it. Guiding back or replanning.`,
    rerouting: 'Planning a new route from here.',
    finished: 'Back at the habitat. Excursion finished.',
  }
  lines.push(`Status: ${status[s.status]}`)

  // Next stop.
  const next = s.nextStopId ? i.stops[s.nextStopId] : null
  if (next && s.status !== 'finished') {
    const isHome = s.nextStopId === habitatId
    lines.push(
      `Next stop: ${next.name}. ${saidDistance(s.legRemainingM)} away, about ${saidDuration(s.legRemainingMin)} ${moving}.`,
    )
    if (!isHome) {
      lines.push(`Task at ${next.name}: ${next.task}`)
      lines.push(`Why ${next.name}: ${next.science}`)
      lines.push(`Planned time working at each stop: ${saidDuration(i.mobility.stopMinutes)}.`)
    }
  }
  const after = i.plan.order.slice(s.legIndex + 2, -1).map(name)
  lines.push(after.length ? `Stops after the next one, in order: ${after.join(', ')}. Then the habitat.` : 'After the next stop: back to the habitat.')
  const done = s.visited.filter((id) => id !== habitatId).map(name)
  lines.push(done.length ? `Stops done: ${done.join(', ')}.` : 'Stops done: none yet.')

  // The rest of the excursion.
  if (s.status !== 'finished') {
    lines.push(
      `Rest of the route, stops included: ${saidDistance(s.routeRemainingM)}, about ${saidDuration(s.routeRemainingMin)}. Expected back at the habitat at ${clock(i.lmst + s.routeRemainingMin)}.`,
    )
  }

  // Way home and the emergency reserve.
  if (i.base) {
    lines.push(`Straight back to the habitat from here: ${saidDistance(i.base.distanceM)}, about ${saidDuration(i.base.minutes)} ${moving}.`)
  }
  if (s.walkHomeMin !== null) {
    const beyond = s.walkHomeMin > WALK_BACK_RESERVE_MIN
    lines.push(
      `Walking home on foot from here in an emergency: about ${saidDuration(s.walkHomeMin)}. Emergency reserve is ${WALK_BACK_RESERVE_MIN} minutes: ${beyond ? 'currently BEYOND the reserve' : 'within the reserve'}.`,
    )
  }

  // Which way.
  if (s.routeHeadingDeg !== null) {
    lines.push(`Direction to ${i.mobility.id === 'rover' ? 'drive' : 'walk'}: ${Math.round(s.routeHeadingDeg)} degrees, ${compassName(s.routeHeadingDeg)}.`)
  }
  if (s.drifting) lines.push(`Drifting ${s.drifting} of the route line; correct ${s.drifting === 'left' ? 'right' : 'left'}.`)
  else if (s.onRoute && s.status === 'navigating') lines.push('On the route line.')
  const turn = i.upcoming.find((u) => u.maneuver.kind === 'turn')
  if (turn) {
    const why = turn.maneuver.reason ? `, ${turn.maneuver.reason}` : ''
    lines.push(`Next turn: ${turn.maneuver.text} in ${saidDistance(turn.distanceM)}${why}.`)
  } else {
    lines.push('Next turn: none before the next stop.')
  }
  const steep = i.upcoming.find((u) => u.maneuver.kind === 'hazard')
  if (steep?.maneuver.slopeDeg) {
    lines.push(
      `Steep ground ahead: ${Math.round(steep.maneuver.slopeDeg)} degrees over about ${saidDistance(steep.maneuver.lengthM ?? 0)}, starting in ${saidDistance(steep.distanceM)}.`,
    )
  } else {
    lines.push('Steep ground ahead: none announced before the next stop.')
  }

  // Safety: radiation, weather, light, turn-back time.
  const hoursOut = i.minutesOut / 60
  const tripHours = (i.minutesOut + (s.status === 'finished' ? 0 : s.routeRemainingMin)) / 60
  lines.push(
    `Radiation dose so far: ${evaDoseMsv(hoursOut).toFixed(2)} millisieverts. Expected for the whole excursion: ${evaDoseMsv(tripHours).toFixed(2)} millisieverts. Typical dose on the Mars surface: 0.64 millisieverts per day (Curiosity RAD). No solar particle event unless announced.`,
  )
  lines.push(
    `Air temperature now: ${degreesC(temperatureC(i.lmst))}. In one hour: ${degreesC(temperatureC(i.lmst + 60))}. Warmest today ${degreesC(DAY.warmestC)} at ${clock(DAY.warmestAt)}. Typical sol from Perseverance MEDA data, not a forecast.`,
  )
  const gusts =
    i.lmst < DAY.gustsFrom
      ? `start in ${saidDuration(DAY.gustsFrom - i.lmst)}`
      : i.lmst < DAY.gustsTo
        ? 'now'
        : 'over for today'
  lines.push(`Gust hours, strong gusts and dust devils: ${clock(DAY.gustsFrom)} to ${clock(DAY.gustsTo)}, ${gusts}.`)
  const daylight = DAY.sunset - i.lmst
  lines.push(`Sunset at ${clock(DAY.sunset)}. Daylight left: ${daylight > 0 ? saidDuration(daylight) : 'none, it is after sunset'}.`)
  if (i.turnBackLmst !== null) {
    const left = i.turnBackLmst - i.lmst
    lines.push(
      `Latest turn-back time: ${clock(i.turnBackLmst)}, ${left > 0 ? `in ${saidDuration(left)}` : 'already passed, head back now'}.`,
    )
  }
  lines.push(`Longest allowed excursion: ${i.mobility.maxEvaHours} hours.`)

  return lines.join('\n').slice(0, ASK_CONTEXT_MAX_CHARS)
}
