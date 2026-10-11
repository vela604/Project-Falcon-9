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

  // Geometric probe distribution from target outward.
  // Gaps: target→p1 = d, p1→p2 = d·φ, ..., p_last→edge = d·φ^k.
  // Sum: d·(φ^(k+1)-1)/(φ-1) = room → solve d.
  // Edges are virtual anchors (no worker there). All probes strictly inside.
  function distributeProbes(lo, hi, target, N, ratio, quantumKg, includeEdges) {
    if (N < 1) return [];
    const loI = Math.round(lo), hiI = Math.round(hi);
    if (hiI - loI < 1) return [];
    let T = Math.round(target);
    if (T < loI) T = loI;
    if (T > hiI) T = hiI;

    // Edge probes only on first iteration — after that, bracket is trusted.
    const edgeProbes = [];
    let interiorN = N;
    if (includeEdges && hiI - loI > 1) {
      edgeProbes.push(loI, hiI);
      interiorN = Math.max(1, N - 2);
    }
    if (interiorN === 1) return edgeProbes.length ? edgeProbes.concat([T]).slice(0, N) : [T];

    const kTotal = interiorN - 1;
    const roomL = T - loI, roomR = hiI - T;

    let kL, kR;
    if (roomL < quantumKg && roomR < quantumKg) return [T];
    else if (roomL < quantumKg) { kL = 0; kR = kTotal; }
    else if (roomR < quantumKg) { kL = kTotal; kR = 0; }
    else if (kTotal % 2 === 0) { kL = kR = kTotal / 2; }
    else if (roomL > roomR) { kL = Math.ceil(kTotal / 2); kR = Math.floor(kTotal / 2); }
    else { kR = Math.ceil(kTotal / 2); kL = Math.floor(kTotal / 2); }

    const probes = [T];
    function spread(room, k, sign) {
      if (k <= 0 || room <= 0) return;
      const d = room * (ratio - 1) / (Math.pow(ratio, k + 1) - 1);
      for (let i = 1; i <= k; i++) {
        const dist = d * (Math.pow(ratio, i) - 1) / (ratio - 1);
        const m = Math.round(T + sign * dist);
        if (m > loI && m < hiI && m !== T) probes.push(m);
      }
    }
    spread(roomL, kL, -1);
    spread(roomR, kR, +1);

    const merged = edgeProbes.concat(probes);
    const seen = new Set();
    return merged.filter(m => { if (seen.has(m)) return false; seen.add(m); return true; });
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
    let init;
    if (opts._forceLo != null && opts._forceHi != null) {
      // First iteration has no fresh data — midpoint is honest.
      // Edges get probed as part of iter 1 (includeEdges), so both bracket
      // endpoints AND the center are evaluated in the same batch.
      // Iter 2+ refines the target using measured slope from iter 1.
      init = { lo: opts._forceLo, hi: opts._forceHi,
               source: 'forced-override',
               target: (opts._forceLo + opts._forceHi) / 2 };
    } else {
      init = pickInitialRange(matching, interp, minRange, safetyKg);
    }
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
      const probes = distributeProbes(lo, hi, target, pool.n, ratio, quantumKg, iter === 0);
      say('probes: ' + probes.map(m => m.toFixed(0)).join(', '));
      if (!probes.length) { say('no valid probes'); break; }

      const results = await Promise.all(probes.map(meco => {
        let p;
        if (interp) {
          const raw = interp(meco);
          p = snapPoint(raw, meco, Q);
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
        if (pred < 0) cls = 'fail';                    // stage fuel insufficient for circ burn
        else if (pred > bandHi) cls = 'up';
        else if (pred < bandLo) cls = 'down';
        else cls = 'in';
        return { meco: r.meco, cls, pred, m, point: r.point,
                 reason: cls === 'fail' ? 'neg-pred (stage-fuel-insufficient)' : null };
      });

      rows.sort((a, b) => a.meco - b.meco);
      for (const row of rows) {
        history.push(row);
        const pt = row.point || {};
        const Gs = Number.isFinite(pt.Gi) ? (pt.Gi * Q.G).toFixed(3) : '—';
        const bs = Number.isFinite(pt.bi) ? (pt.bi * Q.bias).toFixed(3) : '—';
        const ls = Number.isFinite(pt.li) ? (pt.li * Q.lead).toFixed(3) : '—';
        const tag = row.cls === 'in' ? 'IN  ' : row.cls === 'up' ? 'UP  ' : row.cls === 'down' ? 'DOWN' : 'FAIL';
        const predStr = Number.isFinite(row.pred) ? 'pred=' + row.pred.toFixed(1) + ' kg' : 'pred=—';
        say('  ' + row.meco + '  ' + tag + '  G=' + Gs + ' b=' + bs + ' lead=' + ls + '  ' + predStr +
            (row.cls === 'fail' ? '  (' + row.reason + ')' : ''));
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
      // A neg-pred fail is still a valid data point below the band (finite pred);
      // only exclude COAST_WAIT failures (no pred) and IN (already handled above).
      const dnP = withPred.filter(r => r.cls === 'down' || r.cls === 'fail');
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
