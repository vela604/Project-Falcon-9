// ============================================================================
// fleet.js — Shared data layer for the vehicle fleet (localStorage-backed).
// Loaded AFTER componentLibrary.js, BEFORE config.js everywhere, so
// config.js can pull the selected rocket's resolved-type + params into
// CONFIG. Also used directly by rockets.js (fleet management page) and
// home.js (fleet summary on the console).
//
// PHASE 2 SHAPE: a rocket record references its hardware TYPES by id
// (engineTypeId / recoveryTypeId / rcsTypeId — resolved against
// componentLibrary.js) plus a flat `params` bag of the numeric values that
// type's parameterSchema calls for. Universal fields (height/width/mass/
// dragCd) stay top-level since they don't belong to any one component type.
//
//   { id, name, locked,
//     height, width, dryMass, fuelMassMax, dragCd,
//     engineTypeId, recoveryTypeId, rcsTypeId,
//     params: { octaRadius, engineFMax, ..., rcsThrust, ... } }
//
// Older saved fleets (Phase 1's flat shape, everything top-level) are
// migrated automatically on load — see migrateRocketRecord() below.
// ============================================================================

function _fmtMassShort(kg) {
  if (!Number.isFinite(kg)) return '—';
  return kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg';
}

// Role-specific default body-shell factors, calibrated so a fresh record
// of each role lands on the Falcon-9-class real hardware's derived mass
// with essentially zero error:
//   booster       → 0.0178  (F9 Block 5 booster dry mass 25,600 kg, −0.1%)
//   stage         → 0.0147  (F9 Block 5 upper stage dry mass 3,900 kg)
//   payloadSpace  → 0.0026  (F9 carbon-composite fairing ~1,900 kg)
// A record can override its own value at build time (f-bodyShellFactor).
const DEFAULT_SHELL_FACTOR_BY_ROLE = {
  // Booster: shell factor calibrated so a F9 Block 5 booster's total dry
  // mass (shell + 9×Merlin + 4×carbon legs + carbon interstage) lands on
  // the real 25,600 kg with ~+0.02% error.
  booster: 0.01797,
  // Stage: shell factor calibrated so the F9 Block 5 upper stage's total
  // dry mass (shell + 1×MVac) lands on real 3,900 kg with ~+0.4% error.
  stage: 0.0147,
  // PayloadSpace: fairing-shell thickness fraction — 13.1 m tall × 5.2 m
  // bulge carbon-composite F9 fairing → ~1,906 kg (real ~1,900 kg).
  payloadSpace: 0.0026,
};

const FLEET_KEY = 'rocketSim.fleet.v1';
const SELECTED_KEY = 'rocketSim.selectedId.v1';


// ============================================================================
// PHASE 4 — Family model.
//
// A "family" is a top-level rocket program: exactly ONE bottom member
// (a 'booster', or a legacy 'rocket' that already has its own integrated
// nose) plus any number of 'stage' / 'nose' members attached to it.
// Members are always from the SAME family — cross-family mix is only a
// future "requested from another family" flow.
//
// A record's family is stored as `familyId` on the record itself; the family
// object only holds a bottomId (its mandatory booster/rocket member). This
// keeps membership as the fleet record's own property (survives load-order,
// no drift between two stores), while the family store acts as a lightweight
// registry of grouping + naming.
// ============================================================================
const FAMILIES_KEY = 'rocketSim.families.v1';
const SELECTED_FAMILY_KEY = 'rocketSim.selectedFamilyId.v1';
const LEGACY_FAMILY_ID = 'fam-falcon9-default'; // the seeded Falcon-9 record's family
const UNASSIGNED_FAMILY_ID = 'fam-unassigned'; // orphan stages/noses awaiting a booster

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
function loadFamiliesRaw() {
  try {
    const raw = localStorage.getItem(FAMILIES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* fall through */ }
  return [];
}

function saveFamilies(families) {
  localStorage.setItem(FAMILIES_KEY, JSON.stringify(families));
}

// Public loader — lazily seeds from current fleet state on first access so
// no page needs to call an explicit "migrate" hook. Idempotent: once
// families exist, this is a pure read.
function loadFamilies() {
  let families = loadFamiliesRaw();
  if (!families.length) families = seedFamiliesFromFleet();
  return families;
}

// ---------------------------------------------------------------------------
// First-time seed — non-destructive. Groups whatever's currently in the
// fleet into families per the confirmed rules:
//   - Falcon-9 default      → own family (LEGACY_FAMILY_ID), locked.
//   - User 'booster'        → own family, named "<booster> Family".
//   - User 'rocket' (legacy)→ own family, same as a booster.
//   - User 'stage' / 'nose' → shared UNASSIGNED_FAMILY_ID ("Unassigned
//                             Stages"), no bottom member yet. P4-B UI will
//                             let the user re-home these into a real family
//                             once a booster exists.
// ---------------------------------------------------------------------------
function seedFamiliesFromFleet() {
  const fleet = loadFleet();
  const families = [];
  const nowMembers = [];
  
  fleet.forEach(r => {
      // All three seeded F9 records belong to the same locked legacy family
      // (booster + stage + fairing). The family is pushed once, on the
      // booster — the stage/fairing just get their familyId set.
      if (r.id === 'falcon9-default' || r.id === 'falcon9-stage' || r.id === 'falcon9-fairing') {
        if (!families.some(f => f.id === LEGACY_FAMILY_ID)) {
          families.push({
            id: LEGACY_FAMILY_ID,
            name: 'Falcon-9-Class Family',
            bottomId: 'falcon9-default',
            locked: true,
          });
        }
        r.familyId = LEGACY_FAMILY_ID;
      } else if (r.stageRole === 'booster' || r.stageRole === 'rocket') {
      const fid = 'fam_' + r.id;
      families.push({
        id: fid,
        name: r.name + ' Family',
        bottomId: r.id,
        locked: false,
      });
      r.familyId = fid;
    } else if (r.stageRole === 'stage' || r.stageRole === 'nose') {
      r.familyId = UNASSIGNED_FAMILY_ID;
      nowMembers.push(r.id);
    } else {
      // Unknown / missing role — park it in the unassigned bucket.
      r.familyId = UNASSIGNED_FAMILY_ID;
      nowMembers.push(r.id);
    }
  });
  
  if (nowMembers.length) {
    families.push({
      id: UNASSIGNED_FAMILY_ID,
      name: 'Unassigned Stages',
      bottomId: null,
      locked: false,
    });
  }
  
  saveFamilies(families);
  saveFleet(fleet);
  return families;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
function genFamilyId() {
  return 'fam_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addFamily(data) {
  const families = loadFamilies();
  const rec = {
    id: genFamilyId(),
    name: (data && data.name ? String(data.name) : 'Unnamed Family').trim() || 'Unnamed Family',
    bottomId: (data && data.bottomId) || null, // fleet-record id of the booster/rocket
    locked: false,
  };
  families.push(rec);
  saveFamilies(families);
  return rec;
}

function updateFamily(id, patch) {
  const families = loadFamilies();
  const idx = families.findIndex(f => f.id === id);
  if (idx < 0) return null;
  families[idx] = { ...families[idx], ...patch, id };
  saveFamilies(families);
  return families[idx];
}

function deleteFamily(id) {
  // Guard: refuse to delete the Falcon-9 family or a family still holding
  // records. Callers must first move/delete members — this keeps the fleet
  // and family stores from drifting into orphaned states.
  const f = getFamily(id);
  if (!f || f.locked) return false;
  const orphans = loadFleet().filter(r => r.familyId === id);
  if (orphans.length) return false;
  saveFamilies(loadFamilies().filter(x => x.id !== id));
  if (getSelectedFamilyId() === id) setSelectedFamilyId(null);
  return true;
}

function getFamily(id) {
  return loadFamilies().find(f => f.id === id) || null;
}

function getSelectedFamilyId() {
  return localStorage.getItem(SELECTED_FAMILY_KEY) || null;
}

function setSelectedFamilyId(id) {
  if (id) localStorage.setItem(SELECTED_FAMILY_KEY, id);
  else localStorage.removeItem(SELECTED_FAMILY_KEY);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
function getFamilyRecords(familyId) {
  return loadFleet().filter(r => r.familyId === familyId);
}

// The bottom member (booster or legacy rocket) — the family's mandatory
// single stack-base. Returns null for orphan families (e.g. Unassigned
// Stages) that don't yet have a booster.
function getFamilyBottom(familyId) {
  const f = getFamily(familyId);
  if (!f || !f.bottomId) return null;
  return loadFleet().find(r => r.id === f.bottomId) || null;
}

// Stages + noses attached to a family (everything except the bottom member).
function getFamilyMembers(familyId) {
  const f = getFamily(familyId);
  if (!f) return [];
  return loadFleet().filter(r => r.familyId === familyId && r.id !== f.bottomId);
}

function getFamilyForRecord(recId) {
  const r = loadFleet().find(x => x.id === recId);
  if (!r || !r.familyId) return null;
  return getFamily(r.familyId);
}

// Phase 3 §1.11 / §3: a Stack is an ordered list of fleet-record-ids
// (bottom→top) referencing existing records — it never owns or mutates
// them, so any member stays standalone flyable from its own fleet entry.
// Bottom member is always a 'booster'; upper members are 'stage' or another
// 'booster' — never 'rocket' (§1.11).
const STACKS_KEY = 'rocketSim.stacks.v1';
const SELECTED_STACK_KEY = 'rocketSim.selectedStackId.v1';

// Local formatting helper — fleet.js is a data layer shared by every page
// (some of which don't define rockets.js's fmtMass). Kept here so error
// messages from validateStack() read cleanly everywhere.
function _fmtMassShort(kg) {
  if (!Number.isFinite(kg)) return '—';
  return kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg';
}

// Phase 3 §3 — every fleet record is one of three roles:
//   'rocket'  — standalone, nose-capped, fully flyable. (Phase 1/2 default.)
//   'booster' — like 'rocket' but no nose; can carry a stage/stack on top.
//               Adds maxExtraWeightKg (manual for now, formula later).
//   'stage'   — an upper stage that carries its own fuel tank, body metal,
//               and payload space. Its masses (dryMassNoPayload, fuelMassMax,
//               maxPayloadMassKg, totalWetMassAtMaxPayload) are computed
//               live from those inputs — NEVER stored/cached on the record
//               (PHASE3_PROMPT.md §3 / §1.12).
const STAGE_ROLES = ['rocket', 'booster', 'stage', 'nose', 'payloadSpace', 'payload'];


// Every param key that now lives under `params`, regardless of which
// component type owns it — used to pull legacy flat fields (or a
// not-yet-updated editor's flat submission) into the nested shape.
const FLAT_PARAM_KEYS = [
  'octaRadius', 'engineFMax', 'engineFMinFrac', 'engineVe', 'engineThrustRate',
  'gimbalMaxDeg', 'gimbalRateDegS', 'legDeployRate',
  'rcsThrust', 'rcsVe', 'rcsXOffset', 'rcsTopY', 'rcsBottomY', 'rcsPwmPeriod',
];

function defaultVehicleData() {
  return {
    id: 'falcon9-default',
    name: 'Falcon-9-Class (Default)',
    locked: true,
    stageRole: 'rocket',
    familyId: LEGACY_FAMILY_ID,
    height: 45,
    width: 3.9,
    dryMass: 23000,
    fuelMassMax: 400000,
    dragCd: 0.6,
    engineTypeId: 'octaweb-merlin9',
  recoveryTypeId: 'legs-swingout-4',
  hasRecovery: true,
  // Real F9 legs are carbon-fibre composite over an aluminium honeycomb
  // core — a different material from the al-li airframe. Kept separate
  // from bodyMetalTypeId so a rocket/booster/stage can mix them.
  legsMetalTypeId: 'carbon-composite',
  rcsTypeId: 'rcs-4pod-2nozzle',
    engineThrusters: {
      gimbal: { thrusterTypeId: 'merlin-1d-class', massFlowRate: 207 },
      fixed: { thrusterTypeId: 'merlin-1d-class', massFlowRate: 207 },
    },
    rcsThruster: { thrusterTypeId: 'cold-gas-small', massFlowRate: 0.5 },
    params: {
      octaRadius: 1.7,
      engineFMax: 600000,
      engineFMinFrac: 0.4,
      engineVe: 2900,
      engineThrustRate: 0.5,
      gimbalMaxDeg: 20,
      gimbalRateDegS: 40,
      legDeployRate: 0.5,
      rcsThrust: 1100,
      rcsVe: 2200,
      rcsXOffset: 1.95,
      rcsTopY: 35,
      rcsBottomY: 3,
      rcsPwmPeriod: 0.3,
    },
    bodyDesign: { mode: 'solid', solidColor: '#e9edf2', dslText: '' },
  };
}


// ---------------------------------------------------------------------------
// Blank-record factories for the other stage roles (Phase 3 §3 / PS-B1).
// All inherit the Falcon-9-class engine/legs/RCS baseline as a reasonable
// starting point where relevant — the builder then lets the user swap any
// component type. Placeholder type ids below match the built-in seed
// registry (componentLibrary.js); a real registry with these ids removed
// would fall back gracefully, since getComponentType() returns null and
// the builder surfaces it as "no type selected".
// ---------------------------------------------------------------------------

// ============================================================================
// Falcon 9 Block 5 seed — the default family on a fresh install. Three
// separate fleet records (booster / stage / fairing), one payload, one
// stack. Values are real Block 5 hardware, calibrated so each record's
// derived mass lands on the real figure within ~0.5%.
// ============================================================================

function seedFalcon9Booster() {
  return {
    id: 'falcon9-default',
    name: 'Falcon 9 Block 5 — Booster',
    locked: true,
    stageRole: 'booster',
    familyId: LEGACY_FAMILY_ID,
    height: 41.2, width: 3.7, dragCd: 0.6,
    engineTypeId: 'octaweb-merlin9',
    recoveryTypeId: 'legs-swingout-4',
    hasRecovery: true,
    rcsTypeId: 'rcs-4pod-2nozzle',
    bodyMetalTypeId: 'al-li-alloy',
    legsMetalTypeId: 'carbon-composite',
    bodyShellFactor: 0.01797,
    maxExtraWeightKg: 121500,
    engineThrusters: {
      gimbal: { thrusterTypeId: 'merlin-1d-class', massFlowRate: 306 },
      fixed:  { thrusterTypeId: 'merlin-1d-class', massFlowRate: 306 },
    },
    rcsThruster: { thrusterTypeId: 'cold-gas-small', massFlowRate: 0.5 },
    fuel: {
      typeId: 'rp1-lox',
      tankHeight: 34.1, tankWidth: 3.7,
      baffleCount: 4, baffleInnerRadiusFrac: 0.8,
    },
    params: {
  octaRadius: 1.7,
  rcsTopY: 40.5, rcsBottomY: 1, rcsXOffset: 1.85, rcsPwmPeriod: 0.3,
  legDeployRate: 0.5,
},
    bodyDesign: { mode: 'solid', solidColor: '#e9edf2', dslText: '' },
  };
}

function seedFalcon9Stage() {
  return {
    id: 'falcon9-stage',
    name: 'Falcon 9 Block 5 — Upper Stage',
    locked: false,
    stageRole: 'stage',
    familyId: LEGACY_FAMILY_ID,
    height: 13.8, width: 3.7, dragCd: 0.6,
    engineTypeId: 'single-nozzle-vac',
    recoveryTypeId: null,
    hasRecovery: false,
    rcsTypeId: 'rcs-4pod-2nozzle',
    bodyMetalTypeId: 'al-li-alloy',
    legsMetalTypeId: 'carbon-composite',
    bodyShellFactor: 0.0147,
    maxExtraWeightKg: 22000,
    engineThrusters: {
      gimbal: { thrusterTypeId: 'merlin-1d-vac-class', massFlowRate: 288 },
    },
    rcsThruster: { thrusterTypeId: 'cold-gas-small', massFlowRate: 0.5 },
    fuel: {
      typeId: 'rp1-lox',
      tankHeight: 8.0, tankWidth: 3.7,
      baffleCount: 2, baffleInnerRadiusFrac: 0.8,
    },
    params: {
  rcsTopY: 13, rcsBottomY: 1, rcsXOffset: 1.85, rcsPwmPeriod: 0.3,
},
    bodyDesign: { mode: 'solid', solidColor: '#e9edf2', dslText: '' },
  };
}

function seedFalcon9Fairing() {
  return {
    id: 'falcon9-fairing',
    name: 'Falcon 9 Fairing',
    locked: false,
    stageRole: 'payloadSpace',
    familyId: LEGACY_FAMILY_ID,
    height: 13.1, width: 5.2, dragCd: 0.4,
    payloadSpaceTypeId: 'cap-bulged',
payloadSpaceMetalTypeId: 'carbon-composite',
bodyShellFactor: 0.0026,
deploymentDirection: 'clamshell',
color: '#e9edf2',
// F9 fairings are recovered with parachutes — round-canopy type,
// auto-deploys at CONFIG.FAIRING_CHUTE_DEPLOY_ALT_AGL_M.
chuteTypeId: 'fairing-chute-round',
params: {
  capHeight: 13.1, capWidth: 3.7, bulgeWidth: 5.2,
  frustumSlantDeg: 42, curveHeightFactor: 1.4,
},
    bodyDesign: { mode: 'solid', solidColor: '#e9edf2', dslText: '' },
  };
}

function seedFalcon9Payload() {
  return {
    id: 'pl_falcon9-default',
    name: 'Falcon 9 Demo Payload',
    mass: 12000,
    height: 8.0,
    width: 3.0,
    dragCd: 0.3,
  };
}

function seedFalcon9Stack() {
  return {
    id: 'stk_falcon9-default',
    name: 'Falcon 9 Block 5',
    members: ['falcon9-default', 'falcon9-stage', 'falcon9-fairing'],
    sequence: 'f9-standard',
    payloadId: 'pl_falcon9-default',
    locked: false,
  };
}

function seedFalcon9Family() {
  return [seedFalcon9Booster(), seedFalcon9Stage(), seedFalcon9Fairing()];
}

function blankRocketData() {
  const base = defaultVehicleData();
  return { ...base, id: null, name: 'New Rocket', locked: false, stageRole: 'rocket' };
}

function blankBoosterData() {
  const base = defaultVehicleData();
  const out = {
    ...base,
    id: null,
    name: 'New Booster',
    locked: false,
    stageRole: 'booster',
    maxExtraWeightKg: 0,
    // Same fuel/metal inputs as a stage — dry mass and fuel capacity are
    // now DERIVED (P4-C1), not manually entered. Phase 2C-extension:
    // baffleCount defaults to 0 (no baffles) and baffleInnerRadiusFrac
    // to the standard real-baffle 0.8 ratio.
      // Same fuel/metal inputs as a stage — dry mass and fuel capacity are
  // now DERIVED (P4-C1), not manually entered. Phase 2C-extension:
  // baffleCount defaults to 0 (no baffles) and baffleInnerRadiusFrac
  // to the standard real-baffle 0.8 ratio.
  fuel: { typeId: 'rp1-lox', tankHeight: 45, tankWidth: 3.9, baffleCount: 0, baffleInnerRadiusFrac: 0.8 },
      bodyMetalTypeId: 'al-li-alloy',
    // Real F9 legs are carbon-fibre composite — default a new booster's
    // legs to that, independent of the airframe metal.
    legsMetalTypeId: 'carbon-composite',
    // F9-calibrated default — user can override per-record.
    bodyShellFactor: DEFAULT_SHELL_FACTOR_BY_ROLE.booster,
  };
  
  
  delete out.dryMass;
  delete out.fuelMassMax;
  return out;
}

function blankStageData() {
  const base = defaultVehicleData();
  const out = {
      ...base,
      id: null,
      name: 'New Stage',
      locked: false,
      stageRole: 'stage',
      // Stage inputs — these drive all derived masses at read time.
      // Stage inputs — these drive all derived masses at read time.
fuel: { typeId: 'rp1-lox', tankHeight: 10, tankWidth: 3.9, baffleCount: 0, baffleInnerRadiusFrac: 0.8 },
  bodyMetalTypeId: 'al-li-alloy',
  legsMetalTypeId: 'carbon-composite',
  bodyShellFactor: DEFAULT_SHELL_FACTOR_BY_ROLE.stage,
    // NOTE (PS-B2): nested payloadSpace is the LEGACY shape. Going forward
    // the fairing is its own top-level 'payloadSpace' fleet record (see
    // blankPayloadSpaceData() below) — a brand-new stage created after this
    // step no longer needs one. It's kept out of this blank factory on
    // purpose; the deprecated stage-editor payload fieldset (still wired
    // in rockets.js/rockets.html until PS-C) is what still writes this
    // field onto a record if the user touches those inputs.
    maxExtraWeightKg: 0,
  };
  // A stage has no manually-entered dry/fuel mass — those are computed live
  // from the ingredients above (PHASE3_PROMPT.md §3).
  delete out.dryMass;
  delete out.fuelMassMax;
  return out;
}

// Blank factory for the standalone payloadSpace role (Phase PS-B). A pure
// fairing record — no engines, RCS, recovery, or fuel. Its own footprint
// (height/width) is independent for now; PS-D1 will add the stack-level
// rule that it must sit at the very top with width compatible with the
// member below it. dryMass is DERIVED (structural volume × metal density,
// added in PS-E) — never stored here, same rule as booster/stage.
function blankPayloadSpaceData() {
  return {
    id: null,
    name: 'New Payload Space',
    locked: false,
    stageRole: 'payloadSpace',
    familyId: null,
    height: 3,
    width: 3.9,
    dragCd: 0.4,
        payloadSpaceTypeId: 'cap-bulged',
      payloadSpaceMetalTypeId: 'al-li-alloy',
      bodyShellFactor: DEFAULT_SHELL_FACTOR_BY_ROLE.payloadSpace,
      deploymentDirection: 'clamshell',
      color: '#e9edf2',
      // Fairing recovery chute — null = no chute, deploy nothing. Any body
      // spawned from this record (split half OR emergency-ejected package)
      // inherits this selection.
      chuteTypeId: null,
      params: { capHeight: 3, capWidth: 3.9 },
      bodyDesign: { mode: 'solid', solidColor: '#e9edf2', dslText: '' },
    };
    }


// Normalizes ANY record — a genuinely old Phase-1 flat record, a fresh
// Phase-2 nested record, or a hybrid (e.g. a nested record spread with a
// still-flat editor submission on top, before rockets.js is updated in
// Step F) — into the canonical nested shape. Idempotent: running it twice
// produces the same result. Any param missing after that is backfilled
// from the default vehicle so a record never ends up with holes.
function migrateRocketRecord(r) {
  if (!r) return r;
  const defaults = defaultVehicleData();
  const stageRole = STAGE_ROLES.includes(r.stageRole) ? r.stageRole : 'rocket';
  const out = {
    id: r.id,
    name: r.name,
    locked: !!r.locked,
    stageRole,
    height: r.height !== undefined ? r.height : defaults.height,
    width: r.width !== undefined ? r.width : defaults.width,
    dryMass: r.dryMass !== undefined ? r.dryMass : defaults.dryMass,
    fuelMassMax: r.fuelMassMax !== undefined ? r.fuelMassMax : defaults.fuelMassMax,
    dragCd: r.dragCd !== undefined ? r.dragCd : defaults.dragCd,
    engineTypeId: r.engineTypeId || defaults.engineTypeId,
    recoveryTypeId: r.recoveryTypeId || defaults.recoveryTypeId,
    hasRecovery: (r.hasRecovery === undefined) ? !!r.recoveryTypeId : !!r.hasRecovery,
    rcsTypeId: r.rcsTypeId || defaults.rcsTypeId,
    engineThrusters: r.engineThrusters ? JSON.parse(JSON.stringify(r.engineThrusters)) : null,
    rcsThruster: r.rcsThruster ? JSON.parse(JSON.stringify(r.rcsThruster)) : null,
    params: stageRole === 'nose' ? null : { ...defaults.params, ...(r.params || {}) },
    bodyDesign: {
      mode: (r.bodyDesign && ['solid', 'dsl'].includes(r.bodyDesign.mode)) ? r.bodyDesign.mode : 'solid',
      solidColor: (r.bodyDesign && typeof r.bodyDesign.solidColor === 'string') ? r.bodyDesign.solidColor : '#e9edf2',
      dslText: (r.bodyDesign && typeof r.bodyDesign.dslText === 'string') ? r.bodyDesign.dslText : '',
    },
  };
  out.familyId = r.familyId || null;
// Legs metal — new dedicated field. Pre-fix records had no separate
// legs metal; the mass model used bodyMetalTypeId. Preserve that
// behavior exactly for legacy records by falling back through
// bodyMetalTypeId, and finally to 'al-li-alloy' if neither is present.
// New records from the blank factories carry 'carbon-composite'
// explicitly, so this fallback never runs for them.
out.legsMetalTypeId = r.legsMetalTypeId || r.bodyMetalTypeId || 'al-li-alloy';
// Per-record shell factor. Role-appropriate default for legacy records
// that predate the field; explicit value carried through otherwise.
// Note: this is set for ALL roles (same pattern as legsMetalTypeId
// above) — nose / rocket simply ignore it downstream.
if (Number.isFinite(r.bodyShellFactor)) {
  out.bodyShellFactor = r.bodyShellFactor;
} else {
  out.bodyShellFactor = DEFAULT_SHELL_FACTOR_BY_ROLE[stageRole] || BODY_SHELL_FACTOR;
}
// Both 'booster' and 'stage' carry maxExtraWeightKg — anything can be
// stacked on top of either.
// Both 'booster' and 'stage' carry maxExtraWeightKg — anything can be
// stacked on top of either.
if (stageRole === 'booster' || stageRole === 'stage') {
    out.maxExtraWeightKg = Number.isFinite(r.maxExtraWeightKg) ? r.maxExtraWeightKg : 0;
  }
  
  // Stage-only ingredient inputs.
  if (stageRole === 'stage') {
  out.fuel = {
    typeId: (r.fuel && r.fuel.typeId) || 'rp1-lox',
    tankHeight: (r.fuel && Number.isFinite(r.fuel.tankHeight)) ? r.fuel.tankHeight : 10,
    tankWidth: (r.fuel && Number.isFinite(r.fuel.tankWidth)) ? r.fuel.tankWidth : 3.9,
    // Phase 2C-extension: baffle geometry now per-vehicle. Default 0
    // baffles for legacy records (matches pre-2C-extension behavior for
    // any tank that was never explicitly baffled). Legacy fuel types
    // that used to carry a baffle default (rp1-lox-baffled) no longer
    // exist; records that referenced them will fall back to
    // typeId='rp1-lox' and default to 0 baffles. Any vehicle that
    // actually wanted baffles must set the count here.
    baffleCount: (r.fuel && Number.isFinite(r.fuel.baffleCount)) ?
      Math.max(0, Math.round(r.fuel.baffleCount)) : 0,
    baffleInnerRadiusFrac: (r.fuel && Number.isFinite(r.fuel.baffleInnerRadiusFrac)) ?
      Math.max(0, Math.min(1, r.fuel.baffleInnerRadiusFrac)) : 0.8,
  };
  out.bodyMetalTypeId = r.bodyMetalTypeId || 'al-li-alloy';
    // PS-B2 — IMPORTANT CHANGE: the old code always synthesized a nested
    // `payloadSpace` object here, EVEN when the raw record no longer had
    // one — which meant a stage that splitLegacyStagePayloadSpaces() had
    // already cleaned up would get a brand-new default nested payloadSpace
    // re-attached on the very next load, forever undoing the split. Now
    // this only carries the field forward if the raw record actually still
    // has it (i.e. it hasn't been split yet, or the still-active legacy
    // stage-payload UI just wrote to it — see PS-C).
    if (r.payloadSpace) {
      out.payloadSpace = {
        typeId: r.payloadSpace.typeId || 'cap-standard',
        metalTypeId: r.payloadSpace.metalTypeId || 'al-li-alloy',
        deploymentDirection: r.payloadSpace.deploymentDirection || 'clamshell',
        color: (typeof r.payloadSpace.color === 'string') ? r.payloadSpace.color : '#e9edf2',
        params: r.payloadSpace.params ? { ...r.payloadSpace.params } : { capHeight: 3, capWidth: 2.5 },
      };
    }
    delete out.dryMass;
    delete out.fuelMassMax;
  }
  
  if (stageRole === 'booster') {
  out.fuel = {
    typeId: (r.fuel && r.fuel.typeId) || 'rp1-lox',
    tankHeight: (r.fuel && Number.isFinite(r.fuel.tankHeight)) ? r.fuel.tankHeight : 45,
    tankWidth: (r.fuel && Number.isFinite(r.fuel.tankWidth)) ? r.fuel.tankWidth : 3.9,
    baffleCount: (r.fuel && Number.isFinite(r.fuel.baffleCount)) ?
      Math.max(0, Math.round(r.fuel.baffleCount)) : 0,
    baffleInnerRadiusFrac: (r.fuel && Number.isFinite(r.fuel.baffleInnerRadiusFrac)) ?
      Math.max(0, Math.min(1, r.fuel.baffleInnerRadiusFrac)) : 0.8,
  };
  out.bodyMetalTypeId = r.bodyMetalTypeId || 'al-li-alloy';
    // Derived — no stored dryMass/fuelMassMax on a booster anymore.
    delete out.dryMass;
    delete out.fuelMassMax;
  }
  
  // PS-B2 FIX: this whole block used to live NESTED inside
  // `if (stageRole === 'stage')` above, which meant it could never
  // actually run for a real nose record (a record can't be both 'stage'
  // and 'nose' at once) — bodyMetalTypeId/noseCurveness silently vanished
  // on every save, and nothing ever nulled out the inherited engine/
  // recovery/RCS defaults for a nose. Promoted to its own top-level branch,
  // a sibling of stage/booster/payloadSpace, so it actually executes.
  if (stageRole === 'nose') {
    out.bodyMetalTypeId = r.bodyMetalTypeId || 'al-li-alloy';
    out.noseCurveness = Number.isFinite(r.noseCurveness) ? r.noseCurveness : 0;
    out.engineTypeId = null;
    out.recoveryTypeId = null;
    out.hasRecovery = false;
    out.rcsTypeId = null;
    out.engineThrusters = null;
    out.rcsThruster = null;
    delete out.dryMass;
    delete out.fuelMassMax;
    out.params = null;
  }
  
  // PS-B2: standalone fairing record — the split target of the migration
  // below. Pure shape + metal; no engines, no recovery, no RCS, no fuel.
if (stageRole === 'payloadSpace') {
  out.payloadSpaceTypeId = r.payloadSpaceTypeId || 'cap-bulged';
  out.payloadSpaceMetalTypeId = r.payloadSpaceMetalTypeId || 'al-li-alloy';
  out.deploymentDirection = r.deploymentDirection || 'clamshell';
  out.color = (typeof r.color === 'string') ? r.color : '#e9edf2';
  // Chute selection. null = no chute (legacy/pre-recovery records keep
  // their no-chute behavior; user opts in by picking a type in the form).
  out.chuteTypeId = r.chuteTypeId || null;
    const p = r.params || {};
    out.params = {
      capHeight: Number.isFinite(p.capHeight) ? p.capHeight : 3,
      capWidth: Number.isFinite(p.capWidth) ? p.capWidth : (out.width || 3.9),
      ...(Number.isFinite(p.bulgeWidth) ? { bulgeWidth: p.bulgeWidth } : {}),
      ...(Number.isFinite(p.frustumSlantDeg) ? { frustumSlantDeg: p.frustumSlantDeg } : {}),
      ...(Number.isFinite(p.curveHeightFactor) ? { curveHeightFactor: p.curveHeightFactor } : {}),
    };
    out.engineTypeId = null;
    out.recoveryTypeId = null;
    out.hasRecovery = false;
    out.rcsTypeId = null;
    out.engineThrusters = null;
    out.rcsThruster = null;
    delete out.dryMass;
    delete out.fuelMassMax;
    out.bodyDesign = {
      mode: (r.bodyDesign && ['solid', 'dsl'].includes(r.bodyDesign.mode)) ? r.bodyDesign.mode : 'solid',
      solidColor: (r.bodyDesign && typeof r.bodyDesign.solidColor === 'string') ? r.bodyDesign.solidColor : '#e9edf2',
      dslText: (r.bodyDesign && typeof r.bodyDesign.dslText === 'string') ? r.bodyDesign.dslText : '',
    };
  }
  
  FLAT_PARAM_KEYS.forEach(k => {
    if (r[k] !== undefined && out.params) out.params[k] = r[k];
  });
  
  // P4-RCS-migration: rcsTopMargin → rcsTopY (bottom-anchored).
  // Old rcsTopMargin measured DOWN from the top; new rcsTopY measures UP
  // from the base. Convert once, then delete the legacy key.
  //
  // PS-B2 FIX: guarded on `out.rcsTypeId && out.params` — this block used
  // to run unconditionally and read/write `out.params.*` even when
  // out.params was null (true for 'nose', and now also for a fresh
  // 'payloadSpace' record before this guard existed as an object-safety
  // net) — that was a real, previously-dormant crash for any nose record
  // (nose is currently hidden from the role picker UI, which is exactly
  // why nobody hit it). A record with no RCS type has no RCS margins to
  // migrate, so skipping it here is both safe and correct.
  if (out.rcsTypeId && out.params) {
    if (out.params.rcsTopMargin !== undefined) {
      const H = Number.isFinite(out.height) ? out.height : 45;
      out.params.rcsTopY = Math.max(0, H - out.params.rcsTopMargin);
      delete out.params.rcsTopMargin;
    }
    if (out.params.rcsBottomMargin !== undefined) {
      out.params.rcsBottomY = out.params.rcsBottomMargin;
      delete out.params.rcsBottomMargin;
    }
    // If somehow neither was present, backfill from defaults.
    if (!Number.isFinite(out.params.rcsTopY)) out.params.rcsTopY = defaults.params.rcsTopY;
    if (!Number.isFinite(out.params.rcsBottomY)) out.params.rcsBottomY = defaults.params.rcsBottomY;
  }
  
  backfillThrusterRecords(out, defaults);
  bridgePerfParams(out);
  return out;
}

// ============================================================================
// PS-B2 — one-time split migration: legacy nested stage.payloadSpace becomes
// its own standalone 'payloadSpace' fleet record, inserted into any stack
// right above the stage it came from.
//
// WHY THIS IS A ONE-TIME PASS AND NOT PART OF migrateRocketRecord() ITSELF:
// migrateRocketRecord() only ever sees ONE record at a time and has no
// access to the rest of the fleet or to the stacks store — it has no way to
// spawn a sibling record or splice a stack's member list. So the split has
// to happen at the fleet level, which is what this function does.
//
// It's also gated to run EXACTLY ONCE (via PAYLOAD_SPLIT_DONE_KEY), rather
// than on every loadFleet() call like the rest of the migration pipeline.
// Reason: the stage editor's payload-space fieldset is still live (it's
// only removed in PS-C) and re-writes a nested payloadSpace object on every
// stage save. If this split ran unconditionally on every load, each save
// of an already-split stage would spawn ANOTHER sibling fairing forever.
// Running it once converts whatever legacy data exists right now and then
// gets out of the way — PS-C's real fix is deleting that old UI entirely.
// ============================================================================
function splitLegacyStagePayloadSpaces(fleet) {
  const newRecords = [];
  const insertions = []; // { afterId, newId }
  
  fleet.forEach(rec => {
    if (rec.stageRole !== 'stage') return;
    const ps = rec.payloadSpace;
    // Marker for "still has real legacy data": a finite capHeight. Once
    // split, the nested field is deleted entirely, so this can't re-fire
    // against the same record (even if this ever ran more than once).
    if (!ps || !ps.params || !Number.isFinite(ps.params.capHeight)) return;
    
    const capH = ps.params.capHeight;
    const capW = Number.isFinite(ps.params.capWidth) ? ps.params.capWidth : (rec.width || 3.9);
    const bulgeW = Number.isFinite(ps.params.bulgeWidth) ? ps.params.bulgeWidth : null;
    
    const psRecord = migrateRocketRecord({
      id: genId(),
      name: rec.name + ' Fairing',
      locked: false,
      stageRole: 'payloadSpace',
      familyId: rec.familyId || null,
      height: capH,
      width: bulgeW || capW,
      dragCd: Number.isFinite(rec.dragCd) ? rec.dragCd : 0.4,
      payloadSpaceTypeId: ps.typeId || 'cap-bulged',
      payloadSpaceMetalTypeId: ps.metalTypeId || 'al-li-alloy',
      deploymentDirection: ps.deploymentDirection || 'clamshell',
      color: ps.color || '#e9edf2',
      params: { capHeight: capH, capWidth: capW, ...(bulgeW !== null ? { bulgeWidth: bulgeW } : {}) },
    });
    newRecords.push(psRecord);
    insertions.push({ afterId: rec.id, newId: psRecord.id });
    
    // The stage keeps only its tank now — its own `height` becomes just the
    // tank height; the fairing's height lives on the new sibling instead.
    rec.height = Number.isFinite(rec.fuel && rec.fuel.tankHeight) ? rec.fuel.tankHeight : rec.height;
    delete rec.payloadSpace;
  });
  
  if (!newRecords.length) return { fleet, changed: false };
  
  const outFleet = [...fleet, ...newRecords];
  
  // Splice each new fairing into any stack right after its parent stage —
  // an already-saved stack keeps flying with the same silhouette instead of
  // silently losing its nose the moment this migration runs.
  const stacks = loadStacks();
  let stacksChanged = false;
  stacks.forEach(s => {
    insertions.forEach(({ afterId, newId }) => {
      const idx = s.members.indexOf(afterId);
      if (idx >= 0 && !s.members.includes(newId)) {
        s.members.splice(idx + 1, 0, newId);
        stacksChanged = true;
      }
    });
  });
  if (stacksChanged) saveStacks(stacks);
  
  return { fleet: outFleet, changed: true };
}

const PAYLOAD_SPLIT_DONE_KEY = 'rocketSim.payloadSplitDone.v1';

// Runs splitLegacyStagePayloadSpaces() exactly once per browser/localStorage
// (see the big comment above for why). Safe to call on every loadFleet() —
// after the first real run it's a single localStorage read and a no-op.
function runPayloadSpaceSplitOnce(fleet) {
  if (localStorage.getItem(PAYLOAD_SPLIT_DONE_KEY) === '1') return fleet;
  const result = splitLegacyStagePayloadSpaces(fleet);
  localStorage.setItem(PAYLOAD_SPLIT_DONE_KEY, '1');
  return result.fleet;
}

function loadFleet() {
  try {
    const raw = localStorage.getItem(FLEET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        let migrated = parsed.map(migrateRocketRecord);
        migrated = runPayloadSpaceSplitOnce(migrated);
        if (JSON.stringify(migrated) !== JSON.stringify(parsed)) saveFleet(migrated);
        return migrated;
      }
    }
  } catch (e) { /* fall through to seed */ }
// Fresh install — seed the full Falcon 9 Block 5 demo family (booster +
// upper stage + fairing), plus its payload and pre-built stack. Runs
// once: after this save, subsequent loadFleet() calls take the normal
// migrate-and-return branch above.
//
// CRITICAL: migration MUST run on the seed before returning it. Config.js
// reads the returned records at script-load time, and role-specific
// derived params (engineVe / engineFMax for a booster, etc.) only exist
// AFTER bridgePerfParams() has backfilled them — which only runs inside
// migrateRocketRecord(). Skipping this step left CONFIG.ENGINE_VE
// undefined, which crashed home.js's spec card the moment a booster was
// the selected vehicle.
const seeded = seedFalcon9Family().map(migrateRocketRecord);
saveFleet(seeded);
localStorage.setItem(SELECTED_KEY, seeded[0].id);
  // Seed the demo payload + stack (only if not already present).
  if (!loadPayloads().length) savePayloads([seedFalcon9Payload()]);
  if (!loadStacks().length) {
    saveStacks([seedFalcon9Stack()]);
    setSelectedStackId('stk_falcon9-default');
  }
  return seeded;
  }

function saveFleet(fleet) {
  localStorage.setItem(FLEET_KEY, JSON.stringify(fleet));
}

function getSelectedId() {
  const id = localStorage.getItem(SELECTED_KEY);
  if (id) return id;
  const fleet = loadFleet();
  localStorage.setItem(SELECTED_KEY, fleet[0].id);
  return fleet[0].id;
}

function setSelectedId(id) {
  localStorage.setItem(SELECTED_KEY, id);
}

function getSelectedRocket() {
  const fleet = loadFleet();
  return fleet.find(r => r.id === getSelectedId()) || fleet[0];
}

// ---------------------------------------------------------------------------
// Stack CRUD (Phase 3 Step G1). localStorage-backed, same pattern as the
// fleet. Records are looked up by id — the stack itself stores only ids,
// so renaming/deleting/re-editing a member is immediately reflected.
// ---------------------------------------------------------------------------
function loadStacks() {
  try {
    const raw = localStorage.getItem(STACKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // One-time migration: stacks that predate the frozen-derived
        // layer (or the seed stack written directly via saveStacks)
        // don't have a `derived` field. Compute it now and persist so
        // this never has to run again for the same stack.
        let changed = false;
        parsed.forEach(s => {
          if (!s.derived || !s.derived.interstage) {
            s.derived = computeStackDerived(s.members);
            changed = true;
          }
        });
        if (changed) saveStacks(parsed);
        return parsed;
      }
    }
  } catch (e) { /* fall through */ }
  return [];
}

function saveStacks(stacks) {
  localStorage.setItem(STACKS_KEY, JSON.stringify(stacks));
}

function genStackId() {
  return 'stk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Stack-level derived values — computed ONCE when the stack is saved,
// then read from the stack record forever after. The point: an interstage
// is bolted hardware on the booster, and its dimensions are decided by
// what stage sits on top of it AT STACK DESIGN TIME. Once saved, the
// value must never change during flight — not when the stage detaches,
// not when the sim re-derives mass properties.
//
// Currently freezes only interstage sizing (the only stack-dependent
// structural value in the codebase today). Other per-member masses
// (shell, engines, fuel tank volume, legs, fairing) are member-local and
// don't need this — they compute identically attached or detached.
//
// If a future addition introduces another stack-context-dependent value,
// it goes here too.
// ---------------------------------------------------------------------------
function computeStackDerived(memberIds) {
  const fleet = loadFleet();
  const records = (memberIds || []).map(id => fleet.find(r => r.id === id)).filter(Boolean);
  const interstage = {};
  records.forEach((rec, i) => {
    if (rec.stageRole !== 'booster') return;
    const aboveRec = records[i + 1] || null;
    interstage[rec.id] = computeInterstageForBooster(rec, aboveRec);
  });
  return { interstage };
}

function addStack(data) {
  const stacks = loadStacks();
  const VALID_SEQ = ['f9-standard', 'f9-heavy', 'sso', 'custom'];
  const memberIds = Array.isArray(data && data.members) ? [...data.members] : [];
  const rec = {
    id: genStackId(),
    name: (data && data.name ? String(data.name) : 'Unnamed Stack').trim() || 'Unnamed Stack',
    members: memberIds,
    sequence: (data && VALID_SEQ.includes(data.sequence)) ? data.sequence : 'custom',
    payloadId: (data && data.payloadId) ? data.payloadId : null,
    locked: false,
    // Frozen at save time — see computeStackDerived() header.
    derived: computeStackDerived(memberIds),
  };
  stacks.push(rec);
  saveStacks(stacks);
  return rec;
}

function updateStack(id, data) {
  const stacks = loadStacks();
  const idx = stacks.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const merged = { ...stacks[idx], ...data, id };
  if (merged.payloadId === undefined) merged.payloadId = null;
  if (!Array.isArray(merged.members)) merged.members = [];
  const VALID_SEQ = ['f9-standard', 'f9-heavy', 'sso', 'custom'];
  if (!VALID_SEQ.includes(merged.sequence)) merged.sequence = 'custom';
  // Recompute derived (members may have changed, or an underlying member
  // record was edited). Always overwrite; never trust a stale cached copy.
  merged.derived = computeStackDerived(merged.members);
  stacks[idx] = merged;
  saveStacks(stacks);
  return merged;
}

function deleteStack(id) {
  let stacks = loadStacks();
  const tgt = stacks.find(s => s.id === id);
  if (!tgt || tgt.locked) return false;
  stacks = stacks.filter(s => s.id !== id);
  saveStacks(stacks);
  if (getSelectedStackId() === id) setSelectedStackId(null);
  return true;
}

function getStack(id) {
  return loadStacks().find(s => s.id === id) || null;
}

// ---------------------------------------------------------------------------
// Active-stack resolution (Phase 4 Step P4-C2b-1).
//
// The sim flies a STACK, not a single record. When the user hasn't created
// any stacks yet, we fall back to an implicit 1-member stack so the sim
// always has something to fly:
//   1. Explicit selected stack (SELECTED_STACK_KEY) if set and exists
//   2. Implicit stack = selected booster (SELECTED_KEY) alone
//   3. Implicit stack = Falcon-9 default legacy record
// ---------------------------------------------------------------------------
function getActiveStack() {
  const stacks = loadStacks();
  const sId = getSelectedStackId();
  
  // Explicit stack: use it if it exists AND has at least one live member.
  // Otherwise clear the stale pointer and fall through.
  if (sId) {
    const s = stacks.find(x => x.id === sId);
    const fleet = loadFleet();
    const hasLiveMember = s && s.members.some(id => fleet.some(r => r.id === id));
    if (s && hasLiveMember) {
      return { ...s, isImplicit: false };
    }
    setSelectedStackId(null);
  }
  
  // No explicit stack — fall back to the legacy Falcon-9 default. Individual
  // booster/stage/nose records do NOT fly alone; a single-member stack can
  // be created explicitly in the stack editor if the user wants that.
  const fleet = loadFleet();
  const legacy = fleet.find(r => r.id === 'falcon9-default') || fleet[0];
  if (legacy) {
    return {
      id: 'stk:legacy:' + legacy.id,
      name: legacy.name,
      members: [legacy.id],
      isImplicit: true,
      locked: true,
    };
  }
  return null;
}

function getActiveStackMembers() {
  const stk = getActiveStack();
  if (!stk) return [];
  const fleet = loadFleet();
  return stk.members.map(id => fleet.find(r => r.id === id)).filter(Boolean);
}

// Combined aggregates for a stack (bottom→top). If any member is infeasible
// (e.g. stage with negative payload), its contribution is treated as 0 and
// a warning is set — callers should surface it but shouldn't crash.
function stackCombinedAggregates(stk) {
  const members = getActiveStackMembers();
  const out = {
    name: stk ? stk.name : '—',
    dryMass: 0,
    fuelMass: 0,
    height: 0,
    width: 0,
    bottomMember: members[0] || null,
    warnings: [],
  };
  if (!members.length) return out;
  members.forEach((m, i) => {
    out.height += Number.isFinite(m.height) ? m.height : 0;
    out.width = Math.max(out.width, Number.isFinite(m.width) ? m.width : 0);
    let dry = 0,
      fuel = 0;
    if (m.stageRole === 'booster') {
  // Pass the stack's own frozen interstage value (if present). Falls
  // back to the live compute for legacy stacks that predate the
  // freezing layer — loadStacks() migrates those on next read.
  const frozen = (stk && stk.derived && stk.derived.interstage)
    ? stk.derived.interstage[m.id] : null;
  const d = boosterDerivedMasses(m, members[i + 1] || null, frozen);
  if (d) { dry = d.dryMass;
    fuel = d.fuelMass; }
    } else if (m.stageRole === 'stage') {
      const d = stageDerivedMasses(m);
      if (d && !d.infeasible) { dry = d.dryMassNoPayload;
        fuel = d.fuelMass; }
      else if (d && d.reason) out.warnings.push(`member ${i + 1} (${m.name}): ${d.reason}`);
      else out.warnings.push(`member ${i + 1} (${m.name}): infeasible`);
    } else if (m.stageRole === 'nose') {
      dry = computeNoseDryMass(m);
    } else if (m.stageRole === 'payloadSpace') {
      dry = computePayloadSpaceDryMass(m);
      fuel = 0;
    } else {
      // legacy rocket — flat fields
      dry = Number.isFinite(m.dryMass) ? m.dryMass : 0;
      fuel = Number.isFinite(m.fuelMassMax) ? m.fuelMassMax : 0;
    }
    out.dryMass += dry;
    out.fuelMass += fuel;
  });
  // I-c2: payload mass — counted toward total wet mass (sits inside fairing).
  if (stk && stk.payloadId && typeof getPayload === 'function') {
    const pl = getPayload(stk.payloadId);
    if (pl && Number.isFinite(pl.mass)) {
      out.dryMass += pl.mass;
      out.payloadMass = pl.mass;
      out.payloadName = pl.name;
    }
  }
  return out;
}

function getSelectedStackId() {
  return localStorage.getItem(SELECTED_STACK_KEY) || null;
}

function setSelectedStackId(id) {
  if (id) localStorage.setItem(SELECTED_STACK_KEY, id);
  else localStorage.removeItem(SELECTED_STACK_KEY);
}

function genId() {
  return 'rk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addRocket(data) {
  const fleet = loadFleet();
  const record = migrateRocketRecord({ ...data, id: genId(), locked: false });
  fleet.push(record);
  saveFleet(fleet);
  return record;
}

function updateRocket(id, data) {
  const fleet = loadFleet();
  const idx = fleet.findIndex(r => r.id === id);
  if (idx < 0) return null;
  fleet[idx] = migrateRocketRecord({ ...fleet[idx], ...data, id });
  saveFleet(fleet);
  return fleet[idx];
}

function deleteRocket(id) {
  let fleet = loadFleet();
  const target = fleet.find(r => r.id === id);
  if (!target || target.locked) return false;
  fleet = fleet.filter(r => r.id !== id);
  if (!fleet.length) fleet = [defaultVehicleData()];
  saveFleet(fleet);
  if (getSelectedId() === id) setSelectedId(fleet[0].id);
  
  // Phase 4 (P4-B3): clear stale bottomId pointers — otherwise the family
  // still reports "has booster" (getFamilyBottom would try to find a
  // missing record and return null, but UI checks like `fam.bottomId`
  // would incorrectly be truthy).
  const families = loadFamilies();
  let touched = false;
  families.forEach(f => {
    if (f.bottomId === id) { f.bottomId = null;
      touched = true; }
  });
  if (touched) saveFamilies(families);
  
  return true;
}

// ---------------------------------------------------------------------------
// Derived "capabilities" — shared math so the fleet list, editor preview,
// and (later) mission-planning tools all agree on the same numbers.
// Engine count now comes from the resolved engine-layout type's slot list,
// not a hardcoded 9 — a rocket using a different `ringWithCenter` type (say,
// a 6-outer-engine layout) reports its real 7 automatically.
//
// DEFENSIVE GUARD (bugfix): 'nose' and 'payloadSpace' records have
// `params === null` (they carry no engine/RCS parameter bag at all — see
// migrateRocketRecord()). Previously this function fell straight into the
// "rocket path" below for ANY non-booster record, including those two
// roles, and crashed on `v.params.engineFMax` the instant one existed in
// the fleet. rockets.js's fleet-list rendering calls this for every row
// (stage is the only role it special-cases before calling in), so a single
// nose/payloadSpace record broke the ENTIRE fleet page. This guard makes
// the function itself safe for any record shape, regardless of which
// caller reaches it — never trust the caller to have already filtered
// roles correctly.
// ---------------------------------------------------------------------------
function rocketCapabilities(v) {
  const ZERO = { engineCount: 0, totalMaxThrust: 0, wetMass: 0, mdotMax: 0, twrMax: 0, deltaV: 0, burnTimeS: 0 };
  
  // Guard FIRST — before any branch reads v.* — a nose/payloadSpace record
  // (params null) or a malformed record must never crash this function.
  if (!v || !v.params) return ZERO;
  
  // Booster derived-masses path (P4-C1).
  if (v.stageRole === 'booster') {
    const d = boosterDerivedMasses(v);
    const engineType = getComponentType(v.engineTypeId);
    const engineCount = engineType ? engineType.frame.slots.length : 9;
    if (!d || d.infeasible) return { ...ZERO, engineCount };
    const mdotMax = d.effectiveVe > 0 ? d.totalEngineThrust / d.effectiveVe : 0;
    const twrMax = d.wetMass > 0 ? d.totalEngineThrust / (d.wetMass * 9.8) : 0;
    const deltaV = (d.wetMass > 0 && d.dryMass > 0) ? d.effectiveVe * Math.log(d.wetMass / d.dryMass) : 0;
    const burnTimeS = mdotMax > 0 ? d.fuelMass / mdotMax : 0;
    return {
      engineCount,
      totalMaxThrust: d.totalEngineThrust,
      wetMass: d.wetMass,
      mdotMax,
      twrMax,
      deltaV,
      burnTimeS,
    };
  }
  
  // Rocket path — requires engineFMax/engineVe on params.
  const engineType = (typeof getComponentType === 'function') ? getComponentType(v.engineTypeId) : null;
  const engineCount = engineType ? engineType.frame.slots.length : 9;
  const totalMaxThrust = (v.params.engineFMax || 0) * engineCount;
  const dryMass = Number.isFinite(v.dryMass) ? v.dryMass : 0;
  const fuelMassMax = Number.isFinite(v.fuelMassMax) ? v.fuelMassMax : 0;
  const wetMass = dryMass + fuelMassMax;
  const mdotMax = totalMaxThrust / (v.params.engineVe || 1);
  const twrMax = wetMass > 0 ? totalMaxThrust / (wetMass * 9.8) : 0;
  const deltaV = (wetMass > 0 && dryMass > 0) ? (v.params.engineVe || 0) * Math.log(wetMass / dryMass) : 0;
  const burnTimeS = mdotMax > 0 ? fuelMassMax / mdotMax : 0;
  return { engineCount, totalMaxThrust, wetMass, mdotMax, twrMax, deltaV, burnTimeS };
}


// ---------------------------------------------------------------------------
// Stage derived masses (Phase 3 §4).
// A 'stage' record stores only INPUTS; everything here is COMPUTED LIVE.
// Returns null for non-stage records.
//
// PS-B2 UPDATE: the payload space (fairing) used to be REQUIRED here — a
// stage with no resolvable payloadSpace type was reported "infeasible".
// Now that the fairing is its own standalone fleet record (split off by
// splitLegacyStagePayloadSpaces), a stage that no longer carries a nested
// payloadSpace just contributes 0 payload-container mass/height instead of
// going infeasible. A not-yet-migrated record that still has the legacy
// nested field keeps computing exactly as before — nothing regresses for
// records mid-migration, and a freshly-split stage stays fully usable
// (fuel/engine/body masses, TWR, Δv) without waiting on PS-E.
// ---------------------------------------------------------------------------
function stageDerivedMasses(rec) {
  if (!rec || rec.stageRole !== 'stage') return null;
  const warnings = [];
  
  const fuelType = getComponentType(rec.fuel && rec.fuel.typeId);
  const bodyMetalType = getComponentType(rec.bodyMetalTypeId);
  const engineType = getComponentType(rec.engineTypeId);
  // BUG #1 FIX: mirror boosterDerivedMasses()'s hasRecovery gate — a stage
  // with "Fit recovery" unchecked must not keep contributing leg mass just
  // because recoveryTypeId is still set on the record from a prior state.
  const recoveryType = rec.hasRecovery === false ? null : getComponentType(rec.recoveryTypeId);
  
  const ps = rec.payloadSpace || null;
  const payloadType = ps ? getComponentType(ps.typeId) : null;
  const payloadMetal = ps ? getComponentType(ps.metalTypeId) : null;
  
  if (!fuelType || !bodyMetalType || !engineType) {
    return { infeasible: true, reason: 'Missing or unresolved type reference.', warnings };
  }
  
  const tankH = rec.fuel.tankHeight;
  const tankW = rec.fuel.tankWidth;
  const capParams = (ps && ps.params) || {};
  const capH = (payloadType && payloadMetal && Number.isFinite(capParams.capHeight)) ? capParams.capHeight : 0;
  const capW = Number.isFinite(capParams.capWidth) ? capParams.capWidth : tankW;
  const bulgeW = Number.isFinite(capParams.bulgeWidth) ? capParams.bulgeWidth : capW;
  
  const fuelDensity = fuelType.parameterSchema.find(p => p.key === 'propellantDensity').value;
  const bodyDensity = bodyMetalType.parameterSchema.find(p => p.key === 'density').value;
  const payloadDensity = payloadMetal ? payloadMetal.parameterSchema.find(p => p.key === 'density').value : 0;
  
  // Fuel mass + body (cylindrical tank as the vehicle body). Shell factor
// from the record's own field, falling back to the constant for any
// record that somehow lacks it (shouldn't happen post-migration).
const shellF = Number.isFinite(rec.bodyShellFactor) ? rec.bodyShellFactor : BODY_SHELL_FACTOR;
const tankVolume = Math.PI * (tankW / 2) ** 2 * tankH;
const fuelMass = tankVolume * fuelDensity;
const bodyMass = tankVolume * shellF * bodyDensity;

  const groups = engineThrusterGroups(engineType);
  let totalEngineThrust = 0,
    totalEngineMass = 0,
    sumFlow = 0,
    sumFlowVe = 0;
  Object.keys(groups).forEach(gk => {
    const count = groups[gk].length;
    const g = rec.engineThrusters && rec.engineThrusters[gk];
    if (!g) return;
    const t = getComponentType(g.thrusterTypeId);
    if (!t) return;
    const flow = g.massFlowRate;
    const ve = t.parameterSchema.find(p => p.key === 've').value;
    const thrustPer = flow * ve;
    const massPer = engineMassFromThrust(t, thrustPer);
    totalEngineThrust += thrustPer * count;
    totalEngineMass += (Number.isFinite(massPer) ? massPer : 0) * count;
    sumFlow += flow * count;
    sumFlowVe += flow * ve * count;
  });
  const effectiveVe = sumFlow > 0 ? sumFlowVe / sumFlow : 0;
  
  const stageTotalHeight = tankH + capH;
// Legs — density from legsMetalTypeId (same change as booster path).
let legMass = 0;
if (recoveryType && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle &&
  recoveryType.frame && typeof recoveryType.frame.structuralVolume === 'function') {
  const legsMetal = (typeof getComponentType === 'function') ?
    (getComponentType(rec.legsMetalTypeId) || bodyMetalType) :
    bodyMetalType;
  const legDensity = (legsMetal && legsMetal.parameterSchema.find(p => p.key === 'density')) ?
    legsMetal.parameterSchema.find(p => p.key === 'density').value :
    bodyDensity;
  const legCount = recoveryType.frame.legCount || 0;
  const oneLegVol = recoveryType.frame.structuralVolume(stageTotalHeight, tankW);
  legMass = oneLegVol * legCount * legDensity;
}
  
  let payloadContainerMass = 0;
if (payloadType && payloadType.frame && typeof payloadType.frame.structuralVolume === 'function') {
  // Legacy nested payload-space uses its own shell factor if present,
  // else the payloadSpace role default.
  const psShellF = Number.isFinite(ps && ps.bodyShellFactor) ?
    ps.bodyShellFactor :
    DEFAULT_SHELL_FACTOR_BY_ROLE.payloadSpace;
  payloadContainerMass = payloadType.frame.structuralVolume(capH, capW, bulgeW, psShellF) * payloadDensity;
}
  
  if (payloadType && payloadType.kind === 'bulgedCapShape' && Number.isFinite(capParams.bulgeWidth)) {
    const maxBulgeW = MAX_BULGE_DIAMETER_RATIO * tankW;
    if (bulgeW > maxBulgeW) {
      warnings.push(`Bulge width ${bulgeW} m exceeds cap ${maxBulgeW.toFixed(2)} m (${MAX_BULGE_DIAMETER_RATIO}× tank width).`);
    }
  }
  
  const dryMassNoPayload = bodyMass + totalEngineMass + payloadContainerMass + legMass;
  
  let D = 0;
  if (effectiveVe > 0) {
    D = fuelMass / (Math.exp(SECOND_STAGE_TARGET_DELTA_V / effectiveVe) - 1);
  }
  const maxPayloadMassFromDeltaV = D - dryMassNoPayload;
  
  const g = (typeof G0 !== 'undefined') ? G0 : 9.80665;
  const maxPayloadMassFromThrust = totalEngineThrust / (MIN_TWR_FLOOR * g) - dryMassNoPayload;
  
  const maxPayloadMassKg = Math.min(maxPayloadMassFromDeltaV, maxPayloadMassFromThrust);
  const infeasible = !Number.isFinite(maxPayloadMassKg) || maxPayloadMassKg < 0;
  const totalWetMassAtMaxPayload = dryMassNoPayload + fuelMass + Math.max(0, maxPayloadMassKg);
  
  return {
    fuelMass,
    bodyMass,
    totalEngineMass,
    legMass,
    payloadContainerMass,
    dryMassNoPayload,
    effectiveVe,
    totalEngineThrust,
    maxPayloadMassFromDeltaV,
    maxPayloadMassFromThrust,
    maxPayloadMassKg,
    totalWetMassAtMaxPayload,
    stageTotalHeight,
    tankVolume,
    infeasible,
    warnings,
  };
}


// I-c1: three-check compatibility filter between a payload and a stack.
//   1) Payload height ≤ fairing internal height (capHeight),
//      payload width ≤ fairing base width (capWidth — bulge overhangs,
//      not the constraint).
//   2) Payload mass + fairing mass ≤ stage's own maxExtraWeightKg
//      (immediate member below payloadSpace).
//   3) Every member BELOW that (including booster in multi-stage setups)
//      must have maxExtraWeightKg ≥ (payload + fairing + everything above it).
// Returns { ok, reasons[] }.
function payloadCompatibilityCheck(payload, stackMembers, fleet) {
  const reasons = [];
  if (!payload) return { ok: false, reasons: ['No payload selected'] };
  
  const psIdx = (stackMembers || []).findIndex(id => {
    const r = fleet.find(x => x.id === id);
    return r && r.stageRole === 'payloadSpace';
  });
  if (psIdx < 0) return { ok: false, reasons: ['No payloadSpace in stack'] };
  
  const psRec = fleet.find(x => x.id === stackMembers[psIdx]);
  const psParams = psRec.params || {};
  const psCapH = Number.isFinite(psParams.capHeight) ? psParams.capHeight : 0;
  const psBaseW = Number.isFinite(psParams.capWidth) ? psParams.capWidth : 0;
  
  // Check 1 — dimensions.
  if (payload.height > psCapH) {
    reasons.push(`Payload height ${payload.height} m > fairing height ${psCapH} m`);
  }
  if (payload.width > psBaseW) {
    reasons.push(`Payload width ${payload.width} m > fairing base ${psBaseW} m`);
  }
  
  const psMass = stackMemberOwnMass(psRec, null);
  const psMassOk = Number.isFinite(psMass) ? psMass : 0;
  
  // Checks 2 + 3 — cumulative load from each member below the fairing.
  for (let i = psIdx - 1; i >= 0; i--) {
    const lowerRec = fleet.find(x => x.id === stackMembers[i]);
    if (!lowerRec) continue;
    const cap = Number.isFinite(lowerRec.maxExtraWeightKg) ? lowerRec.maxExtraWeightKg : 0;
    // Load above this member = payload + fairing + every member strictly above i.
    let load = payload.mass + psMassOk;
    for (let j = i + 1; j < stackMembers.length; j++) {
      if (j === psIdx) continue; // fairing already added
      const r = fleet.find(x => x.id === stackMembers[j]);
      const rAbove = (j + 1 < stackMembers.length) ? fleet.find(x => x.id === stackMembers[j + 1]) : null;
      const m = r ? stackMemberOwnMass(r, rAbove || null) : 0;
      if (Number.isFinite(m)) load += m;
    }
    if (load > cap) {
      const label = i === psIdx - 1 ? 'stage' : 'member';
      reasons.push(`${label} "${lowerRec.name}" cap ${_fmtMassShort(cap)} < load above ${_fmtMassShort(load)}`);
    }
  }
  
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Booster derived masses (Phase 4 Step P4-C1).
//
// Same idea as stageDerivedMasses(): a booster's fuel mass, dry mass, and
// total mass are COMPUTED from its inputs (fuel tank dims + metal + engines
// + recovery legs), never stored on the record. Reuses the same formulas
// as the stage path so numbers stay consistent across roles.
//
// Returns null for non-booster records.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Interstage sizing — extracted so it can be called both inside
// boosterDerivedMasses (legacy/fallback path) and at stack-save time
// (to freeze the value on the stack record).
//
// Height: max(stage-above's engine bell × 1.20, 6% booster tank height).
// Mass:   thin-cylinder shell × carbon-composite density.
//
// Only the STACK CONTEXT decides the "stage above" term. Once the stack
// is saved, this value must never change during flight — see
// computeStackDerived() below for the freezing layer.
// ---------------------------------------------------------------------------
function computeInterstageForBooster(rec, aboveRec) {
  let stageAboveBellHeight = 0;
  if (aboveRec && aboveRec.engineTypeId) {
    const layoutAbove = getComponentType(aboveRec.engineTypeId);
    if (layoutAbove && layoutAbove.frame && layoutAbove.frame.slots) {
      const gAbove = engineThrusterGroups(layoutAbove);
      let totalFlow = 0;
      Object.keys(gAbove).forEach(gk => {
        const g = aboveRec.engineThrusters && aboveRec.engineThrusters[gk];
        if (!g || !Number.isFinite(g.massFlowRate)) return;
        totalFlow += g.massFlowRate * gAbove[gk].length;
      });
      const perEngine = totalFlow / layoutAbove.frame.slots.length;
      stageAboveBellHeight = 0.007 * perEngine;
    }
  }
  const tankH = (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) ? rec.fuel.tankHeight : 0;
  const tankW = (rec.fuel && Number.isFinite(rec.fuel.tankWidth)) ? rec.fuel.tankWidth : 0;
  const height = Math.max(stageAboveBellHeight * 1.20, 0.06 * tankH);
  
  const shellF = Number.isFinite(rec.bodyShellFactor) ? rec.bodyShellFactor : BODY_SHELL_FACTOR;
const r_booster = tankW / 2;
const shellThk = shellF * r_booster;
// Real F9 interstage is carbon fibre — hardcoded 1600 kg/m³, matching
// physics.js's own INTERSTAGE_DENSITY constant. Do NOT use the body
// metal density here; the interstage shell is a different material
// from the al-li airframe.
const INTERSTAGE_DENSITY = 1600;
const mass = 2 * Math.PI * r_booster * shellThk * height * INTERSTAGE_DENSITY;

  return { height, mass };
}

function boosterDerivedMasses(rec, aboveMember, frozenInterstage) {
  if (!rec || rec.stageRole !== 'booster') return null;
  const warnings = [];
  
  const fuelType = getComponentType(rec.fuel && rec.fuel.typeId);
  const bodyMetal = getComponentType(rec.bodyMetalTypeId);
  const engineType = getComponentType(rec.engineTypeId);
  const recoveryType = rec.hasRecovery === false ? null : getComponentType(rec.recoveryTypeId);
  
  if (!fuelType || !bodyMetal || !engineType) {
    return { infeasible: true, reason: 'Missing or unresolved type reference.', warnings };
  }
  
  const tankH = rec.fuel.tankHeight;
  const tankW = rec.fuel.tankWidth;
  const fuelDensity = fuelType.parameterSchema.find(p => p.key === 'propellantDensity').value;
  const bodyDensity = bodyMetal.parameterSchema.find(p => p.key === 'density').value;
  
  // Fuel mass + body (cylindrical tank as the vehicle body).
  // Fuel mass + body (cylindrical tank as the vehicle body). Shell factor
// from the record's own field, falling back to the constant for any
// record that somehow lacks it (shouldn't happen post-migration).
const shellF = Number.isFinite(rec.bodyShellFactor) ? rec.bodyShellFactor : BODY_SHELL_FACTOR;
const tankVolume = Math.PI * (tankW / 2) ** 2 * tankH;
const fuelMass = tankVolume * fuelDensity;
const bodyMass = tankVolume * shellF * bodyDensity;

  // Engines — mass-flow-weighted aggregation.
  const groups = engineThrusterGroups(engineType);
  let totalEngineThrust = 0,
    totalEngineMass = 0,
    sumFlow = 0,
    sumFlowVe = 0;
  Object.keys(groups).forEach(gk => {
    const count = groups[gk].length;
    const g = rec.engineThrusters && rec.engineThrusters[gk];
    if (!g) return;
    const t = getComponentType(g.thrusterTypeId);
    if (!t) return;
    const flow = g.massFlowRate;
    const ve = t.parameterSchema.find(p => p.key === 've').value;
    const thrustPer = flow * ve;
    const massPer = engineMassFromThrust(t, thrustPer);
    totalEngineThrust += thrustPer * count;
    totalEngineMass += (Number.isFinite(massPer) ? massPer : 0) * count;
    sumFlow += flow * count;
    sumFlowVe += flow * ve * count;
  });
  const effectiveVe = sumFlow > 0 ? sumFlowVe / sumFlow : 0;
  
  // Legs — same formula as stage (same metal as body).
  // Legs — same volume formula as stage, but density comes from the
// vehicle's own legsMetalTypeId now, not the body's. Falls back to the
// body metal type if legsMetalTypeId is missing/unresolved (legacy
// records, or a hand-edited record), preserving pre-fix behavior for
// anything the migration didn't touch.
let legMass = 0;
if (recoveryType && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle &&
  recoveryType.frame && typeof recoveryType.frame.structuralVolume === 'function') {
  const legsMetal = (typeof getComponentType === 'function') ?
    (getComponentType(rec.legsMetalTypeId) || bodyMetal) :
    bodyMetal;
  const legDensity = (legsMetal && legsMetal.parameterSchema.find(p => p.key === 'density')) ?
    legsMetal.parameterSchema.find(p => p.key === 'density').value :
    bodyDensity;
  const legCount = recoveryType.frame.legCount || 0;
  const oneLegVol = recoveryType.frame.structuralVolume(tankH, tankW);
  legMass = oneLegVol * legCount * legDensity;
}
  
  // ---- Interstage mass (H-0c) ----
  // Black cylinder at the booster's top, sized to cover the stage engine
  // above. Height = max(stage-above bellHeight × 1.20, 6% booster height).
  // Mass = thin-shell cylindrical volume × metal density.
  //
  // BUG #4/#5 FIX: the stage-above used to be looked up ONLY from the
  // simulation page's global SIM_STACK_MEMBERS — so this booster's actual
  // stack neighbour on the Fleet/Stacks page (where SIM_STACK_MEMBERS
  // doesn't exist) was invisible, always falling back to the flat 6%
  // estimate no matter what was really stacked above it. Callers that know
  // their stack order (stackCombinedAggregates, stack validation, the
  // stack-editor UI, and the simulator's own massProps.js) now pass the
  // real neighbour explicitly via `aboveMember`. `undefined` (old
  // call-sites not yet updated) still falls back to the SIM_STACK_MEMBERS
  // global for backward compatibility; explicit `null` means "definitely
  // no member above" (e.g. a standalone booster preview).
  // Interstage dimensions — either the FROZEN value from the stack record
// (preferred: set once when the stack was saved, never changes during
// flight), or the legacy fallback (compute from `aboveMember` or the
// SIM_STACK_MEMBERS global). Same physical formula in both paths; the
// only difference is WHEN it runs.
let interstageH_m, interstageMass;
if (frozenInterstage && Number.isFinite(frozenInterstage.height) && Number.isFinite(frozenInterstage.mass)) {
  interstageH_m = frozenInterstage.height;
  interstageMass = frozenInterstage.mass;
} else {
  let above = aboveMember;
  if (above === undefined) {
    above = null;
    if (typeof SIM_STACK_MEMBERS !== 'undefined' && SIM_STACK_MEMBERS.length) {
      const idx = SIM_STACK_MEMBERS.findIndex(x => x.id === rec.id);
      if (idx >= 0 && idx + 1 < SIM_STACK_MEMBERS.length) above = SIM_STACK_MEMBERS[idx + 1];
    }
  }
  const computed = computeInterstageForBooster(rec, above);
  interstageH_m = computed.height;
  interstageMass = computed.mass;
}

  const dryMass = bodyMass + totalEngineMass + legMass + interstageMass;
  const wetMass = dryMass + fuelMass;
  
  return {
    fuelMass,
    bodyMass,
    totalEngineMass,
    legMass,
    interstageMass,
    interstageHeight: interstageH_m,
    dryMass,
    wetMass,
    effectiveVe,
    totalEngineThrust,
    tankVolume,
    infeasible: false,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Stage ↔ booster compatibility (Phase 3 §1.6 + §1.16).
//   §1.6  — S.width ≤ B.width  (taper allowed)
//   §1.16 — S.totalWetMassAtMaxPayload ≤ B.maxExtraWeightKg
// Always computed LIVE from the current fleet — never cached on the stage
// record (§1.4). Returns { compatible, incompatible } where incompatible
// entries carry a human-readable `reasons` array.
// ---------------------------------------------------------------------------
function compatibleBoostersForStage(stage, fleet) {
  const compatible = [],
    incompatible = [];
  if (!stage || stage.stageRole !== 'stage') return { compatible, incompatible };
  
  const d = stageDerivedMasses(stage);
  const infeasible = !d || d.infeasible;
  const stageWetMass = infeasible ? null : d.totalWetMassAtMaxPayload;
  
  (fleet || []).forEach(b => {
    if (!b || b.stageRole !== 'booster') return;
    const reasons = [];
    if (stage.width > b.width) {
      reasons.push(`width ${stage.width} m > booster ${b.width} m`);
    }
    if (infeasible) {
      reasons.push('stage infeasible — no payload capacity');
    } else if (stageWetMass > (b.maxExtraWeightKg || 0)) {
      reasons.push(`stage wet mass ${_fmtMassShort(stageWetMass)} > booster cap ${_fmtMassShort(b.maxExtraWeightKg || 0)}`);
    }
    if (reasons.length) incompatible.push({ booster: b, reasons });
    else compatible.push(b);
  });
  return { compatible, incompatible };
}

// ---------------------------------------------------------------------------
// Stack member own mass (Phase 3 §1.16 — corrected).
//   stage       → dryMassNoPayload + fuelMass — the stage's OWN hardware +
//                 propellant, with NO payload assumed. Real cargo is tracked
//                 separately via the stack's own `payloadId` (see
//                 validateStack()/stackCombinedAggregates(), and the live
//                 sim's _bodyPayloadMass() in physics.js). Using
//                 totalWetMassAtMaxPayload here was wrong: it silently
//                 assumed the stage was loaded to its MAX theoretical
//                 capacity even when no payload (or a smaller one) was
//                 actually assigned, inflating every total-mass / booster-
//                 capacity number that read through this function. The
//                 max-capacity number is still available separately via
//                 stageDerivedMasses().totalWetMassAtMaxPayload for the
//                 "which boosters COULD this stage fit under" advisory
//                 check (see compatibleBoostersForStage(), unchanged).
//   booster     → boosterDerivedMasses().wetMass
//   rocket      → dryMass + fuelMassMax (flat, like before)
//   nose        → computeNoseDryMass() (cone metal mass)
//   payloadSpace→ computePayloadSpaceDryMass() (fairing's own structural mass;
//                 the cargo it carries is added separately, same as stage).
// Returns NaN for an infeasible stage.
// ---------------------------------------------------------------------------
function stackMemberOwnMass(member, aboveMember) {
  if (!member) return NaN;
  if (member.stageRole === 'stage') {
    const d = stageDerivedMasses(member);
    if (!d || d.infeasible) return NaN;
    return d.dryMassNoPayload + d.fuelMass;
  }
  if (member.stageRole === 'booster') {
    const d = boosterDerivedMasses(member, aboveMember);
    if (!d) return NaN;
    return d.wetMass;
  }
  if (member.stageRole === 'nose') {
    return computeNoseDryMass(member);
  }
  
  if (member.stageRole === 'payloadSpace') {
    return computePayloadSpaceDryMass(member);
  }
  
  const dry = Number.isFinite(member.dryMass) ? member.dryMass : 0;
  const fuel = Number.isFinite(member.fuelMassMax) ? member.fuelMassMax : 0;
  return dry + fuel;
}

// ---------------------------------------------------------------------------
// Stack validation (Phase 3 §1.6 / §1.11 / §1.16, extended recursively).
//
// Rules enforced (all live, nothing cached):
//   §1.11 — bottom member MUST be 'booster'; every member above must be
//           'booster' or 'stage' (nose allowed on top, rocket never).
//   §1.6  — adjacent widths: upper.width ≤ lower.width (taper allowed).
//   §1.16 — for each member, CUMULATIVE mass of everything above it must
//           fit within that member's maxExtraWeightKg (recursive N-stage).
//
// NOTE (PS-B2): 'payloadSpace' isn't in the allowed-roles-above-another-
// member list yet — PS-D1 explicitly owns adding that rule (top-most only).
// A stack that now contains a split-off fairing will show as invalid here
// until PS-D1 lands; that's a cosmetic "X ERR" badge only — getActiveStack()
// doesn't gate on validity, so the stack still flies (see PS-D2 for wiring
// the fairing into the live render/mass pipeline properly).
//
// Returns { valid, errors, stackTotalHeight, stackTotalMass, memberInfo }.
// ---------------------------------------------------------------------------
function validateStack(members, fleet, stack) {
  fleet = fleet || loadFleet();
  const errors = [];
  const memberInfo = [];
  
  if (!Array.isArray(members) || members.length === 0) {
    return { valid: false, errors: ['Stack has no members.'], stackTotalHeight: 0, stackTotalMass: 0, memberInfo: [] };
  }
  
  const resolved = members.map((id, i) => {
    const rec = fleet.find(r => r.id === id);
    if (!rec) errors.push(`Member ${i + 1}: fleet record "${id}" not found.`);
    return rec || null;
  });
  
  // I-c1: if this stack has a payload assigned, verify it still fits.
  if (stack && stack.payloadId) {
    const pl = (typeof getPayload === 'function') ? getPayload(stack.payloadId) : null;
    if (!pl) {
      errors.push(`Payload "${stack.payloadId}" not found.`);
    } else {
      const check = payloadCompatibilityCheck(pl, members, fleet);
      if (!check.ok) check.reasons.forEach(r => errors.push(`Payload: ${r}`));
    }
  }
  
  if (resolved[0] && resolved[0].stageRole !== 'booster') {
    errors.push(`Bottom member must be a booster (got "${resolved[0].stageRole || 'unknown'}").`);
  }
  
  
  // SEQ-2: preset sequences enforce their exact role order. Custom
  // sequences fall through to the general rules below.
  const PRESET_ROLES = {
    'f9-standard': ['booster', 'stage', 'payloadSpace'],
    'f9-heavy': ['booster', 'stage', 'stage', 'payloadSpace'],
    'sso': ['booster', 'payloadSpace'],
  };
  const seq = stack && stack.sequence;
  if (PRESET_ROLES[seq]) {
    const expected = PRESET_ROLES[seq];
    if (resolved.length !== expected.length) {
      errors.push(`Sequence "${seq}" expects ${expected.length} members (${expected.join(' → ')}); got ${resolved.length}.`);
    } else {
      resolved.forEach((r, i) => {
        if (!r) return;
        if (r.stageRole !== expected[i]) {
          errors.push(`Member ${i + 1} should be '${expected[i]}' for preset "${seq}" (got "${r.stageRole}").`);
        }
      });
    }
  }
  
  
  const TOP = resolved.length - 1;
  resolved.forEach((r, i) => {
    if (!r) return;
    if (r.stageRole === 'rocket') {
      errors.push(`Member ${i + 1}: 'rocket' role can't be part of a stack.`);
      return;
    }
    if (r.stageRole === 'payloadSpace') {
      // PS-D1: payload space is allowed ONLY as the top-most member.
      if (i !== TOP) {
        errors.push(`Member ${i + 1}: 'payloadSpace' must be the top-most member.`);
      }
      return;
    }
    if (i > 0 && r.stageRole !== 'stage' && r.stageRole !== 'booster' && r.stageRole !== 'nose') {
      errors.push(`Member ${i + 1}: only 'stage' / 'booster' / 'nose' can sit above another member.`);
    }
  });
  
  const ownMasses = resolved.map((r, i) => r ? stackMemberOwnMass(r, resolved[i + 1] || null) : NaN);
  const loadAbove = new Array(resolved.length).fill(0);
  for (let i = resolved.length - 2; i >= 0; i--) {
    loadAbove[i] = loadAbove[i + 1] + (Number.isFinite(ownMasses[i + 1]) ? ownMasses[i + 1] : 0);
  }
  
  for (let i = 0; i < resolved.length - 1; i++) {
    const lower = resolved[i],
      upper = resolved[i + 1];
    if (!lower || !upper) continue;
    
    // PS-D1 fix: for a payloadSpace (fairing), the BASE diameter (capWidth)
    // is what must fit the member below — the bulge overhangs by design.
    // Comparing the record's stored `width` (which is bulgeWidth for bulged
    // shapes) would wrongly reject a correctly-designed fairing.
    let upperWidth = upper.width;
    if (upper.stageRole === 'payloadSpace' && upper.params &&
      Number.isFinite(upper.params.capWidth)) {
      upperWidth = upper.params.capWidth;
    }
    
    const widthOk = upperWidth <= lower.width;
    if (!widthOk) {
      errors.push(`Width: "${upper.name}" base (${upperWidth} m) > "${lower.name}" (${lower.width} m).`);
    }
    
    const cap = Number.isFinite(lower.maxExtraWeightKg) ? lower.maxExtraWeightKg : 0;
    const load = loadAbove[i];
    const loadOk = Number.isFinite(load) && load <= cap;
    if (!loadOk) {
      errors.push(`Mass: load above "${lower.name}" (${_fmtMassShort(load)}) > its cap (${_fmtMassShort(cap)}).`);
    }
    memberInfo.push({ record: lower, ownMass: ownMasses[i], loadAbove: load, widthOk, loadOk });
  }
  if (resolved.length > 0) {
    const top = resolved[resolved.length - 1];
    if (top) {
      memberInfo.push({ record: top, ownMass: ownMasses[resolved.length - 1], loadAbove: 0, widthOk: true, loadOk: true });
    }
  }
  
  const stackTotalHeight = resolved.reduce((s, r) => s + ((r && Number.isFinite(r.height)) ? r.height : 0), 0);
  let stackTotalMass = ownMasses.reduce((s, m) => s + (Number.isFinite(m) ? m : 0), 0);
  
  // Real assigned cargo (if any) rides on top of every member's own mass —
  // the same number the live sim actually flies with (_bodyPayloadMass() in
  // physics.js). Without this, stackTotalMass only reflected empty hardware
  // even when a payload was assigned to the stack.
  if (stack && stack.payloadId && typeof getPayload === 'function') {
    const pl = getPayload(stack.payloadId);
    if (pl && Number.isFinite(pl.mass)) stackTotalMass += pl.mass;
  }
  
  return {
    valid: errors.length === 0,
    errors,
    stackTotalHeight,
    stackTotalMass,
    memberInfo,
  };
}


// Phase 4 (P4-B3): nose dry mass = cone volume × shell factor × metal
// density. Curveness affects the visual silhouette but not the mass
// (simplification — the user confirmed cone-volume is fine for now).
function computeNoseDryMass(rec) {
  if (!rec || rec.stageRole !== 'nose') return 0;
  const metal = getComponentType(rec.bodyMetalTypeId);
  if (!metal) return 0;
  const density = metal.parameterSchema.find(p => p.key === 'density').value;
  const H = rec.height || 0,
    W = rec.width || 0;
  const coneVolume = (1 / 3) * Math.PI * Math.pow(W / 2, 2) * H;
  return coneVolume * BODY_SHELL_FACTOR * density;
}

// PS-E: standalone payloadSpace (fairing) dry mass — structural shell
// volume × its own metal density. structuralVolume() is the type's own
// formula (same pattern as legs), so a new fairing kind works with zero
// changes here. Returns 0 if the type/metal can't be resolved.
function computePayloadSpaceDryMass(rec) {
  if (!rec || rec.stageRole !== 'payloadSpace') return 0;
  const type = getComponentType(rec.payloadSpaceTypeId);
  const metal = getComponentType(rec.payloadSpaceMetalTypeId);
  if (!type || !metal) return 0;
  if (!type.frame || typeof type.frame.structuralVolume !== 'function') return 0;
  const density = metal.parameterSchema.find(p => p.key === 'density').value;
      const p = rec.params || {};
  const capH = Number.isFinite(p.capHeight) ? p.capHeight : 0;
  const capW = Number.isFinite(p.capWidth) ? p.capWidth : (rec.width || 0);
  // bulgeWidth defaults to capWidth — same as the renderer's no-bulge
  // fallback, so a record without bulgeWidth still produces a valid
  // straight-sided shape's volume rather than NaN.
  const bulgeW = Number.isFinite(p.bulgeWidth) ? p.bulgeWidth : capW;
  // Per-record shell factor — F9-calibrated default if absent.
  const shellF = Number.isFinite(rec.bodyShellFactor) ?
    rec.bodyShellFactor :
    DEFAULT_SHELL_FACTOR_BY_ROLE.payloadSpace;
  return type.frame.structuralVolume(capH, capW, bulgeW, shellF) * density;
 }




// PS-B3 — payloadSpace dimensions helper. Reads the ACTUAL rendered
// footprint off a standalone payloadSpace record: height = capHeight
// (total fairing height, base to tip); width = the widest diameter, which
// for a bulged shape is the bulge itself, not the base. Needed wherever
// something wants this member's true silhouette — stack-width taper
// checks (PS-D1) and stack preview scaling (renderStackPreview already
// reads member.height/width directly, which the blank/migration factories
// keep in sync with these params, but a form that edits params in place
// without touching height/width would otherwise drift — this is the
// single source of truth to recompute from).
//
// Branches on type.kind, not type.id (Rule 1) — a new bulged-family shape
// needs zero changes here, only its own `kind`.
function payloadSpaceDimensions(rec) {
  if (!rec || rec.stageRole !== 'payloadSpace') return { height: 0, width: 0 };
  const p = rec.params || {};
  const height = Number.isFinite(p.capHeight) ? p.capHeight : (rec.height || 0);
  const capWidth = Number.isFinite(p.capWidth) ? p.capWidth : (rec.width || 0);
  const bulgeWidth = Number.isFinite(p.bulgeWidth) ? p.bulgeWidth : capWidth;
  return { height, width: Math.max(capWidth, bulgeWidth) };
}


// ---------------------------------------------------------------------------
// Thruster-group helpers (Phase 3 Step B).
//
// A single engine layout can hold slots with DIFFERENT capabilities — the
// octaweb's 1 gimbal-capable center engine vs 8 fixed outer engines is the
// canonical case. §2.2 says: one thruster dropdown per DISTINCT
// `gimbalCapable` value the layout's slots contain. This function derives
// those groups generically from the layout's own slot list, so a brand-new
// layout with the same boolean but a different shape still gets the right
// number of dropdowns with zero changes.
//
// (When 2+ distinct "kinds" are needed in one layout someday, §2.2 flags
// that an explicit `slotKind` string on slots would replace the
// gimbalCapable boolean as the discriminator — currently out of scope.)
// ---------------------------------------------------------------------------
function engineThrusterGroups(engineType) {
  const groups = {};
  if (!engineType || !engineType.frame || !engineType.frame.slots) return groups;
  engineType.frame.slots.forEach(slot => {
    const key = slot.gimbalCapable ? 'gimbal' : 'fixed';
    (groups[key] = groups[key] || []).push(slot);
  });
  return groups;
}

// Backfill the new engineThrusters / rcsThruster sub-records for records
// that predate them (Phase 1/2 records, or the default seed): derive the
// initial mass-flow-rate from whatever flat engineFMax/engineVe (or RCS
// equivalents) were already in `params`, so a migrated record reproduces
// the SAME thrust profile it had before the fix.
function backfillThrusterRecords(rec, defaults) {
  const engineType = (typeof getComponentType === 'function') ? getComponentType(rec.engineTypeId) : null;
  if (engineType && !rec.engineThrusters) {
    const groups = engineThrusterGroups(engineType);
    const seedVe = (rec.params && rec.params.engineVe) || 2900;
    const seedFMax = (rec.params && rec.params.engineFMax) || 600000;
    const seedFlow = seedVe > 0 ? seedFMax / seedVe : 207;
    const seedType = (defaults && defaults.engineThrusters && defaults.engineThrusters.gimbal) ?
      defaults.engineThrusters.gimbal.thrusterTypeId : 'merlin-1d-class';
    rec.engineThrusters = {};
    Object.keys(groups).forEach(gk => {
      rec.engineThrusters[gk] = { thrusterTypeId: seedType, massFlowRate: seedFlow };
    });
  }
  // PS-B2: only backfill an rcsThruster for a record that actually
  // references an RCS type. Previously this ran unconditionally, which
  // meant a nose (rcsTypeId should be null) silently gained a phantom
  // cold-gas thruster nobody ever fires — same class of bug as the
  // rcsTopY backfill fixed in migrateRocketRecord above, and the same fix
  // keeps a fresh 'payloadSpace' record clean too.
  if (!rec.rcsThruster && rec.rcsTypeId) {
    const seedVe = (rec.params && rec.params.rcsVe) || 2200;
    const seedThrust = (rec.params && rec.params.rcsThrust) || 1100;
    const seedType = (defaults && defaults.rcsThruster) ? defaults.rcsThruster.thrusterTypeId : 'cold-gas-small';
    rec.rcsThruster = {
      thrusterTypeId: seedType,
      massFlowRate: seedVe > 0 ? seedThrust / seedVe : 0.5,
    };
  }
}

// Transitional bridge: recompute the flat `params.engineFMax` / engineVe /
// gimbal / throttle / rcs* keys FROM the resolved thruster sub-records, so
// config.js and the running sim keep working unchanged while Steps C/D/E
// migrate them off these flat keys. Weighted average for engineVe, and
// per-engine Fmax averaged across groups so `engineFMax × engineCount` in
// rocketCapabilities() still yields the correct TOTAL max thrust.
function bridgePerfParams(rec) {
  if (!rec || !rec.engineThrusters) return;
  const engineType = (typeof getComponentType === 'function') ? getComponentType(rec.engineTypeId) : null;
  if (!engineType) return;
  const groups = engineThrusterGroups(engineType);
  if (!rec.params) rec.params = {};
  
  let totalThrust = 0,
    totalEngines = 0,
    sumFlowVe = 0,
    sumFlow = 0;
  let gimbalThruster = null,
    gimbalFlow = 0;
  
  Object.keys(groups).forEach(gk => {
    const slots = groups[gk];
    const g = rec.engineThrusters[gk];
    if (!g) return;
    const t = getComponentType(g.thrusterTypeId);
    if (!t || !Number.isFinite(g.massFlowRate)) return;
    const veEntry = t.parameterSchema.find(p => p.key === 've');
    const ve = veEntry ? veEntry.value : undefined;
    if (ve === undefined) return;
    const perEngineThrust = g.massFlowRate * ve;
    totalThrust += perEngineThrust * slots.length;
    totalEngines += slots.length;
    sumFlowVe += g.massFlowRate * ve * slots.length;
    sumFlow += g.massFlowRate * slots.length;
    if (gk === 'gimbal') { gimbalThruster = t;
      gimbalFlow = g.massFlowRate; }
  });
  
  if (totalEngines > 0) {
    rec.params.engineFMax = totalThrust / totalEngines;
    rec.params.engineVe = sumFlow > 0 ? sumFlowVe / sumFlow : rec.params.engineVe;
  }
  // Gimbal / throttle-floor / rate come from the gimbal-capable group (the
  // center engine) since those are the values the sim currently reads for
  // its single shared gimbal slider.
  if (gimbalThruster) {
    const valOf = (k) => {
      const e = gimbalThruster.parameterSchema.find(p => p.key === k);
      return e ? e.value : undefined;
    };
    const minFrac = valOf('minThrottleFrac');
    const maxRate = valOf('maxThrottleRateFrac');
    const gMax = valOf('gimbalMaxDeg');
    const gRate = valOf('gimbalRateDegS');
    if (minFrac !== undefined) rec.params.engineFMinFrac = minFrac;
    if (maxRate !== undefined) rec.params.engineThrustRate = maxRate;
    if (gMax !== undefined) rec.params.gimbalMaxDeg = gMax;
    if (gRate !== undefined) rec.params.gimbalRateDegS = gRate;
  }
  if (rec.rcsThruster) {
    const rt = (typeof getComponentType === 'function') ? getComponentType(rec.rcsThruster.thrusterTypeId) : null;
    if (rt && Number.isFinite(rec.rcsThruster.massFlowRate)) {
      const rve = rt.parameterSchema.find(p => p.key === 've');
      if (rve) {
        rec.params.rcsVe = rve.value;
        rec.params.rcsThrust = rec.rcsThruster.massFlowRate * rve.value;
      }
    }
  }
}


// ============================================================================
// PAYLOADS — Phase I. Satellites / cargo that ride inside a payloadSpace
// fairing. Stored in their own localStorage array (same pattern as fleet /
// families / stacks). A payload is NOT a stack member — it sits INSIDE a
// payloadSpace member and is deployed when that fairing splits.
// ============================================================================
const PAYLOADS_KEY = 'rocketSim.payloads.v1';

function loadPayloads() {
  try {
    const raw = localStorage.getItem(PAYLOADS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* fall through */ }
  return [];
}

function savePayloads(list) {
  localStorage.setItem(PAYLOADS_KEY, JSON.stringify(list));
}

function genPayloadId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function blankPayloadData() {
  return {
    id: null,
    name: 'New Payload',
    mass: 500, // kg
    height: 2, // m
    width: 1.5, // m
    dragCd: 0.3,
  };
}

function addPayload(data) {
  const list = loadPayloads();
  const rec = {
    id: genPayloadId(),
    name: (data && data.name ? String(data.name) : 'New Payload').trim() || 'New Payload',
    mass: Number.isFinite(data && data.mass) ? data.mass : 500,
    height: Number.isFinite(data && data.height) ? data.height : 2,
    width: Number.isFinite(data && data.width) ? data.width : 1.5,
    dragCd: Number.isFinite(data && data.dragCd) ? data.dragCd : 0.3,
  };
  list.push(rec);
  savePayloads(list);
  return rec;
}

function updatePayload(id, patch) {
  const list = loadPayloads();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return null;
  const merged = { ...list[idx], ...patch, id };
  list[idx] = merged;
  savePayloads(list);
  return merged;
}

function deletePayload(id) {
  let list = loadPayloads();
  const tgt = list.find(p => p.id === id);
  if (!tgt) return false;
  list = list.filter(p => p.id !== id);
  savePayloads(list);
  // Clear any payloadSpace.payloadId pointers that referenced this payload.
  const fleet = loadFleet();
  let touched = false;
  fleet.forEach(r => {
    if (r.payloadId === id) { r.payloadId = null;
      touched = true; }
  });
  if (touched) saveFleet(fleet);
  return true;
}

function getPayload(id) {
  if (!id) return null;
  return loadPayloads().find(p => p.id === id) || null;
}