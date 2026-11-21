// Standalone regression tests for Falcon Heavy Phase 1B.4 (propulsion/fuel model).
// Run from the repository root: node tests/assembly-propulsion.test.cjs
// Node built-ins only. ALL fixture values below are SYNTHETIC test data; none
// is a real Falcon Heavy (or Falcon 9) measurement.
const baseAssert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const propulsionPath = path.join(root, 'js', 'simJs', 'core', 'assemblyPropulsion.js');
const vehiclePath = path.join(root, 'js', 'simJs', 'core', 'vehicle.js');
const assembliesPath = path.join(root, 'js', 'vehicleAssemblies.js');
const propulsionSource = read('js', 'simJs', 'core', 'assemblyPropulsion.js');
const vehicleSource = read('js', 'simJs', 'core', 'vehicle.js');
const assembliesSource = read('js', 'vehicleAssemblies.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
// Objects created inside a vm context have a different realm's prototypes, so
// strict deepEqual compares JSON-normalised copies of both sides instead.
const assert = Object.assign((...a) => baseAssert(...a), baseAssert, {
  deepEqual: (a, b, m) => baseAssert.deepEqual(plain(a), plain(b), m),
  notDeepEqual: (a, b, m) => baseAssert.notDeepEqual(plain(a), plain(b), m),
});

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write('PASS ' + name + '\n');
}

// ------------------------------------------------------------- fixtures
const ATTACHED_FIELD_NAMES = ['coreInstanceId', 'memberId', 'memberIndex', 'tankKey', 'uid'];
const SLOT_IDS = ['C', 'E0', 'E45', 'E90', 'E135', 'E180', 'E225', 'E270', 'E315'];

function makeLayout(id, slotIds) {
  return {
    id,
    category: 'engineLayout',
    kind: 'ringWithCenter',
    frame: {
      slots: slotIds.map((sid, i) => ({
        id: sid,
        role: i === 0 ? 'center' : 'outer',
        gimbalCapable: true,
        angleDeg: i === 0 ? null : (i - 1) * 45,
        position: (R) => ({ x: i === 0 ? 0 : R * Math.cos(((i - 1) * 45) * Math.PI / 180) }),
      })),
    },
  };
}
function makeThruster() {
  return {
    id: 'thr-synth',
    category: 'thruster',
    parameterSchema: [
      { key: 'veVacuum', value: 3000 },
      { key: 'atmosphericPenalty', value: 300 },
      { key: 'minThrottleFrac', value: 0.4 },
      { key: 'maxThrottleRateFrac', value: 0.5 },
    ],
  };
}
function makeFleet() {
  const engineRecord = (id, role, extra) => Object.assign({
    id, stageRole: role, familyId: 'fam-synth', height: 40, width: 3.5, dryMass: 20000,
    engineTypeId: 'layout-synth-9',
    params: { octaRadius: 1.5 },
    engineThrusters: { gimbal: { thrusterTypeId: 'thr-synth', massFlowRate: 250 } },
    synthTankKg: 100000,
  }, extra || {});
  return [
    engineRecord('center-booster', 'booster', { synthTankKg: 100000 }),
    { id: 'upper-stage', stageRole: 'stage', familyId: 'fam-synth', height: 12, width: 3.5, dryMass: 4000, synthAboveDeductKg: 2000 },
    engineRecord('side-rocket', 'rocket', { noseHeightM: 3.2, synthTankKg: 80000 }),
  ];
}
function makeStacks() {
  return [{ id: 'central-stack', sequence: 'custom', members: ['center-booster', 'upper-stage'], payloadId: null }];
}
function makeAssembly() {
  return {
    id: 'asm-test', schemaVersion: 1, type: 'triple-core', name: 'Synthetic Triple-Core Test',
    centralStackId: 'central-stack',
    sideCores: [{ slotId: 'left', recordId: 'side-rocket' }, { slotId: 'right', recordId: 'side-rocket' }],
    locked: false,
  };
}

function makeContext(overrides) {
  const calls = { build: [], built: [], fuel: [] };
  const library = {
    'layout-synth-9': makeLayout('layout-synth-9', SLOT_IDS),
    'thr-synth': makeThruster(),
  };
  const ctx = {
    CONFIG: { ENGINE_THRUST_RATE: 0.5, GIMBAL_ACCEL_OVERRIDE: 0 },
    getComponentType(id) { return id ? (library[id] || null) : null; },
    // Same grouping rule as fleet.js's engineThrusterGroups().
    engineThrusterGroups(layout) {
      const groups = {};
      if (!layout || !layout.frame || !layout.frame.slots) return groups;
      layout.frame.slots.forEach((slot) => {
        const key = slot.gimbalCapable ? 'gimbal' : 'fixed';
        (groups[key] = groups[key] || []).push(slot);
      });
      return groups;
    },
    validateStack(members, records) {
      const resolved = members.map((id) => records.find((r) => r && r.id === id));
      const valid = resolved.length > 0 && resolved.every(Boolean);
      return {
        valid,
        errors: valid ? [] : ['one or more members are missing'],
        stackTotalHeight: valid ? resolved.reduce((s, r) => s + r.height + (r.noseHeightM || 0), 0) : 0,
        stackTotalMass: valid ? resolved.reduce((s, r) => s + r.dryMass, 0) : 0,
      };
    },
    // Synthetic stand-in for massProps.js's memberMaxFuel (records its arguments).
    // It also reproduces the PRODUCTION side effect: boosterDerivedMasses() writes
    // a private _bdmCache onto the record it is given.
    memberMaxFuel(rec, above) {
      calls.fuel.push({ rec, above, argc: arguments.length });
      rec._bdmCache = { key: 'synthetic|' + (above ? above.id : '-'), value: { fuelMass: 0 } };
      return (rec.synthTankKg || 0) - ((above && above.synthAboveDeductKg) || 0);
    },
    // Storage / implicit-selection access must never happen.
    localStorage: { getItem() { throw new Error('storage read'); }, setItem() { throw new Error('storage write'); } },
    loadFleet() { throw new Error('implicit loadFleet'); },
    loadStacks() { throw new Error('implicit loadStacks'); },
    __calls: calls,
    __library: library,
    ...(overrides || {}),
  };
  vm.createContext(ctx);
  vm.runInContext(assembliesSource, ctx, { filename: assembliesPath });
  vm.runInContext(vehicleSource, ctx, { filename: vehiclePath });
  const realBuild = ctx.buildEnginesForRecord;
  ctx.__realBuild = realBuild;
  ctx.buildEnginesForRecord = function (rec) { calls.build.push(rec); const out = realBuild(rec); calls.built.push(out); return out; };
  vm.runInContext(propulsionSource, ctx, { filename: propulsionPath });
  return ctx;
}
function input(overrides) {
  return { assembly: makeAssembly(), fleet: makeFleet(), stacks: makeStacks(), ...(overrides || {}) };
}
function model(ctx, overrides) { return ctx.AssemblyPropulsion.buildAssemblyPropulsionModel(input(overrides)); }
function mustBuild(ctx, overrides) {
  const r = ctx.AssemblyPropulsion.buildEnginePacks(input(overrides));
  assert.equal(r.ok, true, r.errors.join(' | '));
  return r;
}
function rejects(result, re, msg) {
  assert.equal(result.ok, false, msg || 'expected rejection');
  assert.ok(result.errors.length > 0, 'errors reported');
  if (re) assert.ok(result.errors.some((e) => re.test(e)), (msg || '') + ' :: ' + result.errors.join(' | '));
}
function withoutCache(rec) { const c = { ...rec }; delete c._bdmCache; return c; }
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
function planInput(over) {
  const engines = [
    { uid: 'c1', tankKey: 'center:0', massFlowRate: 100 },
    { uid: 'c2', tankKey: 'center:0', massFlowRate: 100 },
    { uid: 'l1', tankKey: 'side-left:0', massFlowRate: 100 },
    { uid: 'r1', tankKey: 'side-right:0', massFlowRate: 100 },
  ];
  return Object.assign({
    engines,
    fuelByTankKey: { 'center:0': 1000, 'side-left:0': 1000, 'side-right:0': 1000 },
    rcsMassFlowDemand: 0,
    dt: 0.1,
  }, over || {});
}

// ------------------------------------------------------------- API shape
check('exposes a frozen globalThis.AssemblyPropulsion with the stable API', () => {
  const ctx = makeContext();
  const api = ctx.AssemblyPropulsion;
  assert.ok(Object.isFrozen(api));
  ['buildEnginePacks', 'buildFuelCapacityDescriptors', 'buildAssemblyPropulsionModel', 'computeHeavyFuelTotals',
    'planFuelStarvation', 'flattenEnginePacks', 'validateEngineUids', 'buildEngineUid'].forEach((n) => {
    assert.equal(typeof api[n], 'function', n);
  });
  assert.deepEqual(plain(api.CORE_IDS), ['center', 'side-left', 'side-right']);
  assert.deepEqual(plain(api.TANK_KEYS), ['center:0', 'side-left:0', 'side-right:0']);
  assert.equal(Reflect.set(api, 'extra', 1), false, 'frozen: cannot add properties');
  assert.equal(Reflect.set(api, 'buildEnginePacks', null), false, 'frozen: cannot replace functions');
  assert.ok(!('extra' in api));
});

// ------------------------------------------------------------- engine packs
check('valid assembly produces exactly three packs in order centre, left, right', () => {
  const ctx = makeContext();
  const r = mustBuild(ctx);
  assert.equal(r.packs.length, 3);
  assert.deepEqual(r.packs.map((p) => p.coreInstanceId), ['center', 'side-left', 'side-right']);
  assert.deepEqual(r.packs.map((p) => p.tankKey), ['center:0', 'side-left:0', 'side-right:0']);
  assert.deepEqual(r.packs.map((p) => p.memberId), ['center-booster', 'side-rocket', 'side-rocket']);
  assert.deepEqual(r.packs.map((p) => p.memberIndex), [0, 0, 0]);
});

check('three nine-engine packs give 27 distinct engine objects and UIDs in flatten order', () => {
  const ctx = makeContext();
  const r = mustBuild(ctx);
  r.packs.forEach((p) => assert.equal(p.engines.length, 9));
  assert.equal(r.engines.length, 27);
  assert.equal(new Set(r.engines).size, 27);
  assert.equal(new Set(r.engines.map((e) => e.uid)).size, 27);
  assert.deepEqual(r.engines.map((e) => e.coreInstanceId),
    [].concat(Array(9).fill('center'), Array(9).fill('side-left'), Array(9).fill('side-right')));
  assert.deepEqual(r.engines.map((e) => e.id), [].concat(SLOT_IDS, SLOT_IDS, SLOT_IDS));
  const flat = ctx.AssemblyPropulsion.flattenEnginePacks(r.packs);
  flat.forEach((e, i) => assert.strictEqual(e, r.engines[i]));
});

check('original engine.id values are unchanged and no localSlotId field is added', () => {
  const ctx = makeContext();
  const r = mustBuild(ctx);
  r.packs.forEach((p) => {
    assert.deepEqual(p.engines.map((e) => e.id), SLOT_IDS);
    p.engines.forEach((e) => {
      assert.ok(!('localSlotId' in e));
      assert.equal(e.coreInstanceId, p.coreInstanceId);
      assert.equal(e.memberId, p.memberId);
      assert.equal(e.memberIndex, 0);
      assert.equal(e.tankKey, p.tankKey);
      assert.equal(typeof e.uid, 'string');
    });
  });
  assert.equal(r.packs[1].engines[2].uid, 'side-left|m0|side-rocket|s2|E45');
});

check('UID builder protects against delimiter collisions', () => {
  const ctx = makeContext();
  const u = ctx.AssemblyPropulsion.buildEngineUid;
  assert.notEqual(u('side-left', 0, 'a|s1|b', 2, 'E'), u('side-left', 0, 'a', 1, 'b|s2|E'));
  assert.notEqual(u('center', 0, 'x', 0, 'C'), u('center', 0, 'x', 1, 'C'));
  assert.equal(u('side-left', 0, 'a|b', 1, 'E'), 'side-left|m0|a%7Cb|s1|E', 'memberId is encoded');
  assert.equal(u('side-left', 0, 'a', 1, 'E|b'), 'side-left|m0|a|s1|E%7Cb', 'slot id is encoded');
});

check('same side record in both slots yields independent mutable objects', () => {
  const ctx = makeContext();
  const r = mustBuild(ctx);
  const left = r.packs[1];
  const right = r.packs[2];
  assert.equal(left.recordId, right.recordId);
  assert.notStrictEqual(left.engines, right.engines);
  left.engines.forEach((e, i) => assert.notStrictEqual(e, right.engines[i]));
  Object.keys(left.engines[0]).forEach((k) => {
    const v = left.engines[0][k];
    if (v && typeof v === 'object') assert.notStrictEqual(v, right.engines[0][k], k);
  });
});

check('mutating left engine state never changes right or centre engine state', () => {
  const ctx = makeContext();
  const r = mustBuild(ctx);
  const rightBefore = plain(r.packs[2].engines);
  const centerBefore = plain(r.packs[0].engines);
  r.packs[1].engines.forEach((e) => {
    e.massFlowRate = 123; e.targetMassFlowRate = 200; e.gimbalDeg = 4; e.currentF = 9; e.Ve = 1;
  });
  assert.deepEqual(plain(r.packs[2].engines), rightBefore);
  assert.deepEqual(plain(r.packs[0].engines), centerBefore);
  r.packs[2].engines[0].massFlowRate = 77;
  assert.equal(r.packs[1].engines[0].massFlowRate, 123);
  assert.equal(r.packs[0].engines[0].massFlowRate, 0);
});

check('two separate builds never share engine objects', () => {
  const ctx = makeContext();
  const a = mustBuild(ctx);
  const b = mustBuild(ctx);
  const first = new Set(a.engines);
  b.engines.forEach((e) => assert.ok(!first.has(e)));
});

check('buildEnginesForRecord is called separately for every pack', () => {
  const ctx = makeContext();
  const inp = input();
  const r = ctx.AssemblyPropulsion.buildEnginePacks(inp);
  assert.equal(r.ok, true);
  assert.equal(ctx.__calls.build.length, 3);
  assert.strictEqual(ctx.__calls.build[0], inp.fleet[0]);
  assert.strictEqual(ctx.__calls.build[1], inp.fleet[2]);
  assert.strictEqual(ctx.__calls.build[2], inp.fleet[2]);
});

check('output engines are shallow clones; builder objects never acquire ownership fields', () => {
  const ctx = makeContext();
  const r = mustBuild(ctx);
  assert.equal(ctx.__calls.built.length, 3);
  r.packs.forEach((pack, i) => {
    const sources = ctx.__calls.built[i];
    assert.equal(sources.length, 9);
    sources.forEach((src, j) => {
      const out = pack.engines[j];
      assert.notStrictEqual(out, src, 'output is a clone, not the builder object');
      ATTACHED_FIELD_NAMES.forEach((k) => assert.ok(!(k in src), 'builder object must not gain ' + k));
      assert.equal(out.id, src.id, 'id unchanged');
      Object.keys(src).forEach((k) => assert.strictEqual(out[k], src[k], 'field preserved: ' + k));
      assert.deepEqual(Object.keys(out).filter((k) => !ATTACHED_FIELD_NAMES.includes(k)), Object.keys(src));
    });
  });
  const sourceBefore = plain(ctx.__calls.built[0][0]);
  r.packs[0].engines[0].massFlowRate = 55;
  assert.deepEqual(ctx.__calls.built[0][0], sourceBefore, 'mutating an output never touches the builder object');
});

check('frozen engine objects from an injected builder are accepted and left untouched', () => {
  const ctx = makeContext();
  const sources = [];
  const deps = {
    buildEnginesForRecord(rec) {
      const e = ctx.__realBuild(rec);
      e.forEach((x) => Object.freeze(x));
      sources.push(e);
      return e;
    },
  };
  const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps }));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(sources.length, 3);
  sources.forEach((arr) => arr.forEach((src) => {
    assert.ok(Object.isFrozen(src));
    ATTACHED_FIELD_NAMES.forEach((k) => assert.ok(!(k in src)));
  }));
  r.engines.forEach((e) => assert.ok(!Object.isFrozen(e), 'output engines are mutable clones'));
  assert.equal(r.engines.length, 27);
  assert.deepEqual(r.packs[1].engines.map((e) => e.id), SLOT_IDS);
  const rightBefore = plain(r.packs[2].engines);
  r.packs[1].engines.forEach((e) => { e.massFlowRate = 40; e.gimbalDeg = 2; });
  assert.deepEqual(r.packs[2].engines, rightBefore, 'left/right state stays independent');
});

check('reusing the same source engine objects for several builds still yields independent outputs', () => {
  const ctx = makeContext();
  const shared = ctx.__realBuild(makeFleet()[0]);
  const sharedBefore = plain(shared);
  const deps = { buildEnginesForRecord: () => shared };
  const a = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps }));
  const b = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps }));
  assert.equal(a.ok, true, a.errors.join(' | '));
  assert.equal(b.ok, true, b.errors.join(' | '));
  [a, b].forEach((r) => {
    assert.equal(new Set(r.engines).size, 27);
    assert.equal(new Set(r.engines.map((e) => e.uid)).size, 27);
    r.engines.forEach((e) => assert.ok(!shared.includes(e), 'no output is a source object'));
  });
  const first = new Set(a.engines);
  b.engines.forEach((e) => assert.ok(!first.has(e)));
  assert.deepEqual(shared, sharedBefore, 'shared source objects unchanged');
  shared.forEach((src) => ATTACHED_FIELD_NAMES.forEach((k) => assert.ok(!(k in src))));
  const rightBefore = plain(a.packs[2].engines);
  const centerBefore = plain(a.packs[0].engines);
  a.packs[1].engines.forEach((e) => { e.massFlowRate = 99; e.targetMassFlowRate = 99; });
  assert.deepEqual(a.packs[2].engines, rightBefore);
  assert.deepEqual(a.packs[0].engines, centerBefore);
  assert.deepEqual(b.packs[1].engines.map((e) => e.massFlowRate), Array(9).fill(0));
  assert.deepEqual(shared, sharedBefore);
});

check('shared mutable nested references are still rejected', () => {
  const ctx = makeContext();
  const api = ctx.AssemblyPropulsion;
  const sharedChild = { nested: true };
  rejects(api.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) {
      const e = ctx.__realBuild(rec);
      e.forEach((x) => { x.sharedRef = sharedChild; });
      return e;
    },
  } })), /shares mutable object/, 'same nested object on every engine');
  // Source engines (each with its own nested object) reused across packs: a
  // shallow clone would make the packs share those nested objects.
  const reused = ctx.__realBuild(makeFleet()[0]);
  reused.forEach((x) => { x.aux = { n: 1 }; });
  rejects(api.buildEnginePacks(input({ deps: { buildEnginesForRecord: () => reused } })), /shares mutable object/,
    'reused sources with nested objects');
  // Nested objects that are unique per engine and per call are acceptable.
  const ok = api.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) {
      const e = ctx.__realBuild(rec);
      e.forEach((x) => { x.aux = { n: 1 }; });
      return e;
    },
  } }));
  assert.equal(ok.ok, true, ok.errors.join(' | '));
  assert.equal(new Set(ok.engines.map((e) => e.aux)).size, 27);
});

check('UID collisions are rejected', () => {
  const ctx = makeContext();
  const api = ctx.AssemblyPropulsion;
  assert.deepEqual(plain(api.validateEngineUids([{ uid: 'a' }, { uid: 'b' }])), []);
  assert.ok(api.validateEngineUids([{ uid: 'a' }, { uid: 'a' }]).some((e) => /Duplicate engine uid/.test(e)));
  assert.ok(api.validateEngineUids([{ uid: '' }]).length > 0);
  assert.ok(api.validateEngineUids([{}]).length > 0);
  assert.ok(api.validateEngineUids('nope').length > 0);
  // Builder-level: a UID generator that collides cannot be injected, but a
  // pre-seeded reserved "uid" field on an engine is refused outright.
  const deps = {
    buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); e[1].uid = 'preset'; return e; },
  };
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input({ deps })), /reserved field "uid"/);
});

check('duplicate, missing and empty layout slot IDs are rejected', () => {
  let ctx = makeContext();
  ctx.__library['layout-synth-9'].frame.slots[2].id = 'E0';
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /duplicate layout slot id "E0"/);
  ctx = makeContext();
  delete ctx.__library['layout-synth-9'].frame.slots[3].id;
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /missing or empty id/);
  ctx = makeContext();
  ctx.__library['layout-synth-9'].frame.slots[3].id = '   ';
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /missing or empty id/);
  ctx = makeContext();
  ctx.__library['layout-synth-9'].frame.slots[3].id = 7;
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /missing or empty id/);
});

check('missing layout and empty / non-array slots are rejected', () => {
  let ctx = makeContext();
  delete ctx.__library['layout-synth-9'];
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /layout does not exist/);
  ctx = makeContext();
  ctx.__library['layout-synth-9'].frame.slots = [];
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /non-empty array/);
  ctx = makeContext();
  ctx.__library['layout-synth-9'].frame.slots = 'x';
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /non-empty array/);
  ctx = makeContext();
  delete ctx.__library['layout-synth-9'].frame;
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /non-empty array/);
});

check('missing or unresolved thruster configurations are rejected, never skipped', () => {
  const variants = [
    ['no thruster group', (f) => { delete f[0].engineThrusters.gimbal; }],
    ['no engineThrusters at all', (f) => { delete f[0].engineThrusters; }],
    ['unresolved thruster type', (f) => { f[0].engineThrusters.gimbal.thrusterTypeId = 'nope'; }],
  ];
  variants.forEach(([label, mutate]) => {
    const ctx = makeContext();
    const fleet = makeFleet();
    mutate(fleet);
    const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ fleet }));
    rejects(r, /expected 9 engines.*got 0/, label);
    assert.deepEqual(plain(r.packs), []);
    assert.deepEqual(plain(r.engines), []);
  });
  // Missing veVacuum entry on the thruster type -> builder silently skips every slot.
  const ctx = makeContext();
  ctx.__library['thr-synth'].parameterSchema = ctx.__library['thr-synth'].parameterSchema.filter((p) => p.key !== 'veVacuum');
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input()), /expected 9 engines/);
  // A side core with a broken thruster is rejected even when the centre is fine.
  const ctx2 = makeContext();
  const fleet = makeFleet();
  delete fleet[2].engineThrusters.gimbal;
  rejects(ctx2.AssemblyPropulsion.buildEnginePacks(input({ fleet })), /side-left/);
});

check('a builder that drops one slot or reorders slots is rejected', () => {
  const ctx = makeContext();
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); e.splice(4, 1); return e; },
  } })), /expected 9 engines.*missing slot\(s\): E135/);
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); return [e[1], e[0]].concat(e.slice(2)); },
  } })), /order does not match layout order/);
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: { buildEnginesForRecord: () => null } })), /did not return an array/);
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: { buildEnginesForRecord() { throw new Error('boom'); } } })), /threw: boom/);
});

check('invalid engine mass flow is rejected', () => {
  [NaN, 0, -5, Infinity, '250'].forEach((bad) => {
    const ctx = makeContext();
    const fleet = makeFleet();
    fleet[0].engineThrusters.gimbal.massFlowRate = bad;
    const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ fleet }));
    rejects(r, /maxMassFlowRate|Fmax/, String(bad));
    assert.equal(r.packs.length, 0);
  });
});

check('invalid exhaust velocity is rejected', () => {
  [NaN, 0, -1, Infinity].forEach((bad) => {
    const ctx = makeContext();
    ctx.__library['thr-synth'].parameterSchema.find((p) => p.key === 'veVacuum').value = bad;
    const r = ctx.AssemblyPropulsion.buildEnginePacks(input());
    rejects(r, /Ve must be|veVacuum must be/, String(bad));
  });
});

check('engine current and target flow above maxMassFlowRate are rejected', () => {
  const MAX = 250; // synthetic thruster max flow
  const above = MAX + 1e-9;
  ['massFlowRate', 'targetMassFlowRate'].forEach((field) => {
    const ctx = makeContext();
    const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
      buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); e[3][field] = above; return e; },
    } }));
    rejects(r, new RegExp(field + ' exceeds maxMassFlowRate'), field);
    assert.deepEqual(plain(r.packs), []);
    assert.deepEqual(plain(r.engines), []);
    // Also fails closed through the combined model and for a side core.
    const ctx2 = makeContext();
    const r2 = ctx2.AssemblyPropulsion.buildAssemblyPropulsionModel(input({ deps: {
      buildEnginesForRecord(rec) { const e = ctx2.__realBuild(rec); if (rec.id === 'side-rocket') e[0][field] = MAX * 2; return e; },
    } }));
    rejects(r2, new RegExp('side-left.*' + field + ' exceeds maxMassFlowRate'), field + ' side');
    assert.deepEqual(plain(r2.tanks), []);
  });
});

check('engine current and target flow exactly equal to maxMassFlowRate are accepted; idle zero stays valid', () => {
  const ctx = makeContext();
  const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) {
      const e = ctx.__realBuild(rec);
      e.forEach((x) => { x.massFlowRate = x.maxMassFlowRate; x.targetMassFlowRate = x.maxMassFlowRate; });
      return e;
    },
  } }));
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.engines.length, 27);
  r.engines.forEach((e) => { assert.equal(e.massFlowRate, 250); assert.equal(e.targetMassFlowRate, 250); });
  // Mixed: current at max, target idle (and vice versa) is also valid.
  const ctx2 = makeContext();
  const r2 = ctx2.AssemblyPropulsion.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) {
      const e = ctx2.__realBuild(rec);
      e[0].massFlowRate = e[0].maxMassFlowRate; e[0].targetMassFlowRate = 0;
      e[1].massFlowRate = 0; e[1].targetMassFlowRate = e[1].maxMassFlowRate;
      return e;
    },
  } }));
  assert.equal(r2.ok, true, r2.errors.join(' | '));
  // Unmodified builder output (zero current/target flow) is valid: no positive minimum on idle engines.
  const r3 = mustBuild(makeContext());
  r3.engines.forEach((e) => { assert.equal(e.massFlowRate, 0); assert.equal(e.targetMassFlowRate, 0); });
});

check('invalid, negative, non-finite and missing current/target flow are still rejected', () => {
  ['massFlowRate', 'targetMassFlowRate'].forEach((field) => {
    [NaN, -1, -1e-9, Infinity, -Infinity, '5', null].forEach((bad) => {
      const ctx = makeContext();
      const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
        buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); e[2][field] = bad; return e; },
      } }));
      rejects(r, new RegExp(field + ' must be a finite number >= 0'), field + '=' + String(bad));
      assert.ok(!r.errors.some((e) => /exceeds maxMassFlowRate/.test(e)), 'no spurious upper-bound error for ' + String(bad));
    });
    const ctx = makeContext();
    const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
      buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); delete e[2][field]; return e; },
    } }));
    rejects(r, new RegExp(field + ' must be a finite number >= 0'), field + ' missing');
  });
  // An invalid maxMassFlowRate is reported as such and does not produce an upper-bound comparison.
  const ctx = makeContext();
  const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) { const e = ctx.__realBuild(rec); e[0].maxMassFlowRate = 0; e[0].massFlowRate = 5; return e; },
  } }));
  rejects(r, /maxMassFlowRate must be a finite number > 0/);
  assert.ok(!r.errors.some((e) => /exceeds maxMassFlowRate \(/.test(e)));
});

check('assembly validation failure fails closed before any engine is built', () => {
  const ctx = makeContext();
  const fleet = makeFleet().filter((r) => r.id !== 'side-rocket');
  const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ fleet }));
  rejects(r, /Assembly validation failed/);
  assert.equal(ctx.__calls.build.length, 0);
  assert.deepEqual(plain(r.packs), []);
  const ctx2 = makeContext();
  rejects(ctx2.AssemblyPropulsion.buildEnginePacks(input({ deps: { validateVehicleAssembly() { throw new Error('x'); } } })), /validation threw/);
  rejects(ctx2.AssemblyPropulsion.buildEnginePacks(input({ deps: { validateVehicleAssembly: () => ({ valid: true }) } })), /validation failed|Central stack/);
});

check('inputs must be explicit: no storage or implicit-global fallback', () => {
  const ctx = makeContext();
  const api = ctx.AssemblyPropulsion;
  rejects(api.buildEnginePacks({ assembly: makeAssembly(), stacks: makeStacks() }), /fleet must be an explicit array/);
  rejects(api.buildEnginePacks({ assembly: makeAssembly(), fleet: makeFleet() }), /stacks must be an explicit array/);
  rejects(api.buildEnginePacks({ fleet: makeFleet(), stacks: makeStacks() }), /assembly must be an object/);
  rejects(api.buildEnginePacks(null), /Input must be an object/);
  // The context's loadFleet/loadStacks/localStorage all throw if touched; a
  // valid explicit build succeeds, so none was used.
  assert.equal(api.buildEnginePacks(input()).ok, true);
  assert.equal(api.buildAssemblyPropulsionModel(input()).ok, true);
});

check('injected dependencies override globals', () => {
  const ctx = makeContext();
  let used = 0;
  const r = ctx.AssemblyPropulsion.buildEnginePacks(input({ deps: {
    buildEnginesForRecord(rec) { used += 1; return ctx.__realBuild(rec); },
  } }));
  assert.equal(r.ok, true);
  assert.equal(used, 3);
  assert.equal(ctx.__calls.build.length, 0, 'global spy bypassed');
});

check('engine-pack build does not mutate assembly, fleet or stacks', () => {
  const ctx = makeContext();
  const inp = input();
  const snap = plain(inp);
  mustBuild(ctx, inp);
  assert.deepEqual(plain(inp), snap);
  const failing = input({ fleet: makeFleet().slice(0, 2) });
  const snap2 = plain(failing);
  rejects(ctx.AssemblyPropulsion.buildEnginePacks(failing));
  assert.deepEqual(plain(failing), snap2);
});

// ------------------------------------------------------------- fuel capacity
check('centre capacity uses its actual next axial member and an ephemeral record copy', () => {
  const ctx = makeContext();
  const inp = input();
  const snap = plain(inp);
  const r = ctx.AssemblyPropulsion.buildFuelCapacityDescriptors(inp);
  assert.equal(r.ok, true, r.errors.join(' | '));
  const centerCall = ctx.__calls.fuel[0];
  assert.notStrictEqual(centerCall.rec, inp.fleet[0], 'memberMaxFuel gets a copy, not the Fleet record');
  assert.deepEqual(withoutCache(centerCall.rec), inp.fleet[0], 'copy retains every required field');
  assert.equal(centerCall.rec.id, 'center-booster');
  assert.equal(centerCall.rec.synthTankKg, 100000);
  assert.strictEqual(centerCall.rec.engineThrusters, inp.fleet[0].engineThrusters, 'shallow copy');
  assert.ok('_bdmCache' in centerCall.rec, 'the production cache write landed on the copy');
  assert.ok(!('_bdmCache' in inp.fleet[0]), 'original centre record untouched');
  assert.strictEqual(centerCall.above, inp.fleet[1], 'actual next axial member passed by identity');
  assert.equal(centerCall.argc, 2);
  assert.equal(r.capacityByTankKey['center:0'], 100000 - 2000);
  assert.deepEqual(inp, snap);
  // Single-member central stack: the next member is an explicit null.
  const ctx2 = makeContext();
  const stacks = [{ id: 'central-stack', sequence: 'custom', members: ['center-booster'], payloadId: null }];
  const r2 = ctx2.AssemblyPropulsion.buildFuelCapacityDescriptors(input({ stacks }));
  assert.equal(r2.ok, true, r2.errors.join(' | '));
  assert.strictEqual(ctx2.__calls.fuel[0].above, null);
  assert.equal(r2.capacityByTankKey['center:0'], 100000);
});

check('side capacity explicitly passes null with an ephemeral record copy', () => {
  const ctx = makeContext();
  const inp = input();
  const snap = plain(inp);
  const r = ctx.AssemblyPropulsion.buildFuelCapacityDescriptors(inp);
  assert.equal(r.ok, true);
  assert.equal(ctx.__calls.fuel.length, 3);
  [1, 2].forEach((i) => {
    const c = ctx.__calls.fuel[i];
    assert.notStrictEqual(c.rec, inp.fleet[2], 'copy, not the Fleet record');
    assert.deepEqual(withoutCache(c.rec), inp.fleet[2], 'copy retains every required field');
    assert.equal(c.rec.id, 'side-rocket');
    assert.equal(c.rec.stageRole, 'rocket');
    assert.equal(c.rec.noseHeightM, 3.2);
    assert.ok('_bdmCache' in c.rec, 'cache write landed on the copy');
    assert.equal(c.argc, 2, 'second argument supplied explicitly (not omitted)');
    assert.strictEqual(c.above, null, 'null, never undefined');
  });
  assert.notStrictEqual(ctx.__calls.fuel[1].rec, ctx.__calls.fuel[2].rec, 'each side gets its own copy');
  assert.ok(!('_bdmCache' in inp.fleet[2]), 'original side record untouched');
  assert.deepEqual(inp, snap);
  assert.equal(r.capacityByTankKey['side-left:0'], 80000);
  assert.equal(r.capacityByTankKey['side-right:0'], 80000);
  assert.deepEqual(r.tanks.map((t) => t.tankKey), ['center:0', 'side-left:0', 'side-right:0']);
  assert.deepEqual(r.tanks.map((t) => t.coreInstanceId), ['center', 'side-left', 'side-right']);
});

check('no public builder leaves a _bdmCache (or any change) on the caller Fleet records', () => {
  ['buildFuelCapacityDescriptors', 'buildAssemblyPropulsionModel', 'buildEnginePacks'].forEach((fn) => {
    const ctx = makeContext();
    const inp = input();
    const snap = plain(inp);
    const r = ctx.AssemblyPropulsion[fn](inp);
    assert.equal(r.ok, true, fn + ': ' + r.errors.join(' | '));
    inp.fleet.forEach((rec) => assert.ok(!('_bdmCache' in rec), fn + ': ' + rec.id));
    assert.deepEqual(inp, snap, fn);
    if (fn !== 'buildEnginePacks') assert.ok(ctx.__calls.fuel.every((c) => '_bdmCache' in c.rec), 'side effect reproduced on copies');
  });
});

check('invalid, non-finite or non-positive capacities are rejected', () => {
  [NaN, Infinity, -Infinity, 0, -10, undefined, null, '5'].forEach((bad) => {
    const ctx = makeContext();
    const r = ctx.AssemblyPropulsion.buildFuelCapacityDescriptors(input({ deps: { memberMaxFuel: () => bad } }));
    rejects(r, /fuel capacity must be a finite number > 0/, String(bad));
    assert.deepEqual(plain(r.tanks), []);
  });
  const ctx = makeContext();
  rejects(ctx.AssemblyPropulsion.buildFuelCapacityDescriptors(input({ deps: { memberMaxFuel() { throw new Error('q'); } } })), /memberMaxFuel threw/);
  const side0 = (rec) => (rec.id === 'side-rocket' ? 0 : 5);
  const r = ctx.AssemblyPropulsion.buildFuelCapacityDescriptors(input({ deps: { memberMaxFuel: side0 } }));
  rejects(r, /side-left/);
});

check('capacity model keeps fleet records unmodified and descriptors immutable', () => {
  const ctx = makeContext();
  const inp = input();
  const snap = plain(inp);
  const r = model(ctx, inp);
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.deepEqual(plain(inp), snap);
  inp.fleet.forEach((rec) => assert.ok(!('_bdmCache' in rec), rec.id + ' has no _bdmCache'));
  assert.ok(r.tanks.every((t) => Object.isFrozen(t)));
  assert.ok(!('memberFuel' in inp.fleet[2]), 'no side fuel stored on the fleet record');
  assert.equal(r.engines.length, 27);
});

// Reproduces the PRODUCTION write pattern of boosterDerivedMasses(): it READS
// rec._bdmCache.key, and on a miss MUTATES the existing cache object in place
// (rec._bdmCache.key = ...; rec._bdmCache.value = ...) rather than replacing it.
function productionLikeMemberMaxFuel(log) {
  return function memberMaxFuel(rec, above) {
    const key = 'k|' + (above ? above.id : '-');
    log.push({ rec, above, argc: arguments.length, cacheObj: rec._bdmCache, keyOnEntry: rec._bdmCache && rec._bdmCache.key });
    if (rec._bdmCache && rec._bdmCache.key === key) return rec._bdmCache.value.fuelMass; // cache hit
    const fuel = (rec.synthTankKg || 0) - ((above && above.synthAboveDeductKg) || 0);
    if (!rec._bdmCache) rec._bdmCache = {};
    rec._bdmCache.key = key;
    rec._bdmCache.value = { fuelMass: fuel };
    return fuel;
  };
}
function seedCaches(fleet, key, fuelFor) {
  const seeded = {};
  [0, 2].forEach((i) => {
    const cache = { key, value: { fuelMass: fuelFor(i) } };
    fleet[i]._bdmCache = cache;
    seeded[i] = { cache, value: cache.value, key, fuel: cache.value.fuelMass };
  });
  return seeded;
}
function assertSeededUntouched(fleet, seeded, label) {
  [0, 2].forEach((i) => {
    const s0 = seeded[i];
    assert.strictEqual(fleet[i]._bdmCache, s0.cache, label + ': cache object identity kept (' + fleet[i].id + ')');
    assert.equal(fleet[i]._bdmCache.key, s0.key, label + ': cache key unchanged (' + fleet[i].id + ')');
    assert.strictEqual(fleet[i]._bdmCache.value, s0.value, label + ': cache value identity unchanged (' + fleet[i].id + ')');
    assert.equal(fleet[i]._bdmCache.value.fuelMass, s0.fuel, label + ': cache value content unchanged (' + fleet[i].id + ')');
    assert.deepEqual(Object.keys(fleet[i]._bdmCache), ['key', 'value'], label + ': no extra cache fields');
  });
}

check('cache miss: a pre-existing nested _bdmCache is detached; original cache object is never mutated', () => {
  ['buildFuelCapacityDescriptors', 'buildAssemblyPropulsionModel'].forEach((fn) => {
    const ctx = makeContext();
    const inp = input();
    const seeded = seedCaches(inp.fleet, 'stale-key-that-never-matches', () => -1);
    const log = [];
    const r = ctx.AssemblyPropulsion[fn](input({ ...inp, deps: { memberMaxFuel: productionLikeMemberMaxFuel(log) } }));
    assert.equal(r.ok, true, fn + ': ' + r.errors.join(' | '));
    assert.equal(log.length, 3, fn);
    // The in-place production-style write happened on the COPY's own cache object.
    log.forEach((c, i) => {
      const orig = i === 0 ? inp.fleet[0] : inp.fleet[2];
      assert.notStrictEqual(c.rec, orig, fn + ': record is a copy');
      assert.notStrictEqual(c.cacheObj, orig._bdmCache, fn + ': copy received an independent _bdmCache object');
      assert.strictEqual(c.rec._bdmCache, c.cacheObj, fn + ': the same (copied) container was mutated in place');
      assert.equal(c.keyOnEntry, 'stale-key-that-never-matches', fn + ': existing key preserved on the copy');
      assert.ok(c.rec._bdmCache.key.startsWith('k|'), fn + ': miss rewrote .key on the copy');
      assert.notStrictEqual(c.rec._bdmCache.value, orig._bdmCache.value, fn + ': miss replaced .value on the copy only');
    });
    assert.notStrictEqual(log[1].cacheObj, log[2].cacheObj, fn + ': left and right side copies do not share a cache object');
    // Original centre and side Fleet records are completely unchanged.
    assertSeededUntouched(inp.fleet, seeded, fn);
    // Correct values and real argument semantics (centre: actual next member; sides: literal null).
    assert.strictEqual(log[0].above, inp.fleet[1], fn + ': centre gets its actual next axial member');
    assert.equal(log[0].argc, 2);
    [1, 2].forEach((i) => { assert.strictEqual(log[i].above, null, fn + ': side gets literal null'); assert.equal(log[i].argc, 2); });
    assert.deepEqual(r.capacityByTankKey, { 'center:0': 98000, 'side-left:0': 80000, 'side-right:0': 80000 }, fn);
  });
});

check('cache miss with FROZEN original cache objects still works (no write can reach them)', () => {
  const ctx = makeContext();
  const inp = input();
  const seeded = seedCaches(inp.fleet, 'stale', () => -1);
  [0, 2].forEach((i) => { Object.freeze(inp.fleet[i]._bdmCache); Object.freeze(inp.fleet[i]._bdmCache.value); });
  const log = [];
  const r = ctx.AssemblyPropulsion.buildFuelCapacityDescriptors({ ...inp, deps: { memberMaxFuel: productionLikeMemberMaxFuel(log) } });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.ok(log.every((c) => !Object.isFrozen(c.rec._bdmCache)), 'copied cache container is mutable');
  assertSeededUntouched(inp.fleet, seeded, 'frozen');
});

check('cache hit: the copy keeps key/value so the hit is used, and the original is still untouched', () => {
  ['buildFuelCapacityDescriptors', 'buildAssemblyPropulsionModel'].forEach((fn) => {
    const ctx = makeContext();
    const inp = input();
    // Centre key matches what the synthetic computes for (centre, next = upper-stage); sides for (side, null).
    inp.fleet[0]._bdmCache = { key: 'k|upper-stage', value: { fuelMass: 11111 } };
    inp.fleet[2]._bdmCache = { key: 'k|-', value: { fuelMass: 22222 } };
    const seeded = { 0: { cache: inp.fleet[0]._bdmCache, value: inp.fleet[0]._bdmCache.value, key: 'k|upper-stage', fuel: 11111 },
      2: { cache: inp.fleet[2]._bdmCache, value: inp.fleet[2]._bdmCache.value, key: 'k|-', fuel: 22222 } };
    const log = [];
    const r = ctx.AssemblyPropulsion[fn]({ ...inp, deps: { memberMaxFuel: productionLikeMemberMaxFuel(log) } });
    assert.equal(r.ok, true, fn + ': ' + r.errors.join(' | '));
    assert.deepEqual(r.capacityByTankKey, { 'center:0': 11111, 'side-left:0': 22222, 'side-right:0': 22222 },
      fn + ': cached values were served (cache preserved on the copy)');
    log.forEach((c) => {
      assert.ok(c.cacheObj && c.keyOnEntry, fn + ': copy arrived with the existing cache key');
    });
    assertSeededUntouched(inp.fleet, seeded, fn);
    assert.notStrictEqual(log[0].cacheObj, inp.fleet[0]._bdmCache, fn + ': even a hit uses an independent container');
  });
});

check('record copy is shallow apart from the cache container; non-object caches are left alone', () => {
  const ctx = makeContext();
  const inp = input();
  inp.fleet[0]._bdmCache = { key: 'x', value: { fuelMass: 1 } };
  const log = [];
  const r = ctx.AssemblyPropulsion.buildFuelCapacityDescriptors({ ...inp, deps: { memberMaxFuel: productionLikeMemberMaxFuel(log) } });
  assert.equal(r.ok, true, r.errors.join(' | '));
  const copy = log[0].rec;
  ['engineThrusters', 'params'].forEach((k) => assert.strictEqual(copy[k], inp.fleet[0][k], k + ' is shared, not deep-cloned'));
  assert.strictEqual(log[1].rec.engineThrusters, inp.fleet[2].engineThrusters);
  // Non-object _bdmCache values (null / string / array) are passed through as-is, without throwing.
  [null, 'oops', [1, 2]].forEach((weird) => {
    const ctx2 = makeContext();
    const inp2 = input();
    inp2.fleet[2]._bdmCache = weird;
    const seen = [];
    const r2 = ctx2.AssemblyPropulsion.buildFuelCapacityDescriptors({ ...inp2, deps: { memberMaxFuel(rec, above) { seen.push(rec._bdmCache); return 5; } } });
    assert.equal(r2.ok, true, r2.errors.join(' | '));
    assert.strictEqual(seen[1], weird);
    assert.strictEqual(inp2.fleet[2]._bdmCache, weird);
  });
});

check('engine-pack build also leaves seeded _bdmCache objects untouched', () => {
  const ctx = makeContext();
  const inp = input();
  const seeded = seedCaches(inp.fleet, 'stale', () => -1);
  const r = ctx.AssemblyPropulsion.buildEnginePacks(inp);
  assert.equal(r.ok, true, r.errors.join(' | '));
  assertSeededUntouched(inp.fleet, seeded, 'buildEnginePacks');
});

// ------------------------------------------------------------- fuel totals
check('central and side fuel are kept separate; the total is a separate sum', () => {
  const ctx = makeContext();
  const central = [90000, 7000];
  const t = ctx.AssemblyPropulsion.computeHeavyFuelTotals({ centralMemberFuel: central, sideLeftFuel: 40000, sideRightFuel: 35000 });
  assert.equal(t.ok, true);
  assert.equal(t.center, 97000);
  assert.equal(t.left, 40000);
  assert.equal(t.right, 35000);
  assert.equal(t.side, 75000);
  assert.equal(t.total, 172000);
});

check('total displayed fuel does not mutate or replace central member fuel', () => {
  const ctx = makeContext();
  const central = [90000, 7000];
  const body = { fuelMass: 97000, memberFuel: central };
  const input1 = { centralMemberFuel: central, sideLeftFuel: 1, sideRightFuel: 2 };
  const snap = plain({ body, input1 });
  const t = ctx.AssemblyPropulsion.computeHeavyFuelTotals(deepFreeze({ centralMemberFuel: central.slice(), sideLeftFuel: 1, sideRightFuel: 2 }));
  assert.equal(t.total, 97003);
  ctx.AssemblyPropulsion.computeHeavyFuelTotals(input1);
  assert.deepEqual(plain({ body, input1 }), snap);
  assert.equal(body.fuelMass, 97000, 'body.fuelMass is never assigned the Heavy total');
  assert.strictEqual(body.memberFuel, central);
  assert.equal(central.length, 2, 'side fuel is not appended to the central memberFuel[]');
});

check('fuel totals fail closed on invalid values', () => {
  const ctx = makeContext();
  const f = ctx.AssemblyPropulsion.computeHeavyFuelTotals;
  const good = { centralMemberFuel: [1, 2], sideLeftFuel: 3, sideRightFuel: 4 };
  assert.equal(f(good).ok, true);
  [NaN, -1, Infinity, '3', null, undefined].forEach((bad) => {
    rejects(f({ ...good, sideLeftFuel: bad }), /sideLeftFuel/, String(bad));
    rejects(f({ ...good, sideRightFuel: bad }), /sideRightFuel/, String(bad));
    rejects(f({ ...good, centralMemberFuel: [1, bad] }), /centralMemberFuel\[1\]/, String(bad));
  });
  rejects(f({ ...good, centralMemberFuel: [] }), /non-empty array/);
  rejects(f({ ...good, centralMemberFuel: 5 }), /non-empty array/);
  rejects(f(null), /Input must be an object/);
  rejects(f({ centralMemberFuel: [Number.MAX_VALUE, Number.MAX_VALUE], sideLeftFuel: 0, sideRightFuel: 0 }), /not finite/);
  assert.equal(f({ centralMemberFuel: [0], sideLeftFuel: 0, sideRightFuel: 0 }).total, 0);
});

// ------------------------------------------------------------- planner
check('left-side fuel debit does not affect centre or right fuel', () => {
  const ctx = makeContext();
  const p = ctx.AssemblyPropulsion.planFuelStarvation(planInput({
    engines: [
      { uid: 'c1', tankKey: 'center:0', massFlowRate: 0 },
      { uid: 'l1', tankKey: 'side-left:0', massFlowRate: 200 },
      { uid: 'r1', tankKey: 'side-right:0', massFlowRate: 0 },
    ],
  }));
  assert.equal(p.ok, true, p.errors.join(' | '));
  assert.equal(p.fuelDebitByTankKey['side-left:0'], 20);
  assert.equal(p.remainingFuelByTankKey['side-left:0'], 980);
  assert.equal(p.fuelDebitByTankKey['center:0'], 0);
  assert.equal(p.fuelDebitByTankKey['side-right:0'], 0);
  assert.equal(p.remainingFuelByTankKey['center:0'], 1000);
  assert.equal(p.remainingFuelByTankKey['side-right:0'], 1000);
});

check('right-side fuel debit does not affect centre or left fuel', () => {
  const ctx = makeContext();
  const p = ctx.AssemblyPropulsion.planFuelStarvation(planInput({
    engines: [
      { uid: 'c1', tankKey: 'center:0', massFlowRate: 0 },
      { uid: 'l1', tankKey: 'side-left:0', massFlowRate: 0 },
      { uid: 'r1', tankKey: 'side-right:0', massFlowRate: 300 },
    ],
  }));
  assert.equal(p.ok, true, p.errors.join(' | '));
  assert.equal(p.fuelDebitByTankKey['side-right:0'], 300 * 0.1);
  assert.equal(p.remainingFuelByTankKey['side-right:0'], 1000 - 300 * 0.1);
  assert.equal(p.fuelDebitByTankKey['center:0'], 0);
  assert.equal(p.fuelDebitByTankKey['side-left:0'], 0);
  assert.equal(p.remainingFuelByTankKey['center:0'], 1000);
  assert.equal(p.remainingFuelByTankKey['side-left:0'], 1000);
});

check('central RCS demand is charged to center:0 only', () => {
  const ctx = makeContext();
  const p = ctx.AssemblyPropulsion.planFuelStarvation(planInput({
    engines: [
      { uid: 'c1', tankKey: 'center:0', massFlowRate: 0 },
      { uid: 'l1', tankKey: 'side-left:0', massFlowRate: 0 },
      { uid: 'r1', tankKey: 'side-right:0', massFlowRate: 0 },
    ],
    rcsMassFlowDemand: 5,
  }));
  assert.equal(p.ok, true);
  assert.equal(p.fuelDebitByTankKey['center:0'], 0.5);
  assert.equal(p.fuelDebitByTankKey['side-left:0'], 0);
  assert.equal(p.fuelDebitByTankKey['side-right:0'], 0);
  assert.equal(p.demandByTankKey['center:0'], 5);
  assert.equal(p.demandByTankKey['side-left:0'], 0);
  assert.equal(p.mainDemandByTankKey['center:0'], 0);
  assert.equal(p.rcsScale, 1);
  assert.equal(p.rcsDeliveredMassFlow, 5);
  // Combined with main-engine demand on the same tank.
  const q = ctx.AssemblyPropulsion.planFuelStarvation(planInput({ rcsMassFlowDemand: 10 }));
  assert.equal(q.demandByTankKey['center:0'], 210);
  assert.equal(q.demandByTankKey['side-left:0'], 100);
  assert.equal(q.demandByTankKey['side-right:0'], 100);
});

check('empty tank produces zero permitted delivery', () => {
  const ctx = makeContext();
  const p = ctx.AssemblyPropulsion.planFuelStarvation(planInput({
    fuelByTankKey: { 'center:0': 0, 'side-left:0': 1000, 'side-right:0': 0 },
    rcsMassFlowDemand: 4,
  }));
  assert.equal(p.ok, true);
  assert.equal(p.scaleByTankKey['center:0'], 0);
  assert.equal(p.scaleByEngineUid.c1, 0);
  assert.equal(p.deliveredMassFlowByEngineUid.c1, 0);
  assert.equal(p.deliveredMassFlowByEngineUid.c2, 0);
  assert.equal(p.deliveredMassFlowByEngineUid.r1, 0);
  assert.equal(p.deliveredMassFlowByEngineUid.l1, 100, 'non-empty left tank still delivers');
  assert.equal(p.rcsScale, 0);
  assert.equal(p.rcsDeliveredMassFlow, 0);
  assert.equal(p.fuelDebitByTankKey['center:0'], 0);
  assert.equal(p.remainingFuelByTankKey['center:0'], 0);
  assert.deepEqual(plain(p.starvedTankKeys), ['center:0', 'side-right:0']);
});

check('final-timestep demand above available fuel never over-debits', () => {
  const ctx = makeContext();
  // demand 200 kg/s * 0.1 s = 20 kg requested, only 5 kg available
  const p = ctx.AssemblyPropulsion.planFuelStarvation(planInput({
    fuelByTankKey: { 'center:0': 5, 'side-left:0': 1000, 'side-right:0': 1000 },
  }));
  assert.equal(p.ok, true);
  assert.equal(p.scaleByTankKey['center:0'], 5 / 20);
  assert.equal(p.fuelDebitByTankKey['center:0'], 5);
  assert.equal(p.remainingFuelByTankKey['center:0'], 0);
  assert.equal(p.scaleByEngineUid.c1, 0.25);
  assert.equal(p.deliveredMassFlowByEngineUid.c1, 25);
  assert.deepEqual(plain(p.starvedTankKeys), ['center:0']);
  assert.equal(p.scaleByTankKey['side-left:0'], 1);
  // Exactly enough fuel is not starvation.
  const e = ctx.AssemblyPropulsion.planFuelStarvation(planInput({
    fuelByTankKey: { 'center:0': 20, 'side-left:0': 10, 'side-right:0': 10 },
  }));
  assert.equal(e.scaleByTankKey['center:0'], 1);
  assert.equal(e.remainingFuelByTankKey['center:0'], 0);
  assert.deepEqual(plain(e.starvedTankKeys), []);
});

check('scale formula: demand 0 gives 1 even from an empty tank; fuzz never over-debits', () => {
  const ctx = makeContext();
  const z = ctx.AssemblyPropulsion.planFuelStarvation({
    engines: [{ uid: 'c1', tankKey: 'center:0', massFlowRate: 0 }],
    fuelByTankKey: { 'center:0': 0 },
    rcsMassFlowDemand: 0,
    dt: 0.05,
  });
  assert.equal(z.scaleByTankKey['center:0'], 1);
  assert.equal(z.deliveredMassFlowByEngineUid.c1, 0);
  assert.deepEqual(plain(z.starvedTankKeys), []);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 2000; i += 1) {
    const fuel = { 'center:0': rnd() * 50, 'side-left:0': rnd() * 50, 'side-right:0': rnd() < 0.2 ? 0 : rnd() * 50 };
    const engines = [];
    ['center:0', 'side-left:0', 'side-right:0'].forEach((tk) => {
      for (let j = 0; j < 3; j += 1) engines.push({ uid: tk + '#' + j, tankKey: tk, massFlowRate: rnd() * 150 });
    });
    const dt = 0.001 + rnd() * 0.2;
    const p = ctx.AssemblyPropulsion.planFuelStarvation({ engines, fuelByTankKey: fuel, rcsMassFlowDemand: rnd() * 10, dt });
    assert.equal(p.ok, true);
    Object.keys(fuel).forEach((tk) => {
      assert.ok(p.fuelDebitByTankKey[tk] <= fuel[tk], 'debit <= available');
      assert.ok(p.remainingFuelByTankKey[tk] >= 0, 'remaining >= 0');
      assert.ok(p.scaleByTankKey[tk] >= 0 && p.scaleByTankKey[tk] <= 1);
      const delivered = engines.filter((e) => e.tankKey === tk).reduce((s, e) => s + p.deliveredMassFlowByEngineUid[e.uid], 0) * dt;
      assert.ok(delivered <= fuel[tk] * (1 + 1e-12) + 1e-12, 'delivered fuel within available');
      if (fuel[tk] === 0) assert.equal(p.scaleByTankKey[tk], 0);
    });
  }
});

check('planner leaves its inputs unchanged after successful and unsuccessful calls', () => {
  const ctx = makeContext();
  const good = planInput();
  const snap = plain(good);
  const p = ctx.AssemblyPropulsion.planFuelStarvation(good);
  assert.equal(p.ok, true);
  assert.deepEqual(plain(good), snap);
  p.fuelDebitByTankKey['center:0'] = -1;
  p.scaleByEngineUid.c1 = 7;
  assert.deepEqual(plain(good), snap, 'mutating the result does not touch inputs');
  const bad = planInput({ dt: NaN });
  const badSnap = plain({ ...bad, dt: 'NaN' });
  rejects(ctx.AssemblyPropulsion.planFuelStarvation(bad));
  assert.deepEqual(plain({ ...bad, dt: 'NaN' }), badSnap);
  // Fully frozen inputs work (proves there are no writes).
  const frozen = deepFreeze(planInput({ rcsMassFlowDemand: 3 }));
  assert.equal(ctx.AssemblyPropulsion.planFuelStarvation(frozen).ok, true);
  const real = mustBuild(ctx).engines;
  const realSnap = plain(real);
  const fuel = { 'center:0': 1000, 'side-left:0': 1000, 'side-right:0': 1000 };
  real.forEach((e) => { e.massFlowRate = e.maxMassFlowRate; });
  const realSnap2 = plain(real);
  const rp = ctx.AssemblyPropulsion.planFuelStarvation({ engines: real, fuelByTankKey: fuel, rcsMassFlowDemand: 1, dt: 0.1 });
  assert.equal(rp.ok, true);
  assert.deepEqual(plain(real), realSnap2);
  assert.notDeepEqual(realSnap, realSnap2);
  assert.deepEqual(fuel, { 'center:0': 1000, 'side-left:0': 1000, 'side-right:0': 1000 });
});

check('invalid timestep fails closed', () => {
  const ctx = makeContext();
  [0, -0.1, NaN, Infinity, -Infinity, '0.1', null, undefined].forEach((dt) => {
    const r = ctx.AssemblyPropulsion.planFuelStarvation(planInput({ dt }));
    rejects(r, /dt must be/, String(dt));
    assert.ok(!('scaleByTankKey' in r), 'no usable plan returned');
  });
});

check('invalid fuel, RCS demand and engine data fail closed', () => {
  const ctx = makeContext();
  const plan = (o) => ctx.AssemblyPropulsion.planFuelStarvation(planInput(o));
  [-1, NaN, Infinity, '5', null, undefined].forEach((bad) => {
    rejects(plan({ fuelByTankKey: { 'center:0': bad, 'side-left:0': 1, 'side-right:0': 1 } }), /Fuel for center:0/, String(bad));
    rejects(plan({ rcsMassFlowDemand: bad }), /rcsMassFlowDemand/, String(bad));
  });
  rejects(plan({ fuelByTankKey: { 'center:0': 1, 'side-left:0': 1 } }), /no fuel entry/);
  rejects(plan({ fuelByTankKey: { 'side-left:0': 1, 'side-right:0': 1 } }), /include "center:0"/);
  rejects(plan({ fuelByTankKey: null }), /fuelByTankKey must be an object/);
  rejects(plan({ fuelByTankKey: [1, 2, 3] }), /fuelByTankKey must be an object/);
  rejects(plan({ fuelByTankKey: { 'center:0': 1, 'side-left:0': 1, 'side-right:0': 1, bogus: 1 } }), /Invalid tank key/);
  rejects(plan({ engines: [] }), /non-empty array/);
  rejects(plan({ engines: null }), /non-empty array/);
  const dup = planInput().engines;
  dup[1].uid = 'c1';
  rejects(plan({ engines: dup }), /Duplicate engine uid/);
  [-1, NaN, Infinity, '1', undefined].forEach((bad) => {
    const e = planInput().engines;
    e[0].massFlowRate = bad;
    rejects(plan({ engines: e }), /massFlowRate/, String(bad));
  });
  const noTank = planInput().engines;
  delete noTank[2].tankKey;
  rejects(plan({ engines: noTank }), /invalid tankKey/);
  const noUid = planInput().engines;
  delete noUid[0].uid;
  rejects(plan({ engines: noUid }), /no valid uid/);
  rejects(plan({ engines: [{ uid: '__proto__', tankKey: 'center:0', massFlowRate: 1 }] }), /no valid uid/);
  rejects(ctx.AssemblyPropulsion.planFuelStarvation(null), /Input must be an object/);
  rejects(plan({ engines: [{ uid: 'c1', tankKey: 'center:0', massFlowRate: Number.MAX_VALUE }], rcsMassFlowDemand: Number.MAX_VALUE,
    fuelByTankKey: { 'center:0': 1 }, dt: 10 }), /not finite/);
});

check('planner rejects unknown tank keys in fuelByTankKey', () => {
  const ctx = makeContext();
  const good = { 'center:0': 1000, 'side-left:0': 1000, 'side-right:0': 1000 };
  ['foo:0', 'center:1', 'side-left:1', 'center:00', 'Center:0', 'side-top:0', 'center:0 ', 'side-right:'].forEach((bad) => {
    const r = ctx.AssemblyPropulsion.planFuelStarvation(planInput({ fuelByTankKey: { ...good, [bad]: 5 } }));
    rejects(r, /Invalid tank key/, JSON.stringify(bad));
    assert.ok(!('scaleByTankKey' in r));
  });
  assert.equal(ctx.AssemblyPropulsion.planFuelStarvation(planInput({ fuelByTankKey: good })).ok, true);
});

check('planner rejects unknown engine tankKey even when a matching fuel entry exists', () => {
  const ctx = makeContext();
  const withFoo = { 'center:0': 1000, 'side-left:0': 1000, 'side-right:0': 1000, 'foo:0': 1000 };
  const engines = planInput().engines;
  engines[2].tankKey = 'foo:0';
  const r = ctx.AssemblyPropulsion.planFuelStarvation(planInput({ engines, fuelByTankKey: withFoo }));
  rejects(r, /Engine l1 has an invalid tankKey/);
  assert.ok(r.errors.some((e) => /Invalid tank key: "foo:0"/.test(e)), 'the fuel entry is rejected too');
  // Without a matching fuel entry the engine key is still reported as invalid (not merely "no fuel entry").
  const r2 = ctx.AssemblyPropulsion.planFuelStarvation(planInput({ engines }));
  rejects(r2, /Engine l1 has an invalid tankKey/);
  assert.ok(!r2.errors.some((e) => /no fuel entry/.test(e)));
  ['Side-Left:0', 'side-left:1', 'side-left', '', null, 7].forEach((bad) => {
    const e = planInput().engines;
    e[2].tankKey = bad;
    rejects(ctx.AssemblyPropulsion.planFuelStarvation(planInput({ engines: e })), /invalid tankKey/, String(bad));
  });
});

check('independent tanks drain independently over multiple steps (model + planner)', () => {
  const ctx = makeContext();
  const m = model(ctx);
  assert.equal(m.ok, true, m.errors.join(' | '));
  const fuel = {
    'center:0': m.capacityByTankKey['center:0'],
    'side-left:0': 5, // nearly empty left core
    'side-right:0': m.capacityByTankKey['side-right:0'],
  };
  m.engines.forEach((e) => { e.massFlowRate = 100; });
  const perCore = 900; // nine synthetic engines at 100 kg/s each
  let cur = fuel;
  for (let step = 0; step < 3; step += 1) {
    const p = ctx.AssemblyPropulsion.planFuelStarvation({ engines: m.engines, fuelByTankKey: cur, rcsMassFlowDemand: 2, dt: 0.1 });
    assert.equal(p.ok, true, p.errors.join(' | '));
    assert.equal(p.demandByTankKey['side-left:0'], perCore);
    assert.equal(p.demandByTankKey['center:0'], perCore + 2);
    assert.equal(p.demandByTankKey['side-right:0'], perCore);
    if (step === 0) {
      assert.equal(p.scaleByTankKey['side-left:0'], 5 / 90);
      assert.equal(p.remainingFuelByTankKey['side-left:0'], 0);
      assert.deepEqual(plain(p.starvedTankKeys), ['side-left:0']);
    } else {
      assert.equal(p.scaleByTankKey['side-left:0'], 0);
    }
    assert.equal(p.scaleByTankKey['center:0'], 1);
    assert.equal(p.scaleByTankKey['side-right:0'], 1);
    cur = p.remainingFuelByTankKey;
  }
  assert.equal(cur['side-left:0'], 0);
  assert.ok(cur['center:0'] < fuel['center:0'] && cur['center:0'] > 0);
});

// ------------------------------------------------------------- isolation / Falcon 9
check('Falcon 9 buildEnginesForRecord is untouched: ids, count, order and function identity', () => {
  const ctx = makeContext();
  const before = ctx.__realBuild.toString();
  assert.equal(typeof ctx.__realBuild, 'function');
  assert.equal((vehicleSource.match(/function buildEnginesForRecord\(rec\)/g) || []).length, 1);
  // Build Heavy packs (which call the function three times), then check it again.
  mustBuild(ctx);
  assert.equal(ctx.__realBuild.toString(), before);
  const f9 = ctx.__realBuild(makeFleet()[0]);
  assert.equal(f9.length, 9);
  assert.deepEqual(f9.map((e) => e.id), SLOT_IDS);
  f9.forEach((e) => ATTACHED_FIELD_NAMES.forEach((k) => assert.ok(!(k in e), 'plain F9 engine has no ' + k)));
  assert.equal(f9[0].isCenter, true);
  assert.equal(f9.filter((e) => e.isCenter).length, 1);
  assert.equal(f9[0].Ve, 3000);
  assert.equal(f9[0].Fmax, 250 * 3000);
  // The module never reassigns or wraps the function itself.
  const stripped = stripComments(propulsionSource);
  assert.ok(!/\bbuildEnginesForRecord\s*=[^=]/.test(stripped), 'module does not assign buildEnginesForRecord');
  assert.ok(!/root\.buildEnginesForRecord\s*=/.test(stripped));
  // Engine order from an ordinary single-record call equals the pack's order.
  assert.deepEqual(plain(f9.map((e) => e.id)), plain(mustBuild(ctx).packs[0].engines.map((e) => e.id)));
});

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

check('module is isolated: no storage, worker, state.bodies, physics or fuelMass writes', () => {
  const code = stripComments(propulsionSource);
  [
    /state\.bodies/, /localStorage/, /sessionStorage/, /postMessage/, /\bloadFleet\b/, /\bloadStacks\b/,
    /\bloadVehicleAssemblies\b/, /SIM_STACK_MEMBERS/, /getActiveStack/, /\bfuelMass\b/, /setCoreFuel/,
    /\bself\b/, /\bwindow\b/, /\bdocument\b/, /require\(/, /\bimport\b/, /physics/i,
  ].forEach((re) => assert.ok(!re.test(code), 'module must not reference ' + re));
  assert.ok(/root\.AssemblyPropulsion\s*=\s*Object\.freeze/.test(code));
  // memberMaxFuel side calls pass a literal null, never an omitted argument.
  assert.ok(/memberMaxFuel\(copyRecordForCapacity\(core\.record\),\s*null\)/.test(code));
  assert.ok(/memberMaxFuel\(copyRecordForCapacity\(core\.record\),\s*core\.nextRecord\)/.test(code));
  assert.ok(!/memberMaxFuel\(core\.record/.test(code), 'the Fleet record itself is never passed');
  assert.ok(!/memberMaxFuel\(\{\s*\.\.\./.test(code), 'a bare shallow spread (shared _bdmCache) is never passed');
});

check('loading the module defines only AssemblyPropulsion and leaves other globals alone', () => {
  const probe = vm.createContext({});
  vm.runInContext(propulsionSource, probe, { filename: propulsionPath });
  assert.deepEqual(Object.keys(probe), ['AssemblyPropulsion']);
  assert.ok(Object.isFrozen(probe.AssemblyPropulsion));
  // Without the external dependencies the model fails closed instead of guessing.
  const r = probe.AssemblyPropulsion.buildEnginePacks({ assembly: makeAssembly(), fleet: makeFleet(), stacks: makeStacks() });
  rejects(r, /Required dependency "validateVehicleAssembly" is unavailable/);
});

process.stdout.write(`ALL PASS (${passed} tests)\n`);
