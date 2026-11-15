# Helmet view: handoff (second one)

Written 14 Nov 2026, ~22:00 UTC, by Danya's Claude session. This replaces the first handoff of the same day
(~18:15 UTC, in git history). It is for **you** (the next owner) and for **your Claude**.

Read in this order: this file → `FIXLIST.md` (your work list) → `PLAN.md` (the original spec) → `STATUS.md`
(the board and the log).

---

## 1. In one minute

- **What:** the astronaut's helmet for the Martian Map project (NASA Space Apps 2026). After the crew plans a
  route on "Mission control", the astronaut walks outside in a 3D Mars made from real NASA data. Live computer
  vision in the browser finds hazards from camera pixels, a hazard map fills in, and the planner re-routes.
- **Where it stands:** every task of `PLAN.md` is built and merged. The demo runs end to end with no errors.
  It does **not** yet work well or look good. Danya's verdict after trying it: the guide line jumped around
  (fixed), the computer vision "sees one rock when there are a lot", and the look is "very AI generated".
- **Your job:** work through `docs/helmet/FIXLIST.md`. It has the problems found in a full review, in priority
  order, and the design decisions Danya made.
- **Branch:** `feat/helmet-3d`. Never push to `main` directly; open a pull request.
- **State:** everything is committed and pushed. No agents are running. 206 tests pass, build green.

## 2. Branches and what is live

| Branch | What | Note |
|---|---|---|
| `main` | Production, https://martian-map-nasa.vercel.app | Has the helmet (PR #5 merged at `0a80b02`), but **not** the guide-line fix |
| `feat/helmet-3d` | Work branch. Ahead of `main` by the guide-line fix, the fix list and this handoff | **Start here** |
| `feat/helmet-hud` | The first, scripted helmet with real rover panoramas | Backup demo only |
| `wip/helmet-lane-b` | Old unfinished rocks work | Obsolete, superseded |

Every push to a branch gets a Vercel preview URL (GitHub commit status). Previews are private to Danya's
Vercel team: ask Danya for access or a share link.

## 3. Set up and look at it

```bash
git clone https://github.com/danyarwx/martian-map && cd martian-map
git checkout feat/helmet-3d
npm ci
npm test          # expect 206 passing
npm run dev       # http://localhost:5173/#plan → "Go outside (helmet view)", or straight to /#helmet
```

- Run it on a laptop with a real GPU. Cloud sessions render at about 2 frames per second.
- Demo steps and keys: `docs/helmet/DEMO.md`. Its screenshots and some wording describe the look before the
  redesign.
- In dev mode `window.__helmet` exposes the session (pose, guide, hazard grid), which is how the review moved
  the astronaut and measured things.

## 4. What changed since the first handoff

1. **The previous owner finished the build** (14 Nov): rocks, sky, player, camera rig, hazard map, mini-map, CV
   view, local guide, global re-route, Go outside, map hand-back, suit and weather panel, sand classifier,
   drop-offs, real-photo view, eval harness, demo script. Merged to `main` as PR #5. Details: the STATUS log.
2. **Guide-line fix** (`83eeb9a`, `src/helmet/nav/guide.ts`, 7 tests). The guide used to be re-planned from
   scratch every 150 ms, so it changed whenever the astronaut turned their head. Now the guide is the planned
   line while it is clear, and one kept detour round a rock, steep ground or a drop-off. Checked in the browser:
   standing still and looking around, the guide changed in 9 of 11 samples before and 1 of 10 after.
   **This fix is not on `main` yet** (FIXLIST A1).
3. **Review and design session** (`5ca153b`): `docs/helmet/FIXLIST.md`. One small code change with it: the
   sand warning now reads "Loose sand ahead on the route: slow down, watch your footing", because the guide no
   longer steers round sand.

## 5. The work list in short (full text in FIXLIST.md)

**P0, do first**
- **A1** Get the guide-line fix onto `main` (new PR `feat/helmet-3d → main`).
- **A2** The CV finds too few rocks: recall 56 % against a target of 80 %. Decision: two levels (hazard rocks
  over 30 cm, small rocks 10–30 cm), each rock outlined separately. Needs a contract change.
- **A3** The real-photo test (key R) misses the obvious foreground rocks on the Perseverance photo.
- **A4** Hazards are only on the mini-map, not highlighted in the view.

**P1**: a red walk-back warning is on screen from the first second (A5); the map handed back to Mission control
is almost invisible (A6); the steering arrow is unreadable (B1); overlays cover the suit panel (B2); Esc leaves
the helmet with an overlay open (B3); developer numbers in the status chip (B4); no touch controls (B5).

**Design rebuild (section C), decided by Danya on 14 Nov**
- Real visor HUD: thin glowing line symbols on curved glass. No boxed panels.
- HUD green for symbols; amber and red only for warnings.
- Essentials only on screen; the full readout and the map open with a key.
- World as photoreal as we can: rocks, ground, sand, sky.
- Rocks outlined in the view, sand hatched; chevrons on the ground replace the ribbon guide.

Suggested order is at the end of FIXLIST.md.

## 6. The design mockup (unfinished)

- Link: https://claude.ai/artifact/GieNFN1R3QUiLWhbd7apHW ("Martian Map Visor HUD", a design canvas).
  It is **private to Danya**. Danya has to share it from the page's Share menu before you can open it.
- What is in it:
  - **"Hazard found"** (`Main.dc.html`): the visor with heading tape, next stop, O₂ and EVA gauges, small rocks
    in dashed green, hazard rocks outlined in red with labels, sand hatched in amber, amber chevrons bending
    round a boulder field, the old line crossed out.
  - **"Clear ground: essentials only"** (`Clear.dc.html`): the same visor with nothing in the way.
- What is missing:
  - The third artboard, **"Tab held: full readout and map"**, is listed on the canvas but its file
    (`Data.dc.html`) was never written, so that frame is empty. The readout and map scope are already drawn
    inside `Main.dc.html` (mode `data`); the missing file only needs to import `Main` with `mode="data"`, the
    way `Clear.dc.html` does with `mode="clear"`.
  - Nobody has looked at the rendered canvas yet. Treat it as a first draft: check it renders, then get
    Danya's verdict before building from it.
- The scene in the mockup is a drawing. It shows the HUD direction, not the target quality of the 3D world.
- FIXLIST section C says to build from the approved mockup. **It is not approved yet.**

## 7. Things that are easy to get wrong

- **The CV may not read the world.** Nothing under `src/helmet/cv/` may import `world/`, `sim/` or `eval/`
  (`firewall.test.ts`). Rock outlines in the view must come from the CV's own output.
- **`src/helmet/contracts.ts` is shared.** The two-level rocks need a change there; make it once, note it in
  STATUS, then update the users.
- **World changes change the CV's input.** After any change to rocks, ground, sand or light: re-run
  `node scripts/eval_helmet.cjs` and re-train the sand classifier (`cv/sandWeights.ts`).
- **Teammates' folders:** `src/lib/` (planner) and `src/map/` belong to others. Ask before changing them.
- **No new dependencies** without asking Danya. System fonts only. No backend.
- **Usage limits:** three parallel agents used up a 5-hour Claude limit in about four hours. Run at most two.
- **Dates:** everything so far happened on 14 Nov 2026 (UTC).

## 8. Open decisions for Danya

Listed in FIXLIST (A5, A6, B5, B6, C6, section D) and under "Questions for the human" in STATUS.md. The ones
that block work soonest:
1. Approve or change the visor mockup (section 6).
2. Which demo route: one inside the 60-minute walk-back reserve, or keep the warning as a talking point (A5).
3. Laptop-only demo, or touch controls for a tablet (B5).

## 9. Prompt to give your Claude

Paste this as the first message in Claude Code, from the repo root on `feat/helmet-3d`:

```
You are continuing the Martian Map helmet work. Read, in order: CLAUDE.md, docs/helmet/HANDOFF.md,
docs/helmet/FIXLIST.md, then docs/helmet/PLAN.md §0, §2, §4 and §5, and the end of docs/helmet/STATUS.md.
Then:
1. Run npm ci, npm test (expect 206 passing) and npm run build. Tell me if anything is red.
2. Start with the quick items of FIXLIST "Suggested order" step 1 (B1, B3, B4, B7), one commit each.
3. Then FIXLIST A2 (the CV finds too few rocks): propose the contracts.ts change and the approach first, wait
   for my OK, then implement with tests and re-run the eval. Report the recall and precision numbers.
4. Do not start the design rebuild (FIXLIST section C) until I confirm the mockup is approved.
Rules: one item at a time; build and tests green before each commit; commit message "helmet: <FIXLIST id>
<title>"; one log line in docs/helmet/STATUS.md per item; push to feat/helmet-3d; never push to main; no new
dependencies; nothing in src/helmet/cv/ may import world/, sim/ or eval/. For anything visual, run the dev
server and look at a screenshot of #helmet before calling it done. Stop and ask when a decision is needed
that the docs do not answer.
```
