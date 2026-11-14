// The built-in voice: speaks every announcement on the navigation bus, in the terse radio style.
// Engine order: Piper when its model has been downloaded (not wired yet), else the browser's own voice.
import type { NavBus } from '../../nav/events.ts'
import { canSpeak, createBrowserEngine } from './browserEngine.ts'
import { createSpeechQueue, type SpeechEngine } from './queue.ts'
import { playSquelch, unlockAudio } from './squelch.ts'

export { canSpeak }

export interface Voice {
  /** Mutes or unmutes. Muting stops the line being spoken. Captions are not affected. */
  setMuted(muted: boolean): void
  /** Unlocks audio (call from a tap) and says "Radio check". */
  radioCheck(): void
  /** Stops listening to the bus and silences the voice. */
  stop(): void
}

/** The engine in use: Piper when available, else the browser voice. Null when nothing can speak. */
function chooseEngine(): SpeechEngine | null {
  return createBrowserEngine()
}

/** Wraps an engine so every line starts with the radio click. */
function withSquelch(engine: SpeechEngine): SpeechEngine {
  return {
    async speak(text) {
      await playSquelch()
      await engine.speak(text)
    },
    cancel: () => engine.cancel(),
  }
}

export function startVoice(bus: NavBus, muted = false): Voice {
  const engine = chooseEngine()
  if (!engine) return { setMuted() {}, radioCheck() {}, stop() {} }
  const queue = createSpeechQueue(withSquelch(engine))
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
    stop() {
      off()
      queue.clear()
    },
  }
}
