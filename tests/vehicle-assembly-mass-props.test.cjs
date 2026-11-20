// Standalone regression tests for js/simJs/core/vehicleAssemblyMassProps.js.
// Run from the repository root: node tests/vehicle-assembly-mass-props.test.cjs
// Node built-ins only. ALL NUMBERS BELOW ARE SYNTHETIC test values, not real
// Falcon Heavy masses, dimensions or inertias. Expected values are derived by
// hand from raw sums (shown in comments), not by re-using the module's formula.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const massSrcPath = path.join(__dirname, '..', 'js', 'simJs', 'core', 'vehicleAssemblyMassProps.js');
const geoSrcPath = path.join(__dirname, '..', 'js', 'vehicleAssemblyGeometry.js');
const massSrc = fs.readFileSync(massSrcPath, 'utf8');

// Module under test, loaded into an EMPTY context: no browser/sim globals exist.
const ctx = vm.createContext({});
vm.runInContext(massSrc, ctx, { filename: 'vehicleAssemblyMassProps.js' });
const M = ctx.VehicleAssemblyMassProps;
assert.ok(M, 'VehicleAssemblyMassProps global must exist');

// Results come from another vm realm: normalise before deep comparisons.
const plain = (x) => JSON.parse(JSON.stringify(x));
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};
// Relative tolerance for floating-point comparison.
const near = (a, b, msg) => {
  const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' got ' + a);
};

// ---- Fixtures (SYNTHETIC) ---------------------------------------------------
// Geometry fixture shaped like resolveVehicleAssemblyGeometry() output.
function geom(d, shift) {
  const s = shift || { x: 0, y: 0 };
  return {
    valid: true, errors: [], geometryOnly: true, flightReady: false,
    sideCoreCenterlineOffsetM: d,
    cores: [
      { instanceId: 'center', slotId: 'center', origin: { x: 0 + s.x, y: 0 + s.y }, memberBounds: [] },
      { instanceId: 'side-left', slotId: 'left', origin: { x: -d + s.x, y: 0 + s.y }, memberBounds: [] },
      { instanceId: 'side-right', slotId: 'right', origin: { x: d + s.x, y: 0 + s.y }, memberBounds: [] },
    ],
    memberBounds: [], boundingBox: null, clearances: [],
  };
}
const centerComps = () => [
  { label: 'c-tank', mass: 100, comX: 0, comY: 10, iOwn: 50 },
  { label: 'c-upper', mass: 50, comX: 0, comY: 30, iOwn: 20 },
];
// One side-rocket design (comX = 0: symmetric about its own centreline).
const sideComps = () => [
  { label: 's-tank', mass: 40, comX: 0, comY: 8, iOwn: 10 },
  { label: 's-nose', mass: 20, comX: 0, comY: 20, iOwn: 5 },
];
function inputs(over) {
  return Object.assign({
    geometry: geom(4),
    cores: [
      { instanceId: 'center', components: centerComps() },
      { instanceId: 'side-left', components: sideComps() },
      { instanceId: 'side-right', components: sideComps() },
    ],
  }, over || {});
}
const run = (inp) => M.resolveVehicleAssemblyMassProps(inp);
const coreEntry = (inp, id) => inp.cores.find((c) => c.instanceId === id);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// Independent hand-derived result of the SYMMETRIC fixture (d = 4):
//   absolute (m, x, y): C(100,0,10) C(50,0,30) L(40,-4,8) L(20,-4,20) R(40,4,8) R(20,4,20)
//   M = 270; sum m x = 0; sum m y = 1000+1500+320+400+320+400 = 3940
//   sum iOwn = 50+20+10+5+10+5 = 100
//   sum m x^2 = 16*(40+20+40+20) = 1920
//   sum m y^2 = 10000+45000+ 2*(2560+8000) = 76120
//   I_c = 100 + [1920 - 0] + [76120 - 3940^2/270]
const SYM = {
  M: 270,
  x: 0,
  y: 3940 / 270,
  moi: 100 + 1920 + (76120 - (3940 * 3940) / 270),
};

t('API: frozen, geometry-only, not flight-ready', () => {
  assert.strictEqual(Object.isFrozen(M), true);
  assert.strictEqual(M.geometryOnly, true);
  assert.strictEqual(M.flightReady, false);
  assert.strictEqual(typeof M.resolveVehicleAssemblyMassProps, 'function');
  const r = run(inputs());
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  assert.strictEqual(r.geometryOnly, true);
  assert.strictEqual(r.flightReady, false);
  assert.deepStrictEqual(plain(r.errors), []);
  assert.ok(r.massExclusions.some((e) => /strut/.test(e)) && r.massExclusions.some((e) => /attachment/.test(e)));
});

t('1. symmetric three-core arrangement gives COM X = 0 exactly', () => {
  const r = run(inputs());
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  assert.strictEqual(r.comX, 0);
  near(r.totalMass, SYM.M);
});

t('2. known asymmetric arrangement: exact COM X/Y', () => {
  // Left side heavier: s-tank 60 (was 40). Hand sums:
  //   C(100,0,10) C(50,0,30) L(60,-4,8) L(20,-4,20) R(40,4,8) R(20,4,20)
  //   M = 290; sum m x = -240 -80 +160 +80 = -80; sum m y = 1000+1500+480+400+320+400 = 4100
  const inp = inputs();
  coreEntry(inp, 'side-left').components[0].mass = 60;
  const r = run(inp);
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  near(r.totalMass, 290);
  near(r.comX, -80 / 290);
  near(r.comY, 4100 / 290);
  assert.ok(r.comX < 0, 'heavier left core must pull COM to -X (not forced to zero)');
});

t('3. MOI includes every component\'s own inertia + parallel-axis terms', () => {
  const r = run(inputs());
  near(r.comY, SYM.y);
  near(r.moi, SYM.moi);
  // iOwn really contributes: raising one component's iOwn by 7 raises MOI by exactly 7.
  const inp = inputs();
  coreEntry(inp, 'center').components[1].iOwn += 7;
  near(run(inp).moi, SYM.moi + 7);
  // ...and each core's own iOwn counts (left nose +3, right tank +11).
  const inp2 = inputs();
  coreEntry(inp2, 'side-left').components[1].iOwn += 3;
  coreEntry(inp2, 'side-right').components[0].iOwn += 11;
  near(run(inp2).moi, SYM.moi + 14);
});

t('4. parallel-axis contribution of the two side-core offsets is m_side * d^2 each', () => {
  // With xc = 0 in both layouts and identical Y, MOI(d) - MOI(0) = sum m_side * d^2
  // = (40+20+40+20) * d^2 = 120 d^2 (the Y terms are unchanged).
  const base = run(Object.assign(inputs(), { geometry: geom(1e-300) })).moi; // ~zero offset, still a valid geometry fixture
  [4, 6, 11.5].forEach((d) => {
    const r = run(Object.assign(inputs(), { geometry: geom(d) }));
    assert.strictEqual(r.comX, 0);
    near(r.moi - base, 120 * d * d, 'd=' + d);
  });
});

t('5. same design in both side slots: independent translated instances', () => {
  const shared = sideComps();           // the SAME array object (and objects) for both slots
  const inp = inputs();
  coreEntry(inp, 'side-left').components = shared;
  coreEntry(inp, 'side-right').components = shared;
  const snap = plain(shared);
  const r = run(inp);
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  const L = r.components.filter((c) => c.coreInstanceId === 'side-left');
  const R = r.components.filter((c) => c.coreInstanceId === 'side-right');
  assert.strictEqual(L.length, 2); assert.strictEqual(R.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.notStrictEqual(L[i], R[i]);
    assert.notStrictEqual(L[i], shared[i]); assert.notStrictEqual(R[i], shared[i]);
    assert.strictEqual(L[i].label, R[i].label);
    assert.strictEqual(L[i].mass, R[i].mass);
    near(L[i].comX, -4); near(R[i].comX, 4);
    assert.strictEqual(L[i].comY, R[i].comY);
  }
  assert.deepStrictEqual(plain(shared), snap, 'shared design components were not mutated');
  near(r.moi, SYM.moi);
});

t('6. different left/right fuel masses shift COM and inertia correctly', () => {
  // Left tank 60 (iOwn 15), right tank 25 (iOwn 6); everything else as in the fixture.
  //   C(100,0,10) C(50,0,30) L(60,-4,8) L(20,-4,20) R(25,4,8) R(20,4,20)
  //   M = 275; sum m x = -240-80+100+80 = -140; sum m y = 1000+1500+480+400+200+400 = 3980
  //   sum iOwn = 50+20+15+5+6+5 = 101
  //   sum m x^2 = 16*(60+20+25+20) = 2000
  //   sum m y^2 = 10000+45000 + (60*64+8000) + (25*64+8000) = 55000+11840+9600 = 76440
  //   I_c = 101 + (2000 - 140^2/275) + (76440 - 3980^2/275)
  const inp = inputs();
  const L = coreEntry(inp, 'side-left').components, R = coreEntry(inp, 'side-right').components;
  L[0].mass = 60; L[0].iOwn = 15; R[0].mass = 25; R[0].iOwn = 6;
  const r = run(inp);
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  near(r.totalMass, 275);
  near(r.comX, -140 / 275);
  near(r.comY, 3980 / 275);
  near(r.moi, 101 + (2000 - (140 * 140) / 275) + (76440 - (3980 * 3980) / 275));
  const cm = (id) => r.coreMasses.find((c) => c.instanceId === id).mass;
  near(cm('center'), 150); near(cm('side-left'), 80); near(cm('side-right'), 45);
});

t('7. common translation of all origins shifts COM by that vector, MOI unchanged', () => {
  const base = run(inputs());
  [{ x: 100, y: -37 }, { x: -5.5, y: 250 }, { x: 0, y: 12 }].forEach((s) => {
    const r = run(Object.assign(inputs(), { geometry: geom(4, s) }));
    assert.strictEqual(r.valid, true, r.errors.join('; '));
    near(r.comX, base.comX + s.x); near(r.comY, base.comY + s.y);
    near(r.moi, base.moi); near(r.totalMass, base.totalMass);
  });
});

t('8. component mass, iOwn, labels and metadata preserved; originals not aliased', () => {
  const inp = inputs();
  const meta = { k: 1 };
  coreEntry(inp, 'side-right').components[0] = {
    label: 'tagged', mass: 40, comX: 0.5, comY: 8, iOwn: 10, extra: meta, role: 'propellant',
  };
  const r = run(inp);
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  const c = r.components.find((x) => x.label === 'tagged');
  assert.strictEqual(c.mass, 40); assert.strictEqual(c.iOwn, 10);
  assert.strictEqual(c.role, 'propellant');
  assert.deepStrictEqual(plain(c.extra), { k: 1 });
  assert.strictEqual(c.coreInstanceId, 'side-right');
  near(c.comX, 4.5); near(c.comY, 8);       // origin.x + comX; origin.y + comY
  assert.strictEqual(r.components.length, 6);
  // Every core keeps its identity + individual mass.
  assert.deepStrictEqual(plain(r.coreMasses.map((x) => [x.instanceId, x.slotId, x.mass, x.componentCount])),
    [['center', 'center', 150, 2], ['side-left', 'left', 60, 2], ['side-right', 'right', 60, 2]]);
  // A pre-stamped matching coreInstanceId is accepted; a conflicting one is rejected.
  const ok = inputs(); coreEntry(ok, 'center').components[0].coreInstanceId = 'center';
  assert.strictEqual(run(ok).valid, true);
  const bad = inputs(); coreEntry(bad, 'center').components[0].coreInstanceId = 'side-left';
  const rb = run(bad);
  assert.strictEqual(rb.valid, false);
  assert.ok(rb.errors.some((e) => /Core "center" component 0: coreInstanceId/.test(e)));
});

t('9. input arrays and objects remain unchanged; output order independent of input order', () => {
  const inp = inputs();
  const snap = plain(inp);
  const r = run(inp);
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(plain(inp), snap);
  r.components[0].mass = 12345; r.components[0].comX = 999;   // mutating output must not touch input
  assert.deepStrictEqual(plain(inp), snap);
  // Cores matched by instanceId, never by array position.
  const shuffled = inputs();
  shuffled.cores = [shuffled.cores[2], shuffled.cores[0], shuffled.cores[1]];
  const a = run(shuffled), b = run(inputs());
  assert.deepStrictEqual(plain(a), plain(b));
  // Deterministic: repeated runs are identical.
  assert.deepStrictEqual(plain(run(inputs())), plain(run(inputs())));
});

t('10. deep-frozen inputs work on success and failure paths', () => {
  const good = deepFreeze(inputs());
  const snap = plain(good);
  assert.strictEqual(run(good).valid, true);
  assert.deepStrictEqual(plain(good), snap);
  const badInp = inputs();
  coreEntry(badInp, 'side-left').components[1].mass = -1;
  deepFreeze(badInp);
  const snapBad = plain(badInp);
  const r = run(badInp);
  assert.strictEqual(r.valid, false);
  assert.deepStrictEqual(plain(badInp), snapBad);
  assert.strictEqual(run(deepFreeze({ geometry: null, cores: null })).valid, false);
});

t('11. missing, duplicate and unexpected core instances rejected', () => {
  let inp = inputs(); inp.cores.pop();                                   // right missing
  let r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /missing core instance "side-right"/.test(e)));
  inp = inputs(); inp.cores[2].instanceId = 'side-left';                 // duplicate left, right missing
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /duplicate core instance "side-left"/.test(e)));
  assert.ok(r.errors.some((e) => /missing core instance "side-right"/.test(e)));
  inp = inputs(); inp.cores.push({ instanceId: 'side-extra', components: sideComps() });
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /unexpected core instance "side-extra"/.test(e)));
  [undefined, null, 7, ''].forEach((id) => {
    const i = inputs(); i.cores[1].instanceId = id;
    assert.strictEqual(run(i).valid, false, String(id));
  });
  inp = inputs(); inp.cores = 'nope'; assert.strictEqual(run(inp).valid, false);
  inp = inputs(); inp.cores = [null, ...inp.cores]; assert.strictEqual(run(inp).valid, false);
  // The same problems in the GEOMETRY result are rejected too.
  inp = inputs(); inp.geometry.cores.pop();
  r = run(inp); assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /geometry is missing core instance "side-right"/.test(e)));
  inp = inputs(); inp.geometry.cores[2].instanceId = 'side-left';
  assert.strictEqual(run(inp).valid, false);
  inp = inputs(); inp.geometry.cores.push({ instanceId: 'side-extra', origin: { x: 9, y: 0 } });
  assert.strictEqual(run(inp).valid, false);
  // Failure results are explicit and carry no numbers.
  assert.strictEqual(r.geometryOnly, true); assert.strictEqual(r.flightReady, false);
  assert.strictEqual(r.totalMass, null); assert.deepStrictEqual(plain(r.components), []);
});

t('12. missing/invalid geometry and core origins rejected', () => {
  [undefined, null, 'g', [], 5].forEach((g) => {
    const inp = inputs(); inp.geometry = g;
    assert.strictEqual(run(inp).valid, false, String(g));
  });
  const flags = [['valid', false], ['valid', undefined], ['geometryOnly', false], ['geometryOnly', undefined],
    ['flightReady', true], ['flightReady', undefined]];
  flags.forEach(([k, v]) => {
    const inp = inputs();
    if (v === undefined) delete inp.geometry[k]; else inp.geometry[k] = v;
    assert.strictEqual(run(inp).valid, false, k + '=' + String(v));
  });
  assert.strictEqual(run(Object.assign(inputs(), { geometry: Object.assign(geom(4), { cores: 'x' }) })).valid, false);
  [undefined, null, 'o', {}, { x: 1 }, { y: 1 }, { x: NaN, y: 0 }, { x: 0, y: Infinity },
    { x: '1', y: 0 }, { x: 0, y: null }].forEach((o) => {
    const inp = inputs();
    if (o === undefined) delete inp.geometry.cores[1].origin; else inp.geometry.cores[1].origin = o;
    const r = run(inp);
    assert.strictEqual(r.valid, false, JSON.stringify(o));
    assert.ok(r.errors.some((e) => /geometry core "side-left": origin/.test(e)), JSON.stringify(o));
  });
  assert.strictEqual(run(undefined).valid, false);
  assert.strictEqual(run(null).valid, false);
});

t('13. empty / missing component arrays rejected', () => {
  [undefined, null, [], 'x', {}, 3].forEach((v) => {
    const inp = inputs();
    if (v === undefined) delete coreEntry(inp, 'side-right').components; else coreEntry(inp, 'side-right').components = v;
    const r = run(inp);
    assert.strictEqual(r.valid, false, String(v));
    assert.ok(r.errors.some((e) => /Core "side-right": components must be a non-empty array/.test(e)), String(v));
  });
});

t('14. invalid mass, comX/comY and iOwn rejected with core id and component index', () => {
  const field = (name, vals, re) => vals.forEach((v) => {
    const inp = inputs();
    const c = coreEntry(inp, 'side-left').components[1];
    if (v === undefined) delete c[name]; else c[name] = v;
    const r = run(inp);
    assert.strictEqual(r.valid, false, name + '=' + String(v));
    assert.ok(r.errors.some((e) => e.indexOf('Core "side-left" component 1: ' + name) === 0 && re.test(e)),
      name + '=' + String(v) + ' — ' + r.errors.join(' | '));
    assert.ok(!r.errors.some((e) => /component 0|"center"|"side-right"/.test(e)), 'only the bad component is blamed');
  });
  field('mass', [-1, -1e-12, NaN, Infinity, -Infinity, '5', null, undefined], /mass must be a finite number >= 0/);
  field('comX', [NaN, Infinity, -Infinity, '1', null, undefined], /comX must be a finite number/);
  field('comY', [NaN, Infinity, -Infinity, '1', null, undefined], /comY must be a finite number/);
  field('iOwn', [-1, NaN, Infinity, -Infinity, '2', null, undefined], /iOwn must be a finite number >= 0/);
  // Malformed component objects are not skipped.
  [null, undefined, 5, 'c', []].forEach((c) => {
    const inp = inputs(); coreEntry(inp, 'center').components[0] = c;
    const r = run(inp);
    assert.strictEqual(r.valid, false, String(c));
    assert.ok(r.errors.some((e) => /Core "center" component 0: must be an object/.test(e)));
  });
  // Several independent faults are all reported, none dropped.
  const inp = inputs();
  coreEntry(inp, 'center').components[0].mass = -1;
  coreEntry(inp, 'side-right').components[1].iOwn = NaN;
  const r = run(inp);
  assert.ok(r.errors.some((e) => /Core "center" component 0: mass/.test(e)));
  assert.ok(r.errors.some((e) => /Core "side-right" component 1: iOwn/.test(e)));
  // Zero-mass components are ACCEPTED when their coordinates and inertia are valid,
  // and contribute exactly their own iOwn (no mass => no parallel-axis term).
  const z = inputs();
  coreEntry(z, 'side-left').components.push({ label: 'zero', mass: 0, comX: 3, comY: 99, iOwn: 2 });
  const rz = run(z);
  assert.strictEqual(rz.valid, true, rz.errors.join('; '));
  near(rz.totalMass, SYM.M); near(rz.comX, 0); near(rz.comY, SYM.y); near(rz.moi, SYM.moi + 2);
});

t('15. zero total mass of any single core rejected', () => {
  ['center', 'side-left', 'side-right'].forEach((id) => {
    const inp = inputs();
    coreEntry(inp, id).components.forEach((c) => { c.mass = 0; });
    const r = run(inp);
    assert.strictEqual(r.valid, false, id);
    assert.ok(r.errors.some((e) => e.indexOf('Core "' + id + '": total mass must be finite and greater than zero') === 0), id);
    assert.deepStrictEqual(plain(r.coreMasses), []);
  });
});

t('16. overflow / non-finite aggregates rejected', () => {
  // Mass sum overflows within one core.
  let inp = inputs();
  coreEntry(inp, 'center').components = [
    { mass: 1.5e308, comX: 0, comY: 1, iOwn: 0 }, { mass: 1.5e308, comX: 0, comY: 1, iOwn: 0 }];
  let r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Core "center": total mass must be finite/.test(e)));
  // Mass-weighted sum overflows (m * x = Infinity) though every input is finite.
  inp = inputs();
  coreEntry(inp, 'center').components = [{ mass: 1e200, comX: 1e200, comY: 0, iOwn: 0 }];
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /centre of mass is not finite/.test(e)));
  assert.strictEqual(r.comX, null);
  // Translation overflows (origin + comX).
  inp = inputs();
  inp.geometry.cores[2].origin.x = 1.7e308;
  coreEntry(inp, 'side-right').components[0].comX = 1.7e308;
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Core "side-right" component 0: translated position is not finite/.test(e)));
  // Inertia overflows although mass and COM are finite.
  inp = inputs();
  coreEntry(inp, 'center').components = [
    { mass: 1, comX: 0, comY: 0, iOwn: 1.5e308 }, { mass: 1, comX: 0, comY: 0, iOwn: 1.5e308 }];
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /moment of inertia is not finite/.test(e)));
  assert.strictEqual(r.moi, null);
  // Total mass can overflow although each core is finite.
  inp = inputs();
  ['center', 'side-left', 'side-right'].forEach((id) => {
    coreEntry(inp, id).components = [{ mass: 1e308, comX: 0, comY: 0, iOwn: 0 }];
  });
  r = run(inp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /Aggregate total mass/.test(e)));
});

t('17. pure: needs no browser / simulation globals and references none', () => {
  // Loaded above into vm.createContext({}) — the global object has none of these.
  ['localStorage', 'document', 'window', 'CONFIG', 'stackMassProps', 'combineComponents', 'memberComponents']
    .forEach((n) => assert.strictEqual(vm.runInContext('typeof ' + n, ctx), 'undefined', n));
  // Source, comments stripped, must not mention runtime/global state or non-determinism.
  const code = massSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['localStorage', 'sessionStorage', 'document', 'window', 'CONFIG', 'stackMassProps', 'combineComponents',
    'memberComponents', 'postMessage', 'Worker', 'require(', 'import ', 'fetch(', 'Math.random', 'Date.now', 'new Date',
    'sideCoreCenterlineOffsetM'].forEach((tok) => assert.ok(code.indexOf(tok) < 0, 'must not reference ' + tok));
  // Only the single frozen API global is added to the realm.
  assert.deepStrictEqual(Object.keys(ctx), ['VehicleAssemblyMassProps']);
});

t('integration: consumes a REAL resolveVehicleAssemblyGeometry() result (origins authoritative)', () => {
  const gctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(geoSrcPath, 'utf8'), gctx, { filename: 'vehicleAssemblyGeometry.js' });
  const G = gctx.VehicleAssemblyGeometry;
  const okValidator = () => ({ valid: true, errors: [], stackTotalHeight: 1, stackTotalMass: 1 });
  const g = G.resolveVehicleAssemblyGeometry({
    stackValidator: okValidator,
    assembly: { schemaVersion: 1, type: 'triple-core', centralStackId: 'stk',
      sideCores: [{ slotId: 'left', recordId: 'r' }, { slotId: 'right', recordId: 'r' }] },
    fleet: [
      { id: 'b', stageRole: 'booster', familyId: 'f', width: 3, height: 40 },
      { id: 'r', stageRole: 'rocket', familyId: 'f', width: 2, height: 30, noseHeightM: 4 },
    ],
    stacks: [{ id: 'stk', members: ['b'] }],
    sideCoreCenterlineOffsetM: 5.5,                 // synthetic
  });
  assert.strictEqual(g.valid, true, g.errors.join('; '));
  const r = run({
    geometry: g,
    cores: [
      { instanceId: 'side-right', components: sideComps() },
      { instanceId: 'center', components: centerComps() },
      { instanceId: 'side-left', components: sideComps() },
    ],
  });
  assert.strictEqual(r.valid, true, r.errors.join('; '));
  near(r.comX, 0);
  const left = r.components.find((c) => c.coreInstanceId === 'side-left');
  const right = r.components.find((c) => c.coreInstanceId === 'side-right');
  near(left.comX, -5.5); near(right.comX, 5.5);
  near(r.moi, 100 + 120 * 5.5 * 5.5 + (76120 - (3940 * 3940) / 270));
  // A geometry that failed is rejected (fail closed, no numbers).
  const bad = G.resolveVehicleAssemblyGeometry({ stackValidator: okValidator, sideCoreCenterlineOffsetM: -1 });
  assert.strictEqual(bad.valid, false);
  const rr = run({ geometry: bad, cores: inputs().cores });
  assert.strictEqual(rr.valid, false);
  assert.strictEqual(rr.moi, null);
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
