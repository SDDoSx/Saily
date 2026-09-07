#!/usr/bin/env node
/* tools/replay.js - route replay harness (Playwright + Chromium).

   Serves site/, opens the real app on a phone viewport, and feeds GPS fixes that run EXACTLY along every bundled
   route's leg lines (window.PASSAGE.routes) at 3, 5 and 22 kn, every 3 s of simulated time, through
   window.SAILY.onFix(). The page clock (Date.now) follows the simulated time so that alert cooldowns, the
   fix-staleness gate and the GPS-lost timer behave as they would at sea, while the loop itself runs in seconds.
   Every alert in window.SAILY.S.log is recorded with the leg (from -> to), the position and the distance along
   the route.

   Assertions (exit code 1 on any failure):
     (a) no alert whose text starts with 'Land or rocks ahead' (a boat on its own verified leg lines must not be warned
         about land); the count is reported either way;
     (b) every 'danger' alert is a lane/zone entry ('Entering the WESTBOUND/EASTBOUND traffic lane', 'In the separation
         zone') on a leg that crosses that lane/zone, recomputed here by point-in-polygon against window.CHART.tss
         lanes/zones sampled along the leg (the builder prints the same information as LEG lines), or a hazard whose
         id is listed for that route/speed in the expected file;
     (c) the ordered sequence of zone entries/exits and 'Waypoint X reached' alerts equals
         passages/<passage-id>.expected.json for that route/speed.

   Usage: NODE_PATH=/opt/node22/lib/node_modules node tools/replay.js [--route <id>] [--speed <kn>] [--write]
                                                                     [--port <n>] [--batch <n>] [--quiet]
     --route <id>   only this route (repeatable)       --speed <kn>  only this speed (repeatable)
     --write        write the expected file from this run (prints a diff against the previous one)
     --port <n>     first port to try (default 8131, then upwards to 8199)
     --batch <n>    fixes per page.evaluate call (default 250)     --quiet  summary only
   Reports: tools/out/replay-<route>-<speed>.json. See docs/TESTING.md. */
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const N = require('../site/nav.js');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(__dirname, 'out');
const FIX = path.join(__dirname, 'fixtures');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SPEEDS = [3, 5, 22];
const STEP_S = 3;            // seconds of simulated time between fixes
const ACC_M = 8;             // reported accuracy of the synthetic fixes, metres
const MS_TO_KN = 1.943844;
const SAMPLE_NM = 0.005;     // sampling step of the leg-vs-polygon crossing test (about 9 m)
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml' };

// ---------- arguments ----------
const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 26).join('\n');
const opt = { routes: [], speeds: [], write: false, port: +(process.env.SAILY_REPLAY_PORT || 8131), batch: 250, quiet: false };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--route') opt.routes.push(a[++i]);
    else if (a[i] === '--speed') opt.speeds.push(+a[++i]);
    else if (a[i] === '--write') opt.write = true;
    else if (a[i] === '--port') opt.port = +a[++i];
    else if (a[i] === '--batch') opt.batch = Math.max(1, +a[++i] || 250);
    else if (a[i] === '--quiet') opt.quiet = true;
    else if (a[i] === '--help' || a[i] === '-h') { console.log(USAGE); process.exit(0); }
    else { console.error('unknown argument: ' + a[i] + '\n'); console.error(USAGE); process.exit(2); }
  }
  if (opt.speeds.some(s => !(s > 0))) { console.error('--speed needs a positive number of knots'); process.exit(2); }
}

// ---------- static server (same as tools/e2e.js) ----------
function serve(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(SITE, p);
      if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    });
    server.on('error', e => { if (e.code === 'EADDRINUSE' && port < 8199) resolve(serve(port + 1)); else reject(e); });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

// ---------- synthetic track along the leg lines ----------
/** fixes every STEP_S seconds along the great-circle leg lines; the last fix sits exactly on the final waypoint */
function planFixes(wps, speedKn, t0) {
  const legs = N.legs(wps);
  const total = legs.reduce((s, l) => s + l.dist, 0);
  const step = speedKn * STEP_S / 3600;
  const at = s => {
    let acc = 0;
    for (const l of legs) {
      if (s <= acc + l.dist + 1e-9 || l.i === legs.length - 1) {
        const p = N.destination(l.from, l.brg, Math.min(Math.max(0, s - acc), l.dist));
        return { leg: l.i, lat: p.lat, lon: p.lon, hdg: Math.round(l.brg * 10) / 10 };
      }
      acc += l.dist;
    }
    return null;
  };
  const fixes = []; let k = 0;
  for (let s = 0; s < total; s += step, k++) fixes.push(Object.assign({ i: k, t: t0 + k * STEP_S * 1000, along: s, spd: speedKn / MS_TO_KN }, at(s)));
  fixes.push(Object.assign({ i: k, t: t0 + Math.ceil(total / speedKn * 3600 * 1000), along: total, spd: speedKn / MS_TO_KN }, at(total)));
  return { fixes, legs, total };
}

/** which TSS polygons a leg line passes through: point-in-polygon on samples every SAMPLE_NM plus both ends */
function legCrossings(leg, polys) {
  const hit = new Set();
  const n = Math.max(1, Math.ceil(leg.dist / SAMPLE_NM));
  for (let k = 0; k <= n; k++) {
    const q = k === n ? leg.to : N.destination(leg.from, leg.brg, leg.dist * k / n);
    for (const z of polys) if (!hit.has(z.id) && N.pointInRings(q, z.rings)) hit.add(z.id);
  }
  return [...hit];
}

// ---------- alert classification (by text, ids resolved from the S.zone transitions of the same fix) ----------
const ZONE_IN = [ // pk = polygon kind in window.CHART.tss, used to resolve the id from the zone transitions of the same fix
  [/^Entering the WESTBOUND traffic lane/, { pk: 'lane', flow: 'W' }],
  [/^Entering the EASTBOUND traffic lane/, { pk: 'lane', flow: 'E' }],
  [/^In the separation zone/, { pk: 'zone' }],
  [/^Entering the Tanger-Med precautionary area/, { id: 'prec_tm' }],
  [/^Entering the precautionary area/, { id: 'prec_east' }],
  [/^In the Spanish inshore traffic zone/, { id: 'itz_n' }],
  [/^In the south-eastern inshore zone/, { id: 'itz_se' }],
  [/^In the Moroccan inshore traffic zone/, { id: 'itz_sw' }],
  [/^Off Tanger-Med/, { id: 'free_tm' }],
];
const ZONE_OUT = [
  [/^Clear of the westbound lane/, { pk: 'lane', flow: 'W' }],
  [/^Clear of the eastbound lane/, { pk: 'lane', flow: 'E' }],
  [/^Leaving the precautionary area/, { pk: 'prec' }],
  [/^Leaving the Spanish inshore zone/, { id: 'itz_n' }],
  [/^Leaving the Moroccan inshore zone/, { id: 'itz_sw' }],
  [/^Clear of the Tanger-Med approaches/, { id: 'free_tm' }],
];
const LAND_AHEAD = /^Land or rocks ahead/;
const WP_REACHED = /^Waypoint (\S+) reached\./;
const HAZARD = /^DANGER: /;

function classify(text) {
  const m = WP_REACHED.exec(text); if (m) return { kind: 'wp', id: m[1] };
  for (const [re, c] of ZONE_IN) if (re.test(text)) return Object.assign({ ev: 'zone-in' }, c);
  for (const [re, c] of ZONE_OUT) if (re.test(text)) return Object.assign({ ev: 'zone-out' }, c);
  if (LAND_AHEAD.test(text)) return { kind: 'land' };
  if (HAZARD.test(text)) return { kind: 'hazard' };
  return { kind: 'other' };
}

// ---------- expected file ----------
function expectedPath(passageId) { return path.join(ROOT, 'passages', passageId + '.expected.json'); }
function loadExpected(passageId) { try { return JSON.parse(fs.readFileSync(expectedPath(passageId), 'utf8')); } catch (e) { return null; } }
const tokenOf = s => `${s.ev} ${s.id} @ ${s.leg}`;
function diffLines(a, b) { // LCS line diff: ' ' same, '-' removed, '+' added
  const n = a.length, m = b.length; const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push('  ' + a[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push('- ' + a[i++]); else out.push('+ ' + b[j++]); }
  while (i < n) out.push('- ' + a[i++]);
  while (j < m) out.push('+ ' + b[j++]);
  return out;
}

// ---------- browser side ----------
/** runs in the page once: take over the GPS and the clock */
function pageTakeover() {
  const S = window.SAILY.S;
  S.settings.voice = false; S.navigating = true;
  if (S.watchId !== null) { try { navigator.geolocation.clearWatch(S.watchId); } catch (e) { } S.watchId = null; } // the harness is the GPS from here on
  const real = Date.now.bind(Date);
  window.__replayNow = real(); window.__replayRealNow = real;
  Date.now = () => window.__replayNow; // simulated clock: fix timestamps, alert cooldowns and the stale-fix gate stay consistent
  return { passage: window.PASSAGE.id, routes: window.PASSAGE.routes.map(r => ({ id: r.id, short: r.short, waypoints: r.waypoints.map(w => ({ id: w.id, name: w.name, lat: w.lat, lon: w.lon, radius: w.radius })) })),
    tss: ['lanes', 'zones', 'precautionary', 'itz', 'free'].map(k => (window.CHART.tss[k] || []).map(z => ({ id: z.id, kind: k === 'lanes' ? 'lane' : k === 'zones' ? 'zone' : k === 'precautionary' ? 'prec' : k, flow: z.flow || null, rings: z.rings }))).flat(),
    dangers: (S.dangers || window.PASSAGE.hazards).map(h => ({ id: h.id, name: h.name, level: h.level, lat: h.lat, lon: h.lon, radius: h.radius })),
    now: window.__replayNow };
}
/** runs in the page before each route: fresh navigation state, active waypoint 1 */
function pageSetup(routeId) {
  const S = window.SAILY.S, P = window.PASSAGE;
  S.route = P.routes.find(r => r.id === routeId); S.settings.routeId = routeId;
  S.settings.wp = 1; S.manualWp = false;
  S.zone = {}; S.zonePending = {}; S.hazard = {}; S.hazardNear = {}; S.hazPending = {}; S.approached = {}; S.arrivedFinal = false; S.holdToast = false;
  S.alertLast = {}; S.log = []; S.fixes = []; S.track = []; S.smoother.reset(); S.sog = null; S.cog = null; S.pos = null; S.solution = null;
  S.lastKnown = null; S.lastGood = null; S.landAheadPrev = undefined; S.gpsLost = false; S.mob = null;
  S.sunsetWarned = true; S.nightNoted = true; // time-of-day alerts depend on the wall clock, not on the route
  window.SAILY.processFix();
  return { wp: S.settings.wp, route: S.route.id };
}
/** runs in the page per batch: feed fixes, return the alerts and zone transitions of each fix */
function pageFeed(fixes) {
  const S = window.SAILY.S; const events = []; const debug = [];
  S.log = []; let prevLen = 0;
  let before = Object.assign({}, S.zone);
  for (const f of fixes) {
    window.__replayNow = f.t;
    window.SAILY.onFix({ coords: { latitude: f.lat, longitude: f.lon, accuracy: f.acc, altitude: null, altitudeAccuracy: null, speed: f.spd, heading: f.hdg }, timestamp: f.t });
    const trans = [];
    for (const k of new Set(Object.keys(before).concat(Object.keys(S.zone)))) if (!!before[k] !== !!S.zone[k]) trans.push({ id: k, inside: !!S.zone[k] });
    before = Object.assign({}, S.zone);
    const n = S.log.length - prevLen;
    const alerts = n > 0 ? S.log.slice(0, n).reverse().map(l => ({ level: l.level, text: l.text, t: l.t })) : [];
    if (S.log.length > 150) { S.log = []; prevLen = 0; } else prevLen = S.log.length; // the app caps its log at 200 entries
    if (alerts.length || trans.length) events.push({ i: f.i, alerts, trans, wp: S.settings.wp, sog: S.sog, cog: S.cog, grade: S.fixGrade || null });
  }
  return { events, debug, wp: S.settings.wp, arrived: !!S.arrivedFinal, gps: document.getElementById('gpsText').textContent, fixes: S.fixes.length };
}

// ---------- one route at one speed ----------
async function runRoute(page, ctx, route, speed, t0) {
  const plan = planFixes(route.waypoints, speed, t0);
  const polys = ctx.tss.filter(z => z.kind === 'lane' || z.kind === 'zone');
  const legs = plan.legs.map(l => ({ i: l.i, from: l.from.id, to: l.to.id, dist: +l.dist.toFixed(3), brg: Math.round(l.brg), crosses: legCrossings(l, polys), passes: legCrossings(l, ctx.tss.filter(z => z.kind === 'prec')) }));
  const setup = await page.evaluate(pageSetup, route.id);
  if (setup.wp !== 1 || setup.route !== route.id) throw new Error('route setup failed: ' + JSON.stringify(setup));
  const events = []; let last = null; let fed = 0;
  const started = Date.now();
  for (let i = 0; i < plan.fixes.length; i += opt.batch) {
    const chunk = plan.fixes.slice(i, i + opt.batch).map(f => ({ i: f.i, t: f.t, lat: f.lat, lon: f.lon, hdg: f.hdg, spd: f.spd, acc: ACC_M }));
    last = await page.evaluate(pageFeed, chunk);
    events.push(...last.events); fed += chunk.length;
    await new Promise(r => setTimeout(r, 3)); // a few ms between batches: timers and the map get a turn
  }
  const zoneById = Object.fromEntries(ctx.tss.map(z => [z.id, z]));
  const hazByName = ctx.dangers.filter(h => h.level === 'danger');
  const alerts = []; const sequence = []; const transitions = [];
  for (const e of events) {
    const fix = plan.fixes[e.i]; const leg = legs[fix.leg]; const legName = `${leg.from}>${leg.to}`;
    const used = new Set();
    for (const tr of e.trans) transitions.push({ fix: e.i, along: +fix.along.toFixed(3), leg: legName, id: tr.id, inside: tr.inside });
    for (const a of e.alerts) {
      const c = classify(a.text);
      const rec = { n: alerts.length + 1, fix: e.i, t: a.t, simMin: +((fix.t - t0) / 60000).toFixed(1), along: +fix.along.toFixed(3), leg: legName, legIndex: fix.leg, lat: +fix.lat.toFixed(5), lon: +fix.lon.toFixed(5), wp: e.wp, level: a.level, text: a.text, kind: c.ev || c.kind };
      if (c.ev) { // zone entry/exit: resolve the polygon id from the transitions of this fix
        const want = c.ev === 'zone-in';
        const tr = e.trans.find((t, k) => !used.has(k) && t.inside === want && (c.id ? t.id === c.id : (zoneById[t.id] && zoneById[t.id].kind === c.pk && (!c.flow || zoneById[t.id].flow === c.flow))));
        if (tr) { used.add(e.trans.indexOf(tr)); rec.zoneId = tr.id; } else { rec.zoneId = c.id || (c.pk + (c.flow ? '-' + c.flow : '')); rec.unresolved = true; }
        sequence.push({ ev: c.ev, id: rec.zoneId, leg: legName });
      } else if (c.kind === 'wp') { rec.wpId = c.id; sequence.push({ ev: 'wp', id: c.id, leg: legName }); }
      else if (c.kind === 'hazard') { const h = hazByName.find(h => a.text.startsWith(`DANGER: ${h.name}. `)); rec.hazardId = h ? h.id : null; }
      alerts.push(rec);
    }
  }
  const counts = { total: alerts.length, danger: 0, warn: 0, info: 0 };
  for (const a of alerts) counts[a.level] = (counts[a.level] || 0) + 1;
  return { route: route.id, speed, t0, tEnd: plan.fixes[plan.fixes.length - 1].t, fixes: fed, totalNm: +plan.total.toFixed(2), simHours: +(plan.total / speed).toFixed(2), wallSeconds: +((Date.now() - started) / 1000).toFixed(1),
    finalWp: last.wp, arrivedFinal: last.arrived, gps: last.gps, legs, alerts, transitions, sequence, counts };
}

// ---------- assertions ----------
function assess(run, expected, ctx) {
  const failures = [];
  const land = run.alerts.filter(a => a.kind === 'land');
  const a = { pass: land.length === 0, count: land.length, first: land[0] || null };
  if (!a.pass) failures.push(`(a) ${land.length} 'Land or rocks ahead' alert(s), first at ${land[0].along} nm on ${land[0].leg}: "${land[0].text}"`);
  const exp = expected && expected.routes && expected.routes[run.route] && expected.routes[run.route][String(run.speed)];
  const allowedHaz = new Set((exp && exp.hazards) || []);
  const b = { pass: true, failures: [], hazards: [] };
  const legByName = Object.fromEntries(run.legs.map(l => [`${l.from}>${l.to}`, l]));
  for (const al of run.alerts) {
    if (al.level !== 'danger' || al.kind === 'land') continue; // land-ahead is reported under (a)
    if (al.kind === 'zone-in') {
      const cr = legByName[al.leg].crosses;
      const ok = al.unresolved ? cr.length > 0 : cr.includes(al.zoneId);
      if (!ok) b.failures.push(`#${al.n} ${al.zoneId} entry on ${al.leg} which does not cross it (leg crosses: ${cr.join(',') || 'nothing'})`);
    } else if (al.kind === 'hazard') {
      b.hazards.push(al.hazardId);
      if (!al.hazardId) b.failures.push(`#${al.n} hazard alert with an unknown hazard: "${al.text.slice(0, 60)}"`);
      else if (!allowedHaz.has(al.hazardId) && !opt.write) b.failures.push(`#${al.n} hazard '${al.hazardId}' on ${al.leg} is not listed in the expected file`);
    } else b.failures.push(`#${al.n} unexpected danger alert on ${al.leg}: "${al.text.slice(0, 80)}"`);
  }
  b.pass = b.failures.length === 0; failures.push(...b.failures.map(f => '(b) ' + f));
  const actual = run.sequence.map(tokenOf);
  const c = { pass: true, expectedFound: !!exp, diff: [] };
  if (opt.write) { c.written = true; }
  else if (!exp) { c.pass = false; failures.push(`(c) no expected entry for ${run.route} @ ${run.speed} kn in ${path.relative(ROOT, expectedPath(ctx.passage))}: run with --write`); }
  else {
    const want = exp.sequence.map(tokenOf);
    if (JSON.stringify(want) !== JSON.stringify(actual)) { c.pass = false; c.diff = diffLines(want, actual); failures.push(`(c) sequence differs from the expected file (${want.length} expected, ${actual.length} actual):\n      ` + c.diff.filter(l => l[0] !== ' ').join('\n      ')); }
  }
  return { a, b, c, failures, pass: failures.length === 0 };
}

// ---------- output ----------
const pad = (s, n) => String(s).padEnd(n);
function printRun(run, res) {
  console.log(`\n=== ${run.route} @ ${run.speed} kn: ${run.fixes} fixes, ${run.totalNm} nm, ${run.simHours} h simulated in ${run.wallSeconds} s, final WP ${run.finalWp}${run.arrivedFinal ? ' (arrived)' : ' (NOT arrived)'}, ${run.counts.total} alerts (${run.counts.danger} danger, ${run.counts.warn} warn, ${run.counts.info} info)`);
  console.log('legs crossing lanes/zones: ' + (run.legs.filter(l => l.crosses.length).map(l => `${l.from}>${l.to} [${l.crosses.join(',')}]`).join('; ') || 'none') + (run.legs.some(l => l.passes.length) ? '; precautionary: ' + run.legs.filter(l => l.passes.length).map(l => `${l.from}>${l.to} [${l.passes.join(',')}]`).join('; ') : ''));
  if (!opt.quiet) {
    console.log(pad('#', 4) + pad('nm', 8) + pad('t+min', 7) + pad('leg', 20) + pad('level', 7) + 'alert');
    for (const a of run.alerts) console.log(pad(a.n, 4) + pad(a.along.toFixed(2), 8) + pad(a.simMin, 7) + pad(a.leg, 20) + pad(a.level, 7) + a.text.slice(0, 110) + (a.text.length > 110 ? '…' : '') + (a.zoneId ? `  [${a.zoneId}${a.unresolved ? '?' : ''}]` : '') + (a.hazardId ? `  [${a.hazardId}]` : ''));
    const silent = run.transitions.filter(t => !run.alerts.some(a => a.fix === t.fix && a.zoneId === t.id));
    if (silent.length) console.log('zone transitions without an alert: ' + silent.map(t => `${t.inside ? 'in' : 'out'}:${t.id}@${t.leg}(${t.along} nm)`).join(', '));
  }
  for (const f of res.failures) console.log('FAIL ' + f);
  if (res.pass) console.log(`PASS (a) land-ahead ${res.a.count}, (b) danger alerts justified, (c) sequence ${opt.write ? 'written' : 'matches'} (${run.sequence.length} entries)`);
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, port } = await serve(opt.port);
  const browser = await chromium.launch(Object.assign({ args: ['--no-sandbox'] }, (process.env.SAILY_CHROMIUM !== 'default' && fs.existsSync(EXE)) ? { executablePath: EXE } : {}));
  const tile = fs.readFileSync(path.join(FIX, 'tile.png'));
  const errors = []; const debugLines = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['geolocation'],
    geolocation: { latitude: 36.2882, longitude: -5.2703, accuracy: 10 }, locale: 'en-GB', timezoneId: 'Europe/Madrid', serviceWorkers: 'block' });
  const page = await context.newPage();
  // no egress: tiles come from a fixture, the forecast fails fast so no wall-clock-dependent weather alerts join the replay
  await page.route(u => /^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(u.href), r => /open-meteo\.com/.test(r.request().url()) ? r.abort() : r.fulfill({ status: 200, contentType: 'image/png', body: tile }));
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { const t = m.text(); if (t.startsWith('LANDAHEAD')) debugLines.push(t); else if (m.type() === 'error' && !/open-meteo\.com|ERR_FAILED|Failed to load resource/.test(t)) errors.push('console: ' + t); });
  let exitCode = 0;
  const summary = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btnStart');
    await page.waitForTimeout(800);
    await page.click('#btnPlanOnly');
    await page.waitForFunction(() => window.SAILY && window.SAILY.S.pos !== null, null, { timeout: 8000 }).catch(() => console.log('note: no geolocation fix from the browser within 8 s, continuing'));
    await page.waitForTimeout(500);
    const ctx = await page.evaluate(pageTakeover);
    const routes = ctx.routes.filter(r => !opt.routes.length || opt.routes.includes(r.id));
    const speeds = opt.speeds.length ? opt.speeds : SPEEDS;
    for (const id of opt.routes) if (!ctx.routes.some(r => r.id === id)) throw new Error(`unknown route '${id}'; bundled: ${ctx.routes.map(r => r.id).join(', ')}`);
    const expected = loadExpected(ctx.passage);
    const newExpected = expected ? JSON.parse(JSON.stringify(expected)) : { passage: ctx.passage, generatedBy: 'tools/replay.js --write', routes: {} };
    console.log(`passage ${ctx.passage}: routes ${routes.map(r => r.id).join(', ')} at ${speeds.join('/')} kn; fixes every ${STEP_S} s; ${ctx.tss.length} TSS polygons; ${ctx.dangers.length} danger circles; port ${port}`);
    let t0 = ctx.now;
    for (const route of routes) for (const speed of speeds) {
      const run = await runRoute(page, ctx, route, speed, t0);
      t0 = run.tEnd + 60000;
      const res = assess(run, expected, ctx);
      if (opt.write) {
        const prev = expected && expected.routes && expected.routes[route.id] && expected.routes[route.id][String(speed)];
        const entry = { hazards: [...new Set(res.b.hazards.filter(Boolean))].sort(), sequence: run.sequence };
        newExpected.routes[route.id] = newExpected.routes[route.id] || {}; newExpected.routes[route.id][String(speed)] = entry;
        const d = diffLines(prev ? prev.sequence.map(tokenOf) : [], run.sequence.map(tokenOf));
        res.c.diff = d;
        run.expectedDiff = d.filter(l => l[0] !== ' ');
      }
      run.assertions = res; run.pageErrors = errors.slice(); run.landAheadDebug = debugLines.splice(0);
      printRun(run, res);
      if (opt.write) {
        const changed = res.c.diff.filter(l => l[0] !== ' ');
        console.log(changed.length ? `expected ${route.id} @ ${speed} kn: ${changed.length} line(s) changed vs the previous file:\n  ` + changed.join('\n  ') : `expected ${route.id} @ ${speed} kn: unchanged (${run.sequence.length} entries)`);
      }
      fs.writeFileSync(path.join(OUT, `replay-${route.id}-${speed}.json`), JSON.stringify(Object.assign({ passage: ctx.passage, generatedAt: new Date().toISOString(), stepSeconds: STEP_S }, run), null, 1));
      summary.push({ route: route.id, kn: speed, fixes: run.fixes, alerts: run.counts.total, danger: run.counts.danger, warn: run.counts.warn, info: run.counts.info, landAhead: res.a.count, seq: run.sequence.length, a: res.a.pass ? 'ok' : 'FAIL', b: res.b.pass ? 'ok' : 'FAIL', c: opt.write ? 'written' : res.c.pass ? 'ok' : 'FAIL' });
      if (!res.pass) exitCode = 1;
    }
    if (opt.write) {
      newExpected.updatedAt = new Date().toISOString(); newExpected.stepSeconds = STEP_S;
      fs.writeFileSync(expectedPath(ctx.passage), JSON.stringify(newExpected, null, 1) + '\n');
      console.log('\nwrote ' + path.relative(ROOT, expectedPath(ctx.passage)));
    }
  } catch (e) { errors.push('harness: ' + (e.stack || e.message)); exitCode = 1; }
  await browser.close(); server.close();
  if (summary.length) { console.log('\nSummary (alerts per route and speed):'); console.table(summary); }
  if (errors.length) { console.log('ERRORS (' + errors.length + '):'); errors.forEach(e => console.log(' - ' + e)); exitCode = 1; }
  console.log(exitCode ? 'REPLAY FAILED' : 'REPLAY OK');
  process.exit(exitCode);
})();
