// ============================================================================
// rough-scan.js — Phase A of Zeta-Helix: find optimal MECO via parallel scan.
//
// Uses N Web Workers (TunerCore.WorkerPool). Each probe = COAST_WAIT_ENTRY
// eval; predicted stage residual = (mc + F_cw) * exp(-Δv/Ve) - mc, where
// F_cw = stageFuelAtStopKg, Δv = coastDeltaV from guidance.
//
// Bracket from roughRefs (data-fed); geometric probe distribution around a
// slope-predicted center; virtual anchors at bracket edges (real probes sit
// inside); φ spacing; bracket shrink per iteration; converges when a probe
// lands in [lo+safety, hi-safety].
//
// No checkpoint used — different MECO = different trajectory from cutoff.
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

  // --- pick initial bracket from refs (data-fed) ---
  function pickInitialRange(refs, stackId, altKm, fuelPct, minRange, defaultSlope) {
    const matching = (refs || []).filter(r =>
      (!stackId || !r.stackId || r.stackId === stackId) &&
      (r.altKm == null || r.altKm === altKm) &&
      (r.fuelPct == null || r.fuelPct === fuelPct)
    );
    if (matching.length < 1) {
      return { lo: minRange[0], hi: minRange[1], source: 'minRange-fallback' };
    }
    matching.sort((a, b) => a.meco - b.meco);
    if (matching.length === 1) {
      const r = matching[0];
      const slope = defaultSlope || -0.08;
      const target = r.meco + (150 - r.residualKg) / slope;
      return { lo: Math.max(minRange[0], target - 3000), hi: Math.min(minRange[1], target + 3000),
               source: 'single-ref-extrapolated', target };
    }
    // find pair bracketing residual 150
    let pair = null;
    for (let i = 1; i < matching.length; i++) {
      if (matching[i-1].residualKg >= 150 && matching[i].residualKg <= 150) {
        pair = [matching[i-1], matching[i]]; break;
      }
    }
    if (!pair) pair = [matching[0], matching[matching.length-1]];
    const slope = (pair[1].residualKg - pair[0].residualKg) / (pair[1].meco - pair[0].meco);
    const target = pair[0].meco + (150 - pair[0].residualKg) / slope;
    const mecoAt100 = pair[0].meco + (100 - pair[0].residualKg) / slope;
    const mecoAt200 = pair[0].meco + (200 - pair[0].residualKg) / slope;
    const lo = Math.max(minRange[0], Math.min(mecoAt100, mecoAt200));
    const hi = Math.min(minRange[1], Math.max(mecoAt100, mecoAt200));
    return { lo, hi, source: 'ref-pair', target, slope };
  }

  // --- geometric probe distribution ---
  function distributeProbes(lo, hi, target, N, ratio, quantumKg) {
    if (N < 1) return [];
    if (N === 1) return [Math.round(target)];
    const roomL = Math.max(0, target - lo);
    const roomR = Math.max(0, hi - target);
    let kL, kR;
    if ((N - 1) % 2 === 0) { kL = kR = (N - 1) / 2; }
    else if (roomL > roomR) { kL = Math.ceil((N - 1) / 2); kR = Math.floor((N - 1) / 2); }
    else { kR = Math.ceil((N - 1) / 2); kL = Math.floor((N - 1) / 2); }
    function spacing(room, k) {
      if (k === 0 || room <= 0) return 0;
      if (k === 1) return room;
      return room * (ratio - 1) / (Math.pow(ratio, k) - 1);
    }
    let dL = spacing(roomL, kL), dR = spacing(roomR, kR);
    if (dL > 0 && dL < quantumKg) dL = quantumKg;
    if (dR > 0 && dR < quantumKg) dR = quantumKg;
    const probes = [Math.round(target)];
    for (let i = 0; i < kL; i++) probes.push(Math.round(target - dL * Math.pow(ratio, i)));
    for (let i = 0; i < kR; i++) probes.push(Math.round(target + dR * Math.pow(ratio, i)));
    const seen = new Set();
    return probes
      .filter(m => m >= lo && m <= hi)
      .filter(m => { if (seen.has(m)) return false; seen.add(m); return true; });
  }

  // --- main entry ---
  async function roughScan(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig;
    const pool = opts.pool;
    if (!pool) throw new Error('roughScan needs opts.pool');
    if (!Number.isFinite(opts.mc) || !Number.isFinite(opts.Ve)) {
      throw new Error('roughScan needs opts.mc and opts.Ve');
    }

    const altKm = opts.altKm != null ? opts.altKm : Cfg.fixed.targetAltKm;
    const fuelPct = opts.fuelPct != null ? opts.fuelPct : 100;
    const stackId = opts.stackId != null ? opts.stackId : null;
    const refs = opts.refs || Cfg.roughRefs || [];
    const rsc = Cfg.roughScan || {};
    const minRange = opts.minRange || rsc.minRange || [20000, 80000];
    const ratio = opts.ratio || rsc.ratio || 1.618033988749895;
    const safetyKg = opts.safetyKg != null ? opts.safetyKg : (rsc.safetyKg || 40);
    const maxIters = opts.maxIters || rsc.maxIters || 8;
    const defaultSlope = rsc.defaultSlopeKgPerKg || -0.08;
    const quantumKg = opts.quantumKg || 30;  // ~30 kg / tick at full thrust
    const targetRes = opts.targetResidualKg || rsc.targetResidualKg || 150;
    const bandLo = safetyKg;             // 40
    const bandHi = 200 - safetyKg;       // 160

    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const t0 = performance.now();

    const init = pickInitialRange(refs, stackId, altKm, fuelPct, minRange, defaultSlope);
    say('initial bracket: [' + init.lo.toFixed(0) + ', ' + init.hi.toFixed(0) + ']  source=' + init.source +
        '  target=' + (Number.isFinite(init.target) ? init.target.toFixed(0) : '?'));
    let lo = init.lo, hi = init.hi, target = Number.isFinite(init.target) ? init.target : (lo + hi) / 2;

    const history = [];
    let totalEvals = 0;
    const mc = opts.mc, Ve = opts.Ve;

    for (let iter = 0; iter < maxIters; iter++) {
      if (hi - lo < quantumKg) { say('bracket collapsed to <quantum at iter ' + iter); break; }
      say('=== iter ' + (iter + 1) + ' bracket [' + lo.toFixed(0) + ', ' + hi.toFixed(0) + '] target=' + target.toFixed(0) + ' ===');
      const probes = distributeProbes(lo, hi, target, pool.n, ratio, quantumKg);
      say('probes: ' + probes.map(m => m.toFixed(0)).join(', '));
      if (!probes.length) { say('no valid probes'); break; }

      const results = await Promise.all(probes.map(meco => {
        const p = Object.assign({}, point, { meco });
        return pool.runEval(p, { stopAt: 'COAST_WAIT_ENTRY', quiet: true })
          .then(m => ({ meco, m }))
          .catch(e => ({ meco, error: e.message }));
      }));
      totalEvals += probes.length;

      const rows = results.map(r => {
        if (r.error) return { meco: r.meco, cls: 'fail', reason: r.error };
        const m = r.m;
        if (m.endReason !== 'COAST_WAIT_ENTRY' || !Number.isFinite(m.coastDeltaV) || !Number.isFinite(m.stageFuelAtStopKg)) {
          return { meco: r.meco, cls: 'fail', reason: m.endReason };
        }
        const pred = (mc + m.stageFuelAtStopKg) * Math.exp(-m.coastDeltaV / Ve) - mc;
        let cls;
        if (pred > bandHi) cls = 'up';
        else if (pred < bandLo) cls = 'down';
        else cls = 'in';
        return { meco: r.meco, cls, pred, m };
      });

      rows.sort((a, b) => a.meco - b.meco);
      for (const row of rows) {
        history.push(row);
        if (row.cls === 'in') say('  ' + row.meco + '  IN   pred=' + row.pred.toFixed(1));
        else if (row.cls === 'up') say('  ' + row.meco + '  UP   pred=' + row.pred.toFixed(1));
        else if (row.cls === 'down') say('  ' + row.meco + '  DOWN pred=' + row.pred.toFixed(1));
        else say('  ' + row.meco + '  FAIL ' + row.reason);
      }

      const inHits = rows.filter(r => r.cls === 'in').sort((a, b) => b.meco - a.meco);
      if (inHits.length) {
        const best = inHits[0];
        say('=== converged: MECO=' + best.meco + '  pred=' + best.pred.toFixed(1) + ' kg ===');
        return { ok: true, meco: best.meco, predictedResidual: best.pred,
                 history, evals: totalEvals, wallMs: performance.now() - t0, log: lines, reason: 'in-band' };
      }

      const ups = rows.filter(r => r.cls === 'up').map(r => r.meco);
      const downs = rows.filter(r => r.cls === 'down' || r.cls === 'fail').map(r => r.meco);
      const newLo = ups.length ? Math.max(...ups) : lo;
      const newHi = downs.length ? Math.min(...downs) : hi;
      if (newLo >= newHi) { say('=== bracket collapsed, no in-band hit ==='); break; }
      if (newLo === lo && newHi === hi) { say('=== no progress ==='); break; }
      lo = newLo; hi = newHi;
      // refine target via latest slope
      const sortedUp = rows.filter(r => r.cls === 'up' && Number.isFinite(r.pred));
      const sortedDown = rows.filter(r => r.cls === 'down' && Number.isFinite(r.pred));
      if (sortedUp.length && sortedDown.length) {
        const a = sortedUp[sortedUp.length - 1];
        const b = sortedDown[0];
        const s = (b.pred - a.pred) / (b.meco - a.meco);
        if (s < 0) target = a.meco + (targetRes - a.pred) / s;
      }
    }

    // fallback: pick probe closest to targetRes among those with pred in [0, 200]
    const cands = history.filter(r => Number.isFinite(r.pred) && r.pred <= 200 && r.pred >= 0);
    cands.sort((a, b) => Math.abs(a.pred - targetRes) - Math.abs(b.pred - targetRes));
    const fallback = cands[0] || null;
    if (fallback) say('=== fallback: MECO=' + fallback.meco + '  pred=' + fallback.pred.toFixed(1) + ' ===');
    return {
      ok: false, reason: 'no-in-band',
      meco: fallback ? fallback.meco : null,
      predictedResidual: fallback ? fallback.pred : NaN,
      history, evals: totalEvals, wallMs: performance.now() - t0, log: lines,
    };
  }

  T.roughScan = roughScan;
  T.distributeProbes = distributeProbes;
  T.pickInitialRange = pickInitialRange;
})();
