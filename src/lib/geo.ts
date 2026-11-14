import type { LatLon, TerrainMeta } from '../types.ts'

/** Mean radius of Mars in metres. */
export const MARS_RADIUS_M = 3389500

const RAD = Math.PI / 180

/** Great-circle distance on Mars, metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * MARS_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Grid column/row holding a point. Row 0 is the northern edge. May be outside the grid. */
export function toCell(t: TerrainMeta, p: LatLon): { col: number; row: number } {
  return {
    col: Math.floor(((p.lon - t.west) / (t.east - t.west)) * t.width),
    row: Math.floor(((t.north - p.lat) / (t.north - t.south)) * t.height),
  }
}

/** Centre of a grid cell. */
export function cellCenter(t: TerrainMeta, col: number, row: number): LatLon {
  return {
    lon: t.west + ((col + 0.5) / t.width) * (t.east - t.west),
    lat: t.north - ((row + 0.5) / t.height) * (t.north - t.south),
  }
}

export function inGrid(t: TerrainMeta, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < t.width && row < t.height
}
