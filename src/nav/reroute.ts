// Replanning during navigation, in its own planner worker so the screen stays smooth.
import type { LatLon, MobilityId, RoutePlan, RouteProfile, SiteConfig, Target } from '../types.ts'
import type { RerouteRequest, RerouteResponse } from '../lib/planner.worker.ts'

export interface WorkerRerouter {
  /** Pass this as `requestReroute` to `createNavigator`. */
  requestReroute(from: LatLon, stopIds: string[]): Promise<RoutePlan>
  /** Stops the worker. */
  dispose(): void
}

/**
 * Starts a planner worker for replanning. `stops` holds the targets by id; the worker loads the terrain
 * itself on the first request (a few seconds), so create this when navigation starts, not on the first reroute.
 */
export function createWorkerRerouter(options: {
  site: SiteConfig
  mobility: MobilityId
  profile: RouteProfile
  habitat: Target
  stops: Record<string, Target>
}): WorkerRerouter {
  const worker = new Worker(new URL('../lib/planner.worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve: (p: RoutePlan) => void; reject: (e: Error) => void }>()
  let nextId = 1
  worker.onmessage = (e: MessageEvent<RerouteResponse>) => {
    const res = e.data
    const waiting = pending.get(res.id)
    if (!waiting) return
    pending.delete(res.id)
    if (res.ok) waiting.resolve(res.plan)
    else waiting.reject(new Error(res.error))
  }
  return {
    requestReroute(from, stopIds) {
      const id = nextId++
      const req: RerouteRequest = {
        kind: 'reroute',
        id,
        terrain: options.site.terrain,
        mobility: options.mobility,
        profile: options.profile,
        habitat: options.habitat,
        from,
        stops: stopIds.map((s) => options.stops[s]).filter((s): s is Target => s !== undefined),
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage(req)
      })
    },
    dispose() {
      worker.terminate()
      for (const p of pending.values()) p.reject(new Error('Rerouting stopped.'))
      pending.clear()
    },
  }
}
