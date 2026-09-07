# Changelog

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
