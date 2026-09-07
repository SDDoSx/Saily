/* ais.js - optional live ship targets from aisstream.io (free API key, browser WebSocket) with CPA/TCPA alarms.
   No keyless public AIS feed covers the Strait of Gibraltar; without a key the module stays idle and says so. */
(function (root) {
  'use strict';
  const N = root.NAV;
  const A = {
    targets: new Map(), ws: null, status: 'off', key: '', bbox: null, onUpdate: null, onAlarm: null, own: null,
    retry: 0, timer: null, quiet: null, lastMsgAt: 0, alarmed: {},
    frames: 0, openedAt: 0, detail: '', lastError: '', onStatus: null,
    cpaWarnNm: 0.5, tcpaWarnMin: 12, staleMin: 10,
  };
  const URL_STREAM = 'wss://stream.aisstream.io/v0/stream';
  // aisstream takes any two opposite corners but is not documented to normalise them; send SW then NE.
  function boxOf(bbox) {
    const s = Math.min(bbox[0], bbox[2]), w = Math.min(bbox[1], bbox[3]);
    const n = Math.max(bbox[0], bbox[2]), e = Math.max(bbox[1], bbox[3]);
    return [[s, w], [n, e]];
  }
  function setStatus(status, detail) {
    A.status = status; if (detail !== undefined) A.detail = detail;
    if (A.onStatus) try { A.onStatus(A.status, A.detail); } catch (e) { }
  }
  function decodeBytes(buf) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(buf);
    let s = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  /** One decoded frame of UTF-8 JSON: an AIS report, or the server telling us why it is about to hang up. */
  function handleFrame(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) {
      // Show what actually arrived, never "[object Blob]": the text is the only clue to why it failed.
      A.lastError = String(text).replace(/\s+/g, ' ').trim().slice(0, 160) || 'empty frame';
      setStatus('error', 'the server sent something that is not JSON: ' + A.lastError);
      return;
    }
    // aisstream reports a bad key or a malformed subscription as a plain frame, then closes.
    const err = msg && (msg.error || msg.Error || (!msg.MetaData && typeof msg.message === 'string' && msg.message));
    if (err) { A.lastError = String(err).slice(0, 200); setStatus('rejected', A.lastError); return; }
    ingest(msg);
  }
  /** aisstream closes on a late or malformed subscription and on a bad key: say which, don't fail silently. */
  function closeReason(ev) {
    const code = ev && ev.code, why = (ev && ev.reason || '').trim();
    if (why) return `closed: ${why}`;
    if (A.frames === 0 && A.openedAt && Date.now() - A.openedAt < 15000) {
      return `closed ${code || '?'} right after subscribing: the key is usually the reason (check it at aisstream.io)`;
    }
    return `closed ${code || '?'}`;
  }
  function connect(key, bbox) {
    disconnect();
    A.key = key; A.bbox = bbox; A.frames = 0; A.openedAt = 0;
    if (!key) { setStatus('no key', 'paste an aisstream.io key'); return; }
    if (!('WebSocket' in root)) { setStatus('no websocket', 'this browser cannot stream AIS'); return; }
    if (!bbox || bbox.length !== 4) { setStatus('error', 'no area to subscribe to'); return; }
    try {
      setStatus('connecting', '');
      const ws = new WebSocket(URL_STREAM);
      // aisstream sends binary frames whose payload is UTF-8 JSON. Left alone, the browser hands them over
      // as a Blob and JSON.parse chokes on "[object Blob]"; asking for ArrayBuffer keeps decoding synchronous
      // and in order.
      ws.binaryType = 'arraybuffer';
      A.ws = ws;
      ws.onopen = () => {
        A.retry = 0; A.openedAt = Date.now();
        const box = boxOf(bbox);
        // The subscription must arrive within 3 s of the socket opening or aisstream closes it.
        ws.send(JSON.stringify({
          APIKey: key,
          BoundingBoxes: [box],
          FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'],
        }));
        setStatus('connected', `subscribed to ${box[0][0].toFixed(2)},${box[0][1].toFixed(2)} .. ${box[1][0].toFixed(2)},${box[1][1].toFixed(2)}`);
        // A key that is accepted but sees no traffic looks exactly like a key that was rejected. Say which.
        clearTimeout(A.quiet);
        A.quiet = setTimeout(() => {
          if (A.ws === ws && A.frames === 0) setStatus('connected', 'no messages yet: the key works only if this changes; otherwise check it, or the area may simply be quiet');
        }, 30000);
      };
      ws.onmessage = ev => {
        A.frames++;
        const d = ev.data;
        if (typeof d === 'string') return handleFrame(d);
        if (d instanceof ArrayBuffer) return handleFrame(decodeBytes(d));
        if (ArrayBuffer.isView && ArrayBuffer.isView(d)) return handleFrame(decodeBytes(d.buffer));
        if (d && typeof d.text === 'function') { d.text().then(handleFrame, () => setStatus('error', 'could not read the message from the server')); return; }
        setStatus('error', 'the server sent a frame this browser cannot read');
      };
      ws.onerror = () => { if (A.ws === ws) setStatus('error', 'the connection failed (network, or the browser blocked it)'); };
      ws.onclose = ev => {
        clearTimeout(A.quiet);
        if (A.ws !== ws) return;
        A.ws = null;
        if (!A.key) return;
        A.retry++;
        const wait = Math.min(60000, 2000 * Math.pow(2, A.retry));
        setStatus('reconnecting', `${A.lastError || closeReason(ev)}; retrying in ${Math.round(wait / 1000)} s`);
        A.timer = setTimeout(() => connect(A.key, A.bbox), wait);
      };
    } catch (e) { setStatus('error', String(e && e.message || e)); }
  }
  function disconnect() {
    clearTimeout(A.timer); clearTimeout(A.quiet);
    if (A.ws) { const w = A.ws; A.ws = null; try { w.close(); } catch (e) { } }
    setStatus(A.key ? 'stopped' : 'off', '');
  }
  /** AIS names are @-padded to a fixed width; some feeds pass the padding through. */
  function cleanName(v) { return String(v).replace(/@+/g, ' ').replace(/\s+/g, ' ').trim(); }
  /** aisstream message -> target */
  function ingest(msg) {
    if (!msg || !msg.MetaData) return;
    const md = msg.MetaData, mmsi = md.MMSI; if (!mmsi) return;
    const t = A.targets.get(mmsi) || { mmsi, name: '', lat: null, lon: null, cog: null, sog: null, hdg: null, type: null, t: 0 };
    if (md.ShipName && !t.name) t.name = cleanName(md.ShipName);
    const m = msg.Message || {};
    // Class A (1/2/3), Class B (18) and Class B extended (19) all carry a position.
    const pr = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport;
    if (pr) {
      t.lat = pr.Latitude != null ? pr.Latitude : md.latitude; t.lon = pr.Longitude != null ? pr.Longitude : md.longitude;
      t.cog = (pr.Cog != null && pr.Cog < 360) ? pr.Cog : null; t.sog = (pr.Sog != null && pr.Sog < 102) ? pr.Sog : null;
      t.hdg = (pr.TrueHeading != null && pr.TrueHeading < 360) ? pr.TrueHeading : null; t.t = Date.now();
    }
    const sd = m.ShipStaticData;
    if (sd) { if (sd.Name) t.name = cleanName(sd.Name); if (sd.Type != null) t.type = sd.Type; }
    // Class B static (24) comes in two parts: A carries the name, B the ship type.
    const sdr = m.StaticDataReport;
    if (sdr) {
      const a = sdr.ReportA, b = sdr.ReportB;
      if (a && a.Name) t.name = cleanName(a.Name);
      if (b && b.ShipType != null) t.type = b.ShipType;
    }
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
  A.boxOf = boxOf; A.cleanName = cleanName; A.handleFrame = handleFrame; A.decodeBytes = decodeBytes;
})(typeof self !== 'undefined' ? self : this);
