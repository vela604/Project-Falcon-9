// Standalone regression tests for js/vehicleAssemblyGeometry.js.
// Dimensions are SYNTHETIC test values, not real vehicle dimensions.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'vehicleAssemblyGeometry.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx, { filename: 'vehicleAssemblyGeometry.js' });
const G = ctx.VehicleAssemblyGeometry;
assert.ok(G, 'VehicleAssemblyGeometry global must exist');

// Results come from another vm realm: normalise before deep comparisons.
const plain = (x) => JSON.parse(JSON.stringify(x));
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, (m || '') + ' expected ' + b + ' got ' + a);

// Recording stub validator (kept outside inputs so deep-freezing inputs is safe).
const calls = [];
const okValidator = (members, fleet, stack) => {
  calls.push({ members, fleet, stack });
  return { valid: true, errors: [], stackTotalHeight: 1, stackTotalMass: 1 };
};

function makeInputs() {
  calls.length = 0;
  return {
    stackValidator: okValidator,
    assembly: {
      id: 'asm_t', schemaVersion: 1, type: 'triple-core', name: 'T',
      centralStackId: 'stk_c',
      sideCores: [{ slotId: 'left', recordId: 'b_side' }, { slotId: 'right', recordId: 'b_side' }],
      locked: false,
    },
    fleet: [
      { id: 'b_center', stageRole: 'booster', familyId: 'fam1', width: 3, height: 40 },
      { id: 'int1', stageRole: 'interstage', width: 3, height: 2 },
      { id: 'stage2', stageRole: 'stage', width: 3, height: 12 },
      { id: 'fairing', stageRole: 'payloadSpace', width: 3.2, height: 8, stageOverlapM: 1.5 },
      { id: 'b_side', stageRole: 'rocket', familyId: 'fam1', width: 2, height: 30, noseHeightM: 4 },
      { id: 'b_side2', stageRole: 'rocket', familyId: 'fam1', width: 2.5, height: 32, noseHeightM: 3 },
    ],
    stacks: [{ id: 'stk_c', members: ['b_center', 'int1', 'stage2', 'fairing'] }],
    sideCoreCenterlineOffsetM: 4,
  };
}
const run = (inp) => G.resolveVehicleAssemblyGeometry(inp);
const core = (r, id) => r.cores.find((c) => c.instanceId === id);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('API reports geometry-only / not flight-ready', () => {
  assert.strictEqual(G.geometryOnly, true);
  assert.strictEqual(G.flightReady, false);
  const r = run(makeInputs());
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  assert.strictEqual(r.geometryOnly, true);
  assert.strictEqual(r.flightReady, false);
});

t('1. symmetric center/left/right placements', () => {
  const r = run(makeInputs());
  assert.deepStrictEqual(plain(core(r, 'center').origin), { x: 0, y: 0 });
  assert.deepStrictEqual(plain(core(r, 'side-left').origin), { x: -4, y: 0 });
  assert.deepStrictEqual(plain(core(r, 'side-right').origin), { x: 4, y: 0 });
});

t('2. same record in both slots yields distinct core instances', () => {
  const r = run(makeInputs());
  const l = core(r, 'side-left'), rt = core(r, 'side-right');
  assert.notStrictEqual(l, rt);
  assert.notStrictEqual(l.instanceId, rt.instanceId);
  assert.strictEqual(l.memberBounds[0].recordId, 'b_side');
  assert.strictEqual(rt.memberBounds[0].recordId, 'b_side');
  assert.notStrictEqual(l.memberBounds[0], rt.memberBounds[0]);
  assert.notStrictEqual(l.origin, rt.origin);
});

t('3. central member Y offsets bottom-to-top', () => {
  const b = core(run(makeInputs()), 'center').memberBounds;
  assert.deepStrictEqual(plain(b.map((m) => m.base.y)), [0, 40, 42, 52.5]);
});

t('4. fairing overlap applied consistently', () => {
  const b = core(run(makeInputs()), 'center').memberBounds;
  const f = b[3];
  near(f.base.y, 54 - 1.5); near(f.minY, 52.5); near(f.maxY, 60.5);
  // Overlap must not apply to non-payloadSpace members even if field present.
  const inp = makeInputs();
  inp.fleet.find((x) => x.id === 'stage2').stageOverlapM = 5;
  near(core(run(inp), 'center').memberBounds[3].base.y, 52.5);
});

t('5. member bounds and aggregate bounding box', () => {
  const r = run(makeInputs());
  assert.strictEqual(r.memberBounds.length, 6);
  const L = core(r, 'side-left').memberBounds[0];
  assert.deepStrictEqual(
    plain({ a: L.minX, b: L.maxX, c: L.minY, d: L.maxY, w: L.width, h: L.height, role: L.stageRole, rec: L.recordId, cid: L.coreInstanceId }),
    { a: -5, b: -3, c: 0, d: 34, w: 2, h: 34, role: 'rocket', rec: 'b_side', cid: 'side-left' });
  assert.deepStrictEqual(plain(r.boundingBox), { minX: -5, maxX: 5, minY: 0, maxY: 60.5 });
});

t('6. missing/zero/negative/NaN/Infinity/non-number offset rejected', () => {
  [undefined, null, 0, -1, NaN, Infinity, -Infinity, '4'].forEach((v) => {
    const inp = makeInputs();
    inp.sideCoreCenterlineOffsetM = v;
    const r = run(inp);
    assert.strictEqual(r.valid, false, 'offset ' + String(v));
    assert.ok(r.errors.some((e) => /sideCoreCenterlineOffsetM/.test(e)), 'offset ' + String(v));
  });
  const inp = makeInputs(); delete inp.sideCoreCenterlineOffsetM;
  assert.strictEqual(run(inp).valid, false);
});

t('7. negative clearance rejected; zero accepted', () => {
  const inp = makeInputs();
  inp.sideCoreCenterlineOffsetM = 2; // 2 - 1.5 - 1 = -0.5
  const bad = run(inp);
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.errors.some((e) => /negative hull clearance/.test(e)));
  inp.sideCoreCenterlineOffsetM = 2.5; // exactly 0
  const ok = run(inp);
  assert.strictEqual(ok.valid, true, ok.errors.join('; '));
  near(ok.clearances[0].clearanceM, 0);
  inp.sideCoreCenterlineOffsetM = 4;
  near(run(inp).clearances[1].clearanceM, 1.5);
});

t('clearance uses each side core\'s own width', () => {
  const inp = makeInputs();
  inp.assembly.sideCores[1].recordId = 'b_side2'; // width 2.5
  const r = run(inp);
  near(r.clearances.find((c) => c.slotId === 'left').clearanceM, 1.5);
  near(r.clearances.find((c) => c.slotId === 'right').clearanceM, 4 - 1.5 - 1.25);
  assert.strictEqual(core(r, 'side-right').memberBounds[0].height, 35);
});

const comps = () => [
  { label: 'tank', mass: 100, comX: 0.5, comY: 10, iOwn: 7, extra: { k: 1 } },
  { label: 'engine', mass: 20, comX: -0.25, comY: 1, iOwn: 0.5 },
];

t('8. component translation without mutation', () => {
  const orig = deepFreeze(comps());
  const out = G.translateMassComponents(orig, { x: -4, y: 2 });
  assert.notStrictEqual(out, orig);
  near(out[0].comX, -3.5); near(out[0].comY, 12);
  near(out[1].comX, -4.25); near(out[1].comY, 3);
  assert.notStrictEqual(out[0], orig[0]);
  assert.deepStrictEqual(plain(orig), plain(comps()));
  assert.throws(() => G.translateMassComponents(orig, { x: NaN, y: 0 }));
});

t('9. mass, iOwn and metadata preserved', () => {
  const out = G.translateMassComponents(comps(), { x: 4, y: 0 });
  assert.strictEqual(out[0].mass, 100); assert.strictEqual(out[0].iOwn, 7);
  assert.strictEqual(out[1].mass, 20); assert.strictEqual(out[1].iOwn, 0.5);
  assert.strictEqual(out[0].label, 'tank');
  assert.deepStrictEqual(plain(out[0].extra), { k: 1 });
});

t('10. world transform matches physics _rotatedPoint convention', () => {
  const ref = (body, lx, ly) => {
    const c = Math.cos(body.theta), s = Math.sin(body.theta);
    return { x: body.rx + lx * c - ly * s, y: body.ry + lx * s + ly * c };
  };
  [0, Math.PI / 2, Math.PI, -Math.PI / 3, 0.7, 5.5].forEach((theta) => {
    const pose = { rx: 10, ry: -3, theta };
    [[0, 0], [1, 0], [0, 1], [-4, 25.5]].forEach(([x, y]) => {
      const got = G.assemblyPointToWorld({ x, y }, pose), exp = ref(pose, x, y);
      near(got.x, exp.x, 'x@' + theta); near(got.y, exp.y, 'y@' + theta);
    });
  });
  // Explicit sign check: theta = +90deg sends local +Y (nose) toward world -X.
  const n = G.assemblyPointToWorld({ x: 0, y: 1 }, { rx: 0, ry: 0, theta: Math.PI / 2 });
  near(n.x, -1); near(n.y, 0);
  const r = G.assemblyPointToWorld({ x: 1, y: 0 }, { rx: 0, ry: 0, theta: Math.PI / 2 });
  near(r.x, 0); near(r.y, 1);
  assert.throws(() => G.assemblyPointToWorld({ x: 0, y: 0 }, { rx: 0, ry: 0, theta: NaN }));
});

t('11. missing central stack / side-core record rejected', () => {
  let inp = makeInputs(); inp.assembly.centralStackId = 'nope';
  let r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Central stack "nope"/.test(e)));
  inp = makeInputs(); inp.assembly.sideCores[0].recordId = 'ghost';
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Side-core left.*ghost/.test(e)));
  inp = makeInputs(); inp.stacks[0].members[1] = 'ghost';
  assert.strictEqual(run(inp).valid, false);
  inp = makeInputs(); inp.assembly.sideCores.pop();
  assert.strictEqual(run(inp).valid, false);
  inp = makeInputs(); inp.assembly.sideCores[1].slotId = 'left';
  assert.strictEqual(run(inp).valid, false);
  inp = makeInputs(); inp.assembly.type = 'dual-core';
  assert.strictEqual(run(inp).valid, false);
});

t('12. invalid side-core role and non-booster central base rejected', () => {
  let inp = makeInputs(); inp.assembly.sideCores[0].recordId = 'stage2';
  let r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /stageRole "rocket"/.test(e)));
  inp = makeInputs(); inp.assembly.sideCores[1].recordId = 'b_center'; // ordinary booster
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Side-core right.*stageRole "rocket"/.test(e)));
  inp = makeInputs(); inp.stacks[0].members = ['stage2', 'fairing'];
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /begin with a valid booster/.test(e)));
});

t('13. inputs unchanged (deep-frozen inputs, success and failure paths)', () => {
  const inp = makeInputs();
  const snap = plain(inp);
  deepFreeze(inp);
  assert.strictEqual(run(inp).valid, true);
  assert.deepStrictEqual(plain(inp), snap);
  const bad = makeInputs(); bad.sideCoreCenterlineOffsetM = 1;
  const snapBad = plain(bad);
  deepFreeze(bad);
  assert.strictEqual(run(bad).valid, false);
  assert.deepStrictEqual(plain(bad), snapBad);
  // Output must not alias input records.
  const r = run(makeInputs());
  r.memberBounds[0].width = 999;
  assert.strictEqual(run(makeInputs()).memberBounds[0].width, 3);
});

t('14. malformed component coordinates rejected, input untouched', () => {
  const bad = [
    { label: 'noX', mass: 1, comY: 1 },
    { label: 'noY', mass: 1, comX: 1 },
    { label: 'nanX', mass: 1, comX: NaN, comY: 1 },
    { label: 'infY', mass: 1, comX: 1, comY: Infinity },
    { label: 'strX', mass: 1, comX: '1', comY: 1 },
    { label: 'nullY', mass: 1, comX: 1, comY: null },
  ];
  bad.forEach((c) => {
    const input = deepFreeze([{ mass: 5, comX: 0, comY: 0, iOwn: 0 }, c]);
    const snap = plain(input);
    assert.throws(() => G.translateMassComponents(input, { x: 1, y: 1 }), /components\[1\]\.com[XY]/, c.label);
    assert.deepStrictEqual(plain(input), snap);
  });
  assert.throws(() => G.translateMassComponents([null], { x: 0, y: 0 }), /components\[0\]/);
  assert.throws(() => G.translateMassComponents([[]], { x: 0, y: 0 }), /components\[0\]/);
  // Genuine zero coordinates are still valid.
  const ok = G.translateMassComponents([{ mass: 1, comX: 0, comY: 0, iOwn: 0 }], { x: 2, y: 3 });
  near(ok[0].comX, 2); near(ok[0].comY, 3);
});

const rec = (inp, id) => inp.fleet.find((x) => x.id === id);

t('15. missing/invalid side noseHeightM rejected', () => {
  [undefined, 0, -1, NaN, Infinity, '4', null].forEach((v) => {
    const inp = makeInputs();
    if (v === undefined) delete rec(inp, 'b_side').noseHeightM; else rec(inp, 'b_side').noseHeightM = v;
    const r = run(inp);
    assert.strictEqual(r.valid, false, String(v));
    assert.ok(r.errors.some((e) => /noseHeightM/.test(e)), String(v));
  });
});

t('16. family: matching accepted; missing/different rejected', () => {
  assert.strictEqual(run(makeInputs()).valid, true);
  [undefined, '', 'other'].forEach((v) => {
    const inp = makeInputs();
    if (v === undefined) delete rec(inp, 'b_side').familyId; else rec(inp, 'b_side').familyId = v;
    const r = run(inp);
    assert.strictEqual(r.valid, false, String(v));
    assert.ok(r.errors.some((e) => /familyId/.test(e)), String(v));
  });
  const inp = makeInputs(); delete rec(inp, 'b_center').familyId;
  const r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /bottom booster must have a non-empty familyId/.test(e)));
});

t('17. same rocket record in both slots accepted', () => {
  const r = run(makeInputs());
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  assert.strictEqual(core(r, 'side-left').memberBounds[0].recordId, core(r, 'side-right').memberBounds[0].recordId);
  assert.notStrictEqual(core(r, 'side-left'), core(r, 'side-right'));
});

t('18. each side rocket validated as single-member legacy stack', () => {
  const inp = makeInputs(); run(inp);
  assert.strictEqual(calls.length, 3);
  calls.slice(1).forEach((c) => {
    assert.deepStrictEqual(plain(c.members), ['b_side']);
    assert.deepStrictEqual(plain(c.stack), { sequence: 'legacy', payloadId: null });
    assert.strictEqual(c.fleet, inp.fleet);
  });
});

t('19. central validator receives exact members, fleet and stack objects', () => {
  const inp = makeInputs(); run(inp);
  assert.strictEqual(calls[0].members, inp.stacks[0].members);
  assert.strictEqual(calls[0].fleet, inp.fleet);
  assert.strictEqual(calls[0].stack, inp.stacks[0]);
});

t('20. missing / throwing / malformed validators fail closed', () => {
  let inp = makeInputs(); delete inp.stackValidator;
  let r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /stackValidator/.test(e)));
  inp = makeInputs(); inp.stackValidator = 'nope';
  assert.strictEqual(run(inp).valid, false);
  inp = makeInputs(); inp.stackValidator = () => { throw new Error('boom'); };
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /stackValidator threw: boom/.test(e)));
  [undefined, null, 'ok', 1, true, [], {}, { valid: 'true' }, { valid: 1 }, { valid: false }].forEach((out) => {
    const i = makeInputs(); i.stackValidator = () => out;
    const res = run(i);
    assert.strictEqual(res.valid, false, JSON.stringify(out));
    assert.ok(res.errors.length > 0);
  });
});

// Real fleet.js validateStack() returns { valid, errors, stackTotalHeight,
// stackTotalMass, memberInfo }. A "valid" result missing/corrupting those
// fields is malformed and must fail closed, like vehicleAssemblies.js does.
t('24. validator result must match the validateStack() contract', () => {
  const good = { valid: true, errors: [], stackTotalHeight: 54, stackTotalMass: 29000, memberInfo: [] };
  // Fully real-shaped result (memberInfo present) is accepted.
  let inp = makeInputs(); inp.stackValidator = () => good;
  let r = run(inp);
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  // memberInfo is not inspected: absent is still accepted (shape unverified).
  inp = makeInputs(); inp.stackValidator = () => ({ valid: true, errors: [], stackTotalHeight: 1, stackTotalMass: 1 });
  assert.strictEqual(run(inp).valid, true);
  // Tiny positive finite values are accepted.
  inp = makeInputs(); inp.stackValidator = () => ({ ...good, stackTotalHeight: 0.001, stackTotalMass: 0.001 });
  assert.strictEqual(run(inp).valid, true);

  const bad = [
    ['bare {valid:true}', { valid: true }],
    ['no height/mass', { valid: true, errors: [] }],
    ['errors missing', { valid: true, stackTotalHeight: 54, stackTotalMass: 29000 }],
    ['errors null', { ...good, errors: null }],
    ['errors string', { ...good, errors: 'none' }],
    ['errors object', { ...good, errors: {} }],
    ['valid but errors non-empty', { ...good, errors: ['x'] }],
    ['height missing', { valid: true, errors: [], stackTotalMass: 29000 }],
    ['mass missing', { valid: true, errors: [], stackTotalHeight: 54 }],
  ];
  [NaN, Infinity, -Infinity, 0, -1, '54', null].forEach((v) => {
    bad.push(['height ' + String(v), { ...good, stackTotalHeight: v }]);
    bad.push(['mass ' + String(v), { ...good, stackTotalMass: v }]);
  });
  bad.forEach(([name, out]) => {
    // Malformed for every stack the geometry resolver validates.
    const i = makeInputs(); i.stackValidator = () => out;
    const res = run(i);
    assert.strictEqual(res.valid, false, name);
    ['Central stack', 'Side-core left', 'Side-core right'].forEach((label) => {
      assert.ok(res.errors.some((e) => e.indexOf(label + ': stackValidator returned a malformed result') === 0),
        name + ' / ' + label + ' — ' + res.errors.join(' | '));
    });
    assert.strictEqual(res.geometryOnly, true);
    assert.strictEqual(res.flightReady, false);
    assert.deepStrictEqual(plain(res.cores), []);
  });
  // Malformed only on the side-core call is still rejected and labelled.
  inp = makeInputs();
  inp.stackValidator = (m, f, s) => (s && s.sequence === 'legacy' ? { valid: true } : good);
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /^Side-core left: stackValidator returned a malformed result/.test(e)));
  assert.ok(!r.errors.some((e) => /^Central stack:/.test(e)));
  // Malformed only on the central call is still rejected and labelled.
  inp = makeInputs();
  inp.stackValidator = (m, f, s) => (s && s.sequence === 'legacy' ? good : { valid: true });
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /^Central stack: stackValidator returned a malformed result/.test(e)));
  assert.ok(!r.errors.some((e) => /^Side-core/.test(e)));
});

t('21. meaningful validator errors preserved; side validator failure rejected', () => {
  let inp = makeInputs();
  inp.stackValidator = (m, f, s) => (s && s.sequence === 'legacy'
    ? { valid: false, errors: ['rocket is bad'] } : okValidator(m, f, s));
  let r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Side-core left: rocket is bad/.test(e)));
  inp = makeInputs();
  inp.stackValidator = (m, f, s) => (s && s.sequence ? okValidator(m, f, s) : { valid: false, errors: ['central bad'] });
  inp.stacks[0].sequence = undefined;
  r = run(inp);
  assert.ok(r.errors.some((e) => /Central stack: central bad/.test(e)));
});

t('22. integrated nose included in side-core bounds', () => {
  const r = run(makeInputs());
  const b = core(r, 'side-right').memberBounds[0];
  near(b.height, 34); near(b.maxY, 34); near(b.hullHeightM, 30); near(b.noseHeightM, 4);
  rec(makeInputs(), 'b_side'); // no-op, fixture sanity
  const inp = makeInputs(); rec(inp, 'b_side').height = 70;
  near(run(inp).boundingBox.maxY, 74); // taller than central 60.5 only because of hull+nose
});

t('23. frozen virtual interstage height does not change hull bounds', () => {
  const base = plain(run(makeInputs()).memberBounds);
  [99, 5, 0.001].forEach((h) => {
    const inp = makeInputs();
    inp.stacks[0].derived = { interstage: { b_center: { height: h, mass: 1 } } };
    assert.deepStrictEqual(plain(run(inp).memberBounds), base, 'derived height ' + h);
  });
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
