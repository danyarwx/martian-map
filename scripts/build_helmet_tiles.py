#!/usr/bin/env python3
"""Cuts the 1 m HiRISE DTM and the 25 cm HiRISE ortho into 128 m tiles along the helmet's walking routes.

Spec: docs/helmet/PLAN.md section 6.1 (task T1.1). Input: public/data/helmet/routes.json (scripts/export_routes.ts)
and public/data/jezero_terrain.json + jezero_elev.bin (the 10 m planner grid, for the tile grid anchor and the
elevation sanity check).

Data, both read over HTTP so nothing big lands on disk:
  - Elevation: USGS Mars 2020 TRN HiRISE 1 m DTM (1.8 GB GeoTIFF, uncompressed strips), read in windows through
    GDAL /vsicurl/ byte ranges. Equirectangular, standard parallel 0, on a 3 396 190 m sphere, so
    x = lon_rad * R_PROJ and y = lat_rad * R_PROJ (same as scripts/build_terrain.py).
  - Ortho: Mars Trek WMTS layer JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd, zoom 17
    (Leaflet EPSG:4326 grid: 2^(z+1) x 2^z tiles of 256 px over lon -180..180, lat 90..-90). Raw tiles are
    cached in scripts/raw/trek/17/{y}/{x}.png (404s as {x}.404), not in git.

Tile grid (fixed, never overlapping): tiles are 128 m x 128 m in app metres (R = 3 389 500 m, src/lib/geo.ts),
anchored at the planner grid's north-west corner (`origin`). One tile spans TILE_DEG_LAT degrees of latitude and
TILE_DEG_LON = TILE_DEG_LAT / cos(scaleLat) degrees of longitude, scaleLat = the planner grid's middle latitude.
Tile (row, col) has north = origin.lat - row * TILE_DEG_LAT and west = origin.lon + col * TILE_DEG_LON.

Per tile, in public/data/helmet/tiles/:
  r{row}_c{col}.bin       129 x 129 elevation samples (1 m, shared edges: sample k sits at west + k/128 of the
                          tile width), int16 little-endian centimetres above the tile's zMin, row 0 = north.
                          elevation_m = zMin + value / 100. Areoid heights, like the planner grid.
  r{row}_c{col}.jpg       HiRISE ortho, 512 x 512 px (0.25 m/px), grayscale JPEG q80, pixel centres on a
                          regular grid inside the tile bounds, row 0 = north.
  r{row}_c{col}_sand.png  sand mask, 256 x 256 (0.5 m/px), 1 bit, white = sand. Derived from the ortho only
                          (see sand_mask() for the thresholds). Ground truth for the world shader and the eval
                          harness; never read by src/helmet/cv/.
public/data/helmet/index.json lists every tile (paths relative to the index file) and the demo windows.

Which tiles: within CORRIDOR_M of the route polylines, restricted to the demo windows: the first WINDOW_M of each
leg and the last WINDOW_M of each leg (legs are stored in one direction; each end is "after a stop" one way and
"before a stop" the other way). A window is named after the stop it touches. --all-corridor tiles whole legs.

Run:
  scripts/.venv/bin/python scripts/build_helmet_tiles.py                 # demo windows
  scripts/.venv/bin/python scripts/build_helmet_tiles.py --all-corridor  # whole legs (check the budget)
  options: --force (write even above the size budget), --dry-run (selection only), --no-previews
Previews (hillshade | ortho + route | blend + sand) go to scripts/raw/previews/<window>.png.
"""
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
TREK_CACHE = RAW / "trek" / "17"
PREVIEWS = RAW / "previews"
DATA = ROOT.parent / "public" / "data"
OUT = DATA / "helmet"
TILES = OUT / "tiles"

# Sources
DTM_URL = (
    "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/"
    "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
)
# planetarymaps.usgs.gov answers with a 302 to this S3 copy, which serves byte ranges directly.
DTM_S3_URL = (
    "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/"
    "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
)
TREK_LAYER = "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd"
TREK_URL = "https://trek.nasa.gov/tiles/Mars/EQ/" + TREK_LAYER + "/1.0.0/default/default028mm/{z}/{y}/{x}.png"
TREK_Z = 17

# Geometry
R_APP = 3389500.0  # src/lib/geo.ts MARS_RADIUS_M: the app's metres
R_PROJ = 3396190.0  # sphere of the DTM's equirectangular projection
TILE_M = 128
SAMPLES = TILE_M + 1  # 1 m elevation samples with shared edges
ORTHO_PX = 512  # 0.25 m/px
SAND_PX = 256  # 0.5 m/px
SAND_MARGIN_M = 16  # sand features are computed on a slightly bigger image, then cropped (no edge effects)

# Selection and budget
CORRIDOR_M = 150
WINDOW_M = 600
BUDGET_BYTES = 40 * 1024 * 1024

# Quality gates
SANITY_MAX_DIFF_M = 2.0  # tile median vs the 10 m planner grid
MAX_NODATA_FRAC = 0.5  # tiles with more DTM no-data than this are skipped (the world uses the coarse fallback)
JPEG_QUALITY = 80

# Sand mask (sand_mask()). Tuned by eye on HiRISE at Seitah (ripple fields between bright bedrock, small ripples on
# the smooth floor) and checked on the previews. Everything runs on the ortho downsampled to 0.5 m/px and divided by
# the median of the (margin-extended) tile, so slow albedo changes across the crater do not matter.
# Smoothing is a Gaussian (three box passes) of the given sigma.
SAND_BAND_M = (0.75, 4.0)  # band-pass sigmas, metres: keeps the ripple scale (wavelengths ~2-10 m)
SAND_TENSOR_SIGMA_M = 5.0  # structure-tensor smoothing, metres: a few ripple wavelengths
SAND_COH_MIN = 0.55  # orientation coherence (0 = no direction, 1 = one direction) above this = parallel ripples
SAND_ENERGY_MIN = 0.04  # ... with at least this much band-pass gradient (per metre, relative units): not flat ground
SAND_ROCK_REL = 1.5  # 0.5 m-smoothed pixels brighter than this are bright bedrock or float rock
SAND_ROCK_SIGMA_M = 3.0  # their density is smoothed over this sigma ...
SAND_ROCK_MAX = 0.12  # ... and above this share there is no sand (ripple crests stay below, bedrock outcrops above)
SAND_SHEET_REL = 0.85  # featureless sand sheet: 4 m-smoothed brightness below this ...
SAND_SHEET_ENERGY = 0.03  # ... and band-pass energy below this (dark and smooth)
SAND_OPEN_PX = 5  # opening filter in 0.5 m pixels: removes specks under ~2.5 m
SAND_CLOSE_PX = 7  # closing filter: joins ripple crests and troughs into one patch


def log(*a):
    print(*a, flush=True)


# --------------------------------------------------------------------------------------------------------------
# Tile grid


class Grid:
    def __init__(self, meta):
        self.origin_lat = meta["north"]
        self.origin_lon = meta["west"]
        self.scale_lat = (meta["south"] + meta["north"]) / 2
        m_per_deg = R_APP * math.pi / 180
        self.deg_lat = TILE_M / m_per_deg
        self.deg_lon = TILE_M / (m_per_deg * math.cos(math.radians(self.scale_lat)))
        self.kx = m_per_deg * math.cos(math.radians(self.scale_lat))  # metres per degree of longitude
        self.ky = m_per_deg

    def xy(self, lat, lon):
        """Metres east and south of the origin (y grows southwards, like rows)."""
        return (np.asarray(lon) - self.origin_lon) * self.kx, (self.origin_lat - np.asarray(lat)) * self.ky

    def bounds(self, row, col):
        north = self.origin_lat - row * self.deg_lat
        west = self.origin_lon + col * self.deg_lon
        return west, north - self.deg_lat, west + self.deg_lon, north  # west, south, east, north

    @staticmethod
    def tile_id(row, col):
        return f"r{row:04d}_c{col:04d}"


# --------------------------------------------------------------------------------------------------------------
# Selection


def densify(xy, step=4.0):
    out = [xy[0]]
    for a, b in zip(xy[:-1], xy[1:]):
        d = math.dist(a, b)
        n = max(1, int(math.ceil(d / step)))
        for k in range(1, n + 1):
            out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    return out


def cut(xy, start_m, end_m):
    """Part of a polyline between two distances along it."""
    out = []
    acc = 0.0
    for a, b in zip(xy[:-1], xy[1:]):
        d = math.dist(a, b)
        if acc + d >= start_m and acc <= end_m and d > 0:
            t0 = max(0.0, (start_m - acc) / d)
            t1 = min(1.0, (end_m - acc) / d)
            p0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            p1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            if not out:
                out.append(p0)
            out.append(p1)
        acc += d
    return out


def tiles_near(points, radius):
    found = set()
    for x, y in points:
        for row in range(int(math.floor((y - radius) / TILE_M)), int(math.floor((y + radius) / TILE_M)) + 1):
            for col in range(int(math.floor((x - radius) / TILE_M)), int(math.floor((x + radius) / TILE_M)) + 1):
                dx = max(col * TILE_M - x, 0, x - (col + 1) * TILE_M)
                dy = max(row * TILE_M - y, 0, y - (row + 1) * TILE_M)
                if dx * dx + dy * dy <= radius * radius:
                    found.add((row, col))
    return found


def select(grid, routes, all_corridor):
    """Returns {window id: {"tiles": set, "segments": [polyline xy], "legs": n}}."""
    windows = {}

    def add(win, seg):
        w = windows.setdefault(win, {"tiles": set(), "segments": []})
        w["segments"].append(seg)
        w["tiles"] |= tiles_near(densify(seg), CORRIDOR_M)

    for leg in routes["legs"]:
        lat = [p[0] for p in leg["path"]]
        lon = [p[1] for p in leg["path"]]
        xs, ys = grid.xy(lat, lon)
        xy = list(zip(xs.tolist(), ys.tolist()))
        length = sum(math.dist(a, b) for a, b in zip(xy[:-1], xy[1:]))
        if all_corridor:
            add(leg["fromId"], cut(xy, 0, length / 2))
            add(leg["toId"], cut(xy, length / 2, length))
        else:
            add(leg["fromId"], cut(xy, 0, min(WINDOW_M, length)))
            add(leg["toId"], cut(xy, max(0.0, length - WINDOW_M), length))
    return windows


# --------------------------------------------------------------------------------------------------------------
# Elevation: windowed DTM reads + the 10 m grid


def open_dtm():
    import rasterio

    os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
    os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
    local = RAW / "jezero_hirise_dtm_1m.tif"
    if local.exists():
        log(f"DTM: local copy {local}")
        return rasterio.open(local)
    for url in (DTM_URL, DTM_S3_URL):
        try:
            src = rasterio.open("/vsicurl/" + url)
            log(f"DTM: windowed reads from {url}")
            return src
        except Exception as e:  # noqa: BLE001 - report and try the next URL
            log(f"DTM: cannot open {url}: {e}")
    raise SystemExit("Cannot open the 1 m DTM over HTTP. Download it into scripts/raw/ (see scripts/fetch_data.sh --full).")


def sample_positions(grid, row, col):
    west, south, east, north = grid.bounds(row, col)
    k = np.arange(SAMPLES) / (SAMPLES - 1)
    lon = west + k * (east - west)
    lat = north - k * (north - south)
    return np.meshgrid(lat, lon, indexing="ij")  # (129, 129) lat, lon; row 0 north


def dtm_pixel(src, lat, lon):
    """Fractional pixel coordinates of pixel centres (col, row) in the DTM for lat/lon in degrees."""
    x = np.radians(lon) * R_PROJ
    y = np.radians(lat) * R_PROJ
    t = src.transform
    col = (x - t.c) / t.a - 0.5
    row = (y - t.f) / t.e - 0.5
    return col, row


def bilinear(a, col, row):
    """Bilinear sample of a with NaN propagation; outside the array = NaN."""
    h, w = a.shape
    c0 = np.floor(col).astype(int)
    r0 = np.floor(row).astype(int)
    fc = col - c0
    fr = row - r0
    out = np.full(col.shape, np.nan, dtype="float64")
    ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
    c0o, r0o, fco, fro = c0[ok], r0[ok], fc[ok], fr[ok]
    v = (
        a[r0o, c0o] * (1 - fco) * (1 - fro)
        + a[r0o, c0o + 1] * fco * (1 - fro)
        + a[r0o + 1, c0o] * (1 - fco) * fro
        + a[r0o + 1, c0o + 1] * fco * fro
    )
    out[ok] = v
    return out


def read_dtm_block(src, grid, tiles):
    """Reads one DTM window covering `tiles` and returns {tile: (129,129) float metres with NaN}."""
    from rasterio.windows import Window

    pos = {t: sample_positions(grid, *t) for t in tiles}
    cols = np.concatenate([dtm_pixel(src, la, lo)[0].ravel() for la, lo in pos.values()])
    rows = np.concatenate([dtm_pixel(src, la, lo)[1].ravel() for la, lo in pos.values()])
    c0 = max(0, int(math.floor(cols.min())) - 1)
    r0 = max(0, int(math.floor(rows.min())) - 1)
    c1 = min(src.width, int(math.ceil(cols.max())) + 2)
    r1 = min(src.height, int(math.ceil(rows.max())) + 2)
    out = {}
    if c1 <= c0 or r1 <= r0:
        for t in tiles:
            out[t] = np.full((SAMPLES, SAMPLES), np.nan)
        return out
    a = src.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype("float64")
    a[(a < -1e5) | ~np.isfinite(a)] = np.nan
    for t, (la, lo) in pos.items():
        c, r = dtm_pixel(src, la, lo)
        out[t] = bilinear(a, c - c0, r - r0)
    return out


def grid10_sampler(meta):
    w, h = meta["width"], meta["height"]
    e = np.fromfile(DATA / "jezero_elev.bin", dtype="<i2").reshape(h, w).astype("float64")
    e[e == -32768] = np.nan
    e /= 10.0

    def sample(lat, lon):
        col = (lon - meta["west"]) / (meta["east"] - meta["west"]) * w - 0.5
        row = (meta["north"] - lat) / (meta["north"] - meta["south"]) * h - 0.5
        return bilinear(e, col, row)

    return sample


# --------------------------------------------------------------------------------------------------------------
# Ortho: Trek z17 tiles


TREK_DEG = 180.0 / 2**TREK_Z


def trek_range(west, south, east, north):
    x0 = int(math.floor((west + 180) / TREK_DEG))
    x1 = int(math.floor((east + 180) / TREK_DEG))
    y0 = int(math.floor((90 - north) / TREK_DEG))
    y1 = int(math.floor((90 - south) / TREK_DEG))
    return x0, x1, y0, y1


def trek_path(y, x):
    return TREK_CACHE / str(y) / f"{x}.png"


def fetch_trek(yx):
    """Downloads one Trek tile into the cache. Returns 'hit', 'ok', '404' or an error string."""
    y, x = yx
    p = trek_path(y, x)
    missing = p.with_suffix(".404")
    if p.exists():
        return "hit"
    if missing.exists():
        return "404"
    p.parent.mkdir(parents=True, exist_ok=True)
    url = TREK_URL.format(z=TREK_Z, y=y, x=x)
    req = urllib.request.Request(url, headers={"User-Agent": "helmet-tile-builder/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            tmp = p.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(p)
            return "ok"
        except urllib.error.HTTPError as e:
            if e.code == 404:
                missing.touch()
                return "404"
            err = f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001 - network hiccup: retry
            err = str(e)
        time.sleep(1.5 * (attempt + 1))
    return f"error {err} {url}"


def ortho_image(west, south, east, north, px):
    """Grayscale ortho (float, 0..255) and validity mask, px x px, pixel centres inside the bounds."""
    x0, x1, y0, y1 = trek_range(west, south, east, north)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    lum = Image.new("L", (nx * 256, ny * 256), 0)
    alpha = Image.new("L", (nx * 256, ny * 256), 0)
    for j in range(ny):
        for i in range(nx):
            p = trek_path(y0 + j, x0 + i)
            if not p.exists():
                continue
            im = Image.open(p).convert("LA")
            lum.paste(im.getchannel(0), (i * 256, j * 256))
            alpha.paste(im.getchannel(1), (i * 256, j * 256))
    # mosaic pixel coordinates of the requested bounds (pixel edges)
    lon0 = -180 + x0 * TREK_DEG
    lat0 = 90 - y0 * TREK_DEG
    s = 256 / TREK_DEG
    box = ((west - lon0) * s, (lat0 - north) * s, (east - lon0) * s, (lat0 - south) * s)
    l = np.asarray(lum.transform((px, px), Image.EXTENT, box, resample=Image.BICUBIC), dtype="float32")
    a = np.asarray(alpha.transform((px, px), Image.EXTENT, box, resample=Image.BILINEAR), dtype="float32")
    return l, a >= 250


# --------------------------------------------------------------------------------------------------------------
# Sand mask


def box(a, k):
    """Mean over a k x k box (k odd), edges padded by reflection."""
    r = k // 2
    p = np.pad(a, r, mode="reflect")
    c = np.cumsum(np.cumsum(p, axis=0), axis=1)
    c = np.pad(c, ((1, 0), (1, 0)))
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s / (k * k)


def odd(n):
    n = int(round(n))
    return n if n % 2 else n + 1


def gauss(a, sigma_px):
    """Approximate Gaussian blur: three box passes of width ~2 sigma."""
    k = odd(2 * sigma_px)
    for _ in range(3):
        a = box(a, k)
    return a


def sand_mask(lum, valid, m_per_px):
    """Sand / loose ground from a grayscale ortho (already at the mask resolution). Returns a bool array.

    sand = (ripples OR dark featureless sheet) AND no bright rock nearby, then opening + closing.
      ripples   band-pass the image (SAND_BAND_M), structure tensor smoothed over SAND_TENSOR_SIGMA_M:
                coherence >= SAND_COH_MIN and gradient energy >= SAND_ENERGY_MIN
      sheet     4 m-smoothed brightness < SAND_SHEET_REL and energy < SAND_SHEET_ENERGY
      rock      share of pixels brighter than SAND_ROCK_REL (smoothed over SAND_ROCK_SIGMA_M) > SAND_ROCK_MAX vetoes
    A heuristic from orbit, not a measurement: good enough for scenery and as eval ground truth.
    """
    if valid.mean() < 0.2:
        return np.zeros(lum.shape, dtype=bool)
    med = float(np.median(lum[valid]))
    if med <= 1:
        return np.zeros(lum.shape, dtype=bool)
    g = np.where(valid, lum, med).astype("float64") / med
    lo, hi = SAND_BAND_M
    bp = gauss(g, lo / m_per_px) - gauss(g, hi / m_per_px)
    gy, gx = np.gradient(bp)
    s = SAND_TENSOR_SIGMA_M / m_per_px
    jxx, jyy, jxy = gauss(gx * gx, s), gauss(gy * gy, s), gauss(gx * gy, s)
    coh = np.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / (jxx + jyy + 1e-12)
    energy = np.sqrt(jxx + jyy) / m_per_px
    ripples = (coh >= SAND_COH_MIN) & (energy >= SAND_ENERGY_MIN)
    sheet = (gauss(g, 4 / m_per_px) < SAND_SHEET_REL) & (energy < SAND_SHEET_ENERGY)
    rock = gauss((gauss(g, 0.5 / m_per_px) > SAND_ROCK_REL).astype("float64"), SAND_ROCK_SIGMA_M / m_per_px)
    sand = (ripples | sheet) & (rock <= SAND_ROCK_MAX) & valid
    im = Image.fromarray((sand * 255).astype("uint8"), "L")
    k = SAND_OPEN_PX
    im = im.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))  # opening
    k = SAND_CLOSE_PX
    im = im.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))  # closing
    return np.asarray(im) > 127


# --------------------------------------------------------------------------------------------------------------
# Previews


def hillshade(z, m_per_px, az=315.0, alt=45.0):
    gy, gx = np.gradient(z, m_per_px)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)  # gy is southwards (row order): this gives a north-up hillshade
    a = math.radians(az)
    e = math.radians(alt)
    hs = np.sin(e) * np.cos(slope) + np.cos(e) * np.sin(slope) * np.cos(a - aspect)
    return np.clip(hs, 0, 1)


def write_preview(name, grid, tiles, built, segments):
    rows = [t[0] for t in tiles]
    cols = [t[1] for t in tiles]
    r0, c0 = min(rows), min(cols)
    nr, nc = max(rows) - r0 + 1, max(cols) - c0 + 1
    S = TILE_M  # 1 px per metre
    elev = np.full((nr * S, nc * S), np.nan)
    orth = np.zeros((nr * S, nc * S), dtype="float32")
    sand = np.zeros((nr * S, nc * S), dtype=bool)
    for t in tiles:
        if t not in built:
            continue
        b = built[t]
        y, x = (t[0] - r0) * S, (t[1] - c0) * S
        elev[y : y + S, x : x + S] = b["elev"][:S, :S]
        orth[y : y + S, x : x + S] = np.asarray(Image.fromarray(b["ortho"]).resize((S, S), Image.BOX), dtype="float32")
        sand[y : y + S, x : x + S] = np.asarray(Image.fromarray(b["sand"].astype("uint8") * 255).resize((S, S), Image.NEAREST)) > 127
    have = np.isfinite(elev)
    fill = np.where(have, elev, np.nanmean(elev) if have.any() else 0)
    hs = hillshade(fill, 1.0)
    hs_img = np.where(have, hs * 255, 0).astype("uint8")
    blend = np.where(have, orth * (0.35 + 0.9 * hs), 0)
    blend_rgb = np.stack([blend, blend, blend], -1)
    blend_rgb[sand] = blend_rgb[sand] * 0.5 + np.array([232, 176, 74]) * 0.5
    panels = [
        Image.fromarray(hs_img).convert("RGB"),
        Image.fromarray(orth.astype("uint8")).convert("RGB"),
        Image.fromarray(np.clip(blend_rgb, 0, 255).astype("uint8"), "RGB"),
    ]
    for p in panels:
        d = ImageDraw.Draw(p)
        for t in tiles:
            y, x = (t[0] - r0) * S, (t[1] - c0) * S
            d.rectangle([x, y, x + S - 1, y + S - 1], outline=(70, 140, 255) if t in built else (255, 0, 0))
        for seg in segments:
            pts = [(x - c0 * S, y - r0 * S) for x, y in seg]
            if len(pts) > 1:
                d.line(pts, fill=(80, 255, 140), width=2)
    W, H = panels[0].size
    sheet = Image.new("RGB", (W * 3 + 20, H), (20, 20, 20))
    for i, p in enumerate(panels):
        sheet.paste(p, (i * (W + 10), 0))
    if sheet.width > 3000:
        f = 3000 / sheet.width
        sheet = sheet.resize((3000, max(1, int(sheet.height * f))), Image.LANCZOS)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    path = PREVIEWS / f"{name}.png"
    sheet.save(path)
    return path


# --------------------------------------------------------------------------------------------------------------


def main():
    args = set(sys.argv[1:])
    all_corridor = "--all-corridor" in args
    force = "--force" in args
    dry = "--dry-run" in args

    meta = json.loads((DATA / "jezero_terrain.json").read_text())
    routes = json.loads((OUT / "routes.json").read_text())
    grid = Grid(meta)
    windows = select(grid, routes, all_corridor)
    all_tiles = sorted(set().union(*(w["tiles"] for w in windows.values())))
    log(f"{len(routes['legs'])} legs, {len(windows)} windows, {len(all_tiles)} tiles "
        f"({'whole legs' if all_corridor else f'{WINDOW_M} m demo windows'}, corridor {CORRIDOR_M} m)")
    if dry:
        for name, w in windows.items():
            log(f"  {name:20s} {len(w['tiles']):4d} tiles")
        return

    # 1. Ortho tiles from Trek (cached)
    need = set()
    for t in all_tiles:
        west, south, east, north = grid.bounds(*t)
        m = SAND_MARGIN_M / TILE_M
        dw, dh = (east - west) * m, (north - south) * m
        x0, x1, y0, y1 = trek_range(west - dw, south - dh, east + dw, north + dh)
        need |= {(y, x) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)}
    log(f"Trek z{TREK_Z}: {len(need)} tiles needed")
    stats = {}
    errors = []
    with ThreadPoolExecutor(8) as ex:
        for i, res in enumerate(ex.map(fetch_trek, sorted(need))):
            key = res if not res.startswith("error") else "error"
            stats[key] = stats.get(key, 0) + 1
            if key == "error":
                errors.append(res)
            if (i + 1) % 500 == 0:
                log(f"  {i + 1}/{len(need)} {stats}")
    log(f"  done {stats}")
    if errors:
        for e in errors[:10]:
            log("  " + e)
        raise SystemExit(f"{len(errors)} Trek tiles failed to download; rerun to retry (cache keeps the rest).")

    # 2. Elevation from the DTM, in blocks of 8 x 8 tiles (one HTTP window each)
    src = open_dtm()
    g10 = grid10_sampler(meta)
    blocks = {}
    for t in all_tiles:
        blocks.setdefault((t[0] // 8, t[1] // 8), []).append(t)
    elev = {}
    t0 = time.time()
    for i, (k, ts) in enumerate(sorted(blocks.items())):
        elev.update(read_dtm_block(src, grid, ts))
        log(f"  DTM block {i + 1}/{len(blocks)}: {len(ts)} tiles, {time.time() - t0:.0f} s")

    # 3. Build every tile in memory
    built = {}
    skipped = []
    sanity_fail = []
    sanity_diffs = []
    files = {}
    for t in all_tiles:
        tid = grid.tile_id(*t)
        west, south, east, north = grid.bounds(*t)
        z = elev[t]
        nodata = float(np.isnan(z).mean())
        if nodata > MAX_NODATA_FRAC:
            skipped.append((tid, f"DTM no-data {nodata:.0%}"))
            continue
        la, lo = sample_positions(grid, *t)
        z10 = g10(la, lo)
        filled = 0.0
        if nodata > 0:
            hole = np.isnan(z)
            z = np.where(hole, z10, z)
            filled = nodata
            if np.isnan(z).any():
                z = np.where(np.isnan(z), np.nanmedian(z), z)
        # sanity: tile median vs the 10 m planner grid over the same samples
        both = np.isfinite(z10)
        if both.any():
            diff = float(np.median(z[both]) - np.median(z10[both]))
            sanity_diffs.append(diff)
            if abs(diff) > SANITY_MAX_DIFF_M:
                sanity_fail.append((tid, diff))
        zmin = math.floor(float(z.min()) * 100) / 100
        cm = np.round((z - zmin) * 100)
        if cm.max() > 32767:
            skipped.append((tid, f"relief {cm.max() / 100:.0f} m exceeds int16 cm"))
            continue
        elev_bytes = cm.astype("<i2").tobytes()

        # ortho with a margin for the sand features, then the central crop
        mpx = TILE_M / ORTHO_PX
        margin_px = int(SAND_MARGIN_M / mpx)
        big = ORTHO_PX + 2 * margin_px
        dw = (east - west) * margin_px / ORTHO_PX
        dh = (north - south) * margin_px / ORTHO_PX
        lum_big, ok_big = ortho_image(west - dw, south - dh, east + dw, north + dh, big)
        lum = lum_big[margin_px:-margin_px, margin_px:-margin_px]
        ok = ok_big[margin_px:-margin_px, margin_px:-margin_px]
        ortho_valid = float(ok.mean())
        if ok.any():
            fill_v = float(np.median(lum[ok]))
        else:
            fill_v = 110.0  # neutral mid-grey: the shader tints it
        ortho_u8 = np.clip(np.where(ok, lum, fill_v), 0, 255).astype("uint8")
        buf = io.BytesIO()
        Image.fromarray(ortho_u8, "L").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
        ortho_bytes = buf.getvalue()

        # sand at 0.5 m/px on the extended image, cropped to the tile
        f = ORTHO_PX // SAND_PX
        hb = big // f
        lum_s = lum_big[: hb * f, : hb * f].reshape(hb, f, hb, f).mean(axis=(1, 3))
        ok_s = ok_big[: hb * f, : hb * f].reshape(hb, f, hb, f).mean(axis=(1, 3)) > 0.5
        sand_big = sand_mask(lum_s, ok_s, TILE_M / SAND_PX)
        mp = margin_px // f
        sand = sand_big[mp : mp + SAND_PX, mp : mp + SAND_PX]
        buf = io.BytesIO()
        Image.fromarray(sand.astype("uint8") * 255, "L").convert("1").save(buf, "PNG", optimize=True)
        sand_bytes = buf.getvalue()

        entry = {
            "id": tid,
            "row": t[0],
            "col": t[1],
            "west": round(west, 9),
            "south": round(south, 9),
            "east": round(east, 9),
            "north": round(north, 9),
            "zMin": zmin,
            "file": f"tiles/{tid}.bin",
            "ortho": f"tiles/{tid}.jpg",
            "sand": f"tiles/{tid}_sand.png",
        }
        if ortho_valid < 0.999:
            entry["orthoValid"] = round(ortho_valid, 3)
        if filled > 0:
            entry["dtmFilled"] = round(filled, 3)
        entry["sandFrac"] = round(float(sand.mean()), 3)
        built[t] = {"entry": entry, "elev": z, "ortho": ortho_u8, "sand": sand}
        files[f"{tid}.bin"] = elev_bytes
        files[f"{tid}.jpg"] = ortho_bytes
        files[f"{tid}_sand.png"] = sand_bytes

    # 4. Report
    total = sum(len(b) for b in files.values())
    by_kind = {k: sum(len(v) for n, v in files.items() if n.endswith(k)) for k in (".bin", ".jpg", "_sand.png")}
    log("\nDemo windows:")
    log(f"  {'window':20s} {'segments':>8s} {'tiles':>6s} {'built':>6s} {'MB':>6s}")
    for name, w in sorted(windows.items()):
        ts = w["tiles"]
        nb = sum(1 for t in ts if t in built)
        mb = sum(len(files[f"{grid.tile_id(*t)}{s}"]) for t in ts if t in built for s in (".bin", ".jpg", "_sand.png")) / 2**20
        log(f"  {name:20s} {len(w['segments']):8d} {len(ts):6d} {nb:6d} {mb:6.1f}")
    log(f"  {'all (unique)':20s} {'':8s} {len(all_tiles):6d} {len(built):6d} {total / 2**20:6.1f}")
    log(f"  by kind: elevation {by_kind['.bin'] / 2**20:.1f} MB, ortho {by_kind['.jpg'] / 2**20:.1f} MB, "
        f"sand {by_kind['_sand.png'] / 2**20:.2f} MB")
    for tid, why in skipped:
        log(f"  skipped {tid}: {why}")
    d = np.array(sanity_diffs)
    if d.size:
        log(f"\nElevation sanity (tile median - 10 m grid median): {d.size} tiles, mean {d.mean():+.2f} m, "
            f"max |diff| {np.abs(d).max():.2f} m, failures (> {SANITY_MAX_DIFF_M} m): {len(sanity_fail)}")
    for tid, diff in sanity_fail:
        log(f"  SANITY FAIL {tid}: {diff:+.2f} m")
    nonfull = [b["entry"] for b in built.values() if "orthoValid" in b["entry"]]
    if nonfull:
        log(f"Ortho partly missing on {len(nonfull)} tiles (filled with the tile median grey), "
            f"worst {min(e['orthoValid'] for e in nonfull):.0%} valid")

    if total > BUDGET_BYTES and not force:
        raise SystemExit(f"\nTotal {total / 2**20:.1f} MB exceeds the {BUDGET_BYTES / 2**20:.0f} MB budget. "
                         "Nothing written. Use --force to write anyway.")

    # 5. Write
    TILES.mkdir(parents=True, exist_ok=True)
    keep = set(files)
    for old in TILES.iterdir():
        if old.name not in keep:
            old.unlink()
    for name, data in files.items():
        (TILES / name).write_bytes(data)
    index = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "elevation": DTM_URL,
            "ortho": f"Mars Trek WMTS {TREK_LAYER}, zoom {TREK_Z}",
            "routes": "public/data/helmet/routes.json (scripts/export_routes.ts)",
        },
        "selection": "whole legs" if all_corridor else f"demo windows: first/last {WINDOW_M} m of every leg",
        "corridorM": CORRIDOR_M,
        "tileSizeM": TILE_M,
        "sampleM": 1,
        "samples": SAMPLES,
        "orthoMPerPx": TILE_M / ORTHO_PX,
        "orthoPx": ORTHO_PX,
        "sandMPerPx": TILE_M / SAND_PX,
        "sandPx": SAND_PX,
        "radiusM": R_APP,
        "origin": {"lat": grid.origin_lat, "lon": grid.origin_lon},
        "scaleLat": grid.scale_lat,
        "tileDegLat": grid.deg_lat,
        "tileDegLon": grid.deg_lon,
        "elevEncoding": "int16 little-endian, centimetres above zMin (metres, areoid), 129 x 129, row 0 = north, "
        "shared edges (sample k at west + k/128 of the tile)",
        "orthoEncoding": "grayscale JPEG, 512 x 512, 0.25 m/px, row 0 = north",
        "sandEncoding": "1-bit PNG, 256 x 256, 0.5 m/px, white = sand (derived from the ortho; ground truth only)",
        "totalBytes": total,
        "windows": [
            {"id": name, "tiles": sorted(grid.tile_id(*t) for t in w["tiles"] if t in built)}
            for name, w in sorted(windows.items())
        ],
        "tiles": [built[t]["entry"] for t in sorted(built)],
    }
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")
    log(f"\nWrote {len(built)} tiles ({total / 2**20:.1f} MB) to {TILES} and {OUT / 'index.json'}")

    # 6. Previews
    if "--no-previews" not in args:
        for name, w in sorted(windows.items()):
            p = write_preview(name, grid, sorted(w["tiles"]), built, w["segments"])
            log(f"  preview {p}")


if __name__ == "__main__":
    main()
