#!/usr/bin/env node
// ============================================================================
// headless/test-full-chain.js — Stage 3 verification.
//
// Runs leoInsertionV2 and a block-composed chain (ascent block + mission
// glue + insertion block) side-by-side, and compares the sim-tick at
// which each mission phase is entered.
//
// The test guide mirrors the mission-level glue from V2's tick function:
//   ASCENT (block) → WAIT_SPLIT (mission) → SEPARATED_AXIAL (mission) →
//   INSERTION (block) → DONE (block's internal payload monitor)
//
// Mission phases are mapped to V2's phase names for a direct comparison.
// Any nonzero tick delta is a bug.
// ============================================================================

const { runSim } = require("./runner");

// ---- The composed test guide, injected as extraBootstrapCode ----
const CHAIN_GUIDE = `
(function() {
  const M = {
  phase: 'ASCENT',
  ascent: null,
  insertion: null,
  suicide: null,
  preSplitBodyCount: 0,
  preSplitBodyId: null,
  splitDetected: false,
  fairingOpened: false,
  stageIdx: -1,
  boosterIdx: -1,
  insertionResult: null,
  deployCmdSimTime: null,
  suicideStartT: null,
  suicideResult: null,
};
const SUICIDE_DELAY_AFTER_DEPLOY_S = 60;
const CIRC_ATT_KP_M = 0.5;
const CIRC_ATT_KD_M = 4.0;

  const SPLIT_TARGET_M = 10;
  const SPLIT_TIMEOUT_S = 10;

  function _send(cmd) { if (cmd) Guidance.send(cmd); }

  const chainGuide = function(snapshot) {
  const simT = snapshot.simTime;

  // ---- Mission-level fairing auto-open (phase-independent) ----
  if (!M.fairingOpened && M.splitDetected && M.stageIdx >= 0) {
    const stageBody = snapshot.bodies[M.stageIdx];
    if (stageBody) {
      const altKm = (Math.hypot(stageBody.rx, stageBody.ry) - 6371000) / 1000;
      if (altKm >= 80) {
        const hasFairing = stageBody.members &&
          stageBody.members.some(mm => mm && mm.stageRole === 'payloadSpace');
        if (hasFairing) {
          const cmd = Guidance.cmdSplitFairing();
          cmd.targetBodyIdx = M.stageIdx;
          Guidance.send(cmd);
          M.fairingOpened = true;
        }
      }
    }
  }

  switch (M.phase) {

      case 'ASCENT': {
        if (!M.ascent) {
          M.ascent = FUNDAMENTAL_BLOCKS.ascent.createInstance();
          M.ascent.start(FUNDAMENTAL_BLOCKS.ascent.defaultConstants, 0, {});
          M.preSplitBodyId = snapshot.bodies[0] ? snapshot.bodies[0].id : null;
        }
        M.ascent.tick(snapshot);
        if (M.ascent.isDone()) {
          M.preSplitBodyCount = snapshot.bodies.length;
          M.phase = 'WAIT_SPLIT';
        }
        break;
      }

      case 'WAIT_SPLIT': {
  if (snapshot.bodies.length > M.preSplitBodyCount) {
    // In F9 stacks the stage is the retained active body (idx 0);
    // the discarded booster is pushed to the end.
    M.stageIdx = 0;
    const boosterIdx = snapshot.bodies.findIndex((b, i) =>
      i !== M.stageIdx && b && !b.isActive);
    M.boosterIdx = boosterIdx >= 0 ? boosterIdx : 1;
    M.splitDetected = true;
    M.phase = 'SEPARATED_AXIAL';
  }
  break;
}

      case 'SEPARATED_AXIAL': {
        const boosterBody = snapshot.bodies[M.boosterIdx];
        const stageBody = snapshot.bodies[M.stageIdx];
        if (!boosterBody || !stageBody) { M.phase = 'INSERTION'; break; }

        const boosterDuties = GuideRCS.postSeparationAxialDuty(snapshot, M.boosterIdx, 'dn');
        if (boosterDuties) _send(Guidance.cmdRcsDuty(boosterDuties, M.boosterIdx));
        const stageDuties = GuideRCS.postSeparationAxialDuty(snapshot, M.stageIdx, 'up');
        if (stageDuties) _send(Guidance.cmdRcsDuty(stageDuties, M.stageIdx));

        const boosterHeight = (boosterBody.members && boosterBody.members[0])
          ? (boosterBody.members[0].height || 0) : 0;
        const upX = -Math.sin(stageBody.theta);
        const upY = Math.cos(stageBody.theta);
        const dx = stageBody.rx - boosterBody.rx;
        const dy = stageBody.ry - boosterBody.ry;
        const axialGap = Math.max(0, (dx * upX + dy * upY) - boosterHeight);

        if (axialGap >= SPLIT_TARGET_M) {
          _send(Guidance.cmdRcsDuty(null, M.stageIdx));
          _send(Guidance.cmdRcsDuty(null, M.boosterIdx));
          M.insertion = FUNDAMENTAL_BLOCKS.insertion.createInstance();
          M.insertion.start(FUNDAMENTAL_BLOCKS.insertion.defaultConstants, M.stageIdx, {});
          M.phase = 'INSERTION';
        }
        break;
      }

          case 'INSERTION': {
      const insSt = M.insertion.getStatus();
      if (M.deployCmdSimTime == null && insSt.deployCommandSimTime != null) {
        M.deployCmdSimTime = insSt.deployCommandSimTime;
      }
      M.insertion.tick(snapshot);
      if (M.insertion.isDone()) {
        M.insertionResult = M.insertion.getResult();
        if (M.deployCmdSimTime == null && M.insertionResult) {
          M.deployCmdSimTime = M.insertionResult.deployCommandSimTime;
        }
        M.phase = 'MISSION_DWELL';
      }
      break;
    }

    case 'MISSION_DWELL': {
      // Mission-level attitude hold during the pre-deorbit dwell.
      // Uses the target theta captured by the insertion block.
      const stageBody = snapshot.bodies[M.stageIdx];
      if (stageBody) {
        const targetTheta = M.insertionResult
          ? M.insertionResult.coast2TargetThetaInertial : null;
        if (targetTheta != null) {
          const dNext = Derivation.derive(snapshot, M.stageIdx);
          const I = (dNext && dNext.massProps) ? dNext.massProps.I : 0;
          if (I > 0) {
            let thetaErr = stageBody.theta - targetTheta;
            while (thetaErr > Math.PI) thetaErr -= 2 * Math.PI;
            while (thetaErr < -Math.PI) thetaErr += 2 * Math.PI;
            const tau = -I * (CIRC_ATT_KP_M * thetaErr + CIRC_ATT_KD_M * stageBody.omega);
            const rr = GuideRCS.targetTorqueRcsNoNetForce(snapshot, tau, M.stageIdx);
            if (rr && rr.fires.length) _send(Guidance.cmdRcsDuty(rr.duties, M.stageIdx));
            else _send(Guidance.cmdRcsDuty(null, M.stageIdx));
          }
        }
      }
      _send(Guidance.cmdSetAllThrottle(0));
      _send(Guidance.cmdSetGimbalRate(0));

      const elapsed = simT - (M.deployCmdSimTime != null ? M.deployCmdSimTime : simT);
      if (elapsed >= SUICIDE_DELAY_AFTER_DEPLOY_S) {
        _send(Guidance.cmdRcsDuty(null, M.stageIdx));
        const markCmd = Guidance.cmdMarkIntentionalImpact(M.stageIdx);
        _send(markCmd);
        M.suicide = FUNDAMENTAL_BLOCKS.suicide.createInstance();
        M.suicide.start(FUNDAMENTAL_BLOCKS.suicide.defaultConstants, M.stageIdx, {});
        M.suicideStartT = simT;
        M.phase = 'SUICIDE';
      }
      break;
    }

    case 'SUICIDE': {
      M.suicide.tick(snapshot);
      if (M.suicide.isDone()) {
        M.suicideResult = M.suicide.getResult();
        M.phase = 'SUICIDE_END';
      }
      break;
    }

    case 'SUICIDE_END': break;
  }
};

  chainGuide.start = function() {
  M.phase = 'ASCENT';
  M.ascent = null;
  M.insertion = null;
  M.suicide = null;
  M.preSplitBodyCount = 0;
  M.preSplitBodyId = null;
  M.splitDetected = false;
  M.fairingOpened = false;
  M.stageIdx = -1;
  M.boosterIdx = -1;
  M.insertionResult = null;
  M.deployCmdSimTime = null;
  M.suicideStartT = null;
  M.suicideResult = null;
};

  chainGuide.stop = function() {
    if (M.ascent) M.ascent.stop();
    if (M.insertion) M.insertion.stop();
    M.ascent = null;
    M.insertion = null;
  };

  chainGuide.getStatus = function() {
    const out = { phase: M.phase, stageIdx: M.stageIdx, boosterIdx: M.boosterIdx };
    if (M.phase === 'ASCENT' && M.ascent) {
      const as = M.ascent.getStatus();
      out.ascentPhase = as.ascentPhase;
      out.mecoTriggered = as.mecoTriggered;
    }
      if ((M.phase === 'INSERTION' || M.phase === 'MISSION_DWELL' ||
       M.phase === 'SUICIDE' || M.phase === 'SUICIDE_END') && M.insertion) {
    const ins = M.insertion.getStatus();
    out.insertionPhase = ins.phase;
    out.circAchieved = ins.circAchieved;
    out.payloadCleared = ins.payloadCleared;
  }
  if ((M.phase === 'SUICIDE' || M.phase === 'SUICIDE_END') && M.suicide) {
    out.suicidePhase = M.suicide.getStatus().phase;
  }
  return out;
};

  Guidance._registerTestGuide('_test_fullChain', chainGuide);
})();
`;

// Map test-guide's layered status to V2's phase names.
function mapTestPhase(gs) {
  if (gs.phase === 'ASCENT') return 'ASCENT';
  if (gs.phase === 'WAIT_SPLIT') return 'MECO_SPOOL';
  if (gs.phase === 'SEPARATED_AXIAL') return 'SEPARATED_AXIAL';
  if (gs.phase === 'INSERTION' || gs.phase === 'MISSION_DWELL') {
    return gs.insertionPhase || '?';
  }
  if (gs.phase === 'SUICIDE' || gs.phase === 'SUICIDE_END') {
    return gs.suicidePhase || '?';
  }
  return gs.phase;
}

function runTimeline(guideName, extraCode, durationS) {
  const warm = runSim({
    durationS: 0.001,
    quiet: true,
    extraBootstrapCode: extraCode,
  });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({
    atmosphere: true,
    slosh: true,
    imu: false,
    wind: { enabled: false, speed: 0, directionDeg: 0 },
  });
  sim.setFueling(100, 100);
  const ok = sim.startGuide(guideName);
  if (!ok) throw new Error("startGuide failed: " + guideName);

  const dt = sim.CONFIG.DT;
  const maxTicks = Math.ceil(durationS / dt);
  const timeline = [];
  let lastMapped = null;

  for (let i = 0; i < maxTicks; i++) {
    sim.step(1);
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const mapped =
      guideName === "leoInsertionV2" ? gs.phase || "?" : mapTestPhase(gs);
    if (mapped !== lastMapped) {
      timeline.push({ t: st.simTime, phase: mapped });
      lastMapped = mapped;
    }
    // Stop when SUICIDE_COAST reached (end of suicide block) OR run
// duration exceeded. Previously broke at DONE — but the test chain
// now runs SUICIDE too, so we need to keep going through DONE and
// MISSION_DWELL to reach the suicide phases.
if (mapped === 'SUICIDE_COAST') break;
  }
  return timeline;
}

console.log("");
console.log("Stage 3 — Full chain verification");
console.log("===================================");
console.log("");

const DUR = 1500;

console.log("Running V2 (up to " + DUR + "s)...");
const v2 = runTimeline("leoInsertionV2", undefined, DUR);
console.log("  captured " + v2.length + " phase entries");

console.log("Running block chain (up to " + DUR + "s)...");
const test = runTimeline("_test_fullChain", CHAIN_GUIDE, DUR);
console.log("  captured " + test.length + " phase entries");
console.log("");

const PHASES = [
  'ASCENT', 'MECO_SPOOL', 'SEPARATED_AXIAL',
  'STAGE_BURN', 'RCS_BOOST', 'COAST_ROTATE', 'COAST_WAIT',
  'COAST_HOLD', 'CIRCULARIZE', 'COAST_ROTATE_2', 'COAST_HOLD_2', 'DONE',
  'SUICIDE_ROTATE', 'SUICIDE_BURN', 'SUICIDE_COAST',
];

function entryTime(timeline, phase) {
  for (const e of timeline) if (e.phase === phase) return e.t;
  return null;
}

let fails = 0;
console.log("Phase                    | V2 entry  | Test entry | Δ ticks");
console.log("-------------------------|-----------|------------|--------");
for (const ph of PHASES) {
  const tV2 = entryTime(v2, ph);
  const tT = entryTime(test, ph);
  if (tV2 === null && tT === null) continue;
  if (tV2 === null || tT === null) {
    console.log(
      ph.padEnd(24) +
        " | " +
        (tV2 === null ? "    —    " : tV2.toFixed(4).padStart(8)) +
        " | " +
        (tT === null ? "    —    " : tT.toFixed(4).padStart(8)) +
        " | " +
        (tV2 === null ? "test only" : "V2 only"),
    );
    fails++;
    continue;
  }
  const dTicks = Math.round((tT - tV2) * 80);
  const ok = dTicks === 0;
  console.log(
    ph.padEnd(24) +
      " | " +
      tV2.toFixed(4).padStart(8) +
      " | " +
      tT.toFixed(4).padStart(8) +
      " | " +
      (
        (ok ? "  0" : dTicks > 0 ? " +" + dTicks : " " + dTicks) +
        (ok ? "" : "  ✗")
      ).padStart(7),
  );
  if (!ok) fails++;
}

console.log("");
if (fails === 0) {
  console.log("✓ ALL phases match bit-exactly.");
  process.exit(0);
} else {
  console.log("✗ " + fails + " phase(s) diverged.");
  process.exit(1);
}
