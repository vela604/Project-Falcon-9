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

// ---------------------------------------------------------------------------
// Atmosphere — U.S. Standard Atmosphere 1976 (US76).
//
//   0 – 86 km (geometric): the seven standard temperature layers. Pressure
//   follows from the hydrostatic equation and density from the ideal-gas law,
//   so density, pressure and temperature are mutually consistent:
//
//     T(H)  = Tb + Lb·(H − Hb)                         (geopotential H)
//     P(H)  = Pb·(T/Tb)^(−g0 / (R·Lb))     if Lb ≠ 0
//           = Pb·exp(−g0·(H − Hb) / (R·Tb)) if Lb = 0
//     ρ     = P / (R·T)
//     H     = r0·h / (r0 + h)                  r0 = 6 356 766 m
//
//   86 – 1000 km: US76 tabulated density and kinetic temperature, with
//   log-linear interpolation of density (density falls close to
//   exponentially between table rows). Above 1000 km density continues
//   with the slope of the last table segment.
//
// Above 86 km pressure is estimated as ρ·R·T with the sea-level gas constant.
// The true mean molecular weight changes there, so it is only approximate;
// the value is below 0.4 Pa, which changes nozzle exhaust velocity by less
// than 0.01 m/s, so it does not affect engine performance.
//
// US76 describes MODERATE solar activity. Real density at orbital altitude
// changes by roughly a factor of 10 over the solar cycle.
// ---------------------------------------------------------------------------
const _ATM = (function () {
  const R = 287.05287; // J/(kg·K), specific gas constant of dry air
  const g0 = 9.80665; // m/s²
  const r0 = 6356766; // m, US76 reference radius for geopotential height
  const Hb = [0, 11000, 20000, 32000, 47000, 51000, 71000]; // layer bases (geopotential m)
  const Tb = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65]; // K at layer bases
  const Lb = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002]; // K/m
  const Pb = [101325];
  for (let i = 1; i < Hb.length; i++) {
    const dH = Hb[i] - Hb[i - 1];
    Pb[i] = (Lb[i - 1] === 0) ?
      Pb[i - 1] * Math.exp(-g0 * dH / (R * Tb[i - 1])) :
      Pb[i - 1] * Math.pow((Tb[i - 1] + Lb[i - 1] * dH) / Tb[i - 1], -g0 / (R * Lb[i - 1]));
  }
  // Upper atmosphere table: [geometric altitude km, density kg/m³, kinetic temperature K]
  const UP = [
    [86, 6.958e-6, 186.87], [90, 3.416e-6, 186.87], [100, 5.604e-7, 195.08],
    [110, 9.708e-8, 240.0], [120, 2.222e-8, 360.0], [130, 8.152e-9, 469.27],
    [140, 3.831e-9, 559.63], [150, 2.076e-9, 634.39], [160, 1.233e-9, 696.29],
    [180, 5.194e-10, 790.07], [200, 2.541e-10, 854.56], [250, 6.073e-11, 941.33],
    [300, 1.916e-11, 976.01], [350, 7.014e-12, 990.06], [400, 2.803e-12, 995.83],
    [450, 1.184e-12, 998.22], [500, 5.215e-13, 999.24], [600, 1.137e-13, 999.85],
    [700, 3.070e-14, 999.97], [800, 1.136e-14, 999.99], [900, 5.759e-15, 1000.0],
    [1000, 3.561e-15, 1000.0],
  ];
  const upZ = UP.map(r => r[0] * 1000);
  const upLnRho = UP.map(r => Math.log(r[1]));
  const upT = UP.map(r => r[2]);
  const out = { T: 288.15, P: 101325, rho: 1.225 }; // reused scratch object (no per-call allocation)

  function state(altM) {
    const h = altM < 0 ? 0 : altM;
    if (h < 86000) {
      const H = r0 * h / (r0 + h);
      let i = Hb.length - 1;
      while (i > 0 && H < Hb[i]) i--;
      const dH = H - Hb[i];
      const T = Tb[i] + Lb[i] * dH;
      const P = (Lb[i] === 0) ?
        Pb[i] * Math.exp(-g0 * dH / (R * Tb[i])) :
        Pb[i] * Math.pow(T / Tb[i], -g0 / (R * Lb[i]));
      out.T = T; out.P = P; out.rho = P / (R * T);
      return out;
    }
    const n = upZ.length;
    let i = 0;
    while (i < n - 2 && h > upZ[i + 1]) i++;
    const t = (h - upZ[i]) / (upZ[i + 1] - upZ[i]); // t > 1 above the table: extrapolate
    const lnRho = upLnRho[i] + t * (upLnRho[i + 1] - upLnRho[i]);
    const T = h >= upZ[n - 1] ? upT[n - 1] : upT[i] + t * (upT[i + 1] - upT[i]);
    const rho = Math.exp(lnRho);
    out.T = T; out.rho = rho; out.P = rho * R * T;
    return out;
  }
  return { state };
})();

// Mass density, kg/m³. Zero when the atmosphere toggle is off.
function airDensity(altitude) {
  if (!atmosphereEnabled) return 0;
  return _ATM.state(altitude).rho;
}

// Static ambient pressure, Pa. Same atmosphereEnabled guard as airDensity(),
// so toggling "Atmosphere" off zeroes both density and pressure.
function airPressure(altitude) {
  if (!atmosphereEnabled) return 0;
  return _ATM.state(altitude).P;
}

// Ambient temperature, K (not gated by the toggle; it is a property of the
// reference atmosphere, used for the speed of sound).
function airTemperature(altitude) {
  return _ATM.state(altitude).T;
}

// Speed of sound, m/s: a = sqrt(γ·R·T), γ = 1.4. Below 86 km this is the
// physical value; above it the air is too thin for a sound speed to mean
// much, but the value is only used to form a Mach number there.
function speedOfSound(altitude) {
  return Math.sqrt(1.4 * 287.05287 * _ATM.state(altitude).T);
}

// ---------------------------------------------------------------------------
// Hull drag coefficient as a function of Mach number and altitude.
//
//   Cd = Cd_ref · f(Mach)                                (continuum flow)
//   Cd = (1 − w)·Cd_continuum + w·Cd_free_molecular       (blend with altitude)
//
// f(Mach) is the usual slender-body shape: flat subsonic, a steep rise
// through the transonic range (wave drag) to a peak near Mach 1.1, then a
// gradual fall through the supersonic range to a hypersonic plateau.
// It is normalised so that f(2.0) = 1, so CONFIG.DRAG_CD is the Cd the hull
// has at Mach 2 (in the middle of the ascent). With Cd_ref = 0.6 this gives
// about 0.36 subsonic, 0.93 at the transonic peak and 0.33 hypersonic.
//
// A smooth, monotone-preserving cubic (Fritsch–Carlson / PCHIP) joins the
// table nodes, so the drag has no kinks when Mach sweeps through the peak.
//
// Free-molecular flow: once the mean free path becomes comparable to the
// vehicle size the air no longer behaves like a continuum and the drag
// coefficient of a body rises to about 2.2 (the value used for satellites).
// The blend runs from CONFIG.DRAG_FM_ALT_START_M to DRAG_FM_ALT_FULL_M.
// This only matters for orbital decay; at those altitudes the density is
// too low to change an ascent.
// ---------------------------------------------------------------------------
const _HULL_CD = (function () {
  const xs = [0, 0.6, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0];
  const ys = [0.60, 0.62, 0.75, 0.95, 1.35, 1.55, 1.50, 1.25, 1.00, 0.78, 0.68, 0.60, 0.55];
  const n = xs.length, h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  function f(M) {
    if (!(M > xs[0])) return ys[0];
    if (M >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (M > xs[i + 1]) i++;
    const t = (M - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  }
  return { f };
})();

// Dimensionless Cd multiplier vs Mach (equals 1 at Mach 2).
function hullCdMachFactor(mach) {
  return _HULL_CD.f(mach);
}

// Absolute hull Cd for a given airspeed (m/s, relative to the air) and altitude (m).
// Physics and guidance should both call this so they agree on the drag.
function hullDragCoefficient(speedRel, altitude) {
  const a = speedOfSound(altitude);
  const cdContinuum = CONFIG.DRAG_CD * _HULL_CD.f(a > 0 ? speedRel / a : 0);
  const cdFM = Number.isFinite(CONFIG.DRAG_CD_FREE_MOLECULAR) ? CONFIG.DRAG_CD_FREE_MOLECULAR : 2.2;
  const alt0 = Number.isFinite(CONFIG.DRAG_FM_ALT_START_M) ? CONFIG.DRAG_FM_ALT_START_M : 90000;
  const alt1 = Number.isFinite(CONFIG.DRAG_FM_ALT_FULL_M) ? CONFIG.DRAG_FM_ALT_FULL_M : 160000;
  if (altitude <= alt0) return cdContinuum;
  const x = Math.min(1, (altitude - alt0) / (alt1 - alt0));
  const w = x * x * (3 - 2 * x); // smoothstep
  return cdContinuum * (1 - w) + cdFM * w;
}

// ---------------- Wind ----------------
// Modeled as a horizontal (locally tangential) vector at the rocket's current
// location. directionDeg: 0° = local "East" (tangential), 90° = local "Up".
// In practice we keep it purely tangential (horizontal) for a near-surface sim.
const wind = {
  enabled: false,
  speed: 0, // m/s
  directionDeg: 0,
};

function windInertialVector(rx, ry) {
  if (!wind.enabled || wind.speed === 0) return { wx: 0, wy: 0 };
  const r = Math.hypot(rx, ry);
  const upX = rx / r,
    upY = ry / r;
  // East = direction of increasing φ = direction of Earth's rotation.
  // Matches telemetry.js's uex/uey and earthSurfaceVelocity(). Previous
  // (-upY, upX) was WEST — the wind panel's 0° compass arrow pointed East
  // while the physics pushed the rocket West, an invisible contradiction
  // until you actually watched the response.
  const eastX = upY,
    eastY = -upX;
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

// ============================================================================
// Skin equilibrium temperature (K) — derived quantity, no state.
//
// Two heating channels + one cooling channel, solved for radiative-
// convective equilibrium each call:
//
//   Recovery temperature (convective driving temp):
//     T_rec = T_air · (1 + 0.9·(γ-1)/2 · M²)
//
//   Convective coefficient (Re-analogy, calibrated):
//     h = 0.03 · ρ · V · Cp_air     (+ natural-convection floor below 60 km)
//
//   Environmental background (radiative bath):
//     T_env = T_air below 80 km · blend 80-120 km · 250 K (LEO) above
//
//   Solve:  h·T + εσ·T⁴ = h·T_rec + εσ·T_env⁴
//
// Called by telemetry.js (main sim) and guidance-tester-ui.js (tester) as
// a pure function — the caller accumulates the thermal lag separately.
// Cheap: single scalar solve, ~8 Newton iterations.
// ============================================================================
function skinEquilibriumK(altM, speedRelMps, heatingScale) {
  heatingScale = Number.isFinite(heatingScale) ? heatingScale : 1;
  const alt = Math.max(0, altM);
  const T_air = airTemperature(alt);
  const rho = airDensity(alt);
  const hasAir = (typeof atmosphereEnabled === 'undefined' || atmosphereEnabled) && rho > 1e-9;

  const a_sound = speedOfSound(alt);
  const M = (hasAir && a_sound > 0 && speedRelMps > 0) ? speedRelMps / a_sound : 0;
  const T_rec = hasAir ? Math.min(3000, T_air * (1 + 0.9 * 0.2 * M * M)) : 0;

  const T_space = 250;
  let T_env;
  if (!hasAir) T_env = T_space;
  else if (alt < 80000) T_env = T_air;
  else if (alt > 120000) T_env = T_space;
  else T_env = T_air + (T_space - T_air) * (alt - 80000) / 40000;

  let h_conv;
  if (!hasAir) h_conv = 0;
  else {
    const forced = 0.03 * rho * Math.max(0, speedRelMps) * 1000 * heatingScale;
    const natural = (rho > 1e-4) ? 5 * heatingScale : 0;
    h_conv = Math.max(forced, natural);
  }

  const sigma = 5.670374e-8;
  const eps = 0.85;
  const T_env_4 = T_env * T_env * T_env * T_env;
  const rhs = h_conv * T_rec + eps * sigma * T_env_4;

  let T = Math.max(T_env, Math.min(T_rec > 0 ? T_rec : T_env, 500));
  for (let i = 0; i < 8; i++) {
    const T2 = T * T;
    const f = h_conv * T + eps * sigma * T2 * T2 - rhs;
    const df = h_conv + 4 * eps * sigma * T * T * T;
    if (df <= 1e-12) break;
    T -= f / df;
    if (T < 4) T = 4;
    if (T > 3000) T = 3000;
  }
  return T;
}
