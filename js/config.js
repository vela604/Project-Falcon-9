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
  height: 45,
  width: 3.9,
  dryMass: 23000,
  fuelMassMax: 400000,
  dragCd: 0.6,
  engineTypeId: 'octaweb-merlin9',
  recoveryTypeId: 'legs-swingout-4',
  rcsTypeId: 'rcs-4pod-2nozzle',
  params: {
    octaRadius: 1.7,
    engineFMax: 600000,
    engineFMinFrac: 0.4,
    engineVe: 2900,
    engineThrustRate: 0.5,
    gimbalMaxDeg: 20,
    gimbalRateDegS: 40,
    legDeployRate: 0.5, // fraction of full travel per second (~2s to fully deploy/stow)
    rcsThrust: 1100,
    rcsVe: 2200,
    rcsXOffset: 1.95,
    rcsTopMargin: 3,
    rcsBottomMargin: 3,
    rcsPwmPeriod: 0.3,
  },
};

const ACTIVE_VEHICLE = (typeof getSelectedRocket === 'function') ? getSelectedRocket() : DEFAULT_VEHICLE;



// ---------------------------------------------------------------------------
// Phase 4 (P4-C2) — booster derived masses override manual dry/fuel fields.
// A booster record no longer carries dryMass/fuelMassMax; both come from
// boosterDerivedMasses(). Rocket/stage/nose keep their existing shapes.
// ---------------------------------------------------------------------------
const _activeRole = ACTIVE_VEHICLE.stageRole || 'rocket';
const _boosterDerived = (_activeRole === 'booster' && typeof boosterDerivedMasses === 'function') ?
  boosterDerivedMasses(ACTIVE_VEHICLE) :
  null;

// Phase 4 — default starting fuel is 60% of max tank capacity. This leaves
// headroom so the player can add fuel at the pad / landing site. Bounded by
// the sim's refueling UI (P4-C4).
const DEFAULT_FUEL_FRACTION = 1.0;


// ---------------------------------------------------------------------------
// Phase 4 (P4-C2b-1): the sim flies the ACTIVE STACK. Aggregate dry/fuel/
// height/width across all members; hardware types (engines/RCS/recovery)
// come from the BOTTOM member (the booster) — the one doing the launch.
// ---------------------------------------------------------------------------
const ACTIVE_STACK = (typeof getActiveStack === 'function') ? getActiveStack() : null;
const ACTIVE_STACK_MEMBERS = (typeof getActiveStackMembers === 'function') ?
  getActiveStackMembers() : (ACTIVE_VEHICLE ? [ACTIVE_VEHICLE] : []);
const ACTIVE_STACK_AGG = (typeof stackCombinedAggregates === 'function') ?
  stackCombinedAggregates(ACTIVE_STACK) : null;
const STACK_BOTTOM = ACTIVE_STACK_AGG ? ACTIVE_STACK_AGG.bottomMember : ACTIVE_VEHICLE;

// Bottom member is the primary hardware source. All existing CONFIG fields
// that used ACTIVE_VEHICLE.params.* now source from STACK_BOTTOM instead.
const ACTIVE_VEHICLE_FOR_HARDWARE = STACK_BOTTOM || ACTIVE_VEHICLE;

// Resolve the three hardware types this vehicle references against the
// Components Library registry. Every other file consumes ONLY these
// resolved objects (frame/capabilities/parameterSchema) — never the id
// strings — per Phase 2's no-branching-on-type.id rule.
//const RESOLVED_ENGINE_LAYOUT = (typeof getComponentType === 'function') ? getComponentType(ACTIVE_VEHICLE.engineTypeId) : null;
//const RESOLVED_RECOVERY_TYPE = (typeof getComponentType === 'function') ? getComponentType(ACTIVE_VEHICLE.recoveryTypeId) : null;
//const RESOLVED_RCS_TYPE = (typeof getComponentType === 'function') ? getComponentType(ACTIVE_VEHICLE.rcsTypeId) : null;
const RESOLVED_ENGINE_LAYOUT = (typeof getComponentType === 'function') ?
  getComponentType(ACTIVE_VEHICLE_FOR_HARDWARE.engineTypeId) : null;
const _recoveryDisabled = ACTIVE_VEHICLE_FOR_HARDWARE.hasRecovery === false;
const RESOLVED_RECOVERY_TYPE = (!_recoveryDisabled && typeof getComponentType === 'function') ?
  getComponentType(ACTIVE_VEHICLE_FOR_HARDWARE.recoveryTypeId) : null;
const RESOLVED_RCS_TYPE = (typeof getComponentType === 'function') ?
  getComponentType(ACTIVE_VEHICLE_FOR_HARDWARE.rcsTypeId) : null;


const CONFIG = {
  
  // ---------------- Universal / Earth ----------------
  EARTH_RADIUS: 6371000, // m
  GM_EARTH: 3.986004418e14, // m^3/s^2
  
  // Earth rotation — sidereal day, rad/s. Real value: 2π / 86164.0905 s.
  EARTH_OMEGA: 7.2921159e-5, // rad/s
  
  // Where on the Earth circle the launch site sits, measured CCW from
  // the +y axis (i.e. "up" at t=0). Change this to move the site around
  // the planet — the pad, gravity turn, and initial velocity all follow.
  LAUNCH_SITE_ANGLE_0: 0, // rad
  GM_EARTH: 3.986004418e14, // m^3/s^2  (standard gravitational parameter)
  SEA_LEVEL_DENSITY: 1.225, // kg/m^3
  SCALE_HEIGHT: 8500, // m (exponential atmosphere model)
  // Launch-site altitude above sea level (m). 0 = sea-level pad (current
  // default). Change this when a launch site sits on elevated terrain:
  // physics uses it for the ground-contact check, and the render frame
  // shifts its local origin so the pad still reads as y_local = 0.
  LAUNCH_SITE_ALTITUDE: 0,
  
  // ---------------- Orbit regimes (altitude ASL, km) ----------------
// Standard Earth-orbit classification boundaries. Bands are half-open:
// [MIN, MAX) — low edge inclusive, high edge exclusive. GEO is a
// specific altitude (period = one sidereal day), not a band.
LEO_MIN_KM:  160,
LEO_MAX_KM:  2000,
MEO_MIN_KM:  2000,
MEO_MAX_KM:  35786,
GEO_ALT_KM:  35786,
  
  // ---------------- Vehicle geometry & mass ----------------
  ROCKET_NAME: ACTIVE_STACK_AGG ? ACTIVE_STACK_AGG.name : ACTIVE_VEHICLE.name,
  ROCKET_HEIGHT: ACTIVE_STACK_AGG ? ACTIVE_STACK_AGG.height : ACTIVE_VEHICLE.height,
  ROCKET_WIDTH: ACTIVE_STACK_AGG ? ACTIVE_STACK_AGG.width : ACTIVE_VEHICLE.width,
  DRY_MASS: ACTIVE_STACK_AGG ? ACTIVE_STACK_AGG.dryMass : ACTIVE_VEHICLE.dryMass,
  FUEL_MASS_MAX: ACTIVE_STACK_AGG ? ACTIVE_STACK_AGG.fuelMass : ACTIVE_VEHICLE.fuelMassMax,
  DEFAULT_FUEL_FRACTION: 1.00,
  
  
  // ---------------- Main engines (octaweb, 2D projection) ----------------
  OCTA_RADIUS: ACTIVE_VEHICLE.params.octaRadius, // m — radius of the 8 outer engines
  // A2 CLEANUP: ENGINE_F_MAX kept — still read by home.js's spec sheet.
  // ENGINE_F_MIN_FRAC removed — verified zero reads anywhere (the actual
  // per-engine floor now lives on each engine object as minMassFlowRate,
  // sourced from its thruster type's minThrottleFrac in vehicle.js).
  ENGINE_F_MAX: ACTIVE_VEHICLE.params.engineFMax, // N per engine
  ENGINE_VE: ACTIVE_VEHICLE.params.engineVe, // m/s exhaust velocity
  ENGINE_THRUST_RATE: ACTIVE_VEHICLE.params.engineThrustRate, // max change rate, fraction of F_MAX per second
  GIMBAL_MAX_DEG: ACTIVE_VEHICLE.params.gimbalMaxDeg, // ± degrees (gimbal-capable engines)
  GIMBAL_RATE_DEG_S: ACTIVE_VEHICLE.params.gimbalRateDegS, // deg/sec max slew rate
  
  // ---------------- RCS (4 advanced pods) ----------------
  RCS_THRUST: ACTIVE_VEHICLE.params.rcsThrust, // N, fixed magnitude per nozzle
  RCS_VE: ACTIVE_VEHICLE.params.rcsVe, // m/s
  RCS_X_OFFSET: ACTIVE_VEHICLE.params.rcsXOffset, // m from centerline
  RCS_TOP_Y: ACTIVE_VEHICLE_FOR_HARDWARE.params.rcsTopY, // m, base se upar
  RCS_BOTTOM_Y: ACTIVE_VEHICLE_FOR_HARDWARE.params.rcsBottomY, // m, base se upar
  RCS_PWM_PERIOD: ACTIVE_VEHICLE.params.rcsPwmPeriod, // s, duty-cycle period for the far-arm pod
  
  // ---------------- Aerodynamics ----------------
  DRAG_CD: ACTIVE_VEHICLE.dragCd, // dimensionless, orientation-independent (Phase-1 simplification)
  
  // ---------------- Landing legs ----------------
  LEG_DEPLOY_RATE: ACTIVE_VEHICLE.params.legDeployRate || 0.5, // fraction of full travel per second
  
  // ---------------- Resolved hardware TYPES ----------------
  ENGINE_LAYOUT: RESOLVED_ENGINE_LAYOUT,
  RECOVERY_TYPE: RESOLVED_RECOVERY_TYPE,
  RCS_TYPE: RESOLVED_RCS_TYPE,
  
  
  
  // ---------------- Landing safety envelope ----------------
  // A touchdown only counts as a LANDING if all of these hold; otherwise
  // it's a crash. Kept as fixed, generous "don't break the hardware"
  // numbers rather than per-vehicle tuned values.
  LANDING_MIN_LEG_DEPLOY: 0.9, // legs.progress must be at least this deployed
  LANDING_MAX_VSPEED: 5, // m/s, max safe descent rate
  LANDING_MAX_HSPEED: 2.5, // m/s, max safe lateral speed at touchdown
  LANDING_MAX_TILT_DEG: 12, // ± degrees off local vertical
  LANDING_MAX_OMEGA: 0.15, // rad/s, max safe spin rate at touchdown
  
  // Legs cannot be COMMANDED to deploy while the vehicle is still climbing
  // (powered ascent right off the pad) or moving faster than this, so they
  // can't be ripped open during launch or a fast reentry. Stowing is always
  // allowed. See legDeploySafety() in controls.js.
  LEG_DEPLOY_MAX_SPEED: 100, // m/s
  
  
  // ---------------- Stage builder (Phase 3) ----------------
  // Constants used by the 'stage' record builder flow (rockets.js) —
  // fuel-tank sizing, feasibility, and payload-capacity math. Every value
  // here is a PLACEHOLDER per the "dummy value first" philosophy
  // (PHASE3_PROMPT.md §1.12): the pipeline/framework consumes them exactly
  // where a real derived formula will eventually go, so dropping in that
  // formula later means editing only this block — no caller changes.
  
  // Fraction of a stage's fuel-tank cylinder volume that becomes metal
  // shell, used to estimate body mass: bodyMass = tankVolume ×
  // BODY_SHELL_FACTOR × bodyMetalDensity. Placeholder number calibrated
  // roughly against Falcon-9-class tankage; not yet a real structural model.
  BODY_SHELL_FACTOR: 0.0165,
  
  // Target Δv budget a 'stage' design is sized against, feeding the
  // Tsiolkovsky capacity calc: D = fuelMass / (e^(ΔV/effectiveVe) − 1).
  // Gravity losses are currently absorbed into this single placeholder
  // (PHASE3_PROMPT.md §1.12) rather than tracked as a separate term.
  SECOND_STAGE_TARGET_DELTA_V: 4500, // m/s
  
  // Minimum liftoff thrust-to-weight ratio a stage must sustain to be
  // considered feasible. Used to derive the thrust-limited max payload:
  // totalEngineThrust ≥ MIN_TWR_FLOOR × (dryMassNoPayload + payload) × g.
  // (Renamed clarity-wise per PHASE3_PROMPT.md §1.2; the underlying "min
  // thrust per kg" idea is unchanged.)
  MIN_TWR_FLOOR: 1.2,
  
  // Hard cap on a bulgedCapShape payload-space's bulge diameter, expressed
  // as a ratio against the stage's own fuel-tank diameter:
  // bulgeDiameter ≤ MAX_BULGE_DIAMETER_RATIO × fuelTankDiameter. Keeps the
  // silhouette from ballooning beyond a plausible real-fairing proportion.
  MAX_BULGE_DIAMETER_RATIO: 1.4,
  
  
  
// ---------------- Fairing parachute recovery ----------------
// Altitude (m, AGL) below which a fairing-half or emergency-ejected
// shielded body auto-deploys its parachute. Same trigger for every
// chute-equipped body — normal Split Fairing halves AND Emergency
// Eject packages. No manual button; deployment is automatic.
FAIRING_CHUTE_DEPLOY_ALT_AGL_M: 1500,
  
// ---------------- Simulation ----------------
DT: 1 / 80, // s, fixed physics timestep,
  
  // ---------------- Stage separation (pneumatic pushers) ----------------
  // Real F9 uses N2/helium pneumatic pushers in the interstage — not RCS —
  // to push the lower body away after MECO. This sim models them as a
  // constant acceleration applied to the DISCARDED body along its own
  // local tail direction (-Y in body frame) for a short window.
  //
  //   SEPARATION_ACC_CONST       m/s² applied to the discarded body
  //   SEPARATION_PUSH_DURATION_S window length, seconds
  //
  // Product = velocity gain. Default 6.0 × 1.0 = 6 m/s relative kick —
  // matches the 3–5 m/s range real F9-class pushers deliver. Not
  // propellant-consuming; pusher mass and gas budget are ignored.
  SEPARATION_ACC_CONST: 2.5,
  SEPARATION_PUSH_DURATION_S: 1.0,
  // ---------------- Fuel slosh (Phase 2A) ----------------
  // A single lateral slosh oscillator on the body's BOTTOM tank only.
  // 2A uses fixed constants; Phase 2B replaces SLOSH_OMEGA/SLOSH_ZETA with
  // per-tank values derived from Abramson's formulas (tank radius + fill
  // level), and Phase 2C adds a baffle damping bonus on top. This block
  // stays as the fallback used whenever a real derivation isn't available
  // (e.g. a member with no tank geometry yet).
  SLOSH_ENABLED: true,
  SLOSH_OMEGA: 1.6, // rad/s — 2A fixed value; 2B uses this only as a FALLBACK
  // when a body has no usable tank geometry (see bottomTankSloshOmega() in
  // physics.js). No longer the everyday value once 2B.1 lands.
  SLOSH_ZETA: 0.03, // fallback damping ratio — 2B.3 replaces this as the
  // everyday value with per-tank boundary-layer damping
  // (bottomTankSloshZeta() in physics.js); stays as the fallback used
  // whenever real tank geometry/frequency aren't available, same role
  // SLOSH_OMEGA plays for frequency.
  SLOSH_MASS_FRACTION: 0.27, // fallback fraction, same role as SLOSH_OMEGA above — now used only when h/R can't be derived (see sloshMassFraction() in massProps.js, Phase 2B.2)
  SLOSH_SUBSTEPS: 4, // Euler substeps per physics tick, for ω·dt stability headroom
  // Phase 2B.1 — first antisymmetric sloshing-mode eigenvalue (Abramson /
  // NASA SP-106) for an upright cylindrical tank. Standard textbook value;
  // not something a designer/fuel-type would ever override, so it lives
  // here as a named constant rather than hardcoded in the formula.
  SLOSH_LAMBDA1: 1.841,
  // Phase 2B.3 — representative kinematic viscosity feeding the boundary-
  // layer damping formula (bottomTankSloshZeta() in physics.js). Real
  // viscosity depends on which propellant is loaded, but this codebase
  // already treats fuel as one averaged "RP-1/LOX" density rather than
  // modeling each propellant separately (see componentLibrary.js's
  // buildFuelRp1Lox) — same simplification here. 1e-6 m²/s sits between
  // LOX's (~1.9e-7 m²/s) and RP-1's (~2.5e-6 m²/s) kinematic viscosity at
  // typical propellant temperatures.
  SLOSH_KINEMATIC_VISCOSITY: 1e-6, // m²/s
    // Hard ceiling on the derived damping ratio. Abramson's boundary-layer
  // formula diverges as fill height → 0 (a near-empty tank is essentially
  // all boundary layer, directionally correct but unbounded) — clamped
  // here rather than letting a near-critical/overdamped ratio reach the
  // Euler integrator right as a stage runs dry.
    SLOSH_ZETA_MAX: 0.5,
    // Phase 2C — geometric baffle damping calibration. The per-baffle
    // damping contribution is:
    //     ζ_1 = SLOSH_BAFFLE_DAMPING_COEF × (1 - baffleInnerRadiusFrac)
    // and total baffle damping is ζ_1 × baffleCount, added on top of the
    // boundary-layer ζ. The coefficient is a PLACEHOLDER calibrated so that
    // the previous fixed constant (SLOSH_BAFFLE_ZETA = 0.10) is reproduced
    // for the default baffled-tank geometry — 4 baffles at 0.8 inner-radius
    // fraction gives 0.125 × 4 × 0.2 = 0.10. Real baffled tanks run ζ ≈
    // 0.10–0.15 (Abramson / NASA SP-106); refining this coefficient against
    // real slosh-test data is future work.
    SLOSH_BAFFLE_DAMPING_COEF: 0.125,
  

};