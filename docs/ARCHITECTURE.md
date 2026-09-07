# Architecture

Saily is deliberately small: a static page, no framework, no build step for the app, no backend.
Everything a helmsman needs offline is shipped inside the page.

```
passages/<id>.json  ──► tools/build_chart.py ──► site/passages/<id>/passage.js   (routes with legs, hazards, places, labels,
OSM extracts (scratch)        │  (validates with                    weather points, thresholds, briefing cards)
passages/<id>.tss.json ───────┴── validate_passage.py) ► site/passages/<id>/chart-data.js (land polygons, harbour detail, breakwaters,
  (IMO TSS positions, alert texts;                                  TSS lanes/zones/ITZ with alert texts and flowDeg,
   schema/*.schema.json)                                            anchorages, lights/buoys)
site/passages/index.json  the catalogue: what is bundled, which is the default, where each one's files are
site/index.html   markup + CSS (design tokens, instrument-panel layout, phone portrait/landscape, desktop two-column)
site/boot.js      picks the passage, loads its data, then the app: data always before the code that reads it
site/nav.js       pure geodesy: distance, bearing, cross-track, along-track, solve(), smoothing, sun, GPX
site/weather.js   Open-Meteo forecast + marine client, hourly merge, thresholds, passage check, tide extremes
site/app.js       state, GPS, alerts (beeps + prioritised speech), map layers, HUD, pages, preload, simulation
site/sw.js        service worker: shell cache-first, tiles cache-first, forecast network-first with stale marker
```

## Data flow at sea
1. `watchPosition` fix → `onFix()` derives SOG/COG (device values when trustworthy, otherwise from deltas,
   GPS jumps rejected) → smoothed.
2. `processFix()` runs `NAV.solve()` for the active waypoint: bearing, distance, XTE, along-track, remaining.
   Arrival is the radius or, unless the waypoint was selected by hand, the passed perpendicular.
3. Checks in order: navigation alerts (off track, approach, lane heading), zones (point-in-polygon against the
   TSS polygons, side of ships derived from COG), hazards (circles with a pre-warning band), harbour speed,
   weather at the nearest forecast point, sunset.
4. `alert()` writes the log, shows the banner, beeps by level, speaks by priority (danger interrupts).

## Offline model
- App shell is precached (`cache: 'reload'` so a new version never installs stale files).
- The vector chart, route, hazards and TSS are inside `chart-data.js` and `passage.js`, so the map works with no tiles.
- Tiles: cache-first; missing tiles offline return a transparent PNG so the vector chart shows through.
- Forecast: network-first; offline the last stored response is returned with an `X-Saily-Cache: stale` header so the
  app never re-stamps it as fresh. A partial refresh keeps the previous data for the failed points.
- Preload: CARTO corridor tiles (single host so keys match), OpenSeaMap seamarks, harbour zooms from OSM and Esri.

## Time zones
Two zones per passage (`tz.from`, `tz.to`). All API times are requested in the departure zone. The arrival clock can be
pinned to a fixed UTC offset in Setup when the device's time-zone database lags a legal change.

## Why a fixed route and not a routing engine
A strait crossing is a small number of deliberate legs chosen from official routeing (COLREG rule 10, TSS geometry,
port access channels). Encoding them as reviewed waypoints with per-waypoint spoken instructions is safer than
auto-routing over data we cannot license (official ENCs). Route editing is on the roadmap as an overlay on that base.
