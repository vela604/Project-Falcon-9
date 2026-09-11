// ============================================================================
// config.js — Single source of truth for all tunable constants.
//
// Vehicle-specific fields (geometry/mass/engines/RCS/drag) are pulled from
// the user's SELECTED rocket in the fleet (see fleet.js, populated by the
// Vehicle Fleet page) — PHASE 2 shape: ACTIVE_VEHICLE.params.* plus three
// hardware TYPE ids resolved against the Components Library
// (componentLibrary.js) into CONFIG.ENGINE_LAYOUT / RECOVERY_TYPE / RCS_TYPE,
// so vehicle.js/controls.js/physics.js/rcs.js/rocketArt.js can read a
// type's `frame`/`capabilities` instead of anything hardcoded. If
// fleet.js/componentLibrary.js haven't been loaded on this page, or the
// fleet is empty, this falls back to the hard-coded default below so every
// page keeps working standalone.
// ============================================================================

const DEFAULT_VEHICLE = {
  name: 'Falcon-9-Class (Default)',
  height: 45, width: 3.9, dryMass: 23000, fuelMassMax: 400000, dragCd: 0.6,
  engineTypeId: 'octaweb-merlin9',
  recoveryTypeId: 'legs-swingout-4',
  rcsTypeId: 'rcs-4pod-2nozzle',
  params: {
    octaRadius: 1.7, engineFMax: 600000, engineFMinFrac: 0.4, engineVe: 2900,
    engineThrustRate: 0.5, gimbalMaxDeg: 20, gimbalRateDegS: 40,
    legDeployRate: 0.5, // fraction of full travel per second (~2s to fully deploy/stow)
    rcsThrust: 1100, rcsVe: 2200, rcsXOffset: 1.95,
    rcsTopMargin: 3, rcsBottomMargin: 3, rcsPwmPeriod: 0.3,
  },
};

const ACTIVE_VEHICLE = (typeof getSelectedRocket === 'function') ? getSelectedRocket() : DEFAULT_VEHICLE;

// Resolve the three hardware types this vehicle references against the
// Components Library registry. Every other file consumes ONLY these
// resolved objects (frame/capabilities/parameterSchema) — never the id
// strings — per Phase 2's no-branching-on-type.id rule.
const RESOLVED_ENGINE_LAYOUT = (typeof getComponentType === 'function') ? getComponentType(ACTIVE_VEHICLE.engineTypeId) : null;
const RESOLVED_RECOVERY_TYPE = (typeof getComponentType === 'function') ? getComponentType(ACTIVE_VEHICLE.recoveryTypeId) : null;
const RESOLVED_RCS_TYPE = (typeof getComponentType === 'function') ? getComponentType(ACTIVE_VEHICLE.rcsTypeId) : null;

const CONFIG = {

  // ---------------- Universal / Earth ----------------
  EARTH_RADIUS: 6371000,          // m
  GM_EARTH: 3.986004418e14,       // m^3/s^2  (standard gravitational parameter)
  SEA_LEVEL_DENSITY: 1.225,       // kg/m^3
  SCALE_HEIGHT: 8500,             // m (exponential atmosphere model)

  // ---------------- Vehicle geometry & mass ----------------
  ROCKET_NAME: ACTIVE_VEHICLE.name,
  ROCKET_HEIGHT: ACTIVE_VEHICLE.height,           // m
  ROCKET_WIDTH: ACTIVE_VEHICLE.width,             // m
  DRY_MASS: ACTIVE_VEHICLE.dryMass,               // kg
  FUEL_MASS_MAX: ACTIVE_VEHICLE.fuelMassMax,      // kg

  // ---------------- Main engines (octaweb, 2D projection) ----------------
  OCTA_RADIUS: ACTIVE_VEHICLE.params.octaRadius,         // m — radius of the 8 outer engines
  ENGINE_F_MAX: ACTIVE_VEHICLE.params.engineFMax,        // N per engine
  ENGINE_F_MIN_FRAC: ACTIVE_VEHICLE.params.engineFMinFrac, // 40% throttle floor (default)
  ENGINE_VE: ACTIVE_VEHICLE.params.engineVe,             // m/s exhaust velocity
  ENGINE_THRUST_RATE: ACTIVE_VEHICLE.params.engineThrustRate, // max change rate, fraction of F_MAX per second
  GIMBAL_MAX_DEG: ACTIVE_VEHICLE.params.gimbalMaxDeg,    // ± degrees (gimbal-capable engines)
  GIMBAL_RATE_DEG_S: ACTIVE_VEHICLE.params.gimbalRateDegS, // deg/sec max slew rate

  // ---------------- RCS (4 advanced pods) ----------------
  RCS_THRUST: ACTIVE_VEHICLE.params.rcsThrust,           // N, fixed magnitude per nozzle
  RCS_VE: ACTIVE_VEHICLE.params.rcsVe,                   // m/s
  RCS_X_OFFSET: ACTIVE_VEHICLE.params.rcsXOffset,        // m from centerline
  RCS_TOP_MARGIN: ACTIVE_VEHICLE.params.rcsTopMargin,    // m below the nose where top pods sit
  RCS_BOTTOM_MARGIN: ACTIVE_VEHICLE.params.rcsBottomMargin, // m above the base where bottom pods sit
  RCS_PWM_PERIOD: ACTIVE_VEHICLE.params.rcsPwmPeriod,    // s, duty-cycle period for the far-arm pod

  // ---------------- Aerodynamics ----------------
  DRAG_CD: ACTIVE_VEHICLE.dragCd,                 // dimensionless, orientation-independent (Phase-1 simplification)

  // ---------------- Landing legs ----------------
  LEG_DEPLOY_RATE: ACTIVE_VEHICLE.params.legDeployRate || 0.5, // fraction of full travel per second

  // ---------------- Resolved hardware TYPES (Components Library) ----------------
  // vehicle.js / controls.js / physics.js / rcs.js / rocketArt.js read
  // these instead of anything hardcoded. Falls back to the built-in
  // Falcon-9-class types if the registry somehow isn't available, so a
  // page never ends up with a null frame.
  ENGINE_LAYOUT: RESOLVED_ENGINE_LAYOUT || (typeof buildOctaweb9 === 'function' ? buildOctaweb9() : null),
  RECOVERY_TYPE: RESOLVED_RECOVERY_TYPE || (typeof buildLegsSwingout4 === 'function' ? buildLegsSwingout4() : null),
  RCS_TYPE: RESOLVED_RCS_TYPE || (typeof buildRcs4Pod2Nozzle === 'function' ? buildRcs4Pod2Nozzle() : null),

  // ---------------- Landing safety envelope ----------------
  // A touchdown only counts as a LANDING if all of these hold; otherwise
  // it's a crash. Kept as fixed, generous "don't break the hardware"
  // numbers rather than per-vehicle tuned values.
  LANDING_MIN_LEG_DEPLOY: 0.9,     // legs.progress must be at least this deployed
  LANDING_MAX_VSPEED: 5,           // m/s, max safe descent rate
  LANDING_MAX_HSPEED: 2.5,         // m/s, max safe lateral speed at touchdown
  LANDING_MAX_TILT_DEG: 12,        // ± degrees off local vertical
  LANDING_MAX_OMEGA: 0.15,         // rad/s, max safe spin rate at touchdown

  // Legs cannot be COMMANDED to deploy while the vehicle is still climbing
  // (powered ascent right off the pad) or moving faster than this, so they
  // can't be ripped open during launch or a fast reentry. Stowing is always
  // allowed. See legDeploySafety() in controls.js.
  LEG_DEPLOY_MAX_SPEED: 200,        // m/s

  // ---------------- Simulation ----------------
  DT: 1 / 60,                     // s, fixed physics timestep
};
