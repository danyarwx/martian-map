// A real Perseverance photo of a stop, with markers for the stop and the other places on the route.
// The photo is unchanged; the markers are placed with the camera model of that frame (src/lib/photoProjection.ts).
import { useMemo, useState } from 'react'
import type { LatLon, StopView, Target } from '../types.ts'
import { type Landmark, type PlacedLandmark, framesFor, placeLandmarks } from '../lib/photoProjection.ts'
import type { PhotoData } from '../lib/usePhotoData.ts'

/** How many photos "Another view" steps through. */
const MAX_CHOICES = 6
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
const metres = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`)

export default function StopPhoto(p: {
  stop: Target
  /** Other places to mark when they are in the picture: the habitat and the other stops of the route. */
  landmarks: Landmark[]
  /** Places a view from the stop should face, most wanted first: the next stop, then the habitat. */
  lookAt: LatLon[]
  photos: PhotoData | null
  /** The single cached photo of a suggested stop, shown while the frames load or when none fits. */
  fallback?: StopView
}) {
  const { stop, photos } = p
  const [pick, setPick] = useState(0)
  const [shownFor, setShownFor] = useState(stop.id)
  if (shownFor !== stop.id) {
    // A different stop: start again from its best photo.
    setShownFor(stop.id)
    setPick(0)
  }
  const choices = useMemo(
    () => (photos ? framesFor(photos.frames, photos.terrain, stop, p.lookAt).slice(0, MAX_CHOICES) : []),
    // lookAt is rebuilt on every render; its places are what matter.
    [photos, stop.lat, stop.lon, JSON.stringify(p.lookAt)],
  )
  const choice = choices[Math.min(pick, choices.length - 1)]
  const placed = useMemo(
    () => (choice && photos ? placeLandmarks(choice.frame, photos.terrain, p.landmarks.filter((l) => l.id !== stop.id)) : []),
    [choice, photos, JSON.stringify(p.landmarks), stop.id],
  )

  if (!choice) {
    if (p.fallback) {
      return (
        <figure>
          <img className="photo-plain" src={p.fallback.file} alt={`Ground view near ${stop.name}`} />
          <figcaption>
            {p.fallback.camera}, sol {p.fallback.sol}
            {p.fallback.distanceM > 20 ? `, taken ${p.fallback.distanceM} m from this spot` : ''} · {p.fallback.credit}
          </figcaption>
        </figure>
      )
    }
    if (!photos) return null
    return <p className="photo-none">Perseverance took no photo within {metres(1500)} that shows this spot.</p>
  }

  const { frame, mode, distanceM, mark } = choice
  const looking = compass(frame.headingDeg)
  const caption =
    mode === 'here'
      ? `View from this spot, looking ${looking}.${distanceM > 15 ? ` The rover stood ${metres(distanceM)} away.` : ''}`
      : mark && !mark.visible
        ? `${stop.name} from ${metres(distanceM)} away, looking ${looking}. A rise hides it from here; the dashed marker shows where it lies.`
        : `${stop.name} from ${metres(distanceM)} away, looking ${looking}.`

  return (
    <figure className="photo">
      <div className="photo-frame" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        <img src={frame.file} alt={caption} />
        {placed.map((l) => (
          <Marker key={l.id} place={l} />
        ))}
        {mode === 'toward' && mark && <Marker place={{ ...mark, id: stop.id, name: stop.name }} main />}
      </div>
      <figcaption>
        {caption}
        <span className="photo-credit">
          {' '}
          {photos?.camera ?? 'Perseverance Navcam'}, sol {frame.sol} ·{' '}
          <a href={frame.source} target="_blank" rel="noreferrer">
            {photos?.credit ?? 'NASA/JPL-Caltech'}
          </a>
        </span>
      </figcaption>
      {choices.length > 1 && (
        <button type="button" className="btn photo-next" onClick={() => setPick((pick + 1) % choices.length)}>
          Another view ({Math.min(pick, choices.length - 1) + 1} of {choices.length})
        </button>
      )}
    </figure>
  )
}

/** A pin standing on the ground at the place, with its name and distance. Dashed when the ground hides the place. */
function Marker({ place, main = false }: { place: PlacedLandmark | (PlacedLandmark & { visible: boolean }); main?: boolean }) {
  const side = place.x > 0.7 ? 'left' : place.x < 0.3 ? 'right' : 'centre'
  // Near the top edge the label would leave the picture: put it under the dot instead.
  const top = place.y < 0.22 ? ' photo-mark--top' : ''
  return (
    <div
      className={`photo-mark photo-mark--${side}${top}${main ? ' is-main' : ''}${place.visible ? '' : ' is-hidden'}`}
      style={{ left: `${place.x * 100}%`, top: `${place.y * 100}%` }}
      title={place.visible ? place.name : `${place.name}: behind a rise from here`}
    >
      <span className="photo-mark-label">
        {place.name} · {metres(place.distanceM)}
      </span>
      <i className="photo-mark-stem" />
      <i className="photo-mark-dot" />
    </div>
  )
}
