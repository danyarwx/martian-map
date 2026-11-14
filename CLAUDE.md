# Martian Map: Space Apps 2026 project context

Claude reads this file at the start of every session. Keep it short and up to date. Whoever changes the plan updates this file in the same commit.

## The challenge

NASA Space Apps 2026: "Interplanetary Survival Guide: Martian Map" (Intermediate).
https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/

Build a map, tool or interface that a Mars astronaut could use on a single Marswalk. It layers data from several NASA missions over one **local** site or route. The challenge text points out that Mars Trek and the USGS maps are regional or global, so a hyperlocal view is the gap we fill.

What the judges will look for (taken from the challenge text):
1. A specific science goal and a site that fits it (their own example: boxwork formations near Mount Sharp, which Curiosity studied in 2025)
2. At least 3 data types layered together: optical, thermal, spectral, topographic, geophysical, atmospheric, radiation or chemical
3. Astronaut safety: radiation / space weather, and how a suited astronaut carrying gear can actually move
4. A route that reaches the science targets and avoids obstacles such as large rocks and steep slopes
5. Ground-level imagery from rovers, so the crew knows what a stop looks like before they get there
6. A form factor: habitat planning screen, tablet, or helmet HUD

## Status (update at every handover)

Last updated: Fri 13 Nov, evening before the hackathon.

Live: https://martian-map-nasa.vercel.app (Vercel project `martian-map`, team `danyarwx-9436s-projects`)
Repo: https://github.com/danyarwx/martian-map (public, so collaborators' pushes deploy on Vercel Hobby)
Every push to `main` deploys production. Every other branch and PR gets a preview URL.

Done:
- Vite + React + TS + Leaflet app with `L.CRS.EPSG4326` (Trek tiles line up, checked on the live site)
- Layers in `src/MarsMap.tsx`: Viking color + MOLA relief (global), CTX 6 m + HiRISE 25 cm (Jezero), THEMIS day IR (thermal)
- Perseverance traverse + 708 waypoints from `public/data/*.json` (`npm run fetch-data` refreshes them)
- Map opens at Perseverance's landing point, zoom 13

Known issues:
- Scale bar uses Earth's radius, so its distances are wrong. Fix it (Mars radius 3389.5 km) or hide it before the demo
- Waypoint tooltip only shows sol + tilt. The panorama URLs in the waypoint properties aren't used yet
- No elevation data in the app yet. The HiRISE 1 m DTM is not served as tiles, so the GeoTIFF has to be downloaded and processed (see Data sources)
- Everything sits in one component (`MarsMap.tsx`). Split it into `src/map/` before 2–3 people edit it at once

Next, in order:
1. Kickoff: fill in "Our decisions" below
2. Agree on shared data formats: `src/types.ts` (`Waypoint`, `RouteSegment`, `Hazard`, `LayerDef`), which files the scripts write to `public/data`, and who owns which folder
3. `/ecc:plan` → one GitHub issue per task, each with an owner
4. Build in parallel. Feature freeze around hour 20. Then polish, README, backup demo video

Helmet view (branch `feat/helmet-hud`):
- `#hud` or the "Helmet view" tab opens it. Scripted 25 s walk: habitat (invented) → stops sol 1224, 1219 → Cheyava Falls, with a boulder-field hazard (invented) found on the way
- Contract with the map/planner: `src/types.ts` (`Hazard`, `Stop`, `LatLon`...). `HelmetHUD` takes `onHazard(h)` (App keeps the list; MarsMap should draw it) and `replan(route, walkedM, hazard)` (defaults to a simple detour in `walkScript.ts` until the real planner exists)
- Panoramas load from `public/data/panoramas/` (`npm run fetch-panoramas`), then NASA's server, then a plain backdrop. If the view looks rotated against the map, set `PANO_AZ_OFFSET_DEG` in `src/panels/hud/Panorama.tsx`

Folder ownership (to avoid merge conflicts):
- Dev 1: `src/map/` (layers, controls, drawing the route)
- Dev 2: `scripts/`, `public/data/`, `src/lib/` (slope/hazard logic, route planning)
- Dev 3 / Danya: `src/panels/` (stop card with panorama, safety panel, HUD view)

## Our decisions (fill these in at kickoff and keep them current)

- Site: Jezero is the leading option. It's the only site with verified walking-scale imagery (HiRISE 25 cm), a 1 m DTM, rover stops with panoramas and tilt, and thermal coverage. Confirm at kickoff
- Science goal: astronauts walk to Cheyava Falls (Bright Angel area, Neretva Vallis, rover stop sol 1210, 18.4975°N 77.3052°E) to sample the rock with the possible biosignature ("leopard spots", Sapphire Canyon sample). Decided 14 Nov
- Form factor: Level 1 = habitat planning map (Dev 1/2). Level 2 = helmet HUD that adds hazards found during the walk to the map and triggers a re-route (Danya, `src/panels/`, branch `feat/helmet-hud`)
- Data layers (minimum 3): TBD
- Demo story, 3 minutes: TBD

## Stack

- Frontend: Vite + React + TypeScript, deployed on Vercel
- Map: Leaflet with `L.CRS.EPSG4326`. Don't switch to Web Mercator (EPSG:3857): Mars Trek tiles are equirectangular
- Data prep: Python scripts in `/scripts`. Output is static JSON/GeoJSON in `/public/data`
- No backend unless one is truly needed. Static files cannot break during the demo
- Fonts: system fonts only (Arial, Georgia, Verdana, Tahoma). No Google Fonts. The venue Wi-Fi will be bad

## Data sources

Confirm every endpoint with a real request before building on it. Write down what works here.

| Layer | Source | Notes |
|---|---|---|
| Basemap / optical | Mars Trek WMTS: `https://trek.nasa.gov/tiles/Mars/EQ/{LayerID}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}`. VERIFIED: `Mars_Viking_MDIM21_ClrMosaic_global_232m` (jpg, max z7) | Grid = Leaflet `L.CRS.EPSG4326` (2x1 tiles at z0, 256px). Capabilities XML lists more zoom levels than really exist, so test real tiles. Many catalog IDs 404 |
| Site imagery (walking scale) | VERIFIED: `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd` (png, tiles to z17 ≈ 0.3 m/px) and `JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0` (png, to z13) | Jezero only. Bounds in `MarsMap.tsx`. Found via Trek catalog search: `https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems?q=Jezero&rows=200` |
| Site elevation | Exists in Trek catalog: `JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40` (1 m) and CTX 20 m DTM | NOT served as tiles (404). Need the GeoTIFF download (Trek UI or USGS) for slope / no-go zones. Spike C |
| Thermal | VERIFIED: `THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018` (png, max z9, 65S–65N) | Our 3rd data type |
| Topography (global) | VERIFIED: `Mars_MGS_MOLA_ClrShade_merge_global_463m` (jpg, max z7) | Too coarse to route by on foot. Fine for context |
| Topography (local, for routing) | HiRISE DTMs: https://www.uahirise.org/dtm/ | ~1 m/px. Derive slope from it to find no-go zones |
| Rover route (Perseverance) | VERIFIED: `https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json` (559 segments) and `M20_waypoints.json` (708 points) | Standard GeoJSON [lon, lat, elev]. Waypoints include sol, elevation, rover pitch/roll/tilt, distance, and panorama URLs (relative to `https://mars.nasa.gov/mmgis-maps/M20/`). Use tilt for slope warnings and panoramas for POV images |
| Ground-level photos | Perseverance raw images: https://mars.nasa.gov/mars2020/multimedia/raw-images/ | Attach photos to waypoints by sol |
| Geology | USGS Mars maps: https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars | Geologic units for the science layer |
| Route visual reference | https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/ | Shows how NASA presents a route |
| Atmosphere / radiation | Candidates: Perseverance MEDA, Curiosity REMS and RAD | Not confirmed yet. A static "typical conditions" panel with a cited source counts |

## Rules for working with Claude on this repo

- Scope is fixed for 48h. Ask before adding a new feature or dependency.
- Prioritize the demo path. If something doesn't appear in the 3-minute demo, it waits until the end.
- Keep tests minimal: unit-test only the logic the demo needs (coordinate transforms, slope/route calculation). No full TDD.
- Never commit API keys. The api.nasa.gov key goes in `.env.local`, which is gitignored. Use `DEMO_KEY` while developing.
- Cache every remote dataset we use into `/public/data` so the demo works offline.
- One feature per branch, small PRs, merge to `main` often. `main` must always deploy.
- Record where each layer's data comes from in `/public/data/SOURCES.md`. Judges ask.

## ECC commands we use

- `/ecc:plan`: break a feature into tasks before coding it
- `/build-fix`: when the build or type check fails
- `/code-review`: before merging into `main`
- `/save-session` and `/resume-session`: at handovers and before long breaks
- `/security-scan`: before the repo goes public and before submission
- `/update-docs`: README for the submission, in the final 2 hours
