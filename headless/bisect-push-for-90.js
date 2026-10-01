#!/usr/bin/env node
// ============================================================================
// headless/bisect-push-for-90.js
//
// STAGE_BURN_LOCK_TILT_DEG pinned at 90.0°.
// CIRC_TRIGGER_LEAD_S pinned at 1.0s.
// Bisect PUSH_MAX_GIMBAL_DEG to land circularize Δv on 100 m/s.
//
// Direction: higher push → more horizontal velocity at cutoff → smaller Δv.
//            lower  push → less horizontal velocity at cutoff → bigger Δv.
//
// Classification:
//   crash / no Δv captured        → 'high' (lower pushHi)
//   Δv > 100 + tol                → 'low'  (raise pushLo)
//   Δv < 100 - tol                → 'high' (lower pushHi)
//   |Δv - 100| ≤ tol              → 'target'
//
// Δv / t_rem captured inside guidance at 1st-pass COAST_ROTATE exit
// (see leoInsertionV2) — the exact moment COAST_WAIT would begin, so
// short COAST_WAIT phases that the outer loop skips are still captured.
//
// After bisection:
//   - take precise push
//   - compute floor and ceil at 2 decimals
//   - run both fresh
//   - among {precise, floor, ceil}, pick the one with Δv closest to 100
//   - report all three + winner
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const TILT_LOCK_FIXED = 90.0;
const CIRC_LEAD_FIXED = 1.0;
const DELTA_V_TARGET  = 100.0;
const DELTA_V_TOL     = 5.0;
const PRECISION       = 1e-4;
const TOTAL_SIM_S     = 700;
const MAX_ITER        = 200;

const CHUNK_COARSE    = 8;
const CHUNK_FINE      = 1;
const CLOSE_BRACKET   = 0.005;

const PUSH_LO_INIT    = 0.3;
const PUSH_HI_INIT    = 0.61;

// ---------------------------------------------------------------------------
// One run.
// ---------------------------------------------------------------------------
function runOne(pushVal, chunkTicks) {
  const warm = runSim({ durationS: 0.05, quiet: true });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({ atmosphere: true, slosh: true, imu: false });
  sim.applyTunables('leoInsertionV2', [
    { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG',   value: pushVal },
    { path: 'STAGE_BURN_LOCK_TILT_DEG',     value: TILT_LOCK_FIXED },
    { path: 'CIRC_TRIGGER_LEAD_S',          value: CIRC_LEAD_FIXED },
  ]);
  sim.setFueling(100, 100);
  sim.startGuide('leoInsertionV2');

  const dt = sim.CONFIG.DT;
  const totalTicks = Math.ceil(TOTAL_SIM_S / dt);

  let abortReason = null;
  let abortApogeeKm = null;
  let deltaV = null;
  let tRem = null;
  let lastPhase = null;

  for (let i = 0; i < totalTicks; i += chunkTicks) {
    sim.step(Math.min(chunkTicks, totalTicks - i));
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const phase = gs.phase;
    lastPhase = phase;
    const a = st.bodies.find(b => b.isActive) || st.bodies[0];
    if (!a) { abortReason = 'NO_BODY'; break; }

    // STAGE_BURN vr monitor (fail-forward signal only — not the primary
    // criterion any more, but a clean early-exit path when a value clearly
    // isn't going to work).
    if (phase === 'STAGE_BURN') {
      const rr = Math.hypot(a.rx, a.ry) || 1;
      const vr = (a.vx * a.rx + a.vy * a.ry) / rr;
      if (vr < 0) {
        const apKm = Number.isFinite(gs.apogeeKm) ? gs.apogeeKm : null;
        abortApogeeKm = apKm;
        abortReason = 'VR_NEG';
        break;
      }
    }

    // Δv / t_rem become available once 1st-pass COAST_ROTATE exits.
    if (gs.coastDeltaV !== null && gs.coastDeltaV !== undefined) {
      deltaV = gs.coastDeltaV;
      tRem = gs.coastTRem;
      break;
    }

    if (st.crashed) { abortReason = 'CRASH'; break; }
  }

  sim.stopGuide();

  return {
    pushVal,
    chunkTicks,
    tRem: (tRem !== null && Number.isFinite(tRem)) ? tRem : null,
    deltaV: (deltaV !== null && Number.isFinite(deltaV)) ? deltaV : null,
    abortReason,
    abortApogeeKm,
    lastPhase,
    crashed: sim.getStatus().crashed,
  };
}

function classify(r) {
  if (r.crashed) return 'high';
  if (r.abortReason) return 'high';
  if (r.deltaV === null) return 'high';
  if (r.deltaV > DELTA_V_TARGET + DELTA_V_TOL) return 'low';
  if (r.deltaV < DELTA_V_TARGET - DELTA_V_TOL) return 'high';
  return 'target';
}

const cache = new Map();
function runOneCached(pushVal, chunkTicks) {
  const key = pushVal.toFixed(8) + '|' + chunkTicks;
  if (cache.has(key)) return cache.get(key);
  const r = runOne(pushVal, chunkTicks);
  cache.set(key, r);
  return r;
}

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------
function fmtR(r) {
  const t = (r.tRem !== null) ? r.tRem.toFixed(1) + 's' : '—';
  const d = (r.deltaV !== null) ? r.deltaV.toFixed(2) + 'm/s' : '—';
  const ab = r.abortReason ? ('[' + r.abortReason +
    (r.abortApogeeKm !== null ? '@' + r.abortApogeeKm.toFixed(0) + 'km' : '') + ']') : '';
  return 't_rem=' + t.padStart(9) + '  Δv=' + d.padStart(12) +
    '  phase=' + String(r.lastPhase || '?').padEnd(15) + '  ' + ab;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
console.log('=== bisect PUSH_MAX_GIMBAL_DEG ===');
console.log('TILT_LOCK fixed = ' + TILT_LOCK_FIXED + '°');
console.log('CIRC_LEAD fixed = ' + CIRC_LEAD_FIXED + ' s');
console.log('Δv target       = ' + DELTA_V_TARGET + ' ± ' + DELTA_V_TOL + ' m/s');
console.log('PRECISION       = ' + PRECISION);
console.log('range           = [' + PUSH_LO_INIT + ', ' + PUSH_HI_INIT + ']');
console.log('chunk: coarse=' + CHUNK_COARSE + ' (bracket > ' + CLOSE_BRACKET + '), fine=' + CHUNK_FINE);
console.log('');

let pushLo = PUSH_LO_INIT;
let pushHi = PUSH_HI_INIT;

function pickChunk() {
  return (pushHi - pushLo) > CLOSE_BRACKET ? CHUNK_COARSE : CHUNK_FINE;
}

console.log('initial: push=' + pushLo + '…');
let rLo = runOneCached(pushLo, pickChunk());
let cLo = classify(rLo);
console.log('  ' + fmtR(rLo) + '  → ' + cLo);

console.log('initial: push=' + pushHi + '…');
let rHi = runOneCached(pushHi, pickChunk());
let cHi = classify(rHi);
console.log('  ' + fmtR(rHi) + '  → ' + cHi);
console.log('');

if (cLo === 'high' && cHi === 'high') {
  console.log('WARNING: both endpoints on high side — bracket too low.');
}
if (cLo === 'low' && cHi === 'low') {
  console.log('WARNING: both endpoints on low side — bracket too high.');
}
console.log('');

const trace = [rLo, rHi];

// ---------------------------------------------------------------------------
// Bisection
// ---------------------------------------------------------------------------
for (let iter = 0; iter < MAX_ITER; iter++) {
  if (pushHi - pushLo < PRECISION) break;

  const chunk = pickChunk();

  let pushMid;
  if (rLo.deltaV !== null && rHi.deltaV !== null &&
      Math.abs(rHi.deltaV - rLo.deltaV) > 1) {
    let ratio = (DELTA_V_TARGET - rLo.deltaV) / (rHi.deltaV - rLo.deltaV);
    ratio = Math.max(0.05, Math.min(0.95, ratio));
    pushMid = pushLo + (pushHi - pushLo) * ratio;
  } else {
    pushMid = (pushLo + pushHi) / 2;
  }

  const rMid = runOneCached(pushMid, chunk);
  const cMid = classify(rMid);
  trace.push(rMid);

  console.log(
    '#' + String(iter + 1).padStart(3) +
    '  push=' + pushMid.toFixed(6) +
    '  ' + fmtR(rMid) +
    '  [' + pushLo.toFixed(6) + ', ' + pushHi.toFixed(6) + ']' +
    '  → ' + cMid
  );

  if (cMid === 'high') {
    pushHi = pushMid; rHi = rMid;
  } else if (cMid === 'low') {
    pushLo = pushMid; rLo = rMid;
  } else { // target — keep bisecting, treat like high to try to nail precise
    pushHi = pushMid; rHi = rMid;
  }
}

// ---------------------------------------------------------------------------
// Precise result — closest Δv to target among all trace entries that
// produced a valid Δv.
// ---------------------------------------------------------------------------
let precise = null;
for (const r of trace) {
  if (r.deltaV === null) continue;
  if (precise === null ||
      Math.abs(r.deltaV - DELTA_V_TARGET) < Math.abs(precise.deltaV - DELTA_V_TARGET)) {
    precise = r;
  }
}

console.log('');
console.log('=== PRECISE (high-precision bisection) ===');
if (precise) {
  console.log('push   = ' + precise.pushVal.toFixed(6));
  console.log('Δv     = ' + precise.deltaV.toFixed(3) + ' m/s');
  console.log('t_rem  = ' + (precise.tRem !== null ? precise.tRem.toFixed(2) + 's' : '—'));
} else {
  console.log('No run produced a valid Δv.');
}
console.log('final bracket: [' + pushLo.toFixed(6) + ', ' + pushHi.toFixed(6) + ']');
console.log('');

// ---------------------------------------------------------------------------
// 2-decimal pass
// ---------------------------------------------------------------------------
let finalWinner = null;
let candidates = [];

if (precise) {
  const a = Math.floor(precise.pushVal * 100) / 100;
  const b = Math.ceil(precise.pushVal * 100) / 100;

  console.log('=== 2-DECIMAL CANDIDATES ===');
  console.log('precise = ' + precise.pushVal.toFixed(6) + ' → floor=' + a.toFixed(2) + ' ceil=' + b.toFixed(2));
  console.log('');

  const rA = (Math.abs(a - precise.pushVal) < 1e-9)
    ? precise
    : runOneCached(a, CHUNK_FINE);
  const rB = (Math.abs(b - precise.pushVal) < 1e-9)
    ? precise
    : runOneCached(b, CHUNK_FINE);
  if (rA !== precise) trace.push(rA);
  if (rB !== precise && rB !== rA) trace.push(rB);

  candidates = [
    { label: 'precise', push: precise.pushVal, r: precise },
    { label: 'floor',   push: a,               r: rA },
    { label: 'ceil',    push: b,               r: rB },
  ];

  candidates.forEach(c => {
    console.log(
      '  ' + c.label.padEnd(8) +
      '  push=' + c.push.toFixed(6) +
      '  ' + fmtR(c.r)
    );
  });
  console.log('');

  const valid = candidates.filter(c => c.r.deltaV !== null);
  if (valid.length) {
    valid.forEach(c => {
      c.dist = Math.abs(c.r.deltaV - DELTA_V_TARGET);
    });
    valid.sort((x, y) => x.dist - y.dist);
    finalWinner = valid[0];
  }
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------
console.log('=== FINAL ===');
if (precise) {
  console.log('PRECISE    push=' + precise.pushVal.toFixed(6) +
    '  Δv=' + precise.deltaV.toFixed(3) + ' m/s' +
    '  t_rem=' + (precise.tRem !== null ? precise.tRem.toFixed(2) + 's' : '—'));
}
candidates.forEach(c => {
  if (c === finalWinner) return;
  const dv = c.r.deltaV !== null ? c.r.deltaV.toFixed(3) + ' m/s' : '—';
  const tr = c.r.tRem !== null ? c.r.tRem.toFixed(2) + 's' : '—';
  console.log('           ' + c.label.padEnd(8) + ' push=' + c.push.toFixed(2) +
    '  Δv=' + dv + '  t_rem=' + tr);
});
if (finalWinner) {
  const dv = finalWinner.r.deltaV !== null ? finalWinner.r.deltaV.toFixed(3) + ' m/s' : '—';
  const tr = finalWinner.r.tRem !== null ? finalWinner.r.tRem.toFixed(2) + 's' : '—';
  console.log('');
  console.log('★ WINNER   ' + finalWinner.label.padEnd(8) +
    ' push=' + finalWinner.push.toFixed(2) +
    '  Δv=' + dv + '  t_rem=' + tr);
} else {
  console.log('');
  console.log('No winner — none of the candidates produced a valid Δv.');
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bisect-push-90-' + Date.now() + '.json');
fs.writeFileSync(outFile, JSON.stringify({
  tiltLockFixed: TILT_LOCK_FIXED,
  circLeadFixed: CIRC_LEAD_FIXED,
  deltaVTarget: DELTA_V_TARGET,
  deltaVTol: DELTA_V_TOL,
  precision: PRECISION,
  range: [PUSH_LO_INIT, PUSH_HI_INIT],
  precise: precise
    ? { push: precise.pushVal, tRem: precise.tRem, deltaV: precise.deltaV } : null,
  candidates: candidates.map(c => ({
    label: c.label, push: c.push,
    tRem: c.r.tRem, deltaV: c.r.deltaV,
  })),
  winner: finalWinner
    ? { label: finalWinner.label, push: finalWinner.push,
        tRem: finalWinner.r.tRem, deltaV: finalWinner.r.deltaV } : null,
  finalBracket: [pushLo, pushHi],
  trace,
}, null, 2));
console.log('');
console.log('saved: ' + outFile);