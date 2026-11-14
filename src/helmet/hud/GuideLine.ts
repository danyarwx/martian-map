// The guide line on the ground (docs/helmet/PLAN.md §5.8, §7.1): the local planner's path round the hazards, as a
// ribbon draped over the terrain. It lives on layer 1, which only the main camera sees: the CV cameras (layer 0)
// must look at the bare world, never at what the helmet drew.
import * as THREE from 'three'
import { localToThree } from '../frames.ts'

export const HUD_LAYER = 1
const WIDTH_M = 0.22
const LIFT_M = 0.07
const MAX_POINTS = 160

export class GuideLine {
  readonly mesh: THREE.Mesh
  private geometry = new THREE.BufferGeometry()
  private material = new THREE.MeshBasicMaterial({ color: '#8fe3d6', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false })
  private pos = new Float32Array(MAX_POINTS * 2 * 3)

  constructor(scene: THREE.Scene) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    const index: number[] = []
    for (let k = 0; k < MAX_POINTS - 1; k++) index.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2)
    this.geometry.setIndex(index)
    this.geometry.setDrawRange(0, 0)
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'guide line'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
    this.mesh.layers.set(HUD_LAYER)
    scene.add(this.mesh)
  }

  /** Draw `path` (local ENU) on the ground. An empty path hides the line. */
  set(path: readonly { x: number; y: number }[], heightAt: (x: number, y: number) => number, blocked: boolean): void {
    const n = Math.min(MAX_POINTS, path.length)
    if (n < 2) {
      this.geometry.setDrawRange(0, 0)
      return
    }
    for (let k = 0; k < n; k++) {
      const a = path[Math.max(0, k - 1)]
      const b = path[Math.min(n - 1, k + 1)]
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      // unit normal to the direction of travel, in the ground plane
      const nx = (-(b.y - a.y) / len) * (WIDTH_M / 2)
      const ny = ((b.x - a.x) / len) * (WIDTH_M / 2)
      const p = path[k]
      for (const s of [-1, 1]) {
        const x = p.x + s * nx
        const y = p.y + s * ny
        const t = localToThree({ x, y, z: heightAt(x, y) + LIFT_M })
        const o = (2 * k + (s < 0 ? 0 : 1)) * 3
        this.pos[o] = t.x
        this.pos[o + 1] = t.y
        this.pos[o + 2] = t.z
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true
    this.geometry.setDrawRange(0, (n - 1) * 6)
    this.material.color.set(blocked ? '#ff5a4e' : '#8fe3d6')
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
  }
}
