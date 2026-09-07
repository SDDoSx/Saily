#!/usr/bin/env python3
"""Validate passage definitions (passages/<id>.json) and the traffic separation scheme files they reference
(<id>.tss.json) against schema/passage.schema.json and schema/tss.schema.json, then run the checks a schema
cannot express (bbox order, waypoint ids, weatherPoints routeNm non-decreasing, point references, ...).

Usage: validate_passage.py [--quiet] [--strict] [passage.json ...]
       default: every passages/*.json that is not a .tss.json or .expected.json
       --strict  warnings count as errors
       exit 1 when any file has errors; every problem is printed as  <file>: <json pointer>: <message>

Uses the jsonschema library when installed (pip install -r tools/requirements.txt); otherwise a small built-in
checker covering the subset of JSON Schema 2020-12 the two schemas use. tools/build_chart.py calls validate_files()
before building.
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
SCHEMA_DIR = os.path.join(ROOT, 'schema')

try:
    import jsonschema  # type: ignore
    HAVE_JSONSCHEMA = True
except ImportError:  # pragma: no cover - depends on the environment
    jsonschema = None
    HAVE_JSONSCHEMA = False
if os.environ.get('SAILY_NO_JSONSCHEMA'):  # force the built-in checker (used by the tests to cover both paths)
    HAVE_JSONSCHEMA = False


# --- schema validation ----------------------------------------------------------------------------
def load_schema(name):
    return json.load(open(os.path.join(SCHEMA_DIR, name), encoding='utf-8'))


def pointer(path):
    return '/' + '/'.join(str(p) for p in path) if path else '/'


def schema_errors(instance, schema):
    """[(pointer, message)] sorted by pointer. Library when available, else the built-in checker."""
    if HAVE_JSONSCHEMA:
        cls = jsonschema.validators.validator_for(schema)
        cls.check_schema(schema)
        errs = []
        for e in cls(schema).iter_errors(instance):
            errs.append((pointer(list(e.absolute_path)), _short(e)))
        return sorted(set(errs))
    return sorted(set(MiniValidator(schema).errors(instance)))


def _short(e):
    """One-line message: for oneOf/anyOf failures name the branch errors, else the library text."""
    if e.validator in ('oneOf', 'anyOf') and e.context:
        inner = sorted(set(f'{pointer(list(c.absolute_path))}: {c.message}' for c in e.context))
        return e.message.split('\n')[0][:160] + ' (' + '; '.join(inner)[:300] + ')'
    return e.message.split('\n')[0][:300]


class MiniValidator:
    """Fallback JSON Schema checker: type, properties, required, additionalProperties, unevaluatedProperties
    (treated like additionalProperties against the local properties, which the schemas list in full), items,
    prefixItems, minItems, maxItems, uniqueItems, minProperties, propertyNames, minimum, maximum,
    exclusiveMinimum, exclusiveMaximum, multipleOf, enum, const, pattern, minLength, maxLength, allOf, anyOf,
    oneOf, not, dependentRequired, $ref to #/$defs/... . Enough for schema/*.json; not a general validator."""

    def __init__(self, schema):
        self.root = schema

    def errors(self, instance):
        out = []
        self._check(instance, self.root, [], out)
        return out

    def _resolve(self, ref):
        assert ref.startswith('#/'), ref
        node = self.root
        for part in ref[2:].split('/'):
            node = node[part.replace('~1', '/').replace('~0', '~')]
        return node

    @staticmethod
    def _type_ok(v, t):
        if t == 'object':
            return isinstance(v, dict)
        if t == 'array':
            return isinstance(v, list)
        if t == 'string':
            return isinstance(v, str)
        if t == 'integer':
            return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
        if t == 'number':
            return isinstance(v, (int, float)) and not isinstance(v, bool)
        if t == 'boolean':
            return isinstance(v, bool)
        if t == 'null':
            return v is None
        raise ValueError(t)

    def _check(self, v, s, path, out):
        if s is True:
            return
        if s is False:
            out.append((pointer(path), 'not allowed here'))
            return
        if '$ref' in s:
            self._check(v, self._resolve(s['$ref']), path, out)
        t = s.get('type')
        if t is not None:
            types = t if isinstance(t, list) else [t]
            if not any(self._type_ok(v, x) for x in types):
                out.append((pointer(path), f'{json.dumps(v)[:60]} is not of type {", ".join(types)}'))
                return
        if 'enum' in s and v not in s['enum']:
            out.append((pointer(path), f'{json.dumps(v)[:60]} is not one of {json.dumps(s["enum"])}'))
        if 'const' in s and v != s['const']:
            out.append((pointer(path), f'{json.dumps(v)[:60]} was expected to be {json.dumps(s["const"])}'))
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if 'minimum' in s and v < s['minimum']:
                out.append((pointer(path), f'{v} is less than the minimum of {s["minimum"]}'))
            if 'maximum' in s and v > s['maximum']:
                out.append((pointer(path), f'{v} is greater than the maximum of {s["maximum"]}'))
            if 'exclusiveMinimum' in s and v <= s['exclusiveMinimum']:
                out.append((pointer(path), f'{v} is less than or equal to the minimum of {s["exclusiveMinimum"]}'))
            if 'exclusiveMaximum' in s and v >= s['exclusiveMaximum']:
                out.append((pointer(path), f'{v} is greater than or equal to the maximum of {s["exclusiveMaximum"]}'))
            if 'multipleOf' in s and (v / s['multipleOf']) % 1 != 0:
                out.append((pointer(path), f'{v} is not a multiple of {s["multipleOf"]}'))
        if isinstance(v, str):
            if 'minLength' in s and len(v) < s['minLength']:
                out.append((pointer(path), f'{json.dumps(v)[:60]} is too short (minLength {s["minLength"]})'))
            if 'maxLength' in s and len(v) > s['maxLength']:
                out.append((pointer(path), f'{json.dumps(v)[:60]} is too long (maxLength {s["maxLength"]})'))
            if 'pattern' in s and not re.search(s['pattern'], v):
                out.append((pointer(path), f'{json.dumps(v)[:60]} does not match {json.dumps(s["pattern"])}'))
        if isinstance(v, list):
            if 'minItems' in s and len(v) < s['minItems']:
                out.append((pointer(path), f'{json.dumps(v)[:60]} is too short (minItems {s["minItems"]})'))
            if 'maxItems' in s and len(v) > s['maxItems']:
                out.append((pointer(path), f'{json.dumps(v)[:60]} is too long (maxItems {s["maxItems"]})'))
            if s.get('uniqueItems') and len({json.dumps(x, sort_keys=True) for x in v}) != len(v):
                out.append((pointer(path), f'{json.dumps(v)[:60]} has non-unique elements'))
            prefix = s.get('prefixItems', [])
            for i, item in enumerate(v):
                if i < len(prefix):
                    self._check(item, prefix[i], path + [i], out)
                elif 'items' in s:
                    self._check(item, s['items'], path + [i], out)
        if isinstance(v, dict):
            props = s.get('properties', {})
            for k in s.get('required', []):
                if k not in v:
                    out.append((pointer(path), f'{json.dumps(k)} is a required property'))
            if 'minProperties' in s and len(v) < s['minProperties']:
                out.append((pointer(path), f'{json.dumps(v)[:60]} does not have enough properties (minProperties {s["minProperties"]})'))
            for k, sub in props.items():
                if k in v:
                    self._check(v[k], sub, path + [k], out)
            for k, needed in s.get('dependentRequired', {}).items():
                if k in v:
                    for n in needed:
                        if n not in v:
                            out.append((pointer(path), f'{json.dumps(n)} is a dependency of {json.dumps(k)}'))
            if 'propertyNames' in s:
                for k in v:
                    self._check(k, s['propertyNames'], path + [k], out)
            extra = s.get('additionalProperties', s.get('unevaluatedProperties'))
            if extra is not None and extra is not True:
                for k in v:
                    if k in props:
                        continue
                    if extra is False:
                        out.append((pointer(path), f'Additional properties are not allowed ({json.dumps(k)} was unexpected)'))
                    else:
                        self._check(v[k], extra, path + [k], out)
        for sub in s.get('allOf', []):
            self._check(v, sub, path, out)
        if 'anyOf' in s:
            branches = [self._branch(v, sub, path) for sub in s['anyOf']]
            if not any(len(b) == 0 for b in branches):
                out.append((pointer(path), f'{json.dumps(v)[:60]} is not valid under any of the given schemas (' + '; '.join(m for b in branches for _, m in b)[:300] + ')'))
        if 'oneOf' in s:
            branches = [self._branch(v, sub, path) for sub in s['oneOf']]
            ok = sum(1 for b in branches if len(b) == 0)
            if ok == 0:
                out.append((pointer(path), f'{json.dumps(v)[:60]} is not valid under any of the given schemas (' + '; '.join(m for b in branches for _, m in b)[:300] + ')'))
            elif ok > 1:
                out.append((pointer(path), f'{json.dumps(v)[:60]} is valid under more than one of the given schemas'))
        if 'not' in s and len(self._branch(v, s['not'], path)) == 0:
            out.append((pointer(path), f'{json.dumps(v)[:60]} should not be valid under {json.dumps(s["not"])[:80]}'))

    def _branch(self, v, sub, path):
        errs = []
        self._check(v, sub, path, errs)
        return errs


# --- checks beyond the schema ---------------------------------------------------------------------
class Report:
    def __init__(self, file):
        self.file = file
        self.errors = []
        self.warnings = []

    def error(self, ptr, msg):
        self.errors.append((ptr, msg))

    def warn(self, ptr, msg):
        self.warnings.append((ptr, msg))

    def lines(self):
        for ptr, msg in sorted(set(self.errors)):
            yield f'{self.file}: {ptr}: error: {msg}'
        for ptr, msg in sorted(set(self.warnings)):
            yield f'{self.file}: {ptr}: warning: {msg}'


def in_bbox(bbox, lat, lon):
    s, w, n, e = bbox
    return s <= lat <= n and w <= lon <= e


def check_passage(pz, rep, schema):
    """Semantic checks of a passage dict (schema errors already reported)."""
    bbox = pz.get('bbox')
    bbox_ok = isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(x, (int, float)) for x in bbox)
    if bbox_ok:
        s, w, n, e = bbox
        if not s < n:
            rep.error('/bbox', f'south {s} must be less than north {n} (order is [south, west, north, east])')
        if not w < e:
            rep.error('/bbox', f'west {w} must be less than east {e} (order is [south, west, north, east])')
        bbox_ok = s < n and w < e

    def inside(ptr, obj, what, level='error'):
        if bbox_ok and isinstance(obj, dict) and isinstance(obj.get('lat'), (int, float)) and isinstance(obj.get('lon'), (int, float)):
            if not in_bbox(bbox, obj['lat'], obj['lon']):
                (rep.error if level == 'error' else rep.warn)(ptr, f'{what} ({obj["lat"]}, {obj["lon"]}) is outside bbox {bbox}')

    known = set(schema.get('properties', {}).keys())
    for k in pz:
        if k not in known:
            rep.warn('/' + k, 'unknown top-level key (copied to passage.js unchanged; add it to schema/passage.schema.json if it is meant to stay)')

    for key, pl in (pz.get('places') or {}).items():
        inside(f'/places/{key}', pl, f'place {key}')
        db = pl.get('detailBox') if isinstance(pl, dict) else None
        if isinstance(db, list) and len(db) == 4 and all(isinstance(x, (int, float)) for x in db) and not (db[0] < db[2] and db[1] < db[3]):
            rep.error(f'/places/{key}/detailBox', 'order is [south, west, north, east]')

    all_wp_ids = set()
    route_ids = []
    recommended = 0
    for i, r in enumerate(pz.get('routes') or []):
        if not isinstance(r, dict):
            continue
        route_ids.append(r.get('id'))
        if r.get('recommended'):
            recommended += 1
        seen = {}
        wps = r.get('waypoints') or []
        for j, w in enumerate(wps):
            if not isinstance(w, dict):
                continue
            ptr = f'/routes/{i}/waypoints/{j}'
            wid = w.get('id')
            if wid in seen:
                rep.error(ptr + '/id', f'waypoint id {wid!r} already used at waypoint {seen[wid]} of route {r.get("id")!r}')
            seen[wid] = j
            all_wp_ids.add(wid)
            inside(ptr, w, f'waypoint {wid}')
            if j > 0 and isinstance(wps[j - 1], dict) and wps[j - 1].get('lat') == w.get('lat') and wps[j - 1].get('lon') == w.get('lon'):
                rep.error(ptr, f'waypoint {wid} is at the same position as the previous waypoint (zero-length leg)')
        if len(wps) >= 2 and not any(isinstance(w, dict) and w.get('note') for w in wps):
            rep.warn(f'/routes/{i}', 'no waypoint has a spoken note')
    dup = {x for x in route_ids if route_ids.count(x) > 1}
    if dup:
        rep.error('/routes', f'duplicate route id(s): {sorted(str(d) for d in dup)}')
    if pz.get('routes') and recommended == 0:
        rep.warn('/routes', 'no route is marked "recommended": the app starts on the first one')
    if recommended > 1:
        rep.warn('/routes', f'{recommended} routes are marked "recommended": the app uses the first one')

    for j, wid in enumerate(pz.get('harbourWaypoints') or []):
        if wid not in all_wp_ids:
            rep.error(f'/harbourWaypoints/{j}', f'{wid!r} is not a waypoint of any route')

    seen = {}
    for i, h in enumerate(pz.get('hazards') or []):
        if not isinstance(h, dict):
            continue
        if h.get('id') in seen:
            rep.error(f'/hazards/{i}/id', f'hazard id {h.get("id")!r} already used at hazard {seen[h.get("id")]}')
        seen[h.get('id')] = i
        inside(f'/hazards/{i}', h, f'hazard {h.get("id")}')

    for i, lb in enumerate(pz.get('labels') or []):
        inside(f'/labels/{i}', lb, f'label {lb.get("name") if isinstance(lb, dict) else i}')

    seen = {}
    last = None
    for i, wp in enumerate(pz.get('weatherPoints') or []):
        if not isinstance(wp, dict):
            continue
        if wp.get('id') in seen:
            rep.error(f'/weatherPoints/{i}/id', f'weather point id {wp.get("id")!r} already used at weather point {seen[wp.get("id")]}')
        seen[wp.get('id')] = i
        inside(f'/weatherPoints/{i}', wp, f'weather point {wp.get("id")}')
        nm = wp.get('routeNm')
        if isinstance(nm, (int, float)):
            if last is not None and nm < last:
                rep.error(f'/weatherPoints/{i}/routeNm', f'routeNm {nm} is less than the previous point\'s {last}: weather points must be listed in route order')
            last = nm

    th = pz.get('thresholds') or {}
    for a, b in (('windCaution', 'windNoGo'), ('gustCaution', 'gustNoGo'), ('waveCaution', 'waveNoGo')):
        if isinstance(th.get(a), (int, float)) and isinstance(th.get(b), (int, float)) and th[a] >= th[b]:
            rep.error(f'/thresholds/{a}', f'{a} {th[a]} must be below {b} {th[b]}')

    inside('/sun', pz.get('sun'), 'sun position', level='warn')

    tz = pz.get('tz') or {}
    for side in ('from', 'to'):
        zone = (tz.get(side) or {}).get('zone') if isinstance(tz.get(side), dict) else None
        if isinstance(zone, str):
            try:
                import zoneinfo
                zoneinfo.ZoneInfo(zone)
            except ImportError:
                rep.warn(f'/tz/{side}/zone', 'zoneinfo not available: time zone name not checked')
            except Exception:  # ZoneInfoNotFoundError or a missing tz database
                rep.error(f'/tz/{side}/zone', f'unknown IANA time zone {zone!r}')
    for key, pl in (pz.get('places') or {}).items():
        zone = pl.get('tz') if isinstance(pl, dict) else None
        if isinstance(zone, str):
            try:
                import zoneinfo
                zoneinfo.ZoneInfo(zone)
            except ImportError:
                pass
            except Exception:
                rep.error(f'/places/{key}/tz', f'unknown IANA time zone {zone!r}')

    seen = {}
    for i, c in enumerate(pz.get('cards') or []):
        if isinstance(c, dict):
            if c.get('id') in seen:
                rep.error(f'/cards/{i}/id', f'card id {c.get("id")!r} already used at card {seen[c.get("id")]}')
            seen[c.get('id')] = i


DM_RE = re.compile(r'^\s*(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([NSEW])\s*$')


def parse_coord(v):
    """Decimal degrees or 'DD MM.MM H' -> float degrees (S and W negative); None when not parseable."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if not isinstance(v, str):
        return None
    m = DM_RE.match(v)
    if not m:
        return None
    d = int(m.group(1)) + float(m.group(2)) / 60.0
    if float(m.group(2)) >= 60:
        return None
    return -d if m.group(3) in 'SW' else d


def resolve_points(points, rep=None):
    """{id: (lat, lon)} for a tss 'points' list; reports unresolved references and cycles."""
    raw = {}
    for i, p in enumerate(points):
        if isinstance(p, dict) and isinstance(p.get('id'), str):
            if p['id'] in raw and rep:
                rep.error(f'/points/{i}/id', f'point id {p["id"]!r} already used')
            raw.setdefault(p['id'], (i, p))
    out = {}

    def coord(pid, key, chain):
        i, p = raw[pid]
        ref = p.get(key + 'Of')
        if ref is not None:
            if ref not in raw:
                if rep:
                    rep.error(f'/points/{i}/{key}Of', f'refers to unknown point {ref!r}')
                return None
            if ref in chain:
                if rep:
                    rep.error(f'/points/{i}/{key}Of', f'circular reference {" -> ".join(chain + [ref])}')
                return None
            return coord(ref, key, chain + [ref])
        val = parse_coord(p.get(key))
        if val is None and rep:
            rep.error(f'/points/{i}/{key}', f'cannot parse {json.dumps(p.get(key))} (use decimal degrees or "DD MM.MM N")')
        return val

    for pid, (i, p) in raw.items():
        lat = coord(pid, 'lat', [pid])
        lon = coord(pid, 'lon', [pid])
        if lat is not None and not -90 <= lat <= 90 and rep:
            rep.error(f'/points/{i}/lat', f'latitude {lat} out of range')
        if lon is not None and not -180 <= lon <= 180 and rep:
            rep.error(f'/points/{i}/lon', f'longitude {lon} out of range')
        if lat is not None and lon is not None:
            out[pid] = (lat, lon)
    return out


TSS_LISTS = ('separationZones', 'lanes', 'precautionary', 'inshoreZones', 'freeAreas', 'anchorages')


def check_tss(tss, rep, pz=None):
    """Semantic checks of a tss dict (schema errors already reported); pz for the bbox cross-check."""
    points = resolve_points(tss.get('points') or [], rep)
    bbox = (pz or {}).get('bbox')
    if isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(x, (int, float)) for x in bbox) and bbox[0] < bbox[2] and bbox[1] < bbox[3]:
        for i, p in enumerate(tss.get('points') or []):
            if isinstance(p, dict) and p.get('id') in points and not in_bbox(bbox, *points[p['id']]):
                rep.warn(f'/points/{i}', f'point {p["id"]} {points[p["id"]]} is outside the passage bbox {bbox}')

    ids = {}
    zone_ids = set()
    for lst in TSS_LISTS:
        for i, el in enumerate(tss.get(lst) or []):
            if not isinstance(el, dict):
                continue
            ptr = f'/{lst}/{i}'
            eid = el.get('id')
            if eid in ids:
                rep.error(ptr + '/id', f'id {eid!r} already used at {ids[eid]} (ids must be unique across the whole file: the app keys its zone state by id)')
            ids[eid] = ptr
            if lst == 'separationZones':
                zone_ids.add(eid)

            def refs(key, min_n, ring):
                lst_ = el.get(key)
                if not isinstance(lst_, list):
                    return
                for j, pid in enumerate(lst_):
                    if pid not in points:
                        rep.error(f'{ptr}/{key}/{j}', f'unknown point {pid!r}')
                closed = ring and len(lst_) >= 2 and lst_[0] == lst_[-1]
                if closed:
                    rep.warn(f'{ptr}/{key}', 'first point repeated at the end: rings are closed automatically')
                if len(lst_) != len(set(lst_)) and not (closed and len(lst_) - 1 == len(set(lst_))):
                    rep.error(f'{ptr}/{key}', 'a point is used twice')
                if len(lst_) < min_n:
                    rep.error(f'{ptr}/{key}', f'needs at least {min_n} points')

            if lst in ('separationZones', 'lanes', 'precautionary', 'inshoreZones', 'freeAreas'):
                refs('region', 3, ring=True)
            if lst == 'separationZones':
                refs('centreline', 2, ring=False)
            if lst == 'lanes' and isinstance(el.get('arrows'), dict):
                arr = el['arrows']
                for j, pid in enumerate(arr.get('along') or []):
                    if pid not in points:
                        rep.error(f'{ptr}/arrows/along/{j}', f'unknown point {pid!r}')
            if lst == 'anchorages':
                for key in ('lat', 'lon'):
                    if parse_coord(el.get(key)) is None:
                        rep.error(f'{ptr}/{key}', f'cannot parse {json.dumps(el.get(key))}')
            if lst != 'anchorages':
                if not isinstance(el.get('enter'), str) or not el.get('enter', '').strip():
                    rep.error(ptr + '/enter', 'every zone needs a spoken enter text')
                for key in ('enter', 'leave'):
                    txt = el.get(key)
                    if isinstance(txt, str) and txt.strip() and not re.search(r'[.!?]$', txt.strip()):
                        rep.warn(f'{ptr}/{key}', 'alert text should end with a full stop (it is read aloud as a sentence)')
    for i, lane in enumerate(tss.get('lanes') or []):
        if isinstance(lane, dict) and lane.get('separationZone') is not None and lane['separationZone'] not in zone_ids:
            rep.error(f'/lanes/{i}/separationZone', f'unknown separation zone {lane["separationZone"]!r}')
    for lst in ('separationZones', 'lanes', 'precautionary'):
        seen = {}
        for i, el in enumerate(tss.get(lst) or []):
            par = el.get('paragraph') if isinstance(el, dict) else None
            if par is not None:
                if par in seen:
                    rep.warn(f'/{lst}/{i}/paragraph', f'paragraph {par!r} already used by {seen[par]}: the LEG report labels will collide')
                seen[par] = el.get('id')
    if tss.get('lanes') and not any(isinstance(l, dict) and l.get('separationZone') for l in tss['lanes']) and tss.get('separationZones'):
        rep.warn('/lanes', 'separation zones defined but no lane refers to one')
    try:
        _check_tss_geometry(tss, points, rep)
    except ImportError:
        rep.warn('/', 'shapely not installed: polygon validity not checked')


def _check_tss_geometry(tss, points, rep):
    """Ring validity (self-intersection) with shapely, when available."""
    from shapely.geometry import Polygon
    for lst in ('separationZones', 'lanes', 'precautionary', 'inshoreZones', 'freeAreas'):
        for i, el in enumerate(tss.get(lst) or []):
            reg = el.get('region') if isinstance(el, dict) else None
            if isinstance(reg, list) and len(reg) >= 3 and all(p in points for p in reg):
                poly = Polygon([(points[p][1], points[p][0]) for p in reg])
                if not poly.is_valid:
                    rep.error(f'/{lst}/{i}/region', 'polygon is not valid (self-intersecting or degenerate): check the vertex order')
                elif poly.area == 0:
                    rep.error(f'/{lst}/{i}/region', 'polygon has zero area')


# --- files ----------------------------------------------------------------------------------------
def tss_path_for(passage_path, pz):
    ref = pz.get('tss') if isinstance(pz, dict) else None
    if not isinstance(ref, str):
        return None
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(passage_path)), ref))


def validate_passage_dict(pz, file='passage', schema=None):
    schema = schema or load_schema('passage.schema.json')
    rep = Report(file)
    for ptr, msg in schema_errors(pz, schema):
        rep.error(ptr, msg)
    if isinstance(pz, dict):
        check_passage(pz, rep, schema)
    return rep


def validate_tss_dict(tss, file='tss', pz=None, schema=None):
    schema = schema or load_schema('tss.schema.json')
    rep = Report(file)
    for ptr, msg in schema_errors(tss, schema):
        rep.error(ptr, msg)
    if isinstance(tss, dict):
        check_tss(tss, rep, pz)
    return rep


def validate_files(passage_path, tss_path=None):
    """Validate one passage file and its TSS file. Returns [Report]; a report per file."""
    reports = []
    rel = os.path.relpath(passage_path, ROOT) if os.path.abspath(passage_path).startswith(ROOT) else passage_path
    try:
        pz = json.load(open(passage_path, encoding='utf-8'))
    except (OSError, ValueError) as e:
        rep = Report(rel)
        rep.error('/', f'cannot read JSON: {e}')
        return [rep]
    reports.append(validate_passage_dict(pz, rel))
    tp = tss_path or tss_path_for(passage_path, pz)
    if tp is None:
        return reports
    trel = os.path.relpath(tp, ROOT) if os.path.abspath(tp).startswith(ROOT) else tp
    if not os.path.exists(tp):
        reports[0].error('/tss', f'file not found: {tp}')
        return reports
    try:
        tss = json.load(open(tp, encoding='utf-8'))
    except (OSError, ValueError) as e:
        rep = Report(trel)
        rep.error('/', f'cannot read JSON: {e}')
        reports.append(rep)
        return reports
    reports.append(validate_tss_dict(tss, trel, pz if isinstance(pz, dict) else None))
    return reports


def default_files():
    return sorted(f for f in glob.glob(os.path.join(ROOT, 'passages', '*.json')) if not f.endswith('.tss.json') and not f.endswith('.expected.json'))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    quiet = '--quiet' in argv
    strict = '--strict' in argv
    files = [a for a in argv if not a.startswith('--')] or default_files()
    if not files:
        print('validate_passage: no passage files found', file=sys.stderr)
        return 1
    n_err = n_warn = 0
    for f in files:
        reps = validate_files(f)
        for rep in reps:
            for line in rep.lines():
                print(line)
            n_err += len(rep.errors)
            n_warn += len(rep.warnings)
            if not quiet:
                print(f'{rep.file}: {len(rep.errors)} error(s), {len(rep.warnings)} warning(s)' + ('' if HAVE_JSONSCHEMA else ' [built-in checker: jsonschema not installed]'))
    bad = n_err > 0 or (strict and n_warn > 0)
    if not quiet:
        print('validate_passage:', 'FAILED' if bad else 'OK', f'({len(files)} passage file(s), {n_err} error(s), {n_warn} warning(s))')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
