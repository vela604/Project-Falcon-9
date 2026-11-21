// ============================================================================
// assemblyPropulsion.js — Falcon Heavy Phase 1B.4: independent propulsion and
// fuel MODEL (calculation groundwork only).
//
// NOT flight-ready. This module is not connected to the flight worker, to
// state.bodies, or to the live physics loop, and it is not loaded by any page.
// It reads no storage and no implicit "selected assembly" global: every input
// (assembly, fleet, stacks) is passed in explicitly.
//
// What it provides
//   1. Engine packs: three independent engine arrays, in the fixed order
//      "center", "side-left", "side-right", each built by a separate call to
//      the existing buildEnginesForRecord(record) and then strictly validated.
//   2. Fuel-capacity descriptors for the three first-stage engine tanks
//      ("center:0", "side-left:0", "side-right:0").
//   3. A pure per-tank fuel-starvation planner (planFuelStarvation).
//   4. A pure helper for total displayed Heavy fuel (computeHeavyFuelTotals).
//
// Fuel concepts are deliberately kept distinct:
//   - central memberFuel[]  : the existing axial-stack fuel (centre core only).
//   - side fuel stores      : independent left / right fuel, never placed in
//                             the central memberFuel[].
//   - total displayed fuel  : a separate sum. It must never be assigned to the
//                             central body's fuelMass.
//
// Planner approximation (IMPORTANT): the scale returned for a tank is the
// AVERAGE availability over the whole fixed timestep dt, i.e.
//     scale = demand > 0 ? min(1, availableFuel / (demand * dt)) : 1
// It is an approximation of a tank running dry part-way through the tick
// (mid-tick cutoff). It is not an exact transient simulation. RK4 force
// integration and engine shutdown belong to the later physics-integration
// phase and are intentionally not implemented here.
//
// Immutability contract:
//   - memberMaxFuel() is given an EPHEMERAL COPY of each record made by
//     copyRecordForCapacity(): a shallow copy of the record plus, when
//     record._bdmCache is an object, a separate shallow copy of that cache
//     container (existing key/value preserved so a valid cache hit still works).
//     The production boosterDerivedMasses() reads rec._bdmCache.key and, on a
//     miss, WRITES rec._bdmCache.key / .value in place; those writes must land
//     on the copy's own cache object, never on the caller's Fleet record or its
//     nested cache. Nothing else is cloned (no deep copy of design data). The
//     centre still receives its actual next axial member (not copied) and side
//     cores an explicit literal null.
//   - Engine objects returned by buildEnginesForRecord() are validated and then
//     SHALLOW-CLONED before ownership metadata (coreInstanceId, memberId,
//     memberIndex, tankKey, uid) is attached. The builder's own objects are never
//     modified, so they may even be frozen or reused between builds. Nested
//     mutable objects shared between output engines are rejected.
//
// Dependencies are resolved at call time from an optional `deps` object, and
// otherwise from the globals validateVehicleAssembly, buildEnginesForRecord,
// memberMaxFuel and getComponentType. Only functions are taken from globals;
// data (assembly, fleet, stacks) is never taken from anywhere but the caller.
// ============================================================================
(function (root) {
  'use strict';

  const CORE_CENTER = 'center';
  const CORE_SIDE_LEFT = 'side-left';
  const CORE_SIDE_RIGHT = 'side-right';
  const CORE_IDS = Object.freeze([CORE_CENTER, CORE_SIDE_LEFT, CORE_SIDE_RIGHT]);
  const TANK_KEY_BY_CORE = Object.freeze({
    [CORE_CENTER]: 'center:0',
    [CORE_SIDE_LEFT]: 'side-left:0',
    [CORE_SIDE_RIGHT]: 'side-right:0',
  });
  const TANK_KEYS = Object.freeze(CORE_IDS.map((id) => TANK_KEY_BY_CORE[id]));
  const CENTER_TANK_KEY = TANK_KEY_BY_CORE[CORE_CENTER];
  const TANK_KEY_SET = new Set(TANK_KEYS);
  const ATTACHED_FIELDS = Object.freeze(['coreInstanceId', 'memberId', 'memberIndex', 'tankKey', 'uid']);

  // ------------------------------------------------------------------ helpers
  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
  function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function describe(v) {
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    return v === null ? 'null' : typeof v;
  }
  function failure(errors, extra) {
    return Object.assign({ ok: false, errors: errors.slice() }, extra || {});
  }

  function resolveDeps(deps, errors) {
    const d = isObject(deps) ? deps : {};
    const out = {};
    ['validateVehicleAssembly', 'buildEnginesForRecord', 'memberMaxFuel', 'getComponentType'].forEach((name) => {
      const fn = typeof d[name] === 'function' ? d[name] : (typeof root[name] === 'function' ? root[name] : null);
      if (!fn) errors.push('Required dependency "' + name + '" is unavailable.');
      out[name] = fn;
    });
    return out;
  }

  // ------------------------------------------------------------------- UIDs
  // uid = core | m<memberIndex> | memberId | s<slotIndex> | slotId. memberId
  // and slotId are percent-encoded so that a delimiter inside an identifier
  // can never make two different identities render to the same string; the
  // explicit slot index is further collision protection. engine.id is NOT
  // changed: it stays the component-library slot ID ("C", "E45", ...).
  function buildEngineUid(coreInstanceId, memberIndex, memberId, slotIndex, slotId) {
    return [
      String(coreInstanceId),
      'm' + String(memberIndex),
      encodeURIComponent(String(memberId)),
      's' + String(slotIndex),
      encodeURIComponent(String(slotId)),
    ].join('|');
  }

  function validateEngineUids(engines) {
    const errors = [];
    if (!Array.isArray(engines)) return ['Engine list must be an array.'];
    const seen = new Set();
    engines.forEach((engine, i) => {
      const uid = engine && engine.uid;
      if (!isNonEmptyString(uid)) { errors.push('Engine #' + i + ' has no valid uid.'); return; }
      if (seen.has(uid)) errors.push('Duplicate engine uid: ' + uid);
      seen.add(uid);
    });
    return errors;
  }

  // ------------------------------------------------------ core resolution
  // Validates the assembly (fail closed) and resolves the three core records.
  function resolveCores(input, errors) {
    if (!isObject(input)) { errors.push('Input must be an object { assembly, fleet, stacks }.'); return null; }
    const assembly = input.assembly;
    const fleet = input.fleet;
    const stacks = input.stacks;
    if (!isObject(assembly)) errors.push('assembly must be an object.');
    if (!Array.isArray(fleet)) errors.push('fleet must be an explicit array.');
    if (!Array.isArray(stacks)) errors.push('stacks must be an explicit array.');
    const deps = resolveDeps(input.deps, errors);
    if (errors.length) return null;

    let validation;
    try {
      validation = deps.validateVehicleAssembly(assembly, { fleet, stacks });
    } catch (err) {
      errors.push('Assembly validation threw: ' + (err && err.message ? err.message : String(err)));
      return null;
    }
    if (!validation || validation.valid !== true || !Array.isArray(validation.errors) || validation.errors.length !== 0) {
      const reasons = validation && Array.isArray(validation.errors) ? validation.errors : [];
      errors.push('Assembly validation failed.' + (reasons.length ? ' ' + reasons.join(' | ') : ''));
      return null;
    }

    const centralStack = validation.centralStack;
    const members = centralStack && Array.isArray(centralStack.members) ? centralStack.members : null;
    if (!members || members.length === 0) { errors.push('Central stack has no members.'); return null; }
    const centerRecord = fleet.find((r) => r && r.id === members[0]) || null;
    if (!isObject(centerRecord) || !isNonEmptyString(centerRecord.id)) {
      errors.push('Central stack bottom record "' + members[0] + '" was not found in the supplied fleet.');
      return null;
    }
    let centerNext = null;
    if (members.length > 1) {
      centerNext = fleet.find((r) => r && r.id === members[1]) || null;
      if (!isObject(centerNext)) {
        errors.push('Central stack next axial record "' + members[1] + '" was not found in the supplied fleet.');
        return null;
      }
    }

    const sideEntries = Array.isArray(validation.sideCores) ? validation.sideCores : [];
    const sideRecord = (slotId) => {
      const entry = sideEntries.find((s) => s && s.slotId === slotId);
      return entry && isObject(entry.record) ? entry.record : null;
    };
    const left = sideRecord('left');
    const right = sideRecord('right');
    if (!left) errors.push('Side-core "left" record could not be resolved.');
    if (!right) errors.push('Side-core "right" record could not be resolved.');
    [left, right].forEach((r, i) => {
      if (r && !isNonEmptyString(r.id)) errors.push('Side-core "' + (i ? 'right' : 'left') + '" record has no id.');
    });
    if (errors.length) return null;

    return {
      deps,
      fleet,
      cores: [
        { coreInstanceId: CORE_CENTER, memberId: centerRecord.id, memberIndex: 0, record: centerRecord, nextRecord: centerNext },
        { coreInstanceId: CORE_SIDE_LEFT, memberId: left.id, memberIndex: 0, record: left, nextRecord: null },
        { coreInstanceId: CORE_SIDE_RIGHT, memberId: right.id, memberIndex: 0, record: right, nextRecord: null },
      ],
    };
  }

  // ------------------------------------------------------ engine validation
  function validateLayoutSlots(label, layout, errors) {
    if (!isObject(layout)) { errors.push(label + ': engine layout does not exist.'); return null; }
    const slots = layout.frame && layout.frame.slots;
    if (!Array.isArray(slots) || slots.length === 0) {
      errors.push(label + ': engine layout frame.slots must be a non-empty array.');
      return null;
    }
    const seen = new Set();
    let ok = true;
    slots.forEach((slot, i) => {
      if (!isObject(slot) || !isNonEmptyString(slot.id)) {
        errors.push(label + ': layout slot #' + i + ' has a missing or empty id.');
        ok = false;
        return;
      }
      if (seen.has(slot.id)) {
        errors.push(label + ': duplicate layout slot id "' + slot.id + '".');
        ok = false;
      }
      seen.add(slot.id);
    });
    return ok ? slots : null;
  }

  function validateEngineNumbers(label, engine, errors) {
    const positive = ['Ve', 'veVacuum', 'maxMassFlowRate', 'Fmax'];
    const nonNegative = ['minMassFlowRate', 'Fmin', 'massFlowRate', 'targetMassFlowRate'];
    positive.forEach((k) => {
      if (!(isFiniteNumber(engine[k]) && engine[k] > 0)) {
        errors.push(label + ': ' + k + ' must be a finite number > 0 (got ' + describe(engine[k]) + ').');
      }
    });
    nonNegative.forEach((k) => {
      if (!(isFiniteNumber(engine[k]) && engine[k] >= 0)) {
        errors.push(label + ': ' + k + ' must be a finite number >= 0 (got ' + describe(engine[k]) + ').');
      }
    });
    if (isFiniteNumber(engine.minMassFlowRate) && isFiniteNumber(engine.maxMassFlowRate) &&
        engine.minMassFlowRate > engine.maxMassFlowRate) {
      errors.push(label + ': minMassFlowRate exceeds maxMassFlowRate.');
    }
    // Upper bounds: current and target flow may equal, but never exceed, the
    // engine maximum. Zero (idle) stays valid. Only checked when both sides are
    // finite numbers; non-finite values are already reported above.
    if (isFiniteNumber(engine.maxMassFlowRate) && engine.maxMassFlowRate > 0) {
      ['massFlowRate', 'targetMassFlowRate'].forEach((k) => {
        if (isFiniteNumber(engine[k]) && engine[k] > engine.maxMassFlowRate) {
          errors.push(label + ': ' + k + ' exceeds maxMassFlowRate (' + describe(engine[k]) + ' > ' + describe(engine.maxMassFlowRate) + ').');
        }
      });
    }
  }

  function buildPack(core, deps, errors) {
    const label = core.coreInstanceId + ' (' + core.memberId + ')';
    const before = errors.length;
    const record = core.record;

    let layout = null;
    try { layout = deps.getComponentType(record.engineTypeId); } catch (err) { layout = null; }
    const slots = validateLayoutSlots(label, layout, errors);
    if (!slots) return null;

    let built;
    try {
      built = deps.buildEnginesForRecord(record);
    } catch (err) {
      errors.push(label + ': buildEnginesForRecord threw: ' + (err && err.message ? err.message : String(err)));
      return null;
    }
    if (!Array.isArray(built)) { errors.push(label + ': buildEnginesForRecord did not return an array.'); return null; }

    // buildEnginesForRecord skips a slot whose thruster configuration is
    // missing or unresolved. That is never accepted here.
    if (built.length !== slots.length) {
      const have = new Set(built.map((e) => e && e.id));
      const missing = slots.filter((s) => !have.has(s.id)).map((s) => s.id);
      errors.push(label + ': expected ' + slots.length + ' engines (one per layout slot) but got ' + built.length +
        (missing.length ? '; missing slot(s): ' + missing.join(', ') + ' (invalid or missing thruster configuration?)' : '') + '.');
      return null;
    }
    slots.forEach((slot, i) => {
      const engine = built[i];
      const eLabel = label + ' slot "' + slot.id + '"';
      if (!isObject(engine)) { errors.push(eLabel + ': engine is not an object.'); return; }
      if (engine.id !== slot.id) {
        errors.push(eLabel + ': engine order does not match layout order (found id ' + describe(engine.id) + ' at index ' + i + ').');
        return;
      }
      ATTACHED_FIELDS.forEach((k) => {
        if (hasOwn(engine, k)) errors.push(eLabel + ': engine already defines reserved field "' + k + '".');
      });
      validateEngineNumbers(eLabel, engine, errors);
    });
    if (errors.length > before) return null;

    const tankKey = TANK_KEY_BY_CORE[core.coreInstanceId];
    // Shallow-clone every engine BEFORE attaching ownership metadata: the
    // objects returned by buildEnginesForRecord() are never mutated.
    const owned = [];
    try {
      built.forEach((source, i) => {
        const engine = { ...source };
        engine.coreInstanceId = core.coreInstanceId;
        engine.memberId = core.memberId;
        engine.memberIndex = core.memberIndex;
        engine.tankKey = tankKey;
        engine.uid = buildEngineUid(core.coreInstanceId, core.memberIndex, core.memberId, i, slots[i].id);
        owned.push(engine);
      });
    } catch (err) {
      errors.push(label + ': could not attach identity fields to engines: ' + (err && err.message ? err.message : String(err)));
      return null;
    }
    return {
      coreInstanceId: core.coreInstanceId,
      memberId: core.memberId,
      memberIndex: core.memberIndex,
      tankKey,
      recordId: record.id,
      engines: owned,
    };
  }

  function flattenEnginePacks(packs) {
    const out = [];
    if (!Array.isArray(packs)) return out;
    packs.forEach((pack) => { if (pack && Array.isArray(pack.engines)) pack.engines.forEach((e) => out.push(e)); });
    return out;
  }

  function buildPacksFromCores(resolved, errors) {
    const packs = [];
    resolved.cores.forEach((core) => {
      const pack = buildPack(core, resolved.deps, errors);
      if (pack) packs.push(pack);
    });
    if (errors.length) return null;

    // Cross-pack independence and uniqueness.
    const engines = flattenEnginePacks(packs);
    const seenObjects = new Set();
    engines.forEach((engine) => {
      if (seenObjects.has(engine)) errors.push('Engine object ' + engine.uid + ' is shared between packs.');
      seenObjects.add(engine);
      Object.keys(engine).forEach((k) => {
        const v = engine[k];
        if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
          if (seenObjects.has(v)) errors.push('Engine ' + engine.uid + ' shares mutable object "' + k + '" with another engine.');
          seenObjects.add(v);
        }
      });
    });
    validateEngineUids(engines).forEach((e) => errors.push(e));
    return errors.length ? null : packs;
  }

  function buildEnginePacks(input) {
    const errors = [];
    const resolved = resolveCores(input, errors);
    if (!resolved) return failure(errors, { packs: [], engines: [] });
    const packs = buildPacksFromCores(resolved, errors);
    if (!packs) return failure(errors, { packs: [], engines: [] });
    return { ok: true, errors: [], packs, engines: flattenEnginePacks(packs) };
  }

  // ------------------------------------------------------- fuel capacities
  // Ephemeral record copy for memberMaxFuel(). A bare { ...record } is NOT
  // enough: boosterDerivedMasses() mutates the NESTED rec._bdmCache object in
  // place (.key / .value), which the shallow copy would still share with the
  // Fleet record. So the cache container is copied too (key/value preserved).
  // Everything else stays shared by reference and is only read by production.
  function copyRecordForCapacity(record) {
    const copy = { ...record };
    if (isObject(record._bdmCache)) copy._bdmCache = { ...record._bdmCache };
    return copy;
  }

  function buildTanksFromCores(resolved, errors) {
    const tanks = [];
    resolved.cores.forEach((core) => {
      let capacity;
      try {
        // Each call receives an ephemeral copy of the record (including a
        // separate _bdmCache container, see copyRecordForCapacity) so that the
        // private cache write cannot mutate the caller's Fleet record.
        // Centre: its actual next axial member. Side cores: an EXPLICIT null
        // (never undefined) so boosterDerivedMasses() cannot consult the
        // central SIM_STACK_MEMBERS and inherit central-stack context.
        capacity = core.coreInstanceId === CORE_CENTER
          ? resolved.deps.memberMaxFuel(copyRecordForCapacity(core.record), core.nextRecord)
          : resolved.deps.memberMaxFuel(copyRecordForCapacity(core.record), null);
      } catch (err) {
        errors.push(core.coreInstanceId + ': memberMaxFuel threw: ' + (err && err.message ? err.message : String(err)));
        return;
      }
      if (!(isFiniteNumber(capacity) && capacity > 0)) {
        errors.push(core.coreInstanceId + ' (' + core.memberId + '): fuel capacity must be a finite number > 0 (got ' + describe(capacity) + ').');
        return;
      }
      tanks.push(Object.freeze({
        tankKey: TANK_KEY_BY_CORE[core.coreInstanceId],
        coreInstanceId: core.coreInstanceId,
        memberId: core.memberId,
        memberIndex: core.memberIndex,
        capacityKg: capacity,
      }));
    });
    return errors.length ? null : tanks;
  }

  function capacityMap(tanks) {
    const out = {};
    tanks.forEach((t) => { out[t.tankKey] = t.capacityKg; });
    return out;
  }

  function buildFuelCapacityDescriptors(input) {
    const errors = [];
    const resolved = resolveCores(input, errors);
    if (!resolved) return failure(errors, { tanks: [], capacityByTankKey: {} });
    const tanks = buildTanksFromCores(resolved, errors);
    if (!tanks) return failure(errors, { tanks: [], capacityByTankKey: {} });
    return { ok: true, errors: [], tanks, capacityByTankKey: capacityMap(tanks) };
  }

  // Convenience: engine packs + fuel descriptors from ONE validation pass.
  function buildAssemblyPropulsionModel(input) {
    const errors = [];
    const empty = { packs: [], engines: [], tanks: [], capacityByTankKey: {} };
    const resolved = resolveCores(input, errors);
    if (!resolved) return failure(errors, empty);
    const packs = buildPacksFromCores(resolved, errors);
    const tanks = buildTanksFromCores(resolved, errors);
    if (!packs || !tanks) return failure(errors, empty);
    return {
      ok: true,
      errors: [],
      packs,
      engines: flattenEnginePacks(packs),
      tanks,
      capacityByTankKey: capacityMap(tanks),
    };
  }

  // ------------------------------------------------------------ fuel totals
  // total = sum(centralMemberFuel) + sideLeftFuel + sideRightFuel.
  // Pure: reads its inputs only; the result must NOT be written to
  // body.fuelMass or into the central memberFuel[].
  function computeHeavyFuelTotals(input) {
    const errors = [];
    if (!isObject(input)) return failure(['Input must be an object.']);
    const central = input.centralMemberFuel;
    let center = 0;
    if (!Array.isArray(central) || central.length === 0) {
      errors.push('centralMemberFuel must be a non-empty array.');
    } else {
      central.forEach((v, i) => {
        if (!(isFiniteNumber(v) && v >= 0)) errors.push('centralMemberFuel[' + i + '] must be a finite number >= 0 (got ' + describe(v) + ').');
        else center += v;
      });
    }
    ['sideLeftFuel', 'sideRightFuel'].forEach((k) => {
      if (!(isFiniteNumber(input[k]) && input[k] >= 0)) errors.push(k + ' must be a finite number >= 0 (got ' + describe(input[k]) + ').');
    });
    if (errors.length) return failure(errors);
    const left = input.sideLeftFuel;
    const right = input.sideRightFuel;
    const total = center + left + right;
    if (!Number.isFinite(total)) return failure(['Total fuel is not finite.']);
    return { ok: true, errors: [], center, left, right, side: left + right, total };
  }

  // ------------------------------------------------------ starvation planner
  // Main-engine demand per engine is its CURRENT massFlowRate (kg/s), the
  // canonical engine state. Central RCS demand is charged to "center:0" only.
  function planFuelStarvation(input) {
    const errors = [];
    if (!isObject(input)) return failure(['Input must be an object { engines, fuelByTankKey, rcsMassFlowDemand, dt }.']);
    const { engines, fuelByTankKey, rcsMassFlowDemand, dt } = input;

    if (!(isFiniteNumber(dt) && dt > 0)) errors.push('dt must be a finite number > 0 (got ' + describe(dt) + ').');
    if (!(isFiniteNumber(rcsMassFlowDemand) && rcsMassFlowDemand >= 0)) {
      errors.push('rcsMassFlowDemand must be a finite number >= 0 (got ' + describe(rcsMassFlowDemand) + ').');
    }

    const fuelKeys = [];
    if (!isObject(fuelByTankKey)) {
      errors.push('fuelByTankKey must be an object.');
    } else {
      Object.keys(fuelByTankKey).forEach((k) => {
        if (!TANK_KEY_SET.has(k)) { errors.push('Invalid tank key: ' + JSON.stringify(k) + ' (allowed: ' + TANK_KEYS.join(', ') + ').'); return; }
        const v = fuelByTankKey[k];
        if (!(isFiniteNumber(v) && v >= 0)) { errors.push('Fuel for ' + k + ' must be a finite number >= 0 (got ' + describe(v) + ').'); return; }
        fuelKeys.push(k);
      });
      if (!hasOwn(fuelByTankKey, CENTER_TANK_KEY)) errors.push('fuelByTankKey must include "' + CENTER_TANK_KEY + '" (central RCS tank).');
    }

    const engineList = [];
    if (!Array.isArray(engines) || engines.length === 0) {
      errors.push('engines must be a non-empty array.');
    } else {
      const seenUid = new Set();
      engines.forEach((engine, i) => {
        if (!isObject(engine)) { errors.push('Engine #' + i + ' is not an object.'); return; }
        const uid = engine.uid;
        if (!isNonEmptyString(uid) || uid === '__proto__') { errors.push('Engine #' + i + ' has no valid uid.'); return; }
        if (seenUid.has(uid)) { errors.push('Duplicate engine uid: ' + uid); return; }
        seenUid.add(uid);
        if (typeof engine.tankKey !== 'string' || !TANK_KEY_SET.has(engine.tankKey)) {
          errors.push('Engine ' + uid + ' has an invalid tankKey (allowed: ' + TANK_KEYS.join(', ') + ').');
          return;
        }
        if (isObject(fuelByTankKey) && !hasOwn(fuelByTankKey, engine.tankKey)) {
          errors.push('Engine ' + uid + ' draws from tank ' + engine.tankKey + ' which has no fuel entry.');
          return;
        }
        if (!(isFiniteNumber(engine.massFlowRate) && engine.massFlowRate >= 0)) {
          errors.push('Engine ' + uid + ' massFlowRate must be a finite number >= 0 (got ' + describe(engine.massFlowRate) + ').');
          return;
        }
        engineList.push(engine);
      });
    }
    if (errors.length) return failure(errors);

    // Demand (kg/s) per tank, accumulated in deterministic engine order.
    const mainDemandByTankKey = {};
    fuelKeys.forEach((k) => { mainDemandByTankKey[k] = 0; });
    engineList.forEach((e) => { mainDemandByTankKey[e.tankKey] += e.massFlowRate; });
    const demandByTankKey = {};
    const requestedFuelByTankKey = {};
    const tankOrder = fuelKeys.slice().sort();
    tankOrder.forEach((k) => {
      const demand = mainDemandByTankKey[k] + (k === CENTER_TANK_KEY ? rcsMassFlowDemand : 0);
      demandByTankKey[k] = demand;
      requestedFuelByTankKey[k] = demand * dt;
      if (!Number.isFinite(demand) || !Number.isFinite(requestedFuelByTankKey[k])) {
        errors.push('Demand for tank ' + k + ' is not finite.');
      }
    });
    if (errors.length) return failure(errors);

    const scaleByTankKey = {};
    const fuelDebitByTankKey = {};
    const remainingFuelByTankKey = {};
    const starvedTankKeys = [];
    tankOrder.forEach((k) => {
      const available = fuelByTankKey[k];
      const demand = demandByTankKey[k];
      const requested = requestedFuelByTankKey[k];
      const scale = demand > 0 ? Math.min(1, available / requested) : 1;
      scaleByTankKey[k] = scale;
      if (scale < 1) {
        // Starved: the tank is emptied exactly. Never over-debit, never go
        // negative, and an empty tank (available === 0 -> scale 0) supplies nothing.
        fuelDebitByTankKey[k] = available;
        remainingFuelByTankKey[k] = 0;
        starvedTankKeys.push(k);
      } else {
        fuelDebitByTankKey[k] = requested;
        remainingFuelByTankKey[k] = Math.max(0, available - requested);
      }
    });

    const scaleByEngineUid = {};
    const deliveredMassFlowByEngineUid = {};
    engineList.forEach((e) => {
      const scale = scaleByTankKey[e.tankKey];
      scaleByEngineUid[e.uid] = scale;
      deliveredMassFlowByEngineUid[e.uid] = e.massFlowRate * scale;
    });
    const rcsScale = scaleByTankKey[CENTER_TANK_KEY];

    return {
      ok: true,
      errors: [],
      dt,
      scaleByTankKey,
      scaleByEngineUid,
      deliveredMassFlowByEngineUid,
      fuelDebitByTankKey,
      remainingFuelByTankKey,
      rcsScale,
      rcsDeliveredMassFlow: rcsMassFlowDemand * rcsScale,
      starvedTankKeys,
      mainDemandByTankKey,
      demandByTankKey,
      requestedFuelByTankKey,
    };
  }

  root.AssemblyPropulsion = Object.freeze({
    PHASE: '1B.4',
    CORE_IDS,
    TANK_KEYS,
    TANK_KEY_BY_CORE,
    buildEngineUid,
    validateEngineUids,
    buildEnginePacks,
    flattenEnginePacks,
    buildFuelCapacityDescriptors,
    buildAssemblyPropulsionModel,
    computeHeavyFuelTotals,
    planFuelStarvation,
  });
})(globalThis);
