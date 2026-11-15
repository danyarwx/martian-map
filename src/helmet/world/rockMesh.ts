// Draws the rocks of rocks.ts (docs/helmet/PLAN.md §6.2): a few shared rock shapes, instanced.
//
// A tile holds thousands of rocks (most of them 15–30 cm), so rocks are only generated for tiles near the player
// and only the ones that matter at their distance are drawn: everything within 20 m, rocks from 0.3 m within 60 m,
// rocks from 0.6 m and the demo boulders within 150 m. Three levels of detail per shape: 500 triangles for rocks
// from 0.3 m within 12 m, 180 triangles to 40 m (and for the pebbles at the feet), 20 triangles beyond. The
// instance lists are rebuilt when the player has moved a few metres.
//
// Only the LOOK lives here. Where rocks are and how big they are is rocks.ts (collision and the CV eval's ground
// truth read that); every shape fills the same unit box, so a rock's d × h × d·w is what is drawn.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import { localToThree } from '../frames.ts'
import type { HeightField } from './heightField.ts'
import { hash2, mulberry32 } from './noise.ts'
import { BURY, demoBoulderFields, demoRocksByTile, RockField, rocksInTile, roughGrid, VARIANTS, type DemoField, type DemoRock, type Rock } from './rocks.ts'
import type { RoutesFileLeg } from './routes.ts'
import { FLAT } from './terrainMesh.ts'
import type { TileIndex } from './tileGrid.ts'
import type { TileSlot } from './tiles.ts'

/** Rocks are generated for tiles nearer than this and dropped beyond DROP_M, metres. */
const GENERATE_M = 170
const DROP_M = 260
/** Draw distances by size class, metres. */
const SMALL_M = 20
const MEDIUM_M = 60
const LARGE_M = 150
/** Within NEAR_M rocks from 0.3 m use the 500-triangle shape, within DETAIL_M the 180-triangle one. */
const NEAR_M = 12
const DETAIL_M = 40
/** Pebbles (under 0.3 m) this close use the 180-triangle shape too. */
const PEBBLE_DETAIL_M = 5
/** Icosahedron subdivision of the three levels: 20·(n+1)² triangles. */
const LOD_DETAIL: readonly [number, number, number] = [4, 2, 0]
/** Instances per shape and level. A level that is full hands the rock to the next one down. */
const LOD_CAP: readonly [number, number, number] = [40, 500, 1800]
/** Rebuild the instance lists after the player moved this far, metres. */
const REBUILD_M = 3
/** Soft contact shadows are drawn under rocks from this size within this distance. */
const CONTACT_MIN_D = 0.25
const CONTACT_M = 45
const CONTACT_CAP = 600
/** Darkest point of a contact shadow (share of the ground's light it takes away). */
const CONTACT_ALPHA = 0.36

/**
 * Above 1 the upper part of every shape is lifted towards its full height (1 = as modelled). Kept low on purpose:
 * with broad, flat tops (1.5 and more) neighbouring boulders read as one in the helmet's stereo and the CV eval's
 * rock recall fell under its 80 % target; 1.2 measured 81 %.
 */
const TOP_FULLNESS = 1.2

/** Smooth 3D value noise in [0, 1]. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)
  const at = (i: number, j: number, k: number) => hash2(ix + i + (iz + k) * 157, iy + j + (iz + k) * 311, seed)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), ux), lerp(at(0, 1, 0), at(1, 1, 0), ux), uy),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), ux), lerp(at(0, 1, 1), at(1, 1, 1), ux), uy),
    uz,
  )
}

function fbm3(x: number, y: number, z: number, seed: number, octaves: number): number {
  let v = 0
  let amp = 0.5
  let f = 1
  for (let o = 0; o < octaves; o++) {
    v += amp * (noise3(x * f, y * f, z * f, seed + o * 17) - 0.5)
    amp *= 0.5
    f *= 2.1
  }
  return v // about −0.5..0.5
}

/** What makes the rock shapes differ: how lumpy, how many fracture planes cut it, how smooth it is shaded. */
interface RockStyle {
  /** Low-frequency swelling of the radius, ±. */
  lump: number
  /** Fracture planes: a flat face is cut wherever the lump pokes through one. */
  cuts: number
  /** Distance of the planes from the centre, as a share of the radius (smaller = deeper cuts). */
  cutDepth: readonly [number, number]
  /** Fine surface relief, ±. */
  fine: number
  /** 0 = faceted, 1 = fully smooth normals. */
  smooth: number
  /** 1 = a ball, smaller = boxier: steeper sides and a broader top. */
  box: number
}

/** One style per rocks.ts variant: an angular block, a rounded boulder, a split slab, a weathered lump. */
const STYLES: readonly RockStyle[] = [
  { lump: 0.18, cuts: 9, cutDepth: [0.62, 0.86], fine: 0.035, smooth: 0.55, box: 0.62 },
  { lump: 0.34, cuts: 0, cutDepth: [1, 1], fine: 0.05, smooth: 0.92, box: 0.8 },
  { lump: 0.14, cuts: 6, cutDepth: [0.5, 0.8], fine: 0.03, smooth: 0.5, box: 0.55 },
  { lump: 0.3, cuts: 4, cutDepth: [0.7, 0.92], fine: 0.06, smooth: 0.8, box: 0.72 },
]

/**
 * A unit rock (fills the box −0.5..0.5 on every axis): a sphere swollen by noise, cut by fracture planes, with fine
 * relief on top and a flattened underside. The shape depends on the variant only, so every level of detail of a
 * variant is the same rock sampled more or less finely.
 */
function rockGeometry(variant: number, detail: number): THREE.BufferGeometry {
  const style = STYLES[variant % STYLES.length]
  const g = new THREE.IcosahedronGeometry(0.5, detail)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const seed = 977 + variant * 131
  const rnd = mulberry32(seed)
  const planes: { n: THREE.Vector3; d: number }[] = []
  for (let c = 0; c < style.cuts; c++) {
    const n = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.8 + 0.15, rnd() * 2 - 1).normalize()
    planes.push({ n, d: 0.5 * (style.cutDepth[0] + (style.cutDepth[1] - style.cutDepth[0]) * rnd()) })
  }
  const off = variant * 19.7
  const v = new THREE.Vector3()
  const u = new THREE.Vector3()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (let i = 0; i < pos.count; i++) {
    u.fromBufferAttribute(pos, i).normalize()
    // the same corner appears in several triangles: everything below depends on the direction only
    const lump = fbm3(u.x * 1.6 + off, u.y * 1.6, u.z * 1.6, seed, 3)
    // a ball pushed towards a box: |x|^box keeps the sign and fattens the corners
    v.set(Math.sign(u.x) * Math.pow(Math.abs(u.x), style.box), Math.sign(u.y) * Math.pow(Math.abs(u.y), style.box), Math.sign(u.z) * Math.pow(Math.abs(u.z), style.box))
    v.multiplyScalar(0.5 * (1 + 2 * style.lump * lump))
    for (const p of planes) {
      const over = v.dot(p.n) - p.d
      if (over > 0) v.addScaledVector(p.n, -over * 0.94) // a slightly bulging flat face
    }
    const fine = fbm3(u.x * 5.5 + off, u.y * 5.5, u.z * 5.5, seed + 99, 3)
    v.addScaledVector(u, style.fine * 2 * fine)
    if (v.y < -0.22) v.y = -0.22 + (v.y + 0.22) * 0.45 // flatter underside
    pos.setXYZ(i, v.x, v.y, v.z)
    min.min(v)
    max.max(v)
  }
  // fill the unit box, so the drawn size is the rock's d × h × d·w
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      (pos.getX(i) - min.x) / (max.x - min.x) - 0.5,
      // a broad top rather than a point: the rock is as tall as rocks.ts says over a good part of its width
      1 - Math.pow(Math.max(0, 1 - (pos.getY(i) - min.y) / (max.y - min.y)), TOP_FULLNESS) - 0.5,
      (pos.getZ(i) - min.z) / (max.z - min.z) - 0.5,
    )
  }
  smoothNormals(g, style.smooth)
  g.computeBoundingSphere()
  return g
}

/** Normals of a non-indexed geometry: the face normal blended with the average over the faces sharing the corner. */
function smoothNormals(g: THREE.BufferGeometry, smooth: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  const face = new Float32Array(n * 3)
  const sum = new Map<string, THREE.Vector3>()
  const keys: string[] = new Array(n)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const fn = new THREE.Vector3()
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i)
    b.fromBufferAttribute(pos, i + 1)
    c.fromBufferAttribute(pos, i + 2)
    fn.subVectors(b, a).cross(c.sub(a)) // length = twice the area: larger faces weigh more
    for (let k = 0; k < 3; k++) {
      const j = i + k
      const key = `${Math.round(pos.getX(j) * 2e4)},${Math.round(pos.getY(j) * 2e4)},${Math.round(pos.getZ(j) * 2e4)}`
      keys[j] = key
      const s = sum.get(key)
      if (s) s.add(fn)
      else sum.set(key, fn.clone())
      face[j * 3] = fn.x
      face[j * 3 + 1] = fn.y
      face[j * 3 + 2] = fn.z
    }
  }
  const nor = new Float32Array(n * 3)
  for (let j = 0; j < n; j++) {
    fn.set(face[j * 3], face[j * 3 + 1], face[j * 3 + 2]).normalize()
    a.copy(sum.get(keys[j])!).normalize()
    fn.lerp(a, smooth).normalize()
    nor[j * 3] = fn.x
    nor[j * 3 + 1] = fn.y
    nor[j * 3 + 2] = fn.z
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
}

/** Colour of the dust that settles on top of rocks (linear): the ground's own colour, a little paler. */
const DUST = FLAT.clone().multiplyScalar(1.12)
/** Rock colours (sRGB): dark basalt to paler, dustier stone. Each rock gets a mix of the two and its own shade. */
const ROCK_DARK: readonly [number, number, number] = [0.33, 0.25, 0.215]
const ROCK_PALE: readonly [number, number, number] = [0.5, 0.375, 0.29]
/** Metres of rock surface covered by one repeat of the detail texture. */
const ROCK_TEX_M = 1.3

/**
 * The rock material: a MeshStandardMaterial with, in the shader, the ground's detail texture laid on from three
 * sides (pits and mottling at a fixed size in metres, whatever the rock's size), a darker base where the rock
 * meets the ground, and dust on the faces that look up.
 */
function rockMaterial(detail: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0 })
  if (!detail) return m
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRockDetail = { value: detail }
    shader.uniforms.uRockDust = { value: DUST }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockP;\nvarying vec3 vRockN;\nvarying float vRockY;\nvarying float vRockSize;\nvarying mat3 vRockM;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
  vRockY = position.y;
  vRockN = normal;
#ifdef USE_INSTANCING
  vec3 rockS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  // metres on the rock, shifted per rock so two rocks of one shape do not carry the same marks
  vRockSize = rockS.x;
  vRockP = position * rockS + fract(instanceMatrix[3].xyz * 0.173) * 9.0;
  vRockM = mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix[0].xyz / rockS.x, instanceMatrix[1].xyz / rockS.y, instanceMatrix[2].xyz / rockS.z);
#else
  vRockSize = 1.0;
  vRockP = position;
  vRockM = mat3(modelViewMatrix);
#endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uRockDetail;\nuniform vec3 uRockDust;\nvarying vec3 vRockP;\nvarying vec3 vRockN;\nvarying float vRockY;\nvarying float vRockSize;\nvarying mat3 vRockM;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `{
    vec3 rockW = pow(abs(normalize(vRockN)), vec3(4.0));
    rockW /= rockW.x + rockW.y + rockW.z;
    vec3 rockQ = vRockP * ${(1 / ROCK_TEX_M).toFixed(4)};
    vec4 rockX = texture2D(uRockDetail, rockQ.zy);
    vec4 rockY = texture2D(uRockDetail, rockQ.xz);
    vec4 rockZ = texture2D(uRockDetail, rockQ.xy);
    vec4 rockT = rockX * rockW.x + rockY * rockW.y + rockZ * rockW.z;
    // a second, coarser look-up for streaks and patches a hand wide
    vec3 rockQ2 = vRockP * 0.19 + 0.37;
    float rockLow = texture2D(uRockDetail, rockQ2.zy).a * rockW.x + texture2D(uRockDetail, rockQ2.xz).a * rockW.y + texture2D(uRockDetail, rockQ2.xy).a * rockW.z;
    diffuseColor.rgb *= max(0.0, 1.0 + 0.7 * (rockT.b - 0.5) + 0.55 * (rockLow - 0.5));
    // pits and grain
    vec2 rx = rockX.rg * 2.0 - 1.0;
    vec2 ry = rockY.rg * 2.0 - 1.0;
    vec2 rz = rockZ.rg * 2.0 - 1.0;
    vec3 rockBump = rockW.x * vec3(0.0, rx.y, rx.x) + rockW.y * vec3(ry.x, 0.0, ry.y) + rockW.z * vec3(rz.x, rz.y, 0.0);
    normal = normalize(normal + 0.9 * (vRockM * rockBump));
    // less sky reaches the foot of the rock
    float rockFoot = smoothstep(${(-0.5 + BURY - 0.04).toFixed(3)}, ${(-0.5 + BURY + 0.4).toFixed(3)}, vRockY);
    diffuseColor.rgb *= mix(0.66, 1.0, rockFoot);
    // dust settles on what faces up, in patches; boulders carry more of it than small stones
    float rockUp = dot(normal, normalize(viewMatrix[1].xyz));
    float rockDust = smoothstep(0.5, 0.95, rockUp + 0.6 * (rockLow - 0.5) + 0.25 * (rockT.b - 0.5)) * mix(0.35, 1.0, rockFoot);
    diffuseColor.rgb = mix(diffuseColor.rgb, uRockDust * (1.0 + 0.3 * (rockT.b - 0.5)), 0.6 * rockDust * smoothstep(0.2, 0.9, vRockSize));
  }`,
      )
  }
  m.customProgramCacheKey = () => 'mars-rock-v1'
  return m
}

/** A soft dark disc on the ground under a rock: the sky light the rock keeps off the ground around it. */
function contactMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: CONTACT_ALPHA } },
    vertexShader: /* glsl */ `
varying vec2 vC;
void main() {
  vC = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float uAlpha;
varying vec2 vC;
void main() {
  float r = length(vC);
  float a = 1.0 - smoothstep(0.42, 1.0, r);
  gl_FragColor = vec4(0.05, 0.03, 0.02, uAlpha * a * a);
}`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    fog: false,
    toneMapped: false,
  })
}

interface TileInput {
  slot: TileSlot
  rough: Uint8Array | null
}

interface Shape {
  mesh: THREE.InstancedMesh
  n: number
}

export interface RockLayerOptions {
  group: THREE.Group
  index: TileIndex
  origin: LatLon
  /** routes.json legs, for the demo boulder fields. */
  legs: readonly RoutesFileLeg[]
  /** Legs of the plan being walked: a demo boulder field goes on the leg into each of its stops. */
  planLegs?: readonly { toId: string; path: LatLon[] }[]
  /** The ground's detail texture (terrainMesh.ts): the rocks' surface marks. Without it rocks are plain. */
  detail?: THREE.Texture
  /** For tilting the contact shadows with the ground. Without it they lie level. */
  heights?: HeightField
}

export class RockLayer {
  readonly field = new RockField()
  /** The demo boulder fields (one per demo window). */
  readonly demoFields: DemoField[]
  private demoByTile: Map<string, DemoRock[]>
  private inputs = new Map<string, TileInput>()
  /** Shapes by level of detail (0 = finest), then by variant. */
  private lods: Shape[][] = [[], [], []]
  private contact: Shape
  private contactMat: THREE.ShaderMaterial
  private material: THREE.MeshStandardMaterial
  private opts: RockLayerOptions
  private builtAt: { x: number; y: number; version: number } | null = null
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private s = new THREE.Vector3()
  private p = new THREE.Vector3()
  private c = new THREE.Color()
  private up = new THREE.Vector3()
  private yAxis = new THREE.Vector3(0, 1, 0)
  private q2 = new THREE.Quaternion()

  constructor(opts: RockLayerOptions) {
    this.opts = opts
    const planned = (stopId: string) => {
      const leg = opts.planLegs?.find((l) => l.toId === stopId && l.path.length > 1)
      return leg ? { legId: `plan>${stopId}`, path: leg.path } : null
    }
    this.demoFields = demoBoulderFields(opts.index.windows ?? [], opts.legs, planned)
    this.demoByTile = demoRocksByTile(this.demoFields, opts.index)
    this.material = rockMaterial(opts.detail ?? null)
    const names = ['near', 'mid', 'far']
    for (let l = 0; l < 3; l++) {
      for (let v = 0; v < VARIANTS; v++) this.lods[l].push(this.shape(rockGeometry(v, LOD_DETAIL[l]), LOD_CAP[l], `rocks ${names[l]} ${v}`))
    }
    // contact shadows: one flat square per rock, lying on the ground
    this.contactMat = contactMaterial()
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    const mesh = new THREE.InstancedMesh(quad, this.contactMat, CONTACT_CAP)
    mesh.name = 'rock contact shadows'
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.renderOrder = 5
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    opts.group.add(mesh)
    this.contact = { mesh, n: 0 }
  }

  private get shapes(): Shape[] {
    return this.lods.flat()
  }

  private shape(geometry: THREE.BufferGeometry, cap: number, name: string): Shape {
    const mesh = new THREE.InstancedMesh(geometry, this.material, cap)
    mesh.name = name
    mesh.count = 0
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false // instances are spread around the player
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.setColorAt(0, this.c.set('#ffffff'))
    this.opts.group.add(mesh)
    return { mesh, n: 0 }
  }

  /** A terrain tile got its heights (TileStreamer.onBuilt): remember what its rocks depend on. */
  addTile(slot: TileSlot): void {
    this.inputs.set(slot.id, { slot, rough: slot.orthoPixels ? roughGrid(slot.orthoPixels, Math.round(Math.sqrt(slot.orthoPixels.length / 4)), 4) : null })
  }

  removeTile(slot: TileSlot): void {
    this.inputs.delete(slot.id)
    this.field.removeTile(slot.id)
  }

  /** Per frame, with the player's local position. */
  update(x: number, y: number): void {
    // at most one tile's rocks per frame, nearest first
    let next: TileInput | null = null
    for (const t of this.inputs.values()) {
      const has = this.field.hasTile(t.slot.id)
      if (has && t.slot.dist > DROP_M) this.field.removeTile(t.slot.id)
      else if (!has && t.slot.dist < GENERATE_M && (!next || t.slot.dist < next.slot.dist)) next = t
    }
    if (next) {
      const s = next.slot
      this.field.setTile(
        s.id,
        rocksInTile(s.id, {
          row: s.row,
          col: s.col,
          grid: this.opts.index,
          origin: this.opts.origin,
          heights: s.heights,
          sand: s.sand,
          rough: next.rough,
          demo: this.demoByTile.get(s.id),
        }),
      )
    }
    const b = this.builtAt
    if (!b || b.version !== this.field.version || Math.hypot(x - b.x, y - b.y) > REBUILD_M) {
      this.builtAt = { x, y, version: this.field.version }
      this.rebuild(x, y)
    }
  }

  /** Rocks drawn right now. */
  get drawn(): number {
    return this.shapes.reduce((n, s) => n + s.n, 0)
  }

  private rebuild(x: number, y: number): void {
    const shapes = this.shapes
    for (const s of shapes) s.n = 0
    this.contact.n = 0
    for (const t of this.field.tileRocks()) {
      const slot = this.inputs.get(t.id)?.slot
      const dist = slot ? Math.hypot(Math.max(slot.x0 - x, 0, x - slot.x1), Math.max(slot.y0 - y, 0, y - slot.y1)) : 0
      if (dist > LARGE_M) continue
      if (dist < SMALL_M) for (const k of t.bySize.small) this.place(t.rocks[k], x, y, SMALL_M)
      if (dist < MEDIUM_M) for (const k of t.bySize.medium) this.place(t.rocks[k], x, y, MEDIUM_M)
      for (const k of t.bySize.large) this.place(t.rocks[k], x, y, LARGE_M)
    }
    for (const s of shapes) {
      s.mesh.count = s.n
      s.mesh.instanceMatrix.needsUpdate = true
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true
    }
    this.contact.mesh.count = this.contact.n
    this.contact.mesh.instanceMatrix.needsUpdate = true
  }

  private place(r: Rock, x: number, y: number, reach: number): void {
    const dist = Math.hypot(r.x - x, r.y - y)
    if (dist > reach) return
    const v = r.variant % VARIANTS
    let level = r.d >= 0.3 ? (dist < NEAR_M ? 0 : dist < DETAIL_M ? 1 : 2) : dist < PEBBLE_DETAIL_M ? 1 : 2
    while (level < 2 && this.lods[level][v].n >= LOD_CAP[level]) level++
    const shape = this.lods[level][v]
    if (shape.n >= shape.mesh.instanceMatrix.count) return
    // centre: the base is BURY·h under the ground
    const at = localToThree({ x: r.x, y: r.y, z: r.z + r.h * (0.5 - BURY) })
    this.p.set(at.x, at.y, at.z)
    this.e.set(r.tilt, r.rot, 0, 'YXZ')
    this.q.setFromEuler(this.e)
    this.s.set(r.d, r.h, r.d * r.w)
    this.m.compose(this.p, this.q, this.s)
    shape.mesh.setMatrixAt(shape.n, this.m)
    // dark basalt to paler stone, and a little darker or lighter per rock
    const kind = hash2(Math.round(r.x * 10), Math.round(r.y * 10), 6)
    const pale = kind * kind
    const shade = 0.8 + 0.4 * hash2(Math.round(r.x * 10), Math.round(r.y * 10), 5)
    this.c.setRGB(
      (ROCK_DARK[0] + (ROCK_PALE[0] - ROCK_DARK[0]) * pale) * shade,
      (ROCK_DARK[1] + (ROCK_PALE[1] - ROCK_DARK[1]) * pale) * shade,
      (ROCK_DARK[2] + (ROCK_PALE[2] - ROCK_DARK[2]) * pale) * shade,
      THREE.SRGBColorSpace,
    )
    shape.mesh.setColorAt(shape.n, this.c)
    shape.n++

    if (r.d >= CONTACT_MIN_D && dist < CONTACT_M && this.contact.n < CONTACT_CAP) {
      // lie on the ground: tilt the square to the ground's slope over the rock's footprint
      let gx = 0
      let gy = 0
      const hf = this.opts.heights
      if (hf) {
        const b = Math.max(0.5, r.d * 0.6)
        gx = (hf.heightAt(r.x + b, r.y) - hf.heightAt(r.x - b, r.y)) / (2 * b)
        gy = (hf.heightAt(r.x, r.y + b) - hf.heightAt(r.x, r.y - b)) / (2 * b)
      }
      const n = localToThree({ x: -gx, y: -gy, z: 1 })
      this.up.set(n.x, n.y, n.z).normalize()
      const g = localToThree({ x: r.x, y: r.y, z: r.z + 0.02 })
      this.p.set(g.x, g.y, g.z)
      this.e.set(0, r.rot, 0, 'YXZ')
      this.q.setFromEuler(this.e)
      this.q2.setFromUnitVectors(this.yAxis, this.up)
      this.q.premultiply(this.q2)
      const reach = 1.5 + 0.25 / Math.max(0.25, r.d) // small rocks: a relatively wider halo
      this.s.set(r.d * reach, 1, r.d * r.w * reach)
      this.m.compose(this.p, this.q, this.s)
      this.contact.mesh.setMatrixAt(this.contact.n++, this.m)
    }
  }

  dispose(): void {
    for (const s of [...this.shapes, this.contact]) {
      s.mesh.removeFromParent()
      s.mesh.geometry.dispose()
      s.mesh.dispose()
    }
    this.material.dispose()
    this.contactMat.dispose()
    this.inputs.clear()
  }
}
