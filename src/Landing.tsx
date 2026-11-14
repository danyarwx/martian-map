import type { SiteConfig, StopView } from './types.ts'

/** The data layers the map combines, as shown on the landing page. */
const LAYERS: { kind: string; source: string }[] = [
  { kind: 'Optical', source: 'HiRISE 25 cm · CTX 6 m' },
  { kind: 'Topographic', source: 'slope from the HiRISE 1 m DTM' },
  { kind: 'Thermal', source: 'THEMIS day IR' },
  { kind: 'Spectral', source: 'CRISM minerals' },
  { kind: 'Ground photos', source: 'Perseverance Navcam' },
]

const STEPS: { title: string; text: string }[] = [
  {
    title: 'Choose your stops',
    text: "Six science targets from Perseverance's mission, or drop your own point anywhere on the map.",
  },
  {
    title: 'Get a safe route',
    text: 'Planned on HiRISE elevation data, steering around slopes too steep to cross in a spacesuit.',
  },
  {
    title: 'Check it before you go',
    text: 'Time outside, radiation dose, daylight, and how long the walk back to the habitat takes.',
  },
]

/** First screen: what the tool does and two ways in. */
export default function Landing({
  site,
  view,
  onOwn,
}: {
  site: SiteConfig
  /** Ground photo at the habitat, once the photo index has loaded. */
  view?: StopView
  onOwn: () => void
}) {
  return (
    <div className="landing">
      <header className="landing-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a0e06" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 20l6-12 4 7 3-4 5 9z" />
            </svg>
          </span>
          <strong>Martian Map</strong>
          <span className="muted">{site.name}</span>
        </div>
        <nav className="landing-nav">
          <a href="#how">How it works</a>
          <a href="#data">Data</a>
        </nav>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-copy">
            <span className="landing-eyebrow">Marswalk planner</span>
            <h1>Plan a safe walk to the places Perseverance found most promising.</h1>
            <p>
              Pick the stops you want to see. Martian Map finds a route a suited astronaut can actually walk, checks it
              against slope, daylight and radiation, and shows what each stop looks like from the ground.
            </p>
            <div className="landing-actions">
              <button type="button" className="btn btn--primary btn--cta" onClick={onOwn}>
                Plan my route
              </button>
            </div>
          </div>
          <figure className="landing-shot">
            {view ? (
              <>
                <img src={view.file} alt="Jezero crater floor at the landing site, seen by Perseverance" />
                <figcaption>
                  The habitat site: {view.camera}, sol {view.sol} · {view.credit}
                </figcaption>
              </>
            ) : (
              <div className="landing-shot-empty" aria-hidden="true" />
            )}
          </figure>
        </section>

        <section id="how" className="landing-section">
          <h2>How it works</h2>
          <ol className="landing-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="landing-no" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{s.title}</h3>
                <p className="muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="data" className="landing-section">
          <h2>Built from NASA mission data</h2>
          <ul className="landing-layers">
            {LAYERS.map((l) => (
              <li key={l.kind}>
                <strong>{l.kind}</strong> <span className="muted">{l.source}</span>
              </li>
            ))}
          </ul>
          <p className="muted landing-goal">Science goal: {site.scienceGoal}</p>
        </section>
      </main>
    </div>
  )
}
