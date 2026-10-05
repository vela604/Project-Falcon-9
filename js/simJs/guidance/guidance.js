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
  let _physicsSend = null; // (msg) => void, wired by guidance.worker.js
  let _lastRawSnapshot = null; // most recent snapshot exactly as received
  let _lastMeasuredSnapshot = null; // post-IMU copy handed to tick()

  function init(physicsSendFn) {
    _physicsSend = physicsSendFn;
  }

  // Forwarding stubs for boot-time stack data. Actual storage and all
  // accessors live in derivation.js, which owns the raw records and the
  // formulas that consume them.
  function setStackData(data) {
    Derivation.setStackData(data);
  }
  function getStackData() {
    return Derivation.getStackData();
  }

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
      const st = typeof g.getStatus === "function" ? g.getStatus() : null;
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
  leoInsertionV3: [
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
  leoInsertionV3: {
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
    rawSeq.forEach((ph) => {
      const disp = ph in map ? map[ph] : ph;
      rawToDisp[ph] = disp;
      if (disp === null) return; // hidden
      if (!displaySeq.includes(disp)) displaySeq.push(disp);
    });
    const displayLog = {};
    rawSeq.forEach((ph) => {
      const disp = rawToDisp[ph];
      if (disp === null) return; // hidden
      const e = rawLog[ph];
      if (!e) return;
      const cur = displayLog[disp];
      if (!cur) {
        displayLog[disp] = { startT: e.startT, endT: e.endT };
      } else {
        if (
          Number.isFinite(e.startT) &&
          (!Number.isFinite(cur.startT) || e.startT < cur.startT)
        ) {
          cur.startT = e.startT;
        }
        if (e.endT === null || e.endT === undefined) {
          cur.endT = null;
        } else if (cur.endT !== null && cur.endT !== undefined) {
          if (e.endT > cur.endT) cur.endT = e.endT;
        }
      }
    });
    const curDisp = rawCurrentPhase ? rawToDisp[rawCurrentPhase] || null : null;
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
  function getGuideStatusLabel(name) {
    return GUIDE_STATUS_LABELS[name] || "";
  }

  function startGuide(name) {
    if (!name || !GUIDES[name]) {
      console.warn("[guidance] startGuide: unknown guide", name);
      return false;
    }
    if (_activeGuide === name) return true;
    if (_activeGuide && typeof GUIDES[_activeGuide].stop === "function") {
      try {
        GUIDES[_activeGuide].stop();
      } catch (e) {
        console.error(e);
      }
    }
    _activeGuide = name;
    _phaseLog = {};
    _lastSeenPhase = null;
    _guideStartT = null;
    if (typeof GUIDES[name].start === "function") {
      try {
        GUIDES[name].start();
      } catch (e) {
        console.error(e);
      }
    }
    console.log("[guidance] started:", name);
    return true;
  }

  function stopGuide() {
    if (!_activeGuide) return;
    const name = _activeGuide;
    if (typeof GUIDES[name].stop === "function") {
      try {
        GUIDES[name].stop();
      } catch (e) {
        console.error(e);
      }
    }
    _activeGuide = null;
    console.log("[guidance] stopped:", name);
  }

  function setActiveGuide(name) {
    _activeGuide = name && GUIDES[name] ? name : null;
  }
  function getActiveGuide() {
    return _activeGuide;
  }
  function listGuides() {
    return Object.keys(GUIDES);
  }

  function getGuideStatus() {
    if (!_activeGuide) return { active: null };
    const g = GUIDES[_activeGuide];
    const out = { active: _activeGuide };
    if (typeof g.getStatus === "function") Object.assign(out, g.getStatus());
    const rawSeq = GUIDE_PHASE_SEQUENCES[_activeGuide] || [];
    const transformed = _applyPhaseDisplay(
      _activeGuide,
      rawSeq,
      _phaseLog,
      out.phase,
    );
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
    // V2 state removed — _hState and _leoStateV2 no longer exist after
    // the leoInsertionV2 migration to guidance-experiments.js. Referencing
    // them here threw a ReferenceError on every export; try/catch swallowed
    // it, but the crash truncated the payload to just { activeGuide } —
    // so FF workers never received V3's mid-flight state and re-initialized
    // from scratch. That's why FF wobbled / drifted / showed wrong apogee.
    out.guideConfigs = {};
      Object.keys(_GUIDE_CONFIGS).forEach((name) => {
        out.guideConfigs[name] = getGuideConfig(name);
      });
      out.phaseLog = JSON.parse(JSON.stringify(_phaseLog || {}));
out.lastSeenPhase = _lastSeenPhase;
out.guideStartT = _guideStartT;
out.lastSimTime = _lastSimTime;

// V3 mission state + block states for FF mid-flight support.
out.v3State = {
  init: _v3State.init,
  ticks: _v3State.ticks,
  missionPhase: _v3State.missionPhase,
  missionPhaseStart: _v3State.missionPhaseStart,
  stageIdx: _v3State.stageIdx,
  boosterIdx: _v3State.boosterIdx,
  preSplitBodyCount: _v3State.preSplitBodyCount,
  mecoTriggered: _v3State.mecoTriggered,
  splitDetected: _v3State.splitDetected,
  fairingOpened: _v3State.fairingOpened,
  deployCmdSimTime: _v3State.deployCmdSimTime,
  insertionResult: _v3State.insertionResult,
  suicideResult: _v3State.suicideResult,
    lastAltKm: _v3State.lastAltKm,
    lastAxialGap: _v3State.lastAxialGap,
    lateralArmed: _v3State.lateralArmed,

};
if (_v3State.ascentBlock) out.v3AscentBlock = _v3State.ascentBlock.getState();
if (_v3State.insertionBlock) out.v3InsertionBlock = _v3State.insertionBlock.getState();
if (_v3State.suicideBlock) out.v3SuicideBlock = _v3State.suicideBlock.getState();
    } catch (e) {
      console.warn("[guidance] exportGuideState failed", e);
    }
    return out;
  }

function importGuideState(data) {
  if (!data) return;
  try {
    // V2 state restore removed — _hState / _leoStateV2 no longer exist.
    // (Guarded on `data.hState` before, so this never crashed, but the
    // line was dead weight and confusing.)
    if (data.activeGuide !== undefined) _activeGuide = data.activeGuide;
      if (data.guideConfigs && typeof data.guideConfigs === "object") {
        Object.keys(data.guideConfigs).forEach((name) => {
          const v = data.guideConfigs[name];
          if (v && typeof v === "object") {
            try {
              applyGuideConfig(name, v);
            } catch (e) {
              console.warn(
                "[guidance] importGuideState config restore failed for",
                name,
                e,
              );
            }
          }
        });
      }
      if (data.phaseLog && typeof data.phaseLog === "object") {
        _phaseLog = JSON.parse(JSON.stringify(data.phaseLog));
      }
      if (data.lastSeenPhase !== undefined) _lastSeenPhase = data.lastSeenPhase;
      if (data.guideStartT !== undefined) _guideStartT = data.guideStartT;
      if (data.lastSimTime !== undefined) _lastSimTime = data.lastSimTime;

// V3 restore
if (data.v3State) {
  Object.keys(data.v3State).forEach(k => { _v3State[k] = data.v3State[k]; });
}
if (data.v3AscentBlock) {
  if (!_v3State.ascentBlock) {
    _v3State.ascentBlock = FUNDAMENTAL_BLOCKS.ascent.createInstance();
  }
  _v3State.ascentBlock.setState(data.v3AscentBlock);
}
if (data.v3InsertionBlock) {
  if (!_v3State.insertionBlock) {
    _v3State.insertionBlock = FUNDAMENTAL_BLOCKS.insertion.createInstance();
  }
  _v3State.insertionBlock.setState(data.v3InsertionBlock);
}
if (data.v3SuicideBlock) {
  if (!_v3State.suicideBlock) {
    _v3State.suicideBlock = FUNDAMENTAL_BLOCKS.suicide.createInstance();
  }
  _v3State.suicideBlock.setState(data.v3SuicideBlock);
}
    } catch (e) {
      console.warn("[guidance] importGuideState failed", e);
    }
  }

  function tick(snapshot) {
    if (_activeGuide && GUIDES[_activeGuide]) {
      GUIDES[_activeGuide](snapshot);
    }
  }

  

  



// ============================================================================
// leoInsertionV3 — composed mission guide using FUNDAMENTAL_BLOCKS.
//
// Mission-level glue:
//   - ascent block (pad → MECO)
//   - split detection (body count delta)
//   - SEPARATED_AXIAL gap monitor (mission-level)
//   - fairing auto-open (phase-independent, 80 km)
//   - insertion block (stage burn → payload deployed)
//   - DONE dwell (from deploy cmd tick — CORRECT; V2 counts from COAST_HOLD_2)
//   - suicide block (retrograde align → burn → RCS trim → engines off)
// ============================================================================

const _v3State = {
  init: false,
  ticks: 0,
  missionPhase: 'ASCENT',   // ASCENT | WAIT_SPLIT | SEPARATED_AXIAL | INSERTION | DONE_DWELL | SUICIDE | END
  missionPhaseStart: 0,

  stageIdx: -1,
  boosterIdx: -1,
  preSplitBodyCount: 0,

  ascentBlock: null,
  insertionBlock: null,
  suicideBlock: null,

  mecoTriggered: false,
  splitDetected: false,
  fairingOpened: false,
  deployCmdSimTime: null,

  insertionResult: null,
  suicideResult: null,
  // One-shot flag — payload-open command fires exactly once per mission,
  // at deployCmdSimTime + PAYLOAD_DEPLOY_OPEN_DELAY_S.
  payloadOpenFired: false,
  
  lastAltKm: 0,
    lastAxialGap: 0,
    lateralArmed: false,
    // One-shot flag — pusher torque fires at most once per mission, only
    // after the axial gap exceeds the stage bell height + margin.
    pusherTorqueFired: false,
  };

const _v3Config = {
  ascent: null,
  separation: {
  // SEPARATED_AXIAL duration (s). Counted from the phase's entry (split
  // detected), not from the axial gap. Replaces the old AXIAL_SEP_TARGET_M
  // meter-based condition — the phase now always runs for exactly this
  // many seconds, then hands off to INSERTION.
  SEPARATION_DURATION_S: 3,
  SPLIT_TIMEOUT_S: 15,
  LATERAL_TRIGGER_MARGIN_M: 0.3,
  BOOSTER_SEP_ANG_ACCEL_DEG_S2: -1,
  BOOSTER_SEP_TARGET_OMEGA_DEG_S: 10,
},
  insertion: null,
  fairing: { HAS_FAIRING: true, FAIRING_OPEN_ALT_KM: 80, FAIRING_OPEN_ENABLED: true },
  done: {
  SUICIDE_DELAY_AFTER_DEPLOY_S: 1800,
  CIRC_ATT_KP: 0.5,
  CIRC_ATT_KD: 4.0,
  DEORBIT_ENABLED: true,
  // Delay (s) between the payload deploy command and firing the
  // payload-open command (satellite unfolds its panels / dish).
  PAYLOAD_DEPLOY_OPEN_DELAY_S: 5,
},
suicide: null,
};

(function _v3InitDefaults() {
  const F = (typeof FUNDAMENTAL_BLOCKS !== 'undefined') ? FUNDAMENTAL_BLOCKS : null;
  if (F && F.ascent) _v3Config.ascent = JSON.parse(JSON.stringify(F.ascent.defaultConstants));
  if (F && F.insertion) _v3Config.insertion = JSON.parse(JSON.stringify(F.insertion.defaultConstants));
  if (F && F.suicide) _v3Config.suicide = JSON.parse(JSON.stringify(F.suicide.defaultConstants));
})();

function _v3CurrentPhase() {
  const mp = _v3State.missionPhase;
  if (mp === 'ASCENT') return 'ASCENT';
  if (mp === 'WAIT_SPLIT') return 'MECO_SPOOL';
  if (mp === 'SEPARATED_AXIAL') return 'SEPARATED_AXIAL';
  if (mp === 'INSERTION') {
    if (_v3State.insertionBlock) return _v3State.insertionBlock.getStatus().phase;
    return '?';
  }
  if (mp === 'DONE_DWELL') return 'DONE';
  if (mp === 'SUICIDE') {
    if (_v3State.suicideBlock) return _v3State.suicideBlock.getStatus().phase;
    return '?';
  }
  return '?';
}

// Computes the stage's engine bell height (meters) from the stage record.
// Mirrors fleet.js's engineBellHeightForRecord but runs in the guidance
// worker, where fleet.js isn't loaded. Reaches the same type registry
// through Derivation.getTypeById, which came in with the boot stackData.
// Returns 0 on any lookup failure — callers treat 0 as "unknown, skip".
function _stageBellHeightForBody(stageBody) {
  if (!stageBody || !stageBody.members || !stageBody.members.length) return 0;
  const member = stageBody.members[0];
  if (!member || !member.engineTypeId || !member.engineThrusters) return 0;
  const g = member.engineThrusters.gimbal || member.engineThrusters.fixed;
  if (!g || !Number.isFinite(g.massFlowRate)) return 0;
  const t = Derivation.getTypeById(g.thrusterTypeId);
  if (!t || !Array.isArray(t.parameterSchema)) return 0;
  const ent = t.parameterSchema.find(p => p.key === 'massFlowToBellHeight');
  if (!ent || !Number.isFinite(ent.value)) return 0;
  return ent.value * g.massFlowRate;
}

// Physical height of the top of a discarded body's stack, measured from
// the body's own position (which is the bottom member's HULL BASE — the
// base member's engine bell hangs BELOW this reference, into the flame
// trench, and is NOT part of the top-side height). Sum of member hull
// heights only.
function _discardedStackTop_m(body) {
  if (!body || !Array.isArray(body.members) || !body.members.length) return 0;
  let h = 0;
  body.members.forEach(m => {
    if (Number.isFinite(m.height)) h += m.height;
  });
  return h;
}

function _leoTickV3(snapshot) {
  _v3State.ticks++;
  if (!snapshot || !Array.isArray(snapshot.bodies) || !snapshot.bodies.length) return;
  const simT = snapshot.simTime;

  if (!_v3State.init) {
    _v3State.init = true;
    _v3State.missionPhase = 'ASCENT';
    _v3State.missionPhaseStart = simT;
    _v3State.preSplitBodyCount = snapshot.bodies.length;
    _v3State.stageIdx = 0;
    _v3State.boosterIdx = -1;

    _v3State.ascentBlock = FUNDAMENTAL_BLOCKS.ascent.createInstance();
    _v3State.ascentBlock.start(_v3Config.ascent, 0, {});
  }

  // ---- Mission-level fairing auto-open (phase-independent) ----
  if (!_v3State.fairingOpened &&
      _v3State.splitDetected &&
      _v3Config.fairing.HAS_FAIRING &&
      _v3Config.fairing.FAIRING_OPEN_ENABLED &&
      _v3State.stageIdx >= 0) {
    const stageBody = snapshot.bodies[_v3State.stageIdx];
    if (stageBody) {
      const env = Derivation.getEnv();
      const altKm = (Math.hypot(stageBody.rx, stageBody.ry) - env.EARTH_RADIUS) / 1000;
      _v3State.lastAltKm = altKm;
      if (altKm >= _v3Config.fairing.FAIRING_OPEN_ALT_KM) {
        const hasFairing = stageBody.members &&
          stageBody.members.some(m => m && m.stageRole === 'payloadSpace');
        if (hasFairing) {
          const cmd = cmdSplitFairing();
          cmd.targetBodyIdx = _v3State.stageIdx;
          send(cmd);
          _v3State.fairingOpened = true;
          console.log('[leoInsertionV3] fairing open at t=' + simT.toFixed(2) +
            ' alt=' + altKm.toFixed(2) + ' km');
        }
      }
    }
  }

  switch (_v3State.missionPhase) {

    case 'ASCENT': {
      _v3State.ascentBlock.tick(snapshot);
      if (_v3State.ascentBlock.isDone()) {
        _v3State.mecoTriggered = true;
        _v3State.missionPhase = 'WAIT_SPLIT';
        _v3State.missionPhaseStart = simT;
        _v3State.preSplitBodyCount = snapshot.bodies.length;
      }
      break;
    }

    case 'WAIT_SPLIT': {
  if (snapshot.bodies.length > _v3State.preSplitBodyCount) {
  _v3State.splitDetected = true;
  _v3State.stageIdx = 0;
  const boosterIdx = snapshot.bodies.findIndex((b, i) =>
    i !== _v3State.stageIdx && b && !b.isActive);
  _v3State.boosterIdx = boosterIdx >= 0 ? boosterIdx : 1;
  _v3State.pusherTorqueFired = false;
  // Pusher torque is NOT fired here — it waits in SEPARATED_AXIAL
  // until the axial gap clears the stage's engine bell (see the
  // arming check in that case). Firing at split-time would rotate
  // the booster while its interstage still overlaps the MVac bell.
  _v3State.missionPhase = 'SEPARATED_AXIAL';
  _v3State.missionPhaseStart = simT;
  break;
}
  if (simT - _v3State.missionPhaseStart > _v3Config.separation.SPLIT_TIMEOUT_S) {
    console.warn('[leoInsertionV3] split timeout');
    _v3State.missionPhase = 'END';
  }
  break;
}

    case 'SEPARATED_AXIAL': {
  const bIdx = _v3State.boosterIdx;
  const sIdx = _v3State.stageIdx;
  if (bIdx < 0 || sIdx < 0) { _v3State.missionPhase = 'END'; break; }
  const boosterBody = snapshot.bodies[bIdx];
  const stageBody = snapshot.bodies[sIdx];
  if (!boosterBody || !stageBody) { _v3State.missionPhase = 'END'; break; }

  // ---- True axial gap: stage hull base to top of discarded stack.
  const discardedTop_m = _discardedStackTop_m(boosterBody);
  const upX = -Math.sin(stageBody.theta);
  const upY = Math.cos(stageBody.theta);
  const dx = stageBody.rx - boosterBody.rx;
  const dy = stageBody.ry - boosterBody.ry;
  const axialGap = Math.max(0, (dx * upX + dy * upY) - discardedTop_m);
  _v3State.lastAxialGap = axialGap;

  // ---- Bell-clearance arming check.
// Booster's pusher torque fires once the stage's engine bell has
// cleared the booster's top/interstage (bell height + margin), and
// the lateral RCS kick arms at the same moment. Bell height is
// derived per tick from the stage record's engine config, so a
// different stage engine produces a different trigger point
// automatically.
const stageBellH = _stageBellHeightForBody(stageBody);
const lateralMargin = Number.isFinite(_v3Config.separation.LATERAL_TRIGGER_MARGIN_M) ?
  _v3Config.separation.LATERAL_TRIGGER_MARGIN_M : 0;
const bellCleared = (stageBellH > 0) && (axialGap >= stageBellH + lateralMargin);
const lateralArmed = bellCleared;
_v3State.lateralArmed = lateralArmed;

// ---- Pusher torque — one-shot, gated on bell clearance.
// Physically: pneumatic pushers can't rotate the booster while
// its interstage still overlaps the MVac bell; a rotation at that
// moment would drive the interstage into the nozzle.
if (bellCleared && !_v3State.pusherTorqueFired) {
  const alphaDeg = _v3Config.separation.BOOSTER_SEP_ANG_ACCEL_DEG_S2;
  const omegaDeg = _v3Config.separation.BOOSTER_SEP_TARGET_OMEGA_DEG_S;
  if (Number.isFinite(alphaDeg) && alphaDeg !== 0 &&
    Number.isFinite(omegaDeg) && omegaDeg > 0) {
    send(cmdPusherTorque(
      alphaDeg * Math.PI / 180,
      omegaDeg * Math.PI / 180,
      bIdx
    ));
    _v3State.pusherTorqueFired = true;
  }
}

  // ---- Booster duty assembly ----
  // Baseline: axial 'dn' on every pod (pushes booster tailward).
  //
  // Once lateral is armed, the left pods get a NEGATIVE-torque kick:
  //   • Left pods: flip vertical to 'up' (Fy = +F) + keep lateral 'lat'
  //   • Right pods: leave axial 'dn' as-is (Fy = −F)
  //
  // τ = rx · Fy. Left pods have rx < 0, so Fy > 0 → τ_L < 0.
  // Right pods have rx > 0, so Fy < 0 → τ_R < 0.
  // Both sides push the same way → net τ = −2·F·xOffset.
  //
  // Net vertical force = (+F on L) + (−F on R) = 0, so no vertical
  // drift is introduced. Net lateral = +F on L only (booster drifts
  // left of the stack, matching the intended lateral-kick behaviour).
  //
  // 'up' REPLACES the L pods' axial 'dn' rather than adding to it —
  // firing both up and dn on the same pod would cancel to zero and
  // waste propellant.
  const boosterAxial = GuideRCS.postSeparationAxialDuty(snapshot, bIdx, 'dn');
  let boosterMerged = boosterAxial ? Object.assign({}, boosterAxial) : {};

  if (lateralArmed) {
    const boosterPods = boosterBody.pods || [];
    const latDuties = GuideRCS.postSeparationLateralDuty(snapshot, bIdx, 'L');
    boosterPods.forEach(p => {
      const pid = p.podId;
      if (p.side === 'L') {
        boosterMerged[pid] = {
          up: 1,
          dn: 0,
          lat: (latDuties && latDuties[pid]) ? latDuties[pid].lat : 1,
        };
      }
      // Right pods: keep axial 'dn' from boosterMerged, no change.
    });
  }
  if (boosterMerged) { const c = cmdRcsDuty(boosterMerged, bIdx); send(c); }

  // ---- Stage: axial 'up' duty only. No lateral on the stage.
  // ---- Stage: axial 'up' duty only. No lateral on the stage.
const stageDuties = GuideRCS.postSeparationAxialDuty(snapshot, sIdx, 'up');
if (stageDuties) { const c = cmdRcsDuty(stageDuties, sIdx); send(c); }

// Timeout-based handoff to INSERTION — fixed duration from the
// phase's entry, independent of how far the axial gap has opened.
const elapsedSep = simT - _v3State.missionPhaseStart;
if (elapsedSep >= _v3Config.separation.SEPARATION_DURATION_S) {
  send(cmdRcsDuty(null, sIdx));
  send(cmdRcsDuty(null, bIdx));
  _v3State.lateralArmed = false;
  _v3State.insertionBlock = FUNDAMENTAL_BLOCKS.insertion.createInstance();
  _v3State.insertionBlock.start(_v3Config.insertion, sIdx, {});
  _v3State.missionPhase = 'INSERTION';
  _v3State.missionPhaseStart = simT;
}
break;
}

    case 'INSERTION': {
      _v3State.insertionBlock.tick(snapshot);
      if (_v3State.insertionBlock.isDone()) {
        _v3State.insertionResult = _v3State.insertionBlock.getResult();
        _v3State.deployCmdSimTime = _v3State.insertionResult
          ? _v3State.insertionResult.deployCommandSimTime : simT;
        _v3State.missionPhase = 'DONE_DWELL';
        _v3State.missionPhaseStart = simT;
      }
      break;
    }

    case 'DONE_DWELL': {
      const stageBody = snapshot.bodies[_v3State.stageIdx];
      if (stageBody && _v3State.insertionResult &&
          _v3State.insertionResult.coast2TargetThetaInertial != null) {
        const dNext = Derivation.derive(snapshot, _v3State.stageIdx);
        const I_next = (dNext && dNext.massProps) ? dNext.massProps.I : 0;
        if (I_next > 0) {
          let thetaErr = stageBody.theta - _v3State.insertionResult.coast2TargetThetaInertial;
          while (thetaErr > Math.PI) thetaErr -= 2 * Math.PI;
          while (thetaErr < -Math.PI) thetaErr += 2 * Math.PI;
          const tau_desired = -I_next *
            (_v3Config.done.CIRC_ATT_KP * thetaErr +
             _v3Config.done.CIRC_ATT_KD * stageBody.omega);
          const result = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau_desired, _v3State.stageIdx);
          if (result && result.fires.length) send(cmdRcsDuty(result.duties, _v3State.stageIdx));
          else send(cmdRcsDuty(null, _v3State.stageIdx));
        }
      }

      send(cmdSetAllThrottle(0));
send(cmdSetGimbalRate(0));

// ---- Payload-open command ----
// After deploy, wait PAYLOAD_DEPLOY_OPEN_DELAY_S seconds, then send
// a one-shot open command to the deployed payload body. Finding the
// body by scanning for the payloadBody marker — its index can shift
// as other bodies spawn.
if (!_v3State.payloadOpenFired &&
  Number.isFinite(_v3State.deployCmdSimTime) &&
  simT >= _v3State.deployCmdSimTime + _v3Config.done.PAYLOAD_DEPLOY_OPEN_DELAY_S) {
  let _payIdx = -1;
  for (let _i = 0; _i < snapshot.bodies.length; _i++) {
    const _b = snapshot.bodies[_i];
    if (_b && _b.payloadBody && !_b.payloadOpened) { _payIdx = _i; break; }
  }
  if (_payIdx >= 0) {
    send(cmdOpenPayload(_payIdx));
    _v3State.payloadOpenFired = true;
  }
}

// Dwell measured from the DEPLOY COMMAND tick — the correct

      // Dwell measured from the DEPLOY COMMAND tick — the correct
      // behaviour. V2 measured from COAST_HOLD_2 entry due to a missing
      // phaseStart update, giving ~59.29s of actual dwell instead of 60s.
      const deployT = _v3State.deployCmdSimTime != null
        ? _v3State.deployCmdSimTime : _v3State.missionPhaseStart;
      const dwellS = simT - deployT;

      if (dwellS >= _v3Config.done.SUICIDE_DELAY_AFTER_DEPLOY_S) {
        send(cmdRcsDuty(null, _v3State.stageIdx));

        if (_v3Config.done.DEORBIT_ENABLED) {
          send(cmdMarkIntentionalImpact(_v3State.stageIdx));
          const env = Derivation.getEnv();
          _v3State.suicideBlock = FUNDAMENTAL_BLOCKS.suicide.createInstance();
          _v3State.suicideBlock.start(_v3Config.suicide, _v3State.stageIdx, {
            restingArea: {
              midWestDeg: env.REMOTE_AREA_MID_WEST_DEG,
              westStartDeg: env.REMOTE_AREA_WEST_START_DEG,
              westEndDeg: env.REMOTE_AREA_WEST_END_DEG,
            },
          });
          _v3State.missionPhase = 'SUICIDE';
          _v3State.missionPhaseStart = simT;
          console.log('[leoInsertionV3] DONE_DWELL → SUICIDE at t=' + simT.toFixed(2));
        } else {
          _v3State.missionPhase = 'END';
          _v3State.missionPhaseStart = simT;
        }
      }
      break;
    }

    case 'SUICIDE': {
      _v3State.suicideBlock.tick(snapshot);
      if (_v3State.suicideBlock.isDone()) {
        _v3State.suicideResult = _v3State.suicideBlock.getResult();
        _v3State.missionPhase = 'END';
        _v3State.missionPhaseStart = simT;
        console.log('[leoInsertionV3] SUICIDE done at t=' + simT.toFixed(2));
      }
      break;
    }

    case 'END': {
      send(cmdSetAllThrottle(0));
      send(cmdSetGimbalRate(0));
      break;
    }

    default: break;
  }
}

_leoTickV3.start = function () {
  _v3State.init = false;
  _v3State.ticks = 0;
  _v3State.missionPhase = 'ASCENT';
  _v3State.missionPhaseStart = 0;
  _v3State.stageIdx = -1;
  _v3State.boosterIdx = -1;
  _v3State.preSplitBodyCount = 0;
  _v3State.ascentBlock = null;
  _v3State.insertionBlock = null;
  _v3State.suicideBlock = null;
  _v3State.mecoTriggered = false;
  _v3State.splitDetected = false;
  _v3State.fairingOpened = false;
  _v3State.deployCmdSimTime = null;
  _v3State.insertionResult = null;
_v3State.suicideResult = null;
_v3State.payloadOpenFired = false;
_v3State.lastAltKm = 0;
_v3State.lastAxialGap = 0;
_v3State.lateralArmed = false;
_v3State.pusherTorqueFired = false;
console.log('[leoInsertionV3] started');
};

_leoTickV3.stop = function () {
  if (_v3State.ascentBlock) { try { _v3State.ascentBlock.stop(); } catch (e) {} }
  if (_v3State.insertionBlock) { try { _v3State.insertionBlock.stop(); } catch (e) {} }
  if (_v3State.suicideBlock) { try { _v3State.suicideBlock.stop(); } catch (e) {} }
  _v3State.ascentBlock = null;
  _v3State.insertionBlock = null;
  _v3State.suicideBlock = null;
  console.log('[leoInsertionV3] stopped');
};

_leoTickV3.getStatus = function () {
  const out = {
    ticks: _v3State.ticks,
    phase: _v3CurrentPhase(),
    mecoTriggered: _v3State.mecoTriggered,
    splitDetected: _v3State.splitDetected,
    fairingOpened: _v3State.fairingOpened,
    axialGap: _v3State.lastAxialGap,
    altKm: _v3State.lastAltKm,
  };

  if ((_v3State.missionPhase === 'ASCENT') && _v3State.ascentBlock) {
    const as = _v3State.ascentBlock.getStatus();
    Object.assign(out, {
      ascentPhase: as.ascentPhase,
      ascentTicks: as.ticks,
      elapsed: as.elapsed,
      lockedDeltaDeg: as.lockedDeltaDeg,
      aoaDeg: as.aoaDeg,
      aoaNextDeg: as.aoaNextDeg,
      omegaAoANow: as.omegaAoANow,
      omegaAoANext: as.omegaAoANext,
      alphaAoANow: as.alphaAoANow,
      alphaAoANext: as.alphaAoANext,
      dQ: as.dQ,
      tauDQ: as.tauDQ,
      tauDesired: as.tauDesired,
      tauDrag: as.tauDrag,
      tauTarget: as.tauTarget,
      gRate: as.gRate,
      gRadN: as.gRadN,
      gReqDeg: as.gReqDeg,
    });
  }

  // Deorbit schedule — exposed always (null until deploy happens), so the
// phase-checkpoint UI can render a pending countdown on the DEORBIT
// row during the SUICIDE_DELAY_AFTER_DEPLOY_S dwell window.
out.suicideDelayS = _v3Config.done.SUICIDE_DELAY_AFTER_DEPLOY_S;
out.suicidePendingStartS =
  (Number.isFinite(_v3State.deployCmdSimTime) &&
    Number.isFinite(_v3Config.done.SUICIDE_DELAY_AFTER_DEPLOY_S)) ?
  (_v3State.deployCmdSimTime + _v3Config.done.SUICIDE_DELAY_AFTER_DEPLOY_S) :
  null;

if (_v3State.insertionBlock) {
  const ins = _v3State.insertionBlock.getStatus();
  Object.assign(out, {
        stageBurnLocked: ins.stageBurnLocked,
        stageBurnTargetTiltDeg: ins.stageBurnTargetTiltDeg,
        circTriggerLeadS: ins.circTriggerLeadS,
        apogeeKm: ins.apogeeKm,
        perigeeKm: ins.perigeeKm,
      coastTBurnPractical: ins.coastTBurnPractical,
      coastVOrbital: ins.coastVOrbital,
      coastTargetThetaDeg: ins.coastTargetThetaDeg,
      coast2TargetThetaDeg: ins.coast2TargetThetaDeg,
      circCurrentV: ins.circCurrentV,
      circTargetV: ins.circTargetV,
      circErr: ins.circErr,
      circAchieved: ins.circAchieved,
      coastDeltaV: ins.coastDeltaV,
      coastTRem: ins.coastTRem,
      deployCommandSimTime: ins.deployCommandSimTime,
      payloadCleared: ins.payloadCleared,
    });
  }

  if (_v3State.suicideBlock) {
    const su = _v3State.suicideBlock.getStatus();
    Object.assign(out, {
      suicidePhase: su.phase,
      suicideImpactEfDeg: su.suicideImpactEfDeg,
      suicideDlambdaDeg: su.suicideDlambdaDeg,
      suicideTrimDone: su.suicideTrimDone,
    });
  }

  return out;
};

GUIDES.leoInsertionV3 = _leoTickV3;


 

  function setLeoInsertionV3(patch) {
  if (!patch) return;
  Object.keys(patch).forEach(k => {
    if (!(k in _v3Config)) return;
    const cur = _v3Config[k];
    const nxt = patch[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) &&
        nxt && typeof nxt === 'object' && !Array.isArray(nxt)) {
      Object.assign(cur, nxt);
    } else {
      _v3Config[k] = nxt;
    }
  });
  console.log('[leoInsertionV3] constants updated');
}
function getLeoInsertionV3Config() { return JSON.parse(JSON.stringify(_v3Config)); }
  // ============================================================================
  // Guide config API — table + accessors.
  //
  // Only leoInsertionV2 has tunable constants now. The table shape is kept
  // identical so callers (guidance modal, presets page, tester, fast page)
  // don't need any change.
  // ============================================================================
  const _GUIDE_CONFIGS = {
  leoInsertionV3: {
    get: () => getLeoInsertionV3Config(),
    set: (vals) => setLeoInsertionV3(vals),
  },
};

  function getGuideConfig(name) {
    const entry = _GUIDE_CONFIGS[name];
    if (!entry) return null;
    try {
      return JSON.parse(JSON.stringify(entry.get()));
    } catch (e) {
      console.error("[guidance] getGuideConfig clone failed for", name, e);
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
      console.error("[guidance] applyGuideConfig failed for", name, e);
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
  // Stage 2 test hook — allows external code (headless/test-ascent-block.js)
  // to register a temporary guide for verification. Not called by any
  // production code path; safe to leave in place.
  function _registerTestGuide(name, guideObj) {
    if (!name || typeof guideObj !== "function") return false;
    GUIDES[name] = guideObj;
    return true;
  }
  // ---- Outbound: single choke point for physics commands. ----
  function send(msg) {
    if (!_physicsSend) {
      console.warn(
        "[guidance] send() called before physics port connected:",
        msg,
      );
      return;
    }
    if (_missionBodyIdx !== null && msg.targetBodyIdx === undefined) {
      msg.targetBodyIdx = _missionBodyIdx;
    }
    _physicsSend(msg);
  }

  // ---- Command builders. Shape-only; clamping is physics's job. ----
  function cmdSetGroupThrottle(angles, kgPerSec) {
    return { type: "setGroupThrottle", angles, value: kgPerSec };
  }
  function cmdSetCenterThrottle(kgPerSec) {
    return { type: "setCenterThrottle", value: kgPerSec };
  }
  function cmdSetAllThrottle(kgPerSec) {
    return { type: "setAllThrottle", value: kgPerSec };
  }
  function cmdRcs(key, on) {
    return { type: "rcs", key, on: !!on };
  }
  function cmdLegs(deployed) {
    return { type: "legs", deployed: !!deployed };
  }
  function cmdGridFinsDeploy(deployed) {
    return { type: "gridFinsDeploy", deployed: !!deployed };
  }
  function cmdGridFinsControl(controlDeg) {
    return { type: "gridFinsControl", controlDeg };
  }
  function cmdSeparate() {
    return { type: "separate" };
  }
  function cmdSplitFairing() {
    return { type: "splitFairing" };
  }
  function cmdReleasePayload() {
    return { type: "releasePayload" };
  }
  function cmdEmergencyEject() {
    return { type: "emergencyEject" };
  }
  function cmdTakeControl(idx) {
    return { type: "takeControl", idx };
  }
  function cmdWarp(value) {
    return { type: "warp", value };
  }
  function cmdSetFuelMass(value) {
    return { type: "setFuelMass", value };
  }
  function cmdSetGimbalRate(degPerSec, target) {
    const msg = { type: "setGimbalRate", degPerSec };
    if (target) msg.target = target;
    return msg;
  }
  function cmdRcsDuty(duties, targetBodyIdx) {
    const msg = { type: "rcsDuty", duties };
    if (Number.isInteger(targetBodyIdx)) msg.targetBodyIdx = targetBodyIdx;
    return msg;
  }
  function cmdMarkIntentionalImpact(targetBodyIdx) {
  const msg = { type: "markIntentionalImpact" };
  if (Number.isInteger(targetBodyIdx)) msg.targetBodyIdx = targetBodyIdx;
  return msg;
}
function cmdPusherTorque(angAccelRadPerS2, targetOmegaRadPerS, targetBodyIdx) {
  const msg = { type: "pusherTorque", angAccel: angAccelRadPerS2, targetOmega: targetOmegaRadPerS };
  if (Number.isInteger(targetBodyIdx)) msg.targetBodyIdx = targetBodyIdx;
  return msg;
}
function cmdOpenPayload(targetBodyIdx) {
  const msg = { type: "openPayload" };
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
    setLeoInsertionV3,
setMissionBody,
getLeoInsertionV3Config,
// Stage 2 test hook — see _registerTestGuide below.
_registerTestGuide,
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
cmdPusherTorque,
    // Debug getters
    get lastRawSnapshot() {
      return _lastRawSnapshot;
    },
    get lastMeasuredSnapshot() {
      return _lastMeasuredSnapshot;
    },
  };
})();
