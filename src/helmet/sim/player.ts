// The astronaut's body: walking speed, what stops them (docs/helmet/PLAN.md §6.3). Pure: no three.js, no DOM.
//
// Assumptions (not measurements): eye height 1.65 m; 1.0 m/s on the level, slowed on slopes like the planner
// (slopeSpeedFactor); a suited astronaut steps over anything up to 0.40 m (the CV already calls 0.30 m a
// "rock": warn early, stop late) and cannot climb ground steeper than 25°.
import { slopeSpeedFactor } from '../../lib/mobility.ts'
import type { Pose } from '../contracts.ts'
import { headingToDir } from '../frames.ts'
import { BURY } from '../world/rocks.ts'

export const EYE_M = 1.65
/** Walking speed, m/s. Faster than a suited astronaut really walks (the planner assumes 0.7 m/s): a demo choice, so the walk does not drag. Suit time runs by the clock, not by distance. */
export const WALK_MPS = 4.0
/** Shift: the presenter hurries; the HUD shows "time ×4". */
export const FAST_FACTOR = 4
export const MAX_CLIMB_DEG = 25
/** Body radius for collisions, metres. */
export const BODY_R_M = 0.3
/**
 * Rocks standing less than this above the ground are stepped over, metres. The CV warns from 0.30 m (the safe
 * step); the body is only stopped from 0.40 m, so a low rock the camera missed costs a warning, not a dead stop.
 */
export const STEP_OVER_M = 0.4

export interface RockLike {
  x: number
  y: number
  d: number
  h: number
}

/** What the player needs to know about the world. */
export interface Ground {
  heightAt(x: number, y: number): number
  slopeAt(x: number, y: number): number
  rocksNear(x: number, y: number, r: number): RockLike[]
}

export interface MoveInput {
  /** +1 forward, −1 back. */
  fwd: number
  /** +1 right, −1 left. */
  side: number
  fast: boolean
}

export interface MoveResult {
  /** Metres moved this step. */
  moved: number
  /** What stopped (or deflected) the step. */
  blocked: 'rock' | 'slope' | null
  /** Ground slope under the feet after the step, degrees. */
  slopeDeg: number
  /** Speed used, m/s. */
  speed: number
}

/** Height of a rock above the ground (the rest is buried). */
export function rockStandsM(r: RockLike): number {
  return r.h * (1 - BURY)
}

function hitsRock(g: Ground, x: number, y: number, fromX: number, fromY: number): boolean {
  for (const r of g.rocksNear(x, y, BODY_R_M)) {
    if (rockStandsM(r) < STEP_OVER_M) continue
    const reach = (r.d / 2) * 0.85 + BODY_R_M
    const now = Math.hypot(r.x - x, r.y - y)
    // already overlapping (after a jump): let them walk out, never further in
    if (now < reach && now <= Math.hypot(r.x - fromX, r.y - fromY)) return true
  }
  return false
}

/** Moves `pose` (x, y, z) one time step. Heading and pitch are the controls' business. */
export function stepPlayer(pose: Pose, inp: MoveInput, dt: number, g: Ground): MoveResult {
  const slope0 = g.slopeAt(pose.x, pose.y)
  const speed = WALK_MPS * slopeSpeedFactor(Math.min(slope0, MAX_CLIMB_DEG)) * (inp.fast ? FAST_FACTOR : 1)
  let blocked: MoveResult['blocked'] = null
  let moved = 0
  const len = Math.hypot(inp.fwd, inp.side)
  if (len > 0 && dt > 0) {
    const f = headingToDir(pose.headingDeg)
    const r = headingToDir(pose.headingDeg + 90)
    const dx = ((f.x * inp.fwd + r.x * inp.side) / len) * speed * dt
    const dy = ((f.y * inp.fwd + r.y * inp.side) / len) * speed * dt
    const z0 = g.heightAt(pose.x, pose.y)
    // the full step, else slide along one axis
    for (const [sx, sy] of [
      [dx, dy],
      [dx, 0],
      [0, dy],
    ]) {
      if (!sx && !sy) continue
      const nx = pose.x + sx
      const ny = pose.y + sy
      if (hitsRock(g, nx, ny, pose.x, pose.y)) {
        blocked = 'rock'
        continue
      }
      if (g.slopeAt(nx, ny) > MAX_CLIMB_DEG && g.heightAt(nx, ny) > z0 + 1e-4) {
        blocked = blocked ?? 'slope'
        continue
      }
      pose.x = nx
      pose.y = ny
      moved = Math.hypot(sx, sy)
      break
    }
  }
  pose.z = g.heightAt(pose.x, pose.y) + EYE_M
  return { moved, blocked: moved > 0 && blocked === null ? null : blocked, slopeDeg: g.slopeAt(pose.x, pose.y), speed }
}
