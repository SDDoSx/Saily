# Handover (2026-09-07)

Branch: `main` (the working branch `claude/marine-nav-app-yacht-erflpd` points at the same commit). Deploy by
pushing `main`: `.github/workflows/pages.yml` publishes `site/` to **https://sddosx.github.io/Saily/**.

## Live

- **GitHub Pages: https://sddosx.github.io/Saily/** — the URL to add to the Home Screen. Verified in a browser:
  chart, service worker controlling, forecast for all five points, no console errors.
- Claude artifact (single file, forecast embedded):
  https://claude.ai/code/artifact/a5c6333e-2d58-474f-9b47-a16309f9d55b. The artifact viewer blocks
  page-initiated downloads, so GPX and track export are dead there; they work on Pages.
- Gap analysis and roadmap, written this session:
  https://claude.ai/code/artifact/4eeca0aa-86ed-498e-a307-0712ad85e1bf

## State of the tree

Clean. Verified on macOS with node 22.14 and a python venv holding shapely and jsonschema:

| check | result |
| --- | --- |
| `node tools/unit.js` | 22/22 |
| `node --test tests/*.test.js` | 54/54 |
| `python3 tests/build/test_build_chart.py` | 9/9 |
| `python3 tests/build/test_validate_passage.py` | 11/11 |
| `python3 tools/validate_passage.py --strict` | 0 errors, 0 warnings |
| `node tools/e2e.js` | 0 errors |
| `node tools/replay.js` | 9/9 route-speed runs PASS, 0 land-ahead |
| `npx eslint .` | 0 errors, 2 warnings (unused `dot` in app.js, `staleCount` in weather.js) |

**Local gotcha:** `tools/serve.js` binds port 8080. A stale server from an earlier run makes `e2e.js` and
`replay.js` hang with no output, because their own server cannot bind and never prints a port. If either
hangs, `lsof -ti :8080 | xargs kill -9` first.

## What was done this session

Three pieces, all deployed. `docs/../CHANGELOG.md` 0.12.0 has the full list.

1. **AIS**: the key was never used — a separate "Enable AIS targets" checkbox, defaulted off, gated the
   connection, and every failure after that was silent. Pasting a key now switches it on, and the status line
   says exactly what happened.
2. **Interface**: rebuilt on design tokens. The helm is one instrument, not eight identical cards; Setup is
   seven sections with the prose collapsed; the weather verdict stopped repeating itself.
3. **Passages**: `site/passages/index.json` is a catalogue, `site/boot.js` picks one at boot, and no place name
   is left in the app code. Adding a passage is a directory plus a catalogue line (`docs/ADAPTING.md` step 5).

Four latent bugs came out of that work, all of which would only have bitten a *second* passage: zone alerts
were keyed by the Strait's own zone ids and silently skipped anything else; `weather.js` loaded before the
passage and used the Strait's sample points and thresholds regardless; its fallback was five fixed
coordinates in the Strait; and the service worker registered on an event that had already fired, so the app
would have stopped working offline.

## Next steps

The roadmap artifact above has the reasoning. In order:

1. **Sea trial.** Nothing here has been on the water. The replay harness simulates the guards, not a real GPS.
2. **Phase 2 — make a passage without Python.** Draw waypoints on the map, run the existing land-clearance
   check in the browser, export the passage JSON. This is what stops other people contributing passages.
3. **Course-up chart.** Deliberately not attempted: Leaflet has no rotation, and a CSS transform on the map
   pane breaks hit-testing. It needs a real plugin or a canvas renderer, and half-doing it in a safety app is
   worse than not doing it.
4. **Phase 4 — Signal K**, for AIS from a real receiver and depth under the keel.
5. Clear the two eslint warnings, or give `staleCount` the use it was written for.
6. `tools/fetch_wx.py` and `tools/build_passage.py` have no tests.

## Conventions

Commit trailers: `Co-Authored-By:` the model and `Claude-Session:` the session URL. No model names in code or
commit subjects. Do not create a PR unless asked. Local dev needs `npm install && npx playwright install
chromium` and `pip install -r tools/requirements.txt`. Chart-build scratch data (coast.json, harbours.json,
land_*.json) lives in the session scratchpad; a fresh session must re-fetch with `tools/fetch_osm.py`
(Overpass mirrors are flaky; kumi.systems answered).
