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

## Our decisions (fill these in at kickoff and keep them current)

- Site: TBD (Jezero/Perseverance traverse or Gale/Mount Sharp boxwork. Both have rover route data and photos)
- Science goal: TBD
- Form factor: TBD
- Data layers (minimum 3): TBD
- Demo story, 3 minutes: TBD

## Stack

- Frontend: Vite + React + TypeScript, deployed on Vercel
- Map: Leaflet or OpenLayers with a custom equirectangular CRS. Mars tiles cannot go into a Web Mercator (EPSG:3857) Earth setup unchanged
- Data prep: Python scripts in `/scripts`. Output is static JSON/GeoJSON in `/public/data`
- No backend unless one is truly needed. Static files cannot break during the demo
- Fonts: system fonts only (Arial, Georgia, Verdana, Tahoma). No Google Fonts. The venue Wi-Fi will be bad

## Data sources

Confirm every endpoint with a real request before building on it. Write down what works here.

| Layer | Source | Notes |
|---|---|---|
| Basemap / optical | Mars Trek WMTS: `https://trek.nasa.gov/tiles/Mars/EQ/{LayerID}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}`. VERIFIED: `Mars_Viking_MDIM21_ClrMosaic_global_232m` (jpg, max z7) | Grid = Leaflet `L.CRS.EPSG4326` (2x1 tiles at z0, 256px). Capabilities XML lists more zoom levels than really exist, so test real tiles. Many catalog IDs 404 |
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
