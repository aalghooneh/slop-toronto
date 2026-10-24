import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EXPRESSWAYS, RAMPS, DETAIL } from './city-config.js';

// js/expressways.js
// The drivable expressways: the Gardiner on its piers ~14 m over Lake Shore Blvd, the Don Valley Parkway up the valley
// from where the Gardiner swings north at the Don, and the ramps between them and the streets (OpenStreetMap
// motorway_link ways). Each carriageway is a ribbon, a centre line with a height at every vertex: the Gardiner's deck
// at DECK_Y, the DVP down in the valley at grade (rising to the deck over its last DVP_CLIMB m), and every ramp
// interpolated between the heights of what its ends join (a motorway's node: that deck; a street: the ground).
// surfaceAt() answers what the player stands on; buildExpressways() lays the decks, barriers, piers & markings.

const DECK_Y = 14.0;
const DECK_T = 1.5;
const DVP_CLIMB = 380;
const STEP = 8;
const LIFT = 0.05; // the asphalt's top over the ribbon's centre line (proud of the ground where it runs at grade)
// What is laid out: the Gardiner from the Exhibition to the Don, the DVP up past the Bloor Viaduct
const WIN = { x0: DETAIL.x0 - 900, x1: DETAIL.x1 + 900, z0: -3000, z1: DETAIL.z1 + 900 };
const inWin = (p) => p.x > WIN.x0 && p.x < WIN.x1 && p.z > WIN.z0 && p.z < WIN.z1;

// The first run of a polyline inside the window (its longest stretch of consecutive vertices there), resampled every
// ~STEP m
function windowRun(src) {
  let kept = [];
  let run = [];
  for (const p of [...src, null]) {
    if (p && inWin(p)) run.push(p);
    else {
      if (run.length > kept.length) kept = run;
      run = [];
    }
  }
  if (kept.length < 2) return null;
  const pts = [{ ...kept[0] }];
  for (let i = 1; i < kept.length; i++) {
    const a = pts[pts.length - 1], b = kept[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 1; k <= n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return pts;
}
const arc = (pts) => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return cum;
};
const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------------------------------------------------
// The ribbons: { kind: 'gardiner' | 'dvp' | 'ramp', name, w, lanes, pts: [{ x, z, y }], cum, len }
// ---------------------------------------------------------------------------------------------------------------------
const RIBBONS = [];
const ribbon = (kind, name, w, lanes, pts) => {
  const cum = arc(pts);
  const r = { kind, name, w, lanes, pts, cum, len: cum[cum.length - 1] };
  RIBBONS.push(r);
  return r;
};
const gardiner = [];
for (const e of EXPRESSWAYS) {
  if (e.name !== 'Gardiner Expressway') continue;
  const pts = windowRun(e.pts);
  if (pts) gardiner.push(ribbon('gardiner', e.name, e.w, e.lanes, pts.map((p) => ({ ...p, y: DECK_Y }))));
}
// The DVP: each carriageway joined to the Gardiner carriageway whose end it meets at the Don, climbing to its deck
for (const e of EXPRESSWAYS) {
  if (e.name !== 'Don Valley Parkway') continue;
  let pts = windowRun(e.pts);
  if (!pts) continue;
  const near = (p, q) => Math.hypot(p.x - q.x, p.z - q.z) < 260;
  let fromStart = false, fromEnd = false;
  for (const g of gardiner) {
    const gEnd = g.pts[g.pts.length - 1];
    const gStart = g.pts[0];
    if (!fromStart && near(gEnd, pts[0])) {
      pts = [...windowRun([gEnd, pts[0]]).slice(0, -1), ...pts];
      fromStart = true;
    } else if (!fromEnd && near(gStart, pts[pts.length - 1])) {
      pts = [...pts, ...windowRun([pts[pts.length - 1], gStart]).slice(1)];
      fromEnd = true;
    }
  }
  const cum = arc(pts);
  const len = cum[cum.length - 1];
  ribbon('dvp', e.name, e.w, e.lanes, pts.map((p, i) => {
    const up = Math.max(fromStart ? smooth(Math.max(0, 1 - cum[i] / DVP_CLIMB)) : 0, fromEnd ? smooth(Math.max(0, 1 - (len - cum[i]) / DVP_CLIMB)) : 0);
    return { ...p, y: DECK_Y * up };
  }));
}

// The surface lookup: every segment bucketed into CELL m cells
const CELL = 32;
const SEGS = [];
const cells = new Map();
const cellKey = (ix, iz) => (ix + 2048) * 4096 + (iz + 2048);
function indexRibbon(r) {
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) continue;
    const seg = { r, i, ax: a.x, az: a.z, ay: a.y, bx: b.x, bz: b.z, by: b.y, len, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, hw: r.w / 2 };
    SEGS.push(seg);
    const m = seg.hw + 2;
    for (let ix = Math.floor((Math.min(a.x, b.x) - m) / CELL); ix <= Math.floor((Math.max(a.x, b.x) + m) / CELL); ix++) {
      for (let iz = Math.floor((Math.min(a.z, b.z) - m) / CELL); iz <= Math.floor((Math.max(a.z, b.z) + m) / CELL); iz++) {
        const k = cellKey(ix, iz);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(seg);
      }
    }
  }
}
for (const r of RIBBONS) indexRibbon(r);

// Where (x, z) falls on a segment: along (t, 0..1, a little past both ends so the joints overlap) and across (lat, m)
function onSegment(seg, x, z, out) {
  const dx = x - seg.ax, dz = z - seg.az;
  const along = dx * seg.ux + dz * seg.uz;
  const lat = dx * seg.uz - dz * seg.ux;
  out.t = along / seg.len;
  out.lat = lat;
  out.y = seg.ay + (seg.by - seg.ay) * Math.min(1, Math.max(0, out.t));
  return along > -1.5 && along < seg.len + 1.5 && Math.abs(lat) <= seg.hw;
}
const probe = { t: 0, lat: 0, y: 0 };
// The highest deck under (x, z) no higher than yMax: { y, seg } or null
function surfaceAt(x, z, yMax = Infinity) {
  const list = cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!list) return null;
  let best = null;
  let bestY = -Infinity;
  for (const seg of list) {
    if (!onSegment(seg, x, z, probe) || probe.y > yMax || probe.y <= bestY) continue;
    bestY = probe.y;
    best = seg;
  }
  return best ? { y: bestY + LIFT, seg: best } : null;
}
// (x, z) brought back inside a segment's barriers (`margin` m clear of them) and its ends: { x, z, y }
function clampToSegment(seg, x, z, margin) {
  onSegment(seg, x, z, probe);
  const t = Math.min(1, Math.max(0, probe.t));
  const room = Math.max(0, seg.hw - 0.5 - margin);
  const lat = Math.min(room, Math.max(-room, probe.lat));
  const s = t * seg.len;
  return { x: seg.ax + seg.ux * s + seg.uz * lat, z: seg.az + seg.uz * s - seg.ux * lat, y: seg.ay + (seg.by - seg.ay) * t + LIFT };
}

// ---------------------------------------------------------------------------------------------------------------------
// The ramps: every motorway_link in the window, at the heights of what its ends join
// ---------------------------------------------------------------------------------------------------------------------
{
  const ways = RAMPS.filter((r) => r.pts.length > 1 && r.pts.every(inWin));
  const nodes = new Map();
  const nodeOf = (p) => {
    const k = Math.round(p.x * 2) + ',' + Math.round(p.z * 2);
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { x: p.x, z: p.z, links: [], y: 0, fixed: false }));
    return n;
  };
  const links = ways.map((w) => {
    const cum = arc(w.pts);
    const a = nodeOf(w.pts[0]);
    const b = nodeOf(w.pts[w.pts.length - 1]);
    const L = Math.max(1, cum[cum.length - 1]);
    a.links.push({ n: b, L });
    b.links.push({ n: a, L });
    return { w, a, b };
  });
  // the ends: on a motorway (a node of its centre line), its deck; a dead end, the street; the rest relaxes in between
  for (const n of nodes.values()) {
    let onDeck = null;
    for (const seg of cells.get(cellKey(Math.floor(n.x / CELL), Math.floor(n.z / CELL))) || []) {
      if (onSegment(seg, n.x, n.z, probe) && Math.abs(probe.lat) < 3 && (!onDeck || probe.y > onDeck)) onDeck = probe.y;
    }
    if (onDeck !== null) {
      n.y = onDeck;
      n.fixed = true;
    } else if (n.links.length === 1) n.fixed = true;
  }
  for (let it = 0; it < 300; it++) {
    for (const n of nodes.values()) {
      if (n.fixed) continue;
      let s = 0, wsum = 0;
      for (const l of n.links) {
        s += l.n.y / l.L;
        wsum += 1 / l.L;
      }
      if (wsum) n.y = s / wsum;
    }
  }
  // Is (x, z) still on the Gardiner's or the DVP's deck at height y (the start of a ramp that has yet to branch off)?
  const onMainDeck = (x, z, y) => (cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || [])
    .some((seg) => seg.r.kind !== 'ramp' && onSegment(seg, x, z, probe) && Math.abs(probe.y - y) < 0.5);
  for (const { w, a, b } of links) {
    // resample
    const pts = [{ x: w.pts[0].x, z: w.pts[0].z }];
    for (let i = 1; i < w.pts.length; i++) {
      const p = w.pts[i - 1], q = w.pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / STEP));
      for (let k = 1; k <= n; k++) pts.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
    }
    // level with the deck it leaves (or joins) until it is clear of that deck's barriers, sloping in between
    const cum = arc(pts);
    const len = cum[cum.length - 1];
    let i0 = 0, i1 = pts.length - 1;
    while (i0 < i1 && onMainDeck(pts[i0].x, pts[i0].z, a.y)) i0++;
    while (i1 > i0 && onMainDeck(pts[i1].x, pts[i1].z, b.y)) i1--;
    const s0 = cum[i0], s1 = Math.max(cum[i1], s0 + 1);
    for (let i = 0; i < pts.length; i++) pts[i].y = a.y + (b.y - a.y) * smooth(Math.min(1, Math.max(0, (cum[i] - s0) / (s1 - s0))));
    if (len > 0) indexRibbon(ribbon('ramp', w.name, Math.max(w.w, 6.5), w.lanes, pts));
  }
}

// Does any expressway pass within `pad` m of the world rect [x0, x1] x [z0, z1]? (the far city keeps its blocks clear)
function expresswayNearRect(x0, z0, x1, z1, pad = 6) {
  for (let ix = Math.floor((x0 - pad) / CELL); ix <= Math.floor((x1 + pad) / CELL); ix++) {
    for (let iz = Math.floor((z0 - pad) / CELL); iz <= Math.floor((z1 + pad) / CELL); iz++) {
      for (const seg of cells.get(cellKey(ix, iz)) || []) {
        const m = pad + seg.hw;
        for (let s = 0; s <= seg.len; s += 3) {
          const x = seg.ax + seg.ux * s, z = seg.az + seg.uz * s;
          if (x > x0 - m && x < x1 + m && z > z0 - m && z < z1 + m) return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// GEOMETRY
// ---------------------------------------------------------------------------------------------------------------------
// The right of travel at every vertex (x east, z south: right = (-dz, dx))
function rights(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / L, z: (b.x - a.x) / L };
  });
}
// A sheet along the ribbon between (offset o1, height dy1) and (o2, dy2) from the centre line; dy may be a function of
// the vertex. Non-indexed, flat normals (the materials are double-sided)
function sheet(pts, R, o1, dy1, o2, dy2, i0 = 0, i1 = pts.length - 1) {
  const pos = [];
  const f = (dy, p) => (typeof dy === 'function' ? dy(p) : dy);
  const v = (i, o, dy) => [pts[i].x + R[i].x * o, pts[i].y + f(dy, pts[i]), pts[i].z + R[i].z * o];
  for (let i = i0; i < i1; i++) {
    const a1 = v(i, o1, dy1), a2 = v(i, o2, dy2), b1 = v(i + 1, o1, dy1), b2 = v(i + 1, o2, dy2);
    pos.push(...a1, ...b1, ...a2, ...a2, ...b1, ...b2);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
// A point along a ribbon at arc length s: { x, z, y, rx, rz }
function along(r, s) {
  const { pts, cum } = r;
  let i = 0;
  while (i + 2 < pts.length && cum[i + 1] < s) i++;
  const a = pts[i], b = pts[i + 1];
  const L = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i]) / L));
  const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, rx: -dz, rz: dx };
}

// Does another deck or ramp run under a pier's cap beam (width w, centred on (x, z), across yaw) below height yMax?
// Such a pier would stand in the lower road, so it is left out
function roadUnder(x, z, yaw, w, yMax) {
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  for (let o = -w / 2; o <= w / 2; o += 1) {
    for (const a of [-1.4, 0, 1.4]) {
      if (surfaceAt(x + rx * o + Math.sin(yaw) * a, z + rz * o + Math.cos(yaw) * a, yMax)) return true;
    }
  }
  return false;
}

function buildExpressways(group, highwayLanes) {
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x9a968d, roughness: 0.86, side: THREE.DoubleSide });
  const asphalt = new THREE.MeshStandardNodeMaterial({ color: 0x2c2d30, roughness: 0.82, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xe8e6df, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const yellow = new THREE.MeshStandardNodeMaterial({ color: 0xd9a92c, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const geos = { concrete: [], asphalt: [], white: [], yellow: [] };
  const push = (k, g) => g && geos[k].push(g);
  const boxes = [];
  const colliders = [];
  const boxGeo = (cx, cy, cz, w, h, L, yaw) => {
    const g = new THREE.BoxGeometry(w, h, L).rotateY(yaw).translate(cx, cy, cz).toNonIndexed();
    g.deleteAttribute('uv'); // (merged with the uv-less sheets)
    return g;
  };
  const ELEVATED = 0.6;
  for (const r of RIBBONS) {
    const P = r.pts;
    const R = rights(P);
    const hw = r.w / 2;
    // the asphalt (a few cm proud of the ground where the road runs at grade)
    push('asphalt', sheet(P, R, -hw + 0.45, LIFT, hw - 0.45, LIFT));
    // the concrete deck where it stands clear of the ground: slab edges, soffit, Jersey barriers
    let i = 0;
    while (i < P.length - 1) {
      if (P[i].y < ELEVATED && P[i + 1].y < ELEVATED) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < P.length - 1 && (P[j].y >= ELEVATED || P[j + 1].y >= ELEVATED)) j++;
      const T = (p) => -Math.min(DECK_T, Math.max(0.05, p.y));
      for (const s of [-1, 1]) {
        push('concrete', sheet(P, R, s * hw, T, s * hw, 0.9, i, j)); // outer face, slab edge to barrier top
        push('concrete', sheet(P, R, s * (hw - 0.45), 0, s * (hw - 0.45), 0.9, i, j)); // the barrier's inner face
        push('concrete', sheet(P, R, s * hw, 0.9, s * (hw - 0.45), 0.9, i, j)); // its top
      }
      push('concrete', sheet(P, R, -hw, T, hw, T, i, j));
      push('concrete', sheet(P, R, -hw + 0.45, 0.0, hw - 0.45, 0.0, i, j)); // the deck under the asphalt
      i = j;
    }
    // at grade, the DVP keeps its Jersey barriers along both edges
    if (r.kind === 'dvp') {
      let a = 0;
      while (a < P.length - 1) {
        if (P[a].y >= ELEVATED) {
          a++;
          continue;
        }
        let b = a + 1;
        while (b < P.length - 1 && P[b].y < ELEVATED) b++;
        for (const s of [-1, 1]) {
          push('concrete', sheet(P, R, s * hw, 0, s * hw, 0.85, a, b));
          push('concrete', sheet(P, R, s * (hw - 0.45), LIFT, s * (hw - 0.45), 0.85, a, b));
          push('concrete', sheet(P, R, s * hw, 0.85, s * (hw - 0.45), 0.85, a, b));
        }
        a = b;
      }
    }
    // markings: a yellow edge line on the left (the median side), white on the right, dashed lane lines between
    const mark = () => LIFT + 0.015;
    push('yellow', sheet(P, R, -hw + 0.75, mark, -hw + 0.9, mark));
    push('white', sheet(P, R, hw - 0.9, mark, hw - 0.75, mark));
    const lanes = Math.max(1, Math.round(r.lanes || 1));
    const inner = hw - 0.85;
    for (let k = 1; k < lanes; k++) {
      const off = -inner + (2 * inner * k) / lanes;
      const pos = [];
      for (let s = 2; s + 3 < r.len; s += 12) {
        const a = along(r, s), b = along(r, s + 3);
        const ya = a.y + mark(a), yb = b.y + mark(b);
        const q = (p, o, y) => [p.x + p.rx * o, y, p.z + p.rz * o];
        const a1 = q(a, off - 0.075, ya), a2 = q(a, off + 0.075, ya), b1 = q(b, off - 0.075, yb), b2 = q(b, off + 0.075, yb);
        pos.push(...a1, ...b1, ...a2, ...a2, ...b1, ...b2);
      }
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        push('white', g);
      }
    }
    // piers: a column & cap beam every ~32 m under the deck; corridor boxes (no building under or on the road)
    let run = 0;
    let box = null;
    for (let k = 0; k + 1 < P.length; k++) {
      const a = P[k], b = P[k + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.05) continue;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      if (!box) box = { ax: a.x, az: a.z, L: 0, ux, uz };
      box.L += L;
      if (box.L > 24 || k + 2 === P.length) {
        const ex = b.x - box.ax, ez = b.z - box.az;
        const bl = Math.hypot(ex, ez) || 1;
        boxes.push({ cx: (box.ax + b.x) / 2, cz: (box.az + b.z) / 2, ux: ex / bl, uz: ez / bl, hl: bl / 2 + 1, hw: hw + 2 });
        box = null;
      }
      run += L;
      const h = b.y - DECK_T;
      if (run >= 32 && h > 3 && !roadUnder(b.x, b.z, yaw, r.w - 2, h - 1)) {
        run = 0;
        push('concrete', boxGeo(b.x, h / 2, b.z, 1.8, h, 1.6, yaw));
        push('concrete', boxGeo(b.x, h - 0.6, b.z, r.w - 2, 1.2, 2.0, yaw));
        colliders.push({ minX: b.x - 1.4, maxX: b.x + 1.4, minZ: b.z - 1.4, maxZ: b.z + 1.4, maxY: h });
      }
    }
    // the ambient traffic's lanes (the Gardiner & the DVP; the ramps stay clear)
    if (r.kind !== 'ramp') {
      for (let k = 0; k < r.lanes; k++) {
        const off = (k - (r.lanes - 1) / 2) * 3.6;
        highwayLanes.push({ pts: P.map((p, n) => new THREE.Vector3(p.x + R[n].x * off, p.y + mark(p) + 0.02, p.z + R[n].z * off)), speed: 22 + k * 1.5 });
      }
    }
  }
  const mats = { concrete, asphalt, white, yellow };
  for (const [k, list] of Object.entries(geos)) {
    for (let i = 0; i < list.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(list.slice(i, i + 400), false), mats[k]);
      m.castShadow = k === 'concrete';
      m.receiveShadow = true;
      m.name = 'Expressway';
      group.add(m);
    }
  }
  console.info(`[expressways] ${RIBBONS.filter((r) => r.kind !== 'ramp').length} carriageways, ${RIBBONS.filter((r) => r.kind === 'ramp').length} ramps, ${Math.round(RIBBONS.reduce((t, r) => t + r.len, 0) / 1000)} km drivable`);
  return { boxes, colliders };
}

export { buildExpressways, surfaceAt, clampToSegment, expresswayNearRect, RIBBONS, DECK_Y };
