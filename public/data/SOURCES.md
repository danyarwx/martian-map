# Data sources

One line per dataset: file, source URL, date downloaded, what we use it for.

| File | Source | Downloaded | Used for |
|---|---|---|---|
| (tiles, not stored) | Mars Trek WMTS, Mars_Viking_MDIM21_ClrMosaic_global_232m | live | Optical basemap |
| (tiles, not stored) | Mars Trek WMTS, JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd | live | Walking-scale optical |
| (tiles, not stored) | Mars Trek WMTS, JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0 | live | Site context optical |
| (tiles, not stored) | Mars Trek WMTS, THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018 | live | Thermal overlay |
| (tiles, not stored) | Mars Trek WMTS, Mars_MGS_MOLA_ClrShade_merge_global_463m | live | Topography context |
| M20_traverse.json | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json | 14 Nov 2026 | Rover route |
| M20_waypoints.json | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json | 14 Nov 2026 | Stops, photo anchors, target coordinates |
| M20_heli_waypoints.json | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/m20_heli_waypoints.json | 14 Nov 2026 | Ingenuity's final position (flight 72) |
| jezero_terrain.json, jezero_slope.bin, jezero_elev.bin, jezero_slope.png | Built by `scripts/build_terrain.py` from the USGS Mars 2020 Terrain Relative Navigation DTMs: HiRISE 1 m `https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif`, fallback CTX 20 m `https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif`. `jezero_terrain.json` says which one was used | 14 Nov 2026 | Slope and elevation grid for route planning, slope hazard overlay |
| views/*.jpg, views/index.json | NASA Mars 2020 raw image API `https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json`, picked by `scripts/fetch_views.py`. Image ids and source links are in `views/index.json`. Credit NASA/JPL-Caltech | 14 Nov 2026 | Ground-level photo on each stop card |

## Numbers that are not files

| Value | Source | Used for |
|---|---|---|
| Surface dose rate 0.64 ± 0.12 mSv/day | Curiosity RAD, Gale crater: Hassler et al. 2014, Science 343, 1244797. Jezero has no radiation detector | Safety panel (`src/lib/safety.ts`) |
| Earth background 2.4 mSv/year | UNSCEAR 2008 report | Safety panel comparison |
| Career limit 600 mSv | NASA-STD-3001 Vol. 1 | Safety panel comparison |
| Jezero temperature, pressure, wind | Perseverance MEDA: Rodriguez-Manfredi et al. 2023, Nature Geoscience 16, 19–28 | Safety panel, typical conditions |
| Walking 2.5 km/h up to 20°, rover 10 km/h up to 15°, 8 h outside | Planning assumptions based on Apollo 15–17 surface experience and ISS EVA length (`src/lib/mobility.ts`) | Route time and no-go slopes |
