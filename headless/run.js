#!/usr/bin/env node
 // ============================================================================
// headless/run.js — CLI wrapper for a single headless sim run.
//
// Examples:
//   node headless/run.js
//   node headless/run.js --guide leoInsertionV3 --duration 1500
//   node headless/run.js --fueling '{"boosterPct":90,"stagePct":100}'
//   node headless/run.js --tunables '[{"path":"ascent.PUSH_MAX_GIMBAL_DEG","value":0.16}]'
//   node headless/run.js --json > result.json
// ============================================================================

const { runSim } = require('./runner');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--guide') out.guide = argv[++i];
    else if (a === '--duration') out.durationS = parseFloat(argv[++i]);
    else if (a === '--stack') out.stackId = argv[++i];
    else if (a === '--vehicle') out.vehicleId = argv[++i];
    else if (a === '--fueling') out.fueling = JSON.parse(argv[++i]);
    else if (a === '--tunables') out.tunables = JSON.parse(argv[++i]);
    else if (a === '--env') out.environment = JSON.parse(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv);
const result = runSim(args);

if (args.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  // Add per-chunk timing summary at the end for diagnosing slowdowns.
  const st = result.status;
  const gs = st.guideStatus || {};
  const tr = result.tracker;
  console.log('--- headless sim run ---');
  console.log('guide:           ' + result.guideName);
  console.log('duration:        ' + result.durationS + ' s');
  console.log('ticks run:       ' + result.ticksRun);
  console.log('sim time:        ' + st.simTime.toFixed(2) + ' s');
  console.log('wall time:       ' + result.wallMs.toFixed(0) + ' ms');
  console.log('speed:           ' + (st.simTime / (result.wallMs / 1000)).toFixed(0) + ' x realtime');
  console.log('halted by loop:  ' + result.haltedByLoop);
  console.log('crashed:         ' + st.crashed);
  console.log('landed:          ' + st.landed);
  console.log('guide phase:     ' + (gs.phase || '(none)'));
  console.log('maxG:            ' + tr.maxG.toFixed(2));
  console.log('maxQ:            ' + tr.maxQKPa.toFixed(1) + ' kPa');
  console.log('fuel used:       ' + (tr.initialFuelKg - st.bodies.reduce((s, b) => s + (b.fuelMass || 0), 0)).toFixed(0) + ' kg');
  console.log('bodies:');
  st.bodies.forEach(b => {
    const status = b.crashed ? 'CRASHED' :
      b.landed ? 'LANDED' :
      b.settled ? 'settled' :
      b.isDiscarded ? 'discarded' :
      b.isActive ? 'active' :
      'free';
    console.log('  ' + b.id.padEnd(24) + ' | alt=' + b.altitudeKm.toFixed(1).padStart(7) + ' km' +
      ' | ' + status.padEnd(10) +
      ' | fuel=' + b.fuelMass.toFixed(0).padStart(7) + ' kg' +
      ' | roles=' + (b.members.join('>') || '(none)'));
  });
  
  // Chunk timing — first, last, median, in ms. If first is much larger
  // than last, it's a startup artifact. If they're roughly equal, it's
  // steady-state cost we can optimise.
  const ct = st.chunkTimes || [];
  if (ct.length) {
    const times = ct.map(x => x.ms).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log('');
    console.log('chunk timing (' + ct.length + ' chunks of 10 sim-sec):');
    console.log('  first:  ' + ct[0].ms.toFixed(0) + ' ms  (t=' + ct[0].atSim.toFixed(0) + 's)');
    console.log('  median: ' + median.toFixed(0) + ' ms');
    console.log('  last:   ' + ct[ct.length - 1].ms.toFixed(0) + ' ms  (t=' + ct[ct.length - 1].atSim.toFixed(0) + 's)');
  }
}