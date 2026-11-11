import * as THREE from 'three/webgpu';
import { mrt, vec4, attribute, uniform, uv, length, smoothstep } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';

// js/action-fx.js
// What the shooting looks like: fireballs, the black smoke that rolls up out of them, showers of sparks, bits of
// car, the shock wave racing out along the road, the scorch it leaves, tracers, rocket exhaust and the light all of
// it throws on the street. Everything is a handful of instanced draws fed from fixed pools (the oldest particle
// makes way for the newest), so a pile-up of explosions costs no more than one.

// Effects drawn over the scene leave its normals & reflectivity as they were (see car-effects.js)
const KEEP_SURFACE = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const rnd = (a, b) => a + Math.random() * (b - a);

function tintAttribute(geometry, count, size) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('tint', attr);
  return attr;
}

// (one collapsed instance until the first particle: the pipeline compiles behind the loading screen)
function finishPool(mesh, n) {
  if (n === 0) {
    if (mesh.count === 0) return;
    if (!mesh.userData.drawn) {
      mesh.setMatrixAt(0, ZERO);
      mesh.count = 1;
      mesh.instanceMatrix.needsUpdate = true;
    } else {
      mesh.count = 0;
    }
    mesh.userData.drawn = true;
    return;
  }
  mesh.userData.drawn = true;
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.geometry.attributes.tint.needsUpdate = true;
}

// Soft round puffs that face the camera. Fire is added to the picture (and blooms); smoke covers it
class Billboards {
  constructor(parent, name, count, additive) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.tint = tintAttribute(geo, count, 4);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    if (additive) mat.blending = THREE.AdditiveBlending;
    const t = attribute('tint', 'vec4');
    this.light = uniform(1);
    mat.colorNode = additive ? t.rgb : t.rgb.mul(this.light);
    const r = length(uv().sub(0.5));
    mat.opacityNode = t.a.mul(additive ? smoothstep(0.5, 0.0, r).pow(1.6) : smoothstep(0.5, 0.1, r));
    mat.mrtNode = KEEP_SURFACE;
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 8 : 7;
    this.mesh.count = 1;
    this.mesh.setMatrixAt(0, ZERO);
    parent.add(this.mesh);
    this.max = count;
    this.list = [];
    this.additive = additive;
    this.dummy = new THREE.Object3D();
  }

  // r, g, b: fire's colour at its hottest / smoke's shade
  emit(x, y, z, vx, vy, vz, life, size, grow, opacity, r, g, b, rise = 0, drag = 1.6) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ x, y, z, vx, vy, vz, age: 0, life, size, grow, opacity, r, g, b, rise, drag, spin: Math.random() * 6.28 });
  }

  update(dt, camera) {
    const list = this.list;
    const d = this.dummy;
    const T = this.tint.array;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      const drag = Math.exp(-dt * p.drag);
      p.vx *= drag;
      p.vz *= drag;
      p.vy = p.vy * drag + p.rise * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      d.position.set(p.x, p.y, p.z);
      d.quaternion.copy(camera.quaternion);
      d.rotateZ(p.spin + k * (this.additive ? 1.6 : 0.7));
      d.scale.setScalar(p.size + p.grow * (1 - (1 - k) * (1 - k)));
      d.updateMatrix();
      this.mesh.setMatrixAt(n, d.matrix);
      const o = n * 4;
      if (this.additive) {
        // white-hot, then orange, then a dull red as it burns out
        const cool = k * k;
        T[o] = p.r;
        T[o + 1] = p.g * (1 - 0.72 * k);
        T[o + 2] = p.b * (1 - cool) * (1 - k);
        T[o + 3] = p.opacity * Math.min(1, k * 14) * (1 - k) ** 1.4;
      } else {
        T[o] = p.r;
        T[o + 1] = p.g;
        T[o + 2] = p.b;
        T[o + 3] = p.opacity * Math.min(1, k * 7) * (1 - k) ** 1.5;
      }
      list[n++] = p;
    }
    list.length = n;
    finishPool(this.mesh, n);
  }
}

// Things that fly: sparks & tracers (bright streaks along the way they go) and debris (dark tumbling chunks)
class Streaks {
  constructor(parent, count) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.tint = tintAttribute(geo, count, 3);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = attribute('tint', 'vec3');
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.name = 'ActionStreaks';
    this.mesh.frustumCulled = false;
    this.mesh.count = 1;
    this.mesh.setMatrixAt(0, ZERO);
    parent.add(this.mesh);
    this.max = count;
    this.list = [];
    this.dummy = new THREE.Object3D();
  }

  // kind: 0 spark, 1 tracer (no gravity, dies at the end of its flight), 2 debris
  emit(kind, x, y, z, vx, vy, vz, life, width, r, g, b) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ kind, x, y, z, vx, vy, vz, age: 0, life, width, r, g, b, spin: Math.random() * 6.28, spinVel: rnd(-14, 14) });
  }

  update(dt, groundAt) {
    const list = this.list;
    const d = this.dummy;
    const T = this.tint.array;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      if (p.kind !== 1) {
        p.vy -= (p.kind === 2 ? 19 : 22) * dt;
        const floor = groundAt(p.x, p.z) + 0.04;
        if (p.y + p.vy * dt < floor && p.vy < 0) {
          p.y = floor;
          p.vy = -p.vy * (p.kind === 2 ? 0.32 : 0.45);
          p.vx *= 0.7;
          p.vz *= 0.7;
          p.spinVel *= 0.5;
        }
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const flat = Math.hypot(p.vx, p.vz) || 0.001;
      d.position.set(p.x, p.y, p.z);
      if (p.kind === 2) {
        p.spin += p.spinVel * dt;
        d.rotation.set(p.spin, p.spin * 0.7, p.spin * 1.3);
        d.scale.set(p.width * 2.2, p.width, p.width * 3.4);
      } else {
        d.rotation.set(-Math.atan2(p.vy, flat), Math.atan2(p.vx, p.vz), 0, 'YXZ');
        const speed = Math.hypot(flat, p.vy);
        const fade = p.kind === 1 ? 1 : 1 - k;
        d.scale.set(p.width * fade, p.width * fade, p.kind === 1 ? Math.min(9, speed * 0.028) : Math.max(0.12, Math.min(1.5, speed * 0.05)) * fade);
      }
      d.updateMatrix();
      this.mesh.setMatrixAt(n, d.matrix);
      const o = n * 3;
      const glow = p.kind === 0 ? 1 - k * 0.7 : 1;
      T[o] = p.r * glow;
      T[o + 1] = p.g * glow;
      T[o + 2] = p.b * glow;
      list[n++] = p;
    }
    list.length = n;
    finishPool(this.mesh, n);
  }
}

// Flat on the road: the shock wave's ring (bright, gone in half a second) and the scorch a blast leaves (for a minute)
class GroundMarks {
  constructor(parent, name, count, ring) {
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI * 0.5);
    this.tint = tintAttribute(geo, count, 4);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    if (ring) mat.blending = THREE.AdditiveBlending;
    const t = attribute('tint', 'vec4');
    const r = length(uv().sub(0.5)).mul(2);
    mat.colorNode = t.rgb;
    mat.opacityNode = t.a.mul(ring ? smoothstep(0.62, 0.9, r).mul(smoothstep(1.0, 0.93, r)) : smoothstep(1.0, 0.2, r));
    mat.mrtNode = KEEP_SURFACE;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -3;
    mat.polygonOffsetUnits = -3;
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ring ? 5 : 3;
    this.mesh.count = 1;
    this.mesh.setMatrixAt(0, ZERO);
    parent.add(this.mesh);
    this.max = count;
    this.list = [];
    this.ring = ring;
    this.dummy = new THREE.Object3D();
  }

  emit(x, y, z, size, grow, life, r, g, b, opacity) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ x, y, z, size, grow, life, age: 0, r, g, b, opacity });
  }

  update(dt) {
    const list = this.list;
    const d = this.dummy;
    const T = this.tint.array;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      d.position.set(p.x, p.y, p.z);
      d.scale.setScalar(p.size + p.grow * (1 - (1 - k) ** 3));
      d.updateMatrix();
      this.mesh.setMatrixAt(n, d.matrix);
      const o = n * 4;
      T[o] = p.r;
      T[o + 1] = p.g;
      T[o + 2] = p.b;
      T[o + 3] = p.opacity * (this.ring ? (1 - k) ** 2 : Math.min(1, (1 - k) * 4));
      list[n++] = p;
    }
    list.length = n;
    finishPool(this.mesh, n);
  }
}

class ActionFX {
  // groundAt(x, z): the height of the road or sidewalk there
  constructor(scene, groundAt = () => 0) {
    const group = this.group = new THREE.Group();
    group.name = 'ActionFX';
    scene.add(group);
    this.groundAt = groundAt;
    this.scorch = new GroundMarks(group, 'ActionScorch', 40, false);
    this.rings = new GroundMarks(group, 'ActionShockwaves', 10, true);
    this.smoke = new Billboards(group, 'ActionSmoke', 380, false);
    this.fire = new Billboards(group, 'ActionFire', 320, true);
    this.streaks = new Streaks(group, 520);
    // The light a blast throws on the street: a few point lights handed round, off until something goes up
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffa24a, 0, 90, 2);
      light.userData.level = 0;
      group.add(light);
      this.lights.push(light);
    }
    this.muzzleLight = new THREE.PointLight(0xffc27a, 0, 22, 2);
    group.add(this.muzzleLight);
    this.nextLight = 0;
  }

  flashLight(x, y, z, level) {
    const light = this.lights[this.nextLight];
    this.nextLight = (this.nextLight + 1) % this.lights.length;
    light.position.set(x, y, z);
    light.userData.level = level;
  }

  // A fireball of the given power (1 = a car going up) on ground at height `ground`
  explosion(x, y, z, power = 1, ground = this.groundAt(x, z)) {
    const s = Math.sqrt(power);
    const fire = this.fire;
    const smoke = this.smoke;
    // the flash, then the ball of fire boiling up and out
    fire.emit(x, y + 0.6, z, 0, 0, 0, 0.14, 9 * s, 6 * s, 1, 9, 7.5, 5, 0, 0);
    for (let i = 0, n = Math.round(15 * s); i < n; i++) {
      const a = Math.random() * 6.28;
      const out = rnd(2, 9) * s;
      const up = rnd(1.5, 8) * s;
      fire.emit(x + Math.cos(a) * rnd(0, 0.9) * s, y + rnd(0.2, 1.2) * s, z + Math.sin(a) * rnd(0, 0.9) * s,
        Math.cos(a) * out, up, Math.sin(a) * out, rnd(0.45, 1.0), rnd(1.4, 2.4) * s, rnd(2.5, 4.6) * s, 0.9, 5.2, 2.5, 0.7, 2.5, 2.6);
    }
    // black smoke climbing out of it, and the dust the pressure wave kicks along the road
    for (let i = 0, n = Math.round(13 * s); i < n; i++) {
      const a = Math.random() * 6.28;
      const out = rnd(1, 4.5) * s;
      const shade = rnd(0.03, 0.11);
      smoke.emit(x + Math.cos(a) * rnd(0, 1.2) * s, y + rnd(0.4, 2.0) * s, z + Math.sin(a) * rnd(0, 1.2) * s,
        Math.cos(a) * out, rnd(2.5, 6.5) * s, Math.sin(a) * out, rnd(2.6, 5.2), rnd(1.6, 2.6) * s, rnd(5, 8.5) * s, 0.62, shade, shade, shade, 1.2, 1.1);
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.28 + Math.random() * 0.4;
      const out = rnd(7, 13) * s;
      smoke.emit(x + Math.cos(a) * s, ground + 0.35, z + Math.sin(a) * s, Math.cos(a) * out, rnd(0.2, 1.2), Math.sin(a) * out,
        rnd(0.9, 1.6), 1.2 * s, rnd(3.5, 5.5) * s, 0.3, 0.42, 0.39, 0.35, 0, 2.6);
    }
    // sparks & what is left of the bodywork
    for (let i = 0, n = Math.round(38 * s); i < n; i++) {
      const a = Math.random() * 6.28;
      const out = rnd(4, 26) * s;
      this.streaks.emit(0, x, y + 0.5, z, Math.cos(a) * out, rnd(3, 22) * s, Math.sin(a) * out, rnd(0.5, 1.3), rnd(0.04, 0.075), 7, 3.4, 0.6);
    }
    for (let i = 0, n = Math.round(9 * s); i < n; i++) {
      const a = Math.random() * 6.28;
      const out = rnd(3, 13) * s;
      const shade = rnd(0.01, 0.05);
      this.streaks.emit(2, x, y + 0.8, z, Math.cos(a) * out, rnd(6, 16) * s, Math.sin(a) * out, rnd(1.6, 3.2), rnd(0.07, 0.16), shade, shade, shade);
    }
    this.rings.emit(x, ground + 0.05, z, 1.2 * s, 15 * s, 0.5, 3.2, 2.3, 1.3, 0.85);
    this.scorch.emit(x, ground + 0.03, z, 3.4 * s, 0.8 * s, 70, 0.006, 0.005, 0.004, 0.8);
    this.flashLight(x, y + 2.2, z, 5500 * power);
  }

  // A bullet striking metal (sparks), a wall or the road (dust)
  impact(x, y, z, nx, nz, metal) {
    for (let i = 0, n = metal ? 5 : 2; i < n; i++) {
      this.streaks.emit(0, x, y, z, nx * rnd(2, 9) + rnd(-4, 4), rnd(1, 7), nz * rnd(2, 9) + rnd(-4, 4), rnd(0.15, 0.4), 0.035, 7, 4.2, 1.2);
    }
    if (!metal) this.smoke.emit(x, y, z, nx * 1.5, 0.8, nz * 1.5, rnd(0.5, 0.9), 0.25, 1.3, 0.3, 0.5, 0.47, 0.43, 0, 2);
  }

  // The flash at a gun's muzzle (`size` 1 = the car's turret)
  muzzle(x, y, z, dx, dy, dz, size = 1) {
    this.fire.emit(x + dx * 0.25, y + dy * 0.25, z + dz * 0.25, dx * 9, dy * 9, dz * 9, 0.055, 0.55 * size, 0.7 * size, 1, 8, 5.4, 2.2, 0, 0);
    this.fire.emit(x + dx * 0.7, y + dy * 0.7, z + dz * 0.7, dx * 16, dy * 16, dz * 16, 0.045, 0.3 * size, 0.5 * size, 0.9, 8, 5, 1.6, 0, 0);
    if (size >= 1) {
      this.muzzleLight.position.set(x + dx, y + 0.3, z + dz);
      this.muzzleLight.userData.level = 420;
    }
  }

  tracer(x0, y0, z0, x1, y1, z1, r = 8, g = 5.5, b = 1.6) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const d = Math.hypot(dx, dy, dz) || 1;
    const speed = 320;
    this.streaks.emit(1, x0, y0, z0, (dx / d) * speed, (dy / d) * speed, (dz / d) * speed, d / speed, 0.05, r, g, b);
  }

  // A rocket's exhaust, one frame's worth, left behind at (x, y, z) by a motor burning the way (dx, dy, dz) points
  exhaust(x, y, z, dx, dy, dz) {
    this.fire.emit(x, y, z, -dx * 6, -dy * 6, -dz * 6, 0.12, 0.5, 0.5, 1, 8, 5, 2, 0, 0);
    const shade = rnd(0.5, 0.75);
    this.smoke.emit(x + rnd(-0.1, 0.1), y + rnd(-0.1, 0.1), z + rnd(-0.1, 0.1), -dx * 3 + rnd(-0.6, 0.6), rnd(0, 0.8), -dz * 3 + rnd(-0.6, 0.6),
      rnd(0.9, 1.6), 0.35, rnd(1.6, 2.6), 0.4, shade, shade, shade, 0.5, 2);
  }

  // The puff of a launch tube
  backblast(x, y, z, dx, dz) {
    for (let i = 0; i < 6; i++) {
      this.smoke.emit(x, y, z, -dx * rnd(3, 9) + rnd(-1.5, 1.5), rnd(0.2, 1.5), -dz * rnd(3, 9) + rnd(-1.5, 1.5), rnd(0.6, 1.1), 0.5, rnd(1.5, 2.6), 0.4, 0.7, 0.68, 0.64, 0.4, 2.2);
    }
    this.fire.emit(x, y, z, -dx * 5, 0, -dz * 5, 0.1, 1.1, 1.4, 1, 8, 5, 2, 0, 0);
  }

  // A wreck on fire, one puff's worth: flames licking up, black smoke above them (`heat` 1 fierce .. 0 smouldering)
  burn(x, y, z, heat) {
    if (heat > 0.05 && Math.random() < 0.3 + heat * 0.7) {
      this.fire.emit(x + rnd(-0.8, 0.8), y + rnd(0.3, 0.9), z + rnd(-0.8, 0.8), rnd(-0.4, 0.4), rnd(1.5, 3.2), rnd(-0.4, 0.4),
        rnd(0.35, 0.75), rnd(0.7, 1.3) * (0.5 + heat * 0.5), 0.6, 0.75, 4.2, 1.9, 0.35, 3, 1.5);
    }
    const shade = rnd(0.02, 0.08);
    this.smoke.emit(x + rnd(-0.6, 0.6), y + rnd(1.0, 1.6), z + rnd(-0.6, 0.6), rnd(-0.5, 0.5), rnd(2, 3.4), rnd(-0.5, 0.5),
      rnd(2.6, 4.4), rnd(0.9, 1.4), rnd(3.5, 5.5), 0.34 + heat * 0.2, shade, shade, shade, 0.9, 0.8);
  }

  // Dust where a body or a wreck comes down
  dust(x, y, z, amount = 1) {
    for (let i = 0; i < 4 * amount; i++) {
      const a = Math.random() * 6.28;
      this.smoke.emit(x, y + 0.2, z, Math.cos(a) * rnd(1, 3), rnd(0.3, 1), Math.sin(a) * rnd(1, 3), rnd(0.7, 1.2), 0.5, rnd(1.5, 2.5), 0.22, 0.5, 0.47, 0.43, 0, 2.2);
    }
  }

  update(dt, camera) {
    // (smoke is only seen by the light on it: dim at dusk, barely there at night, lit up by its own fire)
    const glow = cityUniforms.uInteriorGlow.value;
    this.smoke.light.value = Math.max(0.2, Math.min(1, 1.15 - glow * 0.62));
    this.scorch.update(dt);
    this.rings.update(dt);
    this.smoke.update(dt, camera);
    this.fire.update(dt, camera);
    this.streaks.update(dt, this.groundAt);
    for (const light of this.lights) {
      light.userData.level *= Math.exp(-dt * 6.5);
      if (light.userData.level < 4) light.userData.level = 0;
      light.intensity = light.userData.level;
    }
    const m = this.muzzleLight;
    m.userData.level = (m.userData.level || 0) * Math.exp(-dt * 30);
    m.intensity = m.userData.level < 4 ? 0 : m.userData.level;
  }
}

export { ActionFX };
