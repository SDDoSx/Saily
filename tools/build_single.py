#!/usr/bin/env python3
"""Bundle site/ into one self-contained HTML fragment (no doctype/html/head/body) for artifact hosting.
Usage: build_single.py <out.html> [wx_snapshot.json]
"""
import json, re, sys, os
ROOT = os.path.join(os.path.dirname(__file__), '..', 'site')
out = sys.argv[1]
snap = sys.argv[2] if len(sys.argv) > 2 else None
def rd(p): return open(os.path.join(ROOT, p), encoding='utf-8').read()
# One passage per single-file build: the catalogue's default. boot.js is not inlined; the data is already here.
CATALOGUE = json.loads(rd('passages/index.json'))
DEFAULT = next((p for p in CATALOGUE if p.get('default')), CATALOGUE[0])
html = rd('index.html')
# body markup between <body> and </body>, minus script tags
body = html.split('<body>', 1)[1].split('</body>', 1)[0]
body = re.sub(r'<script src="[^"]+"></script>\s*', '', body)
style = html.split('<style>', 1)[1].split('</style>', 1)[0]
leaflet_css = rd('vendor/leaflet/leaflet.css')
leaflet_css = re.sub(r'url\(images/[^)]+\)', 'none', leaflet_css)
leaflet_js = rd('vendor/leaflet/leaflet.min.js')

# The single-file build has no directory to fetch fonts from, so they ride along as data URIs.
import base64
def font_uri(name):
    with open(os.path.join(ROOT, 'vendor', 'fonts', name), 'rb') as f:
        return 'data:font/woff2;base64,' + base64.b64encode(f.read()).decode()
FONT_CSS = (
    "@font-face{font-family:'Plex';src:url(%s) format('woff2-variations');font-weight:400 700;font-style:normal;font-display:swap}"
    "@font-face{font-family:'Plex Cond';src:url(%s) format('woff2');font-weight:600;font-style:normal;font-display:swap}"
    "@font-face{font-family:'Plex Cond';src:url(%s) format('woff2');font-weight:700;font-style:normal;font-display:swap}"
) % (font_uri('plex-sans-var-latin.woff2'), font_uri('plex-cond-600-latin.woff2'), font_uri('plex-cond-700-latin.woff2'))
parts = ['<title>Saily</title>',
         '<style>\n' + leaflet_css + '\n' + FONT_CSS + '\n'
             + re.sub(r"@font-face\{[^}]*vendor/fonts[^}]*\}", '', style) + '\n#app{font-size:15px}\n</style>',
         body,
         '<script>\n' + leaflet_js + '\n</script>',
         # Data before code: weather.js reads PASSAGE at load time (sample points, thresholds, time zone).
         '<script>\n' + rd(DEFAULT['chart']) + '\n</script>',
         '<script>\n' + rd(DEFAULT['passage']) + '\n</script>',
         '<script>\n' + rd('nav.js') + '\n</script>',
         '<script>\n' + rd('weather.js') + '\n</script>',
         '<script>\n' + rd('ais.js') + '\n</script>']
if snap:
    s = json.load(open(snap))
    parts.append('<script>window.SAILY_SINGLE = true; window.EMBEDDED_WX = ' + json.dumps(s, separators=(',', ':')) + ';</script>')
else:
    parts.append('<script>window.SAILY_SINGLE = true;</script>')
parts.append('<script>\n' + rd('app.js') + '\n</script>')
doc = '\n'.join(parts).replace('</script>', '</script>')
# guard: no literal "</script>" inside inlined sources other than our closers
open(out, 'w', encoding='utf-8').write(doc)
print('wrote', out, len(doc.encode()), 'bytes')
