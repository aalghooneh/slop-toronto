import * as THREE from 'three/webgpu';
import { Fn, float, color, positionWorld, uniform, mod, fract, step, smoothstep, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIGNAL_TIMING, blockAt, BLOCKS, FURNITURE, POINTS } from './city-config.js';
import { GEO } from './toronto-geodata.js';
import { cityUniforms, createTreeGrateMaterial, createGodRayMaterial } from './tsl-materials.js';
import { createTreeField } from './trees.js';
import { pavedPlazaRects, parkTreeSites, sidewalkBlocks, parkLampSites } from './city-grid.js';

// js/street-details.js
// Populates downtown Toronto's streets with its street furniture using InstancedMesh:
// - Mast-arm traffic signals with walk signals at every signalised intersection (the real ones, OpenStreetMap)
// - Cobra-head LED streetlights & post-top pedestrian lamps
// - TTC subway entrance pylons at the real entrances
// - Hot dog carts ("street meat") with umbrellas by the squares & stations
// - Fire hydrants & Canada Post letter boxes at their real places, park & street trees (the real ones and more)

function createStreetSignBladeTexture(label) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#123f8c'; // Toronto's blue street-name blades
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 30px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * TSL 3-Aspect Traffic Signal Lens Material (Red y=5.78, Amber y=5.42, Green y=5.06)
 * Driven by the shared signal clock and SIGNAL_TIMING (city-config.js), which js/traffic.js obeys.
 */
function createTrafficSignalLensMaterial(isAvenueHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const wy = positionWorld.y;
    const isTopRed = step(5.60, wy);
    const isBottomGreen = float(1.0).sub(step(5.24, wy));
    const isMidAmber = float(1.0).sub(isTopRed).mul(float(1.0).sub(isBottomGreen));

    // Avenue phase: Green, then Amber from avenueAmber, Red from avenueRed
    // Street phase: Red until avenueRed, then Green, Amber from streetAmber
    const greenActive = isAvenueHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isAvenueHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isAvenueHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isTopRed.mul(redActive)
      .add(isMidAmber.mul(amberActive))
      .add(isBottomGreen.mul(greenActive));

    const lensHue = mix(
      mix(color(0x18ff68), color(0xffaa10), isMidAmber),
      color(0xff2424),
      isTopRed
    );
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

// Pedestrian signal for crossing alongside the avenue: WALK, then a flashing hand until the avenue's amber, then a
// steady hand
function createWalkSignalMaterial(clock) {
  const { cycle, avenueAmber, walk } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const isWalk = float(1.0).sub(step(walk, t));
    const isFlashing = step(walk, t).mul(float(1.0).sub(step(avenueAmber, t)));
    const handLit = float(1.0).sub(isFlashing.mul(step(0.5, fract(t))));
    const hand = mix(color(0x14181e), color(0xff5518), handLit);
    return mix(hand, color(0xf4f9ff), isWalk);
  })();
  return mat;
}

function buildStreetDetails(scene) {
  const group = new THREE.Group();
  group.name = 'StreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that traffic and pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // Shared materials
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b4046,
    roughness: 0.45,
    metalness: 0.78
  });
  const signalHousingMat = new THREE.MeshStandardNodeMaterial({
    color: 0x1d1f22, // black signal housings
    roughness: 0.38,
    metalness: 0.35,
    side: THREE.DoubleSide // the tunnel visors are open half-tubes
  });
  const aveSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const streetSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  const walkSignalGlow = createWalkSignalMaterial(signalClock);
  // Cobra-head LED streetlight lens & pedestrian post-top globe: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const pedGlobeGlow = new THREE.MeshBasicNodeMaterial();
  pedGlobeGlow.colorNode = mix(color(0xd4d2c8), color(0xffe4b0).mul(1.95), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const streetBladeMat = new THREE.MeshStandardNodeMaterial({
    map: createStreetSignBladeTexture('KING ST W'),
    roughness: 0.32
  });

  // 12-inch three-section signal head (origin at its centre, y = 5.42): black housing, a tunnel visor over each lens
  // and a hanger to the mast arm, lenses on both faces (+-z) so it reads from both approaches; the lens material
  // picks red / amber / green from each lens's world height (5.78 / 5.42 / 5.06)
  const HEAD_W = 0.4;
  const HEAD_H = 1.12;
  const HEAD_D = 0.28;
  const LENS_R = 0.145;
  const LENS_Y = [0.36, 0, -0.36];
  const bothFaces = (geo) => [geo, geo.clone().rotateY(Math.PI)];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    new THREE.BoxGeometry(0.07, 0.2, 0.07).translate(0, HEAD_H / 2 + 0.1, 0),
    ...LENS_Y.flatMap((ly) => bothFaces(
      new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.24, 14, 1, true, Math.PI / 2, Math.PI)
        .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.12)
    ))
  ].map((g) => g.toNonIndexed()));
  const signalLensGeo = mergeGeometries(LENS_Y.flatMap((ly) => bothFaces(new THREE.CircleGeometry(LENS_R, 18).translate(0, ly, HEAD_D / 2 + 0.004))));
  // Pedestrian signal: housing with the WALK / hand face lit on both sides (+-z, toward the crosswalk's far end)
  const walkHousingGeo = new THREE.BoxGeometry(0.34, 0.4, 0.24);
  const walkPanelGeo = mergeGeometries(bothFaces(new THREE.PlaneGeometry(0.27, 0.31).translate(0, 0, 0.125)));
  // Cobra-head luminaire on the end of the arm: flattened grey housing, flat lens underneath
  const lampHousingGeo = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.7, 0.2, 0.3);
  const lampLensGeo = new THREE.CircleGeometry(1, 16).rotateX(Math.PI / 2).scale(0.6, 1, 0.24).translate(0, -0.005, 0);
  // Post-top pedestrian lightpole (fluted base + shaft + decorative capital + opal globe)
  const pedLampPostGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.11, 0.16, 0.85, 10).translate(0, 0.425, 0),
    new THREE.CylinderGeometry(0.065, 0.085, 2.75, 10).translate(0, 2.22, 0),
    new THREE.CylinderGeometry(0.14, 0.07, 0.16, 10).translate(0, 3.62, 0)
  ].map((g) => g.toNonIndexed()));
  const pedGlobeGeo = new THREE.SphereGeometry(0.23, 12, 10).translate(0, 3.84, 0);

  // =========================================================================
  // 1. MAST-ARM TRAFFIC SIGNALS, STREET BLADES & WALK SIGNALS
  // =========================================================================
  const poleMatrices = [];
  const armMatrices = [];
  const yellowBoxMatrices = [];
  const aveLensMatrices = [];
  const streetLensMatrices = [];
  const streetBladeMatrices = [];
  const walkBoxMatrices = [];
  const audioSignals = [];
  const lampHeadMatrices = [];
  const pedPostMatrices = [];
  const cobraLampSites = [];
  const streetPointSites = [];
  const placedPoles = [];

  const plazaRects = pavedPlazaRects || [];
  const inPlaza = (x, z, m = 1.0) =>
    plazaRects.some((r) => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m);

  // True only when (x, z) and its surrounding pad-meter footprint sit on a real curb island (never in a road or median)
  const isOnCurbIsland = (x, z, pad = 0.55) => {
    const b = blockAt(x, z);
    if (!b || b.median) return false;
    if (pad <= 0) return true;
    const b1 = blockAt(x - pad, z);
    const b2 = blockAt(x + pad, z);
    const b3 = blockAt(x, z - pad);
    const b4 = blockAt(x, z + pad);
    return !!(b1 && !b1.median && b2 && !b2.median && b3 && !b3.median && b4 && !b4.median);
  };

  // True only when (x, z) is on a non-park, non-median, non-plaza sidewalk with `pad` clearance from all curbs
  const isOnSidewalk = (x, z, pad = 0.55) => {
    if (!isOnCurbIsland(x, z, pad)) return false;
    const b = blockAt(x, z);
    return !(b.park > 0.6) && !inPlaza(x, z, 1.0);
  };

  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    for (let i = 0; i < placedPoles.length; i++) {
      const dx = placedPoles[i].x - x;
      const dz = placedPoles[i].z - z;
      if (dx * dx + dz * dz < md2) return false;
    }
    return true;
  };

  // The signalised intersections: junctions of the street centreline graph where three or more roads meet within reach
  // of a real traffic signal (OpenStreetMap), with the half widths of their north-south and east-west roads (the arm
  // nearest each axis); junctions of roads well off the grid's axes are skipped
  const intersections = (() => {
    const RG = GEO.roadGraph;
    const arms = new Map();
    const pos = (i) => ({ x: RG.nodes[i * 2], z: RG.nodes[i * 2 + 1] });
    for (const [a, b, , w, , , inner] of RG.links) {
      for (const [n, far] of [[a, inner.length ? { x: inner[0], z: inner[1] } : pos(b)], [b, inner.length ? { x: inner[inner.length - 2], z: inner[inner.length - 1] } : pos(a)]]) {
        const p = pos(n);
        const L = Math.hypot(far.x - p.x, far.z - p.z) || 1;
        if (!arms.has(n)) arms.set(n, []);
        arms.get(n).push({ ux: (far.x - p.x) / L, uz: (far.z - p.z) / L, w });
      }
    }
    const sig = FURNITURE.signals;
    const out = [];
    for (const [n, list] of arms) {
      if (list.length < 3) continue;
      const p = pos(n);
      if (!sig.some((q) => Math.abs(q.x - p.x) < 16 && Math.abs(q.z - p.z) < 16)) continue;
      let ns = 0, ew = 0, off = false;
      for (const arm of list) {
        if (Math.abs(arm.uz) > 0.94) ns = Math.max(ns, arm.w);
        else if (Math.abs(arm.ux) > 0.94) ew = Math.max(ew, arm.w);
        else off = true;
      }
      if (!ns || !ew || off) continue;
      // one signal per junction (dual carriageways meet a street at two nodes a few metres apart)
      if (out.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 18)) continue;
      out.push({ x: p.x, z: p.z, nsW: ns, ewW: ew, nsMajor: ns >= ew });
    }
    return out;
  })();

  for (const ix of intersections) {
    {
      const ave = { x: ix.x, width: ix.nsW };
      const st = { z: ix.z, width: ix.ewW };
      const nsMajor = ix.nsMajor;
      const cornerOffsetX = ave.width * 0.5 + 1.25;
      const cornerOffsetZ = st.width * 0.5 + 1.25;

      // Place diagonal pair of traffic signal masts at NE and SW corners of every intersection
      const corners = [
        { sx: 1, sz: -1, armDir: -1 },
        { sx: -1, sz: 1, armDir: 1 }
      ];

      for (const c of corners) {
        let px = ave.x + c.sx * cornerOffsetX;
        let pz = st.z + c.sz * cornerOffsetZ;
        if (!isOnCurbIsland(px, pz, 0.55) || inPlaza(px, pz, 1.0)) {
          // Try nudging slightly deeper into the block corner if clipped near the curb
          const altX = ave.x + c.sx * (cornerOffsetX + 0.85);
          const altZ = st.z + c.sz * (cornerOffsetZ + 0.85);
          if (isOnCurbIsland(altX, altZ, 0.55) && !inPlaza(altX, altZ, 1.0)) {
            px = altX;
            pz = altZ;
          } else {
            continue;
          }
        }
        // Ensure the mast arm actually overhangs the north-south roadway
        if (blockAt(px + c.armDir * 3.1, pz) || !isClearOfPoles(px, pz, 6.0)) continue;
        placedPoles.push({ x: px, z: pz });
        addFootprint(px, pz, 0.5, 0.5);

        // Vertical pole (6.4m tall)
        dummy.position.set(px, 3.3, pz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0.14, 6.4, 0.14);
        dummy.updateMatrix();
        poleMatrices.push(dummy.matrix.clone());

        // Street name sign blade mounted on the pole (y = 4.65m)
        dummy.position.set(px + c.armDir * 0.68, 4.65, pz);
        dummy.scale.set(1.38, 0.34, 0.08);
        dummy.updateMatrix();
        streetBladeMatrices.push(dummy.matrix.clone());

        // Pedestrian walk signal on the pole at crosswalk level (y = 3.15m), facing across the street
        dummy.position.set(px + c.armDir * 0.24, 3.15, pz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        walkBoxMatrices.push(dummy.matrix.clone());
        // These panels share the north-south road's WALK phase; rejected/unplaced poles never become sound sources.
        audioSignals.push({ x: dummy.position.x, y: dummy.position.y, z: dummy.position.z, isAvenue: nsMajor });

        // Mast arm reaching 6.5m over the north-south road
        const armX = px + c.armDir * 3.25;
        dummy.position.set(armX, 6.1, pz);
        dummy.scale.set(6.5, 0.11, 0.11);
        dummy.updateMatrix();
        armMatrices.push(dummy.matrix.clone());

        // Intersection corner cobra-head luminaire overhanging the crosswalk & corner sidewalk
        const cornerLampX = px + c.armDir * 1.85;
        dummy.position.set(cornerLampX, 6.22, pz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        lampHeadMatrices.push(dummy.matrix.clone());
        cobraLampSites.push({
          x: cornerLampX,
          y: 6.18,
          z: pz,
          tx: px + c.armDir * 2.8,
          tz: pz - c.sz * 1.4
        });

        // Two signal heads hanging from the mast arm: the north-south road's (3.1 m out, facing up & down it) and the
        // cross road's (5.5 m out, turned to face along it); the major road's heads follow its phase
        for (const armDist of [3.1, 5.5]) {
          dummy.position.set(px + c.armDir * armDist, 5.42, pz);
          dummy.rotation.set(0, armDist < 4.0 ? 0 : Math.PI / 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          yellowBoxMatrices.push(dummy.matrix.clone());
          ((armDist < 4.0) === nsMajor ? aveLensMatrices : streetLensMatrices).push(dummy.matrix.clone());
        }
        dummy.rotation.set(0, 0, 0);
      }
    }
  }

  // =========================================================================
  // 2. MID-BLOCK AVENUE & STREET ORNAMENTAL ACORN & COBRA STREETLIGHTS
  //    Placed directly along the true curb edges of every city block (BLOCKS)
  //    and verified with blockAt(x, z) so no pole ever stands in any roadway.
  // =========================================================================
  const allBlocks = BLOCKS || [];
  for (const b of allBlocks) {
    if (!b || !b.poly || b.poly.length < 3 || b.median || b.park > 0.6 || b.rail > 0.5) continue;
    if (b.cz < -1950 || b.cz > 1300 || b.cx < -1700 || b.cx > 1400) continue;

    const poly = b.poly;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 24) continue;

      const ux = dx / len;
      const uz = dz / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;

      // Determine inward normal (into the sidewalk block) and outward normal (into the street roadway)
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) continue;
      const outX = -inx;
      const outZ = -inz;
      // Confirm this curb edge fronts an open roadway
      if (blockAt(mx + outX * 2.5, mz + outZ * 2.5)) continue;

      const isAvenueEdge = Math.abs(uz) > 0.65;
      if (isAvenueEdge) {
        const armYaw = Math.atan2(-outZ, outX);
        const cobraFracs = inx > 0 ? [0.26, 0.72] : [0.32, 0.78];
        for (const f of cobraFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const lx = cx + inx * 1.08;
          const lz = cz + inz * 1.08;
          const headX = lx + outX * 2.6;
          const headZ = lz + outZ * 2.6;
          if (
            !isOnSidewalk(lx, lz, 0.55) ||
            blockAt(cx + outX * 2.5, cz + outZ * 2.5) ||
            blockAt(headX, headZ) ||
            !isClearOfPoles(lx, lz, 6.5)
          ) {
            continue;
          }
          placedPoles.push({ x: lx, z: lz });
          addFootprint(lx, lz, 0.45, 0.45);

          // Tall ornamental streetlight pole
          dummy.position.set(lx, 4.3, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.12, 8.4, 0.12);
          dummy.updateMatrix();
          poleMatrices.push(dummy.matrix.clone());

          // Upper luminaire bracket arm overhanging the street
          dummy.position.set(lx + outX * 1.15, 8.2, lz + outZ * 1.15);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(2.3, 0.09, 0.09);
          dummy.updateMatrix();
          armMatrices.push(dummy.matrix.clone());

          // Cobra-head LED luminaire on the end of the arm, lens facing the street
          dummy.position.set(headX, 8.08, headZ);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          lampHeadMatrices.push(dummy.matrix.clone());
          dummy.rotation.set(0, 0, 0);

          cobraLampSites.push({
            x: headX,
            y: 8.02,
            z: headZ,
            tx: lx + outX * 3.4,
            tz: lz + outZ * 3.4
          });
        }

        // Post-top pedestrian lamps along avenue sidewalks (with PointLights)
        const pedFracs = len >= 48 ? [0.16, 0.50, 0.84] : [0.24, 0.76];
        for (const f of pedFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.42;
          const pz = cz + inz * 1.42;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.2)
          ) {
            continue;
          }
          placedPoles.push({ x: px, z: pz });
          addFootprint(px, pz, 0.4, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 30,
            dist: 14.5
          });
        }
      } else if (len >= 36) {
        // Cross-street cast-iron pedestrian post-top globe lightpoles along north and south block curbs
        const crossFracs = len >= 115 ? [0.20, 0.40, 0.60, 0.80] : [0.24, 0.50, 0.76];
        for (const f of crossFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.22;
          const pz = cz + inz * 1.22;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.5)
          ) {
            continue;
          }
          placedPoles.push({ x: px, z: pz });
          addFootprint(px, pz, 0.4, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 28,
            dist: 14.0
          });
        }
      }
    }
  }

  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true) {
    if (matrices.length === 0) return;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  addMatrixArrayInstanced(unitCyl, poleMetalMat, poleMatrices);
  addMatrixArrayInstanced(unitBox, poleMetalMat, armMatrices);
  addMatrixArrayInstanced(signalHousingGeo, signalHousingMat, yellowBoxMatrices);
  addMatrixArrayInstanced(signalLensGeo, aveSignalLensMat, aveLensMatrices, false);
  addMatrixArrayInstanced(signalLensGeo, streetSignalLensMat, streetLensMatrices, false);
  addMatrixArrayInstanced(unitBox, streetBladeMat, streetBladeMatrices);
  addMatrixArrayInstanced(walkHousingGeo, signalHousingMat, walkBoxMatrices);
  addMatrixArrayInstanced(walkPanelGeo, walkSignalGlow, walkBoxMatrices, false);
  addMatrixArrayInstanced(lampHousingGeo, poleMetalMat, lampHeadMatrices);
  addMatrixArrayInstanced(lampLensGeo, lampBulbGlow, lampHeadMatrices, false);
  addMatrixArrayInstanced(pedLampPostGeo, poleMetalMat, pedPostMatrices);
  addMatrixArrayInstanced(pedGlobeGeo, pedGlobeGlow, pedPostMatrices, false);

  // =========================================================================
  // 2B. VOLUMETRIC GOLDEN-HOUR CANYON SUN SHAFTS (GOD RAYS)
  // =========================================================================
  const godRayMat = createGodRayMaterial();
  const godRayGeo = new THREE.PlaneGeometry(54, 92);
  // The financial core's canyons: Bay St at King & at Adelaide, King St at York, Front St by Union Station, Yonge St
  const canyonShafts = [
    { x: -192, y: 44, z: 392, rotY: 0.32, rotZ: -0.46 },
    { x: -195, y: 46, z: 240, rotY: 0.28, rotZ: -0.44 },
    { x: -640, y: 42, z: 395, rotY: 0.30, rotZ: -0.44 },
    { x: -420, y: 40, z: 660, rotY: 0.35, rotZ: -0.42 },
    { x: 15, y: 46, z: 300, rotY: 0.25, rotZ: -0.45 }
  ];
  for (const cs of canyonShafts) {
    const shaft = new THREE.Mesh(godRayGeo, godRayMat);
    shaft.position.set(cs.x, cs.y, cs.z);
    shaft.rotation.set(0.12, cs.rotY, cs.rotZ);
    group.add(shaft);
  }

  // =========================================================================
  // 4. TTC SUBWAY ENTRANCES: the red TTC pylon at each street entrance (OpenStreetMap), lit after dusk
  // =========================================================================
  const ttcRedMat = new THREE.MeshStandardNodeMaterial({ color: 0xc8102e, roughness: 0.45, metalness: 0.2 });
  const ttcPanelMat = new THREE.MeshBasicNodeMaterial();
  ttcPanelMat.colorNode = mix(color(0xe9e4dc), color(0xfff4e0).mul(1.6), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const snapToCurbIsland = (x, z, pad = 1.1) => {
    if (isOnCurbIsland(x, z, pad)) return { x, z };
    for (let r = 2; r <= 14; r += 2) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r;
        const nz = z + Math.sin(ang) * r;
        if (isOnCurbIsland(nx, nz, pad)) return { x: nx, z: nz };
      }
    }
    return null;
  };
  const pylonMatrices = [];
  const pylonPanelMatrices = [];
  for (const e of FURNITURE.subway) {
    const at = snapToCurbIsland(e.x, e.z, 0.9);
    if (!at || !isClearOfPoles(at.x, at.z, 3)) continue;
    placedPoles.push(at);
    addFootprint(at.x, at.z, 0.6, 0.6);
    dummy.position.set(at.x, 0.22 + 1.45, at.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(0.42, 2.9, 0.42);
    dummy.updateMatrix();
    pylonMatrices.push(dummy.matrix.clone());
    dummy.position.set(at.x, 0.22 + 2.55, at.z);
    dummy.scale.set(0.46, 0.5, 0.46);
    dummy.updateMatrix();
    pylonPanelMatrices.push(dummy.matrix.clone());
    streetPointSites.push({ x: at.x, y: 2.9, z: at.z, color: 0xffe8d0, intensity: 12, dist: 7.5 });
  }
  addMatrixArrayInstanced(unitBox, ttcRedMat, pylonMatrices);
  addMatrixArrayInstanced(unitBox, ttcPanelMat, pylonPanelMatrices, false);

  // =========================================================================
  // 5. STREET MEAT: HOT DOG CARTS WITH UMBRELLAS (Nathan Phillips Square, Union Station, the ROM, Queen's Park...)
  // =========================================================================
  const cartSteelMat = new THREE.MeshStandardNodeMaterial({
    color: 0xd0d8e0,
    roughness: 0.25,
    metalness: 0.88
  });
  const umbrellaMat = new THREE.MeshStandardNodeMaterial({
    color: 0xd83a2a, // red & yellow striped vendor umbrella
    roughness: 0.6
  });

  const P = POINTS;
  const cartLocations = [
    [P.nathanPhillips.x + 40, P.nathanPhillips.z + 85], [P.nathanPhillips.x - 60, P.nathanPhillips.z + 85],
    [P.unionStation.x - 30, P.unionStation.z - 50], [P.dundasSquare.x + 25, P.dundasSquare.z - 10],
    [P.rom.x + 30, P.rom.z + 50], [P.queensPark.x + 20, P.queensPark.z + 150], [P.rogersCentre.x + 120, P.rogersCentre.z - 60],
    [P.stLawrenceMarket.x - 30, P.stLawrenceMarket.z - 45]
  ];

  const cartBoxMatrices = [];
  const umbrellaMatrices = [];
  for (const [ox, oz] of cartLocations) {
    const at = snapToCurbIsland(ox, oz, 1.1);
    if (!at) continue;
    const { x: cx, z: cz } = at;
    dummy.position.set(cx, 0.85, cz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1.5, 1.25, 2.2);
    dummy.updateMatrix();
    cartBoxMatrices.push(dummy.matrix.clone());

    dummy.position.set(cx, 2.55, cz);
    dummy.scale.set(1.7, 0.75, 1.7);
    dummy.updateMatrix();
    umbrellaMatrices.push(dummy.matrix.clone());
    streetPointSites.push({ x: cx, y: 2.15, z: cz, color: 0xffdf9e, intensity: 28, dist: 9.5 });
  }
  addMatrixArrayInstanced(unitBox, cartSteelMat, cartBoxMatrices);
  addMatrixArrayInstanced(new THREE.ConeGeometry(1, 1, 8), umbrellaMat, umbrellaMatrices);

  // =========================================================================
  // 6. FIRE HYDRANTS & CANADA POST RED STREET LETTER BOXES (at their real places, OpenStreetMap), INSTANCED
  // =========================================================================
  const hydrantPositions = [];
  const mailboxPositions = [];
  for (const [list, out] of [[FURNITURE.hydrants, hydrantPositions], [FURNITURE.postBoxes, mailboxPositions]]) {
    for (const p of list) {
      const at = isOnSidewalk(p.x, p.z, 0.45) ? p : snapToCurbIsland(p.x, p.z, 0.6);
      if (at && isOnSidewalk(at.x, at.z, 0.4)) out.push([at.x, at.z]);
    }
  }

  const hydrantMat = new THREE.MeshStandardNodeMaterial({ color: 0xb8241e, roughness: 0.5, metalness: 0.4 });
  const hydrantInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.26, 0.85, 8), hydrantMat, hydrantPositions.length);
  hydrantPositions.forEach(([hx, hz], i) => {
    dummy.position.set(hx, 0.64, hz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    hydrantInst.setMatrixAt(i, dummy.matrix);
  });
  hydrantInst.instanceMatrix.needsUpdate = true;
  group.add(hydrantInst);

  const canadaPostMat = new THREE.MeshStandardNodeMaterial({ color: 0xd2232a, roughness: 0.45, metalness: 0.35 });
  const mailboxInst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 1.25, 0.5), canadaPostMat, mailboxPositions.length);
  mailboxPositions.forEach(([mx, mz], i) => {
    dummy.position.set(mx, 0.84, mz);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    mailboxInst.setMatrixAt(i, dummy.matrix);
  });
  mailboxInst.instanceMatrix.needsUpdate = true;
  group.add(mailboxInst);

  // =========================================================================
  // 7. LUSH TREES: PARKS & PLAZAS, CENTRAL PARK WOODLANDS, AVENUE & CROSS-STREET TREES
  //    London planes, honey locusts & American elms (one unified trunk + crown instanced mesh per species & band)
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species (0 plane, 1 honey locust, 2 elm / oak) }
  const mixSpecies = (r, plane, locust) => (r < plane ? 0 : (r < plane + locust ? 1 : 2));


  // A. The parks & the harbourfront promenade (sites laid out by city-grid.js)
  for (const s of parkTreeSites || []) treePositions.push(s);

  // B. The real street trees (OpenStreetMap) standing on a sidewalk
  for (const t of FURNITURE.trees) {
    const b = blockAt(t.x, t.z);
    if (!b || b.park > 0.6 || b.rail > 0.5) continue;
    const r = hashPos(t.x, 1.7, t.z);
    treePositions.push({ x: t.x, y: b.median ? 0.22 : 0.22, z: t.z, scale: 0.62 + r * 0.3, species: r < 0.45 ? 2 : r < 0.75 ? 0 : 1 });
  }

  // C & D. Street trees on the raised sidewalks of every real block (city-config.js BLOCKS via the slabs city-grid.js
  //        laid): along the avenue fronts (w / e edges) and, in the residential neighbourhoods, both curbs of the side
  //        streets (n / s edges) — honey locusts on the narrow streets, planes, locusts & elms on the wider ones, with
  //        random missing trees & the odd unplanted block. Never in plazas or parks.
  const sidewalkTreePositions = [];
  const SIDEWALK_Y = 0.22;
  const swBlocks = sidewalkBlocks || [];
  const onSidewalk = (x, z) => {
    const b = blockAt(x, z);
    return !!b && !(b.park > 0.6) && !b.median;
  };
  // Street trees turn in 90° steps with the crown squeezed across the sidewalk, away from the facades
  function addStreetTree(x, z, scale, species, acrossX, extra = {}) {
    if (!onSidewalk(x, z) || inPlaza(x, z, 1.5) || !isClearOfPoles(x, z, 2.2)) return;
    const q = Math.floor(hashPos(x, 8.8, z) * 3.999);
    const t = { x, y: SIDEWALK_Y, z, scale, species, yaw: q * Math.PI * 0.5, tier: acrossX ? 1 : 2, ...extra };
    if (acrossX === (q % 2 === 0)) t.sx = extra.squeeze || 0.82;
    else t.sz = extra.squeeze || 0.82;
    treePositions.push(t);
    sidewalkTreePositions.push(t);
  }
  const RESIDENTIAL = new Set(['annex', 'harbord', 'cabbagetown', 'church_wellesley', 'st_james_town', 'regent_park', 'corktown', 'kensington',
    'alexandra_park', 'queen_west', 'moss_park', 'garden_district', 'west_don_lands', 'yorkville', 'uoft', 'st_lawrence', 'fort_york',
    'cityplace', 'distillery']);
  const COMMERCIAL = new Set(['financial', 'south_core', 'entertainment', 'yonge_dundas', 'bay_street', 'discovery', 'old_town']);
  const AVE_SP = 17;
  const CROSS_SP = 14;
  for (const s of swBlocks) {
    const b = s.block;
    if (!b || b.median || b.park > 0.6) continue;
    const res = RESIDENTIAL.has(b.district);
    const x0 = s.cx - s.w * 0.5;
    const x1 = s.cx + s.w * 0.5;
    const z0 = s.cz - s.d * 0.5;
    const z1 = s.cz + s.d * 0.5;
    // C. avenue fronts (the slab's short w / e edges on a grid block)
    if (s.d >= 20) {
      const thin = COMMERCIAL.has(b.district) ? 0.55 : 0.3;
      for (const [x, side] of [[x0 + 1.3, -1], [x1 - 1.3, 1]]) {
        const n = Math.floor((s.d - 10) / AVE_SP) + 1;
        const zs = z0 + (s.d - (n - 1) * AVE_SP) * 0.5;
        for (let i = 0; i < n; i++) {
          const tz = zs + i * AVE_SP;
          if (hashPos(x, 3.1, tz) < thin) continue;
          addStreetTree(x, tz, 0.66 + hashPos(tz, 3.1, x) * 0.14, mixSpecies(hashPos(x, side, tz), 0.4, 0.35), true);
        }
      }
    }
    // D. side-street curbs (residential neighbourhoods)
    if (!res || s.w < 24 || hashPos(s.cx, 4.2, s.cz) < 0.22) continue;
    for (const side of [-1, 1]) {
      const edge = side < 0 ? z0 : z1;
      const narrow = !!blockAt(s.cx, edge + side * 14); // a block across within ~14 m: a narrow side street
      const z = edge - side * (narrow ? 0.9 : 1.25);
      const n = Math.floor((s.w - 7) / CROSS_SP) + 1;
      const xs = s.cx - ((n - 1) * CROSS_SP) * 0.5;
      for (let i = 0; i < n; i++) {
        const x = xs + i * CROSS_SP + (hashPos(i, s.cz, side) - 0.5) * 1.6;
        const r = hashPos(x, 6.1, z);
        if (r < 0.32) continue;
        const species = narrow ? 1 : mixSpecies(hashPos(z, 2.9, x), 0.4, 0.35);
        const scale = narrow ? 0.54 + r * 0.1 : 0.6 + r * 0.24;
        addStreetTree(x, z, scale, species, false, { pitRot: Math.PI / 2, grate: false, pitS: narrow ? 0.7 : 1, squeeze: narrow ? 0.7 : 0.82 });
      }
    }
  }
  console.info(`[streetDetails] ${treePositions.length} trees (${sidewalkTreePositions.length} street trees)`);

  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x484642, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });

  // Curbside tree pit surrounds & dark soil beds, with concentric cast-iron grates on the Midtown avenues
  // (pits run along the curb: t.pitRot = PI/2 on cross streets)
  const pitCurbGeo = new THREE.BoxGeometry(1.7, 0.22, 2.6);
  const pitSoilGeo = new THREE.BoxGeometry(1.35, 0.23, 2.25);
  const pitGrateGeo = new THREE.RingGeometry(0.24, 0.82, 12, 1).rotateX(-Math.PI / 2);
  const gratedTrees = sidewalkTreePositions.filter((t) => t.grate !== false);

  const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, sidewalkTreePositions.length);
  const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, sidewalkTreePositions.length);
  const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, Math.max(1, gratedTrees.length));
  pitCurbInst.receiveShadow = true;
  pitSoilInst.receiveShadow = true;
  pitGrateInst.receiveShadow = true;
  pitGrateInst.count = gratedTrees.length;

  sidewalkTreePositions.forEach((t, i) => {
    dummy.rotation.set(0, t.pitRot || 0, 0);
    dummy.scale.set(t.pitS || 1, 1, 1);
    dummy.position.set(t.x, 0.19, t.z);
    dummy.updateMatrix();
    pitCurbInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(t.x, 0.20, t.z);
    dummy.updateMatrix();
    pitSoilInst.setMatrixAt(i, dummy.matrix);
  });
  gratedTrees.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, 0.225, t.z);
    dummy.updateMatrix();
    pitGrateInst.setMatrixAt(i, dummy.matrix);
  });
  pitCurbInst.instanceMatrix.needsUpdate = true;
  pitSoilInst.instanceMatrix.needsUpdate = true;
  pitGrateInst.instanceMatrix.needsUpdate = true;
  for (const pit of [pitCurbInst, pitSoilInst, pitGrateInst]) pit.computeBoundingSphere();
  group.add(pitCurbInst, pitSoilInst, pitGrateInst);

  function hashPos(x, y, z) {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // Procedural trees (js/trees.js): species skeletons with leaf-spray cards, one instanced mesh per species, variant &
  // level of detail, each tree's level following the camera
  const treeField = createTreeField(scene, treePositions);
  group.add(treeField.group);

  // =========================================================================
  // 8. CLUSTERED STREETLIGHTS & STREET FURNITURE LIGHT POOLS
  // =========================================================================
  for (const s of parkLampSites || []) {
    streetPointSites.push({ x: s.x, y: s.y, z: s.z, color: 0xffe4b4, intensity: 32, dist: 14.0 });
  }

  const STREETLIGHT_SPOT_POOL = 36;
  const STREET_POINT_POOL = 48;
  const STREETLIGHT_DIST = 115;
  const STREETLIGHT_DIST_SQ = STREETLIGHT_DIST * STREETLIGHT_DIST;
  const STREET_POINT_DIST = 110;
  const STREET_POINT_DIST_SQ = STREET_POINT_DIST * STREET_POINT_DIST;

  const streetLightsGroup = new THREE.Group();
  streetLightsGroup.name = 'StreetClusteredLights';
  scene.add(streetLightsGroup);

  const streetlightSpotPool = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // Cobra-head LED luminaire: wide downward spread (0.96 rad half-angle) illuminating both road and sidewalk
    const spot = new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    streetLightsGroup.add(spot, spot.target);
    streetlightSpotPool.push(spot);
  }

  const streetPointPool = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const pt = new THREE.PointLight(0xffe4b4, 0, 12, 1.35);
    pt.position.set(0, -1000, 0);
    streetLightsGroup.add(pt);
    streetPointPool.push(pt);
  }

  const activeCobras = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function update(camera) {
    if (!camera) return;
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // Streetlights fade in smoothly as dusk approaches (matching lampBulbGlow smoothstep(0.4, 1.1, uInteriorGlow))
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < STREET_POINT_POOL; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8];
    const fwdZ = -me[10];

    let cobraCount = 0;
    for (let i = 0; i < cobraLampSites.length; i++) {
      const s = cobraLampSites[i];
      const dx = s.x - cx;
      const dz = s.z - cz;
      const d2 = dx * dx + dz * dz + cy * cy;
      if (d2 > STREETLIGHT_DIST_SQ) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STREETLIGHT_DIST) continue;
      s._effDist = effDist;
      activeCobras[cobraCount++] = s;
    }
    activeCobras.length = cobraCount;
    if (cobraCount > 1) activeCobras.sort((a, b) => a._effDist - b._effDist);

    const cobraCutoff = cobraCount > STREETLIGHT_SPOT_POOL
      ? Math.min(STREETLIGHT_DIST, activeCobras[STREETLIGHT_SPOT_POOL]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(cobraCount, STREETLIGHT_SPOT_POOL);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeCobras[i];
      const fade = smoothFade(s._effDist, cobraCutoff * 0.62, cobraCutoff);
      const spot = streetlightSpotPool[i];
      spot.position.set(s.x, s.y, s.z);
      spot.target.position.set(s.tx, 0.0, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < STREETLIGHT_SPOT_POOL; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    let ptCount = 0;
    for (let i = 0; i < streetPointSites.length; i++) {
      const s = streetPointSites[i];
      const dx = s.x - cx;
      const dz = s.z - cz;
      const d2 = dx * dx + dz * dz + cy * cy;
      if (d2 > STREET_POINT_DIST_SQ) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STREET_POINT_DIST) continue;
      s._effDist = effDist;
      activePoints[ptCount++] = s;
    }
    activePoints.length = ptCount;
    if (ptCount > 1) activePoints.sort((a, b) => a._effDist - b._effDist);

    const ptCutoff = ptCount > STREET_POINT_POOL
      ? Math.min(STREET_POINT_DIST, activePoints[STREET_POINT_POOL]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, STREET_POINT_POOL);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      pt.position.set(s.x, s.y, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < STREET_POINT_POOL; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  return { group, footprints, signalClock, audioSignals, update };
}

export { buildStreetDetails };
