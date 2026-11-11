import * as THREE from 'three/webgpu';

// js/combat.js
// The car is armed. On its roof sits a turret: twin machine guns between two rocket pods. It looks where the camera
// looks (drag to aim) and helps: anything in front of the sights is locked on to, and with the police on your tail
// it swings round to whichever cruiser is nearest, all by itself. F hammers away with the guns, X sends a rocket
// (they home on what is locked; six in the pods, reloading one at a time).
//
// Bullets are traced through the city in the instant they are fired: they spark off cars, drop pedestrians and
// chip the buildings. Cars have hit points; out of them they blow up, are thrown into the air and burn where they
// land, and a car going up takes the ones beside it along (a moment later, each on its own fuse). Explosions shove
// everything around them, shake and throw the camera (cameras.js) and are heard late from far away.
//
// All of it is a crime, reported to the police (police.js) through onCrime.

const GUN = { interval: 0.075, range: 170, spread: 0.014, damage: 15, copDamage: 13 };
const ROCKET = { interval: 0.42, max: 6, reload: 2.1, speed: 38, top: 105, thrust: 120, turn: 2.6, life: 4.2 };
const BLAST_RADIUS = 8.5;
const HEAT = { pedestrian: 16, vehicle: 26, cruiser: 34, bullet: 2, rocket: 9 };

const _v = new THREE.Vector3();

// Where a ray from (ox, oz) along the unit vector (dx, dz) enters a box in the plane, or Infinity. `o` is an oriented
// box { cx, cz, cs, sn, hx, hz } (local across = x cs - z sn, along = x sn + z cs: a building's or a vehicle's)
function rayBox(ox, oz, dx, dz, o) {
  const rx = ox - o.cx;
  const rz = oz - o.cz;
  const px = rx * o.cs - rz * o.sn;
  const pz = rx * o.sn + rz * o.cs;
  const qx = dx * o.cs - dz * o.sn;
  const qz = dx * o.sn + dz * o.cs;
  let t0 = 0;
  let t1 = Infinity;
  if (Math.abs(qx) < 1e-9) {
    if (Math.abs(px) > o.hx) return Infinity;
  } else {
    const a = (-o.hx - px) / qx;
    const b = (o.hx - px) / qx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (Math.abs(qz) < 1e-9) {
    if (Math.abs(pz) > o.hz) return Infinity;
  } else {
    const a = (-o.hz - pz) / qz;
    const b = (o.hz - pz) / qz;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 ? t0 : Infinity;
}

const _box = { cx: 0, cz: 0, cs: 1, sn: 0, hx: 0, hz: 0 };

// How far a ray at height y gets before it meets a building, up to maxDist (Infinity if it doesn't)
function rayBuildings(controllers, ox, oz, dx, dz, maxDist, y = 1.2) {
  const STEP = 44;
  let best = Infinity;
  for (let from = 0; from < maxDist; from += STEP) {
    const mid = Math.min(maxDist, from + STEP * 0.5);
    const near = controllers.nearColliders(ox + dx * mid, oz + dz * mid, STEP * 0.5 + 2);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (c.maxY < y) continue;
      let box = c.obb;
      if (!box) {
        box = _box;
        box.cx = (c.minX + c.maxX) * 0.5;
        box.cz = (c.minZ + c.maxZ) * 0.5;
        box.hx = (c.maxX - c.minX) * 0.5;
        box.hz = (c.maxZ - c.minZ) * 0.5;
      }
      const t = rayBox(ox, oz, dx, dz, box);
      if (t < best) best = t;
    }
    if (best <= from + STEP) break;
  }
  return best <= maxDist ? best : Infinity;
}

// Nothing but air between two points at height y?
function clearLine(controllers, x0, z0, x1, z1, y = 1.2) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) return true;
  return rayBuildings(controllers, x0, z0, dx / d, dz / d, d - 0.5, y) === Infinity;
}

function vehicleBox(v, grow = 0) {
  const yaw = v.yaw + v.yawOffset;
  _box.cx = v.x;
  _box.cz = v.z;
  _box.cs = Math.cos(yaw);
  _box.sn = Math.sin(yaw);
  _box.hx = v.halfWidth + grow;
  _box.hz = v.half + grow;
  return _box;
}

function angleBetween(a, b) {
  let d = a - b;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return d;
}

// The turret: a ring on the roof, the housing that turns on it, twin barrels and a rocket pod either side
function buildTurret() {
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x24272b, metalness: 0.85, roughness: 0.38 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x08090a, metalness: 0.6, roughness: 0.55 });
  const warhead = new THREE.MeshStandardNodeMaterial({ color: 0x8a1410, metalness: 0.3, roughness: 0.5 });
  const mesh = (geo, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const root = new THREE.Group();
  root.name = 'CarTurret';
  mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.07, 24), dark, 0, 0.035, 0, root);
  const yaw = new THREE.Group();
  yaw.position.y = 0.07;
  root.add(yaw);
  mesh(new THREE.BoxGeometry(0.34, 0.2, 0.5), metal, 0, 0.11, -0.02, yaw);
  mesh(new THREE.BoxGeometry(0.4, 0.05, 0.3), dark, 0, 0.225, -0.08, yaw);
  const gun = new THREE.Group(); // (kicks back with every round)
  yaw.add(gun);
  mesh(new THREE.BoxGeometry(0.17, 0.1, 0.34), dark, 0, 0.12, 0.36, gun);
  const barrel = new THREE.CylinderGeometry(0.021, 0.021, 0.62, 10).rotateX(Math.PI * 0.5);
  for (const side of [-1, 1]) {
    mesh(barrel, metal, side * 0.045, 0.125, 0.78, gun);
    mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.09, 10).rotateX(Math.PI * 0.5), dark, side * 0.045, 0.125, 1.08, gun);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.125, 1.14);
  gun.add(muzzle);
  const tubes = [];
  for (const side of [-1, 1]) {
    mesh(new THREE.BoxGeometry(0.21, 0.21, 0.66), metal, side * 0.3, 0.115, 0.02, yaw);
    for (const [ux, uy] of [[-0.05, 0.05], [0.05, 0.05], [-0.05, -0.05], [0.05, -0.05]]) {
      mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.03, 10).rotateX(Math.PI * 0.5), warhead, side * 0.3 + ux, 0.115 + uy, 0.345, yaw);
    }
    const tube = new THREE.Object3D();
    tube.position.set(side * 0.3, 0.115, 0.5);
    yaw.add(tube);
    tubes.push(tube);
  }
  return { root, yaw, gun, muzzle, tubes };
}

function buildRocketMesh() {
  const body = new THREE.MeshStandardNodeMaterial({ color: 0x3a4038, metalness: 0.5, roughness: 0.5 });
  const tip = new THREE.MeshStandardNodeMaterial({ color: 0x9a1812, metalness: 0.3, roughness: 0.45 });
  const g = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.8, 10).rotateX(Math.PI * 0.5), body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.22, 10).rotateX(Math.PI * 0.5), tip);
  nose.position.z = 0.51;
  g.add(tube, nose);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.16), body);
    fin.position.z = -0.34;
    fin.rotation.z = (i * Math.PI) / 4;
    g.add(fin);
  }
  g.visible = false;
  return g;
}

class CombatSystem {
  constructor({ scene, controllers, traffic, cameraSystem, fx, audio, groundAt = () => 0, onCrime = () => {}, onPlayerWrecked = () => {} }) {
    this.controllers = controllers;
    this.traffic = traffic;
    this.cameraSystem = cameraSystem;
    this.fx = fx;
    this.audio = audio;
    this.groundAt = groundAt;
    this.onCrime = onCrime;
    this.onPlayerWrecked = onPlayerWrecked;
    this.police = null; // set by main.js once the police are on duty

    const car = this.car = controllers.entities.car;
    this.turret = buildTurret();
    const mount = car.turretMount || { x: 0, y: 1.6, z: -0.35 };
    this.turret.root.position.set(mount.x, mount.y, mount.z);
    car.chassisPivot.add(this.turret.root);

    this.rocketMeshes = [];
    for (let i = 0; i < 6; i++) {
      const m = buildRocketMesh();
      scene.add(m);
      this.rocketMeshes.push(m);
    }
    this.rockets = [];
    this.rocketAmmo = ROCKET.max;
    this.rocketReload = 0;
    this.rocketCooldown = 0;
    this.rocketSide = 0;
    this.rocketHeld = false;
    this.rocketQueued = false;
    this.gunCooldown = 0;
    this.gunKick = 0;
    this.scare = 0;

    this.aimYaw = car.heading;
    this.target = null;
    this.aimPoint = new THREE.Vector3();
    this.armed = false;
    this.flash = 0;
    this.slow = 0;
    this.slowCooldown = 0;
    this.wasWrecked = false;
    this.kills = { vehicles: 0, cruisers: 0 };

    // HUD: the sights, the pods' load, the flash of a blast close by
    this.elSights = document.getElementById('crosshair');
    this.elWeapons = document.getElementById('weapons');
    this.elRockets = document.getElementById('weapon-rockets');
    this.elFlash = document.getElementById('fx-flash');
    this.shown = { ammo: -1, locked: null, visible: null, flash: 0 };

    // The right mouse button sends a rocket too
    const canvas = cameraSystem.domElement;
    if (canvas && canvas.addEventListener) {
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button === 2 && e.pointerType !== 'touch') this.rocketQueued = true;
      });
    }
  }

  // How much the game's clock is held back: a blast close by is seen in slow motion for a moment
  get timeScale() {
    if (this.slow <= 0) return 1;
    const k = Math.min(1, this.slow / 0.16);
    return 1 - 0.62 * k * k * (3 - 2 * k);
  }

  targetPosition(t, out) {
    const r = t.ref;
    if (t.kind === 'ped') return out.set(r.x, this.groundAt(r.x, r.z) + 1.05, r.z);
    return out.set(r.x, (r.y || 0) + 0.75, r.z);
  }

  targetValid(t) {
    const r = t.ref;
    if (t.kind === 'ped') return r.placed && !(r.knock && (r.knock.phase === 'rag' || r.knock.phase === 'down'));
    if (t.kind === 'cop') return r.active && !r.dead;
    return !!r.edge && !r.dead;
  }

  // What the turret should be pointing at: whatever is nearest the sights; failing that, the nearest cruiser anywhere
  // around the car. Only what can be seen from the turret counts
  pickTarget(ox, oz, yaw) {
    const controllers = this.controllers;
    let best = null;
    let bestScore = Infinity;
    const consider = (kind, ref, x, z, cone, range, bias) => {
      const dx = x - ox;
      const dz = z - oz;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 2.5) return;
      const off = Math.abs(angleBetween(Math.atan2(dx, dz), yaw));
      if (off > cone) return;
      let score = off * 60 + d * 0.25 + bias;
      if (this.target && this.target.ref === ref) score -= 14; // (it keeps what it has)
      if (score >= bestScore || !clearLine(controllers, ox, oz, x, z, 1.4)) return;
      bestScore = score;
      best = { kind, ref };
    };
    const units = this.police ? this.police.units : [];
    for (const u of units) if (u.active && !u.dead) consider('cop', u, u.x, u.z, 0.26, 130, -20);
    for (const v of this.traffic.vehicles) {
      if (!v.edge || v.dead || Math.abs(v.x - ox) > 120 || Math.abs(v.z - oz) > 120) continue;
      consider('vehicle', v, v.x, v.z, 0.11, 120, 0);
    }
    for (const p of this.traffic.peds) {
      if (!p.placed || Math.abs(p.x - ox) > 60 || Math.abs(p.z - oz) > 60) continue;
      if (p.knock && (p.knock.phase === 'rag' || p.knock.phase === 'down')) continue;
      consider('ped', p, p.x, p.z, 0.07, 60, 6);
    }
    if (best) return best;
    // the pursuit, wherever it is around the car
    for (const u of units) if (u.active && !u.dead) consider('cop', u, u.x, u.z, Math.PI, 75, 0);
    return best;
  }

  // The nearest thing a ray from (ox, oy, oz) along (dx, dy, dz) strikes within maxDist: { t, kind, ref }
  trace(ox, oy, oz, dx, dy, dz, maxDist, grow = 0) {
    const flat = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / flat;
    const uz = dz / flat;
    const reach = maxDist * flat;
    const hit = this._hit || (this._hit = { t: 0, kind: '', ref: null });
    hit.t = Infinity;
    hit.kind = '';
    hit.ref = null;
    const heightAt = (t) => oy + (dy / flat) * t;
    const tb = rayBuildings(this.controllers, ox, oz, ux, uz, reach, Math.max(0.5, oy));
    if (tb < hit.t) {
      hit.t = tb;
      hit.kind = 'building';
    }
    for (const v of this.traffic.vehicles) {
      if (!v.edge || Math.abs(v.x - ox) > reach + 8 || Math.abs(v.z - oz) > reach + 8) continue;
      const t = rayBox(ox, oz, ux, uz, vehicleBox(v, grow));
      if (t >= hit.t || t > reach) continue;
      const h = heightAt(t) - (v.y || 0);
      if (h < -0.2 || h > (v.bus ? 3.1 : 1.75) + grow) continue;
      hit.t = t;
      hit.kind = 'vehicle';
      hit.ref = v;
    }
    if (this.police) {
      for (const u of this.police.units) {
        if (!u.active) continue;
        const t = rayBox(ox, oz, ux, uz, this.police.box(u, grow));
        if (t >= hit.t || t > reach) continue;
        const h = heightAt(t) - (u.y || 0);
        if (h < -0.2 || h > 1.75 + grow) continue;
        hit.t = t;
        hit.kind = 'cop';
        hit.ref = u;
      }
    }
    const pr = 0.42 + grow;
    for (const p of this.traffic.peds) {
      if (!p.placed) continue;
      const rx = p.x - ox;
      const rz = p.z - oz;
      const along = rx * ux + rz * uz;
      if (along < 0 || along > reach || along >= hit.t) continue;
      const off = Math.abs(rx * uz - rz * ux);
      if (off > pr) continue;
      if (p.knock && (p.knock.phase === 'rag' || p.knock.phase === 'down')) continue;
      const h = heightAt(along) - this.groundAt(p.x, p.z);
      if (h < 0 || h > 1.95 + grow) continue;
      hit.t = along - Math.sqrt(pr * pr - off * off);
      hit.kind = 'ped';
      hit.ref = p;
    }
    // the road itself
    if (dy < 0) {
      const tg = ((oy - this.groundAt(ox + ux * 20, oz + uz * 20) - 0.03) / -dy) * flat;
      if (tg < hit.t && tg <= reach) {
        hit.t = tg;
        hit.kind = 'ground';
        hit.ref = null;
      }
    }
    if (hit.t === Infinity) return null;
    hit.t /= flat; // back to metres along the ray itself
    return hit;
  }

  fireGun() {
    const fx = this.fx;
    const m = this.turret.muzzle.getWorldPosition(_v);
    const ox = m.x;
    const oy = m.y;
    const oz = m.z;
    let dx = Math.sin(this.aimYaw);
    let dz = Math.cos(this.aimYaw);
    let dy = -0.006;
    if (this.target) {
      const p = this.targetPosition(this.target, this.aimPoint);
      const d = Math.hypot(p.x - ox, p.y - oy, p.z - oz) || 1;
      dx = (p.x - ox) / d;
      dy = (p.y - oy) / d;
      dz = (p.z - oz) / d;
    }
    // (no two rounds go quite the same way)
    const s = GUN.spread;
    dx += (Math.random() - 0.5) * 2 * s;
    dy += (Math.random() - 0.5) * s;
    dz += (Math.random() - 0.5) * 2 * s;
    const l = Math.hypot(dx, dy, dz);
    dx /= l;
    dy /= l;
    dz /= l;

    const hit = this.trace(ox, oy, oz, dx, dy, dz, GUN.range);
    const t = hit ? hit.t : GUN.range;
    const hx = ox + dx * t;
    const hy = oy + dy * t;
    const hz = oz + dz * t;
    fx.tracer(ox, oy, oz, hx, hy, hz);
    fx.muzzle(ox, oy, oz, dx, dy, dz);
    this.audio.gun();
    this.cameraSystem.recoil(0.07, 0.3);
    this.gunKick = 1;
    if (!hit) return;
    if (hit.kind === 'vehicle') {
      const v = hit.ref;
      fx.impact(hx, hy, hz, -dx, -dz, true);
      this.traffic.pushVehicle(v, dx * 0.5, dz * 0.5, (Math.random() - 0.5) * 0.4);
      if (!v.dead) {
        this.onCrime('bullet', HEAT.bullet, hx, hz);
        if (this.traffic.damageVehicle(v, GUN.damage) && v.fuse < 0) v.fuse = 0.02;
      }
    } else if (hit.kind === 'cop') {
      fx.impact(hx, hy, hz, -dx, -dz, true);
      this.police.hitUnit(hit.ref, GUN.copDamage, dx, dz);
    } else if (hit.kind === 'ped') {
      fx.impact(hx, hy, hz, -dx, -dz, false);
      if (this.traffic.flingPed(hit.ref, dx * 4.5, 1.6 + Math.random() * 1.5, dz * 4.5, true)) this.onCrime('pedestrian', HEAT.pedestrian, hx, hz);
    } else {
      fx.impact(hx, hy, hz, -dx, -dz, false);
    }
  }

  fireRocket() {
    const mesh = this.rocketMeshes.find((m) => !m.visible);
    if (!mesh) return false;
    const tube = this.turret.tubes[this.rocketSide];
    this.rocketSide = 1 - this.rocketSide;
    const p = tube.getWorldPosition(_v);
    const dx = Math.sin(this.aimYaw);
    const dz = Math.cos(this.aimYaw);
    const car = this.car;
    const carry = Math.max(0, (Math.sin(car.heading) * dx + Math.cos(car.heading) * dz) * car.speed);
    mesh.visible = true;
    this.rockets.push({ mesh, x: p.x, y: p.y, z: p.z, dx, dy: 0.02, dz, speed: ROCKET.speed + carry, life: ROCKET.life, target: this.target ? { ...this.target } : null, age: 0 });
    this.fx.backblast(p.x, p.y, p.z, dx, dz);
    this.audio.rocket();
    this.cameraSystem.recoil(0.3, 0.45);
    this.onCrime('rocket', HEAT.rocket, p.x, p.z);
    return true;
  }

  updateRockets(dt) {
    const list = this.rockets;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      r.age += dt;
      r.life -= dt;
      r.speed = Math.min(ROCKET.top, r.speed + ROCKET.thrust * dt);
      // homing: it turns towards what it was locked on to, as hard as its fins allow
      if (r.target && this.targetValid(r.target) && r.age > 0.08) {
        const p = this.targetPosition(r.target, this.aimPoint);
        let tx = p.x - r.x;
        let ty = p.y - r.y;
        let tz = p.z - r.z;
        const d = Math.hypot(tx, ty, tz) || 1;
        tx /= d;
        ty /= d;
        tz /= d;
        const k = Math.min(1, ROCKET.turn * dt / Math.max(0.02, Math.acos(Math.max(-1, Math.min(1, tx * r.dx + ty * r.dy + tz * r.dz)))));
        r.dx += (tx - r.dx) * k;
        r.dy += (ty - r.dy) * k;
        r.dz += (tz - r.dz) * k;
        const l = Math.hypot(r.dx, r.dy, r.dz) || 1;
        r.dx /= l;
        r.dy /= l;
        r.dz /= l;
      }
      const step = r.speed * dt;
      const hit = this.trace(r.x, r.y, r.z, r.dx, r.dy, r.dz, step + 0.4, 0.25);
      if (hit || r.life <= 0) {
        const t = hit ? Math.max(0, hit.t - 0.3) : step;
        r.mesh.visible = false;
        this.explode(r.x + r.dx * t, Math.max(0.4, r.y + r.dy * t), r.z + r.dz * t, 1.25);
        continue;
      }
      r.x += r.dx * step;
      r.y += r.dy * step;
      r.z += r.dz * step;
      r.mesh.position.set(r.x, r.y, r.z);
      r.mesh.lookAt(r.x + r.dx, r.y + r.dy, r.z + r.dz);
      this.fx.exhaust(r.x - r.dx * 0.5, r.y - r.dy * 0.5, r.z - r.dz * 0.5, r.dx, r.dy, r.dz);
      list[n++] = r;
    }
    list.length = n;
  }

  // Something blows up at (x, y, z) with the given power (1 = a car): seen, heard and felt, and everything within
  // reach is thrown back, hurt or set off. `safe` spares the player's own car (it is the one going up)
  explode(x, y, z, power = 1, { safe = false } = {}) {
    const camera = this.cameraSystem.camera;
    const ground = this.groundAt(x, z);
    this.fx.explosion(x, Math.max(y, ground + 0.3), z, power, ground);
    this.audio.explosion(Math.hypot(camera.position.x - x, camera.position.y - y, camera.position.z - z), power);
    const felt = this.cameraSystem.blast(x, y, z, power);
    this.flash = Math.max(this.flash, felt);
    if (felt > 0.5 && this.slowCooldown <= 0) {
      this.slow = 0.2;
      this.slowCooldown = 2.5;
    }

    const R = BLAST_RADIUS * Math.sqrt(power);
    const traffic = this.traffic;
    for (const v of traffic.vehicles) {
      if (!v.edge) continue;
      const dx = v.x - x;
      const dz = v.z - z;
      if (Math.abs(dx) > R + 8 || Math.abs(dz) > R + 8) continue;
      const d = Math.hypot(dx, dz);
      const f = 1 - Math.max(0, d - v.half * 0.7) / R;
      if (f <= 0) continue;
      const nx = d > 0.2 ? dx / d : Math.random() - 0.5;
      const nz = d > 0.2 ? dz / d : Math.random() - 0.5;
      traffic.pushVehicle(v, nx * f * 13, nz * f * 13, (Math.random() - 0.5) * f * 6);
      if (!v.dead && traffic.damageVehicle(v, 250 * f * power) && v.fuse < 0) {
        v.fuse = 0.1 + Math.random() * 0.4;
        v.blastX = nx;
        v.blastZ = nz;
      }
    }
    if (this.police) this.police.blast(x, z, R, power);
    const pr = R * 1.3;
    for (const p of traffic.peds) {
      if (!p.placed) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      if (Math.abs(dx) > pr || Math.abs(dz) > pr) continue;
      const d = Math.hypot(dx, dz);
      const f = 1 - d / pr;
      if (f <= 0) continue;
      const nx = d > 0.2 ? dx / d : 0;
      const nz = d > 0.2 ? dz / d : 1;
      if (traffic.flingPed(p, nx * f * 12, 3 + f * 7.5, nz * f * 12, f > 0.3)) this.onCrime('pedestrian', HEAT.pedestrian, p.x, p.z);
    }
    traffic.scarePeds(x, z, 55);

    // the player's own car is not spared for having started it
    const car = this.car;
    if (!safe && this.controllers.activeMode === 'car') {
      const dx = car.position.x - x;
      const dz = car.position.z - z;
      const d = Math.hypot(dx, dz);
      const f = 1 - Math.max(0, d - 1.5) / R;
      if (f > 0) {
        const nx = d > 0.2 ? dx / d : 0;
        const nz = d > 0.2 ? dz / d : 1;
        car.vx += nx * f * 8;
        car.vz += nz * f * 8;
        car.heaveVel += f * 1.4;
        car.angularVel += (Math.random() - 0.5) * f * 3;
        car.rollVel += (Math.random() - 0.5) * f * 4;
        this.controllers.hurtCar(34 * f * power);
      }
    }
  }

  // A vehicle whose fuse has run out
  blowUp(v) {
    const nx = v.blastX || Math.random() - 0.5;
    const nz = v.blastZ || Math.random() - 0.5;
    v.blastX = v.blastZ = 0;
    if (!this.traffic.destroyVehicle(v, nx, nz)) return;
    this.kills.vehicles++;
    this.onCrime(v.isNYPD ? 'cruiser' : 'vehicle', v.isNYPD ? HEAT.cruiser : HEAT.vehicle, v.x, v.z);
    this.explode(v.x, 0.9, v.z, v.bus ? 1.7 : 1);
  }

  update(dt, mode, camera) {
    const fx = this.fx;
    const car = this.car;
    const keys = this.controllers.keys;
    const armed = this.armed = mode === 'car' && !(car.wrecked > 0);
    this.gunCooldown -= dt;
    this.rocketCooldown -= dt;
    this.slowCooldown -= dt;
    // (the slow motion is over in a fifth of a second of the player's own time, whatever it does to the game's)
    if (this.slow > 0) this.slow -= dt / Math.max(0.3, this.timeScale);

    // 1. The turret follows the camera, or whatever it has locked on to
    car.mesh.updateMatrixWorld(true); // (where the car is now, not where it was last drawn)
    const m = this.turret.muzzle.getWorldPosition(_v);
    const ox = car.position.x;
    const oz = car.position.z;
    const lookYaw = this.cameraSystem.aimYaw(car);
    let wantYaw = lookYaw;
    if (armed) {
      if (this.target && !this.targetValid(this.target)) this.target = null;
      this.retarget = (this.retarget || 0) - dt;
      if (this.retarget <= 0) {
        this.retarget = 0.12;
        this.target = this.pickTarget(ox, oz, lookYaw);
      }
      if (this.target) {
        const p = this.targetPosition(this.target, this.aimPoint);
        wantYaw = Math.atan2(p.x - m.x, p.z - m.z);
      }
    } else {
      this.target = null;
      wantYaw = car.heading;
    }
    this.aimYaw += angleBetween(wantYaw, this.aimYaw) * Math.min(1, dt * 14);
    this.turret.yaw.rotation.y = this.aimYaw - car.heading;
    this.gunKick = Math.max(0, this.gunKick - dt * 16);
    this.turret.gun.position.z = -0.07 * this.gunKick;

    // 2. The guns & the rockets
    if (armed && keys.fire && this.gunCooldown <= 0) {
      this.gunCooldown = GUN.interval;
      this.fireGun();
      this.scare -= GUN.interval;
      if (this.scare <= 0) {
        this.scare = 0.6;
        this.traffic.scarePeds(ox, oz, 38);
      }
    }
    const wantRocket = (keys.rocket && !this.rocketHeld) || this.rocketQueued || (keys.rocket && this.rocketCooldown < -0.25);
    this.rocketHeld = !!keys.rocket;
    this.rocketQueued = false;
    if (armed && wantRocket && this.rocketCooldown <= 0 && this.rocketAmmo > 0 && this.fireRocket()) {
      this.rocketAmmo--;
      this.rocketCooldown = ROCKET.interval;
    }
    if (this.rocketAmmo < ROCKET.max) {
      this.rocketReload += dt;
      if (this.rocketReload >= ROCKET.reload) {
        this.rocketReload = 0;
        this.rocketAmmo++;
      }
    } else {
      this.rocketReload = 0;
    }
    this.updateRockets(dt);

    // 3. Fuses, fires & smoke: what has been hit hard smokes, what has blown up burns
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (const v of this.traffic.vehicles) {
      if (!v.edge) continue;
      if (v.fuse >= 0 && !v.dead) {
        v.fuse -= dt;
        if (v.fuse < 0) this.blowUp(v);
      }
      if (!v.dead && v.hp >= 60) continue;
      if (Math.abs(v.x - cx) > 260 || Math.abs(v.z - cz) > 260) continue;
      const heat = v.dead ? Math.max(0, 1 - v.dead / 17) : 0;
      v._burn = (v._burn || 0) + dt * (v.dead ? 5 + heat * 9 : (60 - v.hp) * 0.09);
      while (v._burn >= 1) {
        v._burn -= 1;
        if (v.dead) fx.burn(v.x, v.y || 0, v.z, heat);
        else fx.smoke.emit(v.x + v.tx * 1.4, 1.0, v.z + v.tz * 1.4, v.tx * v.speed * 0.5, 1.6, v.tz * v.speed * 0.5, 1.4, 0.5, 2.4, 0.3, 0.3, 0.3, 0.3, 0.6, 1.2);
      }
    }

    // 4. The player's own car going up
    const wrecked = car.wrecked > 0;
    if (wrecked && !this.wasWrecked) {
      this.explode(car.position.x, car.position.y + 0.8, car.position.z, 1.3, { safe: true });
      this.onPlayerWrecked();
    }
    this.wasWrecked = wrecked;
    if (wrecked) {
      this._carBurn = (this._carBurn || 0) + dt * 14;
      while (this._carBurn >= 1) {
        this._carBurn -= 1;
        fx.burn(car.position.x, car.position.y, car.position.z, 1);
      }
    }

    fx.update(dt, camera);
    this.updateHud(dt, camera, mode);
  }

  updateHud(dt, camera, mode) {
    const shown = this.shown;
    const visible = mode === 'car';
    if (visible !== shown.visible) {
      shown.visible = visible;
      if (this.elWeapons) this.elWeapons.hidden = !visible;
      if (this.elSights) this.elSights.hidden = !visible;
    }
    if (this.rocketAmmo !== shown.ammo && this.elRockets) {
      shown.ammo = this.rocketAmmo;
      const pips = this.elRockets.children;
      for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('is-on', i < this.rocketAmmo);
    }
    // the sights sit on what is locked, or out in front of the barrels
    if (visible && this.elSights) {
      const p = this.aimPoint;
      if (this.target) this.targetPosition(this.target, p);
      else p.set(this.car.position.x + Math.sin(this.aimYaw) * 45, this.car.position.y + 1.3, this.car.position.z + Math.cos(this.aimYaw) * 45);
      p.project(camera);
      const on = this.armed && p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      const kind = !on ? 'off' : this.target ? this.target.kind : 'free';
      if (kind !== shown.locked) {
        shown.locked = kind;
        this.elSights.dataset.lock = kind;
      }
      if (on) this.elSights.style.transform = `translate(${((p.x * 0.5 + 0.5) * window.innerWidth).toFixed(1)}px, ${((0.5 - p.y * 0.5) * window.innerHeight).toFixed(1)}px)`;
    }
    this.flash *= Math.exp(-dt * 5.5);
    const flash = this.flash < 0.02 ? 0 : Math.round(this.flash * 40) / 40;
    if (flash !== shown.flash && this.elFlash) {
      shown.flash = flash;
      this.elFlash.style.opacity = String(Math.min(0.42, flash * 0.42));
    }
  }
}

export { CombatSystem, rayBox, rayBuildings, clearLine, angleBetween, ROCKET };
