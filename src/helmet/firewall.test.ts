// The CV must never see the simulated world's ground truth (docs/helmet/PLAN.md §0 rule 9).
// Code under src/helmet/cv/ may not import from world/, sim/ or eval/. Run with `npm test`.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HELMET = resolve(fileURLToPath(new URL('.', import.meta.url)))
const CV = join(HELMET, 'cv')
const FORBIDDEN = ['world', 'sim', 'eval'].map((d) => join(HELMET, d))

function sourceFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // cv/ does not exist yet
  }
  return entries.flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** Every module specifier in static imports, dynamic imports, `export … from`, and `new URL(…)` worker paths. */
export function importsOf(code: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"`]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"`]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) for (const m of code.matchAll(re)) out.push(m[1])
  return out
}

/** Forbidden imports in one file, as "file → specifier". */
export function violations(file: string, code: string): string[] {
  return importsOf(code)
    .filter((spec) => spec.startsWith('.'))
    .filter((spec) => {
      const target = resolve(join(file, '..'), spec)
      return FORBIDDEN.some((dir) => target === dir || target.startsWith(dir + sep))
    })
    .map((spec) => `${relative(HELMET, file)} → ${spec}`)
}

test('cv/ imports nothing from world/, sim/ or eval/', () => {
  const bad = sourceFiles(CV).flatMap((f) => violations(f, readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [], `The CV may only use pixels and the pose:\n${bad.join('\n')}`)
})

test('the check catches each kind of forbidden import', () => {
  const file = join(CV, 'stereo.ts')
  assert.equal(violations(file, `import { rocksNear } from '../world/rocks.ts'`).length, 1)
  assert.equal(violations(file, `import type { Rock } from "../world/rocks.ts"`).length, 1)
  assert.equal(violations(file, `export { player } from '../sim/player.ts'`).length, 1)
  assert.equal(violations(file, `const m = await import('../eval/truth.ts')`).length, 1)
  assert.equal(violations(file, `new Worker(new URL('../world/x.ts', import.meta.url))`).length, 1)
  assert.equal(violations(file, `import { HAZARD } from '../contracts.ts'`).length, 0)
  assert.equal(violations(file, `import { toLocal } from '../frames.ts'`).length, 0)
  assert.equal(violations(file, `import { census } from './census.ts'`).length, 0)
})
