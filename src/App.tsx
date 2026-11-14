import { useCallback, useEffect, useState } from 'react'
import { JEZERO } from './data/jezero.ts'
import { usePlanner } from './lib/usePlanner.ts'
import MarsMap from './map/MarsMap.tsx'
import Sidebar from './panels/Sidebar.tsx'
import type { MobilityId, StopView } from './types.ts'

const site = JEZERO
// A walk that fits one excursion, so the first screen already shows a planned route.
const INITIAL = ['three-forks', 'delta-front', 'seitah']

export default function App() {
  const [mobility, setMobility] = useState<MobilityId>('walk')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(INITIAL))
  const [focusId, setFocusId] = useState<string | null>(null)
  const [views, setViews] = useState<Record<string, StopView>>({})
  const planner = usePlanner(site, mobility, selected)

  useEffect(() => {
    fetch(site.views)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setViews)
      .catch(() => setViews({}))
  }, [])

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <strong>Martian Map</strong>
        <span className="muted">Excursion planner · {site.name}</span>
      </header>
      <div className="workspace">
        <MarsMap
          site={site}
          selected={selected}
          plan={planner.plan}
          focusId={focusId}
          onToggle={toggle}
          onFocus={setFocusId}
        />
        <Sidebar
          site={site}
          mobility={mobility}
          selected={selected}
          focusId={focusId}
          planner={planner}
          views={views}
          onMobility={setMobility}
          onToggle={toggle}
          onFocus={setFocusId}
        />
      </div>
    </div>
  )
}
