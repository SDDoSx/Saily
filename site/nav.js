/* nav.js - pure geodesy and route functions. No DOM. Usable in browser (window.NAV) and node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NAV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const R = 6371008.8; // mean Earth radius, metres
  const NM = 1852;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const norm360 = d => ((d % 360) + 360) % 360;
  /** signed smallest difference a-b in degrees, range (-180, 180] */
  const angleDiff = (a, b) => { let d = norm360(a - b); if (d > 180) d -= 360; return d; };

  /** great-circle distance in nautical miles between {lat,lon} points */
  function distanceNm(a, b) {
    const f1 = toRad(a.lat), f2 = toRad(b.lat);
    const dF = f2 - f1, dL = toRad(b.lon - a.lon);
    const h = Math.sin(dF / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dL / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h))) / NM;
  }
  /** initial great-circle bearing (true), degrees 0-360 */
  function bearingDeg(a, b) {
    const f1 = toRad(a.lat), f2 = toRad(b.lat), dL = toRad(b.lon - a.lon);
    const y = Math.sin(dL) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dL);
    return norm360(toDeg(Math.atan2(y, x)));
  }
  /** destination point from a, bearing brg (deg true), distance d (nm) */
  function destination(a, brg, dNm) {
    const d = dNm * NM / R, t = toRad(brg), f1 = toRad(a.lat), l1 = toRad(a.lon);
    const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return { lat: toDeg(f2), lon: norm360(toDeg(l2) + 540) - 180 };
  }
  /** signed cross-track distance (nm) of p from great circle a->b. Positive = p is RIGHT of track (starboard). */
  function crossTrackNm(p, a, b) {
    const d13 = distanceNm(a, p) * NM / R;
    const t13 = toRad(bearingDeg(a, p)), t12 = toRad(bearingDeg(a, b));
    return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * R / NM;
  }
  /** along-track distance (nm) from a towards b of the foot of the perpendicular from p */
  function alongTrackNm(p, a, b) {
    const d13 = distanceNm(a, p) * NM / R;
    const xt = crossTrackNm(p, a, b) * NM / R;
    const cosd = Math.cos(d13) / Math.cos(xt);
    const at = Math.acos(Math.max(-1, Math.min(1, cosd)));
    const t13 = bearingDeg(a, p), t12 = bearingDeg(a, b);
    const sign = Math.abs(angleDiff(t13, t12)) > 90 ? -1 : 1;
    return sign * at * R / NM;
  }
  /** ray-casting point in polygon; ring = [[lat,lon],...] */
  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      const intersect = ((yi > p.lat) !== (yj > p.lat)) && (p.lon < (xj - xi) * (p.lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function pointInRings(p, rings) { return rings.some(r => pointInRing(p, r)); }

  /** legs for a waypoint list */
  function legs(wps) {
    const out = [];
    for (let i = 0; i < wps.length - 1; i++) {
      out.push({ i, from: wps[i], to: wps[i + 1], dist: distanceNm(wps[i], wps[i + 1]), brg: bearingDeg(wps[i], wps[i + 1]) });
    }
    return out;
  }
  function routeTotal(wps) { return legs(wps).reduce((s, l) => s + l.dist, 0); }

  /**
   * Navigation solution for position pos against waypoints wps with active index k (1..n-1).
   * Returns bearing/distance to active WP, XTE from leg (k-1 -> k), distance to go, and arrival test.
   */
  function solve(pos, wps, k) {
    k = Math.max(1, Math.min(k, wps.length - 1));
    const wp = wps[k], prev = wps[k - 1];
    const brg = bearingDeg(pos, wp);
    const dist = distanceNm(pos, wp);
    const xte = crossTrackNm(pos, prev, wp);
    const along = alongTrackNm(pos, prev, wp);
    const legDist = distanceNm(prev, wp);
    let remaining = dist;
    for (let i = k; i < wps.length - 1; i++) remaining += distanceNm(wps[i], wps[i + 1]);
    const radius = wp.radius || 0.1;
    // arrived: inside the arrival circle, or passed the perpendicular through the WP while within 0.5 nm laterally
    const inRadius = dist <= radius;
    const passedPerp = along >= legDist && Math.abs(xte) < Math.max(0.5, radius * 3) && dist < 1.0;
    const arrived = inRadius || passedPerp;
    return { k, wp, prev, brg, dist, xte, along, legDist, legBrg: bearingDeg(prev, wp), remaining, arrived, inRadius, passedPerp };
  }

  /** ETA helpers: speed in knots, distance in nm -> seconds */
  function ttgSeconds(distNm, speedKn) { return speedKn > 0.5 ? distNm / speedKn * 3600 : null; }

  /** Smoother for speed (EMA) and course (circular EMA) */
  function makeSmoother(alpha) {
    let sog = null, cogSin = 0, cogCos = 0, hasCog = false;
    return {
      push(speedKn, courseDeg) {
        if (typeof speedKn === 'number' && isFinite(speedKn)) sog = sog === null ? speedKn : sog + alpha * (speedKn - sog);
        if (typeof courseDeg === 'number' && isFinite(courseDeg)) {
          const s = Math.sin(toRad(courseDeg)), c = Math.cos(toRad(courseDeg));
          if (!hasCog) { cogSin = s; cogCos = c; hasCog = true; }
          else { cogSin += alpha * (s - cogSin); cogCos += alpha * (c - cogCos); }
        }
      },
      get sog() { return sog; },
      get cog() { return hasCog ? norm360(toDeg(Math.atan2(cogSin, cogCos))) : null; },
      reset() { sog = null; hasCog = false; }
    };
  }

  /** derive speed (kn) and course from two fixes {lat,lon,t(ms)} */
  function deltaSpeedCourse(p1, p2) {
    const dt = (p2.t - p1.t) / 1000;
    if (dt <= 0) return null;
    const d = distanceNm(p1, p2);
    return { sog: d / dt * 3600, cog: bearingDeg(p1, p2), dt, d };
  }

  // ---- formatting ---------------------------------------------------------------
  function fmtDM(lat, lon) {
    const f = (v, pos, neg, w) => {
      const h = v >= 0 ? pos : neg; v = Math.abs(v);
      const d = Math.floor(v), m = (v - d) * 60;
      return String(d).padStart(w, '0') + '°' + m.toFixed(3).padStart(6, '0') + "'" + h;
    };
    return f(lat, 'N', 'S', 2) + ' ' + f(lon, 'E', 'W', 3);
  }
  function fmtBrg(b) { return b === null || b === undefined || !isFinite(b) ? '---°' : String(Math.round(norm360(b)) % 360).padStart(3, '0') + '°'; }
  function fmtNm(d, dp) { return d === null || d === undefined || !isFinite(d) ? '--' : d.toFixed(dp === undefined ? (d < 10 ? 2 : 1) : dp); }
  function fmtDur(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '--:--';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h > 0 ? h + 'h' + String(m).padStart(2, '0') : m + ' min';
  }
  function fmtTime(date, tz) {
    try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(date); }
    catch (e) { return date.toTimeString().slice(0, 5); }
  }
  function compass16(deg) {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(norm360(deg) / 22.5) % 16];
  }

  // ---- sun -----------------------------------------------------------------------
  /** sunrise/sunset (Date objects, UTC-based) for a date and position. NOAA simplified algorithm. */
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180;
    const dayMs = 86400000;
    const J1970 = 2440588, J2000 = 2451545;
    const toJulian = d => d.valueOf() / dayMs - 0.5 + J1970;
    const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);
    const d = toJulian(date) - J2000;
    const lw = rad * -lon, phi = rad * lat;
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    const ds = 0.0009 + lw / (2 * Math.PI) + n;
    const M = rad * (357.5291 + 0.98560028 * ds);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const P = rad * 102.9372;
    const L = M + C + P + Math.PI;
    const dec = Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const h0 = rad * -0.833;
    const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosH < -1 || cosH > 1) return { sunrise: null, sunset: null };
    const w = Math.acos(cosH);
    const Jset = J2000 + (0.0009 + (w + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const Jrise = Jnoon - (Jset - Jnoon);
    return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
  }

  /** wind (from) vs current (towards): returns 'against' | 'with' | 'cross' */
  function windVsCurrent(windFromDeg, currentToDeg) {
    const a = Math.abs(angleDiff(windFromDeg, currentToDeg));
    if (a <= 45) return 'against';
    if (a >= 135) return 'with';
    return 'cross';
  }

  /** GPX for a waypoint list */
  function toGPX(name, wps) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let g = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Saily" xmlns="http://www.topografix.com/GPX/1/1">\n';
    for (const w of wps) g += `  <wpt lat="${w.lat.toFixed(5)}" lon="${w.lon.toFixed(5)}"><name>${esc(w.id)}</name><desc>${esc(w.name)}</desc></wpt>\n`;
    g += `  <rte><name>${esc(name)}</name>\n`;
    for (const w of wps) g += `    <rtept lat="${w.lat.toFixed(5)}" lon="${w.lon.toFixed(5)}"><name>${esc(w.id)}</name></rtept>\n`;
    g += '  </rte>\n</gpx>\n';
    return g;
  }

  return { R, NM, toRad, toDeg, norm360, angleDiff, distanceNm, bearingDeg, destination, crossTrackNm, alongTrackNm,
    pointInRing, pointInRings, legs, routeTotal, solve, ttgSeconds, makeSmoother, deltaSpeedCourse,
    fmtDM, fmtBrg, fmtNm, fmtDur, fmtTime, compass16, sunTimes, windVsCurrent, toGPX };
});
