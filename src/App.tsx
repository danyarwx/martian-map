import { useCallback, useEffect, useState } from 'react'
import MarsMap from './MarsMap'
import HelmetHUD from './panels/HelmetHUD'
import type { Hazard } from './types'

type View = 'map' | 'hud'

const viewFromHash = (): View => (window.location.hash === '#hud' ? 'hud' : 'map')

export default function App() {
  const [view, setView] = useState<View>(viewFromHash)
  // Hazards found during the walk. The planning map will read these once it supports them.
  const [hazards, setHazards] = useState<Hazard[]>([])

  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const show = (v: View) => {
    window.location.hash = v === 'hud' ? 'hud' : ''
    setView(v)
  }

  const addHazard = useCallback((h: Hazard) => {
    setHazards((list) => (list.some((x) => x.id === h.id) ? list : [...list, h]))
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <strong>Martian Map</strong>
        <span className="muted">Space Apps 2026 · Jezero crater · walk to Cheyava Falls</span>
        <nav className="viewtabs" aria-label="Screens">
          <button type="button" aria-pressed={view === 'map'} onClick={() => show('map')}>
            Planning map
          </button>
          <button type="button" aria-pressed={view === 'hud'} onClick={() => show('hud')}>
            Helmet view{hazards.length > 0 ? ` · ${hazards.length} new hazard` : ''}
          </button>
        </nav>
      </header>
      {view === 'map' ? <MarsMap /> : <HelmetHUD onHazard={addHazard} />}
    </div>
  )
}
