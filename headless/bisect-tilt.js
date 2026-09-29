#!/usr/bin/env node
// ============================================================================
// headless/bisect-tilt.js — bisection over STAGE_BURN_LOCK_TILT_DEG.
//
// Fixes PUSH_MAX_GIMBAL_DEG = 0.09576 (bracket-lo from previous bisection).
// Monitors radial velocity vr during STAGE_BURN only.
//
//   FAIL:    vr <= 0.5 at any tick during STAGE_BURN
//   PAUSE:   vr slope turns positive after at least one decrease
//   TIMEOUT: 900s elapsed inside STAGE_BURN without fail or pause
//   EXIT:    phase leaves STAGE_BURN naturally (cutoff) → also a success
//
// Bisection: find the LARGEST tilt lock value where the candidate passes.
// Larger tilt = thrust more horizontal = higher orbit efficiency, but
// faster vr depletion (less vertical thrust support).
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const PUSH_FIXED = 0.09576;
const VR_FLOOR = 0.5;
const STAGE_BURN_TIMEOUT_S = 900;   // protocol says 900s — keep the ceiling
const TOTAL_SIM_S = 700;            // observed minVr ~440s; 700 covers it with margin
const CHUNK_TICKS = 8;      // 0.1s granularity

function runOne(tiltLockDeg) {
  const warm = runSim({ durationS: 0.05, quiet: true });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({ atmosphere: true, slosh: true, imu: false });
  sim.applyTunables('leoInsertionV2', [
    { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: PUSH_FIXED },
    { path: 'STAGE_BURN_LOCK_TILT_DEG',   value: tiltLockDeg },
  ]);
  sim.setFueling(100, 100);
  sim.startGuide('leoInsertionV2');

  const dt = sim.CONFIG.DT;
  const totalTicks = Math.ceil(TOTAL_SIM_S / dt);

  let stageBurnStartT = null;
  let prevVr = null;
  let sawDecrease = false;
  let minVr = Infinity;
  let minVrAtT = null;
  let exitReason = null;
  let stageBurnEndT = null;

  for (let i = 0; i < totalTicks; i += CHUNK_TICKS) {
    sim.step(Math.min(CHUNK_TICKS, totalTicks - i));
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const phase = gs.phase;
    const a = st.bodies.find(b => b.isActive) || st.bodies[0];
    if (!a) { exitReason = 'no-body'; break; }

    const rr = Math.hypot(a.rx, a.ry) || 1;
    const vr = (a.vx * a.rx + a.vy * a.ry) / rr;

    if (phase === 'STAGE_BURN' && stageBurnStartT === null) {
      stageBurnStartT = st.simTime;
    }

    if (phase === 'STAGE_BURN') {
      if (vr < minVr) { minVr = vr; minVrAtT = st.simTime; }

      if (vr <= VR_FLOOR) { exitReason = 'FAIL-vr'; stageBurnEndT = st.simTime; break; }

      if (prevVr !== null) {
        if (vr < prevVr) sawDecrease = true;
        if (sawDecrease && vr > prevVr) {
          exitReason = 'PAUSE-slope+';
          stageBurnEndT = st.simTime;
          break;
        }
      }
      prevVr = vr;

      if (st.simTime - stageBurnStartT > STAGE_BURN_TIMEOUT_S) {
        exitReason = 'TIMEOUT-900s';
        stageBurnEndT = st.simTime;
        break;
      }
    } else if (stageBurnStartT !== null) {
      exitReason = 'EXIT-' + phase;
      stageBurnEndT = st.simTime;
      break;
    }

    if (st.crashed) { exitReason = 'CRASH'; stageBurnEndT = st.simTime; break; }
  }

  const st = sim.getStatus();
  const gs = st.guideStatus || {};
  sim.stopGuide();

  const fail = exitReason === 'FAIL-vr' || exitReason === 'CRASH' || exitReason === 'no-body';
  return {
    tiltLockDeg,
    fail,
    exitReason,
    minVr: Number.isFinite(minVr) ? minVr : null,
    minVrAtT,
    stageBurnStartT,
    stageBurnEndT,
    simTime: st.simTime,
    finalPhase: gs.phase,
    apogeeKm: Number.isFinite(gs.apogeeKm) ? gs.apogeeKm : null,
    perigeeKm: Number.isFinite(gs.perigeeKm) ? gs.perigeeKm : null,
  };
}

console.log('=== bisect STAGE_BURN_LOCK_TILT_DEG ===');
console.log('PUSH_MAX_GIMBAL_DEG fixed = ' + PUSH_FIXED);
console.log('VR floor = ' + VR_FLOOR + ' m/s');
console.log('Stage burn timeout = ' + STAGE_BURN_TIMEOUT_S + ' s');
console.log('Total sim = ' + TOTAL_SIM_S + ' s per eval');
console.log('');

// Bracket from prior 0.5° run: 81.27 PASS (minVr 6.75), 81.58 FAIL (minVr 0.48).
// Narrow bisect to find the true edge where minVr ≈ 0.5.
let lo = 81.27;
let hi = 81.58;
const PRECISION = 0.05;
let best = null;
const trace = [];

while ((hi - lo) > PRECISION) {
  const mid = (lo + hi) / 2;
  const r = runOne(mid);
  trace.push(r);

  const mvr = r.minVr != null ? r.minVr.toFixed(3) : '—';
  const mvrT = r.minVrAtT != null ? r.minVrAtT.toFixed(1) : '—';

  console.log(
    'tilt=' + mid.toFixed(2).padStart(6) +
    '  ' + (r.fail ? 'FAIL' : 'PASS').padEnd(4) +
    '  reason=' + String(r.exitReason).padEnd(16) +
    '  minVr=' + mvr.padStart(8) + ' @ ' + mvrT.padStart(6) + 's' +
    '  finalPhase=' + String(r.finalPhase).padEnd(14) +
    '  apo=' + (r.apogeeKm != null ? r.apogeeKm.toFixed(1) : '—') +
    '  peri=' + (r.perigeeKm != null ? r.perigeeKm.toFixed(1) : '—')
  );

  if (r.fail) {
    hi = mid;
    console.log('    → hi = ' + hi.toFixed(2) + '  (tilt too aggressive)');
  } else {
    best = r;
    lo = mid;
    console.log('    → lo = ' + lo.toFixed(2) + '  (candidate works)');
  }
  console.log('    bracket: [' + lo.toFixed(2) + ', ' + hi.toFixed(2) + ']');
  console.log('');
}

console.log('=== RESULT ===');
if (best) {
  console.log('MAX SAFE STAGE_BURN_LOCK_TILT_DEG = ' + best.tiltLockDeg.toFixed(2));
  console.log('  minVr during burn = ' + best.minVr.toFixed(3) + ' m/s @ t=' + best.minVrAtT.toFixed(1) + 's');
  console.log('  exit reason       = ' + best.exitReason);
  console.log('  apogee            = ' + (best.apogeeKm != null ? best.apogeeKm.toFixed(1) : '—') + ' km');
  console.log('  perigee           = ' + (best.perigeeKm != null ? best.perigeeKm.toFixed(1) : '—') + ' km');
} else {
  console.log('No PASS candidate found in [70, 89.5]. Loosen range or check assumptions.');
}
console.log('final bracket: [' + lo.toFixed(2) + ', ' + hi.toFixed(2) + ']');

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bisect-tilt-' + Date.now() + '.json');
fs.writeFileSync(outFile, JSON.stringify({ trace, best, finalBracket: [lo, hi] }, null, 2));
console.log('saved: ' + outFile);