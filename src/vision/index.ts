// Onboard vision: the helmet camera's hazard analyzer. Everything runs on the device.
//
//   const frame = frameFromCanvas(canvas)          // downscale to 320 px
//   const report = buildReport(measureFrame(frame)) // instant, pixels only
//   const labels = await classifyFrame(canvas.toDataURL('image/jpeg'))
//   const better = buildReport(measureFrame(frame), labels) // with the image model

export * from './types'
export { measureFrame } from './metrics'
export { buildReport, lossFromMetrics, stormShare, HAZE_AT, STORM_AT } from './analyze'
export { addSimulatedDust } from './simulate'
export { loadModel, classifyFrame, MODEL_ID, MODEL_LABELS } from './model'
export type { ModelProgress } from './model'

import type { Frame } from './types'

/** Width the metrics were calibrated at. */
export const ANALYSIS_WIDTH = 320

/** Downscales anything drawable (image, video frame, canvas) to the analysis size. Browser only. */
export function frameFromCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): Frame {
  const width = ANALYSIS_WIDTH
  const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, width, height)
  const image = ctx.getImageData(0, 0, width, height)
  return { data: image.data, width, height }
}
