// Rock memory for the in-view outlines (FIXLIST A4). Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Detection } from '../contracts.ts'
import { RockTracks } from './rockTracks.ts'

const rock = (x: number, y: number, level: 'hazard' | 'small' = 'hazard', heightM = 0.5): Detection => ({ kind: 'rock', level, x, y, radiusM: 0.3, heightM, distanceM: Math.hypot(x, y), confidence: 0.8, groundZ: 0 })
const here = { x: 0, y: 0 }

test('the same rock seen in several frames is one track; a rock 1.5 m away is another', () => {
  const t = new RockTracks()
  t.update([rock(2, 5), rock(3.5, 5)], 0, here)
  t.update([rock(2.1, 5.05), rock(3.45, 4.95)], 150, here)
  t.update([rock(1.95, 4.95)], 300, here)
  assert.equal(t.tracks.length, 2)
  const a = t.tracks.find((r) => Math.abs(r.x - 2) < 0.2)!
  assert.equal(a.hits, 3)
  assert.equal(a.firstSeen, 0)
  assert.equal(a.lastSeen, 300)
  assert.ok(Math.abs(a.x - 2.02) < 0.05, `x ${a.x}`)
})

test('level: hazard when at least a third of the sightings say so; sand and steep detections are ignored', () => {
  const t = new RockTracks()
  t.update([rock(0, 4, 'small', 0.25), { kind: 'sand', x: 1, y: 1, radiusM: 2, distanceM: 1.4, confidence: 1 }], 0, here)
  assert.equal(t.tracks.length, 1)
  assert.equal(t.tracks[0].level, 'small')
  t.update([rock(0, 4, 'hazard', 0.32)], 150, here)
  assert.equal(t.tracks[0].level, 'hazard')
  for (let k = 2; k < 6; k++) t.update([rock(0, 4, 'small', 0.25)], k * 150, here)
  assert.equal(t.tracks[0].level, 'small', '1 of 6')
})

test('a rock not seen for 8 s, or left 40 m behind, is forgotten', () => {
  const t = new RockTracks()
  t.update([rock(0, 5), rock(0, 9)], 0, here)
  t.update([rock(0, 9)], 7000, here)
  assert.equal(t.tracks.length, 2)
  t.update([rock(0, 9)], 8200, here)
  assert.equal(t.tracks.length, 1)
  t.update([], 8300, { x: 0, y: 60 })
  assert.equal(t.tracks.length, 0)
})

test('a rock first seen from 20 m (a metre off) and then from 5 m is one track at the near position', () => {
  const t = new RockTracks()
  const far: Detection = { ...rock(0.2, 20.5), distanceM: 20 }
  t.update([far], 0, { x: 0, y: 0, headingDeg: 0 })
  t.update([far], 150, { x: 0, y: 0, headingDeg: 0 })
  const near: Detection = { ...rock(0, 20), distanceM: 5 }
  t.update([near], 5000, { x: 0, y: 15, headingDeg: 0 })
  assert.equal(t.tracks.length, 1)
  assert.ok(Math.hypot(t.tracks[0].x, t.tracks[0].y - 20) < 0.15, `at ${t.tracks[0].x}, ${t.tracks[0].y}`)
})

test('a track in clear view from near that is not found five frames in a row is dropped; one off to the side stays', () => {
  const t = new RockTracks()
  t.update([{ ...rock(0, 6), distanceM: 6 }, { ...rock(8, 3), distanceM: 8.5 }], 0, { x: 0, y: 0, headingDeg: 0 })
  for (let k = 1; k <= 4; k++) t.update([], k * 150, { x: 0, y: 0, headingDeg: 0 })
  assert.equal(t.tracks.length, 2)
  t.update([], 750, { x: 0, y: 0, headingDeg: 0 })
  assert.equal(t.tracks.length, 1)
  assert.ok(t.tracks[0].x > 7, 'the rock outside the view is kept')
})
