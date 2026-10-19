# Physics & Environment — Technical Documentation

A 2D, Falcon 9–inspired launch simulator. This document explains **what the
simulated world contains, which real-world effects are modelled, how they are
modelled, and how close the numbers are to reality**.

It is written so that a new reader can understand the physics layer without
opening the source. Guidance (the autopilot that flies the rocket) is a
separate topic and is documented in `LEOINSERTION-V3.md`.

**Purpose of the simulator.** Fly a rocket from the pad to orbit, release a
payload, and bring the booster back to land. The physics is detailed wherever
it decides the outcome of that mission (propulsion, mass change, aerodynamics,
attitude dynamics, landing) and deliberately simplified where it does not.
Section 13 lists each simplification together with the reason for it.

Source of truth, all read from the code:

- `config.js` — every physical and tunable constant
- `environment.js` — gravity, atmosphere, wind, Earth rotation
- `physics.js` — forces, torques, integrator, engines, slosh, aero, contact
- `massProps.js` — mass, centre of mass and moment of inertia from components
- `rcs.js` — reaction-control thruster allocation
- `componentLibrary.js` — engine, fuel, RCS and material definitions
- `fleet.js` — the actual vehicle records (booster, upper stage, fairing)
- `trajectoryMath.js` — predicted-path display (two-body, RK2)

`collision.js` only handles inter-stage overlap checks and is not covered.

---

## 0. In one minute

- The world is a **planar (2D) slice of a rotating, spherical Earth**. Gravity
  is a true inverse-square pull toward Earth's centre, not a constant 9.81.
- The launch pad **moves with the Earth**. The rocket starts with the
  ≈ 465 m/s eastward velocity of the surface, and the atmosphere co-rotates
  with it, so there is no fake headwind on the pad.
- Engines are modelled by **mass flow rate × exhaust velocity**, and exhaust
  velocity **changes with ambient pressure**. A sea-level Merlin and a vacuum
  Merlin behave differently, as they do in reality.
- Engines **spool** (3 s start-up, 2 s shutdown) and the gimbal is an
  **acceleration-limited actuator**, not an instant servo.
- Mass, centre of mass and moment of inertia are **rebuilt every tick** from
  physical components. They change as fuel burns, legs move and stages split.
- Aerodynamics produces **drag and an angle-of-attack torque** (weathercock
  effect) using Barrowman and Allen–Perkins methods. Grid fins have their own
  lattice model.
- **Fuel slosh** is a real damped oscillator whose frequency, damping and
  mass come from **Abramson / NASA SP-106** formulas and change with fill level.
- **Gravity-gradient torque** acts on the attitude continuously.
- Everything is integrated with **RK4 at 80 Hz**.

---

## 1. Fidelity at a glance

| Effect | Modelled? | How |
|---|---|---|
| Inverse-square gravity | Yes | `g = GM / r²`, vector toward Earth's centre |
| Earth rotation | Yes | Sidereal rate, surface velocity `ω × r`, co-rotating air |
| Standard atmosphere (US76) | Yes | Seven temperature layers to 86 km, tabulated density to 1000 km; temperature, pressure and density consistent |
| Transonic hull drag | Yes | `Cd(Mach)` with wave-drag rise and peak near Mach 1.1 |
| Orbital drag and decay | Yes | Emerges from drag at LEO density with a free-molecular `Cd` |
| Wind | Yes | Tangential/vertical vector, expressed in the inertial frame |
| Pressure-dependent thrust & Isp | Yes | `Ve = Ve_vac − k·P_ambient` |
| Engine spool-up / spool-down | Yes | Time-limited mass-flow slew |
| Throttle floor and slew rate | Yes | Per engine type |
| Gimbal limits (angle, rate, accel) | Yes | Accel-limited actuator |
| Rocket equation | Yes | Emerges from mass-flow integration (no shortcut) |
| Variable mass, CoM and inertia | Yes | Component model, recomputed per tick |
| Drag (altitude, area, attitude) | Yes | `½ρ·Cd·A·v²`, area depends on AoA |
| Aero torque / moving centre of pressure | Yes | Barrowman + Allen–Perkins blend |
| Grid-fin aerodynamics | Yes | Lattice model with Mach effects and lee shielding |
| Fuel slosh | Yes | Abramson first-mode, 2-way coupled to CoM and spin |
| Slosh baffles | Yes | Geometric damping from count and blockage |
| Gravity-gradient torque | Yes | Pitch-plane tidal torque |
| Stage separation pushers | Yes | Constant-acceleration pulse on discarded body |
| RCS | Yes | 4 pods, cold-gas, PWM balancing |
| Payload eject kick | Yes | Fixed Δv at release |
| Fairing recovery chute | Yes | Auto-deploy drag below 1500 m AGL |
| Rigid-body ground contact | Yes | Four-point silhouette check |
| Out-of-plane motion (yaw, roll, inclination) | No | The simulation is 2D |

---

## 2. Architecture

```
          config.js ──► constants, resolved vehicle hardware
              │
   environment.js ──► gravity · atmosphere · wind · Earth rotation
              │
     massProps.js ──► M, CoM, I from components (per tick)
              │
       physics.js ──► forces + torques ──► RK4 ──► contact ──► state
        ▲   ▲   ▲
        │   │   └── rcs.js (RCS forces)
        │   └────── componentLibrary.js / fleet.js (hardware data)
        └────────── guidance commands (throttle, gimbal accel, RCS)
```

Each physics tick (`DT = 1/80 s`), for **every body in the world** (active
stack, discarded booster, fairing halves, payload):

1. Update actuators (engine flow, gimbal).
2. Rebuild mass properties and slosh state.
3. Compute thrust, RCS, drag and aero torque.
4. Integrate with RK4 (gravity, gravity-gradient and aero are re-evaluated at
   every sub-stage).
5. Burn propellant, resolve ground contact, update telemetry.

Discarded stages obey **the same physics** as the active one. Nothing is
scripted.

---

## 3. The world: Earth, gravity, rotation

### 3.1 Constants (`config.js`)

| Quantity | Value | Real value |
|---|---|---|
| Earth radius | 6 371 000 m | 6 371 km (mean radius) |
| GM | 3.986004418 × 10¹⁴ m³/s² | exact standard value |
| Earth rotation rate | 7.2921159 × 10⁻⁵ rad/s | sidereal day, 86 164.09 s |
| Surface speed at the pad | ω·R ≈ 464.6 m/s | ≈ 465 m/s at the equator |

The sidereal rate is used rather than a 24-hour day, so the Earth turns
slightly faster than a naive model would.

### 3.2 Gravity

```
g⃗ = −(GM / r²) · r̂          (r from Earth's centre)
```

Gravity falls off with altitude and its direction rotates as the vehicle
travels around the planet. Because of this, **orbit emerges naturally**: no
orbit is scripted, a body with enough tangential speed simply keeps falling
around the Earth.

### 3.3 Earth rotation

A point fixed to the Earth's surface has inertial position and velocity

```
x(t) = R · sin(φ₀ + ωt),   y(t) = R · cos(φ₀ + ωt)
v⃗_surface = (ω·y, −ω·x)
```

At reset the rocket is given the angular rate `−ω` (it is attached to the
pad) and therefore **already carries the Earth's eastward velocity**. This is
the real "free" Δv a launch site gives, ≈ 465 m/s at the equator.

### 3.4 Inertial frame

All integration happens in the **inertial frame**. The rotating Earth is
handled by subtracting the surface velocity wherever air-relative quantities
are needed. This avoids fictitious-force bookkeeping and keeps the equations
exact.

---

## 4. Atmosphere and wind

### 4.1 Standard atmosphere (US Standard Atmosphere 1976)

The atmosphere follows the **U.S. Standard Atmosphere 1976**, in two parts.

**0 – 86 km: seven temperature layers.** Temperature is linear in
geopotential height within each layer. Pressure comes from the hydrostatic
equation and density from the ideal-gas law, so all three are consistent with
each other:

```
H     = r₀·h / (r₀ + h)                    r₀ = 6 356 766 m   (geopotential height)
T(H)  = Tb + Lb·(H − Hb)
P(H)  = Pb · (T/Tb)^(−g₀/(R·Lb))           if Lb ≠ 0
      = Pb · exp(−g₀·(H − Hb)/(R·Tb))      if Lb = 0
ρ     = P / (R·T)                          R = 287.053 J/(kg·K)
```

| Layer | Geopotential base | Gradient |
|---|---|---|
| Troposphere | 0 km | −6.5 K/km |
| Tropopause | 11 km | 0 |
| Stratosphere 1 | 20 km | +1.0 K/km |
| Stratosphere 2 | 32 km | +2.8 K/km |
| Stratopause | 47 km | 0 |
| Mesosphere 1 | 51 km | −2.8 K/km |
| Mesosphere 2 | 71 km | −2.0 K/km |

**86 – 1000 km.** Density and kinetic temperature come from the US76 table,
with log-linear interpolation of density (density falls close to
exponentially between rows). Above 1000 km the last table slope continues.

Pressure above 86 km is estimated as `ρ·R·T`. It is only approximate there
(the mean molecular weight changes) but is below 0.4 Pa, which changes engine
exhaust velocity by less than 0.01 m/s.

The same temperature profile gives the **speed of sound**
`a = √(1.4·R·T)`, so Mach number and atmosphere are always consistent. The
atmosphere toggle zeroes density and pressure together, so vacuum behaviour is
consistent: no drag, no aero torque, no nozzle back-pressure.

US76 describes moderate solar activity. Real density at orbital altitude
changes by roughly a factor of 10 over the solar cycle.

### 4.2 Co-rotating air

The air moves with the Earth. Relative velocity used by drag is

```
v_rel = v_body − (v_wind + ω × r)
```

Without the `ω × r` term a rocket on the pad would feel a phantom 465 m/s
headwind. This is handled explicitly.

### 4.3 Wind

Wind is a horizontal (locally tangential) vector with a speed and a
direction (0° = East, 90° = Up), converted into the inertial frame. It enters
the same `v_rel` expression as above, so it produces drag, angle of attack and
weathercock torque exactly like real wind does.

---

## 5. Propulsion

### 5.1 Thrust from mass flow

Thrust is **not** a fixed number. It is the product of two physical
quantities:

```
F = ṁ · Ve
```

The exhaust velocity depends on ambient pressure, because a nozzle's
performance changes with back-pressure:

```
Ve(P) = Ve_vac − k_atm · P_ambient          (clamped to ≥ 1 m/s)
```

`k_atm` is calibrated so that **sea-level Isp matches the real engine**.

### 5.2 Engines used (Falcon 9 Block 5 class)

| | Merlin 1D+ (booster) | Merlin Vacuum (upper stage) |
|---|---|---|
| Vacuum Isp | 311 s (`Ve` = 3 049.9 m/s) | 348 s (`Ve` = 3 412.7 m/s) |
| Sea-level Isp | 282 s | not meant to fire at sea level |
| Pressure coefficient | 0.002807 m²·s/kg | 0.0229 m²·s/kg |
| Mass flow in the fleet record | 306 kg/s | 288 kg/s |
| Resulting thrust | ≈ 846 kN sea level | ≈ 983 kN vacuum |
| Throttle floor | 39 % | 39 % |
| Gimbal | ±8°, 40 °/s, 200 °/s² | ±8°, 40 °/s, 200 °/s² |
| Start-up / shutdown | 3.0 s / 2.0 s | 3.0 s / 2.0 s |

Worked check, booster engine at sea level:

```
Ve = 3049.87 − 0.002807 · 101325 ≈ 2765 m/s
F  = 306 · 2765 ≈ 846 kN       (published sea-level thrust ≈ 845 kN)
```

Nine engines in the octaweb give ≈ 7.6 MN. A vacuum nozzle forced to fire at
sea level is heavily over-expanded in the model (`Ve` ≈ 1 092 m/s), which is
why it only makes sense at altitude, as in reality.

### 5.3 Spool transients

Crossing through zero thrust is a turbopump event, not an ordinary throttle
change, so it has its own timing:

```
start-up:   ṁ rises at  ṁ_max / 3.0 s
shutdown:   ṁ falls at  ṁ_max / 2.0 s
in-flight throttle moves:  rate fraction × ṁ_max per second
```

A command to stop does not stop the engine instantly. It keeps producing
thrust while it winds down. Guidance accounts for this by cutting off early
(see `LEOINSERTION-V3.md` §3.8).

### 5.4 Gimbal as a real actuator

Gimbal angle is not set directly. The **angular acceleration** is the control
input, and the state is integrated in two stages:

```
rate   ← clamp(rate + α·dt,  ±rate_max)
angle  ← clamp(angle + rate·dt, ±angle_max)
```

with `α` limited to ±200 °/s². Hitting the angle stop zeroes the rate in that
direction. A rate command is tracked through the same acceleration limit, so
"stop moving" brakes rather than freezes. Thrust is rotated by the gimbal
angle and its torque is taken about the **actual current centre of mass**:

```
τ = Σ [ (x_e − x_CoM)·F_y − (y_e − y_CoM)·F_x ]
```

Because the CoM can shift sideways when fuel sloshes, the gimbal genuinely
has to fight a moving pivot (§8.2).

### 5.5 Propellant consumption

```
fuel ← fuel − Σṁ · dt
```

The rocket equation is never evaluated as a formula. It **emerges** from
integrating thrust and mass loss together, so gravity loss, drag loss and
steering loss are all included automatically.

### 5.6 RCS

Four pods (top-left, top-right, bottom-left, bottom-right), each with a
vertical-up, vertical-down and one fixed lateral nozzle. Allocation rules
(from `rcs.js`):

- **Vertical translation:** all four pods fire together, torque cancels exactly.
- **Horizontal translation:** the only pods that can push in the wanted
  direction are on one side, at two different heights. The pod with the
  smaller moment arm fires continuously and the pod with the larger arm is
  **PWM-duty-cycled** so that `F_top · d_top = F_bottom · d_bottom`, giving
  zero net torque. The duty cycle uses a **delta-sigma modulator** that carries
  quantisation error into the next period, so the long-run average converges
  exactly.
- **Rotation:** two pods fire both nozzles, two fire vertical only. Net
  force cancels exactly with no PWM.
- The code detects at runtime whether the top or bottom arm is longer, so
  a high CoM (heavy upper stage, empty booster) is handled correctly.

RCS is a cold-gas system (exhaust velocity 700 m/s, ≈ 350 N per nozzle in
the default pod). It consumes propellant.

### 5.7 Separation and payload release

- **Stage separation:** real Falcon 9 uses pneumatic pushers in the
  interstage. The sim applies a constant acceleration (2.5 m/s²) to the
  discarded body along its own tail axis for 1.0 s, giving about 2.5 m/s of
  relative velocity. Pusher gas mass is ignored.
- **Payload release:** a fixed ejection kick of 3.0 m/s (normal) or 20–30 m/s
  (emergency eject). Guidance subtracts the same kick from its circularization
  target, so the physics and the guide agree.

---

## 6. Mass properties

Mass, centre of mass and moment of inertia are **not constants**. Each stack
member is split into components, each with its own mass, position and own
inertia:

| Component | Model |
|---|---|
| Body shell | Thin-wall cylinder: `I = ½·m·r² + (1/12)·m·h²` |
| Nose | Solid cone: `I = (3/20)·m·r² + (3/80)·m·h²` |
| Legs | Thin rods, positions move with deployment progress |
| Engines | Point masses at their mount positions |
| Payload space | Container + payload |
| Fuel | Column of height `h` at the tank base, centroid `h/2` |

Components are combined with the **parallel-axis theorem**, first within a
member and then across the whole stack. Symmetric parts (left/right legs, the
ring of engines) cancel in the CoM but still contribute their `x² + y²`
distance to the inertia.

Practical consequences, all visible in flight:

- The centre of mass **climbs** as the booster empties.
- The moment of inertia **drops** sharply through the burn, so the same gimbal
  angle produces a larger angular acceleration late in the burn.
- After separation, the upper stage and the discarded booster each get their
  own correct properties.

Fuel mass is distributed over members in proportion to their tank capacity.

---

## 7. Aerodynamics

### 7.1 Drag force

```
F_drag = ½ · ρ · Cd · A_eff · |v_rel|²        (opposes v_rel)
```

- `Cd` depends on **Mach number and altitude** (§7.1.1). The reference value
  `CONFIG.DRAG_CD` (0.6 for the Falcon 9 stack) is the hull Cd at Mach 2.
- `A_eff` is **attitude-dependent**. It blends from the circular end-on area
  `π(W/2)²` at zero angle of attack to the side silhouette `W × H` broadside.
  A rocket tumbling sideways therefore feels far more drag than a nose-on
  one, as it should.
- The engine bells hang below the hull and count as a virtual member, so
  they add real cross-flow area when the vehicle is broadside.

#### 7.1.1 Transonic and high-altitude hull drag

The hull drag coefficient is

```
Cd = Cd_ref · f(Mach)                                        (continuum flow)
Cd = (1 − w)·Cd_continuum + w·Cd_free-molecular               (altitude blend)
```

`f(Mach)` is the usual slender-body shape, normalised so `f(2.0) = 1`:

| Mach | 0 | 0.6 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 | 1.5 | 2 | 3 | 4 | 6 | ≥ 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `f` | 0.60 | 0.62 | 0.75 | 0.95 | 1.35 | **1.55** | 1.50 | 1.25 | 1.00 | 0.78 | 0.68 | 0.60 | 0.55 |
| `Cd` (ref 0.6) | 0.36 | 0.37 | 0.45 | 0.57 | 0.81 | **0.93** | 0.90 | 0.75 | 0.60 | 0.47 | 0.41 | 0.36 | 0.33 |

- Flat subsonic, a steep **wave-drag rise** through the transonic range, a
  peak near Mach 1.1, then a gradual fall through the supersonic range to a
  hypersonic plateau. This is the drag rise a real vehicle meets around max-Q.
- A smooth, monotone-preserving cubic (Fritsch–Carlson PCHIP) joins the table
  nodes, so drag has no kinks as Mach sweeps through the peak.
- **Free-molecular flow:** once the mean free path is comparable to the
  vehicle size, a body's drag coefficient rises to about 2.2 (the usual
  satellite value). The blend runs from 90 km to 160 km (smoothstep). It only
  matters for orbital decay, since the air is too thin at those altitudes to
  affect an ascent.
- The table is a generic slender-body shape scaled by `Cd_ref`; it is not
  fitted to Falcon 9 flight data.

Decay check: a 5 000 kg body with 10.75 m² cross-section in a circular 400 km
orbit loses about 3.3 m of semi-major axis per orbit (about 52 m per day) in
the simulator. The textbook formula `Δa = −2π·(Cd·A/m)·ρ·a²` gives 3.8 m, and
the 12 % difference is exactly the air-relative speed (the air co-rotates with
the Earth).

### 7.2 Aero torque and the moving centre of pressure

Drag alone cannot rotate a rocket. The rotation comes from the **normal force**
(perpendicular to the body axis), which acts at the centre of pressure, not at
the centre of mass. Two classical methods are blended:

```
Low angle of attack  (Barrowman, potential flow):
    F_lin   = −q · CNα · S_ref · sin α            CNα ≈ 2 for an ogive nose
Large angle of attack (Allen–Perkins, viscous cross-flow):
    F_cross = −q · Cd_c · A_planform · sin²α · sgn(α)      Cd_c = 1.2
```

The centre of pressure **moves with attitude**:

```
CP/height:   0.90 of nose member (low α)  →  0.50 of body (α → 90°)
blend weight: |sin α|
```

This reproduces weathercocking (stable when CP is behind CoM) and the
destabilising effect when the CP moves ahead of the CoM. This applies to every
body (booster, stage, fairing halves, payload), not only the active one.

Tumbling fairing halves also receive a mild angular-velocity damping term
(rate 0.8 s⁻¹) to represent energy loss through separated flow that a plain
rigid-body model would miss.

### 7.3 Grid fins

Each fin is a lattice panel with three directions: span, chord, thickness.
The flow is resolved into the fin's own axes, so stowed, deployed, slewing and
deflected poses all come from one model:

1. **Face through-flow.** The perforated face passes flow at low incidence and
   progressively blocks as the flow tilts, until it behaves like a solid
   plate (`Cd_face = 1.25`).
2. **Cell-wall cascade lift.** The lattice walls act as many short wings,
   giving a normal-force slope of 3.0 per radian that saturates at cell stall.
   This is the actual grid-fin control mechanism.
3. **Edge drag.** The solid frame seen edge-on (`Cd_edge = 1.15`).

Additional effects:

- **Mach dependence:** transonic drag rise from choked flow, Prandtl–Glauert
  growth of lift slope, and loss of lift once the lattice chokes.
- **Lee-side shielding:** left/right fins in the wake of the hull lose load
  (down to 12 % residual).
- **Rotation damping:** the local flow includes `ω × r`, so a spinning vehicle
  feels grid-fin pitch and yaw damping.
- Forces act at the panel centre, so the centre of pressure moves as the fin
  deploys.

---

## 8. Rotational dynamics

The angular equation of motion is

```
α = ( τ_thrust + τ_RCS + τ_aero + τ_gravity-gradient + τ_contact ) / I
```

### 8.1 Gravity-gradient torque

A long body in a non-uniform gravity field feels a differential pull between
its ends. In the pitch plane:

```
τ_gg = −(3/2) · (GM / r³) · I · sin(2β)
```

`β` is the angle between the body's long axis and the local vertical. The
torque is zero at 0°, 90°, 180°, peaks at 45°, and is **restoring** for a
slender body (the long axis prefers to point radially, the same mechanism that
tidally locks the Moon). It is evaluated fresh at every RK4 sub-stage because
it depends on attitude.

For a Falcon 9 stack in LEO (`I ≈ 2 × 10⁸ kg·m²`, `GM/r³ ≈ 1.3 × 10⁻⁶ s⁻²`)
the peak is about 390 N·m. That is small against RCS authority but it is the
dominant disturbance during long coasts, where nothing else damps attitude.

The axial inertia (about the long axis) is about 0.5 % of the transverse one
for a rocket and is neglected, which overstates the torque by that fraction.

### 8.2 Fuel slosh

Liquid in a partly filled tank does not move with the vehicle. Slosh is one
of the historically important failure modes of launch vehicles, so it is
modelled with the standard analytical tank-slosh theory (Abramson, NASA
SP-106) rather than a made-up spring.

**One lateral oscillator** is attached to the bottom tank:

```
ẍ = −ω²·x − 2ζω·ẋ − a_lateral
```

Its three parameters are not constants. They are recomputed every tick from the
tank radius `R`, the current fill height `h` and the tank's **proper
acceleration** `g_eff`.

**Frequency** (first antisymmetric mode):

```
ω_n = √( g_eff · λ₁ / R · tanh(λ₁·h / R) )          λ₁ = 1.841
```

`g_eff` is what an accelerometer on the tank would read. High thrust makes the
liquid effectively heavier and the slosh faster. In free fall `g_eff → 0` and
the liquid floats with no restoring force. Worked example (booster tank,
`R = 1.85 m`, full): about 0.50 Hz on the pad and about 0.86 Hz at 3 g.

**Damping** has two parts:

```
ζ_wall   = 0.83 / √Re ,   Re = ω_n·R² / ν           (viscous boundary layer)
ζ(h/R)   = ζ_wall · [ 1 + (2R/h) / sinh(2·λ₁·h/R) ]  (shallow-fill correction)
ζ_baffle = 0.125 · N_baffles · (1 − r_inner_fraction)
ζ_total  = ζ(h/R) + ζ_baffle          (capped at 0.5)
```

For the booster at liftoff the wall term is only about 2.5 × 10⁻⁴, while four
baffles at 0.8 inner-radius fraction give about 0.10. This matches the real
engineering reason baffles exist: wall damping alone is far too weak.
Shallow fill raises damping, which is directionally correct as a tank runs dry.

**Slosh mass** (the part of the liquid that actually participates):

```
m₁ / m_liquid = tanh(λ₁·h/R) / (λ₁·h/R)
```

About 3 % of the fuel in a full tall tank, rising to about 50 % at `h/R = 1`.
The sloshing mass sits at height

```
h₁/h = 1 − [cosh(λ₁h/R) − 1] / [λ₁(h/R) · sinh(λ₁h/R)]
```

near the free surface in a deep tank and near mid-height in a shallow one.

**Two-way coupling with the vehicle:**

1. **CoM shift.** The slosh offset moves the centre of mass sideways, and the
   engine torque is computed about that moved CoM, so the gimbal has to
   work against it.
2. **Angular momentum.** The moving mass carries `L = −m₁ · y_rel · ẋ` about
   the CoM, and the body's spin takes the opposite reaction. This produces the
   "whip-back" seen in real vehicles after a sharp manoeuvre.

**Numerical care:**

- Sub-stepped Euler (4 sub-steps per tick) for headroom at high `ω·dt`.
- The liquid cannot pass through the wall: the exposed offset is
  `R · tanh(x_raw / R)` and the velocity follows by the chain rule. This is
  smooth, equals the linear model for small motion, and never exceeds `R`.
- Degenerate cases (empty tank, `g_eff ≈ 0`) fall back to defined constants
  instead of feeding a zero frequency to the integrator.

---

## 9. Integration, contact and stability

### 9.1 Integrator

- **RK4** on position, velocity, attitude and spin, at `DT = 1/80 s`.
- Thrust, RCS and mass are fixed across the four sub-stages of a tick.
  Gravity, gravity-gradient and aerodynamics are re-evaluated at each
  sub-stage because they depend on the evolving state.
- Mass comes from the same mass-property snapshot the integrator uses, so the
  two can never disagree.

### 9.2 Ground contact

Four points of the **rotated** silhouette (base-left, base-right, base-centre,
nose tip) are tested against the surface after integration. The deepest one
defines the contact and the whole rigid body is pushed out along that point's
normal. This closes the earlier problem of a fast-tumbling nose "tunnelling"
through the ground between ticks.

### 9.3 Pad and rest behaviour

On the pad, the rocket rotates with the Earth, so its spin target is `−ω`.
Resting bodies get damping and then sleep, to prevent contact jitter. Landing
is only accepted inside a safety envelope (vertical speed ≤ 5 m/s, lateral
≤ 2.5 m/s, tilt ≤ 12°, spin ≤ 0.15 rad/s, legs ≥ 90 % deployed). Outside it,
the touchdown is a crash.

### 9.4 Recovery hardware

Fairing halves and emergency-ejected packages deploy a canopy automatically
below 1 500 m AGL; the canopy adds drag along the air-relative velocity.

---

## 10. Historical problems and how each one is addressed

| Problem in real launch history | Where it appears here |
|---|---|
| **Propellant slosh** destabilising a vehicle (a documented factor in early Falcon 1 flight trouble; the reason tank baffles exist) | Abramson slosh oscillator with fill-dependent frequency, baffle damping, CoM and angular-momentum coupling (§8.2) |
| **Engine does not stop instantly** (cutoff impulse affects final orbit) | Spool-down model; guidance cuts off early by the spool Δv (§5.3) |
| **Sea-level vs vacuum performance** | `Ve` falls with ambient pressure; vacuum nozzle is useless at sea level (§5.1) |
| **Weathercocking and max-Q loads** | Moving centre of pressure, normal force, wind-aware angle of attack (§7.2) |
| **Rocket gets a free speed boost from Earth's spin** | Initial velocity `ω × r`, co-rotating air (§3.3, §4.2) |
| **Gimbal cannot jump** | Accel/rate/angle-limited actuator (§5.4) |
| **Moving CoM and shrinking inertia as fuel burns** | Component mass model rebuilt every tick (§6) |
| **Stage separation recontact** | Pusher pulse and per-body physics, plus inter-stage collision checks |
| **Booster return control** | Grid-fin lattice model with Mach effects (§7.3) |
| **Long-coast attitude disturbance** | Gravity-gradient torque (§8.1) plus net-zero-force RCS in guidance |
| **Frame confusion between rotating Earth and inertial motion** | Inertial integration with explicit `ω × r` subtraction |

---

## 11. Sanity checks against real numbers

| Quantity | Simulator | Real / reference |
|---|---|---|
| Merlin 1D sea-level thrust | ≈ 846 kN | ≈ 845 kN |
| Merlin Vacuum thrust | ≈ 983 kN | ≈ 981 kN |
| Booster Isp (SL / vac) | 282 s / 311 s | 282 s / 311 s |
| Upper stage Isp (vac) | 348 s | 348 s |
| Throttle floor | 39 % | ≈ 39 % (Block 5 class) |
| Pad surface speed | 464.6 m/s | ≈ 465 m/s |
| Gravity-gradient peak, LEO | ≈ 390 N·m | order 10² N·m for this inertia |
| Booster slosh frequency (full) | ≈ 0.5 Hz | same order as large-tank slosh |
| Air density, 0 / 11 / 32 / 100 / 400 km | matches US76 to within 0.01 % | US76 table: 1.225 / 0.364 / 0.0132 / 5.6 × 10⁻⁷ / 2.8 × 10⁻¹² kg/m³ |
| Speed of sound at sea level | 340.29 m/s | 340.29 m/s |
| Transonic hull Cd peak | ≈ 1.55 × Cd at Mach 2, near Mach 1.1 | Same shape as slender launch vehicles |

---

## 12. Key constants

| Constant | Value | Meaning |
|---|---|---|
| `DT` | 1/80 s | Fixed physics step |
| `GM_EARTH` | 3.986004418 × 10¹⁴ | Gravitational parameter |
| `EARTH_OMEGA` | 7.2921159 × 10⁻⁵ rad/s | Sidereal rotation |
| `DRAG_CD_FREE_MOLECULAR` | 2.2 | Hull Cd in free-molecular flow |
| `DRAG_FM_ALT_START_M` / `DRAG_FM_ALT_FULL_M` | 90 km / 160 km | Altitude range of the Cd blend |
| `AERO_CNALPHA_NOSE` | 2.0 | Barrowman nose normal-force slope |
| `AERO_CD_CROSSFLOW` | 1.2 | Allen–Perkins cross-flow coefficient |
| `SLOSH_LAMBDA1` | 1.841 | First-mode eigenvalue |
| `SLOSH_KINEMATIC_VISCOSITY` | 10⁻⁶ m²/s | Averaged propellant viscosity |
| `SLOSH_ZETA_MAX` | 0.5 | Damping ceiling |
| `SLOSH_BAFFLE_DAMPING_COEF` | 0.125 | Baffle damping calibration |
| `SEPARATION_ACC_CONST` | 2.5 m/s² | Pusher acceleration |
| `PAYLOAD_EJECT_KICK_MPS` | 3.0 m/s | Normal payload release |
| `FAIRING_CHUTE_DEPLOY_ALT_AGL_M` | 1 500 m | Chute deployment |

---

## 13. Modelling choices and simplifications

The goal of this simulator is a complete mission: **launch, reach orbit,
release the payload, return and land the booster.** Every simplification below
was chosen on purpose to keep the work focused on that mission.

For each item, well-established engineering methods exist for the fuller
treatment. They were left out because they add model complexity and
development effort without changing the outcome of the mission the simulator
is built to fly. The "Why" column gives the reason for each.

### 13.1 Scope of the simulation

| Choice | What is used | Why |
|---|---|---|
| **2D (pitch-plane) world** | Motion in one plane, no yaw, roll or out-of-plane velocity | Ascent, insertion, boostback and landing are all flown in the launch plane, so the planar model captures the mission. Going to 3D also needs a full inertia tensor, 3-axis control and a rewritten guidance, which is a large step with no change to the core mechanics |
| **Spherical Earth, point-mass gravity** | `g = GM/r²`, Earth only | Oblateness (J₂) and third-body pulls change an orbit slowly, over days. Over an ascent and a short orbit their effect is negligible |
| **Rigid vehicle** | No body bending or structural modes | Flex modes matter when designing control-loop margins for a specific airframe. Here the aim is to show the flight mechanics, not airframe structural design |

### 13.2 Environment

| Choice | What is used | Why |
|---|---|---|
| **Mean-conditions atmosphere** | US76 (moderate solar activity), no weather or latitude variation | A standard reference atmosphere, accurate for ascent and landing loads. Orbital-altitude density changes with the solar cycle by about 10×, so decay rates are representative rather than predictive |
| **Uniform wind** | Constant speed and direction | Wind is an optional disturbance used to check that guidance is robust. A constant gust is enough for that test |

### 13.3 Aerodynamics

| Choice | What is used | Why |
|---|---|---|
| **Generic hull Cd curve** | Slender-body `Cd(Mach)` shape scaled by one reference value; free-molecular Cd above 90 km | Captures the transonic drag rise around max-Q without needing wind-tunnel data for one specific airframe |
| **Analytical aero methods** | Barrowman and Allen–Perkins | Standard preliminary-design methods with good accuracy for a slender body, and they give attitude-dependent torque without CFD data |

### 13.4 Propulsion and propellant

| Choice | What is used | Why |
|---|---|---|
| **Averaged propellant** | One RP-1/LOX liquid, density about 1 080 kg/m³, one viscosity | Gives the correct total propellant mass and tank volume, which is what sets Δv and slosh geometry. Separate tanks mainly refine centre-of-mass detail |
| **Slosh: first lateral mode, bottom tank** | Linear damped oscillator with soft wall limit | The first mode carries most of the sloshing mass and sets the dominant frequency, so it captures the effect that matters for control. Rotary slosh needs 3D anyway |
| **Separation pushers as a pulse** | 2.5 m/s² for 1.0 s on the discarded body | Produces the correct relative separation velocity without modelling gas dynamics or pusher mass |
| **Boosted RCS exhaust velocity** | 700 m/s | Gives the booster flip enough control authority; a design value chosen for the manoeuvre |
| **Idealised engines** | No tank pressurisation, boil-off, ullage settling, combustion instability or engine-to-engine variation | Repeatable engines make guidance tuning and test results reproducible |

### 13.5 Structure and mass

| Choice | What is used | Why |
|---|---|---|
| **Lumped shell-mass factor** | One factor, tuned so the derived dry mass matches the real vehicle | Flight depends on total mass, centre of mass and inertia, all of which match. Designing every tank wall, skirt and frame individually would not change the flight |
| **Axial inertia ignored** | About 0.5 % of transverse inertia | The effect on the result is below the accuracy of the other terms |

### 13.6 Contact

| Choice | What is used | Why |
|---|---|---|
| **Four-point ground contact** | Base corners, base centre and nose tip | Catches the case that matters (a tumbling nose or corner reaching the ground) at low cost |
| **Fixed landing envelope** | Limits for speed, tilt, spin and leg deployment | Landing is a pass/fail check on touchdown state; the limits are generous "do not break the hardware" values |

### 13.7 Extending the model

If a use case requires more detail, any of the items above can be added. The
atmosphere, drag coefficient and wind each live in a single place
(`environment.js`, `config.js`, `physics.js`), so replacing them is a local
change. They were not added because they would make
the model heavier without changing what the simulator is for.

---

## 14. Source map

| What | File |
|---|---|
| Gravity, atmosphere, wind, Earth-fixed helpers | `environment.js` |
| All constants and vehicle resolution | `config.js` |
| Engine/fuel/RCS/material definitions (Isp, flow, gimbal, spool) | `componentLibrary.js` |
| Vehicle records (tank sizes, baffles, mass flow, Cd) | `fleet.js` |
| Thrust, actuators, aero, grid fins, slosh, gravity gradient, RK4, contact, separation, release | `physics.js` |
| Mass / CoM / inertia, slosh mass fraction and centroid | `massProps.js` |
| 4-pod RCS allocation, PWM, delta-sigma | `rcs.js` |
| Predicted-path display | `trajectoryMath.js` |
