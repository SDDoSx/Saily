// Unit tests for the pure modules (no browser). Run: node tools/unit.js
const assert = require('assert');
const N = require('../site/nav.js');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; } };
t('distance Sotogrande-Tangier ~39.5 nm', () => { const d = N.distanceNm({ lat: 36.2882, lon: -5.2703 }, { lat: 35.7841, lon: -5.7957 }); assert(d > 39 && d < 40.2, d); });
t('bearing north is 0', () => assert.strictEqual(Math.round(N.bearingDeg({ lat: 36, lon: -5.5 }, { lat: 36.1, lon: -5.5 })), 0));
t('bearing east is 90', () => assert.strictEqual(Math.round(N.bearingDeg({ lat: 36, lon: -5.5 }, { lat: 36, lon: -5.4 })), 90));
t('destination round trip', () => { const a = { lat: 36, lon: -5.5 }; const b = N.destination(a, 225, 10); assert(Math.abs(N.distanceNm(a, b) - 10) < 0.01); assert(Math.abs(N.angleDiff(N.bearingDeg(a, b), 225)) < 0.1); });
t('xte sign: right of a southbound track is negative-west', () => { const a = { lat: 36, lon: -5.5 }, b = { lat: 35.9, lon: -5.5 }; const west = { lat: 35.95, lon: -5.51 }; const east = { lat: 35.95, lon: -5.49 }; assert(N.crossTrackNm(west, a, b) > 0, 'west of a southbound track is to the right (positive)'); assert(N.crossTrackNm(east, a, b) < 0); });
t('along track', () => { const a = { lat: 36, lon: -5.5 }, b = { lat: 35.9, lon: -5.5 }; assert(Math.abs(N.alongTrackNm({ lat: 35.95, lon: -5.5 }, a, b) - 3) < 0.05); });
t('solve arrival in radius', () => { const wps = [{ lat: 36, lon: -5.5, radius: 0.1 }, { lat: 35.9, lon: -5.5, radius: 0.1 }]; const s = N.solve({ lat: 35.9005, lon: -5.5 }, wps, 1); assert(s.inRadius && s.arrived); });
t('solve passed perpendicular', () => { const wps = [{ lat: 36, lon: -5.5, radius: 0.05 }, { lat: 35.9, lon: -5.5, radius: 0.05 }]; const s = N.solve({ lat: 35.895, lon: -5.502 }, wps, 1); assert(!s.inRadius && s.passedPerp); });
t('angleDiff wraps', () => { assert.strictEqual(N.angleDiff(10, 350), 20); assert.strictEqual(N.angleDiff(350, 10), -20); });
t('windVsCurrent semantics', () => { assert.strictEqual(N.windVsCurrent(90, 90), 'against'); assert.strictEqual(N.windVsCurrent(270, 90), 'with'); assert.strictEqual(N.windVsCurrent(0, 90), 'cross'); });
t('sunset Tangier 6 Sep 2026 ~18:45 UTC', () => { const s = N.sunTimes(new Date('2026-09-06T12:00:00Z'), 35.78, -5.80); const m = s.sunset.getUTCHours() * 60 + s.sunset.getUTCMinutes(); assert(Math.abs(m - (18 * 60 + 45)) <= 3, m); });
t('fmtDM', () => assert.strictEqual(N.fmtDM(36.2869, -5.2701), "36°17.214'N 005°16.206'W"));
t('smoother circular mean across north', () => { const s = N.makeSmoother(0.5); s.push(10, 350); s.push(10, 10); s.push(10, 10); const c = s.cog; assert(c < 15 || c > 345, c); });
t('GPX export', () => { const g = N.toGPX('r', [{ lat: 36, lon: -5.5, id: 'A', name: 'a' }]); assert(g.includes('<rtept lat="36.00000" lon="-5.50000">')); });
console.log(`${n} unit tests passed`);
