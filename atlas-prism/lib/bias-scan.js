// ============================================================================
// bias-scan.js — for a fixed (G, T, MECO), find the bias that yields a target
// specific orbital energy at COAST_WAIT entry.
//
// Search space: bias only. Range typically [-3, 3] (user configurable).
// Same geometric φ distribution as rough-scan; probes strictly inside;
// edges probed on iter 0; bracket shrinks per iteration.
//
// Classification: E < E_target → "lo" side; E > E_target → "hi" side.
// Direction from data (no assumed monotonicity).
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

  // Reuse the geometric distribution from rough-scan (same file, T.distributeProbes)
  function probes(biLo, biHi, target, N, ratio, quantum, includeEdges) {
    if (T.distributeProbes) return T.distributeProbes(biLo, biHi, target, N, ratio, quantum, includeEdges);
    // fallback: uniform
    const step = (biHi - biLo) / (N - 1 || 1);
    const out = [];
    for (let i = 0; i < N; i++) out.push(Math.round(biLo + i * step));
    return out;
  }

  async function biasScan(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, Q = Cfg.quanta;
    const pool = opts.pool;
    if (!pool) throw new Error('biasScan needs opts.pool');

    const biRange = opts.biRange || [-3 / Q.bias, 3 / Q.bias];  // in bias quanta
    const biTol = opts.biTol || Math.round(0.001 / Q.bias);      // 0.001 deg
    const ratio = opts.ratio || 1.618033988749895;
    const quantum = opts.quantum || Math.round(0.02 / Q.bias);   // ~0.02 deg
    const maxIters = opts.maxIters || 8;
    const E_target = opts.E_target;
    const E_tol = opts.E_tol || 1e5;  // J/kg absolute; ~0.1% of typical E
    if (!Number.isFinite(E_target)) throw new Error('biasScan needs opts.E_target');

    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const t0 = performance.now();

    const RE = root.CONFIG ? root.CONFIG.EARTH_RADIUS : 6371000;
    const GM = root.CONFIG ? root.CONFIG.GM_EARTH : 3.986e14;

    const specE = (m) => {
      if (!Number.isFinite(m.vrCoast) || !Number.isFinite(m.vtCoast) || !Number.isFinite(m.altCoastKm)) return NaN;
      const r = RE + m.altCoastKm * 1000;
      return 0.5 * (m.vrCoast * m.vrCoast + m.vtCoast * m.vtCoast) - GM / r;
    };

    let lo = biRange[0], hi = biRange[1];
    let target = opts.biTarget != null ? opts.biTarget : Math.round((lo + hi) / 2);

    const history = [];
    let evals = 0;
    let globalBest = null;
    const trackBest = (row) => {
      if (!Number.isFinite(row.E)) return;
      const d = Math.abs(row.E - E_target);
      if (!globalBest || d < Math.abs(globalBest.E - E_target)) globalBest = row;
    };

    say('biasScan: E_target = ' + E_target.toExponential(4) + ' J/kg  range=[' + (lo*Q.bias).toFixed(4) + ',' + (hi*Q.bias).toFixed(4) + '] deg  tol=' + (biTol*Q.bias).toFixed(4) + ' deg');

    for (let iter = 0; iter < maxIters; iter++) {
      if (hi - lo < biTol) { say('bracket collapsed < tol at iter ' + iter); break; }
      say('=== iter ' + (iter + 1) + '  bracket [' + (lo*Q.bias).toFixed(4) + ', ' + (hi*Q.bias).toFixed(4) + '] deg  target=' + (target*Q.bias).toFixed(4) + ' ===');
      const bp = probes(lo, hi, target, pool.n, ratio, quantum, iter === 0);
      say('probes: ' + bp.map(x => (x*Q.bias).toFixed(4)).join(', '));
      if (!bp.length) { say('no probes'); break; }

      const results = await Promise.all(bp.map(bi => {
        const p = Object.assign({}, point, { bi });
        return pool.runEval(p, { stopAt: 'COAST_WAIT_ENTRY', quiet: true })
          .then(m => ({ bi, m, E: specE(m), end: m.endReason, ecc: m.eCoast }))
          .catch(e => ({ bi, error: e.message }));
      }));
      evals += bp.length;

      const rows = results.map(r => {
        if (r.error || r.end !== 'COAST_WAIT_ENTRY' || !Number.isFinite(r.E)) {
          return { bi: r.bi, cls: 'fail', reason: r.error || r.end };
        }
        const dE = r.E - E_target;
        let cls;
        if (Math.abs(dE) < E_tol) cls = 'in';
        else if (dE < 0) cls = 'lo';    // E too low
        else cls = 'hi';                 // E too high
        return { bi: r.bi, cls, E: r.E, ecc: r.ecc, m: r.m };
      });

      rows.sort((a, b) => a.bi - b.bi);
      for (const row of rows) {
        history.push(row);
        trackBest(row);
        const bDeg = (row.bi * Q.bias).toFixed(4);
        if (row.cls === 'in') say('  b=' + bDeg + '  IN   E=' + row.E.toExponential(4) + '  ecc=' + row.ecc.toFixed(5));
        else if (row.cls === 'lo') say('  b=' + bDeg + '  LO   E=' + row.E.toExponential(4) + '  ecc=' + row.ecc.toFixed(5) + '  dE=' + (row.E-E_target).toExponential(2));
        else if (row.cls === 'hi') say('  b=' + bDeg + '  HI   E=' + row.E.toExponential(4) + '  ecc=' + row.ecc.toFixed(5) + '  dE=' + (row.E-E_target).toExponential(2));
        else say('  b=' + bDeg + '  FAIL ' + row.reason);
      }

      const inHits = rows.filter(r => r.cls === 'in');
      if (inHits.length) {
        const best = inHits[0];
        say('=== converged: bias=' + (best.bi * Q.bias).toFixed(4) + '  E=' + best.E.toExponential(4) + '  ecc=' + best.ecc.toFixed(5) + ' ===');
        return { ok: true, bias: best.bi * Q.bias, biasQ: best.bi, E: best.E, ecc: best.ecc,
                 metrics: best.m, history, evals, wallMs: performance.now() - t0, log: lines, reason: 'in-tol' };
      }

      const los = rows.filter(r => r.cls === 'lo').map(r => r.bi);
      const his = rows.filter(r => r.cls === 'hi').map(r => r.bi);
      const fails = rows.filter(r => r.cls === 'fail').map(r => r.bi);
      let newLo = lo, newHi = hi;

      if (los.length && his.length) {
        // Find the closest LO/HI pair by bias — that's the crossing.
        // E vs bias can be increasing OR decreasing (V-shape), so we cannot
        // assume lo-bias < hi-bias.
        let bestGap = Infinity, pL = null, pH = null;
        for (const l of los) {
          for (const h of his) {
            const gap = Math.abs(l - h);
            if (gap < bestGap) { bestGap = gap; pL = l; pH = h; }
          }
        }
        if (pL != null && pH != null) {
          newLo = Math.min(pL, pH);
          newHi = Math.max(pL, pH);
        }
      } else if (los.length) {
        // All valid probes are "lo" (E below target). Shrink from above.
        // Fail probes below that point act as the low boundary marker
        // (the boundary between crash and valid is somewhere between them,
        // but we only need a valid probe; probing again at the fail site
        // would waste an eval).
        newHi = Math.min(...los);
        const failsBelow = fails.filter(x => x < newHi);
        if (failsBelow.length) newLo = Math.max(...failsBelow);
        // else: keep old lo (crash not observed in this batch).
      } else if (his.length) {
        // All valid probes are "hi" (E above target). Shrink from below.
        newLo = Math.max(...his);
        const failsAbove = fails.filter(x => x > newLo);
        if (failsAbove.length) newHi = Math.min(...failsAbove);
      } else {
        say('all probes failed — no info to bracket');
        break;
      }

      if (newLo >= newHi || (newLo === lo && newHi === hi)) {
        // Bracket exhausted. Return global best from any iteration.
        if (globalBest) {
          say('  bracket exhausted -> returning global best (b=' + (globalBest.bi * Q.bias).toFixed(4) + ' E=' + globalBest.E.toExponential(4) + ' Δ=' + ((globalBest.E - E_target) / 1e5).toFixed(2) + 'e5)');
          return { ok: false, reason: 'bracket-exhausted',
                   bias: globalBest.bi * Q.bias, biasQ: globalBest.bi,
                   E: globalBest.E, ecc: globalBest.ecc, metrics: globalBest.m,
                   history, evals, wallMs: performance.now() - t0, log: lines };
        }
        say('bracket exhausted, no valid candidates');
        break;
      }
      say('  bracket -> [' + (newLo*Q.bias).toFixed(4) + ', ' + (newHi*Q.bias).toFixed(4) + ']');
      lo = newLo; hi = newHi;
      // refine target via observed slope
      const valid = rows.filter(r => Number.isFinite(r.E) && r.cls !== 'fail');
      if (valid.length >= 2) {
        valid.sort((a, b) => a.bi - b.bi);
        const a = valid[0], b = valid[valid.length - 1];
        const slope = (b.E - a.E) / (b.bi - a.bi);
        if (Math.abs(slope) > 1) {
          const guess = a.bi + (E_target - a.E) / slope;
          target = Math.max(lo + quantum, Math.min(hi - quantum, Math.round(guess)));
        } else {
          target = Math.round((lo + hi) / 2);
        }
      } else {
        target = Math.round((lo + hi) / 2);
      }
    }

    const cands = history.filter(r => Number.isFinite(r.E));
    cands.sort((a, b) => Math.abs(a.E - E_target) - Math.abs(b.E - E_target));
    const fb = globalBest || cands[0] || null;
    return { ok: false, reason: 'no-in-tol',
             bias: fb ? fb.bi * Q.bias : null, biasQ: fb ? fb.bi : null,
             E: fb ? fb.E : NaN, ecc: fb ? fb.ecc : NaN, metrics: fb ? fb.m : null,
             history, evals, wallMs: performance.now() - t0, log: lines };
  }

  T.biasScan = biasScan;
})();
