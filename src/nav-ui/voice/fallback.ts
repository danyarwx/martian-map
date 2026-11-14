// Uses a primary voice that can fail (a cloud one) and a fallback that cannot (the browser's own).
// Pure logic, tested in src/nav/nav.test.ts.
import type { SpeechEngine } from './queue.ts'

/** A voice that may be unable to speak a line. */
export interface TryEngine {
  /** Resolves true when the line was spoken (or cancelled while it was this engine's turn), false when it could not be. */
  trySpeak(text: string): Promise<boolean>
  cancel(): void
}

/** After this many failures in a row the primary voice is left alone for a while, so lines are not all late. */
export const MAX_FAILURES = 2
/** ... for this long, milliseconds. */
export const RETRY_AFTER_MS = 60000

export interface FallbackOptions {
  /** False when the primary cannot work at all right now (no network). Default: always true. */
  available?: () => boolean
  now?: () => number
  /** Told which voice spoke each line, for the screen or the log. */
  onEngine?: (which: 'primary' | 'fallback') => void
}

export function withFallback(primary: TryEngine, fallback: SpeechEngine | null, options: FallbackOptions = {}): SpeechEngine {
  const { available = () => true, now = Date.now, onEngine } = options
  let failures = 0
  let blockedUntil = -Infinity
  /** Counts cancels, so a line cancelled while the primary was trying is not then said by the fallback. */
  let cancels = 0

  return {
    async speak(text) {
      const mine = cancels
      if (available() && now() >= blockedUntil) {
        if (await primary.trySpeak(text)) {
          failures = 0
          onEngine?.('primary')
          return
        }
        if (++failures >= MAX_FAILURES) {
          failures = 0
          blockedUntil = now() + RETRY_AFTER_MS
        }
      }
      if (mine !== cancels || !fallback) return
      onEngine?.('fallback')
      await fallback.speak(text)
    },
    cancel() {
      cancels++
      primary.cancel()
      fallback?.cancel()
    },
  }
}
