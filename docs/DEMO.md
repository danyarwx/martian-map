# 3-minute demo: script and recording checklist

The demo runs on the tablet screen in demo mode: **`/nav?demo=1`**.
It loads the sample cache (Three Forks) and the Delta front on foot, fastest route, leaves the habitat at
**10:30 Mars time** and runs the simulation at **60×** (1 real second = 1 mission minute).
Route: 6.5 km, 4 h 19 min in total. Leg 1 is 90 min, leg 2 is 22 min, the way home is 87 min.

Times below are real seconds after pressing **Start navigation**. They are approximate: the simulated walker
slows down on slopes. Rehearse once and note your own times.

## Script

| Time | On screen / you do | Voice says | What you tell the judges |
|---|---|---|---|
| Before 0:00 | Plan screen: 2 stops, on foot, Fastest. Point at the map layers (and, on the web planning screen, the Perseverance ground photo on each stop card) | — | "One Marswalk at Jezero. Our science goal: signs of ancient life. Collect the samples Perseverance cached, then visit the lake-bottom layers." Optical (HiRISE 25 cm), topography (slope from a 1 m DTM), thermal, minerals |
| 0:00 | Tap **Start navigation** | "Radio check." "Navigation started. 2 stops, 6.5 kilometers, about 4 hours 19 minutes." | "This is the astronaut's tablet. It talks, so hands stay free." |
| ~0:05 | Point at the slope-coloured line | "Head … for … meters." | "The route avoids slopes over 20° on foot. Every turn is announced like a car navigator." |
| ~0:15 | Point at the three rows in the panel (next stop, all stops and back, back to base now) | "Gust hours start in 15 minutes…" | "The gust hours come from real Perseverance MEDA weather data, not a guess." |
| ~0:30 | — | "Gust hours now. Watch your footing…" | |
| ~1:00 | Point at **Back to base now** going red ("Walk home over 60 min") | "Caution. Habitat is more than 60 minutes away on foot…" | "We always know how long the walk home is. 60 minutes is the emergency reserve." |
| ~1:30 | Stop card appears: Task, Why here, time at the stop | "Sample cache reached. Task: …" then the science sentence | "At every stop the crew gets the task and why this spot matters for the search for life. The ground photos are on the planning screen, so the crew saw the spot before leaving." Tap **Done — continue** |
| ~1:45 (optional, needs Wi-Fi) | Tap the mic icon, ask "What do I do at the next stop?" | The answer, in about 2 s: "At Delta front, sample the fine-grained layers…" | "The crew can ask anything about the excursion: next stop, way home, dose, daylight. Answers come only from our navigation data." |
| ~1:55 | Delta front stop card | Arrival, task, "Fine lake-bottom layers are where organic matter…" | "Our strongest lead for life." Tap **Continue** |
| ~2:05 | Drag the map to look ahead, then tap the blue arrow icon (re-centre) | — | "The crew can look around; one tap brings the map back." |
| ~2:15 | Tap **Dust storm** in the yellow SIMULATION bar | "Dust storm warning… Abort the excursion. Return to the habitat now." then "Return route: … to Habitat, about … minutes." | "When space weather turns, the plan changes in a second: straight home, on safe ground." |
| ~2:40 | Let it run | Turn instructions home | Wrap up: data layers, safety, route, ground photos, tablet form factor |

Backup lines if something goes wrong:
- No sound: there are no on-screen captions, so check the volume before you start. If the voice fails, read the turn banner and the stop card aloud yourself.
- Planner slow on first load: wait for the route to appear before tapping Start (about 4 s).
- Mic question says "Can't hear you right now.": no network or no mic permission. Skip the beat; navigation is not affected.
- Want more time to talk: tap **60×** in the SIMULATION bar to cycle to 1×, then back to 60×.

## Before recording

- [ ] Use the deployed site, not `localhost`: `https://martian-map-nasa.vercel.app/nav?demo=1` (or the branch preview).
- [ ] On `feat/voice-openai-tts`-based deployments, check the console says `[voice] speaking with the OpenAI voice`. Otherwise you hear the browser voice, which is fine.
- [ ] Open the page once on the venue Wi-Fi, press **Download for offline** on the plan screen, then test with Wi-Fi off.
- [ ] Browser full screen (F11), zoom 100%, landscape. Close other tabs. Turn off notifications (Windows: Focus assist).
- [ ] Volume up, the voice is the star.
- [ ] Tap the mic once before recording and allow the microphone, so the permission prompt doesn't appear on camera.

## Recording the backup video

Windows (no install): **Xbox Game Bar**
1. Open Chrome with the demo page and click into it.
2. `Win + G` → Capture → make sure "Record audio: All" is on (Settings → Captures → Audio).
3. `Win + Alt + R` to start and stop. The file lands in `Videos\Captures`.

Any OS: **OBS Studio**
1. Source: *Window Capture* of Chrome (or *Display Capture*), plus *Desktop Audio*.
2. Settings → Output → Recording format `mp4`; Video → 1920×1080, 30 fps.
3. Add your microphone as a second audio source if you narrate live.

Then:
- [ ] Record two full takes and keep the better one. Under 3 minutes.
- [ ] Check that the voice is audible in the file.
- [ ] Put the file somewhere the whole team can reach (shared drive), and on a USB stick.
