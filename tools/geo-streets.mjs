// Part 2: Toronto's streets from OpenStreetMap, in the world frame: every highway way as straight pieces carrying the
// attributes the blocks, the road graph and the maps need (curb-to-curb width, travel lanes, direction of travel, at
// grade or not), the elevated expressways (Gardiner, Don Valley Parkway) and the rail & streetcar lines.
import { roadWays, toWorld, rdp, log } from './geo-base.mjs';

// Streets that make up the drivable city: at-grade public roads (no motorways, ramps, lanes or driveways)
const STREET_CLASSES = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary',
  'tertiary_link', 'unclassified', 'residential', 'living_street']);
const MAJOR_CLASSES = new Set(['trunk', 'primary', 'secondary']);

// Curb-to-curb width (m): OSM's own when given, else from the travel lanes (3.3 m each) plus the curb lanes (parking,
// bicycle lanes, streetcar clearances) of each class, never narrower than the class's usual roadway
function curbWidth(t) {
  const w = parseFloat(t.width || '');
  if (w > 3 && w < 40) return w;
  const hw = t.highway.replace('_link', '');
  const oneWay = t.oneway === 'yes' || t.oneway === '-1' || t.junction === 'roundabout';
  const lanes = parseInt(t.lanes || '0', 10);
  if (t.highway.endsWith('_link')) return Math.max(5.5, lanes * 3.4 + 1.2);
  const extra = { trunk: 2.4, primary: 2.2, secondary: 1.6, tertiary: 1.4 }[hw] ?? 1.2;
  const floor = oneWay
    ? { trunk: 10, primary: 8.5, secondary: 8.5, tertiary: 7.5 }[hw] ?? 6.5
    : { trunk: 15, primary: 13, secondary: 12.5, tertiary: 10.5 }[hw] ?? 8.5;
  return Math.min(26, Math.max(floor, lanes ? lanes * 3.3 + extra : 0));
}
// Direction of travel along the way's node order: 1 forward, -1 backward, 0 both
const travelDir = (t) => (t.oneway === 'yes' || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0);
const lanesOf = (t, dir) => {
  const n = parseInt(t.lanes || '0', 10);
  if (n) return n;
  if (MAJOR_CLASSES.has(t.highway)) return dir ? 2 : 4;
  return dir ? 1 : 2;
};
function wayLength(pts) {
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
}

// ---------------------------------------------------------------------------------------------------------------------
// Street ways in world coordinates
// ---------------------------------------------------------------------------------------------------------------------
const ways = [];
for (const w of roadWays) {
  const t = w.tags || {};
  if (!t.highway) continue;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  const L = wayLength(pts);
  const dir = travelDir(t);
  const layer = parseInt(t.layer || '0', 10);
  const bridge = !!t.bridge && t.bridge !== 'no';
  const tunnel = !!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
  // At grade for the street network: ordinary streets, their bridges over the rail corridor & rivers, and the short
  // underpasses beneath the rail viaduct (Yonge, Bay, York, Spadina...)
  const isStreet = STREET_CLASSES.has(t.highway) && t.access !== 'private' && t.area !== 'yes';
  const atGrade = isStreet && (!tunnel || L < 220) && layer < 3;
  ways.push({
    id: w.id,
    name: t.name || '',
    cls: t.highway,
    major: MAJOR_CLASSES.has(t.highway.replace('_link', '')),
    w: curbWidth(t),
    lanes: lanesOf(t, dir),
    dir,
    bridge,
    tunnel,
    layer,
    atGrade,
    service: t.highway === 'service' ? t.service || 'service' : null,
    nodes: w.nodes,
    pts,
    L,
    tags: t
  });
}
log(`${ways.length} highway ways, ${ways.filter((w) => w.atGrade).length} at-grade streets`);

// Straight pieces of the at-grade streets (blocks are cut out of the land by these, at their curb-to-curb widths)
const pieces = [];
for (const w of ways) {
  if (!w.atGrade) continue;
  for (let i = 0; i + 1 < w.pts.length; i++) {
    const [x0, z0] = w.pts[i];
    const [x1, z1] = w.pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 0.3) continue;
    pieces.push({ name: w.name, cls: w.cls, w: w.w, lanes: w.lanes, dir: w.dir, x0, z0, x1, z1, L, way: w });
  }
}
log(`${pieces.length} at-grade street pieces`);

// ---------------------------------------------------------------------------------------------------------------------
// Elevated expressways: the Gardiner (on its piers above Lake Shore Blvd) and the Don Valley Parkway, carriageway by
// carriageway (one-way ways chained end to start), with their ramps
// ---------------------------------------------------------------------------------------------------------------------
function chainWays(list) {
  const byStart = new Map();
  for (const w of list) byStart.set(w.nodes[0], w);
  const used = new Set();
  const chains = [];
  for (const w of list) {
    if (used.has(w)) continue;
    let first = w;
    const seen = new Set([w]);
    for (;;) {
      const prev = list.find((u) => !seen.has(u) && !used.has(u) && u.nodes[u.nodes.length - 1] === first.nodes[0]);
      if (!prev) break;
      seen.add(prev);
      first = prev;
    }
    const pts = [];
    const parts = [];
    let cur = first;
    while (cur && !used.has(cur)) {
      used.add(cur);
      pts.push(...(pts.length ? cur.pts.slice(1) : cur.pts));
      parts.push(cur);
      cur = byStart.get(cur.nodes[cur.nodes.length - 1]);
    }
    chains.push({ pts, parts });
  }
  return chains;
}
const expressways = [];
for (const name of ['Gardiner Expressway', 'Don Valley Parkway']) {
  const list = ways.filter((w) => w.cls === 'motorway' && w.name === name);
  for (const c of chainWays(list)) {
    if (wayLength(c.pts) < 150) continue;
    const lanes = Math.max(...c.parts.map((p) => p.lanes));
    // deck height along it: elevated where its ways are bridges, at grade elsewhere (per point, from its way)
    const elevated = [];
    for (const p of c.parts) for (let i = elevated.length ? 1 : 0; i < p.pts.length; i++) elevated.push(p.bridge ? 1 : 0);
    expressways.push({ name, lanes, w: lanes * 3.6 + 2.4, pts: rdp(c.pts, 0.8), elevated: elevated.length === c.pts.length ? elevated : null, raw: c.pts });
  }
}
const ramps = ways.filter((w) => w.cls === 'motorway_link' || (w.cls === 'motorway' && /Ramp/.test(w.name)))
  .map((w) => ({ name: w.name, lanes: w.lanes, w: Math.max(6, w.lanes * 3.6 + 1.6), dir: w.dir, bridge: w.bridge, layer: w.layer, pts: rdp(w.pts, 0.6) }));
log(`expressways: ${expressways.map((e) => `${e.name} ${Math.round(wayLength(e.pts))} m`).join(', ')}; ${ramps.length} ramps`);

// ---------------------------------------------------------------------------------------------------------------------
// Railways: the Union Station Rail Corridor & its subdivisions (heavy rail), the streetcar network (tram), the subway
// where it surfaces
// ---------------------------------------------------------------------------------------------------------------------
const rails = [];
for (const w of roadWays) {
  const t = w.tags || {};
  if (!t.railway || !['rail', 'tram', 'light_rail', 'subway'].includes(t.railway)) continue;
  const tunnel = t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
  if (t.railway === 'subway' && tunnel) continue;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  rails.push({ kind: t.railway, service: t.service || '', name: t.name || '', bridge: !!t.bridge && t.bridge !== 'no', tunnel: !!tunnel, nodes: w.nodes, pts: rdp(pts, 0.3) });
}
log(`rail: ${rails.filter((r) => r.kind === 'rail').length} heavy-rail ways, ${rails.filter((r) => r.kind === 'tram').length} streetcar ways`);

export { ways, pieces, expressways, ramps, rails, chainWays, wayLength, STREET_CLASSES, MAJOR_CLASSES };

if (process.argv[1] && process.argv[1].endsWith('geo-streets.mjs')) {
  const byName = new Map();
  for (const p of pieces) byName.set(p.name, (byName.get(p.name) || 0) + p.L);
  console.log([...byName].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([n, L]) => `${n || '(unnamed)'} ${Math.round(L)} m`).join('\n'));
}
