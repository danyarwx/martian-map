// Global re-route (docs/helmet/PLAN.md §5.8): when what the helmet sees shuts the planned route, mark the
// planner cells (10 m) it found blocked and ask the teammates' planner for a new route from where the
// astronaut stands, through the remaining stops in the same order, back to the habitat.
//
// Two parts:
// - ReplanDecider: pure. Collects blocked planner cells and says WHEN to re-route. Runs in Node.
// - ReplanClient: owns its own planner worker and speaks its 'replan' message (src/lib/planner.worker.ts).
import { cellCenter, inGrid, toCell } from '../../lib/geo.ts'
// Types only: a value import would pull the planner into the main bundle.
import type { ReplanRequest, ReplanResponse } from '../../lib/planner.worker.ts'
import type { LatLon, MobilityId, RoutePlan, RouteProfile, SiteConfig, Target, TerrainMeta } from '../../types.ts'
import { toLocal } from '../frames.ts'

// ---------------------------------------------------------------------------------------------------
// What is left of a plan

/**
 * The path still to walk: from the vertex of leg `legIndex` nearest to `from` (the whole leg without
 * `from`) to the end of the plan.
 */
export function remainingPath(plan: RoutePlan, legIndex: number, from?: LatLon): LatLon[] {
  const out: LatLon[] = []
  for (let k = Math.max(0, legIndex); k < plan.legs.length; k++) {
    const path = plan.legs[k].path
    let first = 0
    if (k === legIndex && from) {
      let best = Infinity
      for (let i = 0; i < path.length; i++) {
        const d = toLocal(path[i], from)
        const dd = d.x * d.x + d.y * d.y
        if (dd < best) {
          best = dd
          first = i
        }
      }
    }
    for (let i = first; i < path.length; i++) out.push(path[i])
  }
  return out
}

/**
 * The stops still to visit, in order, and the habitat, as the planner wants them (`Target`s).
 *
 * A plan only carries stop ids, so each stop is taken from `site` by id when given; otherwise it is
 * rebuilt from the end point of its leg (the passable cell the planner snapped the stop to, which is
 * where the crew goes anyway). The plan's last leg is taken to end at the habitat.
 */
export function remainingStops(
  plan: RoutePlan,
  legIndex: number,
  site?: { habitat: Target; targets: readonly Target[] },
): { stops: Target[]; habitat: Target } {
  if (plan.legs.length === 0) throw new Error('The plan has no legs')
  const known = new Map<string, Target>()
  if (site) {
    known.set(site.habitat.id, site.habitat)
    for (const t of site.targets) known.set(t.id, t)
  }
  const targetOf = (k: number): Target => {
    const leg = plan.legs[k]
    const hit = known.get(leg.toId)
    if (hit) return hit
    const end = leg.path[leg.path.length - 1]
    return { id: leg.toId, name: leg.toId, summary: '', science: '', task: '', lat: end.lat, lon: end.lon }
  }
  const last = plan.legs.length - 1
  const stops: Target[] = []
  for (let k = Math.max(0, legIndex); k < last; k++) stops.push(targetOf(k))
  return { stops, habitat: targetOf(last) }
}

/**
 * Minutes the current plan still needs from here: the rest of leg `legIndex` (`legDone` = share of it
 * already walked, 0..1, e.g. `fix.s / track.lengthM`), the legs after it, and the work at the stops not
 * reached yet. Compare with the new plan's `totalMinutes`.
 */
export function remainingMinutes(plan: RoutePlan, legIndex: number, legDone = 0): number {
  const last = plan.legs.length - 1
  if (last < 0 || legIndex > last) return 0
  const li = Math.max(0, legIndex)
  let minutes = plan.legs[li].minutes * (1 - Math.min(1, Math.max(0, legDone)))
  for (let k = li + 1; k <= last; k++) minutes += plan.legs[k].minutes
  // Every leg but the last ends at a stop where the crew works.
  const perStop = last > 0 ? plan.stopMinutes / last : 0
  return minutes + perStop * (last - li)
}

// ---------------------------------------------------------------------------------------------------
// When to re-route

/** The part of HazardGrid the decider reads (mapping/hazardGrid.ts fits). */
export interface PlannerCellSource {
  blockedPlannerCells(meta: TerrainMeta, origin: LatLon, coverage?: number): Set<number>
}

export interface ReplanDeciderOptions {
  /** Share of a planner cell that rock, steep or drop cells must cover to block it. */
  coverage?: number
  /**
   * When the local planner is blocked, planner cells near the astronaut are blocked from this (much
   * lower) share on: a rock wall half a metre thick shuts a 10 m cell without covering 30 % of it.
   */
  localCoverage?: number
  /** "Near the astronaut" for `localCoverage`, metres. */
  localRadiusM?: number
  /** A newly blocked cell triggers a re-route when it is within this many planner cells of the remaining route. */
  nearCells?: number
  /** Shortest time between two re-routes, ms. */
  minIntervalMs?: number
}

export interface ReplanCheck {
  grid: PlannerCellSource
  /** Where the astronaut is. */
  at: LatLon
  /** `LocalPlan.blocked` of the latest local plan. */
  localBlocked: boolean
  /** `LocalPlan.blockedAt` as LatLon (frames.ts `toLatLon`): where the route itself is shut. */
  localBlockedAt?: LatLon | null
  /** A monotonic clock, e.g. `performance.now()`. */
  nowMs: number
}

export interface ReplanDecision {
  replan: boolean
  reason: 'hazard-on-route' | 'local-blocked' | null
  /** Planner cells (row × width + col) blocked by this check that caused the re-route. Empty without one. */
  newCells: number[]
}

const NO_REPLAN: ReplanDecision = { replan: false, reason: null, newCells: [] }
/** Route vertices checked behind and ahead of the last known one when following progress. */
const PROGRESS_BACK = 3
const PROGRESS_AHEAD = 40
/** Farther than this from every vertex in that range, the whole route is searched, metres. */
const PROGRESS_RETRY_M = 60

export class ReplanDecider {
  /** Every planner cell found blocked so far, 1 = blocked, index row × width + col of the terrain grid. */
  readonly blocked: Uint8Array
  readonly coverage: number
  readonly localCoverage: number
  readonly localRadiusM: number
  readonly nearCells: number
  readonly minIntervalMs: number

  private readonly meta: TerrainMeta
  private readonly origin: LatLon
  private route: readonly LatLon[] = []
  /** Planner cell under each route vertex, −1 outside the grid. */
  private routeCell: Int32Array = new Int32Array(0)
  /** Planner cell → the last route vertex it is near. A cell counts while that vertex is still ahead. */
  private reach = new Map<number, number>()
  private progress = 0
  private lastReplanMs = -Infinity

  /** `meta` is the terrain header the planner uses; `origin` the session origin of the hazard grid. */
  constructor(meta: TerrainMeta, origin: LatLon, options: ReplanDeciderOptions = {}) {
    this.meta = meta
    this.origin = origin
    this.coverage = options.coverage ?? 0.3
    this.localCoverage = options.localCoverage ?? 0.03
    this.localRadiusM = options.localRadiusM ?? 30
    this.nearCells = options.nearCells ?? 1
    this.minIntervalMs = options.minIntervalMs ?? 5000
    this.blocked = new Uint8Array(meta.width * meta.height)
  }

  /**
   * The route still to walk (`remainingPath`). Call at the start and after every plan change. The cells
   * blocked so far are kept: they belong to the ground, not to the route.
   */
  setRoute(path: readonly LatLon[]): void {
    const { meta } = this
    this.route = path
    this.routeCell = new Int32Array(path.length)
    this.reach = new Map()
    this.progress = 0
    const n = this.nearCells
    for (let k = 0; k < path.length; k++) {
      const { col, row } = toCell(meta, path[k])
      this.routeCell[k] = inGrid(meta, col, row) ? row * meta.width + col : -1
      for (let dr = -n; dr <= n; dr++) {
        for (let dc = -n; dc <= n; dc++) {
          if (inGrid(meta, col + dc, row + dr)) this.reach.set((row + dr) * meta.width + col + dc, k)
        }
      }
    }
  }

  /** Indices of every blocked cell, for `ReplanJob.blocked`. */
  blockedCells(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.blocked.length; i++) if (this.blocked[i]) out.push(i)
    return out
  }

  /**
   * Call after each local plan (or less often: it scans the whole hazard grid, a few ms on a long walk).
   *
   * Re-route when
   * - a planner cell on or next to the route AHEAD became blocked (hazards cover ≥ `coverage` of it), or
   * - the local planner is blocked: then the planner cells within `localRadiusM` holding even a little
   *   hazard (`localCoverage`) are blocked, and the cell where the route is shut.
   * Never more often than `minIntervalMs`; while waiting nothing is scanned and nothing is lost, the
   * next check picks the cells up. Blocked cells off the route are collected silently and go out with
   * the next re-route.
   */
  check(input: ReplanCheck): ReplanDecision {
    if (input.nowMs - this.lastReplanMs < this.minIntervalMs) return NO_REPLAN
    const { meta, blocked } = this
    this.follow(input.at)

    const newCells: number[] = []
    for (const i of input.grid.blockedPlannerCells(meta, this.origin, this.coverage)) {
      if (blocked[i]) continue
      blocked[i] = 1
      if ((this.reach.get(i) ?? -1) >= this.progress) newCells.push(i)
    }
    let reason: ReplanDecision['reason'] = newCells.length > 0 ? 'hazard-on-route' : null

    if (input.localBlocked) {
      const here = toCell(meta, input.at)
      const hereIdx = inGrid(meta, here.col, here.row) ? here.row * meta.width + here.col : -1
      let added = 0
      const add = (i: number) => {
        if (i < 0 || i === hereIdx || blocked[i]) return // never the cell the astronaut stands in
        blocked[i] = 1
        newCells.push(i)
        added++
      }
      for (const i of input.grid.blockedPlannerCells(meta, this.origin, this.localCoverage)) {
        const d = toLocal(cellCenter(meta, i % meta.width, (i / meta.width) | 0), input.at)
        if (Math.hypot(d.x, d.y) <= this.localRadiusM) add(i)
      }
      if (input.localBlockedAt) {
        const c = toCell(meta, input.localBlockedAt)
        if (inGrid(meta, c.col, c.row)) add(c.row * meta.width + c.col)
      }
      // Nothing new to block, yet no way through: shut the next cell of the route, or the same route comes back.
      if (newCells.length === 0) {
        for (let k = this.progress; k < this.routeCell.length && added === 0; k++) {
          const i = this.routeCell[k]
          if (i !== hereIdx) add(i)
        }
      }
      if (added > 0) reason = 'local-blocked'
    }

    if (newCells.length === 0) return NO_REPLAN
    this.lastReplanMs = input.nowMs
    return { replan: true, reason, newCells }
  }

  /** Moves `progress` to the route vertex nearest the astronaut, looking near the last one first. */
  private follow(at: LatLon): void {
    const n = this.route.length
    if (n === 0) return
    const search = (from: number, to: number) => {
      let best = from
      let bestD = Infinity
      for (let k = from; k <= to; k++) {
        const d = toLocal(this.route[k], at)
        const dd = d.x * d.x + d.y * d.y
        if (dd < bestD) {
          bestD = dd
          best = k
        }
      }
      return { best, dist: Math.sqrt(bestD) }
    }
    let hit = search(Math.max(0, this.progress - PROGRESS_BACK), Math.min(n - 1, this.progress + PROGRESS_AHEAD))
    if (hit.dist > PROGRESS_RETRY_M) hit = search(0, n - 1)
    this.progress = hit.best
  }
}

// ---------------------------------------------------------------------------------------------------
// Asking the planner

/** The part of a Worker the client uses (a fake one in tests). */
export interface ReplanWorkerLike {
  postMessage(msg: ReplanRequest): void
  terminate(): void
  onmessage: ((e: MessageEvent<ReplanResponse>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

/** A planner worker of the helmet's own: Mission control's (usePlanner) is not shared. */
export function createReplanWorker(): ReplanWorkerLike {
  return new Worker(new URL('../../lib/planner.worker.ts', import.meta.url), { type: 'module' })
}

export interface ReplanJob {
  /** `plan.mobility` and `plan.profile` of the plan being replaced. */
  mobility: MobilityId
  profile: RouteProfile
  /** Where the astronaut is. */
  from: LatLon
  /** `remainingStops(...)`. */
  stops: Target[]
  habitat: Target
  /** `decider.blockedCells()`. */
  blocked: number[]
  /** `remainingMinutes(...)` of the plan being replaced. */
  remainingMinutes: number
}

export interface ReplanResult {
  /**
   * From the astronaut through the remaining stops to the habitat. `order[0]` and `legs[0].fromId` are
   * 'start' (planner.ts PLAN_FROM_START_ID); the active leg is `legs[0]`. Stops the planner could not
   * reach are in `unreachable`.
   */
  plan: RoutePlan
  /** New `totalMinutes` minus the old plan's remaining minutes: the N of "Route updated: +N min". */
  deltaMinutes: number
}

export class ReplanClient {
  private worker: ReplanWorkerLike | null
  private readonly terrain: SiteConfig['terrain']
  private nextId = 1
  private pending: { id: number; remainingMinutes: number; resolve: (r: ReplanResult) => void; reject: (e: Error) => void } | null = null

  /** `terrain` is the site's terrain files (`SiteConfig.terrain`); the worker loads them on its first request. */
  constructor(terrain: SiteConfig['terrain'], factory: () => ReplanWorkerLike = createReplanWorker) {
    this.terrain = terrain
    const w = factory()
    this.worker = w
    w.onmessage = (e) => {
      const res = e.data
      const p = this.pending
      if (this.worker !== w || !p || !res || res.type !== 'replan' || res.id !== p.id) return
      this.pending = null
      if (!res.ok) p.reject(new Error(res.error))
      else if (res.plan.legs.length === 0) p.reject(new Error('No safe route from here'))
      else p.resolve({ plan: res.plan, deltaMinutes: res.plan.totalMinutes - p.remainingMinutes })
    }
    w.onerror = (e) => {
      const p = this.pending
      if (this.worker !== w || !p) return
      this.pending = null
      p.reject(new Error(e.message || 'Planner worker error'))
    }
  }

  /** True while a re-route is being computed. */
  get busy(): boolean {
    return this.pending !== null
  }

  /**
   * Asks for a new route. One at a time: rejects when one is already running or the client is disposed.
   * Also rejects when the planner finds no route (keep the current plan then). The first request waits
   * for the worker to download the terrain grids (about 3 MB).
   */
  replan(job: ReplanJob): Promise<ReplanResult> {
    const w = this.worker
    if (!w) return Promise.reject(new Error('The re-route client is disposed'))
    if (this.pending) return Promise.reject(new Error('A re-route is already running'))
    const id = this.nextId++
    return new Promise<ReplanResult>((resolve, reject) => {
      this.pending = { id, remainingMinutes: job.remainingMinutes, resolve, reject }
      w.postMessage({
        type: 'replan',
        id,
        terrain: this.terrain,
        mobility: job.mobility,
        from: { lat: job.from.lat, lon: job.from.lon },
        stops: job.stops,
        habitat: job.habitat,
        blocked: job.blocked,
        profile: job.profile,
      })
    })
  }

  /** Terminates the worker. A re-route still running is rejected. */
  dispose(): void {
    const p = this.pending
    this.pending = null
    this.worker?.terminate()
    this.worker = null
    p?.reject(new Error('The re-route client is disposed'))
  }
}
