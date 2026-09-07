# Handover (2026-09-07, session paused mid-integration)

Branch: `claude/marine-nav-app-yacht-erflpd`. Live app for the owner: raw.githack.com serving this branch
(`site/index.html`). GitHub Pages is still not enabled on the repo (owner must set Settings, Pages, Source =
GitHub Actions; the workflow `.github/workflows/pages.yml` is ready).

## State of the tree

Committed (HEAD b2f6d33, verified: `node tools/unit.js` 22/22, `node --test tests/*.test.js` 50/50,
`node tools/e2e.js` 0 errors, `node tools/replay.js --speed 22` PASS on all three routes):

- Live passage verdict under way (Weather tab: Now/Planned toggle, carry-on vs turn-back line), verdict dot on the
  Weather tab, forecast fetch discipline (single in-flight, backoff, quiet while navigating, foreground refresh,
  spoken verdict change), stale banner with the VHF bulletin fallback, departure snaps to now on Start.
- Colours: Automatic / Dark / Daylight / Night (red-amber), night dimmer, big-numbers mode with a Chart button.
- AIS: markers fade after 2 min, stale targets leave the lane panel, HUD ship chip.
- Land-ahead guard: 30 s turn grace after a waypoint change plus two-fix confirmation. The replay harness found
  false "Land or rocks ahead" alarms right after the MALABATA, TANG-N and SOTO-OUT turns (old leg course runs at
  the coast while the smoothed COG settles). This is a real safety fix; keep it.

Uncommitted, in the working tree, produced by three background agents on disjoint files (none touch
`site/app.js`, `site/index.html`, `site/weather.js`, `site/sw.js`, `site/nav.js`, `site/ais.js`):

1. Replay harness and tests: `tools/replay.js`, `passages/strait-of-gibraltar.expected.json`, `tests/*.test.js`
   (node:test, `tools/unit.js` now delegates to them), `eslint.config.js`, `docs/TESTING.md`, CI and package.json
   wiring.
2. OSM fetch pipeline and licensing: `tools/fetch_osm.py`, `tools/requirements.txt`, `tests/build/` (fixtures,
   golden files, `test_build_chart.py`), `LICENSE` rewritten (MIT plus data terms), `NOTICE`, `docs/LICENSING.md`,
   `site/vendor/leaflet/VERSION`, small additive hunks in README, CONTRIBUTING, CHANGELOG, ADAPTING.
3. Passage schema and TSS as data: `passages/strait-of-gibraltar.tss.json` (TSS moved out of
   `tools/build_chart.py`), `schema/`, `tools/validate_passage.py` (runs before every build and in CI),
   `docs/TSS-DATA.md`, `docs/PASSAGE-FORMAT.md`, `tools/build_chart.py` refactored into importable functions.
   `site/chart-data.js` and `site/passage.js` were regenerated: additive fields only (level/enter/leave/flowDeg/
   crossing on TSS elements, tss.anchorages; passage gains tss, variationDeg, weatherVhf). Verified by the review
   agent: 0 removed or changed values against HEAD.

## Review findings on the agent work (not yet fixed)

- `tools/fetch_osm.py` writes `land_osm.json` as a Polygon when the bbox holds one connected land mass;
  `build_chart.load_land()` then crashes on `.geoms`. Always emit a MultiPolygon (or wrap in load_land) and add a
  one-polygon case to `tests/build`.
- `LICENSE` bullet 2 still says the IMO positions live in `tools/build_chart.py`; they are in
  `passages/strait-of-gibraltar.tss.json`.
- `site/vendor/leaflet/VERSION` misdescribes leaflet.min.js: it is cdnjs's own minification of 1.9.4, not
  dist/leaflet.js minus the header.
- Add `__pycache__/` to `.gitignore` (tests/build creates one).
- `fetch_osm.overpass_get` should also catch `http.client.HTTPException` (IncompleteRead from a cut transfer).
- Two verify agents died on the usage limit (replay and schema deliverables were not independently reviewed).
  The replay harness itself was exercised by me and behaves; the schema/validator work only through the build
  byte-identity check above.

## Next steps, in order

1. Fix the five findings above (small edits).
2. Run the full check set: `node tools/unit.js`, `node --test tests/*.test.js`,
   `python3 tests/build/test_build_chart.py`, `python3 tools/validate_passage.py passages/strait-of-gibraltar.json`,
   `NODE_PATH=/opt/node22/lib/node_modules node tools/e2e.js`, and
   `NODE_PATH=/opt/node22/lib/node_modules node tools/replay.js --quiet` (all speeds; the 3 and 5 kn runs were
   started but their log was empty when the session paused, so treat them as unverified).
3. Merge the two "Unreleased" headings in `CHANGELOG.md` into one 0.11.0 entry and add the app changes from
   commit b2f6d33; add one README bullet for night colours, big numbers and the live verdict.
4. Rebuild the single-file artifact: `python3 tools/build_single.py dist/saily.html tools/out/wx_snapshot.json`,
   then `python3 tools/stamp_build.py` (stamps `site/sw.js` VERSION and `site/version.json`).
5. Commit everything, push with `git push -u origin claude/marine-nav-app-yacht-erflpd` (origin is two commits
   behind HEAD already), republish the claude.ai artifact from `dist/saily.html` at the same file path, and check
   the githack URL loads.
6. Tell the owner: Pages still needs enabling; night colours switch automatically after sunset (undo toast, or
   Setup, Colours).

## Conventions

Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01U5VtLSQ7XmXKGhVuge81bx`. No model names in code or commits.
Never push to another branch. Do not create a PR unless asked. Scratch data for the chart build lives in the
session scratchpad (coast.json, harbours.json, land_*.json, circ66.txt); a fresh session must re-fetch with
`tools/fetch_osm.py` (Overpass mirrors are flaky from the sandbox; kumi.systems answered).
