// How distances and times are written everywhere in the interface.

export const km = (m: number) => `${(m / 1000).toFixed(1)} km`

export function duration(minutes: number) {
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')} min`
}
