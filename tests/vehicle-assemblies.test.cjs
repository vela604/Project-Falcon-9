// Standalone regression tests for the multi-core assembly-definition layer.
// Run from the repository root: node tests/vehicle-assemblies.test.cjs
// Uses Node built-ins only and a stub for fleet.js's production validateStack.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const fleet = [
  { id: 'center-booster', stageRole: 'booster', familyId: 'fam-falcon9', height: 41, width: 3.7, dryMass: 25000 },
  { id: 'side-rocket', stageRole: 'rocket', familyId: 'fam-falcon9', height: 41, width: 3.7, noseHeightM: 3.4, dryMass: 25000 },
  { id: 'upper-stage', stageRole: 'stage', familyId: 'fam-falcon9', height: 13, width: 3.7, dryMass: 4000 },
  { id: 'not-a-rocket', stageRole: 'booster', familyId: 'fam-falcon9', height: 41, width: 3.7, dryMass: 25000 },
  { id: 'other-family-rocket', stageRole: 'rocket', familyId: 'fam-other', height: 41, width: 3.7, noseHeightM: 3.4, dryMass: 25000 },
];
const stacks = [
  { id: 'central-stack', sequence: 'custom', members: ['center-booster', 'upper-stage'], payloadId: null },
];

const sourcePath = path.join(__dirname, '..', 'js', 'vehicleAssemblies.js');
const assemblySource = fs.readFileSync(sourcePath, 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeContext(storageMap, overrides) {
  const validationCalls = [];
  const defaultValidateStack = function (members, records, stack) {
    validationCalls.push({ members, fleet: records, stack });
    const resolved = members.map((id) => records.find((record) => record && record.id === id));
    const valid = resolved.length > 0 && resolved.every(Boolean);
    const totalHeight = valid ? resolved.reduce((sum, record) => {
      return sum + (Number.isFinite(record.height) ? record.height : 0) +
        (record.stageRole === 'rocket' && Number.isFinite(record.noseHeightM) ? record.noseHeightM : 0);
    }, 0) : 0;
    return {
      valid,
      errors: valid ? [] : ['one or more members are missing'],
      stackTotalHeight: totalHeight,
      stackTotalMass: valid ? resolved.reduce((sum, record) => sum + (Number.isFinite(record.dryMass) ? record.dryMass : 0), 0) : 0,
    };
  };
  const ctx = {
    localStorage: {
      getItem(key) { return storageMap.has(key) ? storageMap.get(key) : null; },
      setItem(key, value) { storageMap.set(key, String(value)); },
    },
    loadFleet() { return fleet; },
    loadStacks() { return stacks; },
    validateStack: defaultValidateStack,
    __validationCalls: validationCalls,
    ...(overrides || {}),
  };
  vm.createContext(ctx);
  vm.runInContext(assemblySource, ctx, { filename: sourcePath });
  return ctx;
}

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
    { slotId: 'left', recordId: 'side-rocket' },
    { slotId: 'right', recordId: 'side-rocket' },
  ],
};
function newContext(overrides) { return makeContext(new Map(), overrides); }
function validate(ctx, assembly = ctx.loadVehicleAssemblies()[0], fleetInput = fleet, stacksInput = stacks) {
  return ctx.validateVehicleAssembly(assembly, { fleet: fleetInput, stacks: stacksInput });
}

check('creates and persists a triple-core assembly', () => {
  const ctx = newContext();
  const assembly = ctx.addVehicleAssembly(definition);
  assert.equal(assembly.type, 'triple-core');
  assert.equal(assembly.schemaVersion, 1);
  assert.deepEqual(Array.from(assembly.sideCores, (slot) => slot.slotId), ['left', 'right']);
  assert.equal(ctx.getVehicleAssembly(assembly.id).centralStackId, 'central-stack');
});

check('permits the same rocket design record in both physical side slots', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const result = validate(ctx);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.sideCores.length, 2);
  assert.equal(result.sideCores[0].record.id, result.sideCores[1].record.id);
});

check('rejects a missing central stack without fallback', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const assembly = { ...ctx.loadVehicleAssemblies()[0], centralStackId: 'missing-stack' };
  const result = validate(ctx, assembly);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Central stack "missing-stack" was not found')));
});

check('rejects an ordinary booster record as a side core', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const assembly = {
    ...ctx.loadVehicleAssemblies()[0],
    sideCores: [
      { slotId: 'left', recordId: 'not-a-rocket' },
      { slotId: 'right', recordId: 'side-rocket' },
    ],
  };
  const result = validate(ctx, assembly);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Side-core left: record must have stageRole "rocket"')));
});

check('rejects a non-rocket, non-booster record (stage) as a side core', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const assembly = {
    ...ctx.loadVehicleAssemblies()[0],
    sideCores: [
      { slotId: 'left', recordId: 'side-rocket' },
      { slotId: 'right', recordId: 'upper-stage' },
    ],
  };
  const result = validate(ctx, assembly);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Side-core right: record must have stageRole "rocket" (got "stage")')));
  assert.ok(!result.errors.some((error) => error.startsWith('Side-core left:')), 'valid left slot is not blamed');
});

check('rejects a rocket from a different family by record id', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const assembly = {
    ...ctx.loadVehicleAssemblies()[0],
    sideCores: [
      { slotId: 'left', recordId: 'other-family-rocket' },
      { slotId: 'right', recordId: 'side-rocket' },
    ],
  };
  const result = validate(ctx, assembly);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Side-core left: familyId "fam-other" does not match the central stack bottom booster family "fam-falcon9"')));
  assert.ok(!result.errors.some((error) => error.startsWith('Side-core right:')), 'matching right slot is not blamed');
});

check('rejects incomplete and duplicate side-core slots', () => {
  const ctx = newContext();
  assert.throws(() => ctx.addVehicleAssembly({
    ...definition,
    sideCores: [{ slotId: 'left', recordId: 'side-rocket' }],
  }), /exactly two/);
  const assembly = {
    ...definition,
    sideCores: [
      { slotId: 'left', recordId: 'side-rocket' },
      { slotId: 'left', recordId: 'side-rocket' },
    ],
  };
  assert.equal(ctx.validateVehicleAssembly(assembly, { fleet, stacks }).valid, false);
});

check('rejects missing, zero, negative and non-finite side nose heights', () => {
  [undefined, 0, -1, NaN, Infinity, -Infinity, '3', null].forEach((value) => {
    const ctx = newContext();
    ctx.addVehicleAssembly(definition);
    const alteredFleet = fleet.map((record) => ({ ...record }));
    const rocket = alteredFleet.find((record) => record.id === 'side-rocket');
    if (value === undefined) delete rocket.noseHeightM;
    else rocket.noseHeightM = value;
    const result = validate(ctx, ctx.loadVehicleAssemblies()[0], alteredFleet);
    assert.equal(result.valid, false, String(value));
    assert.ok(result.errors.some((error) => error.includes('noseHeightM')), String(value));
  });
});

check('requires side rockets to share the central booster family', () => {
  [undefined, '', '  ', 7, 'fam-other'].forEach((value) => {
    const ctx = newContext();
    ctx.addVehicleAssembly(definition);
    const alteredFleet = fleet.map((record) => ({ ...record }));
    const rocket = alteredFleet.find((record) => record.id === 'side-rocket');
    if (value === undefined) delete rocket.familyId;
    else rocket.familyId = value;
    const result = validate(ctx, ctx.loadVehicleAssemblies()[0], alteredFleet);
    assert.equal(result.valid, false, String(value));
    // Distinguish "missing/blank/non-string" from "different family".
    const expected = value === 'fam-other'
      ? 'does not match the central stack bottom booster family "fam-falcon9"'
      : 'record must have a non-empty familyId';
    assert.ok(result.errors.some((error) => error.startsWith('Side-core left: ') && error.includes(expected)),
      String(value) + ' — ' + result.errors.join(' | '));
    if (value !== 'fam-other') {
      assert.ok(!result.errors.some((error) => error.includes('does not match')), String(value));
    }
  });
});

check('rejects a central bottom booster without a non-empty familyId', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const alteredFleet = fleet.map((record) => ({ ...record }));
  delete alteredFleet.find((record) => record.id === 'center-booster').familyId;
  const result = validate(ctx, ctx.loadVehicleAssemblies()[0], alteredFleet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Central stack bottom booster must have a non-empty familyId')));
  assert.ok(!result.errors.some((error) => error.includes('does not match')),
    'an unknown central family must not cascade into side-core mismatch noise');
});

check('requires the central stack to begin with a booster', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const alteredStacks = [{ ...stacks[0], members: ['side-rocket'] }];
  const result = validate(ctx, ctx.loadVehicleAssemblies()[0], fleet, alteredStacks);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Central stack must begin with a valid booster')));
});

check('validates each side rocket as a single-member legacy stack', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  ctx.__validationCalls.length = 0;
  const centralStack = stacks[0];
  assert.equal(stacks.length, 1, 'no persisted legacy stack exists for the side rocket');
  const result = validate(ctx);
  assert.equal(result.valid, true, result.errors.join('\n'));
  const calls = ctx.__validationCalls;
  assert.equal(calls.length, 3, 'one central and two side validation calls');
  assert.strictEqual(calls[0].members, centralStack.members, 'central members are passed by identity');
  assert.strictEqual(calls[0].fleet, fleet, 'fleet array is passed by identity');
  assert.strictEqual(calls[0].stack, centralStack, 'central stack object is passed by identity');
  calls.slice(1).forEach((call) => {
    assert.deepEqual(plain(call.members), ['side-rocket']);
    assert.deepEqual(plain(call.stack), { sequence: 'legacy', payloadId: null });
  });
});

check('reports a side-core stack validation failure', () => {
  const ctx = newContext({
    validateStack(members) {
      if (members[0] === 'side-rocket') return { valid: false, errors: ['invalid legacy rocket'] };
      return { valid: true, errors: [], stackTotalHeight: 54, stackTotalMass: 29000 };
    },
  });
  ctx.addVehicleAssembly(definition);
  const result = validate(ctx);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Side-core left: invalid legacy rocket')));
  assert.ok(result.errors.some((error) => error.includes('Side-core right: invalid legacy rocket')));
});

check('persists an assembly across a genuinely fresh VM context', () => {
  const firstStorage = new Map();
  const first = makeContext(firstStorage);
  const created = first.addVehicleAssembly(definition);
  const createdPlain = plain(created);
  const savedEntries = new Map(firstStorage);
  assert.ok(savedEntries.has('rocketSim.assemblies.v1'));
  first.addVehicleAssembly({ ...definition, name: 'Added after snapshot' });
  const second = makeContext(savedEntries);
  assert.notEqual(second, first);
  assert.notEqual(second.loadVehicleAssemblies, first.loadVehicleAssemblies);
  assert.equal(vm.runInContext('_vehicleAssembliesCache', second), null);
  const loaded = second.getVehicleAssembly(created.id);
  assert.ok(loaded);
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.centralStackId, 'central-stack');
  assert.deepEqual(plain(loaded.sideCores), [
    { slotId: 'left', recordId: 'side-rocket' },
    { slotId: 'right', recordId: 'side-rocket' },
  ]);
  assert.deepEqual(plain(loaded), createdPlain);
  assert.equal(second.loadVehicleAssemblies().length, 1);
  const result = validate(second, loaded);
  assert.equal(result.valid, true, result.errors.join('\n'));
});

check('does not rewrite storage or prune references when a side rocket is missing', () => {
  const store = new Map();
  const ctx = makeContext(store);
  const created = ctx.addVehicleAssembly(definition);
  const rawBefore = store.get('rocketSim.assemblies.v1');
  const definitionBefore = plain(created);
  const staleFleet = fleet.filter((record) => record.id !== 'side-rocket');
  const result = validate(ctx, created, staleFleet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Side-core left: fleet record "side-rocket" was not found')));
  assert.ok(result.errors.some((error) => error.includes('Side-core right: fleet record "side-rocket" was not found')));
  assert.deepEqual(plain(result.sideCores.map((side) => side.record)), [null, null]);
  assert.equal(store.get('rocketSim.assemblies.v1'), rawBefore);
  assert.equal(ctx.loadVehicleAssemblies().length, 1);
  assert.deepEqual(plain(ctx.getVehicleAssembly(created.id)), definitionBefore);
  assert.deepEqual(plain(created), definitionBefore);
  assert.equal(staleFleet.length, fleet.length - 1, 'supplied fleet array itself was not modified');
  assert.equal(fleet.length, 5, 'shared fixture fleet was not modified');
});

check('rejects non-finite or non-positive derived axial properties', () => {
  const ctx = newContext({
    validateStack: () => ({ valid: true, errors: [], stackTotalHeight: NaN, stackTotalMass: 50000 }),
  });
  ctx.addVehicleAssembly(definition);
  const result = validate(ctx);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('derived stack height must be finite')));
});

check('rejects every non-finite, zero and negative derived height and mass for all three stacks', () => {
  const badValues = [NaN, Infinity, -Infinity, 0, -1, undefined];
  const properties = [
    ['stackTotalHeight', 'derived stack height must be finite and greater than zero', 'derived stack mass'],
    ['stackTotalMass', 'derived stack mass must be finite and greater than zero', 'derived stack height'],
  ];
  const labels = ['Central stack', 'Side-core left', 'Side-core right'];
  let cases = 0;
  properties.forEach(([property, message, other]) => badValues.forEach((badValue) => {
    const ctx = newContext({
      validateStack() {
        const result = { valid: true, errors: [], stackTotalHeight: 54, stackTotalMass: 29000 };
        result[property] = badValue;
        return result;
      },
    });
    ctx.addVehicleAssembly(definition);
    const result = validate(ctx);
    assert.equal(result.valid, false, property + ': ' + String(badValue));
    labels.forEach((label) => assert.ok(result.errors.includes(label + ': ' + message + '.'),
      label + ': ' + property + '=' + String(badValue) + ' — ' + result.errors.join(' | ')));
    assert.ok(!result.errors.some((error) => error.includes(other)),
      property + '=' + String(badValue) + ': must not blame the other (valid) property');
    cases += 1;
  }));
  assert.equal(cases, properties.length * badValues.length);
});

check('accepts small positive finite derived height and mass', () => {
  const ctx = newContext({
    validateStack: () => ({ valid: true, errors: [], stackTotalHeight: 0.001, stackTotalMass: 0.001 }),
  });
  ctx.addVehicleAssembly(definition);
  const result = validate(ctx);
  assert.equal(result.valid, true, result.errors.join('\n'));
});

check('does not mutate assembly, fleet or stack inputs during validation', () => {
  const ctx = newContext();
  ctx.addVehicleAssembly(definition);
  const assembly = ctx.loadVehicleAssemblies()[0];
  const snapshot = plain({ assembly, fleet, stacks });
  const result = validate(ctx, assembly);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(plain({ assembly, fleet, stacks }), snapshot);
});

check('deletes an unlocked assembly from persistent storage', () => {
  const ctx = newContext();
  const assembly = ctx.addVehicleAssembly(definition);
  assert.equal(ctx.deleteVehicleAssembly(assembly.id), true);
  assert.equal(ctx.getVehicleAssembly(assembly.id), null);
});

process.stdout.write(`ALL PASS (${passed} tests)\n`);
