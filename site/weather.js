/* weather.js - Open-Meteo forecast + marine fetch, caching, thresholds and warnings. */
(function (root) {
  'use strict';
  const PZ = root.PASSAGE || {};
  const POINTS = PZ.weatherPoints || [
    { id: 'soto', name: 'Sotogrande offing', lat: 36.27, lon: -5.24, routeNm: 0.5 },
    { id: 'europa', name: 'Europa Point / Strait east', lat: 36.08, lon: -5.36, routeNm: 12.5 },
    { id: 'tarifa', name: 'Tarifa', lat: 35.97, lon: -5.62, routeNm: 27.3 },
    { id: 'cross', name: 'Mid-crossing (TSS)', lat: 35.92, lon: -5.70, routeNm: 34.5 },
    { id: 'tangier', name: 'Tangier Bay', lat: 35.81, lon: -5.77, routeNm: 43.0 },
  ];
  const FC_VARS = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,precipitation,temperature_2m,weather_code,cloud_cover';
  const MARINE_VARS = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,ocean_current_velocity,ocean_current_direction,sea_level_height_msl';
  const TZ = (PZ.tz && PZ.tz.from && PZ.tz.from.zone) || 'Europe/Madrid';
  const KEY = 'saily.weather.v1';

  const DEFAULT_THRESHOLDS = Object.assign({
    windCaution: 14, windNoGo: 20,      // kn sustained at 10 m
    gustCaution: 22, gustNoGo: 30,      // kn
    waveCaution: 1.0, waveNoGo: 1.6,    // m significant wave height (36 ft planing hull)
    currentCaution: 2.0,                // kn
    visCaution: 5000,                   // m
  }, PZ.thresholds || {});

  function fcUrl(p, days) {
    return `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=${FC_VARS}&daily=sunrise,sunset&wind_speed_unit=kn&timezone=${encodeURIComponent(TZ)}&forecast_days=${days || 5}`;
  }
  function marineUrl(p, days) {
    return `https://marine-api.open-meteo.com/v1/marine?latitude=${p.lat}&longitude=${p.lon}&hourly=${MARINE_VARS}&cell_selection=sea&timezone=${encodeURIComponent(TZ)}&forecast_days=${days || 5}`;
  }

  async function fetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (r.headers.get('X-Saily-Cache') === 'stale') j.__stale = true; // served by the service worker from its cache while offline
      return j;
    } finally { clearTimeout(t); }
  }

  /** merge hourly arrays of forecast + marine into rows keyed by ISO local time */
  function mergeHourly(fc, mar) {
    const rows = [];
    const fh = fc && fc.hourly, mh = mar && mar.hourly;
    const times = (fh && fh.time) || (mh && mh.time) || [];
    const v = (arr, i) => (arr && arr[i] !== undefined) ? arr[i] : null;
    for (let i = 0; i < times.length; i++) {
      const row = { time: times[i] };
      if (fh) {
        row.wind = v(fh.wind_speed_10m, i); row.windDir = v(fh.wind_direction_10m, i); row.gust = v(fh.wind_gusts_10m, i);
        row.vis = v(fh.visibility, i); row.rain = v(fh.precipitation, i); row.temp = v(fh.temperature_2m, i);
        row.code = v(fh.weather_code, i); row.cloud = v(fh.cloud_cover, i);
      }
      if (mh && mh.time) {
        const j = mh.time.indexOf(times[i]);
        if (j >= 0) {
          row.wave = v(mh.wave_height, j); row.waveDir = v(mh.wave_direction, j); row.wavePeriod = v(mh.wave_period, j);
          row.swell = v(mh.swell_wave_height, j); row.swellDir = v(mh.swell_wave_direction, j); row.swellPeriod = v(mh.swell_wave_period, j);
          row.windWave = v(mh.wind_wave_height, j);
          const cur = v(mh.ocean_current_velocity, j);
          row.current = cur === null ? null : cur / 1.852; // km/h -> kn
          row.currentDir = v(mh.ocean_current_direction, j);
          row.seaLevel = v(mh.sea_level_height_msl, j);
        }
      }
      rows.push(row);
    }
    return rows;
  }

  /** fetch every point; keeps previous data for points that fail; detects stale (offline) responses */
  async function fetchAll(days, onProgress, previous) {
    days = days || 5;
    const now = Date.now();
    const out = { fetchedAt: now, points: {}, errors: [], stale: false };
    let n = 0, fresh = 0, staleCount = 0;
    for (const p of POINTS) {
      let fc = null, mar = null;
      const [fr, mr] = await Promise.all([fetchJson(fcUrl(p, days)).catch(e => ({ __err: e.message })), fetchJson(marineUrl(p, days)).catch(e => ({ __err: e.message }))]);
      if (fr && fr.__err) out.errors.push(p.id + ' wind: ' + fr.__err); else fc = fr;
      if (mr && mr.__err) out.errors.push(p.id + ' marine: ' + mr.__err); else mar = mr;
      if (fc && !mar) { try { mar = await fetchJson(marineUrl(p, days)); } catch (e) { } } // one retry for the failed half
      if (mar && !fc) { try { fc = await fetchJson(fcUrl(p, days)); } catch (e) { } }
      const stale = !!((fc && fc.__stale) || (mar && mar.__stale));
      if ((fc || mar) && !stale) {
        out.points[p.id] = { ...p, rows: mergeHourly(fc, mar), sunrise: fc && fc.daily ? fc.daily.sunrise : null, sunset: fc && fc.daily ? fc.daily.sunset : null, utcOffset: (fc || mar).utc_offset_seconds, fetchedAt: now };
        fresh++;
      } else if (previous && previous.points && previous.points[p.id]) {
        out.points[p.id] = previous.points[p.id]; // keep what we had
        if (stale) staleCount++;
      } else if (fc || mar) { // stale but nothing better stored
        out.points[p.id] = { ...p, rows: mergeHourly(fc, mar), sunrise: fc && fc.daily ? fc.daily.sunrise : null, sunset: fc && fc.daily ? fc.daily.sunset : null, utcOffset: (fc || mar).utc_offset_seconds, fetchedAt: (previous && previous.fetchedAt) || 0 };
        staleCount++;
      }
      n++; if (onProgress) onProgress(n, POINTS.length);
    }
    if (fresh === 0) { out.stale = true; out.fetchedAt = (previous && previous.fetchedAt) || Math.min(...Object.values(out.points).map(x => x.fetchedAt || 0), now); }
    if (Object.keys(out.points).length && fresh > 0) save(out);
    return out;
  }

  /** build a weather data object from raw API responses {id: {fc, mar}} (used for embedded snapshots) */
  function fromRaw(raw, fetchedAt) {
    const out = { fetchedAt: fetchedAt || Date.now(), points: {}, errors: [], embedded: true };
    for (const p of POINTS) {
      const r = raw && raw[p.id]; if (!r || (!r.fc && !r.mar)) continue;
      const fc = r.fc, mar = r.mar;
      out.points[p.id] = { ...p, rows: mergeHourly(fc, mar), sunrise: fc && fc.daily ? fc.daily.sunrise : null, sunset: fc && fc.daily ? fc.daily.sunset : null, utcOffset: (fc || mar).utc_offset_seconds };
    }
    return out;
  }

  function save(data) { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* quota */ } }
  function load() { try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  /** row for a given Date at a point (nearest hour, local Madrid time strings from API) */
  function rowAt(point, date) {
    if (!point || !point.rows || !point.rows.length) return null;
    // API times are local (Europe/Madrid) without offset. Convert date -> Madrid local ISO 'YYYY-MM-DDTHH:00'.
    const local = madridLocalIso(date);
    let best = null, bestDiff = Infinity;
    for (const r of point.rows) {
      const diff = Math.abs(hourIndex(r.time) - hourIndex(local));
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    return bestDiff <= 1.01 ? best : null;
  }
  function hourIndex(iso) { // 'YYYY-MM-DDTHH:MM' -> hours since epoch-ish (calendar based; good enough within one forecast)
    const d = new Date(iso + ':00Z'); return d.getTime() / 3600000;
  }
  function madridLocalIso(date) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const g = t => parts.find(p => p.type === t).value;
    let hh = g('hour'); if (hh === '24') hh = '00';
    return `${g('year')}-${g('month')}-${g('day')}T${hh}:${g('minute')}`;
  }

  /** classify one row against thresholds -> {level: 'ok'|'caution'|'nogo', reasons:[]} */
  /** classify one hour: returns {level, reasons: [text], items: [{key, level 1|2, value, threshold, text}]} */
  function classify(row, th, course) {
    th = th || DEFAULT_THRESHOLDS;
    const items = [];
    let level = 0; // 0 ok, 1 caution, 2 nogo
    const bump = (l, key, value, threshold, text) => { level = Math.max(level, l); items.push({ key, level: l, value, threshold, text }); };
    if (row.wind != null) {
      if (row.wind >= th.windNoGo) bump(2, 'wind', row.wind, th.windNoGo, `wind ${Math.round(row.wind)} kn`);
      else if (row.wind >= th.windCaution) bump(1, 'wind', row.wind, th.windCaution, `wind ${Math.round(row.wind)} kn`);
    }
    if (row.gust != null) {
      if (row.gust >= th.gustNoGo) bump(2, 'gust', row.gust, th.gustNoGo, `gusts ${Math.round(row.gust)} kn`);
      else if (row.gust >= th.gustCaution) bump(1, 'gust', row.gust, th.gustCaution, `gusts ${Math.round(row.gust)} kn`);
    }
    if (row.wave != null) {
      if (row.wave >= th.waveNoGo) bump(2, 'wave', row.wave, th.waveNoGo, `waves ${row.wave.toFixed(1)} m`);
      else if (row.wave >= th.waveCaution) bump(1, 'wave', row.wave, th.waveCaution, `waves ${row.wave.toFixed(1)} m`);
    }
    if (row.current != null && row.current >= th.currentCaution) bump(1, 'current', row.current, th.currentCaution, `current ${row.current.toFixed(1)} kn`);
    if (row.vis != null && row.vis < th.visCaution) bump(1, 'vis', row.vis, th.visCaution, `visibility ${(row.vis / 1000).toFixed(1)} km`);
    if (row.wind != null && row.windDir != null && row.currentDir != null && row.current != null && row.current >= 1.0 && row.wind >= 12) {
      const rel = root.NAV.windVsCurrent(row.windDir, row.currentDir);
      if (rel === 'against') bump(1, 'windcur', row.current, 1.0, 'wind against current: steep seas');
    }
    if (row.wavePeriod != null && row.wave != null && row.wave >= 0.8 && row.wavePeriod <= 4.5) bump(1, 'steep', row.wavePeriod, 4.5, 'short steep waves');
    if (row.rain != null && row.rain >= 2) bump(1, 'rain', row.rain, 2, `rain ${row.rain} mm/h`);
    if (row.code != null && (row.code === 45 || row.code === 48)) bump(1, 'fog', row.code, 0, 'fog forecast');
    if (row.code != null && row.code >= 95) bump(2, 'thunder', row.code, 0, 'thunderstorm forecast');
    if (course != null && row.wave != null && row.waveDir != null && row.wave >= 0.8) {
      const asp = root.NAV.seaAspect(row.waveDir, course);
      if (asp === 'beam') bump(1, 'beam', row.wave, 0.8, `beam sea ${row.wave.toFixed(1)} m (rolling)`);
      else if (asp === 'head' && row.wave >= 1.0) bump(1, 'head', row.wave, 1.0, `head sea ${row.wave.toFixed(1)} m (slamming, slow down)`);
    }
    return { level: ['ok', 'caution', 'nogo'][level], reasons: items.map(i => i.text), items };
  }

  /** passage plan: for departure time + speed, row at each point when passing it */
  function passage(data, departure, speedKn, th, routeWps) {
    const out = [];
    if (!data) return out;
    for (const p of POINTS) {
      const pt = data.points[p.id];
      if (!pt) continue;
      const when = new Date(departure.getTime() + p.routeNm / speedKn * 3600000);
      const row = rowAt(pt, when);
      const course = routeWps ? root.NAV.courseAtNm(routeWps, p.routeNm) : null;
      out.push({ point: pt, when, row, course, verdict: row ? classify(row, th, course) : null });
    }
    return out;
  }
  /** remaining passage from the current position: points ahead of doneNm, sampled when we reach them */
  function remainingPassage(data, wps, doneNm, now, sogKn, planKn, th) {
    const out = [];
    if (!data) return out;
    const v = Math.max((sogKn && sogKn > 3) ? sogKn : (planKn || 10), 5);
    for (const p of POINTS) {
      if (p.routeNm <= doneNm) continue;
      const pt = data.points[p.id]; if (!pt) continue;
      const when = new Date(now.getTime() + (p.routeNm - doneNm) / v * 3600000);
      const row = rowAt(pt, when);
      const course = wps ? root.NAV.courseAtNm(wps, p.routeNm) : null;
      out.push({ point: pt, when, row, course, verdict: row ? classify(row, th, course) : null });
    }
    return out;
  }
  /** turn back or carry on: verdicts for the way back (points behind, reversed) and the way on */
  function abortCompare(data, wps, doneNm, totalNm, now, sogKn, planKn, th) {
    const v = Math.max((sogKn && sogKn > 3) ? sogKn : (planKn || 10), 5);
    const on = remainingPassage(data, wps, doneNm, now, sogKn, planKn, th);
    const back = [];
    for (const p of POINTS.slice().reverse()) {
      if (p.routeNm >= doneNm) continue;
      const pt = data && data.points[p.id]; if (!pt) continue;
      const when = new Date(now.getTime() + (doneNm - p.routeNm) / v * 3600000);
      const row = rowAt(pt, when);
      const course = wps ? root.NAV.norm360(root.NAV.courseAtNm(wps, p.routeNm) + 180) : null;
      back.push({ point: pt, when, row, course, verdict: row ? classify(row, th, course) : null });
    }
    return { on: overall(on), back: overall(back), onMin: Math.round((totalNm - doneNm) / v * 60), backMin: Math.round(doneNm / v * 60), onPass: on, backPass: back };
  }
  /** forecast coverage: last hour available (local ISO) */
  function coverageEnd(data) { let end = null; for (const pt of Object.values((data && data.points) || {})) { const t = pt.rows.length ? pt.rows[pt.rows.length - 1].time : null; if (t && (!end || t < end)) end = t; } return end; }
  /** scan departure times every hour over the next `hours`, return [{dep, overall, maxWind, maxGust, maxWave}] */
  function departureScan(data, fromDate, hours, speedKn, th, routeWps) {
    const out = [];
    if (!data) return out;
    const start = new Date(fromDate); start.setMinutes(0, 0, 0);
    for (let h = 0; h < hours; h++) {
      const dep = new Date(start.getTime() + h * 3600000);
      const pass = passage(data, dep, speedKn, th, routeWps);
      const rows = pass.map(s => s.row).filter(Boolean);
      const mx = k => rows.length ? Math.max(...rows.map(r => r[k] == null ? -1 : r[k])) : null;
      out.push({ dep, overall: overall(pass), maxWind: mx('wind'), maxGust: mx('gust'), maxWave: mx('wave'), pass });
    }
    return out;
  }

  const KEYNAME = { wind: 'Wind', gust: 'Gusts', wave: 'Waves', current: 'Current', vis: 'Visibility', windcur: 'Wind against current', steep: 'Short steep waves', rain: 'Rain', fog: 'Fog', thunder: 'Thunderstorm', beam: 'Beam sea', head: 'Head sea' };
  const UNIT = { wind: ' kn', gust: ' kn', wave: ' m', current: ' kn', vis: ' m', beam: ' m', head: ' m', rain: ' mm/h', windcur: ' kn', steep: ' s' };
  /** passage verdict: {level ok|caution|nogo|incomplete, governing, groups, missing, reasons} */
  function overall(pass) {
    const missing = [];
    for (const s of pass) { if (!s.row) missing.push({ point: s.point.name, field: 'all' }); else { if (s.row.wind == null) missing.push({ point: s.point.name, field: 'wind' }); if (s.row.wave == null) missing.push({ point: s.point.name, field: 'waves' }); } }
    if (!pass.length) missing.push({ point: 'route', field: 'all' });
    const byKey = {};
    for (const s of pass) {
      if (!s.verdict) continue;
      for (const it of s.verdict.items) {
        const g = byKey[it.key] || (byKey[it.key] = { key: it.key, level: 0, min: Infinity, max: -Infinity, threshold: it.threshold, points: [] });
        g.level = Math.max(g.level, it.level); g.min = Math.min(g.min, it.value); g.max = Math.max(g.max, it.value); g.threshold = it.level >= g.level ? it.threshold : g.threshold;
        g.points.push({ name: s.point.name, value: it.value, level: it.level, when: s.when, text: it.text });
      }
    }
    const fmt = (k, v) => k === 'vis' ? (v / 1000).toFixed(1) + ' km' : (k === 'wave' || k === 'beam' || k === 'head' || k === 'current' ? v.toFixed(1) : Math.round(v)) + (UNIT[k] || '');
    const groups = Object.values(byKey).map(g => {
      const worst = g.points.slice().sort((a, b) => b.level - a.level || b.value - a.value)[0];
      const range = g.min === g.max ? fmt(g.key, g.max) : fmt(g.key, g.min) + ' to ' + fmt(g.key, g.max);
      const where = g.points.length === pass.length ? 'at all points' : 'at ' + g.points.map(p => p.name).join(', ');
      const thr = ['windcur', 'steep', 'fog', 'thunder'].includes(g.key) ? '' : (g.level === 2 ? ' (no-go from ' : ' (caution from ') + fmt(g.key, g.threshold) + ')';
      return { ...g, worst, margin: g.max - g.threshold, text: `${KEYNAME[g.key] || g.key} ${range} ${where}${thr}` };
    }).sort((a, b) => b.level - a.level || b.margin - a.margin);
    let level = groups.some(g => g.level === 2) ? 'nogo' : missing.length ? 'incomplete' : groups.length ? 'caution' : 'ok';
    const governing = groups[0] ? { key: groups[0].key, level: groups[0].level, value: groups[0].worst.value, threshold: groups[0].threshold, point: groups[0].worst.name, when: groups[0].worst.when, text: `${KEYNAME[groups[0].key] || groups[0].key} ${fmt(groups[0].key, groups[0].worst.value)} at ${groups[0].worst.name}` + (['windcur', 'steep', 'fog', 'thunder'].includes(groups[0].key) ? '' : `, ${groups[0].level === 2 ? 'no-go' : 'caution'} from ${fmt(groups[0].key, groups[0].threshold)}`) } : null;
    const reasons = groups.map(g => g.text); if (missing.length) reasons.push('no forecast for ' + missing.map(m => m.point + (m.field === 'all' ? '' : ' (' + m.field + ')')).join(', '));
    return { level, governing, groups, missing, reasons };
  }

  /** nearest forecast point to a position */
  function nearestPoint(data, pos) {
    if (!data) return null;
    let best = null, bd = Infinity;
    for (const p of POINTS) {
      const pt = data.points[p.id]; if (!pt) continue;
      const d = root.NAV.distanceNm(pos, p);
      if (d < bd) { bd = d; best = pt; }
    }
    return best;
  }

  const WMO = { 0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ hail' };

  root.WX = { POINTS, DEFAULT_THRESHOLDS, fetchAll, fromRaw, load, save, rowAt, classify, passage, departureScan, remainingPassage, abortCompare, coverageEnd, overall, nearestPoint, madridLocalIso, WMO, TZ };
})(typeof self !== 'undefined' ? self : this);
