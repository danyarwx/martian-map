import MarsMap from './MarsMap'

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <strong>Martian Map</strong>
        <span className="muted">Space Apps 2026 · Jezero crater (placeholder site)</span>
      </header>
      <MarsMap />
    </div>
  )
}
