// Onboard vision inside the 3D helmet. Reads the helmet's own left camera (the image its computer vision
// already captures every tick), reports dust in the air, and owns the "Simulate dust storm" demo control.
// Renders a small visor panel; tells HelmetView when a storm is seen.

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildReport, classifyFrame, loadModel, measureFrame } from '../index'
import type { LabelScore, VisionReport } from '../types'
import { DustStorm } from './dustStorm'
import './helmet-vision.css'

/** The parts of a HelmetSession this needs. Kept narrow so the helmet code does not depend on src/vision. */
export interface VisionSession {
  rig: { leftRgba: Uint8ClampedArray }
  world: {
    scene: import('three').Scene
    atmosphere: { sun: import('three').DirectionalLight; skyLight: import('three').HemisphereLight; dome: import('three').Mesh }
  }
}

interface Props {
  session: VisionSession
  /** Size of `rig.leftRgba`, pixels. */
  width: number
  height: number
  /** Called once each time the verdict turns to a dust storm. */
  onStorm?: (report: VisionReport) => void
  /** Called when the simulated storm is switched off again. */
  onClear?: () => void
}

const ANALYZE_EVERY_MS = 700
const MODEL_EVERY_MS = 1500
const LABELS_FRESH_MS = 4000
/** Seconds for the simulated storm to build up or clear. */
const STORM_RAMP_S = 6
/** Readings in a row that must say "storm" before the helmet acts on it (about 1.4 s). */
const STORM_CONFIRM = 2

export default function HelmetVision({ session, width, height, onStorm, onClear }: Props) {
  const [report, setReport] = useState<VisionReport | null>(null)
  const [stormOn, setStormOn] = useState(false)
  const [dust, setDust] = useState(0)
  const storm = useRef<DustStorm | null>(null)
  const labels = useRef<{ scores: LabelScore[]; at: number } | null>(null)
  const cb = useRef({ onStorm, onClear })
  cb.current = { onStorm, onClear }
  /**
   * The image model (about 150 MB from the Hugging Face hub) is fetched only once the storm is first switched on:
   * fetched on helmet entry it competed with the terrain tiles on the venue Wi-Fi. Until then the pixels decide alone.
   */
  const model = useRef<'none' | 'loading' | 'ready'>('none')
  const requestModel = useCallback(() => {
    if (model.current !== 'none') return
    model.current = 'loading'
    loadModel().then(
      () => (model.current = 'ready'),
      () => {}, // no model: the pixels decide alone
    )
  }, [])

  // the simulated storm lives in the 3D world: haze, sky and sun
  useEffect(() => {
    const a = session.world.atmosphere
    const s = new DustStorm({ scene: session.world.scene, sun: a.sun, skyLight: a.skyLight, dome: a.dome })
    storm.current = s
    return () => {
      s.dispose()
      storm.current = null
    }
  }, [session])

  // ramp the dust up or down
  useEffect(() => {
    const timer = setInterval(() => {
      setDust((d) => {
        const target = stormOn ? 1 : 0
        const step = 0.1 / STORM_RAMP_S
        const next = Math.abs(target - d) <= step ? target : d + Math.sign(target - d) * step
        storm.current?.set(next)
        return next
      })
    }, 100)
    return () => clearInterval(timer)
  }, [stormOn])

  // read the camera
  useEffect(() => {
    let alive = true
    let modelBusy = false
    let modelAt = 0
    let wasStorm = false
    let stormRun = 0
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const timer = setInterval(() => {
      const rgba = new Uint8ClampedArray(session.rig.leftRgba)
      // the camera has not delivered a picture yet (the buffer is still all black)
      let lit = false
      for (let k = 0; k < rgba.length && !lit; k += 401) if (rgba[k] > 8) lit = true
      if (!lit) return
      const frame = { data: rgba, width, height }
      const now = performance.now()
      const fresh = labels.current && now - labels.current.at < LABELS_FRESH_MS ? labels.current.scores : []
      const r = buildReport(measureFrame(frame), fresh, 'helmet')
      if (!alive) return
      setReport(r)
      stormRun = r.hazard === 'dust_storm' ? stormRun + 1 : 0
      const isStorm = stormRun >= STORM_CONFIRM
      if (isStorm && !wasStorm) cb.current.onStorm?.(r)
      if (r.hazard === 'none') wasStorm = false
      else if (isStorm) wasStorm = true
      if (model.current === 'ready' && !modelBusy && now - modelAt >= MODEL_EVERY_MS) {
        modelBusy = true
        modelAt = now
        ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
        classifyFrame(canvas.toDataURL('image/jpeg', 0.85))
          .then((scores) => (labels.current = { scores, at: performance.now() }))
          .catch(() => {})
          .finally(() => (modelBusy = false))
      }
    }, ANALYZE_EVERY_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [session, width, height])

  const stormOnRef = useRef(stormOn)
  stormOnRef.current = stormOn
  const toggle = useCallback(() => {
    const on = stormOnRef.current
    if (on) cb.current.onClear?.()
    else requestModel()
    setStormOn(!on)
  }, [requestModel])

  // B for "blow": the same as the button, for presenting without the mouse
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return
      if (e.key.toLowerCase() === 'b') toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const tone = report?.hazard === 'dust_storm' ? 'danger' : report?.hazard === 'dust_haze' ? 'warn' : 'ok'
  return (
    <div className={`hv-panel hv-panel--${tone}`}>
      <div className="hv-head">
        <span>Onboard vision</span>
        <span>{report?.source === 'metrics+model' ? 'camera · pixels + model' : 'camera · pixels'}</span>
      </div>
      <div className="hv-text" role="status" aria-live="polite">
        {report ? report.text : 'Reading the camera…'}
      </div>
      {report && (
        <div className="hv-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(report.visibilityLoss * 100)}%` }} />
        </div>
      )}
      <button type="button" className="hv-btn" aria-pressed={stormOn} onClick={toggle}>
        {stormOn ? 'Clear the storm' : 'Simulate dust storm'} <kbd>B</kbd>
      </button>
      {dust > 0 && <div className="hv-sim">Simulated dust {Math.round(dust * 100)}% · not real data</div>}
    </div>
  )
}
