// ============================================================================
// guidance.js — Production guidance orchestrator.
//
// SCOPE: this file ships EXACTLY ONE user-facing guide — leoInsertionV3 —
// plus the internal ascent sub-machine (_hTick / ASCENT_HOLD) that
// leoInsertionV3's ASCENT phase delegates to. Every other guide that has
// ever existed (testGuide, predictiveTorque, predictivePlus, the AoA-push
// family, ascentRR, ascentAoaHold-as-public-guide, leoInsertion v1,
// gimbalPredictive2, predictVerifier) has been moved verbatim to
// guidance-experiments.js. That file is NOT loaded by any worker — it's
// kept as an archive for the guidance_log.html history and for future
// reference if we ever want to bring an experiment back.
//
// Everything here is scoped so that leoInsertionV3 is UNAFFECTED by the
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
  landbackV1: [
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
  landbackV1: {
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

  // Status labels — empty now that only leoInsertionV3 remains (which is
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
  payloadCleared: _v3State.payloadCleared,
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
    // One-shot mission flags — must survive export/import so a checkpoint
    // restore does not leave them "already fired" from a previous run.
    pusherTorqueFired: _v3State.pusherTorqueFired,
    payloadOpenFired: _v3State.payloadOpenFired,

};
if (_v3State.ascentBlock) out.v3AscentBlock = _v3State.ascentBlock.getState();
if (_v3State.insertionBlock) out.v3InsertionBlock = _v3State.insertionBlock.getState();
if (_v3State.suicideBlock) out.v3SuicideBlock = _v3State.suicideBlock.getState();

// landbackV1 mission state + block states for FF mid-flight support.
out.lbState = {
  init: _lbState.init, ticks: _lbState.ticks,
  missionPhase: _lbState.missionPhase, missionPhaseStart: _lbState.missionPhaseStart,
  payloadCleared: _lbState.payloadCleared,
  stageIdx: _lbState.stageIdx, boosterIdx: _lbState.boosterIdx,
  preSplitBodyCount: _lbState.preSplitBodyCount,
  mecoTriggered: _lbState.mecoTriggered, splitDetected: _lbState.splitDetected,
  fairingOpened: _lbState.fairingOpened, deployCmdSimTime: _lbState.deployCmdSimTime,
  insertionResult: _lbState.insertionResult, suicideResult: _lbState.suicideResult,
  lastAltKm: _lbState.lastAltKm, lastAxialGap: _lbState.lastAxialGap,
  lateralArmed: _lbState.lateralArmed,
  pusherTorqueFired: _lbState.pusherTorqueFired, payloadOpenFired: _lbState.payloadOpenFired,
  // ASDS mission state — previously missing here. Without these, a restored
  // guide (FF worker, or physics worker after replaceState) thinks ASDS was
  // never deployed, re-fires _buildASDSPadForGuidance, and pushes a DUPLICATE
  // HOPE pad into the restored worker's CONFIG (same position, but the
  // duplicate is noise and makes debugging ambiguous).
  asdsSpec: _lbState.asdsSpec,
  asdsPad: _lbState.asdsPad,
  asdsDeployed: _lbState.asdsDeployed,
};
if (_lbState.ascentBlock) out.lbAscentBlock = _lbState.ascentBlock.getState();
if (_lbState.insertionBlock) out.lbInsertionBlock = _lbState.insertionBlock.getState();
if (_lbState.suicideBlock) out.lbSuicideBlock = _lbState.suicideBlock.getState();
if (_lbState.rtlsBlock) out.lbRtlsBlock = _lbState.rtlsBlock.getState();
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
  // payloadCleared is a per-run transient: any snapshot captured before the
  // payload exists (SA, EB, CH) must restore as false. Without this, a
  // just-finished run's "true" survives the restore because the loop above
  // only copies keys PRESENT in the snapshot — a field absent from every
  // snapshot leaves the live value in place, which terminates the next run
  // on tick 0 (makeLeadRunner: if (full && gs.payloadCleared) break).
  if (!('payloadCleared' in data.v3State)) _v3State.payloadCleared = false;
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

// landbackV1 restore
if (data.lbState) {
  Object.keys(data.lbState).forEach(k => { _lbState[k] = data.lbState[k]; });
  if (!('payloadCleared' in data.lbState)) _lbState.payloadCleared = false;
}
if (data.lbAscentBlock) {
  if (!_lbState.ascentBlock) _lbState.ascentBlock = FUNDAMENTAL_BLOCKS.ascent.createInstance();
  _lbState.ascentBlock.setState(data.lbAscentBlock);
}
if (data.lbInsertionBlock) {
  if (!_lbState.insertionBlock) _lbState.insertionBlock = FUNDAMENTAL_BLOCKS.insertion.createInstance();
  _lbState.insertionBlock.setState(data.lbInsertionBlock);
}
if (data.lbSuicideBlock) {
  if (!_lbState.suicideBlock) _lbState.suicideBlock = FUNDAMENTAL_BLOCKS.suicide.createInstance();
  _lbState.suicideBlock.setState(data.lbSuicideBlock);
}
if (data.lbRtlsBlock) {
  if (!_lbState.rtlsBlock) _lbState.rtlsBlock = FUNDAMENTAL_BLOCKS.standardRTLS.createInstance();
  _lbState.rtlsBlock.setState(data.lbRtlsBlock);
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

  // Mission-level payload clear tracker. Insertion block no longer
  // verifies payload clearance after its apside-peak exit; this flag
  // is set once the payload body has physically separated (>= clear
  // dist) from the stage. Exposed via getStatus for the tuner.
  payloadCleared: false,

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
  // Patch TARGET_BIAS_MPS into the insertion config per-mission.
  // Payload present -> pre-account for eject kick so stage ends at
  // target_circ - kick and payload ends at target_circ. No payload ->
  // 0 (stage ends exactly at target_circ; mission decides post-insertion).
  const _insCfgV3 = JSON.parse(JSON.stringify(_v3Config.insertion));
  const _stageBForBiasV3 = snapshot.bodies[sIdx];
  if (_stageBForBiasV3 && _stageBForBiasV3.payloadId) {
    const _envBiasV3 = Derivation.getEnv();
    _insCfgV3.TARGET_BIAS_MPS = (_envBiasV3 && Number.isFinite(_envBiasV3.PAYLOAD_EJECT_KICK_MPS))
      ? _envBiasV3.PAYLOAD_EJECT_KICK_MPS : 3.0;
  }
  _v3State.insertionBlock = FUNDAMENTAL_BLOCKS.insertion.createInstance();
  _v3State.insertionBlock.start(_insCfgV3, sIdx, {});
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
        // Mission-level payload release. Insertion exits at target-apside
        // crossing with actuators zeroed but does NOT release payload.
        const _stagePostInsV3 = snapshot.bodies[_v3State.stageIdx];
        if (_stagePostInsV3 && _stagePostInsV3.payloadId && !_stagePostInsV3.payloadReleased) {
          const _relV3 = cmdReleasePayload();
          _relV3.targetBodyIdx = _v3State.stageIdx;
          send(_relV3);
          console.log('[leoInsertionV3] mission-level payload release at t=' + simT.toFixed(2));
        }
        _v3State.missionPhase = 'DONE_DWELL';
        _v3State.missionPhaseStart = simT;
      }
      break;
    }

    case 'DONE_DWELL': {
      // Stage fully OFF in dwell — engines + gimbal + RCS all zero'd. The
      // suicide block at dwell end rotates to retrograde on its own.
      send(cmdRcsDuty(null, _v3State.stageIdx));
      send(cmdSetAllThrottle(0));
send(cmdSetGimbalRate(0));

      // ---- Mission-level payload-clear tracking ----
      // Insertion block exits at apside peak without verifying payload
      // separation. We track it here so tuner's payloadCleared signal
      // becomes true once the payload body has physically cleared.
      if (!_v3State.payloadCleared && _v3State.stageIdx >= 0) {
        const _stageP = snapshot.bodies[_v3State.stageIdx];
        if (_stageP && _stageP.payloadReleased) {
          const _clearDist = (_v3Config.insertion && Number.isFinite(_v3Config.insertion.PAYLOAD_CLEAR_DIST_M))
            ? _v3Config.insertion.PAYLOAD_CLEAR_DIST_M : 20;
          const _cleared = snapshot.bodies.some(b =>
            b && b.payloadBody && b.id !== _stageP.id &&
            Math.hypot(b.rx - _stageP.rx, b.ry - _stageP.ry) >= _clearDist
          );
          if (_cleared) {
            _v3State.payloadCleared = true;
            console.log('[leoInsertionV3] payload cleared at t=' + simT.toFixed(2));
          }
        }
      }

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
            // Mission-level target impact. Compute Earth-fixed angle from the remote
            // resting area and push it into the config clone. Block reads
            // cfg.TARGET_IMPACT_EF_DEG first; falls back to restingArea only if unset.
            // A future mission can override this to any target by replacing the
            // computation below (e.g. alternate impact sites for different stacks).
            const _targetMidWestRadV3 = ((env.REMOTE_AREA_MID_WEST_DEG || 0) * Math.PI) / 180;
            const _targetImpactEfDegV3 = (((env.LAUNCH_SITE_ANGLE_0 || 0) - _targetMidWestRadV3) * 180) / Math.PI;
            const _suicideCfgV3 = JSON.parse(JSON.stringify(_v3Config.suicide));
            if (!Number.isFinite(_suicideCfgV3.TARGET_IMPACT_EF_DEG)) {
              _suicideCfgV3.TARGET_IMPACT_EF_DEG = _targetImpactEfDegV3;
            }
            _v3State.suicideBlock = FUNDAMENTAL_BLOCKS.suicide.createInstance();
            _v3State.suicideBlock.start(_suicideCfgV3, _v3State.stageIdx, {});
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
  _v3State.payloadCleared = false;
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
      payloadCleared: _v3State.payloadCleared || ins.payloadCleared,
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

// ============================================================================
// landbackV1 — EXACT CLONE of leoInsertionV3 (renamed). Starting point for the
// Landback logic. Same phases, same blocks, same config shape. Only the
// identifiers differ (_lb* / _landbackTick / setLandbackV1 / getLandbackV1Config).
// Edit THIS copy freely — leoInsertionV3 stays untouched.
// ============================================================================

const _lbState = {
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
  rtlsBlock: null,        // standardRTLS (booster) — handed over after SEPARATED_AXIAL

  // ASDS mission support — mission type drives these.
  //   asdsSpec     : { name, km } parsed from TARGET_LANDING_PAD (e.g. "HOPE,140")
  //   asdsPad      : actual pad returned by deployASDS() after name/pos adjustment
  //   asdsDeployed : one-shot flag — deploy only fires once per guide session
  asdsSpec: null,
  asdsPad: null,
  asdsDeployed: false,

  mecoTriggered: false,
  splitDetected: false,
  fairingOpened: false,
  deployCmdSimTime: null,

  payloadCleared: false,

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

const _lbConfig = {
  ascent: null,
  separation: {
  // SEPARATED_AXIAL duration (s). Counted from the phase's entry (split
  // detected), not from the axial gap. Replaces the old AXIAL_SEP_TARGET_M
  // meter-based condition — the phase now always runs for exactly this
  // many seconds, then hands off to INSERTION.
  SEPARATION_DURATION_S: 3,
  SPLIT_TIMEOUT_S: 15,
  LATERAL_TRIGGER_MARGIN_M: 0.3,
  BOOSTER_SEP_ANG_ACCEL_DEG_S2: -3,
  BOOSTER_SEP_TARGET_OMEGA_DEG_S: 30,
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
rtls: null,
// Mission-level: which landing pad the booster returns to (id from CONFIG.LANDING_PADS).
mission: { TARGET_LANDING_PAD: 'LZ-1' },
};

(function _lbInitDefaults() {
  const F = (typeof FUNDAMENTAL_BLOCKS !== 'undefined') ? FUNDAMENTAL_BLOCKS : null;
  if (F && F.ascent) _lbConfig.ascent = JSON.parse(JSON.stringify(F.ascent.defaultConstants));
  if (F && F.insertion) _lbConfig.insertion = JSON.parse(JSON.stringify(F.insertion.defaultConstants));
  if (F && F.suicide) _lbConfig.suicide = JSON.parse(JSON.stringify(F.suicide.defaultConstants));
  if (F && F.standardRTLS) _lbConfig.rtls = JSON.parse(JSON.stringify(F.standardRTLS.defaultConstants));
})();

// ---- Mission-level target landing pad (landbackV1) ----
// Pad id comes from _lbConfig.mission.TARGET_LANDING_PAD. Position = Earth-fixed angle
// (launch-site angle + arcOffsetM / R, + = east). Uses env.LANDING_PADS if the boot handoff
// carries it; otherwise falls back to a table mirroring config.js CONFIG.LANDING_PADS.
const _LB_FALLBACK_PADS = [
  { id: 'LZ-1', arcOffsetM: 400 },
  { id: 'LZ-2', arcOffsetM: 700 },
  { id: 'LZ-3', arcOffsetM: 1000 },
];
let _lbPadWarned = false;
// Parse a TARGET_LANDING_PAD spec string for ASDS mode.
//   "HOPE,140"  -> { name: 'HOPE', km: 140 }
//   "HOPE"      -> { name: 'HOPE', km: 140 }     (default position)
//   "HOPE,abc"  -> fallback
//   garbage     -> fallback
// Fallback is always the same ({ HOPE, 140 }) so a malformed preset produces
// a predictable mission state rather than an unpredictable crash.
function _parseASDSSpec(str) {
  const FALLBACK = { name: 'HOPE', km: 140, heightM: 2 };
  if (typeof str !== 'string') return FALLBACK;
  const parts = str.split(',');
  const name = (parts[0] || '').trim();
  if (!name) return FALLBACK;
  if (parts.length === 1) return { name: name, km: 140, heightM: 2 };
  const kmStr = (parts[1] || '').trim();
  const km = parseFloat(kmStr);
  if (!Number.isFinite(km) || km <= 0) return FALLBACK;
  // Optional 3rd part: deck height above sea level (default 2 m)
  let heightM = 2;
  if (parts.length >= 3) {
    const hStr = (parts[2] || '').trim();
    const h = parseFloat(hStr);
    if (Number.isFinite(h) && h >= 0) heightM = h;
  }
  return { name: name, km: km, heightM: heightM };
}

// Build an ASDS pad object from a spec + env, mimicking asds.js's validation
// + fallback logic. Used by worker-context guidance (guidance.worker.js /
// worker-sim.js) where asds.js can't be imported (config.js deliberately
// excluded). Hardware constants below mirror asds.js — update both if changed.
// Returns { pad, wasNameAdjusted, wasPositionAdjusted, requestedName, requestedKm }.
function _buildASDSPadForGuidance(spec, env) {
  const ASDS_LENGTH_M = 91;
  const ASDS_LZ_WEST_M = 54;
  const ASDS_LZ_EAST_M = 37;
  const ASDS_MIN_GAP_M = 120;
  const ASDS_LANDING_RADIUS_M = 35;
  const ASDS_DECK_HEIGHT_M = 2;
  const OCEAN_ZONE_START_DEG = Number.isFinite(env.OCEAN_ZONE_EAST_START_DEG) ? env.OCEAN_ZONE_EAST_START_DEG : 2;
  const OCEAN_ZONE_END_DEG = Number.isFinite(env.OCEAN_ZONE_EAST_END_DEG) ? env.OCEAN_ZONE_EAST_END_DEG : 60;
  // Earth circumference wrap (like 410° → 50°)
  const C_km = 2 * Math.PI * env.EARTH_RADIUS / 1000;
  let km = spec.km;
  if (Number.isFinite(km) && (km < 0 || km >= C_km)) {
    km = ((km % C_km) + C_km) % C_km;
  }
  const heightM = Number.isFinite(spec.heightM) ? spec.heightM : ASDS_DECK_HEIGHT_M;
  const requestedName = spec.name;
  const requestedKm = km;

  // Collect existing ASDS (env boot snapshot + this session's _lbState.asdsPad)
  const existing = [];
  const takenNames = new Set();
  if (Array.isArray(env.LANDING_PADS)) {
    for (const p of env.LANDING_PADS) {
      if (!p) continue;
      if (p.isASDS) existing.push(p);
      if (p.name) takenNames.add(p.name);
      if (p.id) takenNames.add(p.id);
    }
  }
  if (_lbState.asdsPad) {
    existing.push(_lbState.asdsPad);
    if (_lbState.asdsPad.name) takenNames.add(_lbState.asdsPad.name);
    if (_lbState.asdsPad.id) takenNames.add(_lbState.asdsPad.id);
  }

  // Name collision — HOPE → HOPE-1 → HOPE-2 ...
  let appliedName = requestedName;
  let wasNameAdjusted = false;
  if (takenNames.has(requestedName)) {
    for (let i = 1; i < 100; i++) {
      const cand = requestedName + '-' + i;
      if (!takenNames.has(cand)) { appliedName = cand; wasNameAdjusted = true; break; }
    }
  }

  // Ocean bounds + gap validation, ±10 km fallback (mirrors asds.js)
  const R = env.EARTH_RADIUS;
  const startM = OCEAN_ZONE_START_DEG * Math.PI / 180 * R;
  const endM = OCEAN_ZONE_END_DEG * Math.PI / 180 * R;
  const requestedM = Math.round(km * 1000);
  function boundsOk(m) {
    if (m - ASDS_LZ_WEST_M < startM) return false;
    if (m + ASDS_LZ_EAST_M > endM) return false;
    return true;
  }
  let appliedM = requestedM;
  let wasPositionAdjusted = false;
  if (!boundsOk(requestedM)) {
    let found = false;
    for (let d = 1000; d <= 10000; d += 1000) {
      if (boundsOk(requestedM + d)) { appliedM = requestedM + d; wasPositionAdjusted = true; found = true; break; }
      if (boundsOk(requestedM - d)) { appliedM = requestedM - d; wasPositionAdjusted = true; found = true; break; }
    }
    if (!found) {
      appliedM = 140000;
      appliedName = (takenNames.has('HOPE') ? 'HOPE-1' : 'HOPE');
      wasPositionAdjusted = true;
    }
  }

  // ---- Shift conflicting existing pads out of the way ----
  // Latest deploy wins requested position EXACTLY. Any existing pad within
  // hull-gap is moved to nearest valid spot. Lets pre-deploy HOPE @ 328.204
  // and guide-driven deploy @ 328.204 co-exist: pre-existing HOPE shifts
  // out, guide's pad (HOPE-1 by name collision) takes 328.204 exactly —
  // fixes the 19m/1km off-target bug seen when pre-deploy + guide ASDS
  // combine. Same policy as asds.js deployASDS.
  const shifts = [];
  const conflicting = existing.filter(function (p) {
    return (Math.abs(appliedM - (p.arcOffsetM || 0)) - ASDS_LENGTH_M) < ASDS_MIN_GAP_M;
  });
  if (conflicting.length) {
    const otherPads = [];
    for (let i = 0; i < existing.length; i++) {
      if (conflicting.indexOf(existing[i]) < 0) {
        otherPads.push({ arcOffsetM: existing[i].arcOffsetM, name: existing[i].name });
      }
    }
    otherPads.push({ arcOffsetM: appliedM, name: appliedName });
    let shiftAbort = false;
    for (let i = 0; i < conflicting.length; i++) {
      const p = conflicting[i];
      let newM = null;
      for (let d = 1000; d <= 10000; d += 1000) {
        let hit = false;
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const cand = Math.round((p.arcOffsetM || 0) + sgn * d);
          if (cand - ASDS_LZ_WEST_M < startM) continue;
          if (cand + ASDS_LZ_EAST_M > endM) continue;
          let ok = true;
          for (let j = 0; j < otherPads.length; j++) {
            const gap = Math.abs(cand - otherPads[j].arcOffsetM) - ASDS_LENGTH_M;
            if (gap < ASDS_MIN_GAP_M) { ok = false; break; }
          }
          if (ok) { newM = cand; hit = true; break; }
        }
        if (hit) break;
      }
      if (newM == null) { shiftAbort = true; break; }
      shifts.push({
        id: p.id, name: p.name,
        oldM: p.arcOffsetM, newM: newM,
        pad: Object.assign({}, p, { arcOffsetM: newM }),
      });
      otherPads.push({ arcOffsetM: newM, name: p.name });
    }
    if (shiftAbort) {
      // Cannot shift — old ±10km nudge fallback for the NEW pad.
      shifts.length = 0;
      for (let d = 1000; d <= 10000; d += 1000) {
        let hit = false;
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const cand = Math.round(requestedM + sgn * d);
          if (!boundsOk(cand)) continue;
          let ok = true;
          for (let k = 0; k < existing.length; k++) {
            const gap = Math.abs(cand - existing[k].arcOffsetM) - ASDS_LENGTH_M;
            if (gap < ASDS_MIN_GAP_M) { ok = false; break; }
          }
          if (ok) { appliedM = cand; wasPositionAdjusted = true; hit = true; break; }
        }
        if (hit) break;
      }
    }
  }

  const pad = {
    id: appliedName,
    name: appliedName,
    arcOffsetM: appliedM,
    radiusM: ASDS_LANDING_RADIUS_M,
    heightM: heightM,
    lengthM: ASDS_LENGTH_M,
    enabled: true,
    isASDS: true,
    lights: false,
  };
  return {
    pad: pad,
    shifts: shifts,
    wasNameAdjusted: wasNameAdjusted,
    wasPositionAdjusted: wasPositionAdjusted,
    requestedName: requestedName,
    requestedKm: requestedKm,
  };
}

function _lbResolveTargetPad() {
  const env = Derivation.getEnv() || {};
  // ASDS mode: guidance owns the deployed pad — return it directly. No env
  // lookup, no CONFIG lookup. Name/id/position/heightM all come from the
  // object deployASDS() actually created, which already accounts for any
  // collision-renames or position-nudges.
  // ASDS mode: prefer the guidance-owned pad (_lbState.asdsPad), which is
  // authoritative — deployASDS() already resolved name collisions and
  // position nudges, so its return is what actually exists on the field.
  if (_lbConfig.rtls && _lbConfig.rtls.MISSION_TYPE === 'ASDS') {
    let p = _lbState.asdsPad;
    // Fallback: deployASDS() may have failed (asds.js not loaded, or
    // validation rejected the request). Try the parsed name from
    // TARGET_LANDING_PAD — the user may have pre-deployed the droneship
    // manually (e.g. via deployASDS('HOPE', 130) in console). No raw-
    // string lookup; _parseASDSSpec already normalised "HOPE, 130" to
    // { name: 'HOPE', km: 130 }, so we search by 'HOPE'.
    if (!p) {
      const _parsed = _lbState.asdsSpec || _parseASDSSpec(_lbConfig.mission && _lbConfig.mission.TARGET_LANDING_PAD);
      let _padList = null;
      if (typeof CONFIG !== 'undefined' && CONFIG && Array.isArray(CONFIG.LANDING_PADS)) _padList = CONFIG.LANDING_PADS;
      else if (Array.isArray(env.LANDING_PADS)) _padList = env.LANDING_PADS;
      if (_padList) {
        p = _padList.find(x => x && x.isASDS && (x.id === _parsed.name || x.name === _parsed.name)) || null;
      }
      if (p) console.log('[landbackV1] ASDS mode: using pre-deployed pad "' + p.name + '" @ ' + (p.arcOffsetM / 1000).toFixed(2) + ' km');
      else console.warn('[landbackV1] ASDS mode: droneship "' + _parsed.name + '" not deployed — LB falls back to launch-site targeting');
    }
    if (p) {
      const Rg = env.EARTH_RADIUS + (env.LAUNCH_SITE_ALTITUDE || 0);
      const angleEf = (env.LAUNCH_SITE_ANGLE_0 || 0) + p.arcOffsetM / Rg;
      return {
        id: p.id,
        name: p.name,
        arcOffsetM: p.arcOffsetM,
        angleEf: angleEf,
        heightM: Number.isFinite(p.heightM) ? p.heightM : 0,
      };
    }
    // No pad found — fall through to RTLS path so the booster has some
    // target (better to crash at launch site than aim at garbage). The
    // warning above tells the user why.
  }
  const id = (_lbConfig.mission && _lbConfig.mission.TARGET_LANDING_PAD) || 'LZ-1';
  // Live CONFIG.LANDING_PADS preferred over the boot-time env snapshot
  // when CONFIG is in scope. Main-thread pages (lb-nova6, testers) have
  // CONFIG globally, so a mid-session deployASDS() / setASDSPosition()
  // is visible here immediately — no re-INIT needed to pick up a new
  // pad or move an existing one. The guidance worker deliberately does
  // NOT import config.js, so CONFIG is undefined there and env.LANDING_PADS
  // (the boot handoff) is used as before.
  let pads = null;
  if (typeof CONFIG !== 'undefined' && CONFIG && Array.isArray(CONFIG.LANDING_PADS)) {
    pads = CONFIG.LANDING_PADS;
  } else if (Array.isArray(env.LANDING_PADS)) {
    pads = env.LANDING_PADS;
  }
  if (!pads) {
    if (!_lbPadWarned) {
      _lbPadWarned = true;
      console.warn('[landbackV1] env.LANDING_PADS not in boot handoff — using built-in pad table (mirror of config.js)');
    }
    pads = _LB_FALLBACK_PADS;
  }
  const p = pads.find(x => x && x.id === id && x.enabled !== false);
  if (!p) {
    console.warn('[landbackV1] target pad "' + id + '" not found / disabled — RTLS falls back to the launch site');
    return null;
  }
  const Rg = env.EARTH_RADIUS + (env.LAUNCH_SITE_ALTITUDE || 0);
  const angleEf = (env.LAUNCH_SITE_ANGLE_0 || 0) + p.arcOffsetM / Rg;
  return {
    id: p.id,
    arcOffsetM: p.arcOffsetM,
    angleEf: angleEf,
    // Carry pad height so the landing-burn descent law can aim for the
    // actual pad surface (ASDS decks sit 2 m above sea level; flat ground
    // pads default to 0). Consumed by guidance-blocks.js LB case's hEff.
    heightM: Number.isFinite(p.heightM) ? p.heightM : 0,
  };
}

function _lbCurrentPhase() {
  const mp = _lbState.missionPhase;
  if (mp === 'ASCENT') return 'ASCENT';
  if (mp === 'WAIT_SPLIT') return 'MECO_SPOOL';
  if (mp === 'SEPARATED_AXIAL') return 'SEPARATED_AXIAL';
  if (mp === 'INSERTION') {
    if (_lbState.insertionBlock) return _lbState.insertionBlock.getStatus().phase;
    return '?';
  }
  if (mp === 'DONE_DWELL') return 'DONE';
  if (mp === 'SUICIDE') {
    if (_lbState.suicideBlock) return _lbState.suicideBlock.getStatus().phase;
    return '?';
  }
  return '?';
}

// (shared helpers _stageBellHeightForBody / _discardedStackTop_m are reused from above)

function _landbackTick(snapshot) {
  _lbState.ticks++;
  if (!snapshot || !Array.isArray(snapshot.bodies) || !snapshot.bodies.length) return;
  const simT = snapshot.simTime;

  if (!_lbState.init) {
    _lbState.init = true;
    _lbState.missionPhase = 'ASCENT';
    _lbState.missionPhaseStart = simT;
    _lbState.preSplitBodyCount = snapshot.bodies.length;
    _lbState.stageIdx = 0;
    _lbState.boosterIdx = -1;

    _lbState.ascentBlock = FUNDAMENTAL_BLOCKS.ascent.createInstance();
    _lbState.ascentBlock.start(_lbConfig.ascent, 0, {});
  }

  // ---- ASDS deploy (mission type = ASDS) ----
  // Deploy the droneship once at mission start, before ASCENT hands off.
  // The pad returned by deployASDS() is authoritative — guidance stores it
  // and uses it for target lookup (never re-derives from env/CONFIG). Name
  // and position may differ from the request (HOPE → HOPE-1 on collision,
  // ±10 km nudge on ocean/gap conflict); we always use what was applied.
  if (_lbConfig.rtls && _lbConfig.rtls.MISSION_TYPE === 'ASDS' && !_lbState.asdsDeployed) {
    _lbState.asdsDeployed = true;
    const _specStr = (_lbConfig.mission && _lbConfig.mission.TARGET_LANDING_PAD) || '';
    _lbState.asdsSpec = _parseASDSSpec(_specStr);
    // Context detection:
    //   Main thread (lb-nova6, testers) — asds.js loaded, globalThis.deployASDS
    //     is a function. Call it: full validation + dual broadcast (main render
    //     worker + WorkerBridge for physics).
    //   Guidance worker (guidance.worker.js / worker-sim.js) — asds.js NOT
    //     loaded (config.js deliberately excluded for scope isolation). Build
    //     the pad locally from Derivation.getEnv() and send via physicsPort.
    //     Physics echoes back to main thread, workerBridge relays to render.
    // Both paths produce the same pad object; guidance stores it in
    // _lbState.asdsPad regardless of context.
    const _mainThreadDeploy = (typeof globalThis.deployASDS === 'function');
    if (_mainThreadDeploy) {
      const _result = globalThis.deployASDS(_lbState.asdsSpec.name, _lbState.asdsSpec.km, _lbState.asdsSpec.heightM);
      if (_result && _result.ok) {
        _lbState.asdsPad = _result.pad;
        console.log('[landbackV1] ASDS deployed (main thread): ' + _result.appliedName +
          ' @ ' + _result.appliedKm.toFixed(2) + ' km, height=' + _result.appliedHeightM + 'm' +
          (_result.wasNameAdjusted ? ' (renamed from "' + _result.requestedName + '")' : '') +
          (_result.wasPositionAdjusted ? ' (moved from ' + _result.requestedKm.toFixed(2) + ' km)' : ''));
      } else {
        console.warn('[landbackV1] ASDS deploy FAILED: ' + (_result && _result.error || 'unknown') +
          ' — mission continues with fallback targeting');
        _lbState.asdsPad = null;
      }
    } else {
      const _env = Derivation.getEnv() || {};
      const _built = _buildASDSPadForGuidance(_lbState.asdsSpec, _env);
      _lbState.asdsPad = _built.pad;
      // Broadcast shift moves FIRST, then the add — downstream CONFIGs
      // see moved pads before the new arrival, no transient 2-pads-same-spot.
      if (_built.shifts && _built.shifts.length) {
        for (let _si = 0; _si < _built.shifts.length; _si++) {
          send({ type: 'moveLandingPad', pad: _built.shifts[_si].pad });
        }
      }
      send({ type: 'addLandingPad', pad: _built.pad });
      let _shiftTxt = '';
      if (_built.shifts && _built.shifts.length) {
        _shiftTxt = ' (shifted: ' + _built.shifts.map(function (sh) {
          const _dm = sh.newM - sh.oldM;
          return sh.name + '→' + (sh.newM / 1000).toFixed(2) + 'km (' + (_dm >= 0 ? '+' : '') + (_dm / 1000).toFixed(2) + 'km)';
        }).join(', ') + ')';
      }
      console.log('[landbackV1] ASDS deployed (worker-built): ' + _built.pad.name +
        ' @ ' + (_built.pad.arcOffsetM / 1000).toFixed(2) + ' km, height=' + _built.pad.heightM + 'm' +
        (_built.wasNameAdjusted ? ' (renamed from "' + _built.requestedName + '")' : '') +
        (_built.wasPositionAdjusted ? ' (moved from ' + _built.requestedKm.toFixed(2) + ' km)' : '') +
        _shiftTxt +
        ' — sent via physicsPort, awaiting main echo');
    }
  }

  // ---- Mission-level fairing auto-open (phase-independent) ----
  if (!_lbState.fairingOpened &&
      _lbState.splitDetected &&
      _lbConfig.fairing.HAS_FAIRING &&
      _lbConfig.fairing.FAIRING_OPEN_ENABLED &&
      _lbState.stageIdx >= 0) {
    const stageBody = snapshot.bodies[_lbState.stageIdx];
    if (stageBody) {
      const env = Derivation.getEnv();
      const altKm = (Math.hypot(stageBody.rx, stageBody.ry) - env.EARTH_RADIUS) / 1000;
      _lbState.lastAltKm = altKm;
      if (altKm >= _lbConfig.fairing.FAIRING_OPEN_ALT_KM) {
        const hasFairing = stageBody.members &&
          stageBody.members.some(m => m && m.stageRole === 'payloadSpace');
        if (hasFairing) {
          const cmd = cmdSplitFairing();
          cmd.targetBodyIdx = _lbState.stageIdx;
          send(cmd);
          _lbState.fairingOpened = true;
          console.log('[landbackV1] fairing open at t=' + simT.toFixed(2) +
            ' alt=' + altKm.toFixed(2) + ' km');
        }
      }
    }
  }

  // ---- Booster block (standardRTLS) — runs in parallel with the stage's mission phases ----
  if (_lbState.rtlsBlock && !_lbState.rtlsBlock.isDone()) {
    try { _lbState.rtlsBlock.tick(snapshot); }
    catch (e) { console.error('[landbackV1] rtls tick failed', e); }
  }

  switch (_lbState.missionPhase) {

    case 'ASCENT': {
      _lbState.ascentBlock.tick(snapshot);
      if (_lbState.ascentBlock.isDone()) {
        _lbState.mecoTriggered = true;
        _lbState.missionPhase = 'WAIT_SPLIT';
        _lbState.missionPhaseStart = simT;
        _lbState.preSplitBodyCount = snapshot.bodies.length;
      }
      break;
    }

    case 'WAIT_SPLIT': {
  if (snapshot.bodies.length > _lbState.preSplitBodyCount) {
  _lbState.splitDetected = true;
  _lbState.stageIdx = 0;
  const boosterIdx = snapshot.bodies.findIndex((b, i) =>
    i !== _lbState.stageIdx && b && !b.isActive);
  _lbState.boosterIdx = boosterIdx >= 0 ? boosterIdx : 1;
  _lbState.pusherTorqueFired = false;
  // Pusher torque is NOT fired here — it waits in SEPARATED_AXIAL
  // until the axial gap clears the stage's engine bell (see the
  // arming check in that case). Firing at split-time would rotate
  // the booster while its interstage still overlaps the MVac bell.
  _lbState.missionPhase = 'SEPARATED_AXIAL';
  _lbState.missionPhaseStart = simT;
  break;
}
  if (simT - _lbState.missionPhaseStart > _lbConfig.separation.SPLIT_TIMEOUT_S) {
    console.warn('[landbackV1] split timeout');
    _lbState.missionPhase = 'END';
  }
  break;
}

    case 'SEPARATED_AXIAL': {
  const bIdx = _lbState.boosterIdx;
  const sIdx = _lbState.stageIdx;
  if (bIdx < 0 || sIdx < 0) { _lbState.missionPhase = 'END'; break; }
  const boosterBody = snapshot.bodies[bIdx];
  const stageBody = snapshot.bodies[sIdx];
  if (!boosterBody || !stageBody) { _lbState.missionPhase = 'END'; break; }

  const discardedTop_m = _discardedStackTop_m(boosterBody);
  const upX = -Math.sin(stageBody.theta);
  const upY = Math.cos(stageBody.theta);
  const dx = stageBody.rx - boosterBody.rx;
  const dy = stageBody.ry - boosterBody.ry;
  const axialGap = Math.max(0, (dx * upX + dy * upY) - discardedTop_m);
  _lbState.lastAxialGap = axialGap;

  const stageBellH = _stageBellHeightForBody(stageBody);
  const lateralMargin = Number.isFinite(_lbConfig.separation.LATERAL_TRIGGER_MARGIN_M) ?
    _lbConfig.separation.LATERAL_TRIGGER_MARGIN_M : 0;
  const bellCleared = (stageBellH > 0) && (axialGap >= stageBellH + lateralMargin);
  _lbState.lateralArmed = false;

  const boosterAxial = GuideRCS.postSeparationAxialDuty(snapshot, bIdx, 'dn');
  const boosterMerged = boosterAxial ? Object.assign({}, boosterAxial) : {};
  send(cmdRcsDuty(boosterMerged, bIdx));

  const stageDuties = GuideRCS.postSeparationAxialDuty(snapshot, sIdx, 'up');
  if (stageDuties) { const c = cmdRcsDuty(stageDuties, sIdx); send(c); }

  const elapsedSep = simT - _lbState.missionPhaseStart;
  const sepDur = _lbConfig.separation.SEPARATION_DURATION_S;
  const clearOk = !(stageBellH > 0) || bellCleared;
  if (elapsedSep >= sepDur && (clearOk || elapsedSep >= sepDur + 3)) {
    send(cmdRcsDuty(null, sIdx));
    send(cmdRcsDuty(null, bIdx));
    _lbState.lateralArmed = false;

    const relAx = (stageBody.vx - boosterBody.vx) * upX + (stageBody.vy - boosterBody.vy) * upY;
    console.log('[landbackV1] SEP handoff t=' + simT.toFixed(2) + ' elapsed=' + elapsedSep.toFixed(2) +
      ' axialGap=' + axialGap.toFixed(2) + 'm bellH=' + stageBellH.toFixed(2) + 'm relAxialV=' + relAx.toFixed(3) +
      'm/s boosterOmega=' + ((boosterBody.omega || 0) * 180 / Math.PI).toFixed(3) + 'deg/s');

    const _rt = _lbConfig.rtls || {};
    const _sp = _lbConfig.separation;
    _lbState.pusherTorqueFired = false;
    _lbState.rtlsBlock = FUNDAMENTAL_BLOCKS.standardRTLS.createInstance();
    _lbState.rtlsBlock.start(_lbConfig.rtls, bIdx, {
      targetPad: _lbResolveTargetPad(),
      pusher: {
        alphaRad: (Number.isFinite(_rt.FLIP_PUSHER_ANG_ACCEL_DEG_S2) ? _rt.FLIP_PUSHER_ANG_ACCEL_DEG_S2 : _sp.BOOSTER_SEP_ANG_ACCEL_DEG_S2) * Math.PI / 180,
        capRad: (Number.isFinite(_rt.FLIP_PUSHER_MAX_OMEGA_DEG_S) ? _rt.FLIP_PUSHER_MAX_OMEGA_DEG_S : _sp.BOOSTER_SEP_TARGET_OMEGA_DEG_S) * Math.PI / 180,
        isOn: function () { return _lbState.pusherTorqueFired; },
        set: function (a, w) { _lbState.pusherTorqueFired = (a !== 0 && w > 0); send(cmdPusherTorque(a, w, bIdx)); },
      },
    });
    console.log('[landbackV1] booster -> standardRTLS at t=' + simT.toFixed(2));

    // Patch TARGET_BIAS_MPS into the insertion config per-mission.
    const _insCfgLB = JSON.parse(JSON.stringify(_lbConfig.insertion));
    const _stageBForBiasLB = snapshot.bodies[sIdx];
    if (_stageBForBiasLB && _stageBForBiasLB.payloadId) {
      const _envBiasLB = Derivation.getEnv();
      _insCfgLB.TARGET_BIAS_MPS = (_envBiasLB && Number.isFinite(_envBiasLB.PAYLOAD_EJECT_KICK_MPS))
        ? _envBiasLB.PAYLOAD_EJECT_KICK_MPS : 3.0;
    }
    _lbState.insertionBlock = FUNDAMENTAL_BLOCKS.insertion.createInstance();
    _lbState.insertionBlock.start(_insCfgLB, sIdx, {});
    _lbState.missionPhase = 'INSERTION';
    _lbState.missionPhaseStart = simT;
  }
  break;
}

    case 'INSERTION': {
      _lbState.insertionBlock.tick(snapshot);
      if (_lbState.insertionBlock.isDone()) {
        _lbState.insertionResult = _lbState.insertionBlock.getResult();
        _lbState.deployCmdSimTime = _lbState.insertionResult
          ? _lbState.insertionResult.deployCommandSimTime : simT;
        // Mission-level payload release — same rationale as leoInsertionV3.
        const _stagePostInsLB = snapshot.bodies[_lbState.stageIdx];
        if (_stagePostInsLB && _stagePostInsLB.payloadId && !_stagePostInsLB.payloadReleased) {
          const _relLB = cmdReleasePayload();
          _relLB.targetBodyIdx = _lbState.stageIdx;
          send(_relLB);
          console.log('[landbackV1] mission-level payload release at t=' + simT.toFixed(2));
        }
        _lbState.missionPhase = 'DONE_DWELL';
        _lbState.missionPhaseStart = simT;
      }
      break;
    }

    case 'DONE_DWELL': {
      // Stage fully OFF in dwell — engines + gimbal + RCS all zero'd. The
      // suicide block at dwell end rotates to retrograde on its own.
      send(cmdRcsDuty(null, _lbState.stageIdx));
      send(cmdSetAllThrottle(0));
send(cmdSetGimbalRate(0));

      // ---- Mission-level payload-clear tracking (same as V3) ----
      if (!_lbState.payloadCleared && _lbState.stageIdx >= 0) {
        const _stageP = snapshot.bodies[_lbState.stageIdx];
        if (_stageP && _stageP.payloadReleased) {
          const _clearDist = (_lbConfig.insertion && Number.isFinite(_lbConfig.insertion.PAYLOAD_CLEAR_DIST_M))
            ? _lbConfig.insertion.PAYLOAD_CLEAR_DIST_M : 20;
          const _cleared = snapshot.bodies.some(b =>
            b && b.payloadBody && b.id !== _stageP.id &&
            Math.hypot(b.rx - _stageP.rx, b.ry - _stageP.ry) >= _clearDist
          );
          if (_cleared) {
            _lbState.payloadCleared = true;
            console.log('[landbackV1] payload cleared at t=' + simT.toFixed(2));
          }
        }
      }

// ---- Payload-open command ----
// After deploy, wait PAYLOAD_DEPLOY_OPEN_DELAY_S seconds, then send
// a one-shot open command to the deployed payload body. Finding the
// body by scanning for the payloadBody marker — its index can shift
// as other bodies spawn.
if (!_lbState.payloadOpenFired &&
  Number.isFinite(_lbState.deployCmdSimTime) &&
  simT >= _lbState.deployCmdSimTime + _lbConfig.done.PAYLOAD_DEPLOY_OPEN_DELAY_S) {
  let _payIdx = -1;
  for (let _i = 0; _i < snapshot.bodies.length; _i++) {
    const _b = snapshot.bodies[_i];
    if (_b && _b.payloadBody && !_b.payloadOpened) { _payIdx = _i; break; }
  }
  if (_payIdx >= 0) {
    send(cmdOpenPayload(_payIdx));
    _lbState.payloadOpenFired = true;
  }
}

// Dwell measured from the DEPLOY COMMAND tick — the correct

      // Dwell measured from the DEPLOY COMMAND tick — the correct
      // behaviour. V2 measured from COAST_HOLD_2 entry due to a missing
      // phaseStart update, giving ~59.29s of actual dwell instead of 60s.
      const deployT = _lbState.deployCmdSimTime != null
        ? _lbState.deployCmdSimTime : _lbState.missionPhaseStart;
      const dwellS = simT - deployT;

      if (dwellS >= _lbConfig.done.SUICIDE_DELAY_AFTER_DEPLOY_S) {
        send(cmdRcsDuty(null, _lbState.stageIdx));

        if (_lbConfig.done.DEORBIT_ENABLED) {
send(cmdMarkIntentionalImpact(_lbState.stageIdx));
            const env = Derivation.getEnv();
            // Mission-level target impact. Compute Earth-fixed angle from the remote
            // resting area and push it into the config clone. Block reads
            // cfg.TARGET_IMPACT_EF_DEG first; falls back to restingArea only if unset.
            // A future mission can override this to any target by replacing the
            // computation below (e.g. alternate impact sites for different stacks).
            const _targetMidWestRadLB = ((env.REMOTE_AREA_MID_WEST_DEG || 0) * Math.PI) / 180;
            const _targetImpactEfDegLB = (((env.LAUNCH_SITE_ANGLE_0 || 0) - _targetMidWestRadLB) * 180) / Math.PI;
            const _suicideCfgLB = JSON.parse(JSON.stringify(_lbConfig.suicide));
            if (!Number.isFinite(_suicideCfgLB.TARGET_IMPACT_EF_DEG)) {
              _suicideCfgLB.TARGET_IMPACT_EF_DEG = _targetImpactEfDegLB;
            }
            _lbState.suicideBlock = FUNDAMENTAL_BLOCKS.suicide.createInstance();
            _lbState.suicideBlock.start(_suicideCfgLB, _lbState.stageIdx, {});
          _lbState.missionPhase = 'SUICIDE';
          _lbState.missionPhaseStart = simT;
          console.log('[landbackV1] DONE_DWELL → SUICIDE at t=' + simT.toFixed(2));
        } else {
          _lbState.missionPhase = 'END';
          _lbState.missionPhaseStart = simT;
        }
      }
      break;
    }

    case 'SUICIDE': {
      _lbState.suicideBlock.tick(snapshot);
      if (_lbState.suicideBlock.isDone()) {
        _lbState.suicideResult = _lbState.suicideBlock.getResult();
        _lbState.missionPhase = 'END';
        _lbState.missionPhaseStart = simT;
        console.log('[landbackV1] SUICIDE done at t=' + simT.toFixed(2));
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

_landbackTick.start = function () {
  _lbState.init = false;
  _lbState.ticks = 0;
  _lbState.missionPhase = 'ASCENT';
  _lbState.missionPhaseStart = 0;
  _lbState.stageIdx = -1;
  _lbState.boosterIdx = -1;
  _lbState.preSplitBodyCount = 0;
  _lbState.ascentBlock = null;
  _lbState.insertionBlock = null;
  _lbState.suicideBlock = null;
  _lbState.rtlsBlock = null;
  _lbState.mecoTriggered = false;
  _lbState.splitDetected = false;
  _lbState.fairingOpened = false;
  _lbState.deployCmdSimTime = null;
  _lbState.payloadCleared = false;
  _lbState.insertionResult = null;
_lbState.suicideResult = null;
_lbState.payloadOpenFired = false;
_lbState.lastAltKm = 0;
_lbState.lastAxialGap = 0;
_lbState.lateralArmed = false;
_lbState.pusherTorqueFired = false;
_lbState.asdsSpec = null;
_lbState.asdsPad = null;
_lbState.asdsDeployed = false;
console.log('[landbackV1] started');
};

_landbackTick.stop = function () {
  if (_lbState.ascentBlock) { try { _lbState.ascentBlock.stop(); } catch (e) {} }
  if (_lbState.insertionBlock) { try { _lbState.insertionBlock.stop(); } catch (e) {} }
  if (_lbState.suicideBlock) { try { _lbState.suicideBlock.stop(); } catch (e) {} }
  if (_lbState.rtlsBlock) { try { _lbState.rtlsBlock.stop(); } catch (e) {} }
  _lbState.ascentBlock = null;
  _lbState.insertionBlock = null;
  _lbState.suicideBlock = null;
  _lbState.rtlsBlock = null;
  _lbState.asdsSpec = null;
  _lbState.asdsPad = null;
  _lbState.asdsDeployed = false;
  console.log('[landbackV1] stopped');
};

_landbackTick.getStatus = function () {
  const out = {
    ticks: _lbState.ticks,
    phase: _lbCurrentPhase(),
    mecoTriggered: _lbState.mecoTriggered,
    splitDetected: _lbState.splitDetected,
    fairingOpened: _lbState.fairingOpened,
    axialGap: _lbState.lastAxialGap,
    altKm: _lbState.lastAltKm,
  };

  if ((_lbState.missionPhase === 'ASCENT') && _lbState.ascentBlock) {
    const as = _lbState.ascentBlock.getStatus();
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
out.suicideDelayS = _lbConfig.done.SUICIDE_DELAY_AFTER_DEPLOY_S;
out.suicidePendingStartS =
  (Number.isFinite(_lbState.deployCmdSimTime) &&
    Number.isFinite(_lbConfig.done.SUICIDE_DELAY_AFTER_DEPLOY_S)) ?
  (_lbState.deployCmdSimTime + _lbConfig.done.SUICIDE_DELAY_AFTER_DEPLOY_S) :
  null;

if (_lbState.insertionBlock) {
  const ins = _lbState.insertionBlock.getStatus();
  Object.assign(out, {
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
      payloadCleared: _lbState.payloadCleared || ins.payloadCleared,
    });
  }

  if (_lbState.suicideBlock) {
    const su = _lbState.suicideBlock.getStatus();
    Object.assign(out, {
      suicidePhase: su.phase,
      suicideImpactEfDeg: su.suicideImpactEfDeg,
      suicideDlambdaDeg: su.suicideDlambdaDeg,
      suicideTrimDone: su.suicideTrimDone,
    });
  }

  if (_lbState.rtlsBlock) {
    const rs = _lbState.rtlsBlock.getStatus();
    Object.assign(out, {
      rtlsPhase: rs.phase,
      rtlsAltKm: rs.altKm,
      rtlsFlipMode: rs.flipMode,
      rtlsFlipErrDeg: rs.flipErrDeg,
      rtlsFlipOmegaDegS: rs.flipOmegaDegS,
      rtlsFlipTgtDeg: rs.flipTgtDeg,
      rtlsRcsTorque: rs.rcsTorque,
      rtlsBbStage: rs.bbStage,
      rtlsBbErrDeg: rs.bbErrDeg,
      rtlsBbImpactEfDeg: rs.bbImpactEfDeg,
      rtlsBbTargetEfDeg: rs.bbTargetEfDeg,
      rtlsBbThrFrac: rs.bbThrFrac,
      rtlsPreEntrySub: rs.preEntrySub,
      rtlsPreEntryErrDeg: rs.preEntryErrDeg,
      rtlsPreEntryOmegaDegS: rs.preEntryOmegaDegS,
      rtlsPreEntryTgtDeg: rs.preEntryTgtDeg,
      rtlsEbStage: rs.ebStage,
      rtlsEbSpeedMs: rs.ebSpeedMs,
      rtlsEbErrDeg: rs.ebErrDeg,
      rtlsEbAlphaDeg: rs.ebAlphaDeg,
      rtlsEbGimbalDeg: rs.ebGimbalDeg,
      rtlsEbGimbalReqDeg: rs.ebGimbalReqDeg,
      rtlsEbGimbalSat: rs.ebGimbalSat,
      rtlsEbThrFrac: rs.ebThrFrac,
      rtlsEbImpactErrM: rs.ebImpactErrM,
      rtlsEbRcsTorque: rs.ebRcsTorque,
      rtlsEbRcsDir: rs.ebRcsDir,
      rtlsEbFlips: rs.ebFlips,
      rtlsEbAlphaNextDeg: rs.ebAlphaNextDeg,
      rtlsEbTgoS: rs.ebTgoS,
      rtlsEbErateMps: rs.ebErateMps,
      rtlsEbKappa: rs.ebKappa,
      rtlsEbPredErrM: rs.ebPredErrM,
      rtlsEbRcsCmd: rs.ebRcsCmd,
      rtlsPesCtrlCmd: rs.pesCtrlCmd,
      rtlsPesGroundErrM: rs.pesGroundErrM,
      rtlsPesVacErrM: rs.pesVacErrM,
      rtlsPesAlphaDeg: rs.pesAlphaDeg,
      rtlsPesOmegaDegS: rs.pesOmegaDegS,
      rtlsPesQ: rs.pesQ,
      rtlsPesEdotPredMps: rs.pesEdotPredMps,
      rtlsPesEdotMeasMps: rs.pesEdotMeasMps,
      rtlsPesRcsTorque: rs.pesRcsTorque,
      rtlsPesFinCtrlActDeg: rs.pesFinCtrlActDeg,
      rtlsLbSpooled: rs.lbSpooled,
      rtlsLbAlignStartT: rs.lbAlignStartT,
      rtlsLbAlignDeltaMax: rs.lbAlignDeltaMax,
      rtlsLbLastFyBody: rs.lbLastFyBody,
      rtlsLbPlan: rs.lbPlan,
      rtlsLbLegsDeployed: rs.lbLegsDeployed,
    });
  }

  return out;
};


GUIDES.landbackV1 = _landbackTick;



 

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

  function setLandbackV1(patch) {
  if (!patch) return;
  // rtls schema check — filter unknown sub-keys against block defaultConstants
  const _rtlsSchema = (typeof FUNDAMENTAL_BLOCKS !== 'undefined' &&
                       FUNDAMENTAL_BLOCKS.standardRTLS &&
                       FUNDAMENTAL_BLOCKS.standardRTLS.defaultConstants) || null;
  Object.keys(patch).forEach(k => {
    if (!(k in _lbConfig)) return;
    const cur = _lbConfig[k];
    const nxt = patch[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) &&
        nxt && typeof nxt === 'object' && !Array.isArray(nxt)) {
      if (k === 'rtls' && _rtlsSchema) {
        const dropped = [];
        Object.keys(nxt).forEach(sk => {
          if (sk in _rtlsSchema) cur[sk] = nxt[sk];
          else dropped.push(sk);
        });
        if (dropped.length) console.log('[landbackV1] rtls stale keys dropped: ' + dropped.join(', '));
      } else {
        Object.assign(cur, nxt);
      }
    } else {
      _lbConfig[k] = nxt;
    }
  });
  console.log('[landbackV1] constants updated');
}
function getLandbackV1Config() { return JSON.parse(JSON.stringify(_lbConfig)); }
  // ============================================================================
  // Guide config API — table + accessors.
  //
  // Only leoInsertionV3 has tunable constants now. The table shape is kept
  // identical so callers (guidance modal, presets page, tester, fast page)
  // don't need any change.
  // ============================================================================
  const _GUIDE_CONFIGS = {
  leoInsertionV3: {
    get: () => getLeoInsertionV3Config(),
    set: (vals) => setLeoInsertionV3(vals),
  },
  landbackV1: {
    get: () => getLandbackV1Config(),
    set: (vals) => setLandbackV1(vals),
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
  // Per-fin deploy angles (deg, signed, same convention as the fin state:
  // 0 = deployed, L/FB +90 & R -90 = stowed, opposite sign = swung toward the
  // nose). angles = { L?, R?, FB? }; omitted fins keep their current target.
  function cmdGridFinsDeployAngles(angles) {
    return { type: "gridFinsDeploy", angles: Object.assign({}, angles) };
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
  function cmdSetGimbalAccel(degPerSec2, target) {
    const msg = { type: "setGimbalAccel", degPerSec2 };
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

// ASDS (Autonomous Spaceport Drone Ship) — downrange landing platforms.
// deployASDS spawns a new ship at arcOffsetM (metres east of the launch pad).
// setASDSPosition moves an existing one. Validation (ocean zone bounds +
// 250 m hull-edge gap) runs in the physics worker.
function cmdDeployASDS(xMeters) {
  return { type: "deployASDS", xMeters };
}
function cmdSetASDSPosition(padId, newXOffsetM) {
  return { type: "setASDSPosition", padId, newXOffsetM };
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
    setLandbackV1,
getLandbackV1Config,
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
    cmdGridFinsDeployAngles,
    cmdGridFinsControl,
    cmdSeparate,
    cmdSplitFairing,
    cmdReleasePayload,
    cmdEmergencyEject,
    cmdTakeControl,
    cmdWarp,
    cmdSetFuelMass,
    cmdSetGimbalRate,
    cmdSetGimbalAccel,
    cmdRcsDuty,
cmdMarkIntentionalImpact,
cmdDeployASDS,
cmdSetASDSPosition,
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
