import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// js/player-car.js
// The player's car as a detailed model instead of the lofted one the traffic uses: a Chevrolet Corvette C7, with a
// modelled interior, brake discs behind the spokes, and lamps that light (assets/corvette.glb, "Chevrolet Corvette
// (C7)" by Martin Trafas on Sketchfab, CC BY 4.0, slimmed by tools/slim-gltf.py: see the README for the credit).
// Should it not load, three.js's example car stands in (assets/ferrari.glb, "Ferrari 458 Italia" by vicent091036,
// Draco-compressed). Both have their body, glass, lamps and each wheel as separate nodes, which is what lets the
// wheels spin & steer and the lamps work.
//
// loadPlayerCar() swaps the model in for the lofted body on the car entity controllers.js made (same pivots, so the
// suspension, the steering and the headlight beams carry over) and leaves the lofted car in place if neither loads.

const DRACO_URL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@dev/examples/jsm/libs/draco/gltf/';

// What the game needs to know about a model: which way it faces, how long the real car is (to scale it), which of
// its materials are the paint, the glass, the lamps & the tyres, and how its wheels are named
const MODELS = [
  {
    url: new URL('../assets/corvette.glb', import.meta.url).href,
    label: 'Corvette C7',
    length: 4.49,
    turn: 0, // (its nose already points down +z)
    paintColor: 0xf2b705, // racing yellow, under a clear coat
    paint: ['Car_Paint'],
    glass: ['Windows'],
    tail: ['Tail_Lights_Red_Cover', 'Tail_Lights_Red_Cover_2'],
    head: ['Main_Headlight_Lens', 'Daylight_Cover'],
    tyres: ['TireMaterial'],
    roof: ['Car_Paint_2'],
    wheel: /^Rim[ _](FL|FR|RL|RR)$/,
    caliper: /^Brake[ _]Caliper[ _](FL|FR|RL|RR)$/,
    plate: [0.61, 0.012], // (height, and how far in from the very tail)
    engineZ: 1.25, // (in front of the driver)
    chase: [6.4, 1.9, 0.85]
  },
  {
    url: new URL('../assets/ferrari.glb', import.meta.url).href,
    label: 'V8 Coupé',
    length: 0, // (already in metres)
    turn: Math.PI, // (its nose points down -z)
    paintColor: 0xa5121a,
    paint: ['Body_Color'],
    glass: ['Glass_Gray'],
    tail: ['Taillight_Glass'],
    head: ['Projector_Glass', 'Turn_Signal_LED'],
    tyres: ['Tires'],
    roof: [],
    wheel: /^wheel_(fl|fr|rl|rr)$/,
    caliper: null,
    plate: [0.5, -0.004],
    engineZ: -1.5, // (behind the seats)
    chase: [6.3, 1.85, 0.85]
  }
];

async function loadPlayerCar(car) {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_URL);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  try {
    for (const spec of MODELS) {
      try {
        const gltf = await loader.loadAsync(spec.url);
        if (fitPlayerCar(car, gltf.scene, spec)) return true;
      } catch (e) {
        console.warn(`[car] ${spec.label} did not load`, e);
      }
    }
  } finally {
    draco.dispose();
  }
  console.warn('[car] no detailed model: keeping the lofted car');
  return false;
}

function fitPlayerCar(car, model, spec) {
  const root = car.mesh;
  const pivot = car.chassisPivot;
  // Measured at the origin, whatever the car is doing as it loads
  const saved = { position: root.position.clone(), rotation: root.rotation.clone(), px: pivot.rotation.x, pz: pivot.rotation.z, py: pivot.position.y };
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  pivot.rotation.set(0, 0, 0);
  pivot.position.set(0, 0, 0);
  root.updateMatrixWorld(true);

  // Turned to face the way the car drives (+z), scaled to the real car's length, centred, standing on its tyres
  model.rotation.y = spec.turn;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (spec.length) model.scale.multiplyScalar(spec.length / (box.max.z - box.min.z));
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  if (spec.length) {
    model.position.x -= (box.min.x + box.max.x) * 0.5;
    model.position.z -= (box.min.z + box.max.z) * 0.5;
  }
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);
  box.setFromObject(model);

  // Paint, glass and lamps
  const paint = new THREE.MeshPhysicalNodeMaterial({ color: spec.paintColor, metalness: 0.85, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.035 });
  const glass = new THREE.MeshPhysicalNodeMaterial({ color: 0x06080b, metalness: 0.9, roughness: 0.02, transparent: true, opacity: 0.93 });
  const tail = new THREE.MeshStandardNodeMaterial({ color: 0x3a0606, emissive: 0xff1608, emissiveIntensity: 0.3, roughness: 0.3 });
  const head = new THREE.MeshStandardNodeMaterial({ color: 0xdfe6ee, emissive: 0xeaf2ff, emissiveIntensity: 0.1, roughness: 0.2 });
  const rubber = new THREE.MeshStandardNodeMaterial({ color: 0x0c0c0d, roughness: 0.86 });
  const roofBox = new THREE.Box3();
  const wheelNodes = [];
  const caliperNodes = [];
  model.traverse((o) => {
    if (spec.wheel.test(o.name)) wheelNodes.push(o);
    else if (spec.caliper && spec.caliper.test(o.name)) caliperNodes.push(o);
    if (!o.isMesh) return;
    const name = o.material?.name || '';
    const see = !!o.material?.transparent;
    if (spec.roof.includes(name)) roofBox.expandByObject(o);
    if (spec.paint.includes(name)) o.material = paint;
    else if (spec.glass.includes(name)) o.material = glass;
    else if (spec.tail.includes(name)) o.material = tail;
    else if (spec.head.includes(name)) o.material = head;
    else if (spec.tyres.includes(name)) o.material = rubber;
    o.castShadow = o.material !== glass && !see;
    o.receiveShadow = o.material !== glass && !see;
  });

  // Wheels: out of the body onto the car's own pivots (they don't lean or dive with it), each in a group that
  // steers (the fronts) holding a group that spins
  const wheels = [];
  const centre = new THREE.Vector3();
  const wheelBox = new THREE.Box3();
  for (const wheel of wheelNodes) {
    // (the middle of the wheel, wherever the model put its node's origin)
    wheelBox.setFromObject(wheel).getCenter(centre);
    const steerPivot = new THREE.Group();
    steerPivot.position.copy(centre);
    const tire = new THREE.Group();
    steerPivot.add(tire);
    root.add(steerPivot);
    steerPivot.updateMatrixWorld(true);
    tire.attach(wheel);
    // the brake caliper steers with its wheel, but doesn't go round with it
    const corner = wheel.name.slice(-2);
    const caliper = caliperNodes.find((c) => c.name.slice(-2) === corner);
    if (caliper) steerPivot.attach(caliper);
    wheels.push({ steerPivot, tire, isFront: centre.z > 0 });
  }
  if (wheels.length !== 4) {
    console.warn(`[car] ${spec.label} has no separate wheels`);
    for (const w of wheels) root.remove(w.steerPivot);
    root.position.copy(saved.position);
    root.rotation.copy(saved.rotation);
    pivot.rotation.x = saved.px;
    pivot.rotation.z = saved.pz;
    pivot.position.y = saved.py;
    return false;
  }

  // The lofted body, its plates and wheels make way (the headlight beams stay, moved to the new nose)
  for (const child of pivot.children) if (child.isMesh) child.visible = false;
  for (const w of car.wheels) w.steerPivot.visible = false;
  pivot.add(model);
  car.wheels = wheels;
  for (const spot of car.headLights || []) {
    const side = Math.sign(spot.position.x) || 1;
    spot.position.set(side * 0.66, 0.64, box.max.z - 0.35);
    spot.target.position.set(side * 0.9, 0.05, box.max.z + 9.5);
  }
  // The Ontario plate, on the tail
  if (car.plates) {
    car.plates.rear.visible = true;
    car.plates.rear.position.set(0, spec.plate[0], box.min.z + spec.plate[1]);
  }

  // Lamps: the tail lamps glow at night and flare under braking, the headlamps come on with the dusk
  car.modelLights = { tail, head };
  car.label = spec.label;
  car.chaseDistance = spec.chase[0];
  car.chaseHeight = spec.chase[1];
  car.cameraTargetOffset.y = spec.chase[2];
  car.detailed = true;
  // (for the rubber & smoke it leaves, car-effects.js, and the turret on its roof, combat.js)
  const rear = wheels.filter((w) => !w.isFront);
  car.rearTrack = Math.abs(rear[0].steerPivot.position.x);
  car.rearAxleZ = rear[0].steerPivot.position.z;
  car.engineZ = spec.engineZ;
  car.turretMount = roofBox.isEmpty()
    ? { x: 0, y: box.max.y - 0.02, z: -0.3 }
    : { x: 0, y: roofBox.max.y - 0.015, z: (roofBox.min.z + roofBox.max.z) * 0.5 };

  root.position.copy(saved.position);
  root.rotation.copy(saved.rotation);
  pivot.rotation.x = saved.px;
  pivot.rotation.z = saved.pz;
  pivot.position.y = saved.py;
  return true;
}

export { loadPlayerCar };
