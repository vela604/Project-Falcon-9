// ============================================================================
// vehicleAssemblies.js — persistent definitions for multi-core vehicles.
//
// This file deliberately does NOT connect an assembly to the flight model.
// The current simulator accepts one axial stack per physical body; enabling
// a multi-core assembly requires a separate, fail-closed runtime integration.
// Load after fleet.js so validation can use loadFleet/loadStacks/validateStack.
// ============================================================================

const VEHICLE_ASSEMBLIES_STORAGE_KEY = 'rocketSim.assemblies.v1';
const VEHICLE_ASSEMBLY_SCHEMA_VERSION = 1;
const VEHICLE_ASSEMBLY_TYPE_TRIPLE_CORE = 'triple-core';

let _vehicleAssembliesCache = null;

function loadVehicleAssemblies() {
  if (_vehicleAssembliesCache) return _vehicleAssembliesCache;
  try {
    const raw = localStorage.getItem(VEHICLE_ASSEMBLIES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _vehicleAssembliesCache = parsed;
        return parsed;
      }
    }
  } catch (err) {
    // Keep the corrupt value untouched for diagnosis; expose an empty store.
  }
  _vehicleAssembliesCache = [];
  return _vehicleAssembliesCache;
}

function saveVehicleAssemblies(assemblies) {
  if (!Array.isArray(assemblies)) {
    throw new TypeError('Vehicle assemblies must be an array.');
  }
  localStorage.setItem(VEHICLE_ASSEMBLIES_STORAGE_KEY, JSON.stringify(assemblies));
  _vehicleAssembliesCache = assemblies;
}

function _vehicleAssemblyId() {
  return 'asm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function _normalizeVehicleAssembly(data, id) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Assembly data must be an object.');
  }
  const type = data.type || VEHICLE_ASSEMBLY_TYPE_TRIPLE_CORE;
  if (type !== VEHICLE_ASSEMBLY_TYPE_TRIPLE_CORE) {
    throw new Error('Unsupported vehicle assembly type: ' + type);
  }
  const version = data.schemaVersion == null ? VEHICLE_ASSEMBLY_SCHEMA_VERSION : data.schemaVersion;
  if (version !== VEHICLE_ASSEMBLY_SCHEMA_VERSION) {
    throw new Error('Unsupported vehicle assembly schema version: ' + version);
  }
  const centralStackId = (typeof data.centralStackId === 'string') ? data.centralStackId.trim() : '';
  if (!centralStackId) throw new Error('Assembly requires a centralStackId.');
  if (!Array.isArray(data.sideCores) || data.sideCores.length !== 2) {
    throw new Error('A triple-core assembly requires exactly two side-core slots.');
  }

  const slots = {};
  data.sideCores.forEach((core) => {
    if (!core || typeof core !== 'object') throw new Error('Each side-core slot must be an object.');
    const slotId = core.slotId;
    const recordId = (typeof core.recordId === 'string') ? core.recordId.trim() : '';
    if (slotId !== 'left' && slotId !== 'right') {
      throw new Error('Side-core slotId must be "left" or "right".');
    }
    if (slots[slotId]) throw new Error('Duplicate side-core slot: ' + slotId);
    if (!recordId) throw new Error('Side-core slot "' + slotId + '" requires a recordId.');
    slots[slotId] = { slotId, recordId };
  });
  if (!slots.left || !slots.right) {
    throw new Error('A triple-core assembly must define both left and right side-core slots.');
  }

  return {
    id: id || data.id || _vehicleAssemblyId(),
    schemaVersion: VEHICLE_ASSEMBLY_SCHEMA_VERSION,
    type: VEHICLE_ASSEMBLY_TYPE_TRIPLE_CORE,
    name: (typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : 'Unnamed Triple-Core Assembly',
    centralStackId,
    sideCores: [slots.left, slots.right],
    locked: !!data.locked,
  };
}

function addVehicleAssembly(data) {
  const assemblies = loadVehicleAssemblies();
  const assembly = _normalizeVehicleAssembly(data);
  if (assemblies.some((item) => item && item.id === assembly.id)) {
    throw new Error('Vehicle assembly id already exists: ' + assembly.id);
  }
  assembly.locked = false;
  assemblies.push(assembly);
  saveVehicleAssemblies(assemblies);
  return assembly;
}

function updateVehicleAssembly(id, patch) {
  const assemblies = loadVehicleAssemblies();
  const index = assemblies.findIndex((item) => item && item.id === id);
  if (index < 0 || assemblies[index].locked) return null;
  const updated = _normalizeVehicleAssembly({ ...assemblies[index], ...(patch || {}) }, id);
  updated.locked = false;
  assemblies[index] = updated;
  saveVehicleAssemblies(assemblies);
  return updated;
}

function deleteVehicleAssembly(id) {
  const assemblies = loadVehicleAssemblies();
  const target = assemblies.find((item) => item && item.id === id);
  if (!target || target.locked) return false;
  saveVehicleAssemblies(assemblies.filter((item) => item && item.id !== id));
  return true;
}

function getVehicleAssembly(id) {
  return loadVehicleAssemblies().find((item) => item && item.id === id) || null;
}

function _assemblyCheckStack(label, members, fleet, stack, errors) {
  if (typeof validateStack !== 'function') {
    errors.push(label + ': validateStack() is unavailable; validation cannot proceed.');
    return null;
  }
  let result = null;
  try {
    result = validateStack(members, fleet, stack);
  } catch (err) {
    errors.push(label + ': stack validation threw: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
  if (!result || result.valid !== true) {
    const reasons = result && Array.isArray(result.errors) ? result.errors : [];
    if (reasons.length) reasons.forEach((reason) => errors.push(label + ': ' + reason));
    else errors.push(label + ': stack validation did not return valid=true.');
    return result;
  }
  if (!(Number.isFinite(result.stackTotalHeight) && result.stackTotalHeight > 0)) {
    errors.push(label + ': derived stack height must be finite and greater than zero.');
  }
  if (!(Number.isFinite(result.stackTotalMass) && result.stackTotalMass > 0)) {
    errors.push(label + ': derived stack mass must be finite and greater than zero.');
  }
  return result;
}

// Validate references without mutating storage or pruning missing records.
// Side cores are existing stageRole "rocket" fleet records (integrated nose),
// not boosters. Each must belong to the same family as the central stack's
// bottom booster. Reusing one rocket design record in both side slots is
// intentional: the future runtime must instantiate separate physical bodies
// and state for each. The fleet record itself is the design source; no
// persisted legacy stack record is required.
function validateVehicleAssembly(assembly, sources) {
  const errors = [];
  const fleet = sources && Array.isArray(sources.fleet) ? sources.fleet : loadFleet();
  const stacks = sources && Array.isArray(sources.stacks) ? sources.stacks : loadStacks();
  const result = {
    valid: false,
    errors,
    centralStack: null,
    centralValidation: null,
    sideCores: [],
  };

  if (!assembly || typeof assembly !== 'object' || Array.isArray(assembly)) {
    errors.push('Assembly record must be an object.');
    return result;
  }
  if (assembly.schemaVersion !== VEHICLE_ASSEMBLY_SCHEMA_VERSION) {
    errors.push('Unsupported assembly schemaVersion: ' + assembly.schemaVersion);
  }
  if (assembly.type !== VEHICLE_ASSEMBLY_TYPE_TRIPLE_CORE) {
    errors.push('Assembly type must be "triple-core".');
  }

  const centralStack = stacks.find((stack) => stack && stack.id === assembly.centralStackId) || null;
  result.centralStack = centralStack;
  let centralFamilyId = null;
  if (!centralStack) {
    errors.push('Central stack "' + assembly.centralStackId + '" was not found.');
  } else {
    const members = Array.isArray(centralStack.members) ? centralStack.members : [];
    const bottom = members.length ? fleet.find((record) => record && record.id === members[0]) : null;
    if (!bottom || bottom.stageRole !== 'booster') {
      errors.push('Central stack must begin with a valid booster record.');
    } else if (typeof bottom.familyId !== 'string' || !bottom.familyId.trim()) {
      errors.push('Central stack bottom booster must have a non-empty familyId.');
    } else {
      centralFamilyId = bottom.familyId;
    }
    result.centralValidation = _assemblyCheckStack(
      'Central stack', members, fleet, centralStack, errors
    );
  }

  if (!Array.isArray(assembly.sideCores) || assembly.sideCores.length !== 2) {
    errors.push('Assembly must contain exactly two side-core slots.');
  } else {
    const seenSlots = {};
    assembly.sideCores.forEach((slot) => {
      if (!slot || typeof slot !== 'object') {
        errors.push('Each side-core slot must be an object.');
        return;
      }
      const slotId = slot.slotId;
      if (slotId !== 'left' && slotId !== 'right') {
        errors.push('Unknown side-core slot: ' + slotId);
        return;
      }
      if (seenSlots[slotId]) {
        errors.push('Duplicate side-core slot: ' + slotId);
        return;
      }
      seenSlots[slotId] = true;
      const record = fleet.find((item) => item && item.id === slot.recordId) || null;
      result.sideCores.push({ slotId, recordId: slot.recordId || null, record });
      if (!record) {
        errors.push('Side-core ' + slotId + ': fleet record "' + slot.recordId + '" was not found.');
        return;
      }
      if (record.stageRole !== 'rocket') {
        errors.push('Side-core ' + slotId + ': record must have stageRole "rocket" (got "' + (record.stageRole || 'unknown') + '").');
        return;
      }
      if (!(typeof record.noseHeightM === 'number' && Number.isFinite(record.noseHeightM) && record.noseHeightM > 0)) {
        errors.push('Side-core ' + slotId + ': record must have a finite positive noseHeightM.');
      }
      if (typeof record.familyId !== 'string' || !record.familyId.trim()) {
        errors.push('Side-core ' + slotId + ': record must have a non-empty familyId.');
      } else if (centralFamilyId !== null && record.familyId !== centralFamilyId) {
        errors.push('Side-core ' + slotId + ': familyId "' + record.familyId + '" does not match the central stack bottom booster family "' + centralFamilyId + '".');
      }
      _assemblyCheckStack(
        'Side-core ' + slotId,
        [record.id],
        fleet,
        { sequence: 'legacy', payloadId: null },
        errors
      );
    });
    if (!seenSlots.left) errors.push('Side-core slot "left" is missing.');
    if (!seenSlots.right) errors.push('Side-core slot "right" is missing.');
  }

  result.valid = errors.length === 0;
  return result;
}
