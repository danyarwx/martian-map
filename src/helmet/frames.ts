// Coordinate frames for the helmet (docs/helmet/PLAN.md §4.2). Only this file converts between them.
//
// - Geographic: LatLon, planetocentric, east-positive longitude.
// - Local ENU: metres from the session origin; x east, y north, z up. Equirectangular on the Mars sphere,
//   which is accurate to well under a centimetre over the couple of kilometres a helmet session covers.
// - three.js world: y up. A local point (x, y, z) is three (x, z, −y), so north is −z.
// - Hazard grid: 0.5 m cells, row 0 at the northern edge (like the planner grid).
import { MARS_RADIUS_M } from '../lib/geo.ts'
import type { LatLon } from '../types.ts'

const RAD = Math.PI / 180

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Local ENU metres (x east, y north) of `p` around `origin`. */
export function toLocal(p: LatLon, origin: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - origin.lon) * RAD * MARS_RADIUS_M * Math.cos(origin.lat * RAD),
    y: (p.lat - origin.lat) * RAD * MARS_RADIUS_M,
  }
}

/** Inverse of `toLocal`. */
export function toLatLon(x: number, y: number, origin: LatLon): LatLon {
  return {
    lat: origin.lat + y / MARS_RADIUS_M / RAD,
    lon: origin.lon + x / (MARS_RADIUS_M * Math.cos(origin.lat * RAD)) / RAD,
  }
}

/** Local ENU → three.js world coordinates. */
export function localToThree(p: Vec3): Vec3 {
  return { x: p.x, y: p.z, z: -p.y }
}

/** three.js world → local ENU. */
export function threeToLocal(p: Vec3): Vec3 {
  return { x: p.x, y: -p.z, z: p.y }
}

/** Unit view direction in local ENU for a heading (clockwise from north) and pitch (up positive), degrees. */
export function headingToDir(headingDeg: number, pitchDeg = 0): Vec3 {
  const h = headingDeg * RAD
  const p = pitchDeg * RAD
  return { x: Math.sin(h) * Math.cos(p), y: Math.cos(h) * Math.cos(p), z: Math.sin(p) }
}

/** Heading in degrees (0..360, clockwise from north) of a local ENU direction. */
export function dirToHeading(dx: number, dy: number): number {
  return ((Math.atan2(dx, dy) / RAD) % 360 + 360) % 360
}

/** Size of a hazard grid cell, metres. */
export const GRID_CELL_M = 0.5

/**
 * Column and row of the 0.5 m hazard-grid cell holding local point (x, y), for a grid whose
 * north-west corner is at local (x0, y0). Row 0 is the northern edge.
 */
export function gridIndex(x: number, y: number, x0: number, y0: number, cellM = GRID_CELL_M): { col: number; row: number } {
  return { col: Math.floor((x - x0) / cellM), row: Math.floor((y0 - y) / cellM) }
}

/** Local ENU centre of a hazard-grid cell. */
export function gridCellCenter(col: number, row: number, x0: number, y0: number, cellM = GRID_CELL_M): { x: number; y: number } {
  return { x: x0 + (col + 0.5) * cellM, y: y0 - (row + 0.5) * cellM }
}
