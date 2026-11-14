import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App'

// /nav is the tablet navigation screen; everything else is the planning web app. No router needed.
const NavApp = lazy(() => import('./nav-ui/NavApp.tsx'))
const isNav = /^\/nav\/?$/.test(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isNav ? (
      <Suspense fallback={null}>
        <NavApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
