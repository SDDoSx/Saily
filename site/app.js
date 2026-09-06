/* Saily app: GPS navigation, TSS/hazard alerts, weather, offline preload. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
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
  function fmtMA(d) { // Morocco time: device tz database by default; manual UTC offset override in Setup (Morocco moves to UTC+0 on 20 Sep 2026)
    const o = S.settings && S.settings.maOffset;
    if (o === undefined || o === 'auto') return N.fmtTime(d, TZ_MA);
    return N.fmtTime(new Date(d.getTime() + parseInt(o, 10) * 60000), 'UTC');
  }
  const bothTimes = d => `${N.fmtTime(d, TZ_ES)} ${TZL_FROM} · ${fmtMA(d)} ${TZL_TO}`;

  // ---------- state ----------
  const DEFAULTS = { speed: (P.vessel && P.vessel.cruiseKn) || 22, routeId: (P.routes.find(r => r.recommended) || P.routes[0]).id, departure: defaultDeparture(), voice: true, sound: true, th: Object.assign({}, W.DEFAULT_THRESHOLDS), base: 'carto', seamark: true, chartOnly: false, night: false, wp: 1, checklist: {}, maOffset: 'auto', autoZoom: true, aisOn: false, aisKey: '', aisDemo: true, depth: false };
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
    $('netText').textContent = on ? 'online' : 'OFFLINE';
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
  // speech queue with priorities: danger interrupts, info is dropped when the queue is busy
  const speech = { q: [], busy: false, timer: null };
  function speak(text, level) {
    if (S.muted || !S.settings.voice || !('speechSynthesis' in window)) return;
    const pr = level === 'danger' ? 2 : level === 'warn' ? 1 : 0;
    if (pr === 2) { speech.q = speech.q.filter(x => x.pr === 2); try { speechSynthesis.cancel(); } catch (e) { } speech.busy = false; }
    else if (speech.q.length >= 2) { if (pr === 0) return; speech.q = speech.q.filter(x => x.pr >= 1).slice(-1); }
    speech.q.push({ text, pr }); pumpSpeech();
  }
  function pumpSpeech() {
    if (speech.busy || !speech.q.length) return;
    const it = speech.q.shift();
    try {
      const u = new SpeechSynthesisUtterance(it.text); u.lang = 'en-GB'; u.rate = 1.0; u.volume = 1;
      const done = () => { clearTimeout(speech.timer); speech.busy = false; setTimeout(pumpSpeech, 150); };
      u.onend = done; u.onerror = done;
      speech.busy = true; clearTimeout(speech.timer); speech.timer = setTimeout(done, 4000 + it.text.length * 80); // Safari sometimes never fires onend
      speechSynthesis.speak(u);
    } catch (e) { speech.busy = false; }
  }
  let bannerTimer = null, bannerAt = 0;
  function showBanner(level, text, ms) {
    const b = $('alertBanner'); b.className = level; b.classList.remove('hidden');
    const m = /^(.*?[.!?])\s+(.*)$/s.exec(text); $('alertMain').textContent = m ? m[1] : text; $('alertRest').textContent = m ? m[2] : '';
    bannerAt = Date.now(); $('alertAge').textContent = '';
    clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  }
  setInterval(() => { if (!$('alertBanner').classList.contains('hidden') && bannerAt) { const m = Math.round((Date.now() - bannerAt) / 60000); $('alertAge').textContent = m >= 1 ? m + ' min ago' : ''; } }, 15000);
  $('alertBanner').addEventListener('click', e => { if (e.target.id === 'alertDismiss') $('alertBanner').classList.add('hidden'); else $('alertBanner').classList.toggle('expanded'); });
  /** level: info | warn | danger */
  function alert(id, level, text, opt) {
    opt = opt || {};
    const now = Date.now();
    if (opt.cooldown && S.alertLast[id] && now - S.alertLast[id] < opt.cooldown * 1000) return false;
    S.alertLast[id] = now; S.lastAlertText = text; S.lastAlertAt = now;
    S.log.unshift({ t: now, level, text }); if (S.log.length > 200) S.log.length = 200; saveJson(LOG_KEY, S.log);
    showBanner(level, text, level === 'danger' ? 0 : level === 'warn' ? 40000 : 15000);
    if (level === 'danger') beep(3, 880, 0.35); else if (level === 'warn') beep(2, 660, 0.2); else beep(1, 520, 0.12);
    if (opt.speak !== false) speak(text, level);
    try { if (navigator.vibrate) navigator.vibrate(level === 'danger' ? [300, 100, 300, 100, 300] : level === 'warn' ? [200, 100, 200] : 120); } catch (e) { }
    return true;
  }

  // ---------- wake lock ----------
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) { S.wakeLock = await navigator.wakeLock.request('screen'); S.wakeLock.addEventListener('release', () => { S.wakeLock = null; }); }
    } catch (e) { S.wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.started && !S.wakeLock) requestWakeLock();
    try { if (S.audio && S.audio.state === 'suspended') S.audio.resume(); } catch (e) { }
    S.lastFixAt = Date.now(); // grace period: no false 'GPS lost' right after coming back from background
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
    $('map').classList.toggle('night', !!S.settings.night);
    $('btnNight').classList.toggle('on', !!S.settings.night);
    document.body.classList.toggle('day', !!S.settings.day); $('btnDay').classList.toggle('on', !!S.settings.day);
  }
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
  $('btnZoomIn').addEventListener('click', () => { S.userZoomAt = Date.now(); map.zoomIn(); });
  $('btnZoomOut').addEventListener('click', () => { S.userZoomAt = Date.now(); map.zoomOut(); });
  $('btnFollow').addEventListener('click', () => { S.follow = !S.follow; $('btnFollow').classList.toggle('on', S.follow); if (S.follow && S.pos) map.panTo([S.pos.lat, S.pos.lon]); });
  $('btnRoute').addEventListener('click', () => { S.follow = false; $('btnFollow').classList.remove('on'); S.userZoomAt = Date.now(); map.fitBounds(S.route.waypoints.map(w => [w.lat, w.lon]), { padding: [30, 30] }); });
  $('btnLayers').addEventListener('click', () => { const order = ['carto', 'osm', 'sat']; S.settings.base = order[(order.indexOf(S.settings.base) + 1) % order.length]; S.settings.chartOnly = false; saveSettings(); applyBase(); toast('Base map: ' + { osm: 'OpenStreetMap', carto: 'CARTO light', sat: 'Satellite' }[S.settings.base]); });
  $('btnChartOnly').addEventListener('click', () => { S.settings.chartOnly = !S.settings.chartOnly; saveSettings(); applyBase(); toast(S.settings.chartOnly ? 'Vector chart only (works fully offline)' : 'Tiles on'); });
  $('btnNight').addEventListener('click', () => { S.settings.night = !S.settings.night; if (S.settings.night) S.settings.day = false; saveSettings(); applyBase(); });
  $('btnDay').addEventListener('click', () => { S.settings.day = !S.settings.day; if (S.settings.day) S.settings.night = false; saveSettings(); applyBase(); });
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
      else alert('gpserr', 'warn', 'GPS error: ' + err.message, { cooldown: 60 });
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
    S.smoother.push(sog, cog);
    S.sog = S.smoother.sog; S.cog = S.smoother.cog;
    S.pos = fix; S.acc = c.accuracy; S.lastFixAt = Date.now();
    if (S.gpsLost) { S.gpsLost = false; $('alertBanner').classList.add('hidden'); alert('gpsback', 'info', 'GPS signal back.'); }
    S.fixes.push(fix); if (S.fixes.length > 50) S.fixes.shift();
    tripUpdate(fix, prev);
    const last = S.track[S.track.length - 1];
    if (!last || N.distanceNm({ lat: last[0], lon: last[1] }, fix) > 0.01) { S.track.push([+fix.lat.toFixed(5), +fix.lon.toFixed(5), fix.t]); if (S.track.length > 4000) S.track.splice(0, 500); track.addLatLng([fix.lat, fix.lon]); }
    setGps(c.accuracy <= 50 ? 'ok' : c.accuracy <= 150 ? 'warn' : 'bad', (S.sim ? 'SIM ' : 'GPS ') + (c.accuracy ? '±' + Math.round(c.accuracy) + ' m' : ''));
    processFix();
  }
  setInterval(() => {
    if (S.navigating && !S.sim && S.watchId !== null && S.lastFixAt && Date.now() - S.lastFixAt > 25000) { S.gpsLost = true; setGps('bad', 'GPS lost'); alert('gpslost', 'danger', 'GPS signal lost. Check sky view.', { cooldown: 60 }); }
    if (S.track.length && !S.sim) saveJson(TRACK_KEY, S.track.slice(-3000));
  }, 5000);

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
    const arrived = sol.inRadius || (!S.manualWp && sol.passedPerp);
    if (S.navigating && arrived) {
      if (sol.k >= wps.length - 1) {
        if (!S.arrivedFinal) { S.arrivedFinal = true; alert('arrived', 'info', `Arrived at ${sol.wp.name}. ${sol.wp.note}`); }
      } else {
        S.settings.wp = sol.k + 1; S.manualWp = false; saveSettings(); S.approached = {};
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
    if (ttgAll === null) $('hudEta').textContent = '--:--';
    else { const eta = new Date(Date.now() + ttgAll * 1000); $('hudEta').innerHTML = N.fmtTime(eta, TZ_ES) + (sp.plan ? '*' : '') + '<small> ' + TZL_FROM + '</small><br><small>' + fmtMA(eta) + ' ' + TZL_TO + '</small>'; }
    $('hudDtg').innerHTML = N.fmtNm(sol.remaining, 1) + '<small> nm</small><br><small>' + N.fmtDur(ttgAll) + (sp.plan ? '*' : '') + '</small>';
    $('hudPos').textContent = N.fmtDM(S.pos.lat, S.pos.lon);
    $('hudAcc').textContent = sp.plan ? '* at plan speed ' + S.settings.speed + ' kn' : '';
    $('hudSim').textContent = S.sim ? 'SIMULATION' : '';
    $('hudRoute').textContent = S.route.short || S.route.id;
    const wxp = W.nearestPoint(S.wx, S.pos); const row = wxp ? W.rowAt(wxp, new Date()) : null;
    $('hudWx').textContent = row ? `wind ${Math.round(row.wind)}${row.gust ? '/' + Math.round(row.gust) : ''} kn ${N.compass16(row.windDir)} · sea ${row.wave != null ? row.wave.toFixed(1) + ' m' : '--'}${row.current != null ? ' · cur ' + row.current.toFixed(1) + ' kn ' + N.compass16(row.currentDir) : ''}` : '';
  }
  function renderPhase(sol) {
    const el = $('hudPhase');
    if (S.mob) { el.classList.remove('hidden'); el.innerHTML = `<b>MAN OVERBOARD</b> marked ${N.fmtTime(new Date(S.mob.t), TZ_ES)} · steer <b>${N.fmtBrg(N.bearingDeg(S.pos, S.mob))}</b> · ${N.fmtNm(N.distanceNm(S.pos, S.mob))} nm · ${N.fmtDM(S.mob.lat, S.mob.lon)}`; return; }
    const lanes = C.tss.lanes.filter(l => S.zone[l.id]); const zones = C.tss.zones.filter(z => S.zone[z.id]);
    if (lanes.length || zones.length) {
      // distance to clear all TSS polygons along the current leg: walk the leg from here
      let clear = null;
      if (S.cog !== null) { for (let d = 0.1; d <= 8; d += 0.1) { const q = N.destination(S.pos, sol.legBrg, d); const inside = [].concat(C.tss.lanes, C.tss.zones).some(z => N.pointInRings(q, z.rings)); if (!inside) { clear = d; break; } } }
      const flow = lanes.length ? (lanes[0].flow === 'W' ? 270 : 90) : null;
      const target = flow === null ? sol.legBrg : (Math.abs(N.angleDiff(sol.legBrg, flow + 90)) < 90 ? N.norm360(flow + 90) : N.norm360(flow - 90));
      const err = S.cog === null ? null : Math.round(N.angleDiff(S.cog, target));
      const from = lanes.length ? (lanes[0].flow === 'W' ? 'east' : 'west') : null;
      const side = from && S.cog !== null ? (N.angleDiff(from === 'east' ? 90 : 270, S.cog) > 0 ? 'RIGHT' : 'LEFT') : null;
      el.classList.remove('hidden');
      const ships = window.AIS && AIS.targets.size ? AIS.ranked().filter(x => x.c && x.c.range < 6).slice(0, 2).map(x => `${x.t.name || x.t.mmsi} ${N.fmtNm(x.c.range)} nm ${N.compass16(x.c.brg)}${x.c.tcpa !== null && x.c.tcpa > 0 ? ', CPA ' + N.fmtNm(x.c.cpa) + ' in ' + Math.round(x.c.tcpa) + ' min' : ''}`).join(' · ') : '';
      el.innerHTML = (ships ? `<div style="margin-bottom:4px">🚢 ${ships}</div>` : '') + `<b>${lanes.length ? (lanes[0].flow === 'W' ? 'WESTBOUND LANE' : 'EASTBOUND LANE') : 'SEPARATION ZONE'}</b>${side ? ' · ships from your <b>' + side + '</b> (' + from + ')' : ''} · cross on <b>${N.fmtBrg(target)}</b>${err !== null ? ' (' + (err > 0 ? '+' : '') + err + '°)' : ''}${clear !== null ? ' · clear in <b>' + N.fmtNm(clear) + ' nm</b>' + (S.sog > 3 ? ' / ' + Math.round(clear / S.sog * 60) + ' min' : '') : ''}`;
      return;
    }
    const prec = C.tss.precautionary.filter(z => S.zone[z.id]);
    if (prec.length) { el.classList.remove('hidden'); el.innerHTML = `<b>PRECAUTIONARY AREA</b> · converging ships, keep a sharp lookout`; return; }
    if (sol.dist < 0.6 && sol.k >= WPS().length - 2) { el.classList.remove('hidden'); el.innerHTML = `<b>HARBOUR APPROACH</b> · ${sol.wp.note}`; return; }
    el.classList.add('hidden');
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
    mobLine.addTo(map); $('btnMob').classList.add('active'); $('btnMob').textContent = 'Cancel MOB';
    S.follow = true; $('btnFollow').classList.add('on');
    alert('mob', 'danger', `MAN OVERBOARD. Position marked at ${N.fmtDM(S.mob.lat, S.mob.lon)}. Turn back now.`);
    mobTimer = setInterval(() => { if (!S.mob || !S.pos) return; const b = N.bearingDeg(S.pos, S.mob), d = N.distanceNm(S.pos, S.mob); speak(`Man overboard bearing ${N.fmtBrg(b).replace('°', '')}, ${d < 0.1 ? Math.round(d * 1852) + ' metres' : N.fmtNm(d) + ' miles'}.`, 'danger'); }, 20000);
    if (S.pos) processFix();
  }
  function markPosition() {
    if (!S.pos) { toast('No position yet'); return; }
    const m = { n: S.marks.length + 1, lat: S.pos.lat, lon: S.pos.lon, t: Date.now() }; S.marks.push(m);
    L.marker([m.lat, m.lon], { pane: 'aids', icon: L.divIcon({ className: '', html: '<div class="usermark" title="Mark ' + m.n + '"></div>', iconSize: [0, 0] }) }).bindPopup(`<b>Mark ${m.n}</b>${N.fmtDM(m.lat, m.lon)}<br>${N.fmtTime(new Date(m.t), TZ_ES)} ${TZL_FROM}`).addTo(map);
    alert('mark' + m.n, 'info', `Mark ${m.n} at ${N.fmtDM(m.lat, m.lon)}.`);
    saveJson('saily.marks.v1', S.marks);
  }
  function repeatLast() { ensureAudio(); if (!S.lastAlertText) { toast('Nothing to repeat'); return; } showBanner('info', S.lastAlertText, 15000); speak(S.lastAlertText, 'warn'); }
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
  $('btnMob').addEventListener('click', mobToggle);
  $('btnMark').addEventListener('click', markPosition);
  $('btnRepeat').addEventListener('click', repeatLast);
  $('hudPos').addEventListener('click', showBigPos);
  $('btnClosePos').addEventListener('click', () => $('bigpos').classList.add('hidden'));
  $('btnSayPos').addEventListener('click', sayPosition);

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
    const label = `${t.name || t.mmsi}${t.sog != null ? ' ' + t.sog.toFixed(0) + ' kn' : ''}`;
    const popup = `<b>${t.name || 'MMSI ' + t.mmsi}</b>${AIS.typeName(t.type) || 'ship'} · COG ${N.fmtBrg(t.cog)} · ${t.sog != null ? t.sog.toFixed(1) : '--'} kn${c ? '<br>range ' + N.fmtNm(c.range) + ' nm, bearing ' + N.fmtBrg(c.brg) + (c.tcpa !== null && c.tcpa > 0 ? '<br>CPA ' + N.fmtNm(c.cpa) + ' nm in ' + Math.round(c.tcpa) + ' min' : '<br>opening') : ''}<br>${Math.round((Date.now() - t.t) / 1000)} s ago`;
    if (!m) { m = L.marker([t.lat, t.lon], { pane: 'vessel', icon: aisIcon(t, risk) }).bindPopup(popup).bindTooltip(label, { permanent: true, direction: 'right', offset: [10, 0], className: 'aislabel' }); aisGroup.addLayer(m); aisMarkers.set(t.mmsi, m); }
    else { m.setLatLng([t.lat, t.lon]); m.setIcon(aisIcon(t, risk)); m.getPopup().setContent(popup); m.setTooltipContent(label); }
  }
  function aisTick() {
    if (!window.AIS) return;
    AIS.own = S.pos ? { lat: S.pos.lat, lon: S.pos.lon, cog: S.cog, sog: S.sog } : null;
    AIS.prune();
    for (const [mmsi, m] of aisMarkers) if (!AIS.targets.has(mmsi)) { aisGroup.removeLayer(m); aisMarkers.delete(mmsi); }
    if (Date.now() - (S.aisDrawAt || 0) > 5000) { S.aisDrawAt = Date.now(); for (const t of AIS.targets.values()) aisDraw(t); }
  }
  function aisAlarm(t, c) {
    const rel = S.cog === null ? '' : (() => { const d = N.angleDiff(c.brg, S.cog); return Math.abs(d) < 30 ? 'ahead' : Math.abs(d) > 150 ? 'astern' : d > 0 ? 'on your RIGHT' : 'on your LEFT'; })();
    alert('ais-' + t.mmsi, 'danger', `Ship ${t.name || ''} ${rel}, ${N.fmtNm(c.range)} miles, bearing ${N.fmtBrg(c.brg)}, closest approach ${N.fmtNm(c.cpa)} miles in ${Math.round(c.tcpa)} minutes. Watch it.`);
  }
  function aisApply() {
    if (!window.AIS) return;
    AIS.onUpdate = aisDraw; AIS.onAlarm = aisAlarm;
    const key = (S.settings.aisKey || '').trim();
    if (S.settings.aisOn && key && !S.sim) AIS.connect(key, P.bbox); else AIS.disconnect();
  }
  function aisStatusText() { if (!window.AIS) return 'module missing'; const n = AIS.targets.size; return `${AIS.status}${n ? ', ' + n + ' targets' : ''}${AIS.lastMsgAt ? ', last message ' + Math.round((Date.now() - AIS.lastMsgAt) / 1000) + ' s ago' : ''}`; }
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
      alert('xte', 'warn', away ? `Off track ${N.fmtNm(ax)} miles and heading away from the route. Come round to ${N.fmtBrg(sol.brg)}.` : `Off track ${N.fmtNm(ax)} miles. ${dir ? 'Steer ' + dir + ' to ' : 'Hold '}${N.fmtBrg(sol.brg)}.`, { cooldown: 90 });
    }
    if (sol.legDist >= 0.6 && sol.dist < Math.max(0.5, sol.wp.radius * 3) && !S.approached[sol.k] && sol.k < WPS().length - 1) {
      S.approached[sol.k] = true;
      const nb = N.bearingDeg(sol.wp, WPS()[sol.k + 1]);
      alert('appr' + sol.k, 'info', `Waypoint ${sol.wp.id} in ${N.fmtNm(sol.dist)} miles. Next course ${N.fmtBrg(nb)}.`);
    }
    // in-lane heading check
    for (const l of C.tss.lanes) {
      if (S.zone[l.id] && S.cog !== null && S.sog !== null && S.sog > 3) {
        const flow = l.flow === 'W' ? 270 : 90;
        const dev = Math.min(Math.abs(N.angleDiff(S.cog, flow + 90)), Math.abs(N.angleDiff(S.cog, flow - 90)));
        if (dev > 35) alert('lanehdg', 'warn', `Cross the lane at right angles: steer ${Math.abs(N.angleDiff(S.cog, 180)) < 90 ? '180' : '000'}. You are ${Math.round(dev)} degrees off.`, { cooldown: 60 });
      }
    }
  }
  const ZONE_TEXT = {
    west_wb: ['danger', 'Entering the WESTBOUND traffic lane. Ships come from your LEFT, from the east. Keep crossing at right angles, do not slow down.', 'Clear of the westbound lane.'],
    west_eb: ['danger', 'Entering the EASTBOUND traffic lane. Ships come from your RIGHT, from the west. Keep crossing at right angles.', 'Clear of the eastbound lane.'],
    east_wb: ['danger', 'Entering the WESTBOUND traffic lane (east part). Ships come from the east. Cross at right angles.', 'Clear of the westbound lane.'],
    east_eb: ['danger', 'Entering the EASTBOUND traffic lane (east part). Ships come from the west. Cross at right angles.', 'Clear of the eastbound lane.'],
    zone_b: ['warn', 'In the separation zone. Keep crossing, do not linger.', null],
    zone_a: ['warn', 'In the separation zone. Keep crossing, do not linger.', null],
    prec_east: ['warn', 'Entering the precautionary area. Ships converge from Algeciras, Gibraltar, Ceuta and Tanger-Med. Sharp lookout.', 'Leaving the precautionary area.'],
    prec_tm: ['warn', 'Entering the Tanger-Med precautionary area. Ships turning into and out of the port.', 'Leaving the precautionary area.'],
    itz_n: ['info', 'In the Spanish inshore traffic zone. Stay north of the lanes.', 'Leaving the Spanish inshore zone.'],
    itz_se: ['info', 'In the south-eastern inshore zone (Morocco).', null],
    itz_sw: ['info', 'In the Moroccan inshore traffic zone. Follow the coast to Tangier.', 'Leaving the Moroccan inshore zone.'],
    free_tm: ['warn', 'Off Tanger-Med: ferries and container ships manoeuvring. Keep clear of the port approaches.', 'Clear of the Tanger-Med approaches.'],
  };
  function checkZones(pos, sol) {
    const all = [].concat(C.tss.itz, C.tss.free, C.tss.precautionary, C.tss.zones, C.tss.lanes);
    for (const z of all) {
      const inside = N.pointInRings(pos, z.rings);
      const was = !!S.zone[z.id];
      if (inside !== was) {
        S.zone[z.id] = inside;
        const t = ZONE_TEXT[z.id]; if (!t) continue;
        if (inside && z.flow) { // traffic lane: say which side the ships come from relative to our heading
          const from = z.flow === 'W' ? 90 : 270, fromName = z.flow === 'W' ? 'east' : 'west';
          const side = S.cog === null ? (z.flow === 'W' ? 'LEFT' : 'RIGHT') : (N.angleDiff(from, S.cog) > 0 ? 'RIGHT' : 'LEFT');
          alert('zone-' + z.id, 'danger', `Entering the ${z.flow === 'W' ? 'WESTBOUND' : 'EASTBOUND'} traffic lane. Ships come from your ${side}, from the ${fromName}. Keep crossing at right angles, do not slow down.`, { cooldown: 30 });
        }
        else if (inside) alert('zone-' + z.id, t[0], t[1], { cooldown: 30 });
        else if (t[2]) alert('zoneout-' + z.id, 'info', t[2], { cooldown: 30 });
      }
    }
  }
  function checkHazards(pos) {
    S.hazardNear = S.hazardNear || {};
    for (const h of (S.dangers || P.hazards)) {
      const d = N.distanceNm(pos, h);
      const inside = d < h.radius;
      const was = !!S.hazard[h.id];
      if (inside && !was) alert('haz-' + h.id, h.level === 'danger' ? 'danger' : h.level === 'caution' ? 'warn' : 'info', `${h.level === 'danger' ? 'DANGER' : 'Caution'}: ${h.name}. ${h.note}`, { cooldown: 120 });
      else if (!inside && h.level === 'danger' && d < h.radius + 0.15 && !S.hazardNear[h.id]) {
        S.hazardNear[h.id] = true;
        alert('hazn-' + h.id, 'warn', `${h.name}: ${N.fmtNm(d)} miles to the ${N.compass16(N.bearingDeg(pos, h))}.`, { cooldown: 120 });
      }
      if (d > h.radius + 0.4) S.hazardNear[h.id] = false;
      S.hazard[h.id] = inside;
    }
  }
  function landAt(q) { return C.land.some(r => N.pointInRing(q, r)); }
  function checkLandAhead(pos) {
    if (S.cog === null || S.sog === null || S.sog < 1.5) return;
    const nearHarbour = Object.values(P.places).some(pl => N.distanceNm(pos, pl) < 0.2);
    const look = nearHarbour || S.sog < 4 ? 0.08 : Math.min(1.5, Math.max(0.2, S.sog * 4 / 60)); // 4 minutes ahead at sea, 150 m in harbour
    for (let d = 0.04; d <= look; d += 0.04) {
      const q = N.destination(pos, S.cog, d);
      if (landAt(q)) { alert('landahead', 'danger', `Land or rocks ahead, ${d < 0.1 ? Math.round(d * 1852) + ' metres' : N.fmtNm(d) + ' miles'} on this heading. Alter course.`, { cooldown: 30 }); return; }
    }
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
    if (v.level !== 'ok') { S.lastWxAlert = Date.now(); alert('wxnow', v.level === 'nogo' ? 'danger' : 'warn', `Weather ${v.level === 'nogo' ? 'danger' : 'caution'} near ${pt.name}: ${v.reasons.join(', ')}.`); }
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
    let t = Date.now(); let phase = 0;
    S.sim = setInterval(() => {
      const now = Date.now(); const dt = (now - t) / 1000; t = now; phase += dt;
      const sol = N.solve(cur, wps, S.settings.wp);
      const spd = S.settings.speed * (0.92 + 0.08 * Math.sin(phase / 7));
      const hdg = sol.brg + 6 * Math.sin(phase / 25); // weave to exercise XTE
      cur = N.destination(cur, hdg, spd * dt / 3600 * 20); // 20x real time
      onFix({ coords: { latitude: cur.lat + (Math.random() - .5) * 2e-5, longitude: cur.lon + (Math.random() - .5) * 2e-5, accuracy: 8, speed: spd / MS_TO_KN, heading: N.norm360(hdg) }, timestamp: now });
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
    if (mode === 'nav') { S.navigating = true; if (!S.trip) { S.trip = loadJson('saily.trip.v1', null); if (!S.trip || Date.now() - S.trip.startedAt > 12 * 3600000) S.trip = { startedAt: Date.now(), dist: 0, maxSog: 0, n: 0 }; } startGps(); speak('Navigation started. Route ' + (S.route.short || S.route.id) + '.', 'info'); }
    else if (mode === 'sim') { S.navigating = true; startSim(S.settings.wp); }
    else { S.navigating = false; startGps(); }
    renderMore();
  }
  $('btnStart').addEventListener('click', () => begin('nav'));
  $('btnPlanOnly').addEventListener('click', () => begin('look'));
  $('btnStartSim').addEventListener('click', () => begin('sim'));
  function setWp(k, why) {
    const before = S.settings.wp; S.settings.wp = Math.max(1, Math.min(WPS().length - 1, k)); S.manualWp = true; S.approached = {}; S.arrivedFinal = false; saveSettings(); drawRoutes(); if (S.pos) processFix();
    toast((why || 'Active waypoint') + ': ' + WPS()[S.settings.wp].id, 6000, { label: 'Undo', fn: () => { S.settings.wp = before; S.manualWp = true; saveSettings(); drawRoutes(); if (S.pos) processFix(); } });
  }
  $('btnPrevWp').addEventListener('click', () => setWp(S.settings.wp - 1, 'Back to'));
  $('btnNextWp').addEventListener('click', () => setWp(S.settings.wp + 1, 'Skipped to'));
  $('btnMute').addEventListener('click', () => { S.muted = !S.muted; $('btnMute').textContent = S.muted ? '🔇' : '🔊'; if (S.muted) try { speechSynthesis.cancel(); } catch (e) { } });
  $('startInfo').textContent = `${S.route.total} nm · about ${N.fmtDur(S.route.total / S.settings.speed * 3600)} at ${S.settings.speed} kn · planned departure ${bothTimes(new Date(S.settings.departure))}`;

  // ---------- weather ----------
  async function refreshWeather(force) {
    if (SINGLE && !navigator.onLine) { toast('Offline: using embedded forecast'); return; }
    if (!navigator.onLine) { toast('Offline: using stored forecast'); return; }
    if (!force && S.wx && Date.now() - S.wx.fetchedAt < 20 * 60000) return;
    toast('Fetching forecast…');
    try {
      const d = await W.fetchAll(3, null, S.wx);
      if (Object.keys(d.points).length) { S.wx = d; toast(d.stale ? 'Offline: showing the stored forecast' : 'Forecast updated' + (d.errors.length ? ' (some points kept from the previous fetch)' : '')); }
      else toast('Forecast fetch failed');
    } catch (e) { toast('Forecast fetch failed: ' + e.message); }
    if ($('view-wx').classList.contains('active')) renderWx();
    if (S.solution) updateHud(S.solution);
    renderWxOverlay(); renderSeaLine();
  }
  const arrow = deg => `<span class="arrow" style="transform:rotate(${(deg || 0) + 90}deg)">➤</span>`; // wind FROM d blows towards d+180; glyph points east (090)
  const arrowTo = deg => `<span class="arrow" style="transform:rotate(${(deg || 0) - 90}deg)">➤</span>`;
  const tagFor = v => v ? `<span class="tag ${v.level}">${v.level === 'nogo' ? 'NO-GO' : v.level.toUpperCase()}</span>` : '<span class="tag na">no data</span>';
  function renderWx() {
    const el = $('wxPage'); const d = S.wx;
    const age = d ? Math.round((Date.now() - d.fetchedAt) / 60000) : null;
    let h = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Forecast along the route</h2><button class="btn" id="btnWxRefresh">Refresh</button></div>
      <p class="muted">${d ? `Open-Meteo, fetched ${age} min ago (${N.fmtTime(new Date(d.fetchedAt), TZ_ES)} ES).` : 'No forecast stored yet. Go online and tap Refresh.'} Wind at 10 m in knots, waves = significant height, current = surface (includes tide). Thresholds in Setup.</p></div>`;
    if (d) {
      const dep = new Date(S.settings.departure);
      const pass = W.passage(d, dep, S.settings.speed, S.settings.th);
      const ov = W.overall(pass);
      h += `<div class="card"><h2>Passage check: depart ${bothTimes(dep)} at ${S.settings.speed} kn ${tagFor(ov)}</h2>`;
      h += ov.reasons.length ? `<ul>${ov.reasons.map(r => `<li>${r}</li>`).join('')}</ul>` : '<p>No thresholds exceeded at any route point during the planned passage.</p>';
      h += `<div class="tbl"><table><tr><th>Point</th><th>Pass at</th><th>Wind</th><th>Gust</th><th>Waves</th><th>Swell</th><th>Current</th><th>Wind/cur</th><th>Vis</th><th></th></tr>`;
      for (const s of pass) {
        const r = s.row;
        h += `<tr class="${s.verdict ? s.verdict.level : ''}"><td>${s.point.name}</td><td>${N.fmtTime(s.when, TZ_ES)}</td>` + (r ? `<td>${Math.round(r.wind)} kn ${N.compass16(r.windDir)} ${arrow(r.windDir)}</td><td>${Math.round(r.gust)}</td><td>${r.wave != null ? r.wave.toFixed(1) + ' m ' + Math.round(r.wavePeriod) + 's' : '--'}</td><td>${r.swell != null ? r.swell.toFixed(1) + ' m ' + N.compass16(r.swellDir) : '--'}</td><td>${r.current != null ? r.current.toFixed(1) + ' kn ' + arrowTo(r.currentDir) + ' ' + N.compass16(r.currentDir) : '--'}</td><td>${r.current != null && r.current >= 0.8 ? N.windVsCurrent(r.windDir, r.currentDir) : '-'}</td><td>${r.vis != null ? (r.vis / 1000).toFixed(0) + ' km' : '--'}</td><td>${tagFor(s.verdict)}</td>` : '<td colspan="8">no data for this hour</td>') + '</tr>';
      }
      h += '</table></div></div>';
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
    el.innerHTML = h;
    $('btnWxRefresh').addEventListener('click', () => refreshWeather(true));
    const s = $('wxSel'); if (s) s.addEventListener('change', () => { S.wxSel = s.value; renderWx(); });
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
      <div class="kv"><div>Distance</div><div>${r.total} nm</div><div>At ${sp} kn</div><div>${N.fmtDur(r.total / sp * 3600)}</div><div>Departure</div><div>${bothTimes(dep)} · ${dep.toDateString()}</div><div>ETA Tangier</div><div>${bothTimes(new Date(dep.getTime() + r.total / sp * 3600000))}</div><div>Fuel estimate</div><div>${Math.round(r.total / sp * (P.vessel.burnLph || 75))} L at a planning burn of ${P.vessel.burnLph || 75} L/h (${P.vessel.name || 'planning figure'}; tanks ${P.vessel.fuelL || '?'} L). Leave with full tanks.</div></div></div>`;
    h += `<div class="card"><h2>Legs</h2><div class="tbl"><table><tr><th>#</th><th>From</th><th>To</th><th>Course</th><th>Dist</th><th>Leg</th><th>ETA (ES)</th></tr>`;
    r.legs.forEach((l, i) => { cum += l.dist; h += `<tr><td>${i + 1}</td><td>${l.from}</td><td>${l.to}</td><td>${N.fmtBrg(l.brg)}</td><td>${l.dist.toFixed(1)}</td><td>${N.fmtDur(l.dist / sp * 3600)}</td><td>${N.fmtTime(new Date(dep.getTime() + cum / sp * 3600000), TZ_ES)}</td></tr>`; });
    h += `</table></div><p class="muted">Courses are true. Apply your compass variation (about 1° W here) and deviation if steering by compass.</p></div>`;
    h += `<div class="card"><h2>Waypoints</h2><div class="tbl"><table><tr><th>ID</th><th>Position</th><th>Note</th></tr>${r.waypoints.map(w => `<tr><td><b>${w.id}</b><br><span class="muted">${w.name}</span></td><td>${N.fmtDM(w.lat, w.lon)}<br><span class="muted">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span></td><td style="white-space:normal;min-width:220px">${w.note}</td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:8px">${SINGLE ? '' : `<a class="btn" id="gpxLink" download="saily-${r.id}.gpx">Download GPX for the plotter</a>`}<button class="btn" id="btnCopyWp">Copy waypoints (ID, lat/lon)</button></div></div>`;
    for (const c of (P.cards || [])) h += c.html;
    h += `<div class="card"><h2>Departure checklist</h2><div class="check">${CHECKLIST.map((c, i) => `<label><input type="checkbox" data-ck="${i}" ${S.settings.checklist[i] ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></div>`;
    const sun = N.sunTimes(new Date(), P.sun.lat, P.sun.lon);
    h += `<div class="card"><h2>Daylight today</h2><p>Sunrise ${sun.sunrise ? bothTimes(sun.sunrise) : '--'} · Sunset ${sun.sunset ? bothTimes(sun.sunset) : '--'} at Tangier. Plan to be berthed with daylight to spare: the marina entrance and the port traffic are much harder at night.</p></div>`;
    el.innerHTML = h;
    el.querySelectorAll('input[name=route]').forEach(i => i.addEventListener('change', () => { S.settings.routeId = i.value; S.settings.wp = 1; saveSettings(); S.route = P.routes.find(x => x.id === i.value); S.zone = {}; S.approached = {}; drawRoutes(); renderPlan(); if (S.pos) processFix(); }));
    if ($('gpxLink')) $('gpxLink').href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(N.toGPX('Saily ' + r.id, r.waypoints));
    $('btnCopyWp').addEventListener('click', async () => { const txt = r.waypoints.map(w => `${w.id}\t${N.fmtDM(w.lat, w.lon)}\t${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`).join('\n'); try { await navigator.clipboard.writeText(txt); toast('Copied'); } catch (e) { toast('Copy failed'); } });
    el.querySelectorAll('input[data-ck]').forEach(i => i.addEventListener('change', () => { S.settings.checklist[i.dataset.ck] = i.checked; saveSettings(); }));
  }
  const CHECKLIST = P.checklist || [];

  // ---------- setup / more ----------
  function renderMore() {
    const el = $('morePage'); const s = S.settings;
    let h = `<div class="card"><h2>Passage settings</h2>
      <label class="field"><span>Planned cruise speed (kn)</span><input type="number" id="setSpeed" min="5" max="40" step="1" value="${s.speed}"></label>
      <label class="field"><span>Planned departure (Spain time)</span><input type="datetime-local" id="setDep" value="${toLocalInput(TZ_ES, new Date(s.departure))}"></label>
      <label class="field"><span>Route</span><select id="setRoute">${P.routes.map(r => `<option value="${r.id}" ${r.id === s.routeId ? 'selected' : ''}>${r.recommended ? 'Recommended' : 'Alternative'} (${r.short || r.id})</option>`).join('')}</select></label>
      <label class="field"><span>Auto-zoom the chart to the next waypoint</span><input type="checkbox" id="setAutoZoom" ${s.autoZoom !== false ? 'checked' : ''}></label>
      <label class="field"><span>Spoken alerts</span><input type="checkbox" id="setVoice" ${s.voice ? 'checked' : ''}></label>
      <label class="field"><span>Alert beeps</span><input type="checkbox" id="setSound" ${s.sound ? 'checked' : ''}></label>
      <label class="field"><span>OpenSeaMap buoys/lights overlay</span><input type="checkbox" id="setSeamark" ${s.seamark ? 'checked' : ''}></label>
      <label class="field"><span>Morocco clock (MA)</span><select id="setMa"><option value="auto" ${s.maOffset === 'auto' ? 'selected' : ''}>Automatic (phone time zone data)</option><option value="60" ${s.maOffset === '60' ? 'selected' : ''}>UTC+1 (until 20 Sep 2026)</option><option value="0" ${s.maOffset === '0' ? 'selected' : ''}>UTC+0 (from 20 Sep 2026)</option></select></label>
      <div class="row" style="margin-top:8px"><button class="btn" id="btnTestAlert">Test alert</button><button class="btn" id="btnResetWp">Restart route from WP 1</button></div></div>`;
    h += `<div class="card"><h2>Ships (AIS)</h2><p class="muted">Live ship positions need an AIS feed. No public feed covers the Strait of Gibraltar without an account: <b>aisstream.io</b> gives a free key (sign in with GitHub, no payment). Paste it here and the app streams ships in the passage area, draws them with their course, computes closest point of approach (CPA) and time to it (TCPA), and raises a danger alert when a ship will pass within 0.5 nm in the next 12 minutes. Coverage comes from volunteer shore receivers: not every ship, and up to a minute late. The demo simulation shows three synthetic ships so you can see how it looks.</p>
      <label class="field"><span>Enable AIS targets</span><input type="checkbox" id="setAisOn" ${s.aisOn ? 'checked' : ''}></label>
      <label class="field"><span>aisstream.io API key</span><input type="password" id="setAisKey" value="${(s.aisKey || '').replace(/"/g, '&quot;')}" placeholder="paste key" autocomplete="off"></label>
      <label class="field"><span>Show demo ships in the simulation</span><input type="checkbox" id="setAisDemo" ${s.aisDemo !== false ? 'checked' : ''}></label>
      <div class="muted">Status: <span id="aisStatus">${aisStatusText()}</span></div></div>`;
    h += `<div class="card"><h2>Chart layers</h2>
      <label class="field"><span>Depth shading and contours (EMODnet, online only)</span><input type="checkbox" id="setDepth" ${s.depth ? 'checked' : ''}></label>
      <p class="muted">EMODnet bathymetry is a gridded model (about 100 m cells), fine for seeing banks and the shelf, not for the last metres in a harbour. Charted rocks, wrecks and obstructions from OpenStreetMap are drawn as red asterisks with a 0.1 nm alarm circle; the app also warns when land or rocks lie on your heading within four minutes at your speed.</p></div>`;
    h += `<div class="card"><h2>Weather thresholds</h2>
      <label class="field"><span>Wind caution / no-go (kn)</span><span class="row"><input type="number" id="thWindC" value="${s.th.windCaution}" style="width:70px"><input type="number" id="thWindN" value="${s.th.windNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Gust caution / no-go (kn)</span><span class="row"><input type="number" id="thGustC" value="${s.th.gustCaution}" style="width:70px"><input type="number" id="thGustN" value="${s.th.gustNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Wave caution / no-go (m)</span><span class="row"><input type="number" step="0.1" id="thWaveC" value="${s.th.waveCaution}" style="width:70px"><input type="number" step="0.1" id="thWaveN" value="${s.th.waveNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Current caution (kn)</span><input type="number" step="0.1" id="thCur" value="${s.th.currentCaution}" style="width:70px"></label></div>`;
    h += `<div class="card"><h2>Preload for offline use</h2><p class="muted">Do this on wifi before leaving. Stores the app, the 3-day forecast and map tiles for the whole route (about 15 to 40 MB). The vector chart, route, TSS and hazards are built in and always work offline.</p>
      <div class="row"><button class="btn primary" id="btnPreloadAll">Preload everything</button><button class="btn" id="btnPreloadWx">Forecast only</button><button class="btn" id="btnPreloadTiles">Map tiles only</button></div>
      <div class="progress"><div id="preProg"></div></div><div id="preText" class="muted">${preloadStatusText()}</div><div id="storeText" class="muted"></div></div>`;
    h += `<div class="card"><h2>Status</h2><div class="kv"><div>Service worker</div><div id="swText">${SINGLE ? 'single-file build: no service worker (save the page or add to Home Screen; the chart, route and hazards are built in)' : (navigator.serviceWorker && navigator.serviceWorker.controller ? 'active (offline ready)' : 'not yet active: reload once online')}</div><div>Wake lock</div><div>${S.wakeLock ? 'held (screen stays on)' : ('wakeLock' in navigator ? 'not held' : 'not supported: disable auto-lock in iPhone Settings, Display')}</div><div>Install</div><div>iPhone: Safari share button, "Add to Home Screen". Mac: Safari File menu, "Add to Dock". Then open it from the icon and run the preload THERE: the Home Screen app has its own storage, separate from Safari's.</div><div>Simulation</div><div class="row"><button class="btn" id="btnSim">${S.sim ? 'Stop simulation' : 'Start simulation (demo)'}</button></div></div></div>`;
    h += `<div class="card"><h2>Alert log</h2><div class="log">${S.log.slice(0, 40).map(l => `${N.fmtTime(new Date(l.t), TZ_ES)} [${l.level}] ${l.text}`).join('\n') || 'none yet'}</div><div class="row" style="margin-top:8px"><button class="btn" id="btnClearLog">Clear log</button><button class="btn" id="btnClearTrack">Clear track</button><button class="btn danger" id="btnReset">Reset app data</button></div></div>`;
    h += `<div class="card"><h2>About</h2><p class="muted">Saily is a temporary passage aid built for one crossing. Data: ${C.meta.sources.join('; ')}. Weather: Open-Meteo (CC BY 4.0). Map tiles: OpenStreetMap, CARTO, Esri, OpenSeaMap. Positions from the phone GPS (WGS84). Not for navigation without official charts, a proper lookout and COLREGs.</p></div>`;
    el.innerHTML = h;
    const num = (id, f) => $(id).addEventListener('change', () => { const v = parseFloat($(id).value); if (isFinite(v)) { f(v); saveSettings(); if (S.solution) updateHud(S.solution); } });
    num('setSpeed', v => { s.speed = v; });
    $('setDep').addEventListener('change', () => { try { s.departure = fromLocal(TZ_ES, $('setDep').value).toISOString(); saveSettings(); } catch (e) { } });
    $('setRoute').addEventListener('change', () => { s.routeId = $('setRoute').value; s.wp = 1; S.route = P.routes.find(x => x.id === s.routeId); S.zone = {}; S.approached = {}; saveSettings(); drawRoutes(); if (S.pos) processFix(); });
    $('setVoice').addEventListener('change', () => { s.voice = $('setVoice').checked; saveSettings(); });
    $('setAutoZoom').addEventListener('change', () => { s.autoZoom = $('setAutoZoom').checked; saveSettings(); });
    $('setAisOn').addEventListener('change', () => { s.aisOn = $('setAisOn').checked; saveSettings(); aisApply(); setTimeout(() => { const el = $('aisStatus'); if (el) el.textContent = aisStatusText(); }, 1500); });
    $('setAisKey').addEventListener('change', () => { s.aisKey = $('setAisKey').value.trim(); saveSettings(); aisApply(); });
    $('setAisDemo').addEventListener('change', () => { s.aisDemo = $('setAisDemo').checked; saveSettings(); });
    $('setDepth').addEventListener('change', () => { s.depth = $('setDepth').checked; saveSettings(); applyBase(); });
    if (!S.aisStatusTimer) S.aisStatusTimer = setInterval(() => { const el = $('aisStatus'); if (el) el.textContent = aisStatusText(); }, 5000);
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
    $('btnClearTrack').addEventListener('click', () => { S.track = []; track.setLatLngs([]); saveJson(TRACK_KEY, []); S.trip = S.navigating ? { startedAt: Date.now(), dist: 0, maxSog: 0, n: 0 } : null; saveJson('saily.trip.v1', S.trip); toast('Track and trip log cleared'); });
    $('btnReset').addEventListener('click', () => { if (confirm('Reset all settings, track and log?')) { localStorage.clear(); location.reload(); } });
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
        reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('App updated: reload to use the new version', 5000); }); });
      }).catch(() => { });
    });
  }

  // ---------- init ----------
  document.title = 'Saily · ' + (P.title || P.name);
  $('tzFrom').textContent = TZL_FROM; $('tzTo').textContent = TZL_TO;
  $('hudEtaLabel').textContent = 'ETA ' + (P.destinationShort || 'destination');
  $('startTitle').innerHTML = `<b>${P.name}</b><br>${P.description || ''}`;
  setNet(); renderWxOverlay(); renderSeaLine(); aisApply();
  if (S.pos === null) { updateHudIdle(); }
  function updateHudIdle() {
    const w = WPS()[S.settings.wp];
    $('hudWpId').textContent = w.id; $('hudWpName').textContent = w.name;
    $('hudRoute').textContent = S.route.short || S.route.id;
    $('hudDtg').innerHTML = S.route.total + '<small> nm</small>';
  }
  window.SAILY = { S, map, processFix, startSim, stopSim, alert, preload, refreshWeather, onFix };
})();
