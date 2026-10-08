// headless/tuner/diag-determinism.js — reproduce the E drift (0.17116 vs 0.17062) in fresh processes.
//   node tuner/diag-determinism.js [--A 13.94] [--bias 0.59] [--lead 5.525] [--meco 52612]
//        [--raw]            submit raw G=0.60 T=4.82 (bypasses lattice collapse)
//        [--prior]          child first flies a DIFFERENT point (bias 0.9) in the same process (state-leak test, H2)
//        [--workers N]      N>0 uses a worker thread (default 0 = main thread)
//        [--runs 2]         number of fresh processes (default 2)
// Parent spawns fresh `node` children; each child flies the point via evaluator (coastEnd, stride 1) AND a second
// time via evalCore (cache bypass). Compares every metric bit-for-bit (wallMs ignored).
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const argv = process.argv.slice(2);
const has = k => argv.includes('--' + k);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

function pointOf() {
  return {
    ascent_profile_constant: parseFloat(arg('A', '13.94')),
    stage_burn_aoa_bias: parseFloat(arg('bias', '0.59')),
    circ_trigger_lead: parseFloat(arg('lead', '5.525')),
    meco_target_booster_fuel: parseFloat(arg('meco', '52612'))
  };
}
const optsOf = (stride) => has('raw')
  ? { eval: 'coastEnd', stride: stride || parseInt(arg('stride', '1'), 10), snap: false, ascent_G: 0.60, ascent_T: 4.82 }
  : { eval: 'coastEnd', stride: stride || parseInt(arg('stride', '1'), 10) };

// --margin X overrides the fixed insertion.STAGE_BURN_AOA_MARGIN_DEG (config value is used otherwise)
function cfgWithMargin(cfg, margin) {
  const c = JSON.parse(JSON.stringify(cfg));
  const f = c.fixed.find(x => /STAGE_BURN_AOA_MARGIN_DEG/.test(x.path));
  if (f && Number.isFinite(margin)) f.value = margin;
  return c;
}

async function child() {
  const { createEvaluator, loadConfig, evalCore } = require('./evaluator');
  let cfg = loadConfig(path.join(__dirname, 'tuner-config-v3.json'));
  if (has('matrix')) {                                      // stride {1,4} x margin {0.0001,0.001}, one process, cache bypassed
    const pt = pointOf(), rows = [];
    for (const margin of [0.0001, 0.001]) for (const stride of [1, 4]) {
      const r = evalCore(cfgWithMargin(cfg, margin), pt, optsOf(stride)).metrics;
      rows.push({ margin, stride, E: r.coastEndEcc, leadMax: r.coastEndTToApoS, t: r.coastEndT, exact: r.coastEndExactTick, fuel: r.stageFuelAtCoastEndKg });
    }
    process.stdout.write('@@' + JSON.stringify({ matrix: rows }) + '\n');
    process.exit(0);
  }
  if (arg('margin', null) !== null) cfg = cfgWithMargin(cfg, parseFloat(arg('margin', null)));
  const workers = parseInt(arg('workers', '0'), 10);
  const ev = createEvaluator(cfg, { workers });
  const pt = pointOf(), o = optsOf();
  if (has('prior')) await ev.evaluate(Object.assign({}, pt, { stage_burn_aoa_bias: 0.9 }), o);
  const r1 = await ev.evaluate(pt, o);
  const core2 = evalCore(cfg, pt, o);                       // same process, cache bypassed
  await ev.close();
  const pick = m => { const x = Object.assign({}, m); delete x.wallMs; return x; };
  process.stdout.write('@@' + JSON.stringify({
    effective: r1.effective, lattice: r1.lattice,
    m1: pick(r1.metrics), m2: pick(core2.metrics)
  }) + '\n');
  process.exit(0);
}

function diff(a, b, pre, out) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => {
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if (x && y && typeof x === 'object') diff(x, y, pre + k + '.', out);
    else if (!Object.is(x, y)) out.push(pre + k + ': ' + x + '  vs  ' + y);
  });
  return out;
}

if (has('child')) { child().catch(e => { console.error(e); process.exit(1); }); }
else {
  const runs = parseInt(arg('runs', '2'), 10);
  const fwd = argv.filter(a => a !== '--child');
  const res = [];
  for (let i = 0; i < runs; i++) {
    console.log('fresh process ' + (i + 1) + '/' + runs + ' ...');
    const p = spawnSync(process.execPath, [__filename, '--child'].concat(fwd), { encoding: 'utf8', maxBuffer: 1 << 28 });
    const line = (p.stdout || '').split('\n').find(l => l.startsWith('@@'));
    if (!line) { console.error('child failed:\n' + p.stderr); process.exit(1); }
    res.push(JSON.parse(line.slice(2)));
  }
  const f = x => (x === null || x === undefined ? '--' : Number(x).toPrecision(17));
  if (res[0].matrix) {
    console.log('\nmargin    stride  E (coast exit)        lead_max (tToApo)   coastEndT   exact  stageFuel');
    res[0].matrix.forEach(r => console.log(String(r.margin).padEnd(10) + String(r.stride).padEnd(8) + f(r.E).padEnd(22) + f(r.leadMax).padEnd(20) + f(r.t).padEnd(12) + String(r.exact).padEnd(7) + f(r.fuel)));
    console.log('\nReading: rows differing only in stride => stride effect (expect <= 3 ticks = 0.0375 s in lead_max, tiny E shift).\nRows differing only in margin => STAGE_BURN_AOA_MARGIN effect on E / lead_max (H4).');
    process.exit(0);
  }
  console.log('\neffective: ' + JSON.stringify(res[0].effective));
  res.forEach((r, i) => console.log('proc ' + (i + 1) + ': E=' + f(r.m1.coastEndEcc) + '  (2nd run same proc: ' + f(r.m2.coastEndEcc) + ')  t=' + f(r.m1.coastEndT) + ' exact=' + r.m1.coastEndExactTick));
  let bad = 0;
  const rep = (label, d) => { console.log(label + ': ' + (d.length ? d.length + ' DIFFS' : 'identical')); d.slice(0, 15).forEach(s => console.log('   ' + s)); if (d.length) bad++; };
  rep('same process, run 1 vs run 2 (evaluator vs evalCore)', diff(res[0].m1, res[0].m2, '', []));
  for (let i = 1; i < res.length; i++) rep('fresh proc 1 vs proc ' + (i + 1), diff(res[0].m1, res[i].m1, '', []));
  console.log('\nVerdict: ' + (bad ? 'NON-DETERMINISTIC (H2/H3) — see diffs above' :
    'bit-identical => the 0.17116 vs 0.17062 drift comes from different INPUTS (H1: T 4.82 vs 4.820125, lead 5.53 vs 5.525, margin const, stride), not from the sim. Compare with --raw and with/without --prior.'));
  process.exit(bad ? 2 : 0);
}
