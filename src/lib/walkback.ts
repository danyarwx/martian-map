// Walking time straight back to the habitat from anywhere on the map: the "walk-back" safety rule.
import type { Target, Terrain, WalkBackImage } from '../types.ts'
import { buildCostGrid, snapToPassable, timeField } from './astar.ts'
import { cellCenter, toCell } from './geo.ts'
import { MOBILITY } from './mobility.ts'
import { WALK_BACK_RESERVE_MIN } from './safety.ts'

/** Lines drawn on the map, minutes of walking from the habitat. The reserve itself is the strong one. */
export const WALK_BACK_LINES_MIN = [WALK_BACK_RESERVE_MIN / 2, WALK_BACK_RESERVE_MIN, WALK_BACK_RESERVE_MIN * 1.5]

/**
 * Seconds on foot back to the habitat for every cell, Infinity where no safe walking path exists.
 * Always for a crew on foot, whatever they set out with: after a rover failure they walk.
 */
export function walkHomeSeconds(t: Terrain, habitat: Target): Float32Array {
  const cost = buildCostGrid(t, MOBILITY.walk)
  const { col, row } = toCell(t, habitat)
  const start = snapToPassable(cost, t.width, t.height, col, row)
  return timeField(cost, t.width, t.height, t.cellMetersX, t.cellMetersY, start)
}

/** Draws the lines of equal walk-back time: the reserve in green, the half and one-and-a-half lines in white. */
export function walkBackImage(t: Terrain, homeSec: Float32Array): WalkBackImage {
  const { width, height } = t
  const rgba = new Uint8ClampedArray(width * height * 4)
  const band = (i: number) => {
    const min = homeSec[i] / 60
    let b = 0
    while (b < WALK_BACK_LINES_MIN.length && min >= WALK_BACK_LINES_MIN[b]) b++
    return b
  }
  const paint = (i: number, line: number) => {
    const o = i * 4
    const reserve = line === 1
    rgba[o] = reserve ? 126 : 255
    rgba[o + 1] = reserve ? 226 : 255
    rgba[o + 2] = reserve ? 160 : 255
    rgba[o + 3] = reserve ? 255 : 150
  }
  /** Northernmost cell of each line, for its label. */
  const top: number[] = WALK_BACK_LINES_MIN.map(() => -1)
  for (let r = 0; r < height - 1; r++) {
    for (let c = 0; c < width - 1; c++) {
      const i = r * width + c
      if (homeSec[i] === Infinity) continue
      const b = band(i)
      for (const nb of [i + 1, i + width]) {
        if (homeSec[nb] === Infinity) continue
        const other = band(nb)
        if (other === b) continue
        const line = Math.min(b, other) // the line between band k and k+1 is line k
        paint(i, line)
        if (line === 1) paint(nb, line) // the reserve line is two cells wide
        if (top[line] < 0) top[line] = i
      }
    }
  }
  const labels = WALK_BACK_LINES_MIN.flatMap((minutes, k) =>
    top[k] < 0 ? [] : [{ minutes, at: cellCenter(t, top[k] % width, (top[k] / width) | 0) }],
  )
  return { width, height, rgba, labels }
}
