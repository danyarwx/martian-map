# Helmet view: status board

Agents update this file at the start and end of every task (see `PLAN.md` §0 and `LOOP_PROMPT.md`).
Legend: `[ ]` todo · `[~]` in progress (agent name, start time) · `[x]` done (commit) · `[!]` blocked (why).
Lanes: A data · B world/sim · C CV core · D mapping/nav/planner · E HUD/UI/sensors.

Branch: `feat/helmet-3d` · Last sync with `origin/main`: 14 Nov (branch created from main `ab4c0ca`)

## M0 – foundation (serial)
- [x] T0.1 Contracts and frames · commit dc537c3
- [x] T0.2 Dependencies (three 0.170.0) and test glob · deps T0.1 · commit 35c771e
- [x] T0.3 Import firewall test · deps T0.2 · commit 910dd7c
- [x] T0.4 Skeleton `#helmet` · deps T0.2 · commit 68e303c

## M1 – real terrain
- [x] T1.0 (A) Export route polylines · deps T0.2 · commit 55b2155
- [x] T1.1 (A) Tile builder (1 m DTM + 25 cm ortho) · deps T1.0 · host planetarymaps.usgs.gov allowed 14 Nov · commit 2d558d1
- [x] T2.1 (B) Terrain loader and near tiles · deps T0.4, T1.1 · commit 2126b4c
- [~] T2.2 (B) Far terrain, sky, fog, sun · deps T2.1 · worker lane B PAUSED (usage limit, resumes after 21:00 UTC)
- [~] T2.3 (B) Rocks · deps T2.1 · worker lane B PAUSED (usage limit, resumes after 21:00 UTC)
- [~] T2.4 (B) Player, collision, jump-to · deps T2.1, T2.3 · worker lane B PAUSED (usage limit, resumes after 21:00 UTC)
- [ ] T2.5 (E) Go outside from Mission control · deps T2.4

## M2 – live CV and hazard map
- [x] T3.1 (C) Stereo · deps T0.1 · commit 53a000e
- [x] T3.2 (C) Points + ground · deps T3.1 · commit 00de106
- [x] T3.3 (C) Obstacles · deps T3.2 · commit 6902dd1
- [x] T3.4 (C) Slope · deps T3.2 · commit 3c92b97
- [~] T3.5 (C+B) Worker + capture · deps T3.3, T3.4, T2.4 · worker half done (a2e121e: pipeline, worker, client); camera rig sim/cvRig.ts still open (needs T2.4)
- [x] T4.1 (D) Hazard grid · deps T0.1 · commit 4b1661c
- [ ] T4.2 (D+E) Fuse CV into grid + mini-map · deps T3.5, T4.1
- [x] T4.3 (D) Planner: blocked cells + planFrom + replan message · deps T0.2 · Dev 2 reviews · commit 3de3e2c · awaiting Dev 2 review
- [ ] T4.4 (C) Eval harness + metrics · deps T3.5, T4.2
- [ ] T4.5 (E) CV view (V) · deps T3.5
- [ ] T4.6 (E) HUD core (port from feat/helmet-hud) · deps T2.4

## M3 – re-route and guidance
- [ ] T5.0 (D) Local planner + guide line · deps T4.2
- [ ] T5.3 (D) Global replan bridge · deps T4.3, T5.0

## M4 – sensors, sand, drop, real photo, hand-back
- [~] T5.1 (A+E) Weather cache + sensors panel + warnings · deps T4.6 · worker lane A2 PAUSED (usage limit; weather.json, fetch_weather.py, sensors/ written but not committed)
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
- Contract note (orchestrator decision, applied with T4.2): add `CvResult.groundZ?: Float32Array` (one value per patch cell) and `CvFrame.heights?: HeightGrid` so drop-offs run on fused grid heights (§5.6). Optional fields, nothing existing changes
- Usage limit hit at ~17:50 UTC (resets 21:00 UTC): lanes B and A2 paused mid-task; their worktrees keep the work
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
