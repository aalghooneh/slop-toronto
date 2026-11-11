import * as THREE from 'three/webgpu';
import { mrt, vec4, attribute, uniform, float, vec3, cameraPosition, time, mod, cross, normalize, smoothstep, length, abs, mix } from 'three/tsl';

// js/weather.js
// Toronto's weather: clear, rain or snow. The lighting (lighting.js) clouds over, the roads soak (the road materials'
// wetness) and this module fills the air around the camera with rain streaks or snowflakes. The drops live on the
// GPU: every one has a fixed place in a box that repeats around the camera, and falls through it with the clock, so
// nothing is updated per frame but two uniforms.

const WEATHER = {
  clear: { id: 'clear', name: 'Clear', rain: 0, snow: 0, grip: 1 },
  rain: { id: 'rain', name: 'Rain', rain: 1, snow: 0, grip: 0.74 },
  snow: { id: 'snow', name: 'Snow', rain: 0, snow: 1, grip: 0.58 }
};
const WEATHER_ORDER = ['clear', 'rain', 'snow'];

// Effects drawn over the scene leave its normals & reflectivity as they were (the reflections, the ambient occlusion
// and the snow cover in post-processing.js keep seeing what is underneath)
const KEEP_SURFACE = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });

const DROPS = 10000;
const BOX = new THREE.Vector3(46, 26, 46);

class Precipitation {
  constructor(scene) {
    // One quad per drop: `seed` is its place in the box (0..1), `corner` its corner of the quad
    const seeds = new Float32Array(DROPS * 4 * 4);
    const corners = new Float32Array(DROPS * 4 * 2);
    const positions = new Float32Array(DROPS * 4 * 3);
    const index = new Uint32Array(DROPS * 6);
    let state = 0x2545f491;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    for (let i = 0; i < DROPS; i++) {
      const s = [random(), random(), random(), random()];
      for (let c = 0; c < 4; c++) {
        seeds.set(s, (i * 4 + c) * 4);
        corners.set([c & 1 ? 0.5 : -0.5, c & 2 ? 0.5 : -0.5], (i * 4 + c) * 2);
      }
      const v = i * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    geo.setAttribute('corner', new THREE.BufferAttribute(corners, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    this.amount = uniform(0); // 0 none .. 1 pouring: how many of the drops fall, and how bright
    this.snow = uniform(0); // 0 rain .. 1 snow
    this.light = uniform(1); // the daylight on them
    const box = uniform(BOX);
    const seed = attribute('seed', 'vec4');
    const corner = attribute('corner', 'vec2');

    // Rain falls fast and nearly straight; snow drifts down slowly, wandering as it goes
    const fall = mix(float(17), float(1.5), this.snow).mul(seed.w.mul(0.35).add(0.8));
    const wander = vec3(
      time.mul(0.9).add(seed.w.mul(40)).sin().mul(0.55),
      0,
      time.mul(0.7).add(seed.x.mul(40)).cos().mul(0.55)
    ).mul(this.snow);
    const wind = vec3(1.6, 0, 0.7).mul(mix(float(1), float(0.5), this.snow));
    const base = seed.xyz.mul(box).add(wind.mul(time)).add(wander).sub(vec3(0, 1, 0).mul(fall.mul(time)));
    // (wrapped into the box centred on the camera, a little ahead of nothing: all around it)
    const centre = mod(base.sub(cameraPosition), box).sub(box.mul(0.5)).add(cameraPosition);
    const toCamera = normalize(cameraPosition.sub(centre));
    const side = normalize(cross(vec3(0, 1, 0), toCamera));
    const up = normalize(mix(vec3(0, 1, 0).sub(wind.mul(0.06)), cross(toCamera, side), this.snow));
    const width = mix(float(0.02), float(0.055), this.snow);
    const height = mix(float(0.85), float(0.05), this.snow);

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    mat.positionNode = centre.add(side.mul(corner.x).mul(width)).add(up.mul(corner.y).mul(height));
    // only as many drops as it is raining; they fade out at the box's edge so that none pops in
    const edge = smoothstep(0.5, 0.36, length(centre.sub(cameraPosition).div(box)));
    const falling = smoothstep(this.amount, this.amount.sub(0.08), seed.w);
    const across = abs(corner.x).mul(2);
    const along = abs(corner.y).mul(2);
    const shape = mix(smoothstep(1, 0.2, across).mul(smoothstep(1, 0.3, along)), smoothstep(1, 0.35, length(corner).mul(2)), this.snow);
    mat.opacityNode = shape.mul(edge).mul(falling).mul(mix(float(0.42), float(0.9), this.snow));
    mat.colorNode = mix(vec3(0.72, 0.8, 0.9), vec3(1, 1, 1), this.snow).mul(this.light);

    mat.mrtNode = KEEP_SURFACE;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Precipitation';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);
  }
}

class WeatherSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} lighting - the LightingSystem (setWeather() clouds the sky over and soaks the roads)
   */
  constructor(scene, lighting) {
    this.lighting = lighting;
    this.precipitation = new Precipitation(scene);
    this.id = 'clear';
    this.amount = 0; // eased: the precipitation thins out and comes on over a few seconds
    this.cover = 0; // 0..1: how much snow lies on the city
  }

  get current() {
    return WEATHER[this.id];
  }

  // How well the tyres hold the road (1 dry)
  get grip() {
    return 1 + (this.current.grip - 1) * this.amount;
  }

  set(id) {
    if (!WEATHER[id] || id === this.id) return false;
    this.id = id;
    this.lighting.setWeather(WEATHER[id]);
    return true;
  }

  cycle() {
    this.set(WEATHER_ORDER[(WEATHER_ORDER.indexOf(this.id) + 1) % WEATHER_ORDER.length]);
    return this.current;
  }

  update(dt, daylight) {
    const w = this.current;
    const p = this.precipitation;
    const wet = w.rain || w.snow;
    // Rain to snow (or back): what is falling thins right out, changes kind, and comes on again
    const matches = !wet || p.snow.value === w.snow || this.amount < 0.05;
    if (wet && matches) p.snow.value = w.snow;
    this.amount += ((wet && matches ? 1 : 0) - this.amount) * Math.min(1, dt * (matches ? 0.9 : 2.5));
    p.amount.value = this.amount;
    p.light.value = daylight;
    // Snow settles (post-processing.js whitens whatever faces the sky) and melts away again more slowly
    const settle = w.snow && p.snow.value ? 1 : 0;
    this.cover += (settle - this.cover) * Math.min(1, dt * (settle ? 0.35 : 0.5));
    p.mesh.visible = this.amount > 0.004 || !this.drawn;
    this.drawn = true; // (drawn once, empty, so its pipeline compiles behind the loading screen)
  }
}

export { WeatherSystem, WEATHER, WEATHER_ORDER };
