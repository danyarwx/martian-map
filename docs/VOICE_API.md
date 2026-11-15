# Voice assistant API (tablet navigation)

The tablet screen at `/nav` produces the turn-by-turn announcements as events. It shows them as captions, and the built-in voice speaks them. The built-in voice is the reference subscriber: another voice model subscribes to the same events in the same way. You don't need to touch the navigation code.

Source of truth: [`src/nav/events.ts`](../src/nav/events.ts) (types, documented) and [`src/nav/instructions.ts`](../src/nav/instructions.ts) (`Maneuver`).
Reference subscriber: [`src/nav-ui/voice/`](../src/nav-ui/voice/). `index.ts` listens to the bus, `queue.ts` holds the priority rules below, `openaiEngine.ts` plays OpenAI speech fetched from our Vercel function `api/tts.js` (the key stays on the server), `fallback.ts` switches to `browserEngine.ts`, the browser's own voice, when offline or when OpenAI does not answer within 1.5 s. There is no radio click on this branch. To add an engine, implement `SpeechEngine` from `queue.ts` (`speak(text)` and `cancel()`).

The texts are written in a terse radio style and spell out units ("meters", "degrees"), so a speech engine reads them correctly.

## Try it in 30 seconds

1. `npm install`, then `npm run dev`, then open `http://localhost:5173/nav`
2. Press **Start navigation**. In the yellow SIMULATION bar, set the speed to 10×.
3. In the browser console:

```js
window.marsNav.subscribe('*', (e) => e.type !== 'state' && console.log(e.priority, e.type, e.text))
```

## Three ways to listen

| Where your code runs | How |
|---|---|
| Inside the app (recommended) | `import { getNavBus } from './nav/events.ts'`, then `getNavBus().subscribe('*', cb)` |
| Another tab, window or iframe on the same origin | `new BroadcastChannel('mars-nav').onmessage = (m) => cb(m.data)` (or `listenNavChannel(cb)`) |
| Console or a quick script | `window.marsNav` (the same bus object) |

`subscribe(type, cb)` returns a function that unsubscribes. `type` is one event type or `'*'`.
You can also poll: `getState()` returns the current `NavState`, and `getUpcoming(3)` returns the next 3 maneuvers with distances.

## Events

```ts
interface NavEvent {
  id: string          // unique per announcement
  type: 'instruction' | 'hazard' | 'arrive' | 'off_route' | 'rerouted' | 'back_on_route'
      | 'walkback_warning' | 'turn_back_time' | 'time_alert' | 'hazard_event' | 'status'
      | 'stop_briefing' | 'drift' | 'answer' | 'nav_started' | 'nav_ended' | 'state'
  text: string        // finished English sentence: speak this
  priority: 'low' | 'normal' | 'high'
  maneuver?: Maneuver // structured data, if you want to phrase it yourself
  distanceM?: number  // distance to the maneuver when announced
  stopId?: string
  state?: NavState    // only on 'state'
  at: number          // Date.now()
}
```

Rules for the voice:
- **Ignore `type === 'state'`.** It fires about 5 times a second with the full `NavState`, for screens, not speech.
- **`high` interrupts** whatever is being spoken (the "Turn left now" moment, arrival, off route).
- **`normal` waits** in the queue. **`low`** (the early "Turn left in 200 meters" heads-up) is dropped if it has waited more than about 6 s, because by then it is stale. A `high` event also clears everything still waiting.
- **End navigation is silent.** The built-in voice stops the line being spoken and drops everything waiting (`voice.clear()`). The `nav_ended` event of a manual End has empty text; only the arrival at the habitat says "Navigation ended.".
- The app already handles the timing: each turn is announced at about 200 m, 50 m and "now" when walking (400 m and 100 m by rover). Two announcements are never closer than 2 s apart unless one is high priority. Speak events when they arrive; don't add your own timers.

Example texts, from a real run:

```
nav_started      Navigation started. 3 stops, 7.1 kilometers, about 5 hours 10 minutes.
instruction      Head north-west for 550 meters.
instruction low  Bear left in 200 meters.
instruction low  Slight right in 50 meters.
instruction high Bear left.
instruction      Walk straight for 2.1 kilometers.
hazard           Steep ground ahead, 18 degrees, 20 meters. Slow down.
instruction      Bear right in 50 meters, to avoid a 22° slope.
instruction low  Delta front (Hawksbill Gap) in 50 meters.
arrive      high Delta front (Hawksbill Gap) reached. Task: Sample the fine-grained layers by hand, bed by bed.
stop_briefing    Fine lake-bottom layers are where organic matter and traces of microbes are most likely to be preserved.
time_alert       Gust hours start in 15 minutes. Expect strong gusts and dust devils until 15:00.
time_alert  high Thirty minutes of daylight left. Head for the habitat.
status           (not triggered by the UI now) Status. Mars time 10:45. Out 1 hour 20 minutes. Habitat 35 minutes on foot. Air minus 32 degrees. Dose 0.04 millisieverts.
hazard_event high Dust storm warning. Gusts above 20 meters per second and visibility dropping. Abort the excursion. Return to the habitat now.
hazard_event     Reminder: dust storm warning active. Return to base when you can.
rerouted    high Returning to base. Return route: 1.2 kilometers to Habitat, about 25 minutes.
rerouted    high Return route: 1.2 kilometers to Habitat, about 25 minutes.
drift            Drifting left. Correct right.
off_route        Head back to the route, 30 meters to your right.
off_route   high Off route. Replanning.
rerouted         New route: 2.7 kilometers to Delta front (Hawksbill Gap).
walkback_warning Caution. Habitat is more than 60 minutes away on foot. Beyond the emergency reserve.
turn_back_time   Turn-back time reached. Head back to the habitat now.
answer           At Delta front (Hawksbill Gap), sample the fine-grained layers by hand, bed by bed. Planned working time is 30 minutes.
nav_ended        Navigation ended.   (on arrival at the habitat; a manual End says nothing)
```

A `hazard_event` warning no longer changes the route by itself. The screen shows a popup, and the `rerouted` home line follows only when the crew taps Go to base. While the popup waits, the warning repeats (high) every 30 s. After "Continue route", a normal-priority reminder comes every 15 Mars minutes. The panel's "Go to base" button gives the same `rerouted` line, starting with "Returning to base.".

Rover routes say "Drive" instead of "Walk", and their announcement distances are longer.

Every bend of 20° or more in the drawn line is its own announcement (no "…, then …" joining). Smaller bends and short left-right sidesteps that end on the same heading are not announced: the banner shows the heading to walk ("Head 135° SE"), and `drift` fires once when the crew is 10 m (on foot) or 20 m (rover) off the line for 3 s. It re-arms after the crew is back within 5 m. Beyond 25 m `off_route` takes over. `NavState.routeHeadingDeg` and `NavState.drifting` carry the same information for screens.

## `Maneuver` (on instruction and hazard events)

`kind` (`depart`, `turn`, `continue`, `hazard`, `arrive`, `arrive_home`); `modifier` for turns (`slight_left` 20–35°, `bear_left` 35–60°, `left` 60–120°, `sharp_left` over 120°, same for right); `angleDeg` (signed, + is right); `headingDeg`; `at` (lat/lon); `alongM`; `distanceToNextM`; `text` (without the distance); `reason` ("to avoid a 24° slope"); `stopId` / `stopName`; `slopeDeg` / `lengthM` on hazards. See `instructions.ts` for exact names.

## Voice questions (`answer` events)

The round mic icon on the map (shown while navigating) lets the crew ask a question. Tap once, speak, and listening ends after a 1.2 s pause; a second tap sends early. Code: [`src/nav-ui/voice/ask.ts`](../src/nav-ui/voice/ask.ts) (flow), `listen.ts` (microphone), `silence.ts` (pause detection).

1. From the tap until the answer has been said (listening, the wait and the answer), the built-in voice holds its lines (`voice.hold(true)`). Nothing interrupts in that time, safety alarms included. Held lines play afterwards under the stale rules: a high "Turn left." older than 8 s is dropped, alarms (`hazard_event`, `time_alert`, `turn_back_time`, `walkback_warning`) are never dropped.
2. The recording and a plain-text snapshot of the navigation ([`src/nav/askContext.ts`](../src/nav/askContext.ts): next stop and its task, way home, heading, next turn, steep ground, dose, temperature, gust hours, daylight, turn-back time) go to `POST /api/ask` as multipart form data (`audio`, `context`).
3. [`api/ask.js`](../api/ask.js) transcribes the audio (`whisper-1`) and asks a small model (`gpt-5.4-nano`) to answer from the snapshot only, in at most two short sentences. It returns `{ question, answer }` in about 1.5 s. It uses the same guards as `api/tts.js`: same-site only, audio up to 512 KB, snapshot up to 4000 characters, answer up to 300 characters. The models can be changed with the env vars `OPENAI_STT_MODEL` and `OPENAI_ASK_MODEL`.
4. The answer goes on the bus as an `answer` event (priority `normal`). The built-in voice says it first, ahead of everything waiting (`queue.speakNow`). Your voice should do the same. When the question can't be heard (offline, no mic permission, error or no answer within 8 s), the text is "Can't hear you right now." When there was no speech, it is "Didn't catch that. Say again."

There are no captions; the mic icon is the only thing on screen (red and pulsing while listening, a turning ring while waiting).

## Minimal integration

```ts
import { getNavBus, type NavEvent } from './nav/events.ts'

const queue: NavEvent[] = []
let speaking = false

getNavBus().subscribe('*', (e) => {
  if (e.type === 'state' || !e.text) return
  if (e.priority === 'high') { stopAudio(); queue.length = 0 }
  queue.push(e)
  void next()
})

async function next() {
  if (speaking) return
  const e = queue.shift()
  if (!e) return
  if (e.priority === 'low' && Date.now() - e.at > 6000) return next() // stale heads-up
  speaking = true
  await playTts(e.text)   // your model: text in, audio out
  speaking = false
  void next()
}
```

Mount it once in `src/nav-ui/NavApp.tsx`, next to where `startVoice` is used, and mute the built-in voice (the "Voice on" button, or `voice.setMuted(true)`) so the two don't talk over each other. Offline note: the tablet app works without Wi-Fi, so a cloud TTS will fail out there. Fall back to `speechSynthesis` when `navigator.onLine` is false, or use an on-device model.
