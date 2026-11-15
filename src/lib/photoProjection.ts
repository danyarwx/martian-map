// Where a place on the map appears in a Perseverance Navcam photo.
//
// Every cached frame (public/data/frames/index.json, scripts/fetch_frames.py) carries the rover position,
// the rover attitude and the camera's CAHVORE model, the calibration JPL publishes with each raw image.
// A point on the ground goes: lat/lon/elevation -> metres north/east/down of the rover -> rover frame ->
// pixel. The photo itself is never changed; the app draws its markers on top.
import type { LatLon, Terrain } from '../types.ts'
import { MARS_RADIUS_M, inGrid, toCell } from './geo.ts'

export type Vec3 = [number, number, number]

/** JPL CAHVORE camera model (Gennery 2006) in the frame's own pixels, rover frame (x forward, y right, z down). */
export interface CameraModel {
  C: Vec3
  A: Vec3
  H: Vec3
  V: Vec3
  O: Vec3
  R: Vec3
  /** 1 = perspective lens, 0 = fisheye. The Navcams are fisheye. */
  linearity: number
}

/** One cached Navcam frame. */
export interface Frame {
  id: string
  file: string
  sol: number
  /** Where the rover stood: its waypoint, elevation on the same datum as the terrain grid. */
  rover: LatLon & { elev: number }
  /** Unit quaternion (w, x, y, z) turning the rover frame into the site frame (north, east, down). */
  attitude: [number, number, number, number]
  /** Compass direction the camera looks, degrees from north. */
  headingDeg: number
  /** Mast elevation: 0 looks at the horizon, negative looks down. */
  elevationDeg?: number
  /** Pixel size the camera model refers to. */
  width: number
  height: number
  model: CameraModel
  source: string
}

export interface FrameIndex {
  credit: string
  camera: string
  frames: Frame[]
}

const ELEV_NO_DATA = -32768
const RAD = Math.PI / 180
/** Rays further than this from the lens axis are outside the usable picture, even for a fisheye. */
const MAX_OFF_AXIS = 80 * RAD

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Rover frame -> site frame for the attitude quaternion. */
function rotation([w, x, y, z]: Frame['attitude']): number[][] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

/** Metres north, east and down from the rover to a point, with the drop of the horizon on a sphere the size of Mars. */
export function siteOffset(rover: Frame['rover'], p: LatLon, elev: number): Vec3 {
  const north = (p.lat - rover.lat) * RAD * MARS_RADIUS_M
  const east = (p.lon - rover.lon) * RAD * MARS_RADIUS_M * Math.cos(rover.lat * RAD)
  const d2 = north * north + east * east
  return [north, east, rover.elev - elev + d2 / (2 * MARS_RADIUS_M)]
}

/** Pixel of a point given in the rover frame, or null when it is behind or beside the lens. */
export function projectCahvore(m: CameraModel, point: Vec3): { x: number; y: number } | null {
  const d: Vec3 = [point[0] - m.C[0], point[1] - m.C[1], point[2] - m.C[2]]
  const zeta = dot(m.O, d)
  const lam: Vec3 = [d[0] - zeta * m.O[0], d[1] - zeta * m.O[1], d[2] - zeta * m.O[2]]
  const lmag = Math.hypot(...lam)
  const theta = Math.atan2(lmag, zeta)
  if (theta > MAX_OFF_AXIS) return null
  const L = m.linearity
  const chi = L > 1e-9 ? Math.tan(L * theta) / L : L < -1e-9 ? Math.sin(L * theta) / L : theta
  const mu = m.R[0] + m.R[1] * chi ** 2 + m.R[2] * chi ** 4
  const along = chi < 1e-9 ? zeta : lmag / chi
  const v: Vec3 = [
    along * m.O[0] + (1 + mu) * lam[0],
    along * m.O[1] + (1 + mu) * lam[1],
    along * m.O[2] + (1 + mu) * lam[2],
  ]
  const a = dot(m.A, v)
  if (a <= 0) return null
  return { x: dot(m.H, v) / a, y: dot(m.V, v) / a }
}

export interface Projected {
  /** Position in the photo as a share of its width and height (0..1 inside the picture). */
  x: number
  y: number
  inFrame: boolean
  /** Ground distance from the rover, metres. */
  distanceM: number
}

/** Where a point on the ground (`elev` metres) appears in a frame, or null when the camera cannot see that way. */
export function projectPoint(f: Frame, p: LatLon, elev: number): Projected | null {
  const s = siteOffset(f.rover, p, elev)
  const r = rotation(f.attitude)
  // Site -> rover frame is the transpose of the attitude rotation.
  const rover: Vec3 = [
    r[0][0] * s[0] + r[1][0] * s[1] + r[2][0] * s[2],
    r[0][1] * s[0] + r[1][1] * s[1] + r[2][1] * s[2],
    r[0][2] * s[0] + r[1][2] * s[1] + r[2][2] * s[2],
  ]
  const px = projectCahvore(f.model, rover)
  if (!px) return null
  const x = px.x / f.width
  const y = px.y / f.height
  return { x, y, inFrame: x >= 0 && x <= 1 && y >= 0 && y <= 1, distanceM: Math.hypot(s[0], s[1]) }
}

/** Ground elevation of a point from the terrain grid, metres, or null where the grid has no data. */
export function groundElev(t: Terrain, p: LatLon): number | null {
  const { col, row } = toCell(t, p)
  if (!inGrid(t, col, row)) return null
  const e = t.elev[row * t.width + col]
  return e === ELEV_NO_DATA ? null : e / 10
}

/**
 * True when nothing in the terrain grid rises above the straight line between the two points,
 * each `aboveM` metres above its ground (the camera mast, a person's height). Curvature included.
 */
export function lineOfSight(t: Terrain, from: LatLon & { elev: number }, to: LatLon & { elev: number }, fromAboveM: number, toAboveM: number): boolean {
  const north = (to.lat - from.lat) * RAD * MARS_RADIUS_M
  const east = (to.lon - from.lon) * RAD * MARS_RADIUS_M * Math.cos(from.lat * RAD)
  const dist = Math.hypot(north, east)
  const step = Math.min(t.cellMetersX, t.cellMetersY) / 2
  const z0 = from.elev + fromAboveM
  const z1 = to.elev + toAboveM
  // Skip the cells right next to either end: they are the ground the camera and the person stand on.
  for (let d = 15; d < dist - 15; d += step) {
    const k = d / dist
    const e = groundElev(t, { lat: from.lat + (to.lat - from.lat) * k, lon: from.lon + (to.lon - from.lon) * k })
    if (e === null) continue
    const line = z0 + (z1 - z0) * k
    // The ray is straight, the ground curves away beneath it: compare against the ground's drop.
    const drop = (d * (dist - d)) / (2 * MARS_RADIUS_M)
    if (e - drop > line) return false
  }
  return true
}

/** Height of the Navcam above the ground under the rover, metres (rover frame C is about 1.9 m up). */
export const NAVCAM_HEIGHT_M = 1.9
/** Height marked above a place: about a standing person, so the marker shows where the crew would be. */
export const MARK_HEIGHT_M = 1.0
/** The rover stood "at" a stop when it was this close: the photo is then a view from the stop itself. */
export const AT_STOP_M = 40
/** Frames from further away than this are not used to show a stop: it would be a speck. */
export const MAX_VIEW_M = 1500

export interface FrameChoice {
  frame: Frame
  /** 'here': the rover stood at the stop, the photo shows the view from it. 'toward': the photo looks at the stop. */
  mode: 'here' | 'toward'
  /** Rover distance from the stop, metres. */
  distanceM: number
  /** The stop's own marker, for 'toward'. */
  mark?: Projected & { visible: boolean }
}

/**
 * Frames that show a stop, best first.
 * 'here' frames (rover within AT_STOP_M) come first, ordered by how many `lookAt` places they face,
 * then by how level the camera looks.
 * Then 'toward' frames that have the stop in the picture: in clear view before hidden behind a rise,
 * then nearer, then closer to the middle of the picture.
 */
export function framesFor(frames: Frame[], t: Terrain, stop: LatLon, lookAt: LatLon[] = []): FrameChoice[] {
  const stopElev = groundElev(t, stop)
  if (stopElev === null) return []
  const here: (FrameChoice & { score: number })[] = []
  const toward: (FrameChoice & { score: number })[] = []
  for (const f of frames) {
    const s = siteOffset(f.rover, stop, stopElev)
    const distanceM = Math.hypot(s[0], s[1])
    if (distanceM > MAX_VIEW_M) continue
    if (distanceM <= AT_STOP_M) {
      const faced = lookAt.filter((p) => {
        const e = groundElev(t, p)
        return e !== null && projectPoint(f, p, e + MARK_HEIGHT_M)?.inFrame
      }).length
      // Facing the places that matter first, then looking out rather than down at the ground, then nearest.
      const down = Math.abs((f.elevationDeg ?? -4) + 4)
      here.push({ frame: f, mode: 'here', distanceM, score: -faced * 1000 + down * 10 + distanceM })
      continue
    }
    const mark = projectPoint(f, stop, stopElev + MARK_HEIGHT_M)
    if (!mark || !mark.inFrame || mark.x < 0.05 || mark.x > 0.95 || mark.y < 0.05 || mark.y > 0.95) continue
    const visible = lineOfSight(t, f.rover, { ...stop, elev: stopElev }, NAVCAM_HEIGHT_M, MARK_HEIGHT_M)
    const offCentre = Math.hypot(mark.x - 0.5, mark.y - 0.5)
    toward.push({ frame: f, mode: 'toward', distanceM, mark: { ...mark, visible }, score: (visible ? 0 : 1e6) + distanceM + offCentre * 400 })
  }
  const byScore = (a: { score: number }, b: { score: number }) => a.score - b.score
  return [...here.sort(byScore), ...toward.sort(byScore)].map(({ score: _score, ...c }) => c)
}

export interface Landmark extends LatLon {
  id: string
  name: string
}

export interface PlacedLandmark extends Projected {
  id: string
  name: string
  visible: boolean
}

/** The places that fall inside a frame, with their position and whether the ground hides them. Nearer than 15 m is left out. */
export function placeLandmarks(f: Frame, t: Terrain, places: Landmark[]): PlacedLandmark[] {
  const out: PlacedLandmark[] = []
  for (const p of places) {
    const e = groundElev(t, p)
    if (e === null) continue
    const at = projectPoint(f, p, e + MARK_HEIGHT_M)
    if (!at || !at.inFrame || at.distanceM < 15) continue
    out.push({ ...at, id: p.id, name: p.name, visible: lineOfSight(t, f.rover, { ...p, elev: e }, NAVCAM_HEIGHT_M, MARK_HEIGHT_M) })
  }
  return out
}
