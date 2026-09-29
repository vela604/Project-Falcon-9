#!/usr/bin/env node
// ============================================================================
// headless/bisect-push.js — bisection over PUSH_MAX_GIMBAL_DEG.
//
// Condition for success: MECO fires (apogee >= 150 km) while the body tilt
// (θ − local vertical) is in [55°, 60°].
//
//   Too much turn → MECO never fires (crash, tilt past 90°) → lower hi
//   Too little turn → MECO fires at tilt < 55° → raise lo
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const DURATION_S = 160;
const TARGET_LO = 59.5;
const TARGET_HI = 60.5;
const MAX_ITER = 12;
const MIN_BRACKET = 0.0005;

function runOne(pd) {
  const warm = runSim({ durationS: 0.05, quiet: true });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({ atmosphere: true, slosh: true, imu: false });
  sim.applyTunables('leoInsertionV2', [
    { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: pd },
  ]);
  sim.setFueling(100, 100);
  sim.startGuide('leoInsertionV2');

  const dt = sim.CONFIG.DT;
  const totalTicks = Math.ceil(DURATION_S / dt);
  const CHUNK = 40; // 0.5s granularity on phase change detection

  let mecoTiltDeg = null;
  let mecoApogeeKm = null;
  let mecoSimTime = null;
  let prevPhase = null;

  for (let i = 0; i < totalTicks; i += CHUNK) {
    sim.step(Math.min(CHUNK, totalTicks - i));
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const ph = gs.phase;

    if (prevPhase === 'ASCENT' && ph === 'MECO_SPOOL') {
      const a = st.bodies.find(b => b.isActive) || st.bodies[0];
      const rr = Math.hypot(a.rx, a.ry) || 1;
      const localVert = Math.atan2(-a.rx, a.ry);
      mecoTiltDeg = (a.theta - localVert) * 180 / Math.PI;
      mecoApogeeKm = Number.isFinite(gs.apogeeKm) ? gs.apogeeKm : 0;
      mecoSimTime = st.simTime;
    }
    prevPhase = ph;
    if (st.crashed) break;
  }

  const st = sim.getStatus();
  const gs = st.guideStatus || {};
  const a = st.bodies.find(b => b.isActive) || st.bodies[0];
  const rr = Math.hypot(a.rx, a.ry) || 1;
  const localVert = Math.atan2(-a.rx, a.ry);
  const finalTilt = (a.theta - localVert) * 180 / Math.PI;
  sim.stopGuide();

  return {
    pd,
    mecoFired: mecoTiltDeg !== null,
    mecoTiltDeg,
    mecoApogeeKm,
    mecoSimTime,
    finalPhase: gs.phase || '?',
    finalTilt,
    finalAltKm: a.altitudeKm,
    crashed: st.crashed,
    simTime: st.simTime,
  };
}

console.log('=== bisection: PUSH_MAX_GIMBAL_DEG ===');
console.log('target: MECO fires with tilt in [' + TARGET_LO + ', ' + TARGET_HI + ']deg');
console.log('duration per eval: ' + DURATION_S + 's');
console.log('');

// Old "0.09312 → 60°" was a t=180s final tilt, NOT a MECO tilt — that
// reading was taken during STAGE_BURN after MECO+separation. Real MECO
// tilt at 0.09148 is 52.4°, at 0.08984 is 51.2°. Slope ≈ 0.0015 pd per
// 1° of MECO tilt. So 55° needs ≈ 0.095, 60° needs ≈ 0.102. Setting
// bracket to [0.09148, 0.12] to let bisection walk up.
// Bracket from prior two bisections:
//   0.09576 → MECO tilt  55.26°   (converged lo point)
//   0.10005 → MECO tilt  58.20°
//   0.10861 → MECO tilt  63.80°
// Slope in this range ≈ 685°/unit. 60° lands between 0.100 and 0.109.
let lo = 0.10005;   // tested: MECO tilt = 58.20°
let hi = 0.10861;   // tested: MECO tilt = 63.80°
let iter = 0;
let best = null;
const trace = [];

while (iter < MAX_ITER && (hi - lo) > MIN_BRACKET) {
  iter++;
  const mid = (lo + hi) / 2;
  const r = runOne(mid);
  trace.push(r);

  // Decision is based on TILT MAGNITUDE, not crash flag. A run that
// doesn't MECO and doesn't crash can still be over-turned — e.g.
// pd=0.12 gave tilt=-72° with no crash inside 180 s, which is clearly
// past the 60° ceiling and needs less turn. The old code looked only
// at `crashed` in the no-MECO branch, so it always raised `lo`,
// pushing the bracket the wrong way.
//
//   |tilt| < 55°  → not enough turn → raise lo
//   |tilt| > 60°  → too much turn   → lower hi
//   |tilt| ∈ [55, 60] AND MECO fired → converged
const tiltForDecision = r.mecoFired
  ? Math.abs(r.mecoTiltDeg)
  : Math.abs(r.finalTilt);
const mtSigned = r.mecoFired ? r.mecoTiltDeg : r.finalTilt;
let action, reason;

if (r.mecoFired && tiltForDecision >= TARGET_LO && tiltForDecision <= TARGET_HI) {
  best = r;
  action = 'CONVERGED';
  reason = 'MECO at tilt ' + mtSigned.toFixed(1) + 'deg IN RANGE';
} else if (tiltForDecision > TARGET_HI) {
  hi = mid;
  action = 'hi=mid';
  reason = (r.mecoFired ? 'MECO' : 'no MECO') + ' at tilt ' +
    mtSigned.toFixed(1) + 'deg (> ' + TARGET_HI + ' over-turned)';
} else {
  lo = mid;
  action = 'lo=mid';
  reason = (r.mecoFired ? 'MECO' : 'no MECO') + ' at tilt ' +
    mtSigned.toFixed(1) + 'deg (< ' + TARGET_LO + ' under-turned)';
}

  const mecoStr = r.mecoFired
  ? 'MECO@' + r.mecoTiltDeg.toFixed(1).padStart(6) + 'deg apo=' + r.mecoApogeeKm.toFixed(1).padStart(6) + 'km t=' + r.mecoSimTime.toFixed(1).padStart(6) + 's'
  : 'no MECO                    ';
  const finalStr = r.finalPhase.padEnd(12) + ' tilt=' + r.finalTilt.toFixed(1).padStart(7) + 'deg cr=' + (r.crashed ? 'Y' : 'N');

  console.log(
    '#' + String(iter).padStart(2) +
    '  pd=' + mid.toFixed(5) +
    '  ' + mecoStr +
    '  final: ' + finalStr +
    '  | ' + action.padEnd(11) + ' (' + reason + ')'
  );
  console.log('     bracket: [' + lo.toFixed(5) + ', ' + hi.toFixed(5) + ']');

  if (best) break;
}

console.log('');
if (best) {
  console.log('--- CONVERGED ---');
  console.log('PUSH_MAX_GIMBAL_DEG = ' + best.pd.toFixed(5));
  console.log('  tilt @ MECO     = ' + best.mecoTiltDeg.toFixed(2) + ' deg');
  console.log('  apogee @ MECO   = ' + best.mecoApogeeKm.toFixed(2) + ' km');
  console.log('  sim time @ MECO = ' + best.mecoSimTime.toFixed(2) + ' s');
} else {
  console.log('--- NO EXACT CONVERGENCE ---');
  console.log('Final bracket: [' + lo.toFixed(5) + ', ' + hi.toFixed(5) + ']');
  console.log('Final range width: ' + (hi - lo).toFixed(5));
  // Report the two bracket endpoints so user sees the range.
  const rLo = trace.find(x => Math.abs(x.pd - lo) < 1e-6) || trace[trace.length - 1];
  const rHi = trace.find(x => Math.abs(x.pd - hi) < 1e-6) || trace[trace.length - 1];
  if (rLo.mecoFired) console.log('  lo=' + lo.toFixed(5) + ': MECO tilt = ' + rLo.mecoTiltDeg.toFixed(1) + 'deg');
  if (rHi.mecoFired) console.log('  hi=' + hi.toFixed(5) + ': MECO tilt = ' + rHi.mecoTiltDeg.toFixed(1) + 'deg');
}

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bisect-push-' + Date.now() + '.json');
fs.writeFileSync(outFile, JSON.stringify({ trace, best, finalBracket: [lo, hi] }, null, 2));
console.log('');
console.log('saved: ' + outFile);