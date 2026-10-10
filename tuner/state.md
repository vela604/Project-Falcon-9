# state.md — Browser Param Tuner (leoInsertionV3)

> Naye chat me ye file + `multi-step-project.md` + "Next step" ki Attach list paste karo. Ye file akeli bhi project samjhane ke liye kaafi hai. Har step ke end pe isko regenerate karo.

## 1. Current status
- **Step 6 ✅** (real sim, fine mode eMax=0.20): 24 evals (ab 14, lead 8, full 2), wall ~3 min; best = start point (G=0.60 bias=0.59 lead=5.5, E=0.172, deploy 587.54, fuel 52625, resid 849.4, score -525.953). G=0.59 verified: score -525.861 (27 s faster, 10 kg less fuel, resid 752.1) -> stop "score not better". E_max learning did not fire (E_max 0.1995 assumed). `tuneRough` html button exists (real verification still pending).
- **Step 7 v2 code delivered (mock ALL PASS 91, real sim pending):** `TunerCore.findOptimalMeco` v2 (two-knob MECO+G, physics tol, fast probes via hook `stageFuelEngOffKg`, cliff-aware G-drop) in tuner-core.js + html button `Find optimal MECO (Phase A)` (+ start select: ref 50000 / baseline 52612 / ref 55000). See section 15.
- **Next (user):** browser: press `Find optimal MECO (Phase A)` from baseline 52612, paste the whole log (`#n MECO=... residual=...` lines, `=== findOptimalMeco RESULT`, history, final JSON). Optionally also from ref 50000 / 55000 (sanity). Then Step 7 ✅ -> Step 8 (sweepE, Phase B at the final MECO).
- **Attach for next chat:** `state.md`, `multi-step-project.md`, `prompt-web.md` (old, reference only), `tuner/` all files + findOptimalMeco log.

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
| tuner-core.js | `TunerCore.tuneLead` (Step 5 ✅), `tuneAB` (Step 6 ✅), `tuneRough` + `findOptimalMeco` (Step 7 v2, mock-tested, real run pending); sweepE pending. Both accept `opts.hook` (inject mock for node tests; default `TunerHook`) | Step 5 ✅, Step 6 code done; 7-8 pending |
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


## 14. Flow redesign after 2nd real log (run with dirOf fix) + Phase A split
**2nd real log facts:** G=0.57/T=4.82: OK window CLOSED (F1 cliff jumps straight to E=0.35, AB#10-18). G=0.58/T=4.78: window edge E=0.196 -> tuneLead infeasible (downstream fail at the F1 cliff) -> E_max learning fired for real. 69 AB evals before verify (60 of them T ladder).
**tuneAB flow now (Phase B):** startOk -> level 0 = start lane verified as-is (score reference) -> **G descent: each G level = findOk -> climbE (E-max edge of THAT lane) -> verify (tuneLead + FULL + score)**; continue only while verified score improves (`opts.minGain`, default 0), stop on window closed / downstream fail / no gain -> **T descent only if G ended by window closure**, coarse levels only (`modes.*.tPhaseSteps`: fast [], fine [80,40], accurate null = full ladder), 2 consecutive failed levels stop. `settle()` = climb + verify with **lane-local E_max relearn** (lower ceil, re-climb same lane from cached OK points; no restart). `slopes.G/T` = bias per step learned from climbed points. Candidates = every verified lane (tag start / G=.. / T=..), best = lowest score.
**New `TunerCore.tuneRough(point, opts)` (Phase A block):** startOk (+ relax A <=3x if downstream fails) -> tuneLead -> 1 FULL. No edge search, no A minimisation, no relearn. Returns `{ok, point(with lead), E, lead, metrics, residualKg(stageResidualKg), score, evals, evalBreakdown, log}`. Mock: 5-8 evals warm, 29 worst. **Step 7 findOptimalMeco = outer loop around tuneRough** (warm start from previous point; MECO trend: up => bias up, lead down; residual target [0,50]); then Phase B (tuneAB / sweepE) once at the final MECO. HTML button for tuneRough not added yet.
**Mock:** F1 edge now A-dependent (window closes ~A=13.2, as real), b0 shifts with MECO (+2.4e-4 deg/kg), FULL returns stageResidualKg (invented slope -0.4 kg/kg). Mock eval counts: fast 16 / fine 113 (ab 72) / accurate 201 (ab 145). **fine is still ~2x over the 5-8 min budget (113 x 7 s ~ 13 min)** -> Step 10 tuning (candidates: fewer relearns, coarser bias bisect).
**Unverified:** score really improves with lower A (stop rule assumes it; real FULL scores decide), F2 direction (-1), downstream E limit in mock (invented, real fail seen at E=0.196 near cliff only).


## 15. Step 7 — findOptimalMeco v2 (Phase A outer loop), tuner-core.js  (mock ALL PASS 91 checks, real sim pending)
**Why v2:** real v1 run: G=0.60 residual floor ~179 kg (MECO 52612/56612/60612/61199/61492 -> 849.4/537.3/214.5/188.2/179.5), all probes above ~61.7k FAIL (cliff = bias bound), 117 evals, 4 wasted fails (61783-61786), not converged.
**API (unchanged shape + extras):** `TunerCore.findOptimalMeco(point, opts)` -> `{ok, status, meco, point, G, residualKg, score, E, lead, metrics, iters, gDrops, resOffset, failingProbes, bracket, history[], evals, evalBreakdown:{ab,lead,full,probeCoast,probeCirc}, cacheHits, wallMs, log[]}`. History entry = `{iter, seq, meco, gi, kind('start'|'fast'|'level'|'full'|'confirm'), how, real, ok, cls, residualKg, raw(fast only), point, evals, superseded, warm}`.
**opts:** `band (default: config-driven, see 16)`, `aimKg 25`, `fast (true; false = every probe is a full tuneRough)`, `maxGDrops (cfg 3)`, `gQuantumKg (cfg 97.3)`, `gBiasDegPerQ (cfg 0.55)`, `slopePrior (cfg -0.05)`, `probeRescueBi (100 = 0.01 deg)`, `nearConfirmKg (80)`, `autoCalib (true)`, `maxIter (16)`, `maxEvals`, `maxFailWalk (6)`, `mode`, `verbose`, `cache`, `hook`, `env`, `targetAltKm`, `abortRef`, `onLog`, `onProgress`.
**1) Two knobs.** MECO = fine, G = coarse. 1 G quantum = -97.3 kg residual (real) and moves the cliff out ~2200 kg MECO. Old probes are re-used at the new G as *virtual points* `r - gQuantumKg*(gi_old - gi_new)`; the first MECO at a new level is a model jump (secant on virtual points, <= ladder[0]); no old failing MECO is re-probed. Bias warm shift per G step = cfg `gBiasDegPerQ` (learned after the first drop).
**2) Physics tol** `tol = clamp(0.1*bandWidth/|slope|, 30, 300)` kg (slope = kg residual per kg MECO from the two feasible points nearest `lo`; `slopePrior` if none). Bracket/step resolution is tol, not 1 kg. A fail brackets with plain bisect (no interpolation against a cliff).
**3) Fast probe** = COAST_WAIT (warm, <=1 bias rescue 0.01 deg) + 1 CIRC_END at trend-predicted lead (no lead search, no FULL). Residual = `stageFuelEngOffKg` (new hook field, stage fuel at circ engines-off) + `resOffset`. Fail = coast not OK after rescue, or CIRC_END invalid / fuel<=0 / vrEnd<-0.5. Fast IN band (or within `nearConfirmKg` above band while offset unverified) => confirm with `tuneRough` (FULL); `resOffset = real - fast` (also auto-calibrated at the start/level points for free: tuneLead already cached that point's CIRC_END). First probe on every new G level = full tuneRough (new lane bias/lead).
**4) Cliff-aware.** `lo` = feasible point still > band, `hi` = failing MECO above it. `r_opt = r_lo + slope*(hi - tol - lo)`; `r_opt > bandTop` => floor-limited => G-drop (needs a *measured* slope, else bisect). Also G-drop if bracket on a cliff closes (<= tol). Stops: in band (confirmed by FULL) | maxGDrops | bracket closed below band | maxIter | maxEvals | abort | bound.
**Mock (test-tuneAB-mock.js, ALL PASS, 91 checks):** real 5-point curve + real G effect + cliff model (bias bound, 61650 kg at G .60, +2183 kg per G quantum). Baseline -> G=0.59, MECO 63069, residual 34.9, 8 iters, 25 evals (3 FULL, 7 coast + 3 circ probes), 2 failing probes; full-probe mode 67 evals (2.7x); fast offset +/-40 kg corrected (with and without start calibration); tail slopes -0.02/-0.05, starts 50000/55000/58000 converge; impossible/floor-limited/abort/maxIter/maxEvals bounded. **Mock-invented:** curve beyond 61492 (-0.03 kg/kg), cliff position/G shift, bias-per-G (mock 0.524 vs cfg 0.55 -> first level probe costs ~8 evals).
**Real-run watch list:** (1) `resOffset calibrated` lines: real vs fast engOff difference; (2) learned gBias line after G-drop; (3) cliff/G-drop decision lines (`r_opt=`); (4) first probe on the new level (full tuneRough) cost.
**Open (Step 8):** Phase B (tuneAB) lowers G further -> residual drops ~97 kg/quantum: aim Phase A higher or re-check residual after Phase B.

## 16. Residual band change + runTuner (Phase A + B coupled)  (mock ALL PASS, real sim pending)
**Real Phase A v2 log (user):** 52612 -> G-drop at 60612 (r_opt 229.7) -> G=0.59 -> G-drop #2 -> G=0.58, MECO 61150, residual 35.5, 12 steps, resOffset -2..-3 kg, gBias 0.550, score -611.32, **deploy 674.40 s (+84 s vs baseline 590.46)** -> [0,50] empties the stage = bad.
**Config:** `limits.residualTargetKg = [100,200]` (deorbit OFF), `limits.residualTargetDeorbitOnKg = [500,600]` (deorbit ON), `limits.residualPhaseAFrac = 0.5`. Band is config-driven: `TunerCore.residualBand(opts)` -> deorbit ON if `opts.deorbit` or `cfg.fixed.deorbitEnabled`. `findOptimalMeco` default band = residualBand(); explicit `opts.band` still wins.
**Deploy time note:** real points: MECO 52612 -> 590.46 s, MECO 61150 -> 674.4 s => ~0.0098 s per kg MECO; deploy follows MECO, residual is only its proxy. [100,200] vs [0,50] means ~1.5k-5k kg lower MECO (slope -0.03..-0.08) => expect ~15-50 s less deploy time, NOT necessarily ~600 s. Check in the real log (`deploy=` is now printed on every real history row, `deployTimeS` in history entries / result).
**Coupling = Option C + guard:** `TunerCore.runTuner(point, opts)`: Phase A band = upper part of the band `[lo + frac*w, hi]` = [150,200] (headroom), Phase B = `tuneAB(phaseA.point, {mode, residualBand: FULL band})`. New tuneAB opt `residualBand`: a verified lane whose FULL `stageResidualKg` leaves the band is rejected (`rec.resFail`, NOT an E_max failure, no relearn); G descent stops there ("rejected by residual guard"). Result always in band. best = lowest score of Phase B lanes + Phase A point. Output `{ok, status, phaseA, phaseB, band, bestPoint, bestScore, bestMetrics, bestResidualKg, bestDeployS, bestSource, evals, breakdown:{phaseA,phaseB}, wallMs, log}`. Phase A failure -> ok=false, phaseB=null.
**opts:** `mode` (Phase B, default fine), `band`, `deorbit`, `phaseABand`, `residualPhaseAFrac`, `phaseA{}`, `phaseB{}`, `hook, env, targetAltKm, abortRef, onLog, onProgress, cache`.
**HTML:** new `B mode` select + `Full tune (Phase A + B)` button (prints Phase A history, ranked Phase B candidates, best + final JSON). `Find optimal MECO (Phase A)` stays (Phase A only, band from config).
**Mock additions:** [100,200] default band (no G-drop with the real curve; G-drop path with a low cliff), [500,600] deorbit-on, config-driven deorbit flag, runTuner (residual after Phase B in band, guard matters: unguarded tuneAB goes to G=0.59 residual 95), deploy time in history rows (mock deploy = fit of the 2 real points vs MECO). Old v2 tests now pass `band:[0,50]` explicitly.
**Next (user):** browser: `Full tune (Phase A + B)` from baseline 52612; paste log. Watch: Phase A band [150,200] reached with how many G-drops, `residual guard` lines in Phase B, deploy time, resOffset.

---

## Δv REFACTOR — 6-step chat series (Steps 17-22)

**Motivation**: E (eccentricity at COAST_WAIT) was the search signal; user handoff said retire it entirely
(no eCoast search signal, no eMaxGuess, no eSafetyMargin, no climbE, no E_max learning).
New signal = `coastDeltaV` (v_circ(target_alt) − v_apo(current_coast_orbit)), captured at COAST_WAIT entry
from `Guidance.getGuideStatus().coastDeltaV`. Universal target band `[750, 850]` m/s for all altitudes.

**Real anchors**: 320 km baseline Δv=599 (G=0.60, b=0.59). 2000 km manual Δv=925 (G=0.65, b=0.59).
Both outside the wide guard `[700, 900]` — hence guard is informational only, NOT a hard constraint.

**Physics direction (user-confirmed)**: aggressive (G↑ bias↑) → Δv smaller. gentle (G↓ bias↓) → Δv larger.

### 17. Step Δv 1/4 — config + hook + utils
- `tuner-hook.js`: `m.coastDeltaV` added, captured at COAST_WAIT entry from `gs.coastDeltaV`.
- `tuner-config.js`: REMOVED `ecc.eMaxGuess`, `ecc.eDropOnFail`, `limits.eSafetyMargin`.
  ADDED `limits.coastDeltaVbandMps=[750,850]`, `limits.coastDeltaVguardMps=[700,900]`.
  `ecc` block deprecate-marked (kept as reference).
- `tuner-utils.js`: `checkHard` UNCHANGED — Δv NOT hard-fail (would reject both 599 and 925 refs).
  Score weights unchanged. Self-test added for Δv contract.
- **Known breakage after this step**: `tuner-core.js` still referenced `Cfg.ecc.eMaxGuess` → NaN. Fixed in Step 18.

### 18. Step Δv 2/4 — tuneAB rewritten (coastDeltaV classify)
- `tuneAB` replaced. Classify: `F1` (crash) | `F2a` (no coast / apo short / Δv NaN) |
  `F2b` (Δv < 750) | `FE` (Δv > 850) | `OK`.
- `dirOf`: `F1`/`FE` → bias +1; `F2a`/`F2b` → bias −1. No 'flipping' (E gone).
- `climbE` REMOVED. `settle()` = verify only. No `eMax/ceil/eSafe/maxRelearn`.
- Result `eMax` field retained as **deprecated stub** (`{eMax:null, ceil:null, eOk:null, eBad:null, rounds:0, removed:true}`) for UI/mock compat.
- **Data-driven risk flagged**: 320 km baseline Δv=599 < bandLo=750 → F2b → tuner drives bias↓
  toward F1 cliff. Band reachability at 320 km UNKNOWN, to be shown by real sim.

### 19. Step Δv 3/4 — findOptimalMeco refactor (coastCls Δv-based, ceil gone)
- `ceil` local (from `Cfg.ecc.eMax ?? eMaxGuess − eSafetyMargin`) REMOVED.
  Replaced with `dVband` / `bandLo` / `bandHi` (from `limits.coastDeltaVbandMps`).
- `coastCls` rewrite: F1 | F2a | F2b | FE | OK (same classes as tuneAB classify).
- `fastProbe` rescue bias direction: F1+FE → +1; F2a+F2b → −1.
- Residual classify (`cls(h)`: up/down/in/fail) UNTOUCHED — MECO steering unchanged.
  `lo()/hi()/nextMeco()/trendFor()/warmStart()` untouched.
- `tuner-core.js` me ab `eMaxGuess` / `eSafetyMargin` ka **koi reference nahi**.
- **Expected breakage**: mock (no `coastDeltaV` field). Fixed Step 22.

### 20. Step Δv 4/4 — runTuner Phase B multi-sample (sweep mode)
- `tuneAB` me `opts.sweep` branch added: coarse G sweep (stride = `mode.gStep*3` default, ~6 samples),
  NO score-guard (enumerate all OK lanes), NO T descent, fail-stop after 2 consecutive downstream fails.
  Reuses `tryStep`/`settle`/`verify`/`leadHint` warm-start.
- `runTuner` Phase B now defaults `sweep: true`. `residualBand` guard still active.
  `opts.phaseB.sweep = false` to fall back to score-guarded descent.
- Tunables: `opts.sweepStride`, `opts.sweepMaxSamples`, `opts.sweepFailStop`, `opts.sweepTagSuffix`.
- Result shape unchanged: `B.candidates` now typically 4–6 verified lanes; leaderboard auto-includes all.

### 21. Step Δv 5/4+ — E → Δv display cleanup (multi-file)
- Removed E as *field* from tuneRough, findOptimalMeco (history/fast/confirm/probe returns + result assembly),
  runTuner (leaderboard + Phase A skip-branch), makeRow, rowBlockHtml, strategy-example.
- Source of truth: `metrics.coastDeltaV`. `makeRow` reads it directly from metrics.
- UI `rowBlockHtml` detail grid shows `Δv <n> m/s` where `E@coast` was.
  `SORT_KEYS` unchanged (`['score','accuracy','fuel','time']`) — no Δv sort key added (not requested).
- `m.eCoast` metric still exists (used only by classify/coastCls for "did coast wait happen" detection, not a signal).
- `tuneAB.eMax` result stub still present (deprecated).

### 22. Step Δv 5/5 — mock rewritten (Δv-based, no E)
- `test-tuneAB-mock.js` FULL rewrite: synthetic Δv surface (**INVENTED**, direction from user).
  Real-fit pieces KEPT: lead↔vrEnd slope (0.0101 m/s per tick), 5-point residual curve,
  cliff model (bias-bound at G=0.60 ~ 61650, +2183 kg per G quantum).
- Assertions cover: F1/F2b direction, F1-start recovery, tuneAB finds OK, tuneRough returns deltaV,
  findOptimalMeco converges (residual outer loop, orthogonal to Δv), runTuner sweep produces ≥2 candidates
  with deltaV, config regression (band present, eMaxGuess/eDropOnFail/eSafetyMargin removed),
  makeRow reads `coastDeltaV`, no legacy `E` field anywhere.
- **Assumption-free warning**: band [750,850] reachability on the mock is a property of the INVENTED surface,
  NOT a claim about the real 320 km sim. Real verification needed.

---

## Pending / next steps

1. **Real-sim verification (Step Δv 6)**: run tuner from baseline 320 km, paste log.
   Watch: `startOk` finds OK in band? Or bias scan hits F1 first? Phase B multiple candidates?
   Decide from DATA whether band [750,850] is reachable at 320 km as-is, or needs altitude-dependent widening.
2. **Cleanup (Step Δv 7)**:
   - Delete `tuneAB.eMax` result stub once UI/mock no longer read it.
   - Grep `tuner-ui.js` for `eMax` / "E_max learning" log line references — remove if dead.
   - Decide `m.eCoast`: keep (still used by classify detection) or rename to `coastReached` (bool).
3. **Older pre-Δv pendings (still open, lower priority)**:
   - `startOk` bidirectional G relax (currently positive-only, up-relax).
   - `bounds.A.upper = 20` expand (higher orbits need G up to 2+).
   - `maxFailWalk = 6` bump for high-MECO walks.
   - 2000 km real verification run.

## Files touched in Δv refactor
`tuner-hook.js`, `tuner-config.js`, `tuner-utils.js`, `tuner-core.js`, `tuner-ui.js`,
`tuner-strategy-example.js`, `test-tuneAB-mock.js`. `leoV3-Param-S-idea.html` untouched.