/* Saily app: GPS navigation, TSS/hazard alerts, weather, offline preload. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  try {
  const C = window.CHART, N = window.NAV, W = window.WX, P = window.PASSAGE;
  const SINGLE = !!window.SAILY_SINGLE; // single-file build (hosted artifact): no service worker, no raster tiles, embedded forecast
  const TZ_ES = P.tz.from.zone, TZ_MA = P.tz.to.zone, TZL_FROM = P.tz.from.label, TZL_TO = P.tz.to.label;
  const KEY = 'saily.settings.v2', TRACK_KEY = 'saily.track.v1', LOG_KEY = 'saily.alertlog.v1';
  const MS_TO_KN = 1.943844;

  // ---------- time helpers ----------
  function tzOffsetMin(tz, date) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date);
    const g = t => parseInt(p.find(x => x.type === t).value, 10);
    let h = g('hour'); if (h === 24) h = 0;
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), h, g('minute'), g('second'));
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  }
  function fromLocal(tz, isoLocal) { // 'YYYY-MM-DDTHH:MM' wall time in tz -> Date
    const guess = new Date(isoLocal + ':00Z');
    const off = tzOffsetMin(tz, guess);
    return new Date(guess.getTime() - off * 60000);
  }
  function toLocalInput(tz, date) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const g = t => p.find(x => x.type === t).value;
    let h = g('hour'); if (h === '24') h = '00';
    return `${g('year')}-${g('month')}-${g('day')}T${h}:${g('minute')}`;
  }
  function defaultDeparture() {
    const today = toLocalInput(TZ_ES, new Date()).slice(0, 10);
    return fromLocal(TZ_ES, today + 'T' + (P.defaultDeparture || '13:30')).toISOString();
  }
  // Destination-zone clock: the phone's time zone database by default, or a manual UTC offset from
  // passage.tz.to.offsets when a country is mid-change and the database on the phone may be stale.
  function fmtMA(d) {
    const o = S.settings && S.settings.maOffset;
    if (o === undefined || o === 'auto') return N.fmtTime(d, TZ_MA);
    return N.fmtTime(new Date(d.getTime() + parseInt(o, 10) * 60000), 'UTC');
  }
  const bothTimes = d => `${N.fmtTime(d, TZ_ES)} ${TZL_FROM} · ${fmtMA(d)} ${TZL_TO}`;
  const DEST_NAME = P.destinationShort || 'destination';   // the short name for headings and ETA labels
  const TZ_OFFSETS = (P.tz.to && P.tz.to.offsets) || [];   // manual UTC offsets offered in Setup
  const returnRoute = () => P.routes.find(r => r.isReturn) || null;
  /** Escape text that came from outside the app (feed errors, ship names) before it goes into innerHTML. */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- state ----------
  const DEFAULTS = { speed: (P.vessel && P.vessel.cruiseKn) || 22, routeId: (P.routes.find(r => r.recommended) || P.routes[0]).id, departure: defaultDeparture(), voice: true, sound: true, th: Object.assign({}, W.DEFAULT_THRESHOLDS), base: 'carto', seamark: true, chartOnly: false, theme: 'auto', dim: 0, bigHud: false, wp: 1, checklist: {}, maOffset: 'auto', autoZoom: true, aisOn: false, aisKey: '', aisDemo: true, depth: false };
  const S = {
    settings: loadSettings(), pos: null, lastFixAt: 0, fixes: [], track: [], smoother: N.makeSmoother(0.35), sog: null, cog: null, acc: null,
    started: false, navigating: false, sim: null, watchId: null, wakeLock: null, audio: null, muted: false,
    zone: {}, hazard: {}, hazardNear: {}, manualWp: false, approached: {}, alertLast: {}, log: loadJson(LOG_KEY, []), wx: W.load() || (window.EMBEDDED_WX ? W.fromRaw(window.EMBEDDED_WX.points, window.EMBEDDED_WX.fetchedAt) : null), solution: null, route: null, follow: true,
    lastWxAlert: 0, sunsetWarned: false, nightNoted: false, layers: {}, aidsShown: false,
    lastAlertText: '', lastAlertAt: 0, mob: null, marks: [], trip: null, userZoomAt: 0, programmaticZoom: false, progZoomAt: 0,
  };
  function loadSettings() {
    const s = loadJson(KEY, null);
    const merged = Object.assign({}, DEFAULTS, s || {});
    merged.th = Object.assign({}, W.DEFAULT_THRESHOLDS, (s && s.th) || {});
    if (s && !s.theme) merged.theme = s.night ? 'night' : s.day ? 'day' : 'auto'; // settings v2 before the theme selector
    if (!s || !s.departure || new Date(s.departure).getTime() < Date.now() - 36 * 3600000) merged.departure = defaultDeparture();
    return merged;
  }
  function saveSettings() { try { const s = S.sim ? Object.assign({}, S.settings, { wp: S.simSavedWp }) : S.settings; localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { } }
  function loadJson(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

  S.route = P.routes.find(r => r.id === S.settings.routeId) || P.routes[0];
  const WPS = () => S.route.waypoints;
  const DEST = () => WPS()[WPS().length - 1];

  // ---------- UI basics ----------
  function toast(msg, ms, action) {
    const t = $('toast'); t.textContent = msg;
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.addEventListener('click', () => { t.classList.remove('show'); action.fn(); }); t.appendChild(b); }
    t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms || 2500);
  }
  function showView(v) {
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    if (v === 'nav') setTimeout(() => map.invalidateSize(), 50);
    if (v === 'wx') renderWx();
    if (v === 'plan') renderPlan();
    if (v === 'more') renderMore();
  }
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

  function tickClocks() {
    const now = new Date();
    $('clockES').textContent = N.fmtTime(now, TZ_ES);
    $('clockMA').textContent = fmtMA(now);
  }
  setInterval(tickClocks, 1000); tickClocks();

  function setNet() {
    const on = navigator.onLine;
    $('netText').textContent = (on ? 'online' : 'OFFLINE') + (S.started ? (S.wakeLock ? ' 🔆' : ' ⚠︎') : '');
    $('netDot').className = 'dot ' + (on ? 'ok' : 'warn');
    if (on && (!S.wx || Date.now() - S.wx.fetchedAt > 45 * 60000)) refreshWeather(false);
  }
  window.addEventListener('online', setNet); window.addEventListener('offline', setNet);

  // ---------- alerts, sound, speech ----------
  function ensureAudio() {
    try {
      if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
      if (S.audio.state === 'suspended') S.audio.resume();
      try { if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; } catch (e) { } // iOS: play through the silent switch
      // unlock speech on iOS with an empty utterance
      if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
    } catch (e) { }
  }
  function beep(count, freq, dur) {
    if (!S.audio || S.muted || !S.settings.sound) return;
    try {
      const ctx = S.audio; if (ctx.state === 'suspended') ctx.resume(); let t = ctx.currentTime;
      for (let i = 0; i < count; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.0001;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.start(t); o.stop(t + dur + 0.02); t += dur + 0.12;
      }
    } catch (e) { }
  }
  // Speech: sentence-level queue. Priority 2 (danger) interrupts lower priority speech only; danger behind danger queues
  // (max 2, deduplicated by id). The first sentence of an item is its action and is always spoken when its turn comes;
  // the remaining sentences yield to anything of equal or higher priority waiting. Watchdog per sentence.
  const speech = { q: [], cur: null, busy: false, timer: null };
  const splitSentences = t => (String(t).match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [String(t)]).map(x => x.trim()).filter(Boolean);
  function speak(text, level, id) {
    if (S.muted || !S.settings.voice || !('speechSynthesis' in window)) return;
    const pr = level === 'danger' ? 2 : level === 'warn' ? 1 : 0;
    const item = { id: id || text.slice(0, 24), pr, sentences: splitSentences(text) };
    if (pr === 2) {
      if (speech.cur && speech.cur.pr < 2) { try { speechSynthesis.cancel(); } catch (e) { } speech.busy = false; if (speech.cur.sentences.length) speech.q.unshift(speech.cur); speech.cur = null; }
      speech.q = speech.q.filter(x => x.pr === 2 && x.id !== item.id).slice(-1);
      speech.q.push(item);
    } else {
      if (speech.q.length >= 3 && pr === 0) return; // busy: drop info
      speech.q = speech.q.filter(x => x.id !== item.id);
      speech.q.push(item);
      speech.q.sort((x, y) => y.pr - x.pr);
    }
    S.lastHeadline = pr >= 1 ? item.sentences[0] : S.lastHeadline;
    pumpSpeech();
  }
  function pumpSpeech() {
    if (speech.busy) return;
    if (speech.cur && speech.cur.sentences.length) {
      // trailing sentences of the current item yield to anything of equal or higher priority
      if (speech.q.some(x => x.pr >= speech.cur.pr)) speech.cur = null;
    }
    if (!speech.cur || !speech.cur.sentences.length) { speech.cur = speech.q.shift() || null; if (!speech.cur) return; }
    const sentence = speech.cur.sentences.shift();
    try {
      const u = new SpeechSynthesisUtterance(sentence); u.lang = 'en-GB'; u.rate = 1.0; u.volume = 1;
      const done = () => { clearTimeout(speech.timer); speech.busy = false; setTimeout(pumpSpeech, 120); };
      u.onend = done; u.onerror = done;
      speech.busy = true; clearTimeout(speech.timer); speech.timer = setTimeout(done, Math.min(12000, 2000 + sentence.length * 60));
      speechSynthesis.speak(u);
    } catch (e) { speech.busy = false; }
  }
  let bannerTimer = null, bannerAt = 0;
  function showBanner(level, text, ms, snoozeId) {
    const b = $('alertBanner'); b.className = level; b.classList.remove('hidden');
    const sn = $('alertSnooze'); if (sn) { sn.style.display = snoozeId ? '' : 'none'; sn.dataset.id = snoozeId || ''; }
    const m = /^(.*?[.!?])\s+(.*)$/s.exec(text); $('alertMain').textContent = m ? m[1] : text; $('alertRest').textContent = m ? m[2] : '';
    bannerAt = Date.now(); $('alertAge').textContent = '';
    clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  }
  setInterval(() => { if (!$('alertBanner').classList.contains('hidden') && bannerAt) { const m = Math.round((Date.now() - bannerAt) / 60000); $('alertAge').textContent = m >= 1 ? m + ' min ago' : ''; } }, 15000);
  $('alertBanner').addEventListener('click', e => { if (e.target.id === 'alertDismiss') $('alertBanner').classList.add('hidden'); else if (e.target.id === 'alertSnooze') { const id = e.target.dataset.id; const pol = policyFor(id); S.snooze = S.snooze || {}; S.snooze[id] = Date.now() + (pol.snooze || 600) * 1000; $('alertBanner').classList.add('hidden'); toast('Quiet for ' + Math.round((pol.snooze || 600) / 60) + ' min: ' + id); } else $('alertBanner').classList.toggle('expanded'); });
  /** Alert policy by id prefix. repeat: 'interval' (seconds), 'on-change' (value delta or interval), 'once', 'first-spoken'. */
  const POLICY = [
    ['xte', { repeat: 'on-change', delta: 0.2, interval: 300, snooze: 600, speakLevel: 'warn' }],
    ['wxnow', { repeat: 'on-change', interval: 1800, snooze: 1800 }],
    ['wxchange', { repeat: 'on-change', interval: 600, snooze: 1800 }],
    ['gpslost', { repeat: 'interval', interval: 300, speakDelay: 65 }],
    ['harbspeed', { repeat: 'once', snooze: 600 }],
    ['zoneout-', { repeat: 'interval', interval: 30, speak: 'first' }],
    ['zone-itz', { repeat: 'interval', interval: 30, speak: 'first' }],
    ['zone-', { repeat: 'interval', interval: 30 }],
    ['haz-', { repeat: 'interval', interval: 120 }],
    ['hazn-', { repeat: 'interval', interval: 120 }],
    ['ais-', { repeat: 'interval', interval: 180 }],
    ['landahead', { repeat: 'interval', interval: 30 }],
    ['lanehdg', { repeat: 'interval', interval: 60 }],
    ['anchordrag', { repeat: 'interval', interval: 30 }],
    ['wp', { speakLevel: 'warn' }], ['appr', { speakLevel: 'warn' }],
  ];
  const policyFor = id => { for (const [k, p] of POLICY) if (id.startsWith(k)) return p; return {}; };
  /** level: info | warn | danger. opt: {cooldown, speak, value} */
  function alert(id, level, text, opt) {
    opt = opt || {};
    const now = Date.now();
    const pol = policyFor(id);
    const last = S.alertLast[id];
    const interval = (pol.interval || opt.cooldown || 0) * 1000;
    S.snooze = S.snooze || {};
    if (S.snooze[id] && S.snooze[id] > now) { if (last) last.n++; return false; }
    let suppressed = false;
    if (last && typeof last === 'object') {
      if (pol.repeat === 'once') suppressed = true;
      else if (pol.repeat === 'on-change') suppressed = !((opt.value !== undefined && last.value !== undefined && (typeof opt.value === 'number' ? Math.abs(opt.value - last.value) >= (pol.delta || 0) : opt.value !== last.value)) || now - last.t >= interval);
      else if (interval) suppressed = now - last.t < interval;
    }
    if (suppressed) { last.n++; const li = S.log.find(l => l.id === id); if (li) li.n = last.n; return false; }
    S.alertLast[id] = { t: now, n: 1, value: opt.value, count: ((last && last.count) || 0) + 1 };
    S.lastAlertText = text; S.lastAlertAt = now;
    S.log.unshift({ t: now, level, text, id }); if (S.log.length > 200) S.log.length = 200; saveJson(LOG_KEY, S.log);
    const planned = level !== 'danger' && id.startsWith('haz-') && S.plannedHaz && S.plannedHaz.has(id.slice(4));
    const shownLevel = planned ? 'info' : level;
    showBanner(shownLevel, text, shownLevel === 'danger' ? 0 : shownLevel === 'warn' ? 40000 : 15000, pol.snooze ? id : null);
    if (shownLevel === 'danger') { beep(3, 880, 0.35); flashDanger(); } else if (shownLevel === 'warn') beep(2, 660, 0.2); else beep(1, 520, 0.12);
    const speakIt = opt.speak !== false && !(pol.speak === 'first' && S.alertLast[id].count > 1);
    if (speakIt) speak(text, pol.speakLevel || shownLevel, id);
    try { if (navigator.vibrate) navigator.vibrate(shownLevel === 'danger' ? [300, 100, 300, 100, 300] : shownLevel === 'warn' ? [200, 100, 200] : 120); } catch (e) { }
    return true;
  }
  function flashDanger() { document.body.classList.remove('flash'); void document.body.offsetWidth; document.body.classList.add('flash'); setTimeout(() => document.body.classList.remove('flash'), 1300); }
  /** persistent danger strip: shows while a danger condition holds (independent of the banner) */
  function renderDangerStrip() {
    const el = $('dangerStrip'); if (!el) return;
    const items = [];
    if (S.mob) items.push('MAN OVERBOARD');
    for (const l of C.tss.lanes) if (S.zone[l.id]) items.push(l.flow === 'W' ? 'IN WESTBOUND LANE' : 'IN EASTBOUND LANE');
    for (const z of C.tss.zones) if (S.zone[z.id]) items.push('IN SEPARATION ZONE');
    if (S.gpsLost) items.push('GPS LOST');
    if (S.alertLast.landahead && Date.now() - S.alertLast.landahead.t < 30000) items.push('LAND AHEAD');
    if (S.alertLast.anchordrag && Date.now() - S.alertLast.anchordrag.t < 60000) items.push('ANCHOR DRAGGING');
    for (const h of (S.dangers || [])) if (h.level === 'danger' && S.hazard[h.id]) items.push(h.name.toUpperCase());
    el.textContent = items.join(' · '); el.classList.toggle('hidden', !items.length);
  }
  setInterval(renderDangerStrip, 2000);
  /** hazards whose circle touches a leg of the active route are 'planned': briefed, not alarmed */
  function computePlannedHazards() {
    const wps = WPS(); const set = new Set();
    for (const h of (S.dangers || P.hazards)) {
      if (h.level === 'danger') continue;
      for (let i = 0; i < wps.length - 1; i++) {
        const along = N.alongTrackNm(h, wps[i], wps[i + 1]); const leg = N.distanceNm(wps[i], wps[i + 1]);
        const d = along < 0 ? N.distanceNm(h, wps[i]) : along > leg ? N.distanceNm(h, wps[i + 1]) : Math.abs(N.crossTrackNm(h, wps[i], wps[i + 1]));
        if (d < h.radius) { set.add(h.id); break; }
      }
    }
    S.plannedHaz = set;
  }
  // ---------- wake lock ----------
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) { S.wakeLock = await navigator.wakeLock.request('screen'); S.wakeLock.addEventListener('release', () => { S.wakeLock = null; renderLockState(); }); S.wakeRefusals = 0; }
    } catch (e) { S.wakeLock = null; S.wakeRefusals = (S.wakeRefusals || 0) + 1; if (S.wakeRefusals === 2 && document.visibilityState === 'visible') toast('Screen lock refused: disable Low Power Mode or set Auto-Lock to Never', 6000); }
    renderLockState();
  }
  function renderLockState() { const el = $('netText'); if (!el) return; el.title = S.wakeLock ? 'screen wake lock held' : 'no wake lock'; el.textContent = (navigator.onLine ? 'online' : 'OFFLINE') + (S.started ? (S.wakeLock ? ' 🔆' : ' ⚠︎') : ''); }
  setInterval(() => { if (S.started && S.navigating && !S.wakeLock && document.visibilityState === 'visible') requestWakeLock(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.started && !S.wakeLock) requestWakeLock();
    try { if (S.audio && S.audio.state === 'suspended') S.audio.resume(); } catch (e) { }
    S.lastFixAt = Date.now(); // grace period: no false 'GPS lost' right after coming back from background
    if (navigator.onLine && (!S.wx || Date.now() - S.wx.fetchedAt > 20 * 60000)) refreshWeather(false);
    if (S.watchId !== null) { stopGps(); startGps(); } // iOS often leaves the old watch dead
    setTimeout(() => map.invalidateSize(), 50);
  });

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false }).setView([36.03, -5.52], 10);
  map.attributionControl.setPrefix('');
  try { new ResizeObserver(() => map.invalidateSize()).observe($('mapWrap')); } catch (e) { }
  map.createPane('land').style.zIndex = 150;
  map.createPane('tss').style.zIndex = 405;
  map.createPane('haz').style.zIndex = 408;
  map.createPane('route').style.zIndex = 420;
  map.createPane('aids').style.zIndex = 430;
  map.createPane('vessel').style.zIndex = 650;
  const BASES = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
    carto: L.tileLayer('https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap © CARTO' }), // single host: preload cache keys must match
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery © Esri' }),
  };
  const SEAMARK = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenSeaMap' });
  const DEPTH = L.tileLayer.wms('https://ows.emodnet-bathymetry.eu/wms', { layers: 'emodnet:mean_atlas_land', format: 'image/png', transparent: true, opacity: 0.55, attribution: 'EMODnet Bathymetry' });
  const CONTOURS = L.tileLayer.wms('https://ows.emodnet-bathymetry.eu/wms', { layers: 'emodnet:contours', format: 'image/png', transparent: true, opacity: 0.8 });
  function applyBase() {
    Object.values(BASES).forEach(l => map.removeLayer(l));
    if (map.hasLayer(SEAMARK)) map.removeLayer(SEAMARK);
    if (map.hasLayer(DEPTH)) map.removeLayer(DEPTH); if (map.hasLayer(CONTOURS)) map.removeLayer(CONTOURS);
    if (!S.settings.chartOnly && !SINGLE) {
      (BASES[S.settings.base] || BASES.carto).addTo(map);
      if (S.settings.depth) { DEPTH.addTo(map); CONTOURS.addTo(map); }
      if (S.settings.seamark) SEAMARK.addTo(map);
    }
    $('btnChartOnly').classList.toggle('on', !!S.settings.chartOnly);
    applyTheme();
  }
  /** day, dark or night colours. Auto: night from 20 min before sunset to 20 min after sunrise at the passage's sun point. */
  function resolveTheme() {
    const t = S.settings.theme || 'auto';
    if (t !== 'auto') return t;
    const now = new Date(); const st = N.sunTimes(now, P.sun.lat, P.sun.lon);
    if (!st.sunrise || !st.sunset) return 'dark';
    const m = 20 * 60000;
    return (now < st.sunrise.getTime() + m || now > st.sunset.getTime() - m) ? 'night' : 'dark';
  }
  function applyTheme() {
    const t = resolveTheme(); const prev = S.themeNow; S.themeNow = t;
    document.body.classList.toggle('day', t === 'day'); document.body.classList.toggle('night', t === 'night');
    document.body.classList.toggle('bighud', !!S.settings.bigHud);
    $('btnDay').classList.toggle('on', S.settings.theme === 'day'); $('btnNight').classList.toggle('on', S.settings.theme === 'night');
    const bb = $('btnBig'); if (bb) bb.classList.toggle('on', !!S.settings.bigHud);
    const dim = $('dimmer'); if (dim) dim.style.opacity = t === 'night' ? String(Math.min(0.85, S.settings.dim || 0)) : '0';
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.setAttribute('content', t === 'day' ? '#f2f5f8' : t === 'night' ? '#000000' : '#0b1a2b');
    if (prev && prev !== t && (S.settings.theme || 'auto') === 'auto') toast(t === 'night' ? 'Night colours (sunset). Dimmer in Setup.' : 'Day colours (sunrise).', 8000, { label: 'Keep ' + (prev === 'night' ? 'night' : 'dark'), fn: () => { S.settings.theme = prev; saveSettings(); applyTheme(); } });
    if (S.solution && map) setTimeout(() => map.invalidateSize(), 50);
  }
  setInterval(applyTheme, 60000);
  // land polygons (vector fallback under tiles)
  const landStyle = { pane: 'land', color: '#7d6b4a', weight: 1, fillColor: '#e9e2cd', fillOpacity: 1, interactive: false };
  C.land.forEach(r => L.polygon(r, landStyle).addTo(map));
  const detailGroup = L.layerGroup();
  Object.values(C.landDetail).forEach(rings => rings.forEach(r => detailGroup.addLayer(L.polygon(r, landStyle))));
  const structGroup = L.layerGroup();
  C.structures.forEach(line => structGroup.addLayer(L.polyline(line, { pane: 'aids', color: '#333', weight: 3, interactive: false })));
  // TSS
  const tssGroup = L.layerGroup().addTo(map);
  const flowText = f => f === 'W' ? 'Traffic flows WEST (ships come from the east)' : 'Traffic flows EAST (ships come from the west)';
  C.tss.lanes.forEach(l => l.rings.forEach(r => tssGroup.addLayer(L.polygon(r, { pane: 'tss', color: '#c2249f', weight: 1.2, dashArray: '6 4', fillColor: '#c2249f', fillOpacity: 0.07 }).bindPopup(`<b>${l.name}</b>${flowText(l.flow)}<br>Cross at right angles, do not follow the lane.`))));
  C.tss.zones.forEach(z => z.rings.forEach(r => tssGroup.addLayer(L.polygon(r, { pane: 'tss', color: '#c2249f', weight: 1, fillColor: '#c2249f', fillOpacity: 0.3 }).bindPopup(`<b>${z.name}</b>Keep out. Cross quickly at right angles if you must.`))));
  C.tss.precautionary.forEach(p => p.rings.forEach(r => tssGroup.addLayer(L.polygon(r, { pane: 'tss', color: '#c2249f', weight: 1.5, dashArray: '2 6', fillColor: '#c2249f', fillOpacity: 0.04 }).bindPopup(`<b>${p.name}</b>Ships converge and alter course here. Extra caution.`))));
  C.tss.itz.forEach(z => z.rings.forEach(r => tssGroup.addLayer(L.polygon(r, { pane: 'tss', color: '#2e8b57', weight: 1, dashArray: '8 6', fillColor: '#2e8b57', fillOpacity: 0.04 }).bindPopup(`<b>${z.name}</b>Small craft may use this zone. Stay out of the lanes.`))));
  C.tss.free.forEach(z => z.rings.forEach(r => tssGroup.addLayer(L.polygon(r, { pane: 'tss', color: '#888', weight: 1, dashArray: '3 5', fill: false }).bindPopup(`<b>${z.name}</b>`))));
  C.tss.lanes.forEach(l => l.arrows.forEach(a => tssGroup.addLayer(L.marker([a[0], a[1]], { pane: 'tss', interactive: false, icon: L.divIcon({ className: '', html: `<div style="transform:rotate(${a[2] - 90}deg);color:#c2249f;font-size:18px;line-height:18px;width:18px;height:18px;text-align:center;opacity:.8">➤</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }))));
  C.anchorages.forEach(a => tssGroup.addLayer(L.polygon(a.ring, { pane: 'tss', color: '#666', weight: 1, dashArray: '4 4', fillOpacity: 0.05 }).bindPopup(`<b>${a.name}</b>Ships at anchor.`)));
  // hazards: passage-defined circles plus every charted wreck, rock and obstruction (alarm radius 0.1 nm)
  const hazColor = { danger: '#ff2b2b', caution: '#ff9f1a', info: '#4aa3ff' };
  const chartedDangers = C.aids.filter(x => ['wreck', 'rock', 'obstruction'].includes(x.type)).map(x => ({ id: 'aid-' + x.type + '-' + x.lat + '-' + x.lon, lat: x.lat, lon: x.lon, radius: 0.1, level: 'danger', name: `${x.type === 'wreck' ? 'Wreck' : x.type === 'rock' ? 'Rock' : 'Obstruction'}${x.name ? ' ' + x.name : ''}`, note: 'Charted ' + x.type + ' (OpenStreetMap seamark). Keep clear.' }));
  S.dangers = P.hazards.concat(chartedDangers);
  computePlannedHazards();
  S.dangers.forEach(h => L.circle([h.lat, h.lon], { pane: 'haz', radius: h.radius * 1852, color: hazColor[h.level], weight: 1.5, dashArray: h.level === 'danger' ? null : '5 5', fillColor: hazColor[h.level], fillOpacity: h.level === 'danger' ? 0.2 : 0.08 }).bindPopup(`<b>${h.name}</b>${h.note}`).addTo(map));
  chartedDangers.forEach(h => L.marker([h.lat, h.lon], { pane: 'haz', interactive: false, icon: L.divIcon({ className: '', html: '<div style="color:#ff2b2b;font-weight:900;font-size:16px;line-height:16px;text-shadow:0 0 2px #fff">✱</div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map));
  // aids
  const aidsGroup = L.layerGroup();
  const aidColor = a => /red/i.test(a.light) ? '#e53935' : /green/i.test(a.light) ? '#2e7d32' : a.type === 'wreck' || a.type === 'obstruction' ? '#000' : a.type.includes('cardinal') ? '#f5b400' : '#f2f2f2';
  C.aids.forEach(a => {
    const isLight = a.type.startsWith('light');
    aidsGroup.addLayer(L.circleMarker([a.lat, a.lon], { pane: 'aids', radius: isLight ? 5 : 4, color: '#111', weight: 1, fillColor: aidColor(a), fillOpacity: 1 })
      .bindPopup(`<b>${a.name || a.type.replace(/_/g, ' ')}</b>${a.type.replace(/_/g, ' ')}${a.cat ? ' · ' + a.cat : ''}${a.light ? '<br>Light: ' + a.light : ''}<br>${N.fmtDM(a.lat, a.lon)}`));
  });
  function progZoom(fn) { S.programmaticZoom = true; S.progZoomAt = Date.now(); try { fn(); } finally { setTimeout(() => { S.programmaticZoom = false; }, 0); } }
  function updateZoomLayers() {
    const z = map.getZoom();
    const wantAids = z >= 12, wantDetail = z >= 13;
    if (wantAids !== map.hasLayer(aidsGroup)) wantAids ? aidsGroup.addTo(map) : map.removeLayer(aidsGroup);
    if (wantDetail !== map.hasLayer(detailGroup)) { if (wantDetail) { detailGroup.addTo(map); structGroup.addTo(map); } else { map.removeLayer(detailGroup); map.removeLayer(structGroup); } }
  }
  map.on('zoomend', updateZoomLayers); updateZoomLayers();
  // routes
  const routeGroup = L.layerGroup().addTo(map);
  function drawRoutes() {
    routeGroup.clearLayers();
    if (S.dangers) computePlannedHazards();
    P.routes.forEach(r => {
      const active = r.id === S.route.id;
      const ll = r.waypoints.map(w => [w.lat, w.lon]);
      routeGroup.addLayer(L.polyline(ll, { pane: 'route', color: active ? '#ff2d95' : '#777', weight: active ? 4 : 2, opacity: active ? 0.9 : 0.6, dashArray: active ? null : '6 8', interactive: !active }).bindPopup(`<b>${r.name}</b>${r.total} nm`));
      if (active) r.waypoints.forEach((w, i) => {
        routeGroup.addLayer(L.circleMarker([w.lat, w.lon], { pane: 'route', radius: 6, color: '#fff', weight: 2, fillColor: '#ff2d95', fillOpacity: 1 }).bindPopup(`<b>${w.id} · ${w.name}</b>${w.note}<br>${N.fmtDM(w.lat, w.lon)}`));
        routeGroup.addLayer(L.marker([w.lat, w.lon], { pane: 'route', interactive: false, icon: L.divIcon({ className: '', html: `<div class="wplabel ${i < S.settings.wp ? 'dim' : ''}">${w.id}</div>`, iconAnchor: [-8, 8] }) }));
      });
    });
  }
  drawRoutes();
  // vessel + track + bearing line
  const vesselIcon = L.divIcon({ className: 'vessel', iconSize: [0, 0], html: `<div id="vesselRot" style="width:44px;height:44px;margin:-22px 0 0 -22px;transform:rotate(0deg)"><svg viewBox="0 0 44 44" width="44" height="44"><path d="M22 3 L32 36 L22 30 L12 36 Z" fill="#43b3ff" stroke="#031" stroke-width="2"/><circle cx="22" cy="22" r="20" fill="none" stroke="#43b3ff" stroke-width="1.5" opacity=".5"/></svg></div>` });
  const vessel = L.marker([36.2869, -5.2701], { icon: vesselIcon, pane: 'vessel', interactive: false });
  const accCircle = L.circle([36.2869, -5.2701], { radius: 0, color: '#43b3ff', weight: 1, fillOpacity: 0.1, interactive: false, pane: 'haz' });
  const track = L.polyline([], { pane: 'route', color: '#43b3ff', weight: 2, opacity: 0.8, interactive: false }).addTo(map);
  const brgLine = L.polyline([], { pane: 'route', color: '#ffe066', weight: 2, dashArray: '4 6', interactive: false }).addTo(map);
  const predLine = L.polyline([], { pane: 'route', color: '#43b3ff', weight: 1.5, interactive: false }).addTo(map);
  const savedTrack = loadJson(TRACK_KEY, []);
  if (savedTrack.length && Date.now() - savedTrack[savedTrack.length - 1][2] < 12 * 3600000) { S.track = savedTrack; track.setLatLngs(S.track.map(p => [p[0], p[1]])); const lp = S.track[S.track.length - 1]; vessel.setLatLng([lp[0], lp[1]]); vessel.setOpacity(0.5); vessel.addTo(map); }
  map.on('dragstart', () => { S.follow = false; $('btnFollow').classList.remove('on'); });
  map.on('zoomstart', () => { if (!S.programmaticZoom && Date.now() - (S.progZoomAt || 0) > 500) S.userZoomAt = Date.now(); });
  $('btnMore').addEventListener('click', () => { $('mapControls').classList.toggle('open'); $('btnMore').classList.toggle('on', $('mapControls').classList.contains('open')); });
  $('btnZoomIn').addEventListener('click', () => { S.userZoomAt = Date.now(); map.zoomIn(); });
  $('btnZoomOut').addEventListener('click', () => { S.userZoomAt = Date.now(); map.zoomOut(); });
  $('btnFollow').addEventListener('click', () => { S.follow = !S.follow; $('btnFollow').classList.toggle('on', S.follow); if (S.follow && S.pos) map.panTo([S.pos.lat, S.pos.lon]); });
  $('btnRoute').addEventListener('click', () => { S.follow = false; $('btnFollow').classList.remove('on'); S.userZoomAt = Date.now(); map.fitBounds(S.route.waypoints.map(w => [w.lat, w.lon]), { padding: [30, 30] }); });
  $('btnLayers').addEventListener('click', () => { const order = ['carto', 'osm', 'sat']; S.settings.base = order[(order.indexOf(S.settings.base) + 1) % order.length]; S.settings.chartOnly = false; saveSettings(); applyBase(); toast('Base map: ' + { osm: 'OpenStreetMap', carto: 'CARTO light', sat: 'Satellite' }[S.settings.base]); });
  $('btnChartOnly').addEventListener('click', () => { S.settings.chartOnly = !S.settings.chartOnly; saveSettings(); applyBase(); toast(S.settings.chartOnly ? 'Vector chart only (works fully offline)' : 'Tiles on'); });
  $('btnNight').addEventListener('click', () => { S.settings.theme = S.settings.theme === 'night' ? 'auto' : 'night'; saveSettings(); applyTheme(); toast(S.settings.theme === 'night' ? 'Night colours on' : 'Colours: automatic (night after sunset)'); });
  $('btnDay').addEventListener('click', () => { S.settings.theme = S.settings.theme === 'day' ? 'auto' : 'day'; saveSettings(); applyTheme(); toast(S.settings.theme === 'day' ? 'Daylight colours on' : 'Colours: automatic (night after sunset)'); });
  $('btnChartBack').addEventListener('click', () => { S.settings.bigHud = false; saveSettings(); applyTheme(); });
  $('btnBig').addEventListener('click', () => { S.settings.bigHud = !S.settings.bigHud; saveSettings(); applyTheme(); toast(S.settings.bigHud ? 'Big numbers: chart hidden. Tap A again for the chart.' : 'Chart shown'); });
  applyBase();
  if (SINGLE) { $('btnLayers').style.display = 'none'; $('btnChartOnly').style.display = 'none'; }
  // place labels for the vector chart
  const labelGroup = L.layerGroup();
  (P.labels || []).forEach(l => labelGroup.addLayer(L.marker([l.lat, l.lon], { pane: 'aids', interactive: false, icon: L.divIcon({ className: '', html: `<div class="plabel ${l.kind}" data-z="${l.z}">${l.name}</div>`, iconAnchor: [0, 8] }) })));
  labelGroup.addTo(map);
  function updateLabels() { const z = map.getZoom(); document.querySelectorAll('.plabel').forEach(el => { el.style.display = z >= +el.dataset.z ? '' : 'none'; }); }
  map.on('zoomend', updateLabels); setTimeout(updateLabels, 0);
  progZoom(() => map.fitBounds(S.route.waypoints.map(w => [w.lat, w.lon]), { padding: [20, 20] }));

  // ---------- GPS ----------
  function setGps(status, text) { $('gpsDot').className = 'dot ' + status; $('gpsText').textContent = text; }
  function startGps() {
    if (!('geolocation' in navigator)) { setGps('bad', 'no GPS'); alert('nogps', 'danger', 'This device has no geolocation support.'); return; }
    if (S.watchId !== null) return;
    setGps('warn', 'GPS…');
    S.watchId = navigator.geolocation.watchPosition(onFix, err => {
      setGps('bad', 'GPS error');
      if (err.code === 1) alert('gpsdenied', 'danger', 'Location permission denied. Enable it for Safari in iPhone Settings, Privacy, Location Services.', { cooldown: 120 });
      else setGps('bad', err.code === 3 ? 'GPS timeout' : 'GPS error'); // transient errors are folded into the GPS-lost watchdog
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function stopGps() { if (S.watchId !== null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; } }
  function onFix(p) {
    const c = p.coords;
    const fix = { lat: c.latitude, lon: c.longitude, t: p.timestamp || Date.now(), acc: c.accuracy };
    const prev = S.fixes.length ? S.fixes[S.fixes.length - 1] : null;
    let sog = (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0 && c.speed * MS_TO_KN < 80) ? c.speed * MS_TO_KN : null;
    let cog = (typeof c.heading === 'number' && isFinite(c.heading) && sog !== null && sog > 1.5) ? c.heading : null;
    if (prev) {
      const d = N.deltaSpeedCourse(prev, fix);
      if (d && d.dt >= 0.8 && d.sog < 60) { // >60 kn between fixes = GPS jump: ignore for both speed and course
        if (sog === null) sog = d.dt < 30 ? d.sog : null;
        if (cog === null && d.d * 1852 > Math.max(8, (fix.acc || 10) * 0.6) && (sog === null || sog > 1.5)) cog = d.cog;
      }
    }
    // fix-quality gate: reject jumps outright, and do not let poor or stale fixes drive any guard or transition
    if (prev) { const d0 = N.deltaSpeedCourse(prev, fix); if (d0 && d0.dt >= 0.8 && d0.sog >= 60) { setGps('warn', 'GPS jump ignored'); return; } }
    const stale = p.timestamp && Date.now() - p.timestamp > 10000 && !S.sim;
    const grade = stale ? 'stale' : (c.accuracy == null || c.accuracy <= 50) ? 'good' : c.accuracy <= 150 ? 'degraded' : 'poor';
    S.fixGrade = grade;
    if (grade === 'poor' || grade === 'stale') {
      S.lastKnown = fix; S.acc = c.accuracy;
      setGps('bad', (stale ? 'GPS stale' : 'GPS poor') + (c.accuracy ? ' ±' + (c.accuracy >= 1000 ? (c.accuracy / 1000).toFixed(1) + ' km' : Math.round(c.accuracy) + ' m') : ''));
      if (!S.pos) { S.pos = fix; if (!map.hasLayer(vessel)) { vessel.addTo(map); accCircle.addTo(map); } vessel.setLatLng([fix.lat, fix.lon]); vessel.setOpacity(0.4); accCircle.setLatLng([fix.lat, fix.lon]); accCircle.setRadius(c.accuracy || 0); }
      $('hudPos').textContent = N.fmtDM(fix.lat, fix.lon) + ' (poor fix)';
      return;
    }
    S.smoother.push(sog, cog);
    S.sog = S.smoother.sog; S.cog = S.smoother.cog;
    S.pos = fix; S.lastGood = fix; S.acc = c.accuracy; S.lastFixAt = Date.now();
    if (S.gpsLost) { S.gpsLost = false; $('alertBanner').classList.add('hidden'); alert('gpsback', 'info', 'GPS signal back.'); }
    S.fixes.push(fix); if (S.fixes.length > 50) S.fixes.shift();
    tripUpdate(fix, prev); checkAnchor(fix);
    const last = S.track[S.track.length - 1];
    if (!last || N.distanceNm({ lat: last[0], lon: last[1] }, fix) > 0.01) { S.track.push([+fix.lat.toFixed(5), +fix.lon.toFixed(5), fix.t]); if (S.track.length > 4000) S.track.splice(0, 500); track.addLatLng([fix.lat, fix.lon]); }
    setGps(c.accuracy <= 50 ? 'ok' : c.accuracy <= 150 ? 'warn' : 'bad', (S.sim ? 'SIM ' : 'GPS ') + (c.accuracy ? '±' + Math.round(c.accuracy) + ' m' : ''));
    processFix();
  }
  setInterval(() => {
    if (S.navigating && !S.sim && S.watchId !== null && S.lastFixAt && Date.now() - S.lastFixAt > 25000) { S.gpsLost = true; setGps('bad', 'GPS lost'); if (Date.now() - S.lastFixAt > 90000) alert('gpslost', 'danger', 'GPS signal lost. Check sky view.'); }
    if (S.track.length && !S.sim) saveJson(TRACK_KEY, S.track.slice(-3000));
    if (!S.sim) saveJson('saily.nav.v1', { navigating: S.navigating && S.started, startedAt: S.trip && S.trip.startedAt, wp: S.settings.wp, zone: S.zone, hazard: S.hazard, hazardNear: S.hazardNear, approached: S.approached, arrivedFinal: S.arrivedFinal, lastFix: S.pos ? { lat: S.pos.lat, lon: S.pos.lon, t: S.lastFixAt, acc: S.acc } : null, t: Date.now() });
    checkComplete();
  }, 5000);
  function checkComplete() {
    if (!S.navigating || S.sim || !S.arrivedFinal || !S.pos) { S.completeSince = 0; return; }
    const dest = DEST(); const near = N.distanceNm(S.pos, dest) < 0.3 && (S.sog === null || S.sog < 2);
    if (!near) { S.completeSince = 0; return; }
    if (!S.completeSince) S.completeSince = Date.now();
    if (Date.now() - S.completeSince > 120000 && $('completeBar').classList.contains('hidden') && !S.completeShown) {
      S.completeShown = true;
      const t = S.trip; const hrs = t ? (Date.now() - t.startedAt) / 3600000 : 0;
      $('completeBar').innerHTML = `<span><b>Passage complete.</b> ${t ? N.fmtNm(t.dist, 1) + ' nm in ' + N.fmtDur(hrs * 3600) + ', avg ' + (hrs > 0.02 ? (t.dist / hrs).toFixed(1) : '--') + ' kn, max ' + t.maxSog.toFixed(1) + ' kn, fuel about ' + Math.round(hrs * (P.vessel.burnLph || 75)) + ' L.' : ''}</span><button class="btn primary" id="btnStopNav">Stop</button><button class="btn" id="btnKeepGps">Keep GPS</button>${returnRoute() ? '<button class="btn" id="btnPlanReturn">Plan return</button>' : ''}`;
      $('completeBar').classList.remove('hidden');
      $('btnStopNav').addEventListener('click', () => { S.navigating = false; stopGps(); try { S.wakeLock && S.wakeLock.release(); } catch (e) { } localStorage.removeItem('saily.nav.v1'); $('completeBar').classList.add('hidden'); toast('Navigation stopped; track kept'); });
      $('btnKeepGps').addEventListener('click', () => $('completeBar').classList.add('hidden'));
      const pr = $('btnPlanReturn'); if (pr) pr.addEventListener('click', () => { const rr = returnRoute(); if (!rr) return; S.settings.routeId = rr.id; S.settings.wp = 1; const d = new Date(); d.setDate(d.getDate() + 1); S.settings.departure = fromLocal(TZ_ES, toLocalInput(TZ_ES, d).slice(0, 10) + 'T09:00').toISOString(); S.route = rr; S.zone = {}; S.approached = {}; S.arrivedFinal = false; S.trip = null; S.completeShown = false; saveSettings(); drawRoutes(); $('completeBar').classList.add('hidden'); showView('plan'); toast('Return route planned for tomorrow 09:00'); });
    }
  }

  // ---------- navigation processing ----------
  function speedForEta() { return (S.sog !== null && S.sog >= 3) ? { v: S.sog, plan: false } : { v: S.settings.speed, plan: true }; }
  function processFix() {
    const pos = S.pos; if (!pos) return;
    const wps = WPS();
    if (S.mob) { // man overboard: everything points at the MOB position
      const sol = N.solve(pos, [pos, { lat: S.mob.lat, lon: S.mob.lon, id: 'MOB', name: 'man overboard', note: '', radius: 0.02 }], 1);
      sol.remaining = sol.dist; S.solution = sol; updateHud(sol); updateMap(sol); return;
    }
    let sol = N.solve(pos, wps, S.settings.wp);
    const wpsNext = wps[Math.min(sol.k + 1, wps.length - 1)];
    const nextCourse = N.bearingDeg(sol.wp, wpsNext);
    const holdingOff = sol.passedPerp && !sol.inRadius && !(Math.abs(sol.xte) < Math.max(0.15, 2 * (sol.wp.radius || 0.1)) || (S.cog !== null && Math.abs(N.angleDiff(S.cog, nextCourse)) < 60));
    if (holdingOff && !S.holdToast) { S.holdToast = true; toast('Passed ' + sol.wp.id + ' abeam, holding this waypoint: close the track or tap Next WP', 6000); }
    const arrived = sol.inRadius || (!S.manualWp && sol.passedPerp && !holdingOff);
    if (S.navigating && arrived) {
      S.holdToast = false;
      if (sol.k >= wps.length - 1) {
        if (!S.arrivedFinal) { S.arrivedFinal = true; alert('arrived', 'info', `Arrived at ${sol.wp.name}. ${sol.wp.note}`); }
      } else {
        S.settings.wp = sol.k + 1; S.manualWp = false; saveSettings(); S.approached = {}; S.wpChangedAt = pos.t || Date.now();
        const nxt = N.solve(pos, wps, S.settings.wp);
        alert('wp' + sol.k, 'info', `Waypoint ${sol.wp.id} reached. New course ${N.fmtBrg(nxt.brg)}, ${N.fmtNm(nxt.dist)} miles to ${nxt.wp.id}. ${sol.wp.note}`);
        drawRoutes(); sol = nxt;
      }
    }
    S.solution = sol;
    updateHud(sol); updateMap(sol);
    if (S.navigating) { checkNavAlerts(sol); checkZones(pos, sol); checkHazards(pos); checkLandAhead(pos); checkHarbourSpeed(pos); checkWeatherNow(pos); checkSun(); aisTick(); }
  }
  function updateHud(sol) {
    $('hudWpId').textContent = sol.wp.id; $('hudWpName').textContent = sol.wp.name;
    $('hudBrg').textContent = N.fmtBrg(sol.brg);
    $('hudDist').innerHTML = N.fmtNm(sol.dist) + '<small> nm</small>';
    $('hudSog').innerHTML = (S.sog === null ? '--' : S.sog.toFixed(1)) + '<small> kn</small>';
    $('hudCog').textContent = N.fmtBrg(S.cog);
    const x = sol.xte, ax = Math.abs(x);
    const el = $('hudXte');
    if (ax < 0.02) { el.className = 'v steer'; el.textContent = 'on track'; }
    else { el.className = 'v steer ' + (x > 0 ? 'left' : 'right'); el.textContent = (x > 0 ? '◀ ' : '') + N.fmtNm(ax) + ' nm' + (x < 0 ? ' ▶' : ''); }
    // XTE highway: marker shows where the track is relative to us (track to the right when xte < 0)
    const hw = $('hwMarker'); const pct = 50 - Math.max(-1, Math.min(1, x / 0.5)) * 48; hw.style.left = pct + '%'; hw.classList.toggle('bad', ax > 0.3);
    const sp = speedForEta();
    const ttg = N.ttgSeconds(sol.dist, sp.v), ttgAll = N.ttgSeconds(sol.remaining, sp.v);
    const wps = WPS(); const nextBrg = sol.k < wps.length - 1 ? N.bearingDeg(sol.wp, wps[sol.k + 1]) : null;
    const mmss = s => s === null ? '--:--' : (s < 600 ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : N.fmtDur(s));
    $('hudTtg').innerHTML = mmss(ttg) + (sp.plan ? '*' : '') + (nextBrg !== null ? '<br><small>then ' + N.fmtBrg(nextBrg) + '</small>' : '<br><small>arrive</small>');
    renderPhase(sol);
    renderTrip();
    renderStrip(sol);
    renderTape(sol);
    if (ttgAll === null) $('hudEta').textContent = '--:--';
    else { const eta = new Date(Date.now() + ttgAll * 1000); $('hudEta').innerHTML = N.fmtTime(eta, TZ_ES) + (sp.plan ? '*' : '') + '<small> ' + TZL_FROM + '</small><br><small>' + fmtMA(eta) + ' ' + TZL_TO + '</small>'; }
    $('hudDtg').innerHTML = N.fmtNm(sol.remaining, 1) + '<small> nm</small><br><small>' + N.fmtDur(ttgAll) + (sp.plan ? '*' : '') + '</small>';
    $('hudPos').textContent = N.fmtDM(S.pos.lat, S.pos.lon);
    $('hudAcc').textContent = sp.plan ? '* at plan speed ' + S.settings.speed + ' kn' : '';
    $('hudSim').textContent = S.sim ? 'SIMULATION' : '';
    $('hudRoute').textContent = S.route.short || S.route.id;
    if (Date.now() - (S.wxDotAt || 0) > 30000) { S.wxDotAt = Date.now(); renderWxDot(); }
    const wxp = W.nearestPoint(S.wx, S.pos); const row = wxp ? W.rowAt(wxp, new Date()) : null;
    $('hudWx').textContent = row ? `wind ${Math.round(row.wind)}${row.gust ? '/' + Math.round(row.gust) : ''} kn ${N.compass16(row.windDir)} · sea ${row.wave != null ? row.wave.toFixed(1) + ' m' : '--'}${row.current != null ? ' · cur ' + row.current.toFixed(1) + ' kn ' + N.compass16(row.currentDir) : ''}` : '';
  }
  function renderPhase(sol) {
    const el = $('hudPhase');
    if (S.mob) { el.classList.remove('hidden'); if (!el.dataset.mob) { el.dataset.mob = '1'; el.innerHTML = `<span id="mobText"></span> <button class="btn danger" id="btnMobCancel" style="padding:6px 10px">Cancel MOB (hold)</button>`; holdButton($('btnMobCancel'), 1000, () => { if (confirm('Cancel man overboard mode?')) mobToggle(); }, 'Hold for a second to cancel MOB'); } $('mobText').innerHTML = `<b>MAN OVERBOARD</b> marked ${N.fmtTime(new Date(S.mob.t), TZ_ES)} · steer <b>${N.fmtBrg(N.bearingDeg(S.pos, S.mob))}</b> · ${N.fmtNm(N.distanceNm(S.pos, S.mob))} nm · ${N.fmtDM(S.mob.lat, S.mob.lon)}`; return; }
    if (el.dataset.mob) { el.dataset.mob = ''; el.innerHTML = ''; }
    const lanes = C.tss.lanes.filter(l => S.zone[l.id]); const zones = C.tss.zones.filter(z => S.zone[z.id]);
    if (lanes.length || zones.length) {
      // distance to clear all TSS polygons along the current leg: walk the leg from here
      let clear = null;
      if (S.cog !== null) { for (let d = 0.1; d <= 8; d += 0.1) { const q = N.destination(S.pos, sol.legBrg, d); const inside = [].concat(C.tss.lanes, C.tss.zones).some(z => N.pointInRings(q, z.rings)); if (!inside) { clear = d; break; } } }
      const flow = lanes.length ? laneFlowDeg(lanes[0]) : null;
      const target = flow === null ? sol.legBrg : crossingTarget(flow, sol.legBrg);
      const err = S.cog === null ? null : Math.round(N.angleDiff(S.cog, target));
      const from = flow === null ? null : dirWord(N.norm360(flow + 180));
      const side = flow === null ? null : trafficSide(flow, sol);
      // distance to leave THIS polygon and to clear the whole scheme, walking the leg course
      let thisLane = null;
      if (S.cog !== null) { const cur = lanes[0] || zones[0]; for (let d = 0.05; d <= 8; d += 0.05) { const q = N.destination(S.pos, sol.legBrg, d); if (!N.pointInRings(q, cur.rings)) { thisLane = d; break; } } }
      el.classList.remove('hidden');
      const ships = window.AIS && AIS.targets.size ? AIS.ranked().filter(x => x.c && x.c.range < 6 && Date.now() - x.t.t < 180000).slice(0, 2).map(x => `${x.t.name || x.t.mmsi} ${N.fmtNm(x.c.range)} nm ${N.compass16(x.c.brg)}${x.c.tcpa !== null && x.c.tcpa > 0 ? ', CPA ' + N.fmtNm(x.c.cpa) + ' in ' + Math.round(x.c.tcpa) + ' min' : ''}`).join(' · ') : '';
      el.innerHTML = (ships ? `<div style="margin-bottom:4px">🚢 ${ships}</div>` : '') + `<b>${lanes.length ? (lanes[0].flow === 'W' ? 'WESTBOUND LANE' : 'EASTBOUND LANE') : 'SEPARATION ZONE'}</b>${side ? ' · ships from your <b>' + side + '</b> (' + from + ')' : ''} · cross on <b>${N.fmtBrg(target)}</b>${err !== null ? ' (COG ' + (err > 0 ? '+' : '') + err + '°)' : ''}${thisLane !== null ? ' · this lane <b>' + N.fmtNm(thisLane) + ' nm</b>' : ''}${clear !== null ? ' · scheme clear <b>' + N.fmtNm(clear) + ' nm</b>' + (S.sog > 3 ? ' / ' + Math.round(clear / S.sog * 60) + ' min' : '') : ''}`;
      return;
    }
    const prec = C.tss.precautionary.filter(z => S.zone[z.id]);
    if (prec.length) { el.classList.remove('hidden'); el.innerHTML = `<b>PRECAUTIONARY AREA</b> · converging ships, keep a sharp lookout`; return; }
    if (sol.dist < 0.6 && sol.k >= WPS().length - 2) { el.classList.remove('hidden'); el.innerHTML = `<b>HARBOUR APPROACH</b> · ${sol.wp.note}`; return; }
    el.classList.add('hidden');
  }
  function renderTape(sol) {
    const svg = $('tapeSvg'); if (!svg) return;
    const cog = S.cog === null ? sol.brg : S.cog; const span = 120; // degrees visible
    const x = deg => 200 + N.angleDiff(deg, cog) / span * 400;
    let s = '';
    for (let d = Math.ceil((cog - span / 2) / 10) * 10; d <= cog + span / 2; d += 10) {
      const px = x(d); const major = ((d % 30) + 360) % 360 === 0;
      s += `<line x1="${px.toFixed(1)}" y1="${major ? 14 : 20}" x2="${px.toFixed(1)}" y2="30" stroke="#9db4cc" stroke-width="1"/>`;
      if (major) s += `<text x="${px.toFixed(1)}" y="11" font-size="9" fill="#9db4cc" text-anchor="middle">${String(N.norm360(d)).padStart(3, '0')}</text>`;
    }
    const mark = (deg, col, label) => { const px = x(deg); if (Math.abs(N.angleDiff(deg, cog)) > span / 2) return ''; return `<polygon points="${px.toFixed(1)},22 ${(px - 5).toFixed(1)},30 ${(px + 5).toFixed(1)},30" fill="${col}"/>`; };
    s += mark(sol.legBrg, '#ff2d95'); s += mark(sol.brg, '#ffe066');
    s += `<line x1="200" y1="0" x2="200" y2="30" stroke="#43b3ff" stroke-width="2"/>`;
    if (S.cog === null) s += `<text x="200" y="11" font-size="9" fill="#ff9f43" text-anchor="middle">no COG</text>`;
    svg.innerHTML = s;
  }
  function renderTrip() {
    const t = S.trip; const el = $('hudTrip'); if (!t) { el.textContent = ''; return; }
    const hrs = (Date.now() - t.startedAt) / 3600000;
    const avg = hrs > 0.02 ? t.dist / hrs : 0;
    el.textContent = `run ${N.fmtNm(t.dist, 1)} nm · ${N.fmtDur(hrs * 3600)} · avg ${avg.toFixed(1)} · max ${t.maxSog.toFixed(1)} kn · fuel ~${Math.round(hrs * (P.vessel.burnLph || 75))} L`;
  }
  function tripUpdate(fix, prev) {
    if (!S.trip || S.sim) return;
    if (prev) { const d = N.distanceNm(prev, fix); if (d < 0.5) S.trip.dist += d; }
    if (S.sog !== null && S.sog > S.trip.maxSog) S.trip.maxSog = S.sog;
    if (S.trip.n++ % 20 === 0) saveJson('saily.trip.v1', S.trip);
  }
  // ----- helm actions -----
  const mobLine = L.polyline([], { pane: 'route', color: '#ff4757', weight: 3, dashArray: '6 4', interactive: false });
  let mobMarker = null, mobTimer = null;
  function mobToggle() {
    if (S.mob) { // cancel
      S.mob = null; clearInterval(mobTimer); if (mobMarker) map.removeLayer(mobMarker); map.removeLayer(mobLine); $('btnMob').classList.remove('active'); $('btnMob').textContent = 'MOB';
      alert('mobend', 'info', 'Man overboard mode cancelled. Back to the route.'); if (S.pos) processFix(); return;
    }
    if (!S.pos) { toast('No position yet'); return; }
    ensureAudio();
    S.mob = { lat: S.pos.lat, lon: S.pos.lon, t: Date.now() };
    mobMarker = L.marker([S.mob.lat, S.mob.lon], { pane: 'vessel', icon: L.divIcon({ className: '', html: '<div class="mobmark">MOB</div>', iconSize: [0, 0] }) }).addTo(map);
    mobLine.addTo(map); $('btnMob').classList.add('active'); $('btnMob').textContent = 'MOB active';
    S.follow = true; $('btnFollow').classList.add('on');
    alert('mob', 'danger', `MAN OVERBOARD. Position marked at ${N.fmtDM(S.mob.lat, S.mob.lon)}. Turn back now.`);
    mobTimer = setInterval(() => { if (!S.mob || !S.pos) return; const b = N.bearingDeg(S.pos, S.mob), d = N.distanceNm(S.pos, S.mob); speak(`Man overboard bearing ${N.fmtBrg(b).replace('°', '')}, ${d < 0.1 ? Math.round(d * 1852) + ' metres' : N.fmtNm(d) + ' miles'}.`, 'warn', 'mobloop'); }, 20000);
    if (S.pos) processFix();
  }
  function markPosition() {
    if (!S.pos) { toast('No position yet'); return; }
    const m = { n: S.marks.length + 1, lat: S.pos.lat, lon: S.pos.lon, t: Date.now() }; S.marks.push(m);
    L.marker([m.lat, m.lon], { pane: 'aids', icon: L.divIcon({ className: '', html: '<div class="usermark" title="Mark ' + m.n + '"></div>', iconSize: [0, 0] }) }).bindPopup(`<b>Mark ${m.n}</b>${N.fmtDM(m.lat, m.lon)}<br>${N.fmtTime(new Date(m.t), TZ_ES)} ${TZL_FROM}`).addTo(map);
    alert('mark' + m.n, 'info', `Mark ${m.n} at ${N.fmtDM(m.lat, m.lon)}.`);
    saveJson('saily.marks.v1', S.marks);
  }
  function repeatLast() { ensureAudio(); const t = S.lastHeadline || S.lastAlertText; if (!t) { toast('Nothing to repeat'); return; } showBanner('info', S.lastAlertText || t, 15000); speak(S.lastAlertText || t, 'warn', 'repeat'); }
  function showBigPos() {
    if (!S.pos) { toast('No position yet'); return; }
    $('bigposText').textContent = N.fmtDM(S.pos.lat, S.pos.lon);
    $('bigposSub').textContent = `${S.pos.lat.toFixed(5)}, ${S.pos.lon.toFixed(5)} · ${N.fmtTime(new Date(), 'UTC')} UTC · COG ${N.fmtBrg(S.cog)} SOG ${S.sog === null ? '--' : S.sog.toFixed(1)} kn`;
    $('bigpos').classList.remove('hidden');
  }
  function sayPosition() {
    if (!S.pos) return; ensureAudio();
    const d = (v, pos, neg) => { const h = v >= 0 ? pos : neg; v = Math.abs(v); const deg = Math.floor(v), min = ((v - deg) * 60).toFixed(2); return `${deg} degrees ${min} minutes ${h}`; };
    speak(`Position ${d(S.pos.lat, 'north', 'south')}, ${d(S.pos.lon, 'east', 'west')}.`, 'warn');
  }
  /** hold-to-act: fn runs only after the pointer is held for ms; an early release explains */
  function holdButton(el, ms, fn, hint) {
    let timer = null, fired = false;
    el.classList.add('hold'); el.style.setProperty('--hold', ms + 'ms');
    const start = e => { e.preventDefault(); fired = false; el.classList.add('holding'); timer = setTimeout(() => { fired = true; el.classList.remove('holding'); fn(); }, ms); };
    const end = () => { clearTimeout(timer); el.classList.remove('holding'); if (!fired && el.dataset.armed !== 'no') toast(hint || 'Press and hold', 1500); fired = false; };
    el.addEventListener('pointerdown', start); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('pointerleave', end);
    el.addEventListener('click', e => e.preventDefault());
  }
  // anchor watch (sheet instead of prompt; alarm needs two consecutive fixes outside the circle)
  let anchorCircle = null, anchRadius = 45;
  function anchorToggle() {
    if (S.settings.anchor) { S.settings.anchor = null; saveSettings(); if (anchorCircle) { map.removeLayer(anchorCircle); anchorCircle = null; } $('btnAnchor').classList.remove('active'); toast('Anchor watch off'); return; }
    if (!S.pos) { toast('No position yet'); return; }
    $('anchRadius').textContent = anchRadius + ' m'; $('anchorSheet').classList.remove('hidden');
  }
  $('anchMinus').addEventListener('click', () => { anchRadius = Math.max(20, anchRadius - 5); $('anchRadius').textContent = anchRadius + ' m'; });
  $('anchPlus').addEventListener('click', () => { anchRadius = Math.min(150, anchRadius + 5); $('anchRadius').textContent = anchRadius + ' m'; });
  $('anchClose').addEventListener('click', () => $('anchorSheet').classList.add('hidden'));
  $('anchSet').addEventListener('click', () => {
    $('anchorSheet').classList.add('hidden'); if (!S.pos) return;
    ensureAudio(); if (S.watchId === null && !S.sim) startGps();
    S.settings.anchor = { lat: S.pos.lat, lon: S.pos.lon, r: anchRadius, t: Date.now(), acc: S.acc || 0 }; saveSettings(); drawAnchor();
    alert('anchorset', 'info', `Anchor watch set, ${anchRadius} metres${S.acc ? ', GPS plus or minus ' + Math.round(S.acc) + ' metres' : ''}.`);
  });
  function drawAnchor() {
    const an = S.settings.anchor; if (!an) return;
    if (anchorCircle) map.removeLayer(anchorCircle);
    anchorCircle = L.circle([an.lat, an.lon], { pane: 'haz', radius: an.r, color: '#f5b400', weight: 2, dashArray: '4 4', fillOpacity: 0.08 }).addTo(map);
    $('btnAnchor').classList.add('active');
  }
  function checkAnchor(pos) {
    const an = S.settings.anchor; if (!an) return;
    const d = N.distanceNm(pos, an) * 1852;
    const out = d - (pos.acc || 0) > an.r;
    if (out && S.anchorOutPrev) alert('anchordrag', 'danger', `Anchor dragging: ${Math.round(d)} metres from the anchor position, limit ${an.r}.`, { cooldown: 30 });
    S.anchorOutPrev = out;
  }
  if (S.settings.anchor) drawAnchor();
  $('btnAnchor').addEventListener('click', anchorToggle);
  holdButton($('btnMob'), 700, () => { if (S.mob) { toast('Use Cancel MOB in the panel'); return; } mobToggle(); }, 'Hold the MOB button for a second to mark man overboard');
  $('btnMark').addEventListener('click', markPosition);
  $('btnRepeat').addEventListener('click', repeatLast);
  $('hudPos').addEventListener('click', showBigPos);
  $('btnClosePos').addEventListener('click', () => $('bigpos').classList.add('hidden'));
  $('btnSayPos').addEventListener('click', sayPosition);
  $('btnSharePos').addEventListener('click', async () => {
    if (!S.pos) return;
    const sol = S.solution; const sp = speedForEta(); const ttgAll = sol ? N.ttgSeconds(sol.remaining, sp.v) : null;
    const txt = `${P.vessel.name || 'Saily'}: ${N.fmtDM(S.pos.lat, S.pos.lon)} at ${N.fmtTime(new Date(), 'UTC')} UTC, COG ${N.fmtBrg(S.cog)} SOG ${S.sog === null ? '--' : S.sog.toFixed(1)} kn${ttgAll ? ', ETA ' + (P.destinationShort || '') + ' ' + bothTimes(new Date(Date.now() + ttgAll * 1000)) : ''}. https://maps.google.com/?q=${S.pos.lat.toFixed(5)},${S.pos.lon.toFixed(5)}`;
    try { if (navigator.share) await navigator.share({ text: txt }); else { await navigator.clipboard.writeText(txt); toast('Copied to clipboard'); } } catch (e) { try { await navigator.clipboard.writeText(txt); toast('Copied to clipboard'); } catch (e2) { toast('Could not share'); } }
  });

  // ----- live forecast overlay: wind and current arrows at the weather points for the current hour -----
  const wxGroup = L.layerGroup().addTo(map);
  function renderWxOverlay() {
    wxGroup.clearLayers();
    if (!S.wx) return;
    const now = new Date();
    for (const p of W.POINTS) {
      const pt = S.wx.points[p.id]; if (!pt) continue;
      const r = W.rowAt(pt, now); if (!r) continue;
      if (r.wind != null && r.windDir != null) wxGroup.addLayer(L.marker([p.lat, p.lon], { pane: 'aids', interactive: false, icon: L.divIcon({ className: '', html: `<div class="wxarrow"><span style="display:inline-block;transform:rotate(${r.windDir + 90}deg)">➤</span><small> ${Math.round(r.wind)}${r.gust ? '/' + Math.round(r.gust) : ''} kn</small></div>`, iconAnchor: [8, 8] }) }));
      if (r.current != null && r.currentDir != null && r.current >= 0.3) wxGroup.addLayer(L.marker([p.lat - 0.012, p.lon], { pane: 'aids', interactive: false, icon: L.divIcon({ className: '', html: `<div class="wxarrow cur"><span style="display:inline-block;transform:rotate(${r.currentDir - 90}deg)">➤</span><small> ${r.current.toFixed(1)} kn</small></div>`, iconAnchor: [8, 8] }) }));
    }
  }
  setInterval(renderWxOverlay, 10 * 60000);
  function renderSeaLine() {
    const el = $('hudSea'); if (!el) return;
    const parts = [];
    const pt = S.wx && (W.nearestPoint(S.wx, S.pos || WPS()[0]));
    if (pt) { const rows = pt.rows.filter(r => r.seaLevel != null); const nowIso = W.madridLocalIso(new Date()); const i = rows.findIndex(r => r.time >= nowIso.slice(0, 13)); if (i > 0 && i < rows.length) { const rising = rows[i].seaLevel > rows[i - 1].seaLevel; let j = i; while (j < rows.length - 1 && ((rows[j + 1].seaLevel > rows[j].seaLevel) === rising)) j++; parts.push(`tide ${rising ? 'rising' : 'falling'}, ${rising ? 'HW' : 'LW'} ${rows[j].time.slice(11)}`); } }
    const st = N.sunTimes(new Date(), P.sun.lat, P.sun.lon);
    if (st.sunset) { const left = (st.sunset - Date.now()) / 60000; parts.push(left > 0 ? `daylight ${N.fmtDur(left * 60)} (sunset ${N.fmtTime(st.sunset, TZ_ES)})` : 'after sunset'); }
    el.textContent = parts.join(' · ');
  }
  setInterval(renderSeaLine, 60000);
  // ----- passage progress strip: legs as segments, lane crossing highlighted, vessel and waypoints -----
  function renderStrip(sol) {
    const svg = $('stripSvg'); if (!svg) return;
    const wps = WPS(); const total = S.route.total || N.routeTotal(wps); if (!total) return;
    let x = 0; const segs = [];
    for (let i = 0; i < wps.length - 1; i++) { const d = N.distanceNm(wps[i], wps[i + 1]); const mid = N.destination(wps[i], N.bearingDeg(wps[i], wps[i + 1]), d / 2); const lane = [].concat(C.tss.lanes, C.tss.zones).some(z => N.pointInRings(mid, z.rings)); segs.push({ x0: x / total * 400, x1: (x + d) / total * 400, lane }); x += d; }
    let done = 0; for (let i = 0; i < sol.k - 1; i++) done += N.distanceNm(wps[i], wps[i + 1]);
    done += Math.max(0, Math.min(sol.legDist, sol.along)); const vx = Math.max(0, Math.min(400, done / total * 400));
    let s = segs.map(g => `<rect x="${g.x0.toFixed(1)}" y="8" width="${(g.x1 - g.x0).toFixed(1)}" height="6" fill="${g.lane ? '#c2249f' : '#2b5f8f'}"/>`).join('');
    s += `<rect x="0" y="8" width="${vx.toFixed(1)}" height="6" fill="#43b3ff" opacity=".85"/>`;
    let cx = 0; for (let i = 0; i < wps.length; i++) { s += `<rect x="${(cx / total * 400 - 1).toFixed(1)}" y="5" width="2" height="12" fill="#eaf2fb"/>`; if (i < wps.length - 1) cx += N.distanceNm(wps[i], wps[i + 1]); }
    s += `<polygon points="${vx.toFixed(1)},2 ${(vx - 5).toFixed(1)},20 ${(vx + 5).toFixed(1)},20" fill="#ffe066" stroke="#000" stroke-width=".5"/>`;
    svg.innerHTML = s;
  }

  // ----- AIS targets (optional, aisstream.io key) -----
  const aisGroup = L.layerGroup().addTo(map); const aisMarkers = new Map();
  function aisIcon(t, risk) {
    const col = risk === 2 ? '#ff2b2b' : risk === 1 ? '#ff9f1a' : '#666';
    const rot = t.hdg != null ? t.hdg : (t.cog != null ? t.cog : 0);
    return L.divIcon({ className: '', iconSize: [0, 0], html: `<div style="width:22px;height:22px;margin:-11px 0 0 -11px;transform:rotate(${rot}deg)"><svg viewBox="0 0 22 22" width="22" height="22"><path d="M11 2 L18 19 L11 15 L4 19 Z" fill="${col}" stroke="#fff" stroke-width="1.2"/></svg></div>` });
  }
  function aisRisk(c) { if (!c || c.tcpa === null) return 0; if (c.tcpa > 0 && c.tcpa < 12 && c.cpa < 0.5) return 2; if (c.tcpa > 0 && c.tcpa < 20 && c.cpa < 1) return 1; return 0; }
  function aisDraw(t) {
    if (!window.AIS || t.lat == null) return;
    const c = AIS.cpa(AIS.own, t), risk = aisRisk(c);
    let m = aisMarkers.get(t.mmsi);
    // Names arrive from a public feed: escape them before they reach innerHTML.
    const label = `${esc(t.name || t.mmsi)}${t.sog != null ? ' ' + t.sog.toFixed(0) + ' kn' : ''}`;
    const popup = `<b>${esc(t.name || 'MMSI ' + t.mmsi)}</b>${AIS.typeName(t.type) || 'ship'} · COG ${N.fmtBrg(t.cog)} · ${t.sog != null ? t.sog.toFixed(1) : '--'} kn${c ? '<br>range ' + N.fmtNm(c.range) + ' nm, bearing ' + N.fmtBrg(c.brg) + (c.tcpa !== null && c.tcpa > 0 ? '<br>CPA ' + N.fmtNm(c.cpa) + ' nm in ' + Math.round(c.tcpa) + ' min' : '<br>opening') : ''}<br>${Math.round((Date.now() - t.t) / 1000)} s ago`;
    if (!m) { m = L.marker([t.lat, t.lon], { pane: 'vessel', icon: aisIcon(t, risk) }).bindPopup(popup).bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'aislabel' }); aisGroup.addLayer(m); aisMarkers.set(t.mmsi, m); }
    else { m.setLatLng([t.lat, t.lon]); m.setIcon(aisIcon(t, risk)); m.getPopup().setContent(popup); m.setTooltipContent(label); }
    m.setOpacity(Date.now() - t.t > 120000 ? 0.35 : 1); // no report for 2 min: fade, the position is a guess
  }
  function aisTick() {
    if (!window.AIS) return;
    AIS.own = S.pos ? { lat: S.pos.lat, lon: S.pos.lon, cog: S.cog, sog: S.sog } : null;
    AIS.prune();
    for (const [mmsi, m] of aisMarkers) if (!AIS.targets.has(mmsi)) { aisGroup.removeLayer(m); aisMarkers.delete(mmsi); }
    if (Date.now() - (S.aisDrawAt || 0) > 5000) { S.aisDrawAt = Date.now(); for (const t of AIS.targets.values()) aisDraw(t); renderAisChip(); }
  }
  function renderAisChip() {
    const el = $('hudAis'); if (!el) return;
    if (!window.AIS || !AIS.targets.size || !AIS.own) { el.textContent = ''; return; }
    const fresh = AIS.ranked().filter(x => x.c && Date.now() - x.t.t < 180000);
    const near = fresh[0];
    el.textContent = fresh.length ? `🚢 ${fresh.length} ship${fresh.length > 1 ? 's' : ''}` + (near ? `, nearest ${N.fmtNm(near.c.range)} nm ${N.compass16(near.c.brg)}` : '') : '';
  }
  function aisAlarm(t, c) {
    const rel = S.cog === null ? '' : (() => { const d = N.angleDiff(c.brg, S.cog); return Math.abs(d) < 30 ? 'ahead' : Math.abs(d) > 150 ? 'astern' : d > 0 ? 'on your RIGHT' : 'on your LEFT'; })();
    alert('ais-' + t.mmsi, 'danger', `Ship ${t.name || ''} ${rel}, ${N.fmtNm(c.range)} miles, bearing ${N.fmtBrg(c.brg)}, closest approach ${N.fmtNm(c.cpa)} miles in ${Math.round(c.tcpa)} minutes. Watch it.`);
  }
  function aisApply() {
    if (!window.AIS) return;
    AIS.onUpdate = aisDraw; AIS.onAlarm = aisAlarm;
    AIS.onStatus = () => { const el = $('aisStatus'); if (el) el.innerHTML = aisStatusText(); };
    const key = (S.settings.aisKey || '').trim();
    if (S.settings.aisOn && key && !S.sim) AIS.connect(key, P.bbox); else AIS.disconnect();
  }
  /** Why there are no ships on the screen, in one line. Silence here is what makes a bad key look like a bad app. */
  function aisStatusText() {
    if (!window.AIS) return 'module missing';
    const key = (S.settings.aisKey || '').trim();
    if (!S.settings.aisOn) return key ? 'off: switch on "Show live ships" above' : 'off: paste an aisstream.io key to switch on';
    if (!key) return 'no key yet: paste your aisstream.io key above';
    if (S.sim) return 'paused while the demo simulation is running (the demo shows its own ships)';
    const n = AIS.targets.size;
    const bits = [AIS.status];
    if (n) bits.push(`${n} ship${n > 1 ? 's' : ''} in the area`);
    if (AIS.frames) bits.push(`${AIS.frames} messages`);
    if (AIS.lastMsgAt) bits.push(`last ${Math.round((Date.now() - AIS.lastMsgAt) / 1000)} s ago`);
    const detail = AIS.detail ? `<br><span class="muted">${esc(AIS.detail)}</span>` : '';
    return esc(bits.join(', ')) + detail;
  }
  // synthetic ships for the demo: exercise the CPA alarms without a key
  let simShips = null;
  function simShipsTick(dt) {
    if (!window.AIS) return;
    if (!simShips) simShips = [
      { mmsi: 900001, name: 'DEMO CARGO WEST', lat: 35.955, lon: -5.45, cog: 268, sog: 14, type: 70 },
      { mmsi: 900002, name: 'DEMO TANKER EAST', lat: 35.905, lon: -5.85, cog: 88, sog: 12, type: 80 },
      { mmsi: 900003, name: 'DEMO FERRY', lat: 36.005, lon: -5.60, cog: 205, sog: 30, type: 60 },
    ];
    for (const s of simShips) { const q = N.destination(s, s.cog, s.sog * dt / 3600 * 20); s.lat = q.lat; s.lon = q.lon; AIS.ingest({ MessageType: 'PositionReport', MetaData: { MMSI: s.mmsi, ShipName: s.name, latitude: s.lat, longitude: s.lon }, Message: { PositionReport: { Latitude: s.lat, Longitude: s.lon, Cog: s.cog, Sog: s.sog, TrueHeading: s.cog } } }); if (s.type && !AIS.targets.get(s.mmsi).type) AIS.targets.get(s.mmsi).type = s.type; }
  }

  function updateMap(sol) {
    const p = [S.pos.lat, S.pos.lon];
    if (!map.hasLayer(vessel)) { vessel.addTo(map); accCircle.addTo(map); }
    vessel.setOpacity(1);
    vessel.setLatLng(p); accCircle.setLatLng(p); accCircle.setRadius(S.acc || 0);
    const rot = document.getElementById('vesselRot'); if (rot) rot.style.transform = `rotate(${S.cog === null ? 0 : S.cog}deg)`;
    brgLine.setLatLngs([p, [sol.wp.lat, sol.wp.lon]]);
    if (S.cog !== null && S.sog !== null && S.sog > 1) { const d = N.destination(S.pos, S.cog, S.sog / 6); predLine.setLatLngs([p, [d.lat, d.lon]]); } else predLine.setLatLngs([]);
    if (S.follow) {
      // auto-range by what comes next (unless the user zoomed within the last 90 s), then look ahead along COG
      if (S.settings.autoZoom !== false && Date.now() - S.userZoomAt > 90000 && S.navigating) {
        const inLane = Object.keys(S.zone).some(k => S.zone[k] && /^(west|east)_/.test(k));
        const d = S.mob ? 0.5 : sol.dist;
        const want = d > 8 ? 11 : d > 3 ? 12 : d > 1 ? 13 : d > 0.35 ? 14 : 15;
        const z = inLane ? Math.min(want, 12) : want;
        if (z !== map.getZoom()) progZoom(() => map.setZoom(z, { animate: false }));
      }
      let centre = p;
      if (S.cog !== null && S.sog !== null && S.sog > 2) {
        const size = map.getSize(); const k = Math.min(size.x, size.y) * 0.18;
        const vp = map.latLngToContainerPoint(p);
        const ahead = L.point(vp.x + Math.sin(N.toRad(S.cog)) * k, vp.y - Math.cos(N.toRad(S.cog)) * k);
        centre = map.containerPointToLatLng(ahead);
      }
      map.panTo(centre, { animate: false });
    }
    if (S.mob) mobLine.setLatLngs([p, [S.mob.lat, S.mob.lon]]);
  }
  function checkNavAlerts(sol) {
    const ax = Math.abs(sol.xte);
    if (ax > 0.3 && sol.legDist > 0.5 && sol.dist > 0.3) {
      const away = S.cog !== null && Math.abs(N.angleDiff(S.cog, sol.legBrg)) > 90;
      const turn = S.cog !== null ? N.angleDiff(sol.brg, S.cog) : null; // + = bearing is clockwise of our heading = turn right
      const dir = turn === null ? (sol.xte > 0 ? 'left' : 'right') : (Math.abs(turn) < 3 ? '' : (turn > 0 ? 'right' : 'left'));
      alert('xte', 'warn', away ? `Off track ${N.fmtNm(ax)} miles and heading away from the route. Come round to ${N.fmtBrg(sol.brg)}.` : `Off track ${N.fmtNm(ax)} miles. ${dir ? 'Steer ' + dir + ' to ' : 'Hold '}${N.fmtBrg(sol.brg)}.`, { value: Math.round(ax * 10) / 10 });
    }
    if (sol.legDist >= 0.6 && sol.dist < Math.max(0.5, sol.wp.radius * 3) && !S.approached[sol.k] && sol.k < WPS().length - 1) {
      S.approached[sol.k] = true;
      const nb = N.bearingDeg(sol.wp, WPS()[sol.k + 1]);
      alert('appr' + sol.k, 'info', `Waypoint ${sol.wp.id} in ${N.fmtNm(sol.dist)} miles. Next course ${N.fmtBrg(nb)}.`);
    }
    // in-lane heading check
    for (const l of C.tss.lanes) {
      if (S.zone[l.id] && S.cog !== null && S.sog !== null && S.sog > 3) {
        const target = crossingTarget(laneFlowDeg(l), sol.legBrg);
        const dev = Math.abs(N.angleDiff(S.cog, target));
        if (dev > 35) alert('lanehdg', 'warn', `Cross the lane at right angles: steer ${N.fmtBrg(target)}. You are ${Math.round(dev)} degrees off.`, { cooldown: 60 });
      }
    }
  }
  const DIRWORD = { N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east', E: 'east', ESE: 'east-south-east', SE: 'south-east', SSE: 'south-south-east', S: 'south', SSW: 'south-south-west', SW: 'south-west', WSW: 'west-south-west', W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west' };
  const dirWord = deg => DIRWORD[N.compass16(deg)] || N.compass16(deg);
  function laneFlowDeg(l) { return l.flowDeg != null ? l.flowDeg : (l.flow === 'W' ? 270 : 90); }
  function crossingTarget(flow, legBrg) { const a = N.norm360(flow + 90), b = N.norm360(flow - 90); return Math.abs(N.angleDiff(a, legBrg)) < Math.abs(N.angleDiff(b, legBrg)) ? a : b; }
  function trafficSide(flow, sol) { // which side ships come from, relative to our reference heading
    const ref = (S.cog !== null && sol && Math.abs(sol.xte) > 0.1) ? S.cog : (sol ? sol.legBrg : S.cog);
    if (ref === null) return null;
    return N.angleDiff(N.norm360(flow + 180), ref) > 0 ? 'RIGHT' : 'LEFT';
  }
  function checkZones(pos, sol) {
    const all = [].concat(C.tss.itz, C.tss.free, C.tss.precautionary, C.tss.zones, C.tss.lanes);
    for (const z of all) {
      const inside = N.pointInRings(pos, z.rings);
      const was = !!S.zone[z.id];
      if (inside !== was) {
        // debounce: a transition needs the same result on two consecutive accepted fixes (no polygon buffer, by design)
        S.zonePending = S.zonePending || {};
        if (S.zonePending[z.id] !== inside) { S.zonePending[z.id] = inside; continue; }
        S.zonePending[z.id] = undefined;
        S.zone[z.id] = inside;
        // Wording comes from the passage's own TSS data (level/enter/leave), so any passage gets zone alerts.
        if (inside && z.flow) { // traffic lane: side of traffic from the flow bearing and our leg course (COG only when off track)
          const flow = laneFlowDeg(z), fromName = dirWord(N.norm360(flow + 180));
          const side = trafficSide(flow, sol) || 'LEFT';
          alert('zone-' + z.id, 'danger', `Entering the ${z.flow === 'W' ? 'WESTBOUND' : 'EASTBOUND'} traffic lane. Ships come from your ${side}, from the ${fromName}. Cross on ${N.fmtBrg(crossingTarget(flow, sol.legBrg))}, do not slow down.`, { cooldown: 30 });
        }
        else if (inside && z.enter) alert('zone-' + z.id, z.level || 'warn', z.enter, { cooldown: 30 });
        else if (!inside && z.leave) alert('zoneout-' + z.id, 'info', z.leave, { cooldown: 30 });
      }
    }
  }
  function checkHazards(pos) {
    S.hazardNear = S.hazardNear || {};
    for (const h of (S.dangers || P.hazards)) {
      const d = N.distanceNm(pos, h);
      const inside = d < h.radius;
      const was = !!S.hazard[h.id];
      if (inside && !was) { S.hazPending = S.hazPending || {}; if (!S.hazPending[h.id]) { S.hazPending[h.id] = true; continue; } S.hazPending[h.id] = false; }
      if (inside && !was) { const planned = h.level !== 'danger' && S.plannedHaz && S.plannedHaz.has(h.id); alert('haz-' + h.id, h.level === 'danger' ? 'danger' : planned ? 'info' : h.level === 'caution' ? 'warn' : 'info', `${h.level === 'danger' ? 'DANGER' : planned ? 'Planned' : 'Caution'}: ${h.name}. ${planned ? 'As briefed.' : h.note}`, { cooldown: 120 }); }
      else if (!inside && h.level === 'danger' && d < h.radius + 0.15 && !S.hazardNear[h.id]) {
        S.hazardNear[h.id] = true;
        alert('hazn-' + h.id, 'warn', `${h.name}: ${N.fmtNm(d)} miles to the ${N.compass16(N.bearingDeg(pos, h))}.`, { cooldown: 120 });
      }
      if (d > h.radius + 0.4) S.hazardNear[h.id] = false;
      S.hazard[h.id] = inside;
    }
  }
  function landAt(q) { return C.land.some(r => N.pointInRing(q, r)); }
  const HARBOUR_WPS = new Set(P.harbourWaypoints || ['SOTO', 'SOTO-HEAD', 'MAR-APP', 'TANJA', 'TANG-F', 'TANG-E']);
  function checkLandAhead(pos) {
    // Guard against steering into the coast. Bounded by the route: when on track the leg ahead was verified for land
    // clearance by the builder, so only look as far as the active waypoint; on harbour legs the danger circles are the guard.
    if (S.cog === null || S.sog === null || S.sog < 1.5) return;
    const sol = S.solution;
    const onTrack = sol && Math.abs(sol.xte) < 0.1 && Math.abs(N.angleDiff(S.cog, sol.legBrg)) < 25;
    const harbourLeg = sol && (HARBOUR_WPS.has(sol.wp.id) || HARBOUR_WPS.has(sol.prev.id));
    if (onTrack && harbourLeg && Math.abs(sol.xte) < 0.05) return;
    // turning onto a new leg: the smoothed COG still points down the old leg for a few fixes, and the old course often
    // runs at the coast (that is why there is a waypoint). Wait up to 30 s for the COG to come round.
    const turning = sol && S.wpChangedAt && (pos.t || Date.now()) - S.wpChangedAt < 30000 && Math.abs(N.angleDiff(S.cog, sol.legBrg)) >= 25;
    if (turning) { S.landAheadPrev = undefined; S.landAheadHits = 0; return; }
    const nearHarbour = Object.values(P.places).some(pl => N.distanceNm(pos, pl) < 0.2);
    let look = nearHarbour || S.sog < 4 ? 0.08 : Math.min(1.5, Math.max(0.2, S.sog * 4 / 60)); // 4 minutes ahead at sea, 150 m in harbour
    if (onTrack) look = Math.min(look, sol.dist + 0.05);
    // closing only, confirmed by two consecutive fixes: ignore land that is not getting nearer and a single fix whose
    // course sweeps over the coast mid-turn
    for (let d = 0.04; d <= look; d += 0.04) {
      const q = N.destination(pos, S.cog, d);
      if (landAt(q)) {
        const prev = S.landAheadPrev; S.landAheadPrev = d; S.landAheadHits = (S.landAheadHits || 0) + 1;
        if (S.landAheadHits < 2) return; // first sighting: confirm on the next fix
        if (prev !== undefined && d >= prev - 0.001) return; // not closing
        alert('landahead', 'danger', `Land or rocks ahead, ${d < 0.1 ? Math.round(d * 1852) + ' metres' : N.fmtNm(d) + ' miles'} on this heading. Alter course.`, { cooldown: 30 }); return;
      }
    }
    S.landAheadPrev = undefined; S.landAheadHits = 0;
  }
  function checkHarbourSpeed(pos) {
    if (S.sog === null || S.sog < (P.harbourSpeedKn || 4)) return;
    for (const pl of Object.values(P.places)) if (N.distanceNm(pos, pl) < 0.3) alert('harbspeed', 'warn', `Slow down: harbour speed limit near ${pl.name}.`, { cooldown: 60 });
  }
  function checkWeatherNow(pos) {
    if (!S.wx || Date.now() - S.lastWxAlert < 15 * 60000) return;
    const pt = W.nearestPoint(S.wx, pos); if (!pt) return;
    const row = W.rowAt(pt, new Date()); if (!row) return;
    const v = W.classify(row, S.settings.th);
    if (v.level !== 'ok') { S.lastWxAlert = Date.now(); alert('wxnow', v.level === 'nogo' ? 'danger' : 'warn', `Weather ${v.level === 'nogo' ? 'danger' : 'caution'} near ${pt.name}: ${v.reasons.join(', ')}.`, { value: v.level }); }
  }
  function checkSun() {
    const now = new Date(); const st = N.sunTimes(now, P.sun.lat, P.sun.lon);
    if (!st.sunset) return;
    const dt = (st.sunset - now) / 60000;
    if (dt > 0 && dt < 60 && !S.sunsetWarned) { S.sunsetWarned = true; alert('sunset', 'warn', `Sunset in ${Math.round(dt)} minutes (${bothTimes(st.sunset)}). Navigation lights on, prepare for night entry.`); }
    if (dt < 0 && dt > -600 && !S.nightNoted) { S.nightNoted = true; alert('night', 'info', 'After sunset: navigation lights on. Use the aids list for light characteristics.'); }
  }

  // ---------- simulation ----------
  function startSim(fromWp) {
    stopSim();
    S.simGpsWasOn = S.watchId !== null; stopGps(); S.gpsLost = false; if (window.AIS) AIS.disconnect();
    S.simSavedWp = S.settings.wp; S.simSavedTrack = S.track.slice();
    S.track = []; track.setLatLngs([]); S.zone = {}; S.hazard = {}; S.hazardNear = {}; S.approached = {}; S.arrivedFinal = false;
    const wps = WPS();
    S.settings.wp = Math.max(1, Math.min(fromWp || 1, wps.length - 1)); saveSettings(); drawRoutes();
    let cur = { lat: wps[S.settings.wp - 1].lat, lon: wps[S.settings.wp - 1].lon };
    let t = Date.now(); let phase = 0; let simClock = Date.now();
    S.sim = setInterval(() => {
      const now = Date.now(); const dt = (now - t) / 1000; t = now; phase += dt; simClock += dt * 20000; // simulated time runs 20x
      const sol = N.solve(cur, wps, S.settings.wp);
      const spd = S.settings.speed * (0.92 + 0.08 * Math.sin(phase / 7));
      const hdg = sol.brg + 6 * Math.sin(phase / 25); // weave to exercise XTE
      cur = N.destination(cur, hdg, spd * dt / 3600 * 20); // 20x real time
      onFix({ coords: { latitude: cur.lat + (Math.random() - .5) * 2e-5, longitude: cur.lon + (Math.random() - .5) * 2e-5, accuracy: 8, speed: spd / MS_TO_KN, heading: N.norm360(hdg) }, timestamp: simClock });
      if (S.settings.aisDemo !== false) simShipsTick(dt);
      if (S.arrivedFinal) stopSim();
    }, 1000);
    $('hudSim').textContent = 'SIMULATION';
  }
  function stopSim() {
    if (S.sim) { clearInterval(S.sim); S.sim = null; }
    if (S.simGpsWasOn) { S.simGpsWasOn = false; S.lastFixAt = Date.now(); startGps(); } else setGps('', 'GPS off');
    simShips = null; if (window.AIS) { for (const k of [900001, 900002, 900003]) AIS.targets.delete(k); } aisTick(); aisApply();
    if (S.simSavedWp !== undefined) { // restore the real passage state the demo replaced
      S.settings.wp = S.simSavedWp; S.track = S.simSavedTrack || []; S.simSavedWp = undefined; S.simSavedTrack = undefined;
      track.setLatLngs(S.track.map(p => [p[0], p[1]])); saveSettings(); saveJson(TRACK_KEY, S.track);
      S.zone = {}; S.hazard = {}; S.hazardNear = {}; S.approached = {}; S.arrivedFinal = false; S.manualWp = false; drawRoutes(); updateHudIdle();
    }
    $('hudSim').textContent = '';
  }

  // ---------- start ----------
  function begin(mode) {
    ensureAudio(); S.started = true; requestWakeLock();
    $('startOverlay').classList.add('hidden');
    S.arrivedFinal = false;
    if (mode === 'nav') { S.navigating = true; if (Math.abs(Date.now() - new Date(S.settings.departure).getTime()) > 30 * 60000) { S.settings.departure = new Date().toISOString(); saveSettings(); } if (!S.trip) { S.trip = loadJson('saily.trip.v1', null); if (!S.trip || Date.now() - S.trip.startedAt > 12 * 3600000) S.trip = { startedAt: Date.now(), dist: 0, maxSog: 0, n: 0 }; } startGps(); speak('Navigation started. Route ' + (S.route.short || S.route.id) + '.', 'info'); }
    else if (mode === 'sim') { S.navigating = true; startSim(S.settings.wp); }
    else { S.navigating = false; startGps(); }
    renderMore();
  }
  $('btnStart').addEventListener('click', () => begin('nav'));
  $('btnPlanOnly').addEventListener('click', () => begin('look'));
  $('btnStartSim').addEventListener('click', () => begin('sim'));
  function setWp(k, why) {
    const before = S.settings.wp; S.settings.wp = Math.max(1, Math.min(WPS().length - 1, k)); S.manualWp = true; S.approached = {}; S.arrivedFinal = false; S.wpChangedAt = (S.pos && S.pos.t) || Date.now(); saveSettings(); drawRoutes(); if (S.pos) processFix();
    toast((why || 'Active waypoint') + ': ' + WPS()[S.settings.wp].id, 6000, { label: 'Undo', fn: () => { S.settings.wp = before; S.manualWp = true; saveSettings(); drawRoutes(); if (S.pos) processFix(); } });
  }
  holdButton($('btnPrevWp'), 500, () => setWp(S.settings.wp - 1, 'Back to'), 'Hold to go back a waypoint');
  holdButton($('btnNextWp'), 500, () => setWp(S.settings.wp + 1, 'Skipped to'), 'Hold to skip to the next waypoint');
  $('btnMute').addEventListener('click', () => { S.muted = !S.muted; $('btnMute').textContent = S.muted ? '🔇' : '🔊'; if (S.muted) try { speechSynthesis.cancel(); } catch (e) { } });
  $('startInfo').textContent = `${S.route.total} nm · about ${N.fmtDur(S.route.total / S.settings.speed * 3600)} at ${S.settings.speed} kn · planned departure ${bothTimes(new Date(S.settings.departure))}`;

  // ---------- weather ----------
  /** verdict for the passage as it stands: rest of the route from here while navigating, planned departure otherwise */
  function wxVerdictNow() {
    if (!S.wx) return null;
    const live = !!(S.navigating && S.solution && S.solution.remaining != null);
    const doneNm = live ? Math.max(0, S.route.total - S.solution.remaining) : 0;
    const pass = live ? W.remainingPassage(S.wx, S.route.waypoints, doneNm, new Date(), S.sog, S.settings.speed, S.settings.th)
      : W.passage(S.wx, new Date(S.settings.departure), S.settings.speed, S.settings.th, S.route.waypoints);
    return Object.assign(W.overall(pass), { live, doneNm, pass });
  }
  const WX_BACKOFF = [60, 300, 900]; // seconds after 1, 2, 3+ consecutive failures
  async function refreshWeather(force) {
    if (SINGLE && !navigator.onLine) { if (force) toast('Offline: using embedded forecast'); return; }
    if (!navigator.onLine) { if (force) toast('Offline: using stored forecast'); return; }
    if (!force && S.wx && Date.now() - S.wx.fetchedAt < 20 * 60000) return;
    if (!force && Date.now() < (S.wxBackoffUntil || 0)) return;
    if (S.wxInflight) return S.wxInflight; // one fetch at a time; callers share it
    const loud = force || !S.navigating; // under way, only the Weather tab dot and the verdict alert change
    if (loud) toast('Fetching forecast…');
    const before = wxVerdictNow();
    S.wxInflight = (async () => {
      try {
        const d = await W.fetchAll(5, null, S.wx);
        if (Object.keys(d.points).length) {
          S.wx = d;
          if (d.stale) S.wxFails = (S.wxFails || 0) + 1; else if (!d.errors.length) S.wxFails = 0;
          if (loud) toast(d.stale ? 'Offline: showing the stored forecast' : 'Forecast updated' + (d.errors.length ? ' (some points kept from the previous fetch)' : ''));
        } else { S.wxFails = (S.wxFails || 0) + 1; if (loud) toast('Forecast fetch failed'); }
      } catch (e) { S.wxFails = (S.wxFails || 0) + 1; if (loud) toast('Forecast fetch failed: ' + e.message); }
      S.wxBackoffUntil = S.wxFails ? Date.now() + WX_BACKOFF[Math.min(S.wxFails, WX_BACKOFF.length) - 1] * 1000 : 0;
    })();
    try { await S.wxInflight; } finally { S.wxInflight = null; }
    const after = wxVerdictNow();
    if (before && after && S.navigating && before.level !== after.level && after.level !== 'incomplete') {
      alert('wxchange', after.level === 'nogo' ? 'danger' : 'warn', `Forecast update: the rest of the passage is now ${LEVELNAME[after.level]}${after.governing ? ', ' + after.governing.text : ''}.`, { value: after.level });
    }
    if ($('view-wx').classList.contains('active')) renderWx();
    if (S.solution) updateHud(S.solution);
    renderWxOverlay(); renderSeaLine(); renderWxDot();
  }
  function wxAgeInfo() {
    const d = S.wx; if (!d) return { level: 'bad', text: 'no forecast', min: null, stale: false };
    const min = Math.round((Date.now() - d.fetchedAt) / 60000);
    return { level: min > 180 ? 'bad' : min > 60 ? 'warn' : 'ok', min, stale: !!d.stale, text: min < 1 ? 'just now' : min < 60 ? min + ' min ago' : (min / 60).toFixed(1) + ' h ago' };
  }
  /** coloured dot on the Weather tab: verdict for the passage as it stands, dimmed when the forecast is old */
  function renderWxDot() {
    const b = document.querySelector('#tabs button[data-view=wx]'); if (!b) return;
    let dot = b.querySelector('.wxdot'); if (!dot) { dot = document.createElement('span'); dot.className = 'wxdot'; b.appendChild(dot); }
    const v = wxVerdictNow(); const age = wxAgeInfo();
    const cls = !v || v.level === 'incomplete' ? 'na' : v.level;
    dot.className = 'wxdot ' + cls + (age.level !== 'ok' ? ' old' : '');
    dot.title = (v ? LEVELNAME[v.level] : 'no forecast') + ', fetched ' + age.text;
  }
  setInterval(renderWxDot, 60000);
  const arrow = deg => `<span class="arrow" style="transform:rotate(${(deg || 0) + 90}deg)">➤</span>`; // wind FROM d blows towards d+180; glyph points east (090)
  const arrowTo = deg => `<span class="arrow" style="transform:rotate(${(deg || 0) - 90}deg)">➤</span>`;
  const LEVELNAME = { ok: 'OK', caution: 'CAUTION', nogo: 'NO-GO', incomplete: 'INCOMPLETE', na: 'NO DATA' };
  const tagFor = v => v ? `<span class="tag ${v.level}">${LEVELNAME[v.level] || v.level.toUpperCase()}</span>` : '<span class="tag na">no data</span>';
  function renderWx() {
    const el = $('wxPage'); const d = S.wx;
    const age = wxAgeInfo(); const cov = d ? W.coverageEnd(d) : null;
    const live = !!(S.navigating && S.solution && S.solution.remaining != null);
    const mode = live && S.wxMode !== 'plan' ? 'now' : 'plan';
    let h = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Forecast along the route</h2><span class="row" style="gap:6px"><span class="tag ${age.level === 'ok' ? 'ok' : age.level === 'warn' ? 'caution' : 'nogo'}">${d ? 'fetched ' + age.text : 'NO FORECAST'}</span><button class="btn" id="btnWxRefresh">Refresh</button></span></div>
      <p class="muted">${d ? `Open-Meteo, ${N.fmtTime(new Date(d.fetchedAt), TZ_ES)} ES${cov ? ', hourly data to ' + cov.slice(5, 10).replace('-', '/') + ' ' + cov.slice(11) + ' ES' : ''}.` : 'No forecast stored yet. Go online and tap Refresh.'} Wind at 10 m in knots, waves = significant height, current = surface (includes tide). Thresholds in Setup.</p>
      ${d && (age.stale || age.level === 'bad') ? `<p class="wxstale">${age.stale ? 'Offline: this is the stored forecast.' : 'This forecast is more than 3 hours old.'}${P.weatherVhf ? ' Check the VHF bulletin: ' + P.weatherVhf : ''}</p>` : ''}</div>`;
    if (d) {
      const dep = new Date(S.settings.departure);
      const doneNm = live ? Math.max(0, S.route.total - S.solution.remaining) : 0;
      const useKn = live && S.sog > 3 ? Math.round(S.sog) : S.settings.speed;
      const pass = mode === 'now' ? W.remainingPassage(d, S.route.waypoints, doneNm, new Date(), S.sog, S.settings.speed, S.settings.th) : W.passage(d, dep, S.settings.speed, S.settings.th, S.route.waypoints);
      const ov = W.overall(pass);
      const title = mode === 'now' ? `Rest of the passage: ${N.fmtNm(S.route.total - doneNm, 1)} nm from here at ${useKn} kn` : `Passage check: depart ${bothTimes(dep)} at ${S.settings.speed} kn`;
      h += `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${title}</h2>${live ? `<span class="seg"><button class="btn ${mode === 'now' ? 'on' : ''}" data-wxmode="now">Now</button><button class="btn ${mode === 'plan' ? 'on' : ''}" data-wxmode="plan">Planned</button></span>` : ''}</div>
        <div class="verdict ${ov.level}"><div class="vlabel">${LEVELNAME[ov.level] || ov.level}</div><div class="vgov">${ov.governing ? ov.governing.text : (ov.level === 'incomplete' ? 'Forecast missing for part of the passage' : 'Nothing over your thresholds at any route point')}</div></div>`;
      // The verdict above already says CAUTION or NO-GO. Repeating it on every line is noise:
      // a severity stripe carries it, and the measurement leads so the list can be scanned.
      if (ov.groups.length) h += `<ul class="reasons">${ov.groups.map(g => {
        const name = W.KEYNAME[g.key] || g.key;
        const head = g.range ? `<b>${name} ${g.range}</b>` : `<b>${name}</b>`;
        return `<li class="${g.level === 2 ? 'nogo' : 'caution'}">${head} <span class="where">${g.where}${g.thr}</span></li>`;
      }).join('')}</ul>`;
      if (ov.missing.length) h += `<p class="muted">No forecast for ${ov.missing.map(m => m.point + (m.field === 'all' ? '' : ' (' + m.field + ')')).join(', ')}: refresh online or change the departure time.</p>`;
      if (mode === 'now') {
        const ab = W.abortCompare(d, S.route.waypoints, doneNm, S.route.total, new Date(), S.sog, S.settings.speed, S.settings.th);
        const line = (label, v, min, n) => `<b>${label}:</b> ${n ? tagFor(v) + ' ' + N.fmtDur(min * 60) + (v.governing ? ', ' + v.governing.text : '') : 'no forecast point that way'}`;
        h += `<p>${line('Carry on to ' + DEST_NAME, ab.on, ab.onMin, ab.onPass.length)}<br>${line('Turn back', ab.back, ab.backMin, ab.backPass.length)}</p>`;
      }
      h += `<div class="tbl"><table><tr><th>Point</th><th>Pass at</th><th>Wind</th><th>Gust</th><th>Waves</th><th>Swell</th><th>Current</th><th>Wind/cur</th><th>Vis</th><th></th></tr>`;
      for (const s of pass) {
        const r = s.row;
        h += `<tr class="${s.verdict ? s.verdict.level : ''}"><td>${s.point.name}</td><td>${N.fmtTime(s.when, TZ_ES)}</td>` + (r ? `<td>${Math.round(r.wind)} kn ${N.compass16(r.windDir)} ${arrow(r.windDir)}</td><td>${Math.round(r.gust)}</td><td>${r.wave != null ? r.wave.toFixed(1) + ' m ' + Math.round(r.wavePeriod) + 's' : '--'}</td><td>${r.swell != null ? r.swell.toFixed(1) + ' m ' + N.compass16(r.swellDir) : '--'}</td><td>${r.current != null ? r.current.toFixed(1) + ' kn ' + arrowTo(r.currentDir) + ' ' + N.compass16(r.currentDir) : '--'}</td><td>${r.current != null && r.current >= 0.8 ? N.windVsCurrent(r.windDir, r.currentDir) : '-'}</td><td>${r.vis != null ? (r.vis / 1000).toFixed(0) + ' km' : '--'}</td><td>${tagFor(s.verdict)}</td>` : '<td colspan="8">no data for this hour</td>') + '</tr>';
      }
      h += '</table></div></div>';
      // departure-window scan (planning only)
      if (mode === 'plan') {
      const scan = W.departureScan(d, new Date(Math.max(Date.now(), new Date(S.settings.departure).getTime() - 12 * 3600000)), 36, S.settings.speed, S.settings.th, S.route.waypoints);
      const okOnes = scan.filter(s => s.overall.level === 'ok');
      h += `<div class="card"><h2>Departure windows (next 36 h)</h2><p class="muted">Same passage check run for every hour of departure. Green rows are windows with nothing over your thresholds. Tap "Use" to plan on that hour.</p><div class="tbl"><table><tr><th>Depart (ES)</th><th>Verdict</th><th>Max wind</th><th>Max gust</th><th>Max wave</th><th></th></tr>`;
      for (const s of scan) h += `<tr class="${s.overall.level === 'ok' ? 'best' : s.overall.level}"><td>${s.dep.toDateString().slice(0, 3)} ${N.fmtTime(s.dep, TZ_ES)}</td><td>${tagFor(s.overall)}</td><td>${s.maxWind != null && s.maxWind >= 0 ? Math.round(s.maxWind) + ' kn' : '--'}</td><td>${s.maxGust != null && s.maxGust >= 0 ? Math.round(s.maxGust) : '--'}</td><td>${s.maxWave != null && s.maxWave >= 0 ? s.maxWave.toFixed(1) + ' m' : '--'}</td><td><button class="btn" data-dep="${s.dep.toISOString()}" style="padding:4px 8px">Use</button></td></tr>`;
      h += `</table></div>${okOnes.length ? '' : '<p><b>No clean window in the next 36 hours</b> at these thresholds.</p>'}</div>`;
      }
      // hourly table for a selected point
      const sel = S.wxSel || 'tarifa'; const pt = d.points[sel];
      h += `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Hourly</h2><select id="wxSel">${W.POINTS.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>`;
      if (pt) {
        const startIdx = Math.max(0, pt.rows.findIndex(r => r.time >= W.madridLocalIso(new Date(Date.now() - 2 * 3600000))));
        h += `<div class="tbl"><table><tr><th>ES time</th><th>Wind</th><th>Gust</th><th>Waves</th><th>Swell</th><th>Current</th><th>Tide</th><th>Sky</th><th></th></tr>`;
        for (const r of pt.rows.slice(startIdx, startIdx + 30)) {
          const v = W.classify(r, S.settings.th);
          h += `<tr class="${v.level}"><td>${r.time.slice(5, 10).replace('-', '/')} ${r.time.slice(11)}</td><td>${Math.round(r.wind)} ${N.compass16(r.windDir)} ${arrow(r.windDir)}</td><td>${Math.round(r.gust)}</td><td>${r.wave != null ? r.wave.toFixed(1) + ' m ' + Math.round(r.wavePeriod) + 's' : '--'}</td><td>${r.swell != null ? r.swell.toFixed(1) + ' m' : '--'}</td><td>${r.current != null ? r.current.toFixed(1) + ' ' + arrowTo(r.currentDir) : '--'}</td><td>${r.seaLevel != null ? (r.seaLevel >= 0 ? '+' : '') + r.seaLevel.toFixed(2) + ' m' : '--'}</td><td>${W.WMO[r.code] || ''}</td><td>${v.level !== 'ok' ? v.reasons.join(', ') : ''}</td></tr>`;
        }
        h += '</table></div>';
        h += tideSummary(pt);
      }
      h += '</div>';
      h += P.weatherNotes || '';
    }
    el.innerHTML = h; renderWxDot();
    $('btnWxRefresh').addEventListener('click', () => refreshWeather(true));
    const s = $('wxSel'); if (s) s.addEventListener('change', () => { S.wxSel = s.value; renderWx(); });
    el.querySelectorAll('button[data-wxmode]').forEach(b => b.addEventListener('click', () => { S.wxMode = b.dataset.wxmode; renderWx(); }));
    el.querySelectorAll('button[data-dep]').forEach(b => b.addEventListener('click', () => { S.settings.departure = b.dataset.dep; saveSettings(); toast('Departure set to ' + bothTimes(new Date(b.dataset.dep))); renderWx(); }));
  }
  function tideSummary(pt) {
    const rows = pt.rows.filter(r => r.seaLevel != null); if (rows.length < 5) return '';
    const ev = [];
    for (let i = 1; i < rows.length - 1; i++) {
      const a = rows[i - 1].seaLevel, b = rows[i].seaLevel, c = rows[i + 1].seaLevel;
      if (b > a && b >= c) ev.push({ t: rows[i].time, k: 'HW', h: b });
      if (b < a && b <= c) ev.push({ t: rows[i].time, k: 'LW', h: b });
    }
    const nowIso = W.madridLocalIso(new Date());
    const next = ev.filter(e => e.t >= nowIso.slice(0, 13)).slice(0, 4);
    return `<h3>Tide at ${pt.name} (model, approximate)</h3><p>${next.map(e => `${e.k} ${e.t.slice(11)} ES (${e.h.toFixed(1)} m)`).join(' · ')}</p><p class="muted">Rule of thumb off Tarifa: the east-going stream runs roughly from 3 h before to 3 h after local high water and can reach 2 to 3 kn at springs; the west-going stream is weaker because the permanent Atlantic inflow opposes it. Verify with official tide tables.</p>`;
  }

  // ---------- plan ----------
  function renderPlan() {
    const el = $('planPage'); const r = S.route; const dep = new Date(S.settings.departure);
    const sp = S.settings.speed;
    let cum = 0;
    let h = `<div class="card"><h2>Route</h2><div class="row">${P.routes.map(x => `<label class="row" style="gap:6px"><input type="radio" name="route" value="${x.id}" ${x.id === r.id ? 'checked' : ''}> ${x.recommended ? 'Recommended' : 'Alternative'}</label>`).join('')}</div>
      <p><b>${r.name}</b></p><p>${r.summary}</p>
      <div class="kv"><div>Distance</div><div>${r.total} nm</div><div>At ${sp} kn</div><div>${N.fmtDur(r.total / sp * 3600)}</div><div>Departure</div><div>${bothTimes(dep)} · ${dep.toDateString()}</div><div>ETA ${esc(DEST_NAME)}</div><div>${bothTimes(new Date(dep.getTime() + r.total / sp * 3600000))}</div><div>Fuel estimate</div><div>${Math.round(r.total / sp * (P.vessel.burnLph || 75))} L at a planning burn of ${P.vessel.burnLph || 75} L/h (${P.vessel.name || 'planning figure'}; tanks ${P.vessel.fuelL || '?'} L). Leave with full tanks.</div></div></div>`;
    h += `<div class="card"><h2>Legs</h2><div class="tbl"><table><tr><th>#</th><th>From</th><th>To</th><th>Course</th><th>Dist</th><th>Leg</th><th>ETA (ES)</th></tr>`;
    r.legs.forEach((l, i) => { cum += l.dist; h += `<tr><td>${i + 1}</td><td>${l.from}</td><td>${l.to}</td><td>${N.fmtBrg(l.brg)}</td><td>${l.dist.toFixed(1)}</td><td>${N.fmtDur(l.dist / sp * 3600)}</td><td>${N.fmtTime(new Date(dep.getTime() + cum / sp * 3600000), TZ_ES)}</td></tr>`; });
    h += `</table></div><p class="muted">Courses are true. Apply your compass variation (about 1° W here) and deviation if steering by compass.</p></div>`;
    h += `<div class="card"><h2>Waypoints</h2><div class="tbl"><table><tr><th>ID</th><th>Position</th><th>Note</th></tr>${r.waypoints.map(w => `<tr><td><b>${w.id}</b><br><span class="muted">${w.name}</span></td><td>${N.fmtDM(w.lat, w.lon)}<br><span class="muted">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span></td><td style="white-space:normal;min-width:220px">${w.note}</td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:8px">${SINGLE ? '' : `<a class="btn" id="gpxLink" download="saily-${r.id}.gpx">Download GPX for the plotter</a>`}<button class="btn" id="btnCopyWp">Copy waypoints (ID, lat/lon)</button></div></div>`;
    for (const c of (P.cards || [])) h += c.html;
    h += `<div class="card"><h2>Departure checklist</h2><div class="check">${CHECKLIST.map((c, i) => `<label><input type="checkbox" data-ck="${i}" ${S.settings.checklist[i] ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></div>`;
    // pilotage card: paper backup (print / save as PDF)
    const variation = P.variationDeg != null ? P.variationDeg : -1;
    const near = (lat, lon, maxNm) => { let best = Infinity, from = null; for (const l of r.legs) { const A = r.waypoints.find(w => w.id === l.from), B = r.waypoints.find(w => w.id === l.to); const al = N.alongTrackNm({ lat, lon }, A, B); const d = al < 0 ? N.distanceNm({ lat, lon }, A) : al > l.dist ? N.distanceNm({ lat, lon }, B) : Math.abs(N.crossTrackNm({ lat, lon }, A, B)); if (d < best) { best = d; from = l.from; } } return best <= maxNm ? { d: best, from } : null; };
    const hazRows = (S.dangers || P.hazards).map(hz => ({ hz, n: near(hz.lat, hz.lon, 0.6 + hz.radius) })).filter(x => x.n).map(x => `<tr><td>${x.hz.name}</td><td>${N.fmtDM(x.hz.lat, x.hz.lon)}</td><td>${N.fmtNm(x.n.d)} nm off leg from ${x.n.from}</td></tr>`).join('');
    const lightRows = C.aids.filter(x => x.light && (x.type.startsWith('light') || x.type.startsWith('beacon') || x.type.startsWith('buoy'))).map(x => ({ x, n: near(x.lat, x.lon, 2) })).filter(o => o.n).slice(0, 24).map(o => `<tr><td>${o.x.name || o.x.type.replace(/_/g, ' ')}</td><td>${o.x.light}</td><td>${N.fmtDM(o.x.lat, o.x.lon)}</td></tr>`).join('');
    let cum2 = 0;
    h += `<div class="card print-card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Pilotage card (paper backup)</h2><button class="btn" id="btnPrint">Print / save as PDF</button></div>
      <p class="muted">Courses true and magnetic (variation ${variation}°). Times at ${sp} kn from ${bothTimes(dep)}, ${dep.toDateString()}.</p>
      <div class="tbl"><table><tr><th>#</th><th>To</th><th>°T</th><th>°M</th><th>nm</th><th>ETA ${TZL_FROM}</th><th>ETA ${TZL_TO}</th><th>Instruction</th></tr>${r.legs.map((l, i) => { cum2 += l.dist; const w = r.waypoints.find(x => x.id === l.to); const at = new Date(dep.getTime() + cum2 / sp * 3600000); return `<tr><td>${i + 1}</td><td><b>${l.to}</b><br><span class="muted">${N.fmtDM(w.lat, w.lon)}</span></td><td>${N.fmtBrg(l.brg)}</td><td>${N.fmtBrg(l.brg - variation)}</td><td>${l.dist.toFixed(1)}</td><td>${N.fmtTime(at, TZ_ES)}</td><td>${fmtMA(at)}</td><td style="white-space:normal;min-width:200px">${(w.note || '').split(/(?<=[.!?])\s/)[0]}</td></tr>`; }).join('')}</table></div>
      <h3>Dangers near the route</h3><div class="tbl"><table><tr><th>Name</th><th>Position</th><th>Where</th></tr>${hazRows || '<tr><td colspan="3">none within 0.6 nm</td></tr>'}</table></div>
      <h3>Lights within 2 nm of the route</h3><div class="tbl"><table><tr><th>Name</th><th>Character</th><th>Position</th></tr>${lightRows || '<tr><td colspan="3">none charted</td></tr>'}</table></div>
      <h3>Radio</h3><p>${Object.values(P.places).map(pl => `${pl.name}: VHF ${pl.vhf}${pl.phone ? ', ' + pl.phone : ''}`).join(' · ')} · Distress VHF 16 / DSC 70</p></div>`;
    const sun = N.sunTimes(new Date(), P.sun.lat, P.sun.lon);
    h += `<div class="card"><h2>Daylight today</h2><p>Sunrise ${sun.sunrise ? bothTimes(sun.sunrise) : '--'} · Sunset ${sun.sunset ? bothTimes(sun.sunset) : '--'} at ${esc(DEST_NAME)}.${P.sunNote ? ' ' + esc(P.sunNote) : ''}</p></div>`;
    el.innerHTML = h;
    const bp = $('btnPrint'); if (bp) bp.addEventListener('click', () => window.print());
    el.querySelectorAll('input[name=route]').forEach(i => i.addEventListener('change', () => { S.settings.routeId = i.value; S.settings.wp = 1; saveSettings(); S.route = P.routes.find(x => x.id === i.value); S.zone = {}; S.approached = {}; drawRoutes(); renderPlan(); if (S.pos) processFix(); }));
    if ($('gpxLink')) $('gpxLink').href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(N.toGPX('Saily ' + r.id, r.waypoints));
    $('btnCopyWp').addEventListener('click', async () => { const txt = r.waypoints.map(w => `${w.id}\t${N.fmtDM(w.lat, w.lon)}\t${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`).join('\n'); try { await navigator.clipboard.writeText(txt); toast('Copied'); } catch (e) { toast('Copy failed'); } });
    el.querySelectorAll('input[data-ck]').forEach(i => i.addEventListener('change', () => { S.settings.checklist[i.dataset.ck] = i.checked; saveSettings(); }));
  }
  const CHECKLIST = P.checklist || [];

  // ---------- setup / more ----------
  function renderMore() {
    const el = $('morePage'); const s = S.settings;
    // Ordered by what matters at sea: the passage first, then what you hear, then what you see.
    let h = `<div class="card"><h2>Passage</h2>
      <label class="field"><span>Planned cruise speed (kn)</span><input type="number" id="setSpeed" min="5" max="40" step="1" value="${s.speed}"></label>
      <label class="field"><span>Planned departure (${TZL_FROM})</span><input type="datetime-local" id="setDep" value="${toLocalInput(TZ_ES, new Date(s.departure))}"></label>
      <label class="field"><span>Route</span><select id="setRoute">${P.routes.map(r => `<option value="${esc(r.id)}" ${r.id === s.routeId ? 'selected' : ''}>${r.recommended ? 'Recommended' : 'Alternative'} (${esc(r.short || r.id)})</option>`).join('')}</select></label>
      <label class="field"><span>${esc(TZL_TO)} clock</span><select id="setMa"><option value="auto" ${s.maOffset === 'auto' ? 'selected' : ''}>Automatic (phone time zone data)</option>${TZ_OFFSETS.map(o => `<option value="${o.minutes}" ${String(s.maOffset) === String(o.minutes) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
      <div class="row" style="margin-top:12px"><button class="btn" id="btnResetWp">Restart route from WP 1</button></div></div>`;
    h += `<div class="card"><h2>Alerts and sound</h2>
      <label class="field"><span>Spoken alerts</span><input type="checkbox" id="setVoice" ${s.voice ? 'checked' : ''}></label>
      <label class="field"><span>Alert beeps</span><input type="checkbox" id="setSound" ${s.sound ? 'checked' : ''}></label>
      <div class="row" style="margin-top:12px"><button class="btn" id="btnTestAlert">Test alert</button></div>
      <details class="help"><summary>How alerts behave</summary><p>Danger alerts never interrupt one another and repeat only when something changes. The banner has a Quiet button that silences a repeating alert without switching sound off. Sound plays through the iPhone silent switch.</p></details></div>`;
    h += `<div class="card"><h2>Display</h2>
      <label class="field"><span>Colours</span><select id="setTheme"><option value="auto" ${(s.theme || 'auto') === 'auto' ? 'selected' : ''}>Automatic (night after sunset)</option><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="day" ${s.theme === 'day' ? 'selected' : ''}>Daylight (glare)</option><option value="night" ${s.theme === 'night' ? 'selected' : ''}>Night (red)</option></select></label>
      <label class="field"><span>Night dimmer (${Math.round((s.dim || 0) * 100)}%)</span><input type="range" id="setDim" min="0" max="85" step="5" value="${Math.round((s.dim || 0) * 100)}"></label>
      <label class="field"><span>Big numbers (hide the chart)</span><input type="checkbox" id="setBigHud" ${s.bigHud ? 'checked' : ''}></label>
      <label class="field"><span>Auto-zoom the chart to the next waypoint</span><input type="checkbox" id="setAutoZoom" ${s.autoZoom !== false ? 'checked' : ''}></label>
      <details class="help"><summary>About night colours</summary><p>Night is red-amber on black so it does not spoil your night vision, and the chart is tinted to match. On Automatic it switches itself at sunset and back at sunrise, with an undo toast either way.</p></details></div>`;
    h += `<div class="card"><h2>Ships (AIS)</h2>
      <label class="field"><span>aisstream.io API key</span><input type="text" id="setAisKey" value="${esc(s.aisKey || '')}" placeholder="paste key here" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>Show live ships</span><input type="checkbox" id="setAisOn" ${s.aisOn ? 'checked' : ''}></label>
      <label class="field"><span>Show demo ships in the simulation</span><input type="checkbox" id="setAisDemo" ${s.aisDemo !== false ? 'checked' : ''}></label>
      <div class="row" style="margin-top:12px"><button class="btn" id="btnAisTest">Test the key</button></div>
      <div class="muted small" style="margin-top:10px">Status: <span id="aisStatus">${aisStatusText()}</span></div>
      <details class="help"><summary>Getting a key, and what it can and cannot do</summary>
      <p><b>This needs mobile data and it is not a lookout.</b> Coverage comes from volunteer shore receivers: not every ship, up to a minute late, and nothing at all once you lose signal offshore. A real AIS receiver on the boat, or the plotter's own AIS, is the only version of this that works out there. Treat what you see here as a hint about traffic, never as the traffic.</p>
      <p>aisstream.io gives a free key: sign in with GitHub, no payment. Paste it above and the app streams ships in the passage area, draws them with their course, works out the closest point of approach (CPA) and the time to it (TCPA), and raises a danger alert when a ship will pass within 0.5 nm in the next 12 minutes.</p>
      <p>Nothing showing? The status line says why. "connected" with no messages for a minute usually means the key was refused; "rejected" prints what the server said. Live AIS pauses while the demo simulation runs.</p></details></div>`;
    h += `<div class="card"><h2>Chart layers</h2>
      <label class="field"><span>OpenSeaMap buoys and lights</span><input type="checkbox" id="setSeamark" ${s.seamark ? 'checked' : ''}></label>
      <label class="field"><span>Depth shading (EMODnet, online only)</span><input type="checkbox" id="setDepth" ${s.depth ? 'checked' : ''}></label>
      <details class="help"><summary>What the depth layer is worth</summary><p>EMODnet bathymetry is a gridded model of about 100 m cells: fine for seeing banks and the shelf, useless for the last metres in a harbour. Charted rocks, wrecks and obstructions from OpenStreetMap are drawn as red asterisks with a 0.1 nm alarm circle, and the app warns when land or rocks lie on your heading within four minutes at your speed.</p></details></div>`;
    h += `<div class="card"><h2>Weather thresholds</h2><p class="muted small">Caution and no-go limits for this boat. The passage verdict on the Weather tab uses these.</p>
      <label class="field"><span>Wind caution / no-go (kn)</span><span class="row"><input type="number" id="thWindC" value="${s.th.windCaution}" style="width:70px"><input type="number" id="thWindN" value="${s.th.windNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Gust caution / no-go (kn)</span><span class="row"><input type="number" id="thGustC" value="${s.th.gustCaution}" style="width:70px"><input type="number" id="thGustN" value="${s.th.gustNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Wave caution / no-go (m)</span><span class="row"><input type="number" step="0.1" id="thWaveC" value="${s.th.waveCaution}" style="width:70px"><input type="number" step="0.1" id="thWaveN" value="${s.th.waveNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Current caution (kn)</span><input type="number" step="0.1" id="thCur" value="${s.th.currentCaution}" style="width:70px"></label></div>`;
    h += `<div class="card"><h2>Offline</h2><p class="muted small">Do this on wifi before leaving. Stores the app, the forecast and the map tiles for the whole route, about 15 to 40 MB. The chart, route, traffic scheme and hazards are built in and always work offline.</p>
      <div class="row"><button class="btn primary" id="btnPreloadAll">Preload everything</button><button class="btn" id="btnPreloadWx">Forecast only</button><button class="btn" id="btnPreloadTiles">Map tiles only</button></div>
      <div class="progress"><div id="preProg"></div></div><div id="preText" class="muted small">${preloadStatusText()}</div><div id="storeText" class="muted small"></div></div>`;
    h += `<div class="card"><h2>Ready for sea</h2><div id="readyCard" class="muted">checking…</div></div>`;
    h += `<div class="card"><h2>Status</h2><div class="kv"><div>Service worker</div><div id="swText">${SINGLE ? 'single-file build: no service worker (save the page or add to Home Screen; the chart, route and hazards are built in)' : (navigator.serviceWorker && navigator.serviceWorker.controller ? 'active (offline ready)' : 'not yet active: reload once online')}</div><div>Wake lock</div><div>${S.wakeLock ? 'held (screen stays on)' : ('wakeLock' in navigator ? 'not held' : 'not supported: disable auto-lock in iPhone Settings, Display')}</div><div>Simulation</div><div class="row"><button class="btn" id="btnSim">${S.sim ? 'Stop simulation' : 'Start simulation (demo)'}</button></div></div>
      <details class="help"><summary>Installing it properly</summary><p>iPhone: Safari share button, "Add to Home Screen". Mac: Safari File menu, "Add to Dock". Then open it from the icon and run the preload <b>there</b>: the Home Screen app has its own storage, separate from Safari's.</p></details></div>`;
    h += `<div class="card"><h2>Alert log</h2><div class="log">${esc(S.log.slice(0, 40).map(l => `${N.fmtTime(new Date(l.t), TZ_ES)} [${l.level}] ${l.text}${l.n > 1 ? ' (x' + l.n + ')' : ''}`).join('\n') || 'none yet')}</div><div class="row" style="margin-top:12px"><button class="btn" id="btnClearLog">Clear log</button><button class="btn" id="btnClearTrack">Clear track</button>${SINGLE ? '' : '<a class="btn" id="btnTrackGpx" download="saily-track.gpx">Export track (GPX)</a>'}<button class="btn danger" id="btnReset">Reset app data</button></div></div>`;
    h += `<div class="card"><h2>About</h2><p class="muted small">Saily is a passage aid, not a chart plotter. Data: ${esc(C.meta.sources.join('; '))}. Weather: Open-Meteo (CC BY 4.0). Map tiles: OpenStreetMap, CARTO, Esri, OpenSeaMap. Positions from the phone GPS (WGS84). <b>Not for navigation without official charts, a proper lookout and the COLREGs.</b></p></div>`;
    el.innerHTML = h;
    const num = (id, f) => $(id).addEventListener('change', () => { const v = parseFloat($(id).value); if (isFinite(v)) { f(v); saveSettings(); if (S.solution) updateHud(S.solution); } });
    num('setSpeed', v => { s.speed = v; });
    $('setDep').addEventListener('change', () => { try { s.departure = fromLocal(TZ_ES, $('setDep').value).toISOString(); saveSettings(); } catch (e) { } });
    $('setRoute').addEventListener('change', () => { s.routeId = $('setRoute').value; s.wp = 1; S.route = P.routes.find(x => x.id === s.routeId); S.zone = {}; S.approached = {}; saveSettings(); drawRoutes(); if (S.pos) processFix(); });
    $('setVoice').addEventListener('change', () => { s.voice = $('setVoice').checked; saveSettings(); });
    $('setAutoZoom').addEventListener('change', () => { s.autoZoom = $('setAutoZoom').checked; saveSettings(); });
    $('setTheme').addEventListener('change', () => { s.theme = $('setTheme').value; saveSettings(); applyTheme(); });
    $('setDim').addEventListener('input', () => { s.dim = Number($('setDim').value) / 100; saveSettings(); applyTheme(); $('setDim').previousElementSibling.textContent = `Night dimmer (${Math.round(s.dim * 100)}%)`; });
    $('setBigHud').addEventListener('change', () => { s.bigHud = $('setBigHud').checked; saveSettings(); applyTheme(); });
    const aisRefresh = () => { const el = $('aisStatus'); if (el) el.innerHTML = aisStatusText(); };
    $('setAisOn').addEventListener('change', () => { s.aisOn = $('setAisOn').checked; saveSettings(); aisApply(); aisRefresh(); setTimeout(aisRefresh, 1500); });
    // A pasted key is the whole intent: switch AIS on with it rather than making the user find a second control.
    const aisKeyChanged = () => {
      const v = $('setAisKey').value.trim();
      if (v === (s.aisKey || '')) return;
      s.aisKey = v;
      if (v && !s.aisOn) { s.aisOn = true; $('setAisOn').checked = true; toast('AIS switched on'); }
      saveSettings(); aisApply(); aisRefresh(); setTimeout(aisRefresh, 2000);
    };
    $('setAisKey').addEventListener('change', aisKeyChanged);
    $('setAisKey').addEventListener('blur', aisKeyChanged);
    $('setAisKey').addEventListener('paste', () => setTimeout(aisKeyChanged, 0));
    $('btnAisTest').addEventListener('click', () => {
      aisKeyChanged();
      if (!(s.aisKey || '').trim()) { toast('Paste a key first'); return; }
      if (S.sim) { toast('Stop the demo simulation first'); return; }
      aisApply();
      $('aisStatus').innerHTML = 'testing…';
      let n = 0; const iv = setInterval(() => { aisRefresh(); if (++n > 12) clearInterval(iv); }, 2500);
    });
    $('setAisDemo').addEventListener('change', () => { s.aisDemo = $('setAisDemo').checked; saveSettings(); });
    $('setDepth').addEventListener('change', () => { s.depth = $('setDepth').checked; saveSettings(); applyBase(); });
    if (!S.aisStatusTimer) S.aisStatusTimer = setInterval(() => { const el = $('aisStatus'); if (el) el.innerHTML = aisStatusText(); }, 5000);
    $('setSound').addEventListener('change', () => { s.sound = $('setSound').checked; saveSettings(); });
    $('setSeamark').addEventListener('change', () => { s.seamark = $('setSeamark').checked; saveSettings(); applyBase(); });
    $('setMa').addEventListener('change', () => { s.maOffset = $('setMa').value; saveSettings(); tickClocks(); if (S.solution) updateHud(S.solution); });
    num('thWindC', v => s.th.windCaution = v); num('thWindN', v => s.th.windNoGo = v); num('thGustC', v => s.th.gustCaution = v); num('thGustN', v => s.th.gustNoGo = v);
    num('thWaveC', v => s.th.waveCaution = v); num('thWaveN', v => s.th.waveNoGo = v); num('thCur', v => s.th.currentCaution = v);
    $('btnTestAlert').addEventListener('click', () => { ensureAudio(); alert('test', 'warn', 'Test alert. Ships come from your left. Steer 180.', {}); });
    $('btnResetWp').addEventListener('click', () => { s.wp = 1; S.approached = {}; S.arrivedFinal = false; saveSettings(); drawRoutes(); if (S.pos) processFix(); toast('Route restarted'); });
    $('btnPreloadAll').addEventListener('click', () => preload(true, true));
    $('btnPreloadWx').addEventListener('click', () => preload(true, false));
    $('btnPreloadTiles').addEventListener('click', () => preload(false, true));
    $('btnSim').addEventListener('click', () => { if (S.sim) { stopSim(); } else { ensureAudio(); S.started = true; S.navigating = true; $('startOverlay').classList.add('hidden'); startSim(s.wp); showView('nav'); } renderMore(); });
    $('btnClearLog').addEventListener('click', () => { S.log = []; saveJson(LOG_KEY, []); renderMore(); });
    if ($('btnTrackGpx')) $('btnTrackGpx').href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(N.trackGPX('Saily track', S.track));
    $('btnClearTrack').addEventListener('click', () => { S.track = []; track.setLatLngs([]); saveJson(TRACK_KEY, []); S.trip = S.navigating ? { startedAt: Date.now(), dist: 0, maxSog: 0, n: 0 } : null; saveJson('saily.trip.v1', S.trip); toast('Track and trip log cleared'); });
    $('btnReset').addEventListener('click', () => { if (confirm('Reset all settings, track and log?')) { localStorage.clear(); location.reload(); } });
    renderReady();
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { $('storeText').textContent = `Storage used: ${(e.usage / 1048576).toFixed(1)} MB of ${(e.quota / 1048576).toFixed(0)} MB available.`; }).catch(() => { });
  }
  function preloadStatusText() {
    const p = loadJson('saily.preload.v1', null);
    return p ? `Last preload ${new Date(p.t).toLocaleString()} : ${p.tiles} tiles stored, ${p.failed} failed.` : 'Not preloaded yet.';
  }

  // ---------- tile preload ----------
  function tileRange(bbox, z) { // bbox [s,w,n,e]
    const n = Math.pow(2, z);
    const x1 = Math.floor((bbox[1] + 180) / 360 * n), x2 = Math.floor((bbox[3] + 180) / 360 * n);
    const lat2y = lat => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    const y1 = lat2y(bbox[2]), y2 = lat2y(bbox[0]);
    const out = []; for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) out.push({ z, x, y }); return out;
  }
  function tileUrls() {
    const corridor = [35.72, -5.95, 36.34, -5.20];
    const harb = [[36.27, -5.30, 36.31, -5.24], [35.77, -5.83, 35.81, -5.76]];
    const osm = t => `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
    const sea = t => `https://tiles.openseamap.org/seamark/${t.z}/${t.x}/${t.y}.png`;
    const sat = t => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${t.z}/${t.y}/${t.x}`;
    const carto = t => `https://a.basemaps.cartocdn.com/rastertiles/voyager/${t.z}/${t.x}/${t.y}.png`;
    const urls = [];
    // corridor: CARTO base (light, permissive terms) + OpenSeaMap seamarks; OSM standard only for the two harbours (small, within OSM policy)
    for (let z = 8; z <= 13; z++) tileRange(corridor, z).forEach(t => { urls.push(carto(t)); if (z >= 10) urls.push(sea(t)); });
    for (const b of harb) for (let z = 14; z <= 16; z++) tileRange(b, z).forEach(t => { urls.push(carto(t)); urls.push(osm(t)); urls.push(sea(t)); urls.push(sat(t)); });
    return urls;
  }
  async function preload(wx, tiles) {
    if (SINGLE) { toast('Single-file version: nothing to preload, the chart is built in'); return; }
    if (!navigator.onLine) { toast('You are offline'); return; }
    if (!('caches' in window)) { toast('Offline storage needs https (or localhost). Open the app from its https address.'); return; }
    const prog = $('preProg'), txt = $('preText');
    const setP = (f, t) => { if (prog) prog.style.width = Math.round(f * 100) + '%'; if (txt) txt.textContent = t; };
    try { if (navigator.serviceWorker) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } } catch (e) { }
    if (wx) { setP(0.02, 'Fetching forecast…'); await refreshWeather(true); }
    if (tiles) {
      const urls = tileUrls(); let done = 0, failed = 0;
      const cache = await caches.open('tiles-v1');
      const worker = async () => {
        while (urls.length) {
          const u = urls.shift();
          try {
            const hit = await cache.match(u);
            if (!hit || hit.headers.get('X-Saily') === 'blank') {
              let res = null;
              try { res = await fetch(u, { mode: 'cors', cache: 'no-store' }); } catch (e) { res = null; }
              if (!res) { try { res = await fetch(u, { mode: 'no-cors', cache: 'no-store' }); } catch (e) { res = null; } }
              if (!res || res.headers.get('X-Saily') === 'blank') failed++;
              else if (res.ok || res.type === 'opaque') await cache.put(u, res);
              else failed++;
            }
          } catch (e) { failed++; }
          done++; if (done % 10 === 0) setP(0.05 + 0.95 * done / (done + urls.length), `Tiles ${done}/${done + urls.length} (${failed} failed)`);
        }
      };
      const total = urls.length;
      await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
      saveJson('saily.preload.v1', { t: Date.now(), tiles: total - failed, failed });
      setP(1, `Done: ${total - failed} tiles stored, ${failed} failed. ${preloadStatusText()}`);
    } else setP(1, 'Forecast stored.');
    toast('Preload finished');
    renderMore();
  }

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && !SINGLE) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(reg => {
        S.swReg = reg;
        const offer = () => { if (reg.waiting) showUpdateBar(reg); };
        offer();
        reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(); }); });
        setInterval(() => { if (!S.navigating) reg.update().catch(() => { }); }, 6 * 3600000);
      }).catch(() => { });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.applyingUpdate && !reloading) { reloading = true; location.reload(); } });
    });
  }

  // update bar: a new build waits until the user applies it (never mid-passage)
  function showUpdateBar(reg) {
    let bar = $('updateBar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'updateBar'; document.querySelector('main').appendChild(bar); }
    bar.innerHTML = `<span>New version downloaded${S.navigating ? ' (apply when berthed)' : ''}.</span><button class="btn" id="btnApplyUpdate">Apply and reload</button><button class="btn" id="btnLaterUpdate">Later</button>`;
    bar.classList.remove('hidden');
    $('btnApplyUpdate').addEventListener('click', () => { if (S.navigating && !confirm('Apply the update now? The app reloads; navigation restarts from the saved waypoint.')) return; S.applyingUpdate = true; try { reg.waiting.postMessage('skipWaiting'); } catch (e) { location.reload(); } });
    $('btnLaterUpdate').addEventListener('click', () => bar.classList.add('hidden'));
  }
  // resume a passage after iOS killed the tab: restore guard state silently and restart GPS without a tap
  function tryResume() {
    const nav = loadJson('saily.nav.v1', null);
    if (!nav || !nav.navigating || !nav.lastFix || Date.now() - (nav.lastFix.t || nav.t) > 30 * 60000) return false;
    S.zone = nav.zone || {}; S.hazard = nav.hazard || {}; S.hazardNear = nav.hazardNear || {}; S.approached = nav.approached || {}; S.arrivedFinal = !!nav.arrivedFinal;
    S.settings.wp = nav.wp || S.settings.wp; S.started = true; S.navigating = true;
    S.trip = loadJson('saily.trip.v1', null) || { startedAt: nav.startedAt || Date.now(), dist: 0, maxSog: 0, n: 0 };
    S.pos = { lat: nav.lastFix.lat, lon: nav.lastFix.lon, t: nav.lastFix.t, acc: nav.lastFix.acc }; S.acc = nav.lastFix.acc; S.lastFixAt = Date.now();
    $('startOverlay').classList.add('hidden'); drawRoutes(); processFix(); startGps(); requestWakeLock();
    const bar = $('resumeBar'); bar.innerHTML = `<span>Passage resumed at ${WPS()[S.settings.wp].id}. Tap for sound.</span><button class="btn primary" id="btnResumeSound">Sound on</button>`; bar.classList.remove('hidden');
    $('btnResumeSound').addEventListener('click', () => { ensureAudio(); bar.classList.add('hidden'); const sol = S.solution; speak(`Resumed. ${sol ? N.fmtNm(sol.remaining) + ' miles to go, next ' + sol.wp.id : ''}`, 'warn', 'resume'); });
    S.log.unshift({ t: Date.now(), level: 'info', text: 'Resumed passage after the app was closed', id: 'resume' });
    return true;
  }
  // ---------- ready for sea: self-test with one-tap fixes ----------
  async function readyChecks() {
    const rows = [];
    const dot = (ok, warn) => ok ? 'ok' : warn ? 'warn' : 'bad';
    // 1 offline shell
    let shell = { ok: false, text: 'service worker not controlling', fix: 'reload' };
    try {
      if (SINGLE) shell = { ok: true, text: 'single-file build, everything inline' };
      else if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        const missing = await new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = e => res(e.data.missing || []); navigator.serviceWorker.controller.postMessage('shell-status', [ch.port2]); setTimeout(() => res(null), 1500); });
        shell = missing === null ? { ok: false, warn: true, text: 'service worker did not answer' } : missing.length ? { ok: false, text: missing.length + ' app files not cached', fix: 'preload' } : { ok: true, text: 'app cached for offline use' };
      }
    } catch (e) { }
    rows.push({ name: 'App offline', ...shell });
    // 2 tiles
    try {
      if (!SINGLE && 'caches' in window) { const c = await caches.open('tiles-v1'); const urls = tileUrls().filter(u => u.includes('cartocdn') || u.includes('openseamap')); let have = 0; const sample = urls.filter((u, i) => i % 7 === 0); for (const u of sample) if (await c.match(u)) have++; const pct = sample.length ? Math.round(have / sample.length * 100) : 0; rows.push({ name: 'Map tiles', ok: pct >= 95, warn: pct >= 50, text: pct + '% of corridor tiles cached (vector chart always works)', fix: pct < 95 ? 'preload' : null }); }
      else rows.push({ name: 'Map tiles', ok: true, text: 'vector chart built in' });
    } catch (e) { rows.push({ name: 'Map tiles', ok: false, warn: true, text: 'cache not available (needs https)' }); }
    // 3 forecast
    if (S.wx) { const age = (Date.now() - S.wx.fetchedAt) / 3600000; const pt = Object.values(S.wx.points)[0]; const last = pt && pt.rows.length ? pt.rows[pt.rows.length - 1].time : null; const eta = new Date(new Date(S.settings.departure).getTime() + (S.route.total / S.settings.speed + 6) * 3600000); const covers = last ? last >= W.madridLocalIso(eta) : false; rows.push({ name: 'Forecast', ok: age < 6 && covers, warn: age < 24, text: `${age < 1 ? Math.round(age * 60) + ' min' : age.toFixed(1) + ' h'} old${covers ? '' : ', does not cover the planned passage'}`, fix: (age >= 6 || !covers) ? 'wx' : null }); }
    else rows.push({ name: 'Forecast', ok: false, text: 'none stored', fix: 'wx' });
    // 4 location permission
    try { const st = navigator.permissions ? await navigator.permissions.query({ name: 'geolocation' }) : null; rows.push({ name: 'Location', ok: st ? st.state === 'granted' : !!S.pos, warn: !st || st.state === 'prompt', text: st ? st.state : (S.pos ? 'fix received' : 'unknown until you tap Start'), fix: (!st || st.state !== 'granted') ? 'gps' : null }); } catch (e) { rows.push({ name: 'Location', ok: !!S.pos, warn: true, text: S.pos ? 'fix received' : 'unknown until you tap Start', fix: 'gps' }); }
    // 5 wake lock
    rows.push({ name: 'Screen stays on', ok: !!S.wakeLock, warn: 'wakeLock' in navigator, text: S.wakeLock ? 'wake lock held' : ('wakeLock' in navigator ? 'not held yet (granted on Start; refused in Low Power Mode)' : 'not supported: set Auto-Lock to Never'), fix: !S.wakeLock && 'wakeLock' in navigator ? 'wake' : null });
    // 6 sound and voice
    const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)) : [];
    rows.push({ name: 'Sound and voice', ok: !!(S.audio && S.audio.state === 'running') && voices.length > 0, warn: true, text: `${S.audio ? 'audio ' + S.audio.state : 'audio not started'}, ${voices.length} English voice${voices.length === 1 ? '' : 's'}`, fix: 'audio' });
    return rows;
  }
  async function renderReady() {
    const rows = await readyChecks();
    const dots = $('readyDots'); if (dots) dots.innerHTML = rows.map(r => `<span title="${r.name}: ${r.text}"><span class="rdot ${r.ok ? 'dot ok' : r.warn ? 'dot warn' : 'dot bad'}"></span>${r.name}</span>`).join('');
    const card = $('readyCard'); if (!card) return;
    card.innerHTML = `<div class="ready">${rows.map(r => `<span class="dot ${r.ok ? 'ok' : r.warn ? 'warn' : 'bad'}"></span><span><b>${r.name}</b>: ${r.text}</span><span>${r.fix ? `<button class="btn" data-fix="${r.fix}" style="padding:4px 8px">${{ preload: 'Preload', wx: 'Refresh', gps: 'Start GPS', wake: 'Retry', audio: 'Test', reload: 'Reload' }[r.fix]}</button>` : ''}</span>`).join('')}</div>`;
    card.querySelectorAll('button[data-fix]').forEach(b => b.addEventListener('click', async () => { const f = b.dataset.fix; if (f === 'preload') preload(true, true); else if (f === 'wx') await refreshWeather(true); else if (f === 'gps') { startGps(); } else if (f === 'wake') { await requestWakeLock(); if (!S.wakeLock) toast('Screen lock refused: disable Low Power Mode, or set Auto-Lock to Never'); } else if (f === 'audio') { ensureAudio(); alert('test', 'warn', 'Sound check. Ships come from your left.', {}); } else location.reload(); setTimeout(renderReady, 800); }));
  }
  // ---------- init ----------
  document.title = 'Saily · ' + (P.title || P.name);
  $('tzFrom').textContent = TZL_FROM; $('tzTo').textContent = TZL_TO;
  $('hudEtaLabel').textContent = 'ETA ' + DEST_NAME;
  document.title = P.title ? 'Saily · ' + P.title : 'Saily';
  $('startTitle').innerHTML = `<b>${esc(P.name)}</b>${P.description ? `<br><span class="muted small">${esc(P.description)}</span>` : ''}`;
  setNet(); renderWxOverlay(); renderSeaLine(); aisApply(); renderWxDot();
  if (!SINGLE) tryResume();
  renderReady();
  if (S.pos === null) { updateHudIdle(); }
  function updateHudIdle() {
    const w = WPS()[S.settings.wp];
    $('hudWpId').textContent = w.id; $('hudWpName').textContent = w.name;
    $('hudRoute').textContent = S.route.short || S.route.id;
    $('hudDtg').innerHTML = S.route.total + '<small> nm</small>';
  }
  window.SAILY = { S, map, processFix, startSim, stopSim, alert, preload, refreshWeather, onFix, wxVerdictNow, applyTheme, resolveTheme };
  } catch (err) {
    const o = document.getElementById('startOverlay');
    if (o) o.innerHTML = '<h1>Saily</h1><p><b>The app failed to start.</b></p><p class="muted">' + String(err && err.message || err) + '</p><button class="bigbtn" onclick="location.reload()">Reload</button>';
    throw err;
  }
})();
