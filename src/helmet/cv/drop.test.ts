// T5.5: drop-offs from ground heights. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type HazardPatch, type Pose } from '../contracts.ts'
import { gridIndex } from '../frames.ts'
import { DROP_MARK, createDropContext, detectDrops, groundCellHeights, mergeDrops, type HeightGrid } from './drop.ts'
import { createGroundContext, fitGround } from './ground.ts'
import { createObstacleContext, detectObstacles } from './obstacles.ts'
import { backProject, createPointCloud } from './points.ts'
import { intrinsics, rng, tiltedPlane, trueDisparity, type Scene } from './testScenes.ts'

const COLS = 40
const ROWS = 40
/** 20 × 20 m around the origin. */
const X0 = -10
const Y0 = 10
const CAMERA = { x: 0, y: -6 }

/** A height grid from z(x, y) at the cell centres; NaN from `f` means unknown. */
function grid(f: (x: number, y: number) => number): HeightGrid {
  const z = new Float32Array(COLS * ROWS)
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) z[r * COLS + c] = f(X0 + (c + 0.5) * 0.5, Y0 - (r + 0.5) * 0.5)
  return { x0: X0, y0: Y0, cols: COLS, rows: ROWS, z }
}

function run(g: HeightGrid) {
  const ctx = createDropContext(g.cols * g.rows)
  const dets = detectDrops(ctx, g, CAMERA)
  const marked: [number, number, number][] = [] // col, row, mark
  for (let i = 0; i < g.cols * g.rows; i++) if (ctx.mark[i]) marked.push([i % g.cols, Math.floor(i / g.cols), ctx.mark[i]])
  return { ctx, dets, marked }
}

test('2 m scarp (high to the north): one continuous lip along the edge, on the high side, nothing else', () => {
  // Edge at y = 0: cells with centre y > 0 are 2 m up. Rows 0..19 high, 20..39 low.
  const { dets, marked } = run(grid((_x, y) => (y > 0 ? 2 : 0)))
  assert.equal(marked.length, COLS, `${marked.length} cells marked`)
  for (const [, row, m] of marked) {
    assert.equal(row, 19, 'the lip is the last high row')
    assert.equal(m, DROP_MARK.lip)
  }
  assert.equal(dets.length, 1, JSON.stringify(dets))
  const d = dets[0]
  console.log(`  2 m scarp: ${JSON.stringify(d)}`)
  assert.equal(d.kind, 'drop')
  assert.ok(Math.abs(d.x - CAMERA.x) <= 0.5 && Math.abs(d.y - 0.25) < 1e-6, 'nearest lip cell to the camera')
  assert.ok(Math.abs(d.distanceM - 6.25) < 0.3)
  assert.ok(Math.abs(d.radiusM - 10) < 0.3, 'half the 20 m edge')
  assert.ok(Math.abs(d.heightM! - 2) < 1e-6)
  assert.ok(d.confidence > 0.9)
})

test('diagonal 2 m scarp: the lip is one 8-connected segment', () => {
  const { dets, marked } = run(grid((x, y) => (x + y > 0 ? 2 : 0)))
  assert.equal(dets.length, 1, JSON.stringify(dets))
  assert.ok(marked.length >= COLS - 1, `${marked.length} lip cells`)
  for (const [col, row] of marked) {
    const x = X0 + (col + 0.5) * 0.5
    const y = Y0 - (row + 0.5) * 0.5
    assert.ok(x + y > 0 && x + y <= 1.0 + 1e-9, `lip cell (${x}, ${y}) is on the high side, next to the edge`)
  }
})

test('a scarp facing the other way: the lip is again the last high row', () => {
  const { dets, marked } = run(grid((_x, y) => (y > 0 ? 0 : 2))) // high to the south
  assert.equal(dets.length, 1)
  for (const [, row] of marked) assert.equal(row, 20)
})

test('0.5 m step: no drop', () => {
  assert.equal(run(grid((_x, y) => (y > 0 ? 0.5 : 0))).marked.length, 0)
})

test('1.0 m step is the limit (more than 1.0 m is needed), 1.2 m is a drop', () => {
  assert.equal(run(grid((_x, y) => (y > 0 ? 1.0 : 0))).marked.length, 0)
  assert.equal(run(grid((_x, y) => (y > 0 ? 1.2 : 0))).dets.length, 1)
})

test('gentle 15° ramp and a 25° slope: no drop', () => {
  for (const deg of [15, 25]) {
    const t = Math.tan((deg * Math.PI) / 180)
    assert.equal(run(grid((x, y) => t * (0.6 * x + 0.8 * y))).marked.length, 0, `${deg}°`)
  }
})

test('a 45° face is a drop all the way down', () => {
  // Ground falls 4 m over 4 m: z = 4 for y > 2, 0 for y < −2, a 45° face between.
  const { dets, marked } = run(grid((_x, y) => Math.min(4, Math.max(0, y + 2))))
  assert.equal(dets.length, 1)
  const rows = new Set(marked.map(([, r]) => r))
  assert.ok(rows.size >= 6, `${rows.size} rows of the face marked`)
})

test('unknown cells do not create drops: flat ground with an unknown band and scattered holes, plus noise', () => {
  const r = rng(5)
  const { marked } = run(
    grid((_x, y) => {
      if (y > -1 && y < 1) return NaN // 2 m band never seen
      if (r() < 0.2) return NaN
      return 0.05 * (r() - 0.5)
    }),
  )
  assert.equal(marked.length, 0)
})

test('scarp with the face unseen: the lip is drop and the unknown cells down to the low ground too', () => {
  // Rows 0..19 high (2 m), rows 20..21 unknown (the hidden face), 22..39 low. The low ground is 1.5 m from the lip.
  const { dets, marked } = run(grid((_x, y) => (y > 0 ? 2 : y > -1 ? NaN : 0)))
  assert.equal(dets.length, 1)
  const lips = marked.filter(([, , m]) => m === DROP_MARK.lip)
  const gaps = marked.filter(([, , m]) => m === DROP_MARK.gap)
  assert.equal(lips.length, COLS)
  assert.ok(lips.every(([, r]) => r === 19))
  assert.equal(gaps.length, 2 * COLS)
  assert.ok(gaps.every(([, r]) => r === 20 || r === 21))
})

test('a fall beyond 1.5 m across an unknown band is not claimed', () => {
  // Low ground starts 2 m from the lip: too far to call it a drop from these cells.
  assert.equal(run(grid((_x, y) => (y > 0 ? 2 : y > -2 ? NaN : 0))).marked.length, 0)
})

test('a single noisy high cell is dropped, a single cell falling more than 2 m is kept', () => {
  // A lone cell 1.5 m above its surroundings: every side is a lip direction, but one cell is noise.
  assert.equal(run(grid((x, y) => (Math.abs(x - 0.25) < 0.1 && Math.abs(y - 0.25) < 0.1 ? 1.5 : 0))).dets.length, 0)
  assert.equal(run(grid((x, y) => (Math.abs(x - 0.25) < 0.1 && Math.abs(y - 0.25) < 0.1 ? 3 : 0))).dets.length, 1)
})

test('mergeDrops paints drop cells into an offset patch and never overwrites rock', () => {
  const g = grid((_x, y) => (y > 0 ? 2 : y > -1 ? NaN : 0))
  const ctx = createDropContext(g.cols * g.rows)
  detectDrops(ctx, g, CAMERA)
  // A patch 2 m further west and 1 m further north than the grid, all safe, with one rock on the lip.
  const cols = 60
  const rows = 60
  const patch: HazardPatch = { x0: X0 - 2, y0: Y0 + 1, cols, rows, cls: new Uint8Array(cols * rows).fill(HAZARD.safe), conf: new Float32Array(cols * rows) }
  const lip = gridIndex(0.25, 0.25, patch.x0, patch.y0)
  patch.cls[lip.row * cols + lip.col] = HAZARD.rock
  const n = mergeDrops(ctx, g, patch)
  assert.equal(n, 3 * COLS - 1)
  assert.equal(patch.cls[lip.row * cols + lip.col], HAZARD.rock)
  const at = (x: number, y: number) => {
    const { col, row } = gridIndex(x, y, patch.x0, patch.y0)
    return patch.cls[row * cols + col]
  }
  assert.equal(at(3.25, 0.25), HAZARD.drop) // lip
  assert.equal(at(3.25, -0.25), HAZARD.drop) // hidden face
  assert.equal(at(3.25, -0.75), HAZARD.drop)
  assert.equal(at(3.25, -1.25), HAZARD.safe) // low ground
  assert.equal(at(3.25, 0.75), HAZARD.safe) // plateau behind the lip
  const { col, row } = gridIndex(3.25, 0.25, patch.x0, patch.y0)
  assert.ok(patch.conf[row * cols + col] > 0.9)
})

test('groundCellHeights: one frame of flat ground gives heights near 0 in view, unknown behind and on rocks', () => {
  const intr = intrinsics()
  const pose: Pose = { x: 0.13, y: -0.21, z: 1.65, headingDeg: 0, pitchDeg: -15 }
  const scene: Scene = { ground: tiltedPlane(0), boxes: [{ min: { x: -0.3, y: 5.7, z: 0 }, max: { x: 0.3, y: 6.3, z: 1.2 } }] }
  const cloud = createPointCloud()
  backProject(trueDisparity(intr, pose, scene), intr, pose, cloud)
  const g = createGroundContext(cloud.capacity)
  fitGround(g, cloud, pose)
  detectObstacles(createObstacleContext(g), g, cloud, intr, pose)
  const h = groundCellHeights(g, cloud, pose, { x0: 0, y0: 0, cols: 0, rows: 0, z: new Float32Array(g.nCells) })
  assert.equal(h.x0, g.patch.x0)
  assert.equal(h.cols, g.cols)
  const z = (x: number, y: number) => {
    const { col, row } = gridIndex(x, y, h.x0, h.y0)
    return h.z[row * h.cols + col]
  }
  assert.ok(Math.abs(z(0.1, 3.5)) < 0.05)
  assert.ok(Number.isNaN(z(0.1, -3)), 'behind the camera')
  assert.ok(Number.isNaN(z(0, 6)), 'rock cell')
  assert.ok(Number.isNaN(z(0, 20)), 'beyond 15 m')
  let known = 0
  for (const v of h.z) if (Number.isFinite(v)) known++
  assert.ok(known > 300, `${known} known cells`)
  // A 1.2 m rock next to flat ground is not a drop.
  assert.equal(detectDrops(createDropContext(g.nCells), h, pose).length, 0)
})
