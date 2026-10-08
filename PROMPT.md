# leoInsertionV3 Auto-Tuner — Build Prompt (v2: guided search architecture)

Ye file naye chat me paste karo + `STATE.md` + us step ki "Files to attach". **Ek chat = ek step.** Har step ke end me `tuner/STATE.md` update karo (chhota, precise).

---

## 0. Context (har chat me padho)

Hum `leoInsertionV3` guidance ke constants ko autonomously tune karne wala **offline tuner** bana rahe hain (Falcon 9 B5 stack -> 320 km circular LEO). Sim deterministic hai (bit-identical, verified). `runSim(options)` = ek full sim.

**Rules:** `runner.js`, `run.js`, `js/*` MAT badlo (sirf additive, backward-compatible options allowed). Tuner alag layer hai. Config-driven raho (stack / target altitude hardcode nahi).

### Status
- Step 1 (cleanup) DONE. MECO fuel-triggered only.
- Step 2 (evaluator, hook, worker pool, 27 tests) DONE.
- Step 3 (baseline + calibration) DONE. Baseline raw defaults (T=4.82, lead=5.53, G=0.60, bias=0.59, margin=0.001, MECO=52612): deploy 590.46 s, apo/peri 320.111/319.999, vrEnd 0.046, vrMin -0.380, margin 6.73 s. Limits: maxQ 31 kPa, durationCapS 770, maxG 6.02.
- Scans DONE: T continuous (fine quantum 0.000125 s). T=4.820 hard transition. MECO 1D scan: baseline ke alawa sab fail => **MECO isolation me tune nahi hota**.

### Tunables (ab 4 hi)
| id | path | quantum | note |
|---|---|---|---|
| ascent A = G*T^2 | `ascent.PUSH_MAX_GIMBAL_DEG` + `ascent.PUSH_T_S` | G 0.01 deg, T 0.000125 s | "A" ko G step (±0.01) se move karo, T = sqrt(A/G) |
| stage_burn_aoa_bias | `insertion.STAGE_BURN_AOA_BIAS_DEG` | **0.0001** | A ke saath jointly |
| circ_trigger_lead | `insertion.CIRC_TRIGGER_LEAD_S` | 1 tick (0.0125 s) | A/bias se independent (post COAST_ROTATE) |
| meco_target_booster_fuel | `ascent.MECO_TARGET_BOOSTER_FUEL_KG` | 1 kg | mission parameter, outer loop |

`stage_burn_aoa_margin` **tunable nahi** — `fixed` me lock 0.0001.

### Physics insights (user, ab architecture ke base)
1. Ascent profile aur stage burn **separable nahi**. Jointly post-RCS-boost eccentricity **E(A, bias)** decide karte hain. E COAST_ROTATE ke **last tick** (COAST_WAIT se pehle) pe measure hoga.
2. E ki bearable range (E_min, E_max). Target **E_max ke paas** (fastest). E>E_max => fail. E<E_min => time waste.
3. Boundary **non-monotone**: outer region (E>E_max) me high A <-> low bias; inner region me high A <-> high bias. Achievable region 2D **band** hai, curve nahi. "A:bias ratio" galat abstraction.
4. Redundant (A, bias) solutions exist; chahiye wo jo E_max ke sabse paas + A sabse chhota (aggressive = fast).
5. circ lead E ko affect nahi karta (E pehle measure ho chuka). Isliye (A, bias) fix hone ke baad lead alag inner scan hai.
   **Correction (probe):** E (measurement) lead se independent hai, par *mission success* (E, lead) ka joint
   function hai — E=0.26 pe fail "E_max exceed" nahi, "lead galat" ho sakta hai. Isliye **INNER-2 pehle, INNER-1 baad me**:
   INNER-1 har candidate (A, bias) pe `tuneLead` (inner2.js) call karta hai. INNER-2 upper bound = t_to_apogee at
   COAST_WAIT entry (`coastEndTToApoS`), phase duration nahi. E_max = min(physics E_max, timing E_max); stack-dependent
   (learned-bounds.json me stack signature ke saath). Timing-bound pe knife-edge nahi, comfortable margin.
6. Circ burn me vr ~4 s margin ke liye transiently negative hona legit hai. Phase 1: negative vr bina minimise; Phase 2: negative allow; Phase 3: margin 4–5 s pe stop. Practical abhi ~6–7 s. `circVrAtEndMinMps` (0.04) sirf tab 0 pe lao jab Phase 2 me jao.
7. Trend: MECO↑ => bias↑ => lead↓. Reference points: MECO 50000 (G 0.62, lead 5.65, bias 0.78), MECO 55000 (lead 4.46, bias 1.16), baseline 52612 (0.60/5.53/0.59). Inhe warm-start + validation ke liye use karo.
8. Scoring: **orbit error weight HIGH, time weight LOW** (time gentle profile se easily kam hota hai par accuracy bigadti hai).

---

## ARCHITECTURE DECISION: Guided search (CMA-ES hata do)

**Final decision: (b) guided search. CMA-ES main flow se hata diya. Optional last-mile polish = chhota deterministic lattice pattern-search, CMA-ES nahi.**

Kyun:
1. **Landscape CMA-ES ke assumptions todta hai.** Feasible region patli band + cliff (circVrAtEnd=0), T=4.820 pe hard transition, MECO 1D scan me 15/16 points fail. CMA-ES ko flat/hard-fail plateau pe slope nahi milta; failPenalty+depth se bhi slope sirf coarse hai, aur optimum cliff ke ekdum kinare pe hai (knife edge: 0.006 m/s).
2. **Boundary-hugging problem.** Hume band ka *edge* chahiye (E_max), centre nahi. CMA-ES mean ko centre ki taraf kheenchta hai; edge pe sigma collapse hota hai ya cliff me gir jaata hai.
3. **Structure exploitable hai.** MECO = root-finding (residual fuel signal), lead = monotone bisection, (A, bias) = 2D boundary tracing. Ye sab bisection/bracketing se kam evals me exact lattice optimum dete hain; deterministic sim me bisection noise-free hai.
4. **Checkpoint reuse sirf nested structure me chalta hai.** CMA population (A, bias, lead) mix karke bhejta hai => shared prefix nahi. Guided: ek (A, bias) pe checkpoint -> bahut saare lead values.
5. **Explainable + resumable.** Har step ka reason log hota hai; user ke manual results se seedha compare/validate ho sakta hai.
6. CMA-ES ka haq sirf ye tha ki physics knowledge nahi chahiye — wo ab user ke paas hai. Multi-altitude generalisation ke liye bhi heuristic (steps, order) config me parametrise karo; naye stack pe pehle coarse scan se band dhundo, phir wahi algorithm.

Hybrid (c) isliye nahi: CMA fine-stage ko cliff ke paas safe rakhna mushkil, aur lattice pe pattern-search wahi kaam deterministic + cheaper karta hai.

---

## Algorithm spec (manual flow automate)

```
OUTER (MECO):  start baseline MECO (ya nearest reference point se warm start)
  INNER-1 (A, bias):  band search, target E near E_max
  INNER-2 (lead):     3-phase bisection, checkpoint reuse
  FULL CHECK:         full mission -> post-deploy stage residual fuel
  MECO update:        residual > target(0–50 kg) => MECO↑ ; mission fail => MECO↓ ; bracket + bisection
  repeat until residual in target
FINAL: fine polish (A ±0.01 G-step, bias ±0.0001, lead ±1 tick) on full score
```

### Objective (guided search)
Constraint-first, phir edge-hugging:
1. **Orbit tolerance (±1 km apo/peri, ecc 0.0005) = constraint.** Score component
   nahi. Tolerance ke andar = 0 penalty. Bahar = hard fail.
2. **Primary: E_max edge tracking.** Search E(A, bias) ko E_max ke bilkul paas
   rakhe — actual search target, soft score nahi. E > E_max = hard fail.
3. **Secondary: fuel, phir time.** E edge pe fixed hone ke baad, edge ke andar
   max booster fuel left, min deploy time.

Soft score sirf tie-breaker; search in constraints ko enforce karti hai.

### INNER-1: (A, bias)
- A priority: pehle A minimise (G step 0.01, T = sqrt(A/G)), phir bias adjust.
- Bias hybrid bisection steps: ±0.5 -> ±0.1 -> ±0.05 -> ±0.01 -> (±0.001 -> ±0.0001 final).
- Bias extreme (bound, e.g. -2) pe pahunche to **A change karo**, bias reset.
- Boundary non-monotone: har A pe bias bracket alag banao (outer/inner region flag E ke sign/E vs E_max compare se). Boundary ka koi ratio assume mat karo.
- Measure E = truncated eval (stop at COAST_ROTATE end). Truncated yahan valid hai kyunki E hi target hai (pehle ka "proxy invalid" finding sirf *accuracy ranking* ke liye tha, feasibility/E ke liye nahi). E_min/E_max config me; shuru me MECO baseline + reference points se calibrate (E at manual-best = E_max reference).

### INNER-2: circ lead
- Steps ±1 -> ±0.5 -> ±0.1 -> ±0.05 -> ±0.01 (tick lattice me snap; 0.0125 s se chhota effective nahi).
- Phase 1: margin minimise bina negative vr; Phase 2: jab ±0.01 help na kare, negative vr allow (vrMin >= hardFloor); Phase 3: margin 4–5 s pe stop. vrEnd small positive rakho (knife-edge buffer config me).
- **Checkpoint:** sim state COAST_ROTATE end (ya SEPARATED_AXIAL entry) pe save, har lead value yahin se resume.

### MECO outer
- Signal = post-deploy `stageResidualKg` (target 0–50). Monotone-ish: MECO↑ => residual↓. Bracket phir bisection (1 kg lattice). Fail => MECO ke us side ko bound maano.
- Har MECO pe INNER-1 (previous solution se warm start, trend MECO↑ => bias↑ => lead↓ se predict) + INNER-2.

### Score
Orbit error (apo, peri, ecc) HIGH weight, booster fuel medium, time LOW. Hierarchy unit test dobara. Hard constraints same.

---

## Steps (baaki)

**STEP 6 — E(A, bias) mapper.** Truncated-coastEnd eval (stop at COAST_WAIT entry).
2D grid A×bias around reference band; ecc heatmap + per-A boundary where ecc
crosses E_max. Validate: MECO 50000/55000 ke manual (A, bias) band ke andar ya
edge pe aane chahiye. Deliverable: `emap.js` + heatmap + E_max estimate.

**STEP 7 — INNER-2 (done, inner2.js) → INNER-1 + MECO outer.** (order swapped: lead pehle) Boundary tracer (per A, bias where
E = E_max) + bias hybrid bisection + A step descent along boundary. Circ lead
3-phase bisection (COAST_ROTATE end se resume). MECO outer loop: residual fuel
into [0, 50] via bracket + 1-kg bisection. Validate vs manual (baseline, 50000,
55000): tuner ≤ manual deploy time, ≥ manual margin, residual in target.

**STEP 8 — Orchestrator + polish + CLI.** `run-tuner.js` (`--config`,
`--target-alt`, `--resume`), evals.jsonl log, lattice cache, final lattice
pattern-search polish (A ±0.01, bias ±0.0001, lead ±1 tick), best.json
(`applyGuideConfig` format), report.md, fresh-process determinism verification,
`learned-bounds.json` (altitude → best values + E_max band). Optional wind/IMU
sanity run.

**CHECKPOINT (deferred).** Step 7 ke eval count dekh ke decide. <80 evals/MECO
iteration = waste. 150+ = snapshot/restore infra banao (runner.js additive) ya
warm-worker pause approach.

---

## Gotchas (purane, ab bhi valid)
1. Har eval me saare tunables + `fixed` bhejo (`_v3Config` runs ke beech persist karta hai; `resetGuideConfig: true` use hota hai).
2. `quiet: true`. Deorbit hamesha skip. `tracker.maxG` galat — hook ka own G use karo.
3. Cache key me hook-code hash; lattice-point cache rakho.
4. Sim DT 1/80 s; T continuous (fine grid), lead tick lattice.
5. Deterministic compare karte waqt `wallMs` ignore karo.
