// Run with `npm test`. The guide must not move when the astronaut only looks around or sees new ground.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HAZARD, type HazardClass } from '../contracts.ts'
import { buildTrackLocal } from './follow.ts'
import { distToPolyline, GuideKeeper } from './guide.ts'
import { LocalPlanner } from './localPlanner.ts'

/** A hazard grid on 0.5 m cells: unseen unless set. */
class Cells {
  private m = new Map<string, HazardClass>()
  classAtCell(c: number, r: number): HazardClass {
    return this.m.get(`${c},${r}`) ?? HAZARD.unseen
  }
  /** Marks local (x, y) metres. */
  set(x: number, y: number, k: HazardClass): void {
    this.m.set(`${Math.floor(x / 0.5)},${Math.floor(-y / 0.5)}`, k)
  }
  /** Fills a box of local metres. */
  box(x0: number, y0: number, x1: number, y1: number, k: HazardClass): void {
    for (let x = x0; x <= x1; x += 0.5) for (let y = y0; y <= y1; y += 0.5) this.set(x, y, k)
  }
}

// a straight route 100 m north from the origin
const track = buildTrackLocal([{ x: 0, y: 0 }, { x: 0, y: 100 }])
const sig = (p: { x: number; y: number }[]) => p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ')

function step(keeper: GuideKeeper, planner: LocalPlanner, grid: Cells, x: number, y: number, hint?: number) {
  const fresh = planner.plan(grid, track, x, y, hint)
  return keeper.update(fresh, grid, track, x, y)
}

test('open ground: the guide is the planned line, and looking around (new safe/sand cells) does not move it', () => {
  const grid = new Cells()
  const planner = new LocalPlanner()
  const keeper = new GuideKeeper()
  const first = step(keeper, planner, grid, 0, 10)
  assert.equal(keeper.mode, 'route')
  for (const p of first.path) assert.ok(Math.abs(p.x) < 1e-9, 'guide lies on the route line')
  // a head sweep reveals ground left and right: safe cells, a sand patch off to one side, a rock 8 m off the line
  const seen: [number, number, HazardClass][] = []
  for (let x = -15; x <= 15; x += 0.5) for (let y = 10; y <= 40; y += 0.5) seen.push([x, y, HAZARD.safe])
  for (let i = 0; i < 12; i++) {
    for (const [x, y, k] of seen.slice(i * 200, (i + 1) * 200)) grid.set(x, y, k)
    if (i === 4) grid.box(-6, 20, -3, 24, HAZARD.sand)
    if (i === 7) grid.box(7.5, 30, 8.5, 31, HAZARD.rock)
    const g = step(keeper, planner, grid, 0, 10)
    assert.equal(sig(g.path), sig(first.path), `tick ${i}: the guide moved although the astronaut only looked around`)
    assert.equal(g.steerDeg, first.steerDeg)
  }
})

test('sand on the line does not pull the guide off it', () => {
  const grid = new Cells()
  grid.box(-1, 18, 1, 22, HAZARD.sand)
  const keeper = new GuideKeeper()
  const g = step(keeper, new LocalPlanner(), grid, 0, 10)
  assert.equal(keeper.mode, 'route')
  for (const p of g.path) assert.ok(Math.abs(p.x) < 1e-9)
})

test('a rock on the line: one detour, kept while new ground is seen, round the rock', () => {
  const grid = new Cells()
  grid.box(-15, 0, 15, 45, HAZARD.safe)
  grid.box(-1.5, 20, 1.5, 21, HAZARD.rock)
  const planner = new LocalPlanner()
  const keeper = new GuideKeeper()
  const first = step(keeper, planner, grid, 0, 10)
  assert.equal(keeper.mode, 'detour')
  assert.ok(first.path.length > 2)
  for (const p of first.path) assert.ok(!(Math.abs(p.x) < 1.6 && p.y > 19.4 && p.y < 21.6), 'detour avoids the rock')
  // more ground gets seen (a sand patch elsewhere, cells beyond the window): the detour stays
  for (let i = 0; i < 8; i++) {
    grid.box(-20, 46 + i, 20, 46 + i, HAZARD.safe)
    if (i === 3) grid.box(8, 12, 10, 14, HAZARD.sand)
    const g = step(keeper, planner, grid, 0, 10)
    assert.equal(sig(g.path), sig(first.path), `tick ${i}: the kept detour changed`)
  }
})

test('walking along a kept detour trims it but keeps its shape; a rock appearing on it forces a new one', () => {
  const grid = new Cells()
  grid.box(-15, 0, 15, 45, HAZARD.safe)
  grid.box(-1.5, 20, 1.5, 21, HAZARD.rock)
  const planner = new LocalPlanner()
  const keeper = new GuideKeeper()
  const first = step(keeper, planner, grid, 0, 10)
  const p3 = first.path[3]
  const g = step(keeper, planner, grid, p3.x, p3.y)
  assert.equal(keeper.mode, 'detour')
  // every remaining point of the kept detour is still on it
  for (const q of g.path.slice(1)) assert.ok(distToPolyline(first.path, q.x, q.y) < 1e-6)
  // a rock lands on the detour ahead
  const ahead = first.path[Math.min(first.path.length - 2, 8)]
  grid.box(ahead.x - 0.5, ahead.y - 0.5, ahead.x + 0.5, ahead.y + 0.5, HAZARD.rock)
  const h = step(keeper, planner, grid, p3.x, p3.y)
  for (const q of h.path) assert.ok(Math.hypot(q.x - ahead.x, q.y - ahead.y) > 0.5, 'the new detour avoids the new rock')
})

test('leaving the detour by more than keepNearM takes a fresh path', () => {
  const grid = new Cells()
  grid.box(-15, 0, 15, 45, HAZARD.safe)
  grid.box(-1.5, 20, 1.5, 21, HAZARD.rock)
  const planner = new LocalPlanner()
  const keeper = new GuideKeeper()
  const first = step(keeper, planner, grid, 0, 10)
  const side = first.path.some((p) => p.x > 0.5) ? -6 : 6 // walk away on the other side
  const g = step(keeper, planner, grid, side, 12)
  assert.ok(Math.hypot(g.path[0].x - side, g.path[0].y - 12) < 1e-9, 'starts at the astronaut')
  assert.notEqual(sig(g.path), sig(first.path))
})

test('past the hazard, the guide goes back to the planned line after clearTicks clear ticks, joining ahead', () => {
  const grid = new Cells()
  grid.box(-15, 0, 15, 60, HAZARD.safe)
  grid.box(-1.5, 20, 1.5, 21, HAZARD.rock)
  const planner = new LocalPlanner()
  const keeper = new GuideKeeper({ clearTicks: 3 })
  step(keeper, planner, grid, 0, 10)
  assert.equal(keeper.mode, 'detour')
  // the astronaut is past the rock, 2 m off the line: the line ahead is clear
  const modes: string[] = []
  let last = step(keeper, planner, grid, 2, 24)
  modes.push(keeper.mode)
  for (let i = 0; i < 4; i++) {
    last = step(keeper, planner, grid, 2, 24)
    modes.push(keeper.mode)
  }
  assert.equal(modes[modes.length - 1], 'route')
  // it joins the line a few metres ahead, not by turning sideways onto it
  assert.ok(Math.abs(last.path[1].x) < 1e-9 && last.path[1].y >= 26.9, `joins at y=${last.path[1].y}`)
})

test('blocked passes through unchanged and clears the kept detour', () => {
  const grid = new Cells()
  grid.box(-20, 18, 20, 19, HAZARD.rock) // a wall across the whole window
  const keeper = new GuideKeeper()
  const g = step(keeper, new LocalPlanner(), grid, 0, 10)
  assert.equal(g.blocked, true)
  assert.equal(keeper.mode, 'blocked')
  assert.deepEqual(g.path, [])
})
