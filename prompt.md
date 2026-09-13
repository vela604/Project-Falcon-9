# ROCKET SIM — Complete Project Context + Step Plan

You are continuing work on an ongoing browser-based rocket flight simulator called "Rocket Sim" — inspired by SpaceX's Falcon 9. This document gives you every piece of context you need to understand the project deeply and execute any step correctly. Read it fully before touching code. Take your time — nothing here is filler.

**Important:** The user will tell you WHICH step to work on. You do ONLY that step, provide code + verify checklist, then STOP and wait for confirmation before moving to the next step. Never rush ahead.

---

## 1. THE VISION — What We're Building and Why

### The end goal
A browser-based simulator where the user can:
1. **Design rockets in a "technology bay"** — declare reusable hardware types (engine layouts, thruster performance specs, recovery mechanisms, RCS arrangements, fuels, metals, fairing shapes).
2. **Build a fleet of vehicles** — group records into "families", each family is a rocket program with exactly one booster + N stages + N payload spaces.
3. **Assemble a "stack"** — an ordered list of members (booster at bottom, then stages going up, payload space on top) that represents a physical rocket.
4. **Fly the stack in a simulator** — realistic physics: RK4 integration, Earth-centered frame, exponential atmosphere, thrust/RCS/legs, live COM/MOI, fuel burn.
5. **Manually separate stages mid-flight** — booster detaches and free-falls, upper stage continues, camera can follow either.
6. **Land the booster** — deploy legs, control descent, touch down softly (or crash).
7. **Deploy payload** — payload space (fairing) opens, payload is released.

### Design philosophy — the "why" behind every decision
The project is built on a **types-vs-values** separation:
- **Types** (in the Component Library) declare STRUCTURE. "This engine layout has 9 slots at these angles." "This recovery mechanism has 4 legs at these hinge points." Types never carry rocket-specific numbers.
- **Records** (in the Fleet) carry VALUES. "This booster's fuel tank is 45m tall, 3.9m wide." "Its engines run at 207 kg/s mass flow." Records reference types by id.
- **Derived quantities are NEVER stored.** Mass, COM, MOI, payload capacity, TWR — all computed live by functions when needed. This keeps records tiny and prevents drift.

This separation makes the simulator extensible: adding a new engine layout type doesn't require touching any record code. Adding a new role doesn't require rewriting the physics.

---

## 2. CORE CONCEPTS — The Mental Model

### Family
A **family** is a rocket program. It groups related records. Structure:
- **Exactly 1 booster** (mandatory, forms the bottom of any stack from this family)
- **N stages** (upper stages, can be stacked recursively)
- **N payload spaces** (fairing shapes, top of stack)
- **N noses** (reserved for future side-support-thrusters, currently mostly unused)

Records link to a family via their `familyId` field. The family object itself just holds `{ id, name, bottomId, locked }` — `bottomId` points at its booster record.

### Stack
A **stack** is an ordered list of member record ids (bottom → top). This is what the simulator actually flies:
- Stored in localStorage under `rocketSim.stacks.v1`
- Each stack has `{ id, name, members: [id1, id2, ...] }`
- Member roles must follow rules: bottom = booster, upper members = stage / payloadSpace / nose
- The currently active stack is chosen via `SELECTED_STACK_KEY` in localStorage
- If no stack is selected, the sim falls back to the legacy `falcon9-default` record

### Record (fleet entry)
Every fleet record is a self-contained description of ONE physical object (a booster, stage, nose, payload space, or legacy rocket). It has:
- Identity: `id`, `name`, `locked`, `familyId`
- Role: `stageRole` ∈ `{ rocket, booster, stage, nose, payloadSpace }`
- Universal geometry: `height`, `width`, `dragCd`
- Hardware references: `engineTypeId`, `recoveryTypeId`, `rcsTypeId`, `hasRecovery`
- Hardware VALUES: `engineThrusters` (thruster type + mass flow per gimbal group), `rcsThruster`
- Hardware geometry values: `params: { octaRadius, rcsTopY, rcsBottomY, rcsXOffset, rcsPwmPeriod, ... }`
- Visual: `bodyDesign: { mode, solidColor, dslText }`
- Role-specific fields (see Data Model section)

### Type (component library entry)
A **type** is a reusable declaration of hardware structure or performance. Examples:
- `engineLayout` — "octaweb-merlin9" declares 9 slots (1 center + 8 outer at 45° spacing)
- `thruster` — "merlin-1d-class" declares fixed Ve = 2900 m/s, efficiency = 0.9, TWR = 180, etc.
- `recoveryMechanism` — "legs-swingout-4" declares 4 legs, hinge geometry, structural volume formula
- `rcsArrangement` — "rcs-4pod-2nozzle" declares 4 pods at corners, 2 nozzles each
- `fuel` — "rp1-lox" declares propellant density = 1030 kg/m³
- `metal` — "al-li-alloy" declares density = 2700 kg/m³
- `payloadSpace` — "cap-standard" declares a nose cone shape with volume formulas

Types have:
- `category` — top-level discriminator (`engineLayout`, `thruster`, etc.)
- `kind` — sub-shape discriminator (`ringWithCenter`, `legsOnVehicle`, `cornerPods`, `chemical`, `noseCapShape`, ...)
- `displayName`, `description`
- `parameterSchema` — list of `{ key, label, unit, min, max, value? }` fields
- `frame` — geometry/formula data (functions like `hingeGeometry(H)`, `structuralVolume(H, W)`)
- `capabilities` — boolean flags describing behavior

**FIXED types** (thruster, rcsThruster, fuel, metal): every schema entry has a `.value` field. Fleet records cannot override these. They're real-world specs.

**NON-fixed types** (engineLayout, rcsArrangement, recoveryMechanism, payloadSpace): schema entries have no `.value`. Fleet records supply the values via their `params` bag or role-specific fields.

---

## 3. ARCHITECTURE RULES — Never Violate These

### Rule 1: No branching on `type.id`
You must NEVER write `if (type.id === 'octaweb-merlin9')` in any logic file. Instead, branch on:
- `type.category` — what kind of thing is this?
- `type.kind` — which structural sub-shape?
- `type.capabilities.*` — which behaviors does it declare?
- `type.frame.*` — check for the existence of structural data (e.g., `if (type.frame.hingeGeometry)`)
- `type.parameterSchema` — check which fields it declares

**Why:** Any type id can disappear or be added. Structural branching means adding a new "octaweb-merlin7" type needs ZERO changes to sim code.

**Example — correct:**
```js
const canDeploy = type.capabilities && type.capabilities.deploysOnVehicle;
if (canDeploy) { /* draw legs */ }
```
**Example — wrong:**
```js
if (type.id === 'legs-swingout-4') { /* draw legs */ }
```

### Rule 2: Types declare structure; records carry values
Never hardcode a numeric value in a type's parameterSchema. Instead, add it as a `key`, and let the fleet record supply the number via `params`.
- Exception: FIXED types (thruster / rcsThruster / fuel / metal) have real-world spec values. Those are `.value`.

### Rule 3: Live compute over stored values
Derived quantities (mass, COM, MOI, payload capacity, thrust) must be RECOMPUTED every time they're needed. Never store them on a record.
- `boosterDerivedMasses(rec)` — recompute
- `stageDerivedMasses(rec)` — recompute
- `stackCombinedAggregates(stk)` — recompute

**Why:** If a user edits a fuel tank height, all downstream quantities should update immediately with no cache invalidation.

### Rule 4: "Dummy value first" philosophy
When a real formula isn't ready, use a placeholder config constant, and build the pipeline around it. Examples:
- `SECOND_STAGE_TARGET_DELTA_V = 4500` (placeholder Δv budget for stage sizing)
- `MIN_TWR_FLOOR = 1.2` (placeholder minimum TWR for stage feasibility)
- `BODY_SHELL_FACTOR = 0.01` (placeholder shell thickness fraction)

When the real formula arrives, only the constant's value changes — no caller code changes.

### Rule 5: Formulas over if-branches
Model everything as parametric formulas. If you feel like writing `if (deploying) { ... } else if (stowed) { ... }`, ask: can I express this as a formula over inputs?
- **Legs' COM** during deployment: `midpoint of leg at current sweep angle` — computed live every tick. No state branches.
- **Payload space frustum height**: `(bulgeR - capR) / tan(frustumAngleDeg)` — formula.
- **Interstage height**: `max(bellHeight × 1.2, 0.06 × boosterHeight)` — formula.

### Rule 6: Recursive N-stage
Anything that applies to "a stage on a booster" applies recursively (stage on stage on booster). The stack is just an ordered list; validation walks it recursively.

### Rule 7: General formulas over hardcoded approximations
For COM/MOI, we currently assume everything sits on the centerline (x=0). But write formulas generally — use the parallel-axis theorem:
```
I_total = Σ( I_own_i + m_i × d_i² )
```
where `d_i` includes both x and y distance from the total COM. Don't write `I = m × H² / 12` rod approximations. Use the general form so we can relax the symmetry assumption later without a rewrite.

### Rule 8: One step at a time
Provide code for ONE step. Give a verify checklist. STOP. Wait for user confirmation. Do not preemptively implement the next step "since you're in there."

---

## 4. FILE-BY-FILE GUIDE

### HTML pages (4)
| File | Purpose |
|---|---|
| `index.html` | Home page. Shows the currently active stack's preview, specs, and links to other pages. |
| `rockets.html` | Fleet page. Lists families, records, and stacks. Has editors for records and stacks. |
| `components.html` | Technology Bay. Read-only view of all component library types, grouped by category. |
| `simulation.html` | Simulator. Canvas, toolbar, telemetry panel, control cluster, side panels. |

**Script load order (identical structure across pages):**
```html
<script src="js/componentLibrary.js"></script>
<script src="js/customDesign.js"></script>
<script src="js/fleet.js"></script>
<script src="js/config.js"></script>
<!-- page-specific scripts follow -->
```

Why this order matters:
- `componentLibrary.js` — defines `getComponentType()`, `getComponentsByCategory()`, and fixed-value maker functions
- `customDesign.js` — defines DSL parser (`parseAndValidateDesign`) and draw helpers
- `fleet.js` — defines `loadFleet()`, `loadFamilies()`, `loadStacks()`, and derived-mass helpers
- `config.js` — calls `fleet.js` functions at load time to build `CONFIG`, so `fleet.js` must be loaded first

### Styles (4)
`home.css`, `rockets.css`, `components.css`, `simulation.css` — each page has its own. Shared CSS variables (colors, fonts) are duplicated at `:root` in each.

### JS — Shared data layer
| File | Purpose |
|---|---|
| `js/componentLibrary.js` | Type registry + seed types + fixed-value maker helpers + `G0` constant + shared design constants (`BODY_SHELL_FACTOR`, `SECOND_STAGE_TARGET_DELTA_V`, `MIN_TWR_FLOOR`, `MAX_BULGE_DIAMETER_RATIO`) |
| `js/customDesign.js` | Body appearance DSL. `parseAndValidateDesign(jsonText)`, `drawCustomDesignOps(ctx, W, H, ops)`, `applyCylindricalOverlay(ctx, W)`, `validateCustomDesignOps(ops)` |
| `js/fleet.js` | Fleet + Family + Stack persistence. Derived-mass helpers: `boosterDerivedMasses`, `stageDerivedMasses`, `computeNoseDryMass`, `stackMemberOwnMass`, `validateStack`, `compatibleBoostersForStage`, `stackCombinedAggregates`, `engineThrusterGroups`, `getActiveStack`, `getActiveStackMembers` |
| `js/config.js` | Builds the `CONFIG` object the sim reads. Resolves active stack → aggregate masses → hardware types (engine layout / recovery / RCS). |

### JS — Page renderers
| File | Purpose |
|---|---|
| `js/home.js` | Home page. Populates vehicle card with active stack preview + specs. Starts mission clock. |
| `js/rockets.js` | Fleet page. Largest file (~2000 lines). Renders family/record/stack lists, editors, detail panels, role picker, add-member flows. Uses `previewVehicleFor(record)` to bundle opts for preview canvas. |
| `js/components.js` | Technology Bay. Renders all types grouped by category with schema tables. |

### JS — Simulator internals (`js/simJs/`)
| File | Purpose |
|---|---|
| `environment.js` | Gravity (Earth-centered inverse-square), exponential atmosphere, wind vector |
| `vehicle.js` | `ENGINES[]` array built from `CONFIG.ENGINE_LAYOUT.frame.slots`. Merge groups. Legacy COM/MOI helpers. |
| `massProps.js` | Component-based stack mass properties. `memberComponents(rec, fuelMass, legsProgress)`, `combineComponents(components)`, `stackMassProps(members, fuelMassTotal, legsProgress)` |
| `rcs.js` | 4-corner RCS pod fire logic. Delta-sigma PWM for top-pod duty cycle. `computeRCS(comH, dt)` returns `{ Fx, Fy, torque, mdot, firing, pod }` |
| `physics.js` | RK4 integration. `physicsStep(dt)` calls `applyActuatorRateLimits`, `computeMainThrust`, `computeRCS`, composes forces, integrates. Landing/crash detection at ground contact. `resetState()` initializes state. |
| `controls.js` | All input bindings. Throttle sliders, gimbal buttons, RCS direction buttons, legs deploy, wind panel, panel toggles, camera, fuel panel, quick throttle buttons. |
| `rocketArt.js` | `drawRocketArt(ctx, W, H, mpp, opts)` — role-aware single-member drawer. `renderVehiclePreview(canvas, vehicle)`, `renderStackPreview(canvas, memberIds, fleet)`, `buildStagePayload(rec)`, `drawPayloadSpaceShape(ctx, W, H, mpp, opts)` |
| `render.js` | Canvas scene. Sky gradient (altitude-based), grid, ground line, launch pad, ground steam, engine plume. `drawRocket()` calls `drawRocketArt` for each stack member. |
| `telemetry.js` | Dashboard readouts, figure panel (force vectors + fuel bar), basal view (engine ignition status), mini graphs. Glossary panel. |
| `main.js` | Bootstrap. Wires all bindings. Runs `requestAnimationFrame` fixed-timestep loop. `SIM_STACK_MEMBERS` cached here. |

---

## 5. DATA MODEL — Deep Dive

### 5.1 Fleet record shape

Every record lives in `localStorage['rocketSim.fleet.v1']` as an array. `migrateRocketRecord(r)` normalizes any record — old or new — to the canonical shape. It's called on every load; it's idempotent.

**Universal fields (all roles):**
```
id              — string, unique. Auto-generated by genId() for new records.
name            — string, 1-60 chars.
locked          — boolean. Only Falcon-9 default is locked (can't delete).
familyId        — string or null. Points at the family this record belongs to.
stageRole       — 'rocket' | 'booster' | 'stage' | 'nose' | 'payloadSpace'
height          — meters. Interpretation varies per role (see below).
width           — meters. Max diameter.
dragCd          — dimensionless. Orientation-independent Cd (Phase-1 simplification).
engineTypeId    — string. References an engineLayout type.
recoveryTypeId  — string. References a recoveryMechanism type.
rcsTypeId       — string. References an rcsArrangement type.
hasRecovery     — boolean. If false, recovery hardware is skipped.
engineThrusters — { [groupKey]: { thrusterTypeId, massFlowRate } }.
                  groupKey is 'gimbal' | 'fixed' (one per distinct gimbalCapable value in the layout's slots).
                  massFlowRate is the ONLY fleet-editable numeric per group.
rcsThruster     — { thrusterTypeId, massFlowRate }.
params          — { octaRadius, rcsTopY, rcsBottomY, rcsXOffset, rcsPwmPeriod, ... }
                  Values keyed by schema entries of the referenced types.
                  NO performance values here (engineFMax, engineVe, etc.) — those come from thrusters.
bodyDesign      — { mode: 'solid' | 'dsl', solidColor: '#rrggbb', dslText: '...' }
```

**Role-specific fields:**

**`rocket`** (legacy Falcon-9):
- `dryMass` (kg, manually entered)
- `fuelMassMax` (kg, manually entered)
- Has nose (drawn from `height`/`width` with curveness from `noseCurveness`)

**`booster`**:
- `fuel: { typeId, tankHeight, tankWidth }` — tank geometry
- `bodyMetalTypeId` — references a metal type
- `maxExtraWeightKg` — max mass that can be stacked on top
- No nose. Flat top with interstage.
- `dryMass` / `fuelMassMax` are DERIVED (not stored)

**`stage`**:
- `fuel: { typeId, tankHeight, tankWidth }`
- `bodyMetalTypeId`
- `maxExtraWeightKg`
- `height` = `fuel.tankHeight` (the tank only, payload space extends above)
- `dryMass` / `fuelMassMax` are DERIVED

**`nose`** (reserved for future side-thrusters):
- `bodyMetalTypeId`
- `noseCurveness` (0 = sharp cone, 1 = fully rounded)
- `dryMass` is DERIVED from cone volume

**`payloadSpace`** (fairing):
- `payloadSpaceTypeId` — references a payloadSpace type (noseCapShape or bulgedCapShape)
- `payloadSpaceMetalTypeId` — its OWN metal (can differ from the stack's body metal)
- `deploymentDirection` — provisional enum, currently 'clamshell' | 'hinge'
- `color` — '#rrggbb'
- `params: { capHeight, capWidth, bulgeWidth, frustumAngleDeg, curveRatio }`
  - `capHeight` — fairing height (from base to top)
  - `capWidth` — base diameter
  - `bulgeWidth` — max bulge diameter (bulged kind only)
  - `frustumAngleDeg` — angle of the widening frustum from horizontal (bulged only, default 45)
  - `curveRatio` — top-curve height / bulge radius (default 0.85)
- No engines, no fuel, no RCS, no legs.

### 5.2 Family shape

Stored in `localStorage['rocketSim.families.v1']`:
```
{ id, name, bottomId (booster or legacy-rocket record id), locked }
```

`getFamilyBottom(familyId)` resolves `bottomId` to a live record, or returns null if the record was deleted.

### 5.3 Stack shape

Stored in `localStorage['rocketSim.stacks.v1']`:
```
{ id, name, members: [recordId, ...], locked }
```

`getActiveStack()` resolves in order:
1. Selected stack by `SELECTED_STACK_KEY`, if it exists AND has at least one live member
2. Fallback: `falcon9-default` legacy record, wrapped as implicit single-member stack

### 5.4 Component Library types

Stored as a combination of SEED (defined in code, always fresh) and CUSTOM (in `localStorage['rocketSim.componentLibrary.v1']`).

Seed types currently include:
- **engineLayout**: `octaweb-merlin9` (9 engines), `single-nozzle-vac` (1 engine)
- **recoveryMechanism**: `legs-swingout-4` (4 legs), `catch-fitting-2pin` (no legs, future)
- **rcsArrangement**: `rcs-4pod-2nozzle` (4 corner pods)
- **thruster**: `merlin-1d-class` (fixed spec)
- **rcsThruster**: `cold-gas-small` (fixed spec)
- **fuel**: `rp1-lox` (density 1030 kg/m³)
- **metal**: `al-li-alloy` (density 2700 kg/m³)
- **payloadSpace**: `cap-standard` (noseCapShape), `cap-bulged` (bulgedCapShape)

Each type is created by a `buildXxx()` function. FIXED types use `makeThruster()`/`makeRcsThruster()`/`makeFuel()`/`makeMetal()` which call `withFixedValues()` to stamp the `.value` field onto each schema entry.

---

## 6. SIM INTERNALS — Deep Dive

### Coordinate system
- **Inertial frame**: Earth-centered. `rx` = horizontal distance from launch meridian, `ry` = distance from Earth's center.
- **Altitude** = `hypot(rx, ry) - EARTH_RADIUS`
- **Local vertical** = angle from `ry` axis to `(rx, ry)` position vector.
- **Attitude (`theta`)** is in the inertial frame. Screen tilt = `theta - localVerticalAngle`.
- **Rendering frame**: local flat tangent plane anchored at launch meridian. `x_local = rx`, `y_local = ry - EARTH_RADIUS`. Valid while `rx << EARTH_RADIUS`.

### Physics loop
`main.js` runs `requestAnimationFrame`. Each frame:
1. Accumulate `frameDt`
2. While accumulator ≥ `CONFIG.DT` (1/60s): `physicsStep(CONFIG.DT)`
3. `updateLegs(frameDt)`, `renderFrame()`, `drawFigurePanel()`, `drawBasalView()`, `drawGraphs()`, `updateTelemetry()`, `updateStatusBar()`, `updateFuelAvailability()`

`physicsStep(dt)` does:
1. `applyActuatorRateLimits(dt)` — throttle ramps toward target, gimbal slews toward target
2. Compute COM/MOI via `currentGeometry()` (which calls `stackMassProps`)
3. If fuel > 0: `computeMainThrust(comH)` + `computeRCS(comH, dt)`
4. Compose forces: Fx, Fy, torque, mdot
5. RK4 integration over state (rx, ry, vx, vy, theta, omega)
6. Fuel burn: `state.fuelMass -= mdot * dt` (clamped at 0)
7. Ground contact check: if altitude ≤ 0, evaluate landing/crash criteria

### State object
Currently single-body:
```js
state = {
  rx, ry, vx, vy,   // inertial position + velocity
  theta, omega,     // inertial attitude + angular velocity
  dryMass,          // from CONFIG.DRY_MASS (stack total)
  fuelMass,         // starts at CONFIG.FUEL_MASS_MAX * DEFAULT_FUEL_FRACTION
  crashed,          // boolean
  landed,           // boolean
  simTime,          // seconds elapsed
}
```

Plus `legs = { deployed, progress }` — legs are controlled separately (progress animates toward target).

### COM/MOI computation
`stackMassProps(members, fuelMassTotal, legsProgress)` in `massProps.js`:
- For each member: `memberComponents(rec, memberFuelMass, legsProgress)`
- Each member decomposes into components: body, engines, legs (4× individually tracked for live COM), payload space, fuel
- Each component carries `{ mass, comX, comY, iOwn }` in the member's LOCAL frame (base = 0, +Y = up)
- Members are stacked bottom→top, offsetting `comY` by cumulative height
- `combineComponents()` aggregates via parallel-axis theorem: `I_total = Σ(I_own + m × (dx² + dy²))`
- Returns `{ totalMass, dryMass, fuelMass, comX, comY, moi, stackHeight, components }`

### Engines
`ENGINES[]` (in `vehicle.js`) is built by `buildEngineLayout()` from `CONFIG.ENGINE_LAYOUT.frame.slots`. Each engine has:
- `id`, `angleDeg` (null for center), `x` (lateral offset), `isCenter`, `gimbal`, `Fmax`, `Fmin`, `Ve`, `throttle` (0..1), `gimbalDeg`, `currentF`.

Only bottom member's engines thrust. Upper members may have engines but they're not fired yet (Step H will add stage handoff).

### Controls
- Throttle: `setGroupThrottle(group, value)` sets `targetThrottle` on each engine in the group
- Gimbal: `setCenterGimbalTarget(deg)` sets `targetGimbalDeg` on all gimbal-capable engines
- RCS: `rcsCmd[key] = true/false` where key ∈ `{N, S, E, W, NE, NW, SE, SW, CW, ACW}`
- Legs: `legs.deployed = true/false`, `legs.progress` animates toward target at `CONFIG.LEG_DEPLOY_RATE`

### Rate limits
`applyActuatorRateLimits(dt)`:
- Throttle: max change = `CONFIG.ENGINE_THRUST_RATE` per second (fraction of Fmax)
- Gimbal: max change = `CONFIG.GIMBAL_RATE_DEG_S` per second

### RCS
4 pods at corners: TL, TR, BL, BR. Each pod has 3 nozzles: 1 lateral (fixed outward direction), 1 up, 1 down.
- **Pure vertical (N/S):** all 4 pods fire corresponding vertical nozzle. Torque-free.
- **Pure horizontal (E/W):** only pods with correct lateral direction fire. Bottom pod continuous, top pod PWM-cycled to cancel torque.
- **Diagonal:** combination of vertical + lateral groups.
- **Rotation (CW/ACW):** 2 pods fire both nozzles (diagonal), 2 pods fire vertical only. Torque-cancels analytically.

Delta-sigma PWM: carries forward duty-cycle error between periods so long-run average duty converges exactly.

---

## 7. RENDER SYSTEM — Deep Dive

### `drawRocketArt(ctx, W, H, mpp, opts)`
Draws ONE member. The canvas context is already translated to the member's base center, rotated to its orientation.

**opts include:**
```
stageRole              'rocket' | 'booster' | 'stage' | 'nose' | 'payloadSpace'
legsProgress           0..1
legsState              Optional object for tracking foot positions (live sim passes it)
firing                 { [podId]: boolean } for RCS gas puffs
pod                    { [podId]: {Fx, Fy} } for RCS gas puffs
rcsTopY, rcsBottomY    Base-anchored pod heights (meters)
rcsTopMargin, rcsBottomMargin  DEPRECATED — use rcsTopY/rcsBottomY
recoveryType           Resolved recoveryMechanism type object (or null)
rcsType                Resolved rcsArrangement type object (or null)
stageRole              Role
noseCurveness          0..1 (for nose and rocket)
bodyDesign             { mode, solidColor, dslText }
payloadSpaceColor      '#rrggbb' (stage payload colour)
stagePayload           Descriptor from buildStagePayload() (for stage role)
engineLayout           Resolved engineLayout type (for engine bell sizing)
engineThrusters        engineThrusters object from record (for mass flow)
params                 record.params (for octaRadius, etc.)
stageAboveBellHeight   Stage-above bell height (for interstage sizing)
```

**Drawing order (for a rocket/booster/stage):**
1. Back legs (if recovery deploys)
2. Body (cylinder / nose / interstage / payload space shape depending on role)
3. Checkerboard stripe + grid fins (rocket only)
4. Booster interstage (black cylinder at top) + grid fins
5. Stage payload space (fairing shape on top)
6. Front legs (if recovery deploys)
7. RCS pods + gas puffs

### Role-specific body drawing
- **`rocket`**: Cylinder body + smooth nose curve (curveness controls sharpness). Checkerboard + grid fins near top.
- **`booster`**: Flat-top rectangle + black interstage cylinder at top. Fins below interstage.
- **`stage`**: Tank rectangle + payload space shape on top (frustum + straight + ogive). No fins.
- **`nose`**: Early return — draws ONLY a cone shape (curveness-based).
- **`payloadSpace`**: Early return — draws ONLY the fairing shape via `drawPayloadSpaceShape()`.

### Cylindrical gradient
Applied over the body path:
```js
const g = ctx.createLinearGradient(-W/2, 0, W/2, 0);
g.addColorStop(0, 'rgba(0,0,0,0.14)');
g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
g.addColorStop(1, 'rgba(0,0,0,0.20)');
```
Applied on top of any solid fill or DSL design, giving a cylindrical 3D feel.

### Payload space shape
`drawPayloadSpaceShape()` (in `rocketArt.js`) draws only the fairing:
- **noseCapShape**: smooth ogive from base to rounded top
- **bulgedCapShape**: base → frustum (straight, angle = `frustumAngleDeg`) → straight cylinder (variable height) → smooth ogive → rounded top

Sections derived:
```
frustumH = (bulgeR - capR) / tan(frustumAngle)
curveH   = curveRatio × bulgeR
straightH = max(0, H - frustumH - curveH)
```
If `H < frustumH + curveH`, scale frustum and curve down proportionally.

### Engine bell + interstage
Engine bell (stage standalone): cone shape, sized from `massFlowRate`:
```
bellHeight = 0.007 × perEngineFlow   (m)
bellRadius = bellHeight / 2
```
Drawn at base of the stage body, wider at bottom (nozzle silhouette).

Interstage (booster top): black cylinder, diameter = booster width, height = `max(bellHeight × 1.20, 0.06 × boosterHeight)`.

### Stack preview
`renderStackPreview(canvas, memberIds, fleet)`:
- Looks up widest member → sets pixels-per-meter scale
- Sum of member heights → total visual height
- Iterates members bottom→top, translating canvas Y each step
- Calls `drawRocketArt` per member with appropriate opts (including `stageAboveBellHeight` for interstage sizing)

---

## 8. UI PATTERNS — Fleet Page Deep Dive

`rockets.js` is the largest file. Here are the patterns to understand:

### Family list
`renderFleetList()`:
- Groups all fleet records by `familyId`
- Renders each family as a header (`.family-header`) + indented member rows (`.family-member-indent .fleet-row`)
- Each row is clickable → `showVehicleDetail(id)`
- Header is clickable → `showFamilyDetail(fid)`

### Role picker
The `#rolePicker` overlay shows a set of role options. Called with an `allowedRoles` array:
- **New family** → only `['booster']` (mandatory first member)
- **Add member to existing family** → `['stage', 'nose', 'payloadSpace']` if booster exists, else `['booster']`

### Editor form
`#editorForm` has fieldsets, most with `data-roles` or handled by the `applyRoleVisibility(role)` matrix:
- `geometryFieldset` — height, width, dry mass, fuel mass
- `hardwareTypesFieldset` — engine/recovery/RCS type dropdowns + recovery checkbox
- `engineParamsFieldset` — engine geometry + per-group thruster selection
- `recoveryParamsFieldset` — leg deploy rate
- `rcsParamsFieldset` — RCS geometry + RCS-thruster selection
- `stageFuelFieldset` — fuel type, tank height, tank width
- `stageMetalFieldset` — body metal
- `stagePayloadFieldset` — DEPRECATED (moving to separate payloadSpace role)
- `noseShapeFieldset` — curveness slider
- `aeroFieldset` — drag Cd
- `extraWeightFieldset` — max extra weight (booster/stage only)
- `capsBox` — capabilities (rocket/booster)
- `stageCapsBox` — stage capacity (stage only)

The `applyRoleVisibility(role)` function is the single source of truth for which fieldsets show. Update it when adding a new role.

### Detail panel
`showVehicleDetail(id)` — read-only view of a record:
- Preview canvas
- Geometry & mass block
- Hardware sections (engine / recovery / RCS) — populated from type schemas
- Role-specific blocks (Capabilities for rocket/booster, Stage Capacity for stage)
- Compatible boosters list (stage only)

### Stack editor
`openStackEditor(id)` / `openStackEditorNew()`:
- Members chain (rendered bottom→top, visually top-first)
- Add member dropdown (filtered by role + already-in-stack)
- Reorder buttons (up/down)
- Remove buttons
- Live validation output
- Save/Cancel

### Common helper functions
- `escapeHtml(s)` — XSS-safe text
- `fmtMass(kg)` — '12.3 t' or '450 kg'
- `fmtForce(n)` — '600 kN'
- `fmtParamValue(p, v)` — formatted per schema unit
- `setVal(id, v)` — safe `.value` set
- `readVal(id)` — safe parseFloat

---

## 9. THE STEPS — What to Do (in order, one at a time)

### PS-A — Payload space render foundation
Add `drawPayloadSpaceShape(ctx, W, H, mpp, opts)` to `rocketArt.js`. Add early-return branch in `drawRocketArt` for `opts.stageRole === 'payloadSpace'`. Two shape kinds:
- `noseCapShape` — smooth ogive from base to rounded top
- `bulgedCapShape` — base → frustum (angle = `frustumAngleDeg`) → straight → ogive → rounded top

Reads `payloadKind`, `payloadCapWidth`, `payloadBulgeWidth`, `payloadFrustumAngleDeg`, `payloadCurveRatio`, `payloadColor` from opts. Standalone; not yet wired into records.

### PS-B — Payload space data model + migration
Add `'payloadSpace'` to `STAGE_ROLES`. Add `blankPayloadSpaceData()` factory. In `migrateRocketRecord()`:
- For existing stage records with nested `r.payloadSpace` — create a sibling record (fresh id), same familyId, insert into stacks immediately after the stage. Remove nested payloadSpace from stage.
- For new payloadSpace records — ensure all fields default.
- Stage `height` = `fuel.tankHeight` only.

Add helper `payloadSpaceDimensions(rec)` → `{ height, width }`.

Add stub branch to `stackMemberOwnMass()` for payloadSpace (returns 0 for now).

### PS-C — Payload space fleet UI
Role picker option. New fieldset with shape select, metal select, deployment select, color picker, params grid (capHeight, capWidth, bulgeWidth, frustumAngleDeg, curveRatio). Update `applyRoleVisibility()` matrix. Fill/read form. Detail panel. Preview canvas uses `drawRocketArt` with `stageRole: 'payloadSpace'`. Remove payload section from stage form.

### PS-D — Stack integration
Validation: payloadSpace must be top-most in any stack. Render stack preview + sim loop draw it. Pass fairing opts (`payloadCapWidth`, etc.) from member record.

### PS-E — Payload space derived mass
Add `computePayloadSpaceDryMass(rec)` → `structuralVolume(params) × metalDensity`. Update `stackMemberOwnMass()` and `stackCombinedAggregates()`.

### SEQ-1 — Stack sequence picker
New stack flow: prompt for name → preset sequence:
- "Booster + Stage + Payload" (`sequence: 'f9-standard'`)
- "Booster + Stage + Stage + Payload" (`sequence: 'f9-heavy'`)
- "Booster + Payload" (`sequence: 'sso'`)
- "Custom" (`sequence: 'custom'`)

Store on stack record. Non-custom presets scaffold slots during editing.

### SEQ-2 — Sequence validation
`validateStack()` enforces preset-specific role rules.

### H1 — Multi-body foundation
Refactor state from single-body to `bodies[]` array. Still ONE body (the stack). Pure refactor.
- `state.bodies = [{ id, recordId, rx, ry, vx, vy, theta, omega, dryMass, fuelMass, isActive, crashed, landed, isDiscarded }]`
- `state.activeBodyIndex`
- `physicsStep(dt)` loops bodies, integrates each independently (gravity + drag). Only active body applies thrust/RCS/legs.
- Render loops bodies.
- All controls act on active body.

Backward compat: `state.rx` → `state.bodies[state.activeBodyIndex].rx` (getter/setter or explicit refactor).

### H2 — Manual separation
Toolbar button `#btnSeparate`. On click:
- Bottom member of active stack detaches as a new discarded body (own mass/fuel snapshot, no thrust/RCS/legs control)
- Remaining members become new active stack body
- `SIM_STACK_MEMBERS` becomes per-body

Check: at least 2 members, active, not crashed.

### H3 — Camera toggle
Toolbar selector "Follow: [Active ▾]" listing active + discarded bodies. `camera.followBodyIndex`. Off-screen indicator arrow.

### H4 — Polish
Separation flash. Telemetry "Bodies: N (M active)". Discarded bodies hitting ground → crashed/landed state.

---

## 10. WORKING PROTOCOL

### Communication style
The user speaks Hinglish (Hindi + English mixed). Messages are short and direct. They're comfortable with technical English but prefer clear, non-verbose explanations.

### Per-step protocol
1. **Begin:** Say what you're doing ("Chalo PS-B — payload space data model").
2. **Provide:** Exact code blocks. Label each with file + location. Use comments explaining the "why" behind non-obvious lines.
3. **Verify checklist:** Console commands + UI actions. Give expected outputs.
4. **STOP:** Ask the user to verify. Do NOT proceed to next step.
5. **If user reports an error:**
   - Ask for the exact console error + line number
   - Ask them to run diagnostic console commands
   - Diagnose before fixing — never guess
   - Provide the minimal fix

### Code style expectations
- Vanilla JS only — no npm packages, no build tools, no frameworks
- ES6+ features fine (const/let, arrow functions, template literals, destructuring, spread)
- 2-space indentation
- Functions declared with `function name() { ... }` (hoisted)
- Comments explain "why" not "what"
- Match existing naming conventions (camelCase functions and vars, UPPER_SNAKE for constants)
- Reuse existing helpers — check for them first
- Every function that touches rendering or physics should be defensive: guard against `null` / `undefined` / `NaN` and log a warning rather than crash

### Common gotchas

**Load order:**
Any new JS file must be added to all 4 HTML pages in the right order. `componentLibrary.js` → `customDesign.js` → `fleet.js` → `config.js`.

**Function hoisting:**
Function declarations are hoisted. `const`/`let` are not. If `config.js` calls a function from `fleet.js` at load time, that function must be defined by then.

**Brace matching:**
A single missing `}` in a big file breaks ALL subsequent function definitions silently. The error surfaces as `typeof someFunction === 'undefined'` for the functions that come AFTER the missing brace. Diagnostic: run `someWorkingFunction.toString()` and check its length — if it's 5× normal, functions got nested inside it.

**Circular dependencies:**
`config.js` reads from `fleet.js` at load time. If `fleet.js` functions reference `CONFIG`, move those constants to `componentLibrary.js` top-level (already done for `BODY_SHELL_FACTOR`, `G0`, `SECOND_STAGE_TARGET_DELTA_V`, `MIN_TWR_FLOOR`, `MAX_BULGE_DIAMETER_RATIO`).

**localStorage stale data:**
After schema changes, old records migrate via `migrateRocketRecord()`. If migration has bugs, ask the user to selectively clear `rocketSim.*` keys (NOT the entire localStorage — the user has other data there).

**Cache:**
After editing JS, user should hard-reload (`Ctrl+Shift+R`). If behavior doesn't match the code, suspect cache first.

**Duplicate IDs:**
When editing HTML, check `document.querySelectorAll('#someId').length === 1` before assuming it's correct.

### Never do
- Don't add npm packages or build tools
- Don't refactor unrelated code "while you're in there"
- Don't invent APIs — check for existing helpers first (grep the codebase)
- Don't hardcode type ids in logic — branch on category/kind/capabilities/frame
- Don't write "TODO" and skip — either implement, or explicitly defer with a documented reason
- Don't cache derived values on records
- Don't break the types-vs-values separation

### Verify checklist format
Provide as:
1. **Console checks** — exact commands to paste, expected output
2. **UI checks** — exact actions, expected result
3. **Regression checks** — what should still work unchanged
4. **What to report back** — specific outputs the user should paste


## 11. RESPONSE STYLE — Critical for Keeping Costs Down

The user is on a metered AI service. Long responses burn their credit. Keep every response **SHORT and DENSE**.

### Target size per response
- **Total response: ≤ 250 lines of markdown** (including code blocks)
- **Code blocks: ≤ 100 lines total** per response
- **Prose: ≤ 10 short lines** of explanation, NOT paragraphs
- No recaps of what was discussed
- No "great job!" / "nice!" praise
- No repetition of code context ("as we discussed earlier...")
- No restating the problem in a big way
- No "here's what I'm doing" preamble beyond 1 line

### Response template (use this shape every time)
```
**Step PS-B1 — payloadSpace role + blank factory**

**File:** `fleet.js`

**Change 1:** STAGE_ROLES — add 'payloadSpace'.
```js

// paste-here code

**Change 2:** blankPayloadSpaceData() — add after blankNoseData().
```js
// paste-here code
```

**Verify:**
```js
typeof blankPayloadSpaceData          // 'function'
loadFleet()[0].stageRole              // unchanged
```

Bhejo result.


### Rules
- If you need to ask a clarifying question, ask ONE, briefly. Don't provide code in the same message.
- If user reports an error, ask for the exact console message + line. Diagnose with 2-3 console commands MAX. Then fix with the smallest possible patch.
- Never paste code that isn't changing. Only show diffs/inserts.
- Don't add "why this works" explanations unless the change is genuinely non-obvious.
- Skip emoji, decorative language, headers beyond bold labels.

---

## 12. QUICK REFERENCE

### localStorage keys
```
rocketSim.fleet.v1               — array of fleet records
rocketSim.selectedId.v1          — currently selected fleet record id
rocketSim.stacks.v1              — array of stacks
rocketSim.selectedStackId.v1     — currently active stack id
rocketSim.families.v1            — array of families
rocketSim.selectedFamilyId.v1    — currently viewed family id
rocketSim.componentLibrary.v1    — array of custom (user-added) component types
```

### Design constants (in `componentLibrary.js` top-level)
```
G0 = 9.80665                     — gravitational acceleration (m/s²)
BODY_SHELL_FACTOR = 0.01         — body shell fraction of tank volume
SECOND_STAGE_TARGET_DELTA_V = 4500  — placeholder Δv budget (m/s)
MIN_TWR_FLOOR = 1.2              — placeholder minimum TWR
MAX_BULGE_DIAMETER_RATIO = 1.4   — bulge width cap / tank width
```

### Config values (in `CONFIG` object)
```
ROCKET_NAME, ROCKET_HEIGHT, ROCKET_WIDTH, DRY_MASS, FUEL_MASS_MAX
DEFAULT_FUEL_FRACTION = 0.60
ENGINE_LAYOUT, RECOVERY_TYPE, RCS_TYPE — resolved type objects
OCTA_RADIUS, ENGINE_F_MAX, ENGINE_F_MIN_FRAC, ENGINE_VE, ENGINE_THRUST_RATE
GIMBAL_MAX_DEG, GIMBAL_RATE_DEG_S
RCS_THRUST, RCS_VE, RCS_X_OFFSET, RCS_TOP_Y, RCS_BOTTOM_Y, RCS_PWM_PERIOD
DRAG_CD, LEG_DEPLOY_RATE
LANDING_MIN_LEG_DEPLOY, LANDING_MAX_VSPEED, LANDING_MAX_HSPEED, LANDING_MAX_TILT_DEG, LANDING_MAX_OMEGA
LEG_DEPLOY_MAX_SPEED
DT = 1/60
```

### Body DSL ops (for `bodyDesign.dslText`)
```json
[
  {"op":"rect",   "x":-0.5,"y":0,   "w":1,  "h":0.3,  "fill":"#14161a"},
  {"op":"circle", "cx":0,  "cy":0.5, "r":0.15,        "fill":"#ffcc00"},
  {"op":"line",   "x1":-0.5,"y1":0.2,"x2":0.5,"y2":0.2,"stroke":"#ffffff","strokeWidth":0.01},
  {"op":"poly",   "points":[[-0.5,0],[0,0.5],[0.5,0]],"fill":"#222222"},
  {"op":"text",   "x":0,   "y":0.5, "text":"F9",      "size":0.1,"fill":"#ffffff"}
]
```
Normalized coordinates: X from -0.5 (left) to +0.5 (right), Y from 0 (base) to 1 (top).

---

Good luck. Take every step carefully. Verify often. Ask when uncertain.