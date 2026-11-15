// One helmet session: the renderer, the world, the player and the frame loop. No React in here: HelmetView
// creates a session when its data has loaded, draws the HUD from the state the session reports, and disposes it.
import * as THREE from 'three'
import { JEZERO } from '../data/jezero.ts'
import { displayLine } from '../nav/display.ts'
import { MOBILITY } from '../lib/mobility.ts'
import type { LatLon, RoutePlan, Terrain } from '../types.ts'
import { HAZARD, type CvFrame, type CvResult, type Detection, type HelmetDetour, type HelmetEntry, type HelmetExit, type Pose } from './contracts.ts'
import { CvClient } from './cv/client.ts'
import { HazardMap } from './mapping/fuse.ts'
import { buildTrack, locate, pointAhead, remainingM, type RouteTrack } from './nav/follow.ts'
import { GuideKeeper } from './nav/guide.ts'
import { LocalPlanner, type LocalPlan } from './nav/localPlanner.ts'
import { remainingMinutes, remainingPath, remainingStops, ReplanClient, ReplanDecider } from './nav/replan.ts'
import { dirToHeading, GRID_CELL_M, headingToDir, localToThree, toLatLon, toLocal } from './frames.ts'
import { SceneOverlay } from './hud/SceneOverlay.ts'
import { RockTracks } from './mapping/rockTracks.ts'
import { toLatLonBounds } from './mapping/hazardGrid.ts'
import { Controls } from './sim/controls.ts'
import { CV_MAX_DISP, CvRig } from './sim/cvRig.ts'
import type { JumpTarget } from './sim/jump.ts'
import { EYE_M, FAST_FACTOR, stepPlayer, type Ground, type MoveResult, type RockLike } from './sim/player.ts'
import { makeCoarseGrid } from './world/heightField.ts'
import { headingAlong } from './world/path.ts'
import type { RoutesFile } from './world/routes.ts'
import { DEMO_HALF_WIDTH_M } from './world/rocks.ts'
import { World } from './world/scene.ts'
import type { TileIndex } from './world/tileGrid.ts'

export interface SessionData {
  index: TileIndex
  terrain: Terrain
  routes: RoutesFile
}

/** What the HUD shows, reported a few times a second. */
export interface HudState {
  fps: number
  loading: boolean
  coarse: boolean
  /** Local ENU position of the eyes and where they look. */
  pose: Pose
  /** Leg of the plan the astronaut is on. */
  legIndex: number
  slopeDeg: number
  /** Shift held: the presenter hurries ("time ×4"). */
  fast: boolean
  /** Shift held, but the walk is at normal speed because a hazard is near ("slowed near hazard"). */
  slowedNearHazard: boolean
  /** What stopped the last step. */
  blocked: MoveResult['blocked']
  paused: boolean
  cv: CvStats
  nav: NavState
  /** Minutes outside so far: the planned walk to the start point plus the time in the helmet (Shift counts ×4). */
  elapsedMin: number
}

/** Where the astronaut is on the route and what the guide says. */
export interface NavState {
  /** Id of the stop the active leg leads to. */
  toId: string
  /** Metres left on the active leg. */
  remainingM: number
  /** Metres off the planned line. */
  offRouteM: number
  /** Heading to follow, degrees clockwise from north; null before the first guide. */
  steerDeg: number | null
  /** The local planner found no way through its window. */
  blocked: boolean
  /** Nearest rock / steep ground / drop-off on the route line within 15 m. */
  hazardAheadM: number | null
  hazardAheadKind: Detection['kind'] | null
  /** Loose sand lies on the planned line a few metres ahead (and the astronaut is not on sand yet). */
  sandAhead: boolean
  /** A re-route is being computed. */
  replanning: boolean
  /** The last re-route: minutes added, and when (performance.now()). */
  rerouted: { deltaMin: number; at: number } | null
  /** A before/after is being recorded: something wide shut the planned line (re-routed or not). */
  detour: boolean
  /** The astronaut is at the last stop of the plan. */
  arrived: boolean
  /** Bearing of the active leg's stop from here, degrees clockwise from north. */
  stopBearingDeg: number
  /** Walking minutes back to the habitat from the nearest point of the planned leg; null when the plan has none. */
  walkBackMin: number | null
}

/** How the live computer vision is doing. */
export interface CvStats {
  /** Worker time of the last frame, ms. */
  ms: number
  /** Results per second. */
  hz: number
  /** Share of the left image's pixels with a depth, 0..1. */
  valid: number
  detections: number
  /** Of those: rocks taller than the step height, and small rocks (trip risks). */
  hazardRocks: number
  smallRocks: number
  frames: number
  error: string | null
}

/** A CV result with the pose it was taken from. */
export interface CvTick {
  result: CvResult
  /** Pose of the left camera for that frame. */
  pose: Pose
}

const HUD_EVERY_MS = 200
/** How often the route is checked against the hazard map for a global re-route, ms. */
const REPLAN_CHECK_MS = 1000
/**
 * Share of a 10 m planner cell on the route that must be rock / steep / drop before it is blocked: PLAN §5.8's
 * 30 %. It was 6 % for a while (a row of boulders covers under 10 % of a cell), but once the CV found most rocks,
 * every cell with a few scattered stones was blocked and the route changed again and again. Scattered rocks are
 * the local guide's job (it steers round them); a row of boulders is caught by the detour rule below.
 */
const REPLAN_COVERAGE = 0.3
/** At least this long between two re-routes, ms: a route that keeps changing cannot be followed. */
const REPLAN_MIN_INTERVAL_MS = 30000
/** The leg counts as walked when its end is this close, metres. */
const ARRIVE_M = 6
/** Half-side of the fused height window sent with each CV frame, metres (drop-offs matter close by). */
const DROP_WINDOW_M = 16
/**
 * When the guide has to leave the planned line by more than this for DETOUR_TICKS CV frames in a row, the line is
 * shut by something wide (a boulder field, not one rock), and the planner is asked for a new route.
 */
const DETOUR_M = 4
const DETOUR_TICKS = 4
/** A rock / steep / drop cell on the planned line counts for the detour rule this long after it was last seen, ms. */
const HARD_AHEAD_MEMORY_MS = 4000
/** "Loose sand ahead" looks this far along the planned line, metres. */
const SAND_AHEAD_M = 6
/**
 * Rocks this close to the point where the line was shut are named as its cause in the before/after view, metres.
 * The demo boulder field's half-width (rocks.ts DEMO_HALF_WIDTH_M): the rocks of the field, not the scattered ones beyond.
 */
const DETOUR_CAUSE_M = DEMO_HALF_WIDTH_M
/** Shift hurries only while nothing hard lies on the planned line this close ahead, metres. */
const HURRY_CLEAR_M = 20
/** The walked detour is recorded as a point every this many metres, at most DETOUR_TRAIL_MAX points (about 1 km). */
const DETOUR_TRAIL_STEP_M = 2
const DETOUR_TRAIL_MAX = 500

/** Longest walk straight back to the habitat on the legs from `from` on, minutes; null when no leg has the numbers. */
function walkBackMax(plan: RoutePlan, from: number): number | null {
  let max: number | null = null
  for (const leg of plan.legs.slice(Math.max(0, from))) {
    for (const v of leg.walkHomeMin) if (Number.isFinite(v) && (max === null || v > max)) max = v
  }
  return max
}
/** Time between CV frames, ms (PLAN §4: about every 150 ms, at least 4 Hz). */
export const CV_EVERY_MS = 150

export class HelmetSession {
  readonly entry: HelmetEntry
  /** The plan being walked: the entry's, or the latest re-route. */
  plan: RoutePlan
  /** True once the planner has re-routed. */
  replanned = false
  /** Session origin: local ENU (0, 0). Fixed for the whole session, also across jumps. */
  readonly origin: LatLon
  readonly pose: Pose
  readonly world: World
  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  readonly controls: Controls
  readonly rig: CvRig
  readonly cv: CvClient
  readonly cvStats: CvStats = { ms: 0, hz: 0, valid: 0, detections: 0, hazardRocks: 0, smallRocks: 0, frames: 0, error: null }
  /** The latest CV result (for the CV view). */
  lastCv: CvTick | null = null
  /** Top-down map of what the camera has seen. */
  readonly hazards = new HazardMap()
  /** The active leg as a 1 m track in local ENU. */
  track: RouteTrack
  /** The local planner's latest guide round the hazards (null before the first one). */
  guide: LocalPlan | null = null
  private localPlanner = new LocalPlanner()
  /** Keeps the shown guide steady: the planned line while it is clear, one kept detour round hazards (nav/guide.ts). */
  private keeper = new GuideKeeper()
  /** Rocks the CV found, remembered across frames, for the outlines in the view. */
  readonly rocks = new RockTracks()
  private overlay: SceneOverlay
  private decider: ReplanDecider
  private replanner: ReplanClient
  private replanAt = 0
  private rerouted: NavState['rerouted'] = null
  /** Re-routes so far (for the log and for testing). */
  rerouteCount = 0
  /** Time outside for the whole trip as planned, and what the re-routes of this walk added to it. */
  private tripMin: number
  /** What `tripMin` counts: the whole trip, or (stand-in demo route of #helmet) the rest of it from the start point. */
  private tripFrom: HelmetDetour['tripFrom'] = 'habitat'
  /** The first re-route that changed the line, kept for the before/after view in Mission control. */
  private detour: HelmetDetour | null = null
  /**
   * What happens after that re-route, until the stop it led to: the way the astronaut really walked (the guide and
   * any later re-routes take them round the whole field, the first new line only round what was seen by then), and
   * every boulder of the field the cameras found on the way.
   */
  private detourFollow: { stopId: string; causeAt: { x: number; y: number }; trail: LatLon[]; rocks: Map<number, number>; done: boolean } | null = null
  private arrived = false
  private detourTicks = 0
  private hardAheadAt = -Infinity
  private sandAhead = false
  private elapsedS = 0
  private onPlan: (plan: RoutePlan) => void
  legIndex: number
  paused = false
  /** Extra metres above the eye, for looking at the world from above while debugging (dev only). */
  lift = 0
  private ground: Ground
  private ro: ResizeObserver
  private onState: (s: HudState) => void
  private last = performance.now()
  private frames = 0
  private fpsFrom = this.last
  private fps = 0
  private hudAt = 0
  private move: MoveResult = { moved: 0, blocked: null, slopeDeg: 0, speed: 0 }
  private fast = false
  /** Shift is held (whether or not the walk is hurrying right now). */
  private hurryHeld = false
  private cvAt = 0
  /** CV pixels come back without stalling the frame (CvRig.captureAsync); false after it failed once. */
  private asyncCapture = true
  private disposed = false
  private cvPoses = new Map<number, Pose>()
  private cvCount = 0
  private cvHzFrom = this.last
  private cvListeners = new Set<(t: CvTick) => void>()

  constructor(host: HTMLElement, entry: HelmetEntry, data: SessionData, onState: (s: HudState) => void, onPlan: (plan: RoutePlan) => void = () => {}, standIn = false) {
    this.entry = entry
    this.plan = entry.plan
    this.tripMin = entry.plan.totalMinutes
    this.onPlan = onPlan
    this.origin = entry.startAt
    this.legIndex = entry.legIndex
    this.onState = onState

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.setSize(host.clientWidth, host.clientHeight)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    host.appendChild(renderer.domElement)
    this.renderer = renderer
    this.camera = new THREE.PerspectiveCamera(70, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 6000)

    this.world = new World({ index: data.index, coarse: makeCoarseGrid(data.terrain), origin: this.origin, renderer, legs: data.routes.legs, planLegs: standIn ? undefined : entry.plan.legs })
    const heights = this.world.heights
    const rocks = this.world.rocks.field
    this.ground = {
      heightAt: (x, y) => heights.heightAt(x, y),
      slopeAt: (x, y) => heights.slopeAt(x, y),
      rocksNear: (x, y, r) => rocks.rocksNear(x, y, r),
    }

    // face along the route from the start point
    this.pose = { x: 0, y: 0, z: EYE_M, headingDeg: headingAlong(entry.plan.legs[entry.legIndex].path, entry.startAt), pitchDeg: -5 }
    this.controls = new Controls(renderer.domElement, this.pose)

    this.track = buildTrack(entry.plan.legs[entry.legIndex].path, this.origin)
    // the walk from the habitat to the start point already took time (a real plan's legs carry real minutes)
    if (!standIn) {
      const before = entry.plan.legs.slice(0, entry.legIndex).reduce((m, l) => m + l.minutes, 0)
      const fix = locate(this.track, 0, 0)
      const stopsBefore = entry.legIndex * MOBILITY[entry.plan.mobility].stopMinutes
      this.elapsedS = 60 * (before + stopsBefore + entry.plan.legs[entry.legIndex].minutes * (this.track.lengthM > 0 ? fix.s / this.track.lengthM : 0))
    }
    this.overlay = new SceneOverlay(host)
    this.decider = new ReplanDecider(data.terrain, this.origin, { coverage: REPLAN_COVERAGE, minIntervalMs: REPLAN_MIN_INTERVAL_MS })
    this.decider.setRoute(remainingPath(this.plan, this.legIndex, entry.startAt))
    this.replanner = new ReplanClient(JEZERO.terrain)
    // The stand-in plan of #helmet has made-up times (routes.json holds lines only): ask the planner for the real
    // plan from here, so a later "Route updated: +N min" compares like with like.
    if (standIn) {
      const before = this.plan
      const { stops, habitat } = remainingStops(before, this.legIndex)
      this.replanner
        .replan({ mobility: before.mobility, profile: before.profile, from: entry.startAt, stops, habitat, blocked: [], remainingMinutes: 0 })
        .then((res) => {
          if (this.plan !== before) return
          this.plan = res.plan
          this.tripMin = res.plan.totalMinutes // the stand-in's times are made up: compare with the real plan
          this.tripFrom = 'start' // which starts where the helmet stands, not at the habitat
          this.setLeg(0)
          this.guide = null
          this.decider.setRoute(remainingPath(res.plan, 0))
          this.onPlan(res.plan)
        })
        .catch((err) => console.warn('helmet: could not plan the demo route, keeping the stand-in:', err?.message ?? err))
    }

    this.rig = new CvRig(renderer)
    this.cv = new CvClient({ stereo: { maxDisp: CV_MAX_DISP } })
    this.cv.onResult((result) => this.onCvResult(result))
    this.cv.onError((msg, id) => {
      console.error('helmet CV:', msg)
      this.cvStats.error = msg
      if (id !== null) this.cvPoses.delete(id)
    })

    this.ro = new ResizeObserver(() => {
      renderer.setSize(host.clientWidth, host.clientHeight)
      this.overlay.resize(host.clientWidth, host.clientHeight)
      this.camera.aspect = host.clientWidth / Math.max(1, host.clientHeight)
      this.camera.updateProjectionMatrix()
    })
    this.ro.observe(host)
    renderer.setAnimationLoop((now) => this.frame(now))
  }

  /** Put the astronaut at a point of the route, facing along it. The look-up/down angle stays. */
  jumpTo(t: JumpTarget): void {
    const p = toLocal(t.at, this.origin)
    this.pose.x = p.x
    this.pose.y = p.y
    this.pose.headingDeg = t.headingDeg
    this.setLeg(t.legIndex)
    this.decider.setRoute(remainingPath(this.plan, this.legIndex, t.at))
    this.guide = null
    this.rocks.clear()
    this.hudAt = 0
  }

  /** Local ENU of a geographic point in this session. */
  local(p: LatLon): { x: number; y: number } {
    return toLocal(p, this.origin)
  }

  /** Called with every CV result, on the main thread. Returns an unsubscribe function. */
  onCv(cb: (t: CvTick) => void): () => void {
    this.cvListeners.add(cb)
    return () => this.cvListeners.delete(cb)
  }

  private onCvResult(result: CvResult): void {
    const pose = this.cvPoses.get(result.id)
    this.cvPoses.delete(result.id)
    if (!pose) return
    let valid = 0
    const d = result.disparity
    for (let k = 0; k < d.length; k++) if (d[k] === d[k]) valid++
    const st = this.cvStats
    st.ms = result.ms
    st.valid = valid / d.length
    st.detections = result.detections.length
    st.smallRocks = result.detections.filter((d) => d.kind === 'rock' && d.level === 'small').length
    st.hazardRocks = result.detections.filter((d) => d.kind === 'rock' && d.level !== 'small').length
    st.frames++
    st.error = null
    this.cvCount++
    this.lastCv = { result, pose }
    this.hazards.fuse(result)
    this.rocks.update(result.detections, performance.now(), pose)
    this.navigate()
    this.followDetour()
    for (const cb of this.cvListeners) cb(this.lastCv)
  }

  /** One captured stereo pair → the CV worker, with the CV's own ground heights around where it was taken. */
  private sendCv(frame: CvFrame, at: { x: number; y: number }): void {
    if (this.disposed) return
    // the CV's own fused ground heights around the astronaut, for drop-offs (never the world's heights)
    frame.heights = this.hazards.grid.heightWindow(at.x, at.y, DROP_WINDOW_M)
    this.cvPoses.set(frame.id, frame.pose)
    if (!this.cv.send(frame)) this.cvPoses.delete(frame.id)
  }

  private setLeg(k: number): void {
    this.legIndex = Math.min(k, this.plan.legs.length - 1)
    this.track = buildTrack(this.plan.legs[this.legIndex].path, this.origin)
    this.arrived = false
    this.keeper.reset()
  }

  /** After every CV frame: the guide round the hazards, leg changes, and the global re-route check. */
  private navigate(): void {
    const { pose } = this
    const now = performance.now()
    const fresh = this.localPlanner.plan(this.hazards.grid, this.track, pose.x, pose.y, this.guide?.fix.s)
    const guide = this.keeper.update(fresh, this.hazards.grid, this.track, pose.x, pose.y)
    this.guide = guide

    // next leg when this one is walked
    if (remainingM(this.track, guide.fix.s) < ARRIVE_M && guide.fix.distM < 2 * ARRIVE_M) {
      if (this.legIndex < this.plan.legs.length - 1) {
        this.setLeg(this.legIndex + 1)
        this.guide = null
        return
      }
      this.arrived = true
    }

    // how far the guide strays from the planned line, and where
    let detour = 0
    let detourAt: { x: number; y: number } | null = null
    for (let k = 0; k < guide.path.length; k += 3) {
      const f = locate(this.track, guide.path[k].x, guide.path[k].y, guide.fix.s)
      if (f.distM > detour && f.s > guide.fix.s) {
        detour = f.distM
        detourAt = { x: f.x, y: f.y }
      }
    }
    // Only rock, steep ground and drop-offs shut a route. Sand makes the guide prefer firm ground, which can also
    // take it off the line, so the detour counts only while a hard hazard was seen on the line itself.
    if (guide.hazardAheadM !== null) this.hardAheadAt = now
    const hardAhead = now - this.hardAheadAt < HARD_AHEAD_MEMORY_MS
    this.detourTicks = !guide.blocked && hardAhead && detour > DETOUR_M && guide.fix.distM < DETOUR_M ? this.detourTicks + 1 : 0
    // loose sand on the planned line a few steps ahead
    const ahead = pointAhead(this.track, guide.fix.s, SAND_AHEAD_M)
    this.sandAhead = this.hazards.grid.classAt(ahead.x, ahead.y) === HAZARD.sand && this.hazards.grid.classAt(pose.x, pose.y) !== HAZARD.sand
    const shut = guide.blocked || this.detourTicks >= DETOUR_TICKS
    const shutAt = guide.blocked ? guide.blockedAt : detourAt
    // Something wide shuts the line: the before/after starts here, whether or not the planner re-routes globally.
    // The guide often gets round the boulder field on its own; without this the judge saw no before/after then.
    if (!this.detour && shut && shutAt) this.startDetour(this.plan, this.legIndex, toLatLon(pose.x, pose.y, this.origin), shutAt)

    if (now - this.replanAt < REPLAN_CHECK_MS || this.replanner.busy) return
    this.replanAt = now
    const at = toLatLon(pose.x, pose.y, this.origin)
    const decision = this.decider.check({
      grid: this.hazards.grid,
      at,
      localBlocked: shut,
      localBlockedAt: shut && shutAt ? toLatLon(shutAt.x, shutAt.y, this.origin) : null,
      nowMs: now,
    })
    if (!decision.replan) return
    const before = this.plan
    const legIndex = this.legIndex
    const { stops, habitat } = remainingStops(before, legIndex)
    const oldPath = remainingPath(before, legIndex, at)
    const causeAt = shut && shutAt ? shutAt : { x: pose.x, y: pose.y }
    this.replanner
      .replan({
        mobility: before.mobility,
        profile: before.profile,
        from: at,
        stops,
        habitat,
        blocked: this.decider.blockedCells(),
        remainingMinutes: remainingMinutes(before, this.legIndex, this.track.lengthM > 0 ? guide.fix.s / this.track.lengthM : 0),
      })
      .then((res) => {
        if (this.plan !== before) return // jumped or re-routed meanwhile
        const newPath = remainingPath(res.plan, 0)
        this.decider.setRoute(newPath)
        // a blocked cell beside the route can give the same line back: nothing to announce then
        const same = newPath.length === oldPath.length && newPath.every((p, k) => Math.abs(p.lat - oldPath[k].lat) < 1e-7 && Math.abs(p.lon - oldPath[k].lon) < 1e-7)
        this.plan = res.plan
        this.replanned = true
        this.rerouteCount++
        this.setLeg(0)
        this.guide = null
        this.detourTicks = 0
        if (!same) {
          this.rerouted = { deltaMin: res.deltaMinutes, at: performance.now() }
          if (!this.detour) this.startDetour(before, legIndex, at, causeAt)
        }
        this.onPlan(res.plan)
      })
      .catch((err) => console.warn('helmet: re-route failed, keeping the current plan:', err?.message ?? err))
  }

  /**
   * The onboard vision saw a dust storm (src/vision): drop the stops still ahead and plan the way back to the
   * habitat from here, with the hazards found so far still blocked. Resolves once the new plan is in place.
   */
  async returnToHabitat(): Promise<void> {
    while (this.replanner.busy) await new Promise((r) => setTimeout(r, 200))
    const before = this.plan
    const { habitat } = remainingStops(before, this.legIndex)
    const at = toLatLon(this.pose.x, this.pose.y, this.origin)
    const fix = this.guide?.fix ?? locate(this.track, this.pose.x, this.pose.y)
    const res = await this.replanner.replan({
      mobility: before.mobility,
      profile: before.profile,
      from: at,
      stops: [],
      habitat,
      blocked: this.decider.blockedCells(),
      remainingMinutes: remainingMinutes(before, this.legIndex, this.track.lengthM > 0 ? fix.s / this.track.lengthM : 0),
    })
    this.plan = res.plan
    this.replanned = true
    this.decider.setRoute(remainingPath(res.plan, 0))
    this.setLeg(0)
    this.guide = null
    this.detourTicks = 0
    this.hudAt = 0
    this.onPlan(res.plan)
  }

  /**
   * The detour as it stands now: the trip time with every re-route of this walk, the boulders found so far, and
   * the after-line = the way walked from the first re-route, then the current plan on to the stop.
   */
  private detourNow(d: HelmetDetour): HelmetDetour {
    const out: HelmetDetour = { ...d, tripFrom: this.tripFrom }
    const f = this.detourFollow
    if (f && f.rocks.size > 0) {
      out.rocks = Math.max(d.rocks, f.rocks.size)
      out.tallestM = Math.max(d.tallestM ?? 0, ...f.rocks.values())
    }
    if (f && f.trail.length > 1) {
      const leg = this.plan.legs[this.legIndex]
      const rest = !f.done && leg?.toId === f.stopId ? remainingPath({ ...this.plan, legs: [leg] }, 0, toLatLon(this.pose.x, this.pose.y, this.origin)) : []
      out.afterPath = [...f.trail, ...rest]
    }
    // What it cost: the extra metres walked round the field (both lines end at the same stop) at the planner's walking
    // speed on the level. Not the planner's re-route figure: that also re-plans the rest of the trip and once came out
    // shorter ("round the boulders: −1 min"), which says nothing about the boulders.
    const perMin = (MOBILITY[this.plan.mobility].flatSpeedKmh * 1000) / 60
    // Both lines measured as the map draws them (displayLine: straight runs): the planned line follows the planner's
    // 10 m cells in a staircase that the walker cuts, so its raw length hid the detour (extra came out about 0 m).
    const extraM = Math.max(0, this.lengthM(displayLine(out.afterPath)) - this.lengthM(displayLine(out.beforePath)))
    const delta = extraM / perMin
    out.extraM = extraM
    out.deltaMin = delta
    out.tripMin = { before: this.tripMin, after: this.tripMin + delta }
    out.walkBackMaxMin = { before: d.walkBackMaxMin.before, after: walkBackMax(this.plan, this.legIndex) }
    return out
  }

  /** Length of a lat/lon line, metres (local frame). */
  private lengthM(path: readonly LatLon[]): number {
    let m = 0
    for (let i = 1; i < path.length; i++) {
      const a = toLocal(path[i - 1], this.origin)
      const b = toLocal(path[i], this.origin)
      m += Math.hypot(b.x - a.x, b.y - a.y)
    }
    return m
  }

  /** After every CV frame while a detour is being walked: collect the field's boulders (the trail: followTrail). */
  private followDetour(): void {
    const f = this.detourFollow
    if (!f || f.done) return
    // the trail ends at the stop the detour led to (the next leg starts there), or after a long way
    if (this.plan.legs[this.legIndex]?.toId !== f.stopId || this.arrived || f.trail.length >= DETOUR_TRAIL_MAX) {
      f.done = true
      return
    }
    for (const t of this.rocks.tracks) {
      if (t.level !== 'hazard' || Math.hypot(t.x - f.causeAt.x, t.y - f.causeAt.y) > DETOUR_CAUSE_M) continue
      f.rocks.set(t.id, Math.max(f.rocks.get(t.id) ?? 0, t.heightM))
    }
  }

  /**
   * After every step while a detour is being walked: a trail point every DETOUR_TRAIL_STEP_M. Per step, not per CV
   * frame: with few CV frames (Shift, a slow GPU) the points were metres apart and the trail cut the corners of the
   * way round, so the detour came out shorter than it was.
   */
  private followTrail(): void {
    const f = this.detourFollow
    if (!f || f.done || this.plan.legs[this.legIndex]?.toId !== f.stopId || f.trail.length >= DETOUR_TRAIL_MAX) return
    const last = toLocal(f.trail[f.trail.length - 1], this.origin)
    if (Math.hypot(this.pose.x - last.x, this.pose.y - last.y) >= DETOUR_TRAIL_STEP_M) f.trail.push(toLatLon(this.pose.x, this.pose.y, this.origin))
  }

  /**
   * The before/after starts: the planned line from here to the stop, the rocks seen so far where it is shut, and from
   * now on the way actually walked (followDetour). Started by a global re-route or by the guide leaving the line for
   * something wide, whichever comes first.
   */
  private startDetour(before: RoutePlan, legIndex: number, at: LatLon, causeAt: { x: number; y: number }): void {
    const rocks = this.rocks.tracks.filter((t) => t.level === 'hazard' && Math.hypot(t.x - causeAt.x, t.y - causeAt.y) <= DETOUR_CAUSE_M)
    // the old line only up to the next stop: the rest of the trip is the same in both
    const beforePath = remainingPath({ ...before, legs: [before.legs[legIndex]] }, 0, at)
    this.detour = {
      at: toLatLon(causeAt.x, causeAt.y, this.origin),
      rocks: rocks.length,
      tallestM: rocks.length ? Math.max(...rocks.map((t) => t.heightM)) : null,
      beforePath,
      afterPath: beforePath,
      deltaMin: 0,
      extraM: 0,
      tripMin: { before: this.tripMin, after: this.tripMin },
      tripFrom: this.tripFrom,
      walkBackMaxMin: { before: walkBackMax(before, legIndex), after: walkBackMax(before, legIndex) },
    }
    this.detourFollow = { stopId: before.legs[legIndex].toId, causeAt, trail: [at], rocks: new Map(), done: false }
  }

  /** What goes back to Mission control: the seen ground as a picture, the hazards found, and the plan if it changed. */
  exit(): HelmetExit {
    const grid = this.hazards.grid
    const img = grid.toImage()
    let seen: HelmetExit['seen'] = null
    if (img.width && img.height) {
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0)
      seen = { bounds: toLatLonBounds(img, this.origin), png: c.toDataURL('image/png') }
    }
    return {
      seen,
      // sand is ground, not an obstacle: it is in the picture (yellow), not in the marker list
      hazards: grid
        .hazardsList()
        .filter((h) => h.kind !== 'sand')
        .map((h) => ({ at: toLatLon(h.x, h.y, this.origin), kind: h.kind, radiusM: h.radiusM })),
      plan: this.replanned ? this.plan : null,
      rerouteDeltaMin: this.replanned && this.rerouted ? this.rerouted.deltaMin : undefined,
      detour: this.detour ? this.detourNow(this.detour) : undefined,
    }
  }

  private navState(): NavState {
    const g = this.guide
    const fix = g?.fix ?? locate(this.track, this.pose.x, this.pose.y)
    return {
      toId: this.plan.legs[this.legIndex].toId,
      remainingM: remainingM(this.track, fix.s),
      offRouteM: fix.distM,
      steerDeg: g ? g.steerDeg : null,
      blocked: g?.blocked ?? false,
      hazardAheadM: g?.hazardAheadM ?? null,
      hazardAheadKind: g?.hazardAheadKind ?? null,
      sandAhead: this.sandAhead,
      replanning: this.replanner.busy,
      rerouted: this.rerouted,
      detour: this.detour !== null,
      arrived: this.arrived,
      stopBearingDeg: dirToHeading(this.track.x[this.track.n - 1] - this.pose.x, this.track.y[this.track.n - 1] - this.pose.y),
      walkBackMin: this.walkBackMin(fix.s),
    }
  }

  private walkBackMin(s: number): number | null {
    const home = this.plan.legs[this.legIndex].walkHomeMin
    if (!home.length || this.track.lengthM <= 0) return null
    const v = home[Math.min(home.length - 1, Math.round((s / this.track.lengthM) * (home.length - 1)))]
    return Number.isFinite(v) ? v : null
  }

  dispose(): void {
    this.disposed = true // a readback still on its way finds nothing to send to
    this.renderer.setAnimationLoop(null)
    this.replanner.dispose()
    this.overlay.dispose()
    this.cv.terminate()
    this.rig.dispose()
    this.cvListeners.clear()
    this.ro.disconnect()
    this.controls.dispose()
    this.world.dispose()
    this.renderer.dispose()
    // dispose() frees three's resources but keeps the WebGL context; browsers keep only ~16 of them, so
    // every trip into the helmet left one behind until old ones got dropped (and repainted) mid-session.
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  /**
   * The body walked into a rock: the astronaut now knows it is there, seen or not, so it goes on the hazard map
   * like a CV rock and the guide plans round it. Without this, a rock the cameras missed (about one in five per
   * frame) left the guide pointing straight into it and the walker stuck there (review H-P0-1). Touch is the only
   * way the world's truth reaches the map, and only where the body actually is.
   */
  private feelRock(r: RockLike): void {
    const rad = r.d / 2 + GRID_CELL_M / 2
    const x0 = Math.floor((r.x - rad) / GRID_CELL_M) * GRID_CELL_M
    const y0 = Math.ceil((r.y + rad) / GRID_CELL_M) * GRID_CELL_M
    const cols = Math.ceil((r.x + rad - x0) / GRID_CELL_M)
    const rows = Math.ceil((y0 - (r.y - rad)) / GRID_CELL_M)
    const cls = new Uint8Array(cols * rows)
    const conf = new Float32Array(cols * rows)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cx = x0 + (col + 0.5) * GRID_CELL_M
        const cy = y0 - (row + 0.5) * GRID_CELL_M
        if (Math.hypot(cx - r.x, cy - r.y) > rad) continue // left as "not observed"
        cls[row * cols + col] = HAZARD.rock
        conf[row * cols + col] = 0.95
      }
    }
    this.hazards.grid.update({ x0, y0, cols, rows, cls, conf }, this.cvCount)
  }

  private frame(now: number): void {
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000))
    this.last = now
    const { pose, world } = this

    const ready = world.readyAround(pose.x, pose.y)
    const inp = this.controls.input()
    // Shift hurries on open ground only. Near a hazard (the guide is off the line, or something hard lies on it
    // within HURRY_CLEAR_M) the walk drops to normal speed: at ×4 the cameras saw the boulders a frame every few
    // metres, too late to steer round, and the guide swung from side to side (review H-P0-1).
    this.hurryHeld = inp.fast && !this.paused
    const nearHazard = this.keeper.mode !== 'route' || (this.guide?.hazardAheadM ?? Infinity) <= HURRY_CLEAR_M
    this.fast = this.hurryHeld && !nearHazard
    // no walking before the ground under the feet exists, or the player would start inside it
    const still = this.paused || !ready
    const res = stepPlayer(pose, still ? { fwd: 0, side: 0, fast: false } : { ...inp, fast: this.fast }, still ? 0 : dt, this.ground)
    if (!still) this.elapsedS += dt * (this.fast ? FAST_FACTOR : 1)
    if (res.moved > 0 || res.blocked || (!inp.fwd && !inp.side)) this.move = res
    else this.move = { ...res, blocked: this.move.blocked }
    if (res.hit) this.feelRock(res.hit)
    if (res.moved > 0) this.followTrail()
    pose.z += this.lift
    world.update(pose)

    const eye = localToThree(pose)
    const d = localToThree(headingToDir(pose.headingDeg, pose.pitchDeg))
    this.camera.position.set(eye.x, eye.y, eye.z)
    this.camera.lookAt(eye.x + d.x, eye.y + d.y, eye.z + d.z)
    this.renderer.render(world.scene, this.camera)
    this.overlay.draw({
      camera: this.camera,
      pose,
      rocks: this.rocks.tracks,
      grid: this.hazards.grid,
      gridVersion: this.hazards.version,
      path: this.guide?.path ?? [],
      guide: this.guide?.blocked ? 'blocked' : this.keeper.mode === 'detour' ? 'detour' : 'route',
      heightAt: this.ground.heightAt,
      now: performance.now(),
    })

    // CV tick: both eyes → pixels → worker. One frame in flight; a busy worker or a readback still on its way
    // means this tick is skipped.
    if (ready && !this.paused && now - this.cvAt >= CV_EVERY_MS && !this.cv.busy && !this.rig.capturing) {
      this.cvAt = now
      const at = { x: pose.x, y: pose.y } // where the eyes were rendered: the frame arrives a few ms later
      if (this.asyncCapture) {
        this.rig
          .captureAsync(world.scene, pose)
          ?.then((frame) => this.sendCv(frame, at))
          .catch((err) => {
            // e.g. no fence support: go back to the synchronous readback for the rest of the session
            if (this.disposed) return
            console.warn('helmet: async CV capture failed, using the synchronous one:', err?.message ?? err)
            this.asyncCapture = false
          })
      } else this.sendCv(this.rig.capture(world.scene, pose), at)
    }
    if (now - this.cvHzFrom > 2000) {
      this.cvStats.hz = (this.cvCount * 1000) / (now - this.cvHzFrom)
      this.cvCount = 0
      this.cvHzFrom = now
    }

    this.frames++
    if (now - this.fpsFrom > 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsFrom))
      this.frames = 0
      this.fpsFrom = now
    }
    if (now - this.hudAt >= HUD_EVERY_MS) {
      this.hudAt = now
      this.onState({
        fps: this.fps,
        loading: !ready,
        coarse: world.coarseAt(pose.x, pose.y),
        pose: { ...pose },
        legIndex: this.legIndex,
        slopeDeg: res.slopeDeg,
        fast: this.fast,
        slowedNearHazard: this.hurryHeld && !this.fast,
        blocked: inp.fwd || inp.side ? this.move.blocked : null,
        paused: this.paused,
        cv: { ...this.cvStats },
        nav: this.navState(),
        elapsedMin: this.elapsedS / 60,
      })
    }
  }
}
