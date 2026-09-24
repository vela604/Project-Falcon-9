// ============================================================================
// guidance.js — Guidance worker orchestrator.
//
// Responsibilities (deliberately minimal):
//   - Boot: receive stack data from main thread, hand to Derivation.
//   - IMU: toggle on/off, funnel raw snapshots through measure().
//   - tick(): called once per snapshot with the (optionally IMU-errored)
//     state. Empty placeholder for now — a real control law drops in here.
//   - Command builders: shape outgoing messages to the physics worker.
//
// Everything heavy is in sibling modules:
//   - derivation.js  → Derivation.* : mass props, per-member aero, kinematics
//   - guidercs.js    → GuideRCS.*   : torque-driven RCS distribution
//
// Both are globals once guidance.worker.js importScripts's them, and both
// are deliberately excluded from touching anything physics-side. This file
// is the ONLY place that knows how to talk to the physics worker (via
// send()/cmd* builders); the algorithms above just produce data.
// ============================================================================

const Guidance = (function () {
  let _physicsSend = null;      // (msg) => void, wired by guidance.worker.js
  let _lastRawSnapshot = null;  // most recent snapshot exactly as received
  let _lastMeasuredSnapshot = null; // post-IMU copy handed to tick()
  
  function init(physicsSendFn) {
    _physicsSend = physicsSendFn;
  }
  
  // Forwarding stubs for boot-time stack data. Actual storage and all
  // accessors live in derivation.js, which owns the raw records and the
  // formulas that consume them.
  function setStackData(data) { Derivation.setStackData(data); }
  function getStackData() { return Derivation.getStackData(); }
  
  // ---- IMU wiring ----
  function setImuEnabled(enabled) {
    setEnabled(enabled); // imu.js global
  }
  
  // Called once per snapshot from guidance.worker.js. Applies (or skips)
  // IMU noise, stores both versions, and hands the measured one to tick().
  function onSnapshot(rawSnapshot) {
    _lastRawSnapshot = rawSnapshot;
    _lastMeasuredSnapshot = measure(rawSnapshot);
    tick(_lastMeasuredSnapshot);
  }
  
// ============================================================
// Guide framework. Each guide is a tick function with optional
// .start() / .stop() lifecycle hooks and optional .getStatus()
// for UI feedback. Exactly one is active at a time.
// ============================================================
const GUIDES = {};
let _activeGuide = null;

function startGuide(name) {
  if (!name || !GUIDES[name]) {
    console.warn('[guidance] startGuide: unknown guide', name);
    return false;
  }
  if (_activeGuide === name) return true;
  if (_activeGuide && typeof GUIDES[_activeGuide].stop === 'function') {
    try { GUIDES[_activeGuide].stop(); } catch (e) { console.error(e); }
  }
  _activeGuide = name;
  if (typeof GUIDES[name].start === 'function') {
    try { GUIDES[name].start(); } catch (e) { console.error(e); }
  }
  console.log('[guidance] started:', name);
  return true;
}

function stopGuide() {
  if (!_activeGuide) return;
  const name = _activeGuide;
  if (typeof GUIDES[name].stop === 'function') {
    try { GUIDES[name].stop(); } catch (e) { console.error(e); }
  }
  _activeGuide = null;
  console.log('[guidance] stopped:', name);
}

function setActiveGuide(name) {
  // Legacy: immediate activation without start/stop hooks.
  _activeGuide = (name && GUIDES[name]) ? name : null;
}
function getActiveGuide() { return _activeGuide; }
function listGuides() { return Object.keys(GUIDES); }

function getGuideStatus() {
  if (!_activeGuide) return { active: null };
  const g = GUIDES[_activeGuide];
  const out = { active: _activeGuide };
  if (typeof g.getStatus === 'function') Object.assign(out, g.getStatus());
  return out;
}

// ---- Guide state pack/unpack (for main-thread fast-forward) ----
// Every guide's phase and mission-plan data lives in one of these
// module-scoped state objects. Fast-forward on the main thread imports
// them at the start (so the FF guide resumes from the exact phase the
// worker was in) and exports them at the end (so the worker picks up
// where the FF stopped). Without this, main and worker guides drift
// immediately — one replays from ASCENT, the other is mid-STAGE_BURN.
function exportGuideState() {
  const out = { activeGuide: _activeGuide };
  try {
    out.hState = JSON.parse(JSON.stringify(_hState));
    out.leoState = JSON.parse(JSON.stringify(_leoState));
    out.leoStateV2 = JSON.parse(JSON.stringify(_leoStateV2));
    out.rrState = JSON.parse(JSON.stringify(_rrState));
  } catch (e) {
    console.warn('[guidance] exportGuideState failed', e);
  }
  return out;
}
function importGuideState(data) {
  if (!data) return;
  try {
    if (data.hState) Object.assign(_hState, data.hState);
    if (data.leoState) Object.assign(_leoState, data.leoState);
    if (data.leoStateV2) Object.assign(_leoStateV2, data.leoStateV2);
    if (data.rrState) Object.assign(_rrState, data.rrState);
    if (data.activeGuide !== undefined) _activeGuide = data.activeGuide;
  } catch (e) {
    console.warn('[guidance] importGuideState failed', e);
  }
}

function tick(snapshot) {
  if (_activeGuide && GUIDES[_activeGuide]) {
    GUIDES[_activeGuide](snapshot);
  }
}

// ============================================================
// testGuide — experimental.
//
// Every tick:
//   1. Derive current total torque on the active body (engine + drag;
//      torqueRcs is 0 in derive by construction).
//   2. Target torque = −(that value) — the exact opposing torque
//      RCS would need to produce to zero the net rotation.
//   3. Hand the target to GuideRCS.targetTorqueRcs → duty table.
//   4. Send cmdRcsDuty(duties) to physics.
//
// stop() relinquishes RCS duty control so physics falls back to idle.
// ============================================================
const _testGuideState = {
  ticks: 0,
  lastTarget: 0,
  lastAchieved: 0,
  lastFires: 0,
  lastSaturated: false,
};
const _TEST_TORQUE_DEADBAND = 100; // N·m

function _testGuideTick(snapshot) {
  _testGuideState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const d = Derivation.derive(snapshot, idx);
  if (!d || !d.massProps) return;
  
  // EXPERIMENT: 2× the opposing torque — overshoots deliberately so
// we can see the reverse-direction response and how the loop
// settles (or doesn't). Will be reverted to −1× once we understand
// the dynamics.
const targetTorque = -dragNext;
_predictiveState.lastTarget = targetTorque;

// ---- 4. Convert to per-pod duties at PREDICTED COM ----

const result = GuideRCS.targetTorqueRcs(snapshot, targetTorque, idx);
if (!result || !result.fires.length) {
  send(cmdRcsDuty({}));
  _testGuideState.lastAchieved = 0;
  _testGuideState.lastFires = 0;
  _testGuideState.lastSaturated = false;
  return;
}
  
  send(cmdRcsDuty(result.duties));
  _testGuideState.lastAchieved = result.torqueAchieved;
  _testGuideState.lastFires = result.fires.length;
  _testGuideState.lastSaturated = result.saturated;
}

_testGuideTick.start = function () {
  // Launch: max throttle, gimbal left untouched (defaults to 0).
  send(cmdSetAllThrottle(Infinity));
  _testGuideState.ticks = 0;
  _testGuideState.lastTarget = 0;
  _testGuideState.lastAchieved = 0;
  _testGuideState.lastFires = 0;
  _testGuideState.lastSaturated = false;
};
_testGuideTick.stop = function () {
  send(cmdRcsDuty(null));
};
_testGuideTick.getStatus = function () {
  return { ..._testGuideState };
};

GUIDES.testGuide = _testGuideTick;

// ============================================================
// predictiveTorque — feedforward drag-torque cancellation.
//
// Math (all in the physics tick's dt = CONFIG.DT ≈ 12.5 ms):
//
//   1. Derive current state → kinematic + force quantities.
//   2. Predict next-tick state assuming NO RCS action this tick:
//        rx_next   = rx + vx·dt
//        ry_next   = ry + vy·dt
//        a_inertial = gravity + rotate(thrust_body, theta)/M + drag/M
//        vx_next   = vx + a_inertial.x·dt
//        vy_next   = vy + a_inertial.y·dt
//        alpha_now = torque_total / I
//        omega_next = omega + alpha_now·dt
//        theta_next = theta + omega·dt + ½·alpha_now·dt²
//        slosh_x_next = slosh_x + slosh_v·dt   (Euler)
//   3. Derive the same body AT the predicted state (deriveForState):
//        → A_eff_next, COP_next, COM_next, τ_drag_next
//   4. targetTorque = −τ_drag_next
//   5. GuideRCS.targetTorqueRcs with comX/comY = next-tick COM, so
//      arm geometry matches where COM will be when the torque lands.
//   6. cmdRcsDuty(duties).
//
// The RCS command we're sending in step 6 is intentionally NOT part
// of the prediction in step 2 — we're cancelling the disturbance as
// predicted in the "do-nothing" world, not iterating to a fixed point.
// ============================================================
const _predictiveState = {
  ticks: 0,
  lastTarget: 0,
  lastAchieved: 0,
  lastFires: 0,
  lastSaturated: false,
  lastDragNext: 0,
  lastComNextX: 0,
  lastComNextY: 0,
};


function _predictiveTick(snapshot) {
  _predictiveState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  // ---- 1. Predict next-tick kinematics (no RCS action assumed) ----
  const cosT = Math.cos(dNow.theta);
  const sinT = Math.sin(dNow.theta);
  
  // Thrust is body-frame; rotate to inertial (same convention physics
  // uses in derivatives(): Fx_i = Fx·cosT − Fy·sinT, Fy_i = Fx·sinT + Fy·cosT).
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  
  // Drag from derive() is ALREADY inertial-frame (built from relVx/relVy).
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIx * dt;
  const vy_n = dNow.vy + aIy * dt;
  
  const alpha = dNow.alphaAng;
  const omega_n = dNow.omega + alpha * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  // ---- 2. Derive at predicted state ----
  const dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n,
    vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  });
  if (!dNext || !dNext.massProps) return;
  
  const dragNext = dNext.torqueDrag;
  _predictiveState.lastDragNext = dragNext;
  _predictiveState.lastComNextX = dNext.massProps.comX;
  _predictiveState.lastComNextY = dNext.massProps.comY;
  
  // ---- 3. Target torque = opposite of predicted drag torque ----
  const targetTorque = -dragNext;
  _predictiveState.lastTarget = targetTorque;
  
  
  
  // ---- 4. Convert to per-pod duties at PREDICTED COM ----
  const result = GuideRCS.targetTorqueRcs(
    snapshot, targetTorque, idx,
    { comX: dNext.massProps.comX, comY: dNext.massProps.comY }
  );
  if (!result || !result.fires.length) {
    send(cmdRcsDuty({}));
    _predictiveState.lastAchieved = 0;
    _predictiveState.lastFires = 0;
    _predictiveState.lastSaturated = false;
    return;
  }
  
  send(cmdRcsDuty(result.duties));
  _predictiveState.lastAchieved = result.torqueAchieved;
  _predictiveState.lastFires = result.fires.length;
  _predictiveState.lastSaturated = result.saturated;
}

_predictiveTick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _predictiveState.ticks = 0;
  _predictiveState.lastTarget = 0;
  _predictiveState.lastAchieved = 0;
  _predictiveState.lastFires = 0;
  _predictiveState.lastSaturated = false;
  _predictiveState.lastDragNext = 0;
};
_predictiveTick.stop = function () {
  send(cmdRcsDuty(null));
};
_predictiveTick.getStatus = function () {
  return {
    ticks: _predictiveState.ticks,
    lastTarget: _predictiveState.lastTarget,
    lastAchieved: _predictiveState.lastAchieved,
    lastFires: _predictiveState.lastFires,
    lastSaturated: _predictiveState.lastSaturated,
  };
};

GUIDES.predictivePlus = _predPlusTick;

// ============================================================
// predictivePlusAoA — predictivePlus + periodic AoA impulse.
//
// Same five-term PID + feedforward as predictivePlus, plus:
//
//   Every `_AOA_CYCLE` (3) ticks: check current AoA.
//     Tick N   : check. If |AoA| > threshold, set pending.
//     Tick N+1 : fire. Add impulse torque 2·I/dt² with sign
//                opposing the AoA. Base PID runs as normal,
//                so this is superposition on top.
//     Tick N+2 : skip. Base PID only.
//     Tick N+3 : check again.
//
// `2·I/dt²` is enormous compared to RCS capability — the fire tick
// will saturate RCS every time. That's the point of this experiment.
// ============================================================
const _predAoaState = {
  ticks: 0,
  lastTarget: 0,
  lastAchieved: 0,
  lastFires: 0,
  lastSaturated: false,
  lastThetaError: 0,
  lastOmega: 0,
  lastIntegralError: 0,
  lastAoaDeg: 0,
  lastCorrection: 0,
  lastTerms: { ff: 0, p: 0, d: 0, lead: 0, i: 0, aoa: 0 },
};

let _predAoaIntegralError = 0;
let _predAoaPrevDragTorque = null;
let _predAoaTickCounter = 0;
let _predAoaPendingFire = false;
const _AOA_CYCLE = 3;              // check, fire, skip
const _AOA_THRESHOLD_DEG = 0.01;

function _predAoaTick(snapshot) {
  _predAoaState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  // ---- 1. Next-tick kinematics (no RCS assumed) ----
  const cosT = Math.cos(dNow.theta), sinT = Math.sin(dNow.theta);
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIx * dt;
  const vy_n = dNow.vy + aIy * dt;
  
  const alpha = dNow.alphaAng;
  const omega_n = dNow.omega + alpha * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  // ---- 2. Next-tick drag torque ----
  const dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n,
    vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  });
  if (!dNext || !dNext.massProps) return;
  
  const dragNext = dNext.torqueDrag;
  
  // ---- 3. Base PID + feedforward ----
  // Phase 3 — full predictivePlusAoA stack (includes -K_d·ω).
const ffTerm = -dragNext;

// AoA-zero target: the body-axis angle that makes velBodyX = 0,
// i.e. aligns the nose with the body's velocity-through-air.
// Derivation: velBodyX = relVx·cosθ + relVy·sinθ = 0
//   → tanθ = −relVx/relVy
//   → θ = atan2(relVx, −relVy)   (branch that puts nose INTO
//     the motion direction, not retrograde)
// Fallback to local vertical when relV is near-zero (early flight,
// any degenerate case) — atan2(0,0) gives 0 which is wrong.
const speedRelNow = dNow.speedRel || 0;
const thetaTarget = (speedRelNow > 0.5) ?
  Math.atan2(dNow.relVx, -dNow.relVy) :
  -Math.atan2(body.rx, body.ry);
let thetaError = body.theta - thetaTarget;
  while (thetaError > Math.PI) thetaError -= 2 * Math.PI;
  while (thetaError < -Math.PI) thetaError += 2 * Math.PI;
  const pTerm = -_PRED_GAINS.K_p * thetaError;
  _predAoaState.lastThetaError = thetaError;
  
  const dTerm = -_PRED_GAINS.K_d * dNow.omega;
  _predAoaState.lastOmega = dNow.omega;
  
  let leadTerm = 0;
  if (_PRED_GAINS.K_lead > 0 && _predAoaPrevDragTorque !== null) {
    const dTau_dt = (dragNext - _predAoaPrevDragTorque) / dt;
    leadTerm = -_PRED_GAINS.K_lead * dTau_dt;
  }
  _predAoaPrevDragTorque = dragNext;
  
  const iTerm = _PRED_GAINS.K_i * _predAoaIntegralError;
  _predAoaState.lastIntegralError = _predAoaIntegralError;
  
  // ---- 4. AoA impulse (periodic) ----
  // ---- 4. AoA impulse (periodic, saturating) ----
let aoaTerm = 0;
_predAoaState.lastAoaDeg = dNow.alphaDeg;

if (_predAoaPendingFire) {
  // Fire tick — impulse torque of 2·I·AoA/dt² opposing the current AoA.
  // AoA in radians (alphaDeg is degrees; convert). Negative sign flips
  // the sign so positive AoA → negative torque, and vice versa.
  // The pending flag is NOT cleared here — it's cleared below only
  // if RCS actually delivered the requested torque. If RCS saturates
  // (impulse is far bigger than max available), the pending flag
  // stays set and the same term fires again next tick, until either
  // AoA drops enough that the impulse becomes deliverable, or the
  // threshold is met and no more fire is needed.
  const aoaRad = dNow.alphaDeg * Math.PI / 180;
  aoaTerm = -2 * dNow.massProps.I * aoaRad / (dt * dt);
} else if (_predAoaTickCounter % _AOA_CYCLE === 0) {
  // Check tick
  if (Math.abs(dNow.alphaDeg) > _AOA_THRESHOLD_DEG) {
    _predAoaPendingFire = true;
  }
}
_predAoaTickCounter++;
_predAoaState.lastCorrection = aoaTerm;
  
  // ---- 5. Combined target torque ----
  const targetTorque = ffTerm + pTerm + dTerm + leadTerm + iTerm + aoaTerm;
  _predAoaState.lastTarget = targetTorque;
  _predAoaState.lastTerms = {
    ff: ffTerm, p: pTerm, d: dTerm, lead: leadTerm, i: iTerm, aoa: aoaTerm,
  };
  
  // ---- 6. Fire ----
  const result = GuideRCS.targetTorqueRcs(
    snapshot, targetTorque, idx,
    { comX: dNext.massProps.comX, comY: dNext.massProps.comY }
  );
  
  if (!result || !result.fires.length) {
    send(cmdRcsDuty({}));
    _predAoaState.lastAchieved = 0;
    _predAoaState.lastFires = 0;
    _predAoaState.lastSaturated = false;
    return;
  }
  
  send(cmdRcsDuty(result.duties));
  _predAoaState.lastAchieved = result.torqueAchieved;
  _predAoaState.lastFires = result.fires.length;
  _predAoaState.lastSaturated = result.saturated;
  
  if (!result.saturated) {
    const gap = targetTorque - result.torqueAchieved;
    _predAoaIntegralError += gap * dt;
    if (_predAoaIntegralError >  1e6) _predAoaIntegralError =  1e6;
    if (_predAoaIntegralError < -1e6) _predAoaIntegralError = -1e6;
  }
}

_predAoaTick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _predAoaState.ticks = 0;
  _predAoaState.lastTarget = 0;
  _predAoaState.lastAchieved = 0;
  _predAoaState.lastFires = 0;
  _predAoaState.lastSaturated = false;
  _predAoaState.lastThetaError = 0;
  _predAoaState.lastOmega = 0;
  _predAoaState.lastIntegralError = 0;
  _predAoaState.lastAoaDeg = 0;
  _predAoaState.lastCorrection = 0;
  _predAoaState.lastTerms = { ff: 0, p: 0, d: 0, lead: 0, i: 0, aoa: 0 };
  _predAoaIntegralError = 0;
  _predAoaPrevDragTorque = null;
  _predAoaTickCounter = 0;
  _predAoaPendingFire = false;
};
_predAoaTick.stop = function () {
  send(cmdRcsDuty(null));
};
_predAoaTick.getStatus = function () {
  return {
    ticks: _predAoaState.ticks,
    lastTarget: _predAoaState.lastTarget,
    lastAchieved: _predAoaState.lastAchieved,
    lastFires: _predAoaState.lastFires,
    lastSaturated: _predAoaState.lastSaturated,
    lastThetaError: _predAoaState.lastThetaError,
    lastOmega: _predAoaState.lastOmega,
    lastIntegralError: _predAoaState.lastIntegralError,
    lastAoaDeg: _predAoaState.lastAoaDeg,
    lastCorrection: _predAoaState.lastCorrection,
    lastTerms: _predAoaState.lastTerms,
  };
};

GUIDES.predictivePlusAoAPush = _predSweepTick;

// ============================================================
// predictVerifier — no RCS, just verify prediction accuracy.
//
// Each tick:
//   1. If a previous prediction exists (and exactly one physics tick
//      elapsed between snapshots — verified via simTime delta),
//      compare predicted vs actual derive() outputs.
//   2. Compute fresh next-tick prediction using the SAME math the
//      guides use.
//   3. Fire nothing (cmdRcsDuty(null)) so we don't perturb the state
//      we're trying to predict.
//
// Reports mean absolute error for key quantities every ~1s.
// Call getPredictVerifierStatus() for a snapshot of the numbers.
// ============================================================
const _pvState = {
  ticks: 0,
  nCompared: 0,
  nSkipped: 0,       // snapshots that didn't line up 1-to-1 with a tick
  prevSimTime: null,
  sAbsTq: 0,
  sAbsDrag: 0,
  sAbsAlpha: 0,
  sAbsAlt: 0,
  sAbsQ: 0,
  lastTq: { pred: 0, act: 0, err: 0 },
  lastAlpha: { pred: 0, act: 0, err: 0 },
  lastDrag: { pred: 0, act: 0, err: 0 },
  lastQ: { pred: 0, act: 0, err: 0 },
};
let _pvPendingPrediction = null;

function _predictNextTick(snapshot, idx) {
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return null;
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return null;
  
  const cosT = Math.cos(dNow.theta), sinT = Math.sin(dNow.theta);
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIx * dt;
  const vy_n = dNow.vy + aIy * dt;
  
  const alpha = dNow.alphaAng;
  const omega_n = dNow.omega + alpha * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  
  const body = snapshot.bodies[idx];
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  return Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n,
    vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  });
}

function _pvCompare(pred, act) {
  const errTq = act.torqueDrag - pred.torqueDrag;
  const errAlpha = act.alphaDeg - pred.alphaDeg;
  _pvState.sAbsTq += Math.abs(errTq);
  _pvState.sAbsDrag += Math.abs(act.dragMag - pred.dragMag);
  _pvState.sAbsAlpha += Math.abs(errAlpha);
  _pvState.sAbsAlt += Math.abs(act.altitudeASL - pred.altitudeASL);
  _pvState.sAbsQ += Math.abs(act.Q - pred.Q);
  _pvState.lastTq = { pred: pred.torqueDrag, act: act.torqueDrag, err: errTq };
  _pvState.lastAlpha = { pred: pred.alphaDeg, act: act.alphaDeg, err: errAlpha };
  _pvState.lastDrag = { pred: pred.dragMag, act: act.dragMag, err: act.dragMag - pred.dragMag };
  _pvState.lastQ = { pred: pred.Q, act: act.Q, err: act.Q - pred.Q };
  _pvState.nCompared++;
}

function _predictVerifierTick(snapshot) {
  _pvState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  
  // Compare pending prediction with current actual, but only when
  // exactly one physics tick elapsed since the last snapshot.
  if (_pvPendingPrediction && _pvState.prevSimTime !== null) {
    const tickDelta = snapshot.simTime - _pvState.prevSimTime;
    if (Math.abs(tickDelta - dt) < dt * 0.05) {
      const dNow = Derivation.derive(snapshot, idx);
      if (dNow) _pvCompare(_pvPendingPrediction, dNow);
    } else {
      _pvState.nSkipped++;
    }
  }
  _pvState.prevSimTime = snapshot.simTime;
  
  // Fresh prediction for next tick
  _pvPendingPrediction = _predictNextTick(snapshot, idx);
  
  // Fire nothing
  send(cmdRcsDuty(null));
  
  // Report every 80 ticks (~1 s)
  if (_pvState.ticks % 80 === 0 && _pvState.nCompared > 0) {
    const n = _pvState.nCompared;
    const meanTq = _pvState.sAbsTq / n;
    const meanAlpha = _pvState.sAbsAlpha / n;
    console.log(
      `[pv] t=${snapshot.simTime.toFixed(2)}s n=${n} skip=${_pvState.nSkipped}` +
      ` | τ: mean|err|=${meanTq.toFixed(0)} N·m, last pred=${_pvState.lastTq.pred.toFixed(0)} act=${_pvState.lastTq.act.toFixed(0)}` +
      ` | α: mean|err|=${meanAlpha.toExponential(2)}°, last pred=${_pvState.lastAlpha.pred.toFixed(4)} act=${_pvState.lastAlpha.act.toFixed(4)}`
    );
  }
}

_predictVerifierTick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _pvState.ticks = 0;
  _pvState.nCompared = 0;
  _pvState.nSkipped = 0;
  _pvState.prevSimTime = null;
  _pvState.sAbsTq = 0;
  _pvState.sAbsDrag = 0;
  _pvState.sAbsAlpha = 0;
  _pvState.sAbsAlt = 0;
  _pvState.sAbsQ = 0;
  _pvPendingPrediction = null;
  console.log('[predictVerifier] started — no RCS, pure prediction check');
};
_predictVerifierTick.stop = function () {
  send(cmdRcsDuty(null));
  const n = _pvState.nCompared || 1;
  console.log('[predictVerifier] stop. Summary:');
  console.log('  n compared:', _pvState.nCompared, '| skipped:', _pvState.nSkipped);
  console.log('  mean |err| τ_drag:', (_pvState.sAbsTq / n).toFixed(1), 'N·m');
  console.log('  mean |err| dragMag:', (_pvState.sAbsDrag / n).toFixed(1), 'N');
  console.log('  mean |err| alpha:', (_pvState.sAbsAlpha / n).toExponential(3), '°');
  console.log('  mean |err| altitude:', (_pvState.sAbsAlt / n).toFixed(2), 'm');
  console.log('  mean |err| Q:', (_pvState.sAbsQ / n).toFixed(1), 'Pa');
};
_predictVerifierTick.getStatus = function () {
  const n = _pvState.nCompared || 1;
  return {
    ticks: _pvState.ticks,
    nCompared: _pvState.nCompared,
    nSkipped: _pvState.nSkipped,
    meanAbsErrTq: _pvState.sAbsTq / n,
    meanAbsErrAlphaDeg: _pvState.sAbsAlpha / n,
    meanAbsErrDragN: _pvState.sAbsDrag / n,
    meanAbsErrQPa: _pvState.sAbsQ / n,
    lastTq: _pvState.lastTq,
    lastAlpha: _pvState.lastAlpha,
    lastDrag: _pvState.lastDrag,
  };
};

GUIDES.predictVerifier = _predictVerifierTick;

// ============================================================
// predictivePlusAoAPush — east push prefix + predictivePlusAoA.
//
//   Phase 0..S : full east torque (RCS saturated)
//   Phase S+   : predictivePlusAoA verbatim — feedforward + PID +
//                AoA impulse. thetaTarget = atan2(relVx, −relVy)
//                (the AoA-zero branch the user verified works).
//
// No west phase. No cadence. Just push, then let AoA-chase take over.
// ============================================================
let   _SWEEP_S_SECONDS = 10.0;
const _SWEEP_FULL_TORQUE = 1e9;

const _predSweepState = {
  ticks: 0,
  phase: 'idle',
  elapsed: 0,
  lastTarget: 0,
  lastAchieved: 0,
  lastFires: 0,
  lastSaturated: false,
  lastThetaError: 0,
  lastOmega: 0,
  lastIntegralError: 0,
  lastAoaDeg: 0,
  lastDaoA: 0,
  aoaGrowing: false,
  lastCorrection: 0,
  lastTerms: { ff: 0, p: 0, d: 0, lead: 0, i: 0, aoa: 0, sweep: 0 },
};

let _predSweepIntegralError = 0;
let _predSweepPrevDragTorque = null;
let _predSweepTickCounter = 0;
let _predSweepAoaPendingFire = false; // kept for reset symmetry, unused now
let _predSweepStartTime = null;

// AoA bang-bang midpoint state machine:
//   idle    → capture AoA, start forward fire
//   forward → fire toward zero until |AoA| ≤ half initial AND dAoA is
//             moving toward zero — then switch to brake
//   brake   → fire opposite until dAoA ≈ 0 — then back to idle
let _aoaPrevForD = 0; // previous-tick AoA (radians), for dAoA/dt
let _aoaPrevForD_valid = false;

function _predSweepTick(snapshot) {
  _predSweepState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  // ---- Next-tick kinematics ----
  const cosT = Math.cos(dNow.theta), sinT = Math.sin(dNow.theta);
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIx * dt;
  const vy_n = dNow.vy + aIy * dt;
  
  const alpha = dNow.alphaAng;
  const omega_n = dNow.omega + alpha * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  const dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n,
    vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  });
  if (!dNext || !dNext.massProps) return;
  
  const dragNext = dNext.torqueDrag;
  
  // ---- Phase ----
  if (_predSweepStartTime === null) _predSweepStartTime = snapshot.simTime;
  const elapsed = snapshot.simTime - _predSweepStartTime;
  _predSweepState.elapsed = elapsed;
  const phase = elapsed < _SWEEP_S_SECONDS ? 'east' : 'chase';
  _predSweepState.phase = phase;
  
  let targetTorque;
  let terms = { ff: 0, p: 0, d: 0, lead: 0, i: 0, aoa: 0, sweep: 0 };
  
  if (phase === 'east') {
    // ---- Push prefix: full saturated east ----
    targetTorque = -_SWEEP_FULL_TORQUE;
    terms.sweep = targetTorque;
    _predSweepState.lastThetaError = 0;
    _predSweepState.lastOmega = dNow.omega;
    _predSweepState.lastIntegralError = _predSweepIntegralError;
    _predSweepState.lastAoaDeg = dNow.alphaDeg;
    _predSweepState.lastCorrection = 0;
  } else {
    // ---- predictivePlusAoA verbatim ----
    
    // Feedforward
    const ffTerm = -dragNext;
    
    // Proportional — thetaTarget = AoA-zero direction.
// Derivation: nose world direction = (−sinθ, cosθ). Align with
// relV: (−sinθ, cosθ) = k·(relVx, relVy), k>0.
//   → sinθ = −relVx/|relV|, cosθ = relVy/|relV|
//   → θ = atan2(−relVx, relVy)
// Test: relV = (0, 100) → θ = 0 (nose up). ✓
// Fallback to local vertical (θ = −atan2(rx, ry)) when relV is tiny.
const speedRelNow = dNow.speedRel || 0;
const thetaTarget = (speedRelNow > 0.5) ?
  Math.atan2(-dNow.relVx, dNow.relVy) :
  -Math.atan2(body.rx, body.ry);
let thetaError = body.theta - thetaTarget;
    while (thetaError > Math.PI) thetaError -= 2 * Math.PI;
    while (thetaError < -Math.PI) thetaError += 2 * Math.PI;
    const pTerm = -_PRED_GAINS.K_p * thetaError;
    _predSweepState.lastThetaError = thetaError;
    
    // Rate damping — brake |AoA| only when it is GROWING. d|AoA|/dt =
// dAoA × sign(AoA). If positive, |AoA| is expanding and we should
// oppose the motion. If negative, |AoA| is shrinking — leave it
// alone and let the P term finish the job. The old unconditional
// -K_d·dAoA fought every reduction, which (with K_d large) could
// overpower P and actually push AoA the wrong way.
const aoaRad_d = dNow.alphaDeg * Math.PI / 180;
const dAoA_d = _aoaPrevForD_valid ? (aoaRad_d - _aoaPrevForD) / dt : 0;
_aoaPrevForD = aoaRad_d;
_aoaPrevForD_valid = true;
const aoaIsGrowing = (aoaRad_d * dAoA_d) > 0;
const dTerm = aoaIsGrowing ? (-_PRED_GAINS.K_d * dAoA_d) : 0;
_predSweepState.lastOmega = dNow.omega;
_predSweepState.lastDaoA = dAoA_d;
_predSweepState.lastAoaGrowing = aoaIsGrowing;



    // Phase lead
    let leadTerm = 0;
    if (_PRED_GAINS.K_lead > 0 && _predSweepPrevDragTorque !== null) {
      const dTau_dt = (dragNext - _predSweepPrevDragTorque) / dt;
      leadTerm = -_PRED_GAINS.K_lead * dTau_dt;
    }
    _predSweepPrevDragTorque = dragNext;
    
    // Integral
    const iTerm = _PRED_GAINS.K_i * _predSweepIntegralError;
    _predSweepState.lastIntegralError = _predSweepIntegralError;
    
// AoA impulse term disabled for this experiment. Rate damping via
// the PID's -K_d·(dAoA/dt) term is now the sole attitude correction.
const aoaTerm = 0;
_predSweepState.lastAoaDeg = dNow.alphaDeg;
_predSweepState.lastCorrection = 0;
_predSweepState.aoaMode = 'disabled';


    targetTorque = ffTerm + pTerm + dTerm + leadTerm + iTerm + aoaTerm;
    terms = { ff: ffTerm, p: pTerm, d: dTerm, lead: leadTerm, i: iTerm, aoa: aoaTerm, sweep: 0 };
  }
  
  _predSweepState.lastTarget = targetTorque;
  _predSweepState.lastTerms = terms;
  
  // ---- Fire ----
  const result = GuideRCS.targetTorqueRcs(
    snapshot, targetTorque, idx,
    { comX: dNext.massProps.comX, comY: dNext.massProps.comY }
  );
  
  if (!result || !result.fires.length) {
    send(cmdRcsDuty({}));
    _predSweepState.lastAchieved = 0;
    _predSweepState.lastFires = 0;
    _predSweepState.lastSaturated = false;
    return;
  }
  
  send(cmdRcsDuty(result.duties));
  _predSweepState.lastAchieved = result.torqueAchieved;
  _predSweepState.lastFires = result.fires.length;
  _predSweepState.lastSaturated = result.saturated;
  
  if (_predSweepAoaPendingFire) {
    const aoaNowAbs = Math.abs(dNow.alphaDeg);
    if (!result.saturated || aoaNowAbs <= _AOA_THRESHOLD_DEG) {
      _predSweepAoaPendingFire = false;
    }
  }
  
  if (!result.saturated && !_predSweepAoaPendingFire) {
    const gap = targetTorque - result.torqueAchieved;
    _predSweepIntegralError += gap * dt;
    if (_predSweepIntegralError >  1e6) _predSweepIntegralError =  1e6;
    if (_predSweepIntegralError < -1e6) _predSweepIntegralError = -1e6;
  }
}

_predSweepTick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _predSweepState.ticks = 0;
  _predSweepState.phase = 'east';
  _predSweepState.elapsed = 0;
  _predSweepState.lastTarget = 0;
  _predSweepState.lastAchieved = 0;
  _predSweepState.lastFires = 0;
  _predSweepState.lastSaturated = false;
  _predSweepState.lastThetaError = 0;
  _predSweepState.lastOmega = 0;
  _predSweepState.lastIntegralError = 0;
  _predSweepState.lastAoaDeg = 0;
  _predSweepState.lastCorrection = 0;
  _predSweepState.lastTerms = { ff: 0, p: 0, d: 0, lead: 0, i: 0, aoa: 0, sweep: 0 };
  _predSweepIntegralError = 0;
  _predSweepPrevDragTorque = null;
    _predSweepTickCounter = 0;
  _predSweepAoaPendingFire = false;
  _predSweepStartTime = null;
      _aoaPrevForD = 0;
  _aoaPrevForD_valid = false;
  };
  
_predSweepTick.stop = function () {
  send(cmdRcsDuty(null));
};
_predSweepTick.getStatus = function () {
  return {
    ticks: _predSweepState.ticks,
    phase: _predSweepState.phase,
    elapsed: _predSweepState.elapsed,
    lastTarget: _predSweepState.lastTarget,
    lastAchieved: _predSweepState.lastAchieved,
    lastFires: _predSweepState.lastFires,
    lastSaturated: _predSweepState.lastSaturated,
    lastThetaError: _predSweepState.lastThetaError,
    lastOmega: _predSweepState.lastOmega,
    lastIntegralError: _predSweepState.lastIntegralError,
    lastAoaDeg: _predSweepState.lastAoaDeg,
    lastDaoA: _predSweepState.lastDaoA || 0,
    aoaGrowing: !!_predSweepState.lastAoaGrowing,
        lastCorrection: _predSweepState.lastCorrection,
      aoaMode: _predSweepState.aoaMode || 'idle',
      lastTerms: _predSweepState.lastTerms,
    };
    };

GUIDES.predictivePlusAoAPush = _predSweepTick;

function setSweepDuration(sec) {
  if (Number.isFinite(sec) && sec > 0) {
    _SWEEP_S_SECONDS = sec;
    console.log('[sweep] S =', sec, 's');
  }
}


// ============================================================
// gimbalPredictive2 — 2-tick lookahead gimbal control.
//
// At snapshot N:
//   g_N   = current gimbal angle
//   R_N   = current committed rate (from previous command)
//   g_{N+1} = g_N + R_N × dt    (physics will integrate this during tick N+1)
//
//   S_{N+1} = predict(S_N, gimbal = g_{N+1})
//   S_{N+2} = predict(S_{N+1}, gimbal = g_{N+1})   ← "don't change rate"
//
//   τ_drag(S_{N+2}) = ?  (from derive)
//   Solve g_req such that  τ_gimbal(g_req) = −τ_drag(S_{N+2})
//     where  τ_gimbal(g) = comY × F_total × sin(g)   (radians)
//     → g_req = asin(−τ_drag / (comY × F_total))
//
//   Clamp g_req to ±GIMBAL_MAX_DEG.
//
//   We want g_{N+2} = g_req, and g_{N+2} = g_{N+1} + R_{N+1} × dt
//     → R_{N+1} = (g_req − g_{N+1}) / dt
//
//   Clamp R_{N+1} to ±GIMBAL_RATE_DEG_S. Send it.
//
// Physics applies the rate starting next tick; by the tick after next
// the gimbal is at g_req and the drag torque at that instant is
// cancelled by gimbal torque. No RCS involved.
// ============================================================
const _gimbal2State = {
  ticks: 0,
  gN: 0,
  gN1: 0,
  gReq: 0,
  RReq: 0,
  RCmd: 0,
  tauDrag2: 0,
  saturated: false,
};

function _gimbalPredictive2Tick(snapshot) {
  _gimbal2State.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  // ---- Gimbal-capable engines ----
  const engines = body.engines || [];
  const gimbalEngines = engines.filter(e => e.gimbal);
  if (!gimbalEngines.length) return;
  
  const g_N = gimbalEngines[0].gimbalDeg || 0;
  const R_N = Number.isFinite(gimbalEngines[0].targetGimbalRateDegS)
    ? gimbalEngines[0].targetGimbalRateDegS : 0;
  
  // ---- Predict S_{N+1} ----
  // Two candidate predictions of the gimbal angle at tick N+1:
  //   - "if nothing changes": g = g_N + R_N·dt  (used for the state
  //     evolution prediction, so drag torque reflects the state we'll
  //     actually be in — drag barely depends on gimbal angle)
  //   - "if we command R_new": g = g_N + R_new·dt  (this is what the
  //     gimbal WILL be at N+1, and it's what the cancel condition is
  //     solved for)
  // We iterate once: use g_N + R_N·dt for the state, solve for g_req,
  // then compute R_new from g_N (not g_N1) so gimbal lands exactly on
  // g_req at N+1.
  const g_N1 = g_N + R_N * dt;
  
  // Predict S_{N+1} state (position, velocity, attitude) at gimbal = g_N1.
  const cosT = Math.cos(dNow.theta), sinT = Math.sin(dNow.theta);
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  
  const rx_n1 = dNow.rx + dNow.vx * dt;
  const ry_n1 = dNow.ry + dNow.vy * dt;
  const vx_n1 = dNow.vx + aIx * dt;
  const vy_n1 = dNow.vy + aIy * dt;
  
  const alpha = dNow.alphaAng;
  const omega_n1 = dNow.omega + alpha * dt;
  const theta_n1 = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n1 = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n1 = sloshNow.velocity || 0;
  
  const dN1 = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n1, ry: ry_n1,
    vx: vx_n1, vy: vy_n1,
    theta: theta_n1, omega: omega_n1,
    slosh: { offset: sloshX_n1, velocity: sloshV_n1 },
  }, g_N1);
  if (!dN1 || !dN1.massProps) return;
  
  const tauDrag1 = dN1.torqueDrag;
  _gimbal2State.tauDrag2 = tauDrag1;
  
  // ---- Solve g_req such that τ_gimbal(g_req) = −τ_drag(S_{N+1}) ----
  // τ_gimbal(g) ≈ A·cos(g) + B·sin(g)   [g in radians]
  //   A = Σ (e.x − comX)·F_e
  //   B = comY · Σ F_e
  // → R_amp·sin(g + φ) = target,   R_amp = √(A²+B²), φ = atan2(A, B)
  const comX1 = dN1.massProps.comX;
  const comY1 = dN1.massProps.comY;
  
  let A = 0, B = 0;
  gimbalEngines.forEach(e => {
    const F = (e.massFlowRate || 0) * (e.Ve || 0);
    A += ((e.x || 0) - comX1) * F;
    B += F;
  });
  B *= comY1;
  
  const targetTau = -tauDrag1;
  const Ramp = Math.hypot(A, B);
  let g_req_rad = 0;
  if (Ramp > 1) {
    const ratio = Math.max(-1, Math.min(1, targetTau / Ramp));
    const phi = Math.atan2(A, B);
    const s1 = Math.asin(ratio) - phi;
    const s2 = Math.PI - Math.asin(ratio) - phi;
    const wrap = (x) => { while (x > Math.PI) x -= 2*Math.PI; while (x < -Math.PI) x += 2*Math.PI; return x; };
    const w1 = wrap(s1), w2 = wrap(s2);
    g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
  }
  let g_req_deg = g_req_rad * 180 / Math.PI;
  
  // Clamp g_req to angle envelope.
  const MAX_ANG = (env && Number.isFinite(env.GIMBAL_MAX_DEG)) ? env.GIMBAL_MAX_DEG : 5;
  if (Math.abs(g_req_deg) > MAX_ANG) {
    g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
  }
  
  // ---- Rate required so gimbal lands on g_req at tick N+1 ----
  // Physics: g_{N+1} = g_N + R_new · dt   (rate we're about to send
  // applies during tick N+1 — that's the ONLY tick it will run, since
  // guidance replaces the rate again at snapshot N+1).
  const R_required = (g_req_deg - g_N) / dt;
  const MAX_RATE = (env && Number.isFinite(env.GIMBAL_RATE_DEG_S)) ? env.GIMBAL_RATE_DEG_S : 40;
  let R_cmd = R_required;
  let saturated = false;
  if (Math.abs(R_cmd) > MAX_RATE) {
    R_cmd = Math.sign(R_cmd) * MAX_RATE;
    saturated = true;
  }
  
  send(cmdSetGimbalRate(R_cmd));
  
    _gimbal2State.gN = g_N;
  _gimbal2State.gN1 = g_N1;
  _gimbal2State.gReq = g_req_deg;
  _gimbal2State.RReq = R_required;
  _gimbal2State.RCmd = R_cmd;
  _gimbal2State.saturated = saturated;
  
  // Aliases so the generic right-toolbar readout works. "Target" here
  // is the torque we WANT to cancel (= −τ_drag at N+1); "Achieved" is
  // the gimbal torque we're actually generating at g_req. Both are
  // torques in the same units as RCS guides' lastTarget/lastAchieved.
  const tauGimbalAchieved = A * Math.cos(g_req_rad) + B * Math.sin(g_req_rad);
  _gimbal2State.lastTarget = -tauDrag1;
  _gimbal2State.lastAchieved = tauGimbalAchieved;
  _gimbal2State.lastFires = 1; // one gimbal actuator, for parity
  }

_gimbalPredictive2Tick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _gimbal2State.ticks = 0;
  _gimbal2State.gN = 0;
  _gimbal2State.gN1 = 0;
  _gimbal2State.gReq = 0;
  _gimbal2State.RReq = 0;
  _gimbal2State.RCmd = 0;
  _gimbal2State.tauDrag2 = 0;
  _gimbal2State.saturated = false;
  console.log('[gimbalPredictive2] started');
};
_gimbalPredictive2Tick.stop = function () {
  // Rate 0 leaves gimbal at its current angle; no forced recentre.
  send(cmdSetGimbalRate(0));
  console.log('[gimbalPredictive2] stopped');
};
_gimbalPredictive2Tick.getStatus = function() {
  return {
    ticks: _gimbal2State.ticks,
    gN: _gimbal2State.gN,
    gN1: _gimbal2State.gN1,
    gReq: _gimbal2State.gReq,
    RReq: _gimbal2State.RReq,
    RCmd: _gimbal2State.RCmd,
    tauDrag2: _gimbal2State.tauDrag2,
    saturated: _gimbal2State.saturated,
    // Aliases for the generic right-toolbar readout
    lastTarget: _gimbal2State.lastTarget || 0,
    lastAchieved: _gimbal2State.lastAchieved || 0,
    lastFires: _gimbal2State.lastFires || 0,
  };
};

GUIDES.gimbalPredictive2 = _gimbalPredictive2Tick;

// ============================================================
// ascentRR — Rotate-Rest cycle on top of the successful
// gimbalPredictive2 core.
//
// Cycle: 10s REST (initial climb) → 10s ROTATE → 10s REST → ...
//   Rotate phase: τ_desired = EAST_SIGN · I · A · sin(2π·t/T)
//                 where A = 2π·Δθ_rad / T²
//   Rest phase:   τ_desired = -K_DAMP · I · ω_relative   (damps residual spin)
// Gimbal target torque: τ_gimbal = τ_desired − τ_drag_next (predicted).
// Gimbal rate solved and clamped the same way gimbalPredictive2 does.
//
// Δθ is decided at the START of every rotation, from that instant's
// dynamic pressure Q:  Δθ = DELTA_THETA_K / Q  (capped at MAX deg).
//
// Altitude gates:
//   ≥ PAUSE_ROTATE_KM (8 km):  finish current rotation if mid-flight,
//                              then REST-only (no more rotations)
//   ≥ RESUME_ROTATE_KM (14 km): reset cycle, resume rotate-rest fresh
//
// Throttle program:
//   10 km ≤ alt < 14 km:  THR_FRAC_LOW (0.7)
//   otherwise:            1.0
//
// ALL constants in ASCENT_RR below — tune directly.
// ============================================================
const ASCENT_RR = {
  // --- Rotate-rest cycle timing ---
// Rotate duration scales with Δθ: T_rotate = |Δθ_deg| seconds
// ("jitna degree, utna second"). Small rotations take proportionally
// less time, avoiding extended exposure where drag amplifies AoA.
CYCLE_ROTATE_S: 10, // default / fallback if scaling disabled
  CYCLE_REST_S: 5,
  // Dynamic-T clamp: keep the pulse width physically meaningful
  // (never shorter than MIN, never longer than MAX).
  ROTATE_T_MIN_S: 1.0,
  ROTATE_T_MAX_S: 10.0,
  ROTATE_T_SCALE: 1.0, // seconds per degree
  
// --- Δθ calibration: Δθ_deg = Δθ_MAX · exp(−Q / Q_SCALE) ---
// Exponential decay with dynamic pressure. Gives max rotation at
// low Q (near the pad), smoothly decays as Q grows through MaxQ.
//
// Constants chosen so MaxQ (~35 kPa) → Δθ ≈ 3°:
//   Q =      0 Pa → Δθ = 10.00°
//   Q =  3,000 Pa → Δθ ≈  9.02°
//   Q =  5,000 Pa → Δθ ≈  8.42°
//   Q = 10,000 Pa → Δθ ≈  7.08°
//   Q = 20,000 Pa → Δθ ≈  5.02°
//   Q = 35,000 Pa → Δθ ≈  2.99°   (MaxQ)
//
// Q_SCALE sets how fast Δθ falls with pressure. Higher Q_SCALE →
// gentler decay (more rotation deeper into ascent). Tune both at
// runtime via setAscentRR({...}).
DELTA_THETA_MAX_DEG: 5, // ° — value as Q → 0
  DELTA_THETA_Q_SCALE: 29000, // Pa — e-folding pressure
  
  // --- Rotation direction (east = downrange). Flip to +1 if the
  //     rocket rotates west with −1. ---
  ROTATION_EAST_SIGN: -1,
  
  // --- REST-phase omega damper (1/s). Adds τ = -K_DAMP · I · ω_rel
  //     during REST, so ω_rel decays as e^(-K_DAMP·t). Kills residual
  //     spin left over from the previous rotation (and drag-driven
  //     wobble) without interfering with the rotation program itself.
  //     2.0 → ω halves every ~0.35 s. ---
  K_DAMP:             2.0,
  
// --- Chain threshold ---
// After a ROTATE cycle completes, if |AoA| is still above this,
// skip REST and immediately start another ROTATE (with Δθ = current
// AoA). Prevents drag-driven AoA growth during idle rest when the
// alignment is still off.
AOA_CHAIN_THRESHOLD_DEG: 0.5,
  
  // --- Altitude gates ---
  PAUSE_ROTATE_KM: 8, // finish rotation, then REST-only
  RESUME_ROTATE_KM: 14, // reset cycle, resume rotate-rest
  
  // --- Throttle program ---
  THR_ALT_LOW_KM:     10,
  THR_ALT_HIGH_KM:    14,
  THR_FRAC_LOW:       0.7,
  THR_FRAC_HIGH:      1.0,
};

const _rrState = {
  init: false,
  ticks: 0,
  phase: 'REST',          // 'ROTATE' | 'REST'  (first 10s is REST)
  phaseStart: 0,          // simTime when current phase began
  currentDeltaDeg: 0,     // Δθ for the CURRENT rotation
  paused: false,
  wasPaused: false,
  lastThrottleSent: null,
  // debug — full snapshot for main-thread logging
  lastTauDesired: 0,
  lastTauDrag: 0,
  lastTauTarget: 0,
  lastGRate: 0,
  lastAltKm: 0,
  lastElapsed: 0,
  lastThetaInertial: 0,
  lastThetaRel: 0,
  lastOmegaInertial: 0,
  lastOmegaRel: 0,
  lastTargetThetaRel: 0,
  lastThetaErr: 0,
  lastQ: 0,
  lastGRadN: 0,
  lastGRadN1: 0,
  lastGReqDeg: 0,
  lastRReqDegS: 0,
  lastRcmdDegS: 0,
      lastInertia: 0,
    lastMass: 0,
    lastMode: 'ROTATE',
    firstRotateDone: false,
    currentT: 10, // active T for THIS rotation (seconds)
};

// Dynamic rotate duration: T = clamp(|Δθ_deg| × ROTATE_T_SCALE, MIN, MAX).
// Called every time a new ROTATE phase begins.
function _rrRotateT(Δθ_deg) {
  const cfg = ASCENT_RR;
  const s = Math.abs(Δθ_deg) * (Number.isFinite(cfg.ROTATE_T_SCALE) ? cfg.ROTATE_T_SCALE : 1);
  const mn = Number.isFinite(cfg.ROTATE_T_MIN_S) ? cfg.ROTATE_T_MIN_S : 1;
  const mx = Number.isFinite(cfg.ROTATE_T_MAX_S) ? cfg.ROTATE_T_MAX_S : 10;
  if (!Number.isFinite(s)) return cfg.CYCLE_ROTATE_S;
  return Math.max(mn, Math.min(mx, s));
}

function _rrDeltaThetaDeg(Q) {
  const maxDeg = ASCENT_RR.DELTA_THETA_MAX_DEG;
  const qScale = ASCENT_RR.DELTA_THETA_Q_SCALE;
  if (!Number.isFinite(maxDeg) || maxDeg <= 0) return 0;
  if (!Number.isFinite(qScale) || qScale <= 0) return maxDeg;
  const qEff = (Number.isFinite(Q) && Q > 0) ? Q : 0;
  const delta = maxDeg * Math.exp(-qEff / qScale);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return delta;
}

function _rrWrapPi(x) {
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function _rrTick(snapshot) {
  _rrState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  const altKm = dNow.altitudeAGL / 1000;
  const simT = snapshot.simTime;
  const cfg = ASCENT_RR;
  _rrState.lastAltKm = altKm;
  
  // ---------- Init ----------
  // First 10 seconds are REST — rocket climbs straight while flight is
  // still settling. Rotation begins at t=10s.
  if (!_rrState.init) {
  _rrState.init = true;
  _rrState.phase = 'REST';
  _rrState.phaseStart = simT;
  _rrState.currentDeltaDeg = 0; // set when first ROTATE begins
  _rrState.paused = altKm >= cfg.PAUSE_ROTATE_KM;
  _rrState.wasPaused = _rrState.paused;
  _rrState.firstRotateDone = false;
}
  
  // ---------- Pause / resume transitions ----------
  _rrState.wasPaused = _rrState.paused;
  if (altKm >= cfg.PAUSE_ROTATE_KM)   _rrState.paused = true;
  if (altKm >= cfg.RESUME_ROTATE_KM)  _rrState.paused = false;
  
 if (_rrState.wasPaused && !_rrState.paused) {
  // Just resumed after MaxQ. Reset cycle fresh: start with a ROTATE.
  // Past MaxQ, the disturbance is already established — go straight
  // to AoA-based alignment.
  _rrState.phase = 'ROTATE';
  _rrState.phaseStart = simT;
  _rrState.currentDeltaDeg = dNow.alphaDeg;
  _rrState.currentT = _rrRotateT(_rrState.currentDeltaDeg);
  _rrState.firstRotateDone = true;
}
  
  // ---------- Cycle clock ----------
  const elapsed = simT - _rrState.phaseStart;
  
  if (_rrState.paused) {
    if (_rrState.phase === 'ROTATE' && elapsed < cfg.CYCLE_ROTATE_S) {
      // Mid-rotation → finish it
    } else if (_rrState.phase !== 'REST') {
      _rrState.phase = 'REST';
      _rrState.phaseStart = simT;
    }
  } else {
    if (_rrState.phase === 'ROTATE') {
  if (elapsed >= _rrState.currentT) {
    // Chain ONLY when AoA is POSITIVE. Positive = velocity east of
    // body axis = we're still behind, rotate more east to catch up.
    // Negative = body has overshot east of velocity = go to REST
    // and let gravity rotate velocity east until AoA becomes
    // positive again.
    //
    // Chaining on negative AoA used to trigger a WEST pulse
    // (Δθ = currentDeltaDeg, dirSign flips), which undid the
    // previous east tilt — pushing the rocket back toward vertical
    // instead of continuing downrange.
    if (dNow.alphaDeg > cfg.AOA_CHAIN_THRESHOLD_DEG) {
  // Chained pulse — same sine formula, but HALF the T. Keeps
  // re-checks tight so we don't overshoot past the velocity
  // vector while AoA is still large.
  _rrState.phase = 'ROTATE';
  _rrState.phaseStart = simT;
  _rrState.currentDeltaDeg = dNow.alphaDeg;
  _rrState.currentT = _rrRotateT(_rrState.currentDeltaDeg) * 0.5;
} else {
      _rrState.phase = 'REST';
      _rrState.phaseStart = simT;
    }
  }
} else {
  if (elapsed >= cfg.CYCLE_REST_S) {
    _rrState.phase = 'ROTATE';
    _rrState.phaseStart = simT;
    if (!_rrState.firstRotateDone) {
      // First rotation — deliberate disturbance kick from the
      // Q-based formula. Sets a starting AoA that gravity then
      // rotates. Subsequent rotations align to whatever AoA that
      // rotation produced.
      _rrState.currentDeltaDeg = _rrDeltaThetaDeg(dNow.Q);
      _rrState.firstRotateDone = true;
    } else {
      // Δθ = current AoA. Sign carries direction; magnitude is
      // the current AoA in degrees.
      _rrState.currentDeltaDeg = dNow.alphaDeg;
    }
    // Scale T with this rotation's magnitude.
    _rrState.currentT = _rrRotateT(_rrState.currentDeltaDeg);
  }
}
  }
  
  // ---------- Predict next-tick state (same as gimbalPredictive2) ----------
  const cosT = Math.cos(dNow.theta), sinT = Math.sin(dNow.theta);
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIx * dt;
  const vy_n = dNow.vy + aIy * dt;
  const alpha = dNow.alphaAng;
  const omega_n = dNow.omega + alpha * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  const engines = body.engines || [];
  const gimbals = engines.filter(e => e.gimbal);
  if (!gimbals.length) return;
  
  const g_N  = gimbals[0].gimbalDeg || 0;
  const R_N  = Number.isFinite(gimbals[0].targetGimbalRateDegS)
    ? gimbals[0].targetGimbalRateDegS : 0;
  const g_N1 = g_N + R_N * dt;
  
  const dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n, vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  }, g_N1);
  if (!dNext || !dNext.massProps) return;
  
  const τ_drag_next = dNext.torqueDrag;
  _rrState.lastTauDrag = τ_drag_next;
  
  // ---------- τ_desired (uses next-tick I) ----------
  const I_next = dNext.massProps.I;
  const omegaEarth = (env && Number.isFinite(env.EARTH_OMEGA)) ? env.EARTH_OMEGA : 0;
  const ω_rel_now = dNow.omega + omegaEarth;
  let τ_desired = 0;
  if (_rrState.phase === 'ROTATE') {
  // Δθ = |AoA| captured at the start of this rotation. Direction
  // follows sign of AoA: positive (velocity east of body) → east
  // rotate; negative → west rotate.
  // T = dynamic, scaled with |Δθ| (jitna degree utna second).
  const T = _rrState.currentT;
  const Δθ_rad = Math.abs(_rrState.currentDeltaDeg) * Math.PI / 180;
  const A_ang = (2 * Math.PI * Δθ_rad) / (T * T);
  const omega_ang = (2 * Math.PI) / T;
  const tRel = Math.max(0, Math.min(T, elapsed));
  const dirSign = (_rrState.currentDeltaDeg >= 0) ?
    cfg.ROTATION_EAST_SIGN :
    -cfg.ROTATION_EAST_SIGN;
  τ_desired = dirSign * I_next * A_ang * Math.sin(omega_ang * tRel);
  _rrState.lastMode = 'ROTATE';
} else {
    // REST phase — residual-omega damper. Damp ω_relative (ground-
    // relative), NOT ω_inertial. ω_inertial carries Earth's own
    // rotation; damping it to zero would drift the rocket out of
    // alignment with local vertical at ω_earth rate.
    τ_desired = -cfg.K_DAMP * I_next * ω_rel_now;
    _rrState.lastMode = 'REST-DAMP';
  }
  _rrState.lastTauDesired = τ_desired;
  
  // ---------- Solve gimbal rate ----------
  const τ_target = τ_desired - τ_drag_next;
  _rrState.lastTauTarget = τ_target;
  
  const comX = dNext.massProps.comX;
  const comY = dNext.massProps.comY;
  let A_g = 0, B_g = 0;
  gimbals.forEach(e => {
    const F = (e.massFlowRate || 0) * (e.Ve || 0);
    A_g += ((e.x || 0) - comX) * F;
    B_g += F;
  });
  B_g *= comY;
  
  const R_amp = Math.hypot(A_g, B_g);
  let g_req_rad = 0;
  if (R_amp > 1) {
    const ratio = Math.max(-1, Math.min(1, τ_target / R_amp));
    const phi = Math.atan2(A_g, B_g);
    const w1 = _rrWrapPi(Math.asin(ratio) - phi);
    const w2 = _rrWrapPi(Math.PI - Math.asin(ratio) - phi);
    g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
  }
  let g_req_deg = g_req_rad * 180 / Math.PI;
  const MAX_ANG = (env && Number.isFinite(env.GIMBAL_MAX_DEG)) ? env.GIMBAL_MAX_DEG : 5;
  if (Math.abs(g_req_deg) > MAX_ANG) g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
  
  const R_req = (g_req_deg - g_N) / dt;
  const MAX_RATE = (env && Number.isFinite(env.GIMBAL_RATE_DEG_S)) ? env.GIMBAL_RATE_DEG_S : 40;
  const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));
  _rrState.lastGRate = R_cmd;
  
  // ---- Debug: capture full snapshot for main-thread logging ----
  const localVert = Math.atan2(-dNow.rx, dNow.ry);
  const targetThetaAbs = localVert + cfg.ROTATION_EAST_SIGN * (_rrState.currentDeltaDeg * Math.PI / 180);
  _rrState.lastElapsed = elapsed;
  _rrState.lastThetaInertial = dNow.theta;
  _rrState.lastThetaRel = dNow.theta - localVert;
  _rrState.lastOmegaInertial = dNow.omega;
  _rrState.lastOmegaRel = ω_rel_now;
  _rrState.lastTargetThetaRel = targetThetaAbs - localVert;
  _rrState.lastThetaErr = _rrWrapPi(targetThetaAbs - dNow.theta);
  _rrState.lastQ = dNow.Q;
  _rrState.lastGRadN = g_N;
  _rrState.lastGRadN1 = g_N1;
  _rrState.lastGReqDeg = g_req_deg;
  _rrState.lastRReqDegS = R_req;
  _rrState.lastRcmdDegS = R_cmd;
  _rrState.lastInertia = I_next;
  _rrState.lastMass = M;
  
  send(cmdSetGimbalRate(R_cmd));
  
  // ---------- Throttle program ----------
  let thrFrac = cfg.THR_FRAC_HIGH;
  if (altKm >= cfg.THR_ALT_LOW_KM && altKm < cfg.THR_ALT_HIGH_KM) {
    thrFrac = cfg.THR_FRAC_LOW;
  }
  let refMax = 0;
  engines.forEach(e => { if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate; });
  const targetFlow = thrFrac * refMax;
  
  if (_rrState.lastThrottleSent === null ||
      Math.abs(targetFlow - _rrState.lastThrottleSent) > 0.5) {
    send(cmdSetAllThrottle(targetFlow));
    _rrState.lastThrottleSent = targetFlow;
  }
}

_rrTick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _rrState.init = false;
  _rrState.ticks = 0;
  _rrState.phase = 'REST';
  _rrState.phaseStart = 0;
  _rrState.currentDeltaDeg = 0;
  _rrState.paused = false;
  _rrState.wasPaused = false;
  _rrState.lastThrottleSent = null;
  _rrState.lastTauDesired = 0;
  _rrState.lastTauDrag = 0;
  _rrState.lastTauTarget = 0;
  _rrState.lastGRate = 0;
  _rrState.lastAltKm = 0;
  _rrState.lastElapsed = 0;
  _rrState.lastThetaInertial = 0;
  _rrState.lastThetaRel = 0;
  _rrState.lastOmegaInertial = 0;
  _rrState.lastOmegaRel = 0;
  _rrState.lastTargetThetaRel = 0;
  _rrState.lastThetaErr = 0;
  _rrState.lastQ = 0;
  _rrState.lastGRadN = 0;
  _rrState.lastGRadN1 = 0;
  _rrState.lastGReqDeg = 0;
  _rrState.lastRReqDegS = 0;
  _rrState.lastRcmdDegS = 0;
  _rrState.lastInertia = 0;
_rrState.lastMass = 0;
_rrState.lastMode = 'ROTATE';
_rrState.firstRotateDone = false;
_rrState.currentT = 10;
console.log('[ascentRR] started');
};
_rrTick.stop = function () {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  _rrState.init = false;
  _rrState.phase = 'REST';
  console.log('[ascentRR] stopped');
};
_rrTick.getStatus = function () {
  return {
    ticks: _rrState.ticks,
    phase: _rrState.phase,
    mode: _rrState.lastMode,
    paused: _rrState.paused,
    altKm: _rrState.lastAltKm,
    elapsed: _rrState.lastElapsed,
    deltaDeg: _rrState.currentDeltaDeg,
    tauDesired: _rrState.lastTauDesired,
    tauDrag: _rrState.lastTauDrag,
    tauTarget: _rrState.lastTauTarget,
    gRate: _rrState.lastGRate,
    throttleFlow: _rrState.lastThrottleSent,
    thetaInertial: _rrState.lastThetaInertial,
    thetaRel: _rrState.lastThetaRel,
    omegaInertial: _rrState.lastOmegaInertial,
    omegaRel: _rrState.lastOmegaRel,
    targetThetaRel: _rrState.lastTargetThetaRel,
    thetaErr: _rrState.lastThetaErr,
    Q: _rrState.lastQ,
    gRadN: _rrState.lastGRadN,
    gRadN1: _rrState.lastGRadN1,
    gReqDeg: _rrState.lastGReqDeg,
    rReq: _rrState.lastRReqDegS,
    rCmd: _rrState.lastRcmdDegS,
    inertia: _rrState.lastInertia,
    mass: _rrState.lastMass,
  };
};

GUIDES.ascentRR = _rrTick;

// Runtime tuner — guidance worker console:
//   Guidance.setAscentRR({ DELTA_THETA_K: 150000, ROTATION_EAST_SIGN: 1 })
function setAscentRR(patch) {
  if (!patch) return;
  Object.keys(patch).forEach(k => {
    if (k in ASCENT_RR) ASCENT_RR[k] = patch[k];
  });
  console.log('[ascentRR] constants:', JSON.stringify(ASCENT_RR));
}
function getAscentRRConfig() { return { ...ASCENT_RR }; }
// ============================================================
// Ascent constants — pitch program, throttle program, cutoff,
// attitude gains. Populated by the ascent guide (to be written).
// All tunable values live here so the guide itself stays thin.
// ============================================================
const ASCENT = {
  // --- Pitch program (tilt from local vertical, positive = downrange/east) ---
  TILT_KM_MAXQ: 10, // tilt reaches TILT_MAXQ_DEG here
  TILT_KM_HOLD_END: 20, // hold at TILT_MAXQ_DEG through here
  TILT_KM_FINAL: 85, // tilt reaches TILT_FINAL_DEG here
  TILT_MAXQ_DEG: 20,
  TILT_FINAL_DEG: 60,
  // Sign convention: positive tilt = east/downrange. theta_relative for
  // east tilt is NEGATIVE in this sim (see gimbalPredictive2 comments),
  // so target_theta = local_vertical − tilt. Set EAST_SIGN = +1 if the
  // build has the opposite handedness.
  TILT_EAST_SIGN: -1,
  
  // --- Throttle program ---
  THR_KM_DOWN: 7, // start throttling down
  THR_KM_LOW: 10, // reach THR_LOW_FRAC
  THR_KM_UP: 16, // start throttling up
  THR_KM_FULL: 18, // reach 1.0
  THR_LOW_FRAC: 0.7,
  
  // --- Cutoff ---
  CUTOFF_KM: 80,
  
  // --- Attitude gains (torque per rad error / per rad/s rate) ---
  // I_xx of F9 ≈ 1.3e8 kg·m². Critically-damped ~1 rad/s bandwidth:
  //   K_p = I·ω_n² ≈ 1.3e8, K_d = 2·I·ω_n ≈ 2.6e8
  K_p: 1.3e8,
  K_d: 2.6e8,
};

// ============================================================
// predictivePlus — feedforward + PID hybrid.
//
//   targetTorque = −τ_drag_predicted          (feedforward)
//                − K_p · (θ − θ_target)      (attitude hold)
//                − K_d · ω                   (rate damping)
//                − K_lead · dτ_drag/dt       (phase lead)
//                + K_i · integral_error      (bias correction)
//
// The first term does the bulk disturbance work. The four feedback
// terms absorb model error, latency, RCS cross-coupling, and slow
// biases — everything that makes pure feedforward drift and eventually
// fail. Theta_target is the current local-vertical direction
// (-atan2(rx, ry)), so the rocket naturally holds "upright relative
// to ground".
// ============================================================
const _predictivePlusState = {
  ticks: 0,
  lastTarget: 0,
  lastAchieved: 0,
  lastFires: 0,
  lastSaturated: false,
  lastThetaError: 0,
  lastOmega: 0,
  lastIntegralError: 0,
  lastTerms: { ff: 0, p: 0, d: 0, lead: 0, i: 0 },
};

// Gains, tunable at runtime via Guidance.setPredictiveGains({...}).
// Tuned for F9-class stack (I ≈ 1.3e8 kg·m², RCS max ≈ 1.2e4 N·m per axis).
// Rough calibration:
//   K_p: 0.01 rad attitude error → ~3000 N·m correction
//   K_d: 0.01 rad/s rate error   → ~2000 N·m correction
//   K_i: 50 N·m persistent bias over 10 s → ~250 N·m correction
//   K_lead: 0 disables (needs noise-tolerant derivative to be useful)
const _PRED_GAINS = {
  K_p: 3.0e5,
  K_d: 5.0e7, // bumped for stronger rate damping
  K_lead: 0.0,
  K_i: 0.5,
};

let _predIntegralError = 0;      // N·m·s
let _predPrevDragTorque = null;  // N·m

function _predPlusTick(snapshot) {
  _predictivePlusState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  // ---- 1. Predict next-tick kinematics (no RCS assumed) ----
  const cosT = Math.cos(dNow.theta), sinT = Math.sin(dNow.theta);
  const thrustIx = dNow.thrustBodyX * cosT - dNow.thrustBodyY * sinT;
  const thrustIy = dNow.thrustBodyX * sinT + dNow.thrustBodyY * cosT;
  const aIx = dNow.gVecX + (thrustIx + dNow.dragVecX) / M;
  const aIy = dNow.gVecY + (thrustIy + dNow.dragVecY) / M;
  
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIx * dt;
  const vy_n = dNow.vy + aIy * dt;
  
  const alpha = dNow.alphaAng;
  const omega_n = dNow.omega + alpha * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha * dt * dt;
  
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  // ---- 2. Next-tick drag torque via deriveForState ----
  const dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n,
    vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  });
  if (!dNext || !dNext.massProps) return;
  
  const dragNext = dNext.torqueDrag;
  
  // ---- 3. The five terms ----
  
  // 3a. Feedforward — cancel predicted drag
  const ffTerm = -dragNext;
  
  // 3b. Proportional — attitude hold vs local vertical
  const thetaTarget = -Math.atan2(body.rx, body.ry);
  let thetaError = body.theta - thetaTarget;
  while (thetaError > Math.PI) thetaError -= 2 * Math.PI;
  while (thetaError < -Math.PI) thetaError += 2 * Math.PI;
  const pTerm = -_PRED_GAINS.K_p * thetaError;
  _predictivePlusState.lastThetaError = thetaError;
  
  // 3c. Rate damping
  const dTerm = -_PRED_GAINS.K_d * dNow.omega;
  _predictivePlusState.lastOmega = dNow.omega;
  
  // 3d. Phase lead — derivative of predicted drag torque
  let leadTerm = 0;
  if (_PRED_GAINS.K_lead > 0 && _predPrevDragTorque !== null) {
    const dTau_dt = (dragNext - _predPrevDragTorque) / dt;
    leadTerm = -_PRED_GAINS.K_lead * dTau_dt;
  }
  _predPrevDragTorque = dragNext;
  
  // 3e. Integral — accumulated torque deficit
  const iTerm = _PRED_GAINS.K_i * _predIntegralError;
  _predictivePlusState.lastIntegralError = _predIntegralError;
  
  const targetTorque = ffTerm + pTerm + dTerm + leadTerm + iTerm;
  _predictivePlusState.lastTarget = targetTorque;
  _predictivePlusState.lastTerms = {
    ff: ffTerm, p: pTerm, d: dTerm, lead: leadTerm, i: iTerm,
  };
  
  // ---- 4. Fire via GuideRCS at PREDICTED COM ----
  const result = GuideRCS.targetTorqueRcs(
    snapshot, targetTorque, idx,
    { comX: dNext.massProps.comX, comY: dNext.massProps.comY }
  );
  
  if (!result || !result.fires.length) {
    send(cmdRcsDuty({}));
    _predictivePlusState.lastAchieved = 0;
    _predictivePlusState.lastFires = 0;
    _predictivePlusState.lastSaturated = false;
    return;
  }
  
  send(cmdRcsDuty(result.duties));
  _predictivePlusState.lastAchieved = result.torqueAchieved;
  _predictivePlusState.lastFires = result.fires.length;
  _predictivePlusState.lastSaturated = result.saturated;
  
  // Anti-windup: only accumulate the deficit when RCS wasn't
  // saturated. If saturated, the gap isn't correctable — integrating
  // it would just build a huge terminal value and cause a rebound
  // the moment saturation lifts.
  if (!result.saturated) {
    const gap = targetTorque - result.torqueAchieved; // N·m
    _predIntegralError += gap * dt;
    // Clamp — safety against slow drift / numerical accumulation.
    if (_predIntegralError >  1e6) _predIntegralError =  1e6;
    if (_predIntegralError < -1e6) _predIntegralError = -1e6;
  }
}

_predPlusTick.start = function () {
  send(cmdSetAllThrottle(Infinity));
  _predictivePlusState.ticks = 0;
  _predictivePlusState.lastTarget = 0;
  _predictivePlusState.lastAchieved = 0;
  _predictivePlusState.lastFires = 0;
  _predictivePlusState.lastSaturated = false;
  _predictivePlusState.lastThetaError = 0;
  _predictivePlusState.lastOmega = 0;
  _predictivePlusState.lastIntegralError = 0;
  _predictivePlusState.lastTerms = { ff: 0, p: 0, d: 0, lead: 0, i: 0 };
  _predIntegralError = 0;
  _predPrevDragTorque = null;
};
_predPlusTick.stop = function () {
  send(cmdRcsDuty(null));
};
_predPlusTick.getStatus = function () {
  return {
    ticks: _predictivePlusState.ticks,
    lastTarget: _predictivePlusState.lastTarget,
    lastAchieved: _predictivePlusState.lastAchieved,
    lastFires: _predictivePlusState.lastFires,
    lastSaturated: _predictivePlusState.lastSaturated,
    lastThetaError: _predictivePlusState.lastThetaError,
    lastOmega: _predictivePlusState.lastOmega,
    lastIntegralError: _predictivePlusState.lastIntegralError,
    lastTerms: _predictivePlusState.lastTerms,
  };
};

GUIDES.predictivePlus = _predPlusTick;

// Runtime gain tuning — callable from the guidance worker console.
function setPredictiveGains(gains) {
  if (!gains) return;
  ['K_p', 'K_d', 'K_lead', 'K_i'].forEach(k => {
    if (Number.isFinite(gains[k])) _PRED_GAINS[k] = gains[k];
  });
  console.log('[predictivePlus] gains:', JSON.stringify(_PRED_GAINS));
}

function getPredictiveGains() { return { ..._PRED_GAINS }; }
  
  
  
// ============================================================
// ascentAoaHold — PUSH → COAST → HOLD with lag-free AoA derivatives.
//
//   PUSH  : sin pulse (T sec), east kick. AoA goes negative.
//   COAST : pure gimbalPredictive2 — drag cancel only. Body holds,
//           velocity catches up east, AoA drifts negative → positive.
//   HOLD  : triggered when AoA ≥ 0 AND ω_AoA > 0. Adds two extra
//           τ_desired terms:
//             τ_accel = −I_next · α_AoA_N1   (oppose AoA accel)
//             τ_damp  = −K · I_next · ω_AoA_N1 (damp AoA rate → 0)
//   Revert to COAST when AoA < 0 (or |AoA| blows past safety cap).
//
// Lag-free derivatives — both use the PREDICTED next-tick AoA
// (dNext.alphaDeg, verified exact by predictVerifier), not a
// 1-tick-backward finite difference:
//   ω_AoA_N1 = (AoA_N1 − AoA_N) / dt
//   α_AoA_N1 = (AoA_N1 − 2·AoA_N + AoA_N-1) / dt²
// ============================================================
const ASCENT_HOLD = {
    INITIAL_COAST_S: 11.3, // straight climb before the push pulse
  PUSH_T_S: 10.3,
  // --- PUSH amplitude, specified as the peak gimbal angle to swing to.
  //     At each tick during PUSH, the gimbal torque coefficients A/B
  //     (= −comX·ΣF, comY·ΣF) are computed from the current thrust and
  //     geometry, then the peak torque at this gimbal angle is
  //         τ_gimbal_max = A·cos(g_max) + B·sin(g_max)
  //     and the sine pulse amplitude is  A_ang = τ_gimbal_max / I.
  //&&      So the peak torque during the pulse equals the max the gimbal
  //     can produce at this angle — self-scaling with thrust & inertia.
  //
 //     Default 1.5° is calibrated to be roughly equivalent to the
//     previous PUSH_DELTA_DEG = 1° for the F9-class test stack. Tune
//     by feel.
PUSH_MAX_GIMBAL_DEG: 1.45,
  PUSH_EAST_SIGN: -1,
  HOLD_K_DAMP: 4.0, // sweet spot; 1.5+ aggressive
  HOLD_MAX_AOA_DEG: 8, // safety: blow past this → revert to COAST
  
  // --- dQ-driven east torque term (HOLD only) ---
  // Adds a non-negative east-only torque whose magnitude rises as dQ
  // goes negative (Q falling, post-MaxQ). Never flips to west.
  //   τ_dQ = -K_dQ · I · f(dQ)
  //   f(dQ) = 0.5 · (1 - tanh(dQ / Q_ref))   ∈ (0, 1]
  // Q_ref sets the dQ sensitivity scale. Typical dQ through MaxQ is
  // thousands of Pa/s, so 5000 sits the sigmoid's slope right over the
  // interesting range.
    HOLD_K_DQ: 0.005,
  HOLD_Q_REF: 1000,
  
// --- Throttle fraction (0..1) applied to every engine's own max
//     mass flow rate. 1.0 = full throttle (default), 0.7 = 70%.
//     Sent every tick via cmdSetAllThrottle(refMax × THROTTLE_FRAC);
//     physics's clampMassFlowCommand scales each engine down to its
//     own fraction of its own max. ---
THROTTLE_FRAC: 1.0,
  
  // --- Throttle-down band (AGL, km). Between LOW and HIGH the throttle
  //     drops to THROTTLE_FRAC_LOW — a Max-Q throttle bucket. Outside
  //     the band, base THROTTLE_FRAC applies. Half-open interval
  //     [LOW, HIGH): low edge inclusive, high edge exclusive. ---
  THROTTLE_ALT_LOW_KM: 8,
  THROTTLE_ALT_HIGH_KM: 13,
  THROTTLE_FRAC_LOW: 0.7,

// --- COASTnAoADAMP phase torque ---
    
    // --- COASTnAoADAMP phase torque ---
    //   τ_desired = (−COAST_DAMP_GAIN · I · AoA_N1) / COAST_DAMP_K²
    // Independent of the HOLD constants so both phases tune separately.
    COAST_DAMP_GAIN: 16,
    COAST_DAMP_K: 4.0,
  
};

const _hState = {
    init: false,
    ticks: 0,
    phase: 'PUSH', // 'PRE_COAST' | 'PUSH' | 'COAST' | 'HOLD'
    phaseStart: 0,
    currentDeltaDeg: 0, // locked Δθ for THIS PUSH pulse
    lastThrottleSent: undefined,
    lastQ: null, // previous tick's dynamic pressure (for dQ/dt)
    lastDQ: 0, // last computed dQ/dt for debug
    // debug
  // debug
  lastElapsed: 0,
  lastAltKm: 0,
  lastAoANowDeg: 0,
  lastAoANextDeg: 0,
  lastOmegaAoANow: 0,
  lastOmegaAoANext: 0,
  lastAlphaAoANext: 0,
  lastTauDesired: 0,
  lastTauDrag: 0,
  lastTauTarget: 0,
  lastGRate: 0,
  lastGRadN: 0,
  lastGReqDeg: 0,
};

function _hWrapPi(x) {
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

// Time from current 2-body state to the next apogee, in seconds.
// Exact via Kepler's equation (no numerical integration needed).
// Returns Infinity on escape trajectories.
function _hTimeToApogee(r, vr, vt, GM) {
  if (!(r > 0)) return Infinity;
  const E = 0.5 * (vr * vr + vt * vt) - GM / r;
  if (E >= 0) return Infinity;
  const a = -GM / (2 * E);
  const h = r * vt;
  const eSq = 1 + 2 * E * h * h / (GM * GM);
  const e = Math.sqrt(Math.max(0, eSq));
  if (e < 1e-9) {
    // Circular — apogee undefined; return half-period as a stand-in.
    return Math.PI * Math.sqrt(a * a * a / GM);
  }
  const cosE = (1 - r / a) / e;
  const sinE = (r * vr) / (e * Math.sqrt(GM * a));
  let E_an = Math.atan2(sinE, cosE);
  if (E_an < 0) E_an += 2 * Math.PI;
  const M = E_an - e * Math.sin(E_an);
  const n = Math.sqrt(GM / (a * a * a));
  if (M < Math.PI) return (Math.PI - M) / n;
  return (3 * Math.PI - M) / n;
}

// cfgOverride: optional config bag. When called directly by the
// ascentAoaHold guide, omitted → defaults to ASCENT_HOLD (legacy path).
// When called by leoInsertion's ASCENT phase, receives LEO_INSERTION.ASCENT
// so the two guides tune independently.
function _hTick(snapshot, cfgOverride) {
  _hState.ticks++;
  const idx = snapshot.activeBodyIndex || 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const dNow = Derivation.derive(snapshot, idx);
  if (!dNow || !dNow.massProps) return;
  
  const env = Derivation.getEnv();
  const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
  const M = dNow.massProps.M;
  if (!(M > 0)) return;
  
  const simT = snapshot.simTime;
  const altKm = dNow.altitudeAGL / 1000;
  _hState.lastAltKm = altKm;
  const cfg = cfgOverride || ASCENT_HOLD;
  
  // ---------- Init ----------
  if (!_hState.init) {
    _hState.init = true;
    _hState.phase = 'PRE_COAST';
    _hState.phaseStart = simT;
  }
  
  // ---------- Predict next-tick state ----------
  const cosTc = Math.cos(dNow.theta), sinTc = Math.sin(dNow.theta);
  const thrustIxC = dNow.thrustBodyX * cosTc - dNow.thrustBodyY * sinTc;
  const thrustIyC = dNow.thrustBodyX * sinTc + dNow.thrustBodyY * cosTc;
  const aIxC = dNow.gVecX + (thrustIxC + dNow.dragVecX) / M;
  const aIyC = dNow.gVecY + (thrustIyC + dNow.dragVecY) / M;
  const rx_n = dNow.rx + dNow.vx * dt;
  const ry_n = dNow.ry + dNow.vy * dt;
  const vx_n = dNow.vx + aIxC * dt;
  const vy_n = dNow.vy + aIyC * dt;
  const alpha_body = dNow.alphaAng;
  const omega_n = dNow.omega + alpha_body * dt;
  const theta_n = dNow.theta + dNow.omega * dt + 0.5 * alpha_body * dt * dt;
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  
  const engines = body.engines || [];
  const gimbals = engines.filter(e => e.gimbal);
  if (!gimbals.length) return;
  
  const g_N  = gimbals[0].gimbalDeg || 0;
  const R_N  = Number.isFinite(gimbals[0].targetGimbalRateDegS)
    ? gimbals[0].targetGimbalRateDegS : 0;
  const g_N1 = g_N + R_N * dt;
  
  const dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n, vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  }, g_N1);
  if (!dNext || !dNext.massProps) return;
  
  const τ_drag_next = dNext.torqueDrag;
  _hState.lastTauDrag = τ_drag_next;
  const I_next = dNext.massProps.I;
  
  // ---------- AoA derivatives — ANALYTIC, no finite difference ----------
  //
  //   AoA = atan2(u, v),   u = relV·bodyX,  v = relV·bodyY
  //
  //   First derivative:
  //     d(AoA)/dt = ω + (v·a_x − u·a_y) / r²
  //   Second derivative (with jerk ≈ 0 over one tick):
  //     d²(AoA)/dt² = α − 2·(v·a_x − u·a_y)·(u·a_x + v·a_y) / r⁴
  //
  //   where a_x, a_y are body-frame components of inertial acceleration,
  //   r² = u² + v².
  //
  // Both formulas are exact algebra — no 1/dt² amplification.
  //
  // Helper: computes u, v, a_x, a_y from a body-derived object.
  function bodyFrameKinematics(d, M_d) {
    const cosT = Math.cos(d.theta);
    const sinT = Math.sin(d.theta);
    const thrustIx = d.thrustBodyX * cosT - d.thrustBodyY * sinT;
    const thrustIy = d.thrustBodyX * sinT + d.thrustBodyY * cosT;
    const aIx = d.gVecX + (thrustIx + d.dragVecX) / M_d;
    const aIy = d.gVecY + (thrustIy + d.dragVecY) / M_d;
    const u = d.relVx * cosT + d.relVy * sinT;
    const v = -d.relVx * sinT + d.relVy * cosT;
    const ax = aIx * cosT + aIy * sinT;
    const ay = -aIx * sinT + aIy * cosT;
    return { u, v, ax, ay };
  }
  
  // Current tick (for trigger condition)
  // Current tick (for trigger condition AND for HOLD's Now-mode torque)
const kC = bodyFrameKinematics(dNow, M);
const r2C = kC.u * kC.u + kC.v * kC.v;
const PC = kC.v * kC.ax - kC.u * kC.ay;
const QC = kC.u * kC.ax + kC.v * kC.ay;
const omegaAoANow = (r2C > 1e-6) ? (dNow.omega + PC / r2C) : 0;
const alphaAoANow = (r2C > 1e-6) ? (dNow.alphaAng - 2 * PC * QC / (r2C * r2C)) : 0;
  
  // Next tick (for HOLD torque — lag-free)
  const kN = bodyFrameKinematics(dNext, dNext.massProps.M);
  const r2N = kN.u * kN.u + kN.v * kN.v;
  const PN  = kN.v * kN.ax - kN.u * kN.ay;
  const QN  = kN.u * kN.ax + kN.v * kN.ay;
  const omegaAoANext = (r2N > 1e-6) ? (dNext.omega + PN / r2N) : 0;
  const alphaAoANext = (r2N > 1e-6) ? (dNext.alphaAng - 2 * PN * QN / (r2N * r2N)) : 0;
  
  _hState.lastAoANowDeg = dNow.alphaDeg;
_hState.lastAoANextDeg = dNext.alphaDeg;
_hState.lastOmegaAoANow = omegaAoANow;
_hState.lastOmegaAoANext = omegaAoANext;
_hState.lastAlphaAoANow = alphaAoANow;
_hState.lastAlphaAoANext = alphaAoANext;

// Dynamic-pressure trend. Positive = still climbing toward MaxQ;
// negative = past MaxQ (or descending). Used by HOLD to choose
// between next-tick and current-tick torque calculation.
const Q_now = dNow.Q;
const dQ = (_hState.lastQ !== null) ? (Q_now - _hState.lastQ) / dt : 0;
_hState.lastQ = Q_now;
_hState.lastDQ = dQ;
  
  // ---------- Phase transitions ----------
  const elapsed = simT - _hState.phaseStart;
  
  if (_hState.phase === 'PRE_COAST') {
  if (elapsed >= cfg.INITIAL_COAST_S) {
    _hState.phase = 'PUSH';
    _hState.phaseStart = simT;

    // Lock Δθ for this PUSH pulse from the max gimbal angle at this
    // instant. Peak torque the gimbal can reach at PUSH_MAX_GIMBAL_DEG
    // — computed from current thrust + geometry — then Δθ follows
    // from the sine-pulse identity  Δθ = τ_peak · T² / (2π·I).
    // After this, the max-gimbal input is discarded; the pulse uses
    // the old formula with this locked Δθ for its entire duration.
    const g_max_rad = (Number.isFinite(cfg.PUSH_MAX_GIMBAL_DEG) ? cfg.PUSH_MAX_GIMBAL_DEG : 0) * Math.PI / 180;
    let A_gp = 0, B_gp = 0;
    gimbals.forEach(e => {
      const F = (e.massFlowRate || 0) * (e.Ve || 0);
      A_gp += ((e.x || 0) - dNext.massProps.comX) * F;
      B_gp += F;
    });
    B_gp *= dNext.massProps.comY;
    const tau_peak = A_gp * Math.cos(g_max_rad) + B_gp * Math.sin(g_max_rad);
    const Tp = cfg.PUSH_T_S;
    const deltaRad = (I_next > 0) ? (tau_peak * Tp * Tp) / (2 * Math.PI * I_next) : 0;
    _hState.currentDeltaDeg = deltaRad * 180 / Math.PI;
    _hState.lastLockedDeltaDeg = _hState.currentDeltaDeg; // debug
  }
} else if (_hState.phase === 'PUSH') {
    if (elapsed >= cfg.PUSH_T_S) {
      _hState.phase = 'COAST';
      _hState.phaseStart = simT;
    }
  } else if (_hState.phase === 'COAST') {
    // Trigger: AoA ≥ 0 AND ω_AoA > 0 (analytic).
    if (dNow.alphaDeg >= 0) { // && omegaAoANow > 0) {
      _hState.phase = 'HOLD';
      _hState.phaseStart = simT;
    }
  } else if (_hState.phase === 'HOLD') {
    if (dNow.alphaDeg < 0) { // || omegaAoANow < 0) {//Math.abs(dNow.alphaDeg) > cfg.HOLD_MAX_AOA_DEG) {
      _hState.phase = 'COASTnAoADAMP';
      _hState.phaseStart = simT;
    }
  }
  _hState.lastElapsed = elapsed;
  
  // ---------- τ_desired ----------
    let τ_desired = 0;
  if (_hState.phase === 'PUSH') {
    const T = cfg.PUSH_T_S;
    const Δθ_rad = _hState.currentDeltaDeg * Math.PI / 180;
    const A_ang = (2 * Math.PI * Δθ_rad) / (T * T);
    const omega_ang = (2 * Math.PI) / T;
    const tRel = Math.max(0, Math.min(T, elapsed));
    τ_desired = cfg.PUSH_EAST_SIGN * I_next * A_ang * Math.sin(omega_ang * tRel);
    _hState.lastTauDQ = 0;
  } else if (_hState.phase === 'COAST' || _hState.phase === 'PRE_COAST') {
  τ_desired = 0;
  _hState.lastTauDQ = 0;
} else if (_hState.phase === 'COASTnAoADAMP') {
  τ_desired = (-I_next * cfg.COAST_DAMP_GAIN * dNext.alphaDeg) /
    (cfg.COAST_DAMP_K * cfg.COAST_DAMP_K);
  _hState.lastTauDQ = 0;
} else { // HOLD
  // Two sub-modes based on dynamic-pressure trend:
  //   dQ/dt ≥ 0  → pre-MaxQ (or Q flat): use PREDICTED next-tick
  //                values. Q rising means next tick matters more than
  //                now (drag is growing).
  //   dQ/dt < 0  → past MaxQ: use CURRENT-tick values. Q falling means
  //                next tick's drag is already weaker than now, so
  //                predicting against the next tick would lag the
  //                actual pressure environment. Reacting on the
  //                current (higher-Q) state keeps the loop from
  //                feeling sluggish in the descent-side of the
  //                pressure hump.
  const useNow = (dQ < 0);
  const I_use = useNow ? dNow.massProps.I : I_next;
  const alpha_use = useNow ? alphaAoANow : alphaAoANext;
  const omega_use = useNow ? omegaAoANow : omegaAoANext;
  const τ_accel = -I_use * alpha_use;
  const τ_damp = -cfg.HOLD_K_DAMP * I_use * omega_use;
  
  // dQ-driven east nudge — always east (negative torque), never west.
  //   f ∈ (0, 1], rises as dQ falls below zero.
  const qRef = cfg.HOLD_Q_REF;
  const f_dQ = (Number.isFinite(qRef) && qRef > 0) ?
    0.5 * (1 - Math.tanh(dQ / qRef)) :
    0.5;
    const τ_dQ = -cfg.HOLD_K_DQ * I_use * f_dQ;
  _hState.lastTauDQ = τ_dQ;
  
  τ_desired = τ_accel + τ_damp + τ_dQ;
  }
  _hState.lastTauDesired = τ_desired;
  
  // ---------- Solve gimbal rate ----------
  const τ_target = τ_desired - τ_drag_next;
  _hState.lastTauTarget = τ_target;
  
  const comX = dNext.massProps.comX;
  const comY = dNext.massProps.comY;
  let A_g = 0, B_g = 0;
  gimbals.forEach(e => {
    const F = (e.massFlowRate || 0) * (e.Ve || 0);
    A_g += ((e.x || 0) - comX) * F;
    B_g += F;
  });
  B_g *= comY;
  
  const R_amp = Math.hypot(A_g, B_g);
  let g_req_rad = 0;
  if (R_amp > 1) {
    const ratio = Math.max(-1, Math.min(1, τ_target / R_amp));
    const phi = Math.atan2(A_g, B_g);
    const w1 = _hWrapPi(Math.asin(ratio) - phi);
    const w2 = _hWrapPi(Math.PI - Math.asin(ratio) - phi);
    g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
  }
  let g_req_deg = g_req_rad * 180 / Math.PI;
  const MAX_ANG = (env && Number.isFinite(env.GIMBAL_MAX_DEG)) ? env.GIMBAL_MAX_DEG : 20;
  if (Math.abs(g_req_deg) > MAX_ANG) g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
  
  const R_req = (g_req_deg - g_N) / dt;
  const MAX_RATE = (env && Number.isFinite(env.GIMBAL_RATE_DEG_S)) ? env.GIMBAL_RATE_DEG_S : 40;
  const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));
  
  _hState.lastGRate = R_cmd;
  _hState.lastGRadN = g_N;
  _hState.lastGReqDeg = g_req_deg;
  
  send(cmdSetGimbalRate(R_cmd));
  
// ---------- Throttle: base frac, overridden to low frac inside band ----------
//   refMax is the largest maxMassFlowRate among this stack's engines.
//   Sending refMax × frac lets physics's clampMassFlowCommand scale
//   each engine to its own frac of its own max — exact for the normal
//   homogeneous octaweb case.
let refMax = 0;
engines.forEach(e => { if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate; });

// Base throttle fraction.
let thrFrac = (Number.isFinite(cfg.THROTTLE_FRAC) && cfg.THROTTLE_FRAC > 0) ?
  Math.min(1, cfg.THROTTLE_FRAC) : 1.0;

// Max-Q bucket — half-open [LOW, HIGH) in AGL km.
const thrLow = Number.isFinite(cfg.THROTTLE_ALT_LOW_KM) ? cfg.THROTTLE_ALT_LOW_KM : Infinity;
const thrHigh = Number.isFinite(cfg.THROTTLE_ALT_HIGH_KM) ? cfg.THROTTLE_ALT_HIGH_KM : -Infinity;
if (altKm >= thrLow && altKm < thrHigh) {
  const lowFrac = Number.isFinite(cfg.THROTTLE_FRAC_LOW) ? cfg.THROTTLE_FRAC_LOW : thrFrac;
  thrFrac = Math.max(0, Math.min(1, lowFrac));
}

const targetFlow = refMax * thrFrac;
if (_hState.lastThrottleSent === undefined ||
  Math.abs(targetFlow - _hState.lastThrottleSent) > 0.5) {
  send(cmdSetAllThrottle(targetFlow));
  _hState.lastThrottleSent = targetFlow;
}
  }

_hTick.start = function() {
    send(cmdSetAllThrottle(Infinity));
    _hState.init = false;
_hState.ticks = 0;
_hState.phase = 'PRE_COAST';
_hState.phaseStart = 0;
_hState.currentDeltaDeg = 0;
_hState.lastThrottleSent = undefined;
_hState.lastQ = null;
_hState.lastDQ = 0;
  console.log('[ascentAoaHold] started');
};
_hTick.stop = function () {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  _hState.init = false;
  console.log('[ascentAoaHold] stopped');
};
_hTick.getStatus = function() {
    return {
      ticks: _hState.ticks,
      phase: _hState.phase,
      elapsed: _hState.lastElapsed,
      lockedDeltaDeg: _hState.currentDeltaDeg,
    altKm: _hState.lastAltKm,
    aoaDeg: _hState.lastAoANowDeg,
    aoaNextDeg: _hState.lastAoANextDeg,
    omegaAoANow: _hState.lastOmegaAoANow,
    omegaAoANext: _hState.lastOmegaAoANext,
    alphaAoANow: _hState.lastAlphaAoANow,
  alphaAoANext: _hState.lastAlphaAoANext,
  dQ: _hState.lastDQ,
  tauDQ: _hState.lastTauDQ,
    tauDesired: _hState.lastTauDesired,
    tauDrag: _hState.lastTauDrag,
    tauTarget: _hState.lastTauTarget,
    gRate: _hState.lastGRate,
    gRadN: _hState.lastGRadN,
    gReqDeg: _hState.lastGReqDeg,
  };
};

GUIDES.ascentAoaHold = _hTick;

function setAscentHold(patch) {
  if (!patch) return;
  Object.keys(patch).forEach(k => {
    if (k in ASCENT_HOLD) ASCENT_HOLD[k] = patch[k];
  });
  console.log('[ascentAoaHold] constants:', JSON.stringify(ASCENT_HOLD));
}
  function getAscentHoldConfig() { return { ...ASCENT_HOLD }; }
  
// ============================================================
// leoInsertion — full mission superguide.
//
// Sequential phases inside one tick (implementation to follow):
//   1. ASCENT   — delegates to _hTick (ascentAoaHold's full phase
//                 machine: PRE_COAST → PUSH → COAST → HOLD →
//                 COASTnAoADAMP). ASCENT_HOLD constants stay
//                 authoritative for this phase.
//   2. MECO     — engines cut at MECO_ALT_KM.
//   3. FAIRING  — once alt ≥ FAIRING_OPEN_ALT_KM, send
//                 cmdSplitFairing(). Idempotent — fires once.
//   4. SETTLE   — RCS drives inertial ω toward RCS_OMEGA_TARGET,
//                 within RCS_SETTLE_TOL.
//   5. SEPARATE — send cmdSeparate(). Booster becomes free.
//   6. STAGE    — upper-stage ignition, orbit insertion at
//                 TARGET_ORBIT_ALT_KM.
//
// This guide is a stub — tick() returns immediately. The command
// handlers it will dispatch (splitFairing, separate, releasePayload,
// emergencyEject, takeControl) are already wired in the tester and
// fast pages' localDispatch, so this tick can start calling them
// the moment the phase machine lands.
// ============================================================
const LEO_INSERTION = {
    // ---- Ascent constants (independent copy of ASCENT_HOLD) ----
    // leoInsertion's ASCENT phase runs `_hTick` with THIS config, not the
    // shared ASCENT_HOLD. Same keys, same defaults to start, but tunable
    // independently — editing here never touches ascentAoaHold's behavior,
    // and vice versa. This is what makes the two guides tuneable apart.
    ASCENT: {
      INITIAL_COAST_S: 4.9,
      PUSH_T_S: 4.8,
      PUSH_MAX_GIMBAL_DEG: 1.45,
      PUSH_EAST_SIGN: -1,
      HOLD_K_DAMP: 4.0,
      HOLD_MAX_AOA_DEG: 8,
      HOLD_K_DQ: 0.005,
      HOLD_Q_REF: 1000,
      THROTTLE_FRAC: 1.0,
      THROTTLE_ALT_LOW_KM: 8,
      THROTTLE_ALT_HIGH_KM: 13,
      THROTTLE_FRAC_LOW: 0.7,
      COAST_DAMP_GAIN: 16,
      COAST_DAMP_K: 4.0,
    },
    
    // ---- Hand-off from ascent ----
    // MECO fires when the current osculating apogee (from live inertial
    // state, thrust NOT assumed) reaches this value. Altitude-based
    // trigger is gone — apogee is the physically meaningful target.
    MECO_APOGEE_KM: 150,

  // ---- Separation phase targets ----
  // Phase 1 (axial): fire booster RCS `dn` nozzles until the gap along
  // the retained body's nose axis reaches AXIAL_SEP_TARGET_M.
  AXIAL_SEP_TARGET_M:   10,
  // Phase 2 (lateral): fire booster RCS LEFT pods' `lat` nozzles until
  // the perpendicular-to-nose-axis distance reaches LATERAL_SEP_TARGET_M.
  LATERAL_SEP_TARGET_M: 5,
  // Safety net: if the split hasn't been detected within this many sim
  // seconds after MECO, abort the spool phase and go straight to STAGE.
  // Guards against a stuck two-phase sequence (shouldn't happen, but the
  // phase machine must never lock up).
  SPLIT_TIMEOUT_S:      10,

  // ---- Fairing opening (post-separation) ----
  FAIRING_OPEN_ALT_KM:  80,
  FAIRING_OPEN_ENABLED: true,

  // ---- Target orbit ----
  TARGET_ORBIT_ALT_KM:  180,
  // Reference bands (CONFIG.*):
  //   160–2000 km  → LEO
  //   2000–35786   → MEO
  //   35786 km     → GEO

// ---- RCS settle (post-separation, pre-stage-burn) ----
RCS_OMEGA_TARGET: 0,
  RCS_SETTLE_TOL: 1e-4,
  
  // ---- Coast → circularization planning ----
  // After TARGET_APOGEE cuts the engine, apogee is fixed (two-body).
  // Guidance computes: V_apogee, V_orbital, Δv, fuel needed (Tsiolkovsky),
  // T_burn = fuel/mdot, and T_coast = time-to-apogee (numerical).
  // Burn triggers when T_remaining_to_apogee ≤ COAST_BURN_TRIGGER_FRAC × T_burn.
  COAST_BURN_TRIGGER_FRAC: 1.0,
  
  // Horizontal target = local vertical rotated −90° (east prograde).
  // CW direction, matches ascent convention where east tilt = negative
  // θ_rel.
  COAST_TARGET_TILT_DEG: -90,
  
  // Rotation to horizontal — same bang-bang as ROTATE_BANG_BANG.
  COAST_ROTATE_TOL_DEG: 0.5,
  COAST_ROTATE_OMEGA_TOL: 0.02,
  COAST_ROTATE_TIMEOUT_S: 240,
  
  // Circularization burn.
  CIRC_VEL_TOL_MPS: 5, // cutoff tolerance on |v − v_orb|
  CIRC_DECAY_FRAC: 0.05, // decay window as frac of V_orbital
  CIRC_ATT_KP: 0.5, // gimbal attitude hold P gain
  CIRC_ATT_KD: 4.0, // gimbal attitude hold D gain

  // ---- Stage (upper) phase ----
  STAGE: {
      BURN_ALT_KM: 80,
      TARGET_VEL_MPS: 7800,
      CUTOFF_TOL_V: 5,
    },
    
// ---- ROTATE — bang-bang RCS rotation to steep climb angle ----
// Engine OFF during rotation. RCS fires max torque in one direction
// until θ passes the midpoint (start + target) / 2, then max torque
// opposite to decelerate. Time-optimal for a rigid body with
// saturating actuator and no rate limit.
//
// Target: east tilt from local vertical. Ascent convention: east is
// negative θ_rel.
ANG_FOR_APOG_TILT_DEG: 10,
  // Exit tolerance — tilt error and angular rate below these = done.
  ROTATE_TOL_DEG: 0.5,
  ROTATE_OMEGA_TOL: 0.02,
  // Safety: bail out of rotation if it takes this long (RCS may be
  // too weak to reach target on a heavy stage; DONE is preferable to
  // a phase-machine hang).
  ROTATE_TIMEOUT_S: 90,
    
    // ---- targetApogee — raise apogee to target orbit altitude ----
    // Full throttle until apogee is within TARGET_APOGEE_MARGIN_KM of the
    // target, then min throttle for a soft approach, then cutoff. The
    // margin exists because at orbital velocity the apogee moves several km
    // per tick — without it the cutoff would overshoot by tens of km.
    TARGET_APOGEE_MARGIN_KM: 10,
    // Inertial ω damper gain (1/s) — same shape as ascent's REST damper.
    STAGE_OMEGA_DAMP: 2.0,
  };

const _leoState = {
  init: false,
  ticks: 0,
  phase: 'ASCENT',
  // 'ASCENT' | 'MECO_SPOOL' | 'SEPARATED_AXIAL' | 'SEPARATED_LATERAL'
  // | 'STAGE_COAST' | 'ANG_FOR_APOGEE' | 'TARGET_APOGEE' | 'DONE'
  phaseStart: 0,
  mecoTriggered: false,
  splitDetected: false,
  fairingOpened: false,
  initialBodyCount: 0,
  preSplitBodyId: null,
  boosterIdx: -1,
  stageIdx: -1,
  // Debug / status
  lastAltKm: 0,
  lastAxialGap: 0,
  lastLateralGap: 0,
      angStartTiltDeg: null, // tilt at ROTATE entry
    bangMidpointDeg: null, // (start + target) / 2
    lastApogeeKm: 0,
    lastApogeeSimT: 0,
    // Coast-to-apogee / circularization plan (locked at TARGET_APOGEE cutoff)
    coastCutoffSimT: 0,
    coastApogeeKm: 0,
    coastVApogee: 0,
    coastVOrbital: 0,
    coastDeltaV: 0,
    coastFuelNeeded: 0,
    coastTBurn: 0,
    coastTCoast: 0,
    // Coast rotate state
      coastRotateStartTilt: null,
    coastRotateMid: null,
    // Live circularization readout (updated every CIRCULARIZE tick)
    circCurrentV: 0,
    circTargetV: 0,
    circErr: 0,
    circAchieved: false,
  };

function _leoTick(snapshot) {
  _leoState.ticks++;
  if (!snapshot || !Array.isArray(snapshot.bodies) || !snapshot.bodies.length) return;

  const idx = (Number.isInteger(snapshot.activeBodyIndex)) ? snapshot.activeBodyIndex : 0;
  const body = snapshot.bodies[idx];
  if (!body) return;
  const simT = snapshot.simTime;

  // ---------- Init ----------
  if (!_leoState.init) {
  _leoState.init = true;
  _leoState.phase = 'ASCENT';
  _leoState.phaseStart = simT;
  _leoState.mecoTriggered = false;
  _leoState.splitDetected = false;
  _leoState.fairingOpened = false;
  _leoState.initialBodyCount = snapshot.bodies.length;
  _leoState.preSplitBodyId = body.id || null;
  _leoState.boosterIdx = -1;
  _leoState.stageIdx = idx;
  
  // Kick off the ascent sub-guide — commands engines to full throttle,
  // resets its internal phase machine. Its per-tick function is called
  // below in the ASCENT branch, but its .start() hook must run once.
  if (typeof _hTick !== 'undefined' && typeof _hTick.start === 'function') {
    try { _hTick.start(); } catch (e) { console.error('[leoInsertion] _hTick.start failed', e); }
  }
  console.log('[leoInsertion] started, phase ASCENT');
}

// ---------- Derive current state ----------
const d = Derivation.derive(snapshot, idx);
if (!d || !d.massProps) return;
_leoState.lastAltKm = d.altitudeAGL / 1000;

// ---------- Derive next-tick predicted state (used by drag-cancel and
// the COASTnAoADAMP formula in stage phases) ----------
const env = Derivation.getEnv();
const dt = (env && Number.isFinite(env.DT)) ? env.DT : (1 / 80);
const M_d = d.massProps.M;
let dNext = null;
if (M_d > 0) {
  const cosT = Math.cos(d.theta), sinT = Math.sin(d.theta);
  const thrustIx = d.thrustBodyX * cosT - d.thrustBodyY * sinT;
  const thrustIy = d.thrustBodyX * sinT + d.thrustBodyY * cosT;
  const aIx = d.gVecX + (thrustIx + d.dragVecX) / M_d;
  const aIy = d.gVecY + (thrustIy + d.dragVecY) / M_d;
  const rx_n = d.rx + d.vx * dt;
  const ry_n = d.ry + d.vy * dt;
  const vx_n = d.vx + aIx * dt;
  const vy_n = d.vy + aIy * dt;
  const omega_n = d.omega + d.alphaAng * dt;
  const theta_n = d.theta + d.omega * dt + 0.5 * d.alphaAng * dt * dt;
  const sloshNow = body.slosh || { offset: 0, velocity: 0 };
  const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
  const sloshV_n = sloshNow.velocity || 0;
  dNext = Derivation.deriveForState(snapshot, idx, {
    rx: rx_n, ry: ry_n, vx: vx_n, vy: vy_n,
    theta: theta_n, omega: omega_n,
    slosh: { offset: sloshX_n, velocity: sloshV_n },
  });
}

// ---------- Phase machine ----------
  switch (_leoState.phase) {

// =========================================================
// ASCENT — delegate to ascentAoaHold's full tick, then check
// for MECO trigger on osculating apogee.
// =========================================================
case 'ASCENT': {
  if (typeof _hTick === 'function') {
    _hTick(snapshot, LEO_INSERTION.ASCENT);
  }
  if (!_leoState.mecoTriggered) {
    // Current osculating apogee from live inertial state. No thrust
    // assumed — this is the apogee the stack would reach if the
    // engines cut THIS instant, which is exactly what MECO means.
    const r_m = Math.hypot(body.rx, body.ry);
    const ux_m = body.rx / r_m, uy_m = body.ry / r_m;
    const ex_m = body.ry / r_m, ey_m = -body.rx / r_m;
    const vr_m = body.vx * ux_m + body.vy * uy_m;
    const vt_m = body.vx * ex_m + body.vy * ey_m;
    const GM_m = env.GM_EARTH;
    const R_m = env.EARTH_RADIUS;
    const E_m = 0.5 * (vr_m * vr_m + vt_m * vt_m) - GM_m / r_m;
    let apogeeKm = Infinity;
    if (E_m < 0) {
      const a_m = -GM_m / (2 * E_m);
      const h_m = r_m * vt_m;
      const e_m = Math.sqrt(Math.max(0, 1 + 2 * E_m * h_m * h_m / (GM_m * GM_m)));
      apogeeKm = (a_m * (1 + e_m) - R_m) / 1000;
    }
    _leoState.lastApogeeKm = apogeeKm;

    if (apogeeKm >= LEO_INSERTION.MECO_APOGEE_KM) {
      _leoState.mecoTriggered = true;
      _leoState.phase = 'MECO_SPOOL';
      _leoState.phaseStart = simT;

      if (typeof cmdSeparate === 'function') send(cmdSeparate());

      console.log('[leoInsertion] MECO — apogee',
        apogeeKm.toFixed(2), 'km (target',
        LEO_INSERTION.MECO_APOGEE_KM, 'km) — separation commanded');
    }
  }
  break;
}

    // =========================================================
    // MECO_SPOOL — separation requested, waiting for engine cutoff
    // to complete and the actual split to occur.
    // =========================================================
    case 'MECO_SPOOL': {
  // No commands during the spool window — waiting for engine cutoff
  // to complete and the split to physically fire. Pre-split RCS
  // firing was tried and removed (see MECO trigger comment above).
  // Detection only.
  
  // Detect the split by body-count increase.
  if (snapshot.bodies.length > _leoState.initialBodyCount) {
    _leoState.splitDetected = true;

        // Identify: stage is the body whose id matches the pre-split
        // active body; booster is the newly-appended one.
        const stageIdx = _leoState.preSplitBodyId != null
          ? snapshot.bodies.findIndex(b => b.id === _leoState.preSplitBodyId)
          : idx;
        const boosterIdx = snapshot.bodies.findIndex((b, i) =>
          i !== stageIdx && b && !b.isActive);

        _leoState.stageIdx = (stageIdx >= 0) ? stageIdx : idx;
        _leoState.boosterIdx = (boosterIdx >= 0) ? boosterIdx : (1 - _leoState.stageIdx);

        _leoState.phase = 'SEPARATED_AXIAL';
        _leoState.phaseStart = simT;
        console.log('[leoInsertion] split detected — booster idx', _leoState.boosterIdx,
          'stage idx', _leoState.stageIdx);
        break;
      }

      // Safety timeout — if split never lands, don't lock up.
      if (simT - _leoState.phaseStart > LEO_INSERTION.SPLIT_TIMEOUT_S) {
        console.warn('[leoInsertion] split timeout — advancing to STAGE');
        _leoState.phase = 'STAGE';
        _leoState.phaseStart = simT;
      }
      break;
    }

    // =========================================================
    // SEPARATED_AXIAL — booster fires dn duty (full) each tick.
    // Terminates when the gap along the stage's nose axis reaches
    // AXIAL_SEP_TARGET_M, measured BEYOND the initial adjacency
    // (bases start adjacent, gap = 0, grows as booster moves away).
    // =========================================================
    case 'SEPARATED_AXIAL': {
      const bIdx = _leoState.boosterIdx;
      const sIdx = _leoState.stageIdx;
      if (bIdx < 0 || sIdx < 0) { _leoState.phase = 'STAGE'; break; }
      const boosterBody = snapshot.bodies[bIdx];
      const stageBody = snapshot.bodies[sIdx];
      if (!boosterBody || !stageBody) { _leoState.phase = 'STAGE'; break; }

      // Booster fires dn (tailward), stage fires up (noseward) —
// both bodies actively push apart. Balanced RCS keeps the pair's
// net momentum zero and lets the stage hold attitude.
const boosterDuties = GuideRCS.postSeparationAxialDuty(snapshot, bIdx, 'dn');
if (boosterDuties) send(cmdRcsDuty(boosterDuties, bIdx));
const stageDuties = GuideRCS.postSeparationAxialDuty(snapshot, sIdx, 'up');
if (stageDuties) send(cmdRcsDuty(stageDuties, sIdx));

      // Measure axial gap along the STAGE's nose axis.
      const boosterHeight = (boosterBody.members && boosterBody.members[0])
        ? (boosterBody.members[0].height || 0) : 0;
      const upX = -Math.sin(stageBody.theta);
      const upY = Math.cos(stageBody.theta);
      const dx = stageBody.rx - boosterBody.rx;
      const dy = stageBody.ry - boosterBody.ry;
      const proj = dx * upX + dy * upY;
      const axialGap = Math.max(0, proj - boosterHeight);
      _leoState.lastAxialGap = axialGap;

      if (axialGap >= LEO_INSERTION.AXIAL_SEP_TARGET_M) {
  // Release BOTH bodies' RCS duty — lateral phase is skipped.
  // Straight to ROTATE_BANG_BANG: engines stay off, RCS does the
  // slew to climb angle. No Karman-line coast in between — the
  // stage's ballistic apogee right after separation (~180 km) is
  // BELOW target, so a coast-then-burn would let it drift up
  // unused and then burn to overshoot. Rotate and burn NOW.
  send(cmdRcsDuty(null, sIdx));
  send(cmdRcsDuty(null, bIdx));
  _leoState.phase = 'ROTATE_BANG_BANG';
  _leoState.phaseStart = simT;
  _leoState.angStartTiltDeg = null;
  _leoState.bangMidpointDeg = null;
  console.log('[leoInsertion] axial gap', axialGap.toFixed(2),
    'm — entering ROTATE_BANG_BANG');
}
      break;
    }

    // =========================================================
// SEPARATED_LATERAL — booster fires LEFT pods' lat nozzles
// (force toward body +X in booster's own frame). Terminates
// when |perpendicular offset from stage's nose axis| reaches
// LATERAL_SEP_TARGET_M.
// =========================================================
// SEPARATED_LATERAL removed — lateral nudge was dropped in favour of
// going straight to STAGE_COAST once axial gap clears. The lateral
// RCS force was too weak to meaningfully change the separation anyway.

case 'SEPARATED_LATERAL': {
  const bIdx = _leoState.boosterIdx;
  const sIdx = _leoState.stageIdx;
  if (bIdx < 0 || sIdx < 0) { _leoState.phase = 'STAGE'; break; }
  const boosterBody = snapshot.bodies[bIdx];
  const stageBody = snapshot.bodies[sIdx];
  if (!boosterBody || !stageBody) { _leoState.phase = 'STAGE'; break; }
  
  // Fire booster's LEFT pods — lateral nozzles, full duty.
  const duties = GuideRCS.postSeparationLateralDuty(snapshot, bIdx, 'L');
  if (duties) send(cmdRcsDuty(duties, bIdx));
  
  // Perpendicular gap from stage's nose axis.
  const upX = -Math.sin(stageBody.theta);
  const upY = Math.cos(stageBody.theta);
  const perpX = -upY;
  const perpY = upX;
  const dx = stageBody.rx - boosterBody.rx;
  const dy = stageBody.ry - boosterBody.ry;
  const latSigned = dx * perpX + dy * perpY;
  const lateralGap = Math.abs(latSigned);
  _leoState.lastLateralGap = lateralGap;
  
  if (lateralGap >= LEO_INSERTION.LATERAL_SEP_TARGET_M) {
    // Cut booster RCS — relinquish duty control on that body.
    send(cmdRcsDuty(null, bIdx));
    _leoState.phase = 'STAGE_COAST';
    _leoState.phaseStart = simT;
    console.log('[leoInsertion] lateral gap', lateralGap.toFixed(2),
      'm — separation complete, entering STAGE_COAST');
  }
  break;
}

// =========================================================
// ROTATE_BANG_BANG — slew the stage to the steep climb angle
// using saturating RCS torque. Engine stays OFF for the whole
// rotation; there is no drag-cancel gimbal here.
//
// Time-optimal bang-bang:
//   Phase 1 (before midpoint): fire +max torque → accelerate
//   Phase 2 (after  midpoint): fire −max torque → decelerate
//   mid = (startTilt + targetTilt) / 2
// Exit when tilt error and |ω| are both inside tolerance, or on
// timeout. Apogee is checked every tick — if it already reached
// target (unlikely right after MECO but possible on a lighter
// stack), skip straight to DONE.
// =========================================================
case 'ROTATE_BANG_BANG': {
  // Engine OFF — no thrust to interfere with the RCS-only slew.
  send(cmdSetAllThrottle(0));
  // Cancel any gimbal command left over from ascent.
  send(cmdSetGimbalRate(0));

  const elapsed = simT - _leoState.phaseStart;

  // ---- Apogee check every tick ----
  const r_ap = Math.hypot(body.rx, body.ry);
  const ux_ap = body.rx / r_ap, uy_ap = body.ry / r_ap;
  const ex_ap = body.ry / r_ap, ey_ap = -body.rx / r_ap;
  const vr_ap = body.vx * ux_ap + body.vy * uy_ap;
  const vt_ap = body.vx * ex_ap + body.vy * ey_ap;
  const GM_ap = env.GM_EARTH;
  const R_ap = env.EARTH_RADIUS;
  const E_ap = 0.5 * (vr_ap * vr_ap + vt_ap * vt_ap) - GM_ap / r_ap;
  let apogeeKm = Infinity;
  if (E_ap < 0) {
    const a_ap = -GM_ap / (2 * E_ap);
    const h_ap = r_ap * vt_ap;
    const e_ap = Math.sqrt(Math.max(0, 1 + 2 * E_ap * h_ap * h_ap / (GM_ap * GM_ap)));
    apogeeKm = (a_ap * (1 + e_ap) - R_ap) / 1000;
  }
  _leoState.lastApogeeKm = apogeeKm;
  if (apogeeKm >= LEO_INSERTION.TARGET_ORBIT_ALT_KM) {
    send(cmdRcsDuty(null, idx));
    send(cmdSetAllThrottle(0));
    _leoState.phase = 'DONE';
    console.log('[leoInsertion] apogee already at target during rotate:',
      apogeeKm.toFixed(2), 'km — DONE');
    break;
  }

  // ---- Timeout safety ----
  if (elapsed >= LEO_INSERTION.ROTATE_TIMEOUT_S) {
    send(cmdRcsDuty(null, idx));
    _leoState.phase = 'TARGET_APOGEE';
    _leoState.phaseStart = simT;
    console.log('[leoInsertion] ROTATE timeout — proceeding to TARGET_APOGEE');
    break;
  }

  // ---- Tilt / midpoint ----
  const localVert = Math.atan2(-body.rx, body.ry);
  const currentTiltDeg = (body.theta - localVert) * 180 / Math.PI;
  const targetTiltDeg = -LEO_INSERTION.ANG_FOR_APOG_TILT_DEG;

  if (_leoState.angStartTiltDeg === null) {
    _leoState.angStartTiltDeg = currentTiltDeg;
    _leoState.bangMidpointDeg = (currentTiltDeg + targetTiltDeg) / 2;
  }
  const midDeg = _leoState.bangMidpointDeg;
  const startDeg = _leoState.angStartTiltDeg;

  const err = targetTiltDeg - currentTiltDeg;
  const omegaRel = body.omega + (env.EARTH_OMEGA || 0);

  // ---- Exit when close and slow ----
  if (Math.abs(err) < LEO_INSERTION.ROTATE_TOL_DEG &&
      Math.abs(omegaRel) < LEO_INSERTION.ROTATE_OMEGA_TOL) {
    send(cmdRcsDuty(null, idx));
    _leoState.phase = 'TARGET_APOGEE';
    _leoState.phaseStart = simT;
    console.log('[leoInsertion] ROTATE complete — tilt',
      currentTiltDeg.toFixed(2), '° — entering TARGET_APOGEE');
    break;
  }

  // ---- Bang-bang torque sign ----
  // Direction of desired motion in θ_rel: sign(target − start).
  const dirSign = Math.sign(targetTiltDeg - startDeg) || 1;
  // Crossed midpoint? (start-mid) * (current-mid) ≤ 0 means we're on
  // the far side of mid now.
  const crossed = (startDeg - midDeg) * (currentTiltDeg - midDeg) <= 0;
  const phaseSign = crossed ? -1 : 1;
  const tauCmd = phaseSign * dirSign * 1e9;

  const result = GuideRCS.targetTorqueRcs(snapshot, tauCmd, idx);
  if (result && result.fires.length) {
    send(cmdRcsDuty(result.duties, idx));
  } else {
    send(cmdRcsDuty(null, idx));
  }
  break;
}

  // =========================================================
  // TARGET_APOGEE — full burn until apogee reaches target orbit.
  //   Attitude: gimbal (inertial ω damper + drag cancel).
  //   Throttle: max until target − apogee ≤ TARGET_APOGEE_MARGIN_KM,
  //             then min for a soft approach, then cutoff + DONE.
  // =========================================================
  case 'TARGET_APOGEE': {
    if (!dNext || !dNext.massProps) break;
    const I_next = dNext.massProps.I;

    const tau_damp = -LEO_INSERTION.STAGE_OMEGA_DAMP * I_next * body.omega;
    const tau_drag_cancel = -dNext.torqueDrag;
    const tau_desired = tau_damp + tau_drag_cancel;

    const gimbals = (body.engines || []).filter(e => e.gimbal);
    if (!gimbals.length) { _leoState.phase = 'DONE'; break; }
    const g_N = gimbals[0].gimbalDeg || 0;
    const comX = dNext.massProps.comX;
    const comY = dNext.massProps.comY;
    let A_g = 0, B_g = 0;
    gimbals.forEach(e => {
      const F = (e.massFlowRate || 0) * (e.Ve || 0);
      A_g += ((e.x || 0) - comX) * F;
      B_g += F;
    });
    B_g *= comY;
    const R_amp = Math.hypot(A_g, B_g);
    let g_req_rad = 0;
    if (R_amp > 1) {
      const ratio = Math.max(-1, Math.min(1, tau_desired / R_amp));
      const phi = Math.atan2(A_g, B_g);
      const w1 = _hWrapPi(Math.asin(ratio) - phi);
      const w2 = _hWrapPi(Math.PI - Math.asin(ratio) - phi);
      g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
    }
    let g_req_deg = g_req_rad * 180 / Math.PI;
    const MAX_ANG = (env && Number.isFinite(env.GIMBAL_MAX_DEG)) ? env.GIMBAL_MAX_DEG : 20;
    if (Math.abs(g_req_deg) > MAX_ANG) g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
    const R_req = (g_req_deg - g_N) / dt;
    const MAX_RATE = (env && Number.isFinite(env.GIMBAL_RATE_DEG_S)) ? env.GIMBAL_RATE_DEG_S : 40;
    const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));
    send(cmdSetGimbalRate(R_cmd));

    // Osculating apogee from current inertial state.
    const r = Math.hypot(body.rx, body.ry);
    const ux = body.rx / r, uy = body.ry / r;
    const ex = body.ry / r, ey = -body.rx / r;
    const vr = body.vx * ux + body.vy * uy;
    const vtInertial = body.vx * ex + body.vy * ey;
    const GM = env.GM_EARTH;
    const R_earth = env.EARTH_RADIUS;
    const E = 0.5 * (vr * vr + vtInertial * vtInertial) - GM / r;
    let apogeeKm = Infinity;
    if (E < 0) {
      const a = -GM / (2 * E);
      const h = r * vtInertial;
      const eSq = 1 + 2 * E * h * h / (GM * GM);
      const e = Math.sqrt(Math.max(0, eSq));
      const ra = a * (1 + e);
      apogeeKm = (ra - R_earth) / 1000;
    }
  // Effective guidance tick interval (sim-seconds between snapshots
// THAT THIS PHASE ACTUALLY SAW). NOT CONFIG.DT — under load the
// guidance worker can lag and see snapshots 100-200 ms apart while
// physics still ticks at 12.5 ms. Using CONFIG.DT here made the
// apogee-rate 8-16× too high and the prediction far too short —
// cutoff fired on a tick where apogee was already 208 km.
const simDt = (_leoState.lastApogeeSimT > 0 && simT > _leoState.lastApogeeSimT) ?
  (simT - _leoState.lastApogeeSimT) :
  dt;
const apogeeRate = (_leoState.lastApogeeKm > 0 && simDt > 0) ?
  (apogeeKm - _leoState.lastApogeeKm) / simDt :
  0;
// Extrapolate one real guidance tick forward — if the NEXT tick's
// apogee would already exceed target, cut NOW. simDt carries the
// real lag, so a slow device gets a proportionally wider prediction.
const predictedApogeeKm = apogeeKm + Math.max(0, apogeeRate) * simDt;
_leoState.lastApogeeKm = apogeeKm;
_leoState.lastApogeeSimT = simT;

const targetKm = LEO_INSERTION.TARGET_ORBIT_ALT_KM;
const margin = LEO_INSERTION.TARGET_APOGEE_MARGIN_KM;
const gap = targetKm - apogeeKm;

if (gap <= 0 || predictedApogeeKm >= targetKm) {
  send(cmdSetAllThrottle(0));
  
  // ---- One-shot mission plan for the coast + circularization ----
  // Engine is now off — apogee is fixed (two-body). Compute
  // everything here so the coast phases don't re-derive.
  const r_c = Math.hypot(body.rx, body.ry);
  const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
  const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
  const vr_c = body.vx * ux_c + body.vy * uy_c;
  const vt_c = body.vx * ex_c + body.vy * ey_c;
  const GM_c = env.GM_EARTH;
  const R_c = env.EARTH_RADIUS;
  const E_c = 0.5 * (vr_c * vr_c + vt_c * vt_c) - GM_c / r_c;
  let r_apo = r_c;
  if (E_c < 0) {
    const a_c = -GM_c / (2 * E_c);
    const h_c = r_c * vt_c;
    const e_c = Math.sqrt(Math.max(0, 1 + 2 * E_c * h_c * h_c / (GM_c * GM_c)));
    r_apo = a_c * (1 + e_c);
  }
  const h_now = r_c * vt_c;
  const v_apo = (r_apo > 0) ? Math.abs(h_now) / r_apo : 0;
  const v_orb = Math.sqrt(GM_c / r_apo);
  const dv_needed = Math.max(0, v_orb - v_apo);
  
  const m_now = (dNext && dNext.massProps) ? dNext.massProps.M : d.massProps.M;
  const ve_engine = (body.engines && body.engines[0] && body.engines[0].Ve) || 3412;
  const m_final = m_now / Math.exp(dv_needed / ve_engine);
  const fuel_needed = Math.max(0, m_now - m_final);
  let refMax_c = 0;
  (body.engines || []).forEach(e => {
    if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax_c) refMax_c = e.maxMassFlowRate;
  });
  const t_burn = refMax_c > 0 ? fuel_needed / refMax_c : 0;
  
  // ---- Numerical time-to-apogee via Kepler (exact two-body) ----
  const t_coast = _hTimeToApogee(r_c, vr_c, vt_c, GM_c);
  
  _leoState.coastCutoffSimT = simT;
  _leoState.coastApogeeKm = (r_apo - R_c) / 1000;
  _leoState.coastVApogee = v_apo;
  _leoState.coastVOrbital = v_orb;
  _leoState.coastDeltaV = dv_needed;
  _leoState.coastFuelNeeded = fuel_needed;
  _leoState.coastTBurn = t_burn;
  _leoState.coastTCoast = t_coast;
  _leoState.phase = 'COAST_ROTATE';
  _leoState.phaseStart = simT;
  _leoState.coastRotateStartTilt = null;
  _leoState.coastRotateMid = null;
  
  console.log('[leoInsertion] TARGET APOGEE cutoff at', apogeeKm.toFixed(2),
    'km | plan: V_apo=' + v_apo.toFixed(1) + ' V_orb=' + v_orb.toFixed(1) +
    ' Δv=' + dv_needed.toFixed(1) + ' m/s | T_burn=' + t_burn.toFixed(2) +
    's | T_coast=' + t_coast.toFixed(1) + 's → COAST_ROTATE');
} else {
    // Linear throttle decay across the final margin:
    //   gap = margin  → 100%
    //   gap = 0       → 40% (floor)
    // Anything below 40% would be floored by physics to each
    // engine's own min-throttle (0.4 for Merlin Vac), so 40% is the
    // effective bottom of the usable range — no point commanding
    // lower. Below the margin, cutoff fires on the next tick once
    // gap ≤ 0.
    const frac = Math.max(0.4, Math.min(1.0, 0.4 + 0.6 * (gap / margin)));
    
    let refMax = 0;
    (body.engines || []).forEach(e => {
      if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate;
    });
    send(cmdSetAllThrottle(refMax * frac));
  }
  break;
  }

    // =========================================================
  // COAST_ROTATE — engine OFF. Bang-bang RCS slew to horizontal
  // (target = local vertical − 90°, east prograde).
  // =========================================================
  case 'COAST_ROTATE': {
    send(cmdSetAllThrottle(0));
    send(cmdSetGimbalRate(0));
    
    const elapsed = simT - _leoState.phaseStart;
    if (elapsed >= LEO_INSERTION.COAST_ROTATE_TIMEOUT_S) {
      send(cmdRcsDuty(null, idx));
      _leoState.phase = 'COAST_HOLD';
      _leoState.phaseStart = simT;
      console.log('[leoInsertion] COAST_ROTATE timeout — COAST_HOLD');
      break;
    }
    
    const localVert = Math.atan2(-body.rx, body.ry);
    const currentTiltDeg = (body.theta - localVert) * 180 / Math.PI;
    const targetTiltDeg = LEO_INSERTION.COAST_TARGET_TILT_DEG;
    
    if (_leoState.coastRotateStartTilt === null) {
      _leoState.coastRotateStartTilt = currentTiltDeg;
      _leoState.coastRotateMid = (currentTiltDeg + targetTiltDeg) / 2;
    }
    const startDeg = _leoState.coastRotateStartTilt;
    const midDeg = _leoState.coastRotateMid;
    
    const err = targetTiltDeg - currentTiltDeg;
    const omegaRel = body.omega + (env.EARTH_OMEGA || 0);
    if (Math.abs(err) < LEO_INSERTION.COAST_ROTATE_TOL_DEG &&
        Math.abs(omegaRel) < LEO_INSERTION.COAST_ROTATE_OMEGA_TOL) {
      send(cmdRcsDuty(null, idx));
      _leoState.phase = 'COAST_HOLD';
      _leoState.phaseStart = simT;
      console.log('[leoInsertion] COAST_ROTATE done at tilt', currentTiltDeg.toFixed(2),
        '° — COAST_HOLD');
      break;
    }
    
    const dirSign = Math.sign(targetTiltDeg - startDeg) || 1;
    const crossed = (startDeg - midDeg) * (currentTiltDeg - midDeg) <= 0;
    const phaseSign = crossed ? -1 : 1;
    const tauCmd = phaseSign * dirSign * 1e9;
    
    const result = GuideRCS.targetTorqueRcs(snapshot, tauCmd, idx);
    if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
    else send(cmdRcsDuty(null, idx));
    break;
  }

  // =========================================================
  // COAST_HOLD — engine OFF, coast toward apogee. RCS holds the
  // body at horizontal using the COASTnAoADAMP formula, but routed
  // through targetTorqueRcsNoNetForce so the hold produces ZERO net
  // linear acceleration (no trajectory drift over 100+ seconds).
  // Burn trigger fires when time remaining to apogee ≤ triggerFrac×T_burn.
  // =========================================================
  case 'COAST_HOLD': {
    send(cmdSetAllThrottle(0));
    send(cmdSetGimbalRate(0));
    
    // Check burn trigger.
    const r_c = Math.hypot(body.rx, body.ry);
    const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
    const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
    const vr_c = body.vx * ux_c + body.vy * uy_c;
    const vt_c = body.vx * ex_c + body.vy * ey_c;
    const t_rem = _hTimeToApogee(r_c, vr_c, vt_c, env.GM_EARTH);

// Apogee-peak detection. _hTimeToApogee returns time to the NEXT
// apogee; right AT apogee that mathematically jumps back to a full
// period (M == π boundary case). So t_rem alone can't detect
// "we're at apogee". Detect it by vr crossing from positive to
// negative — that's the moment the radial velocity flips, which
// only happens at apogee.
const prevVr = _leoStateV2._prevVr;
_leoStateV2._prevVr = vr_c;
const apogeePeak = (prevVr !== null && prevVr !== undefined &&
  prevVr > 0 && vr_c <= 0);

// Trigger: apogee reached (fire now) OR t_rem window (fire early
// so the burn ENDS near apogee). Apogee-peak detection catches
// the case where we arrive at apogee before the t_rem window
// opens — mathematically the trigger for that path is the vr
// sign flip, since t_rem is unusable at the peak.
if (apogeePeak || t_rem <= _leoStateV2.coastTBurnPractical) {
  send(cmdRcsDuty(null, idx));
  _leoStateV2.phase = 'CIRCULARIZE';
  _leoStateV2.phaseStart = simT;
  console.log('[leoInsertionV2] burn trigger — ' +
    (apogeePeak ? 'apogee peak detected' : 't_rem=' + t_rem.toFixed(2) +
      's ≤ T_burn_practical=' + _leoStateV2.coastTBurnPractical.toFixed(2) + 's') +
    ' — CIRCULARIZE');
  break;
}
    
    // Attitude hold — same formula as ascent COASTnAoADAMP.
    if (dNext && dNext.massProps) {
      const I_next = dNext.massProps.I;
      const gain = (LEO_INSERTION.ASCENT && Number.isFinite(LEO_INSERTION.ASCENT.COAST_DAMP_GAIN))
        ? LEO_INSERTION.ASCENT.COAST_DAMP_GAIN : 16;
      const kd = (LEO_INSERTION.ASCENT && Number.isFinite(LEO_INSERTION.ASCENT.COAST_DAMP_K))
        ? LEO_INSERTION.ASCENT.COAST_DAMP_K : 4.0;
      const tau_desired = (-I_next * gain * dNext.alphaDeg) / (kd * kd);
      
      const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
      if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
      else send(cmdRcsDuty(null, idx));
    }
    break;
  }

  // =========================================================
  // CIRCULARIZE — engine on, prograde burn along local horizontal.
  // Attitude held at horizontal via gimbal. Throttle decays near
  // cutoff to avoid overshoot. Cutoff when |v − V_orbital| < tol.
  // =========================================================
  case 'CIRCULARIZE': {
    if (!dNext || !dNext.massProps) break;
    const gimbals = (body.engines || []).filter(e => e.gimbal);
    
    // ---- Current velocity vs orbital ----
    const r_c = Math.hypot(body.rx, body.ry);
const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
// Radial and inertial-tangential velocity components. Needed for
// the osculating perigee computation below — the crossing condition
// reads these, and without them vr_c/vt_c were undefined → NaN in
// the perigee calc → crossing never fired, engine burned past
// every target altitude.
const vr_c = body.vx * ux_c + body.vy * uy_c;
const vt_c = body.vx * ex_c + body.vy * ey_c;
const speed = Math.hypot(body.vx, body.vy);
const v_orb_target = _leoStateV2.coastVOrbital;
const v_err = v_orb_target - speed;

// Live readout — updated every tick while circularizing.
_leoState.circCurrentV = speed;
_leoState.circTargetV = v_orb_target;
_leoState.circErr = v_err;

if (v_err <= 0) {
  _leoState.circAchieved = true;
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  _leoState.phase = 'DONE';
  console.log('[leoInsertion] CIRCULARIZE complete — v=' + speed.toFixed(1) +
    ' m/s (target ' + v_orb_target.toFixed(1) + ') — DONE');
  break;
}
    
    // ---- Throttle: full until decay window, then ramp to 40% ----
    const decayWindow = LEO_INSERTION.CIRC_DECAY_FRAC * v_orb_target;
    let thrFrac = 1.0;
    if (v_err <= decayWindow && decayWindow > 0) {
      thrFrac = Math.max(0.4, 0.4 + 0.6 * (v_err / decayWindow));
    }
    let refMax = 0;
    (body.engines || []).forEach(e => {
      if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate;
    });
    send(cmdSetAllThrottle(refMax * thrFrac));
    
    // ---- Attitude hold at horizontal via gimbal ----
    if (gimbals.length) {
      const I_next = dNext.massProps.I;
      const localVert = Math.atan2(-body.rx, body.ry);
      const targetAbsTilt = localVert + LEO_INSERTION.COAST_TARGET_TILT_DEG * Math.PI / 180;
      let thetaErr = body.theta - targetAbsTilt;
      thetaErr = _hWrapPi(thetaErr);
      const omegaRel = body.omega + (env.EARTH_OMEGA || 0);
      const tau_desired = -I_next * (LEO_INSERTION.CIRC_ATT_KP * thetaErr
                                   + LEO_INSERTION.CIRC_ATT_KD * omegaRel);
      
      const g_N = gimbals[0].gimbalDeg || 0;
      const comX1 = dNext.massProps.comX;
      const comY1 = dNext.massProps.comY;
      let A_g = 0, B_g = 0;
      gimbals.forEach(e => {
        const F = (e.massFlowRate || 0) * (e.Ve || 0);
        A_g += ((e.x || 0) - comX1) * F;
        B_g += F;
      });
      B_g *= comY1;
      const R_amp = Math.hypot(A_g, B_g);
      let g_req_rad = 0;
      if (R_amp > 1) {
        const ratio = Math.max(-1, Math.min(1, tau_desired / R_amp));
        const phi = Math.atan2(A_g, B_g);
        const w1 = _hWrapPi(Math.asin(ratio) - phi);
        const w2 = _hWrapPi(Math.PI - Math.asin(ratio) - phi);
        g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
      }
      let g_req_deg = g_req_rad * 180 / Math.PI;
      const MAX_ANG = (env && Number.isFinite(env.GIMBAL_MAX_DEG)) ? env.GIMBAL_MAX_DEG : 20;
      if (Math.abs(g_req_deg) > MAX_ANG) g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
      const R_req = (g_req_deg - g_N) / dt;
      const MAX_RATE = (env && Number.isFinite(env.GIMBAL_RATE_DEG_S)) ? env.GIMBAL_RATE_DEG_S : 40;
      const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));
      send(cmdSetGimbalRate(R_cmd));
    }
    break;
  }

  case 'DONE':
  default:
    break;
}
    
    // ---- Fairing open (independent, runs every tick) ----
    // Once the split has happened (bodies >= 2) AND altitude crosses
    // FAIRING_OPEN_ALT_KM, send cmdSplitFairing() once. Physics's fairing
    // split is idempotent — the check is defensive, not required.
    if (LEO_INSERTION.FAIRING_OPEN_ENABLED &&
      !_leoState.fairingOpened &&
      _leoState.splitDetected &&
      _leoState.lastAltKm >= LEO_INSERTION.FAIRING_OPEN_ALT_KM) {
      // Only send if a payloadSpace member is still attached to the
      // ACTIVE body (fairing might have been ejected/opened earlier).
      const stageBody = snapshot.bodies[_leoState.stageIdx];
      const hasFairing = !!(stageBody && stageBody.members &&
        stageBody.members.some(m => m && m.stageRole === 'payloadSpace'));
      if (hasFairing) {
        send(cmdSplitFairing());
        _leoState.fairingOpened = true;
        console.log('[leoInsertion] fairing open at',
          _leoState.lastAltKm.toFixed(2), 'km — cmdSplitFairing sent');
      }
    }
    }

_leoTick.start = function() {
    _leoState.init = false;
    _leoState.ticks = 0;
    _leoState.phase = 'ASCENT';
    _leoState.phaseStart = 0;
    _leoState.mecoTriggered = false;
    _leoState.splitDetected = false;
    _leoState.fairingOpened = false;
  _leoState.initialBodyCount = 0;
  _leoState.preSplitBodyId = null;
  _leoState.boosterIdx = -1;
  _leoState.stageIdx = -1;
    _leoState.lastAltKm = 0;
  _leoState.lastAxialGap = 0;
  _leoState.lastLateralGap = 0;
        _leoState.angStartTiltDeg = null;
  _leoState.bangMidpointDeg = null;
  _leoState.lastApogeeKm = 0;
  _leoState.lastApogeeSimT = 0;
  _leoState.coastCutoffSimT = 0;
  _leoState.coastApogeeKm = 0;
  _leoState.coastVApogee = 0;
  _leoState.coastVOrbital = 0;
  _leoState.coastDeltaV = 0;
  _leoState.coastFuelNeeded = 0;
  _leoState.coastTBurn = 0;
  _leoState.coastTCoast = 0;
    _leoState.coastRotateStartTilt = null;
  _leoState.coastRotateMid = null;
  _leoState.circCurrentV = 0;
  _leoState.circTargetV = 0;
  _leoState.circErr = 0;
  _leoState.circAchieved = false;
  console.log('[leoInsertion] started');
  };
_leoTick.stop = function() {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  send(cmdRcsDuty(null));
  if (typeof _hTick !== 'undefined' && typeof _hTick.stop === 'function') {
    try { _hTick.stop(); } catch (e) {}
  }
  console.log('[leoInsertion] stopped');
};
_leoTick.getStatus = function() {
  return {
    ticks: _leoState.ticks,
    phase: _leoState.phase,
    altKm: _leoState.lastAltKm,
    mecoTriggered: _leoState.mecoTriggered,
    splitDetected: _leoState.splitDetected,
    fairingOpened: _leoState.fairingOpened,
    axialGap: _leoState.lastAxialGap,
    lateralGap: _leoState.lastLateralGap,
            apogeeKm: _leoState.lastApogeeKm,
      angStartTiltDeg: _leoState.angStartTiltDeg,
      bangMidpointDeg: _leoState.bangMidpointDeg,
        coastTBurn: _leoState.coastTBurn,
    coastTCoast: _leoState.coastTCoast,
    coastDeltaV: _leoState.coastDeltaV,
    coastVOrbital: _leoState.coastVOrbital,
    circCurrentV: _leoState.circCurrentV,
    circTargetV: _leoState.circTargetV,
    circErr: _leoState.circErr,
    circAchieved: _leoState.circAchieved,
  };
  };

GUIDES.leoInsertion = _leoTick;

function setLeoInsertion(patch) {
  if (!patch) return;
  Object.keys(patch).forEach(k => {
    if (!(k in LEO_INSERTION)) return;
    const cur = LEO_INSERTION[k];
    const nxt = patch[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) &&
      nxt && typeof nxt === 'object' && !Array.isArray(nxt)) {
      // Deep merge one level — protects nested objects like STAGE from
      // being wholesale replaced by a patch that only carries a couple
      // of its keys.
      Object.assign(cur, nxt);
    } else {
      LEO_INSERTION[k] = nxt;
    }
  });
  console.log('[leoInsertion] constants updated');
}
function getLeoInsertionConfig() { return { ...LEO_INSERTION }; }





// ============================================================
// leoInsertionV2 — full mission, correct orbital-insertion shape.
//
// Same as v1 up to MECO. Diverges after separation:
//
//   v1: rotate to steep climb, burn hard to apogee, coast to apogee,
//       then try to circularize in the last 25% of T_burn. FAILED at
//       orbit because the climb profile was wrong and the horizontal
//       burn was fighting gravity for 4–5× the ideal burn time.
//
//   v2: after separation, re-ignite the stage and continue with the
//       SAME COASTnAoADAMP formula used in ascent. Full throttle,
//       gimbal holding AoA = 0 (nose follows velocity vector — a
//       natural gravity turn). Burn continues until the OSCULATING
//       APOGEE reaches the target orbit altitude, then cuts.
//       At that moment the vehicle is NOT at apogee — it's on an
//       orbit whose apogee equals the target. The remaining coast
//       naturally arrives at apogee, and the circularization burn
//       starts well before to absorb gravity losses.
//
// Circularization timing:
//   T_burn_ideal = fuel_needed / mdot  (Tsiolkovsky)
//   T_burn_practical = 4 × T_burn_ideal  (rule-of-thumb for gravity loss)
//   Burn starts when time-to-apogee ≤ T_burn_practical.
//   This guarantees the burn's peak lands near apogee instead of
//   undershooting by the whole gravity-loss deficit.
// ============================================================

const LEO_INSERTION_V2 = {
  // ---- Ascent constants (independent copy — same shape as v1) ----
  ASCENT: {
    INITIAL_COAST_S: 4.9,
    PUSH_T_S: 4.8,
    PUSH_MAX_GIMBAL_DEG: 1.45,
    PUSH_EAST_SIGN: -1,
    HOLD_K_DAMP: 4.0,
    HOLD_MAX_AOA_DEG: 8,
    HOLD_K_DQ: 0.005,
    HOLD_Q_REF: 1000,
    THROTTLE_FRAC: 1.0,
    THROTTLE_ALT_LOW_KM: 8,
    THROTTLE_ALT_HIGH_KM: 13,
    THROTTLE_FRAC_LOW: 0.7,
    COAST_DAMP_GAIN: 16,
    COAST_DAMP_K: 4.0,
  },

  // ---- Hand-off from ascent (same as v1) ----
  MECO_APOGEE_KM: 150,

  // ---- Separation ----
  AXIAL_SEP_TARGET_M: 10,
  LATERAL_SEP_TARGET_M: 5,
  SPLIT_TIMEOUT_S: 10,

  // ---- Fairing ----
  FAIRING_OPEN_ALT_KM: 80,
  FAIRING_OPEN_ENABLED: true,

  // ---- Target orbit ----
  TARGET_ORBIT_ALT_KM: 320,

  // ---- RCS settle ----
  RCS_OMEGA_TARGET: 0,
  RCS_SETTLE_TOL: 1e-4,

// ---- STAGE_BURN — full throttle with ascent AoA-damp ----
// Burn continues until osculating apogee ≥ TARGET_ORBIT_ALT_KM.
// Predictive cutoff to absorb the spool-down overshoot.
STAGE_BURN_LOOKAHEAD_TICKS: 3,
  
  // Cutoff margin: cut the engine this much EARLY (in Δv terms),
  // deliberately leaving a gap for RCS_BOOST to trim. Decouples cutoff
  // timing from tick-granularity — the main engine does the coarse
  // burn, RCS does the fine trim. 3 m/s ≈ 10-15 km of apogee, which
  // RCS covers in ~80 seconds at 1080 N on a ~28 t stage.
  STAGE_BURN_CUTOFF_MARGIN_MPS: 3.0,
  
  // Attitude lock: once |θ_rel| (tilt from local vertical) first reaches
  // this many degrees during STAGE_BURN, switch from AoA-damp to a PD
  // hold at that tilt. Below the threshold the gimbal holds velocity-
  // aligned (AoA = 0); above, it holds the body at a fixed angle
  // relative to local vertical so thrust stays at ~85° to radial,
  // adding tangential velocity to raise perigee. Sign is captured at
  // crossing, so it doesn't flip mid-burn.
  STAGE_BURN_LOCK_TILT_DEG: 85,

  // ---- Coast + circularization ----
  COAST_TARGET_TILT_DEG: -90,
  COAST_ROTATE_TOL_DEG: 0.5,
  COAST_ROTATE_OMEGA_TOL: 0.02,
  COAST_ROTATE_TIMEOUT_S: 240,
  
  // Rate-damping term for COAST_HOLD_2's attitude hold. The base
  // COASTnAoADAMP formula is proportional-only (effective per-radian
  // gain ≈ 57 via the deg→rad conversion, ζ ≈ 0.05 from the one-tick
  // α-lookahead alone) — an essentially undamped oscillator. Adding
  // -I·K·ω_body with K=10 brings ζ to ~0.7, which stops the visible
  // oscillation without changing the equilibrium.
  COAST2_DAMP_RATE: 10,
  
  // Burn trigger lead: fire when time-remaining-to-apogee ≤
  // startupDurationS + this. The startup duration is the hard floor
  // (thrust can't be full until then); the extra lead gives the
  // attitude controller room to settle before the burn really ramps.
  CIRC_TRIGGER_LEAD_S: 3.0,

  CIRC_VEL_TOL_MPS: 5,
  
  // Payload ejection kick. `releasePayloadOnActiveBody` applies a
  // prograde impulse to the payload when it separates — 3 m/s for
  // normal release, 20 m/s for emergency. The stage only needs to
  // reach V_orbital − kick, because the payload's final velocity is
  // stage_v + kick. Cutting 3 m/s early also saves burn time.
  PAYLOAD_EJECT_KICK_MPS: 3.0,
  CIRC_DECAY_FRAC: 0.05,
  CIRC_ATT_KP: 0.5,
  CIRC_ATT_KD: 4.0,
  
  // Perigee-crossing cutoff. During a prograde burn near apogee, perigee
  // rises from deep-negative (orbit intersects Earth) up through 0. At
  // the moment it crosses 0, the orbit just became "bound but touching
  // the atmosphere". Waiting for v ≥ V_orbital instead pushes apogee
  // hundreds of km past target — apogee changes so fast at this point
  // that one guidance tick can overshoot by 100+ km. Cutting on the
  // perigee crossing stops the burn earlier, keeping apogee close to
  // target. RCS then holds attitude through the coast.
  // Cutoff fires when osculating perigee crosses this value. NEGATIVE
// by default: during the 2 s shutdown spool, thrust continues and
// perigee keeps rising — firing at perigee = 0 would overshoot (the
// burn reaches apogee 450 km instead of 320). Firing at −50 km means
// by the time engines actually stop, perigee has risen through 0 to
// a small positive value. Tune: more negative = cut earlier = less
// apogee overshoot.
CIRC_PERIGEE_CUTOFF_KM: -50,
  // Multiplier on ideal T_burn to set the coast burn trigger window.
  // 4× matches the observed gravity-loss deficit (gravity eats ~3/4 of
  // the useful burn budget on a horizontal burn at LEO altitude).
  COAST_BURN_MULTIPLIER: 4.0,
  
  // ---- Payload deploy ----
  // Nose-alignment tolerance for the deploy slew. Aligned when
  // |θ_err| < this (converted to rad in the phase) AND |ω| < 0.02 rad/s;
  // release fires on alignment, or on the 60 s safety timeout.
  DEPLOY_ALIGN_TOL_DEG: 3.0,

// ---- Placeholder (unused in v2, kept for shape symmetry) ----
  STAGE: { BURN_ALT_KM: 80, TARGET_VEL_MPS: 7800, CUTOFF_TOL_V: 5 },
  ANG_FOR_APOG_TILT_DEG: 10,
  ROTATE_TOL_DEG: 0.5,
  ROTATE_OMEGA_TOL: 0.02,
  ROTATE_TIMEOUT_S: 90,
  TARGET_APOGEE_MARGIN_KM: 10,
  STAGE_OMEGA_DAMP: 2.0,
};

const _leoStateV2 = {
  init: false,
  ticks: 0,
  phase: 'ASCENT',
  phaseStart: 0,
  mecoTriggered: false,
  splitDetected: false,
  fairingOpened: false,
  initialBodyCount: 0,
  missionBodyIdx: null, // locked to the body guidance is flying
  preSplitBodyId: null,
  boosterIdx: -1,
  stageIdx: -1,
  lastAltKm: 0,
  lastAxialGap: 0,
  lastLateralGap: 0,
  lastApogeeKm: 0,
  lastApogeeSimT: 0,
  coastCutoffSimT: 0,
  coastApogeeKm: 0,
  coastVApogee: 0,
  coastVOrbital: 0,
  coastDeltaV: 0,
  coastFuelNeeded: 0,
  coastTBurnIdeal: 0,
  coastTBurnPractical: 0,
  coastTCoast: 0,
  coastRotateStartTilt: null,
  coastRotateMid: null,
  coastTargetThetaInertial: null, // fixed inertial θ that at apogee aligns nose with velocity
    circCurrentV: 0,
    circTargetV: 0,
    circErr: 0,
    circAchieved: false,
        lastPerigeeKm: null,
    stageBurnLocked: false,
    stageBurnTargetTiltDeg: 0,
    _prevApogeeKm: 0,
  _prevVr: null,
  _prevApogeeErr: null, // last tick's (apogee - target) for crossing detection
      deployTargetTheta: null,
      deployStartTheta: 0,
      deployBangMid: 0,
      // Post-circularization realign — burn started 3 s before the old
      // apogee and ran past it, so the pre-CIRCULARIZE target θ no longer
      // points at apogee. Recompute from the NEW osculating orbit.
      coast2TargetThetaInertial: null,
      coast2RotateStartTilt: null,
      coast2RotateMid: null,
      _prevVr2: null,
    
  
};

function _leoTickV2(snapshot) {
  _leoStateV2.ticks++;
  if (!snapshot || !Array.isArray(snapshot.bodies) || !snapshot.bodies.length) return;
  
  // Use the locked mission body if one is set; otherwise fall back to
  // the currently-active body on the first tick. The init block below
  // captures the mission body the first time we run.
  let idx = (Number.isInteger(_leoStateV2.missionBodyIdx)) ?
    _leoStateV2.missionBodyIdx :
    ((Number.isInteger(snapshot.activeBodyIndex)) ? snapshot.activeBodyIndex : 0);
  const body = snapshot.bodies[idx];
  if (!body) return;
  const simT = snapshot.simTime;

  // ---------- Init ----------
  if (!_leoStateV2.init) {
  _leoStateV2.init = true;
  _leoStateV2.phase = 'ASCENT';
  _leoStateV2.phaseStart = simT;
  _leoStateV2.mecoTriggered = false;
  _leoStateV2.splitDetected = false;
  _leoStateV2.fairingOpened = false;
  _leoStateV2.initialBodyCount = snapshot.bodies.length;
  _leoStateV2.preSplitBodyId = body.id || null;
  _leoStateV2.boosterIdx = -1;
  _leoStateV2.stageIdx = idx;
  
  // Lock the mission body and hand the index to Guidance.send().
  // From here on, activeBodyIndex changes (Take Control, etc.) don't
  // affect which body guidance commands.
  _leoStateV2.missionBodyIdx = idx;
  if (typeof Guidance !== 'undefined' && Guidance.setMissionBody) {
    Guidance.setMissionBody(idx);
  }
    if (typeof _hTick !== 'undefined' && typeof _hTick.start === 'function') {
  try { _hTick.start(); } catch (e) { console.error('[leoInsertionV2] _hTick.start failed', e); }
}

// ---- Boot-time contract validation ----
// Every env and engine field the guide reads must be present. If any
// is missing, that's a boot-pipeline bug — surface it loudly on the
// first tick instead of silently substituting a fallback that hides
// the problem for the rest of the mission.
(function validateContracts() {
  const env = Derivation.getEnv();
  const requiredEnv = ['DT','GM_EARTH','EARTH_RADIUS','EARTH_OMEGA',
                        'GIMBAL_MAX_DEG','GIMBAL_RATE_DEG_S'];
  const missingEnv = requiredEnv.filter(k => !Number.isFinite(env[k]));
  if (missingEnv.length) {
    console.error('[leoInsertionV2] CONTRACT VIOLATION — env missing:',
      missingEnv.join(', '), '— guide will misbehave');
  }
  const eng = body.engines && body.engines[0];
  if (!eng) {
    console.error('[leoInsertionV2] CONTRACT VIOLATION — no engine[0]');
    return;
  }
  const requiredEng = ['Ve','maxMassFlowRate','startupDurationS','shutdownDurationS'];
  const missingEng = requiredEng.filter(k => !Number.isFinite(eng[k]));
  if (missingEng.length) {
    console.error('[leoInsertionV2] CONTRACT VIOLATION — engine missing:',
      missingEng.join(', '), '— guide will misbehave');
  }
})();

console.log('[leoInsertionV2] started, phase ASCENT');
  }

  // ---------- Derive current state ----------
  const d = Derivation.derive(snapshot, idx);
  if (!d || !d.massProps) return;
  _leoStateV2.lastAltKm = d.altitudeAGL / 1000;

  const env = Derivation.getEnv();
const dt = env.DT;
const M_d = d.massProps.M;

  // ---------- Predict next-tick state ----------
  let dNext = null;
  if (M_d > 0) {
    const cosT = Math.cos(d.theta), sinT = Math.sin(d.theta);
    const thrustIx = d.thrustBodyX * cosT - d.thrustBodyY * sinT;
    const thrustIy = d.thrustBodyX * sinT + d.thrustBodyY * cosT;
    const aIx = d.gVecX + (thrustIx + d.dragVecX) / M_d;
    const aIy = d.gVecY + (thrustIy + d.dragVecY) / M_d;
    const rx_n = d.rx + d.vx * dt;
    const ry_n = d.ry + d.vy * dt;
    const vx_n = d.vx + aIx * dt;
    const vy_n = d.vy + aIy * dt;
    const omega_n = d.omega + d.alphaAng * dt;
    const theta_n = d.theta + d.omega * dt + 0.5 * d.alphaAng * dt * dt;
    const sloshNow = body.slosh || { offset: 0, velocity: 0 };
    const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
    const sloshV_n = sloshNow.velocity || 0;
    dNext = Derivation.deriveForState(snapshot, idx, {
      rx: rx_n, ry: ry_n, vx: vx_n, vy: vy_n,
      theta: theta_n, omega: omega_n,
      slosh: { offset: sloshX_n, velocity: sloshV_n },
    });
  }

  // ---------- Phase machine ----------
  switch (_leoStateV2.phase) {

    case 'ASCENT': {
      if (typeof _hTick === 'function') {
        _hTick(snapshot, LEO_INSERTION_V2.ASCENT);
      }
      if (!_leoStateV2.mecoTriggered) {
        const r_m = Math.hypot(body.rx, body.ry);
        const ux_m = body.rx / r_m, uy_m = body.ry / r_m;
        const ex_m = body.ry / r_m, ey_m = -body.rx / r_m;
        const vr_m = body.vx * ux_m + body.vy * uy_m;
        const vt_m = body.vx * ex_m + body.vy * ey_m;
        const GM_m = env.GM_EARTH;
        const R_m = env.EARTH_RADIUS;
        const E_m = 0.5 * (vr_m * vr_m + vt_m * vt_m) - GM_m / r_m;
        let apogeeKm = Infinity;
        if (E_m < 0) {
          const a_m = -GM_m / (2 * E_m);
          const h_m = r_m * vt_m;
          const e_m = Math.sqrt(Math.max(0, 1 + 2 * E_m * h_m * h_m / (GM_m * GM_m)));
          apogeeKm = (a_m * (1 + e_m) - R_m) / 1000;
        }
        _leoStateV2.lastApogeeKm = apogeeKm;
        if (apogeeKm >= LEO_INSERTION_V2.MECO_APOGEE_KM) {
          _leoStateV2.mecoTriggered = true;
          _leoStateV2.phase = 'MECO_SPOOL';
          _leoStateV2.phaseStart = simT;
          if (typeof cmdSeparate === 'function') send(cmdSeparate());
          console.log('[leoInsertionV2] MECO — apogee',
            apogeeKm.toFixed(2), 'km — separation commanded');
        }
      }
      break;
    }

    case 'MECO_SPOOL': {
      if (snapshot.bodies.length > _leoStateV2.initialBodyCount) {
        _leoStateV2.splitDetected = true;
        const stageIdx = _leoStateV2.preSplitBodyId != null
          ? snapshot.bodies.findIndex(b => b.id === _leoStateV2.preSplitBodyId)
          : idx;
        const boosterIdx = snapshot.bodies.findIndex((b, i) =>
          i !== stageIdx && b && !b.isActive);
        _leoStateV2.stageIdx = (stageIdx >= 0) ? stageIdx : idx;
        _leoStateV2.boosterIdx = (boosterIdx >= 0) ? boosterIdx : (1 - _leoStateV2.stageIdx);
        _leoStateV2.phase = 'SEPARATED_AXIAL';
        _leoStateV2.phaseStart = simT;
        console.log('[leoInsertionV2] split detected — booster idx', _leoStateV2.boosterIdx,
          'stage idx', _leoStateV2.stageIdx);
        break;
      }
      if (simT - _leoStateV2.phaseStart > LEO_INSERTION_V2.SPLIT_TIMEOUT_S) {
        console.warn('[leoInsertionV2] split timeout');
        _leoStateV2.phase = 'DONE';
      }
      break;
    }

    case 'SEPARATED_AXIAL': {
      const bIdx = _leoStateV2.boosterIdx;
      const sIdx = _leoStateV2.stageIdx;
      if (bIdx < 0 || sIdx < 0) { _leoStateV2.phase = 'DONE'; break; }
      const boosterBody = snapshot.bodies[bIdx];
      const stageBody = snapshot.bodies[sIdx];
      if (!boosterBody || !stageBody) { _leoStateV2.phase = 'DONE'; break; }

      const boosterDuties = GuideRCS.postSeparationAxialDuty(snapshot, bIdx, 'dn');
      if (boosterDuties) send(cmdRcsDuty(boosterDuties, bIdx));
      const stageDuties = GuideRCS.postSeparationAxialDuty(snapshot, sIdx, 'up');
      if (stageDuties) send(cmdRcsDuty(stageDuties, sIdx));

      const boosterHeight = (boosterBody.members && boosterBody.members[0])
        ? (boosterBody.members[0].height || 0) : 0;
      const upX = -Math.sin(stageBody.theta);
      const upY = Math.cos(stageBody.theta);
      const dx = stageBody.rx - boosterBody.rx;
      const dy = stageBody.ry - boosterBody.ry;
      const proj = dx * upX + dy * upY;
      const axialGap = Math.max(0, proj - boosterHeight);
      _leoStateV2.lastAxialGap = axialGap;

      if (axialGap >= LEO_INSERTION_V2.AXIAL_SEP_TARGET_M) {
        send(cmdRcsDuty(null, sIdx));
        send(cmdRcsDuty(null, bIdx));
        _leoStateV2.phase = 'STAGE_BURN';
        _leoStateV2.phaseStart = simT;
        _leoStateV2.lastApogeeSimT = 0;
        console.log('[leoInsertionV2] axial gap', axialGap.toFixed(2),
          'm — entering STAGE_BURN');
      }
      break;
    }

  case 'STAGE_BURN': {
    if (!dNext || !dNext.massProps) break;
    const gimbals = (body.engines || []).filter(e => e.gimbal);
    if (!gimbals.length) { _leoStateV2.phase = 'DONE'; break; }

    // Full throttle — no decay here; cutoff spool is handled by physics.
    send(cmdSetAllThrottle(Infinity));

    const I_next = dNext.massProps.I;
    const localVert = Math.atan2(-body.rx, body.ry);
    const currentTiltDeg = (body.theta - localVert) * 180 / Math.PI;

    // Tilt lock — once |θ_rel| first crosses 85°, lock the target
    // tilt for the rest of the burn.
    if (!_leoStateV2.stageBurnLocked &&
        Math.abs(currentTiltDeg) >= LEO_INSERTION_V2.STAGE_BURN_LOCK_TILT_DEG) {
      _leoStateV2.stageBurnLocked = true;
      _leoStateV2.stageBurnTargetTiltDeg = (currentTiltDeg >= 0) ?
        LEO_INSERTION_V2.STAGE_BURN_LOCK_TILT_DEG :
        -LEO_INSERTION_V2.STAGE_BURN_LOCK_TILT_DEG;
      console.log('[leoInsertionV2] STAGE_BURN attitude locked at tilt ' +
        _leoStateV2.stageBurnTargetTiltDeg.toFixed(1) + '° (θ_rel=' +
        currentTiltDeg.toFixed(2) + '°)');
    }

    // Attitude control: AoA-damp pre-lock, PD-hold at locked tilt after.
    let tau_desired;
    if (_leoStateV2.stageBurnLocked) {
      const targetAbsTheta = localVert +
        _leoStateV2.stageBurnTargetTiltDeg * Math.PI / 180;
      const thetaErr = _hWrapPi(body.theta - targetAbsTheta);
      const omegaRel = body.omega + (env.EARTH_OMEGA || 0);
      tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                             + LEO_INSERTION_V2.CIRC_ATT_KD * omegaRel);
    } else {
      const gain = LEO_INSERTION_V2.ASCENT.COAST_DAMP_GAIN;
      const kd = LEO_INSERTION_V2.ASCENT.COAST_DAMP_K;
      tau_desired = (-I_next * gain * dNext.alphaDeg) / (kd * kd);
    }
    const tau_target = tau_desired - dNext.torqueDrag;

    // Gimbal solve.
    const g_N = gimbals[0].gimbalDeg || 0;
    const comX1 = dNext.massProps.comX;
    const comY1 = dNext.massProps.comY;
    let A_g = 0, B_g = 0;
    gimbals.forEach(e => {
      const F = (e.massFlowRate || 0) * (e.Ve || 0);
      A_g += ((e.x || 0) - comX1) * F;
      B_g += F;
    });
    B_g *= comY1;
    const R_amp = Math.hypot(A_g, B_g);
    let g_req_rad = 0;
    if (R_amp > 1) {
      const ratio = Math.max(-1, Math.min(1, tau_target / R_amp));
      const phi = Math.atan2(A_g, B_g);
      const w1 = _hWrapPi(Math.asin(ratio) - phi);
      const w2 = _hWrapPi(Math.PI - Math.asin(ratio) - phi);
      g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
    }
    let g_req_deg = g_req_rad * 180 / Math.PI;
const MAX_ANG = env.GIMBAL_MAX_DEG;
if (Math.abs(g_req_deg) > MAX_ANG) g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
const R_req = (g_req_deg - g_N) / dt;
const MAX_RATE = env.GIMBAL_RATE_DEG_S;
const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));
send(cmdSetGimbalRate(R_cmd));

    // ---- Osculating apogee / perigee ----
    const r_ap = Math.hypot(body.rx, body.ry);
    const ux_ap = body.rx / r_ap, uy_ap = body.ry / r_ap;
    const ex_ap = body.ry / r_ap, ey_ap = -body.rx / r_ap;
    const vr_ap = body.vx * ux_ap + body.vy * uy_ap;
    const vt_ap = body.vx * ex_ap + body.vy * ey_ap;
    const GM_ap = env.GM_EARTH;
    const R_ap = env.EARTH_RADIUS;
    const E_ap = 0.5 * (vr_ap * vr_ap + vt_ap * vt_ap) - GM_ap / r_ap;
    let apogeeKm = Infinity;
    if (E_ap < 0) {
      const a_ap = -GM_ap / (2 * E_ap);
      const h_ap = r_ap * vt_ap;
      const e_ap = Math.sqrt(Math.max(0, 1 + 2 * E_ap * h_ap * h_ap / (GM_ap * GM_ap)));
      apogeeKm = (a_ap * (1 + e_ap) - R_ap) / 1000;
    }
    _leoStateV2.lastApogeeKm = apogeeKm;

    const h_sb = r_ap * vt_ap;
    const p_sb = h_sb * h_sb / GM_ap;
    const e_sb = Math.sqrt(Math.max(0, 1 + 2 * E_ap * h_sb * h_sb / (GM_ap * GM_ap)));
    const r_p_sb = p_sb / (1 + e_sb);
    const perigeeKm_sb = (r_p_sb - R_ap) / 1000;
    _leoStateV2.lastPerigeeKm = perigeeKm_sb;

    // Predictive cutoff accounts for engine shutdown spool.
    const simDt = (_leoStateV2.lastApogeeSimT > 0 && simT > _leoStateV2.lastApogeeSimT)
      ? (simT - _leoStateV2.lastApogeeSimT) : dt;
    const apogeeRateV2 = (_leoStateV2.lastApogeeSimT > 0
      && Number.isFinite(apogeeKm)
      && Number.isFinite(_leoStateV2._prevApogeeKm))
      ? (apogeeKm - _leoStateV2._prevApogeeKm) / simDt : 0;
    _leoStateV2._prevApogeeKm = apogeeKm;
    _leoStateV2.lastApogeeSimT = simT;

    // ---- Spool Δv via physics, not rate extrapolation ----
// The old model `apogeeKm + apogeeRate × spoolS` assumed apogee
// rate stays constant during spool-down. But thrust tapers
// linearly, so the actual apogee gain is roughly half that
// (average thrust = current/2). Result: cutoff fired ~30 km
// early, leaving a large gap for RCS_BOOST to fill.
//
// New approach — same physics model CIRCULARIZE uses:
//   1. mdot ramps linearly to zero over t_spool_actual
//   2. average Δv = (mdot_now/2) × Ve × t_spool / M
//   3. Apply that Δv prograde to the current velocity
//   4. Compute apogee at THAT velocity — the state the vehicle
//      will actually reach when thrust hits zero
//   5. Cut when that predicted apogee >= target
// Engine contract: shutdownDurationS is a schema-declared field
// on the thruster type. If it's missing, the build is broken —
// don't silently substitute a default, that just hides the bug.
const spoolS = body.engines[0].shutdownDurationS;

let mdot_now_sb = 0;
let maxMFR_sb = 0;
(body.engines || []).forEach(e => {
  mdot_now_sb += (e.massFlowRate || 0);
  if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > maxMFR_sb) {
    maxMFR_sb = e.maxMassFlowRate;
  }
});
const ve_engine_sb = body.engines[0].Ve;
const M_sb = dNext.massProps.M;

// Physics ramp: mdot decreases at fixed rate (maxMFR / spoolS)
// from current flow, so actual spool time scales with current flow.
let t_spool_actual = spoolS;
if (maxMFR_sb > 0 && mdot_now_sb > 0) {
  t_spool_actual = mdot_now_sb * spoolS / maxMFR_sb;
}
const a_avg_sb = (mdot_now_sb / 2) * ve_engine_sb / Math.max(1, M_sb);
const dv_spool_sb = a_avg_sb * t_spool_actual;

// Apply dv_spool prograde to current velocity.
const speed_sb = Math.hypot(body.vx, body.vy);
let apogeePredicted = apogeeKm;
if (speed_sb > 1) {
  const ux_v = body.vx / speed_sb, uy_v = body.vy / speed_sb;
  const vx_pred = body.vx + ux_v * dv_spool_sb;
  const vy_pred = body.vy + uy_v * dv_spool_sb;
  const v2_pred = vx_pred * vx_pred + vy_pred * vy_pred;
  // Specific energy with the SAME radius (spool is fast, radius
  // barely changes: ~30 m/s × 2 s = 60 m out of 6,700 km).
  const E_pred = 0.5 * v2_pred - GM_ap / r_ap;
  if (E_pred < 0) {
    const a_pred = -GM_ap / (2 * E_pred);
    // Specific angular momentum = r × v (z-component).
    const h_pred = body.rx * vy_pred - body.ry * vx_pred;
    const e_pred = Math.sqrt(Math.max(0,
      1 + 2 * E_pred * h_pred * h_pred / (GM_ap * GM_ap)));
    apogeePredicted = (a_pred * (1 + e_pred) - R_ap) / 1000;
  } else {
    apogeePredicted = Infinity;
  }
}
// Cutoff margin: cut the engine this much EARLY, deliberately
// leaving a gap for RCS_BOOST to trim. Decouples cutoff timing
// from tick-granularity — the main engine does coarse burn, RCS
// does the fine trim. 3 m/s ≈ 10-15 km of apogee, which RCS
// covers in ~80 seconds at 1080 N / 28 t.
// Cutoff margin: see LEO_INSERTION_V2.STAGE_BURN_CUTOFF_MARGIN_MPS.
const dv_with_margin = dv_spool_sb + LEO_INSERTION_V2.STAGE_BURN_CUTOFF_MARGIN_MPS;

// Recompute predicted apogee with the extra margin applied.
let apogeePredicted_margin = apogeeKm;
if (speed_sb > 1) {
  const ux_v = body.vx / speed_sb, uy_v = body.vy / speed_sb;
  const vx_pred = body.vx + ux_v * dv_with_margin;
  const vy_pred = body.vy + uy_v * dv_with_margin;
  const v2_pred = vx_pred * vx_pred + vy_pred * vy_pred;
  const E_pred = 0.5 * v2_pred - GM_ap / r_ap;
  if (E_pred < 0) {
    const a_pred = -GM_ap / (2 * E_pred);
    const h_pred = body.rx * vy_pred - body.ry * vx_pred;
    const e_pred = Math.sqrt(Math.max(0,
      1 + 2 * E_pred * h_pred * h_pred / (GM_ap * GM_ap)));
    apogeePredicted_margin = (a_pred * (1 + e_pred) - R_ap) / 1000;
  }
}
const predictedKm = apogeePredicted_margin;

    if (apogeeKm >= LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM ||
        predictedKm >= LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM) {
      send(cmdSetAllThrottle(0));
      send(cmdSetGimbalRate(0));
      _leoStateV2.phase = 'RCS_BOOST';
      _leoStateV2.phaseStart = simT;
      console.log('[leoInsertionV2] STAGE_BURN cutoff — apogee ' +
        apogeeKm.toFixed(1) + ' km (target ' +
        LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM + ') | perigee=' +
        perigeeKm_sb.toFixed(1) + ' km, e=' + e_sb.toFixed(4) +
        ' → RCS_BOOST');
      break;
    }
    break;
  }

  // =========================================================
  // RCS_BOOST — engine off, waits for spool, then fires all four
  // 'up' nozzles at full duty if apogee is below target. Exits at
  // apogee == target, then immediately transitions to CIRCULARIZE
  // (attitude is already prograde from STAGE_BURN's tilt lock).
  // =========================================================
  case 'RCS_BOOST': {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));

  // Current osculating elements.
  const r_b = Math.hypot(body.rx, body.ry);
  const ux_b = body.rx / r_b, uy_b = body.ry / r_b;
  const ex_b = body.ry / r_b, ey_b = -body.rx / r_b;
  const vr_b = body.vx * ux_b + body.vy * uy_b;
  const vt_b = body.vx * ex_b + body.vy * ey_b;
  const GM_b = env.GM_EARTH;
  const R_b = env.EARTH_RADIUS;
  const E_b = 0.5 * (vr_b * vr_b + vt_b * vt_b) - GM_b / r_b;
  let apogeeKm_b = Infinity;
  if (E_b < 0) {
    const a_b = -GM_b / (2 * E_b);
    const h_b = r_b * vt_b;
    const e_b = Math.sqrt(Math.max(0, 1 + 2 * E_b * h_b * h_b / (GM_b * GM_b)));
    apogeeKm_b = (a_b * (1 + e_b) - R_b) / 1000;
  }
  _leoStateV2.lastApogeeKm = apogeeKm_b;

  const h_b2 = r_b * vt_b;
  const p_b = h_b2 * h_b2 / GM_b;
  const e_b2 = Math.sqrt(Math.max(0, 1 + 2 * E_b * h_b2 * h_b2 / (GM_b * GM_b)));
  const r_p_b = p_b / (1 + e_b2);
  const perigeeKm_b = (r_p_b - R_b) / 1000;
  _leoStateV2.lastPerigeeKm = perigeeKm_b;

  // ---- Wait for engine shutdown spool ----
  // During spool-down, residual thrust is still pushing the body
  // prograde; firing RCS on top would double-count. Wait until all
  // engines are effectively at zero flow.
  const engineStillFiring = (body.engines || []).some(e => (e.massFlowRate || 0) > 1);
  if (engineStillFiring) {
    send(cmdRcsDuty(null, idx));
    break;
  }

// ---- Bidirectional trim to EXACT apogee ----
// No tolerance band. RCS fires corrective thrust every tick, and
// we exit the moment apogee CROSSES the target between two ticks
// — the closest achievable point on a discrete tick grid. Per-tick
// apogee movement under RCS thrust (~1080 N on 28 t) is ~2 m, so
// crossing detection lands the final apogee within a couple of
// meters of target. Fires 'up' when undershooting, 'dn' when
// overshooting, symmetric.
const errKm = apogeeKm_b - LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM;
const prevErr = _leoStateV2._prevApogeeErr;
_leoStateV2._prevApogeeErr = errKm;

// Crossing: previous tick was on one side, current tick is on the
// other side (or exactly on the target).
const crossed = (prevErr !== null && prevErr !== undefined &&
  ((prevErr < 0 && errKm >= 0) || (prevErr > 0 && errKm <= 0)));

if (crossed) {
  send(cmdRcsDuty(null, idx));

    // ---- One-shot circularization plan ----
    const r_c = r_b;
    const vr_c = vr_b;
    const vt_c = vt_b;
    const GM_c = GM_b;
    const R_c = R_b;
    const E_c = E_b;
    const a_c = E_c < 0 ? -GM_c / (2 * E_c) : r_c;
    const h_c = r_b * vt_c;
    const e_c = e_b2;
    const r_apo = a_c > 0 ? a_c * (1 + e_c) : r_c;
    const v_apo = r_apo > 0 ? Math.abs(h_c) / r_apo : 0;
    const v_orb = Math.sqrt(GM_c / r_apo);
    const dv_needed = Math.max(0, v_orb - v_apo);

    const v2_c = body.vx * body.vx + body.vy * body.vy;
    const rv_c = body.rx * body.vx + body.ry * body.vy;
    const ex_ecc = ((v2_c - GM_c / r_c) * body.rx - rv_c * body.vx) / GM_c;
    const ey_ecc = ((v2_c - GM_c / r_c) * body.ry - rv_c * body.vy) / GM_c;
    const e_mag = Math.hypot(ex_ecc, ey_ecc);
    let thetaApo;
    if (e_mag > 1e-6) {
      const phiApo = Math.atan2(-ex_ecc, -ey_ecc);
      const rx_apo = r_apo * Math.sin(phiApo);
      const ry_apo = r_apo * Math.cos(phiApo);
      const sDir = (vt_c >= 0) ? 1 : -1;
      thetaApo = Math.atan2(-sDir * ry_apo, -sDir * rx_apo);
    } else {
      thetaApo = Math.atan2(-body.vx, body.vy);
    }
    _leoStateV2.coastTargetThetaInertial = thetaApo;

    const m_now = dNext.massProps.M;
const ve_engine = body.engines[0].Ve;
const m_final = m_now / Math.exp(dv_needed / ve_engine);
const fuel_needed = Math.max(0, m_now - m_final);
const refMax_c = body.engines[0].maxMassFlowRate;
    const t_burn_ideal = refMax_c > 0 ? fuel_needed / refMax_c : 0;
    const t_burn_practical = t_burn_ideal * LEO_INSERTION_V2.COAST_BURN_MULTIPLIER;
    const t_coast = _hTimeToApogee(r_c, vr_c, vt_c, GM_c);

    _leoStateV2.coastCutoffSimT = simT;
    _leoStateV2.coastApogeeKm = (r_apo - R_c) / 1000;
    _leoStateV2.coastVApogee = v_apo;
    _leoStateV2.coastVOrbital = v_orb;
    _leoStateV2.coastDeltaV = dv_needed;
    _leoStateV2.coastFuelNeeded = fuel_needed;
    _leoStateV2.coastTBurnIdeal = t_burn_ideal;
    _leoStateV2.coastTBurnPractical = t_burn_practical;
    _leoStateV2.coastTCoast = t_coast;
    _leoStateV2.phase = 'COAST_ROTATE';
    _leoStateV2.phaseStart = simT;
    _leoStateV2.coastRotateStartTilt = null;
    _leoStateV2.coastRotateMid = null;

    console.log('[leoInsertionV2] RCS_BOOST done at apogee ' +
      apogeeKm_b.toFixed(2) + ' km (err ' + errKm.toFixed(2) + ')' +
      ' | perigee=' + perigeeKm_b.toFixed(1) + ' km, e=' + e_c.toFixed(4) +
      ' | V_apo=' + v_apo.toFixed(1) + ' V_orb=' + v_orb.toFixed(1) +
      ' Δv=' + dv_needed.toFixed(1) + ' → COAST_ROTATE');
    break;
  }

  // Fire the corrective direction. 'up' = toward nose = prograde
  // when body is velocity-aligned (STAGE_BURN tilt-lock maintained
  // through the spool); 'dn' = tailward = retrograde.
  const direction = (errKm > 0) ? 'dn' : 'up';
  const duties = GuideRCS.postSeparationAxialDuty(snapshot, idx, direction);
  if (duties) send(cmdRcsDuty(duties, idx));
  else send(cmdRcsDuty(null, idx));
  break;
}

  // =========================================================
  // COAST_ROTATE — bang-bang RCS slew to fixed inertial θ.
  // =========================================================
  case 'COAST_ROTATE': {
    send(cmdSetAllThrottle(0));
    send(cmdSetGimbalRate(0));

    const elapsed = simT - _leoStateV2.phaseStart;
    if (elapsed >= LEO_INSERTION_V2.COAST_ROTATE_TIMEOUT_S) {
      send(cmdRcsDuty(null, idx));
      _leoStateV2.phase = 'COAST_HOLD';
      _leoStateV2.phaseStart = simT;
      console.log('[leoInsertionV2] COAST_ROTATE timeout — COAST_HOLD');
      break;
    }

    const targetThetaRad = _leoStateV2.coastTargetThetaInertial;
    if (targetThetaRad === null || targetThetaRad === undefined) {
      send(cmdRcsDuty(null, idx));
      _leoStateV2.phase = 'COAST_HOLD';
      _leoStateV2.phaseStart = simT;
      break;
    }
    const targetThetaDeg = targetThetaRad * 180 / Math.PI;
    const currentThetaDeg = body.theta * 180 / Math.PI;

    if (_leoStateV2.coastRotateStartTilt === null) {
      _leoStateV2.coastRotateStartTilt = currentThetaDeg;
      _leoStateV2.coastRotateMid = (currentThetaDeg + targetThetaDeg) / 2;
    }
    const startDeg = _leoStateV2.coastRotateStartTilt;
    const midDeg = _leoStateV2.coastRotateMid;
    const err = targetThetaDeg - currentThetaDeg;
    const omegaRel = body.omega + (env.EARTH_OMEGA || 0);

    if (Math.abs(err) < LEO_INSERTION_V2.COAST_ROTATE_TOL_DEG &&
        Math.abs(omegaRel) < LEO_INSERTION_V2.COAST_ROTATE_OMEGA_TOL) {
      send(cmdRcsDuty(null, idx));
      _leoStateV2.phase = 'COAST_HOLD';
      _leoStateV2.phaseStart = simT;
      console.log('[leoInsertionV2] COAST_ROTATE done at inertial θ',
        currentThetaDeg.toFixed(2), '° — COAST_HOLD');
      break;
    }

      const dirSign = Math.sign(targetThetaDeg - startDeg) || 1;
  const crossed = (startDeg - midDeg) * (currentThetaDeg - midDeg) <= 0;
  const phaseSign = crossed ? -1 : 1;
  const tauCmd = phaseSign * dirSign * 1e9;
  
  // Net-zero-force distributor — this is a coast-phase slew on a
  // ballistic arc; the greedy distributor's unbalanced fires would
  // push the vehicle off the arc over the ~30-60 s rotation.
  const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tauCmd, idx);
  if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
  else send(cmdRcsDuty(null, idx));
  break;
  }
  
  // =========================================================
  // COAST_HOLD — engine OFF, coast toward apogee. RCS holds the
  // distributor; wait for burn trigger (engine startup + 2 s window
  // remaining to apogee, or vr sign flip).
  // =========================================================
  case 'COAST_HOLD': {
    send(cmdSetAllThrottle(0));
    send(cmdSetGimbalRate(0));

    const r_c = Math.hypot(body.rx, body.ry);
    const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
    const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
    const vr_c = body.vx * ux_c + body.vy * uy_c;
    const vt_c = body.vx * ex_c + body.vy * ey_c;
    const t_rem = _hTimeToApogee(r_c, vr_c, vt_c, env.GM_EARTH);

    // Apogee-peak fallback — _hTimeToApogee jumps to full period
    // exactly at apogee; vr sign flip catches the boundary.
    const prevVr = _leoStateV2._prevVr;
    _leoStateV2._prevVr = vr_c;
    const apogeePeak = (prevVr !== null && prevVr !== undefined
      && prevVr > 0 && vr_c <= 0);

  const startupS = body.engines[0].startupDurationS;
// Lead the burn start by an extra few seconds beyond engine startup —
// see LEO_INSERTION_V2.CIRC_TRIGGER_LEAD_S comment.
const triggerWindowS = startupS + LEO_INSERTION_V2.CIRC_TRIGGER_LEAD_S;

    if (t_rem <= triggerWindowS || apogeePeak) {
      send(cmdRcsDuty(null, idx));
      _leoStateV2.phase = 'CIRCULARIZE';
      _leoStateV2.phaseStart = simT;
      console.log('[leoInsertionV2] burn trigger — ' +
        (apogeePeak ? 'apogee peak (vr sign flip)'
          : 't_rem=' + t_rem.toFixed(2) + 's ≤ ' + triggerWindowS.toFixed(2) + 's') +
        ' — CIRCULARIZE');
      break;
    }

    // Attitude hold via net-zero-force RCS.
    if (dNext && dNext.massProps && _leoStateV2.coastTargetThetaInertial !== null) {
      const I_next = dNext.massProps.I;
      const thetaErr = _hWrapPi(body.theta - _leoStateV2.coastTargetThetaInertial);
      const omegaRel = body.omega + (env.EARTH_OMEGA || 0);
      const tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                   + LEO_INSERTION_V2.CIRC_ATT_KD * omegaRel);
      const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
      if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
      else send(cmdRcsDuty(null, idx));
    }
    break;
  }

  // =========================================================
  // CIRCULARIZE — full throttle, gimbal PD-hold at fixed inertial θ.
  // Cutoff when speed reaches V_orbital OR apogee climbs back to
  // target (whichever fires first).
  // =========================================================
  case 'CIRCULARIZE': {
    if (!dNext || !dNext.massProps) break;
    const gimbals = (body.engines || []).filter(e => e.gimbal);

    const r_c = Math.hypot(body.rx, body.ry);
    const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
    const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
    const vr_c = body.vx * ux_c + body.vy * uy_c;
    const vt_c = body.vx * ex_c + body.vy * ey_c;
    const speed = Math.hypot(body.vx, body.vy);
    const v_orb_target = _leoStateV2.coastVOrbital;
    const v_err = v_orb_target - speed;

    _leoStateV2.circCurrentV = speed;
    _leoStateV2.circTargetV = v_orb_target;
    _leoStateV2.circErr = v_err;

    // Current osculating apogee — cutoff if it reaches target again.
    const E_now = 0.5 * (vr_c * vr_c + vt_c * vt_c) - env.GM_EARTH / r_c;
    let apogeeNowKm = Infinity;
    if (E_now < 0) {
      const a_now = -env.GM_EARTH / (2 * E_now);
      const h_now = r_c * vt_c;
      const e_now = Math.sqrt(Math.max(0, 1 + 2 * E_now * h_now * h_now / (env.GM_EARTH * env.GM_EARTH)));
      apogeeNowKm = (a_now * (1 + e_now) - env.EARTH_RADIUS) / 1000;
    }
    _leoStateV2.lastApogeeKm = apogeeNowKm;

    // Cutoff ONLY on speed reaching V_orbital. The previous apogee
// check fired immediately because CIRCULARIZE starts AT apogee
// (RCS_BOOST already pushed it to target) — apogeeNowKm was
// already ≥ 320 on tick 1, so DONE fired before any burn. Speed
// is the physical circularization criterion: at apogee, when
// |v| = V_orbital, perigee rises to apogee and the orbit is
// circular.
// Cutoff fires EARLY by the Δv the engine will deliver during
// its shutdown spool. Physics ramps mass flow linearly from
// current down to zero over shutdownDurationS, so average flow
// ≈ current/2 and fuel burned ≈ (current/2) × spoolS. Tsiolkovsky
// over that fuel gives the post-cutoff Δv. Cutting when the
// remaining v_err equals that predicted Δv lands the actual
// speed on V_orbital at the moment thrust hits zero.
// Read spool time from the ACTIVE engine's own shutdownDurationS
// (per-thruster-type field set in the fleet build, sourced from
// componentLibrary.js). Falls back to CONFIG if the engine object
// doesn't carry it (older cached fleets), then 2.0 as last resort.
const spoolS = body.engines[0].shutdownDurationS;
console.log('[leoInsertionV2] CIRCULARIZE using spoolS=' + spoolS.toFixed(2) +
  's (engine.shutdownDurationS=' +
  (body.engines && body.engines[0] ? body.engines[0].shutdownDurationS : 'none') + ')');

// Simple linear-ramp approximation. Mass flow ramps linearly from
// mdot_now down to zero over spoolS, so average mdot = mdot_now/2.
// Average thrust = (mdot_now/2) × Ve. Average accel = F_avg / M.
// Δv delivered during the spool = a_avg × spoolS.
// Mass loss during the spool (~300 kg on a 30 t stage) is
// negligible for this estimate, so M is treated as constant.
let mdot_now = 0;
(body.engines || []).forEach(e => { mdot_now += (e.massFlowRate || 0); });
const ve_engine_c = body.engines[0].Ve;
const m_now_c = dNext.massProps.M;

// Physics ramp rate = maxMassFlowRate / shutdownDurationS (kg/s²),
// starting from current flow and going down to zero. So the ACTUAL
// spool time is proportional to current flow, not the full rated
// duration:
//   t_spool_actual = mdot_now / (maxMassFlowRate / shutdownS)
//                  = mdot_now × shutdownS / maxMassFlowRate
// Average mdot during the ramp = mdot_now / 2.
let maxMFR = 0;
(body.engines || []).forEach(e => {
  if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > maxMFR) maxMFR = e.maxMassFlowRate;
});
let t_spool_actual = spoolS;
if (maxMFR > 0 && mdot_now > 0) {
  t_spool_actual = mdot_now * spoolS / maxMFR;
}
const F_avg_spool = (mdot_now / 2) * ve_engine_c;
const a_avg_spool = F_avg_spool / Math.max(1, m_now_c);
const dv_spool = a_avg_spool * t_spool_actual;

// Effective target for the STAGE is V_orbital − payload kick,
// because the payload's own final velocity = stage_v + kick.
// Combined with the spool Δv, cutoff fires when the remaining
// stage-side v_err equals (spool Δv + payload kick).
const ejectionKick = (typeof LEO_INSERTION_V2.PAYLOAD_EJECT_KICK_MPS === 'number') ?
  LEO_INSERTION_V2.PAYLOAD_EJECT_KICK_MPS : 0;
const cutoffThreshold = dv_spool + ejectionKick;
if (v_err <= cutoffThreshold) {
  _leoStateV2.circAchieved = true;
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  
  // ---- Compute coast2TargetThetaInertial at CIRCULARIZE end ----
  // Same computation as the RCS_BOOST plan block (which computed
  // coastTargetThetaInertial for COAST_ROTATE): eccentricity vector →
  // apogee point → velocity direction there, as inertial θ. The burn
  // just changed the orbit, so this differs from coastTargetThetaInertial.
  {
    const r_c = Math.hypot(body.rx, body.ry);
    const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
    const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
    const vr_c = body.vx * ux_c + body.vy * uy_c;
    const vt_c = body.vx * ex_c + body.vy * ey_c;
    const GM_c = env.GM_EARTH;
    const v2_c = body.vx * body.vx + body.vy * body.vy;
    const rv_c = body.rx * body.vx + body.ry * body.vy;
    const ex_ecc = ((v2_c - GM_c / r_c) * body.rx - rv_c * body.vx) / GM_c;
    const ey_ecc = ((v2_c - GM_c / r_c) * body.ry - rv_c * body.vy) / GM_c;
    const e_mag = Math.hypot(ex_ecc, ey_ecc);
    let thetaApo;
    if (e_mag > 1e-6) {
      const phiApo = Math.atan2(-ex_ecc, -ey_ecc);
      const E_c = 0.5 * (vr_c * vr_c + vt_c * vt_c) - GM_c / r_c;
      const a_c = E_c < 0 ? -GM_c / (2 * E_c) : r_c;
      const r_apo = a_c * (1 + e_mag);
      const rx_apo = r_apo * Math.sin(phiApo);
      const ry_apo = r_apo * Math.cos(phiApo);
      const sDir = (vt_c >= 0) ? 1 : -1;
      thetaApo = Math.atan2(-sDir * ry_apo, -sDir * rx_apo);
    } else {
      // Near-circular: no meaningful apogee direction; use current
      // velocity direction as a sensible fallback.
      const speed_c = Math.hypot(body.vx, body.vy);
      thetaApo = (speed_c > 1) ? Math.atan2(-body.vx, body.vy) : body.theta;
    }
    _leoStateV2.coast2TargetThetaInertial = thetaApo;
    console.log('[leoInsertionV2] CIRCULARIZE complete — v=' + speed.toFixed(1) +
      ' | coast2Target=' + (thetaApo * 180 / Math.PI).toFixed(2) + '°' +
      ' (e=' + e_mag.toExponential(3) + ') → COAST_ROTATE_2');
  }
  
  _leoStateV2.phase = 'COAST_ROTATE_2';
  _leoStateV2.phaseStart = simT;
  _leoStateV2.coast2RotateStartTilt = null;
  _leoStateV2.coast2RotateMid = null;
  _leoStateV2._prevVr2 = null;
  break;
}

    // Throttle: full until final decay window, then ramp to 40%.
    const decayWindow = LEO_INSERTION_V2.CIRC_DECAY_FRAC * v_orb_target;
    let thrFrac = 1.0;
    if (v_err <= decayWindow && decayWindow > 0) {
      thrFrac = Math.max(0.4, 0.4 + 0.6 * (v_err / decayWindow));
    }
    let refMax = 0;
    (body.engines || []).forEach(e => {
      if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate;
    });
    send(cmdSetAllThrottle(refMax * thrFrac));

    // Gimbal PD-hold at fixed inertial θ.
    if (gimbals.length && _leoStateV2.coastTargetThetaInertial !== null) {
      const I_next = dNext.massProps.I;
      const thetaErr = _hWrapPi(body.theta - _leoStateV2.coastTargetThetaInertial);
      const omegaRel = body.omega + (env.EARTH_OMEGA || 0);
      const tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                   + LEO_INSERTION_V2.CIRC_ATT_KD * omegaRel);
      const g_N = gimbals[0].gimbalDeg || 0;
      const comX1 = dNext.massProps.comX;
      const comY1 = dNext.massProps.comY;
      let A_g = 0, B_g = 0;
      gimbals.forEach(e => {
        const F = (e.massFlowRate || 0) * (e.Ve || 0);
        A_g += ((e.x || 0) - comX1) * F;
        B_g += F;
      });
      B_g *= comY1;
      const R_amp = Math.hypot(A_g, B_g);
      let g_req_rad = 0;
      if (R_amp > 1) {
        const ratio = Math.max(-1, Math.min(1, tau_desired / R_amp));
        const phi = Math.atan2(A_g, B_g);
        const w1 = _hWrapPi(Math.asin(ratio) - phi);
        const w2 = _hWrapPi(Math.PI - Math.asin(ratio) - phi);
        g_req_rad = (Math.abs(w1) <= Math.abs(w2)) ? w1 : w2;
      }
      let g_req_deg = g_req_rad * 180 / Math.PI;
const MAX_ANG = env.GIMBAL_MAX_DEG;
if (Math.abs(g_req_deg) > MAX_ANG) g_req_deg = Math.sign(g_req_deg) * MAX_ANG;
const R_req = (g_req_deg - g_N) / dt;
const MAX_RATE = env.GIMBAL_RATE_DEG_S;
const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));
      send(cmdSetGimbalRate(R_cmd));
    }
    break;
  }


// =========================================================
// COAST_ROTATE_2 — bang-bang slew to coast2TargetThetaInertial,
// exactly the same controller as COAST_ROTATE: target is the fixed
// inertial θ computed at CIRCULARIZE end (velocity direction at the
// new apogee point, from eccentricity vector).
// =========================================================
case 'COAST_ROTATE_2': {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  
  const elapsed = simT - _leoStateV2.phaseStart;
  if (elapsed >= LEO_INSERTION_V2.COAST_ROTATE_TIMEOUT_S) {
    send(cmdRcsDuty(null, idx));
    _leoStateV2.phase = 'COAST_HOLD_2';
    _leoStateV2.phaseStart = simT;
    _leoStateV2._prevVr2 = null;
    console.log('[leoInsertionV2] COAST_ROTATE_2 timeout — COAST_HOLD_2');
    break;
  }
  
  const targetThetaRad = _leoStateV2.coast2TargetThetaInertial;
  if (targetThetaRad === null || targetThetaRad === undefined) {
    send(cmdRcsDuty(null, idx));
    _leoStateV2.phase = 'COAST_HOLD_2';
    _leoStateV2.phaseStart = simT;
    _leoStateV2._prevVr2 = null;
    break;
  }
  const targetThetaDeg = targetThetaRad * 180 / Math.PI;
  const currentThetaDeg = body.theta * 180 / Math.PI;
  
  if (_leoStateV2.coast2RotateStartTilt === null) {
    _leoStateV2.coast2RotateStartTilt = currentThetaDeg;
    _leoStateV2.coast2RotateMid = (currentThetaDeg + targetThetaDeg) / 2;
  }
  const startDeg = _leoStateV2.coast2RotateStartTilt;
  const midDeg = _leoStateV2.coast2RotateMid;
  const err = targetThetaDeg - currentThetaDeg;
  const omegaRel = body.omega + (env.EARTH_OMEGA || 0);
  
  if (Math.abs(err) < LEO_INSERTION_V2.COAST_ROTATE_TOL_DEG &&
    Math.abs(omegaRel) < LEO_INSERTION_V2.COAST_ROTATE_OMEGA_TOL) {
    send(cmdRcsDuty(null, idx));
    _leoStateV2.phase = 'COAST_HOLD_2';
    _leoStateV2.phaseStart = simT;
    _leoStateV2._prevVr2 = null;
    console.log('[leoInsertionV2] COAST_ROTATE_2 done at inertial θ ' +
      currentThetaDeg.toFixed(2) + '° — COAST_HOLD_2');
    break;
  }
  
  const dirSign = Math.sign(targetThetaDeg - startDeg) || 1;
  const crossed = (startDeg - midDeg) * (currentThetaDeg - midDeg) <= 0;
  const phaseSign = crossed ? -1 : 1;
  const tauCmd = phaseSign * dirSign * 1e9;
  
  const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tauCmd, idx);
  if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
  else send(cmdRcsDuty(null, idx));
  break;
}
  
// =========================================================
// COAST_HOLD_2 — same COASTnAoADAMP controller as pre-circularize
// COAST_HOLD: AoA damping drives the nose to the velocity direction
// (prograde). AoA is velocity-relative by definition, so the target
// rotates with the orbit naturally — no fixed inertial θ, no drift.
// Eject on vr sign flip (apogee crossing).
// =========================================================
case 'COAST_HOLD_2': {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));

  const r_c = Math.hypot(body.rx, body.ry);
  const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
  const vr_c = body.vx * ux_c + body.vy * uy_c;

  const prevVr = _leoStateV2._prevVr2;
  _leoStateV2._prevVr2 = vr_c;
  const apogeePeak = (prevVr !== null && prevVr !== undefined
    && prevVr > 0 && vr_c <= 0);

  if (apogeePeak) {
    send(cmdRcsDuty(null, idx));
    if (typeof cmdReleasePayload === 'function') send(cmdReleasePayload());
    _leoStateV2.phase = 'DONE';
    console.log('[leoInsertionV2] payload released at apogee — ' +
      'r=' + r_c.toFixed(0) + 'm vr=' + vr_c.toFixed(3) +
      ' alt=' + ((r_c - env.EARTH_RADIUS) / 1000).toFixed(1) + ' km');
    break;
  }

  // Attitude hold — same formula as ascent COASTnAoADAMP and
  // pre-circularize COAST_HOLD.
  if (dNext && dNext.massProps) {
    const I_next = dNext.massProps.I;
    const gain = (LEO_INSERTION_V2.ASCENT && Number.isFinite(LEO_INSERTION_V2.ASCENT.COAST_DAMP_GAIN))
      ? LEO_INSERTION_V2.ASCENT.COAST_DAMP_GAIN : 16;
    const kd = (LEO_INSERTION_V2.ASCENT && Number.isFinite(LEO_INSERTION_V2.ASCENT.COAST_DAMP_K))
      ? LEO_INSERTION_V2.ASCENT.COAST_DAMP_K : 4.0;
        const tau_desired = (-I_next * gain * dNext.alphaDeg) / (kd * kd) -
      I_next * LEO_INSERTION_V2.COAST2_DAMP_RATE * body.omega;
    
    const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
    if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
    else send(cmdRcsDuty(null, idx));
    }
    break;
    }


// =========================================================
// DONE — engine off, orbit ballistic. Same COASTnAoADAMP attitude
// hold as COAST_HOLD_2 (AoA damping keeps the nose prograde as the
// orbit progresses — naturally tracks the rotating target).
// =========================================================
case 'DONE': {
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  
  if (dNext && dNext.massProps) {
  const I_next = dNext.massProps.I;
  const gain = (LEO_INSERTION_V2.ASCENT && Number.isFinite(LEO_INSERTION_V2.ASCENT.COAST_DAMP_GAIN)) ?
    LEO_INSERTION_V2.ASCENT.COAST_DAMP_GAIN : 16;
  const kd = (LEO_INSERTION_V2.ASCENT && Number.isFinite(LEO_INSERTION_V2.ASCENT.COAST_DAMP_K)) ?
    LEO_INSERTION_V2.ASCENT.COAST_DAMP_K : 4.0;
  const tau_desired = (-I_next * gain * dNext.alphaDeg) / (kd * kd) -
    I_next * LEO_INSERTION_V2.COAST2_DAMP_RATE * body.omega;
  
  const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
  if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
  else send(cmdRcsDuty(null, idx));
}
break;
}



  default:
    break;
}

  // ---- Fairing open (independent) ----
  if (LEO_INSERTION_V2.FAIRING_OPEN_ENABLED &&
      !_leoStateV2.fairingOpened &&
      _leoStateV2.splitDetected &&
      _leoStateV2.lastAltKm >= LEO_INSERTION_V2.FAIRING_OPEN_ALT_KM) {
    const stageBody = snapshot.bodies[_leoStateV2.stageIdx];
    const hasFairing = !!(stageBody && stageBody.members &&
      stageBody.members.some(m => m && m.stageRole === 'payloadSpace'));
    if (hasFairing) {
      send(cmdSplitFairing());
      _leoStateV2.fairingOpened = true;
      console.log('[leoInsertionV2] fairing open at',
        _leoStateV2.lastAltKm.toFixed(2), 'km');
    }
  }
}

_leoTickV2.start = function () {
  _leoStateV2.init = false;
  _leoStateV2.ticks = 0;
  _leoStateV2.phase = 'ASCENT';
  _leoStateV2.phaseStart = 0;
  _leoStateV2.mecoTriggered = false;
_leoStateV2.splitDetected = false;
_leoStateV2.fairingOpened = false;
_leoStateV2.initialBodyCount = 0;
_leoStateV2.missionBodyIdx = null;
  _leoStateV2.preSplitBodyId = null;
  _leoStateV2.boosterIdx = -1;
  _leoStateV2.stageIdx = -1;
  _leoStateV2.lastAltKm = 0;
  _leoStateV2.lastAxialGap = 0;
  _leoStateV2.lastLateralGap = 0;
  _leoStateV2.lastApogeeKm = 0;
  _leoStateV2.lastApogeeSimT = 0;
  _leoStateV2._prevApogeeKm = 0;
_leoStateV2._prevVr = null;
_leoStateV2._prevApogeeErr = null;
  _leoStateV2.coastCutoffSimT = 0;
  _leoStateV2.coastApogeeKm = 0;
  _leoStateV2.coastVApogee = 0;
  _leoStateV2.coastVOrbital = 0;
  _leoStateV2.coastDeltaV = 0;
  _leoStateV2.coastFuelNeeded = 0;
  _leoStateV2.coastTBurnIdeal = 0;
  _leoStateV2.coastTBurnPractical = 0;
  _leoStateV2.coastTCoast = 0;
  _leoStateV2.coastRotateStartTilt = null;
_leoStateV2.coastRotateMid = null;
_leoStateV2.coastTargetThetaInertial = null;
  _leoStateV2.circCurrentV = 0;
  _leoStateV2.circTargetV = 0;
  _leoStateV2.circErr = 0;
    _leoStateV2.circAchieved = false;
  _leoStateV2.lastPerigeeKm = null;
    _leoStateV2.stageBurnLocked = false;
  _leoStateV2.stageBurnTargetTiltDeg = 0;
  _leoStateV2._prevApogeeKm = 0;
    _leoStateV2.deployTargetTheta = null;
  _leoStateV2.deployStartTheta = 0;
  _leoStateV2.deployBangMid = 0;
  _leoStateV2.coast2TargetThetaInertial = null;
  _leoStateV2.coast2RotateStartTilt = null;
  _leoStateV2.coast2RotateMid = null;
  _leoStateV2._prevVr2 = null;
  
  console.log('[leoInsertionV2] started');
  };
_leoTickV2.stop = function() {
  // Commands target the mission body explicitly — send() auto-injects
  // the lock, which is still set at this point. Only after cleanup do
  // we clear the mission body.
  send(cmdSetAllThrottle(0));
  send(cmdSetGimbalRate(0));
  send(cmdRcsDuty(null));
  if (typeof _hTick !== 'undefined' && typeof _hTick.stop === 'function') {
    try { _hTick.stop(); } catch (e) {}
  }
  // Release the mission lock so a subsequent guide start picks up
  // whatever body is active at that moment.
  _leoStateV2.missionBodyIdx = null;
  if (typeof Guidance !== 'undefined' && Guidance.setMissionBody) {
    Guidance.setMissionBody(null);
  }
  console.log('[leoInsertionV2] stopped');
};
_leoTickV2.getStatus = function () {
  return {
    ticks: _leoStateV2.ticks,
    phase: _leoStateV2.phase,
    altKm: _leoStateV2.lastAltKm,
    mecoTriggered: _leoStateV2.mecoTriggered,
    splitDetected: _leoStateV2.splitDetected,
    fairingOpened: _leoStateV2.fairingOpened,
    axialGap: _leoStateV2.lastAxialGap,
    lateralGap: _leoStateV2.lastLateralGap,
    apogeeKm: _leoStateV2.lastApogeeKm,
    coastTBurnIdeal: _leoStateV2.coastTBurnIdeal,
    coastTBurnPractical: _leoStateV2.coastTBurnPractical,
    coastTCoast: _leoStateV2.coastTCoast,
    coastDeltaV: _leoStateV2.coastDeltaV,
    coastVOrbital: _leoStateV2.coastVOrbital,
    coastTargetThetaDeg: (_leoStateV2.coastTargetThetaInertial != null) ?
    _leoStateV2.coastTargetThetaInertial * 180 / Math.PI : null,
    circCurrentV: _leoStateV2.circCurrentV,
    circTargetV: _leoStateV2.circTargetV,
    circErr: _leoStateV2.circErr,
    circAchieved: _leoStateV2.circAchieved,
    lastPerigeeKm: _leoStateV2.lastPerigeeKm,
    stageBurnLocked: _leoStateV2.stageBurnLocked,
    stageBurnTargetTiltDeg: _leoStateV2.stageBurnTargetTiltDeg,
    // Post-circularization realign — new apogee-point θ (recomputed
    // after the burn; differs from coastTargetThetaDeg because the
    // 3 s early burn start + early cutoff shifted the orbit).
    coast2TargetThetaDeg: (_leoStateV2.coast2TargetThetaInertial != null) ?
    _leoStateV2.coast2TargetThetaInertial * 180 / Math.PI : null,
    coast2RotateStartTiltDeg: _leoStateV2.coast2RotateStartTilt,
    coast2RotateMidDeg: _leoStateV2.coast2RotateMid,
  };
  };

GUIDES.leoInsertionV2 = _leoTickV2;

function setLeoInsertionV2(patch) {
  if (!patch) return;
  Object.keys(patch).forEach(k => {
    if (!(k in LEO_INSERTION_V2)) return;
    const cur = LEO_INSERTION_V2[k];
    const nxt = patch[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) &&
        nxt && typeof nxt === 'object' && !Array.isArray(nxt)) {
      Object.assign(cur, nxt);
    } else {
      LEO_INSERTION_V2[k] = nxt;
    }
  });
  console.log('[leoInsertionV2] constants updated');
}
function getLeoInsertionV2Config() { return { ...LEO_INSERTION_V2 }; }





// ---- Mission body lock ----
// When a guide is running, every command it sends must land on the
// body the guide is flying, regardless of what body the human UI has
// selected via Take Control. Without this, Take Control repoints
// guidance at the wrong vehicle — the guided body gets its engines
// killed by take-control's shutdown, and the newly-focused body
// receives stage-burn throttle commands it was never meant to.
let _missionBodyIdx = null;
function setMissionBody(idx) {
  _missionBodyIdx = Number.isInteger(idx) ? idx : null;
}

// ---- Outbound: single choke point for physics commands. ----
function send(msg) {
  if (!_physicsSend) {
    console.warn('[guidance] send() called before physics port connected:', msg);
    return;
  }
  // Auto-inject the mission body when the caller didn't set one.
  // Commands that explicitly set targetBodyIdx (RCS_BOOST, etc.) are
  // left untouched — only the default-active-body path is redirected.
  if (_missionBodyIdx !== null && msg.targetBodyIdx === undefined) {
    msg.targetBodyIdx = _missionBodyIdx;
  }
  _physicsSend(msg);
}
  
  // ---- Command builders. Shape-only; clamping is physics's job. ----
  function cmdSetGroupThrottle(angles, kgPerSec) { return { type: 'setGroupThrottle', angles, value: kgPerSec }; }
  function cmdSetCenterThrottle(kgPerSec) { return { type: 'setCenterThrottle', value: kgPerSec }; }
  function cmdSetAllThrottle(kgPerSec) { return { type: 'setAllThrottle', value: kgPerSec }; }
  function cmdRcs(key, on) { return { type: 'rcs', key, on: !!on }; }
  function cmdLegs(deployed) { return { type: 'legs', deployed: !!deployed }; }
  function cmdSeparate() { return { type: 'separate' }; }
  function cmdSplitFairing() { return { type: 'splitFairing' }; }
  function cmdReleasePayload() { return { type: 'releasePayload' }; }
  function cmdEmergencyEject() { return { type: 'emergencyEject' }; }
  function cmdTakeControl(idx) { return { type: 'takeControl', idx }; }
  function cmdWarp(value) { return { type: 'warp', value }; }
  function cmdSetFuelMass(value) { return { type: 'setFuelMass', value }; }
  function cmdSetGimbalRate(degPerSec) { return { type: 'setGimbalRate', degPerSec }; }
  // Optional targetBodyIdx — post-separation, guidance needs to command
// a non-active body's pods (typically the discarded booster). Physics
// worker's resolveTargetBody handles it; human UI never sets it.
function cmdRcsDuty(duties, targetBodyIdx) {
  const msg = { type: 'rcsDuty', duties };
  if (Number.isInteger(targetBodyIdx)) msg.targetBodyIdx = targetBodyIdx;
  return msg;
}

  return {
    init,
    setImuEnabled,
    setStackData,
    getStackData,
    onSnapshot,
tick,
send,
// Guide library
startGuide,
stopGuide,
setActiveGuide,
getActiveGuide,
listGuides,
getGuideStatus,
setPredictiveGains,
setAscentRR,
setSweepDuration,
setAscentHold,
setLeoInsertion,
setLeoInsertionV2,
setMissionBody,
getLeoInsertionV2Config,
getAscentRRConfig,
getAscentHoldConfig,
getPredictiveGains,
getLeoInsertionConfig,
exportGuideState,
importGuideState,
    // Convenience forwarders so callers can keep using Guidance.*
    derive: (...args) => Derivation.derive(...args),
    deriveAllBodies: (...args) => Derivation.deriveAllBodies(...args),
    targetTorqueRcs: (...args) => GuideRCS.targetTorqueRcs(...args),
    // Command builders
    cmdSetGroupThrottle,
    cmdSetCenterThrottle,
    cmdSetAllThrottle,
    cmdRcs,
    cmdLegs,
    cmdSeparate,
    cmdSplitFairing,
    cmdReleasePayload,
    cmdEmergencyEject,
    cmdTakeControl,
    cmdWarp,
    cmdSetFuelMass,
    cmdSetGimbalRate,
    cmdRcsDuty,
    // Debug getters
    get lastRawSnapshot() { return _lastRawSnapshot; },
    get lastMeasuredSnapshot() { return _lastMeasuredSnapshot; },
  };
})();