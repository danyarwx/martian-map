#!/usr/bin/env bash
# Downloads datasets into public/data so the app (and the demo) works offline.
# Log every source in public/data/SOURCES.md.
#
#   bash scripts/fetch_data.sh          rover data, ground photos, terrain grid from the 20 m DTM
#   bash scripts/fetch_data.sh --full   same, but terrain from the 1 m HiRISE DTM (1.8 GB download)
set -euo pipefail
cd "$(dirname "$0")/.."

M20=https://mars.nasa.gov/mmgis-maps/M20/Layers/json
curl -fsSL -o public/data/M20_traverse.json       $M20/M20_traverse.json
curl -fsSL -o public/data/M20_waypoints.json      $M20/M20_waypoints.json
curl -fsSL -o public/data/M20_heli_waypoints.json $M20/m20_heli_waypoints.json

# Mineral indicators: CRISM map-projected browse image "CAR" (carbonates, clays, hydrated minerals) of
# observation FRT00005C5E, from the PDS Geosciences Node. Shown as one image overlay; bounds are in src/map/layers.ts.
CRISM=https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/browse/2007/2007_139/frt00005c5e
curl -fsSL -o public/data/jezero_crism_car.png $CRISM/frt00005c5e_07_brcarj_mtr3.png

# Python env for the processing scripts
[ -d scripts/.venv ] || python3 -m venv scripts/.venv
scripts/.venv/bin/pip install -q -r scripts/requirements.txt

# Elevation models: USGS Mars 2020 Terrain Relative Navigation release. Kept out of git (scripts/raw).
TRN=https://planetarymaps.usgs.gov/mosaic/mars2020_trn
mkdir -p scripts/raw
[ -f scripts/raw/jezero_ctx_dtm_20m.tif ] || curl -fsSL -o scripts/raw/jezero_ctx_dtm_20m.tif \
  $TRN/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
if [ "${1:-}" = "--full" ]; then
  curl -fL -C - -o scripts/raw/jezero_hirise_dtm_1m.tif \
    $TRN/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif
fi

scripts/.venv/bin/python scripts/build_terrain.py   # slope + elevation grid for the route planner
scripts/.venv/bin/python scripts/fetch_views.py     # one ground-level rover photo per stop

ls -lh public/data
