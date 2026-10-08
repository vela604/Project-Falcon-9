# tuner/STATE.md — Step 6 done; INNER-2 run once on real sim, classifier fixed (re-run pending); INNER-1 next

## Decision
CMA-ES hata diya. Guided search (see PROMPT.md v2). Last-mile polish = lattice pattern-search.

## Step 6 changes (this chat)
- hook-sandbox.js: bug fix. New `M.coastEnd` captured on COAST_ROTATE -> next phase (COAST_WAIT) transition
  (poll tracks prevPh). Fields: apo/peri/e/vr, stageFuelKg, t, fromPhase/toPhase, `exactTick` (false => transition
  caught late because stride>1). New stop point `stopAt: 'coastRotateEnd'`. `M.coast` (entry) kept for comparison.
- evaluator.js: `eval: 'coastEnd'` (evalKind 'coastEnd', stopAt coastRotateEnd); metrics coastEndApoKm/PeriKm/Ecc/Vr,
  stageFuelAtCoastEndKg, coastEndT, coastEndToPhase, coastEndExactTick; scoreMetrics short-circuit for coastEnd
  (pre-coast hard fails only, score = coastEndEcc, no crash on missing full-mission fields);
  `opts.stride` override (strideOf); cache key = context(stride) + evalKind + stride + lattice.
  Full evals also record coastEnd (so entry vs exit comparable in one run).
- emap.js (new): 8x11 grid (A 13.2-15.0, bias 0.4-1.4), MECO 52612, lead 5.525, eval {eval:'coastEnd', stride:1}.
  Prints ecc(1e-6) + log10 heatmaps, writes emap.json / emap.csv. `--e-max X` => per-A crossings (log-interp, reports
  all crossings per row = handles non-monotone band). `--from emap.json --e-max X` re-extracts with ZERO evals.
- verify-coastend.js (new): baseline full eval (raw defaults, stride 1), prints entry vs exit ecc; exit 1 if identical.
- test-evaluator.js: +4 tests (coastEnd exact tick, entry!=exit time, short-circuit/pool finalize, cache key). 31/31 pass offline.
- Finding (stub): default stride 4 catches the transition up to 3 ticks late (25.05 vs 25.0125) => stride 1 mandatory for E.

## E-map result (user run, MECO 52612, lead 5.525, 88 evals, ~70-90 s wall/eval under 6 workers)
- All 88 cells exactTick=true, no hard flags. E = 0.17 baseline matches manual => exit measurement point confirmed.
- ecc x1e-6 grid (rows A, cols bias 0.4..1.4): steep wall between A=13.97 and 14.49 (E 0.67 -> 0.002); min-E locus moves
  with A (bias ~0.5 @14.23, ~1.2 @14.74, >1.4 @15.0). Low-E basin ~0.0015-0.002 (A14.23/b0.5, A14.49/b0.8, A14.74/b1.2).
- stageFuelAtCoastEnd: ~1000-1400 kg in low-E basin, up to ~50000 kg at high E.
- Baseline manual point (A~13.94, bias 0.59) sits ON the steep wall (E~0.14-0.17) => explains knife-edge behaviour.
- Margin back to 0.001 in user config (our copy of config still 0.0001: sync it).

## E_max probe verdict (A=13.97, MECO 52612, lead 5.525 fixed, margin 0.001)
- Only bias 0.6 cleared (E 0.142): margin 126 s, deploy 722.6 s, residual 853 kg — NOT target regime (margin 4-5 s, ~590 s).
- bias 0.4/0.5 (E 0.028/0.068): payload_not_cleared (burn misfire / margin 171 s -> deploy past cap).
- bias 0.7-0.9 (E 0.26-0.48): circ_vr_too_negative (-6.7..-65 m/s), burn ends past apogee (margin ~ period).
- ROOT CAUSE = lead confound: lead 5.525 is tuned for E~0.17. Failures at other E are "lead wrong", not "E > E_max".
  => INNER-1 and INNER-2 are COUPLED at mission-success level. ORDER SWAPPED: INNER-2 first, INNER-1 calls it.
- Margin vs (bias, lead) is steeply non-linear: 0.01 bias / lead shift can move margin by 10+ s. Probe margin 126 s
  (A13.97/b0.6) vs baseline 6.73 s (A13.94/b0.59) is expected steepness, not an inconsistency.

## E_max (design)
- Two sources: physics E_max (vr too negative / orbit fail) and timing E_max (coast_wait t_to_apogee too short for a
  successful circ burn; lead reaches cap and still fails). Actual E_max = min(both). In timing-bound case keep a
  comfortable margin, do not sit on the knife edge.
- E_max is STACK-DEPENDENT (engine, payload mass, ...). Never hardcode: learned-bounds.json stores it with a stack
  signature. Long-term: new stack => calibrate E_max first, then INNER-1.
- E_max is not yet measured: needs INNER-2-tuned evals at several E (done properly only once INNER-2 runs on the real sim).

## Residual hypothesis (~849 kg regardless of A/bias at fixed MECO)
Status: NOT REFUTED, NOT CONFIRMED. Probe's 853 (A13.97/b0.6) vs baseline 849 (A13.94/b0.59) is the same point re-measured
(4 kg diff). Real test needs a successful mission at A >= 14.5. Until then do not rely on it for INNER-1 design.
Early emap support: low-E cells have ~1000-1400 kg stage fuel at coast end.

## Step 7a: hook + metric + INNER-2 (this chat)
- hook pubOrbit now exposes tToApoS and periodS. evaluator metrics: coastEndTToApoS (= lead_max), coastEndPeriodS, coastTToApoS.
  test-evaluator.js 31/31 pass (coastEndTToApoS checked vs Kepler truth in stub).
- inner2.js `tuneLead(ev, cfg, {A,bias,meco,lead?}, opts)` -> {status converged|timing-bound|physics-bound, detail, lead, metrics,
  leadMaxS, capTicks, evals, rounds, phase, anomalies, samples, log}. Full evals, stride 1. k-section over lead ticks (parallel =
  workers, 1 => bisection), cap = floor(t_to_apogee/dt)-1, signed (period-unwrapped) margin, Phase1 vr>=0 -> Phase2 vr>=hardFloor
  -> Phase3 stop when margin in [4,5] & vrEnd>=0.04 & cleared. Anomalies flagged: non-monotone, large-skip.
  test-inner2.js 15/15 pass (synthetic models) + stub e2e with real evaluator OK. NOT run on the real sim yet.
- Interpretation to confirm: timing-bound = lead at cap still on the LOW side (margin rises with lead). First target found is
  returned (not necessarily the lowest-margin one in the window).

## INNER-2 first real run (A13.94/b0.59, MECO 52612, start lead 5.525; user run: 39 evals, 9 rounds, 657 s wall)
- Result was physics-bound/vr-hardfloor @ lead 3.7 = WRONG (classifier bug), not a physical limit.
- Bug: failed burns (leads 0-4.5 s: vrEnd<0, payload not cleared, "margin" 600-1040 s) classified 'high' (sm > accHi) and became
  the bracket's hi endpoint => bracket [295,296], no interior, true mode transition (lead 4.5 -> 5.525) never sampled.
- Fix (inner2.js): vrEnd < 0 => burn ended past apogee => class 'low' (cause 'past-apogee'), margin ignored. Chosen over the proposed
  "uncleared & sm>accHi => invalid": invalid carries no information, 'low' gives the bracket its lo side; and samples at lead >= 7.5
  (uncleared, vrEnd>0, smooth rising sm/vr) are physical "lead too large, deploy past duration cap" and stay valid 'high'.
- Honest reporting: result now has windowReached, achievedMarginS and a `summary` ("window [4,5] NOT reachable at this (A, bias);
  smallest achievable margin = X s"). Sample table now classified with the FINAL phase's floor (was -Infinity => misleading).
- Data points from the run (success mode starts between lead 4.525 and 5.525): lead 5.525 -> sm 11.2, vrMin -0.338, vrEnd 0.078,
  cleared; sm slope ~1.44 s/tick, vrEnd ~0.0083 m/s/tick => sm 4.5 would sit near lead ~5.46 where vrEnd ~0.04 = the buffer:
  window may be missed by the vrEnd>=0.04 requirement alone. Re-run decides.
- tests: test-inner2.js 18/18 (adds real-run-shape mocks); NOT re-run on the real sim yet.

## Margin drift 11.2 s (INNER-2) vs 6.73 s (Step 3) at "same" A/bias — UNEXPLAINED, diag written
Known differences (computed offline): A=13.94 snaps to G0.60/T=4.820125 (Step 3: T=4.82 exactly, raw path; T has a HARD
transition at 4.820, step is 0.000125 s); lead 5.53 (raw) vs 5.525 (tick-snapped); margin metric could also differ
(circEndMarginS = post-burn orbit t_to_apo vs circEndMarginPreApoS). E matches (0.171 vs ~0.17), so ascent/stage burn agree.
Run `node tuner/diag-margin-drift.js` (4 evals) to attribute it. Until then treat absolute margin values from lattice evals
with care near T=4.820.

## Cost note (user)
INNER-2 on one (A, bias) = ~39 evals / ~11 min at 6 workers (~90 s/eval). INNER-1 x MECO outer => 15-30 h estimate.
Lead evals share the whole prefix up to COAST_WAIT entry (~520 of ~590 sim-s): a checkpoint at coastEnd is the obvious win
(Step 4 decision pending; measure wall first).

## vrEnd buffer removed (this chat)
- Reason: absolute vrEnd threshold is scale dependent (tick slope ~0.001 m/s high orbit, ~0.02 low orbit). Real constraint = vrEnd >= 0
  (sign only: ascending branch vs past-apogee). Margin [4,5] is the target itself.
- config: guided.inner2.vrEndBufferMps 0.04 -> 0 (key kept, no longer read by code); scoring.hardConstraints.circVrAtEndMinMps.min 0.04 -> 0.
- inner2.js: 'vr-end-low' branch + vrEndBuf param removed; only past-apogee remains (vrEnd < -1e-10 => low).
- tests: test-inner2.js 20/20 (+ run case vrEnd 0.0279/margin 4.010 => target; tiny-vrEnd window found); test-evaluator.js 31/31 (circVrAtEndMinMps.min == 0, 0.0279 and 0 do not hard fail).
- Expected on re-run (baseline A13.94/b0.59): converged / in-window near n=437 (lead 5.4625), margin ~4.01. NOT re-run on real sim yet.
- Stale text elsewhere in this file mentioning vrEnd>=0.04 / buffer is superseded by this section.

## A -> (G, T) collapse map (diag-a-collapse.js, pure computation, [13.5, 14.5] step 0.001)
- A_eff is monotone in A and ~A (max |A_eff - A| 3.7e-4; 0 decreases) => the collapse itself does not make A non-monotone.
- BUT the sim sees (G, T), not A_eff: T is a SAWTOOTH in A. G steps 0.01 at A = 13.591, 13.824, 14.056, 14.288 (spacing 0.232);
  inside a G segment T ramps 4.7995 -> 4.8405 (dT/dA = 1/(2GT) = 0.173 s per unit A), then snaps back by ~0.04 s at the G jump
  while A_eff barely changes (e.g. 14.0554 -> 14.0559): same A_eff, different (G, T) = the "redundant solutions" of physics insight #4.
- T quantum = 0.000723 in A; every 0.001 step of A changes Tn (1.38 quanta). Quanta per nominal A step (median): 0.01 -> 14,
  0.05 -> 69, 0.1 -> 141. G-jump inside a step window: 4% (0.01), 21% (0.05), 43% (0.1), 86% (0.2).
- T = 4.820 (hard transition) sits at A = G*4.82^2 per G segment: 13.4748 (G.58), 13.7071 (.59), 13.9394 (.60), 14.1718 (.61), 14.4041 (.62).
  Baseline: A=13.93944 -> T=4.820000; A=13.940 -> T=4.820125 (one quantum above).
- Implication for INNER-1: search in (G, T) not A: G index discrete (0.01) x T continuous within the segment (smooth, no resets);
  A_eff = G*T^2 only for reporting. Treat G-segment boundaries as potential discontinuities of E(A); the steep E wall between
  A=13.97 and 14.49 in the emap straddles two G jumps (14.056, 14.288) and part of it may be a G effect, not an A effect.

## Determinism RESOLVED (this chat) — H4 (margin constant) confirmed; sim is pure deterministic
- Reported drift: E 0.17116 vs 0.17062, lead_max 51.154 vs 52.348 at "same" inputs. Cause: STAGE_BURN_AOA_MARGIN_DEG 0.001 vs 0.0001.
  diag-determinism.js --matrix (one process, cache bypassed): margin 0.0001 -> E 0.170616 / lead_max 52.348 / coastEndT 522.425;
  margin 0.001 -> E 0.171164 / lead_max 51.154 / coastEndT 523.387 (dE 5.5e-4, dlead_max 1.19 s, dcoastEndT 0.96 s).
  Stride 1 vs 4: dE ~1e-16, dlead_max 2-5 ticks (polling lag only). Two fresh processes bit-identical (user report). H2/H3 ruled out.
- Consequences: E = f(G, T, bias, MECO | config) pure; cfg.fixed (margin) is in the cache context hash already; learned-bounds must
  store the margin. emap.csv was margin 0.001 (emap.js header comment "0.0001" is stale). Old INNER-2 results (lead 5.4375,
  margin 4.26, deploy 588.62) were margin 0.0001: algorithm validation only. Expect margin-0.001 baseline: E 0.1712, lead_max ~51.15 s.
- H1 (T 4.82 vs 4.820125 across the hard transition) still separate/open: coastEndT 524.3 (raw T=4.82) vs 523.4 (snapped 4.820125).
- INNER1-DESIGN.md rev 2 (spec only, no code): (G, T, bias) search, Level-0 E probes (coastEnd) + Level-1 INNER-2 verify,
  two-branch (L/R) bias tracing around b*(G,T), E_max learned as bracket (E_ok, E_fail) with lead-confound rule, per-G-segment T search,
  top-K finalists by full score. Open (non-blocking): Q1 side of T=4.820, Q2 branch L vs R of manual points, Q4 t_needed (placeholder 8 s).
- diag-gjump.js written (NOT run): same A_eff, G .60 vs .61 around A~14.056, compared with a same-size A shift inside one G segment.
- diag-determinism.js gained --matrix / --margin / --stride.

## Manual reference data 50000 / 55000 (this chat, user) — details in INNER1-DESIGN.md section 15
- E at COAST_WAIT entry: 52612 (G.60 b.59 lead5.53) 0.1723; 50000 (G.62 b.78 lead5.65) 0.1719; 55000 (G.60 b1.16 lead4.46) 0.1494 (not edge-hugging, +30 s).
  Hypothesis (unverified): E_max ~0.172, nearly MECO-independent; store per MECO, init bracket from previous MECO.
- Emap valid at MECO 52612 only (E at fixed (G,bias) shifts ~x4 for +4.5% MECO). Branch L/R of 50000/55000 unknown (not derivable from emap).
- Deploy gap is physical coast to apogee: Level-0 proxy deploy ~ coastEndT + coastEndTToApoS (+ calibrated offset).
- Real phase sequence COAST_ROTATE -> COAST_WAIT(0.02 s) -> COAST_ROTATE(0.01 s) -> COAST_HOLD -> CIRCULARIZE. Hook coastEnd capture verified safe
  by code reading (guard M.coastEnd === null). Not executed. inner2 cap could use floor(lead_max/dt) - 3 (not applied). Stub lacks that cycle.
- TODO config: warmStart 55000 add G 0.60.

## Step 7b: INNER-1 implementation (this chat) — DONE offline, real run pending
- inner1.js + test-inner1.js. 21/21 offline tests pass. (G, T, bias) search, Level-0 E probes + Level-1 INNER-2 verify.
- E_max learning per MECO per branch (oks/fails/inconclusive), seed from nearest MECO, `contradicted` fail-below-ok flagged not applied.
- Lead-confound rule: only timing-bound / vr-hardfloor set eFail. window-skipped/lead-floor/no-valid-burn = inconclusive.
- Timing pre-screen: coastEndTToApoS < tNeededS never calls INNER-2.
- Warm start interpolates (G, bias, lead) between manual refs (50000/52612/55000, all with G).
- verifyPoint persistent cache in learned.verifies -> idempotence.
- Driver `run-inner1.js` (next chat).
- Bug fix note: upMult 1.5 (not 1.15); 5 edits applied to inner1.js after first 21/21 attempt.
- 
## Open / next
- Run diag-gjump.js (optional check #3), then implement INNER-1 (next chat: inner1.js + test-inner1.js with synthetic E models).
- Step 4: checkpoint feasibility (measure WALL speedup first). Deferred; decide after Step 7 eval counts.
- Step 7: INNER-1 boundary tracer uses emap output (per-A crossings) as warm start.
- Note: hard-flagged cells (maxQ/maxG) still report ecc; the mapper does not drop them.
