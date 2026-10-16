// ============================================================================
// bootstrap.js — Universal bootstrap (extracted from universal-bootstrap-test.html)
//
// Finds (MECO, G, bias range) for any target altitude, using SA + CH snapshot
// sharing. Called from universal-bootstrap-test.html (thin wrapper) and
// from SERENO FLUX (OPT-MECO replacement).
//
// Public API on TunerCore:
//   T.UB                — pure helpers (pass, key, setNorm, maxPred, edgeBias,
//                         rangeAtG, localBest, pickRows)
//   T.runBootstrap(opts) — full pipeline, returns { ok, champs, good, table,
//                         rows, chosen, evals, wallMs, status, error? }
//   T.verifyPointSingle(opts) — single-point verifyChain (debug)
//
// opts shape: { pool, params, onLog, onStatus?, abortRef? }
// params fields: alt, K, bmax, mLo, mHi, mN, mq, gLoI, gHiI, gStep, Tn, li,
//   predTarget, predMin, predMax, ideal, eps, tScale, dpts, nbr, tol, tolHi,
//   tfrac, kc, dvMin, tbMin, tApoMax, trim, bres
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

  // ---------------- Pure helpers ----------------
  const UB = (function () {
    const BQ = 0.0001;
    const pass = (r, P) => !!(r && r.ok && Number.isFinite(r.pred) && r.pred >= P.predMin);
    const key = (r, P) => {
      if (!pass(r, P) || !Number.isFinite(r.tEst) || !P.norm) return Infinity;
      const n = P.norm;
      const tN = (r.tEst - n.tLo) / n.tSpan, fN = 1 - (r.M - n.mLo) / n.mSpan;
      return (1 - P.ideal) * tN + P.ideal * fN;
    };
    function setNorm(recs, P) {
      const ps = recs.filter((r) => pass(r, P) && Number.isFinite(r.tEst));
      if (!ps.length) { P.norm = null; return null; }
      const ts = ps.map((r) => r.tEst), ms = ps.map((r) => r.M);
      const tLo = Math.min.apply(null, ts), tHi = Math.max.apply(null, ts);
      const mLo = Math.min.apply(null, ms), mHi = Math.max.apply(null, ms);
      P.norm = { tLo, tSpan: Math.max(1, tHi - tLo), mLo, mSpan: Math.max(1, mHi - mLo, (P.mHi - P.mLo) / 3) };
      return P.norm;
    }
    const maxPred = (recs, P) => recs.filter((r) => pass(r, P)).reduce((b, r) => (!b || key(r, P) < key(b, P)) ? r : b, null);

    async function edgeBias(ev, P, Gi, b0, sign, bound, res, k, onRound) {
      const at = (t) => ev(Gi, sign * t);
      let lo = sign * b0, hi = bound, nonContig = false;
      if (lo >= hi) return { t: lo, clipped: true, nonContig };
      if (pass(await at(hi), P)) return { t: hi, clipped: true, nonContig };
      while (hi - lo > res) {
        const pts = [];
        for (let j = 1; j <= k; j++) { const t = lo + Math.round((hi - lo) * j / (k + 1)); if (t > lo && t < hi && !pts.includes(t)) pts.push(t); }
        if (!pts.length) break;
        const rs = await Promise.all(pts.map(at));
        let j = 0, nlo = lo, nhi = hi;
        while (j < pts.length && pass(rs[j], P)) { nlo = pts[j]; j++; }
        if (j < pts.length) { nhi = pts[j]; for (let q = j + 1; q < pts.length; q++) if (pass(rs[q], P)) nonContig = true; }
        if (onRound) onRound(sign, pts, rs, nlo, nhi);
        lo = nlo; hi = nhi;
      }
      return { t: lo, clipped: false, nonContig };
    }

    async function rangeAtG(ev, P, Gi, b0, k, onRound) {
      const bound = Math.round(P.bmax / BQ), res = Math.max(1, Math.round(P.bres / BQ));
      const pair = await Promise.all([
        edgeBias(ev, P, Gi, b0, +1, bound, res, k, onRound),
        edgeBias(ev, P, Gi, b0, -1, bound, res, k, onRound),
      ]);
      const up = pair[0], dn = pair[1];
      const lo = -dn.t, hi = up.t;
      return { Gi, lo, hi, width: hi - lo, mid: (lo + hi) / 2, clipLo: dn.clipped, clipHi: up.clipped, nonContig: up.nonContig || dn.nonContig };
    }

    async function localBest(ev, P, M, seed, cap) {
      cap = cap || 140;
      const Bi = Math.round(P.bmax / BQ), gLo = P.gLoI, gHi = P.gHiI;
      let used = 0;
      const evalSet = async (pts) => {
        const fresh = pts.filter((p) => p.Gi >= gLo && p.Gi <= gHi && Math.abs(p.bi) <= Bi);
        used += fresh.length;
        return Promise.all(fresh.map((p) => ev(M, p.Gi, p.bi)));
      };
      let c = { Gi: seed.Gi, bi: seed.bi }, best = null;
      let rG = 2, sb = Math.round(0.5 / BQ);
      for (; ;) {
        const pts = [{ Gi: c.Gi, bi: c.bi }];
        for (const dg of [-1, 0, 1]) for (const db of [-1, 0, 1]) if (dg || db) pts.push({ Gi: c.Gi + dg * rG, bi: c.bi + db * sb });
        best = maxPred(await evalSet(pts), P);
        if (best) break;
        rG *= 2; sb *= 2;
        if (rG > 16 || used > cap) return null;
      }
      c = { Gi: best.Gi, bi: best.bi };
      while (used < cap) {
        const pts = [];
        for (const dg of [-1, 0, 1]) for (const db of [-1, 0, 1]) if (dg || db) pts.push({ Gi: c.Gi + dg * rG, bi: c.bi + db * sb });
        const nb = maxPred(await evalSet(pts), P);
        if (nb && key(nb, P) < key(best, P) - P.eps) { best = nb; c = { Gi: nb.Gi, bi: nb.bi }; continue; }
        if (rG > 1) { rG = Math.ceil(rG / 2); sb = Math.max(1, Math.round(sb / 2)); }
        else if (sb > Math.round(0.03 / BQ)) sb = Math.round(sb / 2);
        else break;
      }
      return best;
    }

    function pickRows(rows, K, bestGi) {
      const arr = Object.keys(rows).map((g) => rows[g]);
      const chosen = [];
      const first = arr.find((r) => r.Gi === bestGi) || arr.slice().sort((a, b) => b.width - a.width)[0];
      if (!first) return [];
      chosen.push(first);
      for (const r of arr.slice().sort((a, b) => b.width - a.width)) {
        if (chosen.length >= K) break;
        if (chosen.every((c) => Math.abs(c.Gi - r.Gi) >= 2)) chosen.push(r);
      }
      return chosen.sort((a, b) => a.Gi - b.Gi);
    }

    return { BQ, pass, key, setNorm, maxPred, edgeBias, rangeAtG, localBest, pickRows };
  })();

  const f1 = (x, d) => Number.isFinite(x) ? x.toFixed(d) : '--';
  const gfmt = (gi) => (gi / 100).toFixed(2);
  const bfmt = (bi) => ((bi >= 0 ? '+' : '') + (bi * UB.BQ).toFixed(4));
  function linspace(a, b, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(Math.round((a + (b - a) * i / (n - 1)) / 10) * 10);
    return out;
  }
  const nowMs = () => (typeof performance !== 'undefined') ? performance.now() : Date.now();
  const abort = (ctx) => !!(ctx.abortRef && ctx.abortRef.aborted);

  // ---------------- Metrics classification ----------------
  function classify(m, P) {
    if (m.endReason === 'STAGE_VR_NEG') return 'F1_BURN';
    if (m.crashed || m.endReason === 'CRASHED') return 'CRASH';
    if (m.endReason !== 'COAST_WAIT_ENTRY') return 'OTHER:' + m.endReason;
    if (!Number.isFinite(m.apoCoastKm)) return 'OTHER:noApo';
    if (m.apoCoastKm < P.alt - P.tol) return 'APO_SHORT';
    if (m.apoCoastKm > P.alt + P.tolHi) return 'APO_LONG';
    if (!Number.isFinite(m.circDvMaxMps) || !Number.isFinite(m.circTBurnS) || !Number.isFinite(m.tToApoCoastS)) return 'OTHER:noPhys';
    if (m.coastDeltaV < P.dvMin * (1 - P.ideal) || m.circTBurnS < P.tbMin * (1 - P.ideal)) return 'NEAR_ORBIT';
    if (P.tApoMax > 0 && m.tToApoCoastS > P.tApoMax) return 'LONG_COAST';
    if (m.circTBurnS > P.tfrac * m.tToApoCoastS) return 'FAIL_PHYS';
    return 'OK';
  }

  // ---------------- Evaluator (uses pool.runEvalSA — Level 2 SA sharing) ----------------
  function makeEv(ctx) {
    const pool = ctx.pool, P = ctx.P;
    const cache = new Map(), inflight = new Map();
    const fn = (M, Gi, bi) => {
      const k = M + '|' + Gi + '|' + bi;
      if (cache.has(k)) return Promise.resolve(cache.get(k));
      if (inflight.has(k)) return inflight.get(k);
      if (abort(ctx)) return Promise.reject(new Error('stopped'));
      const point = { Gi, Tn: P.Tn, bi, li: P.li, meco: M };
      const p = pool.runEvalSA(point, { stopAt: 'COAST_WAIT_ENTRY', abortOnStageVrNeg: true, targetAltKm: P.alt, quiet: true }).then((m) => {
        const cls = classify(m, P);
        const pred = (Number.isFinite(m.circM0Kg) && Number.isFinite(m.circVe) && Number.isFinite(m.coastDeltaV))
          ? m.circM0Kg * Math.exp(-m.coastDeltaV / m.circVe) - m.circDryKg + P.kc * m.coastDeltaV : NaN;
        const rec = { M, Gi, bi, cls, ok: cls === 'OK', pred, dv: m.coastDeltaV, apoC: m.apoCoastKm, wall: m.wallMs,
          tApo: m.tToApoCoastS, tEst: m.simTimeEnd + m.tToApoCoastS + 15 };
        cache.set(k, rec); inflight.delete(k); ctx.evals.n++;
        if (ctx.evals.n % 10 === 0 && ctx.onStatus) ctx.onStatus('evals done: ' + ctx.evals.n);
        return rec;
      });
      inflight.set(k, p); return p;
    };
    fn.cache = cache;
    fn.byM = (M) => Array.from(cache.values()).filter((r) => r.M === M);
    return fn;
  }

  // ---------------- Phase A ----------------
  async function phaseA(ctx, ev, P) {
    const onLog = ctx.onLog;
    const Ms = linspace(P.mLo, P.mHi, P.mN), Bi = Math.round(P.bmax / UB.BQ);
    const Gs = []; for (let g = P.gLoI; g <= P.gHiI; g += P.gStep) Gs.push(g);
    const rows = []; for (let j = 0; j < P.nbr; j++) rows.push(Math.round(-Bi + 2 * Bi * j / (P.nbr - 1)));
    onLog('PHASE A  coarse MECO map: ' + Ms.length + ' MECO x ' + rows.length + ' bias rows x ' + Gs.length + ' G = ' + (Ms.length * rows.length * Gs.length) + ' evals max', 'hi');
    const jobs = [];
    for (const M of Ms) for (const b of rows) for (const g of Gs) jobs.push(ev(M, g, b));
    await Promise.all(jobs);
    const table = Ms.map((M) => {
      const recs = ev.byM(M);
      const okRecs = recs.filter((r) => UB.pass(r, P));
      const np = okRecs.length;
      const best = okRecs.reduce((b, r) => (!b || r.pred > b.pred) ? r : b, null);
      const cnt = {}; recs.forEach((r) => { cnt[r.cls] = (cnt[r.cls] || 0) + 1; });
      return { M, np, best, cnt };
    });
    onLog('MECO     pass  bestPred  tEst   at(G,b)            other classes');
    table.forEach((t) => onLog(String(t.M).padEnd(8) + String(t.np).padStart(5) + f1(t.best ? t.best.pred : NaN, 0).padStart(10) + f1(t.best ? t.best.tEst : NaN, 0).padStart(6) + '  ' +
      (t.best ? (gfmt(t.best.Gi) + ',' + bfmt(t.best.bi)) : '--').padEnd(18) + ' ' + Object.keys(t.cnt).filter((k) => k !== 'OK').map((k) => k + ':' + t.cnt[k]).join(' '), t.best ? 'ok' : 'dim'));
    return table;
  }

  // ---------------- Phase B ----------------
  async function jointSearch(ctx, ev, P, seed, cap, tag) {
    const onLog = ctx.onLog;
    const Bi = Math.round(P.bmax / UB.BQ);
    let c = { M: seed.M, Gi: seed.Gi, bi: seed.bi }, best = seed, used = 0;
    let sM = Math.max(P.mq, 2000), rG = 2, sb = Math.round(0.5 / UB.BQ);
    const minSb = Math.round(0.03 / UB.BQ);
    while (used < cap && !abort(ctx)) {
      const pts = [];
      for (const dm of [-1, 0, 1]) for (const dg of [-1, 0, 1]) for (const db of [-1, 0, 1]) {
        if (!dm && !dg && !db) continue;
        const M = Math.round((c.M + dm * sM) / 10) * 10, Gi = c.Gi + dg * rG, bi = c.bi + db * sb;
        if (M < P.mLo || M > P.mHi || Gi < P.gLoI || Gi > P.gHiI || Math.abs(bi) > Bi) continue;
        pts.push({ M, Gi, bi });
      }
      used += pts.length;
      const rs = await Promise.all(pts.map((p) => ev(p.M, p.Gi, p.bi)));
      const nb = UB.maxPred(rs, P);
      if (nb && UB.key(nb, P) < UB.key(best, P) - P.eps) {
        best = nb; c = { M: nb.M, Gi: nb.Gi, bi: nb.bi };
        onLog('  ' + tag + ' M=' + nb.M + ' G=' + gfmt(nb.Gi) + ' b=' + bfmt(nb.bi) + ' pred=' + f1(nb.pred, 0) + ' tEst=' + f1(nb.tEst, 0) + 's tApo=' + f1(nb.tApo, 0) + ' cost=' + UB.key(nb, P).toFixed(3), 'dim');
        continue;
      }
      let shrunk = false;
      if (sM > P.mq) { sM = Math.max(P.mq, Math.round(sM / 2 / 10) * 10); shrunk = true; }
      if (rG > 1) { rG = Math.ceil(rG / 2); shrunk = true; }
      if (sb > minSb) { sb = Math.max(minSb, Math.round(sb / 2)); shrunk = true; }
      if (!shrunk) break;
    }
    return best;
  }

  async function phaseB(ctx, ev, P) {
    const onLog = ctx.onLog;
    const all = Array.from(ev.cache.values()).filter((r) => Number.isFinite(UB.key(r, P)));
    if (!all.length) return null;
    all.sort((a, b) => UB.key(a, P) - UB.key(b, P));
    const seeds = [];
    for (const r of all) {
      if (seeds.length >= 3) break;
      if (seeds.every((q) => Math.abs(q.M - r.M) >= 1000 || Math.abs(q.bi - r.bi) >= 5000)) seeds.push(r);
    }
    onLog('PHASE B  joint search (M,G,bias) -> cost=(1-w)*time+w*fuel, w=' + P.ideal + ', pred>=' + P.predMin + '  seeds: ' +
      seeds.map((r) => r.M + '/' + gfmt(r.Gi) + '/' + bfmt(r.bi) + ' pred ' + f1(r.pred, 0) + ' t ' + f1(r.tEst, 0)).join(' | '), 'hi');
    let champ = null; const bests = [];
    for (let i = 0; i < seeds.length && !abort(ctx); i++) {
      const b = await jointSearch(ctx, ev, P, seeds[i], 130, 's' + (i + 1));
      onLog('  seed ' + (i + 1) + ' -> M=' + b.M + ' G=' + gfmt(b.Gi) + ' b=' + bfmt(b.bi) + ' pred=' + f1(b.pred, 0) + ' floorMargin=' + (Number.isFinite(b.pred) ? '+' + (b.pred - P.predMin).toFixed(0) : '--') + ' tEst=' + f1(b.tEst, 0) + 's' + '  cost=' + UB.key(b, P).toFixed(3), 'ok');
      bests.push(b);
      if (!champ || UB.key(b, P) < UB.key(champ, P)) champ = b;
    }
    bests.sort((a, b) => UB.key(a, P) - UB.key(b, P));
    return champ ? { M: champ.M, best: champ, champs: bests } : null;
  }

  // ---------------- Anchor search (used in force modes) ----------------
  async function findAnchorBias(ctx, ev, P, M, Gi) {
    const tries = [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2, -2.5, 2.5, -3, 3];
    const Bi = Math.round(P.bmax / UB.BQ);
    for (const b of tries) {
      const bi = Math.round(b / UB.BQ);
      if (Math.abs(bi) > Bi) continue;
      const r = await ev(M, Gi, bi);
      if (UB.pass(r, P)) {
        return { M, Gi, bi, pred: r.pred, tEst: r.tEst, dv: r.dv, apoC: r.apoC, anchorHit: b };
      }
    }
    return null;
  }

  // ---------------- Phase C ----------------
  async function phaseC(ctx, ev, P, M, anchor, forceGi) {
    const onLog = ctx.onLog, NW = ctx.NW;
    const evM = (Gi, bi) => ev(M, Gi, bi);
    const k = Math.max(2, Math.ceil(NW / 2));
    const Bi = Math.round(P.bmax / UB.BQ);
    onLog('PHASE C  band trace at MECO=' + M + ' anchor G=' + gfmt(anchor.Gi) + ' b=' + bfmt(anchor.bi) + ' pred=' + f1(anchor.pred, 0) + (forceGi != null ? '  [force G]' : ''), 'hi');
    const rows = {};
    const r0 = await UB.rangeAtG(evM, P, anchor.Gi, anchor.bi, k);
    rows[anchor.Gi] = r0;
    const line = (r) => gfmt(r.Gi) + '  ' + bfmt(r.lo) + ' ' + bfmt(r.hi) + '  w=' + (r.width * UB.BQ).toFixed(3) + (r.clipLo ? ' CLIP-' : '') + (r.clipHi ? ' CLIP+' : '') + (r.nonContig ? ' NONCONTIG' : '');
    onLog(line(r0), 'ok');
    if (forceGi != null) { onLog('(force G — single G row, no trace)', 'dim'); return rows; }
    const span = 12;
    for (const dir of [+1, -1]) {
      let prev = r0, shift = 0, Gi = anchor.Gi;
      for (let n = 0; n < span; n++) {
        if (abort(ctx)) return rows;
        Gi += dir; if (Gi < P.gLoI || Gi > P.gHiI) break;
        const c = Math.round(prev.mid + shift), st = Math.max(Math.round(0.05 / UB.BQ), Math.round(prev.width / 2));
        const cands = [Math.max(-Bi, Math.min(Bi, c))];
        for (let d = st; d <= 2 * Bi; d += st) for (const s of [+1, -1]) { const b = c + s * d; if (b >= -Bi && b <= Bi) cands.push(b); }
        let hit = null;
        for (let i = 0; i < cands.length && !hit; i += NW) {
          const rs = await Promise.all(cands.slice(i, i + NW).map((b) => evM(Gi, b)));
          hit = rs.find((r) => UB.pass(r, P)) || null;
        }
        if (!hit) { onLog('G=' + gfmt(Gi) + ': no pass -> band ends this side', 'dim'); break; }
        const r = await UB.rangeAtG(evM, P, Gi, hit.bi, k);
        rows[Gi] = r; onLog(line(r), 'ok'); shift = r.mid - prev.mid; prev = r;
      }
    }
    return rows;
  }

  // ---------------- Phase D ----------------
  const ORBIT_TOL_FRAC = 0.001;
  async function verifyPoint(ctx, ev, P, M, Gi, bi) {
    const pool = ctx.pool;
    const point = { Gi, Tn: P.Tn, bi, li: P.li, meco: M };
    const ch = await pool.runJob('verifyChain', { point, altKm: P.alt });
    const lr = { ok: !!ch.tuneOk, inBand: ch.inBand, reason: ch.reason, lead: ch.lead, leadTicks: ch.leadTicks, marginS: ch.margin, evals: ch.evals };
    const rec0 = await ev(M, Gi, bi);
    const idealReg = Number.isFinite(rec0.dv) && rec0.dv < P.dvMin;
    const out = { tlog: ch.log || null, idealReg, Gi, bi, M, lead: lr.lead, evals: lr.evals || 0, tuneOk: !!lr.ok, reason: lr.reason, full: false, inBand: !!lr.inBand, margin: lr.marginS, pred: rec0.pred };
    if (!lr.ok || !Number.isFinite(lr.leadTicks)) {
      try {
        const dm = await pool.runEval(Object.assign({}, point, { li: Math.round(5.5 / 0.0125) }), { stopAt: 'CIRC_END', targetAltKm: P.alt, quiet: true });
        out.evals++;
        out.diag = 'end=' + dm.endReason + ' vrMin=' + f1(dm.vrMin, 2) + ' vrEnd=' + f1(dm.vrEnd, 2) + ' margin=' + f1(dm.marginS, 1) + ' fuelOff=' + f1(dm.stageFuelEngOffKg, 0) + ' pred=' + f1(rec0.pred, 0) + ' Δ=' + f1(dm.stageFuelEngOffKg - rec0.pred, 0);
      } catch (e) { out.diag = 'diag error'; }
      return out;
    }
    const m = ch.metrics || {};
    out.tEnd = ch.simEnd; out.payloadCleared = !!m.payloadCleared; out.apo = m.apogeeKm; out.peri = m.perigeeKm; out.vrEnd = ch.vrEnd; out.resid = m.stageResidualKg;
    const tolKm = ORBIT_TOL_FRAC * P.alt;
    out.full = (idealReg || (out.inBand && lr.lead >= 1)) && out.payloadCleared && Math.abs(m.apogeeKm - P.alt) <= tolKm && Math.abs(m.perigeeKm - P.alt) <= tolKm && ch.vrEnd >= 0;
    return out;
  }

  async function phaseD(ctx, ev, P, M, chosen) {
    const onLog = ctx.onLog;
    onLog(''); onLog('PHASE D  verify (checkpoint chain: SA -> CH -> tuneLead -> FULL) on ' + chosen.length + ' rows x ' + P.dpts + ' biases', 'hi');
    const res = [];
    for (const r of chosen) {
      if (abort(ctx)) break;
      const w = r.hi - r.lo;
      const biases = [];
      for (let q = 0; q < P.dpts; q++) biases.push(Math.round(r.lo + w * (0.15 + 0.75 * q / (P.dpts - 1))));
      const rs = await Promise.all(biases.map((bi) => verifyPoint(ctx, ev, P, M, r.Gi, bi)));
      for (const v of rs) {
        ctx.evals.n += v.evals; res.push(v);
        const tag = v.full ? (v.idealReg ? 'VERIFIED-FULL(ideal regime, margin n/a)' : 'VERIFIED-FULL')
          : (v.tuneOk ? (!v.inBand ? 'MARGIN-OUT-OF-BAND' : (v.lead < 1 ? 'LEAD-AT-EDGE' : 'FULL-FAIL')) : 'tuneLead-FAIL');
        onLog('  G=' + gfmt(v.Gi) + ' b=' + bfmt(v.bi) + '  ' + tag + (v.tuneOk ? '  lead=' + v.lead.toFixed(4) + ' margin=' + f1(v.margin, 2) : '  (' + v.reason + ')  @lead5.5: ' + (v.diag || '')) +
          '  pred=' + f1(v.pred, 0) +
          (v.payloadCleared !== undefined ? '  Δ=' + f1(v.resid - v.pred, 0) + '  cleared=' + v.payloadCleared + ' apo=' + f1(v.apo, 2) + ' peri=' + f1(v.peri, 2) + ' vrEnd=' + f1(v.vrEnd, 2) + ' resid=' + f1(v.resid, 0) + ' T=' + f1(v.tEnd, 0) + 's' : ''), v.full ? 'ok' : 'bad');
        if (!v.tuneOk && v.tlog) v.tlog.slice(-14).forEach((l) => onLog('      ' + l, 'dim'));
      }
    }
    return res;
  }

  // ---------------- Report ----------------
  function report(ctx, P, M, anchor, rows) {
    const onLog = ctx.onLog;
    const chosen = UB.pickRows(rows, P.K, anchor.Gi);
    onLog(''); onLog('=============== BOOTSTRAP RESULT  alt=' + P.alt + ' km ===============', 'hi');
    onLog('MECO = ' + M + '   (pred ' + f1(anchor.pred, 0) + ' kg, tEst ' + f1(anchor.tEst, 0) + ' s at G=' + gfmt(anchor.Gi) + ' bias=' + bfmt(anchor.bi) + ')', 'ok');
    onLog('candidates below are COAST-FEASIBLE ONLY (ideal-Tsiolkovsky filter). Phase D verifies them with tuneLead+FULL.', 'dim');
    for (const r of chosen) {
      const w = r.width, tr = Math.round(w * P.trim);
      const lo = r.lo + tr, hi = r.hi - tr;
      const rawW = (r.width * UB.BQ).toFixed(3);
      const step = Math.max(0.01, Math.round(((hi - lo) * UB.BQ / 10) * 100) / 100);
      onLog('G=' + gfmt(r.Gi) + '  window [' + bfmt(r.lo) + ', ' + bfmt(r.hi) + '] w=' + rawW + (r.clipLo ? ' CLIP-' : '') + (r.clipHi ? ' CLIP+' : ''));
      onLog('   score-scan inputs ->  G ' + (r.Gi / 100).toFixed(2) + '   MECO ' + M + '   alt ' + P.alt + '   bias lo ' + (lo * UB.BQ).toFixed(3) + '   hi ' + (hi * UB.BQ).toFixed(3) + '   step ' + step.toFixed(2), 'dim');
    }
    return chosen;
  }

  // ---------------- Main entry ----------------
  async function runBootstrap(opts) {
    const ctx = {
      pool: opts.pool,
      NW: opts.pool.n,
      P: opts.params,
      onLog: opts.onLog || function () {},
      onStatus: opts.onStatus || function () {},
      abortRef: opts.abortRef || { aborted: false },
      evals: { n: 0 },
    };
    const P = ctx.P;
    const t0 = nowMs();
    const ev = makeEv(ctx);
    const out = { ok: false, status: '', champs: [], good: [], table: null, rows: {}, chosen: [], evals: 0, wallMs: 0, error: null };
    try {
      ctx.onLog('--- universal bootstrap  alt=' + P.alt + '  T=' + (P.Tn * 0.000125) + '  K=' + P.K + '  pred [' + P.predMin + ',' + P.predMax + ']  ideal=' + P.ideal + '  bias rows=' + P.nbr +
        (opts.forceMeco != null ? '  FORCE MECO=' + opts.forceMeco : '') +
        (opts.forceGi != null ? '  FORCE G=' + gfmt(opts.forceGi) : '') + ' ---', 'dim');
      let bk = null;
      if (opts.forceMeco != null) {
        // Force mode: skip Phase A/B. Need an anchor (passing G, bias) at fixed M.
        const Gi = opts.forceGi != null ? opts.forceGi : Math.round((P.gLoI + P.gHiI) / 2);
        ctx.onStatus('force: anchor search at M=' + opts.forceMeco + ' G=' + gfmt(Gi) + '...');
        ctx.onLog('Phase A/B skipped (force MECO=' + opts.forceMeco + ') — finding anchor bias at G=' + gfmt(Gi), 'warn');
        const anchor = await findAnchorBias(ctx, ev, P, opts.forceMeco, Gi);
        if (!anchor) {
          out.status = 'no feasible bias at force (M, G)';
          ctx.onLog('No feasible bias found at M=' + opts.forceMeco + ' G=' + gfmt(Gi) + ' (tried bias ∈ [-3, +3])', 'bad');
          out.evals = ctx.evals.n; out.wallMs = nowMs() - t0;
          return out;
        }
        ctx.onLog('anchor found: bias=' + bfmt(anchor.bi) + ' pred=' + f1(anchor.pred, 0) + ' tEst=' + f1(anchor.tEst, 0) + 's', 'ok');
        bk = { M: opts.forceMeco, best: anchor, champs: [anchor] };
      } else {
        ctx.onStatus('phase A...');
        const table = await phaseA(ctx, ev, P);
        out.table = table;
        ctx.onLog('SA share: build=' + ctx.pool.saStats.build + ' reuse=' + ctx.pool.saStats.hit + ' preSAfail=' + ctx.pool.saStats.failHit + ' stored=' + ctx.pool.snaps.size + ' evicted=' + ctx.pool.snaps.evicted, 'dim');
        const nrm = UB.setNorm(Array.from(ev.cache.values()), P);
        if (nrm) ctx.onLog('norm: tEst ' + nrm.tLo.toFixed(0) + '..' + (nrm.tLo + nrm.tSpan).toFixed(0) + ' s,  MECO ' + nrm.mLo + '..' + (nrm.mLo + nrm.mSpan) + '  ideal=' + P.ideal, 'dim');
        ctx.onStatus('phase B...');
        bk = await phaseB(ctx, ev, P);
        if (!bk || !bk.best) {
          out.status = 'no feasible point at any MECO';
          ctx.onLog('NO feasible point at any MECO tried. Widen MECO range / G range, or lower pred min.', 'bad');
          out.evals = ctx.evals.n; out.wallMs = nowMs() - t0;
          return out;
        }
      }
      out.champs = bk.champs;
      let good = [], tried = 0;
      for (const ch of bk.champs) {
        if (abort(ctx) || good.length) break;
        tried++;
        if (tried > 1) { ctx.onLog(''); ctx.onLog('>>> fallback: champion #' + tried + '  M=' + ch.M + ' G=' + gfmt(ch.Gi) + ' b=' + bfmt(ch.bi) + ' pred=' + f1(ch.pred, 0) + ' tEst=' + f1(ch.tEst, 0), 'hi'); }
        ctx.onStatus('phase C (champ ' + tried + ')...');
        const rows = await phaseC(ctx, ev, P, ch.M, ch, opts.forceGi);
        out.rows[ch.M] = rows;
        const chosen = report(ctx, P, ch.M, ch, rows);
        out.chosen = chosen;
        ctx.onStatus('phase D (champ ' + tried + ')...');
        const ver = await phaseD(ctx, ev, P, ch.M, chosen);
        good = ver.filter((v) => v.full);
        ctx.onLog(''); ctx.onLog('=============== VERIFIED-FULL: ' + good.length + ' / ' + ver.length + '  (champion ' + tried + '/' + bk.champs.length + ') ===============', good.length ? 'hi' : 'bad');
        good.sort((a, b) => a.tEnd - b.tEnd);
        for (const v of good) ctx.onLog('G=' + gfmt(v.Gi) + '  MECO=' + v.M + '  bias=' + bfmt(v.bi) + '  lead=' + v.lead.toFixed(4) + '  T=' + f1(v.tEnd, 0) + 's  resid=' + f1(v.resid, 0) + (v.resid >= 100 && v.resid <= 200 ? '  [in 100-200 band]' : '  [outside band]'), 'ok');
      }
      out.good = good;
      out.ok = good.length > 0;
      out.status = out.ok ? 'ok' : 'no FULL-verified point from any champion';
      if (!good.length) ctx.onLog('No FULL-verified point from any Phase B champion. Run circ-diag on the top champion (check endReason / fuelOff) before changing anything else.', 'bad');
    } catch (e) {
      out.status = 'error: ' + ((e && e.message) || e);
      out.error = out.status;
      ctx.onLog('ERROR: ' + ((e && e.message) || e), 'bad');
    }
    out.evals = ctx.evals.n;
    out.wallMs = nowMs() - t0;
    ctx.onLog('total evals: ' + out.evals + '   wall ' + (out.wallMs / 1000).toFixed(0) + 's');
    return out;
  }

  // ---------------- Single point (debug) ----------------
  async function verifyPointSingle(opts) {
    const ctx = {
      pool: opts.pool,
      NW: opts.pool.n,
      P: opts.params,
      onLog: opts.onLog || function () {},
      onStatus: opts.onStatus || function () {},
      abortRef: opts.abortRef || { aborted: false },
      evals: { n: 0 },
    };
    const P = ctx.P;
    const ev = makeEv(ctx);
    const t0 = nowMs();
    P.alt = opts.alt;
    ctx.onLog('');
    ctx.onLog('=== DEBUG single  alt=' + opts.alt + '  G=' + (opts.Gi / 100) + '  MECO=' + opts.M + '  bias=' + (opts.bi * 0.0001) + ' ===', 'hi');
    ctx.onLog('lattice: ' + JSON.stringify({ Gi: opts.Gi, Tn: P.Tn, bi: opts.bi, li: P.li, meco: opts.M }), 'dim');
    const v = await verifyPoint(ctx, ev, P, opts.M, opts.Gi, opts.bi);
    const ms = nowMs() - t0;
    ctx.onLog('');
    const tag = v.full ? (v.idealReg ? 'VERIFIED-FULL(ideal regime)' : 'VERIFIED-FULL')
      : (v.tuneOk ? (!v.inBand ? 'MARGIN-OUT-OF-BAND' : (v.lead < 1 ? 'LEAD-AT-EDGE' : 'FULL-FAIL')) : 'tuneLead-FAIL');
    ctx.onLog('RESULT: ' + tag + '  wall=' + (ms / 1000).toFixed(1) + 's', v.full ? 'ok' : 'bad');
    ctx.onLog('  tuneOk=' + v.tuneOk + ' inBand=' + v.inBand + ' lead=' + f1(v.lead, 4) + ' leadTicks=' + v.leadTicks + ' margin=' + f1(v.margin, 3) + ' evals=' + v.evals + ' reason=' + (v.reason || '-'), 'dim');
    ctx.onLog('  pred=' + f1(v.pred, 0), 'dim');
    if (v.payloadCleared !== undefined) ctx.onLog('  cleared=' + v.payloadCleared + ' apo=' + f1(v.apo, 3) + ' peri=' + f1(v.peri, 3) + ' vrEnd=' + f1(v.vrEnd, 4) + ' resid=' + f1(v.resid, 0) + ' Δ=' + f1(v.resid - v.pred, 0) + ' T=' + f1(v.tEnd, 1) + 's', 'dim');
    if (v.diag) ctx.onLog('  @lead5.5 diag: ' + v.diag, 'dim');
    if (v.tlog && v.tlog.length) {
      ctx.onLog('  --- tuneLead log (' + v.tlog.length + ' lines) ---', 'dim');
      v.tlog.forEach((l) => ctx.onLog('  ' + l, 'dim'));
    }
    return v;
  }

  Object.assign(T, { UB, linspace, classify, makeEv, phaseA, phaseB, phaseC, phaseD, verifyPoint, runBootstrap, verifyPointSingle, gfmt, bfmt, f1 });
})();
