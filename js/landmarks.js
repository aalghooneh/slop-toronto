import * as THREE from 'three/webgpu';
import { color, mix, smoothstep, positionWorld, sin, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_SITES, TOWERS, POINTS } from './city-config.js';
import { createPreWarBuildingMaterial, createCurtainWallMaterial, cityUniforms } from './tsl-materials.js';
import { batchStaticGroupMeshes } from './city-grid.js';

// js/landmarks.js
// Toronto's landmarks, modelled on their real OpenStreetMap outlines (city-config.js LANDMARK_SITES) and at their real
// heights: the CN Tower (553 m, its tripod shaft, main pod & SkyPod), the Rogers Centre's dome, City Hall's two curved
// towers & council-chamber saucer over Nathan Phillips Square (reflecting pool, Freedom Arches, the TORONTO sign), Old
// City Hall's clock tower, Union Station's colonnade, the Royal York's copper roofs, the Gooderham (Flatiron) Building,
// Queen's Park's Legislative Building, the ROM's Crystal, St. Lawrence Market & Scotiabank Arena; every other reserved
// landmark lot (Roy Thomson Hall, the Eaton Centre, the AGO, the theatres...) is extruded from its outline.

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const colliders = [];
  const site = (name) => LANDMARK_SITES[name];

  // -------------------------------------------------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------------------------------------------------
  const concreteMat = new THREE.MeshStandardNodeMaterial({ color: 0xb9b3a8, roughness: 0.82 });
  const whiteMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e6e0, roughness: 0.55 });
  const darkGlassMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a222b, roughness: 0.12, metalness: 0.85 });
  const copperMat = new THREE.MeshStandardNodeMaterial({ color: 0x4f8a72, roughness: 0.55, metalness: 0.25 });
  const steelMat = new THREE.MeshStandardNodeMaterial({ color: 0xc4c8cc, roughness: 0.35, metalness: 0.85 });
  const redMat = new THREE.MeshStandardNodeMaterial({ color: 0xc8202a, roughness: 0.5 });
  const domeMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9d8d2, roughness: 0.6, metalness: 0.2 });
  const crystalMat = new THREE.MeshStandardNodeMaterial({ color: 0xc6ccd0, roughness: 0.3, metalness: 0.75 });
  // The CN Tower's pod & shaft lights after dusk: a slow colour cycle around the pod, white LEDs up the shaft
  const podGlowMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a222b, roughness: 0.15, metalness: 0.8 });
  podGlowMat.emissiveNode = mix(color(0x6a2cff), color(0xff2a6a), sin(positionWorld.x.mul(0.15).add(time.mul(0.4))).mul(0.5).add(0.5))
    .mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(1.6));
  const shaftLightMat = new THREE.MeshStandardNodeMaterial({ color: 0xb9b3a8, roughness: 0.82 });
  shaftLightMat.emissiveNode = color(0x8a6cff).mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(0.45));
  const STYLE = {
    sandstone: createPreWarBuildingMaterial({ stoneColor: 0xa7735a, trimColor: 0x7d5442, windowGlassColor: 0x1a2028, windowWidth: 2.2, floorHeight: 4.2, litProbability: 0.5, warmth: 0.85, seed: 13.7 }),
    limestone: createPreWarBuildingMaterial({ stoneColor: 0xd9cfbb, trimColor: 0xa99d88, windowGlassColor: 0x1a2632, windowWidth: 2.4, floorHeight: 4.2, litProbability: 0.55, warmth: 0.82, seed: 21.4 }),
    brick: createPreWarBuildingMaterial({ stoneColor: 0x9c4f3a, trimColor: 0xd2c2a6, windowGlassColor: 0x161e26, windowWidth: 2.2, floorHeight: 3.9, litProbability: 0.6, warmth: 0.88, seed: 33.9 }),
    concrete: createPreWarBuildingMaterial({ stoneColor: 0xc4beb2, trimColor: 0x99938a, windowGlassColor: 0x1b2530, windowWidth: 2.6, floorHeight: 3.6, litProbability: 0.55, warmth: 0.75, seed: 45.2 }),
    glass: createCurtainWallMaterial({ glassTint: 0x2a4256, frameTint: 0x8e9aa6, windowWidth: 2.8, floorHeight: 4.0, litProbability: 0.55, warmth: 0.6, reflectivity: 0.93, seed: 52.1 }),
    mirror: createCurtainWallMaterial({ glassTint: 0x3b4a58, frameTint: 0x5d6a74, windowWidth: 1.6, floorHeight: 2.2, litProbability: 0.3, warmth: 0.6, reflectivity: 0.97, seed: 66.6 })
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------------
  const add = (geo, mat, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  function ringShape(ring) {
    const shape = new THREE.Shape();
    ring.forEach((p, i) => (i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z)));
    shape.closePath();
    return shape;
  }
  // The outline `ring` extruded from y0 to y0 + h
  function extrude(ring, y0, h, mat) {
    const geo = new THREE.ExtrudeGeometry(ringShape(ring), { depth: h, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2).translate(0, y0, 0);
    return add(geo, mat);
  }
  // A polygon outline shrunk (or grown) about its centroid by a factor
  const scaleRing = (ring, f, cx, cz) => ring.map((p) => ({ x: cx + (p.x - cx) * f, z: cz + (p.z - cz) * f }));
  const box = (mat, x, y, z, w, h, d, ry = 0) => {
    const m = add(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y + h / 2, z);
    m.rotation.y = ry;
    return m;
  };
  const collide = (x0, x1, z0, z1, maxY) => colliders.push({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), maxY });
  const collideSite = (s, maxY, f = 0.92) => collide(s.x - (s.w * f) / 2, s.x + (s.w * f) / 2, s.z - (s.d * f) / 2, s.z + (s.d * f) / 2, maxY);
  // A square pyramid roof
  const pyramid = (mat, x, y, z, w, h, ry = 0) => {
    const m = add(new THREE.ConeGeometry(w * Math.SQRT1_2, h, 4, 1).rotateY(Math.PI / 4), mat);
    m.position.set(x, y + h / 2, z);
    m.rotation.y = ry;
    return m;
  };
  // A box tapering linearly from (l0, t0) at its foot to (l1, t1) at the top, reaching out along +x from x = 0
  function taperedFin(l0, l1, t0, t1, h) {
    const g = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      p.setXYZ(i, p.getX(i) * (l0 + (l1 - l0) * y), y * h, p.getZ(i) * (t0 + (t1 - t0) * y));
    }
    g.computeVertexNormals();
    return g;
  }
  const modelled = new Set();

  // =========================================================================
  // 1. CN TOWER (553.3 m): a hexagonal core braced by three tapering fins up to the main pod at ~342 m (the white
  //    radome ring, the glass-walled LookOut & EdgeWalk level, the 360 Restaurant), the core on to the SkyPod at
  //    447 m, then the steel antenna mast
  // =========================================================================
  {
    const s = site('CN Tower');
    const cx = s ? s.x : POINTS.cnTower.x;
    const cz = s ? s.z : POINTS.cnTower.z;
    modelled.add('CN Tower');
    const parts = [];
    parts.push(new THREE.CylinderGeometry(5.6, 8.5, 446, 6).translate(0, 223, 0));
    for (let k = 0; k < 3; k++) parts.push(taperedFin(19, 7, 5.5, 3.2, 336).rotateY((k * 2 * Math.PI) / 3 + Math.PI / 6));
    // underside of the main pod
    parts.push(new THREE.CylinderGeometry(19, 8, 12, 24).translate(0, 330, 0));
    parts.push(new THREE.CylinderGeometry(17.5, 19.5, 3, 24).translate(0, 355.5, 0));
    parts.push(new THREE.CylinderGeometry(9, 17.5, 8, 24).translate(0, 361, 0));
    // SkyPod
    parts.push(new THREE.CylinderGeometry(7.5, 6.5, 9, 18).translate(0, 450, 0));
    const shaft = add(mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g))), concreteMat);
    shaft.position.set(cx, 0, cz);
    // the white radome ring (the "doughnut") under the pod & the glass decks above it
    const radome = add(new THREE.TorusGeometry(20.5, 2.6, 10, 40).rotateX(Math.PI / 2), whiteMat);
    radome.position.set(cx, 337.5, cz);
    const deck = add(new THREE.CylinderGeometry(19.5, 20.5, 12, 32, 1, true), podGlowMat, false);
    deck.position.set(cx, 348, cz);
    const deck2 = add(new THREE.CylinderGeometry(19.5, 19.5, 0.6, 32), concreteMat);
    deck2.position.set(cx, 342.2, cz);
    const sky = add(new THREE.CylinderGeometry(7.6, 7.6, 3.2, 18, 1, true), darkGlassMat, false);
    sky.position.set(cx, 450.5, cz);
    // antenna mast in red & white bands, tapering to the tip
    const bands = [];
    for (let k = 0; k < 10; k++) {
      const y0 = 455 + k * 9.8;
      const r0 = 2.6 - k * 0.2;
      bands.push({ g: new THREE.CylinderGeometry(r0 - 0.2, r0, 9.8, 10).translate(0, y0 + 4.9, 0), red: k % 2 === 0 });
    }
    const mastRed = add(mergeGeometries(bands.filter((b) => b.red).map((b) => b.g)), redMat);
    const mastWhite = add(mergeGeometries(bands.filter((b) => !b.red).map((b) => b.g)), whiteMat);
    mastRed.position.set(cx, 0, cz);
    mastWhite.position.set(cx, 0, cz);
    // a lit band up the shaft at night
    const glowBand = add(new THREE.CylinderGeometry(5.75, 8.4, 330, 6, 1, true).translate(0, 168, 0), shaftLightMat, false);
    glowBand.position.set(cx, 0, cz);
    glowBand.scale.set(1.01, 1, 1.01);
    collide(cx - 9, cx + 9, cz - 9, cz + 9, 553);
    // the tower's base pavilion
    box(STYLE.glass, cx + 26, 0, cz + 6, 30, 9, 26);
    collide(cx + 11, cx + 41, cz - 7, cz + 19, 9);
  }

  // =========================================================================
  // 2. ROGERS CENTRE: the 86 m retractable dome on its round concrete drum
  // =========================================================================
  {
    const s = site('Rogers Centre');
    if (s) {
      modelled.add('Rogers Centre');
      const R = 100;
      const pts = [];
      pts.push(new THREE.Vector2(R, 0), new THREE.Vector2(R, 30));
      for (let k = 0; k <= 16; k++) {
        const a = (k / 16) * (Math.PI / 2);
        pts.push(new THREE.Vector2(Math.cos(a) * (R - 2), 30 + Math.sin(a) * 56));
      }
      const drum = add(new THREE.CylinderGeometry(R + 1, R + 2, 30, 64, 1, true), STYLE.concrete);
      drum.position.set(s.x, 15, s.z);
      drum.scale.set(s.w / (2 * R + 4), 1, s.d / (2 * R + 4));
      const dome = add(new THREE.LatheGeometry(pts.slice(2), 64), domeMat);
      dome.position.set(s.x, 0, s.z);
      dome.scale.set(s.w / (2 * R + 4), 1, s.d / (2 * R + 4));
      // the dome's panel seams
      for (let k = 0; k < 4; k++) {
        const seam = add(new THREE.TorusGeometry(R - 1.5, 0.5, 6, 48, Math.PI).rotateY((k * Math.PI) / 8), steelMat, false);
        seam.position.set(s.x, 30, s.z);
        seam.scale.set((s.w / (2 * R + 4)) * 0.99, 0.56 * (R / (R - 1.5)), (s.d / (2 * R + 4)) * 0.99);
        seam.rotation.y = (k * Math.PI) / 4;
      }
      collideSite(s, 86, 0.66);
    }
  }

  // =========================================================================
  // 3. CITY HALL & NATHAN PHILLIPS SQUARE (Viljo Revell, 1965): the two curved towers (east 99 m, west 79 m) around
  //    the council chamber's saucer on the podium; to the south the square's reflecting pool under the three Freedom
  //    Arches and the TORONTO sign
  // =========================================================================
  {
    const s = site('Toronto City Hall');
    if (s) {
      modelled.add('Toronto City Hall');
      const cx = s.x;
      const cz = s.z;
      // podium
      box(STYLE.concrete, cx, 0, cz, Math.min(s.w, 110), 9, Math.min(s.d, 70));
      collide(cx - 55, cx + 55, cz - 35, cz + 35, 9);
      // the towers: annular sectors facing each other across the saucer, their convex backs to the east & west
      const tower = (dir, h, span) => {
        const shape = new THREE.Shape();
        const r0 = 30, r1 = 46;
        const a0 = -span / 2, a1 = span / 2;
        shape.absarc(0, 0, r1, a0, a1, false);
        shape.absarc(0, 0, r0, a1, a0, true);
        const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 24 });
        g.rotateX(-Math.PI / 2);
        const outer = add(g, concreteMat);
        outer.position.set(cx, 0, cz - 6);
        outer.rotation.y = dir > 0 ? 0 : Math.PI;
        // the glazed inner (concave) face
        const inner = add(new THREE.CylinderGeometry(30.2, 30.2, h - 1, 24, 1, true, Math.PI / 2 - span / 2, span), darkGlassMat, false);
        inner.position.set(cx, (h - 1) / 2, cz - 6);
        inner.rotation.y = dir > 0 ? 0 : Math.PI;
        const x0 = cx + dir * 30, x1 = cx + dir * 46;
        collide(x0, x1, cz - 6 - 34, cz - 6 + 34, h);
      };
      tower(1, 99, 1.45);
      tower(-1, 79, 1.35);
      // the council chamber: a white saucer on its column
      const col = add(new THREE.CylinderGeometry(4, 5, 6, 16), concreteMat);
      col.position.set(cx, 12, cz - 6);
      const saucer = add(new THREE.SphereGeometry(22, 32, 12), whiteMat);
      saucer.position.set(cx, 17, cz - 6);
      saucer.scale.set(1, 0.3, 1);

      // Nathan Phillips Square: between the podium and Queen St
      const sqZ0 = cz + 40;
      const sqZ1 = Math.max(sqZ0 + 60, 2);
      const midZ = (sqZ0 + sqZ1) / 2;
      const pool = add(new THREE.PlaneGeometry(60, 26).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x2a4658, roughness: 0.08, metalness: 0.3 }), false);
      pool.position.set(cx + 18, 0.3, midZ);
      box(STYLE.concrete, cx + 18, 0, midZ - 13.5, 62, 0.45, 1.2);
      box(STYLE.concrete, cx + 18, 0, midZ + 13.5, 62, 0.45, 1.2);
      box(STYLE.concrete, cx + 18 - 30.5, 0, midZ, 1.2, 0.45, 28);
      box(STYLE.concrete, cx + 18 + 30.5, 0, midZ, 1.2, 0.45, 28);
      // the three Freedom Arches over the pool
      for (const ax of [-18, 0, 18]) {
        const arch = add(new THREE.TorusGeometry(12, 0.55, 8, 32, Math.PI), whiteMat);
        arch.position.set(cx + 18 + ax, 0.3, midZ);
        arch.rotation.y = Math.PI / 2;
        arch.scale.set(1, 0.85, 1);
      }
      // the TORONTO sign: 3D letters lit in changing colours at night
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 160;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1024, 160);
      ctx.font = '900 150px Inter, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const letters = 'TORONTO';
      const cols = ['#e03a3e', '#f28c28', '#f4d03f', '#3aa655', '#2e86de', '#8e44ad', '#e84393'];
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(0, 0, 1024, 160);
      for (let i = 0; i < letters.length; i++) {
        ctx.fillStyle = cols[i];
        ctx.fillText(letters[i], 75 + i * 146, 86);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const signMat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.4 });
      signMat.emissiveNode = color(0xffffff).mul(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(0.5));
      const sign = box(signMat, cx + 18, 0.3, midZ - 20, 22, 3, 0.9);
      sign.receiveShadow = false;
      collide(cx + 7, cx + 29, midZ - 20.5, midZ - 19.5, 3.3);
    }
  }

  // =========================================================================
  // 4. OLD CITY HALL (1899): the Richardsonian Romanesque sandstone block & its 104 m clock tower at the head of Bay St
  // =========================================================================
  {
    const s = site('Old City Hall');
    if (s) {
      modelled.add('Old City Hall');
      extrude(s.ring, 0, 24, STYLE.sandstone);
      pyramid(copperMat, s.x, 24, s.z, Math.min(s.w, s.d) * 0.55, 10);
      // the clock tower on the Queen St (south) front, centred on Bay St
      const tx = Math.abs(s.x - -192) < s.w / 2 ? -192 : s.x;
      const tz = s.z + s.d / 2 - 7;
      box(STYLE.sandstone, tx, 0, tz, 12, 82, 12);
      pyramid(copperMat, tx, 82, tz, 13.5, 22);
      for (const [dx, dz, ry] of [[0, 6.05, 0], [0, -6.05, Math.PI], [6.05, 0, Math.PI / 2], [-6.05, 0, -Math.PI / 2]]) {
        const face = add(new THREE.CircleGeometry(2.6, 24), whiteMat, false);
        face.position.set(tx + dx, 72, tz + dz);
        face.rotation.y = ry;
      }
      collideSite(s, 24);
      collide(tx - 6, tx + 6, tz - 6, tz + 6, 104);
    }
  }

  // =========================================================================
  // 5. UNION STATION (1927): the long Beaux-Arts block on Front St, its colonnade of 22 Roman Doric columns & the Great
  //    Hall rising over the middle
  // =========================================================================
  {
    const s = site('Union Station');
    if (s) {
      modelled.add('Union Station');
      extrude(s.ring, 0, 22, STYLE.limestone);
      box(STYLE.limestone, s.x, 22, s.z - s.d * 0.1, Math.min(80, s.w * 0.4), 8, s.d * 0.55);
      const zf = s.z - s.d / 2 - 2.6;
      const n = 22;
      const span = Math.min(s.w * 0.55, 130);
      for (let i = 0; i < n; i++) {
        const col = add(new THREE.CylinderGeometry(0.85, 0.95, 13, 14), STYLE.limestone);
        col.position.set(s.x - span / 2 + (span * i) / (n - 1), 6.5, zf);
      }
      box(STYLE.limestone, s.x, 13, zf, span + 4, 3, 3.4);
      collideSite(s, 30);
    }
  }

  // =========================================================================
  // 6. FAIRMONT ROYAL YORK (1929): the château-style hotel's base, its central tower & copper roofs
  // =========================================================================
  {
    const s = site('Fairmont Royal York Hotel');
    if (s) {
      modelled.add('Fairmont Royal York Hotel');
      extrude(s.ring, 0, 44, STYLE.limestone);
      const w = s.w * 0.42;
      const d = s.d * 0.38;
      box(STYLE.limestone, s.x, 44, s.z, w, 52, d);
      pyramid(copperMat, s.x, 96, s.z, Math.max(w, d) * 0.95, 26);
      box(STYLE.limestone, s.x - s.w * 0.3, 44, s.z, s.w * 0.18, 18, s.d * 0.3);
      box(STYLE.limestone, s.x + s.w * 0.3, 44, s.z, s.w * 0.18, 18, s.d * 0.3);
      pyramid(copperMat, s.x - s.w * 0.3, 62, s.z, s.w * 0.2, 10);
      pyramid(copperMat, s.x + s.w * 0.3, 62, s.z, s.w * 0.2, 10);
      collideSite(s, 44);
      collide(s.x - w / 2, s.x + w / 2, s.z - d / 2, s.z + d / 2, 124);
    }
  }

  // =========================================================================
  // 7. GOODERHAM (FLATIRON) BUILDING (1892): the red-brick wedge between Front & Wellington Sts, its round turret &
  //    copper cap at the point facing Church St
  // =========================================================================
  {
    const s = site('Gooderham Building');
    if (s) {
      modelled.add('Gooderham Building');
      extrude(s.ring, 0, 19, STYLE.brick);
      // the sharpest corner of the outline is the point
      let best = null;
      const R = s.ring;
      for (let i = 0; i < R.length; i++) {
        const p = R[(i + R.length - 1) % R.length], q = R[i], r = R[(i + 1) % R.length];
        const ax = p.x - q.x, az = p.z - q.z, bx = r.x - q.x, bz = r.z - q.z;
        const cos = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
        if (!best || cos > best.cos) best = { cos, q };
      }
      const tx = best.q.x + (s.x - best.q.x) * 0.12;
      const tz = best.q.z + (s.z - best.q.z) * 0.12;
      const turret = add(new THREE.CylinderGeometry(3.4, 3.4, 21, 16), STYLE.brick);
      turret.position.set(tx, 10.5, tz);
      const cap = add(new THREE.ConeGeometry(4.0, 7, 16), copperMat);
      cap.position.set(tx, 24.5, tz);
      add(new THREE.ExtrudeGeometry(ringShape(scaleRing(s.ring, 0.97, s.x, s.z)), { depth: 2.5, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, 19, 0), copperMat);
      collideSite(s, 21, 0.8);
    }
  }

  // =========================================================================
  // 8. QUEEN'S PARK: the Ontario Legislative Building (1893), pink Credit Valley sandstone, its towers over the south
  //    front looking down University Ave
  // =========================================================================
  {
    const s = site('Ontario Legislative Building');
    if (s) {
      modelled.add('Ontario Legislative Building');
      extrude(s.ring, 0, 21, STYLE.sandstone);
      const fz = s.z + s.d / 2 - 10;
      for (const dx of [-11, 11]) {
        box(STYLE.sandstone, s.x + dx, 0, fz, 10, 40, 10);
        pyramid(copperMat, s.x + dx, 40, fz, 11, 12);
      }
      box(STYLE.sandstone, s.x, 0, fz + 2, 14, 30, 8);
      collideSite(s, 21);
    }
  }

  // =========================================================================
  // 9. ROYAL ONTARIO MUSEUM: the 1914 galleries & Daniel Libeskind's Michael Lee-Chin Crystal (2007), its tilted
  //    aluminium & glass prisms breaking out over Bloor St
  // =========================================================================
  {
    const s = site('Royal Ontario Museum');
    if (s) {
      modelled.add('Royal Ontario Museum');
      extrude(s.ring, 0, 24, STYLE.limestone);
      const bz = s.z - s.d / 2 + 18;
      const prisms = [[-18, 0, 34, 22, 26, 0.35, 0.15], [6, 4, 30, 18, 30, -0.25, 0.3], [22, -2, 26, 16, 22, 0.2, -0.4], [-2, -8, 20, 26, 16, 0.5, 0.1]];
      for (const [dx, dz, h, w, d, rx, rz] of prisms) {
        const m = add(new THREE.BoxGeometry(w, h, d), crystalMat);
        m.position.set(s.x + dx, h * 0.45, bz + dz);
        m.rotation.set(rx, (dx + dz) * 0.03, rz);
      }
      collideSite(s, 30);
    }
  }

  // =========================================================================
  // 10. ST. LAWRENCE MARKET (South Market, 1845/1904) & SCOTIABANK ARENA
  // =========================================================================
  {
    const s = site('St. Lawrence Market South');
    if (s) {
      modelled.add('St. Lawrence Market South');
      extrude(s.ring, 0, 14, STYLE.brick);
      const front = add(new THREE.BoxGeometry(Math.min(s.w, 30), 9, 12), STYLE.brick);
      front.position.set(s.x, 18.5, s.z - s.d / 2 + 6);
      pyramid(copperMat, s.x, 23, s.z - s.d / 2 + 6, 10, 6);
      collideSite(s, 14);
    }
    const a = site('Scotiabank Arena');
    if (a) {
      modelled.add('Scotiabank Arena');
      extrude(a.ring, 0, 36, STYLE.glass);
      collideSite(a, 36);
    }
  }

  // =========================================================================
  // 11. EVERY OTHER RESERVED LANDMARK LOT (city-config.js LANDMARK_SITES, kept clear by buildings.js): its real outline
  //     at its real height, unless it is one of the towers towers.js builds
  // =========================================================================
  {
    const HEIGHT = { 'Roy Thomson Hall': 27, 'Massey Hall': 22, 'Hockey Hall of Fame': 20, 'Art Gallery of Ontario': 24, 'Sharp Centre for Design': 26,
      'Ripley\'s Aquarium of Canada': 14, 'Metro Toronto Convention Centre - North Building': 18, 'Metro Toronto Convention Centre - South Building': 10,
      'CF Toronto Eaton Centre': 30, 'Brookfield Place': 18, 'Allen Lambert Galleria': 26, 'Westin Harbour Castle': 14, 'Cathedral Church of St. James': 22,
      'Four Seasons Centre for the Performing Arts': 30, 'Princess of Wales Theatre': 22, 'Royal Alexandra Theatre': 20, 'Meridian Hall': 30,
      'John Street Roundhouse': 9, 'Osgoode Hall': 16 };
    const STYLE_OF = { 'Roy Thomson Hall': 'mirror', 'Allen Lambert Galleria': 'glass', 'Sharp Centre for Design': 'concrete', 'Ripley\'s Aquarium of Canada': 'glass',
      'CF Toronto Eaton Centre': 'glass', 'Cathedral Church of St. James': 'limestone', 'Massey Hall': 'brick', 'Royal Alexandra Theatre': 'brick',
      'John Street Roundhouse': 'brick', 'Osgoode Hall': 'limestone', 'Hockey Hall of Fame': 'limestone', 'Art Gallery of Ontario': 'glass' };
    const towerAt = (s) => TOWERS.some((t) => t.cx > s.x - s.w / 2 && t.cx < s.x + s.w / 2 && t.cz > s.z - s.d / 2 && t.cz < s.z + s.d / 2);
    for (const [name, s] of Object.entries(LANDMARK_SITES)) {
      if (modelled.has(name) || towerAt(s) || !s.ring || s.ring.length < 3) continue;
      const h = (s.h && s.h > 4 && s.h < 40 ? s.h : null) ?? HEIGHT[name] ?? 18;
      if (name === 'Sharp Centre for Design') {
        // the "tabletop": a box on stilts over the art college
        extrude(s.ring, 0, 9, STYLE.concrete);
        box(whiteMat, s.x, 26, s.z, s.w * 0.9, 9, s.d * 0.9);
        for (const [dx, dz] of [[-0.35, -0.3], [0.3, 0.25], [-0.1, 0.35], [0.38, -0.2]]) {
          const leg = add(new THREE.CylinderGeometry(0.5, 0.5, 27, 8), copperMat);
          leg.position.set(s.x + dx * s.w, 13, s.z + dz * s.d);
          leg.rotation.z = dx * 0.4;
        }
        collideSite(s, 9);
        continue;
      }
      extrude(s.ring, 0, h, STYLE[STYLE_OF[name] || 'concrete']);
      if (name === 'Cathedral Church of St. James') {
        // its 93 m spire over the west front
        const sx = s.x - s.w / 2 + 8;
        box(STYLE.limestone, sx, 0, s.z, 9, 46, 9);
        const spire = add(new THREE.ConeGeometry(5.2, 47, 8), copperMat);
        spire.position.set(sx, 46 + 23.5, s.z);
      }
      collideSite(s, h);
    }
  }

  batchStaticGroupMeshes(group, new Set([podGlowMat, shaftLightMat]));
  scene.add(group);
  return { group, colliders };
}

export { buildLandmarks };
