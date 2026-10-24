// Part 6: the street centrelines as a graph, for the drivable road network (js/road-network.js). Every at-grade
// street way of OpenStreetMap is split at the nodes it shares with another street (intersections) and at its ends:
// those nodes become graph nodes and each piece a link with its curb-to-curb width, travel lanes and direction of
// travel. Laneways, driveways & parking aisles (service roads) and the expressways stay out.
import { rdp, log, geo } from './geo-base.mjs';
import { ways } from './geo-streets.mjs';

const PAD = 120; // links reaching this far beyond the detail window still count (they end at its edge's streets)

export function buildRoadGraph() {
  const { DETAIL } = geo;
  const streets = ways.filter((w) => w.atGrade && w.cls !== 'living_street');
  const inside = ([x, z]) => x > DETAIL.x0 - PAD && x < DETAIL.x1 + PAD && z > DETAIL.z0 - PAD && z < DETAIL.z1 + PAD;
  // how many street ways use each node (twice for a way's own ends)
  const uses = new Map();
  for (const w of streets) {
    w.nodes.forEach((id, i) => uses.set(id, (uses.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  }
  const nodeIndex = new Map();
  const nodes = [];
  const nodeOf = (id, p) => {
    if (!nodeIndex.has(id)) {
      nodeIndex.set(id, nodes.length / 2);
      nodes.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
    }
    return nodeIndex.get(id);
  };
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
    return nameIds.get(n);
  };
  const links = [];
  for (const w of streets) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && uses.get(w.nodes[i]) < 2) continue;
      const pts = w.pts.slice(start, i + 1);
      if (pts.some(inside)) {
        const a = nodeOf(w.nodes[start], pts[0]);
        const b = nodeOf(w.nodes[i], pts[pts.length - 1]);
        if (a !== b) {
          const inner = rdp(pts, 0.4).slice(1, -1).flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
          links.push([a, b, nameId(w.name), Math.round(w.w * 10) / 10, w.lanes, w.dir, inner]);
        }
      }
      start = i;
    }
  }
  log(`road graph: ${nodes.length / 2} nodes, ${links.length} links`);
  return { nodes, links, names };
}
