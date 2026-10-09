# state.md — Browser Param Tuner (leoInsertionV3)

> Naye chat me ye file + `multi-step-project.md` + "Next step" ki Attach list paste karo. Ye file akeli bhi project samjhane ke liye kaafi hai. Har step ke end pe isko regenerate karo.

## 1. Current status
- **Last finished:** Step 5 code delivered — `tuner-core.js` (`TunerCore.tuneLead`) + html button `Tune lead (baseline)`. Logic mock-tested in node (monotone margin model, vr constraints binding/non-binding, impossible case); **real sim pe abhi chala nahi**.
- **Verified by user earlier:** Step 4 baseline/determinism/speed (section 10). Ref points E button chala (section 10).
- **Next (user):** `Tune lead (baseline)` dabao, log paste karo (tuneLead lines + RESULT + 2 FULL lines). Phir Step 5 ✅ -> Step 6.
- **Next step after verify:** Step 6 — INNER-1 `tuneAB` (design in multi-step-project.md). Attach: `state.md`, `multi-step-project.md`, `prompt-web.md`, `tuner/` saari files (html, config, engine, utils, hook, core) + tuneLead log.

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
| tuner-core.js | `TunerCore.tuneLead(point, opts)` (Step 5, mock-tested); tuneAB, findOptimalMeco, sweepE | Step 5 code done; 6-8 pending |
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

