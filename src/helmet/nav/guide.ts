// Guide keeper: decides which line the helmet SHOWS, so the guide does not jump about.
//
// The local planner (localPlanner.ts) searches a fresh A* path on every CV tick. On open ground many paths
// cost almost the same, and every glance reveals new cells (unseen → safe, a sand patch, a far rock), so the
// winning path flips from tick to tick: the teal line and the steering arrow moved even when the astronaut
// only turned their head. This module adds memory and a sensible default:
//
// - ROUTE mode (the normal case): while no rock, steep ground or drop-off lies on or right beside the planned
//   line ahead, the guide IS the planned line, from the astronaut's place on it to the lookahead point. It
//   only changes as the astronaut walks. Sand does not take the guide off the line (the HUD warns about it).
// - DETOUR mode: a hard hazard is on the line. The planner's path round it is adopted once and then KEPT while
//   it stays free of hard hazards, the astronaut stays within KEEP_NEAR_M of it and it still reaches a few
//   metres ahead. Only then is a new path taken. Back to ROUTE once the line ahead has been clear for
//   CLEAR_TICKS ticks in a row, joining the line a few metres ahead rather than turning sharply.
//
// It never makes a path the planner did not find, and it never hides `blocked` (that still asks for a re-route).
import { HAZARD, type HazardClass } from '../contracts.ts'
import { GRID_CELL_M, dirToHeading } from '../frames.ts'
import type { LocalPlan } from './localPlanner.ts'
import { pointAt, type RouteTrack } from './follow.ts'

export interface GuideCells {
  classAtCell(col: number, row: number): HazardClass
}

export interface GuideOptions {
  /** Length of the guide ahead of the astronaut in ROUTE mode, metres (the planner's lookahead). */
  lookaheadM?: number
  /** Cells around a hard hazard that also count as shut (the planner's inflation). */
  inflateCells?: number
  /** A kept detour is dropped when the astronaut is farther than this from it, metres. */
  keepNearM?: number
  /** A kept detour is dropped when less than this of it is left ahead, metres. */
  keepAheadM?: number
  /** Ticks in a row the line ahead must be clear before the guide goes back to it. */
  clearTicks?: number
  /** Where the steering arrow points: this far along the shown guide, metres. */
  steerAheadM?: number
  /** CV ticks a fresh path that turns back (over 90°) is held off while the kept detour is clear ahead. */
  holdTicks?: number
  /** How much of the kept detour must be clear ahead for that, metres. */
  holdM?: number
}

export type GuideMode = 'route' | 'detour' | 'blocked'

type P = { x: number; y: number }

const isHard = (k: HazardClass) => k === HAZARD.rock || k === HAZARD.steep || k === HAZARD.drop

export class GuideKeeper {
  readonly lookaheadM: number
  readonly inflateCells: number
  readonly keepNearM: number
  readonly keepAheadM: number
  readonly clearTicks: number
  readonly steerAheadM: number

  /** Ticks a fresh path that turns back is held off while the kept detour is still clear ahead (about 1 s). */
  readonly holdTicks: number
  /** ... for at least this far, metres. */
  readonly holdM: number

  mode: GuideMode = 'route'
  /** The detour being kept, local ENU metres, from where it was adopted to its goal. */
  private kept: P[] | null = null
  private clearRun = 0
  private holdRun = 0

  constructor(o: GuideOptions = {}) {
    this.lookaheadM = o.lookaheadM ?? 30
    this.inflateCells = o.inflateCells ?? 1
    this.keepNearM = o.keepNearM ?? 2.5
    this.keepAheadM = o.keepAheadM ?? 6
    this.clearTicks = o.clearTicks ?? 4
    this.steerAheadM = o.steerAheadM ?? 3
    this.holdTicks = o.holdTicks ?? 6
    this.holdM = o.holdM ?? 4
  }

  /** Forget everything (new leg, new plan, jump). */
  reset(): void {
    this.mode = 'route'
    this.kept = null
    this.clearRun = 0
    this.holdRun = 0
  }

  /**
   * Takes the planner's fresh result for this tick and returns the plan to show and act on. Only `path`
   * and `steerDeg` can differ from `fresh`; the rest (fix, blocked, hazard ahead) is passed through.
   */
  update(fresh: LocalPlan, grid: GuideCells, track: RouteTrack, x: number, y: number): LocalPlan {
    if (fresh.blocked) {
      this.mode = 'blocked'
      this.kept = null
      this.clearRun = 0
      return fresh
    }
    const s0 = fresh.fix.s
    const goalS = Math.min(track.lengthM, s0 + this.lookaheadM)
    const lineClear = this.lineClear(grid, track, s0, goalS)
    this.clearRun = lineClear ? this.clearRun + 1 : 0

    // back on the line once it has stayed clear for a while (or it was never left)
    if (this.mode !== 'detour' || this.clearRun >= this.clearTicks) {
      if (lineClear) {
        const path = this.routePath(grid, track, x, y, fresh.fix.distM, s0, goalS)
        if (path) {
          this.mode = 'route'
          this.kept = null
          return { ...fresh, path, steerDeg: this.steer(path, x, y, fresh.steerDeg) }
        }
      }
    }

    // a hard hazard is on the line (or we are still passing one): keep the detour while it is good
    if (this.kept && this.keepable(this.kept, grid, x, y)) {
      this.holdRun = 0
      const path = this.trimmed(this.kept, x, y)
      this.mode = 'detour'
      return { ...fresh, path, steerDeg: this.steer(path, x, y, fresh.steerDeg) }
    }
    // The kept detour is shut somewhere ahead (a rock seen only now). The fresh path often goes round the other
    // end of the field: the arrow swung by up to 180° and back (review H-P0-1). While the kept path is still clear
    // for HOLD_M ahead, walk on along that clear part for a few ticks; as the astronaut gets nearer, the planner
    // usually finds the way round on the same side. If it still turns back after holdTicks, it is taken.
    if (this.kept && this.holdRun < this.holdTicks) {
      const clear = this.clearPart(this.kept, grid, x, y)
      if (clear && pathLength(clear) >= this.holdM) {
        const keepDeg = this.steer(clear, x, y, fresh.steerDeg)
        const turn = Math.abs(((fresh.steerDeg - keepDeg + 540) % 360) - 180)
        if (turn > 90) {
          this.holdRun++
          this.mode = 'detour'
          return { ...fresh, path: clear, steerDeg: keepDeg }
        }
      }
    }
    this.holdRun = 0
    this.kept = fresh.path.length > 1 ? fresh.path.map((p) => ({ x: p.x, y: p.y })) : null
    this.mode = 'detour'
    return fresh
  }

  /** The kept detour from the astronaut up to its first shut stretch, or null when the astronaut is off it. */
  private clearPart(path: P[], grid: GuideCells, x: number, y: number): P[] | null {
    if (distToPolyline(path, x, y) > this.keepNearM) return null
    const ahead = this.trimmed(path, x, y)
    const out: P[] = [ahead[0]]
    for (let i = 1; i < ahead.length; i++) {
      if (!this.segmentClear(grid, ahead[i - 1], ahead[i])) break
      out.push(ahead[i])
    }
    return out.length > 1 ? out : null
  }

  /** True when no hard hazard (grown by the margin) lies on the planned line between s0 and goalS. */
  private lineClear(grid: GuideCells, track: RouteTrack, s0: number, goalS: number): boolean {
    for (let s = s0; s <= goalS; s += GRID_CELL_M / 2) {
      const p = pointAt(track, s)
      if (this.shutAt(grid, p.x, p.y)) return false
    }
    return true
  }

  private shutAt(grid: GuideCells, x: number, y: number): boolean {
    const c = Math.floor(x / GRID_CELL_M)
    const r = Math.floor(-y / GRID_CELL_M)
    const m = this.inflateCells
    for (let dr = -m; dr <= m; dr++) for (let dc = -m; dc <= m; dc++) if (isHard(grid.classAtCell(c + dc, r + dr))) return true
    return false
  }

  /** True when the straight segment a → b crosses no shut cell. */
  private segmentClear(grid: GuideCells, a: P, b: P): boolean {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(len / (GRID_CELL_M / 2)))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      // the astronaut's own cell is never refused (they are standing there)
      if (k === 0) continue
      if (this.shutAt(grid, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false
    }
    return true
  }

  /**
   * The planned line from the astronaut to goalS, one point per metre. When the astronaut is off the line,
   * the guide joins it a few metres ahead (straight, if that stretch is clear), not at the nearest point.
   * Null when the join is not clear: the caller keeps the detour then.
   */
  private routePath(grid: GuideCells, track: RouteTrack, x: number, y: number, offM: number, s0: number, goalS: number): P[] | null {
    const joinS = offM < 1 ? s0 : Math.min(goalS, s0 + Math.max(3, offM * 1.5))
    const join = pointAt(track, joinS)
    if (offM >= 1 && !this.segmentClear(grid, { x, y }, join)) return null
    const path: P[] = [{ x, y }]
    for (let s = Math.ceil(joinS); s <= goalS; s += 1) {
      const p = pointAt(track, s)
      path.push({ x: p.x, y: p.y })
    }
    const end = pointAt(track, goalS)
    const last = path[path.length - 1]
    if (Math.hypot(end.x - last.x, end.y - last.y) > 0.05) path.push({ x: end.x, y: end.y })
    return path
  }

  /** A kept detour is good while nothing hard is on its remaining part, the astronaut is near it and it still leads on. */
  private keepable(path: P[], grid: GuideCells, x: number, y: number): boolean {
    const k = nearestIndex(path, x, y)
    const d = distToPolyline(path, x, y)
    if (d > this.keepNearM) return false
    if (remainingLength(path, k, x, y) < this.keepAheadM) return false
    for (let i = Math.max(1, k); i < path.length; i++) if (!this.segmentClear(grid, path[i - 1], path[i])) return false
    return true
  }

  /** The kept detour from the astronaut on: drop the points already passed, start at the astronaut. */
  private trimmed(path: P[], x: number, y: number): P[] {
    const k = nearestIndex(path, x, y)
    const out: P[] = [{ x, y }]
    // skip the nearest vertex when it is behind (closer to the previous one than the astronaut is)
    let start = k
    if (k + 1 < path.length) {
      const ax = path[k + 1].x - path[k].x
      const ay = path[k + 1].y - path[k].y
      if ((x - path[k].x) * ax + (y - path[k].y) * ay > 0) start = k + 1
    }
    for (let i = start; i < path.length; i++) {
      if (out.length === 1 && Math.hypot(path[i].x - x, path[i].y - y) < 0.05) continue // the astronaut is on it
      out.push(path[i])
    }
    return out
  }

  private steer(path: P[], x: number, y: number, fallback: number): number {
    let walked = 0
    for (let k = 1; k < path.length; k++) {
      walked += Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y)
      if (walked >= this.steerAheadM || k === path.length - 1) {
        const dx = path[k].x - x
        const dy = path[k].y - y
        return Math.hypot(dx, dy) > 0.25 ? dirToHeading(dx, dy) : fallback
      }
    }
    return fallback
  }
}

function nearestIndex(path: P[], x: number, y: number): number {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = (path[i].x - x) ** 2 + (path[i].y - y) ** 2
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

export function distToPolyline(path: P[], x: number, y: number): number {
  if (path.length === 1) return Math.hypot(path[0].x - x, path[0].y - y)
  let best = Infinity
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const L = vx * vx + vy * vy
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / L)) : 0
    best = Math.min(best, Math.hypot(a.x + vx * t - x, a.y + vy * t - y))
  }
  return best
}

function pathLength(path: P[]): number {
  let len = 0
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  return len
}

function remainingLength(path: P[], k: number, x: number, y: number): number {
  let len = Math.hypot(path[k].x - x, path[k].y - y)
  for (let i = k + 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  return len
}
