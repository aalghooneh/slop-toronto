// js/route-finder.js
// GPS routing over the drivable road graph (road-network.js): A* from wherever the player is to any point on a street,
// following the one-way streets the traffic follows. The result is a polyline of world points (the intersections'
// centres, with the corners rounded off) that the radar, the full map and the glowing guide line on the road all draw.
//
// The graph: nodes { id, x, z, out: [edge] } and directed edges { id, from, to, x0, z0, dx, dz, span, lanes }.

const CELL = 96;

class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, val) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const key = keys.pop();
    const val = vals.pop();
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}

// Rounds the corners of a polyline (Chaikin), keeping its two ends where they are
function smoothPath(points, passes = 2) {
  let pts = points;
  for (let pass = 0; pass < passes && pts.length > 2; pass++) {
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      // (long straights keep their length: only the 6 m either side of a corner is cut)
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const k = Math.min(0.25, 6 / len);
      if (i > 0) out.push({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k });
      if (i + 2 < pts.length) out.push({ x: b.x - (b.x - a.x) * k, z: b.z - (b.z - a.z) * k });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function pathLength(points) {
  let length = 0;
  for (let i = 0; i + 1 < points.length; i++) length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  return length;
}

function createRouteFinder(network) {
  const { nodes, edges } = network;
  nodes.forEach((n, i) => { if (n.id === undefined) n.id = i; });

  // Edges bucketed by the cells their centreline crosses
  const grid = new Map();
  const key = (ix, iz) => ix * 100000 + iz;
  for (const e of edges) {
    const steps = Math.max(1, Math.ceil(e.span / (CELL * 0.5)));
    let last = null;
    for (let k = 0; k <= steps; k++) {
      const t = (e.span * k) / steps;
      const c = key(Math.floor((e.x0 + e.dx * t) / CELL), Math.floor((e.z0 + e.dz * t) / CELL));
      if (c === last) continue;
      last = c;
      let list = grid.get(c);
      if (!list) grid.set(c, (list = []));
      list.push(e);
    }
  }

  // The edges whose centreline comes within `radius` of (x, z): [{ edge, t (m along it), dist, x, z }], nearest first
  function edgesNear(x, z, radius = 60) {
    const found = [];
    const seen = new Set();
    const reach = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iz = cz - reach; iz <= cz + reach; iz++) {
        const list = grid.get(key(ix, iz));
        if (!list) continue;
        for (const e of list) {
          if (seen.has(e)) continue;
          seen.add(e);
          const t = Math.max(0, Math.min(e.span, (x - e.x0) * e.dx + (z - e.z0) * e.dz));
          const px = e.x0 + e.dx * t;
          const pz = e.z0 + e.dz * t;
          const dist = Math.hypot(px - x, pz - z);
          if (dist <= radius) found.push({ edge: e, t, dist, x: px, z: pz });
        }
      }
    }
    return found.sort((a, b) => a.dist - b.dist);
  }

  function nearestEdge(x, z, radius = 400) {
    for (let r = 40; r <= radius; r *= 2) {
      const found = edgesNear(x, z, r);
      if (found.length) return found[0];
    }
    return null;
  }

  const cost = new Float64Array(nodes.length);
  const stamp = new Uint32Array(nodes.length);
  const cameBy = new Array(nodes.length);
  let generation = 0;

  /**
   * The way by road from (fromX, fromZ) to (toX, toZ): { points: [{ x, z }], length } or null where no street is near
   * either end. `heading` (radians, 0 = +z) prefers setting off along the street the way the player already faces.
   */
  function route(fromX, fromZ, toX, toZ, heading = null) {
    const starts = edgesNear(fromX, fromZ, 30);
    if (!starts.length) {
      const e = nearestEdge(fromX, fromZ);
      if (e) starts.push(e);
    }
    const goals = edgesNear(toX, toZ, 30);
    if (!goals.length) {
      const e = nearestEdge(toX, toZ);
      if (e) goals.push(e);
    }
    if (!starts.length || !goals.length) return null;
    const startReach = starts[0].dist + 14;
    const goalReach = goals[0].dist + 14;

    if (++generation === 0xffffffff) {
      stamp.fill(0);
      generation = 1;
    }
    const heap = new MinHeap();
    const h = (n) => Math.hypot(n.x - toX, n.z - toZ);
    const visit = (n, g, by) => {
      if (stamp[n.id] === generation && cost[n.id] <= g) return;
      stamp[n.id] = generation;
      cost[n.id] = g;
      cameBy[n.id] = by;
      heap.push(g + h(n), n.id);
    };

    // Goals: reaching the node a goal edge leaves, then along it to the point beside the destination
    const goalAt = new Map(); // node id -> { edge, t }
    for (const s of goals) {
      if (s.dist > goalReach) break;
      const prev = goalAt.get(s.edge.from.id);
      if (!prev || s.t < prev.t) goalAt.set(s.edge.from.id, s);
    }

    // Already on the street the destination is on, with it ahead: straight there
    let best = null;
    const sinH = heading === null ? 0 : Math.sin(heading);
    const cosH = heading === null ? 0 : Math.cos(heading);
    for (const s of starts) {
      if (s.dist > startReach) break;
      // Setting off against the way the player faces costs a U-turn's worth of road
      const against = heading !== null && s.edge.dx * sinH + s.edge.dz * cosH < -0.3 ? 40 : 0;
      for (const g of goals) {
        if (g.dist > goalReach || g.edge !== s.edge || g.t < s.t) continue;
        const total = against + g.t - s.t;
        if (!best || total < best.total) best = { total, direct: [s, g] };
      }
      visit(s.edge.to, against + s.edge.span - s.t, { start: s });
    }

    let end = null;
    while (heap.size) {
      const id = heap.pop();
      const n = nodes[id];
      const g = cost[id];
      if (best && g + h(n) >= best.total) break;
      const goal = goalAt.get(id);
      if (goal && (!best || g + goal.t < best.total)) {
        best = { total: g + goal.t };
        end = { node: n, goal };
      }
      for (const e of n.out) {
        // (a little preference for the wider streets, as a driver would have)
        visit(e.to, g + e.span * (e.lanes && e.lanes.length > 1 ? 0.92 : 1), { edge: e });
      }
    }
    if (!best) return null;

    const points = [];
    if (best.direct) {
      points.push({ x: best.direct[0].x, z: best.direct[0].z }, { x: best.direct[1].x, z: best.direct[1].z });
    } else {
      points.push({ x: end.goal.x, z: end.goal.z });
      let n = end.node;
      for (let guard = 0; guard < nodes.length; guard++) {
        points.push({ x: n.x, z: n.z });
        const by = cameBy[n.id];
        if (by.start) {
          points.push({ x: by.start.x, z: by.start.z });
          break;
        }
        n = by.edge.from;
      }
      points.reverse();
    }
    // from the player to the street, and from the street to the door
    if (Math.hypot(points[0].x - fromX, points[0].z - fromZ) > 1) points.unshift({ x: fromX, z: fromZ });
    const last = points[points.length - 1];
    if (Math.hypot(last.x - toX, last.z - toZ) > 1) points.push({ x: toX, z: toZ });
    const smooth = smoothPath(points);
    return { points: smooth, length: pathLength(smooth) };
  }

  return { route, nearestEdge, edgesNear };
}

// Where along a route the point (x, z) is: { index (segment), t (0..1 along it), dist (m off the line), along (m from
// the start) }, searching only from segment `from` on (the player doesn't go back along it)
function locateOnPath(points, x, z, from = 0, window = 24) {
  let best = { index: from, t: 0, dist: Infinity, along: 0 };
  let along = 0;
  for (let i = 0; i < from && i + 1 < points.length; i++) along += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  const end = Math.min(points.length - 1, from + window);
  for (let i = from; i < end; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const dist = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    const len = Math.sqrt(len2);
    if (dist < best.dist) best = { index: i, t, dist, along: along + len * t };
    along += len;
  }
  return best;
}

export { createRouteFinder, locateOnPath, smoothPath, pathLength };
