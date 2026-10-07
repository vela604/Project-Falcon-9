// ============================================================================
// headless/tuner/diag-step3.js — follow-ups to calibrate.js (Step 3).
//
//   node headless/tuner/diag-step3.js [--config <p>] [--workers 6] [--mode all|det|iso|sweep|tscan]
//        [--lead-from 5.50] [--lead-n 13] [--ascent-T 4.82]
//        [--t-from 4.8125] [--t-step 0.00125] [--t-n 21]      (tscan only; NOT part of 'all')
//
//  det    Is a FRESH process bit-identical to a WARM one? Runs: fresh#1, fresh#2, then an in-process run
//         after a different (snapped) run. Prints every metric that differs (key, value A, value B).
//  iso    Which change moved deploy time 590 -> 747 s: ascent T 4.82->4.825, lead 5.53->5.525, or both?
//  sweep  Lead scan in 1-tick (0.0125 s) steps around the manual best: shows how circ margin / vr / orbit
//         respond to lead (is it monotone? smooth? sawtooth?). Needed before designing Phase 4.
//
//  tscan  Is ascent T continuous or tick-quantised? Scans raw ascent_T in sub-tick steps (default 0.1 tick =
//         0.00125 s, from 385 to 387 ticks, lead fixed at 5.53). Quantised => plateaus (identical rows between
//         tick boundaries 4.8125 / 4.825 / 4.8375); continuous => every row differs. Marks rows identical to the
//         previous one with '=' . Also shows where the jump at 4.82->4.825 sits (a switch or a steep ramp?).
//
// Output is compact on purpose (paste it back). Full JSON goes to <config dir>/out/diag-step3.json.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const EV = require('./evaluator');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

function findConfig() {
  const c = arg('config', null);
  if (c) return path.resolve(c);
  const cands = [path.join(__dirname, 'tuner-config-v3.json'), path.join(__dirname, '..', '..', 'tuner', 'tuner-config-v3.json'),
    path.join(process.cwd(), 'tuner', 'tuner-config-v3.json')];
  const f = cands.find(p => fs.existsSync(p));
  if (!f) throw new Error('config not found; pass --config');
  return f;
}
const CFG_PATH = findConfig();
const OUT_DIR = path.join(path.dirname(CFG_PATH), 'out');
const MODE = arg('mode', 'all');
const WORKERS = parseInt(arg('workers', String(Math.min(6, os.cpus().length))), 10);
const T_ASC = parseFloat(arg('ascent-T', '4.82'));
const RAW = { snap: false, ascent_G: 0.60, ascent_T: T_ASC };

const f = (x, d) => (x === null || x === undefined || !Number.isFinite(x)) ? 'n/a' : x.toFixed(d === undefined ? 3 : d);
const line = (...a) => console.log(...a);
const head = t => line('\n=== ' + t + ' ' + '='.repeat(Math.max(0, 70 - t.length)));
const out = {};

function flat(o, p, acc) {
  if (o && typeof o === 'object') Object.keys(o).forEach(k => flat(o[k], p + '.' + k, acc));
  else acc[p] = o;
  return acc;
}
function diff(a, b, max) {
  const fa = flat(JSON.parse(JSON.stringify(a)), 'm', {}), fb = flat(JSON.parse(JSON.stringify(b)), 'm', {});
  const keys = new Set(Object.keys(fa).concat(Object.keys(fb)));
  const d = [];
  keys.forEach(k => { if (k.indexOf('wallMs') >= 0) return; if (!Object.is(fa[k], fb[k])) d.push([k, fa[k], fb[k]]); });
  return { n: d.length, shown: d.slice(0, max || 25) };
}

function freshCore() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'calibrate.js'), '--config', CFG_PATH, '--child-eval'],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: Object.assign({}, process.env, { TUNER_CAL_FAST: 'true' }) });
  const m = /@@CORE@@([\s\S]*)@@END@@/.exec(r.stdout || '');
  if (!m) throw new Error('child failed: ' + (r.stderr || '').slice(0, 400));
  return JSON.parse(m[1]);
}

function row(label, r) {
  const m = r.metrics;
  return '  ' + label.padEnd(22) + f(m.timeToDeployS, 2).padStart(9) + f(m.circEndMarginS, 2).padStart(10) + f(m.circMinVr, 3).padStart(9) +
    f(m.circVrAtEnd, 3).padStart(9) + f(m.apogeeKm, 3).padStart(10) + f(m.perigeeKm, 3).padStart(10) + f(m.ecc * 1e6, 1).padStart(8) +
    f(m.circBurnStartT, 2).padStart(9) + f(m.circBurnEndT, 2).padStart(9) + (r.hardFail ? '  FAIL:' + r.failures.map(z => z.id).join(',') : '');
}
const HDR = '  ' + 'case'.padEnd(22) + 'deploy'.padStart(9) + 'margin'.padStart(10) + 'vrMin'.padStart(9) + 'vrEnd'.padStart(9) +
  'apo'.padStart(10) + 'peri'.padStart(10) + 'e*1e6'.padStart(8) + 'burn0'.padStart(9) + 'burn1'.padStart(9);

async function main() {
  const cfg = EV.loadConfig(CFG_PATH);
  cfg.evaluator = Object.assign(cfg.evaluator || {}, { fast: true });   // validated bit-identical by calibrate.js
  fs.mkdirSync(OUT_DIR, { recursive: true });
  line('config:', CFG_PATH, '| workers:', WORKERS, '| ascent T (raw cases):', T_ASC);

  if (MODE === 'all' || MODE === 'det') {
    head('DET  fresh vs fresh vs warm');
    const A = freshCore().metrics;
    const B = freshCore().metrics;
    const dAB = diff(A, B);
    line('  fresh#1 vs fresh#2 : ' + (dAB.n === 0 ? 'IDENTICAL' : dAB.n + ' fields differ'));
    dAB.shown.forEach(d => line('     ' + d[0] + ' : ' + JSON.stringify(d[1]) + '  vs  ' + JSON.stringify(d[2])));
    EV.evalCore(cfg, {}, {});                                   // warm-up with a DIFFERENT (snapped) run
    const W = EV.evalCore(cfg, {}, Object.assign({}, { snap: false, ascent_G: 0.60, ascent_T: 4.82 })).metrics;
    const dAW = diff(A, W);
    line('  fresh#1 vs warm    : ' + (dAW.n === 0 ? 'IDENTICAL' : dAW.n + ' fields differ'));
    dAW.shown.forEach(d => line('     ' + d[0] + ' : ' + JSON.stringify(d[1]) + '  vs  ' + JSON.stringify(d[2])));
    out.det = { freshVsFresh: dAB, freshVsWarm: dAW };
  }

  if (MODE === 'all' || MODE === 'iso' || MODE === 'sweep' || MODE === 'tscan') {
    const ev = EV.createEvaluator(cfg, { workers: WORKERS });
    if (MODE === 'all' || MODE === 'iso') {
      head('ISO  what moved deploy time? (raw = un-snapped)');
      const cases = [
        ['raw (T4.82, lead5.53)', {}, { snap: false, ascent_G: 0.60, ascent_T: 4.82 }],
        ['T=4.825 only', {}, { snap: false, ascent_G: 0.60, ascent_T: 4.825 }],
        ['lead=5.525 only', { circ_trigger_lead: 5.525 }, { snap: false, ascent_G: 0.60, ascent_T: 4.82 }],
        ['both', { circ_trigger_lead: 5.525 }, { snap: false, ascent_G: 0.60, ascent_T: 4.825 }],
        ['lattice-snapped', {}, {}]
      ];
      const res = await Promise.all(cases.map(c => ev.evaluateMany([c[1]], c[2]).then(r => r[0])));
      line(HDR);
      res.forEach((r, i) => line(row(cases[i][0], r)));
      out.iso = cases.map((c, i) => ({ case: c[0], metrics: res[i].metrics, score: res[i].score }));
    }
    if (MODE === 'all' || MODE === 'sweep') {
      head('SWEEP  circ_trigger_lead, 1-tick steps (ascent T=' + T_ASC + ')');
      const from = parseFloat(arg('lead-from', '5.50'));
      const n = parseInt(arg('lead-n', '13'), 10);
      const leads = [];
      for (let k = 0; k < n; k++) leads.push(Math.round(from * 80 + k) / 80);
      const res = await ev.evaluateMany(leads.map(x => ({ circ_trigger_lead: x })), RAW);
      line(HDR);
      res.forEach((r, i) => line(row('lead ' + leads[i].toFixed(4), r)));
      out.sweep = leads.map((x, i) => ({ lead: x, metrics: res[i].metrics, score: res[i].score }));
    }
    if (MODE === 'tscan') {
      head('TSCAN  raw ascent_T, lead=5.53, G=0.60');
      const t0 = parseFloat(arg('t-from', '4.8125')), dt = parseFloat(arg('t-step', '0.00125')), nT = parseInt(arg('t-n', '21'), 10);
      const Ts = [];
      for (let k = 0; k < nT; k++) Ts.push(Math.round((t0 + k * dt) * 1e6) / 1e6);
      const res = await Promise.all(Ts.map(T => ev.evaluateMany([{}], { snap: false, ascent_G: 0.60, ascent_T: T }).then(r => r[0])));
      line('  ' + 'T'.padEnd(9) + 'ticks'.padStart(8) + ' ' + HDR.trim().replace(/^case\s+/, '').replace(/\s+/g, ' '));
      let prev = null;
      res.forEach((r, i) => {
        const m = r.metrics;
        const sig = [m.timeToDeployS, m.circEndMarginS, m.circBurnEndT, m.apogeeKm].join('|');
        const same = prev === sig; prev = sig;
        line('  ' + Ts[i].toFixed(5).padEnd(9) + (Ts[i] * 80).toFixed(2).padStart(8) + (same ? ' =' : '  ') + row('', r).trim());
      });
      out.tscan = Ts.map((T, i) => ({ T, metrics: res[i].metrics, score: res[i].score }));
    }
    line('\n  cache: ' + JSON.stringify(ev.cacheStats()));
    await ev.close();
  }

  fs.writeFileSync(path.join(OUT_DIR, 'diag-step3.json'), JSON.stringify(out, null, 2));
  line('\n  wrote ' + path.join(OUT_DIR, 'diag-step3.json'));
}
main().catch(e => { console.error(e); process.exit(1); });
