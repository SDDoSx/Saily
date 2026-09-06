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
    const wxState = await page.evaluate(() => ({ hasWx: !!window.SAILY.S.wx, pts: window.SAILY.S.wx ? Object.keys(window.SAILY.S.wx.points) : [], errors: window.SAILY.S.wx ? window.SAILY.S.wx.errors : null }));
    console.log('Weather state:', JSON.stringify(wxState));
    // service worker + offline reload
    await page.click('#tabs button[data-view=nav]');
    const swReady = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; await new Promise(r => setTimeout(r, 1500)); return !!reg.active; });
    console.log('SW active:', swReady);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller);
    console.log('SW controlling after reload:', ctl);
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
    await ctx.setGeolocation({ latitude: 36.2856, longitude: -5.2710, accuracy: 8 });
    await page.waitForTimeout(2500);
    await ctx.setGeolocation({ latitude: 36.2825, longitude: -5.2630, accuracy: 8 });
    await page.waitForTimeout(2500);
    await ctx.setGeolocation({ latitude: 36.20, longitude: -5.295, accuracy: 8 });
    await page.waitForTimeout(2500);
    const s1 = await page.evaluate(() => ({ wp: document.getElementById('hudWpId').textContent, sog: document.getElementById('hudSog').textContent, cog: document.getElementById('hudCog').textContent, xte: document.getElementById('hudXte').textContent, gps: document.getElementById('gpsText').textContent }));
    console.log('Desktop after geolocation jumps:', JSON.stringify(s1));
    await ctx.setGeolocation({ latitude: 35.96, longitude: -5.70, accuracy: 8 }); // inside westbound lane (west)
    await page.waitForTimeout(2500);
    const zones = await page.evaluate(() => ({ zone: window.SAILY.S.zone, log: window.SAILY.S.log.slice(0, 4).map(l => l.level + ': ' + l.text) }));
    console.log('Zones at 35.96,-5.70:', JSON.stringify(zones));
    await page.screenshot({ path: path.join(OUT, 'desktop-nav.png') });
    await page.click('#tabs button[data-view=wx]'); await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'desktop-wx.png'), fullPage: true });
    await page.click('#tabs button[data-view=plan]'); await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'desktop-plan.png'), fullPage: true });
  });
  await browser.close(); server.close();
  console.log('\nERRORS (' + errors.length + '):'); errors.forEach(e => console.log(' - ' + e));
  process.exit(errors.length ? 1 : 0);
})();
