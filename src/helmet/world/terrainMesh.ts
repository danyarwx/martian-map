// three.js meshes and materials for the near terrain tiles (docs/helmet/PLAN.md §6.2).
//
// One BufferGeometry per 128 m tile from its 129 × 129 height samples (decimated by `stride` further away), with
// normals from central differences (neighbouring tiles' heights across the edges, through the height field), UVs
// onto the tile's 25 cm ortho, and a 3 m skirt along the four edges so tiles of different detail never show a crack.
// Real tiles use the grayscale HiRISE ortho tinted to Mars colours in the shader; coarse tiles use vertex colours
// from the slope. Both share a procedural tiling detail normal map for sub-metre texture.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import { localToThree, toLocal } from '../frames.ts'
import { hash2 } from './noise.ts'
import { CELLS, SAMPLES, tileBounds, type TileGridSpec } from './tileGrid.ts'

export type Stride = 1 | 2 | 4 | 8

/** Depth of the skirt hanging from each tile edge, metres. */
export const SKIRT_M = 3

export interface TileGeometryInput {
  /** 129 × 129 heights in metres, row 0 north. */
  h: Float32Array
  row: number
  col: number
  grid: TileGridSpec
  origin: LatLon
  stride: Stride
  /** Height outside this tile (for normals along the edges). */
  outside: (lat: number, lon: number) => number
  /** Add vertex colours from the slope (coarse tiles). */
  slopeColours?: boolean
}

/** Colour of flat coarse ground and of steep ground (sRGB), Mars albedo. */
export const FLAT = new THREE.Color().setRGB(0.47, 0.34, 0.26, THREE.SRGBColorSpace)
export const STEEP = new THREE.Color().setRGB(0.33, 0.24, 0.19, THREE.SRGBColorSpace)

export function buildTileGeometry(inp: TileGeometryInput): THREE.BufferGeometry {
  const { h, stride, grid } = inp
  const b = tileBounds(inp.row, inp.col, grid)
  const nw = toLocal({ lat: b.north, lon: b.west }, inp.origin)
  const se = toLocal({ lat: b.south, lon: b.east }, inp.origin)
  const n = CELLS / stride + 1
  const dxM = (se.x - nw.x) / CELLS // metres per sample, east
  const dyM = (nw.y - se.y) / CELLS // metres per sample, south

  const heightIJ = (i: number, j: number): number => {
    if (i >= 0 && i <= CELLS && j >= 0 && j <= CELLS) return h[i * SAMPLES + j]
    return inp.outside(b.north - (i / CELLS) * grid.tileDegLat, b.west + (j / CELLS) * grid.tileDegLon)
  }

  const skirtVerts = 4 * n
  const total = n * n + skirtVerts
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  const col = inp.slopeColours ? new Float32Array(total * 3) : null
  const c = new THREE.Color()

  const writeVertex = (v: number, i: number, j: number, dz: number) => {
    const x = nw.x + j * dxM
    const y = nw.y - i * dyM
    const z = h[i * SAMPLES + j] + dz
    const p = localToThree({ x, y, z })
    pos[v * 3] = p.x
    pos[v * 3 + 1] = p.y
    pos[v * 3 + 2] = p.z
    // normal from central differences over ±stride samples
    const s = stride
    const gx = (heightIJ(i, j + s) - heightIJ(i, j - s)) / (2 * s * dxM)
    const gy = (heightIJ(i - s, j) - heightIJ(i + s, j)) / (2 * s * dyM) // north positive
    const len = Math.hypot(gx, gy, 1)
    const nn = localToThree({ x: -gx / len, y: -gy / len, z: 1 / len })
    nor[v * 3] = nn.x
    nor[v * 3 + 1] = nn.y
    nor[v * 3 + 2] = nn.z
    uv[v * 2] = j / CELLS
    uv[v * 2 + 1] = i / CELLS // textures use flipY = false: v = 0 is the image's top (north) row
    if (col) {
      const slopeDeg = (Math.acos(1 / len) * 180) / Math.PI
      const t = THREE.MathUtils.smoothstep(slopeDeg, 8, 30)
      const jitter = 0.94 + 0.12 * hash2(Math.round(x), Math.round(y), 5)
      c.copy(FLAT).lerp(STEEP, t).multiplyScalar(jitter)
      col[v * 3] = c.r
      col[v * 3 + 1] = c.g
      col[v * 3 + 2] = c.b
    }
  }

  for (let a = 0; a < n; a++) for (let bb = 0; bb < n; bb++) writeVertex(a * n + bb, a * stride, bb * stride, 0)

  // skirt vertices: north edge, east edge, south edge, west edge, each n long
  const edges: [number, number][][] = [[], [], [], []]
  for (let k = 0; k < n; k++) {
    edges[0].push([0, k * stride])
    edges[1].push([k * stride, CELLS])
    edges[2].push([CELLS, k * stride])
    edges[3].push([k * stride, 0])
  }
  let v = n * n
  const skirtStart: number[] = []
  for (const e of edges) {
    skirtStart.push(v)
    for (const [i, j] of e) writeVertex(v++, i, j, -SKIRT_M)
  }

  const indices: number[] = []
  for (let a = 0; a < n - 1; a++) {
    for (let bb = 0; bb < n - 1; bb++) {
      const p00 = a * n + bb
      const p01 = p00 + 1
      const p10 = p00 + n
      const p11 = p10 + 1
      indices.push(p00, p10, p01, p01, p10, p11)
    }
  }
  // skirt quads, wound to face outwards
  const outward: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]] // three (x, z) of north, east, south, west
  const top = (e: number, k: number) => {
    const [i, j] = edges[e][k]
    return (i / stride) * n + j / stride
  }
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < n - 1; k++) {
      const t0 = top(e, k)
      const t1 = top(e, k + 1)
      const s0 = skirtStart[e] + k
      const s1 = s0 + 1
      // face normal of (t0, t1, s0)
      const ax = pos[t1 * 3] - pos[t0 * 3]
      const az = pos[t1 * 3 + 2] - pos[t0 * 3 + 2]
      const by = pos[s0 * 3 + 1] - pos[t0 * 3 + 1]
      // cross((ax,0,az), (0,by,0)) = (-az·by, 0, ax·by)
      const nx = -az * by
      const nz = ax * by
      const facesOut = nx * outward[e][0] + nz * outward[e][1] > 0
      if (facesOut) indices.push(t0, t1, s0, t1, s1, s0)
      else indices.push(t0, s0, t1, t1, s0, s1)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(indices)
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

/** Periodic value noise on a `period`-cell lattice, so the texture tiles seamlessly. */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const m = (k: number) => ((k % period) + period) % period
  const a = hash2(m(ix), m(iy), seed)
  const b = hash2(m(ix + 1), m(iy), seed)
  const c = hash2(m(ix), m(iy + 1), seed)
  const d = hash2(m(ix + 1), m(iy + 1), seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** Metres of ground covered by one repeat of the detail normal map. */
export const DETAIL_REPEAT_M = 4

/**
 * Tiling detail normal map (generated once per world): grit and pebbles of a few centimetres to ~0.5 m, which the
 * 1 m DTM and the 25 cm ortho cannot show up close.
 */
export function makeDetailNormalMap(size = 256): THREE.DataTexture {
  const hgt = new Float32Array(size * size)
  const octaves = [
    { cells: 8, amp: 0.5 },
    { cells: 16, amp: 0.3 },
    { cells: 32, amp: 0.2 },
    { cells: 64, amp: 0.12 },
  ]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      for (let o = 0; o < octaves.length; o++) {
        const { cells, amp } = octaves[o]
        v += amp * periodicNoise((x / size) * cells, (y / size) * cells, cells, 101 + o)
      }
      // a few pebbles: sharpen the bumps
      hgt[y * size + x] = Math.pow(v, 1.6)
    }
  }
  const data = new Uint8Array(size * size * 4)
  const strength = 6
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (xx: number, yy: number) => hgt[(((yy + size) % size) * size + ((xx + size) % size))]
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const len = Math.hypot(dx, dy, 1)
      const k = (y * size + x) * 4
      data[k] = Math.round(((-dx / len) * 0.5 + 0.5) * 255)
      data[k + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255)
      data[k + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
      data[k + 3] = 255
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.colorSpace = THREE.NoColorSpace
  const reps = 128 / DETAIL_REPEAT_M
  t.repeat.set(reps, reps)
  t.needsUpdate = true
  return t
}

/** Linear-space tint applied to the grayscale ortho: butterscotch dust over basaltic rock. */
export const ORTHO_TINT = new THREE.Color().setRGB(1.38, 0.74, 0.44)

/**
 * Material for a real 1 m tile: grayscale ortho as `map`, re-coloured in the fragment shader (gray × Mars tint),
 * plus the detail normal map. Stays a MeshStandardMaterial so lights, fog and shadows work unchanged.
 */
export function makeOrthoMaterial(ortho: THREE.Texture, detail: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: ortho,
    normalMap: detail,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.96,
    metalness: 0,
  })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uMarsTint = { value: ORTHO_TINT }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uMarsTint;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
#ifdef USE_MAP
  float marsGray = diffuseColor.r;
  diffuseColor.rgb = vec3(marsGray) * uMarsTint;
#endif`,
      )
  }
  m.customProgramCacheKey = () => 'mars-ortho-v1'
  return m
}

/** Material for coarse tiles (no ortho): vertex colours from the slope + the detail normal map. */
export function makeCoarseMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    normalMap: detail,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.97,
    metalness: 0,
  })
}
