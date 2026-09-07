// ESLint flat config (ESLint 9/10). Run: npx eslint .   CI runs it as a non-blocking step.
// Only two rules: undefined identifiers are errors, unused ones are warnings. No dependency on the `globals` package:
// the browser, service-worker and node globals the code uses are listed here.
'use strict';
const ro = names => Object.fromEntries(names.split(/\s+/).filter(Boolean).map(n => [n, 'readonly']));
const shared = ro('console setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone performance fetch Headers Request Response AbortController URL URLSearchParams TextEncoder TextDecoder Blob atob btoa crypto Intl WebSocket');
const browser = Object.assign(ro(`window document navigator location history screen self localStorage sessionStorage indexedDB caches requestAnimationFrame cancelAnimationFrame
  matchMedia getComputedStyle devicePixelRatio innerWidth innerHeight addEventListener removeEventListener dispatchEvent open scrollTo alert confirm prompt
  Event CustomEvent MouseEvent TouchEvent KeyboardEvent HTMLElement HTMLSelectElement Node Image FileReader DOMParser XMLSerializer Notification
  MutationObserver ResizeObserver IntersectionObserver AudioContext webkitAudioContext SpeechSynthesisUtterance speechSynthesis
  MessageChannel MessagePort BroadcastChannel Worker ServiceWorkerRegistration`), shared);
const serviceworker = Object.assign(ro('self caches clients registration skipWaiting location importScripts'), shared);
const node = Object.assign(ro('require module exports __dirname __filename process Buffer global globalThis setImmediate clearImmediate'), shared);

module.exports = [
  { ignores: ['site/vendor/**', 'site/chart-data.js', 'site/passage.js', 'dist/**', 'tools/out/**', 'node_modules/**', 'passages/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: Object.assign({}, node, browser) },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] },
  },
  { // the app: browser globals, Leaflet and the modules that attach themselves to window; nav/weather/ais also carry a UMD wrapper
    files: ['site/**/*.js'],
    languageOptions: { globals: Object.assign({}, browser, ro('L CHART PASSAGE NAV WX AIS SAILY SAILY_SINGLE EMBEDDED_WX module')) },
  },
  { files: ['site/sw.js'], languageOptions: { globals: serviceworker } },
  { files: ['tools/**/*.js', 'tests/**/*.js', 'eslint.config.js'], languageOptions: { globals: node } },
];
