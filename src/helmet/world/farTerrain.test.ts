// Run with `npm test`. Builds the far terrain from the real 10 m grid in public/data.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Terrain } from '../../types.ts'
import { threeToLocal, toLatLon } from '../frames.ts'
import { buildFarGeometryData, FAR_RADIUS_M } from './farTerrain.ts'
import { coarseHeight, makeCoarseGrid } from './heightField.ts'

const DATA = new URL('../../../public/data/', import.meta.url)
const meta = JSON.parse(readFileSync(new URL('jezero_terrain.json', DATA), 'utf8'))
const elevBuf = readFileSync(new URL('jezero_elev.bin', DATA))
const terrain = { ...meta, elev: new Int16Array(elevBuf.buffer, elevBuf.byteOffset, elevBuf.byteLength / 2) } as Terrain
const grid = makeCoarseGrid(terrain)
// the middle of the grid: the most terrain within 4 km, so the largest mesh a session can get
const ORIGIN = { lat: (meta.north + meta.south) / 2, lon: (meta.west + meta.east) / 2 }

const t0 = performance.now()
const far = buildFarGeometryData(grid, ORIGIN)
const buildMs = performance.now() - t0

test('the far terrain stays within its triangle budget', () => {
  console.log(`far terrain: ${far.vertices} vertices, ${far.triangles} triangles, built in ${buildMs.toFixed(0)} ms`)
  assert.ok(far.triangles > 10_000, `${far.triangles} triangles`)
  assert.ok(far.triangles <= 80_000, `${far.triangles} triangles`)
})

test('vertices lie on the 10 m grid, within the radius, never on a no-data cell', () => {
  const m = grid.meta
  let moved = 0
  for (let v = 0; v < far.vertices; v++) {
    const p = threeToLocal({ x: far.position[v * 3], y: far.position[v * 3 + 1], z: far.position[v * 3 + 2] })
    assert.ok(Math.hypot(p.x, p.y) < FAR_RADIUS_M + 120)
    const ll = toLatLon(p.x, p.y, ORIGIN)
    const c = Math.floor(((ll.lon - m.west) / (m.east - m.west)) * m.width)
    const r = Math.floor(((m.north - ll.lat) / (m.north - m.south)) * m.height)
    assert.equal(grid.noData[r * m.width + c], 0)
    // an edge vertex next to a coarser block is moved onto that block's edge; all others are the grid height
    if (Math.abs(p.z - coarseHeight(grid, ll.lat, ll.lon)) > 0.01) moved++
  }
  assert.ok(moved < far.vertices * 0.05, `${moved} of ${far.vertices} vertices moved`)
})

test('all triangles face up and no edge is shared by more than two', () => {
  const edges = new Map<number, number>()
  const n = far.vertices
  const P = far.position
  for (let t = 0; t < far.triangles; t++) {
    const a = far.index[t * 3]
    const b = far.index[t * 3 + 1]
    const c = far.index[t * 3 + 2]
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = Math.min(p, q) * n + Math.max(p, q)
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
    // three.js y is up: the y of cross(b − a, c − a) must be positive
    const ux = P[b * 3] - P[a * 3]
    const uz = P[b * 3 + 2] - P[a * 3 + 2]
    const vx = P[c * 3] - P[a * 3]
    const vz = P[c * 3 + 2] - P[a * 3 + 2]
    assert.ok(uz * vx - ux * vz > 0, 'faces up')
  }
  for (const k of edges.values()) assert.ok(k <= 2)
})

test('no cracks: a vertex in the middle of a coarser block\'s edge lies on that edge', () => {
  const P = far.position
  const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`
  const at = new Map<string, number>()
  for (let v = 0; v < far.vertices; v++) at.set(key(P[v * 3], P[v * 3 + 2]), v)
  let checked = 0
  for (let t = 0; t < far.triangles; t++) {
    const tri = [far.index[t * 3], far.index[t * 3 + 1], far.index[t * 3 + 2]]
    for (let e = 0; e < 3; e++) {
      const a = tri[e]
      const b = tri[(e + 1) % 3]
      const dx = Math.abs(P[a * 3] - P[b * 3])
      const dz = Math.abs(P[a * 3 + 2] - P[b * 3 + 2])
      if (dx > 1 && dz > 1) continue // a diagonal, never a block edge
      const mid = at.get(key((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2))
      if (mid === undefined) continue
      assert.ok(Math.abs(P[mid * 3 + 1] - (P[a * 3 + 1] + P[b * 3 + 1]) / 2) < 1e-3, 'on the coarse edge')
      checked++
    }
  }
  assert.ok(checked > 50, `${checked} T-junctions checked`)
})
