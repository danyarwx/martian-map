// Sky, sun, dust haze and sunlight of the helmet world (docs/helmet/PLAN.md §6.2).
//
// All of this is a MODEL, not a measurement (public/data/SOURCES.md):
// - Sun position: plain solar geometry from the local solar time and the latitude. The season is ASSUMED to be an
//   equinox (solar declination 0°), which is close to the season Perseverance landed in (northern spring, about
//   Ls 5°). On Mars the declination swings between ±25.2° over the year, so on other dates the real sun stands
//   up to 25° further north or south. No equation of time, no refraction.
// - Sky colour: butterscotch overhead, paler and brighter towards the horizon where the line of sight passes
//   through more dust, and a pale blue-white glow round the sun (dust scatters blue light forwards). Colours
//   picked by eye after rover sky photographs. The sky goes through the same tone mapping as the ground, so the
//   haze on far terrain and the sky behind it meet in one colour.
// - Haze: exponential fog in the horizon colour. Its density is chosen so the far terrain fades out before its
//   4 km edge, not from a measured dust opacity.
// - Light: a warm sun plus a strong butterscotch sky light, because on Mars a large share of the daylight arrives
//   scattered by dust: shadows are filled in and soft-edged. The shares are picked by eye.
import * as THREE from 'three'
import type { Pose } from '../contracts.ts'
import { localToThree, type Vec3 } from '../frames.ts'

const RAD = Math.PI / 180

/** Default local solar time of a helmet session, hours (PLAN §6.2). */
export const DEFAULT_LST_HOURS = 10.5
/** Latitude of the Jezero site, degrees north. */
export const JEZERO_LAT_DEG = 18.44
/** Assumed solar declination, degrees: an equinox. See the note at the top of this file. */
export const ASSUMED_DECLINATION_DEG = 0

/**
 * Unit vector towards the sun in local ENU (x east, y north, z up) at `lstHours` local solar time (12 = the sun
 * crossing the meridian) and planetocentric latitude `latDeg`, for solar declination `declDeg`.
 */
export function sunDirection(lstHours: number, latDeg: number, declDeg: number = ASSUMED_DECLINATION_DEG): Vec3 {
  const hourAngle = (lstHours - 12) * 15 * RAD // negative before noon
  const lat = latDeg * RAD
  const decl = declDeg * RAD
  const x = -Math.cos(decl) * Math.sin(hourAngle)
  const y = Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(hourAngle)
  const z = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
  const len = Math.hypot(x, y, z)
  return { x: x / len, y: y / len, z: z / len }
}

/** Sun elevation above the horizon, degrees, of a local ENU direction. */
export function sunElevationDeg(dir: Vec3): number {
  return Math.asin(Math.max(-1, Math.min(1, dir.z))) / RAD
}

/**
 * Centre of the shadow box: `p` moved onto the shadow map's texel grid along the map's two axes (`right`, `up`,
 * unit vectors across the light direction), so the map samples the same world points from frame to frame and
 * shadow edges do not shimmer as the player moves. The component along the light is kept.
 */
export function snapToTexels(p: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, texelM: number, out = new THREE.Vector3()): THREE.Vector3 {
  const r = p.dot(right)
  const u = p.dot(up)
  const dr = Math.round(r / texelM) * texelM - r
  const du = Math.round(u / texelM) * texelM - u
  return out.copy(p).addScaledVector(right, dr).addScaledVector(up, du)
}

/** Sky colours (sRGB, as scene colours: they are tone-mapped like the ground). A model, see the top of the file. */
export const SKY = {
  zenith: '#a9794a',
  horizon: '#e6c69a',
  /** Below the horizon, where no terrain is drawn: thicker haze. */
  below: '#c9a57a',
  sun: '#fff8ee',
  /** Forward-scattering glow around the sun: bluish white. */
  glow: '#d3def0',
} as const

/** FogExp2 density, 1/m: about 22 % haze at 1 km, 67 % at 2 km, 99 % at 4 km. */
export const HAZE_DENSITY = 0.00055

/** Half-width of the square the sun's shadow map covers around the player, metres. */
export const SHADOW_HALF_M = 60
export const SHADOW_MAP_SIZE = 2048
/** Shadow edges are blurred over about this many shadow-map texels (6 cm each) to either side. */
export const SHADOW_SOFTNESS = 2.2
/** Distance of the light from the player, and the depth range of the shadow camera, metres. */
const LIGHT_DISTANCE_M = 300
const SKY_RADIUS_M = 1000
const SUN_INTENSITY = 2.5
const SKY_LIGHT_INTENSITY = 1.25
/** Exposure of the display image (tone mapping). The CV cameras render without tone mapping and do not see it. */
export const EXPOSURE = 1.3
/** Brightness of the sun's disc relative to white, before tone mapping. */
const SUN_DISC = 30

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uBelow;
uniform vec3 uSun;
uniform vec3 uGlow;
uniform vec3 uSunDir;
uniform float uDay;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  // the dust path grows like 1 / sin(elevation): butterscotch overhead, pale haze low down
  float haze = 1.0 - exp(-0.16 / (h + 0.04));
  vec3 col = mix(uZenith, uHorizon, haze);
  // the last degrees above the horizon: a bright band of haze
  col = mix(col, uHorizon * 1.06, exp(-h * 22.0) * 0.6);
  col = mix(col, uBelow, smoothstep(0.0, -0.2, d.y));
  float cosAng = clamp(dot(d, uSunDir), -1.0, 1.0);
  float ang = acos(cosAng);
  float above = smoothstep(-0.03, 0.0, d.y) * uDay;
  // the whole half of the sky round the sun is brighter
  col *= 1.0 + 0.22 * above * pow(max(cosAng, 0.0), 3.0);
  // bluish aureole: a tight core and a wide skirt
  float aureole = 0.85 * exp(-ang / 0.05) + 0.4 * exp(-ang / 0.2) + 0.12 * exp(-ang / 0.55);
  col = mix(col, uGlow * (1.0 + 1.2 * exp(-ang / 0.05)), clamp(aureole, 0.0, 1.0) * above);
  // the disc (drawn a little larger than the real 0.35 degrees so it is visible), with a soft limb
  float disc = 1.0 - smoothstep(0.0065, 0.0105, ang);
  col += uSun * (${SUN_DISC.toFixed(1)} * disc + 2.5 * exp(-ang / 0.012)) * above;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export interface AtmosphereOptions {
  /** Local solar time, hours. Default 10:30. */
  lstHours?: number
  /** Latitude of the site, degrees north. Default Jezero. */
  latDeg?: number
}

/**
 * Sky dome, haze, sky light and the sun with its shadow, for one scene. The dome and the shadow box follow the
 * player; call `update` every frame with the eye pose.
 */
export class Atmosphere {
  readonly sun: THREE.DirectionalLight
  readonly skyLight: THREE.HemisphereLight
  readonly dome: THREE.Mesh
  /** Direction towards the sun in three.js world coordinates. */
  readonly sunDir = new THREE.Vector3()
  private scene: THREE.Scene
  private latDeg: number
  private lst: number
  private right = new THREE.Vector3()
  private up = new THREE.Vector3()
  private centre = new THREE.Vector3()
  private eye = new THREE.Vector3()
  private skyMaterial: THREE.ShaderMaterial

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, opts: AtmosphereOptions = {}) {
    this.scene = scene
    this.latDeg = opts.latDeg ?? JEZERO_LAT_DEG
    this.lst = opts.lstHours ?? DEFAULT_LST_HOURS

    renderer.shadowMap.enabled = true
    // PCF with a radius: softer edges than PCFSoft, which ignores the radius
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMappingExposure = EXPOSURE

    const horizon = new THREE.Color(SKY.horizon)
    scene.background = null // the dome covers every pixel
    scene.fog = new THREE.FogExp2(horizon, HAZE_DENSITY)

    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(SKY.zenith) },
        uHorizon: { value: horizon.clone() },
        uBelow: { value: new THREE.Color(SKY.below) },
        uSun: { value: new THREE.Color(SKY.sun) },
        uGlow: { value: new THREE.Color(SKY.glow) },
        uSunDir: { value: this.sunDir },
        uDay: { value: 1 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS_M, 32, 16), this.skyMaterial)
    this.dome.name = 'sky'
    this.dome.renderOrder = -1000 // first, behind everything
    this.dome.frustumCulled = false
    scene.add(this.dome)

    this.skyLight = new THREE.HemisphereLight('#f0cfa6', '#6e4a31', SKY_LIGHT_INTENSITY)
    this.skyLight.name = 'sky light'
    scene.add(this.skyLight)

    this.sun = new THREE.DirectionalLight('#fff1dc', SUN_INTENSITY)
    this.sun.name = 'sun'
    this.sun.castShadow = true
    const s = this.sun.shadow
    s.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    s.camera.left = -SHADOW_HALF_M
    s.camera.right = SHADOW_HALF_M
    s.camera.top = SHADOW_HALF_M
    s.camera.bottom = -SHADOW_HALF_M
    s.camera.near = 1
    s.camera.far = LIGHT_DISTANCE_M * 2
    s.camera.updateProjectionMatrix()
    s.bias = -0.0004
    s.normalBias = 0.08
    s.radius = SHADOW_SOFTNESS
    scene.add(this.sun, this.sun.target)

    this.setLocalSolarTime(this.lst)
  }

  get lstHours(): number {
    return this.lst
  }

  /** Move the sun to another local solar time (hours). */
  setLocalSolarTime(lstHours: number): void {
    this.lst = lstHours
    const local = sunDirection(lstHours, this.latDeg)
    const d = localToThree(local)
    this.sunDir.set(d.x, d.y, d.z)
    // the shadow camera's axes: it looks from the sun at its target with +y up
    const m = new THREE.Matrix4().lookAt(this.sunDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0))
    this.right.setFromMatrixColumn(m, 0)
    this.up.setFromMatrixColumn(m, 1)
    // full sun from 15° elevation up, none below the horizon
    const day = THREE.MathUtils.smoothstep(local.z, -0.02, 0.26)
    this.sun.intensity = SUN_INTENSITY * day
    this.sun.castShadow = day > 0
    this.skyLight.intensity = SKY_LIGHT_INTENSITY * (0.25 + 0.75 * day)
    this.skyMaterial.uniforms.uDay.value = THREE.MathUtils.smoothstep(local.z, -0.05, 0.02)
  }

  /** Per frame, with the eye pose in local ENU. */
  update(pose: Pose): void {
    const e = localToThree(pose)
    this.eye.set(e.x, e.y, e.z)
    this.dome.position.copy(this.eye)
    snapToTexels(this.eye, this.right, this.up, (2 * SHADOW_HALF_M) / SHADOW_MAP_SIZE, this.centre)
    this.sun.target.position.copy(this.centre)
    this.sun.position.copy(this.centre).addScaledVector(this.sunDir, LIGHT_DISTANCE_M)
  }

  dispose(): void {
    this.scene.remove(this.dome, this.skyLight, this.sun, this.sun.target)
    this.dome.geometry.dispose()
    this.skyMaterial.dispose()
    this.sun.shadow.dispose()
    this.sun.dispose()
    this.skyLight.dispose()
    this.scene.fog = null
  }
}
