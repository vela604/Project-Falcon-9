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

const FUNDAMENTAL_BLOCKS = {
  // ==========================================================================
  // ASCENT — pad → MECO_SPOOL
  //
  // Runs the ascent attitude sub-machine (PRE_COAST → PUSH → COAST →
  // HOLD → COASTnAoADAMP), monitors apogee, and when apogee crosses
  // MECO_APOGEE_KM: issues cmdSeparate() and ends.
  //
  // Body-locked to the launch stack (typically index 0).
  // ==========================================================================
  ascent: {
    name: "ascent",
    displayName: "Ascent",
    description:
      "Pad → MECO. Fires engines, holds attitude to the MECO apogee target, and issues the separation command.",
    defaultConstants: {
      INITIAL_COAST_S: 4.9,
  PUSH_T_S: 4.82,
  PUSH_MAX_GIMBAL_DEG: 0.60,
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
        GIMBAL_TARGET: "center",
    // MECO trigger mode. false → apogee-based (legacy, unchanged).
    // true → fuel-based: fire MECO when the booster's tank has exactly
    // MECO_TARGET_BOOSTER_FUEL_KG left AFTER the shutdown spool-down
    // burns through its residual flow. MECO_APOGEE_KM is ignored when
    // this is true.
    MECO_TRIGGER_ON_FUEL: false,
    // Residual booster tank fuel (kg) desired at the end of shutdown
    // spool-down. Only read when MECO_TRIGGER_ON_FUEL is true.
    MECO_TARGET_BOOSTER_FUEL_KG: 52612,
    MECO_APOGEE_KM: 150,
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
        const R_N = Number.isFinite(gimbals[0].targetGimbalRateDegS)
          ? gimbals[0].targetGimbalRateDegS
          : 0;
        const g_N1 = g_N + R_N * dt;

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
        } else if (_sub.phase === "COAST" || _sub.phase === "PRE_COAST") {
          tau_desired = 0;
          _sub.lastTauDQ = 0;
        } else if (_sub.phase === "COASTnAoADAMP") {
          tau_desired =
            (-I_next * cfg.COAST_DAMP_GAIN * dNext.alphaDeg) /
            (cfg.COAST_DAMP_K * cfg.COAST_DAMP_K);
          _sub.lastTauDQ = 0;
        } else {
          const useNow = dQ < 0;
          const I_use = useNow ? dNow.massProps.I : I_next;
          const alpha_use = useNow ? alphaAoANow : alphaAoANext;
          const omega_use = useNow ? omegaAoANow : omegaAoANext;
          const tau_accel = -I_use * alpha_use;
          const tau_damp = -cfg.HOLD_K_DAMP * I_use * omega_use;

          const qRef = cfg.HOLD_Q_REF;
          const f_dQ =
            Number.isFinite(qRef) && qRef > 0
              ? 0.5 * (1 - Math.tanh(dQ / qRef))
              : 0.5;
          const tau_dQ = -cfg.HOLD_K_DQ * I_use * f_dQ;
          _sub.lastTauDQ = tau_dQ;

          tau_desired = tau_accel + tau_damp + tau_dQ;
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
        const MAX_ANG =
          env && Number.isFinite(env.GIMBAL_MAX_DEG) ? env.GIMBAL_MAX_DEG : 20;
        if (Math.abs(g_req_deg) > MAX_ANG)
          g_req_deg = Math.sign(g_req_deg) * MAX_ANG;

        const R_req = (g_req_deg - g_N) / dt;
        const MAX_RATE =
          env && Number.isFinite(env.GIMBAL_RATE_DEG_S)
            ? env.GIMBAL_RATE_DEG_S
            : 40;
        const R_cmd = Math.max(-MAX_RATE, Math.min(MAX_RATE, R_req));

        _sub.lastGRate = R_cmd;
        _sub.lastGRadN = g_N;
        _sub.lastGReqDeg = g_req_deg;

        _send(Guidance.cmdSetGimbalRate(R_cmd, cfg.GIMBAL_TARGET));

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
  
  // Always compute apogee — used both for the apogee-trigger path
  // and for the diagnostic payload (recorded at MECO regardless of
  // which trigger mode fired).
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
  
  if (_constants.MECO_TRIGGER_ON_FUEL) {
    // Fuel-based trigger: fire MECO the first tick where the current
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
// One-tick predictive: fire on the tick BEFORE residual would
// drop below target. By the time the MECO command reaches
// physics, one more physics step runs and burns mdot·dt more;
// predicting that overshoot lets us hit the target almost
// exactly (off by less than one tick's worth of fuel).
//
// residualNextTick = residual − mdot_now · dt
//   fire when residualNextTick <= target
const dt = env.DT;
const burnThisTick = mdot_now * dt;
const residualNextTick = residual - burnThisTick;
if (residualNextTick <= target) shouldFire = true;
  } else {
    // Apogee-based trigger (legacy).
    if (apogeeKm >= _constants.MECO_APOGEE_KM) shouldFire = true;
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
  STAGE_BURN_LOCK_TILT_DEG: 90,
// AoA bootstrap margin + PD gains.
  // AoA bootstrap margin + PD gains. AoA entering STAGE_BURN is ~1°
// from gravity-gradient drift during the 10m axial wait; the
// standard controller's torque spike on that first tick is violent
// enough to wobble the stage. Bootstrap damps AoA below margin with
// a critically-damped PD (kp, kd), then hands off to the standard
// controller. For critical damping set kd ≈ 2·√kp.
STAGE_BURN_AOA_MARGIN_DEG: 0.001,
  STAGE_BURN_AOA_KP: 1.0,
  STAGE_BURN_AOA_KD: 2.0,
  // Target AoA offset from velocity during STAGE_BURN (deg). Zero =
  // nose perfectly aligned (fastest tilt evolution). Small positive
  // or negative value introduces a perpendicular thrust component
  // that changes the natural tilt growth rate.
  STAGE_BURN_AOA_BIAS_DEG: 0.59,
    COAST_TARGET_TILT_DEG: -90,
      COAST_ROTATE_TOL_DEG: 0.5,
      COAST_ROTATE_OMEGA_TOL: 0.02,
      COAST_ROTATE_TIMEOUT_S: 240,
      COAST_WAIT_BEFORE_APOGEE_S: 90,
      CIRC_TRIGGER_LEAD_S: 5.53,
      CIRC_DECAY_FRAC: 0.05,
      CIRC_ATT_KP: 0.5,
      CIRC_ATT_KD: 4.0,
      COAST_BURN_MULTIPLIER: 4.0,
      TARGET_ORBIT_ALT_KM: 320,
      // Minimum distance from stage to a released payload body for it to
      // count as "cleared". Small enough to fire quickly after release,
      // large enough to skip transient spawn-overlap frames.
      PAYLOAD_CLEAR_DIST_M: 20,
      // Fail-safe: if payload never confirms (spawn stuck, marker missing),
      // insertion ends after this many seconds anyway so the mission can
      // continue.
      PAYLOAD_CONFIRM_TIMEOUT_S: 120,
    },
    importantFields: [],
    createInstance: function () {
      // ---- Instance state ----
      let _constants = null;
      let _bodyIdx = null;
      let _missionCtx = null;
      let _done = false;
      let _result = null;

      // Sub-machine state — mirrors V2's _leoStateV2 slice relevant to
      // STAGE_BURN..COAST_HOLD_2 + DONE payload-monitor.
      const _st = {
    init: false,
    ticks: 0,
    phase: "STAGE_BURN",
    phaseStart: 0,
    // STAGE_BURN
    stageBurnLocked: false,
    stageBurnTargetTiltDeg: 0,
    stageBurnSpooled: false,
    stageBurnAoaBootstrapped: false,
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
const localVert = Math.atan2(-body.rx, body.ry);
const currentTiltDeg = ((body.theta - localVert) * 180) / Math.PI;

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

if (
  !_st.stageBurnLocked &&
  Math.abs(currentTiltDeg) >= cfg.STAGE_BURN_LOCK_TILT_DEG
) {
  _st.stageBurnLocked = true;
  _st.stageBurnTargetTiltDeg =
    currentTiltDeg >= 0
      ? cfg.STAGE_BURN_LOCK_TILT_DEG
      : -cfg.STAGE_BURN_LOCK_TILT_DEG;
}

// ---- Attitude torque ----
// Bootstrap: AoA entering STAGE_BURN is ~1° from gravity-gradient drift
// during the 10m axial wait. Standard controller's torque on that first
// tick is violent enough to wobble the stage. Damp AoA to below
// STAGE_BURN_AOA_MARGIN_DEG first, then hand off. Once handed off,
// never return to the bootstrap branch — the standard controller takes
// over from that tick onward.
let tau_desired = null;
const aoaDegNow = Number.isFinite(dNext.alphaDeg) ? dNext.alphaDeg : 0;

if (!_st.stageBurnAoaBootstrapped) {
  if (Math.abs(aoaDegNow) > cfg.STAGE_BURN_AOA_MARGIN_DEG) {
    // PD on AoA — but using AoA's OWN rate, not raw body omega.
    //
    // Why raw omega doesn't work: during a powered burn the velocity
    // vector itself rotates (gravity turn continues). A raw-omega PD
    // sees ω_body == velocity-rotation-rate, reads "no rate", and
    // holds AoA at whatever value the two happened to cancel at — a
    // nonzero steady state. Using d(AoA)/dt = ω_body + P/r² (the true
    // kinematic AoA rate including the drift term) drives AoA to zero
    // at steady state.
    const cosT = Math.cos(dNext.theta);
    const sinT = Math.sin(dNext.theta);
    const u = dNext.relVx * cosT + dNext.relVy * sinT;
    const v = -dNext.relVx * sinT + dNext.relVy * cosT;
    const thrustIx = dNext.thrustBodyX * cosT - dNext.thrustBodyY * sinT;
    const thrustIy = dNext.thrustBodyX * sinT + dNext.thrustBodyY * cosT;
    const Md = dNext.massProps.M;
    const aIx = dNext.gVecX + (thrustIx + dNext.dragVecX) / Md;
    const aIy = dNext.gVecY + (thrustIy + dNext.dragVecY) / Md;
    const ax = aIx * cosT + aIy * sinT;
    const ay = -aIx * sinT + aIy * cosT;
    const r2 = u * u + v * v;
    const P = v * ax - u * ay;
    const omegaAoA = (r2 > 1e-6) ? (dNext.omega + P / r2) : dNext.omega;
    
    const aoaRadNow = aoaDegNow * Math.PI / 180;
    const kp = cfg.STAGE_BURN_AOA_KP;
    const kd = cfg.STAGE_BURN_AOA_KD;
    tau_desired = -I_next * (kp * aoaRadNow + kd * omegaAoA);
  } else {
    _st.stageBurnAoaBootstrapped = true;
    // Fall through to standard controller on this same tick.
  }
}

if (tau_desired === null) {
  if (_st.stageBurnLocked) {
    const targetAbsTheta =
      localVert + (_st.stageBurnTargetTiltDeg * Math.PI) / 180;
    const thetaErr = _wrapPi(body.theta - targetAbsTheta);
    const r2 = body.rx * body.rx + body.ry * body.ry;
    const h = body.rx * body.vy - body.ry * body.vx;
    const omegaLocalVert = r2 > 1 ? h / r2 : 0;
    const omegaRelToTarget = body.omega - omegaLocalVert;
    tau_desired =
      -I_next *
      (cfg.CIRC_ATT_KP * thetaErr +
        cfg.CIRC_ATT_KD * omegaRelToTarget);
  } else {
  // Same PD-on-AoA as the bootstrap, but running continuously while
  // STAGE_BURN is unlocked. Using AoA's own rate (ω_body + P/r²)
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
  const biasRad2 = (Number.isFinite(cfg.STAGE_BURN_AOA_BIAS_DEG) ? cfg.STAGE_BURN_AOA_BIAS_DEG : 0) * Math.PI / 180;
  const aoaErr2 = aoaRad2 - biasRad2;
  const kp2 = cfg.STAGE_BURN_AOA_KP;
  const kd2 = cfg.STAGE_BURN_AOA_KD;
  tau_desired = -I_next * (kp2 * aoaErr2 + kd2 * omegaAoA2);
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
            if (Math.abs(g_req_deg) > env.GIMBAL_MAX_DEG) {
              g_req_deg = Math.sign(g_req_deg) * env.GIMBAL_MAX_DEG;
            }
            const R_req = (g_req_deg - g_N) / dt;
            const R_cmd = Math.max(
              -env.GIMBAL_RATE_DEG_S,
              Math.min(env.GIMBAL_RATE_DEG_S, R_req),
            );
            _send(Guidance.cmdSetGimbalRate(R_cmd));

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
              apogeeKm >= cfg.TARGET_ORBIT_ALT_KM ||
              apogeePredicted_margin >= cfg.TARGET_ORBIT_ALT_KM
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

            const errKm = apogeeKm_b - cfg.TARGET_ORBIT_ALT_KM;
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
              const v_orb = Math.sqrt(GM_c / r_apo);
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
                  const vOrb_cap = Math.sqrt(GM_cap / rApo_cap);
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
              const tau_desired =
                -I_next *
                (cfg.CIRC_ATT_KP * thetaErr + cfg.CIRC_ATT_KD * body.omega);
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
              if (Math.abs(g_req_deg) > env.GIMBAL_MAX_DEG) {
                g_req_deg = Math.sign(g_req_deg) * env.GIMBAL_MAX_DEG;
              }
              const R_req = (g_req_deg - g_N) / dt;
              const R_cmd = Math.max(
                -env.GIMBAL_RATE_DEG_S,
                Math.min(env.GIMBAL_RATE_DEG_S, R_req),
              );
              _send(Guidance.cmdSetGimbalRate(R_cmd));
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
              let thetaApo;
              if (e_mag > 1e-6) {
                const phiApo = Math.atan2(-ex_ecc, -ey_ecc);
                const E_c = 0.5 * v2_c - GM_c / r_c;
                const a_c = E_c < 0 ? -GM_c / (2 * E_c) : r_c;
                const r_apo = a_c * (1 + e_mag);
                const rx_apo = r_apo * Math.sin(phiApo);
                const ry_apo = r_apo * Math.cos(phiApo);
                const vt_c =
                  body.vx * (body.ry / r_c) + body.vy * (-body.rx / r_c);
                const sDir = vt_c >= 0 ? 1 : -1;
                thetaApo = Math.atan2(-sDir * ry_apo, -sDir * rx_apo);
              } else {
                const speed_c = Math.hypot(body.vx, body.vy);
                thetaApo =
                  speed_c > 1 ? Math.atan2(-body.vx, body.vy) : body.theta;
              }
              _st.coast2TargetThetaInertial = thetaApo;
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

            const r_c = Math.hypot(body.rx, body.ry);
            const ux_c = body.rx / r_c,
              uy_c = body.ry / r_c;
            const vr_c = body.vx * ux_c + body.vy * uy_c;

            const prevVr = _st._prevVr2;
            _st._prevVr2 = vr_c;
            const apogeePeak =
              prevVr !== null &&
              prevVr !== undefined &&
              prevVr > 0 &&
              vr_c <= 0;

            if (apogeePeak) {
              _send(Guidance.cmdRcsDuty(null, idx));
              _send(Guidance.cmdReleasePayload());
              _st.deployCommandSimTime = simT;
              _deployCmdTick = _st.ticks;
              _payloadBodyCountAtDeploy = snapshot.bodies.length;
              _st.phase = "DONE";
              _st.phaseStart = simT;
              break;
            }

            if (
              dNext &&
              dNext.massProps &&
              _st.coast2TargetThetaInertial !== null
            ) {
              const I_next = dNext.massProps.I;
              const thetaErr = _wrapPi(
                body.theta - _st.coast2TargetThetaInertial,
              );
              const tau_desired =
                -I_next *
                (cfg.CIRC_ATT_KP * thetaErr + cfg.CIRC_ATT_KD * body.omega);
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
          // DONE — payload monitor + attitude hold.
          // Mission-level code handles the dwell + suicide dispatch.
          case "DONE": {
            _send(Guidance.cmdSetAllThrottle(0));
            _send(Guidance.cmdSetGimbalRate(0));

            // Attitude hold — same as V2's DONE phase
            if (
              dNext &&
              dNext.massProps &&
              _st.coast2TargetThetaInertial !== null
            ) {
              const I_next = dNext.massProps.I;
              const thetaErr = _wrapPi(
                body.theta - _st.coast2TargetThetaInertial,
              );
              const tau_desired =
                -I_next *
                (cfg.CIRC_ATT_KP * thetaErr + cfg.CIRC_ATT_KD * body.omega);
              const result = GuideRCS.targetTorqueRcsNoNetForce(
                snapshot,
                tau_desired,
                idx,
              );
              if (result && result.fires.length)
                _send(Guidance.cmdRcsDuty(result.duties, idx));
              else _send(Guidance.cmdRcsDuty(null, idx));
            }

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

          _st.init = false;
          _st.ticks = 0;
          _st.phase = "STAGE_BURN";
          _st.phaseStart = 0;
          _st.stageBurnLocked = false;
_st.stageBurnTargetTiltDeg = 0;
_st.stageBurnSpooled = false;
_st.stageBurnAoaBootstrapped = false;
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
          _st.deployCommandSimTime = null;
          _st.payloadCleared = false;

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
      stageBurnLocked: _st.stageBurnLocked,
      stageBurnTargetTiltDeg: _st.stageBurnTargetTiltDeg,
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
      SUICIDE_TRIM_FAR_DEG: 1.0,
      SUICIDE_TRIM_MIN_DUTY: 0.15,
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
                if (Math.abs(g_req_deg) > env.GIMBAL_MAX_DEG) {
                  g_req_deg = Math.sign(g_req_deg) * env.GIMBAL_MAX_DEG;
                }
                const R_req = (g_req_deg - g_N) / dt;
                const R_cmd = Math.max(
                  -env.GIMBAL_RATE_DEG_S,
                  Math.min(env.GIMBAL_RATE_DEG_S, R_req),
                );
                _send(Guidance.cmdSetGimbalRate(R_cmd));
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

            if (_st.suicideTrimStartT === 0) {
              _st.suicideTrimStartT = simT;
            }

            if (simT - _st.suicideTrimStartT > cfg.SUICIDE_TRIM_MAX_S) {
              _st.suicideTrimDone = true;
              _send(Guidance.cmdRcsDuty(null, idx));
              _done = true;
              _result = {
                bodyIdx: _bodyIdx,
                trimConverged: false,
                trimTimedOut: true,
                suicideImpactEfDeg:
                  _st.suicideImpactEf != null
                    ? (_st.suicideImpactEf * 180) / Math.PI
                    : null,
                suicideDlambdaDeg:
                  _st.suicideDlambda != null
                    ? (_st.suicideDlambda * 180) / Math.PI
                    : null,
              };
              break;
            }

            const speedH = Math.hypot(body.vx, body.vy);
let rHold = null;
if (speedH > 1) {
  const ux_v = body.vx / speedH;
  const uy_v = body.vy / speedH;
  const targetThetaRad = Math.atan2(ux_v, -uy_v);
  const thetaErrH = _wrapPi(body.theta - targetThetaRad);
  const I_nextH = dNext && dNext.massProps ? dNext.massProps.I : 0;
  if (I_nextH > 0) {
    const tau_hold =
      -I_nextH *
      (cfg.SUICIDE_ATT_KP * thetaErrH +
        cfg.SUICIDE_ATT_KD * body.omega);
    rHold = GuideRCS.targetTorqueRcsNoNetForce(
      snapshot,
      tau_hold,
      idx,
    );
  }
}

            const impact = _predictImpact(
              body.rx,
              body.ry,
              body.vx,
              body.vy,
              simT,
              cfg.SUICIDE_PREDICT_DT_S,
              cfg.SUICIDE_PREDICT_HORIZON_S,
              env.GM_EARTH,
              env.EARTH_RADIUS,
              env.EARTH_OMEGA,
            );
            if (!impact) {
              const duties = GuideRCS.postSeparationAxialDuty(
                snapshot,
                idx,
                "up",
              );
              if (duties) _send(Guidance.cmdRcsDuty(duties, idx));
              break;
            }

            const lambdaMidEf = (env.LAUNCH_SITE_ANGLE_0 || 0) -
  midWestDeg * Math.PI / 180;
let dLambdaDeg = (impact.phiEf - lambdaMidEf) * 180 / Math.PI;
// Wrap to [-180°, 180°] so the trim takes the SHORT way around
// the planet. Without this, an impact at +166° with target at
// -140° gives a raw diff of +306°, which the code misreads as
// "impact far east, need huge retrograde correction". The true
// error is 54° EAST (the other way around), needing only small
// prograde. Fires wrong direction otherwise.
while (dLambdaDeg > 180) dLambdaDeg -= 360;
while (dLambdaDeg < -180) dLambdaDeg += 360;
            
            
        



            if (Math.abs(dLambdaDeg) < cfg.SUICIDE_TRIM_TOL_DEG) {
              _st.suicideTrimDone = true;
              _send(Guidance.cmdRcsDuty(null, idx));
              _done = true;
              _result = {
                bodyIdx: _bodyIdx,
                trimConverged: true,
                trimTimedOut: false,
                suicideImpactEfDeg: (impact.phiEf * 180) / Math.PI,
                suicideDlambdaDeg: dLambdaDeg,
              };
              break;
            }



            const direction = dLambdaDeg > 0 ? "up" : "dn";
const FAR = cfg.SUICIDE_TRIM_FAR_DEG;
const MIN_DUTY = cfg.SUICIDE_TRIM_MIN_DUTY;
let duty = Math.min(1, Math.abs(dLambdaDeg) / Math.max(FAR, 1e-6));
if (duty < MIN_DUTY) duty = MIN_DUTY;

const duties = GuideRCS.postSeparationAxialDuty(snapshot, idx, direction);
if (duties) {
  Object.keys(duties).forEach(podId => {
    const dd = duties[podId];
    if (!dd) return;
    dd.up *= duty;
    dd.dn *= duty;
    dd.lat *= duty;
  });
  // Merge with the attitude-hold duties computed above so
  // trim no longer overwrites hold. Different nozzle axes
  // (trim uses up/dn, hold uses lat + its own up/dn pairs),
  // so the two compose on the same duty table.
  if (rHold && rHold.duties) {
    Object.keys(rHold.duties).forEach(podId => {
      if (!duties[podId]) duties[podId] = { up: 0, dn: 0, lat: 0 };
      const rh = rHold.duties[podId];
      duties[podId].up = Math.min(1, duties[podId].up + (rh.up || 0));
      duties[podId].dn = Math.min(1, duties[podId].dn + (rh.dn || 0));
      duties[podId].lat = Math.min(1, duties[podId].lat + (rh.lat || 0));
    });
  }
  _send(Guidance.cmdRcsDuty(duties, idx));
}
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
};