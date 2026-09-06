# Saily · Sotogrande → Tangier passage app

Offline-capable GPS passage guide for one crossing of the Strait of Gibraltar in a Jeanneau Prestige 36:
Puerto Sotogrande → Tanja Marina Bay (Tangier). Runs in Safari on iPhone and Mac as a home-screen web app.

## What it does
- Route with 15 verified waypoints (Spanish inshore zone, right-angle crossing of the TSS at 5°42'W, Moroccan
  inshore zone, official Tanja Marina Bay access channel) plus an alternative east crossing. Legs checked against
  the OSM coastline for land clearance.
- Vector chart built in: coastline, harbour breakwaters, the IMO traffic separation scheme (COLREG.2/Circ.66 coordinates),
  precautionary areas, inshore zones, anchorages, lights and buoys, hazards (Sotogrande shoal notice Feb 2026,
  La Perla, Tarifa race, Banco de Fenix, Almirante Rock, Buoree Rock, Tangier shoals). Works with no tiles at all.
- GPS: bearing/distance to waypoint, cross-track error with steer arrow, SOG/COG, TTG, ETA in Spanish and Moroccan time,
  automatic waypoint advance, track.
- Spoken and audible alerts: entering lanes (which side ships come from), separation zone, precautionary areas,
  hazards, off track, approaching waypoint, harbour speed, GPS lost, sunset, weather thresholds.
- Weather: Open-Meteo wind (10 m, gusts) and marine (waves, swell, surface current incl. tide, sea level) at five
  route points, passage check with go / caution / no-go thresholds, wind-against-current flag, hourly table, tide extremes.
- Preload for offline use (app shell, 3-day forecast, map tiles for the corridor and both harbours).
- Plan page: legs, waypoints in degrees/minutes, GPX export, marina and formalities briefing, COLREG rule 10 summary,
  emergency and VHF reference, departure checklist.

## Deploy (GitHub Pages)
The workflow `.github/workflows/pages.yml` publishes `site/` on every push to `main` or this branch.
GitHub Pages must exist first, and the workflow token cannot create it:
1. GitHub Free serves Pages only from **public** repositories: Settings → General → Danger zone → Change visibility → Public.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Re-run the failed "Deploy Saily to GitHub Pages" run (Actions tab) or push again. If the run reports
   "not allowed to deploy to github-pages due to environment protection rules", either merge this branch into `main`
   or add the branch under Settings → Environments → github-pages → Deployment branches.
4. Open https://sddosx.github.io/Saily/ (path is case-sensitive).

Any static host works too: `site/` is plain files, and `tools/out/saily-standalone.html` (built by
`tools/build_single.py`) is a single self-contained file with the chart and a forecast snapshot embedded.

## Use on the boat
1. On wifi, open the site in Safari, tap Share → **Add to Home Screen**, then open it from the icon
   (keeps the cache, fullscreen; wake lock works on iOS 18.4+).
2. Setup tab → **Preload everything** (forecast + tiles). Then airplane-mode test: the app must open and show the chart.
3. Before departure: Weather tab → passage check; Plan tab → checklist, call the marina.
4. On deck: tap **Start navigation**. Keep the phone on deck with a clear sky view, plugged in, screen on.
   iOS only delivers GPS while the page is in front with the screen on.
5. The app is an aid. Keep a lookout, obey COLREGs, and use the boat's plotter and VHF.

## Development
- `python3 tools/build_chart.py <scratch-dir> site/chart-data.js` regenerates the chart (needs the OSM extracts in the scratch dir).
- `NODE_PATH=/opt/node22/lib/node_modules node tools/e2e.js` runs the Playwright smoke test (mobile + desktop, offline reload).
- `node -e "require('./site/nav.js')"` for the pure geodesy functions.

Data: OpenStreetMap contributors (ODbL), IMO COLREG.2/Circ.66, NGA Pub 131, Puerto Sotogrande notices, Tanja Marina Bay guide 2026,
Open-Meteo (CC BY 4.0), CARTO / Esri / OpenSeaMap tiles.
