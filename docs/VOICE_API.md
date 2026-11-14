# Voice assistant API (tablet navigation)

The tablet screen at `/nav` produces the turn-by-turn announcements as events. It shows them as captions but does not speak them. Your voice model subscribes to the events and speaks them. You don't need to touch the navigation code.

Source of truth: [`src/nav/events.ts`](../src/nav/events.ts) (types, documented) and [`src/nav/instructions.ts`](../src/nav/instructions.ts) (`Maneuver`).
Working example to copy: [`src/nav-ui/browserVoice.ts`](../src/nav-ui/browserVoice.ts) (browser TTS, 25 lines, behind the "Speak (browser TTS)" switch).

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
- **`normal` waits** in the queue. **`low`** (the early "In 200 m, …" heads-up) can be dropped if it has waited more than about 5 s, because by then it is stale.
- The app already handles the timing: each turn is announced at about 200 m, 50 m and "now" when walking (400 m and 100 m by rover). Two announcements are never closer than 2 s apart unless one is high priority. Speak events when they arrive; don't add your own timers.

Example texts, from a real run:

```
nav_started      Navigation started: 3 stops, 7.1 km, about 5 h 10 min.
instruction      Head north-west for 550 m.
instruction low  In 200 m, bear left.
instruction high Bear left.
instruction      Walk straight for 2.1 km.
hazard           Steep stretch ahead: 18°, about 20 m. Slow down.
instruction      In 50 m, bear right to avoid a 22° slope.
arrive      high You have arrived at Delta front (Hawksbill Gap). Task: Sample the fine-grained layers by hand, bed by bed.
off_route        Head back to the route, 30 m to your right.
rerouted         New route: 2.7 km to Delta front (Hawksbill Gap).
walkback_warning (beyond the 60-minute walk-back reserve)
nav_ended        Navigation ended.
```

Rover routes say "Drive" instead of "Walk", and their announcement distances are longer.

## `Maneuver` (on instruction and hazard events)

`kind` (`depart`, `turn`, `continue`, `hazard`, `arrive`, `arrive_home`); `modifier` for turns (slight / normal / sharp, left / right); `angleDeg` (signed, + is right); `headingDeg`; `at` (lat/lon); `alongM`; `distanceToNextM`; `text` (without the distance in front); `reason` ("to avoid a 24° slope"); `stopId` / `stopName`; `slopeDeg` / `lengthM` on hazards. See `instructions.ts` for exact names.

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
  if (e.priority === 'low' && Date.now() - e.at > 5000) return next() // stale heads-up
  speaking = true
  await playTts(e.text)   // your model: text in, audio out
  speaking = false
  void next()
}
```

Mount it once in `src/nav-ui/NavApp.tsx`, next to where `startBrowserVoice` is used, and turn the browser voice off. Offline note: the tablet app works without Wi-Fi, so a cloud TTS will fail out there. Fall back to `speechSynthesis` when `navigator.onLine` is false, or use an on-device model.
