"""Saily chart service: a WSGI application that builds a passage's chart from OpenStreetMap.

Everything else in Saily is a static page. This exists for the one job a browser cannot do: fetching a
coastline from Overpass and polygonising it. It is a plain WSGI app with no framework, so it runs under
gunicorn, uWSGI, waitress, or the development server in `python3 -m server`.

    GET  /health                          is it up, and how busy
    POST /v1/builds                       {"passage": {...}, "tss": {...}} -> 202 {"id", "state"}
    GET  /v1/builds/<id>                  {"state": queued|running|done|failed, ...}
    GET  /v1/builds/<id>/log              what the builder printed
    GET  /v1/builds/<id>/chart-data.js    the built chart
    GET  /v1/builds/<id>/passage.js       the built passage
    GET  /v1/builds/<id>/bundle.json      both of the above as one JSON, for the app to load in one request

The data it returns is derived from OpenStreetMap and is ODbL: attribution and share-alike apply, and the
bundle says so. See docs/LICENSING.md.

Configuration is environment variables, all optional; docs/BACKEND.md lists them.
"""
import importlib.util
import json
import os
import sys
import time
import traceback

from .jobs import JobStore, JobError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STARTED = time.time()


def _env(name, default):
    v = os.environ.get(name)
    return default if v is None or v == '' else v


def _num(name, default, cast=float):
    try:
        return cast(_env(name, default))
    except (TypeError, ValueError):
        return cast(default)


CONFIG = {
    'jobs_dir': _env('SAILY_JOBS_DIR', os.path.join(ROOT, '.jobs')),
    'max_body': int(_num('SAILY_MAX_BODY', 1 << 20, int)),          # 1 MiB of JSON is a very large passage
    'max_bbox_deg2': _num('SAILY_MAX_BBOX_DEG2', 4.0),              # the bundled Strait passage is 0.92
    'max_places': int(_num('SAILY_MAX_PLACES', 12, int)),           # each place costs a detail polygon
    'max_waypoints': int(_num('SAILY_MAX_WAYPOINTS', 200, int)),
    'max_running': int(_num('SAILY_MAX_RUNNING', 1, int)),          # be a good citizen of the Overpass mirrors
    'max_queued': int(_num('SAILY_MAX_QUEUED', 4, int)),
    'ttl_seconds': int(_num('SAILY_JOB_TTL', 24 * 3600, int)),
    'build_timeout': int(_num('SAILY_BUILD_TIMEOUT', 600, int)),
    'allow_origin': _env('SAILY_ALLOW_ORIGIN', '*'),
}

STORE = JobStore(CONFIG['jobs_dir'], CONFIG['max_running'], CONFIG['max_queued'],
                 CONFIG['ttl_seconds'], CONFIG['build_timeout'])


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


VALIDATOR = _load('validate_passage', 'tools/validate_passage.py')

ATTRIBUTION = ('Chart data (c) OpenStreetMap contributors, Open Database License 1.0. '
               'Attribution and share-alike apply: https://www.openstreetmap.org/copyright')


# --- request checks -------------------------------------------------------------------------------
def check_request(body):
    """Everything that must be true before a build is worth starting. Raises JobError with a reason."""
    if not isinstance(body, dict):
        raise JobError('the body must be a JSON object')
    passage = body.get('passage')
    if not isinstance(passage, dict):
        raise JobError('"passage" must be the passage object')

    bbox = passage.get('bbox')
    if not (isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox)):
        raise JobError('"bbox" must be [south, west, north, east] in degrees')
    s, w, n, e = bbox
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise JobError(f'bbox {bbox} must be south < north and west < east, within the world')
    area = (n - s) * (e - w)
    if area > CONFIG['max_bbox_deg2']:
        raise JobError(f'bbox covers {area:.2f} square degrees; this service builds up to '
                       f'{CONFIG["max_bbox_deg2"]:.2f}. Split the passage or run tools/build_area.py yourself.')

    places = passage.get('places') or {}
    if len(places) > CONFIG['max_places']:
        raise JobError(f'{len(places)} places; up to {CONFIG["max_places"]} are built')
    total_wps = sum(len(r.get('waypoints') or []) for r in (passage.get('routes') or []))
    if total_wps > CONFIG['max_waypoints']:
        raise JobError(f'{total_wps} waypoints across the routes; up to {CONFIG["max_waypoints"]} are built')

    mirrors = body.get('mirrors')
    if mirrors is not None:
        if not (isinstance(mirrors, list) and all(isinstance(m, str) for m in mirrors)):
            raise JobError('"mirrors" must be a list of Overpass URLs')
        if len(mirrors) > 4:
            raise JobError('at most four mirrors')
        for m in mirrors:
            if not m.startswith('https://') or len(m) > 200:
                raise JobError(f'mirror {m!r} must be an https URL')

    # the same validator the build and CI run, so the service never accepts what the builder will reject
    tss = body.get('tss')
    if passage.get('tss') and tss is None:
        raise JobError('the passage names a "tss" file, so send it as "tss" in the same request')
    if tss is not None and not isinstance(tss, dict):
        raise JobError('"tss" must be the traffic-scheme object')
    reports = [VALIDATOR.validate_passage_dict(passage, 'passage')]
    if tss is not None:
        reports.append(VALIDATOR.validate_tss_dict(tss, 'tss', passage))
    problems = []
    for rep in reports:
        problems += [f'{rep.file}{ptr}: {msg}' for ptr, msg in sorted(set(rep.errors))]
    if problems:
        raise JobError('the passage did not validate:\n' + '\n'.join(problems[:20]))
    return passage, tss, mirrors


# --- tiny WSGI plumbing ---------------------------------------------------------------------------
def _json(start, status, obj, extra=None):
    body = (json.dumps(obj, indent=1) + '\n').encode('utf-8')
    headers = [('Content-Type', 'application/json; charset=utf-8'),
               ('Content-Length', str(len(body))),
               ('Cache-Control', 'no-store'),
               ('Access-Control-Allow-Origin', CONFIG['allow_origin'])]
    start(status, headers + (extra or []))
    return [body]


def _text(start, status, text, ctype='text/plain; charset=utf-8', cache='no-store'):
    body = text.encode('utf-8')
    start(status, [('Content-Type', ctype), ('Content-Length', str(len(body))),
                   ('Cache-Control', cache),
                   ('Access-Control-Allow-Origin', CONFIG['allow_origin'])])
    return [body]


def _read_body(environ):
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        raise JobError('bad Content-Length')
    if length > CONFIG['max_body']:
        raise JobError(f'the body is larger than {CONFIG["max_body"]} bytes')
    # never trust the declared length: stop reading at the cap either way
    raw = environ['wsgi.input'].read(min(length, CONFIG['max_body']) or 0)
    if not raw:
        raise JobError('empty body')
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        raise JobError(f'the body is not JSON: {e}')


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    path = environ.get('PATH_INFO', '/') or '/'

    if method == 'OPTIONS':
        start_response('204 No Content', [
            ('Access-Control-Allow-Origin', CONFIG['allow_origin']),
            ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
            ('Access-Control-Allow-Headers', 'Content-Type'),
            ('Access-Control-Max-Age', '86400'),
            ('Content-Length', '0')])
        return [b'']

    try:
        STORE.sweep()
        parts = [p for p in path.split('/') if p]

        if path in ('/health', '/healthz', '/'):
            queued, running = STORE.counts()
            return _json(start_response, '200 OK', {
                'ok': True, 'service': 'saily-chart-service',
                'uptimeSeconds': round(time.time() - STARTED),
                'queued': queued, 'running': running,
                'limits': {'maxBboxDeg2': CONFIG['max_bbox_deg2'], 'maxQueued': CONFIG['max_queued'],
                           'maxRunning': CONFIG['max_running'], 'buildTimeoutSeconds': CONFIG['build_timeout']},
                'attribution': ATTRIBUTION,
            })

        if parts[:2] == ['v1', 'builds']:
            if method == 'POST' and len(parts) == 2:
                passage, tss, mirrors = check_request(_read_body(environ))
                st = STORE.submit(passage, tss, mirrors)
                return _json(start_response, '202 Accepted', dict(st, poll=f'/v1/builds/{st["id"]}'),
                             extra=[('Location', f'/v1/builds/{st["id"]}')])

            if method == 'GET' and len(parts) >= 3:
                job_id = parts[2]
                st = STORE.status(job_id)
                if st is None:
                    return _json(start_response, '404 Not Found', {'error': 'no such build'})
                tail = parts[3] if len(parts) > 3 else None

                if tail is None:
                    return _json(start_response, '200 OK', st)
                if tail == 'log':
                    return _text(start_response, '200 OK', STORE.log(job_id) or '(nothing yet)\n')
                if tail in ('chart-data.js', 'passage.js'):
                    js = STORE.artifact(job_id, tail)
                    if js is None:
                        return _json(start_response, '409 Conflict', {'error': f'not built yet ({st["state"]})', 'state': st['state']})
                    return _text(start_response, '200 OK', js, 'application/javascript; charset=utf-8', 'public, max-age=3600')
                if tail == 'bundle.json':
                    chart, pj = STORE.artifact(job_id, 'chart-data.js'), STORE.artifact(job_id, 'passage.js')
                    if chart is None:
                        return _json(start_response, '409 Conflict', {'error': f'not built yet ({st["state"]})', 'state': st['state']})
                    return _json(start_response, '200 OK', {
                        'id': job_id, 'passageId': st.get('passageId'), 'bbox': st.get('bbox'),
                        'chart': chart, 'passage': pj, 'attribution': ATTRIBUTION,
                    })
                return _json(start_response, '404 Not Found', {'error': 'no such artifact'})

        return _json(start_response, '404 Not Found', {'error': 'no such endpoint', 'see': '/health'})

    except JobError as e:
        return _json(start_response, '400 Bad Request', {'error': str(e)})
    except Exception:                                            # noqa: BLE001
        # the client gets nothing internal; the operator gets the traceback
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return _json(start_response, '500 Internal Server Error', {'error': 'the service failed to handle that'})


app = application
