// Unit tests for the pure modules (no browser). Run: node tools/unit.js
// The assertions live in tests/nav.test.js (node:test); this entry point keeps the documented command and runs that same file.
// The full node:test suite (nav, weather, AIS) is `node --test tests/*.test.js`.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const file = path.join(__dirname, '..', 'tests', 'nav.test.js');
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { stdio: 'inherit' });
if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);
