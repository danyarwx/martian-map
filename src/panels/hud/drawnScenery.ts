// Backup scenery for the helmet view: a drawn, seamless 360° Mars landscape.
// Used only when a stop's real panorama can't be loaded, so the demo never shows a blank visor.
import type { Panorama } from '../../types'

const PX_PER_DEG = 10
const W = 360 * PX_PER_DEG
const H = 600
const HORIZON = 330

let cached: Panorama | null = null

export function drawnScenery(): Panorama {
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2D canvas not available')

  // small seeded PRNG so the scenery is the same every time
  let seed = 7
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const sky = g.createLinearGradient(0, 0, 0, HORIZON)
  sky.addColorStop(0, '#b98a63')
  sky.addColorStop(0.7, '#dcb48b')
  sky.addColorStop(1, '#e9c9a2')
  g.fillStyle = sky
  g.fillRect(0, 0, W, HORIZON + 2)

  // ridges built from whole-number sine waves, so the left and right edges meet seamlessly
  const ridge = (base: number, waves: [number, number][], color: string) => {
    const phased = waves.map(([k, a]) => [k, a, rnd() * Math.PI * 2] as const)
    g.beginPath()
    g.moveTo(0, H)
    for (let x = 0; x <= W; x += 4) {
      const ang = (x / W) * Math.PI * 2
      let h = 0
      for (const [k, a, p] of phased) h += a * Math.sin(k * ang + p)
      g.lineTo(x, base - h)
    }
    g.lineTo(W, H)
    g.closePath()
    g.fillStyle = color
    g.fill()
  }
  ridge(HORIZON - 18, [[3, 22], [7, 10], [13, 5], [29, 2]], '#b07a58')
  ridge(HORIZON - 4, [[2, 12], [5, 9], [11, 6], [23, 3], [47, 1.5]], '#94603f')

  const ground = g.createLinearGradient(0, HORIZON, 0, H)
  ground.addColorStop(0, '#9a6243')
  ground.addColorStop(1, '#5e3521')
  g.fillStyle = ground
  g.fillRect(0, HORIZON + 6, W, H - HORIZON)

  for (let i = 0; i < 9000; i++) {
    const y = HORIZON + 8 + Math.pow(rnd(), 0.8) * (H - HORIZON)
    g.fillStyle = rnd() < 0.5 ? 'rgba(40,20,10,0.18)' : 'rgba(230,180,140,0.10)'
    const s = 1 + (y - HORIZON) / 120
    g.fillRect(rnd() * W, y, s * 2, s * 0.7)
  }

  const rock = (x: number, y: number, r: number) => {
    g.fillStyle = 'rgba(30,14,8,0.35)'
    g.beginPath()
    g.ellipse(x + r * 0.3, y + r * 0.25, r * 1.1, r * 0.35, 0, 0, Math.PI * 2)
    g.fill()
    const grd = g.createLinearGradient(x - r, y - r, x + r, y)
    grd.addColorStop(0, '#7b4a33')
    grd.addColorStop(1, '#3a2016')
    g.fillStyle = grd
    g.beginPath()
    g.ellipse(x, y - r * 0.3, r, r * 0.6, 0, Math.PI, 0)
    g.lineTo(x + r, y - r * 0.2)
    g.lineTo(x - r, y - r * 0.2)
    g.fill()
  }
  for (let i = 0; i < 420; i++) {
    const t = Math.pow(rnd(), 1.6)
    const y = HORIZON + 10 + t * (H - HORIZON - 20)
    const x = rnd() * W
    const r = 1.5 + t * 16 * (0.4 + rnd())
    rock(x, y, r)
    if (x < 40) rock(x + W, y, r)
    if (x > W - 40) rock(x - W, y, r)
  }

  cached = { url: canvas.toDataURL('image/jpeg', 0.85), columns: W, rows: H, elZeroRow: HORIZON }
  return cached
}
