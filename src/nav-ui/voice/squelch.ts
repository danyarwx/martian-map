// The short radio click that opens every line. A burst of faded noise made with WebAudio: no audio files to ship.
let ctx: AudioContext | null = null

/** The page's one audio output, shared by the click and the cloud voice. Null when the browser has none. */
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

/** Plays the click and resolves when it has ended. Resolves at once when audio is not available. */
export function playSquelch(durationMs = 90): Promise<void> {
  const c = audioContext()
  if (!c || c.state !== 'running') return Promise.resolve()
  const frames = Math.round((c.sampleRate * durationMs) / 1000)
  const buffer = c.createBuffer(1, frames, c.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2
  const src = c.createBufferSource()
  src.buffer = buffer
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 1800
  const gain = c.createGain()
  gain.gain.value = 0.25
  src.connect(filter).connect(gain).connect(c.destination)
  return new Promise((resolve) => {
    src.onended = () => resolve()
    src.start()
  })
}
