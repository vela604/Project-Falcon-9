# How a Rocket Booster Flies Itself Home

### A guided tour of the RTLS (Return‑To‑Launch‑Site) landback guidance — from the physics up to the equations

---

## 0. Before we start

### 0.1 The mission in one paragraph

A rocket booster pushes the upper stage as high and as fast as it can, then lets go. At that moment it is very high and very fast, moving **up and away** from the launch pad. If it did nothing it would fall into the ocean, far from home. Instead it must (1) turn around, (2) fire its engines to kill the outbound speed and aim itself back at the pad, (3) survive the thick air of re‑entry, and (4) arrive over the pad *upright*, moving almost **zero** — slowly enough that its landing legs, not its structure, absorb the touch.

Nothing here is steered by a pilot. A computer reads the vehicle's state 80 times per second and commands four kinds of actuators.

### 0.2 The four tools

| Tool | What it is | A simple way to picture it |
|---|---|---|
| **Engines (thrust)** | Big rocket engines at the bottom. Their only job is to push along the body axis; the throttle sets how hard. | The accelerator and brake of a car |
| **Gimbal** | The engine can swivel a few degrees. A swivelled engine pushes slightly sideways *and* twists the vehicle. | The tiller of a boat |
| **RCS** | Small on/off gas jets on the sides. Weak, but they work in vacuum. | Tiny thrusters — like a drone's side puffs |
| **Grid fins** | Four steerable lattice wings near the top. Useful only when there is air. | Rudders / the flaps of a paraglider |

### 0.3 Three facts that shape every design decision

1. **The booster is long and heavy at the top.** A 40‑metre cylinder does not tilt easily. Everything that rotates it has to be planned *ahead*.
2. **Actuators are weak, laggy, or on/off.** RCS cannot be "half on" in a smooth way. Engines take ~2 s to spool up and down.
3. **A rocket engine cannot throttle down to nothing.** The minimum thrust of the engine used for landing is *larger than the vehicle's own weight*. That means the booster **can never hover**. This single fact explains most of the difficulty of the last second of the mission (§7).

### 0.4 How the controller thinks, every 1/80th second

```
 read the state  ──►  predict the near future  ──►  decide a command  ──►  send it  ──► physics moves the vehicle
 (position, speed,     (one tick ahead, or          (throttle, gimbal,
  angle, spin, mass)    whole trajectory ahead)       RCS, fins)
```

A recurring theme: **predict, then act**. The vehicle is too slow to correct mistakes after the fact, so every phase answers the question *"if I do nothing more, where will I end up?"* and acts to make that answer correct.

### 0.5 What each phase does (the whole mission on one page)

| # | Phase | Starts | Engines | Gimbal | RCS | Grid fins | Job |
|---|---|---|---|---|---|---|---|
| 1 | FLIP | 139.9 s | off | off | **rotates** | – | Turn the engines toward the flight path |
| 2 | BOOSTBACK | 159.7 s | 3→1, tapering | **holds direction** | off | – | Cancel outbound speed, aim at the pad |
| 3 | PRE‑ENTRY | 199.2 s | off | off | aligns & holds | deployed | Face the airflow |
| 4 | ENTRY BURN | 415.3 s | full, 3 engines | **cancels torque** | **steers** | deployed, idle | Slow down; trim the impact point |
| 5 | POST‑ENTRY | 432.0 s | off | centred | tops up | **steer** | Remove the remaining impact error |
| 6 | LB ALIGN | 506.2 s | off | centred | off | ramp to 0 | A calm start for the final burn |
| 7 | **LANDING BURN** | 520.6 s | 1 engine → **vertical control** | **lateral control** | off | assist | Stop exactly at the ground, over the pad |

### 0.6 How to read the rest

Each phase is told in the same four steps:

* **The problem** — why is it hard?
* **The insight** — the one idea that makes it easy.
* **Build‑up** — equations, one small step at a time, with real numbers from a real simulated run.
* **What you see in the run** — the result.

If you only want the story, read *The problem* and *The insight* of each phase. If you want the equations, read on.

### 0.7 Notation (you can come back to this)

| Symbol | Meaning |
|---|---|
| θ | body angle (the direction the nose points) |
| ω | rotation rate (how fast θ is changing) |
| M, I | mass; moment of inertia (how hard it is to spin) |
| g | gravity at the vehicle's location (≈ 9.7–9.8 m/s²) |
| h, v | height above the ground (leg tips); speed *downward* |
| a | acceleration or deceleration (m/s²) |
| F | engine thrust (N) |

---

## 1. FLIP — turning the engines toward the flight path

### The problem
Right after separation the booster points the wrong way — its engines face *down‑range*, but to brake it needs them to face *against* the motion. It must rotate by 232.5° using only RCS, which is weak (it can speed the rotation up by just **1.84 degrees per second, every second**). And while it turns, the (still thin) air pushes on it like a **weather vane**.

### The insight
Think of a long, heavy turntable that you can push with a weak motor. To turn it by a given angle in the least time: **push as hard as you can, then at exactly the right moment push as hard as you can the other way, so that it stops precisely on target.** The whole problem is deciding *the right moment*.

Brake too late and it overshoots; too early and you waste time. The right moment is when the **distance needed to stop** equals the **distance remaining**.

### Build‑up

**Step 1 — the ideal case (no air).** Let the RCS give acceleration `a` both ways. To cover an angle D from rest to rest: accelerate for half the time, brake for half. Then

```
D = 2 · ½ · a · (t/2)²      →      t = 2·√(D / a)
```

For this mission D = 232.5° and a = 1.84°/s²:

```
t = 2·√(232.5 / 1.84) = 2 · 11.24 = 22.5 s
```

The log prints exactly that: *"t(−)=22.4 s"*. The separation pusher (a small extra rotation push at the start) brings the estimate down to *18.6 s*. The real flip took **19.8 s**.

**Step 2 — the braking rule.** While rotating at rate ω, braking with deceleration `a_b` takes an angle

```
stopAng = ω² / (2·a_b)
```

(that is the same formula as the braking distance of a car: `v² / 2a`). So the rule is

```
accelerate until   |angle still to go|  ≤  stopAng   →   then brake at full power
```

**Step 3 — why the simple rule fails here.** With ω = 18.5°/s and a_b = 1.84°/s², the rule says `stopAng = 18.5²/(2·1.84) ≈ 93°`. But the real log says:

```
[FLIP-BRAKE-START] t=3.5  err=-200.5°  w=-18.53°/s  stop=200.7°
```

The controller began braking when 200° were still to go — **twice as early** as the simple rule. The reason: in the first‑tick table of this run the *air's* angular acceleration reaches about **7°/s²**, almost four times what the RCS can produce. The air does not help the brake; it fights it. The effective deceleration was only

```
a_eff = ω² / (2·stopAng) = 18.53² / (2·200.7) ≈ 0.86 °/s²    (instead of 1.84)
```

A controller that ignored the air would have braked too late and overshot wildly.

**Step 4 — how the real controller finds `stopAng`.** It does not use a formula; it *simulates the braking forward in time*, step by step, until the rotation stops:

```
ω̇ = a_RCS(t) + a_air(θ, t)
ȧ_RCS = ( a_brake − a_RCS ) / τ_lag          ← the jets take a moment to reach full push
```

- `a_air(θ)` comes from a **table**: the program asks the physics model, for 72 different angles, "what torque would the air exert at this angle?" — and rebuilds the table every 0.5 s. It also builds predicted tables for 8, 16 and 24 s ahead, because the air gets denser as the booster falls.
- `τ_lag` and the RCS gain are **measured in flight**: the gain by a least‑squares fit of "commanded torque vs. actual angular acceleration", the lag from the time the response needs to reach 63 % of its final value.
- The state is advanced by **one tick** before every decision (a command takes one tick to act).
- A 1° margin avoids chatter.
- In the last braking tick the torque is not full but `(−ω/dt − a_air)/k` — just enough to make ω exactly zero.

### What you see in the run
The flip ends in **19.8 s with 0.00° overshoot**. The target direction itself is "the nose opposite to the horizontal part of the velocity": take the velocity, remove the part along the vertical, and point opposite to what remains.

---

## 2. BOOSTBACK — cancelling the outbound speed

### The problem
The booster is moving away from the pad at several hundred metres per second. Burn too little and it lands in the sea; burn too much and it lands beyond the pad on the other side. And there is no feedback in the usual sense — you can't see "where am I relative to the pad" because the pad is not the target yet; the **future landing point** is.

### The insight
At any instant you can compute: *"If I switched all engines off right now, where would the booster hit the ground?"* — a **predicted impact point**. Burn until that point reaches the pad. It is like adjusting a golf swing in mid‑air: you don't care where the ball is, you care where it *will land*, and you push until that is the hole.

### Build‑up

**Step 1 — the predicted impact point.** From the current position and velocity, integrate only gravity forward in time (1 s steps, up to 2500 s) until the vehicle reaches the Earth's surface. Convert the landing position into an angle that rotates with the Earth (so the pad stands still):

```
φ_impact = φ_inertial − Ω · t
error e = (φ_impact − φ_pad) · R_earth        (in metres, along the ground)
```

At the start of the burn the error was `err0 = 3.048°` of arc ≈ 339 km. The burn's job is to bring that to zero.

**Step 2 — when to stop.** The engines do not stop instantly; as they spool down they still add a bit of speed Δv_spool. So the test uses the error *as it will be after the spool‑down*:

```
cutoff when  e( v + n̂ · Δv_spool ) ≤ 0
```

**Step 3 — easing off.** Cutting at full thrust risks overshoot. Two things are done:

* **Three engines at first**, then at `err ≈ 0.18°` only the **centre** engine (outer engines off).
* **Throttle taper:** `throttle = f_min + (1 − f_min)·clamp(e / TAPER, 0, 1)`. As the error shrinks the throttle falls linearly — a gentle landing of the impact point on the pad.

**Step 4 — the gimbal's job: keep the nose on the local horizontal.** The engines push along the nose, so *where the nose points is the direction of the burn*. The target is the local horizontal (tangent to the Earth). A "spring and damper" law on the angle error:

```
torque wanted  τ = − I · ( Kp · θ_error + Kd · ω )         Kp = 0.5,  Kd = 1.2
```

- The spring `Kp` pulls the nose back toward the target; the damper `Kd` opposes rotation so it does not swing.
- Natural frequency `ωₙ = √Kp = 0.71 rad/s`; damping ratio `ζ = Kd/(2√Kp) = 0.85` — slightly under 1, so it settles fast with almost no overshoot.
- The controller evaluates the law on the state **one tick ahead**, and subtracts the torque the environment exerts (`τ_target = τ_wanted − τ_env`), so it only asks the gimbal for what is actually missing.

**Step 5 — turning torque into a gimbal angle.** An engine with thrust F, a distance *c* below the centre of mass, deflected by an angle γ, produces a torque

```
τ(γ) = A · cos γ + B · sin γ          A = Σ (x_engine − x_COM) · F   (offset engines, constant push)
                                      B = c · Σ F                      (thrust times the lever arm)
```

Write `R = √(A² + B²)` and `φ = atan2(A, B)`; then `τ = R · sin(γ + φ)`, so

```
γ = asin( τ / R ) − φ
```

(Two solutions exist; the one with the smaller |γ| is chosen, and clipped to the gimbal limit.) Plainly: *bigger thrust → longer lever → smaller angle needed.* When thrust is tiny (engine still spooling up) R is tiny and the same torque would need an enormous angle — which causes oscillation. That is why the gimbal is **frozen until the engines reach full thrust**.

### What you see in the run
The impact error ends at **0.0000°** (cutoff at t = 198.4 s). Three engines burned to 189.9 s, the centre engine alone for the last ~9 s.

---

## 3. PRE‑ENTRY STEER — arriving at 90 km already facing the wind

### The problem
At 124 km altitude there is no air. At 60 km the booster will enter dense air at several hundred m/s. To survive, the booster should face the air **head‑on** — nose against the airflow — so the airflow hits it symmetrically (low heating, small twisting torque). Between 124 km and 60 km it has to be turned to that exact direction, and it must arrive with almost no spin left over.

### The insight
Don't turn as fast as possible; turn at a *steady pace that finishes on time*. Like walking to a meeting: if the destination is 100 m away and you have 100 s, walk 1 m/s — don't sprint and wait.

### Build‑up

**Step 1 — where is "head‑on"?** The air moves with the Earth. So the wind the booster feels is its velocity *relative to the rotating Earth*:

```
v_rel = ( vx − Ω·y ,  vy + Ω·x )              (Ω = Earth's rotation rate)
nose target:  θ* = atan2( v_relx , −v_rely )   (nose opposite to v_rel)
```

**Step 2 — where will "head‑on" be when I get there?** The booster is coasting under gravity alone, so its path can be computed: propagate (gravity only, 0.5 s steps) until the radius equals `R_earth + 90 km`. At that future moment compute `θ*_future` and the time `T` it takes. This is refreshed every 0.5 s.

**Step 3 — the on‑time rate.** If the angle still to turn is θ_err and the time left is T_rem:

```
ω_desired = θ_err / T_rem
```

For example, to turn 20° in 100 s, turn at 0.2°/s. The RCS command is **proportional** to the difference between desired and actual rate, saturating:

```
duty = min(1, |ω_desired − ω| / 0.02),     dead band 0.001 rad/s
```

The jets are chosen in "pure torque" mode — pairs that rotate the vehicle without pushing it — so the trajectory is not disturbed.

**Step 4 — hold.** From 90 km the same law works on the live target, with a spring‑damper:

```
τ = − I · [ Kp·(θ − θ*) + Kd·(ω − ω_target) ],      Kp = 0.5,  Kd = 4.0
```

`ω_target` is the rate at which the target itself rotates (the airflow direction changes as the booster falls) — a "feed‑forward". The damping ratio is `ζ = 4/(2√0.5) ≈ 2.8` — **heavily over‑damped**: like a heavy door with a hydraulic closer, it creeps to the position and does not swing past it.

### What you see in the run
The switch from "drift" to "hold" at 90 km shows `θ_err = −0.21°` — the nose is within a fifth of a degree of the airflow direction, with a tiny rate. Handoff to the entry burn at 60 km.

---

## 4. ENTRY BURN — slowing down, and nudging the landing point

### The problem
Two goals at the same time:
1. **Slow down** from supersonic to ≈ 600 m/s before the air gets thick (heat, load).
2. **Fine‑tune** the predicted landing point, which is currently a few hundred metres off.

But the steering tools are poor: the thrust is fixed (full throttle), the RCS jets are weak, and at this altitude the air produces a **twisting torque on the booster far larger than the RCS can fight**.

### The insight (in two parts)

**Part A — "Make the RCS feel like it is in vacuum."**
Imagine a friend trying to rotate you slowly while you stand in a strong crosswind. He cannot, because the wind keeps shoving you. Now imagine you lean into the wind with exactly the opposite force: his light touch works again. That is what the **gimbal** does here. It continuously produces a torque opposite to the environment's torque, keeping the *net* environment torque at **≈ 0**. To the RCS, the vehicle now behaves as if there were no air, so even weak jets can control the attitude with fine precision. The gimbal is not steering at all; it is *cancelling a disturbance*.

**Part B — "To move the landing point, tilt the thrust."**
All engines push along the nose. If the nose is tilted a little away from the velocity, the push has a small sideways component, which slowly shifts the trajectory — and with it the landing point. The RCS provides that tilt. The only question is **when to start and stop rotating**, because the RCS can't hold an angle — it can only swing the nose one way, then the other.

### Build‑up

**Step 1 — the gimbal cancels the environment.** With the same geometry as in §2:

```
τ_target = − τ_env (predicted one tick ahead)         →      τ_gimbal + τ_env = 0
γ = asin( τ_target / R ) − φ
```

**Step 2 — the error to be corrected.** The impact point is computed as in §2, with one deliberate twist — a **bias** `b` is subtracted:

```
e = (φ_impact − φ_pad) · R_earth − b
```

The burn does not aim at the pad; it aims at a point shifted by `b` (tuned to −726.8 m in this mission). The reason: after the burn the vehicle still flies through air and uses its fins, which push the landing point; `b` pre‑compensates, so the booster arrives at the landing burn on the right path.

**Step 3 — time to go.** The burn ends when the speed reaches 600 m/s. From the measured deceleration (filtered, τ = 0.5 s):

```
T = ( v − 600 ) / ( − v̇ )
```

**Step 4 — what a small tilt does.** Thrust acceleration a_T (thrust ÷ mass). A tilt θ gives a sideways acceleration `a_T·θ`. One m/s of sideways velocity moves the impact point by `S` metres (found numerically by running the predictor twice, once with +1 m/s). So the error drifts at an extra rate

```
κ · θ         where  κ = a_T · S
```

**Step 5 — the prediction.** If I start rotating *now*, and the RCS needs time to stop the rotation again, what is the error at the moment the burn ends?

```
s = e  +  ė·T  +  κ · ∫₀ᵀ θ dt
```

The three terms: today's error, its drift if nothing changes, and the extra drift due to the tilt I will have.

How much tilt will I have? Currently the nose rotates at ω. The RCS can brake that rotation at deceleration `a_B`, so the rate falls linearly: `ω(t) = ω₀ − a_B·t`, and the angle `θ(t) = ω₀ t − a_B t²/2` until the rotation stops at `t_s = ω₀/a_B`. Integrating:

```
if T ≤ t_s :   ∫θ dt = ω₀·T²/2 − a_B·T³/6
if T > t_s :   ∫θ dt = ω₀³/(3·a_B²) + ( ω₀²/(2·a_B) )·( T − t_s )
```

(After the rotation stops, the final angle `ω₀²/(2a_B)` simply persists for the remaining time.)

**Step 6 — the decision.** Every tick:

```
s >  +100 m   → fire the RCS to rotate one way
s <  −100 m   → fire the other way
otherwise     → null the rotation (brake it if |ω| > 0.002 rad/s)
T < 0.5 s     → only null the rotation (too late to steer)
```

The decision is based on the *predicted* error, which includes the braking distance of the rotation. Therefore it can switch direction **early enough** that the nose stops where it should.

### What you see in the run
Cutoff at t = 430.0 s (v = 599.8 m/s, alt 45.3 km); the impact error is **45 m**. The jets changed direction 39 times in the burn. The bias was −726.8 m.

---

## 5. POST‑ENTRY STEER — steering with the wind itself

### The problem
Now the engines are off. The booster glides through the atmosphere from 44 km to 5 km. The landing point is still some tens or hundreds of metres from the pad (at the end of the phase: 162 m measured on the ground, −42 m predicted). With no thrust, only the air can move it.

### The insight
A glider steers by changing its angle to the wind: tilt the wings, and the air pushes it sideways. The booster, too, produces a sideways force from the air that depends on its **angle of attack** (the angle between its axis and the airflow). Change the angle by a few degrees and the sideways force changes. The grid fins let it *hold* a chosen angle despite the air's twisting torque.

So the chain of reasoning is:

```
want: landing‑point error to shrink  →  need a different sideways air force  →  need a different angle  →  fins hold it
```

### Build‑up

**Step 1 — how much does the landing point react to force?** Using the predictor of §2, shift the speed by +1 m/s in x and again in y:

```
Sx = ∂e/∂vx ,      Sy = ∂e/∂vy        (metres of landing‑point shift per m/s)
```

**Step 2 — how fast is the error changing right now?** From the aerodynamic acceleration `(ax, ay)` that the physics model gives:

```
ė_pred = Sx · ax + Sy · ay
```

**Step 3 — how fast do I *want* it to change?** I want an exponential approach, closing 63 % of the gap every 40 s:

```
ė_des = − e / τ_e,    τ_e = 40 s        →       e(t) = e₀ · exp(−t / 40)
```

(Slow and smooth, because the sideways air force is small.)

**Step 4 — what angle change gets me there?** Evaluate the aerodynamic model once at the current angle and once at θ + 1° → the sensitivity (Jacobian) `J = ∂ė/∂θ`. Then

```
Δθ = ( ė_des − ė_pred ) / J
```

**Step 5 — check that it is possible.** (i) A different angle changes the twisting torque of the air by `J_h` per degree; the fins plus 80 % of the RCS must be able to cancel it — that limits Δθ to an interval. (ii) |Δθ| ≤ 6° per step. (iii) |α| ≤ 12°. The result is the target angle `θ* = θ + Δθ`.

**Step 6 — hold that angle (spring + damper again).**

```
τ_cmd = I · ( − Kp·(θ − θ*) − Kd·ω ),         Kp = 0.05,  Kd = 0.6        (ωₙ = 0.22 rad/s, ζ = 1.34)
```

Very soft and over‑damped: the booster is slow to turn, and a fast loop would just saturate the fins.

**Step 7 — where does the torque come from?** The air already twists the booster by `H(θ)` (drag + gravity‑gradient). The fins must provide the remainder:

```
τ_fin = τ_cmd − H(θ) − d̂
```

`d̂` is a **disturbance observer**: a smoothed difference between the torque actually measured and the torque the model predicted (clipped to ±150 kN·m). It "learns" the model's mistakes while flying.

**Step 8 — from torque to fin angle.** The program has a table of fin torque for fin deflections from −30° to +30° in 5° steps. It searches the table from the neutral position outward (in the direction in which torque grows) and interpolates to the angle that gives `τ_fin`; the fin moves at no more than 40°/s. If the fins alone cannot reach the torque, lateral RCS jets (dead band 500 N·m) add the rest.

**Step 9 — start with a check.** For the first **6 seconds** the fins are held neutral, RCS off, and the program just *compares* the torque it measures with the torque the model predicts. It is a safety check that the model matches reality before any command depends on it.

### What you see in the run
Handoff at 5 km with a vacuum‑impact error of −0.042 km, angle of attack 6.1°, rotation rate 0.05°/s.

---

## 6. LANDING BURN ALIGN — a calm start

At 5 km the fins are ramped smoothly to zero (3°/s), the gimbal is commanded to centre, engines and RCS are off. The booster coasts to its natural aerodynamic balance (angle −0.17°, rate 0.6°/s at the start of the final burn). At 2.0 km the final burn begins; this is the only phase where *no* part of the mission may be rushed.

---

## 7. THE LANDING BURN — stopping exactly at the ground

*This is the heart of the mission. Everything before it exists to deliver the booster to this moment in the right place; everything after it is a few seconds of settling. It is described in far more detail than the other phases.*

### 7.1 Why this phase is special — three numbers

At the start of the burn (t = 520.6 s) the booster is **2.0 km above the ground, falling at 217 m/s** — about 780 km/h. It has to be at **almost zero speed, at the ground, over the pad, upright.** There are three facts about the booster that make this hard:

1. **Use one engine.** Landing uses only the centre engine. Its full thrust is about 845 kN (≈ 2.7 × the vehicle's landing weight of ~316 kN). Plenty for braking.
2. **It can't be throttled below ≈ 39 %.** The minimum thrust is about 330 kN — **more than the weight (316 kN)**. So even at the lowest setting the vehicle is pushed *upward* with 14 kN extra (= 0.43 m/s² of net upward acceleration at a mass of 32 t). It can brake, it can never hover. Using three engines would be hopeless: their minimum thrust would be about three times greater (≈ 1000 kN).
3. **Waiting is not free, rushing is not free.** If it brakes early, it wastes fuel and stops in mid‑air (and then must fall again). If it brakes late, it hits the ground at speed. The ideal is the **suicide burn** (the "hoverslam"): ignite as late as possible and brake as hard as needed so that the speed becomes zero exactly at the ground. It is like stopping a car at a wall by braking at the last moment with exactly the right force.

### 7.2 One landing, seen in numbers

This is the real log of the landing burn (before the final fine‑tuning), sampled every few seconds:

| Time (s) | Height h | Speed v (down) | What the controller wants (decel) | Engine throttle |
|---|---|---|---|---|
| 520.6 | 2000 m | 217 m/s | engine lights, spool‑up (≈ 2 s) | ramping |
| 522.6 | 1578 m | 195 m/s | 12.3 m/s² | 62 % |
| 525.6 | 1057 m | 154 m/s | 12.3 | 69 % |
| 528.6 | 652 m | 116 m/s | 11.9 | 74 % |
| 531.6 | 359 m | 80 m/s | 10.9 | 75 % |
| 534.1 | 191 m | 55 m/s | 9.0 (legs deployed at 200 m) | 70 % |
| 536.6 | 79 m | 33 m/s | 7.7 | 67 % |
| 538.6 | 28 m | 18.6 m/s | 6.3 | 62 % |
| 540.1 | 7.7 m | 9.4 m/s | 5.6 | 59 % |
| 541.1 | 1.2 m | 3.6 m/s | 5.4 | 58 % |
| ≈ 542 | 0 | ≈ 0.4–0.6 m/s | engine at minimum, then off | → 0 |

Notice what is happening: the booster brakes at roughly **10–12 m/s² (≈ 1.2 g of net braking)** at the beginning and **5–6 m/s²** at the end, and the time between 2 km and the ground is only **~21 s**. Every number in this table is produced by the equations that follow.

### 7.3 Vertical control — "how hard must I brake from here on?"

The throttle controls the **vertical** motion. The idea is so simple that a driver does it by instinct.

#### Step 1 — the braking distance formula, rearranged

A car moving at speed v that brakes with constant deceleration `a` stops in the distance

```
d = v² / (2a)
```

Turn this around: if the wall is at distance h, the constant deceleration needed is

```
a_need = v² / (2h)
```

We do not want to stop dead; we want to arrive with a small speed `V_TD` (the "touchdown speed"). Slight modification:

```
a_need = ( v² − V_TD² ) / ( 2h )
```

**A worked example from the log:** at t = 522.6 s, h = 1577.5 m and v = 195.15 m/s (V_TD was then 0.2 m/s):

```
a_need = (195.15² − 0.2²) / (2 × 1577.5) = 38083 / 3155 = 12.07 m/s²
```

The log reads `aNeed=12.07`. This is the whole idea: **if the booster brakes with exactly a_need from this moment on and keeps doing so, it will land with speed V_TD.**

#### Step 2 — why you cannot simply "brake at a_need and be done"

Two things go wrong:
* The engine has a lag, the air changes the deceleration, the mass keeps dropping: the real deceleration `a` is never exactly `a_need`.
* **Any error grows, and it grows faster the closer you are to the ground.** Let us see why. Over time, `v` decreases by `a·dt` and `h` decreases by `v·dt`. Differentiating `a_need` with respect to time:

```
d(a_need)/dt = (v/h) · ( a_need − a )
```

Read this equation slowly. If the actual braking `a` is *smaller* than what is needed, `a_need` grows; the factor **v/h** is the "urgency": at h = 1500 m and v = 195 m/s it is 0.13 per second, at h = 10 m and v = 9 m/s it is 0.9 per second — **seven times faster**. In the last metres, even a small shortfall becomes a big required deceleration within a fraction of a second. So the controller needs a law that makes the error shrink as the ground approaches.

#### Step 3 — the law

Let `a_ref` be a comfortable "reference" deceleration — the one the vehicle gets at its normal throttle (60 %). The controller commands

```
a_req = a_ref + K · ( a_need − a_ref ),      K = 2
```

(`a_ref = THR·F_max·cosθ/M − g + a_air`: the deceleration the engine at nominal throttle would produce, taking weight, tilt and the air's help into account.)

**What this does.** Let `δ = a_need − a_ref`. Substituting `a = a_req` into the previous equation gives `a_need − a = (1 − K)·δ`, and since `dh = −v·dt`:

```
dδ/dh = (K − 1) · δ / h        →        δ ∝ h^(K−1)
```

For **K = 2: δ ∝ h** — the mismatch shrinks *in proportion to the height*, reaching zero at the ground. With `K = 1` the mismatch would never grow *or* shrink (a mistake early would still be a mistake at the ground); with `K < 1` it would blow up. So **K = 2 is the smallest simple choice that actively removes the error as the booster gets lower.** It behaves like a pilot's "flare": gentle corrections early, firm precise ones near the ground.

**A worked example** (t = 536.1 s): h = 96.9 m, v = 37.0 m/s.

```
a_need = (37.0² − 0.2²)/(2·96.9) = 7.05       a_ref = 6.05
a_req  = 6.05 + 2·(7.05 − 6.05) = 8.05  m/s²
```

The vehicle is slightly "too high and too fast" for the reference, so it brakes a little harder than the reference — and the log shows `aReq=8.06` and the throttle at 68 %. *(In the real vehicle `a_ref` itself drifts as fuel burns and the air thins, so δ does not literally fall like h. What matters is that the controller always acts against the mismatch with gain 2 and never lets it grow.)*

#### Step 4 — from "deceleration" to "thrust"

Newton's law for the vertical direction: `M·a = F·cosθ − M·g + M·a_air`. Solve for the thrust:

```
F = M · ( a_req + g − a_air ) / cosθ
```

Example at t = 541.1 s: mass 32.3 t (from `gEff = F/M = 15.26`), `a_req = 5.43`, `g = 9.8`:

```
F ≈ 32 300 × (5.43 + 9.8) ≈ 492 kN  =  58 % of 845 kN
```

— the log shows exactly 58 % and `F = 492 398 N`. The thrust is clipped between the engine's minimum and maximum before it is sent as a mass‑flow command.

#### Step 5 — what happens in the last metre (the part that took the most work)

Everything above brakes the vehicle at ~5.5 m/s² down to the very last second. But the engine cannot throttle below 330 kN, and the vehicle weighs 316 kN. Here is what that causes, and how each problem was solved.

**Problem A — the hop.** At the moment the legs touch, the controller switches the engine off. The shutdown is not instant: the thrust falls **linearly over 2 s**, i.e. by Fmax/2 s ≈ **422 kN every second**. As long as the thrust is above the weight, the vehicle is *pushed upward*.

*An estimate.* If at contact the thrust is 450 kN: the excess over the weight is `E = 450 − 316 = 134 kN`. It takes `t₀ = 134 / 422 = 0.32 s` to fall to the weight. In this time the vehicle gains

```
Δv = ½ · E · t₀ / M = ½ · 134 000 · 0.32 / 32 200 ≈ 0.67 m/s      →   hop ≈ Δv²/(2g) ≈ 2.3 cm
```

A couple of centimetres: tiny in size, but visible — the vehicle lifts off its legs, lands again and in a real vehicle would put stress on the legs.

**Fix A — fade to the minimum thrust before the ground.** The "comfortable" reference throttle is not constant any more; in the last few metres it fades from 60 % toward the minimum (39 %):

```
THR(h) = f_min + ( THR − f_min ) · clamp( h / H_BLEND , 0 , 1 ),      H_BLEND ≈ 8 m
```

At contact the thrust is then already the minimum: `E = 330 − 316 = 14 kN`; `t₀ = 14/422 = 0.033 s`; `Δv = ½·14 000·0.033/32 200 ≈ 0.007 m/s`; hop ≈ **0.0000025 m = 2.5 µm.** The measured hop in the run was **0.0000 mm**. The formula agrees with the measurement.

**Problem B — the vehicle can stall above the ground.** At the minimum thrust the vehicle decelerates only at `a_min = (F_min − M·g)/M ≈ 0.43 m/s²`. The distance needed to stop from speed V at that deceleration is

```
d_stop = V² / (2·a_min)
```

| V (m/s) | 0.2 | 0.4 | 0.6 |
|---|---|---|---|
| stopping distance | 4.6 cm | 19 cm | 42 cm |

If the target touchdown speed is 0.2 m/s and the ground is only 10 cm further than expected, the vehicle comes to a halt **5 cm above the ground** and the engine, still pushing upward at minimum thrust, starts to lift it. That is exactly what was seen in an earlier run.

**Fix B — choose the touchdown speed from the mass.** Keep a margin of 0.2 m of stopping distance:

```
a_min = max( 0 , F_min/M − g )
V_TD  = clamp( √( 2 · a_min · 0.2 m ) , 0.3 m/s , 1.5 m/s )
```

| Landing mass | ≥ 34 t | 33 t | 32.2 t | 30 t | 28 t |
|---|---|---|---|---|---|
| V_TD | 0.30 m/s | 0.35 | 0.47 | 0.72 | 0.91 |

A lighter vehicle (less fuel) has more excess thrust at the minimum setting, so it needs a *higher* touchdown speed. This keeps the landing safe for any fuel load without manual tuning. Touchdown at 0.4–0.9 m/s is gentle compared with the 5 m/s the legs are rated for.

**Problem C — the controller believed the ground was 0.31 m lower than it really was.** The guidance and the physics computed the hanging length of the landing legs with different formulas (3.06 m vs 3.37 m). Because the vehicle was following the "braking curve" `v = √(V_TD² + 2·a·h)`, a ground that is 0.31 m too low is *very* expensive:

```
v at h = 0.31 m  ≈  √(2 · 6.2 · 0.31)  ≈  2 m/s
```

The booster touched down at 2 m/s instead of the planned 0.2 m/s. **Fix C:** the guidance now uses exactly the same leg formula as the physics (3.375 m); the log confirms it: `[LEG-SLAM-OK] … src=physicsMatch`.

#### Step 6 — contact

The guidance declares contact when the ground flag from the physics is set, or the height above the legs is ≤ 0, or the vehicle has stalled just above the ground. From that instant **all commands go to zero**: throttle, gimbal, fins, RCS. The engine spools down; the controller records the final state and measures the hop (peak height above the lowest point reached after contact).

### 7.4 Lateral control — sliding over the pad and arriving upright

At 2 km the booster is **not** exactly above the pad: the log shows `x = +16 m` and a sideways speed of `−5.5 m/s` (about 20 km/h) at the start of the burn. In 21 s it has to remove both, and arrive upright with a tilt below 12°. The lateral controller uses the *gimbal* (with some help from the fins). There are three loops, one inside the other. Let's build them from the inside out of the physical picture.

#### Step 1 — tilting turns thrust into sideways acceleration

If the engine pushes with a thrust acceleration `g_eff = F/M` (about 15 m/s² here) and the vehicle is tilted by θ, the horizontal part of the push is `g_eff · sin θ ≈ g_eff · θ`:

```
sideways acceleration = g_eff · θ
```

Tilt of 1° = 0.0175 rad → **0.26 m/s²**. Tilt of 5° → 1.3 m/s².

This gives a feeling for the problem: to remove 5.5 m/s of sideways speed with a tilt of 1° would take 21 s — the **entire burn**. So the booster has to tilt several degrees early (the log shows peaks of 7–9°), then straighten up before touching down. *Sideways speed is expensive.*

#### Step 2 — why the "obvious" control fails, and the trick

You steer by swivelling the engine. But a swivelled engine does two things at once:
1. It pushes the vehicle sideways (immediately).
2. It twists the vehicle (so that later it tilts).

If we try to control the position of the centre of mass, the first effect makes it move the **wrong way first**, then the right way — which makes feedback unstable. The trick is physical: there is a point on the body that does *not* move at the instant the force is applied: the **centre of percussion** — the "sweet spot" of a baseball bat: hit the ball with it and your hands feel nothing. It is located at a distance

```
ℓ = I / ( c · M )          (about 15 m in this vehicle; c = lever arm of the engine)
```

from the centre of mass. Define the controlled position

```
z = x − ℓ · θ
```

(x = sideways position of the centre of mass). A sideways force `F_g` from the gimbal changes `z̈` by `F_g/M − ℓ·(c·F_g/I) = 0`. So **the gimbal does not disturb z directly; only the tilt does** — and the system becomes clean:

```
z̈ = − g_net · ( θ − θ₀ )
```

(θ₀ = the angle at which the vehicle is not accelerating sideways.)

#### Step 3 — the "net" gain

`g_net` is the real effect of a degree of tilt, **after** the air has taken its share:

```
g_net = g_eff − k_q − S / (c·M)
```

* `g_eff` — what the thrust would do alone (15–24 m/s²).
* `k_q` — the air's sideways reaction to the tilt.
* `S/(c·M)` — the sideways effort the gimbal needs just to hold the tilt against the hull's weathervane torque.

In the log this quantity is `gRaw`: early in the burn it is only **0–8 m/s²** (the air eats most of the control), near the ground ≈ 15. When it falls below 12 % of `g_eff` the log marks the second `[NO‑AUTH]` — the controller knows it has no authority, so it does not push; it waits.

#### Step 4 — the outer loop: *what sliding speed do I want?*

Not "go to the pad as fast as possible". Three limits are combined, the smallest wins:

```
z_dot_ref = − sign(z) · min(  K_z · |z| ,   √( 2 · a_B · |z| ) ,   v_h  )
            K_z = 0.1 s⁻¹                   v_h = min( 2 m/s , 0.03·h + 0.1 )
```

1. **`K_z·|z|` — a gentle pull.** 10 m away → 1 m/s: "close the gap in 10 seconds". (Log: `z = 16.41` gave `zdRef = −1.64`: exactly 0.1 × 16.41.)
2. **`√(2·a_B·|z|)` — never go faster than you can stop.** It is the same braking‑distance formula, with `a_B = 0.3·g_net·θ_auth` (only 30 % of the available lateral acceleration is trusted, as a safety reserve).
3. **`v_h` — slow down near the ground.** 3.1 m/s at 100 m, 0.4 m/s at 10 m, 0.1 m/s at the ground. A sideways speed on touchdown would topple the vehicle.

Then the **acceleration wanted** is a simple proportional law (like a driver following a speed limit):

```
a_des = K_V · ( z_dot_ref − ż ),         K_V = 0.5 s⁻¹
```

(Log, first tick: `0.5 × (−1.64 + 5.518) = 1.939` — exactly the printed `aDes=1.939`.) The gain 0.5 per second means "close the speed gap in about 2 s".

#### Step 5 — from wanted acceleration to wanted tilt

Because `z̈ = −g_net·(θ − θ₀)`, the tilt needed is found by an **incremental inversion**:

```
θ_des = θ + ( z̈_measured − a_des ) / g_net
```

In words: "I'm accelerating at `z̈_measured`, I want `a_des`; the missing amount, divided by what a degree of tilt gives, is the extra tilt." Using the *measured* acceleration, not a model, makes it self‑correcting — a wrong wind, a misjudged mass, an aerodynamic surprise are all absorbed. Example: if I need 0.5 m/s² more and `g_net = 15`, I add 0.033 rad ≈ **1.9°** of tilt.

*Safeguards on the wanted tilt:*
* **Slew limit ≈ 4°/s.** In the first second of the run the formula asked for about −10°; the limit allowed about 1.8° in 0.5 s (log: `thDes` moved from −1.71° to −3.51°).
* **A cap that shrinks toward the ground:** `|θ_des| ≤ min(10°, 1.5° + 0.04°/m · h)` — 10° high up, **1.5° at the ground**. The reason: an upright landing is worth more than a perfect position.
* **A "can the gimbal hold it?" limit:** the tilt must be a tilt that the gimbal is able to maintain against the hull's torque (`lim=[…]` in the log).
* **No authority:** command the weathervane angle (where the hull torque is zero), don't fight.

#### Step 6 — the inner loop: *reach and hold that tilt*

A spring (pulls the angle to the wanted angle) and a damper (resists rotation):

```
θ̈_cmd = − K_θ · ( θ − θ_des ) − K_ω · ω,           K_θ = 1.0 s⁻²,  K_ω = 1.6 s⁻¹
```

* Natural frequency `ω_n = √K_θ = 1 rad/s` (a time scale of about 1 s), damping ratio `ζ = K_ω/(2√K_θ) = 0.8` — settles in ~3 s with a little overshoot.
* **Why three loops must be nested in time.** The inner loop (attitude) acts on a ~1 s scale; the outer loop (speed) acts at 0.5 s⁻¹ — about **3× slower**. If they ran at the same speed they would fight each other and oscillate; it is like steering a ship: the helmsman's correction must be much slower than the rudder's response. This ratio is also the reason why one must never raise `K_V` without raising the inner gains.

#### Step 7 — from "wanted angular acceleration" to the actual actuators

The moment that the actuators must deliver:

```
M_act = I · θ̈_cmd − τ_env + comX · F
```

(`τ_env`: torque from the air on the hull; `comX·F`: the torque of the thrust line if it is off‑centre.)

*Who delivers it?* The **gimbal** keeps 40 % of its range in reserve, and the **grid fins** take any moment that exceeds the rest (their torque is found by inverting the tabulated fin‑torque curve, as in §5). The gimbal part is a sideways force at the lever arm `c`:

```
F_x = ( M_act − τ_fin ) / c,          γ = asin( F_x / F )          (a side force F·sin γ )
```

In the log, `dlt` is the gimbal angle (typically between −3° and −0.5° in the middle of the burn) and `fin=a->b` the fin command (zero most of the time; up to −7° during the strongest corrections).

### 7.5 How to read the landing log (a flight recorder)

A typical line:

```
th=-3.456 w=-0.566 x=0.94 vx=-4.91 | z=1.86 zd=-4.756 z2=-0.2026 zdRef=-0.19 aDes=2.285 | thDes=-2.55 lim=[-10.0,10.0]
gRaw=-0.95 gEff=16.50 [NO-AUTH] | h=1057.26 vy=-154.27 vRef=-147.10 aNeed=11.26 aRef=10.23 aReq=12.28 F=586549 cmd=586855 thr=69%
dlt=-2.00 fin=0.0->0.0
```

| Field | Meaning |
|---|---|
| `th`, `w` | tilt (°) and rotation rate (°/s) |
| `x`, `vx` | position and sideways speed of the centre of mass relative to the pad |
| `z`, `zd`, `z2` | position, speed and acceleration of the *controlled point* (sweet spot) |
| `zdRef` | the sliding speed the outer loop wants |
| `aDes` | the sideways acceleration it asks for |
| `thDes`, `lim` | the tilt it asks for, and the allowed range |
| `gRaw`, `gEff` | the net effect of tilt (after the air) and the thrust acceleration |
| `[NO-AUTH]` | the air eats the control; the controller waits |
| `h`, `vy` | height above the leg tips, vertical speed |
| `vRef` | speed on the ideal curve at this height |
| `aNeed`, `aRef`, `aReq` | needed, reference and commanded deceleration |
| `F`, `cmd`, `thr` | actual thrust, commanded thrust, throttle in percent |
| `dlt`, `fin` | gimbal angle (°) and fin command |

### 7.6 The whole landing burn as one picture

```
  VERTICAL                                    LATERAL
  ────────                                    ───────
  h, v ──► a_need = (v²−V_TD²)/(2h)           pad error z ──► speed limits ──► wanted sliding speed
              │                                                                      │
              ▼                                                                      ▼
  a_req = a_ref + 2·(a_need − a_ref)           wanted sideways accel a_des = K_V·(speed error)
              │                                                                      │
              ▼                                                                      ▼
  thrust F = M·(a_req + g − a_air)/cosθ        wanted tilt θ_des = θ + (z̈_meas − a_des)/g_net
              │                                                                      │
              ▼                                                                      ▼
  throttle  (never below F_min,                spring‑damper → wanted torque → gimbal (+ fins)
   fades to F_min near the ground)
              │                                                                      │
              └───────────────────────────►  VEHICLE  ◄──────────────────────────┘
                                     (engine pushes up and sideways)
```

---

## 8. The result

| Quantity | Achieved | Spec limit |
|---|---|---|
| Position error at touchdown | ≈ 0.2 m | 42.5 m (pad radius) |
| Sideways speed | ≈ 0.26 m/s | 2.5 m/s |
| Tilt | ≈ 0.25° | 12° |
| Rotation rate | ≈ 0.54 °/s | 8.6 °/s |
| Vertical speed at impact | 0.4–0.6 m/s (= the planned V_TD) | 5 m/s |
| **Hop after touchdown** | **0.0000 mm** | – |

Before tuning the same landing gave `x = 4.99 m`, `vx = 0.73 m/s`, `θ = 1.68°`, and a visible hop.

## 9. Questions a reader is likely to ask

**Why not just hover and land gently?** The engine cannot throttle below the vehicle's weight; hovering is physically impossible.

**Why only one engine for the landing?** Because the minimum thrust must be as close to the weight as possible; one engine's minimum is 330 kN, three would be ≈ 1000 kN — about three times the weight.

**Why does the booster tilt so much early in the burn if it must land upright?** Because it arrives with ~6.7 m/s of sideways speed and every degree of tilt only gives 0.26 m/s² of sideways acceleration; it has to tilt early and straighten at the end.

**Why is the touchdown speed 0.4–0.6 m/s and not 0?** At the minimum thrust the vehicle brakes at only 0.43 m/s²; a lower speed would let it stall above the ground and climb.

**Why K = 2 and not a bigger number?** K = 2 is the smallest value that makes the error shrink toward the ground (`δ ∝ h`); larger values make the throttle more nervous and amplify the lag of the engine.

**Why is the outer lateral loop slower than the inner one?** Time‑scale separation: the outer loop's command must be held long enough for the inner loop to follow. About 3 : 1 is the safe ratio.

**What is the biggest remaining inefficiency?** The sideways speed (≈ 6.7 m/s) at the start of the burn. Steering that also removes this speed *before* the burn (during POST‑ENTRY) would reduce the tilt needed in the final 20 s.
