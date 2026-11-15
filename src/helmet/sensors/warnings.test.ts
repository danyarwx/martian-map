// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WALK_BACK_RESERVE_MIN } from '../../lib/safety.ts'
import { COLD_C, evaluateWarnings, HAZARD_AHEAD_M, type WarningInput } from './warnings.ts'

/** A calm moment: nothing to warn about. */
const CALM: WarningInput = {
  nearestHazardM: null,
  nearestHazardKind: null,
  slopeUnderFootDeg: 3,
  walkBackMin: 20,
  daylightLeftMin: 300,
  doseMsv: 0.05,
  plannedDoseMsv: 0.1,
  airTempC: -40,
  weatherSol: 1133,
}

const ids = (input: Partial<WarningInput>) => evaluateWarnings({ ...CALM, ...input }).map((w) => w.id)
const one = (input: Partial<WarningInput>, id: string) => evaluateWarnings({ ...CALM, ...input }).find((w) => w.id === id)

test('calm input gives no warnings; unknown inputs are skipped', () => {
  assert.deepEqual(ids({}), [])
  const unknown = { nearestHazardM: null, slopeUnderFootDeg: null, walkBackMin: null, daylightLeftMin: null, doseMsv: null, plannedDoseMsv: null, airTempC: null }
  assert.deepEqual(ids(unknown), [])
})

test('hazard ahead: within 15 m only, danger when close or a drop-off', () => {
  assert.equal(HAZARD_AHEAD_M, 15)
  assert.equal(one({ nearestHazardM: 15.01, nearestHazardKind: 'rock' }, 'hazard-ahead'), undefined)
  const at = one({ nearestHazardM: 15, nearestHazardKind: 'rock' }, 'hazard-ahead')
  assert.equal(at?.severity, 'caution')
  assert.match(at!.text, /Rock ahead, 15 m/)
  assert.equal(one({ nearestHazardM: 9, nearestHazardKind: 'sand' }, 'hazard-ahead')?.text, 'Loose sand ahead, 9 m')
  assert.equal(one({ nearestHazardM: 4, nearestHazardKind: 'sand' }, 'hazard-ahead')?.severity, 'danger')
  assert.equal(one({ nearestHazardM: 12, nearestHazardKind: 'drop' }, 'hazard-ahead')?.severity, 'danger')
  assert.match(one({ nearestHazardM: 12, nearestHazardKind: 'rock' }, 'hazard-ahead')!.source, /hazard map/)
})

test('slope under foot: over 15° caution, over 20° danger', () => {
  assert.equal(one({ slopeUnderFootDeg: 15 }, 'slope'), undefined)
  assert.equal(one({ slopeUnderFootDeg: 14 }, 'slope'), undefined)
  assert.equal(one({ slopeUnderFootDeg: 15.5 }, 'slope')?.severity, 'caution')
  assert.equal(one({ slopeUnderFootDeg: 20 }, 'slope')?.severity, 'caution')
  assert.equal(one({ slopeUnderFootDeg: 21 }, 'slope')?.severity, 'danger')
  assert.match(one({ slopeUnderFootDeg: 21 }, 'slope')!.source, /HiRISE/)
})

test('walk-back: only beyond the 60 min reserve', () => {
  // daylight is kept ample so only the walk-back rule can fire
  const day = { daylightLeftMin: 600 }
  assert.equal(one({ ...day, walkBackMin: WALK_BACK_RESERVE_MIN }, 'walk-back'), undefined)
  assert.equal(one({ ...day, walkBackMin: 59 }, 'walk-back'), undefined)
  const over = one({ ...day, walkBackMin: 61 }, 'walk-back')
  assert.equal(over?.severity, 'danger')
  assert.match(over!.source, /safety\.ts/)
})

test('daylight: must cover the walk back plus 30 min', () => {
  assert.equal(one({ walkBackMin: 40, daylightLeftMin: 70 }, 'daylight'), undefined) // exactly 40 + 30
  assert.equal(one({ walkBackMin: 40, daylightLeftMin: 71 }, 'daylight'), undefined)
  assert.equal(one({ walkBackMin: 40, daylightLeftMin: 69 }, 'daylight')?.severity, 'caution')
  assert.equal(one({ walkBackMin: 40, daylightLeftMin: 39 }, 'daylight')?.severity, 'danger')
  assert.match(one({ walkBackMin: 40, daylightLeftMin: 69 }, 'daylight')!.source, /MEDA, sol 1133/)
})

test('dose: only over the planned EVA dose', () => {
  assert.equal(one({ doseMsv: 0.1, plannedDoseMsv: 0.1 }, 'dose'), undefined)
  assert.equal(one({ doseMsv: 0.09, plannedDoseMsv: 0.1 }, 'dose'), undefined)
  const over = one({ doseMsv: 0.11, plannedDoseMsv: 0.1 }, 'dose')
  assert.equal(over?.severity, 'caution')
  assert.match(over!.source, /RAD/)
})

test('cold: only below -70 °C', () => {
  assert.equal(COLD_C, -70)
  assert.equal(one({ airTempC: -70 }, 'cold'), undefined)
  assert.equal(one({ airTempC: -69 }, 'cold'), undefined)
  const cold = one({ airTempC: -71 }, 'cold')
  assert.equal(cold?.severity, 'caution')
  assert.match(cold!.source, /MEDA, sol 1133/)
})

test('warnings are sorted most severe first, rule order breaking ties', () => {
  const w = evaluateWarnings({
    ...CALM,
    nearestHazardM: 10, // caution
    nearestHazardKind: 'rock',
    slopeUnderFootDeg: 25, // danger
    walkBackMin: 75, // danger
    daylightLeftMin: 90, // caution (75 + 30 > 90 > 75)
    doseMsv: 0.2, // caution
    airTempC: -75, // caution
  })
  assert.deepEqual(w.map((x) => x.id), ['slope', 'walk-back', 'hazard-ahead', 'daylight', 'dose', 'cold'])
  assert.deepEqual(w.map((x) => x.severity), ['danger', 'danger', 'caution', 'caution', 'caution', 'caution'])
  for (const x of w) assert.ok(x.source.length > 0 && x.text.length > 0)
})
