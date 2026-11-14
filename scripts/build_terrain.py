#!/usr/bin/env python3
"""Turns the Jezero elevation model into the slope/elevation grid the route planner reads.

Input (first one found in scripts/raw/):
  jezero_hirise_dtm_1m.tif   HiRISE 1 m DTM  -> 10 m grid, slope measured on a 2 m baseline
  jezero_ctx_dtm_20m.tif     CTX 20 m DTM    -> 20 m grid (fallback, coarse)
Both come from the USGS Mars 2020 Terrain Relative Navigation release (see public/data/SOURCES.md).

Output in public/data/:
  jezero_terrain.json   grid bounds, size, cell size, encoding
  jezero_slope.bin      uint8 per cell, slope in half degrees (255 = no data)
  jezero_elev.bin       int16 per cell, elevation in decimetres above the areoid (-32768 = no data)
  jezero_slope.png      coloured slope overlay for the map

Run: scripts/.venv/bin/python scripts/build_terrain.py   (add --ctx to force the 20 m fallback)
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window, from_bounds
from PIL import Image

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT.parent / "public" / "data"

# The DTMs are equirectangular with standard parallel 0 on a 3396.19 km sphere,
# so metres east = lon_rad * R and metres north = lat_rad * R.
R_PROJ = 3396190.0

# Area of interest: Perseverance's whole traverse plus a margin (planetocentric lat, east lon).
WEST, EAST = 77.20, 77.48
SOUTH, NORTH = 18.40, 18.52
MID_LAT = math.radians((SOUTH + NORTH) / 2)

# Slope classes for the overlay. Limits match src/lib/mobility.ts.
CLASSES = [  # (upper bound in degrees, RGBA)
    (5, (0, 0, 0, 0)),
    (10, (255, 221, 0, 90)),
    (15, (255, 150, 0, 140)),
    (20, (255, 80, 0, 170)),
    (90, (220, 0, 30, 200)),
]


def pick_source():
    hirise = RAW / "jezero_hirise_dtm_1m.tif"
    ctx = RAW / "jezero_ctx_dtm_20m.tif"
    if hirise.exists() and "--ctx" not in sys.argv:
        return hirise, 2.0, 5, "HiRISE 1 m DTM (USGS Mars 2020 TRN), slope on 2 m baseline, 85th percentile per 10 m cell"
    if ctx.exists():
        return ctx, 20.0, 1, "CTX 20 m DTM (USGS Mars 2020 TRN)"
    raise SystemExit("No DTM in scripts/raw/. See scripts/fetch_data.sh")


def block(a, k):
    """View a (H, W) array as (H/k, W/k, k*k) blocks."""
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:h, :w].reshape(h // k, k, w // k, k).swapaxes(1, 2).reshape(h // k, w // k, k * k)


def main():
    src_path, work_res, agg, label = pick_source()
    left, right = math.radians(WEST) * R_PROJ, math.radians(EAST) * R_PROJ
    bottom, top = math.radians(SOUTH) * R_PROJ, math.radians(NORTH) * R_PROJ

    with rasterio.open(src_path) as src:
        win = from_bounds(left, bottom, right, top, src.transform).round_offsets().round_lengths()
        # The HiRISE DTM ends east of our west edge. A window that sticks out of the raster is read
        # stretched, so clip it; the header then carries the bounds that were really read.
        win = win.intersection(Window(0, 0, src.width, src.height))
        h = int(round(win.height * src.res[1] / work_res))
        w = int(round(win.width * src.res[0] / work_res))
        # keep the grid a whole number of output cells
        h, w = h // agg * agg, w // agg * agg
        elev = src.read(1, window=win, out_shape=(h, w), resampling=Resampling.average, masked=True)
        b = rasterio.windows.bounds(win, src.transform)
    elev = elev.astype("float32").filled(np.nan)
    elev[elev < -1e5] = np.nan

    # Projected pixels are work_res metres north-south but shrink east-west by cos(lat) on the ground.
    dy = work_res
    dx = work_res * math.cos(MID_LAT)
    gy, gx = np.gradient(elev, dy, dx)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))

    if agg > 1:
        with np.errstate(all="ignore"):
            slope = np.nanpercentile(block(slope, agg), 85, axis=2)
            elev = np.nanmean(block(elev, agg), axis=2)

    gh, gw = slope.shape
    slope_u8 = np.where(np.isnan(slope), 255, np.clip(np.round(slope * 2), 0, 254)).astype("uint8")
    elev_i16 = np.where(np.isnan(elev), -32768, np.round(elev * 10)).astype("<i2")

    OUT.mkdir(parents=True, exist_ok=True)
    slope_u8.tofile(OUT / "jezero_slope.bin")
    elev_i16.tofile(OUT / "jezero_elev.bin")

    rgba = np.zeros((gh, gw, 4), dtype="uint8")
    lower = 0
    for upper, colour in CLASSES:
        rgba[(slope >= lower) & (slope < upper)] = colour
        lower = upper
    Image.fromarray(rgba, "RGBA").save(OUT / "jezero_slope.png", optimize=True)

    cell = work_res * agg
    meta = {
        "source": label,
        "west": math.degrees(b[0] / R_PROJ),
        "south": math.degrees(b[1] / R_PROJ),
        "east": math.degrees(b[2] / R_PROJ),
        "north": math.degrees(b[3] / R_PROJ),
        "width": gw,
        "height": gh,
        "cellMetersX": round(cell * math.cos(MID_LAT), 3),
        "cellMetersY": cell,
        "slopeEncoding": "uint8, half degrees, 255 = no data, row 0 = north",
        "elevEncoding": "int16 little-endian, decimetres, -32768 = no data, row 0 = north",
    }
    (OUT / "jezero_terrain.json").write_text(json.dumps(meta, indent=2) + "\n")

    valid = slope[~np.isnan(slope)]
    print(f"{label}\ngrid {gw} x {gh}, cell {cell} m, {valid.size / slope.size:.1%} valid")
    for t in (5, 10, 15, 20, 25):
        print(f"  slope > {t:2d} deg: {(valid > t).mean():.1%}")


if __name__ == "__main__":
    main()
