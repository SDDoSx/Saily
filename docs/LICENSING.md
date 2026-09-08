# Licensing

Saily mixes MIT-licensed code with data that carries its own terms. This page says which is which, what a
fork must do, and where each notice lives. The binding texts are [`LICENSE`](../LICENSE) (the licence) and
[`NOTICE`](../NOTICE) (the third-party inventory); this page explains them.

## At a glance

| What | Where | Terms | A fork must |
|---|---|---|---|
| Code | `site/*.js` except the two generated files, `site/index.html`, `site/sw.js`, `tools/`, `tests/` | MIT | keep the copyright and permission notice |
| Passage definition | `passages/*.json`, `site/passages/<id>/passage.js` | MIT text written for this project; quotes facts from IMO, NGA Pub 131 and port notices | keep the source citations inside the notes |
| Vector chart | `site/passages/<id>/chart-data.js`; embedded in `dist/saily.html` and `tools/out/saily-standalone.html` | **ODbL 1.0** (OpenStreetMap derivative database) | show "© OpenStreetMap contributors", share-alike, keep `NOTICE` |
| TSS geometry | `passages/strait-of-gibraltar.tss.json` (positions), `chart-data.js` `tss` block | IMO COLREG.2/Circ.66 positions cited as facts | not copy the circular's text; verify against the scheme in force |
| Pilotage notes | `passages/strait-of-gibraltar.json` | NGA Pub 131, public domain | keep the "Pub 131" citation |
| Forecast fixtures and snapshots | `tools/fixtures/fc.json`, `tools/fixtures/marine.json`, `tools/out/wx_snapshot.json`, the forecast inside `dist/saily.html` | Open-Meteo, CC BY 4.0 | keep "Weather data by Open-Meteo.com" |
| Map library | `site/vendor/leaflet/` | Leaflet 1.9.4, BSD-2-Clause | keep `site/vendor/leaflet/LICENSE` |
| Tiles, depth, AIS at run time | OpenStreetMap, OpenSeaMap, Esri, EMODnet, aisstream.io | each provider's terms | keep the attribution control; respect the preload limits |

## Code: MIT

Everything that is not data is MIT (`LICENSE`, second half). That covers the app (`app.js`, `nav.js`, `weather.js`,
`ais.js`, `sw.js`, `index.html`), the build and test tools, the workflows and the docs. Copy, change and sell it;
keep the notice.

`passages/*.json` and the generated `site/passages/<id>/passage.js` are treated as code: the route, the spoken notes, the checklist
and the briefing cards were written for this project. They *cite* facts from the IMO circular, NGA Pub 131 and the port
notices (positions, depths, light characteristics, VHF channels). Keep those citations when you edit the notes so the
next person can verify them.

## Vector chart: OpenStreetMap under the ODbL

`site/passages/<id>/chart-data.js` is built by `tools/build_chart.py` from OpenStreetMap data fetched by `tools/fetch_osm.py`
(coastline ways, `seamark:*` nodes and ways, breakwaters and piers). Under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) that file is a **Derivative Database**:
OSM data extracted, polygonised, simplified and rounded. The map the app draws from it is a **Produced Work**.
The `tss` block inside the same file is not OSM (see the next section); everything else in it is.

What the ODbL requires, and how Saily meets it:

- **Attribution (section 4.3).** "© OpenStreetMap contributors" must be visible wherever the chart is shown. The app
  puts it in the Leaflet attribution control (`chart-data.js` also carries `meta.sources`) and on the About card. Do
  not remove or hide either.
- **Share-alike (section 4.4).** If you publicly use a modified chart (new bbox, another passage, extra seamarks) you
  must offer that chart under the ODbL. The simple way is what this repository does: keep `site/passages/<id>/chart-data.js`
  committed in a public repository and reproducible with the two commands in `docs/ADAPTING.md`. Do not merge data
  whose licence is incompatible with the ODbL into it, in particular official electronic or raster chart data from a
  hydrographic office, which is copyrighted and not share-alike.
- **Keep notices intact (section 4.6).** Keep `NOTICE` with every copy, including single-file builds. The data date is
  the `osm3s.timestamp_osm_base` field of the Overpass extracts (`coast.json`, `harbours.json`) in the scratch
  directory; `NOTICE` records it for the shipped chart.
- **The MIT licence does not extend to this file.** A downstream user who takes `chart-data.js` takes it under the
  ODbL, whatever the rest of the repository says.

## Traffic separation scheme: IMO COLREG.2/Circ.66

The TSS polygons (lanes, separation zones, precautionary areas, inshore traffic zones) are computed by
`tools/build_chart.py` from the 25 positions of Annex 1 of COLREG.2/Circ.66 ("In the Strait of Gibraltar", adopted
21 November 2014, in force 1 June 2015) transcribed in `passages/strait-of-gibraltar.tss.json` (`docs/TSS-DATA.md`). Those positions are reproduced as **facts**: a position is not a copyrightable
expression. The circular's text and figures are copyright of the International Maritime Organization and are not
reproduced; the briefing paraphrases the rules in the app's own words.

Safety, not licensing: the scheme in force is the one promulgated by IMO and printed on the official charts. Amending
circulars are issued from time to time. Anyone adapting Saily to another area must transcribe the current circular
for that area into its own `.tss.json`, in their own words for the notes, and must not copy TSS geometry from a map
database (`docs/ADAPTING.md`, step 3).

## Pilotage notes: NGA Pub 131

Hazard descriptions marked "Pub 131" in `passages/strait-of-gibraltar.json` (La Perla rocks, Banco de Fenix, races,
tidal sets) are paraphrased from NGA Publication 131, *Sailing Directions (Enroute) Western Mediterranean*, published
by the US National Geospatial-Intelligence Agency. As a work of the United States Government it is in the public domain
(17 U.S.C. § 105). NGA's own caveat applies: sailing directions supplement, and never replace, the official charts.

## Forecasts: Open-Meteo, CC BY 4.0

`tools/fixtures/fc.json` and `tools/fixtures/marine.json` are recorded responses of the Open-Meteo forecast and marine
APIs used by the tests. `tools/out/wx_snapshot.json` and the `EMBEDDED_WX` block of `dist/saily.html` and
`tools/out/saily-standalone.html` are forecast snapshots embedded in the single-file build, and the app caches live
responses on the device. All of this is Open-Meteo data under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): keep the "Weather data by Open-Meteo.com" attribution on the
Weather page and the About card, and in any redistributed single-file build.

## Map library: Leaflet 1.9.4, BSD-2-Clause

`site/vendor/leaflet/` holds Leaflet 1.9.4 (`leaflet.min.js`, `leaflet.css`, `images/`). The licence text is in
`site/vendor/leaflet/LICENSE` and the version and origin in `site/vendor/leaflet/VERSION`. The single-file build inlines
the library; the BSD licence asks that the copyright notice travels with binary redistributions, which `NOTICE` and the
vendored `LICENSE` file provide.

## Run-time services: tiles, depth, AIS

Raster tiles are optional; the vector chart works without them. The app fetches tiles from the providers below and
caches them on the device for offline use (Setup → Preload). Each provider has its own terms; the app only ever shows
tiles with the provider's attribution, and the preload is limited on purpose. If you change the preload areas or zoom
levels in `app.js` (`tileUrls()`), re-read the terms first.

| Provider | Used for | Attribution shown | Terms | Preload |
|---|---|---|---|---|
| ~~CARTO Voyager~~ | **removed in 0.15.2** | — | CARTO now returns keyless tiles stamped "API KEY REQUIRED" across the image. If you want it back, get a key and add it to `BASES` yourself | — |
| OpenStreetMap standard (`tile.openstreetmap.org`) | alternative base map | © OpenStreetMap contributors | [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/): attribution, no bulk download, valid User-Agent/Referer | two harbour boxes only, zoom 14-16 |
| OpenSeaMap (`tiles.openseamap.org`) | seamark overlay | © OpenSeaMap | [openseamap.org](https://www.openseamap.org): tiles CC BY-SA 2.0, data ODbL | corridor zoom 10-13, harbours zoom 14-16 |
| Esri World Imagery (`server.arcgisonline.com`) | satellite base map | Imagery © Esri (full credit line: "Esri, Maxar, Earthstar Geographics, and the GIS User Community") | [Esri terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement): attribution required; offline caching of basemap tiles is restricted, keep the preload small | harbours only, zoom 14-16 |
| EMODnet Bathymetry WMS (`ows.emodnet-bathymetry.eu`) | depth shading and contours (online only) | EMODnet Bathymetry | [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry): free of charge with attribution; DTM products CC BY 4.0 | not preloaded |
| aisstream.io | optional AIS targets with a user-supplied key | n/a (targets are not stored) | [aisstream.io](https://aisstream.io) terms | n/a |

Nothing fetched from these services is stored in the repository.

## Port notices

The Puerto Sotogrande safety notice of 20 February 2026 (Guadiaro shoal) and the Tanja Marina Bay guide 2026 (access
channel, VHF, berthing) are quoted as facts in the passage definition. The documents belong to the ports. Verify them
before a passage: notices expire.

## Checklist for forks and new passages

1. Keep `LICENSE`, `NOTICE`, `site/vendor/leaflet/LICENSE` and this page with every copy, including single-file builds.
2. Keep `site/passages/<id>/chart-data.js` public and reproducible (ODbL share-alike) and the OpenStreetMap attribution visible.
3. Add every new data source to `NOTICE` with its terms. Never paste geometry from official charts (ENC, raster) or
   commercial chart products into the chart: hydrographic office data is copyrighted and not ODbL-compatible.
4. Update `meta.sources` in `tools/build_chart.py` so the About card lists your sources.
5. Keep the "not an official nautical chart" statement visible. Saily is an aid; the official chart, a lookout and the
   COLREGs come first.
