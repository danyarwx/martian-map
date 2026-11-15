// The OpenAI voice. The audio comes from our own /api/tts function (api/tts.js), which holds the key.
// Needs a network: when the audio is not there in time, `trySpeak` gives up and the browser voice speaks.
// The lines of the route are known in advance (src/nav/lines.ts), so they are fetched in the background
// at Start (`prefetch`) and are then ready the moment they are said.
import type { SpeakOptions, TryEngine, TryResult } from './fallback.ts'
import { audioContext } from './audio.ts'

const ENDPOINT = '/api/tts'

/**
 * An urgent line ("Turn left.", an alarm, off route) must start within this time or the browser voice
 * says it, milliseconds. OpenAI takes about 1.1-1.8 s for a short line (measured 14 Nov); a walker
 * covers under 2 m in this time.
 */
export const URGENT_WITHIN_MS = 2500
/** Any other line (heads-ups, briefings, answers) may wait this long for the OpenAI voice, milliseconds. */
export const CALM_WITHIN_MS = 6000
/** Background fetches running at once. */
const PREFETCH_PARALLEL = 3

/** Wakes the function at page load, so its cold start is over before the first line. No speech is made. */
export function warmUpVoice() {
  void fetch(ENDPOINT, { method: 'GET' }).catch(() => {})
}

/**
 * Audio kept, as MP3 bytes (20-40 KB a line, decoded only when played): a whole route's lines with room
 * for reroutes, about 12 MB at most. Oldest out first.
 */
const CACHE_LINES = 400

export function createOpenAiEngine(): TryEngine {
  const cache = new Map<string, Promise<ArrayBuffer | null>>()
  let playing: AudioBufferSourceNode | null = null
  let stopWaiting: (() => void) | null = null
  /** Lines still to fetch in the background, first first. */
  let toFetch: string[] = []
  let fetching = 0

  /** The MP3 bytes of a line, or null when they could not be fetched. Fetched once per line. */
  function audioFor(text: string): Promise<ArrayBuffer | null> {
    let hit = cache.get(text)
    if (!hit) {
      hit = fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(async (res) => {
          if (!res.ok || !res.headers.get('content-type')?.startsWith('audio/')) {
            console.warn(`[voice] /api/tts answered ${res.status}`)
            return null
          }
          return await res.arrayBuffer()
        })
        .catch((err) => {
          console.warn('[voice] /api/tts unreachable', err)
          return null
        })
      cache.set(text, hit)
      // A failed line is forgotten, so it is tried again next time.
      void hit.then((buf) => buf === null && cache.delete(text))
      if (cache.size > CACHE_LINES) cache.delete(cache.keys().next().value!)
    } else {
      // Recently used: move to the young end, so a long route does not push out the lines it repeats.
      cache.delete(text)
      cache.set(text, hit)
    }
    return hit
  }

  /** Keeps up to PREFETCH_PARALLEL background fetches running until the list is empty. */
  function pumpFetches() {
    while (fetching < PREFETCH_PARALLEL && toFetch.length > 0 && navigator.onLine) {
      const text = toFetch.shift()!
      if (cache.has(text)) continue
      fetching++
      void audioFor(text).finally(() => {
        fetching--
        pumpFetches()
      })
    }
  }

  return {
    prefetch(texts) {
      const seen = new Set<string>()
      toFetch = texts.filter((t) => t && !cache.has(t) && !seen.has(t) && seen.add(t))
      pumpFetches()
    },
    async trySpeak(text, opts?: SpeakOptions): Promise<TryResult> {
      const ctx = audioContext()
      if (!ctx) return 'failed'
      // Right after the Start tap the audio may still be unlocking.
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))])
      if (ctx.state !== 'running') return 'slow'
      let cancelled = false
      let late = false
      const within = opts?.urgent ? URGENT_WITHIN_MS : CALM_WITHIN_MS
      // Late audio is not played, but the request is left running: the line is then ready the next time.
      const bytes = await new Promise<ArrayBuffer | null>((resolve) => {
        const timer = setTimeout(() => {
          late = true
          resolve(null)
        }, within)
        stopWaiting = () => {
          cancelled = true
          clearTimeout(timer)
          resolve(null)
        }
        void audioFor(text).then(resolve).finally(() => clearTimeout(timer))
      })
      stopWaiting = null
      if (cancelled) return 'spoken' // nothing more to say for this line
      if (!bytes) return late ? 'slow' : 'failed'
      let buffer: AudioBuffer
      try {
        // decodeAudioData takes over the bytes it is given; the cached copy must stay usable.
        buffer = await ctx.decodeAudioData(bytes.slice(0))
      } catch {
        return 'failed'
      }
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
