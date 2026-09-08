#!/usr/bin/env python3
"""Build a passage's chart from scratch: fetch the OpenStreetMap extracts, then build.

This is the two documented commands of docs/ADAPTING.md step 2 as one, so the chart service (server/) and a
person at a terminal run exactly the same pipeline:

    python3 tools/fetch_osm.py   <passage.json> <scratch>
    python3 tools/build_chart.py <scratch> <out>/chart-data.js <passage.json>

Usage:
    build_area.py <passage.json> <out-dir> [--scratch DIR] [--mirror URL] [--offline] [--timeout S]

Writes <out-dir>/chart-data.js and <out-dir>/passage.js. Exits non-zero with the reason on failure.
The OpenStreetMap data it fetches is ODbL: see docs/LICENSING.md before publishing a chart built with it.
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def build(passage_path, out_dir, scratch=None, mirrors=None, offline=False, timeout=120, log=print):
    """Fetch and build one passage. Returns a dict describing what was written."""
    fetch_osm = _load('fetch_osm', 'tools/fetch_osm.py')
    build_chart = _load('build_chart', 'tools/build_chart.py')
    validate_passage = _load('validate_passage', 'tools/validate_passage.py')

    reports = validate_passage.validate_files(passage_path)
    for rep in reports:
        for line in rep.lines():
            log(line)
    if any(rep.errors for rep in reports):
        raise SystemExit('passage data is invalid; nothing built')

    tmp = scratch or tempfile.mkdtemp(prefix='saily-area-')
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    argv = [passage_path, tmp, '--timeout', str(timeout)]
    for m in (mirrors or []):
        argv += ['--mirror', m]
    if offline:
        argv.append('--offline')
    t0 = time.time()
    log(f'fetch_osm {" ".join(argv[1:])}')
    rc = fetch_osm.main(argv)
    if rc:
        raise SystemExit(f'fetch_osm failed with status {rc}')
    fetched = time.time() - t0

    out_chart = os.path.join(out_dir, 'chart-data.js')
    log(f'build_chart -> {out_chart}')
    rc = build_chart.main([tmp, out_chart, passage_path])
    if rc:
        raise SystemExit(f'build_chart failed with status {rc}')

    out_passage = os.path.join(out_dir, 'passage.js')
    result = {
        'chart': out_chart, 'passage': out_passage,
        'chartBytes': os.path.getsize(out_chart),
        'passageBytes': os.path.getsize(out_passage) if os.path.exists(out_passage) else 0,
        'fetchSeconds': round(fetched, 1),
        'totalSeconds': round(time.time() - t0, 1),
    }
    coast = os.path.join(tmp, 'coast.json')
    if os.path.exists(coast):
        with open(coast, encoding='utf-8') as f:
            result['osmDate'] = (json.load(f).get('osm3s') or {}).get('timestamp_osm_base', 'unknown')
    if scratch is None:
        shutil.rmtree(tmp, ignore_errors=True)
    log(f'built {result["chartBytes"]} bytes of chart in {result["totalSeconds"]} s (OSM data {result.get("osmDate", "?")})')
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('passage')
    ap.add_argument('out')
    ap.add_argument('--scratch', help='keep the Overpass extracts here instead of a temporary directory')
    ap.add_argument('--mirror', action='append', metavar='URL', help='Overpass endpoint (repeatable)')
    ap.add_argument('--offline', action='store_true', help='re-polygonise an existing scratch coast.json')
    ap.add_argument('--timeout', type=float, default=120)
    a = ap.parse_args(argv)
    try:
        res = build(a.passage, a.out, a.scratch, a.mirror, a.offline, a.timeout)
    except SystemExit as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 1
    print(json.dumps(res, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
