import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  attribute,
  texture,
  positionWorld,
  positionGeometry,
  normalGeometry,
  sin,
  abs,
  floor,
  fract,
  max,
  min,
  clamp,
  mix,
  step,
  smoothstep,
  dot,
  fwidth,
  select
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';
import { MAINLAND_POLYGONS, ISLAND_POLYGONS, RUNWAYS, CITY_LAND, LL, POINTS, landDistance } from './city-config.js';

// js/surroundings.js
// The rest of Toronto around the simulated downtown, at true 1:1 scale on the real geography (1 unit = 1 m, x = street
// grid east, z = grid south, origin at Yonge & Queen), built to read as real places from the street, the harbour, the
// helicopter and the CN Tower's LookOut while staying cheap:
// - The mainland from the real Lake Ontario shore (Mississauga to Pickering; dock walls along the water only) and the
//   Toronto Islands, Ontario Place's islands & the Leslie Street Spit
// - A procedural ground shader: the concession-road grid (arterials every ~2 km on the grid's bearing) with residential
//   streets, roofs & backyard trees between them, overridden by a land-use map of the real parks, ravines, cemeteries,
//   rail & port lands; sodium street lights at night
// - Instanced buildings: house rows on the residential blocks, mid-rise along the arterials, and the real high-rise
//   clusters (Liberty Village, Humber Bay Shores, Yonge & St. Clair, Yonge & Eglinton, North York Centre, Thorncliffe
//   Park, Mississauga City Centre, Scarborough Centre...)
// - Landmarks seen from downtown: the Hearn's 215 m stack in the Port Lands, Ontario Place's Cinesphere, BMO Field &
//   the Exhibition, Billy Bishop airport, Gibraltar Point's lighthouse, Casa Loma and the Prince Edward (Bloor) Viaduct

// =====================================================================================================================
// 1. HELPERS
// =====================================================================================================================
const toLinear = (c) => Math.pow(c, 2.2);
const srgb = (r, g, b) => vec3(toLinear(r), toLinear(g), toLinear(b));
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function polygonBounds(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}
// Spatial index of a big polygon: z-bands holding the edges that span them, for exact point-in-polygon tests
const BAND = 64;
function indexPolygon(pts) {
  const b = polygonBounds(pts);
  const bands = Array.from({ length: Math.floor((b.maxZ - b.minZ) / BAND) + 1 }, () => []);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const k1 = Math.floor((Math.max(p.z, q.z) - b.minZ) / BAND);
    for (let k = Math.floor((Math.min(p.z, q.z) - b.minZ) / BAND); k <= k1; k++) bands[k].push(i);
  }
  return { pts, b, bands };
}
function insideIndexed(ix, x, z) {
  const { b, pts } = ix;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
  let inside = false;
  for (const i of ix.bands[Math.floor((z - b.minZ) / BAND)]) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    if ((p.z > z) !== (q.z > z) && x < ((q.x - p.x) * (z - p.z)) / (q.z - p.z) + p.x) inside = !inside;
  }
  return inside;
}

// Land masses (top heights in metres; downtown's street deck is y = 0, the lake y = -2.0)
const LAND = [];
const addLand = (id, pts, top, extra = {}) => {
  if (pts && pts.length >= 3) LAND.push({ id, pts, top, index: indexPolygon(pts), ...extra });
};
for (const [k, pts] of Object.entries(MAINLAND_POLYGONS)) addLand(`mainland-${k}`, pts, 0.0, { mainland: true });
ISLAND_POLYGONS.forEach((pts, i) => addLand(`island-${i}`, pts, 0.35, { island: true }));
const landAt = (x, z) => LAND.find((l) => insideIndexed(l.index, x, z)) || null;
const CITY_INDEX = indexPolygon(CITY_LAND);

// =====================================================================================================================
// 2. LAND-USE MAP (R = park / woods, G = industry / rail / port, B = low-density leafy suburb), ~31 m texels
// =====================================================================================================================
const LU = { minX: -16000, maxX: 16000, minZ: -16000, maxZ: 16000, w: 1024, h: 1024 };
function paintLandUse() {
  const c = document.createElement('canvas');
  c.width = LU.w;
  c.height = LU.h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(0,0,40)';
  ctx.fillRect(0, 0, LU.w, LU.h);
  const px = (p) => [((p.x - LU.minX) / (LU.maxX - LU.minX)) * LU.w, ((p.z - LU.minZ) / (LU.maxZ - LU.minZ)) * LU.h];
  const m = LU.w / (LU.maxX - LU.minX); // texels per metre
  ctx.globalCompositeOperation = 'lighter';
  const ellipse = (lon, lat, rx, rz, rgb) => {
    const [x, y] = px(LL(lon, lat));
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rx * m, rz * m, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  const stroke = (pts, w, rgb) => {
    ctx.strokeStyle = `rgb(${rgb})`;
    ctx.lineWidth = Math.max(1, w * m);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([lon, lat], i) => {
      const [x, y] = px(LL(lon, lat));
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  const PARK = '255,0,0';
  const IND = '0,255,0';
  const LEAFY = '0,0,180';
  // The ravines: the Don Valley (with its East & West branches), the Humber, Rosedale's & Taylor Creek
  stroke([[-79.3550, 43.6530], [-79.3585, 43.6650], [-79.3635, 43.6760], [-79.3690, 43.6870], [-79.3640, 43.6970], [-79.3480, 43.7060], [-79.3380, 43.7150], [-79.3320, 43.7300], [-79.3420, 43.7450]], 420, PARK);
  stroke([[-79.3690, 43.6870], [-79.3830, 43.6950], [-79.3920, 43.7100], [-79.3990, 43.7300]], 260, PARK);
  stroke([[-79.3800, 43.6800], [-79.3700, 43.6840], [-79.3620, 43.6840]], 120, PARK);
  stroke([[-79.3370, 43.7030], [-79.3150, 43.6990], [-79.2950, 43.6990]], 160, PARK);
  stroke([[-79.4740, 43.6300], [-79.4890, 43.6480], [-79.5010, 43.6650], [-79.5100, 43.6900], [-79.5170, 43.7200], [-79.5300, 43.7500]], 380, PARK);
  // Parks & cemeteries
  ellipse(-79.4637, 43.6465, 650, 900, PARK); // High Park
  ellipse(-79.3866, 43.6942, 700, 450, PARK); // Mount Pleasant Cemetery
  ellipse(-79.3555, 43.6702, 260, 380, PARK); // Riverdale Park
  ellipse(-79.4140, 43.6476, 170, 260, PARK); // Trinity Bellwoods
  ellipse(-79.4202, 43.6645, 140, 160, PARK); // Christie Pits
  ellipse(-79.4155, 43.6545, 200, 120, PARK); // Bickford Park & Fred Hamilton
  ellipse(-79.3606, 43.6789, 300, 200, PARK); // St. James Cemetery & Necropolis
  ellipse(-79.4054, 43.6889, 250, 200, PARK); // Sir Winston Churchill Park & the reservoir
  ellipse(-79.3880, 43.6550, 1, 1, PARK);
  ellipse(-79.3500, 43.6880, 520, 360, PARK); // Evergreen Brick Works & Chester Hill
  ellipse(-79.4280, 43.6780, 180, 200, PARK); // Wychwood Barns & Hillcrest
  ellipse(-79.3135, 43.6630, 260, 200, PARK); // Woodbine Beach & Ashbridge's Bay
  ellipse(-79.2950, 43.6680, 520, 160, PARK); // the Beaches' boardwalk parks
  ellipse(-79.4930, 43.6275, 260, 200, PARK); // Humber Bay Park
  ellipse(-79.4250, 43.6290, 420, 180, '120,90,0'); // Exhibition Place's grounds
  stroke([[-79.3410, 43.6420], [-79.3330, 43.6280], [-79.3260, 43.6140], [-79.3250, 43.6110]], 360, PARK); // Tommy Thompson Park (the Leslie Spit)
  // Port Lands, the rail corridors & yards, the airports' aprons
  ellipse(-79.3360, 43.6450, 1300, 600, IND);
  stroke([[-79.4250, 43.6380], [-79.4500, 43.6380], [-79.4800, 43.6400]], 120, IND); // Lakeshore West corridor
  stroke([[-79.4050, 43.6370], [-79.4300, 43.6560], [-79.4450, 43.6750], [-79.4650, 43.7050]], 90, IND); // Barrie & Kitchener lines
  stroke([[-79.3550, 43.6550], [-79.3300, 43.6640], [-79.2900, 43.6790], [-79.2500, 43.7000]], 90, IND); // Lakeshore East
  stroke([[-79.3880, 43.6830], [-79.3600, 43.6880], [-79.3300, 43.7020]], 70, IND); // North Toronto subdivision
  ellipse(-79.3620, 43.7250, 500, 300, IND); // Leaside's industry
  ellipse(-79.4850, 43.6550, 700, 300, IND); // the Junction's rail yards
  // The leafy, low-density neighbourhoods: Rosedale, Forest Hill, Lawrence Park, the Kingsway, the Beaches
  ellipse(-79.3800, 43.6810, 900, 600, LEAFY);
  ellipse(-79.4150, 43.6950, 1000, 800, LEAFY);
  ellipse(-79.4000, 43.7250, 900, 800, LEAFY);
  ellipse(-79.5050, 43.6550, 1200, 900, LEAFY);
  ellipse(-79.2950, 43.6720, 900, 500, LEAFY);
  const img = ctx.getImageData(0, 0, LU.w, LU.h).data;
  const data = new Uint8Array(LU.w * LU.h * 4);
  for (let i = 0; i < LU.w * LU.h * 4; i++) data[i] = img[i];
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tex = new THREE.DataTexture(data, LU.w, LU.h, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, data };
}
let landUse = null;
const luAt = (x, z) => {
  const i = Math.max(0, Math.min(LU.w - 1, Math.floor(((x - LU.minX) / (LU.maxX - LU.minX)) * LU.w)));
  const j = Math.max(0, Math.min(LU.h - 1, Math.floor(((z - LU.minZ) / (LU.maxZ - LU.minZ)) * LU.h)));
  const k = (j * LU.w + i) * 4;
  return { park: landUse.data[k] / 255, industry: landUse.data[k + 1] / 255, leafy: landUse.data[k + 2] / 255 };
};

// =====================================================================================================================
// 3. MATERIALS
// =====================================================================================================================
const hash12 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const valueNoise = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash12(i);
  const b = hash12(i.add(vec2(1.0, 0.0)));
  const c = hash12(i.add(vec2(0.0, 1.0)));
  const d = hash12(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});
// Box-filtered periodic pulse (fraction of a footprint `w` around `x` where fract() lies in [a, b]): settles to the mean
// coverage once a period shrinks below a pixel, so grids never shimmer at distance
const boxPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});
// 0 by day, ~0.75 at blue hour, 1 at night
const nightFactorNode = () => smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);

// Residential blocks (north-south streets every ~95 m, east-west ones every ~250 m) between the concession-road
// arterials (every 2 km each way, wider), then the land-use map's parks, industry & leafy suburbs
const BLOCK_U = 95;
const BLOCK_V = 250;
const ARTERIAL = 2000;
function createLandMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0 });
  const wp = positionWorld;
  const lu = texture(landUse.tex, vec2(wp.x.sub(LU.minX).div(LU.maxX - LU.minX), wp.z.sub(LU.minZ).div(LU.maxZ - LU.minZ))).toVar();
  const gu = wp.x.div(BLOCK_U).toVar();
  const gv = wp.z.div(BLOCK_V).toVar();
  const fwU = fwidth(gu).toVar();
  const fwV = fwidth(gv).toVar();
  const hu = float(5.0 / BLOCK_U);
  const hv = float(5.0 / BLOCK_V);
  const inBlock = boxPulse(gu, hu, float(1.0).sub(hu), fwU).mul(boxPulse(gv, hv, float(1.0).sub(hv), fwV)).toVar();
  const swU = float(2.2 / BLOCK_U);
  const swV = float(2.2 / BLOCK_V);
  const inLots = boxPulse(gu, hu.add(swU), float(1.0).sub(hu).sub(swU), fwU).mul(boxPulse(gv, hv.add(swV), float(1.0).sub(hv).sub(swV), fwV)).toVar();
  // arterials
  const au = wp.x.div(ARTERIAL);
  const av = wp.z.div(ARTERIAL);
  const ah = float(11.0 / ARTERIAL);
  const arterial = float(1.0).sub(boxPulse(au, ah, float(1.0).sub(ah), fwidth(au)).mul(boxPulse(av, ah, float(1.0).sub(ah), fwidth(av)))).toVar();

  // Lots ~8 m wide along the block, two rows of roofs with a band of backyard trees between them
  const cell = floor(vec2(gu, gv));
  const lotId = vec2(floor(fract(gu).mul(BLOCK_U / 8.0)).add(cell.x.mul(17.0)), cell.y.mul(3.0).add(floor(fract(gv).mul(3.0))));
  const lotHash = hash12(lotId).toVar();
  const lotDetail = float(1.0).sub(smoothstep(0.35, 1.1, max(fwU.mul(BLOCK_U / 8.0), fwV.mul(3.0)))).toVar();
  const roofVar = mix(mix(srgb(0.30, 0.30, 0.29), srgb(0.50, 0.49, 0.48), step(0.38, lotHash)), mix(srgb(0.46, 0.34, 0.28), srgb(0.72, 0.71, 0.69), step(0.86, lotHash)), step(0.66, lotHash));
  const roofCol = mix(srgb(0.43, 0.41, 0.39), roofVar, lotDetail);
  const yardBand = boxPulse(fract(gu), 0.3, 0.7, fwU);
  const treeNoise = valueNoise(wp.xz.mul(0.11)).toVar();
  const cTree = mix(srgb(0.19, 0.26, 0.13), srgb(0.30, 0.37, 0.19), treeNoise);
  const yardAmount = clamp(yardBand.mul(0.8).add(lu.b.mul(0.5)).mul(smoothstep(0.25, 0.65, treeNoise.add(lu.b.mul(0.3)))), 0.0, 1.0);
  const lotsCol = mix(roofCol, cTree, yardAmount);
  const cAsphalt = srgb(0.30, 0.30, 0.31);
  const cSidewalk = srgb(0.56, 0.55, 0.53);
  let urban = mix(cAsphalt, mix(cSidewalk, lotsCol, inLots.div(max(inBlock, 0.001))), inBlock);
  urban = mix(urban, cAsphalt, arterial);

  // Industry, rail & port: big light roofs, tank farms and concrete yards in coarse cells
  const indCell = hash12(floor(wp.xz.div(30.0)));
  const cIndustry = mix(srgb(0.50, 0.49, 0.47), mix(srgb(0.70, 0.69, 0.67), srgb(0.52, 0.42, 0.35), step(0.82, indCell)), step(0.45, indCell));
  // Parks, ravines & woods: lawn clearings among dense canopy
  const woods = smoothstep(0.35, 0.7, valueNoise(wp.xz.mul(0.045)).add(treeNoise.mul(0.35)));
  const cPark = mix(srgb(0.36, 0.45, 0.2), cTree, woods);
  const park = lu.r.toVar();
  let col = mix(urban, cIndustry, lu.g);
  col = mix(col, cPark, park);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.9), float(0.97), park);

  // Night: sodium street lights along the grid & the arterials (none in parks), faint lit windows
  const street = float(1.0).sub(inBlock).add(arterial.mul(0.6)).mul(float(1.0).sub(park)).mul(float(1.0).sub(lu.g.mul(0.5)));
  const windowGlow = inLots.mul(step(0.9, lotHash).mul(lotDetail).add(float(1.0).sub(lotDetail).mul(0.1))).mul(float(1.0).sub(park));
  mat.emissiveNode = vec3(1.0, 0.62, 0.3).mul(street.mul(0.55).add(windowGlow.mul(0.18))).mul(nightFactorNode());
  return mat;
}

// The islands: lawns & groves (the Toronto Islands are a park)
function createIslandMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  const wp = positionWorld;
  const n = valueNoise(wp.xz.mul(0.02)).add(valueNoise(wp.xz.mul(0.09)).mul(0.4));
  mat.colorNode = mix(srgb(0.38, 0.47, 0.22), srgb(0.20, 0.28, 0.14), smoothstep(0.55, 0.95, n));
  return mat;
}

function createDockWallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.0 });
  const wp = positionWorld;
  const courseV = wp.y.div(0.85).toVar();
  const course = boxPulse(courseV, 0.0, 0.92, fwidth(courseV));
  const n = valueNoise(vec2(wp.x.add(wp.z).mul(0.09), wp.y.mul(0.6)));
  const stone = mix(srgb(0.42, 0.41, 0.39), srgb(0.55, 0.53, 0.50), n).mul(mix(float(0.8), float(1.0), course));
  const wet = float(1.0).sub(smoothstep(-1.85, -0.9, wp.y));
  mat.colorNode = mix(stone, srgb(0.2, 0.22, 0.18), wet.mul(0.85));
  mat.roughnessNode = mix(float(0.9), float(0.45), wet);
  return mat;
}

// Instanced building facades: punched windows on brick / precast, curtain-wall glass or ribbon windows by style, a
// per-building tint, darker storefront bases & flat roofs, lit windows at night.
// Instance attributes: bInfo = (width, height, depth, seed), bTint = (r, g, b, style)
function createBuildingMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
  const info = attribute('bInfo', 'vec4');
  const tint = attribute('bTint', 'vec4');
  const pG = positionGeometry;
  const nG = normalGeometry;
  const style = tint.w;
  const isRoof = step(0.5, nG.y).toVar();
  const faceX = step(0.5, abs(nG.x));
  const wallW = mix(info.x, info.z, faceX);
  const u = mix(pG.x, pG.z, faceX).add(0.5).mul(wallW).add(info.w.mul(3.7)).toVar();
  const y = pG.y.mul(info.y).toVar();
  const s0 = style.lessThan(0.5);
  const s1 = style.lessThan(1.5);
  const s2 = style.lessThan(2.5);
  const s3 = style.lessThan(3.5);
  const pick = (a, b, c, d, e) => select(s0, float(a), select(s1, float(b), select(s2, float(c), select(s3, float(d), float(e)))));
  const bay = pick(3.0, 1.6, 4.8, 2.2, 2.6);
  const floorH = pick(3.1, 3.3, 4.6, 3.0, 3.4);
  const winW = pick(0.44, 0.88, 0.62, 0.96, 0.46);
  const winH = pick(0.54, 0.78, 0.46, 0.5, 0.56);
  const litProb = pick(0.32, 0.4, 0.14, 0.34, 0.3);
  const glassy = pick(0.15, 1.0, 0.1, 0.35, 0.15);
  const gu = u.div(bay).toVar();
  const gv = y.div(floorH).toVar();
  const fwU = fwidth(gu).toVar();
  const fwV = fwidth(gv).toVar();
  const winMask = boxPulse(gu, float(0.5).sub(winW.mul(0.5)), float(0.5).add(winW.mul(0.5)), fwU)
    .mul(boxPulse(gv, float(0.42).sub(winH.mul(0.5)), float(0.42).add(winH.mul(0.5)), fwV))
    .mul(float(1.0).sub(isRoof))
    .mul(step(1.0, gv))
    .mul(float(1.0).sub(step(info.y.sub(1.2), y)))
    .toVar();
  const cellHash = hash12(floor(vec2(gu, gv)).add(vec2(info.w.mul(0.61), info.w.mul(1.37))));
  const far = smoothstep(0.35, 1.2, max(fwU, fwV)).toVar();
  const lit = mix(step(cellHash, litProb), litProb, far).toVar();
  const bHash = fract(info.w.mul(0.1373));
  const grime = valueNoise(vec2(u.mul(0.45), y.mul(0.05).add(info.w))).toVar();
  const wallBase = tint.rgb.mul(float(0.84).add(bHash.mul(0.3))).mul(mix(float(0.78), float(1.0), smoothstep(0.0, 9.0, y)));
  const wallCol = wallBase.mul(mix(float(0.86), float(1.07), grime));
  const storefront = float(1.0).sub(step(4.2, y)).mul(float(1.0).sub(isRoof)).mul(step(9.0, info.y));
  const cGlass = mix(vec3(0.012, 0.014, 0.017), vec3(0.05, 0.065, 0.08), glassy);
  const roofCol = mix(srgb(0.30, 0.30, 0.31), srgb(0.66, 0.66, 0.65), step(0.72, bHash));
  let col = mix(wallCol, cGlass, winMask);
  col = mix(col, vec3(0.09, 0.085, 0.08), storefront.mul(0.65));
  col = mix(col, roofCol, isRoof);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.86), mix(float(0.14), float(0.06), glassy), winMask);
  mat.metalnessNode = winMask.mul(glassy).mul(0.6);
  const night = nightFactorNode();
  const warm = mix(vec3(1.0, 0.66, 0.36), vec3(0.92, 0.86, 0.76), step(0.78, cellHash));
  const dimmer = mix(fract(cellHash.mul(13.7)).mul(0.75).add(0.25), float(0.62), far);
  const shop = storefront.mul(step(0.35, hash12(vec2(floor(gu), info.w)))).mul(0.8);
  mat.emissiveNode = warm.mul(winMask.mul(lit).mul(dimmer).add(shop)).mul(night.mul(0.95).add(cityUniforms.uInteriorGlow.mul(0.1)));
  return mat;
}

// =====================================================================================================================
// 4. LAND MASSES & DOCK WALLS
// =====================================================================================================================
const LAND_BOTTOM_Y = -3.4;
function buildLandGeometries() {
  const topPos = [];
  const topIdx = [];
  const islandPos = [];
  const islandIdx = [];
  const wallPos = [];
  const wallNrm = [];
  for (const land of LAND) {
    const pts = land.pts;
    const pos = land.island ? islandPos : topPos;
    const idx = land.island ? islandIdx : topIdx;
    const base = pos.length / 3;
    for (const p of pts) pos.push(p.x, land.top, p.z);
    const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.x, p.z)), []);
    for (const t of tris) {
      const a = pts[t[0]], b = pts[t[1]], c = pts[t[2]];
      const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0;
      if (up) idx.push(base + t[0], base + t[1], base + t[2]);
      else idx.push(base + t[0], base + t[2], base + t[1]);
    }
    // dock walls & shore faces along the real water's edge only (not along the straight closures out to the horizon,
    // nor where the land meets downtown or another land piece)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3 || len > 2500) continue;
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      if (Math.hypot(mx, mz) > 30000) continue;
      let nx = dz / len, nz = -dx / len;
      if (insideIndexed(land.index, mx + nx * 0.5, mz + nz * 0.5)) { nx = -nx; nz = -nz; }
      const ox = mx + nx * 1.5, oz = mz + nz * 1.5;
      const other = landAt(ox, oz);
      if ((other && other !== land) || insideIndexed(CITY_INDEX, ox, oz)) continue;
      const at = [a.x, land.top, a.z], ab = [a.x, LAND_BOTTOM_Y, a.z], bt = [b.x, land.top, b.z], bb = [b.x, LAND_BOTTOM_Y, b.z];
      const quad = -dz * nx + dx * nz > 0 ? [at, ab, bb, at, bb, bt] : [at, bb, ab, at, bt, bb];
      for (const v of quad) {
        wallPos.push(v[0], v[1], v[2]);
        wallNrm.push(nx, 0, nz);
      }
    }
  }
  const flatGeo = (pos, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const n = new Float32Array(pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setIndex(idx);
    return g;
  };
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  wallGeo.setAttribute('normal', new THREE.Float32BufferAttribute(wallNrm, 3));
  return { topGeo: flatGeo(topPos, topIdx), islandGeo: flatGeo(islandPos, islandIdx), wallGeo };
}

// =====================================================================================================================
// 5. BUILDINGS: house rows on the residential blocks, mid-rise along the arterials, the high-rise clusters
// =====================================================================================================================
const BOX_GEO = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  const src = g.index.array;
  const keep = [];
  for (let i = 0; i < src.length; i++) if (i < 18 || i >= 24) keep.push(src[i]);
  g.setIndex(keep);
  g.clearGroups();
  return g;
})();
const PALETTE = {
  brick: [[0.56, 0.31, 0.23], [0.50, 0.28, 0.21], [0.62, 0.39, 0.29], [0.45, 0.27, 0.21], [0.60, 0.35, 0.26], [0.68, 0.52, 0.40], [0.74, 0.64, 0.52]],
  light: [[0.76, 0.71, 0.62], [0.70, 0.66, 0.58], [0.82, 0.80, 0.76], [0.73, 0.63, 0.51], [0.78, 0.74, 0.67]],
  glass: [[0.32, 0.39, 0.44], [0.38, 0.44, 0.48], [0.42, 0.46, 0.50], [0.30, 0.40, 0.42], [0.22, 0.25, 0.29], [0.47, 0.50, 0.52]],
  industrial: [[0.58, 0.55, 0.50], [0.62, 0.42, 0.34], [0.72, 0.72, 0.70], [0.50, 0.48, 0.45], [0.66, 0.63, 0.57]],
  modern: [[0.86, 0.85, 0.83], [0.68, 0.68, 0.67], [0.77, 0.73, 0.67], [0.57, 0.59, 0.61]]
};
const PALETTE_STYLE = { brick: 0, light: 4, glass: 1, industrial: 2, modern: 3 };
const pickFrom = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

// High-rise clusters: [lon, lat, radius (m), tower heights h0..h1, share of blocks with towers]
const CLUSTERS = [
  [-79.4195, 43.6385, 520, 40, 130, 0.7], // Liberty Village & King West
  [-79.4045, 43.6385, 360, 60, 160, 0.7], // Fort York & Bathurst Quay
  [-79.4760, 43.6240, 650, 80, 220, 0.75], // Humber Bay Shores
  [-79.3935, 43.6875, 420, 50, 130, 0.5], // Yonge & St. Clair
  [-79.3985, 43.7065, 650, 60, 200, 0.6], // Yonge & Eglinton
  [-79.3970, 43.6980, 300, 40, 100, 0.4], // Davisville
  [-79.4130, 43.7680, 750, 60, 210, 0.6], // North York Centre
  [-79.4110, 43.7610, 380, 60, 180, 0.6], // Sheppard-Yonge
  [-79.3460, 43.7050, 520, 50, 90, 0.6], // Thorncliffe Park
  [-79.3330, 43.7180, 420, 40, 90, 0.5], // Flemingdon Park
  [-79.4680, 43.6560, 520, 40, 95, 0.5], // High Park North
  [-79.3650, 43.6720, 260, 40, 100, 0.5], // Bloor & Castle Frank / St. Jamestown east
  [-79.6400, 43.5930, 900, 80, 200, 0.6], // Mississauga City Centre
  [-79.2570, 43.7760, 650, 60, 170, 0.55], // Scarborough Centre
  [-79.5250, 43.6460, 450, 50, 140, 0.5], // Islington-City Centre West
  [-79.4520, 43.7210, 420, 40, 110, 0.4], // Yorkdale & Lawrence West
  [-79.3480, 43.6600, 380, 25, 60, 0.4], // the Canary District & Riverside
  [-79.3090, 43.7120, 500, 40, 110, 0.4] // Victoria Park & O'Connor
].map(([lon, lat, r, h0, h1, p]) => ({ ...LL(lon, lat), r, h0, h1, p }));
const clusterAt = (x, z) => {
  let best = null;
  for (const c of CLUSTERS) {
    const d = Math.hypot(x - c.x, z - c.z) / c.r;
    if (d < 1 && (!best || d < best.d)) best = { c, d };
  }
  return best;
};
// Keep clear: the landmarks' sites, the airport island, Exhibition Place's stadium
const EXCLUSIONS = [];
const exclude = (x, z, r) => EXCLUSIONS.push({ x, z, r });
const excluded = (x, z, r = 0) => EXCLUSIONS.some((e) => Math.hypot(x - e.x, z - e.z) < e.r + r);
const MAX_BUILD_DIST = 10000;

function generateBuildings() {
  const rand = mulberry32(416);
  const list = [];
  const stats = { houses: 0, midrise: 0, towers: 0, industry: 0 };
  const add = (x, z, w, d, h, palette, rot = 0) => {
    list.push({ x, y: 0, z, w, d, h, rot, seed: Math.floor(rand() * 10000) + 0.5, tint: pickFrom(PALETTE[palette], rand), style: PALETTE_STYLE[palette] });
  };
  const onLand = (x, z) => {
    const l = landAt(x, z);
    return l && l.mainland ? l : null;
  };
  // every residential block of the grid within reach of downtown
  const R = MAX_BUILD_DIST;
  for (let bx = Math.floor(-R / BLOCK_U); bx <= Math.ceil(R / BLOCK_U); bx++) {
    for (let bz = Math.floor(-R / BLOCK_V); bz <= Math.ceil(R / BLOCK_V); bz++) {
      const x0 = bx * BLOCK_U + 7.2;
      const x1 = (bx + 1) * BLOCK_U - 7.2;
      const z0 = bz * BLOCK_V + 7.2;
      const z1 = (bz + 1) * BLOCK_V - 7.2;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const dist = Math.hypot(cx, cz);
      if (dist > R) continue;
      if (!onLand(cx, cz) || !onLand(x0, z0) || !onLand(x1, z1) || !onLand(x0, z1) || !onLand(x1, z0)) continue;
      if (landDistance(cx, cz) > -60) continue; // the detailed downtown (and a margin around it)
      if (excluded(cx, cz, 60)) continue;
      // on an arterial? (the concession grid: the blocks touching it stay back from its wider roadway)
      const nearArt = (v, step) => {
        const f = ((v % step) + step) % step;
        return Math.min(f, step - f);
      };
      if (nearArt(cx, ARTERIAL) < BLOCK_U / 2 + 5 && nearArt(cz, ARTERIAL) < 20) continue;
      const lu = luAt(cx, cz);
      if (lu.park > 0.4) continue;
      const cl = clusterAt(cx, cz);
      // keep a share of the far blocks only (the ground shader carries the grid on)
      const keep = dist < 4000 ? 1 : dist < 7000 ? 0.75 : 0.45;
      if (!cl && rand() > keep) continue;
      if (lu.industry > 0.4) {
        // warehouses & sheds
        const n = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < n; k++) {
          const w = 25 + rand() * 45;
          const d = 30 + rand() * 80;
          add(cx + (rand() - 0.5) * (x1 - x0 - w) * 0.8, cz + (rand() - 0.5) * (z1 - z0 - d) * 0.8, Math.min(w, x1 - x0), Math.min(d, z1 - z0), 7 + rand() * 9, 'industrial');
          stats.industry++;
        }
        continue;
      }
      if (cl && rand() < cl.c.p * (1 - cl.d * 0.6)) {
        // towers on podiums
        const nT = 1 + Math.floor(rand() * 2);
        add(cx, cz, x1 - x0, Math.min(z1 - z0, 70), 10 + rand() * 6, 'light');
        for (let k = 0; k < nT; k++) {
          const tz = cz + (nT === 1 ? 0 : (k - 0.5) * 70);
          const h = cl.c.h0 + (cl.c.h1 - cl.c.h0) * Math.pow(rand(), 1.6) * (1 - cl.d * 0.5);
          add(cx + (rand() - 0.5) * 20, tz, 24 + rand() * 14, 24 + rand() * 12, h, rand() < 0.65 ? 'glass' : 'modern');
          stats.towers++;
        }
        continue;
      }
      // house rows along both north-south streets, a mid-rise or two where an arterial passes
      const leafy = lu.leafy;
      const houseH = 8 + rand() * 3 + leafy * 2;
      const depth = 12 + leafy * 4;
      const gap = leafy > 0.4 ? 4 : 0;
      for (const side of [-1, 1]) {
        const xs = side < 0 ? x0 + 4 + depth / 2 : x1 - 4 - depth / 2;
        if (gap) {
          for (let z = z0 + 6; z < z1 - 14; z += 16 + rand() * 6) add(xs, z + 7, depth, 12 + rand() * 4, houseH + rand() * 2, rand() < 0.6 ? 'brick' : 'light');
        } else {
          add(xs, cz, depth, z1 - z0 - 10, houseH, rand() < 0.7 ? 'brick' : 'light');
        }
        stats.houses++;
      }
      if (nearArt(cz, ARTERIAL) < BLOCK_V * 0.6 || nearArt(cx, ARTERIAL) < BLOCK_U * 1.5) {
        if (rand() < 0.35) {
          add(cx, rand() < 0.5 ? z0 + 18 : z1 - 18, x1 - x0 - 10, 26, 14 + rand() * 18, rand() < 0.6 ? 'brick' : 'modern');
          stats.midrise++;
        }
      }
    }
  }
  return { list, stats };
}

function buildBuildingChunks(list, material, chunkSize, name) {
  const chunks = new Map();
  for (const b of list) {
    const key = Math.floor(b.x / chunkSize) + ',' + Math.floor(b.z / chunkSize);
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, (arr = []));
    arr.push(b);
  }
  const meshes = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const [key, arr] of chunks) {
    const geo = new THREE.BufferGeometry();
    geo.setIndex(BOX_GEO.index);
    geo.setAttribute('position', BOX_GEO.attributes.position);
    geo.setAttribute('normal', BOX_GEO.attributes.normal);
    const info = new Float32Array(arr.length * 4);
    const tint = new Float32Array(arr.length * 4);
    const mesh = new THREE.InstancedMesh(geo, material, arr.length);
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      q.setFromAxisAngle(yAxis, b.rot);
      m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d));
      mesh.setMatrixAt(i, m);
      info[i * 4] = b.w;
      info[i * 4 + 1] = b.h;
      info[i * 4 + 2] = b.d;
      info[i * 4 + 3] = b.seed;
      tint[i * 4] = toLinear(b.tint[0]);
      tint[i * 4 + 1] = toLinear(b.tint[1]);
      tint[i * 4 + 2] = toLinear(b.tint[2]);
      tint[i * 4 + 3] = b.style;
    }
    geo.setAttribute('bInfo', new THREE.InstancedBufferAttribute(info, 4));
    geo.setAttribute('bTint', new THREE.InstancedBufferAttribute(tint, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = name + ':' + key;
    meshes.push(mesh);
  }
  return meshes;
}

// =====================================================================================================================
// 6. LANDMARKS AROUND DOWNTOWN & THE ISLANDS
// =====================================================================================================================
function createPartCollector() {
  const buckets = new Map();
  const add = (material, geometry) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
    let arr = buckets.get(material);
    if (!arr) buckets.set(material, (arr = []));
    arr.push(g);
  };
  return {
    add,
    box(material, x, y, z, w, h, d, ry = 0) {
      add(material, new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0).rotateY(ry).translate(x, y, z));
    },
    build(parent, { castShadow = false, receiveShadow = true } = {}) {
      for (const [material, geos] of buckets) {
        const mesh = new THREE.Mesh(geos.length === 1 ? geos[0] : mergeGeometries(geos, false), material);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        parent.add(mesh);
      }
    }
  };
}

function buildLandmarks(group, parts) {
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0xa8a39a, roughness: 0.85 });
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xe9e8e4, roughness: 0.5, metalness: 0.15 });
  const brick = new THREE.MeshStandardNodeMaterial({ color: 0x7c4a3a, roughness: 0.85 });
  const stone = new THREE.MeshStandardNodeMaterial({ color: 0xb6a68a, roughness: 0.85 });
  const copper = new THREE.MeshStandardNodeMaterial({ color: 0x4f8a72, roughness: 0.55, metalness: 0.2 });
  const asphalt = new THREE.MeshStandardNodeMaterial({ color: 0x3b3c3e, roughness: 0.9 });
  const paint = new THREE.MeshStandardNodeMaterial({ color: 0xe8e4d8, roughness: 0.7 });
  const field = new THREE.MeshStandardNodeMaterial({ color: 0x3f6b2a, roughness: 0.95 });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x2a3a46, roughness: 0.15, metalness: 0.7 });
  const beacon = new THREE.MeshBasicNodeMaterial({ color: 0xff3020 });

  // The R. L. Hearn Generating Station: the long brick hall & its 215 m stack, the tallest thing in the Port Lands
  {
    const h = LL(-79.3381, 43.6431);
    parts.box(brick, h.x, 0, h.z, 220, 45, 90, 0.08);
    parts.add(concrete, new THREE.CylinderGeometry(6, 10, 215, 16).translate(h.x + 60, 107.5, h.z));
    exclude(h.x, h.z, 160);
  }
  // Ontario Place: the Cinesphere's geodesic dome & the pods on their stilts
  {
    const c = POINTS.cinesphere;
    parts.add(white, new THREE.SphereGeometry(17, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2 + 0.25).translate(c.x, 6, c.z));
    parts.add(concrete, new THREE.CylinderGeometry(9, 11, 6, 16).translate(c.x, 3, c.z));
    const op = POINTS.ontarioPlace;
    for (let k = 0; k < 5; k++) {
      const px = op.x + 60 + k * 26;
      const pz = op.z + 40 + (k % 2) * 18;
      parts.box(white, px, 12, pz, 18, 8, 18);
      parts.add(concrete, new THREE.CylinderGeometry(1.2, 1.2, 12, 8).translate(px, 6, pz));
    }
  }
  // BMO Field (the Exhibition's stadium) & the Enercare Centre
  {
    const b = POINTS.bmoField;
    parts.add(field, new THREE.PlaneGeometry(105, 68).rotateX(-Math.PI / 2).translate(b.x, 0.4, b.z));
    for (const [dx, dz, w, d] of [[0, -50, 130, 26], [0, 50, 130, 26], [-70, 0, 20, 90], [70, 0, 20, 90]]) parts.box(concrete, b.x + dx, 0, b.z + dz, w, 22, d);
    parts.box(white, b.x, 24, b.z - 50, 130, 2, 32);
    parts.box(white, b.x, 24, b.z + 50, 130, 2, 32);
    const e = LL(-79.4180, 43.6365);
    parts.box(stone, e.x, 0, e.z, 260, 22, 120, 0);
    exclude(b.x, b.z, 120);
    exclude(e.x, e.z, 160);
  }
  // Billy Bishop Toronto City Airport: runways & taxiways (OpenStreetMap), the terminal & the hangars
  {
    for (const r of RUNWAYS) {
      if (r.closed) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 1) continue;
        const y = r.kind === 'runway' ? 0.42 : 0.4;
        parts.add(asphalt, new THREE.BoxGeometry(r.w, 0.06, L).rotateY(Math.atan2(b.x - a.x, b.z - a.z)).translate((a.x + b.x) / 2, y, (a.z + b.z) / 2));
        if (r.kind === 'runway') {
          // centre-line dashes
          for (let s = 15; s < L - 15; s += 50) {
            const t = s / L;
            parts.add(paint, new THREE.BoxGeometry(0.9, 0.02, 30).rotateY(Math.atan2(b.x - a.x, b.z - a.z)).translate(a.x + (b.x - a.x) * t, y + 0.04, a.z + (b.z - a.z) * t));
          }
        }
      }
    }
    const t = POINTS.billyBishop;
    parts.box(glass, t.x + 80, 0.35, t.z - 60, 70, 12, 30);
    parts.box(concrete, t.x + 160, 0.35, t.z - 40, 40, 14, 40);
    parts.box(concrete, t.x - 120, 0.35, t.z - 70, 50, 12, 36);
    parts.add(concrete, new THREE.CylinderGeometry(2.5, 3, 28, 10).translate(t.x + 40, 14.35, t.z - 90));
    parts.add(glass, new THREE.CylinderGeometry(5, 4, 4, 10).translate(t.x + 40, 30.35, t.z - 90));
  }
  // Gibraltar Point Lighthouse (1808), the oldest on the Great Lakes
  {
    const g = POINTS.gibraltarPoint;
    parts.add(stone, new THREE.CylinderGeometry(2.6, 3.8, 24, 8).translate(g.x, 12.35, g.z));
    parts.add(glass, new THREE.CylinderGeometry(2.2, 2.2, 3, 8).translate(g.x, 25.85, g.z));
    parts.add(beacon, new THREE.SphereGeometry(0.9, 8, 6).translate(g.x, 26, g.z));
    parts.add(copper, new THREE.ConeGeometry(2.6, 2.5, 8).translate(g.x, 28.6, g.z));
  }
  // Casa Loma on the old Lake Iroquois shoreline: the Gothic Revival mansion & its towers
  {
    const c = POINTS.casaLoma;
    parts.box(stone, c.x, 0, c.z, 70, 22, 34);
    for (const [dx, dz, h] of [[-32, 12, 34], [30, -12, 30], [-10, -15, 40]]) {
      parts.box(stone, c.x + dx, 0, c.z + dz, 9, h, 9);
      parts.add(copper, new THREE.ConeGeometry(6.5, 9, 4).rotateY(Math.PI / 4).translate(c.x + dx, h + 4.5, c.z + dz));
    }
    exclude(c.x, c.z, 80);
  }
  // The Prince Edward (Bloor) Viaduct over the Don Valley: the deck on its concrete arches
  {
    const a = LL(-79.3672, 43.6726);
    const b = LL(-79.3570, 43.6774);
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const ry = Math.atan2(b.x - a.x, b.z - a.z);
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    parts.add(concrete, new THREE.BoxGeometry(26, 3, L).rotateY(ry).translate(cx, 30, cz));
    for (let k = 1; k < 8; k++) {
      const t = k / 8;
      parts.add(concrete, new THREE.BoxGeometry(18, 30, 6).rotateY(ry).translate(a.x + (b.x - a.x) * t, 15, a.z + (b.z - a.z) * t));
    }
    exclude(cx, cz, L / 2 + 30);
  }
}

// Trees on the Toronto Islands (willows & cottonwoods in groves) and the Leslie Spit: instanced low-poly crowns
function buildIslandTrees(group) {
  const rand = mulberry32(1793);
  const sites = [];
  for (const land of LAND) {
    if (!land.island) continue;
    const b = land.index.b;
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    const n = Math.min(4000, Math.floor(area / 900));
    for (let i = 0; i < n; i++) {
      const x = b.minX + rand() * (b.maxX - b.minX);
      const z = b.minZ + rand() * (b.maxZ - b.minZ);
      if (!insideIndexed(land.index, x, z) || excluded(x, z, 5)) continue;
      if (Math.sin(x * 0.012 + 1.3) * Math.sin(z * 0.015) > 0.45) continue; // lawns & clearings
      if (RUNWAYS.some((r) => r.pts.some((p) => Math.abs(p.x - x) < 300 && Math.abs(p.z - z) < 300))) continue; // the airport
      sites.push({ x, z, s: 0.7 + rand() * 0.7, y: land.top });
    }
  }
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 6).translate(0, 0.5, 0);
  const crownMat = new THREE.MeshStandardNodeMaterial({ color: 0x3d5a26, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardNodeMaterial({ color: 0x4a3a2c, roughness: 0.9 });
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, Math.max(1, sites.length));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, sites.length));
  crowns.count = trunks.count = sites.length;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  sites.forEach((t, i) => {
    m.compose(new THREE.Vector3(t.x, t.y + 7 * t.s, t.z), q, new THREE.Vector3(5 * t.s, 4.5 * t.s, 5 * t.s));
    crowns.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(1, 4 * t.s, 1));
    trunks.setMatrixAt(i, m);
  });
  crowns.castShadow = true;
  crowns.receiveShadow = true;
  for (const mesh of [crowns, trunks]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return sites.length;
}

// =====================================================================================================================
// 7. ASSEMBLY
// =====================================================================================================================
function buildSurroundings(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'Surroundings';
  landUse = paintLandUse();

  const { topGeo, islandGeo, wallGeo } = buildLandGeometries();
  const land = new THREE.Mesh(topGeo, createLandMaterial());
  land.name = 'MainlandGround';
  land.receiveShadow = true;
  const islands = new THREE.Mesh(islandGeo, createIslandMaterial());
  islands.name = 'IslandGround';
  islands.receiveShadow = true;
  const walls = new THREE.Mesh(wallGeo, createDockWallMaterial());
  walls.name = 'DockWalls';
  group.add(land, islands, walls);

  const parts = createPartCollector();
  buildLandmarks(group, parts);
  parts.build(group, { castShadow: true });
  const { list, stats } = generateBuildings();
  const mat = createBuildingMaterial();
  for (const mesh of buildBuildingChunks(list, mat, 1200, 'SurroundingBuildings')) group.add(mesh);
  const trees = buildIslandTrees(group);

  scene.add(group);
  console.info(`[surroundings] ${list.length} buildings ${JSON.stringify(stats)}, ${trees} island trees, built in ${(performance.now() - t0).toFixed(0)} ms`);
  return { group, landAt, colliders: [] };
}

export { buildSurroundings, landAt as surroundingsLandAt };
