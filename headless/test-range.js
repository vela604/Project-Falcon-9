#!/usr/bin/env node
// ============================================================================
// headless/test-range.js — run FULL missions at a few PUSH_MAX_GIMBAL_DEG
// values inside the MECO-tilt 55-60° bracket, and report end-to-end outcome.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { runSim } = require('./runner');

const CANDIDATES = [
  0.09576,   // bracket lo  — MECO tilt ≈ 55.3°
  0.09900,   // midpoint
  0.10219,   // bracket hi  — MECO tilt ≈ 59.6°
];

const DURATION_S = 1500;

const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(outDir, 'range-' + ts + '.json');

console.log('=== full-mission range test ===');
console.log('candidates: ' + CANDIDATES.join(', '));
console.log('duration: ' + DURATION_S + 's per run');
console.log('');

const results = [];

for (const pd of CANDIDATES) {
  console.log('running pd=' + pd.toFixed(5) + ' …');
  const r = runSim({
    guide: 'leoInsertionV2',
    durationS: DURATION_S,
    quiet: true,
    tunables: [
      { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: pd },
    ],
  });

  const gs = r.status.guideStatus || {};
  const bodies = r.status.bodies || [];
  const active = bodies.find(b => b.isActive) || bodies[0];
  const payload = bodies.find(b => b.payloadReleased);

  const row = {
    pd,
    finalPhase: gs.phase || '?',
    crashed: r.status.crashed,
    landed: r.status.landed,
    simTime: r.status.simTime,
    wallMs: r.wallMs,
    // Ascent / MECO
    mecoTiltDeg: null,       // not captured by runner; captured below
    apogeeKm: Number.isFinite(gs.apogeeKm) ? gs.apogeeKm : null,
    perigeeKm: Number.isFinite(gs.perigeeKm) ? gs.perigeeKm : null,
    // Orbit
    circAchieved: !!gs.circAchieved,
    coastTargetThetaDeg: gs.coastTargetThetaDeg,
    coast2TargetThetaDeg: gs.coast2TargetThetaDeg,
    // Payload
    payloadReleased: !!(payload),
    payloadBodyAltKm: payload ? payload.altitudeKm : null,
    payloadBodyCrashed: payload ? payload.crashed : null,
    // Active body
    activeAltKm: active ? active.altitudeKm : null,
    activeFuelKg: active ? active.fuelMass : null,
    // Fuel across all bodies
    totalFuelLeftKg: bodies.reduce((s, b) => s + (b.fuelMass || 0), 0),
    fuelUsedKg: r.tracker.initialFuelKg - bodies.reduce((s, b) => s + (b.fuelMass || 0), 0),
    maxG: r.tracker.maxG,
    maxQKPa: r.tracker.maxQKPa,
  };
  results.push(row);

  console.log(
    '  phase=' + row.finalPhase.padEnd(14) +
    ' cr=' + (row.crashed ? 'Y' : 'N') +
    ' apogee=' + (row.apogeeKm != null ? row.apogeeKm.toFixed(1) : '—') + 'km' +
    ' peri=' + (row.perigeeKm != null ? row.perigeeKm.toFixed(1) : '—') + 'km' +
    ' circ=' + (row.circAchieved ? 'Y' : 'N') +
    ' payload=' + (row.payloadReleased ? 'Y' : 'N') +
    ' fuelUsed=' + row.fuelUsedKg.toFixed(0) + 'kg' +
    ' maxQ=' + row.maxQKPa.toFixed(0) + 'kPa'
  );
}

fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

console.log('');
console.log('=== summary table ===');
console.log('pd         finalPhase      apogee    peri     circ  payload  fuelUsed  maxQ');
console.log('-'.repeat(82));
for (const r of results) {
  console.log(
    r.pd.toFixed(5).padStart(9) + '  ' +
    r.finalPhase.padEnd(14) + '  ' +
    (r.apogeeKm != null ? r.apogeeKm.toFixed(1) : '—').padStart(7) + '  ' +
    (r.perigeeKm != null ? r.perigeeKm.toFixed(1) : '—').padStart(7) + '  ' +
    (r.circAchieved ? 'Y' : 'N').padStart(4) + '  ' +
    (r.payloadReleased ? 'Y' : 'N').padStart(7) + '  ' +
    r.fuelUsedKg.toFixed(0).padStart(8) + '  ' +
    r.maxQKPa.toFixed(0).padStart(4)
  );
}

console.log('');
console.log('saved: ' + outFile);