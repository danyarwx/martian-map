// T4.4: the pure parts of the eval harness (poses, scoring, the sand trainer). Run with `npm test`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { HAZARD, type Detection, type HazardPatch } from '../contracts.ts'
import { toLocal } from '../frames.ts'
import type { RoutesFile } from '../world/routes.ts'
import type { TileIndex } from '../world/tileGrid.ts'
import { predict, prf, trainLogistic } from './logistic.ts'
import { matchRadius, scoreRockCells, scoreRocks, type TruthRock } from './metrics.ts'
import { EVAL_POSES, evalWindows } from './poses.ts'

const data = (name: string) => JSON.parse(readFileSync(new URL(`../../../public/data/helmet/${name}`, import.meta.url), 'utf8'))

test('60 fixed poses: the same every time, on the demo windows, 6–12 m before each boulder field', () => {
  const index = data('index.json') as TileIndex
  const routes = data('routes.json') as RoutesFile
  const windows = evalWindows(index.windows, routes.legs)
  const poses = windows.flatMap((w) => w.poses)
  assert.equal(poses.length, EVAL_POSES)
  assert.equal(new Set(poses.map((p) => p.id)).size, EVAL_POSES)
  assert.deepEqual(evalWindows(index.windows, routes.legs), windows)
  for (const w of windows) {
    const boulders = w.poses.filter((p) => p.kind === 'boulders')
    assert.equal(boulders.length, 4)
    for (const p of boulders) {
      const d = toLocal(p.at, w.field.center)
      const dist = Math.hypot(d.x, d.y)
      assert.ok(dist >= 5.9 && dist <= 12.4, `${p.id}: ${dist.toFixed(1)} m from the field`)
    }
    for (const p of w.poses) assert.ok(p.pitchDeg <= -10 && p.pitchDeg >= -15 && p.headingDeg >= 0 && p.headingDeg < 360, p.id)
  }
})

const rock = (x: number, y: number, d: number, standM: number): TruthRock => ({ x, y, d, standM })
const det = (x: number, y: number, distanceM: number): Detection => ({ kind: 'rock', x, y, radiusM: 0.4, distanceM, confidence: 1 })

test('rock scoring: centres within max(0.75 m, radius + 0.5 m); precision counts detections 2–12 m away', () => {
  assert.equal(matchRadius(rock(0, 0, 0.4, 0.5)), 0.75)
  assert.equal(matchRadius(rock(0, 0, 1.2, 0.5)), 1.1)
  const visible = [rock(0, 5, 0.6, 0.5), rock(3, 8, 1.2, 0.8), rock(-4, 9, 0.5, 0.35)]
  const nearby = [...visible, rock(0, 13, 1, 0.7), rock(6, 6, 0.4, 0.25)]
  const dets = [
    det(0.3, 5.4, 5.4), // on the first rock
    det(3.9, 8.5, 9.3), // 1.03 m from the second: inside its 1.1 m
    det(0.2, 12.9, 11.9), // a real rock just beyond 12 m: true, though that rock is not in `visible`
    det(6.1, 6.2, 8.6), // on a rock standing only 0.25 m: false, counted as "on a low rock"
    det(-8, 4, 8.9), // nothing there
    det(0, 1.5, 1.5), // nearer than 2 m: not scored
    { kind: 'steep', x: 0, y: 5, radiusM: 2, distanceM: 5, confidence: 1 },
  ]
  const s = scoreRocks(visible, nearby, dets)
  assert.deepEqual(s.foundFlags, [true, true, false])
  assert.equal(s.truth, 3)
  assert.equal(s.found, 2)
  assert.equal(s.detections, 5)
  assert.equal(s.detectionsTrue, 3)
  assert.equal(s.onLowRock, 1)
})

test('rock scoring on the hazard patch: a wide detection between two boulders still marks both', () => {
  const patch: HazardPatch = { x0: -4, y0: 12, cols: 16, rows: 24, cls: new Uint8Array(16 * 24), conf: new Float32Array(16 * 24) }
  const paint = (x: number, y: number) => (patch.cls[Math.floor((patch.y0 - y) / 0.5) * patch.cols + Math.floor((x - patch.x0) / 0.5)] = HAZARD.rock)
  // two boulders 1.6 m apart, rock cells on both; one lone rock cell on empty ground
  paint(-0.75, 6.25)
  paint(-0.25, 6.25)
  paint(0.75, 6.25)
  paint(3.25, 3.25)
  const visible = [rock(-0.8, 6.2, 0.9, 0.6), rock(0.8, 6.2, 0.9, 0.6), rock(-3, 9, 0.6, 0.4)]
  const merged = scoreRocks(visible, visible, [det(0, 6.2, 6.2)])
  assert.deepEqual(merged.foundFlags, [true, true, false], 'the centre rule still finds both here (0.8 m < 0.95 m)')
  const cells = scoreRockCells(visible, visible, patch, { x: 0, y: 0 })
  assert.deepEqual(cells.foundFlags, [true, true, false])
  assert.equal(cells.cells, 4)
  assert.equal(cells.cellsTrue, 3)
})

test('the sand trainer separates two clouds, folds the scaling back into raw weights, and is deterministic', () => {
  // feature 0 decides (sand ≈ 0.40, other ≈ 0.45, like redness); feature 1 is noise on a very different scale
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }
  const n = 600
  const X = new Float32Array(n * 2)
  const y = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    y[i] = i % 3 === 0 ? 1 : 0
    X[i * 2] = (y[i] ? 0.4 : 0.45) + (rnd() - 0.5) * 0.03
    X[i * 2 + 1] = rnd() * 500
  }
  const train = (i: number) => i % 4 !== 3
  const held = (i: number) => i % 4 === 3
  const w = trainLogistic(X, y, 2, train)
  assert.equal(w.length, 3)
  assert.ok(w[0] < -50, `weight of the deciding feature ${w[0]}`)
  const p = predict(X, 2, w)
  const score = prf(p, y, 0.6, held)
  assert.ok(score.f1 > 0.95, `held-out F1 ${score.f1}`)
  assert.equal(score.n, 150)
  assert.equal(score.tp + score.fn, score.positives)
  assert.deepEqual(trainLogistic(X, y, 2, train), w)
  // one class only: a constant answer, no NaN
  assert.deepEqual(trainLogistic(X, new Uint8Array(n), 2, train), [0, 0, -10])
})
