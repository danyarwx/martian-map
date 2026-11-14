// Visibility metrics measured from the pixels of one camera frame.
// Plain arithmetic: runs in a few milliseconds, needs no model and no network.
// Give it a small frame (about 320 px wide is plenty); the caller does the downscaling.

import type { Frame, FrameMetrics } from './types'

/** Side of the square patch used for the dark channel, in pixels of the downscaled frame. */
const PATCH = 8

export function measureFrame(frame: Frame): FrameMetrics {
  const { data, width: w, height: h } = frame
  const n = w * h
  const luma = new Float32Array(n)
  const minRgb = new Float32Array(n)

  let sum = 0
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p] / 255
    const g = data[p + 1] / 255
    const b = data[p + 2] / 255
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    luma[i] = y
    sum += y
    minRgb[i] = Math.min(r, g, b)
  }
  const mean = sum / n

  let varSum = 0
  for (let i = 0; i < n; i++) varSum += (luma[i] - mean) ** 2
  const contrast = Math.sqrt(varSum / n)

  // Edge strength in the lower half: central differences of luma.
  let edgeSum = 0
  let edgeCount = 0
  for (let y = Math.max(1, Math.floor(h / 2)); y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = luma[i + 1] - luma[i - 1]
      const gy = luma[i + w] - luma[i - w]
      edgeSum += Math.sqrt(gx * gx + gy * gy)
      edgeCount++
    }
  }
  const groundDetail = edgeCount ? edgeSum / edgeCount : 0

  // Dark channel: darkest value of any colour channel inside each patch, averaged over patches.
  let darkSum = 0
  let patches = 0
  for (let py = 0; py + PATCH <= h; py += PATCH) {
    for (let px = 0; px + PATCH <= w; px += PATCH) {
      let dark = 1
      for (let y = py; y < py + PATCH; y++) {
        for (let x = px; x < px + PATCH; x++) {
          const v = minRgb[y * w + x]
          if (v < dark) dark = v
        }
      }
      darkSum += dark
      patches++
    }
  }
  const haze = patches ? darkSum / patches : 0

  return { contrast, groundDetail, haze, brightness: mean }
}
