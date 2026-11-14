// The helmet's three.js world: near terrain tiles, lights and haze. HelmetView owns the renderer and camera;
// this owns everything inside the scene and disposes it.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import type { Pose } from '../contracts.ts'
import { buildFarTerrain, FAR_HOLE_M, updateFarTerrain } from './farTerrain.ts'
import { HeightField, type CoarseGrid } from './heightField.ts'
import { RockLayer } from './rockMesh.ts'
import type { RoutesFileLeg } from './routes.ts'
import { Atmosphere } from './sky.ts'
import { makeDetailNormalMap } from './terrainMesh.ts'
import type { TileIndex } from './tileGrid.ts'
import { TileStreamer } from './tiles.ts'

export interface WorldInit {
  index: TileIndex
  coarse: CoarseGrid
  /** Session origin = local ENU (0, 0). */
  origin: LatLon
  renderer: THREE.WebGLRenderer
  /** routes.json legs: where the demo boulder fields go. */
  legs: readonly RoutesFileLeg[]
  /** Legs of the plan being walked (demo boulder fields go on them). */
  planLegs?: readonly { toId: string; path: LatLon[] }[]
}

export class World {
  readonly scene = new THREE.Scene()
  readonly heights: HeightField
  readonly tiles: TileStreamer
  /** Rocks orbit cannot see (simulated). `rocks.field.rocksNear` is the collision query. */
  readonly rocks: RockLayer
  private detail: THREE.DataTexture
  private terrainGroup = new THREE.Group()
  private rockGroup = new THREE.Group()
  readonly atmosphere: Atmosphere
  private far: THREE.Mesh

  constructor(init: WorldInit) {
    this.heights = new HeightField(init.index, init.origin, init.coarse)
    this.detail = makeDetailNormalMap()
    this.terrainGroup.name = 'near terrain'
    this.scene.add(this.terrainGroup)
    this.rockGroup.name = 'rocks'
    this.scene.add(this.rockGroup)
    this.rocks = new RockLayer({ group: this.rockGroup, index: init.index, origin: init.origin, legs: init.legs, planLegs: init.planLegs })

    this.atmosphere = new Atmosphere(this.scene, init.renderer, { latDeg: init.origin.lat })
    this.far = buildFarTerrain(init.coarse, init.origin)
    this.scene.add(this.far)

    this.tiles = new TileStreamer({
      index: init.index,
      origin: init.origin,
      heights: this.heights,
      coarse: init.coarse,
      group: this.terrainGroup,
      detail: this.detail,
      anisotropy: init.renderer.capabilities.getMaxAnisotropy(),
      onBuilt: (slot) => this.rocks.addTile(slot),
      onRemoved: (slot) => this.rocks.removeTile(slot),
    })
  }

  /** Per frame, with the eye pose in local ENU. */
  update(pose: Pose): void {
    this.tiles.update(pose.x, pose.y)
    this.rocks.update(pose.x, pose.y)
    this.atmosphere.update(pose)
    updateFarTerrain(this.far, pose.x, pose.y, this.tiles.readyAround(pose.x, pose.y, FAR_HOLE_M))
  }

  /** True when the ground around (x, y) is built. */
  readyAround(x: number, y: number): boolean {
    return this.tiles.readyAround(x, y)
  }

  /** True when the player stands on coarse terrain (no 1 m DTM tile). */
  coarseAt(x: number, y: number): boolean {
    return !this.heights.isFine(x, y)
  }

  dispose(): void {
    this.tiles.dispose()
    this.rocks.dispose()
    this.detail.dispose()
    this.atmosphere.dispose()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        ;(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
      }
    })
  }
}
