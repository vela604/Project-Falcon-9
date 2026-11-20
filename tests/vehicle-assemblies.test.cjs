// Standalone regression tests for the assembly-definition layer.
// Run from the repository root: node tests/vehicle-assemblies.test.cjs
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const storage = new Map();
const fleet = [
  { id: 'center-booster', stageRole: 'booster', height: 41, width: 3.7, dryMass: 25000 },
  { id: 'side-booster', stageRole: 'booster', height: 41, width: 3.7, dryMass: 25000 },
  { id: 'upper-stage', stageRole: 'stage', height: 13, width: 3.7, dryMass: 4000 },
  { id: 'not-a-booster', stageRole: 'stage', height: 13, width: 3.7, dryMass: 4000 },
];
const stacks = [
  { id: 'central-stack', sequence: 'custom', members: ['center-booster', 'upper-stage'], payloadId: null },
];

// Test double for the production validateStack(); the real one is not loaded
// here (see the report: fleet.js cannot be exercised in isolation reliably).
function stubValidateStack(members, records) {
  const resolved = members.map((id) => records.find((record) => record.id === id));
  const valid = resolved.length > 0 && resolved.every(Boolean);
  return {
    valid,
    errors: valid ? [] : ['one or more members are missing'],
    stackTotalHeight: valid ? resolved.reduce((sum, record) => sum + record.height, 0) : 0,
    stackTotalMass: valid ? resolved.reduce((sum, record) => sum + record.dryMass, 0) : 0,
  };
}

const sourcePath = path.join(__dirname, '..', 'js', 'vehicleAssemblies.js');
const assemblySource = fs.readFileSync(sourcePath, 'utf8');

// Builds a brand-new VM context and evaluates vehicleAssemblies.js in it from
// scratch, backed by the supplied storage Map. Every call gets its own module
// scope (and therefore its own _vehicleAssembliesCache).
function makeContext(storageMap, overrides) {
  const ctx = {
    localStorage: {
      getItem(key) { return storageMap.has(key) ? storageMap.get(key) : null; },
      setItem(key, value) { storageMap.set(key, String(value)); },
    },
    loadFleet() { return fleet; },
    loadStacks() { return stacks; },
    validateStack: stubValidateStack,
    ...(overrides || {}),
  };
  vm.createContext(ctx);
  vm.runInContext(assemblySource, ctx, { filename: sourcePath });
  return ctx;
}

// Objects from another VM context have a different Object.prototype, so strict
// deepEqual would fail on prototype alone. Compare plain JSON copies instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

const context = makeContext(storage);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write('PASS ' + name + '\n');
}

const definition = {
  name: 'Falcon Heavy Test Assembly',
  centralStackId: 'central-stack',
  sideCores: [
    { slotId: 'left', recordId: 'side-booster' },
    { slotId: 'right', recordId: 'side-booster' },
  ],
};

check('creates and persists a triple-core assembly', () => {
  const assembly = context.addVehicleAssembly(definition);
  assert.equal(assembly.type, 'triple-core');
  assert.equal(assembly.schemaVersion, 1);
  assert.deepEqual(Array.from(assembly.sideCores, (slot) => slot.slotId), ['left', 'right']);
  assert.equal(context.getVehicleAssembly(assembly.id).centralStackId, 'central-stack');
});

check('permits the same booster design in both physical side slots', () => {
  const assembly = context.loadVehicleAssemblies()[0];
  const validation = context.validateVehicleAssembly(assembly, { fleet, stacks });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.equal(validation.sideCores.length, 2);
  assert.equal(validation.sideCores[0].record.id, validation.sideCores[1].record.id);
});

check('rejects a missing central stack without fallback', () => {
  const assembly = { ...context.loadVehicleAssemblies()[0], centralStackId: 'missing-stack' };
  const validation = context.validateVehicleAssembly(assembly, { fleet, stacks });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('Central stack "missing-stack" was not found')));
});

check('rejects a side-core record that is not a booster', () => {
  const assembly = {
    ...context.loadVehicleAssemblies()[0],
    sideCores: [
      { slotId: 'left', recordId: 'not-a-booster' },
      { slotId: 'right', recordId: 'side-booster' },
    ],
  };
  const validation = context.validateVehicleAssembly(assembly, { fleet, stacks });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('Side-core left: record must have stageRole')));
});

check('rejects incomplete and duplicate side-core slots', () => {
  assert.throws(() => context.addVehicleAssembly({
    ...definition,
    sideCores: [{ slotId: 'left', recordId: 'side-booster' }],
  }), /exactly two/);
  const assembly = {
    ...context.loadVehicleAssemblies()[0],
    sideCores: [
      { slotId: 'left', recordId: 'side-booster' },
      { slotId: 'left', recordId: 'side-booster' },
    ],
  };
  assert.equal(context.validateVehicleAssembly(assembly, { fleet, stacks }).valid, false);
});

check('rejects non-finite or non-positive derived axial properties', () => {
  const assembly = context.loadVehicleAssemblies()[0];
  const originalValidateStack = context.validateStack;
  context.validateStack = () => ({ valid: true, errors: [], stackTotalHeight: NaN, stackTotalMass: 50000 });
  const validation = context.validateVehicleAssembly(assembly, { fleet, stacks });
  context.validateStack = originalValidateStack;
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('derived stack height must be finite')));
});

// ---------------------------------------------------------------------------
// New tests (Phase 1A hardening)
// ---------------------------------------------------------------------------

check('persists an assembly across a genuinely fresh VM context', () => {
  const firstStorage = new Map();
  const first = makeContext(firstStorage);
  const created = first.addVehicleAssembly(definition);
  const createdPlain = plain(created);

  // Snapshot the raw storage entries, as a browser keeps localStorage while
  // the page (and all its script state) is torn down.
  const savedEntries = new Map(firstStorage);
  assert.ok(savedEntries.has('rocketSim.assemblies.v1'), 'assembly was written to storage');

  // A later write in the first context must not leak into the second one.
  first.addVehicleAssembly({ ...definition, name: 'Added after snapshot' });

  const second = makeContext(savedEntries);
  assert.notEqual(second, first, 'second context is a distinct VM context');
  assert.notEqual(second.loadVehicleAssemblies, first.loadVehicleAssemblies, 'script was re-evaluated');
  assert.equal(vm.runInContext('_vehicleAssembliesCache', second), null, 'fresh module cache starts empty');

  const loaded = second.getVehicleAssembly(created.id);
  assert.ok(loaded, 'assembly is found by id in the fresh context');
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.centralStackId, 'central-stack');
  assert.deepEqual(plain(loaded.sideCores), [
    { slotId: 'left', recordId: 'side-booster' },
    { slotId: 'right', recordId: 'side-booster' },
  ]);
  assert.deepEqual(plain(loaded), createdPlain);
  assert.equal(second.loadVehicleAssemblies().length, 1, 'only the snapshotted assembly is present');

  // The reloaded definition is still usable by the validator.
  const validation = second.validateVehicleAssembly(loaded, { fleet, stacks });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
});

check('fails safely, without rewriting storage, when a side-core record is missing', () => {
  const store = new Map();
  const ctx = makeContext(store);
  const created = ctx.addVehicleAssembly(definition);
  const rawBefore = store.get('rocketSim.assemblies.v1');
  const definitionBefore = plain(created);

  const staleFleet = fleet.filter((record) => record.id !== 'side-booster');
  const validation = ctx.validateVehicleAssembly(created, { fleet: staleFleet, stacks });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes('Side-core left: fleet record "side-booster" was not found')),
    'left slot reports the missing record');
  assert.ok(validation.errors.some((e) => e.includes('Side-core right: fleet record "side-booster" was not found')),
    'right slot reports the missing record');
  assert.deepEqual(plain(validation.sideCores.map((s) => s.record)), [null, null]);

  // Nothing deleted, pruned, or rewritten.
  assert.equal(store.get('rocketSim.assemblies.v1'), rawBefore, 'raw storage untouched');
  assert.equal(ctx.loadVehicleAssemblies().length, 1);
  assert.deepEqual(plain(ctx.getVehicleAssembly(created.id)), definitionBefore);
  assert.deepEqual(plain(created), definitionBefore, 'assembly object passed in was not mutated');
  assert.equal(staleFleet.length, fleet.length - 1, 'supplied fleet array itself was not modified');
});

// Every non-finite / zero / negative value must be rejected for each derived
// property, for the central stack and for both side cores.
const badDerivedValues = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['zero', 0],
  ['negative', -1],
  ['undefined', undefined],
];
const derivedProps = [
  { prop: 'stackTotalHeight', message: 'derived stack height must be finite and greater than zero', other: 'derived stack mass' },
  { prop: 'stackTotalMass', message: 'derived stack mass must be finite and greater than zero', other: 'derived stack height' },
];
const derivedLabels = ['Central stack', 'Side-core left', 'Side-core right'];

check('rejects every non-finite, zero and negative derived height and mass', () => {
  let cases = 0;
  derivedProps.forEach(({ prop, message, other }) => {
    badDerivedValues.forEach(([label, badValue]) => {
      const store = new Map();
      const ctx = makeContext(store, {
        validateStack() {
          const result = { valid: true, errors: [], stackTotalHeight: 54, stackTotalMass: 29000 };
          result[prop] = badValue;
          return result;
        },
      });
      const assembly = ctx.addVehicleAssembly(definition);
      const validation = ctx.validateVehicleAssembly(assembly, { fleet, stacks });
      const where = prop + ' = ' + label;

      assert.equal(validation.valid, false, where + ' must invalidate the assembly');
      derivedLabels.forEach((stackLabel) => {
        assert.ok(validation.errors.includes(stackLabel + ': ' + message + '.'),
          where + ': missing error for ' + stackLabel + '. Got: ' + validation.errors.join(' | '));
      });
      assert.ok(!validation.errors.some((e) => e.includes(other)),
        where + ': must not blame the other (valid) property');
      cases += 1;
    });
  });
  assert.equal(cases, derivedProps.length * badDerivedValues.length);
});

check('accepts small positive finite derived height and mass', () => {
  const ctx = makeContext(new Map(), {
    validateStack: () => ({ valid: true, errors: [], stackTotalHeight: 0.001, stackTotalMass: 0.001 }),
  });
  const assembly = ctx.addVehicleAssembly(definition);
  const validation = ctx.validateVehicleAssembly(assembly, { fleet, stacks });
  assert.equal(validation.valid, true, validation.errors.join('\n'));
});

check('deletes an unlocked assembly from persistent storage', () => {
  const assembly = context.loadVehicleAssemblies()[0];
  assert.equal(context.deleteVehicleAssembly(assembly.id), true);
  assert.equal(context.getVehicleAssembly(assembly.id), null);
});

process.stdout.write(`ALL PASS (${passed} tests)\n`);
