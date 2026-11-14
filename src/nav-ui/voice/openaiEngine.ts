// The OpenAI voice. The audio comes from our own /api/tts function (api/tts.js), which holds the key.
// Needs a network: when the audio is not there in time, `trySpeak` gives up and the browser voice speaks.
import type { TryEngine, TryResult } from './fallback.ts'
import { audioContext } from './audio.ts'

const ENDPOINT = '/api/tts'

/**
 * A line must start within this time or the fallback voice says it, milliseconds. OpenAI takes about
 * 1.1-1.8 s for a short line (measured 14 Nov); a walker covers under 2 m in this time.
 */
export const START_WITHIN_MS = 2500

/** Wakes the function at page load, so its cold start is over before the first line. No speech is made. */
export function warmUpVoice() {
  void fetch(ENDPOINT, { method: 'GET' }).catch(() => {})
}

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
          if (!res.ok || !res.headers.get('content-type')?.startsWith('audio/')) {
            console.warn(`[voice] /api/tts answered ${res.status}`)
            return null
          }
          return await ctx.decodeAudioData(await res.arrayBuffer())
        })
        .catch((err) => {
          console.warn('[voice] /api/tts unreachable', err)
          return null
        })
      cache.set(text, hit)
      // A failed line is forgotten, so it is tried again next time.
      void hit.then((buf) => buf === null && cache.delete(text))
      if (cache.size > CACHE_LINES) cache.delete(cache.keys().next().value!)
    }
    return hit
  }

  return {
    async trySpeak(text): Promise<TryResult> {
      const ctx = audioContext()
      if (!ctx) return 'failed'
      // Right after the Start tap the audio may still be unlocking.
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      if (ctx.state !== 'running') return 'slow'
      let cancelled = false
      let late = false
      // Late audio is not played, but the request is left running: the line is then ready the next time.
      const buffer = await new Promise<AudioBuffer | null>((resolve) => {
        const timer = setTimeout(() => {
          late = true
          resolve(null)
        }, START_WITHIN_MS)
        stopWaiting = () => {
          cancelled = true
          clearTimeout(timer)
          resolve(null)
        }
        void audioFor(text, ctx).then(resolve).finally(() => clearTimeout(timer))
      })
      stopWaiting = null
      if (cancelled) return 'spoken' // nothing more to say for this line
      if (!buffer) return late ? 'slow' : 'failed'
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
      return 'spoken'
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
