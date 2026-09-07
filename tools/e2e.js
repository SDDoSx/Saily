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
  // 3. AIS over a mocked WebSocket. aisstream sends BINARY frames of UTF-8 JSON: read naively, event.data
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
    await page.click('#tabs button[data-view=more]');
    await page.waitForTimeout(600);
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

  await browser.close(); server.close();
  console.log('\nERRORS (' + errors.length + '):'); errors.forEach(e => console.log(' - ' + e));
  process.exit(errors.length ? 1 : 0);
})();
