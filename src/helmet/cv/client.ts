// Main-thread side of the CV worker (docs/helmet/PLAN.md §4, T3.5): at most ONE frame in flight. When
// the worker is still busy, send() returns false and the caller drops that frame, so the CV never lags
// behind the walk; the next CV tick sends a fresh one.
//
// Usage in React (StrictMode mounts effects twice, so create and terminate inside the same effect):
//   useEffect(() => {
//     const cv = new CvClient()
//     const off = cv.onResult((r) => { ... })
//     return () => { off(); cv.terminate() }
//   }, [])
//
// send() TRANSFERS frame.left, frame.right and frame.rgbLeft: their buffers are detached afterwards
// (length 0), so capture each CV tick into new arrays.
import type { CvFrame, CvResult } from '../contracts.ts'
import type { CvPipelineConfig } from './pipeline.ts'
// Types only: a value import would pull the worker's code (the whole pipeline) into the main bundle.
import type { CvWorkerError, CvWorkerRequest, CvWorkerResponse } from './worker.ts'

/** The part of a Worker the client uses (a fake one in tests). */
export interface CvWorkerLike {
  postMessage(msg: CvWorkerRequest, transfer: Transferable[]): void
  terminate(): void
  onmessage: ((e: MessageEvent<CvWorkerResponse>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

const isError = (res: CvWorkerResponse): res is CvWorkerError => 'error' in res

export function createCvWorker(): CvWorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

export class CvClient {
  private worker: CvWorkerLike | null
  private inFlight: number | null = null
  private sentAt = 0
  private readonly resultCbs = new Set<(r: CvResult) => void>()
  private readonly errorCbs = new Set<(msg: string, id: number | null) => void>()
  /** Main-thread round trip of the last frame (post → result), ms. NaN before the first result. */
  lastLatencyMs = NaN

  constructor(options?: CvPipelineConfig, factory: () => CvWorkerLike = createCvWorker) {
    const w = factory()
    this.worker = w
    w.onmessage = (e) => {
      if (this.worker !== w) return // terminated meanwhile
      const res = e.data
      if (res.id === this.inFlight) {
        this.inFlight = null
        this.lastLatencyMs = performance.now() - this.sentAt
      }
      if (isError(res)) for (const cb of this.errorCbs) cb(res.error, res.id)
      else for (const cb of this.resultCbs) cb(res)
    }
    w.onerror = (e) => {
      if (this.worker !== w) return
      const id = this.inFlight
      this.inFlight = null // a crashed frame never answers: free the slot
      for (const cb of this.errorCbs) cb(e.message || 'CV worker error', id)
    }
    if (options) this.configure(options)
  }

  /** True while a frame is being processed. */
  get busy(): boolean {
    return this.inFlight !== null
  }

  /** False after terminate(). */
  get alive(): boolean {
    return this.worker !== null
  }

  /** Retune the pipeline stages; takes effect from the next frame. */
  configure(options: CvPipelineConfig): void {
    this.worker?.postMessage({ type: 'config', options }, [])
  }

  /** Post a frame unless one is in flight. Returns false (frame dropped, nothing transferred) when busy or terminated. */
  send(frame: CvFrame): boolean {
    if (!this.worker || this.inFlight !== null) return false
    const transfer: Transferable[] = []
    for (const a of [frame.left, frame.right, frame.rgbLeft]) {
      // Each buffer once (two views may share one); SharedArrayBuffers cannot be transferred.
      if (a && a.buffer instanceof ArrayBuffer && !transfer.includes(a.buffer)) transfer.push(a.buffer)
    }
    this.inFlight = frame.id
    this.sentAt = performance.now()
    this.worker.postMessage(frame, transfer)
    return true
  }

  /** Called with every result. Returns an unsubscribe function. */
  onResult(cb: (r: CvResult) => void): () => void {
    this.resultCbs.add(cb)
    return () => this.resultCbs.delete(cb)
  }

  /** Called when a frame fails (`id` of the frame, or null when unknown) or the worker crashes. */
  onError(cb: (msg: string, id: number | null) => void): () => void {
    this.errorCbs.add(cb)
    return () => this.errorCbs.delete(cb)
  }

  /** Stop the worker and forget the callbacks. Safe to call twice. */
  terminate(): void {
    this.worker?.terminate()
    this.worker = null
    this.inFlight = null
    this.resultCbs.clear()
    this.errorCbs.clear()
  }
}
