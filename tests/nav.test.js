// node:test suite for site/nav.js (pure geodesy and route functions, no browser).
// Run: node --test tests/   (tools/unit.js runs this same file for the documented `node tools/unit.js` entry point)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../site/nav.js');

test('distance Sotogrande-Tangier ~39.5 nm', () => {
  const d = N.distanceNm({ lat: 36.2882, lon: -5.2703 }, { lat: 35.7841, lon: -5.7957 });
  assert(d > 39 && d < 40.2, String(d));
});
test('bearing north is 0', () => assert.strictEqual(Math.round(N.bearingDeg({ lat: 36, lon: -5.5 }, { lat: 36.1, lon: -5.5 })), 0));
test('bearing east is 90', () => assert.strictEqual(Math.round(N.bearingDeg({ lat: 36, lon: -5.5 }, { lat: 36, lon: -5.4 })), 90));
test('destination round trip', () => {
  const a = { lat: 36, lon: -5.5 }; const b = N.destination(a, 225, 10);
  assert(Math.abs(N.distanceNm(a, b) - 10) < 0.01);
  assert(Math.abs(N.angleDiff(N.bearingDeg(a, b), 225)) < 0.1);
});
test('xte sign: right of a southbound track is positive (west)', () => {
  const a = { lat: 36, lon: -5.5 }, b = { lat: 35.9, lon: -5.5 };
  const west = { lat: 35.95, lon: -5.51 }, east = { lat: 35.95, lon: -5.49 };
  assert(N.crossTrackNm(west, a, b) > 0, 'west of a southbound track is to the right (positive)');
  assert(N.crossTrackNm(east, a, b) < 0);
});
test('along track', () => {
  const a = { lat: 36, lon: -5.5 }, b = { lat: 35.9, lon: -5.5 };
  assert(Math.abs(N.alongTrackNm({ lat: 35.95, lon: -5.5 }, a, b) - 3) < 0.05);
  assert(N.alongTrackNm({ lat: 36.02, lon: -5.5 }, a, b) < 0, 'behind the start of the leg is negative');
});
test('solve arrival in radius', () => {
  const wps = [{ lat: 36, lon: -5.5, radius: 0.1 }, { lat: 35.9, lon: -5.5, radius: 0.1 }];
  const s = N.solve({ lat: 35.9005, lon: -5.5 }, wps, 1);
  assert(s.inRadius && s.arrived);
});
test('solve passed perpendicular', () => {
  const wps = [{ lat: 36, lon: -5.5, radius: 0.05 }, { lat: 35.9, lon: -5.5, radius: 0.05 }];
  const s = N.solve({ lat: 35.895, lon: -5.502 }, wps, 1);
  assert(!s.inRadius && s.passedPerp);
});
test('solve clamps the active index and sums the remaining distance', () => {
  const wps = [{ lat: 36, lon: -5.5 }, { lat: 35.9, lon: -5.5 }, { lat: 35.9, lon: -5.6 }];
  const s = N.solve({ lat: 36, lon: -5.5 }, wps, 0);
  assert.strictEqual(s.k, 1);
  assert(Math.abs(s.remaining - N.routeTotal(wps)) < 0.01);
  assert.strictEqual(N.solve({ lat: 36, lon: -5.5 }, wps, 9).k, 2);
});
test('angleDiff wraps', () => { assert.strictEqual(N.angleDiff(10, 350), 20); assert.strictEqual(N.angleDiff(350, 10), -20); });
test('windVsCurrent semantics', () => {
  assert.strictEqual(N.windVsCurrent(90, 90), 'against');
  assert.strictEqual(N.windVsCurrent(270, 90), 'with');
  assert.strictEqual(N.windVsCurrent(0, 90), 'cross');
});
test('sunset Tangier 6 Sep 2026 ~18:45 UTC', () => {
  const s = N.sunTimes(new Date('2026-09-06T12:00:00Z'), 35.78, -5.80);
  const m = s.sunset.getUTCHours() * 60 + s.sunset.getUTCMinutes();
  assert(Math.abs(m - (18 * 60 + 45)) <= 3, String(m));
});
test('fmtDM', () => assert.strictEqual(N.fmtDM(36.2869, -5.2701), "36°17.214'N 005°16.206'W"));
test('smoother circular mean across north', () => {
  const s = N.makeSmoother(0.5); s.push(10, 350); s.push(10, 10); s.push(10, 10);
  const c = s.cog; assert(c < 15 || c > 345, String(c));
  s.reset(); assert.strictEqual(s.sog, null); assert.strictEqual(s.cog, null);
});
test('GPX export', () => {
  const g = N.toGPX('r', [{ lat: 36, lon: -5.5, id: 'A', name: 'a' }]);
  assert(g.includes('<rtept lat="36.00000" lon="-5.50000">'));
});
test('seaAspect', () => {
  assert.strictEqual(N.seaAspect(90, 180), 'beam');
  assert.strictEqual(N.seaAspect(180, 180), 'head');
  assert.strictEqual(N.seaAspect(0, 180), 'following');
  assert.strictEqual(N.seaAspect(225, 180), 'bow');
  assert.strictEqual(N.seaAspect(45, 180), 'quarter');
});
test('courseAtNm', () => {
  const wps = [{ lat: 36, lon: -5.5 }, { lat: 35.9, lon: -5.5 }, { lat: 35.9, lon: -5.6 }];
  assert.strictEqual(Math.round(N.courseAtNm(wps, 3)), 180);
  assert.strictEqual(Math.round(N.courseAtNm(wps, 8)), 270);
});
test('trackGPX', () => {
  const g = N.trackGPX('t', [[36, -5.5, 1757160000000]]);
  assert(g.includes('<trkpt lat="36.00000" lon="-5.50000"><time>2025-09-06T'));
});
test('pointInRing / pointInRings', () => {
  const ring = [[36, -5.6], [36, -5.4], [35.8, -5.4], [35.8, -5.6]];
  assert(N.pointInRing({ lat: 35.9, lon: -5.5 }, ring));
  assert(!N.pointInRing({ lat: 36.1, lon: -5.5 }, ring));
  assert(N.pointInRings({ lat: 35.9, lon: -5.5 }, [[[0, 0], [0, 1], [1, 1]], ring]));
});
test('legs and routeTotal', () => {
  const wps = [{ lat: 36, lon: -5.5 }, { lat: 35.9, lon: -5.5 }, { lat: 35.9, lon: -5.6 }];
  const l = N.legs(wps);
  assert.strictEqual(l.length, 2);
  assert(Math.abs(l[0].dist - 6) < 0.05 && Math.round(l[0].brg) === 180);
  assert(Math.abs(N.routeTotal(wps) - (l[0].dist + l[1].dist)) < 1e-9);
});
test('deltaSpeedCourse and ttgSeconds', () => {
  const d = N.deltaSpeedCourse({ lat: 36, lon: -5.5, t: 0 }, { lat: 36.1, lon: -5.5, t: 600000 });
  assert(Math.abs(d.sog - 36) < 0.5, 'six miles in ten minutes is 36 kn');
  assert.strictEqual(Math.round(d.cog), 0);
  assert.strictEqual(N.deltaSpeedCourse({ lat: 36, lon: -5.5, t: 5 }, { lat: 36.1, lon: -5.5, t: 5 }), null);
  assert.strictEqual(N.ttgSeconds(10, 20), 1800);
  assert.strictEqual(N.ttgSeconds(10, 0.2), null);
});
test('formatting helpers', () => {
  assert.strictEqual(N.fmtBrg(359.6), '000°');
  assert.strictEqual(N.fmtBrg(null), '---°');
  assert.strictEqual(N.fmtNm(1.234), '1.23');
  assert.strictEqual(N.fmtNm(12.34), '12.3');
  assert.strictEqual(N.fmtDur(3725), '1h02');
  assert.strictEqual(N.fmtDur(600), '10 min');
  assert.strictEqual(N.fmtDur(null), '--:--');
  assert.strictEqual(N.compass16(0), 'N');
  assert.strictEqual(N.compass16(225), 'SW');
  assert.strictEqual(N.fmtTime(new Date('2026-09-06T12:00:00Z'), 'Europe/Madrid'), '14:00');
});

// --- route verification: the JS port of the chart builder's leg check --------------------------------
const fs = require('fs');
const path = require('path');
function loadGlobalScript(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const w = {};
  new Function('window', 'return (function(){' + src + '})()').call(w, w);
  return w;
}

test('projector scales longitude by the cosine of its own latitude', () => {
  // one degree of longitude is 60 nm at the equator and about 30 nm at 60 N
  assert.ok(Math.abs(N.projector(0).kx - 60) < 1e-9);
  assert.ok(Math.abs(N.projector(60).kx - 30) < 0.01, String(N.projector(60).kx));
  const p = N.projector(36);
  const [lat, lon] = p.toLL(p.toXY([36.25, -5.31]));
  assert.ok(Math.abs(lat - 36.25) < 1e-9 && Math.abs(lon + 5.31) < 1e-9, 'round-trips');
});

test('checkLegs measures a leg that runs at the coast as zero clearance', () => {
  const land = [[[36.0, -5.0], [36.0, -4.0], [35.0, -4.0], [35.0, -5.0], [36.0, -5.0]]]; // a square of land
  const wps = [{ id: 'A', lat: 35.5, lon: -3.5 }, { id: 'B', lat: 35.5, lon: -4.5 }];    // runs into it
  const r = N.checkLegs(wps, land, [], { lat0: 35.5 });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].landNm, 0, 'a leg crossing land has no clearance');
  assert.strictEqual(r[0].tooClose, true);
  // the same leg stopped short of the coast clears it by the gap
  const clear = N.checkLegs([{ id: 'A', lat: 35.5, lon: -3.5 }, { id: 'B', lat: 35.5, lon: -3.9 }], land, [], { lat0: 35.5 });
  assert.ok(Math.abs(clear[0].landNm - 0.1 * 60 * Math.cos(35.5 * Math.PI / 180)) < 0.01, String(clear[0].landNm));
  assert.strictEqual(clear[0].tooClose, false);
});

test('checkLegs exempts legs that touch a harbour waypoint', () => {
  const land = [[[36.0, -5.0], [36.0, -4.0], [35.0, -4.0], [35.0, -5.0], [36.0, -5.0]]];
  const wps = [{ id: 'MARINA', lat: 35.5, lon: -4.01 }, { id: 'OFFING', lat: 35.5, lon: -3.5 }];
  assert.strictEqual(N.checkLegs(wps, land, [], { lat0: 35.5 })[0].tooClose, true);
  assert.strictEqual(N.checkLegs(wps, land, [], { lat0: 35.5, harbourIds: ['MARINA'] })[0].tooClose, false);
});

test('checkLegs reports which areas a leg crosses', () => {
  const box = id => ({ id, rings: [[[35.6, -5.0], [35.6, -4.0], [35.4, -4.0], [35.4, -5.0], [35.6, -5.0]]] });
  const through = [{ id: 'A', lat: 35.5, lon: -5.5 }, { id: 'B', lat: 35.5, lon: -3.5 }];
  const around = [{ id: 'A', lat: 35.9, lon: -5.5 }, { id: 'B', lat: 35.9, lon: -3.5 }];
  assert.deepStrictEqual(N.checkLegs(through, [], [box('lane_x')], { lat0: 35.5 })[0].crosses, ['lane_x']);
  assert.deepStrictEqual(N.checkLegs(around, [], [box('lane_x')], { lat0: 35.5 })[0].crosses, []);
});

test('checkLegs matches shapely on every leg of the bundled routes', () => {
  // The chart builder verifies routes with shapely before a passage ships. The editor in the app has to
  // reach the same verdict, or someone drawing a route in the browser is checking against different rules.
  const fixturePath = path.join(__dirname, 'fixtures', 'legs-strait-of-gibraltar.json');
  const chartPath = path.join(__dirname, '..', 'site', 'passages', 'strait-of-gibraltar', 'chart-data.js');
  if (!fs.existsSync(fixturePath) || !fs.existsSync(chartPath)) { console.log('skipped: chart or fixture missing'); return; }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const C = loadGlobalScript('site/passages/strait-of-gibraltar/chart-data.js').CHART;
  const P = loadGlobalScript('site/passages/strait-of-gibraltar/passage.js').PASSAGE;
  const areas = [];
  for (const g of ['lanes', 'zones', 'precautionary']) for (const e of (C.tss[g] || [])) areas.push({ id: e.id, rings: e.rings });

  let compared = 0, worst = 0;
  for (const r of P.routes) {
    for (const leg of N.checkLegs(r.waypoints, C.land, areas, { lat0: fixture.lat0 })) {
      const want = fixture.legs.find(x => x.route === r.id && x.from === leg.from && x.to === leg.to);
      assert.ok(want, `no fixture row for ${r.id} ${leg.from}>${leg.to}`);
      compared++;
      worst = Math.max(worst, Math.abs(want.landNm - leg.landNm));
      // shapely's value is rounded to 2 dp in the fixture, so half of that is the tightest honest bound
      assert.ok(Math.abs(want.landNm - leg.landNm) <= 0.005,
        `${r.id} ${leg.from}>${leg.to}: shapely ${want.landNm} nm, js ${leg.landNm.toFixed(4)} nm`);
      assert.deepStrictEqual([...leg.crosses].sort(), want.crosses,
        `${r.id} ${leg.from}>${leg.to} crossings`);
    }
  }
  assert.strictEqual(compared, fixture.legs.length, 'every fixture leg was checked');
  assert.ok(compared >= 42, 'the bundled routes still have their legs');
});

// --- automatic routing ------------------------------------------------------------------------------
// Synthetic geometry, so the behaviour is pinned by what the router must do rather than by one coastline.
const SQUARE = (s, w, n, e) => [[n, w], [n, e], [s, e], [s, w], [n, w]];

test('open water routes straight there', () => {
  const r = N.suggestRoute({ lat: 36.0, lon: -5.0 }, { lat: 36.0, lon: -4.6 }, [], { cellNm: 0.5, clearNm: 0 });
  assert.ok(r, 'a route was found');
  assert.strictEqual(r.waypoints.length, 2, 'nothing to go around: start and finish only');
  assert.strictEqual(r.waypoints[0].id, 'START');
  assert.strictEqual(r.waypoints[1].id, 'FINISH');
});

test('an island in the way is routed around, not through', () => {
  const island = [SQUARE(35.95, -4.85, 36.05, -4.75)];
  const from = { lat: 36.0, lon: -5.0 }, to = { lat: 36.0, lon: -4.6 };
  const r = N.suggestRoute(from, to, island, { cellNm: 0.25, clearNm: 0.3 });
  assert.ok(r, 'a way round was found');
  assert.ok(r.waypoints.length > 2, 'it had to turn: ' + r.waypoints.length + ' waypoints');
  const legs = N.checkLegs(r.waypoints, island, [], { clearNm: 0.25, lat0: 36 });
  assert.deepStrictEqual(legs.filter(l => l.tooClose).map(l => `${l.from}>${l.to}`), [], 'no leg runs into the island');
  // and it is not a silly detour
  assert.ok(N.routeTotal(r.waypoints) < N.distanceNm(from, to) * 1.6, N.routeTotal(r.waypoints) + ' nm');
});

test('a start inside a harbour still routes', () => {
  // the start sits inside the land polygon, as a berth does; the router must leave from the nearest water
  const land = [SQUARE(35.90, -5.10, 36.10, -4.90)];
  const r = N.suggestRoute({ lat: 36.0, lon: -5.0 }, { lat: 36.0, lon: -4.5 }, land, { cellNm: 0.25, clearNm: 0.2 });
  assert.ok(r, 'a route was still produced');
  assert.strictEqual(r.blockedStart, true, 'it knows the start was not in open water');
  assert.strictEqual(r.waypoints[0].lat, 36.0, 'the first waypoint is still where you asked to leave from');
});

test('no way through is reported, not faked', () => {
  // a wall from edge to edge of the search box
  const wall = [SQUARE(30.0, -4.8, 40.0, -4.7)];
  const r = N.suggestRoute({ lat: 36.0, lon: -5.0 }, { lat: 36.0, lon: -4.5 }, wall, { cellNm: 0.5, clearNm: 0.2, padNm: 2 });
  assert.strictEqual(r, null, 'a route that does not exist must come back null');
});

test('a gap is found and used', () => {
  const wall = [SQUARE(36.02, -4.8, 40.0, -4.7), SQUARE(30.0, -4.8, 35.98, -4.7)];  // a gap at 36.00
  const r = N.suggestRoute({ lat: 36.0, lon: -5.0 }, { lat: 36.0, lon: -4.5 }, wall, { cellNm: 0.1, clearNm: 0 });
  assert.ok(r, 'the gap was found');
  const legs = N.checkLegs(r.waypoints, wall, [], { clearNm: 0.02, lat0: 36 });
  assert.deepStrictEqual(legs.filter(l => l.tooClose).map(l => `${l.from}>${l.to}`), []);
});

test('a traffic lane is crossed nearer to right angles than a diagonal would be', () => {
  // a west-going lane (flow 270) lying across the track; a straight line would cut it at a shallow angle
  const lane = { rings: [SQUARE(35.90, -5.20, 36.00, -4.60)], flowDeg: 270 };
  const from = { lat: 36.20, lon: -5.15 }, to = { lat: 35.75, lon: -4.70 };
  // perpendicularity, not the raw angle: 1.0 is dead across the flow, 0 is straight along it
  const perp = deg => Math.abs(Math.sin(deg * Math.PI / 180));
  const naive = perp(N.angleDiff(N.bearingDeg(from, to), 270));
  const r = N.suggestRoute(from, to, [], { cellNm: 0.25, clearNm: 0, zones: [lane], laneK: 8 });
  assert.ok(r, 'a route was found');
  const legs = N.checkLegs(r.waypoints, [], [{ id: 'lane', rings: lane.rings }], { lat0: 36 });
  const crossing = legs.filter(l => l.crosses.includes('lane'));
  assert.ok(crossing.length, 'something crosses the lane');
  const best = Math.max(...crossing.map(l => perp(N.angleDiff(l.brg, 270))));
  assert.ok(best > naive + 0.1,
    `crossed at ${(Math.asin(best) * 180 / Math.PI).toFixed(0)}° from the flow line; a straight course would be ${(Math.asin(naive) * 180 / Math.PI).toFixed(0)}°`);
  assert.ok(best > 0.85, `rule 10(c) wants as near right angles as practicable; perpendicularity ${best.toFixed(2)}`);
});

test('laneCost is cheapest across the flow and dearest along it', () => {
  const grid = { flow: [270], w: 1 };
  assert.strictEqual(N.laneCost({ flow: [-1], w: 1 }, 0, 0, 6), 1, 'no lane, no penalty');
  const across = N.laneCost(grid, 0, 180, 6);   // due south across a west-going lane
  const along = N.laneCost(grid, 0, 270, 6);    // straight down it
  assert.ok(across < 1.01, 'crossing at right angles costs nothing extra: ' + across);
  assert.ok(along > 6.9, 'running along the lane is heavily penalised: ' + along);
});

test('suggestRoute on the bundled chart clears land on every leg', () => {
  const chartPath = path.join(__dirname, '..', 'site', 'passages', 'strait-of-gibraltar', 'chart-data.js');
  if (!fs.existsSync(chartPath)) { console.log('skipped: no chart'); return; }
  const C = loadGlobalScript('site/passages/strait-of-gibraltar/chart-data.js').CHART;
  const P = loadGlobalScript('site/passages/strait-of-gibraltar/passage.js').PASSAGE;
  const r = P.routes.find(x => x.id === 'tarifa');
  const from = r.waypoints[0], to = r.waypoints[r.waypoints.length - 1];
  const zones = (C.tss.lanes || []).map(e => ({ rings: e.rings, flowDeg: e.flowDeg }));
  const sug = N.suggestRoute(from, to, C.land, { cellNm: 0.25, clearNm: 0.3, hazards: P.hazards, zones });
  assert.ok(sug, 'the Strait can be routed automatically');
  const areas = [];
  for (const g of ['lanes', 'zones', 'precautionary']) for (const e of (C.tss[g] || [])) areas.push({ id: e.id, rings: e.rings });
  const legs = N.checkLegs(sug.waypoints, C.land, areas, {
    clearNm: 0.25, lat0: (C.meta.bbox[0] + C.meta.bbox[2]) / 2, harbourIds: ['START', 'FINISH'],
  });
  assert.deepStrictEqual(legs.filter(l => l.tooClose).map(l => `${l.from}>${l.to}`), [], 'no suggested leg runs into land');
  const total = N.routeTotal(sug.waypoints);
  assert.ok(total > 35 && total < 60, `a sane distance for this crossing: ${total.toFixed(1)} nm`);
  assert.ok(sug.waypoints.length >= 2 && sug.waypoints.length <= 14, `${sug.waypoints.length} waypoints`);
});
