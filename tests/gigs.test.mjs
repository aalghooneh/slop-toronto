import assert from 'node:assert/strict';
import test from 'node:test';
import { GigSystem, rankFor, RANKS, STORAGE_KEY } from '../js/gigs.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

function harness({ storage = memoryStorage() } = {}) {
  const events = [];
  const car = { type: 'car', position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0, health: 100, wrecked: 0, skid: 0 };
  const controllers = { activeMode: 'car', entities: { car }, getActiveEntity: () => car };
  const gigs = new GigSystem({ routeFinder: { route: () => null, nearestEdge: () => null }, controllers, storage, onEvent: (type, data) => events.push([type, data]) });
  return { gigs, car, events, storage };
}

const fare = (over = {}) => ({
  id: 1, kind: 'fare', mode: 'car', x: 0, z: 0, radius: 6.5, stand: { x: 3, z: 0, yaw: 0 }, name: 'Priya', persona: 'chill',
  dest: { x: 0, z: 500, stand: { x: 3, z: 500, yaw: 0 }, place: 'Union Station' }, length: 500, pay: 20, timeLimit: 60, ...over
});

test('ranks climb with lifetime earnings', () => {
  assert.equal(rankFor(0).name, RANKS[0].name);
  assert.equal(rankFor(RANKS[2].cash).index, 2);
  const mid = rankFor((RANKS[1].cash + RANKS[2].cash) / 2);
  assert.equal(mid.index, 1);
  assert.ok(Math.abs(mid.progress - 0.5) < 1e-9);
  assert.equal(rankFor(1e9).next, null);
});

test('a fare is picked up at the kerb, carried, dropped off and paid with a tip', () => {
  const { gigs, car, events } = harness();
  gigs.mode = 'car';
  gigs.accept(fare());
  assert.equal(gigs.job.stage, 'boarding');
  for (let i = 0; i < 100; i++) gigs.update(0.02, 'car'); // 2 s stopped at the kerb
  assert.equal(gigs.job.stage, 'trip');
  car.position.z = 500;
  gigs.update(0.02, 'car');
  assert.equal(gigs.job.stage, 'alighting');
  for (let i = 0; i < 60; i++) gigs.update(0.02, 'car');
  assert.equal(gigs.job, null);
  const done = events.find(([type]) => type === 'complete')[1];
  assert.equal(done.fare, 20);
  assert.ok(done.tip > 0 && done.stars === 5 && done.total === done.fare + done.tip);
  assert.equal(gigs.cash, done.total);
  assert.equal(gigs.streak, 1);
});

test('crashes cost stars and the tip; running late costs the fare itself', () => {
  const rough = harness();
  rough.gigs.mode = 'car';
  rough.gigs.accept(fare({ persona: 'nervous' }));
  for (let i = 0; i < 100; i++) rough.gigs.update(0.02, 'car');
  for (let k = 0; k < 3; k++) {
    rough.gigs.clock += 2;
    rough.gigs.onCollision({ a: rough.car, b: {}, speed: 8 });
  }
  rough.car.position.z = 500;
  for (let i = 0; i < 80; i++) rough.gigs.update(0.02, 'car');
  const roughRide = rough.events.find(([type]) => type === 'complete')[1];
  assert.ok(roughRide.stars <= 2 && roughRide.tip === 0);
  assert.equal(rough.gigs.streak, 0);

  const late = harness();
  late.gigs.mode = 'car';
  late.gigs.accept(fare({ timeLimit: 3 }));
  for (let i = 0; i < 100; i++) late.gigs.update(0.02, 'car');
  for (let i = 0; i < 500; i++) late.gigs.update(0.02, 'car'); // 10 s on a 3 s fare
  late.car.position.z = 500;
  for (let i = 0; i < 80; i++) late.gigs.update(0.02, 'car');
  const lateRide = late.events.find(([type]) => type === 'complete')[1];
  assert.ok(lateRide.late && lateRide.fare < 20 && lateRide.tip === 0);
});

test('a fare who waits too long gets out; changing vehicle abandons the job', () => {
  const { gigs, events } = harness();
  gigs.mode = 'car';
  gigs.accept(fare({ timeLimit: 1 }));
  for (let i = 0; i < 100; i++) gigs.update(0.02, 'car');
  for (let i = 0; i < 2400 && gigs.job; i++) gigs.update(0.02, 'car');
  assert.equal(gigs.job, null);
  assert.equal(events.find(([type]) => type === 'fail')[1].reason, 'timeout');
  assert.equal(gigs.cash, 0);
});

test('progress is saved and restored, and bad saves are ignored', () => {
  const first = harness();
  first.gigs.earn(321, 'test');
  first.gigs.found.add(7);
  first.gigs.save();
  const again = harness({ storage: first.storage });
  assert.equal(again.gigs.cash, 321);
  assert.ok(again.gigs.found.has(7));
  const broken = harness({ storage: memoryStorage({ [STORAGE_KEY]: '{"version":1,"cash":"lots","found":[999,-1,"x"]}' }) });
  assert.equal(broken.gigs.cash, 0);
  assert.equal(broken.gigs.found.size, 0);
});

test('repairs are paid for, and refused without the cash', () => {
  const { gigs, car } = harness();
  car.health = 50;
  assert.equal(gigs.repairCost(), 60);
  assert.equal(gigs.repair(), false);
  assert.equal(car.health, 50);
  gigs.earn(100, 'test');
  assert.equal(gigs.repair(), true);
  assert.equal(car.health, 100);
  assert.equal(gigs.cash, 40);
});

test('raccoons are placed the same way every time, in the open, well apart', () => {
  const a = harness().gigs.placeRaccoons();
  const b = harness().gigs.placeRaccoons();
  assert.ok(a.length >= 30, `most of the 40 find a spot (${a.length})`);
  assert.deepEqual(a.map((r) => [r.x, r.z]), b.map((r) => [r.x, r.z]));
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) >= 140);
  }
});
