// ============================================================================
// imu.js — Phase 3: IMU error model.
//
// Pure function module: measure(trueState) -> measuredState. Runs ONLY
// inside guidance.worker.js. Never imports anything, never touches `state`
// or `CONFIG` — those don't exist in this worker's scope at all (see
// guidance.worker.js's importScripts list). Everything this file needs
// arrives as the argument to measure().
//
// Noise model: white Gaussian, per-axis, per-call, from a seeded PRNG —
// same seed => same sequence => reproducible A/B runs (guidance-with-noise
// vs guidance-without-noise on the same trajectory). See setSeed()/reset()
// below for how a caller controls that.
// ============================================================================

// ---- Seeded PRNG: mulberry32. Small, fast, good-enough statistical
// quality for a noise model (not cryptographic — doesn't need to be). ----
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

// Module-level seed. A future UI field could call setSeed() to override
// this before the first measure() call; until then it's a fixed constant,
// per the spec ("the seed is a module-level constant by default").
const IMU_DEFAULT_SEED = 0x1a2b3c4d;
let _seed = IMU_DEFAULT_SEED;
let _rand = _mulberry32(_seed);

// Box-Muller keeps one spare normal sample per pair of uniform draws —
// halves the PRNG calls per Gaussian sample on average.
let _spareGaussian = null;

function _nextGaussian() {
  if (_spareGaussian !== null) {
    const g = _spareGaussian;
    _spareGaussian = null;
    return g;
  }
  // Box-Muller transform. u1 must be nonzero (log(0) is -Infinity) — the
  // ' || 1e-12' term below excludes the exact-zero case, which the
  // mulberry32 stream can in principle produce.
  let u1 = _rand();
  if (u1 <= 0) u1 = 1e-12;
  const u2 = _rand();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  _spareGaussian = r * Math.sin(theta);
  return r * Math.cos(theta);
}

// Gaussian sample with the given standard deviation (mean 0).
function _gauss(sigma) {
  return _nextGaussian() * sigma;
}

// setSeed(): re-seeds the PRNG and discards any pending spare sample (a
// leftover spare from the OLD seed would otherwise leak one draw from the
// previous sequence into the new one). Two calls to measure() after
// setSeed(sameValue) always produce the same sequence — this is the
// "seedable/deterministic" contract the spec requires, and it's exercised
// directly by the Node harness in VERIFY.md.
function setSeed(seed) {
  _seed = seed >>> 0;
  _rand = _mulberry32(_seed);
  _spareGaussian = null;
}

function resetToDefaultSeed() {
  setSeed(IMU_DEFAULT_SEED);
}

// ---- Noise magnitudes (Phase 3 scope — see IMU_PROMPT_md.txt "What gets
// noised"). Attitude/rate in radians (internal unit used by physics —
// deg values in the spec are converted here once, so every caller of
// measure() works in the same units the rest of the sim already uses). ----
const IMU_SIGMA = {
  theta: 1.7e-3, // rad  (~0.1°)
  omega: 8.7e-4, // rad/s (~0.05°/s)
  position: 5, // m per axis
  velocity: 0.05, // m/s per axis
};

// ---- Enabled flag. Module-level, not a measure() parameter — this is
// what makes "measure() is identity when disabled" a property of the
// function itself (spec's literal contract), rather than something every
// caller has to remember to check before calling. guidance.js flips this
// via setEnabled() when it gets the 'setImuEnabled' message from main
// thread; it does NOT need its own separate on/off branching around every
// measure() call site as a result.
let _enabled = false;

function setEnabled(enabled) {
  _enabled = !!enabled;
}

function isEnabled() {
  return _enabled;
}

// measure(x) -> new object, same shape as x, four kinematic fields
// replaced with noisy draws when enabled. Never mutates x. Every other
// field (mass, engine states, flags, members, rcs state, id, simTime, ...)
// is passed through BY REFERENCE — safe, because the caller (guidance.js)
// owns the input and never mutates it either; see guidance.js's snapshot
// handling.
//
// PHASE 3 CONTRACT: when disabled, this is a true identity — returns the
// SAME reference, not a shallow copy — so a disabled IMU is bit-exact to
// not having an IMU module at all (success criterion #2).
function measure(trueState) {
  if (!_enabled) return trueState;
  
  const out = Object.assign({}, trueState);
  if (Array.isArray(trueState.bodies)) {
    out.bodies = trueState.bodies.map(b => {
      if (!b) return b;
      const nb = Object.assign({}, b);
      nb.theta = b.theta + _gauss(IMU_SIGMA.theta);
      nb.omega = b.omega + _gauss(IMU_SIGMA.omega);
      nb.rx = b.rx + _gauss(IMU_SIGMA.position);
      nb.ry = b.ry + _gauss(IMU_SIGMA.position);
      nb.vx = b.vx + _gauss(IMU_SIGMA.velocity);
      nb.vy = b.vy + _gauss(IMU_SIGMA.velocity);
      return nb;
    });
  }
  return out;
}

// Node/CommonJS export for the standalone verification harness; inside the
// worker this is simply unused (typeof module === 'undefined' there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { measure, setEnabled, isEnabled, setSeed, resetToDefaultSeed, IMU_SIGMA, IMU_DEFAULT_SEED };
}