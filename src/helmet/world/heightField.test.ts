// Run with `npm test`. Reads the real tiles and the 10 m grid from public/data with fs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Terrain } from '../../types.ts'
import { toLocal } from '../frames.ts'
import { coarseHeight, coarseTileHeights, HeightField, makeCoarseGrid } from './heightField.ts'
import { CELLS, decodeTileHeights, SAMPLES, tileBounds, type TileIndex } from './tileGrid.ts'

const DATA = new URL('../../../public/data/', import.meta.url)
const index = JSON.parse(readFileSync(new URL('helmet/index.json', DATA), 'utf8')) as TileIndex
const meta = JSON.parse(readFileSync(new URL('jezero_terrain.json', DATA), 'utf8'))
const elevBuf = readFileSync(new URL('jezero_elev.bin', DATA))
const terrain = {
  ...meta,
  elev: new Int16Array(elevBuf.buffer, elevBuf.byteOffset, elevBuf.byteLength / 2),
} as Terrain
const grid = makeCoarseGrid(terrain)

const tile = index.tiles.find((t) => t.id === 'r0029_c0076') ?? index.tiles[0]
const rawBuf = readFileSync(new URL('helmet/' + tile.file, DATA))
const raw = new Int16Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 2)
const ORIGIN = { lat: (tile.north + tile.south) / 2 + 0.001, lon: (tile.west + tile.east) / 2 - 0.0015 }

function samplePoint(i: number, j: number) {
  const b = tileBounds(tile.row, tile.col, index)
  return toLocal({ lat: b.north - (i / CELLS) * index.tileDegLat, lon: b.west + (j / CELLS) * index.tileDegLon }, ORIGIN)
}

function fieldWithTile() {
  const f = new HeightField(index, ORIGIN, grid)
  f.setTile(tile.row, tile.col, decodeTileHeights(raw, tile.zMin), true)
  return f
}

test('index tile bounds match the grid formula', () => {
  for (const t of index.tiles.slice(0, 20)) {
    const b = tileBounds(t.row, t.col, index)
    assert.ok(Math.abs(b.west - t.west) < 1e-8 && Math.abs(b.north - t.north) < 1e-8, t.id)
    assert.ok(Math.abs(b.east - t.east) < 1e-8 && Math.abs(b.south - t.south) < 1e-8, t.id)
  }
})

test('heightAt reproduces samples read straight from the tile .bin within 1 cm', () => {
  const f = fieldWithTile()
  for (const [i, j] of [[0, 0], [37, 91], [64, 64], [128, 128], [5, 120], [127, 1]]) {
    const want = tile.zMin + raw[i * SAMPLES + j] / 100
    const p = samplePoint(i, j)
    assert.ok(Math.abs(f.heightAt(p.x, p.y) - want) < 0.01, `sample ${i},${j}: ${f.heightAt(p.x, p.y)} vs ${want}`)
  }
  assert.equal(f.isFine(samplePoint(64, 64).x, samplePoint(64, 64).y), true)
})

test('heightAt is bilinear between samples', () => {
  const f = fieldWithTile()
  const z = (i: number, j: number) => tile.zMin + raw[i * SAMPLES + j] / 100
  const i = 40
  const j = 70
  const a = samplePoint(i, j)
  const b = samplePoint(i, j + 1)
  const c = samplePoint(i + 1, j)
  const mid = f.heightAt((a.x + b.x) / 2, (a.y + b.y) / 2)
  assert.ok(Math.abs(mid - (z(i, j) + z(i, j + 1)) / 2) < 0.005, 'midpoint along east')
  const midS = f.heightAt((a.x + c.x) / 2, (a.y + c.y) / 2)
  assert.ok(Math.abs(midS - (z(i, j) + z(i + 1, j)) / 2) < 0.005, 'midpoint along south')
  const centre = f.heightAt((b.x + c.x) / 2, (b.y + c.y) / 2)
  const avg4 = (z(i, j) + z(i, j + 1) + z(i + 1, j) + z(i + 1, j + 1)) / 4
  assert.ok(Math.abs(centre - avg4) < 0.005, 'cell centre = mean of the four corners')
})

test('without a 1 m tile heightAt falls back to the 10 m grid and is flagged coarse', () => {
  const f = new HeightField(index, ORIGIN, grid)
  const p = samplePoint(64, 64)
  const ll = { lat: (tile.north + tile.south) / 2, lon: (tile.west + tile.east) / 2 }
  assert.ok(Math.abs(f.heightAt(p.x, p.y) - coarseHeight(grid, ll.lat, ll.lon)) < 0.01)
  assert.equal(f.isFine(p.x, p.y), false)
  // the 1 m tile and the 10 m grid agree to a couple of metres (the T1.1 builder checked the medians)
  const fine = fieldWithTile()
  assert.ok(Math.abs(fine.heightAt(p.x, p.y) - f.heightAt(p.x, p.y)) < 3)
  // at a cell centre the grid value comes back exactly
  const m = grid.meta
  const col = 800
  const row = 300
  const cLat = m.north - ((row + 0.5) / m.height) * (m.north - m.south)
  const cLon = m.west + ((col + 0.5) / m.width) * (m.east - m.west)
  assert.ok(Math.abs(coarseHeight(grid, cLat, cLon) - terrain.elev[row * m.width + col] / 10) < 1e-3)
})

test('coarse tiles stay within 0.3 m of the 10 m grid and slopeAt is sane', () => {
  const row = 30
  const col = 60
  const h = coarseTileHeights(row, col, index, grid)
  const b = tileBounds(row, col, index)
  let maxDev = 0
  for (let i = 0; i < SAMPLES; i += 8) {
    for (let j = 0; j < SAMPLES; j += 8) {
      const base = coarseHeight(grid, b.north - (i / CELLS) * index.tileDegLat, b.west + (j / CELLS) * index.tileDegLon)
      maxDev = Math.max(maxDev, Math.abs(h[i * SAMPLES + j] - base))
    }
  }
  assert.ok(maxDev <= 0.3 + 1e-6 && maxDev > 0.01, `micro-relief ${maxDev}`)
  const f = fieldWithTile()
  const p = samplePoint(64, 64)
  const s = f.slopeAt(p.x, p.y)
  assert.ok(s >= 0 && s < 60, `slope ${s}`)
})

test('no-data cells of the 10 m grid are filled', () => {
  let filledBad = 0
  for (let k = 0; k < grid.elevM.length; k++) if (!Number.isFinite(grid.elevM[k]) || grid.elevM[k] > -1000) filledBad++
  assert.equal(filledBad, 0)
})
