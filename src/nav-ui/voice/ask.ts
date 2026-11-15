// Voice questions: tap the mic, ask, hear the answer. The recording and the navigation facts
// (src/nav/askContext.ts) go to our function api/ask.js, which transcribes the question and has a language
// model answer it from the facts. The answer goes on the navigation bus as an 'answer' event, so the voice
// speaks it like any other line. No captions: the mic button's look is the only thing on screen.
import type { NavBus } from '../../nav/events.ts'
import { unlockAudio } from './audio.ts'
import { canListen, recordQuestion, type Recording } from './listen.ts'

const ENDPOINT = '/api/ask'
/** Give up on an answer after this long, milliseconds. A good answer takes about 1.5 s (measured 15 Nov). */
export const ANSWER_WITHIN_MS = 8000

/** Said when there is no network, no microphone, or the answer does not come. */
export const CANT_HEAR = "Can't hear you right now."
/** Said when the mic heard nothing that sounded like speech. */
export const NOTHING_HEARD = "Didn't catch that. Say again."

export type AskState = 'idle' | 'listening' | 'thinking'

export interface AskerOptions {
  bus: NavBus
  /** The navigation facts at this moment, or null when not navigating. */
  context: () => string | null
  /** Holds the voice's navigation lines while the mic listens. */
  holdVoice: (on: boolean) => void
  onState: (s: AskState) => void
}

export interface Asker {
  /** The mic button: starts listening, or while listening, ends the question early. */
  tap(): void
  /** Stops listening and forgets the question, e.g. when navigation ends. */
  cancel(): void
}

export function createAsker(o: AskerOptions): Asker {
  let state: AskState = 'idle'
  let recording: Recording | null = null
  let abort: AbortController | null = null
  /** Read through a function: `state` changes while `ask` awaits, which TypeScript's narrowing cannot see. */
  const current = (): AskState => state
  const set = (s: AskState) => {
    state = s
    o.onState(s)
  }
  const say = (text: string) => o.bus.emit({ id: `answer-${Date.now()}`, type: 'answer', text, priority: 'normal' })

  async function ask() {
    unlockAudio() // the tap is what lets the page's audio (and its loudness meter) run
    const context = o.context()
    if (!context) return
    if (!navigator.onLine || !canListen()) {
      say(CANT_HEAR)
      return
    }
    o.holdVoice(true)
    set('listening')
    try {
      recording = await recordQuestion()
    } catch (err) {
      console.warn('[ask] no microphone', err)
      recording = null
    }
    if (recording && current() !== 'listening') {
      // Cancelled while the browser was asking for the microphone.
      recording.cancel()
      recording = null
      return
    }
    if (!recording) {
      o.holdVoice(false)
      set('idle')
      say(CANT_HEAR)
      return
    }
    const audio = await recording.done
    recording = null
    o.holdVoice(false)
    if (current() !== 'listening') return // cancelled
    if (!audio) {
      set('idle')
      say(NOTHING_HEARD)
      return
    }
    set('thinking')
    const form = new FormData()
    form.append('audio', audio, 'question')
    form.append('context', o.context() ?? context)
    abort = new AbortController()
    const timer = setTimeout(() => abort?.abort(), ANSWER_WITHIN_MS)
    let answer: string | null = null
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal: abort.signal })
      const body = res.ok ? ((await res.json()) as { question?: string; answer?: string }) : null
      if (!res.ok) console.warn(`[ask] ${ENDPOINT} answered ${res.status}`)
      else console.info('[ask] heard:', body?.question)
      answer = typeof body?.answer === 'string' && body.answer.trim() ? body.answer : null
    } catch (err) {
      if (current() === 'thinking') console.warn('[ask] no answer', err)
    } finally {
      clearTimeout(timer)
      abort = null
    }
    if (current() !== 'thinking') return // cancelled
    set('idle')
    say(answer ?? CANT_HEAR)
  }

  return {
    tap() {
      if (state === 'idle') void ask()
      else if (state === 'listening') recording?.stop()
    },
    cancel() {
      const was = state
      set('idle')
      if (was === 'listening') {
        recording?.cancel()
        o.holdVoice(false)
      }
      abort?.abort()
    },
  }
}
