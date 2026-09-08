// ============================================================================
// environment.js — Earth-centered gravity, atmosphere, and wind.
//
// The rocket's position (rx, ry) is always measured from the CENTER OF THE
// EARTH (not from the launch pad). This is a deliberate choice so that this
// same physics core can later be extended toward orbital flight without a
// rewrite — see the "polar / Earth-centered frame" design discussion.
// ============================================================================

// Gravitational acceleration vector at a given Earth-centered position,
// always pointing toward the Earth's center (inverse-square law).
function gravityAccel(rx, ry) {
  const r = Math.hypot(rx, ry);
  const g = CONFIG.GM_EARTH / (r * r);
  return { ax: -g * rx / r, ay: -g * ry / r, g, r };
}

// Altitude above sea level, derived from distance-to-center.
function altitudeFromR(r) {
  return r - CONFIG.EARTH_RADIUS;
}

// Exponential atmosphere model: rho(h) = rho0 * e^(-h / scaleHeight).
function airDensity(altitude) {
  if (altitude < 0) return CONFIG.SEA_LEVEL_DENSITY;
  return CONFIG.SEA_LEVEL_DENSITY * Math.exp(-altitude / CONFIG.SCALE_HEIGHT);
}

// ---------------- Wind ----------------
// Modeled as a horizontal (locally tangential) vector at the rocket's current
// location. directionDeg: 0° = local "East" (tangential), 90° = local "Up".
// In practice we keep it purely tangential (horizontal) for a near-surface sim.
const wind = {
  enabled: false,
  speed: 0,        // m/s
  directionDeg: 0,
};

function windInertialVector(rx, ry) {
  if (!wind.enabled || wind.speed === 0) return { wx: 0, wy: 0 };
  const r = Math.hypot(rx, ry);
  const upX = rx / r, upY = ry / r;
  const eastX = -upY, eastY = upX;
  const rad = wind.directionDeg * Math.PI / 180;
  const dirX = eastX * Math.cos(rad) + upX * Math.sin(rad);
  const dirY = eastY * Math.cos(rad) + upY * Math.sin(rad);
  return { wx: dirX * wind.speed, wy: dirY * wind.speed };
}
