// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LatLon, Terrain } from '../types.ts'
import { MARS_RADIUS_M } from './geo.ts'
import { type CameraModel, type Frame, framesFor, lineOfSight, placeLandmarks, projectCahvore, projectPoint } from './photoProjection.ts'

const RAD = Math.PI / 180
/** Degrees of latitude for a distance north, metres. */
const north = (m: number) => m / (MARS_RADIUS_M * RAD)

/** Ideal pinhole camera looking straight ahead (rover x), 1000 x 800 px, focal length 500 px, 1.9 m up. */
function pinhole(linearity = 1): CameraModel {
  const f = 500
  return {
    C: [0, 0, -1.9],
    A: [1, 0, 0],
    H: [500, f, 0], // hc * A + f * (right)
    V: [400, 0, f], // vc * A + f * (down)
    O: [1, 0, 0],
    R: [0, 0, 0],
    linearity,
  }
}

const rover = { lat: 18.45, lon: 77.4, elev: -2500 }
/** Rover facing north (identity attitude: rover x = north, y = east, z = down). */
function frame(model = pinhole(), attitude: Frame['attitude'] = [1, 0, 0, 0]): Frame {
  return { id: 'f', file: '', sol: 1, rover, attitude, headingDeg: 0, width: 1000, height: 800, model, source: '' }
}

const W = 200
const H = 200
/** 200 x 200 grid of 10 m cells centred on the rover, elevation from `elevAt` in metres above the rover's ground. */
function terrain(elevAt: (eastM: number, northM: number) => number = () => 0): Terrain {
  const dLat = north(10)
  const dLon = dLat / Math.cos(rover.lat * RAD)
  const elev = new Int16Array(W * H)
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) elev[r * W + c] = Math.round((rover.elev + elevAt((c - W / 2 + 0.5) * 10, (H / 2 - r - 0.5) * 10)) * 10)
  }
  return {
    source: 'test',
    west: rover.lon - (W / 2) * dLon, east: rover.lon + (W / 2) * dLon,
    south: rover.lat - (H / 2) * dLat, north: rover.lat + (H / 2) * dLat,
    width: W, height: H, cellMetersX: 10, cellMetersY: 10,
    slope: new Uint8Array(W * H), elev,
  }
}

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`)

test('a point straight ahead at camera height lands in the middle of the picture', () => {
  const p = projectPoint(frame(), { lat: rover.lat + north(100), lon: rover.lon }, rover.elev + 1.9)
  assert.ok(p)
  near(p.x, 0.5, 0.001)
  near(p.y, 0.5, 0.002) // curvature lowers a point 100 m away by under a millimetre
  near(p.distanceM, 100, 0.01)
})

test('east is right and lower ground is lower in the picture', () => {
  const pt: LatLon = { lat: rover.lat + north(100), lon: rover.lon + north(20) / Math.cos(rover.lat * RAD) }
  const p = projectPoint(frame(), pt, rover.elev - 8.1)
  assert.ok(p)
  near(p.x, 0.5 + (500 * 20) / 100 / 1000, 0.002) // 20 m right at 100 m = 100 px
  near(p.y, 0.5 + (500 * 10) / 100 / 800, 0.002) // 10 m below the camera = 50 px
})

test('the attitude turns the view: a rover facing east sees north on its left', () => {
  const half = Math.SQRT1_2
  const facingEast: Frame['attitude'] = [half, 0, 0, half] // 90 deg about down
  const p = projectPoint(frame(pinhole(), facingEast), { lat: rover.lat + north(100), lon: rover.lon + north(100) / Math.cos(rover.lat * RAD) }, rover.elev + 1.9)
  assert.ok(p)
  near(p.x, 0.5 - 500 / 1000, 0.002) // 45 deg left
})

test('nothing behind the camera is projected', () => {
  assert.equal(projectPoint(frame(), { lat: rover.lat - north(50), lon: rover.lon }, rover.elev), null)
})

test('a fisheye agrees with a pinhole on the axis and pulls the edges in', () => {
  const ahead = projectCahvore(pinhole(0), [100, 0, -1.9])
  assert.deepEqual(ahead && [Math.round(ahead.x), Math.round(ahead.y)], [500, 400])
  const wide = projectCahvore(pinhole(0), [100, 100, -1.9]) // 45 deg right
  assert.ok(wide && wide.x < 1000 && wide.x > 800, `${wide?.x}`) // fisheye: f * theta = 393 px, pinhole: 500 px
})

test('line of sight is cut by a ridge between the two points, not by one beside them', () => {
  const t = terrain((_e, n) => (n > 290 && n < 310 ? 15 : 0)) // 15 m ridge 300 m north
  const behind = { lat: rover.lat + north(500), lon: rover.lon, elev: rover.elev }
  const before = { lat: rover.lat + north(200), lon: rover.lon, elev: rover.elev }
  const here = { ...rover }
  assert.equal(lineOfSight(t, here, behind, 1.9, 1), false)
  assert.equal(lineOfSight(t, here, before, 1.9, 1), true)
})

test('framesFor prefers a photo taken at the stop, then one looking at it', () => {
  const t = terrain()
  const stop = { lat: rover.lat + north(300), lon: rover.lon }
  const looking = frame()
  const atStop: Frame = { ...frame(), id: 'at', rover: { ...rover, lat: stop.lat } }
  const away: Frame = { ...frame(pinhole(), [0, 0, 0, 1]), id: 'away' } // facing south
  const choices = framesFor([away, looking, atStop], t, stop)
  assert.deepEqual(choices.map((c) => [c.frame.id, c.mode]), [['at', 'here'], ['f', 'toward']])
  assert.equal(choices[1].mark?.visible, true)
})

test('placeLandmarks marks hidden places and skips those out of the picture', () => {
  const t = terrain((_e, n) => (n > 290 && n < 310 ? 15 : 0))
  const placed = placeLandmarks(frame(), t, [
    { id: 'near', name: 'Near', lat: rover.lat + north(200), lon: rover.lon },
    { id: 'far', name: 'Far', lat: rover.lat + north(600), lon: rover.lon },
    { id: 'south', name: 'South', lat: rover.lat - north(200), lon: rover.lon },
  ])
  assert.deepEqual(placed.map((p) => [p.id, p.visible]), [['near', true], ['far', false]])
})

test('a real Navcam model (sol 641) projects as JPL CAHVORE does in scripts/build_real_stereo.py', () => {
  // NLMV0641_0723855471_199ECM_N0310466TRAV00231_00_2LLJ, 1280 x 960. Expected pixels from the Python model.
  const model: CameraModel = {
    C: [0.946511, 0.346507, -1.89696],
    A: [0.835275, 0.0104544, 0.549747],
    H: [533.86, 746.355, 353.983],
    V: [-1.16361, 2.75856, 884.47],
    O: [0.835203, 0.0118703, 0.549828],
    R: [1.736e-6, 0.0501396, -0.0171254],
    linearity: 0,
  }
  const cases: [[number, number, number], number, number][] = [
    [[20, 5, 0], 825.741, 130.485],
    [[8, -6, 1.5], 125.172, 402.293],
    [[3, 2, 0.2], 1028.492, 629.688],
  ]
  for (const [point, x, y] of cases) {
    const px = projectCahvore(model, point)
    assert.ok(px)
    near(px.x, x, 0.01)
    near(px.y, y, 0.01)
  }
})
