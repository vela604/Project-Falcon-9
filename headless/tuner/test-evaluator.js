// ============================================================================
// headless/tuner/test-evaluator.js
//
//   node tuner/test-evaluator.js            offline: unit tests + end-to-end test
//                                           against a STUB sim tree (no project needed)
//   node tuner/test-evaluator.js --live     + real-sim smoke tests (needs full project tree):
//                                           raw-default baseline, determinism, 8-worker pool
//
// Offline e2e builds a throw-away project tree in os.tmpdir() whose sim files
// are stubs with an ANALYTIC (Kepler) orbit and a scripted phase schedule, then
// runs the REAL runner.js + hook-sandbox.js + evaluator.js through it. Truth
// values are known in closed form, so this checks the hook math, the runner
// patch, lattice/collapse, scoring and the worker pool.
// ============================================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ev = require('./evaluator');
const cfgPath = ['tuner-config-v3.json', 'tuner-config-v3.js', path.join(__dirname, 'tuner-config-v3.json')]
  .find(p => fs.existsSync(p)) || path.join(__dirname, 'tuner-config-v3.json');
const cfg = ev.loadConfig(cfgPath);

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const noCliff = c => { const k = JSON.parse(JSON.stringify(c)); k.scoring.hardConstraints.circVrAtEndMinMps.enabled = false; return k; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' got ' + a);

// ---------------------------------------------------------------------------
// Unit tests (no sim)
// ---------------------------------------------------------------------------
async function unit() {
  console.log('unit: lattice + collapse');
  const tA = cfg.tunables.find(x => x.id === 'ascent_profile_constant');

  await t('collapse of default A=13.94 lands on lattice', () => {
    const c = ev.collapseAscent(tA, 13.94);
    near(c.G * 100, Math.round(c.G * 100), 1e-9, 'G on 0.01 grid');
    near(c.T / tA.pushTQuantumS, Math.round(c.T / tA.pushTQuantumS), 1e-6, 'T on fine grid');
    near(c.A_eff, 13.94, 13.94 * 0.004, 'A_eff within 0.4% of A');
  });
  await t('A_eff == G*T^2 exactly and ticks are integers', () => {
    for (let A = 9; A <= 20; A += 0.137) {
      const c = ev.collapseAscent(tA, A);
      assert.strictEqual(c.A_eff, c.G * c.T * c.T);
      assert.ok(Number.isInteger(c.Tn) && c.Tn >= 1);
    }
  });
  await t('collapse(A_eff) stays within one lattice neighbour of collapse(A) (report only)', () => {
    let same = 0, n = 0;
    for (let A = 9; A <= 20; A += 0.0137) {
      const c1 = ev.collapseAscent(tA, A), c2 = ev.collapseAscent(tA, c1.A_eff);
      n++; if (c1.Tn === c2.Tn && Math.abs(c1.G - c2.G) < 1e-9) same++;
      assert.ok(Math.abs(c2.A_eff - c1.A_eff) <= c1.A_eff * 0.01, 'feedback drift too large');
    }
    console.log('       A_eff re-collapse is an exact fixed point for ' + (100 * same / n).toFixed(1) + '% of A values');
  });
  await t('direct tunables snap: bias 1e-4, lead integer ticks, meco 1 kg', () => {
    const s = ev.snapValues(cfg, {
      stage_burn_aoa_bias: 0.59004,
      circ_trigger_lead: 5.5301, meco_target_booster_fuel: 52612.4
    });
    assert.strictEqual(s.effective.bias, 0.59);
    assert.strictEqual(s.effective.lead, 442 / 80);        // 5.5301*80 = 442.4 -> 442 ticks
    assert.strictEqual(s.lattice.lead, 442);
    assert.strictEqual(s.effective.meco, 52612);
  });
  await t('missing ids default to config.initial; raw mode keeps 0.60/4.82/5.53', () => {
    const s = ev.snapValues(cfg, {}, { snap: false, ascent_G: 0.60, ascent_T: 4.82 });
    assert.strictEqual(s.simValues['ascent.PUSH_MAX_GIMBAL_DEG'], 0.6);
    assert.strictEqual(s.simValues['ascent.PUSH_T_S'], 4.82);
    assert.strictEqual(s.simValues['insertion.CIRC_TRIGGER_LEAD_S'], 5.53);
    assert.strictEqual(s.simValues['ascent.MECO_TARGET_BOOSTER_FUEL_KG'], 52612);
  });
  await t('payload always carries fixed + all 4 tunables (TARGET_ALT override)', () => {
    const sn = ev.snapValues(cfg, {});
    const p = ev.buildTunablePayload(cfg, sn, 160);
    assert.strictEqual(p.length, cfg.fixed.length + 5);   // 4 tunables write 5 paths
    assert.strictEqual(p.find(x => x.path === 'insertion.TARGET_ORBIT_ALT_KM').value, 160);
    assert.strictEqual(p.find(x => x.path === 'done.DEORBIT_ENABLED').value, false);
  });

  console.log('unit: score hierarchy');
  const good = () => ({
    evalKind: 'full', apogeeKm: 320, perigeeKm: 320, ecc: 0, boosterFuelLeftKg: 52612,
    timeToDeployS: 590, circBurnStarted: true, circMinVr: 0.5, payloadCleared: true,
    stageCrashed: false, deadReason: null, maxQKPa: 30, maxG: 4, stageMaxAltKm: 330
  });
  const sc = m => ev.scoreMetrics(m, cfg).score;
  const meco = cfg.tunables.find(x => x.id === 'meco_target_booster_fuel');
  const fuelW = cfg.scoring.softTerms.find(x => x.id === 'boosterFuelLeftKg').weightPerKg;
  const timeW = cfg.scoring.softTerms.find(x => x.id === 'timeToDeployS').weightPerS;

  await t('orbit error beats fuel: 1 km out of tolerance costs more than the ENTIRE MECO bounds range of fuel', () => {
    const bad = good(); bad.apogeeKm = 320 + 1 + 1;                   // 1 km beyond tolerance
    const fuelBest = good(); fuelBest.boosterFuelLeftKg += (meco.upper - meco.lower);
    assert.ok(sc(bad) - sc(good()) > fuelW * (meco.upper - meco.lower), 'orbit penalty must dominate');
    assert.ok(sc(fuelBest) < sc(good()));
  });
  await t('fuel beats time: 100 kg of fuel outweighs the ENTIRE durationCap of time', () => {
    const moreFuel = good(); moreFuel.boosterFuelLeftKg += 100;
    const slower = good(); slower.timeToDeployS += cfg.mission.durationCapS;
    assert.ok(fuelW * 100 > timeW * cfg.mission.durationCapS, 'weights must satisfy hierarchy');
    assert.ok(sc(moreFuel) < sc(good()) && sc(slower) > sc(good()));
  });
  await t('any hard fail ranks worse than the worst soft score; deeper fail = worse (slope)', () => {
    const awful = good(); awful.apogeeKm = 1e7; awful.perigeeKm = -1e7; awful.ecc = 0.99;
    const crash = good(); crash.stageCrashed = true;
    const crashLow = good(); crashLow.stageCrashed = true; crashLow.stageMaxAltKm = 50;
    const f = m => ev.scoreMetrics(m, cfg);
    assert.ok(f(awful).hardFail === false && f(awful).score < cfg.scoring.failPenalty);
    assert.ok(f(crash).score > f(awful).score);
    assert.ok(f(crashLow).score > f(crash).score, 'lower altitude crash is deeper');
    const a = good(); a.circMinVr = -3; const b = good(); b.circMinVr = -8;
    assert.ok(f(b).score > f(a).score && f(a).hardFail && f(b).hardFail);
  });
  await t('vr dip that recovers is NOT a hard fail: -0.38 m/s costs only a small tie-breaker', () => {
    const m = good(); m.circMinVr = -0.38;
    const r = ev.scoreMetrics(m, cfg), r0 = ev.scoreMetrics(good(), cfg);
    assert.strictEqual(r.hardFail, false);
    near(r.score - r0.score, 0.38 * cfg.scoring.hardConstraints.circMinRadialVelocityMps.softWeightPerMps, 1e-9);
    const deeper = good(); deeper.circMinVr = -1.5;
    assert.ok(ev.scoreMetrics(deeper, cfg).score > r.score, 'deeper dip scores worse');
    // and it can never outweigh a real orbit error:
    const orbit = good(); orbit.apogeeKm = 322;
    assert.ok(ev.scoreMetrics(orbit, cfg).score - r0.score > ev.scoreMetrics(deeper, cfg).score - r0.score);
  });
  await t('cliff safety: circVrAtEnd below min (= 0, sign check only) = graded hard fail (deeper = worse); disabled removes it', () => {
    const cs = cfg.scoring.hardConstraints.circVrAtEndMinMps;
    const a = good(); a.circVrAtEnd = cs.min - 0.02; const b = good(); b.circVrAtEnd = -0.4;
    const ra = ev.scoreMetrics(a, cfg), rb = ev.scoreMetrics(b, cfg);
    assert.ok(ra.hardFail && rb.hardFail && rb.score > ra.score, 'graded');
    assert.ok(ra.failures.some(x => x.id === 'circ_end_vr_below_cliff_margin'));
    const ok = good(); ok.circVrAtEnd = cs.min + 0.001;
    assert.strictEqual(ev.scoreMetrics(ok, cfg).hardFail, false);
    assert.strictEqual(ev.scoreMetrics(a, noCliff(cfg)).hardFail, false);
    assert.strictEqual(cs.min, 0, 'config: circVrAtEndMinMps.min is 0 (no magnitude threshold)');
    const tiny = good(); tiny.circVrAtEnd = 0.0279;                  // run case: small positive vrEnd must NOT hard fail
    assert.strictEqual(ev.scoreMetrics(tiny, cfg).hardFail, false);
    const zero = good(); zero.circVrAtEnd = 0;
    assert.strictEqual(ev.scoreMetrics(zero, cfg).hardFail, false);
  });
  await t('within tolerance => no orbit penalty; calibrated maxQ/maxG limits ARE enforced (Step 3)', () => {
    const hc = cfg.scoring.hardConstraints;
    const m = good(); m.apogeeKm = 320.9; m.perigeeKm = 319.2; m.ecc = 0.0004; m.maxQKPa = hc.maxQKPa.limit - 1; m.maxG = hc.maxG.limit - 0.5;
    const r = ev.scoreMetrics(m, cfg);
    assert.strictEqual(r.hardFail, false);
    assert.strictEqual(r.soft.apogeeErrKm, 0); assert.strictEqual(r.soft.perigeeErrKm, 0); assert.strictEqual(r.soft.eccentricity, 0);
    const q = good(); q.maxQKPa = hc.maxQKPa.limit + 1;
    assert.ok(ev.scoreMetrics(q, cfg).failures.some(x => x.id === 'maxQ'));
    const g = good(); g.maxG = hc.maxG.limit + 1;
    assert.ok(ev.scoreMetrics(g, cfg).failures.some(x => x.id === 'maxG'));
  });
  await t('maxQ enforced once calibrated', () => {
    const c2 = JSON.parse(JSON.stringify(cfg)); c2.scoring.hardConstraints.maxQKPa = { limit: 40 };
    const m = good(); m.maxQKPa = 45;
    const r = ev.scoreMetrics(m, c2);
    assert.ok(r.hardFail && r.failures[0].id === 'maxQ');
  });
  await t('target altitude override moves the orbit targets', () => {
    const m = good(); m.apogeeKm = 160; m.perigeeKm = 160;
    assert.ok(ev.scoreMetrics(m, cfg).score > ev.scoreMetrics(m, cfg, { targetAltKm: 160 }).score);
  });
}

// ---------------------------------------------------------------------------
// Stub project tree (analytic orbit + scripted phases)
// ---------------------------------------------------------------------------
function buildStubTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuner-stub-'));
  const w = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), txt); };
  for (const f of ['runner.js']) w('headless/' + f, fs.readFileSync(path.join(__dirname, '..', f)));
  for (const f of ['evaluator.js', 'eval-worker.js', 'hook-sandbox.js']) w('headless/tuner/' + f, fs.readFileSync(path.join(__dirname, f)));

  w('js/componentLibrary.js', '');
  w('js/customDesign.js', '');
  w('js/fleet.js', 'function loadFleet(){} function loadStacks(){} function loadFamilies(){} function loadPayloads(){} function setSelectedStackId(){} function setSelectedId(){}');
  w('js/config.js', 'const CONFIG = { DT: 1/80, EARTH_RADIUS: 6371000, GM_EARTH: 3.986004418e14, DRAG_CD: 0.3, GIMBAL_MAX_DEG: 5, GIMBAL_RATE_DEG_S: 10, SLOSH_ENABLED: true };');
  w('js/simJs/core/massProps.js', '');
  w('js/simJs/core/environment.js', 'let atmosphereEnabled = true; const wind = {enabled:false,speed:0,directionDeg:0};' +
    'function airDensity(){ return 0; } function earthSurfaceVelocity(){ return {vx:0,vy:0}; } function windInertialVector(){ return {wx:0,wy:0}; }');
  w('js/simJs/core/vehicle.js', STUB_VEHICLE);
  w('js/simJs/core/rcs.js', '');
  w('js/simJs/core/physics.js', STUB_PHYSICS);
  w('js/simJs/core/collision.js', '');
  w('js/simJs/guidance/imu.js', 'function setEnabled(){} function measure(s){ return s; }');
  w('js/simJs/guidance/derivation.js', 'const Derivation = { setStackData(){} };');
  w('js/simJs/guidance/guidercs.js', '');
  w('js/simJs/guidance/guidance-blocks.js', '');
  w('js/simJs/guidance/guidance.js', STUB_GUIDANCE);
  return root;
}

// Truth model --------------------------------------------------------------
const RE = 6371000, MUE = 3.986004418e14;
const ORB = {
  E1: { ra: RE + 320e3,   rp: RE + 200e3,   tApo: 60 },     // stage, before circ burn
  E2: { ra: RE + 320.3e3, rp: RE + 319.6e3, tApo: 48.47 },  // after circ burn (apogee at t=48.47 s)
  E3: { ra: RE + 320.2e3, rp: RE + 319.8e3, tApo: 48.47 }   // payload after eject kick
};
const STUB_COMMON = `
const __RE = ${RE}, __MU = ${MUE};
const __ORB = ${JSON.stringify(ORB)};
function __setOrbit(b, o, t) {
  const a = (o.ra + o.rp) / 2, e = (o.ra - o.rp) / (o.ra + o.rp), n = Math.sqrt(__MU / (a*a*a));
  let M = Math.PI - n * (o.tApo - t);
  M = ((M % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  let E = M; for (let i = 0; i < 60; i++) E = E - (E - e*Math.sin(E) - M) / (1 - e*Math.cos(E));
  const x = a*(Math.cos(E) - e), y = a*Math.sqrt(1 - e*e)*Math.sin(E);
  const r = Math.hypot(x, y), k = Math.sqrt(__MU*a) / r;
  b.rx = x; b.ry = y; b.vx = -k*Math.sin(E); b.vy = k*Math.sqrt(1 - e*e)*Math.cos(E);
}
`;
const STUB_VEHICLE = STUB_COMMON + `
const state = { simTime: 0, activeBodyIndex: 0, halted: false, crashed: false, landed: false, bodies: [] };
function __mkStage() {
  return { id: 'stage', rx: 0, ry: 0, vx: 0, vy: 0, theta: 0, omega: 0, width: 3.7, height: 40,
    dryMass: 100000, fuelMass: 400000, memberFuel: [], crashed: false, landed: false, settled: false,
    isActive: true, isDiscarded: false, payloadReleased: false, members: [{stageRole:'stage'}],
    engines: [{ currentF: 7.6e6, gimbalDeg: 0, massFlowRate: 2500 }] };
}
function resetState() { state.simTime = 0; state.halted = false; state.crashed = false; state.bodies = [__mkStage()]; __setOrbit(state.bodies[0], __ORB.E1, 0); }
`;
const STUB_PHYSICS = `
function physicsStep(dt) {
  state.simTime += dt;
  const t = state.simTime, b = state.bodies[0];
  const lead = Guidance.__lead();
  const burnEnd = 50 - lead, burnStart = burnEnd - 3;
  // thrust / flow script
  b.engines[0].currentF = t < 10 ? 7.6e6 : 0;
  b.engines[0].massFlowRate = (t >= burnStart && t < burnEnd) ? 50 : 0;
  if (t >= 10 && state.bodies.length === 1) state.bodies.push({ id: 'booster', rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy, theta: 0,
      fuelMass: Guidance.__mecoFuel(), crashed: false, members: [{stageRole:'booster'}], engines: [] });
  __setOrbit(b, t < burnEnd ? __ORB.E1 : __ORB.E2, t);
  if (t >= 52 && state.bodies.length === 2) { const p = { id: 'payload', payloadBody: true, crashed: false, members: [], engines: [] }; __setOrbit(p, __ORB.E3, t); state.bodies.push(p); }
  if (state.bodies.length === 3) __setOrbit(state.bodies[2], __ORB.E3, t);
  b.fuelMass = 400000 - 1000 * Math.min(t, 100);
}
`;
const STUB_GUIDANCE = `
const Guidance = (function () {
  const defaults = () => ({ ascent: { PUSH_MAX_GIMBAL_DEG: 0.6, PUSH_T_S: 4.82, MECO_TARGET_BOOSTER_FUEL_KG: 52612 },
                            insertion: { CIRC_TRIGGER_LEAD_S: 5.53 }, done: { DEORBIT_ENABLED: true } });
  let cfg = defaults(), active = null;
  function merge(t, p) { Object.keys(p).forEach(k => { if (p[k] && typeof p[k] === 'object') { t[k] = t[k] || {}; merge(t[k], p[k]); } else t[k] = p[k]; }); }
  function phase() {
    const t = state.simTime, lead = cfg.insertion.CIRC_TRIGGER_LEAD_S, bs = 50 - lead - 3, be = 50 - lead;
    if (t < 10) return 'ASCENT'; if (t < 15) return 'SEPARATED_AXIAL'; if (t < 20) return 'STAGE_BURN';
    if (t < 25) return 'COAST_ROTATE'; if (t < bs - 0.5) return 'COAST_WAIT';
    if (t < be + 0.5) return 'CIRCULARIZE'; if (t < 50) return 'COAST_ROTATE_2'; return 'COAST_HOLD_2';
  }
  return {
    __lead: () => cfg.insertion.CIRC_TRIGGER_LEAD_S,
    __mecoFuel: () => cfg.ascent.MECO_TARGET_BOOSTER_FUEL_KG,
    init() {}, setImuEnabled() {},
    onSnapshot() {},
    startGuide(n) { active = n; return true; }, stopGuide() { active = null; },
    listGuidesWithConfig: () => ['leoInsertionV3'],
    getGuideConfig: () => JSON.parse(JSON.stringify(cfg)),
    applyGuideConfig(n, p) { merge(cfg, p); return true; },
    getGuideStatus() {
      const t = state.simTime;
      return { active, phase: phase(), mecoTriggered: t >= 10, circTriggerLeadS: cfg.insertion.CIRC_TRIGGER_LEAD_S,
        deployCommandSimTime: t >= 50 ? 50 : null, payloadCleared: t >= 52, apogeeKm: 320, perigeeKm: 319.5,
        pushT: cfg.ascent.PUSH_T_S };
    }
  };
})();
`;

// ---------------------------------------------------------------------------
// Stub end-to-end
// ---------------------------------------------------------------------------
async function e2e() {
  console.log('e2e on stub sim (analytic orbit truth)');
  const root = buildStubTree();
  const ev2 = require(path.join(root, 'headless/tuner/evaluator.js'));
  const { runSim } = require(path.join(root, 'headless/runner.js'));
  const base = {};   // defaults (lead 5.53 -> 442.4 ticks -> 442 ticks = 5.525 s)

  await t('runSim backward compatible: no hook options -> hook null, runs to duration', () => {
    const r = runSim({ durationS: 3, quiet: true });
    assert.strictEqual(r.hook, null); assert.strictEqual(r.stoppedEarly, false); assert.strictEqual(r.ticksRun, 240);
  });
  await t('resetGuideConfig restores code defaults of every known key between runs', () => {
    const a = runSim({ durationS: 0.1, quiet: true, tunables: [{ path: 'ascent.PUSH_T_S', value: 9 }] });
    assert.strictEqual(a.status.guideStatus.pushT, 9);
    const b = runSim({ durationS: 0.1, quiet: true });                              // legacy behaviour: leaks
    assert.strictEqual(b.status.guideStatus.pushT, 9);
    const c = runSim({ durationS: 0.1, quiet: true, resetGuideConfig: true });      // opt-in: clean
    assert.strictEqual(c.status.guideStatus.pushT, 4.82);
  });
  await t('extraBootstrapCode cache key uses content hash (different hook code => different instance)', () => {
    const r1 = runSim({ durationS: 0.1, quiet: true, extraBootstrapCode: 'globalThis.__x = 1;' });
    const r2 = runSim({ durationS: 0.1, quiet: true, extraBootstrapCode: 'globalThis.__x = 2;' });
    assert.notStrictEqual(r1.sim, r2.sim);
  });

  let full;
  await t('full eval: metrics match analytic truth', () => {
    full = ev2.evalCore(cfg, base, {});
    const m = full.metrics;
    assert.strictEqual(m.stopReason, 'payloadCleared');
    assert.strictEqual(m.orbitSource, 'payload@cleared');
    near(m.apogeeKm, 320.2, 1e-6, 'payload apogee'); near(m.perigeeKm, 319.8, 1e-6, 'payload perigee');
    near(m.ecc, 0.4e3 / (ORB.E3.ra + ORB.E3.rp), 1e-9, 'ecc');
    near(m.stageDeployApoKm, 320.3, 1e-6); near(m.stageDeployPeriKm, 319.6, 1e-6);
    near(m.boosterFuelLeftKg, 52612, 0, 'booster fuel at split');
    near(m.timeToDeployS, 50, 0);
    assert.ok(m.circBurnStarted && m.circBurnEnded);
    near(m.circBurnS, 3, 0.0126, 'burn duration');
    const burnEndT = full.metrics.phaseT.CIRCULARIZE !== undefined ? 50 - full.effective.lead : NaN;
    near(m.circEndMarginS, 48.47 - burnEndT, 0.0126, 'time-to-apogee at burn end (independent Kepler truth)');
    assert.ok(m.circMinVr > 0, 'vr positive during burn');
    near(m.stageResidualKg, 400000 - 1000 * 52, 1000 * 0.0126 * 4 + 1, 'stage residual at clear');
    assert.ok(full.metrics.ticksRun < cfg.mission.durationCapS * 80, 'stopped early');
  });
  await t('G-load: peak at end of thrust (t~10 s, m=490000 kg) = 1.5816 g', () => {
    near(full.metrics.maxG, 7.6e6 / (490000 * 9.80665), 1e-6);
    near(full.metrics.maxGT, 10, 0.0126);
  });
  await t('peak altitude tracked (stage apogee of E1 at least)', () => assert.ok(full.metrics.stageMaxAltKm >= 320 - 1e-6));
  await t('score: perfect orbit, no penalty, reward = fuel - time term', () => {
    const r = ev2.scoreMetrics(full.metrics, noCliff(cfg));   // stub orbit is circular: vrEnd~0 sits at the cliff by design
    assert.strictEqual(r.hardFail, false);
    near(r.score, -fuelW() * 52612 + timeW() * 50, 1e-9);
  });
  await t('lead=0 => burn ends after apogee => vr dips negative => soft penalty, not hard fail (stub dip is tiny)', () => {
    const r = ev2.evalCore(cfg, { circ_trigger_lead: 0 }, {});
    const s = ev2.scoreMetrics(r.metrics, noCliff(cfg));
    assert.ok(r.metrics.circMinVr < 0, 'vr min ' + r.metrics.circMinVr);
    assert.strictEqual(s.hardFail, false);
    assert.ok(s.soft.circVrDip > 0);
    assert.ok(Number.isFinite(r.metrics.circVrAtEnd));
  });
  await t('monotone: more lead => larger end margin (bisection premise)', () => {
    const ms = [4, 5, 6, 7].map(l => ev2.evalCore(cfg, { circ_trigger_lead: l }, {}).metrics.circEndMarginS);
    for (let i = 1; i < ms.length; i++) assert.ok(ms[i] > ms[i - 1], ms.join(','));
  });
  await t('truncated eval stops at COAST_ROTATE entry with coast orbit (E1 apogee 320 km)', () => {
    const r = ev2.evalCore(cfg, base, { eval: 'truncated' });
    assert.strictEqual(r.metrics.stopReason, 'coastRotate');
    near(r.metrics.coastApoKm, 320, 1e-6); near(r.metrics.coastPeriKm, 200, 1e-6);
    assert.ok(r.metrics.ticksRun < full.metrics.ticksRun);
  });
  await t('coastEnd eval (stride 1): stops at COAST_ROTATE -> COAST_WAIT, exact tick, entry != exit time', () => {
    const r = ev2.evalCore(cfg, base, { eval: 'coastEnd', stride: 1 });
    const m = r.metrics;
    assert.strictEqual(m.evalKind, 'coastEnd');
    assert.strictEqual(m.stopReason, 'coastRotateEnd');
    assert.strictEqual(m.coastEndToPhase, 'COAST_WAIT');
    assert.strictEqual(m.coastEndExactTick, true);
    near(m.coastEndT, 25, 0.0126, 'exit time'); near(m.phaseT.COAST_ROTATE, 20, 0.0126, 'entry time');
    near(m.coastEndApoKm, 320, 1e-6); near(m.coastEndPeriKm, 200, 1e-6);
    near(m.coastEndEcc, 120e3 / (2 * RE + 520e3), 1e-9, 'coastEnd ecc (Kepler truth)');
    assert.ok(Number.isFinite(m.coastEndVr) && Number.isFinite(m.stageFuelAtCoastEndKg));
    // stub E1 passes apogee at t=60 s; coast exit is at t~25.0 => ~35 s to apogee (INNER-2 lead_max)
    near(m.coastEndTToApoS, 60 - m.coastEndT, 1e-3, 'coastEndTToApoS');
    const aE1 = (2 * RE + 520e3) / 2;
    near(m.coastEndPeriodS, 2 * Math.PI * Math.sqrt(aE1 * aE1 * aE1 / MUE), 1e-6, 'coastEndPeriodS');
    assert.ok(m.coastTToApoS > m.coastEndTToApoS, 'entry is earlier than exit => more time to apogee');
    assert.ok(m.stageFuelAtCoastEndKg < m.stageFuelAtCoastKg, 'fuel burns between entry and exit');
    assert.ok(m.ticksRun < full.metrics.ticksRun);
  });
  await t('full eval also records coastEnd (entry vs exit comparable in one run)', () => {
    assert.strictEqual(full.metrics.coastEndToPhase, 'COAST_WAIT');
    // default stride 4 => capture may be up to 3 ticks late (this is WHY the mapper sends stride 1)
    near(full.metrics.coastEndT, 25, 4 * 0.0125 + 1e-6);
    const exact = ev2.evalCore(cfg, base, { stride: 1 }).metrics;
    assert.strictEqual(exact.coastEndExactTick, true); near(exact.coastEndT, 25, 0.0126);
  });
  await t('coastEnd eval: scoreMetrics short-circuits (no crash, score = ecc), pool finalize path ok', async () => {
    const e = ev2.createEvaluator(cfg, { workers: 2 });
    const r = await e.evaluate(base, { eval: 'coastEnd', stride: 1 });
    assert.strictEqual(r.evalKind, 'coastEnd'); assert.strictEqual(r.hardFail, false);
    near(r.score, r.metrics.coastEndEcc, 0);
    const bad = Object.assign({}, r.metrics, { coastEndEcc: null });
    assert.ok(ev2.scoreMetrics(bad, cfg).failures.some(x => x.id === 'no_coast_end'));
    await e.close();
  });
  await t('cache key separates evalKind and stride', async () => {
    const e = ev2.createEvaluator(cfg, { workers: 0 });
    await e.evaluate(base, { eval: 'coastEnd', stride: 1 });
    await e.evaluate(base, { eval: 'coastEnd', stride: 4 });
    await e.evaluate(base, { eval: 'truncated' });
    await e.evaluate(base, { eval: 'coastEnd', stride: 1 });          // hit
    assert.strictEqual(e.cacheStats().size, 3); assert.strictEqual(e.cacheStats().hits, 1);
    await e.close();
  });
  await t('determinism: two evals on the same instance are bit-identical', () => {
    const a = ev2.evalCore(cfg, { stage_burn_aoa_bias: 0.7 }, {}), b = ev2.evalCore(cfg, { stage_burn_aoa_bias: 0.7 }, {});
    delete a.metrics.wallMs; delete b.metrics.wallMs;
    assert.deepStrictEqual(a.metrics, b.metrics);
  });
  await t('worker pool (3 workers): parallel results == in-process, duplicates deduped, cache hits', async () => {
    const e = ev2.createEvaluator(cfg, { workers: 3 });
    const list = [{}, { circ_trigger_lead: 6 }, { circ_trigger_lead: 6.001 }, { circ_trigger_lead: 4 }, {}];  // 6 and 6.001 snap to same tick
    const rs = await e.evaluateMany(list);
    const ref = list.map(v => ev2.evalCore(cfg, v, {}).metrics.circEndMarginS);
    rs.forEach((r, i) => near(r.metrics.circEndMarginS, ref[i], 0, 'row ' + i));
    assert.strictEqual(e.cacheStats().size, 3, 'unique lattice points');
    assert.deepStrictEqual(rs.map(r => r.cached), [false, false, true, false, true]);
    const again = await e.evaluate({ circ_trigger_lead: 4 });
    assert.ok(again.cached);
    await e.close();
  });
  await t('evaluateMany with workers=0 (in-process) works too', async () => {
    const e = ev2.createEvaluator(cfg, { workers: 0 });
    const rs = await e.evaluateMany([{}, {}]);
    assert.strictEqual(rs.length, 2); assert.strictEqual(rs[1].cached, true);
    await e.close();
  });
  fs.rmSync(root, { recursive: true, force: true });
}
const fuelW = () => cfg.scoring.softTerms.find(x => x.id === 'boosterFuelLeftKg').weightPerKg;
const timeW = () => cfg.scoring.softTerms.find(x => x.id === 'timeToDeployS').weightPerS;

// ---------------------------------------------------------------------------
// Live smoke tests against the real sim (project tree required)
// ---------------------------------------------------------------------------
async function live() {
  console.log('live: real sim (this takes a few minutes)');
  const rawOpts = { snap: false, ascent_G: 0.60, ascent_T: 4.82 };
  let a;
  await t('raw defaults full eval completes and prints key metrics', () => {
    a = ev.evalCore(cfg, {}, rawOpts);
    const m = a.metrics;
    console.log('       stop=' + m.stopReason + ' deploy=' + m.timeToDeployS + ' s  apo/peri=' + m.apogeeKm + '/' + m.perigeeKm +
      ' ecc=' + m.ecc + ' src=' + m.orbitSource + '\n       maxQ=' + m.maxQKPa + ' maxG(own)=' + m.maxG + ' maxG(raw sim)=' + m.maxAccelRawG +
      ' circMinVr=' + m.circMinVr + ' endMargin=' + m.circEndMarginS + ' / pre-apo ' + m.circEndMarginPreApoS +
      '\n       booster fuel=' + m.boosterFuelLeftKg + ' stage residual=' + m.stageResidualKg + ' wall=' + m.wallMs.toFixed(0) + ' ms');
    assert.ok(m.payloadCleared, 'payload cleared');
  });
  await t('hook overhead: same ticks with vs without hook (explains eval wall time)', () => {
    const { runSim } = require('../runner');
    const ms = cfg.mission;
    const sn = ev.snapValues(cfg, {}, rawOpts);
    const tun = ev.buildTunablePayload(cfg, sn, ms.targetOrbitAltKm);
    const base = { stackId: ms.stackId, vehicleId: ms.vehicleId, guide: ms.guide, durationS: a.metrics.simEndT,
      environment: ms.environment, fueling: ms.fueling, quiet: true, tunables: tun, resetGuideConfig: true };
    const plain = runSim(base);                                           // no hook (loads sim: first-run cost included)
    const plain2 = runSim(base);                                          // warm instance
    const hooked = runSim(Object.assign({}, base, { extraBootstrapCode: ev.HOOK_CODE, hookOptions: { stopAt: null } }));
    const hooked2 = runSim(Object.assign({}, base, { extraBootstrapCode: ev.HOOK_CODE, hookOptions: { stopAt: null } }));
    console.log('       cores=' + os.cpus().length + ' (' + os.cpus()[0].model + ')  ticks=' + plain2.ticksRun +
      '\n       no hook: ' + plain.wallMs.toFixed(0) + ' ms cold / ' + plain2.wallMs.toFixed(0) + ' ms warm' +
      '\n       hook   : ' + hooked.wallMs.toFixed(0) + ' ms cold / ' + hooked2.wallMs.toFixed(0) + ' ms warm' +
      '\n       hook overhead (warm): ' + (100 * (hooked2.wallMs / plain2.wallMs - 1)).toFixed(1) + ' %');
  });
  await t('determinism: same eval again in-process is bit-identical', () => {
    const b = ev.evalCore(cfg, {}, rawOpts);
    const x = Object.assign({}, a.metrics), y = Object.assign({}, b.metrics); delete x.wallMs; delete y.wallMs;
    assert.deepStrictEqual(x, y);
  });
  await t('8-worker pool: 8 distinct lattice points run in parallel', async () => {
    const e = ev.createEvaluator(cfg, { workers: 8 });
    const t0 = Date.now();
    const rs = await e.evaluateMany([0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ circ_trigger_lead: 5 + i * 0.1 })));
    console.log('       8 evals in ' + (Date.now() - t0) + ' ms');
    assert.strictEqual(rs.length, 8);
    await e.close();
  });
}

(async () => {
  await unit();
  await e2e();
  if (process.argv.includes('--live')) await live();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
