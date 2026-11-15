import { useEffect, useState } from 'react'
import type { SiteConfig, Terrain } from '../types.ts'
import type { Frame, FrameIndex } from './photoProjection.ts'
import { loadTerrain } from './terrain.ts'

export interface PhotoData {
  frames: Frame[]
  credit: string
  camera: string
  /** The elevation grid, for the height of each marked place and whether the ground hides it. */
  terrain: Terrain
}

/**
 * Cached Navcam frames and the terrain grid, for photos with markers. Null until both have loaded,
 * and for good when either file is missing (run scripts/fetch_frames.py).
 * The worker loads its own copy of the grid; the browser cache serves this one.
 */
export function usePhotoData(site: SiteConfig): PhotoData | null {
  const [data, setData] = useState<PhotoData | null>(null)
  // Keyed by the file paths: the site object itself may be rebuilt on every render, which would restart the load forever.
  const { frames: framesFile, terrain: files } = site
  const key = `${framesFile}|${files.meta}|${files.slope}|${files.elev}`
  useEffect(() => {
    let alive = true
    Promise.all([
      fetch(framesFile).then((r) => (r.ok ? (r.json() as Promise<FrameIndex>) : null)),
      loadTerrain(files),
    ])
      .then(([index, terrain]) => {
        if (alive && index) setData({ frames: index.frames, credit: index.credit, camera: index.camera, terrain })
      })
      .catch(() => alive && setData(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key holds everything the load depends on
  }, [key])
  return data
}
