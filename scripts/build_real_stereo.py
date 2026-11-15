#!/usr/bin/env python3
"""Rectified Perseverance Navcam stereo pair at Cheyava Falls, for the helmet's real-photo test (key R).

Picks a NAVCAM_LEFT / NAVCAM_RIGHT pair from NASA's public raw-image feed (same image timestamp,
same quadrant tile), rectifies it with Fusiello's method and writes, to public/data/helmet/real_stereo/:
  left.png, right.png   grayscale, OUT_W x OUT_H, rectified (same intrinsics, parallel axes, rows aligned)
  left_rgb.png          the left image in colour (the Navcam frames are colour)
  calib.json            StereoIntrinsics {width, height, fx, fy, cx, cy, baselineM} + provenance + checks

Method
1. Camera models. Each quadrant tile has its own CAHVORE model in 1288 x 968 tile pixels, in the rover
   frame (x forward, y right, z down). The linear part C, A, H, V gives the 3 x 4 matrix P = Q [I | -C],
   Q = [H; V; A]. The Navcam models are type 2 (fisheye): projecting with CAHV alone leaves rows 2 px
   apart (mean |dy| 2.1 px, `--model cahv --dry-run`), so rays first go through the fisheye and radial
   (O, R) part of CAHVORE (see to_linear); only E, the entrance-pupil shift (~1e-8), is ignored.
2. Fusiello, Trucco & Verri (2000), "A compact algorithm for rectification of stereo pairs":
   new x axis along the baseline C_R - C_L, new y = (mean optical axis) x (new x), new z = x cross y.
   Both cameras get the same rotation and the same intrinsics K = [[f,0,cx],[0,f,cy],[0,0,1]].
   f is the widest view that still has source data under every output pixel in both images; cx, cy put
   the middle of the two tiles in the middle of the output (the principal point ends near a corner,
   because a quadrant tile has the lens axis at its corner).
3. Resampling: for each output pixel, ray d = R^T K^-1 [u v 1]^T, source pixel = Q to_linear(d)
   (perspective divide), bilinear interpolation.
4. Check (printed and stored in calib.json): Shi-Tomasi corners spread over the left image, each one
   found in the right image by normalised cross-correlation over +-5 rows and all disparities; the row
   offset must average <= 1 px over >= 10 matches. Disparities give the depth range Z = f B / d.

Source: https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=<SOL>
Images: NASA/JPL-Caltech.
Run: scripts/.venv/bin/python scripts/build_real_stereo.py [--sol 1210] [--tag N0560000] [--pick <image id>]
"""
import argparse
import io
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "helmet" / "real_stereo"
RAW = ROOT / "scripts" / "raw" / "real_stereo"
FEED = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol={sol}"
TILE_W, TILE_H = 1288, 968  # quadrant tile size the camera models refer to
OUT_W, OUT_H = 512, 384
MAST_EL_RANGE = (-46.0, -22.0)  # looking at the ground in front of the rover, not the deck or the sky
# Rough rover footprint in the rover frame (x forward, y right, metres), including the arm stowed in front.
# Only used to rank candidate tiles: ground seen inside this box is the rover itself.
ROVER_BOX = (-1.9, 2.4, -1.6, 1.6)
SEARCH_ROWS = 5  # +- rows searched by the check
PATCH = 10  # half size of the NCC patch (21 x 21)
MIN_NCC = 0.8  # a match below this is reported but not counted
# Picked by eye among the top-ranked tiles (all rank 0.93-0.94 for ground share): half-metre rocks in the
# foreground, a rock field behind, sand ripples and wheel tracks. Pass --pick "" to use the top-ranked tile.
PREFERRED = "NLF_1210_0774362057_630ECM_N0560000NCAM03210_01_195J"


def curl(url: str) -> bytes:
    return subprocess.run(["curl", "-fsSL", "--max-time", "120", url], check=True, capture_output=True).stdout


def vec(s: str) -> np.ndarray:
    return np.array([float(v) for v in s.strip("()").split(",")])


def quat_to_matrix(w: float, x: float, y: float, z: float) -> np.ndarray:
    """Rotation for a unit quaternion, scalar first. The feed's attitude maps rover frame -> site frame
    (site: x north, y east, z down)."""
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def cahv(image: dict) -> dict:
    parts = image["camera"]["camera_model_component_list"].split(";")
    C, A, H, V, O, R = (vec(p) for p in parts[:6])
    # CAHVORE type: 1 perspective (linearity 1), 2 fisheye (linearity 0), 3 general (linearity = parameter)
    mtype = float(parts[7]) if len(parts) > 7 else 1.0
    linearity = {1.0: 1.0, 2.0: 0.0}.get(mtype, float(parts[8]) if len(parts) > 8 else 1.0)
    return {"C": C, "A": A, "H": H, "V": V, "O": O, "R": R, "linearity": linearity, "Q": np.stack([H, V, A]), "raw": parts}


def focal(m: dict) -> tuple[float, float]:
    """Horizontal and vertical focal lengths (pixels) of a CAHV model."""
    return float(np.linalg.norm(np.cross(m["A"], m["H"]))), float(np.linalg.norm(np.cross(m["A"], m["V"])))


def load_feed(sol: int) -> list[dict]:
    RAW.mkdir(parents=True, exist_ok=True)
    cache = RAW / f"feed_{sol}.json"
    if not cache.exists():
        cache.write_bytes(curl(FEED.format(sol=sol)))
    return json.loads(cache.read_text())["images"]


def ground_share(left: dict) -> float:
    """Share of the tile's pixels whose ray meets the ground 1.5-20 m away and outside the rover's
    footprint. Ground = the plane under the wheels (z = 0 in the rover frame; the rover origin is close
    to it), so a tilted rover on a slope is handled."""
    m = cahv(left)
    xs, ys = np.meshgrid(np.arange(8, TILE_W, 16), np.arange(8, TILE_H, 16))
    pix = np.stack([xs.ravel(), ys.ravel(), np.ones(xs.size)])
    d = pixel_rays(m, pix).T  # rays in the rover frame
    with np.errstate(divide="ignore", invalid="ignore"):
        t = -m["C"][2] / d[:, 2]
    hit = (d[:, 2] > 0) & (t > 0)
    g = m["C"] + t[:, None] * d
    rng = np.linalg.norm(g - m["C"], axis=1)
    x0, x1, y0, y1 = ROVER_BOX
    on_rover = (g[:, 0] > x0) & (g[:, 0] < x1) & (g[:, 1] > y0) & (g[:, 1] < y1)
    good = hit & ~on_rover & (rng > 1.5) & (rng < 20)
    return float(good.mean())


def candidates(images: list[dict], tag: str) -> list[dict]:
    """Left/right pairs: same image id apart from NL/NR, same tile, Navcam half-resolution quadrant tiles."""
    by_id = {i["imageid"]: i for i in images}
    pairs = []
    for left in by_id.values():
        if left["camera"]["instrument"] != "NAVCAM_LEFT" or tag not in left["imageid"]:
            continue
        if left["extended"].get("dimension") != f"({TILE_W},{TILE_H})" or not left["camera"].get("camera_model_component_list"):
            continue
        el = float(left["extended"]["mastEl"])
        if not MAST_EL_RANGE[0] <= el <= MAST_EL_RANGE[1]:
            continue
        right = by_id.get("NR" + left["imageid"][2:])
        if not right or not right["camera"].get("camera_model_component_list"):
            continue
        if right["extended"].get("dimension") != left["extended"]["dimension"]:
            continue
        if right["extended"].get("subframeRect") != left["extended"].get("subframeRect"):
            continue
        if right["date_taken_mars"] != left["date_taken_mars"]:
            continue
        pairs.append({"left": left, "right": right, "mastEl": el, "ground": ground_share(left)})
    pairs.sort(key=lambda p: -p["ground"])
    return pairs


def load_image(image: dict) -> np.ndarray:
    RAW.mkdir(parents=True, exist_ok=True)
    url = image["image_files"]["large"]
    cache = RAW / url.rsplit("/", 1)[-1]
    if not cache.exists():
        cache.write_bytes(curl(url))
    return np.asarray(Image.open(io.BytesIO(cache.read_bytes())).convert("RGB"), dtype=np.float64)


def rectifying_rotation(mL: dict, mR: dict, k: np.ndarray) -> np.ndarray:
    """Fusiello: rows are the new camera axes (x right along the baseline, y down, z forward), rover frame.
    k = the mean of the two old optical axes, as in Fusiello. A quadrant tile has the lens axis at one
    corner, so the principal point (cx, cy) lands near a corner of the output too: that is expected, and
    gives the widest view (smallest disparities) of the alternatives tried."""
    x = mR["C"] - mL["C"]
    x /= np.linalg.norm(x)
    y = np.cross(k, x)
    y /= np.linalg.norm(y)
    z = np.cross(x, y)
    return np.stack([x, y, z])


MODEL = "cahvore"  # "cahv" ignores O, R and the lens type (fails the row check, see README)


def to_linear(m: dict, d: np.ndarray) -> np.ndarray:
    """Map ray directions (3 x N, rover frame) to the virtual directions that the linear CAHV part
    projects, following JPL's CAHVORE model (Gennery 2006) with the entrance-pupil term E ignored:
    theta = angle from O, chi = theta (fisheye, type 2) or tan(L theta)/L, mu = R0 + R1 chi^2 + R2 chi^4,
    virtual point = (|lambda| / chi) O + (1 + mu) lambda."""
    if MODEL == "cahv":
        return d
    O, R, lin = m["O"], m["R"], m["linearity"]
    zeta = O @ d
    lam = d - np.outer(O, zeta)
    lmag = np.linalg.norm(lam, axis=0)
    theta = np.arctan2(lmag, zeta)
    if lin > 1e-9:
        chi = np.tan(lin * theta) / lin
    elif lin < -1e-9:
        chi = np.sin(lin * theta) / lin
    else:
        chi = theta
    mu = R[0] + R[1] * chi ** 2 + R[2] * chi ** 4
    small = chi < 1e-9
    zetap = np.where(small, zeta, lmag / np.where(small, 1, chi))
    return np.outer(O, zetap) + (1 + mu) * lam


def pixel_rays(m: dict, pix: np.ndarray) -> np.ndarray:
    """Inverse of to_linear: true ray directions (3 x N, rover frame) for tile pixels (3 x N, homogeneous)."""
    p = np.linalg.solve(m["Q"], pix)
    p *= np.sign(m["A"] @ p)
    if MODEL == "cahv":
        return p
    O, R, lin = m["O"], m["R"], m["linearity"]
    zeta = O @ p
    lam = p - np.outer(O, zeta)
    lmag = np.linalg.norm(lam, axis=0)
    t = lmag / zeta  # = (1 + mu) chi
    chi = t.copy()
    for _ in range(20):  # Newton on chi (1 + R0 + R1 chi^2 + R2 chi^4) = t
        f = chi * (1 + R[0] + R[1] * chi ** 2 + R[2] * chi ** 4) - t
        chi -= f / (1 + R[0] + 3 * R[1] * chi ** 2 + 5 * R[2] * chi ** 4)
    if lin > 1e-9:
        theta = np.arctan(lin * chi) / lin
    elif lin < -1e-9:
        theta = np.arcsin(lin * chi) / lin
    else:
        theta = chi
    u = lam / np.where(lmag > 0, lmag, 1)
    return np.outer(O, np.cos(theta)) + np.sin(theta) * u


def source_coords(m: dict, Rn: np.ndarray, K: np.ndarray, scale: float) -> tuple[np.ndarray, np.ndarray]:
    """Source pixel (x, y) in the downloaded image for every output pixel."""
    Q = m["Q"]
    us, vs = np.meshgrid(np.arange(OUT_W, dtype=np.float64), np.arange(OUT_H, dtype=np.float64))
    pix = np.stack([us.ravel(), vs.ravel(), np.ones(us.size)])
    d = to_linear(m, Rn.T @ np.linalg.solve(K, pix))  # rays in the rover frame
    p = Q @ d
    with np.errstate(divide="ignore", invalid="ignore"):
        x = np.where(p[2] > 0, p[0] / p[2], np.nan) * scale
        y = np.where(p[2] > 0, p[1] / p[2], np.nan) * scale
    return x.reshape(OUT_H, OUT_W), y.reshape(OUT_H, OUT_W)


def inside(x: np.ndarray, y: np.ndarray, w: int, h: int) -> np.ndarray:
    return np.isfinite(x) & np.isfinite(y) & (x >= 0) & (y >= 0) & (x <= w - 1) & (y <= h - 1)


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    ok = inside(x, y, w, h)
    xc = np.clip(np.nan_to_num(x), 0, w - 1.001)
    yc = np.clip(np.nan_to_num(y), 0, h - 1.001)
    x0 = np.floor(xc).astype(int)
    y0 = np.floor(yc).astype(int)
    fx = (xc - x0)[..., None]
    fy = (yc - y0)[..., None]
    out = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
           + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)
    out[~ok] = 0
    return out


def gray(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.299, 0.587, 0.114])


def rectify(left: dict, right: dict, imgL: np.ndarray, imgR: np.ndarray):
    mL, mR = cahv(left), cahv(right)
    sL = imgL.shape[1] / TILE_W  # the models are in 1288-px tile pixels; the download may be smaller
    sR = imgR.shape[1] / TILE_W
    mid = np.array([[TILE_W / 2], [TILE_H / 2], [1.0]])
    rays = [pixel_rays(m, mid)[:, 0] for m in (mL, mR)]
    Rn = rectifying_rotation(mL, mR, mL["A"] / np.linalg.norm(mL["A"]) + mR["A"] / np.linalg.norm(mR["A"]))
    fL = np.mean(focal(mL))
    # centre: the middle of each tile, seen through the new rotation, lands mid-image on average
    centres = []
    for ray in rays:
        r = Rn @ ray
        centres.append(r[:2] / r[2])
    cn = np.mean(centres, axis=0)  # normalised image coordinates of the common centre
    zoom = 0.5  # smallest focal length (widest view) that still has source pixels everywhere in both images
    while True:
        f = fL * OUT_W / TILE_W * zoom
        K = np.array([[f, 0, OUT_W / 2 - 0.5 - f * cn[0]], [0, f, OUT_H / 2 - 0.5 - f * cn[1]], [0, 0, 1]])
        xL, yL = source_coords(mL, Rn, K, sL)
        xR, yR = source_coords(mR, Rn, K, sR)
        okL = inside(xL, yL, imgL.shape[1], imgL.shape[0])
        okR = inside(xR, yR, imgR.shape[1], imgR.shape[0])
        if (okL.all() and okR.all()) or zoom > 2:
            break
        zoom += 0.005
    rectL = bilinear(imgL, xL, yL)
    rectR = bilinear(imgR, xR, yR)
    return {"K": K, "Rn": Rn, "zoom": zoom, "rgbL": rectL, "rgbR": rectR, "valid": float((okL & okR).mean()),
            "mL": mL, "mR": mR}


def corners(g: np.ndarray, nx: int, ny: int, border: int) -> list[tuple[int, int]]:
    """Strongest Shi-Tomasi corner in each cell of an nx x ny grid."""
    gy, gx = np.gradient(g)
    def box(a, r=3):
        c = np.cumsum(np.cumsum(np.pad(a, ((r + 1, r), (r + 1, r))), 0), 1)
        return c[2 * r + 1:, 2 * r + 1:] - c[:-2 * r - 1, 2 * r + 1:] - c[2 * r + 1:, :-2 * r - 1] + c[:-2 * r - 1, :-2 * r - 1]
    sxx, syy, sxy = box(gx * gx), box(gy * gy), box(gx * gy)
    score = (sxx + syy) / 2 - np.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2)  # smaller eigenvalue
    h, w = g.shape
    pts = []
    for j in range(ny):
        for i in range(nx):
            x0 = border + (w - 2 * border) * i // nx
            x1 = border + (w - 2 * border) * (i + 1) // nx
            y0 = border + (h - 2 * border) * j // ny
            y1 = border + (h - 2 * border) * (j + 1) // ny
            cell = score[y0:y1, x0:x1]
            k = int(np.argmax(cell))
            pts.append((x0 + k % cell.shape[1], y0 + k // cell.shape[1]))
    return pts


def match(gL: np.ndarray, gR: np.ndarray, u: int, v: int, max_disp: int) -> dict:
    """Find the left patch at (u, v) in the right image: rows v +- SEARCH_ROWS, columns u - max_disp .. u + 5."""
    p = PATCH
    t = gL[v - p:v + p + 1, u - p:u + p + 1]
    t = (t - t.mean()) / (t.std() + 1e-9)
    best = None
    scores = {}
    for dy in range(-SEARCH_ROWS, SEARCH_ROWS + 1):
        vv = v + dy
        if vv - p < 0 or vv + p >= gR.shape[0]:
            continue
        strip = gR[vv - p:vv + p + 1]
        win = np.lib.stride_tricks.sliding_window_view(strip, (2 * p + 1, 2 * p + 1))[0]  # (cols, 21, 21)
        lo = max(p, u - max_disp)
        hi = min(gR.shape[1] - p - 1, u + 5)
        w = win[lo - p:hi - p + 1]
        wn = (w - w.mean(axis=(1, 2), keepdims=True)) / (w.std(axis=(1, 2), keepdims=True) + 1e-9)
        ncc = (wn * t).mean(axis=(1, 2))
        for k, s in enumerate(ncc):
            scores[(dy, lo + k)] = s
            if best is None or s > best[0]:
                best = (s, dy, lo + k)
    s, dy, ur = best

    def sub(a, b, c):  # parabola vertex offset
        den = a - 2 * b + c
        return 0.0 if abs(den) < 1e-12 else 0.5 * (a - c) / den
    fy = sub(scores.get((dy - 1, ur), s), s, scores.get((dy + 1, ur), s)) if abs(dy) < SEARCH_ROWS else 0.0
    fx = sub(scores.get((dy, ur - 1), s), s, scores.get((dy, ur + 1), s))
    # second-best peak away from the best one: a repeated pattern makes the match ambiguous
    others = [v2 for (dy2, u2), v2 in scores.items() if abs(u2 - ur) > 3 or abs(dy2 - dy) > 3]
    return {"u": u, "v": v, "ncc": float(s), "dy": float(dy + fy), "disparity": float(u - (ur + fx)),
            "second": float(max(others)) if others else -1.0}


def ground_range_along_axis(res: dict, u: float, v: float) -> float:
    """Depth (along the rectified optical axis) where this left pixel's ray meets the plane under the
    wheels. Rough (the ground is not flat), only a plausibility check for the stereo depth."""
    K, Rn, mL = res["K"], res["Rn"], res["mL"]
    d = Rn.T @ np.linalg.solve(K, np.array([u, v, 1.0]))
    if d[2] <= 0:
        return float("nan")
    t = -mL["C"][2] / d[2]
    return float(t * (Rn[2] @ d))


def pose_of(res: dict, attitude: np.ndarray) -> dict:
    """Heading/pitch/roll of the rectified left camera, height above the rover origin (site frame)."""
    R = quat_to_matrix(*attitude)
    fwd = R @ res["Rn"][2]
    right = R @ res["Rn"][0]
    heading = float(np.degrees(np.arctan2(fwd[1], fwd[0])) % 360)
    pitch = float(-np.degrees(np.arcsin(fwd[2])))
    roll = float(np.degrees(np.arcsin(right[2])))  # positive: the right side of the image is lower
    height = float(-(R @ res["mL"]["C"])[2])
    return {"headingDeg": round(heading, 2), "pitchDeg": round(pitch, 2), "rollDeg": round(roll, 2),
            "heightAboveRoverOriginM": round(height, 3)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sol", type=int, default=1210)
    ap.add_argument("--tag", default="N0560000", help="site/drive part of the image id (Cheyava Falls: site 56, drive 0)")
    ap.add_argument("--pick", default=PREFERRED, help="left image id to use (empty: the best-ranked one)")
    ap.add_argument("--model", choices=["cahvore", "cahv"], default="cahvore",
                    help="cahv = ignore O, R, E and the lens type (for comparison; fails the row check)")
    ap.add_argument("--dry-run", action="store_true", help="run the check, write nothing")
    args = ap.parse_args()
    global MODEL
    MODEL = args.model

    images = load_feed(args.sol)
    pairs = candidates(images, args.tag)
    if not pairs:
        raise SystemExit(f"sol {args.sol}: no Navcam stereo quadrant pair for {args.tag} with mastEl in {MAST_EL_RANGE}")
    print(f"sol {args.sol}: {len(pairs)} candidate pairs (ground share = rays hitting ground 1.5-20 m, off the rover)")
    for p in pairs:
        print(f"  {p['left']['imageid']}  mastAz {float(p['left']['extended']['mastAz']):7.1f}  mastEl {p['mastEl']:6.1f}  ground {p['ground']:.2f}")
    pair = next((p for p in pairs if p["left"]["imageid"] == args.pick), None) if args.pick else pairs[0]
    if pair is None:
        raise SystemExit(f"--pick {args.pick} is not a candidate")
    left, right = pair["left"], pair["right"]
    print(f"using {left['imageid']} / {right['imageid']}")

    imgL, imgR = load_image(left), load_image(right)
    res = rectify(left, right, imgL, imgR)
    K = res["K"]
    baseline = float(np.linalg.norm(res["mR"]["C"] - res["mL"]["C"]))
    gL, gR = gray(res["rgbL"]), gray(res["rgbR"])
    print(f"rectified {OUT_W}x{OUT_H}: f {K[0, 0]:.2f} px (zoom {res['zoom']:.3f}), c ({K[0, 2]:.2f}, {K[1, 2]:.2f}), "
          f"baseline {baseline:.4f} m, valid in both {res['valid'] * 100:.1f}%")

    # --- check: rows line up, disparity and depth ---
    attitude = vec(left["attitude"])
    max_disp = 220
    picked = [match(gL, gR, u, v, max_disp) for u, v in corners(gL, 5, 4, 40)]
    dense = [match(gL, gR, u, v, max_disp) for u, v in corners(gL, 10, 7, 30)]
    for m in picked + dense:
        m["depthM"] = K[0, 0] * baseline / m["disparity"] if m["disparity"] > 0 else float("inf")
        m["groundPlaneDepthM"] = ground_range_along_axis(res, m["u"], m["v"])
    ok = [m for m in picked if m["ncc"] >= MIN_NCC]
    ok_dense = [m for m in dense if m["ncc"] >= MIN_NCC and m["ncc"] - m["second"] > 0.05]
    print("\n   u    v    NCC   2nd     dy      d      Z(m)  Z flat ground(m)")
    for m in picked:
        flag = "" if m["ncc"] >= MIN_NCC else "  (low NCC, not counted)"
        print(f"{m['u']:4d} {m['v']:4d}  {m['ncc']:.3f} {m['second']:.3f} {m['dy']:+.2f} {m['disparity']:7.2f} {m['depthM']:7.2f}  {m['groundPlaneDepthM']:6.2f}{flag}")
    if len(ok) < 10:
        raise SystemExit(f"only {len(ok)} of {len(picked)} points matched with NCC >= {MIN_NCC}: check failed")
    print(f"(model: {MODEL})")
    dys = np.array([m["dy"] for m in ok])
    disp = np.array([m["disparity"] for m in ok_dense])
    depth = K[0, 0] * baseline / disp
    check = {
        "points": len(ok),
        "meanAbsDyPx": round(float(np.abs(dys).mean()), 3),
        "maxAbsDyPx": round(float(np.abs(dys).max()), 3),
        "meanDyPx": round(float(dys.mean()), 3),
        "densePoints": len(ok_dense),
        "denseMeanAbsDyPx": round(float(np.abs([m["dy"] for m in ok_dense]).mean()), 3),
        "disparityPx": [round(float(disp.min()), 1), round(float(np.percentile(disp, 50)), 1), round(float(disp.max()), 1)],
        "depthM": [round(float(depth.min()), 2), round(float(np.percentile(depth, 50)), 2), round(float(depth.max()), 2)],
        "matches": [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in m.items()} for m in picked],
    }
    print(f"\nrow offset over {len(ok)} points: mean |dy| {check['meanAbsDyPx']} px, max {check['maxAbsDyPx']} px, mean dy {check['meanDyPx']} px")
    print(f"{len(ok_dense)} dense points: mean |dy| {check['denseMeanAbsDyPx']} px; disparity min/median/max {check['disparityPx']} px; "
          f"depth {check['depthM']} m")
    if check["meanAbsDyPx"] > 1.0:
        raise SystemExit("rectification check failed: mean |dy| > 1 px; nothing written")
    if args.dry_run:
        return

    # --- write ---
    OUT.mkdir(parents=True, exist_ok=True)
    as8 = lambda a: np.clip(np.round(a), 0, 255).astype(np.uint8)
    Image.fromarray(as8(gL), "L").save(OUT / "left.png", optimize=True)
    Image.fromarray(as8(gR), "L").save(OUT / "right.png", optimize=True)
    Image.fromarray(as8(res["rgbL"]), "RGB").save(OUT / "left_rgb.png", optimize=True)
    feed_url = FEED.format(sol=args.sol)
    calib = {
        "width": OUT_W, "height": OUT_H,
        "fx": round(float(K[0, 0]), 3), "fy": round(float(K[1, 1]), 3),
        "cx": round(float(K[0, 2]), 3), "cy": round(float(K[1, 2]), 3),
        "baselineM": round(baseline, 4),
        "files": {"left": "left.png", "right": "right.png", "rgbLeft": "left_rgb.png"},
        "pose": {
            "note": "Rectified left camera in the site frame (north/east/down) from the rover attitude quaternion. "
                    "Height is above the rover frame origin, which is close to the ground under the wheels.",
            **pose_of(res, attitude),
        },
        "source": {
            "sol": args.sol,
            "site": left.get("site"), "drive": left.get("drive"),
            "place": "Cheyava Falls, Bright Angel area, Neretva Vallis, Jezero crater",
            "left": {"imageId": left["imageid"], "image": left["image_files"]["large"], "page": left["link"],
                     "cameraModel": left["camera"]["camera_model_component_list"]},
            "right": {"imageId": right["imageid"], "image": right["image_files"]["large"], "page": right["link"],
                      "cameraModel": right["camera"]["camera_model_component_list"]},
            "takenUtc": left["date_taken_utc"], "takenMars": left["date_taken_mars"],
            "mastAzDeg": float(left["extended"]["mastAz"]), "mastElDeg": float(left["extended"]["mastEl"]),
            "feed": feed_url,
            "credit": "NASA/JPL-Caltech",
        },
        "method": f"CAHV 3x4 projection matrices with the CAHVORE fisheye + radial (O, R) terms, E ignored (model: {MODEL}) "
                  "-> Fusiello rectification (common rotation from the baseline, same intrinsics) -> bilinear resampling. "
                  "scripts/build_real_stereo.py; see README.md",
        "check": check,
    }
    (OUT / "calib.json").write_text(json.dumps(calib, indent=2) + "\n")

    # side-by-side with guide rows and a red/cyan anaglyph, for looking at (not shipped)
    sbs = Image.new("RGB", (OUT_W * 2 + 8, OUT_H))
    sbs.paste(Image.fromarray(as8(gL)).convert("RGB"), (0, 0))
    sbs.paste(Image.fromarray(as8(gR)).convert("RGB"), (OUT_W + 8, 0))
    arr = np.asarray(sbs).copy()
    for r in range(24, OUT_H, 48):
        arr[r, :, :] = (255, 60, 60)
    for m in picked:
        for (x, y) in ((m["u"], m["v"]), (round(m["u"] - m["disparity"]) + OUT_W + 8, round(m["v"] + m["dy"]))):
            arr[max(0, y - 3):y + 4, max(0, x - 3):x + 4] = (60, 255, 60)
    Image.fromarray(arr).save(RAW / "side_by_side.png")
    ana = np.stack([as8(gL), as8(gR), as8(gR)], axis=-1)
    Image.fromarray(ana).save(RAW / "anaglyph.png")
    print(f"\nwrote {OUT}/left.png, right.png, left_rgb.png, calib.json; previews in {RAW}")


if __name__ == "__main__":
    main()
