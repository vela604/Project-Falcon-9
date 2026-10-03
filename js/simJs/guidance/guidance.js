// ============================================================================
// guidance.js — Production guidance orchestrator.
//
// SCOPE: this file ships EXACTLY ONE user-facing guide — leoInsertionV2 —
// plus the internal ascent sub-machine (_hTick / ASCENT_HOLD) that
// leoInsertionV2's ASCENT phase delegates to. Every other guide that has
// ever existed (testGuide, predictiveTorque, predictivePlus, the AoA-push
// family, ascentRR, ascentAoaHold-as-public-guide, leoInsertion v1,
// gimbalPredictive2, predictVerifier) has been moved verbatim to
// guidance-experiments.js. That file is NOT loaded by any worker — it's
// kept as an archive for the guidance_log.html history and for future
// reference if we ever want to bring an experiment back.
//
// Everything here is scoped so that leoInsertionV2 is UNAFFECTED by the
// removal — the ascent sub-machine, config bag, phase log, command
// builders, and export/import state all behave byte-for-byte the same as
// they did in the pre-split file.
//
// Sibling modules (loaded by the same worker as this file):
//   - imu.js        → measure()      : sensor noise model
//   - derivation.js → Derivation.*   : mass props, per-member aero
//   - guidercs.js   → GuideRCS.*     : torque → RCS duty tables
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
    _lastSimTime = _lastMeasuredSnapshot.simTime || 0;
    tick(_lastMeasuredSnapshot);

    // Phase-log update: compare the guide's current phase to the last
    // one we recorded. On change, freeze the old phase's endT and open a
    // new entry. Runs every tick (cheap — just a string compare) so the
    // recorded times are as precise as possible.
    if (_activeGuide && GUIDES[_activeGuide]) {
      const g = GUIDES[_activeGuide];
      const st = (typeof g.getStatus === 'function') ? g.getStatus() : null;
      const ph = st && st.phase;
      if (ph && ph !== _lastSeenPhase) {
        const nowT = _lastSimTime;
        if (_lastSeenPhase && _phaseLog[_lastSeenPhase]) {
          _phaseLog[_lastSeenPhase].endT = nowT;
        }
        _lastSeenPhase = ph;
        if (_guideStartT === null) _guideStartT = nowT;
        _phaseLog[ph] = { startT: nowT, endT: null };
      }
    }
  }

  // ============================================================
  // Guide framework. Each guide is a tick function with optional
  // .start() / .stop() lifecycle hooks and optional .getStatus()
  // for UI feedback. Exactly one is active at a time.
  // ============================================================
  const GUIDES = {};
  let _activeGuide = null;

  // ---------------------------------------------------------------------------
  // Per-guide ordered list of phases (raw internal names). The display layer
  // further down maps these to friendly / merged / hidden labels.
  // ---------------------------------------------------------------------------
  const GUIDE_PHASE_SEQUENCES = {
    leoInsertionV2: [
      'ASCENT', 'MECO_SPOOL', 'SEPARATED_AXIAL', 'STAGE_BURN', 'RCS_BOOST',
      'COAST_ROTATE', 'COAST_WAIT', 'COAST_HOLD', 'CIRCULARIZE',
      'COAST_ROTATE_2', 'COAST_HOLD_2', 'DONE',
      'SUICIDE_ROTATE', 'SUICIDE_BURN', 'SUICIDE_COAST',
    ],
  };

  // ---- Phase timeline tracking ----------------------------------------------
  // Display-layer transform for the phase timeline. The phase machine's
  // internal names NEVER change here — this is purely how the sim page's
  // checkpoint panel labels things. See original file for the full rule set.
  const GUIDE_PHASE_DISPLAY = {
    leoInsertionV2: {
      COAST_ROTATE: 'COAST',
      COAST_WAIT: 'COAST',
      COAST_HOLD: 'COAST',
      COAST_ROTATE_2: 'PAYLOAD DEPLOY',
      COAST_HOLD_2: 'PAYLOAD DEPLOY',
      MECO_SPOOL: 'MECO',
      SEPARATED_AXIAL: 'SEPARATION',
      STAGE_BURN: 'ORBIT BURN',
      RCS_BOOST: 'APOGEE TRIM',
      CIRCULARIZE: 'CIRCULARIZE',
      DONE: 'MISSION COMPLETE',
      SUICIDE_ROTATE: 'DEORBIT',
      SUICIDE_BURN: 'DEORBIT',
      SUICIDE_COAST: 'IMPACT',
    },
  };

  // Apply the display transform to a raw (sequence, log) pair and return
  // the display-ready versions plus the current phase's display name.
  function _applyPhaseDisplay(guideName, rawSeq, rawLog, rawCurrentPhase) {
    const map = GUIDE_PHASE_DISPLAY[guideName] || {};
    const displaySeq = [];
    const rawToDisp = {};
    rawSeq.forEach(ph => {
      const disp = (ph in map) ? map[ph] : ph;
      rawToDisp[ph] = disp;
      if (disp === null) return; // hidden
      if (!displaySeq.includes(disp)) displaySeq.push(disp);
    });
    const displayLog = {};
    rawSeq.forEach(ph => {
      const disp = rawToDisp[ph];
      if (disp === null) return; // hidden
      const e = rawLog[ph];
      if (!e) return;
      const cur = displayLog[disp];
      if (!cur) {
        displayLog[disp] = { startT: e.startT, endT: e.endT };
      } else {
        if (Number.isFinite(e.startT) &&
          (!Number.isFinite(cur.startT) || e.startT < cur.startT)) {
          cur.startT = e.startT;
        }
        if (e.endT === null || e.endT === undefined) {
          cur.endT = null;
        } else if (cur.endT !== null && cur.endT !== undefined) {
          if (e.endT > cur.endT) cur.endT = e.endT;
        }
      }
    });
    const curDisp = rawCurrentPhase ? (rawToDisp[rawCurrentPhase] || null) : null;
    return { displaySeq, displayLog, curDisp };
  }

  // Rolling log of { [phaseName]: { startT, endT } } for the active guide.
  // endT is null while a phase is still in progress. Reset on every
  // startGuide. Sent to the main thread inside every guideStatus push so
  // the UI can render the vertical checkpoint timeline.
  let _phaseLog = {};
  let _lastSeenPhase = null;
  let _guideStartT = null;
  let _lastSimTime = 0;

  // Status labels — empty now that only leoInsertionV2 remains (which is
  // not flagged). Kept as an object so getGuideStatusLabel keeps working
  // for any future guide that wants an inline annotation.
  const GUIDE_STATUS_LABELS = {};
  function getGuideStatusLabel(name) { return GUIDE_STATUS_LABELS[name] || ''; }

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
    _phaseLog = {};
    _lastSeenPhase = null;
    _guideStartT = null;
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
    _activeGuide = (name && GUIDES[name]) ? name : null;
  }
  function getActiveGuide() { return _activeGuide; }
  function listGuides() { return Object.keys(GUIDES); }

  function getGuideStatus() {
    if (!_activeGuide) return { active: null };
    const g = GUIDES[_activeGuide];
    const out = { active: _activeGuide };
    if (typeof g.getStatus === 'function') Object.assign(out, g.getStatus());
    const rawSeq = GUIDE_PHASE_SEQUENCES[_activeGuide] || [];
    const transformed = _applyPhaseDisplay(_activeGuide, rawSeq, _phaseLog, out.phase);
    out.phaseSequence = transformed.displaySeq;
    out.phaseLog = transformed.displayLog;
    out.phaseDisplay = transformed.curDisp;
    out.guideStartT = _guideStartT;
    out.simTime = _lastSimTime;
    return out;
  }

  // ---- Guide state pack/unpack (for main-thread fast-forward) ----
  function exportGuideState() {
    const out = { activeGuide: _activeGuide };
    try {
      out.hState = JSON.parse(JSON.stringify(_hState));
      out.leoStateV2 = JSON.parse(JSON.stringify(_leoStateV2));
      out.guideConfigs = {};
      Object.keys(_GUIDE_CONFIGS).forEach(name => {
        out.guideConfigs[name] = getGuideConfig(name);
      });
      out.phaseLog = JSON.parse(JSON.stringify(_phaseLog || {}));
      out.lastSeenPhase = _lastSeenPhase;
      out.guideStartT = _guideStartT;
      out.lastSimTime = _lastSimTime;
    } catch (e) {
      console.warn('[guidance] exportGuideState failed', e);
    }
    return out;
  }

  function importGuideState(data) {
    if (!data) return;
    try {
      if (data.hState) Object.assign(_hState, data.hState);
      if (data.leoStateV2) Object.assign(_leoStateV2, data.leoStateV2);
      if (data.activeGuide !== undefined) _activeGuide = data.activeGuide;
      if (data.guideConfigs && typeof data.guideConfigs === 'object') {
        Object.keys(data.guideConfigs).forEach(name => {
          const v = data.guideConfigs[name];
          if (v && typeof v === 'object') {
            try { applyGuideConfig(name, v); } catch (e) {
              console.warn('[guidance] importGuideState config restore failed for', name, e);
            }
          }
        });
      }
      if (data.phaseLog && typeof data.phaseLog === 'object') {
        _phaseLog = JSON.parse(JSON.stringify(data.phaseLog));
      }
      if (data.lastSeenPhase !== undefined) _lastSeenPhase = data.lastSeenPhase;
      if (data.guideStartT !== undefined) _guideStartT = data.guideStartT;
      if (data.lastSimTime !== undefined) _lastSimTime = data.lastSimTime;
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
  // Internal ascent sub-machine — ASCENT_HOLD config + _hTick.
  //
  // NOT registered as a user-facing guide. This is the state machine
  // leoInsertionV2's ASCENT phase delegates to (`_hTick(snapshot,
  // LEO_INSERTION_V2.ASCENT)`). Moved here from the old standalone
  // ascentAoaHold guide, unchanged — the tick function, its state object,
  // its phase machine, and its debug readout all behave identically.
  // ============================================================
  const ASCENT_HOLD = {
    INITIAL_COAST_S: 11.3,
    PUSH_T_S: 10.3,
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
  };

  const _hState = {
    init: false,
    ticks: 0,
    phase: 'PUSH',
    phaseStart: 0,
    currentDeltaDeg: 0,
    lastThrottleSent: undefined,
    lastQ: null,
    lastDQ: 0,
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

  // cfgOverride: optional config bag. leoInsertionV2 passes its own
  // LEO_INSERTION_V2.ASCENT so its ascent constants are tuned separately
  // from ASCENT_HOLD's own values.
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
    const gimbalTarget = cfg.GIMBAL_TARGET || 'all';
    const gimbals = engines.filter(e => e.gimbal && (gimbalTarget !== 'center' || e.isCenter));
    if (!gimbals.length) return;

    const g_N  = gimbals[0].gimbalDeg || 0;
    const R_N  = Number.isFinite(gimbals[0].targetGimbalRateDegS)
      ? gimbals[0].targetGimbalRateDegS : 0;
    const g_N1 = g_N + R_N * dt;

    const dNext = Derivation.deriveForState(snapshot, idx, {
      rx: rx_n, ry: ry_n, vx: vx_n, vy: vy_n,
      theta: theta_n, omega: omega_n,
      slosh: { offset: sloshX_n, velocity: sloshV_n },
    }, g_N1, cfg.GIMBAL_TARGET);
    if (!dNext || !dNext.massProps) return;

    const τ_drag_next = dNext.torqueDrag;
    _hState.lastTauDrag = τ_drag_next;
    const I_next = dNext.massProps.I;

    // ---------- AoA derivatives — ANALYTIC ----------
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
    const omegaAoANow = (r2C > 1e-6) ? (dNow.omega + PC / r2C) : 0;
    const alphaAoANow = (r2C > 1e-6) ? (dNow.alphaAng - 2 * PC * QC / (r2C * r2C)) : 0;

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
        _hState.lastLockedDeltaDeg = _hState.currentDeltaDeg;
      }
    } else if (_hState.phase === 'PUSH') {
      if (elapsed >= cfg.PUSH_T_S) {
        _hState.phase = 'COAST';
        _hState.phaseStart = simT;
      }
    } else if (_hState.phase === 'COAST') {
      if (dNow.alphaDeg >= 0) {
        _hState.phase = 'HOLD';
        _hState.phaseStart = simT;
      }
    } else if (_hState.phase === 'HOLD') {
      if (dNow.alphaDeg < 0) {
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
      const useNow = (dQ < 0);
      const I_use = useNow ? dNow.massProps.I : I_next;
      const alpha_use = useNow ? alphaAoANow : alphaAoANext;
      const omega_use = useNow ? omegaAoANow : omegaAoANext;
      const τ_accel = -I_use * alpha_use;
      const τ_damp = -cfg.HOLD_K_DAMP * I_use * omega_use;

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

    send(cmdSetGimbalRate(R_cmd, cfg.GIMBAL_TARGET));

    // ---------- Throttle ----------
    let refMax = 0;
    engines.forEach(e => { if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > refMax) refMax = e.maxMassFlowRate; });

    let thrFrac = (Number.isFinite(cfg.THROTTLE_FRAC) && cfg.THROTTLE_FRAC > 0) ?
      Math.min(1, cfg.THROTTLE_FRAC) : 1.0;

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
    console.log('[ascent sub-machine] started');
  };
  _hTick.stop = function () {
    send(cmdSetAllThrottle(0));
    send(cmdSetGimbalRate(0));
    _hState.init = false;
    console.log('[ascent sub-machine] stopped');
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

  // ============================================================
  // leoInsertionV2 — full autonomous mission to LEO + suicide-burn
  // deorbit onto the resting area.
  //
  // Phase flow:
  //   ASCENT → MECO_SPOOL → SEPARATED_AXIAL → STAGE_BURN
  //   → RCS_BOOST → COAST_ROTATE → COAST_HOLD → CIRCULARIZE
  //   → COAST_ROTATE_2 → COAST_HOLD_2 → DONE
  //   → SUICIDE_ROTATE → SUICIDE_BURN → SUICIDE_COAST
  // ============================================================
  const LEO_INSERTION_V2 = {
    ASCENT: {
      INITIAL_COAST_S: 4.9,
      PUSH_T_S: 4.8,
      PUSH_MAX_GIMBAL_DEG: 0.6,
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
      GIMBAL_TARGET: 'center',
    },

    MECO_APOGEE_KM: 150,

    AXIAL_SEP_TARGET_M: 10,
    SPLIT_TIMEOUT_S: 10,

    FAIRING_OPEN_ALT_KM: 80,
    FAIRING_OPEN_ENABLED: true,

    TARGET_ORBIT_ALT_KM: 320,

    STAGE_BURN_CUTOFF_MARGIN_MPS: 0.0,
    STAGE_BURN_LOCK_TILT_DEG: 90,

    COAST_TARGET_TILT_DEG: -90,
    COAST_ROTATE_TOL_DEG: 0.5,
    COAST_ROTATE_OMEGA_TOL: 0.02,
    COAST_ROTATE_TIMEOUT_S: 240,
    COAST_WAIT_BEFORE_APOGEE_S: 90,

    CIRC_TRIGGER_LEAD_S: 1.0,
    CIRC_DECAY_FRAC: 0.05,
    CIRC_ATT_KP: 0.5,
    CIRC_ATT_KD: 4.0,
    COAST_BURN_MULTIPLIER: 4.0,

    SUICIDE_DELAY_AFTER_DEPLOY_S: 60,
    SUICIDE_ROTATE_TOL_DEG: 1.0,
    SUICIDE_ROTATE_OMEGA_TOL: 0.02,
    SUICIDE_ROTATE_TIMEOUT_S: 120,
    SUICIDE_ATT_KP: 0.5,
    SUICIDE_ATT_KD: 4.0,
    SUICIDE_PREDICT_DT_S: 2,
    SUICIDE_PREDICT_HORIZON_S: 4000,
    SUICIDE_BURN_MAX_S: 600,
    SUICIDE_BURN_COARSE_MARGIN_DEG: 10,
    SUICIDE_TRIM_TOL_DEG: 0.1,
    SUICIDE_TRIM_FAR_DEG: 1.0,
    SUICIDE_TRIM_MIN_DUTY: 0.15,
    SUICIDE_TRIM_MAX_S: 120,
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
    missionBodyIdx: null,
    preSplitBodyId: null,
    boosterIdx: -1,
    stageIdx: -1,
    lastAltKm: 0,
    lastAxialGap: 0,
    lastApogeeKm: 0,
    lastApogeeSimT: 0,
    lastPerigeeKm: null,
    stageBurnLocked: false,
    stageBurnTargetTiltDeg: 0,
    _prevApogeeErr: null,
    coastTargetThetaInertial: null,
    coastRotateStartTilt: null,
    coastRotateMid: null,
    coastTBurnPractical: 0,
    coastVOrbital: 0,
    _prevVr: null,
    coastRotateSecondPass: false,
    circCurrentV: 0,
    circTargetV: 0,
    circErr: 0,
    circAchieved: false,
    suicideBurnStartT: 0,
    suicideImpactEf: null,
    suicideDlambda: null,
    suicideTrimDone: false,
    suicideTrimStartT: 0,
    coastRotateEndDeltaV: null,
    coastRotateEndTRem: null,
  };

  // Leapfrog ballistic impact prediction (velocity Verlet, two-body).
  function _suicidePredictImpact(rx, ry, vx, vy, simTimeNow) {
    const _env = Derivation.getEnv();
    if (!_env) return null;
    const GM = _env.GM_EARTH;
    const R = _env.EARTH_RADIUS;
    const omegaE = _env.EARTH_OMEGA;
    const dtPred = LEO_INSERTION_V2.SUICIDE_PREDICT_DT_S;
    const maxT = LEO_INSERTION_V2.SUICIDE_PREDICT_HORIZON_S;

    let px = rx, py = ry, pvx = vx, pvy = vy, t = 0;
    while (t < maxT) {
      const r = Math.hypot(px, py);
      if (r <= R) {
        const phiInertial = Math.atan2(px, py);
        const phiEf = phiInertial - omegaE * (simTimeNow + t);
        return { phiEf, tImpact: t, rImpact: r };
      }
      const r3 = r * r * r;
      const ax = -GM * px / r3, ay = -GM * py / r3;
      const vxh = pvx + 0.5 * ax * dtPred;
      const vyh = pvy + 0.5 * ay * dtPred;
      const nx = px + vxh * dtPred;
      const ny = py + vyh * dtPred;
      const nr = Math.hypot(nx, ny);
      const nr3 = nr * nr * nr;
      pvx = vxh + 0.5 * (-GM * nx / nr3) * dtPred;
      pvy = vyh + 0.5 * (-GM * ny / nr3) * dtPred;
      px = nx; py = ny;
      t += dtPred;
    }
    return null;
  }

  function _leoTickV2(snapshot) {
    _leoStateV2.ticks++;
    if (!snapshot || !Array.isArray(snapshot.bodies) || !snapshot.bodies.length) return;

    let idx = Number.isInteger(_leoStateV2.missionBodyIdx)
      ? _leoStateV2.missionBodyIdx
      : (Number.isInteger(snapshot.activeBodyIndex) ? snapshot.activeBodyIndex : 0);
    const body = snapshot.bodies[idx];
    if (!body) return;
    const simT = snapshot.simTime;

    // ---------- Init ----------
    if (!_leoStateV2.init) {
  _leoStateV2.init = true;
  _leoStateV2.phase = 'ASCENT';
  _leoStateV2.phaseStart = simT;
  _leoStateV2.initialBodyCount = snapshot.bodies.length;
  _leoStateV2.preSplitBodyId = body.id || null;
  _leoStateV2.stageIdx = idx;
  _leoStateV2.missionBodyIdx = idx;
  
  // One-time capture of the stack mass and fuel the guide is actually
  // flying with. This is the ground truth for what FF vs 1x see at
  // t=0 — if the initial mass differs, the entire trajectory shifts.
  try {
    const initD = Derivation.derive(snapshot, idx);
    if (initD && initD.massProps) {
      _leoStateV2.initStackMass = initD.massProps.M;
      _leoStateV2.initComH = initD.massProps.comY;
      _leoStateV2.initI = initD.massProps.I;
    }
    _leoStateV2.initFuelMass = body.fuelMass;
    _leoStateV2.initMemberFuel = Array.isArray(body.memberFuel) ? body.memberFuel.slice() : null;
  } catch (e) {
    console.error('[leoInsertionV2] init mass capture failed', e);
  }
      if (typeof Guidance !== 'undefined' && Guidance.setMissionBody) {
        Guidance.setMissionBody(idx);
      }
      if (typeof _hTick !== 'undefined' && typeof _hTick.start === 'function') {
        try { _hTick.start(); } catch (e) { console.error('[leoInsertionV2] _hTick.start failed', e); }
      }

      // Boot-time contract check — env + engine fields must be present.
      (function validateContracts() {
        const envLocal = Derivation.getEnv();
        const requiredEnv = ['DT', 'GM_EARTH', 'EARTH_RADIUS', 'EARTH_OMEGA',
          'GIMBAL_MAX_DEG', 'GIMBAL_RATE_DEG_S'];
        const missEnv = requiredEnv.filter(k => !Number.isFinite(envLocal[k]));
        if (missEnv.length) {
          console.error('[leoInsertionV2] CONTRACT VIOLATION — env missing:',
            missEnv.join(', '));
        }
        const eng = body.engines && body.engines[0];
        if (!eng) { console.error('[leoInsertionV2] CONTRACT VIOLATION — no engine[0]'); return; }
        const requiredEng = ['Ve', 'maxMassFlowRate', 'startupDurationS', 'shutdownDurationS'];
        const missEng = requiredEng.filter(k => !Number.isFinite(eng[k]));
        if (missEng.length) {
          console.error('[leoInsertionV2] CONTRACT VIOLATION — engine missing:',
            missEng.join(', '));
        }
      })();
      console.log('[leoInsertionV2] started, phase ASCENT');
    }

    // ---------- Derive current state + next-tick prediction ----------
    const d = Derivation.derive(snapshot, idx);
    if (!d || !d.massProps) return;
    _leoStateV2.lastAltKm = d.altitudeAGL / 1000;

    const env = Derivation.getEnv();
    const dt = env.DT;
    const M_d = d.massProps.M;

    let dNext = null;
    if (M_d > 0) {
      const cosT = Math.cos(d.theta), sinT = Math.sin(d.theta);
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

    // ==========================================================
    // Phase machine
    // ==========================================================
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
          const E_m = 0.5 * (vr_m * vr_m + vt_m * vt_m) - GM_m / r_m;
          let apogeeKm = Infinity;
          if (E_m < 0) {
            const a_m = -GM_m / (2 * E_m);
            const h_m = r_m * vt_m;
            const e_m = Math.sqrt(Math.max(0, 1 + 2 * E_m * h_m * h_m / (GM_m * GM_m)));
            apogeeKm = (a_m * (1 + e_m) - env.EARTH_RADIUS) / 1000;
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
        const axialGap = Math.max(0, (dx * upX + dy * upY) - boosterHeight);
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

        send(cmdSetAllThrottle(Infinity));

        const I_next = dNext.massProps.I;
        const localVert = Math.atan2(-body.rx, body.ry);
        const currentTiltDeg = (body.theta - localVert) * 180 / Math.PI;

        if (!_leoStateV2.stageBurnLocked &&
          Math.abs(currentTiltDeg) >= LEO_INSERTION_V2.STAGE_BURN_LOCK_TILT_DEG) {
          _leoStateV2.stageBurnLocked = true;
          _leoStateV2.stageBurnTargetTiltDeg = (currentTiltDeg >= 0)
            ? LEO_INSERTION_V2.STAGE_BURN_LOCK_TILT_DEG
            : -LEO_INSERTION_V2.STAGE_BURN_LOCK_TILT_DEG;
          console.log('[leoInsertionV2] STAGE_BURN attitude locked at tilt ' +
            _leoStateV2.stageBurnTargetTiltDeg.toFixed(1) + '° (θ_rel=' +
            currentTiltDeg.toFixed(2) + '°)');
        }

        let tau_desired;
        if (_leoStateV2.stageBurnLocked) {
          const targetAbsTheta = localVert +
            _leoStateV2.stageBurnTargetTiltDeg * Math.PI / 180;
          const thetaErr = _hWrapPi(body.theta - targetAbsTheta);
          const r2 = body.rx * body.rx + body.ry * body.ry;
          const h = body.rx * body.vy - body.ry * body.vx;
          const omegaLocalVert = r2 > 1 ? h / r2 : 0;
          const omegaRelToTarget = body.omega - omegaLocalVert;
          tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                 + LEO_INSERTION_V2.CIRC_ATT_KD * omegaRelToTarget);
        } else {
          const gain = LEO_INSERTION_V2.ASCENT.COAST_DAMP_GAIN;
          const kd = LEO_INSERTION_V2.ASCENT.COAST_DAMP_K;
          tau_desired = (-I_next * gain * dNext.alphaDeg) / (kd * kd);
        }
        const tau_target = tau_desired - dNext.torqueEnvironmental;

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
        if (Math.abs(g_req_deg) > env.GIMBAL_MAX_DEG) {
          g_req_deg = Math.sign(g_req_deg) * env.GIMBAL_MAX_DEG;
        }
        const R_req = (g_req_deg - g_N) / dt;
        const R_cmd = Math.max(-env.GIMBAL_RATE_DEG_S,
                      Math.min(env.GIMBAL_RATE_DEG_S, R_req));
        send(cmdSetGimbalRate(R_cmd));

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
        const perigeeKm_sb = ((p_sb / (1 + e_sb)) - R_ap) / 1000;
        _leoStateV2.lastPerigeeKm = perigeeKm_sb;

        const spoolS = body.engines[0].shutdownDurationS;
        let mdot_now_sb = 0, maxMFR_sb = 0;
        (body.engines || []).forEach(e => {
          mdot_now_sb += (e.massFlowRate || 0);
          if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > maxMFR_sb) {
            maxMFR_sb = e.maxMassFlowRate;
          }
        });
        const t_spool_actual = (maxMFR_sb > 0 && mdot_now_sb > 0)
          ? mdot_now_sb * spoolS / maxMFR_sb : spoolS;
        const a_avg_sb = (mdot_now_sb / 2) * body.engines[0].Ve / Math.max(1, dNext.massProps.M);
        const dv_spool_sb = a_avg_sb * t_spool_actual;
        const dv_with_margin = dv_spool_sb + LEO_INSERTION_V2.STAGE_BURN_CUTOFF_MARGIN_MPS;

        let apogeePredicted_margin = apogeeKm;
if (dv_with_margin > 0) {
  const gimbalRad = (gimbals[0].gimbalDeg || 0) * Math.PI / 180;
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
    const e_pred = Math.sqrt(Math.max(0,
      1 + 2 * E_pred * h_pred * h_pred / (GM_ap * GM_ap)));
    apogeePredicted_margin = (a_pred * (1 + e_pred) - R_ap) / 1000;
  }
}

// Debug — capture every input that feeds the cutoff condition.
// Any of these differing between FF and 1x at the same simTime
// is the exact root cause of divergent cutoff timing.
_leoStateV2.lastApogeePredicted = apogeePredicted_margin;
_leoStateV2.lastDvSpool = dv_with_margin;
_leoStateV2.lastMassM = dNext.massProps.M;
_leoStateV2.lastTheta = body.theta;
_leoStateV2.lastGimbalDeg = gimbals[0].gimbalDeg || 0;
_leoStateV2.lastMdotNow = mdot_now_sb;
_leoStateV2.lastMaxMFR = maxMFR_sb;
_leoStateV2.lastApogee = apogeeKm;
_leoStateV2.lastPerigee = perigeeKm_sb;

if (apogeeKm >= LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM ||
  apogeePredicted_margin >= LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM) {
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

      case 'RCS_BOOST': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

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
        _leoStateV2.lastPerigeeKm = ((p_b / (1 + e_b2)) - R_b) / 1000;

        const engineStillFiring = (body.engines || []).some(e => (e.massFlowRate || 0) > 1);
        if (engineStillFiring) {
          send(cmdRcsDuty(null, idx));
          break;
        }

        const errKm = apogeeKm_b - LEO_INSERTION_V2.TARGET_ORBIT_ALT_KM;
        const prevErr = _leoStateV2._prevApogeeErr;
        _leoStateV2._prevApogeeErr = errKm;

        const crossed = (prevErr !== null && prevErr !== undefined &&
          ((prevErr < 0 && errKm >= 0) || (prevErr > 0 && errKm <= 0)));

        if (crossed) {
          send(cmdRcsDuty(null, idx));

          const r_c = r_b, vr_c = vr_b, vt_c = vt_b;
          const GM_c = GM_b, R_c = R_b, E_c = E_b;
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
          _leoStateV2.coastTBurnPractical =
            t_burn_ideal * LEO_INSERTION_V2.COAST_BURN_MULTIPLIER;
          _leoStateV2.coastVOrbital = v_orb;

          _leoStateV2.phase = 'COAST_ROTATE';
          _leoStateV2.phaseStart = simT;
          _leoStateV2.coastRotateStartTilt = null;
          _leoStateV2.coastRotateMid = null;

          console.log('[leoInsertionV2] RCS_BOOST done — apogee ' +
            apogeeKm_b.toFixed(2) + ' km, perigee=' + _leoStateV2.lastPerigeeKm.toFixed(1) +
            ' km | V_apo=' + v_apo.toFixed(1) + ' V_orb=' + v_orb.toFixed(1) +
            ' Δv=' + dv_needed.toFixed(1) + ' → COAST_ROTATE');
          break;
        }

        const direction = (errKm > 0) ? 'dn' : 'up';
        const duties = GuideRCS.postSeparationAxialDuty(snapshot, idx, direction);
        if (duties) send(cmdRcsDuty(duties, idx));
        else send(cmdRcsDuty(null, idx));
        break;
      }

      case 'COAST_ROTATE': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

        const elapsed = simT - _leoStateV2.phaseStart;
        if (elapsed >= LEO_INSERTION_V2.COAST_ROTATE_TIMEOUT_S) {
          send(cmdRcsDuty(null, idx));
          if (_leoStateV2.coastRotateSecondPass) {
            _leoStateV2.phase = 'COAST_HOLD';
            _leoStateV2.phaseStart = simT;
            console.log('[leoInsertionV2] COAST_ROTATE (2nd pass) timeout — COAST_HOLD');
          } else {
            _leoStateV2.phase = 'COAST_WAIT';
            _leoStateV2.phaseStart = simT;
            _leoStateV2.coastRotateSecondPass = true;
            console.log('[leoInsertionV2] COAST_ROTATE (1st pass) timeout — COAST_WAIT');
          }
          break;
        }

        const targetThetaRad = _leoStateV2.coastTargetThetaInertial;
        if (targetThetaRad === null || targetThetaRad === undefined) {
          send(cmdRcsDuty(null, idx));
          if (_leoStateV2.coastRotateSecondPass) {
            _leoStateV2.phase = 'COAST_HOLD';
            _leoStateV2.phaseStart = simT;
          } else {
            _leoStateV2.phase = 'COAST_WAIT';
            _leoStateV2.phaseStart = simT;
            _leoStateV2.coastRotateSecondPass = true;
          }
          break;
        }

        const thetaErr = _hWrapPi(body.theta - targetThetaRad);
        const omegaRel = body.omega;

        if (Math.abs(thetaErr) < LEO_INSERTION_V2.COAST_ROTATE_TOL_DEG * Math.PI / 180 &&
          Math.abs(omegaRel) < LEO_INSERTION_V2.COAST_ROTATE_OMEGA_TOL) {
          send(cmdRcsDuty(null, idx));
          if (!_leoStateV2.coastRotateSecondPass) {
            const r_cap = Math.hypot(body.rx, body.ry) || 1;
            const ux_cap = body.rx / r_cap, uy_cap = body.ry / r_cap;
            const ex_cap = body.ry / r_cap, ey_cap = -body.rx / r_cap;
            const vr_cap = body.vx * ux_cap + body.vy * uy_cap;
            const vt_cap = body.vx * ex_cap + body.vy * ey_cap;
            const GM_cap = env.GM_EARTH;
            _leoStateV2.coastRotateEndTRem = _hTimeToApogee(r_cap, vr_cap, vt_cap, GM_cap);
            const E_cap = 0.5 * (vr_cap * vr_cap + vt_cap * vt_cap) - GM_cap / r_cap;
            if (E_cap < 0) {
              const a_cap = -GM_cap / (2 * E_cap);
              const h_cap = r_cap * vt_cap;
              const eSq_cap = 1 + 2 * E_cap * h_cap * h_cap / (GM_cap * GM_cap);
              const e_cap = Math.sqrt(Math.max(0, eSq_cap));
              const rApo_cap = a_cap * (1 + e_cap);
              const vApo_cap = Math.abs(h_cap) / rApo_cap;
              const vOrb_cap = Math.sqrt(GM_cap / rApo_cap);
              _leoStateV2.coastRotateEndDeltaV = Math.max(0, vOrb_cap - vApo_cap);
            } else {
              _leoStateV2.coastRotateEndDeltaV = null;
            }
          }
          if (_leoStateV2.coastRotateSecondPass) {
            _leoStateV2.phase = 'COAST_HOLD';
            _leoStateV2.phaseStart = simT;
            console.log('[leoInsertionV2] COAST_ROTATE (2nd pass) done at θ=' +
              (body.theta * 180 / Math.PI).toFixed(2) + '° → COAST_HOLD');
          } else {
            _leoStateV2.phase = 'COAST_WAIT';
            _leoStateV2.phaseStart = simT;
            _leoStateV2.coastRotateSecondPass = true;
            console.log('[leoInsertionV2] COAST_ROTATE (1st pass) done at θ=' +
              (body.theta * 180 / Math.PI).toFixed(2) + '° → COAST_WAIT');
          }
          break;
        }

        const I_next = (dNext && dNext.massProps) ? dNext.massProps.I : 0;
        if (!(I_next > 0)) { send(cmdRcsDuty(null, idx)); break; }
        const tau_desired = -I_next *
          (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
         + LEO_INSERTION_V2.CIRC_ATT_KD * omegaRel);

        const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
        if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
        else send(cmdRcsDuty(null, idx));
        break;
      }

      case 'COAST_WAIT': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));
        send(cmdRcsDuty(null, idx));

        const r_c = Math.hypot(body.rx, body.ry);
        const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
        const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
        const vr_c = body.vx * ux_c + body.vy * uy_c;
        const vt_c = body.vx * ex_c + body.vy * ey_c;
        const t_rem = _hTimeToApogee(r_c, vr_c, vt_c, env.GM_EARTH);

        if (t_rem <= LEO_INSERTION_V2.COAST_WAIT_BEFORE_APOGEE_S) {
          _leoStateV2.phase = 'COAST_ROTATE';
          _leoStateV2.phaseStart = simT;
          _leoStateV2.coastRotateStartTilt = null;
          _leoStateV2.coastRotateMid = null;
          console.log('[leoInsertionV2] COAST_WAIT done — t_rem=' +
            t_rem.toFixed(1) + 's ≤ ' +
            LEO_INSERTION_V2.COAST_WAIT_BEFORE_APOGEE_S + 's → COAST_ROTATE (2nd pass)');
          break;
        }
        break;
      }

      case 'COAST_HOLD': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

        const r_c = Math.hypot(body.rx, body.ry);
        const ux_c = body.rx / r_c, uy_c = body.ry / r_c;
        const ex_c = body.ry / r_c, ey_c = -body.rx / r_c;
        const vr_c = body.vx * ux_c + body.vy * uy_c;
        const vt_c = body.vx * ex_c + body.vy * ey_c;
        const t_rem = _hTimeToApogee(r_c, vr_c, vt_c, env.GM_EARTH);

        const prevVr = _leoStateV2._prevVr;
        _leoStateV2._prevVr = vr_c;
        const apogeePeak = (prevVr !== null && prevVr !== undefined
          && prevVr > 0 && vr_c <= 0);

        const startupS = body.engines[0].startupDurationS;
        const triggerWindowS = startupS + LEO_INSERTION_V2.CIRC_TRIGGER_LEAD_S;

        if (t_rem <= triggerWindowS || apogeePeak) {
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'CIRCULARIZE';
          _leoStateV2.phaseStart = simT;
          console.log('[leoInsertionV2] burn trigger — ' +
            (apogeePeak ? 'apogee peak'
              : 't_rem=' + t_rem.toFixed(2) + 's ≤ ' + triggerWindowS.toFixed(2) + 's')
            + ' — CIRCULARIZE');
          break;
        }

        if (dNext && dNext.massProps && _leoStateV2.coastTargetThetaInertial !== null) {
          const I_next = dNext.massProps.I;
          const thetaErr = _hWrapPi(body.theta - _leoStateV2.coastTargetThetaInertial);
          const tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                       + LEO_INSERTION_V2.CIRC_ATT_KD * body.omega);
          const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
          if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
          else send(cmdRcsDuty(null, idx));
        }
        break;
      }

      case 'CIRCULARIZE': {
        if (!dNext || !dNext.massProps) break;
        const gimbals = (body.engines || []).filter(e => e.gimbal);

        const r_c = Math.hypot(body.rx, body.ry);
        const speed = Math.hypot(body.vx, body.vy);
        const v_orb_target = _leoStateV2.coastVOrbital;
        const v_err = v_orb_target - speed;

        _leoStateV2.circCurrentV = speed;
        _leoStateV2.circTargetV = v_orb_target;
        _leoStateV2.circErr = v_err;

        const spoolS = body.engines[0].shutdownDurationS;
        let mdot_now = 0, maxMFR = 0;
        (body.engines || []).forEach(e => {
          mdot_now += (e.massFlowRate || 0);
          if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > maxMFR) maxMFR = e.maxMassFlowRate;
        });
        const t_spool_actual = (maxMFR > 0 && mdot_now > 0)
          ? mdot_now * spoolS / maxMFR : spoolS;
        const dv_spool = (mdot_now / 2) * body.engines[0].Ve * t_spool_actual
                       / Math.max(1, dNext.massProps.M);

        const ejectionKick = env.PAYLOAD_EJECT_KICK_MPS || 0;
        const cutoffThreshold = dv_spool + ejectionKick;

        if (v_err <= cutoffThreshold) {
          _leoStateV2.circAchieved = true;
          send(cmdSetAllThrottle(0));
          send(cmdSetGimbalRate(0));
          _leoStateV2.phase = 'COAST_ROTATE_2';
          _leoStateV2.phaseStart = simT;
          _leoStateV2.coast2TargetThetaInertial = null;
          _leoStateV2.coast2RotateStartTilt = null;
          _leoStateV2.coast2RotateMid = null;
          _leoStateV2._prevVr2 = null;
          console.log('[leoInsertionV2] CIRCULARIZE complete — v=' + speed.toFixed(1) +
            ' → COAST_ROTATE_2');
          break;
        }

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

        if (gimbals.length && _leoStateV2.coastTargetThetaInertial !== null) {
          const I_next = dNext.massProps.I;
          const thetaErr = _hWrapPi(body.theta - _leoStateV2.coastTargetThetaInertial);
          const tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                       + LEO_INSERTION_V2.CIRC_ATT_KD * body.omega);
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
          if (Math.abs(g_req_deg) > env.GIMBAL_MAX_DEG) {
            g_req_deg = Math.sign(g_req_deg) * env.GIMBAL_MAX_DEG;
          }
          const R_req = (g_req_deg - g_N) / dt;
          const R_cmd = Math.max(-env.GIMBAL_RATE_DEG_S,
                        Math.min(env.GIMBAL_RATE_DEG_S, R_req));
          send(cmdSetGimbalRate(R_cmd));
        }
        break;
      }

      case 'COAST_ROTATE_2': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

        let stillFiring = false;
        (body.engines || []).forEach(e => { if ((e.massFlowRate || 0) > 1) stillFiring = true; });
        if (stillFiring) { send(cmdRcsDuty(null, idx)); break; }

        const elapsed = simT - _leoStateV2.phaseStart;
        if (elapsed >= LEO_INSERTION_V2.COAST_ROTATE_TIMEOUT_S) {
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'COAST_HOLD_2';
          _leoStateV2.phaseStart = simT;
          _leoStateV2._prevVr2 = null;
          console.log('[leoInsertionV2] COAST_ROTATE_2 timeout — COAST_HOLD_2');
          break;
        }

        if (_leoStateV2.coast2TargetThetaInertial === null) {
          const GM_c = env.GM_EARTH;
          const r_c = Math.hypot(body.rx, body.ry);
          const v2_c = body.vx * body.vx + body.vy * body.vy;
          const rv_c = body.rx * body.vx + body.ry * body.vy;
          const ex_ecc = ((v2_c - GM_c / r_c) * body.rx - rv_c * body.vx) / GM_c;
          const ey_ecc = ((v2_c - GM_c / r_c) * body.ry - rv_c * body.vy) / GM_c;
          const e_mag = Math.hypot(ex_ecc, ey_ecc);
          let thetaApo;
          if (e_mag > 1e-6) {
            const phiApo = Math.atan2(-ex_ecc, -ey_ecc);
            const E_c = 0.5 * v2_c - GM_c / r_c;
            const a_c = (E_c < 0) ? -GM_c / (2 * E_c) : r_c;
            const r_apo = a_c * (1 + e_mag);
            const rx_apo = r_apo * Math.sin(phiApo);
            const ry_apo = r_apo * Math.cos(phiApo);
            const vt_c = body.vx * (body.ry / r_c) + body.vy * (-body.rx / r_c);
            const sDir = (vt_c >= 0) ? 1 : -1;
            thetaApo = Math.atan2(-sDir * ry_apo, -sDir * rx_apo);
          } else {
            const speed_c = Math.hypot(body.vx, body.vy);
            thetaApo = (speed_c > 1) ? Math.atan2(-body.vx, body.vy) : body.theta;
          }
          _leoStateV2.coast2TargetThetaInertial = thetaApo;
          console.log('[leoInsertionV2] COAST_ROTATE_2 target θ=' +
            (thetaApo * 180 / Math.PI).toFixed(4) + '° (e=' +
            e_mag.toExponential(4) + ')');
        }

        const targetThetaRad = _leoStateV2.coast2TargetThetaInertial;

        if (_leoStateV2.coast2RotateStartTilt === null) {
          _leoStateV2.coast2RotateStartTilt = body.theta;
          _leoStateV2.coast2RotateMid = _hWrapPi(targetThetaRad - body.theta);
        }
        const startThetaRad = _leoStateV2.coast2RotateStartTilt;
        const deltaTotalRad = _leoStateV2.coast2RotateMid;

        const thetaErr = _hWrapPi(body.theta - targetThetaRad);
        const omegaRel = body.omega;

        if (Math.abs(thetaErr) < LEO_INSERTION_V2.COAST_ROTATE_TOL_DEG * Math.PI / 180 &&
          Math.abs(omegaRel) < LEO_INSERTION_V2.COAST_ROTATE_OMEGA_TOL) {
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'COAST_HOLD_2';
          _leoStateV2.phaseStart = simT;
          _leoStateV2._prevVr2 = null;
          console.log('[leoInsertionV2] COAST_ROTATE_2 done at θ=' +
            (body.theta * 180 / Math.PI).toFixed(2) + '° → COAST_HOLD_2');
          break;
        }

        const dirSign = Math.sign(deltaTotalRad) || 1;
        const currentDeltaRad = body.theta - startThetaRad;
        const midDeltaRad = deltaTotalRad / 2;
        const crossed = (dirSign > 0)
          ? (currentDeltaRad >= midDeltaRad)
          : (currentDeltaRad <= midDeltaRad);
        const phaseSign = crossed ? -1 : 1;
        const tauCmd = phaseSign * dirSign * 1e9;

        const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tauCmd, idx);
        if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
        else send(cmdRcsDuty(null, idx));
        break;
      }

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
          console.log('[leoInsertionV2] payload released at apogee — alt=' +
            ((r_c - env.EARTH_RADIUS) / 1000).toFixed(1) + ' km');
          break;
        }

        if (dNext && dNext.massProps && _leoStateV2.coast2TargetThetaInertial !== null) {
          const I_next = dNext.massProps.I;
          const thetaErr = _hWrapPi(body.theta - _leoStateV2.coast2TargetThetaInertial);
          const tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                       + LEO_INSERTION_V2.CIRC_ATT_KD * body.omega);
          const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
          if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
          else send(cmdRcsDuty(null, idx));
        }
        break;
      }

      case 'DONE': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

        if (dNext && dNext.massProps && _leoStateV2.coast2TargetThetaInertial !== null) {
          const I_next = dNext.massProps.I;
          const thetaErr = _hWrapPi(body.theta - _leoStateV2.coast2TargetThetaInertial);
          const tau_desired = -I_next * (LEO_INSERTION_V2.CIRC_ATT_KP * thetaErr
                                       + LEO_INSERTION_V2.CIRC_ATT_KD * body.omega);
          const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
          if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
          else send(cmdRcsDuty(null, idx));
        }

        const dwellS = simT - _leoStateV2.phaseStart;
        if (dwellS >= LEO_INSERTION_V2.SUICIDE_DELAY_AFTER_DEPLOY_S) {
          send(cmdRcsDuty(null, idx));
          send(cmdMarkIntentionalImpact(idx));
          _leoStateV2.phase = 'SUICIDE_ROTATE';
          _leoStateV2.phaseStart = simT;
          console.log('[leoInsertionV2] DONE→SUICIDE_ROTATE after ' +
            dwellS.toFixed(1) + 's dwell (marked intentional impact)');
        }
        break;
      }

      case 'SUICIDE_ROTATE': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

        const elapsed = simT - _leoStateV2.phaseStart;
        if (elapsed >= LEO_INSERTION_V2.SUICIDE_ROTATE_TIMEOUT_S) {
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'SUICIDE_BURN';
          _leoStateV2.phaseStart = simT;
          _leoStateV2.suicideBurnStartT = simT;
          console.log('[leoInsertionV2] SUICIDE_ROTATE timeout — proceeding to burn');
          break;
        }

        const speed = Math.hypot(body.vx, body.vy);
        if (speed < 1) {
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'SUICIDE_BURN';
          _leoStateV2.phaseStart = simT;
          _leoStateV2.suicideBurnStartT = simT;
          break;
        }
        const ux_v = body.vx / speed;
        const uy_v = body.vy / speed;
        const targetThetaRad = Math.atan2(ux_v, -uy_v);

        const thetaErr = _hWrapPi(body.theta - targetThetaRad);
        const omegaRel = body.omega;
        if (Math.abs(thetaErr) < LEO_INSERTION_V2.SUICIDE_ROTATE_TOL_DEG * Math.PI / 180 &&
          Math.abs(omegaRel) < LEO_INSERTION_V2.SUICIDE_ROTATE_OMEGA_TOL) {
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'SUICIDE_BURN';
          _leoStateV2.phaseStart = simT;
          _leoStateV2.suicideBurnStartT = simT;
          console.log('[leoInsertionV2] SUICIDE_ROTATE done — θ=' +
            (body.theta * 180 / Math.PI).toFixed(2) + '° → SUICIDE_BURN');
          break;
        }

        const I_next = (dNext && dNext.massProps) ? dNext.massProps.I : 0;
        if (!(I_next > 0)) { send(cmdRcsDuty(null, idx)); break; }
        const tau_desired = -I_next *
          (LEO_INSERTION_V2.SUICIDE_ATT_KP * thetaErr
         + LEO_INSERTION_V2.SUICIDE_ATT_KD * omegaRel);

        const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, idx);
        if (result && result.fires.length) send(cmdRcsDuty(result.duties, idx));
        else send(cmdRcsDuty(null, idx));
        break;
      }

      case 'SUICIDE_BURN': {
        const burnS = simT - _leoStateV2.suicideBurnStartT;
        if (burnS >= LEO_INSERTION_V2.SUICIDE_BURN_MAX_S) {
          send(cmdSetAllThrottle(0));
          send(cmdSetGimbalRate(0));
          send(cmdRcsDuty(null, idx));
          _leoStateV2.phase = 'SUICIDE_COAST';
          _leoStateV2.phaseStart = simT;
          console.log('[leoInsertionV2] SUICIDE_BURN safety timeout after ' +
            burnS.toFixed(1) + 's');
          break;
        }

        const spoolS = body.engines[0].shutdownDurationS;
        let mdot_now_sb = 0, maxMFR_sb = 0;
        (body.engines || []).forEach(e => {
          mdot_now_sb += (e.massFlowRate || 0);
          if (Number.isFinite(e.maxMassFlowRate) && e.maxMassFlowRate > maxMFR_sb) {
            maxMFR_sb = e.maxMassFlowRate;
          }
        });
        const t_spool_sb = (maxMFR_sb > 0 && mdot_now_sb > 0)
          ? mdot_now_sb * spoolS / maxMFR_sb : spoolS;
        const dv_spool_sb = (mdot_now_sb / 2) * body.engines[0].Ve * t_spool_sb
                          / Math.max(1, dNext.massProps.M);

        const ux_nose = -Math.sin(body.theta);
        const uy_nose = Math.cos(body.theta);
        const impact = _suicidePredictImpact(
          body.rx, body.ry,
          body.vx + ux_nose * dv_spool_sb,
          body.vy + uy_nose * dv_spool_sb,
          simT);

        if (impact) {
          const lambdaMidEf = (env.LAUNCH_SITE_ANGLE_0 || 0) -
            (env.REMOTE_AREA_MID_WEST_DEG || 0) * Math.PI / 180;
          const lambdaCoarseEf = lambdaMidEf -
            LEO_INSERTION_V2.SUICIDE_BURN_COARSE_MARGIN_DEG * Math.PI / 180;
          const dLambda = impact.phiEf - lambdaCoarseEf;
          _leoStateV2.suicideImpactEf = impact.phiEf;
          _leoStateV2.suicideDlambda = dLambda;

          if (dLambda <= 0) {
            send(cmdSetAllThrottle(0));
            send(cmdSetGimbalRate(0));
            send(cmdRcsDuty(null, idx));
            _leoStateV2.phase = 'SUICIDE_COAST';
            _leoStateV2.phaseStart = simT;
            console.log('[leoInsertionV2] SUICIDE_BURN coarse cutoff — impact_ef=' +
              (impact.phiEf * 180 / Math.PI).toFixed(3) + '° coarse_ef=' +
              (lambdaCoarseEf * 180 / Math.PI).toFixed(3) + '° dLambda=' +
              (dLambda * 180 / Math.PI).toFixed(3) + '° → COAST');
            break;
          }
        }

        send(cmdSetAllThrottle(0.001));

        const gimbals = (body.engines || []).filter(e => e.gimbal);
        if (gimbals.length && dNext && dNext.massProps) {
          const speed = Math.hypot(body.vx, body.vy);
          if (speed > 1) {
            const ux_v = body.vx / speed;
            const uy_v = body.vy / speed;
            const targetThetaRad = Math.atan2(ux_v, -uy_v);
            const I_next = dNext.massProps.I;
            const thetaErr = _hWrapPi(body.theta - targetThetaRad);
            const tau_desired = -I_next * (LEO_INSERTION_V2.SUICIDE_ATT_KP * thetaErr
                                         + LEO_INSERTION_V2.SUICIDE_ATT_KD * body.omega);
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
            if (Math.abs(g_req_deg) > env.GIMBAL_MAX_DEG) {
              g_req_deg = Math.sign(g_req_deg) * env.GIMBAL_MAX_DEG;
            }
            const R_req = (g_req_deg - g_N) / dt;
            const R_cmd = Math.max(-env.GIMBAL_RATE_DEG_S,
                          Math.min(env.GIMBAL_RATE_DEG_S, R_req));
            send(cmdSetGimbalRate(R_cmd));
          }
        }
        break;
      }

      case 'SUICIDE_COAST': {
        send(cmdSetAllThrottle(0));
        send(cmdSetGimbalRate(0));

        if (_leoStateV2.suicideTrimDone) {
          send(cmdRcsDuty(null, idx));
          break;
        }

        if (_leoStateV2.suicideTrimStartT === 0) {
          _leoStateV2.suicideTrimStartT = simT;
        }

        if (simT - _leoStateV2.suicideTrimStartT > LEO_INSERTION_V2.SUICIDE_TRIM_MAX_S) {
          _leoStateV2.suicideTrimDone = true;
          send(cmdRcsDuty(null, idx));
          console.log('[leoInsertionV2] SUICIDE_TRIM forced off after ' +
            (simT - _leoStateV2.suicideTrimStartT).toFixed(1) + 's — trim timeout');
          break;
        }

        const speedH = Math.hypot(body.vx, body.vy);
        if (speedH > 1) {
          const ux_v = body.vx / speedH;
          const uy_v = body.vy / speedH;
          const targetThetaRad = Math.atan2(ux_v, -uy_v);
          const thetaErrH = _hWrapPi(body.theta - targetThetaRad);
          const I_nextH = (dNext && dNext.massProps) ? dNext.massProps.I : 0;
          if (I_nextH > 0) {
            const tau_hold = -I_nextH *
              (LEO_INSERTION_V2.SUICIDE_ATT_KP * thetaErrH +
                LEO_INSERTION_V2.SUICIDE_ATT_KD * body.omega);
            const rHold = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_hold, idx);
            if (rHold && rHold.fires.length) send(cmdRcsDuty(rHold.duties, idx));
          }
        }

        const impact = _suicidePredictImpact(body.rx, body.ry, body.vx, body.vy, simT);
        if (!impact) {
          const duties = GuideRCS.postSeparationAxialDuty(snapshot, idx, 'up');
          if (duties) send(cmdRcsDuty(duties, idx));
          break;
        }

        const lambdaMidEf = (env.LAUNCH_SITE_ANGLE_0 || 0) -
          (env.REMOTE_AREA_MID_WEST_DEG || 0) * Math.PI / 180;
        const dLambdaDeg = (impact.phiEf - lambdaMidEf) * 180 / Math.PI;

        if (Math.abs(dLambdaDeg) < LEO_INSERTION_V2.SUICIDE_TRIM_TOL_DEG) {
          _leoStateV2.suicideTrimDone = true;
          send(cmdRcsDuty(null, idx));
          console.log('[leoInsertionV2] SUICIDE_TRIM converged — impact_ef=' +
            (impact.phiEf * 180 / Math.PI).toFixed(3) + '° mid_ef=' +
            (lambdaMidEf * 180 / Math.PI).toFixed(3) + '° dLambda=' +
            dLambdaDeg.toFixed(3) + '° — all control off');
          break;
        }

        const direction = (dLambdaDeg > 0) ? 'up' : 'dn';
        const FAR = LEO_INSERTION_V2.SUICIDE_TRIM_FAR_DEG;
        const MIN_DUTY = LEO_INSERTION_V2.SUICIDE_TRIM_MIN_DUTY;
        let duty = Math.min(1, Math.abs(dLambdaDeg) / Math.max(FAR, 1e-6));
        if (duty < MIN_DUTY) duty = MIN_DUTY;

        const duties = GuideRCS.postSeparationAxialDuty(snapshot, idx, direction);
        if (duties) {
          Object.keys(duties).forEach(podId => {
            const d = duties[podId];
            if (!d) return;
            d.up *= duty;
            d.dn *= duty;
            d.lat *= duty;
          });
          send(cmdRcsDuty(duties, idx));
        }
        break;
      }

      default:
        break;
    }

    // ---------- Fairing open (independent, runs every tick) ----------
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
    _leoStateV2.lastApogeeKm = 0;
    _leoStateV2.lastApogeeSimT = 0;
    _leoStateV2.lastPerigeeKm = null;
    _leoStateV2.stageBurnLocked = false;
    _leoStateV2.stageBurnTargetTiltDeg = 0;
    _leoStateV2._prevApogeeErr = null;
    _leoStateV2.coastTargetThetaInertial = null;
    _leoStateV2.coastRotateStartTilt = null;
    _leoStateV2.coastRotateMid = null;
    _leoStateV2.coastTBurnPractical = 0;
    _leoStateV2.coastVOrbital = 0;
    _leoStateV2._prevVr = null;
    _leoStateV2.coastRotateSecondPass = false;
    _leoStateV2.coast2TargetThetaInertial = null;
    _leoStateV2.coast2RotateStartTilt = null;
    _leoStateV2.coast2RotateMid = null;
    _leoStateV2._prevVr2 = null;
    _leoStateV2.circCurrentV = 0;
    _leoStateV2.circTargetV = 0;
    _leoStateV2.circErr = 0;
    _leoStateV2.circAchieved = false;
    _leoStateV2.suicideBurnStartT = 0;
    _leoStateV2.suicideImpactEf = null;
    _leoStateV2.suicideDlambda = null;
    _leoStateV2.suicideTrimDone = false;
    _leoStateV2.suicideTrimStartT = 0;
    _leoStateV2.coastRotateEndDeltaV = null;
    _leoStateV2.coastRotateEndTRem = null;
    console.log('[leoInsertionV2] started');
  };

  _leoTickV2.stop = function () {
    send(cmdSetAllThrottle(0));
    send(cmdSetGimbalRate(0));
    send(cmdRcsDuty(null));
    if (typeof _hTick !== 'undefined' && typeof _hTick.stop === 'function') {
      try { _hTick.stop(); } catch (e) {}
    }
    _leoStateV2.missionBodyIdx = null;
    if (typeof Guidance !== 'undefined' && Guidance.setMissionBody) {
      Guidance.setMissionBody(null);
    }
    console.log('[leoInsertionV2] stopped');
  };

  _leoTickV2.getStatus = function() {
    const base = {
      ticks: _leoStateV2.ticks,
      phase: _leoStateV2.phase,
      altKm: _leoStateV2.lastAltKm,
      mecoTriggered: _leoStateV2.mecoTriggered,
      splitDetected: _leoStateV2.splitDetected,
      fairingOpened: _leoStateV2.fairingOpened,
      axialGap: _leoStateV2.lastAxialGap,
      apogeeKm: _leoStateV2.lastApogeeKm,
      perigeeKm: _leoStateV2.lastPerigeeKm,
      coastTBurnPractical: _leoStateV2.coastTBurnPractical,
      coastVOrbital: _leoStateV2.coastVOrbital,
      coastTargetThetaDeg: (_leoStateV2.coastTargetThetaInertial != null) ?
        _leoStateV2.coastTargetThetaInertial * 180 / Math.PI : null,
      coast2TargetThetaDeg: (_leoStateV2.coast2TargetThetaInertial != null) ?
        _leoStateV2.coast2TargetThetaInertial * 180 / Math.PI : null,
      circCurrentV: _leoStateV2.circCurrentV,
      circTargetV: _leoStateV2.circTargetV,
      circErr: _leoStateV2.circErr,
      circAchieved: _leoStateV2.circAchieved,
      stageBurnLocked: _leoStateV2.stageBurnLocked,
      stageBurnTargetTiltDeg: _leoStateV2.stageBurnTargetTiltDeg,
      coastDeltaV: _leoStateV2.coastRotateEndDeltaV,
      coastTRem: _leoStateV2.coastRotateEndTRem,
      suicideImpactEfDeg: (_leoStateV2.suicideImpactEf != null) ?
        _leoStateV2.suicideImpactEf * 180 / Math.PI : null,
      suicideDlambdaDeg: (_leoStateV2.suicideDlambda != null) ?
        _leoStateV2.suicideDlambda * 180 / Math.PI : null,
        suicideTrimDone: !!_leoStateV2.suicideTrimDone,

  // Debug — every input to the STAGE_BURN cutoff condition.
  apogeePredicted: _leoStateV2.lastApogeePredicted,
  dvSpool: _leoStateV2.lastDvSpool,
  massM: _leoStateV2.lastMassM,
  theta: _leoStateV2.lastTheta,
  gimbalDeg: _leoStateV2.lastGimbalDeg,
  mdotNow: _leoStateV2.lastMdotNow,
  maxMFR: _leoStateV2.lastMaxMFR,
  apogeeState: _leoStateV2.lastApogee,
  perigeeState: _leoStateV2.lastPerigee,

  // Initial values captured at guide start (t=0). Same in every row.
  initStackMass: _leoStateV2.initStackMass,
  initFuelMass: _leoStateV2.initFuelMass,
  initI: _leoStateV2.initI,
};
    if (_leoStateV2.phase === 'ASCENT' && typeof _hTick !== 'undefined' &&
      typeof _hTick.getStatus === 'function') {
      const hs = _hTick.getStatus();
      if (hs && Object.prototype.hasOwnProperty.call(hs, 'phase')) {
        hs.ascentPhase = hs.phase;
        delete hs.phase;
      }
      return Object.assign(base, hs);
    }
    return base;
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

  // ============================================================================
  // Guide config API — table + accessors.
  //
  // Only leoInsertionV2 has tunable constants now. The table shape is kept
  // identical so callers (guidance modal, presets page, tester, fast page)
  // don't need any change.
  // ============================================================================
  const _GUIDE_CONFIGS = {
    leoInsertionV2: {
      get: () => getLeoInsertionV2Config(),
      set: (vals) => setLeoInsertionV2(vals),
    },
  };

  function getGuideConfig(name) {
    const entry = _GUIDE_CONFIGS[name];
    if (!entry) return null;
    try {
      return JSON.parse(JSON.stringify(entry.get()));
    } catch (e) {
      console.error('[guidance] getGuideConfig clone failed for', name, e);
      return null;
    }
  }

  function applyGuideConfig(name, values) {
    const entry = _GUIDE_CONFIGS[name];
    if (!entry || !values) return false;
    try {
      entry.set(values);
      return true;
    } catch (e) {
      console.error('[guidance] applyGuideConfig failed for', name, e);
      return false;
    }
  }

  function hasGuideConfig(name) {
    return !!_GUIDE_CONFIGS[name];
  }

  function listGuidesWithConfig() {
    return Object.keys(_GUIDE_CONFIGS);
  }

  // ---- Mission body lock ----
  // When a guide is running, every command it sends must land on the
  // body the guide is flying, regardless of what body the human UI has
  // selected via Take Control.
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
  function cmdGridFinsDeploy(deployed) { return { type: 'gridFinsDeploy', deployed: !!deployed }; }
  function cmdGridFinsControl(controlDeg) { return { type: 'gridFinsControl', controlDeg }; }
  function cmdSeparate() { return { type: 'separate' }; }
  function cmdSplitFairing() { return { type: 'splitFairing' }; }
  function cmdReleasePayload() { return { type: 'releasePayload' }; }
  function cmdEmergencyEject() { return { type: 'emergencyEject' }; }
  function cmdTakeControl(idx) { return { type: 'takeControl', idx }; }
  function cmdWarp(value) { return { type: 'warp', value }; }
  function cmdSetFuelMass(value) { return { type: 'setFuelMass', value }; }
  function cmdSetGimbalRate(degPerSec, target) {
    const msg = { type: 'setGimbalRate', degPerSec };
    if (target) msg.target = target;
    return msg;
  }
  function cmdRcsDuty(duties, targetBodyIdx) {
    const msg = { type: 'rcsDuty', duties };
    if (Number.isInteger(targetBodyIdx)) msg.targetBodyIdx = targetBodyIdx;
    return msg;
  }
  function cmdMarkIntentionalImpact(targetBodyIdx) {
    const msg = { type: 'markIntentionalImpact' };
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
    getGuideStatusLabel,
    setLeoInsertionV2,
    setMissionBody,
    getLeoInsertionV2Config,
    // Guide config API
    getGuideConfig,
    applyGuideConfig,
    hasGuideConfig,
    listGuidesWithConfig,
    exportGuideState,
    importGuideState,
    // Convenience forwarders
    derive: (...args) => Derivation.derive(...args),
    deriveAllBodies: (...args) => Derivation.deriveAllBodies(...args),
    targetTorqueRcs: (...args) => GuideRCS.targetTorqueRcs(...args),
    // Command builders
    cmdSetGroupThrottle,
    cmdSetCenterThrottle,
    cmdSetAllThrottle,
    cmdRcs,
    cmdLegs,
    cmdGridFinsDeploy,
    cmdGridFinsControl,
    cmdSeparate,
    cmdSplitFairing,
    cmdReleasePayload,
    cmdEmergencyEject,
    cmdTakeControl,
    cmdWarp,
    cmdSetFuelMass,
    cmdSetGimbalRate,
    cmdRcsDuty,
    cmdMarkIntentionalImpact,
    // Debug getters
    get lastRawSnapshot() { return _lastRawSnapshot; },
    get lastMeasuredSnapshot() { return _lastMeasuredSnapshot; },
  };
})();