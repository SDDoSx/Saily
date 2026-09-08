#!/usr/bin/env node
/* Everything, locally, with one command: the app and the chart service side by side.
 *
 *   npm run dev            app on :8080, chart service on :8787
 *
 * The chart service is optional. If Python or shapely is missing, the app still runs and this says so
 * rather than failing: the service is only needed to build a chart for an area that has none.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = process.env.SAILY_APP_PORT || 8080;
const API_PORT = process.env.PORT || 8787;
const children = [];

function pythonWithShapely() {
  for (const py of [process.env.SAILY_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(py, ['-c', 'import shapely, jsonschema'], { cwd: ROOT });
    if (r.status === 0) return py;
  }
  return null;
}

function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (line) => `[${name}] ${line}`;
  const pipe = (stream) => stream.on('data', d => String(d).replace(/\n$/, '').split('\n').forEach(l => console.log(tag(l))));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', code => { if (code !== 0 && code !== null) console.log(tag(`exited with ${code}`)); });
  children.push(p);
  return p;
}

function stopAll() { for (const c of children) { try { c.kill('SIGTERM'); } catch (e) { } } }
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });

start('app', process.execPath, [path.join('tools', 'serve.js')], { PORT: String(APP_PORT) });

const py = pythonWithShapely();
if (py) {
  start('charts', py, ['-m', 'server'], { PORT: String(API_PORT), SAILY_HOST: '127.0.0.1' });
} else {
  console.log('[charts] not started: no python with shapely and jsonschema.');
  console.log('[charts] pip install -r server/requirements.txt   (only needed to build a chart for a new area)');
}

setTimeout(() => {
  console.log('');
  console.log(`  app             http://localhost:${APP_PORT}/`);
  if (py) console.log(`  chart service   http://127.0.0.1:${API_PORT}/health`);
  console.log('  ctrl-c          stop both');
  console.log('');
}, 700);
