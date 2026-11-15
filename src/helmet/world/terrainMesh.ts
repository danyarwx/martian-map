// three.js meshes and materials for the near terrain tiles (docs/helmet/PLAN.md §6.2).
//
// One BufferGeometry per 128 m tile from its 129 × 129 height samples (decimated by `stride` further away), with
// normals from central differences (neighbouring tiles' heights across the edges, through the height field), UVs
// onto the tile's 25 cm ortho, and a 3 m skirt along the four edges so tiles of different detail never show a crack.
// Real tiles use the grayscale HiRISE ortho tinted to Mars colours in the shader; coarse tiles use vertex colours
// from the slope. Both share one procedural tiling detail texture (grit, pebbles, mottling) that is blended in near
// the camera at three scales, and real tiles draw wind ripples where the orbital sand mask says sand.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import { localToThree, toLocal } from '../frames.ts'
import { hash2, mulberry32 } from './noise.ts'
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
  // quintic fade: no creases along the lattice lines (they showed as a faint grid in the normals)
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const m = (k: number) => ((k % period) + period) % period
  const a = hash2(m(ix), m(iy), seed)
  const b = hash2(m(ix + 1), m(iy), seed)
  const c = hash2(m(ix), m(iy + 1), seed)
  const d = hash2(m(ix + 1), m(iy + 1), seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** Metres of ground covered by one repeat of the detail texture at its base scale. */
export const DETAIL_REPEAT_M = 4
/** Repeats of the detail texture across one 128 m tile at the base scale. */
const DETAIL_REPS = 128 / DETAIL_REPEAT_M
/** Pebbles stamped into one repeat of the detail texture, and their radius range in metres. */
const PEBBLES = 700
const PEBBLE_R_M: readonly [number, number] = [0.016, 0.055]
/** Slopes of the detail height field are exaggerated by this in the normal map (lighting only). */
const DETAIL_SLOPE_GAIN = 2.4

/**
 * Tiling detail texture (generated once per world) for what the 1 m DTM and the 25 cm ortho cannot show up close:
 * grit, small pebbles and mottling. PROCEDURAL, not data. One RGBA texture, sampled by the ground shader at three
 * scales (and by the rocks, rockMesh.ts):
 *   R, G  the surface normal's x and y (tangent space: x along +u, y along +v; z is rebuilt in the shader)
 *   B     albedo detail around 0.5: mottling, darker and lighter pebbles
 *   A     smooth low-frequency noise around 0.5: large-scale albedo variation and the bending of sand ripples
 */
export function makeDetailNormalMap(size = 512): THREE.DataTexture {
  const hgt = new Float32Array(size * size) // metres
  const alb = new Float32Array(size * size) // albedo offset
  const low = new Float32Array(size * size)
  const pxM = DETAIL_REPEAT_M / size
  // lumps of 0.5 m down to grit of 3 cm; amplitudes in metres
  const octaves = [
    { cells: 8, amp: 0.022 },
    { cells: 16, amp: 0.014 },
    { cells: 32, amp: 0.008 },
    { cells: 64, amp: 0.005 },
    { cells: 128, amp: 0.003 },
  ]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x
      const u = x / size
      const v = y / size
      let hh = 0
      for (let o = 0; o < octaves.length; o++) {
        const { cells, amp } = octaves[o]
        hh += amp * periodicNoise(u * cells, v * cells, cells, 101 + o)
      }
      hgt[k] = hh
      // mottling: patches of 0.3–1 m plus fine grain
      const m1 = periodicNoise(u * 6, v * 6, 6, 211) - 0.5
      const m2 = periodicNoise(u * 14, v * 14, 14, 212) - 0.5
      const m3 = periodicNoise(u * 40, v * 40, 40, 213) - 0.5
      const grain = hash2(x, y, 214) - 0.5
      alb[k] = 0.28 * m1 + 0.26 * m2 + 0.2 * m3 + 0.2 * grain
      low[k] = 0.5 + 0.62 * (periodicNoise(u * 3, v * 3, 3, 311) - 0.5) + 0.38 * (periodicNoise(u * 7, v * 7, 7, 312) - 0.5)
    }
  }
  // pebbles: flattened domes, most of them small; each a little darker or lighter than the dust
  const rnd = mulberry32(90210)
  for (let p = 0; p < PEBBLES; p++) {
    const cx = rnd() * size
    const cy = rnd() * size
    const t = rnd()
    const rM = PEBBLE_R_M[0] + (PEBBLE_R_M[1] - PEBBLE_R_M[0]) * t * t
    const r = rM / pxM
    const tone = rnd() < 0.7 ? -(0.14 + 0.24 * rnd()) : 0.06 + 0.14 * rnd()
    const squash = 0.45 + 0.4 * rnd()
    const ax = 0.75 + 0.5 * rnd() // not round
    const ang = rnd() * Math.PI
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const reach = Math.ceil(r * 1.4)
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const ex = (dx * ca + dy * sa) / ax
        const ey = (-dx * sa + dy * ca) * ax
        const q = (ex * ex + ey * ey) / (r * r)
        if (q >= 1) continue
        const k = ((((Math.round(cy) + dy) % size) + size) % size) * size + ((((Math.round(cx) + dx) % size) + size) % size)
        const dome = Math.pow(1 - q, 0.8) // no vertical rim: a pebble half sunk in dust
        hgt[k] = Math.max(hgt[k], hgt[k] * 0.3 + rM * squash * dome)
        alb[k] += tone * Math.min(1, dome * 3)
      }
    }
  }
  const data = new Uint8Array(size * size * 4)
  const byte = (f: number) => Math.max(0, Math.min(255, Math.round(f * 255)))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (xx: number, yy: number) => hgt[((yy + size) % size) * size + ((xx + size) % size)]
      const dx = ((at(x + 1, y) - at(x - 1, y)) / (2 * pxM)) * DETAIL_SLOPE_GAIN
      const dy = ((at(x, y + 1) - at(x, y - 1)) / (2 * pxM)) * DETAIL_SLOPE_GAIN
      const len = Math.hypot(dx, dy, 1)
      const k = (y * size + x) * 4
      data[k] = byte((-dx / len) * 0.5 + 0.5)
      data[k + 1] = byte((-dy / len) * 0.5 + 0.5)
      data[k + 2] = byte(0.5 + alb[y * size + x])
      data[k + 3] = byte(low[y * size + x])
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 8
  t.colorSpace = THREE.NoColorSpace
  // the shader scales the tile's own UV itself (three scales), so the texture transform stays 1:1
  t.needsUpdate = true
  return t
}

/** Linear-space tint applied to the grayscale ortho: butterscotch dust over basaltic rock. */
export const ORTHO_TINT = new THREE.Color().setRGB(1.38, 0.74, 0.44)

/** The detail fades in from DETAIL_FAR_M to full strength at DETAIL_NEAR_M from the eye, metres. */
export const DETAIL_NEAR_M = 5
export const DETAIL_FAR_M = 25
/** Albedo swing of the near detail (±) and of the large-scale variation that stays to 150 m. */
export const DETAIL_ALBEDO = 0.75
export const MACRO_ALBEDO = 0.22
/** The second and third scale: whole-number rotations of the tile UV, so they continue across tile edges. */
const SCALE_FINE: readonly [number, number] = [97, 41] // 105 repeats: 1.22 m, turned 23°
const SCALE_MACRO: readonly [number, number] = [5, 3] // 5.8 repeats: 22 m, turned 31°
/** Grain at the feet: 0.35 m per repeat, only within GRAIN_FAR_M. */
const SCALE_GRAIN: readonly [number, number] = [331, 157]
export const GRAIN_FAR_M = 7

/**
 * How sand looks in the helmet world. SIMULATED (public/data/SOURCES.md): where a tile's sand mask says sand, the
 * ground is drawn the way wind-blown sand looks to the rovers, since the 25 cm ortho cannot show it up close:
 * - smooth: no pebbles, only SAND_GRIT of the grit normals and SAND_MOTTLE of the albedo detail are left;
 * - wind ripples as SURFACE NORMALS, so the sun lights one flank and shades the other (nothing is painted on):
 *   large ripples SAND_RIPPLE_M apart and small ones SAND_RIPPLE_SMALL_M apart, both with sharp crests, bent by
 *   smooth noise so crests wander and fork, patchy in strength, and faded out where finer than a pixel. One assumed
 *   wind direction for the whole site (crest normals about SAND_RIPPLE_DIR_DEG clockwise from east);
 * - a touch darker and less red than the dusty ground (dark basaltic sand under thin dust): SAND_TINT, about −4 %.
 * The ripple patterns have a whole number of waves per tile along both axes, so they continue across tile edges.
 */
export const SAND_TINT = new THREE.Color().setRGB(0.9, 0.95, 1.02)
export const SAND_GRIT = 0.25
export const SAND_MOTTLE = 0.4
/** Waves per 128 m tile along east and along south. Large: 0.60 m apart, 10° off east. Small: 0.16 m, 10°. */
export const SAND_RIPPLE_WAVES: readonly [number, number] = [211, 37]
export const SAND_RIPPLE_SMALL_WAVES: readonly [number, number] = [788, 139]
export const SAND_RIPPLE_M = 128 / Math.hypot(SAND_RIPPLE_WAVES[0], SAND_RIPPLE_WAVES[1])
export const SAND_RIPPLE_SMALL_M = 128 / Math.hypot(SAND_RIPPLE_SMALL_WAVES[0], SAND_RIPPLE_SMALL_WAVES[1])
export const SAND_RIPPLE_DIR_DEG = (Math.atan2(SAND_RIPPLE_WAVES[1], SAND_RIPPLE_WAVES[0]) * 180) / Math.PI
/** Tilt of the ripple flanks in the normal map's units (tangent of the slope angle, roughly). */
export const SAND_RIPPLE_STRENGTH = 0.26
export const SAND_RIPPLE_SMALL_STRENGTH = 0.3
/** Smooth noise bends the crests by up to this many waves (large, small). */
export const SAND_RIPPLE_WARP: readonly [number, number] = [1.4, 3]

let noSand: THREE.DataTexture | null = null
/** A 1 × 1 "no sand anywhere" mask for tiles without one. */
function noSandTexture(): THREE.DataTexture {
  if (!noSand) {
    noSand = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat)
    noSand.needsUpdate = true
  }
  return noSand
}

/** A tile's sand mask (n × n, 1 = sand, row 0 north) as a texture laid over the tile like the ortho. */
export function makeSandTexture(mask: Uint8Array): THREE.DataTexture {
  const n = Math.round(Math.sqrt(mask.length))
  const data = new Uint8Array(n * n)
  for (let k = 0; k < data.length; k++) data[k] = mask[k] ? 255 : 0
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat)
  t.magFilter = THREE.LinearFilter // soft edges: sand thins out over about half a metre
  t.minFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.colorSpace = THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

const f1 = (x: number) => x.toFixed(1)
const f4 = (x: number) => x.toFixed(4)

/**
 * Fragment code shared by both ground materials. Needs `marsSand` (0..1) and `marsGray` declared before it; leaves
 * `marsN` (tangent-space normal offset) for the normal chunk. vNormalMapUv is the tile's UV (0..1 over 128 m).
 */
function groundDetailChunk(ripples: boolean): string {
  const [fa, fb] = SCALE_FINE
  const fl = Math.hypot(fa, fb)
  const [ma, mb] = SCALE_MACRO
  const [ga, gb] = SCALE_GRAIN
  const [w1e, w1s] = SAND_RIPPLE_WAVES
  const l1 = Math.hypot(w1e, w1s)
  const [w2e, w2s] = SAND_RIPPLE_SMALL_WAVES
  const l2 = Math.hypot(w2e, w2s)
  return /* glsl */ `
  vec2 marsUv = vNormalMapUv;
  float marsDist = length(vViewPosition);
  float marsNear = 1.0 - smoothstep(${f1(DETAIL_NEAR_M)}, ${f1(DETAIL_FAR_M)}, marsDist);
  float marsMid = 1.0 - smoothstep(60.0, 150.0, marsDist);
  vec4 marsA = texture2D(normalMap, marsUv * ${f1(DETAIL_REPS)});
  vec4 marsB = texture2D(normalMap, mat2(${f1(fa)}, ${f1(fb)}, ${f1(-fb)}, ${f1(fa)}) * marsUv);
  vec4 marsC = texture2D(normalMap, mat2(${f1(ma)}, ${f1(mb)}, ${f1(-mb)}, ${f1(ma)}) * marsUv);
  float marsGrain = (1.0 - smoothstep(2.0, ${f1(GRAIN_FAR_M)}, marsDist)) * (texture2D(normalMap, mat2(${f1(ga)}, ${f1(gb)}, ${f1(-gb)}, ${f1(ga)}) * marsUv).b - 0.5);
  float marsFirm = 1.0 - marsSand;
  // albedo: pebbles and mottling near the eye, broad lighter and darker patches further out
  float marsAlb = (marsA.b - 0.5) * 0.6 + (marsB.b - 0.5) * 0.55;
  marsAlb *= mix(${SAND_MOTTLE.toFixed(2)}, 1.0, marsFirm);
  marsAlb += 0.5 * marsGrain;
  float marsMacro = (marsC.a - 0.5) + 0.5 * (marsA.a - 0.5);
  diffuseColor.rgb *= max(0.0, 1.0 + ${DETAIL_ALBEDO.toFixed(2)} * marsNear * marsAlb + ${MACRO_ALBEDO.toFixed(2)} * marsMid * marsMacro);
  // normals: the fine scale's xy is turned back into the tile's frame
  vec2 marsNb = marsB.rg * 2.0 - 1.0;
  vec2 marsN = (marsA.rg * 2.0 - 1.0) + 0.8 * vec2(${f4(fa / fl)} * marsNb.x + ${f4(fb / fl)} * marsNb.y, ${f4(-fb / fl)} * marsNb.x + ${f4(fa / fl)} * marsNb.y);
  marsN *= mix(0.45, 1.15, marsNear) * mix(${SAND_GRIT.toFixed(2)}, 1.0, marsFirm);
${
  ripples
    ? `  if (marsSand > 0.01) {
    float marsBend = (marsC.a - 0.5) * 2.0;
    // large ripples
    float w1 = ${f1(w1e)} * marsUv.x + ${f1(w1s)} * marsUv.y + ${f1(SAND_RIPPLE_WARP[0])} * marsBend + 0.12 * (marsA.a - 0.5) + 0.3 * marsGray;
    float p1 = fract(w1) * 6.2832;
    float fade1 = 1.0 - smoothstep(0.5, 1.5, fwidth(w1) * 6.2832);
    // sharp crest, long windward flank: the slope of a skewed wave
    float s1 = sin(p1) + 0.45 * sin(2.0 * p1 + 0.5) + 0.15 * sin(3.0 * p1 + 1.0);
    // small ripples ride on the large ones, in patches
    float w2 = ${f1(w2e)} * marsUv.x + ${f1(w2s)} * marsUv.y + ${f1(SAND_RIPPLE_WARP[1])} * marsBend + 0.5 * (marsA.a - 0.5);
    float p2 = fract(w2) * 6.2832;
    float fade2 = 1.0 - smoothstep(0.5, 1.5, fwidth(w2) * 6.2832);
    float s2 = sin(p2) + 0.5 * sin(2.0 * p2 + 0.5) + 0.25 * sin(3.0 * p2 + 1.0);
    float patch1 = 0.6 + 0.8 * marsC.a;
    float patch2 = 0.35 + 0.65 * smoothstep(0.3, 0.6, marsA.a);
    marsN += vec2(${f4(w1e / l1)}, ${f4(w1s / l1)}) * (${SAND_RIPPLE_STRENGTH.toFixed(2)} * marsSand * fade1 * patch1 * s1);
    marsN += vec2(${f4(w2e / l2)}, ${f4(w2s / l2)}) * (${SAND_RIPPLE_SMALL_STRENGTH.toFixed(2)} * marsSand * fade2 * patch2 * s2);
    // a little less sky light reaches the troughs of the large ripples
    diffuseColor.rgb *= 1.0 - 0.07 * marsSand * fade1 * (0.5 - 0.5 * cos(p1));
  }
`
    : ''
}`
}

const GROUND_NORMAL_CHUNK = /* glsl */ `#ifdef USE_NORMALMAP_TANGENTSPACE
  normal = normalize( tbn * vec3( marsN * normalScale, 1.0 ) );
#endif`

/**
 * Material for a real 1 m tile: grayscale ortho as `map`, re-coloured in the fragment shader (gray × Mars tint),
 * plus the procedural detail near the eye, and the simulated look of sand where `sand` (makeSandTexture) says so.
 * Stays a MeshStandardMaterial so lights, fog and shadows work unchanged.
 */
export function makeOrthoMaterial(ortho: THREE.Texture, detail: THREE.Texture, sand: THREE.Texture | null = null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: ortho,
    normalMap: detail,
    normalScale: new THREE.Vector2(1, 1),
    roughness: 0.96,
    metalness: 0,
  })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uMarsTint = { value: ORTHO_TINT }
    shader.uniforms.uSandMask = { value: sand ?? noSandTexture() }
    shader.uniforms.uSandTint = { value: SAND_TINT }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uMarsTint;\nuniform sampler2D uSandMask;\nuniform vec3 uSandTint;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  float marsSand = 0.0;
  float marsGray = 0.0;
#ifdef USE_MAP
  marsGray = diffuseColor.r;
  diffuseColor.rgb = vec3(marsGray) * uMarsTint;
  marsSand = texture2D(uSandMask, vMapUv).r;
  diffuseColor.rgb *= mix(vec3(1.0), uSandTint, marsSand);
#endif
${groundDetailChunk(true)}`,
      )
      .replace('#include <normal_fragment_maps>', GROUND_NORMAL_CHUNK)
  }
  m.customProgramCacheKey = () => 'mars-ortho-v4'
  return m
}

/** Material for coarse tiles (no ortho): vertex colours from the slope + the procedural detail. */
export function makeCoarseMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    normalMap: detail,
    normalScale: new THREE.Vector2(1, 1),
    roughness: 0.97,
    metalness: 0,
  })
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>\n  float marsSand = 0.0;\n  float marsGray = 0.0;\n${groundDetailChunk(false)}`)
      .replace('#include <normal_fragment_maps>', GROUND_NORMAL_CHUNK)
  }
  m.customProgramCacheKey = () => 'mars-coarse-v1'
  return m
}
