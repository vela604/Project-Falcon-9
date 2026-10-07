#!/usr/bin/env node
 // ============================================================================
// headless/regress-step1.js — Step 1 regression helper.
//
//   Capture:  node headless/regress-step1.js capture <out.json> [--duration 1500] [--tunables '<json>']
//   Compare:  node headless/regress-step1.js compare <before.json> <after.json>
//
// Capture runs one leoInsertionV3 sim (quiet) and writes a compact, comparable
// snapshot (no wall times, no sim object). Compare demands EXACT equality of
// every number (determinism => bit-identical is expected).
// ============================================================================
const fs = require('fs');
const { runSim } = require('./runner');

// Keys that Step 1 intentionally removed from the insertion block status.
const REMOVED_KEYS = new Set(['stageBurnLocked', 'stageBurnTargetTiltDeg']);

function compact(result) {
  const st = result.status;
  const gs = Object.assign({}, st.guideStatus || {});
  REMOVED_KEYS.forEach(k => delete gs[k]);
  return {
    guide: result.guideName,
    startOk: result.startOk,
    ticksRun: result.ticksRun,
    haltedByLoop: result.haltedByLoop,
    simTime: st.simTime,
    crashed: st.crashed,
    landed: st.landed,
    tracker: result.tracker,
    guideStatus: gs,
    bodies: st.bodies,
  };
}

function diff(a, b, path, out) {
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach(k => diff(a[k], b[k], path + '.' + k, out));
    return;
  }
  out.push(path + ': ' + JSON.stringify(a) + '  !=  ' + JSON.stringify(b));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'capture') {
  const outFile = rest[0];
  const opts = { guide: 'leoInsertionV3', durationS: 1500, quiet: true };
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--duration') opts.durationS = parseFloat(rest[++i]);
    else if (rest[i] === '--tunables') opts.tunables = JSON.parse(rest[++i]);
  }
  const res = runSim(opts);
  const c = compact(res);
  fs.writeFileSync(outFile, JSON.stringify(c, null, 1));
  const gs = c.guideStatus;
  console.log('captured ->', outFile);
  console.log('  simTime=' + c.simTime.toFixed(2) + ' phase=' + gs.phase +
    ' crashed=' + c.crashed + ' mecoTriggered=' + gs.mecoTriggered +
    ' apogeeKm=' + (gs.apogeeKm != null ? Number(gs.apogeeKm).toFixed(3) : 'n/a') +
    ' deployCmdT=' + gs.deployCommandSimTime);
} else if (mode === 'compare') {
  const a = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
  const b = JSON.parse(fs.readFileSync(rest[1], 'utf8'));
  const out = [];
  diff(a, b, '', out);
  if (!out.length) { console.log('IDENTICAL — regression passed (' + rest[0] + ' == ' + rest[1] + ')');
    process.exit(0); }
  console.log('DIFFERENCES (' + out.length + '):');
  out.slice(0, 60).forEach(l => console.log('  ' + l));
  process.exit(1);
} else {
  console.log('usage: capture <out.json> [--duration S] [--tunables JSON] | compare <a.json> <b.json>');
  process.exit(2);
}