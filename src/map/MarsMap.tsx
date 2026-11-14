import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { RoutePlan, SiteConfig, TerrainMeta } from '../types.ts'
import { NOTE_SIGNS, OBSTACLE_SIGN, slopeLevelLimits } from '../lib/explain.ts'
import { MOBILITY } from '../lib/mobility.ts'
import { createTileLayers, MARS_CRS } from './layers.ts'

interface Props {
  site: SiteConfig
  /** Ids of the targets chosen for the route. */
  selected: ReadonlySet<string>
  plan: RoutePlan | null
  /** Stop whose card is open. */
  focusId: string | null
  onToggle: (id: string) => void
  onFocus: (id: string) => void
}

/** Route line colour per slope class: easy, moderate, close to the limit. */
const LEVEL_COLORS = ['#35e0ff', '#ffd23f', '#ff7a1a']
/** Colour per kind of route note, for the line from a turn to the ground it avoids. */
const NOTE_COLORS = { 'no-go': '#c2382e', slow: '#ffd23f', steep: '#ff7a1a' }
/** From this zoom on, route notes stay open next to the path instead of showing on hover. */
const NOTES_OPEN_ZOOM = 15

/** Whole degrees for the legend. The planner keeps the exact thresholds. */
const deg = (v: number) => String(Math.round(v))

export default function MarsMap({ site, selected, plan, focusId, onToggle, onFocus }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const stopsRef = useRef<L.LayerGroup | null>(null)
  const routeRef = useRef<L.LayerGroup | null>(null)
  const notesRef = useRef<L.LayerGroup | null>(null)
  const handlers = useRef({ onToggle, onFocus })
  handlers.current = { onToggle, onFocus }

  // Map, tile layers and static overlays: built once per site.
  useEffect(() => {
    if (!ref.current) return
    const map = L.map(ref.current, {
      crs: MARS_CRS,
      center: [site.center.lat, site.center.lon],
      zoom: site.zoom,
      minZoom: 0,
      maxZoom: 19,
      worldCopyJump: false,
    })
    mapRef.current = map

    const tiles = createTileLayers()
    const base = Object.values(tiles.base)
    base[0].addTo(map)
    Object.values(tiles.site).forEach((l) => l.addTo(map))
    const control = L.control
      .layers(tiles.base, { ...tiles.site, ...tiles.extra }, { collapsed: true })
      .addTo(map)
    L.control.scale({ imperial: false }).addTo(map)

    let alive = true
    const getJson = async <T,>(path: string): Promise<T | null> => {
      try {
        const res = await fetch(path)
        return res.ok ? ((await res.json()) as T) : null
      } catch {
        return null // file not downloaded yet: run `npm run fetch-data`
      }
    }

    // Slope classes from the elevation model: what the planner treats as slow or no-go ground.
    getJson<TerrainMeta>(site.terrain.meta).then((meta) => {
      if (!alive || !meta) return
      const overlay = L.imageOverlay(
        site.terrain.overlay,
        [[meta.south, meta.west], [meta.north, meta.east]],
        { opacity: 0.75, attribution: 'Slope: USGS Mars 2020 TRN DTM' },
      ).addTo(map)
      control.addOverlay(overlay, 'Slope hazard (topography)')
      routeRef.current?.eachLayer((l) => (l as L.Polyline).bringToFront())
    })

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

    return () => {
      alive = false
      map.remove()
      mapRef.current = null
    }
  }, [site])

  // Habitat and target markers.
  useEffect(() => {
    const group = stopsRef.current
    if (!group) return
    group.clearLayers()
    const visitNo = new Map<string, number>()
    plan?.order.slice(1, -1).forEach((id, i) => visitNo.set(id, i + 1))

    for (const stop of [site.habitat, ...site.targets]) {
      const isHabitat = stop.id === site.habitat.id
      const on = isHabitat || selected.has(stop.id)
      const blocked = plan?.unreachable.includes(stop.id)
      const label = isHabitat ? 'H' : blocked ? '!' : on ? String(visitNo.get(stop.id) ?? '•') : '+'
      const classes = [
        'stop',
        isHabitat ? 'stop--habitat' : on ? 'stop--on' : 'stop--off',
        blocked ? 'stop--blocked' : '',
        focusId === stop.id ? 'stop--focus' : '',
      ].join(' ')
      L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({ className: '', html: `<div class="${classes}">${label}</div>`, iconSize: [28, 28] }),
        title: stop.name,
        zIndexOffset: isHabitat ? 500 : 0,
      })
        .bindTooltip(stop.name, { direction: 'top', offset: [0, -14] })
        .on('click', () => {
          handlers.current.onFocus(stop.id)
          if (!isHabitat) handlers.current.onToggle(stop.id)
        })
        .addTo(group)
    }
  }, [site, selected, plan, focusId])

  // Route line coloured by slope class, its notes and the colour legend.
  useEffect(() => {
    const group = routeRef.current
    const notes = notesRef.current
    const map = mapRef.current
    if (!group || !notes || !map) return
    group.clearLayers()
    notes.clearLayers()
    if (!plan || plan.legs.length === 0) return
    const lines = plan.legs.map((leg) => leg.path.map((p) => [p.lat, p.lon] as L.LatLngTuple))
    const outline = L.polyline(lines, { color: '#04222b', weight: 7, opacity: 0.9, interactive: false }).addTo(group)
    LEVEL_COLORS.forEach((color, level) => {
      const runs = plan.legs.flatMap((leg) =>
        leg.sections.filter((s) => s.level === level).map((s) => s.path.map((p) => [p.lat, p.lon] as L.LatLngTuple)),
      )
      if (runs.length > 0) L.polyline(runs, { color, weight: 3.5, interactive: false }).addTo(group)
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
      L.marker(to, { icon: L.divIcon({ className: '', html, iconSize: [16, 16] }), pane: 'notes', keyboard: false })
        .bindTooltip(note.obstacleText ?? '', { direction: 'top', offset: [0, -8] })
        .addTo(notes)
    }

    const markers = plan.legs.flatMap((leg) =>
      leg.notes.map((note) => {
        const html = `<div class="note note--${note.kind}">${NOTE_SIGNS[note.kind]}</div>`
        const marker = L.marker([note.at.lat, note.at.lon], {
          icon: L.divIcon({ className: '', html, iconSize: [18, 18] }),
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
        `<span><b>${NOTE_SIGNS['no-go']}</b> turn <b>${OBSTACLE_SIGN}</b> what it avoids</span>`
      return el
    }
    legend.addTo(map) // added after the scale bar, so it sits above it

    map.fitBounds(outline.getBounds(), { padding: [50, 50], maxZoom: 15 })
    return () => {
      map.off('zoomend', showNotes)
      legend.remove()
    }
  }, [plan])

  return <div ref={ref} className="map" />
}
