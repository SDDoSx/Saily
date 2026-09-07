// node:test suite for site/ais.js: CPA/TCPA geometry, alarm window, target pruning. No network (connect() is not exercised).
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.self = global;
global.NAV = require('../site/nav.js');
require('../site/ais.js');
const AIS = global.AIS;

const OWN = { lat: 36, lon: -5.5, cog: 0, sog: 10 };
const NM_LAT = 1 / 60;                                        // degrees of latitude per nm
const NM_LON = 1 / (60 * Math.cos(36 * Math.PI / 180));       // degrees of longitude per nm at 36N
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} got ${a}`);
const posMsg = (mmsi, t, extra) => ({
  MessageType: 'PositionReport',
  MetaData: { MMSI: mmsi, ShipName: extra && extra.name || 'TEST', latitude: t.lat, longitude: t.lon, time_utc: new Date().toISOString() },
  Message: { PositionReport: { Latitude: t.lat, Longitude: t.lon, Cog: t.cog == null ? 360 : t.cog, Sog: t.sog == null ? 102.3 : t.sog, TrueHeading: t.hdg == null ? 511 : t.hdg } },
});
function resetAis() { AIS.targets.clear(); AIS.alarmed = {}; AIS.own = null; AIS.onAlarm = null; AIS.onUpdate = null; }

test('cpa: head-on target closes at the sum of the speeds', () => {
  const c = AIS.cpa(OWN, { lat: 36 + 2 * NM_LAT, lon: -5.5, cog: 180, sog: 10 });
  near(c.range, 2, 0.01, 'range'); near(c.brg, 0, 0.5, 'bearing');
  near(c.tcpa, 6, 0.05, 'tcpa minutes: 2 nm at 20 kn'); near(c.cpa, 0, 0.01, 'cpa');
});
test('cpa: overtaking a slower ship ahead and being overtaken from astern', () => {
  const ahead = AIS.cpa(OWN, { lat: 36 + 1 * NM_LAT, lon: -5.5, cog: 0, sog: 5 });
  near(ahead.tcpa, 12, 0.05, 'tcpa: 1 nm at 5 kn closing'); near(ahead.cpa, 0, 0.01);
  const astern = AIS.cpa(OWN, { lat: 36 - 1 * NM_LAT, lon: -5.5, cog: 0, sog: 20 });
  near(astern.brg, 180, 0.5, 'bearing'); near(astern.tcpa, 6, 0.05, 'tcpa'); near(astern.cpa, 0, 0.01);
});
test('cpa: parallel target with the same velocity never closes (tcpa null, cpa = range)', () => {
  const c = AIS.cpa(OWN, { lat: 36, lon: -5.5 + 1 * NM_LON, cog: 0, sog: 10 });
  assert.strictEqual(c.tcpa, null); near(c.cpa, 1, 0.01); near(c.range, 1, 0.01); near(c.brg, 90, 0.5);
});
test('cpa: stationary targets ahead and abeam', () => {
  const ahead = AIS.cpa(OWN, { lat: 36 + 3 * NM_LAT, lon: -5.5, cog: null, sog: 0 });
  near(ahead.tcpa, 18, 0.05, '3 nm at 10 kn'); near(ahead.cpa, 0, 0.01);
  const abeam = AIS.cpa(OWN, { lat: 36, lon: -5.5 + 1 * NM_LON, cog: null, sog: null });
  near(abeam.cpa, 1, 0.01, 'passes 1 nm off'); near(abeam.tcpa, 0, 1e-6, 'abeam now');
  const astern = AIS.cpa(OWN, { lat: 36 - 2 * NM_LAT, lon: -5.5, sog: 0 });
  assert(astern.tcpa < 0, 'already past: negative tcpa');
});
test('cpa: crossing target, closed-form check', () => {
  // own north at 10 kn, target 2 nm east heading west at 10 kn: relative velocity (-10, -10) kn
  const c = AIS.cpa(OWN, { lat: 36, lon: -5.5 + 2 * NM_LON, cog: 270, sog: 10 });
  near(c.tcpa, 6, 0.05); near(c.cpa, Math.SQRT2, 0.01);
});
test('cpa: null without a position', () => {
  assert.strictEqual(AIS.cpa(null, { lat: 36, lon: -5.5 }), null);
  assert.strictEqual(AIS.cpa(OWN, { lat: null, lon: null }), null);
  assert.strictEqual(AIS.cpa({ lat: null }, { lat: 36, lon: -5.5 }), null);
});

test('ingest: position reports create targets, n/a codes become null, static data adds name and type', () => {
  resetAis();
  AIS.ingest(posMsg(111, { lat: 36.1, lon: -5.5, cog: 360, sog: 102.3, hdg: 511 }, { name: 'ALPHA ' }));
  const t = AIS.targets.get(111);
  assert(t, 'target stored'); assert.strictEqual(t.name, 'ALPHA'); assert.strictEqual(t.cog, null); assert.strictEqual(t.sog, null); assert.strictEqual(t.hdg, null);
  assert(Date.now() - t.t < 5000);
  AIS.ingest({ MessageType: 'ShipStaticData', MetaData: { MMSI: 111 }, Message: { ShipStaticData: { Name: 'ALPHA ONE', Type: 70 } } });
  assert.strictEqual(AIS.targets.get(111).name, 'ALPHA ONE'); assert.strictEqual(AIS.targets.get(111).type, 70);
  AIS.ingest(null); AIS.ingest({ Message: {} }); AIS.ingest({ MetaData: { MMSI: 222 }, Message: { ShipStaticData: { Name: 'NOPOS' } } });
  assert.strictEqual(AIS.targets.size, 1, 'static data without a position does not create a target');
  let updated = null; AIS.onUpdate = x => { updated = x; };
  AIS.ingest(posMsg(111, { lat: 36.11, lon: -5.5, cog: 10.5, sog: 12.3, hdg: 12 }));
  assert.strictEqual(updated.mmsi, 111); assert.strictEqual(updated.cog, 10.5); assert.strictEqual(updated.sog, 12.3); assert.strictEqual(updated.hdg, 12);
});

test('alarm fires only inside the CPA/TCPA window, once per 3 minutes per ship', () => {
  resetAis();
  const alarms = []; AIS.own = { ...OWN }; AIS.onAlarm = (t, c) => alarms.push({ mmsi: t.mmsi, c });
  // 2 nm head-on: tcpa 6 min, cpa 0, range 2 -> alarm
  AIS.ingest(posMsg(1, { lat: 36 + 2 * NM_LAT, lon: -5.5, cog: 180, sog: 10 }));
  assert.strictEqual(alarms.length, 1); assert.strictEqual(alarms[0].mmsi, 1); near(alarms[0].c.tcpa, 6, 0.05);
  // same ship again straight away: suppressed by the repeat guard
  AIS.ingest(posMsg(1, { lat: 36 + 1.9 * NM_LAT, lon: -5.5, cog: 180, sog: 10 }));
  assert.strictEqual(alarms.length, 1);
  // after the guard expires it alarms again
  const realNow = Date.now; Date.now = () => realNow() + 200000;
  try { AIS.ingest(posMsg(1, { lat: 36 + 1.5 * NM_LAT, lon: -5.5, cog: 180, sog: 10 })); } finally { Date.now = realNow; }
  assert.strictEqual(alarms.length, 2);
  // crossing ship that passes 1.4 nm off: cpa outside 0.5 nm -> no alarm
  AIS.ingest(posMsg(2, { lat: 36, lon: -5.5 + 2 * NM_LON, cog: 270, sog: 10 }));
  // head-on but 8 nm away: tcpa 24 min and range > 6 -> no alarm
  AIS.ingest(posMsg(3, { lat: 36 + 8 * NM_LAT, lon: -5.5, cog: 180, sog: 10 }));
  // head-on 5 nm away at 30 kn: tcpa 7.5 min but range 5 < 6 -> alarm; then at 5.5 nm range at 10 kn own+10: tcpa 16.5 -> none
  AIS.ingest(posMsg(4, { lat: 36 + 5 * NM_LAT, lon: -5.5, cog: 180, sog: 30 }));
  AIS.ingest(posMsg(5, { lat: 36 + 5.5 * NM_LAT, lon: -5.5, cog: 180, sog: 10 }));
  // moving away astern: negative tcpa -> no alarm
  AIS.ingest(posMsg(6, { lat: 36 - 1 * NM_LAT, lon: -5.5, cog: 180, sog: 10 }));
  // same velocity alongside: tcpa null -> no alarm
  AIS.ingest(posMsg(7, { lat: 36, lon: -5.5 + 0.2 * NM_LON, cog: 0, sog: 10 }));
  assert.deepStrictEqual(alarms.map(a => a.mmsi), [1, 1, 4]);
  // no own position: nothing can alarm
  AIS.own = null;
  AIS.ingest(posMsg(8, { lat: 36 + 2 * NM_LAT, lon: -5.5, cog: 180, sog: 10 }));
  assert.strictEqual(alarms.length, 3);
  // tcpa exactly at the window edge is excluded (strict comparison)
  AIS.own = { ...OWN }; AIS.alarmed = {};
  AIS.ingest(posMsg(9, { lat: 36 + 4 * NM_LAT, lon: -5.5, cog: 180, sog: 10 })); // 4 nm at 20 kn = 12.0 min
  assert.strictEqual(alarms.length, 3);
});

test('prune removes targets older than staleMin', () => {
  resetAis();
  const now = Date.now();
  AIS.targets.set(11, { mmsi: 11, lat: 36, lon: -5.5, t: now - (AIS.staleMin * 60000 + 1000) });
  AIS.targets.set(12, { mmsi: 12, lat: 36, lon: -5.5, t: now - 60000 });
  AIS.targets.set(13, { mmsi: 13, lat: 36, lon: -5.5, t: now });
  AIS.prune();
  assert.deepStrictEqual([...AIS.targets.keys()].sort(), [12, 13]);
});

test('ranked prunes and sorts by range', () => {
  resetAis();
  AIS.own = { ...OWN };
  const now = Date.now();
  AIS.targets.set(21, { mmsi: 21, lat: 36 + 3 * NM_LAT, lon: -5.5, cog: 0, sog: 0, t: now });
  AIS.targets.set(22, { mmsi: 22, lat: 36 + 1 * NM_LAT, lon: -5.5, cog: 0, sog: 0, t: now });
  AIS.targets.set(23, { mmsi: 23, lat: 36 + 2 * NM_LAT, lon: -5.5, cog: 0, sog: 0, t: now - 3600000 });
  const r = AIS.ranked();
  assert.deepStrictEqual(r.map(x => x.t.mmsi), [22, 21]);
  near(r[0].c.range, 1, 0.01);
});

test('typeName maps AIS ship type codes', () => {
  assert.strictEqual(AIS.typeName(30), 'fishing');
  assert.strictEqual(AIS.typeName(36), 'sailing/pleasure');
  assert.strictEqual(AIS.typeName(44), 'high-speed craft');
  assert.strictEqual(AIS.typeName(60), 'passenger');
  assert.strictEqual(AIS.typeName(79), 'cargo');
  assert.strictEqual(AIS.typeName(80), 'tanker');
  assert.strictEqual(AIS.typeName(null), '');
});

test('boxOf normalises a passage bbox to south-west then north-east', () => {
  // passage bbox is [south, west, north, east]; aisstream is not documented to normalise the corners.
  assert.deepStrictEqual(AIS.boxOf([35.7, -5.9, 36.4, -5.1]), [[35.7, -5.9], [36.4, -5.1]]);
  // corners the other way round must still come out south-west first
  assert.deepStrictEqual(AIS.boxOf([36.4, -5.1, 35.7, -5.9]), [[35.7, -5.9], [36.4, -5.1]]);
});

test('cleanName strips the @ padding AIS names carry', () => {
  assert.strictEqual(AIS.cleanName('MAERSK KOWLOON@@@@@'), 'MAERSK KOWLOON');
  assert.strictEqual(AIS.cleanName('  SPACED   OUT  '), 'SPACED OUT');
  assert.strictEqual(AIS.cleanName('@@@@'), '');
});

test('ingest reads Class B extended positions and Class B static names', () => {
  resetAis();
  AIS.ingest({ MetaData: { MMSI: 77, latitude: 36, longitude: -5.5 },
    Message: { ExtendedClassBPositionReport: { Latitude: 36, Longitude: -5.5, Cog: 270, Sog: 6.5 } } });
  AIS.ingest({ MetaData: { MMSI: 77 },
    Message: { StaticDataReport: { ReportA: { Name: 'LITTLE BOAT@@' }, ReportB: { ShipType: 37 } } } });
  const t = AIS.targets.get(77);
  assert.strictEqual(t.name, 'LITTLE BOAT');
  assert.strictEqual(t.type, 37);
  assert.strictEqual(t.sog, 6.5);
  assert.strictEqual(AIS.typeName(t.type), 'sailing/pleasure');
});

test('a binary frame of UTF-8 JSON is decoded, not dropped', () => {
  // aisstream sends binary frames. In a browser event.data arrives as a Blob or ArrayBuffer, and
  // JSON.parse(event.data) throws and stringifies to "[object Blob]": every ship silently disappears.
  resetAis();
  const json = JSON.stringify({
    MetaData: { MMSI: 4242, ShipName: 'BINARY BOAT@@', latitude: 36, longitude: -5.5 },
    Message: { PositionReport: { Latitude: 36, Longitude: -5.5, Cog: 271, Sog: 12.5 } },
  });
  const bytes = new TextEncoder().encode(json);
  assert.strictEqual(AIS.decodeBytes(bytes.buffer), json, 'ArrayBuffer decodes back to the same JSON');
  AIS.handleFrame(AIS.decodeBytes(bytes.buffer));
  const t = AIS.targets.get(4242);
  assert.ok(t, 'the target from a binary frame reaches the map');
  assert.strictEqual(t.name, 'BINARY BOAT');
  assert.strictEqual(t.sog, 12.5);
});

test('a frame that is not JSON reports what arrived, never "[object Blob]"', () => {
  resetAis();
  AIS.handleFrame('<html>502 Bad Gateway</html>');
  assert.strictEqual(AIS.status, 'error');
  assert.ok(AIS.detail.includes('502 Bad Gateway'), AIS.detail);
  assert.ok(!AIS.detail.includes('[object'), 'never shows the stringified object: ' + AIS.detail);
  AIS.handleFrame('');
  assert.ok(AIS.detail.includes('empty frame'), AIS.detail);
});

test('the server refusing the key is reported as rejected, with its own words', () => {
  resetAis();
  AIS.handleFrame(JSON.stringify({ error: 'Invalid API key' }));
  assert.strictEqual(AIS.status, 'rejected');
  assert.strictEqual(AIS.detail, 'Invalid API key');
  assert.strictEqual(AIS.targets.size, 0);
});
