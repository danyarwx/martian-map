/**
 * Plans every walking leg the helmet may need and writes them as polylines for the tile builder.
 *
 * Legs: habitat -> each target, and every pair of targets (habitat + 6 targets = 21 legs). Each leg is
 * the planner's own fastest path for `walk` (src/lib/planner.ts, unchanged): `planRoute(from, [to])`
 * plans the round trip from -> to -> from, and its first leg is the one we keep.
 *
 * Input:  public/data/jezero_terrain.json, jezero_slope.bin, jezero_elev.bin (scripts/build_terrain.py)
 * Output: public/data/helmet/routes.json
 *   { generated, mobility, legs: [{ id: "<fromId>><toId>", fromId, toId, path: [[lat, lon], ...], distanceM }],
 *     unreachable: [{ fromId, toId, reason }] }
 *
 * Run: node scripts/export_routes.ts   (Node >= 22.18 strips the TypeScript types)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JEZERO } from '../src/data/jezero.ts'
import { MOBILITY } from '../src/lib/mobility.ts'
import { planRoute } from '../src/lib/planner.ts'
import type { Target, Terrain, TerrainMeta } from '../src/types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'public', 'data')
const OUT = join(DATA, 'helmet', 'routes.json')

/** Reads the planner grid from disk, the same checks as src/lib/terrain.ts `loadTerrain`. */
function loadTerrainFromDisk(): Terrain {
  const meta = JSON.parse(readFileSync(join(DATA, 'jezero_terrain.json'), 'utf8')) as TerrainMeta
  const slopeBuf = readFileSync(join(DATA, 'jezero_slope.bin'))
  const elevBuf = readFileSync(join(DATA, 'jezero_elev.bin'))
  const cells = meta.width * meta.height
  if (slopeBuf.byteLength !== cells || elevBuf.byteLength !== cells * 2) {
    throw new Error('Terrain files do not match their header. Re-run scripts/build_terrain.py')
  }
  // Copy into fresh, aligned buffers (Node's Buffer may share an unaligned pool slab).
  const slope = new Uint8Array(cells)
  slope.set(slopeBuf)
  const elevBytes = new Uint8Array(cells * 2)
  elevBytes.set(elevBuf)
  return { ...meta, slope, elev: new Int16Array(elevBytes.buffer) }
}

interface LegOut {
  id: string
  fromId: string
  toId: string
  path: [number, number][]
  distanceM: number
}

interface Unreachable {
  fromId: string
  toId: string
  reason: string
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

function main() {
  const t = loadTerrainFromDisk()
  const m = MOBILITY.walk
  const stops: Target[] = [JEZERO.habitat, ...JEZERO.targets]
  const legs: LegOut[] = []
  const unreachable: Unreachable[] = []

  for (let a = 0; a < stops.length; a++) {
    for (let b = a + 1; b < stops.length; b++) {
      const from = stops[a]
      const to = stops[b]
      const plan = planRoute(t, m, from, [to], 'fast')
      const leg = plan.legs.find((l) => l.fromId === from.id && l.toId === to.id)
      if (!leg) {
        const reason = plan.habitatNoFooting ? `no-footing at ${from.id}` : (plan.unreachableWhy[to.id] ?? 'no-path')
        unreachable.push({ fromId: from.id, toId: to.id, reason })
        console.log(`  ${from.id} > ${to.id}: UNREACHABLE (${reason})`)
        continue
      }
      legs.push({
        id: `${from.id}>${to.id}`,
        fromId: from.id,
        toId: to.id,
        path: leg.path.map((p) => [round(p.lat, 7), round(p.lon, 7)]),
        distanceM: round(leg.distanceM, 1),
      })
      console.log(`  ${from.id} > ${to.id}: ${(leg.distanceM / 1000).toFixed(2)} km, ${leg.path.length} points`)
    }
  }

  mkdirSync(dirname(OUT), { recursive: true })
  const out = { generated: new Date().toISOString(), mobility: m.id, legs, unreachable }
  writeFileSync(OUT, JSON.stringify(out) + '\n')
  console.log(`${legs.length} legs, ${unreachable.length} unreachable -> ${OUT}`)
}

main()
