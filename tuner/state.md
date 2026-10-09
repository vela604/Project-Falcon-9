# state.md — Browser Param Tuner (leoInsertionV3)

> Naye chat me ye file + `multi-step-project.md` + "Next step" ki Attach list paste karo. Ye file akeli bhi project samjhane ke liye kaafi hai. Har step ke end pe isko regenerate karo.

## 1. Current status
- **Step 5 ✅** (user-confirmed). Config fix done: `limits.marginTargetS = [3.5, 5.5]`.
- **Last finished:** Step 6 code delivered — `TunerCore.tuneAB` in `tuner-core.js` + html button `Tune (A,bias) + lead (baseline)` (mode select + eMax input) + config keys. Mock-tested in node (`test-tuneAB-mock.js`, synthetic E model, ALL PASS); **real sim pe abhi chala nahi**.
- **Step 6 fix (this chat):** real log analysed -> dirOf fixed, climbE rewritten, relearn reuses visited points, mock refitted to real surface (ALL PASS). See section 13. **Real re-run pending.**
- **Next (user):** page me mode=`fine`, eMax=0.20 pe `Tune (A,bias) + lead (baseline)` dabao; poora log paste karo (AB# lines, verify lines, `=== tuneAB RESULT`, candidates, baseline-vs-best line). Phir Step 6 ✅ -> Step 7.
- **Next step after verify:** Step 7 — Phase A `findOptimalMeco()` (outer loop, residual 0–50 kg). Attach: `state.md`, `multi-step-project.md`, `prompt-web.md`, `tuner/` saari files (html, config, engine, utils, hook, core) + tuneAB log.

## 2. Project in 10 lines
- User = SEHRAN. Falcon 9 Block 5 browser simulator (physics/guidance/render workers). Guidance = `leoInsertionV3`, target 320 km circular LEO.
- Purpose: manual tuning heuristic ko **browser tool** me automate karna (`tuner/leoV3-Param-S-idea.html`, multi-file, no build step). Headless Node tuner (inner1.js/inner2.js) 6x slow + over-engineered tha (~900 evals/MECO iteration vs manual ~12–15).
- Engine = `guidance-numerical.html` ka sim loop reuse (~4500 ticks/s). `js/*` copy/modify nahi; sirf `tuner/` naya.
- Sim bit-identical deterministic; same input = same output.
- Tunables (4): **(G, T)** [A = G·T²], **bias**, **lead**, **MECO**.
- Flow: **Phase A** (MECO=52612 se heuristic → optimal MECO, residual 0–50 kg) → **Phase B** (E-range sweep at that MECO, har E pe tune, score, rank).
- Output: rank-wise expandable blocks + Copy/Download JSON (`Guidance.applyGuideConfig` format).

## 3. Files (tuner/)
| file | role | status |
|---|---|---|
| leoV3-Param-S-idea.html | UI shell + script tags (`../js/...`), boot, smoke test, log, eval buttons (stopAt select, snapped/raw, determinism x2, Ref points E, abort). stopAt is captured at eval start | Step 1/3/4 done, verified |
| tuner-engine.js | engine glue 1:1 from guidance-numerical.html. `TunerEngine.{init, prepareRun, tick, smokeTest, buildSnapshot, localDispatch, applyEnvironment(envObj), applyFueling(envObj)}` | Step 1 done |
| tuner-config.js | `TunerConfig`: quanta, bounds, baseline, references, limits, scoring, modes, env (no logic) | Step 1 done (modes first-cut) |
| tuner-utils.js | `TunerUtils`: lattice point {Gi,Tn,bi,li,meco} ints; `fromRaw, collapseA, aEff, step, key, inBounds, toValues(p,{targetAltKm}), describe, verifyApplied(p,cfg), EvalCache(p,stopAt), checkHard, score(m)->{score,ok,reasons,parts}, runSelfTests` | Step 2 done |
| tuner-hook.js | `TunerHook.runEval(point,opts)` / `runEvalValues(values,opts)` async; `opts`: stopAt (COAST_WAIT_ENTRY\|CIRC_END\|DEPLOY\|FULL), env, durationCapS, abortRef, abortOnStageVrNeg (default true only for COAST_WAIT_ENTRY), onProgress, quiet. Returns metrics (below). Singleton guard (one eval at a time). `findStage`, `gLoad` (headless 1:1) inside | Step 3/4 done, **verified on real sim** |
| tuner-core.js | `TunerCore.tuneLead(point, opts)` (Step 5 ✅), `TunerCore.tuneAB(point, opts)` (Step 6, mock-tested, real run pending); findOptimalMeco, sweepE pending. Both accept `opts.hook` (inject mock for node tests; default `TunerHook`) | Step 5 ✅, Step 6 code done; 7-8 pending |
| test-tuneAB-mock.js | node test (not loaded by html): `node test-tuneAB-mock.js` needs tuner-config/utils/core in same dir | Step 6 |
| tuner-ui.js | inputs, progress, ranked blocks, JSON | Step 9 |
Delivered as separate files in `/mnt/user-data/outputs/tuner/` (no zip).

## 4. Invariants (MAT TODO)
- Tick: engine file ke actual code me `physicsStep(dt) → buildSnapshot() → Guidance.onSnapshot(snap)` (see Locked decisions #1 — header comment ulta bolta hai).
- `buildSnapshot()` me har tick `b.ax/b.ay` set + `b.pods = buildPodEntries(b)` zaroori (RCS guidance).
- `Derivation.setStackData(collectStackData())` ek baar, page load pe, guide start se pehle.
- Run init order: `Guidance.applyGuideConfig` → `resetState(0)` → `applyEnvironment()` → `applyFueling()` → `Guidance.stopGuide()` → `Guidance.startGuide(name)`.
- Har eval me **poora** config (tunables + fixed) bhejo (`_v3Config` runs ke beech persist karta hai). `Deorbit` always off (`done.DEORBIT_ENABLED=false`). MECO fuel-triggered.
- Script load order = `guidance-numerical.html` ke SIM_FILES jaisa; library-cache patch (`loadComponentLibrary`) rakho.
- `quiet`: console spam nahi. Sim sirf lattice-snapped values dekhe; `getGuideConfig()` se verify.

## 5. Quanta (lattice)
G 0.01 deg · T 0.000125 s (integer Tn) · bias 0.0001 deg · lead 0.0125 s (1 tick, integer) · MECO 1 kg. Search `(G_index, Tn)` me, A me nahi. Collapse: `G=round(A/T0²/0.01)·0.01 → T=round(√(A/G)/0.000125)·0.000125 → A_eff=G·T²`. Anchor T0=4.82.

## 6. Heuristic (condensed)
- E = eccentricity at COAST_ROTATE exit (COAST_WAIT first tick). E=f(A,bias) joint 2D; band non-monotone. Target = E_max ke strictly neeche.
- A high/bias high = gentle; A low/bias low = aggressive. Fail1 vr<0 before apogee → gentle. Fail2 no apogee 320 km or E>E_max → aggressive. Fail3 corner → A relax, bias reset.
- INNER-1: hard-lower check → G neeche 1 gimbal steps (back off 1 step on E>E_max / vr<0) → bias ladder ±0.5→0.1→0.05→0.01 (→0.001→0.0001) → bias extreme (−2 / 2.5) → A relax + bias reset.
- INNER-2 (lead): Phase1 lead ghatao bina negative vr (~6–7 s margin pe stuck) → Phase2 negative vr allow, margin 4–5 s, vrEnd +0.02–0.05 buffer, vrMin ≥ −2 (hard floor).
- MECO outer: residual>50 → MECO↑; <0/fail → MECO↓; steps 3000–5000→1000→200; warm start; trend MECO↑⇒bias↑⇒lead↓.
- Reference pts: MECO 50000 (G .62, bias .78, lead 5.65) · 52612 (G .60, bias .59, lead 5.53) · 55000 (G .60, bias 1.16, lead 4.46).
- Baseline (raw): deploy 590.46 s, apo/peri 320.111/319.999, vrEnd 0.046, vrMin −0.380, margin 6.73 s, maxQ ~24.75 kPa, maxG ~4.815.
- Scoring (lower better): apo/peri tol 1 km w 3000; ecc tol 0.0005 scale 0.001 w 1500; booster fuel +0.01/kg; time 0.0005/s. Hard: maxQ ≤ 31 kPa, maxG ≤ 6.02, no crash, vrEnd ≥ 0, payload released/cleared, durationCap 770 s.
- Accuracy modes: Fast (G 5 steps, bias .05, lead 5–10 ticks, T 5 q, N=5, ~2–3 min) · Fine (G 1–2, bias .01, lead 2–4, T 1–2 q, N=8, ~5–8 min) · Accurate (all 1 quantum, N=12 adaptive, ~15–25 min).
- Future: `runEval(values)` async + clean abstraction → later worker pool (no design decision now).

## 7. Locked decisions (user-confirmed unless marked)
1. Tick order = actual loop code in guidance-numerical.html: `physicsStep -> buildSnapshot -> Guidance.onSnapshot`. Header comment ignore (user: "code fast hai, comment choro"). runner.js ki zaroorat nahi (headless slow tha).
2. `STAGE_BURN_AOA_MARGIN_DEG` **fixed 0.001** (guideConfigDefaults.js bhi 0.001). Tunable nahi. Bias 4 decimals (0.0001) tak tune hoga.
3. E sweep default 0.25–0.35 (user ne rakha). **Manual-best E = 0.171 (user-confirmed)**; config `ecc.manualBestE`. E_min/E_max `null` — Step 4 me calibrate. NOTE: sweep range manual-best se upar hai; E_max < 0.25 nikla to sweep range badalna padega.
4. JSON nesting (confirmed "haan"): `{ ascent:{PUSH_MAX_GIMBAL_DEG, PUSH_T_S, MECO_TARGET_BOOSTER_FUEL_KG}, insertion:{STAGE_BURN_AOA_BIAS_DEG, CIRC_TRIGGER_LEAD_S, ...} }`. `applyGuideConfig` shallow-merges per top-level section, so partial sections OK.
5. Lead search (INNER-2) pehle banta hai, INNER-1 usko call karta hai (PROMPT.md correction); user-facing flow wahi.
6. `__tickDump` tuner me nahi (overhead); metrics hook se.
7. Target device: pehle **phone** (Chrome / SPCK inbuilt browser, plain JS, Termux se koi lena-dena nahi). Phone pe ~4k ticks/s single-thread. Baad me PC (Ryzen 9 + RTX 5090) + worker pool — abhi design decision nahi, sirf clean async `runEval`.
8. Delivery: files alag, zip nahi; `js/*` untouched.

## 8. Open questions
1. Self-tests + Apply+verify browser me pass? (node me pass hue; browser me user ne eval runs se indirectly confirm kiya — explicit button run pending, minor.)
2. E_min/E_max actual values — needs the 3 reference-point runs (button added). Baseline E = 0.172278. Sweep default 0.25-0.35 is ABOVE manual-best E (~0.171-0.172): decide in Step 8 (change sweep default or confirm intent).
3. (resolved) margin slope vs lead is ~28 s/s (user, headless INNER-2: lead 5.53 -> 6.72 s, 5.4375 -> 4.26 s), ~0.35 s per tick; expected tuned lead ~5.44-5.46, target margin band [4,5] s unchanged.
4. `guidance-blocks.js` not needed so far (E and margins computed in hook).

## Metrics returned by runEval (current, Step 4)
endReason (COAST_WAIT_ENTRY/CIRC_END/DEPLOY/CLEARED/CRASHED/HALTED/CAP/STAGE_VR_NEG/ABORTED), ticks, simTimeEnd, wallMs, ticksPerSecond.
(A,bias): `eCoast` (osculating e at first COAST_WAIT tick), apoCoastKm, periCoastKm, tToApoCoastS, altCoastKm, vrCoast, vtCoast, coastEntryT, vrMinStageBurn, stageVrNeg(+AltKm,T).
Circ: `vrMin` (CIRCULARIZE entry -> engines off), **`vrEnd`/`marginS` = engines-off tick (matches manual 0.046 / 6.73 s; vrEnd used by score/checkHard). `marginS` is SIGNED since Step 5: vr<0 at engOff (ended past apogee) => marginS = tToApo - period (negative); raw wrapped value in `marginRawS`, `periodEndS` also exposed**, `vrEndAch`/`marginAch` = circAchieved tick (diagnostic only; vrEndAch is negative, margin garbage), circStartT, circAchievedT, circEngOffT.
Mission: deployTimeS (= guide deployCommandSimTime), mecoTimeS, boosterFuelLeftKg (booster body fuel at splitDetected, via findBooster), **stageResidualKg / stageFuelAtDeployKg via `findStage`** (members[0].stageRole==='stage', fallback bodies[0]; NOT activeBodyIndex — that is payload after release), apogeeKm/perigeeKm/ecc (payload body orbit at end), payloadReleased/Cleared, crashed.
Limits: maxQKPa (active body, alt<100 km). **maxG = headless `gLoad` 1:1 on `state.bodies[0]`, every tick, whole run**: |thrust vector (gimbal) + drag| / ((dryMass+fuelMass)*g0). Diagnostics: maxGPhase, maxGT, maxGPre (before COAST_WAIT), maxGAccel (active-body |_lastAccel|, NOT used for score; differs because active body = payload after split).
Perf notes: phase polled via getGuideStatus every tick except sparse (every 16) in ASCENT/COAST_WAIT; console.log muted during evals; yield via MessageChannel every ~40 ms. Determinism check compares flat fields with Object.is -> never add object/array fields to metrics.

## Known facts from guidance.js (Step 1 recon)
- Phases: ASCENT, MECO_SPOOL, SEPARATED_AXIAL, STAGE_BURN, RCS_BOOST, COAST_ROTATE, COAST_WAIT, COAST_HOLD, CIRCULARIZE, COAST_ROTATE_2, COAST_HOLD_2, DONE (+ SUICIDE_* ignored, deorbit off).
- `Guidance.getGuideStatus()` -> `phase`, `altKm`, `apogeeKm`, `perigeeKm`, `circAchieved`, `circCurrentV/TargetV`, `coastTRem`, `coastDeltaV`, `deployCommandSimTime`, `payloadCleared`, `circTriggerLeadS`, `splitDetected`, `mecoTriggered`.
- E at COAST_WAIT first tick = first tick where `phase === 'COAST_WAIT'`; compute from active body state.
- Payload orbit (mission-graded) = body with `payloadBody` flag (stage cut ~3 m/s short on purpose).
- `Guidance.applyGuideConfig('leoInsertionV3', values)`/`getGuideConfig` exist; `_v3Config` persists across runs -> har eval pe full set bhejo.
- DT = 1/80 s (config.js).

## 9. Log
- Step 0: files review, gaps listed, plan + state.md created.
- Step 1: tuner-engine.js (1:1 extract, env/fueling now take plain objects), tuner-config.js, shell html with boot + smoke test created. Syntax-checked with node; browser run pending.
- Step 2: tuner-utils.js created. Metrics contract for score(): crashed, payloadReleased, payloadCleared, vrEnd, vrMin, maxQKPa, maxG, apogeeKm, perigeeKm, ecc, boosterFuelLeftKg, deployTimeS. Hard fail => 1e6 + depth*1000 (graded). Orbit terms = deadzone (tol 1 km / 0.0005), fuel -0.01/kg, time +0.0005/s, vrMin soft 0.01/(m/s). Hierarchy tests pass (orbit > fuel > time).
- Step 3: tuner-hook.js created (+ HTML buttons: stopAt select, Eval snapped/raw, Determinism x2, Abort). Phase flow facts: STAGE_BURN -> RCS_BOOST -> COAST_ROTATE -> COAST_WAIT (first) -> COAST_ROTATE (2nd, at t_rem<=90 s) -> COAST_HOLD -> CIRCULARIZE (t_rem <= engine startup + CIRC_TRIGGER_LEAD_S) -> COAST_ROTATE_2 -> COAST_HOLD_2 -> DONE (release at apogee peak) -> payloadCleared.
- Step 4: user ran 4 evals + determinism. Found/fixed: (a) stage fuel read from payload body (0.0) -> `findStage`; (b) maxG: active-body accel 5.300 vs manual 4.815 -> headless gLoad copied 1:1 on bodies[0], now 4.815 exact (peak @CIRCULARIZE t=572.8 s, preCoast 4.373; manual was whole-run max too, 6.02 limit = 4.815*1.25); (c) vrEnd/margin switched to engines-off values; (d) html stopAt label bug (select changed mid-run). Added `Ref points E` button.

## 10. Step 4 results (baseline, raw == snapped, bit-identical x2)
```
stageResidual=848.7  vrEnd(engOff)=0.0460  margin=6.72  vrMin=-0.380  maxG=4.815  maxQ=24.75
apo/peri=320.111/319.999  ecc=8.32e-6  deploy=590.46  meco@134.81  boosterFuel=52625
E@COAST_WAIT=0.172278  apo/peri@coast=320.00/-1646.62  tToApo=49.7 s  alt@coast=318.10  stage vrMin=116.361
```
- Speed: FULL ~47432 ticks ~8 s (5800-6100 t/s); COAST_WAIT_ENTRY stop = 41946 ticks, 6.9 s (6050 t/s) -> truncating saves only ~12% (coast entry is late, t=524 s of 593 s). CIRC_END should be ~36000-ish ticks per user estimate — measure in Step 5.
- E at manual-best reference points (user ran button): MECO 50000 (G .62, bias .78) E=0.171900, tToApo 52.7 s, stage vrMin 124.8 | 52612 (G .60, bias .59) E=0.172278, 49.7 s, 116.4 | 55000 (G .60, bias 1.16) E=0.149380, 80.5 s, 143.1. All apo=320.00, peri -1420..-1647 km at coast.
- E_min/E_max: NOT derivable from these 3 points (they are manual-best, not band edges; E 0.149-0.172). Real E_max/E_min come from Step 6 (tuneAB boundary tracing). NOTE: sweep default 0.25-0.35 is far above all manual-best E (0.149-0.172) -> decide in Step 8 (likely change default range to ~0.14-0.20 or confirm intent).
- Optional config touch-up: add `stageResidualKg: 848.7` to `TunerConfig.baselineResult`.

## 11. Step 5 — tuneLead (INNER-2), implemented in tuner-core.js
- `TunerCore.tuneLead(point, opts)` async -> `{ok, inBand, reason, lead, leadTicks, marginS, vrEnd, vrMin, phase(1 if vrMin>=0 else 2), point, metrics, evals, cacheHits, wallMs, log[]}`. opts: `abortRef, onLog, onProgress, env, targetAltKm, maxEvals(30), cache(EvalCache, share across calls), marginBand, vrEndBuffer, vrMinFloor, slopeSPerS(28)`.
- Eval = `TunerHook.runEval(p, {stopAt:'CIRC_END'})`, cached by lattice key (+stopAt).
- Algorithm: (1) bracketed secant/bisection on integer ticks toward margin 4.5 s (first step from slope guess 28 s/s, |step|<=60 ticks); (2) if no in-band feasible point: find smallest feasible lead by bisecting between largest infeasible and smallest feasible (walk up 1,2,4..32 ticks if none feasible) — feasible = valid CIRC_END, vrMin >= -2, vrEnd >= 0.02; (3) descend up to 6 ticks while still in band + feasible (lowest margin in band). Selection key: [distance to band, margin].
- Assumes margin and vr-feasibility are monotone in lead. Invalid eval (no CIRC_END/crash) is treated as margin = -inf (too low).
- Mock tests (node): loose vr -> lead 435 ticks (5.4375 s) margin 4.27 in 3-6 evals; binding vr -> returns feasible out-of-band with reason; impossible -> ok=false.
- HTML button `Tune lead (baseline)`: runs tuneLead on snapped baseline, then FULL evals of baseline vs tuned lead + `TunerUtils.score` comparison.
- Done-when (pending real run): margin <= 6.72 s, vrEnd > 0, evals/wall printed, tuned score <= baseline score.
- **First real run (user log) found a bug:** past-apogee burns gave wrapped margin (5437 s = next apogee) -> search treated it as "too high" and drove lead to 0. Fix: hook `marginS` now signed (see metrics); tuneLead steps capped to 3 ticks while only 1 sample known; slope from measured points (nearest 2) after that. Descent loop was already guarded (vrEnd >= 0.02 feasibility), now consistent.
- **Facts from that log:** vrEnd is linear in lead, ~0.0101 m/s per tick (442: +0.0460, 435: -0.0246, 375: -0.6304 ...); margin ~ vrEnd/0.00685 => ~1.4 s per tick near the transition (NOT 0.35). Band [4,5] s (1 s wide) < 1 tick of margin => may contain no tick; prediction: 440 (~3.8 s, vrEnd ~0.026) or 441 (~5.2 s, vrEnd ~0.036). Selection = nearest to band, tie -> smaller margin. Headless claim (5.4375 -> 4.26 s) does not match browser (435 is past apogee) — probably different bias/config in that headless run; browser is the reference.
- Eval cost: CIRC_END eval ~7.7 s (10 evals = 76.9 s) -> truncation saves little (circ is at t~572 of 593 s). Budget Step 6/7 at ~7 s per eval whatever the stopAt.


## 12. Step 6 — tuneAB (INNER-1), implemented in tuner-core.js
- `TunerCore.tuneAB(point, opts)` async -> `{ok, status, best, candidates[], eMax:{eMax,ceil,eOk,eBad,rounds}, evals(total), evalBreakdown:{ab,lead,full}, cacheHits, wallMs, log[]}`. `best` = lowest-score candidate with `ok` (hard constraints pass). Candidate = `{tag, round, point (AB lattice pt), fullPoint (with tuned lead), desc, E, apoCoastKm, lead:{...tuneLead summary}, metrics (FULL), score, ok, reasons, parts}`.
- opts: `mode ('fast'|'fine'|'accurate'; default fine), modeOverride, eMax (start guess; default Cfg.ecc.eMax ?? eMaxGuess = 0.20), biasFloor, maxEvalsAB (160), maxRelearn (2), targetAltKm, env, abortRef, onLog, onProgress, cache, verbose (print tuneLead lines), hook`.
- COAST_WAIT eval classes (ceil = eMax − 0.0005): **F1** stage vr<0 / crash (→ gentle: bias up) · **F2** no coast apo >= target−1 km / never reached COAST_WAIT (→ aggressive: bias down) · **FE** E > ceil (→ gentle) · **OK**. *Spec-ambiguity noted:* prompt-web 2.2 says E>E_max → aggressive, but Step-B ("push A down, E crosses → 1 step back") and the ref points (bias .59→1.16: E .172→.149) say higher gentleness → lower E, so FE goes gentle; `findOk` flips direction empirically if E rises along the scan. **Verify with the real log** (look for "flipping" lines).
- Flow per round: `startOk` (Fail3: scan bias ±0.5 steps, opposite class ⇒ bracket+bisect; no OK ⇒ A relax = G+2 quanta, bias reset, ≤6x) → `push G` down by mode.gStep (trial G−step at same bias; non-OK ⇒ `findOk` rescue ±0.1 bias, K=6; rescue fail ⇒ stop) → `push T` down (Tn ladder 160→mode.tStep halving, rescue ±0.02, K=4, ≤8 steps/level) → `climbE` (bias ladder 0.5…mode floor, both directions, E toward ceil, never above) → candidates (mode.candidates: 1 fast / 2 fine / 3 accurate: min-A-climbed, pre-climb, back-off G+gStep) → each: `tuneLead` (warm lead from previous candidate) + FULL eval + `TunerUtils.score`.
- Rescued push steps learn a bias-per-step slope (A↔bias trade along an E isoline) and predict the next trial's bias (1 eval instead of a scan). A rescue landing within 0.1 deg of the bias bound (−2/2.5) is rejected (Fail3 "extreme bias" = A too low).
- **E_max learning:** top candidate fails (tuneLead infeasible or hard-fail score) ⇒ eBad = its E; eMax := (eOk+eBad)/2 if a passing E is known, else eBad − 0.01; restart from the best passing point (else the failed one); ≤ maxRelearn rounds. Only lowers eMax (no raise). Config: `ecc.eMaxGuess 0.20`, `ecc.eDropOnFail 0.01`, `limits.eSafetyMargin 0.0005`, `limits.coastApoTolKm 1`.
- Config also: `limits.marginTargetS [3.5,5.5]`, `modes.*.candidates`.
- Mock (node, synthetic E(gentleness), true E-limit 0.185 below the 0.20 guess): fast/fine/accurate all ok, 2 relearn rounds, ab evals 83/82/102 (+ lead ~40-80, full 1-3); no-learn case 40 evals; F1 start recovers (43); impossible ⇒ ok=false at 30 evals. Mock is a pessimistic worst case (A↔bias isoline slide + learning from scratch); real sim eval count expected lower. **Each real eval ≈ 7 s ⇒ fine mode ~ (ab+lead+full) × 7 s; if the real log shows > ~60 AB evals, Step 10 tuning needed (bigger T ladder start, fewer bias levels).**
- Done-when (pending real run): best score <= baseline score (button prints baseline vs best), A_eff < 13.94 or equal, evals reported.


## 13. Step 6 fix after first real tuneAB log (AB#1..55)
**Real surface facts (from log):**
- E = |signed ecc| -> **V-shape in bias**, min ~0 at b0(G,T). Right of b0 E rises steeply then saturates (~0.7). F1 (stage vr<0) = cliff just LEFT of b0; FE = high-bias side. So **FE -> bias DOWN, F1 -> bias UP** (old code had FE=+1 = wrong; every FE scan walked uphill and 'flipped').
- b0 moves ~0.52-0.6 deg bias per 0.01 G quantum (the 'G jump' 0.60->0.59: E .17->.69 at same bias), ~4.5 deg/s with T (curved). Bias wander 0.59 -> -0.85 is the A<->bias isoline, NOT a bug.
- Steepness grows as A drops: OK window ~0.1 deg wide at T=4.80, ~0.01-0.02 at T=4.783. Bias bound -2 => G<~0.555 unreachable.
- Old end state E=0.00138 = climbE fixed 0.01 ladder jumped over the window (E .001 -> .4 within 0.018 deg).
**Code changes (tuner-core.js):** `dirOf` F1=+1/else -1 (F2 = -1, **unverified**, never seen in real log); crossing bisect resolution = floorBi/10 (0.001 fine); `climbE` = doubling up-steps from 4*rq then bisect OK|FE to 1 quantum, stops when E in [ceil-0.01, ceil]; G rescue K 6->10; T push <=4 steps/level; relearn rounds reuse lowest-A visited OK point with E<=new ceil (0 evals) instead of restarting from relaxed A.
**Mock (test-tuneAB-mock.js):** surface fitted (scipy) to the real log: V-shape, F1 cliff, G jump, A-dependent steepness, stageVrMin follows E, bias bounds. Downstream `trueEmax` (lead fails above it) is still INVENTED. ALL PASS. Mock AB evals: fast ~49, fine ~73, accurate ~96 (target <60 for fine -> Step 10 tuning if real run is similar; main cost = T ladder fails on narrow windows).
