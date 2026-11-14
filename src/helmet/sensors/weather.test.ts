// Run with `npm test`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DAY, temperatureC } from '../../lib/schedule.ts'
import { airTempAt, clockToMin, daylightLeftMin, type WeatherCache } from './weather.ts'

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`)

test('clockToMin reads hh:mm and hh:mm:ss', () => {
  near(clockToMin('06:18'), 378)
  near(clockToMin('17:13:51'), 17 * 60 + 13 + 51 / 60)
  near(clockToMin(600), 600)
  assert.ok(Number.isNaN(clockToMin('late')))
})

test('daylight left: before sunrise, during the day, at and after sunset', () => {
  const rise = '06:00:00'
  const set = '18:00:00'
  assert.equal(daylightLeftMin('05:00', rise, set), 12 * 60) // the whole coming day
  assert.equal(daylightLeftMin('06:00', rise, set), 12 * 60)
  assert.equal(daylightLeftMin('10:30', rise, set), 7.5 * 60)
  assert.equal(daylightLeftMin(17 * 60 + 59, rise, set), 1)
  assert.equal(daylightLeftMin('18:00', rise, set), 0)
  assert.equal(daylightLeftMin('19:00', rise, set), 0)
})

test('air temperature mirrors the schedule model when given its extremes', () => {
  for (let minute = 0; minute < 24 * 60; minute += 17) {
    near(airTempAt(minute / 60, DAY.coldestC, DAY.warmestC), temperatureC(minute), 1e-9)
  }
})

test('air temperature hits the measured extremes at the coldest and warmest hours', () => {
  near(airTempAt(DAY.coldestAt / 60, -79.3, -24.7), -79.3)
  near(airTempAt(DAY.warmestAt / 60, -79.3, -24.7), -24.7)
  near(airTempAt(DAY.warmestAt / 60 + 24, -79.3, -24.7), -24.7) // wraps around the sol
  const t = airTempAt(10.5, -79.3, -24.7)
  assert.ok(t > -79.3 && t < -24.7)
  assert.ok(airTempAt(10, -80, -20) < airTempAt(12, -80, -20)) // warming in the morning
  assert.ok(airTempAt(20, -80, -20) > airTempAt(23, -80, -20)) // cooling at night
})

test('the cached weather file has usable sols and its latest is the newest one', () => {
  const w = JSON.parse(readFileSync(new URL('../../../public/data/helmet/weather.json', import.meta.url), 'utf8')) as WeatherCache
  assert.ok(w.sols.length > 0)
  for (const s of w.sols) {
    assert.ok(Number.isFinite(s.min_temp) && Number.isFinite(s.max_temp) && Number.isFinite(s.pressure), `sol ${s.sol}`)
    assert.ok(s.min_temp < s.max_temp, `sol ${s.sol}`)
    assert.ok(s.pressure > 300 && s.pressure < 1500, `sol ${s.sol} pressure ${s.pressure} Pa`)
    assert.ok(clockToMin(s.sunrise) < clockToMin(s.sunset), `sol ${s.sol}`)
  }
  assert.equal(w.latest.sol, Math.max(...w.sols.map((s) => s.sol)))
})
