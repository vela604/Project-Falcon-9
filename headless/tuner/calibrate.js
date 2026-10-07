// ============================================================================
// headless/tuner/calibrate.js — STEP 3: baseline + calibration.
//
//   node headless/tuner/calibrate.js [--config <path>] [--write-config]
//        [--skip-perf] [--skip-proxy] [--workers N] [--probe-s 100] [--out <dir>]
//
// Sections (each prints a block you can paste into STATE.md):
//   1 PERF      wall time of a probe run with each speed-up flag (runner `fast`)
//   2 EQUIV     fast-mode vs reference on the probe window must be BIT-IDENTICAL
//               (only then is `evaluator.fast` switched on)
//   3 BASELINE  raw defaults (0.60/4.82/5.53, no lattice snap) full run, then the
//               lattice-snapped defaults; compared with the known manual benchmark
//   4 G-LOAD    own G series vs sim raw accel: liftoff ~1.3-1.5 g, peak near MECO
//   5 CALIB     maxQ limit = baseline x factor, durationCapS = 1.3 x deploy,
//               maxG enabled only if section 4 passes
//   6 DETERM    same eval twice in-process + once in a FRESH process: bit-identical
//   7 PROXY     truncated (stop at COAST_ROTATE) vs full on a small bias sweep
//
// Nothing in the config is touched unless --write-config is given.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EV = require('./evaluator');
const { runSim } = require('../runner');

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

function findConfig() {
  const c = arg('config', null);
  if (c) return path.resolve(c);
  const cands = [
    path.join(__dirname, 'tuner-config-v3.json'),
    path.join(__dirname, '..', '..', 'tuner', 'tuner-config-v3.json'),
    path.join(process.cwd(), 'tuner', 'tuner-config-v3.json'),
    path.join(process.cwd(), 'tuner-config-v3.json')
  ];
  const f = cands.find(p => fs.existsSync(p));
  if (!f) throw new Error('config not found; pass --config');
  return f;
}

const CFG_PATH = findConfig();
const OUT_DIR = path.resolve(arg('out', path.join(path.dirname(CFG_PATH), 'out')));
const PROBE_S = parseFloat(arg('probe-s', '100'));
const WORKERS = parseInt(arg('workers', String(Math.min(6, os.cpus().length))), 10);

const RAW = { snap: false, ascent_G: 0.60, ascent_T: 4.82 };   // user's manual-best constants, un-snapped
const KNOWN = {                                                 // from STATE.md Step 2 live result
  deployS: 590.46, benchmarkS: 590, apo: 320.111, peri: 319.999, maxQ: 24.75
};

// ---------------------------------------------------------------------------
const ms = x => x.toFixed(0) + ' ms';
const f = (x, d) => (x === null || x === undefined || !Number.isFinite(x)) ? 'n/a' : x.toFixed(d === undefined ? 3 : d);
const line = (...a) => console.log(...a);
const head = t => line('\n=== ' + t + ' ' + '='.repeat(Math.max(0, 70 - t.length)));
const report = { when: new Date().toISOString(), config: CFG_PATH };
const md = [];            // STATE.md snippet lines

function stripWall(o) {   // drop wall-clock fields before comparing / hashing
  const c = JSON.parse(JSON.stringify(o));
  (function walk(x) {
    if (x && typeof x === 'object') {
      Object.keys(x).forEach(k => { if (k === 'wallMs') delete x[k]; else walk(x[k]); });
    }
  })(c);
  return c;
}
const same = (a, b) => JSON.stringify(stripWall(a)) === JSON.stringify(stripWall(b));

function runOnce(cfg, fast, durationS, opts) {
  // direct runSim with the evaluator's own hook + tunable payload (probe / equivalence)
  opts = opts || {};
  const snapped = EV.snapValues(cfg, {}, RAW);
  const m = cfg.mission;
  return runSim({
    stackId: m.stackId, vehicleId: m.vehicleId, guide: m.guide,
    durationS, environment: m.environment, fueling: m.fueling, quiet: true,
    tunables: EV.buildTunablePayload(cfg, snapped, m.targetOrbitAltKm),
    resetGuideConfig: true,
    extraBootstrapCode: opts.noHook ? undefined : EV.HOOK_CODE,
    hookOptions: { stopAt: null, stride: 4, flowThreshKgS: 1 },
    fast
  });
}

function bodiesFingerprint(r) {
  return r.status.bodies.map(b => [b.rx, b.ry, b.vx, b.vy, b.theta, b.omega, b.fuelMass, b.memberFuel]);
}

// ---------------------------------------------------------------------------
// Fresh-process child mode: evaluate raw defaults once, print metrics JSON.
// ---------------------------------------------------------------------------
if (flag('child-eval')) {
  const cfg = EV.loadConfig(CFG_PATH);
  cfg.evaluator = Object.assign(cfg.evaluator || {}, { fast: process.env.TUNER_CAL_FAST === 'true' });
  const core = EV.evalCore(cfg, {}, Object.assign({}, RAW));
  process.stdout.write('@@CORE@@' + JSON.stringify(core) + '@@END@@');
  process.exit(0);
}

// ---------------------------------------------------------------------------
async function main() {
  const cfg = EV.loadConfig(CFG_PATH);
  cfg.evaluator = cfg.evaluator || {};
  fs.mkdirSync(OUT_DIR, { recursive: true });
  line('config:', CFG_PATH, '| out:', OUT_DIR, '| workers:', WORKERS);

  // ======================= 1 + 2: PERF + EQUIV ==============================
  let fastChoice = cfg.evaluator.fast || false;
  if (!flag('skip-perf')) {
    head('1 PERF  (probe window ' + PROBE_S + ' sim-s, raw defaults)');
    const variants = [
      ['reference (no hook, no fast)', false, true],
      ['hook only', false, false],
      ['hook + fast.globals', { globals: true }, false],
      ['hook + fast.libCache', { libCache: true }, false],
      ['hook + fast.liveSnapshot', { liveSnapshot: true }, false],
      ['hook + fast ALL', true, false]
    ];
    const perf = [];
    let refRun = null, hookRef = null, allRun = null;
    for (const [name, fast, noHook] of variants) {
      runOnce(cfg, fast, 3, { noHook });                      // warm-up: instance load (not timed)
      const t0 = Date.now();
      const r = runOnce(cfg, fast, PROBE_S, { noHook });
      const wall = Date.now() - t0;
      const tps = r.ticksRun / (wall / 1000);
      perf.push({ name, wallMs: wall, ticksPerS: Math.round(tps), simPerWall: (r.ticksRun / 80) / (wall / 1000) });
      line('  ' + name.padEnd(32), ms(wall).padStart(9), String(Math.round(tps)).padStart(8) + ' ticks/s');
      if (name === 'hook only') hookRef = r;
      if (name === 'hook + fast ALL') allRun = r;
      if (name.startsWith('reference')) refRun = r;
    }
    report.perf = perf;
    const base = perf[1].wallMs, all = perf[perf.length - 1].wallMs;
    line('  hook overhead: ' + f((perf[1].wallMs / perf[0].wallMs - 1) * 100, 1) + ' %');
    line('  fast ALL speed-up vs hook-only: x' + f(base / all, 1) +
      '  -> projected full eval (~' + KNOWN.deployS.toFixed(0) + ' sim-s): ' +
      f((all / PROBE_S) * KNOWN.deployS / 1000, 1) + ' s');

    head('2 EQUIV  (fast modes vs hook-only reference, same window; largest bit-identical subset wins)');
    const idNoHook = JSON.stringify(bodiesFingerprint(refRun)) === JSON.stringify(bodiesFingerprint(hookRef));
    line('  hook does not perturb sim : ' + idNoHook);
    const candidates = [
      ['ALL', true],
      ['globals+libCache', { globals: true, libCache: true }],
      ['libCache', { libCache: true }],
      ['globals', { globals: true }]
    ];
    const eqRes = [];
    fastChoice = false;
    let chosenName = 'none';
    for (const [name, fast] of candidates) {
      const r = (name === 'ALL') ? allRun : runOnce(cfg, fast, PROBE_S, {});
      const idB = JSON.stringify(bodiesFingerprint(hookRef)) === JSON.stringify(bodiesFingerprint(r));
      const idH = same(hookRef.hook, r.hook);
      const idT = JSON.stringify(hookRef.tracker) === JSON.stringify(r.tracker);
      const ok = idB && idH && idT;
      eqRes.push({ name, idBodies: idB, idHook: idH, idTracker: idT, ok });
      line('  ' + name.padEnd(18) + 'bodies=' + idB + ' hook=' + idH + ' tracker=' + idT + '  -> ' + (ok ? 'IDENTICAL' : 'DIFFERS'));
      if (ok) { fastChoice = fast; chosenName = name; break; }
    }
    line('  => fast mode: ' + chosenName + (fastChoice ? '  (accepted, bit-identical)' : '  (all rejected; evaluator.fast stays off)'));
    report.equiv = { idNoHook, tried: eqRes, chosen: chosenName };
    const ok = !!fastChoice;
    md.push('- perf probe (' + PROBE_S + ' sim-s): hook-only ' + ms(base) + ', fast ALL ' + ms(all) +
      ' (x' + f(base / all, 1) + '); equivalence: ' + (ok ? 'bit-identical with fast=' + chosenName : 'FAILED -> fast off'));
  }
  if (flag('skip-perf') && flag('fast')) fastChoice = true;   // known bit-identical (validated by a full-run baseline)
  cfg.evaluator.fast = fastChoice;

  // ======================= 3: BASELINE ======================================
  head('3 BASELINE (full run)');
  let ev, rawRes, snapRes, checks, mR;
  const mdMark = md.length;
  for (let attempt = 0; attempt < 2; attempt++) {
  md.length = mdMark;
  ev = EV.createEvaluator(cfg, { workers: WORKERS });
  const t0 = Date.now();
  rawRes = ev.evaluateSync({}, RAW);
  line('  raw defaults run wall: ' + ms(Date.now() - t0) + '  (fast=' + !!fastChoice + ')');
  snapRes = ev.evaluateSync({}, {});
  report.baselineRaw = rawRes; report.baselineSnapped = snapRes;

  const rows = [
    ['deploy time s', m => m.timeToDeployS, 2],
    ['payload apogee km', m => m.apogeeKm, 3],
    ['payload perigee km', m => m.perigeeKm, 3],
    ['eccentricity', m => m.ecc, 7],
    ['maxQ kPa', m => m.maxQKPa, 2],
    ['maxG own', m => m.maxG, 3],
    ['maxG sim-raw', m => m.maxAccelRawG, 3],
    ['circ min vr m/s', m => m.circMinVr, 3],
    ['circ vr at burn end', m => m.circVrAtEnd, 3],
    ['circEndMarginS (target 4.0)', m => m.circEndMarginS, 3],
    ['booster fuel @split kg', m => m.boosterFuelLeftKg, 0],
    ['stage residual kg (0-50)', m => m.stageResidualKg, 1],
    ['MECO time s', m => m.mecoT, 2],
    ['score', null, 3]
  ];
  line('  ' + 'metric'.padEnd(30) + 'raw'.padStart(14) + 'snapped'.padStart(14) + 'delta'.padStart(12));
  md.push('', '| metric | raw defaults | lattice-snapped | delta |', '|---|---|---|---|');
  rows.forEach(([name, get, d]) => {
    const a = get ? get(rawRes.metrics) : rawRes.score;
    const b = get ? get(snapRes.metrics) : snapRes.score;
    const dl = (a !== null && b !== null) ? b - a : null;
    line('  ' + name.padEnd(30) + f(a, d).padStart(14) + f(b, d).padStart(14) + f(dl, d).padStart(12));
    md.push('| ' + name + ' | ' + f(a, d) + ' | ' + f(b, d) + ' | ' + f(dl, d) + ' |');
  });
  line('  effective values raw    :', JSON.stringify(rawRes.effective));
  line('  effective values snapped:', JSON.stringify(snapRes.effective));
  line('  failures raw/snapped    :', JSON.stringify(rawRes.failures), JSON.stringify(snapRes.failures));

  mR = rawRes.metrics;
  checks = [];
  const chk = (name, pass, detail) => { checks.push({ name, pass, detail }); line('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name + ' ' + (detail || '')); };
  chk('deploy time matches manual benchmark (~590 s)', mR.timeToDeployS !== null && Math.abs(mR.timeToDeployS - KNOWN.benchmarkS) < 2, '(' + f(mR.timeToDeployS, 2) + ' s)');
  chk('reproduces Step 2 live result (deploy)', mR.timeToDeployS !== null && Math.abs(mR.timeToDeployS - KNOWN.deployS) < 0.05, '(' + f(mR.timeToDeployS, 2) + ' vs ' + KNOWN.deployS + ')');
  chk('reproduces Step 2 live result (apogee)', mR.apogeeKm !== null && Math.abs(mR.apogeeKm - KNOWN.apo) < 0.01, '(' + f(mR.apogeeKm, 3) + ' vs ' + KNOWN.apo + ')');
  chk('reproduces Step 2 live result (maxQ)', mR.maxQKPa !== null && Math.abs(mR.maxQKPa - KNOWN.maxQ) < 0.02, '(' + f(mR.maxQKPa, 2) + ' vs ' + KNOWN.maxQ + ')');
  report.checks = checks;
  if (!checks.every(c => c.pass)) line('  !! baseline does not match the known manual result -> do NOT trust calibration below until explained.');
  if (checks.every(c => c.pass) || !fastChoice) break;
  line('  !! full-run baseline mismatch WITH fast mode on -> fast disabled, re-running reference path (slow).');
  await ev.close();
  fastChoice = false; cfg.evaluator.fast = false;
  md.push('- fast mode passed the probe window but FAILED the full-run baseline check -> fast disabled');
  }

  // ======================= 4: G-LOAD ========================================
  head('4 G-LOAD sanity (own series vs sim raw accel)');
  const gs = mR.gSeries || [];
  let gPass = false;
  if (gs.length) {
    const liftoff = gs.filter(r => r[0] >= 1 && r[0] <= 3);
    const gLift = liftoff.length ? Math.max.apply(null, liftoff.map(r => r[1])) : null;
    let peak = gs[0];
    gs.forEach(r => { if (r[1] > peak[1]) peak = r; });
    // own vs raw agreement while thrusting (raw also contains pad reaction at t<3 s and RCS, so skip those)
    const ratios = gs.filter(r => r[1] > 0.3 && r[0] > 3).map(r => r[2] / r[1]).sort((x, y) => x - y);
    const q = p => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] : null;
    const rMed = q(0.5), rLo = q(0.05), rHi = q(0.95);
    line('  liftoff own G (t=1..3 s): ' + f(gLift, 2) + '   (expect ~1.3-1.5)');
    line('  own peak (1 s samples): ' + f(peak[1], 2) + ' g @ t=' + f(peak[0], 0) + ' s (alt ' + f(peak[3], 1) + ' km);  booster-MECO t=' + f(mR.mecoT, 1) + ' s');
    line('  own max (per tick) ' + f(mR.maxG, 3) + ' | sim-raw max ' + f(mR.maxAccelRawG, 3));
    line('  raw/own while thrusting: median ' + f(rMed, 3) + ', p5 ' + f(rLo, 3) + ', p95 ' + f(rHi, 3) + '  (n=' + ratios.length + ')');
    line('  t[s]     ownG   rawG   alt[km]   (every ~20 s)');
    gs.forEach((r, i) => { if (i % 20 === 0) line('  ' + f(r[0], 0).padStart(5) + f(r[1], 2).padStart(9) + f(r[2], 2).padStart(7) + f(r[3], 1).padStart(10)); });
    const diverge = gs.filter(r => r[0] > 3 && r[2] - r[1] > 0.3).map(r => r[0]);
    if (diverge.length) line('  raw > own by >0.3 g at t = ' + diverge.slice(0, 12).map(x => x.toFixed(0)).join(', ') + (diverge.length > 12 ? ' ...' : ''));
    if (mR.rawPeak) line('  rawPeak :', JSON.stringify(mR.rawPeak));
    if (mR.ownPeak) line('  ownPeak :', JSON.stringify(mR.ownPeak));
    // NOTE: the G peak is expected at the END of the last long burn (stage lightens), NOT at booster MECO.
    const liftOk = gLift !== null && gLift >= 1.2 && gLift <= 1.6;
    const agreeOk = rLo !== null && rLo >= 0.85 && rHi <= 1.2;
    gPass = liftOk && agreeOk;
    line('  verdict: liftoff in range=' + liftOk + ', own within -15%/+20% of raw (p5..p95)=' + agreeOk + ' -> maxG ' + (gPass ? 'CAN be enabled (limit is relative to this own baseline)' : 'stays DISABLED'));
    report.gcheck = { gLift, peak, rMed, rLo, rHi, pass: gPass };
    md.push('', '- G-load: liftoff ' + f(gLift, 2) + ' g, own max ' + f(mR.maxG, 2) + ' g, sim-raw max ' + f(mR.maxAccelRawG, 2) + ' g, raw/own median ' + f(rMed, 2) + ' (p5 ' + f(rLo, 2) + ', p95 ' + f(rHi, 2) + ') -> ' + (gPass ? 'verified' : 'NOT verified, maxG stays disabled'));
  } else line('  no gSeries in metrics (old hook?)');

  // ======================= 5: CALIBRATION ===================================
  head('5 CALIBRATION');
  const hc = cfg.scoring.hardConstraints;
  const fq = hc.maxQKPa.calibrateFactorOverBaseline || 1.25;
  const newQ = Math.ceil(mR.maxQKPa * fq * 10) / 10;
  const newCap = Math.ceil(mR.timeToDeployS * 1.3 / 10) * 10;
  const newG = (gPass && mR.maxG) ? Math.ceil(mR.maxG * 1.25 * 100) / 100 : null;
  line('  maxQ limit      : ' + newQ + ' kPa  (baseline ' + f(mR.maxQKPa, 2) + ' x ' + fq + ')');
  line('  durationCapS    : ' + newCap + ' s  (deploy ' + f(mR.timeToDeployS, 1) + ' x 1.3)');
  line('  maxG            : ' + (newG ? 'enable, limit ' + newG + ' g (own baseline ' + f(mR.maxG, 2) + ' x 1.25)' : 'stay disabled'));
  md.push('- calibrated: maxQ limit ' + newQ + ' kPa, durationCapS ' + newCap + ' s, maxG ' + (newG ? 'enabled @ ' + newG + ' g' : 'disabled'));
  report.calib = { maxQKPa: newQ, durationCapS: newCap, maxG: newG };

  // ======================= 6: DETERMINISM ===================================
  head('6 DETERMINISM');
  const a = EV.evalCore(cfg, {}, Object.assign({}, RAW));
  const b = EV.evalCore(cfg, {}, Object.assign({}, RAW));
  const inProc = same(a.metrics, b.metrics) && same(a.metrics, rawRes.metrics);
  line('  in-process, 2 more runs identical to baseline: ' + inProc);
  let fresh = null;
  {
    const child = spawnSync(process.execPath, [__filename, '--config', CFG_PATH, '--child-eval', '--out', OUT_DIR],
      { encoding: 'utf8', maxBuffer: 1 << 28, env: Object.assign({}, process.env, { TUNER_CAL_FAST: String(!!fastChoice) }) });
    const mm = /@@CORE@@([\s\S]*)@@END@@/.exec(child.stdout || '');
    if (!mm) line('  fresh process FAILED: ' + (child.stderr || '').slice(0, 500));
    else { fresh = JSON.parse(mm[1]); }
  }
  const freshSame = fresh ? same(fresh.metrics, rawRes.metrics) : false;
  line('  fresh process identical to baseline: ' + freshSame + (fresh ? '' : ' (child failed)'));
  report.determinism = { inProc, freshSame };
  md.push('- determinism: in-process ' + (inProc ? 'bit-identical' : 'DIFFERS') + ', fresh process ' + (freshSame ? 'bit-identical' : 'DIFFERS'));

  // ======================= 7: PROXY =========================================
  let proxyVerdict = 'skipped';
  if (!flag('skip-proxy')) {
    head('7 PROXY  (truncated @COAST_ROTATE vs full, bias sweep)');
    const biasPts = [0.45, 0.52, 0.59, 0.66, 0.73];
    const list = biasPts.map(x => ({ stage_burn_aoa_bias: x }));
    const tStart = Date.now();
    const full = await ev.evaluateMany(list, { eval: 'full' });
    const wFull = Date.now() - tStart;
    const t1 = Date.now();
    const trunc = await ev.evaluateMany(list, { eval: 'truncated' });
    const wTr = Date.now() - t1;
    line('  bias    | coastApo  coastPeri  coastEcc | final apo  final peri  final ecc  | fail(full)');
    biasPts.forEach((x, i) => {
      const t = trunc[i].metrics, F = full[i].metrics;
      line('  ' + x.toFixed(2) + '   | ' + f(t.coastApoKm, 2).padStart(8) + f(t.coastPeriKm, 1).padStart(10) + f(t.coastEcc, 4).padStart(10) +
        ' | ' + f(F.apogeeKm, 2).padStart(9) + f(F.perigeeKm, 2).padStart(11) + f(F.ecc, 6).padStart(10) + '  | ' + (full[i].hardFail ? full[i].failures.map(z => z.id).join(',') : '-'));
    });
    // The stage burn steers apogee to the target regardless of bias, so coastApo is ~flat (useless as proxy).
    // What varies is coast eccentricity/perigee. A usable proxy must (a) order the points like the full result
    // does at the feasibility cliff, (b) be clearly faster.
    const order = biasPts.map((x, i) => i).sort((i, j) => trunc[i].metrics.coastEcc - trunc[j].metrics.coastEcc);
    let seenFail = false, cliffOk = true;
    order.forEach(i => { if (full[i].hardFail) seenFail = true; else if (seenFail) cliffOk = false; });
    const apoSpread = Math.max.apply(null, trunc.map(r => r.metrics.coastApoKm)) - Math.min.apply(null, trunc.map(r => r.metrics.coastApoKm));
    const feas = full.map((r, i) => i).filter(i => !full[i].hardFail);
    const bestFull = feas.length ? feas.reduce((bi, i) => (full[i].score < full[bi].score ? i : bi), feas[0]) : -1;
    const speed = wFull / wTr;
    line('  coastApo spread over sweep: ' + f(apoSpread, 3) + ' km (flat => not informative)');
    line('  feasibility cliff ordered by coastEcc (all feasible below all infeasible): ' + cliffOk);
    line('  best feasible by full score: bias ' + (bestFull >= 0 ? biasPts[bestFull] : 'none') + '   scores(full): ' + full.map(r => f(r.score, 1)).join(' | '));
    line('  wall (parallel x' + WORKERS + '): full ' + ms(wFull) + ', truncated ' + ms(wTr) + '  -> x' + f(speed, 2));
    const valid = cliffOk && speed >= 1.5;
    proxyVerdict = valid ? 'USABLE for feasibility bracketing only (coastEcc cliff), NOT for accuracy ranking' : 'NOT worth it -> use full evals';
    line('  verdict: ' + proxyVerdict);
    report.proxy = { biasPts, cliffOk, apoSpread, bestFull: bestFull >= 0 ? biasPts[bestFull] : null, wFull, wTr, speed, valid };
    md.push('- truncated proxy: ' + proxyVerdict + ' (cliffOk ' + cliffOk + ', speed-up x' + f(speed, 2) + ', coastApo flat)');
  }

  // ======================= WRITE ============================================
  head('OUTPUT');
  fs.writeFileSync(path.join(OUT_DIR, 'step3-baseline.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'step3-state-snippet.md'), '## Step 3 — Baseline + calibration\n' + md.join('\n') + '\n');
  line('  wrote ' + path.join(OUT_DIR, 'step3-baseline.json'));
  line('  wrote ' + path.join(OUT_DIR, 'step3-state-snippet.md') + '  (paste into STATE.md)');

  if (flag('write-config')) {
    if (!checks.every(c => c.pass)) { line('  --write-config REFUSED: baseline checks failed.'); }
    else {
      hc.maxQKPa.limit = newQ; hc.maxQKPa.calibrate = false; hc.maxQKPa.baselineKPa = Number(f(mR.maxQKPa, 2));
      cfg.mission.durationCapS = newCap;
      if (newG) { hc.maxG.enabled = true; hc.maxG.limit = newG; hc.maxG.baselineOwnG = Number(f(mR.maxG, 3)); }
      cfg.evaluator = Object.assign(cfg.evaluator, { stride: cfg.evaluator.stride || 4, fast: fastChoice });
      cfg.evaluator._note = 'fast = runner speed-ups (globals/libCache/liveSnapshot); enabled by calibrate.js only after bit-identical equivalence check.';
      if (report.proxy) cfg.evaluator.truncatedProxyValid = !!report.proxy.valid;
      fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
      line('  config updated: ' + CFG_PATH);
    }
  } else line('  (config untouched; re-run with --write-config to apply the calibration)');

  await ev.close();
}

main().catch(e => { console.error(e); process.exit(1); });
