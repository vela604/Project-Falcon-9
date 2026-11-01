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

**Gimbal:** accel-limited actuator. Shared helpers at the top of `guidance-blocks.js`:
`_gimbalAlphaCmd`, `_gimbalNextAngle`, `_gimbalCmdMsg` (commands gimbal *angular
acceleration*). Study how `insertion`'s STAGE_BURN and `ascent`'s HOLD use them
before writing any gimbal-controlled phase.

**Block interface** (every block instance): `start(constants, bodyIdx, missionCtx)`,
`tick(snapshot)`, `stop()`, `isDone()`, `getResult()`, `getStatus()`, `getBodyIdx()`,
`getState()`, `setState(s)`, `getConstants()`, `setConstants(patch)`.
**`getState/setState` must carry ALL state as JSON-serialisable data** — the
fast-forward workers rebuild guidance from `exportGuideState()` mid-flight.

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
| 5 | PRE_ENTRY_STEER | ⬜ | |
| 6 | ENTRY_BURN | ⬜ | |
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

### 6.2 PRE_ENTRY_STEER / POST_ENTRY_STEER
- Coast attitude hold (RCS; retrograde / engines-first), grid fins (`cmdGridFinsDeploy`,
  `cmdGridFinsControl`) for aerodynamic steering in-plane toward the pad.
- Need from user: attitude target, grid-fin law, triggers (altitude / Q / speed / predictive).
- Will need aero knowledge: `derivation.js` per-member aero, `physics.js` grid-fin model.

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

- BOOSTBACK tuning (OFFSET / SIDE_CUT / TAPER) after sim run; attitude hold between BOOSTBACK end and PRE_ENTRY_STEER?
- Entry burn trigger (altitude, Q, speed, predicted) and cutoff?
- Grid-fin control law / limits? Aero steering goal (hit pad coordinates?)
- Landing burn: ignition rule, min throttle, leg deploy altitude, success criteria?
- Keep the stage deorbit (`SUICIDE`) in `landbackV1`?
- How should booster phases show in the timeline / telemetry?

## 9. Changelog (newest first — add a line for every change)

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
