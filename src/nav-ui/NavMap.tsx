import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import type { LatLon, RoutePlan, SiteConfig, Target } from '../types.ts'
import { createBaseMap } from '../map/baseMap.ts'
import { cumulativeM, pointAlong } from '../nav/geometry.ts'

/** Where the crew is on the route, while navigating. */
export interface NavProgress {
  position: LatLon | null
  headingDeg: number | null
  legIndex: number
  legAlongM: number
}

interface Props {
  site: SiteConfig
  /** Stops to draw, with their label ('H' for the habitat, else the visiting number). */
  stops: { stop: Target; label: string; done: boolean }[]
  /** The route: planned, or the one being followed. */
  plan: RoutePlan | null
  /** Steep stretches to mark on the route. */
  hazards: LatLon[]
  /** Null on the planning screen. */
  progress: NavProgress | null
  /** Keep the crew in the middle of the map. */
  follow: boolean
  /** Choose the zoom while following. Off once the user zooms by hand, until Re-centre. */
  autoZoom: boolean
  /** Distance to the next turn, metres, to zoom in a step as it comes close. Null when none. */
  nextTurnM: number | null
  /** How far ahead the map should show while following, metres. */
  aheadM: number
  /** Called with false when the user pans the map by hand. */
  onFollow: (on: boolean) => void
  /** Called when the user zooms by hand while navigating. */
  onUserZoom: () => void
}

/** A turn closer than this gets a closer look, metres. */
const CLOSE_TURN_M = 100

/** The crew: a navigation arrow with a white edge, turned to the heading. */
const ME_ICON =
  '<div class="me"><svg class="me-arrow" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">' +
  '<circle cx="32" cy="32" r="26" fill="rgba(47,129,247,.25)"/>' +
  '<path d="M32 8 L50 52 L32 42 L14 52 Z" fill="#2f81f7" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>' +
  '</svg></div>'

/**
 * Whole zoom level at which about `aheadM` metres fit between the middle of the map and its top or side edge,
 * whichever is closer, so the next stretch of route is in view while following.
 */
function followZoom(map: L.Map, aheadM: number): number {
  const size = map.getSize()
  const halfPx = Math.max(100, Math.min(size.x, size.y) / 2)
  const c = map.getCenter()
  // Metres per pixel at zoom 0 here; each zoom level halves it.
  const p = map.project(c, 0)
  const mPerPx0 = map.distance(map.unproject(p, 0), map.unproject(p.add([0, 1]), 0))
  return Math.max(12, Math.min(18, Math.floor(Math.log2((mPerPx0 * halfPx) / aheadM))))
}

const latLngs = (path: LatLon[]) => path.map((p) => [p.lat, p.lon] as L.LatLngTuple)

export default function NavMap(props: Props) {
  const { site, stops, plan, hazards, progress, follow, autoZoom, nextTurnM, aheadM } = props
  const ref = useRef<HTMLDivElement>(null)
  const parts = useRef<{
    map: L.Map
    outline: L.Polyline
    done: L.Polyline
    ahead: L.Polyline
    stops: L.LayerGroup
    hazards: L.LayerGroup
    me: L.Marker
  } | null>(null)
  const handlers = useRef(props)
  handlers.current = props
  /** The zoom this code last set while following, or null. Any other zoom the map ends on is the user's. */
  const wanted = useRef<number | null>(null)
  const fitted = useRef<L.LatLngBounds | null>(null)

  // Map and the layers updated on every position: built once.
  useEffect(() => {
    if (!ref.current) return
    const { map } = createBaseMap(ref.current, site, { zoomControl: false })
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    const outline = L.polyline([], { color: '#0e1116', weight: 11, opacity: 0.85, interactive: false }).addTo(map)
    const done = L.polyline([], { color: '#8a94a1', weight: 6, opacity: 0.8, interactive: false }).addTo(map)
    const ahead = L.polyline([], { color: '#5ce1e6', weight: 7, interactive: false }).addTo(map)
    const hazardGroup = L.layerGroup().addTo(map)
    const stopGroup = L.layerGroup().addTo(map)
    const me = L.marker([site.center.lat, site.center.lon], {
      icon: L.divIcon({ className: '', html: ME_ICON, iconSize: [64, 64] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    })
    // Panning by hand stops following. Zooming by hand keeps following but leaves the zoom to the user.
    map.on('dragstart', () => handlers.current.onFollow(false))
    map.on('zoomend', () => {
      const { progress: navigating, autoZoom: auto } = handlers.current
      if (navigating && auto && wanted.current !== null && map.getZoom() !== wanted.current) {
        wanted.current = null
        handlers.current.onUserZoom()
      }
    })
    parts.current = { map, outline, done, ahead, stops: stopGroup, hazards: hazardGroup, me }

    const resize = new ResizeObserver(() => {
      map.invalidateSize({ pan: false })
      if (fitted.current) map.fitBounds(fitted.current, { padding: [40, 40], maxZoom: 16, animate: false })
    })
    resize.observe(ref.current)
    return () => {
      resize.disconnect()
      map.remove()
      parts.current = null
    }
  }, [site])

  // Distance along each leg, for splitting the line at the crew's position.
  const cums = useMemo(() => plan?.legs.map((l) => cumulativeM(l.path)) ?? [], [plan])

  // The whole route, and the planning view fitted to it.
  useEffect(() => {
    const p = parts.current
    if (!p) return
    const all = plan?.legs.flatMap((l) => latLngs(l.path)) ?? []
    p.outline.setLatLngs(all)
    p.ahead.setLatLngs(all)
    p.done.setLatLngs([])
    if (!progress && all.length > 0) {
      fitted.current = p.outline.getBounds()
      p.map.fitBounds(fitted.current, { padding: [40, 40], maxZoom: 16, animate: false })
    }
  }, [plan]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stops and hazards.
  useEffect(() => {
    const p = parts.current
    if (!p) return
    p.stops.clearLayers()
    for (const { stop, label, done } of stops) {
      const cls = `nav-stop${label === 'H' ? ' nav-stop--home' : ''}${done ? ' nav-stop--done' : ''}`
      L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({ className: '', html: `<div class="${cls}">${label}</div>`, iconSize: [40, 40] }),
        title: stop.name,
        keyboard: false,
      })
        .bindTooltip(stop.name, { direction: 'top', offset: [0, -20] })
        .addTo(p.stops)
    }
    p.hazards.clearLayers()
    for (const h of hazards) {
      L.marker([h.lat, h.lon], {
        icon: L.divIcon({ className: '', html: '<div class="nav-hazard">▲</div>', iconSize: [28, 28] }),
        interactive: false,
        keyboard: false,
      }).addTo(p.hazards)
    }
  }, [stops, hazards])

  // The crew: dot with heading, walked part of the route greyed out.
  useEffect(() => {
    const p = parts.current
    if (!p || !plan) return
    if (!progress) {
      p.me.remove()
      return
    }
    fitted.current = null
    const { legIndex, legAlongM, position, headingDeg } = progress
    const leg = plan.legs[legIndex]
    if (leg) {
      const here = pointAlong(leg.path, cums[legIndex], legAlongM)
      const cut = cums[legIndex].findIndex((a) => a > legAlongM)
      const k = cut < 0 ? leg.path.length : cut
      const done = [...plan.legs.slice(0, legIndex).flatMap((l) => l.path), ...leg.path.slice(0, k), here]
      const ahead = [here, ...leg.path.slice(k), ...plan.legs.slice(legIndex + 1).flatMap((l) => l.path)]
      p.done.setLatLngs(latLngs(done))
      p.ahead.setLatLngs(latLngs(ahead))
    }
    if (position) {
      if (!p.map.hasLayer(p.me)) p.me.addTo(p.map)
      p.me.setLatLng([position.lat, position.lon])
      const arrow = p.me.getElement()?.querySelector<HTMLElement>('.me-arrow')
      if (arrow) arrow.style.transform = `rotate(${headingDeg ?? 0}deg)`
      if (follow) {
        const at = L.latLng(position.lat, position.lon)
        const zoom = autoZoom ? followZoom(p.map, aheadM) + (nextTurnM !== null && nextTurnM < CLOSE_TURN_M ? 1 : 0) : null
        if (zoom !== null && zoom !== wanted.current) {
          wanted.current = zoom
          // No animation: an animated zoom never finishes while the page is in the background.
          p.map.setView(at, zoom, { animate: false })
        } else {
          p.map.panTo(at, { animate: true, duration: 0.25 })
        }
      }
    }
  }, [plan, cums, progress, follow, autoZoom, nextTurnM, aheadM])

  return <div ref={ref} className="nav-map" />
}
