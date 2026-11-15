// Onboard vision inside the helmet view. Drop it into the visor next to the panorama:
// it re-creates what the visor camera sees, analyzes it about once a second on the device,
// shows a small status panel, and tells the parent when the verdict changes.
//
// The helmet view draws its panorama as a CSS background, so there are no pixels to read from it.
// This component draws the same crop of the same panorama into a small hidden canvas instead.

import { useEffect, useRef, useState } from 'react'
import { ANALYSIS_WIDTH, addSimulatedDust, buildReport, classifyFrame, loadModel, measureFrame } from '../index'
import type { LabelScore, VisionReport } from '../types'
import './vision-hud.css'

/** Same shape as the helmet view's `Panorama` type: a 360° equirectangular image. */
export type PanoSource = { url: string; columns: number; rows: number; elZeroRow: number }

type Props = {
  /** Panorama the visor is showing. Undefined = no camera image, the panel says so. */
  pano: PanoSource | undefined
  headingDeg: number
  fovDeg: number
  /** Visor size in CSS pixels and the screen row of the horizon, as given to the panorama. */
  width: number
  height: number
  horizonY: number
  /** Azimuth of the panorama's left edge, degrees from north. */
  azOffsetDeg?: number
  /** SIMULATED dust, 0 to 1. Painted over the view and added to the analyzed frame. */
  simulatedDust?: number
  /** Called when the hazard verdict changes (and once with the first verdict). */
  onReport?: (report: VisionReport) => void
}

const ANALYZE_EVERY_MS = 700
/** The image model looks at the frame this often. The pixel metrics run on every tick. */
const MODEL_EVERY_MS = 1500
/** The model's last opinion is used for this long, then the pixels decide alone. */
const LABELS_FRESH_MS = 4000
/** Blur of the simulated dust at full strength, in visor pixels. */
const DUST_BLUR_PX = 4

const images = new Map<string, Promise<HTMLImageElement>>()
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Could not load ${url}`))
      img.src = url
    })
    images.set(url, p)
  }
  return p
}

const norm = (deg: number) => ((deg % 360) + 360) % 360

/** Draws the visor's crop of the panorama, the way the helmet view's CSS background shows it. */
function drawVisor(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  p: Required<Omit<Props, 'onReport' | 'simulatedDust' | 'pano'>> & { pano: PanoSource },
  blurPx: number,
) {
  const w = ANALYSIS_WIDTH
  const h = Math.max(1, Math.round((p.height / p.width) * w))
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  // Sky and ground the visor shows where the mosaic stops (same colours as .hud in hud.css).
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#a87c5a')
  bg.addColorStop(0.4, '#c99e78')
  bg.addColorStop(0.6, '#6e4630')
  bg.addColorStop(1, '#4a2c1d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // Panorama pixels per visor pixel, then per canvas pixel.
  const visorScale = p.width / ((p.fovDeg / 360) * p.pano.columns)
  const k = (w / p.width) * visorScale * (p.pano.columns / img.naturalWidth) // canvas px per image px
  const imgW = img.naturalWidth * k
  const imgH = img.naturalHeight * k
  const leftAz = norm(p.headingDeg - p.fovDeg / 2 - p.azOffsetDeg)
  const x = -(leftAz / 360) * imgW
  const y = (p.horizonY / p.height) * h - p.pano.elZeroRow * (img.naturalHeight / p.pano.rows) * k
  // Simulated dust also softens the scene, by the same amount as the blur painted over the visor.
  ctx.filter = blurPx > 0 ? `blur(${blurPx.toFixed(2)}px)` : 'none'
  ctx.drawImage(img, x, y, imgW, imgH)
  if (x + imgW < w) ctx.drawImage(img, x + imgW, y, imgW, imgH) // wrap past 360°
  ctx.filter = 'none'
  return ctx
}

export default function VisionHud({ pano, headingDeg, fovDeg, width, height, horizonY, azOffsetDeg = 0, simulatedDust = 0, onReport }: Props) {
  const [report, setReport] = useState<VisionReport | null>(null)
  const [modelReady, setModelReady] = useState(false)
  const [cameraOk, setCameraOk] = useState(true)
  const canvas = useRef<HTMLCanvasElement | null>(null)

  // Latest props for the timer, so it does not restart on every animation frame.
  const live = useRef({ pano, headingDeg, fovDeg, width, height, horizonY, azOffsetDeg, simulatedDust, onReport })
  live.current = { pano, headingDeg, fovDeg, width, height, horizonY, azOffsetDeg, simulatedDust, onReport }
  const lastHazard = useRef<string | null>(null)
  const labels = useRef<{ scores: LabelScore[]; at: number } | null>(null)

  useEffect(() => {
    let alive = true
    loadModel().then(
      () => alive && setModelReady(true),
      () => {}, // no model: the pixel metrics keep working
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    let busy = false
    let modelBusy = false
    let lastModelRun = 0
    const publish = (r: VisionReport) => {
      if (!alive) return
      setReport(r)
      if (r.hazard !== lastHazard.current) {
        lastHazard.current = r.hazard
        live.current.onReport?.(r)
      }
    }
    const tick = async () => {
      const p = live.current
      if (busy || !p.pano || p.width === 0) return
      busy = true
      try {
        const img = await loadImage(p.pano.url)
        if (!alive) return
        setCameraOk(true)
        canvas.current ??= document.createElement('canvas')
        const blurPx = p.simulatedDust * DUST_BLUR_PX * (ANALYSIS_WIDTH / p.width)
        const ctx = drawVisor(canvas.current, img, { ...p, pano: p.pano }, blurPx)
        const c = canvas.current
        let frame = ctx.getImageData(0, 0, c.width, c.height) as { data: Uint8ClampedArray; width: number; height: number }
        if (p.simulatedDust > 0) {
          frame = addSimulatedDust(frame, p.simulatedDust) as typeof frame
          ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), c.width, c.height), 0, 0)
        }
        // Pixels answer at once. The model is slower, so it runs on the side and its latest
        // opinion is mixed in for as long as it is fresh.
        const metrics = measureFrame(frame)
        const fresh = labels.current && performance.now() - labels.current.at < LABELS_FRESH_MS ? labels.current.scores : []
        publish(buildReport(metrics, fresh))
        if (modelReady && !modelBusy && performance.now() - lastModelRun >= MODEL_EVERY_MS) {
          modelBusy = true
          lastModelRun = performance.now()
          classifyFrame(c.toDataURL('image/jpeg', 0.85))
            .then(scores => {
              labels.current = { scores, at: performance.now() }
            })
            .catch(() => {})
            .finally(() => {
              modelBusy = false
            })
        }
      } catch {
        if (alive) setCameraOk(false)
      } finally {
        busy = false
      }
    }
    tick()
    const timer = setInterval(tick, ANALYZE_EVERY_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [modelReady])

  const tone = report?.hazard === 'dust_storm' ? 'danger' : report?.hazard === 'dust_haze' ? 'warn' : 'ok'
  const dust = Math.min(1, Math.max(0, simulatedDust))

  return (
    <>
      {dust > 0 && (
        <div
          className="vision-dust"
          aria-hidden="true"
          style={{
            // Same haze model as simulate.ts: thicker towards the top of the frame.
            background: `linear-gradient(to bottom, rgba(205,160,112,${dust}), rgba(205,160,112,${dust * 0.7}))`,
            backdropFilter: `blur(${(dust * DUST_BLUR_PX).toFixed(1)}px)`,
          }}
        />
      )}
      <div className={`vision-panel vision-panel--${tone}`} role="status" aria-label="Onboard vision">
        <div className="vision-head">
          <span>Onboard vision</span>
          <span>{report?.source === 'metrics+model' ? 'on suit · pixels + model' : 'on suit · pixels'}</span>
        </div>
        <div className="vision-text">
          {!pano || !cameraOk ? 'No camera image.' : report ? report.text : 'Reading the camera…'}
        </div>
        {report && pano && cameraOk && (
          <div className="vision-bar" aria-hidden="true">
            <i style={{ width: `${Math.round(report.visibilityLoss * 100)}%` }} />
          </div>
        )}
        {dust > 0 && <div className="vision-sim">Simulated dust {Math.round(dust * 100)}%</div>}
      </div>
    </>
  )
}
