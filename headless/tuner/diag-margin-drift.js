// headless/tuner/diag-margin-drift.js — why is baseline margin 11.2 s (INNER-2 run) instead of 6.73 s (Step 3)?
//   node tuner/diag-margin-drift.js [--workers 4]        (4 full evals in parallel, ~2-3 min)
// Variants differ ONLY in how (A, lead) reach the sim:
//   V1 raw  G0.60 T4.82      lead 5.53    (Step 3 baseline, unsnapped)
//   V2 raw  G0.60 T4.82      lead 5.525   (isolates lead 5.53 vs tick-snapped 5.525)
//   V3 snap A=13.93944 -> T=4.82     lead 5.525 (isolates raw vs lattice path)
//   V4 snap A=13.94    -> T=4.820125 lead 5.525 (what run-inner2 used: T is 0.000125 s ABOVE the T=4.820 hard transition)
// Prints both margin definitions (post-burn-orbit t_to_apo and pre-burn-apogee-direction) + effective values.
'use strict';
const path = require('path');
const { createEvaluator, loadConfig } = require('./evaluator');
const i = process.argv.indexOf('--workers');
(async () => {
  const cfg = loadConfig(path.join(__dirname, 'tuner-config-v3.json'));
  const ev = createEvaluator(cfg, { workers: i < 0 ? 4 : Number(process.argv[i + 1]) });
  const base = { stage_burn_aoa_bias: 0.59, meco_target_booster_fuel: 52612 };
  const raw = { snap: false, ascent_G: 0.60, ascent_T: 4.82, stride: 1 };
  const V = [
    ['V1 raw   T4.82     lead5.53 ', Object.assign({ circ_trigger_lead: 5.53 }, base), raw],
    ['V2 raw   T4.82     lead5.525', Object.assign({ circ_trigger_lead: 5.525 }, base), raw],
    ['V3 snap  A13.93944 lead5.525', Object.assign({ ascent_profile_constant: 13.93944, circ_trigger_lead: 5.525 }, base), { stride: 1 }],
    ['V4 snap  A13.94    lead5.525', Object.assign({ ascent_profile_constant: 13.94, circ_trigger_lead: 5.525 }, base), { stride: 1 }]
  ];
  const rs = await Promise.all(V.map(([, v, o]) => ev.evaluate(v, o)));
  await ev.close();
  console.log('margin cfg (fixed):', JSON.stringify(cfg.fixed.filter(f => /MARGIN/.test(f.path))));
  const f = (x, d) => x === null || x === undefined ? '--' : Number(x).toFixed(d);
  console.log(['variant', 'T', 'lead', 'E@exit', 'marginPost', 'marginPreApo', 'vrMin', 'vrEnd', 'deploy', 'cleared'].map(s => s.padEnd(15)).join(''));
  rs.forEach((r, k) => { const m = r.metrics, e = r.effective;
    console.log([V[k][0], f(e.ascent_T, 6), f(e.lead, 4), f(m.coastEndEcc, 5), f(m.circEndMarginS, 3), f(m.circEndMarginPreApoS, 3), f(m.circMinVr, 3), f(m.circVrAtEnd, 3), f(m.timeToDeployS, 2), m.payloadCleared].map(s => String(s).padEnd(15)).join('')); });
  console.log('\nReading: V1 ~ 6.73 => Step-3 path reproduced; V1 vs V2 => lead rounding; V2 vs V3 => raw vs lattice; V3 vs V4 => T step 0.000125 across the hard transition.');
})().catch(e => { console.error(e); process.exit(1); });
