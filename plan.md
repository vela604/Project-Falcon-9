# PLAN.md — Landback (booster RTLS) for Project-Falcon-9

> READ FIRST. Single source of truth. Compressed history: Chats 1-9 one-liners,
> Chats 10-11 (active LB work) full detail. User does serious research — pushback
> with data, not validation. After every result: update §4, §10, §11.

## 1. Goal
Falcon 9 Block 5 → 320km LEO + payload deploy + booster RTLS via `landbackV1`
(exact clone of `leoInsertionV3` + new `standardRTLS` block). Stage flies LEO
mission in parallel with booster RTLS. Both tick per tick.

## 2. Architecture (verified)
- 2D planar, Earth-centred inertial. Nose = (-sinθ, cosθ). +τ → +θ.
- 1-tick command latency. All controllers predict one step ahead via deriveForState.
- 3 frames: inertial (gravity, Kepler, trajectory), air-relative (drag, fins, coast),
  ground-relative (pad targeting, touchdown).
- Air-relative retrograde atan2(relVx, -relVy) for coast holds. Inertial retrograde
  for burns. Earth-relative ax targets need +2·ωE·vRad Coriolis correction.
- Physics: RK4, dt=1/80. Booster M≈36t, I≈4.95e6, comY≈9m, comX≈0.
- Single center Merlin at LB: Fmax≈850kN, Fmin≈340kN. Gimbal ±8°, rate 40°/s,
  accel 200°/s². Spool 2s, shutdown 1.2s. RCS 4 pods.

## 3. Physics fundamentals (see physics_*.js extracts)
- Thrust F body-Y, gimbal δ: Fx_body = F·sinδ, Fy_body = F·cosδ.
- Torque about CoM: τ = -comY·Fx_body + e.x·Fy_body ≈ -9·F·sinδ (e.y=0 for F9).
- Environmental torque (derivation.js): torqueDrag + gridFinTorque + torqueGravityGradient.
- Environmental accel: gVecX/Y + dragVec/M + Fnormal/M + gridFinFx/M.
- Command interface: cmdSetAllThrottle(mdot), cmdSetGimbalRate(deg/s),
  cmdGridFinsControl(deg), cmdRcsDuty(dict). All latency 1 tick.

## 4. Status

| Phase | Status |
|---|---|
| FLIP | ✅ 19.8s, 0.00° overshoot |
| BOOSTBACK_BURN | ✅ finalErr=0.0000°, fuel 27495kg |
| PRE_ENTRY_STEER | ✅ DRIFT mode, align at 90km |
| ENTRY_BURN | ✅ cutoff 600m/s, impactErr 45m |
| POST_ENTRY_STEER | ✅ ceiling ~600m, bias -750 |
| LANDING_BURN_ALIGN | ✅ fin ramp 0, exit 2km |
| LANDING_BURN | 🟡 spool ✅, sister-find ✅, traj-lock ✅, ALIGN FAILS — gimbal clamp |
| TOUCHDOWN | ⬜ stub |

## 5. Verified phases (Chats 1-9, one-line summary)

- **FLIP (5-8):** aero-aware v3, pusher moved to FLIP, 19.8s / 0° overshoot, k=1.03.
- **BOOSTBACK (4):** 3-engine → center taper → spool cutoff, pad 0.0000° error.
- **PRE_ENTRY (6):** DRIFT mode, small ω predictive coast 90km, air-relative retrograde.
- **ENTRY_BURN (7):** full throttle C,0,180, gimbal C, cutoff 600 m/s.
- **POST_ENTRY_STEER (7-9):** closed-loop grid fins, PES-BOUND ceiling ~600m, bias -750.
- **Mass fix (7):** phantom payload 47t→35t, I 17.3e6→4.74e6. All pre-fix tuning invalid.
- **Fnormal linear-accel fix (7):** hull lift steers trajectory, not just attitude.

## 6. LANDING_BURN_ALIGN (Chat 10)

Separate phase (POST_ENTRY_STEER → LANDING_BURN_ALIGN → LANDING_BURN → TOUCHDOWN).
Exits at LANDING_BURN_ALT_KM=2. Fin ramps current→0 at POST_ENTRY_GRIDFIN_RAMP_DEG_S=3°/s.
Gimbal zeroed via _gimbalCmdMsg(0) — no threshold, exact zero via 2-tick Newton.
Alpha coasts to aero equilibrium (-0.17°). RCS off. Verified.

## 7. LANDING_BURN (Chat 10-11, ACTIVE)

Phases:
1. SPOOL: fire C 100%, wait mdot ≥ 99% max. lbSpooled=true.
2. Capture6: freeze a0rot, v0rot, dsrot, a0lin, v0lin, dslin at spool.
3. Sister-find: log-grid scan for T0 where both rot & lin solvable. Pick score=crossings sum, shortest L.
4. Traj-lock: solve q,k both at T0_pick. Store _st.lbTrajPow = {rot, lin, T0, a0rot, a0lin}.
5. Per-tick ALIGN: α_target(elapsed), ax_target(elapsed) → 2×2 gimbal/throttle solve.
6. Exit to TOUCHDOWN when aligned OR T0 exhausted.

Solver (power-law from sinusoidal-solver.html):
- α(t) = a₀·(1-(t/L)^q) - k·sin(πt/L)
- Boundary: α(0)=a₀, α(L)=0 by construction
- G(q) = q/(2(q+1)(q+2))
- Quadratic: a₀·G·L² + (v₀/2)·L - Δs = 0 → invert to q
- k = (π/2)·(a₀·q/(q+1) + v₀/L)
- Two (q,k) roots per system per L, pick crossings ≤ 1.

ABANDONED: sinusoidal branch solver A·sin(ft+k1)+k2 — discriminant
9v₀²+12a₀Δs < 0 for typical linear state → no valid T0. Preserved as
_lbSolve_ABANDONED_ / _lbRange_ABANDONED_ for reference.

2×2 solve (per tick):
Predict S(k+1) via current command + gravity + aero.
reqTorque = I_pred·α_target - envTorque_pred
reqFx_world = M_pred·(ax_earth_target + 2·ωE·vRad_pred - gVecX - aeroAcc.ax)

  | comY  -comX | | Fx_body |   | reqTorque    |
  | cosθ  -sinθ | | Fy_body | = | reqFx_world  |

det = -comY·sinθ + comX·cosθ
Fmag = √(Fx_body²+Fy_body²), δ = atan2(Fx_body, Fy_body)

Safety guards:
- Fy_body < 0 → clamp to M_pred·0.01 forward (backward thrust impossible)
- |det| < 1e-2 → fallback vertical hold (FxBody=reqTorque/comY, FyBody=0.95·M·g)
- Gimbal clamp ±8°, throttle clamp [Fmin, Fmax]

## 8. Current failure (Chat 11, decisive)

Capture6 at spool (typical):
  θ=-1.66°, ω=0.242°/s
  x=+16.0m East, vx=-5.45 m/s (West, closing)
  a0rot_obs=0.0031 rad/s², v0rot_obs=0.0042 rad/s, dsrot=+0.029 rad
  a0lin_obs=1.730 m/s², v0lin_obs=-5.45 m/s, dslin=-15.97 m

Sister-find: common range [7.16, 13.23], picked T0=7.54s.
Trajectory: q_rot=0.599, k_rot=0.0027, cross_rot=1 | q_lin=0.269, k_lin=-0.561, cross_lin=0.

ALIGN behavior:
- Linear: PERFECT. x 16m → 0m, vx -5.45 → -0.02 m/s.
- Rotational: FAILS. θ -1.66° → 0 → +2.21° → -3.48° at T0 end.
  - Gimbal clamps 8° at t=525.6 (elapsed 3.0s of 7.54s)
  - θ overshoots because clamped torque >> requested
  - Never recovers, oscillates to -3.48° at exit

Root cause hypothesis:
2×2 gimbal-only solve singular near θ≈0. At θ=0:
- Row 2: [1 0]·[Fx_body;Fy_body] = Fx_world_target → Fy_body unconstrained by linear
- Row 1: [comY -comX]·[Fx_body;Fy_body] = reqTorque — comX≈0, ~no constraint on Fy_body
- Linear target Fx_world ≈ -33kN, torque target Fx_body ≈ small
- Required Fy_body → very negative → δ → 180° (backward) → clamp 8° forward
- Actual torque at 8°-clamped gimbal >> requested → over-rotate → oscillation

Additionally: α_target has one crossing (cross_rot=1). When α_target negative
mid-trajectory, reqTorque negative, Fx_body negative, Fy_body very negative →
clamp → overshoot.

Deep question: is gimbal-only 2DOF (θ→0 + x→0) simultaneous feasible given
Fmax/Fmin/±8° limits, or fundamentally limited by the singularity?

## 9. Sister solver + LB lab (Chat 11)

atlas-prism/tests/landback-align-lab.html — rich diagnostic page:
- Init captures SA/EB/LBA checkpoints
- Bias input + rebuild LBA from EB
- Run LB with auto/manual T0
- Shows: capture6, sister ranges, traj q/k/cross/L, per-tick charts
  (α target vs actual, ω, θ, gimbal, vx, x, thrust, Fy_body), sample table, event log.

sister_solver.html (extracted) — mathematical solver reference.

Exposed status fields (guidance-blocks getStatus → guidance.js forward → HTML):
- lbSpooled, lbAlignStartT, lbAlignT0, lbAlignDeltaMax
- lbCapture6 {a0rot, v0rot, dsrot, a0lin, v0lin, dslin}
- lbTrajPow {T0, a0rot, a0lin, rot:{q,k,crossings,L}, lin:{q,k,crossings,L}}
- lbSisterRanges [[lo,hi],...], lbSisterPick
- lbLastFyBody (raw pre-clamp Fy_body)

## 10. Open questions (Claude handoff)

1. Gimbal-only 2DOF feasibility — singularity unavoidable, or removable by
   reformulation (different free variable, multi-tick prediction)?
2. If infeasible, which option most promising?
   - A. RCS hybrid — gimbal linear, RCS top+bottom pure torque. ~60 kN·m available.
   - B. Sequential phases — θ→0 then x→0. No singularity.
   - C. Grid fins as torque — Q~16000 Pa, ~400 kN·m. Free, decouples.
   - D. Multi-tick gimbal prediction — 40°/s slew, 1-tick predict insufficient.
   - E. Target θ = -0.3° (avoid θ=0, small residual accepted).
   - F. Long T0 (13s vs 7.5s) — cross_rot=0 monotone, avoids negative α dip.
3. Real F9 comparison — vertical descent + small x corrections, NOT 2DOF alignment.
   Are we over-engineering?

## 11. Changelog (recent)

- Chat 11: Power-law solver integrated. Sister-find at capture6, traj-lock once.
  ALIGN fails rotation: gimbal clamps 8° near θ=0, θ oscillates to -3.48° at exit.
  Linear perfect. Diagnostic HTML. Claude handoff prepared (prompt.md).
- Chat 11 (early): Lock-once fix — T0 re-computed per-tick, traj invalidation.
  Now T0 frozen at spool.
- Chat 10: LANDING_BURN_ALIGN phase separated. Old sinusoidal branch abandoned.
- Chat 9: Bias -750 → LB trigger 28m East. PES ceiling ~600m.
- Chats 1-8: see §5. Mass fix, PES-BOUND, flip v3, all pre-LB phases.

## 12. Process

- Hinglish, short, answer-first, no preamble/praise.
- Pushback with data. User: "meri baaton ko challenge karo, khush karne wale answer mat do."
- No constants unless user requests.
- Verify in sim only. No offline harnesses.
- When uncertain: "need X" not guess.

## 13. Files for handoff

Extraction in /storage/emulated/0/Download/claude-lb-follow-prep/:
- standardrtls_full.js, lb_case.js, lb_glue.js
- derivation.js, physics_{header_frames,derivatives,mainthrust,actuator,step_head}.js
- sister_solver.html, landback-align-lab.html
- plan.md (this file), prompt.md
