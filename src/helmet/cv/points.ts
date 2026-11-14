// Disparity → 3D points in local ENU (docs/helmet/PLAN.md §5.2).
//
// Camera frame (pinhole, OpenCV style): X right, Y down, Z forward along the optical axis. Pixel (u, v)
// is the centre of column u, row v (row 0 at the top), so a symmetric frustum has cx = (width − 1)/2.
// The LEFT camera's Pose gives its position and where it looks: forward = frames.headingToDir(heading,
// pitch), right = (cos ψ, −sin ψ, 0) (horizontal, no roll), down = right × forward reversed.
import type { Pose, StereoIntrinsics } from '../contracts.ts'
import { DEPTH_MAX_M, DEPTH_MIN_M } from './stereo.ts'

/** Most points kept per frame: enough for the 0.5 m grid out to ~15 m, small enough for 4 Hz. */
export const MAX_POINTS = 15000

export interface PointCloud {
  readonly capacity: number
  /** Points in use. */
  n: number
  /** x, y, z per point, local ENU metres. */
  readonly xyz: Float32Array
  /** Left-image pixel of each point, v · width + u. */
  readonly pix: Int32Array
}

export function createPointCloud(capacity = MAX_POINTS): PointCloud {
  return { capacity, n: 0, xyz: new Float32Array(capacity * 3), pix: new Int32Array(capacity) }
}

/** Camera axes in local ENU: right, down, forward (each a unit vector), from a pose without roll. */
export interface CameraAxes {
  rx: number
  ry: number
  rz: number
  dx: number
  dy: number
  dz: number
  fx: number
  fy: number
  fz: number
}

export function cameraAxes(pose: Pose): CameraAxes {
  const h = (pose.headingDeg * Math.PI) / 180
  const p = (pose.pitchDeg * Math.PI) / 180
  const sh = Math.sin(h)
  const ch = Math.cos(h)
  const sp = Math.sin(p)
  const cp = Math.cos(p)
  // up = right × forward = (−sinψ·sinθ, −cosψ·sinθ, cosθ); down is its opposite.
  return { rx: ch, ry: -sh, rz: 0, dx: sh * sp, dy: ch * sp, dz: -cp, fx: sh * cp, fy: ch * cp, fz: sp }
}

/**
 * Back-project the valid pixels of a disparity map (NaN = invalid) into `cloud`, in local ENU.
 * Depths outside 1–25 m are dropped. When more than `maxPoints` pixels are valid, every k-th valid
 * pixel in raster order is kept (deterministic, spread over the whole image). Returns the point count.
 */
export function backProject(
  disparity: Float32Array,
  intr: StereoIntrinsics,
  pose: Pose,
  cloud: PointCloud,
  maxPoints = cloud.capacity,
): number {
  const { width: W, height: H, fx, fy, cx, cy, baselineM } = intr
  const fb = fx * baselineM
  const dMin = fb / DEPTH_MAX_M
  const dMax = fb / DEPTH_MIN_M
  const limit = Math.min(maxPoints, cloud.capacity)
  const N = W * H

  let nValid = 0
  for (let i = 0; i < N; i++) {
    const d = disparity[i]
    if (d >= dMin && d <= dMax) nValid++ // false for NaN
  }
  const k = Math.max(1, Math.ceil(nValid / limit))

  const a = cameraAxes(pose)
  const { xyz, pix } = cloud
  let n = 0
  let seen = 0
  for (let v = 0; v < H; v++) {
    const yc = (v - cy) / fy
    for (let u = 0; u < W; u++) {
      const i = v * W + u
      const d = disparity[i]
      if (!(d >= dMin && d <= dMax)) continue
      if (seen++ % k !== 0) continue
      if (n >= limit) break
      const Z = fb / d
      const X = ((u - cx) / fx) * Z
      const Y = yc * Z
      const o = n * 3
      xyz[o] = pose.x + X * a.rx + Y * a.dx + Z * a.fx
      xyz[o + 1] = pose.y + X * a.ry + Y * a.dy + Z * a.fy
      xyz[o + 2] = pose.z + X * a.rz + Y * a.dz + Z * a.fz
      pix[n] = i
      n++
    }
  }
  cloud.n = n
  return n
}

/**
 * Left-image pixel (u, v) and depth Z of a local ENU point; Z ≤ 0 means behind the camera.
 * Writes into `out` ([u, v, Z]) to stay allocation-free.
 */
export function projectToImage(
  x: number,
  y: number,
  z: number,
  intr: StereoIntrinsics,
  axes: CameraAxes,
  pose: Pose,
  out: Float64Array,
): Float64Array {
  const px = x - pose.x
  const py = y - pose.y
  const pz = z - pose.z
  const X = px * axes.rx + py * axes.ry + pz * axes.rz
  const Y = px * axes.dx + py * axes.dy + pz * axes.dz
  const Z = px * axes.fx + py * axes.fy + pz * axes.fz
  out[0] = intr.cx + (intr.fx * X) / Z
  out[1] = intr.cy + (intr.fy * Y) / Z
  out[2] = Z
  return out
}
