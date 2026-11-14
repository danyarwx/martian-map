"""Builds a typical Jezero sol from real Perseverance MEDA measurements.

Downloads air temperature (calibrated ATS), wind (derived WS) and pressure (derived PS) for a run of
consecutive sols from NASA's PDS Atmospheres node, and writes the median of each half hour of local mean
solar time to src/data/medaSol.ts. One sol has gaps (MEDA does not measure all day), so several sols are
combined: what one sol misses, the others fill.

    python scripts/fetch_meda.py            # sols 120-129
    python scripts/fetch_meda.py 300 309    # another season

Only the Python standard library is used. The CSV files are streamed, not stored (about 15 MB per sol).
"""
import csv
import io
import statistics
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://pds-atmospheres.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda'
# Collections are split into folders of sols; these are the folder ranges as published.
FOLDERS = [(0, 89), (90, 179), (180, 299), (300, 419), (420, 539), (540, 659), (660, 779), (780, 899),
           (900, 1019), (1020, 1139), (1140, 1259)]
FILES = {
    'temp': ('data_calibrated_env', 'CAL_ATS_________________P02'),
    'wind': ('data_derived_env', 'DER_WS__________________P02'),
    'pressure': ('data_derived_env', 'DER_PS__________________P01'),
}
FILL = 1e8  # MEDA writes 999999999 for "no value"
BIN_MIN = 30
OUT = Path(__file__).resolve().parent.parent / 'src' / 'data' / 'medaSol.ts'
# A half hour counts as gusty when 5% of its wind samples are at least this fast, m/s.
GUST_MS = 8


def folder(sol: int) -> str:
    for lo, hi in FOLDERS:
        if lo <= sol <= hi:
            return f'sol_{lo:04d}_{hi:04d}'
    raise SystemExit(f'sol {sol} is outside the folders this script knows')


def url(kind: str, sol: int) -> str:
    collection, product = FILES[kind]
    return f'{BASE}/{collection}/{folder(sol)}/sol_{sol:04d}/WE__{sol:04d}___________{product}.CSV'


def rows(u: str):
    """Yields each CSV row as a dict, streamed from the server."""
    req = urllib.request.Request(u, headers={'User-Agent': 'martian-map-data-prep'})
    with urllib.request.urlopen(req, timeout=120) as res:
        yield from csv.DictReader(io.TextIOWrapper(res, encoding='utf-8', newline=''))


def lmst_minute(s: str) -> float:
    """'00120M14:03:21.5' -> minutes after midnight."""
    clock = s.split('M', 1)[1]
    h, m, sec = clock.split(':')
    return int(h) * 60 + int(m) + float(sec) / 60


def value(s: str) -> float | None:
    try:
        v = float(s)
    except ValueError:
        return None
    return None if abs(v) >= FILL else v


def main():
    first, last = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) == 3 else (120, 129)
    bins = {k: [[] for _ in range(24 * 60 // BIN_MIN)] for k in FILES}
    used = []
    per_kind = {k: [] for k in FILES}
    for sol in range(first, last + 1):
        got = False
        for kind in FILES:
            try:
                n = 0
                for r in rows(url(kind, sol)):
                    b = int(lmst_minute(r['LMST']) // BIN_MIN) % len(bins[kind])
                    if kind == 'temp':
                        # The three sensors on the mast (about 1.45 m up); the two on the rover body run warm.
                        vals = [v for v in (value(r[f'ATS_LOCAL_TEMP{i}']) for i in (1, 2, 3)) if v is not None]
                        v = statistics.median(vals) - 273.15 if vals else None
                    elif kind == 'wind':
                        v = value(r['HORIZONTAL_WIND_SPEED'])
                    else:
                        v = value(r['PRESSURE'])
                    if v is not None:
                        bins[kind][b].append(v)
                        n += 1
                got = got or n > 0
                if n:
                    per_kind[kind].append(sol)
                print(f'sol {sol} {kind}: {n} values', flush=True)
            except urllib.error.HTTPError as e:
                print(f'sol {sol} {kind}: {e.code}, skipped', flush=True)
        if got:
            used.append(sol)

    def pct(xs, p):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(p * len(xs)))]

    out = []
    for i in range(len(bins['temp'])):
        t, w, p = bins['temp'][i], bins['wind'][i], bins['pressure'][i]
        out.append({
            'lmst': i * BIN_MIN,
            'airC': round(statistics.median(t), 1) if t else None,
            'windMs': round(statistics.median(w), 1) if w else None,
            'gustMs': round(pct(w, 0.95), 1) if w else None,
            'pressurePa': round(statistics.median(p)) if p else None,
        })

    # Missing half hours (no sol measured them) are filled from their neighbours, so every hour has a value.
    for key in ('airC', 'windMs', 'gustMs', 'pressurePa'):
        known = [i for i, b in enumerate(out) if b[key] is not None]
        if not known:
            raise SystemExit(f'no {key} data at all')
        for i, b in enumerate(out):
            if b[key] is None:
                prev = max((k for k in known if k < i), default=known[-1])
                nxt = min((k for k in known if k > i), default=known[0])
                span = (nxt - prev) % len(out) or len(out)
                share = ((i - prev) % len(out)) / span
                v = out[prev][key] + (out[nxt][key] - out[prev][key]) * share
                b[key] = round(v, 1) if key != 'pressurePa' else round(v)
                b['filled'] = True

    lines = [
        '// GENERATED by scripts/fetch_meda.py — do not edit by hand.',
        f'// A typical sol at Jezero: medians of Perseverance MEDA measurements on sols {used[0]}-{used[-1]}',
        f'// per {BIN_MIN} min of local mean solar time. Sols with data: ' + '; '.join(f'{k} {v}' for k, v in per_kind.items()) + '.',
        '// Air temperature: the three mast ATS sensors'
        "// (calibrated). Wind and pressure: MEDA derived data. Gust = 95th percentile of wind in the half hour.",
        '// Source: NASA PDS Atmospheres node, Mars 2020 MEDA bundle,',
        f'// {BASE}/',
        "// Half hours no sol measured are interpolated and marked `filled`.",
        '',
        'export interface MedaBin {',
        '  /** Start of the half hour, LMST minutes after midnight. */',
        '  lmst: number',
        '  airC: number',
        '  windMs: number',
        '  gustMs: number',
        '  pressurePa: number',
        '  filled?: boolean',
        '}',
        '',
        f'export const MEDA_SOLS = [{used[0]}, {used[-1]}] as const',
        f'export const MEDA_BIN_MIN = {BIN_MIN}',
        f'/** A half hour is gusty when its gust value is at least this, m/s. */',
        f'export const MEDA_GUST_MS = {GUST_MS}',
        '',
        'export const MEDA_SOL: MedaBin[] = [',
    ]
    for b in out:
        filled = ', filled: true' if b.get('filled') else ''
        lines.append(f"  {{ lmst: {b['lmst']}, airC: {b['airC']}, windMs: {b['windMs']}, gustMs: {b['gustMs']}, pressurePa: {b['pressurePa']}{filled} }},")
    lines.append(']')
    OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'wrote {OUT} from sols {used}')
    for b in out:
        print(f"{b['lmst'] // 60:02d}:{b['lmst'] % 60:02d}  {b['airC']:6.1f} C  wind {b['windMs']:4.1f}  gust {b['gustMs']:4.1f}  {b['pressurePa']} Pa{'  (filled)' if b.get('filled') else ''}")


if __name__ == '__main__':
    main()
