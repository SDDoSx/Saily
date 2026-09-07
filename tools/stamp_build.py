#!/usr/bin/env python3
"""Stamp a build id into site/sw.js (VERSION) and site/version.json so every build gets its own atomic shell cache.
Usage: python3 tools/stamp_build.py [<id>]   (default: git short sha + dirty marker)"""
import json, re, subprocess, sys, datetime, os
root = os.path.join(os.path.dirname(__file__), '..')
if len(sys.argv) > 1:
    bid = sys.argv[1]
else:
    try:
        sha = subprocess.check_output(['git', 'rev-parse', '--short=8', 'HEAD'], cwd=root).decode().strip()
        dirty = subprocess.call(['git', 'diff', '--quiet'], cwd=root) != 0
        bid = sha + ('-dirty' if dirty else '')
    except Exception:
        bid = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
# Keep the service worker's precache list in step with what is actually bundled, so a passage added to
# site/passages/ is offline-ready without anyone remembering to edit sw.js.
def passage_files(site):
    out = ['./passages/index.json']
    base = os.path.join(site, 'passages')
    for pid in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        d = os.path.join(base, pid)
        if not os.path.isdir(d):
            continue
        for f in ('chart-data.js', 'passage.js'):
            if os.path.exists(os.path.join(d, f)):
                out.append('./passages/%s/%s' % (pid, f))
    return out


site = os.path.join(root, 'site')
p = os.path.join(site, 'sw.js')
s = open(p).read()
s2 = re.sub(r"const VERSION = '[^']*';", "const VERSION = 'saily-%s';" % bid, s, count=1)
files = passage_files(site)
s2 = re.sub(r"const PASSAGE_FILES = \[[^\]]*\];",
            'const PASSAGE_FILES = [%s];' % ', '.join("'%s'" % f for f in files), s2, count=1)
open(p, 'w').write(s2)
print('precaching', len(files), 'passage file(s)')
json.dump({'build': bid, 'builtAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + 'Z'}, open(os.path.join(root, 'site', 'version.json'), 'w'))
print('stamped', bid)
