// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TerrainMeta } from '../../types.ts'
import { HAZARD, type HazardClass, type HazardPatch } from '../contracts.ts'
import { toLatLon } from '../frames.ts'
import { HAZARD_RGBA, HazardGrid, toLatLonBounds } from './hazardGrid.ts'

const ORIGIN = { lat: 18.45886, lon: 77.4061 }

/** A patch of `cols` × `rows` cells with NW corner at local (x0, y0), every cell `cls` at confidence `conf`. */
function patch(x0: number, y0: number, cols: number, rows: number, cls: HazardClass, conf = 0.8): HazardPatch {
  return {
    x0, y0, cols, rows,
    cls: new Uint8Array(cols * rows).fill(cls),
    conf: new Float32Array(cols * rows).fill(conf),
  }
}

test('an empty grid is unseen everywhere and draws nothing', () => {
  const g = new HazardGrid()
  assert.equal(g.classAt(3, -7), HAZARD.unseen)
  assert.equal(g.confAt(3, -7), 0)
  assert.equal(g.extent(), null)
  assert.equal(g.toImage().width, 0)
  assert.deepEqual(g.hazardsList(), [])
  assert.equal(g.blockCount, 0)
})

test('repeated observations converge: the class stays and the confidence rises', () => {
  const g = new HazardGrid()
  let last = 0
  for (let f = 0; f < 12; f++) {
    g.update(patch(1, 1, 1, 1, HAZARD.rock, 0.7), f)
    assert.equal(g.classAt(1.25, 0.75), HAZARD.rock, `frame ${f}`)
    const c = g.confAt(1.25, 0.75)
    assert.ok(c >= last, `confidence fell at frame ${f}: ${c} < ${last}`)
    last = c
  }
  assert.ok(last > 0.95, `${last}`)
  assert.ok(last < 0.99, 'log-odds are clamped')
  assert.equal(g.seenAtXY(1.25, 0.75), 11)
})

test('one weak observation of safe ground already counts as seen and safe', () => {
  const g = new HazardGrid()
  g.update(patch(0, 0, 2, 2, HAZARD.safe, 0.6), 0)
  assert.equal(g.classAt(0.1, -0.1), HAZARD.safe)
  assert.ok(Math.abs(g.confAt(0.1, -0.1) - 0.6) < 1e-6)
  assert.equal(g.classAt(1.1, -0.1), HAZARD.unseen, 'outside the patch')
})

test('conflicting observations flip the class after enough frames', () => {
  const g = new HazardGrid()
  for (let f = 0; f < 10; f++) g.update(patch(0, 0, 1, 1, HAZARD.rock, 0.9), f)
  // Clear views erase a false rock, but not in a single frame.
  const flips: number[] = []
  for (let f = 10; f < 20; f++) {
    g.update(patch(0, 0, 1, 1, HAZARD.safe, 0.9), f)
    flips.push(g.classAt(0.25, -0.25))
  }
  assert.equal(flips[0], HAZARD.rock, 'one clear view does not erase a well-seen rock')
  assert.equal(flips.at(-1), HAZARD.safe)
  // Then sand, seen often enough, wins over safe.
  for (let f = 20; f < 30; f++) g.update(patch(0, 0, 1, 1, HAZARD.sand, 0.8), f)
  assert.equal(g.classAt(0.25, -0.25), HAZARD.sand)
  // And one hazard replaces another.
  for (let f = 30; f < 40; f++) g.update(patch(0, 0, 1, 1, HAZARD.steep, 0.8), f)
  assert.equal(g.classAt(0.25, -0.25), HAZARD.steep)
})

test('cells with class 0 in a patch are not observations', () => {
  const g = new HazardGrid()
  const p = patch(0, 0, 2, 1, HAZARD.rock)
  p.cls[1] = HAZARD.unseen
  g.update(p, 0)
  assert.equal(g.classAt(0.25, -0.25), HAZARD.rock)
  assert.equal(g.classAt(0.75, -0.25), HAZARD.unseen)
})

test('the grid grows across block boundaries, including to negative indices', () => {
  const g = new HazardGrid()
  // A 4 × 4 m patch straddling the corner of four 64 m blocks at the origin...
  g.update(patch(-2, 2, 8, 8, HAZARD.safe), 0)
  assert.equal(g.blockCount, 4)
  // ...and one far east, in a block of its own.
  g.update(patch(130, 0, 2, 2, HAZARD.rock), 1)
  assert.equal(g.blockCount, 5)
  for (const [x, y] of [[-1.9, 1.9], [1.9, 1.9], [-1.9, -1.9], [1.9, -1.9]]) {
    assert.equal(g.classAt(x, y), HAZARD.safe, `${x}, ${y}`)
  }
  assert.equal(g.classAt(130.3, -0.3), HAZARD.rock)
  assert.equal(g.classAt(64, -64), HAZARD.unseen)
  assert.deepEqual(g.extent(), { minX: -2, maxX: 131, minY: -2, maxY: 2 })
})

test('ground heights are kept and blended', () => {
  const g = new HazardGrid()
  assert.ok(Number.isNaN(g.groundAt(0.25, -0.25)))
  g.update(patch(0, 0, 1, 1, HAZARD.safe), 0, new Float32Array([10]))
  assert.equal(g.groundAt(0.25, -0.25), 10)
  g.update(patch(0, 0, 1, 1, HAZARD.safe), 1, new Float32Array([NaN]))
  assert.equal(g.groundAt(0.25, -0.25), 10, 'unknown height leaves it alone')
  g.update(patch(0, 0, 1, 1, HAZARD.safe), 2, new Float32Array([11]))
  const z = g.groundAt(0.25, -0.25)
  assert.ok(z > 10 && z < 11, `${z}`)
})

test('toImage paints each class in its colour and leaves unseen ground transparent', () => {
  const g = new HazardGrid()
  // One row of five cells, x 0..2.5 m: safe, rock, sand, steep, drop.
  const classes: HazardClass[] = [HAZARD.safe, HAZARD.rock, HAZARD.sand, HAZARD.steep, HAZARD.drop]
  classes.forEach((cls, c) => g.update(patch(c * 0.5, 0, 1, 1, cls, 0.9), 0))
  const img = g.toImage({ minX: 0, maxX: 3, minY: -0.5, maxY: 0 })
  assert.equal(img.width, 6)
  assert.equal(img.height, 1)
  assert.equal(img.x0, 0)
  assert.equal(img.y0, 0)
  classes.forEach((cls, c) => assert.deepEqual([...img.rgba.slice(c * 4, c * 4 + 4)], [...HAZARD_RGBA[cls]], `cell ${c}`))
  assert.deepEqual([...img.rgba.slice(20, 24)], [0, 0, 0, 0], 'unseen')
  assert.deepEqual(HAZARD_RGBA[HAZARD.rock], [255, 90, 78, 255])
  // Without bounds the image covers what was seen.
  const seen = g.toImage()
  assert.deepEqual([seen.width, seen.height, seen.x0, seen.y0], [5, 1, 0, 0])
})

test('toLatLonBounds puts the image where its local corners are', () => {
  const img = { width: 40, height: 20, x0: -10, y0: 5 }
  const b = toLatLonBounds(img, ORIGIN)
  const nw = toLatLon(-10, 5, ORIGIN)
  const se = toLatLon(10, -5, ORIGIN)
  assert.equal(b.west, nw.lon)
  assert.equal(b.north, nw.lat)
  assert.equal(b.east, se.lon)
  assert.equal(b.south, se.lat)
  assert.ok(b.west < b.east && b.south < b.north)
})

test('hazardsList merges a 3 × 3 rock blob into one cluster with a covering radius', () => {
  const g = new HazardGrid()
  g.update(patch(10, 10, 3, 3, HAZARD.rock), 0)
  g.update(patch(20, 10, 1, 1, HAZARD.rock), 0) // a lone cell: below minCells
  g.update(patch(10.5, 8.5, 2, 1, HAZARD.sand), 0) // touches the blob but is another class
  g.update(patch(8, 12, 2, 2, HAZARD.safe), 0)
  const list = g.hazardsList()
  const rocks = list.filter((h) => h.kind === 'rock')
  assert.equal(rocks.length, 1)
  const [r] = rocks
  assert.equal(r.cells, 9)
  assert.ok(Math.abs(r.x - 10.75) < 1e-9 && Math.abs(r.y - 9.25) < 1e-9, `${r.x}, ${r.y}`)
  // The circle reaches the outer corners of the 1.5 m square (0.75·√2 ≈ 1.06 m) give or take a cell.
  assert.ok(r.radiusM >= 0.9 && r.radiusM <= 1.1, `${r.radiusM}`)
  assert.deepEqual(list.filter((h) => h.kind === 'sand').map((h) => h.cells), [2])
  assert.equal(g.hazardsList(1).filter((h) => h.kind === 'rock').length, 2)
})

test('hazardsList follows a cluster across a block boundary', () => {
  const g = new HazardGrid()
  g.update(patch(62, 0, 8, 1, HAZARD.rock), 0) // x 62..66 m, crosses the 64 m block edge
  const list = g.hazardsList()
  assert.equal(list.length, 1)
  assert.equal(list[0].cells, 8)
})

/** 10 × 10 planner cells of 10 m, around the origin: cell (5, 5) covers local x 0..10, y −10..0 (about). */
function meta(): TerrainMeta {
  const cellDegLat = 10 / (3389500 * Math.PI / 180)
  const cellDegLon = cellDegLat / Math.cos(ORIGIN.lat * Math.PI / 180)
  return {
    source: 'test',
    west: ORIGIN.lon - 5 * cellDegLon,
    east: ORIGIN.lon + 5 * cellDegLon,
    south: ORIGIN.lat - 5 * cellDegLat,
    north: ORIGIN.lat + 5 * cellDegLat,
    width: 10,
    height: 10,
    cellMetersX: 10,
    cellMetersY: 10,
  }
}

test('blockedPlannerCells marks a planner cell only above the coverage threshold', () => {
  const m = meta()
  const g = new HazardGrid()
  // 4 × 5 m of rock inside planner cell (5, 5): 20 % of its 100 m².
  g.update(patch(2, -2, 8, 10, HAZARD.rock), 0)
  // 6 × 6 m of sand in cell (6, 5): sand never blocks.
  g.update(patch(12, -2, 12, 12, HAZARD.sand), 0)
  // 6 × 6 m of steep in cell (5, 6): 36 %.
  g.update(patch(2, -12, 12, 12, HAZARD.steep), 0)
  const at = (col: number, row: number) => row * m.width + col
  assert.deepEqual([...g.blockedPlannerCells(m, ORIGIN)], [at(5, 6)])
  assert.deepEqual([...g.blockedPlannerCells(m, ORIGIN, 0.15)].sort((a, b) => a - b), [at(5, 5), at(5, 6)])
  // More rock in cell (5, 5) pushes it over 30 %.
  g.update(patch(2, -7, 8, 6, HAZARD.rock), 1) // now 32 m²
  assert.deepEqual([...g.blockedPlannerCells(m, ORIGIN)].sort((a, b) => a - b), [at(5, 5), at(5, 6)])
  // Hazards outside the terrain grid are ignored.
  g.update(patch(500, 0, 20, 20, HAZARD.drop), 2)
  assert.equal(g.blockedPlannerCells(m, ORIGIN).size, 2)
})

test('heightWindow hands out a fused height only after three frames agreed on it', () => {
  const g = new HazardGrid()
  const patch = { x0: 0, y0: 2, cols: 4, rows: 4, cls: new Uint8Array(16).fill(HAZARD.safe), conf: new Float32Array(16).fill(0.8) }
  const z = (v: number) => new Float32Array(16).fill(v)
  const known = () => g.heightWindow(1, 1, 2).z.filter((v) => v === v)
  g.update(patch, 1, z(5))
  g.update(patch, 2, z(5.1))
  assert.equal(known().length, 0, 'two frames are not enough')
  g.update(patch, 3, z(5.05))
  assert.equal(known().length, 16)
  assert.ok(known().every((v) => Math.abs(v - 5.05) < 0.1))
  // one stray height (a stereo mismatch 1.2 m low) takes the trust away until three frames agree again
  g.update(patch, 4, z(3.8))
  assert.equal(known().length, 0)
  g.update(patch, 5, z(5.05))
  g.update(patch, 6, z(5.05))
  g.update(patch, 7, z(5.05))
  assert.ok(known().length === 16 && known().every((v) => Math.abs(v - 5.05) < 0.2))
})
