# PLAN.md — Landback (booster RTLS) for Project-Falcon-9

> **READ THIS FIRST (instructions for the Claude reading this in a new chat)**
>
> 1. This file is the single source of truth. The user will attach it (plus a few
>    code files) at the start of each chat and then just say what to do next.
>    Do **not** ask them to re-explain the project.
> 2. **After every result** (a phase written, a test run, a bug found, a decision
>    made) **update this file** — status table (§4), changelog (§9), open
>    questions (§8), known risks (§7) — and hand back the updated `plan.md` with
>    the other files you changed. Never leave the plan stale.
> 3. Be token-frugal: the code files are huge. **Never `cat`/`view` a whole file.**
>    `grep -n` first, then `sed -n 'A,Bp'` only the ranges you need (§10).
> 4. User style: writes Hinglish, wants Hinglish replies, short and mobile-friendly
>    (answer first, no preamble). Serious research project — **never call the
>    verification harness a "toy"**; say "offline numerical check" / "verification".
> 5. **Do not add constants the user has not asked for.** Constants for a phase are
>    added only when the user describes that phase. Keep config minimal so the next
>    reader is not misled.
> 6. The user wants **fastest** (time-optimal, full-torque / full-throttle,
>    bang-bang) behaviour, not smooth. Only trim at the very end (last tick) where
>    full torque would overshoot.
> 7. The user will describe each phase in their own words. Implement exactly that,
>    check it numerically, report briefly, update this plan.

---

## 1. Goal

Create **`landbackV1`**: an exact clone of the working guide `leoInsertionV3`
(Falcon 9 Block 5 → 320 km LEO insertion, payload deploy, stage deorbit), and add a
**booster return-to-launch-site (RTLS) landing** on top of it. The booster is
controlled by a new fundamental block **`standardRTLS`** in `guidance-blocks.js`,
exactly like `ascent` controls the booster during ascent and `insertion` controls
the upper stage.

`leoInsertionV3` must stay **untouched** (it is the known-good reference).

## 2. Repo map (only what matters for guidance)

```
js/simJs/guidance/
  guidance.js          mission-level glue; GUIDES{}, config API, export/import state, cmd* builders
  guidance-blocks.js   FUNDAMENTAL_BLOCKS { ascent, insertion, suicide, standardRTLS }  (~127 KB)
  derivation.js        Derivation.* mass props, aero, derive(), deriveForState(), getEnv()
  guidercs.js          GuideRCS.* torque → RCS duty tables
  imu.js               sensor-noise model
  guidance-experiments.js   ARCHIVE of old guides, NOT loaded by any worker
js/guideConfigDefaults.js        code-resident default presets + important fields + compat table
js/guideConstantDescriptions.js  human descriptions per constant (docs/tooltips only)
js/guidancePresets.js, js/guidancePresetsPage.js, js/guidance-tester-ui.js   preset / tester UIs
js/simJs/threads/guidance.worker.js, physics.worker.js, workerBridge.js, fastforward.worker.js
js/simJs/core/physics.js (163 KB), rcs.js, collision.js, environment.js, massProps.js
simulation.html                 guide dropdown (has "Landback V1 (LEO V3 clone)")
LEOINSERTION-V3.md, ARCHITECTURE.md, PHYSICS_ENVIRONMENT.md   existing docs in repo root
```

Load order: `guidance-blocks.js` loads **before** `guidance.js` in every context.

## 3. Core technical facts (verified from code unless marked UNVERIFIED)

**Sim is planar (2-D):** body state is `rx, ry, vx, vy, theta, omega` (Earth-centred
inertial, Earth centre = origin). Single rotation axis. (Inferred from the snapshot
fields; no out-of-plane state seen.)

**Angle convention:** body nose unit vector = `(-sinθ, cosθ)`. **Positive torque
increases θ.** Engine thrust pushes along the nose direction. Retrograde alignment
(nose = −v̂): `θ = atan2(ux_v, -uy_v)` with `u_v = v/|v|`. Nose opposite to the
*local-horizontal* velocity: remove radial part of v, take `atan2(tx, -ty)` of the
unit tangential vector (this is `_flipTargetTheta` in the block).

**Per-tick data (`snapshot`):** `snapshot.simTime`, `snapshot.bodies[i]` with
`rx, ry, vx, vy, theta, omega, fuelMass, members, pods, isActive, slosh, payloadBody…`.
Body 0 = stage after the split; booster = body with `!isActive` (found in WAIT_SPLIT).

**`Derivation.derive(snapshot, idx)`** returns: `rx, ry, vx, vy, theta, omega, r,
altitudeASL, altitudeAGL, gVecX/Y, rho, Q, dragVecX/Y, thrustBodyX/Y, mdotTotal,
massProps{M, comX, comY, I}, alphaAng, alphaDrag, alphaGG, alphaEngine,
torqueEnvironmental, sinAlpha, alphaDeg (AoA), earthSurfaceV, relVx/relVy/speedRel…`
- **`alphaAng` and `torqueTotal` contain NO RCS term** (`torqueRcs = 0` in derive).
  Any controller using RCS must track its own last-commanded RCS torque.
- `Derivation.deriveForState(snapshot, idx, overrideBody, …)` = derive at a predicted state.
- `Derivation.getEnv()` → `DT` (tick, ~1/80 s), `GM_EARTH`, `EARTH_RADIUS`,
  `REMOTE_AREA_*` (resting-area values used by the suicide block), Earth rotation rate
  (env key confirmed: **`EARTH_OMEGA`** = 7.2921159e-5 rad/s).

**`GuideRCS.targetTorqueRcs(snapshot, torque, idx)`** → `{fires[], duties{podId:{up,dn,lat}},
torqueAchieved, saturated}`. Greedy fill: **passing ±1e12 fires every helping nozzle at
duty 1** → gives max torque each way + a full-duty table (used by FLIP).
It does **not** cancel net force. `targetTorqueRcsNoNetForce` does (smaller torque).

**Command latency:** a command sent on tick *k* takes effect on tick *k+1*. All
controllers predict one tick ahead using the torque/duty currently applied.

**Command builders** (`Guidance.cmd*`, used inside blocks via `Guidance.send(cmd)`;
set `targetBodyIdx`): `cmdSetAllThrottle`, `cmdSetGroupThrottle(angles,kgPerSec)`,
`cmdSetCenterThrottle`, `cmdSetGimbalRate(degPerSec,target)`, `cmdSetGimbalAccel`,
`cmdRcsDuty(duties|null, idx)`, `cmdLegs(deployed)`, `cmdGridFinsDeploy(bool)`,
`cmdGridFinsDeployAngles(angles)`, `cmdGridFinsControl(controlDeg)`, `cmdSeparate`,
`cmdSplitFairing`, `cmdReleasePayload`, `cmdOpenPayload(idx)`, `cmdPusherTorque(angAccel,
targetOmega, idx)`, `cmdMarkIntentionalImpact(idx)`, `cmdSetFuelMass`, `cmdWarp`,
`cmdTakeControl(idx)`. (Exact semantics of grid-fin / legs / group-throttle commands:
**read `physics.worker.js`/`physics.js` when first needed.**)

**Frame of reference rules (verified Chat 6 — critical for every phase):**
| Frame | What | Consumers |
|---|---|---|
| **Inertial** | `vx, vy` (Earth-centred, non-rotating) | Gravity, Kepler prediction, trajectory, Earth-fixed conversion |
| **Air-relative** | `d.relVx, d.relVy` = `vx - (wind + ω×r)` | Drag, `d.alphaDeg` display, grid fins, attitude holds in coast |
| **Ground-relative** | air-relative minus wind (≈ air-relative when wind off) | Pad targeting, touchdown velocity |

**Rules:**
- **Coast attitude holds** → air-relative retrograde (matches `alphaDeg=0` display, zero aero torque).
- **Burn attitude targets** → retrograde to the velocity being KILLED:
  - Boostback kills ground-relative horizontal
  - Entry / pre-entry coast uses air-relative (heating frame)
  - Landing burn kills ground-relative velocity
- **Trajectory prediction** → inertial leapfrog, endpoint converted to Earth-fixed:
  `phiEf = atan2(rx, ry) - ωE·(simT + tImpact)`.
- **Pad comparison** → Earth-fixed angle (pad at `LAUNCH_SITE_ANGLE_0 + arcOffsetM/R`).

Mistake to avoid: using `atan2(d.vx, -d.vy)` (inertial) for a coast attitude
hold when the sim's `alphaDeg` is air-relative. At 100km the ~465 m/s Earth
rotation term is 20-40% of descent speed, leaving 15-25° of displayed AoA even
when "aligned" in inertial frame. This was the Chat 6 bug.

**Gimbal:** accel-limited actuator. Shared helpers at the top of `guidance-blocks.js`:
`_gimbalAlphaCmd`, `_gimbalNextAngle`, `_gimbalCmdMsg` (commands gimbal *angular
acceleration*). Study how `insertion`'s STAGE_BURN and `ascent`'s HOLD use them
before writing any gimbal-controlled phase.

**Block interface** (every block instance): `start(constants, bodyIdx, missionCtx)`,
`tick(snapshot)`, `stop()`, `isDone()`, `getResult()`, `getStatus()`, `getBodyIdx()`,
`getState()`, `setState(s)`, `getConstants()`, `setConstants(patch)`.
**`getState/setState` must carry ALL state as JSON-serialisable data** — the
fast-forward workers rebuild guidance from `exportGuideState()` mid-flight.

### 3a. Grid fins (from user's physics.js greps, Chat 7 — inferred from code, not yet sim-verified)
- `GRIDFIN_CONTROL_SIGN = -1`; only the **F/B pair** (`kind 'FB'`) takes `st.control`; L/R fins have no control. Fin plane is rotated about z by `a = SIGN · controlDeg` (rz = ACW-positive, y up) → **positive controlDeg = fin tilted CW in body frame, negative = ACW**.
- Deployed fin (deploy 0): face normal `t` ≈ body axis, chord `c` ≈ body x. Force = face through-flow drag (blockage `B`) + cell-wall cascade lift along chord (`GF_CNA_GRID=3`) + edge drag; Mach factors via `_gfMachFactors`; F/B pair doubles x,y. Torque = `rx·fy − ry·fx` about CoM, `omega` ACW+. Authority ∝ ρ·V² (Q).
- Derived sign (tail-first descent, air from below, fins above CoM): fin tilted ACW (a>0, i.e. controlDeg<0) → fin force +x → **body CW torque**, matches user's intent. UNVERIFIED until `cmdGridFinsControl` handling (units / clamp / slew rate / sign) is read.
- Aero force/torque enter via `dragTorque + gridFinTorque` (so `torqueDrag`/`torqueEnvironmental` already include fin torque).

## 4. Status

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0 | `landbackV1` clone of leoInsertionV3 in guidance.js | ✅ done | identifiers `_lbState/_lbConfig/_landbackTick/setLandbackV1/getLandbackV1Config`, log prefix `[landbackV1]`, export/import keys `lb*` |
| 0b | Registered in guideConfigDefaults.js (compat, preset, important fields), guideConstantDescriptions.js, simulation.html dropdown | ✅ done | |
| 0c | Other files that hardcode `leoInsertionV3` (worker, telemetry, tester UI, presets page/js, fleet, FF) | ⏳ user is doing it (via another tool) | `grep -rn "leoInsertionV3" js/` and mirror every hit for `landbackV1` |
| 1 | `standardRTLS` block skeleton (7 phases, lifecycle, status, state) | ✅ done | at end of `FUNDAMENTAL_BLOCKS` |
| 2 | Handover at end of `SEPARATED_AXIAL` → pusher off, RCS null, rtlsBlock.start(booster) | ✅ done | block ticks every tick in parallel with stage phases |
| 3 | **FLIP** phase | ✅ done, user-verified "perfect, fast turn & settle" | see §5 |
| 4 | BOOSTBACK_BURN | ✅ done, sim-verified | see §6.1 |
| 5 | PRE_ENTRY_STEER | ✅ done, sim-verified (grid fins deploy → quiet coast → ALIGN at 100km → HOLD → handoff at 60km) | see §5.4 |
| 6 | ENTRY_BURN | 🟡 written (patch `entry_burn_patch.js`), awaiting sim check: full-throttle burn, gimbal env-torque cancel, velocity cutoff | see §5.5 |
| 7 | POST_ENTRY_STEER | ⬜ | |
| 8 | LANDING_BURN | ⬜ | |
| 9 | TOUCHDOWN | ⬜ | |
| 10 | Phase timeline / telemetry display for booster phases | ⬜ | see §6.4 |
| 11 | Docs: add a `LANDBACK.md` (or section) describing the finished guide | ⬜ | at the end |
| 12 | RCS 5 kg/s + SEP_ANG_ACCEL -3 + SEP_OMEGA 30 (fleet + config) | ✅ done by user | affected FLIP timing estimates; SEPARATED_AXIAL pre-spin now ~-9°/s at handover (3s × 3°/s²) |

## 5. What is implemented

### 5.1 Mission flow in `landbackV1` (inherited from V3 + one change)
`ASCENT` → `WAIT_SPLIT` (MECO spool, split detection) → `SEPARATED_AXIAL` (3 s: booster
gets axial RCS + lateral kick + pneumatic pusher torque once the stage bell has
cleared; stage gets axial RCS) → **handover (new):** `cmdPusherTorque(0,0,bIdx)`,
RCS null on both, `standardRTLS` started on the booster → `INSERTION` (stage, unchanged)
→ `DONE_DWELL` → `SUICIDE` (stage deorbit) → `END`.
`_lbState.rtlsBlock` is ticked **before** the mission `switch` every tick, wrapped in try/catch.
Status fields exposed: `rtlsPhase, rtlsAltKm, rtlsFlipMode, rtlsFlipErrDeg,
rtlsFlipOmegaDegS, rtlsFlipTgtDeg, rtlsRcsTorque`. FF state keys: `lbState, lbAscentBlock,
lbInsertionBlock, lbSuicideBlock, lbRtlsBlock`. Config bag: `_lbConfig.rtls`.

### 5.2 `standardRTLS` block (guidance-blocks.js, end of file)
- `phases` order: `FLIP, BOOSTBACK_BURN, PRE_ENTRY_STEER, ENTRY_BURN, POST_ENTRY_STEER,
  LANDING_BURN, TOUCHDOWN`. Each has a handler `_phaseXxx(snapshot, d, simT, cfg)` that
  returns `true` when the exit condition is met (then `_goto(next)` logs it to
  `phaseLog`). Stubs just `return false` (= phase holds forever until implemented).
- A phase gets a timeout **only if** `defaultConstants[<PHASE>_TIMEOUT_S]` exists
  (mapping in `TIMEOUT_KEY`; today only `FLIP_TIMEOUT_S`).
- Leaving FLIP sends `cmdRcsDuty(null)`. `stop()` zeroes throttle, gimbal rate, RCS.
- Closure helpers available to new phases: `_send`, `_wrapPi`, `_goto`, `_rcsOff`,
  `_rcsMaxTorques`, `_flipTargetTheta`, `_flipTime`, `_flipRestToRest`, `_st` (state).
- `defaultConstants` (only these 3 exist): `FLIP_ROTATE_TOL_DEG 0.5`, `FLIP_OMEGA_TOL 0.005`
  (rad/s), `FLIP_TIMEOUT_S 120`. Mirrored in `guideConfigDefaults.js` → `landbackV1` → `rtls`.

### 5.3 FLIP algorithm (done)
1. **First tick:** direction is FIXED negative (clockwise) — SEPARATED_AXIAL
   already imparts this spin via `BOOSTER_SEP_ANG_ACCEL_DEG_S2`, so counter-rotating
   would waste torque. Commit immediately (Chat 4f).
2. Target = nose opposite the local-horizontal (tangential) velocity; target, error and
   ω (relative to the target's own slow rotation) are live every tick. Error is tracked
   **unwrapped** along the committed direction.
3. Predict one tick ahead (current RCS torque keeps acting). Full torque toward the
   target; when stopping angle `ω²/(2·a_brake)` (+1 tick of travel) ≥ remaining error →
   full opposite torque. Only the last braking tick is trimmed (`TRIM`: just enough to
   zero ω).
4. Exit when |err| < tol and |ω_rel| < tol → RCS off → next phase.
User-verified in sim (Chat 3, "perfect, fast turn & settle"). Pusher removed
Chat 5, now pure RCS with 5 kg/s nozzles (10× authority).

### 5.4 PRE_ENTRY_STEER algorithm (done)
**Sub-phases** (in `_st.preEntrySub`): **COAST** → **ALIGN** → **HOLD** → handoff.

1. **First tick (phase entry):**
   - `cmdGridFinsDeploy(true)` — one-shot, no control deflection.
   - `cmdSetAllThrottle(0)`, `cmdSetGimbalRate(0)`, `cmdRcsDuty(null)` — everything off.
   - Sub = COAST.

2. **COAST — quiet descent:**
   - Only idempotent zero commands each tick (keeps state clean).
   - Transition to ALIGN when `altKm ≤ PRE_ENTRY_ALIGN_ALT_KM (100)` AND `vr < 0`.
   - The `vr < 0` check handles boostback that ends below the threshold — wait
     for descending pass, not ascending.

3. **ALIGN — bang-bang RCS to air-relative retrograde:**
   - **Target frame = AIR-RELATIVE retrograde** (critical, verified Chat 6):
     `tgtNow = atan2(d.relVx, -d.relVy)` using `d.relVx/relVy` from derivation.js
     (which include wind + surface rotation).
   - Why air-relative: `d.alphaDeg` is defined against relV; at 100km Earth
     rotation (~465 m/s) is 20-40% of descent speed, so inertial-retrograde
     target left 15-25° of AoA (user saw -20°). Air-relative target settles
     with `alphaDeg ≈ 0`.
   - Same bang-bang law as FLIP: first-tick direction, unwrapped error, one-tick
     prediction (with `dTgt = wTgt*dt` target rotation feedforward), ACCEL/
     BRAKE/TRIM modes.
   - Exit tolerances **reuse FLIP_* constants** (user: "like flip phase"):
     `FLIP_ROTATE_TOL_DEG=0.5`, `FLIP_OMEGA_TOL=0.005`.
   - Sub → HOLD on exit.

4. **HOLD — PD attitude hold:**
   - PD on live target: `τ = -I*(KP*err + KD*(ω - wTgt))`, KP=0.5, KD=4.0.
   - `wTgt` feedforward (target rotates each tick as velocity direction changes).
   - Torque via `GuideRCS.targetTorqueRcsNoNetForce` (coast — no orbit disturbance).
   - Every 5 sim-sec, logs `[PRE_ENTRY_HOLD-DBG]` with theta / tgt / err / alphaDeg / omega.
   - Transition to ENTRY_BURN when `altKm ≤ ENTRY_BURN_ALT_KM (60)`, set `finished=true`.

**Constants:** `PRE_ENTRY_ALIGN_ALT_KM=100`, `ENTRY_BURN_ALT_KM=60` (both guesses, tune in sim).
Mirrored in `guideConfigDefaults.js` → `landbackV1.rtls`, described in `guideConstantDescriptions.js`.

**Status fields:** `rtlsPreEntrySub, rtlsPreEntryErrDeg, rtlsPreEntryOmegaDegS,
rtlsPreEntryTgtDeg` (via `_landbackTick.getStatus` → `standardRTLS.getStatus`).

**Console traces:** `PRE_ENTRY_STEER start`, `COAST → ALIGN`, `ALIGN start`,
`ALIGN → HOLD`, `HOLD-DBG` (every 5s), `HOLD → ENTRY_BURN trigger`.

### 5.5 ENTRY_BURN (Chat 7 — written, awaiting sim check)
**Constants (`rtls.*`):** `ENTRY_BURN_ENGINES` `"C,0,180"`, `ENTRY_BURN_GIMBAL_ENGINES` `"C"` (token strings like BOOSTBACK_ENGINES; add gimbal engines only if it saturates), `ENTRY_BURN_CUTOFF_VELOCITY_MS` 600.
**Logic:** stage BURN → SPOOL. Phase entry: `cmdSetAllThrottle(0)` once, then burn-set engines at **FULL throttle** (`Infinity` = engine max) every tick. Spool wait until flow ≥ 97 % of max, then gimbal active.
**Cutoff:** `speedRelV = hypot(d.relVx, d.relVy)` (Earth-relative, incl. rotation) ≤ cutoff → SPOOL: all throttle 0, gimbal rate 0 (frozen, as boostback). Phase ends (`finished`) when total mass flow < 1 kg/s. No spool-dv compensation (trigger is exactly "speed == cutoff").
Gimbal = copy of boostback/circularize law: state advanced one tick (`deriveForState`), `tauTarget = tauDesired − dNext.torqueEnvironmental` (aero + gravity gradient), `asin` solve, clamp `gimbalMaxDeg`. `tauDesired` = PD (KP 0.5 / KD 4.0, internal) on **air-relative retrograde** with `wTgt` feedforward (same as PRE_ENTRY HOLD).
**Watch:** `ENTRY_BURN gimbal SATURATED` (once per onset), `[ENTRY_BURN-DBG]` every 5 s (v, stage, alpha, err, ω, gimbal, tauEnv, tauAvail, sat, Q), `ENTRY_BURN → SPOOL`, `ENTRY_BURN done`. Status: `rtlsEbStage/SpeedMs/ErrDeg/AlphaDeg/GimbalDeg/GimbalReqDeg/GimbalSat/ThrFrac`. `_goto` cleanup: leaving ENTRY_BURN → throttle 0 + gimbal rate 0.
Patch file `entry_burn_patch.js` (sections [1]–[9]) lists exact insertion points.

## 6. Roadmap — remaining phases (design notes, NOT decisions)

**The user defines each phase; below are only my starting suggestions/questions so
the next chat can ask the right things quickly.** Do not implement beyond what the user says.

### 6.1 BOOSTBACK_BURN — IMPLEMENTED (Chat 4)
**Mission ctx:** `landbackV1._lbConfig.mission.TARGET_LANDING_PAD` (default `'LZ-1'`) → `_lbResolveTargetPad()`
→ `rtlsBlock.start(cfg, bIdx, {targetPad:{id,arcOffsetM,angleEf}})`. Pad angle = launch-site angle +
arcOffsetM/EARTH_RADIUS (formula assumed; `env.LANDING_PADS` else fallback table LZ-1 400 / LZ-2 700 / LZ-3 1000 m).
**Constants (`rtls.*`):** `BOOSTBACK_ENGINES` "C,0,180" (centre + the two extreme octaweb engines; string, not array),
`BOOSTBACK_APPARENT_OFFSET_M` 0 (metres, converted to angle via EARTH_RADIUS) (+ = east of pad; aim short so drag/steer covers the rest),
`BOOSTBACK_SIDE_CUT_M` 20000, `BOOSTBACK_TAPER_M` 150000 (current code defaults; 220000/55000 were earlier guesses — updated in Chat 4d).
**Logic:** THREE (all selected engines full) → when predicted-impact error ≤ SIDE_CUT the outer ones go off →
CENTER (throttle tapers 100 % → 39 % floor as error 55 km → 0) → SPOOL cutoff when error ≤ 0 *including spool-down dv*;
phase ends when mass flow < 1 kg/s. Impact = vacuum leapfrog predictor (Earth-fixed). Attitude: CENTRE-engine gimbal only (target "center"), predictive law copied from circularize/suicide (dNext via deriveForState, tau − env torque),
nose opposite horizontal velocity **latched at burn start** (live velocity would flip 180° when vE reverses — found offline).
**Status fields:** `rtlsBbStage/ErrDeg/ImpactEfDeg/TargetEfDeg/ThrFrac`. Logs `[standardRTLS] BOOSTBACK …`.
**Status:** sim-verified working (Chat 5). Vacuum predictor (no drag); cutoff at SIDE_CUT with spool compensation;
attitude hold via centre-engine gimbal only. Limits: no attitude control after cutoff until PRE_ENTRY_STEER;
side-engine spool dv must remain ≤ SIDE_CUT.

(Original design notes below are superseded.)
- Starts with nose already opposite horizontal velocity (thrust decelerates the downrange speed).
- Need from user: which engines/how many, throttle, **cutoff condition**.
  Likely: predict the ballistic impact point each tick (leapfrog predictor already exists
  inside the `suicide` block: `_predictImpact`) and cut when predicted Earth-fixed impact
  = pad (± an offset that accounts for the later entry burn/aero).
- Attitude hold during the burn needs gimbal control (see `insertion` STAGE_BURN PID on AoA).
- **Pad position:** not stored anywhere yet. Plan: at mission start (first tick) record
  launch-site Earth-fixed angle `φ = atan2(rx, ry) − ωE·t` and pass it via `missionCtx`.
  Confirm whether the sim has an explicit launch-site / landing-site definition (env/config).
- Fuel budget: booster residual at MECO is `ascent.MECO_TARGET_BOOSTER_FUEL_KG` (52612 kg
  in the preset — **verify real value from `body.fuelMass` at separation**).

### 6.2 PRE_ENTRY_STEER (✅ done) / POST_ENTRY_STEER (⬜)
- **PRE_ENTRY_STEER done** — see §5.4. Air-relative retrograde target, 3 sub-phases
  (COAST → ALIGN → HOLD), grid fins deployed on entry (control=0), handoff at 60km.
- **POST_ENTRY_STEER still pending** — grid fins become primary actuator here (Q high
  below ~40km; grid fin authority scales with Q). Need from user: pad-steer law
  (grid fin control from pad-impact error?), grid-fin control limits used, exit trigger
  (altitude / speed / predicted for LANDING_BURN).

### 6.3 ENTRY_BURN, LANDING_BURN, TOUCHDOWN
- ENTRY_BURN: relight, hold retrograde with gimbal, cut on speed/Q/altitude.
- LANDING_BURN: suicide-style (ignite when stopping distance at max usable decel = altitude),
  min-throttle limit, legs deploy (`cmdLegs`), cancel horizontal velocity, vertical attitude.
- TOUCHDOWN: engines off on contact; define success (speed, tilt, leg state) — read
  `collision.js`; check whether `cmdMarkIntentionalImpact` is needed/harmful for a landing.

### 6.4 Cross-cutting
- `GUIDE_PHASE_SEQUENCES` / `GUIDE_PHASE_DISPLAY` for `landbackV1` currently show only the
  stage's phases (`_lbCurrentPhase()` returns the stage block's phase). Decide how booster
  phases appear in the checkpoint timeline (second timeline? merged?).
- Telemetry/status UI for `rtls*` fields; presets page (`rtls` section is in the preset).
- Whenever a constant is added: (1) `standardRTLS.defaultConstants`, (2) `guideConfigDefaults.js`
  `landbackV1` preset `rtls:` section **(values must match)**, (3) `GUIDE_IMPORTANT_FIELDS.landbackV1`
  if important (path syntax `rtls.KEY`), (4) `guideConstantDescriptions.js` → `landbackV1` → `'rtls.KEY'`.
- Stage deorbit (`SUICIDE`) is inherited from V3; ask the user if Landback should keep it.

## 7. Known risks / unverified assumptions (update as they get resolved)

1. `cmdPusherTorque(0,0)` assumed to switch pusher off. Still used in SEPARATED_AXIAL
   (fires once, 3s window). FLIP pusher removed (Chat 5), so this only matters for the
   pre-FLIP pre-spin — handover ω expected ≈ -9°/s with new -3°/s² setting.
2. Booster index `boosterIdx` is fixed at split. If any body is ever removed/reordered
   (fairing halves, payload) the index could shift — watch for it.
3. Velocity used by FLIP/targets is **inertial** tangential velocity, not Earth-relative.
   For boostback targeting a pad, ground-relative velocity may be what is wanted.
4. `targetTorqueRcs` full-fire produces some net force (not the no-net-force variant); small
   translational Δv from the flip is ignored. Revisit if boostback accuracy needs it.
5. ~~Booster `isActive=false` commands~~ RESOLVED: `physics.worker.js resolveTargetBody` routes `targetBodyIdx` to discarded bodies. (Still confirm in sim.)
8. Pad arcOffset→angle formula and `env.LANDING_PADS` in boot handoff are UNVERIFIED (environment.js / workerBridge.js not seen); fallback table is used otherwise.
6. Torque sign (+τ → +θ) taken from `DONE_DWELL` and confirmed by the working FLIP.
7. Fast-forward: any new per-phase state must live in `_st` and be JSON-serialisable.

## 8. Open questions for the user (answer when starting each phase)

**ENTRY_BURN (partly answered Chat 7):**
- ✅ Ignition at PRE_ENTRY handoff (60 km). ✅ Engines `C,0,180`, gimbal `C`. ✅ FULL throttle (user changed from lowest-thrust, Chat 7). ✅ Cutoff at Earth-relative speed 600 m/s.
- ⬜ Spool-dv compensation of the cutoff (cut early so final speed = 600)? Decide after sim.
- ⬜ Attitude frame during burn: currently air-relative retrograde (continuity); older note says inertial retrograde may be better for the burn — user to decide after sim.

**PRE_ENTRY (answered, no action):** air-relative retrograde confirmed. Align at 100km, handoff at 60km.

**POST_ENTRY_STEER (Chat 7 — written as first experiment, `post_entry_steer_patch.js`, awaiting sim):** engines/gimbal/RCS off; F/B grid-fin `cmdGridFinsControl` target ramped 0 → max (cap 90, worker clamps to `typeConstants.maxControlDeg`, default 30) at `POST_ENTRY_GRIDFIN_RAMP_DEG_S`=3 deg/s, sign internal `PES_CTRL_SIGN=-1` (controlDeg negative = fin ACW = body CW torque; flip to +1 if sim rotates wrong way). Actuator auto-slews (defaults 40 deg/s, 200 deg/s²; fins must be deployed or control is forced to 0). No exit. Telemetry `[POST_ENTRY-DBG]` every 5 s: ctrlCmd, alpha, ω, θ, Q, groundErr (+east of pad), vacImpactErr (no drag, informational). Status `rtlsPes*`. Judge success by final landing miss distance vs the pre-fin miss.
**First run (Chat 7, user sim):** grid fins steer (sign `-1` confirmed: θ rotates CW, nose east). groundErr 6.02 km → best 3.57 km at t≈500 (≈40 % pulled back) → worsened to 4.03 km at touchdown because fins sat at max the whole descent. `ctrlCmd=-90` is only our request; the worker clamps to `maxControlDeg` (default 30), so the real fin angle was the clamp. Fin lift saturates at stall (`tanStall`) and face drag keeps growing → max torque is NOT at max angle (user's point). Equilibrium alpha only ≈1–5°. No exit → phase kept running after landing (garbage logs; a landed/crashed guard + exit still TODO). vacImpactErr vs groundErr differ by km (vacuum predictor ignores drag) → drag-aware predictor needed for tight closed loop.
**Next idea (user, Chat 7) — WRITTEN as `entry_burn_steer_patch.js` (plain sign(err) version, expected to oscillate on purpose; awaiting sim):** steer the impact with the ENTRY_BURN itself: deliberately NOT zero-AoA; if impact is short (east of pad) fire RCS ACW (nose west → thrust gets a west component), if past the pad reverse. Gimbal must NOT fight the RCS: each tick predict next-tick AoA/env torque from current RCS torque + ω and command gimbal to cancel only the environmental torque.
Design (user): 
Goal: see how far grid fins ALONE can pull the impact point back to the pad after the entry burn shifted it far downrange (if impossible → later change entry-burn AoA). Method: fins to max ACW tilt (booster gets CW torque, air from below) → body rotates CW (nose east) until hull aero torque = fin torque → stable equilibrium → AoA gives lift toward west. Fin command ramped (controlled, no oscillation). Observe impact shift only; no exit yet. Needs: `cmdGridFinsControl` semantics (units, max, slew, sign) + a drag-aware impact estimate (existing `_bbImpact` is vacuum).

**POST_ENTRY_STEER (later):**
- Grid-fin control law: bang-bang? PD on predicted-pad-error? Q-scaled authority?
- Attitude target: air-relative (aero) vs specific steering angle for pad?
- Exit to LANDING_BURN: altitude / speed / predicted ignition?

**LANDING_BURN (later):**
- Ignition rule (suicide-style? predicted stopping distance = altitude?), min throttle, leg deploy altitude, cutoff.
- Success criteria for TOUCHDOWN.

**Older:**
- BOOSTBACK tuning (OFFSET / SIDE_CUT / TAPER) after sim run; attitude hold between BOOSTBACK end and PRE_ENTRY_STEER?
- Entry burn trigger (altitude, Q, speed, predicted) and cutoff?
- Grid-fin control law / limits? Aero steering goal (hit pad coordinates?)
- Landing burn: ignition rule, min throttle, leg deploy altitude, success criteria?
- Keep the stage deorbit (`SUICIDE`) in `landbackV1`?
- How should booster phases show in the timeline / telemetry?

## 9. Changelog (newest first — add a line for every change)

- **Chat 7 (l):** v4 result: exit guard fixed, RCS saturation reduced, still not converging. DeepSeek BUG 1 accepted (NoNetForce `fires[].torque` is the FULL per-nozzle moment, use `res.torqueAchieved`; log showed request +3110 vs "achieved" +135800 → phantom torque in lastRcsTorque). DeepSeek BUG 2 ("position term missing") REJECTED: impact is invariant on a ballistic path (position + gravity + Earth-rot terms cancel), edot = S·a_aero is right; their FD omitted g and would inject −S·g. v5 (`post_entry_closedloop_v5_patch.js`) adds `edotFD` (1 s FD through the predictor incl. g) and `edotBal` (pure-gravity FD, must be ≈0) to measure instead of argue. Insight: J≈1–9 (m/s)/deg ⇒ attitude authority over impact ≈ J·Δα·T ≈ 1.5 km ≈ the whole open-loop drift (+1.6 km): the "dth want −39 / used −1.5" is an authority statement. Cheap complement: ENTRY_BURN_IMPACT_TARGET_M ≈ −1500. STILL NEEDED from user: the first-6-s `[POST_ENTRY-VALIDATE]` lines (no-command window).
- **Chat 7 (k):** POST_ENTRY closed loop v3 FAILED in sim (touchdown vacErr 1.60→1.77 km; edotPred 3–11× off / sign-flipped vs edotMeas; RCS saturated all descent; DBG kept printing after touchdown). My analysis: (1) v3 used `targetTorqueRcs` (net force; CW torque from nozzles above CoM = EAST force, unmodeled) instead of `targetTorqueRcsNoNetForce`; (2) KP/KD 0.5/4 sized for RCS in vacuum ⇒ permanently saturated; (3) outer loop ignored authority — at Q 10–30 kPa hull torque of α≈5–6° exceeds fins+RCS (tauNeed −569 vs reachable −309 kN·m), attitude is slaved to aero equilibrium α_eq(c); (4) fins at c≈−20…−27 (interior, not the scan end) is CORRECT (lattice stall); (5) touchdown guard <10 m too low (bounces 10–49 m). v4 (`post_entry_closedloop_v4_patch.js`): NoNetForce RCS, authority-sized gains (0.05/0.6), TAU_E 40 s, dθ≤1.5°/tick, FEASIBILITY CLAMP on θ* from fin-scan torque range + 80 % RCS authority with linearised hull torque, 6 s no-command VALIDATION window (`[POST_ENTRY-VALIDATE]` meas vs pred edot), guard `alt<50 || landed || crashed`. DeepSeek's "S should be (60,−46) ⇒ edot −320" was its own guess — rejected. Next: read VALIDATE lines; if meas≈pred the model is right and the loop tuning is what remains.
- **Chat 7 (j):** L2 PASS (fin port verified: tau/Fxb ≈ −19.5 m lever — fins are body-x force actuators ~20 m above CoM; passive torque at α≠0 non-zero; stall confirmed, peak |tau| near c≈−10…−17 at α=−6°; passive L/R fins give a sign BIAS ≈ sign(α)·10.7 kN·m, FB pair modulates ±10.6 kN·m ⇒ at a given α fins only reach one torque sign, RCS must cover the other). User: best fin angle is not fixed — it depends on hull alpha + fin angle (fin AoA through the lattice). Closed-loop POST_ENTRY v3 written (`post_entry_closedloop_patch.js`): maintain VACUUM impact err; edot = S·a_aero (S from predictor ±1 m/s, a_aero = hull drag + hull normal force from memberBreakdown (derive's dragVec is axial only) + fin force); outer Newton step on theta (J by +1° finite difference); inner PD torque demand; fin command by scanning the ported fin model at the predicted next state (5° + 2.5° refine, torque at slewed next angle); RCS takes the remainder (proportional via targetTorqueRcs); touchdown guard <10 m AGL. All gains internal. Validation built in: DBG prints edot meas vs pred.
- **Chat 7 (i):** DeepSeek's spec review accepted (Amendment 1 in `derivation_fin_aero_port_spec.js`): port `bodyAeroProfile` too, bug-compatible bell-member indexing (profile.members[0] = bell), `gridFinControlUsed` = actual slewed control, override only when FB.deploy===0, exhaustive allowed-differences list. Possible physics off-by-one to fix later in BOTH places.
- **Chat 7 (h):** Fin-aero port spec written (`derivation_fin_aero_port_spec.js`): verbatim copy of physics.js grid-fin code into derivation.js; NEW fields only (`gridFinFx/Fy/Torque/ControlUsed`, existing outputs bit-identical, no fold-in yet); `Derivation.gridFinAero(snapshot, idx, stateOverride, controlDeg)`; `_fbControlOverride` on the virtual body. Principle (user): no physics→guidance measurements; guidance computes fin forces from its own geometry model. Verification: L1 textual equality, L2 `[PES-FIN-AERO]` sweep at POST_ENTRY start, L3 closed-loop behaviour. Measured `gridFinTorque` is NOT reachable by guidance (only set when body isActive; lastForces not forwarded) — and not wanted. Closed-loop POST_ENTRY next, after L1/L2 pass.
- **Chat 7 (g):** Greps: physics returns `gridFinTorque` (hull+fin total in `dragTorque`), telemetry at physics.js:2194 carries it; worker snapshot copies `gridFins` state per fin kind. DeepSeek proposes porting `computeGridFinAero` into `derivation.js` (Option A: `deriveForState(..., fbControlOverride)`, fin torque folded into derive). My review: fold-in is NOT behaviour-neutral for ENTRY_BURN — with fins deployed and alpha −4…−6°, control=0 still gives non-zero fin force/torque (L/R shielding + FB cascade lift), so `torqueEnvironmental` would change. Safer: add SEPARATE fields `gridFinFx/Fy/Torque` (existing fields untouched), verify against the sim's measured `gridFinTorque`, fold in later deliberately. Closed-loop POST_ENTRY (predict next-tick vacuum-impact change from hull + fin aero, pick fin ctrl by scan, RCS assist on saturation) comes after the port is verified.
- **Chat 7 (f):** DECISION (user): stay with the VACUUM impact error as the metric. After ENTRY_BURN, POST_ENTRY_STEER must only MAINTAIN the vacuum impact error (predictive grid fins + RCS), not chase the real landing. The "drag shortfall ≈ 3.5 km" in (e) was an unverified inference — withdrawn. User saw the fins giving EAST lift while holding the burn-tail AoA (consistent with code: a fin tilted ACW (controlDeg<0) has a direct force +x = east, its useful effect is only the CW torque → nose east → hull lift west); so the net depends on hull lift(α) vs fin direct force, and the predictor must include both. RCS gives torque with no adverse direct force. `ENTRY_BURN_IMPACT_TARGET_M` bias kept as an optional constant (default 0).
- **Chat 7 (e):** ENTRY_BURN v2 WORKED in sim: vacuum impact err 6 km → 0.12 km at cutoff (13 s burn, ~560 RCS flips = dead-band chatter, alpha −4…−6° held). But the REAL landing (groundErr at touchdown) was still ≈ +1.2 km short with fins at max the whole descent: vacuum predictor ignores post-cutoff drag; drag shortfall ≈ 3.5 km (≈1.2 km left + ≈2.4 km fins pulled earlier) ≈ whole fin authority. Fin pull is limited (alpha only ~5°, worker clamp `maxControlDeg`, stall). Cheapest lever = burn target bias west: `ENTRY_BURN_IMPACT_TARGET_M` (`entry_burn_bias_patch.js`; try −1200 m first). POST_ENTRY closed loop (predict next-tick impact change from hull+fin aero forces, solve AoA/θ, fin command, RCS assist when fins saturate) needs the grid-fin aero model inside `Derivation` (derive() currently has hull aero only; `torqueEnvironmental` excludes fin torque) → hook `Derivation.gridFinAero(...)` requested from the user. POST_ENTRY exit/landed guard still TODO.
- **Chat 7 (d):** ENTRY_BURN steer v1 FAILED in sim (3 RCS flips in 13 s, alpha −15°→+22°, final impactErr +8.78 km vs +6.02 km plain; POST_ENTRY inherited a tumbling body). Insight: burn is a huge AoA→impact amplifier (~100 m/s of impact-rate per degree; ~2.4 km/s at 20–30°); plain burn ends ~6 km short ⇒ only ~3–4° ACW tilt held ~13 s is needed — full-torque RCS is overkill. v2 written (`entry_burn_steer_v2_patch.js`): predictive bang-bang on s = err + ėdot·Tgo + κ·∫Δθ (brake-now final error), Tgo from filtered dv/dt, κ = aT·S with S from the vacuum predictor itself (+1 m/s along ACW nose-tangent); brake in dead band (100 m) and when Tgo<0.5 s; DBG every 1 s. Next idea (user): pulse pairs (ACW tick / CW tick) for tiny displacements — note a 1-tick pair only gives Δθ = a·dt² (tiny), pulse width N ticks will need tuning.
- **Chat 7 (c):** ENTRY_BURN steering experiment written (`entry_burn_steer_patch.js`): attitude hold removed; RCS full torque by sign(vacuum impact err) (err>0 short → ACW); gimbal cancels only predicted env torque (state advanced 1 tick incl. current RCS torque); no new constants. Next idea after the failure: use d(err)/dt to gentle / reverse early. POST_ENTRY exit/landed guard still TODO.
- **Chat 7 (b):** POST_ENTRY_STEER first experiment written (grid fins only, ramped max CW-torque tilt, no exit, telemetry for impact shift) — `post_entry_steer_patch.js`; constant `POST_ENTRY_GRIDFIN_RAMP_DEG_S`=3. Grid-fin command path read: `cmdGridFinsControl(deg)` → `targetControl` clamped ±`typeConstants.maxControlDeg`(30 default), actuator auto-slews.
- **Chat 7:** **ENTRY_BURN written** (§5.5): constants `ENTRY_BURN_ENGINES`, `ENTRY_BURN_GIMBAL_ENGINES`, `ENTRY_BURN_CUTOFF_VELOCITY_MS`=600; full-throttle burn (initially lowest-thrust, changed by user), gimbal environment-torque cancel + saturation logging, cutoff when Earth-relative speed ≤ cutoff, ends when thrust spooled down. Delivered as `entry_burn_patch.js` (user passes it to DeepSeek to apply; `guidance-blocks.js` now provided in full for reading).
- **Chat 6:** **PRE_ENTRY_STEER implemented** (§5.4). Sub-phases COAST → ALIGN → HOLD. Grid fins deployed once on entry (`cmdGridFinsDeploy(true)`), then quiet. ALIGN/TRIM/HOLD use **air-relative retrograde** target `atan2(d.relVx, -d.relVy)` — this was the root cause of the "AoA never zeros" bug (user saw ~-20° at HOLD). Formula was correct but targeted inertial frame; sim's `alphaDeg` is air-relative. New constants `PRE_ENTRY_ALIGN_ALT_KM=100`, `ENTRY_BURN_ALT_KM=60` (block default + guideConfigDefaults + descriptions). New status fields `rtlsPreEntrySub/ErrDeg/OmegaDegS/TgtDeg`. Added §3 frame-of-reference rules table (permanent guidance). `_goto` cleanup now also releases RCS for BOOSTBACK_BURN and PRE_ENTRY_STEER. Diagnostic logs: `PRE_ENTRY_HOLD-DBG` every 5 sim-sec (theta/tgt/err/alphaDeg/omega).
- **Chat 5:** FLIP pusher REMOVED (pure RCS-only, user-verified "powerful torque visibly firing" bug = pusher + bang-bang interaction). Restored from working Chat-3 RCS-only version (whole `standardRTLS` block replaced surgically). Also: **RCS nozzles now 5 kg/s per nozzle** (was 0.5, 10× authority — fleet/hardware change, not guidance). **SEPARATED_AXIAL constants updated**: `BOOSTER_SEP_ANG_ACCEL_DEG_S2` **-1 → -3**, `BOOSTER_SEP_TARGET_OMEGA_DEG_S` **10 → 30** (values in `guideConfigDefaults.js` **and** `guidance.js` `_lbConfig`). offline check harness retired — no more offline testing.
- **Chat 4d:** FLIP now fires a one-shot pneumatic-pusher assist (`FLIP_PUSHER_ANG_ACCEL_DEG_S2`=10, `FLIP_PUSHER_TARGET_OMEGA_DEG_S`=25; physics.js: const angAccel until |omega|>=target then off) in the flip direction at the first tick, cut when mode leaves ACCEL / on FLIP exit; defaults are guesses (goal flip 8-12 s). BOOSTBACK: all burn engines fade 100%→floor over last `TAPER_M`=150 km of error, outer two off at `SIDE_CUT_M`=20 km, centre continues on the same fade; spool wait compares to commanded fraction.
- **Chat 4e:** FLIP pusher reworked: NOT a config constant any more. Internal `FLIP_PUSHER_ALPHA_DEG_S2`=5 (deg/s², torque = I·this) is extra torque authority in BOTH directions added to RCS max (planner uses RCS+pusher); ACCEL/BRAKE: RCS full + pusher full, TRIM: pusher first then RCS. Sent every tick as `cmdPusherTorque(tau/I, null)` (null target omega → physics never self-cancels it); zeroed on FLIP exit. Removed `rtls.FLIP_PUSHER_*` from defaults/descriptions.
- **Chat 4f:** FLIP direction FIXED negative/clockwise (flipEu = eNeg; SEPARATED_AXIAL already pushes that way). Pusher max cut to `FLIP_PUSHER_ALPHA_DEG_S2`=1.5 (30 % of 5), now modulated: ACCEL full, BRAKE = just what is needed to stop at target (Treq − RCS, clamped 0..max), TRIM pusher-first.
- **Chat 4g:** pusher max → 0.7 deg/s²; BRAKE modulation removed (it caused overshoot): pusher is now exactly one more RCS in the same bang-bang (ACCEL/BRAKE full, TRIM pusher-first), included in the one-tick prediction.
- **Chat 4h:** FLIP overshoot: ideal offline model (I=2.58e6, 1-tick latency, RCS+pusher) shows NO real overshoot (≈0.1°), so the real cause is an authority mismatch not visible in the files (rcs.js unseen). Added measured authority gain `flipGain` (steady-ACCEL measured/predicted accel ratio, scales RCS+pusher authority in the planner) and a one-line log `FLIP BRAKE start …` (I, rcs±, pusher, gain, planned decel) to expose the true numbers.
- **Chat 4c:** `standardRTLS` converted to the house style: phases are `case`s of a `switch (_st.phase)` in `_tick()` (no HANDLERS table / `_phaseXxx` fns); helpers stay as functions. Exit = `finished = true; break;`. BOOSTBACK also got a spool wait (attitude control only after burn engines hit 99 %).
- **Chat 4b:** user: gimbal wobbled → attitude hold rewritten as exact copy of circularize/suicide gimbal law, centre gimbal only. User verifies in sim; do NOT build verification harnesses (token waste).
- **Chat 4:** BOOSTBACK_BURN implemented (3-engine burn → centre-only taper → spool-compensated cutoff), mission-level `TARGET_LANDING_PAD`, 4 `BOOSTBACK_*` constants, rtlsBb* status. Offline check `rtls-bb-check.js` (stale: user verifies in sim now, no more harnesses); attitude later changed to circularize-style centre-only gimbal; fixed attitude-target flip at vE=0.
- **Chat 3:** FLIP rewritten as pure bang-bang with first-tick direction choice; removed all
  placeholder constants (only 3 remain). Verified offline + user-verified in sim ("perfect").
- **Chat 2:** Added `standardRTLS` skeleton to `guidance-blocks.js`; handover at end of
  `SEPARATED_AXIAL`; `rtls` config/state/status/FF wiring in `landbackV1`.
- **Chat 1:** Cloned `leoInsertionV3` → `landbackV1` (guidance.js, guideConfigDefaults.js,
  guideConstantDescriptions.js, simulation.html option).

## 10. How to work (process for every phase)

1. **User describes the phase** (logic, triggers, engines). Ask at most one clarifying question,
   only if truly blocking.
2. **Read minimal code:**
   ```
   grep -n "standardRTLS" guidance-blocks.js
   sed -n '<start>,<end>p' guidance-blocks.js        # only the rtls block (it is at the end)
   grep -n "<symbol>" guidance.js derivation.js guidercs.js | cut -c1-160
   ```
   Study an analogous existing phase before writing (e.g. `insertion` STAGE_BURN for gimbal
   control, `suicide` for ballistic prediction and burn-cutoff logic).
3. **Edit with a small Node.js patch script** (bash heredoc, `patchFile(file, [{name, old, new}])`,
   exact-string `includes()` check so a missed pattern fails loudly). Commit + push in same bash
   block after verify (user preference, Chat 5).
4. **Verify in sim** (user runs it and reports back). No offline harness — user
   retired the check harness (Chat 5). Trust the code + user feedback loop.
5. **Wire constants** only for what the user specified (see §6.4 checklist).
6. **Deliver** changed files to `/mnt/user-data/outputs/`, call `present_files`, and include the
   **updated `plan.md`** (status, changelog, risks, questions).
7. **Reply** in short Hinglish: what changed, what to look for in the sim (console logs / status
   fields), any assumption to confirm. Offer the next step in one line.

Sim-side check list for the user: pick **Landback V1** in `simulation.html`, watch console for
`[landbackV1] booster → standardRTLS`, `[standardRTLS] FLIP dir=… err=… omega=…`,
`[standardRTLS] <A> → <B> at t=…`, and the `rtls*` status fields.

## 11. Starting a new chat — what the user attaches

Always: **`plan.md`**, **`guidance-blocks.js`**, **`guidance.js`**, **`guideConfigDefaults.js`**
(the latest versions delivered by the previous chat).
Per phase, add as needed:

| Phase / task | Extra files helpful |
|---|---|
| BOOSTBACK (burn, prediction, gimbal) | `derivation.js`, `guidercs.js`, `environment.js`, `physics.js` (grep only) |
| Grid-fin steering / aero | `derivation.js`, `physics.js`, `physics.worker.js`, `massProps.js` |
| Landing / touchdown | `collision.js`, `physics.js`, `rcs.js`, `vehicle.js` |
| UI / timeline / telemetry | `telemetry.js`, `guidance-tester-ui.js`, `guidancePresetsPage.js`, `guidance.worker.js`, `workerBridge.js` |
| Constants / descriptions | `guideConstantDescriptions.js`, `guideConfigDefaults.js` |

**Suggested first message of a new chat:**
> "plan.md aur files attach hain. Plan padho, phase `<NAME>` shuru karte hain: `<logic in your words>`."

Reminder to the next Claude: finish by returning the updated `plan.md`.
