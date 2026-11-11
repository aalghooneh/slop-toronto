import * as THREE from 'three/webgpu';
import { BODY_SPECS, buildCarGeometry, buildSteerableWheelGeo, createLoftedCarMaterial, buildLightbarGeometry, createLightbarMaterial } from './actor-models.js';
import { createContactShadowMaterial } from './tsl-materials.js';
import { clearLine, angleBetween } from './combat.js';

// js/police.js
// The Toronto police, once you give them a reason. Crimes (running people down, shooting, blowing cars up, ramming
// cruisers) add heat, and heat is stars: one to five. Every star puts more cruisers on your tail, and faster ones;
// from three stars the officers shoot. The cruisers are not traffic: they drive where they like, by the streets
// when you are out of sight (the GPS's router finds them the way) and straight at you when you are not. They ram,
// they box you in, and if they hold you at a standstill you are busted.
//
// Get out of their sight (round a corner, behind a building, far away) and stay out of it and the stars start to
// blink: they are searching where they last saw you. Stay hidden long enough and you have got away, which pays.
// Destroying cruisers is possible (combat.js) and makes everything worse.

const MAX_UNITS = 6;
const STARS_AT = [8, 45, 100, 180, 280]; // heat for 1..5 stars
const UNITS = [0, 2, 3, 4, 5, 6]; // cruisers after you, by stars
const TOP_SPEED = [0, 32, 36, 41, 46, 52]; // m/s
const HALF_W = 0.88;
const HALF_L = 2.2;
const SIGHT = 150;
const WHITE = [Math.fround(0.93), Math.fround(0.95), Math.fround(0.97)];
const BURNT = [Math.fround(0.028), Math.fround(0.026), Math.fround(0.025)];

const _p = new THREE.Vector3();
const _box = { cx: 0, cz: 0, cs: 1, sn: 0, hx: 0, hz: 0 };
const _sat = { nx: 0, nz: 0, pen: 0 };

// Two boxes in the plane (centre, heading, half width & half length each): the shortest way to push A clear of B,
// or null if they don't touch
function boxesOverlap(ax, az, ah, aw, al, bx, bz, bh, bw, bl) {
  const dx = ax - bx;
  const dz = az - bz;
  if (dx * dx + dz * dz > (al + bl + 1) ** 2) return null;
  const as = Math.sin(ah), ac = Math.cos(ah), bs = Math.sin(bh), bc = Math.cos(bh);
  let best = Infinity;
  // the four axes: each box's forward (sin, cos) and side (cos, -sin)
  for (let i = 0; i < 4; i++) {
    const ux = i === 0 ? as : i === 1 ? ac : i === 2 ? bs : bc;
    const uz = i === 0 ? ac : i === 1 ? -as : i === 2 ? bc : -bs;
    const ra = Math.abs(ux * as + uz * ac) * al + Math.abs(ux * ac - uz * as) * aw;
    const rb = Math.abs(ux * bs + uz * bc) * bl + Math.abs(ux * bc - uz * bs) * bw;
    const sep = dx * ux + dz * uz;
    const pen = ra + rb - Math.abs(sep);
    if (pen <= 0) return null;
    if (pen < best) {
      best = pen;
      const s = sep < 0 ? -1 : 1;
      _sat.nx = ux * s;
      _sat.nz = uz * s;
    }
  }
  _sat.pen = best;
  return _sat;
}

class PoliceSystem {
  constructor({ scene, controllers, traffic, routeFinder, cameraSystem, combat, fx, audio, onEvent = () => {} }) {
    this.controllers = controllers;
    this.traffic = traffic;
    this.routeFinder = routeFinder;
    this.cameraSystem = cameraSystem;
    this.combat = combat;
    this.fx = fx;
    this.audio = audio;
    this.onEvent = onEvent; // ('stars' | 'evaded' | 'busted' | 'cruiser' | 'collision', data)

    this.heat = 0;
    this.stars = 0;
    this.unseen = 0;
    this.searching = false;
    this.lastKnown = { x: 0, z: 0 };
    this.spawnTimer = 0;
    this.bust = 0;
    this.ramHeat = 0;
    this.clock = 0;
    this.destroyed = 0;
    this.playerX = this.playerZ = undefined;

    this.units = [];
    for (let i = 0; i < MAX_UNITS; i++) {
      this.units.push({
        id: i, active: false, dead: 0, hp: 0, fuse: -1, x: 0, y: 0, z: 0, heading: 0, speed: 0, vx: 0, vz: 0, vy: 0, spin: 0,
        tumble: 0, tumbleVel: 0, pitch: 0, roll: 0, pitchVel: 0, rollVel: 0, steer: 0, wheelSpin: 0,
        route: null, routeIndex: 0, repath: 0, sees: false, look: Math.random() * 0.3, stuck: 0, reverse: 0, gun: 1 + Math.random(), burn: 0,
        type: 'police'
      });
    }

    // One instanced cruiser body, light bar, wheels & contact shadow for the whole pursuit (the sedan the traffic
    // drives, in the service's white livery)
    const spec = this.spec = BODY_SPECS.sedan;
    const group = this.group = new THREE.Group();
    group.name = 'PolicePursuit';
    const bodyGeo = buildCarGeometry(spec, false);
    this.paint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_UNITS * 3), 3);
    this.state = new THREE.InstancedBufferAttribute(new Float32Array(MAX_UNITS * 4), 4);
    bodyGeo.setAttribute('paintColor', this.paint);
    bodyGeo.setAttribute('carState', this.state);
    this.bodies = new THREE.InstancedMesh(bodyGeo, createLoftedCarMaterial(spec), MAX_UNITS);
    this.bars = new THREE.InstancedMesh(buildLightbarGeometry(spec), createLightbarMaterial(), MAX_UNITS);
    const wheelMat = createLoftedCarMaterial(spec, 0xf5821f);
    this.wheelsL = new THREE.InstancedMesh(buildSteerableWheelGeo(spec, -1), wheelMat, MAX_UNITS * 2);
    this.wheelsR = new THREE.InstancedMesh(buildSteerableWheelGeo(spec, 1), wheelMat, MAX_UNITS * 2);
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI * 0.5);
    this.shadows = new THREE.InstancedMesh(plane, createContactShadowMaterial(), MAX_UNITS);
    this.shadows.renderOrder = 998;
    this.meshes = [this.bodies, this.bars, this.wheelsL, this.wheelsR, this.shadows];
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const m of this.meshes) {
      m.frustumCulled = false;
      m.castShadow = m.receiveShadow = m !== this.shadows;
      m.count = 1; // (one collapsed instance: the pipelines compile behind the loading screen)
      m.setMatrixAt(0, zero);
      group.add(m);
    }
    // The red & blue the nearest two throw on the street
    this.beacons = [];
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xff2030, 0, 26, 1.6);
      group.add(light);
      this.beacons.push(light);
    }
    scene.add(group);
    this.dummy = new THREE.Object3D();
    this.frames = 0;

    this.elWanted = document.getElementById('wanted');
    this.shown = { stars: -1, searching: null };
  }

  box(u, grow = 0) {
    _box.cx = u.x;
    _box.cz = u.z;
    _box.cs = Math.cos(u.heading);
    _box.sn = Math.sin(u.heading);
    _box.hx = HALF_W + grow;
    _box.hz = HALF_L + grow;
    return _box;
  }

  // A crime worth `heat`, committed at (x, z)
  crime(kind, heat, x, z) {
    this.heat = Math.min(380, this.heat + heat);
    let stars = 0;
    while (stars < 5 && this.heat >= STARS_AT[stars]) stars++;
    if (stars > this.stars) {
      const first = this.stars === 0;
      this.stars = stars;
      this.spawnTimer = Math.min(this.spawnTimer, first ? 0.8 : 0.2);
      this.onEvent('stars', { stars, kind });
    }
    if (this.stars > 0) {
      // (it gives away where you are)
      this.unseen = Math.min(this.unseen, 2);
      const me = this.controllers.getActiveEntity();
      this.lastKnown.x = Number.isFinite(x) ? x : me.position.x;
      this.lastKnown.z = Number.isFinite(z) ? z : me.position.z;
    }
  }

  // Call it off: the stars go, the cruisers still on the road drive away out of the pool
  clear() {
    this.heat = 0;
    this.stars = 0;
    this.unseen = 0;
    this.bust = 0;
    this.searching = false;
    for (const u of this.units) if (!u.dead) u.active = false;
  }

  spawn(player) {
    const u = this.units.find((o) => !o.active);
    if (!u) return false;
    const px = this.lastKnown.x;
    const pz = this.lastKnown.z;
    for (let attempt = 0; attempt < 10; attempt++) {
      // (more often than not from ahead: they cut you off)
      const ahead = Math.random() < 0.6 ? player.heading + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
      const r = 92 + Math.random() * 58;
      const found = this.routeFinder.nearestEdge(px + Math.sin(ahead) * r, pz + Math.cos(ahead) * r, 80);
      if (!found) continue;
      const d = Math.hypot(found.x - player.position.x, found.z - player.position.z);
      if (d < 75) continue;
      if (attempt < 7 && d < 160 && clearLine(this.controllers, found.x, found.z, player.position.x, player.position.z, 1.4)) continue;
      if (this.units.some((o) => o.active && Math.hypot(o.x - found.x, o.z - found.z) < 9)) continue;
      Object.assign(u, {
        active: true, dead: 0, hp: 130 + this.stars * 12, fuse: -1, x: found.x, y: 0, z: found.z,
        heading: Math.atan2(player.position.x - found.x, player.position.z - found.z), speed: 12, vx: 0, vz: 0, vy: 0, spin: 0,
        tumble: 0, tumbleVel: 0, pitch: 0, roll: 0, pitchVel: 0, rollVel: 0, steer: 0,
        route: null, routeIndex: 0, repath: 0, sees: false, stuck: 0, reverse: 0, jams: 0, gun: 1 + Math.random() * 1.5, burn: 0
      });
      return true;
    }
    return false;
  }

  // A bullet strikes a cruiser
  hitUnit(u, damage, dx, dz) {
    if (!u.active || u.dead) return;
    u.hp -= damage;
    u.vx += dx * 0.4;
    u.vz += dz * 0.4;
    this.crime('bullet', 3, u.x, u.z);
    if (u.hp <= 0 && u.fuse < 0) u.fuse = 0.02;
  }

  // An explosion of the given power, R metres across, at (x, z)
  blast(x, z, R, power) {
    for (const u of this.units) {
      if (!u.active) continue;
      const dx = u.x - x;
      const dz = u.z - z;
      const d = Math.hypot(dx, dz);
      const f = 1 - Math.max(0, d - 1.5) / R;
      if (f <= 0) continue;
      const nx = d > 0.2 ? dx / d : Math.random() - 0.5;
      const nz = d > 0.2 ? dz / d : Math.random() - 0.5;
      u.vx += nx * f * 13;
      u.vz += nz * f * 13;
      u.spin += (Math.random() - 0.5) * f * 6;
      u.rollVel += (Math.random() - 0.5) * f * 5;
      if (u.dead) continue;
      u.speed *= 1 - 0.6 * f;
      u.hp -= 240 * f * power;
      if (u.hp <= 0 && u.fuse < 0) u.fuse = 0.06 + Math.random() * 0.3;
    }
  }

  destroy(u) {
    if (u.dead) return;
    u.dead = 0.001;
    u.speed = 0;
    u.y = 0.01;
    u.vy = 7 + Math.random() * 4.5;
    u.tumbleVel = (Math.random() < 0.5 ? -1 : 1) * (2.6 + Math.random() * 4);
    u.spin += (Math.random() - 0.5) * 7;
    this.destroyed++;
    this.crime('cruiser', 42, u.x, u.z);
    this.onEvent('cruiser', { count: this.destroyed });
    this.combat.explode(u.x, 0.9, u.z, 1);
  }

  // Where a cruiser is heading: at you if it can see you close by, else along the streets to where you were last seen
  steerTarget(u, player, dist, dt) {
    const px = player.position.x;
    const pz = player.position.z;
    if (u.sees && dist < 75) {
      u.route = null;
      // (aimed ahead of a moving target, to cut it off rather than trail it)
      const lead = Math.min(1.1, dist / 38);
      const sin = Math.sin(player.heading || 0);
      const cos = Math.cos(player.heading || 0);
      const speed = player.speed || 0;
      _p.set(px + (sin * speed + (player.vx || 0)) * lead, 0, pz + (cos * speed + (player.vz || 0)) * lead);
      return _p;
    }
    const gx = this.searching ? this.lastKnown.x : px;
    const gz = this.searching ? this.lastKnown.z : pz;
    u.repath -= dt;
    if (!u.route || u.repath <= 0) {
      u.repath = 1.3 + Math.random() * 0.6;
      u.route = this.routeFinder.route(u.x, u.z, gx, gz, u.heading);
      u.routeIndex = 0;
    }
    const points = u.route ? u.route.points : null;
    if (!points || points.length < 2) return _p.set(gx, 0, gz);
    const reach = 7 + Math.abs(u.speed) * 0.45;
    while (u.routeIndex < points.length - 1 && Math.hypot(points[u.routeIndex].x - u.x, points[u.routeIndex].z - u.z) < reach) u.routeIndex++;
    const pt = points[u.routeIndex];
    return _p.set(pt.x, 0, pt.z);
  }

  updateUnit(u, dt, player, mode, hidden) {
    const controllers = this.controllers;
    const traffic = this.traffic;
    const px = player.position.x;
    const pz = player.position.z;
    const dist = Math.hypot(px - u.x, pz - u.z);

    // knocked about by blasts & collisions
    u.x += u.vx * dt;
    u.z += u.vz * dt;
    const damp = Math.exp(-dt * 4.2);
    u.vx *= damp;
    u.vz *= damp;
    u.heading += u.spin * dt;
    u.spin *= Math.exp(-dt * 3.5);

    if (u.dead) {
      // a wreck: thrown up, rolling, burning where it lands, cleared away later
      u.dead += dt;
      if (u.y > 0 || u.vy > 0) {
        u.vy -= 21 * dt;
        u.y += u.vy * dt;
        u.tumble += u.tumbleVel * dt;
        if (u.y <= 0) {
          if (u.vy < -4.5) {
            this.fx.dust(u.x, 0, u.z, 2);
            traffic.sparks(u.x, 0.2, u.z, Math.sin(u.heading), Math.cos(u.heading), -u.vy);
            u.vy *= -0.3;
            u.y = 0.01;
            u.tumbleVel *= 0.45;
          } else {
            u.y = u.vy = u.tumbleVel = 0;
          }
        }
      } else {
        const rest = Math.round(u.tumble / Math.PI) * Math.PI;
        u.tumble += (rest - u.tumble) * Math.min(1, dt * 9);
      }
      const heat = Math.max(0, 1 - u.dead / 16);
      u.burn += dt * (5 + heat * 9);
      while (u.burn >= 1) {
        u.burn -= 1;
        this.fx.burn(u.x, u.y, u.z, heat);
      }
      if (u.dead > 24) u.active = false;
    } else {
      if (u.fuse >= 0) {
        u.fuse -= dt;
        if (u.fuse < 0) return this.destroy(u);
      }
      // 1. Can it see you? (looked for a few times a second)
      u.look -= dt;
      if (u.look <= 0) {
        u.look = 0.22 + Math.random() * 0.1;
        u.sees = !hidden && dist < SIGHT && clearLine(controllers, u.x, u.z, px, pz, 1.4);
      }

      // 2. Steering & speed
      const target = this.steerTarget(u, player, dist, dt);
      let diff = angleBetween(Math.atan2(target.x - u.x, target.z - u.z), u.heading);
      const sin = Math.sin(u.heading);
      const cos = Math.cos(u.heading);
      // round whatever traffic is in the way
      let blockAhead = Infinity;
      for (const v of traffic.vehicles) {
        if (!v.edge) continue;
        const dx = v.x - u.x;
        const dz = v.z - u.z;
        if (Math.abs(dx) > 22 || Math.abs(dz) > 22) continue;
        const along = dx * sin + dz * cos;
        const across = dx * cos - dz * sin;
        if (along > 1 && along < 9 + Math.abs(u.speed) * 0.5 && Math.abs(across) < 2.1 && along < blockAhead) {
          blockAhead = along;
          diff += (across > 0 ? -1 : 1) * 0.5 * (1 - Math.abs(across) / 2.1 + 0.3);
        }
        // contact: they shunt it aside
        const reach = 1.45 + v.half * 0.72;
        const d = Math.hypot(dx, dz);
        if (d < reach && d > 0.01) {
          const nx = dx / d;
          const nz = dz / d;
          const closing = (sin * u.speed + u.vx - v.tx * v.speed - v.vx) * nx + (cos * u.speed + u.vz - v.tz * v.speed - v.vz) * nz;
          u.x -= nx * (reach - d) * 0.7;
          u.z -= nz * (reach - d) * 0.7;
          if (closing > 0.5) {
            traffic.pushVehicle(v, nx * closing * 0.6, nz * closing * 0.6, (Math.random() - 0.5) * closing * 0.2);
            u.speed *= 0.72;
            u.hp -= closing * 0.8;
            if (closing > 3) {
              traffic.sparks(u.x + nx * 1.4, 0.55, u.z + nz * 1.4, nx, nz, closing);
              this.onEvent('collision', { a: u, b: v, x: u.x + nx * 1.4, y: 0.55, z: u.z + nz * 1.4, speed: closing });
            }
          }
        }
      }
      const level = Math.max(1, this.stars);
      let want = TOP_SPEED[level] * (1 - 0.74 * Math.min(1, Math.abs(diff) / 1.05));
      if (u.sees && dist < 28) want = Math.max(want, Math.min(TOP_SPEED[level] + 8, Math.abs(player.speed || 0) + 8));
      if (this.searching && Math.hypot(this.lastKnown.x - u.x, this.lastKnown.z - u.z) < 30) want = Math.min(want, 9); // (looking about)
      if (hidden && !this.searching) want = 0;
      let turn = diff;
      if (u.reverse > 0) {
        u.reverse -= dt;
        want = -5.5;
        turn = -diff;
      }
      u.speed += Math.max(-17 * dt, Math.min(8.5 * dt, want - u.speed));
      const maxYaw = Math.min(2.3, 12.5 / Math.max(Math.abs(u.speed), 3.5));
      const yawRate = Math.max(-maxYaw, Math.min(maxYaw, turn * 4)) * Math.min(1, Math.abs(u.speed) / 2.5) * Math.sign(u.speed || 1);
      u.heading += yawRate * dt;
      u.steer += (Math.max(-0.55, Math.min(0.55, turn)) - u.steer) * Math.min(1, dt * 9);
      const beforeX = u.x + Math.sin(u.heading) * u.speed * dt;
      const beforeZ = u.z + Math.cos(u.heading) * u.speed * dt;
      u.x = beforeX;
      u.z = beforeZ;

      // 3. Buildings stop it (and cost it): stuck against one, it backs off and tries again
      _p.set(u.x, 0, u.z);
      controllers.resolveHorizontalCollision(_p, 1.3, 1.0, null, null);
      const moved = Math.hypot(_p.x - beforeX, _p.z - beforeZ);
      u.x = _p.x;
      u.z = _p.z;
      if (moved > 0.01) {
        const nx = (_p.x - beforeX) / moved;
        const nz = (_p.z - beforeZ) / moved;
        const into = -(Math.sin(u.heading) * nx + Math.cos(u.heading) * nz) * u.speed;
        if (into > 7) {
          // (a real crash, nose first: it costs the cruiser)
          traffic.sparks(u.x - nx * 1.2, 0.55, u.z - nz * 1.2, nx, nz, into);
          this.onEvent('collision', { a: u, b: controllers, x: u.x, y: 0.55, z: u.z, speed: into });
          u.hp -= into * 0.9;
          u.speed *= 0.35;
        } else if (into > 0) {
          u.speed *= Math.exp(-dt * 2.5);
        }
        u.stuck += dt * 2;
      }
      if (Math.abs(u.speed) < 2.5 && want > 6) u.stuck += dt;
      else u.stuck = Math.max(0, u.stuck - dt * 0.5);
      if (u.stuck > 1.1 && u.reverse <= 0) {
        u.stuck = 0;
        u.reverse = 1.0 + Math.random() * 0.5;
        u.route = null;
        // (hopelessly wedged somewhere out of sight: another cruiser takes over)
        if (++u.jams >= 3 && !u.sees) u.active = false;
      }
      if (u.hp <= 0 && u.fuse < 0) u.fuse = 0.3;

      // 4. Whoever is on foot in its way
      if (Math.abs(u.speed) > 5) {
        for (const p of traffic.peds) {
          if (!p.placed || Math.abs(p.x - u.x) > 2.6 || Math.abs(p.z - u.z) > 2.6) continue;
          const dx = p.x - u.x;
          const dz = p.z - u.z;
          if (Math.abs(dx * cos - dz * sin) < HALF_W + 0.25 && Math.abs(dx * sin + dz * cos) < HALF_L + 0.25) {
            traffic.flingPed(p, sin * u.speed * 0.5, 1.5 + Math.abs(u.speed) * 0.08, cos * u.speed * 0.5, false);
          }
        }
      }

      // 5. You
      if (mode !== 'helicopter' && player.position.y < 2.5) this.collide(u, player, mode);

      // 6. From three stars they shoot
      if (this.stars >= 3 && u.sees && dist < 60 && dist > 5 && mode !== 'helicopter') {
        u.gun -= dt;
        if (u.gun <= 0) {
          u.gun = (0.35 + Math.random() * 0.9) / (this.stars - 1.6);
          this.shoot(u, player, dist, mode);
        }
      }
      if (dist > 420) u.active = false; // left far behind: another one takes its place nearer by
      // smoking, once it has taken a beating
      if (u.hp < 60) {
        u.burn += dt * (60 - u.hp) * 0.1;
        while (u.burn >= 1) {
          u.burn -= 1;
          this.fx.smoke.emit(u.x + sin * 1.5, 1.0, u.z + cos * 1.5, sin * u.speed * 0.5, 1.6, cos * u.speed * 0.5, 1.4, 0.5, 2.4, 0.3, 0.3, 0.3, 0.3, 0.6, 1.2);
        }
      }
    }

    // the body on its springs
    u.pitchVel += (-u.pitch * 68 - u.pitchVel * 10.8) * dt;
    u.pitch = Math.max(-0.22, Math.min(0.22, u.pitch + u.pitchVel * dt));
    const lean = u.dead ? 0 : 0.012 * u.speed * Math.max(-1.2, Math.min(1.2, u.steer * 2));
    u.rollVel += ((lean - u.roll) * 68 - u.rollVel * 10.8) * dt;
    u.roll = Math.max(-0.26, Math.min(0.26, u.roll + u.rollVel * dt));
    u.wheelSpin = (u.wheelSpin + (u.speed * dt) / this.spec.wheelRadius) % (Math.PI * 2);
  }

  // Cruiser against the player: pushed apart, momentum traded, the car hurt by how hard they met
  collide(u, player, mode) {
    const pw = mode === 'car' ? 0.94 : mode === 'cyclist' ? 0.35 : 0.32;
    const pl = mode === 'car' ? 2.32 : mode === 'cyclist' ? 0.85 : 0.32;
    const hit = boxesOverlap(player.position.x, player.position.z, player.heading || 0, pw, pl, u.x, u.z, u.heading, HALF_W, HALF_L);
    if (!hit) return;
    const { nx, nz, pen } = hit; // (from the cruiser towards the player)
    const share = mode === 'car' ? 0.5 : 0.9;
    player.position.x += nx * pen * share;
    player.position.z += nz * pen * share;
    if (player.mesh) player.mesh.position.copy(player.position);
    u.x -= nx * pen * (1 - share);
    u.z -= nz * pen * (1 - share);
    const ps = Math.sin(player.heading || 0);
    const pc = Math.cos(player.heading || 0);
    const speed = player.speed || 0;
    const pvx = ps * speed + (player.vx || 0);
    const pvz = pc * speed + (player.vz || 0);
    const uvx = Math.sin(u.heading) * u.speed + u.vx;
    const uvz = Math.cos(u.heading) * u.speed + u.vz;
    const closing = (uvx - pvx) * nx + (uvz - pvz) * nz;
    if (closing <= 0.3) return;
    const cx = (player.position.x + u.x) * 0.5;
    const cz = (player.position.z + u.z) * 0.5;
    u.vx -= nx * closing * 0.55;
    u.vz -= nz * closing * 0.55;
    u.speed *= 0.6;
    u.spin += (nx * Math.cos(u.heading) - nz * Math.sin(u.heading)) * Math.min(2.5, closing * 0.18);
    u.hp -= closing * 1.6;
    if (mode === 'car') {
      player.takeHit?.(closing * 0.85);
      player.vx = (player.vx || 0) + nx * closing * 0.55;
      player.vz = (player.vz || 0) + nz * closing * 0.55;
      player.speed *= 1 - 0.3 * Math.abs(ps * nx + pc * nz);
      // struck off-centre, it is spun (the PIT manoeuvre)
      const rx = (cx - player.position.x) * pc - (cz - player.position.z) * ps;
      const rz = (cx - player.position.x) * ps + (cz - player.position.z) * pc;
      const lnx = nx * pc - nz * ps;
      const lnz = nx * ps + nz * pc;
      player.angularVel = (player.angularVel || 0) + (rz * lnx - rx * lnz) * Math.min(3.2, closing * 0.2);
      player.pitchVel = (player.pitchVel || 0) + lnz * Math.min(14, closing) * 0.18;
      player.rollVel = (player.rollVel || 0) - lnx * Math.min(14, closing) * 0.24;
      player.heaveVel = (player.heaveVel || 0) + Math.min(1.4, closing * 0.11);
    }
    if (closing > 1.8) {
      this.traffic.sparks(cx, 0.58, cz, nx, nz, closing);
      this.onEvent('collision', { a: player, b: u, x: cx, y: 0.58, z: cz, speed: closing });
    }
    // (ramming them is a crime of its own, though not one worth much)
    if (closing > 5 && this.clock - this.ramHeat > 1.2 && (pvx * -nx + pvz * -nz) > 4) {
      this.ramHeat = this.clock;
      this.crime('ram', 5, cx, cz);
    }
  }

  shoot(u, player, dist, mode) {
    const fx = this.fx;
    const ox = u.x + Math.cos(u.heading) * 0.8;
    const oz = u.z - Math.sin(u.heading) * 0.8;
    const oy = 1.15;
    const tx = player.position.x;
    const ty = player.position.y + 0.8;
    const tz = player.position.z;
    // (harder to hit the faster you go and the further off you are)
    const chance = Math.max(0.08, 0.42 - Math.abs(player.speed || 0) * 0.006 - dist * 0.003);
    const hit = mode === 'car' && Math.random() < chance;
    const miss = hit ? 0.3 : 1.5 + dist * 0.05;
    const ex = tx + (Math.random() - 0.5) * miss * 2;
    const ey = ty + (Math.random() - 0.5) * miss;
    const ez = tz + (Math.random() - 0.5) * miss * 2;
    const d = Math.hypot(ex - ox, ey - oy, ez - oz) || 1;
    const over = hit ? 1 : 1.6;
    fx.tracer(ox, oy, oz, ox + (ex - ox) * over, oy + (ey - oy) * over, oz + (ez - oz) * over, 8, 3.2, 1.2);
    fx.muzzle(ox, oy, oz, (ex - ox) / d, (ey - oy) / d, (ez - oz) / d, 0.6);
    const camera = this.cameraSystem.camera;
    this.audio.shot(Math.hypot(camera.position.x - ox, camera.position.z - oz));
    if (hit) {
      fx.impact(ex, ey, ez, (ox - ex) / d, (oz - ez) / d, true);
      this.controllers.hurtCar(1.5 + this.stars * 0.35);
      this.cameraSystem.shake(0.24);
    }
  }

  render(camera) {
    const d = this.dummy;
    const spec = this.spec;
    const paint = this.paint.array;
    const state = this.state.array;
    let n = 0;
    let bars = 0;
    let wheels = 0;
    for (const u of this.units) {
      if (!u.active) continue;
      const dead = u.dead > 0;
      d.position.set(u.x, dead ? u.y + (1 - Math.cos(u.tumble)) * 0.72 : 0, u.z);
      d.rotation.set(u.pitch, u.heading, u.roll + (dead ? u.tumble : 0), 'YXZ');
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      this.bodies.setMatrixAt(n, d.matrix);
      const coat = dead ? BURNT : WHITE;
      paint[n * 3] = coat[0];
      paint[n * 3 + 1] = coat[1];
      paint[n * 3 + 2] = coat[2];
      state[n * 4] = !dead && u.speed < 1 ? 1 : 0;
      state[n * 4 + 1] = state[n * 4 + 2] = 0;
      state[n * 4 + 3] = dead ? 0 : 1;
      if (!dead) {
        this.bars.setMatrixAt(bars++, d.matrix);
        const sin = Math.sin(u.heading);
        const cos = Math.cos(u.heading);
        for (let w = 0; w < 2; w++) {
          const wz = w === 0 ? spec.wheelZ : -spec.wheelZ;
          d.rotation.set(u.wheelSpin + w * 0.55, u.heading + (w === 0 ? u.steer : 0), u.roll, 'YXZ');
          d.position.set(u.x - spec.wheelX * cos + wz * sin, spec.wheelRadius, u.z + spec.wheelX * sin + wz * cos);
          d.updateMatrix();
          this.wheelsL.setMatrixAt(wheels, d.matrix);
          d.position.set(u.x + spec.wheelX * cos + wz * sin, spec.wheelRadius, u.z - spec.wheelX * sin + wz * cos);
          d.updateMatrix();
          this.wheelsR.setMatrixAt(wheels++, d.matrix);
        }
      }
      d.rotation.set(0, u.heading, 0, 'YXZ');
      d.position.set(u.x, 0.018, u.z);
      d.scale.set(2.22, 1, 5.05);
      d.updateMatrix();
      this.shadows.setMatrixAt(n, d.matrix);
      n++;
    }
    // (the collapsed instance stays for the first frames, see the constructor)
    const warm = ++this.frames <= 3;
    const sync = (mesh, count) => {
      if (count === 0 && warm) return;
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    };
    sync(this.bodies, n);
    sync(this.bars, bars);
    sync(this.wheelsL, wheels);
    sync(this.wheelsR, wheels);
    sync(this.shadows, n);
    if (n > 0) {
      this.paint.needsUpdate = true;
      this.state.needsUpdate = true;
    }

    // The beacons of the two nearest the camera, red and blue by turns
    const live = this.units.filter((u) => u.active && !u.dead)
      .sort((a, b) => Math.hypot(a.x - camera.position.x, a.z - camera.position.z) - Math.hypot(b.x - camera.position.x, b.z - camera.position.z));
    for (let i = 0; i < this.beacons.length; i++) {
      const light = this.beacons[i];
      const u = live[i];
      if (!u) {
        light.intensity = 0;
        continue;
      }
      const phase = (this.clock * 1.6 + i * 0.5) % 1;
      const red = phase < 0.5;
      light.color.setHex(red ? 0xff2030 : 0x2a6cff);
      light.intensity = (phase * 12) % 1 < 0.5 ? 260 : 60;
      light.position.set(u.x, 1.9, u.z);
    }
    return live;
  }

  update(dt, mode, camera) {
    this.clock += dt;
    const player = this.controllers.getActiveEntity();
    const hidden = mode === 'helicopter'; // (nobody is looking up)
    // (a teleport, or the car's restart after a wreck: the pursuit doesn't follow)
    const jump = this.playerEntity === player
      ? Math.hypot(player.position.x - (this.playerX ?? player.position.x), player.position.z - (this.playerZ ?? player.position.z)) : 0;
    this.playerEntity = player;
    this.playerX = player.position.x;
    this.playerZ = player.position.z;
    if (jump > 60 && this.stars > 0) this.clear();
    const wrecked = mode === 'car' && player.wrecked > 0;

    if (this.stars > 0 && !wrecked) {
      // 1. Enough of them on the road
      this.spawnTimer -= dt;
      const want = UNITS[this.stars];
      const alive = this.units.reduce((n, u) => n + (u.active && !u.dead ? 1 : 0), 0);
      if (alive < want && this.spawnTimer <= 0) {
        this.spawnTimer = this.spawn(player) ? 1.4 - this.stars * 0.15 : 0.4;
      }
    }

    let seen = false;
    let close = false;
    for (const u of this.units) {
      if (!u.active) continue;
      if (this.stars === 0 && !u.dead) {
        u.active = false;
        continue;
      }
      this.updateUnit(u, dt, player, mode, hidden || wrecked);
      if (!u.active || u.dead) continue;
      if (u.sees) seen = true;
      if (u.sees && Math.abs(u.speed) < 5 && Math.hypot(u.x - player.position.x, u.z - player.position.z) < 7.5) close = true;
    }
    // cruisers keep off each other
    for (let i = 0; i < this.units.length; i++) {
      const a = this.units[i];
      if (!a.active) continue;
      for (let j = i + 1; j < this.units.length; j++) {
        const b = this.units[j];
        if (!b.active) continue;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const d = Math.hypot(dx, dz);
        if (d > 3.4 || d < 0.01) continue;
        const push = (3.4 - d) * 0.5;
        if (!a.dead || b.dead) { a.x += (dx / d) * push; a.z += (dz / d) * push; }
        if (!b.dead || a.dead) { b.x -= (dx / d) * push; b.z -= (dz / d) * push; }
        if (!a.dead) a.speed *= 0.96;
        if (!b.dead) b.speed *= 0.96;
      }
    }

    if (this.stars > 0) {
      // 2. Seen, or searched for
      if (seen) {
        this.unseen = 0;
        this.lastKnown.x = player.position.x;
        this.lastKnown.z = player.position.z;
      } else {
        this.unseen += dt;
      }
      this.searching = this.unseen > 2.5;
      if (this.unseen > 9 + this.stars * 4) {
        const stars = this.stars;
        this.clear();
        this.onEvent('evaded', { stars });
      }
      // 3. Held at a standstill with a cruiser on you: busted
      const still = Math.abs(player.speed || 0) < 1.6 && Math.hypot(player.vx || 0, player.vz || 0) < 1.5;
      this.bust = close && still && !wrecked && mode !== 'helicopter' ? this.bust + dt : Math.max(0, this.bust - dt * 2);
      if (this.bust > 2.4) {
        const stars = this.stars;
        this.clear();
        for (const u of this.units) if (!u.dead) u.active = false;
        this.onEvent('busted', { stars });
      }
    }

    const live = this.render(camera);
    // the sirens of whoever is nearest
    let nearest = Infinity;
    let side = 0;
    for (const u of live) {
      const dx = u.x - camera.position.x;
      const dz = u.z - camera.position.z;
      const d = Math.hypot(dx, dz);
      if (d < nearest) {
        nearest = d;
        const e = camera.matrixWorld.elements; // (its right-hand axis)
        side = d > 1 ? (dx * e[0] + dz * e[2]) / d : 0;
      }
    }
    this.audio.setSiren(nearest, side, live.length);

    // The stars
    if (this.elWanted && (this.stars !== this.shown.stars || this.searching !== this.shown.searching)) {
      this.shown.stars = this.stars;
      this.shown.searching = this.searching;
      this.elWanted.hidden = this.stars === 0;
      this.elWanted.dataset.state = this.searching ? 'searching' : 'chase';
      const stars = this.elWanted.querySelectorAll('.wanted-star');
      stars.forEach((el, i) => el.classList.toggle('is-on', i < this.stars));
      this.elWanted.setAttribute('aria-label', `Wanted level ${this.stars} of 5${this.searching ? ', out of sight' : ''}`);
    }
    document.body.classList.toggle('is-wanted', this.stars > 0);
  }
}

export { PoliceSystem, boxesOverlap, STARS_AT };
