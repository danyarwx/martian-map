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
- [~] T2.1 (B) Terrain loader and near tiles · deps T0.4, T1.1 · worker lane B, started 14 Nov
- [~] T2.2 (B) Far terrain, sky, fog, sun · deps T2.1 · worker lane B, started 14 Nov
- [~] T2.3 (B) Rocks · deps T2.1 · worker lane B, started 14 Nov
- [~] T2.4 (B) Player, collision, jump-to · deps T2.1, T2.3 · worker lane B, started 14 Nov
- [ ] T2.5 (E) Go outside from Mission control · deps T2.4

## M2 – live CV and hazard map
- [~] T3.1 (C) Stereo · deps T0.1 · worker lane C, started 14 Nov
- [~] T3.2 (C) Points + ground · deps T3.1 · worker lane C (queued), started 14 Nov
- [~] T3.3 (C) Obstacles · deps T3.2 · worker lane C (queued), started 14 Nov
- [~] T3.4 (C) Slope · deps T3.2 · worker lane C (queued), started 14 Nov
- [ ] T3.5 (C+B) Worker + capture · deps T3.3, T3.4, T2.4
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
- [~] T5.1 (A+E) Weather cache + sensors panel + warnings · deps T4.6 · worker lane A2 (data + logic now; panel after T4.6), started 14 Nov
- [ ] T5.2 (C) Sand classifier · deps T4.4 · cut #2 if late
- [ ] T5.4 (E) Hand the map back to Mission control · deps T4.2 · Dev 1 reviews
- [ ] T5.5 (C) Drop-offs · deps T4.2 · cut #1 if late
- [~] T6.1 (A) Real stereo pair at Cheyava Falls · deps T3.1 · cut #3 if late · worker lane A2, started 14 Nov
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
