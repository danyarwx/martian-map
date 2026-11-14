// Shared data shapes. Change these together with the files in public/data and the code that reads them.

/** Planetocentric latitude, east-positive longitude, in degrees. */
export interface LatLon {
  lat: number
  lon: number
}

/** A place the crew can choose to visit. */
export interface Target extends LatLon {
  id: string
  name: string
  /** One line for the list. */
  summary: string
  /** Why go there: the science or mission reason. */
  science: string
  /** What the crew does at the stop. */
  task: string
}

/** Ground-level photo of a stop, from public/data/views/index.json (scripts/fetch_views.py). */
export interface StopView {
  file: string
  sol: number
  camera: string
  imageId: string
  /** How far the rover stood from the stop when it took the photo. */
  distanceM: number
  credit: string
  source: string
}

/** Everything that is specific to one site. A second site is a second one of these plus its data files. */
export interface SiteConfig {
  id: string
  name: string
  scienceGoal: string
  center: LatLon
  zoom: number
  habitat: Target
  targets: Target[]
  /** Files under public/data produced by scripts/build_terrain.py. */
  terrain: { meta: string; slope: string; elev: string; overlay: string }
  /** Index of ground-level photos, keyed by stop id. */
  views: string
}

/** Header written by scripts/build_terrain.py. Row 0 is the northern edge. */
export interface TerrainMeta {
  source: string
  west: number
  south: number
  east: number
  north: number
  width: number
  height: number
  cellMetersX: number
  cellMetersY: number
}

export interface Terrain extends TerrainMeta {
  /** Slope per cell in half degrees, 255 = no data. */
  slope: Uint8Array
  /** Elevation per cell in decimetres, -32768 = no data. */
  elev: Int16Array
}

export type MobilityId = 'walk' | 'rover'

/** How the crew moves. Numbers and their sources are in src/lib/mobility.ts. */
export interface Mobility {
  id: MobilityId
  label: string
  /** Speed on level ground, km/h. */
  flatSpeedKmh: number
  /** Cells steeper than this are never entered. */
  maxSlopeDeg: number
  /** Minutes spent working at each target. */
  stopMinutes: number
  /** Longest allowed time outside, hours. */
  maxEvaHours: number
}

/** A short explanation shown on the route: why it bends here, or what to expect. */
export interface RouteNote {
  /** Where to show it on the route. */
  at: LatLon
  kind: 'no-go' | 'slow' | 'steep'
  /** One short sentence, shown to the astronaut. */
  text: string
  /** The ground the route avoids by turning at `at`. Not on the route. Absent for steep stretches. */
  obstacle?: LatLon
  /** What the obstacle is, for its own label on the map. */
  obstacleText?: string
}

/** A run of the path in one slope class. Consecutive runs share their joint point. */
export interface RouteSection {
  path: LatLon[]
  /** 0 = under half the mobility's slope limit, 1 = up to three quarters of it, 2 = above that. */
  level: 0 | 1 | 2
}

/** One stretch of the route between two stops. */
export interface RouteLeg {
  fromId: string
  toId: string
  path: LatLon[]
  distanceM: number
  minutes: number
  ascentM: number
  descentM: number
  maxSlopeDeg: number
  /** Why the path goes the way it does, in path order. */
  notes: RouteNote[]
  /** The path cut by slope class, for colouring the line. */
  sections: RouteSection[]
}

/**
 * Why a target is left out: nowhere passable to stand within reach of the point itself,
 * or a place to stand but no safe way there from the habitat.
 */
export type UnreachableReason = 'no-footing' | 'no-path'

export interface RoutePlan {
  mobility: MobilityId
  /** Stop ids in visiting order, starting and ending at the habitat. */
  order: string[]
  legs: RouteLeg[]
  /** Targets no safe path reaches. They are left out of the route. */
  unreachable: string[]
  /** Reason per id in `unreachable`. */
  unreachableWhy: Record<string, UnreachableReason>
  /** True when the habitat itself has no passable ground within reach, so nothing can be routed. */
  habitatNoFooting: boolean
  distanceM: number
  /** Moving time only. */
  travelMinutes: number
  /** Time working at stops. */
  stopMinutes: number
  totalMinutes: number
  ascentM: number
  maxSlopeDeg: number
  /** True when the whole trip fits in one excursion for this mobility. */
  fitsOneEva: boolean
}
