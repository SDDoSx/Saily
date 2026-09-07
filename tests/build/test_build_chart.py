#!/usr/bin/env python3
"""Golden test for the chart pipeline: tools/fetch_osm.py (land polygonisation, offline part) and
tools/build_chart.py, run on the hand-written fixture in tests/build/fixtures (a square island, a mainland
coast with a bay, a few seamarks, one route, and a small traffic separation scheme in tss.json: two lanes,
a separation zone, a precautionary area, an inshore zone clipped to the coast, a free area, an anchorage).

Run:    python3 tests/build/test_build_chart.py        (plain python, no pytest needed)
   or:  python3 -m pytest tests/build
Update the golden files after an intended change:  UPDATE_GOLDEN=1 python3 tests/build/test_build_chart.py
"""
import difflib
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
FIXTURES = os.path.join(HERE, 'fixtures')
GOLDEN = os.path.join(HERE, 'golden')
UPDATE = os.environ.get('UPDATE_GOLDEN') == '1'


def load_module(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fetch_osm = load_module('fetch_osm', 'tools/fetch_osm.py')
build_chart = load_module('build_chart', 'tools/build_chart.py')

_cache = {}


def pipeline():
    """Run fetch_osm's polygonisation and build_chart on the fixture in a temp dir (once per process)."""
    if 'result' in _cache:
        return _cache['result']
    tmp = tempfile.mkdtemp(prefix='saily-build-test-')
    try:
        for f in ('coast.json', 'harbours.json'):
            shutil.copy(os.path.join(FIXTURES, f), os.path.join(tmp, f))
        passage_path = os.path.join(FIXTURES, 'passage.json')
        passage = json.load(open(passage_path, encoding='utf-8'))
        coast = json.load(open(os.path.join(tmp, 'coast.json'), encoding='utf-8'))
        logs = []
        fetch_osm.polygonise_all(coast, passage, tmp, log=logs.append)
        land_files = {f: json.load(open(os.path.join(tmp, f))) for f in sorted(os.listdir(tmp)) if f.startswith('land_')}
        tss = build_chart.load_tss(passage_path, passage)
        chart, passage_out, report = build_chart.build(tmp, passage, tss)
        out_js = os.path.join(tmp, 'out', 'chart-data.js')
        js, pjs = build_chart.write_outputs(chart, passage_out, out_js, os.path.join(tmp, 'out', 'passage.js'))
        result = {'chart': chart, 'passage': passage_out, 'report': report, 'land': land_files, 'logs': logs,
                  'js': js, 'pjs': pjs, 'passage_in': passage, 'tss_in': tss}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    _cache['result'] = result
    return result


def pretty(obj):
    return json.dumps(obj, indent=1, sort_keys=False, ensure_ascii=False) + '\n'


def check_golden(name, obj):
    path = os.path.join(GOLDEN, name)
    text = pretty(obj)
    if UPDATE:
        os.makedirs(GOLDEN, exist_ok=True)
        open(path, 'w', encoding='utf-8').write(text)
        print('updated', path)
        return
    assert os.path.exists(path), f'missing golden file {path}; run with UPDATE_GOLDEN=1'
    want = open(path, encoding='utf-8').read()
    if json.loads(want) != obj:
        diff = ''.join(difflib.unified_diff(want.splitlines(True), text.splitlines(True), 'golden/' + name, 'actual/' + name, n=2))
        raise AssertionError(f'{name} differs from golden (UPDATE_GOLDEN=1 to accept):\n{diff[:6000]}')


# --- fetch_osm: land polygonisation --------------------------------------------------------------
def test_land_polygons():
    r = pipeline()
    land = r['land']['land_osm.json']
    assert land['type'] == 'MultiPolygon'
    polys = land['coordinates']
    assert len(polys) == 2, f'expected mainland + island, got {len(polys)} polygons'
    boxes = sorted(((min(x for x, y in p[0]), min(y for x, y in p[0]), max(x for x, y in p[0]), max(y for x, y in p[0])) for p in polys))
    mainland, island = boxes
    assert mainland == (-7.1, 36.0, -7.0, 36.03), f'mainland clipped to the bbox: {mainland}'
    assert island == (-7.04, 36.06, -7.03, 36.07), f'square island kept: {island}'
    assert all(len(p) == 1 for p in polys), 'no holes'
    assert not any('(-6.95' in json.dumps(p) for p in polys), 'island outside the bbox dropped'
    for p in polys:
        for x, y in p[0]:
            assert round(x, 5) == x and round(y, 5) == y, 'coordinates rounded to 5 decimals'
    assert any('4 ways -> 3 merged lines' in l for l in r['logs']), r['logs']
    check_golden('land_osm.json', land)


def one_polygon_pipeline():
    """Polygonise a coast with no offshore island, so the bbox holds one connected land mass.
    That is the case that used to write land_osm.json as a bare Polygon and crash build_chart.load_land."""
    if 'one_poly' in _cache:
        return _cache['one_poly']
    tmp = tempfile.mkdtemp(prefix='saily-build-test-1poly-')
    try:
        coast = json.load(open(os.path.join(FIXTURES, 'coast.json'), encoding='utf-8'))
        coast['elements'] = [e for e in coast['elements'] if e['id'] not in (1003, 1004)]  # drop both islands
        passage = json.load(open(os.path.join(FIXTURES, 'passage.json'), encoding='utf-8'))
        fetch_osm.polygonise_all(coast, passage, tmp, log=lambda *a: None)
        land_file = json.load(open(os.path.join(tmp, 'land_osm.json'), encoding='utf-8'))
        land, land_xy = build_chart.load_land(tmp)
        result = {'file': land_file, 'land': land, 'land_xy': land_xy}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    _cache['one_poly'] = result
    return result


def test_land_single_mass_is_multipolygon():
    r = one_polygon_pipeline()
    assert r['file']['type'] == 'MultiPolygon', 'one connected land mass must still be a MultiPolygon'
    assert len(r['file']['coordinates']) == 1, r['file']['coordinates']
    assert r['land'].geom_type == 'MultiPolygon' and len(r['land'].geoms) == 1
    assert not r['land_xy'].is_empty and r['land_xy'].area > 0


def test_land_detail():
    r = pipeline()
    assert sorted(k for k in r['land'] if k != 'land_osm.json') == ['land_bay.json']
    d = r['land']['land_bay.json']
    ring = d['coordinates'][0] if d['type'] == 'Polygon' else d['coordinates'][0][0]
    xs = [x for x, y in ring]; ys = [y for x, y in ring]
    assert min(ys) == 36.0 and max(ys) == 36.03, (min(ys), max(ys))  # bbox south edge .. mainland shore
    assert min(xs) == -7.075 and max(xs) == -7.025, (min(xs), max(xs))  # +-0.025 around the place
    assert [36.012, -7.05] in [[y, x] for x, y in ring] or (-7.05, 36.012) in [tuple(c) for c in ring], 'bay bottom kept'
    assert len(ring) == 10, ring
    check_golden('land_bay.json', d)


# --- build_chart -----------------------------------------------------------------------------------
def test_chart_content():
    r = pipeline()
    c = r['chart']
    assert list(c.keys()) == ['meta', 'land', 'landDetail', 'structures', 'tss', 'anchorages', 'aids']
    assert c['meta']['passage'] == 'fixture-bay' and c['meta']['bbox'] == [36.0, -7.1, 36.1, -7.0]
    assert len(c['land']) == 2 and all(r_[0] == r_[-1] for r_ in c['land']), 'closed lat/lon rings'
    assert all(35.9 < lat < 36.2 and -7.2 < lon < -6.9 for ring in c['land'] for lat, lon in ring), 'rings are [lat, lon]'
    assert list(c['landDetail'].keys()) == ['bay']
    assert len(c['structures']) == 2, 'breakwater + pier (groyne not drawn)'
    assert [len(s) for s in c['structures']] == [3, 2]
    assert [a['name'] for a in c['anchorages']] == ['Anchorage Bravo'], 'three-point anchorage dropped'
    assert len(c['anchorages'][0]['ring']) == 5
    aids = {a['name'] or a['type']: a for a in c['aids']}
    assert sorted(a['type'] for a in c['aids']) == ['buoy_cardinal', 'buoy_lateral', 'harbour', 'light_major', 'light_minor', 'wreck']
    assert aids['Bay head light']['light'] == 'Fl G 4s 6M'
    assert aids['Square Island lighthouse']['light'] == 'Fl(2) W 10s 20M', 'numbered sector keys (seamark:light:1:*)'
    assert aids['Bay No 2']['cat'] == 'port' and aids['Bay No 2']['light'] == ''
    assert aids['buoy_cardinal']['cat'] == 'north' and aids['buoy_cardinal']['light'] == 'Q W'
    assert aids['Old wreck']['type'] == 'wreck'
    assert all(a['type'] != 'mooring' for a in c['aids'])
    check_golden('chart.json', c)


def test_tss_block():
    """The TSS comes from the tss.json named by the passage (docs/TSS-DATA.md), not from the builder."""
    r = pipeline()
    t = r['chart']['tss']
    assert list(t.keys()) == ['lanes', 'zones', 'precautionary', 'itz', 'free', 'points', 'anchorages']
    # points: IMO points only (construction points stay internal), degrees-and-minutes strings parsed
    assert list(t['points'].keys()) == [str(i) for i in range(1, 11)]
    assert t['points']['2'] == [36.08, -7.005], 'point 2 is written as "36 04.80 N", "7 00.30 W"'
    # lanes: region minus the separation-zone strip, split by side; flow letter derived from flowDeg
    assert [l['id'] for l in t['lanes']] == ['north_wb', 'south_eb']
    north, south = t['lanes']
    assert list(north.keys()) == ['id', 'name', 'flow', 'rings', 'arrows', 'flowDeg', 'crossing', 'level', 'enter', 'leave']
    assert (north['flow'], north['flowDeg'], north['crossing']) == ('W', 270, 'rightAngles')
    assert (south['flow'], south['flowDeg'], south['crossing']) == ('E', 90, 'rightAngles'), 'crossing defaults to rightAngles'
    def span(el):
        pts = [p for ring in el['rings'] for p in ring]
        return (min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts))
    assert span(north) == (36.08167, 36.09, -7.095, -7.005), 'north lane: zone edge (36.08 + 0.1 nm) to the region top'
    assert span(south) == (36.072, 36.07833, -7.095, -7.005)
    assert span(t['zones'][0]) == (36.07833, 36.08167, -7.095, -7.005), 'strip 2 x 0.1 nm clipped to the region'
    assert north['arrows'] == [[36.085, -7.02, 270], [36.085, -7.05, 270], [36.085, -7.08, 270]], 'along 2->1, 0.3 nm north, 3 per segment, inside the lane'
    assert south['arrows'] == [[36.07667, -7.08, 90], [36.07667, -7.05, 90], [36.07667, -7.02, 90]]
    # precautionary: plain region; inshore zone and free area clipped to the land (coast at 36.03, bay down to 36.012)
    assert span(t['precautionary'][0]) == (36.072, 36.09, -7.005, -7.0)
    assert t['itz'][0]['rings'] == [[[36.072, -7.045], [36.013, -7.045], [36.012, -7.05], [36.015, -7.065], [36.03, -7.07], [36.03, -7.095], [36.072, -7.095], [36.072, -7.045]]]
    assert span(t['free'][0]) == (36.03, 36.072, -7.025, -7.005)
    # alert text and level copied from the tss.json for every element
    for key in ('lanes', 'zones', 'precautionary', 'itz', 'free'):
        for el in t[key]:
            assert el['level'] in ('danger', 'warn', 'info') and el['enter'].endswith('.'), (key, el['id'])
            assert 'leave' in el
    assert t['zones'][0]['leave'] is None and t['itz'][0]['leave'] == 'Leaving the inshore zone.'
    assert t['anchorages'] == [{'id': 'anch_bay', 'name': 'Bay anchorage', 'lat': 36.04, 'lon': -7.06, 'radiusNm': 0.2}]


def test_no_tss():
    """A passage without "tss" gets an empty block with every list present (the app iterates them)."""
    tss, check_polys = build_chart.build_tss(None, None)
    assert tss == {'lanes': [], 'zones': [], 'precautionary': [], 'itz': [], 'free': [], 'points': {}, 'anchorages': []}
    assert check_polys == []
    assert build_chart.load_tss(os.path.join(FIXTURES, 'passage.json'), {'id': 'x'}) is None


def test_tss_helpers():
    assert build_chart.parse_coord('35 59.01 N') == 35 + 59.01 / 60.0
    assert build_chart.parse_coord('5 25.68 W') == -(5 + 25.68 / 60.0)
    assert build_chart.parse_coord(-7.005) == -7.005
    assert [build_chart.flow_letter(d) for d in (0, 72, 90, 180, 252, 270, 359)] == ['N', 'E', 'E', 'S', 'W', 'W', 'N']
    pts = build_chart.resolve_points({'points': [{'id': 'a', 'lat': 1, 'lon': 2}, {'id': 'b', 'lat': 3, 'lonOf': 'a'}, {'id': 'c', 'latOf': 'b', 'lonOf': 'b'}]})
    assert pts == {'a': (1.0, 2.0), 'b': (3.0, 2.0), 'c': (3.0, 2.0)}
    assert build_chart.report_label('lane', {'id': 'west_wb', 'paragraph': 'd'}) == 'lane_d'
    assert build_chart.report_label('lane', {'id': 'north_wb'}) == 'north_wb'


def test_routes_and_leg_check():
    r = pipeline()
    p = r['passage']
    assert p['id'] == 'fixture-bay' and p['places'] == r['passage_in']['places']
    route = p['routes'][0]
    assert [w['id'] for w in route['waypoints']] == ['BAY', 'BAY-OUT', 'SEA', 'NORTH']
    assert route['waypoints'][3]['note'] == '' and route['waypoints'][3]['radius'] == 0.2
    assert [(l['from'], l['to']) for l in route['legs']] == [('BAY', 'BAY-OUT'), ('BAY-OUT', 'SEA'), ('SEA', 'NORTH')]
    assert route['legs'][0]['brg'] == 0 and route['legs'][0]['dist'] == 0.72
    assert route['total'] == round(sum(l['dist'] for l in route['legs']), 1)
    # leg check: the SEA -> NORTH leg cuts across Square Island and crosses the whole scheme
    # (labels are <kind>_<paragraph letter>: zone_a, lane_b, lane_c; zones first, then lanes, then precautionary areas)
    rows = {(row[1], row[2]): row for row in r['report']}
    assert rows[('SEA', 'NORTH')][3] == 0.0 and rows[('SEA', 'NORTH')][4] == ['zone_a', 'lane_b', 'lane_c']
    assert rows[('BAY-OUT', 'SEA')][4] == [], 'inshore zones and free areas are not part of the crossing report'
    assert rows[('BAY-OUT', 'SEA')][3] > 0.25
    bad = build_chart.bad_legs(r['report'], {'BAY'})
    assert [(b[1], b[2]) for b in bad] == [('SEA', 'NORTH')], bad
    check_golden('passage.json', p)


def test_js_rendering():
    r = pipeline()
    assert r['js'].startswith('window.CHART = {') and r['js'].endswith(';\n')
    assert json.loads(r['js'][len('window.CHART = '):-2]) == r['chart']
    assert r['pjs'].startswith('window.PASSAGE = {') and r['pjs'].endswith(';\n')
    assert json.loads(r['pjs'][len('window.PASSAGE = '):-2]) == r['passage']
    assert '→' in r['pjs'], 'passage.js keeps UTF-8 (ensure_ascii=False)'
    assert r['js'].isascii(), 'chart-data.js stays ASCII'


# --- the JavaScript port of the leg check --------------------------------------------------------
def test_leg_fixture_matches_shapely():
    """The fixture tests/nav.test.js checks the JS port against is what shapely actually computes.

    Both sides measure the shipped chart, so a change to build_chart's geometry, to the routes, or to the
    coastline shows up here before it can silently disagree with the browser."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    chart_js = os.path.join(ROOT, 'site', 'passages', 'strait-of-gibraltar', 'chart-data.js')
    passage_json = os.path.join(ROOT, 'passages', 'strait-of-gibraltar.json')
    fixture = os.path.join(ROOT, 'tests', 'fixtures', 'legs-strait-of-gibraltar.json')
    if not (os.path.exists(chart_js) and os.path.exists(fixture)):
        print('SKIP test_leg_fixture_matches_shapely (chart or fixture missing)')
        return
    chart = json.loads(open(chart_js, encoding='utf-8').read()[len('window.CHART = '):-2])
    land_xy = unary_union([Polygon([build_chart.to_xy(c) for c in ring]) for ring in chart['land']])
    check = []
    for grp in ('lanes', 'zones', 'precautionary'):
        for e in chart['tss'].get(grp, []):
            check.append((e['id'], unary_union([Polygon([build_chart.to_xy(c) for c in r]) for r in e['rings']])))
    pz = json.load(open(passage_json, encoding='utf-8'))
    rows = build_chart.check_legs(build_chart.build_routes(pz), land_xy, check)
    legs = [{'route': r[0], 'from': r[1], 'to': r[2], 'landNm': r[3], 'crosses': sorted(r[4])} for r in rows]

    want = json.load(open(fixture, encoding='utf-8'))
    if UPDATE:
        want['legs'] = legs
        want['lat0'] = build_chart.LAT0
        open(fixture, 'w', encoding='utf-8').write(json.dumps(want, indent=1) + '\n')
        print('updated', fixture)
        return
    assert want['lat0'] == build_chart.LAT0, f"fixture projection origin {want['lat0']} != build_chart.LAT0 {build_chart.LAT0}"
    assert want['legs'] == legs, ('leg check drifted from the fixture; re-run with UPDATE_GOLDEN=1 and check the JS port\n'
                                  + '\n'.join(difflib.unified_diff(pretty(want['legs']).splitlines(True), pretty(legs).splitlines(True),
                                                                   'fixture', 'shapely', n=2)))


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print('PASS', t.__name__)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print('FAIL', t.__name__, '-', e)
    print(f'{len(tests) - failed}/{len(tests)} passed')
    sys.exit(1 if failed else 0)
