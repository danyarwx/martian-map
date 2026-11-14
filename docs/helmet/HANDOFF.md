# Helmet view: handoff

Written 14 Nov 2026, ~18:15 UTC, when Danya handed the helmet work to a new owner using Claude (Max plan).
This file is for **you** (the new owner) and for **your Claude**. Read it first, then `PLAN.md` and `STATUS.md`.

---

## 1. In one minute

- **What:** the astronaut's helmet for the Martian Map hackathon project (NASA Space Apps 2026). After the
  crew plans a route on "Mission control" (the planner your teammates built on `main`), the astronaut walks
  outside in a **3D Mars made from real NASA data**. **Live computer vision** in the browser finds rocks, steep
  ground, sand and drop-offs from camera pixels. A **top-down hazard map** fills in as they walk, and the
  planner **re-routes** around what the helmet finds.
- **Where:** branch **`feat/helmet-3d`** of https://github.com/danyarwx/martian-map. Never push to `main`.
- **Spec:** `docs/helmet/PLAN.md`, written to be followed by Claude agents: decisions, architecture,
  algorithms, and 30 tasks with "done when" checks.
- **Progress:** `docs/helmet/STATUS.md`. About **17 of 30 tasks** are done (most of the hard algorithm and data
  work). The 3D world is half built, and the parts are not yet wired together into the live helmet.
- **State at handoff:** everything is committed and pushed. No agents are running. One unfinished piece is on
  branch `wip/helmet-lane-b` (rocks, see §4).
- **Tests:** `npm test` passes 126/126 and `npm run build` is green on `feat/helmet-3d` (merge commit `fc19b85` and later).

## 2. Before you start (access)

1. **GitHub:** ask Danya to add you as a collaborator on `danyarwx/martian-map` (Settings → Collaborators), so
   you can push to `feat/helmet-3d`. The repo is public, so reading works without it.
2. **Vercel:** every push to a branch gets a preview URL. You see it in the GitHub commit status or PR checks.
   Previews may need a Vercel login on Danya's team: ask Danya for access or for a share link.
3. **Where to run Claude:**
   - **Locally (recommended):** Claude Code on your laptop, in your clone. You need a real GPU to judge the 3D
     view and the frame rate; cloud sessions render with software GL at ~2 fps.
   - **Claude Code on the web:** create a cloud environment whose network allows `mars.nasa.gov`,
     `trek.nasa.gov` and `planetarymaps.usgs.gov`. You only need them if you re-run the data scripts: all
     data the app needs is already committed under `public/data/`.
4. **Plan limits:** this work ran 3 parallel agents and hit Danya's 5-hour usage limit in about 4 hours. On Max,
   run **at most 2 workers in parallel**, or do tasks one by one in a single session.

## 3. Set up and look at it

```bash
git clone https://github.com/danyarwx/martian-map && cd martian-map
git checkout feat/helmet-3d
npm ci
npm test            # expect 126 passing
npm run dev         # then open http://localhost:5173/#helmet
```

- **What you should see at `#helmet`:** real Jezero terrain near Three Forks, made from the 1 m HiRISE
  elevation model with the 25 cm HiRISE photo on top.
  - Walk with W A S D or the arrow keys; Shift hurries; drag to look; Esc returns to Mission control.
  - The status chip reads "Test walk: habitat → three-forks". That walk is a stand-in until "Go outside"
    (T2.5) passes the real plan.
- **`http://localhost:5173/`** is the teammates' Mission control planner, and it is unchanged.
- Python is only needed to rebuild data: `python3 -m venv scripts/.venv && scripts/.venv/bin/pip install -r scripts/requirements.txt`.

## 4. What exists (by folder)

| Area | Files | State |
|---|---|---|
| Contracts and frames | `src/helmet/contracts.ts`, `frames.ts` | Done. Shared types and lat/lon ↔ local metres ↔ three.js conversions |
| CV firewall | `src/helmet/firewall.test.ts` | Done. `cv/` may not import `world/`, `sim/` or `eval/`, so the CV can't cheat |
| Terrain data | `public/data/helmet/` (`index.json`, 241 tiles, `routes.json`), `scripts/build_helmet_tiles.py`, `scripts/export_routes.ts` | Done. 128 m tiles of 1 m elevation + grayscale 25 cm ortho + sand mask, covering the first and last 600 m of all 21 routes between the habitat and the 6 targets. Elsewhere the world falls back to the 10 m grid |
| 3D world | `src/helmet/world/` (`tiles`, `terrainMesh`, `heightField`, `tileGrid`, `routes`, `path`, `noise`, `scene`), `sim/defaultEntry.ts`, `HelmetView.tsx` | Terrain streaming and `heightAt` are done (T2.1). Not built yet: sky/sun/far hills (T2.2), player physics, collision and jump menu (T2.4). Movement is still the simple version inside `HelmetView.tsx` |
| Rocks | branch `wip/helmet-lane-b`, file `src/helmet/world/rocks.ts` | **Unfinished** (T2.3). 407 lines that compile, but no tests and not in the scene. Review it against PLAN §6.2 and finish it, or rewrite it |
| Computer vision | `src/helmet/cv/` (`census`, `stereo`, `points`, `ground`, `obstacles`, `slope`, `drop`, `pipeline`, `worker`, `client`) | Done and tested on synthetic scenes. About 41 ms per frame for the full pipeline. `client.ts` runs it in a Web Worker with one frame in flight. Missing: the **camera rig** that renders two eye views and feeds the worker (`sim/cvRig.ts`, rest of T3.5) |
| Hazard map | `src/helmet/mapping/hazardGrid.ts` | Done (T4.1). 0.5 m grid with log-odds fusion, image export for the mini-map and Leaflet, hazard clusters, and planner cells to block |
| Planner changes | `src/lib/astar.ts`, `planner.ts`, `planner.worker.ts`, `planner.test.ts` | Done (T4.3). Optional `blocked` cells, `planFrom(...)` from any point, and a `'replan'` worker message. **Waiting for review by Dev 2**, who owns `src/lib` |
| Sensors | `src/helmet/sensors/` (`weather`, `suit`, `warnings`), `public/data/helmet/weather.json`, `scripts/fetch_weather.py` | Logic done (part of T5.1). Missing: the HUD panel that shows it |
| Real-photo test data | `public/data/helmet/real_stereo/` (+ `scripts/build_real_stereo.py`) | Done (T6.1). A real Perseverance Navcam stereo pair from Cheyava Falls (sol 1210), rectified, with rows aligned to 0.11 px. Missing: the view that runs the CV on it (T6.2) |

## 5. What to do next (in this order)

The critical path to a working demo is **T2.3 → T2.4 → T3.5 rig → T4.2 → T5.0 → T5.3**. Side tasks can run in
parallel once their dependencies are done. Exact specs are in PLAN §9.

1. **T2.3 rocks.** Merge `origin/wip/helmet-lane-b` into a work branch, then review, test and wire it into
   the scene. Include the demo boulder field.
2. **T2.4 player.** Move movement out of `HelmetView.tsx` into `sim/`, then add collision with rocks and steep
   ground, plus the jump menu built from `index.json` → `windows`.
3. **T3.5 camera rig.** Write `sim/cvRig.ts`: two 256×192 cameras 0.30 m apart, read their pixels each CV tick,
   and send them to `CvClient`. This is the moment the helmet "sees" for the first time.
4. **T4.2 fuse into map + mini-map.** CV results update the `HazardGrid`, and a mini-map draws it. Apply the
   contract note in STATUS ("Questions") at the same time: add `CvResult.groundZ?` and `CvFrame.heights?` so
   drop-offs work on fused heights.
5. **T5.0 local guide, then T5.3 global re-route.** The re-route uses the planner's `'replan'` message in its
   **own** worker instance (see Dev 2 note in STATUS).
6. In parallel once T2.4/T3.5 are done:
   - T2.2 sky/sun
   - T2.5 Go outside button
   - T4.6 HUD core, which ports compass and alerts from branch `feat/helmet-hud`
   - T4.5 CV view (key V)
   - T6.2 real-photo view (key R)
   - T5.1 panel
7. Then T4.4 eval harness (metrics), T5.2 sand, T5.4 hand the map back to Mission control, and M5 polish.
8. **If time runs out**, cut in this order: drop-offs wiring → sand → real-photo view. Keep the core: world,
   CV, hazard map, re-route.

## 6. Decisions you inherit (don't relitigate without Danya)

All in PLAN §2. The key ones:
- **The world:** a simulated 3D Mars built from real orbital data. Rocks are added, because orbit can't see
  rocks under ~1.5 m.
- **The CV:**
  - Real algorithms, live in the browser, working from pixels only.
  - Classic stereo + rules, no neural network.
  - The same detector also runs on a real rover photo, to show it is credible.
- **The screen:** the helmet is full screen with an in-helmet mini-map. Movement is free (keyboard and mouse),
  and there is a "jump to any point" on the route.
- **The planner:** the teammates' planner does global re-routing; the helmet's own local planner steers
  around rocks.
- **Warnings:** they come from sensors and data (weather, dose, daylight, walk-back), not from the camera.
- **Dependencies:** only `three` (0.170.0) was added. No backend. System fonts only.
- **Small deviations already made**, documented in the STATUS log: stereo uniqueness 0.8 instead of 0.95,
  extra robustness checks in ground and slope, and a drop-off rule tweak.

## 7. Gotchas

- **Frame rate in cloud sessions:** about 2–3 fps (software rendering). Judge performance on a real laptop.
- **NASA panorama links:** the panorama URLs inside `M20_waypoints.json` are dead (404/403). Use the
  raw-image feed (see the CLAUDE.md data table).
- **Weather data:** `weather.json` has only **4 sols** with full readings (the feed returns a short window;
  latest sol 1133, April 2024). It is labelled as "latest available reading", which is fine for the demo.
- **Orthos:** they are **grayscale** and get tinted in the material.
- **1 m terrain coverage:** only the demo windows (first and last 600 m of each route) have it. Anywhere else
  shows "coarse terrain".
- **CV coordinates:**
  - The principal point is `cx = (width − 1) / 2` for the rendered cameras.
  - `readRenderTargetPixels` returns rows **bottom-up**, so flip them.
  - Copy CV result buffers before you keep them.
  - The real stereo pair's `cx`/`cy` sit at the image corner, which is correct: the NASA tile is one quarter
    of the sensor.
- **React StrictMode** mounts effects twice. Dispose three.js objects and terminate workers in cleanup.
- **Session safety checks:** the session's safety checks block commands that look like getting around a
  website's protections (spoofed referrers, probing private endpoints). Use the public NASA feeds only.

## 8. People and reviews owed

- **Danya:** owner of the helmet (`src/helmet/`, `src/panels/`). Ask about scope, decisions and access.
- **Dev 2:** owns `src/lib/`, `scripts/`, `public/data/`. Needs to **review T4.3** (planner changes). Open
  question: a one-line `type` guard in `src/lib/usePlanner.ts` would let re-routes share the existing worker.
- **Dev 1:** owns `src/map/`. Will review T5.4, which adds two optional props to `MarsMap`.
- **Backup demo:** the earlier scripted helmet with real rover panoramas is on branch `feat/helmet-hud`.

## 9. Prompt to give your Claude

Paste this as the first message in Claude Code, from the repo root on `feat/helmet-3d`:

```
You are continuing the Martian Map helmet build. Read, in order: CLAUDE.md, docs/helmet/HANDOFF.md,
docs/helmet/PLAN.md (all of it), docs/helmet/STATUS.md. Then:
1. Run npm ci, npm test (expect 126 passing) and npm run build, and tell me if anything is red.
2. Merge origin/wip/helmet-lane-b into a new branch work/t2.3 and review src/helmet/world/rocks.ts against
   PLAN §6.2 and T2.3. Finish it (tests, wiring into the scene, demo boulder field), then merge into
   feat/helmet-3d.
3. Continue along the critical path in HANDOFF §5 (T2.4, then the T3.5 camera rig, then T4.2, T5.0, T5.3),
   following PLAN §0 rules: one task at a time, build and tests green before each commit, commit message
   "helmet: <task id> <title>", update STATUS.md (status line + one log line) with every task, push to
   feat/helmet-3d, never touch main, no new dependencies.
4. For anything visual, run the dev server and look at a screenshot of #helmet before calling it done.
Stop and ask me when a decision is needed that PLAN.md does not answer.
```

To run it as a loop with helpers instead, use the orchestrator prompt in `docs/helmet/LOOP_PROMPT.md` with
`/loop`, and change "at most 3 worker subagents" to **2** because of plan limits.
