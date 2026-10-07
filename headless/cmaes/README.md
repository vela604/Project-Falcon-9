CMA-ES Hybrid Tuning — Falcon 9 LEO Mission

Autonomous tuning pipeline for the leoInsertionV3 guidance constants. Targets a 320 km circular LEO insertion using the Falcon 9 Block 5 stack, scored on orbit accuracy, booster fuel retained, and time-to-deploy.

This document is the single source of truth for what we are tuning, why the search is structured the way it is, and how the phases sequence together. It is written to be handed to an AI coding assistant that will implement the orchestrator around headless/runner.js.

---

1. Why hybrid, not pure black-box

A pure CMA-ES run over all leoInsertionV3 tunables does converge, but it wastes most of its evaluations fighting a physics coupling that the algorithm has no way to see.

The first issue is that PUSH_MAX_GIMBAL_DEG and PUSH_T_S are not independent. Together they define a single physical quantity — the total Δθ of the ascent gravity-turn kick. The controller fires a half-sine torque pulse of amplitude A over duration T, and the resulting rotation is proportional to A·T². CMA-ES sees a 2-D space where one axis (A·T²) actually matters; it burns half its budget exploring the orthogonal direction, which does nothing.

The second issue is that CIRC_TRIGGER_LEAD_S is a 1-D linear problem once the ascent and stage-burn profiles are fixed. Every ascent + stage-burn trajectory has exactly one circ-burn lead time that produces a clean orbit. Running a full CMA-ES over it is overkill.

The third issue is that MECO_TARGET_BOOSTER_FUEL_KG interacts with every downstream phase. Changing it shifts the entire upper-stage mass budget, which changes the optimum for STAGE_BURN_AOA_BIAS_DEG, CIRC_TRIGGER_LEAD_S, and everything else. Tuning it early is wasteful.

The hybrid approach does not replace CMA-ES. It uses domain knowledge to structure the search so CMA-ES operates on low-dimensional, well-behaved subspaces — one tunable at a time, in a physically sensible order. The final refinement (Phase 6) is still a pure CMA-ES loop, just on a search space that has been collapsed and re-anchored by the earlier phases.

The result is the same algorithm, roughly an order of magnitude fewer evaluations for a better-converged result.

---

2. Structural code changes (prerequisites)

Two guidance constants must be removed before tuning, because they conflict with the hybrid structure.

2.1 STAGE_BURN_LOCK_TILT_DEG — deleted

The insertion block had a two-mode stage-burn controller. Before lock, it ran an AoA-tracking PD. After lock, it ran a fixed-tilt PD, engaged once the stage had rotated past a threshold tilt.

The lock mode is now redundant. STAGE_BURN_AOA_BIAS_DEG introduces a target AoA offset that directly controls the tilt-evolution rate during the entire burn — exactly what the lock was there to do, but smoothly and continuously. Keeping both would give two control laws fighting over the same attitude, one of them mode-switched, which is a source of edge cases.

The action is to delete the lock branch from guidance-blocks.js, delete the constant from the insertion block's defaultConstants, from the V3 default preset, from the important-fields list, and from the constant descriptions file.

2.2 MECO_APOGEE_KM — deleted

The ascent block previously supported two MECO triggers. One fired on predicted osculating apogee crossing a target altitude. The other fired when the booster's residual tank fuel (after accounting for the shutdown spool-down burn) reached a target mass.

The two triggers fight each other. Under the hybrid approach we always use the fuel trigger, because MECO_TARGET_BOOSTER_FUEL_KG is what controls how much fuel the booster keeps — and that is the quantity we actually want to tune (see Phase 5). Targeting an apogee altitude instead leaves booster fuel uncontrolled, which was never the mission objective.

The action is to delete the apogee-trigger branch from the ascent block's _checkMeco, set MECO_TRIGGER_ON_FUEL: true as the new default, and delete MECO_APOGEE_KM from all config, preset, and description files.

2.3 Verification

After patching, grep the codebase to confirm zero live references to either constant. The command is:

grep -rn "STAGE_BURN_LOCK_TILT_DEG\|MECO_APOGEE_KM" js/ headless/

Zero hits in js/simJs/guidance/ and headless/ are expected. Historic references inside guidance-experiments.js and guidance_log.html are documentation and can stay.

---

3. Tunables (final list)

After the structural changes above, five quantities are tunable. The first one is derived (see Section 4); the rest are direct scalars.

Number one is ascent_profile_constant, which is derived — it maps to PUSH_MAX_GIMBAL_DEG and PUSH_T_S at run time.

Number two is insertion.STAGE_BURN_AOA_BIAS_DEG, direct, least count 0.1 degrees for search (hardware allows 0.0001).

Number three is insertion.STAGE_BURN_AOA_MARGIN_DEG, direct, least count 0.001 degrees for search (hardware allows 0.0001).

Number four is insertion.CIRC_TRIGGER_LEAD_S, direct, least count 0.01 seconds.

Number five is ascent.MECO_TARGET_BOOSTER_FUEL_KG, direct, least count 1 kilogram.

The term "least count" here means the rounding applied immediately before the value is handed to the simulator, mirroring real hardware limits. Gimbal encoder resolution is 0.01 degrees. Command tick quantization is 0.01 seconds. Tank gauging is 1 kilogram. The stage-burn AoA bias and margin are refined further because the underlying controller accepts finer input than the coast and circularize phases need during search.

---

4. Ascent profile collapse (2D → 1D)

The two PUSH constants are collapsed into a single scalar that CMA-ES actually tunes. The orchestrator performs the derivation on every candidate, before the simulation runs.

4.1 Physics

The PUSH phase applies a half-sine gimbal torque for T seconds. The peak gimbal angle is G. The resulting angular impulse integrates to a total rotation of G·T²/(2π) radians, up to a sign convention. The ascent trajectory through the gravity turn is a monotonic function of this total rotation. Therefore the total rotation is the only degree of freedom that matters for ascent profile. We name it the ascent profile constant, symbol A, and define it as A ≡ G·T²/(2π).

4.2 Collapse procedure

For every candidate scalar A proposed by CMA-ES, the orchestrator runs these steps.

Step one: compute G_raw as 2π·A divided by T0 squared, where T0 is the current PUSH_T_S anchor — the initial value is 4.82 seconds.

Step two: round G to 0.01 degrees. This is the two-decimal hardware rounding.

Step three: compute T_raw as the square root of 2π·A divided by G.

Step four: round T to 0.01 seconds.

Step five: compute A_eff as G·T² divided by 2π. This is the effective profile the simulator will actually fly.

Step six: hand G and T to runSim as the two tunables, and remember A_eff for the next generation.

4.3 Why the feedback matters

Rounding to hardware least-count means the simulator never sees exactly A — it sees A_eff, which may differ by a small amount. If the orchestrator keeps feeding A back into CMA-ES, the algorithm wastes generations re-proposing values that round to the same A_eff, or drifting in a direction that rounding cancels out.

The fix is that after step five, the orchestrator reports A_eff — not A — as the candidate's position in the search space for the next generation. CMA-ES now operates on a well-defined lattice where every distinct point maps to a distinct (G, T) pair after rounding.

---

5. Phase sequence

The tuning runs as six sequential phases. Each phase has a fixed set of frozen constants, a defined search target, and a stopping criterion.

Phase 0 — Anchors

Set MECO_TRIGGER_ON_FUEL to true, which is already the default after Section 2.2. Freeze every tunable at its code-default init value.

PUSH_T_S is 4.82 seconds. PUSH_MAX_GIMBAL_DEG is 0.60 degrees, which implies A is approximately 0.60 times 4.82 squared divided by 2π. STAGE_BURN_AOA_BIAS_DEG is 0.59 degrees. STAGE_BURN_AOA_MARGIN_DEG is 0.001 degrees. CIRC_TRIGGER_LEAD_S is 5.53 seconds. MECO_TARGET_BOOSTER_FUEL_KG is 52,612 kilograms.

This is the baseline. Every subsequent phase improves on it.

Phase 1 — Ascent profile

What is free: A, which drives PUSH_MAX_GIMBAL_DEG and PUSH_T_S via Section 4.

What is frozen: everything else at Phase-0 values.

Search method: 1-D CMA-ES over A, with initial sigma proportional to the current A.

Objective: maximize altitude in kilometers at MECO, subject to mecoTriggered == true and !crashed. There is no orbit-accuracy term here — that is Phase 2's job.

The phase ends when cma.stop() returns true or the max-generations cap hits. The result is an ascent profile that reliably crosses the MECO trigger altitude without loitering.

Phase 2 — Stage burn AoA bias

What is free: STAGE_BURN_AOA_BIAS_DEG.

What is frozen: Phase-1's A value and everything else at Phase-0.

Search method: 1-D CMA-ES, with initial sigma derived from the current value.

Objective: push osculating apogee at stage-burn cutoff toward TARGET_ORBIT_ALT_KM, which is 320 km.

A quick physical recap of what the bias does. AOA_BIAS_DEG sets a target AoA offset from the velocity vector. A larger bias means the nose is held further off-aligned, so thrust acquires a small perpendicular component that slows the natural tilt evolution. A smaller bias means faster tilt evolution.

Two failure modes define the useful range. If bias is too small, the stage rotates too aggressively and apogee never reaches 320 km before the geometry runs out. If bias is too large, apogee reaches 320 km but eccentricity is high — apogee velocity is far below orbital velocity, and circularization has a lot of Δv to make up, which shows up as final orbit error in Phase 4.

Phase 2 finds the middle of that range, where apogee reaches 320 km with reasonable eccentricity to work with.

Phase 3 — Stage burn AoA margin

What is free: STAGE_BURN_AOA_MARGIN_DEG.

What is frozen: Phases 1 and 2.

Search method: 1-D CMA-ES on a narrow range around the current value, with small sigma.

Objective: same as Phase 2 — apogee reaches 320 km — but this is a fine adjustment. The margin controls when the bootstrap PD hands off to the standard PD. Too tight and the handoff happens mid-oscillation. Too loose and attitude is still settling into the standard loop.

The expected search range is 0.001 degrees to 0.01 degrees with 0.001-degree rounding. The initial value 0.001 degrees is already at the low end; Phase 3 mostly confirms it or nudges it up slightly.

Phase 4 — Circularize trigger lead (linear search)

What is free: CIRC_TRIGGER_LEAD_S.

What is frozen: Phases 1 through 3.

Search method: binary search, not CMA-ES, because this is strictly 1-D monotone.

Objective: at circularize spool-out, the next apogee should be exactly CIRC_BURN_END_LEAD_TO_APOGEE_S seconds away, and radial velocity must never dip below V_RADIAL_MIN_MPS during the burn.

The monotonicity works like this. CIRC_TRIGGER_LEAD_S is the time before apogee at which the circ burn starts. A longer lead means the burn completes earlier, so the next apogee is further away at burn end. A shorter lead means the burn ends closer to the apogee, so the 4-second window shrinks. Below some minimum lead, the burn is still firing through apogee, radial velocity goes negative, and the candidate fails. So the mapping from lead to lead-to-apogee-at-burn-end is monotone increasing. Binary search on lead for the target value of 4.0 seconds is valid.

The reason for 4 seconds and not 0: zero lead would mean the burn's spool-out coincides exactly with apogee. That is the theoretical minimum-error configuration, but it is a knife's edge. A fraction of a second of numerical drift in either direction and radial velocity goes negative, which immediately triggers HARD_CONSTRAINT_PENALTY. Instead we stop the burn 4 seconds before apogee and let the COAST_ROTATE_2 and COAST_HOLD_2 phases carry the attitude through to eject. Those phases are already part of the mission script — using them here absorbs the drift without cost.

Phase 4's stopping criterion is that the binary search terminates when the search interval is less than 0.01 seconds, which is one tick. The result is a CIRC_TRIGGER_LEAD_S value that produces a spool-out 4.0 seconds before apogee with high precision.

Phase 5 — MECO fuel target

What is free: ascent.MECO_TARGET_BOOSTER_FUEL_KG.

What is frozen: Phases 1 through 4.

Search method: sequential scan plus bisection, 1-D monotone.

Objective: stage residual fuel, post-payload-eject, near the target defined in constants.js — STAGE_FUEL_TARGET_SUICIDE_OFF_KG when suicide is disabled, or STAGE_FUEL_TARGET_SUICIDE_ON_KG when suicide is enabled, since the suicide burn consumes fuel and the residual target before deorbit is larger.

The monotonicity works like this. Increasing MECO_TARGET_BOOSTER_FUEL_KG means the booster burns less before MECO, so at separation the upper stage carries more mass. That mass must be accelerated, so it costs more stage fuel. Net result: increasing the MECO fuel target reduces stage residual. Monotone in one direction.

The scan runs upward in coarse steps. At each step, a full mission runs and reads the residual. When residual crosses below the target and the mission starts to fail — orbit will not close, or radial velocity dips negative in Phase 4's regime — the scan backs off to the last successful value and bisects between it and the failing neighbour.

Phase 5's output is a MECO_TARGET_BOOSTER_FUEL_KG value that is successful (orbit closes) and leaves stage residual within STAGE_FUEL_TOLERANCE_KG of the target.

Phase 6 — Iterative refinement

What is free: the four tunables from Phases 1 through 4, re-optimized together.

What is frozen: MECO_TARGET_BOOSTER_FUEL_KG at the Phase-5 result.

Search method: CMA-ES on the 4-D combined space, iterated. Run to convergence, take the best point, restart CMA-ES from that point, repeat until the score plateaus.

The definition of plateau: run CMA-ES until cma.stop() returns true. Record the best score. Restart from that point with the same sigma0. Repeat. When the improvement between consecutive restarts drops below PHASE6_PLATEAU_THRESHOLD, which defaults to 5%, stop.

Starting Phase 6 from the Phase-5 result means CMA-ES begins in a narrow, high-quality region of the search space rather than cold. The 4-D volume it needs to explore is small, so iterations are cheap.

---

6. Score function

Every evaluate(candidate) call returns a single scalar.

Hard constraints — checked first

If any of the following is true, the score is HARD_CONSTRAINT_PENALTY, which is -1e9, immediately, and no soft-score terms are computed. The conditions are: tracker.maxG greater than MAX_G_FORCE; tracker.maxQKPa greater than MAX_DYNAMIC_PRESSURE_KPA; status.crashed; or radial velocity during the circ burn dipping below V_RADIAL_MIN_MPS.

Soft score — computed only if hard constraints pass

The soft score is: SCORE_SUCCESS_BONUS times the success flag, minus SCORE_ORBIT_ERROR_WEIGHT times orbit error, plus SCORE_BOOSTER_FUEL_LEFT_WEIGHT times booster fuel left in kilograms, minus SCORE_TIME_TO_DEPLOY_WEIGHT times time to deploy in seconds.

Field definitions

The success flag is a boolean, true when all of the following hold: guideStatus.circAchieved is true; radial velocity stays at or above V_RADIAL_MIN_MPS throughout the circ burn; final osculating apogee and perigee are within tolerance of TARGET_ORBIT_ALT_KM, with tolerance of plus or minus 5 km.

The orbit error scalar summarizes the miss distance. It is the absolute value of final apogee minus 320, plus the absolute value of final perigee minus 320, plus 1000 times the absolute value of eccentricity. The thousand-times weight on eccentricity makes a highly-elliptical-but-both-radii-close orbit still score poorly.

Booster fuel left in kilograms is computed from tracker.initialBoosterFuelKg minus the booster body's current memberFuel[0] at mission end. After separation, the booster continues to coast, so its fuel is whatever was left at separation, since nothing burns on it after.

Time to deploy in seconds is guideStatus.deployCommandSimTime at mission end, i.e. the wall-clock sim time from t=0 to payload release. Lower is better, but only marginally weighted.

The priority order from highest to lowest weight is: the success gate first, then orbit error with weight 100, then booster fuel left with weight 0.05, then time to deploy with weight 0.02.

---

7. Constants file

All magic numbers live in headless/cmaes/constants.js. The orchestrator imports from it. Nothing is hardcoded elsewhere.

The categories are: mission targets — orbit altitude, residual fuel targets, circ-burn end-lead, V-radial floor. Hard constraints — max G, max Q. Rounding — hardware least-count per tunable. CMA-ES hyperparameters — population size, sigma0, generation cap, tolerances, plateau threshold. Initial anchors — Phase-0 values taken from code defaults. Score weights — the four coefficients in the soft-score formula.

To change any of these, edit constants.js only.

---

8. What the orchestrator needs

8.1 Files handed to the AI assistant

Three files, around 500 lines total: headless/runner.js, the simulator launcher, which should not be modified; headless/run.js, the usage example, which should not be modified; and headless/configs.js/v3-leo.json, the objective spec, which can be edited freely.

Plus this README and constants.js.

The assistant does not need the 14 sim source files themselves. The runSim() contract described in Section 8.2 is all it interacts with.

8.2 The runSim contract

The runSim() function takes an options object and returns a result object.

The options object has: stackId, a string defaulting to stk_falcon9-b5; vehicleId, a string defaulting to falcon9-b5-booster; guide, a string set to leoInsertionV3; durationS, a number giving sim-seconds to run; quiet, a boolean, true to suppress progress output; environment, an object with atmosphere, slosh, imu, and a nested wind object containing enabled, speed, and directionDeg; fueling, an object with boosterPct and stagePct in the range 0 to 100; and tunables, an array of objects each having path and value, where paths match the tunable paths from Section 3 exactly.

The result object has: ticksRun, haltedByLoop, wallMs; a status object containing simTime, activeBodyIndex, halted, crashed, landed, a nested guideStatus object described in Section 8.3, and a bodies array where each entry has rx, ry, vx, vy, theta, omega, altitudeKm, fuelMass, memberFuel array, crashed, landed, settled, isActive, isDiscarded, payloadReleased, and members array; and a tracker object containing maxG, maxQKPa, initialFuelKg, initialBoosterFuelKg, initialStageFuelKg, and ticksRun.

8.3 Guide status fields (leoInsertionV3)

The score function reads these fields from status.guideStatus: phase, a string; ascentPhase, a string; mecoTriggered, a boolean; splitDetected, a boolean; fairingOpened, a boolean; altKm, a number; apogeeKm, a number giving osculating apogee; perigeeKm, a number giving osculating perigee; coastDeltaV, a number giving the Δv remaining to circularize; coastTRem, a number giving seconds to apogee at time of measurement; coastVOrbital, a number giving target circular velocity; circCurrentV, a number; circTargetV, a number; circAchieved, a boolean; deployCommandSimTime, a number giving absolute sim time of release; payloadCleared, a boolean; suicidePhase, a string; and suicideTrimDone, a boolean.

Any guide status field not used by the score is still forwarded. The score ignores it.

8.4 Determinism guarantee

The simulator is fully deterministic. Same options give the same result and the same score, bit-for-bit. No seeds and no repeats are needed per candidate.

---

9. Expected compute budget

Per runSim call at durationS = 1500, single-core wall time is roughly 15 to 20 seconds, for around 120,000 sim ticks.

Per CMA-ES generation, with population size 16, 16 candidates take about 4 to 5 minutes on a single core. Parallelised across N cores, it becomes about 5/N minutes.

The total budget for the whole pipeline without parallelism looks like this. Phase 1 needs roughly 50 to 80 candidates, 15 to 30 minutes. Phase 2 needs roughly 60 to 100 candidates, 20 to 35 minutes. Phase 3 needs roughly 30 to 50 candidates, 10 to 20 minutes. Phase 4 needs roughly 10 candidates, 3 to 5 minutes. Phase 5 needs roughly 20 to 30 candidates, 6 to 10 minutes. Phase 6 needs roughly 600 to 2,000 candidates, 3 to 10 hours.

Total single-core: roughly 4 to 12 hours. Parallelised across 8 cores: 30 to 90 minutes.

The bulk is Phase 6, which is expected. Everything before Phase 6 is a scaffold to give Phase 6 a good starting region.

---

10. Order of operations for implementation

First, apply the two structural code changes from Section 2 and verify with grep.

Second, write headless/cmaes/constants.js.

Third, write headless/configs.js/v3-leo.json with the final 5-tunable paths from Section 3. Note the paths use lowercase group names — ascent. and insertion. — and are nested, so TARGET_ORBIT_ALT_KM lives at insertion.TARGET_ORBIT_ALT_KM, not at root.

Fourth, write headless/cmaes/evaluate.js, which takes a candidate struct, performs the ascent profile collapse from Section 4, builds the tunables array, calls runSim, computes the score from Section 6, and returns score, metrics, and A_eff.

Fifth, write headless/cmaes/score.js, a pure function taking result and constants and returning a score.

Sixth, write headless/cmaes/orchestrator.js, the six-phase state machine from Section 5, using the cmaes npm package for 1-D and 4-D CMA-ES phases, and a custom binary search for Phase 4.

Seventh, run Phases 1 through 4 first and inspect intermediate results. Confirm the ascent profile collapse is producing distinct (G, T) pairs for distinct A values. Confirm Phase 4 binary search converges.

Eighth, run Phase 5, verify it finds a MECO fuel target within tolerance of the residual target.

Ninth, run Phase 6 to convergence.

---

11. Failure modes to watch

If Phase 1 converges but Phase 2 cannot reach 320 km, the ascent profile is too aggressive. Re-run Phase 1 with a lower A init and tighter sigma.

If Phase 4 binary search diverges, the circ-burn controller is not monotonic in that regime. Check for radial velocity oscillations well above the target. A possible root cause is that STAGE_BURN_AOA_BIAS_DEG from Phase 2 is at the edge of its range. Re-run Phase 2.

If Phase 5 scan does not show monotone behavior, MECO_TRIGGER_ON_FUEL may not be taking effect. Verify the patch from Section 2.2 is applied and that _checkMeco enters the fuel branch.

If Phase 6 does not improve on Phase 5, the anchoring points are already optimal within the discretization lattice. Tighten least-count values in constants.js if finer resolution is genuinely needed.

---

12. Non-goals

Landing the booster is not part of this mission profile; the vehicle is expendable-stage, and the booster coasts to a ballistic impact with no landing burn.

Fairing recovery is not attempted. Fairing halves are spawned but not controlled.

Multi-orbit phasing is out of scope. The mission ends at payload release.

Robustness to wind and IMU noise is not tuned here. Tuning is done with both disabled; re-tuning for wind is a separate exercise.

---

Bhai ye poori README hai — bina code block ke, prose form me, copy karne ke liye ready. Agar chahein to iske saath constants.js aur v3-leo.json bhi prose me likh dun, ya wo code form me hi rakhna theek hai?