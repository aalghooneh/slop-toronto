import { LANDMARKS, CITY_BOUNDS, getLocationLabel, blockAt, realHeightAt, pushOntoLand, nearestRoads } from './city-config.js';
import { locateOnPath } from './route-finder.js';

// js/gigs.js
// Toronto Hustle: the game played on top of the city. Every way of getting about has its own work:
// - the car is a cab: pick fares up at the kerb and get them where they're going before their patience runs out,
// - the bicycle is a food courier: collect an order and deliver it while it's hot,
// - the helicopter flies sightseeing tours through rings hung around the skyline,
// - and on foot there are 40 raccoons raiding green bins all over downtown to find.
// Driving with style (drifts, near misses, flat-out runs) pays on the side. Cash earns ranks and is kept, with the
// raccoons found, in localStorage.
//
// This module is the rules only: no DOM and no three.js (gig-world.js draws it, gig-hud.js shows it, main.js wires
// them through the events emitted here), so it runs under Node for the tests.

const STORAGE_KEY = 'toronto-hustle';

const RANKS = [
  { cash: 0, name: 'New in Town' },
  { cash: 150, name: 'Side Hustler' },
  { cash: 500, name: 'Streetcar Dodger' },
  { cash: 1200, name: 'Rush Hour Regular' },
  { cash: 2500, name: 'Gardiner Veteran' },
  { cash: 5000, name: 'Downtown Legend' },
  { cash: 10000, name: 'Monarch of the 6ix' }
];

function rankFor(lifetime) {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (lifetime >= RANKS[i].cash) index = i;
  const next = RANKS[index + 1] || null;
  return {
    index,
    name: RANKS[index].name,
    next: next ? next.name : null,
    progress: next ? (lifetime - RANKS[index].cash) / (next.cash - RANKS[index].cash) : 1,
    toNext: next ? next.cash - lifetime : 0
  };
}

const NAMES = ['Priya', 'Marcus', 'Wei', 'Aaliyah', 'Dmitri', 'Chidi', 'Sofia', 'Jamal', 'Mei', 'Liam', 'Fatima', 'Nico', 'Amara', 'Tariq',
  'Yuki', 'Rosa', 'Kwame', 'Anika', 'Mateo', 'Zainab', 'Hye-jin', 'Owen', 'Thandi', 'Ravi', 'Chloé', 'Darnell', 'Ingrid', 'Paulo'];

// What kind of ride each fare wants: how long they'll wait, how they tip, how they take a bump and a drift
const PERSONAS = {
  rush: { tag: 'In a hurry', time: 0.82, tip: 1.7, bump: 1, style: 1 },
  chill: { tag: 'Easygoing', time: 1.3, tip: 0.8, bump: 0.6, style: 1 },
  thrill: { tag: 'Thrill-seeker', time: 1, tip: 1, bump: 0.5, style: 3 },
  nervous: { tag: 'Nervous passenger', time: 1.15, tip: 1.5, bump: 2, style: 0 }
};
const PERSONA_IDS = Object.keys(PERSONAS);

const FARE_LINES = {
  cntower: ['CN Tower, please. My cousin\'s in town and won\'t stop asking.', 'To the tower. I\'m doing the EdgeWalk. Don\'t ask.'],
  rogers: ['Rogers Centre! First pitch is in ten minutes!', 'The dome, and step on it, the roof\'s open today.'],
  union: ['Union Station. My GO train leaves without me.', 'Union, quick as you can. The UP Express waits for nobody.'],
  royalyork: ['The Royal York. I\'m late for a wedding. Mine.'],
  cityhall: ['City Hall. I have a strongly worded deputation to make.', 'Nathan Phillips Square, skates are in the bag.'],
  oldcityhall: ['Old City Hall. Jury duty. Take your time, honestly.'],
  eaton: ['Eaton Centre. It\'s an emergency. A shopping emergency.'],
  arena: ['Scotiabank Arena. Puck drops in five. This is our year.', 'To the arena! Tip-off\'s soon, let\'s go!'],
  market: ['St. Lawrence Market. Peameal bacon sandwich, before the line gets silly.'],
  legislature: ['Queen\'s Park. I\'ve got a protest sign and a schedule.'],
  fcp: ['First Canadian Place. The markets close at four and so does my patience.'],
  scotia: ['Scotia Plaza. I have a meeting I\'m meant to be chairing.'],
  rbc: ['Royal Bank Plaza, the gold one. You can\'t miss it.'],
  brookfield: ['Brookfield Place. Lunch under the big glass arches.'],
  flatiron: ['The Gooderham Building. Yes, the flatiron. Yes, for a photo.'],
  rom: ['The ROM. The dinosaurs close at five thirty.'],
  ago: ['The AGO, please. Free Wednesday night, it\'ll be packed.'],
  roythomson: ['Roy Thomson Hall. The symphony doesn\'t do late seating.'],
  ripleys: ['The aquarium. I promised the kids sharks.'],
  massey: ['Massey Hall. Doors were at seven.'],
  dundassq: ['Yonge and Dundas. Meeting someone under the big screens.'],
  distillery: ['Distillery District. The patio is calling.'],
  kensington: ['Kensington Market. Vintage shopping, then empanadas.'],
  ferry: ['The ferry docks! The island boat leaves on the hour!'],
  harbourfront: ['Harbourfront. I want to look at the lake and think.']
};
const GENERIC_LINES = ['{place}, please. And mind the streetcar tracks.', 'Can you get me to {place}? The 501 is short-turning again.',
  'I need to be at {place}. The subway\'s closed this weekend, obviously.', '{place}. I\'d walk, but, you know. Construction.',
  'Take me to {place}. Avoid King if you can.', '{place}, thanks. Nice car, by the way.'];

const KITCHENS = ['Six Slice Pizza', 'Kensington Dumpling House', 'Peameal Pete\'s', 'Danforth Souvlaki Stop', 'Bao Down', 'Roti Rocket',
  'Double Double Donuts', 'Queen West Ramen', 'Jerk Junction', 'Poutine Machine', 'Spadina Pho Bar', 'The Butter Tart Bar'];
const ORDERS = ['two large pizzas', 'a dozen dumplings', 'a peameal bacon sandwich', 'a chicken souvlaki dinner', 'six pork bao',
  'a boneless goat roti', 'a box of honey crullers', 'a bowl of tonkotsu ramen', 'jerk chicken with rice and peas', 'a large poutine',
  'a rare beef pho', 'half a dozen butter tarts'];

const RACCOON_COUNT = 40;
const RACCOON_REWARD = 25;
const RACCOON_ALL_BONUS = 1000;

// Per travel mode: how the work is found and judged
const MODES = {
  car: { kind: 'fare', offers: 3, near: [90, 380], trip: [420, 1500], zone: 6.5, stopSpeed: 2.2, pace: 10.5, slack: 22, base: 6, rate: 0.03 },
  cyclist: { kind: 'delivery', offers: 3, near: [60, 260], trip: [260, 820], zone: 4.5, stopSpeed: 3, pace: 6.2, slack: 22, base: 4, rate: 0.034 },
  helicopter: { kind: 'tour', offers: 1, rings: 5, ringRadius: 15, pace: 26, slack: 9 }
};

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
const money = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0);

class GigSystem {
  /**
   * @param {object} o
   * @param {object} o.routeFinder - route-finder.js over the road graph
   * @param {object} o.controllers - the ThirdPersonControllerManager (entities, activeMode, nearColliders)
   * @param {object} [o.traffic] - the traffic system (its cars, for near misses)
   * @param {Storage} [o.storage] - where progress is kept (localStorage)
   * @param {() => number} [o.random]
   * @param {(type: string, data: object) => void} [o.onEvent]
   * @param {(x: number, z: number, r: number) => number} [o.roofAt] - the highest roof within r m of a point
   */
  constructor({ routeFinder, controllers, traffic = null, storage = null, random = Math.random, onEvent = () => {}, roofAt = null }) {
    this.routeFinder = routeFinder;
    this.controllers = controllers;
    this.traffic = traffic;
    this.storage = storage;
    this.random = random;
    this.onEvent = onEvent;
    // The highest roof within r of (x, z): everything built there where given, else the real towers only
    this.roofAt = roofAt || ((x, z) => realHeightAt(x, z) || 0);

    this.enabled = true;
    this.cash = 0;
    this.lifetime = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.completed = { fare: 0, delivery: 0, tour: 0 };
    this.bestPayout = 0;
    this.found = new Set(); // raccoon ids
    this.load();

    this.mode = null;
    this.offers = [];
    this.job = null;
    this.cooldown = 1.5; // seconds until the next offers appear
    this.offerSeq = 0;
    this.clock = 0;

    // Where the player is being sent: { x, y, z, radius, kind } and the way there by road
    this.target = null;
    this.route = null;
    this.routeIndex = 0;
    this.routeAlong = 0;
    this.routeTimer = 0;
    this.routeFor = null;
    this.routeKind = null;

    this.style = { combo: 0, comboTimer: 0, drift: 0, driftGap: 0, fast: 0, pending: [], seen: new WeakMap(), lastHit: -10 };
    this.raccoons = [];
    this.raccoonNear = Infinity;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------------------------------------------
  load() {
    try {
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY));
      if (saved?.version !== 1) return;
      this.cash = money(saved.cash);
      this.lifetime = Math.max(this.cash, money(saved.lifetime));
      this.bestStreak = money(saved.bestStreak);
      this.bestPayout = money(saved.bestPayout);
      for (const kind of Object.keys(this.completed)) this.completed[kind] = money(saved.completed?.[kind]);
      if (Array.isArray(saved.found)) for (const id of saved.found) if (Number.isInteger(id) && id >= 0 && id < RACCOON_COUNT) this.found.add(id);
      if (saved.enabled === false) this.enabled = false;
    } catch { /* A first visit, or storage is unavailable. */ }
  }

  save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({
        version: 1, cash: this.cash, lifetime: this.lifetime, bestStreak: this.bestStreak, bestPayout: this.bestPayout,
        completed: this.completed, found: [...this.found], enabled: this.enabled
      }));
    } catch { /* Storage may be disabled or full. */ }
  }

  get rank() {
    return rankFor(this.lifetime);
  }

  earn(amount, why) {
    amount = money(amount);
    if (!amount) return;
    const before = this.rank.index;
    this.cash += amount;
    this.lifetime += amount;
    this.onEvent('cash', { amount, why, cash: this.cash });
    const rank = this.rank;
    if (rank.index > before) this.onEvent('rank', { name: rank.name, index: rank.index });
    this.save();
  }

  spend(amount) {
    amount = money(amount);
    if (amount > this.cash) return false;
    this.cash -= amount;
    this.onEvent('cash', { amount: -amount, why: 'spend', cash: this.cash });
    this.save();
    return true;
  }

  // What the garage would charge to make the car as new, and doing it (R)
  repairCost() {
    const car = this.controllers.entities.car;
    return car.wrecked > 0 ? 0 : Math.ceil((100 - car.health) * 1.2);
  }

  repair() {
    const car = this.controllers.entities.car;
    const cost = this.repairCost();
    if (!cost) return false;
    if (!this.spend(cost)) {
      this.onEvent('notice', { text: `Repairs cost $${cost}. You have $${this.cash}.`, tone: 'bad' });
      return false;
    }
    car.health = 100;
    this.onEvent('notice', { text: `Car repaired for $${cost}`, tone: 'good' });
    return true;
  }

  setEnabled(enabled) {
    enabled = !!enabled;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      if (this.job) this.endJob();
      this.clearOffers();
    } else {
      this.cooldown = 0.3;
    }
    this.save();
    this.onEvent('enabled', { enabled });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Raccoons: one by each landmark and the rest in the parks, in the same places for everyone
  // -------------------------------------------------------------------------------------------------------------
  placeRaccoons(isClear = () => true) {
    const random = mulberry(0x70c0);
    const anchors = LANDMARKS.map((l) => ({ x: l.x, z: l.z, near: l.short || l.name }));
    // spread the rest over downtown on a jittered grid, so that every neighbourhood has a few
    const cols = 5;
    const rows = 4;
    for (let i = 0; anchors.length < RACCOON_COUNT * 2 && i < cols * rows * 2; i++) {
      const cx = CITY_BOUNDS.minX + ((i % cols) + 0.2 + random() * 0.6) * ((CITY_BOUNDS.maxX - CITY_BOUNDS.minX) / cols);
      const cz = CITY_BOUNDS.minZ + ((Math.floor(i / cols) % rows) + 0.2 + random() * 0.6) * ((CITY_BOUNDS.maxZ - CITY_BOUNDS.minZ) / rows);
      anchors.push({ x: cx, z: cz, near: null });
    }
    const placed = [];
    for (const anchor of anchors) {
      if (placed.length >= RACCOON_COUNT) break;
      for (let attempt = 0; attempt < 240; attempt++) {
        const r = 22 + random() * (anchor.near ? 80 : 160);
        const a = random() * Math.PI * 2;
        const x = anchor.x + Math.cos(a) * r;
        const z = anchor.z + Math.sin(a) * r;
        if (x < CITY_BOUNDS.minX + 20 || x > CITY_BOUNDS.maxX - 20 || z < CITY_BOUNDS.minZ + 20 || z > CITY_BOUNDS.maxZ - 20) continue;
        // on a sidewalk or in a park, in the open, a few steps from a street, and not on top of another one
        if (!blockAt(x, z)) continue;
        const land = pushOntoLand(x, z, 10);
        if (land.x !== x || land.z !== z) continue;
        const roads = nearestRoads(x, z, 26);
        if (!roads.length || roads[0].dist < 9) continue;
        if (!isClear(x, z, 1.6)) continue;
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 140)) continue;
        placed.push({ id: placed.length, x, z, yaw: random() * Math.PI * 2, near: anchor.near || getLocationLabel(x, z), found: false });
        break;
      }
    }
    for (const r of placed) r.found = this.found.has(r.id);
    this.raccoons = placed;
    return placed;
  }

  get raccoonTotal() {
    return this.raccoons.length;
  }

  updateRaccoons(entity, mode) {
    let near = Infinity;
    if (mode !== 'helicopter' || entity.position.y < 6) {
      for (const r of this.raccoons) {
        if (r.found) continue;
        const d = Math.hypot(r.x - entity.position.x, r.z - entity.position.z);
        if (d < near) near = d;
        if (d < 4.2) {
          r.found = true;
          this.found.add(r.id);
          const count = this.found.size;
          this.onEvent('raccoon', { raccoon: r, count, total: this.raccoons.length });
          this.earn(RACCOON_REWARD, 'raccoon');
          if (count === this.raccoons.length) {
            this.onEvent('notice', { text: `All ${count} raccoons found. Toronto's trash pandas salute you.`, tone: 'good', big: true });
            this.earn(RACCOON_ALL_BONUS, 'raccoons');
          }
          this.save();
        }
      }
    }
    this.raccoonNear = near;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------------------------------------------------
  // A spot at the kerb of the street nearest (x, z): where the vehicle stops (in the lane by the kerb) and where
  // whoever is waiting stands (on the sidewalk beside it, facing the road)
  kerbAt(x, z) {
    const hit = this.routeFinder.nearestEdge(x, z);
    if (!hit) return null;
    const e = hit.edge;
    const margin = Math.min(14, e.span * 0.3);
    const t = Math.max(margin, Math.min(e.span - margin, hit.t));
    const lane = e.lanes && e.lanes.length ? e.lanes[e.lanes.length - 1] : 1.8;
    const px = e.x0 + e.dx * t;
    const pz = e.z0 + e.dz * t;
    let stand = null;
    for (const off of [3.1, 2.5, 3.8, 4.6]) {
      const sx = px + e.rx * (lane + off);
      const sz = pz + e.rz * (lane + off);
      if (blockAt(sx, sz)) {
        stand = { x: sx, z: sz };
        break;
      }
    }
    stand ??= { x: px + e.rx * (lane + 3.1), z: pz + e.rz * (lane + 3.1) };
    return {
      x: px + e.rx * lane, z: pz + e.rz * lane,
      stand: { x: stand.x, z: stand.z, yaw: Math.atan2(-e.rx, -e.rz) },
      dir: { x: e.dx, z: e.dz }
    };
  }

  // A kerb about `min`..`max` m from (x, z), away from the spots already taken
  kerbAround(x, z, min, max, taken = []) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const r = min + this.random() * (max - min);
      const a = this.random() * Math.PI * 2;
      const tx = Math.max(CITY_BOUNDS.minX + 30, Math.min(CITY_BOUNDS.maxX - 30, x + Math.cos(a) * r));
      const tz = Math.max(CITY_BOUNDS.minZ + 30, Math.min(CITY_BOUNDS.maxZ - 30, z + Math.sin(a) * r));
      const kerb = this.kerbAt(tx, tz);
      if (!kerb) continue;
      const d = Math.hypot(kerb.x - x, kerb.z - z);
      if (d < min * 0.6 || d > max * 1.5) continue;
      if (taken.some((p) => Math.hypot(p.x - kerb.x, p.z - kerb.z) < 60)) continue;
      return kerb;
    }
    return null;
  }

  makeTrip(mode, x, z, taken) {
    const M = MODES[mode];
    const pickup = this.kerbAround(x, z, M.near[0], M.near[1], taken);
    if (!pickup) return null;
    // Half the fares are going somewhere everybody knows
    let dest = null;
    let place = null;
    let landmark = null;
    if (this.random() < 0.55) {
      const options = LANDMARKS.filter((l) => {
        const d = Math.hypot(l.x - pickup.x, l.z - pickup.z);
        return d > M.trip[0] && d < M.trip[1] * 1.25;
      });
      if (options.length) {
        landmark = pick(this.random, options);
        dest = this.kerbAt(landmark.x, landmark.z);
        if (dest && Math.hypot(dest.x - landmark.x, dest.z - landmark.z) > 220) dest = null;
        if (dest) place = landmark.name;
      }
    }
    if (!dest) {
      landmark = null;
      dest = this.kerbAround(pickup.x, pickup.z, M.trip[0], M.trip[1]);
      if (!dest) return null;
      place = getLocationLabel(dest.x, dest.z);
    }
    const route = this.routeFinder.route(pickup.x, pickup.z, dest.x, dest.z);
    const length = route ? route.length : Math.hypot(dest.x - pickup.x, dest.z - pickup.z) * 1.35;
    const name = pick(this.random, NAMES);
    const offer = {
      id: ++this.offerSeq, kind: M.kind, mode, x: pickup.x, z: pickup.z, y: 0, radius: M.zone, stand: pickup.stand,
      dest: { x: dest.x, z: dest.z, stand: dest.stand, place }, length, name, age: 0
    };
    if (M.kind === 'fare') {
      const id = pick(this.random, PERSONA_IDS);
      offer.persona = id;
      offer.tag = PERSONAS[id].tag;
      const lines = (landmark && FARE_LINES[landmark.id]) || GENERIC_LINES;
      offer.line = pick(this.random, lines).replace('{place}', place.split(' · ')[0]);
      offer.title = `${name} · ${offer.tag}`;
      offer.timeLimit = (length / M.pace + M.slack) * PERSONAS[id].time;
    } else {
      const k = Math.floor(this.random() * KITCHENS.length);
      offer.kitchen = KITCHENS[k];
      offer.order = ORDERS[k];
      offer.title = offer.kitchen;
      offer.line = `${offer.order[0].toUpperCase()}${offer.order.slice(1)} for ${name}. Keep it hot.`;
      offer.timeLimit = length / M.pace + M.slack;
    }
    offer.pay = money(M.base + length * M.rate);
    return offer;
  }

  // A sightseeing tour: rings hung by the landmarks, each the nearest one not yet visited, clear of the towers
  makeTour(entity) {
    const M = MODES.helicopter;
    const rings = [];
    let x = entity.position.x;
    let z = entity.position.z;
    const fwdX = Math.sin(entity.heading);
    const fwdZ = Math.cos(entity.heading);
    const clearAltitude = (px, pz) => this.roofAt(px, pz, 34);
    // the first ring hangs ahead of the helicopter: flying through it starts the tour
    const start = { x: x + fwdX * 170, z: z + fwdZ * 170 };
    start.x = Math.max(CITY_BOUNDS.minX, Math.min(CITY_BOUNDS.maxX, start.x));
    start.z = Math.max(CITY_BOUNDS.minZ, Math.min(CITY_BOUNDS.maxZ, start.z));
    rings.push({ x: start.x, z: start.z, y: Math.min(360, Math.max(90, entity.position.y, clearAltitude(start.x, start.z) + 40)), name: 'Start' });
    x = start.x;
    z = start.z;
    const used = new Set();
    while (rings.length < M.rings + 1) {
      const options = LANDMARKS.filter((l) => !used.has(l.id) && Math.hypot(l.x - x, l.z - z) > 260)
        .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, 4);
      if (!options.length) break;
      const lm = pick(this.random, options);
      used.add(lm.id);
      // beside the landmark, on the side with the lowest roofs
      let best = null;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = lm.x + Math.cos(a) * 95;
        const pz = lm.z + Math.sin(a) * 95;
        const top = clearAltitude(px, pz);
        if (!best || top < best.top) best = { x: px, z: pz, top };
      }
      if (best.top > 300) continue; // (hemmed in by towers taller than the helicopter climbs)
      rings.push({ x: best.x, z: best.z, y: Math.max(90, best.top + 42), name: lm.short || lm.name });
      x = best.x;
      z = best.z;
    }
    if (rings.length < 3) return null;
    let length = 0;
    for (let i = 0; i < rings.length; i++) {
      const prev = i ? rings[i - 1] : { x: entity.position.x, y: entity.position.y, z: entity.position.z };
      const r = rings[i];
      r.leg = Math.hypot(r.x - prev.x, r.y - prev.y, r.z - prev.z);
      r.yaw = Math.atan2(r.x - prev.x, r.z - prev.z);
      r.time = r.leg / M.pace + M.slack;
      if (i) length += r.leg;
    }
    return {
      id: ++this.offerSeq, kind: 'tour', mode: 'helicopter', x: rings[0].x, y: rings[0].y, z: rings[0].z, radius: M.ringRadius,
      rings, length, pay: money(30 + (rings.length - 1) * 22 + length * 0.012), age: 0,
      title: 'Skyline tour', line: `${rings.length - 1} stops: ${rings.slice(1).map((r) => r.name).join(', ')}`
    };
  }

  clearOffers() {
    if (!this.offers.length) return;
    this.offers = [];
    this.onEvent('offers', { offers: this.offers });
  }

  refreshOffers(entity, mode) {
    const M = MODES[mode];
    if (!M) return this.clearOffers();
    let changed = false;
    // offers left far behind, or that nobody took, make way for new ones
    const keep = this.offers.filter((o) => {
      const d = Math.hypot(o.x - entity.position.x, o.z - entity.position.z);
      return o.mode === mode && d < (mode === 'helicopter' ? 900 : 620) && o.age < (mode === 'helicopter' ? 75 : 150);
    });
    if (keep.length !== this.offers.length) {
      this.offers = keep;
      changed = true;
    }
    for (let guard = 0; this.offers.length < M.offers && guard < 4; guard++) {
      const offer = mode === 'helicopter' ? this.makeTour(entity) : this.makeTrip(mode, entity.position.x, entity.position.z, this.offers);
      if (!offer) continue;
      this.offers.push(offer);
      changed = true;
    }
    if (changed) this.onEvent('offers', { offers: this.offers });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The job in hand
  // -------------------------------------------------------------------------------------------------------------
  accept(offer) {
    const job = this.job = { ...offer, stage: 'boarding', wait: offer.kind === 'tour' ? 0 : 1.25, hits: 0, styleCash: 0, elapsed: 0, late: false };
    this.offers = [];
    this.onEvent('offers', { offers: this.offers });
    if (job.kind === 'tour') {
      job.stage = 'tour';
      job.ring = 1;
      job.timeLeft = job.rings[1].time;
      job.timeLimit = job.timeLeft;
      this.onEvent('accept', { job });
      this.onEvent('ring', { job, index: 0, last: false });
    } else {
      job.timeLeft = job.timeLimit;
      this.onEvent('accept', { job });
    }
  }

  endJob() {
    const job = this.job;
    this.job = null;
    this.cooldown = 2.2;
    return job;
  }

  fail(reason) {
    const job = this.endJob();
    if (!job) return;
    this.streak = 0;
    this.onEvent('fail', { job, reason });
  }

  complete() {
    const job = this.endJob();
    const M = MODES[job.mode];
    let stars;
    let tip = 0;
    let fare = job.pay;
    const ratio = Math.max(0, job.timeLeft) / job.timeLimit;
    if (job.kind === 'tour') {
      stars = Math.max(1, Math.min(5, Math.round(3 + ratio * 6 - job.hits)));
      tip = job.pay * 0.5 * Math.min(1, ratio * 3);
    } else {
      const persona = PERSONAS[job.persona] || { tip: 1, bump: 1 };
      const bumps = job.hits * persona.bump;
      stars = 5 - Math.round(bumps * 0.9) - (job.late ? 2 : ratio < 0.12 ? 1 : 0);
      stars = Math.max(1, Math.min(5, stars));
      if (job.late) fare = job.pay * Math.max(0.4, 1 + job.timeLeft / 45 * 0.6); // (timeLeft is negative: down to 40%)
      else tip = job.pay * (0.12 + 0.55 * ratio) * persona.tip * Math.max(0, 1 - bumps * 0.3);
      if (job.persona === 'nervous' && !job.hits && !job.late) tip += job.pay * 0.25; // a smooth ride
    }
    if (stars >= 4) {
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else if (stars <= 2) {
      this.streak = 0;
    }
    const multiplier = 1 + Math.min(10, Math.max(0, this.streak - 1)) * 0.1;
    const total = money((fare + tip) * multiplier);
    this.completed[job.kind]++;
    this.bestPayout = Math.max(this.bestPayout, total);
    this.onEvent('complete', {
      job, fare: money(fare), tip: money(tip), stars, multiplier, total, streak: this.streak, late: job.late,
      seconds: job.elapsed, pace: M.pace
    });
    this.earn(total, job.kind);
  }

  // A crash while working: the customer (or the order) feels it
  onCollision(event) {
    const entity = this.controllers.getActiveEntity();
    if (!event || (event.a !== entity && event.b !== entity)) return;
    const speed = event.speed || 0;
    if (speed < 3.2 || this.clock - this.style.lastHit < 0.9) return;
    this.style.lastHit = this.clock;
    this.breakCombo();
    const other = event.a === entity ? event.b : event.a;
    const pedestrian = !!(other && other.rig);
    const job = this.job;
    if (job && job.stage !== 'boarding') {
      job.hits += pedestrian ? 2 : speed > 9 ? 1.5 : 1;
      this.onEvent('hit', { job, pedestrian, speed });
    } else if (pedestrian) {
      this.onEvent('hit', { job: null, pedestrian, speed });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Style: drifts, near misses and flat-out runs in the car
  // -------------------------------------------------------------------------------------------------------------
  breakCombo() {
    const s = this.style;
    if (s.combo > 1) this.onEvent('combo', { combo: 0 });
    s.combo = 0;
    s.comboTimer = 0;
    s.drift = 0;
    s.fast = 0;
    s.pending.length = 0;
  }

  stylePoint(label, amount) {
    const s = this.style;
    s.combo = Math.min(5, s.combo + 1);
    s.comboTimer = 6;
    let factor = s.combo;
    const job = this.job;
    const riding = job && job.kind === 'fare' && job.stage === 'trip';
    if (riding) factor *= PERSONAS[job.persona].style;
    const total = money(amount * factor);
    if (!total) return;
    if (riding) job.styleCash += total;
    this.onEvent('style', { label, amount: total, combo: s.combo, loved: riding && job.persona === 'thrill' });
    this.earn(total, 'style');
  }

  updateStyle(dt, car) {
    const s = this.style;
    if (s.comboTimer > 0) {
      s.comboTimer -= dt;
      if (s.comboTimer <= 0) {
        s.combo = 0;
        this.onEvent('combo', { combo: 0 });
      }
    }
    if (car.wrecked > 0) return this.breakCombo();
    const speed = Math.abs(car.speed);

    // Drift: paid when the slide ends, by how long and how fast it was
    if (car.skid > 0.45 && speed > 7) {
      s.drift += dt * (3 + speed * 0.22);
      s.driftGap = 0;
    } else if (s.drift > 0) {
      s.driftGap += dt;
      if (s.driftGap > 0.4) {
        if (s.drift > 4) this.stylePoint(s.drift > 22 ? 'Monster drift' : s.drift > 11 ? 'Big drift' : 'Drift', s.drift * 0.45);
        s.drift = 0;
      }
    }

    // Flat out: every three seconds held above 110 km/h
    if (speed > 30.5) {
      s.fast += dt;
      if (s.fast >= 3) {
        s.fast = 0;
        this.stylePoint('Flat out', 6);
      }
    } else {
      s.fast = 0;
    }

    // Near miss: passing traffic within a door's width at speed. It counts once it's clear no crash followed
    for (let i = s.pending.length - 1; i >= 0; i--) {
      if ((s.pending[i] -= dt) <= 0) {
        s.pending.splice(i, 1);
        this.stylePoint('Near miss', 4);
      }
    }
    if (speed > 12.5 && this.traffic) {
      const sin = Math.sin(car.heading);
      const cos = Math.cos(car.heading);
      for (const list of [this.traffic.cars, this.traffic.buses]) {
        if (!list) continue;
        for (const v of list) {
          const dx = v.x - car.position.x;
          const dz = v.z - car.position.z;
          if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
          const across = Math.abs(dx * cos - dz * sin);
          const along = Math.abs(dx * sin + dz * cos);
          if (along > 2.6 || across < 1.7 || across > 3.5) continue;
          if (this.clock - (s.seen.get(v) ?? -10) < 4) continue;
          s.seen.set(v, this.clock);
          s.pending.push(0.45);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Every frame
  // -------------------------------------------------------------------------------------------------------------
  update(dt, mode = this.controllers.activeMode) {
    this.clock += dt;
    const entity = this.controllers.entities[mode];
    if (mode !== this.mode) {
      // changing vehicle walks away from whatever was in hand
      if (this.job) this.fail('abandoned');
      this.mode = mode;
      this.clearOffers();
      this.cooldown = Math.min(this.cooldown, 0.6);
      this.breakCombo();
    }
    this.updateRaccoons(entity, mode);
    if (!this.enabled) {
      this.setTarget(null);
      return;
    }
    if (mode === 'car') this.updateStyle(dt, entity);

    const M = MODES[mode];
    const job = this.job;
    const px = entity.position.x;
    const pz = entity.position.z;
    const speed = Math.abs(entity.speed);

    if (!job) {
      for (const o of this.offers) o.age += dt;
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        this.cooldown = 1;
        this.refreshOffers(entity, mode);
      }
      // taking one: stopping at its kerb, or flying through a tour's first ring
      let nearest = null;
      let nearestDist = Infinity;
      for (const o of this.offers) {
        const d = o.kind === 'tour' ? Math.hypot(o.x - px, o.y - entity.position.y, o.z - pz) : Math.hypot(o.x - px, o.z - pz);
        if (d < nearestDist) {
          nearest = o;
          nearestDist = d;
        }
      }
      if (nearest && nearestDist < nearest.radius && (nearest.kind === 'tour' || speed < M.stopSpeed) && !(entity.wrecked > 0)) {
        this.accept(nearest);
      } else {
        this.setTarget(nearest ? { x: nearest.x, y: nearest.y, z: nearest.z, radius: nearest.radius, kind: 'offer', ref: nearest } : null);
      }
    }

    if (this.job) this.updateJob(dt, entity, mode);
    this.updateRoute(dt, entity, mode);
  }

  updateJob(dt, entity, mode) {
    const job = this.job;
    const M = MODES[mode];
    const px = entity.position.x;
    const pz = entity.position.z;
    const speed = Math.abs(entity.speed);

    if (job.kind === 'tour') {
      job.elapsed += dt;
      job.timeLeft -= dt;
      const ring = job.rings[job.ring];
      this.setTarget({ x: ring.x, y: ring.y, z: ring.z, radius: M.ringRadius, kind: 'ring', ref: ring });
      if (Math.hypot(ring.x - px, ring.y - entity.position.y, ring.z - pz) < M.ringRadius + 1.5) {
        const last = job.ring === job.rings.length - 1;
        this.onEvent('ring', { job, index: job.ring, last });
        if (last) return this.complete();
        job.ring++;
        // what's left on the clock carries over
        job.timeLeft += job.rings[job.ring].time;
        job.timeLimit = Math.max(job.timeLimit, job.timeLeft);
      } else if (job.timeLeft <= 0) {
        this.fail('timeout');
      }
      return;
    }

    if (job.stage === 'boarding') {
      // they get in (or the order is handed over) while the vehicle waits at the kerb
      this.setTarget({ x: job.x, y: 0, z: job.z, radius: job.radius, kind: 'pickup', ref: job });
      if (Math.hypot(job.x - px, job.z - pz) > job.radius + 5) {
        // drove off without them
        this.job = null;
        this.cooldown = 0.5;
        this.onEvent('fail', { job, reason: 'left' });
        return;
      }
      if (speed < M.stopSpeed) job.wait -= dt;
      if (job.wait <= 0) {
        job.stage = 'trip';
        this.onEvent('boarded', { job });
      }
      return;
    }

    if (job.stage === 'trip') {
      job.elapsed += dt;
      job.timeLeft -= dt;
      if (!job.late && job.timeLeft <= 0) {
        job.late = true;
        this.onEvent('late', { job });
      }
      if (job.timeLeft < -45) return this.fail('timeout');
      if (entity.wrecked > 0) return this.fail('wrecked');
      const d = job.dest;
      this.setTarget({ x: d.x, y: 0, z: d.z, radius: job.radius, kind: 'dropoff', ref: job });
      if (Math.hypot(d.x - px, d.z - pz) < job.radius + 1 && speed < M.stopSpeed) {
        job.stage = 'alighting';
        job.wait = 0.9;
        this.onEvent('arrived', { job });
      }
      return;
    }

    if (job.stage === 'alighting') {
      job.wait -= dt;
      if (job.wait <= 0) this.complete();
    }
  }

  setTarget(target) {
    const ref = target ? target.ref : null;
    const kind = target ? target.kind : null;
    if (ref !== this.routeFor || kind !== this.routeKind) {
      this.routeFor = ref;
      this.routeKind = kind;
      this.route = null;
      this.routeTimer = 0;
    }
    this.target = target;
  }

  // The way by road to the target, found again when the player strays from it
  updateRoute(dt, entity, mode) {
    const target = this.target;
    if (!target || mode === 'helicopter' || mode === 'person') {
      this.route = null;
      return;
    }
    this.routeTimer -= dt;
    const px = entity.position.x;
    const pz = entity.position.z;
    if (this.route) {
      const at = locateOnPath(this.route.points, px, pz, this.routeIndex);
      this.routeIndex = at.index;
      this.routeAlong = at.along;
      this.routeOff = at.dist;
      if (at.dist < 28 || this.routeTimer > 0) return;
    } else if (this.routeTimer > 0) {
      return;
    }
    this.routeTimer = 1.2;
    const route = this.routeFinder.route(px, pz, target.x, target.z, entity.heading);
    this.route = route;
    this.routeIndex = 0;
    this.routeAlong = 0;
    this.routeOff = 0;
    this.routeVersion = (this.routeVersion || 0) + 1;
  }

  // Metres left to the target: by road where there is a route, as the crow flies otherwise
  distanceLeft(entity) {
    const t = this.target;
    if (!t) return 0;
    if (this.route) return Math.max(0, this.route.length - this.routeAlong);
    return Math.hypot(t.x - entity.position.x, (t.y || 0) - (t.kind === 'ring' || t.ref?.kind === 'tour' ? entity.position.y : 0), t.z - entity.position.z);
  }
}

export { GigSystem, RANKS, rankFor, PERSONAS, MODES as GIG_MODES, RACCOON_COUNT, STORAGE_KEY };
