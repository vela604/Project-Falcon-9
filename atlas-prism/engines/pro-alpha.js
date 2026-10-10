// engines/pro-alpha.js — Pro-Alpha Engine.
// Load order: AFTER lib/primitives.js, BEFORE ui/host.js.
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore;
  const U = root.TunerUtils;

  async function runTuner(point, opts) {
  opts = opts || {};
  const Cfg = root.TunerConfig, U = root.TunerUtils, L = Cfg.limits;
  const t0 = performance.now();
  const lines = [];
  const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
  const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
  const band = opts.band || T.residualBand(opts);
  const frac = opts.residualPhaseAFrac != null ? opts.residualPhaseAFrac : (L.residualPhaseAFrac != null ? L.residualPhaseAFrac : 0.5);
  const bandA = opts.phaseABand || [band[0] + frac * (band[1] - band[0]), band[1]];
  const cache = opts.cache || new U.EvalCache();
// wrap the hook so every fresh sim call prints "▶ eval #N ..." / "◀ eval #N end=... wall=...". Disable with opts.evalLog === false.
const hookBase = opts.hook || root.TunerHook;
const wrappedHook = (opts.evalLog === false) ? hookBase : T.makeEvalLogger((s) => say(s), hookBase)();
const common = { hook: wrappedHook, env: opts.env, targetAltKm: opts.targetAltKm, abortRef: opts.abortRef, onProgress: opts.onProgress, cache };
say('runTuner: residual band [' + band[0] + ',' + band[1] + '] kg (' + ((opts.deorbit != null ? opts.deorbit : Cfg.fixed.deorbitEnabled) ? 'deorbit ON' : 'deorbit OFF') + ')  Phase A band [' + fmt(bandA[0], 0) + ',' + fmt(bandA[1], 0) + ']  Phase B mode=' + (opts.mode || 'fine'));
say('runTuner: evalLog=' + (opts.evalLog === false ? 'off' : 'on'));

  // ---- MECO probe (only when the ref MECO is BELOW probeStartKg) ----
// For 320 km refs (MECO 52612) no probe is needed. For high orbits with ref MECO≈0, probe at probeStartKg;
// if it fails, fall back to the REF MECO (not 0) and skip Phase A entirely (MECO fixed).
const MC = Cfg.meco || {};
const probeStart = opts.probeStartKg != null ? opts.probeStartKg : (MC.probeStartKg != null ? MC.probeStartKg : 20000);
let startPoint = point, probeInfo = null, skipPhaseA = false;
if (point.meco < probeStart) {
  const probedPoint = Object.assign({}, point, { meco: probeStart });
  say('=== MECO probe: ref MECO=' + point.meco + ' < ' + probeStart + ' → probing at ' + probeStart + ' (G=' + U.gOf(probedPoint.Gi) + ' bias=' + U.biasOf(probedPoint.bi) + ' lead=' + probedPoint.li + 't) ===');
  const pr = await T.tuneRough(probedPoint, Object.assign({}, common, { mode: 'fast', roughRelax: 0 }));
  if (pr.ok) {
    startPoint = probedPoint;
    probeInfo = { probedKg: probeStart, ok: true, usedKg: probeStart, residualKg: pr.residualKg, evals: pr.evals };
    say('  probe OK at MECO ' + probeStart + ' → MECO search will refine  evals=' + pr.evals + ' residual=' + fmt(pr.residualKg, 1) + ' kg');
  } else {
    skipPhaseA = true;
    probeInfo = { probedKg: probeStart, ok: false, usedKg: point.meco, reason: pr.reason, evals: pr.evals };
    say('  probe FAILED at MECO ' + probeStart + ' (' + pr.reason + ') → MECO fixed at ref value ' + point.meco + ', Phase A skipped');
  }
} else {
  say('=== MECO probe: skipped (ref MECO=' + point.meco + ' >= ' + probeStart + '; using ref as-is) ===');
}

  // ---- Phase A: MECO search (skip if probe failed) ----
  let A;
  if (skipPhaseA) {
    const rf = await T.tuneRough(startPoint, Object.assign({}, common, { mode: 'fast', roughRelax: 0 }));
    if (!rf.ok) {
      const res = { ok: false, status: 'MECO fixed fallback failed: ' + rf.reason, phaseA: null, phaseB: null, band,
        bestPoint: null, bestScore: NaN, bestMetrics: null, bestResidualKg: NaN, bestDeployS: NaN, bestSource: null,
        evals: probeInfo.evals + rf.evals, breakdown: null, wallMs: performance.now() - t0, log: lines, leaderboard: [], meco: fixedFallback, probe: probeInfo };
      say('=== runTuner FAILED: ' + res.status + ' ===');
      return res;
    }
    A = { ok: true, status: 'skipped (MECO fixed at ' + fixedFallback + ')', meco: fixedFallback, point: startPoint,
      residualKg: rf.residualKg, score: rf.score, deltaV: rf.deltaV, lead: rf.lead, metrics: rf.metrics,
      deployTimeS: rf.metrics ? rf.metrics.deployTimeS : NaN, band: [band[0], band[1]], G: U.gOf(startPoint.Gi),
      iters: 0, gDrops: 0, resOffset: 0, failingProbes: 0, bracket: { lo: null, hi: null },
      history: [{ iter: 1, seq: 1, meco: fixedFallback, gi: startPoint.Gi, how: 'fixed', kind: 'fixed', real: true, ok: true,
        residualKg: rf.residualKg, E: rf.E, score: rf.score, point: startPoint, lead: rf.lead, metrics: rf.metrics,
        deployTimeS: rf.metrics ? rf.metrics.deployTimeS : NaN }],
      evals: rf.evals, evalBreakdown: rf.evalBreakdown, cacheHits: rf.cacheHits, wallMs: rf.wallMs, log: rf.log };
    say('=== Phase A: SKIPPED (MECO fixed at ' + fixedFallback + ') ===');
  } else {
    say('=== Phase A: findOptimalMeco ===');
    A = await T.findOptimalMeco(startPoint, Object.assign({}, common, { band: bandA, onLog: opts.onLog ? (l) => say(l) : (l) => lines.push(l) }, opts.phaseA || {}));
    if (!A.ok || !A.point) { const res = { ok: false, status: 'phase A failed: ' + A.status, phaseA: A, phaseB: null, band, bestPoint: null, bestScore: NaN, bestMetrics: null, bestResidualKg: NaN, bestDeployS: NaN, bestSource: null, evals: A.evals, breakdown: null, wallMs: performance.now() - t0, log: lines, leaderboard: [], meco: A.meco, probe: probeInfo }; say('runTuner: ' + res.status); return res; }
    if (opts.abortRef && opts.abortRef.aborted) { return { ok: false, status: 'aborted', phaseA: A, phaseB: null, band, evals: A.evals, log: lines, leaderboard: [], wallMs: performance.now() - t0, probe: probeInfo }; }
  }

  // ---- Phase B: tuneAB at A.meco (guard only when MECO was searched, not fixed) ----
  const phaseBGuard = skipPhaseA ? null : band;
  say('=== Phase B: tuneAB at MECO=' + A.meco + ' (start G=' + U.gOf(A.point.Gi) + ' bias=' + U.biasOf(A.point.bi) + ' lead=' + A.point.li + 't, residual ' + fmt(A.residualKg, 1) + ' kg, guard ' + (phaseBGuard ? '[' + phaseBGuard[0] + ',' + phaseBGuard[1] + ']' : 'OFF (MECO fixed)') + ') ===');
  // Step Δv 4/4: Phase B is a coarse multi-sample, not a single-optimum descent.
// opts.phaseB can override (e.g. { sweep: false } to fall back to score-guarded descent).
const B = await T.tuneAB(A.point, Object.assign({}, common, { mode: opts.mode || 'fine', residualBand: phaseBGuard, sweep: true, onLog: opts.onLog ? (l) => say(l) : (l) => lines.push(l) }, opts.phaseB || {}));
const res = { ok: false, status: '', phaseA: A, phaseB: B, band, bestPoint: null, bestScore: NaN, bestMetrics: null, bestResidualKg: NaN, bestDeployS: NaN,
                bestSource: null, evals: A.evals + B.evals, breakdown: { phaseA: A.evalBreakdown, phaseB: B.evalBreakdown },
                wallMs: 0, log: lines, leaderboard: [], meco: A.meco, probe: probeInfo };

  const cands = [];
  if (B.best) cands.push({ src: 'phaseB[' + B.best.tag + ']', point: B.best.fullPoint, score: B.best.score, metrics: B.best.metrics });
  if (Number.isFinite(A.score) && A.metrics) cands.push({ src: 'phaseA' + (skipPhaseA ? '(fixed)' : ''), point: A.point, score: A.score, metrics: A.metrics });
  cands.sort((a, b) => a.score - b.score);
  const best = skipPhaseA
    ? cands.find((c) => c.metrics && c.metrics.payloadCleared) || null
    : cands.find((c) => c.metrics && c.metrics.stageResidualKg >= band[0] && c.metrics.stageResidualKg <= band[1]) || null;
  if (best) {
    res.bestPoint = best.point; res.bestScore = best.score; res.bestMetrics = best.metrics; res.bestSource = best.src;
    res.bestResidualKg = best.metrics.stageResidualKg; res.bestDeployS = best.metrics.deployTimeS; res.ok = true; res.status = 'ok';
  } else res.status = skipPhaseA ? 'no cleared candidate' : 'phase B: no in-band candidate';

  const alt = opts.targetAltKm != null ? opts.targetAltKm : Cfg.fixed.targetAltKm;
  const rows = [], seen = new Map();
  const addRow = (row) => {
    const k = U.key(row.point);
    if (seen.has(k)) { const o = seen.get(k); if (o.src.indexOf(row.src) < 0) o.src += '+' + row.src; return; }
    seen.set(k, row); rows.push(row);
  };
  A.history.filter((e) => e.real && e.ok && e.metrics && e.point && e.meco === A.meco && e.gi === A.point.Gi)
  .forEach((e) => addRow(U.makeRow('A', 'A:' + e.kind, e.point, e.metrics, { deltaV: e.deltaV, targetAltKm: alt })));
B.candidates.forEach((c) => { if (!c.metrics || !(c.fullPoint || c.point)) return;
  addRow(U.makeRow('B', c.tag, c.fullPoint || c.point, c.metrics,
    { deltaV: c.deltaV, targetAltKm: alt, reject: !!c.resFail, reasons: c.resFail ? c.reasons : [] })); });
    res.leaderboard = U.sortRows(rows, 'score');
  res.meco = A.meco;
  res.wallMs = performance.now() - t0;
  say('=== runTuner ' + (res.ok ? 'OK' : 'FAILED') + ': ' + res.status + (res.ok ? ' | best=' + res.bestSource + ' score=' + res.bestScore.toFixed(3) + ' residual=' + fmt(res.bestResidualKg, 1) + ' kg deploy=' + fmt(res.bestDeployS, 2) + 's ' + JSON.stringify(U.describe(res.bestPoint)) : '') +
      ' | evals=' + res.evals + ' (A ' + A.evals + ' + B ' + B.evals + ') wall=' + (res.wallMs / 1000).toFixed(1) + 's');
  return res;
}

  // Backward-compat shim — some callers (mock test) reach for
  // TunerCore.runTuner directly. Registry remains the canonical path.
  T.runTuner = runTuner;

  T.registerStrategy('guided', {
    label: 'Pro-Alpha Engine',
    describe: 'probe MECO → Phase A search (MECO) → Phase B lane sweep (G/T/bias) → lead per lane',
    runTuner,
  });
})();
