# Martian Map

NASA Space Apps 2026, challenge "Interplanetary Survival Guide: Martian Map".
A hyperlocal map for one Marswalk in Jezero crater: plan the excursion on a habitat screen, then walk it with a
helmet display that finds hazards from its own cameras.

Live: https://martian-map-nasa.vercel.app

## What it does

**Mission control (habitat planning screen)**
- Layers from several NASA missions over one site: HiRISE 25 cm and CTX 6 m images, slope from the HiRISE 1 m
  elevation model, THEMIS thermal, CRISM minerals, Perseverance's route and ground photos.
- Science goal: signs of ancient life. Six suggested science targets, your own targets, a movable habitat.
- Plans the fastest safe round trip on foot (2.5 km/h, 20° limit) or by crew rover (10 km/h, 15° limit), and a
  gentler alternative. The route explains where it turns and what it avoids.
- Safety: fits one 8-hour excursion or not, radiation dose for the time outside, typical weather, walking time
  straight back to the habitat, suggested departure time.

**Helmet (the walk itself)**
- A 3D Mars built from the real elevation model and orbital photo around the planned route.
- Live computer vision in the browser: two simulated helmet cameras, stereo depth, and from that rocks (each
  outlined in the view), steep ground, loose sand and drop-offs. The detector only gets pixels.
- A hazard map fills in as the astronaut walks; when the planned line is shut, the mission planner gives a new
  route from where the astronaut stands.
- The same detector runs on a real Perseverance stereo photo (key R).
- Back inside, the ground the helmet saw and the hazards it found are on the planning map.

## Run

```bash
npm install
npm run fetch-data   # rover data, ground photos, terrain grid into public/data
npm run dev          # http://localhost:5173
npm test
```

Open `/#plan` for the planner and `/#helmet` for the helmet on a demo route. Helmet keys and the demo steps:
`docs/helmet/DEMO.md`. The helmet needs a laptop with a GPU, a keyboard and a mouse.

## What is real and what is simulated

Real: elevation, orbital images, thermal and mineral layers, Perseverance's route and photos, the weather readings
(MEDA), the radiation dose rate (Curiosity RAD), the stereo photo of the real-photo test, and the computer vision
itself. Simulated: rocks smaller than orbit can see (about 1.5 m), sky and sun, the suit's oxygen and time numbers,
and the astronaut's position. Every layer's source and every assumption: `public/data/SOURCES.md`.

## More

- Project context and decisions: `CLAUDE.md`. Team setup: `SETUP.md`.
- Helmet: spec `docs/helmet/PLAN.md`, state and measurements `docs/helmet/STATUS.md`.
- Stack: Vite, React, TypeScript, Leaflet (equirectangular Mars grid), three.js. Static files only, no backend.
