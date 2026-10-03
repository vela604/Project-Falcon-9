#!/usr/bin/env node
// ============================================================================
// headless/test-diag-hang.js — Diagnose why the insertion block hangs in
// STAGE_BURN after the composed chain starts it.
//
// Logs (every 10 sim-seconds):
//   - block's internal phase
//   - block's own computed apogee
//   - stage engine's target flow rate, actual flow rate, current thrust
//   - stage's current fuel mass
//
// If engMdot stays 0 → throttle command not reaching physics.
// If engMdot > 0 but apogee stalls low → mass/trajectory issue.
// If blockPhase never changes but apogee > 320 → transition condition
//                                              problem in the block.
// ============================================================================

const { runSim } = require('./runner');

const DIAG_GUIDE = `
(function() {
  const M = {
  phase: 'ASCENT',
  ascent: null,
  insertion: null,
  preSplitCount: 0,
  insertionTicks: 0,
  splitDetected: false,
  fairingOpened: false,
  stageIdx: 0,
};

  function _send(cmd) { if (cmd) Guidance.send(cmd); }

  const chainGuide = function(snapshot) {
    const simT = snapshot.simTime;

    // ---- Mission-level fairing auto-open (phase-independent) ----
    // Mirrors V2's independent fairing check. Runs every tick, from the
    // moment split is detected until the fairing opens. Without this,
    // the fairing's ~1900 kg stays on the stage and the burn can't
    // reach its target apogee.
    if (!M.fairingOpened && M.splitDetected && M.stageIdx >= 0) {
      const stageBody = snapshot.bodies[M.stageIdx];
      if (stageBody) {
        const altKm = (Math.hypot(stageBody.rx, stageBody.ry) - CONFIG.EARTH_RADIUS) / 1000;
        if (altKm >= 80) {
          const hasFairing = stageBody.members &&
            stageBody.members.some(mm => mm && mm.stageRole === 'payloadSpace');

          if (M.splitDetected && !M.__diagPrinted) {
  M.__diagPrinted = true;
  const b0 = snapshot.bodies[0];
  const b1 = snapshot.bodies[1];
  console.error('[DIAG-SPLIT] t=' + simT.toFixed(4) +
    ' stageIdx=' + M.stageIdx +
    ' b0.role=' + (b0 && b0.members && b0.members[0] ? b0.members[0].stageRole : '?') +
    ' b0.alt=' + (b0 ? ((Math.hypot(b0.rx, b0.ry) - 6371000)/1000).toFixed(2) : '?') +
    ' b0.isActive=' + (b0 ? b0.isActive : '?') +
    ' b1.role=' + (b1 && b1.members && b1.members[0] ? b1.members[0].stageRole : '?') +
    ' b1.alt=' + (b1 ? ((Math.hypot(b1.rx, b1.ry) - 6371000)/1000).toFixed(2) : '?') +
    ' b1.isActive=' + (b1 ? b1.isActive : '?'));
}

          
          if (hasFairing) {
            const cmd = Guidance.cmdSplitFairing();
            cmd.targetBodyIdx = M.stageIdx;
            Guidance.send(cmd);
            M.fairingOpened = true;
            console.error('[DIAG] fairing open at t=' + simT.toFixed(4) + ' alt=' + altKm.toFixed(2));
          }
        }
      }
    }

    switch (M.phase) {
      case 'ASCENT': {
        if (!M.ascent) {
          M.ascent = FUNDAMENTAL_BLOCKS.ascent.createInstance();
          M.ascent.start(FUNDAMENTAL_BLOCKS.ascent.defaultConstants, 0, {});
        }
        M.ascent.tick(snapshot);
        if (M.ascent.isDone()) {
          M.preSplitCount = snapshot.bodies.length;
          M.phase = 'WAIT_SPLIT';
        }
        break;
      }
      case 'WAIT_SPLIT': {
  if (snapshot.bodies.length > M.preSplitCount) {
    M.splitDetected = true;
    // In F9 stacks, the stage is always the retained active body
    // (index 0); the discarded booster is pushed to index 1.
    M.stageIdx = 0;
    M.phase = 'SEPARATED_AXIAL';
  }
  break;
}
      case 'SEPARATED_AXIAL': {
        const boosterBody = snapshot.bodies[1];
        const stageBody = snapshot.bodies[0];
        if (!boosterBody || !stageBody) { M.phase = 'INSERTION'; break; }
        const bd = GuideRCS.postSeparationAxialDuty(snapshot, 1, 'dn');
        if (bd) _send(Guidance.cmdRcsDuty(bd, 1));
        const sd = GuideRCS.postSeparationAxialDuty(snapshot, 0, 'up');
        if (sd) _send(Guidance.cmdRcsDuty(sd, 0));
        const bH = (boosterBody.members && boosterBody.members[0])
          ? (boosterBody.members[0].height || 0) : 0;
        const upX = -Math.sin(stageBody.theta);
        const upY = Math.cos(stageBody.theta);
        const dx = stageBody.rx - boosterBody.rx;
        const dy = stageBody.ry - boosterBody.ry;
        const gap = Math.max(0, (dx * upX + dy * upY) - bH);
        if (gap >= 10) {
          _send(Guidance.cmdRcsDuty(null, 0));
          _send(Guidance.cmdRcsDuty(null, 1));
          M.insertion = FUNDAMENTAL_BLOCKS.insertion.createInstance();
          M.insertion.start(FUNDAMENTAL_BLOCKS.insertion.defaultConstants, 0, {});
          M.insertionTicks = 0;
          M.phase = 'INSERTION';
          console.error('[DIAG] insertion.start t=' + simT.toFixed(4));
        }
        break;
      }
      case 'INSERTION': {
        M.insertion.tick(snapshot);
        M.insertionTicks++;
        if (M.insertionTicks % 800 === 0) {
          const ins = M.insertion.getStatus();
          const stage = snapshot.bodies[0];
          const eng = stage && stage.engines ? stage.engines[0] : null;
          console.error('[DIAG] t=' + simT.toFixed(2) +
            ' phase=' + ins.phase +
            ' apogee=' + (ins.apogeeKm != null && isFinite(ins.apogeeKm)
                          ? ins.apogeeKm.toFixed(2) : 'n/a') +
            ' tgtFlow=' + (eng ? (eng.targetMassFlowRate || 0).toFixed(1) : 'n/a') +
            ' mdot=' + (eng ? (eng.massFlowRate || 0).toFixed(1) : 'n/a') +
            ' F=' + (eng ? Math.round(eng.currentF || 0) : 'n/a') +
            ' fuelKg=' + (stage ? Math.round(stage.fuelMass || 0) : '?'));
        }
        if (M.insertion.isDone()) {
          console.error('[DIAG] insertion.isDone at t=' + simT.toFixed(4));
          M.phase = 'DONE';
        }
        break;
      }
      case 'DONE': break;
    }
  };

  chainGuide.start = function() {
  M.phase = 'ASCENT';
  M.ascent = null;
  M.insertion = null;
  M.preSplitCount = 0;
  M.insertionTicks = 0;
  M.splitDetected = false;
  M.fairingOpened = false;
  M.stageIdx = 0;
};
  chainGuide.stop = function() {
    if (M.ascent) M.ascent.stop();
    if (M.insertion) M.insertion.stop();
  };
  chainGuide.getStatus = function() {
    const out = { phase: M.phase };
    if ((M.phase === 'INSERTION' || M.phase === 'DONE') && M.insertion) {
      out.insertionPhase = M.insertion.getStatus().phase;
    }
    return out;
  };

  Guidance._registerTestGuide('_diag', chainGuide);
})();
`;

const warm = runSim({ durationS: 0.001, quiet: true, extraBootstrapCode: DIAG_GUIDE });
const sim = warm.sim;
sim.reset(0);
sim.setEnvironment({
  atmosphere: true, slosh: true, imu: false,
  wind: { enabled: false, speed: 0, directionDeg: 0 },
});
sim.setFueling(100, 100);
sim.startGuide('_diag');

const dt = sim.CONFIG.DT;
const maxTicks = Math.ceil(700 / dt);
for (let i = 0; i < maxTicks; i++) {
  sim.step(1);
  if (sim.state.halted) break;
}
console.error('[DIAG] run complete.');