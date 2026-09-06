/* ais.js - optional live ship targets from aisstream.io (free API key, browser WebSocket) with CPA/TCPA alarms.
   No keyless public AIS feed covers the Strait of Gibraltar; without a key the module stays idle and says so. */
(function (root) {
  'use strict';
  const N = root.NAV;
  const A = {
    targets: new Map(), ws: null, status: 'off', key: '', bbox: null, onUpdate: null, onAlarm: null, own: null,
    retry: 0, timer: null, lastMsgAt: 0, alarmed: {},
    cpaWarnNm: 0.5, tcpaWarnMin: 12, staleMin: 10,
  };
  function connect(key, bbox) {
    disconnect();
    A.key = key; A.bbox = bbox;
    if (!key) { A.status = 'no key'; return; }
    if (!('WebSocket' in root)) { A.status = 'no websocket'; return; }
    try {
      A.status = 'connecting';
      const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
      A.ws = ws;
      ws.onopen = () => { A.retry = 0; A.status = 'connected'; ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[bbox[0], bbox[1]], [bbox[2], bbox[3]]]], FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'] })); };
      ws.onmessage = ev => { try { ingest(JSON.parse(ev.data)); } catch (e) { } };
      ws.onerror = () => { A.status = 'error'; };
      ws.onclose = () => { if (A.ws === ws) { A.ws = null; if (A.key) { A.status = 'reconnecting'; A.retry++; A.timer = setTimeout(() => connect(A.key, A.bbox), Math.min(60000, 2000 * Math.pow(2, A.retry))); } } };
    } catch (e) { A.status = 'error'; }
  }
  function disconnect() { clearTimeout(A.timer); if (A.ws) { const w = A.ws; A.ws = null; try { w.close(); } catch (e) { } } A.status = A.key ? 'stopped' : 'off'; }
  /** aisstream message -> target */
  function ingest(msg) {
    if (!msg || !msg.MetaData) return;
    const md = msg.MetaData, mmsi = md.MMSI; if (!mmsi) return;
    const t = A.targets.get(mmsi) || { mmsi, name: '', lat: null, lon: null, cog: null, sog: null, hdg: null, type: null, t: 0 };
    if (md.ShipName && !t.name) t.name = String(md.ShipName).trim();
    const pr = msg.Message && (msg.Message.PositionReport || msg.Message.StandardClassBPositionReport);
    if (pr) {
      t.lat = pr.Latitude != null ? pr.Latitude : md.latitude; t.lon = pr.Longitude != null ? pr.Longitude : md.longitude;
      t.cog = (pr.Cog != null && pr.Cog < 360) ? pr.Cog : null; t.sog = (pr.Sog != null && pr.Sog < 102) ? pr.Sog : null;
      t.hdg = (pr.TrueHeading != null && pr.TrueHeading < 360) ? pr.TrueHeading : null; t.t = Date.now();
    }
    const sd = msg.Message && msg.Message.ShipStaticData;
    if (sd) { if (sd.Name) t.name = String(sd.Name).trim(); if (sd.Type != null) t.type = sd.Type; }
    if (t.lat == null) return;
    A.targets.set(mmsi, t); A.lastMsgAt = Date.now();
    if (A.onUpdate) A.onUpdate(t);
    evaluate(t);
  }
  function prune() { const cut = Date.now() - A.staleMin * 60000; for (const [k, t] of A.targets) if (t.t < cut) A.targets.delete(k); }
  /** closest point of approach: returns {cpa nm, tcpa min, range nm, brg} using flat-earth relative motion */
  function cpa(own, tgt) {
    if (!own || own.lat == null || tgt.lat == null) return null;
    const kx = Math.cos(N.toRad(own.lat)) * 60, ky = 60;
    const dx = (tgt.lon - own.lon) * kx, dy = (tgt.lat - own.lat) * ky; // nm
    const range = Math.hypot(dx, dy); const brg = N.norm360(N.toDeg(Math.atan2(dx, dy)));
    const os = own.sog || 0, oc = own.cog || 0, ts = tgt.sog || 0, tc = tgt.cog || 0;
    const ovx = os * Math.sin(N.toRad(oc)), ovy = os * Math.cos(N.toRad(oc));
    const tvx = ts * Math.sin(N.toRad(tc)), tvy = ts * Math.cos(N.toRad(tc));
    const rvx = tvx - ovx, rvy = tvy - ovy; const rv2 = rvx * rvx + rvy * rvy;
    if (rv2 < 1e-6) return { cpa: range, tcpa: null, range, brg };
    const tcpaH = -(dx * rvx + dy * rvy) / rv2; // hours
    const cx = dx + rvx * tcpaH, cy = dy + rvy * tcpaH;
    return { cpa: Math.hypot(cx, cy), tcpa: tcpaH * 60, range, brg };
  }
  function evaluate(t) {
    if (!A.own || !A.onAlarm) return;
    const c = cpa(A.own, t); if (!c || c.tcpa === null) return;
    if (c.tcpa > 0 && c.tcpa < A.tcpaWarnMin && c.cpa < A.cpaWarnNm && c.range < 6) {
      const last = A.alarmed[t.mmsi] || 0;
      if (Date.now() - last > 180000) { A.alarmed[t.mmsi] = Date.now(); A.onAlarm(t, c); }
    }
  }
  /** targets sorted by CPA risk for the list/panel */
  function ranked() {
    prune();
    const out = [];
    for (const t of A.targets.values()) { const c = cpa(A.own, t); out.push({ t, c }); }
    out.sort((a, b) => (a.c ? a.c.range : 1e9) - (b.c ? b.c.range : 1e9));
    return out;
  }
  const TYPES = { 3: 'special', 5: 'special', 6: 'passenger', 7: 'cargo', 8: 'tanker', 9: 'other' };
  function typeName(code) { if (code == null) return ''; if (code === 30) return 'fishing'; if (code === 36 || code === 37) return 'sailing/pleasure'; if (code >= 40 && code < 50) return 'high-speed craft'; if (code >= 60 && code < 70) return 'passenger'; if (code >= 70 && code < 80) return 'cargo'; if (code >= 80 && code < 90) return 'tanker'; return TYPES[Math.floor(code / 10)] || ''; }
  root.AIS = A; A.connect = connect; A.disconnect = disconnect; A.ingest = ingest; A.cpa = cpa; A.ranked = ranked; A.typeName = typeName; A.prune = prune;
})(typeof self !== 'undefined' ? self : this);
