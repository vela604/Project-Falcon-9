// ============================================================================
// guidance-blocks.js — Fundamental reusable guidance blocks.
//
// A "block" is a bounded, self-contained piece of guidance logic with its
// own state, its own constants schema, and a lifecycle interface. Blocks
// are the reusable units that mission-level guides compose together.
//
// Each block is INSTANCE-created (createInstance()), so the same block
// definition can be instantiated multiple times in parallel. All state is
// instance-local; the definition object is stateless.
//
// INTERFACE (every block instance must implement):
//   start(constants, bodyIdx, missionCtx)
//   tick(snapshot)
//   stop()
//   isDone()
//   getResult()
//   getStatus()
//   getBodyIdx()
//   getConstants()
//   setConstants(patch)
//
// Loaded BEFORE guidance.js in every context (worker + page).
// ============================================================================

// ============================================================================
// Gimbal angular-acceleration helpers. The gimbal is an accel-limited actuator:
// guidance commands an angular acceleration alpha (deg/s^2) and physics
// (applyActuatorRateLimitsForBody) integrates rate and angle. Limits are
// per-engine thruster-type properties (gimbalMaxDeg / gimbalRateDegS /
// gimbalAccelDegS2) read from the snapshot engine, not from env/CONFIG.
// Shared by every block that commands the gimbal; the same law is meant to be
// reused later for grid fins.
// ============================================================================
// ===== Verbose deploy-phase diagnostic gate =====
// false = silent except [DEPLOY-RESULT] (one line pair per deploy).
// true  = fires APEX / TORQUE-DIAG / TRIM-DIAG / STAGE-ORBIT / DEPLOY-FIRE
//         / DEPLOY-DIAG / SPAWN / PAY-ORBIT — reproduces the 26m->0.9m
//         investigation (LEOINSERTION-V3.md §5.8). Physics-side [PHYS-SPAWN]
//         log has its own flag in physics.js (DEBUG_PHYS_SPAWN).
const DEBUG_DEPLOY = false;

function _gClamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// 2-tick Newtonian law (final rate vf = 0): alpha so that the gimbal reaches
// g_req with zero rate after 2 ticks, re-solved every tick (receding horizon),
// clamped to +-aMax, plus a braking guard so a SATURATED alpha cannot overshoot:
// when heading toward the target faster than sqrt(2*aMax*|gap|), cap the speed.
// NOTE: physics.js keeps a copy (_gimbalAlphaCmdPhys) for the slider-angle path;
// keep the two in sync.
function _gimbalAlphaCmd(g_req, g_N, v, dt, aMax) {
  const d = g_req - g_N;
  let a = _gClamp((d / dt - v) / dt, -aMax, aMax);
  const vcap = 0.9 * Math.sqrt(2 * aMax * Math.abs(d));
  const vnew = v + a * dt;
  if (Math.abs(vnew) > vcap && vnew * d > 0) {
    a = _gClamp((Math.sign(d) * vcap - v) / dt, -aMax, aMax);
  }
  return a;
}

// Predicted gimbal angle one tick ahead if the CURRENT command is left unchanged
// (mirrors the physics branch in applyActuatorRateLimitsForBody, incl. the
// slider-angle path and the angle/rate clamps).
function _gimbalNextAngle(e, dt) {
  const aMax = e.gimbalAccelDegS2, vMax = e.gimbalRateDegS, gLim = e.gimbalMaxDeg;
  const g = e.gimbalDeg || 0;
  let v = e.gimbalRateActDegS || 0;
  let a = 0;
  if (Number.isFinite(e.targetGimbalAccelDegS2)) a = e.targetGimbalAccelDegS2;
  else if (Number.isFinite(e.targetGimbalRateDegS)) a = (_gClamp(e.targetGimbalRateDegS, -vMax, vMax) - v) / dt;
  else if (Number.isFinite(e.targetGimbalDeg)) a = _gimbalAlphaCmd(_gClamp(e.targetGimbalDeg, -gLim, gLim), g, v, dt, aMax);
  a = _gClamp(a, -aMax, aMax);
  v = _gClamp(v + a * dt, -vMax, vMax);
  let gn = g + v * dt;
  if (gn > gLim) gn = gLim; else if (gn < -gLim) gn = -gLim;
  return gn;
}

// The one place that builds the gimbal command message (alpha, deg/s^2).
function _gimbalCmdMsg(g_req_deg, gimbal0, dt, target) {
  const alpha = _gimbalAlphaCmd(g_req_deg, gimbal0.gimbalDeg || 0, gimbal0.gimbalRateActDegS || 0,
    dt, gimbal0.gimbalAccelDegS2);
  return Guidance.cmdSetGimbalAccel(alpha, target);
}

const FUNDAMENTAL_BLOCKS = {
  // ==========================================================================
  // ASCENT — pad → MECO_SPOOL
  //
  // Runs the ascent attitude sub-machine (PRE_COAST → PUSH → COAST →
  // HOLD → COASTnAoADAMP), monitors the booster tank, and when the
  // booster's residual fuel (after shutdown spool-down) reaches
  // MECO_TARGET_BOOSTER_FUEL_KG: issues cmdSeparate() and ends.
  //
  // Body-locked to the launch stack (typically index 0).
  // ==========================================================================
  ascent: {
    name: "ascent",
    displayName: "Ascent",
    description:
      "Pad → MECO. Fires engines, runs the ascent attitude sub-machine, and issues the separation command when the booster's residual fuel reaches the MECO fuel target.",
    defaultConstants: {
      INITIAL_COAST_S: 4.9,
  PUSH_T_S: 4.82,
  PUSH_MAX_GIMBAL_DEG: 0.64,
  PUSH_EAST_SIGN: -1,
      // HOLD attitude law (the only one): stage-burn style PD on AoA angle + AoA rate
      // (tau = -I*(KP*aoa + KD*omegaAoA + KI*int(aoa))), no bias, applied for both HOLD and COASTnAoADAMP phases.
      HOLD_PD_KP: 1.0,
      HOLD_PD_KD: 2.0,
      // Integral gain on AoA (fixed constant, not tuned). Removes the PD static AoA offset (grows with q). KI < KP*KD.
      HOLD_PD_KI: 0.3,
      // Seconds. >0 low-passes the commanded gimbal in aoa_pd HOLD (removes the 1-tick limit cycle). 0 = old deadbeat command.
      GIMBAL_CMD_TAU_S: 0.1,
      THROTTLE_FRAC: 1.0,
      THROTTLE_ALT_LOW_KM: 8,
      THROTTLE_ALT_HIGH_KM: 13,
      THROTTLE_FRAC_LOW: 0.7,
        GIMBAL_TARGET: "center",
    // MECO is fuel-triggered (the only trigger): fire MECO when the
    // booster's tank will have exactly MECO_TARGET_BOOSTER_FUEL_KG left
    // AFTER the shutdown spool-down burns through its residual flow.
    // Residual booster tank fuel (kg) desired at the end of spool-down.
    MECO_TARGET_BOOSTER_FUEL_KG: 52612,
  },
  importantFields: [],
    createInstance: function() {
      // ---- Instance state ----
      let _constants = null;
      let _bodyIdx = null;
      let _missionCtx = null;
      let _done = false;
      let _result = null;

      // Sub-machine state — mirrors the module-level _hState in guidance.js
      // (V2 keeps its own copy; this is the block-local copy).
      const _sub = {
        init: false,
        ticks: 0,
        phase: "PRE_COAST",
        phaseStart: 0,
        currentDeltaDeg: 0,
        lastLockedDeltaDeg: 0,
        lastThrottleSent: undefined,
        lastQ: null,
        lastDQ: 0,
        lastElapsed: 0,
        lastAltKm: 0,
        lastAoANowDeg: 0,
        lastAoANextDeg: 0,
        lastOmegaAoANow: 0,
        lastOmegaAoANext: 0,
        lastAlphaAoANow: 0,
        lastAlphaAoANext: 0,
        lastTauDesired: 0,
        lastTauDrag: 0,
        lastTauTarget: 0,
        lastTauDQ: 0,
        lastGRate: 0,
        lastGRadN: 0,
        lastGReqDeg: 0,
      };

      // MECO monitoring state
      let _mecoTriggered = false;
      let _lastApogeeKm = Infinity;
      let _mecoSimTime = null;
      let _apogeeAtMeco_km = null;
      let _tiltAtMeco_deg = null;
      // Debug-only captures (mirror V2's init block)
      let _initStackMass = null;
      let _initComH = null;
      let _initI = null;
      let _initFuelMass = null;
      let _captured = false;
      let _primed = false;

      // ---- Helpers ----
      function _send(cmd) {
        if (!cmd) return;
        if (cmd.targetBodyIdx === undefined) cmd.targetBodyIdx = _bodyIdx;
        Guidance.send(cmd);
      }

      function _wrapPi(x) {
        while (x > Math.PI) x -= 2 * Math.PI;
        while (x < -Math.PI) x += 2 * Math.PI;
        return x;
      }

      // ---- Sub-machine tick — verbatim from guidance.js's _hTick ----
      function _tickSubMachine(snapshot) {
        _sub.ticks++;
        const idx = _bodyIdx;
        const body = snapshot.bodies[idx];
        if (!body) return;

        const dNow = Derivation.derive(snapshot, idx);
        if (!dNow || !dNow.massProps) return;

        const env = Derivation.getEnv();
        const dt = env && Number.isFinite(env.DT) ? env.DT : 1 / 80;
        const M = dNow.massProps.M;
        if (!(M > 0)) return;

        const simT = snapshot.simTime;
        const altKm = dNow.altitudeAGL / 1000;
        _sub.lastAltKm = altKm;
        const cfg = _constants;

        if (!_sub.init) {
          _sub.init = true;
          _sub.phase = "PRE_COAST";
          _sub.phaseStart = simT;
        }

        const cosTc = Math.cos(dNow.theta),
          sinTc = Math.sin(dNow.theta);
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
        const theta_n =
          dNow.theta + dNow.omega * dt + 0.5 * alpha_body * dt * dt;
        const sloshNow = body.slosh || { offset: 0, velocity: 0 };
        const sloshX_n = (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt;
        const sloshV_n = sloshNow.velocity || 0;

        const engines = body.engines || [];
        const gimbalTarget = cfg.GIMBAL_TARGET || "all";
        const gimbals = engines.filter(
          (e) => e.gimbal && (gimbalTarget !== "center" || e.isCenter),
        );
        if (!gimbals.length) return;

        const g_N = gimbals[0].gimbalDeg || 0;
        const g_N1 = _gimbalNextAngle(gimbals[0], dt);

        const dNext = Derivation.deriveForState(
          snapshot,
          idx,
          {
            rx: rx_n,
            ry: ry_n,
            vx: vx_n,
            vy: vy_n,
            theta: theta_n,
            omega: omega_n,
            slosh: { offset: sloshX_n, velocity: sloshV_n },
          },
          g_N1,
          cfg.GIMBAL_TARGET,
        );
        if (!dNext || !dNext.massProps) return;

        const tau_drag_next = dNext.torqueDrag;
        _sub.lastTauDrag = tau_drag_next;
        const I_next = dNext.massProps.I;

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

        const kC = bodyFrameKinematics(dNow, M);
        const r2C = kC.u * kC.u + kC.v * kC.v;
        const PC = kC.v * kC.ax - kC.u * kC.ay;
        const QC = kC.u * kC.ax + kC.v * kC.ay;
        const omegaAoANow = r2C > 1e-6 ? dNow.omega + PC / r2C : 0;
        const alphaAoANow =
          r2C > 1e-6 ? dNow.alphaAng - (2 * PC * QC) / (r2C * r2C) : 0;

        const kN = bodyFrameKinematics(dNext, dNext.massProps.M);
        const r2N = kN.u * kN.u + kN.v * kN.v;
        const PN = kN.v * kN.ax - kN.u * kN.ay;
        const QN = kN.u * kN.ax + kN.v * kN.ay;
        const omegaAoANext = r2N > 1e-6 ? dNext.omega + PN / r2N : 0;
        const alphaAoANext =
          r2N > 1e-6 ? dNext.alphaAng - (2 * PN * QN) / (r2N * r2N) : 0;

        _sub.lastAoANowDeg = dNow.alphaDeg;
        _sub.lastAoANextDeg = dNext.alphaDeg;
        _sub.lastOmegaAoANow = omegaAoANow;
        _sub.lastOmegaAoANext = omegaAoANext;
        _sub.lastAlphaAoANow = alphaAoANow;
        _sub.lastAlphaAoANext = alphaAoANext;

        const Q_now = dNow.Q;
        const dQ = _sub.lastQ !== null ? (Q_now - _sub.lastQ) / dt : 0;
        _sub.lastQ = Q_now;
        _sub.lastDQ = dQ;

        const elapsed = simT - _sub.phaseStart;

        if (_sub.phase === "PRE_COAST") {
          if (elapsed >= cfg.INITIAL_COAST_S) {
            _sub.phase = "PUSH";
            _sub.phaseStart = simT;

            const g_max_rad =
              ((Number.isFinite(cfg.PUSH_MAX_GIMBAL_DEG)
                ? cfg.PUSH_MAX_GIMBAL_DEG
                : 0) *
                Math.PI) /
              180;
            let A_gp = 0,
              B_gp = 0;
            gimbals.forEach((e) => {
              const F = (e.massFlowRate || 0) * (e.Ve || 0);
              A_gp += ((e.x || 0) - dNext.massProps.comX) * F;
              B_gp += F;
            });
            B_gp *= dNext.massProps.comY;
            const tau_peak =
              A_gp * Math.cos(g_max_rad) + B_gp * Math.sin(g_max_rad);
            const Tp = cfg.PUSH_T_S;
            const deltaRad =
              I_next > 0 ? (tau_peak * Tp * Tp) / (2 * Math.PI * I_next) : 0;
            _sub.currentDeltaDeg = (deltaRad * 180) / Math.PI;
            _sub.lastLockedDeltaDeg = _sub.currentDeltaDeg;
          }
        } else if (_sub.phase === "PUSH") {
          if (elapsed >= cfg.PUSH_T_S) {
            _sub.phase = "COAST";
            _sub.phaseStart = simT;
          }
        } else if (_sub.phase === "COAST") {
          if (dNow.alphaDeg >= 0) {
            _sub.phase = "HOLD";
            _sub.phaseStart = simT;
          }
        } else if (_sub.phase === "HOLD") {
          if (dNow.alphaDeg < 0) {
            _sub.phase = "COASTnAoADAMP";
            _sub.phaseStart = simT;
          }
        }
        _sub.lastElapsed = elapsed;

        let tau_desired = 0;
        if (_sub.phase === "PUSH") {
          const T = cfg.PUSH_T_S;
          const dTheta_rad = (_sub.currentDeltaDeg * Math.PI) / 180;
          const A_ang = (2 * Math.PI * dTheta_rad) / (T * T);
          const omega_ang = (2 * Math.PI) / T;
          const tRel = Math.max(0, Math.min(T, elapsed));
          tau_desired =
            cfg.PUSH_EAST_SIGN * I_next * A_ang * Math.sin(omega_ang * tRel);
          _sub.lastTauDQ = 0;
          _sub.aoaInt = 0;
        } else if (_sub.phase === "COAST" || _sub.phase === "PRE_COAST") {
          tau_desired = 0;
          _sub.aoaInt = 0;
          _sub.lastTauDQ = 0;
        } else {
          // Same PD-on-AoA as STAGE_BURN: uses AoA's own rate (omega + P/r^2), no accel term,
          // so no dependence of tau_desired on the gimbal being solved (no 1-tick sign-flip loop).
          const aoaRadPD = (Number.isFinite(dNext.alphaDeg) ? dNext.alphaDeg : 0) * Math.PI / 180;
          // PID: conditional integration (|aoa| < 0.05 deg) + clamp; reset outside HOLD/COASTnAoADAMP.
          const _kiH = Number.isFinite(cfg.HOLD_PD_KI) ? cfg.HOLD_PD_KI : 0.3;
          if (!Number.isFinite(_sub.aoaInt)) _sub.aoaInt = 0;
          if (Math.abs(aoaRadPD) < 0.05 * Math.PI / 180) {
            _sub.aoaInt = Math.max(-0.005, Math.min(0.005, _sub.aoaInt + aoaRadPD * dt));
          }
          tau_desired = -I_next * (cfg.HOLD_PD_KP * aoaRadPD + cfg.HOLD_PD_KD * omegaAoANext + _kiH * _sub.aoaInt);
          _sub.lastTauDQ = 0;
        }
        _sub.lastTauDesired = tau_desired;

        const tau_target = tau_desired - tau_drag_next;
        _sub.lastTauTarget = tau_target;

        const comX = dNext.massProps.comX;
        const comY = dNext.massProps.comY;
        let A_g = 0,
          B_g = 0;
        gimbals.forEach((e) => {
          const F = (e.massFlowRate || 0) * (e.Ve || 0);
          A_g += ((e.x || 0) - comX) * F;
          B_g += F;
        });
        B_g *= comY;

        const R_amp = Math.hypot(A_g, B_g);
        let g_req_rad = 0;
        if (R_amp > 1) {
          const ratio = Math.max(-1, Math.min(1, tau_target / R_amp));
          const phi = Math.atan2(A_g, B_g);
          const w1 = _wrapPi(Math.asin(ratio) - phi);
          const w2 = _wrapPi(Math.PI - Math.asin(ratio) - phi);
          g_req_rad = Math.abs(w1) <= Math.abs(w2) ? w1 : w2;
        }
        let g_req_deg = (g_req_rad * 180) / Math.PI;
        const MAX_ANG = gimbals[0].gimbalMaxDeg;
        if (Math.abs(g_req_deg) > MAX_ANG)
          g_req_deg = Math.sign(g_req_deg) * MAX_ANG;

        // Command shaping (ascent HOLD, aoa_pd only): the target gimbal is low-passed with a PHYSICAL time
        // constant GIMBAL_CMD_TAU_S (seconds, dt-independent). A deadbeat command (reach g_req in ONE tick) on a
        // target that depends on the stale next-gimbal guess g_N1 is marginal at low airspeed and limit-cycles at
        // Nyquist; per-tick loop gain here is ~dt/tau, so the residual jitter vanishes as dt -> 0.
        let g_cmd_deg = g_req_deg;
        const _tauC = cfg.GIMBAL_CMD_TAU_S;
        if (Number.isFinite(_tauC) && _tauC > 0 &&
            (_sub.phase === "HOLD" || _sub.phase === "COASTnAoADAMP")) {
          if (!Number.isFinite(_sub.gCmdFilt)) _sub.gCmdFilt = g_N;   // seed from measured gimbal on entry
          _sub.gCmdFilt += (1 - Math.exp(-dt / _tauC)) * (g_req_deg - _sub.gCmdFilt);
          g_cmd_deg = _sub.gCmdFilt;
        } else {
          _sub.gCmdFilt = NaN;
        }
        const R_req = (g_cmd_deg - g_N) / dt;
        const MAX_RATE = gimbals[0].gimbalRateDegS;
        const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));

        _sub.lastGRate = R_cmd;
        _sub.lastGRadN = g_N;
        _sub.lastGReqDeg = g_req_deg;

        _send(_gimbalCmdMsg(g_cmd_deg, gimbals[0], dt, cfg.GIMBAL_TARGET));

        let refMax = 0;
        engines.forEach((e) => {
          if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax)
            refMax = e.maxMassFlowRate;
        });

        let thrFrac =
          Number.isFinite(cfg.THROTTLE_FRAC) && cfg.THROTTLE_FRAC > 0
            ? Math.min(1, cfg.THROTTLE_FRAC)
            : 1.0;

        const thrLow = Number.isFinite(cfg.THROTTLE_ALT_LOW_KM)
          ? cfg.THROTTLE_ALT_LOW_KM
          : Infinity;
        const thrHigh = Number.isFinite(cfg.THROTTLE_ALT_HIGH_KM)
          ? cfg.THROTTLE_ALT_HIGH_KM
          : -Infinity;
        if (altKm >= thrLow && altKm < thrHigh) {
          const lowFrac = Number.isFinite(cfg.THROTTLE_FRAC_LOW)
            ? cfg.THROTTLE_FRAC_LOW
            : thrFrac;
          thrFrac = Math.max(0, Math.min(1, lowFrac));
        }

        const targetFlow = refMax * thrFrac;
        if (
          _sub.lastThrottleSent === undefined ||
          Math.abs(targetFlow - _sub.lastThrottleSent) > 0.5
        ) {
          _send(Guidance.cmdSetAllThrottle(targetFlow));
          _sub.lastThrottleSent = targetFlow;
        }
      }

      // ---- MECO check — mirrors V2's ASCENT case MECO trigger ----
      function _checkMeco(snapshot) {
  const idx = _bodyIdx;
  const body = snapshot.bodies[idx];
  if (!body) return;
  
  const env = Derivation.getEnv();
  if (!env) return;
  
  const simT = snapshot.simTime;
  
  // Always compute apogee — diagnostic only (recorded in the MECO
  // result payload and status); it no longer gates the trigger.
  const r_m = Math.hypot(body.rx, body.ry);
  const ux_m = body.rx / r_m,
    uy_m = body.ry / r_m;
  const ex_m = body.ry / r_m,
    ey_m = -body.rx / r_m;
  const vr_m = body.vx * ux_m + body.vy * uy_m;
  const vt_m = body.vx * ex_m + body.vy * ey_m;
  const GM_m = env.GM_EARTH;
  const E_m = 0.5 * (vr_m * vr_m + vt_m * vt_m) - GM_m / r_m;
  let apogeeKm = Infinity;
  if (E_m < 0) {
    const a_m = -GM_m / (2 * E_m);
    const h_m = r_m * vt_m;
    const e_m = Math.sqrt(
      Math.max(0, 1 + (2 * E_m * h_m * h_m) / (GM_m * GM_m)),
    );
    apogeeKm = (a_m * (1 + e_m) - env.EARTH_RADIUS) / 1000;
  }
  _lastApogeeKm = apogeeKm;
  
  let shouldFire = false;
  let boosterFuelNow = null;
  
  {
    // Fuel-based trigger (sole trigger): fire MECO the first tick where the current
    // booster tank fuel minus the fuel that will still burn during
    // the shutdown spool-down reaches MECO_TARGET_BOOSTER_FUEL_KG.
    //
    // Spool-down burn model (matches applyActuatorRateLimitsForBody's
    // shutdown branch — a linear ramp from current mdot to zero over
    // shutdownDurationS seconds scaled by mdot/maxMFR):
    //   t_spool  = mdot_now * shutdownS / maxMFR
    //   burn     = mdot_now * t_spool / 2
    const engs = body.engines || [];
// Spool-down burn = integral of the mass-flow ramp from current
// value to zero. Each engine ramps independently at its own
// rate (maxMassFlowRate / shutdownDurationS), so compute
// per-engine and sum. All engines typically share the same
// thruster type → same rate → same t_spool for each; but the
// per-engine sum handles heterogeneous clusters too.
let spoolBurn = 0;
let mdot_now = 0;
engs.forEach((e) => {
  const mf = e.massFlowRate || 0;
  const mM = e.maxMassFlowRate || 0;
  mdot_now += mf;
  if (mf > 0 && mM > 0) {
    const sd = (Number.isFinite(e.shutdownDurationS) && e.shutdownDurationS > 0) ?
      e.shutdownDurationS : 1.2;
    const t = (mf * sd) / mM;
    spoolBurn += (mf * t) / 2;
  }
});
    
    boosterFuelNow = (Array.isArray(body.memberFuel) &&
        Number.isFinite(body.memberFuel[0])) ?
      body.memberFuel[0] : 0;
    
    const residual = boosterFuelNow - spoolBurn;
const target = Number.isFinite(_constants.MECO_TARGET_BOOSTER_FUEL_KG) ?
  _constants.MECO_TARGET_BOOSTER_FUEL_KG : 0;
// Fire when the projected post-shutdown residual (current fuel
// minus the shutdown spool integral) reaches the target. The
// spool integral already accounts for the full shutdown burn
// including the tick the command propagates, so no separate
// one-tick compensation is needed.
//

const dt = env.DT;

if (residual <= target) shouldFire = true;
  }
  
  if (shouldFire) {
    _mecoTriggered = true;
    _mecoSimTime = simT;
    _apogeeAtMeco_km = Number.isFinite(apogeeKm) ? apogeeKm : null;
    const localVert = Math.atan2(-body.rx, body.ry);
    _tiltAtMeco_deg = ((body.theta - localVert) * 180) / Math.PI;
    
    _send(Guidance.cmdSeparate());
    
    _done = true;
    _result = {
      mecoSimTime: _mecoSimTime,
      separationCommandedSimTime: _mecoSimTime,
      apogeeAtMeco_km: _apogeeAtMeco_km,
      tiltAtMeco_deg: _tiltAtMeco_deg,
      bodyIdx: _bodyIdx,
      initStackMass: _initStackMass,
      initFuelMass: _initFuelMass,
      boosterFuelAtMeco: boosterFuelNow,
    };
  }
}

      // ---- Public instance ----
      return {
        start(constants, bodyIdx, missionCtx) {
          if (!constants) throw new Error("ascent.start: constants required");
          if (!Number.isInteger(bodyIdx))
            throw new Error("ascent.start: bodyIdx required");
          _constants = JSON.parse(JSON.stringify(constants));
          _bodyIdx = bodyIdx;
          _missionCtx = missionCtx || {};
          _done = false;
          _result = null;
          _mecoTriggered = false;
          _lastApogeeKm = Infinity;
          _mecoSimTime = null;
          _apogeeAtMeco_km = null;
          _tiltAtMeco_deg = null;
          _captured = false;
          _primed = false;

          // Reset sub-machine state
          _sub.init = false;
          _sub.ticks = 0;
          _sub.phase = "PRE_COAST";
          _sub.phaseStart = 0;
          _sub.currentDeltaDeg = 0;
          _sub.lastLockedDeltaDeg = 0;
          _sub.lastThrottleSent = undefined;
          _sub.lastQ = null;
          _sub.lastDQ = 0;
          _sub.lastElapsed = 0;
          _sub.lastAltKm = 0;
          _sub.lastAoANowDeg = 0;
          _sub.lastAoANextDeg = 0;
          _sub.lastOmegaAoANow = 0;
          _sub.lastOmegaAoANext = 0;
          _sub.lastAlphaAoANow = 0;
          _sub.lastAlphaAoANext = 0;
          _sub.lastTauDesired = 0;
          _sub.lastTauDrag = 0;
          _sub.lastTauTarget = 0;
          _sub.lastTauDQ = 0;
          _sub.lastGRate = 0;
          _sub.lastGRadN = 0;
          _sub.lastGReqDeg = 0;

          // NOTE: cmdSetAllThrottle(Infinity) is NOT sent here. In V2 the
          // equivalent spool-up command fires on the FIRST tick (inside
          // _leoTickV2's init block, which calls _hTick.start()), i.e.
          // AFTER the first physicsStep. Sending it in start() would put
          // it before the first physicsStep, shifting the whole ascent by
          // one tick — enough to make MECO fire ~10 ticks early over 134s.
          _primed = false;
        },

        tick(snapshot) {
          if (_done) return;
          if (!snapshot || !snapshot.bodies || !snapshot.bodies[_bodyIdx])
            return;

          // First-tick spool-up — this is the exact point where V2's
          // _hTick.start() fires (from inside _leoTickV2's init block),
          // i.e. after the first physicsStep. Must match that timing.
          if (!_primed) {
            _primed = true;
            _send(Guidance.cmdSetAllThrottle(Infinity));
          }

          // One-time debug capture — mirrors V2's init block
          if (!_captured) {
            _captured = true;
            try {
              const initD = Derivation.derive(snapshot, _bodyIdx);
              if (initD && initD.massProps) {
                _initStackMass = initD.massProps.M;
                _initComH = initD.massProps.comY;
                _initI = initD.massProps.I;
              }
              const b = snapshot.bodies[_bodyIdx];
              _initFuelMass = b.fuelMass;
            } catch (e) {
              /* ignore */
            }
          }

          _tickSubMachine(snapshot);
          if (!_mecoTriggered) _checkMeco(snapshot);
        },

        stop() {
          _send(Guidance.cmdSetAllThrottle(0));
          _send(Guidance.cmdSetGimbalRate(0));
          _sub.init = false;
          _done = false;
          _primed = false;
        },

        isDone() {
          return _done;
        },

        getResult() {
          return _result ? Object.assign({}, _result) : null;
        },

        getStatus() {
          return {
            phase: _done ? "DONE" : "ASCENT",
            ascentPhase: _sub.phase,
            ticks: _sub.ticks,
            elapsed: _sub.lastElapsed,
            lockedDeltaDeg: _sub.currentDeltaDeg,
            altKm: _sub.lastAltKm,
            aoaDeg: _sub.lastAoANowDeg,
            aoaNextDeg: _sub.lastAoANextDeg,
            omegaAoANow: _sub.lastOmegaAoANow,
            omegaAoANext: _sub.lastOmegaAoANext,
            alphaAoANow: _sub.lastAlphaAoANow,
            alphaAoANext: _sub.lastAlphaAoANext,
            dQ: _sub.lastDQ,
            tauDQ: _sub.lastTauDQ,
            tauDesired: _sub.lastTauDesired,
            tauDrag: _sub.lastTauDrag,
            tauTarget: _sub.lastTauTarget,
            gRate: _sub.lastGRate,
            gRadN: _sub.lastGRadN,
            gReqDeg: _sub.lastGReqDeg,
            mecoTriggered: _mecoTriggered,
            mecoSimTime: _mecoSimTime,
            apogeeKm: _lastApogeeKm,
          };
        },

        getBodyIdx() {
          return _bodyIdx;
        },
        getState() {
  return {
    bodyIdx: _bodyIdx,
    constants: _constants ? JSON.parse(JSON.stringify(_constants)) : null,
    missionCtx: _missionCtx ? JSON.parse(JSON.stringify(_missionCtx)) : null,
    done: _done,
    result: _result ? JSON.parse(JSON.stringify(_result)) : null,
    sub: JSON.parse(JSON.stringify(_sub)),
    mecoTriggered: _mecoTriggered,
    lastApogeeKm: Number.isFinite(_lastApogeeKm) ? _lastApogeeKm : null,
    mecoSimTime: _mecoSimTime,
    apogeeAtMeco_km: _apogeeAtMeco_km,
    tiltAtMeco_deg: _tiltAtMeco_deg,
    initStackMass: _initStackMass,
    initComH: _initComH,
    initI: _initI,
    initFuelMass: _initFuelMass,
    captured: _captured,
    primed: _primed,
  };
},
setState(s) {
  if (!s) return;
  _bodyIdx = Number.isInteger(s.bodyIdx) ? s.bodyIdx : null;
  _constants = s.constants ? JSON.parse(JSON.stringify(s.constants)) : null;
  _missionCtx = s.missionCtx ? JSON.parse(JSON.stringify(s.missionCtx)) : {};
  _done = !!s.done;
  _result = s.result ? JSON.parse(JSON.stringify(s.result)) : null;
  if (s.sub) Object.assign(_sub, s.sub);
  _mecoTriggered = !!s.mecoTriggered;
  _lastApogeeKm = s.lastApogeeKm != null ? s.lastApogeeKm : Infinity;
  _mecoSimTime = s.mecoSimTime;
  _apogeeAtMeco_km = s.apogeeAtMeco_km;
  _tiltAtMeco_deg = s.tiltAtMeco_deg;
  _initStackMass = s.initStackMass;
  _initComH = s.initComH;
  _initI = s.initI;
  _initFuelMass = s.initFuelMass;
  _captured = !!s.captured;
  _primed = !!s.primed;
},
        getConstants() {
          return _constants ? JSON.parse(JSON.stringify(_constants)) : null;
        },
        setConstants(patch) {
          if (_constants && patch) Object.assign(_constants, patch);
        },
      };
    },
  },

  // ==========================================================================
  // INSERTION — post-separation stage → payload deployed
  //
  // Runs the upper-stage burn, coasts, circularizes, releases the payload,
  // and ends once the released payload body has spawned and physically
  // cleared the stage. Multi-payload-aware via missionCtx.expectedPayloadCount
  // (defaults to 1).
  //
  // Body-locked to the stage index (mission code resolves it after split).
  // ==========================================================================
  insertion: {
    name: "insertion",
    displayName: "Orbital Insertion",
    description:
      "Post-separation stage → target orbit → payload release. Ends once every expected payload body has spawned and cleared the stage.",
    defaultConstants: {
    GIMBAL_TARGET: "all",
  STAGE_BURN_CUTOFF_MARGIN_MPS: 0.0,
// STAGE_BURN AoA PID gains. AoA entering STAGE_BURN is ~1° from
  // gravity-gradient drift during the 10m axial wait. The target is seeded
  // with the current AoA and ramped straight to the bias (no zeroing phase).
  STAGE_BURN_AOA_KP: 4.0,
  STAGE_BURN_AOA_KD: 4.0,
  // Integral gain (1/s^3 on AoA) + bias ramp rate. Fixed constants, NOT in the
  // tunable key list (not part of retuning). KI < KP*KD for stability.
  STAGE_BURN_AOA_KI: 1.0,
  STAGE_BURN_AOA_BIAS_RATE_DEG_S: 0.5,
  // Target AoA offset from velocity during STAGE_BURN (deg). Zero =
  // nose perfectly aligned (fastest tilt evolution). Small positive
  // or negative value introduces a perpendicular thrust component
  // that changes the natural tilt growth rate.
  STAGE_BURN_AOA_BIAS_DEG: 0.827,
    COAST_TARGET_TILT_DEG: -90,
      COAST_ROTATE_TOL_DEG: 0.5,
      COAST_ROTATE_OMEGA_TOL: 0.02,
      COAST_ROTATE_TIMEOUT_S: 240,
      COAST_WAIT_BEFORE_APOGEE_S: 90,
      CIRC_TRIGGER_LEAD_S: 5.525,
      CIRC_DECAY_FRAC: 0.05,
      // Rotate phases (ROTATE / ROTATE_2 / CIRCULARIZE / DONE) keep the same
      // gains — tuning there is fine and shouldn't be touched.
      CIRC_ATT_KP: 0.5,
      CIRC_ATT_KD: 4.0,
      // Hold phases (COAST_HOLD, COAST_HOLD_2) use tighter PID:
      //   - Higher KP/KD: faster transient (τ = KD/KP ≈ 1 s, ~3τ settle in 5 s peak budget)
      //   - KI: eliminates the steady-state error a PD leaves behind when the target
      //     apside direction drifts at ~0.066°/s. Kick direction = attitude at deploy,
      //     so any residual here becomes apo/peri ecc in the payload orbit.
      // Data-driven: TORQUE-DIAG showed tau_desired ~ -16 N·m at
      // attErr=0.055 deg — because KP+KD+KI sum ≈ 0. KP wanted +0.0051,
      // KD gave -0.0020 (over-rotation), KI gave -0.0031 (integral wound
      // wrong from earlier transient). Net nearly zero -> slow convergence.
      // Fix: KP 5->15 dominates; KI 2->0 (redundant with omegaTgt FF,
      // which already handles moving-target steady-state; integral was
      // actively fighting due to windup).
      COAST_HOLD_ATT_KP: 15.0,
      COAST_HOLD_ATT_KD: 5.0,
      COAST_HOLD_ATT_KI: 0.0,
      COAST_BURN_MULTIPLIER: 4.0,
      // Target orbit is now defined by two apsides. The insertion block
      // internally derives: apogee = max(apside1, apside2),
      // perigee = min(apside1, apside2). Equal values → circular orbit
      // (identical to the old single-altitude behaviour).
      //   Circular target:    APSIDE1 = APSIDE2 = 320
      //   Elliptical target:  APSIDE1 = 320, APSIDE2 = 250  (apo=320, peri=250)
      TARGET_APSIDE1_ALT_KM: 320,
      TARGET_APSIDE2_ALT_KM: 320,
      // Minimum distance from stage to a released payload body for it to
      // count as "cleared". Small enough to fire quickly after release,
      // large enough to skip transient spawn-overlap frames.
      PAYLOAD_CLEAR_DIST_M: 20,
      // Fail-safe: if payload never confirms (spawn stuck, marker missing),
      // insertion ends after this many seconds anyway so the mission can
      // continue.
      PAYLOAD_CONFIRM_TIMEOUT_S: 120,
      // COAST_HOLD_2 axial trim: drive apogee dv gap (= v_circ(rapo) - v_apo)
      // to the eject kick. Net-force RCS only, no floor duty.
      COAST_HOLD_2_TRIM_TOL_MPS: 0.0001,
      COAST_HOLD_2_TRIM_FAR_MPS: 0.01,
    },
    importantFields: [],
    createInstance: function () {
      // ---- Instance state ----
      let _constants = null;
      let _bodyIdx = null;
      let _missionCtx = null;
      let _done = false;
      let _result = null;

      // Derived target apogee/perigee (km ASL). Computed once in start()
      // from TARGET_APSIDE1_ALT_KM / TARGET_APSIDE2_ALT_KM (higher = apogee,
      // lower = perigee). Self-healing: if only one apside is set, it is
      // mirrored to the other (auto circular).
      let _targetApoKm = 320;
      let _targetPeriKm = 320;

      // Sub-machine state — mirrors V2's _leoStateV2 slice relevant to
      // STAGE_BURN..COAST_HOLD_2 + DONE payload-monitor.
      const _st = {
    init: false,
    ticks: 0,
    phase: "STAGE_BURN",
    phaseStart: 0,
    // STAGE_BURN
    stageBurnSpooled: false,
    stageBurnAoaSeeded: false,
    sbBiasEff: NaN,
    sbAoaInt: 0,
    lastApogeeKm: 0,
    lastPerigeeKm: null,
        // RCS_BOOST
        _prevApogeeErr: null,
        // COAST_ROTATE / COAST_WAIT / COAST_HOLD / CIRCULARIZE
        coastTargetThetaInertial: null,
        coastRotateStartTilt: null,
        coastRotateMid: null,
        coastTBurnPractical: 0,
        coastVOrbital: 0,
        _prevVr: null,
        coastRotateSecondPass: false,
        coastRotateEndDeltaV: null,
        coastRotateEndTRem: null,
        // CIRCULARIZE
        circCurrentV: 0,
        circTargetV: 0,
        circErr: 0,
        circAchieved: false,
        // COAST_ROTATE_2 / COAST_HOLD_2
        coast2TargetThetaInertial: null,
        coast2RotateStartTilt: null,
        coast2RotateMid: null,
        _prevVr2: null,
        coast2TargetApside: 'apo',
        // Hold-phase attitude PID integrators + arming flags.
        // Integrators reset once per HOLD entry (armed=false → armed=true on
        // first PID tick); no windup during ROTATE transit.
        hold1ThetaInt: 0,
        hold1IntArmed: false,
        hold2ThetaInt: 0,
        hold2IntArmed: false,
        hold2LastRcsTorque: 0,
        hold2PrevThetaApoLive: null,
        hold2PrevT: null,
        hold2OmegaTgt: 0,
          // DONE
  deployCommandSimTime: null,
    payloadCleared: false,
    // Cached during tick — startupS + CIRC_TRIGGER_LEAD_S. Read by
    // the direction HUD to display how much earlier the circ burn
    // starts relative to apogee.
    lastCircTriggerLeadS: 0,
  };

      // Payload-monitor state
      let _payloadBodyCountAtDeploy = 0;
      let _deployCmdTick = -1;

      function _send(cmd) {
        if (!cmd) return;
        if (cmd.targetBodyIdx === undefined) cmd.targetBodyIdx = _bodyIdx;
        Guidance.send(cmd);
      }

      function _wrapPi(x) {
        while (x > Math.PI) x -= 2 * Math.PI;
        while (x < -Math.PI) x += 2 * Math.PI;
        return x;
      }

      // ---- Local copy of _hTimeToApogee (guidance.js keeps its own
      // private; blocks stay self-contained) ----
      function _timeToApogee(r, vr, vt, GM) {
        if (!(r > 0)) return Infinity;
        const E = 0.5 * (vr * vr + vt * vt) - GM / r;
        if (E >= 0) return Infinity;
        const a = -GM / (2 * E);
        const h = r * vt;
        const eSq = 1 + (2 * E * h * h) / (GM * GM);
        const e = Math.sqrt(Math.max(0, eSq));
        if (e < 1e-9) return Math.PI * Math.sqrt((a * a * a) / GM);
        const cosE = (1 - r / a) / e;
        const sinE = (r * vr) / (e * Math.sqrt(GM * a));
        let E_an = Math.atan2(sinE, cosE);
        if (E_an < 0) E_an += 2 * Math.PI;
        const M = E_an - e * Math.sin(E_an);
        const n = Math.sqrt(GM / (a * a * a));
        if (M < Math.PI) return (Math.PI - M) / n;
        return (3 * Math.PI - M) / n;
      }

      // Time to NEXT perigee (parallel to _timeToApogee). Perigee at M=0
      // (and M=2π), so t_peri = (2π - M)/n.
      function _timeToPerigee(r, vr, vt, GM) {
        if (!(r > 0)) return Infinity;
        const E = 0.5 * (vr * vr + vt * vt) - GM / r;
        if (E >= 0) return Infinity;
        const a = -GM / (2 * E);
        const h = r * vt;
        const eSq = 1 + (2 * E * h * h) / (GM * GM);
        const e = Math.sqrt(Math.max(0, eSq));
        if (e < 1e-9) return Math.PI * Math.sqrt((a * a * a) / GM);
        const cosE = (1 - r / a) / e;
        const sinE = (r * vr) / (e * Math.sqrt(GM * a));
        let E_an = Math.atan2(sinE, cosE);
        if (E_an < 0) E_an += 2 * Math.PI;
        const M = E_an - e * Math.sin(E_an);
        const n = Math.sqrt(GM / (a * a * a));
        return (2 * Math.PI - M) / n;
      }

      // ---- Payload monitor ----
      // Counts payload bodies spawned AFTER the deploy command tick, and
      // checks each is physically clear of the stage.
      function _countClearedPayloads(snapshot) {
        let cleared = 0;
        for (let i = 0; i < snapshot.bodies.length; i++) {
          if (i === _bodyIdx) continue;
          const b = snapshot.bodies[i];
          if (!b || !b.payloadBody) continue;
          const stage = snapshot.bodies[_bodyIdx];
          if (!stage) continue;
          const dx = b.rx - stage.rx;
          const dy = b.ry - stage.ry;
          const d = Math.hypot(dx, dy);
          if (d >= _constants.PAYLOAD_CLEAR_DIST_M) cleared++;
        }
        return cleared;
      }

      // Merge two {pod:{up,dn,lat}} RCS duty maps (simple sum + clamp).
      function _mergeRcsDuties(a, b) {
        if (!a && !b) return null;
        const out = {};
        const pods = new Set();
        if (a) Object.keys(a).forEach(function (p) { pods.add(p); });
        if (b) Object.keys(b).forEach(function (p) { pods.add(p); });
        pods.forEach(function (pod) {
          const da = (a && a[pod]) || { up: 0, dn: 0, lat: 0 };
          const db = (b && b[pod]) || { up: 0, dn: 0, lat: 0 };
          const up = Math.min(1, (da.up || 0) + (db.up || 0));
          const dn = Math.min(1, (da.dn || 0) + (db.dn || 0));
          const lat = Math.min(1, (da.lat || 0) + (db.lat || 0));
          if (up > 0 || dn > 0 || lat > 0) out[pod] = { up: up, dn: dn, lat: lat };
        });
        return Object.keys(out).length ? out : null;
      }

      // ---- Main tick ----
      function _tick(snapshot) {
        _st.ticks++;
        const idx = _bodyIdx;
        const body = snapshot.bodies[idx];
        if (!body) return;
        const simT = snapshot.simTime;

        if (!_st.init) {
          _st.init = true;
          _st.phase = "STAGE_BURN";
          _st.phaseStart = simT;
        }

        // ---- Derive current + next-tick state (mirrors V2) ----
        const d = Derivation.derive(snapshot, idx);
        if (!d || !d.massProps) return;
        const env = Derivation.getEnv();
        const dt = env.DT;
        const M_d = d.massProps.M;

        let dNext = null;
        if (M_d > 0) {
          const cosT = Math.cos(d.theta),
            sinT = Math.sin(d.theta);
          const thrustIx = d.thrustBodyX * cosT - d.thrustBodyY * sinT;
          const thrustIy = d.thrustBodyX * sinT + d.thrustBodyY * cosT;
          const aIx = d.gVecX + (thrustIx + d.dragVecX) / M_d;
          const aIy = d.gVecY + (thrustIy + d.dragVecY) / M_d;
          const sloshNow = body.slosh || { offset: 0, velocity: 0 };
          dNext = Derivation.deriveForState(snapshot, idx, {
            rx: d.rx + d.vx * dt,
            ry: d.ry + d.vy * dt,
            vx: d.vx + aIx * dt,
            vy: d.vy + aIy * dt,
            theta: d.theta + d.omega * dt + 0.5 * d.alphaAng * dt * dt,
            omega: d.omega + d.alphaAng * dt,
            slosh: {
              offset: (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt,
              velocity: sloshNow.velocity || 0,
            },
          });
        }

        const cfg = _constants;

        switch (_st.phase) {
          // ==========================================================
          case "STAGE_BURN": {
            if (!dNext || !dNext.massProps) break;
            const gimbals = (body.engines || []).filter((e) => e.gimbal);
            if (!gimbals.length) {
              _st.phase = "DONE";
              _st.phaseStart = simT;
              break;
            }

            _send(Guidance.cmdSetAllThrottle(Infinity));

            const I_next = dNext.massProps.I;

// ---- Spool wait ----
// Hold gimbal rate at 0 and skip attitude control until every engine
// has reached >= 99% of its own max mass flow rate. Running attitude
// control during engine startup transient just fights spool noise.
if (!_st.stageBurnSpooled) {
  let allFull = true;
  const engsForSpool = body.engines || [];
  for (let ei = 0; ei < engsForSpool.length; ei++) {
    const e = engsForSpool[ei];
    const maxF = Number.isFinite(e.maxMassFlowRate) ? e.maxMassFlowRate : 0;
    const cur = Number.isFinite(e.massFlowRate) ? e.massFlowRate : 0;
    if (maxF > 0 && cur < maxF * 0.99) { allFull = false; break; }
  }
  if (!allFull) {
    _send(Guidance.cmdSetGimbalRate(0));
    break;
  }
  _st.stageBurnSpooled = true;
}

// ---- Attitude torque ----
// PID on AoA. AoA entering STAGE_BURN is ~1° from gravity-gradient drift
// during the 10m axial wait. On the first control tick the bias target is
// seeded with the current AoA (zero error => no torque spike) and then
// ramped straight to STAGE_BURN_AOA_BIAS_DEG.
let tau_desired = null;
const aoaDegNow = Number.isFinite(dNext.alphaDeg) ? dNext.alphaDeg : 0;
// PID integrator (conditional integration + clamp).
const SB_KI = Number.isFinite(cfg.STAGE_BURN_AOA_KI) ? cfg.STAGE_BURN_AOA_KI : 1.0;
const SB_BIAS_RATE = Number.isFinite(cfg.STAGE_BURN_AOA_BIAS_RATE_DEG_S) ? cfg.STAGE_BURN_AOA_BIAS_RATE_DEG_S : 0.5;
const SB_I_GATE_RAD = 0.05 * Math.PI / 180;
const SB_INT_MAX = 0.005; // rad*s  => max KI*int = 5e-3 rad/s^2 at KI=1
if (!Number.isFinite(_st.sbAoaInt)) _st.sbAoaInt = 0;
// Seed on first tick (see above); afterwards ramp toward the bias at SB_BIAS_RATE.
if (!_st.stageBurnAoaSeeded) {
  _st.stageBurnAoaSeeded = true;
  _st.sbBiasEff = aoaDegNow;
  _st.sbAoaInt = 0;
}

if (tau_desired === null) {
  {
  // PID-on-AoA, running continuously for the
  // whole STAGE_BURN (single control law — no fixed-tilt lock mode).
  // Using AoA's own rate (ω_body + P/r²)
  // rather than raw ω_body, so the controller sees the true attitude
  // error against the velocity vector.
  //
  // AOA_BIAS_DEG shifts the target AoA away from zero. Nonzero bias
  // means the nose is held slightly off-aligned with the velocity
  // vector, giving thrust a small perpendicular component that
  // slows (or accelerates, depending on sign) the natural gravity-
  // turn tilt evolution during the burn.
  const cosT2 = Math.cos(dNext.theta);
  const sinT2 = Math.sin(dNext.theta);
  const u2 = dNext.relVx * cosT2 + dNext.relVy * sinT2;
  const v2 = -dNext.relVx * sinT2 + dNext.relVy * cosT2;
  const tIx2 = dNext.thrustBodyX * cosT2 - dNext.thrustBodyY * sinT2;
  const tIy2 = dNext.thrustBodyX * sinT2 + dNext.thrustBodyY * cosT2;
  const Md2 = dNext.massProps.M;
  const aIx2 = dNext.gVecX + (tIx2 + dNext.dragVecX) / Md2;
  const aIy2 = dNext.gVecY + (tIy2 + dNext.dragVecY) / Md2;
  const ax2 = aIx2 * cosT2 + aIy2 * sinT2;
  const ay2 = -aIx2 * sinT2 + aIy2 * cosT2;
  const rr2 = u2 * u2 + v2 * v2;
  const P2 = v2 * ax2 - u2 * ay2;
  const omegaAoA2 = (rr2 > 1e-6) ? (dNext.omega + P2 / rr2) : dNext.omega;
  const aoaRad2 = aoaDegNow * Math.PI / 180;
  // Bias is ramped (rate-limited) from 0 to its target so the target never steps.
  const biasTgt = Number.isFinite(cfg.STAGE_BURN_AOA_BIAS_DEG) ? cfg.STAGE_BURN_AOA_BIAS_DEG : 0;
  if (!Number.isFinite(_st.sbBiasEff)) _st.sbBiasEff = 0;
  const _biasStepMax = SB_BIAS_RATE * dt;
  _st.sbBiasEff += Math.max(-_biasStepMax, Math.min(_biasStepMax, biasTgt - _st.sbBiasEff));
  const biasRad2 = _st.sbBiasEff * Math.PI / 180;
  const aoaErr2 = aoaRad2 - biasRad2;
  if (Math.abs(aoaErr2) < SB_I_GATE_RAD) {
    _st.sbAoaInt = Math.max(-SB_INT_MAX, Math.min(SB_INT_MAX, _st.sbAoaInt + aoaErr2 * dt));
  }
  const kp2 = cfg.STAGE_BURN_AOA_KP;
  const kd2 = cfg.STAGE_BURN_AOA_KD;
  tau_desired = -I_next * (kp2 * aoaErr2 + kd2 * omegaAoA2 + SB_KI * _st.sbAoaInt);
}
}
const tau_target = tau_desired - dNext.torqueEnvironmental;

            const g_N = gimbals[0].gimbalDeg || 0;
            const comX1 = dNext.massProps.comX;
            const comY1 = dNext.massProps.comY;
            let A_g = 0,
              B_g = 0;
            gimbals.forEach((e) => {
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
              const w1 = _wrapPi(Math.asin(ratio) - phi);
              const w2 = _wrapPi(Math.PI - Math.asin(ratio) - phi);
              g_req_rad = Math.abs(w1) <= Math.abs(w2) ? w1 : w2;
            }
            let g_req_deg = (g_req_rad * 180) / Math.PI;
            const _gMax = gimbals[0].gimbalMaxDeg;
            if (Math.abs(g_req_deg) > _gMax) {
              g_req_deg = Math.sign(g_req_deg) * _gMax;
            }
            _send(_gimbalCmdMsg(g_req_deg, gimbals[0], dt));

            const r_ap = Math.hypot(body.rx, body.ry);
            const ux_ap = body.rx / r_ap,
              uy_ap = body.ry / r_ap;
            const ex_ap = body.ry / r_ap,
              ey_ap = -body.rx / r_ap;
            const vr_ap = body.vx * ux_ap + body.vy * uy_ap;
            const vt_ap = body.vx * ex_ap + body.vy * ey_ap;
            const GM_ap = env.GM_EARTH;
            const R_ap = env.EARTH_RADIUS;
            const E_ap = 0.5 * (vr_ap * vr_ap + vt_ap * vt_ap) - GM_ap / r_ap;
            let apogeeKm = Infinity;
            if (E_ap < 0) {
              const a_ap = -GM_ap / (2 * E_ap);
              const h_ap = r_ap * vt_ap;
              const e_ap = Math.sqrt(
                Math.max(0, 1 + (2 * E_ap * h_ap * h_ap) / (GM_ap * GM_ap)),
              );
              apogeeKm = (a_ap * (1 + e_ap) - R_ap) / 1000;
            }
            _st.lastApogeeKm = apogeeKm;

            const h_sb = r_ap * vt_ap;
            const p_sb = (h_sb * h_sb) / GM_ap;
            const e_sb = Math.sqrt(
              Math.max(0, 1 + (2 * E_ap * h_sb * h_sb) / (GM_ap * GM_ap)),
            );
            const perigeeKm_sb = (p_sb / (1 + e_sb) - R_ap) / 1000;
            _st.lastPerigeeKm = perigeeKm_sb;

            const spoolS = body.engines[0].shutdownDurationS;
            let mdot_now_sb = 0,
              maxMFR_sb = 0;
            (body.engines || []).forEach((e) => {
              mdot_now_sb += e.massFlowRate || 0;
              if (
                Number.isFinite(e.maxMassFlowRate) &&
                e.maxMassFlowRate > maxMFR_sb
              ) {
                maxMFR_sb = e.maxMassFlowRate;
              }
            });
            const t_spool_actual =
              maxMFR_sb > 0 && mdot_now_sb > 0
                ? (mdot_now_sb * spoolS) / maxMFR_sb
                : spoolS;
            const a_avg_sb =
              ((mdot_now_sb / 2) * body.engines[0].Ve) /
              Math.max(1, dNext.massProps.M);
            const dv_spool_sb = a_avg_sb * t_spool_actual;
            const dv_with_margin =
              dv_spool_sb + cfg.STAGE_BURN_CUTOFF_MARGIN_MPS;

            let apogeePredicted_margin = apogeeKm;
            if (dv_with_margin > 0) {
              const gimbalRad = ((gimbals[0].gimbalDeg || 0) * Math.PI) / 180;
              const thetaThrust = body.theta - gimbalRad;
              const thrustDirX = -Math.sin(thetaThrust);
              const thrustDirY = Math.cos(thetaThrust);
              const vx_pred = body.vx + thrustDirX * dv_with_margin;
              const vy_pred = body.vy + thrustDirY * dv_with_margin;
              const v2_pred = vx_pred * vx_pred + vy_pred * vy_pred;
              const E_pred = 0.5 * v2_pred - GM_ap / r_ap;
              if (E_pred < 0) {
                const a_pred = -GM_ap / (2 * E_pred);
                const h_pred = body.rx * vy_pred - body.ry * vx_pred;
                const e_pred = Math.sqrt(
                  Math.max(
                    0,
                    1 + (2 * E_pred * h_pred * h_pred) / (GM_ap * GM_ap),
                  ),
                );
                apogeePredicted_margin = (a_pred * (1 + e_pred) - R_ap) / 1000;
              }
            }

            if (
              apogeeKm >= _targetPeriKm ||
              apogeePredicted_margin >= _targetPeriKm
            ) {
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              _st.phase = "RCS_BOOST";
              _st.phaseStart = simT;
              break;
            }
            break;
          }

          // ==========================================================
          case "RCS_BOOST": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            const r_b = Math.hypot(body.rx, body.ry);
            const ux_b = body.rx / r_b,
              uy_b = body.ry / r_b;
            const ex_b = body.ry / r_b,
              ey_b = -body.rx / r_b;
            const vr_b = body.vx * ux_b + body.vy * uy_b;
            const vt_b = body.vx * ex_b + body.vy * ey_b;
            const GM_b = env.GM_EARTH;
            const R_b = env.EARTH_RADIUS;
            const E_b = 0.5 * (vr_b * vr_b + vt_b * vt_b) - GM_b / r_b;
            let apogeeKm_b = Infinity;
            if (E_b < 0) {
              const a_b = -GM_b / (2 * E_b);
              const h_b = r_b * vt_b;
              const e_b = Math.sqrt(
                Math.max(0, 1 + (2 * E_b * h_b * h_b) / (GM_b * GM_b)),
              );
              apogeeKm_b = (a_b * (1 + e_b) - R_b) / 1000;
            }
            _st.lastApogeeKm = apogeeKm_b;

            const h_b2 = r_b * vt_b;
            const p_b = (h_b2 * h_b2) / GM_b;
            const e_b2 = Math.sqrt(
              Math.max(0, 1 + (2 * E_b * h_b2 * h_b2) / (GM_b * GM_b)),
            );
            _st.lastPerigeeKm = (p_b / (1 + e_b2) - R_b) / 1000;

            const engineStillFiring = (body.engines || []).some(
              (e) => (e.massFlowRate || 0) > 1,
            );
            if (engineStillFiring) {
              _send(Guidance.cmdRcsDuty(null, idx));
              break;
            }

            const errKm = apogeeKm_b - _targetPeriKm;
            const prevErr = _st._prevApogeeErr;
            _st._prevApogeeErr = errKm;

            const crossed =
              prevErr !== null &&
              prevErr !== undefined &&
              ((prevErr < 0 && errKm >= 0) || (prevErr > 0 && errKm <= 0));

            if (crossed) {
              _send(Guidance.cmdRcsDuty(null, idx));

              const r_c = r_b,
                vr_c = vr_b,
                vt_c = vt_b;
              const GM_c = GM_b,
                R_c = R_b,
                E_c = E_b;
              const a_c = E_c < 0 ? -GM_c / (2 * E_c) : r_c;
              const h_c = r_b * vt_c;
              const e_c = e_b2;
              const r_apo = a_c > 0 ? a_c * (1 + e_c) : r_c;
              const v_apo = r_apo > 0 ? Math.abs(h_c) / r_apo : 0;
              // Target velocity at apogee for the ELLIPTICAL orbit whose
              // apogee is at _targetApoKm and perigee at _targetPeriKm.
              // vis-viva: v_a = sqrt(GM·(2/r_a − 1/a)), a = (r_a + r_p)/2.
              // Reduces to sqrt(GM/r) when apo==peri (circular target).
              const r_a_tgt = R_c + _targetApoKm * 1000;
              const r_p_tgt = R_c + _targetPeriKm * 1000;
              const a_tgt = (r_a_tgt + r_p_tgt) / 2;
              // PERI-TARGET STRATEGY: burn at near-side (r ≈ target_peri),
              // prograde, raises far side to target_apo. Velocity target
              // = v at PERI position of target orbit (vis-viva 2/r_p - 1/a).
              const v_orb = Math.sqrt(GM_c * (2 / r_p_tgt - 1 / a_tgt));
              const dv_needed = Math.max(0, v_orb - v_apo);

              const v2_c = body.vx * body.vx + body.vy * body.vy;
              const rv_c = body.rx * body.vx + body.ry * body.vy;
              const ex_ecc =
                ((v2_c - GM_c / r_c) * body.rx - rv_c * body.vx) / GM_c;
              const ey_ecc =
                ((v2_c - GM_c / r_c) * body.ry - rv_c * body.vy) / GM_c;
              const e_mag = Math.hypot(ex_ecc, ey_ecc);
              let thetaApo;
              if (e_mag > 1e-6) {
                const phiApo = Math.atan2(-ex_ecc, -ey_ecc);
                const rx_apo = r_apo * Math.sin(phiApo);
                const ry_apo = r_apo * Math.cos(phiApo);
                const sDir = vt_c >= 0 ? 1 : -1;
                thetaApo = Math.atan2(-sDir * ry_apo, -sDir * rx_apo);
              } else {
                thetaApo = Math.atan2(-body.vx, body.vy);
              }
              _st.coastTargetThetaInertial = thetaApo;

              const m_now = dNext.massProps.M;
              const ve_engine = body.engines[0].Ve;
              const m_final = m_now / Math.exp(dv_needed / ve_engine);
              const fuel_needed = Math.max(0, m_now - m_final);
              const refMax_c = body.engines[0].maxMassFlowRate;
              const t_burn_ideal = refMax_c > 0 ? fuel_needed / refMax_c : 0;
              _st.coastTBurnPractical =
                t_burn_ideal * cfg.COAST_BURN_MULTIPLIER;
              _st.coastVOrbital = v_orb;

              _st.phase = "COAST_ROTATE";
              _st.phaseStart = simT;
              _st.coastRotateStartTilt = null;
              _st.coastRotateMid = null;
              break;
            }

            const direction = errKm > 0 ? "dn" : "up";
            const duties = GuideRCS.postSeparationAxialDuty(
              snapshot,
              idx,
              direction,
            );
            if (duties) _send(Guidance.cmdRcsDuty(duties, idx));
            else _send(Guidance.cmdRcsDuty(null, idx));
            break;
          }

          // ==========================================================
          case "COAST_ROTATE": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            const elapsed = simT - _st.phaseStart;
            if (elapsed >= cfg.COAST_ROTATE_TIMEOUT_S) {
              _send(Guidance.cmdRcsDuty(null, idx));
              if (_st.coastRotateSecondPass) {
                _st.phase = "COAST_HOLD";
                _st.phaseStart = simT;
              } else {
                _st.phase = "COAST_WAIT";
                _st.phaseStart = simT;
                _st.coastRotateSecondPass = true;
              }
              break;
            }

            const targetThetaRad = _st.coastTargetThetaInertial;
            if (targetThetaRad === null || targetThetaRad === undefined) {
              _send(Guidance.cmdRcsDuty(null, idx));
              if (_st.coastRotateSecondPass) {
                _st.phase = "COAST_HOLD";
                _st.phaseStart = simT;
              } else {
                _st.phase = "COAST_WAIT";
                _st.phaseStart = simT;
                _st.coastRotateSecondPass = true;
              }
              break;
            }

            const thetaErr = _wrapPi(body.theta - targetThetaRad);
            const omegaRel = body.omega;

            if (
              Math.abs(thetaErr) < (cfg.COAST_ROTATE_TOL_DEG * Math.PI) / 180 &&
              Math.abs(omegaRel) < cfg.COAST_ROTATE_OMEGA_TOL
            ) {
              _send(Guidance.cmdRcsDuty(null, idx));
              if (!_st.coastRotateSecondPass) {
                const r_cap = Math.hypot(body.rx, body.ry) || 1;
                const ux_cap = body.rx / r_cap,
                  uy_cap = body.ry / r_cap;
                const ex_cap = body.ry / r_cap,
                  ey_cap = -body.rx / r_cap;
                const vr_cap = body.vx * ux_cap + body.vy * uy_cap;
                const vt_cap = body.vx * ex_cap + body.vy * ey_cap;
                const GM_cap = env.GM_EARTH;
                _st.coastRotateEndTRem = _timeToApogee(
                  r_cap,
                  vr_cap,
                  vt_cap,
                  GM_cap,
                );
                const E_cap =
                  0.5 * (vr_cap * vr_cap + vt_cap * vt_cap) - GM_cap / r_cap;
                if (E_cap < 0) {
                  const a_cap = -GM_cap / (2 * E_cap);
                  const h_cap = r_cap * vt_cap;
                  const eSq_cap =
                    1 + (2 * E_cap * h_cap * h_cap) / (GM_cap * GM_cap);
                  const e_cap = Math.sqrt(Math.max(0, eSq_cap));
                  const rApo_cap = a_cap * (1 + e_cap);
                  const vApo_cap = Math.abs(h_cap) / rApo_cap;
                  // Elliptical target velocity at apogee (circular when
                  // apo==peri). Same vis-viva form as RCS_BOOST above.
                  const r_a_tgt_cap = env.EARTH_RADIUS + _targetApoKm * 1000;
                  const r_p_tgt_cap = env.EARTH_RADIUS + _targetPeriKm * 1000;
                  const a_tgt_cap = (r_a_tgt_cap + r_p_tgt_cap) / 2;
                  // PERI-TARGET STRATEGY: v at PERI position of target orbit.
                  const vOrb_cap = Math.sqrt(GM_cap * (2 / r_p_tgt_cap - 1 / a_tgt_cap));
                  _st.coastRotateEndDeltaV = Math.max(0, vOrb_cap - vApo_cap);
                } else {
                  _st.coastRotateEndDeltaV = null;
                }
              }
              if (_st.coastRotateSecondPass) {
                _st.phase = "COAST_HOLD";
                _st.phaseStart = simT;
              } else {
                _st.phase = "COAST_WAIT";
                _st.phaseStart = simT;
                _st.coastRotateSecondPass = true;
              }
              break;
            }

            const I_next = dNext && dNext.massProps ? dNext.massProps.I : 0;
            if (!(I_next > 0)) {
              _send(Guidance.cmdRcsDuty(null, idx));
              break;
            }
            const tau_desired =
              -I_next *
              (cfg.CIRC_ATT_KP * thetaErr + cfg.CIRC_ATT_KD * omegaRel);

            const result = GuideRCS.targetTorqueRcsNoNetForce(
              snapshot,
              tau_desired,
              idx,
            );
            if (result && result.fires.length)
              _send(Guidance.cmdRcsDuty(result.duties, idx));
            else _send(Guidance.cmdRcsDuty(null, idx));
            break;
          }

          // ==========================================================
          case "COAST_WAIT": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));
            _send(Guidance.cmdRcsDuty(null, idx));

            const r_c = Math.hypot(body.rx, body.ry);
            const ux_c = body.rx / r_c,
              uy_c = body.ry / r_c;
            const ex_c = body.ry / r_c,
              ey_c = -body.rx / r_c;
            const vr_c = body.vx * ux_c + body.vy * uy_c;
            const vt_c = body.vx * ex_c + body.vy * ey_c;
            const t_rem = _timeToApogee(r_c, vr_c, vt_c, env.GM_EARTH);

            if (t_rem <= cfg.COAST_WAIT_BEFORE_APOGEE_S) {
              _st.phase = "COAST_ROTATE";
              _st.phaseStart = simT;
              _st.coastRotateStartTilt = null;
              _st.coastRotateMid = null;
              break;
            }
            break;
          }

          // ==========================================================
          case "COAST_HOLD": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            const r_c = Math.hypot(body.rx, body.ry);
            const ux_c = body.rx / r_c,
              uy_c = body.ry / r_c;
            const ex_c = body.ry / r_c,
              ey_c = -body.rx / r_c;
            const vr_c = body.vx * ux_c + body.vy * uy_c;
            const vt_c = body.vx * ex_c + body.vy * ey_c;
            const t_rem = _timeToApogee(r_c, vr_c, vt_c, env.GM_EARTH);

            const prevVr = _st._prevVr;
            _st._prevVr = vr_c;
            const apogeePeak =
              prevVr !== null &&
              prevVr !== undefined &&
              prevVr > 0 &&
              vr_c <= 0;

            const startupS = body.engines[0].startupDurationS;
            const triggerWindowS = startupS + cfg.CIRC_TRIGGER_LEAD_S;

            if (t_rem <= triggerWindowS || apogeePeak) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "CIRCULARIZE";
              _st.phaseStart = simT;
              break;
            }

            if (
              dNext &&
              dNext.massProps &&
              _st.coastTargetThetaInertial !== null
            ) {
              const I_next = dNext.massProps.I;
              const thetaErr = _wrapPi(
                body.theta - _st.coastTargetThetaInertial,
              );
              // PID on inertial theta. Integrator eliminates the steady-state
              // lag that PD leaves when the target drifts (apside direction
              // rotates ~0.066 deg/s). Arming flag ensures a fresh integral
              // each HOLD entry — no windup from ROTATE transit.
              if (!_st.hold1IntArmed) { _st.hold1ThetaInt = 0; _st.hold1IntArmed = true; }
              const kiH1 = Number.isFinite(cfg.COAST_HOLD_ATT_KI) ? cfg.COAST_HOLD_ATT_KI : 2.0;
              const kpH1 = Number.isFinite(cfg.COAST_HOLD_ATT_KP) ? cfg.COAST_HOLD_ATT_KP : 5.0;
              const kdH1 = Number.isFinite(cfg.COAST_HOLD_ATT_KD) ? cfg.COAST_HOLD_ATT_KD : 5.0;
              if (Math.abs(thetaErr) < 0.5 * Math.PI / 180) {
                _st.hold1ThetaInt = Math.max(-0.005, Math.min(0.005, _st.hold1ThetaInt + thetaErr * dt));
              }
              const tau_desired =
                -I_next *
                (kpH1 * thetaErr + kdH1 * body.omega + kiH1 * _st.hold1ThetaInt);
              const result = GuideRCS.targetTorqueRcsNoNetForce(
                snapshot,
                tau_desired,
                idx,
              );
              if (result && result.fires.length)
                _send(Guidance.cmdRcsDuty(result.duties, idx));
              else _send(Guidance.cmdRcsDuty(null, idx));
            }
            break;
          }

          // ==========================================================
          case "CIRCULARIZE": {
            if (!dNext || !dNext.massProps) break;
            const gimbals = (body.engines || []).filter((e) => e.gimbal);

            const r_c = Math.hypot(body.rx, body.ry);
            const speed = Math.hypot(body.vx, body.vy);
            const v_orb_target = _st.coastVOrbital;
            const v_err = v_orb_target - speed;

            _st.circCurrentV = speed;
            _st.circTargetV = v_orb_target;
            _st.circErr = v_err;

            const spoolS = body.engines[0].shutdownDurationS;
            let mdot_now = 0,
              maxMFR = 0;
            (body.engines || []).forEach((e) => {
              mdot_now += e.massFlowRate || 0;
              if (
                Number.isFinite(e.maxMassFlowRate) &&
                e.maxMassFlowRate > maxMFR
              )
                maxMFR = e.maxMassFlowRate;
            });
            const t_spool_actual =
              maxMFR > 0 && mdot_now > 0
                ? (mdot_now * spoolS) / maxMFR
                : spoolS;
            const dv_spool =
              ((mdot_now / 2) * body.engines[0].Ve * t_spool_actual) /
              Math.max(1, dNext.massProps.M);

            const ejectionKick = env.PAYLOAD_EJECT_KICK_MPS || 0;
            const cutoffThreshold = dv_spool + ejectionKick;

            if (v_err <= cutoffThreshold) {
              _st.circAchieved = true;
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              _st.phase = "COAST_ROTATE_2";
              _st.phaseStart = simT;
              _st.coast2TargetThetaInertial = null;
              _st.coast2RotateStartTilt = null;
              _st.coast2RotateMid = null;
              _st._prevVr2 = null;
              break;
            }

            const decayWindow = cfg.CIRC_DECAY_FRAC * v_orb_target;
            let thrFrac = 1.0;
            if (v_err <= decayWindow && decayWindow > 0) {
              thrFrac = Math.max(0.4, 0.4 + 0.6 * (v_err / decayWindow));
            }
            let refMax = 0;
            (body.engines || []).forEach((e) => {
              if (
                Number.isFinite(e.maxMassFlowRate) &&
                e.maxMassFlowRate > refMax
              )
                refMax = e.maxMassFlowRate;
            });
            _send(Guidance.cmdSetAllThrottle(refMax * thrFrac));

            if (gimbals.length && _st.coastTargetThetaInertial !== null) {
              const I_next = dNext.massProps.I;
              const thetaErr = _wrapPi(
                body.theta - _st.coastTargetThetaInertial,
              );
              const tau_desired =
                -I_next *
                (cfg.CIRC_ATT_KP * thetaErr + cfg.CIRC_ATT_KD * body.omega);
              const g_N = gimbals[0].gimbalDeg || 0;
              const comX1 = dNext.massProps.comX;
              const comY1 = dNext.massProps.comY;
              let A_g = 0,
                B_g = 0;
              gimbals.forEach((e) => {
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
                const w1 = _wrapPi(Math.asin(ratio) - phi);
                const w2 = _wrapPi(Math.PI - Math.asin(ratio) - phi);
                g_req_rad = Math.abs(w1) <= Math.abs(w2) ? w1 : w2;
              }
              let g_req_deg = (g_req_rad * 180) / Math.PI;
              const _gMax = gimbals[0].gimbalMaxDeg;
              if (Math.abs(g_req_deg) > _gMax) {
                g_req_deg = Math.sign(g_req_deg) * _gMax;
              }
              _send(_gimbalCmdMsg(g_req_deg, gimbals[0], dt));
            }
            break;
          }

          // ==========================================================
          case "COAST_ROTATE_2": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            let stillFiring = false;
            (body.engines || []).forEach((e) => {
              if ((e.massFlowRate || 0) > 1) stillFiring = true;
            });
            if (stillFiring) {
              _send(Guidance.cmdRcsDuty(null, idx));
              break;
            }

            const elapsed = simT - _st.phaseStart;
            if (elapsed >= cfg.COAST_ROTATE_TIMEOUT_S) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "COAST_HOLD_2";
              _st.phaseStart = simT;
              _st._prevVr2 = null;
              break;
            }

            if (_st.coast2TargetThetaInertial === null) {
              const GM_c = env.GM_EARTH;
              const r_c = Math.hypot(body.rx, body.ry);
              const v2_c = body.vx * body.vx + body.vy * body.vy;
              const rv_c = body.rx * body.vx + body.ry * body.vy;
              const ex_ecc =
                ((v2_c - GM_c / r_c) * body.rx - rv_c * body.vx) / GM_c;
              const ey_ecc =
                ((v2_c - GM_c / r_c) * body.ry - rv_c * body.vy) / GM_c;
              const e_mag = Math.hypot(ex_ecc, ey_ecc);
              // PICK NEARER APSIDE: compute t to apo + t to peri from current
              // post-burn state, pick the smaller. Attitude target, trim, and
              // deploy trigger all follow the chosen apside.
              const ux_c0 = body.rx / r_c, uy_c0 = body.ry / r_c;
              const vr_c0 = body.vx * ux_c0 + body.vy * uy_c0;
              const vt_c0 =
                body.vx * (body.ry / r_c) + body.vy * (-body.rx / r_c);
              const t_apo = _timeToApogee(r_c, vr_c0, vt_c0, GM_c);
              const t_peri = _timeToPerigee(r_c, vr_c0, vt_c0, GM_c);
              const pickPeri = (t_peri < t_apo);
              _st.coast2TargetApside = pickPeri ? 'peri' : 'apo';
              console.log('[insertion] COAST_ROTATE_2: t_apo=' +
                t_apo.toFixed(1) + 's, t_peri=' + t_peri.toFixed(1) +
                's -> picking ' + _st.coast2TargetApside);
              let thetaTarget;
              if (e_mag > 1e-6) {
                const E_c = 0.5 * v2_c - GM_c / r_c;
                const a_c = E_c < 0 ? -GM_c / (2 * E_c) : r_c;
                const sDir = vt_c0 >= 0 ? 1 : -1;
                let rx_aps, ry_aps;
                if (pickPeri) {
                  const phiPeri = Math.atan2(ex_ecc, ey_ecc);
                  const r_peri = a_c * (1 - e_mag);
                  rx_aps = r_peri * Math.sin(phiPeri);
                  ry_aps = r_peri * Math.cos(phiPeri);
                } else {
                  const phiApo = Math.atan2(-ex_ecc, -ey_ecc);
                  const r_apo = a_c * (1 + e_mag);
                  rx_aps = r_apo * Math.sin(phiApo);
                  ry_aps = r_apo * Math.cos(phiApo);
                }
                thetaTarget = Math.atan2(-sDir * ry_aps, -sDir * rx_aps);
              } else {
                const speed_c = Math.hypot(body.vx, body.vy);
                thetaTarget =
                  speed_c > 1 ? Math.atan2(-body.vx, body.vy) : body.theta;
              }
              _st.coast2TargetThetaInertial = thetaTarget;
            }

            const targetThetaRad = _st.coast2TargetThetaInertial;

            if (_st.coast2RotateStartTilt === null) {
              _st.coast2RotateStartTilt = body.theta;
              _st.coast2RotateMid = _wrapPi(targetThetaRad - body.theta);
            }
            const startThetaRad = _st.coast2RotateStartTilt;
            const deltaTotalRad = _st.coast2RotateMid;

            const thetaErr = _wrapPi(body.theta - targetThetaRad);
            const omegaRel = body.omega;

            if (
              Math.abs(thetaErr) < (cfg.COAST_ROTATE_TOL_DEG * Math.PI) / 180 &&
              Math.abs(omegaRel) < cfg.COAST_ROTATE_OMEGA_TOL
            ) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "COAST_HOLD_2";
              _st.phaseStart = simT;
              _st._prevVr2 = null;
              break;
            }

            const dirSign = Math.sign(deltaTotalRad) || 1;
            const currentDeltaRad = body.theta - startThetaRad;
            const midDeltaRad = deltaTotalRad / 2;
            const crossed =
              dirSign > 0
                ? currentDeltaRad >= midDeltaRad
                : currentDeltaRad <= midDeltaRad;
            const phaseSign = crossed ? -1 : 1;
            const tauCmd = phaseSign * dirSign * 1e9;

            const result = GuideRCS.targetTorqueRcsNoNetForce(
              snapshot,
              tauCmd,
              idx,
            );
            if (result && result.fires.length)
              _send(Guidance.cmdRcsDuty(result.duties, idx));
            else _send(Guidance.cmdRcsDuty(null, idx));
            break;
          }

          // ==========================================================
          case "COAST_HOLD_2": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            const GM_c = env.GM_EARTH;
            const r_c = Math.hypot(body.rx, body.ry);
            const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
            const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
            const vr_c = body.vx * ux_c + body.vy * uy_c;
            const vt_c = body.vx * ex_c + body.vy * ey_c;

            // Live apogee velocity direction — re-derived each tick from the
            // current orbit. (COAST_ROTATE_2 still uses the snapped value.)
            const v2_c = body.vx * body.vx + body.vy * body.vy;
            const rv_c = body.rx * body.vx + body.ry * body.vy;
            const ex_ecc = ((v2_c - GM_c / r_c) * body.rx - rv_c * body.vx) / GM_c;
            const ey_ecc = ((v2_c - GM_c / r_c) * body.ry - rv_c * body.vy) / GM_c;
            const e_mag = Math.hypot(ex_ecc, ey_ecc);
            const E_c = 0.5 * v2_c - GM_c / r_c;
            const a_c = E_c < 0 ? -GM_c / (2 * E_c) : r_c;
            const h_live = r_c * vt_c;
            // Elliptical target velocity at the CHOSEN apside (circular when
            // apo==peri). COAST_ROTATE_2 already picked nearer apside and
            // stored it in _st.coast2TargetApside; trim + attitude + deploy
            // trigger all key off it.
            const r_a_tgt_live = env.EARTH_RADIUS + _targetApoKm * 1000;
            const r_p_tgt_live = env.EARTH_RADIUS + _targetPeriKm * 1000;
            const a_tgt_live = (r_a_tgt_live + r_p_tgt_live) / 2;
            let r_live_at_apside, v_live_at_apside, v_target_at_apside;
            if (_st.coast2TargetApside === 'peri') {
              r_live_at_apside = a_c * (1 - e_mag);
              v_live_at_apside = r_live_at_apside > 0 ? Math.abs(h_live) / r_live_at_apside : 0;
              v_target_at_apside = Math.sqrt(GM_c * (2 / r_p_tgt_live - 1 / a_tgt_live));
            } else {
              r_live_at_apside = a_c * (1 + e_mag);
              v_live_at_apside = r_live_at_apside > 0 ? Math.abs(h_live) / r_live_at_apside : 0;
              v_target_at_apside = Math.sqrt(GM_c * (2 / r_a_tgt_live - 1 / a_tgt_live));
            }
            const gap = v_target_at_apside - v_live_at_apside;
            const targetGap = Number.isFinite(env.PAYLOAD_EJECT_KICK_MPS)
              ? env.PAYLOAD_EJECT_KICK_MPS : 0;
            const dvError = gap - targetGap;
            _st.coastHold2GapMps = gap;
            _st.coastHold2DvErrorMps = dvError;
            _st.coastHold2VcircAtApo = v_target_at_apside;
            _st.coastHold2VapoLive = v_live_at_apside;

            // Attitude target = velocity direction (prograde).
            //
            // Previously used the eccentricity-vector direction when
            // e_mag > 1e-6. Problem: at e_mag just above 1e-6 (typical
            // near-apex, near-circular), the ecc vector is numerically
            // ill-conditioned — direction is essentially noise (can be
            // 0.1-1 deg off from the true apside direction). Targeting
            // that noisy direction produced a misleading APEX attErr of
            // 0.006 deg while the TRUE tracking error against prograde
            // was 0.11 deg (visible in DEPLOY-DIAG). Velocity direction
            // is always well-defined and matches the physics spawn kick
            // direction exactly (physics.js: ux = vx/|v|, uy = vy/|v|).
            const speed_c = Math.hypot(body.vx, body.vy);
            const thetaApoLive = speed_c > 1 ? Math.atan2(-body.vx, body.vy) : body.theta;
            _st.coast2TargetThetaLive = thetaApoLive;

            // OMEGA FEEDFORWARD — target rotation rate, ANALYTIC formula
            // valid for ANY Kepler orbit (circle, ellipse, everything).
            //
            // thetaApoLive = atan2(-vx, vy) (velocity direction). Its rate:
            //   dtheta/dt = (vx*ay - vy*ax) / v^2       (chain rule)
            // For ballistic: ax = -GM*rx/r^3, ay = -GM*ry/r^3
            //   = -GM*(rx*vy - ry*vx) / (r^3 * v^2)
            //   = -GM*h / (r^3 * v^2)                   (h = specific ang. mom.)
            //
            // Sanity (circular): h = r*v, v^2 = GM/r -> |omega| = v/r. Correct.
            // Ellipse: same formula, h from actual r x v. No eccentricity
            // assumption. Works everywhere.
            //
            // WHY NOT finite-diff: prev-tick thetaApoLive - current, divided
            // by dt, gives lagged rate + numerical noise. That residual was
            // the 0.0555 deg attErr (matches 0.078-0.0555 = 22.5 deg-per-
            // cent of original PD lag; slow drift not oscillation confirms
            // systematic lag, not noise).
            let _omegaTgt = 0;
            {
              const _rO = Math.hypot(body.rx, body.ry);
              const _vO = Math.hypot(body.vx, body.vy);
              if (_rO > 1 && _vO > 0.01 && env && Number.isFinite(env.GM_EARTH)) {
                // h = rx*vy - ry*vx  (specific angular momentum, sim convention)
                const _hO = body.rx * body.vy - body.ry * body.vx;
                // d(atan2(-vx,vy))/dt = +mu*h/(r^3*v^2). Note the POSITIVE sign:
                // derived from d(theta)/dt = (vx*ay - vy*ax)/v^2 with ballistic
                // ax,ay = -mu*r/r^3. Sanity (circular): h=r*v, v^2=mu/r -> |omega|=v/r.
                // An earlier version had -mu*h/... — sign reversed, so feedforward
                // pushed the wrong way (0.078 -> 0.1018 deg, worse than no feedforward).
                _omegaTgt = env.GM_EARTH * _hO / (_rO * _rO * _rO * _vO * _vO);
                // Glitch guard — reasonable LEO range
                if (Math.abs(_omegaTgt) > 0.05) _omegaTgt = 0;
              }
            }
            _st.hold2PrevThetaApoLive = thetaApoLive;
            _st.hold2PrevT = simT;
            _st.hold2OmegaTgt = _omegaTgt;

            // Apogee-peak FIRST — unconditional eject (trim state irrelevant).
            const prevVr = _st._prevVr2;
            _st._prevVr2 = vr_c;
            const apogeePeak =
              prevVr !== null &&
              prevVr !== undefined &&
              prevVr > 0 &&
              vr_c <= 0;
            const perigeePeak =
              prevVr !== null &&
              prevVr !== undefined &&
              prevVr < 0 &&
              vr_c >= 0;

            // PAYLOAD-APEX DETECTION — fire at the PAYLOAD's own apside, not stage's.
            //
            // Physics spawns the payload at stage base + totalH (nose tip). The
            // payload's radial direction differs from the stage's by theta ~ L/r,
            // where L = payload spawn offset from stage CoM ~ stage.height. So
            // the stage-frame prograde kick (3 m/s) gains a radial component
            // in the payload frame:
            //   vr_pay = vr_stage + (L/r)*(V_stage + KICK)
            // At stage apex (vr_stage=0): vr_pay = +(L/r)*(V+KICK) — the payload
            // is still CLIMBING. Its own apex is (L/r)*(V+KICK)/g seconds
            // after the stage apex (~2s for a 320 km target). Firing at the
            // stage apex spawns the payload while it's still climbing → ecc
            // ~1.9e-6, split ~26m — SYSTEMATIC (matches DEPLOY-DIAG exactly).
            //
            // Fire 1 tick before payload-apex prediction crosses zero -> spawn
            // lands at payload apex (vr_pay ~ 0) -> true circular payload orbit.
            //
            // Fallback: if env.PAYLOAD_DEPLOY_OFFSET_M is missing (=0), vr_pay
            // degenerates to vr_stage -> payload apex == stage apex -> old
            // behavior. Acceptable degradation.
            // L = sum of current body.members' heights. This EXACTLY matches
            // physics.js releasePayloadOnActiveBody's spawn offset:
            //   payloadRx = active.rx + totalH * upX
            //   totalH = active.members.reduce((s,m) => s + m.height, 0)
            // Same source, same tick, no env dependency, no stageRole lookup.
            // Robust across stage-role detection failures, worker scope issues,
            // and future physics.js spawn-formula changes (as long as it stays
            // "base + sum of member heights", which is the current design).
            const _L = (body.members && body.members.length) ?
              body.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) : 0;
            const _KICK = (env && Number.isFinite(env.PAYLOAD_EJECT_KICK_MPS))
              ? env.PAYLOAD_EJECT_KICK_MPS : 0;
            const _V_s = Math.hypot(body.vx, body.vy);
            const _geom = (_L > 0 && r_c > 1) ? (_L / r_c) * (_V_s + _KICK) : 0;
            const vr_pay = vr_c + _geom;

            // dvr/dt from the last 2 ticks. Coasting at 320km: no thrust/drag,
            // so dvr/dt ~ -g (radial gravity). Per tick: -g*dt ~ -0.111 m/s.
            // (Payload vr drifts by the same dvrdt — L, V_s, r_c are essentially
            // constant over one tick.)
            const dvrdt = (prevVr !== null && prevVr !== undefined && dt > 0)
              ? (vr_c - prevVr) / dt : 0;
            const vrNext = vr_pay + dvrdt * dt;
            const apogeePeakNextTick = (vr_pay > 0) && (vrNext <= 0);
            const perigeePeakNextTick = (vr_pay < 0) && (vrNext >= 0);

            // Prefer the predicted (fire at N-1, spawn AT apside) path over the
            // confirmed (fire at apex, spawn 1 tick late) fallback. Old detection
            // is kept so a noisy dvr/dt or unusual tick ordering can't strand
            // us without a deploy trigger.
            // Payload apex only — stage apex is ~2s earlier and would fire too
            // early, defeating the whole point of the payload-frame prediction.
            const deployPeak = (_st.coast2TargetApside === 'peri')
              ? perigeePeakNextTick
              : apogeePeakNextTick;

            // [DEBUG] APEX tick log — only when near apex.
            if (Math.abs(vr_pay) < 0.3) {
              const _attErrDeg = _wrapPi(body.theta - thetaApoLive) * (180 / Math.PI);
              if (DEBUG_DEPLOY) console.log('[APEX-t' + simT.toFixed(4) + ']' +
                ' attErr=' + _attErrDeg.toFixed(4) + 'deg' +
                ' vr=' + vr_c.toFixed(5) +
                ' vr_pay=' + vr_pay.toFixed(5) +
                ' geom=' + _geom.toFixed(5) +
                ' L=' + _L.toFixed(2) +
                ' nMembers=' + (body.members ? body.members.length : 0) +
                ' dvrdt=' + (Number.isFinite(dvrdt) ? dvrdt.toFixed(3) : 'NaN') +
                ' vrNext=' + (Number.isFinite(vrNext) ? vrNext.toFixed(5) : 'NaN') +
                ' predNext=' + apogeePeakNextTick +
                ' oldPeak=' + apogeePeak +
                ' deployPeak=' + deployPeak +
                ' apside=' + _st.coast2TargetApside);
            }

            if (deployPeak) {
              if (DEBUG_DEPLOY) console.log('[DEPLOY-FIRE-t' + simT.toFixed(4) + ']' +
                ' vr=' + vr_c.toFixed(5) +
                ' prevVr=' + (prevVr !== null && prevVr !== undefined ? prevVr.toFixed(5) : 'null') +
                ' predNext=' + apogeePeakNextTick +
                ' oldPeak=' + apogeePeak +
                ' fireReason=' + (apogeePeakNextTick ? 'PREDICTED' : 'OLD'));
              // [STAGE-ORBIT] complete stage orbital state at fire tick
              try {
                const _rS = Math.hypot(body.rx, body.ry);
                const _rSx = body.rx / _rS, _rSy = body.ry / _rS;
                const _vrS = body.vx * _rSx + body.vy * _rSy;
                const _vtS = -body.vx * _rSy + body.vy * _rSx;
                const _vS = Math.hypot(body.vx, body.vy);
                const _vcS = Math.sqrt(env.GM_EARTH / _rS);
                const _v2S = body.vx * body.vx + body.vy * body.vy;
                const _rvS = body.rx * body.vx + body.ry * body.vy;
                const _exS = ((_v2S - env.GM_EARTH / _rS) * body.rx - _rvS * body.vx) / env.GM_EARTH;
                const _eyS = ((_v2S - env.GM_EARTH / _rS) * body.ry - _rvS * body.vy) / env.GM_EARTH;
                const _eS = Math.sqrt(_exS * _exS + _eyS * _eyS);
                if (DEBUG_DEPLOY) console.log('[STAGE-ORBIT] r=' + _rS.toFixed(2) +
                  ' vr=' + _vrS.toFixed(6) +
                  ' vt=' + _vtS.toFixed(4) +
                  ' speed=' + _vS.toFixed(4) +
                  ' v_circ=' + _vcS.toFixed(4) +
                  ' ecc_vec=' + _eS.toExponential(3));
              } catch (e) {}
              // DEPLOY DIAGNOSTIC: log stage state at deploy tick
              try {
                var _spd = Math.hypot(body.vx, body.vy);
                var _vd = Math.atan2(-body.vx, body.vy);
                var _ae = _wrapPi(body.theta - _vd) * 180 / Math.PI;
                var _kick = env.PAYLOAD_EJECT_KICK_MPS || 0;
                var _radKick = _kick * Math.sin(_ae * Math.PI / 180);
                var _proKick = _kick * Math.cos(_ae * Math.PI / 180);
                var _eccFromAtt = Math.abs(_radKick) / _spd;
                var _apexM = (6371000 + _targetPeriKm * 1000) * _eccFromAtt;
                if (DEBUG_DEPLOY) console.log("[DEPLOY-DIAG] attErr_deg=" + _ae.toFixed(4) + " speed=" + _spd.toFixed(4) + " kick=" + _kick.toFixed(3) + " prograde=" + _proKick.toFixed(4) + " radial=" + _radKick.toFixed(5) + " apexDevM=" + _apexM.toFixed(2));
                _st._stageVx = body.vx;
                _st._stageVy = body.vy;
                _st._stageSpeed = _spd;
              } catch (e) { console.log("[DEPLOY-DIAG] err", e); }
              _send(Guidance.cmdRcsDuty(null, idx));
              _send(Guidance.cmdReleasePayload());
              _st.deployCommandSimTime = simT;
              _deployCmdTick = _st.ticks;
              _payloadBodyCountAtDeploy = snapshot.bodies.length;
              _st.phase = "DONE";
              _st.phaseStart = simT;
              break;
            }

            // Attitude hold — torque-only RCS toward LIVE apogee direction.
            // PID (not PD): integrator eliminates steady-state lag; the apside
            // direction drifts ~0.066 deg/s, and PD would leave a persistent
            // ~0.05-0.1 deg offset = kick misalignment = payload ecc.
            let attDuties = null;
            let attTorqueAchieved = 0;
            if (dNext && dNext.massProps) {
              const I_next = dNext.massProps.I;
              if (!_st.hold2IntArmed) {
                _st.hold2ThetaInt = 0;
                _st.hold2IntArmed = true;
                _st.hold2LastRcsTorque = 0;
              }
              // PLAIN PD on CURRENT actual state (no 1-tick prediction of body).
              //
              // Earlier version predicted body's N+1 state via:
              //   alphaPred = alphaEnv + tauRcsLastTick/I
              //   thetaPred = theta + omega*dt + 0.5*alphaPred*dt^2
              //   omegaPred = omega + alphaPred*dt
              // User observed this destabilizes: the "imagined" next-tick state
              // (built from the last-commanded RCS torque) fights the actual
              // controller output. When RCS quantization causes the actual
              // applied torque to differ from the last-commanded one (likely at
              // bang-bang boundaries), the predicted state becomes wrong, KD
              // amplifies the error, RCS fires harder, system chases a ghost.
              //
              // Reverting to plain PD on actual state. Analytic omega_target
              // feedforward (_omegaTgt) is KEPT — it's a TARGET rotation rate
              // (physics-correct, ellipse-safe), not a predicted body state.
              const thetaErr = _wrapPi(body.theta - thetaApoLive);
              const kiH2 = Number.isFinite(cfg.COAST_HOLD_ATT_KI) ? cfg.COAST_HOLD_ATT_KI : 0.0;
              const kpH2 = Number.isFinite(cfg.COAST_HOLD_ATT_KP) ? cfg.COAST_HOLD_ATT_KP : 15.0;
              const kdH2 = Number.isFinite(cfg.COAST_HOLD_ATT_KD) ? cfg.COAST_HOLD_ATT_KD : 5.0;
              if (Math.abs(thetaErr) < 0.5 * Math.PI / 180) {
                _st.hold2ThetaInt = Math.max(-0.005, Math.min(0.005, _st.hold2ThetaInt + thetaErr * dt));
              }
              // Rate RELATIVE to rotating target (feedforward on target only).
              const omegaRel = body.omega - _omegaTgt;
              const tau_desired =
                -I_next * (kpH2 * thetaErr + kdH2 * omegaRel + kiH2 * _st.hold2ThetaInt);
              const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
              if (result && result.fires.length) {
                attDuties = result.duties;
                attTorqueAchieved = Number.isFinite(result.torqueAchieved) ? result.torqueAchieved : 0;
              }
              // [TORQUE-DIAG] — is RCS saturated? Is KI working?
              if (Math.abs(vr_pay) < 0.3) {
                const _tauAch = Number.isFinite(attTorqueAchieved) ? attTorqueAchieved : 0;
                const _sat = (result && result.saturated) ? 1 : 0;
                if (DEBUG_DEPLOY) console.log('[TORQUE-DIAG-t' + simT.toFixed(4) + ']' +
                  ' attErr=' + (thetaErr*180/Math.PI).toFixed(4) + 'deg' +
                  ' tauDes=' + tau_desired.toFixed(0) +
                  ' tauAch=' + _tauAch.toFixed(0) +
                  ' sat=' + _sat +
                  ' KPterm=' + (kpH2 * thetaErr).toFixed(6) +
                  ' KDterm=' + (kdH2 * omegaRel).toFixed(6) +
                  ' KIterm=' + (kiH2 * _st.hold2ThetaInt).toFixed(6));
              }
            }

            // Axial trim — net-force RCS only. Drive gap to eject kick.
            // dvError > 0 -> too slow -> prograde ("up").
            // dvError < 0 -> too fast -> retrograde ("dn").
            // [TRIM-DIAG] — log axial trim state near fire tick
            if (Math.abs(vr_pay) < 0.3) {
              const _dutyPrev = Math.min(1, Math.abs(dvError) / Math.max(Number.isFinite(cfg.COAST_HOLD_2_TRIM_FAR_MPS) ? cfg.COAST_HOLD_2_TRIM_FAR_MPS : 0.01, 1e-6));
              const _tolPrev = Number.isFinite(cfg.COAST_HOLD_2_TRIM_TOL_MPS) ? cfg.COAST_HOLD_2_TRIM_TOL_MPS : 0.0001;
              if (DEBUG_DEPLOY) console.log('[TRIM-DIAG-t' + simT.toFixed(4) + ']' +
                ' dvErr=' + dvError.toFixed(6) +
                ' duty=' + _dutyPrev.toFixed(5) +
                ' fires=' + (Math.abs(dvError) > _tolPrev && _dutyPrev >= 0.005));
            }
            let axialDuties = null;
            const TRIM_TOL = Number.isFinite(cfg.COAST_HOLD_2_TRIM_TOL_MPS)
              ? cfg.COAST_HOLD_2_TRIM_TOL_MPS : 0.00001;
            const TRIM_FAR = Number.isFinite(cfg.COAST_HOLD_2_TRIM_FAR_MPS)
              ? cfg.COAST_HOLD_2_TRIM_FAR_MPS : 0.0;
            // Lowered from 0.02 to 0.005 (0.5% min duty) — allows trim to
            // fire near convergence, where dvError is small and duty is tiny.
            // At 0.02, trim stopped firing once duty dropped below 2%, leaving
            // a residual of ~0.0014 m/s (the 4.7m apo-peri split).
            const DEADBAND_DUTY = 0.005;
            if (Math.abs(dvError) > TRIM_TOL) {
              const direction = dvError > 0 ? "up" : "dn";
              const duty = Math.min(1, Math.abs(dvError) / Math.max(TRIM_FAR, 1e-6));
              if (duty >= DEADBAND_DUTY) {
                const raw = GuideRCS.postSeparationAxialDuty(snapshot, idx, direction);
                if (raw) {
                  axialDuties = {};
                  Object.keys(raw).forEach(function (pod) {
                    const d = raw[pod];
                    if (!d) return;
                    axialDuties[pod] = {
                      up: (d.up || 0) * duty,
                      dn: (d.dn || 0) * duty,
                      lat: (d.lat || 0) * duty,
                    };
                  });
                }
              }
            }

            const merged = _mergeRcsDuties(attDuties, axialDuties);
            if (merged) _send(Guidance.cmdRcsDuty(merged, idx));
            else _send(Guidance.cmdRcsDuty(null, idx));
            _st.hold2LastRcsTorque = attTorqueAchieved;
            break;
          }

          // ==========================================================
          // DONE — payload monitor + attitude hold.
          // Mission-level code handles the dwell + suicide dispatch.
          case "DONE": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            // [DEBUG] SPAWN — first tick payload exists in snapshot.
            if (!_st._spawnLogged) {
              for (let _si = 0; _si < snapshot.bodies.length; _si++) {
                const _sb = snapshot.bodies[_si];
                if (_sb && _sb.payloadBody) {
                  _st._spawnLogged = true;
                  const _sr = Math.hypot(_sb.rx, _sb.ry);
                  const _svr = (_sb.vx * _sb.rx + _sb.vy * _sb.ry) / _sr;
                  if (DEBUG_DEPLOY) console.log('[SPAWN-t' + simT.toFixed(4) + ']' +
                    ' idx=' + _si +
                    ' vr=' + _svr.toFixed(5) +
                    ' omega=' + (Number.isFinite(_sb.omega) ? _sb.omega.toFixed(6) : 'NaN') +
                    ' speed=' + Math.hypot(_sb.vx, _sb.vy).toFixed(4) +
                    ' deployCmdT=' + (Number.isFinite(_st.deployCommandSimTime) ? _st.deployCommandSimTime.toFixed(4) : 'null') +
                    ' dtSinceCmd=' + (Number.isFinite(_st.deployCommandSimTime) ? (simT - _st.deployCommandSimTime).toFixed(4) : 'null') +
                    ' ticksSinceCmd=' + (Number.isFinite(_st.deployCommandSimTime) ? Math.round((simT - _st.deployCommandSimTime) / dt) : 'null'));
                  break;
                }
              }
            }

            // DEPLOY RESULT: log payload post-eject state once
            if (!_st._payloadLogged) {
              var _pb = snapshot.bodies.find(function(x){ return x && x.payloadBody; });
              if (_pb) {
                _st._payloadLogged = true;
                try {
                  var GM = env.GM_EARTH, Re = env.EARTH_RADIUS;
                  var _r = Math.hypot(_pb.rx, _pb.ry);
                  var _vt = (_pb.vx * _pb.ry - _pb.vy * _pb.rx) / _r;
                  var _spdP = Math.hypot(_pb.vx, _pb.vy);
                  var _E = 0.5 * _spdP * _spdP - GM / _r;
                  var _h = _r * _vt;
                  var _e = Math.sqrt(Math.max(0, 1 + 2 * _E * _h * _h / (GM * GM)));
                  // [PAY-ORBIT] — full payload orbital diagnostic
                  try {
                    var _uxP = _pb.rx / _r, _uyP = _pb.ry / _r;
                    var _vrP = _pb.vx * _uxP + _pb.vy * _uyP;
                    var _vcP = Math.sqrt(GM / _r);
                    var _v2P = _pb.vx * _pb.vx + _pb.vy * _pb.vy;
                    var _rvP = _pb.rx * _pb.vx + _pb.ry * _pb.vy;
                    var _exP = ((_v2P - GM / _r) * _pb.rx - _rvP * _pb.vx) / GM;
                    var _eyP = ((_v2P - GM / _r) * _pb.ry - _rvP * _pb.vy) / GM;
                    var _eV = Math.sqrt(_exP * _exP + _eyP * _eyP);
                    if (DEBUG_DEPLOY) console.log('[PAY-ORBIT] r=' + _r.toFixed(2) +
                      ' vr=' + _vrP.toFixed(6) +
                      ' vt=' + _vt.toFixed(4) +
                      ' speed=' + _spdP.toFixed(4) +
                      ' v_circ=' + _vcP.toFixed(4) +
                      ' ecc_formula=' + _e.toExponential(3) +
                      ' ecc_vector=' + _eV.toExponential(3));
                  } catch (e) {}
                  var _apoK = -1, _periK = -1;
                  if (_E < 0) { var _a = -GM / (2 * _E); _apoK = (_a * (1 + _e) - Re) / 1000; _periK = (_a * (1 - _e) - Re) / 1000; }
                  var _dvx = _pb.vx - (_st._stageVx || 0);
                  var _dvy = _pb.vy - (_st._stageVy || 0);
                  var _dv = Math.hypot(_dvx, _dvy);
                  var _spd0 = _st._stageSpeed || 1;
                  var _uVx = (_st._stageVx || 0) / _spd0;
                  var _uVy = (_st._stageVy || 0) / _spd0;
                  var _dvA = _dvx * _uVx + _dvy * _uVy;
                  var _dvP = _dvx * (-_uVy) + _dvy * _uVx;
                  console.log("[DEPLOY-RESULT] payloadSpeed=" + _spdP.toFixed(4) + " dvActual=" + _dv.toFixed(4) + " dvAlong=" + _dvA.toFixed(4) + " dvPerp=" + _dvP.toFixed(5) + " apo=" + _apoK.toFixed(4) + " peri=" + _periK.toFixed(4) + " ecc=" + _e.toExponential(3));
                  console.log("[DEPLOY-RESULT] err: apoKm=" + (_apoK - _targetApoKm).toFixed(3) + " periKm=" + (_periK - _targetPeriKm).toFixed(3) + " targetApo=" + _targetApoKm + " targetPeri=" + _targetPeriKm);
                } catch (e2) { console.log("[DEPLOY-RESULT] err", e2); }
              }
            }

            // Stage fully OFF in DONE — engines + gimbal zero'd above, RCS
            // explicitly relinquished too. Mission-level DONE_DWELL used to
            // keep firing RCS to hold attitude, which burned propellant for
            // no reason: the suicide block at dwell end rotates to retrograde
            // on its own anyway.
            _send(Guidance.cmdRcsDuty(null, idx));

            // Payload monitor: wait for at least expectedPayloadCount
            // payload bodies to spawn and clear the stage.
            const expected = Number.isInteger(_missionCtx.expectedPayloadCount)
              ? Math.max(1, _missionCtx.expectedPayloadCount)
              : 1;
            const cleared = _countClearedPayloads(snapshot);
            if (cleared >= expected) {
              _st.payloadCleared = true;
              _done = true;
              _result = {
                stageBodyIdx: _bodyIdx,
                deployCommandSimTime: _st.deployCommandSimTime,
                doneEntrySimTime: _st.phaseStart,
                coast2TargetThetaInertial: _st.coast2TargetThetaInertial,
                clearedPayloadCount: cleared,
                finalApogeeKm: _st.lastApogeeKm,
                finalPerigeeKm: _st.lastPerigeeKm,
              };
              break;
            }

            // Fail-safe timeout
            const elapsedDone = simT - _st.phaseStart;
            if (elapsedDone >= cfg.PAYLOAD_CONFIRM_TIMEOUT_S) {
              _done = true;
              _result = {
                stageBodyIdx: _bodyIdx,
                deployCommandSimTime: _st.deployCommandSimTime,
                doneEntrySimTime: _st.phaseStart,
                coast2TargetThetaInertial: _st.coast2TargetThetaInertial,
                clearedPayloadCount: cleared,
                timedOut: true,
                finalApogeeKm: _st.lastApogeeKm,
                finalPerigeeKm: _st.lastPerigeeKm,
              };
              break;
            }
            break;
          }

          default:
            break;
        }
      }

      return {
        start(constants, bodyIdx, missionCtx) {
          if (!constants)
            throw new Error("insertion.start: constants required");
          if (!Number.isInteger(bodyIdx))
            throw new Error("insertion.start: bodyIdx required");
          _constants = JSON.parse(JSON.stringify(constants));
          _bodyIdx = bodyIdx;
          _missionCtx = missionCtx || {};
          _done = false;
          _result = null;

          // Self-healing apside derivation (no legacy fallback):
          //   - Both set      → use as-is
          //   - Only apside1  → mirror to apside2 (auto circular)
          //   - Only apside2  → mirror to apside1 (auto circular)
          //   - Neither set   → 320/320 (sane default)
          // apo = max(apside1, apside2), peri = min(apside1, apside2) — so
          // user order never matters.
          const _ap1Raw = Number.isFinite(constants.TARGET_APSIDE1_ALT_KM)
            ? constants.TARGET_APSIDE1_ALT_KM
            : (Number.isFinite(constants.TARGET_APSIDE2_ALT_KM)
                ? constants.TARGET_APSIDE2_ALT_KM : 320);
          const _ap2Raw = Number.isFinite(constants.TARGET_APSIDE2_ALT_KM)
            ? constants.TARGET_APSIDE2_ALT_KM
            : _ap1Raw;
          _targetApoKm = Math.max(_ap1Raw, _ap2Raw);
          _targetPeriKm = Math.min(_ap1Raw, _ap2Raw);

          _st.init = false;
          _st.ticks = 0;
          _st.phase = "STAGE_BURN";
          _st.phaseStart = 0;
_st.stageBurnSpooled = false;
_st.stageBurnAoaSeeded = false;
_st.sbBiasEff = NaN;
_st.sbAoaInt = 0;
_st.lastApogeeKm = 0;
          _st.lastPerigeeKm = null;
          _st._prevApogeeErr = null;
          _st.coastTargetThetaInertial = null;
          _st.coastRotateStartTilt = null;
          _st.coastRotateMid = null;
          _st.coastTBurnPractical = 0;
          _st.coastVOrbital = 0;
          _st._prevVr = null;
          _st.coastRotateSecondPass = false;
          _st.coastRotateEndDeltaV = null;
          _st.coastRotateEndTRem = null;
          _st.circCurrentV = 0;
          _st.circTargetV = 0;
          _st.circErr = 0;
          _st.circAchieved = false;
          _st.coast2TargetThetaInertial = null;
          _st.coast2RotateStartTilt = null;
          _st.coast2RotateMid = null;
          _st._prevVr2 = null;
          _st.coast2TargetApside = 'apo';
          _st.hold1ThetaInt = 0;
          _st.hold1IntArmed = false;
          _st.hold2ThetaInt = 0;
          _st.hold2IntArmed = false;
          _st.hold2LastRcsTorque = 0;
          _st.hold2PrevThetaApoLive = null;
          _st.hold2PrevT = null;
          _st.hold2OmegaTgt = 0;
          _st.deployCommandSimTime = null;
          _st.payloadCleared = false;
          _st._spawnLogged = false;
          _st.coast2TargetThetaLive = null;
          _st.coastHold2GapMps = null;
          _st.coastHold2DvErrorMps = null;
          _st.coastHold2VcircAtApo = null;
          _st.coastHold2VapoLive = null;

          _payloadBodyCountAtDeploy = 0;
          _deployCmdTick = -1;
        },

        tick(snapshot) {
          if (_done) return;
          if (!snapshot || !snapshot.bodies || !snapshot.bodies[_bodyIdx])
            return;
          _tick(snapshot);
        },

        stop() {
          _send(Guidance.cmdSetAllThrottle(0));
          _send(Guidance.cmdSetGimbalRate(0));
          _send(Guidance.cmdRcsDuty(null));
          _st.init = false;
          _done = false;
        },

        isDone() {
          return _done;
        },
        getResult() {
          return _result ? Object.assign({}, _result) : null;
        },
        getStatus() {
          //sehran
    // Compute circ-burn trigger lead exactly ONCE per instance, then
    // freeze. Value = stage engine's startupDurationS (from its
    // thruster type spec) + mission CIRC_TRIGGER_LEAD_S. Both are
    // constants; per-tick recompute would give the same answer every
    // time, so we cache after the first successful compute.
    if (_st._circLeadCached === undefined) {
      let startupS = 0;
      try {
        const sd = (typeof Derivation !== 'undefined' && Derivation.getStackData) ?
          Derivation.getStackData() : null;
        if (sd && Array.isArray(sd.members)) {
          for (let i = 0; i < sd.members.length; i++) {
            const m = sd.members[i];
            if (!m || m.stageRole !== 'stage') continue;
            const g = m.engineThrusters &&
              (m.engineThrusters.gimbal || m.engineThrusters.fixed);
            if (!g || !g.thrusterTypeId) continue;
            const t = Derivation.getTypeById(g.thrusterTypeId);
            if (!t || !Array.isArray(t.parameterSchema)) continue;
            const ent = t.parameterSchema.find(p => p.key === 'startupDurationS');
            if (ent && Number.isFinite(ent.value)) { startupS = ent.value; break; }
          }
        }
      } catch (e) {}
      const userLead = (_constants && Number.isFinite(_constants.CIRC_TRIGGER_LEAD_S)) ?
        _constants.CIRC_TRIGGER_LEAD_S : 0;
      _st._circLeadCached = startupS + userLead;
    }
    return {
      phase: _st.phase,
      ticks: _st.ticks,
      apogeeKm: _st.lastApogeeKm,
      perigeeKm: _st.lastPerigeeKm,
      coastTBurnPractical: _st.coastTBurnPractical,
      coastVOrbital: _st.coastVOrbital,
      circTriggerLeadS: _st._circLeadCached,
            coastTargetThetaDeg:
              _st.coastTargetThetaInertial != null
                ? (_st.coastTargetThetaInertial * 180) / Math.PI
                : null,
            coast2TargetThetaDeg:
              _st.coast2TargetThetaInertial != null
                ? (_st.coast2TargetThetaInertial * 180) / Math.PI
                : null,
            circCurrentV: _st.circCurrentV,
            circTargetV: _st.circTargetV,
            circErr: _st.circErr,
            circAchieved: _st.circAchieved,
            coastHold2TargetThetaLiveDeg:
              _st.coast2TargetThetaLive != null
                ? (_st.coast2TargetThetaLive * 180) / Math.PI
                : null,
            coastHold2GapMps: _st.coastHold2GapMps,
            coastHold2DvErrorMps: _st.coastHold2DvErrorMps,
            coastHold2VcircAtApo: _st.coastHold2VcircAtApo,
            coastHold2VapoLive: _st.coastHold2VapoLive,
            coastDeltaV: _st.coastRotateEndDeltaV,
            coastTRem: _st.coastRotateEndTRem,
            deployCommandSimTime: _st.deployCommandSimTime,
            payloadCleared: _st.payloadCleared,
          };
        },
        getBodyIdx() {
          return _bodyIdx;
        },

        getState() {
  return {
    bodyIdx: _bodyIdx,
    constants: _constants ? JSON.parse(JSON.stringify(_constants)) : null,
    missionCtx: _missionCtx ? JSON.parse(JSON.stringify(_missionCtx)) : null,
    done: _done,
    result: _result ? JSON.parse(JSON.stringify(_result)) : null,
    st: JSON.parse(JSON.stringify(_st)),
    payloadBodyCountAtDeploy: _payloadBodyCountAtDeploy,
    deployCmdTick: _deployCmdTick,
  };
},
setState(s) {
  if (!s) return;
  _bodyIdx = Number.isInteger(s.bodyIdx) ? s.bodyIdx : null;
  _constants = s.constants ? JSON.parse(JSON.stringify(s.constants)) : null;
  _missionCtx = s.missionCtx ? JSON.parse(JSON.stringify(s.missionCtx)) : {};
  _done = !!s.done;
  _result = s.result ? JSON.parse(JSON.stringify(s.result)) : null;
  if (s.st) Object.assign(_st, s.st);
  _payloadBodyCountAtDeploy = s.payloadBodyCountAtDeploy || 0;
  _deployCmdTick = Number.isInteger(s.deployCmdTick) ? s.deployCmdTick : -1;
  // Recompute derived target apsides from restored constants (start() is
  // not called during state restore — without this, _targetApoKm/PeriKm
  // would stay at their 320/320 defaults even if the config was different).
  // Self-healing: mirror single apside to the other (auto circular).
  if (_constants) {
    const _ap1 = Number.isFinite(_constants.TARGET_APSIDE1_ALT_KM)
      ? _constants.TARGET_APSIDE1_ALT_KM
      : (Number.isFinite(_constants.TARGET_APSIDE2_ALT_KM)
          ? _constants.TARGET_APSIDE2_ALT_KM : 320);
    const _ap2 = Number.isFinite(_constants.TARGET_APSIDE2_ALT_KM)
      ? _constants.TARGET_APSIDE2_ALT_KM
      : _ap1;
    _targetApoKm = Math.max(_ap1, _ap2);
    _targetPeriKm = Math.min(_ap1, _ap2);
  }
},
        
        getConstants() {
          return _constants ? JSON.parse(JSON.stringify(_constants)) : null;
        },
        setConstants(patch) {
          if (_constants && patch) Object.assign(_constants, patch);
        },
      };
    },
  },

  // ==========================================================================
  // SUICIDE — generic deorbit block.
  //
  // Given any body and a target resting area, aligns the body to retrograde,
  // runs the deorbit burn to a coarse impact-angle cutoff, then holds
  // attitude and RCS-trims the impact point. Ends when trim converges (or
  // the trim timeout elapses) with all engines off.
  //
  // missionCtx.restingArea (optional): { midWestDeg, westStartDeg, westEndDeg }.
  // Falls back to env's REMOTE_AREA_* values (V2 identical).
  // ==========================================================================
  suicide: {
    name: "suicide",
    displayName: "Suicide Burn (Deorbit)",
    description:
      "Aligns any body to retrograde, runs a suicide burn to a resting area, RCS-trims the impact. Generic — usable on any body that needs a controlled deorbit.",
    defaultConstants: {
      SUICIDE_ROTATE_TOL_DEG: 1.0,
      SUICIDE_ROTATE_OMEGA_TOL: 0.02,
      SUICIDE_ROTATE_TIMEOUT_S: 120,
      SUICIDE_ATT_KP: 0.5,
      SUICIDE_ATT_KD: 4.0,
      SUICIDE_PREDICT_DT_S: 2,
      SUICIDE_PREDICT_HORIZON_S: 4000,
      SUICIDE_BURN_MAX_S: 600,
      SUICIDE_BURN_COARSE_MARGIN_DEG: 0.5,
      SUICIDE_TRIM_TOL_DEG: 0.1,
      SUICIDE_TRIM_FAR_DEG: 0.5,
      // Lowered from 0.15 — at small errors (just above TOL), 15% duty
// accumulates meaningful Δv over the long remaining fall time and
// causes overshoot. 0.03 is close to RCS noise floor but still
// enough to nudge.
SUICIDE_TRIM_MIN_DUTY: 0.03,
      SUICIDE_TRIM_MAX_S: 120,
    },
    importantFields: [],
    createInstance: function () {
      let _constants = null;
      let _bodyIdx = null;
      let _missionCtx = null;
      let _done = false;
      let _result = null;

      const _st = {
        init: false,
        ticks: 0,
        phase: "SUICIDE_ROTATE",
        phaseStart: 0,
        suicideBurnStartT: 0,
        suicideImpactEf: null,
        suicideDlambda: null,
            suicideTrimDone: false,
    suicideTrimStartT: 0,
  };

      function _send(cmd) {
        if (!cmd) return;
        if (cmd.targetBodyIdx === undefined) cmd.targetBodyIdx = _bodyIdx;
        Guidance.send(cmd);
      }

      function _wrapPi(x) {
        while (x > Math.PI) x -= 2 * Math.PI;
        while (x < -Math.PI) x += 2 * Math.PI;
        return x;
      }

      // ---- Leapfrog ballistic impact prediction — verbatim from V2 ----
      function _predictImpact(
        rx,
        ry,
        vx,
        vy,
        simTimeNow,
        dtPred,
        maxT,
        GM,
        R,
        omegaE,
      ) {
        let px = rx,
          py = ry,
          pvx = vx,
          pvy = vy,
          t = 0;
        while (t < maxT) {
          const r = Math.hypot(px, py);
          if (r <= R) {
            const phiInertial = Math.atan2(px, py);
            const phiEf = phiInertial - omegaE * (simTimeNow + t);
            return { phiEf, tImpact: t, rImpact: r };
          }
          const r3 = r * r * r;
          const ax = (-GM * px) / r3,
            ay = (-GM * py) / r3;
          const vxh = pvx + 0.5 * ax * dtPred;
          const vyh = pvy + 0.5 * ay * dtPred;
          const nx = px + vxh * dtPred;
          const ny = py + vyh * dtPred;
          const nr = Math.hypot(nx, ny);
          const nr3 = nr * nr * nr;
          pvx = vxh + 0.5 * ((-GM * nx) / nr3) * dtPred;
          pvy = vyh + 0.5 * ((-GM * ny) / nr3) * dtPred;
          px = nx;
          py = ny;
          t += dtPred;
        }
        return null;
      }

      function _tick(snapshot) {
  _st.ticks++;
  const idx = _bodyIdx;
  const body = snapshot.bodies[idx];
  if (!body) return;
  const simT = snapshot.simTime;
  
// Cache circ-burn trigger lead exactly ONCE per instance.
//
// Fires the first tick where body.engines and _constants are both
// populated. After that, the value is never recomputed — it's a
// pure function of two constants (thruster type's startupDurationS
// and the mission's CIRC_TRIGGER_LEAD_S), so caching it for the
// life of this insertion block instance is exactly equivalent to
// recomputing it, without the per-tick cost.
//
// Retry loop: on the split tick, engine arrays can still be empty
// (rebuildEnginesForBody runs after members change). Waiting a
// few ticks for them to populate is what the earlier single-shot
// version missed.
if (_st.lastCircTriggerLeadS === 0 &&
  body.engines && body.engines.length &&
  _constants) {
  const s0 = body.engines[0].startupDurationS;
  const userLead = _constants.CIRC_TRIGGER_LEAD_S;
  const total = (Number.isFinite(s0) ? s0 : 0) +
    (Number.isFinite(userLead) ? userLead : 0);
  if (total > 0) {
    _st.lastCircTriggerLeadS = total;
  }
}
  
  if (!_st.init) {
          _st.init = true;
          _st.phase = "SUICIDE_ROTATE";
          _st.phaseStart = simT;
        }

        const d = Derivation.derive(snapshot, idx);
        if (!d || !d.massProps) return;
        const env = Derivation.getEnv();
        const dt = env.DT;
        const M_d = d.massProps.M;

        let dNext = null;
        if (M_d > 0) {
          const cosT = Math.cos(d.theta),
            sinT = Math.sin(d.theta);
          const thrustIx = d.thrustBodyX * cosT - d.thrustBodyY * sinT;
          const thrustIy = d.thrustBodyX * sinT + d.thrustBodyY * cosT;
          const aIx = d.gVecX + (thrustIx + d.dragVecX) / M_d;
          const aIy = d.gVecY + (thrustIy + d.dragVecY) / M_d;
          const sloshNow = body.slosh || { offset: 0, velocity: 0 };
          dNext = Derivation.deriveForState(snapshot, idx, {
            rx: d.rx + d.vx * dt,
            ry: d.ry + d.vy * dt,
            vx: d.vx + aIx * dt,
            vy: d.vy + aIy * dt,
            theta: d.theta + d.omega * dt + 0.5 * d.alphaAng * dt * dt,
            omega: d.omega + d.alphaAng * dt,
            slosh: {
              offset: (sloshNow.offset || 0) + (sloshNow.velocity || 0) * dt,
              velocity: sloshNow.velocity || 0,
            },
          });
        }

        const cfg = _constants;
        const restingArea = (_missionCtx && _missionCtx.restingArea) || null;
        const midWestDeg =
          restingArea && Number.isFinite(restingArea.midWestDeg)
            ? restingArea.midWestDeg
            : env.REMOTE_AREA_MID_WEST_DEG || 0;

        switch (_st.phase) {
          // ==========================================================
          case "SUICIDE_ROTATE": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            const elapsed = simT - _st.phaseStart;
            if (elapsed >= cfg.SUICIDE_ROTATE_TIMEOUT_S) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "SUICIDE_BURN";
              _st.phaseStart = simT;
              _st.suicideBurnStartT = simT;
              break;
            }

            const speed = Math.hypot(body.vx, body.vy);
            if (speed < 1) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "SUICIDE_BURN";
              _st.phaseStart = simT;
              _st.suicideBurnStartT = simT;
              break;
            }
            const ux_v = body.vx / speed;
            const uy_v = body.vy / speed;
            const targetThetaRad = Math.atan2(ux_v, -uy_v);

            const thetaErr = _wrapPi(body.theta - targetThetaRad);
            const omegaRel = body.omega;
            if (
              Math.abs(thetaErr) <
                (cfg.SUICIDE_ROTATE_TOL_DEG * Math.PI) / 180 &&
              Math.abs(omegaRel) < cfg.SUICIDE_ROTATE_OMEGA_TOL
            ) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "SUICIDE_BURN";
              _st.phaseStart = simT;
              _st.suicideBurnStartT = simT;
              break;
            }

            const I_next = dNext && dNext.massProps ? dNext.massProps.I : 0;
            if (!(I_next > 0)) {
              _send(Guidance.cmdRcsDuty(null, idx));
              break;
            }
            const tau_desired =
              -I_next *
              (cfg.SUICIDE_ATT_KP * thetaErr + cfg.SUICIDE_ATT_KD * omegaRel);

            const result = GuideRCS.targetTorqueRcsNoNetForce(
              snapshot,
              tau_desired,
              idx,
            );
            if (result && result.fires.length)
              _send(Guidance.cmdRcsDuty(result.duties, idx));
            else _send(Guidance.cmdRcsDuty(null, idx));
            break;
          }

          // ==========================================================
          case "SUICIDE_BURN": {
            const burnS = simT - _st.suicideBurnStartT;
            if (burnS >= cfg.SUICIDE_BURN_MAX_S) {
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.phase = "SUICIDE_COAST";
              _st.phaseStart = simT;
              break;
            }

            const spoolS = body.engines[0].shutdownDurationS;
            let mdot_now_sb = 0,
              maxMFR_sb = 0;
            (body.engines || []).forEach((e) => {
              mdot_now_sb += e.massFlowRate || 0;
              if (
                Number.isFinite(e.maxMassFlowRate) &&
                e.maxMassFlowRate > maxMFR_sb
              ) {
                maxMFR_sb = e.maxMassFlowRate;
              }
            });
            const t_spool_sb =
              maxMFR_sb > 0 && mdot_now_sb > 0
                ? (mdot_now_sb * spoolS) / maxMFR_sb
                : spoolS;
            const dv_spool_sb =
              ((mdot_now_sb / 2) * body.engines[0].Ve * t_spool_sb) /
              Math.max(1, dNext.massProps.M);

            const ux_nose = -Math.sin(body.theta);
            const uy_nose = Math.cos(body.theta);
            const impact = _predictImpact(
              body.rx,
              body.ry,
              body.vx + ux_nose * dv_spool_sb,
              body.vy + uy_nose * dv_spool_sb,
              simT,
              cfg.SUICIDE_PREDICT_DT_S,
              cfg.SUICIDE_PREDICT_HORIZON_S,
              env.GM_EARTH,
              env.EARTH_RADIUS,
              env.EARTH_OMEGA,
            );

            if (impact) {
  const lambdaMidEf =
    (env.LAUNCH_SITE_ANGLE_0 || 0) - (midWestDeg * Math.PI) / 180;
  const lambdaCoarseEf =
    lambdaMidEf -
    (cfg.SUICIDE_BURN_COARSE_MARGIN_DEG * Math.PI) / 180;
  let dLambda = impact.phiEf - lambdaCoarseEf;
  // Wrap to [-π, π] for the same reason as the coast case:
  // the raw difference can be ±2π off when impact and target
  // straddle the ±180° meridian. Without this, cutoff fires
  // wildly early (at impact ≈ +166° instead of near the target).
  while (dLambda > Math.PI) dLambda -= 2 * Math.PI;
  while (dLambda < -Math.PI) dLambda += 2 * Math.PI;
  _st.suicideImpactEf = impact.phiEf;
  _st.suicideDlambda = dLambda;
  
  if (dLambda <= 0) {
    
                _send(Guidance.cmdSetAllThrottle(0));
                _send(Guidance.cmdSetGimbalRate(0));
                _send(Guidance.cmdRcsDuty(null, idx));
                _st.phase = "SUICIDE_COAST";
                _st.phaseStart = simT;
                break;
              }
            }

            _send(Guidance.cmdSetAllThrottle(0.001));

            const gimbals = (body.engines || []).filter((e) => e.gimbal);
            if (gimbals.length && dNext && dNext.massProps) {
              const speed = Math.hypot(body.vx, body.vy);
              if (speed > 1) {
                const ux_v = body.vx / speed;
                const uy_v = body.vy / speed;
                const targetThetaRad = Math.atan2(ux_v, -uy_v);
                const I_next = dNext.massProps.I;
                const thetaErr = _wrapPi(body.theta - targetThetaRad);
                const tau_desired =
                  -I_next *
                  (cfg.SUICIDE_ATT_KP * thetaErr +
                    cfg.SUICIDE_ATT_KD * body.omega);
                const g_N = gimbals[0].gimbalDeg || 0;
                const comX1 = dNext.massProps.comX;
                const comY1 = dNext.massProps.comY;
                let A_g = 0,
                  B_g = 0;
                gimbals.forEach((e) => {
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
                  const w1 = _wrapPi(Math.asin(ratio) - phi);
                  const w2 = _wrapPi(Math.PI - Math.asin(ratio) - phi);
                  g_req_rad = Math.abs(w1) <= Math.abs(w2) ? w1 : w2;
                }
                let g_req_deg = (g_req_rad * 180) / Math.PI;
                const _gMax = gimbals[0].gimbalMaxDeg;
                if (Math.abs(g_req_deg) > _gMax) {
                  g_req_deg = Math.sign(g_req_deg) * _gMax;
                }
                _send(_gimbalCmdMsg(g_req_deg, gimbals[0], dt));
              }
            }
            break;
          }

          // ==========================================================
          case "SUICIDE_COAST": {
  _send(Guidance.cmdSetAllThrottle(0));
  _send(Guidance.cmdSetGimbalRate(0));
  
  if (_st.suicideTrimDone) {
    _send(Guidance.cmdRcsDuty(null, idx));
    break;
  }
  
  if (_st.suicideTrimStartT === 0) _st.suicideTrimStartT = simT;
  if (simT - _st.suicideTrimStartT > cfg.SUICIDE_TRIM_MAX_S) {
    _st.suicideTrimDone = true;
    _send(Guidance.cmdRcsDuty(null, idx));
    _done = true;
    _result = {
      bodyIdx: _bodyIdx,
      trimConverged: false,
      trimTimedOut: true,
      suicideImpactEfDeg: _st.suicideImpactEf != null ?
        (_st.suicideImpactEf * 180) / Math.PI : null,
      suicideDlambdaDeg: _st.suicideDlambda != null ?
        (_st.suicideDlambda * 180) / Math.PI : null,
    };
    break;
  }
  
  const lambdaMidEf =
    (env.LAUNCH_SITE_ANGLE_0 || 0) - (midWestDeg * Math.PI) / 180;
  
  const impact = _predictImpact(
    body.rx, body.ry, body.vx, body.vy, simT,
    cfg.SUICIDE_PREDICT_DT_S, cfg.SUICIDE_PREDICT_HORIZON_S,
    env.GM_EARTH, env.EARTH_RADIUS, env.EARTH_OMEGA);
  
  if (!impact) {
    _send(Guidance.cmdRcsDuty(null, idx));
    break;
  }
  
  let E_rad = impact.phiEf - lambdaMidEf;
  while (E_rad > Math.PI) E_rad -= 2 * Math.PI;
  while (E_rad < -Math.PI) E_rad += 2 * Math.PI;
  _st.suicideImpactEf = impact.phiEf;
  _st.suicideDlambda = E_rad;
  const E_deg = E_rad * 180 / Math.PI;
  
  // Converged → RCS off, done.
  if (Math.abs(E_deg) < cfg.SUICIDE_TRIM_TOL_DEG) {
    _st.suicideTrimDone = true;
    _send(Guidance.cmdRcsDuty(null, idx));
    _done = true;
    _result = {
      bodyIdx: _bodyIdx,
      trimConverged: true,
      trimTimedOut: false,
      suicideImpactEfDeg: impact.phiEf * 180 / Math.PI,
      suicideDlambdaDeg: E_deg,
    };
    break;
  }
  
  // ---- Lead-compensated proportional trim ----
  // dE/dt from last tick. Lead error predicts τ seconds ahead.
  // When E is closing rapidly (dE has opposite sign to E),
  // E_lead is smaller than E and can cross zero BEFORE E does,
  // so firing stops before overshoot. τ tunes how far we look
  // ahead.
  const prevE = _st._prevTrimE_rad;
  _st._prevTrimE_rad = E_rad;
  const dE = (Number.isFinite(prevE) && dt > 0) ?
    (E_rad - prevE) / dt : 0;
  const tau = Number.isFinite(cfg.SUICIDE_TRIM_LEAD_S) ?
    cfg.SUICIDE_TRIM_LEAD_S : 10;
  const E_lead_deg = (E_rad + tau * dE) * 180 / Math.PI;
  
  // Direction from the LEAD error's sign (not raw E). When lead
  // crosses zero, direction flips too — firing reverses to
  // catch any residual drift.
  const direction = E_lead_deg > 0 ? "up" : "dn";
  
  // Proportional duty on lead error. NO floor — duty freely
  // goes to zero as E_lead → 0. That's the fix for overshoot:
  // previously MIN_DUTY forced 3% firing at tiny errors, which
  // accumulated into a huge overshoot over the remaining fall.
  const FAR = cfg.SUICIDE_TRIM_FAR_DEG;
  let duty = Math.min(1, Math.abs(E_lead_deg) / Math.max(FAR, 1e-6));
  
  // Deadband is a chatter guard, NOT a floor — it means "don't
  // fire at all when lead error is negligible", not "fire at
  // least this much".
  const DEADBAND_DUTY = 0.02;
  if (duty < DEADBAND_DUTY) {
    _send(Guidance.cmdRcsDuty(null, idx));
    break;
  }
  
  const duties = GuideRCS.postSeparationAxialDuty(snapshot, idx, direction);
  if (!duties) {
    _send(Guidance.cmdRcsDuty(null, idx));
    break;
  }
  Object.keys(duties).forEach((podId) => {
    const dd = duties[podId];
    if (!dd) return;
    dd.up *= duty;
    dd.dn *= duty;
    dd.lat *= duty;
  });
  _send(Guidance.cmdRcsDuty(duties, idx));
  break;
}

          default:
            break;
        }
      }

      return {
        start(constants, bodyIdx, missionCtx) {
          if (!constants) throw new Error("suicide.start: constants required");
          if (!Number.isInteger(bodyIdx))
            throw new Error("suicide.start: bodyIdx required");
          _constants = JSON.parse(JSON.stringify(constants));
          _bodyIdx = bodyIdx;
          _missionCtx = missionCtx || {};
          _done = false;
          _result = null;

          _st.init = false;
          _st.ticks = 0;
          _st.phase = "SUICIDE_ROTATE";
          _st.phaseStart = 0;
          _st.suicideBurnStartT = 0;
          _st.suicideImpactEf = null;
          _st.suicideDlambda = null;
              _st.suicideTrimDone = false;
  _st.suicideTrimStartT = 0;
  },

        tick(snapshot) {
          if (_done) return;
          if (!snapshot || !snapshot.bodies || !snapshot.bodies[_bodyIdx])
            return;
          _tick(snapshot);
        },

        stop() {
          _send(Guidance.cmdSetAllThrottle(0));
          _send(Guidance.cmdSetGimbalRate(0));
          _send(Guidance.cmdRcsDuty(null));
          _st.init = false;
          _done = false;
        },

        isDone() {
          return _done;
        },
        getResult() {
          return _result ? Object.assign({}, _result) : null;
        },
        getStatus() {
          return {
            phase: _st.phase,
            ticks: _st.ticks,
            suicideImpactEfDeg:
              _st.suicideImpactEf != null
                ? (_st.suicideImpactEf * 180) / Math.PI
                : null,
            suicideDlambdaDeg:
              _st.suicideDlambda != null
                ? (_st.suicideDlambda * 180) / Math.PI
                : null,
            suicideTrimDone: !!_st.suicideTrimDone,
          };
        },
        getBodyIdx() {
          return _bodyIdx;
        },
        getState() {
  return {
    bodyIdx: _bodyIdx,
    constants: _constants ? JSON.parse(JSON.stringify(_constants)) : null,
    missionCtx: _missionCtx ? JSON.parse(JSON.stringify(_missionCtx)) : null,
    done: _done,
    result: _result ? JSON.parse(JSON.stringify(_result)) : null,
    st: JSON.parse(JSON.stringify(_st)),
  };
},
setState(s) {
  if (!s) return;
  _bodyIdx = Number.isInteger(s.bodyIdx) ? s.bodyIdx : null;
  _constants = s.constants ? JSON.parse(JSON.stringify(s.constants)) : null;
  _missionCtx = s.missionCtx ? JSON.parse(JSON.stringify(s.missionCtx)) : {};
  _done = !!s.done;
  _result = s.result ? JSON.parse(JSON.stringify(s.result)) : null;
  if (s.st) Object.assign(_st, s.st);
},
        getConstants() {
          return _constants ? JSON.parse(JSON.stringify(_constants)) : null;
        },
        setConstants(patch) {
          if (_constants && patch) Object.assign(_constants, patch);
        },
      };
    },
  },

  // ==========================================================================
  // STANDARD_RTLS — booster return-to-launch-site ("Landback")
  //
  // Runs on the BOOSTER body only (same control authority as `ascent`:
  // booster engines / gimbal / grid fins / RCS). Starts right after stage
  // separation and ends when the booster is on the pad.
  //
  // Internal phases, in order:
  //   FLIP             — flip manoeuvre (turn engines-first → retrograde/boostback attitude)
  //   BOOSTBACK_BURN   — boostback burn, cancels downrange velocity, targets the pad
  //   PRE_ENTRY_STEER  — attitude / grid-fin steering into the entry-burn window
  //   ENTRY_BURN       — entry burn (slows the booster before dense atmosphere)
  //   POST_ENTRY_STEER — aerodynamic steering (grid fins) down to the landing-burn window
  //   LANDING_BURN     — suicide-style landing burn, legs deploy
  //   TOUCHDOWN        — engines off, confirm contact, block ends
  //
  // Lifecycle, phase machine, status and save/restore are real. FLIP is
  // implemented; the other phase handlers are TODO stubs that return false
  // ("not done yet") and simply hold the phase until they are written. A
  // handler returns true when its exit condition is met. A phase gets a
  // timeout only if its <PHASE>_TIMEOUT_S constant exists (see TIMEOUT_KEY).
  // ==========================================================================
  standardRTLS: {
    name: "standardRTLS",
    displayName: "Standard RTLS (Landback)",
    description:
      "Booster return-to-launch-site. Flip → boostback → pre-entry steer → entry burn → post-entry steer → landing burn → touchdown. Controls the booster body only.",
    phases: [
      "FLIP",
      "BOOSTBACK_BURN",
      "PRE_ENTRY_STEER",
      "ENTRY_BURN",
      "POST_ENTRY_STEER",
      "LANDING_BURN",
      "TOUCHDOWN",
    ],
    defaultConstants: {
      // FLIP — exit window + safety timeout. (Constants for later phases get
      // added as each phase is defined.)
      FLIP_ROTATE_TOL_DEG: 0.5,   // done when |angle error| < this ...
      FLIP_OMEGA_TOL: 0.005,      // ... and |relative omega| < this (rad/s)
      FLIP_TIMEOUT_S: 120,
      // BOOSTBACK_BURN
      BOOSTBACK_ENGINES: "C,0,180",       // engines fired for the burn: "C" = centre, numbers = outer-ring angleDeg (0 / 180 = the two extreme left/right engines)
      BOOSTBACK_APPARENT_OFFSET_M: 0,      // aim at (target pad + this) ground distance, metres; + = east of the pad (short), - = west
      BOOSTBACK_SIDE_CUT_M: 20000,         // outer engines off when impact is within this ground distance of the apparent target (m)
      BOOSTBACK_TAPER_M: 150000,           // throttle (all burn engines) fades 100% -> floor over the last this-many metres of error
      // PRE_ENTRY_STEER — altitude-triggered alignment + entry-burn handoff.
      // Both are guesses — tune in sim.
      PRE_ENTRY_ALIGN_ALT_KM: 100,         // start RCS alignment at this altitude AGL on descent (user, Chat 5)
      ENTRY_BURN_ALT_KM: 60,               // transition to ENTRY_BURN at this altitude AGL
      // ENTRY_BURN
      ENTRY_BURN_ENGINES: "C,0,180",       // engines lit at FULL throttle: "C" = centre, numbers = outer-ring angleDeg
      ENTRY_BURN_GIMBAL_ENGINES: "C",      // engines that gimbal to cancel env torque (subset of above; expand if SATURATED)
      ENTRY_BURN_CUTOFF_VELOCITY_MS: 600,  // cutoff when Earth-relative speed falls to this value
      ENTRY_BURN_IMPACT_TARGET_M: -1480,   // m: bias burn target west so post-cutoff drag/fin drift lands near pad
      // POST_ENTRY_STEER
      POST_ENTRY_GRIDFIN_RAMP_DEG_S: 3,    // grid-fin control target ramps 0 -> max at this rate (deg/s); slower = less oscillation (guess, tune in sim)
    },
    importantFields: [],
    createInstance: function () {
      let _constants = null;
      let _bodyIdx = null;
      let _missionCtx = null;
      let _done = false;
      let _result = null;

      const PHASES = [
        "FLIP", "BOOSTBACK_BURN", "PRE_ENTRY_STEER", "ENTRY_BURN",
        "POST_ENTRY_STEER", "LANDING_BURN", "TOUCHDOWN",
      ];
      const TIMEOUT_KEY = {
        FLIP: "FLIP_TIMEOUT_S",
        BOOSTBACK_BURN: "BOOSTBACK_TIMEOUT_S",
        PRE_ENTRY_STEER: "PRE_ENTRY_TIMEOUT_S",
        ENTRY_BURN: "ENTRY_BURN_TIMEOUT_S",
        POST_ENTRY_STEER: "POST_ENTRY_TIMEOUT_S",
        LANDING_BURN: "LANDING_TIMEOUT_S",
        TOUCHDOWN: "TOUCHDOWN_TIMEOUT_S",
      };

      const _st = {
        init: false,
        ticks: 0,
        phase: "FLIP",
        phaseStart: 0,
        startSimTime: null,
        phaseLog: {},          // { [phase]: { startT, endT, reason } }
        lastAltKm: 0,
        // ---- FLIP scratch ----
        lastRcsTorque: 0,      // torque (N·m) of the RCS command sent LAST tick (= what is applied now)
        flipInit: false,
        flipDir: 0,            // committed rotation direction (+1 / -1), chosen on the first FLIP tick
        flipEu: 0,             // unwrapped angle error along the committed direction (target - theta)
        flipPrevRaw: 0,
        flipPrevTgt: null,
        flipPrevT: null,
        flipMode: null,        // ACCEL | BRAKE | TRIM
        flipErrDeg: null,
        flipOmegaDegS: null,
        flipTgtDeg: null,
        // ---- BOOSTBACK scratch ----
        bbInit: false,
        bbStage: null,         // THREE | CENTER | SPOOL
        bbSpooled: false,      // burn-set engines reached >=99% max flow once (attitude control starts only then)
        bbSign: 0,             // +1/-1: direction of the horizontal velocity at burn start (attitude is held opposite to it, even after the velocity reverses)
        bbPrevTgt: null,
        bbPrevT: null,
        bbErrDeg: null,        // predicted impact - apparent target (Earth-fixed deg, + = east)
        bbImpactEfDeg: null,
        bbTargetEfDeg: null,
        bbThrFrac: null,
        // ---- PRE_ENTRY_STEER scratch ----
        preEntryInit: false,
        preEntrySub: null,             // COAST | ALIGN | HOLD
        preEntryAlignInit: false,
        preEntryEu: 0,                 // unwrapped angle error along committed direction
        preEntryPrevRaw: 0,
        preEntryErrDeg: null,
        preEntryOmegaDegS: null,
        preEntryTgtDeg: null,
        preEntryMode: null,            // ACCEL | BRAKE | TRIM (during ALIGN)
        preEntryPrevTgt: null,         // last-tick target theta (for wTgt/dTgt)
        preEntryPrevT: null,           // last-tick simTime
        // ---- ENTRY_BURN scratch ----
        ebInit: false,
        ebSpooled: false,
        ebStage: null,
        ebSpeedMs: null,
        ebPrevTgt: null,
        ebPrevT: null,
        ebErrDeg: null,
        ebAlphaDeg: null,
        ebGimbalDeg: null,
        ebGimbalReqDeg: null,
        ebGimbalSat: false,
        ebThrFrac: null,
        ebTauEnv: null,
        ebTauAvail: null,
        // Add other per-phase scratch state here
      };

      function _send(cmd) {
        if (!cmd) return;
        if (cmd.targetBodyIdx === undefined) cmd.targetBodyIdx = _bodyIdx;
        Guidance.send(cmd);
      }

      function _wrapPi(x) {
        while (x > Math.PI) x -= 2 * Math.PI;
        while (x < -Math.PI) x += 2 * Math.PI;
        return x;
      }

      // Move to `next` (or finish the block if `next` is null).
      function _goto(next, simT, reason) {
        const cur = _st.phase;
        if (cur === "FLIP" || cur === "BOOSTBACK_BURN" || cur === "PRE_ENTRY_STEER") {
          _send(Guidance.cmdRcsDuty(null, _bodyIdx));
          _st.lastRcsTorque = 0;
        }
        if (cur === "ENTRY_BURN") {
          _send(Guidance.cmdSetAllThrottle(0));
          _send(Guidance.cmdSetGimbalRate(0));
          _send(Guidance.cmdRcsDuty(null, _bodyIdx));
          _st.lastRcsTorque = 0;
        }
        if (_st.phaseLog[cur]) {
          _st.phaseLog[cur].endT = simT;
          _st.phaseLog[cur].reason = reason || "done";
        }
        if (!next) {
          _done = true;
          _result = {
            doneSimTime: simT,
            elapsed: simT - (_st.startSimTime || 0),
            phaseLog: JSON.parse(JSON.stringify(_st.phaseLog)),
          };
          console.log("[standardRTLS] DONE at t=" + simT.toFixed(2));
          return;
        }
        _st.phase = next;
        _st.phaseStart = simT;
        _st.phaseLog[next] = { startT: simT, endT: null, reason: null };
        console.log("[standardRTLS] " + cur + " → " + next + " at t=" + simT.toFixed(2) + " (" + (reason || "done") + ")");
      }

      // ---------------------------------------------------------------------
      // Phase helpers. The phases themselves are `case`s of the switch in _tick()
      // (same style as the other blocks): set `finished = true; break;` to leave a phase.
      // ---------------------------------------------------------------------
      // ---- FLIP helpers ---------------------------------------------------
      // Body angle that puts the NOSE exactly opposite to the local-horizontal
      // (tangential) component of the inertial velocity. Nose = (-sinθ, cosθ).
      function _flipTargetTheta(rx, ry, vx, vy) {
        const r = Math.hypot(rx, ry);
        if (!(r > 1)) return null;
        const hx = rx / r, hy = ry / r;               // local vertical
        const vr = vx * hx + vy * hy;
        const tx = vx - vr * hx, ty = vy - vr * hy;   // tangential velocity
        const tm = Math.hypot(tx, ty);
        if (!(tm > 1e-3)) return null;
        return Math.atan2(tx / tm, -ty / tm);         // nose = -t̂
      }

      // Max RCS torque available each way (N·m, both >= 0). Asking
      // targetTorqueRcs for an absurd torque fires every helping nozzle at
      // duty 1, so the result is both the max torque and the full-duty table.
      function _rcsMaxTorques(snapshot) {
        const BIG = 1e12;
        const sum = (r) => (r && r.fires ? r.fires.reduce((a, f) => a + f.torque, 0) : 0);
        const rp = GuideRCS.targetTorqueRcs(snapshot, +BIG, _bodyIdx);
        const rn = GuideRCS.targetTorqueRcs(snapshot, -BIG, _bodyIdx);
        return { pos: Math.max(0, sum(rp)), neg: Math.max(0, -sum(rn)), rp: rp, rn: rn };
      }

      function _rcsOff() {
        _send(Guidance.cmdRcsDuty(null, _bodyIdx));
        _st.lastRcsTorque = 0;
      }

      // Min time to cover distance D from rest to rest: accelerate at a, brake at b.
      function _flipRestToRest(D, a, b) {
        const v = Math.sqrt(2 * D / (1 / a + 1 / b));
        return v / a + v / b;
      }

      // Min time (full torque, bang-bang) to bring signed error e to 0 at rest,
      // starting with relative omega w. aPos / aNeg = angular accel available
      // with +/- torque (rad/s²).
      function _flipTime(e, w, aPos, aNeg) {
        const sgn = e >= 0 ? 1 : -1;
        const a = sgn > 0 ? aPos : aNeg;     // accelerates toward the target
        const b = sgn > 0 ? aNeg : aPos;     // brakes
        const D = Math.abs(e);
        const wt = w * sgn;                  // omega component toward the target
        if (wt >= 0) {
          const stop = wt * wt / (2 * b);
          if (stop <= D) {                   // can accelerate a bit more, then brake
            const vp = Math.sqrt((D + wt * wt / (2 * a)) / (1 / (2 * a) + 1 / (2 * b)));
            return (vp - wt) / a + vp / b;
          }
          return wt / b + _flipRestToRest(stop - D, b, a);   // unavoidable overshoot, come back
        }
        const dAway = wt * wt / (2 * a);     // first cancel the spin that carries us away
        return Math.abs(wt) / a + _flipRestToRest(D + dAway, a, b);
      }

      // FLIP — fastest rotation (RCS only), nose → opposite the local-horizontal
      // velocity. Pure bang-bang:
      //   * FIRST TICK: look at the state (angle error + omega + torque available
      //     each way) and pick the way round that is fastest — the direction the
      //     booster is already spinning wins unless the other way is genuinely
      //     quicker. That direction is then committed (error is tracked unwrapped
      //     along it, so it never flips to the long/short route mid-flip).
      //   * every tick: target + error + omega are live; the state is predicted ONE
      //     tick ahead using the RCS torque currently applied (the command computed
      //     now only takes effect next tick).
      //   * full torque toward the target; as soon as the stopping angle
      //     (w²/2a_brake) reaches the remaining error → full torque the other way.
      //   * only the last braking tick is trimmed (just enough to zero omega).

      // ---- later phases: TODO ----
      // ---- BOOSTBACK helpers ----------------------------------------------
      const BB_PRED_DT = 1.0;       // s, leapfrog step of the ballistic impact predictor
      const BB_PRED_MAX_S = 2500;   // s, prediction horizon
      const BB_ATT_KP = 0.5;        // attitude hold (same law + gains as the suicide block)
      const BB_ATT_KD = 4.0;
      const BB_FUEL_EMPTY_KG = 1;

      // "C,0,180" -> ["C", 0, 180]. "C" = centre engine, numbers = outer-ring engine angleDeg.
      function _bbTokens(cfg) {
        const raw = String(cfg.BOOSTBACK_ENGINES == null ? "C,0,180" : cfg.BOOSTBACK_ENGINES);
        const toks = [];
        raw.split(",").forEach(function (s) {
          const t = s.trim();
          if (!t) return;
          if (t.toUpperCase() === "C") toks.push("C");
          else if (Number.isFinite(Number(t))) toks.push(Number(t));
        });
        return toks;
      }
      function _bbInSet(e, toks) {
        for (let i = 0; i < toks.length; i++) {
          const t = toks[i];
          if (t === "C") { if (e.isCenter) return true; }
          else if (!e.isCenter && Number.isFinite(e.angleDeg) &&
                   Math.abs(_wrapPi((e.angleDeg - t) * Math.PI / 180)) < 1e-6) return true;
        }
        return false;
      }
      // Throttle command (kg/s per engine; Infinity = that engine's max) for a set of engines.
      function _bbThrottle(set, value) {
        const angles = [];
        let center = false;
        set.forEach(function (e) { if (e.isCenter) center = true; else angles.push(e.angleDeg); });
        if (center) _send(Guidance.cmdSetCenterThrottle(value));
        if (angles.length) _send(Guidance.cmdSetGroupThrottle(angles, value));
      }
      // ENTRY_BURN tokenizer — same semantics as _bbTokens but generic string,
      // so the config string can be edited without touching the block.
      function _ebTokens(raw, fallback) {
        const toks = [];
        String(raw == null ? fallback : raw).split(",").forEach(function (s) {
          const t = s.trim();
          if (!t) return;
          if (t.toUpperCase() === "C") toks.push("C");
          else if (Number.isFinite(Number(t))) toks.push(Number(t));
        });
        return toks;
      }
      const EB_ATT_KP = 0.5;
      const EB_ATT_KD = 4.0;
      const EB_VDOT_TAU_S = 0.5;
      const EB_ERATE_TAU_S = 0.25;
      const EB_WARMUP_S = 0.5;
      const EB_TOL_M = 100;
      const EB_TGO_MIN_S = 0.5;
      const EB_W_TOL = 0.002;
// ---- POST_ENTRY_STEER closed-loop helpers (v4, all internal) ----
      const PES_TAU_E_S = 40;
      const PES_KP = 0.05;
      const PES_KD = 0.6;
      const PES_ALPHA_MAX_DEG = 12;
      const PES_DTH_MAX_DEG = 1.5;
      const PES_J_MIN = 0.3;
      const PES_JH_MIN = 1e3;
      const PES_CTRL_CAP_DEG = 30;
      const PES_FIN_STEP_DEG = 5;
      const PES_FIN_RATE_DEGS = 40;
      const PES_RCS_DEADBAND_NM = 500;
      const PES_RCS_MARGIN = 0.8;
      const PES_VALIDATE_S = 6;

      function _pesAeroAccel(ds, M) {
        let fxb = 0;
        (ds.memberBreakdown || []).forEach(function (m) {
          fxb += (m.Fnormal_linear || 0) + (m.Fnormal_crossflow || 0);
        });
        // Physics consistency: sim's derivatives() has ax = grav + (thrust + dragVec + gridFin)/M.
        // Fnormal (hull lift) enters ONLY dragTorque (attitude), NOT linear force.
        const fx = ds.dragVecX + (ds.gridFinFx || 0);
        const fy = ds.dragVecY + (ds.gridFinFy || 0);
        return { ax: fx / M, ay: fy / M, fxb: fxb };
      }

      function _pesRcsAch(res) {
        if (!res) return 0;
        if (Number.isFinite(res.torqueAchieved)) return res.torqueAchieved;
        return res.fires ? res.fires.reduce(function (a, f) { return a + f.torque * (Number.isFinite(f.duty) ? f.duty : 1); }, 0) : 0;
      }
      // Lateral-only RCS: balanced lateral pairs (TR+BL for +τ, TL+BR for -τ). No up/dn.
      function _pesRcsLateralOnly(snapshot, idx, targetTorque) {
        if (!snapshot || !snapshot.bodies) return null;
        const body = snapshot.bodies[idx];
        if (!body || !Array.isArray(body.pods)) return null;
        if (!Number.isFinite(targetTorque)) return null;
        const d = Derivation.derive(snapshot, idx);
        if (!d || !d.massProps) return null;
        const bySide = { L: [], R: [] };
        body.pods.forEach(function(p){ if (p.side === 'L' || p.side === 'R') bySide[p.side].push(p); });
        bySide.L.sort(function(a,b){ return (b.offsetFromStackBase||0)-(a.offsetFromStackBase||0); });
        bySide.R.sort(function(a,b){ return (b.offsetFromStackBase||0)-(a.offsetFromStackBase||0); });
        if (!bySide.L.length || !bySide.R.length) return null;
        const topL = bySide.L[0], botL = bySide.L[bySide.L.length-1];
        const topR = bySide.R[0], botR = bySide.R[bySide.R.length-1];
        const refM = body.members[topL.memberIdx];
        if (!refM || !refM.rcsThruster) return null;
        const refT = Derivation.getTypeById(refM.rcsThruster.thrusterTypeId);
        if (!refT) return null;
        const ve = Derivation.typeParam(refT, 've');
        const mdot = refM.rcsThruster.massFlowRate;
        if (!Number.isFinite(ve) || !Number.isFinite(mdot)) return null;
        const F = mdot * ve;
        if (!(F > 0)) return null;
        const yTop = topL.offsetFromStackBase || 0;
        const yBot = botL.offsetFromStackBase || 0;
        const tauL_max = Math.max(0, (yTop - yBot) * F);
        const absTau = Math.abs(targetTorque);
        const sign = targetTorque >= 0 ? 1 : -1;
        const duty = tauL_max > 0 ? Math.min(1, absTau / tauL_max) : 0;
        const duties = {};
        if (sign > 0 && duty > 1e-9) {
          duties[topR.podId] = { up: 0, dn: 0, lat: duty };
          duties[botL.podId] = { up: 0, dn: 0, lat: duty };
        } else if (sign < 0 && duty > 1e-9) {
          duties[topL.podId] = { up: 0, dn: 0, lat: duty };
          duties[botR.podId] = { up: 0, dn: 0, lat: duty };
        }
        return {
          fires: [],
          duties: duties,
          torqueAchieved: sign * duty * tauL_max,
          saturated: absTau > tauL_max,
          tauL_max: tauL_max,
          F: F,
        };
      }

      function _pesRcsMax(snapshot, idx) {
        const BIG = 1e12;
        const rp = _pesRcsLateralOnly(snapshot, idx, +BIG);
        const rn = _pesRcsLateralOnly(snapshot, idx, -BIG);
        return { pos: Math.max(0, _pesRcsAch(rp)), neg: Math.max(0, -_pesRcsAch(rn)) };
      }


      function _pesAeroAccel(ds, M) {
        let fxb = 0;
        (ds.memberBreakdown || []).forEach(function (m) {
          fxb += (m.Fnormal_linear || 0) + (m.Fnormal_crossflow || 0);
        });
        // Physics consistency: sim's derivatives() has ax = grav + (thrust + dragVec + gridFin)/M.
        // Fnormal (hull lift) enters ONLY dragTorque (attitude), NOT linear force.
        const fx = ds.dragVecX + (ds.gridFinFx || 0);
        const fy = ds.dragVecY + (ds.gridFinFy || 0);
        return { ax: fx / M, ay: fy / M, fxb: fxb };
      }
      // dv (m/s) still delivered while the given engines spool down from their CURRENT flow
      // (linear ramp to zero over shutdownDurationS, scaled by flow/maxFlow — same model as ascent MECO).
      function _bbSpoolDv(engs, M) {
        let imp = 0;
        engs.forEach(function (e) {
          const mf = e.massFlowRate || 0, mM = e.maxMassFlowRate || 0;
          if (!(mf > 0 && mM > 0)) return;
          const sd = (Number.isFinite(e.shutdownDurationS) && e.shutdownDurationS > 0) ? e.shutdownDurationS : 1.2;
          imp += mf * (e.Ve || 0) * (mf * sd / mM) / 2;
        });
        return imp / Math.max(1, M);
      }
      // Ballistic (vacuum, point-mass) impact predictor — leapfrog, same scheme as the suicide
      // block, plus linear interpolation of the surface crossing. Returns Earth-fixed angle.
      function _bbImpact(rx, ry, vx, vy, simTimeNow, GM, R, omegaE) {
        const dtp = BB_PRED_DT;
        let px = rx, py = ry, pvx = vx, pvy = vy, t = 0;
        let r = Math.hypot(px, py);
        if (r <= R) return null;
        while (t < BB_PRED_MAX_S) {
          const r3 = r * r * r;
          const vxh = pvx + 0.5 * (-GM * px / r3) * dtp;
          const vyh = pvy + 0.5 * (-GM * py / r3) * dtp;
          const nx = px + vxh * dtp, ny = py + vyh * dtp;
          const nr = Math.hypot(nx, ny);
          if (nr <= R) {
            const f = (r - R) / Math.max(1e-9, r - nr);
            const ix = px + (nx - px) * f, iy = py + (ny - py) * f;
            const ti = t + f * dtp;
            return { phiEf: Math.atan2(ix, iy) - omegaE * (simTimeNow + ti), tImpact: ti };
          }
          const nr3 = nr * nr * nr;
          pvx = vxh + 0.5 * (-GM * nx / nr3) * dtp;
          pvy = vyh + 0.5 * (-GM * ny / nr3) * dtp;
          px = nx; py = ny; r = nr; t += dtp;
        }
        return null;
      }

      // BOOSTBACK_BURN — retro burn that moves the ballistic impact point to the APPARENT target
      // (= target pad + BOOSTBACK_APPARENT_OFFSET_M, Earth-fixed).
      //   THREE  : engines in BOOSTBACK_ENGINES (default centre + the two extreme outer engines,
      //            0 deg and 180 deg), throttle 100 % until error < BOOSTBACK_TAPER_M, then fading
      //            linearly to the throttle floor as error -> 0.
      //   CENTER : when impact error <= BOOSTBACK_SIDE_CUT_M the outer engines are shut off and
      //            the centre engine finishes the job on the same fade curve.
      //   SPOOL  : cutoff (spool-down dv included in the prediction); attitude hold continues until
      //            thrust is gone, then the phase ends.
      // Impact error = predicted Earth-fixed impact angle - apparent target angle (+ = east of it,
      // i.e. still short; the burn drives it down to 0). Attitude: nose opposite the local-horizontal
      // velocity (same target as FLIP), held with the CENTRE engine gimbal only (predictive law copied from circularize).

      function _tick(snapshot) {
        _st.ticks++;
        const body = snapshot.bodies[_bodyIdx];
        if (!body) return;
        const simT = snapshot.simTime;
        const cfg = _constants;

        if (!_st.init) {
          _st.init = true;
          _st.startSimTime = simT;
          _st.phaseStart = simT;
          _st.phaseLog[_st.phase] = { startT: simT, endT: null, reason: null };
        }

        const d = Derivation.derive(snapshot, _bodyIdx);
        if (!d || !d.massProps) return;
        _st.lastAltKm = d.altitudeAGL / 1000;

        let finished = false;
        switch (_st.phase) {
          // ==========================================================
          case "FLIP": {
            const idx = _bodyIdx;
            if (!snapshot.bodies[idx]) break;
            const env = Derivation.getEnv();
            const dt = env && Number.isFinite(env.DT) ? env.DT : 1 / 80;
            const I = d.massProps.I;
            if (!(I > 0)) break;
            const R2D = 180 / Math.PI;

            const tgtNow = _flipTargetTheta(d.rx, d.ry, d.vx, d.vy);
            if (tgtNow === null) { _rcsOff(); break; }
            const mx = _rcsMaxTorques(snapshot);
            if (!(mx.pos > 0) || !(mx.neg > 0)) { _rcsOff(); break; }

            // rate at which the target itself rotates (orbital motion)
            let wTgt = 0;
            if (_st.flipPrevTgt !== null && _st.flipPrevT !== null && simT > _st.flipPrevT) {
              wTgt = _wrapPi(tgtNow - _st.flipPrevTgt) / (simT - _st.flipPrevT);
              if (Math.abs(wTgt) > 0.05) wTgt = 0; // glitch guard
            }
            _st.flipPrevTgt = tgtNow;
            _st.flipPrevT = simT;
            const wRelNow = d.omega - wTgt;
            const rawErr = tgtNow - d.theta;

            if (!_st.flipInit) {
              // ---- first tick: read the state, choose the direction ----
              _st.flipInit = true;
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              const e0 = _wrapPi(rawErr);
              const ePos = e0 >= 0 ? e0 : e0 + 2 * Math.PI;   // way round in +direction
              const eNeg = ePos - 2 * Math.PI;                // way round in -direction
              const tPos = _flipTime(ePos, wRelNow, mx.pos / I, mx.neg / I);
              const tNeg = _flipTime(eNeg, wRelNow, mx.pos / I, mx.neg / I);
              // Direction FIXED to negative (clockwise): the SEPARATED_AXIAL push already tips the booster that way.
              _st.flipEu = eNeg;
              _st.flipDir = -1;
              console.log("[standardRTLS] FLIP dir=" + (_st.flipDir > 0 ? "+" : "-") +
                " err=" + (_st.flipEu * R2D).toFixed(1) + "deg omega=" + (wRelNow * R2D).toFixed(2) +
                "deg/s  t(+)=" + tPos.toFixed(1) + "s t(-)=" + tNeg.toFixed(1) + "s");
            } else {
              _st.flipEu += _wrapPi(rawErr - _st.flipPrevRaw);   // unwrapped along the committed way
            }
            _st.flipPrevRaw = rawErr;

            _st.flipTgtDeg = tgtNow * R2D;
            _st.flipErrDeg = _st.flipEu * R2D;
            _st.flipOmegaDegS = wRelNow * R2D;

            if (Math.abs(_st.flipEu) < cfg.FLIP_ROTATE_TOL_DEG / R2D &&
                Math.abs(wRelNow) < cfg.FLIP_OMEGA_TOL) {
              _rcsOff();
              finished = true; break;
            }

            // ---- one-tick-ahead prediction (current RCS torque keeps acting) ----
            const M = d.massProps.M;
            let aIx = d.gVecX, aIy = d.gVecY;
            if (M > 0) {
              const cosT = Math.cos(d.theta), sinT = Math.sin(d.theta);
              const thrIx = d.thrustBodyX * cosT - d.thrustBodyY * sinT;
              const thrIy = d.thrustBodyX * sinT + d.thrustBodyY * cosT;
              aIx += (thrIx + d.dragVecX) / M;
              aIy += (thrIy + d.dragVecY) / M;
            }
            const aTot = d.alphaAng + _st.lastRcsTorque / I;  // d.alphaAng has NO rcs term
            const dTheta = d.omega * dt + 0.5 * aTot * dt * dt;
            const wP = d.omega + aTot * dt;
            const tgtP = _flipTargetTheta(d.rx + d.vx * dt, d.ry + d.vy * dt,
                                          d.vx + aIx * dt, d.vy + aIy * dt);
            const dTgt = tgtP !== null ? _wrapPi(tgtP - tgtNow) : 0;
            const eP = _st.flipEu + dTgt - dTheta;
            const wRelP = wP - wTgt;

            // ---- bang-bang on the predicted state ----
            const sgn = eP >= 0 ? 1 : -1;
            const brakeMax = sgn > 0 ? mx.neg : mx.pos;          // torque available AGAINST the motion
            const towards = wRelP * sgn > 0;
            const stopAng = wRelP * wRelP * I / (2 * brakeMax) + Math.abs(wRelP) * dt;
            let tauCmd, fullRes = null;
            if (towards && Math.abs(eP) <= stopAng) {
              const need = I * Math.abs(wRelP) / dt;             // torque that zeroes omega in one tick
              if (need >= brakeMax) {
                _st.flipMode = "BRAKE"; fullRes = sgn > 0 ? mx.rn : mx.rp; tauCmd = -sgn * brakeMax;
              } else {
                _st.flipMode = "TRIM"; tauCmd = -sgn * need;     // last tick only: just enough
              }
            } else {
              _st.flipMode = "ACCEL"; fullRes = sgn > 0 ? mx.rp : mx.rn; tauCmd = sgn * (sgn > 0 ? mx.pos : mx.neg);
            }

            const res = fullRes || GuideRCS.targetTorqueRcs(snapshot, tauCmd, idx);
            if (res && res.fires && res.fires.length) {
              _send(Guidance.cmdRcsDuty(res.duties, idx));
              _st.lastRcsTorque = res.fires.reduce((a, f) => a + f.torque, 0);
            } else {
              _rcsOff();
            }
            break;
          }

          // ==========================================================
          case "BOOSTBACK_BURN": {
            const idx = _bodyIdx;
            const body = snapshot.bodies[idx];
            if (!body) break;
            const env = Derivation.getEnv();
            const dt = env && Number.isFinite(env.DT) ? env.DT : 1 / 80;
            const M = d.massProps.M, I = d.massProps.I;
            if (!(I > 0) || !(M > 0)) break;
            const R2D = 180 / Math.PI;
            const engines = body.engines || [];

            const toks = _bbTokens(cfg);
            const burnSet = engines.filter(function (e) { return _bbInSet(e, toks); });
            if (!burnSet.length) {
              console.warn("[standardRTLS] BOOSTBACK: no engine matches BOOSTBACK_ENGINES='" + cfg.BOOSTBACK_ENGINES + "' — skipping phase");
              finished = true; break;
            }
            const centerSet = burnSet.filter(function (e) { return e.isCenter; });
            const finishSet = centerSet.length ? centerSet : burnSet;      // keeps burning to the end
            const offSet = burnSet.filter(function (e) { return finishSet.indexOf(e) < 0; });  // shut off first

            // ---- apparent target (Earth-fixed) ----
            const pad = (_missionCtx && _missionCtx.targetPad) || null;
            const padEf = (pad && Number.isFinite(pad.angleEf)) ? pad.angleEf : (env.LAUNCH_SITE_ANGLE_0 || 0);
            // metre constants -> angle (arc on the Earth surface)
            const mPerRad = env.EARTH_RADIUS;
            const offM = Number.isFinite(cfg.BOOSTBACK_APPARENT_OFFSET_M) ? cfg.BOOSTBACK_APPARENT_OFFSET_M : 0;
            const tgtEf = padEf + offM / mPerRad;
            _st.bbTargetEfDeg = tgtEf * R2D;

            // ---- impact error now, and with the spool-down dv of everything that is firing ----
            const nx = -Math.sin(d.theta), ny = Math.cos(d.theta);
            const omegaE = env.EARTH_OMEGA || 0;
            function errWith(dv) {
              const imp = _bbImpact(d.rx, d.ry, d.vx + nx * dv, d.vy + ny * dv, simT, env.GM_EARTH, env.EARTH_RADIUS, omegaE);
              return imp ? { err: _wrapPi(imp.phiEf - tgtEf), phiEf: imp.phiEf } : null;
            }
            const e0 = errWith(0);
            const eAll = errWith(_bbSpoolDv(engines, M));
            if (e0) { _st.bbErrDeg = e0.err * R2D; _st.bbImpactEfDeg = e0.phiEf * R2D; }

            let mdotNow = 0;
            engines.forEach(function (e) { mdotNow += e.massFlowRate || 0; });
            const fuel0 = (Array.isArray(body.memberFuel) && Number.isFinite(body.memberFuel[0])) ? body.memberFuel[0] : body.fuelMass;

            // ---- stage transitions ----
            if (!_st.bbInit) {
              _st.bbInit = true;
              _st.bbStage = "THREE";
              _send(Guidance.cmdSetAllThrottle(0));   // everything not in the burn set stays off
              console.log("[standardRTLS] BOOSTBACK start: engines=" + toks.join(",") +
                " tgtEf=" + (tgtEf * R2D).toFixed(4) + "deg (pad " + (pad ? pad.id : "launch-site") +
                " + offset " + offM + "m) err0=" + (e0 ? (e0.err * R2D).toFixed(3) : "n/a") + "deg");
            }
            const sideCutM = Number.isFinite(cfg.BOOSTBACK_SIDE_CUT_M) ? cfg.BOOSTBACK_SIDE_CUT_M : 0;
            const taperM = Number.isFinite(cfg.BOOSTBACK_TAPER_M) ? cfg.BOOSTBACK_TAPER_M : 0;
            if (_st.bbStage === "THREE") {
              if (eAll && eAll.err <= 0) {
                _st.bbStage = "SPOOL";
                console.log("[standardRTLS] BOOSTBACK THREE → SPOOL (cutoff, err=" + (e0 ? (e0.err * R2D).toFixed(4) : "n/a") + "deg) t=" + simT.toFixed(2));
              } else if (e0 && e0.err * mPerRad <= sideCutM) {
                _st.bbStage = "CENTER";
                console.log("[standardRTLS] BOOSTBACK THREE → CENTER (outer engines off, err=" + (e0.err * R2D).toFixed(4) + "deg) t=" + simT.toFixed(2));
              }
            }
            if (_st.bbStage === "CENTER" && eAll && eAll.err <= 0) {
              _st.bbStage = "SPOOL";
              console.log("[standardRTLS] BOOSTBACK CENTER → SPOOL (cutoff, err=" + (e0 ? (e0.err * R2D).toFixed(4) : "n/a") + "deg) t=" + simT.toFixed(2));
            }
            if (_st.bbStage !== "SPOOL" && !(fuel0 > BB_FUEL_EMPTY_KG)) {
              _st.bbStage = "SPOOL";
              console.warn("[standardRTLS] BOOSTBACK out of fuel → SPOOL");
            }

            // ---- throttle ----
            // Fade: all burn engines run 100 % while error >= TAPER_M, then fall linearly to the throttle
            // floor as the error -> 0. At SIDE_CUT_M the outer engines go off; centre keeps following the fade.
            let thrFrac = 0;
            const refE = finishSet[0];
            const maxMF = refE.maxMassFlowRate || 0;
            const minFrac = maxMF > 0 ? Math.min(1, (refE.minMassFlowRate || 0) / maxMF) : 0;
            let fadeX = 1;
            if (taperM > 0 && e0) fadeX = Math.max(0, Math.min(1, (e0.err * mPerRad) / taperM));
            const fadeFrac = minFrac + (1 - minFrac) * fadeX;
            if (_st.bbStage === "THREE" || _st.bbStage === "CENTER") {
              thrFrac = fadeFrac;
              const val = thrFrac >= 0.999 ? Infinity : maxMF * thrFrac;
              _bbThrottle(finishSet, val);
              if (_st.bbStage === "THREE") _bbThrottle(offSet, val);
              else _bbThrottle(offSet, 0);
            } else {
              _send(Guidance.cmdSetAllThrottle(0));
            }
            _st.bbThrFrac = thrFrac;

            // ---- attitude hold: CENTRE-engine gimbal only; same predictive law as circularize /
            //      suicide (state advanced one tick via deriveForState, tau minus env torque) ----
            const gimbals = engines.filter(function (e) { return e.gimbal && e.isCenter; });
            const M_d = d.massProps.M;
            let dNext = null;
            {
              const cT = Math.cos(d.theta), sT = Math.sin(d.theta);
              const tIx = d.thrustBodyX * cT - d.thrustBodyY * sT;
              const tIy = d.thrustBodyX * sT + d.thrustBodyY * cT;
              const aIx = d.gVecX + (tIx + d.dragVecX) / M_d;
              const aIy = d.gVecY + (tIy + d.dragVecY) / M_d;
              const sl = body.slosh || { offset: 0, velocity: 0 };
              dNext = Derivation.deriveForState(snapshot, idx, {
                rx: d.rx + d.vx * dt, ry: d.ry + d.vy * dt,
                vx: d.vx + aIx * dt, vy: d.vy + aIy * dt,
                theta: d.theta + d.omega * dt + 0.5 * d.alphaAng * dt * dt,
                omega: d.omega + d.alphaAng * dt,
                slosh: { offset: (sl.offset || 0) + (sl.velocity || 0) * dt, velocity: sl.velocity || 0 },
              });
            }
            const rr = Math.hypot(d.rx, d.ry);
            if (!_st.bbSign) {   // direction of horizontal velocity at burn start (kept even after it reverses)
              const vE0 = rr > 1 ? (d.vx * d.ry - d.vy * d.rx) / rr : 0;
              _st.bbSign = vE0 >= 0 ? 1 : -1;
            }
            const tgtNow = rr > 1 ? Math.atan2(_st.bbSign * d.ry / rr, _st.bbSign * d.rx / rr) : null;
            // Spool wait (same as circularize STAGE_BURN): no attitude control while the burn-set engines are still
            // starting up (thrust tiny -> huge gimbal demand -> limit cycle). Also frozen once SPOOL (cutoff) starts.
            if (!_st.bbSpooled && _st.bbStage === "THREE") {
              let full = true;
              burnSet.forEach(function (e) {
                const mx = Number.isFinite(e.maxMassFlowRate) ? e.maxMassFlowRate : 0;
                if (mx > 0 && (e.massFlowRate || 0) < mx * thrFrac * 0.97) full = false;
              });
              if (full) _st.bbSpooled = true;
            } else if (_st.bbStage !== "THREE") {
              _st.bbSpooled = true;
            }
            if (!_st.bbSpooled || _st.bbStage === "SPOOL") {
              _send(Guidance.cmdSetGimbalRate(0));
            } else if (gimbals.length && tgtNow !== null && dNext && dNext.massProps) {
              const thetaErr = _wrapPi(dNext.theta - tgtNow);
              const tauDesired = -dNext.massProps.I * (BB_ATT_KP * thetaErr + BB_ATT_KD * dNext.omega);
              const tauTarget = tauDesired - (Number.isFinite(dNext.torqueEnvironmental) ? dNext.torqueEnvironmental : 0);
              const comX = dNext.massProps.comX, comY = dNext.massProps.comY;
              let A = 0, B = 0;
              gimbals.forEach(function (e) {
                const F = (e.massFlowRate || 0) * (e.Ve || 0);
                A += ((e.x || 0) - comX) * F;
                B += F;
              });
              B *= comY;
              const Ramp = Math.hypot(A, B);
              let gReqRad = 0;
              if (Ramp > 1) {
                const ratio = Math.max(-1, Math.min(1, tauTarget / Ramp));
                const phi = Math.atan2(A, B);
                const w1 = _wrapPi(Math.asin(ratio) - phi);
                const w2 = _wrapPi(Math.PI - Math.asin(ratio) - phi);
                gReqRad = Math.abs(w1) <= Math.abs(w2) ? w1 : w2;
              }
              let gReqDeg = gReqRad * R2D;
              const gMax = gimbals[0].gimbalMaxDeg;
              if (Math.abs(gReqDeg) > gMax) gReqDeg = Math.sign(gReqDeg) * gMax;
              _send(_gimbalCmdMsg(gReqDeg, gimbals[0], dt, "center"));
            }

            // ---- end: thrust gone ----
            if (_st.bbStage === "SPOOL" && mdotNow < 1) {
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              console.log("[standardRTLS] BOOSTBACK done t=" + simT.toFixed(2) + " finalErr=" +
                (_st.bbErrDeg != null ? _st.bbErrDeg.toFixed(4) : "n/a") + "deg fuel=" + Math.round(fuel0) + "kg");
              finished = true; break;
            }
            break;
          }

          // ==========================================================
          // PRE_ENTRY_STEER — coast, align, hold, then handoff to ENTRY_BURN
          //
          // Sub-phases (tracked in _st.preEntrySub):
          //   COAST : quiet coast until descent crosses PRE_ENTRY_ALIGN_ALT_KM.
          //           Grid fins deployed once on phase entry, engines/gimbal/RCS off.
          //   ALIGN : bang-bang RCS rotate to retrograde (nose opposite to NET
          //           velocity vector, unlike FLIP which targets horizontal-opposite).
          //           Same 1-tick-ahead prediction + bang-bang law as FLIP.
          //   HOLD  : PD attitude hold at retrograde target until ENTRY_BURN_ALT_KM.
          //
          // Alignment tolerances reuse FLIP_ROTATE_TOL_DEG and FLIP_OMEGA_TOL
          // (user said "like flip phase" — no new constants).
          case "PRE_ENTRY_STEER": {
            const idx = _bodyIdx;
            const env = Derivation.getEnv();
            const dt = env && Number.isFinite(env.DT) ? env.DT : 1 / 80;
            const I = d.massProps.I;
            if (!(I > 0)) break;
            const R2D = 180 / Math.PI;
            const altKm = d.altitudeAGL / 1000;
            _st.lastAltKm = altKm;
            const rMag = d.r || Math.hypot(d.rx, d.ry);
            const vrSign = (d.vx * d.rx + d.vy * d.ry) / Math.max(1, rMag);

            // First tick of phase — deploy grid fins, all control off
            if (!_st.preEntryInit) {
              _st.preEntryInit = true;
              _st.preEntrySub = 'COAST';
              _st.preEntryAlignInit = false;
              _st.preEntryEu = 0;
              _st.preEntryPrevRaw = 0;
              _st.preEntryErrDeg = null;
              _st.preEntryOmegaDegS = null;
              _st.preEntryTgtDeg = null;
              _st.preEntryMode = null;
              _send(Guidance.cmdGridFinsDeploy(true));
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              _send(Guidance.cmdRcsDuty(null, idx));
              _st.lastRcsTorque = 0;
              console.log("[standardRTLS] PRE_ENTRY_STEER start t=" + simT.toFixed(2) +
                " alt=" + altKm.toFixed(1) + "km vr=" + vrSign.toFixed(1) +
                "m/s — grid fins deployed, coasting");
            }

            const alignAltKm = Number.isFinite(cfg.PRE_ENTRY_ALIGN_ALT_KM) ? cfg.PRE_ENTRY_ALIGN_ALT_KM : 80;
            const burnAltKm = Number.isFinite(cfg.ENTRY_BURN_ALT_KM) ? cfg.ENTRY_BURN_ALT_KM : 60;

            // COAST — quiet until descending below alignment altitude
            if (_st.preEntrySub === 'COAST') {
              if (altKm <= alignAltKm && vrSign < 0) {
                _st.preEntrySub = 'ALIGN';
                _st.preEntryAlignInit = false;
                console.log("[standardRTLS] PRE_ENTRY_COAST → ALIGN t=" + simT.toFixed(2) +
                  " alt=" + altKm.toFixed(1) + "km vr=" + vrSign.toFixed(1) + "m/s");
                // fall through to ALIGN on same tick
              } else {
                // Quiet — idempotent safety commands, no control
                _send(Guidance.cmdSetAllThrottle(0));
                _send(Guidance.cmdSetGimbalRate(0));
                _send(Guidance.cmdRcsDuty(null, idx));
                _st.lastRcsTorque = 0;
                break;
              }
            }

            // Target: nose OPPOSITE to AIR-RELATIVE net velocity (retrograde
            // in the air frame, not the inertial frame).
            //
            // WHY AIR-RELATIVE (was inertial before — root cause of the ~20°
            // displayed-AoA complaint):
            //   derivation.js computes d.alphaDeg against relV:
            //     relVx = vx - (wind + ω·ry)     [ω·r ≈ 465 m/s at 100 km]
            //     relVy = vy - (wind - ω·rx)
            //     velBodyX = relV · body-X(θ)     [body-X = (cosθ, sinθ)]
            //     alphaDeg = asin(velBodyX / |relV|)
            //   At 100 km the Earth-rotation term (~465 m/s) is 20-40% of the
            //   descent speed (~1000-2000 m/s). Aligning to INERTIAL retrograde
            //   (atan2(vx, -vy)) leaves 15-20° of air-relative alpha, shown as
            //   AoA ≈ -20°. The formula was correct — it targeted the wrong
            //   frame.
            //
            // FIX: use d.relVx, d.relVy (already computed by derivation,
            // includes wind + surface rotation). Now HOLD settles with
            // alphaDeg ≈ 0, matching user expectation.
            //
            //   Example check: v=(353,-2000), θ=10° (inertial target).
            //     relV=(-112,-2000), velBodyX=-458, α=-13°. Matches user.
            //     air-relative target atan2(-112, 2000) = -3.2°, settles
            //     there → velBodyX=0 → α=0. ✓
            //
            // NOTE: ENTRY_BURN (later phase) should still use INERTIAL
            // retrograde (burning along nose at air-relative-retro would leave
            // a small residual inertial velocity). Different frame per phase.
            const speedRelV = Math.hypot(d.relVx, d.relVy);
            if (!(speedRelV > 1)) { _rcsOff(); break; }
            const tgtNow = Math.atan2(d.relVx, -d.relVy);
            _st.preEntryTgtDeg = tgtNow * R2D;

            // Target rotates as velocity direction changes each tick (up to
            // ~0.5-1 deg/s during steep descent). Compute wTgt = d(tgt)/dt,
            // like FLIP does. dTgt = wTgt*dt corrects the one-tick prediction;
            // wRel = omega - wTgt kills the steady-state lag in braking calc.
            let wTgt = 0;
            if (_st.preEntryPrevTgt !== null && _st.preEntryPrevT !== null &&
                simT > _st.preEntryPrevT) {
              wTgt = _wrapPi(tgtNow - _st.preEntryPrevTgt) / (simT - _st.preEntryPrevT);
              if (Math.abs(wTgt) > 0.05) wTgt = 0;  // glitch guard
            }
            _st.preEntryPrevTgt = tgtNow;
            _st.preEntryPrevT = simT;

            // HOLD — PD attitude hold, watch for entry-burn trigger
            if (_st.preEntrySub === 'HOLD') {
              if (altKm <= burnAltKm) {
                console.log("[standardRTLS] PRE_ENTRY_HOLD → ENTRY_BURN trigger t=" + simT.toFixed(2) +
                  " alt=" + altKm.toFixed(1) + "km");
                finished = true;
                break;
              }
              const thetaErr = _wrapPi(d.theta - tgtNow);
              _st.preEntryErrDeg = thetaErr * R2D;
              _st.preEntryOmegaDegS = d.omega * R2D;
              const kp = 0.5, kd = 4.0;  // same as insertion's CIRC_ATT_KP/KD
              // Periodic HOLD telemetry — every 5 sim-sec. Confirms alphaDeg ≈ 0
              // (air-relative retrograde target on track) and err → 0.
              if (Math.round(simT * 16) % 400 === 0) {
                const alphaNow = Number.isFinite(d.alphaDeg) ? d.alphaDeg : NaN;
                console.log("[PRE_ENTRY_HOLD-DBG] t=" + simT.toFixed(2) +
                  " alt=" + altKm.toFixed(1) + "km" +
                  " theta=" + (d.theta * R2D).toFixed(2) + "deg" +
                  " tgt=" + (tgtNow * R2D).toFixed(2) + "deg" +
                  " err=" + (thetaErr * R2D).toFixed(3) + "deg" +
                  " alphaDeg=" + (Number.isFinite(alphaNow) ? alphaNow.toFixed(3) : '?') +
                  " omega=" + (d.omega * R2D).toFixed(3) + "deg/s");
              }
              // Feedforward: (d.omega - wTgt) instead of raw d.omega — kills
              // steady-state lag on the rotating target without extra gain.
              const result = GuideRCS.targetTorqueRcsNoNetForce(
                snapshot, -I * (kp * thetaErr + kd * (d.omega - wTgt)), idx
              );
              if (result && result.fires.length) {
                _send(Guidance.cmdRcsDuty(result.duties, idx));
                _st.lastRcsTorque = result.fires.reduce((a, f) => a + f.torque, 0);
              } else {
                _rcsOff();
              }
              break;
            }

            // ALIGN — bang-bang RCS rotate to retrograde (same law as FLIP)
            const mx = _rcsMaxTorques(snapshot);
            if (!(mx.pos > 0) || !(mx.neg > 0)) { _rcsOff(); break; }

            const rawErr = _wrapPi(tgtNow - d.theta);
            if (!_st.preEntryAlignInit) {
              _st.preEntryAlignInit = true;
              const ePos = rawErr >= 0 ? rawErr : rawErr + 2 * Math.PI;
              const eNeg = ePos - 2 * Math.PI;
              _st.preEntryEu = Math.abs(ePos) <= Math.abs(eNeg) ? ePos : eNeg;
              _st.preEntryPrevRaw = rawErr;
              _st.lastRcsTorque = 0;
              console.log("[standardRTLS] PRE_ENTRY_ALIGN start t=" + simT.toFixed(2) +
                " err=" + (_st.preEntryEu * R2D).toFixed(1) + "deg omega=" + (d.omega * R2D).toFixed(2) + "deg/s" +
                " tgt=" + (tgtNow * R2D).toFixed(1) + " theta=" + (d.theta * R2D).toFixed(1) + "deg" +
                " alphaDeg=" + (Number.isFinite(d.alphaDeg) ? d.alphaDeg.toFixed(1) : '?'));
            } else {
              _st.preEntryEu += _wrapPi(rawErr - _st.preEntryPrevRaw);
              _st.preEntryPrevRaw = rawErr;
            }
            _st.preEntryErrDeg = _st.preEntryEu * R2D;
            _st.preEntryOmegaDegS = d.omega * R2D;

            // Exit alignment — reuse FLIP tolerances (per user "like flip phase")
            const alignTolDeg = Number.isFinite(cfg.FLIP_ROTATE_TOL_DEG) ? cfg.FLIP_ROTATE_TOL_DEG : 0.5;
            const alignOmegaTol = Number.isFinite(cfg.FLIP_OMEGA_TOL) ? cfg.FLIP_OMEGA_TOL : 0.005;
            if (Math.abs(_st.preEntryEu) < alignTolDeg / R2D && Math.abs(d.omega) < alignOmegaTol) {
              _rcsOff();
              _st.preEntrySub = 'HOLD';
              console.log("[standardRTLS] PRE_ENTRY_ALIGN → HOLD t=" + simT.toFixed(2) +
                " err=" + (_st.preEntryEu * R2D).toFixed(2) + "deg omega=" + (d.omega * R2D).toFixed(3) + "deg/s");
              break;
            }

            // One-tick-ahead prediction (current RCS torque keeps acting).
            // dTgt = wTgt*dt — target's own rotation this tick. Without it,
            // the prediction assumes a stationary target and the controller
            // fires against stale error on descent (dt*wTgt can be 0.01-0.02°
            // per tick, compounding across the alignment window).
            const aTot = d.alphaAng + _st.lastRcsTorque / I;
            const dTheta = d.omega * dt + 0.5 * aTot * dt * dt;
            const wP = d.omega + aTot * dt;
            const dTgt = wTgt * dt;
            const eP = _st.preEntryEu + dTgt - dTheta;
            const wRelP = wP - wTgt;

            // Bang-bang decision (same structure as FLIP)
            const sgn = eP >= 0 ? 1 : -1;
            const brakeMax = sgn > 0 ? mx.neg : mx.pos;
            const towards = wRelP * sgn > 0;
            const stopAng = wRelP * wRelP * I / (2 * brakeMax) + Math.abs(wRelP) * dt;
            let tauCmd, fullRes = null;
            if (towards && Math.abs(eP) <= stopAng) {
              const need = I * Math.abs(wRelP) / dt;
              if (need >= brakeMax) {
                _st.preEntryMode = "BRAKE"; fullRes = sgn > 0 ? mx.rn : mx.rp; tauCmd = -sgn * brakeMax;
              } else {
                _st.preEntryMode = "TRIM"; tauCmd = -sgn * need;
              }
            } else {
              _st.preEntryMode = "ACCEL"; fullRes = sgn > 0 ? mx.rp : mx.rn; tauCmd = sgn * (sgn > 0 ? mx.pos : mx.neg);
            }

            const res = fullRes || GuideRCS.targetTorqueRcs(snapshot, tauCmd, idx);
            if (res && res.fires && res.fires.length) {
              _send(Guidance.cmdRcsDuty(res.duties, idx));
              _st.lastRcsTorque = res.fires.reduce((a, f) => a + f.torque, 0);
            } else {
              _rcsOff();
            }
            break;
          }

          // ==========================================================
          // ENTRY_BURN — light ENTRY_BURN_ENGINES at lowest thrust, hold
          // air-relative retrograde via gimbal + env-torque cancel.
          // NO cutoff yet — phase holds until user defines the exit.
          case "ENTRY_BURN": {
            const idx = _bodyIdx;
            const body = snapshot.bodies[idx];
            if (!body) break;
            const env = Derivation.getEnv();
            const dt = env && Number.isFinite(env.DT) ? env.DT : 1 / 80;
            const R2D = 180 / Math.PI;
            const altKm = d.altitudeAGL / 1000;
            const M = d.massProps.M, I = d.massProps.I;
            if (!(I > 0) || !(M > 0)) break;
            const engines = body.engines || [];
            const burnToks = _ebTokens(cfg.ENTRY_BURN_ENGINES, "C,0,180");
            const burnSet = engines.filter(function (e) { return _bbInSet(e, burnToks); });
            if (!burnSet.length) {
              console.warn("[standardRTLS] ENTRY_BURN: no engine matches ENTRY_BURN_ENGINES='" + cfg.ENTRY_BURN_ENGINES + "' - skip");
              finished = true; break;
            }
            const gimToks = _ebTokens(cfg.ENTRY_BURN_GIMBAL_ENGINES, "C");
            const gimbals = engines.filter(function (e) { return e.gimbal && _bbInSet(e, gimToks); });
            if (!_st.ebInit) {
              _st.ebInit = true;
              _st.ebSpooled = false;
              _st.ebStage = "BURN";
              _st.ebGimbalSat = false;
              _st.ebRcsDir = 0;
              _st.ebFlips = 0;
              _st.ebSpoolT = null;
              _st.ebPrevT = null;
              _st.ebPrevV = null;
              _st.ebPrevErr = null;
              _st.ebVdotF = null;
              _st.ebErateF = null;
              _send(Guidance.cmdSetAllThrottle(0));
              console.log("[standardRTLS] ENTRY_BURN start t=" + simT.toFixed(2) +
                " alt=" + altKm.toFixed(1) + "km engines=" + burnToks.join(",") +
                " gimbal=" + gimToks.join(",") + " (full throttle, cutoff " +
                (Number.isFinite(cfg.ENTRY_BURN_CUTOFF_VELOCITY_MS) ? cfg.ENTRY_BURN_CUTOFF_VELOCITY_MS : 600) +
                " m/s) STEER v2: predictive Tgo + braking");
            }
            const speedRelV = Math.hypot(d.relVx, d.relVy);
            const vCut = Number.isFinite(cfg.ENTRY_BURN_CUTOFF_VELOCITY_MS) ? cfg.ENTRY_BURN_CUTOFF_VELOCITY_MS : 600;
            _st.ebSpeedMs = speedRelV;
            if (_st.ebStage !== "SPOOL" && speedRelV <= vCut) {
              _st.ebStage = "SPOOL";
              console.log("[standardRTLS] ENTRY_BURN -> SPOOL cutoff t=" + simT.toFixed(2) +
                " v=" + speedRelV.toFixed(1) + " alt=" + altKm.toFixed(1) + "km impactErr=" +
                (_st.ebImpactErrM != null ? (_st.ebImpactErrM / 1000).toFixed(2) + "km" : "n/a"));
            }
            let mdotNow = 0;
            engines.forEach(function (e) { mdotNow += e.massFlowRate || 0; });
            if (_st.ebStage === "BURN") {
              _bbThrottle(burnSet, Infinity);
              _st.ebThrFrac = 1;
            } else {
              _send(Guidance.cmdSetAllThrottle(0));
              _st.ebThrFrac = 0;
            }
            if (!_st.ebSpooled && _st.ebStage === "BURN") {
              let ready = true;
              burnSet.forEach(function (e) {
                const mx = Number.isFinite(e.maxMassFlowRate) ? e.maxMassFlowRate : 0;
                if (mx > 0 && (e.massFlowRate || 0) < mx * 0.97) ready = false;
              });
              if (ready) {
                _st.ebSpooled = true;
                _st.ebSpoolT = simT;
                console.log("[standardRTLS] ENTRY_BURN engines at full thrust t=" + simT.toFixed(2));
              }
            }
            const active = _st.ebSpooled && _st.ebStage === "BURN";
            const pad = (_missionCtx && _missionCtx.targetPad) || null;
            const padEf = (pad && Number.isFinite(pad.angleEf)) ? pad.angleEf : (env.LAUNCH_SITE_ANGLE_0 || 0);
            const omegaE = env.EARTH_OMEGA || 0;
            const Rm = env.EARTH_RADIUS;
            const imp = _bbImpact(d.rx, d.ry, d.vx, d.vy, simT, env.GM_EARTH, Rm, omegaE);
            const biasM = Number.isFinite(cfg.ENTRY_BURN_IMPACT_TARGET_M) ? cfg.ENTRY_BURN_IMPACT_TARGET_M : 0;
            const errM = imp ? _wrapPi(imp.phiEf - padEf) * Rm - biasM : null;
            _st.ebImpactErrM = errM;
            const dtS = (_st.ebPrevT !== null && simT > _st.ebPrevT) ? (simT - _st.ebPrevT) : dt;
            if (_st.ebPrevT !== null && _st.ebPrevV !== null) {
              const vdR = (speedRelV - _st.ebPrevV) / dtS;
              const kv = Math.min(1, dtS / EB_VDOT_TAU_S);
              _st.ebVdotF = (_st.ebVdotF === null) ? vdR : _st.ebVdotF + kv * (vdR - _st.ebVdotF);
              if (errM !== null && _st.ebPrevErr !== null) {
                const eR = (errM - _st.ebPrevErr) / dtS;
                const ke = Math.min(1, dtS / EB_ERATE_TAU_S);
                _st.ebErateF = (_st.ebErateF === null) ? eR : _st.ebErateF + ke * (eR - _st.ebErateF);
              }
            }
            _st.ebPrevT = simT;
            _st.ebPrevV = speedRelV;
            _st.ebPrevErr = errM;
            const tGo = (_st.ebVdotF !== null && _st.ebVdotF < -0.5) ? Math.max(0, (speedRelV - vCut) / (-_st.ebVdotF)) : null;
            _st.ebTgoS = tGo;
            _st.ebErateMps = _st.ebErateF;
            const rcsNow = Number.isFinite(_st.lastRcsTorque) ? _st.lastRcsTorque : 0;
            let dNext = null;
            {
              const cT = Math.cos(d.theta), sT = Math.sin(d.theta);
              const tIx = d.thrustBodyX * cT - d.thrustBodyY * sT;
              const tIy = d.thrustBodyX * sT + d.thrustBodyY * cT;
              const aIx = d.gVecX + (tIx + d.dragVecX) / M;
              const aIy = d.gVecY + (tIy + d.dragVecY) / M;
              const alphaTot = d.alphaAng + rcsNow / I;
              const sl = body.slosh || { offset: 0, velocity: 0 };
              dNext = Derivation.deriveForState(snapshot, idx, {
                rx: d.rx + d.vx * dt, ry: d.ry + d.vy * dt,
                vx: d.vx + aIx * dt, vy: d.vy + aIy * dt,
                theta: d.theta + d.omega * dt + 0.5 * alphaTot * dt * dt,
                omega: d.omega + alphaTot * dt,
                slosh: { offset: (sl.offset || 0) + (sl.velocity || 0) * dt, velocity: sl.velocity || 0 }
              });
            }
            _st.ebAlphaDeg = Number.isFinite(d.alphaDeg) ? d.alphaDeg : null;
            _st.ebAlphaNextDeg = (dNext && Number.isFinite(dNext.alphaDeg)) ? dNext.alphaDeg : null;
            let rcsDir = 0;
            _st.ebPredErrM = null;
            if (active && errM !== null) {
              const warm = (simT - _st.ebSpoolT) >= EB_WARMUP_S && _st.ebErateF !== null && tGo !== null;
              const mxT = _rcsMaxTorques(snapshot);
              const aPos = mxT.pos / I, aNeg = mxT.neg / I;
              const w1 = d.omega + (rcsNow / I) * dt;
              const wSgn = w1 >= 0 ? 1 : -1;
              const aB = wSgn > 0 ? aNeg : aPos;
              if (warm && aB > 1e-9) {
                const aT = Math.hypot(d.thrustBodyX, d.thrustBodyY) / M;
                const px = -Math.cos(d.theta), py = -Math.sin(d.theta);
                const imp2 = _bbImpact(d.rx, d.ry, d.vx + px, d.vy + py, simT, env.GM_EARTH, Rm, omegaE);
                const S = imp2 ? (_wrapPi(imp2.phiEf - padEf) * Rm - biasM - errM) : 0;
                const kappa = aT * S;
                _st.ebKappa = kappa;
                const T = Math.max(0, tGo);
                const aw = Math.abs(w1);
                const ts = aw / aB;
                let intT;
                if (ts >= T) intT = wSgn * (aw * T * T / 2 - aB * T * T * T / 6);
                else intT = wSgn * (aw * aw * aw / (3 * aB * aB) + (aw * aw / (2 * aB)) * (T - ts));
                const s = errM + _st.ebErateF * T + kappa * intT;
                _st.ebPredErrM = s;
                if (T < EB_TGO_MIN_S) rcsDir = aw > EB_W_TOL ? -wSgn : 0;
                else if (s > EB_TOL_M) rcsDir = 1;
                else if (s < -EB_TOL_M) rcsDir = -1;
                else rcsDir = aw > EB_W_TOL ? -wSgn : 0;
              }
              if (rcsDir !== 0) {
                const res = rcsDir > 0 ? mxT.rp : mxT.rn;
                if (res && res.duties) {
                  _send(Guidance.cmdRcsDuty(res.duties, idx));
                  _st.lastRcsTorque = rcsDir > 0 ? mxT.pos : -mxT.neg;
                } else { rcsDir = 0; _rcsOff(); }
              } else _rcsOff();
              if (rcsDir !== 0 && _st.ebRcsDir !== 0 && rcsDir !== _st.ebRcsDir) _st.ebFlips++;
              if (rcsDir !== 0) _st.ebRcsDir = rcsDir;
            } else _rcsOff();
            _st.ebRcsTorque = _st.lastRcsTorque;
            _st.ebRcsCmd = rcsDir;
            if (!active || !gimbals.length || !dNext || !dNext.massProps) {
              _send(Guidance.cmdSetGimbalRate(0));
            } else {
              const tauEnv = Number.isFinite(dNext.torqueEnvironmental) ? dNext.torqueEnvironmental : 0;
              const tauTarget = -tauEnv;
              const comX = dNext.massProps.comX, comY = dNext.massProps.comY;
              let A = 0, B = 0;
              gimbals.forEach(function (e) {
                const F = (e.massFlowRate || 0) * (e.Ve || 0);
                A += ((e.x || 0) - comX) * F;
                B += F;
              });
              B *= comY;
              const Ramp = Math.hypot(A, B);
              let gReqRad = 0;
              if (Ramp > 1) {
                const ratio = Math.max(-1, Math.min(1, tauTarget / Ramp));
                const phi = Math.atan2(A, B);
                const w1g = _wrapPi(Math.asin(ratio) - phi);
                const w2g = _wrapPi(Math.PI - Math.asin(ratio) - phi);
                gReqRad = Math.abs(w1g) <= Math.abs(w2g) ? w1g : w2g;
              }
              let gReqDeg = gReqRad * R2D;
              const gMax = gimbals[0].gimbalMaxDeg;
              const sat = Ramp <= 1 || Math.abs(tauTarget) > Ramp || Math.abs(gReqDeg) > gMax;
              if (Math.abs(gReqDeg) > gMax) gReqDeg = Math.sign(gReqDeg) * gMax;
              _st.ebGimbalReqDeg = gReqDeg;
              _st.ebGimbalDeg = gimbals[0].gimbalDeg || 0;
              _st.ebTauEnv = tauEnv;
              _st.ebTauAvail = Ramp;
              if (sat && !_st.ebGimbalSat)
                console.warn("[standardRTLS] ENTRY_BURN gimbal SATURATED t=" + simT.toFixed(2));
              _st.ebGimbalSat = sat;
              const gimTarget = gimbals.every(function (e) { return e.isCenter; }) ? "center" : "all";
              _send(_gimbalCmdMsg(gReqDeg, gimbals[0], dt, gimTarget));
            }
            if (active && Math.round(simT * 80) % 80 === 0) {
              console.log("[ENTRY_BURN-DBG] t=" + simT.toFixed(2) + " alt=" + altKm.toFixed(1) + "km" +
                " v=" + speedRelV.toFixed(1) + " Tgo=" + (tGo != null ? tGo.toFixed(1) : "n/a") + "s" +
                " err=" + (errM != null ? (errM / 1000).toFixed(3) : "n/a") + "km" +
                " edot=" + (_st.ebErateF != null ? Math.round(_st.ebErateF) : "n/a") + "m/s" +
                " kappa=" + (_st.ebKappa != null ? Math.round(_st.ebKappa) : "n/a") +
                " s=" + (_st.ebPredErrM != null ? Math.round(_st.ebPredErrM) : "n/a") + "m" +
                " rcs=" + (rcsDir > 0 ? "ACW" : rcsDir < 0 ? "CW" : "off") + " flips=" + _st.ebFlips +
                " alpha=" + (_st.ebAlphaDeg != null ? _st.ebAlphaDeg.toFixed(2) : "n/a") + "deg" +
                " w=" + (d.omega * R2D).toFixed(3) + "deg/s" +
                " g=" + (_st.ebGimbalDeg != null ? _st.ebGimbalDeg.toFixed(2) : "n/a") + "deg" +
                " sat=" + (_st.ebGimbalSat ? "YES" : "no") + " Q=" + (Number.isFinite(d.Q) ? Math.round(d.Q) : "n/a"));
            }
            if (_st.ebStage === "SPOOL" && mdotNow < 1) {
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              _rcsOff();
              console.log("[standardRTLS] ENTRY_BURN done t=" + simT.toFixed(2) + " v=" + speedRelV.toFixed(1) +
                " alt=" + altKm.toFixed(1) + "km impactErr=" + (errM != null ? (errM / 1000).toFixed(3) + "km" : "n/a") +
                " flips=" + _st.ebFlips);
              finished = true; break;
            }
            break;
          }

          // ==========================================================
          // ==========================================================
          // POST_ENTRY_STEER — FIRST EXPERIMENT: grid fins only, ramped max
          // ACW tilt to induce CW body rotation (nose east, lift west).
          // NO exit; phase holds so impact shift can be judged at landing.
                              case "POST_ENTRY_STEER": {
            const idx = _bodyIdx;
            const body = snapshot.bodies[idx];
            if (!body) break;
            const env = Derivation.getEnv();
            const dt = env && Number.isFinite(env.DT) ? env.DT : 1 / 80;
            const R2D = 180 / Math.PI, D2R = Math.PI / 180;
            const altKm = d.altitudeAGL / 1000;
            const omegaE = env.EARTH_OMEGA || 0;
            const Rm = env.EARTH_RADIUS;
            const M = d.massProps.M, I = d.massProps.I;
            if (!(M > 0) || !(I > 0)) break;

            if (!_st.pesInit) {
              _st.pesInit = true;
              _st.pesDone = false;
              _st.pesT0 = simT;
              _st.pesCmdC = 0;
              _st.pesPrevT = null;
              _st.pesPrevErr = null;
              _st.pesErateF = null;
              _send(Guidance.cmdSetAllThrottle(0));
              _send(Guidance.cmdSetGimbalRate(0));
              _rcsOff();
              _send(Guidance.cmdGridFinsDeploy(true));
              console.log("[standardRTLS] POST_ENTRY_STEER (closed loop v4) start t=" + simT.toFixed(2) +
                " alt=" + altKm.toFixed(1) + "km v=" + Math.hypot(d.relVx, d.relVy).toFixed(0) + "m/s" +
                " — first " + PES_VALIDATE_S + "s: NO commands (model validation)");
              try {
                const cT0 = Math.cos(d.theta), sT0 = Math.sin(d.theta);
                const rows = [-30, -10, 0, 10, 30].map(function (c) {
                  const g = Derivation.gridFinAero(snapshot, idx, null, c);
                  if (!g) return "c=" + c + ": n/a";
                  const fxb = g.Fx * cT0 + g.Fy * sT0;
                  const fyb = -g.Fx * sT0 + g.Fy * cT0;
                  return "c=" + c + ": Fxb=" + fxb.toFixed(0) + " Fyb=" + fyb.toFixed(0) + " tau=" + g.torque.toFixed(0);
                });
                console.log("[PES-FIN-AERO] alpha=" + (Number.isFinite(d.alphaDeg) ? d.alphaDeg.toFixed(2) : "n/a") + "deg" +
                  " Q=" + (Number.isFinite(d.Q) ? Math.round(d.Q) : "n/a") +
                  " finCtrlNow=" + (d.gridFinControlUsed != null ? d.gridFinControlUsed.toFixed(1) : "n/a") + " | " + rows.join(" | "));
              } catch (e) { console.warn("[PES-FIN-AERO] failed: " + e); }
            }

            if (d.altitudeAGL < 50 || body.landed || body.crashed) {
              if (!_st.pesDone) {
                _st.pesDone = true;
                _rcsOff();
                console.log("[standardRTLS] POST_ENTRY_STEER touchdown t=" + simT.toFixed(2) +
                  " vacImpactErr=" + (_st.pesVacErrM != null ? (_st.pesVacErrM / 1000).toFixed(3) + "km" : "n/a") +
                  " groundErr=" + (_st.pesGroundErrM != null ? (_st.pesGroundErrM / 1000).toFixed(3) + "km" : "n/a"));
              }
              break;
            }

            const cAct = Number.isFinite(d.gridFinControlUsed) ? d.gridFinControlUsed : null;
            if (cAct === null) {
              if (Math.round(simT * 16) % 400 === 0) console.warn("[POST_ENTRY] no grid-fin data");
              break;
            }

            const pad = (_missionCtx && _missionCtx.targetPad) || null;
            const padEf = (pad && Number.isFinite(pad.angleEf)) ? pad.angleEf : (env.LAUNCH_SITE_ANGLE_0 || 0);
            const imp0 = _bbImpact(d.rx, d.ry, d.vx, d.vy, simT, env.GM_EARTH, Rm, omegaE);
            if (!imp0) { _rcsOff(); break; }
            const errM = _wrapPi(imp0.phiEf - padEf) * Rm;
            const impX = _bbImpact(d.rx, d.ry, d.vx + 1, d.vy, simT, env.GM_EARTH, Rm, omegaE);
            const impY = _bbImpact(d.rx, d.ry, d.vx, d.vy + 1, simT, env.GM_EARTH, Rm, omegaE);
            const Sx = impX ? (_wrapPi(impX.phiEf - padEf) * Rm - errM) : 0;
            const Sy = impY ? (_wrapPi(impY.phiEf - padEf) * Rm - errM) : 0;
            _st.pesVacErrM = errM;
            const phiNow = Math.atan2(d.rx, d.ry) - omegaE * simT;
            _st.pesGroundErrM = _wrapPi(phiNow - padEf) * Rm;

            const dtS = (_st.pesPrevT !== null && simT > _st.pesPrevT) ? (simT - _st.pesPrevT) : dt;
            if (_st.pesPrevT !== null && _st.pesPrevErr !== null) {
              const eRaw = (errM - _st.pesPrevErr) / dtS;
              const ke = Math.min(1, dtS / 0.5);
              _st.pesErateF = (_st.pesErateF === null) ? eRaw : _st.pesErateF + ke * (eRaw - _st.pesErateF);
            }
            _st.pesPrevT = simT; _st.pesPrevErr = errM;

            const a0 = _pesAeroAccel(d, M);
            const edotPred = Sx * a0.ax + Sy * a0.ay;
            const edotDes = -errM / PES_TAU_E_S;

            let edotFD = null, edotBal = null;
            {
              const T = 1.0;
              const fd = function (ax, ay) {
                const gx = d.gVecX + ax, gy = d.gVecY + ay;
                const im = _bbImpact(d.rx + d.vx * T + 0.5 * gx * T * T, d.ry + d.vy * T + 0.5 * gy * T * T,
                  d.vx + gx * T, d.vy + gy * T, simT + T, env.GM_EARTH, Rm, omegaE);
                return im ? (_wrapPi(im.phiEf - padEf) * Rm - errM) / T : null;
              };
              edotFD = fd(a0.ax, a0.ay);
              edotBal = fd(0, 0);
            }

            _st.pesAlphaDeg = Number.isFinite(d.alphaDeg) ? d.alphaDeg : null;
            _st.pesOmegaDegS = d.omega * R2D;
            _st.pesQ = Number.isFinite(d.Q) ? d.Q : null;
            _st.pesEdotPredMps = edotPred;
            _st.pesEdotMeasMps = _st.pesErateF;
            _st.pesFinCtrlActDeg = cAct;

            if ((simT - _st.pesT0) < PES_VALIDATE_S) {
              _send(Guidance.cmdGridFinsControl(0));
              _rcsOff();
              _st.pesCtrlCmd = 0; _st.pesRcsTorque = 0;
              if (Math.round(simT * 80) % 80 === 0) {
                console.log("[POST_ENTRY-VALIDATE] t=" + simT.toFixed(2) + " alt=" + altKm.toFixed(1) + "km" +
                  " Q=" + (Number.isFinite(d.Q) ? Math.round(d.Q) : "n/a") + " alpha=" + d.alphaDeg.toFixed(2) + "deg" +
                  " edot meas/pred=" + (_st.pesErateF != null ? _st.pesErateF.toFixed(2) : "n/a") + "/" + edotPred.toFixed(2) + "m/s" +
                  " FD=" + (edotFD != null ? edotFD.toFixed(2) : "n/a") + " bal=" + (edotBal != null ? edotBal.toFixed(2) : "n/a") +
                  " S=(" + Sx.toFixed(1) + "," + Sy.toFixed(1) + ") a=(" + a0.ax.toFixed(3) + "," + a0.ay.toFixed(3) + ")m/s2" +
                  " hullLatF=" + Math.round(a0.fxb) + " finFxb=" +
                  Math.round((d.gridFinFx || 0) * Math.cos(d.theta) + (d.gridFinFy || 0) * Math.sin(d.theta)) +
                  " vacErr=" + (errM / 1000).toFixed(3) + "km");
              }
              break;
            }

            const rcsNow = Number.isFinite(_st.lastRcsTorque) ? _st.lastRcsTorque : 0;
            const alphaTot = d.alphaAng + ((d.gridFinTorque || 0) + rcsNow) / I;
            const sl = body.slosh || { offset: 0, velocity: 0 };
            const stateNext = {
              rx: d.rx + d.vx * dt, ry: d.ry + d.vy * dt,
              vx: d.vx + (d.gVecX + a0.ax) * dt, vy: d.vy + (d.gVecY + a0.ay) * dt,
              theta: d.theta + d.omega * dt + 0.5 * alphaTot * dt * dt,
              omega: d.omega + alphaTot * dt,
              slosh: { offset: (sl.offset || 0) + (sl.velocity || 0) * dt, velocity: sl.velocity || 0 },
            };
            const dNext = Derivation.deriveForState(snapshot, idx, stateNext);
            if (!dNext) { _rcsOff(); break; }
            const H0 = (dNext.torqueDrag || 0) + (dNext.torqueGravityGradient || 0);

            // Fixed RCS CW setup (BR.lat + TL.lat, full duty) — used by feasibility AND command
            const bodyPods = body.pods || [];
            const topLpod = bodyPods.filter(function (p) { return p.side === 'L'; })
              .sort(function (a, b) { return (b.offsetFromStackBase || 0) - (a.offsetFromStackBase || 0); })[0];
            const botRpod = bodyPods.filter(function (p) { return p.side === 'R'; })
              .sort(function (a, b) { return (a.offsetFromStackBase || 0) - (b.offsetFromStackBase || 0); })[0];
            let rcsCwTorque = 0;
            let rcsPodThrust = 0;
            if (topLpod && botRpod) {
              const refM = body.members[topLpod.memberIdx];
              if (refM && refM.rcsThruster) {
                const refT = Derivation.getTypeById(refM.rcsThruster.thrusterTypeId);
                const veF = Derivation.typeParam(refT, 've');
                const mdotF = refM.rcsThruster.massFlowRate;
                if (Number.isFinite(veF) && Number.isFinite(mdotF)) {
                  rcsPodThrust = mdotF * veF;
                  rcsCwTorque = -(topLpod.offsetFromStackBase - botRpod.offsetFromStackBase) * rcsPodThrust;
                }
              }
            }
            const finT = function (c) {
              const g = Derivation.gridFinAero(snapshot, idx, stateNext, c);
              return g ? g.torque : 0;
            };
            const cList = [], tList = [];
            let loFin = Infinity, hiFin = -Infinity;
            for (let c = -PES_CTRL_CAP_DEG; c <= PES_CTRL_CAP_DEG + 1e-9; c += PES_FIN_STEP_DEG) {
              const t = finT(c);
              cList.push(c); tList.push(t);
              if (t < loFin) loFin = t;
              if (t > hiFin) hiFin = t;
            }
            const rcsMax = _pesRcsMax(snapshot, idx);
            const Ltot = loFin - PES_RCS_MARGIN * rcsMax.neg;
            const Utot = hiFin + PES_RCS_MARGIN * rcsMax.pos;

            const ds1 = Derivation.deriveForState(snapshot, idx, { theta: d.theta + D2R });
            let J = 0, dAdTh = 0, Jh = 0;
            if (ds1) {
              const a1 = _pesAeroAccel(ds1, M);
              J = (Sx * a1.ax + Sy * a1.ay) - edotPred;
              dAdTh = (Number.isFinite(ds1.alphaDeg) ? ds1.alphaDeg : d.alphaDeg) - d.alphaDeg;
              Jh = ((ds1.torqueDrag || 0) + (ds1.torqueGravityGradient || 0)) - ((d.torqueDrag || 0) + (d.torqueGravityGradient || 0));
            }
            let dthDeg = (Math.abs(J) > PES_J_MIN) ? (edotDes - edotPred) / J : 0;
            const dthWanted = dthDeg;
            let feasLo = -Infinity, feasHi = Infinity;
            if (Math.abs(Jh) > PES_JH_MIN) {
              const a = -Utot - H0, b = -Ltot - H0;
              if (Jh > 0) { feasLo = a / Jh; feasHi = b / Jh; } else { feasLo = b / Jh; feasHi = a / Jh; }
            }
            dthDeg = Math.max(feasLo, Math.min(feasHi, dthDeg));
            dthDeg = Math.max(-PES_DTH_MAX_DEG, Math.min(PES_DTH_MAX_DEG, dthDeg));
            let aStar = d.alphaDeg + dAdTh * dthDeg;
            if (Math.abs(aStar) > PES_ALPHA_MAX_DEG && Math.abs(dAdTh) > 0.05) {
              aStar = Math.sign(aStar) * PES_ALPHA_MAX_DEG;
              dthDeg = Math.max(-PES_DTH_MAX_DEG, Math.min(PES_DTH_MAX_DEG, (aStar - d.alphaDeg) / dAdTh));
            }
            const thetaStar = d.theta + dthDeg * D2R;

            const tauCmd = I * (-PES_KP * (dNext.theta - thetaStar) - PES_KD * dNext.omega);
            const tauNeed = tauCmd - H0;

            let bestC = cAct, bestErr = Infinity;
            const consider = function (c, t) {
              const er = Math.abs(t - tauNeed);
              if (er < bestErr - 1e-6 || (Math.abs(er - bestErr) <= 1e-6 && Math.abs(c - cAct) < Math.abs(bestC - cAct))) {
                bestErr = er; bestC = c;
              }
            };
            for (let i = 0; i < cList.length; i++) consider(cList[i], tList[i]);
            { const c0 = bestC;
              [c0 - PES_FIN_STEP_DEG / 2, c0 + PES_FIN_STEP_DEG / 2].forEach(function (c) {
                if (c >= -PES_CTRL_CAP_DEG - 1e-9 && c <= PES_CTRL_CAP_DEG + 1e-9) consider(c, finT(c));
              }); }
            const cStar = Math.max(-PES_CTRL_CAP_DEG, Math.min(PES_CTRL_CAP_DEG, bestC));
            _st.pesCmdC = cStar;
            _send(Guidance.cmdGridFinsControl(cStar));
            const maxStep = PES_FIN_RATE_DEGS * dt;
            const cNext = cAct + Math.max(-maxStep, Math.min(maxStep, cStar - cAct));
            const tauFinNext = finT(cNext);

            // ---- 5. RCS: lateral-only dynamic (no up/dn fires) ----
            const tauR = tauNeed - tauFinNext;
            let rcsAch = 0;
            if (Math.abs(tauR) > PES_RCS_DEADBAND_NM) {
              const res = _pesRcsLateralOnly(snapshot, idx, tauR);
              if (res && res.duties && Object.keys(res.duties).length) {
                _send(Guidance.cmdRcsDuty(res.duties, idx));
                rcsAch = _pesRcsAch(res);
              } else {
                _send(Guidance.cmdRcsDuty(null, idx));
              }
            } else {
              _send(Guidance.cmdRcsDuty(null, idx));
            }
            _st.lastRcsTorque = rcsAch;

            _st.pesCtrlCmd = cStar;
            _st.pesRcsTorque = rcsAch;
            if (Math.round(simT * 80) % 160 === 0) {
              console.log("[POST_ENTRY-DBG] t=" + simT.toFixed(2) + " alt=" + altKm.toFixed(1) + "km" +
                " v=" + Math.hypot(d.relVx, d.relVy).toFixed(0) + " Q=" + (Number.isFinite(d.Q) ? Math.round(d.Q) : "n/a") +
                " vacErr=" + (errM / 1000).toFixed(3) + "km groundErr=" + (_st.pesGroundErrM / 1000).toFixed(3) + "km" +
                " edot meas/pred/des=" + (_st.pesErateF != null ? _st.pesErateF.toFixed(1) : "n/a") + "/" +
                edotPred.toFixed(1) + "/" + edotDes.toFixed(1) + "m/s" +
                " FD=" + (edotFD != null ? edotFD.toFixed(2) : "n/a") + " bal=" + (edotBal != null ? edotBal.toFixed(2) : "n/a") +
                " J=" + J.toFixed(2) +
                " dth want/feas[" + feasLo.toFixed(2) + "," + feasHi.toFixed(2) + "]/used=" + dthWanted.toFixed(2) + "/" + dthDeg.toFixed(2) + "deg" +
                " alpha=" + d.alphaDeg.toFixed(2) + "→" + aStar.toFixed(2) + "deg w=" + (d.omega * R2D).toFixed(3) + "deg/s" +
                " fin act/cmd=" + cAct.toFixed(1) + "/" + cStar.toFixed(1) +
                " auth[" + Math.round(Ltot) + "," + Math.round(Utot) + "] H0=" + Math.round(H0) +
                " tauNeed=" + Math.round(tauNeed) + " tauFin=" + Math.round(tauFinNext) + " tauRcs=" + Math.round(rcsAch) +
                " hullLatF=" + Math.round(a0.fxb));
            }
            break;
          }

          // ==========================================================
          case "LANDING_BURN": {
            // TODO: landing burn
            break;
          }

          // ==========================================================
          case "TOUCHDOWN": {
            // TODO: touchdown
            break;
          }

          default:
            break;
        }

        const i = PHASES.indexOf(_st.phase);
        const next = i >= 0 && i < PHASES.length - 1 ? PHASES[i + 1] : null;

        if (finished) {
          _goto(next, simT, "done");
          return;
        }
        const tmo = cfg[TIMEOUT_KEY[_st.phase]];
        if (Number.isFinite(tmo) && simT - _st.phaseStart > tmo) {
          console.warn("[standardRTLS] " + _st.phase + " timeout");
          _goto(next, simT, "timeout");
        }
      }

      return {
        start(constants, bodyIdx, missionCtx) {
          if (!constants) throw new Error("standardRTLS.start: constants required");
          if (!Number.isInteger(bodyIdx))
            throw new Error("standardRTLS.start: bodyIdx required");
          _constants = JSON.parse(JSON.stringify(constants));
          _bodyIdx = bodyIdx;
          _missionCtx = missionCtx || {};
          _done = false;
          _result = null;

          _st.init = false;
          _st.ticks = 0;
          _st.phase = "FLIP";
          _st.phaseStart = 0;
          _st.startSimTime = null;
          _st.phaseLog = {};
          _st.lastAltKm = 0;
          _st.lastRcsTorque = 0;
          _st.flipInit = false;
          _st.flipDir = 0;
          _st.flipEu = 0;
          _st.flipPrevRaw = 0;
          _st.flipPrevTgt = null;
          _st.flipPrevT = null;
          _st.flipMode = null;
          _st.flipErrDeg = null;
          _st.flipOmegaDegS = null;
          _st.flipTgtDeg = null;
          _st.bbInit = false;
          _st.bbSign = 0;
          _st.bbSpooled = false;
          _st.bbStage = null;
          _st.bbPrevTgt = null;
          _st.bbPrevT = null;
          _st.bbErrDeg = null;
          _st.bbImpactEfDeg = null;
          _st.bbTargetEfDeg = null;
          _st.bbThrFrac = null;
          _st.preEntryInit = false;
          _st.preEntrySub = null;
          _st.preEntryAlignInit = false;
          _st.preEntryEu = 0;
          _st.preEntryPrevRaw = 0;
          _st.preEntryErrDeg = null;
          _st.preEntryOmegaDegS = null;
          _st.preEntryTgtDeg = null;
          _st.preEntryMode = null;
          _st.preEntryPrevTgt = null;
          _st.preEntryPrevT = null;
          _st.ebInit = false;
          _st.ebSpooled = false;
          _st.ebStage = null;
          _st.ebSpeedMs = null;
          _st.ebPrevTgt = null;
          _st.ebPrevT = null;
          _st.ebErrDeg = null;
          _st.ebAlphaDeg = null;
          _st.ebGimbalDeg = null;
          _st.ebGimbalReqDeg = null;
          _st.ebGimbalSat = false;
          _st.ebThrFrac = null;
          _st.ebTauEnv = null;
          _st.ebTauAvail = null;
          _st.ebImpactErrM = null;
          _st.ebRcsTorque = 0;
          _st.ebRcsDir = 0;
          _st.ebFlips = 0;
          _st.ebAlphaNextDeg = null;
          _st.ebSpoolT = null;
          _st.ebPrevV = null;
          _st.ebPrevErr = null;
          _st.ebVdotF = null;
          _st.ebErateF = null;
          _st.ebTgoS = null;
          _st.ebErateMps = null;
          _st.ebKappa = null;
          _st.ebPredErrM = null;
          _st.ebRcsCmd = 0;
          _st.pesInit = false;
          _st.pesT0 = 0;
          _st.pesRcsLogged = false;
          _st.pesCtrlCmd = 0;
          _st.pesGroundErrM = null;
          _st.pesVacErrM = null;
          _st.pesAlphaDeg = null;
          _st.pesOmegaDegS = null;
          _st.pesQ = null;
          _st.pesDone = false;
          _st.pesCmdC = 0;
          _st.pesPrevT = null;
          _st.pesPrevErr = null;
          _st.pesErateF = null;
          _st.pesEdotPredMps = null;
          _st.pesEdotMeasMps = null;
          _st.pesRcsTorque = 0;
          _st.pesFinCtrlActDeg = null;
        },

        tick(snapshot) {
          if (_done) return;
          if (!snapshot || !snapshot.bodies || !snapshot.bodies[_bodyIdx]) return;
          _tick(snapshot);
        },

        stop() {
          _send(Guidance.cmdSetAllThrottle(0));
          _send(Guidance.cmdSetGimbalRate(0));
          _send(Guidance.cmdRcsDuty(null));
          _st.init = false;
          _done = false;
        },

        isDone() {
          return _done;
        },
        getResult() {
          return _result ? Object.assign({}, _result) : null;
        },
        getStatus() {
          return {
            phase: _done ? "DONE" : _st.phase,
            ticks: _st.ticks,
            altKm: _st.lastAltKm,
            phaseStart: _st.phaseStart,
            phaseLog: JSON.parse(JSON.stringify(_st.phaseLog)),
            flipMode: _st.flipMode,
            flipErrDeg: _st.flipErrDeg,
            flipOmegaDegS: _st.flipOmegaDegS,
            flipTgtDeg: _st.flipTgtDeg,
            flipDir: _st.flipDir,
            bbStage: _st.bbStage,
            bbErrDeg: _st.bbErrDeg,
            bbImpactEfDeg: _st.bbImpactEfDeg,
            bbTargetEfDeg: _st.bbTargetEfDeg,
            bbThrFrac: _st.bbThrFrac,
            preEntrySub: _st.preEntrySub,
            preEntryErrDeg: _st.preEntryErrDeg,
            preEntryOmegaDegS: _st.preEntryOmegaDegS,
            preEntryTgtDeg: _st.preEntryTgtDeg,
            preEntryMode: _st.preEntryMode,
            ebStage: _st.ebStage,
            ebSpeedMs: _st.ebSpeedMs,
            ebErrDeg: _st.ebErrDeg,
            ebAlphaDeg: _st.ebAlphaDeg,
            ebGimbalDeg: _st.ebGimbalDeg,
            ebGimbalReqDeg: _st.ebGimbalReqDeg,
            ebGimbalSat: _st.ebGimbalSat,
            ebThrFrac: _st.ebThrFrac,
            ebImpactErrM: _st.ebImpactErrM,
            ebRcsTorque: _st.ebRcsTorque,
            ebRcsDir: _st.ebRcsDir,
            ebFlips: _st.ebFlips,
            ebAlphaNextDeg: _st.ebAlphaNextDeg,
            ebTgoS: _st.ebTgoS,
            ebErateMps: _st.ebErateMps,
            ebKappa: _st.ebKappa,
            ebPredErrM: _st.ebPredErrM,
            ebRcsCmd: _st.ebRcsCmd,
            pesCtrlCmd: _st.pesCtrlCmd,
            pesGroundErrM: _st.pesGroundErrM,
            pesVacErrM: _st.pesVacErrM,
            pesAlphaDeg: _st.pesAlphaDeg,
            pesOmegaDegS: _st.pesOmegaDegS,
            pesQ: _st.pesQ,
            pesEdotPredMps: _st.pesEdotPredMps,
            pesEdotMeasMps: _st.pesEdotMeasMps,
            pesRcsTorque: _st.pesRcsTorque,
            pesFinCtrlActDeg: _st.pesFinCtrlActDeg,
            rcsTorque: _st.lastRcsTorque,
          };
        },
        getBodyIdx() {
          return _bodyIdx;
        },
        getState() {
          return {
            bodyIdx: _bodyIdx,
            constants: _constants ? JSON.parse(JSON.stringify(_constants)) : null,
            missionCtx: _missionCtx ? JSON.parse(JSON.stringify(_missionCtx)) : null,
            done: _done,
            result: _result ? JSON.parse(JSON.stringify(_result)) : null,
            st: JSON.parse(JSON.stringify(_st)),
          };
        },
        setState(s) {
          if (!s) return;
          _bodyIdx = Number.isInteger(s.bodyIdx) ? s.bodyIdx : null;
          _constants = s.constants ? JSON.parse(JSON.stringify(s.constants)) : null;
          _missionCtx = s.missionCtx ? JSON.parse(JSON.stringify(s.missionCtx)) : {};
          _done = !!s.done;
          _result = s.result ? JSON.parse(JSON.stringify(s.result)) : null;
          if (s.st) Object.assign(_st, s.st);
        },
        getConstants() {
          return _constants ? JSON.parse(JSON.stringify(_constants)) : null;
        },
        setConstants(patch) {
          if (_constants && patch) Object.assign(_constants, patch);
        },
      };
    },
  },
};
