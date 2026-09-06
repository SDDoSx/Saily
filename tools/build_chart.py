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

def clip_arrows(arr, poly):
    return [a for a in arr if poly.contains(Point(to_xy((a[0], a[1]))))]

lanes = [
    {'id': 'west_wb', 'name': 'Westbound lane (west)', 'flow': 'W', 'rings': geom_to_latlon(lane_d),
     'arrows': clip_arrows(arrows(shift([P[3], P[4], P[5]], 1.2), 'fwd', 4), lane_d)},
    {'id': 'west_eb', 'name': 'Eastbound lane (west)', 'flow': 'E', 'rings': geom_to_latlon(lane_e),
     'arrows': clip_arrows(arrows(shift([P[5], P[4], P[3]], -1.3), 'fwd', 4), lane_e)},
    {'id': 'east_wb', 'name': 'Westbound lane (east)', 'flow': 'W', 'rings': geom_to_latlon(lane_c),
     'arrows': clip_arrows(arrows(shift([P[1], P[2]], 1.1), 'fwd', 4), lane_c)},
    {'id': 'east_eb', 'name': 'Eastbound lane (east)', 'flow': 'E', 'rings': geom_to_latlon(lane_f),
     'arrows': clip_arrows(arrows(shift([P[2], P[1]], -1.0), 'fwd', 4), lane_f)},
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
    (36.2882, -5.2703, 'SOTO', 'Sotogrande inner mouth', 'Inner harbour mouth, 80 m wide, opens S. 3 kn limit. VHF 9. Head S down the channel between the breakwater (E) and the beach (W).', 0.03),
    (36.2856, -5.2710, 'SOTO-HEAD', 'Sotogrande breakwater head', 'Green light on the head 100 m to your east. Round it to port and turn ESE immediately: reported shoal 36 16.890N 5 16.276W lies 0.25 nm due S of here. Do not head S or SW.', 0.04),
    (36.2825, -5.2630, 'SOTO-OUT', 'Sotogrande offing', 'Clear of the Guadiaro bar and the shoal. Set course for the east side of Gibraltar.', 0.15),
    (36.1250, -5.3250, 'GIB-E', 'Gibraltar east side', 'Anchored ships in the eastern anchorage. Pass east of them. Keep 0.7 nm off the Rock.', 0.2),
    (36.0980, -5.3450, 'EUROPA', 'Europa Point offing', 'Rounding Europa Point 0.7 nm off; small race off the point. Precautionary area begins 3 nm S: ship traffic converging on Algeciras, Ceuta and Tanger-Med. Stay in the northern inshore zone.', 0.2),
    (36.0400, -5.4400, 'CARNERO', 'Punta Carnero offing', 'Algeciras Bay entrance: ships cross your track. Strong NW-NE tidal set along the Carnero shore; La Perla rocks (4.7 m, race close E of them) 1.2 nm S of the point are 0.5 nm N of this leg: hold the offing.', 0.2),
    (35.9845, -5.6130, 'TARIFA', 'Tarifa Island offing', 'Narrow corridor: island 0.8 nm N, westbound lane 0.7 nm S. Overfalls and race off the island, worst with wind against tide. Tarifa-Tangier ferries cross here.', 0.2),
    (35.9800, -5.7000, 'X-NORTH', 'Crossing point north', 'Turn to 180 T. Cross the TSS at right angles, do not slow down. First the WESTBOUND lane: ships come from your LEFT (east).', 0.15),
    (35.8740, -5.7000, 'X-SOUTH', 'Crossing point south', 'Clear of the eastbound lane. Now in the Moroccan inshore zone. Anchorage Alpha 1.4 nm E. Banco de Fenix (15 m) lies on this leg: overfalls at max stream, slow down if the sea steepens.', 0.15),
    (35.8350, -5.7650, 'MALABATA', 'Cap Malabata offing', 'Cap Malabata light 1.1 nm SE; Almirante Rock (6.3 m, breaks) 0.9 nm SE. Tangier Bay opens ahead. Ferries from Tarifa come down from the N at 30 kn.', 0.2),
    (35.8020, -5.7870, 'TANG-N', 'Tangier port approach (ferry line)', 'Call Tanja Marina Bay on VHF 11 now. Jetty head light Fl(3) 12s 0.7 nm SSW. Stay on the deep-water ferry line; charted wreck (buoyed) and Buoree Rock (0.9 m) lie E of it. Buoys may be missing.', 0.15),
    (35.7880, -5.7845, 'TANG-E', 'Marina access channel, point E', 'Start of the marked TMBI access channel (12 m), beside the ferry turning area. Follow it SW towards the marina entrance. Ferries turn here: keep clear.', 0.08),
    (35.7836, -5.7925, 'TANG-F', 'Channel point F, off entrance', 'Green Jetee Est head 200 m to the W. Continue SW to the point S of the gap; do NOT turn W here, the jetty is in the way.', 0.05),
    (35.7824, -5.7955, 'MAR-APP', 'South of marina entrance', 'Turn N. Entrance gap 120 m ahead: red Fl(3)R (C12) to port, green Fl(3)G to starboard. Shoal 0.9-2 m to your W/SW along the beach: do not drift west.', 0.04),
    (35.7841, -5.7957, 'TANJA', 'Tanja Marina Bay entrance', 'Inside the gap heading N. Fuel dock to starboard, reception pontoon beyond it (high wall, fenders high). Q flag and Moroccan flag up. Marineros take lines.', 0.03),
]

def wp(id_):
    return next(w for w in ROUTE_TARIFA if w[2] == id_)

ROUTE_EAST = [
    wp('SOTO'), wp('SOTO-HEAD'), wp('SOTO-OUT'), wp('GIB-E'), wp('EUROPA'),
    (35.9420, -5.4250, 'G-SOUTH', 'South edge of precautionary area', 'Crossed the eastern precautionary area (no lanes, but converging ships). Enter the south-eastern inshore zone just S of point 16.', 0.2),
    (35.9250, -5.4600, 'CIRES', 'Punta Cires offing', 'Small race off Punta Cires. Leaving the SE inshore zone into the Tanger-Med free area. Ferries and container ships turning into Tanger-Med ahead.', 0.2),
    (35.9000, -5.5450, 'TMED-OFF', 'Off Tanger-Med', 'Passing 1 nm N of Tanger-Med breakwaters. Keep clear of ships manoeuvring. Enter the SW inshore zone.', 0.2),
    (35.8680, -5.6500, 'KSAR', 'Off Ksar es-Seghir', 'SW inshore zone. Anchorage Alpha (ships at anchor) 1.3 nm SW: this leg passes 0.6 nm N of it.', 0.2),
    wp('MALABATA'), wp('TANG-N'), wp('TANG-E'), wp('TANG-F'), wp('MAR-APP'), wp('TANJA'),
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
# hazard crossings per leg (info)

bad = [row for row in report if row[3] < 0.25 and not (row[1].startswith('SOTO') or row[1].startswith('MAR') or row[1].startswith('TANG-') or row[2].startswith('SOTO') or row[2] in ('MAR-APP', 'TANJA', 'TANG-F', 'TANG-E'))]
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
     'note': 'Puerto Sotogrande reports a dangerous reduction of depth at 36 16.890N 5 16.276W, 500 m S of the breakwater head. Keep well clear; leave and approach from the E/SE.'},
    {'id': 'la_perla', 'lat': 36.057, 'lon': -5.4262, 'radius': 0.3, 'level': 'caution',
     'name': 'La Perla rocks (4.7 m) and Las Bajas', 'note': 'Pinnacle rocks 1.2 nm S of Punta Carnero light, race close E of them; strong NW-NE tidal set along the Carnero shore (Pub 131). Position derived from the pilot, approximate.'},
    {'id': 'tarifa_race', 'lat': 35.9985, 'lon': -5.6100, 'radius': 1.0, 'level': 'caution',
     'name': 'Tarifa overfalls / tide race',
     'note': 'Steep breaking seas off Tarifa Island with wind against tide; strongest wind acceleration in the strait.'},
    {'id': 'cabezos', 'lat': 36.017, 'lon': -5.70, 'radius': 0.8, 'level': 'caution',
     'name': 'Bajo de los Cabezos race', 'note': 'Race of considerable violence at max stream; in heavy weather it can extend across the strait (Pub 131). Off route, 2 nm N of X-NORTH.'},
    {'id': 'anch_alpha', 'lat': ANCH_ALPHA[0], 'lon': ANCH_ALPHA[1], 'radius': ANCH_ALPHA[2], 'level': 'caution',
     'name': 'Anchorage Alpha (Tanger-Med ships)', 'note': 'Ships at anchor, 0.4 nm radius (IMO). Pass north of it.'},
    {'id': 'fenix', 'lat': 35.867, 'lon': -5.717, 'radius': 0.6, 'level': 'caution',
     'name': 'Banco de Fenix (15 m): race area', 'note': 'Rocky bank 3 nm NNE of Malabata. No grounding risk, but the most violent races on the Moroccan side at max stream, worse with wind against stream (Pub 131). Position approximate.'},
    {'id': 'almirante', 'lat': 35.825, 'lon': -5.7486, 'radius': 0.3, 'level': 'caution',
     'name': 'Almirante Rock (6.3 m)', 'note': '0.5 nm N of Cap Malabata, breaks in heavy seas, marked by a lit buoy (may be off station). Keep 1 nm off Malabata.'},
    {'id': 'sevil', 'lat': 35.800, 'lon': -5.755, 'radius': 0.3, 'level': 'caution',
     'name': 'Sevil du Burj shoal (3.6 m)', 'note': 'East part of Tangier Bay, 1 nm SSW of Malabata; Gandouri shoal (5.5 m) 0.7 nm SW of it. Positions approximate (Pub 131).'},
    {'id': 'buoree', 'lat': 35.791, 'lon': -5.773, 'radius': 0.3, 'level': 'danger',
     'name': 'Buoree Rock (0.9 m)', 'note': 'About 1 nm E of the main jetty head, marked by a lit buoy. Position approximate (Pub 131): stay on the ferry line N of the jetty head, do not cross the bay directly to the marina.'},
    {'id': 'tang_wreck', 'lat': 35.7945, 'lon': -5.7838, 'radius': 0.15, 'level': 'caution',
     'name': 'Charted wreck ENE of jetty head', 'note': 'Dangerous wreck about 0.5 nm ENE of the main jetty head, marked by a lit buoy (Pub 131, position approximate). Keep a lookout for the buoy.'},
    {'id': 'tang_ferry', 'lat': 35.7912, 'lon': -5.7933, 'radius': 0.35, 'level': 'caution',
     'name': 'Tangier port entrance: fast ferries', 'note': 'FRS / Intershipping fast ferries to Tarifa and cruise ships enter and leave here. Keep out of their way, keep to the marina side.'},
    {'id': 'tang_shoal_w', 'lat': 35.7828, 'lon': -5.7978, 'radius': 0.07, 'level': 'danger',
     'name': 'Shoal SW of the red head', 'note': 'Shoal water 0.9-2 m immediately S and SW of the Jetee Ouest head (C12) along the beach (TMBI chart). Approach the gap from the S/SE only.'},
    {'id': 'tang_beach', 'lat': 35.7795, 'lon': -5.7900, 'radius': 0.2, 'level': 'danger',
     'name': 'Tangier beach shallows', 'note': 'Shoal water along the beach S of the marina. Stay in the marked channel.'},
    {'id': 'tmed_port', 'lat': 35.8880, 'lon': -5.5000, 'radius': 1.5, 'level': 'caution',
     'name': 'Tanger-Med port approaches', 'note': 'Container ships and ferries manoeuvring; port control on VHF 12/16.'},
    {'id': 'gib_anch', 'lat': 36.1400, 'lon': -5.3220, 'radius': 0.7, 'level': 'info',
     'name': 'Gibraltar eastern anchorage', 'note': 'Ships at anchor around you east of the Rock: pass between them, watch for bunker barges alongside and anchor chains ahead of their bows.'},
]

places = {
    'sotogrande': {'name': 'Puerto Sotogrande', 'lat': 36.2882, 'lon': -5.2703, 'vhf': '9', 'phone': '+34 956 790 000', 'tz': 'Europe/Madrid'},
    'tangier': {'name': 'Tanja Marina Bay (Tanger Ville)', 'lat': 35.7836, 'lon': -5.7956, 'vhf': '11 / 16', 'phone': '+212 539 372 424', 'tz': 'Africa/Casablanca'},
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

labels = [
    (35.95, -5.62, 'STRAIT OF GIBRALTAR', 'sea', 8), (36.288, -5.284, 'Sotogrande', 'town', 10), (36.14, -5.353, 'Gibraltar', 'town', 10),
    (36.13, -5.455, 'Algeciras', 'town', 10), (36.013, -5.606, 'Tarifa', 'town', 10), (35.889, -5.32, 'Ceuta', 'town', 10),
    (35.885, -5.505, 'Tanger-Med', 'town', 10), (35.772, -5.812, 'Tangier', 'town', 10), (35.84, -5.562, 'Ksar es-Seghir', 'town', 11),
    (35.817, -5.750, 'Cap Malabata', 'cape', 11), (35.91, -5.483, 'Punta Cires', 'cape', 11), (36.077, -5.426, 'Punta Carnero', 'cape', 11),
    (36.109, -5.346, 'Europa Point', 'cape', 11), (36.0, -5.61, 'Isla de Tarifa', 'cape', 12), (36.20, -5.40, 'BAY OF ALGECIRAS', 'sea', 11),
    (35.80, -5.77, 'TANGIER BAY', 'sea', 12), (36.20, -5.08, 'ALBORAN SEA', 'sea', 9), (35.90, -6.0, 'ATLANTIC', 'sea', 9),
]
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
    'labels': [{'lat': l[0], 'lon': l[1], 'name': l[2], 'kind': l[3], 'z': l[4]} for l in labels],
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
