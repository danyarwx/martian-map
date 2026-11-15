// Keyboard and mouse for the helmet (docs/helmet/PLAN.md §6.3): W/A/S/D or arrows walk, Shift hurries, drag looks.
// One-shot keys (J, V, R, M, P, H, Esc) are the view's business; this only tracks what is held down.
import type { Pose } from '../contracts.ts'
import type { MoveInput } from './player.ts'

const LOOK_DEG_PER_PX = 0.15

export class Controls {
  /** Set false to freeze walking and looking (menus, pause). */
  enabled = true
  private keys = new Set<string>()
  private drag: { x: number; y: number } | null = null
  private el: HTMLElement
  private pose: Pose

  constructor(el: HTMLElement, pose: Pose) {
    this.el = el
    this.pose = pose
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointercancel', this.onUp)
  }

  input(): MoveInput {
    const k = this.keys
    if (!this.enabled) return { fwd: 0, side: 0, fast: false }
    return {
      fwd: (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0),
      side: (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0),
      fast: k.has('shift'),
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.el.removeEventListener('pointerdown', this.onDown)
    this.el.removeEventListener('pointermove', this.onMove)
    this.el.removeEventListener('pointerup', this.onUp)
    this.el.removeEventListener('pointercancel', this.onUp)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
    this.keys.add(e.key.toLowerCase())
  }
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase())
  private onBlur = () => this.keys.clear()
  private onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY }
    this.el.setPointerCapture(e.pointerId)
  }
  private onMove = (e: PointerEvent) => {
    if (!this.drag || !this.enabled) return
    const p = this.pose
    p.headingDeg = (((p.headingDeg - (e.clientX - this.drag.x) * LOOK_DEG_PER_PX) % 360) + 360) % 360
    p.pitchDeg = Math.max(-80, Math.min(80, p.pitchDeg + (e.clientY - this.drag.y) * LOOK_DEG_PER_PX))
    this.drag = { x: e.clientX, y: e.clientY }
  }
  private onUp = () => {
    this.drag = null
  }
}
