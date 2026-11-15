// The built-in voice: speaks every announcement on the navigation bus, in the terse radio style.
// Engine order: the OpenAI voice (through /api/tts) when there is a network and it answers in time,
// else the browser's own voice, which also works offline.
import type { NavBus } from '../../nav/events.ts'
import { createBrowserEngine } from './browserEngine.ts'
import { withFallback } from './fallback.ts'
import { createOpenAiEngine, warmUpVoice } from './openaiEngine.ts'
import { createSpeechQueue, type SpeechEngine } from './queue.ts'
import { unlockAudio } from './audio.ts'

export interface Voice {
  /** Mutes or unmutes. Muting stops the line being spoken. Captions are not affected. */
  setMuted(muted: boolean): void
  /** Unlocks audio (call from a tap) and says "Radio check". */
  radioCheck(): void
  /** Holds navigation lines while the mic listens; they play once released. */
  hold(on: boolean): void
  /** Stops listening to the bus and silences the voice. */
  stop(): void
}

/** The OpenAI voice with the browser voice behind it. */
function chooseEngine(): SpeechEngine {
  const browser = createBrowserEngine()
  let last = ''
  return withFallback(createOpenAiEngine(), browser, {
    available: () => navigator.onLine,
    onEngine(which) {
      if (which !== last) console.info(`[voice] speaking with the ${which === 'primary' ? 'OpenAI' : 'browser'} voice`)
      last = which
    },
  })
}

export function startVoice(bus: NavBus, muted = false): Voice {
  warmUpVoice()
  const queue = createSpeechQueue(chooseEngine())
  queue.setMuted(muted)
  const off = bus.subscribe('*', (e) => {
    if (e.type === 'state' || !e.text) return
    queue.push(e.text, e.priority)
  })
  return {
    setMuted: (m) => queue.setMuted(m),
    radioCheck() {
      unlockAudio()
      queue.push('Radio check.', 'high')
    },
    hold: (on) => queue.hold(on),
    stop() {
      off()
      queue.clear()
    },
  }
}
