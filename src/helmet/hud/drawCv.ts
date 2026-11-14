// Draws one CV result onto a canvas: the left image with labelled detection boxes, and the disparity map beside it.
// Shared by the live CV view (V) and the real-photo test (R), so both show exactly the same thing.
import type { Detection } from '../contracts.ts'

export const KIND_COLOUR: Record<Detection['kind'], string> = { rock: '#ff5a4e', sand: '#e8b04a', steep: '#ff8a3d', drop: '#b04aff' }

/** Disparity → colour: near warm, far cool, no match black. */
function ramp(d: number, maxD: number, out: Uint8ClampedArray, o: number): void {
  out[o + 3] = 255
  if (d !== d) {
    out[o] = out[o + 1] = out[o + 2] = 0
    return
  }
  const t = Math.min(1, Math.max(0, d / maxD)) // 0 far … 1 near
  out[o] = 255 * Math.min(1, Math.max(0, 2 * t - 0.4))
  out[o + 1] = 255 * (1 - Math.abs(2 * t - 1) * 0.9)
  out[o + 2] = 255 * Math.min(1, Math.max(0, 1.3 - 2.2 * t))
}

export interface CvPicture {
  width: number
  height: number
  /** Left image, RGBA, row 0 at the top. */
  rgba: ArrayLike<number>
  disparity: Float32Array
  detections: readonly Detection[]
  /** Disparity shown as "nearest", pixels. */
  maxDisparity: number
}

/** The canvas must be `2 · width · scale` by `height · scale` pixels. */
export function drawCv(canvas: HTMLCanvasElement, pic: CvPicture, scale: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: W, height: H } = pic
  const img = new ImageData(W * 2, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4
      const o = (y * W * 2 + x) * 4
      img.data[o] = pic.rgba[s]
      img.data[o + 1] = pic.rgba[s + 1]
      img.data[o + 2] = pic.rgba[s + 2]
      img.data[o + 3] = 255
      ramp(pic.disparity[y * W + x], pic.maxDisparity, img.data, o + W * 4)
    }
  }
  const small = document.createElement('canvas')
  small.width = W * 2
  small.height = H
  small.getContext('2d')!.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, W * 2 * scale, H * scale)
  ctx.font = '12px Menlo, Consolas, monospace'
  ctx.lineWidth = 2
  for (const d of pic.detections) {
    if (!d.bbox) continue
    const [bx, by, bw, bh] = d.bbox
    const c = KIND_COLOUR[d.kind]
    ctx.strokeStyle = c
    ctx.strokeRect(bx * scale, by * scale, Math.max(2, bw * scale), Math.max(2, bh * scale))
    const label = `${d.kind}${d.heightM ? ` ${d.heightM.toFixed(1)} m` : ''} · ${d.distanceM.toFixed(1)} m`
    const tw = ctx.measureText(label).width
    const ly = by * scale > 16 ? by * scale - 4 : (by + bh) * scale + 13
    ctx.fillStyle = 'rgba(10, 18, 18, 0.75)'
    ctx.fillRect(bx * scale - 1, ly - 11, tw + 6, 14)
    ctx.fillStyle = c
    ctx.fillText(label, bx * scale + 2, ly)
  }
}
