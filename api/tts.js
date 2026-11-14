// Vercel function: POST /api/tts { "text": "Turn left in 50 meters." } -> MP3 audio spoken by OpenAI.
// It exists only so the OpenAI key stays on the server (OPENAI_API_KEY in the Vercel project settings).
// The app is public, so the function is guarded: same-site requests only, and short texts only.
// Note: OpenAI shuts these speech models down on 6 Jan 2027 (see their deprecations page).

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech'

/** The longest line the navigation says is well under this. Keeps a stranger from spending the credit. */
export const MAX_CHARS = 300

const DEFAULT_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_VOICE = 'marin'
const STYLE =
  'You are a mission-control radio operator guiding an astronaut on a Mars walk. Speak calmly and clearly, ' +
  'at an even, brisk pace, with short pauses between sentences. No emotion, no emphasis, no filler.'

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

/** GET wakes the function up (the app calls it at page load). No speech is made, so it costs nothing. */
export function GET() {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

export async function POST(request) {
  if (!sameSite(request)) return json(403, { error: 'forbidden' })
  const key = process.env.OPENAI_API_KEY
  if (!key) return json(503, { error: 'voice not configured' })

  let text
  try {
    text = (await request.json()).text
  } catch {
    return json(400, { error: 'expected JSON' })
  }
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHARS) return json(400, { error: 'bad text' })

  let upstream
  try {
    upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || DEFAULT_MODEL,
        voice: process.env.OPENAI_TTS_VOICE || DEFAULT_VOICE,
        input: text.trim(),
        instructions: STYLE,
        response_format: 'mp3',
      }),
    })
  } catch {
    return json(502, { error: 'voice service unreachable' })
  }
  if (!upstream.ok) {
    // The reason goes to the function log, not to the browser: it can name the account.
    console.error('OpenAI speech failed', upstream.status, (await upstream.text()).slice(0, 300))
    return json(502, { error: 'voice service failed' })
  }
  // The whole clip (20-40 KB) is read first and sent in one piece: passing OpenAI's stream straight
  // through was cut off under `vercel dev`.
  let audio
  try {
    audio = await upstream.arrayBuffer()
  } catch {
    return json(502, { error: 'voice service failed' })
  }
  return new Response(audio, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.byteLength), 'cache-control': 'no-store' },
  })
}
