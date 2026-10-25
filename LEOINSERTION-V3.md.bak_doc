# LEO Insertion V3 — Technical Documentation

One autonomous guidance that flies a rocket from the pad to its target
orbit and releases the payload. No manual command after launch.

This document explains **how it works and why**, with the actual formulas
the code uses. It is written so that someone new can read it top to bottom
and understand the whole mission without opening the source.

Source of truth for everything below, all read from the code:

- `js/simJs/guidance/guidance-blocks.js` — blocks `ascent`, `insertion`, `suicide`
- `js/simJs/guidance/guidance.js` — the mission layer that composes the blocks
- `js/simJs/guidance/derivation.js` — mass, aero and torque model guidance uses
- `js/simJs/guidance/guidercs.js` — RCS allocation (net-zero-force solver)

`guidance-experiments.js` holds old attempts that are kept for history. It is
not part of V3 and is not covered here.

---

## 0. In one minute

- The mission is **three reusable blocks** (ascent → insertion → suicide/deorbit)
  glued by a thin mission layer. Each block is a state machine with
  `start / tick / stop`.
- Every attitude controller follows the **same pipeline**:
  1. predict the state one tick ahead,
  2. compute the torque we want (PD/PID on angle-of-attack, or PD on inertial angle),
  3. subtract the disturbance torque we already know about,
  4. convert torque into a gimbal angle (a sine inversion),
  5. convert that angle into an **angular acceleration** command for the gimbal.
- The gimbal is a real **accel-limited actuator**, not an ideal servo.
- Every engine cutoff is **fired early** by exactly the Δv the engine will still
  produce while it spools down.
- During long coasts, attitude is held with **net-zero-force RCS**, so the
  orbit is not disturbed.
- Engine, mass and gimbal limits are read from the vehicle at runtime.
  Only the **target orbit altitude** has to be set.

---

## 1. Architecture

```
            ┌──────────── mission layer (thin glue) ────────────┐
            │ split detection · axial-separation window ·        │
            │ block dispatch · booster tumble kick · fairing ·   │
            │ payload open · dwell · deorbit hand-off            │
            └───────┬──────────────────┬───────────────┬─────────┘
                    │                  │               │
              ┌─────▼─────┐      ┌─────▼──────┐   ┌────▼─────┐
              │  ascent   │      │ insertion  │   │ suicide  │
              │ pad→MECO  │      │ stage→orbit│   │ deorbit  │
              └───────────┘      │ →payload   │   │ (option) │
                                 └────────────┘   └──────────┘
```

| Block | Does | Ends when |
|---|---|---|
| `ascent` | Fires engines, runs the ascent attitude sub-machine, monitors the booster tank, commands separation | Booster residual fuel reaches the MECO target, separation commanded |
| `insertion` | Upper-stage burn, trim, coast, circularize, release payload | Every expected payload body has spawned and cleared the stage |
| `suicide` | Aligns to retrograde, suicide burn to a resting area, RCS-trims impact | Landed or impacted (optional, not covered in depth here) |

Why blocks: the same `ascent` can fly a different rocket, and the same
`insertion` can target a different orbit by changing constants only. Only the
mission-level glue is mission specific.

### 1.1 Mission layer (`guidance.js`)

The mission layer is its own small state machine:

```
ASCENT → WAIT_SPLIT → SEPARATED_AXIAL → INSERTION → DONE_DWELL → SUICIDE → END
```

- **ASCENT.** Runs the ascent block. When it has commanded separation, the
  mission moves on and remembers the body count.
- **WAIT_SPLIT.** The split is detected by a **body-count increase** in the
  snapshot (the stage stays body 0, the discarded booster is the other
  inactive body). If no split appears within `SPLIT_TIMEOUT_S` (15 s) the
  mission ends.
- **SEPARATED_AXIAL.** Runs for exactly `SEPARATION_DURATION_S` (3 s) from the
  split, then starts the insertion block. During it:
  - booster: every RCS pod fires axial `dn` (pushes it tailward); stage:
    every pod fires axial `up`.
  - **Bell-clearance gate.** The true axial gap is
    `(stage − booster)·up − discardedStackTop`. When
    `gap ≥ stageBellHeight + LATERAL_TRIGGER_MARGIN_M` (0.3 m), the **booster
    tumble kick** is armed. Firing it earlier would rotate the booster
    while its interstage still overlaps the stage's engine bell. The bell
    height is derived per tick from the stage's engine config, so another
    engine changes the trigger point automatically.
  - **Tumble kick (one-shot).** `pusherTorque` with
    `BOOSTER_SEP_ANG_ACCEL_DEG_S2 = −1` and target
    `BOOSTER_SEP_TARGET_OMEGA_DEG_S = 10`, plus an RCS pattern: left pods
    flip from `dn` to `up` (keeping `lat`), right pods stay `dn`. With pod
    offset `xO` the torque is `τ = −2·F·xO`, and the vertical forces cancel
    (`+F` on left, `−F` on right), so the booster does not drift axially.
- **INSERTION.** Runs the insertion block. At the end of SEPARATED_AXIAL all
  RCS duty is cleared.
- **Fairing.** Phase-independent: after the split, when the stage altitude
  reaches `FAIRING_OPEN_ALT_KM` (80 km) the fairing opens (once).
- **Payload open.** `PAYLOAD_DEPLOY_OPEN_DELAY_S` (5 s) after the deploy
  command, a one-shot open command goes to the released payload body
  (panels / dish unfold).
- **DONE_DWELL.** The dwell is measured **from the deploy command tick**,
  not from the start of the last phase. After `SUICIDE_DELAY_AFTER_DEPLOY_S`
  the stage is marked as an intentional impact and, if `DEORBIT_ENABLED`,
  the suicide block starts.

Timing model (important for every formula below): guidance reads a snapshot
at tick **N**; its command takes effect on the physics step at **N+1**. The
tick length is `env.DT` (fallback 1/80 s in the code).

---

## 2. Mission flow

| # | Phase | Block | Exit condition |
|---|---|---|---|
| 1 | PRE_COAST | ascent | `INITIAL_COAST_S` elapsed (zero torque) |
| 2 | PUSH | ascent | `PUSH_T_S` elapsed (one sine torque pulse) |
| 3 | COAST | ascent | AoA ≥ 0 (zero torque) |
| 4 | HOLD | ascent | AoA < 0 |
| 5 | COASTnAoADAMP | ascent | MECO (same law as HOLD) |
| 6 | MECO | ascent | residual-fuel trigger (§4.5), then separation |
| 7 | SEPARATION | mission | axial push apart, one-shot booster tumble kick |
| 8 | STAGE_BURN | insertion | apogee (now or post-spool prediction) ≥ target |
| 9 | RCS_BOOST | insertion | apogee error crosses zero |
| 10 | COAST_ROTATE | insertion | `|θerr| < 0.5°` and `|ω| < 0.02 rad/s` (or 240 s timeout) |
| 11 | COAST_WAIT | insertion | time to apogee ≤ `COAST_WAIT_BEFORE_APOGEE_S` |
| 12 | COAST_ROTATE (2nd pass) → COAST_HOLD | insertion | time to apogee ≤ startup + `CIRC_TRIGGER_LEAD_S`, or apogee peak |
| 13 | CIRCULARIZE | insertion | `v_err ≤ dv_spool + eject kick` |
| 14 | COAST_ROTATE_2 → COAST_HOLD_2 | insertion | apogee peak |
| 15 | PAYLOAD DEPLOY | insertion | release commanded at apogee, DONE once payload clears |
| 16 | DEORBIT | suicide | optional |

---

## 3. Shared foundations

### 3.1 Notation

```
r, v        inertial position / velocity of the body
θ, ω, α     body attitude angle, angular rate, angular accel
g           gimbal angle (deg)           v_g   gimbal rate (deg/s)
I, M        moment of inertia, total mass (from mass properties)
comX, comY  centre of mass (body frame)
Ve, ṁ       exhaust velocity, mass flow rate (per engine)
GM, R       Earth gravitational parameter, Earth radius
```

### 3.2 Orbit geometry (used everywhere)

Radial and tangential split, then energy, then conic elements:

```
r  = |r⃗|           vr = v⃗ · r̂           vt = v⃗ · ê      (ê = (ry, −rx)/r)

E  = ½(vr² + vt²) − GM/r          specific energy (E < 0 → bound)
a  = −GM / (2E)                    semi-major axis
h  = r · vt                        angular momentum
e  = √( 1 + 2·E·h² / GM² )         eccentricity

apogee altitude  = a(1 + e) − R
perigee altitude = h²/GM / (1 + e) − R
```

### 3.3 Time to apogee (Kepler)

Used to trigger the coast and circularization phases.

```
cos E_an = (1 − r/a) / e
sin E_an = (r · vr) / ( e · √(GM·a) )
E_an     = atan2(sin E_an, cos E_an)      (wrapped to 0…2π)
M_anom   = E_an − e · sin E_an             (mean anomaly)
n        = √( GM / a³ )                    (mean motion)

t_to_apogee = (π − M_anom)/n          if M_anom < π
            = (3π − M_anom)/n         otherwise
```

Circular orbit (`e ≈ 0`) returns half a period. Unbound (`E ≥ 0`) returns ∞.

### 3.4 One-tick-ahead prediction

Because a command acts one tick later, the controller solves for the
**next** state, not the current one:

```
a⃗_inertial = g⃗ + (F⃗_thrust + F⃗_drag) / M
r⃗₊  = r⃗ + v⃗·dt
v⃗₊  = v⃗ + a⃗·dt
θ₊  = θ + ω·dt + ½·α·dt²
ω₊  = ω + α·dt
g₊  = predicted gimbal angle (same actuator model physics uses, §3.6)
```

Then mass properties, drag torque, `I`, AoA and its rate are re-derived at
the predicted state (`deriveForState`: the real snapshot is copied with only
those fields overridden). In the ascent block the override also includes the
predicted gimbal angle `g₊`, so `I₊` and `τ_drag₊` match where the gimbal will
really be next tick. A **1-tick horizon is exactly right** here: a longer
horizon overshoots because the command is rewritten every tick before it
finishes acting.

### 3.5 Angle of attack and its rate — analytic, no finite differences

A finite difference of AoA over one tick amplifies noise by 1/dt² (6400× at
1/80 s) and saturates the gimbal from float rounding. Instead, algebra on
body-frame velocity relative to the air and body-frame acceleration:

```
u  =  relVx·cosθ + relVy·sinθ          (component across the body axis)
v  = −relVx·sinθ + relVy·cosθ          (component along the body axis)
r² =  u² + v²

sin(AoA) = u / |v_rel|                  AoA = asin(u / |v_rel|)

P  =  v·ax − u·ay
Q  =  u·ax + v·ay

ω_AoA = ω  +  P / r²                    (rate of AoA)
α_AoA = α  −  2·P·Q / r⁴                (accel of AoA)
```

`relV` is velocity **relative to the air**: `v − (wind + Ω × r)`, i.e. wind and
the Earth's rotation (`Ω·ry, −Ω·rx`) are removed. `ω_AoA` is the true rate of
the angle between nose and the air-relative velocity vector. The
controllers use `ω_AoA` and **not** `α_AoA`: with no acceleration term, the
desired torque does not depend on the gimbal being solved for, so there is no
one-tick sign-flip loop.

### 3.6 Torque → gimbal angle

The gimbal torque about the centre of mass is a sinusoid in the gimbal angle.
For all gimballed engines `e`:

```
F_e = ṁ_e · Ve_e
A   = Σ (x_e − comX) · F_e              (lateral lever)
B   = comY · Σ F_e                      (axial lever)

τ(g) = A·cos g + B·sin g  =  R_amp · sin(g + φ)
R_amp = √(A² + B²)        φ = atan2(A, B)
```

Inverting for a wanted torque `τ`:

```
ratio = clamp( τ / R_amp , −1, 1 )
g₁ = wrap( asin(ratio) − φ )
g₂ = wrap( π − asin(ratio) − φ )
g_req = whichever of g₁, g₂ has the smaller |g|
g_req = clamp( g_req , ±gimbalMaxDeg )
```

If `R_amp ≤ 1` (engines essentially off) the request is 0.

The torque we ask the gimbal for is the wanted torque **minus the known
disturbance** (drag torque during ascent, environmental torque in the
upper stage):

```
τ_target = τ_desired − τ_disturbance
```

### 3.7 Gimbal as an accel-limited actuator

Guidance never sets a gimbal angle directly. It sends an **angular
acceleration** α (deg/s²). Physics integrates:

```
a  = clamp(α_cmd , ±aMax)
v_g ← clamp(v_g + a·dt , ±vMax)
g   ← g + v_g·dt
g   ← clamp(g , ±gMax)     (rate set to 0 if it pushes into the stop)
```

`aMax = gimbalAccelDegS2`, `vMax = gimbalRateDegS`, `gMax = gimbalMaxDeg` are
properties of the thruster type, read per engine.

The guidance side computes α from a **2-tick Newtonian law** that reaches the
requested angle with zero rate, re-solved every tick (receding horizon), plus
a braking guard so a saturated α cannot overshoot:

```
d     = g_req − g
a     = clamp( (d/dt − v_g)/dt , ±aMax )
v_cap = 0.9 · √( 2·aMax·|d| )
if |v_g + a·dt| > v_cap and moving toward the target:
      a = clamp( (sign(d)·v_cap − v_g)/dt , ±aMax )
```

The slider path in physics uses the same law, so a human command and a
guidance command behave identically. Physics also supports direct rate and
accel commands; priority is *guidance accel > guidance rate > slider angle*.

### 3.8 Spool-down Δv (why every cutoff is early)

When the shutdown command is sent, the engine does not stop instantly. Its
mass flow ramps linearly to zero over a time proportional to current flow:

```
t_spool  = ṁ_now · shutdownDurationS / ṁ_max
impulse  = ½ · ṁ_now · Ve · t_spool       (area of the ramp)
dv_spool = impulse / M
```

Every cutoff (MECO, STAGE_BURN, CIRCULARIZE) fires early by this amount, so
the velocity at the moment the engine **actually** stops equals the target.
Without this, circularization lands high and apogee overshoots.

### 3.9 What guidance knows about the vehicle (`derivation.js`)

`derive()` builds one consistent picture of a body from the snapshot. It
mirrors the physics model (a past mismatch in payload mass made every
attitude response half as strong, so the two are kept identical).

**Environment**

```
g⃗   = −GM/r² · r̂
ρ    = ρ₀ · exp(−altitude / H)                 (ρ₀ at or below sea level)
q    = ½ · ρ · |v_rel|²
v_rel = v − wind − (Ω·ry, −Ω·rx)
```

**Mass properties** (centre of mass and inertia, from components: engines,
legs, fuel plus slosh, grid fins, structure per member, payload cargo):

```
M    = Σ m_i
com  = Σ m_i · com_i / M
I    = Σ ( iOwn_i + m_i · |com_i − com|² )     (parallel-axis theorem)
```

Fuel is split per member, the slosh offset shifts the fuel centre, and
payload cargo stays in the mass until it is actually released.

**Aerodynamic model** (per member, so the centre of pressure moves with the
stack). With `sinα = u/|v_rel|`:

```
drag    = ½ · ρ · Cd · A_eff · |v_rel|²
A_eff   = A_axial·(1 − w) + A_side·w          w = min(1, |sinα|)
F_lin   = −q · CNα · S_ref · sinα             (tapered members only: nose, payload space)
F_cross = −q · Cd_crossflow · A_side · |sinα| · sinα
τ_drag  = Σ ( comY − CP_y ) · F_normal        (linear and crossflow parts, each at its own CP)
```

**Torques, all per body**

```
τ_engine = Σ [ (x_e − comX)·F_e·cos g  −  (y_e − comY)·F_e·sin g ]
τ_gg     = −1.5 · GM/r³ · I · sin(2β)         β = θ − local vertical
                                               local vertical = atan2(−rx, ry)
τ_drag   = aero only
τ_env    = τ_drag + τ_gg                       ("environmental")
```

The gravity-gradient formula uses the slender-body simplification
(axial inertia ≈ 0). For an F9-size stack in LEO it is about 380 N·m, small
but it is the dominant disturbance over a long coast.

`B = comY · ΣF` in §3.6 is the same engine torque with the gimbal bearing at
`y = 0`, which holds for F9 and nearly every real engine.

**Which controller cancels what**

| Controller | Disturbance subtracted from `τ_des` |
|---|---|
| Ascent HOLD / COASTnAoADAMP | `τ_drag₊` |
| STAGE_BURN | `τ_env₊` (drag **and** gravity gradient) |
| Coast rotate/hold, CIRCULARIZE, COAST 2 | none: plain PD, no disturbance feed-forward |

In the coasts the gravity-gradient drift is handled by the PD loop and by
the second rotate before the burn (§5.3), not by feed-forward.

### 3.10 Net-zero-force RCS (`guidercs.js`)

A single RCS pod makes a torque **and** a linear force. Over a coast of
100 s or more, unbalanced duty drifts the vehicle by metres.
`targetTorqueRcsNoNetForce()` uses only two balanced patterns. `F` is one
nozzle's thrust (`ṁ · Ve`), `xO` the pod's lateral offset, and `yTop`,
`yBot` the heights of the top and bottom pods:

```
Vertical pattern (4 fires, opposite Y forces)
   τ > 0 :  TL.dn + TR.up + BL.dn + BR.up
   τ < 0 :  TL.up + TR.dn + BL.up + BR.dn
   τ_V,max = 4 · xO · F          (arm ≈ 2 m)

Lateral pattern (2 fires, opposite X forces)
   τ > 0 :  TR.lat + BL.lat
   τ < 0 :  TL.lat + BR.lat
   τ_L,max = (yTop − yBot) · F    (arm ≈ 40 m)
```

Both patterns have zero net force by construction. Allocation, with
`|τ|` the wanted torque:

```
|τ| ≥ τ_V,max + τ_L,max :  both duties = 1            (saturated)
|τ| ≤ τ_L,max            :  d_L = |τ| / τ_L,max,  d_V = 0
otherwise                :  d_L = 1,  d_V = (|τ| − τ_L,max) / τ_V,max
```

Laterals go first because their arm is about 20× longer, so most demands
are met with laterals alone. The solver needs four pods (top and bottom on
each side); otherwise it returns an empty plan and the caller releases RCS.
The plain `targetTorqueRcs()` (greedy, sorted by torque per fire) is the
general solver and may leave a net force; V3 uses it nowhere in the coast.

The same file also provides the separation patterns used by the mission
layer: `preSeparationDuty`, `postSeparationAxialDuty` (`dn` or `up` on every
pod) and `postSeparationLateralDuty` (`lat` on one side).

---

## 4. Ascent block (pad → MECO)

Body-locked to the launch stack. Runs a sub-machine every tick.

### 4.1 Phases

```
PRE_COAST ──(INITIAL_COAST_S)──► PUSH ──(PUSH_T_S)──► COAST
COAST ──(AoA ≥ 0)──► HOLD ──(AoA < 0)──► COASTnAoADAMP
```

`PRE_COAST` and `COAST` command zero torque. The first throttle command is
sent on the first tick (after the first physics step) on purpose; sending it
earlier shifts the whole ascent by one tick and makes MECO fire early.

### 4.2 PUSH — a one-cycle sine torque pulse

At the PRE_COAST → PUSH transition the pulse amplitude is sized from the
peak torque the gimbal can make at `PUSH_MAX_GIMBAL_DEG`:

```
τ_peak = A·cos(g_max) + B·sin(g_max)              (§3.6 levers)
Δθ     = τ_peak · T² / (2π · I)                   T = PUSH_T_S
```

During PUSH the wanted torque is:

```
A_ang = 2π·Δθ / T²
ω_ang = 2π / T
τ_des = PUSH_EAST_SIGN · I · A_ang · sin(ω_ang · t)       0 ≤ t ≤ T
```

Integrating twice, one sine cycle of angular acceleration gives a total tilt
of exactly `Δθ` with **zero angular rate at the end**. That is the initial
eastward kick that starts the gravity turn, and it is sized by what the
gimbal can really deliver, not a hand-set angle.

### 4.3 HOLD and COASTnAoADAMP — PID on AoA

Same law for both phases, evaluated on the predicted next state:

```
aoa      = AoA₊ (rad)                  ω_AoA₊ from §3.5
∫aoa    += aoa·dt   only if |aoa| < 0.05°,  clamped to ±0.005 rad·s
τ_des    = −I₊ · ( KP·aoa + KD·ω_AoA₊ + KI·∫aoa )
τ_target = τ_des − τ_drag₊
```

`KP = HOLD_PD_KP`, `KD = HOLD_PD_KD`, `KI = HOLD_PD_KI` (fixed 0.3, `KI < KP·KD`
for stability). The integral removes the static AoA offset a PD leaves behind,
which grows with dynamic pressure. The gate and clamp stop wind-up during the
large transients. The integrator is reset in PRE_COAST, PUSH and COAST.

**Command shaping.** In HOLD / COASTnAoADAMP the requested gimbal angle is
low-passed with a physical time constant:

```
g_f ← g_f + (1 − e^(−dt/τ_c)) · ( g_req − g_f )          τ_c = GIMBAL_CMD_TAU_S
```

Reason: a deadbeat command (reach `g_req` in one tick) built on a stale
next-gimbal guess is marginal at low airspeed and limit-cycles at the Nyquist
frequency. The per-tick loop gain becomes ≈ dt/τ_c, so the residual jitter
vanishes as dt → 0. The filter is seeded from the measured gimbal on entry.

### 4.4 Throttle schedule (bucket through max-Q)

```
thrFrac = THROTTLE_FRAC                              (1.0 by default)
if THROTTLE_ALT_LOW_KM ≤ alt < THROTTLE_ALT_HIGH_KM:
      thrFrac = THROTTLE_FRAC_LOW                    (0.7 between 8 and 13 km)
flow_cmd = ṁ_max · thrFrac     (re-sent only if it changes by > 0.5 kg/s)
```

### 4.5 MECO — fuel-triggered

The only trigger. Fire MECO at the first tick where the booster tank, after
the spool-down burn, would hold exactly the target residual:

```
for each engine e:
      t_spool_e = ṁ_e · shutdownS / ṁ_max_e
      burn_e    = ṁ_e · t_spool_e / 2
fire when   fuel_now − Σ burn_e  ≤  MECO_TARGET_BOOSTER_FUEL_KG
```

The spool integral already contains the tick in which the command
propagates, so there is no separate one-tick compensation. Apogee is
computed every tick for diagnostics only; it does not gate the trigger.
After the trigger the block issues `cmdSeparate()` and ends.

---

## 5. Insertion block (upper stage → payload)

Body-locked to the stage index (the mission layer resolves it after the
split). Multi-payload aware through `expectedPayloadCount` (default 1).

### 5.1 STAGE_BURN

Throttle is set to maximum. First, a **spool wait**: no attitude control
until every engine reaches 99 % of its own max flow, so the controller does
not fight start-up noise.

**Attitude: PID on AoA with a seeded, ramped target.** Entering STAGE_BURN the
AoA is about 1° from gravity-gradient drift during the axial wait. So:

```
first control tick:   b_eff = aoa_now     (error = 0, no torque spike)
afterwards:           b_eff += clamp( b_tgt − b_eff , ±RATE·dt )
                      b_tgt = STAGE_BURN_AOA_BIAS_DEG
                      RATE  = STAGE_BURN_AOA_BIAS_RATE_DEG_S

err   = aoa₊ − b_eff                                    (rad)
∫err += err·dt   only if |err| < 0.05°,  clamped to ±0.005 rad·s
τ_des = −I₊ · ( KP·err + KD·ω_AoA₊ + KI·∫err )
τ_target = τ_des − τ_environmental₊
```

`KP = STAGE_BURN_AOA_KP`, `KD = STAGE_BURN_AOA_KD`, `KI = 1.0` (fixed,
`KI < KP·KD`). The target never steps, there is no zeroing phase, and a
steady disturbance leaves no residual AoA error because of the integral.

The nonzero bias holds the nose slightly off the velocity vector, so thrust
has a small perpendicular component that changes how fast the natural tilt
grows during the burn.

τ_target then goes through §3.6 (gimbal angle) and §3.7 (accel command).

**Cutoff prediction.** Each tick, compute apogee now, and apogee after the
engine's remaining spool-down impulse:

```
dv   = dv_spool + STAGE_BURN_CUTOFF_MARGIN_MPS               (§3.8)
dir  = ( −sin(θ − g) , cos(θ − g) )                          thrust direction
v⃗'   = v⃗ + dir · dv                                         predicted velocity
apogee' = apogee computed from (r⃗, v⃗')                      (§3.2)

cut off when   apogee ≥ TARGET_ORBIT_ALT_KM
          or   apogee' ≥ TARGET_ORBIT_ALT_KM
```

The margin is extra predicted Δv (default 0): a positive value cuts earlier
and leaves a gap for the RCS trim.

### 5.2 RCS_BOOST — exact apogee by RCS

Wait until every engine flow is below 1 kg/s. Then:

```
err = apogee − TARGET_ORBIT_ALT_KM
fire axial RCS  "dn" if err > 0, else "up"
done when err changes sign
```

At the crossing, the burn plan for circularization is computed once:

```
r_apo = a(1 + e)               v_apo = |h| / r_apo
v_orb = √( GM / r_apo )        dv_needed = max(0, v_orb − v_apo)

eccentricity vector  e⃗ = ( (v² − GM/r)·r⃗ − (r⃗·v⃗)·v⃗ ) / GM
apogee direction     = −ê         → inertial target angle θ_apo

m_final = m / exp( dv_needed / Ve )          (Tsiolkovsky)
t_burn_ideal = (m − m_final) / ṁ_max
t_burn_practical = t_burn_ideal · COAST_BURN_MULTIPLIER
```

`θ_apo` (the attitude that points the thrust along the apogee velocity
direction) and `v_orb` are stored for the later phases.
`t_burn_practical` is stored; in the code read for this document the
circularization trigger does not use it (it uses §5.4).

### 5.3 Coast: rotate, wait, rotate again, hold

```
COAST_ROTATE : slew to θ_apo with RCS            (first pass → COAST_WAIT)
COAST_WAIT   : free drift, nothing fires
               until t_to_apogee ≤ COAST_WAIT_BEFORE_APOGEE_S (90 s)
COAST_ROTATE : slew again to θ_apo               (second pass → COAST_HOLD)
COAST_HOLD   : hold θ_apo until the circularization trigger
```

The first rotate happens long before apogee; free drift over the wait lets
gravity-gradient torque tilt the stage, so a second rotate re-aims just
before the burn. Rotate and hold use the same PD law, in inertial angle:

```
θerr  = wrap( θ − θ_apo )
τ_des = −I₊ · ( CIRC_ATT_KP·θerr + CIRC_ATT_KD·ω )
RCS   = targetTorqueRcsNoNetForce(τ_des)            (§3.9)
rotate done when  |θerr| < COAST_ROTATE_TOL_DEG  and  |ω| < COAST_ROTATE_OMEGA_TOL
(or after COAST_ROTATE_TIMEOUT_S)
```

### 5.4 CIRCULARIZE

Trigger:

```
t_to_apogee ≤ engine.startupDurationS + CIRC_TRIGGER_LEAD_S      (§3.3)
   or  vr crosses from positive to ≤ 0  (apogee peak)
```

Burn:

```
v_err = v_orb − |v|                     (inertial speed against target)

decayWindow = CIRC_DECAY_FRAC · v_orb
thrFrac = 1                                   if v_err > decayWindow
thrFrac = max( 0.4 , 0.4 + 0.6·v_err/decayWindow )     otherwise
```

Throttle tapers to 40 % in the last part of the burn for a finer finish.

Attitude: the same PD as the coast, but torque goes to the **gimbal**
(§3.6, §3.7) instead of RCS:

```
τ_des = −I₊ · ( CIRC_ATT_KP·θerr + CIRC_ATT_KD·ω )
```

Cutoff, early by the spool Δv **plus** the payload eject kick (pre-compensated
so the payload leaves at the right speed):

```
cutoffThreshold = dv_spool + PAYLOAD_EJECT_KICK_MPS
cut off when  v_err ≤ cutoffThreshold
```

### 5.5 Release and finish

```
COAST_ROTATE_2 : wait until engines are off, compute θ_apo again, slew to it
COAST_HOLD_2   : hold θ_apo
at apogee peak : cmdReleasePayload()
DONE           : once every expected payload body has spawned and is
                 PAYLOAD_CLEAR_DIST_M (20 m) clear of the stage
                 (give up after PAYLOAD_CONFIRM_TIMEOUT_S)
```

---

## 6. Constants

Values as in the repo snapshot read for this document. The three tuned
baseline values are marked.

**Ascent**

| Constant | Value | Meaning |
|---|---|---|
| `INITIAL_COAST_S` | 4.9 | zero-torque coast before PUSH |
| `PUSH_T_S` | 4.82 | length of the push pulse |
| `PUSH_MAX_GIMBAL_DEG` | **0.61** (tuned) | gimbal angle that sizes the pulse |
| `PUSH_EAST_SIGN` | −1 | push direction |
| `HOLD_PD_KP / KD` | 1.0 / 2.0 | HOLD gains |
| `HOLD_PD_KI` | 0.3 (fixed) | HOLD integral gain |
| `GIMBAL_CMD_TAU_S` | 0.1 | command low-pass time constant |
| `THROTTLE_FRAC` | 1.0 | nominal throttle |
| `THROTTLE_ALT_LOW_KM / HIGH_KM` | 8 / 13 | throttle bucket |
| `THROTTLE_FRAC_LOW` | 0.7 | throttle inside the bucket |
| `MECO_TARGET_BOOSTER_FUEL_KG` | 52612 | residual fuel at engine stop |
| `GIMBAL_TARGET` | center | which engines gimbal |

**Insertion**

| Constant | Value | Meaning |
|---|---|---|
| `TARGET_ORBIT_ALT_KM` | 320 | the mission's orbit altitude |
| `STAGE_BURN_AOA_KP / KD` | 4.0 / 4.0 | STAGE_BURN gains |
| `STAGE_BURN_AOA_KI` | 1.0 (fixed) | integral gain |
| `STAGE_BURN_AOA_BIAS_DEG` | **0.59** (tuned) | target AoA offset |
| `STAGE_BURN_AOA_BIAS_RATE_DEG_S` | 0.5 (fixed) | bias ramp rate |
| `STAGE_BURN_CUTOFF_MARGIN_MPS` | 0.0 | extra predicted Δv at cutoff |
| `COAST_ROTATE_TOL_DEG` | 0.5 | rotate done: angle |
| `COAST_ROTATE_OMEGA_TOL` | 0.02 | rotate done: rate (rad/s) |
| `COAST_ROTATE_TIMEOUT_S` | 240 | rotate give-up time |
| `COAST_WAIT_BEFORE_APOGEE_S` | 90 | when the second rotate starts |
| `COAST_BURN_MULTIPLIER` | 4.0 | burn-time safety factor (stored) |
| `CIRC_TRIGGER_LEAD_S` | **5.64** (tuned) | burn-start lead, added to engine startup |
| `CIRC_DECAY_FRAC` | 0.05 | throttle taper window, fraction of `v_orb` |
| `CIRC_ATT_KP / KD` | 0.5 / 4.0 | coast and circularize attitude gains |
| `PAYLOAD_CLEAR_DIST_M` | 20 | payload clear distance |
| `PAYLOAD_CONFIRM_TIMEOUT_S` | 120 | payload confirm timeout |
| `GIMBAL_TARGET` | all | which engines gimbal |

Also decided by the mission layer **(unverified here)**: `SEPARATION_DURATION_S`,
`SUICIDE_DELAY_AFTER_DEPLOY_S`.

Not constants, read at runtime from the vehicle: thrust, `Ve`, `ṁ_max`,
startup and shutdown durations, `gimbalMaxDeg`, `gimbalRateDegS`,
`gimbalAccelDegS2`, mass, `I`, centre of mass.

The "fixed" constants are deliberately not in the tunable key list, so they
are not part of retuning.

---

## 7. Design decisions and why

1. **Torque-based, not angle-based gimbal control.** The desired torque comes
   from the attitude law; the gimbal angle is whatever produces that torque
   with the current thrust and lever arms. So the same law works for any
   engine, any mass, any centre of mass.
2. **Accel-limited gimbal.** A real gimbal cannot jump. Modelling accel, rate
   and angle limits makes a command that works in the sim honest.
3. **AoA's own rate, no accel term.** Removes the dependence of the desired
   torque on the unknown gimbal, which would create a one-tick sign-flip loop.
4. **Analytic derivatives.** Finite differences amplify noise by 1/dt².
5. **PID with a gated, clamped integrator.** Removes steady offsets from
   dynamic pressure and gravity gradient; the gate and clamp prevent wind-up.
6. **Seeded, ramped target.** The command never steps at burn start.
7. **Early cutoffs by spool Δv.** The engine's own shutdown model is used, so
   the sim and the guidance agree on what "stop" means.
8. **Net-zero-force RCS for coasts.** Attitude control must not move the orbit.
9. **Everything from the vehicle record.** Swapping the engine type in the
   fleet editor carries through without touching the guide.

---

## 8. Known limitations

- **Wind not verified end-to-end.** The controllers use the same
  relative-wind math as physics, so the structure is wind-aware, but the
  constants have not been tuned against a windy ascent.
- **Earth is the only gravitating body.** Sun and Moon are not modelled.
  Negligible for one mission; long-term propagation would need more.
- **Very high orbits or very low TWR stacks** may need the controller gains
  adjusted, as with any real autopilot.
- **Circularization accuracy** depends on control authority at the target
  altitude: a shorter burn gives tighter results.

---

## 9. How to explain it in two minutes

> The rocket flies itself. Each tick it looks one tick into the future,
> decides how much torque it needs to keep its nose where it wants (a PID on
> angle of attack), subtracts the torque that gravity and air will already
> apply, and works out the gimbal angle that makes exactly that torque. The
> gimbal is modelled like a real one, so guidance commands an angular
> acceleration, not an angle. Every engine cutoff is fired early by exactly
> the thrust the engine will still make while it winds down, so the speed
> when the engine really stops is the speed we wanted. In the coast it only
> uses balanced pairs of RCS thrusters so it never nudges the orbit. The
> whole thing is built from three reusable blocks, and everything about the
> engine and the stack is read from the vehicle, so the only number you
> have to give it is the orbit altitude.

---

## 10. Source map

| What | File |
|---|---|
| Blocks `ascent`, `insertion`, `suicide`, gimbal helpers `_gimbalAlphaCmd`, `_gimbalNextAngle`, `_gimbalCmdMsg`, `_timeToApogee` | `js/simJs/guidance/guidance-blocks.js` |
| Command builders, outbound `send()` | `js/simJs/guidance/guidance.js` |
| Next-state derivation, drag and environmental torque (unverified here) | `js/simJs/guidance/derivation.js` |
| Net-zero-force RCS (unverified here) | `js/simJs/guidance/guidercs.js` |
| Sensor noise on the snapshot | `js/simJs/guidance/imu.js` |
| Gimbal actuator integration, slider-path copy of the 2-tick law (`_gimbalAlphaCmdPhys`) | `js/simJs/core/physics.js` |
| Mission glue, presets, config keys | `js/simJs/guidance/guidance-experiments.js`, `js/guideConfigDefaults.js`, `js/guideConstantDescriptions.js` |
