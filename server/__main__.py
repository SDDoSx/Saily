"""Development server: python3 -m server [--host H] [--port P]

Uses wsgiref, which is fine for one person building charts on a laptop. In production put the same
application behind gunicorn (server/wsgi.py) or any other WSGI server; docs/BACKEND.md has both.
"""
import argparse
import os
import sys
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server

from .app import application, CONFIG


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--host', default=os.environ.get('SAILY_HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8787)))
    a = ap.parse_args(argv)
    srv = make_server(a.host, a.port, application, server_class=ThreadingWSGIServer)
    print(f'Saily chart service on http://{a.host}:{a.port}/  (jobs in {CONFIG["jobs_dir"]})', flush=True)
    print(f'  health:  curl http://{a.host}:{a.port}/health', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
