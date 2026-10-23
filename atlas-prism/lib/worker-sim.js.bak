// worker-sim.js — sim instance in a Web Worker.
// Handles: hydrate, runEval, runEvalValues, setupSA, probeBiasCheckpoint, ping.
// Emits progress events so the pool can show per-worker live state.

// ---- localStorage stub ----
self.localStorage = (function () {
  const _data = Object.create(null);
  return {
    getItem(k) { return k in _data ? _data[k] : null; },
    setItem(k, v) { _data[k] = String(v); },
    removeItem(k) { delete _data[k]; },
    clear() { Object.keys(_data).forEach(k => delete _data[k]); },
    get length() { return Object.keys(_data).length; },
    key(i) { return Object.keys(_data)[i] || null; },
    _populate(obj) { Object.keys(obj || {}).forEach(k => { if (obj[k] != null) _data[k] = String(obj[k]); }); }
  };
})();
self.window = self;

// ---- progress emit ----
const _workerTag = 'w' + Math.random().toString(36).slice(2, 6);
let _jobSeq = 0;
function emit(phase, detail) {
  try { self.postMessage({ type: 'progress', tag: _workerTag, phase, detail, ts: Date.now() }); } catch (e) {}
}
function emitCount(detail) {
  // Post a message keyed by seq so user can see per-eval counts live
  self.postMessage({ type: 'progress', tag: _workerTag, phase: 'eval', detail, ts: Date.now(), seq: ++_jobSeq });
}

// ---- sim load ----
let _loaded = false;
let _bootError = null;
function _loadSim() {
  if (_loaded) return;
  try {
    importScripts(
      '../../js/componentLibrary.js',
      '../../js/customDesign.js',
      '../../js/fleet.js',
      '../../js/config.js',
      '../../js/simJs/core/massProps.js',
      '../../js/simJs/core/environment.js',
      '../../js/simJs/core/vehicle.js',
      '../../js/simJs/core/rcs.js',
      '../../js/simJs/core/physics.js',
      '../../js/simJs/core/collision.js',
      '../../js/simJs/guidance/imu.js',
      '../../js/simJs/guidance/derivation.js',
      '../../js/simJs/guidance/guidercs.js',
      '../../js/simJs/guidance/guidance-blocks.js',
      '../../js/simJs/guidance/guidance.js',
      '../../js/guideConfigDefaults.js',
      '../lib/config.js',
      '../lib/sim.js',
      '../lib/lattice.js',
      '../lib/hook.js',
      '../lib/registry.js',
      '../lib/primitives.js',
      '../engines/pro-alpha.js'
    );
    if (typeof TunerEngine === 'undefined') throw new Error('TunerEngine not loaded');
    TunerEngine.init();
    _loaded = true;
  } catch (e) {
    _bootError = (e && e.message) || String(e);
    throw e;
  }
}

// ---- snapshot helpers ----
function deepClone(x, memo) {
  memo = memo || new WeakMap();
  if (x === null || typeof x !== 'object') return x;
  if (memo.has(x)) return memo.get(x);
  if (Array.isArray(x)) { const a = []; memo.set(x, a); for (let i = 0; i < x.length; i++) a[i] = deepClone(x[i], memo); return a; }
  const o = {}; memo.set(x, o); for (const k of Object.keys(x)) o[k] = deepClone(x[k], memo); return o;
}

let _saSnapshot = null;

function captureSnap() {
  const st = {};
  Object.keys(state).forEach(k => { if (k === 'bodies') return; try { st[k] = deepClone(state[k]); } catch (e) { st[k] = null; } });
  return {
    bodies: deepClone(state.bodies),
    stateKeysSnapshot: st,
    simTime: state.simTime,
    activeBodyIndex: state.activeBodyIndex,
    guidanceState: Guidance.exportGuideState(),
  };
}

function restoreSnap(snap, biasOverride, leadOverride, mecoOverride) {
  Object.keys(snap.stateKeysSnapshot).forEach(k => {
    try { state[k] = deepClone(snap.stateKeysSnapshot[k]); } catch (e) {}
  });
  state.simTime = snap.simTime;
  state.activeBodyIndex = snap.activeBodyIndex;
  const sb = snap.bodies;
  while (state.bodies.length > sb.length) state.bodies.pop();
  while (state.bodies.length < sb.length) state.bodies.push({});
  for (let i = 0; i < sb.length; i++) {
    const src = sb[i], dst = state.bodies[i];
    Object.keys(dst).forEach(k => { delete dst[k]; });
    Object.keys(src).forEach(k => { dst[k] = deepClone(src[k]); });
  }
  const ab = state.bodies[state.activeBodyIndex];
  if (ab) ['rx','ry','vx','vy','theta','omega','dryMass','fuelMass'].forEach(k => {
    try { state[k] = ab[k]; } catch (e) {}
  });
  for (const b of state.bodies) {
    if (!b || !b.members || !b.members.length) continue;
    if (b._lastBottomMember && b._lastBottomMember.id) {
      const m = b.members.find(mm => mm && mm.id === b._lastBottomMember.id);
      if (m) b._lastBottomMember = m;
    }
  }
  const g = deepClone(snap.guidanceState);
  if (mecoOverride != null) {
    if (g.guideConfigs && g.guideConfigs.leoInsertionV3 && g.guideConfigs.leoInsertionV3.ascent) {
      g.guideConfigs.leoInsertionV3.ascent.MECO_TARGET_BOOSTER_FUEL_KG = mecoOverride;
    }
    if (g.v3AscentBlock && g.v3AscentBlock.constants) g.v3AscentBlock.constants.MECO_TARGET_BOOSTER_FUEL_KG = mecoOverride;
  }
  if (biasOverride != null && g.guideConfigs && g.guideConfigs.leoInsertionV3 && g.guideConfigs.leoInsertionV3.insertion) {
    g.guideConfigs.leoInsertionV3.insertion.STAGE_BURN_AOA_BIAS_DEG = biasOverride;
  }
  if (leadOverride != null && g.guideConfigs && g.guideConfigs.leoInsertionV3 && g.guideConfigs.leoInsertionV3.insertion) {
    g.guideConfigs.leoInsertionV3.insertion.CIRC_TRIGGER_LEAD_S = leadOverride;
  }
  if (g.v3InsertionBlock && g.v3InsertionBlock.constants) {
    if (biasOverride != null) g.v3InsertionBlock.constants.STAGE_BURN_AOA_BIAS_DEG = biasOverride;
    if (leadOverride != null) {
      g.v3InsertionBlock.constants.CIRC_TRIGGER_LEAD_S = leadOverride;
      if (g.v3InsertionBlock.st) delete g.v3InsertionBlock.st._circLeadCached;
    }
  }
  Guidance.importGuideState(g);
}

function phaseNow() {
  const gs = Guidance.getGuideStatus();
  return gs && gs.phase;
}

async function tickUntilCleared(maxS) {
  const maxTicks = Math.ceil(maxS / CONFIG.DT);
  for (let i = 0; i < maxTicks; i++) {
    if (state.halted) return { ok: false, reason: 'halted', simTime: state.simTime, gs: Guidance.getGuideStatus() };
    TunerEngine.tick(CONFIG.DT);
    const gs = Guidance.getGuideStatus();
    if (gs && gs.payloadCleared) return { ok: true, simTime: state.simTime, gs };
  }
  return { ok: false, reason: 'cap', simTime: state.simTime, gs: Guidance.getGuideStatus() };
}

async function tickUntilPhase(targetPhases, maxS) {
  const maxTicks = Math.ceil(maxS / CONFIG.DT);
  for (let i = 0; i < maxTicks; i++) {
    if (state.halted) return false;
    TunerEngine.tick(CONFIG.DT);
    const ph = phaseNow();
    if (targetPhases.indexOf(ph) >= 0) return true;
  }
  return false;
}

function findStageBody() {
  for (const b of state.bodies) {
    if (b && !b.payloadBody && !b.fairingHalf && b.members && b.members[0] && b.members[0].stageRole === 'stage') return b;
  }
  return null;
}

function extractCircMetrics() {
  const stb = findStageBody();
  if (!stb) return { vrEnd: NaN, marginS: NaN, vrMin: NaN };
  const r = Math.hypot(stb.rx, stb.ry);
  const vr = (stb.vx * stb.rx + stb.vy * stb.ry) / r;
  const vt = (stb.vx * stb.ry - stb.vy * stb.rx) / r;
  const GM = CONFIG.GM_EARTH;
  const E = 0.5 * (vr * vr + vt * vt) - GM / r;
  let per = 0, tApo = Infinity;
  if (E < 0) {
    const a = -GM / (2 * E);
    per = 2 * Math.PI * Math.sqrt(a * a * a / GM);
    const h = r * vt;
    const eSq = 1 + 2 * E * h * h / (GM * GM);
    const e = Math.sqrt(Math.max(0, eSq));
    if (e < 1e-9) tApo = Math.PI * Math.sqrt(a * a * a / GM);
    else {
      const cosE = (1 - r / a) / e;
      const sinE = (r * vr) / (e * Math.sqrt(GM * a));
      let Ean = Math.atan2(sinE, cosE);
      if (Ean < 0) Ean += 2 * Math.PI;
      const M = Ean - e * Math.sin(Ean);
      const n = Math.sqrt(GM / (a * a * a));
      tApo = M < Math.PI ? (Math.PI - M) / n : (3 * Math.PI - M) / n;
    }
  }
  const marginS = vr < 0 ? (tApo - per) : tApo;
  return { vrEnd: vr, marginS, vrMin: -1, tApo, per };
}



// ---- Step 1: portability-test helpers (ladder / fingerprint / scan) ----
let _ladder = [];
function scanSnap(x) {
  const out = { fn: 0, sym: 0, nan: 0, inf: 0, nonPlain: 0, nodes: 0, paths: [] };
  const seen = new WeakSet();
  (function w(v, p) {
    const t = typeof v;
    if (t === 'function') { out.fn++; if (out.paths.length < 12) out.paths.push('fn@' + p); return; }
    if (t === 'symbol') { out.sym++; return; }
    if (t === 'number') { if (Number.isNaN(v)) out.nan++; else if (!Number.isFinite(v)) out.inf++; return; }
    if (v === null || t !== 'object') return;
    if (seen.has(v)) return; seen.add(v); out.nodes++;
    const pr = Object.getPrototypeOf(v);
    if (pr !== Object.prototype && pr !== Array.prototype && pr !== null) { out.nonPlain++; if (out.paths.length < 12) out.paths.push('proto@' + p); }
    for (const k of Object.keys(v)) w(v[k], p + '.' + k);
  })(x, '');
  return out;
}
// Same spool/residual formula as ascent block _checkMeco: snapshot is valid for MECO target M iff residualProj > M.
function mecoResidual() {
  const b = state.bodies[0]; if (!b) return NaN;
  let spool = 0;
  (b.engines || []).forEach(e => {
    const mf = e.massFlowRate || 0, mM = e.maxMassFlowRate || 0;
    if (mf > 0 && mM > 0) { const sd = (Number.isFinite(e.shutdownDurationS) && e.shutdownDurationS > 0) ? e.shutdownDurationS : 1.2; spool += (mf * (mf * sd / mM)) / 2; }
  });
  const f = (Array.isArray(b.memberFuel) && Number.isFinite(b.memberFuel[0])) ? b.memberFuel[0] : 0;
  return f - spool;
}
function fingerprint() {
  const f = { simTime: state.simTime, nb: state.bodies.length };
  state.bodies.forEach((b, i) => {
    if (!b) return;
    ['rx','ry','vx','vy','theta','omega','fuelMass','dryMass'].forEach(k => { f['b' + i + '.' + k] = b[k]; });
    (b.engines || []).forEach((e, j) => { f['b' + i + 'e' + j + '.mf'] = e.massFlowRate; f['b' + i + 'e' + j + '.g'] = e.gimbalDeg; });
  });
  return f;
}
async function runToCW(tCheck, capS) {
  const fp = {}, ol = console.log; console.log = function () {};
  try {
    let got = false;
    const n = Math.ceil(capS / CONFIG.DT);
    for (let i = 0; i < n; i++) {
      if (state.halted) break;
      TunerEngine.tick(CONFIG.DT);
      if (!got && state.simTime >= tCheck) { fp.check = fingerprint(); got = true; }
      const gs = Guidance.getGuideStatus();
      if (gs && gs.phase === 'COAST_WAIT') {
        fp.cw = fingerprint();
        const stb = findStageBody();
        if (stb) { const o = TunerHook.orbitOf(stb, CONFIG.GM_EARTH, CONFIG.EARTH_RADIUS); fp.cw.eCoast = o.ecc; fp.cw.tToApo = o.tToApo; fp.cw.apoKm = o.apoKm; fp.cw.periKm = o.periKm; }
        fp.cw.coastDeltaV = gs.coastDeltaV;
        break;
      }
    }
    fp.reached = !!fp.cw;
    return fp;
  } finally { console.log = ol; }
}


// ---- PROF (telemetry only; sim results untouched). Set PROF_ON=false to remove all overhead. ----
// PROF_BENCH adds ~0.3 s once per setupSA (micro-benchmark on the SA snapshot); set false after measuring.
const PROF_ON = true, PROF_BENCH = true;
// Far-body dormancy (booster/fairings skipped once >100 km from the stage). Verified IDENTICAL (RUN DORMANT VERIFY, 3 param sets). Set false to disable.
const DORMANT_ON = true;
let _tk = 0;   // tick counter (incremented in the ops wrapper)
const _P = { restore: 0, capture: 0, prep: 0, job: 0, ch: 0, chT: 0, circ: 0, circT: 0, full: 0, fullT: 0 };
function _flushProf() {
  if (!PROF_ON) return;
  const d = {}; let any = false;
  for (const k in _P) { if (_P[k]) { d[k] = _P[k]; any = true; _P[k] = 0; } }
  if (any) { try { self.postMessage({ type: 'prof', tag: _workerTag, d }); } catch (e) {} }
}
function _installProf() {
  if (!PROF_ON || self.__profWrapped) return;
  try {
    const rs = restoreSnap, cs = captureSnap, pr = TunerEngine.prepareRun;
    restoreSnap = function () { const t = performance.now(); try { return rs.apply(this, arguments); } finally { _P.restore += performance.now() - t; } };
    captureSnap = function () { const t = performance.now(); try { return cs.apply(this, arguments); } finally { _P.capture += performance.now() - t; } };
    TunerEngine.prepareRun = function () { const t = performance.now(); try { return pr.apply(this, arguments); } finally { _P.prep += performance.now() - t; } };
    self.__profRaw = { rs, cs };
    self.__profWrapped = true;
  } catch (e) {}
}
// Micro-benchmark from the SA snapshot (state is restored to SA afterwards; every later job starts with prepareRun/restoreSnap anyway).
function _bench() {
  const B = {}, sv = Object.assign({}, _P), ol = console.log; console.log = function () {};
  const raw = (self.__profRaw || {}), rs = raw.rs || restoreSnap, cs = raw.cs || captureSnap;
  const tick = TunerEngine.__rawTick || TunerEngine.tick;   // unwrapped: bench ticks are not counted as ops
  try {
    const per = (fn, n) => { const a = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - a) / n; };
    B.gsUs = per(() => Guidance.getGuideStatus(), 2000) * 1000;
    B.capMs = per(() => cs(), 5);
    B.resMs = per(() => rs(_saSnapshot, null, null, null), 5);
    try { B.snapKB = JSON.stringify(_saSnapshot).length / 1024; } catch (e) { B.snapKB = -1; }
    const N = 500;
    rs(_saSnapshot, null, null, null);
    let a = performance.now(), n = 0;
    for (; n < N; n++) { if (state.halted) break; tick.call(TunerEngine, CONFIG.DT); }
    B.tickUs = (performance.now() - a) / Math.max(1, n) * 1000;
    rs(_saSnapshot, null, null, null);
    a = performance.now(); n = 0;
    for (; n < N; n++) { if (state.halted) break; tick.call(TunerEngine, CONFIG.DT); Guidance.getGuideStatus(); }
    B.tickGsUs = (performance.now() - a) / Math.max(1, n) * 1000;
    rs(_saSnapshot, null, null, null);
  } catch (e) { B.err = (e && e.message) || String(e); }
  finally { console.log = ol; Object.assign(_P, sv); }
  try { self.postMessage({ type: 'prof', tag: _workerTag, bench: B }); } catch (e) {}
}

// Fixed-work loop shapes for the standalone bench page (sereno-bench.html). Telemetry only: starts from the SA snapshot, leaves state at SA.
function _benchLoop(N, values) {
  const R = {}, sv = Object.assign({}, _P), ol = console.log; console.log = function () {};
  const raw = self.__profRaw || {}, rs = raw.rs || restoreSnap, cs = raw.cs || captureSnap;
  const tick = (TunerEngine.__rawTick || TunerEngine.tick).bind(TunerEngine), dt = CONFIG.DT;
  const run = (name, snap, step) => {
    rs(snap, null, null, null);
    const a = performance.now(); let n = 0;
    for (; n < N; n++) { if (state.halted) break; step(); }
    R[name] = (performance.now() - a) / Math.max(1, n) * 1000; R[name + 'N'] = n;
  };
  try {
    run('raw', _saSnapshot, () => tick(dt));
    run('gs', _saSnapshot, () => { tick(dt); Guidance.getGuideStatus(); });
    run('circ', _saSnapshot, () => { tick(dt); const gs = Guidance.getGuideStatus(); const stb = findStageBody(); if (stb && gs) Math.hypot(stb.rx, stb.ry); });
    // advance to COAST_WAIT (stage burn + rotate), then the same shapes in coast
    rs(_saSnapshot, null, null, null);
    const t0 = performance.now(); let k = 0, cw = false;
    for (; k < 45000; k++) { if (state.halted) break; tick(dt); const g = Guidance.getGuideStatus(); if (g && g.phase === 'COAST_WAIT') { cw = true; break; } }
    R.toCoastMs = performance.now() - t0; R.toCoastTicks = k; R.coastReached = cw;
    if (cw) {
      const snapCW = cs();
      run('cwRaw', snapCW, () => tick(dt));
      run('cwGs', snapCW, () => { tick(dt); Guidance.getGuideStatus(); });
      // tuneLead-eval shape: restore + 400 ticks (gs + findStageBody), x5
      const a = performance.now(); let n = 0;
      for (let r = 0; r < 5; r++) { rs(snapCW, 1.8, 5.5, null); for (let i = 0; i < 400; i++) { if (state.halted) break; tick(dt); Guidance.getGuideStatus(); findStageBody(); n++; } }
      R.cycle = (performance.now() - a) / Math.max(1, n) * 1000; R.cycleN = n;
    }
    rs(_saSnapshot, null, null, null);
    if (values) { const a = performance.now(); TunerEngine.prepareRun(TunerConfig.guideName, values, TunerConfig.env); R.prepMs = performance.now() - a; }
  } catch (e) { R.err = (e && e.message) || String(e); }
  finally { console.log = ol; Object.assign(_P, sv); }
  R.tag = _workerTag;
  return R;
}

// ---- EXPERIMENT (telemetry only, never shipped): where does a coast tick go, and what would dropping the extra bodies save? ----
// Starts from the SA snapshot, runs to COAST_WAIT, then measures from that point. State is left dirty; every later job restores anyway.
function _benchExp(N, values) {
  const R = { perBody: [] }, sv = Object.assign({}, _P), ol = console.log; console.log = function () {};
  const raw = self.__profRaw || {}, rs = raw.rs || restoreSnap, cs = raw.cs || captureSnap;
  const tick = (TunerEngine.__rawTick || TunerEngine.tick).bind(TunerEngine), dt = CONFIG.DT;
  const T = (fn, n) => { const a = performance.now(); let i = 0; for (; i < n; i++) { if (state.halted) break; fn(); } return (performance.now() - a) / Math.max(1, i) * 1000; };   // us per call
  const role = (b) => !b ? '?' : b.fairingHalf ? 'fairing' : b.payloadBody ? 'payload' : (b.members && b.members[0] && b.members[0].stageRole) || 'free';
  try {
    rs(_saSnapshot, null, null, null);
    let k = 0, cw = false;
    for (; k < 45000; k++) { if (state.halted) break; tick(dt); const g = Guidance.getGuideStatus(); if (g && g.phase === 'COAST_WAIT') { cw = true; break; } }
    R.coastReached = cw; R.toCoastTicks = k;
    if (!cw) return R;
    const snapCW = cs();
    const back = () => rs(snapCW, 1.8, 5.5, null);
    back();
    R.nBodies = state.bodies.length; R.roles = state.bodies.map(role).join(',');

    // 1. tick decomposition (all bodies)
    back(); R.physOnly = T(() => physicsStep(dt), N);
    back(); R.physSnap = T(() => { physicsStep(dt); TunerEngine.buildSnapshot(); }, N);
    back(); R.tickAll = T(() => tick(dt), N);
    back(); R.tickAllGs = T(() => { tick(dt); Guidance.getGuideStatus(); }, N);

    // 2. per-function, per-body micro timings (same inputs repeated; state restored afterwards)
    back();
    const K = 1000, groundR = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
    const safe = (f) => { try { return f(); } catch (e) { return NaN; } };
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i], o = { role: role(b), members: (b.members || []).length };
      const g = currentGeometry(b);
      const ex = { Fx: 0, Fy: 0, torque: 0, M: g.M, I: g.I, comH: g.comH, comW: g.comW || 0, height: _bodyHeightOf(b), aero: null, gridFins: null, _lastAero: null, _tickAero: null };
      ex.aero = bodyAeroProfile(b); ex.gridFins = bodyGridFinProfile(b, ex.aero);
      ex._tickAero = computeDragAero(b, ex);
      o.currentGeometry = safe(() => T(() => currentGeometry(b), K));
      o.buildPodEntries = safe(() => T(() => buildPodEntries(b), K));
      o.fillGeom = safe(() => T(() => bottomTankFillGeometry(b), K));
      o.slosh = safe(() => T(() => applySloshStep(b, dt, false), K));
      o.thrust = safe(() => T(() => computeMainThrustForBody(b, g.comH, g.comW), K));
      o.rcs = safe(() => T(() => computeRCSForBody(b, g.comH, g.comW, dt), K));
      o.drag = safe(() => T(() => computeDragAero(b, ex), K));
      o.deriv = safe(() => T(() => derivatives(b, ex), K));
      o.ground = safe(() => T(() => resolveGroundContact(b, groundR, g), K));
      o.lowAlt = safe(() => T(() => _lowestPointAltitude(b, groundR), K));
      R.perBody.push(o);
    }
    R.collision = safe(() => T(() => narrowPhaseCollisionContacts(broadPhaseCollisionPairs()), K));
    R.buildSnap = safe(() => T(() => TunerEngine.buildSnapshot(), K));
    const snap = TunerEngine.buildSnapshot();
    R.onSnap = safe(() => T(() => Guidance.onSnapshot(snap), K));
    R.gs = safe(() => T(() => Guidance.getGuideStatus(), K));

    // 3. what if only the stage body existed in coast? (changes the sim: experiment only)
    back();
    const si = state.bodies.findIndex((b) => role(b) === 'stage');
    R.stageIdx = si;
    if (si >= 0) {
      state.bodies = [state.bodies[si]]; state.activeBodyIndex = 0;
      R.oneBodyPhys = T(() => physicsStep(dt), N);
      back(); state.bodies = [state.bodies[si]]; state.activeBodyIndex = 0;
      R.oneBodyTickGs = T(() => { tick(dt); Guidance.getGuideStatus(); }, N);
    }
  } catch (e) { R.err = (e && e.message) || String(e); }
  finally { console.log = ol; Object.assign(_P, sv); try { rs(_saSnapshot, null, null, null); } catch (e) {} }
  R.tag = _workerTag;
  return R;
}


// ---- VERIFY (telemetry only, never shipped): after COAST_WAIT, is the stage trajectory independent of booster/fairings? ----
// Runs from the COAST_WAIT snapshot: A (all bodies), A2 (control, same as A), B (stage body only). Hashes the stage state every tick (bit-exact).
function _benchVerify(maxTicks) {
  const R = {}, sv = Object.assign({}, _P), ol = console.log; console.log = function () {};
  const raw = self.__profRaw || {}, rs = raw.rs || restoreSnap, cs = raw.cs || captureSnap;
  const tick = (TunerEngine.__rawTick || TunerEngine.tick).bind(TunerEngine), dt = CONFIG.DT;
  const dv = new DataView(new ArrayBuffer(8)), KEYS = ['rx', 'ry', 'vx', 'vy', 'theta', 'omega'];
  const isStage = (b) => b && !b.payloadBody && !b.fairingHalf && b.members && b.members[0] && b.members[0].stageRole === 'stage';
  const role = (b) => !b ? '?' : b.fairingHalf ? 'fairing' : b.payloadBody ? 'payload' : isStage(b) ? 'stage' : 'booster';
  try {
    rs(_saSnapshot, null, null, null);
    let k = 0, cw = false;
    for (; k < 45000; k++) { if (state.halted) break; tick(dt); const g = Guidance.getGuideStatus(); if (g && g.phase === 'COAST_WAIT') { cw = true; break; } }
    R.coastReached = cw;
    if (!cw) return R;
    const snapCW = cs();
    const run = (mode) => {
      rs(snapCW, 1.8, 5.5, null);
      if (mode === 'stage') { const si = state.bodies.findIndex(isStage); state.bodies = [state.bodies[si]]; state.activeBodyIndex = 0; }
      let h = 2166136261 >>> 0, n = 0, ph = '', stopAt = -1, gs = null;
      const cps = [], phases = [], gaps = new Map(), contacts = { ticks: 0, pairs: {} };
      const t0 = performance.now();
      for (; n < maxTicks; n++) {
        if (state.halted) break;
        tick(dt);
        gs = Guidance.getGuideStatus(); const phase = gs && gs.phase;
        const st = findStageBody();
        if (st) for (let q = 0; q < 6; q++) { dv.setFloat64(0, st[KEYS[q]]); h = Math.imul(h ^ dv.getUint32(0), 16777619); h = Math.imul(h ^ dv.getUint32(4), 16777619); }
        if ((n % 100) === 99) cps.push(h >>> 0);
        if (phase !== ph) { ph = phase; phases.push(n + ':' + phase); }
        if (mode === 'gap' && st) {
          try {
            const c0 = _bodyBoundingCenter(st), r0 = _bodyBoundingRadius(st);
            for (const b of state.bodies) {
              if (b === st) continue;
              const c = _bodyBoundingCenter(b), gap = Math.hypot(c.x - c0.x, c.y - c0.y) - (_bodyBoundingRadius(b) + r0);
              let m = gaps.get(b); if (!m) { m = { role: role(b), first: gap, firstTick: n, min: gap, minTick: n, last: gap }; gaps.set(b, m); }
              if (gap < m.min) { m.min = gap; m.minTick = n; } m.last = gap;
            }
            const cc = state.collisionContacts;
            if (cc && cc.length) { contacts.ticks++; for (const c of cc) { const key = role(state.bodies[c.i]) + '-' + role(state.bodies[c.j]); contacts.pairs[key] = (contacts.pairs[key] || 0) + 1; } }
          } catch (e) { contacts.err = (e && e.message) || String(e); }
        }
        if (stopAt < 0 && phase === 'DONE') stopAt = n + 300;
        if (stopAt >= 0 && n >= stopAt) break;
      }
      const st = findStageBody(), fs = {};
      if (st) KEYS.forEach((q) => { fs[q] = st[q]; });
      const pick = {}; if (gs) ['phase', 'coastDeltaV', 'circErr', 'apogeeKm', 'perigeeKm', 'circAchieved', 'payloadCleared'].forEach((q) => { pick[q] = gs[q]; });
      return { n, h: h >>> 0, cps, phases, fs, gs: pick, ms: performance.now() - t0, gaps: Array.from(gaps.values()), contacts, nb: state.bodies.length, simTime: state.simTime };
    };
    const A = run('gap'), A2 = run('full'), B = run('stage');
    const first = (x, y) => { const m = Math.min(x.cps.length, y.cps.length); for (let i = 0; i < m; i++) if (x.cps[i] !== y.cps[i]) return (i + 1) * 100; return (x.cps.length !== y.cps.length || x.n !== y.n) ? -2 : -1; };
    R.A = A; R.A2 = A2; R.B = B;
    R.divAA2 = first(A, A2); R.divAB = first(A, B);   // -1 identical, -2 lengths differ, else tick (<=)
    R.gsEqAB = JSON.stringify(A.gs) === JSON.stringify(B.gs); R.fsEqAB = JSON.stringify(A.fs) === JSON.stringify(B.fs);
    R.phasesEqAB = JSON.stringify(A.phases) === JSON.stringify(B.phases);
  } catch (e) { R.err = (e && e.message) || String(e); }
  finally { console.log = ol; Object.assign(_P, sv); try { rs(_saSnapshot, null, null, null); } catch (e) {} }
  R.tag = _workerTag;
  return R;
}


// ---- DORMANT VERIFY (telemetry only): SA -> DONE, dormancy off vs on, bit-exact stage hash ----
function _benchDormant(maxTicks) {
  const R = { sets: [] }, sv = Object.assign({}, _P), ol = console.log; console.log = function () {};
  const raw = self.__profRaw || {}, rs = raw.rs || restoreSnap;
  const tick = (TunerEngine.__rawTick || TunerEngine.tick).bind(TunerEngine), dt = CONFIG.DT;
  const dv = new DataView(new ArrayBuffer(8)), KEYS = ['rx', 'ry', 'vx', 'vy', 'theta', 'omega', 'fuelMass', 'dryMass'];
  const mix = (h, x) => { dv.setFloat64(0, x); h = Math.imul(h ^ dv.getUint32(0), 16777619); return Math.imul(h ^ dv.getUint32(4), 16777619); };
  const run = (ov, on, every) => {
    rs(_saSnapshot, ov[0], ov[1], ov[2]);
    TunerEngine.setDormant(on, 100000, every);
    let h = 2166136261 >>> 0, hp = 2166136261 >>> 0, n = 0, stopAt = -1, gs = null; const dorm = {}; const t0 = performance.now();
    for (; n < maxTicks; n++) {
      if (state.halted) break;
      tick(dt);
      gs = Guidance.getGuideStatus(); const phase = gs && gs.phase;
      const st = findStageBody();
      if (st) for (let q = 0; q < KEYS.length; q++) h = mix(h, st[KEYS[q]]);
      if ((n & 63) === 0) for (let i = 0; i < state.bodies.length; i++) { const b = state.bodies[i]; if (b && b.dormant && dorm[i] === undefined) dorm[i] = n; }
      if (stopAt < 0 && phase === 'DONE') stopAt = n + 300;
      if (stopAt >= 0 && n >= stopAt) break;
    }
    const ms = performance.now() - t0;
    for (const b of state.bodies) if (b && b.payloadBody) for (let q = 0; q < KEYS.length; q++) hp = mix(hp, b[KEYS[q]]);
    const pick = {}; if (gs) ['phase', 'coastDeltaV', 'circErr', 'apogeeKm', 'perigeeKm', 'circAchieved', 'payloadCleared'].forEach((q) => { pick[q] = gs[q]; });
    return { n, h: h >>> 0, hp: hp >>> 0, ms, gs: pick, dorm, nb: state.bodies.length };
  };
  const eq = (a, b) => a.n === b.n && a.h === b.h && a.hp === b.hp && JSON.stringify(a.gs) === JSON.stringify(b.gs);
  try {
    const sets = [[null, null, null], [1.8, 5.5, null], [0.5, 3.0, null]];
    sets.forEach((ov, si) => {
      const off = run(ov, false, 200), on = run(ov, true, 200);
      const S = { ov, off, on, eqOn: eq(off, on) };
      if (si === 0) { const on37 = run(ov, true, 37); S.on37 = on37; S.eqOn37 = eq(off, on37); }
      R.sets.push(S);
    });
  } catch (e) { R.err = (e && e.message) || String(e); }
  finally { console.log = ol; Object.assign(_P, sv); try { TunerEngine.setDormant(DORMANT_ON); rs(_saSnapshot, null, null, null); } catch (e) {} }
  R.tag = _workerTag;
  return R;
}

// ---- ops counter (telemetry only; no effect on sim results) ----
// Counts TunerEngine.tick calls and posts throttled deltas: { type:'ops', tag, n }.
let _opsAcc = 0, _simAcc = 0, _opsT = 0;
function _flushOps() {
  const n = _opsAcc; if (!n) return;
  const sim = _simAcc; _opsAcc = 0; _simAcc = 0; _opsT = Date.now();
  try { self.postMessage({ type: 'ops', tag: _workerTag, n, s: sim }); } catch (e) {}
}
function _installOps() {
  try {
    const E = (typeof TunerEngine !== 'undefined') ? TunerEngine : null;
    if (!E || E.__opsWrapped || typeof E.tick !== 'function') return;
    const t = E.tick;
    E.tick = function () {
      _tk++;
      _simAcc += +arguments[0] || 0;   // tick(dt): dt = simulated seconds
      if ((++_opsAcc & 255) === 0 && Date.now() - _opsT > 250) _flushOps();
      return t.apply(this, arguments);
    };
    E.__opsWrapped = true;
    E.__rawTick = t;
  } catch (e) {}
}

// ---- message handler ----
self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type, payload } = msg;

  if (type === 'hydrate') {
    self.localStorage._populate(payload && payload.keys);
    try {
      _loadSim();
      _installOps();
      _installProf();
      if (DORMANT_ON) { try { TunerEngine.setDormant(true); } catch (e) {} }
      self.postMessage({ type: 'ready', tag: _workerTag });
    } catch (err) {
      self.postMessage({ type: 'ready', error: _bootError, tag: _workerTag });
    }
    return;
  }
  if (!_loaded) {
    self.postMessage({ id, ok: false, error: 'sim not loaded' });
    return;
  }

  try {
    const _job = async (type, payload) => {
    let result;

    if (type === 'runEval') {
      result = await TunerHook.runEval(payload.point, payload.opts || {});
    } else if (type === 'runEvalValues') {
      result = await TunerHook.runEvalValues(payload.values, payload.opts || {});
    } else if (type === 'saRun') {
      // Level 2: COAST_WAIT_ENTRY-style eval with SA snapshot sharing.
      //   no payload.snap -> live run (same as runEval) that captures the SA checkpoint on the way; returns { metrics, snap }
      //                      (snap null if the run ended before SA: metrics are then bias-independent and final)
      //   payload.snap    -> restore SA checkpoint (+ this point's bias/lead), continue; returns { metrics }
      // payload: { point, opts, snap? }.  metrics shape == TunerHook.runEval.
      const o = Object.assign({}, payload.opts || {});
      const altKm = o.targetAltKm != null ? o.targetAltKm : TunerConfig.fixed.targetAltKm;
      o.targetAltKm = altKm; o.verifyPoint = payload.point;
      const values = TunerUtils.toValues(payload.point, { targetAltKm: altKm });
      if (payload.snap) {
        const bias = values.insertion.STAGE_BURN_AOA_BIAS_DEG, lead = values.insertion.CIRC_TRIGGER_LEAD_S;
        o.resume = { cp: payload.snap, restore: (s) => restoreSnap(s, bias, lead, null) };
        result = { ok: true, metrics: await TunerHook.runEvalValues(values, o) };
      } else {
        const cpOut = {};
        o.cpAtPhase = 'SEPARATED_AXIAL'; o.onCheckpoint = captureSnap; o.cpOut = cpOut;
        if (payload.build) o.stopAtCheckpoint = true;   // saBuild: ascent only, stop right after SA snapshot (~2s); metrics then partial, use snap
        const m = await TunerHook.runEvalValues(values, o);
        result = { ok: true, metrics: m, snap: cpOut.cp || null };
      }
    } else if (type === 'tuneLead') {
      // Bootstrap Step 3b: tune lead for one lattice point (CIRC_END evals), entirely inside this worker.
      // payload: { point, opts: { targetAltKm, maxEvals } }. Returns scalars only (no log array bloat > 40 lines).
      const o = payload.opts || {};
      const cache = new TunerUtils.EvalCache();
      const lr = await TunerCore.tuneLead(payload.point, {
        hook: TunerHook, cache, targetAltKm: o.targetAltKm, maxEvals: o.maxEvals || 30,
      });
      const mm = lr.metrics || {};
      result = {
        ok: lr.ok, inBand: lr.inBand, reason: lr.reason, lead: lr.lead, leadTicks: lr.leadTicks,
        marginS: lr.marginS, vrEnd: lr.vrEnd, vrMin: lr.vrMin, evals: lr.evals, wallMs: lr.wallMs,
        stageFuelEngOffKg: mm.stageFuelEngOffKg, coastDeltaV: mm.coastDeltaV, apoCoastKm: mm.apoCoastKm,
        maxG: mm.maxG, maxQKPa: mm.maxQKPa, maxOmega: mm.maxOmega,
        log: (lr.log || []).slice(-40),
      };
    } else if (type === 'traceRun') {
      // Full-mission trace for gimbal-accel comparison (a sweep via the test-only CONFIG.GIMBAL_ACCEL_OVERRIDE;
      // Infinity = unlimited accel baseline, undefined/omitted = thruster-type value).
      // payload { point | values, altKm, accelDegS2, every (ticks, default 4), capS (default 1500), env }
      // Returns columnar arrays (simTime, phase, alt, speeds, pitch, gimbal angle/rate/alpha) + phase-change events.
      if (Object.isFrozen(CONFIG)) throw new Error('CONFIG frozen: cannot set GIMBAL_ACCEL_OVERRIDE');
      const altKm = payload.altKm != null ? payload.altKm : 320;
      // Point source priority: values > point (lattice) > raw {G,T,bias,lead,meco} via TunerUtils.fromRaw > TunerConfig.baselineRaw
      const _pt = payload.point || TunerUtils.fromRaw(payload.raw || TunerConfig.baselineRaw);
      const values = payload.values || TunerUtils.toValues(_pt, { targetAltKm: altKm });
      // Optional deep-merge of constants into values (applied to every run so comparisons stay apples-to-apples).
      const patchMissing = [];
      const _patchRestore = {};   // section -> {key: oldValue} for patched keys that toValues() does not carry (restored in finally; _v3Config persists across runs)
      if (payload.patch) {
        const _curCfg = Guidance.getGuideConfig(TunerConfig.guideName) || {};
        Object.keys(payload.patch).forEach(sec => {
          const ps = payload.patch[sec];
          if (!ps || typeof ps !== 'object' || Array.isArray(ps) || !(values[sec] || _curCfg[sec])) { patchMissing.push(sec); return; }
          if (!values[sec] || typeof values[sec] !== 'object') values[sec] = {};
          Object.keys(ps).forEach(k => {
            if (k in values[sec]) values[sec][k] = ps[k];
            else if (_curCfg[sec] && (k in _curCfg[sec])) { (_patchRestore[sec] = _patchRestore[sec] || {})[k] = _curCfg[sec][k]; values[sec][k] = ps[k]; }
            else patchMissing.push(sec + '.' + k);
          });
        });
      }
      const every = Math.max(1, payload.every || 4), maxTicks = Math.ceil((payload.capS || 1500) / CONFIG.DT);
      const sv = { a: CONFIG.GIMBAL_ACCEL_OVERRIDE };
      CONFIG.GIMBAL_ACCEL_OVERRIDE = (payload.accelDegS2 != null) ? payload.accelDegS2 : undefined;   // read by vehicle.js when engines are built (prepareRun)
      const C = { t: [], cmdRate: [], rx: [], ry: [], alt: [], vx: [], vy: [], theta: [], omega: [], gimbal: [], gimbalRate: [], alpha: [], gimbalTgt: [], thrust: [], fuel: [] };
      const phases = []; let lastPh = null, endReason = 'cap', ticks = 0;
      const ol = console.log; console.log = function () {};
      try {
        TunerEngine.refreshStackData();
        TunerEngine.prepareRun(TunerConfig.guideName, values, payload.env || TunerConfig.env);
        for (let i = 1; i <= maxTicks; i++) {
          if (state.halted) { endReason = 'halted'; break; }
          TunerEngine.tick(CONFIG.DT); ticks = i;
          const gs = Guidance.getGuideStatus() || {};
          if (gs.phase !== lastPh) { lastPh = gs.phase; phases.push({ t: +state.simTime.toFixed(3), phase: gs.phase }); if (gs.phase === 'DONE') { endReason = 'DONE'; } }
          const inWin = payload.hiT0 != null && state.simTime >= payload.hiT0 && state.simTime <= payload.hiT1;   // full-rate samples inside [hiT0,hiT1]
          if (i % every === 0 || inWin || endReason === 'DONE') {
            const b = state.bodies[state.activeBodyIndex]; if (!b) continue;
            const g = (b.engines || []).find(en => en.gimbal) || {};
            let F = 0; for (const en of (b.engines || [])) F += en.currentF || 0;
            C.t.push(+state.simTime.toFixed(3)); C.alt.push(gs.altKm != null ? gs.altKm : (Math.hypot(b.rx, b.ry) - CONFIG.EARTH_RADIUS) / 1000);
            C.rx.push(b.rx); C.ry.push(b.ry); C.vx.push(b.vx); C.vy.push(b.vy); C.theta.push(b.theta); C.omega.push(b.omega);
            C.gimbal.push(g.gimbalDeg || 0); C.gimbalRate.push(g.gimbalRateActDegS || 0);
            C.alpha.push(Number.isFinite(g.targetGimbalAccelDegS2) ? g.targetGimbalAccelDegS2 : null);
            C.gimbalTgt.push(Number.isFinite(g.targetGimbalDeg) ? g.targetGimbalDeg : null);
            C.cmdRate.push(Number.isFinite(g.targetGimbalRateDegS) ? g.targetGimbalRateDegS : null); C.thrust.push(F); C.fuel.push(b.fuelMass);
          }
          if (endReason === 'DONE') break;
        }
      } finally {
        console.log = ol;
        CONFIG.GIMBAL_ACCEL_OVERRIDE = sv.a;
        try { TunerEngine.refreshStackData(); } catch (e) {}
        try { Guidance.stopGuide(); } catch (e) {}
        if (Object.keys(_patchRestore).length) { try { Guidance.applyGuideConfig(TunerConfig.guideName, _patchRestore); } catch (e) {} }
      }
      result = { ok: true, patchMissing, endReason, ticks, simTime: state.simTime, accelDegS2: payload.accelDegS2, phases, cols: C };
    } else if (type === 'setupSA') {
      emit('setupSA', 'running ascent');
      TunerEngine.prepareRun(TunerConfig.guideName, payload.values, payload.env || TunerConfig.env);
      const ok = await tickUntilPhase(['SEPARATED_AXIAL'], 300);
      if (!ok) {
        emit('setupSA', 'FAIL ' + phaseNow());
        result = { ok: false, reason: 'SA not reached: ' + phaseNow() };
      } else {
        _saSnapshot = captureSnap();
        emit('setupSA', 'saved at t=' + _saSnapshot.simTime.toFixed(2));
        if (PROF_ON && PROF_BENCH) _bench();
        result = { ok: true, simTime: _saSnapshot.simTime };
      }
    } else if (type === 'probeBiasCheckpoint') {
      if (!_saSnapshot) { result = { ok: false, reason: 'no SA snapshot' }; }
      else {
        const newBias = payload.bias;
        const altKm = payload.altKm != null ? payload.altKm : 320;
        const Q = TunerConfig.quanta;
        const tag = 'b=' + newBias.toFixed(3);

        // ---- 1. Restore SA + bias, run to COAST_HOLD ----
        // (inline loop so we can snag eCoast when COAST_WAIT is entered — needed by SERENO FLUX table)
        emit('probe', tag + ' restore+runToCH');
        restoreSnap(_saSnapshot, newBias, null);
        const _pc0 = performance.now(), _pk0 = _tk;
        let okCH = false;
        let eCoastAtCW = NaN;
        // CH is reached ~tToApo after COAST_WAIT -> 800 s is wrong above ~500 km (2000 km: CH at ~1890 s).
        // Was max(800, suggestDurationCap(alt)) = 800 s at 320 km -> long-coast points (tToApo 1300-1700 s) never reached CH. Hook grows its cap dynamically; here use a hard ceiling (loop breaks at CH anyway).
        const _chCapS = payload.chCapS || 4000;
        const _chTicks = Math.ceil(_chCapS / CONFIG.DT);
        for (let _i = 0; _i < _chTicks; _i++) {
          if (state.halted) break;
          TunerEngine.tick(CONFIG.DT);
          const _gs = Guidance.getGuideStatus();
          if (!Number.isFinite(eCoastAtCW) && _gs && _gs.phase === 'COAST_WAIT') {
            const _stb = findStageBody();
            if (_stb) {
              const _r = Math.hypot(_stb.rx, _stb.ry);
              const _vr = (_stb.vx * _stb.rx + _stb.vy * _stb.ry) / _r;
              const _vt = (_stb.vx * _stb.ry - _stb.vy * _stb.rx) / _r;
              const _E = 0.5 * (_vr*_vr + _vt*_vt) - CONFIG.GM_EARTH / _r;
              const _h = _r * _vt;
              eCoastAtCW = Math.sqrt(Math.max(0, 1 + 2 * _E * _h * _h / (CONFIG.GM_EARTH * CONFIG.GM_EARTH)));
            }
          }
          if (_gs && _gs.phase === 'COAST_HOLD') { okCH = true; break; }
        }
        _P.ch += performance.now() - _pc0; _P.chT += _tk - _pk0;
        if (!okCH) {
          emit('probe', tag + ' CH_FAIL ' + phaseNow() + (state.halted ? ' HALTED' : ' CAP@' + _chCapS + 's'));
          result = { ok: false, reason: 'CH not reached: ' + phaseNow() + (state.halted ? ' (halted)' : ' (cap ' + _chCapS + 's)') };
        } else {
          // ---- 2. Capture local CH snapshot ----
          const chSnap = captureSnap();
          emit('probe', tag + ' CH captured t=' + chSnap.simTime.toFixed(2) + ', tuneLead');


          // ---- 3. tuneLead with CH-based hook ----
          const cache = new TunerUtils.EvalCache();
          let evalN = 0;
          const CPHook = {
            runEval: async (p2, o) => {
              evalN++;
              const lead = p2.li * Q.lead;
              emit('probe', tag + ' eval#' + evalN + ' lead=' + lead.toFixed(4));
              restoreSnap(chSnap, newBias, lead);
              const _pe0 = performance.now(), _pek0 = _tk;
              // Measure EXACTLY like hook.js CIRC_END: window opens at phase CIRCULARIZE, vrMin tracked inside it,
              // vrEnd / signed margin read at the engines-off tick (not after COAST_ROTATE_2).
              let circWindow = false, circAchSeen = false, vrMinC = Infinity, res = null;
              const capT = Math.ceil(300 / CONFIG.DT);
              for (let _k = 0; _k < capT; _k++) {
                if (state.halted) break;
                TunerEngine.tick(CONFIG.DT);
                const gs = Guidance.getGuideStatus();
                const stb = findStageBody();
                if (!stb || !gs) continue;
                const r = Math.hypot(stb.rx, stb.ry);
                const vr = (stb.vx * stb.rx + stb.vy * stb.ry) / r;
                if (gs.phase === 'CIRCULARIZE' && !circWindow && !circAchSeen) circWindow = true;
                if (gs.circAchieved && !circAchSeen) circAchSeen = true;
                if (circWindow) {
                  if (vr < vrMinC) vrMinC = vr;
                  if (circAchSeen) {
                    let mdot = 0; const en = stb.engines;
                    if (en) for (let q = 0; q < en.length; q++) mdot += en[q].massFlowRate || 0;
                    if (mdot <= 1e-9) {
                      const o = TunerHook.orbitOf(stb, CONFIG.GM_EARTH, CONFIG.EARTH_RADIUS);
                      const marginS = !(o.vr < 0) ? o.tToApo : (Number.isFinite(o.periodS) ? (o.tToApo - o.periodS) : -Infinity);
                      res = { vrEnd: o.vr, marginS, vrMin: vrMinC };
                      break;
                    }
                  }
                }
              }
              _P.circ += performance.now() - _pe0; _P.circT += _tk - _pek0;
              if (!res) return { endReason: state.halted ? 'HALTED' : 'CAP', crashed: !!state.crashed, vrEnd: NaN, marginS: NaN, vrMin: NaN };
              return { endReason: 'CIRC_END', crashed: !!state.crashed, vrEnd: res.vrEnd, marginS: res.marginS, vrMin: res.vrMin };
            }
          };
          // Lattice point (needed for cache key only)
          const cfg = Guidance.getGuideConfig('leoInsertionV3');
          const point = {
            Gi: Math.round(cfg.ascent.PUSH_MAX_GIMBAL_DEG / Q.G),
            Tn: Math.round(cfg.ascent.PUSH_T_S / Q.T),
            bi: Math.round(cfg.insertion.STAGE_BURN_AOA_BIAS_DEG / Q.bias),
            li: Math.round(cfg.insertion.CIRC_TRIGGER_LEAD_S / Q.lead),
            meco: cfg.ascent.MECO_TARGET_BOOSTER_FUEL_KG,
          };
          const lr = await TunerCore.tuneLead(point, { hook: CPHook, cache, targetAltKm: altKm, marginBand: payload.marginBand });
          emit('probe', tag + ' tuneLead ok=' + lr.ok + ' lead=' + (Number.isFinite(lr.lead) ? lr.lead.toFixed(4) : 'n/a') + ' evals=' + lr.evals);

          if (!lr.ok) {
            result = { ok: false, tuneOk: false, reason: 'lead_failed: ' + lr.reason, lead: lr.lead, margin: lr.marginS, evals: lr.evals, log: (lr.log || []).slice(-40) };
          } else {
            // ---- 4. FULL eval from CH with best lead ----
            // Tick until payload PHYSICALLY clears (gs.payloadCleared === true).
            // 'DONE' phase fires at deploy COMMAND, not at payload clear — the payload
            // physically clears ~10-30 s later. Stopping at DONE left gsEnd.payloadCleared
            // false → false "duration_cap_hit + payload_not_cleared" hard-fail.
            emit('probe', tag + ' FULL lead=' + lr.lead.toFixed(4));
            restoreSnap(chSnap, newBias, lr.lead);
            const _pf0 = performance.now(), _pfk0 = _tk;
            let okFull = false;
            const _capTicksFull = Math.ceil(300 / CONFIG.DT);
            for (let _i = 0; _i < _capTicksFull; _i++) {
              if (state.halted) break;
              TunerEngine.tick(CONFIG.DT);
              const _gs = Guidance.getGuideStatus();
              if (_gs && _gs.payloadCleared) { okFull = true; break; }
            }
            _P.full += performance.now() - _pf0; _P.fullT += _tk - _pfk0;
            const gsEnd = Guidance.getGuideStatus();
            const stb = findStageBody();
            const m = {
              endReason: gsEnd.payloadCleared ? 'CLEARED' : 'CAP',
              crashed: !!state.crashed,
              payloadReleased: !!gsEnd.payloadCleared,
              payloadCleared: !!gsEnd.payloadCleared,
              deployTimeS: gsEnd.deployCommandSimTime,
              apogeeKm: NaN, perigeeKm: NaN, ecc: NaN,
              boosterFuelLeftKg: NaN, stageResidualKg: stb ? stb.fuelMass : NaN,
              maxQKPa: NaN, maxG: NaN,
            };
            const pb = state.bodies.find(x => x && x.payloadBody);
            if (pb) {
              const o = TunerHook.orbitOf(pb, CONFIG.GM_EARTH, CONFIG.EARTH_RADIUS);
              m.apogeeKm = o.apoKm; m.perigeeKm = o.periKm; m.ecc = o.ecc;
            }
            const sc = TunerUtils.score(m, { targetAltKm: altKm });
            emit('probe', tag + ' FULL score=' + (sc.score != null ? sc.score.toFixed(2) : '?') + ' cleared=' + m.payloadCleared);
            result = {
              ok: sc.ok, tuneOk: true, inBand: lr.inBand, leadTicks: lr.leadTicks, lead: lr.lead, margin: lr.marginS, vrEnd: lr.vrEnd,
              score: sc.score, reasons: sc.reasons, metrics: m,
              evals: lr.evals + 1,
              capHit: !okFull,
              capReason: okFull ? null : 'cap',
              simEnd: state.simTime,
              eCoast: eCoastAtCW,
            };
          }
        }
      }
    } else if (type === 'ladderBuild') {
      // Step 1: ascent ladder. payload { point (meco should be 0 = never fires early), altKm, stepS }
      const t0 = Date.now(), altKm = payload.altKm != null ? payload.altKm : 320;
      const values = TunerUtils.toValues(payload.point, { targetAltKm: altKm });
      const ol = console.log; console.log = function () {};
      try {
        TunerEngine.prepareRun(TunerConfig.guideName, values, payload.env || TunerConfig.env);
        const stepTicks = Math.max(1, Math.round((payload.stepS || 2) / CONFIG.DT));
        _ladder = [];
        const maxT = Math.ceil(400 / CONFIG.DT);
        for (let i = 1; i <= maxT; i++) {
          if (state.halted) break;
          TunerEngine.tick(CONFIG.DT);
          const gs = Guidance.getGuideStatus();
          if (!gs || gs.phase !== 'ASCENT' || gs.mecoTriggered) break;
          if (i % stepTicks === 0) _ladder.push({ tick: i, simTime: state.simTime, residualProj: mecoResidual(), snap: captureSnap() });
        }
      } finally { console.log = ol; }
      const last = _ladder[_ladder.length - 1];
      let cloneOk = null, cloneErr = null, jsonBytes = null;
      if (last) {
        try { jsonBytes = JSON.stringify(last.snap).length; } catch (e) { jsonBytes = 'ERR ' + e.message; }
        try { structuredClone(last.snap); cloneOk = true; } catch (e) { cloneOk = false; cloneErr = e.message; }
      }
      result = {
        ok: !!last, n: _ladder.length, wallMs: Date.now() - t0,
        times: _ladder.map(x => +x.simTime.toFixed(3)), residuals: _ladder.map(x => Math.round(x.residualProj)),
        jsonBytes, cloneOk, cloneErr, scan: last ? scanSnap(last.snap) : null,
      };
    } else if (type === 'ladderGet') {
      // payload { M } -> last snapshot whose projected MECO residual is still > M (prefix identical for that MECO)
      let idx = -1;
      for (let i = 0; i < _ladder.length; i++) if (_ladder[i].residualProj > payload.M) idx = i;
      result = idx < 0 ? { ok: false, reason: 'no snapshot above M' } : { ok: true, idx, simTime: _ladder[idx].simTime, residualProj: _ladder[idx].residualProj, snap: _ladder[idx].snap };
    } else if (type === 'runScratch' || type === 'runFromSnap') {
      // payload { point (target: meco=M, bias, lead), altKm, tCheck, snap? , capS }
      const altKm = payload.altKm != null ? payload.altKm : 320, t0 = Date.now();
      const values = TunerUtils.toValues(payload.point, { targetAltKm: altKm });
      const ol = console.log; console.log = function () {};
      try {
        TunerEngine.prepareRun(TunerConfig.guideName, values, payload.env || TunerConfig.env);   // resetState(0) + env + fueling + startGuide
        if (type === 'runFromSnap') {
          restoreSnap(payload.snap, values.insertion.STAGE_BURN_AOA_BIAS_DEG, values.insertion.CIRC_TRIGGER_LEAD_S, values.ascent.MECO_TARGET_BOOSTER_FUEL_KG);
        }
      } finally { console.log = ol; }
      const fp = await runToCW(payload.tCheck, payload.capS || 1500);
      fp.wallMs = Date.now() - t0;
      result = fp;
    } else if (type === 'benchExp') {
      result = _benchExp(payload.ticks || 1500, payload.values);
    } else if (type === 'benchDormant') {
      result = _benchDormant(payload.ticks || 200000);
    } else if (type === 'benchVerify') {
      result = _benchVerify(payload.ticks || 150000);
    } else if (type === 'benchLoop') {
      result = _benchLoop(payload.ticks || 2000, payload.values);
    } else if (type === 'ping') {
      result = { pong: true, tag: _workerTag, hasTunerEngine: typeof TunerEngine !== 'undefined' };
    } else if (type === 'verifyChain') {
      // Checkpoint pipeline in ONE worker (snapshots are worker-local, pool has no pinning):
      //   ascent -> SEPARATED_AXIAL snapshot -> (restore, bias) -> COAST_HOLD snapshot -> tuneLead from CH -> FULL from CH.
      // payload: { point (lattice), altKm, marginBand? }.  Same result shape as probeBiasCheckpoint + wallMs/saSimTime.
      const t0 = Date.now();
      const altKm = payload.altKm != null ? payload.altKm : 320;
      const values = TunerUtils.toValues(payload.point, { targetAltKm: altKm });
      const r1 = await _job('setupSA', { values });
      if (!r1.ok) { result = { ok: false, reason: 'setupSA: ' + r1.reason, wallMs: Date.now() - t0 }; }
      else {
        result = await _job('probeBiasCheckpoint', { bias: values.insertion.STAGE_BURN_AOA_BIAS_DEG, altKm, marginBand: payload.marginBand });
        result.saSimTime = r1.simTime; result.wallMs = Date.now() - t0;
      }
    } else {
      throw new Error('unknown job type: ' + type);
    }
    return result;
    };
    const _j0 = performance.now();
    const result = await _job(type, payload);
    _P.job += performance.now() - _j0;
    _flushOps(); _flushProf();
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    _flushOps(); _flushProf();
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
