// Uses a primary voice that can fail (a cloud one) and a fallback that cannot (the browser's own).
// Pure logic, tested in src/nav/nav.test.ts.
import type { SpeakOptions, SpeechEngine } from './queue.ts'

export type { SpeakOptions }

/**
 * What became of a line: 'spoken' (or cancelled during its turn), 'slow' (the audio was not there in time;
 * the voice is fine, it just could not say this line now), or 'failed' (the voice is not working).
 */
export type TryResult = 'spoken' | 'slow' | 'failed'

/** A voice that may be unable to speak a line. */
export interface TryEngine {
  trySpeak(text: string, opts?: SpeakOptions): Promise<TryResult>
  cancel(): void
  /** Fetches these lines in the background so they are ready when said. Replaces an earlier list. */
  prefetch?(texts: string[]): void
}

/** After this many failures in a row (not slow lines) the primary voice is left alone for a while. */
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
    async speak(text, opts) {
      const mine = cancels
      if (available() && now() >= blockedUntil) {
        const result = await primary.trySpeak(text, opts)
        if (result === 'spoken') {
          failures = 0
          onEngine?.('primary')
          return
        }
        if (result === 'failed' && ++failures >= MAX_FAILURES) {
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
