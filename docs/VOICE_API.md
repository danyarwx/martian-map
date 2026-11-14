# Voice assistant API (tablet navigation)

The tablet screen at `/nav` produces the turn-by-turn announcements as events. It shows them as captions, and the built-in voice speaks them. The built-in voice is the reference subscriber: another voice model subscribes to the same events in the same way. You don't need to touch the navigation code.

Source of truth: [`src/nav/events.ts`](../src/nav/events.ts) (types, documented) and [`src/nav/instructions.ts`](../src/nav/instructions.ts) (`Maneuver`).
Reference subscriber: [`src/nav-ui/voice/`](../src/nav-ui/voice/). `index.ts` listens to the bus, `queue.ts` holds the priority rules below, `openaiEngine.ts` plays OpenAI speech fetched from our Vercel function `api/tts.js` (the key stays on the server), `fallback.ts` switches to `browserEngine.ts`, the browser's own voice, when offline or when OpenAI does not answer within 1.5 s, and `squelch.ts` is the radio click before each line. To add an engine, implement `SpeechEngine` from `queue.ts` (`speak(text)` and `cancel()`).

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
      | 'walkback_warning' | 'turn_back_time' | 'nav_started' | 'nav_ended' | 'state'
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
- The app already handles the timing: each turn is announced at about 200 m, 50 m and "now" when walking (400 m and 100 m by rover). Two announcements are never closer than 2 s apart unless one is high priority. Speak events when they arrive; don't add your own timers.

Example texts, from a real run:

```
nav_started      Navigation started. 3 stops, 7.1 kilometers, about 5 h 10 min.
instruction      Head north-west for 550 meters.
instruction low  Bear left in 200 meters.
instruction high Bear left.
instruction      Walk straight for 2.1 kilometers.
hazard           Steep ground ahead, 18 degrees, 20 meters. Slow down.
instruction      Bear right in 50 meters, to avoid a 22° slope.
instruction low  Delta front (Hawksbill Gap) in 50 meters.
arrive      high Delta front (Hawksbill Gap) reached. Task: Sample the fine-grained layers by hand, bed by bed.
off_route        Head back to the route, 30 meters to your right.
off_route   high Off route. Replanning.
rerouted         New route: 2.7 kilometers to Delta front (Hawksbill Gap).
walkback_warning (beyond the 60-minute walk-back reserve)
nav_ended        Navigation ended.
```

Rover routes say "Drive" instead of "Walk", and their announcement distances are longer.

## `Maneuver` (on instruction and hazard events)

`kind` (`depart`, `turn`, `continue`, `hazard`, `arrive`, `arrive_home`); `modifier` for turns (slight / normal / sharp, left / right); `angleDeg` (signed, + is right); `headingDeg`; `at` (lat/lon); `alongM`; `distanceToNextM`; `text` (without the distance); `reason` ("to avoid a 24° slope"); `stopId` / `stopName`; `slopeDeg` / `lengthM` on hazards. See `instructions.ts` for exact names.

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
