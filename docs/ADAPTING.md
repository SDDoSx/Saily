# Adapting Saily to another passage

1. Copy `passages/strait-of-gibraltar.json` to `passages/<your-id>.json` and edit:
   - `bbox`: the chart area (south, west, north, east).
   - `tz`: departure and arrival time zones and labels.
   - `vessel`: cruise speed (kn), fuel burn (L/h), fuel capacity, draft.
   - `places`: marinas with VHF and phone.
   - `routes`: each with `waypoints` (`id`, `name`, `lat`, `lon`, `radius` nm, `note` read aloud on arrival) and `recommended`.
   - `hazards`: circles with `level` (`danger` pre-warns 0.15 nm out, `caution`, `info`) and a note read aloud.
   - `labels`: place names for the vector chart with the zoom level they appear at.
   - `weatherPoints`: where Open-Meteo is sampled, with `routeNm` (distance from departure) for the passage check.
   - `thresholds`: go/caution/no-go limits for your boat.
   - `checklist`, `cards` (briefing HTML), `weatherNotes`.
2. Fetch coastline and seamarks for the bbox from Overpass into a scratch directory (see the queries in the git
   history of `tools/build_chart.py`: `natural=coastline` ways and `seamark:type` nodes/ways), and polygonise land
   with the left-hand rule (the script does this from `coast.json`).
3. Traffic separation schemes: transcribe the IMO coordinates for your area into `tools/build_chart.py` (the
   Gibraltar block shows the pattern: separation zone centrelines with a half-width, lane outer limits,
   precautionary areas, inshore zone limits). Never copy TSS geometry from a map database without checking it
   against the IMO circular in force.
4. Run `python3 tools/build_chart.py <scratch> site/chart-data.js passages/<your-id>.json`. The script prints every
   leg's distance to land and which TSS polygons it crosses; fix waypoints until only the deliberate crossings remain.
5. Run `node tools/unit.js` and `node tools/e2e.js`, then test on the phone in simulation mode.

Everything the app says aloud comes from the JSON notes: write them as instructions a helmsman can act on.
