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
const LEGACY_FAMILY_ID = 'fam-falcon9-default';   // the seeded Falcon-9 record's family
const UNASSIGNED_FAMILY_ID = 'fam-unassigned';    // orphan stages/noses awaiting a booster

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
    if (r.id === 'falcon9-default') {
      families.push({
        id: LEGACY_FAMILY_ID,
        name: 'Falcon-9-Class Family',
        bottomId: r.id,
        locked: true,
      });
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
    bottomId: (data && data.bottomId) || null,  // fleet-record id of the booster/rocket
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
const STAGE_ROLES = ['rocket', 'booster', 'stage', 'nose'];


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
    height: 45, width: 3.9, dryMass: 23000, fuelMassMax: 400000, dragCd: 0.6,
    engineTypeId: 'octaweb-merlin9',
    recoveryTypeId: 'legs-swingout-4',
    hasRecovery: true,
    rcsTypeId: 'rcs-4pod-2nozzle',
    engineThrusters: {
      gimbal: { thrusterTypeId: 'merlin-1d-class', massFlowRate: 207 },
      fixed:  { thrusterTypeId: 'merlin-1d-class', massFlowRate: 207 },
    },
    rcsThruster: { thrusterTypeId: 'cold-gas-small', massFlowRate: 0.5 },
    params: {
  octaRadius: 1.7, engineFMax: 600000, engineFMinFrac: 0.4, engineVe: 2900,
  engineThrustRate: 0.5, gimbalMaxDeg: 20, gimbalRateDegS: 40,
  legDeployRate: 0.5,
  rcsThrust: 1100, rcsVe: 2200, rcsXOffset: 1.95,
  rcsTopY: 42, rcsBottomY: 3, rcsPwmPeriod: 0.3,
},
    bodyDesign: { mode: 'solid', solidColor: '#e9edf2', dslText: '' },
  };
}


// ---------------------------------------------------------------------------
// Blank-record factories for the other two stage roles (Phase 3 §3). Both
// inherit the Falcon-9-class engine/legs/RCS baseline as a reasonable
// starting point — the builder (Step E) then lets the user swap any
// component type. Placeholder type ids below match the built-in seed
// registry (componentLibrary.js); a real registry with these ids removed
// would fall back gracefully, since getComponentType() returns null and
// the builder surfaces it as "no type selected".
// ---------------------------------------------------------------------------

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
    // now DERIVED (P4-C1), not manually entered.
    fuel: { typeId: 'rp1-lox', tankHeight: 45, tankWidth: 3.9 },
    bodyMetalTypeId: 'al-li-alloy',
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
    fuel: { typeId: 'rp1-lox', tankHeight: 10, tankWidth: 3.9 },
    bodyMetalTypeId: 'al-li-alloy',
    payloadSpace: {
      typeId: 'cap-standard',
      metalTypeId: 'al-li-alloy',
      deploymentDirection: 'clamshell',   // provisional — §5 enum still open
      params: { capHeight: 3, capWidth: 2.5 },
    },
    maxExtraWeightKg: 0,
  };
  // A stage has no manually-entered dry/fuel mass — those are computed live
  // from the ingredients above (PHASE3_PROMPT.md §3).
  delete out.dryMass;
  delete out.fuelMassMax;
  return out;
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
  // Both 'booster' and 'stage' carry maxExtraWeightKg — anything can be
  // stacked on top of either.
  if (stageRole === 'booster' || stageRole === 'stage') {
    out.maxExtraWeightKg = Number.isFinite(r.maxExtraWeightKg) ? r.maxExtraWeightKg : 0;
  }
  
  // Stage-only ingredient inputs. Step E's builder writes these; Step D's
  // migration ensures an existing (or partially-written) record is fully
  // populated so nothing downstream sees an undefined shape.
  if (stageRole === 'stage') {
    out.fuel = {
      typeId: (r.fuel && r.fuel.typeId) || 'rp1-lox',
      tankHeight: (r.fuel && Number.isFinite(r.fuel.tankHeight)) ? r.fuel.tankHeight : 10,
      tankWidth: (r.fuel && Number.isFinite(r.fuel.tankWidth)) ? r.fuel.tankWidth : 3.9,
    };
    out.bodyMetalTypeId = r.bodyMetalTypeId || 'al-li-alloy';
    out.payloadSpace = {
      typeId: (r.payloadSpace && r.payloadSpace.typeId) || 'cap-standard',
      metalTypeId: (r.payloadSpace && r.payloadSpace.metalTypeId) || 'al-li-alloy',
      deploymentDirection: (r.payloadSpace && r.payloadSpace.deploymentDirection) || 'clamshell',
      params: (r.payloadSpace && r.payloadSpace.params) ?
        { ...r.payloadSpace.params } :
        { capHeight: 3, capWidth: 2.5 },
    };
    out.payloadSpace = {
  typeId: (r.payloadSpace && r.payloadSpace.typeId) || 'cap-standard',
  metalTypeId: (r.payloadSpace && r.payloadSpace.metalTypeId) || 'al-li-alloy',
  deploymentDirection: (r.payloadSpace && r.payloadSpace.deploymentDirection) || 'clamshell',
  color: (r.payloadSpace && typeof r.payloadSpace.color === 'string') ? r.payloadSpace.color : '#e9edf2',
  params: (r.payloadSpace && r.payloadSpace.params)
    ? { ...r.payloadSpace.params }
    : { capHeight: 3, capWidth: 2.5 },
};
    // Stage masses are computed live, not stored — make sure no stale
    // manual-mass fields linger from a legacy record.
    if (stageRole === 'stage' || stageRole === 'nose') {
  delete out.dryMass;
  delete out.fuelMassMax;
}
if (stageRole === 'nose') {
  out.bodyMetalTypeId = r.bodyMetalTypeId || 'al-li-alloy';
  out.noseCurveness = Number.isFinite(r.noseCurveness) ? r.noseCurveness : 0;
  // A nose has no engines, no recovery type, no RCS hardware, no fuel
  // tank or payload space. Strip anything inherited from a default shape.
  out.engineTypeId = null;
  out.recoveryTypeId = null;
  out.hasRecovery = false;
  out.rcsTypeId = null;
  out.engineThrusters = null;
  out.rcsThruster = null;
  delete out.dryMass;      // computed live from cone volume
  delete out.fuelMassMax;
  delete out.params;
}
  }
  
  if (stageRole === 'booster') {
  out.fuel = {
    typeId: (r.fuel && r.fuel.typeId) || 'rp1-lox',
    tankHeight: (r.fuel && Number.isFinite(r.fuel.tankHeight)) ? r.fuel.tankHeight : 45,
    tankWidth:  (r.fuel && Number.isFinite(r.fuel.tankWidth))  ? r.fuel.tankWidth  : 3.9,
  };
  out.bodyMetalTypeId = r.bodyMetalTypeId || 'al-li-alloy';
  // Derived — no stored dryMass/fuelMassMax on a booster anymore.
  delete out.dryMass;
  delete out.fuelMassMax;
}
  
  FLAT_PARAM_KEYS.forEach(k => {
    if (r[k] !== undefined) out.params[k] = r[k];
  });
// P4-RCS-migration: rcsTopMargin → rcsTopY (bottom-anchored).
// Old rcsTopMargin measured DOWN from the top; new rcsTopY measures UP
// from the base. Convert once, then delete the legacy key.
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
if (!Number.isFinite(out.params.rcsTopY))    out.params.rcsTopY = defaults.params.rcsTopY;
if (!Number.isFinite(out.params.rcsBottomY)) out.params.rcsBottomY = defaults.params.rcsBottomY;

  backfillThrusterRecords(out, defaults);
  bridgePerfParams(out);
  return out;
}

function loadFleet() {
  try {
    const raw = localStorage.getItem(FLEET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const migrated = parsed.map(migrateRocketRecord);
        if (JSON.stringify(migrated) !== JSON.stringify(parsed)) saveFleet(migrated);
        return migrated;
      }
    }
  } catch (e) { /* fall through to seed */ }
  const seeded = [defaultVehicleData()];
  saveFleet(seeded);
  localStorage.setItem(SELECTED_KEY, seeded[0].id);
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
      if (Array.isArray(parsed)) return parsed;
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

function addStack(data) {
  const stacks = loadStacks();
  const rec = {
    id: genStackId(),
    name: (data && data.name ? String(data.name) : 'Unnamed Stack').trim() || 'Unnamed Stack',
    members: Array.isArray(data && data.members) ? [...data.members] : [],
    locked: false,
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
  if (!Array.isArray(merged.members)) merged.members = [];
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
    let dry = 0, fuel = 0;
    if (m.stageRole === 'booster') {
      const d = boosterDerivedMasses(m);
      if (d) { dry = d.dryMass; fuel = d.fuelMass; }
    } else if (m.stageRole === 'stage') {
      const d = stageDerivedMasses(m);
      if (d && !d.infeasible) { dry = d.dryMassNoPayload; fuel = d.fuelMass; }
      else if (d && d.reason) out.warnings.push(`member ${i + 1} (${m.name}): ${d.reason}`);
      else out.warnings.push(`member ${i + 1} (${m.name}): infeasible`);
    } else if (m.stageRole === 'nose') {
      dry = computeNoseDryMass(m);
    } else {
      // legacy rocket — flat fields
      dry = Number.isFinite(m.dryMass) ? m.dryMass : 0;
      fuel = Number.isFinite(m.fuelMassMax) ? m.fuelMassMax : 0;
    }
    out.dryMass += dry;
    out.fuelMass += fuel;
  });
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
    if (f.bottomId === id) { f.bottomId = null; touched = true; }
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
// ---------------------------------------------------------------------------
function rocketCapabilities(v) {
  // Phase 4 (P4-C1): booster uses derived masses — its dryMass/fuelMassMax
  // fields no longer exist on the record.
  if (v && v.stageRole === 'booster') {
    const d = boosterDerivedMasses(v);
    const engineType = getComponentType(v.engineTypeId);
    const engineCount = engineType ? engineType.frame.slots.length : 9;
    if (!d) return { engineCount, totalMaxThrust: 0, wetMass: 0, mdotMax: 0, twrMax: 0, deltaV: 0, burnTimeS: 0 };
    const mdotMax = d.effectiveVe > 0 ? d.totalEngineThrust / d.effectiveVe : 0;
    const twrMax = d.wetMass > 0 ? d.totalEngineThrust / (d.wetMass * 9.8) : 0;
    const deltaV = (d.wetMass > 0 && d.dryMass > 0) ? d.effectiveVe * Math.log(d.wetMass / d.dryMass) : 0;
    const burnTimeS = mdotMax > 0 ? d.fuelMass / mdotMax : 0;
    return {
      engineCount,
      totalMaxThrust: d.totalEngineThrust,
      wetMass: d.wetMass,
      mdotMax, twrMax, deltaV, burnTimeS,
    };
  }
  // ...existing rocket path unchanged...

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
// ---------------------------------------------------------------------------
function stageDerivedMasses(rec) {
  if (!rec || rec.stageRole !== 'stage') return null;
  const warnings = [];

  const fuelType       = getComponentType(rec.fuel && rec.fuel.typeId);
  const bodyMetalType  = getComponentType(rec.bodyMetalTypeId);
  const payloadType    = getComponentType(rec.payloadSpace && rec.payloadSpace.typeId);
  const payloadMetal   = getComponentType(rec.payloadSpace && rec.payloadSpace.metalTypeId);
  const engineType     = getComponentType(rec.engineTypeId);
  const recoveryType   = getComponentType(rec.recoveryTypeId);

  if (!fuelType || !bodyMetalType || !payloadType || !payloadMetal || !engineType) {
    return { infeasible: true, reason: 'Missing or unresolved type reference.', warnings };
  }

  const tankH = rec.fuel.tankHeight;
  const tankW = rec.fuel.tankWidth;
  const capParams = rec.payloadSpace.params || {};
  const capH = Number.isFinite(capParams.capHeight) ? capParams.capHeight : 0;
  const capW = Number.isFinite(capParams.capWidth) ? capParams.capWidth : tankW;
  const bulgeW = Number.isFinite(capParams.bulgeWidth) ? capParams.bulgeWidth : null;

  const fuelDensity    = fuelType.parameterSchema.find(p => p.key === 'propellantDensity').value;
  const bodyDensity    = bodyMetalType.parameterSchema.find(p => p.key === 'density').value;
  const payloadDensity = payloadMetal.parameterSchema.find(p => p.key === 'density').value;

  const tankVolume = Math.PI * (tankW / 2) ** 2 * tankH;
  const fuelMass = tankVolume * fuelDensity;
  const bodyMass = tankVolume * BODY_SHELL_FACTOR * bodyDensity;

  const groups = engineThrusterGroups(engineType);
  let totalEngineThrust = 0, totalEngineMass = 0, sumFlow = 0, sumFlowVe = 0;
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
    totalEngineMass   += (Number.isFinite(massPer) ? massPer : 0) * count;
    sumFlow   += flow * count;
    sumFlowVe += flow * ve * count;
  });
  const effectiveVe = sumFlow > 0 ? sumFlowVe / sumFlow : 0;

  const stageTotalHeight = tankH + capH;
  let legMass = 0;
  if (recoveryType && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle
      && recoveryType.frame && typeof recoveryType.frame.structuralVolume === 'function') {
    const legCount = recoveryType.frame.legCount || 0;
    const oneLegVol = recoveryType.frame.structuralVolume(stageTotalHeight, tankW);
    legMass = oneLegVol * legCount * bodyDensity;
  }

  let payloadContainerMass = 0;
  if (payloadType.frame && typeof payloadType.frame.structuralVolume === 'function') {
    const vol = (payloadType.kind === 'bulgedCapShape' && bulgeW !== null)
      ? payloadType.frame.structuralVolume(capH, capW, bulgeW)
      : payloadType.frame.structuralVolume(capH, capW);
    payloadContainerMass = vol * payloadDensity;
  }

  if (payloadType.kind === 'bulgedCapShape' && bulgeW !== null) {
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
    fuelMass, bodyMass, totalEngineMass, legMass, payloadContainerMass,
    dryMassNoPayload, effectiveVe, totalEngineThrust,
    maxPayloadMassFromDeltaV, maxPayloadMassFromThrust, maxPayloadMassKg,
    totalWetMassAtMaxPayload, stageTotalHeight, tankVolume,
    infeasible, warnings,
  };
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
function boosterDerivedMasses(rec) {
  if (!rec || rec.stageRole !== 'booster') return null;
  const warnings = [];

  const fuelType     = getComponentType(rec.fuel && rec.fuel.typeId);
  const bodyMetal    = getComponentType(rec.bodyMetalTypeId);
  const engineType   = getComponentType(rec.engineTypeId);
  const recoveryType = rec.hasRecovery === false ? null : getComponentType(rec.recoveryTypeId);

  if (!fuelType || !bodyMetal || !engineType) {
    return { infeasible: true, reason: 'Missing or unresolved type reference.', warnings };
  }

  const tankH = rec.fuel.tankHeight;
  const tankW = rec.fuel.tankWidth;
  const fuelDensity = fuelType.parameterSchema.find(p => p.key === 'propellantDensity').value;
  const bodyDensity = bodyMetal.parameterSchema.find(p => p.key === 'density').value;

  // Fuel mass + body (cylindrical tank as the vehicle body).
  const tankVolume = Math.PI * (tankW / 2) ** 2 * tankH;
  const fuelMass   = tankVolume * fuelDensity;
  const bodyMass   = tankVolume * BODY_SHELL_FACTOR * bodyDensity;

  // Engines — mass-flow-weighted aggregation.
  const groups = engineThrusterGroups(engineType);
  let totalEngineThrust = 0, totalEngineMass = 0, sumFlow = 0, sumFlowVe = 0;
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
    totalEngineMass   += (Number.isFinite(massPer) ? massPer : 0) * count;
    sumFlow   += flow * count;
    sumFlowVe += flow * ve * count;
  });
  const effectiveVe = sumFlow > 0 ? sumFlowVe / sumFlow : 0;

  // Legs — same formula as stage (same metal as body).
  let legMass = 0;
  if (recoveryType && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle
      && recoveryType.frame && typeof recoveryType.frame.structuralVolume === 'function') {
    const legCount = recoveryType.frame.legCount || 0;
    const oneLegVol = recoveryType.frame.structuralVolume(tankH, tankW);
    legMass = oneLegVol * legCount * bodyDensity;
  }

  // ---- Interstage mass (H-0c) ----
  // Black cylinder at the booster's top, sized to cover the stage engine
  // above. Height = max(stage-above bellHeight × 1.20, 6% booster height).
  // Mass = thin-shell cylindrical volume × metal density.
  // The stage-above is looked up from SIM_STACK_MEMBERS if loaded (sim /
  // preview with active stack); otherwise defaults to 6% (standalone).
  let stageAboveBellHeight = 0;
  if (typeof SIM_STACK_MEMBERS !== 'undefined' && SIM_STACK_MEMBERS.length) {
    const idx = SIM_STACK_MEMBERS.findIndex(x => x.id === rec.id);
    if (idx >= 0 && idx + 1 < SIM_STACK_MEMBERS.length) {
      const above = SIM_STACK_MEMBERS[idx + 1];
      if (above && above.engineTypeId) {
        const layoutAbove = getComponentType(above.engineTypeId);
        if (layoutAbove && layoutAbove.frame && layoutAbove.frame.slots) {
          const gAbove = engineThrusterGroups(layoutAbove);
          let totalFlow = 0;
          Object.keys(gAbove).forEach(gk => {
            const g = above.engineThrusters && above.engineThrusters[gk];
            if (!g || !Number.isFinite(g.massFlowRate)) return;
            totalFlow += g.massFlowRate * gAbove[gk].length;
          });
          const perEngine = totalFlow / layoutAbove.frame.slots.length;
          stageAboveBellHeight = 0.007 * perEngine;
        }
      }
    }
  }
  const interstageH_m = Math.max(stageAboveBellHeight * 1.20, 0.06 * tankH);
  const r_booster = tankW / 2;
  const shellThk = BODY_SHELL_FACTOR * r_booster;
  const interstageMass = 2 * Math.PI * r_booster * shellThk * interstageH_m * bodyDensity;

  const dryMass = bodyMass + totalEngineMass + legMass + interstageMass;
  const wetMass = dryMass + fuelMass;

  return {
    fuelMass, bodyMass, totalEngineMass, legMass, interstageMass,
    dryMass, wetMass,
    effectiveVe, totalEngineThrust,
    tankVolume,
    infeasible: false, warnings,
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
  const compatible = [], incompatible = [];
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
// Stack member own mass (Phase 3 §1.16).
//   stage   → totalWetMassAtMaxPayload (dry + fuel + max payload)
//   booster → boosterDerivedMasses().wetMass
//   rocket  → dryMass + fuelMassMax (flat, like before)
//   nose    → computeNoseDryMass() (cone metal mass)
// Returns NaN for an infeasible stage.
// ---------------------------------------------------------------------------
function stackMemberOwnMass(member) {
  if (!member) return NaN;
  if (member.stageRole === 'stage') {
    const d = stageDerivedMasses(member);
    if (!d || d.infeasible) return NaN;
    return d.totalWetMassAtMaxPayload;
  }
  if (member.stageRole === 'booster') {
    const d = boosterDerivedMasses(member);
    if (!d) return NaN;
    return d.wetMass;
  }
  if (member.stageRole === 'nose') {
    return computeNoseDryMass(member);
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
// Returns { valid, errors, stackTotalHeight, stackTotalMass, memberInfo }.
// ---------------------------------------------------------------------------
function validateStack(members, fleet) {
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

  if (resolved[0] && resolved[0].stageRole !== 'booster') {
    errors.push(`Bottom member must be a booster (got "${resolved[0].stageRole || 'unknown'}").`);
  }
  resolved.forEach((r, i) => {
    if (!r) return;
    if (r.stageRole === 'rocket') {
      errors.push(`Member ${i + 1}: 'rocket' role can't be part of a stack.`);
    } else if (i > 0 && r.stageRole !== 'stage' && r.stageRole !== 'booster' && r.stageRole !== 'nose') {
      errors.push(`Member ${i + 1}: only 'stage' / 'booster' / 'nose' can sit above another member.`);
    }
  });

  const ownMasses = resolved.map(r => r ? stackMemberOwnMass(r) : NaN);
  const loadAbove = new Array(resolved.length).fill(0);
  for (let i = resolved.length - 2; i >= 0; i--) {
    loadAbove[i] = loadAbove[i + 1] + (Number.isFinite(ownMasses[i + 1]) ? ownMasses[i + 1] : 0);
  }

  for (let i = 0; i < resolved.length - 1; i++) {
    const lower = resolved[i], upper = resolved[i + 1];
    if (!lower || !upper) continue;

    const widthOk = upper.width <= lower.width;
    if (!widthOk) {
      errors.push(`Width: "${upper.name}" (${upper.width} m) > "${lower.name}" (${lower.width} m).`);
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
  const stackTotalMass = ownMasses.reduce((s, m) => s + (Number.isFinite(m) ? m : 0), 0);

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
  const H = rec.height || 0, W = rec.width || 0;
  const coneVolume = (1 / 3) * Math.PI * Math.pow(W / 2, 2) * H;
  return coneVolume * BODY_SHELL_FACTOR * density;
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
    const seedType = (defaults && defaults.engineThrusters && defaults.engineThrusters.gimbal)
      ? defaults.engineThrusters.gimbal.thrusterTypeId : 'merlin-1d-class';
    rec.engineThrusters = {};
    Object.keys(groups).forEach(gk => {
      rec.engineThrusters[gk] = { thrusterTypeId: seedType, massFlowRate: seedFlow };
    });
  }
  if (!rec.rcsThruster) {
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

  let totalThrust = 0, totalEngines = 0, sumFlowVe = 0, sumFlow = 0;
  let gimbalThruster = null, gimbalFlow = 0;

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
    if (gk === 'gimbal') { gimbalThruster = t; gimbalFlow = g.massFlowRate; }
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