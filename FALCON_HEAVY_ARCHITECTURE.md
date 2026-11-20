# Falcon Heavy — architecture and implementation gates

**Status:** Phase 1A groundwork only. The assembly-definition store and its
validator are being introduced; Falcon Heavy is **not yet flyable** in the
simulation. Do not interpret an assembly record as runtime support.

## 1. Architectural boundary

The existing `rocketSim.stacks.v1` model remains an axial, bottom-to-top list
of fleet record IDs. It continues to represent the central vehicle's normal
longitudinal chain. A Falcon Heavy is not a longer axial stack: it is one
central axial stack plus two lateral booster instances.

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
    { slotId: "left",  recordId: "<booster fleet record id>" },
    { slotId: "right", recordId: "<booster fleet record id>" }
  ],
  locked: false
}
```

- `centralStackId` references an existing axial stack. That stack must resolve
  and begin with a real `stageRole: "booster"` record.
- The side slots must be exactly `left` and `right`, each referencing an
  existing fleet record whose role is `booster`.
- The same booster design record may be referenced by both side slots. A fleet
  record is a reusable design definition, not a physical flight instance. The
  runtime must create separate body, engine, propellant, actuator, guidance,
  and recovery state for the left and right instances.
- Side boosters are not inserted into `centralStack.members`; they remain
  lateral assembly members, not axial stages.
- References are never silently pruned. A missing or incompatible reference
  makes validation fail and must be visible to the user.

`js/vehicleAssemblies.js` exposes storage CRUD and
`validateVehicleAssembly()`. Validation delegates axial stack checks to the
existing `validateStack()` function and additionally checks central/side role
and derived positive finite **axial** height/mass. It does not yet derive lateral
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
  boosters, non-booster records, duplicate/missing slot identities, and
  invalid/non-finite derived geometry or mass.
- Reuse of one booster design in both side slots is permitted.
- Unit tests run with Node's built-in modules; no third-party dependency is
  introduced.

A passing Phase 1A test suite validates only the definition layer. It does not
validate physical flight support or make Falcon Heavy launchable.
