// ============================================================================
// rough-scan.js — Phase A of Zeta-Helix: find optimal MECO via parallel scan.
//
// Two data paths:
//   1. Refs available (>= 2 matching) → interp G/T/bias/lead from MECO linearly.
//      Bracket = where interp residual crosses 200-safety and 100+safety.
//   2. No refs → fallback to config minRange.
//
// Probes: geometric distribution around slope-predicted center, φ ratio,
// cumulative spacing (gaps form geometric sequence). N workers parallel.
// Accept: predicted residual ∈ [100+safety, 200-safety] = [140, 160].
// Multiple hits: highest MECO (closest to 100 residual, max fuel savings).
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

  function pickRefs(refs, stackId, altKm, fuelPct) {
    return (refs || []).filter(r =>
      (!stackId || !r.stackId || r.stackId === stackId) &&
      (r.altKm == null || r.altKm === altKm) &&
      (r.fuelPct == null || r.fuelPct === fuelPct)
    ).sort((a, b) => a.meco - b.meco);
  }

  // Linear interp/extrapolate G, T, bias, lead, residual from MECO.
  function buildInterp(matching) {
    if (matching.length < 2) return null;
    return function (meco) {
      let a = matching[0], b = matching[1];
      for (let i = 1; i < matching.length; i++) {
        if (meco >= matching[i-1].meco && meco <= matching[i].meco) {
          a = matching[i-1]; b = matching[i]; break;
        }
      }
      if (meco < matching[0].meco) { a = matching[0]; b = matching[1]; }
      if (meco > matching[matching.length-1].meco) {
        a = matching[matching.length-2]; b = matching[matching.length-1];
      }
      const dmeco = b.meco - a.meco || 1;
      const k = (meco - a.meco) / dmeco;
      return {
        G:    a.G    + (b.G    - a.G)    * k,
        T:    a.T    + (b.T    - a.T)    * k,
        bias: a.bias + (b.bias - a.bias) * k,
        lead: a.lead + (b.lead - a.lead) * k,
        residualKg: a.residualKg + (b.residualKg - a.residualKg) * k,
      };
    };
  }

  // Bracket from interp: find MECO where residual crosses 200-safety (going down)
  // and 100+safety (going down). Scan a wide window on both sides of refs.
  function pickInitialRange(matching, interp, minRange, safetyKg) {
    if (!interp) return { lo: minRange[0], hi: minRange[1], source: 'minRange-fallback' };
    const hiEdge = 200 - safetyKg;  // 160
    const loEdge = 100 + safetyKg;  // 140
    const first = matching[0].meco, last = matching[matching.length-1].meco;
    const span = Math.max(1, last - first);
    const start = Math.max(minRange[0], first - 2 * span);
    const end = Math.min(minRange[1], last + 2 * span);
    const step = Math.max(10, (end - start) / 200);
    let prev = null;
    let mecoAt_hi = null, mecoAt_lo = null;
    for (let m = start; m <= end; m += step) {
      const r = interp(m).residualKg;
      if (prev && prev.r >= hiEdge && r <= hiEdge && mecoAt_hi == null) {
        const k = (hiEdge - prev.r) / (r - prev.r);
        mecoAt_hi = prev.m + k * (m - prev.m);
      }
      if (prev && prev.r >= loEdge && r <= loEdge && mecoAt_lo == null) {
        const k = (loEdge - prev.r) / (r - prev.r);
        mecoAt_lo = prev.m + k * (m - prev.m);
      }
      prev = { m, r };
      if (mecoAt_hi != null && mecoAt_lo != null) break;
    }
    if (mecoAt_hi != null && mecoAt_lo != null && mecoAt_hi < mecoAt_lo) {
      return { lo: Math.max(minRange[0], mecoAt_hi),
               hi: Math.min(minRange[1], mecoAt_lo),
               source: 'residual-slope-bracket',
               target: (mecoAt_hi + mecoAt_lo) / 2 };
    }
    // fallback: single pair extrapolation
    const a = matching[matching.length-2], b = matching[matching.length-1];
    const slope = (b.residualKg - a.residualKg) / (b.meco - a.meco);
    if (slope < 0) {
      const t = b.meco + (150 - b.residualKg) / slope;
      return { lo: Math.max(minRange[0], t - 2000), hi: Math.min(minRange[1], t + 2000),
               source: 'last-pair-extrapolated', target: t };
    }
    return { lo: minRange[0], hi: minRange[1], source: 'fallback' };
  }

  // Geometric cumulative distribution: gaps are d, d*r, d*r^2, ...
  // probes at target ± (d, d+dr, d+dr+dr^2, ...)
  function distributeProbes(lo, hi, target, N, ratio, quantumKg) {
    if (N < 1) return [];
    if (N === 1) return [Math.round(Math.max(lo, Math.min(hi, target)))];
    const roomL = Math.max(0, target - lo);
    const roomR = Math.max(0, hi - target);
    let kL, kR;
    if ((N - 1) % 2 === 0) { kL = kR = (N - 1) / 2; }
    else if (roomL > roomR) { kL = Math.ceil((N - 1) / 2); kR = Math.floor((N - 1) / 2); }
    else { kR = Math.ceil((N - 1) / 2); kL = Math.floor((N - 1) / 2); }
    function d1(room, k) {
      if (k === 0 || room <= 0) return 0;
      if (k === 1) return room;
      return room * (ratio - 1) / (Math.pow(ratio, k) - 1);
    }
    let dL = d1(roomL, kL), dR = d1(roomR, kR);
    if (dL > 0 && dL < quantumKg) {
      dL = quantumKg;
      // recompute ratio locally so outermost = roomL
      if (roomL > dL && kL > 1) {
        // solve r from dL*(r^k-1)/(r-1)=roomL; approximate by increasing ratio
        let r = ratio;
        for (let i = 0; i < 40; i++) {
          const f = dL * (Math.pow(r, kL) - 1) / (r - 1) - roomL;
          if (Math.abs(f) < 1) break;
          r = r * (1 + f / roomL * 0.5);
          r = Math.max(1.01, Math.min(5, r));
        }
        dR = dR; // keep other side unchanged
        // Apply local ratio
        var localRatioL = r;
      }
    }
    if (dR > 0 && dR < quantumKg) {
      dR = quantumKg;
      if (roomR > dR && kR > 1) {
        let r = ratio;
        for (let i = 0; i < 40; i++) {
          const f = dR * (Math.pow(r, kR) - 1) / (r - 1) - roomR;
          if (Math.abs(f) < 1) break;
          r = r * (1 + f / roomR * 0.5);
          r = Math.max(1.01, Math.min(5, r));
        }
        var localRatioR = r;
      }
    }
    const rL = localRatioL || ratio;
    const rR = localRatioR || ratio;
    const probes = [Math.round(target)];
    let cum = 0;
    for (let i = 0; i < kL; i++) {
      cum += dL * Math.pow(rL, i);
      probes.push(Math.round(target - cum));
    }
    cum = 0;
    for (let i = 0; i < kR; i++) {
      cum += dR * Math.pow(rR, i);
      probes.push(Math.round(target + cum));
    }
    const seen = new Set();
    return probes
      .filter(m => m >= lo && m <= hi)
      .filter(m => { if (seen.has(m)) return false; seen.add(m); return true; });
  }

  function snapPoint(raw, meco, Q) {
    return {
      Gi: Math.max(0, Math.round(raw.G / Q.G)),
      Tn: Math.max(0, Math.round(raw.T / Q.T)),
      bi: Math.round(raw.bias / Q.bias),
      li: Math.max(0, Math.round(raw.lead / Q.lead)),
      meco: Math.round(meco),
    };
  }

  async function roughScan(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, Q = Cfg.quanta;
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
    const quantumKg = opts.quantumKg || 30;
    const targetRes = opts.targetResidualKg || rsc.targetResidualKg || 150;
    const bandLo = 100 + safetyKg;
    const bandHi = 200 - safetyKg;

    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const t0 = performance.now();

    const matching = pickRefs(refs, stackId, altKm, fuelPct);
    const interp = buildInterp(matching);
    const init = pickInitialRange(matching, interp, minRange, safetyKg);
    say('refs matched: ' + matching.length + (interp ? ' (interp ready)' : ' (no interp)'));
    say('initial bracket: [' + init.lo.toFixed(0) + ', ' + init.hi.toFixed(0) + ']  source=' + init.source +
        '  target=' + (Number.isFinite(init.target) ? init.target.toFixed(0) : '?'));
    let lo = init.lo, hi = init.hi, target = Number.isFinite(init.target) ? init.target : (lo + hi) / 2;

    const history = [];
    let totalEvals = 0;
    const mc = opts.mc, Ve = opts.Ve;

    // Fallback point when no interp available
    const basePoint = point;

    for (let iter = 0; iter < maxIters; iter++) {
      if (hi - lo < quantumKg) { say('bracket collapsed < quantum at iter ' + iter); break; }
      say('=== iter ' + (iter + 1) + '  bracket [' + lo.toFixed(0) + ', ' + hi.toFixed(0) + '] target=' + target.toFixed(0) + ' ===');
      const probes = distributeProbes(lo, hi, target, pool.n, ratio, quantumKg);
      say('probes: ' + probes.map(m => m.toFixed(0)).join(', '));
      if (!probes.length) { say('no valid probes'); break; }

      const results = await Promise.all(probes.map(meco => {
        let p;
        if (interp) {
          const raw = interp(meco);
          p = snapPoint(raw, meco, Q);
          say('  probe ' + meco + ' -> G=' + (p.Gi * Q.G).toFixed(3) + ' bias=' + (p.bi * Q.bias).toFixed(3) +
              ' lead=' + (p.li * Q.lead).toFixed(3) + ' (interp)');
        } else {
          p = Object.assign({}, basePoint, { meco });
        }
        return pool.runEval(p, { stopAt: 'COAST_WAIT_ENTRY', quiet: true })
          .then(m => ({ meco, m, point: p }))
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
        return { meco: r.meco, cls, pred, m, point: r.point };
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
        say('=== converged MECO=' + best.meco + '  pred=' + best.pred.toFixed(1) + ' kg  G=' + (best.point.Gi*Q.G).toFixed(3) + ' bias=' + (best.point.bi*Q.bias).toFixed(3) + ' ===');
        return { ok: true, meco: best.meco, predictedResidual: best.pred,
                 point: best.point,
                 history, evals: totalEvals, wallMs: performance.now() - t0, log: lines, reason: 'in-band' };
      }

      const ups = rows.filter(r => r.cls === 'up').map(r => r.meco);
      const downs = rows.filter(r => r.cls === 'down' || r.cls === 'fail').map(r => r.meco);
      const newLo = ups.length ? Math.max(...ups) : lo;
      const newHi = downs.length ? Math.min(...downs) : hi;
      if (newLo >= newHi) { say('bracket collapsed'); break; }
      if (newLo === lo && newHi === hi) { say('no progress'); break; }
      lo = newLo; hi = newHi;

      // refine target using observed preds
      const withPred = rows.filter(r => Number.isFinite(r.pred));
      const upP = withPred.filter(r => r.cls === 'up');
      const dnP = withPred.filter(r => r.cls === 'down');
      if (upP.length && dnP.length) {
        const a = upP[upP.length - 1], b = dnP[0];
        const s = (b.pred - a.pred) / (b.meco - a.meco);
        if (s < 0) target = a.meco + (targetRes - a.pred) / s;
      }
    }

    const cands = history.filter(r => Number.isFinite(r.pred) && r.pred <= 200 && r.pred >= 0);
    cands.sort((a, b) => Math.abs(a.pred - targetRes) - Math.abs(b.pred - targetRes));
    const fb = cands[0] || null;
    if (fb) say('fallback: MECO=' + fb.meco + ' pred=' + fb.pred.toFixed(1));
    return { ok: false, reason: 'no-in-band',
             meco: fb ? fb.meco : null, predictedResidual: fb ? fb.pred : NaN, point: fb ? fb.point : null,
             history, evals: totalEvals, wallMs: performance.now() - t0, log: lines };
  }

  T.roughScan = roughScan;
  T.distributeProbes = distributeProbes;
  T.pickInitialRange = pickInitialRange;
})();
