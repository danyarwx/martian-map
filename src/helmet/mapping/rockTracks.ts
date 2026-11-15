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
  /** How uncertain the position is, metres: from the range of the closest sighting so far. */
  sigmaM: number
  /** CV frames in a row in which the rock should have been in clear view but was not found. */
  missed: number
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

/** A track in clear view (this near, this close to the view axis) that is not found this many frames in a row is dropped. */
const CLEAR_NEAR_M = 2.5
const CLEAR_FAR_M = 11
const CLEAR_HALF_ANGLE_DEG = 26
const MISSED_MAX = 5

/**
 * Position error of a stereo sighting at this range, metres: depth error grows with the square of the range
 * (about 0.08 m at 8 m, 0.5 m at 20 m for the helmet's cameras).
 */
export function sightingSigmaM(rangeM: number): number {
  return 0.0012 * rangeM * rangeM
}

/** A sighting is the same rock when it is this close to the track: the rocks' size plus how unsure both positions are. */
function sameRock(t: RockTrack, d: Detection, dSigma: number): boolean {
  return Math.hypot(t.x - d.x, t.y - d.y) <= Math.max(0.4, 0.7 * Math.max(t.radiusM, d.radiusM)) + Math.max(t.sigmaM, dSigma)
}

export class RockTracks {
  readonly tracks: RockTrack[] = []
  private nextId = 1
  private opts: RockTrackOptions

  constructor(opts: Partial<RockTrackOptions> = {}) {
    this.opts = { ...ROCK_TRACK_DEFAULTS, ...opts }
  }

  /** Feed one CV frame's detections. `at` = where the astronaut stands. */
  update(detections: readonly Detection[], now: number, at: { x: number; y: number; headingDeg?: number }): void {
    const matched = new Set<RockTrack>()
    for (const d of detections) {
      if (d.kind !== 'rock') continue
      const hazard = d.level !== 'small'
      const dSigma = sightingSigmaM(d.distanceM)
      let best: RockTrack | null = null
      let bestD = Infinity
      for (const t of this.tracks) {
        if (!sameRock(t, d, dSigma)) continue
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
          sigmaM: dSigma,
          missed: 0,
        })
        matched.add(this.tracks[this.tracks.length - 1])
        continue
      }
      // a sighting from closer is more exact: weigh by 1 / sigma², and never less than a running mean over 8 frames
      const w = Math.max(1 / Math.min(8, best.hits + 1), best.sigmaM ** 2 / (best.sigmaM ** 2 + dSigma ** 2 + 1e-6))
      best.sigmaM = Math.min(best.sigmaM, dSigma)
      best.missed = 0
      matched.add(best)
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
    // Two tracks that turned out to be one rock (first seen from far, then again from near): keep the surer one.
    for (let a = this.tracks.length - 1; a >= 0; a--) {
      const ta = this.tracks[a]
      for (let b = 0; b < a; b++) {
        const tb = this.tracks[b]
        if (Math.hypot(ta.x - tb.x, ta.y - tb.y) > Math.max(0.4, 0.6 * Math.max(ta.radiusM, tb.radiusM)) + Math.min(ta.sigmaM, tb.sigmaM)) continue
        const keep = ta.sigmaM < tb.sigmaM || (ta.sigmaM === tb.sigmaM && ta.hits >= tb.hits) ? ta : tb
        const drop = keep === ta ? tb : ta
        keep.hits += drop.hits
        keep.hazardHits += drop.hazardHits
        keep.firstSeen = Math.min(keep.firstSeen, drop.firstSeen)
        keep.level = keep.hazardHits * 3 >= keep.hits ? 'hazard' : 'small'
        this.tracks[b] = keep
        this.tracks.splice(a, 1)
        break
      }
    }
    // A track the camera now looks straight at from near, and does not find, was never a rock there.
    if (at.headingDeg !== undefined) {
      const hx = Math.sin((at.headingDeg * Math.PI) / 180)
      const hy = Math.cos((at.headingDeg * Math.PI) / 180)
      const cosMax = Math.cos((CLEAR_HALF_ANGLE_DEG * Math.PI) / 180)
      for (let k = this.tracks.length - 1; k >= 0; k--) {
        const t = this.tracks[k]
        if (matched.has(t)) continue
        const dx = t.x - at.x
        const dy = t.y - at.y
        const dist = Math.hypot(dx, dy)
        if (dist < CLEAR_NEAR_M || dist > CLEAR_FAR_M || (dx * hx + dy * hy) / dist < cosMax) continue
        if (++t.missed >= MISSED_MAX) this.tracks.splice(k, 1)
      }
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
