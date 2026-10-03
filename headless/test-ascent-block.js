#!/usr/bin/env node
// ============================================================================
// headless/test-ascent-block.js — Stage 2 verification.
//
// Runs leoInsertionV2 and the ascent block (via a temporary test guide)
// side-by-side and compares MECO timing. Both must fire MECO at the same
// sim tick for the block to be behavior-identical to V2.
// ============================================================================

const { runSim } = require('./runner');

// Register the ascent block as a guide inside the sandbox.
const ASCENT_BLOCK_GUIDE = `
(function() {
  const blk = FUNDAMENTAL_BLOCKS.ascent.createInstance();
  const testGuide = function(snapshot) { blk.tick(snapshot); };
  testGuide.start = function() {
    blk.start(FUNDAMENTAL_BLOCKS.ascent.defaultConstants, 0, {});
  };
  testGuide.stop = function() { blk.stop(); };
  testGuide.getStatus = function() {
    const st = blk.getStatus();
    return st;
  };
  Guidance._registerTestGuide('_test_ascentBlock', testGuide);
})();
`;

function runToMeco(guideName, extraCode) {
  const warm = runSim({ durationS: 0.001, quiet: true, extraBootstrapCode: extraCode });
  const sim = warm.sim;
  sim.reset(0);
  sim.setEnvironment({ atmosphere: true, slosh: true, imu: false,
    wind: { enabled: false, speed: 0, directionDeg: 0 } });
  sim.setFueling(100, 100);

  const ok = sim.startGuide(guideName);
  if (!ok) throw new Error('startGuide failed: ' + guideName);

  const dt = sim.CONFIG.DT;
  const maxTicks = Math.ceil(200 / dt);
  for (let i = 0; i < maxTicks; i++) {
    sim.step(1);
    const st = sim.getStatus();
    const gs = st.guideStatus || {};
    const phase = gs.phase;
    // V2 enters MECO_SPOOL at MECO. Block sets phase to 'DONE' when MECO fires.
    if (guideName === 'leoInsertionV2' && phase === 'MECO_SPOOL') {
      return { mecoTime: st.simTime, phase, alt: st.bodies[0].altitudeKm };
    }
    if (guideName === '_test_ascentBlock' && phase === 'DONE') {
      return { mecoTime: st.simTime, phase, alt: st.bodies[0].altitudeKm };
    }
  }
  return { mecoTime: null, phase: 'TIMEOUT', alt: null };
}

console.log('');
console.log('Stage 2 — Ascent block verification');
console.log('=====================================');
console.log('');

const v2 = runToMeco('leoInsertionV2', undefined);
console.log('  V2 guide MECO:      t=' + (v2.mecoTime === null ? 'TIMEOUT' : v2.mecoTime.toFixed(6)) +
  '  phase=' + v2.phase + '  alt=' + (v2.alt ? v2.alt.toFixed(3) : '—') + ' km');

const blk = runToMeco('_test_ascentBlock', ASCENT_BLOCK_GUIDE);
console.log('  Ascent block MECO:  t=' + (blk.mecoTime === null ? 'TIMEOUT' : blk.mecoTime.toFixed(6)) +
  '  phase=' + blk.phase + '  alt=' + (blk.alt ? blk.alt.toFixed(3) : '—') + ' km');

console.log('');
if (v2.mecoTime === null || blk.mecoTime === null) {
  console.log('  ✗ At least one run timed out without reaching MECO.');
  process.exit(1);
}
const diff = Math.abs(v2.mecoTime - blk.mecoTime);
if (diff < 1e-9) {
  console.log('  ✓ BIT-IDENTICAL MECO time.');
  process.exit(0);
} else {
  console.log('  ✗ MECO times differ by ' + diff.toFixed(9) + ' s (' +
    (diff * 80).toFixed(2) + ' ticks).');
  process.exit(1);
}