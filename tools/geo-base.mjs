// tools/build-geodata.mjs
// Builds js/toronto-geodata.js: real Toronto geography in the simulation's 1:1 world frame, from OpenStreetMap.
// Frame: 1 unit = 1 m, x = street-grid east, z = grid south (north = -z), origin at the centreline intersection of
// Yonge St & Queen St, axes turned from true north by the grid's measured bearing (about -16.6°: Toronto's "north" up
// Yonge St points north-north-west).
//
// Inputs (tools/data/, fetched by tools/fetch-geodata.sh through tools/overpass.sh), all © OpenStreetMap contributors:
//   osm_lake.json       Lake Ontario (relation 1206310): the mainland shore & the Toronto Islands
//   osm_roads.json      highways & railways over downtown (with node ids, to split ways at intersections)
//   osm_parks.json      parks, lawns, water, woods, cemeteries, railway land & parking over downtown
//   osm_buildings.json  building outlines with heights / storeys over downtown (lot height hints & landmarks)
//   osm_piers.json      piers, breakwaters & the island airport's runways
//
// usage: GEO_DATA=tools/data node tools/build-geodata.mjs [outFile]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[geodata]', ...a);

// =====================================================================================================================
// 1. FRAME
// =====================================================================================================================
const LAT0 = 43.65243;
const LON0 = -79.37926;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
let THETA = (-16.6 * Math.PI) / 180; // refined below from the north-south arterials
let ORIGIN = [0, 0]; // grid (u, v) of Yonge St & Queen St, refined below

// Local tangent plane (east, north) metres
const enu = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
// Grid frame: u = grid east, v = grid south
function gridUV(lon, lat) {
  const [e, n] = enu(lon, lat);
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}
const toWorld = (lon, lat) => {
  const [u, v] = gridUV(lon, lat);
  return [u - ORIGIN[0], v - ORIGIN[1]];
};

// =====================================================================================================================
// 2. GEOMETRY HELPERS
// =====================================================================================================================
const r1 = (x) => Math.round(x * 10) / 10;
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
// Ramer-Douglas-Peucker on an open polyline
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring (split at the two farthest-apart vertices)
function rdpRing(ring, eps) {
  let i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
// Sutherland-Hodgman: the part of a ring on the side n·p <= c of a line (n = [nx, nz])
function clipHalfPlane(ring, nx, nz, c) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const da = a[0] * nx + a[1] * nz - c, db = b[0] * nx + b[1] * nz - c;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}
const clipRect = (ring, x0, x1, z0, z1) => clipHalfPlane(clipHalfPlane(clipHalfPlane(clipHalfPlane(ring, -1, 0, -x0), 1, 0, x1), 0, -1, -z0), 0, 1, z1);

// ---------------------------------------------------------------------------------------------------------------------
// Raster tools (for the shoreline, the curb islands and merging polygons)
// ---------------------------------------------------------------------------------------------------------------------
class Raster {
  constructor(x0, z0, x1, z1, res) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Uint8Array(this.w * this.h);
  }
  // Scanline fill of a ring (even-odd) with `val`
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k];
        const [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Squared Euclidean distance (in cells) from every cell to the nearest cell where mask(v) is true (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const out = new Float32Array(w * h);
    const v = new Int32Array(Math.max(w, h));
    const zz = new Float64Array(Math.max(w, h) + 1);
    const dt1 = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0;
      zz[0] = -INF;
      zz[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zz[k] = s;
        zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => (out[q * w + i] = val));
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => (out[j * w + q] = val));
    return out;
  }
  // Morphological opening of the 1-cells with a disc of radius r metres
  open(r) {
    const rc = (r / this.res) ** 2;
    const toWater = this.edt((x) => x === 0);
    const eroded = new Uint8Array(this.d.length);
    for (let i = 0; i < eroded.length; i++) eroded[i] = toWater[i] > rc ? 1 : 0;
    const save = this.d;
    this.d = eroded;
    const toEroded = this.edt((x) => x === 1);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = this.d[i] && toEroded[i] <= rc + 1e-6 ? 1 : 0;
  }
  // Morphological closing (fills inlets / gaps narrower than 2r)
  close(r) {
    const rc = (r / this.res) ** 2;
    const toLand = this.edt((x) => x === 1);
    const dil = new Uint8Array(this.d.length);
    for (let i = 0; i < dil.length; i++) dil[i] = toLand[i] <= rc ? 1 : 0;
    const save = this.d;
    this.d = dil;
    const toGap = this.edt((x) => x === 0);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = dil[i] && toGap[i] > rc ? 1 : 0;
  }
  // Keep only the 4-connected component containing the most cells
  keepLargest() {
    const { w, h, d } = this;
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, cur = 0;
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!d[s] || lab[s]) continue;
      cur++;
      let n = 0;
      stack.push(s);
      lab[s] = cur;
      while (stack.length) {
        const p = stack.pop();
        n++;
        const i = p % w, j = (p - i) / w;
        if (i > 0 && d[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
        if (i < w - 1 && d[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
        if (j > 0 && d[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
        if (j < h - 1 && d[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
      }
      if (n > bestN) { bestN = n; best = cur; }
    }
    for (let i = 0; i < w * h; i++) d[i] = lab[i] === best ? 1 : 0;
  }
  // Outer boundary of the (single) region as a ring of cell-corner points (Moore-neighbour style edge walk)
  traceOuter() {
    const { w, h, d, res, x0, z0 } = this;
    const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h ? d[j * w + i] : 0);
    let si = -1, sj = -1;
    outer: for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (at(i, j)) { si = i; sj = j; break outer; }
    // Walk corners: position (cx, cz) in corner coordinates, direction index 0:+x 1:+z 2:-x 3:-z
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    let cx = si, cz = sj, dir = 0; // top edge of cell (si, sj), walking +x with land below
    const pts = [];
    const start = `${cx},${cz},${dir}`;
    let guard = 0;
    do {
      pts.push([x0 + cx * res, z0 + cz * res]);
      cx += DX[dir];
      cz += DZ[dir];
      const cellAt = (dxl, dzl) => at(cx + dxl, cz + dzl);
      let left, right;
      if (dir === 0) { left = cellAt(0, -1); right = cellAt(0, 0); }
      else if (dir === 1) { left = cellAt(0, 0); right = cellAt(-1, 0); }
      else if (dir === 2) { left = cellAt(-1, 0); right = cellAt(-1, -1); }
      else { left = cellAt(-1, -1); right = cellAt(0, -1); }
      if (left && right) dir = (dir + 3) % 4; // turn left (land ahead): keep land on the right
      else if (!left && right) { /* straight */ }
      else dir = (dir + 1) % 4; // turn right
      if (++guard > 50000000) throw new Error('trace runaway');
    } while (`${cx},${cz},${dir}` !== start);
    // Merge collinear runs, then replace the stair steps (short edges) by their midpoints, turning the raster's stairs
    // into sloping runs before simplifying; corners between two long edges (the window's own corners) stay
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
      if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
    }
    const short = res * 3.5;
    const len = (i) => {
      const a = out[i], b = out[(i + 1) % out.length];
      return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    };
    const res2 = [];
    for (let i = 0; i < out.length; i++) {
      if (len((i + out.length - 1) % out.length) > short && len(i) > short) res2.push(out[i]);
      if (len(i) <= short) {
        const a = out[i], b = out[(i + 1) % out.length];
        res2.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    }
    return res2;
  }
}

// =====================================================================================================================
// 3. FRAME CALIBRATION FROM THE STREETS
// =====================================================================================================================
const osmRoads = load('osm_roads.json');
const roadWays = osmRoads.elements.filter((e) => e.type === 'way' && e.geometry && e.nodes);
{
  // Bearing: length-weighted median direction of the long straight north-south arterial segments
  const NS = new Set(['Yonge Street', 'Bay Street', 'University Avenue', 'Spadina Avenue', 'Church Street', 'Jarvis Street',
    'Bathurst Street', 'Sherbourne Street', 'Parliament Street', 'York Street', 'Simcoe Street', 'John Street']);
  const angs = [];
  for (const w of roadWays) {
    if (!NS.has((w.tags || {}).name)) continue;
    const g = w.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const [e0, n0] = enu(g[i].lon, g[i].lat);
      const [e1, n1] = enu(g[i + 1].lon, g[i + 1].lat);
      const L = Math.hypot(e1 - e0, n1 - n0);
      if (L < 30) continue;
      let a = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI;
      a = ((a % 180) + 180) % 180;
      if (a > 90) a -= 180;
      angs.push([a, L]);
    }
  }
  angs.sort((p, q) => p[0] - q[0]);
  const tot = angs.reduce((t, a) => t + a[1], 0);
  let acc = 0;
  for (const [a, L] of angs) {
    acc += L;
    if (acc >= tot / 2) { THETA = (a * Math.PI) / 180; break; }
  }
  // Origin: where Yonge St's centreline crosses Queen St's (the crossing nearest the corner's nominal place)
  const segs = (re) => {
    const out = [];
    for (const w of roadWays) {
      if (!re.test((w.tags || {}).name || '') || !(w.tags || {}).highway) continue;
      for (let i = 0; i + 1 < w.geometry.length; i++) out.push([enu(w.geometry[i].lon, w.geometry[i].lat), enu(w.geometry[i + 1].lon, w.geometry[i + 1].lat)]);
    }
    return out;
  };
  let found = null;
  let bestD = Infinity;
  for (const [a0, a1] of segs(/^Yonge Street$/)) {
    for (const [b0, b1] of segs(/^Queen Street (East|West)$/)) {
      const dax = a1[0] - a0[0], daz = a1[1] - a0[1], dbx = b1[0] - b0[0], dbz = b1[1] - b0[1];
      const den = dax * dbz - daz * dbx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((b0[0] - a0[0]) * dbz - (b0[1] - a0[1]) * dbx) / den;
      const u = ((b0[0] - a0[0]) * daz - (b0[1] - a0[1]) * dax) / den;
      if (t < -0.05 || t > 1.05 || u < -0.05 || u > 1.05) continue;
      const e = a0[0] + dax * t, n = a0[1] + daz * t;
      const d = Math.hypot(e, n);
      if (d < bestD) { bestD = d; found = { lon: LON0 + e / KX, lat: LAT0 + n / KY }; }
    }
  }
  // (Queen St is closed at Yonge St for the Ontario Line's construction, so OpenStreetMap may have no crossing: then the
  // corner's surveyed place, the Yonge St node at Queen St)
  if (!found) found = { lon: LON0, lat: LAT0 };
  ORIGIN = gridUV(found.lon, found.lat);
  log(`bearing ${(THETA * 180 / Math.PI).toFixed(3)}°, origin (Yonge St & Queen St) at ${found.lat.toFixed(6)}, ${found.lon.toFixed(6)}`);
}

// =====================================================================================================================
// 4. THE DETAILED DOWNTOWN & THE LAKE
// =====================================================================================================================
// Downtown, simulated in full: from just west of Bathurst St to the Don River, from just north of Bloor St down to the
// lake (the Port Lands' western quays included). Beyond it the low-detail city (js/surroundings.js) carries on.
const DETAIL = { x0: -2140, x1: 2080, z0: -2140, z1: 1800 };
// ...minus the Port Lands south of the Keating Channel, east of the Parliament Slip
const DETAIL_CUT = { x0: 1460, x1: DETAIL.x1, z0: 1130, z1: DETAIL.z1 };

// Lake Ontario from its multipolygon: every member's nodes inside the fetched window as runs, chained end to start
const lake = load('osm_lake.json').elements.find((e) => e.type === 'relation');
const lakeRuns = [];
for (const m of lake.members) {
  if (m.type !== 'way' || !m.geometry) continue;
  let cur = [];
  for (const g of m.geometry) {
    if (g && g.lat !== undefined) cur.push(toWorld(g.lon, g.lat));
    else {
      if (cur.length > 1) lakeRuns.push({ role: m.role, pts: cur });
      cur = [];
    }
  }
  if (cur.length > 1) lakeRuns.push({ role: m.role, pts: cur });
}
function chainRuns(runs) {
  const key = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const byStart = new Map();
  const byEnd = new Map();
  for (const r of runs) {
    byStart.set(key(r.pts[0]), r);
    byEnd.set(key(r.pts[r.pts.length - 1]), r);
  }
  const used = new Set();
  const chains = [];
  for (const r of runs) {
    if (used.has(r)) continue;
    let first = r;
    const seen = new Set([r]);
    for (;;) {
      const prev = byEnd.get(key(first.pts[0]));
      if (!prev || seen.has(prev) || used.has(prev)) break;
      seen.add(prev);
      first = prev;
    }
    const pts = [];
    let cur = first;
    while (cur && !used.has(cur)) {
      used.add(cur);
      pts.push(...(pts.length ? cur.pts.slice(1) : cur.pts));
      cur = byStart.get(key(cur.pts[cur.pts.length - 1]));
    }
    chains.push(pts);
  }
  return chains;
}
// Mainland shore: the outer chains joined west to east (Oakville to Pickering), land to the north
const outerChains = chainRuns(lakeRuns.filter((r) => r.role === 'outer')).filter((c) => c.length > 20);
outerChains.sort((a, b) => a[0][0] - b[0][0]);
let shore = [];
for (const c of outerChains) {
  const ch = c[0][0] < c[c.length - 1][0] ? c : c.slice().reverse();
  if (shore.length && Math.hypot(ch[0][0] - shore[shore.length - 1][0], ch[0][1] - shore[shore.length - 1][1]) > 5) {
    // a separate stretch: keep the longer run of the shore
    if (ch.length > shore.length) shore = ch.slice();
    continue;
  }
  shore.push(...(shore.length ? ch.slice(1) : ch));
}
log(`mainland shore: ${shore.length} pts from (${shore[0].map(Math.round)}) to (${shore[shore.length - 1].map(Math.round)})`);
const FAR = 60000;
const mainland = [[-FAR, shore[0][1]], ...shore, [FAR, shore[shore.length - 1][1]], [FAR, -FAR], [-FAR, -FAR]];

// Islands: the inner rings (the Toronto Islands, Ontario Place's islands...) closed by chaining their ways
const islandRings = chainRuns(lakeRuns.filter((r) => r.role === 'inner'))
  .filter((c) => c.length > 3 && Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 1)
  .map((c) => c.slice(0, -1))
  .filter((r) => Math.abs(ringArea(r)) > 1500);
log(`${islandRings.length} lake islands over 1500 m²`);

// --- Downtown's land: the mainland inside the detail window, slips & slivers narrower than ~10 m smoothed over ------
const RES = 2;
const landRaster = new Raster(DETAIL.x0 - 40, DETAIL.z0 - 40, DETAIL.x1 + 40, DETAIL.z1 + 40, RES);
landRaster.fillRing(clipRect(mainland, DETAIL.x0, DETAIL.x1, DETAIL.z0, DETAIL.z1), 1);
landRaster.fillRing([[DETAIL_CUT.x0, DETAIL_CUT.z0], [DETAIL_CUT.x1 + 40, DETAIL_CUT.z0], [DETAIL_CUT.x1 + 40, DETAIL_CUT.z1 + 40], [DETAIL_CUT.x0, DETAIL_CUT.z1 + 40]], 0);
// The harbour's slips & basins and the Don River are mapped as water of their own, not as the lake: cut them out too
const SHORE_WATER = new Set(['river', 'canal', 'harbour', 'basin', 'slip', 'dock', 'lagoon', 'bay', 'channel']);
const shoreWater = [];
for (const e of load('osm_parks.json').elements) {
  const t = e.tags || {};
  if (t.natural !== 'water' || !(SHORE_WATER.has(t.water) || (!t.water && /Slip|Basin|Channel|River/.test(t.name || '')))) continue;
  const ways = e.type === 'way' ? [e.geometry] : (e.members || []).filter((m) => m.role === 'outer').map((m) => m.geometry);
  for (const g of ways) {
    if (!g || g.length < 4 || !g.every(Boolean)) continue;
    const ring = g.map((p) => toWorld(p.lon, p.lat));
    const b = bbox(ring);
    if (b.x1 < DETAIL.x0 || b.x0 > DETAIL.x1 || b.z1 < DETAIL.z0 || b.z0 > DETAIL.z1) continue;
    shoreWater.push(ring);
  }
}
for (const r of shoreWater) landRaster.fillRing(r, 0);
log(`${shoreWater.length} slips, basins & river reaches cut out of downtown's land`);
landRaster.open(5);
landRaster.close(4);
landRaster.keepLargest();
let downtown = landRaster.traceOuter();
downtown = rdpRing(downtown, 1.2);
if (ringArea(downtown) > 0) downtown.reverse(); // negative shoelace area in (x, z), like every ring of the frame
log(`downtown land ring: ${downtown.length} pts, ${(Math.abs(ringArea(downtown)) / 1e6).toFixed(2)} km²`);

const FRAME_LL = [LAT0, LON0, KX, KY, THETA, ORIGIN[0], ORIGIN[1]];
const geo = { THETA, ORIGIN, FRAME_LL, DETAIL, DETAIL_CUT, shore, mainland, islandRings, downtown, landRaster };
export { geo, toWorld, gridUV, rdp, rdpRing, ringArea, bbox, pointInRing, clipHalfPlane, clipRect, Raster, r1, load, log, centroid, roadWays };
