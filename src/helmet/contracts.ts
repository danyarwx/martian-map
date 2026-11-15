// Shapes shared between the helmet modules (docs/helmet/PLAN.md §4.3).
// Change only after a note in docs/helmet/STATUS.md: world/, sim/, cv/, mapping/, nav/ and hud/ all rely on them.
import type { LatLon, RoutePlan } from '../types.ts'

/** 0 unseen, 1 safe, 2 rock, 3 sand, 4 steep, 5 drop. */
export type HazardClass = 0 | 1 | 2 | 3 | 4 | 5

export const HAZARD = { unseen: 0, safe: 1, rock: 2, sand: 3, steep: 4, drop: 5 } as const

/** Eye position in local ENU metres (see frames.ts) and where the head points. */
export interface Pose {
  x: number
  y: number
  z: number
  /** Degrees clockwise from north. */
  headingDeg: number
  /** Degrees, positive looking up. */
  pitchDeg: number
  /**
   * Camera roll about its viewing direction, degrees; positive = the camera's right side lower. Absent = level,
   * which is what the helmet's own cameras are. Only the CV reads it (a real rover photo is rarely level).
   */
  rollDeg?: number
}

/** Pinhole model shared by both cameras of a rectified stereo pair. */
export interface StereoIntrinsics {
  width: number
  height: number
  fx: number
  fy: number
  cx: number
  cy: number
  /** Distance between the two camera centres, metres. */
  baselineM: number
}

/** Ground heights on 0.5 m cells aligned to the hazard grid. */
export interface HeightGrid {
  /** Local ENU of the north-west corner. */
  x0: number
  y0: number
  cols: number
  rows: number
  /** Height per cell (row-major, row 0 north), metres; NaN = unknown. */
  z: Float32Array
}

/** One stereo frame, main thread → CV worker. Images are rectified: same intrinsics, parallel axes. */
export interface CvFrame {
  id: number
  /** Grayscale, width × height, row-major. */
  left: Uint8Array
  right: Uint8Array
  /** RGB of the left image (3 bytes per pixel), for sand texture and colour. */
  rgbLeft?: Uint8Array
  intr: StereoIntrinsics
  /** Pose of the LEFT camera. */
  pose: Pose
  /**
   * Ground heights the helmet has already fused from earlier frames, around the astronaut (PLAN §5.6). They fill
   * the cells this frame cannot see, so a drop-off is found from what several frames saw of its two sides.
   * These are the CV's own earlier outputs, never the world's truth.
   */
  heights?: HeightGrid
}

export interface Detection {
  kind: 'rock' | 'sand' | 'steep' | 'drop'
  /** Centre in local ENU metres. */
  x: number
  y: number
  radiusM: number
  heightM?: number
  slopeDeg?: number
  /** From the camera, metres. */
  distanceM: number
  /** 0 to 1. */
  confidence: number
  /** Pixel box in the left image: x, y, width, height. */
  bbox?: [number, number, number, number]
  /**
   * Rocks only. 'hazard' = taller than the 0.30 m step height: it blocks the route. 'small' = 0.10–0.30 m: a trip
   * risk that is shown but never becomes a HAZARD.rock cell. Absent = hazard.
   */
  level?: 'hazard' | 'small'
  /** Outline in the left image as a closed polygon: x0, y0, x1, y1, … pixels. */
  outline?: number[]
  /** Ground height under the detection, local ENU metres (the CV's own ground fit). */
  groundZ?: number
}

/** A local hazard patch in 0.5 m cells, aligned to the hazard grid. Row 0 is the northern edge. */
export interface HazardPatch {
  /** Local ENU of the patch's north-west corner. */
  x0: number
  y0: number
  cols: number
  rows: number
  cls: Uint8Array
  conf: Float32Array
}

/** CV worker → main thread. */
export interface CvResult {
  id: number
  /** Worker time for this frame. */
  ms: number
  /** Per pixel of the left image, NaN = no match. For the CV view. */
  disparity: Float32Array
  detections: Detection[]
  patch: HazardPatch
  /** This frame's ground height per patch cell (same layout as `patch`), metres, NaN = not seen. For the fused grid. */
  groundZ?: Float32Array
}

/** What Mission control hands to the helmet. */
export interface HelmetEntry {
  plan: RoutePlan
  /** Where the astronaut starts (the jump point). Also the origin of the local ENU frame. */
  startAt: LatLon
  /** Leg of `plan.legs` the start point is on. */
  legIndex: number
}

/** What the helmet hands back to Mission control on exit. */
export interface HelmetExit {
  seen: { bounds: { west: number; south: number; east: number; north: number }; png: string } | null
  hazards: { at: LatLon; kind: Detection['kind']; radiusM: number }[]
  /** The plan after any re-route, or null when it did not change. */
  plan: RoutePlan | null
  /** Minutes the helmet's last re-route added to the trip (negative = shorter). Absent when it did not re-route. */
  rerouteDeltaMin?: number
}
