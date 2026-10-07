#!/usr/bin/env node
// ============================================================================
// headless/tuner/scan2d.js — 2D scan over ascent T x circ lead.
//
// Motivation (Step 3 diag): ascent T and circ lead are COUPLED — the circ
// burn's end margin depends on both, and there is a hard feasibility CLIFF
// at circVrAtEnd=0. Manual best (T=4.82, lead=5.53) sits 0.006 m/s above
// the safety min = knife edge. A pure 1D P1 (T scan at fixed lead) or P4
// (lead scan at fixed T) explores a diagonal slice of the real search
// space, not the ridge.
//
// This script scans the ridge directly so Step 4 (P1+P4 combined) has a
// joint anchor.
//
// Usage:
//   node headless/tuner/scan2d.js
//   node headless/tuner/scan2d.js --t-from 4.816 --t-to 4.834 --t-step 0.002
//   node headless/tuner/scan2d.js --lead-from 3.9 --lead-to 5.6 --lead-step 0.1
//   node headless/tuner/scan2d.js --workers 6
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
    path.join(process.cwd(), 'tuner-config-v3.json')
  ];
  const f = cands.find(p => fs.existsSync(p));
  if (!f) throw new Error('config not found; pass --config');
  return f;
}

const CFG_PATH = findConfig();
const OUT_DIR = path.join(path.dirname(CFG_PATH), 'out');

const T_FROM = parseFloat(arg('t-from', '4.816'));
const T_TO   = parseFloat(arg('t-to',   '4.834'));
const T_STEP = parseFloat(arg('t-step', '0.002'));
const L_FROM = parseFloat(arg('lead-from', '3.90'));
const L_TO   = parseFloat(arg('lead-to',   '5.60'));
const L_STEP = parseFloat(arg('lead-step', '0.10'));
const WORKERS = parseInt(arg('workers', String(Math.min(6, os.cpus().length || 6))), 10);

const f = (x, d) => (x === null || x === undefined || !Number.isFinite(x)) ? 'n/a' : x.toFixed(d === undefined ? 3 : d);

function range(from, to, step) {
  const out = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Number((from + i * step).toFixed(6)));
  return out;
}

async function main() {
  const cfg = EV.loadConfig(CFG_PATH);
  cfg.evaluator = Object.assign(cfg.evaluator || {}, { fast: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const Ts = range(T_FROM, T_TO, T_STEP);
  const Ls = range(L_FROM, L_TO, L_STEP);
  const total = Ts.length * Ls.length;

  console.log('config   :', CFG_PATH);
  console.log('T grid   :', Ts.length, 'values from', T_FROM, 'to', T_TO, '(step ' + T_STEP + ')');
  console.log('lead grid:', Ls.length, 'values from', L_FROM, 'to', L_TO, '(step ' + L_STEP + ')');
  console.log('total    :', total, 'evals');
  console.log('workers  :', WORKERS, '(0 = in-process)');
  console.log('');

  const ev = EV.createEvaluator(cfg, { workers: WORKERS });
  const rows = [];
  const t0 = Date.now();
  let done = 0;

  for (const T of Ts) {
    const valuesList = Ls.map(L => ({ circ_trigger_lead: L }));
    const opts = { snap: false, ascent_G: 0.60, ascent_T: T };
    const results = await ev.evaluateMany(valuesList, opts);
    results.forEach((r, i) => {
      const m = r.metrics;
      rows.push({
        T: T, T_ticks: T * 80,
        lead: Ls[i], lead_ticks: Math.round(Ls[i] * 80),
        deploy: m.timeToDeployS,
        vrEnd: m.circVrAtEnd,
        vrMin: m.circMinVr,
        margin: m.circEndMarginS,
        apo: m.apogeeKm,
        peri: m.perigeeKm,
        ecc: m.ecc,
        boosterFuelKg: m.boosterFuelLeftKg,
        stageResidualKg: m.stageResidualKg,
        score: r.score,
        hardFail: r.hardFail,
        failureIds: r.hardFail ? r.failures.map(x => x.id).join('|') : ''
      });
      done++;
    });
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write('\r  ' + done + '/' + total + ' evals (' + el + 's, ' +
      ((Date.now() - t0) / Math.max(1, done)).toFixed(0) + ' ms/eval)');
  }
  console.log('\n');
  await ev.close();

  const jsonPath = path.join(OUT_DIR, 'scan2d.json');
  const csvPath = path.join(OUT_DIR, 'scan2d.csv');
  fs.writeFileSync(jsonPath, JSON.stringify({
    when: new Date().toISOString(),
    config: CFG_PATH,
    range: { T: [T_FROM, T_TO, T_STEP], lead: [L_FROM, L_TO, L_STEP] },
    rows: rows
  }, null, 2));
  const header = 'T,T_ticks,lead,lead_ticks,deploy,vrEnd,vrMin,margin,apo,peri,ecc,boosterFuelKg,stageResidualKg,score,hardFail,failureIds';
  const csv = [header].concat(rows.map(r => [
    r.T, r.T_ticks.toFixed(2), r.lead, r.lead_ticks, r.deploy, r.vrEnd, r.vrMin, r.margin,
    r.apo, r.peri, r.ecc, r.boosterFuelKg, r.stageResidualKg, r.score,
    r.hardFail ? 1 : 0, r.failureIds
  ].join(','))).join('\n');
  fs.writeFileSync(csvPath, csv);

  console.log('=== DEPLOY TIME GRID ===');
  console.log('  rows = ascent T (top = higher T);  cols = circ lead (left = earlier burn, higher margin)');
  console.log('  cell = deploy seconds (0 dec);  FAIL = hard-failed eval');
  console.log('');
  let h1 = '         ';
  Ls.forEach(L => { h1 += String(Math.round(L * 80)).padStart(7); });
  console.log(h1 + '   (lead ticks)');
  Ts.forEach(T => {
    let line = (T * 80).toFixed(1).padStart(6) + '  ';
    Ls.forEach(L => {
      const r = rows.find(x => x.T === T && x.lead === L);
      if (!r) { line += '   -   '; return; }
      if (r.hardFail) { line += '  FAIL '; return; }
      line += r.deploy.toFixed(0).padStart(7);
    });
    console.log(line + '   T=' + T.toFixed(4) + 's');
  });

  console.log('');
  console.log('=== vrEnd GRID (feasibility cliff at 0) ===');
  console.log('  negative -> fail side;  positive = feasible;  safety min from config');
  console.log('');
  let h2 = '         ';
  Ls.forEach(L => { h2 += String(Math.round(L * 80)).padStart(7); });
  console.log(h2 + '   (lead ticks)');
  Ts.forEach(T => {
    let line = (T * 80).toFixed(1).padStart(6) + '  ';
    Ls.forEach(L => {
      const r = rows.find(x => x.T === T && x.lead === L);
      if (!r) { line += '   -   '; return; }
      if (r.hardFail && r.vrEnd !== null && r.vrEnd < 0) {
        line += ('  ' + r.vrEnd.toFixed(2)).padStart(7);
        return;
      }
      line += f(r.vrEnd, 3).padStart(7);
    });
    console.log(line + '   T=' + T.toFixed(4) + 's');
  });

  console.log('');
  console.log('=== RIDGE  (per T, feasible cell with margin closest to 4.0 s) ===');
  const safetyMin = cfg.scoring.hardConstraints.circVrAtEndMinMps.min;
  console.log('  constraint: !hardFail  &&  circVrAtEnd >= ' + safetyMin + ' m/s (config)');
  console.log('');
  console.log('  T(ticks)  T(s)      lead(ticks)  lead(s)  deploy    vrEnd     margin    apo(km)   peri(km)  ecc*1e6  booster   residual');
  Ts.forEach(T => {
    const cands = rows.filter(r =>
      r.T === T && !r.hardFail && r.vrEnd !== null && r.vrEnd >= safetyMin && r.margin !== null
    );
    if (!cands.length) {
      console.log('  ' + (T * 80).toFixed(1).padStart(7) + '  ' + T.toFixed(4).padStart(7) + '   (no feasible cell in this T row)');
      return;
    }
    const best = cands.reduce((a, b) => Math.abs(a.margin - 4) < Math.abs(b.margin - 4) ? a : b);
    console.log(
      '  ' + (T * 80).toFixed(1).padStart(7) + '  ' + T.toFixed(4).padStart(7) +
      '  ' + String(best.lead_ticks).padStart(11) + '  ' + best.lead.toFixed(4).padStart(7) +
      '  ' + best.deploy.toFixed(2).padStart(7) + '  ' + best.vrEnd.toFixed(4).padStart(7) +
      '  ' + best.margin.toFixed(2).padStart(8) + '  ' + best.apo.toFixed(3).padStart(8) +
      '  ' + best.peri.toFixed(3).padStart(8) + '  ' + (best.ecc * 1e6).toFixed(1).padStart(7) +
      '  ' + best.boosterFuelKg.toFixed(0).padStart(7) + '  ' + best.stageResidualKg.toFixed(1).padStart(8)
    );
  });

  console.log('');
  console.log('=== BEST OVERALL (min deploy among feasible cells with margin in [3.9, 8] s) ===');
  const validRange = rows.filter(r => !r.hardFail && r.vrEnd >= safetyMin && r.margin >= 3.9 && r.margin <= 8);
  if (!validRange.length) {
    console.log('  (no cell in margin range; ridge constraint too tight?)');
  } else {
    validRange.sort((a, b) => a.deploy - b.deploy);
    const top = validRange.slice(0, 8);
    console.log('  rank  T(ticks)  T(s)      lead(ticks)  deploy    vrEnd     margin    apo(km)   ecc*1e6  score');
    top.forEach((r, i) => {
      console.log(
        '  ' + String(i + 1).padStart(3) + '   ' + (r.T * 80).toFixed(1).padStart(7) + '  ' + r.T.toFixed(4).padStart(7) +
        '  ' + String(r.lead_ticks).padStart(11) + '  ' + r.deploy.toFixed(2).padStart(7) +
        '  ' + r.vrEnd.toFixed(4).padStart(7) + '  ' + r.margin.toFixed(2).padStart(8) +
        '  ' + r.apo.toFixed(3).padStart(8) + '  ' + (r.ecc * 1e6).toFixed(1).padStart(7) +
        '  ' + r.score.toFixed(1).padStart(9)
      );
    });
  }

  console.log('');
  console.log('files:');
  console.log('  ' + jsonPath);
  console.log('  ' + csvPath);
  console.log('');
  console.log('Next: paste the two grid tables + ridge table + BEST OVERALL.');
}

main().catch(e => { console.error(e); process.exit(1); });