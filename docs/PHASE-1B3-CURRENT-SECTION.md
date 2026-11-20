
## Phase 1B.3 — Composite mass-properties adapter

`js/simJs/core/vehicleAssemblyMassProps.js` (`globalThis.VehicleAssemblyMassProps`,
frozen API `resolveVehicleAssemblyMassProps({ geometry, cores })`) is a pure,
deterministic calculation module. It is **not connected to the flight worker,
physics, renderer, aero, storage or any script-load list, and it does not make
Falcon Heavy flight-ready.** Results carry `geometryOnly: true` and
`flightReady: false`.

- **Inputs.** `geometry` is the result of `resolveVehicleAssemblyGeometry()`;
  `cores` is `[{ instanceId, components }]` for exactly `center`, `side-left` and
  `side-right`, matched by `instanceId` (never array order). Each `components`
  array uses the upstream component schema `{ label, mass, comX, comY, iOwn }`
  (plus optional metadata) and must be local to **that core's complete
  base-centre origin**. The module does not call `stackMassProps()` or
  `combineComponents()` and reads no DOM, storage, worker state or `CONFIG`.
  The adapter is stricter than upstream `combineComponents()`, which treats a
  missing `mass`/`comX`/`comY`/`iOwn` as 0: here each must be a finite number
  (`mass` and `iOwn` >= 0), otherwise the call fails closed.
- **Required upstream producers (source contract).** Derived from the supplied
  `massProps.js` excerpt (not the complete file; private helpers such as
  `_memberComponentsFull()` were not inspected and no upstream code was
  executed):
  - `memberComponents()` returns components in a single member's *own*
    base-centre frame; every axial member restarts at `comY = 0`. Raw outputs of
    different central members must **not** be concatenated.
  - **Central core:** use the complete central axial stack's
    `stackMassProps(centralMembers, ...).components`. It applies each member's
    cumulative `baseOffset` (including the payload-space `stageOverlapM`
    adjustment) to `comY` and already contains the `payloadCargo` component when
    `payloadMass > 0`. Do not add cargo again.
  - **Each side core:** use that rocket's own single-member
    `stackMassProps([rocketRecord], ...).components` (`stageRole: 'rocket'`,
    integrated nose already above the hull in the member-local frame). Pass
    `payloadMass = 0` unless a real side-core payload exists.
  - `fuelMassTotal` must equal the sum of the supplied per-member fuel values,
    and legs, slosh offset and grid-fin state must be the corresponding core's
    live state.
  - **Upstream dependency:** `stackMassProps()` internally calls
    `getActiveStack()` to read frozen interstage data
    (`derived.interstage`). Correct active-stack context is therefore an
    integration prerequisite. Phase 1B.3 neither hides nor mutates it, and
    `massProps.js` is not refactored here.
- **Assembly-frame translation.** Core origins come only from the geometry
  result and are added **exactly once** per component:
  `assemblyComX = origin.x + comX`, `assemblyComY = origin.y + comY`. Axial
  member offsets of the central stack must already be applied upstream; the
  adapter adds only the three core origins. No
  lateral offset is derived, guessed or hardcoded. Output components are new
  objects (mass, `iOwn`, labels and metadata preserved) stamped with
  `coreInstanceId`; inputs are never mutated.
- **Composite properties.** `M = Σ mᵢ`; `x_c = Σ mᵢxᵢ / M`; `y_c = Σ mᵢyᵢ / M`;
  `I_c = Σ [ iOwnᵢ + mᵢ((xᵢ − x_c)² + (yᵢ − y_c)²) ]` (parallel-axis theorem about
  the composite COM; `iOwn` is the component's own transverse/pitch-plane
  inertia). Asymmetric propellant loading acts only through the supplied
  components; COM X is never forced to zero.
- **Independent core identities.** The same rocket design may fill both side
  slots; its left and right components are translated independently and keep
  distinct `coreInstanceId` values. `coreMasses` preserves each core's identity
  and summed mass.
- **Fail closed.** Invalid or non-geometry-only/flight-ready geometry, missing,
  duplicate or unexpected cores, non-finite origins, empty/missing component
  lists, malformed components (negative/non-finite `mass` or `iOwn`, non-finite
  `comX`/`comY`), a core with non-positive total mass, or a non-finite aggregate
  all return `valid: false` with errors naming the core and component index.
  Zero-mass components are accepted.
- **Current exclusions.** Inter-core struts, attachment hardware and separation
  hardware are **not** included: their physical specifications are not yet
  established, so no mass or inertia is invented for them. All three cores must be
  supplied with one consistent local-origin convention (base-centre of the core);
  the adapter composes but cannot verify this upstream convention.
- **Geometry assumptions not verified.** The origins come from the Phase 1B.1
  kernel (centre `(0,0)`, sides `(-d,0)`/`(+d,0)` with `d` supplied by the
  caller; all three bases at `y = 0`). These are geometry-kernel conventions,
  **not** verified against real Falcon Heavy lateral spacing, vertical
  attachment alignment or structure. The adapter's output is a calculation
  result only and must not be read as physically verified or flight-ready.
