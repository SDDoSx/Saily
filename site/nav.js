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

  // ---------- route verification: distance from a leg to land, and which areas it crosses ----------
  // A local equirectangular projection into nautical miles. Over a passage-sized box this is accurate to
  // well under a metre, and it makes segment geometry ordinary planar arithmetic. lat0 must be the centre
  // of the area being measured: scaling longitude by cos(35.95 deg) at 60 N would understate x by 60%.
  function projector(lat0) {
    const kx = Math.cos(toRad(lat0)) * 60, ky = 60;
    return {
      lat0, kx, ky,
      toXY: ll => [ll[1] * kx, ll[0] * ky],
      toLL: xy => [xy[1] / ky, xy[0] / kx],
    };
  }
  /** squared distance from point p to segment ab, all [x, y] */
  function ptSegSq(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    let t = l2 === 0 ? 0 : ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = p[0] - (a[0] + t * vx), dy = p[1] - (a[1] + t * vy);
    return { d2: dx * dx + dy * dy, at: [a[0] + t * vx, a[1] + t * vy] };
  }
  function segsCross(a, b, c, d) {
    const s = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = s(c, d, a), d2 = s(c, d, b), d3 = s(a, b, c), d4 = s(a, b, d);
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    const on = (p, q, r) => s(p, q, r) === 0 && Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
      Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
    return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
  }
  /** project rings of [lat, lon] once, so a route check does not reproject the coastline per leg */
  function ringsXY(rings, proj) { return rings.map(r => r.map(ll => proj.toXY(ll))); }
  /** Closest approach of leg a->b to a set of projected rings: nm, and where on the ring it is.
      Zero when the leg touches or enters the area, which is what "distance to land" means here. */
  function segToRingsXY(ax, bx, rxy) {
    let best = Infinity, at = null;
    for (const ring of rxy) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (segsCross(ax, bx, ring[j], ring[i])) return { nm: 0, at: ring[i] };
        const c1 = ptSegSq(ring[i], ax, bx);            // ring vertex to the leg
        if (c1.d2 < best) { best = c1.d2; at = ring[i]; }
        const c2 = ptSegSq(ax, ring[j], ring[i]);       // leg ends to the ring edge
        if (c2.d2 < best) { best = c2.d2; at = c2.at; }
        const c3 = ptSegSq(bx, ring[j], ring[i]);
        if (c3.d2 < best) { best = c3.d2; at = c3.at; }
      }
    }
    return { nm: Math.sqrt(best), at };
  }
  function inRingXY(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  /** true when leg a->b touches, crosses or lies inside any of the projected rings */
  function segHitsRingsXY(ax, bx, rxy) {
    for (const ring of rxy) {
      if (inRingXY(ax, ring) || inRingXY(bx, ring)) return true;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (segsCross(ax, bx, ring[j], ring[i])) return true;
      }
    }
    return false;
  }

  /** Per-leg verification of a route, the same check the chart builder runs before a passage ships.
      waypoints: [{id, lat, lon}]; land: rings of [lat, lon]; areas: [{id, rings}] to report crossings of.
      Returns one row per leg: distance and bearing, closest approach to land and where, and which areas
      it crosses. `clearNm` (default 0.25) and `harbourIds` decide which rows come back flagged, because a
      leg into a marina is deliberately close to land. */
  function checkLegs(waypoints, land, areas, opts) {
    opts = opts || {};
    const wps = waypoints || [];
    if (wps.length < 2) return [];
    const lat0 = opts.lat0 !== undefined ? opts.lat0 : wps.reduce((s, w) => s + w.lat, 0) / wps.length;
    const proj = projector(lat0);
    const landXY = ringsXY(land || [], proj);
    const areaXY = (areas || []).map(a => ({ id: a.id, name: a.name, rings: ringsXY(a.rings || [], proj) }));
    const clearNm = opts.clearNm === undefined ? 0.25 : opts.clearNm;
    const harbour = new Set(opts.harbourIds || []);
    const out = [];
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      const ax = proj.toXY([a.lat, a.lon]), bx = proj.toXY([b.lat, b.lon]);
      const near = segToRingsXY(ax, bx, landXY);
      const at = near.at ? proj.toLL(near.at) : null;
      const crosses = areaXY.filter(g => segHitsRingsXY(ax, bx, g.rings)).map(g => g.id);
      const exempt = harbour.has(a.id) || harbour.has(b.id);
      out.push({
        from: a.id, to: b.id,
        dist: distanceNm(a, b), brg: bearingDeg(a, b),
        landNm: near.nm,
        landAt: at ? { lat: at[0], lon: at[1] } : null,
        crosses,
        tooClose: near.nm < clearNm && !exempt,
        exempt,
      });
    }
    return out;
  }

  // ---------- automatic routing: a course from A to B that stays off the land ----------
  // A grid of cells over the area, land (plus a clearance margin) marked unusable, A* across what is left,
  // then the path pulled straight so it comes out as a handful of waypoints rather than hundreds of steps.
  // The result is a suggestion. It is checked by checkLegs like any other route, and it is not a chart.

  /** Mark the cells a boat cannot use: land, its clearance margin, and any hazard circles. */
  function buildGrid(bbox, land, opts) {
    opts = opts || {};
    const cellNm = opts.cellNm || 0.25;
    const clearNm = opts.clearNm === undefined ? 0.3 : opts.clearNm;
    const lat0 = (bbox[0] + bbox[2]) / 2;
    const proj = projector(lat0);
    const [x0, y0] = proj.toXY([bbox[0], bbox[1]]);
    const [x1, y1] = proj.toXY([bbox[2], bbox[3]]);
    const w = Math.max(2, Math.ceil((x1 - x0) / cellNm));
    const h = Math.max(2, Math.ceil((y1 - y0) / cellNm));
    const blocked = new Uint8Array(w * h);

    // rings carry a bounding box so most cells cost one comparison rather than a full crossing count
    const rings = (land || []).map(r => {
      let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
      for (const [la, lo] of r) {
        if (la < mnLat) mnLat = la; if (la > mxLat) mxLat = la;
        if (lo < mnLon) mnLon = lo; if (lo > mxLon) mxLon = lo;
      }
      return { r, mnLat, mxLat, mnLon, mxLon };
    });
    const cellLL = (ix, iy) => proj.toLL([x0 + (ix + 0.5) * cellNm, y0 + (iy + 0.5) * cellNm]);
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const [la, lo] = cellLL(ix, iy);
        for (const g of rings) {
          if (la < g.mnLat || la > g.mxLat || lo < g.mnLon || lo > g.mxLon) continue;
          if (pointInRing({ lat: la, lon: lo }, g.r)) { blocked[iy * w + ix] = 1; break; }
        }
      }
    }
    // grow the land by the clearance margin: a multi-source sweep outwards from every blocked cell
    const margin = Math.ceil(clearNm / cellNm);
    if (margin > 0) {
      let front = [];
      for (let i = 0; i < blocked.length; i++) if (blocked[i] === 1) front.push(i);
      for (let step = 0; step < margin && front.length; step++) {
        const next = [];
        for (const i of front) {
          const ix = i % w, iy = (i / w) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = ix + dx, ny = iy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!blocked[j]) { blocked[j] = 2; next.push(j); }   // 2 = margin, still unusable
          }
        }
        front = next;
      }
    }
    // Traffic separation schemes are not obstacles, they are rules: COLREG rule 10(c) says cross on a
    // heading as nearly as practicable at right angles to the flow. Record each cell's flow bearing so the
    // search can price a step through it by the angle it makes, rather than banning it or ignoring it.
    const flow = new Int16Array(w * h).fill(-1);
    for (const z of (opts.zones || [])) {
      if (z.flowDeg === undefined || z.flowDeg === null) continue;
      const zrings = (z.rings || []).map(r => {
        let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
        for (const [la, lo] of r) { if (la < mnLat) mnLat = la; if (la > mxLat) mxLat = la; if (lo < mnLon) mnLon = lo; if (lo > mxLon) mxLon = lo; }
        return { r, mnLat, mxLat, mnLon, mxLon };
      });
      for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
        const i = iy * w + ix;
        if (flow[i] >= 0 || blocked[i]) continue;
        const [la, lo] = cellLL(ix, iy);
        for (const g of zrings) {
          if (la < g.mnLat || la > g.mxLat || lo < g.mnLon || lo > g.mxLon) continue;
          if (pointInRing({ lat: la, lon: lo }, g.r)) { flow[i] = Math.round(norm360(z.flowDeg)); break; }
        }
      }
    }
    for (const hz of (opts.hazards || [])) {
      const rNm = hz.radiusNm || hz.radius || 0.15;
      const cells = Math.ceil(rNm / cellNm);
      const [hx, hy] = proj.toXY([hz.lat, hz.lon]);
      const cx = Math.round((hx - x0) / cellNm - 0.5), cy = Math.round((hy - y0) / cellNm - 0.5);
      for (let dy = -cells; dy <= cells; dy++) for (let dx = -cells; dx <= cells; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (dx * dx + dy * dy <= cells * cells) blocked[ny * w + nx] = 3;   // 3 = hazard
      }
    }
    return {
      w, h, cellNm, blocked, flow, proj, x0, y0,
      toCell(ll) {
        const [px, py] = proj.toXY([ll.lat, ll.lon]);
        return { ix: Math.min(w - 1, Math.max(0, Math.round((px - x0) / cellNm - 0.5))),
                 iy: Math.min(h - 1, Math.max(0, Math.round((py - y0) / cellNm - 0.5))) };
      },
      toLL(ix, iy) { const [la, lo] = cellLL(ix, iy); return { lat: la, lon: lo }; },
      free(ix, iy) { return ix >= 0 && iy >= 0 && ix < w && iy < h && !blocked[iy * w + ix]; },
    };
  }

  /** nearest usable cell to one that is blocked, so a start in a marina still routes */
  function nearestFree(grid, ix, iy, maxRings) {
    if (grid.free(ix, iy)) return { ix, iy };
    for (let r = 1; r <= (maxRings || 40); r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (grid.free(ix + dx, iy + dy)) return { ix: ix + dx, iy: iy + dy };
      }
    }
    return null;
  }

  /** true when every cell along a straight line between two cells is usable */
  function clearLine(grid, a, b) {
    const dx = Math.abs(b.ix - a.ix), dy = Math.abs(b.iy - a.iy);
    const sx = a.ix < b.ix ? 1 : -1, sy = a.iy < b.iy ? 1 : -1;
    let err = dx - dy, x = a.ix, y = a.iy;
    for (let guard = 0; guard < dx + dy + 4; guard++) {
      if (!grid.free(x, y)) return false;
      if (x === b.ix && y === b.iy) return true;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return grid.free(b.ix, b.iy);
  }

  /** How much dearer a step is because of the traffic scheme it passes through.
      1 at right angles to the flow, up to 1 + k running along it, so the cheapest way across a lane is the
      one the COLREGs ask for and the cheapest route overall spends the least time inside it. */
  function laneCost(grid, i, stepBrg, k) {
    const f = grid.flow ? grid.flow[i] : -1;
    if (f < 0) return 1;
    const along = Math.abs(Math.cos(toRad(angleDiff(stepBrg, f))));   // 1 parallel, 0 perpendicular
    return 1 + (k === undefined ? 6 : k) * along;
  }

  /** A* over the usable cells; returns the cell path or null */
  function astar(grid, from, to, opts) {
    const w = grid.w, n = grid.w * grid.h;
    const start = from.iy * w + from.ix, goal = to.iy * w + to.ix;
    const g = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const h = i => { const dx = (i % w) - to.ix, dy = ((i / w) | 0) - to.iy; return Math.hypot(dx, dy); };
    // a binary heap keyed by f; the grids here are small enough that this is comfortably fast
    const heap = [];
    const push = (i, f) => { heap.push([f, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let p = 0; for (;;) { const l = 2 * p + 1, r = l + 1; let m = p; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === p) break; [heap[m], heap[p]] = [heap[p], heap[m]]; p = m; } } return top; };
    g[start] = 0; push(start, h(start));
    let guard = 0;
    while (heap.length && guard++ < n * 4) {
      const [, i] = pop();
      if (done[i]) continue;
      done[i] = 1;
      if (i === goal) break;
      const ix = i % w, iy = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = ix + dx, ny = iy + dy;
        if (!grid.free(nx, ny)) continue;
        if (dx && dy && !(grid.free(ix + dx, iy) && grid.free(ix, iy + dy))) continue;   // no cutting corners
        const j = ny * w + nx;
        const step = (dx && dy) ? Math.SQRT2 : 1;
        const brg = norm360(toDeg(Math.atan2(dx, dy)));
        const ng = g[i] + step * laneCost(grid, j, brg, opts && opts.laneK);
        if (ng < g[j]) { g[j] = ng; came[j] = i; push(j, ng + h(j)); }
      }
    }
    if (!done[goal] && came[goal] < 0) return null;
    const path = [];
    for (let i = goal; i >= 0; i = came[i]) { path.push({ ix: i % w, iy: (i / w) | 0 }); if (i === start) break; }
    return path.reverse();
  }

  /** True when the straight line between two cells would cross a lane at a worse angle than the path did.
      Pulling a path straight is what turns a right-angle crossing back into a diagonal one. */
  function crossingWorsens(grid, a, b, maxAlong) {
    if (!grid.flow) return false;
    const brg = norm360(toDeg(Math.atan2(b.ix - a.ix, b.iy - a.iy)));
    const dx = Math.abs(b.ix - a.ix), dy = Math.abs(b.iy - a.iy);
    const sx = a.ix < b.ix ? 1 : -1, sy = a.iy < b.iy ? 1 : -1;
    let err = dx - dy, x = a.ix, y = a.iy;
    for (let guard = 0; guard < dx + dy + 4; guard++) {
      const f = grid.flow[y * grid.w + x];
      if (f >= 0 && Math.abs(Math.cos(toRad(angleDiff(brg, f)))) > (maxAlong === undefined ? 0.35 : maxAlong)) return true;
      if (x === b.ix && y === b.iy) return false;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return false;
  }

  /** True when the straight line between two cells passes through conditions the search avoided.
      Straightening a path is exactly what undoes a weather detour, so it has to be asked as well. */
  function weatherWorsens(grid, a, b, costAt, limit) {
    if (!costAt) return false;
    const cap = limit === undefined ? 3 : limit;      // past caution, heading for no-go
    const dx = Math.abs(b.ix - a.ix), dy = Math.abs(b.iy - a.iy);
    const sx = a.ix < b.ix ? 1 : -1, sy = a.iy < b.iy ? 1 : -1;
    let err = dx - dy, x = a.ix, y = a.iy;
    for (let guard = 0; guard < dx + dy + 4; guard++) {
      if (costAt(x, y) > cap) return true;
      if (x === b.ix && y === b.iy) return false;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return false;
  }

  /** pull the path straight: keep a point only where the line of sight, the crossing angle, or the
      weather breaks */
  function simplifyPath(grid, cells, opts) {
    if (cells.length < 3) return cells.slice();
    opts = opts || {};
    const out = [cells[0]];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let far = anchor + 1;
      for (let j = cells.length - 1; j > anchor; j--) {
        if (clearLine(grid, cells[anchor], cells[j])
          && !crossingWorsens(grid, cells[anchor], cells[j], opts.maxAlong)
          && !weatherWorsens(grid, cells[anchor], cells[j], opts.costAt, opts.costLimit)) { far = j; break; }
      }
      out.push(cells[far]);
      anchor = far;
    }
    return out;
  }

  /** Suggest a route from `from` to `to` that stays clear of land.
      Returns {waypoints, cellNm, clearNm, blockedStart, blockedEnd} or null when there is no way through. */
  function suggestRoute(from, to, land, opts) {
    opts = opts || {};
    const pad = opts.padNm === undefined ? 4 : opts.padNm;
    const padDeg = pad / 60;
    const bbox = opts.bbox || [
      Math.min(from.lat, to.lat) - padDeg, Math.min(from.lon, to.lon) - padDeg * 1.4,
      Math.max(from.lat, to.lat) + padDeg, Math.max(from.lon, to.lon) + padDeg * 1.4];
    const grid = buildGrid(bbox, land, opts);
    const a0 = grid.toCell(from), b0 = grid.toCell(to);
    const a = nearestFree(grid, a0.ix, a0.iy), b = nearestFree(grid, b0.ix, b0.iy);
    if (!a || !b) return null;
    const cells = astar(grid, a, b, opts);
    if (!cells) return null;
    const pulled = simplifyPath(grid, cells, opts);
    // real endpoints at each end, the pulled corners in between
    const mid = pulled.slice(1, -1).map(c => grid.toLL(c.ix, c.iy));
    const pts = [{ lat: from.lat, lon: from.lon }, ...mid, { lat: to.lat, lon: to.lon }];
    // drop a corner that adds almost nothing to the course
    const kept = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = kept[kept.length - 1], next = pts[i + 1];
      const turn = Math.abs(angleDiff(bearingDeg(prev, pts[i]), bearingDeg(pts[i], next)));
      if (turn > (opts.minTurnDeg || 8)) kept.push(pts[i]);
    }
    kept.push(pts[pts.length - 1]);
    return {
      waypoints: kept.map((p, i) => ({
        id: i === 0 ? (opts.startId || 'START') : i === kept.length - 1 ? (opts.endId || 'FINISH') : 'WP' + i,
        name: i === 0 ? (opts.startName || 'Start') : i === kept.length - 1 ? (opts.endName || 'Finish') : 'Waypoint ' + i,
        lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5, radius: 0.1, note: '',
      })),
      cellNm: grid.cellNm, clearNm: opts.clearNm === undefined ? 0.3 : opts.clearNm,
      blockedStart: !grid.free(a0.ix, a0.iy), blockedEnd: !grid.free(b0.ix, b0.iy),
      cells: cells.length, bbox,
    };
  }

  // ---------- how fast this boat actually goes in these conditions ----------
  // Deliberately simple and deliberately pessimistic. A real polar comes from the builder or from your own
  // log; this is a shape that behaves the right way -- a planing hull comes off the plane in a head sea, a
  // displacement hull barely notices until it is bad, a sailing boat cannot sail into no wind or into the
  // eye of it -- so that a route or a departure chosen with it is chosen for the right reasons.

  /** relative angle between a course and a direction the weather is coming FROM, 0 = dead ahead */
  function relFrom(courseDeg, fromDeg) { return Math.abs(angleDiff(fromDeg, courseDeg)); }

  /** Sailing speed as a fraction of the boat's best, from true wind speed and true wind angle. */
  function sailFactor(twsKn, twaDeg) {
    const a = Math.abs(twaDeg);
    if (twsKn < 3) return 0;                                   // becalmed
    let ang;                                                   // how well the boat goes at this angle
    if (a < 30) ang = 0;                                       // in irons
    else if (a < 45) ang = 0.45 + (a - 30) / 15 * 0.3;         // close hauled, building
    else if (a < 80) ang = 0.75 + (a - 45) / 35 * 0.2;
    else if (a < 140) ang = 0.95 + (a - 80) / 60 * 0.05;       // reaching, best
    else if (a < 170) ang = 1.0 - (a - 140) / 30 * 0.18;       // broad reach to run
    else ang = 0.82 - (a - 170) / 10 * 0.07;                   // dead downwind, blanketed
    let wind;                                                  // and how much wind there is to use
    if (twsKn < 6) wind = (twsKn - 3) / 3 * 0.35;
    else if (twsKn < 12) wind = 0.35 + (twsKn - 6) / 6 * 0.45;
    else if (twsKn < 20) wind = 0.8 + (twsKn - 12) / 8 * 0.2;
    else if (twsKn < 30) wind = 1.0;                           // reefed, still at hull speed
    else wind = Math.max(0.5, 1.0 - (twsKn - 30) / 40);        // survival, slowing down
    return Math.max(0, ang * wind);
  }

  /** Speed made good in these conditions, in knots, before current.
      boat: {kind, cruiseKn, maxKn}; cond: {wind, windDir (from), wave, waveDir (from)} */
  function speedIn(boat, cond, courseDeg) {
    boat = boat || {};
    const cruise = boat.cruiseKn || 8;
    const wave = cond && cond.wave != null ? cond.wave : 0;
    const headSea = cond && cond.waveDir != null && courseDeg != null
      ? Math.max(0, Math.cos(toRad(relFrom(courseDeg, cond.waveDir)))) : 0.5;   // 1 dead on the nose
    if (boat.kind === 'sail') {
      const tws = cond && cond.wind != null ? cond.wind : 0;
      const twa = cond && cond.windDir != null && courseDeg != null ? relFrom(courseDeg, cond.windDir) : 90;
      const best = boat.maxKn || cruise * 1.3;
      const sailing = best * sailFactor(tws, twa);
      const motoring = cruise * 0.85;                       // the iron sail, when it beats sailing
      let v = Math.max(sailing, motoring);
      v *= Math.max(0.55, 1 - 0.22 * headSea * Math.max(0, wave - 0.8));   // punching into it
      return Math.max(1.5, v);
    }
    if (boat.kind === 'displacement' || cruise <= 12) {
      // a displacement hull holds its speed until the sea is genuinely big
      const v = cruise * Math.max(0.55, 1 - 0.16 * headSea * Math.max(0, wave - 1.0) - 0.05 * Math.max(0, wave - 2.0));
      return Math.max(2, v);
    }
    // planing: comes off the plane and the loss is steep once it does
    const over = Math.max(0, wave - 0.5);
    let v = cruise * Math.max(0.3, 1 - 0.55 * headSea * over - 0.12 * over);
    if (wave > 1.6 && headSea > 0.5) v = Math.min(v, cruise * 0.45);   // no longer a planing passage
    return Math.max(3, v);
  }

  /** Speed over the ground: the boat through the water, plus the along-course part of the current. */
  function sogIn(boat, cond, courseDeg) {
    const v = speedIn(boat, cond, courseDeg);
    if (!cond || cond.current == null || cond.currentDir == null || courseDeg == null) return v;
    // currentDir is the direction the water is going TOWARDS
    const along = cond.current * Math.cos(toRad(angleDiff(cond.currentDir, courseDeg)));
    return Math.max(0.5, v + along);
  }

  // ---------- routing through weather, not just around land ----------
  // The same grid, but the cost of a step is the time it takes, and the time it takes depends on the
  // conditions where you will be when you get there. A* over that produces a course that leans away from a
  // forecast gale, and a passage time that is not the flat-water fantasy.

  /** How much dearer a step is because the conditions there are past the boat's limits.
      Beyond no-go it is effectively closed; between caution and no-go it is discouraged. */
  function weatherCost(cond, th, boat) {
    if (!cond) return 1;
    th = th || {};
    let worst = 0;
    const bump = (v, caution, nogo) => {
      if (v == null || caution == null || nogo == null || nogo <= caution) return;
      if (v >= nogo) worst = Math.max(worst, 2 + Math.min(3, (v - nogo) / Math.max(1, nogo - caution)));
      else if (v > caution) worst = Math.max(worst, (v - caution) / (nogo - caution));
    };
    bump(cond.wind, th.windCaution, th.windNoGo);
    bump(cond.gust, th.gustCaution, th.gustNoGo);
    bump(cond.wave, th.waveCaution, th.waveNoGo);
    if (cond.wave != null && cond.wavePeriod != null && cond.wave >= 0.8 && cond.wavePeriod <= 4.5) worst = Math.max(worst, 0.5);
    if (boat && boat.kind === 'sail' && cond.wind != null && cond.wind < 4) worst = Math.max(worst, 0.2);  // drifting
    return 1 + 9 * worst;                      // a no-go cell costs about twenty times a calm one
  }

  /** Route from A to B leaving at a given time, through a forecast field.
      opts: {field, boat, th, departAt, clearNm, cellNm, zones, hazards, maxHours}
      Returns {waypoints, hours, arriveAt, worst, legs} or null. */
  function weatherRoute(from, to, land, opts) {
    opts = opts || {};
    const field = opts.field;
    const boat = opts.boat || {};
    const th = opts.th || {};
    const depart = opts.departAt ? new Date(opts.departAt) : new Date();
    const pad = opts.padNm === undefined ? 4 : opts.padNm;
    const padDeg = pad / 60;
    const bbox = opts.bbox || [
      Math.min(from.lat, to.lat) - padDeg, Math.min(from.lon, to.lon) - padDeg * 1.4,
      Math.max(from.lat, to.lat) + padDeg, Math.max(from.lon, to.lon) + padDeg * 1.4];
    const grid = buildGrid(bbox, land, opts);
    const a0 = grid.toCell(from), b0 = grid.toCell(to);
    const a = nearestFree(grid, a0.ix, a0.iy), b = nearestFree(grid, b0.ix, b0.iy);
    if (!a || !b) return null;

    const w = grid.w, n = grid.w * grid.h;
    const start = a.iy * w + a.ix, goal = b.iy * w + b.ix;
    const bestKn = Math.max(3, boat.maxKn || boat.cruiseKn || 8);
    const hours = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const cellNm = grid.cellNm;
    const h = i => { const dx = (i % w) - b.ix, dy = ((i / w) | 0) - b.iy; return Math.hypot(dx, dy) * cellNm / bestKn; };
    const heap = [];
    const push = (i, f) => { heap.push([f, i]); let c = heap.length - 1; while (c > 0) { const pI = (c - 1) >> 1; if (heap[pI][0] <= heap[c][0]) break; [heap[pI], heap[c]] = [heap[c], heap[pI]]; c = pI; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let pI = 0; for (;;) { const l = 2 * pI + 1, r = l + 1; let m = pI; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === pI) break; [heap[m], heap[pI]] = [heap[pI], heap[m]]; pI = m; } } return top; };
    hours[start] = 0; push(start, h(start));
    const maxHours = opts.maxHours || 96;
    let guard = 0;
    while (heap.length && guard++ < n * 4) {
      const [, i] = pop();
      if (done[i]) continue;
      done[i] = 1;
      if (i === goal) break;
      if (hours[i] > maxHours) continue;
      const ix = i % w, iy = (i / w) | 0;
      const when = new Date(depart.getTime() + hours[i] * 3600000);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = ix + dx, ny = iy + dy;
        if (!grid.free(nx, ny)) continue;
        if (dx && dy && !(grid.free(ix + dx, iy) && grid.free(ix, iy + dy))) continue;
        const j = ny * w + nx;
        const distNm = ((dx && dy) ? Math.SQRT2 : 1) * cellNm;
        const brg = norm360(toDeg(Math.atan2(dx, dy)));
        const ll = grid.toLL(nx, ny);
        const cond = field ? field.at(ll.lat, ll.lon, when) : null;
        const sog = Math.max(0.5, sogIn(boat, cond, brg));
        const cost = (distNm / sog) * weatherCost(cond, th, boat) * laneCost(grid, j, brg, opts.laneK);
        const nh = hours[i] + cost;
        if (nh < hours[j]) { hours[j] = nh; came[j] = i; push(j, nh + h(j)); }
      }
    }
    if (!done[goal] && came[goal] < 0) return null;

    const cells = [];
    for (let i = goal; i >= 0; i = came[i]) { cells.push({ ix: i % w, iy: (i / w) | 0 }); if (i === start) break; }
    cells.reverse();
    // sample the conditions a shortcut would pass through, at roughly when the boat would be there
    const totalH = hours[goal];
    const cellTime = (ix, iy) => {
      const frac = cells.length > 1 ? cells.findIndex(c => c.ix === ix && c.iy === iy) / (cells.length - 1) : 0;
      return new Date(depart.getTime() + Math.max(0, frac) * totalH * 3600000);
    };
    const costAt = field ? (ix, iy) => {
      const ll = grid.toLL(ix, iy);
      return weatherCost(field.at(ll.lat, ll.lon, cellTime(ix, iy)), th, boat);
    } : null;
    const pulled = simplifyPath(grid, cells, Object.assign({}, opts, { costAt, costLimit: opts.costLimit }));
    const mid = pulled.slice(1, -1).map(c => grid.toLL(c.ix, c.iy));
    const pts = [{ lat: from.lat, lon: from.lon }, ...mid, { lat: to.lat, lon: to.lon }];
    const kept = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = kept[kept.length - 1], next = pts[i + 1];
      if (Math.abs(angleDiff(bearingDeg(prev, pts[i]), bearingDeg(pts[i], next))) > (opts.minTurnDeg || 8)) kept.push(pts[i]);
    }
    kept.push(pts[pts.length - 1]);
    const waypoints = kept.map((p, i) => ({
      id: i === 0 ? (opts.startId || 'START') : i === kept.length - 1 ? (opts.endId || 'FINISH') : 'WP' + i,
      name: i === 0 ? (opts.startName || 'Start') : i === kept.length - 1 ? (opts.endName || 'Finish') : 'Waypoint ' + i,
      lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5, radius: 0.1, note: '',
    }));
    // walk the kept waypoints for the numbers a person reads: time, and the worst it gets
    const legsOut = [];
    let t = depart.getTime(), worst = { wind: 0, gust: 0, wave: 0, when: null, where: null };
    for (let i = 0; i < waypoints.length - 1; i++) {
      const A = waypoints[i], B = waypoints[i + 1];
      const brg = bearingDeg(A, B), distNm = distanceNm(A, B);
      let remaining = distNm, legHours = 0, guard2 = 0;
      while (remaining > 0.01 && guard2++ < 400) {
        const frac = 1 - remaining / distNm;
        const here = { lat: A.lat + (B.lat - A.lat) * frac, lon: A.lon + (B.lon - A.lon) * frac };
        const cond = field ? field.at(here.lat, here.lon, new Date(t)) : null;
        const sog = Math.max(0.5, sogIn(boat, cond, brg));
        const stepNm = Math.min(remaining, Math.max(0.5, sog * 0.25));   // quarter-hour steps
        const dh = stepNm / sog;
        t += dh * 3600000; legHours += dh; remaining -= stepNm;
        if (cond) {
          if ((cond.wind || 0) > worst.wind) worst = { ...worst, wind: cond.wind, when: new Date(t), where: here };
          if ((cond.gust || 0) > worst.gust) worst.gust = cond.gust;
          if ((cond.wave || 0) > worst.wave) worst.wave = cond.wave;
        }
      }
      legsOut.push({ from: A.id, to: B.id, distNm, brg, hours: legHours, arriveAt: new Date(t) });
    }
    return {
      waypoints, legs: legsOut,
      hours: (t - depart.getTime()) / 3600000,
      departAt: depart, arriveAt: new Date(t),
      distanceNm: routeTotal(waypoints), worst,
    };
  }

  // ---------- planning a passage: when to leave, and where to stop on the way ----------

  /** Split a route into days. A passage longer than a comfortable run, or one that would arrive in the
      dark, gets broken at the last waypoint reached in daylight, which is where a stop belongs. */
  function schedule(waypoints, opts) {
    opts = opts || {};
    const boat = opts.boat || {};
    const field = opts.field || null;
    const maxH = opts.maxHoursPerDay || 10;
    const sunAt = opts.sunAt || (d => sunTimes(d, waypoints[0].lat, waypoints[0].lon));
    const stops = new Set(opts.stops || []);
    let t = new Date(opts.departAt || Date.now()).getTime();
    const days = [];
    let day = { index: 1, departAt: new Date(t), legs: [], distanceNm: 0, hours: 0 };
    for (let i = 0; i < waypoints.length - 1; i++) {
      const A = waypoints[i], B = waypoints[i + 1];
      const brg = bearingDeg(A, B), distNm = distanceNm(A, B);
      const cond = field ? field.at((A.lat + B.lat) / 2, (A.lon + B.lon) / 2, new Date(t)) : null;
      const sog = Math.max(0.5, sogIn(boat, cond, brg));
      const h = distNm / sog;
      t += h * 3600000;
      day.legs.push({ from: A.id, to: B.id, distNm, brg, hours: h, arriveAt: new Date(t), sog });
      day.distanceNm += distNm; day.hours += h;
      const arriving = new Date(t);
      const sun = sunAt(arriving);
      const dark = sun && sun.sunset && arriving > sun.sunset;
      const tooLong = day.hours >= maxH;
      const asked = stops.has(B.id);
      const last = i === waypoints.length - 2;
      if (!last && (asked || tooLong || dark)) {
        day.stopAt = B.id;
        day.reason = asked ? 'a stop you asked for' : dark ? 'it would be dark before the next one' : `${maxH} hours is a long enough day`;
        day.arriveAt = arriving;
        days.push(day);
        // resume the next morning, an hour after sunrise
        const nextSun = sunAt(new Date(t + 12 * 3600000));
        const resume = nextSun && nextSun.sunrise ? new Date(nextSun.sunrise.getTime() + 3600000) : new Date(t + 12 * 3600000);
        t = Math.max(t, resume.getTime());
        day = { index: days.length + 1, departAt: new Date(t), legs: [], distanceNm: 0, hours: 0 };
      }
    }
    day.arriveAt = new Date(t);
    days.push(day);
    return {
      days, departAt: new Date(opts.departAt || Date.now()), arriveAt: new Date(t),
      totalHours: days.reduce((a, d) => a + d.hours, 0),
      totalNm: days.reduce((a, d) => a + d.distanceNm, 0),
      nights: days.length - 1,
      stops: days.filter(d => d.stopAt).map(d => ({ at: d.stopAt, reason: d.reason, arriveAt: d.arriveAt })),
    };
  }

  /** Score a departure. Lower is better; level says what a person should read into it. */
  function scoreDeparture(route, sched, th, opts) {
    th = th || {}; opts = opts || {};
    const w = route.worst || {};
    let over = 0, level = 'ok', why = null;
    const rate = (v, caution, nogo, name, unit) => {
      if (v == null || caution == null || nogo == null) return;
      if (v >= nogo) { over = Math.max(over, 2 + (v - nogo) / Math.max(1, nogo - caution)); if (level !== 'nogo') { level = 'nogo'; why = `${name} ${Math.round(v * 10) / 10}${unit}, past ${nogo}${unit}`; } }
      else if (v > caution) { over = Math.max(over, (v - caution) / (nogo - caution)); if (level === 'ok') { level = 'caution'; why = `${name} ${Math.round(v * 10) / 10}${unit}, over ${caution}${unit}`; } }
    };
    rate(w.wind, th.windCaution, th.windNoGo, 'wind', ' kn');
    rate(w.gust, th.gustCaution, th.gustNoGo, 'gusts', ' kn');
    rate(w.wave, th.waveCaution, th.waveNoGo, 'waves', ' m');
    const nightPenalty = (sched.nights || 0) * 0.4;
    const arriveDark = opts.arriveDark ? 0.8 : 0;
    return { score: sched.totalHours / 24 + over * 3 + nightPenalty + arriveDark, level, why, over };
  }

  /** Try a window of departures and return them ranked, with the route each one implies.
      opts: {field, boat, th, from, everyHours, hours, land, ...routing options} */
  function planDepartures(from, to, land, opts) {
    opts = opts || {};
    const every = opts.everyHours || 3;
    const windowH = opts.windowHours || 72;
    const t0 = new Date(opts.from || Date.now());
    const out = [];
    for (let h = 0; h <= windowH; h += every) {
      const departAt = new Date(t0.getTime() + h * 3600000);
      if (opts.field && !opts.field.covers(departAt)) break;
      const route = weatherRoute(from, to, land, Object.assign({}, opts, { departAt }));
      if (!route) continue;
      const sched = schedule(route.waypoints, Object.assign({}, opts, { departAt }));
      const sun = opts.sunAt ? opts.sunAt(sched.arriveAt) : sunTimes(sched.arriveAt, to.lat, to.lon);
      const arriveDark = !!(sun && sun.sunset && (sched.arriveAt > sun.sunset || (sun.sunrise && sched.arriveAt < sun.sunrise)));
      const sc = scoreDeparture(route, sched, opts.th, { arriveDark });
      out.push({ departAt, route, schedule: sched, arriveDark, ...sc });
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }

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

  /** GPX track from [[lat, lon, tMs], ...] */
  function trackGPX(name, pts) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let g = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Saily" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>' + esc(name) + '</name><trkseg>\n';
    for (const p of pts) g += `    <trkpt lat="${(+p[0]).toFixed(5)}" lon="${(+p[1]).toFixed(5)}">${p[2] ? '<time>' + new Date(p[2]).toISOString() + '</time>' : ''}</trkpt>\n`;
    return g + '  </trkseg></trk>\n</gpx>\n';
  }
  /** course (deg) on a route at a given distance from its start */
  function courseAtNm(wps, atNm) {
    let acc = 0;
    for (let i = 0; i < wps.length - 1; i++) { const d = distanceNm(wps[i], wps[i + 1]); if (atNm <= acc + d || i === wps.length - 2) return bearingDeg(wps[i], wps[i + 1]); acc += d; }
    return null;
  }
  /** relative sea: waves FROM waveFrom deg vs course -> 'head' | 'bow' | 'beam' | 'quarter' | 'following' */
  function seaAspect(waveFrom, course) {
    const a = Math.abs(angleDiff(waveFrom, course));
    return a < 30 ? 'head' : a < 60 ? 'bow' : a < 120 ? 'beam' : a < 150 ? 'quarter' : 'following';
  }

  return { R, NM, toRad, toDeg, norm360, angleDiff, distanceNm, bearingDeg, destination, crossTrackNm, alongTrackNm,
    pointInRing, pointInRings, legs, routeTotal, solve, ttgSeconds, makeSmoother, deltaSpeedCourse,
    projector, ringsXY, segToRingsXY, segHitsRingsXY, checkLegs,
    buildGrid, nearestFree, clearLine, astar, simplifyPath, suggestRoute, laneCost, crossingWorsens,
    sailFactor, speedIn, sogIn, relFrom, weatherCost, weatherRoute, weatherWorsens,
    schedule, scoreDeparture, planDepartures,
    fmtDM, fmtBrg, fmtNm, fmtDur, fmtTime, compass16, sunTimes, windVsCurrent, toGPX, trackGPX, courseAtNm, seaAspect };
});
