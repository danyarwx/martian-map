// 5 × 5 census transform (docs/helmet/PLAN.md §5.1). Each pixel becomes a 24-bit code: one bit per
// neighbour, set when the neighbour is darker than the centre. Matching codes with the Hamming distance
// is robust to the brightness and gain differences between two cameras, which plain SAD is not.

/** Half size of the census window: 5 × 5. */
export const CENSUS_RADIUS = 2
/** Bits per code (5 × 5 window without its centre). */
export const CENSUS_BITS = 24

/** Bits set in every 12-bit value: two lookups count a 24-bit code. Built once at module load. */
export const POPCOUNT12 = (() => {
  const t = new Uint8Array(4096)
  for (let i = 1; i < 4096; i++) t[i] = (i & 1) + t[i >> 1]
  return t
})()

/** Number of differing bits between two census codes. */
export function hamming24(a: number, b: number): number {
  const x = a ^ b
  return POPCOUNT12[x & 4095] + POPCOUNT12[x >>> 12]
}

/**
 * Census codes of a grayscale image (row-major, width × height) into `out` (same size).
 * Outside the image the edge pixels are repeated, so border codes stay usable.
 */
export function censusTransform(img: Uint8Array, width: number, height: number, out: Uint32Array): Uint32Array {
  const r = CENSUS_RADIUS
  for (let y = 0; y < height; y++) {
    const interiorY = y >= r && y < height - r
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const c = img[i]
      let bits = 0
      if (interiorY && x >= r && x < width - r) {
        // Fast path: no clamping.
        for (let dy = -r; dy <= r; dy++) {
          const row = i + dy * width
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dy === 0) continue
            bits = (bits << 1) | (img[row + dx] < c ? 1 : 0)
          }
        }
      } else {
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy)) * width
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dy === 0) continue
            const xx = Math.min(width - 1, Math.max(0, x + dx))
            bits = (bits << 1) | (img[yy + xx] < c ? 1 : 0)
          }
        }
      }
      out[i] = bits >>> 0
    }
  }
  return out
}
