// The helmet's stereo camera pair (docs/helmet/PLAN.md §6.3, T3.5): two parallel cameras 0.30 m apart at eye
// height, 70° horizontal field of view, 256 × 192, following the head. Each CV tick both are rendered into small
// render targets and read back as pixels. COLOUR ONLY: no depth buffer, no object ids. The CV gets what a camera
// would give it, plus the pose of the left camera (from the simulator: a stand-in for suit IMU + visual odometry).
import * as THREE from 'three'
import type { CvFrame, Pose, StereoIntrinsics } from '../contracts.ts'
import { headingToDir, localToThree } from '../frames.ts'

export const CV_WIDTH = 256
export const CV_HEIGHT = 192
export const CV_HFOV_DEG = 70
export const CV_BASELINE_M = 0.3

export function cvIntrinsics(width = CV_WIDTH, height = CV_HEIGHT, hfovDeg = CV_HFOV_DEG, baselineM = CV_BASELINE_M): StereoIntrinsics {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360)
  // pixel (u, v) is the centre of column u, row v, so a symmetric frustum has its principal point at (size − 1) / 2
  return { width, height, fx: f, fy: f, cx: (width - 1) / 2, cy: (height - 1) / 2, baselineM }
}

/** Poses of the two cameras for a head pose: half a baseline to each side, same direction, no roll. */
export function eyePoses(head: Pose, baselineM = CV_BASELINE_M): { left: Pose; right: Pose } {
  const r = headingToDir(head.headingDeg + 90)
  const h = baselineM / 2
  return {
    left: { ...head, x: head.x - r.x * h, y: head.y - r.y * h },
    right: { ...head, x: head.x + r.x * h, y: head.y + r.y * h },
  }
}

/** Linear render-target value → display (sRGB-like) value, so the images look like a camera's. */
const GAMMA = new Uint8Array(256)
for (let i = 0; i < 256; i++) GAMMA[i] = Math.round(255 * Math.pow(i / 255, 1 / 2.2))

export class CvRig {
  readonly intr: StereoIntrinsics
  /** The last left image, RGBA, row 0 at the top (for the CV view). Overwritten by every capture. */
  readonly leftRgba: Uint8ClampedArray
  private renderer: THREE.WebGLRenderer
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private cams: [THREE.PerspectiveCamera, THREE.PerspectiveCamera]
  private raw: Uint8Array
  private nextId = 1

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.intr = cvIntrinsics()
    const { width: W, height: H, fy } = this.intr
    const vfov = (2 * Math.atan(H / 2 / fy) * 180) / Math.PI
    const make = () => new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    this.targets = [make(), make()]
    this.cams = [new THREE.PerspectiveCamera(vfov, W / H, 0.1, 6000), new THREE.PerspectiveCamera(vfov, W / H, 0.1, 6000)]
    this.raw = new Uint8Array(W * H * 4)
    this.leftRgba = new Uint8ClampedArray(W * H * 4)
  }

  /** Render both eyes for this head pose and read them back. The arrays are new every call (the worker takes them). */
  capture(scene: THREE.Scene, head: Pose): CvFrame {
    const { width: W, height: H } = this.intr
    const eyes = eyePoses(head, this.intr.baselineM)
    const left = new Uint8Array(W * H)
    const right = new Uint8Array(W * H)
    const rgbLeft = new Uint8Array(W * H * 3)
    const r = this.renderer
    const before = r.getRenderTarget()
    ;[eyes.left, eyes.right].forEach((pose, k) => {
      const cam = this.cams[k]
      const at = localToThree(pose)
      const d = localToThree(headingToDir(pose.headingDeg, pose.pitchDeg))
      cam.position.set(at.x, at.y, at.z)
      cam.lookAt(at.x + d.x, at.y + d.y, at.z + d.z)
      r.setRenderTarget(this.targets[k])
      r.render(scene, cam)
      r.readRenderTargetPixels(this.targets[k], 0, 0, W, H, this.raw)
      const gray = k === 0 ? left : right
      // readRenderTargetPixels returns rows bottom-up
      for (let y = 0; y < H; y++) {
        let src = (H - 1 - y) * W * 4
        let dst = y * W
        for (let x = 0; x < W; x++, src += 4, dst++) {
          const R = GAMMA[this.raw[src]]
          const G = GAMMA[this.raw[src + 1]]
          const B = GAMMA[this.raw[src + 2]]
          gray[dst] = (R * 77 + G * 150 + B * 29) >> 8
          if (k === 0) {
            rgbLeft[dst * 3] = R
            rgbLeft[dst * 3 + 1] = G
            rgbLeft[dst * 3 + 2] = B
            this.leftRgba[dst * 4] = R
            this.leftRgba[dst * 4 + 1] = G
            this.leftRgba[dst * 4 + 2] = B
            this.leftRgba[dst * 4 + 3] = 255
          }
        }
      }
    })
    r.setRenderTarget(before)
    return { id: this.nextId++, left, right, rgbLeft, intr: this.intr, pose: eyes.left }
  }

  dispose(): void {
    this.targets.forEach((t) => t.dispose())
  }
}
