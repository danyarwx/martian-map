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
import { planFixedOrder, planFrom, planRoutes } from './planner.ts'
import { loadTerrain } from './terrain.ts'
import { walkBackImage, walkHomeSeconds } from './walkback.ts'

/** Plan the round trip through the chosen targets, in the best order. What the planning screen sends. */
export interface PlanRequest {
  kind?: 'plan'
  id: number
  terrain: SiteConfig['terrain']
  mobility: MobilityId
  habitat: Target
  targets: Target[]
}

/** Plan again from where the crew stands, through the stops still to visit in the given order, then home. */
export interface RerouteRequest {
  kind: 'reroute'
  id: number
  terrain: SiteConfig['terrain']
  mobility: MobilityId
  profile: RouteProfile
  habitat: Target
  from: LatLon
  /** Targets still to visit, in order. The habitat is always the end and is not listed. */
  stops: Target[]
}

export type WorkerRequest = PlanRequest | RerouteRequest

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

export type RerouteResponse =
  | { kind: 'reroute'; id: number; ok: true; plan: RoutePlan }
  | { kind: 'reroute'; id: number; ok: false; error: string }

let terrain: Promise<Terrain> | undefined
/**
 * Walk-back times for the habitat position they were computed for. They change only when the habitat moves.
 * `sent` is set once the picture of them went to the planning screen.
 */
let home: { key: string; seconds: Float32Array; sent: boolean } | undefined

/** Walk-back times for this habitat. With `picture`, also their picture if the planning screen has not had it yet. */
function homeFor(t: Terrain, habitat: Target, picture: boolean): { seconds: Float32Array; walkBack?: WalkBackImage } {
  const key = `${habitat.lat},${habitat.lon}`
  if (home?.key !== key) home = { key, seconds: walkHomeSeconds(t, habitat), sent: false }
  if (!picture || home.sent) return { seconds: home.seconds }
  home.sent = true
  return { seconds: home.seconds, walkBack: walkBackImage(t, home.seconds) }
}

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
    // The cached walk-back times; the planning screen still gets their picture with its next plan.
    const homeSec = homeFor(t, req.habitat, false).seconds
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

self.onmessage = async (e: MessageEvent<WorkerRequest | ReplanRequest>) => {
  if ('type' in e.data && e.data.type === 'replan') return replan(e.data)
  const req = e.data as WorkerRequest
  try {
    terrain ??= loadTerrain(req.terrain)
    const t = await terrain
    if (req.kind === 'reroute') {
      const { seconds } = homeFor(t, req.habitat, false)
      const plan = planFixedOrder(t, MOBILITY[req.mobility], req.from, req.stops, req.habitat, seconds, req.profile)
      self.postMessage({ kind: 'reroute', id: req.id, ok: true, plan } satisfies RerouteResponse)
      return
    }
    const { seconds, walkBack } = homeFor(t, req.habitat, true) // the picture is sent once per habitat position
    const plans = planRoutes(t, MOBILITY[req.mobility], req.habitat, req.targets, seconds)
    self.postMessage({ id: req.id, ok: true, plans, terrainSource: t.source, walkBack } satisfies PlanResponse)
  } catch (err) {
    if (req.kind === 'reroute') {
      // A failed reroute is about the position, not the data: keep what is loaded.
      self.postMessage({ kind: 'reroute', id: req.id, ok: false, error: String(err) } satisfies RerouteResponse)
      return
    }
    terrain = undefined
    home = undefined
    self.postMessage({ id: req.id, ok: false, error: String(err) } satisfies PlanResponse)
  }
}
