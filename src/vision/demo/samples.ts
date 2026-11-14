// Test frames for the onboard vision bench. All are real NASA rover images.
// Sources and credits: public/vision-samples/SOURCES.md and public/data/views/index.json.

export type Sample = {
  id: string
  url: string
  title: string
  note: string
  credit: string
}

export const SAMPLES: Sample[] = [
  {
    id: 'storm-2077',
    url: '/vision-samples/storm-curiosity-sol2077.jpg',
    title: 'Global dust storm, day 4',
    note: 'Curiosity Mastcam, sol 2077 (10 June 2018). The crater rim 30 km away is almost gone.',
    credit: 'NASA/JPL-Caltech/MSSS · PIA22520',
  },
  {
    id: 'storm-2074',
    url: '/vision-samples/storm-curiosity-sol2074.jpg',
    title: 'Global dust storm, day 1',
    note: 'Curiosity Mastcam, sol 2074 (7 June 2018). Same view three days earlier.',
    credit: 'NASA/JPL-Caltech/MSSS · PIA22520',
  },
  {
    id: 'delta-front',
    url: '/data/views/delta-front.jpg',
    title: 'Hazy sky at the delta front',
    note: 'Perseverance Navcam, sol 474. Dusty air, looking towards the Sun.',
    credit: 'NASA/JPL-Caltech',
  },
  {
    id: 'dusty-sky',
    url: '/vision-samples/dusty-sky-curiosity-2018.jpg',
    title: 'Dusty sky, clear ground',
    note: 'Curiosity selfie during the 2018 storm. The sky is orange but the ground nearby is sharp.',
    credit: 'NASA/JPL-Caltech/MSSS · PIA22486',
  },
  {
    id: 'dust-devils',
    url: '/vision-samples/dust-devils-perseverance-sol148.jpg',
    title: 'Clear day with distant dust devils',
    note: 'Perseverance Navcam, sol 148 (20 July 2021), Jezero crater.',
    credit: 'NASA/JPL-Caltech · PIA25290',
  },
  {
    id: 'rocky-plain',
    url: '/vision-samples/rocky-plain-perseverance-2023.jpg',
    title: 'Clear day, rocky plain',
    note: 'Perseverance Navcam, 30 August 2023, Thorofare Ridge.',
    credit: 'NASA/JPL-Caltech · PIA26074',
  },
  {
    id: 'coring',
    url: '/vision-samples/clear-perseverance-coring-2025.jpg',
    title: 'Clear day at the crater rim',
    note: 'Perseverance, 29 April 2025.',
    credit: 'NASA/JPL-Caltech · PIA26572',
  },
  {
    id: 'cheyava',
    url: '/data/views/cheyava-falls.jpg',
    title: 'Clear day at Cheyava Falls',
    note: 'Perseverance Navcam, the excursion target.',
    credit: 'NASA/JPL-Caltech',
  },
  {
    id: 'habitat',
    url: '/data/views/habitat.jpg',
    title: 'Clear day at the landing site',
    note: 'Perseverance Navcam, sol 13.',
    credit: 'NASA/JPL-Caltech',
  },
]
