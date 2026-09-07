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
2. Fetch the OpenStreetMap inputs for the bbox and build the chart, two commands (`pip install -r tools/requirements.txt`
   first, it needs shapely):
   ```
   python3 tools/fetch_osm.py passages/<your-id>.json <scratch>
   python3 tools/build_chart.py <scratch> site/chart-data.js passages/<your-id>.json
   ```
   `fetch_osm.py` queries Overpass for the `natural=coastline` ways and the `seamark:type` / `man_made` harbour
   structures in the bbox, stores them as `coast.json` and `harbours.json`, and polygonises land with the OSM left-hand
   rule (land is on the left of a coastline way) into `land_osm.json` plus a finer `land_<place>.json` for each entry of
   `places` (±0.025° around the place, or the place's own `"detailBox": [south, west, north, east]`). Overpass mirrors
   are slow and flaky: `--mirror <url>` picks another endpoint, `--timeout` and `--retries` tune the backoff, and
   `--offline` re-polygonises from an existing `coast.json` without any network. The data is ODbL: see
   `docs/LICENSING.md` before publishing a chart.
3. Traffic separation schemes: transcribe the IMO positions for your area into `passages/<your-id>.tss.json` and
   name it in the passage file (`"tss": "<your-id>.tss.json"`). `passages/strait-of-gibraltar.tss.json` shows the
   pattern: numbered points as printed in the circular, separation zones as a centreline with a half-width, lanes
   as the region minus the zone on one side, precautionary areas, inshore zones clipped to the coast, and the
   alert text and level for each element (`docs/TSS-DATA.md`, schema `schema/tss.schema.json`). Never copy TSS
   geometry from a map database without checking it against the IMO circular in force, and say who checked it in
   `checkedBy`. `python3 tools/validate_passage.py passages/<your-id>.json` checks both files; the builder runs it
   first and refuses invalid data (`docs/PASSAGE-FORMAT.md` lists every field of the passage file).
4. Re-run `python3 tools/build_chart.py <scratch> site/chart-data.js passages/<your-id>.json` after every waypoint
   change. The script prints every leg's distance to land and which TSS polygons it crosses; fix waypoints until only
   the deliberate crossings remain.
5. Run `node --test tests/*.test.js`, then `node tools/replay.js --write` and read the printed sequence of lane, zone and
   waypoint alerts for every route and speed before committing `passages/<your-id>.expected.json` (see `docs/TESTING.md`).
   Run `node tools/e2e.js`, then test on the phone in simulation mode.

Everything the app says aloud comes from the JSON notes: write them as instructions a helmsman can act on.
