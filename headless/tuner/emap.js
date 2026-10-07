// ============================================================================
// headless/tuner/emap.js — STEP 6: E(A, bias) mapper.
//
//   node tuner/emap.js                      # 8 x 11 grid, 88 evals, no E_max
//   node tuner/emap.js --workers 6
//   node tuner/emap.js --e-max 2.5e-4       # also extract per-A boundary crossings
//   node tuner/emap.js --from tuner/emap.json --e-max 2.5e-4   # re-extract, ZERO evals
//   node tuner/emap.js --dry                # print the grid, run nothing
//
// Measures eccentricity at COAST_ROTATE EXIT (first tick of COAST_WAIT), the point
// the manual heuristic targets. Eval = { eval: 'coastEnd', stride: 1 } so the phase
// transition is caught on its exact tick (metrics.coastEndExactTick must be true).
//
// Options (defaults = Step 6 spec):
//   --a-min 13.2 --a-max 15.0 --a-steps 8
//   --bias-min 0.4 --bias-max 1.4 --bias-steps 11
//   --meco 52612 --lead 5.525        (margin is locked in config `fixed` = 0.0001)
//   --e-max <ecc>                    optional; boundary extraction only
//   --out-dir <dir>                  default: this directory
//   --config <path>                  default: tuner-config-v3.json next to this file
//   --workers <n>                    default: config / TUNER_WORKERS
//
// Output: emap.json (all cells, full metrics subset), emap.csv, heatmaps on stdout.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const EVAL_OPTS = { eval: 'coastEnd', stride: 1 };

function parseArgs(argv) {
  const a = {
    aMin: 13.2, aMax: 15.0, aSteps: 8, biasMin: 0.4, biasMax: 1.4, biasSteps: 11,
    meco: 52612, lead: 5.525, eMax: null, from: null, dry: false,
    outDir: __dirname, config: path.join(__dirname, 'tuner-config-v3.json'), workers: undefined
  };
  const num = (k, v) => { const x = Number(v); if (!Number.isFinite(x)) throw new Error('bad number for ' + k + ': ' + v); return x; };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const nx = () => { if (i + 1 >= argv.length) throw new Error('missing value for ' + k); return argv[++i]; };
    switch (k) {
      case '--a-min': a.aMin = num(k, nx()); break;
      case '--a-max': a.aMax = num(k, nx()); break;
      case '--a-steps': a.aSteps = num(k, nx()); break;
      case '--bias-min': a.biasMin = num(k, nx()); break;
      case '--bias-max': a.biasMax = num(k, nx()); break;
      case '--bias-steps': a.biasSteps = num(k, nx()); break;
      case '--meco': a.meco = num(k, nx()); break;
      case '--lead': a.lead = num(k, nx()); break;
      case '--e-max': a.eMax = num(k, nx()); break;
      case '--from': a.from = nx(); break;
      case '--out-dir': a.outDir = nx(); break;
      case '--config': a.config = nx(); break;
      case '--workers': a.workers = num(k, nx()); break;
      case '--dry': a.dry = true; break;
      default: throw new Error('unknown option ' + k);
    }
  }
  return a;
}

function linspace(lo, hi, n, dec) {
  if (n === 1) return [lo];
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number((lo + (hi - lo) * i / (n - 1)).toFixed(dec)));
  return out;
}

// ---- formatting ------------------------------------------------------------
const W = 9;
const pad = (s, w) => { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; };
function fmtE6(e) {                       // ecc in units of 1e-6
  if (e === null || e === undefined) return '--';
  const v = e * 1e6;
  if (v >= 1e6) return v.toExponential(1);
  return v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
function fmtLog(e) { return (e === null || e === undefined || !(e > 0)) ? '--' : Math.log10(e).toFixed(2); }

function heatmap(title, cells, As, Bs, f) {
  const lines = [title, pad('A \\ bias', 10) + Bs.map(b => pad(b.toFixed(2), W)).join('')];
  As.forEach((A, i) => {
    let row = pad(A.toFixed(3), 10);
    Bs.forEach((_, j) => {
      const c = cells[i * Bs.length + j];
      row += pad(f(c.ecc) + (c.hardFail ? '*' : ' '), W);
    });
    lines.push(row);
  });
  lines.push('(* = pre-coast hard fail flagged: ' + 'crash / maxQ / maxG / dead; value still shown if measured)');
  return lines.join('\n');
}

// ---- boundary extraction (per A, where ecc crosses E_max along bias) --------
// Interpolates in (bias, log10 ecc): ecc varies over orders of magnitude, so a
// linear-in-ecc interpolation would put crossings in the wrong place.
function boundaries(cells, As, Bs, eMax) {
  const out = [];
  As.forEach((A, i) => {
    const row = Bs.map((_, j) => cells[i * Bs.length + j]);
    const crossings = [];
    for (let j = 0; j + 1 < Bs.length; j++) {
      const p = row[j], q = row[j + 1];
      if (p.ecc === null || q.ecc === null || !(p.ecc > 0) || !(q.ecc > 0)) continue;
      const sp = p.ecc - eMax, sq = q.ecc - eMax;
      if (sp === 0) { crossings.push({ bias: Bs[j], dir: sq > 0 ? 'up' : 'down', exact: true }); continue; }
      if (sp * sq < 0) {
        const lp = Math.log10(p.ecc), lq = Math.log10(q.ecc), le = Math.log10(eMax);
        const f = (le - lp) / (lq - lp);
        crossings.push({ bias: Number((Bs[j] + f * (Bs[j + 1] - Bs[j])).toFixed(4)), dir: sq > 0 ? 'up' : 'down', exact: false,
                         between: [Bs[j], Bs[j + 1]] });
      }
    }
    const lastOK = row[row.length - 1].ecc !== null && row[row.length - 1].ecc === eMax;
    if (lastOK) crossings.push({ bias: Bs[Bs.length - 1], dir: 'edge', exact: true });
    const allBelow = row.every(c => c.ecc !== null && c.ecc <= eMax);
    const allAbove = row.every(c => c.ecc !== null && c.ecc > eMax);
    out.push({ A, aEff: row[0].aEff, crossings, allBelow, allAbove });
  });
  return out;
}

function printBoundaries(bs, eMax) {
  console.log('\nBoundary (ecc crosses E_max = ' + eMax + ') per A. dir=up: ecc rises above E_max as bias increases; down: falls below.');
  bs.forEach(b => {
    const desc = b.crossings.length
      ? b.crossings.map(c => c.bias + ' (' + c.dir + ')').join('  |  ')
      : (b.allBelow ? 'no crossing: ecc <= E_max for all bias on grid' : b.allAbove ? 'no crossing: ecc > E_max for all bias on grid' : 'no crossing (missing cells?)');
    console.log('  A=' + pad(b.A.toFixed(3), 7) + '  ' + desc);
  });
}

// ---- csv --------------------------------------------------------------------
function toCsv(cells) {
  const cols = ['A', 'aEff', 'G', 'T', 'bias', 'ecc', 'ecc_e6', 'log10ecc', 'apoKm', 'periKm', 'vr', 'stageFuelKg', 'exactTick', 'hardFail', 'failures', 'wallMs'];
  const rows = [cols.join(',')];
  cells.forEach(c => rows.push([
    c.A, c.aEff, c.G, c.T, c.bias, c.ecc, c.ecc === null ? '' : c.ecc * 1e6, c.ecc > 0 ? Math.log10(c.ecc) : '',
    c.apoKm, c.periKm, c.vr, c.stageFuelKg, c.exactTick, c.hardFail, '"' + (c.failures || []).join(';') + '"', c.wallMs === null ? '' : Math.round(c.wallMs)
  ].map(v => v === null || v === undefined ? '' : v).join(',')));
  return rows.join('\n') + '\n';
}

function summary(cells) {
  const ok = cells.filter(c => c.ecc !== null);
  const miss = cells.length - ok.length;
  const inexact = ok.filter(c => c.exactTick === false).length;
  const es = ok.map(c => c.ecc).sort((x, y) => x - y);
  const q = p => es[Math.min(es.length - 1, Math.floor(p * (es.length - 1)))];
  return { cells: cells.length, measured: ok.length, noEcc: miss, notExactTick: inexact,
           hardFlagged: cells.filter(c => c.hardFail).length,
           eccMin: es[0], eccMedian: q(0.5), eccMax: es[es.length - 1] };
}

async function main() {
  const args = parseArgs(process.argv);
  let doc;

  if (args.from) {
    doc = JSON.parse(fs.readFileSync(args.from, 'utf8'));
    console.log('re-extracting from ' + args.from + ' (no evals)');
  } else {
    const As = linspace(args.aMin, args.aMax, args.aSteps, 4);
    const Bs = linspace(args.biasMin, args.biasMax, args.biasSteps, 4);
    console.log('E-map grid: A ' + As.join(', ') + '\n            bias ' + Bs.join(', ') +
      '\nfixed: MECO=' + args.meco + ' lead=' + args.lead + ' (margin from config fixed)  -> ' + As.length * Bs.length + ' evals, eval=' + JSON.stringify(EVAL_OPTS));
    if (args.dry) return;

    const { createEvaluator, loadConfig } = require('./evaluator');
    const cfg = loadConfig(args.config);
    const ev = createEvaluator(cfg, args.workers !== undefined ? { workers: args.workers } : {});
    const list = [];
    As.forEach(A => Bs.forEach(b => list.push({
      ascent_profile_constant: A, stage_burn_aoa_bias: b,
      meco_target_booster_fuel: args.meco, circ_trigger_lead: args.lead
    })));
    const t0 = Date.now();
    const rs = await ev.evaluateMany(list, EVAL_OPTS);
    const wall = (Date.now() - t0) / 1000;
    await ev.close();

    const cells = rs.map((r, k) => {
      const m = r.metrics;
      return {
        A: list[k].ascent_profile_constant, aEff: r.effective.A_eff, G: r.effective.ascent_G, T: r.effective.ascent_T,
        bias: r.effective.bias,
        ecc: m.coastEndEcc, apoKm: m.coastEndApoKm, periKm: m.coastEndPeriKm, vr: m.coastEndVr,
        stageFuelKg: m.stageFuelAtCoastEndKg, exactTick: m.coastEndExactTick, coastEndT: m.coastEndT,
        entryEcc: m.coastEcc,
        maxQKPa: m.maxQKPa, maxG: m.maxG,
        hardFail: r.hardFail, failures: (r.failures || []).map(f => f.id),
        stopReason: m.stopReason, wallMs: m.wallMs, cached: r.cached
      };
    });
    doc = {
      kind: 'emap', createdWallS: wall,
      fixed: { meco: args.meco, lead: args.lead, evalOpts: EVAL_OPTS },
      As, Bs, cells
    };
    fs.mkdirSync(args.outDir, { recursive: true });
    fs.writeFileSync(path.join(args.outDir, 'emap.json'), JSON.stringify(doc, null, 1));
    fs.writeFileSync(path.join(args.outDir, 'emap.csv'), toCsv(cells));
    const evWall = cells.reduce((s, c) => s + (c.wallMs || 0), 0) / cells.length / 1000;
    console.log('\n' + cells.length + ' evals in ' + wall.toFixed(1) + ' s wall (avg ' + evWall.toFixed(2) + ' s/eval per worker)  -> ' +
      path.join(args.outDir, 'emap.json') + ', emap.csv');
  }

  const { As, Bs, cells } = doc;
  console.log('\n' + heatmap('ECC at COAST_ROTATE exit, units 1e-6   (rows = A, cols = bias)', cells, As, Bs, fmtE6));
  console.log('\n' + heatmap('log10(ecc)', cells, As, Bs, fmtLog));
  console.log('\nsummary: ' + JSON.stringify(summary(cells)));
  const inexact = cells.filter(c => c.exactTick === false).length;
  if (inexact) console.log('WARNING: ' + inexact + ' cell(s) did not catch the transition on its exact tick (stride!=1?).');

  if (args.eMax !== null) {
    const bs = boundaries(cells, As, Bs, args.eMax);
    printBoundaries(bs, args.eMax);
    if (!args.from) fs.writeFileSync(path.join(args.outDir, 'emap-boundary.json'), JSON.stringify({ eMax: args.eMax, boundaries: bs }, null, 1));
  } else {
    console.log('\n(no --e-max given: boundary extraction skipped. Pick E_max from the heatmap, validate with full evals, then rerun with --from emap.json --e-max <v>)');
  }
}

if (require.main === module) main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { parseArgs, linspace, boundaries, summary, toCsv, EVAL_OPTS };
