#!/usr/bin/env node
// ============================================================================
// headless/tuner/scan1d.js — 1D scan over a single tunable.
//
// Other tunables default to (T=4.82, lead=5.525, bias=0.59, margin=0.001,
// meco=52612) via snap=false mode. Override with --fix '<json>'.
//
// Usage:
//   node headless/tuner/scan1d.js --tunable meco_target_booster_fuel \
//        --from 50000 --to 80000 --step 2000
//   node headless/tuner/scan1d.js --tunable stage_burn_aoa_bias \
//        --from 0.40 --to 0.75 --step 0.05
//   node headless/tuner/scan1d.js --tunable circ_trigger_lead \
//        --from 5.40 --to 5.60 --step 0.01 \
//        --fix '{"meco_target_booster_fuel": 55000}'
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const EV = require('./evaluator');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

function findConfig() {
  const c = arg('config', null);
  if (c) return path.resolve(c);
  const cands = [
    path.join(__dirname, 'tuner-config-v3.json'),
    path.join(process.cwd(), 'tuner', 'tuner-config-v3.json'),
  ];
  return cands.find(p => fs.existsSync(p)) || (() => { throw new Error('config not found'); })();
}

const CFG_PATH = findConfig();
const OUT_DIR = path.join(path.dirname(CFG_PATH), 'out');
const TUNABLE = arg('tunable', null);
const V_FROM = parseFloat(arg('from', null));
const V_TO   = parseFloat(arg('to', null));
const V_STEP = parseFloat(arg('step', null));
const WORKERS = parseInt(arg('workers', String(Math.min(6, os.cpus().length || 6))), 10);
const FIX = JSON.parse(arg('fix', '{}'));

if (!TUNABLE || !Number.isFinite(V_FROM) || !Number.isFinite(V_TO) || !Number.isFinite(V_STEP)) {
  console.error('usage: node scan1d.js --tunable <id> --from <x> --to <y> --step <dx> [--fix <json>] [--workers N]');
  process.exit(2);
}

const f = (x, d) => (x === null || x === undefined || !Number.isFinite(x)) ? 'n/a' : x.toFixed(d === undefined ? 3 : d);

function range(from, to, step) {
  const out = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Number((from + i * step).toFixed(8)));
  return out;
}

async function main() {
  const cfg = EV.loadConfig(CFG_PATH);
  cfg.evaluator = Object.assign(cfg.evaluator || {}, { fast: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const vals = range(V_FROM, V_TO, V_STEP);
  console.log('config :', CFG_PATH);
  console.log('tunable:', TUNABLE);
  console.log('range  :', V_FROM, 'to', V_TO, 'step', V_STEP, '=>', vals.length, 'points');
  console.log('fix    :', JSON.stringify(FIX));
  console.log('workers:', WORKERS);
  console.log('');

  const ev = EV.createEvaluator(cfg, { workers: WORKERS });
  const rows = [];
  const t0 = Date.now();

  for (const v of vals) {
    const values = Object.assign({}, FIX);
    values[TUNABLE] = v;
    const r = await ev.evaluate(values, { snap: false, ascent_G: 0.60, ascent_T: 4.82 });
    const m = r.metrics;
    rows.push({
      value: v,
      deploy: m.timeToDeployS,
      vrEnd: m.circVrAtEnd,
      vrMin: m.circMinVr,
      margin: m.circEndMarginS,
      apo: m.apogeeKm,
      peri: m.perigeeKm,
      ecc: m.ecc,
      boosterFuelKg: m.boosterFuelLeftKg,
      stageResidualKg: m.stageResidualKg,
      mecoT: m.mecoT,
      score: r.score,
      hardFail: r.hardFail,
      failIds: r.hardFail ? r.failures.map(x => x.id).join('|') : ''
    });
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write('\r  ' + rows.length + '/' + vals.length + '  (' + el + 's)');
  }
  console.log('\n');
  await ev.close();

  console.log('  value'.padEnd(14) + 'deploy'.padStart(9) + 'vrEnd'.padStart(9) + 'vrMin'.padStart(9) +
    'margin'.padStart(9) + 'mecoT'.padStart(9) + 'booster'.padStart(9) + 'residual'.padStart(10) +
    'apo(km)'.padStart(10) + 'ecc*1e6'.padStart(10) + 'score'.padStart(11) + '  status');
  console.log('  ' + '-'.repeat(140));
  rows.forEach(r => {
    console.log(
      '  ' + String(r.value).padEnd(12) +
      f(r.deploy, 2).padStart(9) +
      f(r.vrEnd, 4).padStart(9) +
      f(r.vrMin, 3).padStart(9) +
      f(r.margin, 2).padStart(9) +
      f(r.mecoT, 2).padStart(9) +
      f(r.boosterFuelKg, 0).padStart(9) +
      f(r.stageResidualKg, 1).padStart(10) +
      f(r.apo, 3).padStart(10) +
      f(r.ecc * 1e6, 1).padStart(10) +
      f(r.score, 2).padStart(11) +
      '  ' + (r.hardFail ? 'FAIL:' + r.failIds : 'ok')
    );
  });

  const csvPath = path.join(OUT_DIR, 'scan1d_' + TUNABLE + '.csv');
  const hdr = 'value,deploy,vrEnd,vrMin,margin,mecoT,boosterFuelKg,stageResidualKg,apo,peri,ecc,score,hardFail,failIds';
  fs.writeFileSync(csvPath, [hdr].concat(rows.map(r =>
    [r.value, r.deploy, r.vrEnd, r.vrMin, r.margin, r.mecoT, r.boosterFuelKg, r.stageResidualKg,
     r.apo, r.peri, r.ecc, r.score, r.hardFail ? 1 : 0, r.failIds].join(','))).join('\n'));
  console.log('\n  ' + csvPath);
}

main().catch(e => { console.error(e); process.exit(1); });