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
const ENGINES = [];

function buildEngineLayout() {
  ENGINES.length = 0;

  // Every slot the registry's engine-layout type declares — for the
  // built-in octaweb-merlin9 this is 1 center + 8 outer at 45° spacing,
  // reproducing the original hardcoded layout exactly; a different
  // `ringWithCenter` type (say, 6 outer engines) needs no changes here at
  // all, just a different registry entry.
  CONFIG.ENGINE_LAYOUT.frame.slots.forEach(slot => {
    const pos = slot.position(CONFIG.OCTA_RADIUS);
    ENGINES.push({
      id: slot.id, angleDeg: slot.angleDeg, x: pos.x,
      isCenter: slot.role === 'center', gimbal: slot.gimbalCapable,
      Fmax: CONFIG.ENGINE_F_MAX, Fmin: CONFIG.ENGINE_F_MAX * CONFIG.ENGINE_F_MIN_FRAC,
      Ve: CONFIG.ENGINE_VE,
      throttle: 0, gimbalDeg: 0, currentF: 0,
    });
  });
}

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
    const a = slotById[idA], b = slotById[idB];
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
  const fuelCentroid = 0.275 * H;   // propellant occupies the lower ~55% of the airframe
  const dryCentroid = 0.5 * H;      // dry structure approximated as a uniform rod
  return (fuelMass * fuelCentroid + (totalMass - fuelMass) * dryCentroid) / totalMass;
}

function momentOfInertia(mass, H, W) {
  return mass * (H * H + W * W) / 12;   // uniform rod approximation
}
