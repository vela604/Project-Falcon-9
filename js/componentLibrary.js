// ============================================================================
// componentLibrary.js — Shared data layer for the Components Library
// (Technology Bay). This is the registry of reusable HARDWARE MODULE
// *types* — engine layouts, recovery mechanisms, RCS arrangements — kept
// completely separate from any specific rocket's configuration (that lives
// in fleet.js). A rocket record just references a type by id plus the
// numeric parameter values that type's schema calls for; it never repeats
// the type's structure.
//
// DESIGN RULE: nothing outside this file (and its seed data below) may ever
// branch on a type's `id` string. Sim/render code only ever reads the
// RESOLVED `frame` / `capabilities` data — a brand-new type is just a new
// registry entry, no other file should need to change.
//
// Loaded BEFORE fleet.js/config.js everywhere it's needed, localStorage-
// backed exactly like fleet.js.
// ============================================================================

const COMPONENT_LIBRARY_KEY = 'rocketSim.componentLibrary.v1';

// Standard gravitational acceleration — physical constant, used by the
// thruster-mass formula (mass = thrust / (TWR × G0)). Not a tunable
// design value, so it lives here rather than in config.js.
const G0 = 9.80665; // m/s²
// Phase 3/4 shared design constants. These live at top-level (not only on
// CONFIG) because fleet.js's stage/booster derived-mass functions are
// called *from* config.js at load time — before CONFIG itself exists.
// Having them here breaks the circular dependency.
const BODY_SHELL_FACTOR = 0.0165;
const SECOND_STAGE_TARGET_DELTA_V = 4500;
const MIN_TWR_FLOOR = 1.2;
const MAX_BULGE_DIAMETER_RATIO = 1.4;
// ---------------------------------------------------------------------------
// Small geometry helper used by "ringWithCenter" engine-layout frames: given
// a slot COUNT evenly spaced starting at startDeg, generate the outer-ring
// slot list. This is the generic replacement for vehicle.js's hardcoded
// `angles = [0,45,90,...]` — any ring size works, not just 8.
// ---------------------------------------------------------------------------
function ringSlots(count, startDeg) {
  startDeg = startDeg || 0;
  const step = 360 / count;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const deg = (startDeg + i * step) % 360;
    slots.push({
      id: 'E' + deg,
      role: 'outer',
      gimbalCapable: false,
      angleDeg: deg,
      position: (R) => ({ x: R * Math.cos(deg * Math.PI / 180) }),
    });
  }
  return slots;
}

// Derive the symmetric (180°-opposite) and asymmetric (same-|x|, i.e. same
// lateral projection) merge topology for any ring of evenly-spaced outer
// slots — the generalized version of vehicle.js's defaultPairGroups() +
// the asymmetric-merge validation rule in mergeGroups().
function ringMergeTopology(slots) {
  const byAngle = {};
  slots.forEach(s => { byAngle[s.angleDeg] = s; });
  const seen = new Set();
  const symmetric = [];
  slots.forEach(s => {
    const opp = (s.angleDeg + 180) % 360;
    const key = [s.angleDeg, opp].sort((a, b) => a - b).join(',');
    if (byAngle[opp] && s.angleDeg !== opp && !seen.has(key)) {
      seen.add(key);
      symmetric.push([s.id, byAngle[opp].id]);
    }
  });
  const seenA = new Set();
  const asymmetric = [];
  slots.forEach(s => {
    slots.forEach(t => {
      if (s === t) return;
      const key = [s.id, t.id].sort().join(',');
      if (seenA.has(key)) return;
      const xa = Math.cos(s.angleDeg * Math.PI / 180);
      const xb = Math.cos(t.angleDeg * Math.PI / 180);
      if (Math.abs(Math.abs(xa) - Math.abs(xb)) < 1e-6 && Math.sign(xa) === Math.sign(xb) && s.angleDeg !== t.angleDeg) {
        seenA.add(key);
        asymmetric.push([s.id, t.id]);
      }
    });
  });
  return { symmetric, asymmetric };
}

function buildOctaweb9() {
  const outer = ringSlots(8, 0);
  return {
    id: 'octaweb-merlin9',
    category: 'engineLayout',
    kind: 'ringWithCenter',
    displayName: 'Octaweb (Merlin-class, 8+1)',
    description: 'One gimbaling center engine surrounded by a ring of 8 fixed outer engines at 45° spacing — the current Falcon-9-class layout. Performance (thrust, Ve, gimbal, throttle) comes from the thruster type(s) selected per gimbalCapable group; this type declares only geometry.',
    frame: {
      slots: [
        { id: 'C', role: 'center', gimbalCapable: true, angleDeg: null, position: () => ({ x: 0 }) },
        ...outer,
      ],
      mergeTopology: ringMergeTopology(outer),
    },
    // STEP B: only geometry remains here. Per-engine thrust/Ve/gimbal/throttle
    // keys moved to the `thruster` category — a fleet record now references
    // one thruster type per distinct `gimbalCapable` group (see §2.2 and
    // fleet.js's engineThrusterGroups()).
    parameterSchema: [
      { key: 'octaRadius', label: 'Ring radius (R)', unit: 'm', min: 0.1 },
    ],
    capabilities: { sharedGimbalSlider: true, throttleGrouping: true },
  };
}


function buildSingleNozzleVac() {
  return {
    id: 'single-nozzle-vac',
    category: 'engineLayout',
    kind: 'ringWithCenter',
    displayName: 'Single Nozzle (vacuum-class)',
    description: 'A single gimbaling vacuum-optimized engine at the base — no outer ring. Typical of an upper stage.',
    frame: {
      slots: [
        { id: 'C', role: 'center', gimbalCapable: true, angleDeg: null, position: () => ({ x: 0 }) },
      ],
      mergeTopology: { symmetric: [], asymmetric: [] },
    },
    // No geometry parameters — single engine sits on the axis. Ring radius
    // is meaningless here (octaweb-only concept).
    parameterSchema: [],
    capabilities: { sharedGimbalSlider: true, throttleGrouping: false },
  };
}

function buildLegsSwingout4() {
  return {
    id: 'legs-swingout-4',
    category: 'recoveryMechanism',
    kind: 'legsOnVehicle',
    displayName: 'Swing-Out Landing Legs (×4)',
    description: 'Four hinged legs mounted on the vehicle itself, folded flush against the airframe in flight and swung open before touchdown — the current Falcon-9-class recovery hardware.',
    frame: {
      legCount: 4,
      hingeGeometry: (H) => ({
        hingeY: -H * 0.004,
        legLength: H * 0.27,
        maxSweepRad: 125 * Math.PI / 180,
        pistonMountY: -H * 0.08,
      }),
      // STEP B / §2.6: one leg's approximate metal volume — placeholder-
      // precision silhouette (thin tapered strut with lightening cutouts
      // folded in via a fill factor), same "dummy value first" philosophy as
      // payloadSpace's volume formulas. Legs are made of the SAME metal as
      // the body (confirmed §1.15), so this is multiplied by body-metal
      // density downstream.
      structuralVolume: (H, W) => {
        const legLength = 0.27 * H;
        const avgThickness = 0.05 * W;
        const avgDepth = 0.04 * W;
        const fillFactor = 0.4; // internal cutouts
        return legLength * avgThickness * avgDepth * fillFactor;
      },
      landingMinDeploy: 0.9,
    },
    parameterSchema: [
      { key: 'legDeployRate', label: 'Deploy rate', unit: '/s', min: 0.05 },
    ],
    capabilities: { vehicleTouchesGround: true, deploysOnVehicle: true, requiresGroundCatcher: false },
  };
}

// Second "kind" in the SAME recoveryMechanism category — proves the
// category isn't tied to any one mechanism shape. Not yet consumed by the
// simulator (that needs a matching ground-tower "catch arms" component,
// noted as future "Ground Support / Tower" category work), but it
// demonstrates the schema handles a structurally different recovery
// concept (no moving parts on the vehicle at all) without special-casing.
function buildCatchFitting2Pin() {
  return {
    id: 'catch-fitting-2pin',
    category: 'recoveryMechanism',
    kind: 'catchFittingOnVehicle',
    displayName: 'Catch-Fitting Pins (×2)',
    description: 'Starship/Super-Heavy-style: no legs at all. The vehicle carries only two fixed catch-pin attachment points; a ground-tower catch-arm mechanism (separate "Ground Support" component, not modeled yet) does the actual catching.',
    frame: {
      fittingPositions: (H) => [{ y: -H * 0.82 }, { y: -H * 0.80 }],
    },
    parameterSchema: [
      { key: 'maxCatchLoadN', label: 'Max catch load', unit: 'N', min: 1000 },
    ],
    capabilities: { vehicleTouchesGround: false, deploysOnVehicle: false, requiresGroundCatcher: true },
  };
}

function buildRcs4Pod2Nozzle() {
  return {
    id: 'rcs-4pod-2nozzle',
    category: 'rcsArrangement',
    kind: 'cornerPods',
    displayName: '4-Corner RCS Pods (2 nozzles/pod)',
    description: 'Four pods at the top/bottom-left/right corners of the airframe, each with one lateral (outward) and one vertical (along-hull) fixed-direction nozzle. Per-nozzle thrust/Ve come from the rcsThruster type; this type declares only pod layout + timing.',
    frame: {
      pods: [
        { id: 'TL', corner: [-1, 'top'] },
        { id: 'TR', corner: [1, 'top'] },
        { id: 'BL', corner: [-1, 'bottom'] },
        { id: 'BR', corner: [1, 'bottom'] },
      ],
      nozzlesPerPod: 2,
    },
    // STEP B: rcsThrust/rcsVe removed — those come from `rcsThruster` type.
    parameterSchema: [
      { key: 'rcsTopY', label: 'Top pods height (from base)', unit: 'm', min: 0 },
      { key: 'rcsBottomY', label: 'Bottom pods height (from base)', unit: 'm', min: 0 },
      { key: 'rcsXOffset', label: 'Lateral offset', unit: 'm', min: 0.1 },
      { key: 'rcsPwmPeriod', label: 'PWM period', unit: 's', min: 0.02 },
    ],
    capabilities: { sharedGimbalSlider: false, throttleGrouping: false },
  };
}

// ============================================================================
// PHASE 3 STEP A — four new "fixed real-world spec" categories, plus
// payloadSpace (2 kinds).
//
// IMPORTANT DIFFERENCE from every category before this one: engineLayout /
// recoveryMechanism / rcsArrangement types declare STRUCTURE only — their
// parameterSchema lists which numbers a rocket/stage build will need to
// supply, but never a value itself (that's filled in per-build). thruster /
// rcsThruster / fuel / metal are the opposite: every key each one declares
// is a FIXED, real-world spec of that named hardware/material — "Merlin-1D
// class" HAS a Ve, an efficiency, a gimbal range, etc., the same way a real
// engine datasheet does. NONE of that is fleet-editable. The only build-time
// choice for a thruster/rcsThruster is a separate mass-flow-rate field (not
// part of this schema at all, bounded by the type's own fixed
// maxMassFlowRate) — see PHASE3_PROMPT.md §2.1/2.3/§4.
//
// withFixedValues()/makeThruster()/makeRcsThruster()/makeFuel()/makeMetal()
// below are the generic "maker" pattern for this: a shared schema SHAPE per
// kind (label/unit/min/max, still used by the Components Library page's
// display table exactly like every other category) plus a values bag that
// gets stamped onto it. Adding a second engine — say a smaller vacuum-
// optimized thruster — is just another makeThruster(...) call with its own
// id/displayName/values, zero changes anywhere else, same as every other
// registry category in this file.
//
// Performance categories (thruster, rcsThruster) deliberately have NO
// `frame` at all — they aren't placed/shaped in space themselves, they're
// plugged into an engineLayout's or rcsArrangement's slots, which is where
// the geometry lives.
// ============================================================================

// Stamps a {key: value} bag onto a schema's entries (adding a `value` field
// to each), after checking the bag exactly matches the schema's own keys —
// a missing or unrecognized key throws immediately. This is a build-time-
// only sanity check (runs once, when the seed registry is built), so a
// typo'd key fails loudly at load time instead of silently shipping an
// "undefined" spec for some type.
function withFixedValues(schema, values) {
  const missing = schema.filter(p => !(p.key in values)).map(p => p.key);
  if (missing.length) throw new Error(`withFixedValues: missing fixed value(s) for key(s): ${missing.join(', ')}`);
  const extra = Object.keys(values).filter(k => !schema.some(p => p.key === k));
  if (extra.length) throw new Error(`withFixedValues: value(s) given for key(s) not in schema: ${extra.join(', ')}`);
  return schema.map(p => ({ ...p, value: values[p.key] }));
}

// Schema SHAPES, one per (category, kind) — shared by every concrete type
// of that kind, exactly like frame-building helpers (ringSlots, etc.) are
// shared by every concrete engineLayout. Only 'chemical' exists today for
// thruster; a future 'electric'/ion kind would get its own shape here and
// its own makeThruster-style call, per the same kind-discriminator pattern
// already used elsewhere (e.g. rcs.js branching on RCS `kind`).
const THRUSTER_CHEMICAL_SCHEMA = [
  { key: 've', label: 'Exhaust velocity', unit: 'm/s', min: 500 },
  { key: 'efficiency', label: 'Efficiency', unit: 'frac', min: 0.1, max: 1 },
  { key: 'twr', label: 'Thrust-to-weight ratio', unit: 'ratio', min: 10, max: 500 },
  { key: 'maxMassFlowRate', label: 'Max mass flow rate', unit: 'kg/s', min: 0.1 },
  { key: 'gimbalCapable', label: 'Gimbal capable', unit: 'bool' },
  { key: 'gimbalMaxDeg', label: 'Gimbal range', unit: 'deg', min: 0, max: 45 },
  { key: 'gimbalRateDegS', label: 'Gimbal slew rate', unit: 'deg/s', min: 1 },
  { key: 'minThrottleFrac', label: 'Throttle floor', unit: 'frac', min: 0, max: 0.95 },
  { key: 'maxThrottleRateFrac', label: 'Throttle change rate', unit: '/s', min: 0.01 },
];

function makeThruster(id, displayName, description, values) {
  return {
    id,
    category: 'thruster',
    kind: 'chemical',
    displayName,
    description,
    parameterSchema: withFixedValues(THRUSTER_CHEMICAL_SCHEMA, values),
  };
}

// A thruster type is a FIXED performance profile (Ve, efficiency, gimbal
// envelope, throttle envelope) that an engineLayout slot group references.
// At rocket-build time, only mass flow rate is chosen (≤ maxMassFlowRate);
// thrust and engine mass both derive from that (see PHASE3_PROMPT.md §1
// formulas) — nothing here is itself a build-time-editable number.
//
// Values below reproduce today's Falcon-9-class octaweb defaults exactly
// (config.js's DEFAULT_VEHICLE: engineFMax 600,000 N @ engineVe 2,900 m/s
// → maxMassFlowRate = 600,000 / 2,900 ≈ 207 kg/s; gimbal ±20° @ 40°/s;
// throttle floor 40%, change rate 0.5/s), so wiring a fleet build to this
// type later (Step D/E) won't shift any existing vehicle's numbers.
// `efficiency` has no such anchor yet — it's a placeholder pending the real
// engine-mass formula refinement noted in PHASE3_PROMPT.md §1.12.
function buildThrusterMerlin1DClass() {
  return makeThruster(
    'merlin-1d-class',
    'Merlin-1D class',
    'Fixed-performance chemical engine type. Ve, efficiency, gimbal range/rate, and throttle floor/rate are all locked in by the type — a rocket build only ever chooses a mass flow rate (≤ this type\'s max), which determines thrust and engine mass.',
    {
      ve: 2900,
      efficiency: 0.9,
      twr: 184,
      maxMassFlowRate: 500,
      gimbalCapable: true,
      gimbalMaxDeg: 20,
      gimbalRateDegS: 40,
      minThrottleFrac: 0.4,
      maxThrottleRateFrac: 0.5,
    }
  );
}

// Same idea as thruster, but for RCS nozzles — an rcsArrangement's pods
// reference one of these instead of declaring rcsThrust/rcsVe directly
// (those keys move OUT of rcsArrangement's parameterSchema in Step B).
const RCS_THRUSTER_COLD_GAS_SCHEMA = [
  { key: 've', label: 'Exhaust velocity', unit: 'm/s', min: 100 },
  { key: 'efficiency', label: 'Efficiency', unit: 'frac', min: 0.1, max: 1 },
  { key: 'maxMassFlowRate', label: 'Max mass flow rate', unit: 'kg/s', min: 0.001 },
];

function makeRcsThruster(id, displayName, description, values) {
  return {
    id,
    category: 'rcsThruster',
    kind: 'coldGas',
    displayName,
    description,
    parameterSchema: withFixedValues(RCS_THRUSTER_COLD_GAS_SCHEMA, values),
  };
}

// Values reproduce today's RCS defaults exactly (config.js's DEFAULT_VEHICLE:
// rcsThrust 1,100 N @ rcsVe 2,200 m/s → maxMassFlowRate = 1,100 / 2,200 = 0.5
// kg/s per nozzle), same continuity reasoning as the main thruster above.
function buildRcsThrusterColdGasSmall() {
  return makeRcsThruster(
    'cold-gas-small',
    'Cold-gas thruster (small)',
    'Fixed-performance RCS nozzle type. Only mass flow rate is chosen per rocket build (≤ this type\'s max); thrust follows from it and the type\'s own Ve/efficiency.',
    {
      ve: 2200,
      efficiency: 0.9,
      maxMassFlowRate: 0.5,
    }
  );
}

// A fuel type declares only propellant density — tank dimensions (and
// therefore fuel mass) are chosen per rocket/stage build.
const FUEL_LIQUID_SCHEMA = [
  { key: 'propellantDensity', label: 'Propellant density', unit: 'kg/m3', min: 100 },
];

function makeFuel(id, displayName, description, values) {
  return {
    id,
    category: 'fuel',
    kind: 'liquid',
    displayName,
    description,
    parameterSchema: withFixedValues(FUEL_LIQUID_SCHEMA, values),
  };
}

// 1,030 kg/m³ — a representative combined RP-1 (~810 kg/m³) + LOX
// (~1,141 kg/m³) average density, the standard simplification for treating
// a bipropellant tank's contents as one effective propellant density.
function buildFuelRp1Lox() {
  return makeFuel(
    'rp1-lox',
    'RP-1 / LOX',
    'Propellant type. Declares ONLY propellant density — tank size (and therefore fuel mass) is decided per rocket/stage build. Baffle hardware (count + inner-radius fraction) is a TANK-hardware property, chosen per vehicle on the fuel-tank fieldset, not a property of the propellant itself. Unbaffled tanks rely on the wall boundary layer alone for slosh damping (Abramson, ζ ~ 1e-4 for large tanks — barely any damping).',
    { propellantDensity: 1080 }
  );
}



// A metal type declares only density — used for body shell, legs (same
// metal as the body, no separate legs-metal field), and payload-space
// container mass (which can pick its OWN, different metal type).
const METAL_ALLOY_SCHEMA = [
  { key: 'density', label: 'Density', unit: 'kg/m3', min: 500 },
];

function makeMetal(id, displayName, description, values) {
  return {
    id,
    category: 'metal',
    kind: 'alloy',
    displayName,
    description,
    parameterSchema: withFixedValues(METAL_ALLOY_SCHEMA, values),
  };
}

// 2,700 kg/m³ — a representative aluminium-lithium alloy density (real
// Al-Li alloys such as 2195 run roughly 2,600–2,780 kg/m³, noticeably
// lighter than a standard aluminium airframe alloy like 2024 at ~2,780).
function buildMetalAlLiAlloy() {
  return makeMetal(
    'al-li-alloy',
    'Aluminium-Lithium alloy',
    'Structural metal type. Declares only density — used to derive body-shell, legs, and payload-space-container mass from whatever volume those structures work out to.', { density: 2700 }
  );
}

// payloadSpace: unlike the four pure-performance categories above, this
// DOES have a frame — it's a physical container with its own geometry.
// Two kinds in the same category (proving it isn't tied to one silhouette,
// same pattern as recoveryMechanism's two kinds): a simple nose cap sized
// to match the stage's own body width, and a wider "bulged" fairing that
// pokes out past it. structuralVolume/internalVolume are deliberately
// FORMULAS (functions of the type's own dimension keys, not stored
// numbers) — placeholder-precision silhouette approximations for now (see
// PHASE3_PROMPT.md §1.12's "dummy value first" approach); the shape of the
// formula (inputs -> volume) is what's load-bearing here, not the exact
// coefficients, which can be refined later without touching anything that
// calls these.
function buildPayloadSpaceNoseCap() {
  return {
    id: 'cap-standard',
    category: 'payloadSpace',
    kind: 'noseCapShape',
    displayName: 'Standard nose cap',
    description: 'Simple cone-shaped payload container sized to the stage\'s own body width — no bulge past it.',
    frame: {
      structuralVolume: (capHeight, capWidth) => {
        const r = capWidth / 2;
        const slant = Math.sqrt(r * r + capHeight * capHeight);
        const lateralArea = Math.PI * r * slant; // cone lateral surface
        const shellThicknessFrac = 0.01; // thin-shell approximation
        return lateralArea * (r * shellThicknessFrac);
      },
      internalVolume: (capHeight, capWidth) => {
        const r = capWidth / 2;
        return (1 / 3) * Math.PI * r * r * capHeight; // cone volume
      },
    },
    parameterSchema: [
      { key: 'capHeight', label: 'Cap height', unit: 'm', min: 0.2 },
      { key: 'capWidth', label: 'Cap base width', unit: 'm', min: 0.2 },
    ],
  };
}

function buildPayloadSpaceBulged() {
  return {
    id: 'cap-bulged',
    category: 'payloadSpace',
    kind: 'bulgedCapShape',
    displayName: 'Bulged payload fairing',
    description: 'Wider fairing-style payload container that bulges out past the stage\'s own body width, tapering back to a point at the nose. Bulge diameter gets capped relative to the stage\'s own fuel-tank diameter at build time (MAX_BULGE_DIAMETER_RATIO), not here.',
    frame: {
      // Simplified silhouette: bottom 60% of the height is a cylinder at
      // the bulge radius, top 40% tapers to a point — a reasonable
      // fairing-like shape, not a modeled aerodynamic profile.
      structuralVolume: (capHeight, capWidth, bulgeWidth) => {
        const rBulge = bulgeWidth / 2;
        const coneH = capHeight * 0.4,
          cylH = capHeight * 0.6;
        const coneSlant = Math.sqrt(rBulge * rBulge + coneH * coneH);
        const lateralArea = Math.PI * rBulge * coneSlant + 2 * Math.PI * rBulge * cylH;
        const shellThicknessFrac = 0.01;
        return lateralArea * (rBulge * shellThicknessFrac);
      },
      internalVolume: (capHeight, capWidth, bulgeWidth) => {
        const rBulge = bulgeWidth / 2;
        const coneH = capHeight * 0.4,
          cylH = capHeight * 0.6;
        return (1 / 3) * Math.PI * rBulge * rBulge * coneH + Math.PI * rBulge * rBulge * cylH;
      },
    },
    parameterSchema: [
      { key: 'capHeight', label: 'Cap height', unit: 'm', min: 0.2 },
      { key: 'capWidth', label: 'Cap base width', unit: 'm', min: 0.2 },
      { key: 'bulgeWidth', label: 'Bulge width', unit: 'm', min: 0.2 },
      { key: 'frustumSlantDeg', label: 'Frustum slant (from base)', unit: 'deg', min: 15, max: 80 },
      { key: 'curveHeightFactor', label: 'Top curve height / bulgeR', unit: 'frac', min: 0.3, max: 1.5 },
    ],
  };
}

function seedComponentLibrary() {
  return [
    buildOctaweb9(),
    buildSingleNozzleVac(),
    buildLegsSwingout4(),
    buildCatchFitting2Pin(),
    buildRcs4Pod2Nozzle(),
    buildThrusterMerlin1DClass(),
    buildRcsThrusterColdGasSmall(),
    buildFuelRp1Lox(),
    
    buildMetalAlLiAlloy(),
    buildPayloadSpaceNoseCap(),
    buildPayloadSpaceBulged(),
  ];
}

// NOTE: functions can't survive JSON round-tripping, so what's persisted in
// localStorage is a plain-data STRIPPED copy (for any user-added custom
// types edited from the Components Library page); the built-in seed types
// above are always re-attached fresh (with their live formula functions
// intact) on every load, keyed by id, rather than ever being serialized.
function stripFunctions(type) {
  return JSON.parse(JSON.stringify(type, (k, v) => (typeof v === 'function' ? undefined : v)));
}

function loadComponentLibrary() {
  const seeded = seedComponentLibrary();
  let custom = [];
  try {
    const raw = localStorage.getItem(COMPONENT_LIBRARY_KEY);
    if (raw) custom = JSON.parse(raw).filter(t => !seeded.some(s => s.id === t.id));
  } catch (e) { /* ignore, start fresh */ }
  return [...seeded, ...custom];
}

function saveCustomComponentTypes(types) {
  const seededIds = seedComponentLibrary().map(t => t.id);
  const custom = types.filter(t => !seededIds.includes(t.id)).map(stripFunctions);
  localStorage.setItem(COMPONENT_LIBRARY_KEY, JSON.stringify(custom));
}

function getComponentType(id) {
  return loadComponentLibrary().find(t => t.id === id) || null;
}

function getComponentsByCategory(category) {
  return loadComponentLibrary().filter(t => t.category === category);
}


// Engine dry mass for a given thrust level: mass = thrust / (TWR × G0).
// Shared by rockets.js (live editor readout) and future stage-mass
// computation (Step E), so both agree on the same formula. Returns NaN if
// the thruster type doesn't declare a valid `twr` — caller should display
// "—" rather than a fake number.
function engineMassFromThrust(thrusterType, thrustN) {
  if (!thrusterType || !Number.isFinite(thrustN)) return NaN;
  const twrEntry = thrusterType.parameterSchema.find(p => p.key === 'twr');
  if (!twrEntry || !Number.isFinite(twrEntry.value) || twrEntry.value <= 0) return NaN;
  return thrustN / (twrEntry.value * G0);
}