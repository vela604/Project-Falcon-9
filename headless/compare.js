#!/usr/bin/env node
// ============================================================================
// headless/compare.js — A/B test the aero-cache patch.
// Runs the same sim twice (cache ON, then OFF) and diffs the states.
// ============================================================================

const { runSim } = require('./runner');

function runOnce(disableCache) {
  return runSim({
    stackId: 'stk_falcon9-b5',
    vehicleId: 'falcon9-b5-booster',
    guide: 'leoInsertionV2',
    durationS: 60,
    quiet: true,
    extraBootstrapCode: disableCache
      ? 'globalThis.SIM_NO_AERO_CACHE = true;'
      : '',
  });
}

console.log('running A (cache ON)…');
const A = runOnce(false);
console.log('running B (cache OFF)…');
const B = runOnce(true);

const aB = A.status.bodies.find(b => b.isActive) || A.status.bodies[0];
const bB = B.status.bodies.find(b => b.isActive) || B.status.bodies[0];

const fields = ['rx', 'ry', 'vx', 'vy', 'theta', 'omega', 'altitudeKm', 'fuelMass'];
console.log('');
console.log('field'.padEnd(16) + 'cache ON'.padStart(22) + 'cache OFF'.padStart(22) + 'delta'.padStart(14));
console.log('-'.repeat(76));
fields.forEach(f => {
  const a = aB[f], b = bB[f];
  const d = (typeof a === 'number' && typeof b === 'number') ? b - a : null;
  console.log(
    f.padEnd(16) +
    (typeof a === 'number' ? a.toFixed(6) : String(a)).padStart(22) +
    (typeof b === 'number' ? b.toFixed(6) : String(b)).padStart(22) +
    (d !== null ? d.toExponential(3) : '—').padStart(14)
  );
});

console.log('');
console.log('guide phase:  A=' + (A.status.guideStatus.phase || '?') +
            '   B=' + (B.status.guideStatus.phase || '?'));
console.log('crashed:      A=' + A.status.crashed + '   B=' + B.status.crashed);
console.log('simTime:      A=' + A.status.simTime.toFixed(3) +
            '   B=' + B.status.simTime.toFixed(3));