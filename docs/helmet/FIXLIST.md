# Helmet view: fix list

Written 15 Nov 2026 after a full review: the code on `feat/helmet-3d` (commit `83eeb9a` + this one), one run of the
whole demo path in a browser (Mission control → Go outside → boulders → V → re-route → R → Esc), and a design
session with Danya. For whoever picks this up next. Read `HANDOFF.md` and `PLAN.md` first for the background.

State when written: 206 tests pass, build green, no console errors in the demo path. The demo runs end to end.
What follows is what stops it from working *well*.

Priority: **P0** = the demo is wrong or misleading without it · **P1** = clearly visible problem · **P2** = polish.

---

## A. Do first

### A1 (P0). The live site does not have the guide-line fix
- `main` (production, https://martian-map-nasa.vercel.app) is at the merge of PR #5 (`0a80b02`). The fix for the
  jumping guide line (`83eeb9a`, `src/helmet/nav/guide.ts`) came after that merge and is only on `feat/helmet-3d`.
- On the live site the guide line and steering arrow still change with every head movement.
- **Do:** open a new PR `feat/helmet-3d → main` and merge it after review.

### A2 (P0). The computer vision finds too few rocks
- **Seen:** in the demo run the hazard map held 4 to 11 hazards while hundreds of rocks were in view. The CV view
  showed "1 detection" with a field of rocks ahead. Danya: "it sees one rock when in reality there are a lot".
- **Measured by the eval** (`#helmet-eval`, STATUS.md): rock recall **56 %** (target 80 %); rocks 0.30–0.40 m tall
  are found 22 % of the time; precision is fine (92.5 %).
- **Causes:**
  1. Rocks under 0.30 m are ignored on purpose (`OBSTACLE_DEFAULTS` in `src/helmet/cv/obstacles.ts`), and most
     visible rocks are smaller than that.
  2. Rocks standing close together merge into one wide detection (8-connected cells of 0.5 m).
  3. The CV cameras are 256 × 192: one pixel is 5.5 cm at 10 m, so a 30 cm rock is 5 pixels tall there.
- **Decision (Danya, 15 Nov): two levels.**
  - **Hazard rock** (taller than 30 cm): strong highlight, blocks the route.
  - **Small rock** (10–30 cm): quiet highlight as a trip risk, never blocks the route.
  - Every rock is outlined separately.
- **Do:**
  1. Split merged components into one detection per rock (per-rock peaks in the height map, or connected
     components on the image-space height mask instead of 0.5 m cells).
  2. Add the small-rock level. This is a **contract change** (`src/helmet/contracts.ts`): a level on `Detection`
     (e.g. `kind: 'rock'` + `level: 'hazard' | 'small'`). Small rocks must not become `HAZARD.rock` cells, or the
     route planner will avoid pebbles.
  3. Raise the CV camera resolution (try 384 × 288, then 512 × 384) and re-measure the worker time; the budget is
     60 ms per frame. `sim/cvRig.ts` sets the size.
  4. Each detection needs an image outline, not only a box (see C3): return a contour or mask per detection.
  5. Re-run `node scripts/eval_helmet.cjs`. Targets: hazard-rock recall ≥ 80 %, precision ≥ 70 %, and a separate
     recall number for small rocks within 8 m.
- The firewall rule stays: nothing in `src/helmet/cv/` may read `world/`.

### A3 (P0). The real-photo test (key R) is not convincing
- **Seen:** on the Perseverance photo from Cheyava Falls the large rocks in the foreground are **not** marked. Only
  two far rocks get a box, one of them at 28.6 m, beyond the CV's own 25 m depth limit. The frame took 394 ms. The
  depth image has a black wedge on its left side.
- This is the moment that is meant to prove the detector works on real Mars, so it currently proves the opposite.
- **Do:**
  1. Find out why the foreground rocks are missed. Suspects: the ground fit on a camera that is rolled −11.5° and
     pitched −30°; the 4 m RANSAC blocks on rough ground; rocks counted as ground.
  2. Drop detections beyond the valid depth range.
  3. Show outlines per rock (A2) and the two levels.
  4. If it cannot be made convincing in time, pick a different pair from the raw feed with clearer separate rocks
     on flatter ground (`scripts/build_real_stereo.py`), or cut it from the demo (it is cut #3 in PLAN §2.13).

### A4 (P0). Hazards are not shown in the view itself
- Rocks and sand the CV finds appear only as coloured squares on the mini-map. Looking through the visor, nothing
  marks them. Danya wants them highlighted in the scene. See C3 for the agreed look.

### A5 (P1). A red warning is on screen from the first second
- `#helmet` (the default demo walk to Three Forks) shows "Walk back 78 min: beyond the 60 min reserve" permanently.
  The planner's default route has the same problem (its far point is 1 h 30 min from the habitat).
- A permanent red alert teaches the audience to ignore alerts.
- **Decide (Danya):** use a demo route inside the reserve, or show this once as a caution that can be acknowledged.
  `src/helmet/sensors/warnings.ts`, `INITIAL` in `src/App.tsx`, `DEFAULT_LEG_ID` in `src/helmet/sim/defaultEntry.ts`.

### A6 (P1). The map handed back to Mission control is almost invisible
- After Esc, the ground the helmet saw and the hazards it found are a few pixels wide at the map's zoom. Nothing
  tells the user anything came back. The re-routed line is drawn dashed, but the sidebar still shows the old numbers.
- **Do:** on return, fit the map to the seen area (or flash it), and show one line such as "Helmet: 11 hazards
  found, route +1 min". Decide whether the planner should adopt the helmet's route (STATUS "Questions": the plan
  starts at a `'start'` pseudo-stop the Sidebar does not know).

---

## B. Bugs and rough edges

| # | P | Problem | Where | Fix |
|---|---|---|---|---|
| B1 | P1 | The steering arrow cannot be read. It is the glyph ▲, which is nearly equilateral, so turned by −38° it looks the same as turned by +82° (seen: arrow pointing right next to "38° left") | `HelmetView.tsx` `.helmet-steer-arrow` | Use an asymmetric arrow shape (SVG) |
| B2 | P1 | The CV view (V) and the real-photo panel (R) cover the top of the suit panel | `helmet.css`, `hud/CvView.tsx`, `hud/RealPhotoTest.tsx` | Solved by the new layout (C2); until then move or shrink |
| B3 | P1 | Esc with the CV view or the real photo open leaves the helmet | `HelmetView.tsx` key handler | Esc closes the open overlay first |
| B4 | P1 | The status chip shows developer numbers to the astronaut: "CV 54 ms · 0.3 Hz · 2 fps" | `HelmetView.tsx` `.helmet-status` | Hide behind a debug key; keep "coarse terrain", "time ×4", "paused" |
| B5 | P1 | On a phone or tablet the panels overlap, the key list is cut off, and there is no way to walk (keyboard only) | `helmet.css`, `sim/controls.ts` | Decide: laptop-only (then say so on small screens), or add a touch joystick |
| B6 | P2 | The guide no longer steers round sand (since the guide fix it stays on the planned line unless a rock, steep ground or a drop-off is on it). The warning text is updated; the behaviour is a decision | `nav/guide.ts` | Decide: accept, or let the keeper adopt a detour for a large sand patch |
| B7 | P2 | The "too cold" warning uses the temperature at departure time, not the current time, so it never changes during the walk | `HelmetView.tsx` (`airTempC: weatherNow(weather, DEPARTURE_LST_H)`) | Use the current local time |
| B8 | P2 | The "N" on the small mini-map is clipped at the corner | `hud/MiniMap.tsx` | Solved by C2 |
| B9 | P2 | Performance was measured on one Mac only (75–99 fps, CV 5–7 Hz). A background tab renders 1 frame per second | — | Test on the laptop that will present. Keep the window in front |
| B10 | P2 | Drop-offs and steep ground never appear in the demo walk and were not checked on the real terrain tiles | `cv/drop.ts`, `cv/slope.ts` | Find a place where they show (delta front), or leave them out of the pitch |
| B11 | P2 | Re-routes load the terrain a second time (own worker), detours get no "why" note, walk-back times ignore blocked cells | `src/lib/usePlanner.ts`, `explain.ts`, `walkback.ts` (Dev 2) | Dev 2's call; see STATUS "Questions" |

---

## C. Design: rebuild the look (decisions from 15 Nov)

Danya's verdict: the surroundings, rocks and sand look fake, and the interface "looks very AI generated".
Decisions:

| Topic | Decision |
|---|---|
| HUD style | **Real visor HUD**: thin glowing line symbols as if projected on curved glass, like a fighter-jet or Apollo-era head-up display. No boxed cards |
| Colour | **HUD green** for symbols. Amber for caution, red for danger. Nothing else |
| Density | **Essentials only**: next stop and distance, the guide, O₂ and time as two small gauges, warnings. Suit details, weather and the map open with a key |
| World | **As photoreal as we can** |
| Hazards in view | **Outlines + ground hatch**: a thin outline round each detected rock, a fine hatch on sand |
| Rock levels | Two (A2): strong outline for hazard rocks, quiet outline for small rocks |
| Guide | **Chevrons on the ground**, fading with distance. No ribbon |

A clickable mockup of this direction is linked from STATUS.md once Danya has approved it. Build from that, not
from this table alone.

### C1. Visor HUD shell
- Remove every panel box (`.helmet-nav`, `.helmet-suit`, `.helmet-status`, the bottom key line).
- One SVG or canvas layer in HUD green with a soft glow, slightly curved toward the edges (visor), plus a faint
  vignette and glass reflection.
- System fonts only (CLAUDE.md). Line symbols instead of text boxes where possible. The current ▲ and ◆ glyphs go.

### C2. Essentials layout
- Top: heading tape with the bearing to the next stop.
- Centre-low: next stop name and distance, small.
- Lower corners: O₂ arc and time-left arc, each with one number.
- Warnings: one line under the heading tape, amber or red, most severe first, max 2 at once.
- Keys: **Tab** (or hold) = full suit and weather readout · **M** = map · **V** = CV view · **R** = real photo ·
  **H** = keys. The key list shows for the first few seconds, then fades.

### C3. Hazards drawn in the scene
- **Rocks:** outline each detected rock in the main view. The outline must come from the CV's own output (A2 step
  4), reprojected from the left CV camera into the main camera, or drawn round the detection's 3D position and
  size. It must **not** use the world's rock list.
- **Sand:** a fine hatch on the terrain where the hazard grid says sand (a texture built from `HazardGrid`,
  projected on the ground near the astronaut).
- Hazard rocks: red-amber, solid line, distance label on the nearest few. Small rocks: thin green dashes, no label.
- Fade in when first detected, so the audience sees the helmet "finding" them.

### C4. Guide as chevrons
- Replace `hud/GuideLine.ts` (ribbon) with instanced chevrons along `guide.path`, one every 2–3 m, lying on the
  terrain, fading out by 30 m, amber where the path detours.

### C5. World realism
- **Rocks:** real shapes (more faces, displaced, a few scanned-style variants), a rock texture with normal map,
  colour variation, dust on top, contact shadows. `world/rockMesh.ts`.
- **Ground:** the 25 cm photo is blurry and striped at the feet. Blend in a detail texture and normal map near the
  camera; remove the stripe pattern. `world/terrainMesh.ts`.
- **Sand:** the simulated sand look (8 % darker, ripples) reads as fake: rework it with real ripple geometry or
  normals.
- **Sky and light:** sun disc with glow, dust haze that thickens toward the horizon, softer shadows, tone mapping.
  `world/sky.ts`.
- **Warning:** every change here changes what the CV cameras see. After C5: re-run the eval and **re-train the
  sand classifier** (`cv/sandWeights.ts` was trained on the current simulated look).

### C6. Mission control and landing page
- Not reviewed for design in this session. Ask Danya whether the same "not AI-generated" pass is wanted there.

---

## D. Housekeeping

- **Backup video** of the helmet demo is not recorded (STATUS T7.2). Record it after A and C.
- **README** for the submission is 14 lines. CLAUDE.md lists it as missing.
- **CLAUDE.md** helmet section is stale ("handed off", "PR #5"): update after A1.
- **DEMO.md** screenshots and text describe the old look and "the guide keeps to firm ground": redo after C.
- **Open vetoes for Danya** (STATUS "Questions"): simulated sand look, stepping over rocks up to 0.40 m,
  `#helmet-eval` shipped in production, re-route threshold 6 % instead of 30 %.
- **Dev 2 / Dev 1 reviews** of the planner and map changes happened only through the PR #5 merge. Confirm with them.

## Suggested order

1. A1 (merge the guide fix), B1, B3, B4, B7: under two hours together.
2. A2 (CV), then A3 with the same changes. This is the biggest piece.
3. C1 + C2 (visor HUD) and C4 (chevrons), from the mockup.
4. C3 (outlines and hatch), which needs A2 step 4.
5. C5 (world), then re-run the eval and re-train sand.
6. A5, A6, B5, then D.
