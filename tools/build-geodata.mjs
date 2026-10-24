// tools/build-geodata.mjs — writes js/toronto-geodata.js (see geo-base.mjs for the frame and the data sources)
// usage: GEO_DATA=tools/data node --max-old-space-size=8192 tools/build-geodata.mjs [out.js]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { geo, toWorld, rdp, bbox, load, log } from './geo-base.mjs';
import { ways, expressways, ramps, rails } from './geo-streets.mjs';
import { blocks, innerRing, STRIP, SIDEWALK } from './geo-blocks.mjs';
import { heightGrid, parkShapes, waterShapes, towers, landmarks, piers, runways, mainlandPieces, islands } from './geo-extra.mjs';
import { buildRoadGraph } from './geo-roadgraph.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/toronto-geodata.js', import.meta.url));
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const { DETAIL, DETAIL_CUT } = geo;
const PAD = 400;
const near = (pts, pad = PAD) => pts.some(([x, z]) => x > DETAIL.x0 - pad && x < DETAIL.x1 + pad && z > DETAIL.z0 - pad && z < DETAIL.z1 + pad);

// --- Named roads (merged per street, direction & width) for the maps, labels & lookups --------------------------------
function mergeRoads() {
  const byKey = new Map();
  for (const w of ways) {
    if (!w.atGrade || !w.name || !near(w.pts, 60)) continue;
    const key = `${w.name}|${Math.round(w.w)}|${w.dir}|${w.lanes}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(w);
  }
  const out = [];
  for (const [, list] of byKey) {
    // chain ways end to start through shared nodes
    const byStart = new Map(list.map((w) => [w.nodes[0], w]));
    const used = new Set();
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
      const line = [];
      let cur = first;
      while (cur && !used.has(cur)) {
        used.add(cur);
        line.push(...(line.length ? cur.pts.slice(1) : cur.pts));
        cur = byStart.get(cur.nodes[cur.nodes.length - 1]);
      }
      out.push({ name: w.name, w: w.w, dir: w.dir, lanes: w.lanes, hw: false, pts: rdp(line, 0.8) });
    }
  }
  for (const e of expressways) if (near(e.pts)) out.push({ name: e.name, w: e.w, dir: 1, lanes: e.lanes, hw: true, pts: e.pts });
  return out;
}
const roadLines = mergeRoads();
log(`${roadLines.length} road polylines (${roadLines.reduce((t, r) => t + r.pts.length, 0)} pts)`);

// --- Points of note from their real coordinates ------------------------------------------------------------------------
const POINTS = {
  cnTower: [43.642566, -79.387057], rogersCentre: [43.641438, -79.389353], unionStation: [43.645195, -79.380601],
  nathanPhillips: [43.652313, -79.383457], dundasSquare: [43.656171, -79.380299], stLawrenceMarket: [43.648693, -79.371437],
  distillery: [43.650261, -79.359556], queensPark: [43.662151, -79.392392], kensington: [43.654596, -79.400707],
  harbourfront: [43.638738, -79.380714], ferryTerminal: [43.640468, -79.375317], billyBishop: [43.628333, -79.396111],
  ontarioPlace: [43.628889, -79.415556], cinesphere: [43.629412, -79.414688], bmoField: [43.633221, -79.418555],
  centreIsland: [43.618997, -79.374128], gibraltarPoint: [43.613139, -79.384503], wardsIsland: [43.630867, -79.354155],
  hanlansPoint: [43.623333, -79.393889], leslieSpitTip: [43.613167, -79.330003], yongeDundas: [43.656171, -79.380299],
  rom: [43.667710, -79.394777], casaLoma: [43.678037, -79.409443], princeEdwardViaduct: [43.676111, -79.361667],
  flatiron: [43.648597, -79.373857], sugarBeach: [43.643222, -79.367581], hto: [43.638900, -79.385667]
};
const points = Object.fromEntries(Object.entries(POINTS).map(([k, [lat, lon]]) => [k, toWorld(lon, lat).map(q)]));

// --- Rails & streetcar tracks over (and a little beyond) downtown -------------------------------------------------------
const railOut = rails.filter((r) => !r.tunnel && near(r.pts, 200))
  .map((r) => [r.kind, r.service, r.name, r.bridge ? 1 : 0, flat(r.pts)]);

// --- Street furniture & stops (OpenStreetMap nodes): signals, TTC subway entrances & streetcar / bus stops, Canada Post
//     boxes, hydrants, street trees & lamps, Bike Share Toronto docks, benches & bins -------------------------------------
const furniture = { signals: [], crossings: [], subway: [], stops: [], postBoxes: [], hydrants: [], trees: [], lamps: [], bikeShare: [], benches: [], bins: [], ferry: [] };
for (const e of load('osm_nodes.json').elements) {
  if (e.type !== 'node') continue;
  const t = e.tags || {};
  const [x, z] = toWorld(e.lon, e.lat).map(q);
  if (!near([[x, z]], 30)) continue;
  if (t.highway === 'traffic_signals') furniture.signals.push(x, z);
  else if (t.highway === 'crossing' && t.crossing !== 'unmarked') furniture.crossings.push(x, z);
  else if (t.railway === 'subway_entrance' || t.entrance === 'subway') furniture.subway.push([x, z, t.name || '']);
  else if (t.railway === 'tram_stop' || (t.highway === 'bus_stop' && t.public_transport !== 'platform')) furniture.stops.push([x, z, t.railway === 'tram_stop' ? 1 : 0, t.name || '']);
  else if (t.amenity === 'post_box') furniture.postBoxes.push(x, z);
  else if (t.emergency === 'fire_hydrant') furniture.hydrants.push(x, z);
  else if (t.natural === 'tree') furniture.trees.push(x, z);
  else if (t.highway === 'street_lamp') furniture.lamps.push(x, z);
  else if (t.amenity === 'bicycle_rental') furniture.bikeShare.push(x, z);
  else if (t.amenity === 'bench') furniture.benches.push(x, z);
  else if (t.amenity === 'waste_basket') furniture.bins.push(x, z);
  else if (t.amenity === 'ferry_terminal') furniture.ferry.push([x, z, t.name || '']);
}
log(`furniture: ${Object.entries(furniture).map(([k, v]) => `${k} ${Array.isArray(v[0]) ? v.length : v.length / 2}`).join(', ')}`);

// --- Assemble -----------------------------------------------------------------------------------------------------------
const GEO = {
  version: 1,
  frame: {
    bearingDeg: q((geo.THETA * 180) / Math.PI * 10) / 10,
    origin: 'Yonge St & Queen St (centreline)',
    units: 'm',
    strip: STRIP,
    sidewalk: SIDEWALK,
    detail: DETAIL,
    detailCut: DETAIL_CUT,
    // [lat0, lon0, metres per degree of longitude & latitude, bearing (radians), origin (u, v)]: see city-config.js LL()
    ll: geo.FRAME_LL
  },
  downtown: flat(geo.downtown),
  innerShore: flat(innerRing),
  mainland: Object.fromEntries(Object.entries(mainlandPieces).map(([k, r]) => [k, flat(r)])),
  islands: islands.map(flat),
  roads: roadLines.map((r) => [r.name, q(r.w), r.dir, r.lanes, r.hw ? 1 : 0, flat(r.pts)]),
  // Street centreline graph (geo-roadgraph.mjs): nodes [x, z, ...], links [node a, node b, name index, curb-to-curb width,
  // travel lanes, direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...]]
  roadGraph: buildRoadGraph(),
  // [outline, lot rects, park share, park name, rectangular, frontage frames [[θ, px, pz, lot rects in the frame], ...] | 0,
  //  rail share, surface parking share, lot height hints [[tallest, mean, built share], ...], frame lot hints | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0,
    b.rail || 0, b.parking || 0, b.hints, b.frameHints || 0]),
  parks: parkShapes.map((p) => ({ name: p.name, cat: p.cat, area: p.area, rings: p.rings.map(flat) })),
  water: waterShapes.map((w) => ({ name: w.name, kind: w.kind, ring: flat(w.ring) })),
  // Real towers of 40 m and up: outline, height, base (building parts stacked on podia start above the ground)
  towers: towers.map((t) => ({ name: t.name, h: t.h, minH: t.minH, colour: t.colour, material: t.material, roof: t.roof, ring: flat(t.ring) })),
  landmarks: Object.fromEntries(Object.entries(landmarks).map(([k, l]) => [k, { ...l, ring: flat(l.ring) }])),
  expressways: expressways.filter((e) => near(e.pts, 3000)).map((e) => ({ name: e.name, lanes: e.lanes, w: q(e.w), pts: flat(e.pts) })),
  ramps: ramps.filter((r) => near(r.pts, 200)).map((r) => ({ name: r.name, lanes: r.lanes, w: q(r.w), dir: r.dir, bridge: r.bridge ? 1 : 0, pts: flat(r.pts) })),
  rails: railOut,
  piers: piers.filter((p) => near(p.ring || p.line, 3000)).map((p) => (p.ring ? { name: p.name, kind: p.kind, ring: flat(p.ring) } : { name: p.name, kind: p.kind, w: p.w, line: flat(p.line) })),
  runways: runways.map((r) => ({ kind: r.kind, ref: r.ref, w: r.w, closed: r.closed ? 1 : 0, pts: flat(r.pts) })),
  furniture,
  // The real buildings' heights over downtown (geo-extra.mjs): 4 m cells, (value, run) byte pairs, value x 3 m
  heightGrid,
  points
};
void bbox;

const json = JSON.stringify(GEO);
const header = `// js/toronto-geodata.js — GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Real Toronto geography in the simulation's world frame: 1 unit = 1 m, x = street-grid east, z = grid south,
// origin at the centreline intersection of Yonge St & Queen St, axes turned ${GEO.frame.bearingDeg}° from true north.
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: © OpenStreetMap contributors (ODbL): Lake Ontario's shore & the Toronto Islands, streets, rail, parks, water,
// building outlines & heights, piers and the island airport.
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
