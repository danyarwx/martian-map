import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { HelmetEntry, HelmetExit } from './contracts.ts'
import { headingToDir, localToThree } from './frames.ts'
import './helmet.css'

interface Props {
  /** The plan and the jump point from Mission control. Null opens the helmet on its own (#helmet). */
  entry: HelmetEntry | null
  onExit: (exit: HelmetExit) => void
}

/** Eye height above the ground, metres. */
const EYE_M = 1.65
/** Walking speed on the level, m/s. Shift multiplies it. */
const WALK_MPS = 1.0
const FAST_FACTOR = 4

/**
 * Full-screen helmet view. Skeleton (T0.4): a flat plane under a Mars sky, walkable with W/A/S/D or the
 * arrow keys, mouse drag to look, Esc to go back. Terrain, CV and HUD arrive in later tasks.
 */
export default function HelmetView({ entry, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [fps, setFps] = useState(0)
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  useEffect(() => {
    const el = host.current
    if (!el) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.setSize(el.clientWidth, el.clientHeight)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const sky = new THREE.Color('#c99e78')
    scene.background = sky
    scene.fog = new THREE.Fog(sky, 200, 2500)

    const camera = new THREE.PerspectiveCamera(70, el.clientWidth / el.clientHeight, 0.1, 5000)
    scene.add(new THREE.HemisphereLight('#f3d6b8', '#5a3a26', 1.2))
    const sun = new THREE.DirectionalLight('#fff1dc', 1.6)
    sun.position.set(300, 400, 200)
    scene.add(sun)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000, 1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#9a6243', roughness: 1 }),
    )
    scene.add(ground)
    const grid = new THREE.GridHelper(4000, 400, '#6e4630', '#7d5038')
    grid.position.y = 0.01
    scene.add(grid)

    // Player state in local ENU (x east, y north, z up).
    const pose = { x: 0, y: 0, z: EYE_M, headingDeg: 0, pitchDeg: -5 }
    const keys = new Set<string>()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exitRef.current({ seen: null, hazards: [], plan: null })
        return
      }
      keys.add(e.key.toLowerCase())
    }
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())
    let dragX: number | null = null
    let dragY = 0
    const onDown = (e: PointerEvent) => {
      dragX = e.clientX
      dragY = e.clientY
      renderer.domElement.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (dragX === null) return
      pose.headingDeg = (pose.headingDeg - (e.clientX - dragX) * 0.15 + 360) % 360
      pose.pitchDeg = Math.max(-80, Math.min(80, pose.pitchDeg + (e.clientY - dragY) * 0.15))
      dragX = e.clientX
      dragY = e.clientY
    }
    const onUp = () => {
      dragX = null
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)

    const onResize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight)
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(el)

    let last = performance.now()
    let frames = 0
    let fpsFrom = last
    renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      const speed = WALK_MPS * (keys.has('shift') ? FAST_FACTOR : 1)
      const fwd = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0)
      const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0)
      if (fwd || side) {
        const f = headingToDir(pose.headingDeg)
        const r = headingToDir(pose.headingDeg + 90)
        const len = Math.hypot(fwd, side)
        pose.x += ((f.x * fwd + r.x * side) / len) * speed * dt
        pose.y += ((f.y * fwd + r.y * side) / len) * speed * dt
      }

      const eye = localToThree(pose)
      const d = localToThree(headingToDir(pose.headingDeg, pose.pitchDeg))
      camera.position.set(eye.x, eye.y, eye.z)
      camera.lookAt(eye.x + d.x, eye.y + d.y, eye.z + d.z)
      renderer.render(scene, camera)

      frames++
      if (now - fpsFrom > 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsFrom)))
        frames = 0
        fpsFrom = now
      }
    })

    return () => {
      renderer.setAnimationLoop(null)
      ro.disconnect()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
        }
      })
      grid.geometry.dispose()
      ;(grid.material as THREE.Material).dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div className="helmet">
      <div ref={host} className="helmet-canvas" />
      <div className="helmet-status" aria-live="polite">
        <span>{entry ? `Leg ${entry.legIndex + 1} of ${entry.plan.legs.length}` : 'Helmet test scene'}</span>
        <span>{fps} fps</span>
      </div>
      <p className="helmet-help">W A S D or arrows to walk · Shift to hurry · drag to look · Esc to go back</p>
    </div>
  )
}
