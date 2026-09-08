#!/usr/bin/env python3
"""Tests for the chart service (server/). No network: the one build these run is made to fail validation,
which exercises the job state machine without touching Overpass.

Run:  python3 tests/server/test_service.py
"""
import io
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)

JOBS = tempfile.mkdtemp(prefix='saily-jobs-test-')
os.environ['SAILY_JOBS_DIR'] = JOBS
os.environ.setdefault('SAILY_ALLOW_ORIGIN', '*')

from server.app import application, check_request, CONFIG, STORE   # noqa: E402
from server.jobs import JobError, JobStore                          # noqa: E402

PASSAGE = json.load(open(os.path.join(ROOT, 'passages', 'strait-of-gibraltar.json'), encoding='utf-8'))
TSS = json.load(open(os.path.join(ROOT, 'passages', 'strait-of-gibraltar.tss.json'), encoding='utf-8'))
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else ' - ' + str(detail)))
    if not ok:
        FAILS.append(name)


def rejects(name, body, expect=None):
    try:
        check_request(body)
        check(name, False, 'was accepted')
    except JobError as e:
        check(name, expect is None or expect in str(e), f'reason was: {e}')


# --- request checks -----------------------------------------------------------------------------
def test_checks():
    passage, tss, mirrors = check_request({'passage': PASSAGE, 'tss': TSS})
    check('the bundled passage is accepted', passage['id'] == 'strait-of-gibraltar' and tss is not None)
    rejects('a body that is not an object', [1, 2], 'JSON object')
    rejects('a missing passage', {}, '"passage"')
    rejects('a passage that names a tss without sending it', {'passage': PASSAGE}, 'send it as "tss"')
    rejects('an inverted bbox', {'passage': dict(PASSAGE, bbox=[36.45, -5.05, 35.65, -6.2]), 'tss': TSS}, 'south < north')
    rejects('a bbox off the world', {'passage': dict(PASSAGE, bbox=[-91, -6.2, 36.45, -5.05]), 'tss': TSS}, 'within the world')
    rejects('a bbox larger than the cap', {'passage': dict(PASSAGE, bbox=[30, -10, 36.45, -5.05]), 'tss': TSS}, 'square degrees')
    rejects('too many places', {'passage': dict(PASSAGE, places={f'p{i}': {'name': 'x', 'lat': 36, 'lon': -5.5, 'vhf': '9'} for i in range(40)}), 'tss': TSS}, 'places')
    rejects('a passage the validator refuses', {'passage': dict(PASSAGE, routes=[]), 'tss': TSS}, 'did not validate')
    # a mirror is a URL the service will fetch: it must not be talked into a plain-text or internal host
    rejects('a plain-http mirror', {'passage': PASSAGE, 'tss': TSS, 'mirrors': ['http://169.254.169.254/']}, 'https')
    rejects('mirrors that are not a list', {'passage': PASSAGE, 'tss': TSS, 'mirrors': 'https://x'}, 'list')
    rejects('too many mirrors', {'passage': PASSAGE, 'tss': TSS, 'mirrors': ['https://a'] * 9}, 'four')


# --- WSGI ---------------------------------------------------------------------------------------
def call(method, path, body=None, content_length=None):
    raw = b'' if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'wsgi.input': io.BytesIO(raw),
           'CONTENT_LENGTH': str(len(raw) if content_length is None else content_length)}
    out = {}

    def start(status, headers, exc=None):
        out['status'] = status
        out['headers'] = dict(headers)
    chunks = application(env, start)
    out['body'] = b''.join(chunks).decode('utf-8')
    return out


def test_wsgi():
    r = call('GET', '/health')
    check('health answers 200', r['status'].startswith('200'), r['status'])
    h = json.loads(r['body'])
    check('health reports its limits', h['ok'] and 'maxBboxDeg2' in h['limits'], h)
    check('health carries the OpenStreetMap attribution', 'OpenStreetMap' in h['attribution'])
    check('every response allows the app origin', r['headers'].get('Access-Control-Allow-Origin') == '*', r['headers'])

    r = call('OPTIONS', '/v1/builds')
    check('preflight answers 204 with the allowed methods', r['status'].startswith('204') and 'POST' in r['headers'].get('Access-Control-Allow-Methods', ''), r)

    r = call('GET', '/nope')
    check('an unknown path is 404 JSON', r['status'].startswith('404') and 'error' in json.loads(r['body']), r['status'])

    r = call('POST', '/v1/builds', b'not json')
    check('a body that is not JSON is 400', r['status'].startswith('400'), r['status'])

    r = call('POST', '/v1/builds', b'{}', content_length=CONFIG['max_body'] + 1)
    check('an oversized body is refused before reading', r['status'].startswith('400') and 'larger than' in r['body'], r['body'][:120])

    r = call('POST', '/v1/builds', {'passage': dict(PASSAGE, bbox=[10, -30, 40, 10]), 'tss': TSS})
    check('a huge bbox is refused with a reason', r['status'].startswith('400') and 'square degrees' in r['body'], r['body'][:160])

    # ids are server-generated hex: nothing else may reach the filesystem
    for bad in ('..', '../../etc', 'x' * 32, 'ABCDEF0123456789abcdef0123456789'):
        r = call('GET', f'/v1/builds/{bad}')
        check(f'a job id of {bad!r} is refused', r['status'].startswith(('400', '404')), r['status'])

    r = call('GET', '/v1/builds/' + ('a' * 32))
    check('an unknown job is 404', r['status'].startswith('404'), r['status'])


# --- job store ----------------------------------------------------------------------------------
def test_jobs():
    store = JobStore(os.path.join(JOBS, 'store'), max_running=1, max_queued=2, ttl_seconds=1, build_timeout=90)
    check('a job id must be hex', _raises(lambda: store.dir_for('../etc')))
    check('an unknown artifact is refused', _raises(lambda: store.artifact('a' * 32, 'passwd')))

    # a passage the builder will reject: the job must end 'failed' with the reason in its log, not hang
    bad = {'id': 'no-routes', 'name': 'no routes', 'bbox': [36.0, -5.5, 36.1, -5.4], 'places': {}, 'routes': [], 'hazards': []}
    st = store.submit(bad)
    check('submit returns a queued job', st['state'] == 'queued' and len(st['id']) == 32, st)
    for _ in range(120):
        st = store.status(st['id'])
        if st['state'] in ('done', 'failed'):
            break
        time.sleep(0.5)
    check('an invalid passage ends as failed, not stuck', st['state'] == 'failed', st)
    check('the failure says what happened', bool(st.get('error')), st)
    check('the log records why', 'invalid' in store.log(st['id']).lower() or 'error' in store.log(st['id']).lower(), store.log(st['id'])[-200:])
    check('the scratch extracts are cleaned up', not os.path.exists(os.path.join(store.dir_for(st['id']), 'scratch')))

    check('a queue that is full is refused', _fills(store))

    time.sleep(1.1)
    removed = store.sweep()
    check('finished jobs are swept after their time to live', removed >= 1, removed)


def _raises(fn):
    try:
        fn()
        return False
    except JobError:
        return True


def _fills(store):
    bad = {'id': 'x', 'name': 'x', 'bbox': [36.0, -5.5, 36.1, -5.4], 'places': {}, 'routes': [], 'hazards': []}
    try:
        for _ in range(store.max_queued + store.max_running + 2):
            store.submit(bad)
        return False
    except JobError as e:
        return 'queue is full' in str(e)


if __name__ == '__main__':
    try:
        test_checks()
        test_wsgi()
        test_jobs()
    finally:
        shutil.rmtree(JOBS, ignore_errors=True)
    print(f'{"FAILED: " + ", ".join(FAILS) if FAILS else "all service tests passed"}')
    sys.exit(1 if FAILS else 0)
