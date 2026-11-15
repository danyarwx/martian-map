// Turns the pixel metrics (and, when the image model is loaded, its label scores) into one report.
// Pure function: no DOM, no network. The thresholds were set on real rover frames, listed in
// public/vision-samples/SOURCES.md: Curiosity's Mastcam during the June 2018 global dust storm
// against clear-day Perseverance frames.

import type { CameraProfile, FrameMetrics, LabelScore, Visibility, VisionHazard, VisionReport } from './types'

/** Visibility loss at which the frame counts as hazy, and as a storm. */
export const HAZE_AT = 0.45
export const STORM_AT = 0.6

/** How much the image model's opinion counts against the pixel metrics. */
const MODEL_WEIGHT = 0.3

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** 0 at `from`, 1 at `to`, linear in between. Works in either direction. */
const ramp = (v: number, from: number, to: number) => clamp01((v - from) / (to - from))

/** Visibility loss from the pixels alone.
 *  Lost ground texture counts most: it held up across cameras (raw Mastcam and Navcam frames and
 *  the stitched helmet panoramas), while overall contrast differs from camera to camera. */
export function lossFromMetrics(m: FrameMetrics, profile: CameraProfile = 'rover'): number {
  if (profile === 'helmet') return lossHelmet(m)
  const blurred = ramp(m.groundDetail, 0.03, 0.012) // ground texture gone
  const hazy = ramp(m.haze, 0.3, 0.45) // dark channel lifted by airborne dust
  const flat = ramp(m.contrast, 0.13, 0.06) // brightness range collapsed
  return 0.5 * blurred + 0.35 * hazy + 0.15 * flat
}

/** Visibility loss for the 3D helmet's camera (256 x 192, rendered). Its ground has little fine texture and
 *  no deep shadows, so the rover calibration reads every frame as half hazy. What does change with dust is the
 *  distance: hills and the horizon fade into a smooth glow. Set on the helmet's own frames in clear air
 *  (far detail 0.019 to 0.052) and in the simulated storm (0.008 or less at 70 % strength and up). */
function lossHelmet(m: FrameMetrics): number {
  return ramp(m.farDetail, 0.016, 0.005)
}

/** Share of "storm" against "clear" in the model's scores, 0 to 1. Undefined without the model. */
export function stormShare(labels: LabelScore[]): number | undefined {
  const storm = labels.find(l => l.id === 'storm')?.score
  const clear = labels.find(l => l.id === 'clear')?.score
  if (storm === undefined || clear === undefined || storm + clear === 0) return undefined
  return storm / (storm + clear)
}

export function buildReport(metrics: FrameMetrics, labels: LabelScore[] = [], profile: CameraProfile = 'rover'): VisionReport {
  const fromPixels = lossFromMetrics(metrics, profile)
  const share = stormShare(labels)
  // The model can be fooled by any bright hazy sky, the metrics by a camera pointed at smooth sand.
  // Together they have to agree before the helmet calls a storm.
  const loss = share === undefined ? fromPixels : (1 - MODEL_WEIGHT) * fromPixels + MODEL_WEIGHT * share

  let hazard: VisionHazard = 'none'
  let visibility: Visibility = 'good'
  if (loss >= STORM_AT) {
    hazard = 'dust_storm'
    visibility = 'low'
  } else if (loss >= HAZE_AT) {
    hazard = 'dust_haze'
    visibility = 'reduced'
  }

  // Confidence grows with the distance from the nearest decision threshold: 0.5 right on it.
  const edge = Math.min(Math.abs(loss - HAZE_AT), Math.abs(loss - STORM_AT))
  const confidence = 0.5 + 0.5 * clamp01(edge / 0.2)

  const pct = Math.round(loss * 100)
  const text =
    hazard === 'dust_storm'
      ? `Dust storm likely. Visibility low, ${pct}% lost.`
      : hazard === 'dust_haze'
        ? `Dust haze. Visibility reduced, ${pct}% lost.`
        : 'Clear. Visibility good.'
  const recommendation =
    hazard === 'dust_storm'
      ? 'Stop the excursion and walk back to the habitat.'
      : hazard === 'dust_haze'
        ? 'Continue with care and stay inside the walk-back reserve.'
        : 'Continue on the planned route.'

  return {
    hazard,
    confidence,
    visibility,
    visibilityLoss: loss,
    text,
    recommendation,
    metrics,
    labels: [...labels].sort((a, b) => b.score - a.score),
    source: share === undefined ? 'metrics' : 'metrics+model',
  }
}
