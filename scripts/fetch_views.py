#!/usr/bin/env python3
"""Caches one ground-level photo for the habitat and every target in src/data/jezero.ts.

For each stop: find the nearest Perseverance waypoint (M20_waypoints.json), ask NASA's raw image
API for the camera frames taken while the rover stood there, keep the colour frame that best shows
the landscape (see frames_for), and save a 1000 px wide copy to public/data/views/<id>.jpg.
public/data/views/index.json records which image was used, so the app can caption and credit it.

Run: scripts/.venv/bin/python scripts/fetch_views.py
"""
import io
import json
import math
import re
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
API = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&num=100&page=0&search=%7C{camera}&sol={sol}"
OUT = ROOT / "public" / "data" / "views"

# Stops where the automatic pick shows the rover instead of the place: use this image id.
PINNED = {"cheyava-falls": "FLF_1219_0775164888_506ECM_N0560784FHAZ02418_01_295J"}


def curl(url):
    return subprocess.run(["curl", "-fsSL", "--max-time", "60", url], check=True, capture_output=True).stdout


def metres(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 3389500 * math.hypot(x, math.radians(lat2 - lat1))


def frames_for(sol):
    """(score, frame) for every full colour frame of this sol. Lower score is better.
    1. Navigation camera looking out near the horizon: the landscape the crew will see.
    2. Front hazard camera: always shows the ground ahead of the rover.
    3. Navigation camera looking steeply down, which usually shows the rover deck or its workspace."""
    frames = []
    for camera in ("NAVCAM_LEFT", "FRONT_HAZCAM_LEFT_A"):
        for im in json.loads(curl(API.format(camera=camera, sol=sol))).get("images", []):
            ext = im.get("extended") or {}
            dim = re.findall(r"\d+", ext.get("dimension") or "")
            image_id = im.get("imageid", "")
            if im.get("sample_type") != "Full" or len(dim) != 2 or int(dim[0]) < 1000:
                continue
            if image_id[:3] not in ("NLF", "FLF") or int(dim[1]) < 0.5 * int(dim[0]):
                continue  # greyscale or a narrow strip
            if camera != "NAVCAM_LEFT":
                frames.append((60, im))
                continue
            try:
                elevation = float(ext["mastEl"])
            except (KeyError, TypeError, ValueError):
                continue
            frames.append((abs(elevation + 5) if elevation > -35 else 80 - elevation, im))
    return frames


def main():
    site = (ROOT / "src" / "data" / "jezero.ts").read_text()
    stops = re.findall(r"id: '([\w-]+)',(?:(?!id: ').)*?lat: ([\d.]+),\s*lon: ([\d.]+)", site, flags=re.S)
    stops = [s for s in stops if s[0] != "jezero"]
    waypoints = sorted(
        (f["properties"] for f in json.loads((ROOT / "public" / "data" / "M20_waypoints.json").read_text())["features"]),
        key=lambda p: p["sol"],
    )
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for stop_id, lat, lon in stops:
        lat, lon = float(lat), float(lon)
        k = min(range(len(waypoints)), key=lambda i: metres(lat, lon, waypoints[i]["lat"], waypoints[i]["lon"]))
        wp = waypoints[k]
        # The rover stays at a waypoint until the sol of the next one.
        last = waypoints[k + 1]["sol"] if k + 1 < len(waypoints) else wp["sol"] + 1
        frames = []
        for sol in range(wp["sol"], min(max(last, wp["sol"] + 1), wp["sol"] + 8)):
            frames += frames_for(sol)
        pinned = [f for f in frames if f[1].get("imageid") == PINNED.get(stop_id)]
        frame = min(pinned or frames, key=lambda f: f[0])[1] if frames else None
        if not frame:
            print(f"{stop_id:18s} no navcam frame at sols {wp['sol']}..{last - 1}")
            continue
        files = frame["image_files"]
        img = Image.open(io.BytesIO(curl(files.get("large") or files["medium"]))).convert("RGB")
        img = img.resize((1000, round(img.height * 1000 / img.width)), Image.LANCZOS)
        img.save(OUT / f"{stop_id}.jpg", quality=82, optimize=True)
        index[stop_id] = {
            "file": f"/data/views/{stop_id}.jpg",
            "sol": frame["sol"],
            "camera": "Perseverance " + ("navigation camera" if frame["imageid"].startswith("N") else "front hazard camera"),
            "imageId": frame["imageid"],
            "distanceM": round(metres(lat, lon, wp["lat"], wp["lon"])),
            "credit": frame.get("credit") or "NASA/JPL-Caltech",
            "source": frame.get("link") or files.get("full_res"),
        }
        print(f"{stop_id:18s} sol {frame['sol']:4d}  {index[stop_id]['distanceM']:4d} m from stop  {frame['imageid']}")
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
