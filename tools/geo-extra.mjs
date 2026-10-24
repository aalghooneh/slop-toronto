// Part 4: parks, rail land & water onto the blocks; real building heights (the towers themselves, and height hints for
// the lots the generator fills); landmark footprints; the Toronto Islands, piers & runways; the low-detail mainland
// around downtown
import { geo, toWorld, rdp, rdpRing, ringArea, bbox, load, log, centroid, clipHalfPlane, Raster } from './geo-base.mjs';
import { blocks, blockRaster as R, blockLabels as lab } from './geo-blocks.mjs';
import { rails } from './geo-streets.mjs';

const { DETAIL, DETAIL_CUT } = geo;
const W = R.w, H = R.h;

// Rings of an OSM element: a closed way, or a multipolygon's outer members chained into closed rings
function elemRings(e, role = 'outer') {
  if (e.type === 'way') {
    const g = (e.geometry || []).filter(Boolean);
    return g.length > 3 ? [g.map((p) => toWorld(p.lon, p.lat))] : [];
  }
  const parts = (e.members || []).filter((m) => m.role === role && m.geometry && m.geometry.every(Boolean)).map((m) => m.geometry.map((p) => toWorld(p.lon, p.lat)));
  const rings = [];
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 500 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const i = parts.findIndex((p) => close(p[0], ring[ring.length - 1]) || close(p[p.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(close(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
    }
    if (ring.length > 3 && close(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}
const simplify = (r, eps) => {
  const s = rdpRing(close0(r), eps);
  if (ringArea(s) > 0) s.reverse();
  return s;
};
function close0(r) {
  return Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.5 ? r.slice(0, -1) : r;
}

// Cells of the block raster covered by a ring, per block label: Map(label -> cells)
function labelCounts(ring) {
  const bb = bbox(ring);
  const j0 = Math.max(0, Math.floor((bb.z0 - R.z0) / R.res)), j1 = Math.min(H - 1, Math.ceil((bb.z1 - R.z0) / R.res));
  const counts = new Map();
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = R.z0 + (j + 0.5) * R.res;
    xs.length = 0;
    for (let a = 0, k = ring.length - 1; a < ring.length; k = a++) {
      const [xa, za] = ring[k], [xb, zb] = ring[a];
      if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
    }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - R.x0) / R.res - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[n + 1] - R.x0) / R.res - 0.5));
      for (let i = i0; i <= i1; i++) {
        const L = lab[j * W + i];
        if (L) counts.set(L, (counts.get(L) || 0) + 1);
      }
    }
  }
  return counts;
}
// blocks don't carry their raster label: recover it from a point inside each block's lot rect or polygon
for (const b of blocks) {
  let best = 0;
  const tryAt = (x, z) => {
    const i = Math.floor((x - R.x0) / R.res), j = Math.floor((z - R.z0) / R.res);
    if (i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i]) best = best || lab[j * W + i];
  };
  for (const r of b.rects) tryAt((r[0] + r[1]) / 2, (r[2] + r[3]) / 2);
  if (!best) {
    const [cx, cz] = centroid(b.poly);
    tryAt(cx, cz);
    for (const [x, z] of b.poly) if (!best) tryAt(x + (cx - x) * 0.1, z + (cz - z) * 0.1);
  }
  b._lab = best;
}
const byLab = new Map(blocks.map((b) => [b._lab, b]));

// ---------------------------------------------------------------------------------------------------------------------
// Parks, rail land & open water (OpenStreetMap)
// ---------------------------------------------------------------------------------------------------------------------
const osmParks = load('osm_parks.json');
const PARK_TAG = (t) => {
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'common' || t.landuse === 'village_green') return 'park';
  if (t.leisure === 'recreation_ground' || t.landuse === 'recreation_ground') return 'park';
  if (t.leisure === 'pitch' || t.leisure === 'playground' || t.leisure === 'dog_park') return 'play';
  if (t.landuse === 'grass' || t.landuse === 'meadow') return 'grass';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (t.landuse === 'forest' || t.natural === 'wood' || t.natural === 'scrub') return 'wood';
  if (t.natural === 'beach' || t.natural === 'sand') return 'beach';
  return null;
};
const parks = [];
const railLand = [];
const waters = [];
const parking = [];
for (const e of osmParks.elements) {
  const t = e.tags || {};
  if (t.landuse === 'railway') {
    for (const r of elemRings(e)) railLand.push(r);
    continue;
  }
  if (t.natural === 'water') {
    for (const r of elemRings(e)) if (Math.abs(ringArea(r)) > 150) waters.push({ name: t.name || '', kind: t.water || '', ring: r });
    continue;
  }
  if (t.amenity === 'parking') {
    if (t.parking === 'underground' || t.parking === 'multi-storey') continue;
    for (const r of elemRings(e)) if (Math.abs(ringArea(r)) > 300) parking.push(r);
    continue;
  }
  const cat = PARK_TAG(t);
  if (!cat) continue;
  for (const r of elemRings(e)) parks.push({ name: t.name || '', cat, area: Math.abs(ringArea(r)), ring: r });
}
log(`${parks.length} park & green rings, ${railLand.length} rail land rings, ${waters.length} water rings, ${parking.length} surface car parks`);

// Coverage of every block by parkland (named parks, lawns, playfields, cemeteries), rail land and surface parking
const parkOf = new Map();
for (const b of blocks) b._park = b._rail = b._parking = 0;
for (const pk of parks) {
  if (pk.area < 400) continue;
  for (const [L, n] of labelCounts(pk.ring)) {
    const b = byLab.get(L);
    if (!b) continue;
    b._park += n;
    const prev = parkOf.get(b);
    const named = pk.name && pk.cat === 'park';
    if (!prev || (named && !prev.named) || (named === prev.named && n > prev.cells)) parkOf.set(b, { name: pk.name, cells: n, named });
  }
}
for (const r of railLand) for (const [L, n] of labelCounts(r)) { const b = byLab.get(L); if (b) b._rail += n; }
// ...and from the heavy-rail tracks themselves (each as a 6 m band), where no rail land is mapped around them
{
  const seen = new Uint8Array(W * H);
  for (const r of rails) {
    if (r.kind !== 'rail' || r.tunnel) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s <= L; s += 0.7) {
        const x = ax + ((bx - ax) * s) / (L || 1), z = az + ((bz - az) * s) / (L || 1);
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            const ii = Math.floor((x + dx - R.x0) / R.res), jj = Math.floor((z + dz - R.z0) / R.res);
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const k = jj * W + ii;
            if (seen[k] || !lab[k]) continue;
            seen[k] = 1;
            const b = byLab.get(lab[k]);
            if (b) b._track = (b._track || 0) + 1;
          }
        }
      }
    }
  }
  for (const b of blocks) {
    b._rail = Math.max(b._rail, Math.min(b.area, (b._track || 0) * 2.2)); // tracks every ~13 m across a corridor fill it
    delete b._track;
  }
}
for (const r of parking) for (const [L, n] of labelCounts(r)) { const b = byLab.get(L); if (b) b._parking += n; }
for (const b of blocks) {
  b.park = Math.min(1, Math.round((b._park / b.area) * 100) / 100);
  b.rail = Math.min(1, Math.round((b._rail / b.area) * 100) / 100);
  b.parking = Math.min(1, Math.round((b._parking / b.area) * 100) / 100);
  const po = parkOf.get(b);
  if (po && b.park > 0.25) b.parkName = po.name;
  delete b._park; delete b._rail; delete b._parking;
}
log(`blocks in parks (>60%): ${blocks.filter((b) => b.park > 0.6).length}; rail blocks (>50%): ${blocks.filter((b) => b.rail > 0.5).length}`);

// Park outlines worth drawing on their own (the park builder & the maps): named parks & greens in or near downtown
const inWindow = (r, pad = 200) => {
  const [cx, cz] = centroid(r);
  return cx > DETAIL.x0 - pad && cx < DETAIL.x1 + pad && cz > DETAIL.z0 - pad && cz < DETAIL.z1 + pad;
};
const parkShapes = parks
  .filter((p) => p.area >= 800 && inWindow(p.ring) && ['park', 'grass', 'cemetery', 'wood', 'play', 'beach'].includes(p.cat))
  .map((p) => ({ name: p.name, cat: p.cat, area: Math.round(p.area), rings: [simplify(p.ring, 0.6)] }));
log(`${parkShapes.length} park outlines kept`);
const waterShapes = waters.filter((w) => inWindow(w.ring, 600)).map((w) => ({ name: w.name, kind: w.kind, ring: simplify(w.ring, 0.6) }));

// ---------------------------------------------------------------------------------------------------------------------
// Buildings: every OpenStreetMap outline & part with its height (tags height / building:levels / min_height), as a
// 2 m max-height raster over downtown (the lots' height hints) and, at 40 m and up, as real towers
// ---------------------------------------------------------------------------------------------------------------------
const osmB = load('osm_buildings.json');
const num = (v) => {
  const n = parseFloat(String(v || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const LOW_TYPES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'garage', 'garages', 'shed', 'roof', 'kiosk', 'hut', 'carport']);
function heightOf(t) {
  const h = num(t.height);
  if (h && h > 1.5) return h;
  const lv = num(t['building:levels']);
  if (lv) return lv * 3.4 + (lv > 4 ? 2 : 1);
  if (LOW_TYPES.has(t.building)) return t.building === 'roof' || t.building === 'carport' ? 4 : 9;
  return 0; // unknown
}
const HR = 2;
const hRaster = new Raster(DETAIL.x0, DETAIL.z0, DETAIL.x1, DETAIL.z1, HR);
const hMax = new Float32Array(hRaster.w * hRaster.h);
const covered = new Uint8Array(hRaster.w * hRaster.h); // any building outline at all (also those of unknown height)
const towers = [];
const named = new Map();
function scanRing(ring, fn) {
  const bb = bbox(ring);
  const j0 = Math.max(0, Math.floor((bb.z0 - hRaster.z0) / HR)), j1 = Math.min(hRaster.h - 1, Math.ceil((bb.z1 - hRaster.z0) / HR));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = hRaster.z0 + (j + 0.5) * HR;
    xs.length = 0;
    for (let a = 0, k = ring.length - 1; a < ring.length; k = a++) {
      const [xa, za] = ring[k], [xb, zb] = ring[a];
      if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
    }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - hRaster.x0) / HR - 0.5)), i1 = Math.min(hRaster.w - 1, Math.floor((xs[n + 1] - hRaster.x0) / HR - 0.5));
      for (let i = i0; i <= i1; i++) fn(j * hRaster.w + i);
    }
  }
}
for (const e of osmB.elements) {
  const t = e.tags || {};
  if (!t.building && (!t['building:part'] || t['building:part'] === 'no')) continue;
  // (towers topped out but still tagged as construction sites count once their height is known)
  if (t.building === 'construction' && !t.height && !t['building:levels']) continue;
  const h = heightOf(t);
  const minH = num(t.min_height) || (num(t['building:min_level']) ? num(t['building:min_level']) * 3.4 : 0);
  for (const ring of elemRings(e)) {
    if (!inWindow(ring, 0)) continue;
    const area = Math.abs(ringArea(ring));
    if (area < 12) continue;
    scanRing(ring, (k) => {
      covered[k] = 1;
      if (h > hMax[k]) hMax[k] = h;
    });
    if (t.name) {
      const prev = named.get(t.name);
      if (!prev || prev.area < area || (prev.h || 0) < h) named.set(t.name, { ring, h, minH, area, part: !!t['building:part'] });
    }
    if (h >= 40 && minH < h - 6 && area >= 60) {
      towers.push({
        name: t.name || '',
        h: Math.round(h * 10) / 10,
        minH: Math.round(minH * 10) / 10,
        part: !!t['building:part'],
        colour: t['building:colour'] || t['colour'] || '',
        material: t['building:material'] || t['building:facade:material'] || '',
        roof: t['roof:shape'] || '',
        area: Math.round(area),
        ring: simplify(ring, 0.35)
      });
    }
  }
}
// A building outline whose parts carry the real heights shows up twice: drop outlines that hold taller parts
towers.sort((a, b) => b.area - a.area);
const towerOut = towers.filter((tw) => {
  if (tw.part) return true;
  const bb = bbox(tw.ring);
  // a part inside it at least as tall: the outline is only the envelope of its parts
  return !towers.some((p) => {
    if (!p.part || p.h < tw.h - 2) return false;
    const [px, pz] = centroid(p.ring);
    return px > bb.x0 && px < bb.x1 && pz > bb.z0 && pz < bb.z1;
  });
});
log(`${towerOut.length} real towers of 40 m and up (${towerOut.filter((t) => t.h >= 150).length} of 150 m and up)`);

// Height hints of every lot rect: [tallest, mean over the built cells, share of the lot built on] from the raster
function hintOf(sample) {
  let n = 0, built = 0, sum = 0, max = 0;
  sample((k) => {
    n++;
    if (!covered[k]) return;
    built++;
    const h = hMax[k] || 10;
    sum += h;
    if (h > max) max = h;
  });
  if (!n) return [0, 0, 0];
  return [Math.round(max), built ? Math.round(sum / built) : 0, Math.round((built / n) * 100) / 100];
}
const cellAt = (x, z) => {
  const i = Math.floor((x - hRaster.x0) / HR), j = Math.floor((z - hRaster.z0) / HR);
  return i >= 0 && j >= 0 && i < hRaster.w && j < hRaster.h ? j * hRaster.w + i : -1;
};
for (const b of blocks) {
  b.hints = b.rects.map(([x0, x1, z0, z1]) => hintOf((f) => {
    for (let z = z0 + 1; z < z1; z += HR) for (let x = x0 + 1; x < x1; x += HR) { const k = cellAt(x, z); if (k >= 0) f(k); }
  }));
  if (b.frames) {
    b.frameHints = b.frames.map(([th, px, pz, rs]) => {
      const cs = Math.cos(th), sn = Math.sin(th);
      return rs.map(([x0, x1, z0, z1]) => hintOf((f) => {
        for (let z = z0 + 1; z < z1; z += HR) {
          for (let x = x0 + 1; x < x1; x += HR) {
            const wx = px + (x - px) * cs + (z - pz) * sn, wz = pz - (x - px) * sn + (z - pz) * cs;
            const k = cellAt(wx, wz);
            if (k >= 0) f(k);
          }
        }
      }));
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Landmarks: real footprints of the buildings js/landmarks.js models (bounding box in the grid frame, height, outline)
// ---------------------------------------------------------------------------------------------------------------------
const LANDMARK_NAMES = ['CN Tower', 'Rogers Centre', 'Union Station', 'Fairmont Royal York Hotel', 'Old City Hall', 'Toronto City Hall',
  'Gooderham Building', 'First Canadian Place', 'Scotia Plaza', 'Royal Bank Plaza North Tower', 'Royal Bank Plaza South Tower',
  'Commerce Court West', 'Commerce Court North', 'Bay Adelaide Centre West Tower', 'Bay Adelaide Centre East Tower', 'Scotiabank Arena',
  'Royal Ontario Museum', 'Ontario Legislative Building', 'North St. Lawrence Market', 'St. Lawrence Market South', 'Roy Thomson Hall',
  'Hockey Hall of Fame', 'Art Gallery of Ontario', 'Sharp Centre for Design', 'Aura', 'One Bloor West', 'Massey Hall', 'Osgoode Hall',
  'Ripley\'s Aquarium of Canada', 'Metro Toronto Convention Centre - North Building', 'Metro Toronto Convention Centre - South Building',
  'CF Toronto Eaton Centre', 'Brookfield Place', 'Allen Lambert Galleria', 'Canada Life', 'Simpson Tower', 'Exchange Tower',
  'Westin Harbour Castle', 'Cathedral Church of St. James', 'Four Seasons Centre for the Performing Arts', 'Princess of Wales Theatre',
  'Royal Alexandra Theatre', 'Meridian Hall', 'John Street Roundhouse', 'Queen\'s Wharf Lighthouse', 'Hudson\'s Bay Centre'];
const landmarks = {};
for (const n of LANDMARK_NAMES) {
  const m = named.get(n);
  if (!m) continue;
  const b = bbox(m.ring);
  landmarks[n] = { x: q1((b.x0 + b.x1) / 2), z: q1((b.z0 + b.z1) / 2), w: q1(b.x1 - b.x0), d: q1(b.z1 - b.z0), h: m.h || null, area: Math.round(m.area), ring: simplify(m.ring, 0.4) };
}
log(`${Object.keys(landmarks).length} landmark footprints (missing: ${LANDMARK_NAMES.filter((n) => !landmarks[n]).join(', ') || 'none'})`);
function q1(v) { return Math.round(v * 10) / 10; }

// ---------------------------------------------------------------------------------------------------------------------
// Piers, breakwaters & the island airport's runways (OpenStreetMap)
// ---------------------------------------------------------------------------------------------------------------------
const osmPiers = load('osm_piers.json');
const piers = [];
const runways = [];
for (const e of osmPiers.elements) {
  const t = e.tags || {};
  if (t.aeroway) {
    if (e.type !== 'way') continue;
    const pts = (e.geometry || []).filter(Boolean).map((g) => toWorld(g.lon, g.lat));
    if (pts.length < 2) continue;
    const closed = e.nodes && e.nodes[0] === e.nodes[e.nodes.length - 1];
    runways.push({ kind: t.aeroway, ref: t.ref || '', w: num(t.width) || (t.aeroway === 'runway' ? 45 : 23), closed: !!closed && t.aeroway !== 'runway', pts: rdp(pts, 0.5) });
    continue;
  }
  for (const r of elemRings(e)) if (Math.abs(ringArea(r)) > 40) piers.push({ name: t.name || '', kind: t.man_made, ring: simplify(r, 0.4) });
  if (e.type === 'way' && !elemRings(e).length) {
    // an open way: a breakwater or a narrow pier drawn as a line
    const pts = (e.geometry || []).filter(Boolean).map((g) => toWorld(g.lon, g.lat));
    if (pts.length > 1) piers.push({ name: t.name || '', kind: t.man_made, line: rdp(pts, 0.4), w: num(t.width) || (t.man_made === 'breakwater' ? 8 : 4) });
  }
}
log(`${piers.length} piers & breakwaters, ${runways.length} airport surfaces`);

// ---------------------------------------------------------------------------------------------------------------------
// The low-detail mainland around downtown: the mainland polygon cut into the pieces beyond the detail window (west,
// north, east, south of it, and the Port Lands corner cut out of it)
// ---------------------------------------------------------------------------------------------------------------------
const M = geo.mainland;
const halfPlanes = (ring, planes) => planes.reduce((r, [nx, nz, c]) => (r.length ? clipHalfPlane(r, nx, nz, c) : r), ring);
const { x0, x1, z0, z1 } = DETAIL;
const mainlandPieces = {
  west: halfPlanes(M, [[1, 0, x0]]),
  north: halfPlanes(M, [[-1, 0, -x0], [1, 0, x1], [0, 1, z0]]),
  east: halfPlanes(M, [[-1, 0, -x1]]),
  south: halfPlanes(M, [[-1, 0, -x0], [1, 0, x1], [0, -1, -z1]]),
  portLands: halfPlanes(M, [[-1, 0, -DETAIL_CUT.x0], [1, 0, x1], [0, -1, -DETAIL_CUT.z0], [0, 1, z1]])
};
for (const [k, r] of Object.entries(mainlandPieces)) {
  if (r.length < 3 || Math.abs(ringArea(r)) < 1000) { delete mainlandPieces[k]; continue; }
  mainlandPieces[k] = simplify(r.concat([r[0]]), k === 'portLands' ? 1 : 3);
  log(`mainland ${k}: ${mainlandPieces[k].length} pts, ${(Math.abs(ringArea(mainlandPieces[k])) / 1e6).toFixed(1)} km²`);
}

// The lake's islands: the Toronto Islands (Centre, Ward's, Algonquin, Olympic, Hanlan's, the airport) & Ontario Place's
const islands = geo.islandRings.map((r) => simplify(r.concat([r[0]]), Math.abs(ringArea(r)) > 2e5 ? 1.2 : 0.8))
  .sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
log(`${islands.length} islands`);

// ---------------------------------------------------------------------------------------------------------------------
// The real buildings' heights on a 4 m grid over downtown (0: no building), run-length encoded: (value, run) byte
// pairs, runs up to 255, values in 3 m steps, base64. The generator (buildings.js) keeps its parts where buildings
// really stand and no taller than they are.
// ---------------------------------------------------------------------------------------------------------------------
const HG = 4;
const heightGrid = (() => {
  const w = Math.ceil((DETAIL.x1 - DETAIL.x0) / HG);
  const h = Math.ceil((DETAIL.z1 - DETAIL.z0) / HG);
  const cells = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      // the cell's 2x2 raster cells: built if any is, the tallest of them
      let built = 0, top = 0;
      for (let dj = 0; dj < 2; dj++) {
        for (let di = 0; di < 2; di++) {
          const k = cellAt(DETAIL.x0 + i * HG + di * 2 + 1, DETAIL.z0 + j * HG + dj * 2 + 1);
          if (k < 0 || !covered[k]) continue;
          built = 1;
          top = Math.max(top, hMax[k] || 10);
        }
      }
      cells[j * w + i] = built ? Math.max(1, Math.min(255, Math.round(top / 3))) : 0;
    }
  }
  const bytes = [];
  for (let k = 0; k < cells.length;) {
    let n = 1;
    while (k + n < cells.length && cells[k + n] === cells[k] && n < 255) n++;
    bytes.push(cells[k], n);
    k += n;
  }
  log(`height grid ${w} x ${h} (4 m): ${bytes.length} RLE bytes`);
  return { x0: DETAIL.x0, z0: DETAIL.z0, cell: HG, w, h, step: 3, rle: Buffer.from(bytes).toString('base64') };
})();

export { heightGrid, parks, parkShapes, waterShapes, railLand, towerOut as towers, landmarks, piers, runways, mainlandPieces, islands };
