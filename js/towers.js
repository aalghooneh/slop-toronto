import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TOWERS, LANDMARK_SITES } from './city-config.js';
import { createPreWarBuildingMaterial, createCurtainWallMaterial } from './tsl-materials.js';

// js/towers.js
// Toronto's real skyline: every building (or building part) of 40 m and up in OpenStreetMap, extruded from its true
// outline to its true height: the bank towers of the Financial District, the condo forests of CityPlace, the South Core
// and the Yonge St corridor, St. James Town's slabs. Facades come from the shared window shaders (world-space mode),
// picked from the building's tagged material & colour, else by height; flat roofs carry a mechanical penthouse.
// The landmarks landmarks.js models in detail are left to it. The generic generator (buildings.js) keeps its lots
// clear of these footprints.

// Facade styles: [factory, options]
const STYLES = {
  glassBlue: [createCurtainWallMaterial, { glassTint: 0x1d3c55, frameTint: 0x3c4c5a, windowWidth: 2.8, floorHeight: 3.3, litProbability: 0.55, warmth: 0.6, reflectivity: 0.93, seed: 11.2 }],
  glassSilver: [createCurtainWallMaterial, { glassTint: 0x34506a, frameTint: 0xaeb8c2, windowWidth: 3.0, floorHeight: 3.4, litProbability: 0.52, warmth: 0.5, reflectivity: 0.95, seed: 23.7 }],
  glassDark: [createCurtainWallMaterial, { glassTint: 0x1b1d20, frameTint: 0x2a2b2e, windowWidth: 2.6, floorHeight: 3.9, litProbability: 0.6, warmth: 0.7, reflectivity: 0.9, seed: 37.1 }],
  glassGreen: [createCurtainWallMaterial, { glassTint: 0x2b4a48, frameTint: 0x8f9a98, windowWidth: 2.8, floorHeight: 3.2, litProbability: 0.58, warmth: 0.62, reflectivity: 0.92, seed: 48.9 }],
  glassGold: [createCurtainWallMaterial, { glassTint: 0x7a5a24, frameTint: 0xb08a3c, windowWidth: 2.6, floorHeight: 3.9, litProbability: 0.5, warmth: 0.75, reflectivity: 0.95, seed: 55.3 }],
  concreteLight: [createPreWarBuildingMaterial, { stoneColor: 0xc9c3b6, trimColor: 0x9b958a, windowGlassColor: 0x1a2632, windowWidth: 2.4, floorHeight: 2.9, litProbability: 0.6, warmth: 0.85, seed: 61.4 }],
  brick: [createPreWarBuildingMaterial, { stoneColor: 0x9a5a44, trimColor: 0xc8b8a0, windowGlassColor: 0x16222e, windowWidth: 2.3, floorHeight: 2.9, litProbability: 0.62, warmth: 0.88, seed: 72.6 }],
  stone: [createPreWarBuildingMaterial, { stoneColor: 0xd6ccb8, trimColor: 0xa29682, windowGlassColor: 0x1a2836, windowWidth: 2.5, floorHeight: 3.7, litProbability: 0.54, warmth: 0.8, seed: 84.0 }],
  graniteRed: [createPreWarBuildingMaterial, { stoneColor: 0x7d4038, trimColor: 0x5a2c27, windowGlassColor: 0x1c242c, windowWidth: 1.9, floorHeight: 3.8, litProbability: 0.55, warmth: 0.7, seed: 91.8 }],
  marbleWhite: [createPreWarBuildingMaterial, { stoneColor: 0xe6e3dc, trimColor: 0xc4c0b8, windowGlassColor: 0x1d262e, windowWidth: 1.6, floorHeight: 3.8, litProbability: 0.55, warmth: 0.65, seed: 97.5 }]
};
// Towers whose look is known by name
const NAMED = {
  'Royal Bank Plaza North Tower': 'glassGold', 'Royal Bank Plaza South Tower': 'glassGold', 'First Canadian Place': 'marbleWhite',
  'Scotia Plaza': 'graniteRed', 'Commerce Court West': 'glassSilver', 'TD Bank Tower': 'glassDark', 'Toronto-Dominion Bank Tower': 'glassDark',
  'Royal Trust Tower': 'glassDark', 'Ernst & Young Tower': 'glassDark', 'TD North Tower': 'glassDark', 'TD South Tower': 'glassDark',
  'TD West Tower': 'glassDark', 'TD Canada Trust Tower': 'glassSilver', 'Bay Wellington Tower': 'glassSilver', 'Aura': 'glassSilver',
  'Bay Adelaide Centre West Tower': 'glassSilver', 'Bay Adelaide Centre East Tower': 'glassSilver', 'Shangri-La': 'glassBlue',
  'The Ritz-Carlton Hotel': 'glassGreen', 'Massey Tower': 'glassDark', 'Commerce Court North': 'stone', 'Canada Life': 'stone'
};
const hash = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
function styleOf(t) {
  if (NAMED[t.name]) return NAMED[t.name];
  const m = (t.material || '').toLowerCase();
  const c = (t.colour || '').toLowerCase();
  const r = hash(t.cx, t.cz);
  if (/brick/.test(m)) return 'brick';
  if (/stone|limestone|sandstone|granite|marble/.test(m)) return /red|brown|#[89a][0-9a-f]4/.test(c) ? 'graniteRed' : 'stone';
  if (/concrete|plaster|stucco/.test(m)) return r < 0.5 ? 'concreteLight' : 'brick';
  if (/glass|metal|steel/.test(m)) return r < 0.4 ? 'glassBlue' : r < 0.7 ? 'glassSilver' : r < 0.85 ? 'glassGreen' : 'glassDark';
  // untagged: the older, lower slabs are masonry & precast, the newer, taller towers glass
  if (t.h < 75) return r < 0.35 ? 'concreteLight' : r < 0.55 ? 'brick' : r < 0.8 ? 'glassBlue' : 'glassSilver';
  return r < 0.38 ? 'glassBlue' : r < 0.66 ? 'glassSilver' : r < 0.82 ? 'glassGreen' : r < 0.92 ? 'glassDark' : 'concreteLight';
}

// The landmarks modelled in detail by landmarks.js (their outlines stay clear of this generator)
const MODELLED = ['CN Tower', 'Rogers Centre', 'Union Station', 'Toronto City Hall', 'Old City Hall', 'Gooderham Building',
  'Ontario Legislative Building', 'Royal Ontario Museum', 'St. Lawrence Market South', 'Scotiabank Arena', 'Fairmont Royal York Hotel'];

function buildTowers(scene) {
  const group = new THREE.Group();
  group.name = 'Towers';
  const colliders = [];
  const footprints = []; // { pts, h } for the maps
  const skip = MODELLED.map((n) => LANDMARK_SITES[n]).filter(Boolean)
    .map((l) => ({ x0: l.x - l.w / 2 - 2, x1: l.x + l.w / 2 + 2, z0: l.z - l.d / 2 - 2, z1: l.z + l.d / 2 + 2 }));
  const geosByStyle = new Map();
  const penthouseGeos = [];
  for (const t of TOWERS) {
    if (skip.some((r) => t.cx > r.x0 && t.cx < r.x1 && t.cz > r.z0 && t.cz < r.z1)) continue;
    const ring = t.ring;
    if (ring.length < 3) continue;
    const shape = new THREE.Shape();
    ring.forEach((p, i) => (i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z)));
    shape.closePath();
    // (towers on podia start at the ground: the podium beneath isn't always mapped as its own part)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t.h, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    const style = styleOf(t);
    if (!geosByStyle.has(style)) geosByStyle.set(style, []);
    geosByStyle.get(style).push(geo.index ? geo.toNonIndexed() : geo);
    // a mechanical penthouse on the roof, a fifth of the footprint, ~2.5 storeys
    const w = (t.maxX - t.minX) * 0.42;
    const d = (t.maxZ - t.minZ) * 0.42;
    if (w > 4 && d > 4 && t.roof !== 'pyramidal' && t.roof !== 'dome') {
      penthouseGeos.push(new THREE.BoxGeometry(w, 6.5, d).translate(t.cx, t.h + 3.25, t.cz).toNonIndexed());
    }
    colliders.push({ minX: t.minX + 0.3, maxX: t.maxX - 0.3, minZ: t.minZ + 0.3, maxZ: t.maxZ - 0.3, maxY: t.h });
    footprints.push({ pts: ring, h: t.h });
  }
  for (const [style, geos] of geosByStyle) {
    const [create, opts] = STYLES[style];
    const mat = create(opts);
    for (let i = 0; i < geos.length; i += 300) {
      const mesh = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 300), false), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  if (penthouseGeos.length) {
    const mech = new THREE.Mesh(mergeGeometries(penthouseGeos, false), new THREE.MeshStandardNodeMaterial({ color: 0x8d8a84, roughness: 0.8 }));
    mech.castShadow = true;
    mech.receiveShadow = true;
    group.add(mech);
  }
  scene.add(group);
  console.info(`[towers] ${colliders.length} real towers in ${geosByStyle.size} facade styles`);
  return { group, colliders, footprints };
}

export { buildTowers };
