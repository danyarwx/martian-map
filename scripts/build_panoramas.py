#!/usr/bin/env python3
"""Build 360° panoramas for the helmet view from Perseverance Navcam raw images.

NASA's MMGIS panorama files (the `images` URLs in M20_waypoints.json) now return 404, so we
stitch our own from the public raw-image feed. At each end-of-drive stop the rover takes a ring
of 5 Navcam pointings (~72° apart), each delivered as 4 quadrant tiles with their own CAHVORE
camera model. For every output pixel (azimuth from north, elevation) we:
  1. make a unit direction in the site frame (x north, y east, z down),
  2. rotate it into the rover frame with the image's attitude quaternion (rover -> site),
  3. project it with the tile's CAHV model (x = d·H / d·A, y = d·V / d·A; O/R/E distortion ignored),
  4. blend overlapping tiles, weighting pixels near a tile's centre more.

Output: public/data/panoramas/navcam_sol<SOL>.jpg, equirectangular, 360° wide,
elevation EL_TOP..EL_BOTTOM, PX_PER_DEG pixels per degree. The constants must match
src/panels/walkScript.ts.

Usage: python3 scripts/build_panoramas.py   (needs numpy and pillow)
Source: https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=<SOL>
"""
import io
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

# Stops on the demo walk: sol -> site/drive tag in the image id (end-of-drive position).
STOPS = {1224: 'N0561998', 1219: 'N0560784', 1210: 'N0560000'}
PX_PER_DEG = 10
EL_TOP, EL_BOTTOM = 25.0, -75.0
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'panoramas')
FEED = 'https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol={sol}'
SKY_TOP, SKY_HORIZON = np.array([168, 124, 90]), np.array([214, 172, 132])  # used where no photo covers


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': 'martian-map-build/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def vec(s: str) -> np.ndarray:
    return np.array([float(v) for v in s.strip('()').split(',')])


def quat_to_matrix(w: float, x: float, y: float, z: float) -> np.ndarray:
    """Rotation matrix for a unit quaternion (scalar first). Maps rover frame -> site frame."""
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def navcam_tiles(sol: int, tag: str) -> list[dict]:
    images = json.loads(get(FEED.format(sol=sol)))['images']
    tiles = [
        i for i in images
        if i['camera']['instrument'] == 'NAVCAM_LEFT'
        and i['extended']['dimension'] == '(1288,968)'
        and tag in i['imageid']
        and i['camera'].get('camera_model_component_list')
    ]
    # one tile per image id (the feed sometimes repeats entries)
    return list({t['imageid']: t for t in tiles}.values())


def smooth_columns(colors: np.ndarray, width: int) -> np.ndarray:
    """Moving average along the 360° axis (wraps around), to avoid streaks in the filled sky."""
    k = np.ones(width) / width
    pad = width
    ext = np.concatenate([colors[-pad:], colors, colors[:pad]])
    return np.stack([np.convolve(ext[:, c], k, mode='same')[pad:-pad] for c in range(3)], axis=-1)


def fill_gaps(out: np.ndarray, covered: np.ndarray) -> None:
    """Fill rows above (sky) and below the photos, continuing each column's edge colour smoothly."""
    H, W = covered.shape
    has = covered.any(axis=0)
    top = np.where(has, covered.argmax(axis=0), H // 2)
    bottom = np.where(has, H - 1 - covered[::-1].argmax(axis=0), H // 2)
    cols = np.arange(W)
    edge_top = np.stack([out[np.clip(top + r, 0, H - 1), cols] for r in range(2, 10)]).mean(axis=0)
    edge_bot = np.stack([out[np.clip(bottom - r, 0, H - 1), cols] for r in range(2, 10)]).mean(axis=0)
    edge_top = smooth_columns(edge_top, 121)
    edge_bot = smooth_columns(edge_bot, 121)
    sky_top = (edge_top.mean(axis=0) * 0.85 + SKY_TOP * 0.15)  # slightly deeper at the zenith side
    rows = np.arange(H)[:, None]
    # above the photos: from the edge colour at the edge, fading to a uniform sky colour at the top
    t = np.clip((top[None, :] - rows) / np.maximum(top[None, :], 1), 0, 1)[..., None]
    sky = edge_top[None] * (1 - t) + sky_top * t
    above = rows < top[None, :]
    out[above & ~covered] = sky[above & ~covered]
    below = rows > bottom[None, :]
    out[below & ~covered] = np.broadcast_to(edge_bot[None], out.shape)[below & ~covered]
    # any hole left inside the photos: plain average colour
    rest = ~covered & ~above & ~below
    out[rest] = out[covered].mean(axis=0) if covered.any() else SKY_HORIZON
    # soften the seam: blend the first rows of each photo edge into the fill
    for r in range(6):
        a = (r + 1) / 7
        rr = np.clip(top + r, 0, H - 1)
        out[rr, cols] = out[rr, cols] * a + edge_top * (1 - a)


def build(sol: int, tag: str) -> None:
    tiles = navcam_tiles(sol, tag)
    if not tiles:
        sys.exit(f'sol {sol}: no Navcam tiles found for {tag}')
    W = 360 * PX_PER_DEG
    H = int((EL_TOP - EL_BOTTOM) * PX_PER_DEG)
    az = np.radians((np.arange(W) + 0.5) / PX_PER_DEG)
    el = np.radians(EL_TOP - (np.arange(H) + 0.5) / PX_PER_DEG)
    AZ, EL = np.meshgrid(az, el)
    d_site = np.stack([np.cos(EL) * np.cos(AZ), np.cos(EL) * np.sin(AZ), -np.sin(EL)], axis=-1)

    acc = np.zeros((H, W, 3))
    wsum = np.zeros((H, W))
    for t in tiles:
        R = quat_to_matrix(*vec(t['attitude']))
        d = d_site @ R  # site -> rover (R is orthonormal, so R^T d == d @ R)
        C, A, Hv, V = [vec(c) for c in t['camera']['camera_model_component_list'].split(';')[:4]]
        img = Image.open(io.BytesIO(get(t['image_files']['large']))).convert('RGB')
        k = img.width / 1288  # model is in 1288-px tile coordinates
        px = np.asarray(img, dtype=np.float64)
        da = d @ A
        with np.errstate(divide='ignore', invalid='ignore'):
            x = (d @ Hv) / da * k
            y = (d @ V) / da * k
        ok = (da > 0) & (x >= 0) & (x < img.width - 1) & (y >= 0) & (y < img.height - 1)
        xi = np.clip(x, 0, img.width - 1).astype(int)
        yi = np.clip(y, 0, img.height - 1).astype(int)
        # weight: 1 at the tile centre, 0 at its edges, so seams blend
        wx = 1 - np.abs(x / img.width * 2 - 1)
        wy = 1 - np.abs(y / img.height * 2 - 1)
        w = np.where(ok, np.clip(wx, 0, 1) * np.clip(wy, 0, 1), 0)
        acc += px[yi, xi] * w[..., None]
        wsum += w
        print(f'  sol {sol}: {t["imageid"]} covers {ok.mean() * 100:.1f}%')

    out = np.zeros((H, W, 3))
    covered = wsum > 1e-6
    out[covered] = acc[covered] / wsum[covered][:, None]
    fill_gaps(out, covered)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f'navcam_sol{sol}.jpg')
    Image.fromarray(out.astype(np.uint8)).save(path, quality=82, optimize=True)
    print(f'sol {sol}: {len(tiles)} tiles -> {path} ({W}x{H}, horizon row {int(EL_TOP * PX_PER_DEG)}, '
          f'{covered.mean() * 100:.0f}% covered)')


if __name__ == '__main__':
    for sol, tag in STOPS.items():
        build(sol, tag)
