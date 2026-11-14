// One CV frame, start to finish (docs/helmet/PLAN.md §4 per-frame flow, §5): stereo pair → CvResult.
//
// disparity (stereo.ts) → back-projection to local ENU (points.ts) → local ground (ground.ts) → rocks
// (obstacles.ts) → steep slopes (slope.ts) → sand (hook, see below) → drop-offs (drop.ts, on this frame's
// per-cell ground heights). Every stage writes into contexts created once, so a frame allocates nothing
// but its result: the disparity map and the hazard patch are copied out (the contexts reuse their buffers
// on the next frame, and the worker transfers the copies to the main thread).
//
// Pure TypeScript, no DOM: the worker (worker.ts) runs it in the browser, the tests run it in Node.
import type { CvFrame, CvResult, Detection, StereoIntrinsics } from '../contracts.ts'
import { createDropContext, detectDrops, fillFromFused, groundCellHeights, mergeDrops, type DropContext, type DropOptions, type HeightGrid } from './drop.ts'
import { createGroundContext, fitGround, type GroundContext, type GroundOptions } from './ground.ts'
import { createObstacleContext, detectObstacles, type ObstacleContext, type ObstacleOptions } from './obstacles.ts'
import { MAX_POINTS, backProject, createPointCloud, type PointCloud } from './points.ts'
import { createSlopeContext, detectSlopes, type SlopeContext, type SlopeOptions } from './slope.ts'
import { computeDisparity, createStereoContext, type StereoContext, type StereoOptions } from './stereo.ts'

/**
 * Sand / loose-ground stage (T5.2, PLAN §5.5), called after the slopes and before the drops. It may paint
 * HAZARD.sand cells into `p.ground.patch` (never over rock, steep or drop) and returns its Detections.
 * Until the classifier exists the pipeline uses `noSand`, which finds nothing.
 */
export type SandHook = (frame: CvFrame, p: CvPipeline) => Detection[]

export const noSand: SandHook = () => []

/** Tuning of every stage; JSON-safe, so the worker can receive it in a config message. */
export interface CvPipelineConfig {
  stereo?: Partial<StereoOptions>
  ground?: Partial<GroundOptions>
  obstacles?: Partial<ObstacleOptions>
  slope?: Partial<SlopeOptions>
  drop?: Partial<DropOptions>
  /** Points kept per frame (≤ the cloud's capacity, MAX_POINTS by default). */
  maxPoints?: number
}

export interface CvPipelineOptions extends CvPipelineConfig {
  sandHook?: SandHook
}

export interface CvPipeline {
  readonly opts: CvPipelineOptions
  /** Intrinsics the contexts were built for. */
  intr: StereoIntrinsics
  stereo: StereoContext
  cloud: PointCloud
  ground: GroundContext
  obstacles: ObstacleContext
  slope: SlopeContext
  drop: DropContext
  /** This frame's per-cell ground heights (drop.ts input), aligned with ground.patch. */
  heights: HeightGrid
  /** Frames run so far. */
  frames: number
}

const sameIntrinsics = (a: StereoIntrinsics, b: StereoIntrinsics) =>
  a.width === b.width && a.height === b.height && a.fx === b.fx && a.fy === b.fy &&
  a.cx === b.cx && a.cy === b.cy && a.baselineM === b.baselineM

export function createCvPipeline(intr: StereoIntrinsics, opts: CvPipelineOptions = {}): CvPipeline {
  const cloud = createPointCloud(Math.max(1, opts.maxPoints ?? MAX_POINTS))
  const ground = createGroundContext(cloud.capacity, opts.ground)
  return {
    opts,
    intr: { ...intr },
    stereo: createStereoContext(intr, opts.stereo),
    cloud,
    ground,
    obstacles: createObstacleContext(ground, opts.obstacles),
    slope: createSlopeContext(ground, opts.slope),
    drop: createDropContext(ground.nCells, opts.drop),
    heights: { x0: 0, y0: 0, cols: ground.cols, rows: ground.rows, z: new Float32Array(ground.nCells) },
    frames: 0,
  }
}

/** Rebuild the contexts in place for new intrinsics (a resized CV camera, or the real Navcam pair). */
function rebuild(p: CvPipeline, intr: StereoIntrinsics): void {
  const fresh = createCvPipeline(intr, p.opts)
  p.intr = fresh.intr
  p.stereo = fresh.stereo
  p.cloud = fresh.cloud
  p.ground = fresh.ground
  p.obstacles = fresh.obstacles
  p.slope = fresh.slope
  p.drop = fresh.drop
  p.heights = fresh.heights
}

/**
 * Run the whole chain on one rectified stereo frame. The returned disparity and patch buffers are
 * copies the caller owns (safe to transfer); the pipeline's contexts keep their own.
 */
export function runFrame(p: CvPipeline, frame: CvFrame): CvResult {
  const t0 = performance.now()
  const { intr, pose } = frame
  if (!sameIntrinsics(p.intr, intr)) rebuild(p, intr)

  const disparity = computeDisparity(p.stereo, frame.left, frame.right)
  backProject(disparity, intr, pose, p.cloud)
  fitGround(p.ground, p.cloud, pose)
  const rocks = detectObstacles(p.obstacles, p.ground, p.cloud, intr, pose)
  const slopes = detectSlopes(p.slope, p.ground, p.cloud, pose)
  const sand = (p.opts.sandHook ?? noSand)(frame, p)
  groundCellHeights(p.ground, p.cloud, pose, p.heights, p.drop.opts)
  // what this frame saw of the ground goes back to the fused grid; the drop rule then also uses what earlier
  // frames saw (a lip and the ground below it are rarely in one frame from 1.65 m)
  const groundZ = p.heights.z.slice(0, p.ground.nCells)
  if (frame.heights) fillFromFused(p.heights, frame.heights)
  const drops = detectDrops(p.drop, p.heights, pose)
  mergeDrops(p.drop, p.heights, p.ground.patch)
  p.frames++

  const patch = p.ground.patch
  const result: CvResult = {
    id: frame.id,
    ms: 0,
    disparity: disparity.slice(),
    detections: [...rocks, ...slopes, ...sand, ...drops],
    patch: { x0: patch.x0, y0: patch.y0, cols: patch.cols, rows: patch.rows, cls: patch.cls.slice(), conf: patch.conf.slice() },
    groundZ,
  }
  result.ms = performance.now() - t0
  return result
}
