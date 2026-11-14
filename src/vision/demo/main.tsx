// Test bench for the onboard vision analyzer. Standalone page (vision.html), not part of the
// planner: pick a rover frame or upload one, add simulated dust, read the report.

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  HAZE_AT,
  STORM_AT,
  addSimulatedDust,
  buildReport,
  classifyFrame,
  frameFromCanvas,
  loadModel,
  measureFrame,
  type VisionReport,
} from '../index'
import { SAMPLES, type Sample } from './samples'
import './demo.css'

type ModelState =
  | { status: 'loading'; percent: number }
  | { status: 'ready' }
  | { status: 'failed'; message: string }

const DISPLAY_WIDTH = 960

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Could not load ${url}`))
    img.src = url
  })
}

const HAZARD_NAME: Record<VisionReport['hazard'], string> = {
  none: 'Clear',
  dust_haze: 'Dust haze',
  dust_storm: 'Dust storm',
  dust_devil: 'Dust devil',
  boulder_field: 'Boulder field',
}

const LABEL_NAME: Record<string, string> = {
  storm: 'Dust storm',
  clear: 'Clear day',
  dust_devil: 'Dust devil (info only)',
  boulders: 'Boulders (info only)',
}

const pct = (v: number) => `${Math.round(v * 100)}%`

function roundedJson(report: VisionReport): string {
  return JSON.stringify(report, (_key, value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : value), 2)
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [model, setModel] = useState<ModelState>({ status: 'loading', percent: 0 })
  const [selected, setSelected] = useState<{ title: string; note: string; credit: string; url: string }>(SAMPLES[0])
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [dust, setDust] = useState(0)
  const [report, setReport] = useState<VisionReport | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, VisionReport>>({})
  const [error, setError] = useState<string | null>(null)
  const runId = useRef(0)

  // Image model: starts downloading as the page opens. Reports work without it in the meantime.
  useEffect(() => {
    const files = new Map<string, { loaded: number; total: number }>()
    loadModel(p => {
      files.set(p.file, { loaded: p.loaded, total: p.total })
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      setModel(m => (m.status === 'loading' ? { status: 'loading', percent: total ? loaded / total : 0 } : m))
    }).then(
      () => setModel({ status: 'ready' }),
      e => setModel({ status: 'failed', message: e instanceof Error ? e.message : String(e) }),
    )
  }, [])

  // Load the selected picture.
  useEffect(() => {
    let cancelled = false
    setError(null)
    loadImage(selected.url).then(
      img => !cancelled && setImage(img),
      e => !cancelled && setError(e.message),
    )
    return () => {
      cancelled = true
    }
  }, [selected])

  // Draw it (with simulated dust if asked) and analyze what is on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const width = Math.min(DISPLAY_WIDTH, image.naturalWidth)
    const height = Math.round((image.naturalHeight / image.naturalWidth) * width)
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.filter = dust > 0 ? `blur(${(dust * 3).toFixed(1)}px)` : 'none'
    ctx.drawImage(image, 0, 0, width, height)
    ctx.filter = 'none'
    if (dust > 0) {
      const dusty = addSimulatedDust(ctx.getImageData(0, 0, width, height), dust)
      ctx.putImageData(new ImageData(new Uint8ClampedArray(dusty.data), width, height), 0, 0)
    }

    const metrics = measureFrame(frameFromCanvas(canvas, width, height))
    setReport(buildReport(metrics))

    if (model.status !== 'ready') return
    const id = ++runId.current
    const timer = setTimeout(async () => {
      try {
        const labels = await classifyFrame(canvas.toDataURL('image/jpeg', 0.85))
        if (id === runId.current) setReport(buildReport(metrics, labels))
      } catch (e) {
        if (id === runId.current) setError(e instanceof Error ? e.message : String(e))
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [image, dust, model.status])

  // Verdict chips under the sample thumbnails: pixels first, then the model once it is ready.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const s of SAMPLES) {
        try {
          const img = await loadImage(s.url)
          const metrics = measureFrame(frameFromCanvas(img, img.naturalWidth, img.naturalHeight))
          const labels = model.status === 'ready' ? await classifyFrame(s.url) : []
          if (cancelled) return
          setThumbs(t => ({ ...t, [s.id]: buildReport(metrics, labels) }))
        } catch {
          // A sample that fails to load just keeps no chip.
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [model.status])

  const pick = useCallback((s: Sample) => {
    setDust(0)
    setSelected(s)
  }, [])

  const upload = useCallback((file: File | undefined) => {
    if (!file) return
    setDust(0)
    setSelected({ title: file.name, note: 'Your image. It stays in this browser.', credit: '', url: URL.createObjectURL(file) })
  }, [])

  const tone = report?.hazard === 'dust_storm' ? 'danger' : report?.hazard === 'dust_haze' ? 'warn' : 'ok'

  return (
    <div className="bench">
      <header className="bench-head">
        <div>
          <h1>Onboard vision</h1>
          <p>
            The helmet camera reads the air. It runs on the suit, with no link to Earth: pixel metrics give an answer
            at once, and a small image model confirms it.
          </p>
        </div>
        <div className={`model model-${model.status}`} role="status">
          {model.status === 'loading' && `Image model loading ${pct(model.percent)} · pixel metrics already active`}
          {model.status === 'ready' && 'Image model ready · running in this browser'}
          {model.status === 'failed' && `Image model unavailable, pixel metrics only (${model.message})`}
        </div>
      </header>

      <main className="bench-main">
        <section className="view">
          <div className="frame">
            <canvas ref={canvasRef} aria-label={selected.title} />
            {report && (
              <div className={`alert alert-${tone}`}>
                <strong>{report.text}</strong>
                <span>{report.recommendation}</span>
              </div>
            )}
            {dust > 0 && <div className="sim-tag">Simulated dust {pct(dust)} · not a real observation</div>}
          </div>
          <div className="caption">
            <strong>{selected.title}</strong> {selected.note} {selected.credit && <em>{selected.credit}</em>}
          </div>
          <div className="controls">
            <label className="slider">
              <span>Add simulated dust</span>
              <input type="range" min={0} max={100} step={1} value={Math.round(dust * 100)} onChange={e => setDust(Number(e.target.value) / 100)} />
              <output>{pct(dust)}</output>
            </label>
            <label className="upload">
              Upload a frame
              <input type="file" accept="image/*" onChange={e => upload(e.target.files?.[0])} />
            </label>
          </div>
          {error && <p className="error">{error}</p>}
        </section>

        <aside className="report">
          {report && (
            <>
              <div className={`verdict verdict-${tone}`}>
                <div className="verdict-name">{HAZARD_NAME[report.hazard]}</div>
                <div className="verdict-meta">
                  Confidence {pct(report.confidence)} · visibility {report.visibility} ·{' '}
                  {report.source === 'metrics' ? 'pixel metrics only' : 'pixel metrics + image model'}
                </div>
              </div>

              <h2>Visibility lost</h2>
              <div className="gauge" aria-label={`Visibility lost ${pct(report.visibilityLoss)}`}>
                <div className={`gauge-fill gauge-${tone}`} style={{ width: pct(report.visibilityLoss) }} />
                <i style={{ left: pct(HAZE_AT) }} title="Haze threshold" />
                <i style={{ left: pct(STORM_AT) }} title="Storm threshold" />
              </div>
              <div className="gauge-scale">
                <span>{pct(report.visibilityLoss)}</span>
                <span>haze from {pct(HAZE_AT)} · storm from {pct(STORM_AT)}</span>
              </div>

              <h2>Measured from the pixels</h2>
              <dl className="metrics">
                <dt>Contrast</dt>
                <dd>{report.metrics.contrast.toFixed(3)}</dd>
                <dt>Ground detail</dt>
                <dd>{report.metrics.groundDetail.toFixed(3)}</dd>
                <dt>Haze (dark channel)</dt>
                <dd>{report.metrics.haze.toFixed(3)}</dd>
              </dl>

              <h2>Image model</h2>
              {report.labels.length ? (
                <ul className="labels">
                  {report.labels.map(l => (
                    <li key={l.id}>
                      <span>{LABEL_NAME[l.id] ?? l.id}</span>
                      <div className="bar">
                        <div style={{ width: pct(l.score) }} />
                      </div>
                      <b>{pct(l.score)}</b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Not loaded yet. The verdict above uses the pixel metrics.</p>
              )}

              <h2>Report for the assistant</h2>
              <pre>{roundedJson(report)}</pre>
            </>
          )}
        </aside>
      </main>

      <section className="samples">
        <h2>Rover frames to try</h2>
        <div className="grid">
          {SAMPLES.map(s => {
            const r = thumbs[s.id]
            const t = r?.hazard === 'dust_storm' ? 'danger' : r?.hazard === 'dust_haze' ? 'warn' : 'ok'
            return (
              <button key={s.id} className={`thumb${selected.url === s.url ? ' is-on' : ''}`} onClick={() => pick(s)}>
                <img src={s.url} alt="" loading="lazy" />
                <span className="thumb-title">{s.title}</span>
                {r && <span className={`chip chip-${t}`}>{HAZARD_NAME[r.hazard]} · {pct(r.visibilityLoss)} lost</span>}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
