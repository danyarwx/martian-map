// Route planning runs here so the map stays responsive while paths are searched.
import type { MobilityId, RoutePlans, SiteConfig, Target, Terrain } from '../types.ts'
import { MOBILITY } from './mobility.ts'
import { planRoutes } from './planner.ts'
import { loadTerrain } from './terrain.ts'

export interface PlanRequest {
  id: number
  terrain: SiteConfig['terrain']
  mobility: MobilityId
  habitat: Target
  targets: Target[]
}

export type PlanResponse =
  | { id: number; ok: true; plans: RoutePlans; terrainSource: string }
  | { id: number; ok: false; error: string }

let terrain: Promise<Terrain> | undefined

self.onmessage = async (e: MessageEvent<PlanRequest>) => {
  const req = e.data
  try {
    terrain ??= loadTerrain(req.terrain)
    const t = await terrain
    const plans = planRoutes(t, MOBILITY[req.mobility], req.habitat, req.targets)
    self.postMessage({ id: req.id, ok: true, plans, terrainSource: t.source } satisfies PlanResponse)
  } catch (err) {
    terrain = undefined
    self.postMessage({ id: req.id, ok: false, error: String(err) } satisfies PlanResponse)
  }
}
