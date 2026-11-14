import { useEffect, useState } from 'react'
import type { Panorama as Pano, Stop } from '../../types'
import { normDeg } from '../geo'
import { drawnScenery } from './drawnScenery'

/**
 * Azimuth of the panorama's left edge, in degrees from north. The stitched Navcam panoramas
 * start at north (scripts/build_panoramas.py). If the view looks rotated against the map, correct it here.
 */
export const PANO_AZ_OFFSET_DEG = 0

type Loaded = { pano: Pano; real: boolean }

// Result per stop, so switching back to a stop doesn't reload or flicker.
const loaded = new Map<string, Loaded>()

function load(stop: Stop): Promise<Loaded> {
  const hit = loaded.get(stop.id)
  if (hit) return Promise.resolve(hit)
  const pano = stop.panorama
  const fallback = (): Loaded => ({ pano: drawnScenery(), real: false })
  const done = (r: Loaded) => {
    loaded.set(stop.id, r)
    return r
  }
  if (!pano) return Promise.resolve(done(fallback()))
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(done({ pano, real: true }))
    img.onerror = () => resolve(done(fallback()))
    img.src = pano.url
  })
}

type Props = {
  stop: Stop
  headingDeg: number
  fovDeg: number
  width: number
  height: number
  horizonY: number
  /** Tells the parent whether real rover imagery or the drawn backup is showing. */
  onSource?: (real: boolean) => void
}

/** A 360° panorama cropped to the visor's field of view. Turning changes which slice shows. */
export default function Panorama({ stop, headingDeg, fovDeg, width, height, horizonY, onSource }: Props) {
  const [state, setState] = useState<Loaded | undefined>(() => loaded.get(stop.id))

  useEffect(() => {
    let alive = true
    load(stop).then((r) => {
      if (!alive) return
      setState(r)
      onSource?.(r.real)
    })
    return () => {
      alive = false
    }
  }, [stop, onSource])

  if (!state || width === 0) return <div className="hud-pano" />

  const { pano } = state
  // Scale so the visor shows `fovDeg` of the 360° image, with the horizon row at horizonY.
  const scale = width / ((fovDeg / 360) * pano.columns)
  const bgW = pano.columns * scale
  const bgH = pano.rows * scale
  const leftAz = normDeg(headingDeg - fovDeg / 2 - PANO_AZ_OFFSET_DEG)
  const x = -(leftAz / 360) * bgW
  const y = horizonY - pano.elZeroRow * scale

  return (
    <div
      className="hud-pano"
      role="img"
      aria-label={state.real ? `Perseverance Navcam view from sol ${stop.sol}` : 'Drawn Mars scenery'}
      style={{
        backgroundImage: `url("${pano.url}")`,
        backgroundSize: `${bgW}px ${bgH}px`,
        backgroundPosition: `${x}px ${y}px`,
        height,
      }}
    />
  )
}
