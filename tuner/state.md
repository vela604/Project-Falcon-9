# state.md — Browser Param Tuner (leoInsertionV3)

> Naye chat me ye file + `multi-step-project.md` + "Next step" ki Attach list paste karo. Ye file akeli bhi project samjhane ke liye kaafi hai. Har step ke end pe isko regenerate karo.

## 1. Current status
- **Last finished:** Step 4 — baseline validated in browser (phone). Hook bugs fixed (stage body lookup, maxG formula, vrEnd/margin = engOff).
- **Verified by user (real sim):** raw/snapped/COAST_WAIT_ENTRY evals, determinism bit-identical (2 runs), ~5000-8000 t/s, FULL eval ~6-9 s. Baseline = manual on every metric (see section 10).
- **Carry-over from Step 4 (not blocking Step 5):** E at COAST_WAIT for MECO 50000 / 55000 reference points + E_min/E_max estimate NOT measured yet. Button `Ref points E (3x COAST_WAIT)` added to html — user runs once, pastes 3 log lines, then fill section 10 + `TunerConfig.ecc.eMin/eMax`.
- **Next:** Step 5 — INNER-2 `tuneLead` in `tuner-core.js` (design in section 11).
- **Attach for Step 5:** `state.md`, `multi-step-project.md`, `prompt-web.md`, `tuner/` saari files (html, tuner-config.js, tuner-engine.js, tuner-utils.js, tuner-hook.js) + the 3 `Ref points E` log lines (if run).

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
| tuner-core.js | tuneLead, tuneAB, findOptimalMeco, sweepE | Steps 5-8 |
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
3. Step 5: expected lead numbers in user's note (lead ~5.44-5.46 with margin 4-5 s) look inconsistent with baseline (lead 5.53 -> margin 6.72 s). Margin should move ~1 s per 1 s of lead, so margin 4-5 s probably needs lead ~3.3-3.8 s. Confirm intent (Step 5 start).
4. `guidance-blocks.js` not needed so far (E and margins computed in hook).

## Metrics returned by runEval (current, Step 4)
endReason (COAST_WAIT_ENTRY/CIRC_END/DEPLOY/CLEARED/CRASHED/HALTED/CAP/STAGE_VR_NEG/ABORTED), ticks, simTimeEnd, wallMs, ticksPerSecond.
(A,bias): `eCoast` (osculating e at first COAST_WAIT tick), apoCoastKm, periCoastKm, tToApoCoastS, altCoastKm, vrCoast, vtCoast, coastEntryT, vrMinStageBurn, stageVrNeg(+AltKm,T).
Circ: `vrMin` (CIRCULARIZE entry -> engines off), **`vrEnd`/`marginS` = engines-off tick (matches manual 0.046 / 6.73 s; used by score/checkHard)**, `vrEndAch`/`marginAch` = circAchieved tick (diagnostic only; vrEndAch is negative, margin garbage), circStartT, circAchievedT, circEngOffT.
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
- E at reference points: MECO 50000 = ? | 52612 = 0.172278 | 55000 = ?  (pending Ref points button)
- E_min/E_max: pending (null in config).
- Optional config touch-up: add `stageResidualKg: 848.7` to `TunerConfig.baselineResult`.

## 11. Next: Step 5 design (INNER-2, lead search) — `tuner-core.js`
- `tuneLead(point, opts)` -> `{ lead, leadTicks, marginS, vrEnd, vrMin, ok, evals, log[] }`. Uses `TunerHook.runEval(point_with_lead, { stopAt:'CIRC_END' })`; uses metrics `vrMin`, `vrEnd`, `marginS` (engOff), `endReason`, crashed. Lead on integer tick lattice (0.0125 s); EvalCache so repeated leads cost nothing.
- Phase 1: reduce lead with no negative vr (vrMin >= 0): ladder 50, 20, 10, 5, 2, 1 ticks (hybrid bracket). Stop when margin < 5 s or vr goes negative.
- Phase 2: negative vr allowed (vrMin >= hard floor -2 m/s), vrEnd >= 0 with buffer 0.02-0.05 (not 0), stop when margin in [4,5] s. vrEnd < 0 = infeasible side.
- Output must be lattice-snapped; final FULL verify happens in later steps (INNER-1 / Phase A).
- Test: baseline (G 0.60, T 4.82, bias 0.59, MECO 52612) -> must reach margin <= 6.72 s with vrEnd > 0. Report evals count and wall time.

