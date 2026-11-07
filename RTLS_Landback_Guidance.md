# Landback Guidance System — RTLS Booster Recovery

> A guided walk-through of how the simulated Falcon‑9‑class booster flies itself back to the launch site and lands on its legs — written for readers who do not know the code (students, professors, reviewers).
>
> **Scope:** 2‑D planar simulation, `landbackV1` guide, `standardRTLS` booster block, plus the tooling used to tune it (`landback-align-lab`).
> **Status:** soft landing achieved with zero measurable hop; all five landing criteria pass with large margin (see §7).

---

## 1. The idea in plain language

After the booster separates from the upper stage at about 140 s, it is moving fast, upward and **away** from the launch site. To land back where it started, it must:

1. **Turn around** (it separates nose‑forward; engines must point the other way).
2. **Cancel its outbound speed and fly back** with a long engine burn (boostback).
3. **Survive re‑entry** — a short burn to slow down before the thick air, then glide on grid fins.
4. **Land vertically** with a "hoverslam": ignite one engine late and brake so that the speed reaches almost zero exactly when the legs touch the ground.

A rocket cannot hover at low weight — its smallest thrust is *larger than its own weight* (see §6.3). That single fact makes the final seconds the hardest part, and most of the work in this project went into it.

The guidance software is a **sequence of phases** (a state machine). Each phase has one job, a clear exit condition, and hands the vehicle to the next one.

```
SEP handoff → FLIP → BOOSTBACK_BURN → PRE_ENTRY_STEER → ENTRY_BURN
            → POST_ENTRY_STEER → LANDING_BURN_ALIGN → LANDING_BURN → TOUCHDOWN_COMPLETE
```

Reference timeline from a successful run (times are mission seconds):

| Phase | Starts | Altitude at start | What happens |
|---|---|---|---|
| Separation handoff | 139.9 | – | Stage separation, booster handed to RTLS block |
| FLIP | 139.9 | – | Rotate ~180° (≈ 20 s) |
| BOOSTBACK_BURN | 159.7 | – | 3 engines → 1 engine, aims impact at pad (≈ 40 s) |
| PRE_ENTRY_STEER | 199.2 | 124 km | Coast; align at 90 km |
| ENTRY_BURN | 415.3 | 60 km | Full‑thrust burn until speed ≈ 600 m/s |
| POST_ENTRY_STEER | 432.0 | 44 km | Grid‑fin steering through the atmosphere |
| LANDING_BURN_ALIGN | 506.2 | 5 km | Fins ramp to neutral, vehicle settles |
| LANDING_BURN | 520.6 | 2 km | One‑engine suicide burn, legs deploy at 200 m |
| TOUCHDOWN_COMPLETE | ~542 | 0 | Engine off, state logged |

---

## 2. Software architecture

| Piece | Role |
|---|---|
| **Physics core** (`physics.js` + parts) | Integrates the vehicle: gravity, thrust, aerodynamics, gimbal, grid fins, legs, ground contact. |
| **Guidance blocks** (`guidance-blocks.js`, `standardrtls_full.js`) | Each flight phase is a block. Blocks read the vehicle state, send *commands* (throttle, gimbal, RCS, fins, legs). They never move the vehicle directly. |
| **Mission glue** (`lb_glue.js`) | Runs the whole mission: ascent → separation → insertion of the upper stage → hands the booster to the RTLS block. |
| **Derivation** (`derivation.js`) | Turns raw state into useful numbers: mass, inertia, centre of mass, local gravity, engine limits, leg geometry. Needed because the guidance runs in a separate worker thread and can only receive plain data. |
| **Config** (`guideConfigDefaults.js`, descriptions) | All tunable constants live in a preset. **Important:** if a key is missing from the preset, the in‑code default is *never* used at runtime — a lesson learned the hard way. |
| **Labs** (`guidance-tester2.html`, `landback-align-lab.html`) | Offline test benches (see §8). |

Command flow every tick (80 Hz): `read state → derive quantities → phase logic → send commands → physics step`.

---

## 3. Phase by phase

### 3.1 FLIP — turning the booster around
The booster starts almost spin‑free but pointing the wrong way (error ≈ 230°). A **pusher** (cold‑gas torque) plus the RCS thrusters spin it up; the software predicts, with a rollout that includes the aerodynamic torque, *where the rotation would stop if braking started now*, and starts braking at exactly the right moment. Result in the run: flip done in 19.8 s with **0.00° overshoot**. Exit when angle error < 0.5° and rate < 0.005 rad/s.

### 3.2 BOOSTBACK_BURN — flying back
Goal: reduce the *impact point error* (where the booster would hit the ground if it coasted from now) to zero at the target pad. The error is evaluated continuously, including the extra velocity change that spooling engines will still add. The burn starts with three engines (centre + two outer), drops to the centre engine when the error becomes small, then cuts off when the error is ≈ 0 (final error 0.0000° in the run). The throttle tapers as the error shrinks to avoid overshooting.

### 3.3 PRE_ENTRY_STEER — coast and align
Grid fins are deployed, engines are off. Above 90 km the vehicle drifts (lateral RCS only); at 90 km it aligns to the air‑relative retrograde direction and holds with a PD controller until the ENTRY_BURN altitude (60 km).

### 3.4 ENTRY_BURN — slowing down before the thick air

**Purpose.** At 60 km the booster is still very fast. A short burn slows it to ≈ 600 m/s relative to the air so that heating and aerodynamic loads stay survivable, *and* it is used to fine‑tune where the booster will land.

**Engine program.** Centre + two outer engines (`C,0,180`) at **full throttle, not modulated**. The burn ends on a speed condition: when Earth‑relative speed ≤ 600 m/s the engines are commanded off and spool down (reference run: cutoff at 45.3 km, burn done at 44.2 km, 543 m/s).

**How it steers (important idea).** With the throttle fixed, the only way to move the impact point is to change *which way the thrust points*. Pointing the thrust slightly off the retrograde direction adds a small sideways velocity, which shifts the predicted impact point. The guidance therefore steers the **body attitude** with the RCS thrusters (on/off jets), not with throttle:

1. **Impact error** `err` is computed every tick from the ballistic (vacuum) trajectory: where would the booster land if it just coasted from now, minus the pad position, minus the **bias** (see below).
2. **Time to go** `T_go` is estimated from the filtered rate of speed loss: `(v − 600) / (−dv/dt)`.
3. **Sensitivity** `κ`: the booster is "virtually" given a small velocity change along the thrust direction and the change of impact point is measured numerically. Multiplied by the thrust acceleration this says how much the impact point moves per second of attitude error.
4. **Predicted error at cutoff** `s = err + err_rate·T + κ·∬ω` — the error now, plus where it is drifting, plus the effect of the rotation that the RCS can still produce. The rotation term accounts for the braking distance: the vehicle cannot stop spinning instantly, so the controller decides *now* whether to fire the jets clockwise, counter‑clockwise, or not at all.
5. **Decision** (bang‑bang with a 100 m dead band): `s > +100 m` → fire one way, `s < −100 m` → the other, otherwise null the rotation rate. In the reference run 39 direction changes ("flips") were needed.
6. **Gimbal** is not used for steering; the centre engine is gimballed only to **cancel the environmental torque** (aerodynamic and gravity‑gradient torque estimated one tick ahead), so the attitude is not disturbed. If the required angle exceeds the gimbal limit the log shows `gimbal SATURATED`.

**The bias.** `ENTRY_BURN_IMPACT_TARGET_M` is subtracted from the error, so the burn does *not* aim at the pad — it aims at a point shifted by the bias (tuned to **−726.8 m**). After cutoff the booster still flies through dense air, and the drag and the fin steering of the next phase systematically move the impact point; the bias is chosen so that the booster arrives at the start of the landing burn in the right place and on the right braking curve. It is mission‑specific and is found with the Bias Scan (§8). Reference outcome: impact error 0.045 km at the end of the burn.

### 3.5 POST_ENTRY_STEER — steering with the grid fins

**Purpose.** Between 44 km and 5 km the engines are off. The booster falls through the atmosphere; the air itself is used to steer, so that the remaining impact error is removed before the landing burn.

**Principle.** The grid fins and the hull produce aerodynamic force. If the body is tilted by an angle of attack α, the lateral aerodynamic force changes, which slowly changes the impact point. So the *real* control variable is the **attitude angle** θ; the fins and RCS are the means to hold that angle against the aerodynamic torque.

**Step 0 — observe first (6 s).** Fins are held at zero, RCS is off, and the software only compares *measured* angular acceleration with the *modelled* torque (drag + gravity gradient + fin). This is a model‑validation window: if the model were wrong the log would show it before any command is issued.

**Then, every tick, a closed loop:**

1. **Impact error and its sensitivity.** `err` = impact point (vacuum) − pad. `S = (Sx, Sy)` is how much the impact point moves per 1 m/s of velocity change in each direction (finite differences on the same ballistic predictor).
2. **Desired rate of error.** `edot_des = −err / τ`, with τ = 40 s (the error should decay with a 40 s time constant — slow and smooth). Predicted current rate: `edot_pred = Sx·a_x + Sy·a_y` from the current aerodynamic acceleration.
3. **Which attitude change achieves it.** The model is re‑evaluated with θ + 1° to get the Jacobian `J = ∂edot/∂θ`. Required change: `Δθ = (edot_des − edot_pred) / J`.
4. **Reality limits.** `Δθ` is clipped to what the available torque can hold (fin torque range over ±30° plus 80 % of the RCS torque, against the drag/gravity‑gradient torque of the new angle), to ±6° per step, and so that |α| ≤ 12°.
5. **Attitude PD.** Torque command `τ = I·(−Kp·(θ − θ*) − Kd·ω)` (Kp = 0.05, Kd = 0.6), converted to a **fin deflection** by inverting the fin‑torque curve (tabulated every 5° over ±30°, rate‑limited to 40°/s).
6. **RCS tops up what the fins cannot give.** Remaining torque is produced by **lateral‑only** RCS jets (never up/down jets, which would change speed) with a 500 N·m dead band.
7. **Disturbance observer.** A running filter compares measured torque to modelled torque (a "ledger") and adds the difference (limited to ±150 kN·m) as an estimate of what the model misses.

**Exit.** At 5 km (`LANDING_BURN_ALIGN_ALT_KM`) the phase hands over. Reference run: vacuum impact error −0.04 km and ground error 0.16 km at the handoff, α = 6°, ω = 0.05°/s.

### 3.6 LANDING_BURN_ALIGN — settling
Fins ramp smoothly to zero and the vehicle coasts to its natural aerodynamic equilibrium so that landing burn begins with a clean, quiet attitude (α ≈ −0.2°, tiny rotation rate).

### 3.7 LANDING_BURN — the hoverslam (the core of the project)
Detailed in §4–§6.

### 3.8 TOUCHDOWN_COMPLETE
On first ground contact the guidance sends zero throttle, gimbal, fins and RCS, holds while the engine spools down (≤ 4 s), then logs the final state and a **hop tracker** (§5.5) and finishes.

---

## 4. The landing burn: two controllers that cooperate

The vehicle must satisfy two independent things at the same time:

* **Vertical:** arrive at the ground with a small, controlled sink rate — controlled by **throttle**.
* **Lateral:** arrive over the pad, with almost no sideways speed — controlled by **tilting** the vehicle (thrust direction) with the gimbal, helped by grid fins.

The software calls this controller **SLAM v6**: a *zero‑effort‑to‑go vertical law* plus an *authority‑aware lateral cascade*.

### 4.1 Vertical law — "brake exactly as hard as needed"

At any moment, with height `h` above the leg tips and downward speed `v`, the constant deceleration that would reach the target touchdown speed `V_TD` exactly at the ground is

```
aNeed = (v² − V_TD²) / (2 h)
```

A reference deceleration `aRef` is what the vehicle gets when flying at a nominal throttle. The commanded deceleration is

```
aReq = aRef + K·(aNeed − aRef),    K = 2
```

* If the vehicle is **above** the ideal curve (needs more braking) → it brakes harder.
* If **below** (too slow) → it reduces throttle (down to the engine's minimum).
* With K > 1 the error shrinks as height decreases, so the law stays stable all the way to the ground.

Every second the software also runs a quick **rollout** ("LB‑REPLAN") that predicts the touchdown height and speed from the present state; if the prediction is off, it is visible in the log immediately.

### 4.2 Lateral cascade — three nested loops

```
position/velocity error  →  desired tilt θ_des  →  attitude PD  →  gimbal (+ grid fins)
```

1. **z‑loop.** Control is done not on the centre of mass but on a point offset by `ℓ = I/(m·c)` (the *centre of percussion*), because there the lateral response to rotation is simpler. Reference lateral speed is limited by (a) a pull toward the pad, (b) a braking curve that uses only 30 % of the available lateral acceleration, (c) a speed limit that shrinks to ≈ 0 at the ground.
2. **Tilt command.** The needed lateral acceleration is converted to a tilt angle with the current thrust. The tilt is slew‑limited (4°/s) and capped: 10° high up, shrinking toward 1.5° near the ground.
3. **Attitude PD.** `θ̈ = −Kθ(θ−θ_des) − Kω·ω`, executed by the gimbal.
4. **Authority awareness.** When the available lateral authority is too low (very early in the burn, thin gimbal torque), the controller holds the "weathervane" angle instead of commanding impossible tilts, and shares the work with the **grid fins** (gimbal keeps 40 % of its range, fins take the rest).

The outer velocity gain (0.5 s⁻¹) is deliberately about **three times slower** than the inner attitude loop (≈ 1 rad/s). This separation of time scales is what keeps the cascade stable; raising the outer gain without raising the inner one is the classic way to break it.

---

## 5. Making the touchdown gentle

The first successful landing still *hopped* — the booster bounced up a little and fell back. Understanding why led to four fixes.

### 5.1 Ground‑truth geometry (leg extension)
The guidance and the physics disagreed about how far the leg tips hang below the hull (3.06 m vs 3.37 m). The guidance therefore thought the ground was 0.31 m lower than it really was, and the vehicle touched down at ≈ 2 m/s instead of the planned ≈ 0.2 m/s. **Fix:** the guidance now uses the same geometry formula as the physics (rounded foot‑pad apex ≈ 3.37 m for a 39.7 m booster). Check line in logs: `[LEG-SLAM-OK] … src=physicsMatch`.

### 5.2 Thrust floor above weight
A Merlin‑class engine cannot throttle below ≈ 39 %, which is **more than the booster's weight** at landing mass (Fmin ≈ 330 kN versus weight ≈ 316 kN). The vehicle can brake but never hover. If the engine is cut while still at 58 % thrust, the thrust takes ≈ 0.8 s to fall below the weight, lifting the vehicle off its legs in the meantime.

### 5.3 Fmin blend
The reference throttle is faded from the nominal 60 % down to the minimum‑throttle fraction over the last ~8–15 m (`LB_H_BLEND`). The vehicle therefore arrives on the ground already at minimum thrust, so almost nothing is left to lift it off. Measured result: **hop = 0.0000 mm**.

### 5.4 Adaptive touchdown speed `V_TD`
At minimum thrust the vehicle decelerates only slowly (a_min = (Fmin − W)/m ≈ 0.4 m/s²). If it is already almost stopped just above the ground, it *stalls and climbs* instead of landing. The safe choice depends on landing mass, which changes with every fuel load:

```
a_min = max(0, Fmin/m − g)
V_TD  = clamp( √(2·a_min·margin), V_TD_min, V_TD_max )      margin = 0.2 m
```

| Landing mass | V_TD |
|---|---|
| ≥ 34 t (Fmin ≤ weight) | 0.30 m/s (floor) |
| 33 t | 0.35 |
| 32.2 t | 0.47 |
| 30 t | 0.72 |
| 28 t | 0.91 |

Lighter vehicle ⇒ larger a_min ⇒ must touch down faster to avoid stalling. A log line `[LB-VTD]` reports the value in use. Different fuel loads need no manual retuning of `V_TD`.

### 5.5 Hop tracker
After contact the logger keeps measuring: lowest altitude, highest altitude afterwards (`hop_mm`), maximum upward speed (`vy_peak`), and the compression of the hull on the legs (`sink_mm`).

---

## 6. Physics facts that shape the design

1. **Variable mass.** Mass drops ≈ 150 kg/s during the burn; gravity, thrust‑to‑weight and the controller's effective gains all drift. The software recomputes mass, inertia and centre of mass every tick.
2. **Centre of percussion.** `ℓ = I/(m·c)` — lateral position is controlled at this point to decouple translation and rotation.
3. **Thrust floor above weight** (§5.2) — the root of both the hop and the stall risk.
4. **Engine dynamics.** Throttle is rate‑limited; shutdown is a 2 s linear ramp of mass flow. Anything that needs the thrust to change quickly has to be commanded early.
5. **Gimbal authority is not constant.** At high dynamic pressure aerodynamic torque eats most of the gimbal's effect (effective gain 2–7 versus 17–24 s⁻² available). The log marks these moments `[NO‑AUTH]`.
6. **Ground contact.** The physics resolves contact at the leg tips (rounded foot pads), checks tilt and speed limits, and then lets the vehicle "settle".

---

## 7. Evidence — one full run

Key numbers from the final configuration (bias −726.8 m):

| Quantity | Result | Limit |
|---|---|---|
| Position error x at touchdown | ≈ 0.2 m | 42.5 m (pad radius) |
| Lateral speed | ≈ 0.26 m/s | 2.5 m/s |
| Tilt θ | ≈ 0.25° | 12° |
| Angular rate ω | ≈ 0.54 °/s | 8.6 °/s |
| Vertical speed at impact | ≈ V_TD (0.4–0.6 m/s) | 5 m/s |
| Hop | 0.000 mm | — |
| Landing burn duration | ≈ 21 s | — |

Each margin is large: the worst is vertical speed (≈ 12 % of its limit); position is < 1 % of the pad radius.

*Earlier run, for comparison (before bias tuning and the Fmin blend): x = 4.99 m, vx = 0.73 m/s, θ = 1.68°, hop visible.*

---

## 8. Tuning tools

### 8.1 Landback Align Lab
A browser tool that **snapshots** the simulation at chosen moments (at separation, start of entry burn, start of landing burn alignment) and re‑runs only the part you want, thousands of times faster than flying the whole mission.

### 8.2 Bias Scan
Because the entry‑burn aim bias depends on the mission, the lab can search it automatically:

* For each candidate bias: rebuild entry burn → alignment → fly the landing burn → measure.
* **Score** (lower is better): weighted sum of `|x|, |vx|, |θ|, |ω|, impact vy, hop` and the **tilt integral** `∫|θ|dt` over the landing burn — i.e. how long *and* how far the vehicle was tilted, not just the peak. Each term is divided by an adjustable scale; each spec violation adds +1000.
* **Search:** *fast* mode walks downhill from the current bias with doubling steps until the score rises (bracket), then golden‑section refinement to 2.5 m — typically 12–17 runs; *robust* mode sweeps the full range then refines.
* **Result:** ranked top‑5, bracket verdict ("peak bracketed", edge warnings), chart of score vs bias.

Findings from the scan:
* Too positive (> −690): the vehicle overshoots in x; spec violations appear.
* Too negative (< −780): it undershoots; x misses by tens of metres.
* The best region (−731 … −724 m) is a flat plateau: zero‑crossings of x, vx and θ lie at slightly different biases (−726, −730, −724), and the score balances them.
* The *lateral speed at the start of the landing burn* stays ≈ −6.7 m/s for every bias; only the lateral **position** changes (28 → 47 m). The best bias puts the vehicle exactly where that speed can still be braked to zero over the pad.

### 8.3 Param List Scan
Same scoring, but for any landing‑burn constant (e.g. `LANDING_BURN_V_TD`, `LANDING_BURN_KW`) — only the landing burn is re‑run, so it is fast. Includes a safety check: if every value gives an identical result the override didn't take effect.

---

## 9. Tunable constants (landing burn)

| Constant | Meaning |
|---|---|
| `LANDING_BURN_V_TD` | Minimum touchdown speed (floor of the adaptive rule) |
| `LANDING_BURN_V_TD_MARGIN_M` | Fmin‑coast stopping distance kept in reserve (0.2 m) |
| `LANDING_BURN_V_TD_MAX` | Upper cap on touchdown speed (1.5 m/s) |
| `LANDING_BURN_THR_LATE` | Nominal reference throttle fraction (0.6) |
| `LB_H_BLEND` | Height below which the reference throttle fades to Fmin (8–15 m) |
| `LANDING_BURN_LEGS_ALT_M` | Altitude to deploy legs (200 m) |
| `LB_KZ, LB_KV, LB_VH, LB_ABRK` | Lateral velocity/position loop |
| `LB_KTH, LB_KW, LB_SLEW` | Attitude loop and tilt slew limit |
| `LB_CAP_*` | Tilt cap far from / near the ground |
| `LB_FIN_SHARE, LB_FIN_RATE, LB_FIN_CAP` | Grid‑fin assist |
| `ENTRY_BURN_IMPACT_TARGET_M` | Entry‑burn aim bias (mission specific) |

---

## 10. Per‑mission procedure

1. Load the mission (vehicle, payload, pad).
2. Run the lab; **tune `ENTRY_BURN_IMPACT_TARGET_M`** with the Bias Scan.
3. Run one full mission; check the touchdown lines: `hop_mm ≈ 0`, `vy imp ≈ V_TD`, all five criteria pass. `V_TD` adapts automatically to the landing mass (`[LB-VTD]` line).
4. If the landing mass is far from anything tested, scan `LANDING_BURN_V_TD`/`MARGIN` once.

---

## 11. Known limitations & future work

* **Planar (2‑D) only.** No cross‑range; no wind.
* **Residual angular rate (≈ 0.5 °/s) and impact speed** are small but not zero; the likely lever for angular rate is modestly stronger attitude damping (`LB_KW`), not yet tuned.
* **Lateral speed at landing‑burn start (−6.7 m/s)** is the deepest remaining cause of tilt during the burn. Reducing it requires better steering in POST_ENTRY_STEER / LANDING_BURN_ALIGN (code change, not a constant). The steering law of POST_ENTRY_STEER only drives the *vacuum impact point* to the pad (time constant 40 s); it has no term for the lateral velocity that the landing burn will have to cancel. Adding one is the natural next improvement.
* The leg geometry formula is duplicated in physics and guidance; both must be changed together (a debug line `[LEG-PHYS-OK]` / `[LEG-SLAM-OK]` makes a mismatch visible).
* Vehicle‑specific numbers (Fmin, engine count, leg geometry) are read from the vehicle, but the margin and cap constants were chosen on one vehicle; a very different vehicle may need a quick scan.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **RTLS** | Return To Launch Site — booster lands back at the pad |
| **Boostback** | Engine burn reversing the booster's horizontal motion |
| **Hoverslam / suicide burn** | Landing burn started as late as possible so speed reaches ~0 at the ground |
| **Fmin** | Minimum engine thrust (cannot throttle lower) |
| **Gimbal** | Swivelling engine to steer thrust |
| **Grid fins** | Steerable aerodynamic surfaces for steering during descent |
| **RCS** | Reaction control thrusters — small cold‑gas jets for attitude |
| **Impact point** | Where the vehicle would hit the ground if it only coasted from now |
| **Bias** | Deliberate offset of the aim point to compensate for later effects |
| **Centre of percussion** | Point offset from the CoM where lateral and rotation dynamics decouple |
| **Hop** | Bounce of the vehicle after first ground contact |
| **V_TD** | Target touchdown speed |
| **Cascade** | Nested control loops: outer one commands the inner one |
| **Angle of attack (α)** | Angle between the vehicle axis and the air flow; controls the aerodynamic side force |
| **Bang‑bang control** | On/off control: the actuator is either fired in one direction, the other, or off |
| **Vacuum impact point** | Landing point computed ignoring the atmosphere (ballistic) — used as the guidance error signal |
