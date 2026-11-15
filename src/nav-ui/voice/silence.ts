// When to stop listening for a question: after a pause once the crew has spoken, or when nobody speaks.
// Pure logic, fed a loudness level a few times a second, so it is tested without a microphone.

export interface SilenceOptions {
  /** The first this-many ms measure the background noise (suit fans, wind), milliseconds. */
  calibrateMs: number
  /** Speech is this many times louder than the background... */
  speechFactor: number
  /** ...and at least this loud (RMS of the samples, 0..1). */
  minSpeechLevel: number
  /** Quiet for this long after speech ends the question, milliseconds. */
  quietMs: number
  /** No speech within this time: give up, milliseconds. */
  noSpeechMs: number
  /** Never record longer than this, milliseconds. */
  maxMs: number
}

export const SILENCE: SilenceOptions = {
  calibrateMs: 250,
  speechFactor: 3,
  minSpeechLevel: 0.02,
  quietMs: 1200,
  noSpeechMs: 5000,
  maxMs: 10000,
}

/** 'listen': keep going. 'done': a question was heard and has ended. 'no_speech': nobody spoke. */
export type SilenceVerdict = 'listen' | 'done' | 'no_speech'

/** Returns a function to call with each loudness level and its time (ms); it says when to stop. */
export function createSilenceDetector(o: SilenceOptions = SILENCE): (level: number, t: number) => SilenceVerdict {
  let start: number | null = null
  let noise = 0
  let samples = 0
  let heard = false
  let lastLoud = 0
  return (level, t) => {
    start ??= t
    const age = t - start
    if (age < o.calibrateMs) {
      noise = (noise * samples + level) / (samples + 1)
      samples++
      return 'listen'
    }
    if (level >= Math.max(o.minSpeechLevel, noise * o.speechFactor)) {
      heard = true
      lastLoud = t
    }
    if (heard && t - lastLoud >= o.quietMs) return 'done'
    if (age >= o.maxMs) return heard ? 'done' : 'no_speech'
    if (!heard && age >= o.noSpeechMs) return 'no_speech'
    return 'listen'
  }
}

/** Loudness of a block of samples (-1..1): root mean square. */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}
