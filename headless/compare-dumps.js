// headless/compare-dumps.js
const fs = require('fs');
const path = require('path');

const numRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'tester-dump.json'), 'utf8'));
const runRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'tester-dump1.json'), 'utf8'));

// Dedupe by simTime (keep LAST entry per simTime)
const numMap = new Map();
let numDupes = 0;
for (const r of numRaw) {
  const key = r.t.toFixed(9);
  if (numMap.has(key)) numDupes++;
  numMap.set(key, r);
}
const runMap = new Map();
let runDupes = 0;
for (const r of runRaw) {
  const key = r.t.toFixed(9);
  if (runMap.has(key)) runDupes++;
  runMap.set(key, r);
}

console.log('Numerical raw ticks: ', numRaw.length, '(' + numDupes + ' dupes removed)');
console.log('Runner raw ticks:    ', runRaw.length, '(' + runDupes + ' dupes removed)');
console.log('Numerical unique:    ', numMap.size);
console.log('Runner unique:       ', runMap.size);
console.log('');

const FIELDS = ['rx', 'ry', 'vx', 'vy', 'theta', 'omega', 'fuelMass'];
const TOL = 1e-6;

let matched = 0, onlyNum = 0, onlyRun = 0, diffs = 0;
const diffSamples = [];

for (const [key, a] of numMap) {
  const b = runMap.get(key);
  if (!b) { onlyNum++; continue; }
  matched++;
  if (a.bodies.length !== b.bodies.length) {
    if (diffs < 20) diffSamples.push('t=' + key + ' bodyCount: ' + a.bodies.length + ' vs ' + b.bodies.length);
    diffs++; continue;
  }
  for (let j = 0; j < a.bodies.length; j++) {
    const bA = a.bodies[j], bB = b.bodies[j];
    for (const k of FIELDS) {
      const va = bA[k], vb = bB[k];
      if (Math.abs(va - vb) > TOL) {
        if (diffs < 20) diffSamples.push('t=' + key + ' body' + j + '.' + k + ': ' + va + ' vs ' + vb);
        diffs++;
      }
    }
    const eA = bA.engines || [], eB = bB.engines || [];
    if (eA.length !== eB.length) {
      if (diffs < 20) diffSamples.push('t=' + key + ' body' + j + ' engCount: ' + eA.length + ' vs ' + eB.length);
      diffs++;
    } else {
      for (let k = 0; k < eA.length; k++) {
        const va = eA[k].massFlowRate || 0;
        const vb = eB[k].massFlowRate || 0;
        if (Math.abs(va - vb) > 1e-6) {
          if (diffs < 20) diffSamples.push('t=' + key + ' body' + j + ' eng' + k + '.mdot: ' + va + ' vs ' + vb);
          diffs++;
        }
      }
    }
  }
}

for (const [key] of runMap) {
  if (!numMap.has(key)) onlyRun++;
}

console.log('Matched timestamps:  ', matched);
console.log('Only in numerical:   ', onlyNum);
console.log('Only in runner:      ', onlyRun);
console.log('Field diffs:         ', diffs);
console.log('');
if (diffs > 0) {
  console.log('First diffs:');
  diffSamples.forEach(d => console.log('  ' + d));
} else if (matched > 100) {
  console.log('✓ BIT-IDENTICAL on all ' + matched + ' matched timestamps');
} else if (matched > 0) {
  console.log('⚠ Only ' + matched + ' matched — not enough data');
} else {
  console.log('✗ No matched timestamps — dumps misaligned');
}