// node:test suite for site/weather.js (thresholds, time handling, passage check) with a fake browser root.
// weather.js attaches to `self`; here `self` is node's global object carrying a hand-made PASSAGE and NAV.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.self = global;
global.NAV = require('../site/nav.js');
// fake passage: the five Strait points (same ids and routeNm as the bundled passage) and explicit thresholds
global.PASSAGE = {
  tz: { from: { label: 'ES', zone: 'Europe/Madrid' }, to: { label: 'MA', zone: 'Africa/Casablanca' } },
  weatherPoints: [
    { id: 'soto', name: 'Sotogrande offing', lat: 36.27, lon: -5.24, routeNm: 0.5 },
    { id: 'europa', name: 'Europa Point', lat: 36.08, lon: -5.36, routeNm: 12.5 },
    { id: 'tarifa', name: 'Tarifa', lat: 35.97, lon: -5.62, routeNm: 27.3 },
    { id: 'cross', name: 'Mid-crossing', lat: 35.92, lon: -5.70, routeNm: 34.5 },
    { id: 'tangier', name: 'Tangier Bay', lat: 35.81, lon: -5.77, routeNm: 43.0 },
  ],
  thresholds: { windCaution: 14, windNoGo: 20, gustCaution: 22, gustNoGo: 30, waveCaution: 1.0, waveNoGo: 1.6, currentCaution: 2.0, visCaution: 5000 },
};
require('../site/weather.js');
const WX = global.WX;
const TH = WX.DEFAULT_THRESHOLDS;

// A passage that cannot be assessed: weather.js historically returned 'na'; the current contract also has 'incomplete'
// (with a `missing` list). Either means "do not trust this verdict", which is what these tests pin down.
const NOT_ASSESSABLE = ['na', 'incomplete'];

const FIX = path.join(__dirname, '..', 'tools', 'fixtures');
const fc = JSON.parse(fs.readFileSync(path.join(FIX, 'fc.json'), 'utf8'));
const mar = JSON.parse(fs.readFileSync(path.join(FIX, 'marine.json'), 'utf8'));
const rawAll = () => Object.fromEntries(WX.POINTS.map(p => [p.id, { fc, mar }]));

// calm baseline row; tests override single fields
const calm = () => ({ wind: 8, windDir: 270, gust: 12, wave: 0.4, waveDir: 270, wavePeriod: 6, current: 0.5, currentDir: 90, vis: 20000, rain: 0 });
const reasons = (row, course) => WX.classify(row, TH, course).reasons.join(' | ');

test('module picks up the fake passage points and thresholds', () => {
  assert.deepStrictEqual(WX.POINTS.map(p => p.id), ['soto', 'europa', 'tarifa', 'cross', 'tangier']);
  assert.strictEqual(TH.windNoGo, 20);
  assert.strictEqual(WX.TZ, 'Europe/Madrid');
});

test('classify: calm row is ok with no reasons', () => {
  const v = WX.classify(calm(), TH);
  assert.strictEqual(v.level, 'ok');
  assert.deepStrictEqual(v.reasons, []);
});
test('classify: wind thresholds', () => {
  assert.strictEqual(WX.classify({ ...calm(), wind: 13.9 }, TH).level, 'ok');
  assert.strictEqual(WX.classify({ ...calm(), wind: 14 }, TH).level, 'caution');
  assert.strictEqual(WX.classify({ ...calm(), wind: 20 }, TH).level, 'nogo');
  assert.match(reasons({ ...calm(), wind: 20 }), /wind 20 kn/);
});
test('classify: gust, wave, current, visibility and rain thresholds', () => {
  assert.strictEqual(WX.classify({ ...calm(), gust: 22 }, TH).level, 'caution');
  assert.strictEqual(WX.classify({ ...calm(), gust: 30 }, TH).level, 'nogo');
  assert.strictEqual(WX.classify({ ...calm(), wave: 1.0, wavePeriod: 7, waveDir: 270 }, TH).level, 'caution');
  assert.strictEqual(WX.classify({ ...calm(), wave: 1.6, wavePeriod: 7 }, TH).level, 'nogo');
  assert.match(reasons({ ...calm(), current: 2.0 }), /current 2\.0 kn/);
  assert.strictEqual(WX.classify({ ...calm(), current: 2.0 }, TH).level, 'caution');
  assert.match(reasons({ ...calm(), vis: 4999 }), /visibility 5\.0 km/);
  assert.match(reasons({ ...calm(), rain: 2 }), /rain 2 mm\/h/);
  assert.strictEqual(WX.classify({ ...calm(), rain: 1.9 }, TH).level, 'ok');
});
test('classify: nogo wins over caution and every reason is kept', () => {
  const v = WX.classify({ ...calm(), wind: 25, gust: 24 }, TH);
  assert.strictEqual(v.level, 'nogo');
  assert.deepStrictEqual(v.reasons, ['wind 25 kn', 'gusts 24 kn']);
});
test('classify: wind against current flags steep seas only above 12 kn wind and 1 kn current', () => {
  // wind FROM 090, current TOWARDS 090: opposed
  assert.match(reasons({ ...calm(), wind: 12, windDir: 90, current: 1.0, currentDir: 90 }), /wind against current: steep seas/);
  assert.doesNotMatch(reasons({ ...calm(), wind: 11.9, windDir: 90, current: 1.0, currentDir: 90 }), /against/);
  assert.doesNotMatch(reasons({ ...calm(), wind: 12, windDir: 90, current: 0.9, currentDir: 90 }), /against/);
  // wind FROM 270 with a current TOWARDS 090 runs with it
  assert.doesNotMatch(reasons({ ...calm(), wind: 15, windDir: 270, current: 1.5, currentDir: 90 }), /against/);
  assert.strictEqual(WX.classify({ ...calm(), wind: 12, windDir: 90, current: 1.0, currentDir: 90 }, TH).level, 'caution');
});
test('classify: short steep waves need >= 0.8 m and a period <= 4.5 s', () => {
  assert.match(reasons({ ...calm(), wave: 0.8, wavePeriod: 4.5 }), /short steep waves/);
  assert.doesNotMatch(reasons({ ...calm(), wave: 0.79, wavePeriod: 4.0 }), /short steep/);
  assert.doesNotMatch(reasons({ ...calm(), wave: 0.9, wavePeriod: 4.6 }), /short steep/);
});
test('classify: beam and head sea via NAV.seaAspect need a course', () => {
  const row = { ...calm(), wave: 0.9, wavePeriod: 7, waveDir: 90 };
  assert.deepStrictEqual(WX.classify(row, TH).reasons, [], 'no course: no aspect reason');
  assert.match(reasons(row, 180), /beam sea 0\.9 m \(rolling\)/);
  assert.strictEqual(WX.classify(row, TH, 180).level, 'caution');
  // head sea: waves from the course direction, only from 1.0 m
  assert.match(reasons({ ...calm(), wave: 1.0, wavePeriod: 7, waveDir: 180 }, 180), /head sea 1\.0 m \(slamming, slow down\)/);
  assert.doesNotMatch(reasons({ ...calm(), wave: 0.9, wavePeriod: 7, waveDir: 180 }, 180), /head sea/);
  // following sea: no aspect reason
  assert.doesNotMatch(reasons({ ...calm(), wave: 1.2, wavePeriod: 7, waveDir: 0 }, 180), /beam|head/);
  // classify uses the shared seaAspect table
  assert.strictEqual(global.NAV.seaAspect(90, 180), 'beam');
});
test('classify: null fields are skipped, custom thresholds respected', () => {
  assert.strictEqual(WX.classify({ wind: null, gust: null, wave: null, current: null, vis: null }, TH).level, 'ok');
  assert.strictEqual(WX.classify({ ...calm(), wind: 10 }, { ...TH, windCaution: 10 }).level, 'caution');
});

test('madridLocalIso: converts UTC to Europe/Madrid wall time, midnight is 00 not 24', () => {
  assert.strictEqual(WX.madridLocalIso(new Date('2026-09-06T12:00:00Z')), '2026-09-06T14:00'); // CEST
  assert.strictEqual(WX.madridLocalIso(new Date('2026-10-24T22:00:00Z')), '2026-10-25T00:00'); // CEST midnight
  assert.strictEqual(WX.madridLocalIso(new Date('2026-10-25T23:00:00Z')), '2026-10-26T00:00'); // CET midnight
  assert.strictEqual(WX.madridLocalIso(new Date('2026-12-01T12:00:00Z')), '2026-12-01T13:00'); // CET
});

test('rowAt around the 25 Oct 2026 DST change (03:00 CEST -> 02:00 CET)', () => {
  // Open-Meteo hourly rows carry local wall time without an offset
  const rows = [];
  for (let h = 22; h < 24; h++) rows.push({ time: `2026-10-24T${String(h).padStart(2, '0')}:00` });
  for (let h = 0; h <= 6; h++) rows.push({ time: `2026-10-25T${String(h).padStart(2, '0')}:00` });
  const pt = { rows };
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-24T22:00:00Z')).time, '2026-10-25T00:00', 'still CEST (UTC+2)');
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-24T23:30:00Z')).time, '2026-10-25T01:00', 'half hours round down to the earlier row');
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-25T00:00:00Z')).time, '2026-10-25T02:00', '02:00 CEST');
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-25T01:00:00Z')).time, '2026-10-25T02:00', '02:00 CET again: the repeated hour maps to the same wall-time row');
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-25T02:00:00Z')).time, '2026-10-25T03:00', 'CET (UTC+1) after the change, not 04:00');
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-25T05:00:00Z')).time, '2026-10-25T06:00');
  assert.strictEqual(WX.rowAt(pt, new Date('2026-10-25T09:00:00Z')), null, 'more than an hour past the last row');
  assert.strictEqual(WX.rowAt({ rows: [] }, new Date()), null);
  assert.strictEqual(WX.rowAt(null, new Date()), null);
});

test('fromRaw builds points from raw API responses', () => {
  const d = WX.fromRaw({ soto: { fc, mar }, tarifa: { fc, mar }, cross: { fc: null, mar } }, 1757150000000);
  assert.strictEqual(d.fetchedAt, 1757150000000);
  assert.strictEqual(d.embedded, true);
  assert.deepStrictEqual(Object.keys(d.points).sort(), ['cross', 'soto', 'tarifa']);
  const p = d.points.soto;
  assert.strictEqual(p.id, 'soto'); assert.strictEqual(p.routeNm, 0.5); assert.strictEqual(p.utcOffset, 7200);
  assert.strictEqual(p.rows.length, 72);
  assert.strictEqual(p.rows[0].time, '2026-09-06T00:00');
  assert.strictEqual(p.rows[0].wind, fc.hourly.wind_speed_10m[0]);
  assert.strictEqual(p.rows[0].wave, mar.hourly.wave_height[0]);
  assert(Math.abs(p.rows[0].current - mar.hourly.ocean_current_velocity[0] / 1.852) < 1e-9, 'current km/h -> kn');
  assert.deepStrictEqual(p.sunset, fc.daily.sunset);
  // marine-only point: wind fields absent, waves present, sun data null
  const c = d.points.cross;
  assert.strictEqual(c.rows.length, 72); assert.strictEqual(c.rows[0].wind, undefined); assert.strictEqual(c.rows[0].wave, mar.hourly.wave_height[0]); assert.strictEqual(c.sunset, null);
  // unknown ids and empty entries are ignored
  assert.deepStrictEqual(Object.keys(WX.fromRaw({ nowhere: { fc, mar }, europa: {} }).points), []);
});

test('passage samples each point at the time the boat gets there', () => {
  const d = WX.fromRaw(rawAll(), 1);
  const dep = new Date('2026-09-06T10:00:00Z'); // 12:00 CEST
  const pass = WX.passage(d, dep, 22, TH, [{ lat: 36.2882, lon: -5.2703 }, { lat: 35.7841, lon: -5.7957 }]);
  assert.strictEqual(pass.length, 5);
  assert.strictEqual(pass[0].row.time, '2026-09-06T12:00');
  assert.strictEqual(pass[4].row.time, '2026-09-06T14:00', '43 nm at 22 kn is just under two hours');
  assert(pass.every(s => s.verdict && ['ok', 'caution', 'nogo'].includes(s.verdict.level)));
  assert(pass.every(s => typeof s.course === 'number'));
  assert.deepStrictEqual(WX.passage(null, dep, 22), []);
});

test('departureScan returns the requested number of hourly entries', () => {
  const d = WX.fromRaw(rawAll(), 1);
  const from = new Date('2026-09-06T08:17:00Z');
  const scan = WX.departureScan(d, from, 6, 22, TH);
  assert.strictEqual(scan.length, 6);
  assert.strictEqual(scan[0].dep.getTime(), new Date('2026-09-06T08:00:00Z').getTime(), 'starts on the hour');
  for (let i = 1; i < scan.length; i++) assert.strictEqual(scan[i].dep - scan[i - 1].dep, 3600000);
  for (const e of scan) {
    assert(['ok', 'caution', 'nogo', 'na'].includes(e.overall.level));
    assert.strictEqual(e.pass.length, 5);
    assert.strictEqual(typeof e.maxWind, 'number'); assert.strictEqual(typeof e.maxWave, 'number');
  }
  assert.strictEqual(WX.departureScan(d, from, 0, 22, TH).length, 0);
  assert.strictEqual(WX.departureScan(d, from, 30, 22, TH).length, 30);
  // beyond the forecast horizon the entries still exist but are not assessable
  const late = WX.departureScan(d, new Date('2026-09-09T06:00:00Z'), 3, 22, TH);
  assert.strictEqual(late.length, 3);
  assert(late.every(e => NOT_ASSESSABLE.includes(e.overall.level) && e.maxWind === null), JSON.stringify(late.map(e => [e.overall.level, e.maxWind])));
  assert.deepStrictEqual(WX.departureScan(null, from, 3, 22, TH), []);
});

test('overall is not assessable (na / incomplete) when a point row is missing', () => {
  const d = WX.fromRaw(rawAll(), 1);
  const dep = new Date('2026-09-06T10:00:00Z');
  const ok = WX.overall(WX.passage(d, dep, 22, TH));
  assert(!NOT_ASSESSABLE.includes(ok.level), 'complete data gives a real verdict: ' + ok.level);
  d.points.tangier.rows = []; // one point without rows: the boat's arrival hour has no forecast
  const na = WX.overall(WX.passage(d, dep, 22, TH));
  assert(NOT_ASSESSABLE.includes(na.level), 'got ' + na.level);
  assert(na.reasons.some(r => /no forecast/i.test(r)), JSON.stringify(na.reasons));
  assert(NOT_ASSESSABLE.includes(WX.overall([]).level), 'empty passage');
  assert(NOT_ASSESSABLE.includes(WX.overall([{ point: { name: 'x' }, row: null, verdict: null }]).level), 'row null');
});

test('overall aggregates verdicts: nogo beats caution, reasons name the point and the value', () => {
  const mk = (name, row) => ({ point: { name }, row, when: new Date('2026-09-06T10:00:00Z'), verdict: WX.classify(row, TH) });
  const pass = [mk('Alpha', { ...calm(), wind: 15 }), mk('Bravo', { ...calm(), wave: 1.8, wavePeriod: 7 }), mk('Charlie', calm())];
  const o = WX.overall(pass);
  assert.strictEqual(o.level, 'nogo');
  assert(o.reasons.some(r => /wind/i.test(r) && /\b15\b/.test(r) && /Alpha/.test(r)), JSON.stringify(o.reasons));
  assert(o.reasons.some(r => /wave/i.test(r) && /1\.8/.test(r) && /Bravo/.test(r)), JSON.stringify(o.reasons));
  assert.strictEqual(WX.overall([pass[0], pass[2]]).level, 'caution');
  const fine = WX.overall([pass[2]]);
  assert.strictEqual(fine.level, 'ok'); assert.deepStrictEqual(fine.reasons, []);
});

test('nearestPoint picks the closest fetched point', () => {
  const d = WX.fromRaw({ soto: { fc, mar }, tangier: { fc, mar } }, 1);
  assert.strictEqual(WX.nearestPoint(d, { lat: 35.8, lon: -5.8 }).id, 'tangier');
  assert.strictEqual(WX.nearestPoint(d, { lat: 36.2, lon: -5.3 }).id, 'soto');
  assert.strictEqual(WX.nearestPoint(null, { lat: 36, lon: -5 }), null);
});
