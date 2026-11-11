import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteFinder, locateOnPath, pathLength } from '../js/route-finder.js';

// A grid of two-way streets 100 m apart (n x n intersections), with one one-way street along its top row
function grid(n = 5, oneWayTop = false) {
  const nodes = [];
  const edges = [];
  const at = (i, j) => nodes[j * n + i];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nodes.push({ id: nodes.length, x: i * 100, z: j * 100, in: [], out: [] });
  const link = (a, b) => {
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const e = { id: edges.length, from: a, to: b, x0: a.x, z0: a.z, dx: (b.x - a.x) / span, dz: (b.z - a.z) / span, span, lanes: [1.8] };
    e.rx = -e.dz;
    e.rz = e.dx;
    edges.push(e);
    a.out.push(e);
    b.in.push(e);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (i + 1 < n) {
      link(at(i, j), at(i + 1, j));
      if (!(oneWayTop && j === 0)) link(at(i + 1, j), at(i, j));
    }
    if (j + 1 < n) {
      link(at(i, j), at(i, j + 1));
      link(at(i, j + 1), at(i, j));
    }
  }
  return { nodes, edges };
}

test('a route follows the streets and is as short as the grid allows', () => {
  const finder = createRouteFinder(grid());
  const route = finder.route(0, 50, 400, 350);
  assert.ok(route, 'there is a way');
  // Manhattan distance 700 m; rounding the corners only ever shortens it a little
  assert.ok(route.length > 640 && route.length <= 701, `about 700 m by road, got ${route.length}`);
  assert.equal(Math.round(pathLength(route.points)), Math.round(route.length));
  const first = route.points[0];
  const last = route.points[route.points.length - 1];
  assert.ok(Math.hypot(first.x, first.z - 50) < 1 && Math.hypot(last.x - 400, last.z - 350) < 1, 'door to door');
  for (const p of route.points) {
    const onStreet = Math.min(Math.abs(p.x % 100), 100 - Math.abs(p.x % 100)) < 8 || Math.min(Math.abs(p.z % 100), 100 - Math.abs(p.z % 100)) < 8;
    assert.ok(onStreet, `(${p.x}, ${p.z}) is on a street`);
  }
});

test('one-way streets are driven the right way round', () => {
  const finder = createRouteFinder(grid(5, true));
  // Along the top row west to east is allowed: straight there
  assert.ok(finder.route(50, 0, 350, 0).length < 310);
  // East to west is against the one-way: round the block instead
  const back = finder.route(350, 0, 50, 0);
  assert.ok(back.length > 400, `detours round the block, got ${back.length}`);
});

test('a point already on the destination street goes straight to it', () => {
  const finder = createRouteFinder(grid());
  const route = finder.route(10, 200, 90, 200);
  assert.ok(Math.abs(route.length - 80) < 1);
});

test('progress along a route only moves forward', () => {
  const points = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }];
  const at = locateOnPath(points, 60, 4);
  assert.equal(at.index, 0);
  assert.ok(Math.abs(at.along - 60) < 1e-9 && Math.abs(at.dist - 4) < 1e-9);
  const later = locateOnPath(points, 97, 40, 1);
  assert.equal(later.index, 1);
  assert.ok(Math.abs(later.along - 140) < 1e-9);
});
