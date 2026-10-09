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
        if (!s.rec || !s.rec.ok) { stopWhy = 'G level ' + U.gOf(q.p.Gi) + ' failed downstream'; windowClosed = true; break; }
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
  // Phase A outer loop — findOptimalMeco(point, opts)
  //   Steers MECO (booster fuel left at MECO, kg) until the stage residual of tuneRough's point is in [0, 50] kg.
  //   residual(MECO) is DECREASING: MECO up -> booster burns less -> stage burns more -> less residual.
  //   Direction rule: residual > band -> MECO up | residual < band (or tuneRough fails) -> MECO down.
  //   1) unbracketed: ladder walk (opts.ladderKg, default cfg.meco.stepLadderKg [4000,1000,200]); once 2 feasible points
  //      exist the step is a secant extrapolation (clamped to <= ladder[0]) instead of a blind ladder step.
  //   2) bracketed (lo = highest MECO still too high a residual, hi = lowest MECO too low / failing): interpolation-guided
  //      bisection (midpoint when hi is a failure with no residual, or when the last step did not halve the bracket)
  //      down to bracket width <= bracketTolKg (default 1 kg).
  //   Warm start: every tuneRough starts from the nearest tuned point, bias/lead shifted by the MECO trend
  //   (MECO up => bias up, lead down), learned from history, default from cfg.references (same-G pair).
  //   tuneRough runs with roughRelax=0 here: relaxing A moves the residual (~ -97 kg per 0.01 G) and would break the
  //   monotone residual(MECO) the loop relies on; a failing MECO simply counts as "MECO down".
  // ==========================================================================
  async function findOptimalMeco(point, opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, U = root.TunerUtils, Q = Cfg.quanta, L = Cfg.limits;
    const t0 = performance.now();
    const band = opts.band || L.residualTargetKg || [0, 50];
    const bLo = band[0], bHi = band[1];
    const aim = opts.aimKg != null ? opts.aimKg : (bLo + bHi) / 2;
    const ladder = (opts.ladderKg || (Cfg.meco && Cfg.meco.stepLadderKg) || [4000, 1000, 200]).slice();
    const tol = opts.bracketTolKg != null ? opts.bracketTolKg : 1;
    const maxIter = opts.maxIter || 24, maxFailWalk = opts.maxFailWalk || 6, trendMinKg = opts.trendMinKg || 300;
    const interp = opts.interp !== false;
    const mB = Cfg.bounds.meco, biB = [Math.round(Cfg.bounds.bias.lower / Q.bias), Math.round(Cfg.bounds.bias.upper / Q.bias)];
    const cache = opts.cache || new U.EvalCache();
    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
    const aborted = () => !!(opts.abortRef && opts.abortRef.aborted);

    // ---- MECO trend (bias quanta / kg, lead ticks / kg) ----
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
    const seed = { meco: point.meco, point, ok: true, seed: true };
    const hist = [];
    function trendFor(ref) {
      const mates = hist.filter((h) => h.ok && h.point && h.point.Gi === ref.point.Gi && h.point.Tn === ref.point.Tn &&
                                       h !== ref && Math.abs(h.meco - ref.meco) >= trendMinKg);
      if (!mates.length) return dTrend;
      mates.sort((a, b) => Math.abs(a.meco - ref.meco) - Math.abs(b.meco - ref.meco));
      const m = mates[0], dm = ref.meco - m.meco;
      let bi = (ref.point.bi - m.point.bi) / dm, li = (ref.point.li - m.point.li) / dm;
      let src = 'learned';
      if (!(bi >= 0)) { bi = dTrend.bi; src += '(bias->default)'; }   // physics prior: MECO up => bias up
      if (!(li <= 0)) { li = dTrend.li; src += '(lead->default)'; }   // MECO up => lead down
      return { bi, li, src };
    }
    function warmStart(target) {
      const refs = hist.filter((h) => h.ok && h.point).concat([seed]);
      refs.sort((a, b) => Math.abs(a.meco - target) - Math.abs(b.meco - target));   // stable: tuned points win ties vs the seed
      const ref = refs[0], tr = trendFor(ref), dm = target - ref.meco;
      const dbi = Math.round(tr.bi * dm), dli = Math.round(tr.li * dm);
      const p = Object.assign({}, ref.point, {
        meco: target,
        bi: Math.max(biB[0], Math.min(biB[1], ref.point.bi + dbi)),
        li: Math.max(0, ref.point.li + dli),
      });
      return { p, from: ref.meco, dbi, dli, src: tr.src };
    }

    // ---- classification + bracket ----
    const classify = (ok, res) => (!ok || !Number.isFinite(res)) ? 'fail' : res > bHi ? 'up' : res < bLo ? 'down' : 'in';
    const feas = () => hist.filter((h) => h.ok && Number.isFinite(h.residualKg));
    const lo = () => hist.filter((h) => h.cls === 'up').sort((a, b) => b.meco - a.meco)[0] || null;
    const hi = () => hist.filter((h) => h.cls === 'down' || h.cls === 'fail').sort((a, b) => a.meco - b.meco)[0] || null;
    function secantSlope(near) {   // kg residual per kg MECO from the two feasible points closest to `near` (must be < 0)
      const f = feas().sort((a, b) => Math.abs(a.meco - near) - Math.abs(b.meco - near));
      for (let j = 1; j < f.length; j++) if (f[j].meco !== f[0].meco) {
        const s = (f[j].residualKg - f[0].residualKg) / (f[j].meco - f[0].meco);
        return s < 0 ? s : null;
      }
      return null;
    }
    let prevW = null;
    function nextMeco() {
      const l = lo(), h = hi();
      if (l && h) {                                   // ---- bracketed: bisect (interpolation-guided) ----
        const w = h.meco - l.meco;
        if (w <= tol) return { stop: 'bracket closed (width ' + w + ' kg)' };
        if (w < 0) return { stop: 'non-monotone: lo ' + l.meco + ' >= hi ' + h.meco };
        const forceMid = prevW != null && w > 0.5 * prevW;
        prevW = w;
        let m = Math.round(l.meco + w / 2), how = 'bisect';
        if (interp && !forceMid) {
          if (Number.isFinite(h.residualKg) && l.residualKg > h.residualKg) {
            m = Math.round(l.meco + (l.residualKg - aim) / (l.residualKg - h.residualKg) * w); how = 'interp';
          } else {
            const s = secantSlope(l.meco);
            if (s) { m = Math.round(l.meco + (aim - l.residualKg) / s); how = 'secant'; }
          }
        }
        return { meco: Math.max(l.meco + 1, Math.min(h.meco - 1, m)), how: how + (forceMid ? '(forced mid)' : ''), width: w };
      }
      // ---- unbracketed: only one side seen ----
      const dir = l ? +1 : -1, ext = l || h;
      const base = feas().sort((a, b) => b.seq - a.seq)[0];   // latest feasible point
      let step = ladder[0], how = 'ladder';
      const s = base ? secantSlope(base.meco) : null;
      if (s) {
        const mv = (aim - base.residualKg) / s;           // MECO move that would hit the aim
        if (Math.sign(mv) === dir) { step = Math.max(1, Math.min(ladder[0], Math.abs(base.meco + mv - ext.meco))); how = 'secant'; }
      }
      return { meco: Math.round(ext.meco + dir * step), how, width: null };
    }

    // ---- main loop ----
    let evals = 0, ev = { ab: 0, lead: 0, full: 0 }, status = 'maxIter', inBand = null, failWalk = 0, seq = 0;
    say('findOptimalMeco: start MECO=' + point.meco + '  band=[' + bLo + ',' + bHi + '] aim=' + aim + ' ladder=' + ladder.join('/') +
        ' tol=' + tol + ' kg  default trend: bias ' + (dTrend.bi * Q.bias * 1000).toFixed(3) + ' mdeg/kg, lead ' + (dTrend.li).toFixed(4) + ' ticks/kg (' + dTrend.src + ')');
    let target = point.meco, how = 'start', width = null;
    for (let it = 1; it <= maxIter; it++) {
      if (aborted()) { status = 'aborted'; break; }
      if (target < mB.lower || target > mB.upper) { status = 'MECO bound reached (' + target + ')'; break; }
      const ws = it === 1 ? { p: Object.assign({}, point, { meco: target }), from: point.meco, dbi: 0, dli: 0, src: 'seed' } : warmStart(target);
      const r = await tuneRough(ws.p, { mode: opts.mode || 'fast', hook: opts.hook, env: opts.env, targetAltKm: opts.targetAltKm, abortRef: opts.abortRef,
        onProgress: opts.onProgress, cache, roughRelax: opts.roughRelax != null ? opts.roughRelax : 0,
        onLog: opts.verbose ? (l) => say('      ' + l) : undefined });
      const res = r.ok ? r.residualKg : NaN, cls = classify(r.ok, res);
      const e = { iter: it, seq: ++seq, meco: target, how, ok: r.ok && Number.isFinite(res), cls, residualKg: res, E: r.E, score: r.score,
        point: r.ok ? r.point : null, lead: r.lead, metrics: r.metrics, warm: { from: ws.from, dBiasQ: ws.dbi, dLeadTicks: ws.dli, trend: ws.src },
        evals: r.evals, evalBreakdown: r.evalBreakdown, wallMs: r.wallMs, reason: r.reason };
      hist.push(e); evals += r.evals; ev.ab += r.evalBreakdown.ab; ev.lead += r.evalBreakdown.lead; ev.full += r.evalBreakdown.full;
      say('#' + it + ' MECO=' + target + ' [' + how + (width != null ? ' w=' + width : '') + ']  warm<-' + ws.from + ' (bias' + (ws.dbi >= 0 ? '+' : '') + ws.dbi + 'q lead' + (ws.dli >= 0 ? '+' : '') + ws.dli + 't)  ->  ' +
          (r.ok ? 'residual=' + fmt(res, 1) + ' kg  ' + (r.point ? 'G=' + U.gOf(r.point.Gi) + ' bias=' + U.biasOf(r.point.bi) + ' lead=' + r.point.li + 't' : '') + ' E=' + fmt(r.E, 4) : 'FAIL (' + r.reason + ')') +
          '  => ' + cls.toUpperCase() + '  evals=' + r.evals + ' (' + (r.wallMs / 1000).toFixed(1) + 's)');
      if (aborted()) { status = 'aborted'; break; }
      if (cls === 'in') { inBand = e; status = 'in band'; break; }
      if (cls === 'fail' && !lo()) { if (++failWalk > maxFailWalk) { status = 'no feasible MECO (' + maxFailWalk + ' failing steps down)'; break; } } else failWalk = 0;
      if (opts.maxEvals && evals >= opts.maxEvals) { status = 'maxEvals'; break; }
      const nx = nextMeco();
      if (nx.stop) { status = nx.stop; break; }
      target = nx.meco; how = nx.how; width = nx.width;
    }

    // ---- result: in-band point, else the closest feasible (lowest residual above the band, else highest below) ----
    let pick = inBand;
    if (!pick) {
      const f = feas();
      pick = f.filter((h) => h.cls === 'up').sort((a, b) => a.residualKg - b.residualKg)[0] ||
             f.sort((a, b) => Math.abs(a.residualKg - aim) - Math.abs(b.residualKg - aim))[0] || null;
    }
    const l = lo(), h = hi();
    const res = {
      ok: !!inBand, status, meco: pick ? pick.meco : null, point: pick ? pick.point : null, residualKg: pick ? pick.residualKg : NaN,
      score: pick ? pick.score : NaN, E: pick ? pick.E : NaN, lead: pick ? pick.lead : null, metrics: pick ? pick.metrics : null,
      bracket: { lo: l ? l.meco : null, hi: h ? h.meco : null }, history: hist, evals, evalBreakdown: ev, cacheHits: cache.hits,
      wallMs: performance.now() - t0, log: lines,
    };
    say('=== findOptimalMeco ' + (res.ok ? 'OK' : 'NOT in band') + ': ' + status + ' | MECO=' + res.meco + ' residual=' + fmt(res.residualKg, 1) + ' kg | iters=' + hist.length +
        ' evals=' + evals + ' (ab ' + ev.ab + ' lead ' + ev.lead + ' full ' + ev.full + ') wall=' + (res.wallMs / 1000).toFixed(1) + 's');
    return res;
  }

  root.TunerCore = { tuneLead, tuneAB, tuneRough, findOptimalMeco };
})();
