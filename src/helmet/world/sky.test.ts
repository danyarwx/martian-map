// Run with `npm test`. Sun position model and the shadow-box snapping of sky.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { dirToHeading } from '../frames.ts'
import { DEFAULT_LST_HOURS, JEZERO_LAT_DEG, snapToTexels, sunDirection, sunElevationDeg } from './sky.ts'

const LAT = JEZERO_LAT_DEG

test('the sun direction is a unit vector at every hour', () => {
  for (let h = 0; h <= 24; h += 0.5) {
    const d = sunDirection(h, LAT)
    assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-12, `hour ${h}`)
  }
})

test('noon at Jezero (equinox assumed): high in the south, 90° − latitude up', () => {
  const d = sunDirection(12, LAT)
  assert.ok(Math.abs(d.x) < 1e-12, 'on the meridian')
  assert.ok(d.y < 0, 'south of the zenith')
  assert.ok(Math.abs(sunElevationDeg(d) - (90 - LAT)) < 1e-9)
})

test('06:00 is low in the east, 18:00 low in the west', () => {
  const rise = sunDirection(6, LAT)
  assert.ok(Math.abs(sunElevationDeg(rise)) < 1e-9, 'on the horizon at an equinox')
  assert.ok(Math.abs(dirToHeading(rise.x, rise.y) - 90) < 1e-6, 'due east')
  const morning = sunDirection(6.5, LAT)
  assert.ok(sunElevationDeg(morning) > 0 && sunElevationDeg(morning) < 10 && morning.x > 0.9)

  const set = sunDirection(18, LAT)
  assert.ok(Math.abs(sunElevationDeg(set)) < 1e-9)
  assert.ok(Math.abs(dirToHeading(set.x, set.y) - 270) < 1e-6, 'due west')
  const evening = sunDirection(17.5, LAT)
  assert.ok(sunElevationDeg(evening) > 0 && sunElevationDeg(evening) < 10 && evening.x < -0.9)
})

test('morning and afternoon mirror each other; midnight is below the horizon', () => {
  const a = sunDirection(9, LAT)
  const b = sunDirection(15, LAT)
  assert.ok(Math.abs(a.x + b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && Math.abs(a.z - b.z) < 1e-12)
  assert.ok(sunDirection(0, LAT).z < 0)
})

test('default 10:30: about 61° up in the south-east', () => {
  const d = sunDirection(DEFAULT_LST_HOURS, LAT)
  assert.ok(Math.abs(sunElevationDeg(d) - 61.2) < 0.2, `elevation ${sunElevationDeg(d)}`)
  const az = dirToHeading(d.x, d.y)
  assert.ok(az > 120 && az < 135, `azimuth ${az}`)
})

test('declination moves the noon sun: at the northern summer solstice it is north of the zenith here', () => {
  const d = sunDirection(12, LAT, 25.19)
  assert.ok(d.y > 0)
  assert.ok(Math.abs(sunElevationDeg(d) - (90 - (25.19 - LAT))) < 1e-9)
})

test('the shadow box centre snaps to whole texels across the light and keeps its depth along it', () => {
  const s = sunDirection(DEFAULT_LST_HOURS, LAT)
  const dir = new THREE.Vector3(s.x, s.z, -s.y)
  const m = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0))
  const right = new THREE.Vector3().setFromMatrixColumn(m, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(m, 1)
  const texel = 120 / 2048
  for (const p of [new THREE.Vector3(12.345, -2561.2, 801.77), new THREE.Vector3(-0.01, 3, 0.02)]) {
    const c = snapToTexels(p, right, up, texel)
    for (const axis of [right, up]) {
      const k = c.dot(axis) / texel
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6, 'on the texel grid')
      assert.ok(Math.abs(c.dot(axis) - p.dot(axis)) <= texel / 2 + 1e-9, 'moved by at most half a texel')
    }
    assert.ok(Math.abs(c.dot(dir) - p.dot(dir)) < 1e-9)
  }
})
