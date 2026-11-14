#!/usr/bin/env node
// Runs the helmet CV eval (docs/helmet/PLAN.md T4.4) in a headless browser and prints its JSON.
//
//   npm run dev                              (in another terminal; or `npm run build && npm run preview`)
//   node scripts/eval_helmet.cjs             (default http://localhost:5173)
//   node scripts/eval_helmet.cjs http://localhost:4173 --per-pose
//
// Playwright is NOT a dependency of this repo (PLAN §0 rule 6). To use this script, install it somewhere
// Node can find it, for example:  npm install --no-save playwright && npx playwright install chromium
// Without it, open <dev server>/#helmet-eval in a browser instead: the page shows the same numbers, keeps them
// in window.__helmetEval and logs them as one line starting with "HELMET_EVAL ".
let playwright
try {
  playwright = require('playwright')
} catch {
  console.error(
    [
      'eval_helmet: the "playwright" package is not installed (it is deliberately not a dependency).',
      '  Install it for this run:  npm install --no-save playwright && npx playwright install chromium',
      '  Or open  <dev server>/#helmet-eval  in a browser: the page shows the same metrics.',
    ].join('\n'),
  )
  process.exit(2)
}

const args = process.argv.slice(2)
const base = (args.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:5173').replace(/\/$/, '')
const perPose = args.includes('--per-pose')
const TIMEOUT_MS = 10 * 60 * 1000

async function main() {
  // WebGL in headless Chromium needs a software renderer on machines without a GPU.
  const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (err) => console.error('page error:', err.message))
    page.on('console', (msg) => {
      const text = msg.text()
      if (msg.type() === 'error' || (msg.type() === 'warning' && text.startsWith('helmet'))) console.error(`browser ${msg.type()}:`, text)
    })
    await page.goto(`${base}/#helmet-eval`, { waitUntil: 'load' })
    let last = ''
    const started = Date.now()
    for (;;) {
      const state = await page.evaluate(() => {
        const e = window.__helmetEval
        return { done: !!(e && e.done), error: e && e.error, progress: (document.getElementById('eval-progress') || {}).textContent || '' }
      })
      if (state.progress !== last) {
        last = state.progress
        console.error(last)
      }
      if (state.error) throw new Error(state.error)
      if (state.done) break
      if (Date.now() - started > TIMEOUT_MS) throw new Error(`no result after ${TIMEOUT_MS / 60000} minutes (last: ${last})`)
      await new Promise((r) => setTimeout(r, 500))
    }
    const result = await page.evaluate((withPoses) => {
      const e = window.__helmetEval
      return JSON.stringify(withPoses ? { metrics: e.metrics, perPose: e.perPose } : { metrics: e.metrics })
    }, perPose)
    console.log(result)
    const m = JSON.parse(result).metrics
    const pct = (v) => `${(v * 100).toFixed(1)} %`
    console.error(
      [
        `poses ${m.posesRun}/${m.poses}`,
        `rock recall ${pct(m.rocks.recall)} (${m.rocks.found}/${m.rocks.truth}), precision ${pct(m.rocks.precision)} (${m.rocks.detectionsTrue}/${m.rocks.detections}); on the hazard map ${pct(m.rocks.onMap.recall)}`,
        `depth error at 5 m: median ${pct(m.depth.medianRel)}, mean ${pct(m.depth.meanRel)}`,
        `slope RMS ${m.slope.rmsDeg.toFixed(2)}°`,
        `sand held-out F1 ${m.sand.shipped.heldOut.f1.toFixed(3)} (P ${m.sand.shipped.heldOut.precision.toFixed(3)}, R ${m.sand.shipped.heldOut.recall.toFixed(3)})`,
        `CV ${m.cvMs.mean.toFixed(1)} ms per frame`,
      ].join('\n'),
    )
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('eval_helmet failed:', err.message)
  process.exit(1)
})
