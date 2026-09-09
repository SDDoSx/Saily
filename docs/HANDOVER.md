# Handover (2026-09-09)

Branch: `main`. Deploy by pushing `main`: `.github/workflows/pages.yml` publishes `site/` to
**https://sddosx.github.io/Saily/**. The working branch `claude/marine-nav-app-yacht-erflpd` tracks it.

## Live

- **https://sddosx.github.io/Saily/** — the URL to add to the Home Screen.
- Single-file build, forecast embedded: https://claude.ai/code/artifact/a5c6333e-2d58-474f-9b47-a16309f9d55b
  (the artifact viewer blocks page-initiated downloads, so GPX export is dead there; it works on Pages).
- Gap analysis and roadmap: https://claude.ai/code/artifact/4eeca0aa-86ed-498e-a307-0712ad85e1bf

## State

0.19.0, tree clean. Verified on macOS with node 22.14 and a python venv holding shapely and jsonschema:

| check | result |
| --- | --- |
| `node tools/unit.js` | 44/44 |
| `node --test tests/*.test.js` | 79/79 |
| `node tools/e2e.js` | 0 errors |
| `node tools/replay.js` | 9/9 route-speed runs, 0 land-ahead |
| `python3 tests/build/test_build_chart.py` | 10/10 |
| `python3 tests/build/test_catalogue.py` | 16/16 |
| `python3 tests/server/test_service.py` | all pass |
| `python3 tools/validate_passage.py --strict` | 0 errors, 0 warnings |
| `node tools/check_route.js …` | every leg clears land |
| `npx eslint .` | clean |

**Local gotchas.** `tools/serve.js` binds 8080 and `e2e.js` binds 8123; a stale server makes either hang with
no output — `lsof -ti :8080 | xargs kill -9` first. Python needs shapely and jsonschema
(`pip install -r tools/requirements.txt`); node needs `npm install && npx playwright install chromium`.

## What this app does now

Draw or auto-generate a route, have it checked against land and the traffic scheme, plan when to leave from
a real forecast, and navigate it with spoken alerts. `npm run dev` runs the app and the chart service
together.

- **Routing** (`site/nav.js`): `checkLegs` is a port of the Python builder's own leg check, pinned to
  shapely's answer on all 42 bundled legs by `tests/nav.test.js` against a fixture the build regenerates.
  `suggestRoute` is A* around land; `weatherRoute` costs a step by the *time* it takes in the conditions
  forecast for where you will be when you get there, so it routes around weather. Both price a step through
  a traffic lane by its angle to the flow, so crossings come out near square (COLREG rule 10(c)), and the
  path straightener refuses to undo either a square crossing or a weather detour.
- **Boat** (`site/boats.json`): archetypes by hull type and length, not a model database. `speedIn` is a
  shape that behaves correctly — a planing hull comes off the plane in a head sea, a displacement hull
  barely notices, a sailing boat has a polar and motors in no wind. It is not a measured polar and says so.
- **Planning**: `planDepartures` ranks a departure every four hours over the next sixty by passage time,
  worst conditions, dark arrival and nights needed. `schedule` breaks a long passage at a stop reached in
  daylight.
- **Passage log** (Plan, Log): every completed leg with actual against predicted speed and the conditions,
  and a one-button calibration of cruise speed from a real passage. Legs the boat could not plausibly have
  sailed are dropped; the simulation is never recorded. This is what the sea trial is for.
- **Chart service** (`server/`): the one thing a browser cannot do — fetch a coastline from Overpass and
  polygonise it. Optional; `tools/build_area.py` does the same locally, and GitHub Actions does it with
  nothing to host (`docs/BACKEND.md`).

## Next steps, in order

1. **Sea trial, planned for the weekend of 12–14 September 2026.** Nothing here has been on the water. Every
   guard, the router, the speed model and the planner are verified in simulation only. `docs/SEA-TRIAL.md`
   is the preparation and what to do with the result.
2. **Signal K** for AIS from a real receiver, depth and wind off the boat's own network. Shore-fed AIS dies
   offshore, which is where it matters.
3. Course-up chart. Deliberately not attempted: Leaflet has no rotation and a CSS transform on the map pane
   breaks hit-testing. It needs a real plugin or a canvas renderer, and half-doing it in a safety app is
   worse than not doing it.
4. `tools/fetch_wx.py`, `tools/build_passage.py` and `tools/dev.js` have no tests.

## Conventions

Commit trailers: `Co-Authored-By:` the model and `Claude-Session:` the session URL. No model names in code
or commit subjects. Do not create a PR unless asked. Chart-build scratch data lives in the session
scratchpad; a fresh session must re-fetch with `tools/fetch_osm.py` (Overpass mirrors are flaky;
kumi.systems answers).
