import { useEffect, useRef, useState } from 'react'
import type { MobilityId, RoutePlan, SiteConfig } from '../types.ts'
import type { PlanRequest, PlanResponse } from './planner.worker.ts'

export interface PlannerState {
  plan: RoutePlan | null
  planning: boolean
  error: string | null
  /** Which elevation model the route was computed on. */
  terrainSource: string | null
}

/** Re-plans the round trip in a worker whenever the chosen targets or the mobility change. */
export function usePlanner(site: SiteConfig, mobility: MobilityId, selected: ReadonlySet<string>): PlannerState {
  const worker = useRef<Worker | null>(null)
  const latest = useRef(0)
  const [state, setState] = useState<PlannerState>({ plan: null, planning: false, error: null, terrainSource: null })

  useEffect(() => {
    const w = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onmessage = (e: MessageEvent<PlanResponse>) => {
      const res = e.data
      if (res.id !== latest.current) return // an older request finished late
      setState((s) =>
        res.ok
          ? { plan: res.plan, planning: false, error: null, terrainSource: res.terrainSource }
          : { ...s, plan: null, planning: false, error: res.error },
      )
    }
    return () => {
      w.terminate()
      worker.current = null
    }
  }, [])

  useEffect(() => {
    const targets = site.targets.filter((t) => selected.has(t.id))
    const id = ++latest.current
    if (targets.length === 0) {
      setState((s) => ({ ...s, plan: null, planning: false, error: null }))
      return
    }
    setState((s) => ({ ...s, planning: true }))
    const req: PlanRequest = { id, terrain: site.terrain, mobility, habitat: site.habitat, targets }
    worker.current?.postMessage(req)
  }, [site, mobility, selected])

  return state
}
