// Where the crew is. On Mars there is no GPS; for the demo a simulated walker moves along the route.
// Anything that produces fixes can drive the navigator, e.g. later an Earth GPS track mapped onto the site.
import type { LatLon, Mobility, RouteLeg } from '../types.ts'
import { bearingDeg, cumulativeM, localProjection, pointAlong } from './geometry.ts'
import { secondsPerMetre } from '../lib/mobility.ts'

/** One position report. */
export interface PositionFix extends LatLon {
  /** Direction of travel, degrees from north. */
  headingDeg: number
  speedMps: number
  /** Expected error of the position, metres. */
  accuracyM: number
  /** Date.now() milliseconds when the fix was taken. */
  t: number
}

/** Anything that reports positions: the simulator now, a real or mapped GPS later. */
export interface PositionSource {
  /** Starts reporting fixes to `cb`. */
  start(cb: (fix: PositionFix) => void): void
  stop(): void
}

/** Fixes per second sent by the simulator. */
const TICK_HZ = 5
/** How quickly a drift moves the walker sideways: metres sideways per metre forward. */
const DRIFT_RATE = 0.7

export interface SimulatedSourceOptions {
  /** The legs to walk, in order. The walker waits at the end of each one until `continueFromStop()`. */
  legs: RouteLeg[]
  mobility: Mobility
  /** Clock, for tests. Default Date.now. */
  now?: () => number
  /** False to drive the walker only through `step()`, e.g. in tests. Default true: about 5 fixes a second. */
  autoTick?: boolean
}

/**
 * A walker (or rover) that follows the route at the mobility's real speed: slower on slopes, using the
 * elevation stored on each leg. Speed can be multiplied for the demo, and it can be pushed off the route
 * to show what the navigator does then.
 */
export class SimulatedSource implements PositionSource {
  private legs: RouteLeg[]
  private readonly mobility: Mobility
  private readonly now: () => number
  private readonly autoTick: boolean
  private legIndex = 0
  private cum: number[] = [0]
  /** Seconds per metre on each segment of the current leg. */
  private segSecPerM: number[] = []
  private alongM = 0
  /** Sideways offset from the path, metres, positive to the right; and where it is heading. */
  private sideM = 0
  private sideTargetM = 0
  private multiplier = 1
  private paused = false
  private waiting = false
  private cb: ((fix: PositionFix) => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTick = 0

  constructor(options: SimulatedSourceOptions) {
    this.legs = options.legs
    this.mobility = options.mobility
    this.now = options.now ?? Date.now
    this.autoTick = options.autoTick ?? true
    this.loadLeg(0)
  }

  start(cb: (fix: PositionFix) => void): void {
    this.cb = cb
    this.lastTick = this.now()
    this.stopTimer()
    if (this.autoTick) {
      this.timer = setInterval(() => {
        const t = this.now()
        this.step((t - this.lastTick) / 1000)
        this.lastTick = t
      }, 1000 / TICK_HZ)
    }
    this.report(0)
  }

  stop(): void {
    this.stopTimer()
    this.cb = null
  }

  /** 1 for real time, 10 or 60 for the demo. */
  setSpeedMultiplier(m: number): void {
    this.multiplier = m
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  /** True while waiting at a stop for `continueFromStop()`. */
  get atStop(): boolean {
    return this.waiting
  }

  /**
   * Starts on the next leg. Call it together with the navigator's `continueFromStop()`: the navigator
   * counts the stop as reached a few metres before the walker gets to its very end.
   */
  continueFromStop(): void {
    if (this.legIndex + 1 >= this.legs.length) return
    this.loadLeg(this.legIndex + 1)
  }

  /**
   * Walks off to the side until `metres` from the route (positive to the right, negative to the left),
   * then keeps going parallel to it. `driftOffRoute(0)` walks back onto the route.
   */
  driftOffRoute(metres: number): void {
    this.sideTargetM = metres
  }

  /** Replaces the route ahead, e.g. after a reroute. The walker jumps to the start of the new route. */
  setPath(legs: RouteLeg[]): void {
    this.legs = legs
    this.sideM = 0
    this.sideTargetM = 0
    this.loadLeg(0)
  }

  /**
   * Puts the walker on leg `legIndex`, `alongM` metres from its start, back on the route. Used when the
   * simulation takes over from GPS at the navigator's position.
   */
  placeAt(legIndex: number, alongM: number): void {
    this.sideM = 0
    this.sideTargetM = 0
    this.loadLeg(Math.max(0, Math.min(legIndex, this.legs.length - 1)))
    const end = this.cum[this.cum.length - 1]
    this.alongM = Math.max(0, Math.min(alongM, end))
    if (this.alongM >= end - 1e-6) this.waiting = true
    this.lastTick = this.now()
    this.report(0)
  }

  /** Moves the walker forward by `seconds` of real time (times the multiplier) and reports a fix. */
  step(seconds: number): void {
    let left = this.paused || this.waiting ? 0 : seconds * this.multiplier
    const start = this.alongM
    const end = this.cum[this.cum.length - 1]
    // Walk segment by segment so each one is crossed at its own speed.
    while (left > 0 && this.alongM < end) {
      const k = this.segmentAt(this.alongM)
      const secPerM = this.segSecPerM[k]
      const toSegEnd = this.cum[k + 1] - this.alongM
      const metres = Math.min(toSegEnd, left / secPerM)
      this.alongM += metres
      left -= metres * secPerM
      if (metres <= 1e-9) break
    }
    const moved = this.alongM - start
    if (this.sideM !== this.sideTargetM) {
      const change = moved * DRIFT_RATE
      const d = this.sideTargetM - this.sideM
      this.sideM += Math.sign(d) * Math.min(Math.abs(d), change)
    }
    if (this.alongM >= end - 1e-6) this.waiting = true
    this.report(seconds > 0 ? moved / seconds : 0)
  }

  private stopTimer() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private loadLeg(i: number) {
    this.legIndex = i
    this.alongM = 0
    this.waiting = false
    const leg = this.legs[i]
    if (!leg) {
      this.cum = [0]
      this.segSecPerM = []
      this.waiting = true
      return
    }
    this.cum = cumulativeM(leg.path)
    const limit = this.mobility.maxSlopeDeg
    this.segSecPerM = leg.path.slice(1).map((_, k) => {
      const run = this.cum[k + 1] - this.cum[k]
      const a = leg.elev[k]
      const b = leg.elev[k + 1]
      const deg = run > 0 && a !== null && b !== null ? (Math.atan(Math.abs(b - a) / run) * 180) / Math.PI : 0
      return secondsPerMetre(this.mobility, Math.min(deg, limit))
    })
    if (this.segSecPerM.length === 0) this.waiting = true
  }

  private segmentAt(alongM: number): number {
    let k = 0
    while (k + 2 < this.cum.length && this.cum[k + 1] <= alongM) k++
    return k
  }

  private report(speedMps: number) {
    if (!this.cb) return
    const path = this.legs[this.legIndex]?.path
    if (!path || path.length === 0) return
    const here = pointAlong(path, this.cum, this.alongM)
    const ahead = pointAlong(path, this.cum, this.alongM + 5)
    const behind = pointAlong(path, this.cum, this.alongM - 5)
    const heading = bearingDeg(behind, ahead)
    let pos = here
    if (this.sideM !== 0) {
      // Right of the direction of travel is the heading turned 90 degrees clockwise.
      const rad = ((heading + 90) * Math.PI) / 180
      pos = localProjection(here).toLatLon({ x: Math.sin(rad) * this.sideM, y: Math.cos(rad) * this.sideM })
    }
    this.cb({ ...pos, headingDeg: heading, speedMps, accuracyM: 1, t: this.now() })
  }
}
