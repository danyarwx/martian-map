import type { LatLon, Mobility, RouteNote, RouteProfile, RouteSection, Terrain } from '../types.ts'
import { cellCenter } from './geo.ts'
import { secondsPerMetre } from './mobility.ts'

/** A stretch of path bends once it is this far from the straight line between its ends, metres. */
const DETOUR_OFFSET_M = 40
/** A bend on a stretch shorter than this along the path is not worth a note, metres. */
const DETOUR_MIN_LENGTH_M = 100
/** A detour note is dropped when the ground it avoids is farther than this from the turn, metres. */
const OBSTACLE_MAX_DISTANCE_M = 300
/** Of two detour notes closer than this along the path, only the more important is kept, metres. */
const NOTE_SPACING_M = 150
/** A steep stretch on the route shorter than this is not worth a note, metres. */
const STEEP_MIN_LENGTH_M = 20
/** A detour over passable ground is explained only when it saves at least this much, seconds. */
const MIN_SAVING_S = 60
/** The gentle route explains a detour only when it is at least this much gentler than the direct line, degrees. */
const MIN_GENTLER_DEG = 3
/** Most notes shown on one leg. */
const MAX_NOTES_PER_LEG = 6

const NO_DATA = 255

/**
 * Sign shown for each kind of note, on the map and in the leg list. Detour notes mark a turn of the
 * route, not a hazard, so they get a turn sign; a steep stretch is on the route itself.
 */
export const NOTE_SIGNS: Record<RouteNote['kind'], string> = { 'no-go': '↷', slow: '↷', steep: '▲' }
/** Sign for the ground a detour note points at. */
export const OBSTACLE_SIGN = '×'

/** Slopes in degrees where the route line changes colour: half and three quarters of the mobility's limit. */
export function slopeLevelLimits(m: Mobility): [number, number] {
  return [m.maxSlopeDeg / 2, m.maxSlopeDeg * 0.75]
}

/** Slope class of one cell for this mobility: 0 easy, 1 moderate, 2 close to the limit. */
function slopeLevel(m: Mobility, slopeDeg: number): 0 | 1 | 2 {
  const [moderate, steep] = slopeLevelLimits(m)
  return slopeDeg < moderate ? 0 : slopeDeg < steep ? 1 : 2
}

/** Grid cells on the straight line from cell `a` to cell `b`, both included (Bresenham). */
function lineCells(width: number, a: number, b: number): number[] {
  let col = a % width
  let row = (a / width) | 0
  const endCol = b % width
  const endRow = (b / width) | 0
  const dc = Math.abs(endCol - col)
  const dr = Math.abs(endRow - row)
  const sc = col < endCol ? 1 : -1
  const sr = row < endRow ? 1 : -1
  let err = dc - dr
  const out = [row * width + col]
  while (col !== endCol || row !== endRow) {
    const e2 = 2 * err
    if (e2 > -dr) {
      err -= dr
      col += sc
    }
    if (e2 < dc) {
      err += dc
      row += sr
    }
    out.push(row * width + col)
  }
  return out
}

/** Ground distance between two neighbouring cells, metres. */
function stepM(t: Terrain, a: number, b: number): number {
  const dc = Math.abs((a % t.width) - (b % t.width))
  const dr = Math.abs(((a / t.width) | 0) - ((b / t.width) | 0))
  return Math.hypot(dc * t.cellMetersX, dr * t.cellMetersY)
}

/** Travel time and steepest slope over a chain of cells, with the same step cost the route search uses. */
function travel(t: Terrain, m: Mobility, cells: number[], from = 0, to = cells.length - 1) {
  let seconds = 0
  let steepestDeg = 0
  for (let k = from; k <= to; k++) {
    const deg = t.slope[cells[k]] / 2
    steepestDeg = Math.max(steepestDeg, deg)
    if (k === from) continue
    const before = t.slope[cells[k - 1]] / 2
    seconds += stepM(t, cells[k - 1], cells[k]) * 0.5 * (secondsPerMetre(m, before) + secondsPerMetre(m, deg))
  }
  return { seconds, steepestDeg }
}

/** Ground position of a cell, metres from the grid's north-west corner. */
function groundXY(t: Terrain, cell: number): [number, number] {
  return [(cell % t.width) * t.cellMetersX, ((cell / t.width) | 0) * t.cellMetersY]
}

/** Distance from cell `p` to the straight segment between cells `a` and `b`, metres. */
function offsetFromSegment(t: Terrain, p: number, a: number, b: number): number {
  const [ax, ay] = groundXY(t, a)
  const [bx, by] = groundXY(t, b)
  const [px, py] = groundXY(t, p)
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const along = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - ax - along * dx, py - ay - along * dy)
}

/** Ground distance between two cells, metres. */
function groundDistanceM(t: Terrain, a: number, b: number): number {
  const [ax, ay] = groundXY(t, a)
  const [bx, by] = groundXY(t, b)
  return Math.hypot(bx - ax, by - ay)
}

function pointOf(t: Terrain, cell: number): LatLon {
  return cellCenter(t, cell % t.width, (cell / t.width) | 0)
}

/** A note before the list is trimmed: where it sits on the path and how much it matters. */
interface Candidate extends RouteNote {
  /** Path index of the cell the note sits on. */
  index: number
  /** Larger matters more among notes of the same kind. */
  weight: number
  /** Kind plus the rounded slope it names: two notes with the same key say the same thing. */
  key: string
  /** Set when a note on a shorter stretch says the same thing nearer the obstacle. */
  dropped?: boolean
}

const KIND_ORDER: Record<RouteNote['kind'], number> = { 'no-go': 0, slow: 1, steep: 2 }
const byImportance = (p: Candidate, q: Candidate) => KIND_ORDER[p.kind] - KIND_ORDER[q.kind] || q.weight - p.weight

/**
 * Why the path bends at path cell `index` instead of going straight from path cell `from` to `to`,
 * or null when the straight line would be passable and barely worse, or the reason lies too far away.
 * "Worse" is slower for the fast route and steeper for the gentle one.
 */
function explainDetour(
  t: Terrain,
  m: Mobility,
  profile: RouteProfile,
  cells: number[],
  from: number,
  to: number,
  index: number,
): Candidate | null {
  const at = pointOf(t, cells[index])
  const direct = lineCells(t.width, cells[from], cells[to])
  const noGo = (i: number) => t.slope[i] === NO_DATA || t.slope[i] / 2 > m.maxSlopeDeg

  // The direct line may cross several obstacles: name the one nearest this bend.
  let nearest = -1
  let nearestM = Infinity
  const [x, y] = groundXY(t, cells[index])
  direct.forEach((cell, k) => {
    if (!noGo(cell)) return
    const [cx, cy] = groundXY(t, cell)
    const d = Math.hypot(cx - x, cy - y)
    if (d < nearestM) {
      nearestM = d
      nearest = k
    }
  })
  if (nearest >= 0) {
    let lo = nearest
    let hi = nearest
    while (lo > 0 && noGo(direct[lo - 1])) lo--
    while (hi + 1 < direct.length && noGo(direct[hi + 1])) hi++
    // Point at the steepest cell of that obstacle, or at its nearest cell when it is all missing data.
    let steepest = 0
    let cell = direct[nearest]
    for (let k = lo; k <= hi; k++) {
      const v = t.slope[direct[k]]
      if (v !== NO_DATA && v / 2 > steepest) {
        steepest = v / 2
        cell = direct[k]
      }
    }
    const deg = Math.round(steepest)
    const distance = groundDistanceM(t, cells[index], cell)
    if (distance > OBSTACLE_MAX_DISTANCE_M) return null
    const away = Math.round(distance / 10) * 10
    const who = m.id === 'walk' ? 'on foot' : 'for the rover'
    const [text, obstacleText] =
      steepest > 0
        ? [
            `Turns here: ${deg}° slope ${away} m away on the direct line (limit ${m.maxSlopeDeg}°).`,
            `${deg}° slope: too steep ${who} (limit ${m.maxSlopeDeg}°)`,
          ]
        : [`Turns here: no elevation data ${away} m away on the direct line.`, 'No elevation data']
    return { at, kind: 'no-go', text, obstacle: pointOf(t, cell), obstacleText, index, weight: steepest, key: `no-go ${deg}` }
  }

  const straight = travel(t, m, direct)
  const taken = travel(t, m, cells, from, to)
  const deg = Math.round(straight.steepestDeg)
  let text: string
  let weight: number
  if (profile === 'gentle') {
    // This route gives up time for gentler ground, so the reason is the slope it stays under.
    weight = straight.steepestDeg - taken.steepestDeg
    if (weight < MIN_GENTLER_DEG) return null
    text = `Turns here: up to ${deg}° on the direct line. This way stays under ${Math.floor(taken.steepestDeg) + 1}°.`
  } else {
    weight = straight.seconds - taken.seconds
    if (weight < MIN_SAVING_S) return null
    const minutes = Math.round(weight / 60)
    text =
      straight.steepestDeg > taken.steepestDeg
        ? `Turns here: up to ${deg}° on the direct line. This way saves ${minutes} min.`
        : `Turns here: slower ground on the direct line. This way saves ${minutes} min.`
  }
  const cell = direct.reduce((best, i) => (t.slope[i] > t.slope[best] ? i : best))
  if (groundDistanceM(t, cells[index], cell) > OBSTACLE_MAX_DISTANCE_M) return null
  const obstacleText = `${deg}° slope: passable but slow`
  return { at, kind: 'slow', text, obstacle: pointOf(t, cell), obstacleText, index, weight, key: `slow ${deg}` }
}

/**
 * Finds every bend of the path worth explaining. Takes the straight line between the ends of a
 * stretch, puts a note on the path cell farthest from it, then looks at the two halves the same way,
 * until a stretch is close enough to straight. `parent` is the nearest note from a longer stretch.
 */
function findDetours(
  t: Terrain,
  m: Mobility,
  profile: RouteProfile,
  cells: number[],
  along: Float64Array,
  from: number,
  to: number,
  parent: Candidate | null,
  out: Candidate[],
) {
  if (to - from < 2 || along[to] - along[from] < DETOUR_MIN_LENGTH_M) return
  let farthest = -1
  let farthestM = DETOUR_OFFSET_M
  for (let k = from + 1; k < to; k++) {
    const d = offsetFromSegment(t, cells[k], cells[from], cells[to])
    if (d > farthestM) {
      farthestM = d
      farthest = k
    }
  }
  if (farthest < 0) return
  const note = explainDetour(t, m, profile, cells, from, to, farthest)
  if (note) {
    // The shorter stretch is nearer the obstacle: it replaces a longer one saying the same thing.
    if (parent && parent.key === note.key) parent.dropped = true
    out.push(note)
  }
  findDetours(t, m, profile, cells, along, from, farthest, note ?? parent, out)
  findDetours(t, m, profile, cells, along, farthest, to, note ?? parent, out)
}

/** Steep stretches on the route itself: runs in the top slope class, bridging single easier cells. */
function findSteep(t: Terrain, cells: number[], levels: (0 | 1 | 2)[], along: Float64Array): Candidate[] {
  const out: Candidate[] = []
  const cellM = (t.cellMetersX + t.cellMetersY) / 2
  const n = cells.length
  for (let a = 0; a < n; a++) {
    if (levels[a] !== 2) continue
    let b = a
    while ((b + 1 < n && levels[b + 1] === 2) || (b + 2 < n && levels[b + 2] === 2)) {
      b += levels[b + 1] === 2 ? 1 : 2
    }
    const lengthM = along[b] - along[a] + cellM
    if (lengthM >= STEEP_MIN_LENGTH_M) {
      let steepest = 0
      for (let k = a; k <= b; k++) steepest = Math.max(steepest, t.slope[cells[k]] / 2)
      const index = (a + b) >> 1
      const deg = Math.round(steepest)
      out.push({
        at: pointOf(t, cells[index]),
        kind: 'steep',
        text: `Steep stretch: up to ${deg}° for ${Math.round(lengthM / 10) * 10} m. Slow down.`,
        index,
        weight: steepest,
        key: `steep ${deg}`,
      })
    }
    a = b
  }
  return out
}

/**
 * Explains a finished leg: notes on why the path bends and where it is steep, and the path cut
 * into runs of equal slope class for colouring, and how many metres of it are in the top slope class.
 * `cells` is the chain of grid cells from the route search; `profile` is what the route was chosen for.
 */
export function explainLeg(
  t: Terrain,
  m: Mobility,
  cells: number[],
  profile: RouteProfile = 'fast',
): { notes: RouteNote[]; sections: RouteSection[]; steepM: number } {
  const n = cells.length
  const levels = cells.map((i) => slopeLevel(m, t.slope[i] / 2))
  // Distance along the path at every cell.
  const along = new Float64Array(n)
  // Each step counts half for the cell it leaves and half for the cell it enters.
  let steepM = 0
  for (let k = 1; k < n; k++) {
    const step = stepM(t, cells[k - 1], cells[k])
    along[k] = along[k - 1] + step
    steepM += step * 0.5 * ((levels[k - 1] === 2 ? 1 : 0) + (levels[k] === 2 ? 1 : 0))
  }

  const sections: RouteSection[] = []
  for (let a = 0; a < n; ) {
    let b = a
    while (b + 1 < n && levels[b + 1] === levels[a]) b++
    // Each run ends on the next run's first point, so the coloured line has no gaps.
    const path = cells.slice(a, Math.min(b + 2, n)).map((i) => pointOf(t, i))
    sections.push({ path, level: levels[a] })
    a = b + 1
  }

  const found: Candidate[] = []
  findDetours(t, m, profile, cells, along, 0, n - 1, null, found)
  // Thin detour notes that crowd each other, most important first.
  const detours: Candidate[] = []
  for (const c of found.filter((c) => !c.dropped).sort(byImportance)) {
    if (detours.every((d) => Math.abs(along[d.index] - along[c.index]) >= NOTE_SPACING_M)) detours.push(c)
  }

  const notes = [...detours, ...findSteep(t, cells, levels, along)]
    .sort(byImportance)
    .slice(0, MAX_NOTES_PER_LEG)
    .sort((p, q) => p.index - q.index)
    .map(({ at, kind, text, obstacle, obstacleText }) =>
      obstacle ? { at, kind, text, obstacle, obstacleText } : { at, kind, text },
    )
  return { notes, sections, steepM }
}
