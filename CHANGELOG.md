# Changelog

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
