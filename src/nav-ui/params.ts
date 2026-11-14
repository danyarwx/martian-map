// The link from the planning screen to the tablet screen: which stops, how the crew moves, which route.
import type { LatLon, MobilityId, RouteProfile, Target } from '../types.ts'

export interface NavSelection {
  stopIds: string[]
  mobility: MobilityId
  profile: RouteProfile
  /** Where the habitat was moved to, or null at the landing point. */
  home: LatLon | null
  /** Destinations the user added, carried as `pt=lat,lon,name`. */
  points: Target[]
}

/** The demo selection: three stops on foot, fastest route. */
export const DEMO_SELECTION: NavSelection = {
  stopIds: ['three-forks', 'delta-front', 'seitah'],
  mobility: 'walk',
  profile: 'fast',
  home: null,
  points: [],
}

const coord = (v: number) => v.toFixed(5)

/** `/nav?...` for a selection. Site targets go by id; custom points by position and name. */
export function navUrl(s: NavSelection): string {
  const q = new URLSearchParams()
  const own = new Set(s.points.map((p) => p.id))
  q.set('stops', s.stopIds.filter((id) => !own.has(id)).join(','))
  q.set('mode', s.mobility)
  q.set('profile', s.profile)
  if (s.home) q.set('home', `${coord(s.home.lat)},${coord(s.home.lon)}`)
  for (const p of s.points) if (s.stopIds.includes(p.id)) q.append('pt', `${coord(p.lat)},${coord(p.lon)},${p.name}`)
  return `/nav?${q.toString()}`
}

/** Reads a selection from the address bar. Without `stops` or `pt`, the demo selection. */
export function parseNavParams(search: string, knownIds: string[]): NavSelection {
  const q = new URLSearchParams(search)
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  const points: Target[] = []
  q.getAll('pt').forEach((raw, i) => {
    const [lat, lon, ...name] = raw.split(',')
    const la = num(lat)
    const lo = num(lon)
    if (la === null || lo === null) return
    const label = name.join(',').trim() || `Point ${i + 1}`
    points.push({ id: `custom-${i + 1}`, name: label, summary: '', science: 'Custom destination.', task: '', lat: la, lon: lo })
  })
  const ids = (q.get('stops') ?? '').split(',').filter((id) => knownIds.includes(id))
  if (ids.length === 0 && points.length === 0) return DEMO_SELECTION
  const [hl, ho] = (q.get('home') ?? '').split(',')
  const homeLat = num(hl)
  const homeLon = num(ho)
  return {
    stopIds: [...ids, ...points.map((p) => p.id)],
    mobility: q.get('mode') === 'rover' ? 'rover' : 'walk',
    profile: q.get('profile') === 'gentle' ? 'gentle' : 'fast',
    home: homeLat !== null && homeLon !== null ? { lat: homeLat, lon: homeLon } : null,
    points,
  }
}
