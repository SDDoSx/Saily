# Passage format (`passages/<id>.json`)

One JSON file describes everything that is specific to a passage: the chart area, the marinas, the routes with
their spoken waypoint notes, the hazards, the place labels, the weather sample points and thresholds, the briefing
cards and checklist, and the traffic separation scheme file. `tools/build_chart.py` copies it to `site/passage.js`
(adding leg distances and bearings) and builds `site/chart-data.js` from it; `tools/fetch_osm.py` uses `bbox` and
`places` to fetch the OpenStreetMap inputs. The schema is `schema/passage.schema.json`; `tools/validate_passage.py`
validates the file and its TSS file and the builder refuses to run on an invalid one.

The bundled example is `passages/strait-of-gibraltar.json`; `docs/ADAPTING.md` walks through making a new one.

## Top level

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Lower-case slug: `strait-of-gibraltar`. Names the file, `<id>.expected.json` (replay) and `chart.meta.passage`. |
| `version` | | Integer, bump when the route changes materially. |
| `name`, `title`, `description` | `name` | Long name, short title for the start screen (`"Sotogrande → Tangier"`), one-paragraph description. |
| `bbox` | yes | `[south, west, north, east]` in decimal degrees: the chart area and the Overpass extract area. |
| `tss` | | Traffic separation scheme file, relative to this file: `"strait-of-gibraltar.tss.json"` (`docs/TSS-DATA.md`). Omit when the area has none. |
| `tz` | | `{"from": {"label": "ES", "zone": "Europe/Madrid"}, "to": {"label": "MA", "zone": "Africa/Casablanca", "note": "..."}}`: departure and arrival zones (IANA names, checked against the tz database) for the two clocks. |
| `vessel` | | `name`, `cruiseKn` (planning speed), `burnLph`, `fuelL`, `draftM`. |
| `defaultDeparture` | | `HH:MM` local (departure zone) proposed for the passage check. |
| `destinationShort` | | Word used in "ETA Tangier". |
| `sun` | | `{lat, lon}` where sunrise and sunset are computed. |
| `places` | yes | Marinas keyed by a slug (`sotogrande`, `tangier`): `name`, `lat`, `lon`, `vhf`, `phone`, `tz`, optional `detailBox` `[s, w, n, e]` for the harbour-detail land extract (default ±0.025°). |
| `harbourWaypoints` | | Waypoint ids inside harbours. Legs touching them are exempt from the builder's 0.25 nm land-clearance warning and from the land-ahead guard when on track. |
| `harbourSpeedKn` | | Speed above which the app warns within 0.3 nm of a place (default 4). |
| `routes` | yes | See below. |
| `hazards` | yes | See below. |
| `labels` | | Place names for the vector chart: `lat`, `lon`, `name`, `kind` (CSS class: `sea`, `town`, `cape`, `island`), `z` (minimum zoom). |
| `weatherPoints` | | Open-Meteo sample points: `id`, `name`, `lat`, `lon`, `routeNm` (distance from departure along the recommended route; the forecast is read at the time the boat gets there). `routeNm` must not decrease along the list. |
| `thresholds` | | `windCaution`, `windNoGo`, `gustCaution`, `gustNoGo` (kn), `waveCaution`, `waveNoGo` (m), `currentCaution` (kn), `visCaution` (m). Missing keys use the defaults in `weather.js`; each caution must be below its no-go. |
| `checklist` | | Strings shown as tick boxes on the Plan page. |
| `cards` | | Briefing cards: `id`, `title`, `html` (a `<div class="card">`). |
| `weatherNotes` | | HTML shown on the Weather page. |
| `weatherVhf` | | One line: where the coastal forecasts are broadcast. |
| `variationDeg` | | Magnetic variation, east positive, for the magnetic compass readout. |

Unknown top-level keys are allowed (the validator warns) and copied to `passage.js` unchanged; the objects inside
the known keys are strict, so a misspelt `radiusNm` on a waypoint is an error.

## Routes and waypoints

```json
{"id": "tarifa", "short": "Tarifa crossing", "name": "Recommended: ...", "recommended": true,
 "summary": "Follow the Spanish coast inside the northern inshore traffic zone to Tarifa, cross both lanes on 180 T ...",
 "waypoints": [
   {"id": "X-NORTH", "name": "Crossing point north", "lat": 35.98, "lon": -5.7, "radius": 0.15,
    "note": "Turn to 180 T. Cross the TSS at right angles, do not slow down. First the WESTBOUND lane: ships come from your LEFT (east)."}
 ]}
```

- `id`: slug; one route should be `recommended` (the app starts on it).
- Waypoint `id`: upper case (`SOTO-HEAD`, `X-NORTH`), unique within the route, spoken and shown on the HUD.
- `radius`: arrival radius in nautical miles (default 0.1). Small in harbours (0.03), 0.15–0.2 at sea.
- `note`: read aloud on arrival. Write it as the instruction the helmsman must act on now, with the next hazard.
- The builder adds `legs` (`from`, `to`, `dist` nm, `brg` true) and `total` to each route in `passage.js`, prints a
  `LEG` line per leg with its distance to land and the TSS polygons it crosses, and warns about legs closer than
  0.25 nm to land that do not touch a harbour waypoint.

## Hazards

```json
{"id": "soto_shoal", "lat": 36.2815, "lon": -5.27127, "radius": 0.12, "level": "danger",
 "name": "Shoal at Guadiaro mouth (marina notice 20 Feb 2026)",
 "note": "Puerto Sotogrande reports a dangerous reduction of depth ... Keep well clear; leave and approach from the E/SE."}
```

Circles. `level` `danger` pre-warns 0.15 nm out and alarms inside; `caution` and `info` are spoken once inside
(a caution hazard the planned route passes through is briefed, not alarmed). Keep the source in the name or note
(`Pub 131`, a port notice with its date): the next person must be able to verify it.

## Checks beyond the schema

`tools/validate_passage.py` also checks: bbox order; every waypoint, hazard, label, weather point and place inside
the bbox; waypoint ids unique within a route and no zero-length leg; route ids unique; exactly one recommended
route (warning); `harbourWaypoints` exist in some route; hazard, weather-point and card ids unique;
`weatherPoints[].routeNm` non-decreasing; caution thresholds below no-go; IANA time zones known; the `tss` file
exists and is valid (`docs/TSS-DATA.md`).

Run it on demand with `python3 tools/validate_passage.py [passages/<id>.json]` (`--strict` makes warnings fail,
as CI does). It uses the `jsonschema` library when installed (`pip install -r tools/requirements.txt`) and a
built-in checker for the subset of JSON Schema the two schemas use otherwise, with the same messages.

## Gibraltar example

`passages/strait-of-gibraltar.json`: three routes (`tarifa` recommended, `east`, `return`), 15 hazards, 18
labels, 5 weather points, thresholds for a 36 ft planing motor yacht, an 11-item checklist and 5 briefing cards.
Its TSS is `passages/strait-of-gibraltar.tss.json`. Build with
`python3 tools/build_chart.py <scratch> site/chart-data.js` after `python3 tools/fetch_osm.py passages/strait-of-gibraltar.json <scratch>`.
