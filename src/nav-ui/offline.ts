// Map tiles for use without a network. The service worker answers tile requests from the cache
// named TILE_CACHE (see vite.config.ts); this module fills that cache ahead of an excursion.
import type { LatLon, RoutePlan } from '../types.ts'
import type { Bounds } from '../lib/geo.ts'
import { OFFLINE_SOURCES, trekTileUrl } from '../map/layers.ts'

/** Must match the runtime cache name in vite.config.ts. */
export const TILE_CACHE = 'trek-tiles'

/** Width of the strip around the route that gets the sharpest imagery, metres on each side. */
export const CORRIDOR_M = 150

/** Average tile size measured on Trek on 14 Nov (20 tiles per zoom), kilobytes. Only for the estimate. */
const AVG_KB: Record<string, number> = { viking: 59, ctx: 30, hirise: 48, hirise16: 40, hirise17: 29 }

/** Zoom levels kept for the whole terrain area, per layer. HiRISE z16-17 only along the route. */
const AREA_ZOOMS = { viking: [5, 7], ctx: [10, 13], hirise: [10, 15] } as const
const CORRIDOR_ZOOMS = [16, 17]

const METRES_PER_DEGREE = 59158 // on Mars, along a meridian

export interface TilePart {
  label: string
  urls: string[]
  estimateMB: number
}

/** Size of a tile at zoom z, degrees. The Trek grid is 2 x 1 tiles of 180° at zoom 0. */
const tileDeg = (z: number) => 180 / 2 ** z

/** Column and row ranges of the tiles covering a box at zoom z. */
function tileRange(z: number, b: Bounds) {
  const d = tileDeg(z)
  return {
    x0: Math.floor((b.west + 180) / d),
    x1: Math.floor((b.east + 180) / d),
    y0: Math.floor((90 - b.north) / d),
    y1: Math.floor((90 - b.south) / d),
  }
}

function addBox(out: Set<string>, layer: keyof typeof OFFLINE_SOURCES, z: number, b: Bounds) {
  const { id, ext } = OFFLINE_SOURCES[layer]
  const r = tileRange(z, b)
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.add(trekTileUrl(id, ext, z, x, y))
}

/** (a) The whole planning area: Viking for context, CTX to z13, HiRISE to z15. */
export function areaTiles(b: Bounds): TilePart {
  const urls = new Set<string>()
  let kb = 0
  for (const layer of ['viking', 'ctx', 'hirise'] as const) {
    const [lo, hi] = AREA_ZOOMS[layer]
    for (let z = lo; z <= hi; z++) {
      const before = urls.size
      addBox(urls, layer, z, b)
      kb += (urls.size - before) * AVG_KB[layer]
    }
  }
  return { label: 'Whole area', urls: [...urls], estimateMB: kb / 1024 }
}

/** (b) HiRISE z16-17 in a strip of CORRIDOR_M either side of the route. */
export function corridorTiles(plan: RoutePlan): TilePart {
  const urls = new Set<string>()
  let kb = 0
  const points: LatLon[] = plan.legs.flatMap((l) => l.path)
  for (const z of CORRIDOR_ZOOMS) {
    const before = urls.size
    for (const p of points) {
      const dLat = CORRIDOR_M / METRES_PER_DEGREE
      const dLon = dLat / Math.cos((p.lat * Math.PI) / 180)
      addBox(urls, 'hirise', z, { west: p.lon - dLon, east: p.lon + dLon, south: p.lat - dLat, north: p.lat + dLat })
    }
    kb += (urls.size - before) * AVG_KB[`hirise${z}`]
  }
  return { label: 'Along the route', urls: [...urls], estimateMB: kb / 1024 }
}

/** True when this browser can keep tiles (Cache Storage needs a secure page: https or localhost). */
export const canCache = () => typeof caches !== 'undefined'

/** How many of `urls` are already in the tile cache. */
export async function countCached(urls: string[]): Promise<number> {
  if (!canCache()) return 0
  const cache = await caches.open(TILE_CACHE)
  const have = new Set((await cache.keys()).map((r) => r.url))
  return urls.filter((u) => have.has(u)).length
}

export interface DownloadProgress {
  done: number
  total: number
  /** Megabytes fetched in this run (tiles already cached are not fetched again). */
  mb: number
  failed: number
}

/**
 * Fetches every tile not yet cached, `concurrency` at a time, and puts it in the tile cache.
 * Resumable: a second run skips what the first one stored. Stops when `signal` aborts.
 */
export async function downloadTiles(
  urls: string[],
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
  concurrency = 6,
): Promise<DownloadProgress> {
  const cache = await caches.open(TILE_CACHE)
  const have = new Set((await cache.keys()).map((r) => r.url))
  const todo = urls.filter((u) => !have.has(u))
  const progress: DownloadProgress = { done: urls.length - todo.length, total: urls.length, mb: 0, failed: 0 }
  onProgress({ ...progress })
  let next = 0
  async function worker() {
    while (next < todo.length && !signal.aborted) {
      const url = todo[next++]
      try {
        const res = await fetch(url, { mode: 'cors', signal })
        if (res.ok) {
          const blob = await res.blob()
          await cache.put(url, new Response(blob, { headers: res.headers }))
          progress.mb += blob.size / 1048576
        } else {
          progress.failed++ // a tile Trek does not have, e.g. at the edge of a mosaic
        }
      } catch {
        if (signal.aborted) return
        progress.failed++
      }
      progress.done++
      onProgress({ ...progress })
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return progress
}
