// Runs the unit tests (src/lib and src/nav, *.test.ts) with `node --test`.
// Node 23.6 and later run TypeScript directly. Older Node gets the test files bundled to plain JS first,
// with the esbuild that Vite already brings along, so no extra dependency is needed.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs = ['src/lib', 'src/nav']
const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.test.ts')).map((f) => `${d}/${f}`))
const [major, minor] = process.versions.node.split('.').map(Number)
const runsTs = major > 23 || (major === 23 && minor >= 6)

let run = files
let out = null
if (!runsTs) {
  const { buildSync } = await import('esbuild')
  out = mkdtempSync(join(tmpdir(), 'martian-map-tests-'))
  buildSync({
    entryPoints: files,
    outdir: out,
    outbase: 'src',
    bundle: true,
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  })
  run = files.map((f) => join(out, f.replace(/^src\//, '').replace(/\.ts$/, '.mjs')))
}
const result = spawnSync(process.execPath, ['--test', ...run], { stdio: 'inherit' })
if (out) rmSync(out, { recursive: true, force: true })
process.exit(result.status ?? 1)
