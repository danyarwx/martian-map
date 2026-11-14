// Local ground model from one frame's points (docs/helmet/PLAN.md §5.2).
//
// 1. Bin the points into the 0.5 m cells of a hazard patch aligned to the hazard grid (frames.gridIndex
//    convention: col = floor((x − x0)/0.5), row = floor((y0 − y)/0.5), row 0 north).
// 2. Ground candidate per cell = the point at the 20th percentile of height: rocks and rock sides sit
//    above the ground, so a low percentile picks the ground under them, while the minimum would pick noise.
// 3. RANSAC plane per 4 × 4 m block on those candidates (0.08 m threshold, 60 iterations, seeded RNG so a
//    frame always gives the same answer), refined by least squares on the inliers.
// 4. Ground height anywhere = bilinear blend of the neighbouring blocks' planes, which smooths the steps
//    between blocks. Height above ground per point = z − ground(x, y).
//
// The patch is 68 m square around the camera (17 blocks), so it holds every point up to the 25 m depth
// limit and ±35° of the field of view. Its corner snaps to the 4 m block lattice of the local frame, so
// cells and blocks line up between frames and with the hazard grid.
import type { HazardPatch, Pose } from '../contracts.ts'
import { GRID_CELL_M } from '../frames.ts'
import type { PointCloud } from './points.ts'

export interface GroundOptions {
  /** Cell size, metres: the hazard grid's. */
  cellM: number
  /** RANSAC block size, metres (a whole number of cells). */
  blockM: number
  /** Patch side, metres (a whole number of blocks). */
  patchSizeM: number
  /** Height percentile taken as a cell's ground candidate, 0..1. */
  percentile: number
  ransacThresholdM: number
  ransacIterations: number
  /** Planes steeper than this are not ground (a rock face, a wall). */
  maxPlaneSlopeDeg: number
  /** A block's plane needs at least this many inlier candidates. */
  minInliers: number
  /** RANSAC samples whose triangle covers less ground than this (m²) are skipped. */
  minSampleAreaM2: number
  /** The inliers' smallest horizontal standard deviation must reach this, metres. */
  minSpreadM: number
  seed: number
}

export const GROUND_DEFAULTS: GroundOptions = {
  cellM: GRID_CELL_M,
  blockM: 4,
  patchSizeM: 68,
  percentile: 0.2,
  ransacThresholdM: 0.08,
  ransacIterations: 60,
  maxPlaneSlopeDeg: 45,
  minInliers: 4,
  minSampleAreaM2: 0.05,
  minSpreadM: 0.25,
  seed: 0x5eed,
}

export interface GroundContext {
  readonly opts: GroundOptions
  readonly cols: number
  readonly rows: number
  readonly nCells: number
  /** Cells per block side. */
  readonly cpb: number
  readonly blocksX: number
  readonly blocksY: number
  /** The frame's hazard patch: geometry set by fitGround, classes filled by obstacles.ts and slope.ts. */
  readonly patch: HazardPatch
  /** Per point: its cell, or −1 outside the patch. */
  readonly cellOf: Int32Array
  /** Points of cell c are order[cellStart[c] .. cellStart[c + 1]). */
  readonly cellStart: Int32Array
  readonly order: Int32Array
  /** Per cell: index of its ground-candidate point, or −1. */
  readonly candidate: Int32Array
  /** Per block: z = a·(x − bx) + b·(y − by) + c about the block centre (bx, by). */
  readonly plane: Float64Array
  readonly planeOk: Uint8Array
  /** Per cell: ground height at the cell centre, NaN where no plane is near. */
  readonly groundZ: Float32Array
  /** Per point: height above the local ground, NaN where unknown. */
  readonly hag: Float32Array
  readonly cursor: Int32Array
  readonly blockPts: Int32Array
  readonly inlier: Uint8Array
  readonly bestInlier: Uint8Array
}

export function createGroundContext(capacity: number, opts: Partial<GroundOptions> = {}): GroundContext {
  const o = { ...GROUND_DEFAULTS, ...opts }
  const cpb = Math.round(o.blockM / o.cellM)
  const blocks = Math.round(o.patchSizeM / o.blockM)
  if (Math.abs(cpb * o.cellM - o.blockM) > 1e-9 || Math.abs(blocks * o.blockM - o.patchSizeM) > 1e-9)
    throw new Error('blockM must be a multiple of cellM and patchSizeM a multiple of blockM')
  const cols = cpb * blocks
  const rows = cols
  const nCells = cols * rows
  const nBlocks = blocks * blocks
  return {
    opts: o,
    cols,
    rows,
    nCells,
    cpb,
    blocksX: blocks,
    blocksY: blocks,
    patch: { x0: 0, y0: 0, cols, rows, cls: new Uint8Array(nCells), conf: new Float32Array(nCells) },
    cellOf: new Int32Array(capacity),
    cellStart: new Int32Array(nCells + 1),
    order: new Int32Array(capacity),
    candidate: new Int32Array(nCells),
    plane: new Float64Array(nBlocks * 3),
    planeOk: new Uint8Array(nBlocks),
    groundZ: new Float32Array(nCells),
    hag: new Float32Array(capacity),
    cursor: new Int32Array(nCells),
    blockPts: new Int32Array(cpb * cpb),
    inlier: new Uint8Array(cpb * cpb),
    bestInlier: new Uint8Array(cpb * cpb),
  }
}

/** Mulberry32 state step: returns the next state; the value is derived by `rand01`. */
function rand01(state: Uint32Array): number {
  let a = (state[0] = (state[0] + 0x6d2b79f5) >>> 0)
  a = Math.imul(a ^ (a >>> 15), a | 1)
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61)
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296
}

/** In-place quickselect on order[lo..hi] by point height: afterwards order[k] holds the k-th lowest. */
function selectByZ(order: Int32Array, xyz: Float32Array, lo: number, hi: number, k: number): void {
  while (hi > lo) {
    const pivot = xyz[order[(lo + hi) >> 1] * 3 + 2]
    let i = lo
    let j = hi
    while (i <= j) {
      while (xyz[order[i] * 3 + 2] < pivot) i++
      while (xyz[order[j] * 3 + 2] > pivot) j--
      if (i <= j) {
        const t = order[i]
        order[i] = order[j]
        order[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return
  }
}

/**
 * Least-squares plane z = a·x + b·y + c through the flagged points (coordinates about (bx, by)).
 * False when the points do not spread over an area (smallest horizontal standard deviation below
 * `minSpread`): points along a line, such as the ground seen along the image border, leave the
 * plane free to turn about that line.
 */
function lsq(
  xyz: Float32Array,
  pts: Int32Array,
  flags: Uint8Array,
  n: number,
  bx: number,
  by: number,
  out: Float64Array,
  o: number,
  minSpread: number,
): boolean {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0, m = 0
  for (let i = 0; i < n; i++) {
    if (!flags[i]) continue
    const p = pts[i] * 3
    const x = xyz[p] - bx
    const y = xyz[p + 1] - by
    const z = xyz[p + 2]
    sxx += x * x
    sxy += x * y
    syy += y * y
    sx += x
    sy += y
    sz += z
    sxz += x * z
    syz += y * z
    m++
  }
  if (m < 3) return false
  const mx = sx / m
  const my = sy / m
  const cxx = sxx / m - mx * mx
  const cyy = syy / m - my * my
  const cxy = sxy / m - mx * my
  const lambdaMin = (cxx + cyy) / 2 - Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy)
  if (lambdaMin < minSpread * minSpread) return false
  return solve3(sxx, sxy, sx, sxy, syy, sy, sx, sy, m, sxz, syz, sz, out, o)
}

/** Solve the symmetric 3 × 3 system [[a b c][d e f][g h i]]·s = (p, q, r) by Cramer's rule. */
export function solve3(
  a: number, b: number, c: number,
  d: number, e: number, f: number,
  g: number, h: number, i: number,
  p: number, q: number, r: number,
  out: Float64Array, o: number,
): boolean {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  const scale = Math.abs(a * e * i) + Math.abs(b * f * g) + Math.abs(c * d * h) + 1e-300
  if (Math.abs(det) < 1e-12 * scale) return false
  out[o] = (p * (e * i - f * h) - b * (q * i - f * r) + c * (q * h - e * r)) / det
  out[o + 1] = (a * (q * i - f * r) - p * (d * i - f * g) + c * (d * r - q * g)) / det
  out[o + 2] = (a * (e * r - q * h) - b * (d * r - q * g) + p * (d * h - e * g)) / det
  return true
}

const rngState = new Uint32Array(1)

/** Fit one block's plane by RANSAC + least squares; returns whether it is usable. */
function fitBlock(ctx: GroundContext, xyz: Float32Array, n: number, bx: number, by: number, blk: number): boolean {
  const { blockPts: pts, inlier, bestInlier, plane, opts } = ctx
  if (n < 3) return false
  const thr = opts.ransacThresholdM
  const minNz = Math.cos((opts.maxPlaneSlopeDeg * Math.PI) / 180)
  let bestCount = 0
  let bestErr = Infinity
  for (let it = 0; it < opts.ransacIterations; it++) {
    const i = Math.floor(rand01(rngState) * n)
    let j = Math.floor(rand01(rngState) * (n - 1))
    if (j >= i) j++
    let k = Math.floor(rand01(rngState) * (n - 2))
    if (k >= Math.min(i, j)) k++
    if (k >= Math.max(i, j)) k++
    const p1 = pts[i] * 3
    const p2 = pts[j] * 3
    const p3 = pts[k] * 3
    const ux = xyz[p2] - xyz[p1], uy = xyz[p2 + 1] - xyz[p1 + 1], uz = xyz[p2 + 2] - xyz[p1 + 2]
    const vx = xyz[p3] - xyz[p1], vy = xyz[p3 + 1] - xyz[p1 + 1], vz = xyz[p3 + 2] - xyz[p1 + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    // |nz| is twice the sample triangle's horizontal area: thin triangles give unstable planes.
    if (Math.abs(nz) < 2 * opts.minSampleAreaM2) continue
    const len = Math.hypot(nx, ny, nz)
    nx /= len
    ny /= len
    nz /= len
    if (nz < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    if (nz < minNz) continue // too steep to be ground
    const d0 = nx * xyz[p1] + ny * xyz[p1 + 1] + nz * xyz[p1 + 2]
    let count = 0
    let err = 0
    for (let m = 0; m < n; m++) {
      const q = pts[m] * 3
      const dist = Math.abs(nx * xyz[q] + ny * xyz[q + 1] + nz * xyz[q + 2] - d0)
      if (dist < thr) {
        inlier[m] = 1
        count++
        err += dist
      } else inlier[m] = 0
    }
    if (count > bestCount || (count === bestCount && err < bestErr)) {
      bestCount = count
      bestErr = err
      for (let m = 0; m < n; m++) bestInlier[m] = inlier[m]
    }
    if (count === n) break
  }
  if (bestCount < Math.min(opts.minInliers, n)) return false
  const o = blk * 3
  if (!lsq(xyz, pts, bestInlier, n, bx, by, plane, o, opts.minSpreadM)) return false
  return Math.hypot(plane[o], plane[o + 1]) <= Math.tan((opts.maxPlaneSlopeDeg * Math.PI) / 180) // nor the refit
}

/**
 * Fit the ground for one frame: sets the patch geometry around `pose`, clears its classes, bins the
 * points, fits the block planes, and fills `groundZ` per cell and `hag` per point.
 */
export function fitGround(ctx: GroundContext, cloud: PointCloud, pose: Pose): void {
  const { opts, cols, rows, nCells, cpb, blocksX, blocksY, patch, cellOf, cellStart, order, candidate, cursor } = ctx
  const { cellM, blockM } = opts
  const xyz = cloud.xyz
  const n = cloud.n

  // Patch corner on the block lattice, camera block in the middle.
  const half = Math.floor(blocksX / 2)
  patch.x0 = (Math.floor(pose.x / blockM) - half) * blockM
  patch.y0 = (Math.floor(pose.y / blockM) + 1 + half) * blockM
  patch.cls.fill(0)
  patch.conf.fill(0)
  const { x0, y0 } = patch

  // 1. Counting sort of the points by cell (inlined frames.gridIndex: this loop runs per point).
  cellStart.fill(0)
  for (let i = 0; i < n; i++) {
    const col = Math.floor((xyz[i * 3] - x0) / cellM)
    const row = Math.floor((y0 - xyz[i * 3 + 1]) / cellM)
    const c = col >= 0 && col < cols && row >= 0 && row < rows ? row * cols + col : -1
    cellOf[i] = c
    if (c >= 0) cellStart[c + 1]++
  }
  for (let c = 0; c < nCells; c++) cellStart[c + 1] += cellStart[c]
  cursor.set(cellStart.subarray(0, nCells))
  for (let i = 0; i < n; i++) {
    const c = cellOf[i]
    if (c >= 0) order[cursor[c]++] = i
  }

  // 2. Ground candidate per cell.
  for (let c = 0; c < nCells; c++) {
    const lo = cellStart[c]
    const hi = cellStart[c + 1] - 1
    if (hi < lo) {
      candidate[c] = -1
      continue
    }
    const k = lo + Math.floor(opts.percentile * (hi - lo))
    selectByZ(order, xyz, lo, hi, k)
    candidate[c] = order[k]
  }

  // 3. One plane per block.
  rngState[0] = opts.seed
  for (let br = 0; br < blocksY; br++)
    for (let bc = 0; bc < blocksX; bc++) {
      let m = 0
      for (let r = br * cpb; r < (br + 1) * cpb; r++)
        for (let c = bc * cpb; c < (bc + 1) * cpb; c++) {
          const p = candidate[r * cols + c]
          if (p >= 0) ctx.blockPts[m++] = p
        }
      const blk = br * blocksX + bc
      ctx.planeOk[blk] = fitBlock(ctx, xyz, m, x0 + (bc + 0.5) * blockM, y0 - (br + 0.5) * blockM, blk) ? 1 : 0
    }

  // 4. Ground height per cell centre and per point.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) ctx.groundZ[r * cols + c] = groundAt(ctx, x0 + (c + 0.5) * cellM, y0 - (r + 0.5) * cellM)
  for (let i = 0; i < n; i++) {
    const o = i * 3
    ctx.hag[i] = cellOf[i] >= 0 ? xyz[o + 2] - groundAt(ctx, xyz[o], xyz[o + 1]) : NaN
  }
}

/**
 * Ground height at local (x, y) from the last fit: the planes of the up to four blocks whose centres
 * surround the point, each evaluated at the point and blended bilinearly. NaN when none of them has a plane.
 */
export function groundAt(ctx: GroundContext, x: number, y: number): number {
  const { blockM } = ctx.opts
  const { x0, y0 } = ctx.patch
  const gx = (x - x0) / blockM - 0.5
  const gy = (y0 - y) / blockM - 0.5
  const i0 = Math.floor(gx)
  const j0 = Math.floor(gy)
  const tx = gx - i0
  const ty = gy - j0
  let sw = 0
  let sz = 0
  for (let dj = 0; dj <= 1; dj++) {
    const j = j0 + dj
    if (j < 0 || j >= ctx.blocksY) continue
    const wy = dj ? ty : 1 - ty
    for (let di = 0; di <= 1; di++) {
      const i = i0 + di
      if (i < 0 || i >= ctx.blocksX) continue
      const blk = j * ctx.blocksX + i
      if (!ctx.planeOk[blk]) continue
      const w = (di ? tx : 1 - tx) * wy
      if (w <= 0) continue
      const bx = x0 + (i + 0.5) * blockM
      const by = y0 - (j + 0.5) * blockM
      const o = blk * 3
      sz += w * (ctx.plane[o] * (x - bx) + ctx.plane[o + 1] * (y - by) + ctx.plane[o + 2])
      sw += w
    }
  }
  return sw > 0 ? sz / sw : NaN
}

/** Slope of block `blk`'s plane, degrees, or NaN when it has none. */
export function blockSlopeDeg(ctx: GroundContext, blk: number): number {
  if (!ctx.planeOk[blk]) return NaN
  return (Math.atan(Math.hypot(ctx.plane[blk * 3], ctx.plane[blk * 3 + 1])) * 180) / Math.PI
}
