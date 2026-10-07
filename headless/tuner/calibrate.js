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

    head('2 EQUIV  (fast ALL vs hook-only reference, same window)');
    const idBodies = JSON.stringify(bodiesFingerprint(hookRef)) === JSON.stringify(bodiesFingerprint(allRun));
    const idHook = same(hookRef.hook, allRun.hook);
    const idTr = JSON.stringify(hookRef.tracker) === JSON.stringify(allRun.tracker);
    const idNoHook = JSON.stringify(bodiesFingerprint(refRun)) === JSON.stringify(bodiesFingerprint(hookRef));
    line('  body states bit-identical : ' + idBodies);
    line('  hook metrics identical    : ' + idHook);
    line('  tracker identical         : ' + idTr);
    line('  hook does not perturb sim : ' + idNoHook);
    const ok = idBodies && idHook && idTr;
    report.equiv = { idBodies, idHook, idTr, idNoHook, ok };
    if (ok) { fastChoice = true; line('  => fast mode ACCEPTED (bit-identical).'); }
    else {
      fastChoice = false;
      line('  => fast mode REJECTED. Trying parts individually to find the culprit:');
      for (const part of ['globals', 'libCache', 'liveSnapshot']) {
        const r = runOnce(cfg, { [part]: true }, PROBE_S, {});
        line('     ' + part.padEnd(13), JSON.stringify(bodiesFingerprint(hookRef)) === JSON.stringify(bodiesFingerprint(r)) ? 'identical' : 'DIFFERS');
      }
    }
    md.push('- perf probe (' + PROBE_S + ' sim-s): hook-only ' + ms(base) + ', fast ALL ' + ms(all) +
      ' (x' + f(base / all, 1) + '); equivalence ' + (ok ? 'bit-identical -> evaluator.fast=true' : 'FAILED -> fast off'));
  }
  cfg.evaluator.fast = fastChoice;

  // ======================= 3: BASELINE ======================================
  head('3 BASELINE (full run)');
  const ev = EV.createEvaluator(cfg, { workers: WORKERS });
  const t0 = Date.now();
  const rawRes = ev.evaluateSync({}, RAW);
  line('  raw defaults run wall: ' + ms(Date.now() - t0) + '  (fast=' + !!fastChoice + ')');
  const snapRes = ev.evaluateSync({}, {});
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

  const mR = rawRes.metrics;
  const checks = [];
  const chk = (name, pass, detail) => { checks.push({ name, pass, detail }); line('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name + ' ' + (detail || '')); };
  chk('deploy time matches manual benchmark (~590 s)', mR.timeToDeployS !== null && Math.abs(mR.timeToDeployS - KNOWN.benchmarkS) < 2, '(' + f(mR.timeToDeployS, 2) + ' s)');
  chk('reproduces Step 2 live result (deploy)', mR.timeToDeployS !== null && Math.abs(mR.timeToDeployS - KNOWN.deployS) < 0.05, '(' + f(mR.timeToDeployS, 2) + ' vs ' + KNOWN.deployS + ')');
  chk('reproduces Step 2 live result (apogee)', mR.apogeeKm !== null && Math.abs(mR.apogeeKm - KNOWN.apo) < 0.01, '(' + f(mR.apogeeKm, 3) + ' vs ' + KNOWN.apo + ')');
  chk('reproduces Step 2 live result (maxQ)', mR.maxQKPa !== null && Math.abs(mR.maxQKPa - KNOWN.maxQ) < 0.02, '(' + f(mR.maxQKPa, 2) + ' vs ' + KNOWN.maxQ + ')');
  report.checks = checks;
  if (!checks.every(c => c.pass)) line('  !! baseline does not match the known manual result -> do NOT trust calibration below until explained.');

  // ======================= 4: G-LOAD ========================================
  head('4 G-LOAD sanity (own series vs sim raw accel)');
  const gs = mR.gSeries || [];
  let gPass = false;
  if (gs.length) {
    const liftoff = gs.filter(r => r[0] >= 1 && r[0] <= 3);
    const gLift = liftoff.length ? Math.max.apply(null, liftoff.map(r => r[1])) : null;
    const tMeco = mR.mecoT;
    let peak = gs[0];
    gs.forEach(r => { if (r[1] > peak[1]) peak = r; });
    line('  liftoff own G (t=1..3 s): ' + f(gLift, 2) + '   (expect ~1.3-1.5)');
    line('  own peak G: ' + f(peak[1], 2) + ' @ t=' + f(peak[0], 0) + ' s, alt ' + f(peak[3], 1) + ' km; MECO t=' + f(tMeco, 1) + ' s');
    line('  sim-raw peak: ' + f(mR.maxAccelRawG, 2) + '  (STATE: 5.30 vs own 4.82)');
    line('  t[s]     ownG   rawG   alt[km]   (every ~20 s)');
    gs.forEach((r, i) => { if (i % 20 === 0) line('  ' + f(r[0], 0).padStart(5) + f(r[1], 2).padStart(9) + f(r[2], 2).padStart(7) + f(r[3], 1).padStart(10)); });
    // where does raw exceed own by >0.3 g ?
    const diverge = gs.filter(r => r[2] - r[1] > 0.3).map(r => r[0]);
    if (diverge.length) line('  raw > own by >0.3 g at t = ' + diverge.slice(0, 12).map(x => x.toFixed(0)).join(', ') + (diverge.length > 12 ? ' ...' : '') + '  (look: separation kicks / RCS / slosh?)');
    const nearMeco = tMeco !== null && Math.abs(peak[0] - tMeco) < 15;
    gPass = gLift !== null && gLift >= 1.2 && gLift <= 1.6 && nearMeco;
    line('  verdict: liftoff in range=' + (gLift >= 1.2 && gLift <= 1.6) + ', peak within 15 s of MECO=' + nearMeco + ' -> maxG ' + (gPass ? 'CAN be enabled' : 'stays DISABLED'));
    report.gcheck = { gLift, peak, tMeco, pass: gPass };
    md.push('', '- G-load: liftoff ' + f(gLift, 2) + ' g, own peak ' + f(peak[1], 2) + ' g @ ' + f(peak[0], 0) + ' s (MECO ' + f(tMeco, 0) + ' s), sim-raw peak ' + f(mR.maxAccelRawG, 2) + ' g -> ' + (gPass ? 'verified' : 'NOT verified, maxG stays disabled'));
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
    // rank agreement: coast apogee vs final apogee (Kendall-style concordance over pairs)
    const pairs = [];
    for (let i = 0; i < biasPts.length; i++) for (let j = i + 1; j < biasPts.length; j++) {
      const da = trunc[j].metrics.coastApoKm - trunc[i].metrics.coastApoKm;
      const db = full[j].metrics.apogeeKm - full[i].metrics.apogeeKm;
      if (Number.isFinite(da) && Number.isFinite(db)) pairs.push(Math.sign(da) === Math.sign(db) || da === 0 || db === 0);
    }
    const conc = pairs.length ? pairs.filter(Boolean).length / pairs.length : 0;
    // distance of the best-by-proxy from the best-by-full
    const bestFull = full.reduce((bi, r, i) => (r.score < full[bi].score ? i : bi), 0);
    const bestTr = trunc.reduce((bi, r, i) => (r.score < trunc[bi].score ? i : bi), 0);
    const speed = (wFull / 1000) / (wTr / 1000);
    line('  apogee-order concordance: ' + f(conc * 100, 0) + ' %   best(full)=bias ' + biasPts[bestFull] + '  best(truncated)=bias ' + biasPts[bestTr]);
    line('  wall (parallel x' + WORKERS + '): full ' + ms(wFull) + ', truncated ' + ms(wTr) + '  -> x' + f(speed, 2));
    const valid = conc >= 0.9 && bestFull === bestTr && speed >= 1.5;
    proxyVerdict = valid ? 'VALID (usable for Steps 4-5)' : 'NOT validated -> use full evals';
    line('  verdict: ' + proxyVerdict);
    report.proxy = { biasPts, conc, bestFull: biasPts[bestFull], bestTr: biasPts[bestTr], wFull, wTr, valid };
    md.push('- truncated proxy: ' + proxyVerdict + ' (concordance ' + f(conc * 100, 0) + ' %, speed-up x' + f(speed, 2) + ')');
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
