# Data sources

One line per dataset: file, source URL, date downloaded, what we use it for.

| File | Source | Downloaded | Used for |
|---|---|---|---|
| (tiles, not stored) | Mars Trek WMTS, Mars_Viking_MDIM21_ClrMosaic_global_232m | live | Optical basemap |
| (tiles, not stored) | Mars Trek WMTS, JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd | live | Walking-scale optical |
| (tiles, not stored) | Mars Trek WMTS, JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0 | live | Site context optical |
| (tiles, not stored) | Mars Trek WMTS, THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018 | live | Thermal overlay |
| (tiles, not stored) | Mars Trek WMTS, Mars_MGS_MOLA_ClrShade_merge_global_463m | live | Topography context |
| M20_traverse.json | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json | | Rover route |
| M20_waypoints.json | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json | | Stops, photo anchors |
| panoramas/N_LRGB_1224_*.jpg, N_LRGB_1219_*.jpg, N_LRGB_1210_*.jpg | https://mars.nasa.gov/mmgis-maps/M20/Layers/mosaics/ (paths from M20_waypoints.json, `images`) via `npm run fetch-panoramas` | | Helmet view backgrounds: Perseverance Navcam 360° panoramas at sols 1224, 1219, 1210 (Cheyava Falls) |
| (constant in code) | Hassler et al. 2014, Science 343, "Mars' Surface Radiation Environment Measured with the Mars Science Laboratory's Curiosity Rover": 0.64 mSv/day | | Helmet view radiation dose rate |
