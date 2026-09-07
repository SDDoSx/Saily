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
p = os.path.join(root, 'site', 'sw.js')
s = open(p).read()
s2 = re.sub(r"const VERSION = '[^']*';", "const VERSION = 'saily-%s';" % bid, s, count=1)
open(p, 'w').write(s2)
json.dump({'build': bid, 'builtAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + 'Z'}, open(os.path.join(root, 'site', 'version.json'), 'w'))
print('stamped', bid)
