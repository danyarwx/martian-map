#!/usr/bin/env bash
# Downloads the Perseverance panoramas the helmet view uses into public/data/panoramas,
# so the demo works without venue Wi-Fi. The list matches src/panels/walkScript.ts.
# Source: NASA/JPL-Caltech MMGIS, https://mars.nasa.gov/mmgis-maps/M20/ (see public/data/SOURCES.md)
set -euo pipefail
mkdir -p "$(dirname "$0")/../public/data/panoramas"
cd "$(dirname "$0")/../public/data/panoramas"

BASE=https://mars.nasa.gov/mmgis-maps/M20/Layers/mosaics
for f in \
  N_LRGB_1224_RZS_0561998_CYL_L_AUTOGENJ01.jpg \
  N_LRGB_1219_RZS_0560784_CYL_L_AUTOGENJ02.jpg \
  N_LRGB_1210_RZS_0560000_CYL_L_AUTOGENJ03.jpg
do
  curl -fsSL -o "$f" "$BASE/$f"
done

ls -lh
