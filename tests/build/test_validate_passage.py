#!/usr/bin/env python3
"""Tests for tools/validate_passage.py: the bundled passage and the test fixture validate cleanly, and each
class of mistake is reported at the right JSON pointer. Every case runs with the jsonschema library (when
installed) and with the built-in fallback checker, so both paths report the same errors.

Run:    python3 tests/build/test_validate_passage.py        (plain python, no pytest needed)
   or:  python3 -m pytest tests/build
"""
import copy
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
FIXTURES = os.path.join(HERE, 'fixtures')


def load_module(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vp = load_module('validate_passage', 'tools/validate_passage.py')
CHECKERS = [True, False] if vp.jsonschema is not None else [False]


def fixture():
    pz = json.load(open(os.path.join(FIXTURES, 'passage.json'), encoding='utf-8'))
    tss = json.load(open(os.path.join(FIXTURES, 'tss.json'), encoding='utf-8'))
    return pz, tss


def both(fn):
    """Run fn(checker_name) with the library and with the fallback checker."""
    for lib in CHECKERS:
        vp.HAVE_JSONSCHEMA = lib
        try:
            fn('jsonschema' if lib else 'builtin')
        finally:
            vp.HAVE_JSONSCHEMA = vp.jsonschema is not None


def errors_at(rep, ptr):
    return [m for p, m in rep.errors if p == ptr]


def has_error(rep, ptr, text):
    return any(p == ptr and text in m for p, m in rep.errors)


# --- clean data --------------------------------------------------------------------------------------
def test_bundled_passage_is_clean():
    def run(name):
        reports = vp.validate_files(os.path.join(ROOT, 'passages', 'strait-of-gibraltar.json'))
        assert [r.file for r in reports] == ['passages/strait-of-gibraltar.json', 'passages/strait-of-gibraltar.tss.json'], [r.file for r in reports]
        for r in reports:
            assert r.errors == [] and r.warnings == [], (name, r.file, list(r.lines()))
    both(run)


def test_fixture_is_clean():
    def run(name):
        reports = vp.validate_files(os.path.join(FIXTURES, 'passage.json'))
        assert len(reports) == 2
        for r in reports:
            assert r.errors == [] and r.warnings == [], (name, r.file, list(r.lines()))
    both(run)


def test_bundled_tss_content():
    """The Gibraltar file keeps the 25 IMO positions and alert text for every element."""
    tss = json.load(open(os.path.join(ROOT, 'passages', 'strait-of-gibraltar.tss.json'), encoding='utf-8'))
    imo = [p for p in tss['points'] if p.get('role', 'imo') == 'imo']
    assert [p['id'] for p in imo] == [str(i) for i in range(1, 26)]
    pts = vp.resolve_points(tss['points'])
    assert round(pts['1'][0], 5) == 35.9835 and round(pts['1'][1], 5) == -5.428
    assert pts['itz_n_nw'] == (36.12, pts['11'][1]) and pts['coast_19'] == (35.78, pts['19'][1])
    ids = [el['id'] for k in vp.TSS_LISTS for el in tss.get(k, [])]
    assert ids == ['zone_b', 'zone_a', 'west_wb', 'west_eb', 'east_wb', 'east_eb', 'prec_east', 'prec_tm', 'itz_n', 'itz_se', 'itz_sw', 'free_tm', 'anch_alpha']
    assert [l['flowDeg'] for l in tss['lanes']] == [270, 90, 270, 90]
    assert all(el['enter'] for k in vp.TSS_LISTS if k != 'anchorages' for el in tss[k])
    assert tss['lanes'][0]['enter'].startswith('Entering the WESTBOUND traffic lane. Ships come from your LEFT')


# --- schema errors -----------------------------------------------------------------------------------
def test_passage_schema_errors():
    def run(name):
        pz, _ = fixture()
        pz['routes'][0]['waypoints'][0]['lat'] = 95
        pz['routes'][0]['waypoints'][1]['radius'] = 0
        pz['hazards'][0]['level'] = 'severe'
        pz['weatherPoints'] = [{'id': 'a', 'name': 'A', 'lat': 36.05, 'lon': -7.05}]  # routeNm missing
        pz['labels'][0]['z'] = 8.5
        pz['places']['bay']['lon'] = -181
        pz['defaultDeparture'] = '25:00'
        pz['cards'] = [{'id': 'c1', 'title': 'T'}]
        pz['routes'][0]['waypoints'][2]['id'] = 'sea'
        pz['routes'][0]['waypoints'][3]['extra'] = 1
        rep = vp.validate_passage_dict(pz, 'p')
        assert has_error(rep, '/routes/0/waypoints/0/lat', '90'), (name, list(rep.lines()))
        assert errors_at(rep, '/routes/0/waypoints/1/radius'), name
        assert has_error(rep, '/hazards/0/level', 'severe'), name
        assert has_error(rep, '/weatherPoints/0', 'routeNm'), name
        assert errors_at(rep, '/labels/0/z'), name
        assert has_error(rep, '/places/bay/lon', '-180'), name
        assert errors_at(rep, '/defaultDeparture'), name
        assert has_error(rep, '/cards/0', 'html'), name
        assert errors_at(rep, '/routes/0/waypoints/2/id'), (name, 'lower-case waypoint id')
        assert has_error(rep, '/routes/0/waypoints/3', 'extra'), (name, 'unknown waypoint key')
    both(run)


def test_passage_required_and_bbox():
    def run(name):
        pz, _ = fixture()
        del pz['routes']
        pz['bbox'] = [36.1, -7.0, 36.0, -7.1]
        rep = vp.validate_passage_dict(pz, 'p')
        assert has_error(rep, '/', 'routes'), name
        assert has_error(rep, '/bbox', 'south') and has_error(rep, '/bbox', 'west'), (name, list(rep.lines()))
        pz, _ = fixture()
        pz['bbox'] = [36.0, -7.1, 36.1]
        rep = vp.validate_passage_dict(pz, 'p')
        assert errors_at(rep, '/bbox'), name
    both(run)


def test_tss_schema_errors():
    def run(name):
        _, tss = fixture()
        tss['lanes'][0]['flowDeg'] = 400
        del tss['lanes'][1]['enter']
        tss['separationZones'][0]['halfWidthNm'] = 0
        tss['anchorages'][0]['radiusNm'] = -1
        tss['precautionary'][0]['level'] = 'loud'
        tss['inshoreZones'][0]['region'] = ['6', '9']
        tss['points'][0]['lat'] = '91 00.00 N'
        tss['points'][2]['lon'] = 181
        tss['points'].append({'id': 'nolat', 'lon': 1})
        tss['points'].append({'id': 'twolat', 'lat': 1, 'latOf': '1', 'lon': 1})
        tss['lanes'][0]['side'] = 'up'
        del tss['checkedBy']
        tss['sourceDate'] = 'yesterday'
        rep = vp.validate_tss_dict(tss, 't')
        assert has_error(rep, '/lanes/0/flowDeg', '360'), (name, list(rep.lines()))
        assert has_error(rep, '/lanes/1', 'enter'), name
        assert errors_at(rep, '/separationZones/0/halfWidthNm'), name
        assert errors_at(rep, '/anchorages/0/radiusNm'), name
        assert has_error(rep, '/precautionary/0/level', 'loud'), name
        assert errors_at(rep, '/inshoreZones/0/region'), name
        assert errors_at(rep, '/points/0/lat'), (name, 'latitude 91 rejected by the pattern')
        assert has_error(rep, '/points/2/lon', '180'), name
        assert errors_at(rep, '/points/14'), (name, 'lat or latOf required')
        assert errors_at(rep, '/points/15'), (name, 'lat and latOf are exclusive')
        assert has_error(rep, '/lanes/0/side', 'up'), name
        assert has_error(rep, '/', 'checkedBy'), name
        assert errors_at(rep, '/sourceDate'), name
    both(run)


def test_tss_side_requires_zone():
    def run(name):
        _, tss = fixture()
        del tss['lanes'][0]['separationZone']
        rep = vp.validate_tss_dict(tss, 't')
        assert has_error(rep, '/lanes/0', 'separationZone'), (name, list(rep.lines()))
        _, tss = fixture()
        tss['lanes'][0]['unknownKey'] = 1
        rep = vp.validate_tss_dict(tss, 't')
        assert has_error(rep, '/lanes/0', 'unknownKey'), (name, list(rep.lines()))
    both(run)


# --- checks beyond the schema --------------------------------------------------------------------------
def test_passage_semantic_checks():
    def run(name):
        pz, _ = fixture()
        pz['weatherPoints'] = [{'id': 'a', 'name': 'A', 'lat': 36.05, 'lon': -7.05, 'routeNm': 2.0},
                               {'id': 'b', 'name': 'B', 'lat': 36.06, 'lon': -7.05, 'routeNm': 1.5},
                               {'id': 'a', 'name': 'C', 'lat': 36.5, 'lon': -7.05, 'routeNm': 3.0}]
        pz['harbourWaypoints'] = ['BAY', 'NOWHERE']
        pz['routes'][0]['waypoints'][1]['id'] = 'BAY'
        pz['hazards'].append(dict(pz['hazards'][0], lat=35.0))
        pz['thresholds'] = {'windCaution': 20, 'windNoGo': 14}
        pz['tz'] = {'from': {'label': 'A', 'zone': 'Europe/Madrid'}, 'to': {'label': 'B', 'zone': 'Mars/Olympus'}}
        pz['mystery'] = 1
        pz['routes'].append(dict(pz['routes'][0]))
        rep = vp.validate_passage_dict(pz, 'p')
        assert has_error(rep, '/weatherPoints/1/routeNm', 'less than'), (name, list(rep.lines()))
        assert has_error(rep, '/weatherPoints/2/id', 'already used'), name
        assert has_error(rep, '/weatherPoints/2', 'outside bbox'), name
        assert has_error(rep, '/harbourWaypoints/1', 'NOWHERE'), name
        assert has_error(rep, '/routes/0/waypoints/1/id', 'already used'), name
        assert has_error(rep, '/hazards/1/id', 'already used') and has_error(rep, '/hazards/1', 'outside bbox'), name
        assert has_error(rep, '/thresholds/windCaution', 'below'), name
        assert has_error(rep, '/tz/to/zone', 'Mars/Olympus'), name
        assert has_error(rep, '/routes', 'duplicate route id'), name
        assert any(p == '/mystery' for p, _ in rep.warnings), (name, 'unknown top-level key is a warning')
        assert any(p == '/routes' and 'recommended' in m for p, m in rep.warnings), name
    both(run)


def test_tss_semantic_checks():
    def run(name):
        pz, tss = fixture()
        tss['lanes'][0]['region'] = ['3', '4', '5', '99']
        tss['lanes'][1]['separationZone'] = 'nozone'
        tss['separationZones'][0]['centreline'] = ['1', '1']
        tss['precautionary'][0]['id'] = 'north_wb'
        tss['points'].append({'id': 'loop_a', 'lat': 1, 'lonOf': 'loop_b'})
        tss['points'].append({'id': 'loop_b', 'lat': 1, 'lonOf': 'loop_a'})
        tss['points'].append({'id': 'far', 'lat': 10, 'lon': 10})
        tss['points'].append({'id': 'badmin', 'lat': '35 65.00 N', 'lon': 1})
        tss['inshoreZones'][0]['enter'] = 'no full stop'
        tss['freeAreas'][0]['region'] = ['10', '5', '10', '5']
        rep = vp.validate_tss_dict(tss, 't', pz)
        assert has_error(rep, '/lanes/0/region/3', "'99'"), (name, list(rep.lines()))
        assert has_error(rep, '/lanes/1/separationZone', 'nozone'), name
        assert has_error(rep, '/separationZones/0/centreline', 'twice'), name
        assert has_error(rep, '/precautionary/0/id', 'already used'), name
        assert any(p.startswith('/points/') and 'circular' in m for p, m in rep.errors), name
        assert any(p == '/points/16' and 'outside the passage bbox' in m for p, m in rep.warnings), (name, list(rep.lines()))
        assert has_error(rep, '/points/17/lat', 'cannot parse'), (name, 'minutes >= 60')
        assert any(p == '/inshoreZones/0/enter' and 'full stop' in m for p, m in rep.warnings), name
        assert errors_at(rep, '/freeAreas/0/region'), (name, 'degenerate polygon')
    both(run)


def test_self_intersecting_region_needs_shapely():
    try:
        import shapely  # noqa: F401
    except ImportError:
        return
    pz, tss = fixture()
    tss['precautionary'][0]['region'] = ['4', '8', '7', '5']  # bow tie
    rep = vp.validate_tss_dict(tss, 't', pz)
    assert has_error(rep, '/precautionary/0/region', 'not valid'), list(rep.lines())


def test_files_and_cli(tmp_path=None):
    import tempfile
    d = tempfile.mkdtemp(prefix='saily-validate-')
    try:
        pz, tss = fixture()
        pz['tss'] = 'missing.tss.json'
        open(os.path.join(d, 'p.json'), 'w').write(json.dumps(pz))
        reports = vp.validate_files(os.path.join(d, 'p.json'))
        assert len(reports) == 1 and has_error(reports[0], '/tss', 'not found'), list(reports[0].lines())
        open(os.path.join(d, 'broken.json'), 'w').write('{')
        reports = vp.validate_files(os.path.join(d, 'broken.json'))
        assert has_error(reports[0], '/', 'cannot read JSON')
        pz['tss'] = 't.json'
        open(os.path.join(d, 'p.json'), 'w').write(json.dumps(pz))
        open(os.path.join(d, 't.json'), 'w').write(json.dumps(tss))
        assert vp.main([os.path.join(d, 'p.json'), '--quiet']) == 0
        tss['lanes'][0]['flowDeg'] = -1
        open(os.path.join(d, 't.json'), 'w').write(json.dumps(tss))
        assert vp.main([os.path.join(d, 'p.json'), '--quiet']) == 1
        assert vp.main(['--quiet']) == 0, 'default: every passages/*.json'
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


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
    print(f'{len(tests) - failed}/{len(tests)} passed', '(jsonschema + built-in checker)' if vp.jsonschema is not None else '(built-in checker only)')
    sys.exit(1 if failed else 0)
