// Onboard vision: what the helmet camera reports. Pure data, no DOM, so the HUD, the map and a
// future assistant can all read the same report.

/** What the camera thinks it is looking at. */
export type VisionHazard = 'none' | 'dust_storm' | 'dust_haze' | 'dust_devil' | 'boulder_field'

export type Visibility = 'good' | 'reduced' | 'low'

/** Numbers measured straight from the pixels. No neural network involved. All 0 to 1. */
export type FrameMetrics = {
  /** Spread of brightness over the whole frame (standard deviation of luma). Dust flattens it. */
  contrast: number
  /** Average edge strength in the lower half of the frame, where the ground is. Dust blurs it. */
  groundDetail: number
  /** Dark-channel haze measure: how bright the darkest colour channel is, patch by patch.
   *  A clear scene always has shadows and saturated colours (low value); airborne dust lifts it. */
  haze: number
  /** Average brightness of the frame. */
  brightness: number
}

/** One zero-shot label from the image model with its share of the probability. */
export type LabelScore = { id: string; hazard: VisionHazard; score: number }

/** The report the helmet shows and the assistant reads. */
export type VisionReport = {
  hazard: VisionHazard
  /** 0 to 1. How sure the analyzer is about `hazard`. */
  confidence: number
  visibility: Visibility
  /** 0 = as clear as the reference clear day, 1 = nothing visible. */
  visibilityLoss: number
  /** One short sentence for the visor. */
  text: string
  /** What the astronaut should do. */
  recommendation: string
  metrics: FrameMetrics
  /** Scores from the image model, highest first. Empty when the model has not loaded: the
   *  report is then built from the pixel metrics alone. */
  labels: LabelScore[]
  /** Which parts of the analyzer produced this report. */
  source: 'metrics' | 'metrics+model'
}

/** A frame as raw RGBA pixels, the same layout as the browser's ImageData. */
export type Frame = { data: Uint8ClampedArray | Uint8Array; width: number; height: number }
