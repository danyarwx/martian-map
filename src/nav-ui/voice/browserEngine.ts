// Speech from the browser's own voices (speechSynthesis). Always available, works offline with local voices.
import type { SpeechEngine } from './queue.ts'

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window

const STORAGE_KEY = 'mars-nav-voice'

/** Voice names that sound best, most preferred first (neural / natural / well-known good system voices). */
const PREFERRED = [/natural/i, /neural/i, /google us english/i, /samantha/i, /aaron/i, /ava\b/i, /zira/i, /^microsoft .*(aria|jenny|guy)/i]

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(name: string) {
  try {
    localStorage.setItem(STORAGE_KEY, name)
  } catch {
    // Storage can be blocked (private window); the pick is simply made again next time.
  }
}

/** The best English (US) voice installed, or null to let the browser use its default. Pure, for testing. */
export function pickVoice<V extends { name: string; lang: string; localService?: boolean }>(
  voices: V[],
  saved: string | null,
): V | null {
  const english = voices.filter((v) => /^en[-_]US$/i.test(v.lang))
  const pool = english.length ? english : voices.filter((v) => /^en/i.test(v.lang))
  if (!pool.length) return null
  const keep = pool.find((v) => v.name === saved)
  if (keep) return keep
  for (const re of PREFERRED) {
    const hit = pool.find((v) => re.test(v.name))
    if (hit) return hit
  }
  return pool.find((v) => v.localService) ?? pool[0]
}

/** Browsers fill the voice list late; this waits for it, at most `waitMs`. */
function loadVoices(synth: SpeechSynthesis, waitMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(synth.getVoices())
    }
    const timer = setTimeout(done, waitMs)
    synth.addEventListener('voiceschanged', done)
  })
}

export function createBrowserEngine(): SpeechEngine | null {
  if (!canSpeak()) return null
  const synth = window.speechSynthesis
  let voice: Promise<SpeechSynthesisVoice | null> | null = null
  const getVoice = () =>
    (voice ??= loadVoices(synth).then((list) => {
      const v = pickVoice(list, remembered())
      if (v) {
        remember(v.name)
        console.info(`[voice] browser voice: ${v.name} (${v.lang})`)
      }
      return v
    }))
  let current: (() => void) | null = null

  return {
    async speak(text) {
      const v = await getVoice()
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text)
        u.lang = 'en-US'
        u.rate = 1.05
        if (v) u.voice = v
        // Some browsers never fire `end`; do not let one lost event freeze the queue.
        const timer = setTimeout(finish, 4000 + text.length * 120)
        function finish() {
          clearTimeout(timer)
          current = null
          resolve()
        }
        u.onend = finish
        u.onerror = finish
        current = finish
        synth.speak(u)
      })
    },
    cancel() {
      synth.cancel()
      current?.()
    },
  }
}
