// Streams the near terrain around the player (docs/helmet/PLAN.md §6.2).
//
// Tiles of the fixed 128 m grid whose nearest point is within 400 m of the player are loaded; tiles beyond 600 m
// are dropped (the gap between the two keeps a walker on a tile edge from loading and unloading the same tile).
// A tile in public/data/helmet/index.json is the real 1 m HiRISE DTM + 25 cm ortho; any other tile inside the 10 m
// grid is a coarse tile (10 m grid + micro-relief, heightField.ts). Fetches run a few at a time, nearest first;
// mesh building is capped per frame so streaming never stalls a frame for long. Detail drops with distance
// (1 m vertex spacing next to the player, 2/4/8 m further out) to stay within the triangle budget.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import { toLatLon, toLocal } from '../frames.ts'
import { coarseTileHeights, inCoarseGrid, type CoarseGrid, type HeightField } from './heightField.ts'
import { buildTileGeometry, makeCoarseMaterial, makeOrthoMaterial, type Stride } from './terrainMesh.ts'
import { decodeTileHeights, tileBounds, tileId, tileKey, tileOf, type TileEntry, type TileIndex } from './tileGrid.ts'

export const INDEX_URL = '/data/helmet/index.json'
const BASE = '/data/helmet/'

/** Load tiles whose nearest point is within this distance of the player, metres. */
export const LOAD_M = 400
/** Drop tiles further than this, metres. */
export const UNLOAD_M = 600
const MAX_IN_FLIGHT = 6
/** Mesh builds per frame, and the time after which a frame stops building, ms. */
const BUILDS_PER_FRAME = 2
const BUILD_BUDGET_MS = 10

export async function loadTileIndex(signal?: AbortSignal): Promise<TileIndex> {
  const r = await fetch(INDEX_URL, { signal })
  if (!r.ok) throw new Error(`${INDEX_URL}: HTTP ${r.status}`)
  return (await r.json()) as TileIndex
}

/** Vertex spacing for a tile at this distance from the player. */
export function strideFor(distM: number): Stride {
  if (distM < 48) return 1
  if (distM < 160) return 2
  if (distM < 320) return 4
  return 8
}

export interface TileSlot {
  key: number
  row: number
  col: number
  id: string
  /** Index entry of a real 1 m tile, null for a coarse tile. */
  entry: TileEntry | null
  /** Local ENU rectangle. */
  x0: number
  x1: number
  y0: number
  y1: number
  /** Distance from the player to the nearest point of the tile, metres. */
  dist: number
  state: 'queued' | 'fetching' | 'fetched' | 'built'
  heights: Float32Array | null
  /** Sand mask, 256 × 256 at 0.5 m, 1 = sand. Real tiles only. */
  sand: Uint8Array | null
  /** RGBA pixels of the ortho, 512 × 512, while the tile is being built (released afterwards). */
  orthoPixels: Uint8ClampedArray | null
  ortho: THREE.Texture | null
  bitmap: ImageBitmap | null
  material: THREE.MeshStandardMaterial | null
  mesh: THREE.Mesh | null
  stride: Stride
  /** Normals along the edges need recomputing (a neighbour arrived). */
  dirty: boolean
  dead: boolean
}

export interface TileStreamerOptions {
  index: TileIndex
  origin: LatLon
  heights: HeightField
  coarse: CoarseGrid | null
  group: THREE.Group
  detail: THREE.Texture
  anisotropy: number
  /** Called after a tile's heights are in the height field, before its mesh is built. */
  onBuilt?: (slot: TileSlot) => void
  /** Called when a tile is dropped. */
  onRemoved?: (slot: TileSlot) => void
}

function pixelsOf(bitmap: ImageBitmap): Uint8ClampedArray {
  const w = bitmap.width
  const h = bitmap.height
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!ctx) throw new Error('no 2D canvas')
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, w, h).data
}

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

export class TileStreamer {
  private slots = new Map<number, TileSlot>()
  private fine = new Map<number, TileEntry>()
  private inFlight = 0
  private lastScan: { x: number; y: number } | null = null
  private abort = new AbortController()
  private opts: TileStreamerOptions
  private coarseMaterial: THREE.MeshStandardMaterial
  private player = { x: 0, y: 0 }

  constructor(opts: TileStreamerOptions) {
    this.opts = opts
    for (const t of opts.index.tiles) this.fine.set(tileKey(t.row, t.col), t)
    this.coarseMaterial = makeCoarseMaterial(opts.detail)
  }

  /** Call every frame with the player's local position. */
  update(x: number, y: number): void {
    this.player.x = x
    this.player.y = y
    if (!this.lastScan || Math.hypot(x - this.lastScan.x, y - this.lastScan.y) > 4) {
      this.lastScan = { x, y }
      this.scan(x, y)
    }
    this.startFetches()
    this.build()
  }

  /** True when every tile within `r` metres of (x, y) has its mesh. */
  readyAround(x: number, y: number, r = 64): boolean {
    for (const s of this.slots.values()) {
      if (s.state !== 'built' && this.rectDist(s, x, y) < r) return false
    }
    return this.lastScan !== null
  }

  /** Tiles still waiting for data or a mesh. */
  get pending(): number {
    let n = 0
    for (const s of this.slots.values()) if (s.state !== 'built') n++
    return n
  }

  get loaded(): number {
    return this.slots.size
  }

  /** Built tiles, for rocks and debugging. */
  builtSlots(): TileSlot[] {
    return [...this.slots.values()].filter((s) => s.state === 'built')
  }

  dispose(): void {
    this.abort.abort()
    for (const s of this.slots.values()) this.release(s)
    this.slots.clear()
    this.coarseMaterial.dispose()
  }

  private rectDist(s: TileSlot, x: number, y: number): number {
    const dx = Math.max(s.x0 - x, 0, x - s.x1)
    const dy = Math.max(s.y0 - y, 0, y - s.y1)
    return Math.hypot(dx, dy)
  }

  private scan(x: number, y: number): void {
    const { index, origin, coarse } = this.opts
    const p = toLatLon(x, y, origin)
    const here = tileOf(p.lat, p.lon, index)
    const reach = Math.ceil(UNLOAD_M / index.tileSizeM) + 1
    for (let r = here.row - reach; r <= here.row + reach; r++) {
      for (let c = here.col - reach; c <= here.col + reach; c++) {
        const key = tileKey(r, c)
        let s = this.slots.get(key)
        if (!s) {
          const entry = this.fine.get(key) ?? null
          const b = tileBounds(r, c, index)
          if (!entry && (!coarse || !inCoarseGrid(coarse, (b.north + b.south) / 2, (b.west + b.east) / 2))) continue
          const nw = toLocal({ lat: b.north, lon: b.west }, origin)
          const se = toLocal({ lat: b.south, lon: b.east }, origin)
          const probe = { x0: nw.x, x1: se.x, y0: se.y, y1: nw.y } as TileSlot
          const d = this.rectDist(probe, x, y)
          if (d > LOAD_M) continue
          s = {
            key,
            row: r,
            col: c,
            id: tileId(r, c),
            entry,
            x0: nw.x,
            x1: se.x,
            y0: se.y,
            y1: nw.y,
            dist: d,
            state: entry ? 'queued' : 'fetched',
            heights: null,
            sand: null,
            orthoPixels: null,
            ortho: null,
            bitmap: null,
            material: null,
            mesh: null,
            stride: strideFor(d),
            dirty: false,
            dead: false,
          }
          this.slots.set(key, s)
        }
      }
    }
    for (const s of this.slots.values()) {
      s.dist = this.rectDist(s, x, y)
      if (s.dist > UNLOAD_M) this.unload(s)
    }
  }

  private startFetches(): void {
    if (this.inFlight >= MAX_IN_FLIGHT) return
    const queued = [...this.slots.values()].filter((s) => s.state === 'queued').sort((a, b) => a.dist - b.dist)
    for (const s of queued) {
      if (this.inFlight >= MAX_IN_FLIGHT) break
      this.fetchTile(s)
    }
  }

  private async fetchTile(s: TileSlot): Promise<void> {
    const e = s.entry!
    s.state = 'fetching'
    this.inFlight++
    const signal = this.abort.signal
    try {
      const [bin, ortho, sand] = await Promise.all([
        fetch(BASE + e.file, { signal }).then((r) => {
          if (!r.ok) throw new Error(`${e.file}: HTTP ${r.status}`)
          return r.arrayBuffer()
        }),
        fetchBitmap(BASE + e.ortho, signal),
        fetchBitmap(BASE + e.sand, signal).catch(() => null),
      ])
      if (s.dead) {
        ortho.close()
        sand?.close()
        return
      }
      s.heights = decodeTileHeights(bin, e.zMin)
      s.bitmap = ortho
      s.orthoPixels = pixelsOf(ortho)
      if (sand) {
        const px = pixelsOf(sand)
        const m = new Uint8Array(sand.width * sand.height)
        for (let k = 0; k < m.length; k++) m[k] = px[k * 4] > 127 ? 1 : 0
        s.sand = m
        sand.close()
      }
      const tex = new THREE.Texture(ortho)
      tex.flipY = false
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = this.opts.anisotropy
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
      tex.needsUpdate = true
      s.ortho = tex
      s.state = 'fetched'
    } catch (err) {
      if (s.dead || signal.aborted) return
      // a missing or broken tile is drawn coarse rather than left as a hole
      console.warn(`helmet: tile ${s.id} failed, using coarse terrain`, err)
      s.entry = null
      s.state = 'fetched'
    } finally {
      this.inFlight--
    }
  }

  private build(): void {
    const t0 = performance.now()
    const ready = [...this.slots.values()].filter((s) => s.state === 'fetched').sort((a, b) => a.dist - b.dist)
    let builds = 0
    for (const s of ready) {
      if (builds >= BUILDS_PER_FRAME || performance.now() - t0 > BUILD_BUDGET_MS) return
      this.buildSlot(s)
      builds++
    }
    // detail changes and edge normal refreshes, nearest first
    const redo = [...this.slots.values()]
      .filter((s) => s.state === 'built' && (s.dirty || strideFor(s.dist) !== s.stride))
      .sort((a, b) => a.dist - b.dist)
    for (const s of redo) {
      if (builds >= BUILDS_PER_FRAME + 1 || performance.now() - t0 > BUILD_BUDGET_MS) return
      this.remesh(s)
      builds++
    }
  }

  private buildSlot(s: TileSlot): void {
    const { heights, index, coarse, group, detail } = this.opts
    if (!s.heights) {
      if (!coarse) return
      s.heights = coarseTileHeights(s.row, s.col, index, coarse)
    }
    heights.setTile(s.row, s.col, s.heights, s.entry !== null)
    this.opts.onBuilt?.(s)
    s.orthoPixels = null
    if (s.ortho) s.material = makeOrthoMaterial(s.ortho, detail)
    const mesh = new THREE.Mesh(this.geometry(s), s.material ?? this.coarseMaterial)
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.name = `tile ${s.id}${s.entry ? '' : ' (coarse)'}`
    s.mesh = mesh
    s.state = 'built'
    group.add(mesh)
    // neighbours computed their edge normals without this tile
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const n = (dr || dc) && this.slots.get(tileKey(s.row + dr, s.col + dc))
        if (n && n.state === 'built' && n.dist < 200) n.dirty = true
      }
    }
  }

  private geometry(s: TileSlot): THREE.BufferGeometry {
    s.stride = strideFor(s.dist)
    s.dirty = false
    const hf = this.opts.heights
    return buildTileGeometry({
      h: s.heights!,
      row: s.row,
      col: s.col,
      grid: this.opts.index,
      origin: this.opts.origin,
      stride: s.stride,
      outside: (lat, lon) => hf.heightLL(lat, lon),
      slopeColours: s.entry === null,
    })
  }

  private remesh(s: TileSlot): void {
    if (!s.mesh) return
    const old = s.mesh.geometry
    s.mesh.geometry = this.geometry(s)
    old.dispose()
  }

  private unload(s: TileSlot): void {
    this.release(s)
    this.slots.delete(s.key)
    if (s.heights) this.opts.heights.removeTile(s.row, s.col)
    this.opts.onRemoved?.(s)
  }

  private release(s: TileSlot): void {
    s.dead = true
    if (s.mesh) {
      s.mesh.removeFromParent()
      s.mesh.geometry.dispose()
      s.mesh = null
    }
    s.material?.dispose()
    s.ortho?.dispose()
    s.bitmap?.close()
    s.material = null
    s.ortho = null
    s.bitmap = null
    s.orthoPixels = null
  }
}
