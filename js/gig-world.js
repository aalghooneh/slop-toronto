import * as THREE from 'three/webgpu';
import { mrt, vec4, uv, time, uniform, float, fract, abs, smoothstep, pow, max, sin, length } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { blockAt, CITY_BOUNDS } from './city-config.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';

// js/gig-world.js
// What Toronto Hustle (gigs.js) looks like in the city: pillars of light over the kerbs where work is waiting and
// where it is going, a line of chevrons running along the road to get there, rings in the sky for the helicopter's
// tours, the customers themselves (waiting, getting in, walking off), and the raccoons at their green bins.

const COLORS = {
  fare: 0xffc21a, // taxi yellow
  delivery: 0xff7a3d,
  tour: 0x3fd8ff,
  dropoff: 0x4dffa0
};
// Effects drawn over the scene leave its normals & reflectivity as they were (the reflections, the ambient occlusion
// and the snow cover in post-processing.js keep seeing what is underneath)
const KEEP_SURFACE = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
const PILLAR_HEIGHT = 90;
const RIBBON_AHEAD = 240; // metres of the route drawn on the road ahead
const RIBBON_POINTS = 160;
const RIBBON_WIDTH = 2.0;
const RIBBON_Y = 0.07;

const personGround = (_owner, x, z) => (blockAt(x, z) ? CITY_BOUNDS.sidewalkHeight : 0);

function glowMaterial(colorUniform, opacityNode, strength = 1.6) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  mat.colorNode = colorUniform.mul(strength);
  mat.opacityNode = opacityNode;
  mat.mrtNode = KEEP_SURFACE;
  return mat;
}

// A pillar of light over a kerb with a pulsing ring on the road and a gem turning above it
class Beacon {
  constructor(parent) {
    this.color = uniform(new THREE.Color(COLORS.fare));
    this.group = new THREE.Group();
    this.group.position.y = -500; // (drawn once below ground so its shaders compile behind the loading screen)

    // A slim shaft of light up into the sky, with slow bands of light climbing it
    const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
    const up = uv().y;
    const bands = sin(up.mul(70).sub(time.mul(2.4))).mul(0.5).add(0.5);
    const pillarOpacity = pow(float(1).sub(up), 1.7).mul(float(0.3).add(bands.mul(0.2)));
    this.pillar = new THREE.Mesh(pillarGeo, glowMaterial(this.color, pillarOpacity, 1.7));
    this.pillar.renderOrder = 5;

    // and a low curtain of light around the stopping zone
    const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 56, 1, true).translate(0, 0.5, 0);
    const wallOpacity = pow(float(1).sub(uv().y), 2.2).mul(0.3);
    this.wall = new THREE.Mesh(wallGeo, glowMaterial(this.color, wallOpacity, 1.5));
    this.wall.renderOrder = 5;

    const ringGeo = new THREE.RingGeometry(0.84, 1, 56).rotateX(-Math.PI * 0.5);
    const pulse = sin(time.mul(4.2)).mul(0.25).add(0.75);
    this.ring = new THREE.Mesh(ringGeo, glowMaterial(this.color, pulse, 1.8));
    this.ring.position.y = 0.06;
    this.ring.renderOrder = 4;

    const padGeo = new THREE.CircleGeometry(0.84, 40).rotateX(-Math.PI * 0.5);
    const r = length(uv().sub(0.5)).mul(2);
    this.pad = new THREE.Mesh(padGeo, glowMaterial(this.color, r.mul(r).mul(0.2).add(0.03), 1.2));
    this.pad.position.y = 0.05;
    this.pad.renderOrder = 4;

    const gemMat = new THREE.MeshBasicNodeMaterial({ fog: false });
    gemMat.colorNode = this.color.mul(2.2);
    this.gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), gemMat);
    this.gem.scale.set(1, 1.5, 1);

    this.group.add(this.pillar, this.wall, this.ring, this.pad, this.gem);
    for (const m of this.group.children) m.frustumCulled = false;
    parent.add(this.group);
  }

  place(x, y, z, radius, colorHex, elapsed, height = PILLAR_HEIGHT) {
    this.group.visible = true;
    this.group.position.set(x, y, z);
    this.color.value.setHex(colorHex);
    this.pillar.scale.set(0.9, height, 0.9);
    this.wall.scale.set(radius, 2.6, radius);
    this.ring.scale.setScalar(radius);
    this.pad.scale.setScalar(radius);
    this.gem.position.y = 5.2 + Math.sin(elapsed * 2.4) * 0.35;
    this.gem.rotation.y = elapsed * 1.8;
  }

  hide() {
    this.group.visible = false;
  }
}

// A hoop in the sky for the helicopter to fly through
class SkyRing {
  constructor(parent) {
    this.color = uniform(new THREE.Color(COLORS.tour));
    this.fade = uniform(1);
    this.group = new THREE.Group();
    this.group.position.y = -500; // (drawn once below ground so its shaders compile behind the loading screen)
    const hoopMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    hoopMat.colorNode = this.color.mul(2.4);
    hoopMat.opacityNode = this.fade;
    this.hoop = new THREE.Mesh(new THREE.TorusGeometry(1, 0.045, 10, 72), hoopMat);
    // a faint film across it, brightest at the rim, sweeping inwards
    const r = length(uv().sub(0.5)).mul(2);
    const sweep = fract(r.mul(3).add(time.mul(0.7)));
    const film = smoothstep(0.3, 1.0, r).mul(0.2).add(smoothstep(0.85, 1.0, sweep).mul(0.1)).mul(this.fade);
    this.film = new THREE.Mesh(new THREE.CircleGeometry(1, 56), glowMaterial(this.color, film, 1.4));
    this.group.add(this.hoop, this.film);
    for (const m of this.group.children) m.frustumCulled = false;
    parent.add(this.group);
  }

  place(ring, radius, colorHex, fade, elapsed) {
    this.group.visible = true;
    this.group.position.set(ring.x, ring.y, ring.z);
    this.group.rotation.y = ring.yaw;
    this.group.scale.setScalar(radius * (1 + Math.sin(elapsed * 3) * 0.02));
    this.color.value.setHex(colorHex);
    this.fade.value = fade;
  }

  hide() {
    this.group.visible = false;
  }
}

// The way there, laid on the road: a ribbon of chevrons running ahead of the player along the route
class GuideRibbon {
  constructor(parent) {
    this.color = uniform(new THREE.Color(COLORS.fare));
    this.start = uniform(0); // metres along the route where the ribbon begins (the player) and ends
    this.end = uniform(1);
    const n = RIBBON_POINTS;
    this.positions = new Float32Array(n * 2 * 3);
    this.uvs = new Float32Array(n * 2 * 2);
    const index = [];
    for (let i = 0; i + 1 < n; i++) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = this.geometry = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geo.setIndex(index);
    geo.setDrawRange(0, 0);

    const along = uv().y; // metres from the start of the route
    const across = abs(uv().x.sub(0.5)).mul(2); // 0 on the centre line .. 1 at the edges
    const f = fract(along.div(4.2).add(across.mul(0.55)).sub(time.mul(1.3)));
    const chevron = smoothstep(0.0, 0.08, f).mul(smoothstep(0.46, 0.36, f));
    const edge = smoothstep(1.0, 0.72, across);
    const ends = smoothstep(this.start.add(2.5), this.start.add(9), along).mul(smoothstep(this.end, max(this.start, this.end.sub(50)), along));
    const mat = glowMaterial(this.color, chevron.mul(0.7).add(0.07).mul(edge).mul(ends), 1.5);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    parent.add(this.mesh);
  }

  // The route's points from `along` m in, for the next RIBBON_AHEAD m
  update(route, index, along, colorHex) {
    if (!route || route.points.length < 2) return this.hide();
    const pts = route.points;
    const P = this.positions;
    const U = this.uvs;
    let n = 0;
    let d = 0;
    for (let i = 0; i < index; i++) d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    const limit = along + RIBBON_AHEAD;
    const half = RIBBON_WIDTH * 0.5;
    let prevDx = 0;
    let prevDz = 0;
    for (let i = index; i < pts.length && n < RIBBON_POINTS; i++) {
      const p = pts[i];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next.x - p.x;
      let dz = next.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-4) {
        dx /= len;
        dz /= len;
      } else {
        dx = prevDx;
        dz = prevDz;
      }
      // (the ribbon's edge turns with the average of the way in and the way out of each point)
      let mx = dx + prevDx;
      let mz = dz + prevDz;
      const ml = Math.hypot(mx, mz);
      if (ml > 1e-4 && (prevDx || prevDz)) {
        mx /= ml;
        mz /= ml;
      } else {
        mx = dx;
        mz = dz;
      }
      const o = n * 6;
      P[o] = p.x + mz * half;
      P[o + 1] = RIBBON_Y;
      P[o + 2] = p.z - mx * half;
      P[o + 3] = p.x - mz * half;
      P[o + 4] = RIBBON_Y;
      P[o + 5] = p.z + mx * half;
      const u = n * 4;
      U[u] = 0;
      U[u + 1] = d;
      U[u + 2] = 1;
      U[u + 3] = d;
      n++;
      if (d > limit) break;
      d += len;
      prevDx = dx;
      prevDz = dz;
    }
    const geo = this.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
    geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.start.value = along;
    this.end.value = Math.min(limit, route.length);
    this.color.value.setHex(colorHex);
    this.mesh.visible = n > 1;
  }

  hide() {
    this.mesh.visible = false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Raccoons: one merged, vertex-coloured model (a raccoon sat up by the green bin it is raiding), instanced
// ---------------------------------------------------------------------------------------------------------------
function tinted(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function buildRaccoonGeometry() {
  const FUR = 0x7f8187;
  const DARK = 0x1c1c20;
  const PALE = 0xd9d5ca;
  const parts = [];
  const ball = (r, x, y, z, sx, sy, sz, hex, seg = 12) => {
    parts.push(tinted(new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2)).scale(sx, sy, sz).translate(x, y, z), hex));
  };
  // The green bin, lid propped open
  parts.push(tinted(new THREE.BoxGeometry(0.56, 0.92, 0.66).translate(-0.58, 0.46, 0), 0x1f7a3c));
  parts.push(tinted(new THREE.BoxGeometry(0.6, 0.05, 0.7).rotateZ(0.75).translate(-0.86, 1.12, 0), 0x186431));
  parts.push(tinted(new THREE.BoxGeometry(0.5, 0.02, 0.6).translate(-0.58, 0.925, 0), 0x0b1410));
  for (const side of [-1, 1]) {
    parts.push(tinted(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 12).rotateX(Math.PI * 0.5).translate(-0.78, 0.09, side * 0.3), DARK));
  }
  // The raccoon, sat up on its haunches facing +z with a paw on the bin
  ball(0.21, 0, 0.27, 0, 1, 1.22, 1.05, FUR, 14);
  ball(0.15, 0, 0.27, 0.09, 0.9, 1.15, 0.8, PALE);
  ball(0.145, 0, 0.6, 0.04, 1.18, 0.92, 1, FUR, 14);
  for (const side of [-1, 1]) {
    ball(0.055, side * 0.07, 0.615, 0.135, 1.35, 0.85, 0.6, DARK, 10); // the mask
    ball(0.017, side * 0.065, 0.622, 0.172, 1, 1, 0.6, 0xf2f2ee, 8); // eyes
    ball(0.05, side * 0.14, 0.59, 0.08, 0.7, 0.9, 0.8, PALE, 8); // cheek ruff
    parts.push(tinted(new THREE.ConeGeometry(0.045, 0.085, 8).translate(side * 0.1, 0.73, 0.02), DARK));
    ball(0.05, side * 0.11, 0.06, 0.13, 0.9, 0.6, 1.5, DARK, 8); // feet
  }
  ball(0.058, 0, 0.565, 0.17, 1, 0.82, 1.15, PALE, 10); // snout
  ball(0.022, 0, 0.578, 0.236, 1, 0.8, 0.8, DARK, 8); // nose
  // forelegs: one resting on the bin's rim, one tucked
  parts.push(tinted(new THREE.CapsuleGeometry(0.04, 0.26, 4, 8).rotateZ(1.05).translate(-0.19, 0.5, 0.06), FUR));
  ball(0.045, -0.31, 0.57, 0.06, 1, 0.8, 1, DARK, 8);
  parts.push(tinted(new THREE.CapsuleGeometry(0.04, 0.14, 4, 8).rotateX(-0.9).translate(0.13, 0.36, 0.14), FUR));
  ball(0.04, 0.13, 0.31, 0.21, 1, 0.8, 1, DARK, 8);
  // the ringed tail, curling up behind
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const a = t * 1.5;
    const r = 0.075 - t * 0.02;
    const seg = new THREE.CylinderGeometry(r * 0.94, r, 0.075, 10).rotateX(Math.PI * 0.5 - a);
    seg.translate(0.05, 0.1 + Math.sin(a) * 0.3 * t + t * 0.05, -0.2 - Math.sin(a * 0.7) * 0.34);
    parts.push(tinted(seg, i % 2 ? DARK : FUR));
  }
  ball(0.05, 0.05, 0.44, -0.52, 1, 1, 1, DARK, 8);
  for (const g of parts) g.deleteAttribute('uv');
  return mergeGeometries(parts);
}

class GigWorld {
  constructor(scene, gigs) {
    this.gigs = gigs;
    const group = this.group = new THREE.Group();
    group.name = 'Gigs';
    scene.add(group);

    this.beacons = Array.from({ length: 4 }, () => new Beacon(group));
    this.rings = Array.from({ length: 3 }, () => new SkyRing(group));
    this.ribbon = new GuideRibbon(group);

    // Customers: whoever is waiting at each offer, and the one getting in or walking away
    this.crowd = new PersonCrowd(6, { farDistance: 70 });
    for (const m of this.crowd.meshes) group.add(m);
    this.actors = new Map();

    // Raccoons
    const count = Math.max(1, gigs.raccoons.length);
    const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    const mesh = this.raccoonMesh = new THREE.InstancedMesh(buildRaccoonGeometry(), mat, count);
    mesh.name = 'Raccoons';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    this.dummy = new THREE.Object3D();
    this.leaving = new Map(); // raccoon id -> seconds since it was found
    gigs.raccoons.forEach((r) => this.writeRaccoon(r, r.found ? 0 : 1, 0));
    mesh.instanceMatrix.needsUpdate = true;
  }

  writeRaccoon(r, scale, hop, spin = 0) {
    const d = this.dummy;
    d.position.set(r.x, CITY_BOUNDS.sidewalkHeight + hop, r.z);
    d.rotation.set(0, r.yaw + spin, 0);
    d.scale.setScalar(1.3 * scale);
    d.updateMatrix();
    this.raccoonMesh.setMatrixAt(r.id, d.matrix);
  }

  onEvent(type, data) {
    if (type === 'raccoon') this.leaving.set(data.raccoon.id, 0);
    else if (type === 'boarded' && data.job.kind === 'fare') this.actors.delete(`offer${data.job.id}`);
    else if (type === 'complete' || type === 'fail') {
      const job = data.job;
      if (type === 'complete' && job.kind === 'fare') {
        // out of the cab and off across the sidewalk
        const car = this.gigs.controllers.entities.car;
        const side = { x: car.position.x + Math.cos(car.heading) * -1.5, z: car.position.z - Math.sin(car.heading) * -1.5 };
        const actor = this.actor(`left${job.id}`, job.id, side.x, side.z, car.heading);
        actor.tx = job.dest.stand.x;
        actor.tz = job.dest.stand.z;
        actor.life = 6;
      }
      const waiting = this.actors.get('customer');
      if (waiting) waiting.life = type === 'complete' ? 4 : 0.01;
      this.actors.delete(`offer${job.id}`);
    }
  }

  actor(key, seed, x, z, yaw) {
    let a = this.actors.get(key);
    if (!a) {
      const n = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
      const rig = new PersonRig({
        seed: (seed * 3.71) % 97, scale: 0.94 + n * 0.12, female: Math.floor(n * 10) % 2 === 0, girth: 0.92 + ((n * 7) % 1) * 0.2,
        hair: (n * 13) % 1, armSwing: 1, stride: 1
      });
      rig.reset(x, z, yaw, personGround, null);
      a = { rig, x, z, yaw, tx: x, tz: z, life: Infinity };
      this.actors.set(key, a);
    }
    return a;
  }

  updateActors(dt, entity, camera) {
    const gigs = this.gigs;
    const job = gigs.job;
    const wanted = new Set();
    for (const o of gigs.offers) {
      if (!o.stand) continue;
      const key = `offer${o.id}`;
      wanted.add(key);
      this.actor(key, o.id, o.stand.x, o.stand.z, o.stand.yaw);
    }
    if (job && job.stand && job.stage === 'boarding') {
      const key = `offer${job.id}`;
      wanted.add(key);
      const a = this.actor(key, job.id, job.stand.x, job.stand.z, job.stand.yaw);
      if (job.kind === 'fare') {
        // over to the kerb side door
        a.tx = entity.position.x + Math.cos(entity.heading) * -1.25;
        a.tz = entity.position.z - Math.sin(entity.heading) * -1.25;
        a.pace = 2.6;
      }
    }
    if (job && job.kind === 'delivery' && job.stage !== 'boarding') {
      wanted.add('customer');
      this.actor('customer', job.id + 0.5, job.dest.stand.x, job.dest.stand.z, job.dest.stand.yaw);
    }

    this.crowd.begin();
    for (const [key, a] of this.actors) {
      if (a.life !== Infinity) a.life -= dt;
      else if (!wanted.has(key)) a.life = 0;
      if (a.life <= 0) {
        this.actors.delete(key);
        continue;
      }
      const dx = a.tx - a.x;
      const dz = a.tz - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.08) {
        const step = Math.min(d, (a.pace || 1.5) * dt);
        a.x += (dx / d) * step;
        a.z += (dz / d) * step;
        a.yaw = Math.atan2(dx, dz);
      }
      a.rig.update(dt, a.x, a.z, a.yaw, personGround, null, 0, true);
      this.crowd.add(a.rig, Math.hypot(a.x - camera.position.x, a.z - camera.position.z));
    }
    this.crowd.end();
  }

  updateRaccoons(dt, elapsed, entity) {
    const mesh = this.raccoonMesh;
    let dirty = false;
    for (const r of this.gigs.raccoons) {
      if (this.leaving.has(r.id)) {
        // found: a startled hop and it's gone
        const t = this.leaving.get(r.id) + dt;
        const k = Math.min(1, t / 0.7);
        this.writeRaccoon(r, 1 - k * k, Math.sin(k * Math.PI) * 0.9, k * 9);
        if (k >= 1) this.leaving.delete(r.id);
        else this.leaving.set(r.id, t);
        dirty = true;
      } else if (!r.found && Math.abs(r.x - entity.position.x) < 60 && Math.abs(r.z - entity.position.z) < 60) {
        // rummaging: a little bob now and then
        const beat = Math.max(0, Math.sin(elapsed * 2.3 + r.id * 1.7));
        this.writeRaccoon(r, 1, beat ** 6 * 0.07, Math.sin(elapsed * 0.9 + r.id) * 0.12);
        dirty = true;
      }
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, elapsed, camera, entity, mode) {
    const gigs = this.gigs;
    this.updateRaccoons(dt, elapsed, entity);
    this.updateActors(dt, entity, camera);

    let beacon = 0;
    let ring = 0;
    const job = gigs.job;
    if (gigs.enabled) {
      for (const o of gigs.offers) {
        if (o.kind === 'tour') {
          if (ring < this.rings.length) this.rings[ring++].place(o.rings[0], o.radius, COLORS.tour, 1, elapsed);
        } else if (beacon < this.beacons.length) {
          this.beacons[beacon++].place(o.x, 0, o.z, o.radius, COLORS[o.kind], elapsed, o === gigs.target?.ref ? PILLAR_HEIGHT : PILLAR_HEIGHT * 0.6);
        }
      }
      if (job && job.kind === 'tour') {
        for (let i = job.ring; i < job.rings.length && ring < this.rings.length; i++) {
          const first = i === job.ring;
          this.rings[ring++].place(job.rings[i], job.radius, first ? (i === job.rings.length - 1 ? COLORS.dropoff : COLORS.tour) : COLORS.tour, first ? 1 : 0.28, elapsed);
        }
      } else if (job) {
        if (job.stage === 'boarding') this.beacons[beacon++].place(job.x, 0, job.z, job.radius, COLORS[job.kind], elapsed);
        else this.beacons[beacon++].place(job.dest.x, 0, job.dest.z, job.radius, COLORS.dropoff, elapsed, PILLAR_HEIGHT * 1.6);
      }
    }
    for (let i = beacon; i < this.beacons.length; i++) this.beacons[i].hide();
    for (let i = ring; i < this.rings.length; i++) this.rings[i].hide();

    if (gigs.enabled && gigs.route && (mode === 'car' || mode === 'cyclist') && !(job && job.stage === 'boarding')) {
      const kind = gigs.target?.kind;
      this.ribbon.update(gigs.route, gigs.routeIndex, gigs.routeAlong, kind === 'dropoff' ? COLORS.dropoff : COLORS[mode === 'car' ? 'fare' : 'delivery']);
    } else {
      this.ribbon.hide();
    }
  }
}

export { GigWorld, COLORS as GIG_COLORS };
