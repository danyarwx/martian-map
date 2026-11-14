import type { SiteConfig } from '../types.ts'

// Coordinates come from NASA's Mars 2020 location data: each target sits on a Perseverance stop
// (public/data/M20_waypoints.json), the helicopter on its last flight record (M20_heli_waypoints.json).
// scripts/fetch_views.py reads the ids and coordinates from this file to cache a ground photo per stop,
// so keep `id`, `lat` and `lon` as plain literals.

export const JEZERO: SiteConfig = {
  id: 'jezero',
  name: 'Jezero crater',
  scienceGoal:
    'Search for signs of ancient life: collect what Perseverance cached, then go where the rover found its strongest leads.',
  center: { lat: 18.468, lon: 77.385 },
  zoom: 13,
  habitat: {
    id: 'habitat',
    name: 'Habitat',
    summary: 'Octavia E. Butler Landing, the flat crater floor where Perseverance touched down.',
    science: 'Start and end of every excursion.',
    task: 'Suit up, check conditions, depart.',
    lat: 18.44463,
    lon: 77.45089,
  },
  targets: [
    {
      id: 'three-forks',
      name: 'Three Forks sample depot',
      summary: '10 sealed sample tubes left on the surface by Perseverance.',
      science:
        'The tubes hold rock cores, regolith and atmosphere picked as a backup set for return to Earth.',
      task: 'Locate and collect the 10 tubes.',
      lat: 18.45007,
      lon: 77.40176,
    },
    {
      id: 'delta-front',
      name: 'Delta front (Hawksbill Gap)',
      summary: 'Layered sediments at the foot of the ancient river delta.',
      science:
        'Fine lake-bottom layers are where organic matter and traces of microbes are most likely to be preserved.',
      task: 'Sample the fine-grained layers by hand, bed by bed.',
      lat: 18.45886,
      lon: 77.4061,
    },
    {
      id: 'seitah',
      name: 'Séítah',
      summary: 'Olivine-rich igneous rock among sand ripples.',
      science:
        'Igneous rock can be dated in a lab, which fixes when the lake existed. The sand ripples make it a mobility hazard.',
      task: 'Chip a fresh sample from an outcrop.',
      lat: 18.43266,
      lon: 77.44137,
    },
    {
      id: 'margin-carbonates',
      name: 'Margin carbonates',
      summary: 'Carbonate-rich rock along the old lake shore.',
      science:
        'On Earth, carbonates that form at lake shores trap and preserve microbial structures such as stromatolites.',
      task: 'Survey the outcrop for layered textures and sample them.',
      lat: 18.49183,
      lon: 77.3272,
    },
    {
      id: 'cheyava-falls',
      name: 'Cheyava Falls',
      summary: 'The "leopard spot" rock in Neretva Vallis.',
      science:
        'Perseverance’s Sapphire Canyon core from this rock is the mission’s strongest potential biosignature (NASA, 2025).',
      task: 'Map the spotted layer along the outcrop and take samples the rover could not reach.',
      lat: 18.49599,
      lon: 77.3037,
    },
    {
      id: 'ingenuity',
      name: 'Ingenuity helicopter',
      summary: 'Final landing spot of the Mars helicopter (flight 72, Airfield Chi).',
      science:
        'Three years of dust and temperature cycling on known hardware: a ready-made materials experiment.',
      task: 'Inspect and photograph the airframe, recover a rotor blade.',
      lat: 18.49727,
      lon: 77.32253,
    },
  ],
  terrain: {
    meta: '/data/jezero_terrain.json',
    slope: '/data/jezero_slope.bin',
    elev: '/data/jezero_elev.bin',
    overlay: '/data/jezero_slope.png',
  },
  views: '/data/views/index.json',
}
