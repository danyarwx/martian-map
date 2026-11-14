import { useEffect, useRef } from 'react'
import type { HelmetSession, HudState } from '../session.ts'

interface Props {
  session: HelmetSession
  /** The latest HUD state: the map redraws whenever it changes. */
  hud: HudState
  large: boolean
}

/** Half-width of the ground shown, metres, and the scale bar length. */
const SMALL = { px: 190, halfM: 25, barM: 10 }
const LARGE = { px: 380, halfM: 60, barM: 20 }

/**
 * The helmet's top-down hazard map (PLAN §7.1): ground the camera has seen, coloured safe / rock / sand / steep /
 * drop, with the planned route, the guide line and the astronaut. North is up.
 */
export default function MiniMap({ session, hud, large }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const cfg = large ? LARGE : SMALL

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const size = cfg.px * dpr
    if (canvas.width !== size) canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { x, y, headingDeg } = hud.pose
    const scale = size / (2 * cfg.halfM) // pixels per metre
    const px = (mx: number) => (mx - x) * scale + size / 2
    const py = (my: number) => (y - my) * scale + size / 2
    ctx.clearRect(0, 0, size, size)

    // what the helmet has seen
    const img = session.hazards.grid.toImage({ minX: x - cfg.halfM, maxX: x + cfg.halfM, minY: y - cfg.halfM, maxY: y + cfg.halfM })
    if (img.width && img.height) {
      const s = (scratch.current ??= document.createElement('canvas'))
      if (s.width !== img.width || s.height !== img.height) {
        s.width = img.width
        s.height = img.height
      }
      const sctx = s.getContext('2d')
      if (sctx) {
        sctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(s, px(img.x0), py(img.y0), img.width * 0.5 * scale, img.height * 0.5 * scale)
      }
    }

    // planned route
    const t = session.track
    ctx.lineWidth = 1.5 * dpr
    ctx.strokeStyle = 'rgba(232, 236, 241, 0.85)'
    ctx.setLineDash([4 * dpr, 4 * dpr])
    ctx.beginPath()
    let pen = false
    for (let k = 0; k < t.n; k++) {
      const inside = Math.abs(t.x[k] - x) < cfg.halfM * 1.5 && Math.abs(t.y[k] - y) < cfg.halfM * 1.5
      if (!inside) {
        pen = false
        continue
      }
      if (pen) ctx.lineTo(px(t.x[k]), py(t.y[k]))
      else ctx.moveTo(px(t.x[k]), py(t.y[k]))
      pen = true
    }
    ctx.stroke()
    ctx.setLineDash([])

    // guide line round the hazards
    const guide = session.guide
    if (guide && guide.path.length > 1) {
      ctx.lineWidth = 2.5 * dpr
      ctx.strokeStyle = guide.blocked ? '#ff5a4e' : '#8fe3d6'
      ctx.beginPath()
      guide.path.forEach((p, k) => (k ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))))
      ctx.stroke()
    }

    // astronaut
    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.rotate((headingDeg * Math.PI) / 180)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#0a1212'
    ctx.lineWidth = dpr
    ctx.beginPath()
    ctx.moveTo(0, -8 * dpr)
    ctx.lineTo(5.5 * dpr, 6 * dpr)
    ctx.lineTo(0, 3 * dpr)
    ctx.lineTo(-5.5 * dpr, 6 * dpr)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    // scale bar and north
    const bar = cfg.barM * scale
    ctx.strokeStyle = ctx.fillStyle = '#8fe3d6'
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.moveTo(10 * dpr, size - 10 * dpr)
    ctx.lineTo(10 * dpr + bar, size - 10 * dpr)
    ctx.stroke()
    ctx.font = `${11 * dpr}px Menlo, Consolas, monospace`
    ctx.fillText(`${cfg.barM} m`, 10 * dpr, size - 15 * dpr)
    ctx.fillText('N', size - 18 * dpr, 16 * dpr)
  }, [session, hud, cfg])

  return (
    <div className={`helmet-minimap${large ? ' is-large' : ''}`} style={{ width: cfg.px, height: cfg.px }}>
      <canvas ref={ref} style={{ width: cfg.px, height: cfg.px }} aria-label="Hazard map of the ground the helmet has seen" />
      <ul className="helmet-legend" aria-hidden="true">
        <li className="hz-safe">safe</li>
        <li className="hz-rock">rock</li>
        <li className="hz-sand">sand</li>
        <li className="hz-steep">steep</li>
        <li className="hz-drop">drop</li>
      </ul>
    </div>
  )
}
