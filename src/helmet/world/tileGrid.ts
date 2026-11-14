// The fixed 128 m tile grid of public/data/helmet/index.json (scripts/build_helmet_tiles.py). Pure: no three.js.
//
// Tile (row, col) spans lon [origin.lon + col·tileDegLon, + tileDegLon] and lat [origin.lat − (row+1)·tileDegLat,
// origin.lat − row·tileDegLat]; row 0 is the northern edge, like every grid in the app. Elevation samples are
// 129 × 129 with shared edges: sample (i, j) sits at west + j/128 and north − i/128 of the tile, in degrees.
import { MARS_RADIUS_M } from '../../lib/geo.ts'
import type { LatLon } from '../../types.ts'

/** Samples along one side of a tile (shared edges). */
export const SAMPLES = 129
/** Sample intervals along one side. */
export const CELLS = SAMPLES - 1

const RAD = Math.PI / 180

export interface TileEntry {
  id: string
  row: number
  col: number
  west: number
  south: number
  east: number
  north: number
  /** Metres (areoid). Samples are centimetres above this. */
  zMin: number
  /** Paths relative to /data/helmet/. */
  file: string
  ortho: string
  sand: string
  sandFrac?: number
}

export interface TileWindow {
  /** Stop id (or 'habitat'). */
  id: string
  tiles: string[]
}

/** The grid part of index.json: enough to find tiles and place samples. */
export interface TileGridSpec {
  origin: LatLon
  tileDegLat: number
  tileDegLon: number
  tileSizeM: number
  /** Latitude the builder used for metres per degree of longitude. */
  scaleLat: number
}

export interface TileIndex extends TileGridSpec {
  sampleM: number
  samples: number
  orthoMPerPx: number
  orthoPx: number
  sandMPerPx: number
  sandPx: number
  tiles: TileEntry[]
  windows: TileWindow[]
}

export function tileId(row: number, col: number): string {
  const pad = (n: number) => (n < 0 ? '-' + String(-n).padStart(4, '0') : String(n).padStart(4, '0'))
  return `r${pad(row)}_c${pad(col)}`
}

/** Numeric key for maps, valid for rows and columns in −5000..5000. */
export function tileKey(row: number, col: number): number {
  return (row + 5000) * 10000 + (col + 5000)
}

/** Row and column of the tile holding `p`. May lie outside the tiled area. */
export function tileOf(lat: number, lon: number, g: TileGridSpec): { row: number; col: number } {
  return {
    row: Math.floor((g.origin.lat - lat) / g.tileDegLat),
    col: Math.floor((lon - g.origin.lon) / g.tileDegLon),
  }
}

export function tileBounds(row: number, col: number, g: TileGridSpec): { west: number; south: number; east: number; north: number } {
  const west = g.origin.lon + col * g.tileDegLon
  const north = g.origin.lat - row * g.tileDegLat
  return { west, east: west + g.tileDegLon, north, south: north - g.tileDegLat }
}

/** Fractional sample coordinates of a point inside tile (row, col): `j` along east, `i` along south, 0..128. */
export function sampleCoords(lat: number, lon: number, row: number, col: number, g: TileGridSpec): { i: number; j: number } {
  const b = tileBounds(row, col, g)
  return { j: ((lon - b.west) / g.tileDegLon) * CELLS, i: ((b.north - lat) / g.tileDegLat) * CELLS }
}

/** Tile heights in metres from the int16 centimetres-above-zMin file. */
export function decodeTileHeights(data: ArrayBuffer | Int16Array, zMin: number): Float32Array {
  const raw = data instanceof Int16Array ? data : new Int16Array(data)
  if (raw.length !== SAMPLES * SAMPLES) throw new Error(`tile has ${raw.length} samples, expected ${SAMPLES * SAMPLES}`)
  const h = new Float32Array(raw.length)
  for (let k = 0; k < raw.length; k++) h[k] = zMin + raw[k] / 100
  return h
}

/** Bilinear sample of a 129 × 129 height array at fractional (i, j), clamped to the tile. */
export function bilinear129(h: Float32Array, i: number, j: number): number {
  const ci = Math.min(CELLS, Math.max(0, i))
  const cj = Math.min(CELLS, Math.max(0, j))
  const i0 = Math.min(CELLS - 1, Math.floor(ci))
  const j0 = Math.min(CELLS - 1, Math.floor(cj))
  const fi = ci - i0
  const fj = cj - j0
  const k = i0 * SAMPLES + j0
  const a = h[k] + (h[k + 1] - h[k]) * fj
  const b = h[k + SAMPLES] + (h[k + SAMPLES + 1] - h[k + SAMPLES]) * fj
  return a + (b - a) * fi
}

/**
 * Metres east and south of the grid anchor, independent of the session origin. Used to seed procedural
 * detail (micro-relief) so it looks the same whatever point the helmet session started from.
 */
export function anchorMetres(lat: number, lon: number, g: TileGridSpec): { e: number; s: number } {
  return {
    e: (lon - g.origin.lon) * RAD * MARS_RADIUS_M * Math.cos(g.scaleLat * RAD),
    s: (g.origin.lat - lat) * RAD * MARS_RADIUS_M,
  }
}
