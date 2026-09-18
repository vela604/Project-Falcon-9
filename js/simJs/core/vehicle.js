// ============================================================================
// vehicle.js — Engine layout, mass/CoM/inertia, and the symmetric/asymmetric
// merge-group system for the engine circle diagram.
//
// PHASE 2: the engine layout is no longer hardcoded to 9 Falcon-9 engines —
// it's built generically from CONFIG.ENGINE_LAYOUT (resolved in config.js
// against componentLibrary.js's registry). A different `ringWithCenter`
// engine-layout type (any outer-engine count) works with ZERO changes to
// this file — only `kind` (a sub-shape discriminator, per the Phase 2
// no-branching-on-type.id rule) is ever inspected, never a specific type id.
// ============================================================================

// Each engine: { id, angleDeg (null for center), x (2D projected lateral
// offset, meters), isCenter, gimbal, Fmax, Fmin, Ve, maxMassFlowRate,
// minMassFlowRate, massFlowRateRateFrac, massFlowRate (kg/s, canonical
// command/state — PHASE 1: replaces the old throttle 0..1 fraction),
// targetMassFlowRate, gimbalDeg, targetGimbalDeg, targetGimbalRateDegS
// (PHASE 3: NaN unless a guidance rate command is active — see
// applyActuatorRateLimitsForBody in physics.js), currentF (last computed
// force, for telemetry/rendering) }
// Build an engine array for a specific record (its engineThrusters + layout).
function buildEnginesForRecord(rec) {
  const layout = (typeof getComponentType === 'function') ? getComponentType(rec.engineTypeId) : null;
  if (!layout || !layout.frame || !Array.isArray(layout.frame.slots)) return [];
  const engines = [];
  const groups = engineThrusterGroups(layout);
  const R = (rec.params && Number.isFinite(rec.params.octaRadius)) ? rec.params.octaRadius : 1.7;
  layout.frame.slots.forEach(slot => {
    const pos = (typeof slot.position === 'function') ? slot.position(R) : { x: 0 };
    const gk = slot.gimbalCapable ? 'gimbal' : 'fixed';
    const g = rec.engineThrusters && rec.engineThrusters[gk];
    if (!g) return;
    const t = (typeof getComponentType === 'function') ? getComponentType(g.thrusterTypeId) : null;
    if (!t) return;
    const ve = t.parameterSchema.find(p => p.key === 've').value;
    // PHASE 1: g.massFlowRate is this engine's build-time-chosen MAX mass
    // flow rate (kg/s) — the thruster type's maxMassFlowRate, capped at
    // build time. Thrust is derived (massFlowRate × Ve), never stored
    // independently.
    const maxMassFlowRate = g.massFlowRate;
    const minFracEnt = t.parameterSchema.find(p => p.key === 'minThrottleFrac');
    const minFrac = minFracEnt ? minFracEnt.value : 0.4;
    const minMassFlowRate = maxMassFlowRate * minFrac;
    const rateFracEnt = t.parameterSchema.find(p => p.key === 'maxThrottleRateFrac');
    // Falls back to the vehicle-wide CONFIG constant for any thruster type
    // that doesn't declare its own rate (keeps old vehicles' feel intact).
    const massFlowRateRateFrac = rateFracEnt ? rateFracEnt.value : CONFIG.ENGINE_THRUST_RATE;
    // PART B (Option 3): per-engine spool transients. Not yet exposed on
    // THRUSTER_CHEMICAL_SCHEMA in componentLibrary.js — these read as
    // undefined for every type today, and applyActuatorRateLimitsForBody
    // (physics.js) falls back to its own approximate constants in that
    // case. Reading them here (rather than hardcoding a number in this
    // file) means the day componentLibrary.js grows these keys, every
    // vehicle picks them up with zero changes here.
    const startupDurationEnt = t.parameterSchema.find(p => p.key === 'startupDurationS');
    const shutdownDurationEnt = t.parameterSchema.find(p => p.key === 'shutdownDurationS');
    const Fmax = maxMassFlowRate * ve;
    engines.push({
      id: slot.id,
      angleDeg: slot.angleDeg,
      x: pos.x,
      isCenter: slot.role === 'center',
      gimbal: slot.gimbalCapable,
      Fmax,
      Fmin: minMassFlowRate * ve,
      Ve: ve,
      // Physical flow-rate envelope for this specific engine (from its
      // thruster type). The command layer (controls.js/physics_worker.js)
      // clamps against these, not against a bare 0..1 fraction.
      maxMassFlowRate,
      minMassFlowRate,
      massFlowRateRateFrac,
      // PART B: undefined today (see comment above) — physics.js's rate
      // limiter treats a non-finite value here as "use my own default".
      startupDurationS: startupDurationEnt ? startupDurationEnt.value : undefined,
      shutdownDurationS: shutdownDurationEnt ? shutdownDurationEnt.value : undefined,
      // Canonical engine state: current and commanded mass flow, kg/s.
      massFlowRate: 0,
      targetMassFlowRate: 0,
      gimbalDeg: 0,
      targetGimbalDeg: 0,
      // PHASE 3: NaN = no active guidance rate command — the sentinel
      // applyActuatorRateLimitsForBody (physics.js) checks via
      // Number.isFinite() to decide between the rate-integration branch
      // and the existing angle-slew branch. Every engine starts here
      // (nothing has commanded a rate yet); setGimbal (human/angle) also
      // resets it back to NaN each time, since an angle command always
      // takes precedence over an in-progress rate command.
      targetGimbalRateDegS: NaN,
      currentF: 0,
    });
  });
  return engines;
}

// ENGINES is now a Proxy over the ACTIVE body's engines array. Existing code
// that reads/writes ENGINES[i].xyz keeps working unchanged — the reads/writes
// route to `state.bodies[state.activeBodyIndex].engines`.
const ENGINES = new Proxy([], {
  get(_, k) {
    const b = state.bodies && state.bodies[state.activeBodyIndex];
    if (!b || !b.engines) return (k === 'length') ? 0 : undefined;
    const val = b.engines[k];
    // Bind array methods (filter/forEach/reduce/find/…) to the underlying
    // real array, otherwise `this` is the (empty) proxy target and every
    // method sees length 0.
    if (typeof val === 'function') return val.bind(b.engines);
    return val;
  },
  set(_, k, v) {
    const b = state.bodies && state.bodies[state.activeBodyIndex];
    if (!b) return true;
    if (!b.engines) b.engines = [];
    b.engines[k] = v;
    return true;
  },
});

function getEngine(angleDeg) {
  return ENGINES.find(e => e.angleDeg === angleDeg);
}

// ---------------------------------------------------------------------------
// Default groups: derived from the registry's mergeTopology.symmetric list
// (id-pairs, e.g. ['E90','E270']) resolved back to angle-pairs — this is
// the generic replacement for the old hardcoded 4-pair Falcon-9 table.
// Whatever ring size the active engine layout has, this produces one group
// per 180°-opposite pair automatically. Falls back to no groups if the
// active layout doesn't expose a mergeTopology at all (e.g. a future
// non-ring engine-layout `kind` with no natural opposite-pair concept) —
// a defensive check on the SHAPE of the frame, not a branch on type.id.
// ---------------------------------------------------------------------------
function defaultPairGroups() {
  const layout = CONFIG.ENGINE_LAYOUT;
  if (!layout || !layout.frame.mergeTopology) return [];
  const slotById = {};
  layout.frame.slots.forEach(s => { slotById[s.id] = s; });
  return layout.frame.mergeTopology.symmetric.map(([idA, idB]) => {
    const a = slotById[idA],
      b = slotById[idB];
    return { name: `${Math.round(a.angleDeg)}°/${Math.round(b.angleDeg)}°`, angles: [a.angleDeg, b.angleDeg] };
  });
}

// mergeState.groups is the live list of controllable peripheral groups.
// mode = 'symmetric'  -> only opposite (180°-apart) angle-sets may be merged together
// mode = 'asymmetric' -> only same-lateral-position ("parallel", e.g. 45°&315°) angle-sets may be merged
let mergeState = {
  mode: 'symmetric',
  groups: defaultPairGroups(),
};

// Merge two existing groups into one (used by the circle-diagram UI).
// Validates that the merge doesn't create an unbalanced-torque configuration:
// for 'symmetric' mode groups must already be internally opposite-safe; for
// 'asymmetric' mode groups must share the same |x| projection so a shared
// slider never creates a differential-thrust rotation about Z. Already
// generic (works off computed x positions, not hardcoded angles) — no
// changes needed here for a different ring size.
function mergeGroups(groupNameA, groupNameB) {
  const a = mergeState.groups.find(g => g.name === groupNameA);
  const b = mergeState.groups.find(g => g.name === groupNameB);
  if (!a || !b || a === b) return false;
  
  if (mergeState.mode === 'asymmetric') {
    const xa = getEngine(a.angles[0]).x;
    const xb = getEngine(b.angles[0]).x;
    if (Math.abs(Math.abs(xa) - Math.abs(xb)) > 1e-6 || Math.sign(xa) !== Math.sign(xb)) {
      console.warn('Asymmetric merge rejected: groups are not at the same lateral (parallel) position.');
      return false;
    }
  }
  
  const merged = { name: a.name + '+' + b.name, angles: [...a.angles, ...b.angles] };
  mergeState.groups = mergeState.groups.filter(g => g !== a && g !== b);
  mergeState.groups.push(merged);
  return true;
}

function resetMerges() {
  mergeState.groups = defaultPairGroups();
}

// ---------------------------------------------------------------------------
// Mass properties (fuel-depletion dependent, recomputed every tick)
// ---------------------------------------------------------------------------
function computeCoM(fuelMass, totalMass, H) {
  const fuelCentroid = 0.275 * H; // propellant occupies the lower ~55% of the airframe
  const dryCentroid = 0.5 * H; // dry structure approximated as a uniform rod
  return (fuelMass * fuelCentroid + (totalMass - fuelMass) * dryCentroid) / totalMass;
}

function momentOfInertia(mass, H, W) {
  return mass * (H * H + W * W) / 12; // uniform rod approximation
}