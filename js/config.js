// ============================================================================
// config.js — Single source of truth for all tunable constants.
//
// NOTE: This file currently hard-codes one default vehicle ("Falcon-9-class").
// Once the Rocket Management page exists, this object will instead be
// populated from the user's selected rocket's saved parameters. Keeping every
// number in one place (instead of scattered through the codebase) is what
// makes that swap possible later without touching physics/render code.
// ============================================================================

const CONFIG = {

  // ---------------- Universal / Earth ----------------
  EARTH_RADIUS: 6371000,          // m
  GM_EARTH: 3.986004418e14,       // m^3/s^2  (standard gravitational parameter)
  SEA_LEVEL_DENSITY: 1.225,       // kg/m^3
  SCALE_HEIGHT: 8500,             // m (exponential atmosphere model)

  // ---------------- Vehicle geometry & mass ----------------
  ROCKET_NAME: 'Falcon-9-Class (Default)',
  ROCKET_HEIGHT: 45,              // m
  ROCKET_WIDTH: 3.9,              // m
  DRY_MASS: 23000,                // kg
  FUEL_MASS_MAX: 400000,          // kg

  // ---------------- Main engines (octaweb, 2D projection) ----------------
  OCTA_RADIUS: 1.7,               // m — radius of the 8 outer engines
  ENGINE_F_MAX: 600000,           // N per engine
  ENGINE_F_MIN_FRAC: 0.4,         // 40% throttle floor
  ENGINE_VE: 2900,                // m/s exhaust velocity
  ENGINE_THRUST_RATE: 0.5,        // max change rate, fraction of F_MAX per second
  GIMBAL_MAX_DEG: 20,             // ± degrees (center engine only)
  GIMBAL_RATE_DEG_S: 40,          // deg/sec max slew rate (full ±20 sweep in 1s)

  // ---------------- RCS (4 advanced pods) ----------------
  RCS_THRUST: 1100,               // N, fixed magnitude per nozzle
  RCS_VE: 2200,                   // m/s
  RCS_X_OFFSET: 1.95,             // m from centerline
  RCS_TOP_MARGIN: 3,              // m below the nose where top pods sit
  RCS_BOTTOM_MARGIN: 3,           // m above the base where bottom pods sit
  RCS_PWM_PERIOD: 0.12,           // s, duty-cycle period for the far-arm pod

  // ---------------- Aerodynamics ----------------
  DRAG_CD: 0.6,                   // dimensionless, orientation-independent (Phase-1 simplification)

  // ---------------- Simulation ----------------
  DT: 1 / 60,                     // s, fixed physics timestep
};
