#!/usr/bin/env node
/* Check a passage's routes against a chart, with the same geometry the app uses.
 *
 * The Python builder prints its own leg report and carries on. This refuses: a chart is about to be
 * committed and published, and a route that runs into land should not be published with it.
 *
 * Usage: check_route.js <passage.json> <chart-data.js> [--clear 0.25]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const N = require(path.join(__dirname, '..', 'site', 'nav.js'));

function loadGlobal(file) {
  const src = fs.readFileSync(file, 'utf8');
  const w = {};
  new Function('window', 'return (function(){' + src + '})()').call(w, w);
  return w;
}

function main(argv) {
  const passageFile = argv[0], chartFile = argv[1];
  if (!passageFile || !chartFile) { console.error('usage: check_route.js <passage.json> <chart-data.js>'); return 2; }
  const clearNm = Number((argv.includes('--clear') ? argv[argv.indexOf('--clear') + 1] : 0.25)) || 0.25;

  const pz = JSON.parse(fs.readFileSync(passageFile, 'utf8'));
  const C = loadGlobal(chartFile).CHART;
  if (!C || !C.land) { console.error(`${chartFile}: no CHART.land`); return 2; }

  const areas = [];
  for (const g of ['lanes', 'zones', 'precautionary']) for (const e of ((C.tss && C.tss[g]) || [])) areas.push({ id: e.id, rings: e.rings });
  const harbourIds = pz.harbourWaypoints || [];
  const lat0 = (C.meta.bbox[0] + C.meta.bbox[2]) / 2;

  let bad = 0, checked = 0;
  for (const r of pz.routes || []) {
    console.log(`\n${r.id}: ${r.name}`);
    const rows = N.checkLegs(r.waypoints, C.land, areas, { clearNm, harbourIds, lat0 });
    for (const l of rows) {
      checked++;
      const flag = l.tooClose ? '  <-- TOO CLOSE' : '';
      if (l.tooClose) bad++;
      console.log(`  ${String(l.from).padEnd(10)}-> ${String(l.to).padEnd(10)} ` +
        `${l.dist.toFixed(2).padStart(6)} nm  ${N.fmtBrg(l.brg)}  land ${l.landNm.toFixed(2).padStart(5)} nm` +
        (l.exempt ? ' (harbour)' : '') + (l.crosses.length ? `  crosses ${l.crosses.join(', ')}` : '') + flag);
    }
  }
  console.log(`\n${checked} leg(s) checked against ${chartFile}, ${bad} within ${clearNm} nm of land`);
  if (bad) {
    console.error(`::error::${bad} leg(s) pass within ${clearNm} nm of land. Move the waypoints, or if a leg is ` +
      `deliberately close because it enters a harbour, list that waypoint id in the passage's "harbourWaypoints".`);
    return 1;
  }
  console.log('every leg clears land');
  return 0;
}

process.exit(main(process.argv.slice(2)));
