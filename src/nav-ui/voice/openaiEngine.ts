// The OpenAI voice. The audio comes from our own /api/tts function (api/tts.js), which holds the key.
// Needs a network: when the audio is not there in time, `trySpeak` gives up and the browser voice speaks.
import type { TryEngine } from './fallback.ts'
import { audioContext, playSquelch } from './squelch.ts'

const ENDPOINT = '/api/tts'

/** A line must start within this time or the fallback voice says it, milliseconds. */
export const START_WITHIN_MS = 1500

/** Lines repeat ("Turn left.", "Radio check."), so their audio is kept. Oldest out first. */
const CACHE_LINES = 60

export function createOpenAiEngine(): TryEngine {
  const cache = new Map<string, Promise<AudioBuffer | null>>()
  let playing: AudioBufferSourceNode | null = null
  let stopWaiting: (() => void) | null = null

  /** The decoded audio of a line, or null when it could not be fetched. Fetched once per line. */
  function audioFor(text: string, ctx: AudioContext): Promise<AudioBuffer | null> {
    let hit = cache.get(text)
    if (!hit) {
      hit = fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(async (res) => {
          if (!res.ok || !res.headers.get('content-type')?.startsWith('audio/')) return null
          return await ctx.decodeAudioData(await res.arrayBuffer())
        })
        .catch(() => null)
      cache.set(text, hit)
      // A failed line is forgotten, so it is tried again next time.
      void hit.then((buf) => buf === null && cache.delete(text))
      if (cache.size > CACHE_LINES) cache.delete(cache.keys().next().value!)
    }
    return hit
  }

  return {
    async trySpeak(text) {
      const ctx = audioContext()
      if (!ctx || ctx.state !== 'running') return false
      let cancelled = false
      // Late audio is not played, but the request is left running: the line is then ready the next time.
      const buffer = await new Promise<AudioBuffer | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), START_WITHIN_MS)
        stopWaiting = () => {
          cancelled = true
          clearTimeout(timer)
          resolve(null)
        }
        void audioFor(text, ctx).then(resolve).finally(() => clearTimeout(timer))
      })
      if (!cancelled && buffer) await playSquelch() // the radio click, right before the voice
      stopWaiting = null
      if (cancelled) return true // nothing more to say for this line
      if (!buffer) return false
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.connect(ctx.destination)
        src.onended = () => {
          if (playing === src) playing = null
          resolve()
        }
        playing = src
        src.start()
      })
      return true
    },
    cancel() {
      stopWaiting?.()
      try {
        playing?.stop()
      } catch {
        // already stopped
      }
    },
  }
}
