import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { JEZERO } from '../data/jezero.ts'
import { loadTerrain } from '../lib/terrain.ts'
import type { HelmetEntry, HelmetExit } from './contracts.ts'
import { headingToDir, localToThree } from './frames.ts'
import { defaultEntry, loadRoutes } from './sim/defaultEntry.ts'
import { makeCoarseGrid } from './world/heightField.ts'
import { World } from './world/scene.ts'
import { headingAlong } from './world/path.ts'
import { loadTileIndex } from './world/tiles.ts'
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

interface Status {
  loading: boolean
  coarse: boolean
  error: string | null
}

/**
 * Full-screen helmet view: the real terrain around the planned route, walkable with W/A/S/D or the arrow keys,
 * mouse drag to look, Esc to go back.
 */
export default function HelmetView({ entry, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [fps, setFps] = useState(0)
  const [status, setStatus] = useState<Status>({ loading: true, coarse: false, error: null })
  const [planLabel, setPlanLabel] = useState(entry ? `Leg ${entry.legIndex + 1} of ${entry.plan.legs.length}` : 'Helmet test walk')
  const exitRef = useRef(onExit)
  exitRef.current = onExit
  const entryRef = useRef(entry)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const abort = new AbortController()

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    el.appendChild(renderer.domElement)
    const camera = new THREE.PerspectiveCamera(70, el.clientWidth / el.clientHeight, 0.1, 6000)
    let world: World | null = null

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

    Promise.all([loadTileIndex(abort.signal), loadTerrain(JEZERO.terrain), loadRoutes()])
      .then(([index, terrain, routes]) => {
        if (abort.signal.aborted) return
        const e = entryRef.current ?? defaultEntry(routes)
        if (!entryRef.current) setPlanLabel(`Test walk: ${e.plan.legs[0].fromId} → ${e.plan.legs[0].toId}`)
        world = new World({ index, coarse: makeCoarseGrid(terrain), origin: e.startAt, renderer, legs: routes.legs })
        // face along the route from the start point
        pose.headingDeg = headingAlong(e.plan.legs[e.legIndex].path, e.startAt)
        if (import.meta.env.DEV) {
          ;(window as unknown as Record<string, unknown>).__helmet = {
            pose,
            world: () => world,
            ready: () => world?.readyAround(pose.x, pose.y) ?? false,
            /** Extra metres above the eye, for looking at the world from above while debugging. */
            lift: 0,
            info: () => ({
              calls: renderer.info.render.calls,
              triangles: renderer.info.render.triangles,
              pending: world?.tiles.pending,
              tiles: world?.tiles.loaded,
              fine: world?.tiles.builtSlots().filter((s) => s.entry).length,
              coarse: world?.coarseAt(pose.x, pose.y),
              rocks: world?.rocks.field.count,
              rocksDrawn: world?.rocks.drawn,
              rocksNear: (r: number) => world?.rocks.field.rocksNear(pose.x, pose.y, r).map((k) => ({ x: k.x, y: k.y, z: k.z, d: k.d, h: k.h })),
              demoRocks: world?.rocks.field.demoRocks().map((r) => ({ x: r.x, y: r.y, d: r.d })),
            }),
          }
        }
      })
      .catch((err) => {
        if (abort.signal.aborted) return
        console.error(err)
        setStatus((s) => ({ ...s, loading: false, error: String(err?.message ?? err) }))
      })

    let last = performance.now()
    let frames = 0
    let fpsFrom = last
    let infoFrom = last
    let shownLoading = true
    let shownCoarse = false
    renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      if (world) {
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
        pose.z = world.heights.heightAt(pose.x, pose.y) + EYE_M
        if (import.meta.env.DEV) pose.z += ((window as unknown as { __helmet?: { lift: number } }).__helmet?.lift ?? 0)
        world.update(pose)

        const eye = localToThree(pose)
        const d = localToThree(headingToDir(pose.headingDeg, pose.pitchDeg))
        camera.position.set(eye.x, eye.y, eye.z)
        camera.lookAt(eye.x + d.x, eye.y + d.y, eye.z + d.z)
        renderer.render(world.scene, camera)

        const loading = !world.readyAround(pose.x, pose.y)
        const coarse = world.coarseAt(pose.x, pose.y)
        if (loading !== shownLoading || coarse !== shownCoarse) {
          shownLoading = loading
          shownCoarse = coarse
          setStatus((s) => ({ ...s, loading, coarse }))
        }
      } else {
        renderer.clear()
      }

      frames++
      if (now - fpsFrom > 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsFrom)))
        frames = 0
        fpsFrom = now
      }
      if (import.meta.env.DEV && now - infoFrom > 5000) {
        infoFrom = now
        const i = renderer.info
        console.debug(`helmet: ${i.render.calls} draw calls, ${i.render.triangles} triangles, ${i.memory.geometries} geometries, ${i.memory.textures} textures`)
      }
    })

    return () => {
      abort.abort()
      renderer.setAnimationLoop(null)
      ro.disconnect()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      world?.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__helmet
    }
  }, [])

  return (
    <div className="helmet">
      <div ref={host} className="helmet-canvas" />
      <div className="helmet-status" aria-live="polite">
        <span>{planLabel}</span>
        {status.loading && <span>Loading terrain…</span>}
        {status.coarse && !status.loading && <span className="helmet-flag">coarse terrain</span>}
        {status.error && <span className="helmet-flag">{status.error}</span>}
        <span>{fps} fps</span>
      </div>
      <p className="helmet-help">W A S D or arrows to walk · Shift to hurry · drag to look · Esc to go back</p>
    </div>
  )
}
