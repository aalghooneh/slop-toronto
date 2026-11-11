import * as THREE from 'three/webgpu';
import { mrt, vec4, attribute, uniform, uv, float, length, smoothstep, abs } from 'three/tsl';
import { BODY_SPECS } from './actor-models.js';
import { cityUniforms } from './tsl-materials.js';

// js/car-effects.js
// What the player's car leaves behind: rubber on the road where the tyres let go (two black strips from the rear
// wheels through every slide and handbrake turn), the smoke that comes off them, spray off a wet road in the rain,
// and the smoke of a car that has taken too many knocks.

// Effects drawn over the scene leave its normals & reflectivity as they were (the reflections, the ambient occlusion
// and the snow cover in post-processing.js keep seeing what is underneath)
const KEEP_SURFACE = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });

const MARK_QUADS = 900; // ring buffer: the oldest marks are laid over by the newest
const MARK_WIDTH = 0.24;
const MARK_Y = 0.016; // just over the road paint
const MARK_STEP = 0.3; // metres of travel per quad
const PUFFS = 140;

class SkidMarks {
  constructor(parent) {
    const n = MARK_QUADS;
    this.positions = new Float32Array(n * 4 * 3);
    this.alphas = new Float32Array(n * 4);
    this.uvs = new Float32Array(n * 4 * 2);
    const index = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
      this.uvs.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
    }
    const geo = this.geometry = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    mat.colorNode = float(0.012).mul(uniform(new THREE.Color(1, 1, 1)));
    // soft at the edges of the tread
    mat.opacityNode = attribute('alpha', 'float').mul(smoothstep(1.0, 0.45, abs(uv().x.sub(0.5)).mul(2)));
    mat.mrtNode = KEEP_SURFACE;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'SkidMarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    parent.add(this.mesh);
    this.next = 0;
    this.wheels = [{ on: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, alpha: 0 }, { on: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, alpha: 0 }];
  }

  // The tyre `wheel` is at (x, y, z) laying rubber of the given strength (0 lifts it off the road)
  lay(wheel, x, y, z, strength) {
    const w = this.wheels[wheel];
    if (strength <= 0.02) {
      w.on = false;
      return;
    }
    if (!w.on) {
      w.on = true;
      w.x = x;
      w.y = y;
      w.z = z;
      w.alpha = 0;
      w.lx = w.lz = 0;
      return;
    }
    const dx = x - w.x;
    const dz = z - w.z;
    const d = Math.hypot(dx, dz);
    if (d < MARK_STEP) return;
    if (d > 4) {
      // (a teleport or a restart: no line drawn across the city)
      w.on = false;
      return;
    }
    // across the strip, at right angles to the way the tyre went
    const sx = (-dz / d) * MARK_WIDTH * 0.5;
    const sz = (dx / d) * MARK_WIDTH * 0.5;
    const i = this.next;
    this.next = (this.next + 1) % MARK_QUADS;
    const P = this.positions;
    const o = i * 12;
    // the strip starts from the end of the one before, so that it bends without gaps
    const px = w.lx || w.lz ? w.lx : sx;
    const pz = w.lx || w.lz ? w.lz : sz;
    P[o] = w.x + px; P[o + 1] = w.y + MARK_Y; P[o + 2] = w.z + pz;
    P[o + 3] = w.x - px; P[o + 4] = w.y + MARK_Y; P[o + 5] = w.z - pz;
    P[o + 6] = x + sx; P[o + 7] = y + MARK_Y; P[o + 8] = z + sz;
    P[o + 9] = x - sx; P[o + 10] = y + MARK_Y; P[o + 11] = z - sz;
    const A = this.alphas;
    const a = Math.min(0.78, strength);
    A[i * 4] = A[i * 4 + 1] = w.alpha;
    A[i * 4 + 2] = A[i * 4 + 3] = a;
    w.alpha = a;
    w.x = x;
    w.y = y;
    w.z = z;
    w.lx = sx;
    w.lz = sz;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
  }
}

// Soft round puffs that face the camera: tyre smoke (pale), road spray (pale, quick) and engine smoke (dark)
class Puffs {
  constructor(parent) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 2), 2); // opacity, shade
    this.fade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('fade', this.fade);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    this.light = uniform(1); // how bright the day is (smoke is only seen by the light on it)
    const f = attribute('fade', 'vec2');
    mat.colorNode = f.y.mul(this.light).mul(uniform(new THREE.Color(1, 1, 1)));
    mat.opacityNode = f.x.mul(smoothstep(0.5, 0.08, length(uv().sub(0.5))));
    mat.mrtNode = KEEP_SURFACE;
    this.mesh = new THREE.InstancedMesh(geo, mat, PUFFS);
    this.mesh.name = 'CarSmoke';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.count = 1; // (one, collapsed, until there is smoke: its pipeline compiles behind the loading screen)
    this.mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0));
    parent.add(this.mesh);
    this.list = [];
    this.dummy = new THREE.Object3D();
  }

  emit(x, y, z, vx, vy, vz, life, size, grow, opacity, shade) {
    if (this.list.length >= PUFFS) this.list.shift();
    this.list.push({ x, y, z, vx, vy, vz, age: 0, life, size, grow, opacity, shade, spin: Math.random() * 6.28 });
  }

  update(dt, camera) {
    const list = this.list;
    const d = this.dummy;
    const F = this.fade.array;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const drag = Math.exp(-dt * 1.6);
      p.vx *= drag;
      p.vz *= drag;
      d.position.set(p.x, p.y, p.z);
      d.quaternion.copy(camera.quaternion);
      d.rotateZ(p.spin + k * 0.8);
      d.scale.setScalar(p.size + p.grow * k);
      d.updateMatrix();
      this.mesh.setMatrixAt(n, d.matrix);
      F[n * 2] = p.opacity * Math.min(1, k * 8) * (1 - k) ** 1.6;
      F[n * 2 + 1] = p.shade;
      list[n++] = p;
    }
    list.length = n;
    if (n === 0) {
      if (this.mesh.count === 0) return;
      // (keep the one collapsed instance until the first frames have compiled its pipeline)
      this.mesh.count = this.drawn ? 0 : 1;
      this.drawn = true;
      return;
    }
    this.drawn = true;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fade.needsUpdate = true;
  }
}

class CarEffects {
  constructor(scene) {
    const group = this.group = new THREE.Group();
    group.name = 'CarEffects';
    scene.add(group);
    this.marks = new SkidMarks(group);
    this.puffs = new Puffs(group);
    this.spec = BODY_SPECS.envision;
    this.smokeDebt = 0;
    this.sprayDebt = 0;
    this.engineDebt = 0;
    this.rain = 0; // set by main.js with the weather
  }

  update(dt, car, active, camera) {
    const spec = this.spec;
    const sin = Math.sin(car.heading);
    const cos = Math.cos(car.heading);
    const speed = Math.abs(car.speed);
    const moving = Math.hypot(car.speed * sin + (car.vx || 0), car.speed * cos + (car.vz || 0));
    // Rubber goes down while the tyres slide across the road, harder the more they do
    // (and with the rear locked by the handbrake, or the wheels spinning away from a standstill)
    let sliding = active && moving > 3 ? Math.max(0, (car.skid - 0.3) / 0.7) : 0;
    if (active && car.handbrake && moving > 4) sliding = Math.max(sliding, 0.55);
    if (active && car.launching) sliding = Math.max(sliding, 0.4);
    const strength = sliding > 0 ? 0.25 + sliding * 0.6 : 0;
    const wx = car.detailed ? 0.82 : spec.wheelX;
    const wz = car.detailed ? -1.5 : -spec.wheelZ;
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      const x = car.position.x + cos * side * wx + sin * wz;
      const z = car.position.z - sin * side * wx + cos * wz;
      this.marks.lay(i, x, car.position.y, z, strength);
      if (sliding > 0.15) {
        this.smokeDebt += dt * sliding * 26;
        while (this.smokeDebt >= 1) {
          this.smokeDebt -= 1;
          const j = () => (Math.random() - 0.5);
          this.puffs.emit(x + j() * 0.3, car.position.y + 0.18, z + j() * 0.3,
            (car.vx || 0) * 0.25 + j() * 0.8, 0.5 + Math.random() * 0.7, (car.vz || 0) * 0.25 + j() * 0.8,
            0.9 + Math.random() * 0.7, 0.5, 2.4 + sliding * 1.4, 0.22 + sliding * 0.14, 0.82);
        }
      }
    }

    // Spray off a wet road, from all four wheels
    if (active && this.rain > 0.3 && speed > 7) {
      this.sprayDebt += dt * Math.min(40, speed * 1.1) * this.rain;
      while (this.sprayDebt >= 1) {
        this.sprayDebt -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const along = Math.random() < 0.5 ? wz : -wz;
        const x = car.position.x + cos * side * wx + sin * (along - 0.4);
        const z = car.position.z - sin * side * wx + cos * (along - 0.4);
        this.puffs.emit(x, car.position.y + 0.2, z, sin * car.speed * 0.35 + (Math.random() - 0.5), 0.9 + Math.random() * 0.8,
          cos * car.speed * 0.35 + (Math.random() - 0.5), 0.45 + Math.random() * 0.3, 0.3, 1.1 + speed * 0.025, 0.085, 0.9);
      }
    }

    // A battered engine smokes from under the bonnet: grey when it is hurt, black once it is wrecked
    const hurt = car.wrecked > 0 ? 1 : Math.max(0, (40 - car.health) / 40);
    if (hurt > 0) {
      this.engineDebt += dt * (4 + hurt * 16);
      while (this.engineDebt >= 1) {
        this.engineDebt -= 1;
        const front = car.detailed ? -1.5 : spec.zFront - 0.9; // (the detailed car's engine is behind the seats)
        this.puffs.emit(car.position.x + sin * front + (Math.random() - 0.5) * 0.5, car.position.y + 1.0,
          car.position.z + cos * front + (Math.random() - 0.5) * 0.5,
          sin * car.speed * 0.5, 1.4 + Math.random(), cos * car.speed * 0.5, 1.4 + Math.random() * 0.8, 0.5, 2.6,
          0.2 + hurt * 0.25, car.wrecked > 0 ? 0.06 : 0.42 - hurt * 0.2);
      }
    }

    // (smoke is as bright as the daylight on it: dim at dusk, barely there at night)
    const glow = cityUniforms.uInteriorGlow.value;
    this.puffs.light.value = Math.max(0.16, Math.min(1, 1.15 - glow * 0.62));
    this.puffs.update(dt, camera);
  }
}

export { CarEffects };
