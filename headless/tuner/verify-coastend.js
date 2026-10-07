// headless/tuner/verify-coastend.js — Step 6 baseline sanity check (needs the REAL sim tree).
//   node tuner/verify-coastend.js
// Runs ONE full eval at raw baseline defaults (G 0.60, T 4.82, lead 5.53, bias 0.59, MECO 52612)
// with stride 1, and compares the eccentricity at COAST_ROTATE ENTRY (old M.coast) vs EXIT (new M.coastEnd).
// Expect: exit != entry (RCS boost + rotation change the orbit) and exit ~ manual reference E.
// If entry == exit (bit-identical) => transitions are being missed: that is a BUG.
'use strict';
const { evalCore, loadConfig } = require('./evaluator');
const path = require('path');
const cfg = loadConfig(path.join(__dirname, 'tuner-config-v3.json'));
const r = evalCore(cfg, {}, { snap: false, ascent_G: 0.60, ascent_T: 4.82, stride: 1 });
const m = r.metrics;
const row = (k, v) => console.log('  ' + k.padEnd(26) + v);
console.log('baseline full eval (stride 1):  stop=' + m.stopReason + '  deploy=' + m.timeToDeployS + ' s  apo/peri=' + m.apogeeKm + '/' + m.perigeeKm);
row('entry t / exit t', m.phaseT.COAST_ROTATE + ' / ' + m.coastEndT + '   (rotate duration ' + (m.coastEndT - m.phaseT.COAST_ROTATE).toFixed(4) + ' s)');
row('exit -> phase', m.coastEndToPhase + '   exactTick=' + m.coastEndExactTick);
row('ecc entry', m.coastEcc);
row('ecc EXIT (coastEndEcc)', m.coastEndEcc);
row('apo/peri entry km', m.coastApoKm + ' / ' + m.coastPeriKm);
row('apo/peri exit km', m.coastEndApoKm + ' / ' + m.coastEndPeriKm);
row('vr exit m/s', m.coastEndVr);
row('stage fuel entry/exit kg', m.stageFuelAtCoastKg + ' / ' + m.stageFuelAtCoastEndKg);
const same = m.coastEcc === m.coastEndEcc;
console.log(same ? '\nFAIL: entry ecc == exit ecc (bit-identical) -> transition missed / wrong phase.' :
  '\nOK: exit differs from entry (' + (m.coastEndEcc / m.coastEcc).toFixed(3) + 'x). Compare coastEndEcc with your manual reference E by eye.');
if (!m.coastEndExactTick) console.log('WARNING: transition not caught on exact tick.');
process.exit(same || !m.coastEndExactTick ? 1 : 0);
