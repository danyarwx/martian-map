# Helmet view (Level 2): build instructions for agents

This is the single source of truth for building the 3D helmet view with live computer vision.
Read it fully before your first task. Progress lives in `docs/helmet/STATUS.md`; the loop prompt
for orchestrators and subagents is `docs/helmet/LOOP_PROMPT.md`.

Owner: Danya (`src/helmet/`, `src/panels/`). Branch: `feat/helmet-3d` (from `main`). Written 14 Nov 2026.

---

## 0. Rules every agent follows

1. **Section 2 (Decisions) is fixed.** Do not change it. If you think a decision is wrong, write it under
   "Questions for the human" in `STATUS.md` and carry on with the next task.
2. **One task at a time**, from `STATUS.md`, in the order allowed by its dependencies. Never start a task
   whose dependencies are not `[x]`.
3. **Stay in your files.** Each task lists the files it may create or change. Anything else needs a note in
   `STATUS.md` first. Teammates own `src/map/` (Dev 1) and `src/lib/`, `scripts/`, `public/data/` (Dev 2):
   only the tasks below that name those paths may touch them, and only as described.
4. **Every task ends green**: `npm run build` and `npm test` pass, plus the task's own validation.
   Never commit a red build. Never weaken or delete an existing test to make it pass.
5. **Commit per task** on `feat/helmet-3d`, message `helmet: <task id> <short title>`, then push.
   Never push to `main`, never force-push, never rewrite history. Merge `origin/main` into the branch
   (no rebase) when STATUS.md says a sync is due or a task needs teammates' new code.
6. **No new dependencies** except the ones in section 2.7. No backend. System fonts only (CLAUDE.md).
7. **Ask the human** (write in STATUS.md, then skip to another task) before: adding a dependency or a
   network host, changing teammates' public APIs beyond what a task specifies, touching `main`, or
   deleting data files.
8. **Honesty in the product.** Anything simulated or assumed is labelled as such in the UI or in
   `public/data/SOURCES.md`. Never present invented numbers as measurements.
9. **The CV must never see the world's ground truth.** Code in `src/helmet/cv/` imports nothing from
   `src/helmet/world/` (enforced by test T0.3). The CV gets camera pixels and the camera pose only.

---

## 1. What we are building (plain words)

The crew planned a route on "Mission control" (teammates' map, already on `main`). An astronaut now
goes outside. **Everything they see and get is in the helmet**:

- A **3D Mars built from real NASA data**: 1 m HiRISE elevation and the 25 cm HiRISE photo around the
  route, the 10 m grid for the hills further out, plus small rocks that orbit cannot see (they are
  scattered with published rock statistics).
- The presenter **walks freely** with keyboard/mouse and can **jump to any point of the planned route**.
- **Live computer vision** in the browser, from camera pixels only: two virtual eyes → stereo depth →
  rocks, steep slopes, sand, holes/drop-offs. A key shows the **CV view** (depth colours, outlines).
- A **top-down hazard map** (like Tesla's): ground the helmet has seen is coloured safe / rock / sand /
  steep / drop, shown as the helmet's mini-map and handed back to Mission control.
- When a hazard blocks the route, the **teammates' planner re-routes** (we add a "blocked cells" input).
- **Warnings from sensors and data**: real Perseverance weather readings, radiation dose, daylight left,
  walk-back time to the habitat. Not from the camera.
- **Credibility moment**: the same detector runs on a **real Perseverance stereo photo** at Cheyava Falls.

### 1.1 The 3-minute demo this must support

1. Mission control: route planned (e.g. habitat → Three Forks → delta front → Séítah). Click **Go outside**.
2. Helmet opens near the end of a leg. Presenter walks; HUD shows next stop, distance, suit data.
3. Boulders ahead that orbit missed: CV outlines them, warning appears, mini-map paints them red.
4. Press **V**: CV view shows depth colours and detections ("this is what the helmet computes").
5. The route is blocked: the planner re-routes, the new line appears in the HUD and on the mini-map.
6. Sand patch: "Loose sand ahead" warning; local guide steers around.
7. Press **R**: the same detector on a real Perseverance stereo photo at Cheyava Falls.
8. Press **Esc**: back on Mission control, the seen corridor and new hazards are on the big map.

---

## 2. Decisions (fixed, agreed with Danya on 14 Nov)

| # | Topic | Decision |
|---|---|---|
| 2.1 | Camera feed | Simulated 3D Mars from real orbital data (HiRISE 1 m DTM + 25 cm ortho), rocks added procedurally |
| 2.2 | CV | Real algorithms, running **live in the browser** (Web Worker), pixels only, no knowledge of world truth |
| 2.3 | CV credibility | Same detector also runs on a real Perseverance Navcam stereo pair, shown **in the demo** (key R) |
| 2.4 | Mapping output | Top-down hazard grid (safe / rock / sand / steep / drop / unseen), fused over time |
| 2.5 | Layout | Helmet **full screen**; hazard map as an in-helmet mini-map; Esc returns to Mission control |
| 2.6 | Movement | Free player control (keyboard + mouse); **jump to any point** of the planned route |
| 2.7 | Dependencies | Add `three` (pinned) and `@types/three` (dev). Nothing else |
| 2.8 | Re-routing | Global: teammates' planner (`src/lib/planner.ts`) with a new blocked-cells input that we add and they review. Local: our short-range planner on the hazard grid steers around rocks within the next ~30 m |
| 2.9 | Warnings | From sensors/data only (MEDA weather, radiation, daylight, walk-back), not from the camera |
| 2.10 | Hazards detected | Rocks/obstacles, steep slopes, sand/loose ground, holes/drop-offs |
| 2.11 | Terrain detail | 1 m elevation + ortho cut into tiles along the routes (script). Elsewhere: 10 m grid + procedural micro-relief, labelled "coarse terrain" |
| 2.12 | Integration | Fresh branch from `main`, plugged into Mission control ("Go outside"). The old scripted helmet stays as a hidden backup |
| 2.13 | Time | ~10 h of work. Cut order if late: holes/drop-offs → sand → real-photo test. Core: world, depth, rocks, slope, hazard map, re-route |

---

## 3. What already exists on `main` (read before coding)

- **App**: `src/App.tsx` holds habitat, targets, mobility, `usePlanner(...)`, chosen `plan` (`RoutePlan`).
  Renders `src/map/MarsMap.tsx` + `src/panels/Sidebar.tsx`. Styles and design tokens: `src/index.css` (`:root`).
- **Types**: `src/types.ts`: `LatLon`, `Target`, `Terrain` (`slope` Uint8 half-degrees, 255 = no data;
  `elev` Int16 decimetres, −32768 = no data; row 0 = north), `Mobility`, `RouteLeg` (`path`, `elev`,
  `walkHomeMin`, `notes`), `RoutePlan`, `RoutePlans`, `SiteConfig`, `StopView`.
- **Terrain grid**: `public/data/jezero_terrain.json` (+ `.bin`s): 1523 × 711 cells of ~9.49 × 10 m,
  west 77.2229, east 77.4800, south 18.4000, north 18.5200, built from the HiRISE 1 m DTM.
  Loader: `src/lib/terrain.ts` `loadTerrain(site.terrain)`.
- **Planner**: `src/lib/planner.ts` `planRoute(t, m, habitat, targets, profile)`, `planRoutes(...)`;
  A* in `src/lib/astar.ts` (`buildCostGrid(t, m, penalty?)` → seconds/metre per cell, `Infinity` = no-go;
  `findPath(cost, w, h, cellMX, cellMY, startCell, goalCell, fastestSecPerM)`; `snapToPassable`; `timeField`).
  Runs in `src/lib/planner.worker.ts` via `src/lib/usePlanner.ts`.
- **Geo**: `src/lib/geo.ts` `MARS_RADIUS_M`, `distanceM`, `toCell`, `cellCenter`, `inGrid`, `inBounds`.
- **Mobility**: `src/lib/mobility.ts` `MOBILITY.walk` (2.5 km/h, 20° limit), `slopeSpeedFactor`, `secondsPerMetre`.
- **Safety**: `src/lib/safety.ts` `SURFACE_DOSE_MSV_PER_DAY = 0.64`, `evaDoseMsv(h)`, `WALK_BACK_RESERVE_MIN = 60`.
- **Schedule**: `src/lib/schedule.ts` (typical sol model: daylight, temperature, gust hours).
- **Site**: `src/data/jezero.ts` habitat at the landing site (18.44463, 77.45089) and 6 targets.
- **Ground photos**: `public/data/views/*.jpg` + `index.json` (one rover photo per stop).
- **Tests**: `npm test` = `node --test src/lib/*.test.ts` (Node ≥ 22.18 strips TS types; works on 22.23).
  Test files are excluded from `tsc`. Put new tests next to their module as `*.test.ts` and extend the
  `test` script glob to include `src/helmet/**/*.test.ts` (task T0.2).
- **Python scripts**: `scripts/.venv` with `scripts/requirements.txt` (numpy, rasterio, pillow).
  `npm run fetch-data` creates it. DTMs live in `scripts/raw/` (not in git).
- **Map tiles** (Mars Trek WMTS, equirectangular, Leaflet `L.CRS.EPSG4326`):
  `https://trek.nasa.gov/tiles/Mars/EQ/{LayerID}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}`;
  HiRISE 25 cm layer `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd` (png, real tiles to z17).
- **Old helmet** (scripted, real rover panoramas): branch `feat/helmet-hud`. Useful code to port:
  `src/panels/geo.ts` (bearing, angleDiff, offsetM, toLocalM, pathLengthM, pointAlong),
  `src/panels/hud/Overlays.tsx` (compass tape, markers, alert banner), `src/panels/hud.css`,
  `scripts/build_panoramas.py` (CAHVORE + attitude quaternion handling: reuse for T6.1).

### 3.1 Environment facts (cloud sessions)

- Allowed hosts so far: `mars.nasa.gov`, `trek.nasa.gov`, npm/PyPI. **`planetarymaps.usgs.gov` is NOT
  allowed yet**; T1.1 needs it. If blocked, write in STATUS.md "ask human to allow planetarymaps.usgs.gov".
- The 1 m DTM is 1.8 GB. Prefer windowed reads over HTTP (`rasterio.open('/vsicurl/<url>')` +
  `from_bounds` windows) so only the tiles we need are downloaded. Fall back to the full download only
  if windowed reads fail, and delete `scripts/raw/*.tif` afterwards if disk is short.
- NASA's MMGIS panorama files (`Layers/mosaics/...`) are 404. The raw-image feed works:
  `https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=N`.
  Weather feed works: `https://mars.nasa.gov/rss/api/?feed=weather&category=mars2020&feedtype=json`.
- Do not try to bypass site protections (spoofed referrers, probing private endpoints). Use public feeds.
- Chromium + Playwright are preinstalled (`require('playwright')`); use them for screenshots and the
  CV evaluation harness. Do not add Playwright to package.json.

---

## 4. Architecture

```
Mission control (App)                         Helmet (full screen, src/helmet/)
┌────────────────────┐  Go outside(plan, at)  ┌───────────────────────────────────────────────┐
│ usePlanner → plan  │ ─────────────────────▶ │ HelmetView.tsx (React shell, HUD, keys)       │
│ MarsMap / Sidebar  │ ◀───────────────────── │  ├─ world/   three.js scene from real data    │
│ seen-corridor layer│  Esc(hazardGrid,route) │  ├─ sim/     player, physics, cameras         │
└────────────────────┘                        │  ├─ cv/      worker: stereo→points→hazards    │
         ▲                                    │  ├─ mapping/ hazard grid fusion (0.5 m)       │
         │ planRoute(... blocked)             │  ├─ nav/     local planner + global replan    │
   src/lib/planner.ts ◀─────────────────────── │  ├─ sensors/ weather, dose, daylight, walkback│
                                              │  └─ hud/     overlays, mini-map, CV view      │
                                              └───────────────────────────────────────────────┘
```

Per frame (60 fps): `sim` moves the player → `world` renders the main view → HUD draws.
Every ~150 ms (CV tick, ≥ 4 Hz): `sim` renders the **left/right CV cameras** into small render targets
(256 × 192), reads pixels, posts them with the camera pose to the **CV worker** → worker returns depth,
detections and a local hazard patch → `mapping` fuses the patch into the hazard grid → `nav` checks the
route against the grid (local steer; global replan when a planner cell is blocked) → HUD/mini-map update.

### 4.1 Folder layout (new code)

```
src/helmet/
  contracts.ts          shared types between helmet modules (T0.1). Change only via a STATUS note.
  frames.ts             coordinate frames + conversions (T0.1)
  HelmetView.tsx        React shell: canvas, HUD, key handling, lifecycle (T2.4)
  helmet.css            styles, reusing :root tokens from src/index.css
  world/                (CV must not import) terrain tiles, far terrain, ortho, rocks, sky, scene
  sim/                  player controller, collision, jump-to, CV camera rig + capture
  cv/                   worker + pure algorithms: stereo, points, ground, obstacles, slope, sand, drop
  mapping/              HazardGrid (0.5 m), fusion, export to LatLon image/polygons
  nav/                  local planner (A* on hazard grid), global replan bridge, route following
  sensors/              weather (MEDA cache), dose, daylight, walk-back, warning rules
  hud/                  compass, markers, alerts, suit panel, mini-map, CV view, real-photo test view
  eval/                 CV evaluation harness (may import world/ AND cv/; dev only, #helmet-eval)
scripts/
  build_helmet_tiles.py 1 m DTM + 25 cm ortho tiles along routes (T1.1)
  export_routes.ts      runs the planner in Node to list route polylines for tiling (T1.0)
  fetch_weather.py      caches MEDA weather (T5.1)
  build_real_stereo.py  rectified Navcam stereo pair at Cheyava Falls (T6.1)
public/data/helmet/     tiles/, index.json, weather.json, real_stereo/
```

### 4.2 Coordinate frames (T0.1, `src/helmet/frames.ts`)

- **Geographic**: `LatLon` (planetocentric, east-positive), as everywhere in the app.
- **Local ENU** (metres): origin `O` = the **session origin** (set when entering the helmet; the jump
  point). `x` east, `y` north, `z` up. Conversion: equirectangular on the Mars sphere
  `x = (lon − O.lon)·π/180·R·cos(O.lat)`, `y = (lat − O.lat)·π/180·R`, `R = MARS_RADIUS_M`.
  Error < 1 cm over 2 km: fine.
- **three.js world**: y-up. `three = (x_east, z_up, −y_north)`. Only `frames.ts` converts; nobody else
  writes these formulas.
- **Camera**: three.js camera convention (−z forward). Heading `ψ` = degrees clockwise from north;
  pitch `θ` positive up.
- **Planner grid**: `toCell`/`cellCenter` from `src/lib/geo.ts` (row 0 north).
- **Hazard grid**: 0.5 m cells in local ENU, `col = floor((x − x0)/0.5)`, `row = floor((y0 − y)/0.5)`
  (row 0 north, like the planner).

### 4.3 Contracts (T0.1, `src/helmet/contracts.ts`) – exact shapes

```ts
export type HazardClass = 0 | 1 | 2 | 3 | 4 | 5 // 0 unseen, 1 safe, 2 rock, 3 sand, 4 steep, 5 drop
export interface Pose { x: number; y: number; z: number; headingDeg: number; pitchDeg: number } // local ENU, eye position
export interface StereoIntrinsics { width: number; height: number; fx: number; fy: number; cx: number; cy: number; baselineM: number }
export interface CvFrame {             // main thread → worker
  id: number; left: Uint8Array; right: Uint8Array // grayscale, rectified (same intrinsics, parallel axes)
  rgbLeft?: Uint8Array                  // RGB of the left image, for sand texture/colour
  intr: StereoIntrinsics; pose: Pose    // pose of the LEFT camera
}
export interface Detection { kind: 'rock' | 'sand' | 'steep' | 'drop'; x: number; y: number; radiusM: number
  heightM?: number; slopeDeg?: number; distanceM: number; confidence: number; bbox?: [number, number, number, number] }
export interface CvResult {             // worker → main thread
  id: number; ms: number
  disparity: Float32Array               // per pixel, NaN = invalid (for the CV view)
  detections: Detection[]
  patch: { x0: number; y0: number; cols: number; rows: number; cls: Uint8Array; conf: Float32Array } // local hazard patch, 0.5 m cells, aligned to grid
}
export interface HelmetEntry { plan: RoutePlan; startAt: LatLon; legIndex: number } // from Mission control
export interface HelmetExit { seen: { bounds: { west: number; south: number; east: number; north: number }; png: string } // data URL, for a Leaflet ImageOverlay
  hazards: { at: LatLon; kind: Detection['kind']; radiusM: number }[]; plan: RoutePlan | null }
```

---

## 5. Algorithms (what "real CV" means here)

All CV runs in `src/helmet/cv/worker.ts` (module worker, `new Worker(new URL(...), { type: 'module' })`,
like the planner worker). Pure functions live in separate files so Node tests can run them.

### 5.1 Stereo depth (`cv/stereo.ts`)
- Input: rectified grayscale 256 × 192, baseline **0.30 m** (helmet stereo pair; Perseverance Navcam is
  0.424 m), horizontal FOV **70°** for the CV cameras.
- **Census transform** 5 × 5 (24-bit) on both images → Hamming cost for disparities 0..47 →
  aggregate with a **box filter** (9 × 9) per disparity using a running sum (O(W·H·D)) →
  winner-takes-all → **sub-pixel** parabola fit → **left-right consistency** (|dL − dR| ≤ 1, else NaN) →
  reject low-texture pixels (cost curve too flat: best/second-best ratio > 0.95 → NaN).
- Depth `Z = fx · B / d`. Valid range 1–25 m.
- Budget: ≤ 60 ms per frame on a laptop CPU in the worker. Use typed arrays, no allocations per frame.
- Test (T3.1): synthetic random-texture pair shifted by known disparity planes → median error < 0.25 px,
  ≥ 90 % valid on textured areas; a step edge keeps a sharp boundary (≤ 2 px blur).

### 5.2 Points and ground (`cv/points.ts`, `cv/ground.ts`)
- Back-project valid pixels: `X = (u − cx)·Z/fx`, `Y = (v − cy)·Z/fy` → rotate by camera pose → local
  ENU points. Subsample to ≤ 15 k points.
- **Local ground**: bin points into the 0.5 m patch; per cell take the 20th-percentile height as ground
  candidate; fit **RANSAC planes per 4 × 4 m block** (threshold 0.08 m, 60 iterations) and smooth.
  Height above ground per point = z − ground(x, y).

### 5.3 Rocks / obstacles (`cv/obstacles.ts`)
- Cell is an obstacle when ≥ 3 points rise **> 0.30 m** above local ground (a suited astronaut's safe
  step height, documented as an assumption). Connected components (8-neighbour) → `Detection`
  `{kind:'rock', radiusM, heightM (95th pct), distanceM}`. Ignore components < 2 cells unless height > 0.5 m.
- Project each component back to the left image for its `bbox` (CV view and HUD outline).

### 5.4 Steep slopes (`cv/slope.ts`)
- Per 1 m block, plane fit to ground points (least squares), slope = angle of normal from vertical.
- `steep` when > **15°** (warning) and no-go when > **20°** (`MOBILITY.walk.maxSlopeDeg`). Mark cells
  `steep` (class 4) only above 20°; 15–20° is a HUD warning, not a hazard cell.

### 5.5 Sand / loose ground (`cv/sand.ts`)
- Per 16 × 16 pixel patch of `rgbLeft` on ground pixels: features = mean luminance relative to frame
  median, local variance, gradient energy, dominant gradient orientation coherence (ripples), redness
  (r/(r+g+b)), and the patch's height roughness from 5.2.
- Classifier: a **logistic regression with ≤ 8 weights**, trained offline by the eval harness (T4.4) on
  rendered frames with labels from the world's sand mask (training only; the weights are then a constant
  in `cv/sandWeights.ts`). Inference uses pixels only. Document this split in SOURCES.md.
- Sand cells get class 3 when probability > 0.6 over ≥ 2 frames.

### 5.6 Holes / drop-offs (`cv/drop.ts`)
- From the fused **hazard grid heights** (not a single frame): a cell is `drop` when ground falls
  > **1.0 m** within **1.5 m** horizontally (scarp edge), or when, looking ahead along rays, valid ground
  disappears beyond a lip while the ray's continuation should have hit ground within 10 m (occlusion
  behind an edge). Run in the worker on the grid neighbourhood sent with the frame.

### 5.7 Hazard grid fusion (`mapping/hazardGrid.ts`)
- 0.5 m cells, covers the current tile neighbourhood (grow by 64 m blocks as needed).
- Per cell: `cls` (HazardClass), `conf` 0..1, `groundZ`, `seenAt` (frame id), log-odds per class.
  Update with each patch: `L += log(p/(1−p))` for the observed class, small decay toward unknown for
  classes not observed, clamp ±4. `cls` = argmax with `conf` = its probability; `unseen` until any
  observation; `safe` when ground seen and no hazard probability > 0.5.
- Export: `toImage()` → RGBA (colours from section 7.3) + bounds in LatLon (for Leaflet ImageOverlay and
  the mini-map), `hazardsList()` → merged clusters as `{at, kind, radiusM}`.

### 5.8 Navigation (`nav/`)
- **Route following**: the active leg path (`RouteLeg.path`, 10 m spacing) → local ENU → resample to 1 m.
- **Local planner** (`nav/localPlanner.ts`): A* on the hazard grid in a 40 × 40 m window ahead,
  cost = 1 + 4·[sand] + ∞·[rock|steep|drop] + 0.5·[unseen], goal = the route point 30 m ahead (or the
  first free one). Re-run every CV tick. Output: a guide polyline drawn on the ground (HUD) and the
  steering arrow.
- **Global replan** (`nav/replan.ts`): when hazard clusters cover a planner cell (10 m) by ≥ 30 %, or the
  local planner finds no path within the window, mark that planner cell blocked and call the teammates'
  planner (new input, T4.3) from the astronaut's position to the remaining stops in the same order.
  Run it in the existing planner worker (add a message type) so the UI never freezes. Replace the
  active plan; HUD shows "Route updated: +N min" from the plans' `totalMinutes` difference.

### 5.9 Localization
- The suit's position comes from the simulator (stand-in for suit IMU + visual odometry). Label this in
  the CV view ("pose: suit nav (simulated)"). Stretch T7.4: real visual odometry from the stereo pair.

---

## 6. World generation (what the helmet camera sees)

### 6.1 Terrain tiles from real data (T1.1 script, T2.1 loader)
- `scripts/export_routes.ts` (Node, imports `src/lib/planner.ts` + loads the `.bin` grids from disk):
  plans **every leg between the habitat and each target and between all target pairs** for `walk`,
  writes `public/data/helmet/routes.json` (polylines). Run with `node scripts/export_routes.ts`.
- `scripts/build_helmet_tiles.py`:
  - Tile = **128 m × 128 m**, 1 m elevation samples (129 × 129, shared edges) as **int16 centimetres
    relative to the tile's minimum** (+ `zMin` in metres in the index), and the HiRISE ortho at
    **0.25 m/px** (512 × 512 JPEG, q 80) from Trek z17 tiles (fetch → mosaic → crop → resample).
  - Which tiles: every tile within **150 m** of any polyline in `routes.json`, restricted to the last
    **600 m before each stop** and the first 600 m after the habitat and after each stop (demo windows).
    Add `--all-corridor` to tile whole legs if the size budget allows.
  - Size budget: **≤ 40 MB** total in `public/data/helmet/tiles/`. The script prints the total and
    refuses to write more unless `--force`.
  - `public/data/helmet/index.json`: `{ tileSizeM, sampleM, orthoMPerPx, origin: LatLon (grid anchor),
    tiles: [{ id, west, south, east, north, zMin, file, ortho }] }`. Anchor tiles to a fixed global
    grid (from the terrain grid's west/north) so they never overlap.
  - Also writes a **sand mask** per tile (`*_sand.png`, 1 bit/0.5 m) from the ortho (dark, low-texture,
    ripple-oriented areas; thresholds documented in the script). Used by the world shader colour
    variation and by the eval harness as ground truth. Never read by `cv/`.
- Sources go into `public/data/SOURCES.md` (DTM URL, Trek layer, tile scheme).

### 6.2 Scene (`world/`)
- **Near terrain**: one `BufferGeometry` per loaded 1 m tile (129 × 129 vertices), ortho as `map`,
  plus a tiling **detail normal map** (procedural, generated once on a canvas) for sub-metre texture.
  Load tiles within 400 m of the player; unload beyond 600 m.
- **Coarse fallback** (no 1 m tile): build the tile from the 10 m grid (bilinear) + fBm micro-relief
  (amplitude 0.3 m, wavelengths 2–16 m), vertex colour from slope. HUD shows "coarse terrain".
- **Far terrain**: the 10 m grid within 4 km, 20 m vertex spacing, vertex colours (Mars albedo, darker
  on steep), heavy distance fog (Mars dust haze, butterscotch).
- **Rocks** (`world/rocks.ts`): deterministic per tile (seed = tile id). Size-frequency from
  Golombek & Rapp (1997): cumulative fractional area `F(D) = k·exp(−q·D)`, `q = 1.79 + 0.152/k`;
  use `k = 0.05` on smooth floor, `k = 0.12` where the ortho is rough (bedrock). Diameters 0.15–1.5 m
  (orbit sees ≥ ~1.5 m). Rock mesh = 3–4 shared low-poly icosahedra variants scaled/rotated, instanced
  (`InstancedMesh`), half-buried (sink 30 % of height). No rocks on sand-mask cells.
- **Demo boulder field**: for each demo window, one cluster of 8–14 rocks 0.5–1.2 m across the planned
  path at ~60 % of the window, so the re-route moment always happens. Record it in SOURCES.md as
  "placed for the demo".
- **Sky**: gradient dome (butterscotch to pale at the horizon), sun direction from local time (default
  10:30 local solar time), shadows from the sun (`DirectionalLight`, shadow map 2048 around the player).
- Everything uses `MeshStandardMaterial`; target 60 fps at 1280 × 720 on integrated graphics: ≤ 300 k
  triangles, ≤ 60 draw calls.

### 6.3 Player and cameras (`sim/`)
- Eye height **1.65 m** above terrain. Walk speed 1.0 m/s × `slopeSpeedFactor` (from `mobility.ts`);
  **Shift** = ×4 (HUD shows "time ×4"). Collision: cannot walk into rock instances (radius test) or onto
  > 25° slopes.
- Controls: **W/A/S/D** or arrows move, **mouse drag** (or pointer lock on click) looks, **J** jump menu
  (habitat, the approach to each stop, "point on route" slider in km), **V** CV view, **R** real-photo
  test, **M** mini-map size, **P** pause, **H** help overlay, **Esc** back to Mission control.
- **CV camera rig**: two `PerspectiveCamera`s, 70° HFOV, 256 × 192, parallel, 0.30 m apart, at eye
  height, following head pose. Render to `WebGLRenderTarget`s every CV tick, `readRenderTargetPixels` →
  RGBA → grayscale + RGB (left) → post to worker as transferables. Never render rock IDs or depth
  buffers for the CV: **colour only**.

---

## 7. Interface (HUD)

### 7.1 Always visible
- Compass tape with heading; marker for the next stop and the final target with distances (port from
  `feat/helmet-hud` `Overlays.tsx`).
- **Suit / sensors panel** (left): O₂ % (model), EVA time left, dose so far (`evaDoseMsv`), air temp and
  pressure (MEDA, latest cached sol, labelled with its sol and date), daylight left, walk-back minutes to
  the habitat (from `RouteLeg.walkHomeMin` at the nearest path point, or `timeField` if off-route).
- **Nav panel** (right): next stop, distance, ETA, slope under foot.
- **Guide line** on the ground (local planner output) and a steering arrow.
- **Warnings** stack (top centre), one line each, severity colour, most severe first. Rules in
  `sensors/warnings.ts`: hazard ahead within 15 m on the guide path; slope > 15° under foot; walk-back
  > 60 min reserve; daylight < walk-back + 30 min; dose over the planned EVA's dose; temperature
  < −70 °C at departure. Each warning names its data source in a tooltip/help.
- **Mini-map** (bottom right, M toggles small/large): hazard grid image, planned route, guide line,
  astronaut arrow, scale bar in metres (Mars radius).
- Credit line: "Terrain: HiRISE DTM + ortho (NASA/JPL/UArizona, USGS). Rocks: simulated." etc.

### 7.2 CV view (V)
- Split: left half = left CV camera image with detection outlines (bbox + label + distance), right half =
  disparity as a colour ramp (near warm → far cool, invalid black). Footer: worker ms per frame, valid
  pixel %, number of detections, pose source. Keep the main HUD widgets.

### 7.3 Colours (tokens in `helmet.css`, derived from `:root` in `src/index.css`)
- Hazard grid: unseen transparent; safe `rgba(143,227,214,0.35)`; rock `#ff5a4e`; sand `#e8b04a`;
  steep `#ff8a3d`; drop `#b04aff`. Use the same in the mini-map, the CV view and the Leaflet layer.

### 7.4 Real-photo test (R)
- Loads `public/data/helmet/real_stereo/` (T6.1): rectified left/right PNG + `calib.json`
  (`StereoIntrinsics`). Runs the **same worker** on it. Shows the photo with detections and the
  disparity image, caption "Perseverance Navcam, sol 1210, Cheyava Falls. Same detector as the helmet."

---

## 8. Integration with Mission control

- **Go outside** (T2.5): a button in the Sidebar summary (Danya's `src/panels/Sidebar.tsx`) and on each
  stop card ("Go outside here" = start 300 m before this stop on the active plan). App holds
  `helmet: HelmetEntry | null`; when set, render `<HelmetView entry=… onExit=…>` full screen instead of
  the workspace (lazy-load with `React.lazy` so three.js is not in the planner's first load).
- **Back** (Esc): `onExit(HelmetExit)` → App stores `seen` + `hazards` → passes them to `MarsMap` as new
  optional props (`seenLayer`, `helmetHazards`) → Dev 1 draws them (task T5.4 adds the props and a
  minimal ImageOverlay + circle markers; Dev 1 reviews). If the helmet replanned, App shows the new plan.
- **URL**: `#helmet` opens the helmet with the default demo plan at the default jump point (for the
  presenter and screenshots). `#helmet-eval` opens the eval harness (dev only).
- **Backup**: the old scripted helmet = branch `feat/helmet-hud` (its Vercel preview URL goes in
  CLAUDE.md, T7.3). Optional stretch T7.5: port it to `#hud-classic`.

---

## 9. Tasks

Format: **ID – title** · deps · files · steps · done when. Lanes allow parallel subagents:
**A** data · **B** world/sim · **C** CV core · **D** mapping/nav/planner · **E** HUD/UI/sensors.
Contract changes after T0 go through a STATUS note and one agent updates `contracts.ts`.

### Milestone M0 – foundation (serial, one agent)

**T0.1 – Contracts and frames** · deps: – · files: `src/helmet/contracts.ts`, `src/helmet/frames.ts`,
`src/helmet/frames.test.ts`
- Write the types of §4.3 exactly; `frames.ts` with `toLocal(p, origin)`, `toLatLon(x, y, origin)`,
  `localToThree`, `threeToLocal`, `headingToDir`, `gridIndex`.
- Done when: tests cover round-trips (≤ 1 mm over 2 km) and axis directions (north = −z in three).

**T0.2 – Dependencies and test glob** · deps: T0.1 · files: `package.json`, `package-lock.json`
- `npm i three@0.170.0` and `npm i -D @types/three@0.170.0`. Test script →
  `node --test src/lib/*.test.ts src/helmet/**/*.test.ts` (check that the glob expands in npm's shell;
  else list folders explicitly).
- Done when: build + tests green.

**T0.3 – Import firewall test** · deps: T0.2 · files: `src/helmet/firewall.test.ts`
- Scans `src/helmet/cv/**/*.ts` for imports of `world/` or `sim/` or `eval/`; fails if any.
- Done when: test passes now and fails if you add such an import (check, then remove it).

**T0.4 – Skeleton** · deps: T0.2 · files: `src/helmet/HelmetView.tsx`, `src/helmet/helmet.css`,
`src/App.tsx` (only: `#helmet` route + lazy import)
- Full-screen canvas with a three.js renderer, a flat plane, sky colour, WASD + drag look, Esc logs exit.
- Done when: `#helmet` shows a walkable flat scene at 60 fps; Mission control unchanged otherwise.

### Milestone M1 – real terrain (lanes A + B)

**T1.0 – Export route polylines** (A) · deps: T0.2 · files: `scripts/export_routes.ts`,
`public/data/helmet/routes.json`
- Load `jezero_terrain.json` + bins with `fs`, call `planRoute` for every pair (habitat + 6 targets),
  write polylines with leg ids. Done when: file exists, 21 legs (or fewer, with unreachable ones listed).

**T1.1 – Tile builder** (A) · deps: T1.0 · files: `scripts/build_helmet_tiles.py`,
`scripts/requirements.txt` (no new packages), `public/data/helmet/index.json`, `public/data/helmet/tiles/*`,
`public/data/SOURCES.md`
- As §6.1. Windowed `/vsicurl/` read of the 1 m DTM; Trek z17 tiles for the ortho (cache raw tiles under
  `scripts/raw/trek/`, not in git). Elevation sanity check: tile median within 2 m of the 10 m grid.
- Done when: index + tiles written, ≤ 40 MB, a printed table of tile counts per demo window, and one
  PNG preview per demo window (hillshade + ortho) saved to `scripts/raw/previews/` and looked at.

**T2.1 – Terrain loader and near tiles** (B) · deps: T0.4, T1.1 · files: `src/helmet/world/tiles.ts`,
`world/terrainMesh.ts`, `world/heightField.ts`
- Load index, stream tiles around the player, build meshes, `heightAt(x, y)` (bilinear, local ENU) used
  by the player and nav. Coarse fallback per §6.2.
- Done when: jumping to each demo window shows real terrain with the ortho; walking 300 m keeps 60 fps;
  `heightAt` test against a known tile sample.

**T2.2 – Far terrain, sky, fog, sun** (B) · deps: T2.1 · files: `world/farTerrain.ts`, `world/sky.ts`
- Done when: hills on the horizon match the map (crater rim to the west visible from the delta front).

**T2.3 – Rocks** (B) · deps: T2.1 · files: `world/rocks.ts`, `world/rocks.test.ts`
- §6.2 distribution + demo boulder field + sand-mask exclusion; `rocksNear(x, y, r)` for collision and eval.
- Done when: test checks the size distribution against `F(D)` (within 20 % in 3 size bins) and determinism.

**T2.4 – Player, collision, jump-to** (B) · deps: T2.1, T2.3 · files: `src/helmet/sim/player.ts`,
`sim/controls.ts`, `sim/jump.ts`, `HelmetView.tsx`
- §6.3 controls; jump menu built from the active `RoutePlan` (habitat, 300 m before each stop, km slider).
- Done when: can't walk through rocks or up > 25°; J jumps correctly; heading/pitch persist.

**T2.5 – Go outside from Mission control** (E) · deps: T2.4 · files: `src/App.tsx`,
`src/panels/Sidebar.tsx`, `src/helmet/HelmetView.tsx`
- §8. Lazy-loaded helmet; `HelmetEntry` from the current plan; Esc returns with `HelmetExit` (empty for now).
- Done when: round trip Mission control → helmet → Mission control keeps the planner state.

### Milestone M2 – live CV and the hazard map (lanes C + D + E)

**T3.1 – Stereo** (C) · deps: T0.1 · files: `cv/census.ts`, `cv/stereo.ts`, `cv/stereo.test.ts`
- §5.1. Synthetic tests as specified, plus a timing test (warn, not fail, if > 60 ms).

**T3.2 – Points + ground** (C) · deps: T3.1 · files: `cv/points.ts`, `cv/ground.ts`, tests
- Done when: synthetic tilted plane recovered (slope error < 1°), points within 5 cm at 5 m.

**T3.3 – Obstacles** (C) · deps: T3.2 · files: `cv/obstacles.ts`, test
- Done when: synthetic boxes of 0.2 m (ignored) / 0.4 m / 0.8 m on a plane → 0.4 and 0.8 found with
  height within 10 cm, bbox projected correctly.

**T3.4 – Slope** (C) · deps: T3.2 · files: `cv/slope.ts`, test

**T3.5 – Worker + capture** (C+B) · deps: T3.3, T3.4, T2.4 · files: `cv/worker.ts`, `sim/cvRig.ts`
- §6.3 rig, transferables, one frame in flight max (drop frames if busy), pose per frame.
- Done when: in the browser, worker returns results at ≥ 4 Hz; `ms` shown in console/HUD.

**T4.1 – Hazard grid** (D) · deps: T0.1 · files: `mapping/hazardGrid.ts`, test
- §5.7 including `toImage` and `hazardsList`. Test: repeated observations converge; conflicting ones flip.

**T4.2 – Fuse CV into grid + mini-map** (D+E) · deps: T3.5, T4.1 · files: `mapping/fuse.ts`,
`hud/MiniMap.tsx`
- Done when: walking past rocks paints them red on the mini-map within 1 s, in the right place
  (compare with `rocksNear` in a dev overlay that only the eval harness may enable).

**T4.3 – Planner: blocked cells** (D, teammate's folder, they review) · deps: T0.2 · files:
`src/lib/astar.ts`, `src/lib/planner.ts`, `src/lib/planner.worker.ts`, `src/lib/planner.test.ts`
- Add optional `blocked?: Uint8Array` (1 = blocked, planner grid size) to `buildCostGrid` (→ Infinity)
  and an options arg to `planRoute`/`planRoutes` that passes it through; add
  `planFrom(t, m, from: LatLon, stops: Target[], habitat: Target, blocked)` that plans from an arbitrary
  start through the remaining stops in the given order and back to the habitat. Add a worker message
  `{ type: 'replan', ... }` without changing existing messages. Existing tests unchanged and green;
  new tests: a blocked wall forces a detour; `planFrom` starts at `from`.
- Done when: green, and a note in STATUS.md tags Dev 2 for review.

**T4.4 – Eval harness** (C, may import world) · deps: T3.5, T4.2 · files: `src/helmet/eval/*`,
`scripts/eval_helmet.cjs` (Playwright, not a dependency)
- `#helmet-eval` renders N = 60 fixed poses across demo windows, runs the worker, compares with ground
  truth from `world/` (rocks ≥ 0.3 m tall within 2–12 m; slope from the height field), prints JSON.
  Targets: rock recall ≥ 0.8, precision ≥ 0.7; depth error ≤ 5 % at 5 m; slope RMS ≤ 3°.
- Also trains the sand logistic weights (T5.2) from labelled patches.
- Done when: `node scripts/eval_helmet.cjs` prints the metrics; results pasted into STATUS.md.

**T4.5 – CV view (V)** (E) · deps: T3.5 · files: `hud/CvView.tsx`

**T4.6 – HUD core** (E) · deps: T2.4 · files: `hud/Compass.tsx`, `hud/Markers.tsx`, `hud/Alerts.tsx`,
`hud/NavPanel.tsx`, `helmet.css`
- Port from `feat/helmet-hud` (`git show origin/feat/helmet-hud:src/panels/hud/Overlays.tsx`) and adapt
  to `Pose` and `RoutePlan`.

### Milestone M3 – re-route and guidance (lane D)

**T5.0 – Local planner + guide line** (D) · deps: T4.2 · files: `nav/localPlanner.ts`, `nav/follow.ts`,
`hud/GuideLine.ts`, tests
- §5.8. Test on a synthetic grid with a rock wall and a gap.

**T5.3 – Global replan bridge** (D) · deps: T4.3, T5.0 · files: `nav/replan.ts`, `HelmetView.tsx`
- §5.8 rule; uses the planner worker's `replan` message; HUD "Route updated, +N min".
- Done when: the demo boulder field in the Three Forks window triggers a replan and the new line goes around.

### Milestone M4 – sensors, sand, drop, real photo, map hand-back (lanes A + C + E)

**T5.1 – Weather cache + sensors panel** (A+E) · deps: T4.6 · files: `scripts/fetch_weather.py`,
`public/data/helmet/weather.json`, `sensors/*.ts`, `hud/SuitPanel.tsx`, `sensors/warnings.test.ts`
- Cache the MEDA feed; pick the latest sol with temperature + pressure; show sol and date. Warnings §7.1.

**T5.2 – Sand classifier** (C) · deps: T4.4 · files: `cv/sand.ts`, `cv/sandWeights.ts`, test
- Done when: eval sand F1 ≥ 0.7 on held-out poses; sand appears yellow on the mini-map.

**T5.4 – Hand the map back** (E, touches Dev 1's map with review) · deps: T4.2 · files: `src/App.tsx`,
`src/map/MarsMap.tsx` (new optional props only), `src/map/layers.ts`
- Seen corridor ImageOverlay + hazard circles on the Leaflet map after Esc.

**T5.5 – Drop-offs** (C) · deps: T4.2 · files: `cv/drop.ts`, test (synthetic 2 m step)

**T6.1 – Real stereo pair** (A) · deps: T3.1 · files: `scripts/build_real_stereo.py`,
`public/data/helmet/real_stereo/{left.png,right.png,calib.json,README.md}`, SOURCES.md
- From the raw feed at sol 1210 (Cheyava Falls, site 56 drive 0): pick a NAVCAM_LEFT/NAVCAM_RIGHT pair
  with the same timestamp and tile suffix, low elevation angle (ground in view). Use each image's CAHV
  (ignore O/R/E), build projection matrices, rectify with Fusiello's method (numpy), resample both to
  512 × 384, write `calib.json` (fx, fy, cx, cy, baseline from |C_L − C_R|). Check: the same feature has
  the same row in both (≤ 1 px) on 10 picked points (ORB not available; use a simple patch matcher).

**T6.2 – Real-photo view (R)** (E) · deps: T6.1, T3.5 · files: `hud/RealPhotoTest.tsx`

### Milestone M5 – polish and hand-off (any lane)

**T7.1 – Performance pass** · 60 fps main view, ≥ 4 Hz CV on a mid laptop; Chrome perf trace saved.
**T7.2 – Demo script + screenshots** · `docs/helmet/DEMO.md`: exact steps/keys for §1.1, screenshots
(Playwright, deviceScaleFactor 2) of each step in `docs/helmet/img/`.
**T7.3 – Docs** · CLAUDE.md "Helmet" section (status, commands, backup URL), SOURCES.md complete,
STATUS.md final, PR `feat/helmet-3d → main` drafted (do not merge; humans review).
**T7.4 – Stretch: visual odometry** · from the stereo pair, frame-to-frame; show drift vs truth in eval.
**T7.5 – Stretch: `#hud-classic`** · port the old scripted helmet behind its own hash.

---

## 10. Definition of done (demo-ready)

- §1.1 runs end to end on the Vercel preview of `feat/helmet-3d` in Chrome on a laptop, without network
  after first load (all data in `public/data/helmet/`).
- Eval metrics meet §T4.4 targets (or STATUS.md explains the gap).
- `npm run build`, `npm test` green; no console errors during the demo path.
- Every simulated element labelled; SOURCES.md lists every dataset and constant used.
- Backup: old helmet preview URL and a recorded video of the new one (T7.2) exist.

## 11. Known traps

- React StrictMode mounts effects twice: create the three.js renderer and workers in effects with
  cleanup (dispose geometries/materials/render targets; terminate workers).
- `readRenderTargetPixels` is synchronous and stalls the GPU: only at the CV tick, only 256 × 192.
- Leaflet uses EPSG4326 here; bounds for ImageOverlay are plain lat/lon. Do not switch CRS.
- `public/data` files are served from `/data/...` at runtime.
- The DTM's west edge ends ~77.25° E: tiles west of that use the coarse fallback.
- Planner grid cells are ~9.49 m × 10 m, not square.
- Don't log or ship anything that looks like a key. Don't add hosts or dependencies without asking.
