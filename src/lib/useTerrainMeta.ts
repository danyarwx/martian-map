import { useEffect, useState } from 'react'
import type { SiteConfig, TerrainMeta } from '../types.ts'

/** Header of the site's elevation grid (its bounds above all), or null until it has loaded. */
export function useTerrainMeta(site: SiteConfig): TerrainMeta | null {
  const [meta, setMeta] = useState<TerrainMeta | null>(null)
  useEffect(() => {
    let alive = true
    fetch(site.terrain.meta)
      .then((r) => (r.ok ? (r.json() as Promise<TerrainMeta>) : null))
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMeta(null)) // file not built yet: run `npm run build-terrain`
    return () => {
      alive = false
    }
  }, [site])
  return meta
}
