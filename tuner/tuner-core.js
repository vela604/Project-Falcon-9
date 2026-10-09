// ============================================================================
// tuner-core.js — search algorithms. Step 5: tuneLead (INNER-2). Step 6: tuneAB. Step 7: tuneRough + findOptimalMeco (Phase A).
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

    // Direction along BIAS that fixes each failure class (+1 = bias up, -1 = bias down).
    // Verified on the real tuneAB log: along bias E(bias) is a V (E = |signed ecc|, min ~0), and
    //   F1 (stage vr<0)  sits on the LOW-bias side  -> bias UP
    //   FE (E > ceil)    sits on the HIGH-bias side -> bias DOWN (E fell monotonically 0.685 -> 0.123 for bias 0.59 -> -0.01 at G=0.59)
    //   F2 (apo short)   not seen in the real log; spec (aggressive) -> bias DOWN, unverified.
    // (Old rule FE=+1 was wrong: every FE scan walked uphill, then 'flipped', and scans at G=0.57 stepped over the OK window.)
    const dirOf = (cls) => (cls === 'F1' ? 1 : -1);
    function classify(m) {
      if (m.endReason === 'STAGE_VR_NEG' || m.stageVrNeg || m.endReason === 'CRASHED') return 'F1';
      if (m.endReason !== 'COAST_WAIT_ENTRY' || !Number.isFinite(m.eCoast)) return 'F2';
      if (!(m.apoCoastKm >= targetAltKm - apoTol)) return 'F2';
      if (m.eCoast > ceil) return 'FE';
      return 'OK';
    }
    const dsc = (p) => 'G=' + U.gOf(p.Gi) + ' T=' + U.tOf(p.Tn) + ' A=' + U.aEff(p).toFixed(4) + ' bias=' + U.biasOf(p.bi);

    const okPts = new Map();   // every point that was OK when evaluated (re-checked against the current ceil on reuse)
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
      if (r.cls === 'OK') okPts.set(U.key(p), r);
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
          // The OK window between F1 and FE edges can be only ~0.01 deg wide (real log) -> bisect finer than the ladder floor.
          const bisFloor = Math.max(1, Math.round(floorBi / 10));
          let a = prev.p.bi, b = r.p.bi, ca = prev.cls;
          while (Math.abs(b - a) > bisFloor) {
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

    // One step of A down on one axis (G: -st gimbal quanta, T: -st Tn quanta); the trial is rescued by a local bias
    // scan. `slopes[axis]` = bias quanta per step unit, learned from climbed (E~ceil) points of consecutive lanes
    // (A and bias trade off along an E isoline, ~0.55 deg per 0.01 G in the real log) -> next trial starts at the
    // predicted bias. A rescue within 0.1 deg of the bias bound is the Fail3 'extreme bias' zone -> rejected.
    const slopes = { G: 0, T: 0 };
    async function tryStep(r, axis, st) {
      const extreme = 1000;
      const trial = axis === 'G' ? U.step(r.p, { dGi: -st }) : U.step(r.p, { dTn: -st });
      if (slopes[axis]) trial.bi = Math.max(biasLo, Math.min(biasHi, r.p.bi + Math.round(slopes[axis] * st)));
      if (!U.inBounds(trial)) return null;
      const q = await findOk(trial, axis === 'G' ? 1000 : 200, axis === 'G' ? 10 : 4);
      if (!q || q.p.bi > biasHi - extreme || q.p.bi < biasLo + extreme) {
        say('step ' + axis + ' -' + st + ' from ' + dsc(r.p) + ': ' + (q ? 'needs extreme bias ' + U.biasOf(q.p.bi) : 'no OK window (closed at ceil)'));
        return null;
      }
      return q;
    }

    // Raise E toward the ceiling (E is steep in bias near its minimum: ~0.4 per 0.02 deg in the real log, so a
    // fixed 0.01 ladder jumps from E~0.001 straight to FE). Go up in bias (E rises on that side) with doubling
    // steps from a fine start until FE, then bisect OK|FE down to the finest bias resolution, stopping early when
    // E lands in [ceil - eClimbTol, ceil]. Never returns a non-OK point.
    async function climbE(r) {
      const rq = Math.max(1, Math.round(floorBi / 10));          // finest bias resolution (0.001 fine, 0.0001 accurate)
      const tolE = opts.eClimbTol != null ? opts.eClimbTol : 0.01;
      const inWin = (x) => x.E >= ceil - tolE;
      let best = r;
      if (inWin(best)) return best;
      let a = r, bad = null, st = 4 * rq;
      while (!bad && a.p.bi < biasHi) {
        const q = await evAB(U.step(a.p, { dbi: Math.min(st, biasHi - a.p.bi) }));
        if (q.cls === 'OK') { if (q.E > best.E) best = q; a = q; if (inWin(q)) return q; st *= 2; }
        else bad = q;
      }
      if (!bad) return best;
      let b = bad;
      while (b.p.bi - a.p.bi > 1) {                                // down to 1 quantum: E can move ~0.05 per 0.001 deg at low A
        const mid = Math.floor((a.p.bi + b.p.bi) / 2);
        if (mid <= a.p.bi) break;
        const q = await evAB(Object.assign({}, a.p, { bi: mid }));
        if (q.cls === 'OK') { if (q.E > best.E) best = q; a = q; if (inWin(q)) return q; } else b = q;
      }
      return best;
    }

    const all = [];            // every verified candidate
    let eOk = -Infinity, eBad = Infinity, leadHint = point.li, relearns = 0, status = 'ok';

    async function verify(rc, tag) {
      const p = Object.assign({}, rc.p, { li: leadHint });
      say('verify [' + tag + '] ' + dsc(p) + ' E=' + fmt(rc.E, 5));
      const lr = await tuneLead(p, { hook: H, cache, abortRef: opts.abortRef, env: opts.env, targetAltKm,
        onProgress: opts.onProgress, onLog: opts.verbose ? (s) => say('    ' + s) : null });
      leadEvals += lr.evals;
      const rec = { tag, round: relearns, point: rc.p, desc: U.describe(rc.p), E: rc.E, apoCoastKm: rc.m.apoCoastKm,
        lead: { ok: lr.ok, inBand: lr.inBand, reason: lr.reason, lead: lr.lead, leadTicks: lr.leadTicks,
                marginS: lr.marginS, vrEnd: lr.vrEnd, vrMin: lr.vrMin, phase: lr.phase },
        metrics: null, score: Cfg.scoring.failPenalty * 2, ok: false, reasons: [], parts: null, fullPoint: null };
      if (!lr.ok) { rec.reasons = ['lead_failed: ' + lr.reason]; say('  -> lead FAILED: ' + lr.reason); return rec; }
      leadHint = lr.leadTicks;
      let fm = cache.get(lr.point, 'FULL');
      if (!fm) { fm = await H.runEval(lr.point, { stopAt: 'FULL', targetAltKm, env: opts.env, abortRef: opts.abortRef,
                                                  onProgress: opts.onProgress }); cache.set(lr.point, 'FULL', fm); fullEvals++; }
      const sc = U.score(fm, { targetAltKm });
      if (sc.ok && opts.residualBand) {                 // Phase B guard: a lane whose stage residual leaves the band is rejected (not an E_max failure)
        const rb = opts.residualBand, rk = fm.stageResidualKg;
        if (!(rk >= rb[0] && rk <= rb[1])) { sc.ok = false; sc.reasons = (sc.reasons || []).concat(['residual_out_of_band ' + fmt(rk, 1) + ' not in [' + rb[0] + ',' + rb[1] + ']']); rec.resFail = true; }
      }
      Object.assign(rec, { metrics: fm, score: sc.score, ok: sc.ok, reasons: sc.reasons, parts: sc.parts, fullPoint: lr.point,
                           desc: U.describe(lr.point) });
      say('  -> lead ' + lr.lead + ' (' + lr.leadTicks + ' t) margin=' + fmt(lr.marginS, 2) + ' vrEnd=' + fmt(lr.vrEnd, 4) +
          '  FULL score=' + sc.score.toFixed(3) + (sc.ok ? '' : ' HARD-FAIL ' + sc.reasons.join(',')) +
          '  deploy=' + fmt(fm.deployTimeS, 2) + ' apo/peri=' + fmt(fm.apogeeKm, 3) + '/' + fmt(fm.perigeeKm, 3));
      return rec;
    }

    // One lane = one (G,T). Find its E-max edge (climbE) and verify it (tuneLead + FULL + score). If the verified edge
    // point fails downstream (real log: E=0.196 at the F1 cliff -> no feasible lead), E_max is lowered and the SAME lane
    // is re-climbed to the new ceiling from its visited OK points (cached, ~free) instead of restarting the search.
    async function settle(q, tag, doClimb) {
      let c = q, rec = null;
      for (let k = 0; k <= maxRelearn; k++) {
        if (doClimb) c = await climbE(c);
        rec = await verify(c, tag + (k ? ' (E_max relearn ' + k + ')' : ''));
        all.push(rec);
        if (rec.ok) { eOk = Math.max(eOk, rec.E); return { c, rec }; }
        if (rec.resFail) { say('  residual guard: lane rejected (' + rec.reasons.join(',') + ')'); return { c, rec }; }
        if (k === maxRelearn) break;
        eBad = Math.min(eBad, c.E);
        eMax = (Number.isFinite(eOk) && eOk < eBad) ? (eOk + eBad) / 2 : eBad - (Cfg.ecc.eDropOnFail || 0.01);
        ceil = eMax - eSafe; relearns++;
        say('E_max learning: E=' + fmt(c.E, 5) + ' failed (' + rec.reasons.join(',') + ') -> eMax := ' + fmt(eMax, 4) +
            '  (eOk=' + fmt(eOk, 5) + ' eBad=' + fmt(eBad, 5) + ')');
        const lane = [...okPts.values()].filter((x) => x.p.Gi === c.p.Gi && x.p.Tn === c.p.Tn && x.E <= ceil && x.m)
          .sort((x, y) => y.E - x.E);
        if (!lane.length) { say('  lane has no OK point below the new ceiling -> lane dropped'); break; }
        c = lane[0]; doClimb = true;
      }
      return { c, rec };
    }

    try {
      say('tuneAB[' + (opts.mode || 'fine') + ']: start ' + dsc(point) + ' lead=' + point.li + 't  eMax=' + eMax +
          ' (ceil ' + ceil.toFixed(4) + ')  biasLadder=' + ladder.join('/') + ' Tladder=' + tLadder.join('/'));
      const minGain = opts.minGain != null ? opts.minGain : 0;
      const better = (rec, ref) => rec.ok && (!ref || rec.score < ref.score - minGain);
      ceil = eMax - eSafe;
      const r0 = await startOk(point);
      if (!r0) { status = 'no OK (A,bias) found (Fail3 exhausted)'; throw new Stop('startOk'); }
      say('startOk: ' + dsc(r0.p) + ' E=' + fmt(r0.E, 5));

      // level 0: the start lane as is (reference score for the stop rule; cheap: lead is already ~right)
      const s0 = await settle(r0, 'start', false);
      let best = s0.rec.ok ? s0.rec : null, lane = s0.c, stopWhy = 'start failed';

      if (opts.rough) {
        // Phase A (rough): ANY feasible (G,T,bias,lead) at this MECO is enough -> no edge search, no A minimisation.
        // If the start lane fails downstream, relax A (G +2 quanta each, bias re-found by scan) up to 3 times.
        let rec = s0.rec;
        for (let n = 1; !(rec && rec.ok) && n <= (opts.roughRelax != null ? opts.roughRelax : 3); n++) {
          const rr = await startOk(U.step(r0.p, { dGi: 2 * n }));
          if (!rr) break;
          const ss = await settle(rr, 'rough-relax' + n, false);
          rec = ss.rec;
        }
        best = rec && rec.ok ? rec : null;
        stopWhy = best ? 'rough: feasible point found' : 'rough: no feasible point';
        say(stopWhy);
      } else {
      // ---- G descent: every G level = find edge (climbE) + verify; continue only while the verified score improves ----
      let windowClosed = false, levels = 0;
      const maxLevels = opts.maxGLevels || 12;
      while (levels++ < maxLevels) {
        const q = await tryStep(lane, 'G', mode.gStep);
        if (!q) { windowClosed = true; stopWhy = 'G window closed'; break; }
        const s = await settle(q, 'G=' + U.gOf(q.p.Gi), true);
        if (!s.rec || !s.rec.ok) { stopWhy = 'G level ' + U.gOf(q.p.Gi) + (s.rec && s.rec.resFail ? ' rejected by residual guard' : ' failed downstream'); windowClosed = true; break; }
        if (s.c.p.bi !== lane.p.bi) slopes.G = (s.c.p.bi - lane.p.bi) / mode.gStep;
        if (!better(s.rec, best)) { stopWhy = 'G level ' + U.gOf(q.p.Gi) + ' score not better (' + s.rec.score.toFixed(3) +
                                              ' vs ' + (best ? best.score.toFixed(3) : 'n/a') + ')'; break; }
        best = s.rec; lane = s.c;
      }
      say('G descent stopped: ' + stopWhy);

      // ---- T descent: only when G is exhausted by the window (not by score); coarse levels, fail-stop ----
      // Gain of a T step is tiny (one 0.02 s T-level ~ one G quantum ~1.7% of A) but each verified step costs ~5 evals,
      // so fine mode only tries the two coarse levels; fast skips T; accurate walks the whole ladder.
      const tSteps = mode.tPhaseSteps || (opts.mode === 'fast' ? [] : (opts.mode === 'accurate' ? tLadder : [80, 40]));
      if (windowClosed && tSteps.length && best) {
        let fails = 0;
        const tFailStop = opts.tFailStop != null ? opts.tFailStop : 2;
        for (const st of tSteps) {
          if (fails >= tFailStop) break;
          let progressed = false;
          for (let it = 0; it < 3; it++) {
            const q = await tryStep(lane, 'T', st);
            if (!q) break;
            const s = await settle(q, 'T=' + U.tOf(q.p.Tn), true);
            if (!s.rec || !s.rec.ok) break;
            if (s.c.p.bi !== lane.p.bi) slopes.T = (s.c.p.bi - lane.p.bi) / st;
            if (!better(s.rec, best)) break;
            best = s.rec; lane = s.c; progressed = true;
          }
          fails = progressed ? 0 : fails + 1;
        }
        say('T descent done at ' + dsc(lane.p) + ' (' + fails + ' consecutive failed levels)');
      }
      }
      if (!best) status = 'no candidate passed (lead/hard constraints)';
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      if (status === 'ok') status = 'stopped: ' + e.message;
    }

    all.sort((a, b) => a.score - b.score);
    const best = all.find((x) => x.ok) || null;
    const evalsTotal = abEvals + leadEvals + fullEvals;
    const res = {
      ok: !!best, status, best, candidates: all,
      eMax: { eMax, ceil, eOk: Number.isFinite(eOk) ? eOk : null, eBad: Number.isFinite(eBad) ? eBad : null, rounds: relearns },
      evals: evalsTotal, evalBreakdown: { ab: abEvals, lead: leadEvals, full: fullEvals }, cacheHits: cache.hits - hits0,
      wallMs: performance.now() - t0, log: lines,
    };
    say('tuneAB: ' + (best ? 'best[' + best.tag + '] score=' + best.score.toFixed(3) + ' ' + JSON.stringify(best.desc) : 'FAILED') +
        '  | ' + status + ' | evals=' + evalsTotal + ' (ab ' + abEvals + ' lead ' + leadEvals + ' full ' + fullEvals + ') wall=' +
        (res.wallMs / 1000).toFixed(1) + 's');
    return res;
  }

  // ==========================================================================
  // Phase A building block — tuneRough(point, opts): at the point's MECO find ANY feasible (G,T,bias,lead):
  // coast reaches apo, E<=ceil, tuneLead ok, FULL passes hard limits. Then FULL metrics give the stage residual that
  // the MECO outer loop (Step 7) steers on. ~10-15 AB evals + lead (~3) + 1 FULL; warm start = previous MECO's point.
  // ==========================================================================
  async function tuneRough(point, opts) {
    opts = Object.assign({}, opts || {}, { rough: true, maxRelearn: 0 });
    if (!opts.mode) opts.mode = 'fast';
    const r = await tuneAB(point, opts);
    const b = r.best;
    const m = b && b.metrics;
    return {
      ok: !!b, reason: b ? 'ok' : r.status,
      point: b ? b.fullPoint : null, E: b ? b.E : NaN, lead: b ? b.lead : null,
      metrics: m || null,
      residualKg: m && Number.isFinite(m.stageResidualKg) ? m.stageResidualKg : NaN,
      score: b ? b.score : NaN,
      evals: r.evals, evalBreakdown: r.evalBreakdown, cacheHits: r.cacheHits, wallMs: r.wallMs, log: r.log,
    };
  }

  // ==========================================================================
  // Phase A outer loop v2 — findOptimalMeco(point, opts)
  //   Steers the stage residual (kg of stage fuel left) into band [0,50] with TWO knobs:
  //     MECO = fine knob (residual decreasing in MECO, slope ~ -0.03..-0.08 kg/kg, flattens + hits a feasibility CLIFF)
  //     G    = coarse knob (1 quantum = -gQuantumKg residual, ~ -97.3 kg, AND the cliff moves out by ~2200 kg MECO)
  //   Probes: FAST = COAST_WAIT (warm start) + 1 CIRC_END at the trend-predicted lead; residual = stageFuelEngOffKg + resOffset.
  //     No lead search, no FULL. Only when a fast probe lands IN band -> confirm with tuneRough (FULL), which calibrates
  //     resOffset (= real - fast). The first probe on a new G level is a full tuneRough (bias/lead of a new lane unknown).
  //   Physics tolerance: tol = clamp(0.1*bandWidth/|slope|, 30, 300) kg (booster burns ~30 kg/tick: finer MECO = same sim).
  //   Cliff-aware: after a failing MECO `hi` above feasible `lo`: r_opt = r_lo + slope*(hi - tol - lo). r_opt > band top =>
  //     floor-limited at this G (no MECO can reach the band) -> G-drop (one quantum), then jump straight to the MECO the
  //     residual model predicts at the new G (old probes are re-used as virtual points: r - gQuantumKg*dGi).
  // ==========================================================================
  // residual band for this run: deorbit ON -> residualTargetDeorbitOnKg, else residualTargetKg (opts.deorbit overrides cfg.fixed.deorbitEnabled)
  function residualBand(opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, L = Cfg.limits;
    const on = opts.deorbit != null ? !!opts.deorbit : !!(Cfg.fixed && Cfg.fixed.deorbitEnabled);
    return (on ? (L.residualTargetDeorbitOnKg || [500, 600]) : (L.residualTargetKg || [100, 200])).slice();
  }

  async function findOptimalMeco(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, U = root.TunerUtils, Q = Cfg.quanta, L = Cfg.limits, H = opts.hook || root.TunerHook;
    const MC = Cfg.meco || {};
    const t0 = performance.now();
    const band = opts.band || residualBand(opts);
    const bLo = band[0], bHi = band[1], bW = bHi - bLo;
    const aim = opts.aimKg != null ? opts.aimKg : (bLo + bHi) / 2;
    const ladder0 = ((opts.ladderKg || MC.stepLadderKg || [4000, 1000, 200])[0]);
    const gKg = opts.gQuantumKg != null ? opts.gQuantumKg : (MC.gQuantumKg || 97.3);
    const gBiasQ0 = Math.round((opts.gBiasDegPerQ != null ? opts.gBiasDegPerQ : (MC.gBiasDegPerQ || 0.55)) / Q.bias);   // bias quanta per +1 Gi
    const slopePrior = opts.slopePrior != null ? opts.slopePrior : (MC.slopePrior || -0.05);
    const maxGDrops = opts.maxGDrops != null ? opts.maxGDrops : (MC.maxGDrops != null ? MC.maxGDrops : 3);
    const maxIter = opts.maxIter || 16, maxFailWalk = opts.maxFailWalk || 6, trendMinKg = opts.trendMinKg || 300;
    const fast = opts.fast !== false;
    const rescueBi = opts.probeRescueBi || 100;            // 0.01 deg, one rescue step for a failing fast probe
    const mB = Cfg.bounds.meco, biB = [Math.round(Cfg.bounds.bias.lower / Q.bias), Math.round(Cfg.bounds.bias.upper / Q.bias)];
    const targetAltKm = opts.targetAltKm != null ? opts.targetAltKm : Cfg.fixed.targetAltKm;
    const ceil = (Cfg.ecc.eMax != null ? Cfg.ecc.eMax : Cfg.ecc.eMaxGuess) - (L.eSafetyMargin != null ? L.eSafetyMargin : 0.0005);
    const apoTol = L.coastApoTolKm != null ? L.coastApoTolKm : 1;
    const cache = opts.cache || new U.EvalCache();
    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
    const aborted = () => !!(opts.abortRef && opts.abortRef.aborted);
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const tolOf = (s) => clamp(0.1 * bW / Math.max(1e-6, Math.abs(s)), 30, 300);

    // ---- default MECO trend (bias quanta/kg, lead ticks/kg) from same-G reference pair ----
    function defaultTrend() {
      const refs = Cfg.references || []; let best = null;
      for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) {
        if (refs[i].G !== refs[j].G || refs[i].meco === refs[j].meco) continue;
        const span = Math.abs(refs[j].meco - refs[i].meco);
        if (!best || span > best.span) best = { a: refs[i], b: refs[j], span };
      }
      if (!best) return { bi: 0, li: 0, src: 'none' };
      const dm = best.b.meco - best.a.meco;
      return { bi: ((best.b.bias - best.a.bias) / Q.bias) / dm, li: ((best.b.lead - best.a.lead) / Q.lead) / dm, src: 'cfg.references' };
    }
    const dTrend = defaultTrend();
    let gBiasQ = gBiasQ0;                          // learned after the first G-drop
    let resOffset = 0, offsetKnown = false;        // real residual = fast raw + resOffset (offsetKnown = verified against a FULL at the same point)
    const autoCalib = opts.autoCalib !== false, nearKg = opts.nearConfirmKg != null ? opts.nearConfirmKg : 80;

    // ---- history ----
    const hist = [];
    let seq = 0, evals = 0;
    const ev = { ab: 0, lead: 0, full: 0, probeCoast: 0, probeCirc: 0 };
    const resid = (h) => (h.real ? h.residualKg : h.raw + resOffset);
    const cls = (h) => (!h.ok ? 'fail' : (() => { const r = resid(h); return !Number.isFinite(r) ? 'fail' : r > bHi ? 'up' : r < bLo ? 'down' : 'in'; })());
    const rAt = (h, gi) => resid(h) - gKg * (h.gi - gi);          // residual of h's MECO as it would be at G index gi
    let curGi = point.Gi;
    const here = () => hist.filter((h) => h.gi === curGi && !h.superseded);
    const feasAll = () => hist.filter((h) => h.ok && !h.superseded && Number.isFinite(resid(h)));
    // virtual class of a feasible entry at the current G level
    const vcls = (h) => { const r = rAt(h, curGi); return r > bHi ? 'up' : r < bLo ? 'down' : 'in'; };
    const lo = () => feasAll().filter((h) => vcls(h) === 'up').sort((a, b) => b.meco - a.meco)[0] || null;
    const hi = () => {
      const c = feasAll().filter((h) => vcls(h) === 'down').concat(here().filter((h) => !h.ok)).sort((a, b) => a.meco - b.meco);
      const l = lo(); return c.filter((h) => !l || h.meco > l.meco)[0] || null;
    };
    let slopeMeasured = false;
    function slopeNear(m) {                          // kg/kg from the two feasible points (virtualised to curGi) closest to m
      const f = feasAll().sort((a, b) => Math.abs(a.meco - m) - Math.abs(b.meco - m));
      for (let j = 1; j < f.length; j++) if (f[j].meco !== f[0].meco) {
        const s = (rAt(f[j], curGi) - rAt(f[0], curGi)) / (f[j].meco - f[0].meco);
        if (s < 0) { slopeMeasured = true; return s; }
      }
      slopeMeasured = false;
      return slopePrior;
    }

    // ---- warm start: nearest entry (same level preferred) shifted by MECO trend and G step ----
    function trendFor(ref) {
      const mates = hist.filter((h) => h.ok && h.point && h !== ref && h.point.Gi === ref.point.Gi && h.point.Tn === ref.point.Tn && !h.fastPoint &&
                                       Math.abs(h.meco - ref.meco) >= trendMinKg);
      if (!mates.length || ref.fastPoint) return dTrend;
      mates.sort((a, b) => Math.abs(a.meco - ref.meco) - Math.abs(b.meco - ref.meco));
      const m = mates[0], dm = ref.meco - m.meco;
      let bi = (ref.point.bi - m.point.bi) / dm, li = (ref.point.li - m.point.li) / dm, src = 'learned';
      if (!(bi >= 0)) { bi = dTrend.bi; src += '(bias->default)'; }
      if (!(li <= 0)) { li = dTrend.li; src += '(lead->default)'; }
      return { bi, li, src };
    }
    const seed = { meco: point.meco, gi: point.Gi, point, ok: true, seed: true, real: true, residualKg: NaN };
    function warmStart(target, gi) {
      const refs = hist.filter((h) => h.ok && h.point && !h.superseded).concat([seed]);
      refs.sort((a, b) => ((a.gi === gi ? 0 : 1e9) + Math.abs(a.meco - target)) - ((b.gi === gi ? 0 : 1e9) + Math.abs(b.meco - target)));
      const ref = refs[0], tr = ref.fastPoint ? dTrend : trendFor(ref), dm = target - ref.meco, dg = gi - ref.point.Gi;
      const dbi = Math.round(tr.bi * dm) + dg * gBiasQ, dli = Math.round(tr.li * dm);
      const p = Object.assign({}, ref.point, { meco: target, Gi: gi,
        bi: clamp(ref.point.bi + dbi, biB[0], biB[1]), li: Math.max(0, ref.point.li + dli) });
      return { p, from: ref.meco, dbi, dli, dg, src: tr.src, ref };
    }

    // ---- fast probe: COAST_WAIT (warm) [+ <=1 bias rescue] + 1 CIRC_END at the predicted lead ----
    function coastCls(m) {
      if (m.endReason === 'STAGE_VR_NEG' || m.stageVrNeg || m.endReason === 'CRASHED') return 'F1';
      if (m.endReason !== 'COAST_WAIT_ENTRY' || !Number.isFinite(m.eCoast)) return 'F2';
      if (!(m.apoCoastKm >= targetAltKm - apoTol)) return 'F2';
      return m.eCoast > ceil ? 'FE' : 'OK';
    }
    async function runCached(p, stopAt) {
      let m = cache.get(p, stopAt);
      if (!m) {
        m = await H.runEval(p, { stopAt, targetAltKm, env: opts.env, abortRef: opts.abortRef, onProgress: opts.onProgress });
        cache.set(p, stopAt, m);
        if (stopAt === 'COAST_WAIT_ENTRY') { ev.probeCoast++; evals++; } else { ev.probeCirc++; evals++; }
      }
      return m;
    }
    async function fastProbe(p0) {
      let n0 = evals, p = p0, c = null, m = null;
      for (let k = 0; k <= 1; k++) {
        if (!U.inBounds(p)) { c = 'OOB'; break; }
        m = await runCached(p, 'COAST_WAIT_ENTRY'); c = coastCls(m);
        if (c === 'OK' || k === 1 || aborted()) break;
        p = Object.assign({}, p, { bi: clamp(p.bi + (c === 'F1' ? +1 : -1) * rescueBi, biB[0], biB[1]) });   // F1 -> bias up, FE/F2 -> down
      }
      if (c !== 'OK') return { ok: false, reason: 'coast ' + c, point: null, evals: evals - n0 };
      const mc = await runCached(p, 'CIRC_END');
      const fuel = mc.stageFuelEngOffKg;
      if (mc.endReason !== 'CIRC_END' || !Number.isFinite(fuel) || fuel <= 0 || !(mc.vrEnd >= -0.5))
        return { ok: false, reason: 'circ end=' + mc.endReason + ' fuel=' + fmt(fuel, 1) + ' vrEnd=' + fmt(mc.vrEnd, 3), point: p, evals: evals - n0 };
      return { ok: true, reason: 'ok', point: p, raw: fuel, E: m.eCoast, vrEnd: mc.vrEnd, evals: evals - n0 };
    }
    async function full(p0) {                        // real tuneRough (FULL) — confirm / first probe on a level
      const r = await tuneRough(p0, { mode: opts.mode || 'fast', hook: opts.hook, env: opts.env, targetAltKm, abortRef: opts.abortRef,
        onProgress: opts.onProgress, cache, roughRelax: opts.roughRelax != null ? opts.roughRelax : 0,
        onLog: opts.verbose ? (l) => say('      ' + l) : undefined });
      evals += r.evals; ev.ab += r.evalBreakdown.ab; ev.lead += r.evalBreakdown.lead; ev.full += r.evalBreakdown.full;
      return r;
    }

    // ---- next MECO (fine knob) at the current level; returns {meco,how} | {gdrop,why} | {stop} ----
    let prevW = null;
    function nextMeco() {
      const l = lo(), h = hi();
      const sl = l ? slopeNear(l.meco) : slopePrior, tol = tolOf(sl);
      if (l && h) {
        const w = h.meco - l.meco, rl = rAt(l, curGi);
        if (h.ok) {                                   // upper side is a real/virtual feasible point below the band
          if (w <= tol) return { stop: 'bracket closed (width ' + w + ' kg <= tol ' + tol.toFixed(0) + ')' };
        } else if (slopeMeasured) {                   // upper side is a FAILURE (cliff) -> optimistic floor test (needs a measured slope)
          const rOpt = rl + sl * Math.max(0, h.meco - tol - l.meco);
          if (rOpt > bHi) return { gdrop: true, why: 'cliff at ' + h.meco + ': r_opt=' + fmt(rOpt, 1) + ' > ' + bHi + ' (r_lo=' + fmt(rl, 1) + ' @' + l.meco + ', slope ' + sl.toFixed(4) + ', tol ' + tol.toFixed(0) + ')' };
          if (w <= tol) return { gdrop: true, why: 'bracket closed on cliff (w=' + w + ' <= tol ' + tol.toFixed(0) + ') with r=' + fmt(rl, 1) };
        } else if (w <= tol) return { gdrop: true, why: 'bracket closed on cliff (w=' + w + ' <= tol ' + tol.toFixed(0) + ') with r=' + fmt(rl, 1) };
        const forceMid = prevW != null && w > 0.5 * prevW; prevW = w;
        let m = Math.round(l.meco + w / 2), how = 'bisect';
        if (!forceMid && h.ok) {                      // interpolate only against a real residual; a cliff gives no residual -> plain bisect
          if (rAt(l, curGi) > rAt(h, curGi)) { m = Math.round(l.meco + (rl - aim) / (rl - rAt(h, curGi)) * w); how = 'interp'; }
          else { m = Math.round(l.meco + (aim - rl) / sl); how = 'secant'; }
        }
        return { meco: clamp(m, l.meco + Math.max(1, Math.round(tol / 2)), h.meco - Math.max(1, Math.round(tol / 2))), how: how + (forceMid ? '(forced mid)' : ''), width: w };
      }
      if (l) {                                        // only "too high residual" seen -> go up (secant, <= ladder[0])
        const rl = rAt(l, curGi), mv = (aim - rl) / sl;
        const step = clamp(mv, tol, ladder0);
        const base = hist.filter((x) => x.gi === curGi && !x.superseded).length ? 'secant' : 'model';
        return { meco: Math.round(l.meco + step), how: base + (step >= ladder0 ? '(cap)' : ''), width: null };
      }
      if (h) {                                        // only below-band / failure seen -> go down
        const f = feasAll().filter((x) => x.meco < h.meco).sort((a, b) => b.meco - a.meco)[0];
        return { meco: Math.round(f ? (f.meco + h.meco) / 2 : h.meco - ladder0), how: 'down', width: null };
      }
      return { stop: 'no data' };
    }

    // ---- main loop ----
    let status = 'maxIter', inBand = null, failWalk = 0, gDrops = 0, iter = 0;
    say('findOptimalMeco v2: start MECO=' + point.meco + ' G=' + U.gOf(point.Gi) + '  band=[' + bLo + ',' + bHi + '] aim=' + aim + ' ladder0=' + ladder0 + ' gQuantum=' + gKg +
        ' kg  fast=' + fast + '  default trend: bias ' + (dTrend.bi * Q.bias * 1000).toFixed(3) + ' mdeg/kg, lead ' + dTrend.li.toFixed(4) + ' ticks/kg (' + dTrend.src + ')');
    let target = point.meco, how = 'start', width = null, newLevel = true, first = true;
    while (iter < maxIter) {
      iter++;
      if (aborted()) { status = 'aborted'; break; }
      if (target < mB.lower || target > mB.upper) { status = 'MECO bound reached (' + target + ')'; break; }
      const n0 = evals;
      const ws = first ? { p: Object.assign({}, point, { meco: target }), from: point.meco, dbi: 0, dli: 0, dg: 0, src: 'seed' } : warmStart(target, curGi);
      const useFull = first || newLevel || !fast;       // start, first probe on a new G level, or fast disabled
      let e;
      if (useFull) {
        const r = await full(ws.p);
        const res = r.ok ? r.residualKg : NaN;
        e = { iter, seq: ++seq, meco: target, gi: curGi, how, kind: first ? 'start' : (newLevel ? 'level' : 'full'), real: true, ok: r.ok && Number.isFinite(res),
              residualKg: res, E: r.E, score: r.score, point: r.ok ? r.point : null, lead: r.lead, metrics: r.metrics, reason: r.reason,
              deployTimeS: r.metrics ? r.metrics.deployTimeS : NaN };
        if (autoCalib && e.ok && r.point) {              // calibrate fast vs FULL at the SAME point: tuneLead already cached its CIRC_END (free)
          const mc = cache.get(r.point, 'CIRC_END');
          const raw = mc && mc.endReason === 'CIRC_END' && Number.isFinite(mc.stageFuelEngOffKg) ? mc.stageFuelEngOffKg
                    : (r.metrics && Number.isFinite(r.metrics.stageFuelEngOffKg) ? r.metrics.stageFuelEngOffKg : NaN);
          if (Number.isFinite(raw)) {
            const old = resOffset; resOffset = res - raw; offsetKnown = true;
            say('      resOffset calibrated at this point: real ' + fmt(res, 1) + ' - fast ' + fmt(raw, 1) + ' = ' + fmt(resOffset, 2) + ' kg' + (Math.abs(resOffset - old) > 1 ? ' (was ' + fmt(old, 1) + ')' : ''));
          }
        }
        if (e.ok && ws.dg !== 0 && r.point) {            // learn bias shift per G step
          const act = (r.point.bi - (ws.ref.point.bi + Math.round((ws.ref.fastPoint ? dTrend : trendFor(ws.ref)).bi * (target - ws.ref.meco)))) / ws.dg;
          if (act > 0) { say('      learned gBias ' + (act * Q.bias).toFixed(3) + ' deg/Gi (was ' + (gBiasQ * Q.bias).toFixed(3) + ')'); gBiasQ = Math.round(act); }
        }
      } else {
        const pr = await fastProbe(ws.p);
        e = { iter, seq: ++seq, meco: target, gi: curGi, how, kind: 'fast', real: false, fastPoint: true, ok: pr.ok, raw: pr.raw, residualKg: NaN,
              E: pr.E, score: NaN, point: pr.ok ? pr.point : null, lead: null, metrics: null, reason: pr.reason, deployTimeS: NaN };
        if (!pr.ok && pr.point && pr.reason.startsWith('coast')) e.point = null;
      }
      e.warm = { from: ws.from, dBiasQ: ws.dbi, dLeadTicks: ws.dli, trend: ws.src };
      e.evals = evals - n0; if (!e.real && e.ok) e.residualKg = e.raw + resOffset;   // informational (decisions use raw+resOffset live)
      hist.push(e);
      let c = cls(e); e.cls = c;
      const rr = e.real ? e.residualKg : (e.ok ? e.raw + resOffset : NaN);
      say('#' + iter + ' MECO=' + target + ' G=' + U.gOf(curGi) + ' [' + e.kind + ' ' + how + (width != null ? ' w=' + width : '') + ']  warm<-' + ws.from + ' (bias' + (ws.dbi >= 0 ? '+' : '') + ws.dbi + 'q lead' + (ws.dli >= 0 ? '+' : '') + ws.dli + 't)  ->  ' +
          (e.ok ? (e.real ? 'residual=' : 'fast residual~') + fmt(rr, 1) + ' kg' + (e.real ? ' deploy=' + fmt(e.deployTimeS, 1) + 's' : '') + (e.point ? ' bias=' + U.biasOf(e.point.bi) + ' lead=' + e.point.li + 't' : '') : 'FAIL (' + e.reason + ')') + '  => ' + c.toUpperCase() + '  evals=' + e.evals);
      if (aborted()) { status = 'aborted'; break; }

      // fast probe says IN band -> confirm with a real tuneRough; calibrate resOffset
      // offset not yet verified against a FULL and the fast estimate is within nearKg above the band -> confirm too (it may really be in band)
      if (e.kind === 'fast' && c === 'up' && !offsetKnown && rr < bHi + nearKg) { c = 'in'; say('      near band with unverified fast offset -> confirm'); }
      if (e.kind === 'fast' && c === 'in') {
        const n1 = evals; iter++;
        const cr = await full(Object.assign({}, e.point));
        const res = cr.ok ? cr.residualKg : NaN;
        const ce = { iter, seq: ++seq, meco: target, gi: curGi, how: 'confirm', kind: 'confirm', real: true, ok: cr.ok && Number.isFinite(res), residualKg: res, E: cr.E, score: cr.score,
                     point: cr.ok ? cr.point : null, lead: cr.lead, metrics: cr.metrics, reason: cr.reason, warm: e.warm, evals: evals - n1,
                     deployTimeS: cr.metrics ? cr.metrics.deployTimeS : NaN };
        e.superseded = true; e.cls = 'superseded'; hist.push(ce);
        if (ce.ok) { const old = resOffset; resOffset = res - e.raw; offsetKnown = true; say('      confirm: real ' + fmt(res, 1) + ' vs fast ' + fmt(e.raw + old, 1) + ' -> resOffset ' + fmt(old, 1) + ' -> ' + fmt(resOffset, 1) + ' kg'); }
        c = cls(ce); ce.cls = c;
        say('#' + iter + ' MECO=' + target + ' [confirm]  ' + (ce.ok ? 'residual=' + fmt(res, 1) + ' kg deploy=' + fmt(ce.deployTimeS, 1) + 's bias=' + U.biasOf(ce.point.bi) + ' lead=' + ce.point.li + 't' : 'FAIL (' + ce.reason + ')') + '  => ' + c.toUpperCase() + '  evals=' + ce.evals);
        e = ce;
      }
      if (c === 'in') { inBand = e; status = 'in band'; break; }

      first = false; newLevel = false;
      if (!e.ok && !lo()) { if (++failWalk > maxFailWalk) { status = 'no feasible MECO (' + maxFailWalk + ' failing steps down)'; break; } } else failWalk = 0;
      if (opts.maxEvals && evals >= opts.maxEvals) { status = 'maxEvals'; break; }
      if (iter >= maxIter) break;
      let nx = nextMeco();
      if (nx.gdrop) {
        if (gDrops >= maxGDrops) { status = 'floor-limited: ' + nx.why + ' (maxGDrops ' + maxGDrops + ')'; break; }
        const np = Object.assign({}, point, { Gi: curGi - 1 });
        if (!U.inBounds(np)) { status = 'floor-limited, G lower bound'; break; }
        gDrops++; curGi--; newLevel = true; prevW = null;
        say('  G-DROP #' + gDrops + ' -> G=' + U.gOf(curGi) + ' (' + nx.why + ')  predicted shift ' + (-gKg).toFixed(1) + ' kg, old probes re-used as virtual points');
        nx = nextMeco();
        if (nx.gdrop || nx.stop) { status = nx.stop || ('floor-limited again: ' + nx.why); break; }
      }
      if (nx.stop) { status = nx.stop; break; }
      // never re-probe a MECO that already has a real entry at this level
      if (here().some((x) => x.meco === nx.meco)) nx.meco += 1;
      target = nx.meco; how = nx.how; width = nx.width;
    }

    // ---- result ----
    let pick = inBand;
    if (!pick) {
      const f = hist.filter((h) => h.real && h.ok && !h.superseded && Number.isFinite(h.residualKg));
      pick = f.filter((h) => h.residualKg > bHi).sort((a, b) => a.residualKg - b.residualKg)[0] ||
             f.sort((a, b) => Math.abs(a.residualKg - aim) - Math.abs(b.residualKg - aim))[0] || null;
    }
    const l = lo(), h = hi();
    const nFail = hist.filter((x) => !x.ok && !x.superseded).length;
    const res = {
      ok: !!inBand, status, meco: pick ? pick.meco : null, point: pick ? pick.point : null, residualKg: pick ? pick.residualKg : NaN,
      score: pick ? pick.score : NaN, E: pick ? pick.E : NaN, lead: pick ? pick.lead : null, metrics: pick ? pick.metrics : null,
      deployTimeS: pick ? pick.deployTimeS : NaN, band,
      G: pick ? U.gOf(pick.gi) : U.gOf(curGi), iters: iter, gDrops, resOffset, failingProbes: nFail,
      bracket: { lo: l ? l.meco : null, hi: h ? h.meco : null }, history: hist, evals, evalBreakdown: ev, cacheHits: cache.hits,
      wallMs: performance.now() - t0, log: lines,
    };
    say('=== findOptimalMeco v2 ' + (res.ok ? 'OK' : 'NOT in band') + ': ' + status + ' | MECO=' + res.meco + ' G=' + res.G + ' residual=' + fmt(res.residualKg, 1) + ' kg | iters=' + iter +
        ' gDrops=' + gDrops + ' failingProbes=' + nFail + ' resOffset=' + fmt(resOffset, 1) + ' evals=' + evals + ' (ab ' + ev.ab + ' lead ' + ev.lead + ' full ' + ev.full + ' probeCoast ' + ev.probeCoast + ' probeCirc ' + ev.probeCirc + ') wall=' + (res.wallMs / 1000).toFixed(1) + 's');
    return res;
  }


  // ==========================================================================
  // runTuner(point, opts) — Phase A (findOptimalMeco) + Phase B (tuneAB at that MECO), coupled (Option C + guard):
  //   * Phase A aims into the UPPER part of the residual band [lo + residualPhaseAFrac*w, hi] (headroom for Phase B),
  //   * Phase B (tuneAB) runs with residualBand = the FULL band: any lane whose FULL stage residual leaves the band is rejected
  //     (G descent stops there), so the final answer is always in band. The Phase A point is Phase B's start lane (reference score).
  //   * best = lowest-score verified candidate (Phase A point included).
  // opts: mode (Phase B, default 'fine'), band, deorbit, phaseA{...findOptimalMeco opts}, phaseB{...tuneAB opts}, hook, env, targetAltKm, abortRef, onLog, onProgress, cache
  // ==========================================================================
  async function runTuner(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, U = root.TunerUtils, L = Cfg.limits;
    const t0 = performance.now();
    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
    const band = opts.band || residualBand(opts);
    const frac = opts.residualPhaseAFrac != null ? opts.residualPhaseAFrac : (L.residualPhaseAFrac != null ? L.residualPhaseAFrac : 0.5);
    const bandA = opts.phaseABand || [band[0] + frac * (band[1] - band[0]), band[1]];
    const cache = opts.cache || new U.EvalCache();
    const common = { hook: opts.hook, env: opts.env, targetAltKm: opts.targetAltKm, abortRef: opts.abortRef, onProgress: opts.onProgress, cache };
    say('runTuner: residual band [' + band[0] + ',' + band[1] + '] kg (' + ((opts.deorbit != null ? opts.deorbit : Cfg.fixed.deorbitEnabled) ? 'deorbit ON' : 'deorbit OFF') + ')  Phase A band [' + fmt(bandA[0], 0) + ',' + fmt(bandA[1], 0) + ']  Phase B mode=' + (opts.mode || 'fine'));
    say('=== Phase A: findOptimalMeco ===');
    const A = await findOptimalMeco(point, Object.assign({}, common, { band: bandA, onLog: opts.onLog ? (l) => say(l) : (l) => lines.push(l) }, opts.phaseA || {}));
    const res = { ok: false, status: '', phaseA: A, phaseB: null, band, bestPoint: null, bestScore: NaN, bestMetrics: null, bestResidualKg: NaN, bestDeployS: NaN,
                  bestSource: null, evals: A.evals, breakdown: null, wallMs: 0, log: lines, leaderboard: [], meco: A.meco };
    if (!A.ok || !A.point) { res.status = 'phase A failed: ' + A.status; res.wallMs = performance.now() - t0; say('runTuner: ' + res.status); return res; }
    if (opts.abortRef && opts.abortRef.aborted) { res.status = 'aborted'; res.wallMs = performance.now() - t0; return res; }
    say('=== Phase B: tuneAB at MECO=' + A.meco + ' (start G=' + U.gOf(A.point.Gi) + ' bias=' + U.biasOf(A.point.bi) + ' lead=' + A.point.li + 't, residual ' + fmt(A.residualKg, 1) + ' kg, residual guard [' + band[0] + ',' + band[1] + ']) ===');
    const B = await tuneAB(A.point, Object.assign({}, common, { mode: opts.mode || 'fine', residualBand: band, onLog: opts.onLog ? (l) => say(l) : (l) => lines.push(l) }, opts.phaseB || {}));
    res.phaseB = B; res.evals = A.evals + B.evals;
    res.breakdown = { phaseA: A.evalBreakdown, phaseB: B.evalBreakdown };
    // best: lowest score among Phase B's verified lanes (start lane = Phase A point) and the Phase A confirmed point
    const cands = [];
    if (B.best) cands.push({ src: 'phaseB[' + B.best.tag + ']', point: B.best.fullPoint, score: B.best.score, metrics: B.best.metrics });
    if (Number.isFinite(A.score) && A.metrics) cands.push({ src: 'phaseA', point: A.point, score: A.score, metrics: A.metrics });
    cands.sort((a, b) => a.score - b.score);
    const best = cands.find((c) => c.metrics && c.metrics.stageResidualKg >= band[0] && c.metrics.stageResidualKg <= band[1]) || null;
    if (best) {
      res.bestPoint = best.point; res.bestScore = best.score; res.bestMetrics = best.metrics; res.bestSource = best.src;
      res.bestResidualKg = best.metrics.stageResidualKg; res.bestDeployS = best.metrics.deployTimeS; res.ok = true; res.status = 'ok';
    } else res.status = 'phase B: no in-band candidate';
    // leaderboard: every real FULL eval at the final MECO — Phase A confirmed/level/start + Phase B verified lanes
    const alt = opts.targetAltKm != null ? opts.targetAltKm : Cfg.fixed.targetAltKm;
    const rows = [], seen = new Map();
    const addRow = (row) => {
      const k = U.key(row.point);
      if (seen.has(k)) { const o = seen.get(k); if (o.src.indexOf(row.src) < 0) o.src += '+' + row.src; return; }
      seen.set(k, row); rows.push(row);
    };
    A.history.filter((e) => e.real && e.ok && e.metrics && e.point && e.meco === A.meco && e.gi === A.point.Gi)
      .forEach((e) => addRow(U.makeRow('A', 'A:' + e.kind, e.point, e.metrics, { E: e.E, targetAltKm: alt })));
    B.candidates.forEach((c) => { if (!c.metrics || !(c.fullPoint || c.point)) return;
      addRow(U.makeRow('B', c.tag, c.fullPoint || c.point, c.metrics,
        { E: c.E, targetAltKm: alt, reject: !!c.resFail, reasons: c.resFail ? c.reasons : [] })); });
    res.leaderboard = U.sortRows(rows, 'score');
    res.meco = A.meco;
    res.wallMs = performance.now() - t0;
    say('=== runTuner ' + (res.ok ? 'OK' : 'FAILED') + ': ' + res.status + (res.ok ? ' | best=' + res.bestSource + ' score=' + res.bestScore.toFixed(3) + ' residual=' + fmt(res.bestResidualKg, 1) + ' kg deploy=' + fmt(res.bestDeployS, 2) + 's ' + JSON.stringify(U.describe(res.bestPoint)) : '') +
        ' | evals=' + res.evals + ' (A ' + A.evals + ' + B ' + B.evals + ') wall=' + (res.wallMs / 1000).toFixed(1) + 's');
    return res;
  }

  root.TunerCore = { tuneLead, tuneAB, tuneRough, findOptimalMeco, runTuner, residualBand };
})();
