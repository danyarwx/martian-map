import { useEffect, useRef, useState } from 'react'
import type { MobilityId, RoutePlans, SiteConfig, Target, WalkBackImage } from '../types.ts'
import type { PlanRequest, PlanResponse } from './planner.worker.ts'

export interface PlannerState {
  /** The fastest and the gentlest route for the current request. */
  plans: RoutePlans | null
  planning: boolean
  error: string | null
  /** Which elevation model the route was computed on. */
  terrainSource: string | null
  /** Lines of equal walking time back to the habitat, for the map. Null until the first plan. */
  walkBack: WalkBackImage | null
}

/**
 * Re-plans the round trip in a worker whenever the habitat, the targets to visit or the mobility change.
 * A new plan starts only when a position, the set of targets or the mobility really differs.
 */
export function usePlanner(site: SiteConfig, mobility: MobilityId, habitat: Target, targets: Target[]): PlannerState {
  const worker = useRef<Worker | null>(null)
  const latest = useRef(0)
  const [state, setState] = useState<PlannerState>({
    plans: null,
    planning: false,
    error: null,
    terrainSource: null,
    walkBack: null,
  })

  useEffect(() => {
    const w = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onmessage = (e: MessageEvent<PlanResponse>) => {
      const res = e.data
      if (res.id !== latest.current) return // an older request finished late
      setState((s) =>
        res.ok
          ? {
              plans: res.plans,
              planning: false,
              error: null,
              terrainSource: res.terrainSource,
              walkBack: res.walkBack ?? s.walkBack,
            }
          : { ...s, plans: null, planning: false, error: res.error },
      )
    }
    return () => {
      w.terminate()
      worker.current = null
    }
  }, [])

  // What the plan depends on, as text: re-rendering with equal values does not plan again.
  const request = JSON.stringify([mobility, habitat, targets])

  useEffect(() => {
    const id = ++latest.current
    if (targets.length === 0) {
      setState((s) => ({ ...s, plans: null, planning: false, error: null }))
      return
    }
    setState((s) => ({ ...s, planning: true }))
    const [, home, stops] = JSON.parse(request) as [MobilityId, Target, Target[]]
    const req: PlanRequest = { id, terrain: site.terrain, mobility, habitat: home, targets: stops }
    worker.current?.postMessage(req)
  }, [site, mobility, request])

  return state
}
