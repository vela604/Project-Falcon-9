# atlas-prism Universal Bootstrap — state.md (v4)

Last updated: after Round 3 (parent range decided, boundary search approach chosen).
Plan: prompt.md v4. Context: handoff v4.
Protocol: chat end me poora state.md. Sirf proven facts, guess = "HYPOTHESIS".

================================================================================
## 1. Step status
================================================================================
| Step | Kaam | Status |
|---|---|---|
| 1 | Caps fix | NEXT |
| 2 | Reproduce 320 + 2000 | pending |
| 3 | Boundary search (G_min, G_max) | pending |
| 4 | lib/bootstrap.js bias cliff | pending |
| 5 | bootstrapPoint(alt) | pending |
| 6 | Altitude continuation | pending |
| 7 | Altitude-aware limits | pending |

================================================================================
## 2. Done log
================================================================================
- Round 1-3: handoff v2, code files padhe, contradictions resolve.
- Parent bias range [-3°, +3°] DECIDED (empirical ±4 oscillation recoverable, 
  ±3 for safety). Guidance block fix SKIPPED (controller already critically damped).
- Boundary search approach chosen (bias=+3 → G_min, bias=-3 → G_max).

================================================================================
## 3. Environment
================================================================================
- Phone: Termux + SPCK, 8 cores, localhost:7700. 2000 km FULL eval ~15s.
- Repo: vela604/Project-Falcon-9.
- Scope v1: F9 B5 standard stack (stk_falcon9-b5), payload 12000 kg, target 
  160-2000 km, deorbit OFF, fuel 100%.
- Constants: CONFIG.DT = 1/80, EARTH_RADIUS = 6371000, GM_EARTH = 3.986004418e14.
- Quanta: G 0.01°, T 0.000125s, bias 0.0001°, lead 0.0125s, MECO 1kg.
- Point contract: {Gi, Tn, bi, li, meco} (integers).
- worker-sim importScripts order: js/componentLibrary → customDesign → fleet → 
  js/config → simJs/core/{massProps, environment, vehicle, rcs, physics, collision} 
  → simJs/guidance/{imu, derivation, guidercs, guidance-blocks, guidance} 
  → js/guideConfigDefaults → lib/{config, sim, lattice, hook, registry, primitives} 
  → engines/pro-alpha.

================================================================================
## 4. Verified facts
================================================================================
- worker-sim hard caps: SA 300s (line 230), CH 800s (253), COAST_ROTATE_2 300s 
  (288), FULL 300s (319). TunerConfig.durationCapS = 770. 2000 km mission 1953s 
  → silent CAP. **Step 1 fix.**
- coastDeltaV = max(0, vOrb(rApo_cap) − vApo_cap) (guidance-blocks 1328-1330). 
  Stage burn apogee ≥ TARGET_ORBIT_ALT_KM pe cut.
- checkHard: Δv hard-fail nahi. maxG > 6.02 hard-fail (lattice.js:148).
- FE classification: primitives.js 232 aur 608, band default [750,850]. 
  Residual band: primitives.js ~497 ([100,200], deorbit ON [500,600]).
- config: meco.probeStartKg 20000, fixedFallbackKg 0, roughScan.minRange [20000,80000]. 
  MECO < 20000 kabhi probe nahi hota.
- 320 km baseline: G .60, T 4.82, bias .59, lead 5.53, MECO 52612 → deploy 590.46s, 
  apo/peri 320.111/319.999, residual 848.7 kg, maxQ 24.75 kPa, maxG 4.815.
- 320 km refs: MECO 50000 (G .62, bias .78, lead 5.65); 55000 (G .60, bias 1.16, 
  lead 4.46); 60002 (G .59, bias 1.804, lead 3.90, residual ~190); 60494 (G .59, 
  bias ~1.88, lead ~3.79, residual ~150).
- 2000 km manual point: MECO 0, G 0.65, T 4.82, bias 0.59, lead 7.82. 
  Timeline: SA 155.82s → stage burn 158.84 → RCS_BOOST 512.85 (stage fuel 6.01t) 
  → COAST_WAIT 567.15 (alt 719.97, Δv 924.99, t_rem 1367.7s) → CH 1893.73 → 
  CIRC 1924.04 → DONE 1952.03 (apo/peri 2000.4/2000.0), residual ~480kg, 
  run 1953s. Booster end fuel ~2.7t.

================================================================================
## 5. Resolved contradictions
================================================================================
- coastDeltaV formula: handoff v2 (vOrb(rApo)−vApo) sahi. hook comment 
  (v_circ(target)−v_apo) approximate.
- tHalf: 2000 km ≈ 3811s, 320 km ≈ 2724s.
- Residual at 2000 km: MECO badhane se residual girta hai (320 km slope −0.089 
  kg/kg). Band MECO ~few t pe reachable ho sakta hai (HYPOTHESIS, Step 3 test).
- PEAK G 3798g sim event-log bug, real maxG safe. Tuner m.maxG alag (Step 2).
- bias 0.59 at 2000 km: confirmed.
- Guidance block fix: NOT NEEDED. Controller critically damped (KP=1, KD=2 = 2√KP).
  Bias > ~3° pe saturation. Parent range [-3, +3] se solve.

================================================================================
## 6. OPEN items
================================================================================
1. 320 km Δv: 599 vs 696.25 — Step 2 measure.
2. Booster fuel 2.7t at MECO=0 — spool-down? Step 2.
3. Tuner m.maxG on 2000 km (< 6.02 expected) — Step 2.
4. 2000 km residual band reachable MECO — Step 3.
5. G_min, G_max actual values — Step 3 boundary search.
6. Contour slope (°bias per 0.01G) actual — Step 3.
7. Window width vs G — Step 3.
8. "Touch hypothesis": G1 max ≈ G1+0.01 min? — Step 3 data.
9. Residual band + Δv band altitude-aware shape — Step 7.
10. rApo_cap exact definition — agar seed formula Δv pe depend kare to.

================================================================================
## 7. Rules reminder
================================================================================
Code pehle, ek chat = ek step. js/* untouched. Metrics scalars only. 
Naya logic lib/bootstrap.js. "Files badli ya rm?" puchho pehle. 
Priority: code > state.md > handoff.

================================================================================
## 8. Harvest plan (Step 6)
================================================================================
Har success ek entry (format prompt.md §2). Alag JSON store (main thread). 
runEval metrics me nahi. Fayda: same-stack-different-alt pe scaling fit se seed.