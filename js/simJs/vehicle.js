// ============================================================================
// vehicle.js — Engine layout (9 engines), mass/CoM/inertia, and the
// symmetric/asymmetric merge-group system for the octaweb circle diagram.
// ============================================================================

// Each engine: { id, angleDeg (null for center), x (2D projected lateral
// offset, meters), isCenter, gimbal, Fmax, Fmin, Ve, throttle (0..1),
// gimbalDeg, currentF (last computed force, for telemetry/rendering) }
const ENGINES = [];

function buildEngineLayout() {
  ENGINES.length = 0;

  ENGINES.push({
    id: 'C', angleDeg: null, x: 0, isCenter: true, gimbal: true,
    Fmax: CONFIG.ENGINE_F_MAX, Fmin: CONFIG.ENGINE_F_MAX * CONFIG.ENGINE_F_MIN_FRAC,
    Ve: CONFIG.ENGINE_VE,
    throttle: 0, gimbalDeg: 0, currentF: 0,
  });

  // 8 outer engines at 45° increments around the octaweb ring. Their 2D
  // lateral position is the projection onto the single simulated axis:
  //   x = R * cos(angle)
  // This naturally produces 5 distinct lateral positions:
  //   0° -> +R        180° -> -R          (the "extreme" pair)
  //   45°,315° -> +0.707R   135°,225° -> -0.707R   (the "diagonal" pairs, 2 engines each)
  //   90°,270° -> 0                                (the "on-axis" pair)
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];
  angles.forEach(a => {
    const x = CONFIG.OCTA_RADIUS * Math.cos(a * Math.PI / 180);
    ENGINES.push({
      id: 'E' + a, angleDeg: a, x: x, isCenter: false, gimbal: false,
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
// Default groups: engines whose angles are 180° apart (true octagon opposite
// pairs). This gives exactly 4 pairs + center = 5 sliders, matching the
// design brief. Every default group is inherently torque-symmetric — firing
// a group's two engines at equal throttle never produces yaw about the CoM
// beyond the intended thrust axis.
// ---------------------------------------------------------------------------
function defaultPairGroups() {
  return [
    { name: 'On-Axis',  angles: [90, 270] },
    { name: 'Diag-A',   angles: [45, 225] },
    { name: 'Diag-B',   angles: [135, 315] },
    { name: 'Extreme',  angles: [0, 180] },
  ];
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
// slider never creates a differential-thrust rotation about Z.
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
