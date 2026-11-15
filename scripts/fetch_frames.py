#!/usr/bin/env python3
"""Caches Navcam landscape frames from every Perseverance stop on the terrain grid, with each frame's camera model.

The app uses them to show any point of a route from the ground: it picks a frame that looks at the point and
draws markers for the point and other places on top of the unchanged photo (src/lib/photoProjection.ts).

For each waypoint inside the terrain grid (M20_waypoints.json):
1. Frames = NAVCAM_LEFT colour frames taken at the waypoint's own site/drive (the "RMC" localisation, so the
   rover position is exact), looking out near the horizon (mast elevation -12..+6 deg).
2. Up to MAX_PER_STOP of them, spread over the compass (one per HEADING_BIN of camera heading), full field of
   view before quadrant tiles.
3. Each is saved 640 px wide to public/data/frames/<image id>.jpg. public/data/frames/index.json holds per frame
   the rover position (waypoint lat/lon/elevation), the rover attitude quaternion (rover -> site frame,
   site = north/east/down, scalar first) and the CAHVORE camera model in the frame's own pixels.

Checked 2026-11-15: the attitude's yaw equals the waypoint yaw, the waypoint elevation (elev_geoid) equals the
DTM grid within 0.5 m, and the DTM skyline projected through the model lies on the skyline in the photo.

Source: https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json  Images: NASA/JPL-Caltech.
Run: scripts/.venv/bin/python scripts/fetch_frames.py [--limit N]
"""
import argparse
import io
import json
import math
import subprocess
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "frames"
FEEDS = ROOT / "scripts" / "raw" / "feeds"
FEED = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&num=1000&page=0&search=%7CNAVCAM_LEFT&sol={sol}"
WIDTH = 640
MAX_PER_STOP = 6
HEADING_BIN = 60
EL_RANGE = (-12.0, 6.0)  # steeper down, the rover deck fills the bottom of the picture
FULL_FOV = "(1,1,5120,3840)"
# mars.nasa.gov answers 403 for a few minutes after a burst of about 40 requests: pace them, and wait out a 403.
PAUSE_S = 2.0
BLOCKED_WAIT_S = 150
BLOCKED_TRIES = 6


def curl(url: str) -> bytes:
    for attempt in range(BLOCKED_TRIES):
        time.sleep(PAUSE_S)
        r = subprocess.run(["curl", "-sSL", "--max-time", "120", "-w", "\n%{http_code}", url], capture_output=True)
        body, _, code = r.stdout.rpartition(b"\n")
        if code == b"200":
            return body
        print(f"  HTTP {code.decode() or r.returncode} for {url[:90]}..., waiting {BLOCKED_WAIT_S} s", flush=True)
        time.sleep(BLOCKED_WAIT_S)
    raise RuntimeError(f"gave up on {url}")


def feed(sol: int) -> list[dict]:
    """Every NAVCAM_LEFT image of a sol (one request: num=1000 covers the busiest sols), cached in scripts/raw/feeds.
    Caches written by the earlier paged version hold at most 1000 images, which is the same."""
    FEEDS.mkdir(parents=True, exist_ok=True)
    cache = FEEDS / f"ncam_left_{sol}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    images = json.loads(curl(FEED.format(sol=sol))).get("images", [])
    cache.write_text(json.dumps(images))
    return images


def vec(s: str) -> list[float]:
    return [float(v) for v in s.strip("()").split(",")]


def rotate(q: list[float], v: list[float]) -> list[float]:
    """Rotates v by the unit quaternion q = (w, x, y, z)."""
    w, x, y, z = q
    m = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]
    return [sum(m[i][j] * v[j] for j in range(3)) for i in range(3)]


def camera(im: dict) -> dict | None:
    parts = (im.get("camera") or {}).get("camera_model_component_list", "").split(";")
    if im.get("camera", {}).get("camera_model_type") != "CAHVORE" or len(parts) < 8:
        return None
    C, A, H, V, O, R = (vec(p) for p in parts[:6])
    kind = float(parts[7])
    linearity = {1.0: 1.0, 2.0: 0.0}.get(kind, float(parts[8]) if len(parts) > 8 else 1.0)
    return {"C": C, "A": A, "H": H, "V": V, "O": O, "R": R, "linearity": linearity}


def candidates(wp: dict, sols: range) -> list[dict]:
    out = []
    for sol in sols:
        for im in feed(sol):
            ext = im.get("extended") or {}
            if im.get("site") != wp["site"] or str(im.get("drive")) != str(wp["drive"]):
                continue
            if im.get("sample_type") != "Full" or not im.get("imageid", "").startswith("NLF"):
                continue
            try:
                el = float(ext["mastEl"])
                w, h = (int(v) for v in ext["dimension"].strip("()").split(","))
            except (KeyError, ValueError):
                continue
            cam = camera(im)
            if not cam or not (EL_RANGE[0] <= el <= EL_RANGE[1]) or w < 1000 or h < 0.6 * w:  # no narrow strips
                continue
            q = vec(im["attitude"])
            a = rotate(q, cam["A"])
            out.append({
                "im": im, "cam": cam, "q": q, "w": w, "h": h, "el": el,
                "heading": math.degrees(math.atan2(a[1], a[0])) % 360,
                "full": ext.get("subframeRect") == FULL_FOV,
            })
    return out


def pick(frames: list[dict]) -> list[dict]:
    """One frame per heading bin: full field of view first, then the one looking closest to the horizon."""
    best: dict[int, dict] = {}
    for f in frames:
        b = int(f["heading"] // HEADING_BIN)
        key = (not f["full"], abs(f["el"] + 4))
        if b not in best or key < best[b]["key"]:
            best[b] = {**f, "key": key}
    return sorted(best.values(), key=lambda f: f["key"])[:MAX_PER_STOP]


def save(f: dict) -> None:
    path = OUT / f"{f['im']['imageid']}.jpg"
    if path.exists():
        return
    files = f["im"]["image_files"]
    img = Image.open(io.BytesIO(curl(files.get("large") or files["medium"]))).convert("RGB")
    img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
    img.save(path, quality=78, optimize=True)


def r6(v):
    return [round(x, 6) for x in v] if isinstance(v, list) else round(v, 6)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only the first N waypoints (for a test run)")
    args = ap.parse_args()
    meta = json.loads((ROOT / "public" / "data" / "jezero_terrain.json").read_text())
    wps = sorted(
        (f["properties"] for f in json.loads((ROOT / "public" / "data" / "M20_waypoints.json").read_text())["features"]),
        key=lambda p: p["sol"],
    )
    inside = [
        (k, wp) for k, wp in enumerate(wps)
        if meta["west"] <= wp["lon"] <= meta["east"] and meta["south"] <= wp["lat"] <= meta["north"]
    ]
    if args.limit:
        inside = inside[: args.limit]
    OUT.mkdir(parents=True, exist_ok=True)

    def one(item):
        k, wp = item
        last = wps[k + 1]["sol"] if k + 1 < len(wps) else wp["sol"] + 1
        return wp, pick(candidates(wp, range(wp["sol"], min(max(last, wp["sol"] + 1), wp["sol"] + 8))))

    results = []
    for n, item in enumerate(inside, 1):
        results.append(one(item))
        if n % 25 == 0:
            print(f"{n}/{len(inside)} waypoints, {sum(len(fs) for _, fs in results)} frames so far", flush=True)
    chosen = [(wp, f) for wp, fs in results for f in fs]
    for n, (_, f) in enumerate(chosen, 1):
        save(f)
        if n % 10 == 0:
            print(f"{n}/{len(chosen)} images saved", flush=True)

    frames = []
    for wp, f in chosen:
        im, cam = f["im"], f["cam"]
        frames.append({
            "id": im["imageid"],
            "file": f"/data/frames/{im['imageid']}.jpg",
            "sol": im["sol"],
            "rover": {"lat": wp["lat"], "lon": wp["lon"], "elev": round(wp["elev_geoid"], 2)},
            "attitude": r6(f["q"]),
            "headingDeg": round(f["heading"], 1),
            "elevationDeg": round(f["el"], 1),
            "width": f["w"],
            "height": f["h"],
            "model": {k: r6(v) for k, v in cam.items()},
            "source": im.get("link"),
        })
    (OUT / "index.json").write_text(json.dumps({
        "credit": "NASA/JPL-Caltech",
        "camera": "Perseverance navigation camera (Navcam, left)",
        "note": "Camera model CAHVORE in the frame's own pixels (width x height), rover frame x forward, y right, z down. "
                "attitude rotates rover frame -> site frame (north, east, down), scalar first. rover.elev is the waypoint's elev_geoid, "
                "the same datum as jezero_elev.bin.",
        "frames": frames,
    }, separators=(",", ":")) + "\n")
    size = sum(p.stat().st_size for p in OUT.glob("*.jpg"))
    print(f"{len(inside)} waypoints, {sum(1 for _, fs in results if fs)} with frames, {len(frames)} frames, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
