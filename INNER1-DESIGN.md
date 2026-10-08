# INNER-1 design — (A, bias) boundary search (spec only, no code)

Status: DRAFT for review. Inputs used: PROMPT.md v2, STATE.md, emap.csv (88 cells), diag-a-collapse, inner2.js.
Revision 2: HANDOFF.md, emap.js, runner.js now read; determinism resolved (H4); Q3 resolved.

---

## 1. What INNER-1 must deliver

For a given MECO, return the (G, T, bias) + lead (from INNER-2) such that:
1. Mission succeeds with orbit inside tolerance and margin window [4, 5] s reached (INNER-2 `windowReached`).
2. E (coast-end eccentricity) is as close to E_max as possible (aggressive end of the band).
3. Among such points, A_eff is smallest (PROMPT priority), then best full score (fuel, deploy time).

Output: ranked list of feasible boundary candidates (not one point), each with INNER-2 result attached. The final pick is by full-mission score (see 8), because "min A" is a heuristic for "fast", not the real objective.

## 2. Search space: (G index, T, bias), NOT A

Facts from diag-a-collapse: the sim sees (G, T). G is discrete (0.01 deg), T is continuous within a G segment and ramps ~4.7995 -> 4.8405, then snaps back at the G jump (A_eff almost unchanged). So A is a sawtooth coordinate and "redundant solutions" are just different G segments.

Design:
- Coordinates: `g` (integer cd), `Tn` (integer, quantum 0.000125 s), `bias` (integer, quantum 0.0001).
- A_eff = G*T^2 is a derived, report/sort key only. INNER-1 never feeds A back into a search.
- Smoothness assumption (to be verified, not assumed silently): within one G segment E(T, bias) is smooth except at the T = 4.820 hard transition. Treat T = 4.820 as an explicit discontinuity inside segment G=0.60 (and for other G the segment simply may not contain 4.820 because T range 4.80-4.84 does; each G segment contains 4.820 at A = G*4.82^2, so every segment has this transition).
- Each (G segment) is searched independently; segments are compared only at the end via A_eff / score. A G jump is never bisected across.
- The T = 4.820 transition splits each segment into two sub-segments (T < 4.820, T >= 4.820 in the sim's sense; exact side rule must be confirmed by one probe pair at Tn = 4.82/0.000125 +-1).

## 3. Cheap measurement vs expensive verification

Costs (user): coastEnd eval ~70-90 s (1 eval, stops at COAST_WAIT entry); INNER-2 on one point ~39 evals / ~11 min (6 workers). So:

- **Level 0 (E probe)**: `eval:'coastEnd', stride:1` -> E, coastEndTToApoS (timing info), stageFuelAtCoastEnd. 6 probes per round in parallel.
- **Level 1 (verify)**: `tuneLead` only on a few finalists. INNER-2 is never called inside a bisection loop.

Pre-screens at level 0 (reject without INNER-2):
- coastEndTToApoS < t_needed (lead required ~5.4 s + engine startup + safety). t_needed is learned: initial value from baseline (lead 5.44-5.53). Reject = "timing-infeasible".
- hard flags (maxQ, maxG, crashed).
- E > E_hi_known_fail (a lower bound on E that has already failed INNER-2 on the SAME branch and same segment).

## 4. Shape of E(bias) at fixed (G, T) — from emap.csv

Observed rows (MECO 52612, lead 5.525):
- A=13.97 (G.60): E rises monotonically with bias over 0.4-1.4 (0.027 -> 0.67).
- A=14.23 (G.61): V-shape, min E 0.0015 at bias 0.5; both sides rise (0.0030 @0.4, 0.41 @1.4).
- A=14.49 (G.62): V, min 0.0020 at bias 0.8.
- A=14.74 (G.63): V, min 0.0024 at bias 1.2.
- A=15.0 (G.65): monotone falling toward bias 1.4 (min beyond range).
- G.57-.59 rows (A<13.8): E 0.6-0.85, no feasible look at all.

So at fixed (G,T) E(bias) is unimodal: a left branch (bias < b*, E falls as bias rises) and a right branch (bias > b*, E rises). E = E_max has up to TWO crossings per (G,T): b_L < b* < b_R. That is the "outer / inner region" of insight #3. Rows without a minimum in range have 1 crossing only (A=13.97: right branch only; A=15.0: left branch only).

Branch id is stored with every candidate: `L` (dE/dbias < 0) or `R` (dE/dbias > 0). Never mix the branches in one bisection.

Tracer must not assume which branch contains the fast solution; it traces both and the final score decides. (Open question Q2.)

## 5. Bias search at a fixed (G, T): "find the E_target crossing"

Goal: find bias_b on each branch such that INNER-2 succeeds and E is just below E_max (largest feasible E on that branch).

Step A — locate b* (minimum of E): coarse scan of 6 biases (parallel, one round) over [lo, hi] then golden/parabolic refinement in log E. Reuse neighbouring segments' b* as a warm start (b* moves smoothly with A: ~0.5 @14.23, 0.8 @14.49, 1.2 @14.74). Skip if monotone (no interior min) -> only one branch.

Step B — per branch, find the largest feasible E:
1. Hybrid bracketing in bias with the PROMPT step ladder 0.5 -> 0.1 -> 0.05 -> 0.01 -> 0.001 -> 0.0001, but the *evaluation* in the early levels is Level-0 (E only) and the *decision* uses E, not mission success: target E_t (current E_max estimate, minus a safety margin that shrinks).
2. Because E(bias) is smooth and monotone on a branch, replace pure bisection by secant/regula-falsi in log E on the lattice (reaches 1e-4 in ~4-5 rounds instead of ~12 bisection levels). k-section with 6 workers: each round evaluates 6 biases (pure bracket reduction as fallback if secant misbehaves).
3. Final lattice neighbour set (bias_b-2..+2 ticks of 1e-4, 5 points) -> Level-0 E; pick the largest E <= E_t.
4. Level-1 verify: `tuneLead` at the chosen point. Outcome: `ok` (windowReached), `window-skipped` (margin > accHi: lead too coarse, treat as feasible-with-penalty), `timing-bound`, `physics-bound`.
5. Feasibility feedback on E (this is the E_max learning loop, section 6): ok -> E_ok = E, raise E_t toward E_fail; fail -> E_fail = E, lower E_t.

Bias extreme (bound -2 / 2.5): branch has no crossing -> mark segment "branch absent"; do not wander (replaces the PROMPT "bias extreme => change A" with an explicit segment-level record).

Bias lattice 1e-4: E changes by ~1e-5..1e-3 per 1e-4 at the wall rows, so the fine lattice is real. Expect last-mile (+-1..2 ticks) to be done by Level-0 + local check, not by bisection.

## 6. E_max as a learned, stack-dependent, MECO-dependent bound

E_max = min(E_phys, E_timing). Not measured yet. INNER-1 learns it, stored in learned-bounds.json with stack signature (+ MECO, margin constant, target alt).

State: `E_ok` (largest E with INNER-2 success), `E_fail` (smallest E with INNER-2 failure on the SAME branch and a comparable segment). E_max in (E_ok, E_fail]. Learning is bracket + bisection in E-space, but the probes are driven by the bias search above, so E_max learning and boundary tracing are one loop.

Caveat from STATE: failures at other E can be "lead wrong", not "E too big". Rule: a failure only counts toward E_fail if INNER-2 returned `timing-bound`, or `physics-bound` with a genuine vr-hardfloor after Phase 2. `window-skipped` and `no-valid-burn` do NOT set E_fail (inconclusive: record, retry at a neighbouring tick/bias). This prevents learning a false E_max from lead-confounded failures.

Start: E_ok = 0.171 (baseline A13.94/b0.59, margin 0.001: E = 0.171164, lead_max = 51.154 s, matrix run; the 0.1706 / 52.348 s numbers belong to margin 0.0001 and are NOT used). First E_t = 0.17*1.5 ... exact multipliers in config (`guided.inner1.eMaxGrowth`). Timing E_max comes out of the t_needed rule: timing-bound is detected at Level 0 via coastEndTToApoS vs t_needed (no INNER-2 required) -> cheap and exact.

Timing-bound vs knife-edge: keep a comfortable margin (PROMPT insight #5): final E_t = E_max_est - safety, safety = config (default 5% of E).

## 7. A search (G/T aware)

Per G segment s (cd index):
1. Sub-segments split at T = 4.820.
2. Along T (increasing A within segment) E_min(T) = E(b*(T), T) is smooth; feasibility of ANY bias requires E_min(T) <= E_max. So the set of T where a boundary exists is an interval (assumption). Find the smallest T_s with a boundary by:
   - coarse: T step ~0.005 s (~16 A-units... exact map: dA = 2GT dT = ~5.8*dT) -> 6 parallel Level-0 probes at b*(T) estimate;
   - refine by bisection on "E_min(T) <= E_t" down to 1 quantum (0.000125 s), Level-0 only. Cost per segment: ~3-4 rounds.
3. Candidate list per segment: lowest-T boundary point on each branch (L, R) + the T=4.820 neighbours if they straddle a discontinuity.
4. Verify finalists with INNER-2 (section 5.4).
5. Segments are processed in order of increasing G starting at the segment that contains the baseline (G.60) and walking down to lower G only while E_min(T_max of segment) <= E_t (emap: G <= .59 never feasible -> stop early, cheap since a single Level-0 row proves it).
6. Global answer = min A_eff among verified boundary candidates; keep the top K (config, default 3) with different (segment, branch) for the final full-score comparison.

Walking *up* in G is also required: A min is the PROMPT priority, but the real score may prefer larger G (e.g. segments .61-.63 have b* in 0.5-1.2 with much lower E: they sit far from E_max, i.e. "slow but safe"). Rule: search only segments whose E_min <= E_max (boundary exists) and A_eff <= A_best_verified + dA_window (config). Beyond that window skip (they cannot beat min-A by definition).

## 8. Final selection and polish hand-off

Candidates (K) -> one FULL mission eval each (INNER-2 already produced it) -> score via existing scoreMetrics (orbit HIGH, fuel MED, time LOW; hierarchy test already exists). Best score wins; ties by smaller A_eff.
Polish (Step 8): lattice pattern-search around the winner: G step 0.01 (the segment jump!), Tn +-1, bias +-1 tick, lead +-1 tick. Each polish move goes through `tuneLead` only if bias/T moved.

## 9. MECO outer interplay

INNER-1 output depends on MECO. Warm start = nearest of reference points {50000: G.62/b.78/L5.65, 52612: G.60/b.59/L5.53, 55000: b1.16/L4.46} via linear interpolation in MECO of (bias, lead); G interpolated then snapped. Since trend "MECO up => bias up => lead down": start bias bracket around the predicted value with half-width = 0.3 and let the L/R branch classifier tell which branch the prediction lands on. When the MECO outer loop moves by delta_MECO <= ~200 kg, reuse previous E_max estimate and previous b*(segment); re-verify only the finalists (saves most of the 15-30 h).

## 10. Eval budget (estimates, 6 workers, ~90 s/eval Level-0 round of 6 probes = 90 s; INNER-2 = 11 min)

| item | rounds | wall |
|---|---|---|
| b* location, 1 segment | 2 | 3 min |
| each branch crossing (secant, 1e-4) | 4-5 | 7 min |
| segment T-search | 3-4 | 6 min |
| INNER-2 verify, per finalist | 1 | 11 min |
| E_max learning (shared) | overlaps | ~0 extra |
Per MECO: ~3 segments x (3+14+6) min + ~6 finalists x 11 = ~2.3 h first MECO, ~1 h warm. Checkpoint at coastEnd would cut Level-1 (INNER-2 shares ~520 of 590 sim-s) by ~5-8x; decide after the first INNER-1 run measures the real split (Step 4 stays deferred).

## 11. Failure modes and anomaly reporting

- Non-unimodal E(bias) (second local min): log `anomaly: multimodal`, switch the segment to a dense 6-point scan.
- Discontinuity in E_min(T) larger than expected (outside T=4.820): log, split the sub-segment there.
- INNER-2 `window-skipped` at the best candidate: feasible but lead coarse; take it only as fallback.
- Level-0/Level-1 disagreement (E measured at level-1 != level-0 for same lattice point): hard error — this is exactly the determinism question (section 12).
- No feasible point at all: report E_min per segment table and stop (no silent expansion).

## 12. Determinism prerequisite

INNER-1 relies on E being a pure function of the lattice point (cache keys, bracket logic, Level-0/Level-1 consistency). The reported drift E=0.17116 vs 0.17062 at (nominally) the same inputs must be explained first. Hypotheses to separate (diag-determinism.js):
H1 different effective inputs (raw T=4.82 vs snapped T=4.820125 across the hard transition; lead 5.53 vs 5.525);
H2 sim state leaks between evals in one process (guide config/_v3Config keys not covered by resetGuideConfig, order dependence);
H3 genuine non-determinism across fresh processes;
H4 STAGE_BURN_AOA_MARGIN_DEG differed between the two runs (0.0001 vs 0.001).

**RESOLVED (user ran diag-determinism.js --matrix, same process, cache bypassed):**
| margin | stride | E | lead_max (s) | coastEndT (s) |
|---|---|---|---|---|
| 0.0001 | 1 | 0.17061572200464811 | 52.348357 | 522.425 |
| 0.0001 | 4 | 0.17061572200464795 | 52.323357 | |
| 0.001 | 1 | 0.17116412023042205 | 51.153653 | 523.387 |
| 0.001 | 4 | 0.17116412023042210 | 51.091153 | |
- H4 confirmed: margin alone moves E by 5.5e-4, lead_max by 1.19 s, coastEndT by 0.96 s (the whole drift).
- Stride changes E by ~1e-16 (noise) and lead_max by 2-5 ticks (polling lag): irrelevant for E, but stride 1 stays mandatory for lead_max (cap) accuracy.
- Two fresh processes: bit-identical (user report). H2 / H3 ruled out. E = f(G, T, bias, MECO | config) is a pure function.
- H1 (T 4.82 vs 4.820125 across the hard transition) is a separate, still-open input effect (see diag-gjump.js / Q1). The user's note: coastEndT 524.3 at raw T=4.82 (verify-coastend) vs 523.4 at snapped T=4.820125 suggests T across 4.820 shifts timing by ~1 s.
- Consequence: the config signature (`fixed`, incl. margin) must be part of every cache key / learned-bounds entry (already true: contextHash hashes cfg.fixed). Old INNER-2 numbers (lead 5.4375, margin 4.26, deploy 588.62) used margin 0.0001: algorithm-validation only.

## 13. Tests to write with the implementation (offline, synthetic like test-inner2)

- Synthetic E(bias,T) model with V-shape, G jumps, T=4.820 step; INNER-1 must find min-A feasible boundary, both branches, with eval counts below the budget.
- Lead-confounded failure (window-skipped) must not lower E_max.
- Warm start across MECO.
- Idempotence with cache (second call 0 new evals).

## 14. Open questions (need user input)

Q1. Which side of the T=4.820 transition is the "good" side for each G (does the hard transition shift feasibility)?
Q2. PARTLY ANSWERED (section 15): baseline (G.60, b.59) is on branch R at MECO 52612 (emap row G.60 rises with bias). The branch of the 50000 / 55000 manual points CANNOT be read from the emap (E landscape shifts with MECO), so it stays unknown; the tracer finds it with Level-0 scans.
Q3. RESOLVED (user): the emap.csv run used margin 0.001 (the emap.js header comment "locked = 0.0001" is stale). emap and future INNER-1 runs are consistent; the old INNER-2 results (margin 0.0001) are algorithm-validation only.
Q4. t_needed (minimum coastEndTToApoS for a feasible burn): STILL OPEN. Data point: at the baseline lead_max = 51.2 s while the needed lead is only ~5.5 s, so the timing bound is far away for E ~ 0.17 and only bites at much larger E. Proposal: t_needed = needed lead of the best verified point + engine startupDurationS + 1 s; placeholder `guided.inner1.tNeededS` = 8.0 (to be confirmed), used only as a Level-0 pre-screen, never as a final verdict (INNER-2 `timing-bound` is the verdict).

## 15. Manual reference points (rev 3, user data)

| MECO | G | bias | lead | coast_rot dur (s) | DONE (s) | E at COAST_WAIT entry |
|---|---|---|---|---|---|---|
| 52612 (baseline) | .60 | .59 | 5.53 | ~19.2 | 590.46 | 0.1723 |
| 50000 | .62 | .78 | 5.65 | 19.91 | 593.37 | 0.1719 |
| 55000 | .60 | 1.16 | 4.46 | 22.70 | 620.18 | 0.1494 |
E = (apo - peri)/(apo + peri + 2R) with apo/peri as altitudes (formula re-checked: 50000 -> 0.1719, 55000 -> 0.1494). User's baseline 0.1723 vs hook 0.1712 (margin 0.001, snapped T): small gap, the manual number is a hand read-out; do not treat as a determinism problem.

1. **E_max prior.** Two independently hand-tuned MECOs (52612, 50000) land at E = 0.172 (0.2% apart); 55000 sits lower (0.149) and is not edge-hugging (+30 s deploy). Hypothesis (UNVERIFIED): E_max is nearly MECO-independent, ~0.172. Use: store E_max per MECO (as the user recommends) but initialise each new MECO's bracket from the previous MECO's (E_ok, E_fail), so the first INNER-2 verify at E_t ~ 0.17 either confirms it (then probe upward) or fails (then bracket downward). Never treat 0.172 as a hard constant.
2. **The emap does not transfer across MECO.** At MECO 50000, (G.62, b.78) has E = 0.172 while the MECO-52612 emap gives ~0.002 there; at MECO 55000, (G.60, b1.16) has E = 0.149 while the emap gives 0.62. So: emap = warm start for MECO 52612 only; other MECOs start from the manual seeds above and Level-0 scans. Branch labels (L/R) come only from live Level-0 scans.
3. **Section 9 correction.** "Reuse previous b*" across MECO steps is unsafe: dE/dMECO is large (4.5% MECO change moves E at fixed (G, bias) by a factor ~4). At every MECO step re-run the b* locate (about 2 Level-0 rounds) and only reuse the E_max bracket.
4. **Deploy time is mostly physical coast.** The 50000 vs 55000 gap (+26.8 s deploy) sits between COAST_WAIT and CIRCULARIZE (+31.5 s): the stage coasts to apogee. That is `coastEndTToApoS` plus the coast-end time, both available from a Level-0 eval. Use `coastEndT + coastEndTToApoS` as a Level-0 deploy-time proxy to rank candidates before INNER-2 (the offset to the true deploy time is calibrated from each verified point; do not hardcode it).
5. **Real phase sequence** (user): COAST_ROTATE -> COAST_WAIT (~0.02 s) -> COAST_ROTATE (~0.01 s) -> COAST_HOLD -> CIRCULARIZE. Hook check (hook-sandbox.js poll): `coastEnd` is captured at the first COAST_ROTATE -> next-phase transition only (guard `M.coastEnd === null`); the second COAST_ROTATE -> COAST_HOLD does not recapture, `M.coast` / `phaseT` use first-seen guards. Safe. Consequences: (a) with stride 4 the transient COAST_WAIT can be missed, so `coastEndToPhase` may read COAST_HOLD and `exactTick` false (E unaffected: coast, E constant to 1e-16, matches the matrix); stride 1 stays mandatory; (b) `lead_max` is measured ~0.03 s (2-3 ticks) before COAST_HOLD entry, where the circ trigger is evaluated, so inner2's cap `floor(lead_max/dt) - 1` can sit 1-2 ticks above the true cap: harmless (identical plateau samples) but cap = floor(lead_max/dt) - 3 is cleaner (candidate tweak for inner2.js, not applied). (c) The stub guidance in test-evaluator.js has no COAST_WAIT -> COAST_ROTATE cycle; add one to the stub to lock (a)/(b).
6. Coast-rotation duration depends on (G, bias): 19.2 / 19.9 / 22.7 s. It shifts coastEndT and therefore deploy time; the proxy in (4) includes it automatically.
7. Config: warmStart for MECO 55000 should carry G 0.60 (currently missing in tuner-config-v3.json).

## Status

Revision 3. Determinism resolved (section 12). Open, non-blocking: Q1, Q2, Q4 (safe defaults above, all logged by the tracer). Optional check #3 (G jump at A~14.0558, same A_eff, different (G, T)) = `diag-gjump.js`; its result decides whether G segments are searched independently (jump = real discontinuity, current design) or can be merged along A_eff.

## Notes

HANDOFF.md, emap.js, runner.js were read in revision 2. The real sim (js/*) is not in this workspace; nothing was executed here. runner.js: resetGuideConfig restores only keys present in the pristine Guidance.getGuideConfig snapshot; guidance state outside that config is not reset by runSim (the matrix shows no leak for the tested sequence).
