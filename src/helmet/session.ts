// One helmet session: the renderer, the world, the player and the frame loop. No React in here: HelmetView
// creates a session when its data has loaded, draws the HUD from the state the session reports, and disposes it.
import * as THREE from 'three'
import type { LatLon, Terrain } from '../types.ts'
import type { CvResult, HelmetEntry, Pose } from './contracts.ts'
import { CvClient } from './cv/client.ts'
import { headingToDir, localToThree, toLocal } from './frames.ts'
import { Controls } from './sim/controls.ts'
import { CvRig } from './sim/cvRig.ts'
import type { JumpTarget } from './sim/jump.ts'
import { EYE_M, stepPlayer, type Ground, type MoveResult } from './sim/player.ts'
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
/** Time between CV frames, ms (PLAN §4: about every 150 ms, at least 4 Hz). */
export const CV_EVERY_MS = 150

export class HelmetSession {
  readonly entry: HelmetEntry
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

  constructor(host: HTMLElement, entry: HelmetEntry, data: SessionData, onState: (s: HudState) => void) {
    this.entry = entry
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

    this.world = new World({ index: data.index, coarse: makeCoarseGrid(data.terrain), origin: this.origin, renderer, legs: data.routes.legs })
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
    this.legIndex = t.legIndex
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
    for (const cb of this.cvListeners) cb(this.lastCv)
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null)
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
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const { pose, world } = this

    const ready = world.readyAround(pose.x, pose.y)
    const inp = this.controls.input()
    this.fast = inp.fast && !this.paused
    // no walking before the ground under the feet exists, or the player would start inside it
    const still = this.paused || !ready
    const res = stepPlayer(pose, still ? { fwd: 0, side: 0, fast: false } : inp, still ? 0 : dt, this.ground)
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
      })
    }
  }
}
