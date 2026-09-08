/* boot.js - choose the passage, then load the app around it.

   The passage is data, not a build-time constant: the catalogue in passages/index.json lists what is
   bundled, the chosen one is remembered per device, and everything after it is loaded in an order that
   guarantees the data exists before the code that reads it (weather.js takes its sample points,
   thresholds and time zone from PASSAGE the moment it runs).

   The single-file build inlines one passage and never loads this file. */
(function () {
  'use strict';
  var CATALOGUE = 'passages/index.json';
  var KEY = 'saily.passage.id';
  var CODE = ['nav.js', 'weather.js', 'ais.js', 'app.js'];
  var FALLBACK_ID = 'strait-of-gibraltar';   // only used when the catalogue cannot be fetched at all

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res;
      s.onerror = function () { rej(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }

  // --- passages this device built for itself -----------------------------------------------------
  // The chart service returns "window.CHART = {...};". Parse that rather than run it: the data is a
  // chart, and a chart should never be able to execute anything, whoever is hosting the service.
  var DEV_INDEX = 'saily.device.passages';
  var DEV_PREFIX = 'saily.device.passage.';
  function deviceIndex() {
    try { return JSON.parse(localStorage.getItem(DEV_INDEX) || '[]') || []; } catch (e) { return []; }
  }
  function parseAssign(text, name) {
    var src = String(text || '');
    var at = src.indexOf('=');
    if (at < 0 || src.slice(0, at).replace(/\s/g, '') !== 'window.' + name) throw new Error('not a ' + name + ' file');
    return JSON.parse(src.slice(at + 1).trim().replace(/;\s*$/, ''));
  }
  function loadDevice(id) {
    var raw = localStorage.getItem(DEV_PREFIX + id);
    if (!raw) throw new Error('this device has no passage ' + id);
    var saved = JSON.parse(raw);
    window.CHART = parseAssign(saved.chart, 'CHART');
    window.PASSAGE = parseAssign(saved.passage, 'PASSAGE');
  }

  function pick(list) {
    var want = stored();
    for (var i = 0; i < list.length; i++) if (list[i].id === want) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j]['default']) return list[j];
    return list[0] || null;
  }

  function fail(msg) {
    var o = document.getElementById('startOverlay');
    if (o) o.innerHTML = '<h1>Saily</h1><p><b>The app did not load.</b></p><p class="muted">' + msg +
      '</p><button class="bigbtn" onclick="location.reload()">Reload</button>';
  }

  // A page opened straight off the disk cannot fetch its own catalogue (file:// has no origin to fetch
  // from), but it can still load scripts. Fall back to the first passage directory so the chart opens.
  function withoutCatalogue(why) {
    var id = stored() || FALLBACK_ID;
    window.SAILY_PASSAGES = [];
    window.SAILY_PASSAGE_ID = id;
    return loadScript('passages/' + id + '/chart-data.js')
      .then(function () { return loadScript('passages/' + id + '/passage.js'); })
      .catch(function () { throw new Error(why); });
  }

  fetch(CATALOGUE, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .catch(function () { return []; })              // offline before the first install, or opened off the disk
    .then(function (list) {
      var device = deviceIndex();
      window.SAILY_PASSAGES = list.concat(device);
      var p = pick(window.SAILY_PASSAGES);
      if (!p) return withoutCatalogue('the passage catalogue is empty');
      window.SAILY_PASSAGE_ID = p.id;
      if (p.device) { loadDevice(p.id); return null; }
      return loadScript(p.chart).then(function () { return loadScript(p.passage); });
    })
    .then(function () {
      return CODE.reduce(function (chain, f) { return chain.then(function () { return loadScript(f); }); }, Promise.resolve());
    })
    .catch(function (e) {
      fail('Chart or passage data is missing (' + (e && e.message ? e.message : e) + '). This is normal offline before the first install: reload once you have signal.');
    });
})();
