#!/usr/bin/env node
// ============================================================================
// headless/bisect-push-for-90.js
//
// STAGE_BURN_LOCK_TILT_DEG pinned at 89.999°.
//
// Bisect PUSH_MAX_GIMBAL_DEG over [0.01, 1.00] to find the smallest push
// where the circularize Δv stays ≤ DELTA_V_MAX (50 m/s). At that push,
// time-to-apogee (t_rem) at the first COAST_WAIT tick after COAST_ROTATE
// (1st pass) is minimized.
//
// Physical reasoning:
//   - Higher push → more gravity turn → higher horizontal velocity at
//     MECO → smaller circularize Δv needed.
//   - Higher push → longer coast (t_rem) before circularize.
//   - Lower push → shorter coast, but bigger Δv requirement.
//   The binding constraint is Δv ≤ 50. Bisection finds the boundary.
//
// Captured at the first COAST_WAIT tick after COAST_ROTATE (1st pass):
//   t_rem  = time-to-apogee from Kepler (matches guidance.js _hTimeToApogee)
//   deltaV = V_orb(r_apo) − V_apo      (matches guidance.js's coast plan)
//
// Classification of a run:
//   crash / no COAST_WAIT / no t_rem → 'high'   (push too high → lower)
//   Δv null OR Δv > DELTA_V_MAX       → 'low'    (push too low → raise)
//   else                              → 'pass'   (candidate; try lower)
//
// Bisection: because a pass means "could still be lower", we move pushHi
// down on pass. Answer is the smallest push that passes (≈ Δv boundary),
// which yields minimum t_rem among all feasible pushes.
//
// Adaptive chunk granularity:
//   bracket > CLOSE_BRACKET → CHUNK_COARSE = 8  (fast sweep)
//   bracket ≤ CLOSE_BRACKET → CHUNK_FINE   = 1  (precise t_rem capture)
// Cache key includes chunk, so a value first run coarsely is re-run finely
// once the bracket closes.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const TILT_LOCK_FIXED = 89.999;
const DELTA_V_MAX     = 50.0;    // m/s — circularize Δv hard limit
const PRECISION       = 1e-4;
const TOTAL_SIM_S     = 700;
const MAX_ITER        = 120;

const CHUNK_COARSE    = 8;
const CHUNK_FINE      = 1;
const CLOSE_BRACKET   = 0.005;

const PUSH_LO_INIT    = 0.01;
const PUSH_HI_INIT    = 1.00;

// ---------------------------------------------------------------------------
// Kepler time-to-apogee — identical formula to guidance.js's _hTimeToApogee.
// ---------------------------------------------------------------------------
function timeToApogee(r, vr, vt, GM) {
  if (!(r > 0)) return Infinity;
  const E = 0.5 * (vr * vr + vt * vt) - GM / r;
  if (E >= 0) return Infinity;
  const a = -GM / (2 * E);
  const h = r * vt;
  const eSq = 1 + 2 * E * h * h / (GM * GM);
  const e = Math.sqrt(Math.max(0, eSq));
  if (e < 1e-9) return Math.PI * Math.sqrt(a * a * a / GM);
  const cosE = (1 - r / a) / e;
  const sinE = (r * vr) / (e * Math.sqrt(GM * a));
  let E_an = Math.atan2(sinE, cosE);
  if (E_an < 0) E_an += 2 * Math.PI;
  const M = E_an - e * Math.sin(E_an);
  const n = Math.sqrt(GM / (a * a * a));
  if (M < Math.PI) return (Math.PI - M) / n;
  return (3 * Math.PI - M) / n;
}

// ---------------------------------------------------------------------------
// Circularize Δv — matches guidance.js's RCS_BOOST-done plan block.
//   E     = specific orbital energy
//   a     = semi-major axis
//   h     = specific angular momentum
//   e     = eccentricity
//   r_apo = a·(1+e)             apogee radius after stage burn
//   v_apo = |h| / r_apo         velocity at apogee (vr=0 there)
//   v_orb = √(GM / r_apo)       circular orbital speed at that radius
//   Δv    = v_orb − v_apo
// Returns null if E ≥ 0 (escape / hyperbolic — no apogee).
// ---------------------------------------------------------------------------
function deltaVCircularize(r, vr, vt, GM) {
  const E = 0.5 * (vr * vr + vt * vt) - GM / r;
  if (E >= 0) return null;
  const a = -GM / (2 * E);
  const h = r * vt;
  const eSq = 1 + 2 * E * h * h / (GM * GM);
  const e = Math.sqrt(Math.max(0, eSq));
  const rApo = a * (1 + e);
  if (!(rApo > 0)) return null;
  const vApo = Math.abs(h) / rApo;
  const vOrb = Math.sqrt(GM / rApo);
  return Math.max(0, vOrb - vApo);
}

// ---------------------------------------------------------------------------
// One run: given a PUSH value and a tick-chunk size, return t_rem and Δv at
// the first COAST_WAIT tick following COAST_ROTATE (1st pass).
// ---------------------------------------------------------------------------
function runOne(pushVal, chunkTicks) {
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
  const GM = sim.CONFIG.GM_EARTH;

  let prevPhase = null;
  let tRem = null;
  let deltaV = null;
  let tRemAtSimTime = null;
  let exitedPhase = null;

  for (let i = 0; i < totalTicks; i += chunkTicks) {
    sim.step(Math.min(chunkTicks, totalTicks - i));
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const phase = gs.phase;
    const a = st.bodies.find(b => b.isActive) || st.bodies[0];
    if (!a) { exitedPhase = 'NO_BODY'; break; }

    // Capture on first COAST_WAIT tick after COAST_ROTATE (1st pass).
    // (2nd-pass COAST_ROTATE exits to COAST_HOLD, not COAST_WAIT.)
    if (tRem === null && prevPhase === 'COAST_ROTATE' && phase === 'COAST_WAIT') {
      const rr = Math.hypot(a.rx, a.ry) || 1;
      const ux = a.rx / rr, uy = a.ry / rr;
      const ex = a.ry / rr, ey = -a.rx / rr;
      const vr = a.vx * ux + a.vy * uy;
      const vt = a.vx * ex + a.vy * ey;
      tRem = timeToApogee(rr, vr, vt, GM);
      deltaV = deltaVCircularize(rr, vr, vt, GM);
      tRemAtSimTime = st.simTime;
      exitedPhase = phase;
      break;
    }

    if (st.crashed) { exitedPhase = 'CRASH'; break; }
    prevPhase = phase;
  }

  sim.stopGuide();

  return {
    pushVal,
    chunkTicks,
    tRem: (tRem !== null && Number.isFinite(tRem)) ? tRem : null,
    deltaV: (deltaV !== null && Number.isFinite(deltaV)) ? deltaV : null,
    tRemAtSimTime,
    exitedPhase,
    crashed: sim.getStatus().crashed,
  };
}

// 'high' → push too high, try lower; 'low' → push too low, raise it;
// 'pass' → feasible, try lower to minimize t_rem.
function classify(r) {
  if (r.crashed || r.tRem === null) return 'high';
  if (r.deltaV === null || r.deltaV > DELTA_V_MAX) return 'low';
  return 'pass';
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
// Bootstrap
// ---------------------------------------------------------------------------
console.log('=== bisect PUSH_MAX_GIMBAL_DEG ===');
console.log('TILT_LOCK fixed    = ' + TILT_LOCK_FIXED + '°');
console.log('Δv constraint      = ≤ ' + DELTA_V_MAX + ' m/s (circularize)');
console.log('PRECISION          = ' + PRECISION);
console.log('range              = [' + PUSH_LO_INIT + ', ' + PUSH_HI_INIT + ']');
console.log('chunk: coarse=' + CHUNK_COARSE + ' (bracket > ' + CLOSE_BRACKET + '), fine=' + CHUNK_FINE);
console.log('');

function pickChunk() {
  return (pushHi - pushLo) > CLOSE_BRACKET ? CHUNK_COARSE : CHUNK_FINE;
}

let pushLo = PUSH_LO_INIT;
let pushHi = PUSH_HI_INIT;

console.log('initial run: push=' + pushLo + ' (expect Δv-fail / low side)…');
let rLo = runOneCached(pushLo, pickChunk());
console.log('  t_rem=' + (rLo.tRem !== null ? rLo.tRem.toFixed(3) + 's' : 'FAIL') +
  '  Δv=' + (rLo.deltaV !== null ? rLo.deltaV.toFixed(1) + 'm/s' : '—') +
  '  exit=' + rLo.exitedPhase);

console.log('initial run: push=' + pushHi + ' (expect pass / high side)…');
let rHi = runOneCached(pushHi, pickChunk());
console.log('  t_rem=' + (rHi.tRem !== null ? rHi.tRem.toFixed(3) + 's' : 'FAIL') +
  '  Δv=' + (rHi.deltaV !== null ? rHi.deltaV.toFixed(1) + 'm/s' : '—') +
  '  exit=' + rHi.exitedPhase);
console.log('');

if (classify(rLo) === 'pass') {
  console.log('WARNING: lo endpoint ALREADY passes (Δv ≤ ' + DELTA_V_MAX + ').');
  console.log('         The Δv constraint might not bind in the range.');
}
if (classify(rHi) === 'low') {
  console.log('WARNING: hi endpoint is Δv-FAIL (push too low for constraint).');
  console.log('         Bracket inverted — results unreliable.');
}
console.log('');

let bestPush = null;
let bestTRem = null;
let bestDeltaV = null;
let bestChunk = null;

function considerCandidate(push, r) {
  if (r.tRem === null) return;
  if (r.deltaV === null || r.deltaV > DELTA_V_MAX) return;
  if (bestPush === null || r.tRem < bestTRem) {
    bestPush = push;
    bestTRem = r.tRem;
    bestDeltaV = r.deltaV;
    bestChunk = r.chunkTicks;
  }
}
considerCandidate(pushLo, rLo);
considerCandidate(pushHi, rHi);

const trace = [rLo, rHi];

// ---------------------------------------------------------------------------
// Bisection (weighted on Δv when both endpoints have it)
// ---------------------------------------------------------------------------
for (let iter = 0; iter < MAX_ITER; iter++) {
  if (pushHi - pushLo < PRECISION) break;

  const chunk = pickChunk();

  let pushMid;
  const dL = rLo.deltaV;
  const dH = rHi.deltaV;
  if (dL !== null && dH !== null && Math.abs(dH - dL) > 1e-9) {
    let ratio = (DELTA_V_MAX - dL) / (dH - dL);
    ratio = Math.max(0.05, Math.min(0.95, ratio));
    pushMid = pushLo + (pushHi - pushLo) * ratio;
  } else {
    pushMid = (pushLo + pushHi) / 2;
  }

  const rMid = runOneCached(pushMid, chunk);
  trace.push(rMid);

  const tStr = (rMid.tRem !== null) ? rMid.tRem.toFixed(4) + 's' : 'FAIL';
  const dStr = (rMid.deltaV !== null) ? rMid.deltaV.toFixed(2) + 'm/s' : '—';
  const c = classify(rMid);
  const side = c === 'high' ? 'high→hi' : c === 'low' ? 'low→lo' : 'pass→hi';

  console.log(
    '#' + String(iter + 1).padStart(3) +
    '  push=' + pushMid.toFixed(6) +
    '  t_rem=' + tStr.padStart(10) +
    '  Δv=' + dStr.padStart(10) +
    '  chunk=' + chunk +
    '  [' + pushLo.toFixed(6) + ', ' + pushHi.toFixed(6) + ']' +
    '  → ' + side
  );

  if (c === 'high') {
    pushHi = pushMid;
    rHi = rMid;
  } else if (c === 'low') {
    pushLo = pushMid;
    rLo = rMid;
  } else { // pass
    pushHi = pushMid;
    rHi = rMid;
    considerCandidate(pushMid, rMid);
  }
}

console.log('');
console.log('=== HIGH-PRECISION RESULT ===');
if (bestPush === null) {
  console.log('No feasible push found (no run with Δv ≤ ' + DELTA_V_MAX + ').');
} else {
  console.log('push   = ' + bestPush.toFixed(6));
  console.log('t_rem  = ' + bestTRem.toFixed(4) + 's');
  console.log('Δv     = ' + bestDeltaV.toFixed(3) + ' m/s');
  console.log('chunk  = ' + bestChunk);
}
console.log('final bracket: [' + pushLo.toFixed(6) + ', ' + pushHi.toFixed(6) + ']');
console.log('');

// ---------------------------------------------------------------------------
// 2-decimal pass — always CHUNK_FINE.
// Among candidates with Δv ≤ DELTA_V_MAX, pick min t_rem.
// ---------------------------------------------------------------------------
let finalDecPush = null;
let finalDecTRem = null;
let finalDecDeltaV = null;

if (bestPush !== null) {
  const a = Math.floor(bestPush * 100) / 100;
  const b = Math.ceil(bestPush * 100) / 100;

  console.log('=== 2-DECIMAL PASS ===');
  console.log('bracketing ' + bestPush.toFixed(6) + ' → ' + a + ' and ' + b);

  let rA = null, rB = null;
  if (a === b) {
    rA = runOneCached(a, CHUNK_FINE);
    rB = rA;
    console.log('  push=' + a.toFixed(2) +
      '  t_rem=' + (rA.tRem !== null ? rA.tRem.toFixed(4) + 's' : 'FAIL') +
      '  Δv=' + (rA.deltaV !== null ? rA.deltaV.toFixed(2) + 'm/s' : '—'));
  } else {
    rA = runOneCached(a, CHUNK_FINE);
    rB = runOneCached(b, CHUNK_FINE);
    trace.push(rA, rB);
    console.log('  push=' + a.toFixed(2) +
      '  t_rem=' + (rA.tRem !== null ? rA.tRem.toFixed(4) + 's' : 'FAIL') +
      '  Δv=' + (rA.deltaV !== null ? rA.deltaV.toFixed(2) + 'm/s' : '—'));
    console.log('  push=' + b.toFixed(2) +
      '  t_rem=' + (rB.tRem !== null ? rB.tRem.toFixed(4) + 's' : 'FAIL') +
      '  Δv=' + (rB.deltaV !== null ? rB.deltaV.toFixed(2) + 'm/s' : '—'));
  }

  const validA = (rA.tRem !== null && rA.deltaV !== null && rA.deltaV <= DELTA_V_MAX);
  const validB = (rB.tRem !== null && rB.deltaV !== null && rB.deltaV <= DELTA_V_MAX);

  if (validA && validB) {
    if (rA.tRem <= rB.tRem) { finalDecPush = a; finalDecTRem = rA.tRem; finalDecDeltaV = rA.deltaV; }
    else                    { finalDecPush = b; finalDecTRem = rB.tRem; finalDecDeltaV = rB.deltaV; }
  } else if (validA) {
    finalDecPush = a; finalDecTRem = rA.tRem; finalDecDeltaV = rA.deltaV;
  } else if (validB) {
    finalDecPush = b; finalDecTRem = rB.tRem; finalDecDeltaV = rB.deltaV;
  } else {
    console.log('  WARNING: neither 2-decimal candidate is Δv-feasible.');
  }
  if (finalDecPush !== null) {
    console.log('  → picked push=' + finalDecPush.toFixed(2) +
      '  t_rem=' + finalDecTRem.toFixed(4) + 's' +
      '  Δv=' + finalDecDeltaV.toFixed(2) + 'm/s');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------
console.log('=== FINAL ===');
if (bestPush !== null) {
  console.log('HIGH-PRECISION  push=' + bestPush.toFixed(6) +
    '  t_rem=' + bestTRem.toFixed(4) + 's' +
    '  Δv=' + bestDeltaV.toFixed(3) + 'm/s');
}
if (finalDecPush !== null) {
  console.log('2-DECIMAL       push=' + finalDecPush.toFixed(2) +
    '  t_rem=' + finalDecTRem.toFixed(4) + 's' +
    '  Δv=' + finalDecDeltaV.toFixed(3) + 'm/s');
}

// ---------------------------------------------------------------------------
// Save JSON
// ---------------------------------------------------------------------------
const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bisect-push-90-' + Date.now() + '.json');
fs.writeFileSync(outFile, JSON.stringify({
  tiltLockFixed: TILT_LOCK_FIXED,
  deltaVMax: DELTA_V_MAX,
  precision: PRECISION,
  range: [PUSH_LO_INIT, PUSH_HI_INIT],
  highPrecision: bestPush !== null
    ? { push: bestPush, tRem: bestTRem, deltaV: bestDeltaV } : null,
  twoDecimal: finalDecPush !== null
    ? { push: finalDecPush, tRem: finalDecTRem, deltaV: finalDecDeltaV } : null,
  finalBracket: [pushLo, pushHi],
  trace,
}, null, 2));
console.log('');
console.log('saved: ' + outFile);