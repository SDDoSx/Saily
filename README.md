# Saily · Sotogrande → Tangier passage app

Offline-capable GPS passage guide for one crossing of the Strait of Gibraltar in a Jeanneau Prestige 36:
Puerto Sotogrande → Tanja Marina Bay (Tangier). Runs in Safari on iPhone and Mac as a home-screen web app.

## What it does
- **Vector chart built in**: coastline from OpenStreetMap, the IMO traffic separation scheme (COLREG.2/Circ.66) with lanes,
  separation zones, precautionary areas and inshore zones, lights, buoys, charted wrecks and rocks, and place labels.
  Raster tiles (CARTO, OpenStreetMap, satellite, OpenSeaMap seamarks, EMODnet depth) are an optional layer on top.
- **Route guidance**: verified waypoints with pilotage notes read aloud, bearing and distance to the next waypoint,
  cross-track error with an XTE highway bar, steering cue, next-turn countdown, ETA in both time zones, passage progress strip,
  automatic waypoint advance with undo, MOB, mark position, repeat last instruction, big position display for a MAYDAY.
- **Alerts at the helm** (spoken and on screen): entering a traffic lane with the side ships come from and the crossing heading,
  separation zone, precautionary area, hazards with a pre-warning at 0.15 nm (shoals, rocks, wrecks, races), land or rocks
  on your heading within four minutes, off track, waypoint approach and arrival, harbour speed, GPS lost and back,
  sunset, weather thresholds.
- **Ships**: optional AIS targets from aisstream.io (free key) with CPA/TCPA and a danger alert when a ship will pass
  within 0.5 nm in the next 12 minutes; demo ships in the simulation.
- **Weather that decides**: Open-Meteo wind, gusts, waves, swell, surface current and tide at five route points, sampled
  at the time you reach each point; go / caution / no-go with reasons; wind-against-current flag; live wind and current
  arrows on the chart; tide state and daylight left on the panel. Under way it re-judges the rest of the passage from
  where you are and compares carrying on with turning back; a change of verdict is spoken.
- **Alerts you can trust**: every guard is bounded by the verified route, poor GPS fixes never trigger anything, zone
  transitions are debounced, repeats are change-based with a Quiet button, and danger speech never cuts danger speech.
  A route replay harness walks every bundled route through the real guards in CI.
- **Ready for sea**: a self-test on the start screen and in Setup (offline cache, tiles, forecast age, location
  permission, wake lock, sound) with one-tap fixes; resume after the phone kills the tab; printable pilotage card.
- **Works offline**: app shell, forecast and tiles are cached; the chart, route, TSS and hazards never need a network.
  New builds wait until you choose to apply them, never mid-passage.
- **Phone first**: portrait and landscape layouts, auto-zoom with look-ahead, wake lock, sound through the silent
  switch, one-hand map controls.
- **Readable at any hour**: Automatic, Dark, Daylight (glare) and Night colours; night is red-amber on black so it does
  not spoil your night vision, switches itself at sunset with an undo toast, and dims further on request. Big-numbers
  mode drops the chart for the figures that matter, with a Chart button to bring it back. (Setup, Colours.)
- **Passage as data**: `passages/*.json` holds the route, hazards, places, weather points, thresholds and briefing; the
  build script turns it into the chart. See `docs/ADAPTING.md`.

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
Once: `npm install && npx playwright install chromium` (browser tests), and `pip install -r tools/requirements.txt`
(chart build and passage validation). The `NODE_PATH` in the npm scripts is only a fallback for environments with a
global Playwright; a local `node_modules` takes precedence.
- `npm test` runs the unit tests, the node:test suites and the Playwright smoke test (mobile + desktop, offline reload).
- `npm run test:replay` replays every bundled route through the app at 3, 5 and 22 kn and checks the alert sequence
  against `passages/*.expected.json`. See `docs/TESTING.md`.
- `npm run validate` and `npm run test:build` check the passage/TSS JSON against `schema/` and golden-test the chart
  pipeline on a fixture.
- `python3 tools/fetch_osm.py passages/strait-of-gibraltar.json <scratch-dir>` fetches the OSM extracts, then
  `python3 tools/build_chart.py <scratch-dir> site/chart-data.js` regenerates the chart.
- `node -e "require('./site/nav.js')"` for the pure geodesy functions.
- `npm start` serves `site/` locally.

Data: OpenStreetMap contributors (ODbL), IMO COLREG.2/Circ.66, NGA Pub 131, Puerto Sotogrande notices, Tanja Marina Bay guide 2026,
Open-Meteo (CC BY 4.0), CARTO / Esri / OpenSeaMap tiles.
Licences: code MIT, chart data ODbL (share-alike), forecasts CC BY 4.0, tiles under provider terms: see [docs/LICENSING.md](docs/LICENSING.md).
