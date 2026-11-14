import { useEffect, useRef } from 'react'
import type { HelmetSession, HudState } from '../session.ts'
import { drawCv } from './drawCv.ts'

interface Props {
  session: HelmetSession
  hud: HudState
}

/**
 * CV view (key V, PLAN §7.2): what the helmet computes. Left: the left camera's image with the detections drawn
 * on it. Right: the disparity (depth) map from the stereo pair.
 */
export default function CvView({ session, hud }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { width: W, height: H } = session.rig.intr

  useEffect(() => {
    const tick = session.lastCv
    if (!ref.current || !tick) return
    drawCv(ref.current, { width: W, height: H, rgba: session.rig.leftRgba, disparity: tick.result.disparity, detections: tick.result.detections, maxDisparity: 40 }, 2)
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
