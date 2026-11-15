// #helmet-eval: runs the CV eval harness (run.ts) and shows what it measured. Dev tool, not part of the demo.
// The result is also on window.__helmetEval = { done, metrics, perPose } and logged as one JSON line
// ("HELMET_EVAL {...}") for scripts/eval_helmet.cjs.
import { useEffect, useRef, useState } from 'react'
import { predict, prf, trainLogistic } from './logistic.ts'
import { runEval, TARGETS, type EvalMetrics, type PoseRecord, type PoseView } from './run.ts'

const pct = (v: number, digits = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)} %` : 'none')
const num = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : 'none')

function drawView(canvas: HTMLCanvasElement, v: PoseView): void {
  const S = 3
  canvas.width = v.width * S
  canvas.height = v.height * S
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const small = document.createElement('canvas')
  small.width = v.width
  small.height = v.height
  small.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(v.rgba), v.width, v.height), 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height)
  // sand patches: filled = the classifier says sand, outlined = the world says sand
  for (const p of v.patches) {
    const pr = Math.floor(p.index / v.patchCols)
    const x = (p.index - pr * v.patchCols) * v.patchPx * S
    const y = pr * v.patchPx * S
    const side = v.patchPx * S
    if (p.prob > 0.6) {
      ctx.fillStyle = 'rgba(232,176,74,0.35)'
      ctx.fillRect(x, y, side, side)
    }
    if (p.sand) {
      ctx.strokeStyle = '#3aa0ff'
      ctx.lineWidth = 1
      ctx.strokeRect(x + 1.5, y + 1.5, side - 3, side - 3)
    }
  }
  ctx.lineWidth = 2
  for (const d of v.detections) {
    if (d.kind !== 'rock' || !d.bbox) continue
    ctx.strokeStyle = '#ff5a4e'
    ctx.strokeRect(d.bbox[0] * S, d.bbox[1] * S, d.bbox[2] * S, d.bbox[3] * S)
  }
  for (const r of v.rocks) {
    ctx.strokeStyle = r.found ? '#58e07a' : '#ffe14a'
    ctx.beginPath()
    ctx.arc(r.u * S, r.v * S, 7, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function Row({ name, value, target, pass, basis }: { name: string; value: string; target: string; pass: boolean | null; basis: string }) {
  return (
    <tr>
      <td>{name}</td>
      <td style={{ textAlign: 'right', fontWeight: 700 }}>{value}</td>
      <td>{target}</td>
      <td style={{ color: pass === null ? '#888' : pass ? '#1a7f37' : '#b3261e', fontWeight: 700 }}>{pass === null ? 'no target' : pass ? 'met' : 'missed'}</td>
      <td>{basis}</td>
    </tr>
  )
}

function Metrics({ m }: { m: EvalMetrics }) {
  const s = m.sand
  return (
    <table className="eval-table">
      <thead>
        <tr>
          <th>Measure</th>
          <th>Value</th>
          <th>Target</th>
          <th></th>
          <th>Based on</th>
        </tr>
      </thead>
      <tbody>
        <Row name="Rock recall" value={pct(m.rocks.recall)} target="≥ 80 %" pass={m.rocks.recall >= TARGETS.rockRecall} basis={`${m.rocks.found} of ${m.rocks.truth} rocks standing ≥ 0.30 m, 2–12 m away, in view`} />
        <Row name="Rock precision" value={pct(m.rocks.precision)} target="≥ 70 %" pass={m.rocks.precision >= TARGETS.rockPrecision} basis={`${m.rocks.detectionsTrue} of ${m.rocks.detections} rock detections 2–12 m away (${m.rocks.falseOnLowRock} of the false ones sit on a 0.20–0.30 m rock)`} />
        <Row
          name="Rocks in the way found in time (walk)"
          value={pct(m.walk.hazard.recall)}
          target=""
          pass={null}
          basis={`${m.walk.hazard.found} of ${m.walk.hazard.truth} rocks ≥ 0.30 m within ${m.walk.corridorM} m of the walk at the 7 boulder fields, found at least once while ${m.walk.inTimeM} m or more away (frames every ${m.walk.stepM} m from ${m.walk.fromM} m to ${m.walk.toM} m); by height ${m.walk.hazard.byHeight.map((b) => `${b.from}–${b.to} m ${pct(b.recall)}`).join(', ')}; first found at ${m.walk.hazard.medianFirstM.toFixed(1)} m (median). Small rocks: ${pct(m.walk.small.recall)} (${m.walk.small.found} of ${m.walk.small.truth})`}
        />
        <Row name="Small rocks found (0.10–0.30 m)" value={pct(m.rocks.small.recall)} target="" pass={null} basis={`${m.rocks.small.found} of ${m.rocks.small.truth} within 8 m, in view; ${m.rocks.small.detectionsTrue} of ${m.rocks.small.detections} small-rock detections sit on a rock (${pct(m.rocks.small.precision)}); CV image ${m.cv.width} × ${m.cv.height}, ${m.cv.maxDisp} disparities`} />
        <Row name="Rocks marked on the hazard map" value={pct(m.rocks.onMap.recall)} target="" pass={null} basis={`${m.rocks.onMap.found} of ${m.rocks.truth} rocks with a rock cell on or beside them (neighbours reported as one wide detection count here)`} />
        <Row name="Rock cells at a rock" value={pct(m.rocks.onMap.precision)} target="" pass={null} basis={`${m.rocks.onMap.cellsTrue} of ${m.rocks.onMap.cells} rock cells 2–12 m away`} />
        <Row name="Depth error at 5 m, median" value={pct(m.depth.medianRel, 2)} target="≤ 5 %" pass={m.depth.medianRel <= TARGETS.depthRelAt5m} basis={`${m.depth.n} ground pixels 4–6 m away`} />
        <Row name="Depth error at 5 m, mean" value={pct(m.depth.meanRel, 2)} target="≤ 5 %" pass={m.depth.meanRel <= TARGETS.depthRelAt5m} basis={`bias ${pct(m.depth.biasRel, 2)}; all pixels incl. rocks: ${pct(m.depth.allPixels.meanRel, 2)} over ${m.depth.allPixels.n}`} />
        <Row name="Slope RMS error" value={`${num(m.slope.rmsDeg)}°`} target="≤ 3°" pass={m.slope.rmsDeg <= TARGETS.slopeRmsDeg} basis={`${m.slope.blocks} 1 m blocks; bias ${num(m.slope.biasDeg)}°; before the 3 × 3 median ${num(m.slope.rmsRawDeg)}° over ${m.slope.rawBlocks}`} />
        <Row name="Sand F1, held-out poses (shipped weights)" value={num(s.shipped.heldOut.f1)} target="≥ 0.70" pass={s.shipped.heldOut.f1 >= TARGETS.sandF1} basis={`precision ${num(s.shipped.heldOut.precision)}, recall ${num(s.shipped.heldOut.recall)}; ${s.shipped.heldOut.positives} sand of ${s.shipped.heldOut.n} patches`} />
        <Row name="Sand F1, held-out poses (trained in this run)" value={num(s.trained.heldOut.f1)} target="≥ 0.70" pass={s.trained.heldOut.f1 >= TARGETS.sandF1} basis={`precision ${num(s.trained.heldOut.precision)}, recall ${num(s.trained.heldOut.recall)}; train F1 ${num(s.trained.train.f1)} on ${s.trained.train.n} patches`} />
        <Row name="CV time per frame, mean" value={`${num(m.cvMs.mean, 1)} ms`} target="" pass={null} basis={`median ${num(m.cvMs.median, 1)} ms, max ${num(m.cvMs.max, 1)} ms (main thread here, the same code as the worker); ${pct(m.validShare, 0)} of pixels with a depth`} />
      </tbody>
    </table>
  )
}

export default function EvalView() {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const views = useRef<PoseView[]>([])
  const [progress, setProgress] = useState('Starting…')
  const [poses, setPoses] = useState<PoseRecord[]>([])
  const [metrics, setMetrics] = useState<EvalMetrics | null>(null)
  const [shown, setShown] = useState(-1)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const abort = new AbortController()
    const w = window as unknown as Record<string, unknown>
    w.__helmetEval = { done: false, metrics: null, perPose: [] }
    views.current = []
    setPoses([])
    setMetrics(null)
    runEval({
      host: el,
      signal: abort.signal,
      onProgress: (t) => !abort.signal.aborted && setProgress(t),
      onPose: (rec, view) => {
        if (abort.signal.aborted) return
        views.current.push(view)
        setPoses((p) => [...p, rec])
        setShown(views.current.length - 1)
      },
    })
      .then((res) => {
        if (abort.signal.aborted) return
        setMetrics(res.metrics)
        // sandData and the trainer stay reachable for experiments from the console
        w.__helmetEval = { done: res.done, metrics: res.metrics, perPose: res.perPose, sandData: res.sandData, views: views.current, tools: { trainLogistic, predict, prf } }
        console.log('HELMET_EVAL ' + JSON.stringify({ metrics: res.metrics, perPose: res.perPose }))
      })
      .catch((err) => {
        if (abort.signal.aborted) return
        console.error('helmet eval:', err)
        setProgress(`Failed: ${String(err?.message ?? err)}`)
        w.__helmetEval = { done: true, metrics: null, perPose: [], error: String(err?.message ?? err) }
      })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    const v = views.current[shown]
    if (v && canvas.current) drawView(canvas.current, v)
  }, [shown])

  return (
    <div ref={host} style={{ font: '15px/1.45 Verdana, Tahoma, Arial, sans-serif', color: '#1c1c1c', background: '#f6f3ee', minHeight: '100vh', padding: '20px 24px', boxSizing: 'border-box', overflow: 'auto', height: '100vh' }}>
      <style>{`.eval-table{border-collapse:collapse;margin:12px 0 20px}.eval-table th,.eval-table td{border-bottom:1px solid #d8d2c6;padding:4px 10px;text-align:left;vertical-align:top}.eval-table th{font-size:13px;color:#555}.eval-table tr.sel{background:#e9e2d4}.eval-table tbody tr{cursor:default}`}</style>
      <h1 style={{ font: '700 22px Georgia, serif', margin: '0 0 6px' }}>Helmet computer vision: evaluation</h1>
      <p style={{ margin: '0 0 4px' }}>
        60 fixed poses in the simulated helmet world. The CV gets the two camera images and the pose; the world's rocks, heights and sand mask are used only to score it.
      </p>
      <p id="eval-progress" style={{ margin: '0 0 10px', fontWeight: 700 }}>
        {progress}
      </p>
      {metrics && <Metrics m={metrics} />}
      {metrics && metrics.skipped.length > 0 && <p>Skipped: {metrics.skipped.join('; ')}</p>}
      {metrics && (
        <p style={{ fontSize: 13 }}>
          Sand weights trained in this run ({metrics.sand.features.join(', ')}, bias): <code>[{metrics.sand.trained.weights.map((v) => v.toPrecision(5)).join(', ')}]</code>
        </p>
      )}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <canvas ref={canvas} style={{ width: 512, height: 384, background: '#222', display: 'block' }} />
          <p style={{ fontSize: 13, maxWidth: 512, margin: '6px 0 0' }}>
            Left camera of pose {shown + 1}. Red boxes: rocks the CV found. Circles: world rocks standing ≥ 0.30 m (green found, yellow missed). Yellow tint: patches the classifier calls sand; blue outline: patches the world's mask calls sand.
          </p>
        </div>
        <table className="eval-table" style={{ fontSize: 13, margin: 0 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Pose</th>
              <th>Rocks found</th>
              <th>Detections true</th>
              <th>Depth err 5 m</th>
              <th>Slope RMS</th>
              <th>Sand patches</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            {poses.map((p, k) => (
              <tr key={p.id} className={k === shown ? 'sel' : ''} onClick={() => setShown(k)}>
                <td>{k + 1}</td>
                <td>
                  {p.id}
                  {p.fine ? '' : ' (coarse)'}
                </td>
                <td>
                  {p.foundRocks} / {p.truthRocks}
                </td>
                <td>
                  {p.detectionsTrue} / {p.detections}
                </td>
                <td>{pct(p.depthRel5m, 2)}</td>
                <td>{num(p.slopeRmsDeg)}°</td>
                <td>
                  {p.sandPatches} ({pct(p.sandTruthShare, 0)} sand)
                </td>
                <td>{p.ms.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
