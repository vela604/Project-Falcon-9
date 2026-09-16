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
// offset, meters), isCenter, gimbal, Fmax, Fmin, Ve, throttle (0..1),
// gimbalDeg, currentF (last computed force, for telemetry/rendering) }
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
    const Fmax = g.massFlowRate * ve;
    const minFracEnt = t.parameterSchema.find(p => p.key === 'minThrottleFrac');
    const minFrac = minFracEnt ? minFracEnt.value : 0.4;
    engines.push({
      id: slot.id,
      angleDeg: slot.angleDeg,
      x: pos.x,
      isCenter: slot.role === 'center',
      gimbal: slot.gimbalCapable,
      Fmax,
      Fmin: Fmax * minFrac,
      Ve: ve,
      throttle: 0,
      targetThrottle: 0,
      gimbalDeg: 0,
      targetGimbalDeg: 0,
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