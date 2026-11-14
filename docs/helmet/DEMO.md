# Helmet demo: exact steps

The 3-minute story of `PLAN.md` §1.1, with the keys to press. Screenshots are in `docs/helmet/img/`
(taken 14 Nov 2026 from the dev server in the Claude desktop Browser pane, 756 px wide; a laptop screen has more room).

Before the demo: open the site once with the network on so the data is cached, use Chrome on a laptop with a real
GPU, and keep the window in front (a background tab renders 1 frame per second).

| # | Do | Say | Screenshot |
|---|---|---|---|
| 1 | Open Mission control (`/`). The default route is planned. Click **Go outside (helmet view)** in the summary (or **Go outside here** on a stop card) | "The crew planned this route from orbit data. Now one of them goes outside." | `01-mission-control.jpg` |
| 2 | The helmet opens 300 m before the first stop. Walk with **W** (hold **Shift** to hurry: the chip shows "time ×4"). Follow the teal line on the ground | "Everything the astronaut gets is in the helmet: compass, next stop, suit, weather from Perseverance's last reading. The ground is the real 1 m elevation model and the 25 cm HiRISE photo." | `02-helmet-hud.jpg` |
| 3 | Keep walking about 50 m. Boulders appear across the route. The mini-map (bottom right) paints them red; press **M** for the large map | "Orbit cannot see rocks under about 1.5 m. These are simulated, and the helmet has never been told where they are: it finds them from two camera images." | `03-boulders-minimap.jpg` |
| 4 | Press **V** | "This is what the helmet computes, live, 5–7 times a second: the left camera with what it found, and depth from the stereo pair." | `04-cv-view.jpg` |
| 5 | Press **V** again and walk on. About 15 m before the boulders the alert "Route updated" appears and the dashed line on the mini-map moves | "The planned line is shut, so the mission planner, the same one as on the big screen, gives a new route from where the astronaut stands. The teal line steers round the rocks." | `05-reroute.jpg` |
| 6 | Walk on along the guide past the boulders | "Loose sand shows yellow on the map and raises a caution; the guide prefers firm ground." (The sand detector is trained on the simulated sand look: say so if asked) | `06-past-the-boulders.jpg` |
| 7 | Press **R** | "The same detector, unchanged, on a real Perseverance stereo photo from Cheyava Falls. Rocks lower than a step are left alone on purpose." Press **R** to close | `07-real-photo.jpg` |
| 8 | Press **Esc** | "Back inside, the ground the helmet saw and the hazards it found are on the planning map for the next crew." | `08-back-on-the-map.jpg` |

## Keys

W A S D or arrows walk · Shift hurry (time ×4) · drag to look · J jump to a point of the route · V computer vision
view · R real-photo test · M map size · P pause · H help · Esc back to Mission control.

## If something goes wrong

- **Terrain does not load / "coarse terrain"**: only the first and last 600 m of each leg have 1 m data. Press **J**
  and jump to "300 m before …".
- **No re-route at the boulders**: the guide still steers round them (local planner). Say that instead, and show the
  mini-map.
- **Slow**: close the CV view (V) and the large map (M). Check the window is in front.
- **Backup**: `#helmet` opens the helmet directly on the demo excursion without Mission control. The older scripted
  helmet with real rover panoramas is on branch `feat/helmet-hud`.

## What is real and what is simulated (say it if asked)

Real: elevation (HiRISE 1 m), ground photo (HiRISE 25 cm), weather readings (MEDA, sol 1133), the dose rate
(Curiosity RAD), the stereo photo in step 7, and the computer vision itself (pixels in, hazards out).
Simulated: rocks under 1.5 m and the demo boulder fields, sky and sun, the suit's oxygen and time numbers, the
astronaut's position (stands in for suit navigation). The full list is in `public/data/SOURCES.md`.
