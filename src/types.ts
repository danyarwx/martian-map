// Shared data formats. Every part of the app (map, route planner, helmet view) talks in these types.
// Change them only after agreeing with the rest of the team: they are the contract between folders.

/** Planetocentric latitude, east-positive longitude, in degrees. */
export type LatLon = { lat: number; lon: number }

/** Something to keep away from. Orbit hazards come from the data layers; helmet hazards are found during the walk. */
export type Hazard = LatLon & {
  id: string
  /** Radius of the no-go circle, in metres. */
  radiusM: number
  kind: 'rock' | 'sand' | 'slope'
  source: 'orbit' | 'helmet'
  /** 0 to 1. */
  confidence: number
  /** Short text for the map tooltip and the helmet alert. */
  label?: string
}

/** A 360° equirectangular panorama: left edge = azimuth 0° (north), one row = constant elevation. */
export type Panorama = {
  /** URL the browser loads, e.g. /data/panoramas/navcam_sol1210.jpg */
  url: string
  columns: number
  rows: number
  /** Image row of the horizon (elevation 0°), counted from the top. */
  elZeroRow: number
}

/** A place on the walk. Rover stops carry the sol they were visited and their panorama. */
export type Stop = LatLon & {
  id: string
  name: string
  kind: 'habitat' | 'stop' | 'target'
  sol?: number
  /** Rover tilt at this stop, in degrees. A rough slope hint. */
  tiltDeg?: number
  panorama?: Panorama
}

/** Where the astronaut is and which way they face (degrees clockwise from north). */
export type AstronautPose = LatLon & { headingDeg: number }

export type SuitStatus = {
  oxygenPct: number
  evaSecondsLeft: number
  doseMicroSv: number
}
