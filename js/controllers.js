import * as THREE from 'three/webgpu';
import { CITY_BOUNDS, isTypingInField, blockAt, pushOntoLand, SPAWN } from './city-config.js';
import { surfaceAt, clampToSegment } from './expressways.js';
import { cityUniforms, createCarPaintMaterial, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';

// js/controllers.js
// Sculpted, non-blocky GTA 6-style 3D models, animations, and physics controllers
// for Third-Person Navigation:
// 1. Person (Skinned Pedestrian: planted-footstep IK walk/run/jump, see pedestrians.js)
// 2. Car (Lofted Buick Envision Crossover with Sloped Windshield & Clearcoat)
// 3. Cyclist (Sculpted Road Cyclist with Drop-Bar Frame & Aero Helmet)
// 4. Helicopter (Harbourfront Sightseeing Twin-Turbine Chopper)

// Spawn on 5th Ave at 37th St, facing south down the avenue toward the Empire State Building (34th St)
// Half width & half length of the player's car (the Buick Envision's body, actor-models.js BODY_SPECS.envision)
const CAR_HALF_W = 0.94;
const CAR_HALF_L = 2.32;
// Its wheels, from its centre (actor-models.js BODY_SPECS.envision wheelX & wheelZ)
const WHEEL_X = 0.83;
const WHEEL_Z = 1.33;
const SPAWN_X = SPAWN.x; // Yonge St between Queen St and King St (city-config.js SPAWN)
const SPAWN_Z = SPAWN.z - 12;
const groundCollider = { type: 'ground' };

// The player's car: a mid-engined V8 coupé (4.5 L, 540 N·m, ~420 kW at 9,000 rpm), a seven-speed dual-clutch gearbox
// and rear-wheel drive moving ~1,500 kg. Nothing caps its speed: it runs out of power against the air (about 330 km/h)
const ENVISION = {
  mass: 1485, wheelRadius: 0.358, finalDrive: 4.44, efficiency: 0.87,
  gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69], reverse: 2.98,
  idle: 900, stall: 3000, redline: 8800, reverseLimit: 4000, peakTorque: 540, peakPower: 419000,
  shiftTime: 0.09, // the drive is cut while the box changes gear
  traction: 9.0, // m/s²: what the rear tyres put down pulling away, the weight thrown back onto them
  drag: 2.7e-4, // ½ ρ Cd A / m (Cd A ≈ 0.66 m²): a = drag v²
  rolling: 0.14, // m/s²: tyre rolling resistance
  brake: 11.5, handbrake: 6.5
};
// Its chassis for the handling (see carHandling): the axles from the centre of mass (the engine sits behind the
// seats, so the weight is to the rear), the height of the centre of mass (what throws weight forward under braking
// and back under power), its yaw inertia, and the tyres: a Pacejka "magic formula" curve of grip against slip
// angle that peaks near 8° and falls away a little beyond it, on a road that holds mu times the load on the tyre
const CHASSIS = {
  a: 1.42, b: 1.23, h: 0.46, inertia: 2350,
  mu: 1.12, B: 10.5, C: 1.42, E: 0.25,
  rearBias: 1.1, // the rear tyres are wider than the fronts: the car pushes on (understeers) before it spins
  brakeFront: 0.62, // share of the braking done by the front wheels
  downforce: 0.55 // N per (m/s)²: the air presses it onto the road at speed
};
const GRAVITY = 9.81;
const RPM_PER_MS = 60 / (2 * Math.PI * ENVISION.wheelRadius); // wheel rpm per m/s

// Crash damage: an impact at `speed` m/s (closing speed along the contact normal) takes this much of the car's 100
// health. Bumps & scrapes under ~15 km/h are free; a 50 km/h wall costs about a tenth, a 100 km/h one about 40, so it
// takes a few big crashes (or many small ones) to wreck it. The frames of one crash (it grinds along a wall, or bounces
// off it into it again) count once: within `window` s only what a harder impact adds over the first is taken
const CRASH = { threshold: 4, scale: 0.35, exponent: 1.5, window: 0.6, wreckTime: 3.5 };
function crashDamage(speed) {
  return speed > CRASH.threshold ? CRASH.scale * (speed - CRASH.threshold) ** CRASH.exponent : 0;
}

// Full-load engine torque (N·m): building to the plateau off idle, then held to peak power
function engineTorque(rpm) {
  const E = ENVISION;
  const r = Math.max(E.idle, Math.min(E.redline, rpm));
  const plateau = r < 3250 ? E.peakTorque * (0.62 + 0.38 * (r - E.idle) / (3250 - E.idle)) : E.peakTorque;
  return Math.min(plateau, E.peakPower / (r * Math.PI / 30));
}

// One step of the car's longitudinal motion: picks the gear like an automatic (holding gears to the redline with the
// pedal floored, short-shifting when cruising, kicking down for power), drives the wheels through it, and takes off the
// air drag, rolling resistance and engine braking. `throttle` -1..1 (backward brakes, then reverses); `pedal` 0..1.
// Leaves c.gear (-1 reverse), c.rpm and c.shiftTimer for the sound and the dashboard; returns the new speed
function driveCar(c, throttle, pedal, dt) {
  const E = ENVISION;
  const v = c.speed;
  if (!Number.isInteger(c.gear)) c.gear = 0;
  const braking = throttle * v < 0 && Math.abs(v) > 0.3;
  if (!braking) {
    if (throttle < 0 && v <= 0.3) c.gear = -1;
    else if (throttle > 0 && v >= -0.3 && c.gear < 0) c.gear = 0;
  }
  c.shiftTimer = Math.max(0, (c.shiftTimer || 0) - dt);
  const wheelRpm = Math.abs(v) * RPM_PER_MS;
  const ratioOf = (g) => (g < 0 ? E.reverse : E.gears[g]) * E.finalDrive;
  if (c.gear >= 0 && !c.shiftTimer) {
    const up = pedal > 0.95 ? E.redline - 250 : 2200 + pedal * 3000;
    const down = pedal > 0.95 ? E.redline - 1500 : 1300 + pedal * 1800;
    if (c.gear < E.gears.length - 1 && wheelRpm * ratioOf(c.gear) > up) {
      c.gear++;
      c.shiftTimer = E.shiftTime;
    } else if (c.gear > 0 && wheelRpm * ratioOf(c.gear) < down && wheelRpm * ratioOf(c.gear - 1) < up * 0.9) {
      c.gear--;
      c.shiftTimer = pedal > 0 ? E.shiftTime * 0.7 : 0;
    }
  }
  const ratio = ratioOf(c.gear);
  // (the torque converter lets the engine spin up ahead of the wheels pulling away, to its stall speed)
  const rpm = Math.max(wheelRpm * ratio, !braking && pedal > 0 ? E.stall : E.idle);
  c.rpm = Math.min(E.redline, rpm);

  let push = 0; // along the gear's direction of travel
  if (!braking && pedal > 0 && !c.shiftTimer && rpm < (c.gear < 0 ? E.reverseLimit : E.redline)) {
    // (the spinning engine & wheels add to the mass to get moving, the more so in the low gears)
    const inertia = 1.04 + 0.004 * (ratio / E.finalDrive) ** 2;
    // (c.gripScale: how well the road holds the tyres, 1 dry: less in the rain, less again on snow)
    push = Math.min(E.traction * (c.gripScale ?? 1), (engineTorque(rpm) * pedal * ratio * E.efficiency) / (E.wheelRadius * E.mass * inertia));
  }
  // what slows it: the brakes, the air, the tyres and, off the pedal, the engine held by the gearbox
  let resist = E.rolling + E.drag * v * v;
  if (braking) resist += E.brake * Math.abs(throttle) * (c.gripScale ?? 1);
  else if (!pedal) resist += ((20 + 0.012 * rpm) * ratio * E.efficiency) / (E.wheelRadius * E.mass);
  const dir = c.gear < 0 ? -1 : 1;
  let next = v + dir * push * dt;
  const slow = resist * dt;
  next = Math.abs(next) <= slow ? (push ? next : 0) : next - Math.sign(next) * slow;
  return next;
}
// Grip of a tyre at slip angle `alpha` (radians) as a share of its peak (Pacejka's magic formula, odd in alpha)
function tyreCurve(alpha) {
  const T = CHASSIS;
  const x = T.B * alpha;
  return Math.sin(T.C * Math.atan(x - T.E * (x - Math.atan(x))));
}

// The car's handling: a single-track ("bicycle") model with real tyres. The car has a forward speed u, a sideways
// speed v (+ to its left) and a yaw rate r (+ turning left). Each axle's tyres run at a slip angle (between where the
// wheel points and where it is actually going) and push back sideways with a force that follows the tyre curve,
// scaled by the load on that axle (which shifts forward under braking and back under power) and by what is left of
// the tyre's grip after driving or braking has taken its share (the friction circle). Out of that fall the things a
// real car does: it pushes wide when turned in too fast, tucks its nose when the throttle is lifted mid-corner,
// steps its tail out under power or with the rear wheels locked by the handbrake, and comes back when steered into
// the slide. Stepped in slices of at most 1/240 s (the tyres are stiff at low speed).
//   s: { u, v, r } is advanced in place; ax: the longitudinal acceleration asked of the tyres this frame (m/s²);
//   driving: how much of it is the engine's (through the rear wheels) rather than the brakes'. Returns the slip
//   angles and the lateral acceleration for the suspension, the tyre marks and the sound
function carHandling(s, steer, ax, driving, handbrake, grip, dt, stability = 0) {
  const T = CHASSIS;
  const m = ENVISION.mass;
  const L = T.a + T.b;
  const mu = T.mu * grip;
  const steps = Math.max(1, Math.ceil(dt * 240));
  const h = dt / steps;
  const cosS = Math.cos(steer);
  const sinS = Math.sin(steer);
  let slipF = 0;
  let slipR = 0;
  let ay = 0;
  for (let i = 0; i < steps; i++) {
    const { u, v, r } = s;
    // Loads: static, shifted by the longitudinal acceleration, plus the air's
    const aero = T.downforce * u * u;
    const shift = (m * ax * T.h) / L;
    const loadF = Math.max(0.1 * m * GRAVITY, (m * GRAVITY * T.b) / L - shift + aero * 0.4);
    const loadR = Math.max(0.1 * m * GRAVITY, (m * GRAVITY * T.a) / L + shift + aero * 0.6);
    // What driving or braking takes of each axle's grip
    const forceX = m * ax;
    const useF = driving ? 0 : Math.min(1, Math.abs(forceX * T.brakeFront) / (mu * loadF));
    let useR = Math.min(1, Math.abs(driving ? forceX : forceX * (1 - T.brakeFront)) / (mu * loadR));
    if (handbrake) useR = 0.96; // locked: the tyre slides, and holds next to nothing sideways
    const keepF = Math.sqrt(1 - useF * useF);
    const keepR = Math.sqrt(1 - useR * useR);
    // Slip angles: each axle's sideways speed against its speed along where its wheels point (softened towards a
    // standstill, where an angle means nothing)
    const vF = v + T.a * r;
    const vR = v - T.b * r;
    const soft = 1.2;
    slipF = Math.atan2(vF * cosS - u * sinS, Math.abs(u * cosS + vF * sinS) + soft);
    slipR = Math.atan2(vR, Math.abs(u) + soft);
    const forceF = -mu * loadF * keepF * tyreCurve(slipF); // along the front wheels' own left
    const forceR = -mu * loadR * keepR * T.rearBias * tyreCurve(slipR);
    // Sideways & yaw accelerations in the car's frame (the front force acts along the steered wheels' left)
    ay = (forceF * cosS + forceR) / m;
    const along = (-forceF * sinS) / m; // steering scrubs speed off
    let yaw = (T.a * forceF * cosS - T.b * forceR) / T.inertia;
    // Stability control: brakes single wheels to hold the car to the turn the steering asks for (the yaw rate a
    // neutral car would settle at, no more than the road can hold), which is what keeps a fast road car pointing
    // the way it is going. Held off while the handbrake is on or the driver has it floored (stability 0)
    if (stability > 0 && Math.abs(u) > 6) {
      const limit = (mu * GRAVITY) / Math.abs(u);
      const wanted = Math.max(-limit, Math.min(limit, (u * Math.tan(steer)) / (L * (1 + 0.0016 * u * u))));
      yaw -= (r - wanted) * stability * Math.min(1, (Math.abs(u) - 6) / 10);
    }
    s.r = r + yaw * h;
    // (the frame turns with the car: forward speed feeds the sideways one and back)
    s.v = v + (ay - u * s.r) * h;
    s.u = u + (along + v * s.r) * h;
  }
  return { slipF, slipR, ay };
}

const BICYCLE_DRIVE = {
  speed: 12.8, boostSpeed: 19, reverseSpeed: 4.5, acceleration: 9, boostAcceleration: 13.5,
  rolling: 0.05, drag: 0.002, brake: 7.5 // Backward input is scaled to 0.6, giving 4.5 m/s² braking.
};

function driveSpeed(speed, throttle, boost, dt, drive) {
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  const deceleration = drive.rolling + (braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : boost ? drive.boostSpeed : drive.speed;
  const acceleration = boost ? drive.boostAcceleration : drive.acceleration;
  // Releasing boost removes the extra power; existing momentum decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person', controllers.entities.person.position.y);

function createOntarioLicensePlateTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#1b3f8b';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 248, 120);
  ctx.fillStyle = '#1b3f8b';
  ctx.font = '800 16px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ONTARIO', 128, 26);
  ctx.font = '900 46px JetBrains Mono, monospace';
  ctx.fillText('CBXR 418', 128, 80);
  ctx.font = 'italic 600 13px Inter, Arial, sans-serif';
  ctx.fillText('YOURS TO DISCOVER', 128, 112);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = []) {
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      boost: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };
    // whatever the car runs into (buildings here; traffic, streetcars & pedestrians in their own systems) damages it
    this.entities.car.takeHit = (speed) => this.damageCar(speed);

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC'],
      boost: ['ShiftLeft', 'ShiftRight']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.activeMode = mode;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(0.25, Math.min(380, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude);
    ent._deckSeg = null;
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      // (a saved height puts it back on the expressway deck it was on rather than the street under it)
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode, savedAltitude ?? 0);
    }
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.vx = ent.vz = ent.angularVel = ent.yawRate = ent.steerAngle = ent.skid = ent.gear = ent.shiftTimer = 0;
      ent.rpm = ENVISION.idle;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = 1;
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const car = this.activeMode === 'car';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const extX = (car ? Math.abs(cosH) * CAR_HALF_W + Math.abs(sinH) * CAR_HALF_L : radius) + 0.1;
    const extZ = (car ? Math.abs(sinH) * CAR_HALF_W + Math.abs(cosH) * CAR_HALF_L : radius) + 0.1;
    const reach = Math.max(extX, extZ);
    const margin = heli ? 6000 : 0;
    const entity = this.getActiveEntity();
    // Conservative body cylinders, including the car's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.5, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2] };
    const others = Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(CITY_BOUNDS.minZ - margin, Math.min(CITY_BOUNDS.maxZ + margin, pz));
      px = Math.max(CITY_BOUNDS.minX - margin, Math.min(CITY_BOUNDS.maxX + margin, px));
      // on foot, by car or bicycle: on downtown's ground, 8 m in from the dock walls & its inland edges
      return heli ? { x: px, z: pz } : pushOntoLand(px, pz, 8);
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      const y = heli ? altitude : this.activeMode === 'person' ? baseY + 1 : 1;
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (y > c.maxY + 1.5) continue;
        if (p.x + extX <= c.minX || p.x - extX >= c.maxX || p.z + extZ <= c.minZ || p.z - extZ >= c.maxZ) continue;
        if (c.obb) {
          const o = c.obb, dx = p.x - o.cx, dz = p.z - o.cz;
          const ls = sinH * o.cs - cosH * o.sn, lc = sinH * o.sn + cosH * o.cs;
          const ex = (car ? Math.abs(lc) * CAR_HALF_W + Math.abs(ls) * CAR_HALF_L : radius) + 0.1;
          const ez = (car ? Math.abs(ls) * CAR_HALF_W + Math.abs(lc) * CAR_HALF_L : radius) + 0.1;
          if (Math.abs(dx * o.cs - dz * o.sn) >= o.hx + ex || Math.abs(dx * o.sn + dz * o.cs) >= o.hz + ez) continue;
        }
        return false;
      }
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(CITY_BOUNDS.minX, Math.min(CITY_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(CITY_BOUNDS.minZ, Math.min(CITY_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'Pedestrian',
      mesh: root,
      crowd,
      rig,
      position: new THREE.Vector3(SPAWN_X - 9.6, CITY_BOUNDS.sidewalkHeight, SPAWN_Z + 12),
      heading: 0,
      speed: 0,
      verticalVel: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED BUICK ENVISION CROSSOVER)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCar';

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    const spec = BODY_SPECS.envision;
    const carLoftMat = createLoftedCarMaterial(spec, 0x24405f); // Deep Azure Metallic

    // 1. 3D Lofted Crossover Body + Curved Windscreens + Sloping Roof with Rails + Side Mirrors
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, carLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 2. Ontario licence plates on the bumpers
    const nyPlateTex = createOntarioLicensePlateTexture();
    const nyPlateMat = new THREE.MeshStandardNodeMaterial({ map: nyPlateTex, roughness: 0.28 });
    const rearPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), nyPlateMat);
    rearPlate.position.set(0, spec.plates[1], spec.zRear - 0.006);
    chassisPivot.add(rearPlate);

    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), nyPlateMat);
    frontPlate.position.set(0, spec.plates[0], spec.zFront + 0.006);
    chassisPivot.add(frontPlate);

    // 2b. Brake lights, CHMSL & turn signals are lit by the body material from its carState uniform (see updateCar)
    const carState = carLoftMat.userData.carState;

    // 3. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, carLoftMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront });
    }

    // 4. Soft Under-Car Contact Shadow (AO) + Clustered Dual LED Headlight SpotLights & Rear Brake PointLight
    const carShadowGeo = new THREE.PlaneGeometry(2.2, 5.15);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    this.scene.add(root);

    return {
      type: 'car',
      label: 'Buick Envision',
      mesh: root,
      chassisPivot,
      carState,
      headLights,
      wheels,
      plates: { front: frontPlate, rear: rearPlate },
      position: new THREE.Vector3(SPAWN_X - 3.6, 0.0, SPAWN_Z + 12),
      heading: 0,
      speed: 0,
      vx: 0,
      skid: 0,
      gear: 0,
      rpm: ENVISION.idle,
      shiftTimer: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      health: 100, // 0 wrecks it (CRASH)
      wrecked: 0, // seconds until a wrecked car restarts
      home: { x: SPAWN_X - 3.6, z: SPAWN_Z + 12, heading: 0 },
      cameraTargetOffset: new THREE.Vector3(0, 1.05, 0),
      chaseDistance: 7.1,
      chaseHeight: 2.25
    };
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: 'Bike Share Toronto Cyclist',
      mesh: root,
      leanPivot,
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      position: new THREE.Vector3(SPAWN_X - 5.4, 0.0, SPAWN_Z - 8),
      heading: 0,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    return {
      type: 'helicopter',
      label: 'Sightseeing Helicopter',
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(SPAWN_X - 110, 96, SPAWN_Z - 60),
      heading: 0.62,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // On a raised curb island (city-config.js BLOCKS: the real blocks, malls & plazas), not in a park
  // Every curb island (sidewalks, park floors, medians) stands at the sidewalk's height
  isPointOnSidewalk(x, z) {
    return !!blockAt(x, z);
  }

  // The ground under (x, z) for something now at height y: an expressway's deck or ramp (expressways.js) reached
  // from there, else the street or the sidewalk
  getGroundHeight(x, z, mode = 'person', y = 0) {
    // (a car as a whole stays at road level for everything that places it; its wheels ('wheel') climb the curbs)
    const base = (mode === 'person' || mode === 'wheel') && this.isPointOnSidewalk(x, z) ? CITY_BOUNDS.sidewalkHeight : 0.0;
    const deck = surfaceAt(x, z, y + 1.0);
    return deck ? Math.max(base, deck.y) : base;
  }

  // Keeps `entity` (at pos, its new position; pos.y still last frame's height) on the expressways: true while it is on
  // a deck or a ramp, or held there by the barriers having run into its edge (or an end that leads nowhere), so that
  // the bounds of downtown's ground don't apply. Stepping off at grade onto downtown's streets lets go.
  followDeck(pos, radius, entity) {
    const here = surfaceAt(pos.x, pos.z, pos.y + 1.0);
    if (here && here.y > pos.y - 1.0) {
      entity._deckSeg = here.seg;
      return true;
    }
    const seg = entity._deckSeg;
    if (!seg) return false;
    if (pos.y < 1.0) {
      const inBounds = pos.x > CITY_BOUNDS.minX && pos.x < CITY_BOUNDS.maxX && pos.z > CITY_BOUNDS.minZ && pos.z < CITY_BOUNDS.maxZ;
      const p = inBounds ? pushOntoLand(pos.x, pos.z, 8.0) : null;
      if (p && p.x === pos.x && p.z === pos.z) {
        entity._deckSeg = null;
        return false;
      }
    }
    const c = clampToSegment(seg, pos.x, pos.z, radius * 0.6);
    pos.x = c.x;
    pos.z = c.z;
    // scraping along the barrier costs a little speed, running into it head on nearly all
    if (entity.speed) entity.speed *= Math.max(0.15, Math.abs(Math.sin(entity.heading) * seg.ux + Math.cos(entity.heading) * seg.uz)) * 0.99;
    if (entity.vx) entity.vx *= 0.5;
    if (entity.vz) entity.vz *= 0.5;
    return true;
  }

  // The colliders whose bounds come within `r` of (x, z), in their original order. They never move, so they are
  // bucketed once into 48 m cells (tens of thousands of buildings: testing them all every frame cost ~0.5 ms)
  nearColliders(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  resolveHorizontalCollision(pos, radius, yHeight = 1.0, carEntity = null, entity = carEntity) {
    // Downtown's ground or the expressways (the helicopter may roam out over the lake & the rest of the city)
    const heli = this.activeMode === 'helicopter';
    const onDeck = !heli && entity && this.followDeck(pos, radius, entity);
    if (!onDeck) {
      const m = heli ? 6000 : 0;
      pos.x = Math.max(CITY_BOUNDS.minX - m, Math.min(CITY_BOUNDS.maxX + m, pos.x));
      pos.z = Math.max(CITY_BOUNDS.minZ - m, Math.min(CITY_BOUNDS.maxZ + m, pos.z));
    }
    if (!heli && !onDeck) {
      const p = pushOntoLand(pos.x, pos.z, 8.0);
      if (p.x !== pos.x || p.z !== pos.z) {
        pos.x = p.x;
        pos.z = p.z;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
    }

    const sinH = carEntity ? Math.sin(carEntity.heading) : 0;
    const cosH = carEntity ? Math.cos(carEntity.heading) : 1;
    const extX = carEntity ? (Math.abs(cosH) * CAR_HALF_W + Math.abs(sinH) * CAR_HALF_L) : radius;
    const extZ = carEntity ? (Math.abs(sinH) * CAR_HALF_W + Math.abs(cosH) * CAR_HALF_L) : radius;

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (yHeight > c.maxY + 1.5) continue;

      if (
        pos.x + extX > c.minX &&
        pos.x - extX < c.maxX &&
        pos.z + extZ > c.minZ &&
        pos.z - extZ < c.maxZ
      ) {
        let nx = 0;
        let nz = 0;
        if (c.obb) {
          // Oriented box (buildings along a non-grid street; min/max are its world bounds): push out in its own frame
          const o = c.obb;
          const dx = pos.x - o.cx;
          const dz = pos.z - o.cz;
          const lx = dx * o.cs - dz * o.sn;
          const lz = dx * o.sn + dz * o.cs;
          const ls = sinH * o.cs - cosH * o.sn; // heading in the box's frame
          const lc = sinH * o.sn + cosH * o.cs;
          const ex = carEntity ? (Math.abs(lc) * CAR_HALF_W + Math.abs(ls) * CAR_HALF_L) : radius;
          const ez = carEntity ? (Math.abs(ls) * CAR_HALF_W + Math.abs(lc) * CAR_HALF_L) : radius;
          if (lx + ex <= -o.hx || lx - ex >= o.hx || lz + ez <= -o.hz || lz - ez >= o.hz) continue;
          const oL = lx + ex + o.hx;
          const oR = o.hx - (lx - ex);
          const oT = lz + ez + o.hz;
          const oB = o.hz - (lz - ez);
          const m = Math.min(oL, oR, oT, oB);
          let qx = lx;
          let qz = lz;
          let mx = 0;
          let mz = 0;
          if (m === oL) { qx = -o.hx - ex; mx = -1; }
          else if (m === oR) { qx = o.hx + ex; mx = 1; }
          else if (m === oT) { qz = -o.hz - ez; mz = -1; }
          else { qz = o.hz + ez; mz = 1; }
          pos.x = o.cx + qx * o.cs + qz * o.sn;
          pos.z = o.cz - qx * o.sn + qz * o.cs;
          nx = mx * o.cs + mz * o.sn;
          nz = -mx * o.sn + mz * o.cs;
        } else {
          const overlapLeft = (pos.x + extX) - c.minX;
          const overlapRight = c.maxX - (pos.x - extX);
          const overlapTop = (pos.z + extZ) - c.minZ;
          const overlapBottom = c.maxZ - (pos.z - extZ);

          const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
          if (minOverlap === overlapLeft) {
            pos.x = c.minX - extX;
            nx = -1;
          } else if (minOverlap === overlapRight) {
            pos.x = c.maxX + extX;
            nx = 1;
          } else if (minOverlap === overlapTop) {
            pos.z = c.minZ - extZ;
            nz = -1;
          } else {
            pos.z = c.maxZ + extZ;
            nz = 1;
          }
        }

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * CAR_HALF_W + Math.abs(nx * sin + nz * cos) * CAR_HALF_L : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            carEntity.takeHit?.(vn);
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.yawRate = (carEntity.yawRate || 0) * 0.4; // (the wall stops it turning)
            carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }

    // Pushed off the deck it is driving on (by a collider): back inside its barriers, so it can't drop through the road
    if (onDeck && entity._deckSeg && pos.y > 1.0 && !surfaceAt(pos.x, pos.z, pos.y + 1.0)) {
      const c = clampToSegment(entity._deckSeg, pos.x, pos.z, radius * 0.6);
      pos.x = c.x;
      pos.z = c.z;
    }
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt) {
    const p = this.entities.person;
    const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
    p.crowd.begin();
    p.crowd.add(p.rig, 0);
    p.crowd.end();

    const b = this.entities.cyclist;
    b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
    b.riderCrowd.begin();
    b.riderCrowd.add(b.riderRig, 0);
    b.riderCrowd.end();
    b.helmet.quaternion.copy(b.riderRig.headQuaternion);
    b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
  }

  update(dt, elapsed) {
    this.clock = (this.clock || 0) + dt;
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else {
      // Keep the sidewalk pedestrian walking naturally when not actively controlled
      const p = this.entities.person;
      const walkSpeed = 1.48;
      p.speed = walkSpeed;
      p.position.x += Math.sin(p.heading) * walkSpeed * dt;
      p.position.z += Math.cos(p.heading) * walkSpeed * dt;
      if (p.position.z < -340) p.heading = 0;
      else if (p.position.z > 340) p.heading = Math.PI;
    }

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.y = e.heading;
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = HEADLIGHTS.intensity * beamScale;
      }
    }
    // (the detailed model's lamps, player-car.js: tail lamps glow after dark and flare under braking)
    if (car.modelLights) {
      const braking = car.carState ? car.carState.value.x : 0;
      car.modelLights.tail.emissiveIntensity = braking ? 5.5 : 0.25 + beamScale * 1.1;
      car.modelLights.head.emissiveIntensity = 0.08 + beamScale * 3.2;
    }
    const bike = this.entities.cyclist;
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    const maxWalk = this.keys.boost ? 8.2 : 4.4;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxWalk * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxWalk * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    p.speed += (targetSpeed - p.speed) * Math.min(1, dt * 10);

    p.position.x += Math.sin(p.heading) * p.speed * dt;
    p.position.z += Math.cos(p.heading) * p.speed * dt;
    this.resolveHorizontalCollision(p.position, 0.48, p.position.y + 1.0, null, p);

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    if (this.keys.up && p.position.y <= groundY + 0.02) {
      p.verticalVel = 5.2;
    }
    p.verticalVel -= 14.5 * dt;
    p.position.y += p.verticalVel * dt;
    if (p.position.y < groundY) {
      p.position.y = groundY;
      p.verticalVel = 0;
    }
  }

  // An impact at `speed` m/s: takes its toll on the car's health, and wrecks it at 0
  damageCar(speed) {
    const c = this.entities.car;
    if (c.wrecked > 0 || !Number.isFinite(speed)) return;
    const now = this.clock || 0;
    let damage = crashDamage(speed);
    if (c.lastCrash && now - c.lastCrash.time < CRASH.window) {
      damage -= crashDamage(c.lastCrash.speed);
      if (damage <= 0) return;
      c.lastCrash.speed = speed;
    } else {
      c.lastCrash = { time: now, speed };
    }
    c.health = Math.max(0, c.health - damage);
    if (c.health === 0) c.wrecked = CRASH.wreckTime;
  }

  // A wrecked car's restart: back where the drive began, as new
  restartCar() {
    const c = this.entities.car;
    c.health = 100;
    c.wrecked = 0;
    c.lastCrash = null;
    if (this.activeMode === 'car') this.teleportActiveTo(c.home.x, c.home.z, c.home.heading);
    else {
      c.position.set(c.home.x, 0, c.home.z);
      c.heading = c.home.heading;
      c.speed = c.vx = c.vz = 0;
    }
  }

  updateCar(dt) {
    const c = this.entities.car;
    // wrecked: the engine is dead and the controls do nothing until it restarts
    if (c.wrecked > 0) {
      c.wrecked -= dt;
      if (c.wrecked <= 0) return this.restartCar();
    }
    const dead = c.wrecked > 0;
    let throttle = 0;
    if (!dead && this.keys.forward) throttle = this.keys.forward;
    else if (!dead && this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0 && Math.abs(c.speed) > 0.3;
    const previousSpeed = c.speed;
    // the keys press the accelerator most of the way; Shift floors it (a gamepad trigger or the touch stick is analog)
    const pedal = braking ? 0 : Math.min(1, Math.abs(throttle) * (this.keys.boost ? 1 : 0.8));
    c.speed = driveCar(c, throttle, pedal, dt);
    const acceleration = dt > 0 ? (c.speed - previousSpeed) / dt : 0;

    let steerInput = 0;
    if (!dead && this.keys.left) steerInput = this.keys.left;
    if (!dead && this.keys.right) steerInput = -this.keys.right;

    // The car's motion in its own frame: forward speed, sideways speed (+ left) and yaw rate
    const sin0 = Math.sin(c.heading);
    const cos0 = Math.cos(c.heading);
    const state = c._motion || (c._motion = { u: 0, v: 0, r: 0 });
    state.u = c.speed;
    state.v = c.vx * cos0 - c.vz * sin0;
    state.r = c.yawRate || 0;
    const pace = Math.abs(state.u);
    const grip = c.gripScale ?? 1;

    // Steering: full lock at parking speeds; at speed, no further than the front tyres can use (a little past the
    // angle of their peak grip, on top of what the corner itself needs), and it turns more slowly the faster the car
    // goes, so a tap of the key at 250 km/h is a lane change. A slide is caught the way a driver catches it: the
    // wheels turn towards the way the car is actually going (opposite lock), on top of what the keys ask
    const L = CHASSIS.a + CHASSIS.b;
    const lock = Math.min(0.56, Math.atan((L * CHASSIS.mu * GRAVITY * grip) / Math.max(1, pace * pace)) + 0.105);
    const drift = pace > 4 && state.u > 0 ? Math.atan2(state.v, pace) : 0;
    // (only once it really is sliding: the few degrees a car drifts in any corner are left alone)
    const catchSlide = Math.max(-0.5, Math.min(0.5, Math.sign(drift) * Math.max(0, Math.abs(drift) - 0.07) * 0.9));
    const steerTarget = Math.max(-0.6, Math.min(0.6, steerInput * lock + catchSlide));
    c.steerAngle += (steerTarget - c.steerAngle) * Math.min(1, dt * (16 - 9 * Math.min(1, pace / 60)));

    // The handbrake (Space) locks the rear wheels: they slide instead of gripping, and the tail comes round
    const handbrake = !dead && !!this.keys.up && Math.hypot(c.speed, c.vx, c.vz) > 2;
    if (handbrake) state.u = Math.sign(state.u) * Math.max(0, Math.abs(state.u) - ENVISION.handbrake * grip * dt);
    // Without Shift the traction control keeps the driven wheels from taking more than most of the rear tyres' grip;
    // floored (Shift), all of it can go into wheelspin, and the tail with it
    const driving = !braking && pedal > 0;
    const drive = driving && !this.keys.boost ? Math.sign(acceleration) * Math.min(Math.abs(acceleration), 5.6 * grip) : acceleration;
    const tyres = carHandling(state, c.steerAngle, drive, driving, handbrake, grip, dt, handbrake || (this.keys.boost && driving) ? 0 : 5);
    // At a crawl the tyres simply hold the car: it rolls where its wheels point and settles at once
    if (pace < 2.5) {
      const hold = Math.exp(-dt * (2.5 - pace) * 9);
      const rolling = (state.u * Math.tan(c.steerAngle)) / L;
      state.r = rolling + (state.r - rolling) * hold;
      state.v *= hold;
    }
    c.yawRate = state.r;
    c.heading += (state.r + c.angularVel) * dt; // (+ the spin a collision left it with)
    c.angularVel *= Math.exp(-dt * 7.8);
    c.speed = state.u;
    const lateral = state.v; // the slide across the car (m/s), + to its left
    c.vx = Math.cos(c.heading) * lateral;
    c.vz = -Math.sin(c.heading) * lateral;
    c.lateralG = tyres.ay / GRAVITY;
    // How far past their grip the tyres are (0 gripping .. 1 fully sliding): the squeal, the rubber, the smoke
    const beyond = Math.max(Math.abs(tyres.slipR), Math.abs(tyres.slipF) * 0.85) - 0.17;
    c.skid = pace > 3 || Math.abs(lateral) > 2 ? Math.min(1, Math.max(handbrake ? 0.6 : 0, beyond / 0.24)) : 0;
    // (for the rubber & smoke it leaves, car-effects.js: the rear locked, or spinning away from a standstill)
    c.handbrake = handbrake;
    c.launching = !dead && pedal > 0.95 && c.gear === 0 && pace < 9 && pace > 0.3;

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.position.x += (Math.sin(c.heading) * c.speed + c.vx) * dt;
    c.position.z += (Math.cos(c.heading) * c.speed + c.vz) * dt;

    this.resolveHorizontalCollision(c.position, 1.35, c.position.y + 1.0, c);
    // Each wheel stands on what is under it: the car climbs the curbs (a thump through the suspension, a little speed
    // lost) and tilts with a wheel or two up on the sidewalk
    const sn = Math.sin(c.heading);
    const cs = Math.cos(c.heading);
    const wheelY = c._wheelY || (c._wheelY = [0, 0, 0, 0]);
    let groundSum = 0;
    let kerb = 0;
    for (let i = 0; i < 4; i++) {
      const lx = i & 1 ? WHEEL_X : -WHEEL_X;
      const lz = i & 2 ? -WHEEL_Z - 0.17 : WHEEL_Z - 0.17; // (the axles sit a little behind the body's middle)
      const h = this.getGroundHeight(c.position.x + cs * lx + sn * lz, c.position.z - sn * lx + cs * lz, 'wheel', c.position.y);
      if (Math.abs(h - wheelY[i]) > 0.08 && Math.abs(h - wheelY[i]) < 0.6) kerb += h - wheelY[i];
      wheelY[i] = h;
      groundSum += h;
    }
    const groundY = groundSum / 4;
    if (kerb && Math.abs(c.speed) > 1) {
      c.heaveVel += Math.max(-0.5, Math.min(1.1, kerb * 2.4 + Math.abs(kerb) * Math.abs(c.speed) * 0.05));
      c.speed *= 0.985;
    }
    // (eased over a curb's height; a deck or ramp is followed exactly)
    c.position.y = Math.abs(groundY - c.position.y) < 0.4 ? c.position.y + (groundY - c.position.y) * Math.min(1, dt * 18) : groundY;
    const kerbPitch = -((wheelY[0] + wheelY[1]) - (wheelY[2] + wheelY[3])) / (4 * WHEEL_Z);
    const kerbRoll = ((wheelY[1] + wheelY[3]) - (wheelY[0] + wheelY[2])) / (4 * WHEEL_X);

    // 3-DOF Spring-Damper Chassis Suspension (Pitch, Roll & Vertical Heave)
    // (soft and floaty: the body dives under braking, squats under power and leans hard into the corners & slides)
    // (firm: about 2.5° of roll at 1 g of cornering, a degree and a half of dive under full braking)
    const targetPitch = -Math.max(-1.3, Math.min(1.3, acceleration / GRAVITY)) * 0.028 + kerbPitch;
    const targetRoll = Math.max(-1.4, Math.min(1.4, tyres.ay / GRAVITY)) * 0.045 + kerbRoll;
    const springK = 90.0;
    const dampC = 11.0;
    c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * springK - c.pitchVel * dampC) * dt;
    c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * springK - c.rollVel * dampC) * dt;
    c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * dt));
    c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * dt));

    c.heaveVel += (-c.heaveY * 85.0 - c.heaveVel * 12.0) * dt;
    c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * dt));
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking || (c.speed === 0 && !throttle) ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  updateCyclist(dt) {
    const b = this.entities.cyclist;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -0.6 * this.keys.backward;

    b.speed = driveSpeed(b.speed, throttle, this.keys.boost, dt, BICYCLE_DRIVE);

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    this.resolveHorizontalCollision(b.position, 0.65, b.position.y + 1.0, null, b);
    b.position.y = this.getGroundHeight(b.position.x, b.position.z, 'cyclist', b.position.y);

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = this.keys.boost ? 52.0 : 32.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    if (h.position.y < 0.25) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, 0.25, h.position.z, 0, 1, 0, -h.verticalSpeed);
    }
    h.position.y = Math.max(0.25, Math.min(380, h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, h.position.y, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
