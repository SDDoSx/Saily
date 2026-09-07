# Handover (2026-09-07, deployed)

Branch: `claude/marine-nav-app-yacht-erflpd`, fast-forwarded into `main` at the owner's request so GitHub Pages
could deploy (the `github-pages` environment only allows `main`). Both refs are at the same commit.

## Live

- **GitHub Pages: https://sddosx.github.io/Saily/** — Pages is now enabled (Settings, Pages, Source = GitHub
  Actions) and `.github/workflows/pages.yml` publishes `site/` on every push to `main`. Verified in a browser:
  chart, service worker controlling, forecast fetched for all five points, no console errors. This is the URL to
  add to the Home Screen. The workflow no longer triggers on the working branch: the `github-pages` environment
  allows only `main`, so a branch run failed on the environment rule *and*, sharing the `pages` concurrency
  group with `cancel-in-progress`, cancelled the main deploy first. **Deploy by pushing `main`.**
- Claude artifact (single file, forecast embedded):
  https://claude.ai/code/artifact/a5c6333e-2d58-474f-9b47-a16309f9d55b — built from `dist/saily.html`. Note the
  artifact viewer blocks page-initiated downloads, so GPX and track export are dead there; they work on Pages.
- raw.githack.com still serves the branch but now puts a one-click "External Content Notice" in front of the
  page. Usable as a fallback, wrong for a Home Screen app.

## State of the tree

HEAD `3799ee8`, clean. Verified on this machine (macOS, node 22.14, python 3.14 in a venv with shapely and
jsonschema):

| check | result |
| --- | --- |
| `node tools/unit.js` | 22/22 |
| `node --test tests/*.test.js` | 50/50 |
| `python3 tests/build/test_build_chart.py` | 9/9 |
| `python3 tests/build/test_validate_passage.py` | 11/11 |
| `python3 tools/validate_passage.py --strict` | 0 errors, 0 warnings |
| `node tools/e2e.js` | 0 errors |
| `node tools/replay.js` | 9/9 route-speed runs PASS (3, 5 and 22 kn on tarifa, east and return; 0 land-ahead) |
| `npx eslint .` | 0 errors, 2 warnings (unused locals `dot` in app.js, `staleCount` in weather.js) |

The 3 and 5 kn replay runs, unverified when the previous session paused, pass.

## What was done this session

All five review findings from the previous handover are fixed:

1. `fetch_osm.geojson(geom, force_multi=True)` for `land_osm.json`, so a bbox with one connected land mass no
   longer writes a bare Polygon that crashed `build_chart.load_land` on `.geoms`; `load_land` also promotes a
   Polygon defensively, and `test_land_single_mass_is_multipolygon` covers it (confirmed failing before the fix).
2. `LICENSE` bullet 2 points at `passages/strait-of-gibraltar.tss.json`, not `tools/build_chart.py`.
3. `site/vendor/leaflet/VERSION` rewritten. Every vendored file was re-checked byte-for-byte against cdnjs:
   `leaflet.min.js` is cdnjs's *own* minification (different identifier mangling, no sourceMappingURL), not
   `dist/leaflet.js` minus the header — `dist/leaflet.js` is what cdnjs serves as `leaflet.js`. Checksums recorded.
4. `__pycache__/` was already in `.gitignore`; `package-lock.json` added (CI installs with `--no-save`).
5. `overpass_get` catches `http.client.HTTPException` (IncompleteRead from a cut transfer).

Also:

- `tools/fetch_wx.py` (new): fetches the Open-Meteo snapshot that `build_single.py` embeds. It had no producer
  in the tree, so the single-file build was not reproducible. `dist/saily.html` was rebuilt from a snapshot taken
  2026-09-07 12:17Z covering to 2026-09-11 23:00 ES.
- `CHANGELOG.md`: one `0.11.0 (2026-09-07)` entry instead of two headings, with the app changes from `b2f6d33`.
  `package.json` bumped to 0.11.0.
- `README.md`: live passage verdict, night/big-numbers colours, and a Development section that works off
  `npm install` rather than a global `NODE_PATH`.
- `stamp_build.py` off the deprecated `datetime.utcnow()`.

## Next steps

Nothing is blocking. Candidates, in rough order of value:

1. Sea trial. The owner has not yet run the app on the water; the replay harness is a simulation of the guards,
   not of a real GPS.
2. Clear the two eslint warnings (dead locals) or give `staleCount` the use it was written for (a count in the
   stale-forecast banner).
3. `tools/fetch_wx.py` has no test and no fixture; the golden build test does not cover it.
4. Re-run `tools/fetch_osm.py` + `tools/build_chart.py` against current OSM and diff `site/chart-data.js`: the
   shipped chart is from a 2026-07-27 coastline extract and nothing re-checks it.
5. `docs/ADAPTING.md` has not been walked end to end for a second passage.

## Conventions

Commit trailers: `Co-Authored-By:` the model, and `Claude-Session:` the session URL. No model names in code or
commit subjects. Do not create a PR unless asked. Scratch data for the chart build lives in the session
scratchpad (coast.json, harbours.json, land_*.json); a fresh session must re-fetch with `tools/fetch_osm.py`
(Overpass mirrors are flaky; kumi.systems answered). Local dev needs `npm install && npx playwright install
chromium` and `pip install -r tools/requirements.txt`.
