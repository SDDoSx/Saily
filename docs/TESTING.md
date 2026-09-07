# Testing

Four layers, all runnable from a clean checkout with Node 22 (Playwright and Chromium only for the last two):

| Layer | Command | What it covers |
|---|---|---|
| Unit (node:test) | `node --test tests/*.test.js` | `nav.js` geodesy and route solving, `weather.js` thresholds / DST-safe hour lookup / passage check, `ais.js` CPA-TCPA, alarm window, pruning |
| Unit (legacy entry) | `node tools/unit.js` | runs `tests/nav.test.js` (kept for the documented workflow) |
| End-to-end | `node tools/e2e.js` | Playwright smoke test: start overlay, simulation, HUD, lane alert, weather page, service worker and offline reload, desktop layout |
| Route replay | `node tools/replay.js` | every bundled route driven through the real app at 3, 5 and 22 kn; the alert sequence is checked against `passages/<id>.expected.json` |
| Lint | `npx eslint .` | `no-undef` (error) and `no-unused-vars` (warning) with the browser / service-worker / node globals declared in `eslint.config.js`; non-blocking in CI |
| Passage data | `python3 tools/validate_passage.py --strict` and `python3 tests/build/test_validate_passage.py` | every `passages/*.json` and its `.tss.json` against `schema/*.schema.json` plus the semantic checks (`docs/PASSAGE-FORMAT.md`, `docs/TSS-DATA.md`); the test file feeds each class of mistake through both the `jsonschema` library and the built-in fallback checker |
| Chart pipeline | `python3 tests/build/test_build_chart.py` | `fetch_osm.py` polygonisation and `build_chart.py` on the hand-written island-and-bay fixture with its own small TSS (`tests/build/fixtures/tss.json`), compared with `tests/build/golden/` |

`npm test` runs unit + node:test + e2e; `npm run test:replay` runs the replay. In this sandbox Playwright lives in
`/opt/node22/lib/node_modules`, so prefix the browser tools with `NODE_PATH=/opt/node22/lib/node_modules`.
Node 22 does not accept a bare directory for `node --test` (it tries to `require('tests')`), hence the glob.

The node:test files load the browser modules with a fake root: `global.self = global`, `global.NAV = require('../site/nav.js')`,
plus a hand-made `global.PASSAGE` for `weather.js`, so the same files that run in Safari run unchanged under node.

## Route replay harness (`tools/replay.js`)

The replay answers one question: *if the boat follows the published leg lines exactly, what does the helmsman hear, and when?*

What it does:
1. Serves `site/` on a port from 8131 upwards, opens `index.html` in Chromium at 390x844 (phone) with geolocation permission,
   taps **Just look around** (`#btnPlanOnly`), sets `S.settings.voice = false` and `S.navigating = true`.
2. Takes over the GPS and the clock: the browser watch is cleared and `Date.now` in the page follows the simulated time, so
   alert cooldowns, the stale-fix gate and the GPS-lost timer see the same time as the fixes.
3. For every route in `window.PASSAGE.routes` and every speed in 3, 5, 22 kn: resets the navigation state
   (`S.settings.wp = 1`, zones / hazards / approach flags cleared, `processFix()`), then feeds fixes every 3 s of simulated time
   through `window.SAILY.onFix({coords:{latitude, longitude, accuracy: 8, speed, heading}, timestamp})`, positioned exactly on the
   great-circle leg lines with the leg bearing as heading. The last fix sits on the final waypoint. Fixes go in batches of
   250 per `page.evaluate` (`--batch`), a few milliseconds apart; a 2 h passage at 22 kn replays in 10-30 s, the 15 h
   crawl at 3 kn (18,000 fixes) in about a minute, the whole matrix in five to six minutes.
4. Reads `window.SAILY.S.log` after every fix and records each alert with the leg (`FROM>TO`), the position, the distance along
   the route and the simulated minute, plus every `S.zone` transition (so exits that have no spoken text are still visible).

Output:
- A console table per route and speed (`#`, nm along the route, minutes since departure, leg, level, text, resolved zone or
  hazard id), the list of zone transitions that produced no alert, the assertion results, and a summary table at the end.
- `tools/out/replay-<route>-<speed>.json` with the same data plus the legs (distance, bearing, which lanes / zones /
  precautionary areas the leg line crosses) and the assertion details.

Assertions (exit code 1 if any fails, page errors also fail the run):
- **(a)** no alert whose text starts with `Land or rocks ahead`. A boat on its own verified leg lines must not be warned about
  land. The count is printed either way.
- **(b)** every `danger` alert is either a lane / zone entry (`Entering the WESTBOUND/EASTBOUND traffic lane`,
  `In the separation zone`) on a leg whose line crosses that polygon, or a hazard whose id is listed under `hazards` for that
  route and speed in the expected file. The crossings are recomputed by point-in-polygon against `window.CHART.tss`
  lanes and zones sampled every 0.005 nm along the leg; `tools/build_chart.py` prints the same information as `LEG` lines
  (builder names: `lane_d` = `west_wb`, `lane_e` = `west_eb`, `lane_c` = `east_wb`, `lane_f` = `east_eb`, `prec_g` = `prec_east`,
  `prec_h` = `prec_tm`).
- **(c)** the ordered sequence of zone entries / exits and `Waypoint X reached` alerts equals the `sequence` stored for that
  route and speed in `passages/<passage-id>.expected.json`. A sequence entry is `{ev: zone-in | zone-out | wp, id, leg}`;
  zone ids are resolved from the `S.zone` transition on the same fix (an unresolved one is printed with a `?`).

Options:
- `--route <id>` and `--speed <kn>` (repeatable) restrict the run, e.g. `node tools/replay.js --route tarifa --speed 22`.
- `--write` regenerates the expected entries for the routes and speeds that ran (other entries are kept) and prints a diff
  against the previous file. Assertions (a) and (b) still run; (b)'s hazard list is taken from the run itself. Review the diff
  before committing: the expected file is the record of what the helmsman is told on each leg, so a changed line needs a reason
  in the commit message (a moved waypoint, a corrected TSS polygon, a new hazard).
- `--quiet` prints the summary only; `--port` and `--batch` as above. `SAILY_CHROMIUM=default` uses Playwright's own Chromium.

Reading the results:
- Lane and zone alerts on the Tarifa crossing come in the order `itz_n out, west_wb in, zone_b in, west_wb out, west_eb in,
  itz_sw in, west_eb out`; the separation-zone exit has no spoken text by design and shows up only in the transition list.
- Waypoint arrival is by radius, so `Waypoint X reached` fires a little before the corner while the boat is still on the old
  heading; the approach alert (`Waypoint X in 0.5 miles`) precedes it. Speed matters: at 3 kn the land-ahead look-ahead is
  150 m and the harbour-speed warning never fires; at 22 kn the look-ahead is four minutes (1.5 nm).
- A `Land or rocks ahead` alert during a replay means the guard looked past a corner along the old heading, or the coastline
  data is closer to the leg than the builder's clearance check allows. Either way it is a bug to fix, not an expected entry.
- Hazard pre-warnings (`<name>: 0.26 miles to the S`) are `warn` level and informational here; a `DANGER:` entry is only
  accepted when its id is in the expected file, so a leg that starts passing through a danger circle is caught.

What the replay does not do: no cross-track error (the fixes are on the line), no GPS noise or dropouts, no AIS targets, no
forecast (Open-Meteo requests are blocked so wall-clock-dependent weather alerts stay out; the sunset / night flags are
preset for the same reason), no service worker. Those paths are covered by `tools/e2e.js` and the unit tests.

Adding a passage: run `node tools/replay.js --write` once the routes are verified with `tools/build_chart.py`, read the printed
sequence for every route and speed, and commit `passages/<id>.expected.json` with the chart data.

## CI

`.github/workflows/ci.yml` runs, in order: ESLint (non-blocking), `node tools/unit.js`, `node --test tests/*.test.js`,
`tools/validate_passage.py --strict` with `tests/build/test_validate_passage.py`, `tests/build/test_build_chart.py`,
Playwright install, `node tools/e2e.js`, `node tools/replay.js`. The replay JSON reports are uploaded as a workflow artifact.
