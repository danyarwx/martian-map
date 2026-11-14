import { useEffect, useState } from 'react'
import type { Stop } from '../../types'
import { normDeg } from '../geo'
import { panoramaSources } from '../walkScript'

/**
 * Azimuth of the panorama's left edge, in degrees from north. MMGIS cylindrical mosaics start at
 * azimuth 0. If the view turns out rotated against the map, correct it here once.
 */
export const PANO_AZ_OFFSET_DEG = 0

// Resolved image URL per stop: a string, or null when no source loaded (we then show a plain backdrop).
const resolved = new Map<string, string | null>()

function loadFirst(urls: string[]): Promise<string | null> {
  return urls.reduce<Promise<string | null>>(
    (prev, url) =>
      prev.then(
        (ok) =>
          ok ??
          new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve(url)
            img.onerror = () => resolve(null)
            img.src = url
          }),
      ),
    Promise.resolve(null),
  )
}

type Props = {
  stop: Stop
  headingDeg: number
  fovDeg: number
  width: number
  height: number
  horizonY: number
}

/** A 360° rover panorama cropped to the visor's field of view. Turning changes which slice shows. */
export default function Panorama({ stop, headingDeg, fovDeg, width, height, horizonY }: Props) {
  const [src, setSrc] = useState<string | null | undefined>(() => resolved.get(stop.id))

  useEffect(() => {
    if (resolved.has(stop.id)) {
      setSrc(resolved.get(stop.id))
      return
    }
    let alive = true
    setSrc(undefined)
    loadFirst(panoramaSources(stop)).then((url) => {
      resolved.set(stop.id, url)
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [stop])

  const pano = stop.panorama
  if (!src || !pano || width === 0) {
    return (
      <div className="hud-pano hud-pano--fallback" style={{ ['--horizon' as string]: `${horizonY}px` }}>
        <span className="hud-pano-note">{src === undefined ? 'Loading panorama…' : 'Panorama not available offline. Run npm run fetch-panoramas'}</span>
      </div>
    )
  }

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
      aria-label={`Perseverance panorama from sol ${stop.sol}`}
      style={{
        backgroundImage: `url("${src}")`,
        backgroundSize: `${bgW}px ${bgH}px`,
        backgroundPosition: `${x}px ${y}px`,
        height,
      }}
    />
  )
}
