// What is said when, independent of any speech engine, so it can be tested without a browser.
// Rules (docs/VOICE_API.md): 'high' interrupts what is being said, 'normal' waits its turn, and a line
// that has waited too long for its turn is stale and is dropped.
import type { NavPriority } from '../../nav/events.ts'

/** The thing that makes sound. `speak` resolves when the line has ended or was cancelled; it must not reject. */
export interface SpeechEngine {
  speak(text: string): Promise<void>
  /** Stops the line being spoken now; its `speak` then resolves. */
  cancel(): void
}

/** A queued line waits at most this long for its turn, milliseconds. After that the crew has moved on. */
export const STALE_MS: Record<NavPriority, number> = { low: 6000, normal: 20000, high: Infinity }

export interface SpeechQueue {
  /** Queues a line. A 'high' one interrupts the current line and replaces everything waiting. */
  push(text: string, priority: NavPriority): void
  /** Muting silences the current line and empties the queue; lines pushed while muted are ignored. */
  setMuted(muted: boolean): void
  /** Stops the current line and empties the queue. */
  clear(): void
  /**
   * While held (the mic is listening), the current line is stopped and new lines wait instead of playing,
   * so the voice does not talk into the microphone. Released, they play under the usual stale rules.
   */
  hold(on: boolean): void
}

export function createSpeechQueue(engine: SpeechEngine, now: () => number = Date.now): SpeechQueue {
  interface Item {
    text: string
    priority: NavPriority
    at: number
  }
  let pending: Item[] = []
  let muted = false
  let held = false
  let running = false

  async function pump() {
    if (running) return
    running = true
    try {
      for (let item = held ? undefined : pending.shift(); item; item = held ? undefined : pending.shift()) {
        if (muted || now() - item.at > STALE_MS[item.priority]) continue
        await engine.speak(item.text)
      }
    } finally {
      running = false
    }
  }

  return {
    push(text, priority) {
      if (muted || !text) return
      if (priority === 'high') {
        pending = []
        engine.cancel()
      }
      pending.push({ text, priority, at: now() })
      void pump()
    },
    hold(on) {
      held = on
      if (on) engine.cancel()
      else void pump()
    },
    setMuted(m) {
      muted = m
      if (m) this.clear()
    },
    clear() {
      pending = []
      engine.cancel()
    },
  }
}
