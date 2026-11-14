// The 60 fixed camera poses of the eval harness (docs/helmet/PLAN.md T4.4). Pure and deterministic: the same
// poses on every run, from routes.json and the tile index only.
//
// Per demo window (the six stops and the habitat) eight poses:
//   4 "boulders": 6, 8, 10 and 12 m before the window's demo boulder field, on or beside the path, looking at
//      the middle of the field;
//   4 "leg": on the approach path 40, 110, 170 and 330 m before the stop, looking along the path, 35° to either
//      side of it, or across it.
// The first four windows get a fifth leg pose 450 m before the stop, looking back: 7 × 8 + 4 = 60.
// Pitch is between −10° and −15° (looking a little down, like someone watching where they walk).
import type { LatLon } from '../../types.ts'
import { dirToHeading, headingToDir, toLatLon, toLocal } from '../frames.ts'
import { cumulativeM, pointAtDistance } from '../world/path.ts'
import { demoBoulderFields, type DemoField } from '../world/rocks.ts'
import { approachPath, type RoutesFileLeg } from '../world/routes.ts'
import type { TileWindow } from '../world/tileGrid.ts'

export interface EvalPose {
  id: string
  window: string
  kind: 'boulders' | 'leg'
  at: LatLon
  headingDeg: number
  pitchDeg: number
}

export interface EvalWindow {
  id: string
  /** Session origin used for this window: the middle of its demo boulder field. */
  origin: LatLon
  field: DemoField
  poses: EvalPose[]
}

const BOULDER_POSES: { back: number; side: number; pitch: number }[] = [
  { back: 6, side: 0, pitch: -15 },
  { back: 8, side: -2.5, pitch: -13 },
  { back: 10, side: 2.5, pitch: -12 },
  { back: 12, side: 0, pitch: -10 },
]
const LEG_POSES: { before: number; yaw: number; pitch: number }[] = [
  { before: 40, yaw: 0, pitch: -12 },
  { before: 110, yaw: 35, pitch: -10 },
  { before: 170, yaw: -35, pitch: -15 },
  { before: 330, yaw: 90, pitch: -13 },
  { before: 450, yaw: 180, pitch: -11 },
]
/** Windows that get the fifth leg pose. */
const EXTRA = 4
export const EVAL_POSES = 60

export function evalWindows(windows: readonly TileWindow[], legs: readonly RoutesFileLeg[]): EvalWindow[] {
  const sorted = [...windows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const fields = demoBoulderFields(sorted, legs)
  const out: EvalWindow[] = []
  sorted.forEach((w, wi) => {
    const field = fields.find((f) => f.stopId === w.id)
    const ap = approachPath(w.id, legs)
    if (!field || !ap) return
    const poses: EvalPose[] = []
    const fwd = headingToDir(field.headingDeg)
    const right = headingToDir(field.headingDeg + 90)
    BOULDER_POSES.forEach((b, k) => {
      const x = -fwd.x * b.back + right.x * b.side
      const y = -fwd.y * b.back + right.y * b.side
      poses.push({ id: `${w.id}/boulders-${k + 1}`, window: w.id, kind: 'boulders', at: toLatLon(x, y, field.center), headingDeg: dirToHeading(-x, -y), pitchDeg: b.pitch })
    })
    const cum = cumulativeM(ap.path)
    const total = cum[cum.length - 1]
    LEG_POSES.slice(0, wi < EXTRA ? 5 : 4).forEach((l, k) => {
      const p = pointAtDistance(ap.path, Math.max(5, total - l.before), cum)
      poses.push({ id: `${w.id}/leg-${k + 1}`, window: w.id, kind: 'leg', at: p.at, headingDeg: (p.headingDeg + l.yaw + 360) % 360, pitchDeg: l.pitch })
    })
    out.push({ id: w.id, origin: field.center, field, poses })
  })
  return out
}

/** Local ENU of a pose in its window's frame. */
export function poseLocal(p: EvalPose, w: EvalWindow): { x: number; y: number } {
  return toLocal(p.at, w.origin)
}
