// ============================================================================
// fleet.js — Shared data layer for the vehicle fleet (localStorage-backed).
// Loaded BEFORE config.js everywhere, so config.js can pull the selected
// rocket's parameters into CONFIG. Also used directly by rockets.js (fleet
// management page) and home.js (fleet summary on the console).
//
// A "rocket" record holds exactly the per-vehicle fields from config.js's
// "Vehicle geometry & mass" / "Main engines" / "RCS" / "Aerodynamics"
// sections. Universal/Earth and simulation constants stay global in
// config.js and are not part of a rocket record.
// ============================================================================

const FLEET_KEY = 'rocketSim.fleet.v1';
const SELECTED_KEY = 'rocketSim.selectedId.v1';

function defaultVehicleData() {
  return {
    id: 'falcon9-default',
    name: 'Falcon-9-Class (Default)',
    locked: true,               // seeded default: editable, not deletable
    height: 45, width: 3.9, dryMass: 23000, fuelMassMax: 400000,
    octaRadius: 1.7, engineFMax: 600000, engineFMinFrac: 0.4, engineVe: 2900,
    engineThrustRate: 0.5, gimbalMaxDeg: 20, gimbalRateDegS: 40,
    rcsThrust: 1100, rcsVe: 2200, rcsXOffset: 1.95,
    rcsTopMargin: 3, rcsBottomMargin: 3, rcsPwmPeriod: 0.3,
    dragCd: 0.6,
    legDeployRate: 0.5,
  };
}

function loadFleet() {
  try {
    const raw = localStorage.getItem(FLEET_KEY);
    if (raw) {
      const fleet = JSON.parse(raw);
      if (Array.isArray(fleet) && fleet.length) return fleet;
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
  const record = { ...data, id: genId(), locked: false };
  fleet.push(record);
  saveFleet(fleet);
  return record;
}

function updateRocket(id, data) {
  const fleet = loadFleet();
  const idx = fleet.findIndex(r => r.id === id);
  if (idx < 0) return null;
  fleet[idx] = { ...fleet[idx], ...data, id };
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
// ---------------------------------------------------------------------------
function rocketCapabilities(v) {
  const engineCount = 9; // fixed octaweb+center architecture for this program
  const totalMaxThrust = v.engineFMax * engineCount;
  const wetMass = v.dryMass + v.fuelMassMax;
  const mdotMax = totalMaxThrust / v.engineVe;
  const twrMax = totalMaxThrust / (wetMass * 9.8);
  const deltaV = v.engineVe * Math.log(wetMass / v.dryMass);
  const burnTimeS = mdotMax > 0 ? v.fuelMassMax / mdotMax : 0;
  return { engineCount, totalMaxThrust, wetMass, mdotMax, twrMax, deltaV, burnTimeS };
}
