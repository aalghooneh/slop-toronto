import * as THREE from 'three/webgpu';
import { LANDMARK_SITES, POINTS, TELEPORT_LOCATIONS } from './city-config.js';

// js/cameras.js
// Multi-camera system supporting Third-Person Chase (with mouse/touch orbit + zoom),
// Low-Angle Action Cam, POV/Cockpit Cam, 7 Scenic Toronto Cameras, and Auto-Director Drone.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         short: 'Chase',       category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         short: 'Action',      category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   short: 'POV / Dash',  category: 'follow', fov: 68 },
  { id: 'queensPark',  name: 'Queen\'s Park & University Ave', short: 'Queen\'s Pk', category: 'scenic', fov: 52 },
  { id: 'bayStreet',   name: 'Bay St & Old City Hall',   short: 'Bay St',      category: 'scenic', fov: 48 },
  { id: 'dundasSq',    name: 'Yonge & Dundas',           short: 'Yonge-Dundas', category: 'scenic', fov: 58 },
  { id: 'cityHall',    name: 'Nathan Phillips Square',   short: 'City Hall',   category: 'scenic', fov: 50 },
  { id: 'lookout',     name: 'CN Tower LookOut',         short: 'LookOut',     category: 'scenic', fov: 52 },
  { id: 'unionFront',  name: 'Front St & Union Station', short: 'Union',       category: 'scenic', fov: 52 },
  { id: 'waterfront',  name: 'Harbour & Skyline',        short: 'Skyline',     category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Auto-Director Aerial',     short: 'Director',    category: 'scenic', fov: 50 }
];

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the city & the lake run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    // The feel of speed (see update()): the lens widens, the camera hangs out behind a slide, leans a touch into the
    // corners and shudders flat out and when the car takes a knock
    this.slideYaw = 0;
    this.leanRoll = 0;
    this.fovKick = 0;
    this.trauma = 0;
    // What an explosion does to it (see blast()): thrown back from the blast on a spring, the lens punched wide
    this.kickOffset = new THREE.Vector3();
    this.kickVel = new THREE.Vector3();
    this.fovPunch = 0;
    this.shakeSeed = Math.random() * 100;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  // A knock to the camera: 0..1, by how hard the hit was (it dies away in half a second)
  shake(amount) {
    if (Number.isFinite(amount)) this.trauma = Math.min(1, Math.max(this.trauma, amount));
  }

  // The recoil of the car's guns: a little is added with every shot, up to a steady judder
  recoil(amount, ceiling = 0.3) {
    if (Number.isFinite(amount) && this.trauma < ceiling) this.trauma = Math.min(ceiling, this.trauma + amount);
  }

  // An explosion of the given power (1 = a car going up) at (x, y, z): the nearer, the harder the camera is shaken,
  // and the pressure wave throws it back from the blast (it swings back on a spring) and punches the lens wide.
  // Returns how hard it was hit, 0..1
  blast(x, y, z, power = 1) {
    const dx = this.camera.position.x - x;
    const dy = this.camera.position.y - y;
    const dz = this.camera.position.z - z;
    const d = Math.hypot(dx, dy, dz);
    const reach = 150 * Math.sqrt(power);
    if (!(d < reach)) return 0;
    const felt = Math.min(1, power * (1 - d / reach) ** 2.2 * 1.25);
    this.shake(0.18 + felt * 0.82);
    const push = felt * 9.5 / Math.max(d, 1.5);
    this.kickVel.x += dx * push;
    this.kickVel.y += Math.abs(dy) * push * 0.5 + felt * 2.4;
    this.kickVel.z += dz * push;
    this.fovPunch = Math.min(16, this.fovPunch + felt * 11);
    return felt;
  }

  // The way the follow cameras look, over the ground (the car's turret aims along it, combat.js)
  aimYaw(entity = this.controllerManager.getActiveEntity()) {
    if (this.activePresetId === 'chase') return entity.heading + this.orbitYawOffset + this.slideYaw;
    if (this.activePresetId === 'pov') return entity.heading + this.orbitYawOffset;
    return entity.heading;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.slideYaw = this.leanRoll = this.fovKick = this.trauma = this.fovPunch = 0;
    this.kickOffset.set(0, 0, 0);
    this.kickVel.set(0, 0, 0);
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    // A sliding car is followed along the way it is going rather than the way it points, so a drift swings its flank
    // (and then its nose) into view; the camera also leans a little with the steering at speed
    const follow = this.activePresetId === 'chase' || this.activePresetId === 'action' || this.activePresetId === 'pov';
    let slide = 0;
    let lean = 0;
    if (follow && entity.type === 'car') {
      const sin = Math.sin(entity.heading);
      const cos = Math.cos(entity.heading);
      const lateral = (entity.vx || 0) * cos - (entity.vz || 0) * sin;
      if (entity.speed > 4) slide = Math.max(-0.5, Math.min(0.5, Math.atan2(lateral, entity.speed) * 0.75));
      lean = -(entity.steerAngle || 0) * Math.min(1, Math.abs(entity.speed) / 30) * 0.045 + slide * 0.05;
    } else if (follow && entity.type === 'cyclist') {
      lean = (entity.leanAngle || 0) * 0.18;
    } else if (follow && entity.type === 'helicopter') {
      lean = (entity.rollAngle || 0) * 0.22;
    }
    this.slideYaw += (slide - this.slideYaw) * (1 - Math.exp(-dt * 4.5));
    this.leanRoll += (lean - this.leanRoll) * (1 - Math.exp(-dt * 5));

    const totalYaw = entity.heading + this.orbitYawOffset + (this.activePresetId === 'chase' ? this.slideYaw : 0);

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'queensPark': {
        // University Ave's median at College St, looking up the avenue to the Legislative Building at Queen's Park
        const leg = LANDMARK_SITES['Ontario Legislative Building'] || { x: -760, z: -1380 };
        const sway = Math.sin(elapsed * 0.22) * 3.5;
        desiredPos.set(-595.0 + sway, 9.0, -980.0);
        desiredLook.set(leg.x, 18.0, leg.z);
        break;
      }

      case 'bayStreet': {
        // Bay St at Front St looking north up the bank towers' canyon to Old City Hall's clock tower at its head
        const sway = Math.sin(elapsed * 0.25) * 1.8;
        desiredPos.set(-192.0 + sway, 6.5, 640.0);
        desiredLook.set(-192.0, 70.0, 20.0);
        break;
      }

      case 'dundasSq': {
        // The corner of Yonge & Dundas, the square's screens & the Eaton Centre
        const sq = POINTS.dundasSquare;
        const sway = Math.sin(elapsed * 0.3) * 3.0;
        desiredPos.set(sq.x - 40.0 + sway, 5.5, sq.z - 30.0);
        desiredLook.set(sq.x + 30.0, 25.0, sq.z + 40.0);
        break;
      }

      case 'cityHall': {
        // Nathan Phillips Square from Queen St: the pool, the arches, the TORONTO sign & the curved towers behind
        const ch = LANDMARK_SITES['Toronto City Hall'] || { x: -380, z: -120 };
        const q = TELEPORT_LOCATIONS.cityhall || { x: ch.x, z: 4 };
        const sway = Math.cos(elapsed * 0.22) * 2.5;
        desiredPos.set(ch.x + 10.0 + sway, 9.0, q.z - 4.0);
        desiredLook.set(ch.x, 45.0, ch.z);
        break;
      }

      case 'lookout': {
        // The CN Tower's LookOut level (346 m) looking north-east over the Financial District to the Don
        const cn = POINTS.cnTower;
        const pan = Math.sin(elapsed * 0.18) * 160.0;
        desiredPos.set(cn.x + 14.0, 346.0, cn.z - 14.0);
        desiredLook.set(200.0 + pan, 90.0, -300.0);
        break;
      }

      case 'unionFront': {
        // Front St outside Union Station looking west to the Royal York, the CN Tower beyond
        const sway = Math.sin(elapsed * 0.25) * 1.5;
        desiredPos.set(-300.0, 4.5 + sway * 0.2, 650.0);
        desiredLook.set(-900.0, 120.0, 760.0);
        break;
      }

      case 'waterfront': {
        // Over the harbour off the Toronto Islands, looking back at the skyline & the CN Tower
        const drift = Math.sin(elapsed * 0.15) * 60.0;
        desiredPos.set(-350.0 + drift, 45.0, 2350.0);
        desiredLook.set(-400.0, 150.0, 600.0);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(
          Math.cos(angle) * radius - 400.0,
          alt,
          Math.sin(angle) * radius + 500.0
        );
        desiredLook.set(-400.0, 150.0, 500.0);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);

    // The lens widens with speed on the follow cameras (most of all in the car)
    const preset = this.getActivePreset();
    const perSpeed = entity.type === 'car' ? 0.26 : entity.type === 'helicopter' ? 0.12 : 0.3;
    const kick = follow ? Math.min(entity.type === 'car' ? 15 : 8, Math.max(0, this.smoothedSpeed - 6) * perSpeed) : 0;
    this.fovKick += (kick - this.fovKick) * (1 - Math.exp(-dt * 2.5));
    this.fovPunch *= Math.exp(-dt * 5.5);
    const fov = preset.fov + this.fovKick + this.fovPunch;
    if (Math.abs(fov - this.camera.fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // Shudder: a fine rumble flat out, a jolt from a crash, and the full treatment from an explosion. Trauma (0..1)
    // dies away faster the less there is of it and is felt as its square: the camera is thrown about (not in step:
    // each axis has its own mix of frequencies) and twisted in pitch, yaw & roll, which is what reads as a blow
    // rather than a wobble. Crashes only reach the follow cameras; a blast shakes whichever camera sees it
    this.trauma = Math.max(0, this.trauma - dt * (1.05 + this.trauma * 1.5));
    const rumble = follow && entity.type === 'car' ? Math.max(0, this.smoothedSpeed - 30) * 0.0011 : 0;
    const jolt = this.trauma * this.trauma;
    // the blast's shove, on a damped spring
    const kv = this.kickVel;
    const ko = this.kickOffset;
    kv.x += (-ko.x * 95 - kv.x * 13) * dt;
    kv.y += (-ko.y * 95 - kv.y * 13) * dt;
    kv.z += (-ko.z * 95 - kv.z * 13) * dt;
    ko.set(ko.x + kv.x * dt, ko.y + kv.y * dt, ko.z + kv.z * dt);
    const thrown = Math.hypot(ko.x, ko.y, ko.z);
    if (thrown > 3) ko.set((ko.x * 3) / thrown, (ko.y * 3) / thrown, (ko.z * 3) / thrown);
    this.camera.position.add(ko);
    let twistX = 0;
    let twistY = 0;
    let twistZ = 0;
    if (rumble || jolt) {
      const t = elapsed + this.shakeSeed;
      const a = rumble + jolt * 0.42;
      const wave = (f, p) => Math.sin(t * f + p) * 0.6 + Math.sin(t * f * 1.73 + p * 2.1) * 0.4;
      this.camera.position.x += wave(71.3, 0.0) * a;
      this.camera.position.y += wave(63.1, 2.1) * a * 0.8;
      this.camera.position.z += wave(57.7, 0.7) * a;
      twistX = wave(47.3, 4.2) * jolt * 0.036;
      twistY = wave(41.9, 1.3) * jolt * 0.04;
      twistZ = wave(53.0, 3.1) * jolt * 0.075;
    }
    this.camera.position.y = Math.max(0.4, this.camera.position.y);
    this.camera.lookAt(this.currentLookAt);
    if ((twistX || twistY) && this.camera.rotateX) {
      this.camera.rotateX(twistX);
      this.camera.rotateY(twistY);
    }
    const roll = this.leanRoll + twistZ;
    if (roll && this.camera.rotateZ) this.camera.rotateZ(roll);
  }
}

export { CAMERA_PRESETS, CameraSystem };
