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
