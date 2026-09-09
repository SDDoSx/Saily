// End-to-end smoke test with Playwright (Chromium). Run: NODE_PATH=/opt/node22/lib/node_modules node tools/e2e.js
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'site');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
const OUT = path.join(__dirname, 'out');
(async () => {
  await new Promise(r => server.listen(8123, r));
  const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(Object.assign({ args: ['--no-sandbox'] }, (process.env.SAILY_CHROMIUM !== 'default' && fs.existsSync(EXE)) ? { executablePath: EXE } : {}));
  const FIX = path.join(__dirname, 'fixtures');
  const fixtures = { tile: fs.readFileSync(path.join(FIX, 'tile.png')), fc: fs.readFileSync(path.join(FIX, 'fc.json')), marine: fs.readFileSync(path.join(FIX, 'marine.json')) };
  const errors = [];
  async function run(name, ctxOpts, steps) {
    const ctx = await browser.newContext(Object.assign({ permissions: ['geolocation'], geolocation: { latitude: 36.2882, longitude: -5.2703, accuracy: 10 }, locale: 'en-GB', timezoneId: 'Europe/Madrid' }, ctxOpts));
    await ctx.addInitScript(() => { try { const k = 'saily.settings.v2'; const s = JSON.parse(localStorage.getItem(k) || '{}'); if (!s.theme) { s.theme = 'dark'; localStorage.setItem(k, JSON.stringify(s)); } } catch (e) { } });
    const page = await ctx.newPage();
    // external services are stubbed with recorded fixtures (the sandbox browser has no egress)
    await page.route(u => /^https:\/\//.test(u.href), r => {
      const u = r.request().url();
      if (/marine-api\.open-meteo\.com/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fixtures.marine });
      if (/\/\/api\.open-meteo\.com/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fixtures.fc });
      return r.fulfill({ status: 200, contentType: 'image/png', body: fixtures.tile });
    });
    page.on('console', m => { if (m.type() === 'error' && !/open-meteo\.com/.test((m.location() && m.location().url) || '')) errors.push(`[${name}] console: ${m.text()}`); }); // the sandbox SW cannot reach the stubbed weather API
    page.on('pageerror', e => errors.push(`[${name}] pageerror: ${e.message}`));
    page.on('requestfailed', r => { const u = r.url(); if (u.startsWith('http://localhost')) errors.push(`[${name}] requestfailed: ${u}`); });
    await page.goto('http://localhost:8123/index.html', { waitUntil: 'domcontentloaded' });
    try { await steps(page, ctx); } catch (e) { errors.push(`[${name}] step failed: ${e.message}`); await page.screenshot({ path: path.join(OUT, name + '-failure.png') }).catch(() => {}); }
    await ctx.close();
  }
  // 1. iPhone viewport: start overlay, simulation, HUD, alerts
  await run('iphone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page, ctx) => {
    await page.waitForSelector('#btnStart');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'iphone-start.png') });
    await page.click('#btnStartSim');
    await page.waitForTimeout(9000);
    const hud = await page.evaluate(() => ({ wp: document.getElementById('hudWpId').textContent, brg: document.getElementById('hudBrg').textContent, dist: document.getElementById('hudDist').textContent, sog: document.getElementById('hudSog').textContent, cog: document.getElementById('hudCog').textContent, xte: document.getElementById('hudXte').textContent, eta: document.getElementById('hudEta').textContent, dtg: document.getElementById('hudDtg').textContent, log: window.SAILY.S.log.slice(0, 5).map(l => l.level + ': ' + l.text) }));
    console.log('HUD after 9 s sim:', JSON.stringify(hud, null, 1));
    await page.screenshot({ path: path.join(OUT, 'iphone-sim.png') });
    // jump the simulation to the crossing point to check lane alerts
    await page.evaluate(() => { window.SAILY.stopSim(); window.SAILY.S.settings.wp = 8; window.SAILY.startSim(8); });
    await page.waitForTimeout(16000);
    const log2 = await page.evaluate(() => window.SAILY.S.log.slice(0, 8).map(l => l.level + ': ' + l.text));
    console.log('Log during crossing:', JSON.stringify(log2, null, 1));
    await page.screenshot({ path: path.join(OUT, 'iphone-crossing.png') });
    for (const v of ['wx', 'plan', 'more']) { await page.click(`#tabs button[data-view=${v}]`); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(OUT, `iphone-${v}.png`), fullPage: false }); }
    // night colours and big numbers
    await page.click('#tabs button[data-view=nav]'); await page.click('#btnMore'); await page.click('#btnNight'); await page.waitForTimeout(400);
    const themeState = await page.evaluate(() => ({ theme: window.SAILY.S.settings.theme, resolved: window.SAILY.resolveTheme(), night: document.body.classList.contains('night') }));
    console.log('Night mode:', JSON.stringify(themeState)); if (!themeState.night) errors.push('night theme not applied');
    await page.screenshot({ path: path.join(OUT, 'iphone-night.png') });
    await page.click('#btnBig'); await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, 'iphone-bighud.png') }); await page.click('#btnChartBack'); await page.waitForTimeout(300);
    await page.click('#btnNight'); await page.evaluate(() => { window.SAILY.S.settings.theme = 'dark'; window.SAILY.applyTheme(); }); await page.click('#btnMore');
    const wxState = await page.evaluate(() => ({ hasWx: !!window.SAILY.S.wx, pts: window.SAILY.S.wx ? Object.keys(window.SAILY.S.wx.points) : [], errors: window.SAILY.S.wx ? window.SAILY.S.wx.errors : null }));
    console.log('Weather state:', JSON.stringify(wxState));
    // weather.js captures PASSAGE at load time: if it is loaded first, every passage silently gets the
    // Strait of Gibraltar's sample points and a 36 ft planing hull's thresholds. Script order matters.
    const wxWiring = await page.evaluate(() => ({
      points: window.WX.POINTS === window.PASSAGE.weatherPoints,
      tz: window.WX.TZ === window.PASSAGE.tz.from.zone,
      thresholds: Object.entries(window.PASSAGE.thresholds || {}).every(([k, v]) => window.WX.DEFAULT_THRESHOLDS[k] === v),
    }));
    console.log('Weather reads the passage:', JSON.stringify(wxWiring));
    for (const [k, ok] of Object.entries(wxWiring)) if (!ok) errors.push(`weather.js is not reading the passage's ${k} (script order in index.html)`);
    // service worker + offline reload
    await page.click('#tabs button[data-view=nav]');
    // Bounded, and asserted: app.js is loaded dynamically by boot.js, so a registration that waits on the
    // window "load" event never runs and the app silently stops working offline. Never hang here.
    const swReady = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 20000))]);
      if (!reg) return false;
      await new Promise(r => setTimeout(r, 1500));
      return !!reg.active;
    });
    console.log('SW active:', swReady);
    if (!swReady) errors.push('service worker never activated: the app would not work offline');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller);
    console.log('SW controlling after reload:', ctl);
    if (!ctl) errors.push('service worker is not controlling the page after a reload');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(e => errors.push('offline reload failed: ' + e.message));
    await page.waitForTimeout(1500);
    const offlineOk = await page.evaluate(() => ({ title: document.title, hasMap: !!document.querySelector('.leaflet-container'), net: document.getElementById('netText').textContent, chartLoaded: !!window.CHART }));
    console.log('Offline reload:', JSON.stringify(offlineOk));
    await page.click('#btnPlanOnly');
    await page.waitForTimeout(800);
    await page.click('#btnMore');
    await page.click('#btnChartOnly');
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'iphone-offline-chart.png') });
    await ctx.setOffline(false);
  });
  // 2. Desktop: real geolocation updates through watchPosition, zone alert
  await run('desktop', { viewport: { width: 1400, height: 900 } }, async (page, ctx) => {
    await page.waitForSelector('#btnStart');
    await page.click('#btnStart');
    await page.waitForTimeout(2500);
    await page.evaluate(() => { window.SAILY.S.fixes = []; });
    await ctx.setGeolocation({ latitude: 36.2856, longitude: -5.2710, accuracy: 8 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { window.SAILY.S.fixes = []; });
    await ctx.setGeolocation({ latitude: 36.2825, longitude: -5.2630, accuracy: 8 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { window.SAILY.S.fixes = []; });
    await ctx.setGeolocation({ latitude: 36.20, longitude: -5.295, accuracy: 8 });
    await page.waitForTimeout(2500);
    const s1 = await page.evaluate(() => ({ wp: document.getElementById('hudWpId').textContent, sog: document.getElementById('hudSog').textContent, cog: document.getElementById('hudCog').textContent, xte: document.getElementById('hudXte').textContent, gps: document.getElementById('gpsText').textContent }));
    console.log('Desktop after geolocation jumps:', JSON.stringify(s1));
    await page.evaluate(() => { window.SAILY.S.fixes = []; });
    await ctx.setGeolocation({ latitude: 35.96, longitude: -5.70, accuracy: 8 }); // inside westbound lane (west)
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.SAILY.S.fixes = []; });
    await ctx.setGeolocation({ latitude: 35.9595, longitude: -5.70, accuracy: 8 }); // second fix inside: zone transitions are debounced
    await page.waitForTimeout(2500);
    const zones = await page.evaluate(() => ({ zone: window.SAILY.S.zone, log: window.SAILY.S.log.slice(0, 4).map(l => l.level + ': ' + l.text) }));
    console.log('Zones at 35.96,-5.70:', JSON.stringify(zones));
    await page.screenshot({ path: path.join(OUT, 'desktop-nav.png') });
    await page.click('#tabs button[data-view=wx]'); await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'desktop-wx.png'), fullPage: true });
    await page.click('#tabs button[data-view=plan]'); await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'desktop-plan.png'), fullPage: true });
  });
  // 3. Setup and Plan show one section at a time, and their listeners have to tolerate a card that is
  //    not on the page. Walk every section of both and insist nothing throws.
  await run('sections', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
    await page.waitForFunction(() => !!window.SAILY, null, { timeout: 15000 });
    await page.waitForTimeout(900);
    for (const [tab, expect] of [['plan', ['Route', 'Before you go', 'Briefing', 'Log']], ['more', ['Boat', 'Alerts', 'Display', 'Data', 'About']]]) {
      await page.click(`#tabs button[data-view=${tab}]`);
      await page.waitForTimeout(900);
      const secs = await page.evaluate(() => [...document.querySelectorAll('.view.active .subnav button')].map(b => b.textContent.trim()));
      if (JSON.stringify(secs) !== JSON.stringify(expect)) errors.push(`[${tab}] sections are ${JSON.stringify(secs)}, expected ${JSON.stringify(expect)}`);
      for (const name of secs) {
        await page.click(`.view.active .subnav button:text-is("${name}")`);
        await page.waitForTimeout(600);
        const cards = await page.evaluate(() => [...document.querySelectorAll('.view.active .card h2')].map(h => h.textContent.trim()));
        if (!cards.length) errors.push(`[${tab}] section "${name}" rendered no cards`);
        const on = await page.evaluate(() => (document.querySelector('.view.active .subnav button.on') || {}).textContent);
        if ((on || '').trim() !== name) errors.push(`[${tab}] section "${name}" did not become current`);
      }
    }
    // the pre-departure cards moved from Setup to Plan and must still work there
    await page.click('#tabs button[data-view=plan]'); await page.waitForTimeout(700);
    await page.click('.view.active .subnav button:text-is("Before you go")'); await page.waitForTimeout(2200);
    const ready = await page.evaluate(() => { const c = document.getElementById('readyCard'); return c ? c.textContent : null; });
    if (!ready) errors.push('the ready-for-sea card is not on Plan');
    else if (/checking/.test(ready)) errors.push('the ready-for-sea card never filled in on Plan');
    if (!(await page.$('#btnPreloadAll'))) errors.push('the offline preload card is not on Plan');
    // and the weather thresholds are now part of Your boat
    await page.click('#tabs button[data-view=more]'); await page.waitForTimeout(700);
    await page.click('.view.active .subnav button:text-is("Boat")'); await page.waitForTimeout(700);
    if (!(await page.$('#thWindC'))) errors.push('the weather thresholds are not in Setup, Boat');
    console.log('Sections: both tabs walked, pre-departure cards on Plan, thresholds with the boat');
  });

  // 4. AIS over a mocked WebSocket. aisstream sends BINARY frames of UTF-8 JSON: read naively, event.data
  //    arrives as a Blob, JSON.parse throws, and every ship silently disappears. Prove a binary frame lands.
  await run('ais', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
    let subscription = null;
    await page.routeWebSocket(/stream\.aisstream\.io/, ws => {
      ws.onMessage(m => {
        subscription = String(m);
        ws.send(Buffer.from(JSON.stringify({
          MetaData: { MMSI: 987654321, ShipName: 'E2E CARGO@@@', latitude: 36.0, longitude: -5.5 },
          Message: { PositionReport: { Latitude: 36.0, Longitude: -5.5, Cog: 268, Sog: 14.2, TrueHeading: 268 } },
        }), 'utf8'));
      });
    });
    // routeWebSocket only applies to sockets opened after it is installed, and run() has already navigated.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.AIS && !!window.SAILY, null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    // Drive it the way a user does: paste the key into Setup. That must switch AIS on by itself.
    // AIS lives in the Data section now, so go there the way a person would.
    await page.click('#tabs button[data-view=more]');
    await page.waitForTimeout(700);
    await page.click('.view.active .subnav button:text-is("Data")');
    await page.waitForTimeout(700);
    await page.fill('#setAisKey', 'e2e-mock-key');
    await page.$eval('#setAisKey', el => el.blur());
    await page.waitForTimeout(2500);
    const autoOn = await page.$eval('#setAisOn', el => el.checked);
    if (!autoOn) errors.push('pasting an AIS key did not switch AIS on');
    const ais = await page.evaluate(() => ({
      binaryType: window.AIS.ws && window.AIS.ws.binaryType, status: window.AIS.status,
      frames: window.AIS.frames, targets: window.AIS.targets.size,
      name: (([...window.AIS.targets.values()][0] || {}).name) || null,
      sog: (([...window.AIS.targets.values()][0] || {}).sog),
    }));
    console.log('AIS over a binary frame:', JSON.stringify(ais));
    if (ais.binaryType !== 'arraybuffer') errors.push('AIS socket is not reading binary frames as ArrayBuffer');
    if (ais.targets !== 1) errors.push(`AIS binary frame produced ${ais.targets} targets, expected 1 (frames seen: ${ais.frames})`);
    if (ais.name !== 'E2E CARGO') errors.push('AIS ship name wrong or @-padding not stripped: ' + ais.name);
    const sub = subscription ? JSON.parse(subscription) : null;
    if (!sub) errors.push('AIS never sent a subscription');
    else {
      const box = sub.BoundingBoxes && sub.BoundingBoxes[0];
      if (!box || box[0][0] > box[1][0] || box[0][1] > box[1][1]) errors.push('AIS bounding box is not south-west then north-east: ' + JSON.stringify(box));
      if (!(sub.FilterMessageTypes || []).includes('StandardClassBPositionReport')) errors.push('AIS does not subscribe to Class B positions');
    }
    await page.evaluate(() => window.AIS.disconnect());
  });

  // 5. The passage log is calibration data: it sets cruise speed, and through it every ETA and the fuel
  //    figure. A leg the boat could not have sailed -- a GPS jump, a slept-through phone, a skipped
  //    waypoint -- must never reach it.
  await run('passagelog', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
    await page.waitForFunction(() => !!window.SAILY, null, { timeout: 15000 });
    await page.waitForTimeout(800);
    const seeded = await page.evaluate(() => {
      localStorage.setItem('saily.passages.v1', JSON.stringify([{
        id: 'run-e2e', startedAt: Date.now() - 3600000, endedAt: Date.now(), route: 'tarifa', boat: 'test boat',
        legs: [
          { from: 'A', to: 'B', distNm: 9.9, hours: 0.66, actualKn: 15.0, predictedKn: 21.0, reason: 'reached', cond: { wind: 18, wave: 1.4 } },
          { from: 'B', to: 'C', distNm: 5.8, hours: 0.36, actualKn: 16.1, predictedKn: 21.5, reason: 'reached', cond: { wind: 15, wave: 1.1 } },
          { from: 'C', to: 'D', distNm: 4.0, hours: 0.02, actualKn: 200, predictedKn: 21.0, reason: 'skipped', cond: null },
        ],
      }]));
      return true;
    });
    if (!seeded) errors.push('could not seed the passage log');
    await page.click('#tabs button[data-view=plan]'); await page.waitForTimeout(800);
    await page.click('.view.active .subnav button:text-is("Route")'); await page.waitForTimeout(500);
    await page.click('.view.active .subnav button:text-is("Log")'); await page.waitForTimeout(1000);
    const txt = await page.evaluate(() => document.querySelector('.view.active').innerText);
    if (!/slower than predicted/.test(txt)) errors.push('the log did not report the shortfall: ' + txt.slice(0, 160));
    if (!/skipped/.test(txt)) errors.push('a skipped leg is not marked as such');

    // calibrate: the 200 kn skipped leg must not drag the answer upwards
    const before = await page.evaluate(() => window.SAILY.S.settings.speed);
    page.on('dialog', d => d.accept());
    const cal = await page.$('[data-cal]');
    if (!cal) errors.push('no calibration offered for a passage that missed its prediction');
    else {
      await cal.click(); await page.waitForTimeout(1200);
      const after = await page.evaluate(() => window.SAILY.S.settings.speed);
      console.log(`Passage log: cruise speed ${before} -> ${after} kn from the recorded legs`);
      if (!(after < before)) errors.push(`calibration should have slowed the boat down: ${before} -> ${after}`);
      if (after > 20) errors.push(`the skipped 200 kn leg leaked into the calibration: ${after} kn`);
    }
  });

  // 6. Route editor: the leg check has to catch a route drawn over land, or drawing one here is worse
  //    than useless. Also checks the JSON it exports is the shape a passage file expects.
  await run('editor', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
    await page.waitForFunction(() => !!window.SAILY && !!window.CHART, null, { timeout: 15000 });

    // Discoverability is a feature: the editor was once the last of six unlabelled squares behind a
    // hamburger, and nobody found it. Check both ways in, by their labels.
    await page.click('#tabs button[data-view=plan]'); await page.waitForTimeout(900);
    const planBtn = await page.$('#btnPlanRoute');
    if (!planBtn) errors.push('the Plan tab has no button to plan a route');
    else {
      const label = (await planBtn.textContent()).toLowerCase();
      if (!/plan.*route/.test(label)) errors.push('the Plan tab button does not say what it does: ' + label);
      await planBtn.click(); await page.waitForTimeout(1000);
      if (!(await page.evaluate(() => document.body.classList.contains('editing')))) errors.push('the Plan tab button did not open the editor');
      if (!(await page.evaluate(() => document.getElementById('view-nav').classList.contains('active')))) errors.push('the Plan tab button did not switch to the chart');
      if (!(await page.evaluate(() => document.getElementById('startOverlay').classList.contains('hidden')))) errors.push('the editor opened behind the start overlay');
      await page.evaluate(() => window.SAILY.stopEdit()); await page.waitForTimeout(500);
    }
    await page.click('#tabs button[data-view=nav]'); await page.waitForTimeout(500);
    await page.click('#btnPlanOnly').catch(() => {});
    await page.waitForTimeout(800);
    await page.click('#btnMore'); await page.waitForTimeout(400);
    const menu = await page.evaluate(() => [...document.querySelectorAll('#mapControls .more button')].map(b => b.innerText.replace(/\s+/g, ' ').trim()));
    console.log('Map menu:', JSON.stringify(menu));
    if (!menu.some(t => /plan a route/i.test(t))) errors.push('the map menu does not name "Plan a route": ' + JSON.stringify(menu));
    await page.click('#btnEdit'); await page.waitForTimeout(900);
    if (!(await page.evaluate(() => document.body.classList.contains('editing')))) errors.push('editor did not open');
    const start = await page.evaluate(() => window.SAILY.S.edit.wps.length);
    if (start < 2) errors.push('editor did not load the active route');

    // the bundled route is verified: the editor must agree
    const clean = await page.evaluate(() => document.querySelector('#editPanel .verdictline').className);
    if (!/\bok\b/.test(clean)) errors.push('editor flags the bundled route, which the chart builder passes');

    // put a waypoint ashore, west of Gibraltar, and the leg must be flagged.
    // editPush first, exactly as the marker's dragstart handler does, so undo has something to restore.
    const flagged = await page.evaluate(() => {
      const S = window.SAILY.S;
      window.SAILY.editPush();
      S.edit.wps[3].lat = 36.13; S.edit.wps[3].lon = -5.35;
      window.SAILY.editRender();
      const v = document.querySelector('#editPanel .verdictline');
      return { cls: v.className, text: v.textContent, badRows: document.querySelectorAll('#editPanel tr.bad').length };
    });
    console.log('Editor with a waypoint ashore:', JSON.stringify(flagged));
    if (!/\bbad\b/.test(flagged.cls)) errors.push('editor did not flag a leg drawn over land');
    if (flagged.badRows < 1) errors.push('editor flagged no legs after a waypoint was moved ashore');

    // undo restores it
    await page.click('#edUndo'); await page.waitForTimeout(400);
    const undone = await page.evaluate(() => document.querySelector('#editPanel .verdictline').className);
    if (!/\bok\b/.test(undone)) errors.push('undo did not restore the route');

    // adding a waypoint by tapping the chart. Dismiss the alert banner first: it covers the top of the map.
    await page.evaluate(() => { const b = document.getElementById('alertBanner'); if (b) b.classList.add('hidden'); });
    const before = await page.evaluate(() => window.SAILY.S.edit.wps.length);
    // Leaflet swallows clicks while a zoom is animating: settle first, then tap.
    await page.evaluate(() => new Promise(res => {
      const m = window.SAILY.map;
      m.once('zoomend', () => setTimeout(res, 150));
      m.setZoom(9, { animate: false });
      setTimeout(res, 2000);
    }));
    await page.waitForTimeout(300);
    const box = await page.$eval('#mapWrap', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.touchscreen.tap(Math.round(box.x + box.w * 0.25), Math.round(box.y + box.h * 0.5));
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => window.SAILY.S.edit.wps.length);
    if (after !== before + 1) errors.push(`tapping the chart added ${after - before} waypoints, expected 1`);

    // the exported JSON is a passage route
    await page.click('#edJson'); await page.waitForTimeout(500);
    const json = await page.$eval('#edJsonText', el => el.value);
    let route = null;
    try { route = JSON.parse(json); } catch (e) { errors.push('exported route JSON does not parse: ' + e.message); }
    if (route) {
      console.log('Exported route:', JSON.stringify({ id: route.id, waypoints: route.waypoints.length, keys: Object.keys(route) }));
      for (const k of ['id', 'name', 'waypoints']) if (!(k in route)) errors.push('exported route is missing the required field ' + k);
      if ('legs' in route || 'total' in route) errors.push('exported route contains built fields (legs/total) that the passage schema rejects');
      const w = route.waypoints[0] || {};
      for (const k of ['id', 'name', 'lat', 'lon']) if (!(k in w)) errors.push('exported waypoint is missing ' + k);
      if (typeof w.lat !== 'number' || typeof w.lon !== 'number') errors.push('exported waypoint coordinates are not numbers');
    }
    await page.click('#edBack'); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'editor.png') });
    await page.click('#edClose'); await page.waitForTimeout(400);
    if (await page.evaluate(() => document.body.classList.contains('editing'))) errors.push('editor did not close');
  });

  await browser.close(); server.close();
  console.log('\nERRORS (' + errors.length + '):'); errors.forEach(e => console.log(' - ' + e));
  process.exit(errors.length ? 1 : 0);
})();
