/* weather.js - Open-Meteo forecast + marine fetch, caching, thresholds and warnings. */
(function (root) {
  'use strict';
  const POINTS = [
    { id: 'soto', name: 'Sotogrande offing', lat: 36.27, lon: -5.24, routeNm: 0.5 },
    { id: 'europa', name: 'Europa Point / Strait east', lat: 36.08, lon: -5.36, routeNm: 12.5 },
    { id: 'tarifa', name: 'Tarifa', lat: 35.97, lon: -5.62, routeNm: 27.3 },
    { id: 'cross', name: 'Mid-crossing (TSS)', lat: 35.92, lon: -5.70, routeNm: 34.5 },
    { id: 'tangier', name: 'Tangier Bay', lat: 35.81, lon: -5.77, routeNm: 43.0 },
  ];
  const FC_VARS = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,precipitation,temperature_2m,weather_code,cloud_cover';
  const MARINE_VARS = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,ocean_current_velocity,ocean_current_direction,sea_level_height_msl';
  const TZ = 'Europe/Madrid';
  const KEY = 'saily.weather.v1';

  const DEFAULT_THRESHOLDS = {
    windCaution: 18, windNoGo: 25,      // kn sustained
    gustCaution: 25, gustNoGo: 32,      // kn
    waveCaution: 1.2, waveNoGo: 2.0,    // m significant wave height
    currentCaution: 2.0,                // kn
    visCaution: 2000,                   // m
  };

  function fcUrl(p, days) {
    return `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=${FC_VARS}&daily=sunrise,sunset&wind_speed_unit=kn&timezone=${encodeURIComponent(TZ)}&forecast_days=${days}`;
  }
  function marineUrl(p, days) {
    return `https://marine-api.open-meteo.com/v1/marine?latitude=${p.lat}&longitude=${p.lon}&hourly=${MARINE_VARS}&cell_selection=sea&timezone=${encodeURIComponent(TZ)}&forecast_days=${days}`;
  }

  async function fetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /** merge hourly arrays of forecast + marine into rows keyed by ISO local time */
  function mergeHourly(fc, mar) {
    const rows = [];
    const fh = fc && fc.hourly, mh = mar && mar.hourly;
    const times = (fh && fh.time) || (mh && mh.time) || [];
    for (let i = 0; i < times.length; i++) {
      const row = { time: times[i] };
      if (fh) {
        row.wind = fh.wind_speed_10m[i]; row.windDir = fh.wind_direction_10m[i]; row.gust = fh.wind_gusts_10m[i];
        row.vis = fh.visibility ? fh.visibility[i] : null; row.rain = fh.precipitation[i]; row.temp = fh.temperature_2m[i];
        row.code = fh.weather_code ? fh.weather_code[i] : null; row.cloud = fh.cloud_cover ? fh.cloud_cover[i] : null;
      }
      if (mh) {
        const j = mh.time.indexOf(times[i]);
        if (j >= 0) {
          row.wave = mh.wave_height[j]; row.waveDir = mh.wave_direction[j]; row.wavePeriod = mh.wave_period[j];
          row.swell = mh.swell_wave_height[j]; row.swellDir = mh.swell_wave_direction[j]; row.swellPeriod = mh.swell_wave_period[j];
          row.windWave = mh.wind_wave_height[j];
          row.current = mh.ocean_current_velocity ? mh.ocean_current_velocity[j] / 1.852 : null; // km/h -> kn
          row.currentDir = mh.ocean_current_direction ? mh.ocean_current_direction[j] : null;
          row.seaLevel = mh.sea_level_height_msl ? mh.sea_level_height_msl[j] : null;
        }
      }
      rows.push(row);
    }
    return rows;
  }

  async function fetchAll(days, onProgress) {
    days = days || 3;
    const out = { fetchedAt: Date.now(), points: {}, errors: [] };
    let n = 0;
    for (const p of POINTS) {
      let fc = null, mar = null;
      try { fc = await fetchJson(fcUrl(p, days)); } catch (e) { out.errors.push(p.id + ' wind: ' + e.message); }
      try { mar = await fetchJson(marineUrl(p, days)); } catch (e) { out.errors.push(p.id + ' marine: ' + e.message); }
      if (fc || mar) {
        out.points[p.id] = { ...p, rows: mergeHourly(fc, mar), sunrise: fc && fc.daily ? fc.daily.sunrise : null, sunset: fc && fc.daily ? fc.daily.sunset : null, utcOffset: (fc || mar).utc_offset_seconds };
      }
      n++; if (onProgress) onProgress(n, POINTS.length);
    }
    if (Object.keys(out.points).length) save(out);
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
  function classify(row, th) {
    th = th || DEFAULT_THRESHOLDS;
    const reasons = [];
    let level = 0; // 0 ok, 1 caution, 2 nogo
    const bump = (l, msg) => { level = Math.max(level, l); reasons.push(msg); };
    if (row.wind != null) {
      if (row.wind >= th.windNoGo) bump(2, `wind ${Math.round(row.wind)} kn`);
      else if (row.wind >= th.windCaution) bump(1, `wind ${Math.round(row.wind)} kn`);
    }
    if (row.gust != null) {
      if (row.gust >= th.gustNoGo) bump(2, `gusts ${Math.round(row.gust)} kn`);
      else if (row.gust >= th.gustCaution) bump(1, `gusts ${Math.round(row.gust)} kn`);
    }
    if (row.wave != null) {
      if (row.wave >= th.waveNoGo) bump(2, `waves ${row.wave.toFixed(1)} m`);
      else if (row.wave >= th.waveCaution) bump(1, `waves ${row.wave.toFixed(1)} m`);
    }
    if (row.current != null && row.current >= th.currentCaution) bump(1, `current ${row.current.toFixed(1)} kn`);
    if (row.vis != null && row.vis < th.visCaution) bump(1, `visibility ${(row.vis / 1000).toFixed(1)} km`);
    if (row.wind != null && row.windDir != null && row.currentDir != null && row.current != null && row.current >= 1.0 && row.wind >= 12) {
      const rel = root.NAV.windVsCurrent(row.windDir, row.currentDir);
      if (rel === 'against') bump(1, 'wind against current: steep seas');
    }
    if (row.wavePeriod != null && row.wave != null && row.wave >= 0.8 && row.wavePeriod <= 4.5) bump(1, 'short steep waves');
    if (row.rain != null && row.rain >= 2) bump(1, `rain ${row.rain} mm/h`);
    return { level: ['ok', 'caution', 'nogo'][level], reasons };
  }

  /** passage plan: for departure time + speed, row at each point when passing it */
  function passage(data, departure, speedKn, th) {
    const out = [];
    if (!data) return out;
    for (const p of POINTS) {
      const pt = data.points[p.id];
      if (!pt) continue;
      const when = new Date(departure.getTime() + p.routeNm / speedKn * 3600000);
      const row = rowAt(pt, when);
      out.push({ point: pt, when, row, verdict: row ? classify(row, th) : null });
    }
    return out;
  }

  function overall(pass) {
    let level = 'ok'; const reasons = [];
    for (const s of pass) {
      if (!s.verdict) continue;
      if (s.verdict.level === 'nogo') level = 'nogo';
      else if (s.verdict.level === 'caution' && level === 'ok') level = 'caution';
      for (const r of s.verdict.reasons) reasons.push(`${s.point.name}: ${r}`);
    }
    return { level, reasons };
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

  root.WX = { POINTS, DEFAULT_THRESHOLDS, fetchAll, load, save, rowAt, classify, passage, overall, nearestPoint, madridLocalIso, WMO, TZ };
})(typeof self !== 'undefined' ? self : this);
