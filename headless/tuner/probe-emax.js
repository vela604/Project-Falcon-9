// headless/tuner/probe-emax.js — E_max probe: FULL evals along a bias sweep at fixed A.
//   node tuner/probe-emax.js                       # A=13.97, bias 0.4..0.9 (6 evals)
//   node tuner/probe-emax.js --a 13.97 --biases 0.4,0.5,0.6 --workers 6 --meco 52612 --lead 5.525
// Per eval: payloadCleared, apo/peri/ecc, stageResidualKg, deploy time, circ margin/vr, hard fails,
// plus coastEndEcc (must equal the emap cell: stride 1 is deterministic) -> E vs mission outcome.
// Output: emax-probe.json + table. Tolerance (PROMPT.md): +-1 km apo/peri, ecc 0.0005.
'use strict';
const fs = require('fs'), path = require('path');
const { createEvaluator, loadConfig } = require('./evaluator');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const A = Number(arg('--a', 13.97)), meco = Number(arg('--meco', 52612)), lead = Number(arg('--lead', 5.525));
const biases = arg('--biases', '0.4,0.5,0.6,0.7,0.8,0.9').split(',').map(Number);
const workers = arg('--workers', undefined);
const outDir = arg('--out-dir', __dirname);
const cfg = loadConfig(arg('--config', path.join(__dirname, 'tuner-config-v3.json')));
const margin = (cfg.fixed.find(f => /MARGIN/.test(f.path)) || {}).value;
const TOL = { km: 1, ecc: 0.0005 };
const f = (x, d) => x === null || x === undefined ? '--' : Number(x).toFixed(d);

(async () => {
  console.log('E_max probe: A=' + A + ' MECO=' + meco + ' lead=' + lead + ' margin(config fixed)=' + margin + '  biases ' + biases.join(','));
  const ev = createEvaluator(cfg, workers !== undefined ? { workers: Number(workers) } : {});
  const list = biases.map(b => ({ ascent_profile_constant: A, stage_burn_aoa_bias: b, meco_target_booster_fuel: meco, circ_trigger_lead: lead }));
  const t0 = Date.now();
  const rs = await ev.evaluateMany(list, { stride: 1 });          // full eval, exact-tick coastEnd recorded too
  await ev.close();
  const rows = rs.map((r, i) => {
    const m = r.metrics;
    const inTol = m.payloadCleared && m.apogeeKm !== null &&
      Math.abs(m.apogeeKm - 320) <= TOL.km && Math.abs(m.perigeeKm - 320) <= TOL.km && m.ecc <= TOL.ecc;
    return { bias: r.effective.bias, A_eff: r.effective.A_eff, coastEndEcc: m.coastEndEcc, coastEndT: m.coastEndT,
      stageFuelAtCoastEndKg: m.stageFuelAtCoastEndKg, payloadCleared: m.payloadCleared, apoKm: m.apogeeKm, periKm: m.perigeeKm,
      ecc: m.ecc, stageResidualKg: m.stageResidualKg, deployS: m.timeToDeployS, circBurnS: m.circBurnS,
      circEndMarginS: m.circEndMarginS, circMinVr: m.circMinVr, circVrAtEnd: m.circVrAtEnd, boosterFuelLeftKg: m.boosterFuelLeftKg,
      hardFail: r.hardFail, failures: r.failures.map(x => x.id), stopReason: m.stopReason, inTolerance: inTol, wallMs: m.wallMs };
  });
  console.log('\n' + ['bias', 'E@coastEnd', 'fuel@cEnd', 'cleared', 'apo', 'peri', 'ecc', 'residual', 'deploy', 'burnS', 'margin', 'vrMin', 'vrEnd', 'tol', 'fails'].map(s => s.padStart(11)).join(''));
  rows.forEach(x => console.log([f(x.bias, 2), f(x.coastEndEcc, 4), f(x.stageFuelAtCoastEndKg, 0), x.payloadCleared, f(x.apoKm, 3), f(x.periKm, 3),
    f(x.ecc, 5), f(x.stageResidualKg, 1), f(x.deployS, 2), f(x.circBurnS, 1), f(x.circEndMarginS, 2), f(x.circMinVr, 3), f(x.circVrAtEnd, 3),
    x.inTolerance ? 'OK' : 'NO', x.failures.join('+') || '-'].map(s => String(s).padStart(11)).join('')));
  const res = rows.map(x => x.stageResidualKg).filter(v => v !== null);
  if (res.length) console.log('\nresidual spread across cleared evals: min ' + Math.min(...res).toFixed(1) + '  max ' + Math.max(...res).toFixed(1) + '  (hypothesis ~849 const)');
  const okE = rows.filter(x => x.inTolerance).map(x => x.coastEndEcc), badE = rows.filter(x => !x.inTolerance).map(x => x.coastEndEcc);
  console.log('E in-tolerance max: ' + (okE.length ? Math.max(...okE).toFixed(4) : 'none') + '   E out-of-tolerance min: ' + (badE.length ? Math.min(...badE).toFixed(4) : 'none') + '   => E_max lies between (if monotone in this sweep)');
  console.log('wall ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  fs.writeFileSync(path.join(outDir, 'emax-probe.json'), JSON.stringify({ A, meco, lead, margin, rows }, null, 1));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
