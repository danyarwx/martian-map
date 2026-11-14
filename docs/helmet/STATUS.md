# Helmet view: status board

Agents update this file at the start and end of every task (see `PLAN.md` §0 and `LOOP_PROMPT.md`).
Legend: `[ ]` todo · `[~]` in progress (agent name, start time) · `[x]` done (commit) · `[!]` blocked (why).
Lanes: A data · B world/sim · C CV core · D mapping/nav/planner · E HUD/UI/sensors.

Branch: `feat/helmet-3d` · Last sync with `origin/main`: 14 Nov (branch created from main `ab4c0ca`) · **Handed off 14 Nov: read `docs/helmet/HANDOFF.md` first**

## M0 – foundation (serial)
- [x] T0.1 Contracts and frames · commit dc537c3
- [x] T0.2 Dependencies (three 0.170.0) and test glob · deps T0.1 · commit 35c771e
- [x] T0.3 Import firewall test · deps T0.2 · commit 910dd7c
- [x] T0.4 Skeleton `#helmet` · deps T0.2 · commit 68e303c

## M1 – real terrain
- [x] T1.0 (A) Export route polylines · deps T0.2 · commit 55b2155
- [x] T1.1 (A) Tile builder (1 m DTM + 25 cm ortho) · deps T1.0 · host planetarymaps.usgs.gov allowed 14 Nov · commit 2d558d1
- [x] T2.1 (B) Terrain loader and near tiles · deps T0.4, T1.1 · commit 2126b4c
- [x] T2.2 (B) Far terrain, sky, fog, sun · deps T2.1 · commit 74c87b8
- [x] T2.3 (B) Rocks · deps T2.1 · done 14 Nov by the new owner (work/t2.3 merged)
- [x] T2.4 (B) Player, collision, jump-to · deps T2.1, T2.3 · done 14 Nov (work/t2.4 merged)
- [ ] T2.5 (E) Go outside from Mission control · deps T2.4

## M2 – live CV and hazard map
- [x] T3.1 (C) Stereo · deps T0.1 · commit 53a000e
- [x] T3.2 (C) Points + ground · deps T3.1 · commit 00de106
- [x] T3.3 (C) Obstacles · deps T3.2 · commit 6902dd1
- [x] T3.4 (C) Slope · deps T3.2 · commit 3c92b97
- [x] T3.5 (C+B) Worker + capture · deps T3.3, T3.4, T2.4 · worker a2e121e; camera rig sim/cvRig.ts done 14 Nov (work/t3.5)
- [x] T4.1 (D) Hazard grid · deps T0.1 · commit 4b1661c
- [x] T4.2 (D+E) Fuse CV into grid + mini-map · deps T3.5, T4.1 · done 14 Nov (work/t4.2); drop-off wiring (contract note) NOT applied yet
- [x] T4.3 (D) Planner: blocked cells + planFrom + replan message · deps T0.2 · Dev 2 reviews · commit 3de3e2c · awaiting Dev 2 review
- [ ] T4.4 (C) Eval harness + metrics · deps T3.5, T4.2
- [x] T4.5 (E) CV view (V) · deps T3.5 · done 14 Nov with T4.2
- [ ] T4.6 (E) HUD core (port from feat/helmet-hud) · deps T2.4

## M3 – re-route and guidance
- [x] T5.0 (D) Local planner + guide line · deps T4.2 · done 14 Nov (work/t5)
- [x] T5.3 (D) Global replan bridge · deps T4.3, T5.0 · done 14 Nov (work/t5)

## M4 – sensors, sand, drop, real photo, hand-back
- [~] T5.1 (A+E) Weather cache + sensors panel + warnings · deps T4.6 · data + logic done (b3b52cc: weather.json, fetch_weather.py, sensors/weather.ts, suit.ts, warnings.ts + tests); the HUD panel is still to do with T4.6
- [ ] T5.2 (C) Sand classifier · deps T4.4 · cut #2 if late
- [ ] T5.4 (E) Hand the map back to Mission control · deps T4.2 · Dev 1 reviews
- [~] T5.5 (C) Drop-offs · deps T4.2 · cut #1 if late · pure detector done (d44185d); fused-grid wiring with T4.2
- [x] T6.1 (A) Real stereo pair at Cheyava Falls · deps T3.1 · cut #3 if late · commit 27088c9
- [ ] T6.2 (E) Real-photo view (R) · deps T6.1, T3.5 · cut #3 if late

## M5 – polish
- [ ] T7.1 Performance pass
- [ ] T7.2 Demo script + screenshots + backup video
- [ ] T7.3 Docs, CLAUDE.md, draft PR (do not merge)
- [ ] T7.4 Stretch: visual odometry
- [ ] T7.5 Stretch: `#hud-classic`

## Eval results (T4.4)
| Date | Rock recall | Rock precision | Depth err @5 m | Slope RMS | Sand F1 | CV ms/frame |
|---|---|---|---|---|---|---|

## Questions for the human
- 14 Nov (new owner): re-route threshold. PLAN §5.8 blocks a planner cell at 30 % hazard cover; a row of boulders covers under 10 % of a 10 m cell, so it never fired. `session.ts` uses 6 % (`REPLAN_COVERAGE`). Danya: OK, or should the demo boulder field be made denser instead?
- Contract note (orchestrator decision, applied with T4.2): add `CvResult.groundZ?: Float32Array` (one value per patch cell) and `CvFrame.heights?: HeightGrid` so drop-offs run on fused grid heights (§5.6). Optional fields, nothing existing changes
- 14 Nov ~18:10 UTC: work handed off to another person (see `docs/helmet/HANDOFF.md`). All agents stopped; nothing in flight
- Dev 2 (review of T4.3): `usePlanner`'s worker `onmessage` does not check `type`, so replans must go to a separate worker instance (T5.3 will do that, loading the terrain a second time, ~3 MB) unless Dev 2 adds `if ('type' in res) return` in `src/lib/usePlanner.ts`. Detours around blocked cells get no route note from `explainLeg`; walk-back times ignore blocked cells. Details in the T4.3 log line

## Log
<!-- One line per finished or blocked task: date, task, agent, commit, note. Newest at the bottom. -->
- 14 Nov · T0.1 · orchestrator · dc537c3 · contracts.ts per §4.3 (+HAZARD constants, HazardPatch type), frames.ts with grid helpers; 5 tests
- 14 Nov · T0.2 · orchestrator · 35c771e · three 0.170.0 + @types/three pinned; npm test runs 'src/lib/*.test.ts' 'src/helmet/**/*.test.ts' (Node expands the quoted globs, nested folders verified)
- 14 Nov · T0.3 · orchestrator · 910dd7c · firewall test; verified it fails on a planted cv→world import
- 14 Nov · T0.4 · orchestrator · 68e303c · #helmet lazy-loads HelmetView (three.js in its own 472 kB chunk), flat scene ~50 fps on software GL, Esc returns to Mission control. Movement lives in HelmetView for now; T2.4 moves it to sim/
- 14 Nov · T4.1 · lane D · 4b1661c · mapping/hazardGrid.ts: 0.5 m grid in 64 m blocks, log-odds fusion (decay 0.98, a safe view clears hazards at half weight, clamp ±4), toImage (§7.3 colours) + toLatLonBounds, hazardsList (8-connected clusters), blockedPlannerCells(meta, origin, 0.3); 12 tests
- 14 Nov · T4.3 · lane D · 3de3e2c · src/lib: buildCostGrid(…, blocked?), PlanOptions as last arg of planRoute/planRoutes, planFrom(t, m, from, stops, habitat, {blocked, profile, homeSec}) with order starting 'start', worker 'replan' message (existing messages unchanged); 8 new tests, existing 21 green · @Dev 2 please review
- 14 Nov · merge · orchestrator · lane D merged into feat/helmet-3d; scope checked (6 files, all listed), 48/48 tests, build green
- 14 Nov · T1.0 · lane A · 55b2155 · 21/21 legs, 0 unreachable, public/data/helmet/routes.json (220 KB), node scripts/export_routes.ts ~2 s
- 14 Nov · T1.1 · lane A · 2d558d1 · 241 tiles, 14.3 MB (budget 40); per window: cheyava 23, delta-front 56, habitat 43, ingenuity 47, margin-carbonates 46, seitah 53, three-forks 61; elevation check 0 failures (max 0.14 m vs 10 m grid); 0 Trek 404s; windowed /vsicurl/ DTM reads (no full download); ortho is GRAYSCALE (tint in shader); index.json adds row/col/sandFrac and a `windows` list per stop; sand mask is an orbital heuristic (gaps on bright crests, small false patches); --all-corridor would be 496 tiles ~30 MB (not built)
- 14 Nov · merge · orchestrator · lane A merged; scope checked (728 files, all listed paths), 48/48 tests, build green
- 14 Nov · T3.1 · lane C · 53a000e · census 5×5 + Hamming, 9×9 box aggregation with running sums, WTA + parabola + LR check + uniqueness; d=10 median error 0.006 px / 100 % valid, slanted 0.060 px / 100 %, step edge median 0 wrong px per row, 256×192×48 ≈ 40–48 ms in Node. Uniqueness default 0.8 (spec said 0.95; 0.95 let horizon mismatches through as false 1.7 m rocks) — T4.4 to tune
- 14 Nov · T3.2 · lane C · 00de106 · back-projection (≤ 15k points) + per-cell 20th pct + seeded RANSAC per 4 m block (thin-triangle and spread checks added); 10° slope within 1° per block, 9.85° with 0.1 px noise, 10.00° end to end; points ≤ 3.1 cm off at 5 m with ±0.05 px; ~3 ms
- 14 Nov · T3.3 · lane C · 6902dd1 · rocks from cells with ≥ 3 points > 0.30 m above ground (+ ≥ 3 points 0.10–0.30 m to reject floating mismatches), 8-connected, bbox; boxes 0.2 ignored / 0.4 → 0.399 m IoU 0.94 / 0.8 → 0.799 m IoU 1.00; through stereo 0.380 m / 0.783 m. HazardPatch = fixed 68 × 68 m around the camera, snapped to a 4 m grid
- 14 Nov · T3.4 · lane C · 3c92b97 · per-1 m-block LSQ slope with error filter (≤ 2.5°, ≤ 15 m) + 3×3 median; steep cells > 20°, 15–20° warning; 12° none, 17° warning, 25° steep, also with 0.1 px noise and through stereo; full CV frame ≈ 42 ms. Notes for T3.5: copy disparity/patch buffers before transfer; cx = (w−1)/2; readRenderTargetPixels rows are bottom-up; order disparity → backProject → fitGround → obstacles → slopes
- 14 Nov · merge · orchestrator · lane C merged; scope checked (12 files in cv/), 80/80 tests, build green
- 14 Nov · T5.5 (pure) · lane C2 · d44185d · cv/drop.ts: lip where ground falls > 1.0 m within 1.5 m (8 dirs, known cells, first known cell > 0.3 m lower), hidden face cells marked, 8-connected segments → 'drop' detections; 2 m scarp → one-cell continuous lip; 0.5 m step / 15° ramp / unknown band → nothing; occlusion-ray rule skipped (false drops on crests and rock shadows). Single frames rarely see below a lip from 1.65 m: needs fused grid heights (contract note)
- 14 Nov · T3.5a · lane C2 · a2e121e · cv/pipeline.ts (disparity → points → ground → obstacles → slope → sandHook → drop; result buffers copied; contexts rebuilt on new intrinsics), cv/worker.ts (transfers disparity/cls/conf; {id,error} on failure), cv/client.ts (one frame in flight, send() false = dropped). 0.6 m box → 1 rock 0.07 m off, h 0.61 m; ≈ 41 ms/frame in Node (drop 0.35 ms). Worker chunk appears in the app build once sim/cvRig.ts imports client.ts
- 14 Nov · T6.1 · lane A2 · 27088c9 · sol 1210 Navcam pair NLF/NRF_1210_0774362057 quadrant _01 (mastEl −43°, ground with rocks); fisheye CAHVORE handled (plain CAHV gave |dy| 2.1 px); rectified 512×384, fx 540.9, B 0.4244 m, cx/cy at the quadrant corner (correct: tile is one quarter of the sensor); row check mean |dy| 0.11 px (max 0.71) on 14 points; disparity 16–82 px, depth 2.8–14.2 m (median 6 m)
- 14 Nov · T2.1 · lane B · 2126b4c · world/tiles.ts, terrainMesh.ts, heightField.ts (+test), tileGrid, routes, path, noise, scene; sim/defaultEntry.ts; HelmetView wired (details in the commit). Rocks (T2.3) in progress, uncommitted
- 14 Nov · merge · orchestrator · lanes C2, A2 (T6.1 only), B (T2.1 only) merged; scope checked; 109/109 tests, build green
- 14 Nov · T5.1 (data + logic) · lane A2 · b3b52cc · weather.json from the MEDA feed (only 4 sols with full temperature + pressure in the feed's window; latest sol 1133, 2024-04-27: −79.3 / −24.7 °C, 778.9 Pa); sensors/weather.ts (daylight left, air temperature model), suit.ts (O₂ / EVA time model, assumptions named), warnings.ts (§7.1 rules, most severe first); 65 tests green in its worktree, 126/126 after merge
- 14 Nov · T2.3 (WIP) · lane B · 034238c · world/rocks.ts written before the usage limit stopped the agent; compiles; no tests, not in the scene. Pushed as `wip/helmet-lane-b`
- 14 Nov · handoff · orchestrator · loop stopped, all agents stopped, T5.1 merged, WIP pushed, HANDOFF.md written
- 14 Nov · T2.3 · new owner (Sasha + Claude) · work/t2.3 · rocks.ts from wip/helmet-lane-b reviewed against §6.2 and kept as is; added rocks.test.ts (8 tests: F(D) within 20 % in 3 bins for k 0.05 and 0.12, determinism, sand exclusion, rough grid, demo field, rocksNear vs brute force), world/rockMesh.ts (instanced, 4 shapes × 2 detail levels = 8 draw calls; rocks generated for tiles within 170 m; all sizes drawn to 20 m, ≥ 0.3 m to 60 m, ≥ 0.6 m + demo boulders to 150 m), wired into scene.ts (`world.rocks.field.rocksNear` for collision). Seen in the browser: demo field of 12 boulders 60 m ahead of the #helmet start; 75 fps, 25 draw calls, 144k triangles with 1667 rocks drawn. Note: the #helmet start tile is 98 % sand by the orbital mask, so there are almost no natural rocks right at the start
- 14 Nov · T2.4 · new owner · work/t2.4 · sim/player.ts (1 m/s × slopeSpeedFactor, Shift ×4, rocks standing ≥ 0.30 m block with sliding, no climbing > 25°; 5 tests), sim/jump.ts (start, 300 m before each stop, km slider; 3 tests), sim/controls.ts. New file outside the task list: `src/helmet/session.ts` = the frame loop, renderer, world and player without React (HelmetView now only loads data and draws the HUD from `HudState` 5×/s); later tasks hang the CV rig, hazard grid and nav on it. One session origin for the whole session, also across jumps. Keys J (jump menu), H (help), P (pause) work; V/R/M come with their tasks. Seen in the browser: stops 0.22 m from a 1.17 m demo boulder with 'rock in the way'; jump to the habitat (2.5 km) loads its terrain; 75 fps
- 14 Nov · T2.2 · subagent · 74c87b8 · world/sky.ts (gradient dome, sun at 10:30 local solar time, equinox assumed, shadow map 2048 ±60 m, FogExp2) and world/farTerrain.ts (10 m grid within 4 km of the session origin, 20/40/80 m rings, ≤ 72k triangles, sunk under the near tiles). The crater rim west of 77.25°E cannot be drawn: the 10 m grid has no data there. Not checked: shadow shimmer in motion, other jump points
- 14 Nov · T5.0/T5.3 (pure parts) · subagent · 7d74ac6 · nav/follow.ts, nav/localPlanner.ts (A* on the hazard grid, 0.3 ms mean), nav/replan.ts (ReplanDecider + ReplanClient with its own planner worker); 32 tests; not wired yet. Timing test now checks the median (p95 flaked when the test files ran in parallel)
- 14 Nov · T3.5 · new owner · work/t3.5 · sim/cvRig.ts: two 256 × 192 cameras, 70° HFOV, 0.30 m apart, colour only, rows flipped, linear → display gamma in JS; session sends a frame every 150 ms with one in flight. In the browser at the Three Forks demo boulders from 8 m: worker 37 ms, 7.0 Hz, 70 % valid pixels, 5 rocks found, each within 0.3 m of a real boulder (heights 0.40–0.68 m vs 0.42–0.65 m true); 75 fps main view. The status chip shows CV ms and Hz
- 14 Nov · T4.2 + T4.5 · new owner · work/t4.2 · mapping/fuse.ts (HazardMap: grid + version + latest detections), hud/MiniMap.tsx (north-up, ±25 m small / ±60 m large with M, route dashed, astronaut arrow, scale bar, legend), hud/CvView.tsx (V: left camera with labelled boxes, disparity ramp, ms / Hz / valid % / pose source). In the browser: walking 5 m toward the Three Forks demo boulders paints 4 rock clusters within ~1 m of the real boulders, safe ground as the seen wedge. Not done here: the contract note (CvResult.groundZ / CvFrame.heights for drop-offs on fused heights) — drop-offs are cut #1, so they wait until the core path is done
- 14 Nov · T5.0 + T5.3 · new owner · work/t5 · session.ts runs the local planner after every CV frame (hud/GuideLine.ts: ribbon on the ground, on three.js layer 1 so the CV cameras never see it), moves to the next leg at a stop, and checks the route against the hazard map once a second (ReplanDecider, coverage 0.06 instead of 0.30: see Questions) → ReplanClient (own planner worker) → new plan, track and "Route updated" alert. HUD: alerts (sensors/warnings.ts rules for hazard ahead and slope), nav panel (next stop, distance, steering arrow). `session.exit()` fills HelmetExit (seen image + bounds, hazard clusters, plan if re-routed). #helmet now opens the whole demo excursion (4 legs) and asks the planner for the real plan at start, so times are comparable. Seen in the browser at Three Forks: boulders detected from ~16 m, 1 planner cell blocked, new route passes 7 m south of the field, walked along the guide past it without touching a rock; 75 fps, CV 30 ms at 6.5 Hz. Not done: T2.5 (Go outside button), T4.6/T5.1 panels (compass, suit), T6.2 (R), T5.4 (map side), T4.4 eval, sand, drop-off wiring
