// SIMULATED dust storm for the 3D helmet world. Not data: it thickens the scene's haze, tints the sky and
// dims the sun, so the screen and the helmet's own cameras both see dusty air. The onboard vision then has
// to notice it from camera pixels alone. Anything shown with this must be labelled as simulated.

import * as THREE from 'three'

/** What the storm changes. The helmet's World and Atmosphere expose all of these. */
export interface StormTarget {
  scene: THREE.Scene
  sun: THREE.DirectionalLight
  skyLight: THREE.HemisphereLight
  dome: THREE.Mesh
}

/** Sunlit airborne dust, from Curiosity's Mastcam frame of sol 2077 (the same colour as simulate.ts). */
const DUST = new THREE.Color(205 / 255, 160 / 255, 112 / 255).convertSRGBToLinear()
/** Haze density at full strength, 1/m. three.js FogExp2 hides 1 - exp(-(d * density)^2) of a thing d metres
 *  away: at 0.09 that is 18 % at 5 m, 55 % at 10 m and 96 % at 20 m, a thick storm. */
const STORM_DENSITY = 0.09
/** Sunlight left at full strength. Curiosity's sky reached an optical depth above 8 in June 2018. */
const SUN_LEFT = 0.15

type Saved = {
  fog: THREE.FogExp2 | null
  sun: number
  sky: number
  uniforms: Record<string, THREE.Color>
}

export class DustStorm {
  private target: StormTarget
  private saved: Saved
  private fog: THREE.FogExp2
  private strength = 0

  constructor(target: StormTarget) {
    this.target = target
    const uniforms = (target.dome.material as THREE.ShaderMaterial).uniforms ?? {}
    const colours: Record<string, THREE.Color> = {}
    for (const k of ['uZenith', 'uHorizon', 'uBelow', 'uGlow']) {
      const v = uniforms[k]?.value
      if (v instanceof THREE.Color) colours[k] = v.clone()
    }
    const fog = target.scene.fog instanceof THREE.FogExp2 ? target.scene.fog : null
    this.saved = { fog: fog ? (fog.clone() as THREE.FogExp2) : null, sun: target.sun.intensity, sky: target.skyLight.intensity, uniforms: colours }
    this.fog = fog ?? new THREE.FogExp2(DUST.clone(), 0)
  }

  /** 0 = the world as it was, 1 = full storm. The sun's own day/night setting is kept underneath. */
  set(strength: number): void {
    const s = Math.min(1, Math.max(0, strength))
    if (s === this.strength) return
    this.strength = s
    const { scene, sun, skyLight, dome } = this.target
    const base = this.saved

    // haze: denser and dust coloured
    const baseDensity = base.fog?.density ?? 0
    this.fog.density = baseDensity + (STORM_DENSITY - baseDensity) * s * s
    this.fog.color.copy(base.fog?.color ?? DUST).lerp(DUST, s)
    scene.fog = s > 0 || base.fog ? this.fog : null

    // light: the sun fades behind the dust, the sky glow stays
    sun.intensity = base.sun * (1 - (1 - SUN_LEFT) * s)
    skyLight.intensity = base.sky * (1 - 0.3 * s)

    // sky dome: every colour drifts to the dust colour
    const uniforms = (dome.material as THREE.ShaderMaterial).uniforms ?? {}
    for (const [k, c] of Object.entries(base.uniforms)) uniforms[k]?.value?.copy(c).lerp(DUST, s)
  }

  get value(): number {
    return this.strength
  }

  /** Puts the world back exactly as it was. */
  dispose(): void {
    this.set(0)
    const base = this.saved.fog
    if (base) {
      this.fog.color.copy(base.color)
      this.fog.density = base.density
    }
    this.target.scene.fog = base ? this.fog : null
  }
}
