#!/usr/bin/env node
// ============================================================================
// headless/calibrate-500.js
//
// Two-phase calibration to Δv = 500 m/s circularize.
//
//   Phase 1 — PUSH_MAX_GIMBAL_DEG bisect, values rounded to 2 decimals
//             bracket [0.30, 0.61], PUSH_T_S fixed at 4.8
//
//   Phase 2 — PUSH_T_S bisect, precision 0.02
//             push_max frozen at Phase 1 result
//             bracket found by ±1 s probing from start value (4.8)
//             Phase 1's frozen-push / push_t=4.8 run is REUSED, not re-run.
//
// Direction (both phases): higher push / higher push_t → lower Δv.
//   Δv > 500 → push too low  → raise lo
//   Δv < 500 → push too high → lower hi
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const TILT_LOCK_FIXED = 90.0;
const CIRC_LEAD_FIXED = 1.0;
const DELTA_V_TARGET  = 500.0;
const TOTAL_SIM_S     = 700;
const MAX_ITER        = 40;

const PUSH_LO_INIT    = 0.59;
const PUSH_HI_INIT    = 0.61;
const PUSH_T_INIT     = 4.8;

const CHUNK_FINE = 1;

function round2(x)  { return Math.round(x * 100) / 100; }
function round02(x) { return Math.round(x * 50)  / 50;  }

function runOne(pushVal, pushT) {
  const warm = runSim({ durationS: 0.05, quiet: true });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({ atmosphere: true, slosh: true, imu: false });
  sim.applyTunables('leoInsertionV2', [
    { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: pushVal },
    { path: 'ASCENT.PUSH_T_S',            value: pushT },
    { path: 'STAGE_BURN_LOCK_TILT_DEG',   value: TILT_LOCK_FIXED },
    { path: 'CIRC_TRIGGER_LEAD_S',        value: CIRC_LEAD_FIXED },
  ]);
  sim.setFueling(100, 100);
  sim.startGuide('leoInsertionV2');

  const dt = sim.CONFIG.DT;
  const totalTicks = Math.ceil(TOTAL_SIM_S / dt);

  let deltaV = null, tRem = null, lastPhase = null, crashed = false;
  let captureSimT = null;
  let activeFuelKg = null, stackFuelKg = null;
  let mecoSimT = null, stageBurnSimT = null, coastWaitSimT = null;
  let prevPhase = null;
  let maxQKPa = 0, maxG = 0;

  for (let i = 0; i < totalTicks; i += CHUNK_FINE) {
    sim.step(Math.min(CHUNK_FINE, totalTicks - i));
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const phase = gs.phase;
    lastPhase = phase;

    const ab = st.bodies.find(b => b.isActive) || st.bodies[0];
    if (ab) {
      const ax = ab.accelX || 0, ay = ab.accelY || 0;
      const g = Math.hypot(ax, ay) / 9.80665;
      if (g > maxG) maxG = g;

      // Dynamic pressure Q — same convention as telemetry.js / runner.js
      const rr = Math.hypot(ab.rx, ab.ry);
      const alt = rr - sim.CONFIG.EARTH_RADIUS;
      const rho = (typeof sim.state !== 'undefined' && sim.CONFIG.SEA_LEVEL_DENSITY) ?
        sim.CONFIG.SEA_LEVEL_DENSITY * Math.exp(-Math.max(0, alt) / sim.CONFIG.SCALE_HEIGHT) : 0;
      const w = sim.CONFIG.EARTH_OMEGA || 0;
      const svx = w * ab.ry, svy = -w * ab.rx;
      const relvx = ab.vx - svx;
      const relvy = ab.vy - svy;
      const speed = Math.hypot(relvx, relvy);
      const q = 0.5 * rho * speed * speed / 1000;
      if (q > maxQKPa) maxQKPa = q;
    }

    if (prevPhase !== phase) {
      if (phase === 'MECO_SPOOL' && mecoSimT === null) mecoSimT = st.simTime;
      if (phase === 'STAGE_BURN' && stageBurnSimT === null) stageBurnSimT = st.simTime;
      if (phase === 'COAST_WAIT' && coastWaitSimT === null) coastWaitSimT = st.simTime;
    }
    prevPhase = phase;

    if (st.crashed) { crashed = true; break; }

    if (gs.coastDeltaV !== null && gs.coastDeltaV !== undefined) {
      deltaV = gs.coastDeltaV;
      tRem = gs.coastTRem;
      captureSimT = st.simTime;
      if (ab) {
        activeFuelKg = ab.fuelMass || 0;
        stackFuelKg = st.bodies.reduce((s, b) => s + (b.fuelMass || 0), 0);
      }
      break;
    }
  }
  sim.stopGuide();
  return {
    pushVal, pushT,
    deltaV: (deltaV !== null && Number.isFinite(deltaV)) ? deltaV : null,
    tRem: (tRem !== null && Number.isFinite(tRem)) ? tRem : null,
    captureSimT,
    activeFuelKg, stackFuelKg,
    mecoSimT, stageBurnSimT, coastWaitSimT,
    maxQKPa, maxG,
    lastPhase, crashed,
  };
}

function fmtResult(r) {
  const head = 'push=' + r.pushVal.toFixed(4) +
    '  push_t=' + r.pushT.toFixed(2) +
    '  Δv=' + (r.deltaV !== null ? r.deltaV.toFixed(2).padStart(9) + 'm/s' : '     FAIL') +
    '  t_rem=' + (r.tRem !== null ? r.tRem.toFixed(1).padStart(8) + 's' : '       —');
  const sub = '  simT=' + (r.captureSimT !== null ? r.captureSimT.toFixed(1).padStart(6) + 's' : '     —') +
    '  fuel=' + (r.activeFuelKg !== null ? (r.activeFuelKg / 1000).toFixed(2).padStart(6) + 't' : '     —') +
    '  stack=' + (r.stackFuelKg !== null ? (r.stackFuelKg / 1000).toFixed(1).padStart(7) + 't' : '      —') +
    '  maxG=' + r.maxG.toFixed(2).padStart(4) +
    '  maxQ=' + r.maxQKPa.toFixed(1).padStart(5) + 'kPa' +
    '  phase=' + String(r.lastPhase || '?') +
    (r.crashed ? '  [CRASH]' : '');
  return '  ' + head + '\n' + sub;
}

// ============================================================================
// Phase 1
// ============================================================================
console.log('=== PHASE 1: PUSH_MAX_GIMBAL_DEG → Δv = ' + DELTA_V_TARGET + ' ===');
console.log('tilt=' + TILT_LOCK_FIXED + '°  lead=' + CIRC_LEAD_FIXED + 's  push_t=' + PUSH_T_INIT);
console.log('bracket=[' + PUSH_LO_INIT + ', ' + PUSH_HI_INIT + ']  rounding=2 decimals');
console.log('');

let pushLo = PUSH_LO_INIT;
let pushHi = PUSH_HI_INIT;
const tested1 = new Map();

for (let iter = 0; iter < MAX_ITER; iter++) {
  const raw = (pushLo + pushHi) / 2;
  const mid = round2(raw);
  const key = mid.toFixed(2);
  if (tested1.has(key)) break;
  if (mid <= pushLo || mid >= pushHi) break;

  const r = runOne(mid, PUSH_T_INIT);
  tested1.set(key, r);

  let action;
  if (r.deltaV === null) { pushHi = mid; action = 'fail→hi'; }
  else if (r.deltaV > DELTA_V_TARGET) { pushLo = mid; action = 'lo=mid'; }
  else { pushHi = mid; action = 'hi=mid'; }

  console.log('#' + String(iter + 1).padStart(2) + fmtResult(r));
  console.log('  bracket: [' + pushLo.toFixed(2) + ', ' + pushHi.toFixed(2) + ']  → ' + action);
  console.log('');

  if (pushHi - pushLo <= 0.01) break;
}

let best1 = null;
tested1.forEach(r => {
  if (r.deltaV === null) return;
  if (best1 === null ||
      Math.abs(r.deltaV - DELTA_V_TARGET) < Math.abs(best1.deltaV - DELTA_V_TARGET)) {
    best1 = r;
  }
});

if (!best1) { console.log('Phase 1 failed — no valid Δv.'); process.exit(1); }

const frozenPush = best1.pushVal;
console.log('PHASE 1 CONVERGED: push=' + frozenPush.toFixed(2) +
  '  Δv=' + best1.deltaV.toFixed(2) + 'm/s  t_rem=' +
  (best1.tRem !== null ? best1.tRem.toFixed(1) + 's' : '—'));
console.log('');

// ============================================================================
// Phase 2
// ============================================================================
console.log('=== PHASE 2: PUSH_T_S → Δv = ' + DELTA_V_TARGET + ' ===');
console.log('push_max_gimbal frozen at ' + frozenPush.toFixed(2));
console.log('push_t start = ' + PUSH_T_INIT + '  precision = 0.02');
console.log('');

const tested2 = new Map();

// Seed with Phase 1's frozen-push / push_t=4.8 result — no re-run needed.
if (Math.abs(best1.pushVal - frozenPush) < 1e-9 &&
    Math.abs(best1.pushT - PUSH_T_INIT) < 1e-9) {
  tested2.set(PUSH_T_INIT.toFixed(2), best1);
  console.log('reusing Phase 1\'s frozen-push / push_t=' + PUSH_T_INIT.toFixed(2) + ' run:');
  console.log(fmtResult(best1));
  console.log('');
}

function testPushT(pt) {
  const key = pt.toFixed(2);
  if (tested2.has(key)) return tested2.get(key);
  const r = runOne(frozenPush, pt);
  tested2.set(key, r);
  return r;
}

const rStart = testPushT(PUSH_T_INIT);
if (!tested2.has(PUSH_T_INIT.toFixed(2)) || tested2.get(PUSH_T_INIT.toFixed(2)) !== best1) {
  console.log('start:');
  console.log(fmtResult(rStart));
  console.log('');
}

let ptLo = null, ptHi = null;

if (rStart.deltaV === null || rStart.deltaV > DELTA_V_TARGET) {
  ptLo = PUSH_T_INIT;
  for (let pt = PUSH_T_INIT + 1; pt <= PUSH_T_INIT + 15; pt += 1) {
    const rr = testPushT(pt);
    console.log('probe up push_t=' + pt.toFixed(2) + ':');
    console.log(fmtResult(rr));
    if (rr.deltaV !== null && rr.deltaV <= DELTA_V_TARGET) { ptHi = pt; break; }
    if (rr.deltaV === null) { ptHi = pt; break; }
    ptLo = pt;
  }
} else {
  ptHi = PUSH_T_INIT;
  for (let pt = PUSH_T_INIT - 1; pt >= PUSH_T_INIT - 15; pt -= 1) {
    const rr = testPushT(pt);
    console.log('probe down push_t=' + pt.toFixed(2) + ':');
    console.log(fmtResult(rr));
    if (rr.deltaV === null || rr.deltaV > DELTA_V_TARGET) { ptLo = pt; break; }
    ptHi = pt;
  }
}

if (ptLo === null || ptHi === null) {
  console.log('Failed to bracket push_t.');
  process.exit(1);
}

console.log('');
console.log('bracket: [' + ptLo.toFixed(2) + ', ' + ptHi.toFixed(2) + '] → bisect (precision 0.02)');
console.log('');

for (let iter = 0; iter < MAX_ITER; iter++) {
  if (ptHi - ptLo <= 0.02) break;
  const raw = (ptLo + ptHi) / 2;
  const mid = round02(raw);
  const key = mid.toFixed(2);
  if (tested2.has(key)) break;
  if (mid <= ptLo || mid >= ptHi) break;

  const rr = testPushT(mid);
  let action;
  if (rr.deltaV === null) { ptHi = mid; action = 'fail→hi'; }
  else if (rr.deltaV > DELTA_V_TARGET) { ptLo = mid; action = 'lo=mid'; }
  else { ptHi = mid; action = 'hi=mid'; }

  console.log('#' + String(iter + 1).padStart(2) + fmtResult(rr));
  console.log('  bracket: [' + ptLo.toFixed(2) + ', ' + ptHi.toFixed(2) + ']  → ' + action);
  console.log('');
}

let best2 = null;
tested2.forEach(r => {
  if (r.deltaV === null) return;
  if (best2 === null ||
      Math.abs(r.deltaV - DELTA_V_TARGET) < Math.abs(best2.deltaV - DELTA_V_TARGET)) {
    best2 = r;
  }
});

console.log('=== FINAL ===');
console.log('PUSH_MAX_GIMBAL_DEG = ' + frozenPush.toFixed(2));
if (best2) {
  console.log('PUSH_T_S            = ' + best2.pushT.toFixed(2));
  console.log('Δv                  = ' + best2.deltaV.toFixed(2) + ' m/s');
  console.log('t_rem               = ' + (best2.tRem !== null ? best2.tRem.toFixed(2) + 's' : '—'));
  console.log('active fuel @ capture = ' +
    (best2.activeFuelKg !== null ? (best2.activeFuelKg / 1000).toFixed(2) + ' t' : '—'));
  console.log('stack fuel @ capture  = ' +
    (best2.stackFuelKg !== null ? (best2.stackFuelKg / 1000).toFixed(2) + ' t' : '—'));
  console.log('maxG                = ' + best2.maxG.toFixed(2));
  console.log('maxQ                = ' + best2.maxQKPa.toFixed(1) + ' kPa');
} else {
  console.log('push_t: no valid candidate.');
}

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'calib-500-' + Date.now() + '.json');
fs.writeFileSync(outFile, JSON.stringify({
  tiltLockFixed: TILT_LOCK_FIXED,
  circLeadFixed: CIRC_LEAD_FIXED,
  deltaVTarget: DELTA_V_TARGET,
  phase1: { frozenPush, best1, tested: [...tested1.values()] },
  phase2: { best2, tested: [...tested2.values()] },
}, null, 2));
console.log('');
console.log('saved: ' + outFile);