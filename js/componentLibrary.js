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
    description: 'One gimbaling center engine surrounded by a ring of 8 fixed outer engines at 45° spacing — the current Falcon-9-class layout.',
    frame: {
      slots: [
        { id: 'C', role: 'center', gimbalCapable: true, angleDeg: null, position: () => ({ x: 0 }) },
        ...outer,
      ],
      mergeTopology: ringMergeTopology(outer),
    },
    parameterSchema: [
      { key: 'octaRadius', label: 'Ring radius (R)', unit: 'm', min: 0.1 },
      { key: 'engineFMax', label: 'Max thrust / engine', unit: 'N', min: 1000 },
      { key: 'engineFMinFrac', label: 'Throttle floor', unit: 'frac', min: 0, max: 0.95 },
      { key: 'engineVe', label: 'Exhaust velocity', unit: 'm/s', min: 500 },
      { key: 'engineThrustRate', label: 'Thrust change rate', unit: '/s', min: 0.01 },
      { key: 'gimbalMaxDeg', label: 'Gimbal range', unit: 'deg', min: 0, max: 45 },
      { key: 'gimbalRateDegS', label: 'Gimbal slew rate', unit: 'deg/s', min: 1 },
    ],
    capabilities: { sharedGimbalSlider: true, throttleGrouping: true },
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
    description: 'Four pods at the top/bottom-left/right corners of the airframe, each with one lateral (outward) and one vertical (along-hull) fixed-direction nozzle — the current Falcon-9-class RCS.',
    frame: {
      pods: [
        { id: 'TL', corner: [-1, 'top'] },
        { id: 'TR', corner: [1, 'top'] },
        { id: 'BL', corner: [-1, 'bottom'] },
        { id: 'BR', corner: [1, 'bottom'] },
      ],
      nozzlesPerPod: 2,
    },
    parameterSchema: [
      { key: 'rcsThrust', label: 'Nozzle thrust', unit: 'N', min: 10 },
      { key: 'rcsVe', label: 'Exhaust velocity', unit: 'm/s', min: 200 },
      { key: 'rcsXOffset', label: 'Lateral offset', unit: 'm', min: 0.1 },
      { key: 'rcsTopMargin', label: 'Top margin', unit: 'm', min: 0 },
      { key: 'rcsBottomMargin', label: 'Bottom margin', unit: 'm', min: 0 },
      { key: 'rcsPwmPeriod', label: 'PWM period', unit: 's', min: 0.02 },
    ],
    capabilities: { sharedGimbalSlider: false, throttleGrouping: false },
  };
}

function seedComponentLibrary() {
  return [
    buildOctaweb9(),
    buildLegsSwingout4(),
    buildCatchFitting2Pin(),
    buildRcs4Pod2Nozzle(),
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
