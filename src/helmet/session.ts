// One helmet session: the renderer, the world, the player and the frame loop. No React in here: HelmetView
// creates a session when its data has loaded, draws the HUD from the state the session reports, and disposes it.
import * as THREE from 'three'
import { JEZERO } from '../data/jezero.ts'
import { MOBILITY } from '../lib/mobility.ts'
import type { LatLon, RoutePlan, Terrain } from '../types.ts'
import { HAZARD, type CvResult, type Detection, type HelmetEntry, type HelmetExit, type Pose } from './contracts.ts'
import { CvClient } from './cv/client.ts'
import { HazardMap } from './mapping/fuse.ts'
import { buildTrack, locate, pointAhead, remainingM, type RouteTrack } from './nav/follow.ts'
import { LocalPlanner, type LocalPlan } from './nav/localPlanner.ts'
import { remainingMinutes, remainingPath, remainingStops, ReplanClient, ReplanDecider } from './nav/replan.ts'
import { dirToHeading, headingToDir, localToThree, toLatLon, toLocal } from './frames.ts'
import { GuideLine, HUD_LAYER } from './hud/GuideLine.ts'
import { toLatLonBounds } from './mapping/hazardGrid.ts'
import { Controls } from './sim/controls.ts'
import { CvRig } from './sim/cvRig.ts'
import type { JumpTarget } from './sim/jump.ts'
import { EYE_M, FAST_FACTOR, stepPlayer, type Ground, type MoveResult } from './sim/player.ts'
import { makeCoarseGrid } from './world/heightField.ts'
import { headingAlong } from './world/path.ts'
import type { RoutesFile } from './world/routes.ts'
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
 * Share of a 10 m planner cell on the route that must be rock / steep / drop before it is blocked. PLAN §5.8 says
 * 30 %, but a row of boulders across the path covers well under 10 % of a planner cell, so 30 % never fires on
 * the very thing a re-route is for. 6 % is about 6 m² of obstacle in a cell (deviation, logged in STATUS.md).
 */
const REPLAN_COVERAGE = 0.06
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
  readonly cvStats: CvStats = { ms: 0, hz: 0, valid: 0, detections: 0, frames: 0, error: null }
  /** The latest CV result (for the CV view). */
  lastCv: CvTick | null = null
  /** Top-down map of what the camera has seen. */
  readonly hazards = new HazardMap()
  /** The active leg as a 1 m track in local ENU. */
  track: RouteTrack
  /** The local planner's latest guide round the hazards (null before the first one). */
  guide: LocalPlan | null = null
  private localPlanner = new LocalPlanner()
  private guideLine: GuideLine
  private decider: ReplanDecider
  private replanner: ReplanClient
  private replanAt = 0
  private rerouted: NavState['rerouted'] = null
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
  private cvAt = 0
  private cvPoses = new Map<number, Pose>()
  private cvCount = 0
  private cvHzFrom = this.last
  private cvListeners = new Set<(t: CvTick) => void>()

  constructor(host: HTMLElement, entry: HelmetEntry, data: SessionData, onState: (s: HudState) => void, onPlan: (plan: RoutePlan) => void = () => {}, standIn = false) {
    this.entry = entry
    this.plan = entry.plan
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
    this.camera.layers.enable(HUD_LAYER)

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
    this.guideLine = new GuideLine(this.world.scene)
    this.decider = new ReplanDecider(data.terrain, this.origin, { coverage: REPLAN_COVERAGE })
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
          this.setLeg(0)
          this.guide = null
          this.decider.setRoute(remainingPath(res.plan, 0))
          this.onPlan(res.plan)
        })
        .catch((err) => console.warn('helmet: could not plan the demo route, keeping the stand-in:', err?.message ?? err))
    }

    this.rig = new CvRig(renderer)
    this.cv = new CvClient()
    this.cv.onResult((result) => this.onCvResult(result))
    this.cv.onError((msg, id) => {
      console.error('helmet CV:', msg)
      this.cvStats.error = msg
      if (id !== null) this.cvPoses.delete(id)
    })

    this.ro = new ResizeObserver(() => {
      renderer.setSize(host.clientWidth, host.clientHeight)
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
    this.guideLine.set([], this.ground.heightAt, false)
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
    st.frames++
    st.error = null
    this.cvCount++
    this.lastCv = { result, pose }
    this.hazards.fuse(result)
    this.navigate()
    for (const cb of this.cvListeners) cb(this.lastCv)
  }

  private setLeg(k: number): void {
    this.legIndex = Math.min(k, this.plan.legs.length - 1)
    this.track = buildTrack(this.plan.legs[this.legIndex].path, this.origin)
    this.arrived = false
  }

  /** After every CV frame: the guide round the hazards, leg changes, and the global re-route check. */
  private navigate(): void {
    const { pose } = this
    const now = performance.now()
    const guide = this.localPlanner.plan(this.hazards.grid, this.track, pose.x, pose.y, this.guide?.fix.s)
    this.guide = guide
    this.guideLine.set(guide.path, this.ground.heightAt, guide.blocked)

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
    const { stops, habitat } = remainingStops(before, this.legIndex)
    const oldPath = remainingPath(before, this.legIndex, at)
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
        this.setLeg(0)
        this.guide = null
        this.detourTicks = 0
        if (!same) this.rerouted = { deltaMin: res.deltaMinutes, at: performance.now() }
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
    this.renderer.setAnimationLoop(null)
    this.replanner.dispose()
    this.guideLine.dispose()
    this.cv.terminate()
    this.rig.dispose()
    this.cvListeners.clear()
    this.ro.disconnect()
    this.controls.dispose()
    this.world.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private frame(now: number): void {
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000))
    this.last = now
    const { pose, world } = this

    const ready = world.readyAround(pose.x, pose.y)
    const inp = this.controls.input()
    this.fast = inp.fast && !this.paused
    // no walking before the ground under the feet exists, or the player would start inside it
    const still = this.paused || !ready
    const res = stepPlayer(pose, still ? { fwd: 0, side: 0, fast: false } : inp, still ? 0 : dt, this.ground)
    if (!still) this.elapsedS += dt * (this.fast ? FAST_FACTOR : 1)
    if (res.moved > 0 || res.blocked || (!inp.fwd && !inp.side)) this.move = res
    else this.move = { ...res, blocked: this.move.blocked }
    pose.z += this.lift
    world.update(pose)

    const eye = localToThree(pose)
    const d = localToThree(headingToDir(pose.headingDeg, pose.pitchDeg))
    this.camera.position.set(eye.x, eye.y, eye.z)
    this.camera.lookAt(eye.x + d.x, eye.y + d.y, eye.z + d.z)
    this.renderer.render(world.scene, this.camera)

    // CV tick: both eyes → pixels → worker. One frame in flight; a busy worker means this tick is skipped.
    if (ready && !this.paused && now - this.cvAt >= CV_EVERY_MS && !this.cv.busy) {
      this.cvAt = now
      const frame = this.rig.capture(world.scene, pose)
      // the CV's own fused ground heights around the astronaut, for drop-offs (never the world's heights)
      frame.heights = this.hazards.grid.heightWindow(pose.x, pose.y, DROP_WINDOW_M)
      this.cvPoses.set(frame.id, frame.pose)
      if (!this.cv.send(frame)) this.cvPoses.delete(frame.id)
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
        blocked: inp.fwd || inp.side ? this.move.blocked : null,
        paused: this.paused,
        cv: { ...this.cvStats },
        nav: this.navState(),
        elapsedMin: this.elapsedS / 60,
      })
    }
  }
}
