// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaDoseMsv, SURFACE_DOSE_MSV_PER_DAY } from '../../lib/safety.ts'
import { doseSoFarMsv, EVA_LIMIT_MIN, evaTimeLeftMin, O2_CAPACITY_MIN, O2_RESERVE_MIN, o2Percent, suitState } from './suit.ts'

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`)

test('oxygen starts full, falls linearly and never leaves 0..100', () => {
  near(o2Percent(0), 100)
  near(o2Percent(O2_CAPACITY_MIN / 2), 50)
  near(o2Percent(O2_CAPACITY_MIN), 0)
  near(o2Percent(O2_CAPACITY_MIN + 100), 0)
  near(o2Percent(-10), 100)
  assert.ok(o2Percent(120, 1.5) < o2Percent(120)) // heavy work uses more
})

test('EVA time left: the 8 h limit at the planning workload', () => {
  assert.equal(EVA_LIMIT_MIN, 480)
  near(evaTimeLeftMin(0), 480)
  near(evaTimeLeftMin(300), 180)
  near(evaTimeLeftMin(480), 0)
  near(evaTimeLeftMin(600), 0)
})

test('EVA time left: oxygen above the reserve limits it under heavy work', () => {
  // workload 1.5: the tank lasts O2_CAPACITY_MIN / 1.5 = 340 min, minus the 30 min reserve
  near(evaTimeLeftMin(0, 1.5), O2_CAPACITY_MIN / 1.5 - O2_RESERVE_MIN, 1e-9)
  near(evaTimeLeftMin(100, 1.5), O2_CAPACITY_MIN / 1.5 - O2_RESERVE_MIN - 100, 1e-9)
})

test('dose comes from the measured surface rate', () => {
  near(doseSoFarMsv(0), 0)
  near(doseSoFarMsv(24 * 60), SURFACE_DOSE_MSV_PER_DAY)
  near(doseSoFarMsv(90), evaDoseMsv(1.5))
  const s = suitState(240)
  near(s.o2Pct, o2Percent(240))
  near(s.evaLeftMin, 240)
  near(s.doseMsv, evaDoseMsv(4))
})
