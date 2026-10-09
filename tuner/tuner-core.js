// ============================================================================
// tuner-core.js — search algorithms. Step 5: tuneLead (INNER-2).
//
// tuneLead(point, opts) -> Promise<result>
//   Finds the circ trigger lead (integer ticks, 0.0125 s) for a fixed
//   (G, T, bias, MECO) so that the circ burn ends with margin (time to apogee
//   at engines-off) inside the target band [4, 5] s, while
//     vrEnd (engines-off) >= buffer low (0.02 m/s, never exactly 0)
//     vrMin >= hard floor (-2 m/s)
//   Each eval = runEval(point, {stopAt:'CIRC_END'}) (truncated sim).
//
// SIGNED margin(lead) (hook: marginS < 0 = burn ended past apogee) is monotone and
// steep near the apogee transition (~1.4 s per tick measured on the baseline), so the search is a bracketed secant/bisection on the integer tick
// lattice, followed by (a) a feasibility walk if the band point violates vr
// constraints, (b) a short descent to the lowest margin that is still in band.
//
// Selection key (lower is better): [distance to band, margin]. So an in-band
// feasible point always beats an out-of-band one, and inside the band the
// smaller margin wins (heuristic: "minimize margin without breaking vr").
// `phase` = 1 if the chosen point has vrMin >= 0 (no negative vr at all),
// else 2 (negative vr tolerated, recovery expected).
//
// Pure async, no globals mutated except through TunerHook (singleton sim).
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;

  async function tuneLead(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, U = root.TunerUtils, H = opts.hook || root.TunerHook;
    const L = Cfg.limits, q = Cfg.quanta.lead;
    const band = opts.marginBand || L.marginTargetS;          // [4, 5]
    const mLo = band[0], mHi = band[1], mTgt = (mLo + mHi) / 2;
    const bufLo = (opts.vrEndBuffer || L.vrEndBufferMps)[0];   // 0.02
    const vrFloor = opts.vrMinFloor != null ? opts.vrMinFloor : L.vrMinHardFloorMps;
    const slope = opts.slopeSPerS || 28;                       // s of margin per s of lead (empirical)
    const maxEvals = opts.maxEvals || 30;
    const firstCap = opts.firstStepCapTicks || 3;              // only 1 sample known: do not leap over the transition
    const cache = opts.cache || new U.EvalCache();
    const targetAltKm = opts.targetAltKm != null ? opts.targetAltKm : Cfg.fixed.targetAltKm;
    const leadOf = (li) => Number((li * q).toFixed(4));
    const t0 = performance.now();

    const pts = new Map();           // li -> record
    const lines = [];
    let evals = 0, hitsBefore = cache.hits;
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

    class Stop extends Error {}

    async function ev(li) {
      if (li < 0) li = 0;
      if (pts.has(li)) return pts.get(li);
      if (opts.abortRef && opts.abortRef.aborted) throw new Stop('aborted');
      const p = Object.assign({}, point, { li });
      let m = cache.get(p, 'CIRC_END');
      let fresh = false;
      if (!m) {
        if (evals >= maxEvals) throw new Stop('maxEvals');
        m = await H.runEval(p, { stopAt: 'CIRC_END', targetAltKm, env: opts.env,
                                 abortRef: opts.abortRef, onProgress: opts.onProgress });
        cache.set(p, 'CIRC_END', m);
        evals++; fresh = true;
      }
      const valid = m.endReason === 'CIRC_END' && !m.crashed && Number.isFinite(m.vrEnd) && Number.isFinite(m.marginS);
      const r = {
        li, lead: leadOf(li), m, valid,
        margin: valid ? m.marginS : -Infinity,    // no clean circ end => treat as "too low"
        vrEnd: m.vrEnd, vrMin: m.vrMin,
        feas: valid && m.vrMin >= vrFloor && m.vrEnd >= bufLo,
        inBand: valid && m.marginS >= mLo && m.marginS <= mHi,
      };
      pts.set(li, r);
      say((fresh ? '  eval ' : '  (cached) ') + 'lead=' + r.lead + ' (' + li + ' ticks)  end=' + m.endReason +
          '  margin=' + fmt(m.marginS, 2) + 's  vrEnd=' + fmt(m.vrEnd, 4) + '  vrMin=' + fmt(m.vrMin, 3) +
          (r.feas ? '  feasible' : '  INFEASIBLE') + (r.inBand ? '  [in band]' : ''));
      return r;
    }

    // Local slope (s of signed margin per tick) from the two valid points nearest to
    // the target; falls back to the slope guess. Near the apogee transition the real
    // slope is much steeper than the guess, so measured data takes over from point 2.
    function slopeTick() {
      const v = [...pts.values()].filter((r) => Number.isFinite(r.margin))
        .sort((a, b) => Math.abs(a.margin - mTgt) - Math.abs(b.margin - mTgt));
      if (v.length >= 2 && v[0].li !== v[1].li) {
        const s = (v[0].margin - v[1].margin) / (v[0].li - v[1].li);
        if (s > 0.01) return s;
      }
      return slope * q;
    }

    const dist = (r) => (r.margin < mLo ? mLo - r.margin : (r.margin > mHi ? r.margin - mHi : 0));
    function bestFeasible() {
      let best = null;
      for (const r of pts.values()) {
        if (!r.feas) continue;
        if (!best || dist(r) < dist(best) - 1e-12 ||
            (Math.abs(dist(r) - dist(best)) <= 1e-12 && r.margin < best.margin)) best = r;
      }
      return best;
    }

    let reason = 'ok';
    try {
      say('tuneLead: start lead=' + leadOf(point.li) + ' (' + point.li + ' ticks)  band=[' + mLo + ',' + mHi +
          ']s  vrEnd>=' + bufLo + '  vrMin>=' + vrFloor + '  slope guess ' + slope + ' s/s');

      // ---- 1) root-find margin(li) = mTgt, bracketed on the tick lattice ----
      let lo = null, hi = null;                       // lo: margin < target, hi: margin >= target
      const note = (r) => {
        if (r.margin < mTgt) { if (!lo || r.li > lo.li) lo = r; }
        else { if (!hi || r.li < hi.li) hi = r; }
      };
      let r0 = await ev(point.li);
      note(r0);
      for (let it = 0; it < 14; it++) {
        if (r0.inBand && r0.feas) break;
        const hit = [...pts.values()].find((r) => r.inBand);
        if (hit) break;                               // band reached (feasibility handled below)
        if (lo && hi && hi.li - lo.li <= 1) break;    // bracket closed, no tick inside band
        let next;
        if (lo && hi) {
          if (Number.isFinite(lo.margin) && Number.isFinite(hi.margin) && hi.margin > lo.margin) {
            const f = (mTgt - lo.margin) / (hi.margin - lo.margin);
            next = lo.li + Math.round(f * (hi.li - lo.li));
          } else next = Math.floor((lo.li + hi.li) / 2);
          next = Math.min(hi.li - 1, Math.max(lo.li + 1, next));
        } else if (hi) {                              // margin too high -> lead down
          const d = Math.ceil((hi.margin - mTgt) / slopeTick());
          next = hi.li - Math.min(pts.size < 2 ? firstCap : 60, Math.max(1, d));
        } else {                                      // margin too low (or past apogee) -> lead up
          const d = Number.isFinite(lo.margin) ? Math.ceil((mTgt - lo.margin) / slopeTick()) : 8;
          next = lo.li + Math.min(pts.size < 2 ? firstCap : 60, Math.max(1, d));
        }
        if (next < 0) next = 0;
        if (pts.has(next)) break;                     // no new information
        note(await ev(next));
      }

      // ---- 2) feasibility: find the smallest feasible lead (vr constraints) ----
      // Used when no feasible point sits inside the band yet. Assumes feasibility is
      // monotone in lead (higher lead = gentler = more vrEnd).
      const bisect = async (a, b) => {                // a infeasible, b feasible
        while (b - a > 1) {
          const mid = Math.floor((a + b) / 2);
          const r = await ev(mid);
          if (r.feas) b = mid; else a = mid;
        }
      };
      let best = bestFeasible();
      if (!best || !best.inBand) {
        let F = null;                                 // feasible point with the smallest lead
        for (const r of pts.values()) if (r.feas && (!F || r.li < F.li)) F = r;
        if (!F) {
          const bad = [...pts.values()].sort((x, y) => Math.abs(x.margin - mTgt) - Math.abs(y.margin - mTgt))[0];
          say('no feasible point yet -> walking lead up from ' + bad.li);
          let step = 1, badLi = bad.li;
          while (step <= 32 && !F) {
            const r = await ev(badLi + step);
            if (r.feas) F = r; else { badLi = r.li; step *= 2; }
          }
          if (F) await bisect(badLi, F.li);
          else reason = 'no feasible lead found (vr constraints)';
        } else {
          let I = null;                               // infeasible point just below F
          for (const r of pts.values()) if (!r.feas && r.li < F.li && (!I || r.li > I.li)) I = r;
          if (I) { say('vr constraint binds -> bisect ' + I.li + '..' + F.li); await bisect(I.li, F.li); }
        }
        best = bestFeasible();
      }

      // ---- 3) descend to the lowest margin that is still inside the band ----
      if (best && best.inBand) {
        for (let k = 0; k < 6; k++) {
          const r = await ev(best.li - 1);
          if (r.feas && r.margin >= mLo && r.margin < best.margin) best = r; else break;
        }
      }
      best = bestFeasible();
      if (best && !best.inBand && reason === 'ok') reason = 'feasible but margin outside band';
      if (!best && reason === 'ok') reason = 'no feasible lead found';

      const out = finish(best, reason);
      return out;
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      const best = bestFeasible();
      return finish(best, 'stopped: ' + e.message);
    }

    function finish(best, why) {
      const res = {
        ok: !!best, inBand: !!(best && best.inBand), reason: why,
        lead: best ? best.lead : NaN, leadTicks: best ? best.li : NaN,
        marginS: best ? best.margin : NaN, vrEnd: best ? best.vrEnd : NaN, vrMin: best ? best.vrMin : NaN,
        phase: best ? (best.vrMin >= 0 ? 1 : 2) : null,
        point: best ? Object.assign({}, point, { li: best.li }) : null,
        metrics: best ? best.m : null,
        evals, cacheHits: cache.hits - hitsBefore, wallMs: performance.now() - t0,
        log: lines,
      };
      say('tuneLead: ' + (res.ok ? 'lead=' + res.lead + ' (' + res.leadTicks + ' ticks) margin=' + fmt(res.marginS, 2) +
          's vrEnd=' + fmt(res.vrEnd, 4) + ' vrMin=' + fmt(res.vrMin, 3) + ' phase ' + res.phase + (res.inBand ? '' : ' [OUT OF BAND]')
          : 'FAILED') + '  | ' + why + ' | evals=' + evals + ' wall=' + (res.wallMs / 1000).toFixed(1) + 's');
      return res;
    }
  }

  // ==========================================================================
  // Step 6 — tuneAB (INNER-1): (G, T, bias) joint search, MECO + lead start fixed.
  //
  // Signal eval = runEval(p, {stopAt:'COAST_WAIT_ENTRY'}) -> eCoast, apoCoastKm,
  // stageVrNeg. Classes (ceiling = eMax - eSafetyMargin):
  //   F1 : stage-burn vr < 0 (or crash)        -> too aggressive -> go GENTLE  (bias up / G up / T up)
  //   F2 : apo at coast < target - tol, or run never reached COAST_WAIT -> go AGGRESSIVE
  //   FE : E > ceiling                          -> go GENTLE (push-down step B: "E cross -> back off";
  //        ref data: higher bias => lower E). Direction is double-checked empirically in findOk.
  //   OK : none of the above
  // Flow: startOk (Fail3 relax) -> push G down -> push T down -> bias climb (E toward ceiling)
  //       -> candidates -> tuneLead + FULL eval + score -> E_max learning (<= maxRelearn rounds).
  // ==========================================================================
  async function tuneAB(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, U = root.TunerUtils, H = opts.hook || root.TunerHook;
    const Q = Cfg.quanta, L = Cfg.limits;
    const mode = Object.assign({}, Cfg.modes[opts.mode || 'fine'] || Cfg.modes.fine, opts.modeOverride || {});
    const targetAltKm = opts.targetAltKm != null ? opts.targetAltKm : Cfg.fixed.targetAltKm;
    const cache = opts.cache || new U.EvalCache();
    const maxAB = opts.maxEvalsAB || 160;
    const apoTol = L.coastApoTolKm != null ? L.coastApoTolKm : 1;
    const eSafe = L.eSafetyMargin != null ? L.eSafetyMargin : 0.0005;
    const maxRelearn = opts.maxRelearn != null ? opts.maxRelearn : 2;
    const biasLo = Math.round(Cfg.bounds.bias.lower / Q.bias), biasHi = Math.round(Cfg.bounds.bias.upper / Q.bias);
    const t0 = performance.now();
    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
    class Stop extends Error {}

    // bias ladder in bias-quanta (0.5, 0.1, 0.05, 0.01, 0.001, 0.0001 deg) down to the mode floor
    const floorBi = Math.max(1, Math.round((opts.biasFloor != null ? opts.biasFloor : mode.biasStep) / Q.bias));
    const ladder = [5000, 1000, 500, 100, 10, 1].filter((s) => s >= floorBi);
    if (!ladder.length || ladder[ladder.length - 1] !== floorBi) ladder.push(floorBi);
    // T ladder in Tn quanta: 160 (0.02 s) halving down to the mode step
    const tLadder = []; for (let s = 160; s > mode.tStep; s = Math.floor(s / 2)) tLadder.push(s); tLadder.push(mode.tStep);

    let eMax = opts.eMax != null ? opts.eMax : (Cfg.ecc.eMax != null ? Cfg.ecc.eMax : Cfg.ecc.eMaxGuess);
    let ceil = eMax - eSafe;
    let abEvals = 0, leadEvals = 0, fullEvals = 0;
    const hits0 = cache.hits;

    const dirOf = (cls) => (cls === 'F2' ? -1 : 1);       // +1 = gentler
    function classify(m) {
      if (m.endReason === 'STAGE_VR_NEG' || m.stageVrNeg || m.endReason === 'CRASHED') return 'F1';
      if (m.endReason !== 'COAST_WAIT_ENTRY' || !Number.isFinite(m.eCoast)) return 'F2';
      if (!(m.apoCoastKm >= targetAltKm - apoTol)) return 'F2';
      if (m.eCoast > ceil) return 'FE';
      return 'OK';
    }
    const dsc = (p) => 'G=' + U.gOf(p.Gi) + ' T=' + U.tOf(p.Tn) + ' A=' + U.aEff(p).toFixed(4) + ' bias=' + U.biasOf(p.bi);

    async function evAB(p) {
      if (!U.inBounds(p)) return { p, cls: 'OOB', E: NaN, m: null };
      if (opts.abortRef && opts.abortRef.aborted) throw new Stop('aborted');
      let m = cache.get(p, 'COAST_WAIT_ENTRY'), fresh = false;
      if (!m) {
        if (abEvals >= maxAB) throw new Stop('maxEvalsAB');
        m = await H.runEval(p, { stopAt: 'COAST_WAIT_ENTRY', targetAltKm, env: opts.env,
                                 abortRef: opts.abortRef, onProgress: opts.onProgress });
        cache.set(p, 'COAST_WAIT_ENTRY', m); abEvals++; fresh = true;
      }
      const r = { p, cls: classify(m), E: m.eCoast, m };
      if (fresh) say('  AB#' + abEvals + ' ' + dsc(p) + '  ' + r.cls + '  E=' + fmt(m.eCoast, 5) +
                     '  apo=' + fmt(m.apoCoastKm, 2) + '  stageVrMin=' + fmt(m.vrMinStageBurn, 2) + '  end=' + m.endReason);
      return r;
    }

    // Find an OK point near p0 by scanning bias in the direction the class asks for.
    // Opposite class after a step => bracket => bisect. null = band closed / bias extreme.
    async function findOk(p0, stepBi, K) {
      const r0 = await evAB(p0);
      if (r0.cls === 'OK') return r0;
      if (r0.cls === 'OOB') return null;
      let dir = dirOf(r0.cls), prev = r0, flipped = false, k = 1, atBound = false;
      while (k <= K) {
        let bi = p0.bi + dir * stepBi * k;
        bi = Math.max(biasLo, Math.min(biasHi, bi));
        if (bi === prev.p.bi) { if (atBound) return null; atBound = true; k++; continue; }
        const r = await evAB(Object.assign({}, p0, { bi }));
        if (r.cls === 'OK') return r;
        if (r.cls === 'OOB') return null;
        if (r.cls === 'FE' && prev.cls === 'FE' && r.E > prev.E + 1e-9 && !flipped) {
          flipped = true; dir = -dir; k = 1; prev = r0; say('  (E rises along this bias direction -> flipping)'); continue;
        }
        if (dirOf(r.cls) === -dir && dirOf(prev.cls) === dir) {
          // crossing: prev wants `dir`, r wants -dir  -> OK window lies between them
          let a = prev.p.bi, b = r.p.bi, ca = prev.cls;
          while (Math.abs(b - a) > floorBi) {
            const mid = Math.round((a + b) / 2);
            if (mid === a || mid === b) break;
            const rm = await evAB(Object.assign({}, p0, { bi: mid }));
            if (rm.cls === 'OK') return rm;
            if (dirOf(rm.cls) === dirOf(ca)) a = mid; else b = mid;
          }
          return null;
        }
        prev = r; k++;
      }
      return null;
    }

    // Fail3: start point, relax A (G up) and reset bias until some bias works.
    async function startOk(p) {
      const relaxStep = Math.max(2, mode.gStep), R = 6;
      for (let n = 0; n <= R; n++) {
        const p1 = U.step(p, { dGi: n * relaxStep });
        const r = await findOk(p1, ladder[0], 10);
        if (r) { if (n) say('startOk: A relaxed by ' + n * relaxStep + ' gimbal quanta'); return r; }
        say('startOk: no OK bias at ' + dsc(p1) + ' -> relax A');
      }
      return null;
    }

    // Push A down on one axis; every trial may be rescued by a local bias shift.
    // Rescued trials teach a bias-per-step slope (A and bias trade off along an E isoline),
    // so the next trial starts at the predicted bias (1 eval instead of a scan). A rescue that
    // lands within 0.1 deg of the bias bound is the Fail3 "extreme bias" zone -> not accepted.
    async function push(r, axis, steps, rescueStep, rescueK, maxIt) {
      let best = r, slope = 0;                    // bias quanta per step unit
      const extreme = 1000;
      for (const st of steps) {
        for (let it = 0; it < maxIt; it++) {
          let trial = axis === 'G' ? U.step(best.p, { dGi: -st }) : U.step(best.p, { dTn: -st });
          if (slope) trial.bi = Math.max(biasLo, Math.min(biasHi, best.p.bi + Math.round(slope * st)));
          const q = U.inBounds(trial) ? await findOk(trial, rescueStep, rescueK) : null;
          if (!q || q.p.bi > biasHi - extreme || q.p.bi < biasLo + extreme) {
            say('push ' + axis + ' step ' + st + ': stop at ' + dsc(best.p) + ' E=' + fmt(best.E, 5) +
                (q ? '  (next needs extreme bias ' + U.biasOf(q.p.bi) + ')' : '')); break;
          }
          if (q.p.bi !== best.p.bi) slope = (q.p.bi - best.p.bi) / st;
          best = q;
        }
      }
      return best;
    }

    // Bias hill-climb on E (toward the ceiling, never above), both directions per level.
    async function climbE(r) {
      let cur = r, lastDir = 1;
      for (const s of ladder) {
        for (let moves = 0; moves < 8; moves++) {
          let improved = false;
          for (const d of [lastDir, -lastDir]) {
            const q = await evAB(U.step(cur.p, { dbi: d * s }));
            if (q.cls === 'OK' && q.E > cur.E + 1e-9) { cur = q; lastDir = d; improved = true; break; }
          }
          if (!improved) break;
        }
      }
      return cur;
    }

    const all = [];            // every verified candidate (all rounds)
    let eOk = -Infinity, eBad = Infinity, leadHint = point.li, round = 0, startP = point, status = 'ok';

    async function verify(rc, tag) {
      const p = Object.assign({}, rc.p, { li: leadHint });
      say('verify [' + tag + '] ' + dsc(p) + ' E=' + fmt(rc.E, 5));
      const lr = await tuneLead(p, { hook: H, cache, abortRef: opts.abortRef, env: opts.env, targetAltKm,
        onProgress: opts.onProgress, onLog: opts.verbose ? (s) => say('    ' + s) : null });
      leadEvals += lr.evals;
      const rec = { tag, round, point: rc.p, desc: U.describe(rc.p), E: rc.E, apoCoastKm: rc.m.apoCoastKm,
        lead: { ok: lr.ok, inBand: lr.inBand, reason: lr.reason, lead: lr.lead, leadTicks: lr.leadTicks,
                marginS: lr.marginS, vrEnd: lr.vrEnd, vrMin: lr.vrMin, phase: lr.phase },
        metrics: null, score: Cfg.scoring.failPenalty * 2, ok: false, reasons: [], parts: null, fullPoint: null };
      if (!lr.ok) { rec.reasons = ['lead_failed: ' + lr.reason]; say('  -> lead FAILED: ' + lr.reason); return rec; }
      leadHint = lr.leadTicks;
      let fm = cache.get(lr.point, 'FULL');
      if (!fm) { fm = await H.runEval(lr.point, { stopAt: 'FULL', targetAltKm, env: opts.env, abortRef: opts.abortRef,
                                                  onProgress: opts.onProgress }); cache.set(lr.point, 'FULL', fm); fullEvals++; }
      const sc = U.score(fm, { targetAltKm });
      Object.assign(rec, { metrics: fm, score: sc.score, ok: sc.ok, reasons: sc.reasons, parts: sc.parts, fullPoint: lr.point,
                           desc: U.describe(lr.point) });
      say('  -> lead ' + lr.lead + ' (' + lr.leadTicks + ' t) margin=' + fmt(lr.marginS, 2) + ' vrEnd=' + fmt(lr.vrEnd, 4) +
          '  FULL score=' + sc.score.toFixed(3) + (sc.ok ? '' : ' HARD-FAIL ' + sc.reasons.join(',')) +
          '  deploy=' + fmt(fm.deployTimeS, 2) + ' apo/peri=' + fmt(fm.apogeeKm, 3) + '/' + fmt(fm.perigeeKm, 3));
      return rec;
    }

    try {
      say('tuneAB[' + (opts.mode || 'fine') + ']: start ' + dsc(point) + ' lead=' + point.li + 't  eMax=' + eMax +
          ' (ceil ' + ceil.toFixed(4) + ')  biasLadder=' + ladder.join('/') + ' Tladder=' + tLadder.join('/'));
      for (round = 0; round <= maxRelearn; round++) {
        ceil = eMax - eSafe;
        say('--- round ' + round + '  eMax=' + fmt(eMax, 4) + ' ceil=' + fmt(ceil, 4) + ' ---');
        let r = await startOk(startP);
        if (!r) { status = 'no OK (A,bias) found (Fail3 exhausted)'; break; }
        say('startOk: ' + dsc(r.p) + ' E=' + fmt(r.E, 5));
        r = await push(r, 'G', [mode.gStep], 1000, 6, 40);     // G rescue: bias +-0.1 steps
        const afterG = r;
        r = await push(r, 'T', tLadder, 200, 4, 8);            // T rescue: bias +-0.02 steps
        const preClimb = r;
        r = await climbE(r);
        say('AB result: ' + dsc(r.p) + ' E=' + fmt(r.E, 5) + '  (AB evals so far ' + abEvals + ')');

        // candidates: climbed min-A, pre-climb, back-off one G step
        const cands = [{ rc: r, tag: 'minA-climbed' }];
        if (mode.candidates > 1 && U.key(preClimb.p) !== U.key(r.p)) cands.push({ rc: preClimb, tag: 'minA-preclimb' });
        if (mode.candidates > 2) {
          const bo = await findOk(U.step(afterG.p, { dGi: mode.gStep }), 1000, 6);
          if (bo && !cands.some((c) => U.key(c.rc.p) === U.key(bo.p))) cands.push({ rc: bo, tag: 'backoff-G' });
        }
        const recs = [];
        for (const c of cands.slice(0, Math.max(1, mode.candidates))) recs.push(await verify(c.rc, c.tag));
        recs.forEach((x) => all.push(x));
        recs.filter((x) => x.ok).forEach((x) => { eOk = Math.max(eOk, x.E); });

        const top = recs[0];
        if (top.ok || round === maxRelearn) { if (!top.ok) status = 'top candidate failed; E_max relearn exhausted'; break; }
        // E_max learning: the E edge we pushed to is not tolerated downstream
        eBad = Math.min(eBad, top.E);
        eMax = (Number.isFinite(eOk) && eOk < eBad) ? (eOk + eBad) / 2 : eBad - (Cfg.ecc.eDropOnFail || 0.01);
        say('E_max learning: E=' + fmt(top.E, 5) + ' failed (' + top.reasons.join(',') + ') -> eMax := ' + fmt(eMax, 4) +
            '  (eOk=' + fmt(eOk, 5) + ' eBad=' + fmt(eBad, 5) + ')');
        const okRec = recs.find((x) => x.ok);
        startP = okRec ? okRec.point : top.point;
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      status = 'stopped: ' + e.message;
    }

    all.sort((a, b) => a.score - b.score);
    const best = all.find((x) => x.ok) || null;
    const evalsTotal = abEvals + leadEvals + fullEvals;
    const res = {
      ok: !!best, status, best, candidates: all,
      eMax: { eMax, ceil, eOk: Number.isFinite(eOk) ? eOk : null, eBad: Number.isFinite(eBad) ? eBad : null, rounds: round },
      evals: evalsTotal, evalBreakdown: { ab: abEvals, lead: leadEvals, full: fullEvals }, cacheHits: cache.hits - hits0,
      wallMs: performance.now() - t0, log: lines,
    };
    say('tuneAB: ' + (best ? 'best[' + best.tag + '] score=' + best.score.toFixed(3) + ' ' + JSON.stringify(best.desc) : 'FAILED') +
        '  | ' + status + ' | evals=' + evalsTotal + ' (ab ' + abEvals + ' lead ' + leadEvals + ' full ' + fullEvals + ') wall=' +
        (res.wallMs / 1000).toFixed(1) + 's');
    return res;
  }

  root.TunerCore = { tuneLead, tuneAB };
})();
