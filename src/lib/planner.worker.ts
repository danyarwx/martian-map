// Route planning runs here so the map stays responsive while paths are searched.
import type {
  LatLon,
  MobilityId,
  RoutePlan,
  RoutePlans,
  RouteProfile,
  SiteConfig,
  Target,
  Terrain,
  WalkBackImage,
} from '../types.ts'
import { MOBILITY } from './mobility.ts'
import { planFrom, planRoutes } from './planner.ts'
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

/**
 * Re-plan from where the crew is now (the helmet's global re-route, see planner.ts `planFrom`).
 * Plan requests have no `type`; this one is told apart by `type: 'replan'`.
 */
export interface ReplanRequest {
  type: 'replan'
  id: number
  terrain: SiteConfig['terrain']
  mobility: MobilityId
  /** Where the crew is now. */
  from: LatLon
  /** Stops still to visit, in this order. */
  stops: Target[]
  habitat: Target
  /** Terrain cell indices (row × width + col) that are no-go on top of the slope limit. */
  blocked: number[]
  profile: RouteProfile
}

export type ReplanResponse =
  | { type: 'replan'; id: number; ok: true; plan: RoutePlan }
  | { type: 'replan'; id: number; ok: false; error: string }

let terrain: Promise<Terrain> | undefined
/** Walk-back times for the habitat position they were computed for. They change only when the habitat moves. */
let home: { key: string; seconds: Float32Array } | undefined

async function replan(req: ReplanRequest) {
  const fail = (err: unknown) =>
    self.postMessage({ type: 'replan', id: req.id, ok: false, error: String(err) } satisfies ReplanResponse)
  let t: Terrain
  try {
    terrain ??= loadTerrain(req.terrain)
    t = await terrain
  } catch (err) {
    terrain = undefined // try loading again next time
    return fail(err)
  }
  try {
    const blocked = new Uint8Array(t.width * t.height)
    for (const i of req.blocked) if (i >= 0 && i < blocked.length) blocked[i] = 1
    // Reuse the cached walk-back times when they are for this habitat; otherwise compute them without
    // touching the cache, so the next plan request still sends its walk-back picture.
    const key = `${req.habitat.lat},${req.habitat.lon}`
    const homeSec = home?.key === key ? home.seconds : walkHomeSeconds(t, req.habitat)
    const plan = planFrom(t, MOBILITY[req.mobility], req.from, req.stops, req.habitat, {
      blocked,
      profile: req.profile,
      homeSec,
    })
    self.postMessage({ type: 'replan', id: req.id, ok: true, plan } satisfies ReplanResponse)
  } catch (err) {
    fail(err) // e.g. no passable ground near the crew: the caller keeps its current plan
  }
}

self.onmessage = async (e: MessageEvent<PlanRequest | ReplanRequest>) => {
  if ('type' in e.data && e.data.type === 'replan') return replan(e.data)
  const req = e.data as PlanRequest
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
