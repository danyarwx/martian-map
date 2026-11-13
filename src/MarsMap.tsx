import { useEffect, useRef } from 'react'
import L from 'leaflet'

// Mars Trek WMTS, equirectangular. Tile pattern:
// https://trek.nasa.gov/tiles/Mars/EQ/{LayerID}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}
// Layer list: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars
// Verified 13 Nov: grid is 2x1 tiles at z0, 256px, top-left (-180, 90), so it matches Leaflet's EPSG4326 exactly.
// Real tiles stop at z7 (Viking, MOLA) and z9 (THEMIS) even though the capabilities XML lists more levels.
const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ'

function trekLayer(layerId: string, ext: 'jpg' | 'png', maxNativeZoom: number) {
  return L.tileLayer(
    `${TREK}/${layerId}/1.0.0/default/default028mm/{z}/{y}/{x}.${ext}`,
    { maxNativeZoom, maxZoom: 14, noWrap: true, attribution: 'NASA/JPL-Caltech Mars Trek' },
  )
}

// Jezero crater, Perseverance landing area (planetocentric lat, east-positive lon)
const JEZERO: L.LatLngExpression = [18.44, 77.45]

export default function MarsMap() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return

    // Mars tiles are equirectangular, so use EPSG:4326 (plate carree) instead of Leaflet's
    // default Web Mercator. With the default CRS the tiles land in the wrong places.
    const map = L.map(ref.current, {
      crs: L.CRS.EPSG4326,
      center: JEZERO,
      zoom: 7,
      minZoom: 0,
      maxZoom: 14,
      worldCopyJump: false,
    })

    const viking = trekLayer('Mars_Viking_MDIM21_ClrMosaic_global_232m', 'jpg', 7).addTo(map)
    const mola = trekLayer('Mars_MGS_MOLA_ClrShade_merge_global_463m', 'jpg', 7)

    // Thermal: THEMIS daytime IR, 100 m/px, covers 65S-65N
    const themis = trekLayer('THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018', 'png', 9)
    themis.setOpacity(0.7)

    const overlays: Record<string, L.Layer> = { 'THEMIS day IR (thermal)': themis }
    const control = L.control.layers(
      { 'Viking color (optical)': viking, 'MOLA shaded relief (topography)': mola },
      overlays,
      { collapsed: false },
    ).addTo(map)

    L.control.scale({ imperial: false }).addTo(map)

    // Perseverance traverse + waypoints. Run `npm run fetch-data` first so these are served locally.
    // NOTE: the scale bar assumes Earth's radius. Fix it or hide it before the demo (Mars radius ≈ 3389.5 km).
    const loadGeoJson = async (path: string, name: string, opts: L.GeoJSONOptions) => {
      try {
        const res = await fetch(path)
        if (!res.ok) return
        const layer = L.geoJSON(await res.json(), opts).addTo(map)
        control.addOverlay(layer, name)
      } catch {
        /* file not downloaded yet */
      }
    }

    loadGeoJson('/data/M20_traverse.json', 'Perseverance traverse', {
      style: { color: '#ffb000', weight: 3 },
    })
    loadGeoJson('/data/M20_waypoints.json', 'Perseverance waypoints', {
      pointToLayer: (_f, latlng) =>
        L.circleMarker(latlng, { radius: 3, color: '#ffffff', weight: 1, fillOpacity: 0.8 }),
      onEachFeature: (f, layer) => {
        const p: Record<string, unknown> = f.properties ?? {}
        // Waypoints carry sol, elevation, rover tilt and panorama image paths (relative to
        // https://mars.nasa.gov/mmgis-maps/M20/). Good material for POV photos and slope warnings.
        const sol = String(p.sol ?? '')
        const tilt = typeof p.tilt === 'number' ? ` · tilt ${p.tilt.toFixed(1)}°` : ''
        layer.bindTooltip(sol !== '' ? `Sol ${sol}${tilt}` : 'Waypoint')
      },
    })

    return () => {
      map.remove()
    }
  }, [])

  return <div ref={ref} className="map" />
}
