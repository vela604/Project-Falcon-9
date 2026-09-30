#!/usr/bin/env node
// ============================================================================
// headless/bisect-push-for-90.js — bisect PUSH_MAX_GIMBAL_DEG with
// STAGE_BURN_LOCK_TILT_DEG pinned at 90° (max orbital efficiency).
//
// Strategy: 90° tilt-lock puts ALL stage-burn thrust into horizontal
// velocity — zero gravity loss during the burn. But it also means zero
// vertical support, so radial velocity decays throughout the burn. The
// limiting PUSH value is the LARGEST one where vr still stays above the
// floor through STAGE_BURN. Larger PUSH → more aggressive gravity turn
// during ascent → less vr remaining → tighter margin at 90°.
//
//   vr <= 0.5 at any tick → FAIL (PUSH too aggressive) → hi = mid
//   vr slope turns positive (local min reached) → PASS → lo = mid
//   900 s elapsed without either → PASS (never dipped)
//
// Converged value = max safe PUSH at 90°. Higher PUSH is more efficient
// ascent (more gravity turn) but breaks the vr floor.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const TILT_LOCK_FIXED = 89.999;
const VR_FLOOR = 0.001;
const STAGE_BURN_TIMEOUT_S = 900;
const TOTAL_SIM_S = 700;
const CHUNK_TICKS = 8;

function runOne(pushVal) {
  const warm = runSim({ durationS: 0.05, quiet: true });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({ atmosphere: true, slosh: true, imu: false });
  sim.applyTunables('leoInsertionV2', [
    { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: pushVal },
    { path: 'STAGE_BURN_LOCK_TILT_DEG',   value: TILT_LOCK_FIXED },
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
  let mecoTiltDeg = null;
  let mecoSimT = null;
  let exitReason = null;
  let prevPhase = null;

  for (let i = 0; i < totalTicks; i += CHUNK_TICKS) {
    sim.step(Math.min(CHUNK_TICKS, totalTicks - i));
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const phase = gs.phase;
    const a = st.bodies.find(b => b.isActive) || st.bodies[0];
    if (!a) { exitReason = 'no-body'; break; }

    if (prevPhase === 'ASCENT' && phase === 'MECO_SPOOL' && mecoSimT === null) {
      const rr = Math.hypot(a.rx, a.ry) || 1;
      const lv = Math.atan2(-a.rx, a.ry);
      mecoTiltDeg = (a.theta - lv) * 180 / Math.PI;
      mecoSimT = st.simTime;
    }
    prevPhase = phase;

    const rr = Math.hypot(a.rx, a.ry) || 1;
    const vr = (a.vx * a.rx + a.vy * a.ry) / rr;

    if (phase === 'STAGE_BURN' && stageBurnStartT === null) {
      stageBurnStartT = st.simTime;
    }

    if (phase === 'STAGE_BURN') {
      if (vr < minVr) { minVr = vr; minVrAtT = st.simTime; }
      if (vr <= VR_FLOOR) { exitReason = 'FAIL-vr'; break; }
      if (prevVr !== null) {
        if (vr < prevVr) sawDecrease = true;
        if (sawDecrease && vr > prevVr) { exitReason = 'PAUSE-slope+'; break; }
      }
      prevVr = vr;
      if (st.simTime - stageBurnStartT > STAGE_BURN_TIMEOUT_S) {
        exitReason = 'TIMEOUT-900s'; break;
      }
    } else if (stageBurnStartT !== null) {
      exitReason = 'EXIT-' + phase; break;
    }
    if (st.crashed) { exitReason = 'CRASH'; break; }
  }

  const st = sim.getStatus();
  const gs = st.guideStatus || {};
  sim.stopGuide();

  const fail = exitReason === 'FAIL-vr' || exitReason === 'CRASH' || exitReason === 'no-body';
  return {
    pushVal,
    fail,
    exitReason,
    minVr: Number.isFinite(minVr) ? minVr : null,
    minVrAtT,
    mecoTiltDeg,
    mecoSimT,
    simTime: st.simTime,
    finalPhase: gs.phase,
    apogeeKm: Number.isFinite(gs.apogeeKm) ? gs.apogeeKm : null,
    perigeeKm: Number.isFinite(gs.perigeeKm) ? gs.perigeeKm : null,
  };
}

console.log('=== bisect PUSH_MAX_GIMBAL_DEG @ TILT_LOCK = 90° ===');
console.log('vr floor = ' + VR_FLOOR + ' m/s');
console.log('stage burn timeout = ' + STAGE_BURN_TIMEOUT_S + ' s');
console.log('');

let lo = 0.067;   // no east kick — near-vertical ascent
let hi = 0.08; // known value at tilt-lock 81.39 — will fail at 90
const PRECISION = 0.00005;
let best = null;
const trace = [];

while ((hi - lo) > PRECISION) {
  const mid = (lo + hi) / 2;
  const r = runOne(mid);
  trace.push(r);

  const mvr = r.minVr != null ? r.minVr.toFixed(3) : '—';
  const mvrT = r.minVrAtT != null ? r.minVrAtT.toFixed(1) : '—';
  const mt = r.mecoTiltDeg != null ? r.mecoTiltDeg.toFixed(1) : '—';

  console.log(
    'push=' + mid.toFixed(5) +
    '  ' + (r.fail ? 'FAIL' : 'PASS').padEnd(4) +
    '  reason=' + String(r.exitReason).padEnd(16) +
    '  minVr=' + mvr.padStart(8) + ' @ ' + mvrT.padStart(6) + 's' +
    '  mecoTilt=' + mt.padStart(6) + '°' +
    '  apo=' + (r.apogeeKm != null ? r.apogeeKm.toFixed(1) : '—')
  );

  if (r.fail) {
    hi = mid;
    console.log('    → hi = ' + hi.toFixed(5) + '  (too aggressive at 90°)');
  } else {
    best = r;
    lo = mid;
    console.log('    → lo = ' + lo.toFixed(5) + '  (works at 90°)');
  }
  console.log('    bracket: [' + lo.toFixed(5) + ', ' + hi.toFixed(5) + ']');
  console.log('');
}

console.log('=== RESULT ===');
if (best) {
  console.log('MAX PUSH_MAX_GIMBAL_DEG at TILT_LOCK = 90°: ' + best.pushVal.toFixed(5));
  console.log('  minVr during burn  = ' + best.minVr.toFixed(3) + ' m/s @ t=' + best.minVrAtT.toFixed(1) + 's');
  console.log('  MECO tilt          = ' + (best.mecoTiltDeg != null ? best.mecoTiltDeg.toFixed(1) + '°' : '—'));
  console.log('  MECO at            = ' + (best.mecoSimT != null ? best.mecoSimT.toFixed(1) + 's' : '—'));
  console.log('  apogee             = ' + (best.apogeeKm != null ? best.apogeeKm.toFixed(1) : '—') + ' km');
  console.log('  perigee            = ' + (best.perigeeKm != null ? best.perigeeKm.toFixed(1) : '—') + ' km');
} else {
  console.log('No PASS found in [0.02, 0.09576]. Check assumptions.');
}
console.log('final bracket: [' + lo.toFixed(5) + ', ' + hi.toFixed(5) + ']');

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bisect-push-90-' + Date.now() + '.json');
fs.writeFileSync(outFile, JSON.stringify({ trace, best, finalBracket: [lo, hi] }, null, 2));
console.log('saved: ' + outFile);