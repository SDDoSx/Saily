# Changelog

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
