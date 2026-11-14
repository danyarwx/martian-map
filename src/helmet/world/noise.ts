// Deterministic randomness for the world: seeded PRNG, string hash, value noise and fBm. Pure: no three.js.

/** 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Mulberry32: small, fast, good enough for scattering rocks. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash of an integer lattice point to [0, 1). */
export function hash2(ix: number, iy: number, seed = 0): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1], one lattice cell per unit. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy, seed)
  const b = hash2(ix + 1, iy, seed)
  const c = hash2(ix, iy + 1, seed)
  const d = hash2(ix + 1, iy + 1, seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** Wavelengths (m) and amplitudes (m) of the micro-relief on coarse terrain: 2–16 m, 0.3 m peak in total. */
export const MICRO_RELIEF: readonly { wavelengthM: number; amplitudeM: number }[] = [
  { wavelengthM: 16, amplitudeM: 0.16 },
  { wavelengthM: 8, amplitudeM: 0.08 },
  { wavelengthM: 4, amplitudeM: 0.04 },
  { wavelengthM: 2, amplitudeM: 0.02 },
]

/** Micro-relief in metres (−0.3..0.3) at a point given in metres from a fixed anchor. */
export function microRelief(e: number, s: number): number {
  let z = 0
  for (let o = 0; o < MICRO_RELIEF.length; o++) {
    const { wavelengthM, amplitudeM } = MICRO_RELIEF[o]
    z += amplitudeM * (2 * valueNoise(e / wavelengthM, s / wavelengthM, 17 + o) - 1)
  }
  return z
}
