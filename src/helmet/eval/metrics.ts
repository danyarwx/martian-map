// Scoring of the eval harness (docs/helmet/PLAN.md T4.4). Pure: no DOM, no three.js.
import { HAZARD, type Detection, type HazardPatch } from '../contracts.ts'
import { GRID_CELL_M } from '../frames.ts'

/** A rock of the simulated world, as the eval sees it. */
export interface TruthRock {
  x: number
  y: number
  /** Diameter, metres. */
  d: number
  /** Height standing above the ground, metres: h · (1 − BURY). */
  standM: number
}

/** A rock counts as an obstacle from this standing height, metres (the CV's step height). */
export const ROCK_MIN_STAND_M = 0.3
/** Rocks and detections are scored between these distances from the camera, metres. */
export const ROCK_NEAR_M = 2
export const ROCK_FAR_M = 12

/** A detection matches a rock when their centres are within this, metres. */
export function matchRadius(r: TruthRock): number {
  return Math.max(0.75, r.d / 2 + 0.5)
}

export interface RockScore {
  truth: number
  found: number
  /** Which of `visible` were found. */
  foundFlags: boolean[]
  /** Rock detections 2–12 m from the camera. */
  detections: number
  detectionsTrue: number
  /** Which of the scored detections sit on a rock. */
  trueFlags: boolean[]
  scored: Detection[]
  /** Scored detections that are not on a ≥ 0.30 m rock but have a 0.20–0.30 m rock under them. */
  onLowRock: number
}

/**
 * `visible`: rocks standing ≥ 0.30 m, 2–12 m away, in view. `nearby`: every rock around the camera (any height),
 * so a detection of a real rock just outside the frame or the range is not called false.
 * Recall = visible rocks with a rock detection within matchRadius. Precision = rock detections 2–12 m away with a
 * rock standing ≥ 0.30 m within matchRadius.
 */
export function scoreRocks(visible: readonly TruthRock[], nearby: readonly TruthRock[], detections: readonly Detection[]): RockScore {
  const rocks = detections.filter((d) => d.kind === 'rock')
  const near = (r: TruthRock, d: Detection) => Math.hypot(d.x - r.x, d.y - r.y) <= matchRadius(r)
  const foundFlags = visible.map((r) => rocks.some((d) => near(r, d)))
  const scored = rocks.filter((d) => d.distanceM >= ROCK_NEAR_M && d.distanceM <= ROCK_FAR_M)
  const trueFlags = scored.map((d) => nearby.some((r) => r.standM >= ROCK_MIN_STAND_M && near(r, d)))
  let onLowRock = 0
  scored.forEach((d, k) => {
    if (!trueFlags[k] && nearby.some((r) => r.standM >= 0.2 && r.standM < ROCK_MIN_STAND_M && near(r, d))) onLowRock++
  })
  return {
    truth: visible.length,
    found: foundFlags.filter(Boolean).length,
    foundFlags,
    detections: scored.length,
    detectionsTrue: trueFlags.filter(Boolean).length,
    trueFlags,
    scored,
    onLowRock,
  }
}

export interface RockCellScore {
  /** Which of `visible` have a rock cell of the hazard patch on or beside them. */
  foundFlags: boolean[]
  /** Rock cells 2–12 m from the camera, and those of them at a rock standing ≥ 0.30 m. */
  cells: number
  cellsTrue: number
}

/**
 * The same question asked of the hazard patch instead of the detections: is each rock marked on the map, and is
 * each rock cell at a rock? Neighbouring boulders that the CV reports as one wide detection (its centre between
 * them, far from each) count here, because the map is what the walker is steered by.
 */
export function scoreRockCells(visible: readonly TruthRock[], nearby: readonly TruthRock[], patch: HazardPatch, cam: { x: number; y: number }): RockCellScore {
  const cx: number[] = []
  const cy: number[] = []
  for (let k = 0; k < patch.cls.length; k++) {
    if (patch.cls[k] !== HAZARD.rock) continue
    const r = (k / patch.cols) | 0
    cx.push(patch.x0 + (k - r * patch.cols + 0.5) * GRID_CELL_M)
    cy.push(patch.y0 - (r + 0.5) * GRID_CELL_M)
  }
  const foundFlags = visible.map((r) => cx.some((x, k) => Math.hypot(x - r.x, cy[k] - r.y) <= matchRadius(r)))
  let cells = 0
  let cellsTrue = 0
  for (let k = 0; k < cx.length; k++) {
    const dist = Math.hypot(cx[k] - cam.x, cy[k] - cam.y)
    if (dist < ROCK_NEAR_M || dist > ROCK_FAR_M) continue
    cells++
    if (nearby.some((r) => r.standM >= ROCK_MIN_STAND_M && Math.hypot(cx[k] - r.x, cy[k] - r.y) <= matchRadius(r))) cellsTrue++
  }
  return { foundFlags, cells, cellsTrue }
}

export function median(values: ArrayLike<number>): number {
  if (!values.length) return NaN
  const s = Array.from(values).sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function mean(values: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < values.length; i++) s += values[i]
  return values.length ? s / values.length : NaN
}

export function rms(values: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < values.length; i++) s += values[i] * values[i]
  return values.length ? Math.sqrt(s / values.length) : NaN
}
