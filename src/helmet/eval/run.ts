// The CV eval harness (docs/helmet/PLAN.md T4.4): renders 60 fixed poses in the real helmet world, runs the real
// CV pipeline on each stereo pair, and scores it against the world's ground truth. Dev only (#helmet-eval).
//
// This is the one place that may see both sides: world/ (truth) and cv/ (what is tested). The CV still gets
// only the two colour images and the camera pose, exactly as in a session; everything read from the world
// here is used after the fact, to score.
//
// Truth:
//   rocks  world rocks standing ≥ 0.30 m (h · (1 − BURY)), 2–12 m from the left camera, whose middle projects
//          into the left image and whose top is not behind a rise of the terrain;
//   depth  a second render of the same scene from the left camera with a material that writes the distance
//          along the optical axis (packed into 24 bits), once with and once without the rocks: a pixel is
//          "ground" where both agree;
//   slope  HeightField.slopeAt (2 m baseline) at the middle of each 1 m block the CV gave a slope for;
//   sand   the tiles' sand masks (derived from the ortho by scripts/build_helmet_tiles.py) under each judged
//          16 × 16 px patch.
// Sand training: logistic regression on the patches of two poses in three, tested on the third (logistic.ts).
//
// The loop never waits for requestAnimationFrame or timers (a background tab gets about one frame a second):
// tiles are streamed by calling world.update in a loop that yields through a MessageChannel.
import * as THREE from 'three'
import { JEZERO } from '../../data/jezero.ts'
import { loadTerrain } from '../../lib/terrain.ts'
import type { CvFrame, Detection, Pose, StereoIntrinsics } from '../contracts.ts'
import { createCvPipeline, runFrame } from '../cv/pipeline.ts'
import { cameraAxes, projectToImage } from '../cv/points.ts'
import { createSandHook, patchOfPixel, SAND_FEATURES, SAND_NF } from '../cv/sand.ts'
import { SAND_WEIGHTS } from '../cv/sandWeights.ts'
import { headingToDir, localToThree } from '../frames.ts'
import { CvRig } from '../sim/cvRig.ts'
import { loadRoutes } from '../sim/defaultEntry.ts'
import { EYE_M } from '../sim/player.ts'
import { makeCoarseGrid } from '../world/heightField.ts'
import { BURY } from '../world/rocks.ts'
import { World } from '../world/scene.ts'
import { loadTileIndex, strideFor, type TileSlot } from '../world/tiles.ts'
import { predict, prf, trainLogistic, type Prf } from './logistic.ts'
import { mean, median, rms, ROCK_FAR_M, ROCK_MIN_STAND_M, ROCK_NEAR_M, scoreRockCells, scoreRocks, type TruthRock } from './metrics.ts'
import { evalWindows, poseLocal, type EvalPose } from './poses.ts'

/** PLAN T4.4 targets. */
export const TARGETS = { rockRecall: 0.8, rockPrecision: 0.7, depthRelAt5m: 0.05, slopeRmsDeg: 3, sandF1: 0.7 } as const

/** Depths beyond this are "far" in the truth render, metres. */
const DEPTH_FAR_M = 64
const DEPTH_BINS: [number, number][] = [[2, 4], [4, 6], [6, 10], [10, 15], [15, 25]]
/** Probability above which a patch is called sand (the classifier's threshold). */
const SAND_THRESHOLD = 0.6

export interface PoseRecord {
  id: string
  window: string
  kind: EvalPose['kind']
  x: number
  y: number
  headingDeg: number
  pitchDeg: number
  /** On a real 1 m tile. */
  fine: boolean
  truthRocks: number
  foundRocks: number
  detections: number
  detectionsTrue: number
  /** Median |relative depth error| of ground pixels 4–6 m away; NaN when there are none. */
  depthRel5m: number
  slopeRmsDeg: number
  slopeBlocks: number
  validShare: number
  ms: number
  sandPatches: number
  sandTruthShare: number
  sandDetections: number
}

/** What the page draws for one pose. */
export interface PoseView {
  width: number
  height: number
  rgba: Uint8ClampedArray
  detections: Detection[]
  /** Truth rocks in view: pixel of their middle, and whether the CV found them. */
  rocks: { u: number; v: number; found: boolean; standM: number }[]
  /** Judged sand patches: index, probability, truth. */
  patches: { index: number; prob: number; sand: boolean }[]
  patchPx: number
  patchCols: number
  /** For looking into a pose from the console: the CV's disparity, and the true depth with and without the rocks. */
  debug: { disparity: Float32Array; zAll: Float32Array; zTerrain: Float32Array; fb: number; left: Uint8Array; right: Uint8Array; pose: Pose }
}

export interface EvalMetrics {
  poses: number
  posesRun: number
  skipped: string[]
  rocks: {
    truth: number
    found: number
    recall: number
    detections: number
    detectionsTrue: number
    precision: number
    /** False detections with a 0.20–0.30 m rock under them. */
    falseOnLowRock: number
    /** The same on the hazard patch: rocks with a rock cell on or beside them, and rock cells at a rock. */
    onMap: { found: number; recall: number; cells: number; cellsTrue: number; precision: number }
    /** Recall by standing height. */
    byHeight: { from: number; to: number; truth: number; found: number; recall: number; onMap: number; recallOnMap: number }[]
    /** Recall by distance. */
    byDistance: { from: number; to: number; truth: number; found: number; recall: number; onMap: number; recallOnMap: number }[]
  }
  depth: {
    /** Ground pixels 4–6 m away with a disparity. */
    n: number
    medianRel: number
    meanRel: number
    /** Mean signed error (positive = the CV sees it further). */
    biasRel: number
    /** The same bin over every valid pixel, rocks included. */
    allPixels: { n: number; meanRel: number }
    bins: { from: number; to: number; n: number; meanRel: number; biasRel: number }[]
  }
  slope: { blocks: number; rmsDeg: number; biasDeg: number; rmsRawDeg: number; rawBlocks: number; rmsUnder10: number; rmsOver10: number }
  sand: {
    patches: number
    truthShare: number
    heldOutRule: string
    features: readonly string[]
    shipped: { weights: readonly number[]; train: Prf; heldOut: Prf }
    trained: { weights: number[]; train: Prf; heldOut: Prf }
  }
  cvMs: { mean: number; median: number; max: number }
  validShare: number
  seconds: number
}

export interface EvalResult {
  done: boolean
  metrics: EvalMetrics | null
  perPose: PoseRecord[]
  error?: string
}

export interface EvalHooks {
  host: HTMLElement
  signal: AbortSignal
  onProgress(text: string): void
  onPose(rec: PoseRecord, view: PoseView): void
}

/** One sand training row per judged patch. */
export interface SandData {
  nf: number
  names: readonly string[]
  X: number[]
  y: number[]
  pose: number[]
  /** Share of the patch's ground points on sand. */
  share: number[]
}

const channel = new MessageChannel()
/** Yield to the event loop without a timer or an animation frame. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(0)
  })
}

const rectDist = (s: TileSlot, x: number, y: number) => Math.hypot(Math.max(s.x0 - x, 0, x - s.x1), Math.max(s.y0 - y, 0, y - s.y1))

/** True when every tile in reach is built at its final detail and the rocks around the pose exist. */
function ready(world: World, p: Pose): boolean {
  if (world.tiles.pending > 0 || !world.tiles.readyAround(p.x, p.y, 100)) return false
  for (const s of world.tiles.builtSlots()) {
    if (s.dirty || strideFor(s.dist) !== s.stride) return false
    if (rectDist(s, p.x, p.y) < 150 && !world.rocks.field.hasTile(s.id)) return false
  }
  return true
}

/** Stream the world around `head` until it is ready (or the time runs out). Keeps the eyes 1.65 m above the ground. */
async function settle(world: World, head: Pose, signal: AbortSignal, timeoutMs = 180000): Promise<boolean> {
  const t0 = performance.now()
  let stable = 0
  while (performance.now() - t0 < timeoutMs) {
    if (signal.aborted) return false
    head.z = world.heights.heightAt(head.x, head.y) + EYE_M
    world.update(head)
    if (ready(world, head)) {
      if (++stable >= 4) return true
    } else stable = 0
    await tick()
  }
  return false
}

/** Renders the distance along the optical axis of the left camera, as the truth for the stereo depth. */
class DepthProbe {
  private target: THREE.WebGLRenderTarget
  private cam: THREE.PerspectiveCamera
  private mat: THREE.ShaderMaterial
  private raw: Uint8Array
  private renderer: THREE.WebGLRenderer
  private intr: StereoIntrinsics

  constructor(renderer: THREE.WebGLRenderer, intr: StereoIntrinsics) {
    this.renderer = renderer
    this.intr = intr
    const { width: W, height: H, fy } = intr
    this.target = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    this.cam = new THREE.PerspectiveCamera((2 * Math.atan(H / 2 / fy) * 180) / Math.PI, W / H, 0.1, 6000)
    this.raw = new Uint8Array(W * H * 4)
    this.mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        varying float vAxial;
        void main() {
          #include <begin_vertex>
          #include <project_vertex>
          vAxial = -mvPosition.z;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAxial;
        void main() {
          float v = clamp(vAxial / ${DEPTH_FAR_M.toFixed(1)}, 0.0, 1.0) * 16777215.0;
          float b0 = floor(v / 65536.0);
          float b1 = floor((v - b0 * 65536.0) / 256.0);
          float b2 = floor(v - b0 * 65536.0 - b1 * 256.0);
          gl_FragColor = vec4(b0, b1, b2, 255.0) / 255.0;
        }`,
    })
  }

  /** Fill `out` (row 0 at the top) with metres along the axis; DEPTH_FAR_M where nothing is nearer. */
  render(scene: THREE.Scene, pose: Pose, out: Float32Array): void {
    const { width: W, height: H } = this.intr
    const r = this.renderer
    const at = localToThree(pose)
    const d = localToThree(headingToDir(pose.headingDeg, pose.pitchDeg))
    this.cam.position.set(at.x, at.y, at.z)
    this.cam.lookAt(at.x + d.x, at.y + d.y, at.z + d.z)
    // Not part of the near ground: the sky dome, and the far terrain, whose own shader sinks it under the near
    // tiles (with this material it would stand at the 10 m grid's height and poke through them).
    const hide = ['sky', 'far terrain'].map((name) => scene.getObjectByName(name)).filter((o): o is THREE.Object3D => !!o && o.visible)
    for (const o of hide) o.visible = false
    const override = scene.overrideMaterial
    const target = r.getRenderTarget()
    const colour = r.getClearColor(new THREE.Color())
    const alpha = r.getClearAlpha()
    scene.overrideMaterial = this.mat
    r.setClearColor(0xffffff, 1)
    r.setRenderTarget(this.target)
    r.render(scene, this.cam)
    r.readRenderTargetPixels(this.target, 0, 0, W, H, this.raw)
    r.setRenderTarget(target)
    r.setClearColor(colour, alpha)
    scene.overrideMaterial = override
    for (const o of hide) o.visible = true
    for (let y = 0; y < H; y++) {
      let src = (H - 1 - y) * W * 4
      let dst = y * W
      for (let x = 0; x < W; x++, src += 4, dst++) {
        out[dst] = ((this.raw[src] * 65536 + this.raw[src + 1] * 256 + this.raw[src + 2]) / 16777215) * DEPTH_FAR_M
      }
    }
  }

  dispose(): void {
    this.target.dispose()
    this.mat.dispose()
  }
}

interface WorldRock extends TruthRock {
  z: number
}

/** The rocks around the camera, and those of them the camera should see as obstacles. */
function truthRocks(world: World, left: Pose, intr: StereoIntrinsics): { nearby: WorldRock[]; visible: WorldRock[]; pixels: { u: number; v: number }[] } {
  const nearby: WorldRock[] = world.rocks.field.rocksNear(left.x, left.y, ROCK_FAR_M + 4).map((r) => ({ x: r.x, y: r.y, z: r.z, d: r.d, standM: r.h * (1 - BURY) }))
  const axes = cameraAxes(left)
  const proj = new Float64Array(3)
  const visible: WorldRock[] = []
  const pixels: { u: number; v: number }[] = []
  for (const r of nearby) {
    if (r.standM < ROCK_MIN_STAND_M) continue
    const dist = Math.hypot(r.x - left.x, r.y - left.y)
    if (dist < ROCK_NEAR_M || dist > ROCK_FAR_M) continue
    projectToImage(r.x, r.y, r.z + r.standM / 2, intr, axes, left, proj)
    if (!(proj[2] > 0) || proj[0] < 0 || proj[0] > intr.width - 1 || proj[1] < 0 || proj[1] > intr.height - 1) continue
    // the top of the rock must not be behind a rise of the ground
    let hidden = false
    const top = r.z + r.standM
    for (let k = 1; k < 24 && !hidden; k++) {
      const t = k / 24
      const x = left.x + (r.x - left.x) * t
      const y = left.y + (r.y - left.y) * t
      if (left.z + (top - left.z) * t < world.heights.heightAt(x, y) - 0.02) hidden = true
    }
    if (hidden) continue
    visible.push(r)
    pixels.push({ u: proj[0], v: proj[1] })
  }
  return { nearby, visible, pixels }
}

/** Looks up the world's sand mask: 1 sand, 0 not, −1 unknown (coarse tile). */
function sandLookup(world: World): (x: number, y: number) => number {
  const slots = world.tiles.builtSlots()
  let last: TileSlot | null = null
  return (x, y) => {
    let s = last && x >= last.x0 && x < last.x1 && y > last.y0 && y <= last.y1 ? last : null
    if (!s) {
      for (const c of slots) {
        if (x >= c.x0 && x < c.x1 && y > c.y0 && y <= c.y1) {
          s = c
          break
        }
      }
    }
    if (!s || !s.sand) return -1
    last = s
    const px = Math.round(Math.sqrt(s.sand.length))
    const col = Math.min(px - 1, Math.floor(((x - s.x0) / (s.x1 - s.x0)) * px))
    const row = Math.min(px - 1, Math.floor(((s.y1 - y) / (s.y1 - s.y0)) * px))
    return s.sand[row * px + col]
  }
}

const cloneFrame = (f: CvFrame): CvFrame => ({ ...f, left: f.left.slice(), right: f.right.slice(), rgbLeft: f.rgbLeft?.slice() })

export async function runEval(hooks: EvalHooks): Promise<EvalResult & { sandData: SandData }> {
  const { signal } = hooks
  const started = performance.now()
  const perPose: PoseRecord[] = []
  const sandData: SandData = { nf: SAND_NF, names: SAND_FEATURES, X: [], y: [], pose: [], share: [] }
  const result: EvalResult & { sandData: SandData } = { done: false, metrics: null, perPose, sandData }

  hooks.onProgress('Loading the tile index, the 10 m grid and the routes…')
  const [index, terrain, routes] = await Promise.all([loadTileIndex(signal), loadTerrain(JEZERO.terrain), loadRoutes()])
  if (signal.aborted) return result
  const coarse = makeCoarseGrid(terrain)
  const windows = evalWindows(index.windows ?? [], routes.legs)
  const total = windows.reduce((n, w) => n + w.poses.length, 0)

  // the same renderer settings as a session (session.ts)
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(320, 240)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.domElement.style.display = 'none'
  hooks.host.appendChild(renderer.domElement)
  const rig = new CvRig(renderer)
  const intr = rig.intr
  const probe = new DepthProbe(renderer, intr)
  const N = intr.width * intr.height
  const zAll = new Float32Array(N)
  const zTerrain = new Float32Array(N)
  const fb = intr.fx * intr.baselineM

  // the pipeline of the worker (worker.ts): default tuning + the sand stage. The eval judges single frames, so
  // the sand stage paints at once here instead of waiting for a second frame.
  const sandHook = createSandHook({ persistFrames: 1 })
  const pipeline = createCvPipeline(intr, { sandHook })

  // accumulators
  const skipped: string[] = []
  const rockTruth: { standM: number; dist: number; found: boolean; onMap: boolean }[] = []
  let rockCells = 0, rockCellsTrue = 0
  let dets = 0, detsTrue = 0, falseOnLow = 0
  const rel5: number[] = []
  const binN = DEPTH_BINS.map(() => 0)
  const binAbs = DEPTH_BINS.map(() => 0)
  const binSigned = DEPTH_BINS.map(() => 0)
  let all5N = 0, all5Abs = 0
  const slopeErr: number[] = []
  const slopeErrRaw: number[] = []
  const slopeErrLow: number[] = []
  const slopeErrHigh: number[] = []
  const msAll: number[] = []
  const validAll: number[] = []
  let warmed = false
  let poseIndex = -1

  try {
    for (const w of windows) {
      if (signal.aborted) return result
      const world = new World({ index, coarse, origin: w.origin, renderer, legs: routes.legs })
      try {
        for (const ep of w.poses) {
          poseIndex++
          if (signal.aborted) return result
          hooks.onProgress(`Pose ${poseIndex + 1} of ${total}: ${ep.id} (loading the ground around it)`)
          const at = poseLocal(ep, w)
          const head: Pose = { x: at.x, y: at.y, z: 0, headingDeg: ep.headingDeg, pitchDeg: ep.pitchDeg }
          if (!(await settle(world, head, signal))) {
            if (signal.aborted) return result
            skipped.push(`${ep.id}: the ground did not load in time`)
            continue
          }
          // never stand inside a rock: step back along the view direction
          const back = headingToDir(ep.headingDeg)
          let moved = false
          for (let k = 0; k < 6 && world.rocks.field.rocksNear(head.x, head.y, 0.7).some((r) => r.h * (1 - BURY) > 0.2); k++) {
            head.x -= back.x
            head.y -= back.y
            moved = true
          }
          if (moved && !(await settle(world, head, signal))) {
            if (signal.aborted) return result
            skipped.push(`${ep.id}: the ground did not load in time`)
            continue
          }
          head.z = world.heights.heightAt(head.x, head.y) + EYE_M
          world.update(head)

          const frame = rig.capture(world.scene, head)
          const left = frame.pose
          const rgba = rig.leftRgba.slice()
          probe.render(world.scene, left, zAll)
          const rocksGroup = world.scene.getObjectByName('rocks')
          if (rocksGroup) rocksGroup.visible = false
          probe.render(world.scene, left, zTerrain)
          if (rocksGroup) rocksGroup.visible = true

          if (!warmed) {
            // let the JIT see the code before anything is timed
            const warm = createCvPipeline(intr, { sandHook: createSandHook({ persistFrames: 1 }) })
            for (let k = 0; k < 3; k++) runFrame(warm, cloneFrame(frame))
            warmed = true
          }
          const res = runFrame(pipeline, frame)

          // rocks
          const truth = truthRocks(world, left, intr)
          const score = scoreRocks(truth.visible, truth.nearby, res.detections)
          const cells = scoreRockCells(truth.visible, truth.nearby, res.patch, left)
          truth.visible.forEach((r, k) => rockTruth.push({ standM: r.standM, dist: Math.hypot(r.x - left.x, r.y - left.y), found: score.foundFlags[k], onMap: cells.foundFlags[k] }))
          rockCells += cells.cells
          rockCellsTrue += cells.cellsTrue
          dets += score.detections
          detsTrue += score.detectionsTrue
          falseOnLow += score.onLowRock

          // depth
          const poseRel5: number[] = []
          let valid = 0
          for (let i = 0; i < N; i++) {
            const d = res.disparity[i]
            if (!(d > 0)) continue
            valid++
            const zt = zAll[i]
            if (zt >= DEPTH_FAR_M - 0.01) continue
            const e = (fb / d - zt) / zt
            if (zt >= 4 && zt < 6) {
              all5N++
              all5Abs += Math.abs(e)
            }
            if (Math.abs(zt - zTerrain[i]) > 0.002 * zt) continue // a rock, not ground
            for (let b = 0; b < DEPTH_BINS.length; b++) {
              if (zt >= DEPTH_BINS[b][0] && zt < DEPTH_BINS[b][1]) {
                binN[b]++
                binAbs[b] += Math.abs(e)
                binSigned[b] += e
                if (b === 1) {
                  rel5.push(e)
                  poseRel5.push(Math.abs(e))
                }
                break
              }
            }
          }

          // slope
          const sl = pipeline.slope
          const B = sl.opts.blockM
          const { x0, y0 } = pipeline.ground.patch
          const poseSlope: number[] = []
          for (let b = 0; b < sl.blocksX * sl.blocksY; b++) {
            const raw = sl.slopeRaw[b]
            const cv = sl.slope[b]
            if (!Number.isFinite(raw) && !Number.isFinite(cv)) continue
            const br = (b / sl.blocksX) | 0
            const t = world.heights.slopeAt(x0 + (b - br * sl.blocksX + 0.5) * B, y0 - (br + 0.5) * B)
            if (Number.isFinite(raw)) slopeErrRaw.push(raw - t)
            if (Number.isFinite(cv)) {
              slopeErr.push(cv - t)
              poseSlope.push(cv - t)
              ;(t < 10 ? slopeErrLow : slopeErrHigh).push(cv - t)
            }
          }

          // sand: one row per judged patch
          const sc = sandHook.context()
          const patches: PoseView['patches'] = []
          let sandRows = 0, sandTrue = 0
          if (sc) {
            const lookup = sandLookup(world)
            const cnt = new Int32Array(sc.n)
            const onSand = new Int32Array(sc.n)
            const { cloud, ground } = pipeline
            for (let i = 0; i < cloud.n; i++) {
              const p = patchOfPixel(sc, cloud.pix[i])
              if (p < 0 || !sc.ok[p] || ground.cellOf[i] < 0 || !(Math.abs(ground.hag[i]) <= sc.opts.groundTolM)) continue
              const s = lookup(cloud.xyz[i * 3], cloud.xyz[i * 3 + 1])
              if (s < 0) continue
              cnt[p]++
              onSand[p] += s
            }
            for (let p = 0; p < sc.n; p++) {
              if (!sc.ok[p] || cnt[p] < 4) continue
              const share = onSand[p] / cnt[p]
              for (let k = 0; k < SAND_NF; k++) sandData.X.push(sc.feat[p * SAND_NF + k])
              sandData.y.push(share >= 0.5 ? 1 : 0)
              sandData.pose.push(poseIndex)
              sandData.share.push(share)
              patches.push({ index: p, prob: sc.prob[p], sand: share >= 0.5 })
              sandRows++
              if (share >= 0.5) sandTrue++
            }
          }

          msAll.push(res.ms)
          validAll.push(valid / N)
          const rec: PoseRecord = {
            id: ep.id,
            window: ep.window,
            kind: ep.kind,
            x: head.x,
            y: head.y,
            headingDeg: ep.headingDeg,
            pitchDeg: ep.pitchDeg,
            fine: !world.coarseAt(head.x, head.y),
            truthRocks: score.truth,
            foundRocks: score.found,
            detections: score.detections,
            detectionsTrue: score.detectionsTrue,
            depthRel5m: median(poseRel5),
            slopeRmsDeg: rms(poseSlope),
            slopeBlocks: poseSlope.length,
            validShare: valid / N,
            ms: res.ms,
            sandPatches: sandRows,
            sandTruthShare: sandRows ? sandTrue / sandRows : 0,
            sandDetections: res.detections.filter((d) => d.kind === 'sand').length,
          }
          perPose.push(rec)
          hooks.onPose(rec, {
            width: intr.width,
            height: intr.height,
            rgba,
            detections: res.detections,
            rocks: truth.visible.map((r, k) => ({ u: truth.pixels[k].u, v: truth.pixels[k].v, found: score.foundFlags[k], standM: r.standM })),
            patches,
            patchPx: sc?.opts.patchPx ?? 16,
            patchCols: sc?.pw ?? 0,
            debug: { disparity: res.disparity, zAll: zAll.slice(), zTerrain: zTerrain.slice(), fb, left: frame.left, right: frame.right, pose: left },
          })
          await tick()
        }
      } finally {
        world.dispose()
      }
    }

    // sand: train on two poses in three, test on the third
    hooks.onProgress('Training the sand classifier…')
    await tick()
    const held = (i: number) => sandData.pose[i] % 3 === 2
    const train = (i: number) => !held(i)
    const trained = trainLogistic(sandData.X, sandData.y, SAND_NF, train, { threshold: SAND_THRESHOLD })
    const pShipped = predict(sandData.X, SAND_NF, SAND_WEIGHTS)
    const pTrained = predict(sandData.X, SAND_NF, trained)

    const found = rockTruth.filter((r) => r.found).length
    const onMap = rockTruth.filter((r) => r.onMap).length
    const by = (key: 'standM' | 'dist', edges: number[]) =>
      edges.slice(0, -1).map((from, k) => {
        const inBin = rockTruth.filter((r) => r[key] >= from && r[key] < edges[k + 1])
        const f = inBin.filter((r) => r.found).length
        const m = inBin.filter((r) => r.onMap).length
        return { from, to: edges[k + 1], truth: inBin.length, found: f, recall: inBin.length ? f / inBin.length : NaN, onMap: m, recallOnMap: inBin.length ? m / inBin.length : NaN }
      })
    result.metrics = {
      poses: total,
      posesRun: perPose.length,
      skipped,
      rocks: {
        truth: rockTruth.length,
        found,
        recall: rockTruth.length ? found / rockTruth.length : NaN,
        detections: dets,
        detectionsTrue: detsTrue,
        precision: dets ? detsTrue / dets : NaN,
        falseOnLowRock: falseOnLow,
        onMap: {
          found: onMap,
          recall: rockTruth.length ? onMap / rockTruth.length : NaN,
          cells: rockCells,
          cellsTrue: rockCellsTrue,
          precision: rockCells ? rockCellsTrue / rockCells : NaN,
        },
        byHeight: by('standM', [0.3, 0.4, 0.6, 2]),
        byDistance: by('dist', [2, 4, 6, 8, 10, 12.001]),
      },
      depth: {
        n: rel5.length,
        medianRel: median(rel5.map(Math.abs)),
        meanRel: mean(rel5.map(Math.abs)),
        biasRel: mean(rel5),
        allPixels: { n: all5N, meanRel: all5N ? all5Abs / all5N : NaN },
        bins: DEPTH_BINS.map(([from, to], b) => ({ from, to, n: binN[b], meanRel: binN[b] ? binAbs[b] / binN[b] : NaN, biasRel: binN[b] ? binSigned[b] / binN[b] : NaN })),
      },
      slope: {
        blocks: slopeErr.length,
        rmsDeg: rms(slopeErr),
        biasDeg: mean(slopeErr),
        rmsRawDeg: rms(slopeErrRaw),
        rawBlocks: slopeErrRaw.length,
        rmsUnder10: rms(slopeErrLow),
        rmsOver10: rms(slopeErrHigh),
      },
      sand: {
        patches: sandData.y.length,
        truthShare: mean(sandData.y),
        heldOutRule: 'pose index mod 3 = 2 (20 of 60 poses); trained on the other 40',
        features: SAND_FEATURES,
        shipped: { weights: SAND_WEIGHTS, train: prf(pShipped, sandData.y, SAND_THRESHOLD, train), heldOut: prf(pShipped, sandData.y, SAND_THRESHOLD, held) },
        trained: { weights: trained, train: prf(pTrained, sandData.y, SAND_THRESHOLD, train), heldOut: prf(pTrained, sandData.y, SAND_THRESHOLD, held) },
      },
      cvMs: { mean: mean(msAll), median: median(msAll), max: Math.max(...msAll) },
      validShare: mean(validAll),
      seconds: (performance.now() - started) / 1000,
    }
    result.done = true
    hooks.onProgress(`Done: ${perPose.length} of ${total} poses in ${result.metrics.seconds.toFixed(0)} s.`)
    return result
  } finally {
    probe.dispose()
    rig.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}
