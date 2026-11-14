// Route planning runs here so the map stays responsive while paths are searched.
import type { MobilityId, RoutePlans, SiteConfig, Target, Terrain, WalkBackImage } from '../types.ts'
import { MOBILITY } from './mobility.ts'
import { planRoutes } from './planner.ts'
import { loadTerrain } from './terrain.ts'
import { walkBackImage, walkHomeSeconds } from './walkback.ts'

export interface PlanRequest {
  id: number
  terrain: SiteConfig['terrain']
  mobility: MobilityId
  habitat: Target
  targets: Target[]
}

export type PlanResponse =
  | { id: number; ok: true; plans: RoutePlans; terrainSource: string; walkBack?: WalkBackImage }
  | { id: number; ok: false; error: string }

let terrain: Promise<Terrain> | undefined
/** Walk-back times for the habitat position they were computed for. They change only when the habitat moves. */
let home: { key: string; seconds: Float32Array } | undefined

self.onmessage = async (e: MessageEvent<PlanRequest>) => {
  const req = e.data
  try {
    terrain ??= loadTerrain(req.terrain)
    const t = await terrain
    const key = `${req.habitat.lat},${req.habitat.lon}`
    let walkBack: WalkBackImage | undefined
    if (home?.key !== key) {
      home = { key, seconds: walkHomeSeconds(t, req.habitat) }
      walkBack = walkBackImage(t, home.seconds) // sent once per habitat position
    }
    const plans = planRoutes(t, MOBILITY[req.mobility], req.habitat, req.targets, home.seconds)
    self.postMessage({ id: req.id, ok: true, plans, terrainSource: t.source, walkBack } satisfies PlanResponse)
  } catch (err) {
    terrain = undefined
    home = undefined
    self.postMessage({ id: req.id, ok: false, error: String(err) } satisfies PlanResponse)
  }
}
