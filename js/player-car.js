import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// js/player-car.js
// The player's car as a detailed model instead of the lofted one the traffic uses: a mid-engined V8 coupé with a
// modelled interior, brake discs behind the spokes, and lamps that light. The model is three.js's example car
// (assets/ferrari.glb, "Ferrari 458 Italia" by vicent091036 on Sketchfab: see the README for the credit), Draco-compressed, with its body,
// glass, lamps and each wheel as separate nodes, which is what lets the wheels spin & steer and the lamps work.
//
// loadPlayerCar() swaps it in for the lofted body on the car entity controllers.js made (same pivots, so the
// suspension, the steering and the headlight beams carry over) and leaves the lofted car in place if it can't load.

const MODEL_URL = new URL('../assets/ferrari.glb', import.meta.url).href;
const DRACO_URL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@dev/examples/jsm/libs/draco/gltf/';
const PAINT = 0xa5121a; // a deep red, under a clear coat

async function loadPlayerCar(car) {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_URL);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  let gltf;
  try {
    gltf = await loader.loadAsync(MODEL_URL);
  } catch (e) {
    console.warn('[car] the detailed model did not load; keeping the lofted one', e);
    return false;
  } finally {
    draco.dispose();
  }

  const root = car.mesh;
  const pivot = car.chassisPivot;
  // Measured at the origin, whatever the car is doing as it loads
  const saved = { position: root.position.clone(), rotation: root.rotation.clone(), px: pivot.rotation.x, pz: pivot.rotation.z, py: pivot.position.y };
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  pivot.rotation.set(0, 0, 0);
  pivot.position.set(0, 0, 0);
  root.updateMatrixWorld(true);

  // The model's nose points down -z: turned to face the way the car drives (+z), standing on its tyres
  const model = gltf.scene;
  model.rotation.y = Math.PI;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  model.position.y = -box.min.y;
  model.updateMatrixWorld(true);
  box.setFromObject(model);

  // Paint, glass and lamps
  const paint = new THREE.MeshPhysicalNodeMaterial({ color: PAINT, metalness: 0.85, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.035 });
  const glass = new THREE.MeshPhysicalNodeMaterial({ color: 0x06080b, metalness: 0.9, roughness: 0.02, transparent: true, opacity: 0.93 });
  const tail = new THREE.MeshStandardNodeMaterial({ color: 0x3a0606, emissive: 0xff1608, emissiveIntensity: 0.3, roughness: 0.3 });
  const head = new THREE.MeshStandardNodeMaterial({ color: 0xdfe6ee, emissive: 0xeaf2ff, emissiveIntensity: 0.1, roughness: 0.2 });
  const rubber = new THREE.MeshStandardNodeMaterial({ color: 0x0c0c0d, roughness: 0.86 });
  model.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.material?.name || '';
    if (name === 'Body_Color') o.material = paint;
    else if (name === 'Glass_Gray') o.material = glass;
    else if (name === 'Taillight_Glass') o.material = tail;
    else if (name === 'Projector_Glass' || name === 'Turn_Signal_LED') o.material = head;
    else if (name === 'Tires') o.material = rubber;
    o.castShadow = o.material !== glass;
    o.receiveShadow = o.material !== glass;
  });

  // Wheels: out of the body onto the car's own pivots (they don't lean or dive with it), each in a group that
  // steers (the fronts) holding a group that spins
  const wheels = [];
  const centre = new THREE.Vector3();
  for (const [name, isFront] of [['wheel_fl', true], ['wheel_fr', true], ['wheel_rl', false], ['wheel_rr', false]]) {
    const wheel = model.getObjectByName(name);
    if (!wheel) continue;
    wheel.getWorldPosition(centre);
    const steerPivot = new THREE.Group();
    steerPivot.position.copy(centre);
    const tire = new THREE.Group();
    steerPivot.add(tire);
    root.add(steerPivot);
    steerPivot.updateMatrixWorld(true);
    tire.attach(wheel);
    wheels.push({ steerPivot, tire, isFront });
  }
  if (wheels.length !== 4) {
    console.warn('[car] the model has no separate wheels; keeping the lofted car');
    for (const w of wheels) root.remove(w.steerPivot);
    Object.assign(root.position, saved.position);
    root.rotation.copy(saved.rotation);
    return false;
  }

  // The lofted body, its plates and wheels make way (the headlight beams stay, moved to the new nose)
  for (const child of pivot.children) if (child.isMesh) child.visible = false;
  for (const w of car.wheels) w.steerPivot.visible = false;
  pivot.add(model);
  car.wheels = wheels;
  for (const spot of car.headLights || []) {
    const side = Math.sign(spot.position.x) || 1;
    spot.position.set(side * 0.66, 0.62, box.max.z - 0.35);
    spot.target.position.set(side * 0.9, 0.05, box.max.z + 9.5);
  }
  // The Ontario plate, on the tail
  if (car.plates) {
    car.plates.rear.visible = true;
    car.plates.rear.position.set(0, 0.5, box.min.z - 0.004);
  }

  // Lamps: the tail lamps glow at night and flare under braking, the headlamps come on with the dusk
  car.modelLights = { tail, head };
  car.label = 'V8 Coupé';
  car.chaseDistance = 6.3;
  car.chaseHeight = 1.85;
  car.cameraTargetOffset.y = 0.85;
  car.detailed = true;

  root.position.copy(saved.position);
  root.rotation.copy(saved.rotation);
  pivot.rotation.x = saved.px;
  pivot.rotation.z = saved.pz;
  pivot.position.y = saved.py;
  return true;
}

export { loadPlayerCar };
