// What is said when, independent of any speech engine, so it can be tested without a browser.
// Rules (docs/VOICE_API.md): 'high' interrupts what is being said, 'normal' waits its turn, and a line
// that has waited too long for its turn is stale and is dropped. While the crew asks a question (held) and
// while the answer plays, nothing interrupts: every line waits, alarms included, and plays afterwards if it
// is still useful.
import type { NavEventType, NavPriority } from '../../nav/events.ts'

/** The thing that makes sound. `speak` resolves when the line has ended or was cancelled; it must not reject. */
export interface SpeechEngine {
  speak(text: string): Promise<void>
  /** Stops the line being spoken now; its `speak` then resolves. */
  cancel(): void
}

/** A queued line waits at most this long for its turn, milliseconds. After that the crew has moved on. */
export const STALE_MS: Record<NavPriority, number> = { low: 6000, normal: 20000, high: Infinity }
/** A "Turn left." said later than this would be wrong: the bend is behind the crew, milliseconds. */
export const STALE_HIGH_INSTRUCTION_MS = 8000
/** Safety alarms are never dropped, however long they waited. */
const ALARMS: ReadonlySet<NavEventType> = new Set(['hazard_event', 'time_alert', 'turn_back_time', 'walkback_warning'])

/** How long a line may wait for its turn, milliseconds. */
export function staleAfter(priority: NavPriority, type?: NavEventType): number {
  if (type && ALARMS.has(type)) return Infinity
  if (priority === 'high' && type === 'instruction') return STALE_HIGH_INSTRUCTION_MS
  return STALE_MS[priority]
}

export interface SpeechQueue {
  /**
   * Queues a line. A 'high' one interrupts the current line and replaces everything waiting, except while
   * held or while `speakNow` plays: then it waits its turn like the others.
   */
  push(text: string, priority: NavPriority, type?: NavEventType): void
  /** Speaks `text` at once, ahead of everything waiting and even while held (the answer to a question). */
  speakNow(text: string): void
  /** Muting silences the current line and empties the queue; lines pushed while muted are ignored. */
  setMuted(muted: boolean): void
  /** Stops the current line and empties the queue. */
  clear(): void
  /**
   * While held (from the mic tap until the answer is out), the current line is stopped and new lines wait
   * instead of playing, so the voice does not talk into the microphone or over the answer. Released, they
   * play under the usual stale rules.
   */
  hold(on: boolean): void
}

export function createSpeechQueue(engine: SpeechEngine, now: () => number = Date.now): SpeechQueue {
  interface Item {
    text: string
    at: number
    staleMs: number
  }
  let pending: Item[] = []
  /** A line to say before anything else (`speakNow`), and whether it is being said. */
  let first: Item | null = null
  let solo = false
  let muted = false
  let held = false
  let running = false

  async function pump() {
    if (running) return
    running = true
    try {
      for (;;) {
        let item: Item | undefined
        if (first) {
          item = first
          first = null
          solo = true
        } else if (held) {
          break
        } else {
          item = pending.shift()
        }
        if (!item) break
        if (solo || (!muted && now() - item.at <= item.staleMs)) await engine.speak(item.text)
        solo = false
      }
    } finally {
      running = false
      solo = false
    }
  }

  return {
    push(text, priority, type) {
      if (muted || !text) return
      if (priority === 'high' && !held && !solo && !first) {
        pending = []
        engine.cancel()
      }
      pending.push({ text, at: now(), staleMs: staleAfter(priority, type) })
      void pump()
    },
    speakNow(text) {
      if (muted || !text) return
      first = { text, at: now(), staleMs: Infinity }
      engine.cancel()
      void pump()
    },
    setMuted(m) {
      muted = m
      if (m) this.clear()
    },
    clear() {
      pending = []
      first = null
      engine.cancel()
    },
    hold(on) {
      held = on
      if (on) engine.cancel()
      else void pump()
    },
  }
}
