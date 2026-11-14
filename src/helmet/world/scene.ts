// The helmet's three.js world: near terrain tiles, lights and haze. HelmetView owns the renderer and camera;
// this owns everything inside the scene and disposes it.
import * as THREE from 'three'
import type { LatLon } from '../../types.ts'
import type { Pose } from '../contracts.ts'
import { HeightField, type CoarseGrid } from './heightField.ts'
import { makeDetailNormalMap } from './terrainMesh.ts'
import type { TileIndex } from './tileGrid.ts'
import { TileStreamer } from './tiles.ts'

export interface WorldInit {
  index: TileIndex
  coarse: CoarseGrid
  /** Session origin = local ENU (0, 0). */
  origin: LatLon
  renderer: THREE.WebGLRenderer
}

export class World {
  readonly scene = new THREE.Scene()
  readonly heights: HeightField
  readonly tiles: TileStreamer
  private detail: THREE.DataTexture
  private terrainGroup = new THREE.Group()

  constructor(init: WorldInit) {
    this.heights = new HeightField(init.index, init.origin, init.coarse)
    this.detail = makeDetailNormalMap()
    this.terrainGroup.name = 'near terrain'
    this.scene.add(this.terrainGroup)

    const haze = new THREE.Color('#c9a07a')
    this.scene.background = haze
    this.scene.fog = new THREE.Fog(haze, 200, 2500)
    this.scene.add(new THREE.HemisphereLight('#f3d6b8', '#5a3a26', 1.1))
    const sun = new THREE.DirectionalLight('#fff1dc', 2.2)
    sun.position.set(300, 500, 200)
    this.scene.add(sun)

    this.tiles = new TileStreamer({
      index: init.index,
      origin: init.origin,
      heights: this.heights,
      coarse: init.coarse,
      group: this.terrainGroup,
      detail: this.detail,
      anisotropy: init.renderer.capabilities.getMaxAnisotropy(),
    })
  }

  /** Per frame, with the eye pose in local ENU. */
  update(pose: Pose): void {
    this.tiles.update(pose.x, pose.y)
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
    this.detail.dispose()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        ;(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
      }
    })
  }
}
