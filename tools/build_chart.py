#!/usr/bin/env python3
"""Build site/chart-data.js and site/passage.js: offline vector chart and passage definition for one passage.

Usage: build_chart.py [<scratch_dir>] [<out.js>] [<passage.json>]
       (defaults: . site/chart-data.js passages/strait-of-gibraltar.json; passage.js is written next to <out.js>)

The scratch directory holds the OpenStreetMap inputs written by tools/fetch_osm.py:
coast.json, harbours.json, land_osm.json and land_<place>.json.
The passage JSON (schema/passage.schema.json, docs/PASSAGE-FORMAT.md) may name a traffic separation scheme file
with "tss": "<file>.tss.json" (schema/tss.schema.json, docs/TSS-DATA.md); both are validated with
tools/validate_passage.py before anything is built.

Sources
- Land: OpenStreetMap coastline (ODbL), fetched via Overpass, polygonised with the OSM left-hand rule.
- TSS: the IMO circular named in the tss.json "source" field. For the bundled passage: COLREG.2/Circ.66
  (adopted 21 Nov 2014, in force 1 June 2015), Annex 1, "In the Strait of Gibraltar", reference chart IHM 445,
  WGS84, positions copied verbatim into passages/strait-of-gibraltar.tss.json.
- Aids to navigation: OpenStreetMap seamark tags (ODbL).
- Sotogrande shoal: Puerto Sotogrande safety notice, 20 Feb 2026.
"""
import json, math, sys, os
from shapely.geometry import shape, Polygon, MultiPolygon, LineString, Point, mapping, box
from shapely.ops import unary_union, nearest_points

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_passage  # noqa: E402  (tools/validate_passage.py)

DEFAULT_PASSAGE = os.path.join(os.path.dirname(__file__), '..', 'passages', 'strait-of-gibraltar.json')

LAT0 = 35.95
KX = math.cos(math.radians(LAT0)) * 60.0  # nm per degree lon
KY = 60.0                                  # nm per degree lat

def to_xy(ll):  # (lat, lon) -> (x nm, y nm)
    return (ll[1] * KX, ll[0] * KY)

def to_ll(xy):
    return (xy[1] / KY, xy[0] / KX)

def poly_xy(pts):
    return Polygon([to_xy(p) for p in pts])

def geom_to_latlon(g):
    """shapely geometry in xy nm -> list of rings [[lat,lon],...] (outer only)."""
    if g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [[[round(to_ll(c)[0], 5), round(to_ll(c)[1], 5)] for c in g.exterior.coords]]
    if g.geom_type == 'MultiPolygon':
        out = []
        for p in g.geoms:
            out += geom_to_latlon(p)
        return out
    raise ValueError(g.geom_type)

def extend_xy(pts, d=3.0):
    """Centreline points (lat, lon) -> xy polyline extended by d nm at both ends, so that the buffered strip
    covers the whole region it is clipped to."""
    xy = [to_xy(p) for p in pts]
    def ext(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        return (b[0] + dx / n * d, b[1] + dy / n * d)
    return [ext(xy[1], xy[0])] + xy + [ext(xy[-2], xy[-1])]

def pick_side(rest, side):
    """region minus separation-zone strip -> the part on the given side (north/south/east/west by centroid)."""
    parts = list(rest.geoms) if rest.geom_type == 'MultiPolygon' else [rest]
    assert len(parts) == 2, f'separation zone must split the lane region in exactly 2 parts, got {len(parts)}'
    key = (lambda p: p.centroid.y) if side in ('north', 'south') else (lambda p: p.centroid.x)
    parts = sorted(parts, key=key, reverse=side in ('north', 'east'))
    return parts[0]

# Land
def load_land(scratch):
    """land_osm.json -> (shapely MultiPolygon in lon/lat, union in xy nm)."""
    land = shape(json.load(open(os.path.join(scratch, 'land_osm.json'))))
    land_xy = unary_union([Polygon([to_xy((c[1], c[0])) for c in poly.exterior.coords]) for poly in land.geoms])
    return land, land_xy

def bearing(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

def dist_nm(a, b):
    R = 6371008.8
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h)) / 1852.0

def interp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

# Lane flow arrows along centre lines
def arrows(points, dirn, n_per_seg=3):
    out = []
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        brg = bearing(a, b) if dirn == 'fwd' else bearing(b, a)
        for k in range(n_per_seg):
            t = (k + 0.5) / n_per_seg
            p = interp(a, b, t)
            out.append([round(p[0], 5), round(p[1], 5), round(brg)])
    return out

def centre(poly):
    c = poly.centroid
    return to_ll((c.x, c.y))

# lane centre lines (offset 0.25nm + half lane width from zone centre) approximated by lane polygon centroids per segment:
# simpler: use zone centre line shifted north/south by ~1.1 nm
def shift(points, dy):
    return [(p[0] + dy / KY, p[1]) for p in points]

def clip_arrows(arr, poly):
    return [a for a in arr if poly.contains(Point(to_xy((a[0], a[1]))))]

# --- Traffic separation scheme from the passage's tss.json ------------------------------------
EMPTY_TSS = {'lanes': [], 'zones': [], 'precautionary': [], 'itz': [], 'free': [], 'points': {}, 'anchorages': []}

def load_tss(passage_file, PZ):
    """The tss.json named by the passage ("tss": relative to the passage file), or None when there is none."""
    path = validate_passage.tss_path_for(passage_file, PZ)
    if path is None:
        return None
    return json.load(open(path, encoding='utf-8'))

def parse_coord(v):
    """Decimal degrees or 'DD MM.MM H' as printed in IMO circulars -> float degrees (S and W negative)."""
    val = validate_passage.parse_coord(v)
    if val is None:
        raise ValueError(f'bad coordinate {v!r}')
    return val

def resolve_points(tss):
    """tss['points'] -> {id: (lat, lon)}; latOf/lonOf take the parallel/meridian of another point."""
    raw = {p['id']: p for p in tss['points']}
    def coord(p, key):
        ref = p.get(key + 'Of')
        return coord(raw[ref], key) if ref is not None else parse_coord(p[key])
    return {p['id']: (coord(p, 'lat'), coord(p, 'lon')) for p in tss['points']}

def flow_letter(deg):
    """Nearest cardinal of a flow bearing: the app's l.flow ('W' westbound, else eastbound)."""
    return 'NESW'[int(((deg % 360) + 45) // 90) % 4]

def alert_fields(el):
    return {'level': el['level'], 'enter': el['enter'], 'leave': el.get('leave')}

def report_label(kind, el):
    """Name of a polygon in the LEG report: <kind>_<paragraph letter of the circular>, else the id
    (docs/TESTING.md lists the mapping: lane_d = west_wb, ...)."""
    return f"{kind}_{el['paragraph']}" if el.get('paragraph') else el['id']

def build_tss(tss, land_xy):
    """TSS block of the chart (lanes, zones, precautionary areas, inshore zones, free areas, IMO points, anchorages)
    and the raw xy polygons used by the leg check, from the declarative tss.json (docs/TSS-DATA.md)."""
    if not tss:
        return json.loads(json.dumps(EMPTY_TSS)), []
    P = resolve_points(tss)
    region = lambda ids: poly_xy([P[i] for i in ids])

    strips, zones_xy = {}, {}
    for z in tss.get('separationZones', []):
        strip = LineString(extend_xy([P[i] for i in z['centreline']])).buffer(z['halfWidthNm'], cap_style=2, join_style=2)
        strips[z['id']] = strip
        zones_xy[z['id']] = strip.intersection(region(z['region']))

    lanes, lanes_xy = [], {}
    for l in tss.get('lanes', []):
        g = region(l['region'])
        if l.get('separationZone'):
            g = pick_side(g.difference(strips[l['separationZone']]), l['side'])
        lanes_xy[l['id']] = g
        arr = l.get('arrows')
        arrow_list = clip_arrows(arrows(shift([P[i] for i in arr['along']], arr.get('offsetNorthNm', 0)), 'fwd', arr.get('perSegment', 3)), g) if arr else []
        lanes.append(dict({'id': l['id'], 'name': l['name'], 'flow': flow_letter(l['flowDeg']), 'rings': geom_to_latlon(g), 'arrows': arrow_list,
                           'flowDeg': l['flowDeg'], 'crossing': l.get('crossing', 'rightAngles')}, **alert_fields(l)))

    zones = [dict({'id': z['id'], 'name': z['name'], 'rings': geom_to_latlon(zones_xy[z['id']])}, **alert_fields(z)) for z in tss.get('separationZones', [])]
    prec_xy = {p['id']: region(p['region']) for p in tss.get('precautionary', [])}
    precautionary = [dict({'id': p['id'], 'name': p['name'], 'rings': geom_to_latlon(prec_xy[p['id']])}, **alert_fields(p)) for p in tss.get('precautionary', [])]

    def clipped(el):
        g = region(el['region'])
        return g.difference(land_xy) if el.get('clipToLand') else g
    itz = [dict({'id': z['id'], 'name': z['name'], 'rings': geom_to_latlon(clipped(z))}, **alert_fields(z)) for z in tss.get('inshoreZones', [])]
    free_area = [dict({'id': z['id'], 'name': z['name'], 'rings': geom_to_latlon(clipped(z))}, **alert_fields(z)) for z in tss.get('freeAreas', [])]
    anchorages = [{'id': a['id'], 'name': a['name'], 'lat': round(parse_coord(a['lat']), 5), 'lon': round(parse_coord(a['lon']), 5), 'radiusNm': a['radiusNm']}
                  for a in tss.get('anchorages', [])]
    points = {p['id']: [round(P[p['id']][0], 5), round(P[p['id']][1], 5)] for p in tss['points'] if p.get('role', 'imo') == 'imo'}

    out = {'lanes': lanes, 'zones': zones, 'precautionary': precautionary, 'itz': itz, 'free': free_area, 'points': points, 'anchorages': anchorages}
    by_label = lambda pairs: sorted(pairs, key=lambda t: t[0])  # zone_a, zone_b, lane_c ... as the LEG report always listed them
    check_polys = (by_label((report_label('zone', z), zones_xy[z['id']]) for z in tss.get('separationZones', []))
                   + by_label((report_label('lane', l), lanes_xy[l['id']]) for l in tss.get('lanes', []))
                   + by_label((report_label('prec', p), prec_xy[p['id']]) for p in tss.get('precautionary', [])))
    return out, check_polys

# --- Routes come from the passage JSON -------------------------------------------
def route_obj(rid, name, wps, recommended, summary, short=None):
    w = [{'lat': a, 'lon': b, 'id': i, 'name': n, 'note': note, 'radius': r} for a, b, i, n, note, r in wps]
    legs = []
    total = 0
    for i in range(len(wps) - 1):
        a, b = wps[i][:2], wps[i + 1][:2]
        d = dist_nm(a, b)
        total += d
        legs.append({'from': wps[i][2], 'to': wps[i + 1][2], 'dist': round(d, 2), 'brg': round(bearing(a, b))})
    return {'id': rid, 'short': short or rid, 'name': name, 'recommended': recommended, 'summary': summary, 'waypoints': w, 'legs': legs, 'total': round(total, 1)}

def build_routes(PZ):
    return [route_obj(r['id'], r['name'], [(w['lat'], w['lon'], w['id'], w['name'], w.get('note', ''), w.get('radius', 0.1)) for w in r['waypoints']], r.get('recommended', False), r.get('summary', ''), r.get('short')) for r in PZ['routes']]

# --- Verification: legs vs land and TSS polygons --------------------------------
def check_legs(routes, land_xy, check_polys):
    """Per leg: (route, from, to, distance to land nm, TSS polygons crossed, nearest land point)."""
    report = []
    for r in routes:
        wps = r['waypoints']
        for i in range(len(wps) - 1):
            a, b = wps[i], wps[i + 1]
            seg = LineString([to_xy((a['lat'], a['lon'])), to_xy((b['lat'], b['lon']))])
            d_land = seg.distance(land_xy)
            np_ = nearest_points(seg, land_xy)[1]
            near_ll = to_ll((np_.x, np_.y))
            crosses = []
            for nm, g in check_polys:
                if seg.intersects(g):
                    crosses.append(nm)
            report.append((r['id'], a['id'], b['id'], round(d_land, 2), crosses, (round(near_ll[0],4), round(near_ll[1],4))))
    return report

def bad_legs(report, harbour_ids):
    return [row for row in report if row[3] < 0.25 and not (row[1] in harbour_ids or row[2] in harbour_ids)]

# --- Aids to navigation from OSM ---------------------------------------------------
AID_TYPES = ('light_major', 'light_minor', 'beacon_lateral', 'buoy_lateral', 'buoy_cardinal', 'beacon_cardinal', 'buoy_special_purpose', 'beacon_special_purpose', 'buoy_safe_water', 'wreck', 'obstruction', 'rock', 'harbour')

def build_aids(H):
    aids = []
    for e in H['elements']:
        t = e.get('tags', {})
        st = t.get('seamark:type')
        if e['type'] != 'node' or not st:
            continue
        if st not in AID_TYPES:
            continue
        ch = t.get('seamark:light:character') or t.get('seamark:light:1:character')
        col = t.get('seamark:light:colour') or t.get('seamark:light:1:colour')
        per = t.get('seamark:light:period') or t.get('seamark:light:1:period')
        rng = t.get('seamark:light:range') or t.get('seamark:light:1:range')
        cat = t.get('seamark:buoy_cardinal:category') or t.get('seamark:beacon_cardinal:category') or t.get('seamark:buoy_lateral:category') or t.get('seamark:beacon_lateral:category')
        light = ''
        if ch:
            light = ch + (' ' + {'white': 'W', 'red': 'R', 'green': 'G', 'yellow': 'Y'}.get(col, col or '') if col else '') + (' ' + per + 's' if per else '') + (' ' + rng + 'M' if rng else '')
        aids.append({'lat': round(e['lat'], 5), 'lon': round(e['lon'], 5), 'type': st, 'name': t.get('seamark:name') or t.get('name') or '', 'light': light.strip(), 'cat': cat or ''})
    return aids

def build_anchorages(H):
    anchorages = []
    for e in H['elements']:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('seamark:type') == 'anchorage' and e.get('geometry') and len(e['geometry']) > 3:
            anchorages.append({'name': t.get('seamark:name') or t.get('name') or 'Anchorage', 'ring': [[round(p['lat'], 5), round(p['lon'], 5)] for p in e['geometry']]})
    return anchorages

# Breakwaters / piers as lines (for harbour detail)
def build_structures(H):
    structures = []
    for e in H['elements']:
        t = e.get('tags', {})
        if e['type'] == 'way' and (t.get('seamark:type') == 'breakwater' or t.get('man_made') in ('breakwater', 'pier')) and e.get('geometry'):
            structures.append([[round(p['lat'], 5), round(p['lon'], 5)] for p in e['geometry']])
    return structures

def rings_from_mp(mp):
    out = []
    for poly in mp.geoms:
        out.append([[round(c[1], 5), round(c[0], 5)] for c in poly.exterior.coords])
    return out

LEGACY_DETAIL_KEYS = ('soto', 'tang')

def load_detail(scratch, PZ):
    """Harbour detail land: land_<key>.json for each passage place (written by fetch_osm.py);
    falls back to the legacy land_soto.json / land_tang.json names when no per-place file exists."""
    keys = [k for k in PZ.get('places', {}) if os.path.exists(os.path.join(scratch, f'land_{k}.json'))]
    if not keys:
        keys = list(LEGACY_DETAIL_KEYS)
    detail = {}
    for key in keys:
        g = shape(json.load(open(os.path.join(scratch, f'land_{key}.json'))))
        if g.geom_type == 'Polygon':
            g = MultiPolygon([g])
        detail[key] = rings_from_mp(g)
    return detail

def build(scratch, PZ, tss=None):
    """Build the chart and passage objects from the passage dict and the (already loaded) tss dict, or None.
    Returns (chart, passage_out, report)."""
    land, land_xy = load_land(scratch)
    tss, check_polys = build_tss(tss, land_xy)
    routes = build_routes(PZ)
    report = check_legs(routes, land_xy, check_polys)
    H = json.load(open(os.path.join(scratch, 'harbours.json')))
    chart = {
        'meta': {
            'built': 'chart built by tools/build_chart.py',
            'sources': ['OpenStreetMap contributors (ODbL) - coastline, breakwaters, seamarks',
                        'IMO COLREG.2/Circ.66 Annex 1 (2014) - TSS In the Strait of Gibraltar, in force 1 June 2015',
                        'Puerto Sotogrande safety notice 20 Feb 2026 - Guadiaro shoal'],
            'bbox': PZ.get('bbox', [35.65, -6.2, 36.45, -5.05]),
            'passage': PZ['id'],
        },
        'land': rings_from_mp(land),
        'landDetail': load_detail(scratch, PZ),
        'structures': build_structures(H),
        'tss': tss,
        'anchorages': build_anchorages(H),
        'aids': build_aids(H),
    }
    passage_out = dict(PZ)
    passage_out['routes'] = routes
    passage_out['labels'] = PZ.get('labels', [])
    return chart, passage_out, report

def render_chart_js(chart):
    return 'window.CHART = ' + json.dumps(chart, separators=(',', ':')) + ';\n'

def render_passage_js(passage_out):
    return 'window.PASSAGE = ' + json.dumps(passage_out, separators=(',', ':'), ensure_ascii=False) + ';\n'

def write_outputs(chart, passage_out, out, passage_out_path):
    js = render_chart_js(chart)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'w').write(js)
    pjs = render_passage_js(passage_out)
    open(passage_out_path, 'w', encoding='utf-8').write(pjs)
    return js, pjs

def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    scratch = argv[0] if len(argv) > 0 else '.'
    out = argv[1] if len(argv) > 1 else 'site/chart-data.js'
    passage_file = argv[2] if len(argv) > 2 else DEFAULT_PASSAGE
    passage_out_path = os.path.join(os.path.dirname(out), 'passage.js')
    reports = validate_passage.validate_files(passage_file)
    for rep in reports:
        for line in rep.lines():
            print(line)
    if any(rep.errors for rep in reports):
        print('build_chart: passage data invalid, nothing built (see tools/validate_passage.py)', file=sys.stderr)
        return 1
    PZ = json.load(open(passage_file, encoding='utf-8'))
    tss = load_tss(passage_file, PZ)

    chart, passage_out, report = build(scratch, PZ, tss)
    for row in report:
        print('LEG', row)
    harbour_ids = set(PZ.get('harbourWaypoints', ['SOTO', 'SOTO-HEAD', 'MAR-APP', 'TANJA', 'TANG-F', 'TANG-E']))
    bad = bad_legs(report, harbour_ids)
    if bad:
        print('WARNING: legs closer than 0.25 nm to land:', bad)

    js, pjs = write_outputs(chart, passage_out, out, passage_out_path)
    routes = passage_out['routes']
    print('wrote', out, len(js), 'bytes;', 'aids', len(chart['aids']), 'anchorages', len(chart['anchorages']), 'structures', len(chart['structures']))
    print('wrote', passage_out_path, len(pjs.encode()), 'bytes; routes', [r['id'] for r in routes], 'hazards', len(PZ['hazards']), 'cards', len(PZ.get('cards', [])))
    for r in routes:
        print(r['id'], 'total nm', r['total'], [(l['from'], l['to'], l['dist'], l['brg']) for l in r['legs']])
    return 0

if __name__ == '__main__':
    sys.exit(main())
