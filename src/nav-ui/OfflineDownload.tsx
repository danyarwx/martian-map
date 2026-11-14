import { useEffect, useMemo, useRef, useState } from 'react'
import type { RoutePlan } from '../types.ts'
import type { Bounds } from '../lib/geo.ts'
import { areaTiles, canCache, corridorTiles, countCached, downloadTiles, type DownloadProgress } from './offline.ts'

/** Ready offline once this share of the tiles is cached: a few tiles at mosaic edges do not exist on Trek. */
const READY_SHARE = 0.99

/** "Download for offline": the map imagery for the area and the planned route, kept on the tablet. */
export function OfflineDownload({ bounds, plan }: { bounds: Bounds | null; plan: RoutePlan | null }) {
  const parts = useMemo(
    () => (bounds ? [areaTiles(bounds), ...(plan && plan.legs.length ? [corridorTiles(plan)] : [])] : []),
    [bounds, plan],
  )
  const urls = useMemo(() => [...new Set(parts.flatMap((p) => p.urls))], [parts])
  const estimateMB = parts.reduce((s, p) => s + p.estimateMB, 0)
  const [cached, setCached] = useState<number | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    setCached(null)
    countCached(urls).then((n) => alive && setCached(n))
    return () => {
      alive = false
    }
  }, [urls])
  useEffect(() => () => abort.current?.abort(), [])

  if (!canCache() || urls.length === 0) return null
  const busy = progress !== null && abort.current !== null
  const have = progress ? progress.done - progress.failed : (cached ?? 0)
  const ready = !busy && cached !== null && cached >= urls.length * READY_SHARE

  async function start() {
    const ctrl = new AbortController()
    abort.current = ctrl
    const done = await downloadTiles(urls, setProgress, ctrl.signal)
    abort.current = null
    setProgress({ ...done })
    setCached(await countCached(urls))
    setProgress(null)
  }

  return (
    <section className="offline" aria-live="polite">
      <h2 className="label">Offline map</h2>
      {ready ? (
        <p className="chip chip--ok">Ready offline ✓ · {urls.length} tiles</p>
      ) : (
        <p className="muted">
          {parts.map((p) => `${p.label}: ${p.urls.length} tiles`).join(' · ')}, about {Math.round(estimateMB)} MB.
          {cached ? ` ${cached} already saved.` : ''}
        </p>
      )}
      {busy && progress && (
        <>
          <progress max={progress.total} value={progress.done} />
          <p className="num">
            {progress.done} / {progress.total} tiles · {progress.mb.toFixed(1)} MB
            {progress.failed ? ` · ${progress.failed} missing` : ''}
          </p>
        </>
      )}
      {busy ? (
        <button type="button" className="big" onClick={() => abort.current?.abort()}>Cancel</button>
      ) : (
        !ready && (
          <button type="button" className="big" onClick={start}>
            {have > 0 ? 'Resume download' : 'Download for offline'}
          </button>
        )
      )}
    </section>
  )
}
