import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  CITY_BOUNDS,
  CITY_LAND,
  BLOCKS,
  EXPRESSWAYS,
  RAILS,
  DETAIL,
  landDistance,
  waterDistance,
  blockAt
} from './city-config.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial,
  createParkPavingMaterial,
  createIronFenceMaterial,
  createParkLampGlobeMaterial,
  createParkLampPoolMaterial
} from './tsl-materials.js';

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let parkTreeSites;
let parkLampSites;
let pavedPlazaRects;
let sidewalkBlocks;
let viaduct;

// js/city-grid.js
// Builds downtown Toronto's ground: Lake Ontario & the harbour's dock walls, the street deck, every real curb island
// as a raised sidewalk with granite curbs, the parks on their blocks (lawns, walks, trees, benches & lamps), the
// Union Station Rail Corridor's ballast & tracks, the harbourfront promenade along the water's edge and the elevated
// Gardiner Expressway on its piers above Lake Shore Blvd.

function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  if (!mergeGeometries) return;
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * Helper to convert an array of world {x, z} polygon vertices into a horizontal THREE.Shape
 * in (x, -z) space so that rotating by rotateX(-Math.PI / 2) maps (x, -z, 0) -> (x, 0, z)
 * with an upward (+Y) surface normal.
 */
function createWorldXZShape(pts) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  return shape;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/**
 * Sutherland-Hodgman clip of polygon [{x, z}] to the half-plane nx * x + nz * z >= c.
 */
function clipPolygonHalfPlane(pts, nx, nz, c) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const da = nx * a.x + nz * a.z - c;
    const db = nx * b.x + nz * b.z - c;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

function rectPolygon(minX, maxX, minZ, maxZ) {
  return [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
}

/**
 * Clips polygon [{x, z}] (may be concave) to the inside of a convex polygon (either winding).
 * The part inside must be connected.
 */
function clipPolygonToConvex(pts, convex) {
  let area = 0;
  for (let i = 0; i < convex.length; i++) {
    const a = convex[i];
    const b = convex[(i + 1) % convex.length];
    area += a.x * b.z - b.x * a.z;
  }
  const s = area > 0 ? 1 : -1;
  let out = pts;
  for (let i = 0; i < convex.length && out.length; i++) {
    const a = convex[i];
    const b = convex[(i + 1) % convex.length];
    const nx = -s * (b.z - a.z);
    const nz = s * (b.x - a.x);
    out = clipPolygonHalfPlane(out, nx, nz, nx * a.x + nz * a.z);
  }
  return out;
}

/** Area centroid {x, z} of a simple polygon [{x, z}]. */
function polygonCentroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  return Math.abs(a) < 1e-9 ? { x: pts[0].x, z: pts[0].z } : { x: cx / (3 * a), z: cz / (3 * a) };
}

/**
 * Offsets a convex polygon outward (d > 0) or inward (d < 0) by moving each vertex along its corner bisector.
 */
function offsetConvexPolygon(pts, d) {
  const src = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.hypot(q.x - p.x, q.z - p.z) > 0.05;
  });
  const n = src.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = src[i];
    const b = src[(i + 1) % n];
    area += a.x * b.z - b.x * a.z;
  }
  const s = area > 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = src[(i + n - 1) % n];
    const p1 = src[i];
    const p2 = src[(i + 1) % n];
    const l1 = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const l2 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n1x = (s * (p1.z - p0.z)) / l1;
    const n1z = (-s * (p1.x - p0.x)) / l1;
    const n2x = (s * (p2.z - p1.z)) / l2;
    const n2z = (-s * (p2.x - p1.x)) / l2;
    let bx = n1x + n2x;
    let bz = n1z + n2z;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl;
    bz /= bl;
    const cosHalf = Math.max(0.3, bx * n1x + bz * n1z);
    out.push({ x: p1.x + (bx * d) / cosHalf, z: p1.z + (bz * d) / cosHalf });
  }
  return out;
}

/**
 * Tags every vertex of a mesh using the shared park paving material with its paving style (uv.x, see
 * createParkPavingMaterial: 0 hex asphalt pavers, 1 light granite plaza pavers, 2 bluestone slabs).
 */
/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d); null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? 1 : -1; // positive area: the inside lies left of each edge, i.e. along (-dz, dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += out[j].x * out[i].z - out[i].x * out[j].z;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

function polygonCentroidArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  return a * 0.5;
}
function pointInPolygonXZ(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Polygon offset by d (d > 0 inward, d < 0 outward), mitred corners clamped to 3|d|; null if it degenerates */
function offsetPolygon(pts, d) {
  if (d > 0) return offsetPolygonInward(pts, d);
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? -1 : 1; // outward normal side
  const D = -d;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], q = pts[i], r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z, bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9, lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s, n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * D, z: q.z + n1z * D }); continue; }
    mx /= ml; mz /= ml;
    const len = Math.min(3 * D, D / Math.max(1e-3, mx * n1x + mz * n1z));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  return out;
}

function setPavingStyle(geo, style) {
  const uvAttr = geo.attributes.uv;
  for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, style, 0);
  uvAttr.needsUpdate = true;
  return geo;
}

/**
 * Vertical alpha-tested iron fence strips (createIronFenceMaterial) along segments [[x1, z1, x2, z2], ...]:
 * uv.x = metres along the run, uv.y = 0 (bottom) .. 1 (top).
 */
function buildFenceStripGeometry(segments, y0, h) {
  const pos = [];
  const nor = [];
  const uvs = [];
  for (const [x1, z1, x2, z2] of segments) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.4) continue;
    const nx = -(z2 - z1) / len;
    const nz = (x2 - x1) / len;
    const corners = [[x1, z1, 0, 0], [x2, z2, len, 0], [x2, z2, len, 1], [x1, z1, 0, 0], [x2, z2, len, 1], [x1, z1, 0, 1]];
    for (const [x, z, u, v] of corners) {
      pos.push(x, y0 + v * h, z);
      nor.push(nx, 0, nz);
      uvs.push(u, v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/**
 * Closed polygon outline -> fence segments, skipping the stretches within `gapR` of any gate point {x, z}.
 */
function polygonFenceSegments(pts, gates = [], gapR = 2.0, step = 1.0) {
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / step));
    let runStart = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const open = gates.some((g) => Math.hypot(g.x - x, g.z - z) < gapR);
      if (!open && runStart === null) runStart = { x, z };
      if ((open || k === n) && runStart !== null) {
        if (Math.hypot(x - runStart.x, z - runStart.z) > 0.4) segs.push([runStart.x, runStart.z, x, z]);
        runStart = null;
      }
    }
  }
  return segs;
}

// Waterfront piers: shared TSL uber-materials. All static pier geometry is merged per material, so the look of each

const prand = (x, z, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'CityGrid';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  // Ground footprints that traffic and pedestrians must keep clear of (medians, parks, rail land)
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  // =========================================================================
  // 1. LAKE ONTARIO & TORONTO HARBOUR
  // =========================================================================
  const waterMat = createWaterMaterial();
  const lakeGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  lakeGeo.rotateX(-Math.PI / 2);
  const lakeMesh = new THREE.Mesh(lakeGeo, waterMat);
  lakeMesh.position.set(0, CITY_BOUNDS.waterLevel, 4000);
  group.add(lakeMesh);

  // =========================================================================
  // 2. THE HARBOUR'S DOCK WALLS & THE STREET DECK
  // =========================================================================
  const dockWallMat = new THREE.MeshStandardNodeMaterial({ color: 0x6a6760, roughness: 0.84, metalness: 0.06 });
  group.add(createExtrudedPolygonMesh(CITY_LAND, -2.6, 2.56, dockWallMat, true, false));
  const roadMat = createRoadSurfaceMaterial();
  group.add(createFlatPolygonMesh(CITY_LAND, 0.0, roadMat, true));

  // =========================================================================
  // 3. RAISED SIDEWALKS & GRANITE CURBS: every real curb island (city-config.js BLOCKS, from the street centrelines at
  //    their curb-to-curb widths). Rectangular islands are instanced slabs; the rest (the diagonal streets' triangles,
  //    the curving crescents, the medians of University Ave & Spadina Ave) are extruded from their outlines. Park
  //    blocks (section 4) and the rail corridor (section 5) are built on their own.
  // =========================================================================
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const medianHedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x366e3b, roughness: 0.82 });
  const blockSidewalks = []; // { cx, cz, w, d, block } axis-aligned slabs (irregular islands: their lot cover)
  const roadSidewalks = []; // the curbs road-network.js bounds the roads with (medians go in as footprints)
  const slabGeos = [];
  const curbGeos = [];
  const hedgeGeos = [];
  const SW_TOP = 0.22;
  const isPark = (b) => b.park > 0.6 && !b.median;
  const isRail = (b) => b.rail > 0.5 && !isPark(b) && !b.median;
  for (const b of BLOCKS) {
    if (isPark(b) || isRail(b)) continue;
    if (b.rect) {
      const slab = { cx: (b.minX + b.maxX) * 0.5, cz: (b.minZ + b.maxZ) * 0.5, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b };
      blockSidewalks.push(slab);
      if (b.median) addFootprint(slab.cx, slab.cz, slab.w, slab.d);
      else roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    } else {
      // curb (granite) ring under a sidewalk slab inset by 0.25 m, like the instanced pair below
      curbGeos.push(createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat).geometry);
      const inner = offsetPolygonInward(b.poly, 0.25);
      if (inner) slabGeos.push(createExtrudedPolygonMesh(inner, 0.03, SW_TOP - 0.03, sidewalkMat).geometry);
      // rect cover for the consumers that work on rectangles: the lot rects grown back out to the curb
      for (const [x0, x1, z0, z1] of b.rects) {
        const r = { minX: x0 - 4.0, maxX: x1 + 4.0, minZ: z0 - 4.0, maxZ: z1 + 4.0 };
        blockSidewalks.push({ cx: (r.minX + r.maxX) * 0.5, cz: (r.minZ + r.maxZ) * 0.5, w: r.maxX - r.minX, d: r.maxZ - r.minZ, block: b, cover: true });
        if (!b.median) roadSidewalks.push(r);
      }
      if (b.median) addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    // Planted medians (University Ave's, Spadina Ave's...): a clipped hedge on the slab
    if (b.median && Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 2.2) {
      const hedge = offsetPolygonInward(b.poly, 1.0);
      if (hedge) hedgeGeos.push(createExtrudedPolygonMesh(hedge, SW_TOP, 0.55, medianHedgeMat).geometry);
    }
  }
  const mergeInto = (geos, mat, cast = false) => {
    for (let i = 0; i < geos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 400), false), mat);
      m.receiveShadow = true;
      m.castShadow = cast;
      group.add(m);
    }
  };
  mergeInto(curbGeos, curbMat, true);
  mergeInto(slabGeos, sidewalkMat);
  mergeInto(hedgeGeos, medianHedgeMat, true);

  const rectSlabs = blockSidewalks.filter((s) => !s.cover);
  const swInstanced = new THREE.InstancedMesh(unitBox, sidewalkMat, Math.max(1, rectSlabs.length));
  const curbInstanced = new THREE.InstancedMesh(unitBox, curbMat, Math.max(1, rectSlabs.length));
  swInstanced.count = curbInstanced.count = rectSlabs.length;
  swInstanced.receiveShadow = true;
  curbInstanced.receiveShadow = true;
  curbInstanced.castShadow = true;
  rectSlabs.forEach((blk, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(blk.cx, 0.125, blk.cz);
    dummy.scale.set(blk.w - 0.5, 0.19, blk.d - 0.5);
    dummy.updateMatrix();
    swInstanced.setMatrixAt(i, dummy.matrix);
    dummy.position.set(blk.cx, 0.095, blk.cz);
    dummy.scale.set(blk.w, 0.17, blk.d);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(i, dummy.matrix);
  });
  swInstanced.instanceMatrix.needsUpdate = true;
  curbInstanced.instanceMatrix.needsUpdate = true;
  group.add(swInstanced, curbInstanced);

  // =========================================================================
  // 4. PARKS ON THEIR BLOCKS: Queen's Park, Grange Park, Allan Gardens, Moss Park, Berczy Park, Clarence Square...
  //    A sidewalk ring around a granite-coped lawn; on the larger, squarish ones paved walks radiate from a central
  //    plaza between the lawn beds; trees, benches and park lamps throughout
  // =========================================================================
  const lawnMat = createParkLawnMaterial(false);
  const pavingMat = createParkPavingMaterial();
  const graniteMat = new THREE.MeshStandardNodeMaterial({ color: 0x86837c, roughness: 0.8 }); // copings, planters
  const benchMatrices = [];
  const lampMatrices = [];
  const treeSites = []; // { x, y, z, scale, species } park trees planted by street-details.js
  const pavedRects = []; // park slab bounds, exported so street trees (street-details.js) stay off them
  const lawnGeos = [];
  const copingGeos = [];
  const walkGeos = [];
  const PARK_Y = 0.24;
  const LAWN_Y = 0.36;
  const addBench = (x, y, z, rotY) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    benchMatrices.push(dummy.matrix.clone());
  };
  const addLamp = (x, y, z) => lampMatrices.push(new THREE.Matrix4().makeTranslation(x, y, z));
  const area = (pts) => Math.abs(polygonCentroidArea(pts));

  // Trees on a jittered grid inside a polygon (kept `margin` m in from its edges), plane trees, honey locusts & elms
  function scatterTrees(pts, spacing, y, margin) {
    const inner = offsetPolygonInward(pts, margin);
    if (!inner) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of inner) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    for (let gx = x0; gx <= x1; gx += spacing) {
      for (let gz = z0; gz <= z1; gz += spacing) {
        const tx = gx + (prand(gx, gz) - 0.5) * spacing * 0.75;
        const tz = gz + (prand(gz, gx, 1) - 0.5) * spacing * 0.75;
        if (!pointInPolygonXZ(inner, tx, tz) || prand(tx, tz, 5) < 0.18) continue;
        const r = prand(tx, tz, 2);
        treeSites.push({ x: tx, y, z: tz, scale: 0.95 + prand(tx, tz, 3) * 0.4, species: r < 0.45 ? 2 : r < 0.75 ? 0 : 1 });
      }
    }
  }
  // Benches facing the walk & lamps along the edges of a lawn
  function lineEdges(bed, y, step = 9) {
    const s = polygonCentroidArea(bed) > 0 ? 1 : -1;
    for (let i = 0; i < bed.length; i++) {
      const a = bed[i];
      const b = bed[(i + 1) % bed.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 8) continue;
      const nx = (s * (b.z - a.z)) / len;
      const nz = (-s * (b.x - a.x)) / len;
      const count = Math.floor((len - 4) / step);
      for (let k = 0; k < count; k++) {
        const t = (2 + step * (k + 0.5) + (len - 4 - count * step) * 0.5) / len;
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        if (k % 3 === 1) addLamp(px - nx * 0.7, y, pz - nz * 0.7);
        else if (k % 3 === 0) addBench(px - nx * 0.75, y, pz - nz * 0.75, Math.atan2(-nx, -nz));
      }
    }
  }
  // A lawn bed: granite coping, the lawn a little inside it
  function addBed(bed) {
    copingGeos.push(createExtrudedPolygonMesh(bed, 0.1, LAWN_Y - 0.06, graniteMat).geometry);
    const lawn = offsetPolygonInward(bed, 0.3);
    if (lawn) lawnGeos.push(createExtrudedPolygonMesh(lawn, 0.2, LAWN_Y - 0.2 + 0.02, lawnMat).geometry);
  }
  const parkBlocks = BLOCKS.filter(isPark);
  for (const b of parkBlocks) {
    // perimeter: curb, sidewalk ring and the paved floor of the park
    group.add(createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat, true, true));
    const floor = offsetPolygonInward(b.poly, 0.25);
    if (!floor) continue;
    const floorMesh = createExtrudedPolygonMesh(floor, 0.03, PARK_Y - 0.03, pavingMat);
    setPavingStyle(floorMesh.geometry, area(b.poly) > 6000 ? 0 : 2);
    walkGeos.push(floorMesh.geometry);
    addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    pavedRects.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    const inner = offsetPolygonInward(b.poly, 3.6);
    if (!inner || area(inner) < 60) continue;
    const bw = b.maxX - b.minX;
    const bd = b.maxZ - b.minZ;
    const squarish = area(b.poly) / (bw * bd) > 0.9 && Math.min(bw, bd) > 34;
    if (squarish) {
      // walks radiating from a central plaza to the corners and the middle of each side, lawn beds between them
      const hx = (b.minX + b.maxX) * 0.5;
      const hz = (b.minZ + b.maxZ) * 0.5;
      const hubR = Math.min(9, Math.min(bw, bd) * 0.12);
      const halfPath = 1.6;
      const rays = inner.map((p) => Math.atan2(p.z - hz, p.x - hx));
      for (const a of [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5]) if (Math.min(bw, bd) > 70) rays.push(a);
      rays.sort((a, c) => a - c);
      for (let i = 0; i < rays.length; i++) {
        const a1 = rays[i];
        const a2 = i + 1 < rays.length ? rays[i + 1] : rays[0] + Math.PI * 2;
        let poly = inner.map((p) => ({ x: p.x - hx, z: p.z - hz }));
        poly = clipPolygonHalfPlane(poly, -Math.sin(a1), Math.cos(a1), halfPath);
        poly = clipPolygonHalfPlane(poly, Math.sin(a2), -Math.cos(a2), halfPath);
        for (const f of [0.25, 0.5, 0.75]) {
          const am = a1 + (a2 - a1) * f;
          poly = clipPolygonHalfPlane(poly, Math.cos(am), Math.sin(am), hubR + halfPath + 0.6);
        }
        if (poly.length < 3 || area(poly) < 40) continue;
        const bed = poly.map((p) => ({ x: p.x + hx, z: p.z + hz }));
        addBed(bed);
        lineEdges(bed, PARK_Y);
        scatterTrees(bed, 11, LAWN_Y, 2.2);
      }
      // the central plaza: a granite-rimmed fountain basin on the larger squares
      if (hubR > 5) {
        const basin = [[hubR * 0.55 + 0.18, 0], [hubR * 0.55, 0.5], [hubR * 0.55 - 0.4, 0.5], [hubR * 0.55 - 0.4, 0.26]].map(([r, y]) => new THREE.Vector2(r, y));
        const rim = new THREE.Mesh(new THREE.LatheGeometry(basin, 40), graniteMat);
        rim.position.set(hx, PARK_Y, hz);
        rim.receiveShadow = true;
        group.add(rim);
        const pool = new THREE.Mesh(new THREE.CircleGeometry(hubR * 0.55 - 0.39, 40).rotateX(-Math.PI / 2), waterMat);
        pool.position.set(hx, PARK_Y + 0.3, hz);
        group.add(pool);
      }
    } else {
      addBed(inner);
      lineEdges(inner, PARK_Y, 11);
      scatterTrees(inner, 12, LAWN_Y, 2.5);
    }
    // a row of trees along the perimeter sidewalk
    const row = offsetPolygonInward(b.poly, 1.6);
    if (row) {
      for (let i = 0; i < row.length; i++) {
        const a = row[i];
        const c = row[(i + 1) % row.length];
        const len = Math.hypot(c.x - a.x, c.z - a.z);
        for (let s = 5; s < len - 4; s += 9) {
          const px = a.x + ((c.x - a.x) * s) / len;
          const pz = a.z + ((c.z - a.z) * s) / len;
          treeSites.push({ x: px, y: PARK_Y, z: pz, scale: 1.0 + prand(px, pz, 4) * 0.3, species: 0 });
        }
      }
    }
  }
  mergeInto(walkGeos, pavingMat);
  mergeInto(copingGeos, graniteMat);
  mergeInto(lawnGeos, lawnMat);

  // =========================================================================
  // 5. THE UNION STATION RAIL CORRIDOR: ballast beds on the rail land between the streets crossing it, and the tracks
  //    (every heavy-rail line of OpenStreetMap: GO Transit, VIA & UP Express) as steel rails on timber ties
  // =========================================================================
  const ballastMat = new THREE.MeshStandardNodeMaterial({ color: 0x5f5850, roughness: 0.95 });
  const railBlocks = BLOCKS.filter(isRail);
  const ballastGeos = [];
  for (const b of railBlocks) {
    group.add(createExtrudedPolygonMesh(b.poly, 0.0, 0.16, curbMat, true, false));
    const inner = offsetPolygonInward(b.poly, 0.3);
    if (inner) ballastGeos.push(createExtrudedPolygonMesh(inner, 0.02, 0.12, ballastMat).geometry);
    addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
  }
  mergeInto(ballastGeos, ballastMat);
  {
    // Ties as a dark strip under each track, the two rails on top (quads with sides), where the track runs on rail land
    const tiePos = [];
    const railPos = [];
    const quad = (out, ax, az, bx, bz, half, y, h = 0) => {
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / L) * half;
      const nz = ((bx - ax) / L) * half;
      out.push(ax - nx, y, az - nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz, ax - nx, y, az - nz, bx + nx, y, bz + nz, ax + nx, y, az + nz);
      if (h > 0) {
        for (const sgn of [-1, 1]) {
          const ex = ax + sgn * nx, ez = az + sgn * nz, fx = bx + sgn * nx, fz = bz + sgn * nz;
          out.push(ex, y - h, ez, fx, y - h, fz, fx, y, fz, ex, y - h, ez, fx, y, fz, ex, y, ez);
        }
      }
    };
    const onRailLand = (x, z) => {
      const b = blockAt(x, z);
      return !!b && isRail(b);
    };
    for (const r of RAILS) {
      if (r.kind !== 'rail') continue;
      const P = r.pts;
      for (let i = 0; i + 1 < P.length; i++) {
        const a = P[i], c = P[i + 1];
        const L = Math.hypot(c.x - a.x, c.z - a.z);
        const n = Math.max(1, Math.ceil(L / 6));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const ax = a.x + (c.x - a.x) * t0, az = a.z + (c.z - a.z) * t0;
          const bx = a.x + (c.x - a.x) * t1, bz = a.z + (c.z - a.z) * t1;
          if (!onRailLand((ax + bx) / 2, (az + bz) / 2)) continue;
          quad(tiePos, ax, az, bx, bz, 1.3, 0.16);
          const ux = (bx - ax) / (L / n), uz = (bz - az) / (L / n);
          for (const off of [-0.72, 0.72]) quad(railPos, ax - uz * off, az + ux * off, bx - uz * off, bz + ux * off, 0.04, 0.32, 0.16);
        }
      }
    }
    const strip = (pos, mat) => {
      if (!pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const uvs = new Float32Array((pos.length / 3) * 2);
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      group.add(m);
    };
    strip(tiePos, new THREE.MeshStandardNodeMaterial({ color: 0x3a3029, roughness: 0.9 }));
    strip(railPos, new THREE.MeshStandardNodeMaterial({ color: 0x8c8780, roughness: 0.35, metalness: 0.85 }));
  }

  // =========================================================================
  // 6. THE HARBOURFRONT: a granite promenade along every dock wall (the strip between the water and the first blocks),
  //    a steel railing at the edge, lamps & a row of trees
  // =========================================================================
  const highwayLanes = [];
  {
    const promenadeGeos = [];
    const railSegs = [];
    const P = CITY_LAND;
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i];
      const b = P[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1) continue;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      if (waterDistance(mx, mz) > 10) continue; // an inland edge of the detailed city
      // inward normal: towards the land
      let nx = -(b.z - a.z) / len;
      let nz = (b.x - a.x) / len;
      if (landDistance(mx + nx * 4, mz + nz * 4) < landDistance(mx - nx * 4, mz - nz * 4)) { nx = -nx; nz = -nz; }
      const W = 9;
      const pts = [{ x: a.x, z: a.z }, { x: b.x, z: b.z }, { x: b.x + nx * W, z: b.z + nz * W }, { x: a.x + nx * W, z: a.z + nz * W }];
      const m = createExtrudedPolygonMesh(pts, 0.0, 0.2, pavingMat);
      setPavingStyle(m.geometry, 1);
      promenadeGeos.push(m.geometry);
      railSegs.push([a.x + nx * 0.25, a.z + nz * 0.25, b.x + nx * 0.25, b.z + nz * 0.25]);
      for (let s = 6; s < len - 3; s += 24) {
        const px = a.x + ((b.x - a.x) * s) / len;
        const pz = a.z + ((b.z - a.z) * s) / len;
        addLamp(px + nx * 1.4, 0.2, pz + nz * 1.4);
        if (len > 20) treeSites.push({ x: px + nx * 6.5 + (b.x - a.x) / len * 9, y: 0.2, z: pz + nz * 6.5 + (b.z - a.z) / len * 9, scale: 0.95 + prand(px, pz, 6) * 0.3, species: 1 });
      }
    }
    mergeInto(promenadeGeos, pavingMat);
    if (railSegs.length) group.add(new THREE.Mesh(buildFenceStripGeometry(railSegs, 0.2, 1.05), createIronFenceMaterial()));
  }

  // =========================================================================
  // 7. THE GARDINER EXPRESSWAY: each carriageway's deck on single-column bents ~14 m over Lake Shore Blvd, with Jersey
  //    barriers, from the Exhibition grounds past the Don; its lanes carry the ambient highway traffic (traffic.js)
  // =========================================================================
  viaduct = buildGardiner(group, highwayLanes);

  // Instanced park & promenade furniture: slatted benches (seat facing +z) & park lamps with globes
  if (benchMatrices.length) {
    const benchGeo = mergeGeometries([
      new THREE.BoxGeometry(1.9, 0.06, 0.46).translate(0, 0.45, 0.02),
      new THREE.BoxGeometry(1.9, 0.34, 0.05).rotateX(-0.22).translate(0, 0.74, -0.22),
      new THREE.BoxGeometry(0.07, 0.45, 0.52).translate(-0.86, 0.225, 0),
      new THREE.BoxGeometry(0.07, 0.45, 0.52).translate(0.86, 0.225, 0),
      new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(-0.9, 0.62, 0.02),
      new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(0.9, 0.62, 0.02)
    ]);
    const benchMat = new THREE.MeshStandardNodeMaterial({ color: 0x6b4a32, roughness: 0.7, metalness: 0.1 });
    const benchInst = new THREE.InstancedMesh(benchGeo, benchMat, benchMatrices.length);
    benchMatrices.forEach((m, i) => benchInst.setMatrixAt(i, m));
    benchInst.instanceMatrix.needsUpdate = true;
    benchInst.castShadow = true;
    benchInst.receiveShadow = true;
    benchInst.computeBoundingSphere();
    group.add(benchInst);
  }
  if (lampMatrices.length) {
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.15, 0.2, 0.7, 8).translate(0, 0.35, 0),
      new THREE.CylinderGeometry(0.055, 0.085, 3.1, 8).translate(0, 2.25, 0),
      new THREE.CylinderGeometry(0.13, 0.07, 0.2, 8).translate(0, 3.85, 0)
    ]);
    const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c201d, roughness: 0.45, metalness: 0.6 });
    const globeGeo = new THREE.SphereGeometry(0.27, 12, 8).translate(0, 4.17, 0);
    const poleInst = new THREE.InstancedMesh(poleGeo, poleMat, lampMatrices.length);
    const globeInst = new THREE.InstancedMesh(globeGeo, createParkLampGlobeMaterial(), lampMatrices.length);
    lampMatrices.forEach((m, i) => {
      poleInst.setMatrixAt(i, m);
      globeInst.setMatrixAt(i, m);
    });
    poleInst.instanceMatrix.needsUpdate = true;
    globeInst.instanceMatrix.needsUpdate = true;
    poleInst.castShadow = true;
    poleInst.computeBoundingSphere();
    globeInst.computeBoundingSphere();
    group.add(poleInst, globeInst);

    // Warm pools of lamplight on the walks after dusk (additive decal, black by day)
    const poolInst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createParkLampPoolMaterial(), lampMatrices.length);
    const poolM = new THREE.Matrix4();
    lampMatrices.forEach((m, i) => {
      poolInst.setMatrixAt(i, poolM.makeScale(14, 1, 14).setPosition(m.elements[12], m.elements[13] + 0.17, m.elements[14]));
    });
    poolInst.instanceMatrix.needsUpdate = true;
    poolInst.computeBoundingSphere();
    group.add(poolInst);
  }

  // Park & promenade tree and lamp sites, read by street-details.js after the city grid is built
  parkTreeSites = treeSites;
  parkLampSites = lampMatrices.map((m) => ({ x: m.elements[12], y: m.elements[13] + 4.17, z: m.elements[14] }));
  pavedPlazaRects = pavedRects;
  sidewalkBlocks = blockSidewalks; // { cx, cz, w, d } raised sidewalk slabs (street tree rows)

  // Batch static sub-meshes by material to reduce per-frame WebGPU draw calls
  batchStaticGroupMeshes(group, new Set([waterMat, roadMat, lawnMat]));

  scene.add(group);

  // Raised sidewalk blocks bound the roads (medians, parks and rail land are obstacles, handed over with the footprints)
  const sidewalks = roadSidewalks;
  const colliders = viaduct.colliders;
  return { group, sidewalks, footprints, highwayLanes, colliders };
}

// =====================================================================================================================
// THE GARDINER EXPRESSWAY
// =====================================================================================================================
// Each carriageway (OpenStreetMap: one one-way line per direction) within reach of downtown: a concrete box deck at
// DECK_Y with barrier walls, carried every ~32 m by a column & cap beam. Returns { boxes } (oriented boxes buildings keep
// clear of) and { colliders } (the columns, for the player), and pushes the lanes for the ambient traffic.
function buildGardiner(group, highwayLanes) {
  const DECK_Y = 14.0;
  const DECK_T = 1.5;
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x9a968d, roughness: 0.86 });
  const asphalt = new THREE.MeshStandardNodeMaterial({ color: 0x2c2d30, roughness: 0.82 });
  const boxes = [];
  const colliders = [];
  const deckGeos = [];
  const topGeos = [];
  const pad = 900;
  const nearDowntown = (p) => p.x > DETAIL.x0 - pad && p.x < DETAIL.x1 + pad && p.z > DETAIL.z0 && p.z < DETAIL.z1 + pad;
  const boxGeo = (cx, cy, cz, w, h, L, yaw) => new THREE.BoxGeometry(w, h, L).rotateY(yaw).translate(cx, cy, cz);
  for (const e of EXPRESSWAYS) {
    if (e.name !== 'Gardiner Expressway') continue;
    // the run of the carriageway near downtown, resampled every ~8 m
    const src = e.pts.filter(nearDowntown);
    if (src.length < 2) continue;
    const pts = [src[0]];
    for (let i = 1; i < src.length; i++) {
      const a = pts[pts.length - 1], b = src[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L > 400) break; // the polyline left the window and came back: keep the first run
      const n = Math.max(1, Math.ceil(L / 8));
      for (let k = 1; k <= n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    const W = e.w;
    let run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.2) continue;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
      deckGeos.push(boxGeo(cx, DECK_Y - DECK_T / 2, cz, W, DECK_T, L + 0.6, yaw));
      topGeos.push(boxGeo(cx, DECK_Y + 0.02, cz, W - 1.0, 0.04, L + 0.6, yaw));
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      for (const s of [-1, 1]) {
        const ox = uz * s * (W / 2 - 0.25), oz = -ux * s * (W / 2 - 0.25);
        deckGeos.push(boxGeo(cx + ox, DECK_Y + 0.45, cz + oz, 0.45, 0.9, L + 0.6, yaw));
      }
      boxes.push({ cx, cz, ux, uz, hl: L / 2 + 1, hw: W / 2 + 2 });
      run += L;
      if (run >= 32) {
        run = 0;
        const h = DECK_Y - DECK_T;
        deckGeos.push(boxGeo(b.x, h / 2, b.z, 1.8, h, 1.6, yaw));
        deckGeos.push(boxGeo(b.x, h - 0.6, b.z, W - 2, 1.2, 2.0, yaw));
        colliders.push({ minX: b.x - 1.4, maxX: b.x + 1.4, minZ: b.z - 1.4, maxZ: b.z + 1.4, maxY: h });
      }
    }
    // lanes, right of the centreline in the direction of travel (the way's direction)
    for (let k = 0; k < e.lanes; k++) {
      const off = (k - (e.lanes - 1) / 2) * 3.6;
      const lane = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const rx = -(b.z - a.z) / L, rz = (b.x - a.x) / L; // right of travel (x east, z south: right = (-dz, dx))
        lane.push(new THREE.Vector3(pts[i].x + rx * off, DECK_Y + 0.05, pts[i].z + rz * off));
      }
      highwayLanes.push({ pts: lane, speed: 22 + k * 1.5 });
    }
  }
  const add = (geos, mat, cast) => {
    for (let i = 0; i < geos.length; i += 500) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 500), false), mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      group.add(m);
    }
  };
  add(deckGeos, concrete, true);
  add(topGeos, asphalt, false);
  return { boxes, colliders };
}

export {
  buildCityGrid,
  batchStaticGroupMeshes,
  parkTreeSites,
  parkLampSites,
  pavedPlazaRects,
  sidewalkBlocks,
  viaduct
};
