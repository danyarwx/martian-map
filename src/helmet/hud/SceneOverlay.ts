// What the helmet draws INTO the view (FIXLIST A4, C3, C4): an outline round every rock the CV found, a hatch on
// the ground the hazard map calls sand, and the guide as chevrons on the ground. One 2D canvas over the 3D view,
// redrawn every frame with the main camera's projection, so the marks stay glued to the scene.
//
// Inputs are the CV's own outputs (rock tracks, hazard grid) and the guide path. The world's rock list is never
// read. Being a separate canvas, none of it is in the pictures the CV cameras take.
import * as THREE from 'three'
import { HAZARD } from '../contracts.ts'
import { GRID_CELL_M, localToThree } from '../frames.ts'
import type { HazardGrid } from '../mapping/hazardGrid.ts'
import type { RockTrack } from '../mapping/rockTracks.ts'

export const HUD_GREEN = '#6dffa8'
export const HUD_AMBER = '#ffb347'
export const HUD_RED = '#ff5d4d'

const SAND_RANGE_M = 14
const CHEVRON_FIRST_M = 3
const CHEVRON_STEP_M = 2.5
const CHEVRON_LAST_M = 30
const FADE_IN_MS = 700
/** Rock labels (height · distance) on the nearest few hazard rocks. */
const LABELS = 3
const ROCK_RANGE_M = 30

export interface OverlayFrame {
  camera: THREE.PerspectiveCamera
  /** Astronaut's eye, local ENU. */
  pose: { x: number; y: number; z: number }
  rocks: readonly RockTrack[]
  grid: HazardGrid
  gridVersion: number
  /** Guide path ahead (local ENU), and how it is doing. */
  path: readonly { x: number; y: number }[]
  guide: 'route' | 'detour' | 'blocked'
  /** Terrain height under a point, for marks that lie on the ground. */
  heightAt: (x: number, y: number) => number
  /** Milliseconds, the same clock as the rock tracks. */
  now: number
}

interface Screen {
  x: number
  y: number
  /** Distance along the view axis, metres. */
  depth: number
}

export class SceneOverlay {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private v = new THREE.Vector3()
  private w = 0
  private h = 0
  private scale = 1
  private sand: Float32Array = new Float32Array(0)
  private sandN = 0
  private sandVersion = -1
  private sandAt = { x: NaN, y: NaN }

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'helmet-scene-overlay'
    this.canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
    this.resize(host.clientWidth, host.clientHeight)
  }

  resize(width: number, height: number): void {
    this.scale = Math.min(2, window.devicePixelRatio || 1)
    this.w = width
    this.h = height
    this.canvas.width = Math.max(1, Math.round(width * this.scale))
    this.canvas.height = Math.max(1, Math.round(height * this.scale))
  }

  private project(cam: THREE.PerspectiveCamera, x: number, y: number, z: number, out: Screen): boolean {
    const t = localToThree({ x, y, z })
    const v = this.v.set(t.x, t.y, t.z).applyMatrix4(cam.matrixWorldInverse)
    if (v.z > -0.4) return false
    out.depth = -v.z
    v.applyMatrix4(cam.projectionMatrix)
    out.x = (v.x * 0.5 + 0.5) * this.w
    out.y = (0.5 - v.y * 0.5) * this.h
    return true
  }

  draw(f: OverlayFrame): void {
    const { ctx } = this
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    f.camera.updateMatrixWorld()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    this.drawSand(f)
    this.drawChevrons(f)
    this.drawRocks(f)
  }

  /** Sand cells near the astronaut, re-read when the hazard map changed or the astronaut moved 2 m. */
  private refreshSand(f: OverlayFrame): void {
    const moved = !(Math.hypot(f.pose.x - this.sandAt.x, f.pose.y - this.sandAt.y) < 2)
    if (!moved && f.gridVersion === this.sandVersion) return
    this.sandVersion = f.gridVersion
    this.sandAt = { x: f.pose.x, y: f.pose.y }
    const n = Math.ceil((2 * SAND_RANGE_M) / GRID_CELL_M)
    if (this.sand.length < n * n * 3) this.sand = new Float32Array(n * n * 3)
    let k = 0
    const x0 = Math.floor((f.pose.x - SAND_RANGE_M) / GRID_CELL_M)
    const y0 = Math.floor((f.pose.y - SAND_RANGE_M) / GRID_CELL_M)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = (x0 + i + 0.5) * GRID_CELL_M
        const y = (y0 + j + 0.5) * GRID_CELL_M
        if ((x0 + i + y0 + j) % 2 || Math.hypot(x - f.pose.x, y - f.pose.y) > SAND_RANGE_M || f.grid.classAt(x, y) !== HAZARD.sand) continue // every other cell: a fine hatch, not a carpet
        this.sand[k++] = x
        this.sand[k++] = y
        this.sand[k++] = f.heightAt(x, y) + 0.03
      }
    this.sandN = k / 3
  }

  /** A fine hatch on loose sand: one diagonal stroke per 0.5 m cell, lying on the ground. */
  private drawSand(f: OverlayFrame): void {
    this.refreshSand(f)
    if (!this.sandN) return
    const { ctx } = this
    const a: Screen = { x: 0, y: 0, depth: 0 }
    const b: Screen = { x: 0, y: 0, depth: 0 }
    const hc = GRID_CELL_M / 2
    ctx.shadowBlur = 0
    ctx.lineWidth = 1
    // three depth bands, so the hatch thins out with distance
    for (const [near, far, alpha] of [[0, 5, 0.55], [5, 9, 0.38], [9, SAND_RANGE_M, 0.22]] as const) {
      ctx.strokeStyle = HUD_AMBER
      ctx.globalAlpha = alpha
      ctx.beginPath()
      for (let k = 0; k < this.sandN; k++) {
        const x = this.sand[k * 3]
        const y = this.sand[k * 3 + 1]
        const z = this.sand[k * 3 + 2]
        const d = Math.hypot(x - f.pose.x, y - f.pose.y)
        if (d < near || d >= far) continue
        if (!this.project(f.camera, x - hc, y - hc, z, a) || !this.project(f.camera, x + hc, y + hc, z, b)) continue
        if ((a.x < 0 && b.x < 0) || (a.x > this.w && b.x > this.w) || (a.y > this.h && b.y > this.h)) continue
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  /** The guide: chevrons lying on the ground along the path, pointing the way, fading out by 30 m. */
  private drawChevrons(f: OverlayFrame): void {
    const path = f.path
    if (path.length < 2) return
    const { ctx } = this
    const colour = f.guide === 'blocked' ? HUD_RED : f.guide === 'detour' ? HUD_AMBER : HUD_GREEN
    const tip: Screen = { x: 0, y: 0, depth: 0 }
    const l: Screen = { x: 0, y: 0, depth: 0 }
    const r: Screen = { x: 0, y: 0, depth: 0 }
    // the chevrons drift forward slowly, so the direction reads at a glance
    let want = CHEVRON_FIRST_M + ((f.now / 1000) * 0.6) % CHEVRON_STEP_M
    let s = 0
    ctx.strokeStyle = colour
    ctx.shadowColor = colour
    for (let k = 1; k < path.length && want <= CHEVRON_LAST_M; k++) {
      const p0 = path[k - 1]
      const p1 = path[k]
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      if (len < 1e-6) continue
      const tx = (p1.x - p0.x) / len
      const ty = (p1.y - p0.y) / len
      while (want <= s + len && want <= CHEVRON_LAST_M) {
        const u = want - s
        const x = p0.x + tx * u
        const y = p0.y + ty * u
        const wing = 0.38
        const back = 0.42
        const z = (px: number, py: number) => f.heightAt(px, py) + 0.05
        const ok =
          this.project(f.camera, x + tx * 0.2, y + ty * 0.2, z(x, y), tip) &&
          this.project(f.camera, x - tx * back - ty * wing, y - ty * back + tx * wing, z(x, y), l) &&
          this.project(f.camera, x - tx * back + ty * wing, y - ty * back - tx * wing, z(x, y), r)
        if (ok) {
          const fade = Math.min(1, (want - CHEVRON_FIRST_M + 0.6) / 1.5) * Math.max(0, 1 - (want - 8) / (CHEVRON_LAST_M - 8)) ** 1.3
          ctx.globalAlpha = Math.min(1, 0.95 * fade)
          ctx.lineWidth = Math.max(1, Math.min(4, 9 / tip.depth))
          ctx.shadowBlur = 6
          ctx.beginPath()
          ctx.moveTo(l.x, l.y)
          ctx.lineTo(tip.x, tip.y)
          ctx.lineTo(r.x, r.y)
          ctx.stroke()
        }
        want += CHEVRON_STEP_M
      }
      s += len
    }
    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
  }

  /** Outline round each rock the CV found: solid for hazard rocks, thin dashes for small ones. */
  private drawRocks(f: OverlayFrame): void {
    const { ctx } = this
    const focal = this.h / 2 / Math.tan((f.camera.fov * Math.PI) / 360)
    const base: Screen = { x: 0, y: 0, depth: 0 }
    const top: Screen = { x: 0, y: 0, depth: 0 }
    const labelled = f.rocks
      .filter((t) => t.level === 'hazard' && t.hits >= 2)
      .map((t) => ({ t, d: Math.hypot(t.x - f.pose.x, t.y - f.pose.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LABELS)
      .map((e) => e.t.id)
    ctx.font = '11px Menlo, Consolas, "Courier New", monospace'
    ctx.textBaseline = 'bottom'
    for (const t of f.rocks) {
      if (t.hits < 2) continue // one sighting may be noise
      const dist = Math.hypot(t.x - f.pose.x, t.y - f.pose.y)
      if (dist > ROCK_RANGE_M) continue
      const gz = t.groundZ ?? f.heightAt(t.x, t.y)
      if (!this.project(f.camera, t.x, t.y, gz, base) || !this.project(f.camera, t.x, t.y, gz + t.heightM, top)) continue
      const rx = Math.max(3, (t.radiusM * focal) / base.depth)
      const ry = Math.max(3, base.y - top.y)
      if (base.x < -rx || base.x > this.w + rx || top.y > this.h || base.y < 0) continue
      const hazard = t.level === 'hazard'
      const stale = Math.max(0, 1 - (f.now - t.lastSeen) / 8000)
      const alpha = Math.min(1, (f.now - t.firstSeen) / FADE_IN_MS) * (0.35 + 0.65 * stale) * Math.max(0.25, 1 - dist / ROCK_RANGE_M)
      const colour = hazard ? HUD_RED : HUD_GREEN
      ctx.globalAlpha = hazard ? alpha : alpha * 0.75
      ctx.strokeStyle = colour
      ctx.shadowColor = colour
      ctx.shadowBlur = hazard ? 7 : 0
      ctx.lineWidth = hazard ? 1.6 : 1
      ctx.setLineDash(hazard ? [] : [3, 4])
      // a dome over the rock, and the curve of its foot on the ground
      ctx.beginPath()
      ctx.ellipse(base.x, base.y, rx, ry, 0, Math.PI, 2 * Math.PI)
      ctx.ellipse(base.x, base.y, rx, Math.max(1.5, rx * 0.22), 0, 0, Math.PI)
      ctx.closePath()
      ctx.stroke()
      ctx.setLineDash([])
      if (hazard && labelled.includes(t.id)) {
        // corner ticks and a label on the nearest few
        const label = `${t.heightM.toFixed(1)} m · ${dist < 10 ? dist.toFixed(1) : Math.round(dist)} m`
        ctx.shadowBlur = 4
        ctx.fillStyle = colour
        ctx.fillText(label, base.x + rx + 5, top.y + 4)
        ctx.beginPath()
        ctx.moveTo(base.x + rx * 0.7, top.y + ry * 0.3)
        ctx.lineTo(base.x + rx + 3, top.y + 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
  }

  dispose(): void {
    this.canvas.remove()
  }
}
