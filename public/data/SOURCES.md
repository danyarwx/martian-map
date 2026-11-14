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
| jezero_crism_car.png | MRO CRISM map-projected targeted browse product "CAR" of observation FRT00005C5E, PDS Geosciences Node, dataset `MRO-M-CRISM-5-RDR-MPTARGETED-V1.0`: `https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/browse/2007/2007_139/frt00005c5e/frt00005c5e_07_brcarj_mtr3.png` (georeferencing in the `.lbl` next to it). Red = D2300 (Fe/Mg clay), green = BD2500_2 (carbonate), blue = BD1900_2 (hydrated minerals); band parameters from Viviano-Beck et al. 2014, JGR Planets 119. Credit NASA/JPL-Caltech/JHUAPL. Colours are indicators, not identifications | 14 Nov 2026 | Mineral layer (spectral data) |
| src/data/medaSol.ts (generated, in the code, not in this folder) | Perseverance MEDA, NASA PDS Atmospheres node, Mars 2020 MEDA bundle `https://pds-atmospheres.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/`: calibrated air temperature (`CAL_ATS`, the three mast sensors), derived wind (`DER_WS`) and pressure (`DER_PS`), sols 120–129 (air temperature on 5 sols, wind on 7, pressure on 10; the others are not in the archive). Built by `scripts/fetch_meda.py`: median per 30 min of local mean solar time; gust = 95th percentile of wind in the half hour; 2 half hours no sol measured are interpolated | 15 Nov 2026 | Air temperature curve, gust hours, typical conditions, Status readout |
| views/*.jpg, views/index.json | NASA Mars 2020 raw image API `https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json`, picked by `scripts/fetch_views.py`. Image ids and source links are in `views/index.json`. Credit NASA/JPL-Caltech | 14 Nov 2026 | Ground-level photo on each stop card |

## Numbers that are not files

| Value | Source | Used for |
|---|---|---|
| Surface dose rate 0.64 ± 0.12 mSv/day | Curiosity RAD, Gale crater: Hassler et al. 2014, Science 343, 1244797. Jezero has no radiation detector | Safety panel (`src/lib/safety.ts`) |
| Earth background 2.4 mSv/year | UNSCEAR 2008 report | Safety panel comparison |
| Career limit 600 mSv | NASA-STD-3001 Vol. 1 | Safety panel comparison |
| Jezero temperature, pressure, wind | Computed from the MEDA file above (`JEZERO_CONDITIONS` in `src/lib/safety.ts`). Rarer gusts above 20 m/s and dust devils: Newman et al. 2022, Science Advances 8, eabn3783 | Safety panel, typical conditions, dust storm warning text |
| Walking 2.5 km/h up to 20°, rover 10 km/h up to 15°, 8 h outside | Planning assumptions based on Apollo 15–17 surface experience and ISS EVA length (`src/lib/mobility.ts`) | Route time and no-go slopes |
| Walk-back reserve 60 min | Planning assumption (`src/lib/safety.ts`). Apollo's emergency oxygen pack lasted about 30 min at full flow; Apollo traverses were planned inside a "walk-back limit" so the crew could reach the lander on foot after a rover failure. Not a measured Mars value | Walk-back lines on the map, bail-out time per stop, latest turn-back |
| Typical sol: daylight 06:00–18:00; air about −78 °C before dawn to −31 °C around 15:00; gust hours 11:00–17:30 | Air temperature and gust hours: the MEDA medians above (`src/lib/schedule.ts`); gust hours = daytime half hours whose 95th-percentile wind is at least 8 m/s. A typical sol, not a forecast. Daylight: about 12 h at 18° N, shifting by under an hour over the year | Suggested departure time, time-of-day alerts on the tablet |
| Dust storm and solar particle event warnings | Simulated events (buttons on the tablet), not forecasts. Dust: MEDA gusts (above). Solar particle events at the surface: Curiosity RAD, Hassler et al. 2014. Returning to shelter when one is announced is our planning assumption (`HAZARD_EVENTS` in `src/lib/safety.ts`) | Abort-to-habitat demo |
