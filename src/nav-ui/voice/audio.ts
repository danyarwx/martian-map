// The page's one WebAudio output, used to play the OpenAI voice.
let ctx: AudioContext | null = null

/** The shared audio context, created on first use. Null when the browser has none. */
export function audioContext(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    ctx = null
  }
  return ctx
}

/** Call from a tap: browsers keep audio locked until the user has touched the page. */
export function unlockAudio() {
  const c = audioContext()
  if (c && c.state === 'suspended') void c.resume().catch(() => {})
}
