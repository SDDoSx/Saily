# Contributing to Saily

Saily is a small, dependency-light PWA. Keep it that way: plain HTML/CSS/JS, no build step for the app itself,
Python only for the offline data pipeline.

## Run locally
```
node tools/serve.js 8080      # then open http://localhost:8080/ (GPS works on localhost)
node tools/unit.js            # pure geodesy / route tests
node --test tests/*.test.js   # node:test suites: nav, weather, AIS
node tools/e2e.js             # Playwright smoke test (needs playwright + Chromium)
node tools/replay.js          # route replay: every route at 3/5/22 kn, alert sequence vs passages/*.expected.json
python3 tests/build/test_build_chart.py   # chart pipeline golden test (needs shapely)
npx eslint .                  # lint (no-undef, unused variables)
```
See `docs/TESTING.md` for what each layer covers and how to regenerate the replay expectations.

## Layout
- `site/` the app. `index.html` (markup + CSS), `app.js` (UI, GPS, alerts, map), `nav.js` (pure geodesy, also runs in node),
  `weather.js` (Open-Meteo client + thresholds), `sw.js` (offline cache), `chart-data.js` (generated geometry),
  `passage.js` (generated passage definition).
- `passages/*.json` passage definitions: routes, places, hazards, labels, weather points, thresholds, briefing cards
  (`docs/PASSAGE-FORMAT.md`); `passages/*.tss.json` the traffic separation scheme they reference (`docs/TSS-DATA.md`).
  Both are validated by `tools/validate_passage.py` against `schema/*.schema.json` (run by the builder and CI).
- `tools/fetch_osm.py` fetches the OpenStreetMap inputs for a passage bbox from Overpass into a scratch directory and
  polygonises land (needs `pip install -r tools/requirements.txt`).
- `tools/build_chart.py` builds `site/chart-data.js` and `site/passage.js` from those extracts and a passage JSON.
- `tests/build/test_build_chart.py` runs both on a hand-written fixture and compares with `tests/build/golden/`
  (`UPDATE_GOLDEN=1` after an intended change).
- `tools/build_single.py` bundles everything into one HTML file.

## Rules
- Safety first: any change to route geometry, TSS polygons, hazards or alert logic needs a source in the commit message
  and must keep `tools/build_chart.py`'s leg-clearance check clean. If the replay sequence changes, regenerate
  `passages/<id>.expected.json` with `node tools/replay.js --write` and explain every changed line in the commit.
- Every alert text is read aloud: write it as a sentence a helmsman can act on ("Ships come from your LEFT").
- No trackers, no accounts, no backend. Data stays on the device.
- Keep the app usable with no network at all: the vector chart, route and hazards must never depend on tiles or APIs.
- Attribute data sources (OpenStreetMap ODbL, Open-Meteo CC BY 4.0, IMO, port notices) and respect tile providers' terms.

## Pull requests
Run the unit, node:test, e2e and replay tests, describe what you tested on a real phone if the change touches GPS, audio or the map,
and update `CHANGELOG.md`.
