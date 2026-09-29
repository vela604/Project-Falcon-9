#!/usr/bin/env node
// ============================================================================
// headless/profile.js — timing wrapper profile of the headless sim.
//
// Wraps hot functions in the vm with per-call timing instrumentation,
// runs a short sim, and prints a sorted cumulative-cost table.
//
//   node headless/profile.js --duration 30
// ============================================================================

const { runSim } = require('./runner');

const EXTRA_BOOTSTRAP_CODE = `
globalThis.__profile = (function () {
  const stats = {};
  function wrap(obj, name, label) {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name];
    stats[label] = { total: 0, calls: 0 };
    obj[name] = function () {
      const t0 = performance.now();
      try { return orig.apply(this, arguments); }
      finally {
        stats[label].total += performance.now() - t0;
        stats[label].calls++;
      }
    };
  }
  function wrapGlobal(name) {
    const orig = globalThis[name];
    if (typeof orig !== 'function') return;
    stats[name] = { total: 0, calls: 0 };
    globalThis[name] = function () {
      const t0 = performance.now();
      try { return orig.apply(this, arguments); }
      finally {
        stats[name].total += performance.now() - t0;
        stats[name].calls++;
      }
    };
  }
  [
    'physicsStep', 'currentGeometry', 'stackMassProps',
    'computeMainThrustForBody', 'computeRCSForBody', 'computeDragAero',
    'bodyAeroProfile', 'bodyGridFinProfile', 'computeGridFinAero',
    'applySloshStep', 'updateGridFins', 'updateLegs',
    '_updateEngineVeForBody', 'resolveGroundContact',
    'gravityGradientTorque', 'derivatives', 'memberComponents',
  ].forEach(wrapGlobal);
  if (typeof Guidance !== 'undefined') wrap(Guidance, 'onSnapshot', 'Guidance.onSnapshot');
  if (typeof Derivation !== 'undefined') {
    wrap(Derivation, 'derive', 'Derivation.derive');
    wrap(Derivation, 'deriveForState', 'Derivation.deriveForState');
    wrap(Derivation, 'deriveAllBodies', 'Derivation.deriveAllBodies');
  }
  return {
    report: () => {
      const rows = Object.keys(stats).map(k => ({
        name: k,
        total: stats[k].total,
        calls: stats[k].calls,
        avgUs: stats[k].calls > 0 ? (stats[k].total * 1000 / stats[k].calls) : 0,
      }));
      rows.sort((a, b) => b.total - a.total);
      return rows;
    },
  };
})();
`;

function parseArgs(argv) {
  const out = { durationS: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--duration') out.durationS = parseFloat(argv[++i]);
    else if (a === '--stack') out.stackId = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);

console.log('=== headless profiler ===');
console.log('duration: ' + args.durationS + 's');
console.log('');

const result = runSim({
  stackId: args.stackId || 'stk_falcon9-b5',
  vehicleId: 'falcon9-b5-booster',
  durationS: args.durationS,
  quiet: true,
  extraBootstrapCode: EXTRA_BOOTSTRAP_CODE,
});

if (!result.sim || !result.sim.profile) {
  console.error('Profile slot missing — check extraBootstrapCode wiring in runner.js.');
  process.exit(1);
}

console.log('wall: ' + result.wallMs.toFixed(0) + ' ms');
console.log('ticks: ' + result.ticksRun + '  (' + (result.wallMs / result.ticksRun).toFixed(2) + ' ms/tick)');
console.log('');
console.log('function'.padEnd(34) + 'total(ms)'.padStart(11) + 'calls'.padStart(10) + 'avg(µs)'.padStart(11));
console.log('-'.repeat(66));

result.sim.profile.report().forEach(r => {
  if (r.total < 1) return;
  console.log(
    r.name.padEnd(34) +
    r.total.toFixed(1).padStart(11) +
    r.calls.toString().padStart(10) +
    r.avgUs.toFixed(2).padStart(11)
  );
});