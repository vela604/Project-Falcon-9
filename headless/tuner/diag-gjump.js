// headless/tuner/diag-gjump.js — is a G-segment jump (A ~ 14.0558) a real discontinuity of E, or smooth along A_eff?
//   node tuner/diag-gjump.js [--bias 0.6,1.0] [--meco 52612] [--lead 5.525] [--workers 6] [--scan 14.04,14.07]
// Finds the G jump (G 0.60 -> 0.61) by scanning A, then evaluates coastEnd E (stride 1) at 3 points per bias:
//   LO   last A before the jump        (G .60, T ~ 4.84)
//   HI   first A after the jump        (G .61, T ~ 4.80)   -> A_eff differs by ~1e-4 only
//   CTL  LO shifted down by the SAME A distance (HI - LO) inside G .60 (control: pure A_eff effect, no G change)
// Compare |E(HI)-E(LO)| with |E(LO)-E(CTL)|. 2 biases x 3 points = 6 evals = one parallel round (~90 s with 6 workers).
'use strict';
const path = require('path');
const { createEvaluator, loadConfig, collapseAscent } = require('./evaluator');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

(async () => {
  const cfg = loadConfig(path.join(__dirname, 'tuner-config-v3.json'));
  const tA = cfg.tunables.find(t => t.id === 'ascent_profile_constant');
  const [lo0, hi0] = arg('scan', '14.04,14.07').split(',').map(Number);
  const biases = arg('bias', '0.6,1.0').split(',').map(Number);
  const meco = Number(arg('meco', '52612')), lead = Number(arg('lead', '5.525'));

  // locate the jump at 1e-5 resolution
  let A_lo = null, A_hi = null;
  for (let A = lo0; A < hi0; A += 0.00001) {
    const a = Number(A.toFixed(5)), b = Number((A + 0.00001).toFixed(5));
    if (collapseAscent(tA, a).G !== collapseAscent(tA, b).G) { A_lo = a; A_hi = b; break; }
  }
  if (A_lo === null) { console.error('no G jump found in [' + lo0 + ',' + hi0 + ']'); process.exit(1); }
  const dA = Number((A_hi - A_lo).toFixed(5));
  // LO/HI are adjacent on the 1e-5 grid; make the pair wider so each has its own distinct T lattice point
  const ctl = Number((A_lo - dA).toFixed(5));
  const pts = [['CTL', ctl], ['LO ', A_lo], ['HI ', A_hi]];
  pts.forEach(([n, A]) => { const c = collapseAscent(tA, A); console.log(n + ' A=' + A + '  G=' + c.G + ' T=' + c.T.toFixed(6) + ' Tn=' + c.Tn + ' A_eff=' + c.A_eff.toFixed(6)); });

  const ev = createEvaluator(cfg, { workers: Number(arg('workers', '6')) });
  const list = [];
  biases.forEach(b => pts.forEach(([, A]) => list.push({ ascent_profile_constant: A, stage_burn_aoa_bias: b, meco_target_booster_fuel: meco, circ_trigger_lead: lead })));
  const rs = await ev.evaluateMany(list, { eval: 'coastEnd', stride: 1 });
  await ev.close();

  const f = (x, d) => (x === null || x === undefined ? '--' : Number(x).toFixed(d));
  console.log('\nmargin (config fixed): ' + JSON.stringify(cfg.fixed.filter(x => /MARGIN/.test(x.path))));
  console.log(['bias', 'pt', 'G', 'T', 'A_eff', 'E', 'lead_max', 'coastEndT'].map(s => s.padEnd(13)).join(''));
  let k = 0;
  biases.forEach(b => {
    const E = {};
    pts.forEach(([n]) => {
      const r = rs[k++], m = r.metrics, e = r.effective;
      E[n.trim()] = m.coastEndEcc;
      console.log([f(b, 4), n, e.ascent_G, f(e.ascent_T, 6), f(e.A_eff, 6), f(m.coastEndEcc, 8), f(m.coastEndTToApoS, 3), f(m.coastEndT, 3)].map(s => String(s).padEnd(13)).join(''));
    });
    const dJump = Math.abs(E.HI - E.LO), dCtl = Math.abs(E.LO - E.CTL);
    const ratio = dCtl > 0 ? dJump / dCtl : Infinity;
    console.log('  bias ' + b + ': |E(HI)-E(LO)| = ' + dJump.toExponential(3) + '  |E(LO)-E(CTL)| = ' + dCtl.toExponential(3) + '  ratio = ' + ratio.toFixed(1) +
      (ratio > 10 ? '  => G jump is a REAL discontinuity (search G segments independently)' :
       ratio < 3 ? '  => no extra jump effect: E smooth along A_eff here (segments could be merged)' : '  => inconclusive (3..10)'));
  });
  console.log('\nNote: LO and HI have (nearly) the same A_eff but different (G, T). CTL differs from LO by the same A_eff step with G unchanged.');
})().catch(e => { console.error(e); process.exit(1); });
