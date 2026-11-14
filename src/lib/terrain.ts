import type { SiteConfig, Terrain, TerrainMeta } from '../types.ts'

/** Loads the slope and elevation grids written by scripts/build_terrain.py. */
export async function loadTerrain(files: SiteConfig['terrain']): Promise<Terrain> {
  const [meta, slope, elev] = await Promise.all([
    fetch(files.meta).then((r) => r.json() as Promise<TerrainMeta>),
    fetch(files.slope).then((r) => r.arrayBuffer()),
    fetch(files.elev).then((r) => r.arrayBuffer()),
  ])
  const cells = meta.width * meta.height
  if (slope.byteLength !== cells || elev.byteLength !== cells * 2) {
    throw new Error('Terrain files do not match their header. Re-run scripts/build_terrain.py')
  }
  return { ...meta, slope: new Uint8Array(slope), elev: new Int16Array(elev) }
}
