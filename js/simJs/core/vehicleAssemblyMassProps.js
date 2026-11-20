// ============================================================================
// vehicleAssemblyMassProps.js — Phase 1B.3: composite mass-properties adapter.
//
// CALCULATION ONLY. NOT FLIGHT-READY. This module is not connected to the flight
// worker, physics, renderer, aero, storage or any script-load list, and it does
// not make Falcon Heavy flyable. It is pure and deterministic: every input is
// supplied by the caller; it reads no DOM, storage, worker state, CONFIG or other
// global, calls no stackMassProps()/combineComponents(), and mutates nothing.
//
// It composes the already-computed mass components of the three cores of a
// triple-core assembly (central axial stack, left side rocket, right side
// rocket) into ONE rigid composite body:
//
//   M   = sum m_i
//   x_c = sum(m_i x_i) / M          y_c = sum(m_i y_i) / M
//   I_c = sum[ iOwn_i + m_i ((x_i - x_c)^2 + (y_i - y_c)^2) ]
//
// (parallel-axis theorem about the composite COM; iOwn is each component's own
// transverse / pitch-plane inertia, as in the existing simulator convention).
//
// Frame (same as vehicleAssemblyGeometry.js / massProps.js): +X right, +Y up
// toward the nose, metres. Component comX/comY are local to their own core's
// base-centre origin. Assembly-frame position = core origin + local position,
// where the core origins come ONLY from the supplied geometry result
// (resolveVehicleAssemblyGeometry().cores[].origin). No lateral offset is
// derived, guessed or hardcoded here.
//
// The caller (upstream) is responsible for producing each core's components with
// one consistent local-origin convention (base-centre of that core); this module
// cannot verify that and only composes.
//
// EXCLUDED: inter-core struts, attachment hardware and separation hardware. Their
// physical specifications are not yet established, so no mass or inertia is
// invented for them. Asymmetric propellant loading enters only through the
// supplied components; COM X is never forced to zero.
//
// Output components are NEW shallow copies (mass, iOwn, label and all other
// metadata preserved) with translated comX/comY and a coreInstanceId stamp.
// Nested metadata objects are shared by reference with the inputs, not cloned.
// ============================================================================
(function (root) {
  'use strict';

  // Canonical, fixed order => deterministic output regardless of input order.
  const CORE_ORDER = Object.freeze(['center', 'side-left', 'side-right']);
  const SLOT_OF = Object.freeze({ 'center': 'center', 'side-left': 'left', 'side-right': 'right' });
  const EXCLUSIONS = Object.freeze([
    'inter-core struts',
    'attachment hardware',
    'separation hardware',
  ]);

  function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function _isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function _isExpected(id) { return CORE_ORDER.indexOf(id) >= 0; }

  function _fail(errors) {
    return {
      valid: false,
      geometryOnly: true,
      flightReady: false,
      totalMass: null,
      comX: null,
      comY: null,
      moi: null,
      components: [],
      coreMasses: [],
      massExclusions: EXCLUSIONS.slice(),
      errors,
    };
  }

  // Authoritative core origins from the geometry result. Records errors; returns
  // { id: {x, y} } for every expected core whose origin is valid.
  function _readGeometryOrigins(geometry, errors) {
    const origins = {};
    if (!_isObj(geometry)) {
      errors.push('geometry must be the result object of resolveVehicleAssemblyGeometry().');
      return origins;
    }
    if (geometry.valid !== true) errors.push('geometry is missing or invalid (valid !== true).');
    if (geometry.geometryOnly !== true) errors.push('geometry must be marked geometryOnly: true.');
    if (geometry.flightReady !== false) errors.push('geometry must be marked flightReady: false.');
    if (!Array.isArray(geometry.cores)) {
      errors.push('geometry.cores must be an array.');
      return origins;
    }
    const seen = {};
    geometry.cores.forEach((core, i) => {
      if (!_isObj(core)) { errors.push('geometry.cores[' + i + '] must be an object.'); return; }
      const id = core.instanceId;
      if (typeof id !== 'string' || !_isExpected(id)) {
        errors.push('geometry.cores[' + i + ']: unexpected core instance ' + JSON.stringify(id) + '.');
        return;
      }
      if (seen[id]) { errors.push('geometry: duplicate core instance "' + id + '".'); return; }
      seen[id] = true;
      const o = core.origin;
      if (!_isObj(o) || !_isFiniteNum(o.x) || !_isFiniteNum(o.y)) {
        errors.push('geometry core "' + id + '": origin must have finite numeric x and y.');
        return;
      }
      origins[id] = { x: o.x, y: o.y };
    });
    CORE_ORDER.forEach((id) => {
      if (!seen[id]) errors.push('geometry is missing core instance "' + id + '".');
    });
    return origins;
  }

  // Validate one core's components and return translated copies (or null).
  function _translateCore(id, components, origin, errors) {
    if (!Array.isArray(components) || components.length === 0) {
      errors.push('Core "' + id + '": components must be a non-empty array.');
      return null;
    }
    let ok = true;
    const out = [];
    components.forEach((c, i) => {
      const where = 'Core "' + id + '" component ' + i + ': ';
      if (!_isObj(c)) { errors.push(where + 'must be an object.'); ok = false; return; }
      if (!_isFiniteNum(c.mass) || c.mass < 0) {
        errors.push(where + 'mass must be a finite number >= 0 (got ' + String(c.mass) + ').'); ok = false;
      }
      if (!_isFiniteNum(c.comX)) {
        errors.push(where + 'comX must be a finite number (got ' + String(c.comX) + ').'); ok = false;
      }
      if (!_isFiniteNum(c.comY)) {
        errors.push(where + 'comY must be a finite number (got ' + String(c.comY) + ').'); ok = false;
      }
      if (!_isFiniteNum(c.iOwn) || c.iOwn < 0) {
        errors.push(where + 'iOwn must be a finite number >= 0 (got ' + String(c.iOwn) + ').'); ok = false;
      }
      if (c.coreInstanceId !== undefined && c.coreInstanceId !== id) {
        errors.push(where + 'coreInstanceId ' + JSON.stringify(c.coreInstanceId) + ' conflicts with its core "' + id + '".'); ok = false;
      }
      if (!ok || !origin) return;
      const ax = origin.x + c.comX;
      const ay = origin.y + c.comY;
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
        errors.push(where + 'translated position is not finite.'); ok = false; return;
      }
      out.push(Object.assign({}, c, { comX: ax, comY: ay, coreInstanceId: id }));
    });
    return ok && origin ? out : null;
  }

  function resolveVehicleAssemblyMassProps(args) {
    const errors = [];
    const a = _isObj(args) ? args : {};
    if (!_isObj(args)) errors.push('args must be an object { geometry, cores }.');

    const origins = _readGeometryOrigins(a.geometry, errors);

    // ---- Match supplied component sets to cores by instanceId (never by order) ----
    const byId = {};
    if (!Array.isArray(a.cores)) {
      errors.push('cores must be an array of { instanceId, components }.');
    } else {
      a.cores.forEach((entry, i) => {
        if (!_isObj(entry)) { errors.push('cores[' + i + '] must be an object.'); return; }
        const id = entry.instanceId;
        if (typeof id !== 'string' || !_isExpected(id)) {
          errors.push('cores[' + i + ']: unexpected core instance ' + JSON.stringify(id) + '.');
          return;
        }
        if (Object.prototype.hasOwnProperty.call(byId, id)) {
          errors.push('cores: duplicate core instance "' + id + '".');
          return;
        }
        byId[id] = entry;
      });
      CORE_ORDER.forEach((id) => {
        if (!Object.prototype.hasOwnProperty.call(byId, id)) errors.push('cores: missing core instance "' + id + '".');
      });
    }

    // ---- Validate and translate every core (all errors collected, none dropped) ----
    const translated = {};
    CORE_ORDER.forEach((id) => {
      if (!Object.prototype.hasOwnProperty.call(byId, id)) return;
      translated[id] = _translateCore(id, byId[id].components, origins[id] || null, errors);
    });
    if (errors.length) return _fail(errors);

    // ---- Per-core mass, then aggregate (fixed canonical order) ----
    const coreMasses = [];
    CORE_ORDER.forEach((id) => {
      let m = 0;
      translated[id].forEach((c) => { m += c.mass; });
      if (!(Number.isFinite(m) && m > 0)) {
        errors.push('Core "' + id + '": total mass must be finite and greater than zero (got ' + String(m) + ').');
      }
      coreMasses.push({
        instanceId: id,
        slotId: SLOT_OF[id],
        mass: m,
        componentCount: translated[id].length,
      });
    });
    if (errors.length) return _fail(errors);

    const components = [];
    CORE_ORDER.forEach((id) => translated[id].forEach((c) => components.push(c)));

    let M = 0, sx = 0, sy = 0;
    components.forEach((c) => { M += c.mass; sx += c.mass * c.comX; sy += c.mass * c.comY; });
    if (!(Number.isFinite(M) && M > 0)) {
      return _fail(['Aggregate total mass must be finite and greater than zero (got ' + String(M) + ').']);
    }
    const comX = sx / M;
    const comY = sy / M;
    if (!Number.isFinite(comX) || !Number.isFinite(comY)) {
      return _fail(['Aggregate centre of mass is not finite (overflow in mass-weighted sums).']);
    }
    let moi = 0;
    components.forEach((c) => {
      const dx = c.comX - comX, dy = c.comY - comY;
      moi += c.iOwn + c.mass * (dx * dx + dy * dy);
    });
    if (!(Number.isFinite(moi) && moi >= 0)) {
      return _fail(['Aggregate moment of inertia is not finite and non-negative (got ' + String(moi) + ').']);
    }

    return {
      valid: true,
      geometryOnly: true,
      flightReady: false,
      totalMass: M,
      comX,
      comY,
      moi,
      components,
      coreMasses,
      massExclusions: EXCLUSIONS.slice(),
      errors: [],
    };
  }

  root.VehicleAssemblyMassProps = Object.freeze({
    geometryOnly: true,
    flightReady: false,
    status: 'calculation-only; not flight-ready; not connected to the flight simulation',
    resolveVehicleAssemblyMassProps,
  });
})(globalThis);
