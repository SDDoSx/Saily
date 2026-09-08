#!/usr/bin/env python3
"""Tests for tools/catalogue.py, which decides what the app offers.

Run: python3 tests/build/test_catalogue.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else ' - ' + str(detail)))
    if not ok:
        FAILS.append(name)


def run(work, *args):
    """Run catalogue.py against a throwaway copy of site/passages, so the real one is never touched."""
    env = dict(os.environ)
    r = subprocess.run([sys.executable, os.path.join(work, 'tools', 'catalogue.py'), *args],
                       cwd=work, capture_output=True, text=True, env=env)
    return r.returncode, r.stdout + r.stderr


def sandbox():
    work = tempfile.mkdtemp(prefix='saily-cat-')
    os.makedirs(os.path.join(work, 'tools'))
    shutil.copy(os.path.join(ROOT, 'tools', 'catalogue.py'), os.path.join(work, 'tools', 'catalogue.py'))
    for pid in ('alpha', 'bravo'):
        d = os.path.join(work, 'site', 'passages', pid)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'chart-data.js'), 'w').write('window.CHART = {};\n')
        open(os.path.join(d, 'passage.js'), 'w').write('window.PASSAGE = {};\n')
    os.makedirs(os.path.join(work, 'passages'), exist_ok=True)
    for pid, title in (('alpha', 'A → B'), ('bravo', 'B → C')):
        json.dump({'id': pid, 'name': f'{pid} passage', 'title': title, 'description': 'x'},
                  open(os.path.join(work, 'passages', pid + '.json'), 'w'))
    return work


def index(work):
    p = os.path.join(work, 'site', 'passages', 'index.json')
    return json.load(open(p)) if os.path.exists(p) else []


def main():
    work = sandbox()
    try:
        rc, out = run(work, 'add', 'passages/alpha.json', '--default')
        check('adding a built passage succeeds', rc == 0, out)
        e = index(work)
        check('the entry points at the built files', e[0]['chart'] == 'passages/alpha/chart-data.js', e)
        check('the title comes from the passage', e[0]['title'] == 'A → B', e)
        check('it is marked default', e[0].get('default') is True, e)

        rc, out = run(work, 'add', 'passages/bravo.json')
        check('a second passage is added', rc == 0 and len(index(work)) == 2, out)
        check('only one entry is default', sum(1 for x in index(work) if x.get('default')) == 1, index(work))
        check('the default sorts first', index(work)[0]['id'] == 'alpha', index(work))

        rc, out = run(work, 'add', 'passages/bravo.json', '--default')
        check('making another the default clears the old one',
              [x['id'] for x in index(work) if x.get('default')] == ['bravo'], index(work))
        check('adding the same id twice does not duplicate it', len(index(work)) == 2, index(work))

        rc, out = run(work, 'check')
        check('a healthy catalogue checks clean', rc == 0, out)

        # a passage whose files are missing must not be advertised
        json.dump({'id': 'ghost', 'name': 'ghost'}, open(os.path.join(work, 'passages', 'ghost.json'), 'w'))
        rc, out = run(work, 'add', 'passages/ghost.json')
        check('adding a passage that was never built is refused', rc != 0 and 'build it first' in out, out)

        # a built directory nobody can reach is almost always a forgotten catalogue line
        d = os.path.join(work, 'site', 'passages', 'orphan')
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'chart-data.js'), 'w').write('window.CHART = {};\n')
        rc, out = run(work, 'check')
        check('a built passage missing from the catalogue is reported', rc != 0 and 'not in the catalogue' in out, out)
        shutil.rmtree(d)

        rc, out = run(work, 'remove', 'alpha')
        check('removing a passage works', rc == 0 and [x['id'] for x in index(work)] == ['bravo'], out)
        rc, out = run(work, 'remove', 'bravo')
        check('removing the last passage is refused', rc != 0 and 'at least one' in out, out)
        rc, out = run(work, 'remove', 'nope')
        check('removing an unknown id is refused', rc != 0, out)

        rc, out = run(work, 'list')
        check('list prints the catalogue', rc == 0 and 'bravo' in out, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all catalogue tests passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
