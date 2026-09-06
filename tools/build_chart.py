#!/usr/bin/env python3
"""Build site/chart-data.js: offline vector chart for the Sotogrande -> Tangier crossing.

Sources
- Land: OpenStreetMap coastline (ODbL), fetched via Overpass, polygonised with the OSM left-hand rule.
- TSS: IMO COLREG.2/Circ.66 (adopted 21 Nov 2014, in force 1 June 2015), Annex 1,
  "In the Strait of Gibraltar", reference chart IHM 445, WGS84. Coordinates copied verbatim.
- Aids to navigation: OpenStreetMap seamark tags (ODbL).
- Sotogrande shoal: Puerto Sotogrande safety notice, 20 Feb 2026.
"""
import json, math, sys, os
from shapely.geometry import shape, Polygon, MultiPolygon, LineString, Point, mapping, box
from shapely.ops import unary_union

SCRATCH = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'site/chart-data.js'

def dm(d, m):
    return d + m / 60.0

# --- IMO COLREG.2/Circ.66 Annex 1 points (lat, lon), west longitude negative
P = {
    1: (dm(35, 59.01), -dm(5, 25.68)),
    2: (dm(35, 58.36), -dm(5, 28.19)),
    3: (dm(35, 56.70), -dm(5, 34.71)),
    4: (dm(35, 56.21), -dm(5, 36.48)),
    5: (dm(35, 56.21), -dm(5, 44.98)),
    6: (dm(36, 2.80), -dm(5, 19.68)),
    7: (dm(36, 1.21), -dm(5, 25.68)),
    8: (dm(36, 0.35), -dm(5, 28.98)),
    9: (dm(35, 58.68), -dm(5, 35.44)),
    10: (dm(35, 58.41), -dm(5, 36.48)),
    11: (dm(35, 58.41), -dm(5, 44.98)),
    12: (dm(35, 52.51), -dm(5, 44.98)),
    13: (dm(35, 53.81), -dm(5, 36.48)),
    14: (dm(35, 54.55), -dm(5, 33.90)),
    15: (dm(35, 56.35), -dm(5, 27.40)),
    16: (dm(35, 56.84), -dm(5, 25.68)),
    17: (dm(35, 58.78), -dm(5, 18.55)),
    18: (dm(35, 54.45), -dm(5, 25.68)),
    19: (dm(35, 54.88), -dm(5, 27.40)),
    20: (dm(35, 52.87), -dm(5, 36.70)),
    21: (dm(35, 52.06), -dm(5, 36.30)),
    22: (dm(35, 51.10), -dm(5, 36.20)),
    23: (dm(35, 52.18), -dm(5, 34.00)),
    24: (dm(35, 51.20), -dm(5, 32.40)),
    25: (dm(35, 49.09), -dm(5, 44.98)),
}
ANCH_ALPHA = (dm(35, 51.05), -dm(5, 40.34), 0.4)  # lat, lon, radius nm

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

# Regions holding the lanes and zones
region_east = poly_xy([P[7], P[8], P[15], P[16]])
region_west = poly_xy([P[9], P[10], P[11], P[12], P[13], P[14]])

def extend_xy(pts, d=3.0):
    xy = [to_xy(p) for p in pts]
    def ext(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        return (b[0] + dx / n * d, b[1] + dy / n * d)
    return [ext(xy[1], xy[0])] + xy + [ext(xy[-2], xy[-1])]

strip_a = LineString(extend_xy([P[1], P[2]])).buffer(0.25, cap_style=2)
strip_b = LineString(extend_xy([P[3], P[4], P[5]])).buffer(0.25, cap_style=2, join_style=2)
zone_a = strip_a.intersection(region_east)
zone_b = strip_b.intersection(region_west)

def split_lanes(region, strip):
    rest = region.difference(strip)
    parts = list(rest.geoms) if rest.geom_type == 'MultiPolygon' else [rest]
    parts = sorted(parts, key=lambda p: p.centroid.y, reverse=True)
    assert len(parts) == 2, len(parts)
    return parts[0], parts[1]  # north (westbound), south (eastbound)

lane_c, lane_f = split_lanes(region_east, strip_a)
lane_d, lane_e = split_lanes(region_west, strip_b)

prec_g = poly_xy([P[6], P[7], P[16], P[17]])
prec_h = poly_xy([P[8], P[9], P[14], P[15]])

# Land
land = shape(json.load(open(os.path.join(SCRATCH, 'land_osm.json'))))
land_xy = unary_union([Polygon([to_xy((c[1], c[0])) for c in poly.exterior.coords]) for poly in land.geoms])

itz_north = poly_xy([P[7], P[8], P[9], P[10], P[11], (36.12, P[11][1]), (36.12, P[7][1])]).difference(land_xy)
itz_se = poly_xy([P[16], P[15], P[19], P[18]])
itz_sw = poly_xy([P[12], P[13], P[14], P[20], P[21], P[22], P[23], P[24], (35.78, P[24][1]), (35.78, P[12][1]), P[25]]).difference(land_xy)
free_tm = poly_xy([P[15], P[14], P[20], P[21], P[22], P[23], P[24], (35.78, P[24][1]), (35.78, P[19][1]), P[19]]).difference(land_xy)

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

lanes = [
    {'id': 'west_wb', 'name': 'Westbound lane (west)', 'flow': 'W', 'rings': geom_to_latlon(lane_d),
     'arrows': arrows(shift([P[3], P[4], P[5]], 1.2), 'fwd')},
    {'id': 'west_eb', 'name': 'Eastbound lane (west)', 'flow': 'E', 'rings': geom_to_latlon(lane_e),
     'arrows': arrows(shift([P[5], P[4], P[3]], -1.3), 'fwd')},
    {'id': 'east_wb', 'name': 'Westbound lane (east)', 'flow': 'W', 'rings': geom_to_latlon(lane_c),
     'arrows': arrows(shift([P[1], P[2]], 1.1), 'fwd', 4)},
    {'id': 'east_eb', 'name': 'Eastbound lane (east)', 'flow': 'E', 'rings': geom_to_latlon(lane_f),
     'arrows': arrows(shift([P[2], P[1]], -1.0), 'fwd', 4)},
]
zones = [
    {'id': 'zone_b', 'name': 'Separation zone (west)', 'rings': geom_to_latlon(zone_b)},
    {'id': 'zone_a', 'name': 'Separation zone (east)', 'rings': geom_to_latlon(zone_a)},
]
precautionary = [
    {'id': 'prec_east', 'name': 'Precautionary area (east, Gibraltar-Ceuta)', 'rings': geom_to_latlon(prec_g)},
    {'id': 'prec_tm', 'name': 'Precautionary area Tanger-Med', 'rings': geom_to_latlon(prec_h)},
]
itz = [
    {'id': 'itz_n', 'name': 'Northern inshore traffic zone (Spain)', 'rings': geom_to_latlon(itz_north)},
    {'id': 'itz_se', 'name': 'South-eastern inshore traffic zone', 'rings': geom_to_latlon(itz_se)},
    {'id': 'itz_sw', 'name': 'South-western inshore traffic zone (Morocco)', 'rings': geom_to_latlon(itz_sw)},
]
free_area = [{'id': 'free_tm', 'name': 'Free navigation area off Tanger-Med (port approaches, ferries)', 'rings': geom_to_latlon(free_tm)}]

# --- Routes -------------------------------------------------------------------
# (lat, lon, id, name, note, arrival radius nm)
ROUTE_TARIFA = [
    (36.2869, -5.2701, 'SOTO', 'Sotogrande marina entrance', 'Entrance opens SW between the hooked east breakwater and the short mole. Speed 3 kn inside. VHF 9.', 0.05),
    (36.2855, -5.2713, 'SOTO-APP', 'Sotogrande approach', 'Turn here. Shoal reported Feb 2026 at 36 16.890N 5 16.276W, 0.25 nm S of the entrance: keep it to starboard, leave heading ESE.', 0.08),
    (36.2825, -5.2630, 'SOTO-OUT', 'Sotogrande offing', 'Clear of the Guadiaro bar and the shoal. Set course for Gibraltar east side.', 0.15),
    (36.1250, -5.3250, 'GIB-E', 'Gibraltar east side', 'Anchored ships in the eastern anchorage. Pass east of them. Keep 0.7 nm off the Rock.', 0.2),
    (36.0980, -5.3450, 'EUROPA', 'Europa Point offing', 'Rounding Europa Point 0.7 nm off. Precautionary area begins 3 nm south: heavy ship traffic converging on Algeciras / Ceuta / Tanger-Med. Stay in the northern inshore zone.', 0.2),
    (36.0520, -5.4380, 'CARNERO', 'Punta Carnero offing', 'Algeciras Bay entrance: ships entering and leaving the bay cross your track. Inshore zone north of the westbound lane.', 0.2),
    (35.9845, -5.6130, 'TARIFA', 'Tarifa Island offing', 'Narrow corridor: island 0.7 nm N, westbound lane 0.7 nm S. Overfalls and tide race, worst with wind against tide. Ferries Tarifa-Tangier cross here.', 0.2),
    (35.9800, -5.7000, 'X-NORTH', 'Crossing point north', 'Turn to 180 T. Cross the TSS at right angles. First the WESTBOUND lane: ships come from your LEFT (east).', 0.15),
    (35.8740, -5.7000, 'X-SOUTH', 'Crossing point south', 'Clear of the eastbound lane (ships came from your RIGHT). Now in the Moroccan inshore zone. Anchorage Alpha 1.4 nm E.', 0.15),
    (35.8330, -5.7620, 'MALABATA', 'Cap Malabata offing', 'Cap Malabata light 1 nm SE. Tangier Bay opens ahead. Ferries from Tarifa enter the port fast from the N/NE.', 0.2),
    (35.7900, -5.7800, 'TANG-APP', 'Tangier Bay approach', 'Call Tanja Marina Bay on VHF 9 (fallback 16) before entering. Outer breakwater head light Fl W 12s to your right.', 0.15),
    (35.7828, -5.7930, 'MAR-APP', 'Marina approach', 'Marina entrance opens SOUTH. Approach from the E/SE, do NOT cut across the beach shallows to the south. Red mole Fl R to port, green breakwater tip Fl G to starboard.', 0.06),
    (35.7836, -5.7956, 'TANJA', 'Tanja Marina Bay entrance', 'Enter heading N. Reception / customs pontoon: follow marina staff. Q flag up, Moroccan courtesy flag.', 0.04),
]

ROUTE_EAST = [
    ROUTE_TARIFA[0], ROUTE_TARIFA[1], ROUTE_TARIFA[2], ROUTE_TARIFA[3], ROUTE_TARIFA[4],
    (35.9420, -5.4250, 'G-SOUTH', 'South edge of precautionary area', 'Crossed the eastern precautionary area (no lanes, but converging ships). Enter the south-eastern inshore zone just S of point 16.', 0.2),
    (35.9250, -5.4600, 'CIRES', 'Punta Cires offing', 'Leaving the SE inshore zone into the Tanger-Med free area. Ferries and container ships turning into Tanger-Med ahead.', 0.2),
    (35.9000, -5.5450, 'TMED-OFF', 'Off Tanger-Med', 'Passing 1 nm N of Tanger-Med breakwaters. Keep clear of ships manoeuvring. Enter the SW inshore zone.', 0.2),
    (35.8600, -5.6500, 'KSAR', 'Off Ksar es-Seghir', 'SW inshore zone. Anchorage Alpha (ships) 1 nm SW: pass N of it.', 0.2),
    ROUTE_TARIFA[9], ROUTE_TARIFA[10], ROUTE_TARIFA[11], ROUTE_TARIFA[12],
]

def route_obj(rid, name, wps, recommended, summary):
    w = [{'lat': a, 'lon': b, 'id': i, 'name': n, 'note': note, 'radius': r} for a, b, i, n, note, r in wps]
    legs = []
    total = 0
    for i in range(len(wps) - 1):
        a, b = wps[i][:2], wps[i + 1][:2]
        d = dist_nm(a, b)
        total += d
        legs.append({'from': wps[i][2], 'to': wps[i + 1][2], 'dist': round(d, 2), 'brg': round(bearing(a, b))})
    return {'id': rid, 'name': name, 'recommended': recommended, 'summary': summary, 'waypoints': w, 'legs': legs, 'total': round(total, 1)}

routes = [
    route_obj('tarifa', 'Recommended: Spanish inshore zone, right-angle crossing at 5 42W, Moroccan inshore zone', ROUTE_TARIFA, True,
              'Follow the Spanish coast inside the northern inshore traffic zone to Tarifa, cross both lanes on 180 T (COLREG rule 10c), then follow the Moroccan coast to Tangier.'),
    route_obj('east', 'Alternative: east crossing via the Gibraltar-Ceuta precautionary area, past Tanger-Med', ROUTE_EAST, False,
              'Shorter but passes through the busiest converging traffic and the Tanger-Med port approaches. Use only if the Tarifa side is untenable (strong Levante).'),
]

# --- Verification: legs vs land and TSS polygons --------------------------------
report = []
for r in routes:
    wps = r['waypoints']
    for i in range(len(wps) - 1):
        a, b = wps[i], wps[i + 1]
        seg = LineString([to_xy((a['lat'], a['lon'])), to_xy((b['lat'], b['lon']))])
        d_land = seg.distance(land_xy)
        from shapely.ops import nearest_points
        np_ = nearest_points(seg, land_xy)[1]
        near_ll = to_ll((np_.x, np_.y))
        crosses = []
        for nm, g in [('zone_a', zone_a), ('zone_b', zone_b), ('lane_c', lane_c), ('lane_d', lane_d), ('lane_e', lane_e), ('lane_f', lane_f), ('prec_g', prec_g), ('prec_h', prec_h)]:
            if seg.intersects(g):
                crosses.append(nm)
        report.append((r['id'], a['id'], b['id'], round(d_land, 2), crosses, (round(near_ll[0],4), round(near_ll[1],4))))
for row in report:
    print('LEG', row)
bad = [row for row in report if row[3] < 0.25 and not (row[1].startswith('SOTO') or row[1].startswith('MAR') or row[2].startswith('SOTO') or row[2] in ('MAR-APP', 'TANJA'))]
if bad:
    print('WARNING: legs closer than 0.25 nm to land:', bad)

# --- Aids to navigation from OSM ---------------------------------------------------
H = json.load(open(os.path.join(SCRATCH, 'harbours.json')))
aids = []
for e in H['elements']:
    t = e.get('tags', {})
    st = t.get('seamark:type')
    if e['type'] != 'node' or not st:
        continue
    if st not in ('light_major', 'light_minor', 'beacon_lateral', 'buoy_lateral', 'buoy_cardinal', 'beacon_cardinal', 'buoy_special_purpose', 'beacon_special_purpose', 'buoy_safe_water', 'wreck', 'obstruction', 'rock', 'harbour'):
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

anchorages = []
for e in H['elements']:
    t = e.get('tags', {})
    if e['type'] == 'way' and t.get('seamark:type') == 'anchorage' and e.get('geometry') and len(e['geometry']) > 3:
        anchorages.append({'name': t.get('seamark:name') or t.get('name') or 'Anchorage', 'ring': [[round(p['lat'], 5), round(p['lon'], 5)] for p in e['geometry']]})

hazards = [
    {'id': 'soto_shoal', 'lat': 36.2815, 'lon': -5.27127, 'radius': 0.12, 'level': 'danger',
     'name': 'Shoal at Guadiaro mouth (marina notice 20 Feb 2026)',
     'note': 'Puerto Sotogrande reports a dangerous reduction of depth at 36 16.890N 5 16.276W. Keep well clear; approach/leave the marina from the E/SE.'},
    {'id': 'tarifa_race', 'lat': 35.9985, 'lon': -5.6100, 'radius': 1.2, 'level': 'caution',
     'name': 'Tarifa overfalls / tide race',
     'note': 'Steep breaking seas off Tarifa Island with wind against tide; strongest wind acceleration in the strait.'},
    {'id': 'anch_alpha', 'lat': ANCH_ALPHA[0], 'lon': ANCH_ALPHA[1], 'radius': ANCH_ALPHA[2], 'level': 'caution',
     'name': 'Anchorage Alpha (Tanger-Med ships)', 'note': 'Ships at anchor, 0.4 nm radius (IMO). Pass north of it.'},
    {'id': 'tang_beach', 'lat': 35.7805, 'lon': -5.7930, 'radius': 0.25, 'level': 'danger',
     'name': 'Tangier beach shallows', 'note': 'Shoal water S/SE of the marina. Approach the marina entrance from the E/SE only.'},
    {'id': 'tang_ferry', 'lat': 35.7900, 'lon': -5.7900, 'radius': 0.5, 'level': 'caution',
     'name': 'Tangier port entrance: fast ferries', 'note': 'FRS / Intershipping fast ferries to Tarifa enter and leave at speed. Keep out of the fairway, give way.'},
    {'id': 'tmed_port', 'lat': 35.8880, 'lon': -5.5000, 'radius': 1.5, 'level': 'caution',
     'name': 'Tanger-Med port approaches', 'note': 'Container ships and ferries manoeuvring; port control on VHF 12/16.'},
    {'id': 'gib_anch', 'lat': 36.1350, 'lon': -5.3200, 'radius': 0.9, 'level': 'info',
     'name': 'Gibraltar eastern anchorage', 'note': 'Large ships at anchor east of the Rock. Pass between them with care; bunkering barges alongside.'},
]

places = {
    'sotogrande': {'name': 'Puerto Sotogrande', 'lat': 36.2869, 'lon': -5.2701, 'vhf': '9', 'phone': '+34 956 790 000', 'tz': 'Europe/Madrid'},
    'tangier': {'name': 'Tanja Marina Bay (Tanger Ville)', 'lat': 35.7836, 'lon': -5.7956, 'vhf': '9 / 16', 'phone': '', 'tz': 'Africa/Casablanca'},
}

def rings_from_mp(mp):
    out = []
    for poly in mp.geoms:
        out.append([[round(c[1], 5), round(c[0], 5)] for c in poly.exterior.coords])
    return out

land_rings = rings_from_mp(land)
detail = {}
for key in ('soto', 'tang'):
    g = shape(json.load(open(os.path.join(SCRATCH, f'land_{key}.json'))))
    if g.geom_type == 'Polygon':
        g = MultiPolygon([g])
    detail[key] = rings_from_mp(g)

# Breakwaters / piers as lines (for harbour detail)
structures = []
for e in H['elements']:
    t = e.get('tags', {})
    if e['type'] == 'way' and (t.get('seamark:type') == 'breakwater' or t.get('man_made') in ('breakwater', 'pier')) and e.get('geometry'):
        structures.append([[round(p['lat'], 5), round(p['lon'], 5)] for p in e['geometry']])

chart = {
    'meta': {
        'built': 'chart built by tools/build_chart.py',
        'sources': ['OpenStreetMap contributors (ODbL) - coastline, breakwaters, seamarks',
                    'IMO COLREG.2/Circ.66 Annex 1 (2014) - TSS In the Strait of Gibraltar, in force 1 June 2015',
                    'Puerto Sotogrande safety notice 20 Feb 2026 - Guadiaro shoal'],
        'bbox': [35.65, -6.2, 36.45, -5.05],
    },
    'land': land_rings,
    'landDetail': detail,
    'structures': structures,
    'tss': {'lanes': lanes, 'zones': zones, 'precautionary': precautionary, 'itz': itz, 'free': free_area,
            'points': {str(k): [round(v[0], 5), round(v[1], 5)] for k, v in P.items()}},
    'anchorages': anchorages,
    'aids': aids,
    'hazards': hazards,
    'routes': routes,
    'places': places,
}
js = 'window.CHART = ' + json.dumps(chart, separators=(',', ':')) + ';\n'
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write(js)
print('wrote', OUT, len(js), 'bytes;', 'aids', len(aids), 'anchorages', len(anchorages), 'structures', len(structures))
for r in routes:
    print(r['id'], 'total nm', r['total'], [(l['from'], l['to'], l['dist'], l['brg']) for l in r['legs']])
