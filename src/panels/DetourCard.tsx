// The before/after of the helmet's re-route, over the map after the crew comes back inside: what shut the planned
// line, and what going round it costs in time outside and in the walk back to the habitat.
import type { HelmetDetour } from '../helmet/contracts.ts'
import { duration } from '../lib/format.ts'
import { WALK_BACK_RESERVE_MIN } from '../lib/safety.ts'

export type DetourView = 'before' | 'after'

interface Props {
  detour: HelmetDetour
  view: DetourView
  onView: (view: DetourView) => void
  onClose: () => void
}

const signed = (min: number) => {
  const r = Math.round(min)
  if (r === 0) return 'under 1 min'
  return `${r > 0 ? '+' : '−'}${duration(Math.abs(r))}`
}

/** Minutes left of the walk-back reserve, as words: "18 min to spare" or "over by 12 min". */
function margin(walkBack: number | null): { text: string; over: boolean } | null {
  if (walkBack === null) return null
  const left = Math.round(WALK_BACK_RESERVE_MIN - walkBack)
  return left >= 0 ? { text: `${duration(left)} to spare`, over: false } : { text: `over by ${duration(-left)}`, over: true }
}

export function detourCause(d: HelmetDetour): string {
  if (d.rocks === 0) return 'Steep ground or a drop-off across the planned line'
  const tall = d.tallestM !== null ? `, up to ${d.tallestM.toFixed(1)} m tall` : ''
  return d.rocks === 1 ? `A boulder across the planned line${tall}` : `${d.rocks} boulders across the planned line${tall}`
}

export default function DetourCard({ detour, view, onView, onClose }: Props) {
  const { tripMin, walkBackMaxMin: wb } = detour
  const before = margin(wb.before)
  const after = margin(wb.after)
  const rows: { label: string; before: string; after: string; overBefore?: boolean; overAfter?: boolean }[] = [
    {
      // from #helmet the helmet's own demo route counts from where it started, not from the habitat: say so, or it
      // looks like a different number from the planner's
      label: detour.tripFrom === 'start' ? "Time left from the helmet's start" : 'Time outside',
      before: duration(tripMin.before),
      after: duration(tripMin.after),
    },
    {
      label: 'Longest walk back',
      before: wb.before === null ? '–' : duration(wb.before),
      after: wb.after === null ? '–' : duration(wb.after),
    },
    {
      label: `${WALK_BACK_RESERVE_MIN} min reserve`,
      before: before?.text ?? '–',
      after: after?.text ?? '–',
      overBefore: before?.over,
      overAfter: after?.over,
    },
  ]
  return (
    <section className="detour" aria-label="Helmet re-route: before and after">
      <header className="detour-head">
        <span className="detour-kicker">Helmet re-route</span>
        <button type="button" className="detour-close" onClick={onClose} aria-label="Close">
          Close
        </button>
      </header>
      <p className="detour-cause">
        <span className="detour-x" aria-hidden="true">✕</span>
        {detourCause(detour)}. The helmet found {detour.rocks === 1 ? 'it' : 'them'} with its cameras and planned round.
      </p>
      <div className="detour-toggle" role="group" aria-label="Show on the map">
        {(['before', 'after'] as const).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)}>
            {/* the line's colour on the map (MarsMap.tsx: white planned line, DETOUR_NEW green) */}
            <i className={`detour-swatch detour-swatch--${v}`} aria-hidden="true" />
            {v === 'before' ? 'Before: planned line' : 'After: around the rocks'}
          </button>
        ))}
      </div>
      <table className="detour-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td className={r.overBefore ? 'detour-over' : undefined}>{r.before}</td>
              <td className={r.overAfter ? 'detour-over' : undefined}>{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="detour-delta">
        Detour: <strong>{signed(detour.deltaMin)}</strong>
        {detour.extraM >= 1 && ` (${Math.round(detour.extraM)} m more walking)`}
        {wb.before !== null &&
          wb.after !== null &&
          ` · longest walk back ${Math.round(wb.after - wb.before) === 0 ? 'unchanged' : signed(wb.after - wb.before)}`}
      </p>
      {before?.over && (
        // nobody is there to explain the red: say why it is red before and after alike
        <p className="detour-note">
          Red in both columns: on foot this route was already past the {WALK_BACK_RESERVE_MIN} min reserve before the
          detour (the planner flags it). A crew would take the crew rover or drop a stop. The detour itself left the
          walk home {wb.before !== null && wb.after !== null && Math.round(wb.after - wb.before) !== 0 ? `${signed(wb.after - wb.before)} longer` : 'as it was'}.
        </p>
      )}
    </section>
  )
}
