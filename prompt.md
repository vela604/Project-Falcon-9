Booster landing burn alignment — physics + guidance + target equation follow ka problem.
Yeh serious research project hai. Don't validate, verify. Don't propose solution without
understanding why previous attempts failed.

Files attached: full standardrtls block, LB case, landback glue, physics sections,
derivation.js, guideConfigDefaults.js, sinusoidal-solver.html, landback-align-lab.html.

## Project context (short)

Falcon 9 RTLS 2D planar sim. Booster returns to pad. Phases: FLIP -> BOOSTBACK ->
PRE_ENTRY_STEER -> ENTRY_BURN -> POST_ENTRY_STEER -> LANDING_BURN_ALIGN -> LANDING_BURN -> TOUCHDOWN.

Phases 1-6 working (flip 19.8s/0° overshoot, boostback 0.0000° error, entry burn 45m
impact, PES ceiling ~600m). Currently at LANDING_BURN_ALIGN — booster vertical descent
2km->pad, try to align theta->0 and x->0 simultaneously before touchdown.

User goal: force booster to follow a target acceleration trajectory EXACTLY.
Then TOUCHDOWN becomes trivial (already aligned, just descend).

## Physics fundamentals (verified from code)

- 2D planar, Earth-centred inertial.
- State: rx, ry, vx, vy, theta (nose = (-sinθ, cosθ)), omega (rad/s)
- RK4 per tick, dt = 1/80s.
- Booster at LB: M ~36t, I ~4.95e6 kg·m², comY ~9m above base, comX ~0.
- Thrust model (physics_mainthrust.js):
    Thrust F along body-Y with gimbal δ: Fx_body = F·sin(δ), Fy_body = F·cos(δ)
    Torque about CoM: τ = (e.x - comX)·Fy_body - (e.y - comY)·Fx_body
    For F9: e.y = 0, so τ ≈ -9·F·sin(δ)
- Atmos drag + hull lift (derivation.js): dragVec + Fnormal (Barrowman + Allen-Perkins)
- Gravity: gVecX/Y from Earth center
- Coriolis (in guidance, targeting earth-relative ax):
    ax_earth = ax_inertial - 2·ωE·vRad
- 1-tick command latency: command sent tick k applies tick k+1

## Booster actuation (constraints)

- Single center Merlin (engine "C" during LB):
    Fmax ~850 kN (mdot 306 kg/s × Ve ~2780)
    Fmin ~340 kN (minMassFlowRate ~119 kg/s)
    Spool: full in ~2s, shutdown ~1.2s
    mdot rate limit: rateFrac·maxMF·dt per tick
- Gimbal: ±8° max, slew 40°/s, accel 200°/s²
- Grid fins: LB altitude Q~16000 Pa, ~400 kN·m torque available (currently held at 0)
- RCS: top+bottom pairs pure torque ~60 kN·m, lateral pair ±156 kN·m

## Guidance architecture

Guidance runs in separate worker, receives snapshot, sends commands with targetBodyIdx.
See lb_glue.js for block instantiation and tick.

Command builders: cmdSetAllThrottle(mdot_per_engine), cmdSetGimbalRate(rate_deg_s),
cmdSetGimbalAccel(accel_deg_s²), cmdGridFinsControl(deg), cmdRcsDuty(dict).

Latency: send tick k -> applied tick k+1.

## LB phases (standardrtls_full.js, lb_case.js)

Phase progression:
1. SPOOL (~2s): fire 100%, wait until all engines at 99% max flow. lbSpooled=true triggers.
2. Capture6: freeze a0rot, v0rot, dsrot, a0lin, v0lin, dslin at spool tick. Store in _st.lbCapture6.
3. Sister-find (once): log-grid L scan for T0 where both rot & lin feasible under power-law.
   Intersect ranges. Pick score=sum(crossings), shortest L. Store _st.lbSisterRanges, _st.lbSisterPick.
4. Traj-lock (once): solve q,k both at T0_pick. Store _st.lbTrajPow
   = {rot:{q,k,L,cross}, lin:{q,k,L,cross}, T0, a0rot, a0lin}.
5. Per-tick ALIGN: alpha_target(elapsed), ax_target(elapsed) -> 2×2 gimbal/throttle solve.

## Target trajectory (sinusoidal-solver.html — READ CAREFULLY)

Model: alpha(t) = a0·(1 - (t/L)^q) - k·sin(pi·t/L)

Boundary by construction:
    alpha(0) = a0     (baseline at t=0)
    alpha(L) = 0      (both terms zero)

Free params: q (shape), k (sine amplitude), L = T0 (given)

Given (a0, v0, ds, L), solve q, k:
    G(q) = q/(2(q+1)(q+2))
    Quadratic: a0·G(q)·L² + (v0/2)·L - ds = 0 -> invert to q via discriminant
    k = (pi/2)·(a0·q/(q+1) + v0/L)
    Two (q,k) roots per system per L, pick crossings <= 1

Boundary check:
    omega(L) = v0 + integral(alpha) dt = 0
    s(L) - s(0) = v0·L + double_integral(alpha) dt = ds

Sister finder: both rot and lin must be solvable at same L. Scan L on log grid,
find ranges where both _lbSolvePowAtT0 return non-null. Intersect. Pick within.

For LB aligned:
    Rotational: a0_rot = alpha(0) at spool (environmental alpha), v0_rot = omega(spool),
                ds_rot = -theta_local(spool)
    Linear: a0_lin = ax_earth(spool, thrust-included), v0_lin = vx(spool),
            ds_lin = -x_from_pad(spool)

Where ax_earth = gVecX + aeroAcc.ax + thrustX/M - 2·omegaE·vRad (at spool).

## Current per-tick controller (LB case code)

Given alpha_target(t), ax_target(t), at predicted next state:

1. Predict S(k+1) via current command + gravity + aero (deriveForState).
2. From torque target: Fx_body = (I·alpha_target - envTorque_pred) / comY
   (approx; exact: comY·Fx_body - comX·Fy_body = I·alpha_target - envTorque)
3. From linear target: Fx_world_target = M·(ax_inertial_target - gVecX - aeroAcc.ax)
   where ax_inertial_target = ax_target_earth + 2·omegaE·vRad_pred
4. Solve 2×2 for Fx_body, Fy_body:
     [comY  -comX] [Fx_body]   [I·alpha_target - envTorque]
     [cosθ  -sinθ] [Fy_body] = [M·(ax_inertial_target - aero - g)]
     det = -comY·sinθ + comX·cosθ
5. Fmag = sqrt(Fx_body² + Fy_body²), delta = atan2(Fx_body, Fy_body)
6. Clamp gimbal ±8°, throttle Fmax/Fmin
7. Command gimbal rate (per-tick rate needed = (delta_cmd - delta_cur)/dt)
8. Command throttle

Safety:
- Fy_body < 0: clamp to M_pred·0.01 forward (backward thrust impossible)
- |det| < 1e-2: fallback vertical hold (FxBody=reqTorque/comY, FyBody=0.95·M·g)

## Evidence from actual runs

Spool-complete state (typical):
    theta_local = -1.66°, omega = 0.242°/s
    x = +16.0m East of pad, vx = -5.45 m/s (moving West, back toward pad)
    h = 1578m AGL, vy = -195.15 m/s (down)
    Gimbal = 0.00°, thrust = 859543N

Sister-find (from this capture6):
    a0rot_obs = 0.0031 rad/s² (= 0.18°/s², from aero + gravity)
    v0rot_obs = 0.0042 rad/s (0.24°/s)
    dsrot = +0.02901 rad (theta -> 0)
    a0lin_obs = 1.730 m/s² (East — thrust tilt from theta=-1.66° nose)
    v0lin_obs = -5.45 m/s
    dslin = -15.97 m (target: 0, from +16m East -> travel 16m West)

    Common T0 range: [7.16, 13.23] s
    Picked T0 = 7.54s (score=1, one of rot/lin has 1 crossing)
    Locked trajectory:
        q_rot=0.5989, k_rot=0.002739, cross_rot=1
        q_lin=0.2686, k_lin=-0.561171, cross_lin=0

Per-tick ALIGN behavior (best failure):

Actual theta trajectory (sampled 0.5s):
    t=522.60 (spool):  theta=-1.66°, omega=0.242°/s, gimbal=0.00
    t=523.10:          theta=-1.57°, omega=0.244, gimbal=0.24
    t=524.10:          theta=-1.08°, omega=0.488, gimbal=1.84
    t=525.10:          theta=-0.61°, omega=0.650, gimbal=4.05
    t=525.60:          theta=-0.01°, omega=1.794, gimbal=8.00 CLAMP
    t=526.10:          theta=+0.97°, omega=1.898, gimbal=8.00 OVERSHOOT
    t=527.10:          theta=+2.21°, omega=0.169, gimbal=0.75 (released)
    t=528.10:          theta=+0.41°, omega=-1.185, gimbal=-1.88
    t=530.22 (fail):   theta=-3.48°, omega=-1.849, gimbal=-3.62

Actual x trajectory:
    t=522.60: x=+16m, vx=-5.45
    t=527.10: x=+1m, vx=-0.29 (linear converged!)
    t=530.22: x=-0.1m, vx=-0.6 (small overshoot)

Linear was PERFECT. Rotation failed.

Failure event sequence:
- t=525.6: gimbal hits 8° clamp (peak torque way over required)
- Between 525.1->525.6, gimbal 4.05° -> 8.00° (rate demand), triggering clamp
- Once clamped, actual torque >= requested (8° vs demanded ~3-4° effective), over-rotation
- After release (527.1), gimbal swings back at -1.88°, theta oscillates -3.48° at T0 end

## Root cause analysis (hypothesis — verify)

The 2×2 gimbal-only solve is singular near theta ≈ 0.

At theta=0:
- Row 2 becomes [1 0] [Fx_body; Fy_body] = Fx_world_target
- Fy_body only in row 1 (which uses tiny comX ≈ 0)
- Linear target Fx_world ≈ -33 kN (West)
- Torque target Fx_body ≈ small (~1 kN)
- Fy_body must be huge (~-250k N) to satisfy both
- Fmag ≈ 250 kN, delta ≈ atan2(1k, -250k) ≈ ±179° (backward thrust)
- Clamp to 8° -> thrust forward, applied torque ≈ 8° effective ≈ 24× over target

Fundamental: at theta ≈ 0, Fx_body ≈ 0 and Fx_world ≈ -33 kN cannot both be
satisfied by finite gimbal. Gimbal at 8° gives Fx_world ≈ 850·sin(-8°) ≈ -118 kN
(overshoots target 33 kN by 3.5×), torque = 9·850·sin(8°) = 1064 kN·m (target
was -15 kN·m, so 70× over).

At t=525.6 (elapsed 3.0s of 7.54s T0): alpha_target = a0rot·(1-(t/L)^q) - k·sin(pi·t/L).
cross_rot=1 means alpha goes negative mid-trajectory. Negative alpha_target +
comY positive -> Fx_body negative (large magnitude for negative alpha demand),
which forces Fy_body even more negative -> clamp.

## Fundamental question

How to make booster follow alpha_target(t), ax_target(t) exactly — gimbal-only, single engine?

Before proposing patches, note saturation when:
- Linear demand Fx_world >> torque demand Fx_body
- theta -> 0 (singularity)
- alpha_target crosses zero (backward thrust demand)

## Options (analyze, don't just pick)

A. RCS hybrid: gimbal linear only (small δ), RCS top+bottom pure torque (no lateral).
   Decouples. RCS ~60 kN·m, need ~15 kN·m. Works.

B. Sequential: Phase 1 rotate theta->0, omega->0 (linear paused, gimbal only rotation).
   Phase 2 translate x->0 (rotation locked, gimbal small δ). No singularity.

C. Optimal control: per tick, find (delta, mdot) minimizing weighted
   ||tau_actual - tau_target||² + lambda·||F_world_actual - F_world_target||²
   subject to limits. Feasible best-effort, priority via lambda. No guaranteed tracking.

D. Differential flatness reformulation: are alpha_target and ax_target independently
   achievable? Solve backwards from end state (theta=omega=x=vx=0 at T0) to reachable
   set of (delta(t), mdot(t)). Boundary ODE constraint.

E. Grid fins as torque: Q~16000 Pa, ~400 kN·m. Use fins for torque, gimbal for linear.
   Decouples like A but free. Currently held 0.

F. Target trajectory choice: cross_rot=1 (alpha goes negative) triggers singularity.
   What if T0 large enough that alpha stays positive? Long T0 = low alpha amplitude.

G. Modify target ds: theta target small nonzero (0.5°) so singularity avoided.
   Tradeoff end theta not zero.

H. Multi-tick predictive: gimbal slew 40°/s, accel 200°/s². 1-tick predict insufficient.
   Multi-tick rate-limit-aware inversion.

## Specific questions

1. Is gimbal-only 2DOF (theta + x) simultaneous feasible in principle?
   Physically yes (2 DOF thrust: magnitude, angle). But 2×2 inversion is singular.
   Singularity removable by reformulation (different free variable, multi-tick predict),
   or gimbal-only fundamentally unable given Fmax/Fmin/±8°?

2. If infeasible: which of A-H is most promising?

3. Analytical check: given current capture6 (a0rot=0.0031, v0rot=0.0042, dsrot=0.029,
   a0lin=1.73, v0lin=-5.45, dslin=-15.97), and LB limits (Fmax=850kN, Fmin=340kN,
   delta_max=8°, spool complete, T0 in [7.16, 13.23]), max achievable final reduction
   in theta, omega, x, vx? Exact zero achievable with gimbal-only, or theoretical floor?

4. Sinusoidal-solver formula: alpha(t) = a0(1-(t/L)^q) - k·sin(pi·t/L). With cross_rot=1,
   alpha goes negative mid-trajectory. Is this fundamentally incompatible with gimbal-only
   tracking (negative alpha near theta=0 requires backward thrust)?
   What if T0 from LONGER end (13s vs 7.5s) — does cross_rot go to 0 (monotone, no dip)?
   If monotone, singularity avoided?

5. Real F9: vertical descent + small x corrections, NOT 2DOF alignment. Trajectory
   near-vertical corridor. Are we over-engineering?

Don't just pick. Analyze limits first. If gimbal-only feasible, prove it. If infeasible,
prove that too. Then recommend.

Full files attached. Read carefully before answering.
