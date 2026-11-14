// Runs the image model off the main thread, so the helmet view keeps animating while it thinks.
// Messages in:  { type: 'load' } | { type: 'classify', id, image, prompts }
// Messages out: { type: 'progress', file, loaded, total } | { type: 'ready' } | { type: 'failed', message }
//               { type: 'result', id, scores } | { type: 'error', id, message }

import { pipeline } from '@huggingface/transformers'

type Classifier = (image: string, labels: string[]) => Promise<{ label: string; score: number }[]>

const post = (message: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message)

let classifier: Promise<Classifier> | null = null

function load(modelId: string): Promise<Classifier> {
  classifier ??= pipeline('zero-shot-image-classification', modelId, {
    dtype: 'q8',
    progress_callback: (e: unknown) => {
      const p = e as { status?: string; file?: string; loaded?: number; total?: number }
      if (p.status === 'progress' && p.file && p.total) {
        post({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total })
      }
    },
  }) as unknown as Promise<Classifier>
  return classifier
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as
    | { type: 'load'; modelId: string }
    | { type: 'classify'; id: number; modelId: string; image: string; prompts: string[] }
  if (msg.type === 'load') {
    try {
      await load(msg.modelId)
      post({ type: 'ready' })
    } catch (e) {
      classifier = null
      post({ type: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  try {
    const run = await load(msg.modelId)
    post({ type: 'result', id: msg.id, scores: await run(msg.image, msg.prompts) })
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
  }
}
