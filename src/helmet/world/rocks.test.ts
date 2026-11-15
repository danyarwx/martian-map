import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARS_RADIUS_M } from '../../lib/geo.ts'
import { toLocal } from '../frames.ts'
import {
  cumulativeArea,
  D_MAX,
  D_MIN,
  DEMO_BEFORE_STOP_M,
  DEMO_HALF_WIDTH_M,
  DEMO_MIN_ROCKS,
  demoBoulderFields,
  demoRocksByTile,
  K_ROUGH,
  K_SMOOTH,
  RockField,
  rocksInTile,
  roughGrid,
  type Rock,
} from './rocks.ts'
import type { RoutesFileLeg } from './routes.ts'
import { tileBounds, tileId, type TileGridSpec } from './tileGrid.ts'

const RAD = Math.PI / 180
const ORIGIN = { lat: 18.52, lon: 77.2229 }
const GRID: TileGridSpec = {
  origin: ORIGIN,
  tileSizeM: 128,
  scaleLat: 18.46,
  tileDegLat: 128 / (MARS_RADIUS_M * RAD),
  tileDegLon: 128 / (MARS_RADIUS_M * RAD * Math.cos(18.46 * RAD)),
}
const TILE_AREA = 128 * 128

function tile(row: number, col: number, extra: Partial<Parameters<typeof rocksInTile>[1]> = {}): Rock[] {
  return rocksInTile(tileId(row, col), { row, col, grid: GRID, origin: ORIGIN, ...extra })
}

/** Share of the ground covered by rocks with a ≤ d < b (circles of diameter d). */
function coveredShare(rocks: Rock[], a: number, b: number, area: number): number {
  let s = 0
  for (const r of rocks) if (r.d >= a && r.d < b) s += (Math.PI * r.d * r.d) / 4
  return s / area
}

const BINS: [number, number][] = [
  [D_MIN, 0.3],
  [0.3, 0.6],
  [0.6, D_MAX],
]

for (const [name, k, rough] of [
  ['smooth floor', K_SMOOTH, null],
  ['rough ground', K_ROUGH, new Uint8Array(256).fill(1)],
] as const) {
  test(`rock sizes on ${name} follow Golombek & Rapp F(D) within 20 % in three size bins`, () => {
    const rocks: Rock[] = []
    const n = 24
    for (let t = 0; t < n; t++) rocks.push(...tile(10 + (t % 6), 20 + Math.floor(t / 6), { rough }))
    for (const [a, b] of BINS) {
      const want = cumulativeArea(k, a) - cumulativeArea(k, b)
      const got = coveredShare(rocks, a, b, n * TILE_AREA)
      assert.ok(Math.abs(got - want) / want < 0.2, `${a}–${b} m: covered ${got.toFixed(5)}, F(D) says ${want.toFixed(5)}`)
    }
    for (const r of rocks) assert.ok(r.d >= D_MIN && r.d <= D_MAX)
  })
}

test('a tile always gets the same rocks, and another tile gets different ones', () => {
  const a = tile(3, 4)
  const b = tile(3, 4)
  assert.deepEqual(a, b)
  const c = tile(3, 5)
  assert.notDeepEqual(
    a.slice(0, 20).map((r) => r.d),
    c.slice(0, 20).map((r) => r.d),
  )
})

test('rocks stay inside their tile and sit on the ground', () => {
  const heights = new Float32Array(129 * 129)
  for (let i = 0; i < 129; i++) for (let j = 0; j < 129; j++) heights[i * 129 + j] = -2500 + j * 0.1 // rises to the east
  const rocks = tile(7, 9, { heights })
  const b = tileBounds(7, 9, GRID)
  const nw = toLocal({ lat: b.north, lon: b.west }, ORIGIN)
  const se = toLocal({ lat: b.south, lon: b.east }, ORIGIN)
  assert.ok(rocks.length > 1000)
  for (const r of rocks) {
    assert.ok(r.x >= nw.x && r.x <= se.x && r.y <= nw.y && r.y >= se.y)
    const want = -2500 + (((r.x - nw.x) / (se.x - nw.x)) * 128) * 0.1
    assert.ok(Math.abs(r.z - want) < 0.01)
  }
})

test('no rocks on sand', () => {
  const sand = new Uint8Array(256 * 256)
  for (let r = 0; r < 256; r++) for (let c = 0; c < 128; c++) sand[r * 256 + c] = 1 // western half is sand
  const rocks = tile(5, 5, { sand })
  const b = tileBounds(5, 5, GRID)
  const midX = toLocal({ lat: b.north, lon: (b.west + b.east) / 2 }, ORIGIN).x
  assert.ok(rocks.length > 500)
  assert.ok(rocks.every((r) => r.x >= midX - 1e-6))
  // the eastern half is the same as without the mask
  const free = tile(5, 5).filter((r) => r.x >= midX)
  assert.equal(rocks.length, free.length)
})

test('roughGrid marks textured cells only', () => {
  const px = new Uint8Array(512 * 512 * 4).fill(120)
  // one 8 m cell (32 px) of strong texture at cell row 2, col 3
  for (let y = 64; y < 96; y++) for (let x = 96; x < 128; x++) px[(y * 512 + x) * 4] = (x + y) % 2 ? 200 : 40
  const g = roughGrid(px)
  assert.equal(g.length, 256)
  assert.equal(g[2 * 16 + 3], 1)
  assert.equal(g.reduce((s, v) => s + v, 0), 1)
})

test('demo boulder field: a 50 m band of 0.5–1.2 m boulders across the path, 240 m before the stop', () => {
  // a straight leg due north, 1 km long, ending at the stop
  const start = { lat: 18.45, lon: 77.4 }
  const path: [number, number][] = []
  for (let m = 0; m <= 1000; m += 10) path.push([start.lat + m / (MARS_RADIUS_M * RAD), start.lon])
  const legs: RoutesFileLeg[] = [{ id: 'habitat>three-forks', fromId: 'habitat', toId: 'three-forks', path, distanceM: 1000 }]
  const fields = demoBoulderFields([{ id: 'three-forks', tiles: [] }], legs)
  assert.equal(fields.length, 1)
  const f = fields[0]
  assert.ok(f.rocks.length >= DEMO_MIN_ROCKS && f.rocks.length <= DEMO_MIN_ROCKS + 6)
  const stop = { lat: path[path.length - 1][0], lon: path[path.length - 1][1] }
  let west = Infinity
  let east = -Infinity
  for (const r of f.rocks) {
    assert.ok(r.d >= 0.5 && r.d <= 1.2)
    const p = toLocal(r, stop)
    assert.ok(Math.abs(-p.y - DEMO_BEFORE_STOP_M) <= 2.5, `boulder ${(-p.y).toFixed(1)} m before the stop`)
    assert.ok(Math.abs(p.x) <= DEMO_HALF_WIDTH_M + 0.5)
    west = Math.min(west, p.x)
    east = Math.max(east, p.x)
  }
  assert.ok(west < -(DEMO_HALF_WIDTH_M - 2) && east > DEMO_HALF_WIDTH_M - 2, 'the band crosses the path, edge to edge')
  assert.deepEqual(demoBoulderFields([{ id: 'three-forks', tiles: [] }], legs), fields)

  // they end up in the tiles' rocks, flagged, with no natural rock inside them
  const byTile = demoRocksByTile(fields, GRID)
  let seen = 0
  for (const [id, demo] of byTile) {
    const m = /^r(\d+)_c(\d+)$/.exec(id)!
    const rocks = rocksInTile(id, { row: +m[1], col: +m[2], grid: GRID, origin: stop, demo })
    const placed = rocks.filter((r) => r.demo)
    seen += placed.length
    for (const d of placed) {
      for (const r of rocks) if (!r.demo) assert.ok(Math.hypot(r.x - d.x, r.y - d.y) >= (r.d + d.d) / 2)
    }
  }
  assert.equal(seen, f.rocks.length)
})

test('RockField.rocksNear finds exactly the rocks within reach', () => {
  const field = new RockField()
  const all: Rock[] = []
  for (const [row, col] of [
    [0, 0],
    [0, 1],
    [1, 0],
  ]) {
    const rocks = tile(row, col)
    field.setTile(tileId(row, col), rocks)
    all.push(...rocks)
  }
  assert.equal(field.count, all.length)
  const b = tileBounds(0, 0, GRID)
  const corner = toLocal({ lat: b.south, lon: b.east }, ORIGIN) // where the three tiles meet
  for (const [dx, dy, r] of [
    [0, 0, 6],
    [-40, 30, 2.5],
    [50, 60, 12],
    [-500, 0, 5],
  ]) {
    const x = corner.x + dx
    const y = corner.y + dy
    const want = all.filter((k) => Math.hypot(k.x - x, k.y - y) <= r + k.d / 2)
    const got = field.rocksNear(x, y, r)
    assert.equal(got.length, want.length)
    assert.deepEqual(new Set(got), new Set(want))
  }
  field.removeTile(tileId(0, 1))
  assert.ok(field.count < all.length)
})
