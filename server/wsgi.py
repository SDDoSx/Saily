"""WSGI entry point: `gunicorn --workers 1 --threads 8 server.wsgi:app`.

One worker on purpose. Builds run as subprocesses tracked in the job directory, and a single worker keeps
the concurrency cap honest without a shared lock. Threads carry the polling, which is all the traffic there
is. Scale by raising SAILY_MAX_RUNNING, not by adding workers.
"""
from .app import application as app  # noqa: F401
