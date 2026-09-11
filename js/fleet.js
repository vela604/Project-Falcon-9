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

const FLEET_KEY = 'rocketSim.fleet.v1';
const SELECTED_KEY = 'rocketSim.selectedId.v1';

// Every param key that now lives under `params`, regardless of which
// component type owns it — used to pull legacy flat fields (or a
// not-yet-updated editor's flat submission) into the nested shape.
const FLAT_PARAM_KEYS = [
  'octaRadius', 'engineFMax', 'engineFMinFrac', 'engineVe', 'engineThrustRate',
  'gimbalMaxDeg', 'gimbalRateDegS', 'legDeployRate',
  'rcsThrust', 'rcsVe', 'rcsXOffset', 'rcsTopMargin', 'rcsBottomMargin', 'rcsPwmPeriod',
];

function defaultVehicleData() {
  return {
    id: 'falcon9-default',
    name: 'Falcon-9-Class (Default)',
    locked: true,               // seeded default: editable, not deletable
    height: 45, width: 3.9, dryMass: 23000, fuelMassMax: 400000, dragCd: 0.6,
    engineTypeId: 'octaweb-merlin9',
    recoveryTypeId: 'legs-swingout-4',
    rcsTypeId: 'rcs-4pod-2nozzle',
    params: {
      octaRadius: 1.7, engineFMax: 600000, engineFMinFrac: 0.4, engineVe: 2900,
      engineThrustRate: 0.5, gimbalMaxDeg: 20, gimbalRateDegS: 40,
      legDeployRate: 0.5,
      rcsThrust: 1100, rcsVe: 2200, rcsXOffset: 1.95,
      rcsTopMargin: 3, rcsBottomMargin: 3, rcsPwmPeriod: 0.3,
    },
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
  const out = {
    id: r.id,
    name: r.name,
    locked: !!r.locked,
    height: r.height !== undefined ? r.height : defaults.height,
    width: r.width !== undefined ? r.width : defaults.width,
    dryMass: r.dryMass !== undefined ? r.dryMass : defaults.dryMass,
    fuelMassMax: r.fuelMassMax !== undefined ? r.fuelMassMax : defaults.fuelMassMax,
    dragCd: r.dragCd !== undefined ? r.dragCd : defaults.dragCd,
    engineTypeId: r.engineTypeId || defaults.engineTypeId,
    recoveryTypeId: r.recoveryTypeId || defaults.recoveryTypeId,
    rcsTypeId: r.rcsTypeId || defaults.rcsTypeId,
    params: { ...defaults.params, ...(r.params || {}) },
  };
  // Flat legacy fields (top-level on `r`) win over whatever's already in
  // params — this is what lets an old-shape record OR a not-yet-migrated
  // editor submission (flat fields spread on top of an existing nested
  // record) land correctly.
  FLAT_PARAM_KEYS.forEach(k => {
    if (r[k] !== undefined) out.params[k] = r[k];
  });
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
  const engineType = (typeof getComponentType === 'function') ? getComponentType(v.engineTypeId) : null;
  const engineCount = engineType ? engineType.frame.slots.length : 9;
  const totalMaxThrust = v.params.engineFMax * engineCount;
  const wetMass = v.dryMass + v.fuelMassMax;
  const mdotMax = totalMaxThrust / v.params.engineVe;
  const twrMax = totalMaxThrust / (wetMass * 9.8);
  const deltaV = v.params.engineVe * Math.log(wetMass / v.dryMass);
  const burnTimeS = mdotMax > 0 ? v.fuelMassMax / mdotMax : 0;
  return { engineCount, totalMaxThrust, wetMass, mdotMax, twrMax, deltaV, burnTimeS };
}
