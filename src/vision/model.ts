// The image model: CLIP (ViT-B/32, 8-bit quantized) running inside the browser with
// transformers.js. Zero-shot: it scores the frame against the sentences below, no training.
// It runs in a web worker (model.worker.ts): one pass takes about half a second, which would
// freeze the helmet view if it ran on the main thread. The worker starts on first use, so the
// rest of the app does not pay for it. Until the model has loaded, reports use the pixel metrics alone.

import type { LabelScore, VisionHazard } from './types'

export const MODEL_ID = 'Xenova/clip-vit-base-patch32'

/** Sentences the model compares the frame with. Only `storm` and `clear` drive the verdict:
 *  on the test frames the model told those two apart well, but not boulders or dust devils,
 *  so the last two are shown for information and never trigger an alert. */
export const MODEL_LABELS: { id: string; hazard: VisionHazard; prompt: string }[] = [
  { id: 'storm', hazard: 'dust_storm', prompt: 'a dust storm on Mars with a hazy sky and very low visibility' },
  { id: 'clear', hazard: 'none', prompt: 'a clear day on Mars with sharp rocks and a visible horizon' },
  { id: 'dust_devil', hazard: 'dust_devil', prompt: 'a dust devil whirlwind on Mars' },
  { id: 'boulders', hazard: 'boulder_field', prompt: 'a field of large boulders on Mars' },
]

export type ModelProgress = { file: string; loaded: number; total: number }

type Scores = { label: string; score: number }[]

let worker: Worker | null = null
let ready: Promise<void> | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (s: Scores) => void; reject: (e: Error) => void }>()
const progressListeners = new Set<(p: ModelProgress) => void>()

function failAll(error: Error) {
  for (const w of waiting.values()) w.reject(error)
  waiting.clear()
}

/** Starts the download on first call (about 150 MB, cached by the browser afterwards). */
export function loadModel(onProgress?: (p: ModelProgress) => void): Promise<void> {
  if (onProgress) progressListeners.add(onProgress)
  if (!ready) {
    ready = new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' })
      worker = w
      w.onmessage = (event: MessageEvent) => {
        const msg = event.data
        if (msg.type === 'progress') progressListeners.forEach(l => l(msg))
        else if (msg.type === 'ready') resolve()
        else if (msg.type === 'failed') reject(new Error(msg.message))
        else if (msg.type === 'result') {
          waiting.get(msg.id)?.resolve(msg.scores)
          waiting.delete(msg.id)
        } else if (msg.type === 'error') {
          waiting.get(msg.id)?.reject(new Error(msg.message))
          waiting.delete(msg.id)
        }
      }
      w.onerror = e => {
        const error = new Error(e.message || 'Image model worker failed')
        reject(error)
        failAll(error)
      }
      w.postMessage({ type: 'load', modelId: MODEL_ID })
    })
    ready.catch(() => {
      // allow a retry, for example once the network is back
      worker?.terminate()
      worker = null
      ready = null
    })
  }
  return ready
}

/** Scores one frame. `image` is a URL or a data URL. */
export async function classifyFrame(image: string): Promise<LabelScore[]> {
  await loadModel()
  const prompts = MODEL_LABELS.map(l => l.prompt)
  const scores = await new Promise<Scores>((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    // The worker has no page to resolve relative URLs against.
    const absolute = image.startsWith('data:') ? image : new URL(image, location.href).href
    worker!.postMessage({ type: 'classify', id, modelId: MODEL_ID, image: absolute, prompts })
  })
  return MODEL_LABELS.map(l => ({
    id: l.id,
    hazard: l.hazard,
    score: scores.find(s => s.label === l.prompt)?.score ?? 0,
  }))
}
