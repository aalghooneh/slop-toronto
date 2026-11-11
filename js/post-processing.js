import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  dot,
  mix,
  min,
  max,
  pow,
  smoothstep,
  length,
  screenUV,
  screenSize,
  fract,
  sin,
  time
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// Scene-linear color grading and lens bloom, composed in the existing final render pass.

// Exposure and white balance belong to the camera, independently of the physical lighting presets.
// Keep exposure restrained for ACES; stronger bloom stays selective so midtones retain their contrast.
const LOOKS = {
  golden:   { exposure: 1.04, contrast: 1.12, saturation: 1.08, balance: [1.045, 1.00, 0.955], bloom: 0.24, threshold: 1.20 },
  midday:   { exposure: 1.00, contrast: 1.10, saturation: 1.06, balance: [1.015, 1.00, 0.985], bloom: 0.18, threshold: 1.35 },
  twilight: { exposure: 1.06, contrast: 1.10, saturation: 1.08, balance: [1.025, 0.995, 1.015], bloom: 0.28, threshold: 1.05 },
  midnight: { exposure: 1.04, contrast: 1.08, saturation: 1.06, balance: [0.985, 1.00, 1.035], bloom: 0.30, threshold: 1.00 }
};

function createPostProcessing(renderer, sceneColor, reflections, sceneNormal = null, sceneDepth = null, occlusion = null) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Exposure is applied before bloom so its threshold follows the image's exposed brightness.
  // RenderPipeline performs ACES and the output color-space conversion exactly once, after this graph.
  renderer.toneMappingExposure = 1.0;

  const exposure = uniform(1.0);
  const contrast = uniform(1.0);
  const saturation = uniform(1.0);
  const balance = uniform(new THREE.Vector3(1, 1, 1));
  // Speed: the edges of the frame streak towards its centre (0 = still .. 1 = flat out), the middle stays sharp
  const speed = uniform(0.0);
  const fromCentre = screenUV.sub(0.5);
  const streak = speed.mul(smoothstep(0.16, 0.8, length(fromCentre)));
  let streaked = sceneColor.rgb;
  const STREAK_TAPS = 5;
  for (let i = 1; i <= STREAK_TAPS; i++) {
    streaked = streaked.add(sceneColor.sample(screenUV.sub(fromCentre.mul(streak.mul(i * 0.011)))).rgb);
  }
  streaked = streaked.div(STREAK_TAPS + 1);

  // Snow cover (weather.js): whatever faces the sky turns white, by the light that was falling on it (so shadows,
  // lamp light and headlights still read on the snow). The sky itself (depth 0 in the reversed depth buffer) stays
  const snowCover = uniform(0.0);
  const snowUp = uniform(new THREE.Vector3(0, 1, 0)); // world up in view space (main.js, every frame)
  const snowAmbient = uniform(0.3);
  let lit = streaked;
  let mirrored = reflections.rgb;
  if (sceneNormal && sceneDepth) {
    const facing = dot(sceneNormal.rgb, snowUp);
    // (not over what glows in colour: signals' light on the road is left to the snow, the gigs' guide line isn't)
    const chroma = max(max(streaked.r, streaked.g), streaked.b).sub(min(min(streaked.r, streaked.g), streaked.b));
    const lying = smoothstep(0.5, 0.86, facing).mul(snowCover).mul(sceneDepth.r.greaterThan(0.0).select(1.0, 0.0)).mul(0.9)
      .mul(float(1).sub(smoothstep(0.5, 1.0, chroma)));
    const light = dot(streaked, vec3(0.2126, 0.7152, 0.0722));
    const snow = vec3(0.93, 0.96, 1.0).mul(min(light.mul(2.6).add(snowAmbient), 1.35));
    lit = mix(streaked, snow, lying);
    mirrored = mirrored.mul(float(1).sub(lying));
  }

  // Ambient occlusion (GTAO at half resolution, main.js): corners, the foot of every wall, the road under the cars
  // and the gaps between buildings darken, which is what seats everything in the scene. Its sampling noise is
  // averaged over a 3 x 3 neighbourhood; what is brightly lit or glowing is left alone (the occlusion is of the
  // sky's light, not of the sun, lamps or lit windows)
  const aoStrength = uniform(0.85);
  if (occlusion) {
    const texel = vec2(1).div(screenSize).mul(2.0);
    let sum = occlusion.sample(screenUV).r.mul(2);
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      sum = sum.add(occlusion.sample(screenUV.add(texel.mul(vec2(ox, oy)))).r);
    }
    const ao = sum.div(10);
    const brightness = dot(lit, vec3(0.2126, 0.7152, 0.0722));
    const shade = mix(mix(float(1), ao, aoStrength), float(1), smoothstep(0.7, 2.2, brightness));
    lit = lit.mul(shade);
  }
  const exposed = max(lit.add(mirrored), vec3(0)).mul(exposure).mul(balance);

  // Limit only bloom's peak radiance, scaling RGB together to retain neon and lamp colors.
  // The original HDR image keeps its full range for the tone mapper's highlight shoulder.
  const peak = max(max(exposed.r, exposed.g), exposed.b);
  const bloomInput = vec4(exposed.mul(float(8.0).div(max(peak, 8.0))), 1.0);
  const bloomPass = bloom(bloomInput, 0.24, 0.40, 1.20);
  bloomPass.smoothWidth.value = 0.30;
  bloomPass.setResolutionScale(0.5);

  const outputNode = Fn(() => {
    const color = exposed.add(bloomPass.rgb).toVar();
    const luma = dot(color, vec3(0.2126, 0.7152, 0.0722)).toVar();

    // Gentle cool shadow / warm highlight separation; multiply rather than lifting the black level.
    const shadows = mix(vec3(0.965, 1.005, 1.045), vec3(1), smoothstep(0.02, 0.60, luma));
    const highlights = mix(vec3(1), vec3(1.035, 1.005, 0.965), smoothstep(0.60, 3.0, luma));
    color.mulAssign(shadows.mul(highlights));

    // Contrast pivots around middle gray and scales RGB together, avoiding per-channel gamma shifts.
    color.mulAssign(pow(max(luma, 0.0001).div(0.18), contrast.sub(1.0)));
    const gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
    const chroma = max(max(color.r, color.g), color.b).sub(min(min(color.r, color.g), color.b));
    const vibrance = float(0.10).mul(float(1).sub(chroma.div(max(max(max(color.r, color.g), color.b), 0.0001))));
    color.assign(max(mix(vec3(gray), color, saturation.add(vibrance)), vec3(0)));

    // Normalize by the corner radius so the lens falloff remains subtle in portrait and landscape.
    const aspect = screenSize.x.div(screenSize.y);
    const radius = length(screenUV.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
    const vignette = float(1).sub(smoothstep(0.35, 1.0, radius).mul(0.16));
    // A breath of film grain, finest in the shadows: it hides banding in the sky and the fog
    const grain = fract(sin(dot(screenUV.mul(screenSize).add(time.mul(61.7)), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
    const grained = color.mul(vignette).mul(float(1).add(grain.mul(0.045)));
    return vec4(max(grained, vec3(0)), 1.0);
  })();

  function applyPreset(id) {
    const look = LOOKS[id] || LOOKS.golden;
    exposure.value = look.exposure;
    contrast.value = look.contrast;
    saturation.value = look.saturation;
    balance.value.set(...look.balance);
    bloomPass.strength.value = look.bloom;
    bloomPass.threshold.value = look.threshold;
  }

  applyPreset('golden');
  return { outputNode, applyPreset, speed, snowCover, snowUp, snowAmbient, aoStrength };
}

export { createPostProcessing };
