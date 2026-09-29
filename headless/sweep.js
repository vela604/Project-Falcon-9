#!/usr/bin/env node
// ============================================================================
// headless/sweep.js — grid sweep over leoInsertionV2 ascent constants.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const ICS_GRID = [4, 6];
const PT_GRID = [4, 6, 8];
const PD_GRID = [0.4, 1.0, 2.0];
const DURATION_S = 200;

const combosList = [];
for (const ics of ICS_GRID) {
  for (const pt of PT_GRID) {
    for (const pd of PD_GRID) {
      combosList.push({ ics, pt, pd });
    }
  }
}

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(outDir, 'sweep-' + ts + '.json');

console.log('sweep: ' + combosList.length + ' combos x ' + DURATION_S + 's sim');
console.log('output: ' + outFile);
console.log('');

const results = [];
const tStart = Date.now();

for (let i = 0; i < combosList.length; i++) {
  const c = combosList[i];
  const r = runSim({
    guide: 'leoInsertionV2',
    durationS: DURATION_S,
    quiet: true,
    tunables: [
      { path: 'ASCENT.INITIAL_COAST_S',     value: c.ics },
      { path: 'ASCENT.PUSH_T_S',            value: c.pt },
      { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: c.pd },
    ],
  });

  const a = r.status.bodies.find(b => b.isActive) || r.status.bodies[0];
  const gs = r.status.guideStatus || {};
  const apogeeKm = Number.isFinite(gs.apogeeKm) ? gs.apogeeKm : 0;
  const phase = gs.phase || '?';
  const rr = Math.hypot(a.rx, a.ry) || 1;
  const vr = (a.vx * a.rx + a.vy * a.ry) / rr;
  const localVert = Math.atan2(-a.rx, a.ry);
  const tiltDeg = (a.theta - localVert) * 180 / Math.PI;
  const vHoriz = -(a.vx * a.ry - a.vy * a.rx) / rr;

  const row = {
    ics: c.ics, pt: c.pt, pd: c.pd,
    phase: phase,
    crashed: r.status.crashed,
    apogeeKm: apogeeKm,
    altKm: a.altitudeKm,
    vr: vr,
    vHoriz: vHoriz,
    tiltDeg: tiltDeg,
    maxQKPa: r.tracker.maxQKPa,
    maxG: r.tracker.maxG,
    wallMs: r.wallMs,
  };
  results.push(row);

  const elapsed = (Date.now() - tStart) / 1000;
  const etaS = Math.round((elapsed / (i + 1)) * (combosList.length - i - 1));

  console.log(
    String(i + 1).padStart(3) + '/' + combosList.length +
    '  ics=' + c.ics.toFixed(1) +
    ' pt=' + c.pt.toFixed(1) +
    ' pd=' + c.pd.toFixed(2) +
    '  apogee=' + apogeeKm.toFixed(1).padStart(6) + 'km' +
    '  phase=' + phase.padEnd(12) +
    '  tilt=' + tiltDeg.toFixed(1).padStart(6) + 'deg' +
    '  vH=' + vHoriz.toFixed(0).padStart(5) +
    '  cr=' + (r.status.crashed ? 'Y' : 'N') +
    '  maxQ=' + r.tracker.maxQKPa.toFixed(1).padStart(6) +
    '  eta=' + etaS + 's'
  );
}

fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log('');
console.log('--- top 10 by apogee (no crash) ---');
const ok = results.filter(r => !r.crashed);
ok.sort((a, b) => b.apogeeKm - a.apogeeKm);
ok.slice(0, 10).forEach(r => {
  console.log(
    'ics=' + r.ics.toFixed(1) + ' pt=' + r.pt.toFixed(1) + ' pd=' + r.pd.toFixed(2) +
    '  apogee=' + r.apogeeKm.toFixed(1) + 'km' +
    '  phase=' + r.phase +
    '  tilt=' + r.tiltDeg.toFixed(1) + 'deg' +
    '  vH=' + r.vHoriz.toFixed(0)
  );
});
console.log('');
console.log('saved: ' + outFile);