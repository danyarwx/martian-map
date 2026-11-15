// Vercel function: POST /api/ask (multipart form: `audio` = the recorded question, `context` = the
// navigation facts from src/nav/askContext.ts) -> { question, answer }.
// OpenAI turns the recording into text, then a language model answers it from the facts only. The answer
// is spoken by the tablet's voice (api/tts.js). It exists so the OpenAI key stays on the server
// (OPENAI_API_KEY in the Vercel project settings), and is guarded like api/tts.js: same-site requests only,
// and small inputs only.

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const RESPONSES_URL = 'https://api.openai.com/v1/responses'

/** A 10 s question is about 40 KB of opus; this leaves room for Safari's mp4 and stops large uploads. */
export const MAX_AUDIO_BYTES = 512 * 1024
/** src/nav/askContext.ts cuts the facts at this length. */
export const MAX_CONTEXT_CHARS = 4000
/** A spoken question is far shorter than this. */
const MAX_QUESTION_CHARS = 300
/** api/tts.js speaks at most this much. */
const MAX_ANSWER_CHARS = 300

const DEFAULT_STT_MODEL = 'whisper-1'
/** Tested on sample questions: about 2 s including the transcription, and the most to-the-point answers. */
const DEFAULT_ASK_MODEL = 'gpt-5.4-nano'

/** Words Whisper should spell the way the app does. */
const VOCABULARY =
  'Mars excursion at Jezero crater. Habitat, delta front, sample cache, waypoint, turn-back time, gust hours, ' +
  'millisieverts, walk-back reserve, rover, Perseverance.'

const INSTRUCTIONS = `You are mission control, answering an astronaut on a Mars excursion over the radio.
The facts below are the only things you know. Answer the question from them.
Rules:
- At most two short sentences, under 40 words. Plain text, no lists, no markdown.
- Spell out units: "meters", "kilometers", "minutes", "degrees", "millisieverts". Say times as on the facts (e.g. 14:30).
- Give the number the astronaut asked for first.
- If the facts do not answer the question, say: "I don't have that information." Do not guess.
- No medical advice. For anything about the astronaut's health or suit, say to call the habitat.
- Calm, brisk radio style. No greetings, no filler.`

const NOT_HEARD = "Didn't catch that. Say again."

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** True when the request comes from a page of this same site (production, a preview, or localhost). */
function sameSite(request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** The file name tells OpenAI the audio format: Chrome records webm, Safari mp4. */
function fileName(type) {
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'question.mp4'
  if (type.includes('ogg')) return 'question.ogg'
  if (type.includes('wav')) return 'question.wav'
  if (type.includes('mpeg') || type.includes('mp3')) return 'question.mp3'
  return 'question.webm'
}

async function transcribe(key, audio) {
  const form = new FormData()
  form.append('file', audio, fileName(audio.type || ''))
  form.append('model', process.env.OPENAI_STT_MODEL || DEFAULT_STT_MODEL)
  form.append('language', 'en')
  form.append('prompt', VOCABULARY)
  form.append('response_format', 'json')
  const res = await fetch(TRANSCRIBE_URL, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form })
  if (!res.ok) {
    console.error('OpenAI transcription failed', res.status, (await res.text()).slice(0, 300))
    return null
  }
  const text = (await res.json()).text
  return typeof text === 'string' ? text.trim().slice(0, MAX_QUESTION_CHARS) : ''
}

/** The text of a Responses API result: the `output_text` parts of its message items. */
function outputText(body) {
  if (typeof body.output_text === 'string') return body.output_text
  const parts = []
  for (const item of body.output ?? []) {
    for (const c of item.content ?? []) if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text)
  }
  return parts.join(' ')
}

async function answer(key, question, context) {
  const model = process.env.OPENAI_ASK_MODEL || DEFAULT_ASK_MODEL
  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      // Reasoning models spend part of max_output_tokens on thinking; keep that short, the answer is one lookup.
      ...(/^(gpt-5|o\d)/.test(model) ? { reasoning: { effort: 'low' } } : {}),
      instructions: `${INSTRUCTIONS}\n\nFacts:\n${context}`,
      input: question,
      max_output_tokens: 600,
      store: false,
    }),
  })
  if (!res.ok) {
    console.error('OpenAI answer failed', res.status, (await res.text()).slice(0, 300))
    return null
  }
  const text = outputText(await res.json()).replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_ANSWER_CHARS) return text
  // Cut at the last sentence end that fits, so the voice does not stop mid-word.
  const cut = text.slice(0, MAX_ANSWER_CHARS)
  const end = cut.lastIndexOf('. ')
  return end > 40 ? cut.slice(0, end + 1) : cut
}

/** GET wakes the function up. Nothing is sent to OpenAI, so it costs nothing. */
export function GET() {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

export async function POST(request) {
  if (!sameSite(request)) return json(403, { error: 'forbidden' })
  const key = process.env.OPENAI_API_KEY
  if (!key) return json(503, { error: 'questions not configured' })
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_AUDIO_BYTES + MAX_CONTEXT_CHARS * 4 + 4096) return json(413, { error: 'too large' })

  let form
  try {
    form = await request.formData()
  } catch {
    return json(400, { error: 'expected form data' })
  }
  const audio = form.get('audio')
  const context = form.get('context')
  if (!audio || typeof audio === 'string' || audio.size === 0 || audio.size > MAX_AUDIO_BYTES) {
    return json(400, { error: 'bad audio' })
  }
  if (typeof context !== 'string' || !context.trim() || context.length > MAX_CONTEXT_CHARS) {
    return json(400, { error: 'bad context' })
  }

  let question
  try {
    question = await transcribe(key, audio)
  } catch {
    return json(502, { error: 'speech service unreachable' })
  }
  if (question === null) return json(502, { error: 'speech service failed' })
  // Whisper returns nothing, or a stray word or two, for a recording of silence or wind.
  if (question.replace(/[^a-z]/gi, '').length < 4) return json(200, { question, answer: NOT_HEARD })

  let text
  try {
    text = await answer(key, question, context)
  } catch {
    return json(502, { error: 'answer service unreachable' })
  }
  if (!text) return json(502, { error: 'answer service failed' })
  return json(200, { question, answer: text })
}
