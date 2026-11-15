import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import type { LatLon, RoutePlan, SiteConfig, Target } from '../types.ts'
import { createBaseMap } from '../map/baseMap.ts'
import { cumulativeM, pointAlong, turnAngle } from '../nav/geometry.ts'

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
  /** Turn the map so the direction of travel points up. Panning by hand is off while it is on. */
  headingUp: boolean
  /** The compass button: switch between heading-up and north-up. */
  onCompass: () => void
}

/** A turn closer than this gets a closer look, metres. */
const CLOSE_TURN_M = 100

/** The crew: a navigation arrow with a white edge, turned to the heading. */
const ME_ICON =
  '<div class="me"><svg class="me-arrow" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">' +
  '<circle cx="32" cy="32" r="26" fill="rgba(47,129,247,.25)"/>' +
  '<path d="M32 8 L50 52 L32 42 L14 52 Z" fill="#2f81f7" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>' +
  '</svg></div>'

/** Heading changes smaller than this do not turn the map, degrees: keeps it from wobbling. */
const MIN_TURN_DEG = 4

/**
 * Whole zoom level at which about `aheadM` metres fit between the middle of the map and its top or side edge,
 * whichever is closer, so the next stretch of route is in view while following. `visible` is the part of the
 * map on screen, which is smaller than the map while it is turned.
 */
function followZoom(map: L.Map, visible: { w: number; h: number }, aheadM: number): number {
  const halfPx = Math.max(100, Math.min(visible.w, visible.h) / 2)
  const c = map.getCenter()
  // Metres per pixel at zoom 0 here; each zoom level halves it.
  const p = map.project(c, 0)
  const mPerPx0 = map.distance(map.unproject(p, 0), map.unproject(p.add([0, 1]), 0))
  return Math.max(12, Math.min(18, Math.floor(Math.log2((mPerPx0 * halfPx) / aheadM))))
}

/** How long a stop's name stays up after a tap, ms. */
const NAME_SHOWN_MS = 4000

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const latLngs = (path: LatLon[]) => path.map((p) => [p.lat, p.lon] as L.LatLngTuple)

export default function NavMap(props: Props) {
  const { site, stops, plan, hazards, progress, follow, autoZoom, nextTurnM, aheadM, headingUp } = props
  const ref = useRef<HTMLDivElement>(null)
  /** Turns with the heading. Holds the map, sized to the screen's diagonal while turned so no corner is empty. */
  const rotRef = useRef<HTMLDivElement>(null)
  /** Holds the Leaflet controls outside the turning part, so they stay put and on screen. */
  const uiRef = useRef<HTMLDivElement>(null)
  const compassRef = useRef<HTMLSpanElement>(null)
  /** Map rotation in degrees, unwrapped (it may pass 360) so the CSS turn takes the short way round. */
  const rotation = useRef(0)
  /** Arrow angle inside the map, degrees, unwrapped like `rotation` so it never spins the long way round. */
  const arrowAngle = useRef(0)
  const setArrow = (el: HTMLElement | null | undefined, deg: number, exact = false) => {
    arrowAngle.current = exact ? deg : arrowAngle.current + turnAngle(((arrowAngle.current % 360) + 360) % 360, deg)
    if (el) el.style.transform = `rotate(${arrowAngle.current}deg)`
  }
  const visible = useRef({ w: 1, h: 1 })
  const headingUpRef = useRef(headingUp)
  headingUpRef.current = headingUp
  const layoutRef = useRef<() => void>(() => {})
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
    // Controls live outside the turning part of the map.
    const controls = ref.current.querySelector('.leaflet-control-container')
    if (controls && uiRef.current) uiRef.current.appendChild(controls)
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

    // Sizes the map to the screen, or to the screen's diagonal while heading-up, keeping its centre.
    const layout = () => {
      const rot = rotRef.current
      const wrap = rot?.parentElement
      if (!rot || !wrap) return
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      visible.current = { w, h }
      const d = headingUpRef.current ? Math.ceil(Math.hypot(w, h)) : 0
      Object.assign(rot.style, d
        ? { left: `${(w - d) / 2}px`, top: `${(h - d) / 2}px`, width: `${d}px`, height: `${d}px` }
        : { left: '0', top: '0', width: '100%', height: '100%' })
      map.invalidateSize({ animate: false })
      if (fitted.current) map.fitBounds(fitted.current, { padding: [40, 40], maxZoom: 16, animate: false })
    }
    layoutRef.current = layout
    const resize = new ResizeObserver(layout)
    if (rotRef.current?.parentElement) resize.observe(rotRef.current.parentElement)
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
        // The name sits inside the circle's element, so it turns back upright together with it.
        icon: L.divIcon({
          className: '',
          html: `<div class="${cls}">${label}<span class="nav-stop-name">${escapeHtml(stop.name)}</span></div>`,
          iconSize: [40, 40],
        }),
        title: stop.name,
        keyboard: false,
      })
        .on('click', (e) => {
          // A tap shows the name for a few seconds (hover shows it too, see nav.css).
          const el = (e.target as L.Marker).getElement()?.querySelector<HTMLElement>('.nav-stop')
          if (!el) return
          el.classList.add('nav-stop--named')
          window.setTimeout(() => el.classList.remove('nav-stop--named'), NAME_SHOWN_MS)
        })
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
      // Heading-up: the map-turning effect below points the arrow up instead.
      if (!headingUpRef.current) setArrow(p.me.getElement()?.querySelector<HTMLElement>('.me-arrow'), headingDeg ?? 0)
      if (follow) {
        const at = L.latLng(position.lat, position.lon)
        const zoom = autoZoom ? followZoom(p.map, visible.current, aheadM) + (nextTurnM !== null && nextTurnM < CLOSE_TURN_M ? 1 : 0) : null
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

  // Heading-up: size the map for turning, and no panning by hand (it would go sideways on screen).
  useEffect(() => {
    const p = parts.current
    if (!p) return
    layoutRef.current()
    if (headingUp) p.map.dragging.disable()
    else p.map.dragging.enable()
    // Wheel, pinch and double-tap zoom around the crew: the point under a finger is in the wrong place on a
    // turned map. Leaflet reads these options at each event.
    const o = p.map.options
    o.scrollWheelZoom = o.touchZoom = o.doubleClickZoom = headingUp ? 'center' : true
  }, [headingUp])

  // Turn the map against the heading, so the direction of travel points up. North-up turns it back.
  const headingDeg = progress?.headingDeg ?? null
  useEffect(() => {
    const rot = rotRef.current
    if (!rot) return
    const current = ((rotation.current % 360) + 360) % 360
    const target = headingUp && headingDeg !== null ? headingDeg : headingUp ? current : 0
    const delta = turnAngle(current, target)
    const arrow = parts.current?.me.getElement()?.querySelector<HTMLElement>('.me-arrow')
    if (Math.abs(delta) < MIN_TURN_DEG && target !== 0) {
      if (headingUp) setArrow(arrow, rotation.current, true)
      return
    }
    rotation.current += delta
    // Heading-up: the arrow turns exactly with the map, so it keeps pointing up on screen.
    if (headingUp) setArrow(arrow, rotation.current, true)
    else if (headingDeg !== null) setArrow(arrow, headingDeg)
    rot.style.transform = rotation.current ? `rotate(${-rotation.current}deg)` : ''
    // Labels stay upright: they turn back by the same amount.
    rot.style.setProperty('--unturn', `${rotation.current}deg`)
    if (compassRef.current) compassRef.current.style.transform = `rotate(${-rotation.current}deg)`
  }, [headingUp, headingDeg])

  return (
    <>
      <div ref={rotRef} className="nav-map-rot">
        <div ref={ref} className="nav-map" />
      </div>
      <div ref={uiRef} className="nav-map-ui leaflet-touch" />
      {progress && (
        <button
          type="button"
          className="map-fab compass"
          onClick={props.onCompass}
          aria-pressed={headingUp}
          aria-label={headingUp ? 'Heading up. Tap for north up' : 'North up. Tap for heading up'}
          title={headingUp ? 'Heading up · tap for north up' : 'North up · tap for heading up'}
        >
          <span ref={compassRef} className="compass-needle" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2 L17 12 H7 Z" fill="#ff5b5b" /><path d="M12 22 L7 12 H17 Z" fill="#c9d1d9" /></svg>
            <b>N</b>
          </span>
        </button>
      )}
    </>
  )
}
