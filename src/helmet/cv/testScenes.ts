// Synthetic scenes for the CV tests only (never imported by the worker or the app).
// Ground truth comes from geometry: a pinhole camera casts rays at planes and boxes, so the true depth
// and disparity of every pixel are known without a renderer. Stereo tests get images by sampling a
// random texture on the surfaces that the rays hit.
import type { Pose, StereoIntrinsics } from '../contracts.ts'
import { headingToDir } from '../frames.ts'

/** Small deterministic PRNG (mulberry32), uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random texture, gently smoothed so that sub-pixel sampling looks the same in both images. */
export interface Texture {
  width: number
  height: number
  data: Float32Array
}

export function makeTexture(width: number, height: number, seed: number): Texture {
  const r = rng(seed)
  const raw = new Float32Array(width * height)
  for (let i = 0; i < raw.length; i++) raw[i] = r() * 255
  const data = new Float32Array(width * height)
  // [1 2 1] ⊗ [1 2 1] smoothing, edges repeated.
  const k = [1, 2, 1]
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy))
          const xx = Math.min(width - 1, Math.max(0, x + dx))
          s += k[dy + 1] * k[dx + 1] * raw[yy * width + xx]
        }
      data[y * width + x] = s / 16
    }
  // Stretch the contrast back to roughly 0..255.
  let lo = Infinity
  let hi = -Infinity
  for (const v of data) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  for (let i = 0; i < data.length; i++) data[i] = ((data[i] - lo) / (hi - lo)) * 255
  return { width, height, data }
}

/** Bilinear sample, wrapping around so any coordinate is valid. */
export function sample(t: Texture, u: number, v: number): number {
  const fu = Math.floor(u)
  const fv = Math.floor(v)
  const au = u - fu
  const av = v - fv
  const w = t.width
  const h = t.height
  const x0 = ((fu % w) + w) % w
  const y0 = ((fv % h) + h) % h
  const x1 = (x0 + 1) % w
  const y1 = (y0 + 1) % h
  const d = t.data
  const top = d[y0 * w + x0] * (1 - au) + d[y0 * w + x1] * au
  const bot = d[y1 * w + x0] * (1 - au) + d[y1 * w + x1] * au
  return top * (1 - av) + bot * av
}

/** An image of width × height from a per-pixel function (values clamped to 0..255). */
export function image(width: number, height: number, f: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = Math.max(0, Math.min(255, Math.round(f(x, y))))
  return out
}

/** Pinhole intrinsics with a symmetric frustum. Pixel (u, v) is the centre of column u, row v. */
export function intrinsics(width = 256, height = 192, hfovDeg = 70, baselineM = 0.3): StereoIntrinsics {
  const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360)
  return { width, height, fx, fy: fx, cx: (width - 1) / 2, cy: (height - 1) / 2, baselineM }
}

// ---- Geometry ----------------------------------------------------------------------------------

export interface V3 {
  x: number
  y: number
  z: number
}

/** Plane through `point` with upward normal `normal` (local ENU). */
export interface Plane {
  point: V3
  normal: V3
}

/** Axis-aligned box in local ENU. */
export interface Box {
  min: V3
  max: V3
}

export interface Scene {
  ground: Plane
  boxes: Box[]
}

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z)
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}

/** A plane rising `slopeDeg` towards heading `upDirDeg` (clockwise from north), height `z0` at (0, 0). */
export function tiltedPlane(slopeDeg: number, upDirDeg = 0, z0 = 0): Plane {
  const s = Math.sin((slopeDeg * Math.PI) / 180)
  const c = Math.cos((slopeDeg * Math.PI) / 180)
  const h = headingToDir(upDirDeg)
  return { point: { x: 0, y: 0, z: z0 }, normal: { x: -h.x * s, y: -h.y * s, z: c } }
}

/** Height of a plane at (x, y). */
export function planeZ(p: Plane, x: number, y: number): number {
  return p.point.z - (p.normal.x * (x - p.point.x) + p.normal.y * (y - p.point.y)) / p.normal.z
}

/** Camera basis in local ENU, built independently of cv/points.ts: forward, right, up. */
export function cameraBasis(pose: Pose): { f: V3; r: V3; u: V3 } {
  const f = headingToDir(pose.headingDeg, pose.pitchDeg)
  const r = norm(cross(f, { x: 0, y: 0, z: 1 }))
  const u = cross(r, f)
  return { f, r, u }
}

/** Pose of the right camera of the pair: the left pose moved by the baseline along the camera's right. */
export function rightPose(pose: Pose, baselineM: number): Pose {
  const { r } = cameraBasis(pose)
  return { ...pose, x: pose.x + r.x * baselineM, y: pose.y + r.y * baselineM, z: pose.z + r.z * baselineM }
}

/** Ray through pixel (u, v), scaled so that its component along the optical axis is 1. */
export function pixelRay(intr: StereoIntrinsics, pose: Pose, u: number, v: number): V3 {
  const { f, r, u: up } = cameraBasis(pose)
  const a = (u - intr.cx) / intr.fx
  const b = (v - intr.cy) / intr.fy // image rows grow downwards
  return { x: f.x + a * r.x - b * up.x, y: f.y + a * r.y - b * up.y, z: f.z + a * r.z - b * up.z }
}

export interface Hit {
  /** Depth along the optical axis (= ray parameter, since the ray's axial component is 1). */
  t: number
  p: V3
  /** -1 ground, else the box index. */
  surface: number
}

/** Nearest surface hit by a ray from `o` along `d`, or null. */
export function cast(scene: Scene, o: V3, d: V3): Hit | null {
  let best: Hit | null = null
  const g = scene.ground
  const denom = dot(g.normal, d)
  if (denom < -1e-9) {
    const t = dot(g.normal, { x: g.point.x - o.x, y: g.point.y - o.y, z: g.point.z - o.z }) / denom
    if (t > 0) best = { t, p: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t }, surface: -1 }
  }
  scene.boxes.forEach((b, i) => {
    // Slab method.
    let t0 = -Infinity
    let t1 = Infinity
    for (const k of ['x', 'y', 'z'] as const) {
      if (Math.abs(d[k]) < 1e-12) {
        if (o[k] < b.min[k] || o[k] > b.max[k]) return
        continue
      }
      let ta = (b.min[k] - o[k]) / d[k]
      let tb = (b.max[k] - o[k]) / d[k]
      if (ta > tb) [ta, tb] = [tb, ta]
      t0 = Math.max(t0, ta)
      t1 = Math.min(t1, tb)
    }
    if (t1 >= t0 && t0 > 0 && (!best || t0 < best.t))
      best = { t: t0, p: { x: o.x + d.x * t0, y: o.y + d.y * t0, z: o.z + d.z * t0 }, surface: i }
  })
  return best
}

/** True disparity of every left-image pixel (NaN where nothing is hit). */
export function trueDisparity(intr: StereoIntrinsics, pose: Pose, scene: Scene): Float32Array {
  const out = new Float32Array(intr.width * intr.height)
  for (let v = 0; v < intr.height; v++)
    for (let u = 0; u < intr.width; u++) {
      const h = cast(scene, pose, pixelRay(intr, pose, u, v))
      out[v * intr.width + u] = h ? (intr.fx * intr.baselineM) / h.t : NaN
    }
  return out
}

/**
 * Left and right grayscale images of a scene: each surface point gets the value of `tex` at its
 * world position (`texPerM` texels per metre), boxes use their own texture offset so they stand out.
 */
export function renderStereo(
  intr: StereoIntrinsics,
  pose: Pose,
  scene: Scene,
  tex: Texture,
  texPerM = 12,
): { left: Uint8Array; right: Uint8Array } {
  const render = (p: Pose) =>
    image(intr.width, intr.height, (u, v) => {
      const h = cast(scene, p, pixelRay(intr, p, u, v))
      if (!h) return 0
      if (h.surface < 0) return sample(tex, h.p.x * texPerM, h.p.y * texPerM)
      // Box faces: project on the two axes that vary on the face.
      const b = scene.boxes[h.surface]
      const onX = Math.min(Math.abs(h.p.x - b.min.x), Math.abs(h.p.x - b.max.x)) < 1e-6
      const onY = Math.min(Math.abs(h.p.y - b.min.y), Math.abs(h.p.y - b.max.y)) < 1e-6
      const [a, c] = onX ? [h.p.y, h.p.z] : onY ? [h.p.x, h.p.z] : [h.p.x, h.p.y]
      return sample(tex, a * texPerM + 97 * (h.surface + 1), c * texPerM + 31)
    })
  return { left: render(pose), right: render(rightPose(pose, intr.baselineM)) }
}

/** Median of the finite values. */
export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).filter(Number.isFinite).sort((p, q) => p - q)
  if (!a.length) return NaN
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
