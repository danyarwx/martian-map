import { useEffect, useRef } from 'react'
import type { HelmetSession, HudState } from '../session.ts'

interface Props {
  session: HelmetSession
  hud: HudState
}

const KIND_COLOUR: Record<string, string> = { rock: '#ff5a4e', sand: '#e8b04a', steep: '#ff8a3d', drop: '#b04aff' }

/** Disparity → colour: near warm, far cool, no match black. */
function ramp(d: number, maxD: number, out: Uint8ClampedArray, o: number): void {
  if (d !== d) {
    out[o] = out[o + 1] = out[o + 2] = 0
    out[o + 3] = 255
    return
  }
  const t = Math.min(1, Math.max(0, d / maxD)) // 0 far … 1 near
  // blue → cyan → yellow → red
  const r = Math.min(1, Math.max(0, 2 * t - 0.4))
  const g = 1 - Math.abs(2 * t - 1) * 0.9
  const b = Math.min(1, Math.max(0, 1.3 - 2.2 * t))
  out[o] = 255 * r
  out[o + 1] = 255 * g
  out[o + 2] = 255 * b
  out[o + 3] = 255
}

/**
 * CV view (key V, PLAN §7.2): what the helmet computes. Left: the left camera's image with the detections drawn
 * on it. Right: the disparity (depth) map from the stereo pair.
 */
export default function CvView({ session, hud }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { width: W, height: H } = session.rig.intr

  useEffect(() => {
    const canvas = ref.current
    const tick = session.lastCv
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !tick) return
    const S = 2 // draw at twice the camera resolution so the labels are readable
    ctx.imageSmoothingEnabled = false
    const img = new ImageData(W * 2, H)
    const left = session.rig.leftRgba
    const disp = tick.result.disparity
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 4
        const o = (y * W * 2 + x) * 4
        img.data[o] = left[s]
        img.data[o + 1] = left[s + 1]
        img.data[o + 2] = left[s + 2]
        img.data[o + 3] = 255
        ramp(disp[y * W + x], 40, img.data, o + W * 4)
      }
    }
    const small = document.createElement('canvas')
    small.width = W * 2
    small.height = H
    small.getContext('2d')!.putImageData(img, 0, 0)
    ctx.drawImage(small, 0, 0, W * 2 * S, H * S)
    ctx.font = '12px Menlo, Consolas, monospace'
    ctx.lineWidth = 2
    for (const d of tick.result.detections) {
      if (!d.bbox) continue
      const [bx, by, bw, bh] = d.bbox
      const c = KIND_COLOUR[d.kind] ?? '#ffffff'
      ctx.strokeStyle = c
      ctx.strokeRect(bx * S, by * S, Math.max(2, bw * S), Math.max(2, bh * S))
      const label = `${d.kind}${d.heightM ? ` ${d.heightM.toFixed(1)} m` : ''} · ${d.distanceM.toFixed(1)} m`
      const tw = ctx.measureText(label).width
      const ly = by * S > 16 ? by * S - 4 : (by + bh) * S + 13
      ctx.fillStyle = 'rgba(10, 18, 18, 0.75)'
      ctx.fillRect(bx * S - 1, ly - 11, tw + 6, 14)
      ctx.fillStyle = c
      ctx.fillText(label, bx * S + 2, ly)
    }
  }, [session, hud, W, H])

  const cv = hud.cv
  return (
    <div className="helmet-cv" role="img" aria-label="Computer vision view: camera image with detections, and the depth map">
      <div className="helmet-cv-titles">
        <span>Left camera + detections</span>
        <span>Stereo depth (near warm, far cool, no match black)</span>
      </div>
      <canvas ref={ref} width={W * 4} height={H * 2} />
      <p>
        {cv.ms.toFixed(0)} ms per frame · {cv.hz.toFixed(1)} Hz · {(cv.valid * 100).toFixed(0)} % of pixels with depth · {cv.detections} detection
        {cv.detections === 1 ? '' : 's'} · pose: suit nav (simulated) · pixels only, 2 cameras 0.30 m apart
      </p>
    </div>
  )
}
