#!/usr/bin/env python3
"""Fetch the OpenStreetMap inputs for a passage from Overpass and polygonise land.

Usage:
    fetch_osm.py <passage.json> <scratch_dir> [--mirror URL ...] [--offline]
                 [--timeout S] [--retries N] [--backoff S]

Reads the passage bbox (south, west, north, east) and places from <passage.json> and writes into <scratch_dir>:

    coast.json        Overpass JSON ('out geom') of natural=coastline ways in the bbox
    harbours.json     Overpass JSON of seamarks (seamark:type) and harbour structures (man_made)
    land_osm.json     GeoJSON of land in the bbox: coastline ways merged, clipped to the bbox, polygonised together
                      with the bbox boundary, faces classified with the OSM left-hand rule (land is on the left of
                      a coastline way), simplified 0.00015 deg, coordinates rounded to 5 decimals
    land_<key>.json   GeoJSON of land within +-0.025 deg of each entry of passage.places (or the place's own
                      "detailBox": [south, west, north, east]), simplified 0.00003 deg, 5 decimals

The two JSON files from Overpass are stored exactly as received, so tools/build_chart.py reads them unchanged.
--offline skips Overpass and only re-polygonises from an existing coast.json.

Data: (c) OpenStreetMap contributors, ODbL 1.0 (see NOTICE and docs/LICENSING.md).
"""
import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from shapely.geometry import LineString, MultiPolygon, box, mapping
    from shapely.geometry.polygon import orient
    from shapely.ops import linemerge, polygonize, unary_union
except ImportError:  # pragma: no cover
    sys.exit('fetch_osm.py needs shapely: pip install -r tools/requirements.txt')

DEFAULT_MIRRORS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
]
USER_AGENT = 'Saily-fetch_osm/1.0 (+https://github.com/SDDoSx/Saily)'

SEAMARK_TYPES = ['harbour', 'light_major', 'light_minor', 'beacon_.*', 'buoy_.*', 'landmark', 'wreck', 'rock',
                 'obstruction', 'anchorage', 'restricted_area', 'separation_lane', 'separation_zone',
                 'separation_boundary', 'inshore_traffic_zone', 'precautionary_area']
MAN_MADE = ['breakwater', 'pier', 'groyne']

LAND_SIMPLIFY = 0.00015   # deg, whole bbox
DETAIL_SIMPLIFY = 0.00003  # deg, harbour detail
DETAIL_HALF = 0.025        # deg, half-size of the harbour detail box
ROUND = 5


class FetchError(Exception):
    pass


# --- Overpass -------------------------------------------------------------------------------------
def bbox_str(bbox):
    s, w, n, e = bbox
    return f'{s},{w},{n},{e}'


def coast_query(bbox, timeout):
    return f'[out:json][timeout:{timeout}];\nway["natural"="coastline"]({bbox_str(bbox)});\nout geom;'


def harbours_query(bbox, timeout):
    b = bbox_str(bbox)
    sm = '^(' + '|'.join(SEAMARK_TYPES) + ')$'
    mm = '^(' + '|'.join(MAN_MADE) + ')$'
    return (f'[out:json][timeout:{timeout}];\n(\n'
            f'  node["seamark:type"~"{sm}"]({b});\n'
            f'  way["seamark:type"~"{sm}"]({b});\n'
            f'  node["man_made"~"{mm}"]({b});\n'
            f'  way["man_made"~"{mm}"]({b});\n'
            f');\nout geom;')


def overpass_get(mirror, query, timeout):
    """One GET request; returns the raw body (bytes) of a JSON response or raises FetchError."""
    url = mirror + '?' + urllib.parse.urlencode({'data': query})
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read(2000).decode('utf-8', 'replace')
        except Exception:
            pass
        if e.code == 400:
            raise FetchError(f'{mirror}: HTTP 400 bad query (fix the query, no retry): {detail.strip()[:300]}')
        raise FetchError(f'{mirror}: HTTP {e.code} {e.reason}' + (' (rate limited, retry later)' if e.code == 429 else ''))
    except urllib.error.URLError as e:
        raise FetchError(f'{mirror}: {e.reason}')
    except (TimeoutError, OSError, http.client.HTTPException) as e:
        # HTTPException covers IncompleteRead and friends: a mirror that cuts the transfer mid-body.
        raise FetchError(f'{mirror}: {type(e).__name__}: {e}')
    try:
        data = json.loads(body.decode('utf-8'))
    except ValueError:
        head = body[:200].decode('utf-8', 'replace').replace('\n', ' ')
        raise FetchError(f'{mirror}: response is not JSON (busy mirror or HTML error page): {head}')
    if not isinstance(data, dict) or 'elements' not in data:
        raise FetchError(f'{mirror}: unexpected JSON shape (no "elements")')
    remark = data.get('remark')
    if remark and ('error' in remark.lower() or 'timed out' in remark.lower()):
        raise FetchError(f'{mirror}: Overpass remark: {remark}')
    return body


def fetch(query, mirrors, timeout, retries, backoff, label):
    """GET the query from the first mirror that answers; retry rounds with exponential backoff."""
    failures = []
    for attempt in range(retries):
        for mirror in mirrors:
            t0 = time.time()
            try:
                body = overpass_get(mirror, query, timeout)
                print(f'{label}: {mirror} answered in {time.time() - t0:.1f}s ({len(body)} bytes)')
                return body
            except FetchError as e:
                msg = str(e)
                print(f'{label}: attempt {attempt + 1}/{retries} failed: {msg}', file=sys.stderr)
                failures.append(msg)
                if 'HTTP 400' in msg:
                    raise
        if attempt < retries - 1:
            wait = backoff * (2 ** attempt)
            print(f'{label}: all mirrors failed, waiting {wait:.0f}s before retry', file=sys.stderr)
            time.sleep(wait)
    raise FetchError(f'{label}: every mirror failed after {retries} rounds:\n  ' + '\n  '.join(failures))


# --- Polygonisation --------------------------------------------------------------------------------
def coastline_lines(coast):
    lines = []
    for el in coast.get('elements', []):
        if el.get('type') != 'way':
            continue
        geom = el.get('geometry') or []
        if len(geom) < 2:
            continue
        lines.append(LineString([(p['lon'], p['lat']) for p in geom]))
    return lines


def _linestrings(g):
    if g.is_empty:
        return []
    if g.geom_type == 'LineString':
        return [g]
    if g.geom_type in ('MultiLineString', 'GeometryCollection'):
        out = []
        for part in g.geoms:
            out += _linestrings(part)
        return out
    return []  # points from touching the box edge


def polygonise_land(coast, bbox, log=print):
    """Land polygons (shapely geometry, unsimplified) inside bbox from Overpass coastline ways.

    OSM rule: walking a natural=coastline way, land is on the left and water on the right.
    """
    s, w, n, e = bbox
    bx = box(w, s, e, n)
    lines = coastline_lines(coast)
    if not lines:
        log('WARNING: no coastline ways in coast.json; the whole bbox is treated as water')
        return MultiPolygon([])
    merged = linemerge(lines)
    merged = _linestrings(merged)
    clipped = []
    for line in merged:
        clipped += _linestrings(line.intersection(bx))
    # directed coastline segments after clipping (vertices are preserved by the clip and the noding)
    segs = set()
    for line in clipped:
        cs = list(line.coords)
        for i in range(len(cs) - 1):
            segs.add((cs[i], cs[i + 1]))
    faces = list(polygonize(unary_union(clipped + [bx.exterior])))
    land, water, mixed = [], [], 0
    for f in faces:
        cs = list(orient(f, 1.0).exterior.coords)  # counter-clockwise: the face is on the left of each edge
        same = sum(1 for i in range(len(cs) - 1) if (cs[i], cs[i + 1]) in segs)
        opp = sum(1 for i in range(len(cs) - 1) if (cs[i + 1], cs[i]) in segs)
        if same and opp:
            mixed += 1
        if same > opp:
            land.append(f)
        else:
            water.append(f)
    log(f'coastline: {len(lines)} ways -> {len(merged)} merged lines, {len(clipped)} inside the bbox; '
        f'{len(faces)} faces -> {len(land)} land, {len(water)} water')
    if mixed:
        log(f'WARNING: {mixed} faces have coastline on both sides (inconsistent way direction in OSM); classified by majority')
    if not land:
        log('WARNING: no land faces found; check the coastline direction and the bbox')
    return unary_union(land) if land else MultiPolygon([])


def _round_coords(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], ROUND), round(c[1], ROUND)]
    return [_round_coords(x) for x in c]


def geojson(geom, force_multi=False):
    """GeoJSON dict of a (Multi)Polygon with rounded coordinates; empty -> empty MultiPolygon.
    force_multi promotes a single Polygon to a one-part MultiPolygon, so a bbox holding one connected
    land mass still produces the MultiPolygon that build_chart.load_land expects."""
    if geom.is_empty:
        return {'type': 'MultiPolygon', 'coordinates': []}
    if geom.geom_type == 'GeometryCollection':
        polys = [g for g in geom.geoms if g.geom_type in ('Polygon', 'MultiPolygon')]
        geom = unary_union(polys) if polys else MultiPolygon([])
        if geom.is_empty:
            return {'type': 'MultiPolygon', 'coordinates': []}
    m = mapping(geom)
    out = {'type': m['type'], 'coordinates': _round_coords(m['coordinates'])}
    if force_multi and out['type'] == 'Polygon':
        out = {'type': 'MultiPolygon', 'coordinates': [out['coordinates']]}
    return out


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, separators=(',', ':'))
    return os.path.getsize(path)


def polygonise_all(coast, passage, scratch, log=print):
    bbox = passage['bbox']
    land = polygonise_land(coast, bbox, log)
    land_out = geojson(land.simplify(LAND_SIMPLIFY), force_multi=True)
    n = len(land_out['coordinates'])
    size = write_json(os.path.join(scratch, 'land_osm.json'), land_out)
    log(f'wrote land_osm.json: {n} polygons, {size} bytes, area {land.area:.4f} sq deg')
    for key, place in passage.get('places', {}).items():
        if 'detailBox' in place:
            s, w, n_, e = place['detailBox']
        else:
            s, w, n_, e = (place['lat'] - DETAIL_HALF, place['lon'] - DETAIL_HALF,
                           place['lat'] + DETAIL_HALF, place['lon'] + DETAIL_HALF)
        detail = land.intersection(box(w, s, e, n_)).simplify(DETAIL_SIMPLIFY)
        out = geojson(detail)
        cnt = len(out['coordinates']) if out['type'] == 'MultiPolygon' else 1
        size = write_json(os.path.join(scratch, f'land_{key}.json'), out)
        log(f'wrote land_{key}.json ({place.get("name", key)}): {out["type"]} x{cnt}, {size} bytes')


# --- Main ---------------------------------------------------------------------------------------
def load_passage(path):
    with open(path, encoding='utf-8') as f:
        pz = json.load(f)
    bbox = pz.get('bbox')
    if not (isinstance(bbox, list) and len(bbox) == 4):
        sys.exit(f'{path}: "bbox" must be [south, west, north, east]')
    s, w, n, e = bbox
    if not (s < n and w < e and -90 <= s and n <= 90 and -180 <= w and e <= 180):
        sys.exit(f'{path}: bbox {bbox} is not south < north, west < east')
    return pz


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('passage', help='passage JSON (passages/<id>.json)')
    ap.add_argument('scratch', help='output directory (created if missing)')
    ap.add_argument('--mirror', action='append', metavar='URL',
                    help='Overpass endpoint to use (repeatable; replaces the default list: %s)' % ', '.join(DEFAULT_MIRRORS))
    ap.add_argument('--offline', action='store_true', help='do not fetch; re-polygonise from the existing coast.json')
    ap.add_argument('--timeout', type=float, default=120, help='seconds per request (also the Overpass query timeout), default 120')
    ap.add_argument('--retries', type=int, default=3, help='rounds over all mirrors before giving up, default 3')
    ap.add_argument('--backoff', type=float, default=5, help='seconds to wait after the first failed round (doubles each round), default 5')
    a = ap.parse_args(argv)

    pz = load_passage(a.passage)
    os.makedirs(a.scratch, exist_ok=True)
    coast_path = os.path.join(a.scratch, 'coast.json')
    harb_path = os.path.join(a.scratch, 'harbours.json')
    print(f'passage {pz.get("id", "?")}: bbox {pz["bbox"]}, places {list(pz.get("places", {}))}')

    if a.offline:
        if not os.path.exists(coast_path):
            sys.exit(f'--offline: {coast_path} does not exist; run without --offline first')
        if not os.path.exists(harb_path):
            print(f'note: {harb_path} missing; build_chart.py will need it', file=sys.stderr)
        with open(coast_path, encoding='utf-8') as f:
            coast = json.load(f)
        stamp = (coast.get('osm3s') or {}).get('timestamp_osm_base', 'unknown date')
        print(f'offline: using {coast_path} (OSM data {stamp})')
    else:
        mirrors = a.mirror or DEFAULT_MIRRORS
        qt = max(10, int(a.timeout))
        try:
            body = fetch(coast_query(pz['bbox'], qt), mirrors, a.timeout, a.retries, a.backoff, 'coastline')
            with open(coast_path, 'wb') as f:
                f.write(body)
            coast = json.loads(body)
            body = fetch(harbours_query(pz['bbox'], qt), mirrors, a.timeout, a.retries, a.backoff, 'seamarks')
            with open(harb_path, 'wb') as f:
                f.write(body)
            harb = json.loads(body)
        except FetchError as e:
            sys.exit(f'ERROR: {e}\nTry --mirror <url>, a larger --timeout, or --offline with an existing coast.json.')
        stamp = (coast.get('osm3s') or {}).get('timestamp_osm_base', 'unknown date')
        print(f'wrote coast.json: {len(coast["elements"])} coastline ways (OSM data {stamp})')
        kinds = {}
        for el in harb['elements']:
            t = el.get('tags', {})
            k = t.get('seamark:type') or t.get('man_made') or '?'
            kinds[k] = kinds.get(k, 0) + 1
        print(f'wrote harbours.json: {len(harb["elements"])} elements: ' + ', '.join(f'{k} {v}' for k, v in sorted(kinds.items())))
        if not coast['elements']:
            print('WARNING: Overpass returned no coastline for this bbox', file=sys.stderr)

    polygonise_all(coast, pz, a.scratch)
    return 0


if __name__ == '__main__':
    sys.exit(main())
