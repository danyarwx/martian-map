// Far terrain of the helmet world (docs/helmet/PLAN.md §6.2): the 10 m grid out to 4 km from the session origin as
// ONE mesh with vertex colours and no texture, so the hills on the horizon are the real ones.
//
// Vertex spacing is 20 m (every second grid cell) out to 1.5 km, then 40 m to 3 km and 80 m beyond, which keeps the
// mesh under ~80 k triangles; where a finer block meets a coarser one, the finer block's edge vertices are put on
// the coarser edge so no crack opens. Cells without elevation data are skipped (the mesh simply ends there).
//
// The mesh lies FAR_DROP_M below the grid, and sinks a further FAR_SINK_M in a disc around the player while the
// near tiles there are built, so it never pokes through the 1 m tiles it overlaps. It is built once: the session
// origin does not move.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import { localToThree, toLocal } from '../frames.ts'
import type { CoarseGrid } from './heightField.ts'
import { hash2 } from './noise.ts'
import { FLAT, STEEP } from './terrainMesh.ts'

/** The far terrain reaches this far from the session origin, metres. */
export const FAR_RADIUS_M = 4000
/** The whole mesh lies this far below the 10 m grid, metres. */
export const FAR_DROP_M = 2
/** Extra drop inside the hole around the player, metres. */
export const FAR_SINK_M = 40
/** Radius of the hole around the player, metres. Near tiles are loaded out to 400 m (tiles.ts LOAD_M). */
export const FAR_HOLE_M = 320
/** Width of the ramp from the sunken disc back up to the mesh, metres. */
const FAR_HOLE_RAMP_M = 80

/**
 * Brightness of the far terrain against the coarse near tiles' colours. The tinted HiRISE ortho of the real near
 * tiles renders darker than those, and most ground next to the far terrain is real tiles; picked by eye.
 */
const FAR_ALBEDO = 0.75

/** Blocks of this many grid cells share one vertex spacing. Every stride divides it. */
const BLOCK = 8

export interface FarRing {
  /** Blocks whose centre is nearer than this to the origin, metres… */
  toM: number
  /** …have a vertex every `stride` grid cells (10 m each). */
  stride: 2 | 4 | 8
}

export const FAR_RINGS: FarRing[] = [
  { toM: 1500, stride: 2 },
  { toM: 3000, stride: 4 },
  { toM: Infinity, stride: 8 },
]

export interface FarGeometryData {
  /** three.js world coordinates, FAR_DROP_M not applied. */
  position: Float32Array
  normal: Float32Array
  /** Linear RGB. */
  color: Float32Array
  index: Uint32Array
  vertices: number
  triangles: number
}

/**
 * Vertices and triangles of the far terrain. Pure (no WebGL), so it runs in Node tests.
 * Vertices sit on the centres of 10 m grid cells.
 */
export function buildFarGeometryData(
  coarse: CoarseGrid,
  origin: LatLon,
  radiusM: number = FAR_RADIUS_M,
  rings: FarRing[] = FAR_RINGS,
): FarGeometryData {
  const m = coarse.meta
  const w = m.width
  const h = m.height
  const e = coarse.elevM
  const degLon = (m.east - m.west) / w
  const degLat = (m.north - m.south) / h
  // local ENU of the centre of cell (0, 0) and the step per cell
  const p00 = toLocal({ lat: m.north - 0.5 * degLat, lon: m.west + 0.5 * degLon }, origin)
  const p11 = toLocal({ lat: m.north - 1.5 * degLat, lon: m.west + 1.5 * degLon }, origin)
  const dx = p11.x - p00.x // metres per column, east
  const dy = p00.y - p11.y // metres per row, south

  const blockRows = Math.floor((h - 1) / BLOCK)
  const blockCols = Math.floor((w - 1) / BLOCK)

  /** Vertex spacing of block (br, bc) in cells, or 0 when the block is not part of the mesh. */
  const strideOf = (br: number, bc: number): number => {
    if (br < 0 || bc < 0 || br >= blockRows || bc >= blockCols) return 0
    const x = p00.x + (bc * BLOCK + BLOCK / 2) * dx
    const y = p00.y - (br * BLOCK + BLOCK / 2) * dy
    const d = Math.hypot(x, y)
    if (d > radiusM) return 0
    for (const r of rings) if (d < r.toM) return r.stride
    return rings[rings.length - 1].stride
  }

  const elev = (r: number, c: number): number => e[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))]

  /** Height between the two vertices of a coarser neighbour, `s` cells apart, along a shared edge. */
  const onCoarseEdge = (i: number, s: number, at: (k: number) => number): number => {
    const i0 = Math.floor(i / s) * s
    return at(i0) + ((at(i0 + s) - at(i0)) * (i - i0)) / s
  }

  const pos: number[] = []
  const nor: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const vertexOf = new Int32Array(w * h).fill(-1)
  const c3 = new THREE.Color()

  const vertex = (r: number, c: number, s: number, br: number, bc: number): number => {
    const key = r * w + c
    if (vertexOf[key] >= 0) return vertexOf[key]
    const r0 = br * BLOCK
    const c0 = bc * BLOCK
    const i = r - r0
    const j = c - c0
    let z = e[key]
    // On an edge shared with a coarser block, lie on that block's edge (no crack). Corners are never moved.
    if ((j === 0 || j === BLOCK) && i % BLOCK !== 0) {
      const ns = strideOf(br, j === 0 ? bc - 1 : bc + 1)
      if (ns > s && i % ns !== 0) z = onCoarseEdge(i, ns, (k) => e[(r0 + k) * w + c])
    } else if ((i === 0 || i === BLOCK) && j % BLOCK !== 0) {
      const ns = strideOf(i === 0 ? br - 1 : br + 1, bc)
      if (ns > s && j % ns !== 0) z = onCoarseEdge(j, ns, (k) => e[r * w + c0 + k])
    }
    const x = p00.x + c * dx
    const y = p00.y - r * dy
    const p = localToThree({ x, y, z })
    pos.push(p.x, p.y, p.z)
    // shading normal over the mesh's own spacing
    const gx = (elev(r, c + s) - elev(r, c - s)) / ((Math.min(w - 1, c + s) - Math.max(0, c - s)) * dx)
    const gy = (elev(r - s, c) - elev(r + s, c)) / ((Math.min(h - 1, r + s) - Math.max(0, r - s)) * dy) // north positive
    const len = Math.hypot(gx, gy, 1)
    const n = localToThree({ x: -gx / len, y: -gy / len, z: 1 / len })
    nor.push(n.x, n.y, n.z)
    // colour from the slope of the 10 m grid itself, the same ramp as the coarse near tiles
    const sx = (elev(r, c + 1) - elev(r, c - 1)) / ((Math.min(w - 1, c + 1) - Math.max(0, c - 1)) * dx)
    const sy = (elev(r - 1, c) - elev(r + 1, c)) / ((Math.min(h - 1, r + 1) - Math.max(0, r - 1)) * dy)
    const slopeDeg = (Math.atan(Math.hypot(sx, sy)) * 180) / Math.PI
    const t = THREE.MathUtils.smoothstep(slopeDeg, 8, 30)
    const jitter = FAR_ALBEDO * (0.97 + 0.06 * hash2(c, r, 9))
    c3.copy(FLAT).lerp(STEEP, t).multiplyScalar(jitter)
    col.push(c3.r, c3.g, c3.b)
    const v = pos.length / 3 - 1
    vertexOf[key] = v
    return v
  }

  /** True when any cell under the quad (r..r+s, c..c+s) has no elevation data. */
  const hasGap = (r: number, c: number, s: number): boolean => {
    for (let a = r; a <= r + s; a++) {
      const o = a * w
      for (let b = c; b <= c + s; b++) if (coarse.noData[o + b]) return true
    }
    return false
  }

  for (let br = 0; br < blockRows; br++) {
    for (let bc = 0; bc < blockCols; bc++) {
      const s = strideOf(br, bc)
      if (!s) continue
      for (let r = br * BLOCK; r < (br + 1) * BLOCK; r += s) {
        for (let c = bc * BLOCK; c < (bc + 1) * BLOCK; c += s) {
          if (hasGap(r, c, s)) continue
          const v00 = vertex(r, c, s, br, bc)
          const v01 = vertex(r, c + s, s, br, bc)
          const v10 = vertex(r + s, c, s, br, bc)
          const v11 = vertex(r + s, c + s, s, br, bc)
          idx.push(v00, v10, v01, v01, v10, v11) // same winding as the near tiles: faces up
        }
      }
    }
  }

  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nor),
    color: new Float32Array(col),
    index: new Uint32Array(idx),
    vertices: pos.length / 3,
    triangles: idx.length / 3,
  }
}

interface FarUniforms {
  /** (x, z) of the player in three.js world coordinates; third component 1 while the hole is open, else 0. */
  uFarHole: { value: THREE.Vector3 }
}

/**
 * The far terrain mesh for a session. Add it to the scene, call `updateFarTerrain` every frame, and dispose its
 * geometry and material at the end. It does not cast or receive the sun's shadow (that only reaches 60 m).
 */
export function buildFarTerrain(coarse: CoarseGrid, origin: LatLon): THREE.Mesh {
  const d = buildFarGeometryData(coarse, origin)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3))
  g.setAttribute('color', new THREE.BufferAttribute(d.color, 3))
  g.setIndex(new THREE.BufferAttribute(d.index, 1))
  g.computeBoundingSphere()
  g.computeBoundingBox()

  const uniforms: FarUniforms = { uFarHole: { value: new THREE.Vector3(0, 0, 0) } }
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    // behind the near tiles wherever the two are close in depth
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFarHole = uniforms.uFarHole
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uFarHole;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  float farHoleD = distance(position.xz, uFarHole.xy);
  transformed.y -= ${FAR_DROP_M.toFixed(1)} + uFarHole.z * ${FAR_SINK_M.toFixed(1)} * (1.0 - smoothstep(${FAR_HOLE_M.toFixed(1)}, ${(FAR_HOLE_M + FAR_HOLE_RAMP_M).toFixed(1)}, farHoleD));`,
      )
  }
  mat.customProgramCacheKey = () => 'mars-far-v1'

  const mesh = new THREE.Mesh(g, mat)
  mesh.name = 'far terrain'
  mesh.userData.farUniforms = uniforms
  mesh.userData.triangles = d.triangles
  mesh.matrixAutoUpdate = false
  return mesh
}

/**
 * Per frame: where the player is (local ENU), and whether the near tiles within FAR_HOLE_M of them are
 * built. While they are, the far terrain under them is sunk out of sight; while they are not (just after a jump),
 * it stays up and stands in for the ground.
 */
export function updateFarTerrain(mesh: THREE.Mesh, x: number, y: number, nearReady: boolean): void {
  const u = mesh.userData.farUniforms as FarUniforms | undefined
  if (!u) return
  const p = localToThree({ x, y, z: 0 })
  u.uFarHole.value.set(p.x, p.z, nearReady ? 1 : 0)
}
