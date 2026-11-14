import L from 'leaflet'
import type { SiteConfig } from '../types.ts'
import { createTileLayers, MARS_CRS } from './layers.ts'

/**
 * A Leaflet map of the site on Mars: equirectangular CRS with Mars's radius, the global basemap,
 * the site mosaics (CTX, HiRISE) on top, a layer switcher and a metric scale bar.
 * Shared by the planning screen and the tablet navigation screen.
 */
export function createBaseMap(el: HTMLElement, site: SiteConfig, options: L.MapOptions = {}) {
  const map = L.map(el, {
    crs: MARS_CRS,
    center: [site.center.lat, site.center.lon],
    zoom: site.zoom,
    minZoom: 0,
    maxZoom: 19,
    worldCopyJump: false,
    ...options,
  })
  const tiles = createTileLayers()
  Object.values(tiles.base)[0].addTo(map)
  Object.values(tiles.site).forEach((l) => l.addTo(map))
  const control = L.control.layers(tiles.base, { ...tiles.site, ...tiles.extra }, { collapsed: true }).addTo(map)
  L.control.scale({ imperial: false }).addTo(map)
  return { map, control }
}
