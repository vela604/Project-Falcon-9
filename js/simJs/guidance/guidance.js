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
setSweepDuration,
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