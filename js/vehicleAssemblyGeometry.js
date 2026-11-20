// ============================================================================
// vehicleAssemblyGeometry.js — Phase 1B.1: triple-core assembly geometry kernel.
//
// GEOMETRY ONLY. NOT FLIGHT-READY. This module is not connected to the flight
// model, fleet storage, workers or DOM. It is pure: every input is supplied by
// the caller, nothing is read from globals or storage, nothing is mutated.
//
// Assembly-local frame (matches massProps.js / physics.js):
//   +X right, +Y up toward the nose, metres.
//   center core base origin (0, 0); left (-d, 0); right (+d, 0), where
//   d = sideCoreCenterlineOffsetM is supplied explicitly by the caller.
//
// Member bounds are conservative RECTANGULAR hull bounds only.
//   - Central members: raw record.height, bottom-to-top, with the payloadSpace
//     stageOverlapM rule from stackMassProps(). stack.derived.interstage (the
//     frozen virtual interstage) is internal to the booster and is never added
//     as an extra external segment.
//   - Side cores are stageRole "rocket" records with an integrated nose:
//     bound height = record.height + record.noseHeightM.
// Excluded from all bounds: engine-bell hang, grid fins, landing legs,
// attachment struts and any other appendage.
//
// Validation of axial stacks is delegated to an INJECTED stackValidator
// (members, fleet, stack) -> the fleet.js validateStack() result shape
// { valid, errors, stackTotalHeight, stackTotalMass, memberInfo }. This module
// never reads a global validateStack and fails closed if the validator is
// absent, throws, or returns a malformed result. A result is accepted only when
// valid === true AND errors is an empty array AND stackTotalHeight and
// stackTotalMass are finite numbers > 0 (the same derived-property rule
// vehicleAssemblies.js applies). memberInfo is not inspected.
// ============================================================================
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const TYPE_TRIPLE_CORE = 'triple-core';
  // Tolerance for floating-point noise in the clearance subtraction only.
  const CLEARANCE_EPSILON_M = 1e-9;

  function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function _isPosNum(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0; }
  function _findById(list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  // Width source: record.width, else record.diameter. Must be finite > 0.
  function _memberWidth(rec) {
    if (_isPosNum(rec.width)) return rec.width;
    if (_isPosNum(rec.diameter)) return rec.diameter;
    return null;
  }

  function _fail(errors) {
    return {
      valid: false,
      errors,
      geometryOnly: true,
      flightReady: false,
      cores: [],
      memberBounds: [],
      boundingBox: null,
      clearances: [],
    };
  }

  function _makeBound(coreInstanceId, rec, origin, baseOffsetY, width, totalHeight, extra) {
    const baseX = origin.x;
    const baseY = origin.y + baseOffsetY;
    return Object.assign({
      coreInstanceId,
      recordId: rec.id,
      stageRole: rec.stageRole,
      base: { x: baseX, y: baseY },
      width,
      height: totalHeight,
      minX: baseX - width / 2,
      maxX: baseX + width / 2,
      minY: baseY,
      maxY: baseY + totalHeight,
    }, extra || {});
  }

  // Run the injected stack validator fail-closed. Returns true only when the
  // result matches the real validateStack() contract for a VALID stack:
  //   valid === true, errors an empty array, stackTotalHeight and
  //   stackTotalMass finite and > 0.
  // A bare { valid: true } is therefore rejected as malformed. memberInfo is
  // deliberately not inspected. Never reads a global validator.
  function _runValidator(label, validator, members, fleet, stack, errors) {
    let res;
    try {
      res = validator(members, fleet, stack);
    } catch (err) {
      errors.push(label + ': stackValidator threw: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
    if (!_isObj(res)) {
      errors.push(label + ': stackValidator returned a malformed result (expected an object).');
      return false;
    }
    if (res.valid !== true) {
      const reasons = Array.isArray(res.errors)
        ? res.errors.filter((r) => typeof r === 'string' && r) : [];
      if (reasons.length) reasons.forEach((r) => errors.push(label + ': ' + r));
      else errors.push(label + ': stack validation did not return valid=true.');
      return false;
    }
    let ok = true;
    if (!Array.isArray(res.errors)) {
      errors.push(label + ': stackValidator returned a malformed result (valid=true but errors is not an array).');
      ok = false;
    } else if (res.errors.length > 0) {
      errors.push(label + ': stackValidator returned a malformed result (valid=true but errors is not empty).');
      ok = false;
    }
    if (!_isPosNum(res.stackTotalHeight)) {
      errors.push(label + ': stackValidator returned a malformed result (stackTotalHeight must be finite and greater than zero).');
      ok = false;
    }
    if (!_isPosNum(res.stackTotalMass)) {
      errors.push(label + ': stackValidator returned a malformed result (stackTotalMass must be finite and greater than zero).');
      ok = false;
    }
    return ok;
  }

  function _nonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

  function resolveVehicleAssemblyGeometry(args) {
    const errors = [];
    const a = _isObj(args) ? args : {};
    const assembly = a.assembly;
    const fleet = Array.isArray(a.fleet) ? a.fleet : null;
    const stacks = Array.isArray(a.stacks) ? a.stacks : null;
    const validator = a.stackValidator;
    const d = a.sideCoreCenterlineOffsetM;

    if (!_isObj(assembly)) errors.push('Assembly record must be an object.');
    if (!fleet) errors.push('fleet must be an array.');
    if (!stacks) errors.push('stacks must be an array.');
    if (typeof validator !== 'function') {
      errors.push('stackValidator(members, fleet, stack) must be supplied as a function; validation fails closed without it.');
    }
    if (!_isPosNum(d)) {
      errors.push('sideCoreCenterlineOffsetM must be a finite number greater than zero (got ' + String(d) + ').');
    }
    if (errors.length) return _fail(errors);

    if (assembly.type !== TYPE_TRIPLE_CORE) errors.push('Assembly type must be "triple-core".');
    if (assembly.schemaVersion !== SCHEMA_VERSION) {
      errors.push('Unsupported assembly schemaVersion: ' + assembly.schemaVersion);
    }

    // ---- Central stack (resolved first: its bottom booster defines the family) ----
    const centralStack = (typeof assembly.centralStackId === 'string')
      ? _findById(stacks, assembly.centralStackId) : null;
    const centralMembers = [];
    let centralFamilyId = null;
    if (!centralStack) {
      errors.push('Central stack "' + assembly.centralStackId + '" was not found.');
    } else if (!Array.isArray(centralStack.members) || centralStack.members.length === 0) {
      errors.push('Central stack has no members.');
    } else {
      _runValidator('Central stack', validator, centralStack.members, fleet, centralStack, errors);
      centralStack.members.forEach((mid, i) => {
        const rec = (typeof mid === 'string') ? _findById(fleet, mid) : null;
        if (!rec) { errors.push('Central stack member ' + i + ': fleet record "' + mid + '" was not found.'); return; }
        const w = _memberWidth(rec);
        if (w === null) errors.push('Central stack member ' + i + ' ("' + mid + '"): needs finite positive width.');
        if (!_isPosNum(rec.height)) errors.push('Central stack member ' + i + ' ("' + mid + '"): needs finite positive hull height.');
        centralMembers.push({ rec, width: w });
      });
      if (centralMembers.length === centralStack.members.length) {
        const bottom = centralMembers[0].rec;
        if (bottom.stageRole !== 'booster') {
          errors.push('Central stack must begin with a valid booster record.');
        } else if (!_nonEmptyString(bottom.familyId)) {
          errors.push('Central stack bottom booster must have a non-empty familyId.');
        } else {
          centralFamilyId = bottom.familyId;
        }
      }
    }

    // ---- Side-core slots: integrated-nose "rocket" records ----
    const slotRecords = {};
    if (!Array.isArray(assembly.sideCores) || assembly.sideCores.length !== 2) {
      errors.push('Assembly must contain exactly two side-core slots.');
    } else {
      const seen = {};
      assembly.sideCores.forEach((slot) => {
        if (!_isObj(slot)) { errors.push('Each side-core slot must be an object.'); return; }
        const slotId = slot.slotId;
        if (slotId !== 'left' && slotId !== 'right') {
          errors.push('Unknown side-core slot: ' + slotId); return;
        }
        if (seen[slotId]) { errors.push('Duplicate side-core slot: ' + slotId); return; }
        seen[slotId] = true;
        const rec = (typeof slot.recordId === 'string') ? _findById(fleet, slot.recordId) : null;
        if (!rec) {
          errors.push('Side-core ' + slotId + ': fleet record "' + slot.recordId + '" was not found.');
          return;
        }
        if (rec.stageRole !== 'rocket') {
          errors.push('Side-core ' + slotId + ': record must have stageRole "rocket" (got "' + (rec.stageRole || 'unknown') + '").');
          return;
        }
        if (!_isPosNum(rec.noseHeightM)) errors.push('Side-core ' + slotId + ': record needs finite positive noseHeightM.');
        if (!_isPosNum(rec.height)) errors.push('Side-core ' + slotId + ': record needs finite positive hull height.');
        const w = _memberWidth(rec);
        if (w === null) errors.push('Side-core ' + slotId + ': record needs finite positive width.');
        if (!_nonEmptyString(rec.familyId)) {
          errors.push('Side-core ' + slotId + ': record must have a non-empty familyId.');
        } else if (centralFamilyId !== null && rec.familyId !== centralFamilyId) {
          errors.push('Side-core ' + slotId + ': familyId "' + rec.familyId + '" does not match the central stack bottom booster family "' + centralFamilyId + '".');
        }
        _runValidator('Side-core ' + slotId, validator, [rec.id], fleet, { sequence: 'legacy', payloadId: null }, errors);
        slotRecords[slotId] = { rec, width: w };
      });
      if (!seen.left) errors.push('Side-core slot "left" is missing.');
      if (!seen.right) errors.push('Side-core slot "right" is missing.');
    }

    if (errors.length) return _fail(errors);

    // ---- Clearance (central bottom booster vs each side rocket hull) ----
    const centralWidth = centralMembers[0].width;
    const clearances = [];
    ['left', 'right'].forEach((slotId) => {
      const sideWidth = slotRecords[slotId].width;
      const clearance = d - centralWidth / 2 - sideWidth / 2;
      clearances.push({ slotId, clearanceM: clearance });
      if (clearance < -CLEARANCE_EPSILON_M) {
        errors.push('Side-core ' + slotId + ': negative hull clearance (' + clearance + ' m); projected hull envelopes interpenetrate.');
      }
    });
    if (errors.length) return _fail(errors);

    // ---- Placements and bounds ----
    const cores = [];
    const memberBounds = [];

    // Central: raw member hull heights + payloadSpace overlap, exactly the
    // stackMassProps() rule. stack.derived.interstage is deliberately NOT read.
    const centerOrigin = { x: 0, y: 0 };
    const centerBounds = [];
    let yOffset = 0;
    centralMembers.forEach((cm) => {
      const m = cm.rec;
      const overlapM = (m.stageRole === 'payloadSpace' && Number.isFinite(m.stageOverlapM))
        ? m.stageOverlapM : 0;
      const baseOffset = yOffset - overlapM;
      yOffset = baseOffset + m.height;
      centerBounds.push(_makeBound('center', m, centerOrigin, baseOffset, cm.width, m.height));
    });
    cores.push({ instanceId: 'center', slotId: 'center', origin: centerOrigin, memberBounds: centerBounds });

    // Side: one rocket body = hull height + integral nose height.
    [['left', -d], ['right', d]].forEach(([slotId, x]) => {
      const { rec, width } = slotRecords[slotId];
      const origin = { x, y: 0 };
      const bound = _makeBound('side-' + slotId, rec, origin, 0, width,
        rec.height + rec.noseHeightM, { hullHeightM: rec.height, noseHeightM: rec.noseHeightM });
      cores.push({ instanceId: 'side-' + slotId, slotId, origin, memberBounds: [bound] });
    });

    cores.forEach((c) => c.memberBounds.forEach((b) => memberBounds.push(b)));

    const boundingBox = {
      minX: Math.min.apply(null, memberBounds.map((b) => b.minX)),
      maxX: Math.max.apply(null, memberBounds.map((b) => b.maxX)),
      minY: Math.min.apply(null, memberBounds.map((b) => b.minY)),
      maxY: Math.max.apply(null, memberBounds.map((b) => b.maxY)),
    };

    return {
      valid: true,
      errors,
      geometryOnly: true,
      flightReady: false,
      sideCoreCenterlineOffsetM: d,
      cores,
      memberBounds,
      boundingBox,
      clearances,
    };
  }

  // Translate mass components by a core origin. Returns new objects; does not
  // aggregate. Use combineComponents() for mass / COM / MOI.
  function translateMassComponents(components, origin) {
    if (!Array.isArray(components)) throw new TypeError('components must be an array.');
    if (!_isObj(origin) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
      throw new TypeError('origin must have finite x and y.');
    }
    // Validate every component BEFORE building any output, so a bad entry
    // fails the whole call and nothing partial is returned.
    components.forEach((c, i) => {
      if (!_isObj(c)) throw new TypeError('components[' + i + '] must be an object.');
      if (typeof c.comX !== 'number' || !Number.isFinite(c.comX)) {
        throw new TypeError('components[' + i + '].comX must be a finite number (got ' + String(c.comX) + ').');
      }
      if (typeof c.comY !== 'number' || !Number.isFinite(c.comY)) {
        throw new TypeError('components[' + i + '].comY must be a finite number (got ' + String(c.comY) + ').');
      }
    });
    return components.map((c) => Object.assign({}, c, {
      comX: origin.x + c.comX,
      comY: origin.y + c.comY,
    }));
  }

  // Same convention as physics.js _rotatedPoint(body, localX, localY).
  function assemblyPointToWorld(point, bodyPose) {
    if (!_isObj(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new TypeError('point must have finite x and y.');
    }
    if (!_isObj(bodyPose) || !Number.isFinite(bodyPose.rx) ||
        !Number.isFinite(bodyPose.ry) || !Number.isFinite(bodyPose.theta)) {
      throw new TypeError('bodyPose must have finite rx, ry and theta.');
    }
    const cosT = Math.cos(bodyPose.theta), sinT = Math.sin(bodyPose.theta);
    return {
      x: bodyPose.rx + point.x * cosT - point.y * sinT,
      y: bodyPose.ry + point.x * sinT + point.y * cosT,
    };
  }

  root.VehicleAssemblyGeometry = Object.freeze({
    geometryOnly: true,
    flightReady: false,
    status: 'geometry-only; not flight-ready; not connected to the flight simulation',
    resolveVehicleAssemblyGeometry,
    translateMassComponents,
    assemblyPointToWorld,
  });
})(globalThis);
