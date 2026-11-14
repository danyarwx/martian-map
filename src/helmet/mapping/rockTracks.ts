// Rocks the CV has found, remembered across frames (FIXLIST A4 / C3), so the outline of a rock in the view does not
// blink with every frame. Input: the 'rock' detections of each CV frame (the CV's own output: position, size,
// height, level). Nothing here knows the world's rock list.
import type { Detection } from '../contracts.ts'

export interface RockTrack {
  id: number
  /** Local ENU of the rock's visible face, and the ground height under it. */
  x: number
  y: number
  groundZ: number | null
  radiusM: number
  heightM: number
  level: 'hazard' | 'small'
  /** Milliseconds (the caller's clock). */
  firstSeen: number
  lastSeen: number
  /** Frames this rock was seen in. */
  hits: number
  hazardHits: number
}

export interface RockTrackOptions {
  /** A track not seen for this long is dropped, ms. */
  keepMs: number
  /** Tracks farther than this from the astronaut are dropped, metres. */
  keepRangeM: number
  /** Most tracks kept. */
  max: number
}

export const ROCK_TRACK_DEFAULTS: RockTrackOptions = { keepMs: 8000, keepRangeM: 40, max: 160 }

/** Two sightings are the same rock when their centres are this close, metres. */
function sameRock(t: RockTrack, d: Detection): boolean {
  return Math.hypot(t.x - d.x, t.y - d.y) <= Math.max(0.4, 0.7 * Math.max(t.radiusM, d.radiusM))
}

export class RockTracks {
  readonly tracks: RockTrack[] = []
  private nextId = 1
  private opts: RockTrackOptions

  constructor(opts: Partial<RockTrackOptions> = {}) {
    this.opts = { ...ROCK_TRACK_DEFAULTS, ...opts }
  }

  /** Feed one CV frame's detections. `at` = where the astronaut stands. */
  update(detections: readonly Detection[], now: number, at: { x: number; y: number }): void {
    for (const d of detections) {
      if (d.kind !== 'rock') continue
      const hazard = d.level !== 'small'
      let best: RockTrack | null = null
      let bestD = Infinity
      for (const t of this.tracks) {
        if (!sameRock(t, d)) continue
        const dist = Math.hypot(t.x - d.x, t.y - d.y)
        if (dist < bestD) {
          bestD = dist
          best = t
        }
      }
      if (!best) {
        this.tracks.push({
          id: this.nextId++,
          x: d.x,
          y: d.y,
          groundZ: d.groundZ ?? null,
          radiusM: d.radiusM,
          heightM: d.heightM ?? 0.2,
          level: hazard ? 'hazard' : 'small',
          firstSeen: now,
          lastSeen: now,
          hits: 1,
          hazardHits: hazard ? 1 : 0,
        })
        continue
      }
      // a running mean: later sightings from closer weigh the same as earlier ones, up to 8 frames back
      const w = 1 / Math.min(8, best.hits + 1)
      best.x += (d.x - best.x) * w
      best.y += (d.y - best.y) * w
      best.radiusM += (d.radiusM - best.radiusM) * w
      if (d.heightM !== undefined) best.heightM += (d.heightM - best.heightM) * w
      if (d.groundZ !== undefined) best.groundZ = best.groundZ === null ? d.groundZ : best.groundZ + (d.groundZ - best.groundZ) * w
      best.lastSeen = now
      best.hits++
      if (hazard) best.hazardHits++
      // the safe side: a rock seen as a hazard in a third of its sightings is one
      best.level = best.hazardHits * 3 >= best.hits ? 'hazard' : 'small'
    }
    const { keepMs, keepRangeM, max } = this.opts
    for (let k = this.tracks.length - 1; k >= 0; k--) {
      const t = this.tracks[k]
      if (now - t.lastSeen > keepMs || Math.hypot(t.x - at.x, t.y - at.y) > keepRangeM) this.tracks.splice(k, 1)
    }
    if (this.tracks.length > max) {
      this.tracks.sort((a, b) => b.lastSeen - a.lastSeen)
      this.tracks.length = max
    }
  }

  clear(): void {
    this.tracks.length = 0
  }
}
