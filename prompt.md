# atlas-prism — Universal Bootstrap: prompt.md (v4)

Naye chat me: handoff v4 padho pehle (poori story + model), phir ye plan.
state.md me current status hai. Dono + files = poora context.

================================================================================
## 0. Protocol
================================================================================
1. handoff v4 → state.md → ye file. Phir "NEXT" step karo.
2. Step ka exit criteria user output se prove hone par hi DONE.
3. Ek chat = 1 step (ya 2 chhote).
4. Code pehle, 3-5 line plan, phir explanation. User run karega.
5. Chat end me updated state.md poora do.
6. Contradiction: code > state.md > handoff. Jo galat mile state.md me "Resolved" me.

================================================================================
## 1. Problem
================================================================================
Koi bhi target altitude (160-2000 km) pe, F9 B5 stack ke liye, bina known-good 
reference ke ek valid (G, T, bias, lead, MECO) point. Bootstrap = feasibility.
Tuning baad me.

Valid point = payloadCleared && !crashed && apo/peri target ke andar && 
vrEnd >= 0 && maxQ/maxG limits ke andar. Residual band bootstrap me signal nahi.

================================================================================
## 2. Design decisions (approved)
================================================================================
- **Parent bias range:** [-3°, +3°]. Controller saturation ~±3-4° pe, empirical 
  ±4 borderline. Safety margin ke liye ±3.
- **Direction:** G_min pe bias=+3 (most vertical), G_max pe bias=-3 (most aggressive). 
  Bias positive = slower turn, negative = faster.
- **T fixed = 4.82** bootstrap me (T0).
- **MECO seed:** refs interpolation (orbital energy ε pe). Hypothesis.
- **Signal:** COAST_WAIT_ENTRY + abortOnStageVrNeg (cheapest, 5-8s at 2000 km).
- **coastDeltaV** = vOrb(rApo) − vApo. Apogee cutoff se normally apogee = target.
- **Caps:** static upper bound + dynamic at COAST_WAIT (entryT + tToApo + ~400s).
- **Self-growing refs:** har success harvest table me. Agla nearby altitude 
  warm-start se sasta.
- **Guidance block untouched.** Controller already critically damped. Parent 
  range se solve.

### Harvest format
{ stackId, payloadKg, fuelPct, altKm, G, T, bias, lead, meco,
  residualKg, deployTimeS, apoKm, periKm, ecc,
  coastDeltaV, tToApoCoastS, maxG, maxKPa, boosterFuelLeftKg, stageFuelEngOffKg,
  enteredAtCW: { t, altKm, vr, vt, apoKm } }

================================================================================
## 3. Steps
================================================================================

### Step 1 — Caps fix (worker-sim + hook)
Hard-coded caps altitude-aware karo. worker-sim.js lines ~230 (SA 300s), 253 
(CH 800s), 288 (COAST_ROTATE_2 300s), 319 (FULL 300s). hook.js maxTicks 
durationCapS se, static — dynamic banao at COAST_WAIT entry.
Helper: `ticksForMission(targetAltKm)` static upper bound + dynamic tighten.
Reason surface ho (CAP vs STAGE_VR_NEG vs short apogee) — silent fail nahi.
**Exit:** 2000 km FULL = CLEARED, deployTimeS ≈ 1952. 320 km unchanged (590.46s).

### Step 2 — Reproduce known points
bootstrap-test.html skeleton. 320 km baseline + 2000 km manual point FULL eval.
Determinism check. Open items resolve: maxG, booster fuel 2.7t, Δv 599 vs 696.
**Exit:** dono points reproduce.

### Step 3 — Boundary search (G_min, G_max)
bootstrap-test.html pe 2000 km:
- Search A: bias=+3 fixed, G binary search (start 0.65, range 0.55-0.75, 
  quanta 0.01). Output G_min.
- Search B: bias=-3 fixed, G binary search. Output G_max.
- COAST_WAIT_ENTRY + abortOnStageVrNeg. ~10-15 evals each.
- hook.js me maxOmega scalar add (additive). 
- Print each G, class, maxOmega.
**Exit:** G_min, G_max mila. Window width estimate.

### Step 4 — lib/bootstrap.js: two-sided bias cliff bisection
`findFeasibleBias(point, opts)`: fixed (Gi, Tn, meco), two-sided bisection 
(parent ±3 bounded). bias_lo (F1 cliff), bias_hi (F1 cliff). ~12-16 evals.
Test: 320 km (known G) aur 2000 km.
**Exit:** dono altitudes pe cliff, eval count ≤ ~16.

### Step 5 — bootstrapPoint(targetAltKm)
(a) seed: refs interpolation (ε pe) → G0, bias0, lead0, MECO0
(b) G ladder around G0 (Step 4 primitive har G pe) 
(c) existing tuneLead from CH
(d) 1 FULL verify
Output: single valid point + harvest entry.
Test: 320 aur 2000 km **ref hata ke**, phir unseen altitude (1000 km).
**Exit:** 3 altitudes valid point.

### Step 6 — Altitude continuation + refs auto-grow
320→500→800→1200→1600→2000 (+160 side) sequential. Harvest JSON.
**Exit:** poora 160-2000 sweep, table JSON.

### Step 7 — Altitude-aware limits + SERENO FLUX integration
- rough-scan minRange floor, probeStartKg fix
- primitives.js FE classification (232, 608), residual band (497)
- SERENO FLUX integration
**Exit:** SERENO 2000 km real result, 320 unchanged, mock PASS.

================================================================================
## 4. Step end me kya do
================================================================================
1. Patches (path + lines + verify method)
2. User ko exactly kya run karna hai, output kya paste karna hai
3. Updated state.md poora