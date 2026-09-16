// ---------------------------------------------------------------------------
// Wind — FRAME: INERTIAL.
//
// wind.directionDeg: 0° = local East (direction of increasing phi, i.e. the
// direction Earth's rotation carries the surface), 90° = local Up (radial).
// The returned (wx, wy) is the wind's velocity in the INERTIAL frame.
//
// Because the atmosphere co-rotates with Earth, the inertial wind velocity
// at any point is `user_wind + ω_earth × r`. Callers that want the wind as
// seen from the ground subtract `earthSurfaceVelocity()` — see
// physics.js's computeDragAero(), which computes relative velocity as
//   v_rel_inertial = body.vx - (wind.wx + sv.vx)
// ---------------------------------------------------------------------------
// Global atmosphere on/off. When false, airDensity() returns 0, so every
// drag force, aero torque, and sky-density calculation goes to vacuum
// behaviour automatically. Toggled live via a toolbar checkbox:
//   - main thread: sets this global directly
//   - physics worker: receives a `setAtmosphere` message
// Both contexts load this file, so each has its own copy — the toggle
// syncs both.
let atmosphereEnabled = true;

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
  if (!atmosphereEnabled) return 0;
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
  // East = direction of increasing φ = direction of Earth's rotation.
  // Matches telemetry.js's uex/uey and earthSurfaceVelocity(). Previous
  // (-upY, upX) was WEST — the wind panel's 0° compass arrow pointed East
  // while the physics pushed the rocket West, an invisible contradiction
  // until you actually watched the response.
  const eastX = upY, eastY = -upX;
  const rad = wind.directionDeg * Math.PI / 180;
  const dirX = eastX * Math.cos(rad) + upX * Math.sin(rad);
  const dirY = eastY * Math.cos(rad) + upY * Math.sin(rad);
  return { wx: dirX * wind.speed, wy: dirY * wind.speed };
}


// ---------------------------------------------------------------------------
// Earth-fixed helpers. A point pinned to the rotating Earth surface at
// initial angle LAUNCH_SITE_ANGLE_0 has inertial position
//   x(t) = R·sin(φ0 + ωt),  y(t) = R·cos(φ0 + ωt)
// and its inertial velocity is the time-derivative, i.e. ω × r.
// ---------------------------------------------------------------------------
function launchSiteWorldPosition(t) {
  const phi = (CONFIG.LAUNCH_SITE_ANGLE_0 || 0) + CONFIG.EARTH_OMEGA * (t || 0);
  const r = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
  return { x: r * Math.sin(phi), y: r * Math.cos(phi), phi };
}

// Velocity of a point rigidly fixed to the rotating Earth surface, at the
// given inertial position (rx, ry). With our (sin, cos) angle convention,
// the tangential velocity is (ω·ry, -ω·rx).
function earthSurfaceVelocity(rx, ry) {
  const w = CONFIG.EARTH_OMEGA;
  return { vx: w * ry, vy: -w * rx };
}