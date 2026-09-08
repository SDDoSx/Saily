"""On-disk job store for chart builds.

A build takes tens of seconds to a couple of minutes: an Overpass fetch, then polygonisation. That is far
too long to hold an HTTP request open through a proxy, so a build is a job. Submit it, poll it, collect the
files.

State lives in the job directory rather than in memory, so it survives a restart, is visible to every
worker process, and can be inspected with `ls` when something goes wrong.

    <root>/<id>/request.json   what was submitted
    <root>/<id>/passage.json   the passage, as the builder reads it
    <root>/<id>/tss.json       the traffic scheme, when one was submitted
    <root>/<id>/status.json    {id, state, times, error}
    <root>/<id>/build.log      everything the builder printed
    <root>/<id>/out/           chart-data.js, passage.js
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ID_RE = re.compile(r'^[0-9a-f]{32}$')
STATES = ('queued', 'running', 'done', 'failed')


class JobError(Exception):
    """Something the caller can fix; the message is safe to return."""


def _now():
    return time.time()


class JobStore:
    def __init__(self, root, max_running=1, max_queued=4, ttl_seconds=24 * 3600, build_timeout=600):
        self.root = os.path.abspath(root)
        self.max_running = max_running
        self.max_queued = max_queued
        self.ttl = ttl_seconds
        self.build_timeout = build_timeout
        self._lock = threading.Lock()
        os.makedirs(self.root, exist_ok=True)

    # --- paths ---------------------------------------------------------------------------------
    def dir_for(self, job_id):
        if not ID_RE.match(job_id or ''):
            raise JobError('not a job id')
        return os.path.join(self.root, job_id)

    def _status_path(self, job_id):
        return os.path.join(self.dir_for(job_id), 'status.json')

    # --- reading -------------------------------------------------------------------------------
    def status(self, job_id):
        try:
            with open(self._status_path(job_id), encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write_status(self, job_id, **fields):
        st = self.status(job_id) or {'id': job_id}
        st.update(fields)
        path = self._status_path(job_id)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(st, f, indent=1)
        os.replace(tmp, path)          # a poller never sees a half-written status
        return st

    def log(self, job_id, limit=64 * 1024):
        path = os.path.join(self.dir_for(job_id), 'build.log')
        if not os.path.exists(path):
            return ''
        size = os.path.getsize(path)
        with open(path, encoding='utf-8', errors='replace') as f:
            if size > limit:
                f.seek(size - limit)
                return '... (truncated)\n' + f.read()
            return f.read()

    def artifact(self, job_id, name):
        if name not in ('chart-data.js', 'passage.js'):
            raise JobError('unknown artifact')
        path = os.path.join(self.dir_for(job_id), 'out', name)
        if not os.path.exists(path):
            return None
        with open(path, encoding='utf-8') as f:
            return f.read()

    def counts(self):
        """Queued and running jobs, counted from disk so every worker sees the same numbers."""
        queued = running = 0
        for jid in self._ids():
            st = self.status(jid) or {}
            if st.get('state') == 'queued':
                queued += 1
            elif st.get('state') == 'running':
                # a build whose process died leaves 'running' behind: treat a stale one as gone
                if _now() - st.get('startedAt', 0) > self.build_timeout + 60:
                    self._write_status(jid, state='failed', error='the build did not finish in time', finishedAt=_now())
                else:
                    running += 1
        return queued, running

    def _ids(self):
        try:
            return [d for d in os.listdir(self.root) if ID_RE.match(d)]
        except OSError:
            return []

    # --- writing -------------------------------------------------------------------------------
    def submit(self, passage, tss=None, mirrors=None):
        with self._lock:
            queued, running = self.counts()
            if queued + running >= self.max_queued + self.max_running:
                raise JobError(f'the build queue is full ({queued} queued, {running} running); try again shortly')
            job_id = uuid.uuid4().hex
            d = os.path.join(self.root, job_id)
            os.makedirs(os.path.join(d, 'out'), exist_ok=True)
            with open(os.path.join(d, 'passage.json'), 'w', encoding='utf-8') as f:
                json.dump(passage, f, indent=1)
            if tss is not None:
                name = os.path.basename(str(passage.get('tss') or (passage['id'] + '.tss.json')))
                with open(os.path.join(d, name), 'w', encoding='utf-8') as f:
                    json.dump(tss, f, indent=1)
            with open(os.path.join(d, 'request.json'), 'w', encoding='utf-8') as f:
                json.dump({'passageId': passage.get('id'), 'bbox': passage.get('bbox'), 'mirrors': mirrors}, f, indent=1)
            st = self._write_status(job_id, id=job_id, state='queued', passageId=passage.get('id'),
                                    bbox=passage.get('bbox'), createdAt=_now(), error=None)
        threading.Thread(target=self._run, args=(job_id, mirrors), daemon=True).start()
        return st

    def _run(self, job_id, mirrors):
        d = self.dir_for(job_id)
        self._write_status(job_id, state='running', startedAt=_now())
        argv = [sys.executable, os.path.join(ROOT, 'tools', 'build_area.py'),
                os.path.join(d, 'passage.json'), os.path.join(d, 'out'),
                '--scratch', os.path.join(d, 'scratch')]
        for m in (mirrors or []):
            argv += ['--mirror', m]
        try:
            with open(os.path.join(d, 'build.log'), 'w', encoding='utf-8') as log:
                log.write('$ ' + ' '.join(argv[1:]) + '\n\n')
                log.flush()
                proc = subprocess.run(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                      timeout=self.build_timeout, check=False)
            ok = proc.returncode == 0 and os.path.exists(os.path.join(d, 'out', 'chart-data.js'))
            if ok:
                self._write_status(job_id, state='done', finishedAt=_now(), error=None,
                                   chartBytes=os.path.getsize(os.path.join(d, 'out', 'chart-data.js')))
            else:
                self._write_status(job_id, state='failed', finishedAt=_now(),
                                   error=f'the build exited with status {proc.returncode}; see the log')
        except subprocess.TimeoutExpired:
            self._write_status(job_id, state='failed', finishedAt=_now(),
                               error=f'the build ran longer than {self.build_timeout} s and was stopped')
        except Exception as e:                                   # noqa: BLE001 - never lose the job
            self._write_status(job_id, state='failed', finishedAt=_now(), error=f'{type(e).__name__}: {e}')
        finally:
            shutil.rmtree(os.path.join(d, 'scratch'), ignore_errors=True)   # the extracts are large and ODbL

    # --- housekeeping --------------------------------------------------------------------------
    def sweep(self):
        """Delete jobs past their time to live. Cheap enough to call on every request."""
        cut = _now() - self.ttl
        removed = 0
        for jid in self._ids():
            st = self.status(jid) or {}
            when = st.get('finishedAt') or st.get('createdAt') or 0
            if st.get('state') in ('done', 'failed') and when and when < cut:
                shutil.rmtree(os.path.join(self.root, jid), ignore_errors=True)
                removed += 1
        return removed
