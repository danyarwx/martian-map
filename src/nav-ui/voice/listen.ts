// Records one spoken question from the tablet's microphone. Listening ends by itself after a pause
// (silence.ts), or when `stop()` is called (the mic button tapped again). The microphone is released after
// every question.
import { audioContext } from './audio.ts'
import { createSilenceDetector, rms } from './silence.ts'

/** How often the loudness is checked, milliseconds. */
const CHECK_MS = 50

export interface Recording {
  /** The recorded question, or null when nobody spoke or it was cancelled. */
  done: Promise<Blob | null>
  /** Ends listening now and keeps what was said. */
  stop(): void
  /** Ends listening and throws the recording away. */
  cancel(): void
}

/** The first format this browser records in: opus in webm (Chrome, Firefox), else mp4 (Safari). */
function recorderType(): string | undefined {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t))
}

/** True when this browser can record a question at all (needs HTTPS or localhost). */
export const canListen = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/** Starts listening. Rejects when there is no microphone or the crew refused it. */
export async function recordQuestion(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  })
  const type = recorderType()
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)

  // Loudness from the same stream, for the pause detection.
  const ctx = audioContext()
  const source = ctx?.createMediaStreamSource(stream)
  const analyser = ctx?.createAnalyser()
  if (source && analyser) {
    analyser.fftSize = 1024
    source.connect(analyser)
  }
  const buf = new Float32Array(analyser?.fftSize ?? 0)
  const detect = createSilenceDetector()

  let keep = true
  let timer: ReturnType<typeof setInterval> | null = null
  const finish = (keepIt: boolean) => {
    if (recorder.state === 'inactive') return
    keep = keepIt
    recorder.stop()
  }
  const done = new Promise<Blob | null>((resolve) => {
    recorder.onstop = () => {
      if (timer !== null) clearInterval(timer)
      source?.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      resolve(keep && chunks.length ? new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }) : null)
    }
  })

  recorder.start(250)
  if (analyser) {
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      const verdict = detect(rms(buf), performance.now())
      if (verdict !== 'listen') finish(verdict === 'done')
    }, CHECK_MS)
  } else {
    // No WebAudio: listen for a fixed time instead.
    timer = setInterval(() => finish(true), 6000)
  }
  return { done, stop: () => finish(true), cancel: () => finish(false) }
}
