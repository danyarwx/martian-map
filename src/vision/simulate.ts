// SIMULATED dust for demos and tests. Not data: it paints haze over a real frame so the analyzer
// can be shown reacting. Anything made with this must be labelled as simulated.
//
// Standard haze model: seen = scene * t + airlight * (1 - t), where t is how much of the scene
// still gets through. Dust is thicker towards the top of the frame (the far distance and the sky).

import type { Frame } from './types'

/** Colour of sunlit airborne dust, taken from Curiosity's Mastcam frame of sol 2077. */
const AIRLIGHT = [205, 160, 112]

/** Returns a new frame. `strength` 0 = untouched, 1 = nothing but dust. */
export function addSimulatedDust(frame: Frame, strength: number): Frame {
  const { data, width, height } = frame
  const out = new Uint8ClampedArray(data.length)
  const s = Math.min(1, Math.max(0, strength))
  for (let y = 0; y < height; y++) {
    const depth = 1 - y / height // 1 at the top of the frame, 0 at the astronaut's feet
    const t = 1 - s * (0.7 + 0.3 * depth)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      out[p] = data[p] * t + AIRLIGHT[0] * (1 - t)
      out[p + 1] = data[p + 1] * t + AIRLIGHT[1] * (1 - t)
      out[p + 2] = data[p + 2] * t + AIRLIGHT[2] * (1 - t)
      out[p + 3] = 255
    }
  }
  return { data: out, width, height }
}
