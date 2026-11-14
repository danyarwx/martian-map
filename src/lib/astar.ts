import type { Mobility, Terrain } from '../types.ts'
import { secondsPerMetre } from './mobility.ts'

const NO_DATA = 255

/**
 * Seconds per metre for every cell, Infinity where the crew may not go. Build once per mobility.
 * `penalty` multiplies the cost by slope for a search that prefers gentle ground; it must be 1 on the level.
 */
export function buildCostGrid(t: Terrain, m: Mobility, penalty?: (slopeDeg: number) => number): Float32Array {
  const lookup = new Float32Array(256)
  for (let v = 0; v < 255; v++) lookup[v] = secondsPerMetre(m, v / 2) * (penalty ? penalty(v / 2) : 1)
  lookup[NO_DATA] = Infinity
  const cost = new Float32Array(t.slope.length)
  for (let i = 0; i < cost.length; i++) cost[i] = lookup[t.slope[i]]
  return cost
}

/** Nearest passable cell within `radius` cells of (col, row), or -1. */
export function snapToPassable(
  cost: Float32Array,
  width: number,
  height: number,
  col: number,
  row: number,
  radius = 5,
): number {
  let best = -1
  let bestD = Infinity
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const c = col + dc
      const r = row + dr
      if (c < 0 || r < 0 || c >= width || r >= height) continue
      const i = r * width + c
      if (cost[i] === Infinity) continue
      const d = dc * dc + dr * dr
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
  }
  return best
}

/** Binary min-heap of cell indices keyed by a float priority. */
export class Heap {
  private ids: number[] = []
  private keys: number[] = []

  get size() {
    return this.ids.length
  }

  push(id: number, key: number) {
    const ids = this.ids
    const keys = this.keys
    let i = ids.length
    ids.push(id)
    keys.push(key)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      ids[i] = ids[p]
      keys[i] = keys[p]
      i = p
    }
    ids[i] = id
    keys[i] = key
  }

  pop(): number {
    const ids = this.ids
    const keys = this.keys
    const top = ids[0]
    const lastId = ids.pop()!
    const lastKey = keys.pop()!
    const n = ids.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && keys[c + 1] < keys[c]) c++
        if (keys[c] >= lastKey) break
        ids[i] = ids[c]
        keys[i] = keys[c]
        i = c
      }
      ids[i] = lastId
      keys[i] = lastKey
    }
    return top
  }
}

export interface GridPath {
  /** Cell indices from start to goal, inclusive. */
  cells: number[]
  /** Travel time in seconds. */
  seconds: number
}

/**
 * Fastest path between two cells over an 8-connected grid.
 * `cost` is seconds per metre per cell (Infinity = no-go); a step costs its length times the
 * mean of the two cells. Diagonal steps are refused when they would cut a no-go corner.
 * `fastestSecPerM` is the lowest finite cost in the grid and keeps the heuristic admissible.
 */
export function findPath(
  cost: Float32Array,
  width: number,
  height: number,
  cellX: number,
  cellY: number,
  start: number,
  goal: number,
  fastestSecPerM: number,
): GridPath | null {
  if (cost[start] === Infinity || cost[goal] === Infinity) return null
  const n = width * height
  const g = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)
  const diag = Math.hypot(cellX, cellY)
  const goalCol = goal % width
  const goalRow = (goal / width) | 0
  const h = (i: number) => {
    const dx = Math.abs((i % width) - goalCol) * cellX
    const dy = Math.abs(((i / width) | 0) - goalRow) * cellY
    return Math.hypot(dx, dy) * fastestSecPerM
  }

  const open = new Heap()
  g[start] = 0
  open.push(start, h(start))

  while (open.size > 0) {
    const cur = open.pop()
    if (closed[cur]) continue
    if (cur === goal) break
    closed[cur] = 1
    const col = cur % width
    const row = (cur / width) | 0
    const gc = g[cur]
    const cc = cost[cur]

    for (let dr = -1; dr <= 1; dr++) {
      const r = row + dr
      if (r < 0 || r >= height) continue
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue
        const c = col + dc
        if (c < 0 || c >= width) continue
        const nb = r * width + c
        const cn = cost[nb]
        if (cn === Infinity || closed[nb]) continue
        let len: number
        if (dc !== 0 && dr !== 0) {
          if (cost[row * width + c] === Infinity || cost[r * width + col] === Infinity) continue
          len = diag
        } else {
          len = dc !== 0 ? cellX : cellY
        }
        const ng = gc + len * 0.5 * (cc + cn)
        if (ng < g[nb]) {
          g[nb] = ng
          from[nb] = cur
          open.push(nb, ng + h(nb))
        }
      }
    }
  }

  if (g[goal] === Infinity) return null
  const cells: number[] = []
  for (let i = goal; i !== -1; i = from[i]) cells.push(i)
  cells.reverse()
  return { cells, seconds: g[goal] }
}

/**
 * Travel time in seconds from `start` to every cell it can reach (Infinity elsewhere), over the same
 * 8-connected grid and step cost as `findPath`. The cost is symmetric, so this is also the time back to `start`.
 */
export function timeField(
  cost: Float32Array,
  width: number,
  height: number,
  cellX: number,
  cellY: number,
  start: number,
): Float32Array {
  const g = new Float32Array(width * height).fill(Infinity)
  if (start < 0 || cost[start] === Infinity) return g
  const closed = new Uint8Array(width * height)
  const diag = Math.hypot(cellX, cellY)
  const open = new Heap()
  g[start] = 0
  open.push(start, 0)
  while (open.size > 0) {
    const cur = open.pop()
    if (closed[cur]) continue
    closed[cur] = 1
    const col = cur % width
    const row = (cur / width) | 0
    const gc = g[cur]
    const cc = cost[cur]
    for (let dr = -1; dr <= 1; dr++) {
      const r = row + dr
      if (r < 0 || r >= height) continue
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue
        const c = col + dc
        if (c < 0 || c >= width) continue
        const nb = r * width + c
        const cn = cost[nb]
        if (cn === Infinity || closed[nb]) continue
        let len: number
        if (dc !== 0 && dr !== 0) {
          if (cost[row * width + c] === Infinity || cost[r * width + col] === Infinity) continue
          len = diag
        } else {
          len = dc !== 0 ? cellX : cellY
        }
        const ng = gc + len * 0.5 * (cc + cn)
        if (ng < g[nb]) {
          g[nb] = ng
          open.push(nb, ng)
        }
      }
    }
  }
  return g
}
