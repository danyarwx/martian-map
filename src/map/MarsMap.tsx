import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import type { LatLon, RoutePlan, RouteProfile, SiteConfig, Target, TerrainMeta, WalkBackImage } from '../types.ts'
import { NOTE_SIGNS, OBSTACLE_SIGN, slopeLevelLimits } from '../lib/explain.ts'
import { duration } from '../lib/format.ts'
import { MOBILITY, ROUTE_LABELS } from '../lib/mobility.ts'
import { WALK_BACK_RESERVE_MIN } from '../lib/safety.ts'
import { displayLine } from '../nav/display.ts'
import { createBaseMap } from './baseMap.ts'
import { MINERAL_LAYER, MINERAL_LEGEND } from './layers.ts'

interface Props {
  site: SiteConfig
  /** The habitat where it stands now, which may not be the site's landing point. */
  habitat: Target
  /** Destinations the user added. */
  custom: Target[]
  /** Header of the elevation grid, null until loaded. */
  terrainMeta: TerrainMeta | null
  /** Lines of equal walking time back to the habitat, null until the first plan. */
  walkBack: WalkBackImage | null
  /** Ids of the targets chosen for the route. */
  selected: ReadonlySet<string>
  /** The route the user chose. */
  plan: RoutePlan | null
  /** The alternative route, drawn faintly underneath, or null when there is no real alternative. */
  otherPlan: RoutePlan | null
  /** Stop whose card is open. */
  focusId: string | null
  /** True while the next click on the map adds a point. */
  adding: boolean
  /** Opens a stop's card. A click on a marker never changes the route. */
  onFocus: (id: string) => void
  /** Called when a marker is dropped. Returns null when the move is accepted, else the reason it is not. */
  onMoveHabitat: (p: LatLon) => string | null
  onMovePoint: (id: string, p: LatLon) => string | null
  /** A click on the map itself while `adding` is on. */
  onPick: (p: LatLon) => void
  /** A click on the alternative route chooses it. */
  onProfile: (profile: RouteProfile) => void
}

/** Route line colour per slope class: easy, moderate, close to the limit. */
const LEVEL_COLORS = ['#5ce1e6', '#ffd166', '#ff5da2']
/** Colour per kind of route note, for the line from a turn to the ground it avoids. */
const NOTE_COLORS = { 'no-go': '#f85149', slow: '#ffd166', steep: '#ff5da2' }
/** From this zoom on, route notes stay open next to the path instead of showing on hover. */
const NOTES_OPEN_ZOOM = 15

/** Whole degrees for the legend. The planner keeps the exact thresholds. */
const deg = (v: number) => String(Math.round(v))

export default function MarsMap(props: Props) {
  const { site, habitat, custom, terrainMeta, walkBack, selected, plan, otherPlan, focusId, adding } = props
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const stopsRef = useRef<L.LayerGroup | null>(null)
  const routeRef = useRef<L.LayerGroup | null>(null)
  const notesRef = useRef<L.LayerGroup | null>(null)
  const layersRef = useRef<L.Control.Layers | null>(null)
  const handlers = useRef(props)
  handlers.current = props
  /** True while a marker is being dragged: the markers are not rebuilt under the pointer. */
  const dragging = useRef(false)
  /** Bumped after every drop to redraw the markers, also when the drop was refused. */
  const [drops, setDrops] = useState(0)
  /** The pair of routes last drawn, to tell a switch between the two from a new plan. */
  const drawn = useRef<{ plan: RoutePlan | null; other: RoutePlan | null }>({ plan: null, other: null })
  /** The route area last fitted into view. Fitted again when the map's container changes size. */
  const fitted = useRef<L.LatLngBounds | null>(null)

  // Map, tile layers and static overlays: built once per site.
  useEffect(() => {
    if (!ref.current) return
    const { map, control } = createBaseMap(ref.current, site)
    mapRef.current = map
    layersRef.current = control

    // The mineral layer explains its colours while it is on.
    const minerals = new L.Control({ position: 'bottomright' })
    minerals.onAdd = () => {
      const el = L.DomUtil.create('div', 'route-legend')
      el.innerHTML =
        '<strong>Mineral indicators</strong>' +
        MINERAL_LEGEND.map(({ color, label }) => `<span><i style="background:${color}"></i>${label}</span>`).join('') +
        '<span class="legend-note">CRISM band depths, 18 m/px.<br>Hints for where to sample, not proof.</span>'
      return el
    }
    map.on('overlayadd', (e) => e.name === MINERAL_LAYER && minerals.addTo(map))
    map.on('overlayremove', (e) => e.name === MINERAL_LAYER && minerals.remove())

    let alive = true
    const getJson = async <T,>(path: string): Promise<T | null> => {
      try {
        const res = await fetch(path)
        return res.ok ? ((await res.json()) as T) : null
      } catch {
        return null // file not downloaded yet: run `npm run fetch-data`
      }
    }

    getJson<GeoJSON.GeoJsonObject>('/data/M20_traverse.json').then((data) => {
      if (!alive || !data) return
      const layer = L.geoJSON(data, { style: { color: '#ffb000', weight: 1.5, opacity: 0.6 } }).addTo(map)
      layer.bringToBack()
      control.addOverlay(layer, 'Perseverance traverse')
    })
    getJson<GeoJSON.GeoJsonObject>('/data/M20_waypoints.json').then((data) => {
      if (!alive || !data) return
      const layer = L.geoJSON(data, {
        pointToLayer: (_f, latlng) =>
          L.circleMarker(latlng, { radius: 3, color: '#ffffff', weight: 1, fillOpacity: 0.8 }),
        onEachFeature: (f, l) => {
          const p: Record<string, unknown> = f.properties ?? {}
          const tilt = typeof p.tilt === 'number' ? ` · tilt ${p.tilt.toFixed(1)}°` : ''
          l.bindTooltip(`Sol ${String(p.sol ?? '?')}${tilt}`)
        },
      })
      control.addOverlay(layer, 'Perseverance stops')
    })

    routeRef.current = L.layerGroup().addTo(map)
    // Route notes sit above the lines and below the stop markers, so stops keep their clicks.
    map.createPane('notes').style.zIndex = '550'
    notesRef.current = L.layerGroup().addTo(map)
    stopsRef.current = L.layerGroup().addTo(map)

    // Leaflet does not notice when its container is resized by the layout; keep the centre where it was.
    const resize = new ResizeObserver(() => {
      map.invalidateSize({ pan: false })
      if (fitted.current) map.fitBounds(fitted.current, { padding: [50, 50], maxZoom: 15, animate: false })
    })
    resize.observe(ref.current)

    return () => {
      alive = false
      resize.disconnect()
      map.remove()
      mapRef.current = null
      layersRef.current = null
    }
  }, [site])

  // Slope classes from the elevation model: what the planner treats as slow or no-go ground.
  useEffect(() => {
    const map = mapRef.current
    const control = layersRef.current
    if (!map || !control || !terrainMeta) return
    const overlay = L.imageOverlay(
      site.terrain.overlay,
      [[terrainMeta.south, terrainMeta.west], [terrainMeta.north, terrainMeta.east]],
      { opacity: 0.75, attribution: 'Slope: USGS Mars 2020 TRN DTM' },
    ).addTo(map)
    control.addOverlay(overlay, 'Slope hazard (topography)')
    routeRef.current?.eachLayer((l) => (l as L.Polyline).bringToFront())
    return () => {
      control.removeLayer(overlay)
      overlay.remove()
    }
  }, [site, terrainMeta])

  // Walk-back lines: how long it takes to walk straight home from anywhere, with the emergency reserve in green.
  useEffect(() => {
    const map = mapRef.current
    const control = layersRef.current
    if (!map || !control || !terrainMeta || !walkBack) return
    const canvas = document.createElement('canvas')
    canvas.width = walkBack.width
    canvas.height = walkBack.height
    const pixels = new ImageData(walkBack.width, walkBack.height)
    pixels.data.set(walkBack.rgba)
    canvas.getContext('2d')?.putImageData(pixels, 0, 0)
    const group = L.layerGroup([
      L.imageOverlay(
        canvas.toDataURL(),
        [[terrainMeta.south, terrainMeta.west], [terrainMeta.north, terrainMeta.east]],
        { interactive: false },
      ),
      ...walkBack.labels.map(({ minutes, at }) => {
        const reserve = minutes === WALK_BACK_RESERVE_MIN
        const html = `<div class="walkback-label${reserve ? ' walkback-label--reserve' : ''}">${minutes} min${reserve ? ' · reserve' : ''}</div>`
        return L.marker([at.lat, at.lon], {
          icon: L.divIcon({ className: '', html, iconSize: [0, 0] }),
          interactive: false,
          keyboard: false,
        })
      }),
    ]).addTo(map)
    control.addOverlay(group, 'Walk-back time (on foot to habitat)')
    return () => {
      control.removeLayer(group)
      group.remove()
    }
  }, [terrainMeta, walkBack])

  // "Add point on map": crosshair cursor, and the next click on the map itself picks the spot.
  // Clicks on markers do not reach the map, so no point is created under an existing marker.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !adding) return
    const pick = (e: L.LeafletMouseEvent) => handlers.current.onPick({ lat: e.latlng.lat, lon: e.latlng.lng })
    map.on('click', pick)
    map.getContainer().classList.add('map--adding')
    return () => {
      map.off('click', pick)
      map.getContainer().classList.remove('map--adding')
    }
  }, [adding])

  // Habitat, suggested targets and the user's own points.
  useEffect(() => {
    const group = stopsRef.current
    if (!group || dragging.current) return
    group.clearLayers()
    const visitNo = new Map<string, number>()
    plan?.order.slice(1, -1).forEach((id, i) => visitNo.set(id, i + 1))
    const customIds = new Set(custom.map((t) => t.id))

    for (const stop of [habitat, ...site.targets, ...custom]) {
      const isHabitat = stop.id === habitat.id
      const isCustom = customIds.has(stop.id)
      const on = isHabitat || selected.has(stop.id)
      const blocked = isHabitat ? plan?.habitatNoFooting : !plan?.habitatNoFooting && plan?.unreachable.includes(stop.id)
      const label = isHabitat ? 'H' : blocked ? '!' : on ? String(visitNo.get(stop.id) ?? '•') : '+'
      const classes = [
        'stop',
        isHabitat ? 'stop--habitat' : on ? 'stop--on' : 'stop--off',
        isCustom ? 'stop--custom' : '',
        blocked ? 'stop--blocked' : '',
        focusId === stop.id ? 'stop--focus' : '',
      ].join(' ')
      const hint = isHabitat ? `${stop.name}: drag to move` : isCustom ? `${stop.name}: drag to move` : stop.name
      const marker = L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="${classes}"><span>${label}</span></div>`,
          iconSize: [32, 32],
        }),
        title: hint,
        draggable: isHabitat || isCustom,
        zIndexOffset: isHabitat ? 500 : 0,
      })
        .bindTooltip(hint, { direction: 'top', offset: [0, -16] })
        .on('click', () => handlers.current.onFocus(stop.id))
        .addTo(group)
      if (!isHabitat && !isCustom) continue
      // Nothing is planned while dragging: the new position is reported once, on drop.
      marker.on('dragstart', () => {
        dragging.current = true
      })
      marker.on('dragend', () => {
        dragging.current = false
        const { lat, lng } = marker.getLatLng()
        const p = { lat, lon: lng }
        const refused = isHabitat ? handlers.current.onMoveHabitat(p) : handlers.current.onMovePoint(stop.id, p)
        if (refused) marker.setLatLng([stop.lat, stop.lon]) // back to where it was
        setDrops((n) => n + 1)
      })
    }
  }, [site, habitat, custom, selected, plan, focusId, drops])

  // The chosen route coloured by slope class with its notes, the alternative underneath, and the legend.
  useEffect(() => {
    const group = routeRef.current
    const notes = notesRef.current
    const map = mapRef.current
    if (!group || !notes || !map) return
    group.clearLayers()
    notes.clearLayers()
    if (!plan || plan.legs.length === 0) return
    // Lines are drawn simplified: through every 10 m cell centre a straight stretch looks like stairs.
    const linesOf = (p: RoutePlan) => p.legs.map((leg) => displayLine(leg.path).map((q) => [q.lat, q.lon] as L.LatLngTuple))

    // The other route: a pale dashed line under the chosen one. A wide invisible line over it takes the
    // click; both are vector lines, which lie below every marker, so stops and notes keep their clicks.
    const other = otherPlan && otherPlan.legs.length > 0 ? otherPlan : null
    if (other) {
      const otherLines = linesOf(other)
      L.polyline(otherLines, { color: '#ffffff', opacity: 0.6, weight: 2, dashArray: '6 6', interactive: false }).addTo(group)
      L.polyline(otherLines, { color: '#ffffff', opacity: 0, weight: 14, bubblingMouseEvents: false })
        .bindTooltip(`${ROUTE_LABELS[other.profile]} route: ${duration(other.totalMinutes)}`, { sticky: true })
        .on('click', (e) => {
          // While a point is being added, a click on the line is a click on the map.
          if (handlers.current.adding) handlers.current.onPick({ lat: e.latlng.lat, lon: e.latlng.lng })
          else handlers.current.onProfile(other.profile)
        })
        .addTo(group)
    }

    const lines = linesOf(plan)
    const outline = L.polyline(lines, { color: '#0e1116', weight: 8, opacity: 0.9, interactive: false }).addTo(group)
    LEVEL_COLORS.forEach((color, level) => {
      const runs = plan.legs.flatMap((leg) =>
        leg.sections.filter((s) => s.level === level).map((s) => displayLine(s.path).map((p) => [p.lat, p.lon] as L.LatLngTuple)),
      )
      if (runs.length > 0) L.polyline(runs, { color, weight: 4.5, interactive: false }).addTo(group)
    })

    // What each turn avoids: a dashed line from the turn to that ground and a cross on it.
    // Its label shows on hover only; a second permanent label per note would cover the first.
    for (const note of plan.legs.flatMap((leg) => leg.notes)) {
      if (!note.obstacle) continue
      const to: L.LatLngTuple = [note.obstacle.lat, note.obstacle.lon]
      L.polyline([[note.at.lat, note.at.lon], to], {
        color: NOTE_COLORS[note.kind],
        weight: 1.5,
        dashArray: '4 4',
        interactive: false,
        pane: 'notes',
      }).addTo(notes)
      const html = `<div class="obstacle obstacle--${note.kind}">${OBSTACLE_SIGN}</div>`
      L.marker(to, { icon: L.divIcon({ className: '', html, iconSize: [18, 18] }), pane: 'notes', keyboard: false })
        .bindTooltip(note.obstacleText ?? '', { direction: 'top', offset: [0, -8] })
        .addTo(notes)
    }

    const markers = plan.legs.flatMap((leg) =>
      leg.notes.map((note) => {
        const html = `<div class="note note--${note.kind}">${NOTE_SIGNS[note.kind]}</div>`
        const marker = L.marker([note.at.lat, note.at.lon], {
          icon: L.divIcon({ className: '', html, iconSize: [20, 20] }),
          pane: 'notes',
          keyboard: false,
        }).addTo(notes)
        return { marker, text: note.text }
      }),
    )
    let open: boolean | null = null
    const showNotes = () => {
      const now = map.getZoom() >= NOTES_OPEN_ZOOM
      if (now === open) return
      open = now
      for (const { marker, text } of markers) {
        marker.unbindTooltip()
        marker.bindTooltip(text, { permanent: now, direction: 'right', offset: [10, 0], className: 'note-tip' })
      }
    }
    showNotes()
    map.on('zoomend', showNotes)

    const m = MOBILITY[plan.mobility]
    const [moderate, steep] = slopeLevelLimits(m)
    const labels = [`under ${deg(moderate)}°`, `${deg(moderate)}–${deg(steep)}°`, `${deg(steep)}–${deg(m.maxSlopeDeg)}°`]
    const legend = new L.Control({ position: 'bottomleft' })
    legend.onAdd = () => {
      const el = L.DomUtil.create('div', 'route-legend')
      el.innerHTML =
        '<strong>Slope on the route</strong>' +
        labels.map((label, i) => `<span><i style="background:${LEVEL_COLORS[i]}"></i>${label}</span>`).join('') +
        `<span><b>${NOTE_SIGNS['no-go']}</b> turn <b>${OBSTACLE_SIGN}</b> what it avoids</span>` +
        (other ? '<span><i class="other"></i>other route (click to choose)</span>' : '') +
        `<span><i style="background:#7ee2a0"></i>${WALK_BACK_RESERVE_MIN} min walk back to habitat</span>`
      return el
    }
    legend.addTo(map) // added after the scale bar, so it sits above it

    // Fit the view when a new plan arrives, not when the user only switches between the two routes.
    const switched = plan === drawn.current.other && otherPlan === drawn.current.plan
    drawn.current = { plan, other: otherPlan }
    if (!switched) {
      fitted.current = outline.getBounds()
      // No animation: the view must land on the route even when the tab is in the background.
      map.fitBounds(fitted.current, { padding: [50, 50], maxZoom: 15, animate: false })
    }
    return () => {
      map.off('zoomend', showNotes)
      legend.remove()
    }
  }, [plan, otherPlan])

  // Opening a stop's card brings it into view, without changing the zoom.
  useEffect(() => {
    const map = mapRef.current
    const stop = [habitat, ...site.targets, ...custom].find((s) => s.id === focusId)
    if (!map || !stop) return
    const at = L.latLng(stop.lat, stop.lon)
    if (!map.getBounds().pad(-0.15).contains(at)) map.panTo(at)
  }, [focusId]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} className="map" />
}
