# Setup for tonight (Space Apps: Martian Map)

## Already done
Folder `~/Documents/martian-map` contains a Vite + React + TypeScript + Leaflet app. It shows Mars Trek tiles centered on Jezero, with Viking color and MOLA relief layers, and loads the Perseverance route data when present. CLAUDE.md is in the root.

## Danya: get it on GitHub + Vercel (10 min)

```bash
cd ~/Documents/martian-map
npm install
npm run fetch-data
npm run dev                       # open the URL. Do Mars tiles show up?
git add . && git commit -m "Scaffold: Mars Trek tiles + project context"
gh repo create martian-map --private --source=. --push
```
Then:
1. GitHub → Settings → Collaborators: invite the other 1–2 devs. They have to accept tonight.
2. Vercel → Add New → Project → import `martian-map` and keep the defaults. Check that the deployed URL loads the map.

## Every dev (20 min)

1. Claude Code 2.1+, Node 18+, Git.
2. Inside Claude Code:
   ```
   /plugin marketplace add affaan-m/ECC
   /plugin install ecc@ecc
   ```
   Use only this install method. Leave hooks and rules off for now.
3. `git clone` the repo, `npm install`, `npm run fetch-data`, `npm run dev`.
4. Push a test branch, open a PR, and check that a Vercel preview link appears on it.

## Tests tonight (whoever has time)

- **A: tiles.** Do Trek tiles line up at every zoom level? Check `maxNativeZoom` against each layer's `WMTSCapabilities.xml`. Zoom past the native level and see whether the image only gets blurry or breaks.
- **B: route.** Is the Perseverance traverse drawn in the right place over Jezero? If it's offset, check the coordinate order in the JSON (lon/lat vs lat/lon).
- **C: terrain.** Find a HiRISE DTM for the site (https://www.uahirise.org/dtm/) and note its size and format.

Write the result of each in CLAUDE.md under Data sources.

## Kickoff (first 30 min tomorrow)

1. Decide site, science goal, form factor, 3+ data layers and demo story. Fill in "Our decisions" in CLAUDE.md.
2. In Claude Code:
   ```
   /ecc:plan Read CLAUDE.md. Break the project into tasks for 2-3 developers working in parallel for ~30 hours, plus the non-coders on research, design and the pitch. Order the tasks so we have a deployable demo with all layers by hour 20, then polish. Mark which tasks block others.
   ```
3. One GitHub issue per task, each with an owner.

## Roles

- Dev 1: map, tiles, layers, UI
- Dev 2: data scripts, route + safety logic (slope no-go zones)
- Dev 3 (if there is one): waypoint photos, HUD/tablet view
- Non-coders: science narrative, source citations, pitch deck, demo video

## Workflow

- One branch per feature, merge within a few hours. `/code-review` before merging into `main`.
- `main` must always deploy.
- Cache every dataset into `public/data` (via `scripts/`) so the demo works without venue Wi-Fi.
