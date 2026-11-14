#!/usr/bin/env python3
"""Caches Perseverance's MEDA weather readings for the helmet's suit panel and warnings.

Reads NASA's public Mars 2020 weather feed (the one behind mars.nasa.gov/mars2020/weather), keeps the
sols that have numeric minimum and maximum air temperature AND pressure, and writes
public/data/helmet/weather.json:

  { fetched, source, units, sols: [{sol, terrestrial_date, min_temp, max_temp, pressure, sunrise, sunset,
    season, ls}], latest }

`latest` is the most recent kept sol. Sols where the feed has "--" for any of the three are dropped
(the feed reports gaps that way). The feed only lists the last few sols it published.

Run: scripts/.venv/bin/python scripts/fetch_weather.py
"""
import datetime
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "helmet" / "weather.json"
FEED = "https://mars.nasa.gov/rss/api/?feed=weather&category=mars2020&feedtype=json"


def curl(url: str) -> bytes:
    return subprocess.run(["curl", "-fsSL", "--max-time", "60", url], check=True, capture_output=True).stdout


def number(value):
    """The feed mixes numbers and strings ("--" for no data). Returns a float or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except ValueError:
        return None


def main() -> None:
    raw = json.loads(curl(FEED))
    feed_sols = raw.get("sols", [])
    sols = []
    for s in feed_sols:
        t_min, t_max, p = number(s.get("min_temp")), number(s.get("max_temp")), number(s.get("pressure"))
        sol = number(s.get("sol"))
        if t_min is None or t_max is None or p is None or sol is None:
            continue
        sols.append({
            "sol": int(sol),
            "terrestrial_date": s.get("terrestrial_date"),
            "min_temp": t_min,
            "max_temp": t_max,
            "pressure": p,
            "sunrise": s.get("sunrise"),
            "sunset": s.get("sunset"),
            "season": s.get("season"),
            "ls": number(s.get("ls")),
        })
    sols.sort(key=lambda s: s["sol"])
    if not sols:
        raise SystemExit(f"{len(feed_sols)} sols in the feed, none with temperature and pressure: nothing written")
    out = {
        "fetched": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": FEED,
        "credit": "NASA/JPL-Caltech/CAB(CSIC-INTA): Perseverance MEDA",
        "units": {
            "min_temp": "degC", "max_temp": "degC", "pressure": "Pa",
            "sunrise": "local Mars time hh:mm:ss, as given by the feed",
            "sunset": "local Mars time hh:mm:ss, as given by the feed",
            "ls": "deg (solar longitude)",
        },
        "sols": sols,
        "latest": sols[-1],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    last = sols[-1]
    print(f"{len(feed_sols)} sols in the feed, {len(sols)} kept (sols {sols[0]['sol']}-{last['sol']}) -> {OUT}")
    print(f"latest: sol {last['sol']} ({last['terrestrial_date']}), {last['min_temp']} to {last['max_temp']} C, "
          f"{last['pressure']} Pa, sunrise {last['sunrise']}, sunset {last['sunset']}, {last['season']}")


if __name__ == "__main__":
    main()
