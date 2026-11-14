// The CV worker (docs/helmet/PLAN.md §4, §5): receives CvFrames, runs the pipeline, posts CvResults.
// Created by client.ts as a module worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }).
//
// Messages in: a CvFrame (no `type`), or { type: 'config', options } to retune the stages (the pipeline is
// rebuilt on the next frame). Messages out: a CvResult whose disparity and patch buffers are transferred,
// or { id, error } when a frame fails. The handler is exported so Node tests can drive it without a Worker.
import type { CvFrame, CvResult } from '../contracts.ts'
import { createCvPipeline, runFrame, type CvPipeline, type CvPipelineConfig } from './pipeline.ts'
import { createSandHook } from './sand.ts'

export interface CvConfigMessage {
  type: 'config'
  options: CvPipelineConfig
}

export type CvWorkerRequest = CvFrame | CvConfigMessage

export interface CvWorkerError {
  id: number
  error: string
}

export type CvWorkerResponse = CvResult | CvWorkerError

export function isCvError(res: CvWorkerResponse): res is CvWorkerError {
  return 'error' in res
}

/** Message handler of the worker; `post` sends a response with its transfer list. */
export function createCvWorkerHandler(
  post: (msg: CvWorkerResponse, transfer: Transferable[]) => void,
): (msg: CvWorkerRequest) => void {
  let options: CvPipelineConfig = {}
  let pipeline: CvPipeline | null = null
  return (msg) => {
    if ('type' in msg && msg.type === 'config') {
      options = msg.options ?? {}
      pipeline = null
      return
    }
    const frame = msg as CvFrame
    try {
      // the sand stage (sand.ts) is the pipeline's sand hook; a new pipeline starts with no sand history
      pipeline ??= createCvPipeline(frame.intr, { ...options, sandHook: createSandHook() })
      const res = runFrame(pipeline, frame)
      post(res, [res.disparity.buffer, res.patch.cls.buffer, res.patch.conf.buffer, ...(res.groundZ ? [res.groundZ.buffer] : [])])
    } catch (err) {
      post({ id: typeof frame?.id === 'number' ? frame.id : -1, error: String(err) }, [])
    }
  }
}

// Bind to the worker scope only inside a worker (Node tests import this module for the handler).
if ((globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== undefined) {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<CvWorkerRequest>) => void) | null
    postMessage(msg: unknown, transfer: Transferable[]): void
  }
  const handle = createCvWorkerHandler((msg, transfer) => scope.postMessage(msg, transfer))
  scope.onmessage = (e) => handle(e.data)
}
