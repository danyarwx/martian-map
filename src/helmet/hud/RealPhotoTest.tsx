import { useEffect, useRef, useState } from 'react'
import type { CvResult, StereoIntrinsics } from '../contracts.ts'
import { CvClient } from '../cv/client.ts'
import { drawCv } from './drawCv.ts'

const BASE = '/data/helmet/real_stereo/'

interface Calib extends StereoIntrinsics {
  files: { left: string; right: string; rgbLeft?: string }
  pose: { headingDeg: number; pitchDeg: number; heightAboveRoverOriginM: number }
  source: { sol: number; place: string; credit: string }
}

async function pixels(url: string): Promise<ImageData> {
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, c.width, c.height)
}

function gray(d: ImageData): Uint8Array {
  const g = new Uint8Array(d.width * d.height)
  for (let k = 0; k < g.length; k++) g[k] = (d.data[k * 4] * 77 + d.data[k * 4 + 1] * 150 + d.data[k * 4 + 2] * 29) >> 8
  return g
}

/**
 * Real-photo test (key R, PLAN §7.4): the helmet's detector, unchanged, on a real Perseverance Navcam stereo pair.
 * It runs in its own CV worker (the same code), with a wider disparity search because the rover's cameras are
 * further apart and the picture is larger than the helmet's.
 */
export default function RealPhotoTest() {
  const ref = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<{ calib: Calib; result: CvResult; valid: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    const cv = new CvClient({ stereo: { maxDisp: 96 } })
    ;(async () => {
      const calib = (await (await fetch(BASE + 'calib.json')).json()) as Calib
      const [l, r, rgb] = await Promise.all([pixels(BASE + calib.files.left), pixels(BASE + calib.files.right), pixels(BASE + (calib.files.rgbLeft ?? calib.files.left))])
      if (dead) return
      const intr: StereoIntrinsics = { width: calib.width, height: calib.height, fx: calib.fx, fy: calib.fy, cx: calib.cx, cy: calib.cy, baselineM: calib.baselineM }
      const shown = new Uint8ClampedArray(rgb.data)
      cv.onError((msg) => setError(msg))
      cv.onResult((result) => {
        if (dead) return
        let valid = 0
        for (let k = 0; k < result.disparity.length; k++) if (result.disparity[k] === result.disparity[k]) valid++
        setState({ calib, result, valid: valid / result.disparity.length })
        if (ref.current) drawCv(ref.current, { width: intr.width, height: intr.height, rgba: shown, disparity: result.disparity, detections: result.detections, maxDisparity: 85 }, 1)
      })
      cv.send({
        id: 1,
        left: gray(l),
        right: gray(r),
        intr,
        // the camera's own heading and tilt, at its height above the ground; position is arbitrary
        pose: { x: 0, y: 0, z: calib.pose.heightAboveRoverOriginM, headingDeg: calib.pose.headingDeg, pitchDeg: calib.pose.pitchDeg },
      })
    })().catch((err) => !dead && setError(String(err?.message ?? err)))
    return () => {
      dead = true
      cv.terminate()
    }
  }, [])

  return (
    <div className="helmet-cv helmet-real" role="img" aria-label="The helmet's detector on a real Perseverance stereo photo">
      <div className="helmet-cv-titles">
        <span>Real photo: Perseverance Navcam (left) + detections</span>
        <span>Stereo depth from the real pair</span>
      </div>
      <canvas ref={ref} width={1024} height={384} />
      <p>
        {error
          ? `Could not run the test: ${error}`
          : state
            ? `Perseverance Navcam, sol ${state.calib.source.sol}, ${state.calib.source.place.split(',')[0]}. Same detector as the helmet: ${state.result.ms.toFixed(0)} ms, ${(state.valid * 100).toFixed(0)} % of pixels with depth, ${state.result.detections.length} detection${state.result.detections.length === 1 ? '' : 's'}. Image: ${state.calib.source.credit}. The rover's camera is rolled 12°, which the helmet's no-roll model reads as a cross slope.`
            : 'Running the detector on the real stereo pair…'}
      </p>
    </div>
  )
}
