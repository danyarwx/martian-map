import L from 'leaflet'
import { MARS_RADIUS_M } from '../lib/geo.ts'

// Mars Trek WMTS, equirectangular. Tile pattern:
// https://trek.nasa.gov/tiles/Mars/EQ/{LayerID}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}
// Layer list: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars
// Verified 13 Nov: grid is 2x1 tiles at z0, 256px, top-left (-180, 90), so it matches Leaflet's EPSG4326 exactly.
// Real tiles stop at z7 (Viking, MOLA) and z9 (THEMIS) even though the capabilities XML lists more levels.
const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ'

/**
 * Mars tiles are equirectangular, so the map uses plate carree (EPSG:4326) instead of Leaflet's
 * default Web Mercator. R is Mars's radius, so distances and the scale bar are Martian metres.
 */
export const MARS_CRS: L.CRS = L.Util.extend({}, L.CRS.EPSG4326, { R: MARS_RADIUS_M })

function trekLayer(
  layerId: string,
  ext: 'jpg' | 'png',
  maxNativeZoom: number,
  bounds?: L.LatLngBoundsExpression,
) {
  return L.tileLayer(`${TREK}/${layerId}/1.0.0/default/default028mm/{z}/{y}/{x}.${ext}`, {
    maxNativeZoom,
    maxZoom: 19,
    noWrap: true,
    bounds,
    attribution: 'NASA/JPL-Caltech Mars Trek',
  })
}

// Jezero site mosaics (Mars 2020 science team, controlled). Bounds stop Leaflet requesting tiles that don't exist.
// HiRISE 25 cm/px: real tiles up to z17 (~0.3 m/px). CTX 6 m/px: up to z13. Verified 13 Nov.
const JEZ_HIRISE_BOUNDS: L.LatLngBoundsExpression = [[18.3067994, 77.2229331], [18.669315, 77.583964]]
const JEZ_CTX_BOUNDS: L.LatLngBoundsExpression = [[18.2110274, 77.1604655], [18.7211945, 77.6991776]]

export function createTileLayers() {
  const themis = trekLayer('THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018', 'png', 9)
  themis.setOpacity(0.7)
  return {
    base: {
      'Viking color (optical)': trekLayer('Mars_Viking_MDIM21_ClrMosaic_global_232m', 'jpg', 7),
      'MOLA shaded relief (topography)': trekLayer('Mars_MGS_MOLA_ClrShade_merge_global_463m', 'jpg', 7),
    },
    // Site imagery on top of the global basemap: CTX for context, HiRISE for walking-scale detail
    site: {
      'CTX Jezero 6 m (optical)': trekLayer('JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0', 'png', 13, JEZ_CTX_BOUNDS),
      'HiRISE Jezero 25 cm (optical)': trekLayer(
        'JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd',
        'png',
        17,
        JEZ_HIRISE_BOUNDS,
      ),
    },
    // Thermal: THEMIS daytime IR, 100 m/px, covers 65S-65N
    extra: { 'THEMIS day IR (thermal)': themis },
  }
}
