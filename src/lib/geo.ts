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

/** The rectangle that has elevation data. `TerrainMeta` fits. */
export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

export function inBounds(b: Bounds, p: LatLon): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east
}

/** Bounds as shown to the user: three decimals, rounded inwards so every shown value is allowed. */
const shownMin = (v: number) => (Math.ceil(v * 1000) / 1000).toFixed(3)
const shownMax = (v: number) => (Math.floor(v * 1000) / 1000).toFixed(3)

/**
 * Checks coordinates typed by the user. Gives back the point, or a sentence saying what is wrong.
 * Without bounds (terrain header not loaded yet) only the numbers themselves are checked.
 */
export function parsePoint(
  b: Bounds | null,
  lat: string,
  lon: string,
): { ok: true; point: LatLon } | { ok: false; error: string } {
  const read = (text: string) => (text.trim() === '' ? NaN : Number(text))
  const point = { lat: read(lat), lon: read(lon) }
  const check = (value: number, name: string, min?: number, max?: number) => {
    if (!Number.isFinite(value)) return `${name} must be a number.`
    if (min !== undefined && max !== undefined && (value < min || value > max)) {
      return `${name} must be between ${shownMin(min)} and ${shownMax(max)}.`
    }
    return null
  }
  const error = check(point.lat, 'Latitude', b?.south, b?.north) ?? check(point.lon, 'Longitude', b?.west, b?.east)
  return error ? { ok: false, error } : { ok: true, point }
}
