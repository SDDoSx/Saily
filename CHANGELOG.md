# Changelog

## 0.15.1 (2026-09-08)
The route editor was unfindable. It was the last of six unlabelled dark squares behind a hamburger on the
chart, which is not a place anyone would look for "draw a route".
- **A labelled button at the top of the Plan tab**: "Plan a new route on the chart". That is the tab called
  Plan, which is where a person looks.
- The map menu is a labelled list instead of a row of glyphs, with "Plan a route" first and highlighted.
- Pressing it while navigating used to flash a toast and do nothing. It now asks, stops navigation and opens
  the editor.
- It also opened behind the start overlay, so the chart you were meant to tap was covered by "Start
  navigation". The overlay gets out of the way, and comes back if you close the editor without starting.
- The route radios on the Plan tab said "Recommended / Alternative / Alternative". They name the routes now.
- e2e checks both ways in, by their labels, so this cannot quietly regress.

## 0.15.0 (2026-09-08)
The loop closes: draw a route anywhere, have its chart built, and navigate on it, without a terminal.
- **The route editor can build the chart for its own area.** Draw a route where Saily has no chart, press
  Passage JSON, then "Build a chart for this area". The app derives a bounding box around the route, asks the
  chart service to build it, and installs the result as a passage on the device, in the picker with the rest.
  Charts are parsed, never executed, whoever is hosting the service.
- **A chart service URL in Setup**, with a Test button that reports what the service says. Leave it empty and
  none of this is offered; the app has no idea a backend exists.
- **GitHub Actions is a chart service too.** "Build a passage chart" takes the same JSON, builds it, checks
  every leg against the chart it just built, commits it and updates the catalogue. Nothing to host.
  "Check a passage" does the same for a pull request without committing.
- `npm run dev` runs the app and the chart service together.
- `tools/catalogue.py` maintains `site/passages/index.json`; `tools/check_route.js` measures every leg of a
  passage against a chart and refuses a route that runs into land. Both run in CI.
- `server/fly.toml` and `server/render.yaml` for deploying the service.

### Fixed
- `build_chart.load_land` rebuilt land from exterior rings only and unioned them without checking validity.
  On a real coastline that raises `TopologyException: side location conflict` and the build dies -- found by
  building the Bay of Cadiz. Rings are repaired now, and holes are kept, so a lagoon is water rather than land.
- `tz`, `sun` and `vessel` are optional in the passage schema, and the app dereferenced all three directly:
  a passage without them crashed on boot. They fall back to the device zone, the route's destination, and
  empty.
- `harbourWaypoints` was a list of this passage's own waypoint ids defaulted inside the builder, which every
  other passage silently inherited. It is in the passage data now.

## 0.14.0 (2026-09-08)
- **Chart service** (`server/`): the one job a browser cannot do. POST a passage, it fetches the coastline from
  Overpass and builds `chart-data.js` and `passage.js`, as a job you poll. A plain WSGI application with no
  framework, no database and no queue: `python3 -m server` on a laptop, `gunicorn server.wsgi:app` behind
  anything, or one container that runs as-is on Fly, Render, Railway, Cloud Run or a Pi. `docs/BACKEND.md`.
- The service is a convenience, never a dependency. `tools/build_area.py` runs the same build locally, and it
  is what the service runs in a subprocess, so the two cannot drift.
- Guarded to be safe to expose: a bounding-box cap in square degrees, queue and concurrency limits, a body
  size cap, a build timeout, https-only Overpass mirrors, server-generated job ids, and the same
  `validate_passage.py` the build and CI run, before a job is created. Jobs are swept after a day.
- `tests/server/test_service.py` covers the request limits, the WSGI routing, CORS, path traversal and the job
  state machine, without touching the network. It runs in CI.

## 0.13.0 (2026-09-07)
Routes can be drawn in the app and are checked there, so making one no longer means running Python.
- **Route editor** on the chart: tap to add a waypoint, drag to move, insert, delete, rename, undo. Every leg
  is measured as you draw -- closest approach to the coastline and which traffic-scheme areas it crosses --
  with legs inside 0.25 nm flagged, and legs into a harbour exempt the way the chart builder exempts them.
- `NAV.checkLegs` is the browser port of the chart builder's own verification. `tests/nav.test.js` holds it to
  shapely's answer on all 42 legs of the three bundled routes, against a fixture that
  `tests/build/test_build_chart.py` regenerates, so the two can never quietly disagree.
- "Use this route" keeps a drawn route on the device and offers it beside the bundled ones. "Passage JSON"
  gives the block to paste into a passage file for a pull request.
- A drawn route whose legs failed the check is marked **not verified**: it says so in the route picker, on the
  Plan tab, and again before navigation starts.
- `NAV.projector(lat0)` replaces the fixed projection origin, so distances are measured with the cosine of the
  latitude they are actually at rather than the Strait of Gibraltar's.

### Fixed
- The map control container caught pointer events across its whole box. With the ☰ menu open that was a
  roughly 300 px wide invisible strip over the chart that swallowed taps and drags. Only the buttons take
  pointers now.

## 0.12.1 (2026-09-07)
- AIS: decode the binary frames aisstream actually sends. See **Fixed** below; this is the reason no ship
  ever appeared, and the earlier diagnostics work is what surfaced it as "[object Blob]".
- `boot.js` falls back to loading the default passage directly when the catalogue cannot be fetched, so the
  app still opens from a `file://` path.

## 0.12.0 (2026-09-07)
Interface rebuilt on a design system, and the passage became something you choose rather than something the
app is compiled around.
- Design tokens: one type scale, one spacing scale, one radius scale, and surfaces named by role. Every theme
  redefines the same token set, so daylight and night stay consistent by construction.
- The helm reads as one instrument rather than eight identical cards: hairline dividers over a single well,
  bearing and distance to the waypoint set larger than the rest, a header that truncates instead of wrapping,
  and environment readings that no longer cut themselves off. Alerts show three lines instead of two.
- Setup is seven sections in the order they matter at sea, with switches instead of raw checkboxes, selects
  that show their whole option text, and the long explanations behind a summary. The start screen no longer
  scrolls its own title out of view.
- Weather: the repeated CAUTION pills under the verdict are gone; reasons are a list with a severity stripe
  and the measurement leading. A WMO weather code was being printed as a measurement ("Fog 45"); coded
  conditions now print no magnitude.
- Passages: `site/passages/index.json` is a catalogue, `site/boot.js` picks one and loads its data before the
  code that reads it, and a picker appears in Setup once more than one is bundled. Generated data moved to
  `site/passages/<id>/`. Settings, track and alert log are kept per passage. The service worker's precache list
  is generated from what is bundled, so switching passage works offline.
- No place name is left in the app code: the page title, ETA label, daylight note, destination-clock offsets
  and return-route button all come from the passage (`title`, `destinationShort`, `sunNote`, `tz.to.offsets`,
  `route.isReturn`).
- `tools/build_passage.py` regenerates `passage.js` from the passage JSON alone, with no Overpass fetch.
- AIS: a pasted key switches AIS on by itself, and every failure now says why -- close code and reason, the
  server's own error text, the subscribed bounding box, the message count, and a watchdog that separates a
  refused key from a quiet area. Class B extended positions and Class B static reports are subscribed too, so
  small craft appear with their names. Ship names and feed errors are escaped before they reach the page.

### Fixed
- **AIS never showed a ship, and this was why.** aisstream sends binary WebSocket frames whose payload is
  UTF-8 JSON. In a browser that arrives as a `Blob`, so `JSON.parse(event.data)` threw on every message and
  an empty `catch` swallowed it: no ships, no error, nothing. The socket asks for `ArrayBuffer` and decodes
  the bytes now, with a `Blob` path behind it; a frame that is not JSON reports what actually arrived
  instead of "[object Blob]". e2e drives the whole path over a mocked binary frame, from pasting the key in
  Setup to a target on the map.
- Zone alerts were driven by a table in `app.js` keyed by the Strait's own zone ids, and any id it did not
  recognise was skipped: another passage would have got no lane or zone warnings at all. They come from the
  passage data now.
- `weather.js` loaded before `passage.js` and captured `PASSAGE` as undefined, so it silently used its own
  built-in sample points, thresholds and time zone. Another passage would have been judged on the Strait of
  Gibraltar's weather. Data now loads first, and e2e asserts it.
- Its fallback was five fixed coordinates in the Strait; it samples the passage's own route instead.
- The service worker registered on the window `load` event, which has already fired when `boot.js` loads
  `app.js`: the app would have stopped working offline. e2e asserts the worker activates rather than hanging.
- `fetch_osm.py` wrote `land_osm.json` as a bare Polygon when the bbox held one connected land mass, and
  `build_chart.load_land` crashed on it. `overpass_get` catches `http.client.HTTPException` (a cut transfer).
- The cross-track bar's starboard tint was a hard-coded cyan that stayed cyan in night mode.

## 0.11.0 (2026-09-07)
Safety and trust pass driven by a six-lens critique and adversarial review, plus a reproducible chart build.
- Guards: land-ahead bounded by the verified route (harbour legs on track excluded), fix-quality gate (jumps rejected,
  poor and stale fixes never drive alerts), zone and hazard transitions debounced, holding-off guard on auto-advance,
  lane side of traffic and crossing heading derived from the flow bearing and the leg course (correct on the return route).
- Alerts: policy table with change-based repeats and a Quiet button, planned hazards briefed instead of alarmed,
  sentence-level speech queue where danger never cuts danger, persistent danger strip and visual flash.
- Weather: verdict block naming the governing reason and its margin, grouped reasons, INCOMPLETE instead of OK when data
  is missing, fog and thunderstorm considered, departure-window scan, beam and head sea flags, return-route course used.
- Passage lifecycle: resume after iOS kills the tab, passage-complete summary with hand-off to the return route.
- Helm: hold-to-arm MOB with a separate held cancel, hold-to-skip waypoints, anchor sheet with two-fix alarm, compass
  tape, position sharing, track export, printable pilotage card, Ready-for-sea self-test with one-tap fixes, boot watchdog.
- Live passage verdict: under way the Weather tab judges the rest of the passage from where you are (Now / Planned
  toggle) and compares carrying on with turning back; a verdict dot sits on the tab and a change of verdict is spoken.
- Forecast discipline: one fetch in flight at a time with backoff, quiet while navigating, refreshed on return to the
  foreground; the header shows fetch age and coverage end, and a stale forecast points at the VHF bulletin instead.
  Departure snaps to now when navigation starts more than 30 min off the plan.
- Colours: Automatic / Dark / Daylight / Night (red-amber on black, chart tinted to match), switched automatically at
  sunset and sunrise with an undo toast; night dimmer; big-numbers mode with a Chart button to bring the map back.
- Ships: AIS markers fade after two minutes without a report, stale targets leave the lane panel, HUD chip with the
  ship count and the nearest target.
- Land-ahead guard waits up to 30 s for the smoothed course to come round after a waypoint turn and needs two
  consecutive closing fixes: the old leg course at MALABATA, TANG-N and SOTO-OUT runs at the coast, so every turn
  there raised a false alarm. Found by the replay harness.
- Updates: atomic service-worker shell written only at install; a new build waits until you apply it; build stamp.
- Chart build reproducible from public data: `tools/fetch_osm.py` fetches coastline and seamarks for the passage bbox
  from Overpass (mirror fallback, retries, `--offline` re-polygonisation) and polygonises land with the OSM left-hand
  rule; `tools/build_chart.py` split into importable functions with a `main()` guard (outputs unchanged).
- Passage and TSS moved to validated data: `passages/<id>.tss.json` holds the scheme geometry, `schema/` holds the
  JSON schemas and `tools/validate_passage.py` runs before every build and in CI.
- Tests: node:test suites for nav, weather (thresholds, DST-safe hour lookup, departure scan, passage verdict) and AIS
  (CPA/TCPA, alarm window, pruning); `tools/unit.js` now runs the nav suite. Route replay harness `tools/replay.js` drives
  every bundled route through the app at 3, 5 and 22 kn and checks the alert sequence against `passages/<id>.expected.json`
  (`docs/TESTING.md`); `tests/build/` golden-tests the chart pipeline on a hand-written island-and-bay fixture.
  ESLint flat config; CI runs lint (non-blocking), node:test, e2e, the replay and the build tests.
- Licensing paperwork: `LICENSE` separates the MIT code from the data terms, `NOTICE` lists every data source
  (OpenStreetMap ODbL, IMO Circ.66, NGA Pub 131, Open-Meteo, Leaflet, tile providers), `docs/LICENSING.md` explains
  the obligations, Leaflet's licence and version are vendored.
- Project: return route.

## 0.10.0 (2026-09-06)
- Helm panel: phase-aware status (lane crossing with side of traffic, crossing heading, heading error, distance and
  time to clear), XTE highway bar, next-turn countdown, ETA in both zones, passage progress strip, trip statistics.
- One-tap MOB, Mark position, Repeat last instruction, big position display; waypoint skip with undo.
- Map: auto-zoom by distance to the next waypoint with look-ahead offset, zoom buttons, day (glare) theme,
  live wind and current arrows, charted wrecks/rocks as alarmed dangers, EMODnet depth overlay (online).
- Alerts: overlay banner without layout shift, prioritised speech queue, steer word derived from the actual turn needed,
  land-or-rocks-ahead guard, GPS-lost recovery, AIS CPA/TCPA alarms.
- Ships: optional aisstream.io AIS targets; three demo ships in the simulation.
- Offline: single-host tile keys, no blank placeholders stored, stale forecast marked, partial refresh keeps old points.
- Passage definition moved to `passages/strait-of-gibraltar.json`; MIT licence, unit tests, CI, docs.

## 0.9.0 (2026-09-06)
First usable release, built for one crossing (Sotogrande to Tanja Marina Bay, Tangier).
- Vector chart from OpenStreetMap coastline with the IMO Strait of Gibraltar TSS (COLREG.2/Circ.66), inshore zones,
  precautionary areas, lights, buoys and hazards.
- Two verified routes with land-clearance checks; GPS guidance (BRG, DIST, XTE, SOG, COG, TTG, ETA in both time zones),
  automatic waypoint advance, track.
- Spoken alerts: lane entry with the side ships come from, separation zone, precautionary areas, hazards (pre-warning
  with distance and bearing), off track, waypoint approach and arrival, harbour speed, GPS lost, sunset, weather.
- Open-Meteo wind, gust, wave, swell, surface current and tide at five route points; go / caution / no-go passage check.
- Offline: service worker shell cache, forecast cache, tile preload; single-file build for any static host.
- Plan and briefing pages, GPX export, checklist, emergency contacts.
