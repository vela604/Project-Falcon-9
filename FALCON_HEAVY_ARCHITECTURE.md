# Falcon Heavy — architecture and implementation gates

**Status:** Phase 1A assembly-definition groundwork and a Phase 1B.1
geometry-only kernel are under development/review. Neither is connected to the
flight simulation; Falcon Heavy is **not yet flyable**. Do not interpret an
assembly record or passing geometry tests as runtime support.

## 1. Architectural boundary

The existing `rocketSim.stacks.v1` model remains an axial, bottom-to-top list
of fleet record IDs. It continues to represent the central vehicle's normal
longitudinal chain. A Falcon Heavy is not a longer axial stack: it is one
central axial stack plus two lateral side-core instances.

Multi-core definitions therefore live separately in
`rocketSim.assemblies.v1`, implemented by `js/vehicleAssemblies.js`. The new
model is additive and must not change, migrate, or reinterpret existing stack
records. In particular, `triple-core` is an assembly `type`, never a new
`stack.sequence` value.

## 2. Version-1 assembly record

```js
{
  id: "asm_<base36><random>",
  schemaVersion: 1,
  type: "triple-core",
  name: "Falcon Heavy",
  centralStackId: "<existing axial stack id>",
  sideCores: [
    { slotId: "left",  recordId: "<rocket fleet record id>" },
    { slotId: "right", recordId: "<rocket fleet record id>" }
  ],
  locked: false
}
```

- `centralStackId` references an existing axial stack. That stack must resolve
  and begin with a real `stageRole: "booster"` record.
- The side slots must be exactly `left` and `right`. Each `recordId` references
  an existing fleet record with `stageRole: "rocket"` (not `"booster"`). The
  rocket record includes an integrated nose: it must have a finite positive
  `noseHeightM`. No new side-booster role exists, and the rocket is not
  converted into a booster/interstage chain.
- Each side rocket's `familyId` must be a non-empty string equal to the
  `familyId` of the central stack's bottom booster. Missing, invalid, or
  mismatched family references are rejected. Each side rocket is also
  validated as a single-member legacy stack:
  `validateStack([record.id], fleet, { sequence: "legacy", payloadId: null })`.
  No separate persisted legacy stack record is needed; the fleet record is the
  design source.
- The same rocket design record may be referenced by both side slots. A fleet
  record is a reusable design definition, not a physical flight instance. The
  runtime must create separate body, engine, propellant, actuator, guidance,
  and recovery state for the left and right instances.
- Side cores are not inserted into `centralStack.members`; they remain
  lateral assembly members, not axial stages.
- The future Heavy assembly creation UI must offer family-scoped `rocket`
  candidates (same family as the central stack's bottom booster) in the
  left/right side-core selectors. The ordinary axial Stack editor is not
  changed for this; a separate Heavy assembly interface selects side cores.
- References are never silently pruned. A missing or incompatible reference
  makes validation fail and must be visible to the user.

`js/vehicleAssemblies.js` exposes storage CRUD and
`validateVehicleAssembly()`. Validation delegates axial stack checks to the
existing `validateStack()` function and additionally checks the central booster
base, side-core role/nose/family rules and derived positive finite **axial**
height/mass. It does not yet derive lateral
assembly offsets, validate engine/actuator compatibility, or calculate combined
aerodynamics. The validator is non-mutating; a valid result means the stored
definition and its referenced axial records pass these preliminary checks, not
that the vehicle is ready to fly.

## 3. Runtime safety boundary

The current simulation boot captures `SIM_STACK_MEMBERS` from
`getActiveStackMembers()`. The physics worker and its engine construction,
mass-properties, aerodynamics, and renderer paths are built around one axial
member list per body. The new store is therefore deliberately not wired into
flight selection, `resetState()`, or worker initialization in Phase 1A.

Until the runtime capability gate and all required multi-core systems exist:

- a stored assembly must not be treated as launch-ready;
- selecting an unresolved assembly must never fall back to its central stack;
- the existing Falcon 9 stack path must remain unchanged;
- no code may add arbitrary lateral offsets, thrust multipliers, or visual-only
  side boosters to make a flight appear to work.

## 4. Required physical implementation order

1. **Geometry source of truth:** derive core centre-lines and contact/attachment
   geometry from actual component dimensions and explicit physical attachment
   definitions. Do not invent a fixed lateral offset.
2. **Mass and propulsion:** instantiate three independent core systems; resolve
   engine force application points in one assembly frame; compute total mass,
   centre of mass, and moment of inertia including parallel-axis terms; burn
   each core's own propellant only.
3. **Aerodynamics:** derive the assembly's exposed external profile without
   triple-counting overlapping surfaces. Document the limitations of the
   planar model and any empirical coefficients.
4. **Pad and ground contact:** use the real assembly footprint and support
   points; do not treat the central core as the only ground contact.
5. **Side-core separation:** model the real event sequence and force/impulse
   application. Preserve linear and angular momentum subject to modeled
   external forces and exhaust. Do not use an arbitrary separation velocity.
6. **Independent post-separation flight:** each booster must retain its own
   mass, fuel, engines, aero, actuators, and recovery state. Reuse existing
   recovery guidance where its assumptions remain valid.
7. **Guidance:** only after physical behaviour is validated, add a Heavy ascent
   coordinator for the three-core ascent. Keep independent post-separation
   recovery guidance separate.

## 5. Phase 1A completion criteria

- New storage is isolated from all existing fleet/family/stack keys.
- Old stack records and `main` behaviour are untouched.
- The definition validator rejects missing central stacks, missing side
  rockets, non-rocket side records, invalid nose heights, missing or mismatched
  families, duplicate/missing slot identities, and invalid/non-finite derived
  geometry or mass.
- Reuse of one rocket design record in both side slots is permitted.
- Unit tests run with Node's built-in modules; no third-party dependency is
  introduced.

A passing Phase 1A test suite validates only the definition layer. It does not
validate physical flight support or make Falcon Heavy launchable.

## 6. Phase 1B.1 geometry kernel (geometry only)

`js/vehicleAssemblyGeometry.js` (`globalThis.VehicleAssemblyGeometry`) is a pure,
isolated module; it is **geometry-only and not flight-ready** and is not loaded
by any HTML page or connected to the physics worker, renderer, or aero.

- Stack validation is delegated to an **injected** `stackValidator(members,
  fleet, stack)`; the module never reads a global `validateStack` and fails
  closed if the validator is missing, throws, or returns a malformed result.
  A result is accepted only if it matches the `validateStack()` contract
  `{ valid, errors, stackTotalHeight, stackTotalMass, memberInfo }` for a valid
  stack: `valid === true`, `errors` an empty array, and `stackTotalHeight` and
  `stackTotalMass` finite and greater than zero (the same derived-property rule
  `vehicleAssemblies.js` applies). A bare `{ valid: true }` is rejected.
  `memberInfo` is not inspected.
- Central member bounds use raw member hull `height` bottom-to-top with the
  `stageOverlapM` payload-space overlap (the `stackMassProps()` rule).
  `stack.derived.interstage` is the frozen virtual interstage, internal to the
  booster; it is never added as an external height segment.
- A side-core bound is `record.height + record.noseHeightM` tall (hull plus
  integral nose) and `record.width` wide.
- Bounds are conservative rectangles. Engine-bell hang, grid fins, landing
  legs, attachment struts and other appendages are **excluded**.
- The side-core centreline offset `d` is supplied explicitly by the caller and
  is never inferred.
