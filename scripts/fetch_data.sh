#!/usr/bin/env bash
# Downloads datasets into public/data so the app (and the demo) works offline.
# Log every source in public/data/SOURCES.md.
set -euo pipefail
cd "$(dirname "$0")/../public/data"

curl -fsSL -o M20_traverse.json  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
curl -fsSL -o M20_waypoints.json https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json

ls -lh
