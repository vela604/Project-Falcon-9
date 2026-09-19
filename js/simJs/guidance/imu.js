// ============================================================================
// imu.js — Phase 3: IMU error model.
//
// Pure function module: measure(trueState) -> measuredState. Runs ONLY
// inside guidance.worker.js. Never imports anything, never touches `state`
// or `CONFIG` — those don't exist in this worker's scope at all.
//
// Noise model: white Gaussian, per-quantity, per-call, from a seeded PRNG.
// Same seed => same sequence => reproducible A/B runs.
// ============================================================================

// ---- Seeded PRNG: mulberry32 ----
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IMU_DEFAULT_SEED = 0x1a2b3c4d;
let _seed = IMU_DEFAULT_SEED;
let _rand = _mulberry32(_seed);
let _spareGaussian = null;

function _nextGaussian() {
  if (_spareGaussian !== null) {
    const g = _spareGaussian;
    _spareGaussian = null;
    return g;
  }
  let u1 = _rand();
  if (u1 <= 0) u1 = 1e-12;
  const u2 = _rand();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  _spareGaussian = r * Math.sin(theta);
  return r * Math.cos(theta);
}

function _gauss(sigma) {
  return _nextGaussian() * sigma;
}

function setSeed(seed) {
  _seed = seed >>> 0;
  _rand = _mulberry32(_seed);
  _spareGaussian = null;
}

function resetToDefaultSeed() {
  setSeed(IMU_DEFAULT_SEED);
}

// ============================================================================
// SENSOR_SPECS — the noise envelope, one entry per sensor reading that
// guidance receives in its snapshot. EDIT THIS to tune the sim's sensor
// fidelity. Any entry whose `sigma` is 0, missing, or non-finite passes
// its value through un-noised. Add/remove keys as the snapshot schema
// evolves — measure() walks this table, it does not hardcode field names.
//
// Sigma values are representative real-hardware figures for launch-
// vehicle-grade sensors (individual `source` notes below name the
// reference class). They are deliberately on the pessimistic side — a
// good GPS/INS can do better, but a rocket in a vibration-heavy ascent
// is the reference case here.
// ============================================================================
const SENSOR_SPECS = {
  // --- GPS + INS fused state estimate ---
  rx:           { sigma: 5,      unit: 'm',     source: 'GPS position fix (~1-10 m)' },
  ry:           { sigma: 5,      unit: 'm',     source: 'GPS position fix (~1-10 m)' },
  vx:           { sigma: 0.05,   unit: 'm/s',   source: 'GPS doppler velocity' },
  vy:           { sigma: 0.05,   unit: 'm/s',   source: 'GPS doppler velocity' },

  // --- IMU ---
  theta:        { sigma: 1.7e-3, unit: 'rad',   source: 'IMU attitude (gyro-integrated, ~0.1°)' },
  omega:        { sigma: 8.7e-4, unit: 'rad/s', source: 'IMU rate gyro (~0.05°/s short-term)' },
  ax:           { sigma: 0.01,   unit: 'm/s²',  source: 'IMU accelerometer (~1 mg)' },
  ay:           { sigma: 0.01,   unit: 'm/s²',  source: 'IMU accelerometer (~1 mg)' },

  // --- Propellant tank ---
  fuelMass:     { sigma: 300,    unit: 'kg',    source: 'cryogenic tank gauging (~0.06% of 500t)' },

  // --- Engine instrumentation (applied per engine) ---
  engineFlow:   { sigma: 0.3,    unit: 'kg/s',  source: 'turbine flow meter (~0.1%)' },
  engineGimbal: { sigma: 0.02,   unit: 'deg',   source: 'gimbal LVDT (~0.1% FS)' },

  // --- Landing gear ---
  legsProgress: { sigma: 0.01,   unit: 'frac',  source: 'leg position sensor (~1% travel)' },
};

// ---- Enabled flag ----
let _enabled = false;

function setEnabled(enabled) {
  _enabled = !!enabled;
}

function isEnabled() {
  return _enabled;
}

// Reads the spec for a given key and adds Gaussian noise if sigma is set.
// Values that are not finite (NaN/undefined) pass through untouched —
// the sensor layer shouldn't manufacture numbers where there were none.
function _noise(value, specKey) {
  if (!Number.isFinite(value)) return value;
  const spec = SENSOR_SPECS[specKey];
  if (!spec || !Number.isFinite(spec.sigma) || spec.sigma <= 0) return value;
  return value + _gauss(spec.sigma);
}

// measure(x) -> new object, same shape as x, per-sensor noise applied when
// enabled. Never mutates x. Everything not listed in SENSOR_SPECS (mass
// flow flags, RCS state, member records, status booleans, ...) passes
// through untouched.
//
// PHASE 3 CONTRACT: when disabled, this is a true identity — returns the
// SAME reference, not a shallow copy — so a disabled IMU is bit-exact to
// not having an IMU module at all.
function measure(trueState) {
  if (!_enabled) return trueState;

  const out = Object.assign({}, trueState);
  if (Array.isArray(trueState.bodies)) {
    out.bodies = trueState.bodies.map(b => {
      if (!b) return b;
      const nb = Object.assign({}, b);

      // GPS + INS fused kinematics
      nb.rx = _noise(b.rx, 'rx');
      nb.ry = _noise(b.ry, 'ry');
      nb.vx = _noise(b.vx, 'vx');
      nb.vy = _noise(b.vy, 'vy');
      // IMU attitude + rate
      nb.theta = _noise(b.theta, 'theta');
      nb.omega = _noise(b.omega, 'omega');
      // IMU accelerometer (body-frame)
      if (Number.isFinite(b.ax)) nb.ax = _noise(b.ax, 'ax');
      if (Number.isFinite(b.ay)) nb.ay = _noise(b.ay, 'ay');
      // Tank level
      nb.fuelMass = _noise(b.fuelMass, 'fuelMass');

      // Engine flow meter + gimbal LVDT — per engine
      if (Array.isArray(b.engines)) {
        nb.engines = b.engines.map(e => ({
          ...e,
          massFlowRate: _noise(e.massFlowRate, 'engineFlow'),
          gimbalDeg:    _noise(e.gimbalDeg,    'engineGimbal'),
        }));
      }

      // Landing gear position
      if (b.legs) {
        nb.legs = { ...b.legs, progress: _noise(b.legs.progress, 'legsProgress') };
      }

      return nb;
    });
  }
  return out;
}

// Node/CommonJS export for the standalone verification harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    measure, setEnabled, isEnabled,
    setSeed, resetToDefaultSeed,
    SENSOR_SPECS, IMU_DEFAULT_SEED,
  };
}