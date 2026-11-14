// Local planner (docs/helmet/PLAN.md §5.8): the way round what the helmet has just seen.
//
// A* over the 0.5 m hazard grid inside a 40 × 40 m window that holds the astronaut and the route point
// 30 m ahead. Entering a cell costs 1, +4 on sand, +0.5 when nobody has seen it yet; rock, steep and
// drop cells cannot be entered, and neither can the cells touching them (hazards are grown by one cell,
// 0.5 m, so the guide line does not graze a rock). 8-connected, no cutting across the corner of a
// blocked cell.
//
// It runs on every CV tick, so it allocates nothing per call beyond the returned path: the window, the
// search state and the heap are typed arrays owned by the LocalPlanner instance.
import { HAZARD, type Detection, type HazardClass } from '../contracts.ts'
import { GRID_CELL_M, dirToHeading } from '../frames.ts'
import { locate, pointAt, type RouteTrack, type TrackFix } from './follow.ts'

/** The part of HazardGrid the planner reads (mapping/hazardGrid.ts fits). Cells are anchored at local (0, 0). */
export interface HazardCells {
  classAtCell(col: number, row: number): HazardClass
}

export interface LocalPlannerOptions {
  /** Side of the square search window, metres. */
  windowM?: number
  /** How far ahead on the route the goal is, metres. */
  lookaheadM?: number
  /** Cells added around every rock, steep and drop cell. */
  inflateCells?: number
  /** Extra cost of a sand cell. */
  sandCost?: number
  /** Extra cost of a cell not seen yet. */
  unseenCost?: number
  /** How far along the route `hazardAheadM` looks, metres. */
  warnM?: number
  /** Distance along the guide path of the point `steerDeg` aims at, metres. */
  steerAheadM?: number
}

export interface LocalPlan {
  /**
   * The guide line in local ENU metres, from the astronaut's position to the goal, points at most 1 m
   * apart. Empty when `blocked`.
   */
  path: { x: number; y: number }[]
  /** True when no way to the goal exists inside the window: ask for a global re-route (nav/replan.ts). */
  blocked: boolean
  /**
   * Distance along the route (from the route point nearest the astronaut) to the first rock, steep or
   * drop cell ON the route line, when that is within `warnM` (15 m). Null when the route is clear that far.
   */
  hazardAheadM: number | null
  /** What that hazard is. */
  hazardAheadKind: Detection['kind'] | null
  /**
   * Heading to walk, degrees clockwise from north: toward the guide path a few metres ahead. When
   * `blocked`, the heading straight to the goal (do not follow it blindly: something is in the way).
   */
  steerDeg: number
  /** Where the path ends: the route point 30 m ahead, or the first free one beyond it. Null when none is free. */
  goal: { x: number; y: number } | null
  /** When `blocked`: the first place where the route itself is shut, for marking the planner cell. Else null. */
  blockedAt: { x: number; y: number } | null
  /** The astronaut's place on the route (pass `fix.s` as the hint of the next call). */
  fix: TrackFix
}

const SQRT2 = Math.SQRT2
/** Step along a straight line when checking it for hazards, in cells. */
const SIGHT_STEP = 0.5
/** The lookahead must be this much shorter than the window, so a detour has room on both sides. */
const LOOKAHEAD_MARGIN_M = 10
/**
 * Astronaut and goal must both be inside the window, which is centred between them: they may be at most
 * the window side minus this apart. Farther off the route than that, the guide leads back to the route first.
 */
const WINDOW_EDGE_M = 4

function kindOf(cls: HazardClass): Detection['kind'] | null {
  return cls === HAZARD.rock ? 'rock' : cls === HAZARD.steep ? 'steep' : cls === HAZARD.drop ? 'drop' : null
}

export class LocalPlanner {
  readonly windowM: number
  readonly lookaheadM: number
  readonly inflateCells: number
  readonly sandCost: number
  readonly unseenCost: number
  readonly warnM: number
  readonly steerAheadM: number

  /** Window side in cells. */
  private readonly w: number
  /** Hazard class per window cell. */
  private readonly cls: Uint8Array
  /** 1 = cannot be entered (hazard or its margin). */
  private readonly shut: Uint8Array
  /** Cost of entering each cell. */
  private readonly cost: Float32Array
  private readonly g: Float32Array
  private readonly parent: Int32Array
  /** Search number that last wrote g / closed a cell: no clearing between calls. */
  private readonly touched: Uint32Array
  private readonly closed: Uint32Array
  private readonly heapNode: Int32Array
  private readonly heapF: Float32Array
  private heapSize = 0
  private run = 0
  /** Window origin: grid column and row of window cell (0, 0). */
  private c0 = 0
  private r0 = 0
  /** Cells of the last path, goal first. */
  private readonly chain: Int32Array

  constructor(options: LocalPlannerOptions = {}) {
    this.windowM = options.windowM ?? 40
    this.lookaheadM = options.lookaheadM ?? 30
    this.inflateCells = options.inflateCells ?? 1
    this.sandCost = options.sandCost ?? 4
    this.unseenCost = options.unseenCost ?? 0.5
    this.warnM = options.warnM ?? 15
    this.steerAheadM = options.steerAheadM ?? 3
    if (this.lookaheadM > this.windowM - LOOKAHEAD_MARGIN_M) throw new Error('lookaheadM must leave a 10 m margin in the window')
    const w = Math.round(this.windowM / GRID_CELL_M)
    const n = w * w
    this.w = w
    this.cls = new Uint8Array(n)
    this.shut = new Uint8Array(n)
    this.cost = new Float32Array(n)
    this.g = new Float32Array(n)
    this.parent = new Int32Array(n)
    this.touched = new Uint32Array(n)
    this.closed = new Uint32Array(n)
    this.heapNode = new Int32Array(n * 8 + 1)
    this.heapF = new Float32Array(n * 8 + 1)
    this.chain = new Int32Array(n)
  }

  /**
   * Plans from the astronaut at local (x, y) toward the route point `lookaheadM` ahead on `track`.
   * `hintS` is the previous call's `fix.s` (see follow.ts `locate`).
   */
  plan(grid: HazardCells, track: RouteTrack, x: number, y: number, hintS?: number): LocalPlan {
    const fix = locate(track, x, y, hintS)
    const w = this.w

    // ---- warning: first hard hazard on the route line itself
    let hazardAheadM: number | null = null
    let hazardAheadKind: Detection['kind'] | null = null
    const warnEnd = Math.min(this.warnM, track.lengthM - fix.s)
    for (let d = 0; d <= warnEnd; d += GRID_CELL_M / 2) {
      const p = pointAt(track, fix.s + d)
      const kind = kindOf(grid.classAtCell(Math.floor(p.x / GRID_CELL_M), Math.floor(-p.y / GRID_CELL_M)))
      if (kind) {
        hazardAheadM = d
        hazardAheadKind = kind
        break
      }
    }

    // ---- where to go
    const goalS = Math.min(track.lengthM, fix.s + this.lookaheadM)
    let aim: { x: number; y: number } = pointAt(track, goalS)
    // Astronaut and goal must share the window with a margin. Far off the route, head for the route first.
    const reach = this.windowM - WINDOW_EDGE_M
    let onRoute = true
    if (Math.hypot(aim.x - x, aim.y - y) > reach) {
      onRoute = false
      const d = fix.distM
      aim = d > reach ? { x: x + ((fix.x - x) / d) * reach, y: y + ((fix.y - y) / d) * reach } : { x: fix.x, y: fix.y }
    }

    // ---- window around the midpoint of astronaut and goal, aligned to the hazard grid
    this.c0 = Math.floor((x + aim.x) / 2 / GRID_CELL_M) - (w >> 1)
    this.r0 = Math.floor(-(y + aim.y) / 2 / GRID_CELL_M) - (w >> 1)
    this.fill(grid)

    const start = this.cellOf(x, y)
    // The astronaut is where they are: free their cell and the margin cells around it (never true hazards
    // other than the one underfoot), so a rock right beside them does not make every plan "blocked".
    if (start >= 0) {
      const sc = start % w
      const sr = (start / w) | 0
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const c = sc + dc
          const r = sr + dr
          if (c < 0 || r < 0 || c >= w || r >= w) continue
          const i = r * w + c
          if (i === start || kindOf(this.cls[i] as HazardClass) === null) this.shut[i] = 0
        }
      }
    }

    // ---- goal: the aim point, else the first free route point beyond it, else the nearest free one before it
    const picked = { cell: -1, x: 0, y: 0 }
    const tryPoint = (p: { x: number; y: number }): boolean => {
      const i = this.cellOf(p.x, p.y)
      if (i < 0 || this.shut[i]) return false
      picked.cell = i
      picked.x = p.x
      picked.y = p.y
      return true
    }
    if (!tryPoint(aim) && onRoute) {
      let found = false
      for (let s = goalS + 1; !found && s <= track.lengthM + 1; s += 1) {
        const p = pointAt(track, s)
        if (this.cellOf(p.x, p.y) < 0) break // left the window
        found = tryPoint(p)
      }
      for (let s = goalS - 1; !found && s >= fix.s + 2; s -= 1) found = tryPoint(pointAt(track, s))
    }
    const goal = picked.cell < 0 ? null : { x: picked.x, y: picked.y }

    const toAim = dirToHeading(aim.x - x, aim.y - y)
    const fail = (): LocalPlan => ({
      path: [],
      blocked: true,
      hazardAheadM,
      hazardAheadKind,
      steerDeg: toAim,
      goal,
      blockedAt: this.firstShutOnRoute(track, fix.s, goalS),
      fix,
    })
    if (start < 0 || goal === null) return fail()

    const len = this.search(start, picked.cell)
    if (len < 0) return fail()

    // ---- cells → metres, straightened, one point per metre
    const path = this.polyline(len, x, y, goal)
    let steerDeg = fix.headingDeg
    let walked = 0
    for (let k = 1; k < path.length; k++) {
      walked += Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y)
      if (walked >= this.steerAheadM || k === path.length - 1) {
        const dx = path[k].x - x
        const dy = path[k].y - y
        if (Math.hypot(dx, dy) > 0.25) steerDeg = dirToHeading(dx, dy)
        break
      }
    }
    return { path, blocked: false, hazardAheadM, hazardAheadKind, steerDeg, goal, blockedAt: null, fix }
  }

  /** Window cell index of local point (x, y), −1 outside the window. */
  private cellOf(x: number, y: number): number {
    const c = Math.floor(x / GRID_CELL_M) - this.c0
    const r = Math.floor(-y / GRID_CELL_M) - this.r0
    return c < 0 || r < 0 || c >= this.w || r >= this.w ? -1 : r * this.w + c
  }

  /** Reads the window from the grid: class and cost per cell, and which cells are shut (hazards grown by the margin). */
  private fill(grid: HazardCells): void {
    const { w, cls, shut, cost, c0, r0 } = this
    const m = this.inflateCells
    shut.fill(0)
    // One ring of cells outside the window is read too, so a hazard just outside still shuts its neighbours.
    for (let r = -m; r < w + m; r++) {
      for (let c = -m; c < w + m; c++) {
        const k = grid.classAtCell(c0 + c, r0 + r)
        const inside = c >= 0 && r >= 0 && c < w && r < w
        if (inside) {
          const i = r * w + c
          cls[i] = k
          cost[i] = 1 + (k === HAZARD.sand ? this.sandCost : k === HAZARD.unseen ? this.unseenCost : 0)
        }
        if (k !== HAZARD.rock && k !== HAZARD.steep && k !== HAZARD.drop) continue
        const ra = Math.max(0, r - m)
        const rb = Math.min(w - 1, r + m)
        const ca = Math.max(0, c - m)
        const cb = Math.min(w - 1, c + m)
        for (let rr = ra; rr <= rb; rr++) for (let cc = ca; cc <= cb; cc++) shut[rr * w + cc] = 1
      }
    }
  }

  /** A*. Returns the number of cells of the path, written goal-first into `chain`, or −1 when there is none. */
  private search(start: number, goal: number): number {
    const { w, shut, cost, g, parent, touched, closed, heapNode, heapF } = this
    const run = ++this.run
    const gc = goal % w
    const gr = (goal / w) | 0
    const h = (i: number) => {
      const dc = Math.abs((i % w) - gc)
      const dr = Math.abs(((i / w) | 0) - gr)
      return dc > dr ? dc + (SQRT2 - 1) * dr : dr + (SQRT2 - 1) * dc // every cell costs at least 1
    }
    this.heapSize = 0
    g[start] = 0
    parent[start] = -1
    touched[start] = run
    this.push(start, h(start))

    while (this.heapSize > 0) {
      // pop the smallest f
      const cur = heapNode[0]
      const lastN = heapNode[--this.heapSize]
      const lastF = heapF[this.heapSize]
      let i = 0
      for (;;) {
        let child = 2 * i + 1
        if (child >= this.heapSize) break
        if (child + 1 < this.heapSize && heapF[child + 1] < heapF[child]) child++
        if (heapF[child] >= lastF) break
        heapNode[i] = heapNode[child]
        heapF[i] = heapF[child]
        i = child
      }
      heapNode[i] = lastN
      heapF[i] = lastF

      if (closed[cur] === run) continue
      closed[cur] = run
      if (cur === goal) {
        let n = 0
        for (let k = cur; k >= 0; k = parent[k]) this.chain[n++] = k
        return n
      }
      const c = cur % w
      const r = (cur / w) | 0
      const gCur = g[cur]
      const costCur = cost[cur]
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr
        if (nr < 0 || nr >= w) continue
        for (let dc = -1; dc <= 1; dc++) {
          if (dc === 0 && dr === 0) continue
          const nc = c + dc
          if (nc < 0 || nc >= w) continue
          const ni = nr * w + nc
          if (shut[ni] || closed[ni] === run) continue
          const diagonal = dc !== 0 && dr !== 0
          if (diagonal && (shut[r * w + nc] || shut[nr * w + c])) continue // no cutting a blocked corner
          const ng = gCur + (diagonal ? SQRT2 : 1) * 0.5 * (costCur + cost[ni])
          if (touched[ni] === run && ng >= g[ni]) continue
          g[ni] = ng
          parent[ni] = cur
          touched[ni] = run
          this.push(ni, ng + h(ni))
        }
      }
    }
    return -1
  }

  private push(node: number, f: number): void {
    const { heapNode, heapF } = this
    let i = this.heapSize++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapF[p] <= f) break
      heapNode[i] = heapNode[p]
      heapF[i] = heapF[p]
      i = p
    }
    heapNode[i] = node
    heapF[i] = f
  }

  /**
   * True when the straight line between two window positions (in cells) crosses no shut cell and no cell
   * costlier than `limit`: a shortcut may not cross sand or unseen ground that the searched path avoided.
   */
  private clear(ac: number, ar: number, bc: number, br: number, limit: number): boolean {
    const { w, shut, cost } = this
    const steps = Math.max(1, Math.ceil(Math.hypot(bc - ac, br - ar) / SIGHT_STEP))
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const c = Math.floor(ac + (bc - ac) * t)
      const r = Math.floor(ar + (br - ar) * t)
      if (c < 0 || r < 0 || c >= w || r >= w) return false
      const i = r * w + c
      if (shut[i] || cost[i] > limit) return false
    }
    return true
  }

  /**
   * The cell chain as a line in metres: starts at the astronaut, ends at the goal point, corners of the
   * grid path pulled straight wherever the straight line stays clear, then cut to steps of at most 1 m.
   */
  private polyline(len: number, x: number, y: number, goal: { x: number; y: number }): { x: number; y: number }[] {
    const { w, chain, c0, r0 } = this
    // Positions in window cells (fractions allowed), start first.
    const pc: number[] = new Array(len)
    const pr: number[] = new Array(len)
    for (let k = 0; k < len; k++) {
      const i = chain[len - 1 - k]
      pc[k] = (i % w) + 0.5
      pr[k] = ((i / w) | 0) + 0.5
    }
    pc[0] = x / GRID_CELL_M - c0
    pr[0] = -y / GRID_CELL_M - r0
    pc[len - 1] = goal.x / GRID_CELL_M - c0
    pr[len - 1] = -goal.y / GRID_CELL_M - r0

    // Keep a corner only where the straight line from the last kept point would touch a hazard, or ground
    // worse than the searched path used.
    const costAt = (k: number) => this.cost[chain[len - 1 - k]]
    const keep: number[] = [0]
    let anchor = 0
    let worst = len > 1 ? Math.max(costAt(0), costAt(1)) : 0 // costliest cell of the searched path since the anchor
    for (let k = 2; k < len; k++) {
      worst = Math.max(worst, costAt(k))
      if (!this.clear(pc[anchor], pr[anchor], pc[k], pr[k], worst)) {
        anchor = k - 1
        keep.push(anchor)
        worst = Math.max(costAt(anchor), costAt(k))
      }
    }
    if (len > 1) keep.push(len - 1)

    const out: { x: number; y: number }[] = []
    const toLocalX = (c: number) => (c + c0) * GRID_CELL_M
    const toLocalY = (r: number) => -(r + r0) * GRID_CELL_M
    for (let k = 0; k < keep.length; k++) {
      const bx = toLocalX(pc[keep[k]])
      const by = toLocalY(pr[keep[k]])
      if (k > 0) {
        const a = out[out.length - 1]
        const n = Math.ceil(Math.hypot(bx - a.x, by - a.y))
        for (let j = 1; j < n; j++) out.push({ x: a.x + ((bx - a.x) * j) / n, y: a.y + ((by - a.y) * j) / n })
      }
      out.push({ x: bx, y: by })
    }
    out[0] = { x, y }
    out[out.length - 1] = { x: goal.x, y: goal.y }
    return out
  }

  /** First point of the route between `fromS` and `toS` whose cell is shut, or the point 10 m ahead when none is. */
  private firstShutOnRoute(track: RouteTrack, fromS: number, toS: number): { x: number; y: number } {
    for (let s = fromS; s <= toS; s += GRID_CELL_M) {
      const p = pointAt(track, s)
      const i = this.cellOf(p.x, p.y)
      if (i >= 0 && this.shut[i]) return { x: p.x, y: p.y }
    }
    const p = pointAt(track, Math.min(track.lengthM, fromS + 10))
    return { x: p.x, y: p.y }
  }
}
