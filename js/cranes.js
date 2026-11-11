import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TOWERS } from './city-config.js';
import { cityUniforms } from './tsl-materials.js';
import { float, smoothstep, sin, time, uniform } from 'three/tsl';

// js/cranes.js
// Tower cranes on the skyline. Toronto has had more of them at work than any other city in North America for years:
// a downtown skyline without cranes isn't Toronto's. A handful of the real towers (spread out, picked the same way
// every time) carry one on the roof: a lattice mast, the long jib with its trolley & hook, the counter-jib with its
// concrete weights, the cab, and a red aviation light at the tip that comes on at dusk. All of them are one mesh.

const CRANES = 18;
const SPACING = 230; // metres between two cranes at least
const BAY = 1.7; // the lattice's bay: the mast & jib are this square in section

// Steel lattice as a texture: chords along the edges, diagonals across, the rest cut away (alpha test)
function latticeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'square';
  ctx.lineWidth = 15;
  ctx.strokeRect(0, 0, 128, 128);
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(128, 128);
  ctx.moveTo(128, 0);
  ctx.lineTo(0, 128);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A box of lattice `length` long (along x for a jib, along y for a mast), one texture repeat per bay
function latticeBox(length, vertical) {
  const g = vertical ? new THREE.BoxGeometry(BAY, length, BAY) : new THREE.BoxGeometry(length, BAY, BAY);
  const uv = g.attributes.uv;
  const n = g.attributes.normal;
  const bays = Math.max(1, Math.round(length / BAY));
  for (let i = 0; i < uv.count; i++) {
    if (vertical) {
      if (Math.abs(n.getY(i)) < 0.5) uv.setY(i, uv.getY(i) * bays);
    } else if (Math.abs(n.getX(i)) < 0.5) {
      uv.setX(i, uv.getX(i) * bays);
    }
  }
  return g;
}

function hashOf(i) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function buildCranes(scene) {
  // Which towers: tall but not the tallest, well apart, in an order that doesn't change
  const picks = [];
  const candidates = TOWERS.map((t, i) => ({ t, k: hashOf(i) })).filter(({ t }) => t.h >= 55 && t.h <= 210)
    .sort((a, b) => a.k - b.k);
  for (const { t, k } of candidates) {
    if (picks.length >= CRANES) break;
    if (picks.some((p) => Math.hypot(p.t.cx - t.cx, p.t.cz - t.cz) < SPACING)) continue;
    picks.push({ t, k });
  }

  const lattice = [];
  const solid = [];
  const lights = [];
  const m = new THREE.Matrix4();
  for (const { t, k } of picks) {
    const mast = 16 + k * 14; // above the roof
    const jib = 42 + hashOf(k * 91) * 22;
    const counter = jib * 0.3;
    const yaw = hashOf(k * 53) * Math.PI * 2;
    const top = t.h + mast;
    const place = new THREE.Matrix4().makeRotationY(yaw).setPosition(t.cx, 0, t.cz);
    const add = (list, g, x, y, z) => {
      g.applyMatrix4(m.makeTranslation(x, y, z)).applyMatrix4(place);
      list.push(g);
    };
    add(lattice, latticeBox(mast, true), 0, t.h + mast / 2, 0);
    add(lattice, latticeBox(jib, false), jib / 2 + BAY / 2, top + BAY / 2, 0);
    add(lattice, latticeBox(counter, false), -counter / 2 - BAY / 2, top + BAY / 2, 0);
    add(lattice, latticeBox(7.5, true), 0, top + BAY + 3.75, 0); // the cat-head the tie bars hang from
    // tie bars from the cat-head out along both jibs
    for (const [reach, sign] of [[jib * 0.62, 1], [counter * 0.9, -1]]) {
      const rise = 7.2;
      const len = Math.hypot(reach, rise);
      const bar = new THREE.BoxGeometry(len, 0.14, 0.14).applyMatrix4(m.makeRotationZ(-sign * Math.atan2(rise, reach)));
      add(solid, bar, (sign * reach) / 2, top + BAY + rise / 2, 0);
    }
    add(solid, new THREE.BoxGeometry(2.3, 2.3, 2.5), 0.6, top - 1.4, 1.9); // the operator's cab
    add(solid, new THREE.BoxGeometry(3.4, 2.6, 2.3), -counter + 1.2, top - 0.6, 0); // counterweights
    add(solid, new THREE.BoxGeometry(2.6, 1.0, 2.2), 0, top - 0.3, 0); // slewing ring
    const trolley = jib * (0.35 + hashOf(k * 17) * 0.5);
    const drop = 6 + hashOf(k * 29) * 16;
    add(solid, new THREE.BoxGeometry(1.8, 0.5, 1.5), trolley, top - 0.35, 0);
    add(solid, new THREE.BoxGeometry(0.07, drop, 0.07), trolley, top - 0.6 - drop / 2, 0); // the hoist rope
    add(solid, new THREE.BoxGeometry(0.7, 0.9, 0.5), trolley, top - 0.6 - drop - 0.45, 0); // the hook block
    for (const x of [jib + BAY / 2, -counter - BAY / 2, 0]) {
      add(lights, new THREE.SphereGeometry(0.42, 8, 6), x, top + BAY + (x === 0 ? 7.9 : 0.5), 0);
    }
  }
  if (!picks.length) return { group: null, count: 0 };

  const group = new THREE.Group();
  group.name = 'Cranes';
  const yellow = 0xf0b414;
  const latticeMat = new THREE.MeshStandardNodeMaterial({
    color: yellow, map: latticeTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.25
  });
  const latticeMesh = new THREE.Mesh(mergeGeometries(lattice), latticeMat);
  const solidMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9a312, roughness: 0.6, metalness: 0.2 });
  const solidMesh = new THREE.Mesh(mergeGeometries(solid), solidMat);
  for (const mesh of [latticeMesh, solidMesh]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  // Aviation lights: off by day, a slow red pulse from dusk
  const lightMat = new THREE.MeshBasicNodeMaterial({ fog: false });
  const night = smoothstep(0.6, 1.2, cityUniforms.uInteriorGlow);
  const pulse = sin(time.mul(2.2)).mul(0.5).add(0.5);
  lightMat.colorNode = uniform(new THREE.Color(1, 0.08, 0.05)).mul(float(0.25).add(night.mul(pulse.mul(5).add(1.5))));
  group.add(new THREE.Mesh(mergeGeometries(lights), lightMat));
  scene.add(group);
  return { group, count: picks.length };
}

export { buildCranes };
