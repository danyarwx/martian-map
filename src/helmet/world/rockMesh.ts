// Draws the rocks of rocks.ts (docs/helmet/PLAN.md §6.2): a few shared low-poly rock shapes, instanced.
//
// A tile holds thousands of rocks (most of them 15–30 cm), so rocks are only generated for tiles near the player
// and only the ones that matter at their distance are drawn: everything within 20 m, rocks from 0.3 m within 60 m,
// rocks from 0.6 m and the demo boulders within 150 m. Close rocks use an 80-triangle shape, the rest a
// 20-triangle one. The instance lists are rebuilt when the player has moved a few metres.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import { localToThree } from '../frames.ts'
import { hash2, mulberry32 } from './noise.ts'
import { BURY, demoBoulderFields, demoRocksByTile, RockField, rocksInTile, roughGrid, VARIANTS, type DemoField, type DemoRock, type Rock } from './rocks.ts'
import type { RoutesFileLeg } from './routes.ts'
import type { TileIndex } from './tileGrid.ts'
import type { TileSlot } from './tiles.ts'

/** Rocks are generated for tiles nearer than this and dropped beyond DROP_M, metres. */
const GENERATE_M = 170
const DROP_M = 260
/** Draw distances by size class, metres. */
const SMALL_M = 20
const MEDIUM_M = 60
const LARGE_M = 150
/** Within this distance rocks from 0.3 m use the detailed shape. */
const DETAIL_M = 40
/** Instances per shape. */
const CAP_HI = 700
const CAP_LO = 1800
/** Rebuild the instance lists after the player moved this far, metres. */
const REBUILD_M = 3

interface TileInput {
  slot: TileSlot
  rough: Uint8Array | null
}

/** A unit rock (1 m across, 1 m tall, centred): an icosahedron with its corners pushed in and out. */
function rockGeometry(variant: number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, detail)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const rnd = mulberry32(977 + variant * 131)
  const seed = Math.floor(rnd() * 1e6)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // the same corner appears in several triangles: the bump depends on the position only
    const k = hash2(Math.round(v.x * 1000) + Math.round(v.z * 1000) * 7919, Math.round(v.y * 1000), seed)
    const flat = v.y < 0 ? 0.6 : 1 // flatter underside
    v.multiplyScalar(0.78 + 0.44 * k)
    v.y *= flat
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
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
}

export class RockLayer {
  readonly field = new RockField()
  /** The demo boulder fields (one per demo window). */
  readonly demoFields: DemoField[]
  private demoByTile: Map<string, DemoRock[]>
  private inputs = new Map<string, TileInput>()
  private hi: Shape[] = []
  private lo: Shape[] = []
  private material: THREE.MeshStandardMaterial
  private opts: RockLayerOptions
  private builtAt: { x: number; y: number; version: number } | null = null
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private s = new THREE.Vector3()
  private p = new THREE.Vector3()
  private c = new THREE.Color()

  constructor(opts: RockLayerOptions) {
    this.opts = opts
    const planned = (stopId: string) => {
      const leg = opts.planLegs?.find((l) => l.toId === stopId && l.path.length > 1)
      return leg ? { legId: `plan>${stopId}`, path: leg.path } : null
    }
    this.demoFields = demoBoulderFields(opts.index.windows ?? [], opts.legs, planned)
    this.demoByTile = demoRocksByTile(this.demoFields, opts.index)
    this.material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0, flatShading: true })
    for (let v = 0; v < VARIANTS; v++) {
      this.hi.push(this.shape(rockGeometry(v, 1), CAP_HI, `rocks near ${v}`))
      this.lo.push(this.shape(rockGeometry(v, 0), CAP_LO, `rocks far ${v}`))
    }
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
    return [...this.hi, ...this.lo].reduce((n, s) => n + s.n, 0)
  }

  private rebuild(x: number, y: number): void {
    for (const s of [...this.hi, ...this.lo]) s.n = 0
    for (const t of this.field.tileRocks()) {
      const slot = this.inputs.get(t.id)?.slot
      const dist = slot ? Math.hypot(Math.max(slot.x0 - x, 0, x - slot.x1), Math.max(slot.y0 - y, 0, y - slot.y1)) : 0
      if (dist > LARGE_M) continue
      if (dist < SMALL_M) for (const k of t.bySize.small) this.place(t.rocks[k], x, y, SMALL_M)
      if (dist < MEDIUM_M) for (const k of t.bySize.medium) this.place(t.rocks[k], x, y, MEDIUM_M)
      for (const k of t.bySize.large) this.place(t.rocks[k], x, y, LARGE_M)
    }
    for (const s of [...this.hi, ...this.lo]) {
      s.mesh.count = s.n
      s.mesh.instanceMatrix.needsUpdate = true
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true
    }
  }

  private place(r: Rock, x: number, y: number, reach: number): void {
    const dist = Math.hypot(r.x - x, r.y - y)
    if (dist > reach) return
    const shape = (dist < DETAIL_M && r.d >= 0.3 ? this.hi : this.lo)[r.variant % VARIANTS]
    if (shape.n >= shape.mesh.instanceMatrix.count) return
    // centre: the base is BURY·h under the ground
    const at = localToThree({ x: r.x, y: r.y, z: r.z + r.h * (0.5 - BURY) })
    this.p.set(at.x, at.y, at.z)
    this.e.set(r.tilt, r.rot, 0, 'YXZ')
    this.q.setFromEuler(this.e)
    this.s.set(r.d, r.h, r.d * r.w)
    this.m.compose(this.p, this.q, this.s)
    shape.mesh.setMatrixAt(shape.n, this.m)
    // Mars rock, a little darker or lighter per rock
    const shade = 0.75 + 0.4 * hash2(Math.round(r.x * 10), Math.round(r.y * 10), 5)
    shape.mesh.setColorAt(shape.n, this.c.setRGB(0.4 * shade, 0.29 * shade, 0.23 * shade, THREE.SRGBColorSpace))
    shape.n++
  }

  dispose(): void {
    for (const s of [...this.hi, ...this.lo]) {
      s.mesh.removeFromParent()
      s.mesh.geometry.dispose()
      s.mesh.dispose()
    }
    this.material.dispose()
    this.inputs.clear()
  }
}
