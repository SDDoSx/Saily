/* Saily app: GPS navigation, TSS/hazard alerts, weather, offline preload. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.CHART, N = window.NAV, W = window.WX;
  const TZ_ES = 'Europe/Madrid', TZ_MA = 'Africa/Casablanca';
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
    return fromLocal(TZ_ES, today + 'T13:30').toISOString();
  }
  const bothTimes = d => `${N.fmtTime(d, TZ_ES)} ES · ${N.fmtTime(d, TZ_MA)} MA`;

  // ---------- state ----------
  const DEFAULTS = { speed: 22, routeId: 'tarifa', departure: defaultDeparture(), voice: true, sound: true, th: Object.assign({}, W.DEFAULT_THRESHOLDS), base: 'carto', seamark: true, chartOnly: false, night: false, wp: 1, checklist: {} };
  const S = {
    settings: loadSettings(), pos: null, lastFixAt: 0, fixes: [], track: [], smoother: N.makeSmoother(0.35), sog: null, cog: null, acc: null,
    started: false, navigating: false, sim: null, watchId: null, wakeLock: null, audio: null, muted: false,
    zone: {}, hazard: {}, approached: {}, alertLast: {}, log: loadJson(LOG_KEY, []), wx: W.load(), solution: null, route: null, follow: true,
    lastWxAlert: 0, sunsetWarned: false, nightNoted: false, layers: {}, aidsShown: false,
  };
  function loadSettings() {
    const s = loadJson(KEY, null);
    const merged = Object.assign({}, DEFAULTS, s || {});
    merged.th = Object.assign({}, W.DEFAULT_THRESHOLDS, (s && s.th) || {});
    if (!s || !s.departure || new Date(s.departure).getTime() < Date.now() - 36 * 3600000) merged.departure = defaultDeparture();
    return merged;
  }
  function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(S.settings)); } catch (e) { } }
  function loadJson(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

  S.route = C.routes.find(r => r.id === S.settings.routeId) || C.routes[0];
  const WPS = () => S.route.waypoints;
  const DEST = () => WPS()[WPS().length - 1];

  // ---------- UI basics ----------
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms || 2500); }
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
    $('clockMA').textContent = N.fmtTime(now, TZ_MA);
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
      // unlock speech on iOS with an empty utterance
      if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
    } catch (e) { }
  }
  function beep(count, freq, dur) {
    if (!S.audio || S.muted || !S.settings.sound) return;
    try {
      const ctx = S.audio; let t = ctx.currentTime;
      for (let i = 0; i < count; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.0001;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.start(t); o.stop(t + dur + 0.02); t += dur + 0.12;
      }
    } catch (e) { }
  }
  function speak(text) {
    if (S.muted || !S.settings.voice || !('speechSynthesis' in window)) return;
    try {
      if (speechSynthesis.pending && speechSynthesis.speaking) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text); u.lang = 'en-GB'; u.rate = 1.0; u.volume = 1;
      speechSynthesis.speak(u);
    } catch (e) { }
  }
  let bannerTimer = null;
  function showBanner(level, text, ms) {
    const b = $('alertBanner'); b.className = level; $('alertText').textContent = text; b.classList.remove('hidden');
    clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  }
  $('alertBanner').addEventListener('click', () => $('alertBanner').classList.add('hidden'));
  /** level: info | warn | danger */
  function alert(id, level, text, opt) {
    opt = opt || {};
    const now = Date.now();
    if (opt.cooldown && S.alertLast[id] && now - S.alertLast[id] < opt.cooldown * 1000) return false;
    S.alertLast[id] = now;
    S.log.unshift({ t: now, level, text }); if (S.log.length > 200) S.log.length = 200; saveJson(LOG_KEY, S.log);
    showBanner(level, text, level === 'danger' ? 0 : level === 'warn' ? 40000 : 15000);
    if (level === 'danger') beep(3, 880, 0.35); else if (level === 'warn') beep(2, 660, 0.2); else beep(1, 520, 0.12);
    if (opt.speak !== false) speak(text);
    try { if (navigator.vibrate) navigator.vibrate(level === 'danger' ? [300, 100, 300, 100, 300] : level === 'warn' ? [200, 100, 200] : 120); } catch (e) { }
    return true;
  }

  // ---------- wake lock ----------
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) { S.wakeLock = await navigator.wakeLock.request('screen'); S.wakeLock.addEventListener('release', () => { S.wakeLock = null; }); }
    } catch (e) { S.wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.started && !S.wakeLock) requestWakeLock(); if (document.visibilityState === 'visible') map.invalidateSize(); });

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false }).setView([36.03, -5.52], 10);
  map.attributionControl.setPrefix('');
  map.createPane('land').style.zIndex = 150;
  map.createPane('tss').style.zIndex = 405;
  map.createPane('haz').style.zIndex = 408;
  map.createPane('route').style.zIndex = 420;
  map.createPane('aids').style.zIndex = 430;
  map.createPane('vessel').style.zIndex = 650;
  const BASES = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
    carto: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { subdomains: 'abcd', maxZoom: 19, attribution: '© OpenStreetMap © CARTO' }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery © Esri' }),
  };
  const SEAMARK = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenSeaMap' });
  function applyBase() {
    Object.values(BASES).forEach(l => map.removeLayer(l));
    if (map.hasLayer(SEAMARK)) map.removeLayer(SEAMARK);
    if (!S.settings.chartOnly) {
      (BASES[S.settings.base] || BASES.carto).addTo(map);
      if (S.settings.seamark) SEAMARK.addTo(map);
    }
    $('btnChartOnly').classList.toggle('on', !!S.settings.chartOnly);
    $('map').classList.toggle('night', !!S.settings.night);
    $('btnNight').classList.toggle('on', !!S.settings.night);
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
  // hazards
  const hazColor = { danger: '#ff2b2b', caution: '#ff9f1a', info: '#4aa3ff' };
  C.hazards.forEach(h => L.circle([h.lat, h.lon], { pane: 'haz', radius: h.radius * 1852, color: hazColor[h.level], weight: 1.5, dashArray: h.level === 'danger' ? null : '5 5', fillColor: hazColor[h.level], fillOpacity: h.level === 'danger' ? 0.2 : 0.08 }).bindPopup(`<b>${h.name}</b>${h.note}`).addTo(map));
  // aids
  const aidsGroup = L.layerGroup();
  const aidColor = a => /red/i.test(a.light) ? '#e53935' : /green/i.test(a.light) ? '#2e7d32' : a.type === 'wreck' || a.type === 'obstruction' ? '#000' : a.type.includes('cardinal') ? '#f5b400' : '#f2f2f2';
  C.aids.forEach(a => {
    const isLight = a.type.startsWith('light');
    aidsGroup.addLayer(L.circleMarker([a.lat, a.lon], { pane: 'aids', radius: isLight ? 5 : 4, color: '#111', weight: 1, fillColor: aidColor(a), fillOpacity: 1 })
      .bindPopup(`<b>${a.name || a.type.replace(/_/g, ' ')}</b>${a.type.replace(/_/g, ' ')}${a.cat ? ' · ' + a.cat : ''}${a.light ? '<br>Light: ' + a.light : ''}<br>${N.fmtDM(a.lat, a.lon)}`));
  });
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
    C.routes.forEach(r => {
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
  if (savedTrack.length && Date.now() - savedTrack[savedTrack.length - 1][2] < 12 * 3600000) { S.track = savedTrack; track.setLatLngs(S.track.map(p => [p[0], p[1]])); }
  map.on('dragstart', () => { S.follow = false; $('btnFollow').classList.remove('on'); });
  $('btnFollow').addEventListener('click', () => { S.follow = !S.follow; $('btnFollow').classList.toggle('on', S.follow); if (S.follow && S.pos) map.panTo([S.pos.lat, S.pos.lon]); });
  $('btnRoute').addEventListener('click', () => { S.follow = false; $('btnFollow').classList.remove('on'); map.fitBounds(S.route.waypoints.map(w => [w.lat, w.lon]), { padding: [30, 30] }); });
  $('btnLayers').addEventListener('click', () => { const order = ['carto', 'osm', 'sat']; S.settings.base = order[(order.indexOf(S.settings.base) + 1) % order.length]; S.settings.chartOnly = false; saveSettings(); applyBase(); toast('Base map: ' + { osm: 'OpenStreetMap', carto: 'CARTO light', sat: 'Satellite' }[S.settings.base]); });
  $('btnChartOnly').addEventListener('click', () => { S.settings.chartOnly = !S.settings.chartOnly; saveSettings(); applyBase(); toast(S.settings.chartOnly ? 'Vector chart only (works fully offline)' : 'Tiles on'); });
  $('btnNight').addEventListener('click', () => { S.settings.night = !S.settings.night; saveSettings(); applyBase(); });
  applyBase();
  map.fitBounds(S.route.waypoints.map(w => [w.lat, w.lon]), { padding: [20, 20] });

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
      if (d && d.dt >= 0.8) {
        if (sog === null) sog = (d.dt < 30 && d.sog < 60) ? d.sog : null; // >60 kn = GPS jump, ignore
        if (cog === null && d.d * 1852 > Math.max(8, (fix.acc || 10) * 0.6) && (sog === null || sog > 1.5)) cog = d.cog;
      }
    }
    S.smoother.push(sog, cog);
    S.sog = S.smoother.sog; S.cog = S.smoother.cog;
    S.pos = fix; S.acc = c.accuracy; S.lastFixAt = Date.now();
    S.fixes.push(fix); if (S.fixes.length > 50) S.fixes.shift();
    const last = S.track[S.track.length - 1];
    if (!last || N.distanceNm({ lat: last[0], lon: last[1] }, fix) > 0.01) { S.track.push([+fix.lat.toFixed(5), +fix.lon.toFixed(5), fix.t]); if (S.track.length > 4000) S.track.splice(0, 500); track.addLatLng([fix.lat, fix.lon]); }
    setGps(c.accuracy <= 50 ? 'ok' : c.accuracy <= 150 ? 'warn' : 'bad', (S.sim ? 'SIM ' : 'GPS ') + (c.accuracy ? '±' + Math.round(c.accuracy) + ' m' : ''));
    processFix();
  }
  setInterval(() => {
    if (S.navigating && !S.sim && S.lastFixAt && Date.now() - S.lastFixAt > 25000) { setGps('bad', 'GPS lost'); alert('gpslost', 'danger', 'GPS signal lost. Check sky view.', { cooldown: 60 }); }
    if (S.track.length) saveJson(TRACK_KEY, S.track.slice(-3000));
  }, 5000);

  // ---------- navigation processing ----------
  function speedForEta() { return (S.sog !== null && S.sog >= 3) ? { v: S.sog, plan: false } : { v: S.settings.speed, plan: true }; }
  function processFix() {
    const pos = S.pos; if (!pos) return;
    const wps = WPS();
    let sol = N.solve(pos, wps, S.settings.wp);
    if (S.navigating && sol.arrived) {
      if (sol.k >= wps.length - 1) {
        if (!S.arrivedFinal) { S.arrivedFinal = true; alert('arrived', 'info', `Arrived at ${sol.wp.name}. ${sol.wp.note}`); }
      } else {
        S.settings.wp = sol.k + 1; saveSettings(); S.approached = {};
        const nxt = N.solve(pos, wps, S.settings.wp);
        alert('wp' + sol.k, 'info', `Waypoint ${sol.wp.id} reached. New course ${N.fmtBrg(nxt.brg)}, ${N.fmtNm(nxt.dist)} miles to ${nxt.wp.id}. ${nxt.wp.note}`);
        drawRoutes(); sol = nxt;
      }
    }
    S.solution = sol;
    updateHud(sol); updateMap(sol);
    if (S.navigating) { checkNavAlerts(sol); checkZones(pos, sol); checkHazards(pos); checkHarbourSpeed(pos); checkWeatherNow(pos); checkSun(); }
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
    const sp = speedForEta();
    const ttg = N.ttgSeconds(sol.dist, sp.v), ttgAll = N.ttgSeconds(sol.remaining, sp.v);
    $('hudTtg').textContent = N.fmtDur(ttg) + (sp.plan ? '*' : '');
    $('hudEta').textContent = ttgAll === null ? '--:--' : N.fmtTime(new Date(Date.now() + ttgAll * 1000), TZ_ES) + (sp.plan ? '*' : '');
    $('hudEta').title = ttgAll === null ? '' : bothTimes(new Date(Date.now() + ttgAll * 1000));
    $('hudDtg').innerHTML = N.fmtNm(sol.remaining, 1) + '<small> nm ' + N.fmtDur(ttgAll) + '</small>';
    $('hudPos').textContent = N.fmtDM(S.pos.lat, S.pos.lon);
    $('hudAcc').textContent = sp.plan ? '* at plan speed ' + S.settings.speed + ' kn' : '';
    $('hudSim').textContent = S.sim ? 'SIMULATION' : '';
    $('hudRoute').textContent = S.route.id === 'tarifa' ? 'Tarifa crossing' : 'East crossing';
    const wxp = W.nearestPoint(S.wx, S.pos); const row = wxp ? W.rowAt(wxp, new Date()) : null;
    $('hudWx').textContent = row ? `wind ${Math.round(row.wind)}${row.gust ? '/' + Math.round(row.gust) : ''} kn ${N.compass16(row.windDir)} · sea ${row.wave != null ? row.wave.toFixed(1) + ' m' : '--'}${row.current != null ? ' · cur ' + row.current.toFixed(1) + ' kn ' + N.compass16(row.currentDir) : ''}` : '';
  }
  function updateMap(sol) {
    const p = [S.pos.lat, S.pos.lon];
    if (!map.hasLayer(vessel)) { vessel.addTo(map); accCircle.addTo(map); }
    vessel.setLatLng(p); accCircle.setLatLng(p); accCircle.setRadius(S.acc || 0);
    const rot = document.getElementById('vesselRot'); if (rot) rot.style.transform = `rotate(${S.cog === null ? 0 : S.cog}deg)`;
    brgLine.setLatLngs([p, [sol.wp.lat, sol.wp.lon]]);
    if (S.cog !== null && S.sog !== null && S.sog > 1) { const d = N.destination(S.pos, S.cog, S.sog / 6); predLine.setLatLngs([p, [d.lat, d.lon]]); } else predLine.setLatLngs([]);
    if (S.follow) map.panTo(p, { animate: false });
  }
  function checkNavAlerts(sol) {
    const ax = Math.abs(sol.xte);
    if (ax > 0.3 && sol.legDist > 0.5 && sol.dist > 0.3) alert('xte', 'warn', `Off track ${N.fmtNm(ax)} miles. Steer ${sol.xte > 0 ? 'left' : 'right'} to ${N.fmtBrg(sol.brg)}.`, { cooldown: 90 });
    if (sol.dist < Math.max(0.5, sol.wp.radius * 3) && !S.approached[sol.k] && sol.k < WPS().length - 1) {
      S.approached[sol.k] = true;
      const nb = N.bearingDeg(sol.wp, WPS()[sol.k + 1]);
      alert('appr' + sol.k, 'info', `Waypoint ${sol.wp.id} in ${N.fmtNm(sol.dist)} miles. Next course ${N.fmtBrg(nb)}. ${sol.wp.note}`);
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
        if (inside) alert('zone-' + z.id, t[0], t[1], { cooldown: 30 });
        else if (t[2]) alert('zoneout-' + z.id, 'info', t[2], { cooldown: 30 });
      }
    }
  }
  function checkHazards(pos) {
    for (const h of C.hazards) {
      const inside = N.distanceNm(pos, h) < h.radius;
      const was = !!S.hazard[h.id];
      if (inside && !was) alert('haz-' + h.id, h.level === 'danger' ? 'danger' : h.level === 'caution' ? 'warn' : 'info', `${h.level === 'danger' ? 'DANGER' : 'Caution'}: ${h.name}. ${h.note}`, { cooldown: 120 });
      S.hazard[h.id] = inside;
    }
  }
  function checkHarbourSpeed(pos) {
    if (S.sog === null || S.sog < 4) return;
    for (const pl of Object.values(C.places)) if (N.distanceNm(pos, pl) < 0.3) alert('harbspeed', 'warn', `Slow down: harbour speed limit near ${pl.name}.`, { cooldown: 60 });
  }
  function checkWeatherNow(pos) {
    if (!S.wx || Date.now() - S.lastWxAlert < 15 * 60000) return;
    const pt = W.nearestPoint(S.wx, pos); if (!pt) return;
    const row = W.rowAt(pt, new Date()); if (!row) return;
    const v = W.classify(row, S.settings.th);
    if (v.level !== 'ok') { S.lastWxAlert = Date.now(); alert('wxnow', v.level === 'nogo' ? 'danger' : 'warn', `Weather ${v.level === 'nogo' ? 'danger' : 'caution'} near ${pt.name}: ${v.reasons.join(', ')}.`); }
  }
  function checkSun() {
    const now = new Date(); const st = N.sunTimes(now, 35.78, -5.80);
    if (!st.sunset) return;
    const dt = (st.sunset - now) / 60000;
    if (dt > 0 && dt < 60 && !S.sunsetWarned) { S.sunsetWarned = true; alert('sunset', 'warn', `Sunset in ${Math.round(dt)} minutes (${bothTimes(st.sunset)}). Navigation lights on, prepare for night entry.`); }
    if (dt < 0 && dt > -600 && !S.nightNoted) { S.nightNoted = true; alert('night', 'info', 'After sunset: navigation lights on. Use the aids list for light characteristics.'); }
  }

  // ---------- simulation ----------
  function startSim(fromWp) {
    stopSim();
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
      if (S.arrivedFinal) stopSim();
    }, 1000);
    $('hudSim').textContent = 'SIMULATION';
  }
  function stopSim() { if (S.sim) { clearInterval(S.sim); S.sim = null; } $('hudSim').textContent = ''; }

  // ---------- start ----------
  function begin(mode) {
    ensureAudio(); S.started = true; requestWakeLock();
    $('startOverlay').classList.add('hidden');
    S.arrivedFinal = false;
    if (mode === 'nav') { S.navigating = true; startGps(); speak('Navigation started. Route ' + S.route.name.split(':')[0] + '.'); }
    else if (mode === 'sim') { S.navigating = true; startSim(S.settings.wp); }
    else { S.navigating = false; startGps(); }
    renderMore();
  }
  $('btnStart').addEventListener('click', () => begin('nav'));
  $('btnPlanOnly').addEventListener('click', () => begin('look'));
  $('btnStartSim').addEventListener('click', () => begin('sim'));
  $('btnPrevWp').addEventListener('click', () => { S.settings.wp = Math.max(1, S.settings.wp - 1); S.approached = {}; S.arrivedFinal = false; saveSettings(); drawRoutes(); if (S.pos) processFix(); toast('Active waypoint: ' + WPS()[S.settings.wp].id); });
  $('btnNextWp').addEventListener('click', () => { S.settings.wp = Math.min(WPS().length - 1, S.settings.wp + 1); S.approached = {}; saveSettings(); drawRoutes(); if (S.pos) processFix(); toast('Active waypoint: ' + WPS()[S.settings.wp].id); });
  $('btnMute').addEventListener('click', () => { S.muted = !S.muted; $('btnMute').textContent = S.muted ? '🔇' : '🔊'; if (S.muted) try { speechSynthesis.cancel(); } catch (e) { } });
  $('startInfo').textContent = `${S.route.total} nm · about ${N.fmtDur(S.route.total / S.settings.speed * 3600)} at ${S.settings.speed} kn · planned departure ${bothTimes(new Date(S.settings.departure))}`;

  // ---------- weather ----------
  async function refreshWeather(force) {
    if (!navigator.onLine) { toast('Offline: using stored forecast'); return; }
    if (!force && S.wx && Date.now() - S.wx.fetchedAt < 20 * 60000) return;
    toast('Fetching forecast…');
    try {
      const d = await W.fetchAll(3);
      if (Object.keys(d.points).length) { S.wx = d; toast('Forecast updated' + (d.errors.length ? ' (some points failed)' : '')); }
      else toast('Forecast fetch failed');
    } catch (e) { toast('Forecast fetch failed: ' + e.message); }
    if ($('view-wx').classList.contains('active')) renderWx();
    if (S.solution) updateHud(S.solution);
  }
  const arrow = deg => `<span class="arrow" style="transform:rotate(${(deg || 0) + 180}deg)">➤</span>`; // wind FROM: arrow points where it blows to
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
      h += `<div class="card"><h2>How to read the Strait</h2><ul>
        <li><b>Levante</b> (E wind) and <b>Poniente</b> (W wind) funnel through the Strait; the wind is strongest between Tarifa and Tangier and can be 10 to 15 kn more than the forecast at the ends.</li>
        <li>The surface flow runs <b>eastward</b> into the Mediterranean (1 to 2 kn, up to 3 kn off Tarifa) with the tidal stream on top. A Levante blowing <b>against</b> that eastward flow builds short, steep seas: the "wind against current" column flags it.</li>
        <li>Crossing on a plane at 20+ kn in 1.5 m short seas is punishing; over 2 m or 25 kn sustained, do not go with this boat and crew.</li>
        <li>Fog is possible in September, mostly mornings on the Atlantic side. Below 2 km visibility, radar/AIS-less crossing of the lanes is not sensible.</li></ul></div>`;
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
    let h = `<div class="card"><h2>Route</h2><div class="row">${C.routes.map(x => `<label class="row" style="gap:6px"><input type="radio" name="route" value="${x.id}" ${x.id === r.id ? 'checked' : ''}> ${x.recommended ? 'Recommended' : 'Alternative'}</label>`).join('')}</div>
      <p><b>${r.name}</b></p><p>${r.summary}</p>
      <div class="kv"><div>Distance</div><div>${r.total} nm</div><div>At ${sp} kn</div><div>${N.fmtDur(r.total / sp * 3600)}</div><div>Departure</div><div>${bothTimes(dep)} · ${dep.toDateString()}</div><div>ETA Tangier</div><div>${bothTimes(new Date(dep.getTime() + r.total / sp * 3600000))}</div></div></div>`;
    h += `<div class="card"><h2>Legs</h2><div class="tbl"><table><tr><th>#</th><th>From</th><th>To</th><th>Course</th><th>Dist</th><th>Leg</th><th>ETA (ES)</th></tr>`;
    r.legs.forEach((l, i) => { cum += l.dist; h += `<tr><td>${i + 1}</td><td>${l.from}</td><td>${l.to}</td><td>${N.fmtBrg(l.brg)}</td><td>${l.dist.toFixed(1)}</td><td>${N.fmtDur(l.dist / sp * 3600)}</td><td>${N.fmtTime(new Date(dep.getTime() + cum / sp * 3600000), TZ_ES)}</td></tr>`; });
    h += `</table></div><p class="muted">Courses are true. Apply your compass variation (about 1° W here) and deviation if steering by compass.</p></div>`;
    h += `<div class="card"><h2>Waypoints</h2><div class="tbl"><table><tr><th>ID</th><th>Position</th><th>Note</th></tr>${r.waypoints.map(w => `<tr><td><b>${w.id}</b><br><span class="muted">${w.name}</span></td><td>${N.fmtDM(w.lat, w.lon)}<br><span class="muted">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span></td><td style="white-space:normal;min-width:220px">${w.note}</td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:8px"><a class="btn" id="gpxLink" download="saily-${r.id}.gpx">Download GPX for the plotter</a><button class="btn" id="btnCopyWp">Copy waypoints</button></div></div>`;
    h += `<div class="card"><h2>Crossing the traffic lanes (COLREG rule 10)</h2><ul>
      <li>Stay in the <b>inshore traffic zones</b> (green dashed) along both coasts. Do not use the lanes as a route.</li>
      <li>Cross the scheme <b>on a heading at right angles</b> to the traffic flow (here 180° T going south). Heading, not ground track: aim the bow at 180° and accept the set.</li>
      <li>The north lane is <b>westbound</b>: ships come from your <b>left</b>. The south lane is <b>eastbound</b>: ships come from your <b>right</b>. Big ships do 15 to 22 kn; a ship 3 nm away is on you in 8 minutes.</li>
      <li>You are the give-way vessel to anyone in a lane if you are crossing under 20 m LOA (rule 10j): do not impede them. Slow down or speed up early, never cut close ahead.</li>
      <li>Keep VHF 16 on. Tarifa Traffic (VTS) works VHF 10 and watches the whole Strait on radar and AIS. If in doubt, call them: "Tarifa Traffic, this is motor yacht [name], position ..., crossing southbound, request traffic information."</li>
      <li>Precautionary areas (magenta dotted) have no lanes but ships turn and converge there. The eastern one (Gibraltar to Ceuta) is the busiest water in the Strait.</li></ul></div>`;
    h += `<div class="card"><h2>Sotogrande (departure)</h2><div class="kv">
      <div>Marina</div><div>${C.places.sotogrande.name} · VHF 9 (office 09:00-21:00) · +34 956 790 000 · WhatsApp +34 639 347 807</div>
      <div>Layout</div><div>Inner mouth 80 m wide (4.5 m) opens SOUTH at 36°17.29'N 5°16.22'W; a 250 m channel runs south between the breakwater (east) and the beach to the breakwater head with its green light at 36°17.15'N 5°16.19'W. Leaving: go south down the channel, round the head to port, then turn ESE to SOTO-OUT. Speed limit 3 kn near the mouth and inside (port rules art. 37).</div>
      <div>Hazard</div><div>Marina safety notice of 20 Feb 2026: dangerous shoaling at 36°16.890'N 5°16.276'W, 500 m south of the head (bearing 195°), and a voluntary exclusion zone off the Guadiaro river mouth. No notice lifting it was found. Ask the Capitanía on VHF 9 before leaving; do not run south or south-west from the head.</div>
      <div>Sea at entrance</div><div>Swell at the mouth with E/SE winds; noticeable ebb current at the entrance; recurrent silting.</div>
      <div>Leaving Spain</div><div>Spanish-flag private boats without professional crew need no "despacho" (RD 186/2023). Sotogrande is not a Schengen border post: EU/EEA/Swiss crew need nothing; non-EU passport holders (UK, US...) should get their Schengen exit recorded (EES) at La Línea, Algeciras or Tarifa police, or accept the overstay risk on return. Morocco does not ask for a Spanish exit stamp.</div>
      <div>Carry</div><div>Passports, boat registration, insurance certificate valid for Morocco, skipper licence (ICC or national), radio licence, crew list ×4, a sheet with the boat's technical data.</div></div></div>`;
    h += `<div class="card"><h2>Tangier (arrival)</h2><div class="kv">
      <div>Marina</div><div>${C.places.tangier.name} · VHF <b>11</b> (harbourmaster 11/16) · Tangier Traffic (VTS) VHF 69, alt 68 · port pilots VHF 12</div>
      <div>Contact</div><div>Capitainerie 24 h: +212 539 372 424 · Office: +212 539 33 17 17 · info@tanjamarinabay.ma (send registration, insurance, passports and crew list ahead; reservation advised, a berth is not guaranteed on arrival)</div>
      <div>Hours</div><div>Office Mon-Fri 09:00-19:00, Sat 10:00-14:00 (2026 guide), <b>closed Sunday</b>; capitainerie, marineros and fuel 24/7; police and customs posts on site. Arrive before 18:00 Morocco time and clear in daylight; departure clearance is daytime only.</div>
      <div>Approach</div><div>Tangier Bay opens NE. Keep at least 1 nm off Cap Malabata (Almirante Rock 6.3 m, 0.5 nm north of it, breaks in heavy seas). Do not cut across the bay: shoals lie in its east and south (Sevil du Burj 3.6 m, Gandouri 5.5 m, Buoree Rock 0.9 m about 1 nm east of the main jetty head, a wreck 0.5 nm ENE of it). Come in from the NE on the ferry line towards the jetty head Fl(3) 12s, then follow the marked marina channel. Buoys are reported off station or missing: rely on bearings and daylight.</div>
      <div>Entrance</div><div>${N.fmtDM(C.places.tangier.lat, C.places.tangier.lon)}, 140 m wide at the SE corner of the basin, between the Jetée Est head Fl(3)G 10s (starboard) and the Jetée Ouest head Fl(3)R 10s (port). Enter heading N/NW. Shoal 0.9-2 m immediately south of the red head and along the beach: never approach from the beach side. Fuel dock just inside, reception pontoon beyond it (high concrete edge, 1.7-2 m tidal range: fenders high).</div>
      <div>Traffic</div><div>Fast ferries from Tarifa and cruise ships use the north side of the outer harbour and a turning area in the middle. Give way, keep to the marina side. No anchoring within 500 m of the marina breakwaters (Moroccan law).</div>
      <div>Formalities</div><div>Q flag and Moroccan courtesy flag. Police, customs and port authority in one building by the reception pontoon: 15-90 min, no charge. Customs form D716 (temporary admission of the boat): keep the blue and white copies aboard and present them on departure. Declare alcohol, medicines, drones (drones are held until you leave). Visa-free 90 days for EU, UK, US, CA, AU, CH and most others.</div>
      <div>Cost</div><div>2026 rate for a 12 m x 4 m boat: 281 MAD per night in high season (to 30 Sep), about 26 EUR; access card deposit.</div>
      <div>Time</div><div>Morocco is UTC+1: 1 hour behind Spain in September.</div></div></div>`;
    h += `<div class="card"><h2>Emergency and radio</h2><div class="kv">
      <div>Distress</div><div>VHF 16 (DSC 70): MAYDAY / PAN PAN with position from this app.</div>
      <div>Salvamento Marítimo</div><div>+34 900 202 202 (24 h, free) · Spain 112</div>
      <div>Tarifa Traffic</div><div>VTS for the Strait, radar and AIS: VHF <b>10</b> (67 alt), watch 16, MMSI 002240994, +34 956 684 757. Weather and traffic bulletins on VHF 10 at 00:15, 04:15, 08:15, 12:15, 16:15, 20:15 UTC (14:15 and 18:15 Spain time). Yachts need not file a GIBREP report, but announcing the crossing is advised and contact is mandatory in fog.</div>
      <div>Tangier Traffic</div><div>VHF <b>69</b> (68 alt), MMSI 002424131; bulletins 02:15, 06:15, 10:15, 14:15, 18:15, 22:15 UTC.</div>
      <div>Gibraltar</div><div>Gibraltar Port / Gibraltar Bay VTS VHF 12, watch 16.</div>
      <div>Morocco</div><div>Tanger harbourmaster VHF 11/16 · Police 19 · Ambulance 15 · Gendarmerie 177 · MRCC Rabat via VHF 16 / Tangier Traffic 69.</div></div><p class="muted">Compiled from IMO MSC.300(87), NGA Pub 131, port and marina sources (Sep 2026). Confirm before departure and keep a paper copy.</p></div>`;
    h += `<div class="card"><h2>Sea and current notes (NGA Pub 131, Ifremer)</h2><ul>
      <li>Surface flow sets <b>east</b> into the Med, 1-2 kn mid-strait and up to 3 kn inshore; at Tarifa it is almost always eastward (3+ kn measured at HW+2). Mid-strait the east-going stream starts about <b>HW Gibraltar</b> and the west-going about 6 h later, earlier towards both shores.</li>
      <li><b>Punta Carnero</b>: strong NW-NE tidal set along the coast, "numerous accidents"; dangers to 0.2 nm off, La Perla rocks (4.7 m) 1.2 nm south. Keep the CARNERO offing.</li>
      <li><b>Tarifa</b>: races off the island; Bajo de los Cabezos race 5 nm NW (off route) can extend across the strait in heavy weather.</li>
      <li><b>Banco de Fenix</b> (15 m, 3 nm NNE of Malabata) and the banks between Malabata and Hejar Lesfar: the most violent races on the Moroccan side at max stream. The route passes just north of it; at springs (10-14 Sep 2026) with wind against stream expect breaking overfalls there and north of Tangier.</li>
      <li>Wind at Tarifa and Punta Carnero is commonly <b>2-3 Beaufort above</b> the area forecast. The local whale-boat operator stays in port from 21 kn of Levante. Fog forms in the early morning when a Levante dies and can last into the afternoon.</li>
      <li>Tunny nets up to 7 nm offshore in season (white flag with black A by day, red over white lights at night). Whale speed limit 13 kn applies April to August only.</li></ul></div>`;
    h += `<div class="card"><h2>Departure checklist</h2><div class="check">${CHECKLIST.map((c, i) => `<label><input type="checkbox" data-ck="${i}" ${S.settings.checklist[i] ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></div>`;
    const sun = N.sunTimes(new Date(), 35.78, -5.80);
    h += `<div class="card"><h2>Daylight today</h2><p>Sunrise ${sun.sunrise ? bothTimes(sun.sunrise) : '--'} · Sunset ${sun.sunset ? bothTimes(sun.sunset) : '--'} at Tangier. Plan to be berthed with daylight to spare: the marina entrance and the port traffic are much harder at night.</p></div>`;
    el.innerHTML = h;
    el.querySelectorAll('input[name=route]').forEach(i => i.addEventListener('change', () => { S.settings.routeId = i.value; S.settings.wp = 1; saveSettings(); S.route = C.routes.find(x => x.id === i.value); S.zone = {}; S.approached = {}; drawRoutes(); renderPlan(); if (S.pos) processFix(); }));
    $('gpxLink').href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(N.toGPX('Saily ' + r.id, r.waypoints));
    $('btnCopyWp').addEventListener('click', async () => { const txt = r.waypoints.map(w => `${w.id}\t${N.fmtDM(w.lat, w.lon)}\t${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`).join('\n'); try { await navigator.clipboard.writeText(txt); toast('Copied'); } catch (e) { toast('Copy failed'); } });
    el.querySelectorAll('input[data-ck]').forEach(i => i.addEventListener('change', () => { S.settings.checklist[i.dataset.ck] = i.checked; saveSettings(); }));
  }
  const CHECKLIST = [
    'Weather checked in the app for the whole passage window (wind, gusts, waves, wind vs current), and Spanish forecast (AEMET Estrecho) or Windy cross-checked.',
    'Preload done in Setup while on wifi: app shell, forecast, map tiles. Airplane-mode test: app opens and shows the chart.',
    'Phone at 100 %, charging cable and power bank on deck; phone mounted with a clear sky view; auto-lock off (the app requests wake lock, but check).',
    'Route loaded in the boat plotter too (GPX or keyed in); paper copy of waypoints and contacts.',
    'Fuel: full tanks, at least 30 % reserve after the planned burn; engine checks done (oil, coolant, belts, raw water strainers).',
    'Lifejackets worn on deck, kill cord, EPIRB/PLB if aboard, flares in date, VHF tested on 16, handheld VHF charged.',
    'Documents: passports, boat registration, insurance (Morocco covered), skipper licence, crew list ×4, boat stamp if you have one.',
    'Flags: Moroccan courtesy flag and Q flag ready.',
    'Marina office told; Tanja Marina Bay booked or called (VHF 9 on approach).',
    'Crew briefing: lane crossing (ships from the LEFT then the RIGHT), what "give way" means at 22 kn, who watches which sector, seasickness pills taken early.',
    'Timezone: watches to Morocco time on arrival (1 hour back).',
  ];

  // ---------- setup / more ----------
  function renderMore() {
    const el = $('morePage'); const s = S.settings;
    let h = `<div class="card"><h2>Passage settings</h2>
      <label class="field"><span>Planned cruise speed (kn)</span><input type="number" id="setSpeed" min="5" max="40" step="1" value="${s.speed}"></label>
      <label class="field"><span>Planned departure (Spain time)</span><input type="datetime-local" id="setDep" value="${toLocalInput(TZ_ES, new Date(s.departure))}"></label>
      <label class="field"><span>Route</span><select id="setRoute">${C.routes.map(r => `<option value="${r.id}" ${r.id === s.routeId ? 'selected' : ''}>${r.recommended ? 'Recommended (Tarifa crossing)' : 'Alternative (east crossing)'}</option>`).join('')}</select></label>
      <label class="field"><span>Spoken alerts</span><input type="checkbox" id="setVoice" ${s.voice ? 'checked' : ''}></label>
      <label class="field"><span>Alert beeps</span><input type="checkbox" id="setSound" ${s.sound ? 'checked' : ''}></label>
      <label class="field"><span>OpenSeaMap buoys/lights overlay</span><input type="checkbox" id="setSeamark" ${s.seamark ? 'checked' : ''}></label>
      <div class="row" style="margin-top:8px"><button class="btn" id="btnTestAlert">Test alert</button><button class="btn" id="btnResetWp">Restart route from WP 1</button></div></div>`;
    h += `<div class="card"><h2>Weather thresholds</h2>
      <label class="field"><span>Wind caution / no-go (kn)</span><span class="row"><input type="number" id="thWindC" value="${s.th.windCaution}" style="width:70px"><input type="number" id="thWindN" value="${s.th.windNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Gust caution / no-go (kn)</span><span class="row"><input type="number" id="thGustC" value="${s.th.gustCaution}" style="width:70px"><input type="number" id="thGustN" value="${s.th.gustNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Wave caution / no-go (m)</span><span class="row"><input type="number" step="0.1" id="thWaveC" value="${s.th.waveCaution}" style="width:70px"><input type="number" step="0.1" id="thWaveN" value="${s.th.waveNoGo}" style="width:70px"></span></label>
      <label class="field"><span>Current caution (kn)</span><input type="number" step="0.1" id="thCur" value="${s.th.currentCaution}" style="width:70px"></label></div>`;
    h += `<div class="card"><h2>Preload for offline use</h2><p class="muted">Do this on wifi before leaving. Stores the app, the 3-day forecast and map tiles for the whole route (about 15 to 40 MB). The vector chart, route, TSS and hazards are built in and always work offline.</p>
      <div class="row"><button class="btn primary" id="btnPreloadAll">Preload everything</button><button class="btn" id="btnPreloadWx">Forecast only</button><button class="btn" id="btnPreloadTiles">Map tiles only</button></div>
      <div class="progress"><div id="preProg"></div></div><div id="preText" class="muted">${preloadStatusText()}</div><div id="storeText" class="muted"></div></div>`;
    h += `<div class="card"><h2>Status</h2><div class="kv"><div>Service worker</div><div id="swText">${navigator.serviceWorker && navigator.serviceWorker.controller ? 'active (offline ready)' : 'not yet active: reload once online'}</div><div>Wake lock</div><div>${S.wakeLock ? 'held (screen stays on)' : ('wakeLock' in navigator ? 'not held' : 'not supported: disable auto-lock in iPhone Settings, Display')}</div><div>Install</div><div>iPhone: Safari share button, "Add to Home Screen". Mac: Safari File menu, "Add to Dock". Then open it from the icon: fullscreen, and the cache is kept.</div><div>Simulation</div><div class="row"><button class="btn" id="btnSim">${S.sim ? 'Stop simulation' : 'Start simulation (demo)'}</button></div></div></div>`;
    h += `<div class="card"><h2>Alert log</h2><div class="log">${S.log.slice(0, 40).map(l => `${N.fmtTime(new Date(l.t), TZ_ES)} [${l.level}] ${l.text}`).join('\n') || 'none yet'}</div><div class="row" style="margin-top:8px"><button class="btn" id="btnClearLog">Clear log</button><button class="btn" id="btnClearTrack">Clear track</button><button class="btn danger" id="btnReset">Reset app data</button></div></div>`;
    h += `<div class="card"><h2>About</h2><p class="muted">Saily is a temporary passage aid built for one crossing. Data: ${C.meta.sources.join('; ')}. Weather: Open-Meteo (CC BY 4.0). Map tiles: OpenStreetMap, CARTO, Esri, OpenSeaMap. Positions from the phone GPS (WGS84). Not for navigation without official charts, a proper lookout and COLREGs.</p></div>`;
    el.innerHTML = h;
    const num = (id, f) => $(id).addEventListener('change', () => { const v = parseFloat($(id).value); if (isFinite(v)) { f(v); saveSettings(); if (S.solution) updateHud(S.solution); } });
    num('setSpeed', v => { s.speed = v; });
    $('setDep').addEventListener('change', () => { try { s.departure = fromLocal(TZ_ES, $('setDep').value).toISOString(); saveSettings(); } catch (e) { } });
    $('setRoute').addEventListener('change', () => { s.routeId = $('setRoute').value; s.wp = 1; S.route = C.routes.find(x => x.id === s.routeId); S.zone = {}; S.approached = {}; saveSettings(); drawRoutes(); if (S.pos) processFix(); });
    $('setVoice').addEventListener('change', () => { s.voice = $('setVoice').checked; saveSettings(); });
    $('setSound').addEventListener('change', () => { s.sound = $('setSound').checked; saveSettings(); });
    $('setSeamark').addEventListener('change', () => { s.seamark = $('setSeamark').checked; saveSettings(); applyBase(); });
    num('thWindC', v => s.th.windCaution = v); num('thWindN', v => s.th.windNoGo = v); num('thGustC', v => s.th.gustCaution = v); num('thGustN', v => s.th.gustNoGo = v);
    num('thWaveC', v => s.th.waveCaution = v); num('thWaveN', v => s.th.waveNoGo = v); num('thCur', v => s.th.currentCaution = v);
    $('btnTestAlert').addEventListener('click', () => { ensureAudio(); alert('test', 'warn', 'Test alert. Ships come from your left. Steer 180.', {}); });
    $('btnResetWp').addEventListener('click', () => { s.wp = 1; S.approached = {}; S.arrivedFinal = false; saveSettings(); drawRoutes(); if (S.pos) processFix(); toast('Route restarted'); });
    $('btnPreloadAll').addEventListener('click', () => preload(true, true));
    $('btnPreloadWx').addEventListener('click', () => preload(true, false));
    $('btnPreloadTiles').addEventListener('click', () => preload(false, true));
    $('btnSim').addEventListener('click', () => { if (S.sim) { stopSim(); } else { ensureAudio(); S.started = true; S.navigating = true; $('startOverlay').classList.add('hidden'); startSim(s.wp); showView('nav'); } renderMore(); });
    $('btnClearLog').addEventListener('click', () => { S.log = []; saveJson(LOG_KEY, []); renderMore(); });
    $('btnClearTrack').addEventListener('click', () => { S.track = []; track.setLatLngs([]); saveJson(TRACK_KEY, []); toast('Track cleared'); });
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
    if (!navigator.onLine) { toast('You are offline'); return; }
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
            if (!hit) { const res = await fetch(u, { mode: 'no-cors', cache: 'no-store' }); if (res && (res.ok || res.type === 'opaque')) await cache.put(u, res); else failed++; }
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
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(reg => {
        reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('App updated: reload to use the new version', 5000); }); });
      }).catch(() => { });
    });
  }

  // ---------- init ----------
  setNet();
  if (S.pos === null) { updateHudIdle(); }
  function updateHudIdle() {
    const w = WPS()[S.settings.wp];
    $('hudWpId').textContent = w.id; $('hudWpName').textContent = w.name;
    $('hudRoute').textContent = S.route.id === 'tarifa' ? 'Tarifa crossing' : 'East crossing';
    $('hudDtg').innerHTML = S.route.total + '<small> nm</small>';
  }
  window.SAILY = { S, map, processFix, startSim, stopSim, alert, preload, refreshWeather, onFix };
})();
