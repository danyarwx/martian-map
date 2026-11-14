// T3.5 (worker half): the worker's message handler and the one-frame-in-flight client, in Node.
// A fake worker passes messages through structuredClone with the transfer list, like postMessage does,
// so detached buffers and ownership behave as in the browser. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CvFrame, CvResult, Pose } from '../contracts.ts'
import { CvClient, type CvWorkerLike } from './client.ts'
import { intrinsics, makeTexture, renderStereo, tiltedPlane } from './testScenes.ts'
import { createCvWorkerHandler, type CvWorkerRequest, type CvWorkerResponse } from './worker.ts'

const intr = intrinsics()
const pose: Pose = { x: 0, y: 0, z: 1.65, headingDeg: 0, pitchDeg: -15 }
const box = { min: { x: -0.3, y: 5.7, z: 0 }, max: { x: 0.3, y: 6.3, z: 0.6 } }
const pair = renderStereo(intr, pose, { ground: tiltedPlane(0), boxes: [box] }, makeTexture(256, 256, 21))

function makeFrame(id: number): CvFrame {
  return { id, left: pair.left.slice(), right: pair.right.slice(), rgbLeft: new Uint8Array(intr.width * intr.height * 3), intr, pose }
}

test('worker handler: config posts nothing, a frame posts a CvResult with its three buffers transferred', () => {
  const posts: { msg: CvWorkerResponse; transfer: Transferable[] }[] = []
  const handle = createCvWorkerHandler((msg, transfer) => posts.push({ msg, transfer }))
  handle({ type: 'config', options: { obstacles: { stepM: 0.3 } } })
  assert.equal(posts.length, 0)
  handle(makeFrame(3))
  assert.equal(posts.length, 1)
  const res = posts[0].msg as CvResult
  assert.equal(res.id, 3)
  assert.equal(res.detections.filter((d) => d.kind === 'rock').length, 1)
  assert.deepEqual(posts[0].transfer, [res.disparity.buffer, res.patch.cls.buffer, res.patch.conf.buffer])
  // Transfer works (no buffer listed twice, none shared with the pipeline).
  structuredClone(res, { transfer: posts[0].transfer })
  assert.equal(res.disparity.length, 0, 'detached after the transfer')
})

test('worker handler: a broken frame posts { id, error } and the next good frame still works', () => {
  const posts: CvWorkerResponse[] = []
  const handle = createCvWorkerHandler((msg) => posts.push(msg))
  handle({ ...makeFrame(9), left: new Uint8Array(10) })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].id, 9)
  assert.ok('error' in posts[0] && /smaller/.test(posts[0].error), JSON.stringify(posts[0]))
  handle(makeFrame(10))
  assert.ok(!('error' in posts[1]))
})

/** In-process stand-in for `new Worker(...)`, running the real handler on cloned, transferred messages. */
class FakeWorker implements CvWorkerLike {
  onmessage: ((e: MessageEvent<CvWorkerResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  received: CvWorkerRequest[] = []
  private handle = createCvWorkerHandler((msg, transfer) => {
    const out = structuredClone(msg, { transfer })
    setTimeout(() => this.onmessage?.({ data: out } as MessageEvent<CvWorkerResponse>), 0)
  })
  postMessage(msg: CvWorkerRequest, transfer: Transferable[]): void {
    const copy = structuredClone(msg, { transfer })
    this.received.push(copy)
    setTimeout(() => !this.terminated && this.handle(copy), 0)
  }
  terminate(): void {
    this.terminated = true
  }
}

test('client: one frame in flight, inputs transferred, result delivered, then the slot is free', async () => {
  const fake = new FakeWorker()
  const cv = new CvClient({ slope: { warnDeg: 15 } }, () => fake)
  assert.equal(fake.received.length, 1, 'config sent first')
  const results: CvResult[] = []
  const got = new Promise<void>((resolve) => cv.onResult((r) => (results.push(r), resolve())))
  const f1 = makeFrame(1)
  assert.equal(cv.send(f1), true)
  assert.equal(f1.left.length, 0, 'left transferred')
  assert.equal(f1.right.length, 0, 'right transferred')
  assert.equal(f1.rgbLeft!.length, 0, 'rgbLeft transferred')
  assert.equal(cv.busy, true)
  const f2 = makeFrame(2)
  assert.equal(cv.send(f2), false, 'busy: frame dropped')
  assert.equal(f2.left.length, intr.width * intr.height, 'a dropped frame keeps its buffers')
  await got
  assert.equal(results[0].id, 1)
  assert.equal(results[0].detections.filter((d) => d.kind === 'rock').length, 1)
  assert.equal(cv.busy, false)
  assert.ok(cv.lastLatencyMs > 0)
  console.log(`  client round trip (fake worker, same thread): ${cv.lastLatencyMs.toFixed(1)} ms`)
  assert.equal(cv.send(f2), true)
  cv.terminate()
  assert.equal(fake.terminated, true)
  assert.equal(cv.alive, false)
  assert.equal(cv.send(makeFrame(3)), false)
  cv.terminate() // twice is fine (StrictMode cleanup)
})

test('client: left and right sharing one buffer are transferred once; errors free the slot', async () => {
  const fake = new FakeWorker()
  const cv = new CvClient(undefined, () => fake)
  const errors: [string, number | null][] = []
  const failed = new Promise<void>((resolve) => cv.onError((m, id) => (errors.push([m, id]), resolve())))
  const shared = new Uint8Array(20)
  // Too small for the context: the worker answers with an error.
  assert.equal(cv.send({ id: 4, left: shared.subarray(0, 10), right: shared.subarray(10), intr, pose }), true)
  await failed
  assert.equal(errors[0][1], 4)
  assert.equal(cv.busy, false)
  // A worker crash (no answer) also frees the slot.
  assert.equal(cv.send(makeFrame(5)), true)
  fake.terminated = true // swallow the frame
  fake.onerror?.({ message: 'boom' } as ErrorEvent)
  assert.deepEqual(errors[1], ['boom', 5])
  assert.equal(cv.busy, false)
  cv.terminate()
})
