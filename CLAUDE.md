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

Last updated: Sat 14 Nov, hackathon day 1.

Live: https://martian-map-nasa.vercel.app (Vercel project `martian-map`, team `danyarwx-9436s-projects`)
Repo: https://github.com/danyarwx/martian-map (public, so collaborators' pushes deploy on Vercel Hobby)
Every push to `main` deploys production. Every other branch and PR gets a preview URL.

Done on branch `pre-hackathon` (`main` is empty for now):
- Vite + React + TS + Leaflet app with `L.CRS.EPSG4326` (Trek tiles line up, checked on the live site)
- Layers: Viking color + MOLA relief (global), CTX 6 m + HiRISE 25 cm (Jezero), THEMIS day IR (thermal)
- Perseverance traverse + 708 waypoints from `public/data/*.json`

Done on branch `feat/route-planner` (PR open, not merged yet): the excursion planner
- Habitat at Perseverance's landing site, 6 selectable science targets (`src/data/jezero.ts`)
- Fastest safe round trip through the chosen targets, planned from the slope grid (A* per leg, best visiting order). Runs in a web worker
- Two modes: on foot (2.5 km/h, 20° limit) and crew rover (10 km/h, 15° limit). Assumptions and sources are in `src/lib/mobility.ts`
- Check that the trip fits one excursion (8 h), with a warning when it does not
- Movable habitat (drag the marker or enter coordinates) and user-added destinations (click the map or enter coordinates), next to the 6 suggested targets. At most 8 targets per route
- The route explains itself: line coloured by slope, notes where it turns and what it avoids
- Two routes to choose from: Fastest and Gentlest (same slope limit, steep ground punished harder). The other one is shown dashed on the map. Planning 8 targets for both takes about 4 s
- Stop cards with a ground-level rover photo per stop (`public/data/views/`)
- Safety panel: radiation dose for the time outside and typical Jezero weather, static cited values (`src/lib/safety.ts`)
- Slope grid built from the HiRISE 1 m DTM: 1523 x 711 cells of 10 m, slope overlay on the map
- Scale bar now uses Mars's radius
- Code split into folders (see below)

Done on branch `feat/ui-mission-control` (from `feat/route-planner`, not pushed): the "Mission control" UI
- Design tokens (colours, fonts, spacing, radii) on `:root` in `src/index.css`. Design canvas: https://claude.ai/artifact/Lj6DQao3Z7QXw7hs5jWnnh (private)
- Sidebar: pinned summary (status, time / distance / dose, Fastest/Gentlest, one main action "Walk through stops"), then steps 1–4. Loading, empty and error states live in the summary
- Stop card replaces the list and steps through the route (Next / Previous / Remove)
- A click on a map marker only opens its card; it no longer takes the stop off the route
- Map refits the route when its container resizes, without animation (fixes the off-centre route on phones)

Done on branch `feat/safety-timeline` (from `feat/ui-mission-control`, not pushed):
- Walk-back lines on the map: walking time straight back to the habitat (30 / 60 / 90 min), computed in the worker from the slope grid (`src/lib/walkback.ts`). 60 min is the emergency reserve, an assumption in `src/lib/safety.ts`. Summary warns when the route goes beyond it; each stop card shows its bail-out time
- Elevation profile of the route in the Route panel, coloured by slope class
- Suggested departure time (`src/lib/schedule.ts`): scores every quarter hour by time in the midday gust hours, air temperature and daylight left. A model of a typical sol, not a forecast. Slider to try another time, clock times on every leg, latest turn-back time
- Mineral layer "CRISM minerals (spectral)", off by default, with its own legend: one cached image `public/data/jezero_crism_car.png` (18 m/px). Carbonate shows along the western margin, clay on the delta; the crater floor around the demo route is mostly featureless
- The demo route (3 stops on foot) is 1 h 30 min from the habitat at its farthest point, so it shows the walk-back warning. Decide whether the demo keeps that or uses a closer selection

Done on branch `feat/tablet-nav` (from `main`, not pushed): tablet turn-by-turn navigation at `/nav`
- Landscape tablet screen, glove-sized controls, dark theme (`src/nav-ui/`). Plan screen, then Google Maps-style navigation: instruction banner, north-up map that follows the crew arrow, walked part greyed, voice only (no on-screen captions). Panel rows: next stop, all stops and back, back to base now (planned live in a second worker, Fastest profile; past the 60 min walk-back reserve the row turns amber, a caution not a warning: "Caution · walk home 1 h 05 min, reserve 60 min". The voice caution is normal priority, said once each time the reserve is crossed, again after coming back under 55 min). Panel can be hidden (round icon top-right, floating next-stop card; reopens at stops). Map buttons in one 56 px column: re-centre (only when not following), sound, compass, zoom pill. Top right: panel toggle, red ✕ End navigation (confirm bubble). No layer menu on the tablet (Viking + CTX + HiRISE fixed). The turned map can be dragged (own pointer handler in `NavMap.tsx`); it holds its angle until re-centre. Panel footer empty for now. Stop card on the tablet has no photo (photos only on the web planning screen): name, Task, Why here, time at the stop, Done — continue. Stop card with photo and countdown, finished card
- Position is simulated (`src/nav/position.ts`, yellow SIMULATION bar: speed 1×/10×/60×, Drift 40 m = guided back, Drift 90 m = new route). The `PositionSource` interface allows an Earth-GPS-mapped source later
- Instruction engine and announcement timing in `src/nav/` (200 m / 50 m / now on foot, 400 m / 100 m by rover). Off route > 25 m for 5 s: guide back up to 50 m, beyond that replan from here (`planFixedOrder` in the worker)
- Voice API for the AI voice teammate: `docs/VOICE_API.md`. Event bus in `src/nav/events.ts`, also on `window.marsNav` and `BroadcastChannel('mars-nav')`. Optional browser TTS preview
- Planner now straightens A* paths (string pulling, at most 2% slower), which also straightens the web map line. Every bend of 20° or more is announced on its own (Slight 20–35°, Bear 35–60°, Turn 60–120°, Sharp over 120°); short left-right sidesteps stay quiet. The banner shows the heading to walk ("Head 135° SE"). Drift cue "Drifting left. Correct right." at 10 m on foot / 20 m by rover, held 3 s, before the 25 m guide-back
- Installable offline PWA (`vite-plugin-pwa`, service worker registered only from `/nav`). Precache 4.9 MB. "Download for offline" saves Trek tiles: whole area up to HiRISE z15 (~73 MB) plus HiRISE z16–17 along the route (~20 MB for the demo)
- Web app sidebar has "Send to tablet": `/nav?stops=a,b&mode=walk|rover&profile=fast|gentle[&home=lat,lon][&pt=lat,lon,name]`
- Not yet: tested on a real tablet / Safari

Branch `feat/voice-browser-tts` (from `feat/tablet-nav`): built-in voice for `/nav`. Terse radio phrasing with units spelled out, speech queue (high interrupts, stale low dropped), browser voice, radio click, mute as a round sound icon on the map while navigating, "Radio check" on Start.

Branch `feat/voice-openai-tts` (from `feat/tablet-nav`, same voice work plus): OpenAI `gpt-4o-mini-tts` through the Vercel function `api/tts.js` (key in Vercel env `OPENAI_API_KEY`, same-site requests and 300 characters max). Falls back to the browser voice when offline or after 1.5 s. No radio click before lines (removed: it sounded like crackling). This adds a backend: agree as a team before merging. OpenAI shuts this model down on 6 Jan 2027. Piper is parked.

On `feat/tablet-nav` (both voice branches merged in, then task B): safety alerts for `/nav`
- Mars clock: the excursion leaves at the planner's suggested departure (`bestDeparture`); the panel shows Mars time (LMST)
- Spoken time alerts (`src/nav/alerts.ts`): gust hours 15 min ahead and at 11:00, daylight 60 and 30 min before sunset. Turn-back time now fires (`turnBackBy` in `src/lib/schedule.ts`, shared with the web app)
- SIMULATION bar: "Dust storm" and "Solar flare" give a spoken warning and a popup on the map (`warnHazard` in `tracker.ts`). The crew chooses **Go to base** (fastest route home, `returnToBase`) or **Continue route**. While the popup waits, the warning repeats every 30 s of real time. After Continue, a red strip in the banner reopens the popup, and a reminder is spoken every 15 Mars minutes. Texts and sources in `HAZARD_EVENTS`, `src/lib/safety.ts`
- Conditions tiles in the tablet panel, under the three rows (`src/nav/conditions.ts`): Turn back, Daylight, Gust hours, Dose (so far / trip), Air (with trend), Wind. Only the time limits change colour: turn-back under 30 min amber, passed red; daylight under 60 min amber, under 30 min red; gust hours now amber. Values come from the typical sol (`windAt` / `temperatureC` in `schedule.ts`)
- "Go to base" button in the panel's Back-to-base row (on the same line as the figures), with a confirm bubble: the crew returns early by choice (`returnToBase('crew')`). The way home is always planned with the Fastest profile (the `baseRouter` worker), so the row's figure is the route the crew gets. The finished card lists the stops not visited and why
- Status readout (`statusText`, `controls.status`): code kept, but the button was removed, so nothing triggers it now
- On arrival, the stop's science sentence is said after the task
- Voice questions: a mic icon on the map (bottom 279 px, re-centre moved to 347 px). Tap, ask, and listening ends after a pause. `api/ask.js` transcribes with OpenAI `whisper-1` and answers with `gpt-5.4-nano`, using only the navigation facts from `src/nav/askContext.ts`, in about 1.5 s. The answer is spoken as an `answer` bus event; there are no captions. Offline or on error it says "Can't hear you right now." Same key and guards as `api/tts.js`; optional env vars `OPENAI_STT_MODEL` and `OPENAI_ASK_MODEL`. A second backend endpoint: tell the team. Not tested with a real voice yet (tested in the browser with a tone and with recorded speech against the function)
- Real weather (task E): `scripts/fetch_meda.py` builds `src/data/medaSol.ts` from Perseverance MEDA (NASA PDS), sols 120-129, medians per half hour. It drives the temperature curve, the gust hours (now 11:00-17:30, wind 95th percentile >= 8 m/s) and the conditions panel
- Demo mode `/nav?demo=1`: Sample cache + Delta front on foot (4.3 h, the only on-foot routes that fit go past the 60 min reserve), leaves 10:30 Mars time, 60x. Script and recording checklist: `docs/DEMO.md`
- Heading-up map (task D): the map turns with the direction of travel while following (CSS rotation in `NavMap.tsx`, no `leaflet-rotate`: it is GPL-3.0). Compass button switches to north-up; Re-centre returns to heading-up. Panning by hand is off while heading-up; Leaflet controls are moved outside the turning map
- Earth GPS mode (task D): "Real GPS" in the SIMULATION bar. The tablet's GPS drives the arrow, 1 m on Earth = 1 m on Mars, north = north, first fix = where the arrow is at the switch (`src/nav/gps.ts`). Fixes worse than 50 m are skipped, worse than 25 m shown as a warning. Clock runs at 1x. "Simulation" puts the walker back at the navigator's position
- Not tested yet: heading-up and GPS on a real tablet (GPS needs HTTPS, so the Vercel URL, and works poorly indoors)

Commands:
- `npm run fetch-data`: rover data, ground photos, terrain grid from the 20 m CTX DTM. Add `-- --full` to download the 1 m HiRISE DTM (1.8 GB) and build from that
- `npm run build-terrain`: rebuild the slope/elevation grid from the DTM in `scripts/raw/` (HiRISE if present, else CTX)
- `python scripts/fetch_meda.py [first last]`: rebuild the typical sol from MEDA data (streams about 15 MB per sol)
- `npm test`: unit tests for the planner and navigation (`src/lib/*.test.ts`, `src/nav/*.test.ts`). Works on Node 21 too (`scripts/test.mjs` bundles them with esbuild)

Known issues:
- The HiRISE DTM ends at about 77.25°E. The crater rim west of that has no slope data, so the planner treats it as no-go. The last 96 of the 708 rover waypoints (about sol 1690 onward) are in that gap. All 6 targets are inside the covered area
- All 6 targets on foot is a 20 km, 14 h trip, so it does not fit one excursion. By rover it takes 5.8 h. The demo needs a selection that fits
- The delta front target sits on a 20° cell: at the walking limit, and over the rover limit, so the rover stops at the nearest passable cell (within 50 m)
- Waypoint tooltip only shows sol + tilt
- The slope overlay image still uses the old red/orange colours, not the new slope tokens. On phones the attribution overlaps the scale bar
- No README for the submission yet

Next, in order:
1. Review `feat/route-planner` (branched from `pre-hackathon`) and merge it into `main`
2. Write the 3-minute demo story (see "Our decisions") and pick the target selection it shows
3. `/ecc:plan` → one GitHub issue per remaining task, each with an owner
4. Feature freeze around hour 20. Then polish, README, backup demo video

Folders (shared shapes live in `src/types.ts`: `Target`, `Terrain`, `Mobility`, `RouteLeg`, `RoutePlan`, `SiteConfig`):
- `src/map/`: the Leaflet map, layers, drawing the route. Dev 1
- `src/lib/`: planner (`astar.ts`, `planner.ts`, worker), mobility, safety numbers, terrain loading. Dev 2, together with `scripts/` and `public/data/`
- `src/panels/`: sidebar with target list, plan summary, stop cards, safety panel. Dev 3 / Danya
- `src/data/`: site config (habitat, targets, file paths)

## Our decisions (fill these in at kickoff and keep them current)

- Site: Jezero crater. It's the only site with verified walking-scale imagery (HiRISE 25 cm), a 1 m DTM, rover stops with ground photos and tilt, and thermal coverage
- Science goal: search for signs of ancient life. Collect the samples Perseverance cached, then revisit the rover's strongest leads
- Form factor: habitat planning screen
- Data layers: optical (HiRISE 25 cm, CTX 6 m), topographic (slope from the HiRISE 1 m DTM), thermal (THEMIS day IR), spectral (CRISM mineral indicators). Plus rover ground imagery, and radiation and weather as static cited values
- Demo story, 3 minutes: `docs/DEMO.md` (demo mode `/nav?demo=1`)

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
| Site elevation | Exists in Trek catalog: `JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40` (1 m) and CTX 20 m DTM | NOT served as tiles (404). VERIFIED downloads: USGS Mars 2020 TRN DTMs at `https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/…` (1 m, 1.8 GB) and `/CTX/…` (20 m, 10 MB). Full URLs in `scripts/fetch_data.sh`. `scripts/build_terrain.py` turns them into the slope grid. HiRISE coverage ends at about 77.25°E |
| Thermal | VERIFIED: `THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018` (png, max z9, 65S–65N) | Our 3rd data type |
| Topography (global) | VERIFIED: `Mars_MGS_MOLA_ClrShade_merge_global_463m` (jpg, max z7) | Too coarse to route by on foot. Fine for context |
| Topography (local, for routing) | HiRISE DTMs: https://www.uahirise.org/dtm/ | ~1 m/px. Derive slope from it to find no-go zones |
| Rover route (Perseverance) | VERIFIED: `https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json` (559 segments) and `M20_waypoints.json` (708 points) | Standard GeoJSON [lon, lat, elev]. Waypoints include sol, elevation, rover pitch/roll/tilt, distance, and panorama URLs (relative to `https://mars.nasa.gov/mmgis-maps/M20/`). The panorama URLs return 403, so they can't be used |
| Helicopter (Ingenuity) | VERIFIED: `https://mars.nasa.gov/mmgis-maps/M20/Layers/json/m20_heli_waypoints.json` | The file name is lowercase (`M20_heli…` returns 403). Saved as `public/data/M20_heli_waypoints.json`. Gives Ingenuity's final position |
| Ground-level photos | VERIFIED: raw image API `https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=N&search=%7CNAVCAM_LEFT` | `scripts/fetch_views.py` caches one photo per stop into `public/data/views/`, picked by the sol of the nearest waypoint |
| Spectral / minerals | VERIFIED: CRISM MTRDR browse PNG from PDS Geosciences, observation FRT00005C5E, product `brcarj` (URL in `scripts/fetch_data.sh`) | Mars Trek has NO mineral tiles over Jezero: its CRISM items are footprints only (tiles 404), TES is 16 km/px. Shown as one `imageOverlay`, bounds in `src/map/layers.ts`. Covers about 88% of the planning area. No usable olivine product. Trek catalog search needs `key=`, not `q=` |
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
