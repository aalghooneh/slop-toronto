import * as THREE from 'three/webgpu';
import { color, mix, step, smoothstep, positionGeometry, normalGeometry, float } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAILS, FURNITURE, DETAIL, blockAt, signalPhase } from './city-config.js';
import { cityUniforms } from './tsl-materials.js';

// js/streetcars.js
// The TTC's streetcars on the real network (OpenStreetMap's tram tracks): King, Queen, Dundas, College, Spadina,
// Bathurst, Queens Quay & Cherry St.
// - Tracks: every main track's ways chained into continuous lines, going straight on through the junctions; each line
//   is run in the direction right-hand traffic uses it (the side of the street it lies on). The rails are set into the
//   road (on the raised right-of-way of Spadina & Queens Quay), the overhead contact wire hangs above them.
// - Cars: 30 m, five-section Flexity Outlook streetcars in TTC red, articulated along the curves. They dwell at the
//   real stops, wait at red lights, queue behind the traffic (traffic.js) and the player, and shove the player aside on
//   contact; traffic.js in turn keeps behind them (setObstacles).

const GAUGE = 1.495; // TTC broad gauge (4 ft 10 7/8 in)
const SECTIONS = [6.6, 5.7, 5.4, 5.7, 6.6]; // module lengths, nose to tail (30.2 m with the gangways)
const GANGWAY = 0.55;
const CAR_LEN = SECTIONS.reduce((t, l) => t + l, 0) + GANGWAY * (SECTIONS.length - 1);
const HALF_W = 1.27;
const HEIGHT = 3.84;
const MAX_SPEED = 13; // m/s (~47 km/h, downtown)
const ACCEL = 1.1;
const DECEL = 1.4;
const DWELL = 9;
const WIRE_Y = 5.6;
const PAD = 260; // tracks run on this far beyond the detailed downtown

// ---------------------------------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------------------------------
function buildTracks() {
  const ways = RAILS.filter((r) => r.kind === 'tram' && (!r.service || /Loop/.test(r.name))).map((r) => r.pts.map((p) => ({ x: p.x, z: p.z })));
  const key = (p) => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
  const ends = new Map();
  const addEnd = (k, w, atStart) => {
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push({ w, atStart });
  };
  ways.forEach((w, i) => {
    addEnd(key(w[0]), i, true);
    addEnd(key(w[w.length - 1]), i, false);
  });
  const used = new Set();
  const dir = (a, b) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return [(b.x - a.x) / L, (b.z - a.z) / L];
  };
  // carry on from the chain's end into the way going most nearly straight on (within 60°)
  function extend(chain) {
    for (;;) {
      const last = chain[chain.length - 1];
      const d = dir(chain[chain.length - 2], last);
      let best = null;
      let bd = 0.5;
      for (const c of ends.get(key(last)) || []) {
        if (used.has(c.w)) continue;
        const pts = c.atStart ? ways[c.w] : ways[c.w].slice().reverse();
        const nd = dir(pts[0], pts[1]);
        const dot = d[0] * nd[0] + d[1] * nd[1];
        if (dot > bd) {
          bd = dot;
          best = { c, pts };
        }
      }
      if (!best) return;
      used.add(best.c.w);
      chain.push(...best.pts.slice(1));
    }
  }
  const order = ways.map((w, i) => i).sort((a, b) => ways[b].length - ways[a].length);
  const chains = [];
  for (const i of order) {
    if (used.has(i) || ways[i].length < 2) continue;
    used.add(i);
    const chain = ways[i].slice();
    extend(chain);
    chain.reverse();
    extend(chain);
    chain.reverse();
    chains.push(chain);
  }
  // keep the runs within reach of downtown
  const inside = (p) => p.x > DETAIL.x0 - PAD && p.x < DETAIL.x1 + PAD && p.z > DETAIL.z0 - PAD && p.z < DETAIL.z1 + PAD;
  const runs = [];
  for (const c of chains) {
    let cur = [];
    for (const p of c) {
      if (inside(p)) cur.push(p);
      else {
        if (cur.length > 1) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) runs.push(cur);
  }
  const tracks = [];
  for (const pts of runs) {
    const t = makeTrack(pts);
    if (t.len > 150) tracks.push(t);
  }
  return tracks;
}

// A polyline resampled every ~2 m with arc lengths, for fast position & heading lookups
function makeTrack(src) {
  const pts = [src[0]];
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1];
    const b = src[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 2));
    for (let k = 1; k <= n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1], stops: [], signals: [] };
}
function sample(track, s, out) {
  const { pts, cum } = track;
  s = Math.max(0, Math.min(track.len, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.yaw = Math.atan2(b.x - a.x, b.z - a.z);
  return out;
}
// Arc length of the point of the track nearest (x, z), and the distance to it
function project(track, x, z) {
  let best = Infinity;
  let bs = 0;
  const { pts, cum } = track;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
    if (d < best) {
      best = d;
      bs = cum[i];
    }
  }
  return { s: bs, d: Math.sqrt(best) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rails & overhead wire
// ---------------------------------------------------------------------------------------------------------------------
function buildTrackwork(group, tracks) {
  const rail = [];
  const wire = [];
  const quad = (ax, ay, az, bx, by, bz, half) => {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const nx = (-(bz - az) / L) * half;
    const nz = ((bx - ax) / L) * half;
    rail.push(ax - nx, ay, az - nz, bx - nx, by, bz - nz, bx + nx, by, bz + nz, ax - nx, ay, az - nz, bx + nx, by, bz + nz, ax + nx, ay, az + nz);
  };
  // the track's height: on the road, or on a raised right-of-way / median (a curb island)
  const yAt = (x, z) => (blockAt(x, z) ? 0.236 : 0.014);
  for (const t of tracks) {
    const P = t.pts;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i];
      const b = P[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const rx = -(b.z - a.z) / L;
      const rz = (b.x - a.x) / L;
      const ya = yAt(a.x, a.z);
      const yb = yAt(b.x, b.z);
      for (const o of [-GAUGE / 2, GAUGE / 2]) quad(a.x + rx * o, ya, a.z + rz * o, b.x + rx * o, yb, b.z + rz * o, 0.05);
      if (i % 4 === 0) {
        const c = P[Math.min(P.length - 1, i + 4)];
        wire.push(a.x, WIRE_Y, a.z, c.x, WIRE_Y, c.z);
      }
    }
  }
  const railGeo = new THREE.BufferGeometry();
  railGeo.setAttribute('position', new THREE.Float32BufferAttribute(rail, 3));
  railGeo.computeVertexNormals();
  const railMesh = new THREE.Mesh(railGeo, new THREE.MeshStandardNodeMaterial({ color: 0x9a9690, roughness: 0.3, metalness: 0.85 }));
  railMesh.receiveShadow = true;
  railMesh.name = 'StreetcarRails';
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
  const wireMesh = new THREE.LineSegments(wireGeo, new THREE.LineBasicNodeMaterial({ color: 0x1a1a1a }));
  wireMesh.name = 'StreetcarWire';
  group.add(railMesh, wireMesh);
}

// ---------------------------------------------------------------------------------------------------------------------
// The Flexity Outlook: five modules (the end ones with the raked cab), TTC red with the black window band
// ---------------------------------------------------------------------------------------------------------------------
function moduleGeometry(len, nose) {
  const g = new THREE.BoxGeometry(HALF_W * 2, HEIGHT - 0.32, len, 1, 4, 4).translate(0, 0.32 + (HEIGHT - 0.32) / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i);
    const y = p.getY(i);
    let z = p.getZ(i);
    // rounded roof edges
    if (y > HEIGHT - 0.05) x *= 0.86;
    if (nose && z > len / 2 - 0.01) {
      // the cab: a raked windscreen and a rounded nose in plan
      const k = Math.max(0, (y - 1.0) / (HEIGHT - 1.0));
      z -= k * k * 1.05;
      x *= 1 - 0.12 * Math.min(1, Math.max(0, (y - 0.3) / 3.5));
    }
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}
function createStreetcarMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0.25 });
  const y = positionGeometry.y;
  const roof = step(0.6, normalGeometry.y);
  const front = step(0.55, normalGeometry.z); // the cab's end (the gangways hide the inner modules' ends)
  const band = smoothstep(1.02, 1.06, y).mul(float(1.0).sub(smoothstep(2.86, 2.9, y)));
  const whiteLine = smoothstep(0.92, 0.94, y).mul(float(1.0).sub(smoothstep(0.98, 1.0, y)));
  let col = mix(color(0xd2242b), color(0x101215), band);
  col = mix(col, color(0xf2f2ee), whiteLine);
  col = mix(col, color(0xc9cbcc), roof);
  col = mix(col, color(0x0d0f12), front.mul(smoothstep(1.2, 1.3, y)).mul(float(1.0).sub(roof)));
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.38), float(0.08), band);
  mat.metalnessNode = mix(float(0.25), float(0.7), band);
  // lit saloon after dusk, headlamps
  const night = smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow);
  const head = smoothstep(0.55, 0.6, y).mul(float(1.0).sub(smoothstep(0.75, 0.8, y))).mul(front);
  mat.emissiveNode = color(0xffe2b0).mul(band.mul(float(1.0).sub(front)).mul(0.55).add(head.mul(2.5))).mul(night);
  return mat;
}

function createStreetcars(scene, trafficSystem) {
  const group = new THREE.Group();
  group.name = 'Streetcars';
  const tracks = buildTracks();
  buildTrackwork(group, tracks);

  // Direction of travel on each track: the real stops along it face its way (a stop stands to the right of the track
  // in the direction of travel); where a track has none, the right-hand side of the street decides (the track lies
  // right of the street's middle)
  const tmp = { x: 0, z: 0, yaw: 0 };
  const stops = FURNITURE.stops.filter((s) => s.streetcar);
  for (const t of tracks) {
    let vote = 0;
    for (const st of stops) {
      const { s, d } = project(t, st.x, st.z);
      if (d > 14) continue;
      sample(t, s, tmp);
      const right = (st.x - tmp.x) * -Math.cos(tmp.yaw) + (st.z - tmp.z) * Math.sin(tmp.yaw);
      vote += right > 0 ? 1 : -1;
    }
    if (vote < 0) {
      t.pts.reverse();
      t.cum = t.cum.map((c) => t.len - c).reverse();
    }
    // stops on its right, within 14 m: dwell positions
    for (const st of stops) {
      const { s, d } = project(t, st.x, st.z);
      if (d > 14 || s < 20 || s > t.len - 10) continue;
      sample(t, s, tmp);
      const right = (st.x - tmp.x) * -Math.cos(tmp.yaw) + (st.z - tmp.z) * Math.sin(tmp.yaw);
      if (right > 0 && !t.stops.some((q) => Math.abs(q - s) < 40)) t.stops.push(s);
    }
    t.stops.sort((a, b) => a - b);
  }
  // Signals along each track: the junctions of the road network with a signal the track passes through, the major road
  // phase (group 0) or the cross road's by the road the track runs along there
  const net = trafficSystem && trafficSystem.network;
  if (net) {
    for (const t of tracks) {
      for (const n of net.nodes) {
        if (!n.signal) continue;
        const { s, d } = project(t, n.x, n.z);
        if (d > 9 || s < 15) continue;
        sample(t, s, tmp);
        const fx = Math.sin(tmp.yaw);
        const fz = Math.cos(tmp.yaw);
        let major = true;
        let best = 0.8;
        for (const e of n.in || []) {
          const dot = e.dx * fx + e.dz * fz;
          if (dot > best) {
            best = dot;
            major = e.axisIndex === 0;
          }
        }
        t.signals.push({ s, major, half: Math.max(6, (n.hx || 7) + 3) });
      }
      t.signals.sort((a, b) => a.s - b.s);
    }
  }

  // The fleet: one car per ~420 m of track, spread out along it
  const cars = [];
  for (const t of tracks) {
    const n = Math.max(1, Math.round(t.len / 420));
    for (let k = 0; k < n; k++) {
      cars.push({ track: t, s: ((k + 0.5) / n) * t.len, speed: MAX_SPEED * 0.6, dwell: 0, lastStop: -1, sections: SECTIONS.map(() => ({ x: 0, z: 0, yaw: 0 })) });
    }
  }

  const mat = createStreetcarMaterial();
  const noseGeo = moduleGeometry(SECTIONS[0], true);
  const midGeos = SECTIONS.map((l) => moduleGeometry(l, false));
  const gangwayGeo = new THREE.BoxGeometry(HALF_W * 1.9, HEIGHT - 0.6, GANGWAY + 0.2).translate(0, 0.4 + (HEIGHT - 0.6) / 2, 0);
  const pantoGeo = mergeGeometries([
    new THREE.BoxGeometry(1.4, 0.25, 1.6).translate(0, 0.12, 0),
    new THREE.BoxGeometry(0.06, 1.3, 0.06).rotateX(0.5).translate(0, 0.85, 0.3),
    new THREE.BoxGeometry(1.5, 0.05, 0.08).translate(0, 1.5, 0.62)
  ].map((g) => g.toNonIndexed()));
  const count = cars.length;
  const nose = new THREE.InstancedMesh(noseGeo, mat, count * 2);
  const mids = midGeos.map((g) => new THREE.InstancedMesh(g, mat, count)).slice(1, 4);
  const gangways = new THREE.InstancedMesh(gangwayGeo, new THREE.MeshStandardNodeMaterial({ color: 0x1b1c1e, roughness: 0.9 }), count * 4);
  const pantos = new THREE.InstancedMesh(pantoGeo, new THREE.MeshStandardNodeMaterial({ color: 0x2a2b2d, roughness: 0.5, metalness: 0.6 }), count);
  for (const m of [nose, ...mids, gangways, pantos]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
  }
  scene.add(group);

  // Obstacles handed to traffic.js: one box per module of every car near the camera
  const obstacles = [];
  const dummy = new THREE.Object3D();

  function phaseAhead(car, elapsed) {
    const t = car.track;
    for (const sg of t.signals) {
      const d = sg.s - sg.half - car.s;
      if (d < -1 || d > 60) continue;
      const ph = signalPhase(elapsed, sg.major);
      if (ph === 'red' || (ph === 'amber' && d > 12)) return d;
    }
    return Infinity;
  }
  // Distance to the nearest thing standing in the way within `reach` m ahead of the nose: traffic, the player
  function blockedAhead(car, reach, others, playerEnt) {
    const t = car.track;
    sample(t, car.s, tmp);
    let best = Infinity;
    const fx = Math.sin(tmp.yaw);
    const fz = Math.cos(tmp.yaw);
    const test = (x, z, half, halfW) => {
      const dx = x - tmp.x;
      const dz = z - tmp.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < -1 || ahead > reach + half) return;
      const side = Math.abs(dz * fx - dx * fz);
      if (side > HALF_W + halfW + 0.35) return;
      best = Math.min(best, ahead - half);
    };
    for (const v of others) if (v.placed) test(v.x, v.z, v.half || 2.3, v.halfWidth || 0.9);
    for (const o of cars) {
      if (o === car || o.track !== t) continue;
      const tail = o.s - CAR_LEN;
      const d = tail - car.s;
      if (d > -1 && d < reach) best = Math.min(best, d);
    }
    if (playerEnt) test(playerEnt.position.x, playerEnt.position.z, 2.3, 1.0);
    return best;
  }

  function update(dt, elapsed, camera, playerEnt, activeMode) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    const others = trafficSystem ? [...(trafficSystem.cars || []), ...(trafficSystem.buses || [])] : [];
    const ground = playerEnt && activeMode !== 'helicopter' && playerEnt.position.y < 2.6 ? playerEnt : null;
    const camX = camera ? camera.position.x : 0;
    const camZ = camera ? camera.position.z : 0;
    obstacles.length = 0;
    let iNose = 0;
    let iGang = 0;
    cars.forEach((car, ci) => {
      const t = car.track;
      // where the car must stop: a stop to dwell at, a red light, whatever stands ahead
      let target = MAX_SPEED;
      let stopD = Infinity;
      if (car.dwell > 0) {
        car.dwell -= dt;
        target = 0;
      } else {
        const next = t.stops.find((q) => q > car.s - 0.5 && q !== car.lastStop);
        if (next !== undefined) {
          const d = next - car.s;
          if (d < 0.6 && car.speed < 1.0) {
            car.dwell = DWELL;
            car.lastStop = next;
            car.speed = 0;
          } else stopD = Math.min(stopD, d);
        }
        stopD = Math.min(stopD, phaseAhead(car, elapsed));
        const near = Math.abs(sample(t, car.s, tmp).x - camX) < 500 && Math.abs(tmp.z - camZ) < 500;
        if (near) stopD = Math.min(stopD, blockedAhead(car, 40, others, ground) - 4);
      }
      if (stopD < Infinity) target = Math.min(target, Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, stopD))));
      if (car.speed < target) car.speed = Math.min(target, car.speed + ACCEL * dt);
      else car.speed = Math.max(target, car.speed - (stopD < 3 ? DECEL * 3 : DECEL * 1.6) * dt);
      car.s += car.speed * dt;
      if (car.s > t.len) {
        // off the end of the run: back in at its start
        car.s = CAR_LEN;
        car.lastStop = -1;
      }
      // the modules follow the track behind the nose
      let back = car.s;
      for (let k = 0; k < SECTIONS.length; k++) {
        const L = SECTIONS[k];
        const sec = car.sections[k];
        const sa = back;
        const sb = back - L;
        sample(t, sa, tmp);
        const ax = tmp.x, az = tmp.z;
        sample(t, Math.max(0, sb), tmp);
        sec.x = (ax + tmp.x) / 2;
        sec.z = (az + tmp.z) / 2;
        sec.yaw = Math.atan2(ax - tmp.x, az - tmp.z);
        sec.y = blockAt(sec.x, sec.z) ? 0.22 : 0;
        back = sb - GANGWAY;
      }
      // draw: the cab modules (the tail one turned round), the inner ones, the gangways, the pantograph mid-roof
      car.sections.forEach((sec, k) => {
        dummy.position.set(sec.x, sec.y, sec.z);
        dummy.rotation.set(0, sec.yaw + (k === SECTIONS.length - 1 ? Math.PI : 0), 0);
        dummy.updateMatrix();
        if (k === 0 || k === SECTIONS.length - 1) nose.setMatrixAt(iNose++, dummy.matrix);
        else mids[k - 1].setMatrixAt(ci, dummy.matrix);
        if (k === 2) {
          dummy.position.y = sec.y + HEIGHT;
          dummy.updateMatrix();
          pantos.setMatrixAt(ci, dummy.matrix);
        }
        if (k < SECTIONS.length - 1) {
          const nx = car.sections[k + 1];
          dummy.position.set((sec.x + nx.x) / 2, sec.y, (sec.z + nx.z) / 2);
          dummy.rotation.set(0, (sec.yaw + nx.yaw) / 2, 0);
          dummy.updateMatrix();
          gangways.setMatrixAt(iGang++, dummy.matrix);
        }
      });
      // obstacles for the traffic & contact with the player
      const nearCam = Math.abs(car.sections[2].x - camX) < 450 && Math.abs(car.sections[2].z - camZ) < 450;
      if (nearCam) {
        car.sections.forEach((sec, k) => obstacles.push({ x: sec.x, z: sec.z, yaw: sec.yaw, halfW: HALF_W, halfL: SECTIONS[k] / 2 + GANGWAY / 2, speed: car.speed }));
      }
      if (ground && nearCam) {
        const r = activeMode === 'car' ? 1.6 : activeMode === 'cyclist' ? 0.8 : 0.45;
        for (let k = 0; k < SECTIONS.length; k++) {
          const sec = car.sections[k];
          const dx = ground.position.x - sec.x;
          const dz = ground.position.z - sec.z;
          const c = Math.cos(sec.yaw), sn = Math.sin(sec.yaw);
          const lx = dx * c - dz * sn; // across
          const lz = dx * sn + dz * c; // along
          const px = HALF_W + r - Math.abs(lx);
          const pz = SECTIONS[k] / 2 + r - Math.abs(lz);
          if (px <= 0 || pz <= 0) continue;
          // push the player out along the shallower axis
          if (px < pz) {
            const s = Math.sign(lx) || 1;
            ground.position.x += c * px * s;
            ground.position.z -= sn * px * s;
          } else {
            const s = Math.sign(lz) || 1;
            ground.position.x += sn * pz * s;
            ground.position.z += c * pz * s;
          }
          if (ground.speed) ground.speed *= 0.3;
        }
      }
    });
    nose.count = iNose;
    for (const m of mids) m.count = cars.length;
    gangways.count = iGang;
    pantos.count = cars.length;
    for (const m of [nose, ...mids, gangways, pantos]) m.instanceMatrix.needsUpdate = true;
    if (trafficSystem && trafficSystem.setObstacles) trafficSystem.setObstacles(obstacles);
  }

  console.info(`[streetcars] ${tracks.length} track runs, ${Math.round(tracks.reduce((t, k) => t + k.len, 0) / 1000)} km, ${cars.length} streetcars, ${tracks.reduce((t, k) => t + k.stops.length, 0)} stops, ${tracks.reduce((t, k) => t + k.signals.length, 0)} signals`);
  return { group, update, cars, tracks };
}

export { createStreetcars };
