// Ground height under any local ENU point (docs/helmet/PLAN.md §6.2). Pure: no three.js, runs in Node tests.
//
// Where a tile is loaded (the real 1 m HiRISE DTM, or a coarse tile built from the 10 m grid plus micro-relief)
// heights are bilinear over that tile's 129 × 129 samples, which are exactly the vertices the mesh is built from.
// Elsewhere they fall back to the 10 m planner grid (src/lib/terrain.ts), bilinear between cell centres.
// Heights are metres above the areoid (the DTM's datum), so local z is absolute elevation, not height above
// the start point.
import type { LatLon, Terrain, TerrainMeta } from '../../types.ts'
import { toLatLon } from '../frames.ts'
import { microRelief } from './noise.ts'
import { anchorMetres, bilinear129, CELLS, SAMPLES, sampleCoords, tileBounds, tileKey, type TileGridSpec } from './tileGrid.ts'

/** The 10 m grid as metres, with its no-data cells filled so it can be drawn and sampled everywhere. */
export interface CoarseGrid {
  meta: TerrainMeta
  /** Metres, row 0 north. No-data filled from the nearest valid cell of the same row. */
  elevM: Float32Array
  /** 1 where the source had no data. */
  noData: Uint8Array
}

const NO_DATA = -32768

export function makeCoarseGrid(t: Pick<Terrain, keyof TerrainMeta | 'elev'>): CoarseGrid {
  const { width: w, height: h } = t
  const elevM = new Float32Array(w * h)
  const noData = new Uint8Array(w * h)
  let sum = 0
  let n = 0
  for (let k = 0; k < w * h; k++) {
    const v = t.elev[k]
    if (v === NO_DATA) noData[k] = 1
    else {
      elevM[k] = v / 10
      sum += v / 10
      n++
    }
  }
  const mean = n ? sum / n : 0
  for (let r = 0; r < h; r++) {
    const o = r * w
    let lastValid = -1
    for (let c = 0; c < w; c++) {
      if (noData[o + c]) continue
      // fill the gap before this valid cell: left half from the previous valid cell, right half from this one
      for (let g = lastValid + 1; g < c; g++) {
        elevM[o + g] = lastValid < 0 || g - lastValid > c - g ? elevM[o + c] : elevM[o + lastValid]
      }
      lastValid = c
    }
    for (let g = lastValid + 1; g < w; g++) elevM[o + g] = lastValid < 0 ? mean : elevM[o + lastValid]
  }
  const meta: TerrainMeta = {
    source: t.source,
    west: t.west,
    south: t.south,
    east: t.east,
    north: t.north,
    width: w,
    height: h,
    cellMetersX: t.cellMetersX,
    cellMetersY: t.cellMetersY,
  }
  return { meta, elevM, noData }
}

/** Bilinear height between 10 m cell centres, clamped at the grid edge. */
export function coarseHeight(g: CoarseGrid, lat: number, lon: number): number {
  const m = g.meta
  const fx = ((lon - m.west) / (m.east - m.west)) * m.width - 0.5
  const fy = ((m.north - lat) / (m.north - m.south)) * m.height - 0.5
  const cx = Math.min(m.width - 1, Math.max(0, fx))
  const cy = Math.min(m.height - 1, Math.max(0, fy))
  const x0 = Math.min(m.width - 2, Math.floor(cx))
  const y0 = Math.min(m.height - 2, Math.floor(cy))
  const tx = cx - x0
  const ty = cy - y0
  const k = y0 * m.width + x0
  const e = g.elevM
  const a = e[k] + (e[k + 1] - e[k]) * tx
  const b = e[k + m.width] + (e[k + m.width + 1] - e[k + m.width]) * tx
  return a + (b - a) * ty
}

/** True when (lat, lon) is inside the 10 m grid. */
export function inCoarseGrid(g: CoarseGrid, lat: number, lon: number): boolean {
  const m = g.meta
  return lat >= m.south && lat <= m.north && lon >= m.west && lon <= m.east
}

/**
 * Heights for a coarse tile where there is no 1 m DTM tile: the 10 m grid (bilinear) plus fBm micro-relief
 * (0.3 m, 2–16 m wavelengths, noise.ts). The relief is seeded in metres from the tile grid's anchor, so it does
 * not depend on where the session started.
 */
export function coarseTileHeights(row: number, col: number, g: TileGridSpec, grid: CoarseGrid): Float32Array {
  const b = tileBounds(row, col, g)
  const h = new Float32Array(SAMPLES * SAMPLES)
  for (let i = 0; i < SAMPLES; i++) {
    const lat = b.north - (i / CELLS) * g.tileDegLat
    for (let j = 0; j < SAMPLES; j++) {
      const lon = b.west + (j / CELLS) * g.tileDegLon
      const a = anchorMetres(lat, lon, g)
      h[i * SAMPLES + j] = coarseHeight(grid, lat, lon) + microRelief(a.e, a.s)
    }
  }
  return h
}

interface LoadedHeights {
  row: number
  col: number
  h: Float32Array
  /** True for a real 1 m DTM tile, false for a coarse one. */
  fine: boolean
}

/** Baseline of `slopeAt`, metres: the same 2 m the planner's slope grid uses. */
export const SLOPE_BASELINE_M = 2

export class HeightField {
  private tiles = new Map<number, LoadedHeights>()
  readonly grid: TileGridSpec
  /** Session origin: local ENU (0, 0). */
  readonly origin: LatLon
  readonly coarse: CoarseGrid | null

  constructor(grid: TileGridSpec, origin: LatLon, coarse: CoarseGrid | null) {
    this.grid = grid
    this.origin = origin
    this.coarse = coarse
  }

  setTile(row: number, col: number, h: Float32Array, fine: boolean): void {
    this.tiles.set(tileKey(row, col), { row, col, h, fine })
  }

  removeTile(row: number, col: number): void {
    this.tiles.delete(tileKey(row, col))
  }

  hasTile(row: number, col: number): boolean {
    return this.tiles.has(tileKey(row, col))
  }

  /** Samples of a loaded tile, or undefined. */
  tileHeights(row: number, col: number): Float32Array | undefined {
    return this.tiles.get(tileKey(row, col))?.h
  }

  /** Height in metres (areoid) at geographic (lat, lon). */
  heightLL(lat: number, lon: number): number {
    const t = this.loadedAt(lat, lon)
    if (t) {
      const { i, j } = sampleCoords(lat, lon, t.row, t.col, this.grid)
      return bilinear129(t.h, i, j)
    }
    return this.coarse ? coarseHeight(this.coarse, lat, lon) : 0
  }

  /**
   * The loaded tile holding (lat, lon). A point on a shared edge (within a few millimetres) also counts for
   * the tile on the other side, so the last row and column of a tile are usable when its neighbour is not loaded.
   */
  private loadedAt(lat: number, lon: number): LoadedHeights | undefined {
    const g = this.grid
    const fr = (g.origin.lat - lat) / g.tileDegLat
    const fc = (lon - g.origin.lon) / g.tileDegLon
    const row = Math.floor(fr)
    const col = Math.floor(fc)
    const t = this.tiles.get(tileKey(row, col))
    if (t) return t
    const EPS = 2e-5 // of a tile, ~2.5 mm
    const rows = fr - row < EPS ? [row, row - 1] : [row]
    const cols = fc - col < EPS ? [col, col - 1] : [col]
    for (const r of rows) {
      for (const c of cols) {
        const n = this.tiles.get(tileKey(r, c))
        if (n) return n
      }
    }
    return undefined
  }

  /** Height in metres (areoid) under local ENU (x, y). */
  heightAt(x: number, y: number): number {
    const p = toLatLon(x, y, this.origin)
    return this.heightLL(p.lat, p.lon)
  }

  /** Ground slope in degrees under (x, y), over a 2 m baseline. */
  slopeAt(x: number, y: number): number {
    const d = SLOPE_BASELINE_M / 2
    const gx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d)
    const gy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d)
    return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI
  }

  /** True when (x, y) is on a real 1 m DTM tile; false on coarse terrain (HUD shows "coarse terrain"). */
  isFine(x: number, y: number): boolean {
    const p = toLatLon(x, y, this.origin)
    return this.loadedAt(p.lat, p.lon)?.fine ?? false
  }
}
