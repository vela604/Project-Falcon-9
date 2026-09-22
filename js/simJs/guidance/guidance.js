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
    INITIAL_COAST_S: 4.9, // straight climb before the push pulse
  PUSH_T_S: 4.8,
  // --- PUSH amplitude, specified as the peak gimbal angle to swing to.
  //     At each tick during PUSH, the gimbal torque coefficients A/B
  //     (= −comX·ΣF, comY·ΣF) are computed from the current thrust and
  //     geometry, then the peak torque at this gimbal angle is
  //         τ_gimbal_max = A·cos(g_max) + B·sin(g_max)
  //     and the sine pulse amplitude is  A_ang = τ_gimbal_max / I.
  //     So the peak torque during the pulse equals the max the gimbal
  //     can produce at this angle — self-scaling with thrust & inertia.
  //
 //     Default 1.5° is calibrated to be roughly equivalent to the
//     previous PUSH_DELTA_DEG = 1° for the F9-class test stack. Tune
//     by feel.
PUSH_MAX_GIMBAL_DEG: 1.75,
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

function _hTick(snapshot) {
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
  const cfg = ASCENT_HOLD;
  
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
  
   // ---------- Throttle: THROTTLE_FRAC × each engine's own max ----------
  //   refMax is the largest maxMassFlowRate among this stack's engines.
  //   Sending refMax × frac lets physics's clampMassFlowCommand scale
  //   each engine to its own frac of its own max — exact for the normal
  //   homogeneous octaweb case.
  let refMax = 0;
  engines.forEach(e => { if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate; });
  const thrFrac = (Number.isFinite(cfg.THROTTLE_FRAC) && cfg.THROTTLE_FRAC > 0) ?
    Math.min(1, cfg.THROTTLE_FRAC) : 1.0;
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
  
  // ---- Outbound: single choke point for physics commands. ----
  function send(msg) {
    if (!_physicsSend) {
      console.warn('[guidance] send() called before physics port connected:', msg);
      return;
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
  // Pass null to relinquish; {} latches at zero.
  function cmdRcsDuty(duties) { return { type: 'rcsDuty', duties }; }
  
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
getAscentRRConfig,
getAscentHoldConfig,
getPredictiveGains,
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