// ============================================================================
// guidance.js — Phase 3 scaffold. Runs inside guidance.worker.js, imported
// AFTER imu.js (so measure()/setEnabled() below are already global in this
// worker's scope — importScripts shares one global, not modules).
//
// PHASE 3: no control law. This file's job in this phase is the
// INTERFACE — receiving snapshots, applying (or not) IMU error, and giving
// Phase 4 a single place (Guidance.tick) to drop a real algorithm into,
// plus a full set of command-builder helpers so that drop-in doesn't also
// have to invent the wire format.
//
// Isolation note: this file must never reference `state`, `CONFIG`,
// `getComponentType`, or anything else from the physics side. It can't —
// none of those scripts are in this worker's importScripts list (see
// guidance.worker.js) — so a stray reference here throws a ReferenceError
// immediately rather than silently reaching into physics. That's the
// enforcement mechanism the spec asks for; nothing in this file "helps"
// enforce it, the worker boundary does.
// ============================================================================

const Guidance = (function () {
  let _physicsSend = null; // (msg) => void, wired by guidance.worker.js once the physics MessagePort connects
  let _lastRawSnapshot = null; // most recent snapshot exactly as received (pre-IMU)
  let _lastMeasuredSnapshot = null; // what tick()/the future control law actually sees
  
  // One-time boot handoff from main thread. Contains:
  //   members[]         — this stack's member records (functions stripped),
  //                       bottom → top, same order as the physics body's
  //                       own members[] field
  //   types{id → obj}   — every hardware type those members reference
  //                       (functions stripped)
  //   stackPayloadMass  — cargo mass, 0 if none assigned
  //   env               — EARTH_RADIUS, GM_EARTH, EARTH_OMEGA, G0,
  //                       SEA_LEVEL_DENSITY, SCALE_HEIGHT, DRAG_CD,
  //                       LAUNCH_SITE_ALTITUDE, LAUNCH_SITE_ANGLE_0
  // Guidance derives every mass property (dry mass, COM, I, tank
  // geometry, slosh fractions) itself from this data — nothing is
  // pre-computed on the main thread side.
  let _stackData = null;
  
  function init(physicsSendFn) {
    _physicsSend = physicsSendFn;
  }
  
  function setStackData(data) { _stackData = data; }
  function getStackData() { return _stackData; }
  function getMemberRecord(idx) {
    return (_stackData && _stackData.members) ? _stackData.members[idx] : null;
  }
  function getTypeById(id) {
    return (_stackData && _stackData.types && _stackData.types[id]) ? _stackData.types[id] : null;
  }
  function getEnv() {
    return _stackData ? _stackData.env : null;
  }
  function getStackPayloadMass() {
  return _stackData ? (_stackData.stackPayloadMass || 0) : 0;
}

// ============================================================
// DERIVATION MODULE
//
// Everything guidance can compute ITSELF from the snapshot + the
// one-time stack data. Nothing here is pre-computed on main thread;
// guidance is fully self-sufficient.
//
// Conventions (same as physics internally):
//   - Position/velocity: inertial (Earth-centered, non-rotating)
//   - theta: inertial body-axis angle; nose direction is (-sinθ, cosθ)
//   - Body-local frame: origin at base center, +X right, +Y toward nose
//   - Member-local comY: from that member's own base, +Y up-stack
//   - Stack comY: from the STACK base (lowest attached member's base)
// ============================================================

const _SLOSH_LAMBDA1 = 1.841;
const _INTERSTAGE_DENSITY = 1600; // matches fleet.js
const _BODY_SHELL_FACTOR_NOSE = 0.0165; // matches componentLibrary.js for nose mass

// ---- Env accessor with fallback ----
function _envNum(key, fallback) {
  const e = getEnv();
  return (e && Number.isFinite(e[key])) ? e[key] : fallback;
}

// ---- Inertia helpers (matching massProps.js) ----
function _cylI(m, r, h) { return 0.5 * m * r * r + (1 / 12) * m * h * h; }
function _coneI(m, r, h) { return (3 / 20) * m * r * r + (3 / 80) * m * h * h; }
function _rodI(m, L) { return (1 / 12) * m * L * L; }

// ---- Type parameter lookup ----
function _typeParam(type, key) {
  if (!type || !Array.isArray(type.parameterSchema)) return undefined;
  const e = type.parameterSchema.find(p => p.key === key);
  return e ? e.value : undefined;
}

// ---- Abramson slosh fraction (matches massProps.js) ----
function _sloshMassFraction(hOverR) {
  if (!Number.isFinite(hOverR) || hOverR <= 0) return 0.27;
  const x = _SLOSH_LAMBDA1 * hOverR;
  const f = (x < 1e-6) ? 1 : Math.tanh(x) / x;
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0.27;
}
function _sloshCentroidFrac(hOverR) {
  if (!Number.isFinite(hOverR) || hOverR <= 0) return 0.5;
  const x = _SLOSH_LAMBDA1 * hOverR;
  if (x < 1e-3) return 0.5;
  if (x > 30) return 1;
  const f = 1 - (Math.cosh(x) - 1) / (x * Math.sinh(x));
  return Number.isFinite(f) ? Math.min(1, Math.max(0.5, f)) : 0.5;
}

// ---- Parallel-axis aggregation (matches massProps.js) ----
function _combine(components) {
  let M = 0, sumX = 0, sumY = 0;
  (components || []).forEach(c => {
    M += c.mass || 0;
    sumX += (c.mass || 0) * (c.comX || 0);
    sumY += (c.mass || 0) * (c.comY || 0);
  });
  const comX = M > 0 ? sumX / M : 0;
  const comY = M > 0 ? sumY / M : 0;
  let I = 0;
  (components || []).forEach(c => {
    const dx = (c.comX || 0) - comX;
    const dy = (c.comY || 0) - comY;
    I += (c.iOwn || 0) + (c.mass || 0) * (dx * dx + dy * dy);
  });
  return { M, comX, comY, I };
}

// ---- Max fuel a member can hold ----
function _memberMaxFuel(rec, aboveRec) {
  if (!rec) return 0;
  const role = rec.stageRole || 'rocket';
  if (role === 'nose' || role === 'payloadSpace') return 0;
  if (role === 'booster' || role === 'stage') {
    const t = rec.fuel;
    if (!t) return 0;
    const fuelType = getTypeById(t.typeId);
    if (!fuelType) return 0;
    const density = _typeParam(fuelType, 'propellantDensity');
    if (!Number.isFinite(density)) return 0;
    const tankH = Number.isFinite(t.tankHeight) ? t.tankHeight : 0;
    const tankW = Number.isFinite(t.tankWidth) ? t.tankWidth : 0;
    const volume = Math.PI * (tankW / 2) ** 2 * tankH;
    return volume * density;
  }
  return Number.isFinite(rec.fuelMassMax) ? rec.fuelMassMax : 0;
}

// ---- Booster interstage sizing helper ----
// Bell height of the member above, from ITS total engine mass flow /
// total slots. Uses angleDeg-based positions (data, not the stripped
// position() function) so nothing here depends on re-importing formulas.
function _stageAboveBellHeight(aboveRec) {
  if (!aboveRec || !aboveRec.engineTypeId) return 0;
  const layout = getTypeById(aboveRec.engineTypeId);
  if (!layout || !layout.frame || !Array.isArray(layout.frame.slots)) return 0;
  const slotCount = layout.frame.slots.length;
  if (!slotCount) return 0;
  let totalFlow = 0;
  if (aboveRec.engineThrusters) {
    Object.keys(aboveRec.engineThrusters).forEach(gk => {
      const g = aboveRec.engineThrusters[gk];
      if (!g || !Number.isFinite(g.massFlowRate)) return;
      const isG = (gk === 'gimbal');
      const count = layout.frame.slots.filter(s => !!s.gimbalCapable === isG).length;
      totalFlow += g.massFlowRate * count;
    });
  }
  return 0.007 * (totalFlow / slotCount);
}

// ---- Engine components for a member (aggregated per group) ----
function _engineComponents(rec) {
  const out = [];
  if (!rec.engineTypeId || !rec.engineThrusters) return out;
  const layout = getTypeById(rec.engineTypeId);
  if (!layout || !layout.frame || !Array.isArray(layout.frame.slots)) return out;
  const G0 = _envNum('G0', 9.80665);
  const R = (rec.params && Number.isFinite(rec.params.octaRadius)) ? rec.params.octaRadius : 1.7;
  
  let totalMass = 0, sumXmass = 0;
  layout.frame.slots.forEach(slot => {
    const gk = slot.gimbalCapable ? 'gimbal' : 'fixed';
    const g = rec.engineThrusters[gk];
    if (!g) return;
    const t = getTypeById(g.thrusterTypeId);
    if (!t) return;
    const ve = _typeParam(t, 've');
    const twr = _typeParam(t, 'twr');
    if (!Number.isFinite(ve) || !Number.isFinite(g.massFlowRate)) return;
    const thrustPer = g.massFlowRate * ve;
    const massPer = (Number.isFinite(twr) && twr > 0) ? thrustPer / (twr * G0) : 0;
    const posX = (slot.angleDeg === null || slot.angleDeg === undefined)
      ? 0
      : R * Math.cos(slot.angleDeg * Math.PI / 180);
    totalMass += massPer;
    sumXmass += massPer * posX;
  });
  if (totalMass > 0) {
    out.push({ label: 'engines', mass: totalMass, comX: sumXmass / totalMass, comY: 0, iOwn: 0 });
  }
  return out;
}

// ---- Landing leg components (live position with legs progress) ----
function _legComponents(rec, legsProgress) {
  const out = [];
  if (rec.hasRecovery === false) return out;
  const recoveryType = getTypeById(rec.recoveryTypeId);
  if (!recoveryType || recoveryType.kind !== 'legsOnVehicle') return out;
  if (!recoveryType.capabilities || !recoveryType.capabilities.deploysOnVehicle) return out;
  
  const H = Number.isFinite(rec.height) ? rec.height : 0;
  const W = Number.isFinite(rec.width) ? rec.width : 0;
  // Legs anchor to the TANK, not the whole member — matches
  // fleet.js/massProps.js which pass tankHeight into leg structuralVolume.
  const bodyH_forLegs = (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) ?
    rec.fuel.tankHeight : H;
  
  // Leg geometry — same placeholder formulas the swingout type uses.
  const hingeY = -bodyH_forLegs * 0.004;
  const legLength = bodyH_forLegs * 0.27;
  const maxSweepRad = 125 * Math.PI / 180;
  const hingeLocalY = -hingeY; // member-local +Y up from base
  const sweep = (legsProgress || 0) * maxSweepRad;
  const tipLocalY = hingeLocalY + legLength * Math.cos(sweep);
  const midLocalY = (hingeLocalY + tipLocalY) / 2;
  
  // Leg mass per leg — same structuralVolume formula.
  const avgThickness = 0.065 * W;
  const avgDepth = 0.04 * W;
  const oneLegVolume = legLength * avgThickness * avgDepth;
  const legsMetal = getTypeById(rec.legsMetalTypeId) || getTypeById(rec.bodyMetalTypeId);
  const density = legsMetal ? (_typeParam(legsMetal, 'density') || 0) : 0;
  const legMass = oneLegVolume * density;
  
  // X positions: front legs at ±W/2, back legs at ±0.375W.
  const legXs = [-W / 2, W / 2, -W * 0.375, W * 0.375];
  const count = Math.min(4, legXs.length);
  for (let i = 0; i < count; i++) {
    out.push({
      label: 'leg' + i,
      mass: legMass, comX: legXs[i], comY: midLocalY,
      iOwn: _rodI(legMass, legLength),
    });
  }
  return out;
}

// ---- Fuel components (bulk + slosh split, live) ----
function _fuelComponents(rec, memberFuelMass, sloshOffset) {
  const out = [];
  if (!(memberFuelMass > 0)) return out;
  const t = rec.fuel;
  if (!t) return out;
  const tankH = Number.isFinite(t.tankHeight) ? t.tankHeight : 0;
  const tankW = Number.isFinite(t.tankWidth) ? t.tankWidth : 0;
  if (!(tankH > 0) || !(tankW > 0)) return out;
  
  const maxFuel = _memberMaxFuel(rec, null);
  const fillFrac = maxFuel > 0 ? Math.min(1, memberFuelMass / maxFuel) : 0;
  const fuelH = fillFrac * tankH;
  const r = tankW / 2;
  const hOverR = r > 0 ? fuelH / r : 0;
  
  const sloshFrac = _sloshMassFraction(hOverR);
  const sloshActive = Number.isFinite(sloshOffset) && sloshFrac > 1e-6 && sloshFrac < 1;
  
  if (sloshActive) {
    const sloshMass = memberFuelMass * sloshFrac;
    const bulkMass = memberFuelMass - sloshMass;
    const sloshComY = _sloshCentroidFrac(hOverR) * fuelH;
    out.push({ label: 'fuel-bulk', mass: bulkMass, comX: 0, comY: fuelH / 2, iOwn: _cylI(bulkMass, r, fuelH) });
    out.push({ label: 'fuel-slosh', mass: sloshMass, comX: sloshOffset, comY: sloshComY, iOwn: _cylI(sloshMass, r, fuelH) });
  } else {
    out.push({ label: 'fuel', mass: memberFuelMass, comX: 0, comY: fuelH / 2, iOwn: _cylI(memberFuelMass, r, fuelH) });
  }
  return out;
}

// ---- All components of one member in its LOCAL frame (base = 0). ----
function _memberComponents(rec, aboveRec, memberFuelMass, legsProgress, sloshOffset) {
  const role = rec.stageRole || 'rocket';
  const H = Number.isFinite(rec.height) ? rec.height : 0;
  const W = Number.isFinite(rec.width) ? rec.width : 0;
  const r = W / 2;
  const out = [];
  
  // ---- Nose: solid cone ----
  if (role === 'nose') {
    const metal = getTypeById(rec.bodyMetalTypeId);
    const density = metal ? (_typeParam(metal, 'density') || 0) : 0;
    const coneVol = (1 / 3) * Math.PI * r * r * H;
    const mass = coneVol * _BODY_SHELL_FACTOR_NOSE * density;
    out.push({ label: 'nose', mass, comX: 0, comY: H / 4, iOwn: _coneI(mass, r, H) });
    return out;
  }
  
  // ---- PayloadSpace (standalone fairing): bulged cap shell ----
  if (role === 'payloadSpace') {
    const metal = getTypeById(rec.payloadSpaceMetalTypeId);
    const density = metal ? (_typeParam(metal, 'density') || 0) : 0;
    const p = rec.params || {};
    const capH = p.capHeight || 0;
    const capW = p.capWidth || 0;
    const bulgeW = p.bulgeWidth || capW;
    const rBulge = bulgeW / 2;
    const coneH = capH * 0.4;
    const cylH = capH * 0.6;
    const coneSlant = Math.sqrt(rBulge * rBulge + coneH * coneH);
    const lateralArea = Math.PI * rBulge * coneSlant + 2 * Math.PI * rBulge * cylH;
    const shellFrac = Number.isFinite(rec.bodyShellFactor) ? rec.bodyShellFactor : 0.0026;
    const vol = lateralArea * rBulge * shellFrac;
    const mass = vol * density;
    out.push({ label: 'payloadSpace', mass, comX: 0, comY: H / 2, iOwn: _cylI(mass, capW / 2, H) });
    return out;
  }
  
  // ---- Booster / Stage / Rocket: shell + interstage + engines + legs + fuel ----
  let bodyMass = 0, bodyH = H, interstageMass = 0, interstageH = 0;
  
  if (role === 'booster' || role === 'stage') {
    const t = rec.fuel || {};
    const tankH = Number.isFinite(t.tankHeight) ? t.tankHeight : H;
    const tankW = Number.isFinite(t.tankWidth) ? t.tankWidth : W;
    const fuelType = getTypeById(t.typeId);
    const metalType = getTypeById(rec.bodyMetalTypeId);
    const fuelDensity = fuelType ? (_typeParam(fuelType, 'propellantDensity') || 0) : 0;
    const metalDensity = metalType ? (_typeParam(metalType, 'density') || 0) : 0;
    const shellF = Number.isFinite(rec.bodyShellFactor)
      ? rec.bodyShellFactor
      : (role === 'booster' ? 0.01797 : 0.0147);
    const tankVol = Math.PI * (tankW / 2) ** 2 * tankH;
    bodyMass = tankVol * shellF * metalDensity;
    bodyH = tankH;
    
    if (role === 'booster') {
      const bellH = _stageAboveBellHeight(aboveRec);
      const ish = Math.max(bellH * 1.20, 0.06 * tankH);
      const r_b = tankW / 2;
      const shellThk = shellF * r_b;
      interstageMass = 2 * Math.PI * r_b * shellThk * ish * _INTERSTAGE_DENSITY;
      interstageH = ish;
    }
  } else {
    bodyMass = Number.isFinite(rec.dryMass) ? rec.dryMass : 0;
  }
  
  out.push({ label: 'body', mass: bodyMass, comX: 0, comY: bodyH / 2, iOwn: _cylI(bodyMass, r, bodyH) });
  if (interstageMass > 0) {
    out.push({
      label: 'interstage', mass: interstageMass, comX: 0,
      comY: bodyH - interstageH / 2,
      iOwn: _cylI(interstageMass, r, interstageH),
    });
  }
  
  _engineComponents(rec).forEach(c => out.push(c));
  _legComponents(rec, legsProgress).forEach(c => out.push(c));
  _fuelComponents(rec, memberFuelMass, sloshOffset).forEach(c => out.push(c));
  
  return out;
}

// ---- Whole-stack mass properties (with fuel distribution) ----
// bodySnapshot: a body from the guidance snapshot (has .members, .fuelMass,
//   .legs, .slosh)
// payloadMass: cargo mass currently riding on the stack (or 0)
function _stackMassProps(bodySnapshot, payloadMass) {
  const members = (bodySnapshot && bodySnapshot.members) || [];
  if (!members.length) return null;
  
  const fuelTotal = bodySnapshot.fuelMass || 0;
  const legsProgress = bodySnapshot.legs ? (bodySnapshot.legs.progress || 0) : 0;
  const sloshOffset = bodySnapshot.slosh ? (bodySnapshot.slosh.offset || 0) : 0;
  
  const maxFuels = members.map((m, i) => _memberMaxFuel(m, members[i + 1] || null));
  const sumMax = maxFuels.reduce((s, x) => s + x, 0);
  
  const all = [];
let yOffset = 0;
let payloadSpaceComY = null;
let payloadSpaceIdx = -1;
members.forEach((m, i) => {
  const memberFuel = sumMax > 0 ? fuelTotal * (maxFuels[i] / sumMax) : 0;
  const memberLegs = (i === 0) ? legsProgress : 0;
  const memberSlosh = (i === 0) ? sloshOffset : 0;
  const comps = _memberComponents(m, members[i + 1] || null, memberFuel, memberLegs, memberSlosh);
  // Tag every component with its member index — this is what
  // derive()'s per-member breakdown filters on. Window-based
  // inference (comY in [cumY, cumY+H]) double-counted components
  // sitting exactly on a member boundary (e.g. a stage's engines
  // sit at stack-Y = booster top = stage base; they matched both
  // the booster's window and the stage's window).
  comps.forEach(c => all.push({ ...c, comY: c.comY + yOffset, _memberIdx: i }));
  if (m.stageRole === 'payloadSpace') {
    payloadSpaceComY = yOffset + (m.height || 0) / 2;
    payloadSpaceIdx = i;
  }
  yOffset += (m.height || 0);
});

const cargo = Number.isFinite(payloadMass) ? payloadMass : 0;
if (cargo > 0) {
  const comY = payloadSpaceComY !== null ? payloadSpaceComY : yOffset;
  all.push({
    label: 'payloadCargo', mass: cargo, comX: 0, comY, iOwn: 0,
    _memberIdx: payloadSpaceIdx >= 0 ? payloadSpaceIdx : (members.length - 1),
  });
}
  
  const combined = _combine(all);
  return {
    M: combined.M,
    comX: combined.comX,
    comY: combined.comY,
    I: combined.I,
    stackHeight: yOffset,
    dryMass: Math.max(0, combined.M - fuelTotal),
    fuelMass: fuelTotal,
    payloadMass: cargo,
    components: all,
  };
}

// ---- Wind → inertial vector (matches environment.js) ----
// ---- Body-own dimensions, mirroring physics's fallback path. ----
// For a member-less body (fairing half, ejected package, released
// payload), physics uses body.height/body.width — set at spawn time
// by splitFairingOnActiveBody / releasePayloadOnActiveBody — instead
// of a stack aggregate. Guidance's own COM/I/aero math needs the same
// numbers or it will drift from what physics is actually flying.
function _bodyHeightOf(body) {
  if (body && body.members && body.members.length) {
    return body.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0);
  }
  return (body && Number.isFinite(body.height) && body.height > 0) ? body.height : 0;
}
function _bodyWidthOf(body) {
  if (body && body.members && body.members.length) {
    const bottom = body.members[0];
    if (bottom && Number.isFinite(bottom.width)) return bottom.width;
  }
  return (body && Number.isFinite(body.width) && body.width > 0) ? body.width : 0;
}

// ---- Wind → inertial vector (matches environment.js) ----
function _windInertial(rx, ry, wind) {
  if (!wind || !wind.enabled || !wind.speed) return { wx: 0, wy: 0 };
  const r = Math.hypot(rx, ry) || 1;
  const upX = rx / r, upY = ry / r;
  const eastX = upY, eastY = -upX;
  const rad = (wind.directionDeg || 0) * Math.PI / 180;
  const dirX = eastX * Math.cos(rad) + upX * Math.sin(rad);
  const dirY = eastY * Math.cos(rad) + upY * Math.sin(rad);
  return { wx: dirX * wind.speed, wy: dirY * wind.speed };
}

// ------------------------------------------------------------------
// Per-member aerodynamic breakdown (COM + CoP + area share + drag).
//
// Physics's computeDragAero() distributes drag + normal force over every
// member using that member's OWN presented area (nose-on circle blended
// with broadside rectangle by |sin AoA|), and its own CP position
// (tapered members blend nose-CP 0.9H → body-CP 0.5H via |sin AoA|;
// straight cylinders use body-CP 0.5H). This mirrors that per-member,
// then guidance can either aggregate (for trajectory work) or inspect
// individually (for control-law decisions that care about one member).
//
// Values are returned in each member's LOCAL frame (base=0, +Y up), so
// callers add their own cumulative height offset when they need stack-
// frame coordinates.
// ------------------------------------------------------------------
const _AERO_CP_NOSE_FRAC = 0.90;
const _AERO_CP_BODY_FRAC = 0.50;
const _AERO_CP_NOSE_LINEAR_FRAC = 0.466;   // Barrowman ogive CP (small AoA)
const _AERO_CNALPHA_NOSE = 2.0;            // Barrowman CNα, nose/taper
const _AERO_CD_CROSSFLOW = 1.2;            // Allen-Perkins crossflow Cd

function _memberAero(member, refWidth, rho, speedRel, sinAlpha) {
  const H = Number.isFinite(member.height) ? member.height : 0;
  const W = Number.isFinite(member.width) ? member.width : 0;
  const isTapered = (member.stageRole === 'nose') || (member.stageRole === 'payloadSpace');
  const wCross = Math.min(1, Math.abs(sinAlpha));
  
  // Presented area — nose-on circle blended to broadside rectangle.
  const aAxial = Math.PI * (W / 2) ** 2;
  const aSide = W * H;
  const aEff = aAxial * (1 - wCross) + aSide * wCross;
  
  // Drag contribution (axial, magnitude only — direction is at body level).
  const drag = (rho > 0 && speedRel > 1e-3)
    ? 0.5 * rho * (getEnv() ? (getEnv().DRAG_CD || 0.6) : 0.6) * aEff * speedRel * speedRel
    : 0;
  
  // CP position, local frame. Tapered members additionally have a
  // Barrowman linear-regime CP (0.466 × own height) that matters at
  // small AoA; both CPs are returned so callers can apply either regime.
  const cpBodyFrac = isTapered
    ? (_AERO_CP_NOSE_FRAC * (1 - wCross) + _AERO_CP_BODY_FRAC * wCross)
    : _AERO_CP_BODY_FRAC;
  const copY_body = H * cpBodyFrac;
  const copY_linear = isTapered ? H * _AERO_CP_NOSE_LINEAR_FRAC : null;
  
  // Barrowman linear normal-force (tapered only). Allen-Perkins
  // crossflow normal-force (every member).
  const q = 0.5 * rho * speedRel * speedRel;
  const S_ref = Math.PI * (refWidth / 2) ** 2;
  const sinAbs = Math.abs(sinAlpha);
  const F_lin = isTapered ? (-q * _AERO_CNALPHA_NOSE * S_ref * sinAlpha) : 0;
  const F_cross = -q * _AERO_CD_CROSSFLOW * aSide * sinAbs * sinAlpha;
  
  return {
    isTapered, wCross,
    presentedArea: aEff,
    aAxial, aSide,
    drag,
    copY_body,          // local-frame body-CP
    copY_linear,        // local-frame Barrowman CP (null for cylinders)
    Fnormal_linear: F_lin,
    Fnormal_crossflow: F_cross,
  };
}

// ------------------------------------------------------------------
// Derive a FULL body: aggregate + per-member breakdown.
//
// Bodies are independent here by construction — snapshot.bodies[i] is
// one body. When physics has several members attached to that body
// (F9 booster + stage + fairing), the members list is those attached
// members, and everything gets combined. When separated, each body's
// members list reflects only what's still on it — so the SAME function
// correctly handles attached and detached states without any branch.
// ------------------------------------------------------------------

// ============================================================
// THE MASTER DERIVE — one call, everything.
// snapshot: the full guidance snapshot (bodies + wind + simTime)
// bodyIdx:  which body (defaults to activeBodyIndex)
// payloadMass: cargo mass on the stack (or omit to auto-use stackPayloadMass)
// ============================================================
function derive(snapshot, bodyIdx, payloadMass) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
  const idx = Number.isInteger(bodyIdx) ? bodyIdx : (snapshot.activeBodyIndex || 0);
  const body = snapshot.bodies[idx];
  if (!body) return null;
  
  const env = getEnv();
  if (!env) return null;
  
  // Fallback for member-less bodies — a fairing half, an ejected
  // package, a released payload. These carry no `members` list, so
  // all stack-oriented derivations are meaningless. Guidance instead
  // uses body.height/body.width/dryMass — the exact fields physics
  // seeds on such bodies at spawn time, so the two agree.
  const hasMembers = Array.isArray(body.members) && body.members.length > 0;
  
  // ---- Kinematics ----
  const rx = body.rx, ry = body.ry, vx = body.vx, vy = body.vy;
  const theta = body.theta, omega = body.omega;
  
  // ---- Position-derived ----
  const r = Math.hypot(rx, ry);
  const altitudeASL = r - env.EARTH_RADIUS;
  const altitudeAGL = altitudeASL - (env.LAUNCH_SITE_ALTITUDE || 0);
  
  // ---- Gravity ----
  const gMag = env.GM_EARTH / (r * r);
  const gVecX = r > 0 ? -gMag * rx / r : 0;
  const gVecY = r > 0 ? -gMag * ry / r : 0;
  
  // ---- Air density ----
  const rho = altitudeASL < 0
    ? env.SEA_LEVEL_DENSITY
    : env.SEA_LEVEL_DENSITY * Math.exp(-altitudeASL / env.SCALE_HEIGHT);
  
  // ---- Relative velocity (co-rotating atmosphere + user wind) ----
  const w = _windInertial(rx, ry, snapshot.wind);
  const omegaE = env.EARTH_OMEGA || 0;
  const svx = omegaE * ry, svy = -omegaE * rx;
  const relVx = vx - (w.wx + svx);
  const relVy = vy - (w.wy + svy);
  const speedRel = Math.hypot(relVx, relVy);
  
  // ---- Dynamic pressure Q ----
  const Q = 0.5 * rho * speedRel * speedRel;
  
  // ---- AoA (body axis vs relative-velocity direction) ----
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  const velBodyX = speedRel > 1e-6
    ? (relVx * cosT + relVy * sinT)
    : 0;
  const sinAlpha = speedRel > 1e-6
    ? Math.max(-1, Math.min(1, velBodyX / speedRel))
    : 0;
  const alphaDeg = Math.asin(sinAlpha) * 180 / Math.PI;
  
  // ---- Drag (simple axial-area model) ----
  // Sum each member's nose-on cross-section. Guidance's purpose is
  // trajectory prediction; the AoA-dependent area blend can be added
  // later if prediction fidelity demands it.
  const members = body.members || [];
  let axialArea = 0;
  members.forEach(m => {
    const W = m.width || 0;
    axialArea += Math.PI * (W / 2) ** 2;
  });
  if (axialArea <= 0 && body.width) axialArea = Math.PI * (body.width / 2) ** 2;
  const dragCd = env.DRAG_CD || 0.6;
  const dragMag = (rho > 0 && speedRel > 1e-3)
    ? 0.5 * rho * dragCd * axialArea * speedRel * speedRel
    : 0;
  const dragVecX = speedRel > 1e-6 ? -dragMag * relVx / speedRel : 0;
  const dragVecY = speedRel > 1e-6 ? -dragMag * relVy / speedRel : 0;
  
  // ---- Thrust (all engines, magnitude; direction is per-engine gimbal) ----
  let thrustTotal = 0, mdotTotal = 0;
  let thrustBodyX = 0, thrustBodyY = 0; // body-frame components
  (body.engines || []).forEach(e => {
    if (!(e.massFlowRate > 0)) return;
    const F = e.massFlowRate * e.Ve;
    thrustTotal += F;
    mdotTotal += e.massFlowRate;
    const gRad = (e.gimbal ? (e.gimbalDeg || 0) : 0) * Math.PI / 180;
    thrustBodyX += F * Math.sin(gRad);
    thrustBodyY += F * Math.cos(gRad);
  });
  
// ---- Mass properties ----
const payloadMassInput = Number.isFinite(payloadMass) ?
  payloadMass :
  (body.payloadReleased ? 0 : getStackPayloadMass());
// Branch: stack (has members) → aggregate over members. Member-less
// → single lumped body using body.height/width/dryMass, matching
// physics's currentGeometry() fallback.
const massProps = hasMembers ?
  _stackMassProps(body, payloadMassInput) :
  _soloBodyMassProps(body);
  
// ---- Per-member aero + CoM/CoP breakdown ----
// Reference width = widest member, same as physics's bodyAeroProfile.
let refWidth = 0;
members.forEach(m => {
  const W = Number.isFinite(m.width) ? m.width : 0;
  if (W > refWidth) refWidth = W;
});
if (refWidth <= 0 && body.width) refWidth = body.width;

// For a member-less body, synthesize ONE entry so downstream consumers
// (control law, plot tooling) always see at least one member-shaped
// record with the body's own dims — same treatment physics applies
// in bodyAeroProfile(). Tapered=false: no nose-role record exists to
// infer from; a fairing half is a shell, not a nose.
if (!hasMembers) {
  const soloW = _bodyWidthOf(body);
  const soloH = _bodyHeightOf(body);
  const soloAero = _memberAero(
    { stageRole: null, width: soloW, height: soloH },
    refWidth || soloW, rho, speedRel, sinAlpha
  );
  const soloComY = soloH * 0.5;
  return {
    rx, ry, vx, vy, theta, omega,
    r, altitudeASL, altitudeAGL,
    gMag, gVecX, gVecY, rho,
    windInertial: w,
    earthSurfaceV: { svx, svy },
    relVx, relVy, speedRel,
    Q, velBodyX, sinAlpha, alphaDeg,
    dragMag, dragVecX, dragVecY,
    thrustTotal, mdotTotal, thrustBodyX, thrustBodyY,
    massProps,
    memberBreakdown: [{
      index: 0, id: body.id || '(solo)', role: '(solo)',
      H: soloH, W: soloW, baseY: 0,
      mass: massProps.M,
      comX: 0, comY: soloComY, comY_stack: soloComY,
      copY: soloAero.copY_body, copY_stack: soloAero.copY_body,
      copY_linear: soloAero.copY_linear,
      copY_linear_stack: soloAero.copY_linear,
      presentedArea: soloAero.presentedArea,
      aAxial: soloAero.aAxial, aSide: soloAero.aSide,
      drag: soloAero.drag,
      Fnormal_linear: soloAero.Fnormal_linear,
      Fnormal_crossflow: soloAero.Fnormal_crossflow,
      isTapered: soloAero.isTapered,
    }],
    hasMembers: false,
  };
}

let cumY = 0;
const memberBreakdown = members.map((m, i) => {  const H = Number.isFinite(m.height) ? m.height : 0;
  const W = Number.isFinite(m.width) ? m.width : 0;
  
  // CoM — pulled from the mass-props components array (member-local,
  // already computed above).
  // CoM — pull from the mass-props components array. Filter by the
// _memberIdx tag (_stackMassProps sets it directly), NOT by a
// yOffset window: a stage's engines sit at stack-Y = booster top,
// which is exactly the boundary between two windows, so window-
// based filtering double-counted them.
const memberComponents = massProps.components.filter(c => c._memberIdx === i);
  let comLocalX = 0, comLocalY = H / 2, memberMass = 0;
  if (memberComponents.length) {
    const combined = _combine(memberComponents.map(c => ({ ...c, comY: c.comY - cumY })));
    comLocalX = combined.comX;
    comLocalY = combined.comY;
    memberMass = combined.M;
  }
  
  const aero = _memberAero(m, refWidth, rho, speedRel, sinAlpha);
  
  const entry = {
    index: i,
    id: m.id,
    role: m.stageRole || 'rocket',
    H, W,
    baseY: cumY,                // stack-frame base height of this member
    mass: memberMass,
    comX: comLocalX,            // member-local
    comY: comLocalY,            // member-local (from member base)
    comY_stack: cumY + comLocalY,
    copY: aero.copY_body,       // member-local
    copY_stack: cumY + aero.copY_body,
    copY_linear: aero.copY_linear,
    copY_linear_stack: aero.copY_linear !== null ? cumY + aero.copY_linear : null,
    presentedArea: aero.presentedArea,
    aAxial: aero.aAxial,
    aSide: aero.aSide,
    drag: aero.drag,
    Fnormal_linear: aero.Fnormal_linear,
    Fnormal_crossflow: aero.Fnormal_crossflow,
    isTapered: aero.isTapered,
  };
  cumY += H;
  return entry;
});

return {
    // Kinematics (raw, from snapshot)
    rx, ry, vx, vy, theta, omega,
    // Position-derived
    r, altitudeASL, altitudeAGL,
    // Gravity
    gMag, gVecX, gVecY,
    // Atmosphere
    rho,
    // Wind + relative velocity
    windInertial: w,
    earthSurfaceV: { svx, svy },
    relVx, relVy, speedRel,
    // Dynamic pressure
    Q,
    // AoA
    velBodyX, sinAlpha, alphaDeg,
    // Drag
    dragMag, dragVecX, dragVecY,
    // Thrust
    thrustTotal, mdotTotal, thrustBodyX, thrustBodyY,
    // Mass props
        // Mass props
    massProps,
    // Per-member breakdown — one entry per attached member, in stack
    // order (bottom → top). Each has its own CoM, CoP (body-CP and,
    // for tapered, Barrowman linear-CP), presented area, and drag
    // contribution. Attached bodies show all their members here;
    // detached bodies show only what's still on them.
    memberBreakdown,
    hasMembers: true,
    };
    }
    
    // ---- Solo (member-less) body mass properties. ----
    // Mirrors physics's currentGeometry() fallback for a fairing half,
    // ejected package, or released payload: lumped mass at body mid-height,
    // thin-cylinder MOI about that point. Uses body.dryMass + fuelMass.
    function _soloBodyMassProps(body) {
      const M = (Number.isFinite(body.dryMass) ? body.dryMass : 0) +
        (Number.isFinite(body.fuelMass) ? body.fuelMass : 0);
      const H = _bodyHeightOf(body);
      const W = _bodyWidthOf(body);
      // Thin-cylinder MOI about its own COM — same closed form physics
      // uses for the fallback path via momentOfInertia().
      const I = M * (H * H + W * W) / 12;
      const comH = H * 0.5;
      return {
        M,
        comX: 0,
        comY: comH,
        I,
        stackHeight: H,
        dryMass: Number.isFinite(body.dryMass) ? body.dryMass : 0,
        fuelMass: Number.isFinite(body.fuelMass) ? body.fuelMass : 0,
        payloadMass: 0,
        components: [{ label: 'solo', mass: M, comX: 0, comY: comH, iOwn: I }],
      };
    }
    
    // Convenience: run derive() for every body in the snapshot.
    // Returns an array, one entry per body (same order as snapshot.bodies).
    // Bodies with no members (e.g. released payload, fairing half) get
    // whatever derive() can legitimately return — the per-body derivation
    // is uniform across the array, so callers don't need to special-case
    // which body they're looking at.
    function deriveAllBodies(snapshot, perBodyPayloadMass) {
      if (!snapshot || !Array.isArray(snapshot.bodies)) return [];
      return snapshot.bodies.map((_, i) => {
        const pm = Array.isArray(perBodyPayloadMass) ? perBodyPayloadMass[i] : undefined;
        try { return derive(snapshot, i, pm); }
        catch (e) { return null; }
      });
    }
  
  // ---- IMU wiring. setEnabled()/measure() are globals from imu.js. ----
  function setImuEnabled(enabled) {
    setEnabled(enabled); // imu.js global
  }
  
  // Called by guidance.worker.js on every 'snapshot' message from main
  // thread. Applies (or, per imu.js's own identity contract, doesn't
  // apply) IMU error, stores both copies, and hands off to tick().
  function onSnapshot(rawSnapshot) {
    _lastRawSnapshot = rawSnapshot;
    _lastMeasuredSnapshot = measure(rawSnapshot); // imu.js global; identity when disabled
    tick(_lastMeasuredSnapshot);
  }
  
  // PHASE 4 HOOK. Called once per snapshot with the (possibly IMU-errored)
  // state. Empty in Phase 3 — no control law yet. A real implementation
  // reads `snapshot.bodies[snapshot.activeBodyIndex]` and calls the
  // send() helpers below; it should NOT reach for _lastRawSnapshot (that
  // would defeat the entire point of routing through IMU).
  function tick(snapshot) {
    // no-op — Phase 4
  }
  
  // ---- Outbound: send a command to the physics worker. ----
  function send(msg) {
    if (!_physicsSend) {
      console.warn('[guidance] send() called before physics port connected:', msg);
      return;
    }
    _physicsSend(msg);
  }
  
  // ---- Command builders — one per message type in the interface
  // contract (IMU_PROMPT_md.txt, "Command messages"). These only shape
  // the message; clamping/validation is the physics worker's job (same
  // as for human UI commands — guidance is not a trusted client, it goes
  // through the identical clamp path clampMassFlowCommand() etc. use).
  // Every one of these is usable directly from this worker's devtools
  // console for manual testing, e.g.:
  //   Guidance.send(Guidance.cmdSetAllThrottle(Infinity))
  // ----
  
  // A. Existing messages, reused verbatim.
  function cmdSetGroupThrottle(angles, kgPerSec) { return { type: 'setGroupThrottle', angles, value: kgPerSec }; }
  function cmdSetCenterThrottle(kgPerSec) { return { type: 'setCenterThrottle', value: kgPerSec }; }
  function cmdSetAllThrottle(kgPerSec) { return { type: 'setAllThrottle', value: kgPerSec }; }
  function cmdRcs(key, on) { return { type: 'rcs', key, on: !!on }; }
  function cmdLegs(deployed) { return { type: 'legs', deployed: !!deployed }; }
  function cmdSeparate() { return { type: 'separate' }; }
  function cmdSplitFairing() { return { type: 'splitFairing' }; }
  function cmdReleasePayload() { return { type: 'releasePayload' }; }
  function cmdEmergencyEject() { return { type: 'emergencyEject' }; }
  function cmdTakeControl(idx) { return { type: 'takeControl', idx }; }
  function cmdWarp(value) { return { type: 'warp', value }; } // available but discouraged, see spec "Out of scope"
  function cmdSetFuelMass(value) { return { type: 'setFuelMass', value }; } // allowed but discouraged (pad-only, enforced worker-side)
  
  // B. New in Phase 3 — rate-not-angle gimbal, per-nozzle RCS duty.
  function cmdSetGimbalRate(degPerSec) { return { type: 'setGimbalRate', degPerSec }; }
  // duties: { TL:{lat,up,dn}, TR:{...}, BL:{...}, BR:{...} }, any subset of
  // nozzles/pods. Issue C (round 2): passes `duties` through AS-IS — this
  // is deliberate, not an oversight. Call cmdRcsDuty(null) (or with no
  // argument) to relinquish RCS duty control back to the boolean rcsCmd
  // path; physics_worker.js's 'rcsDuty' handler treats a null/undefined
  // duties payload as "release", not "hold at all-zero". Sending
  // cmdRcsDuty({}) or all-zero nozzle objects is NOT the same thing — that
  // still latches duty control, just at zero force.
  function cmdRcsDuty(duties) { return { type: 'rcsDuty', duties }; }
  
  return {
    init,
    setImuEnabled,
    setStackData,
    getStackData,
    getMemberRecord,
    getTypeById,
    getEnv,
    getStackPayloadMass,
    getStackPayloadMass,
// Derivation module
// Derivation module
derive,
deriveAllBodies,
memberMaxFuel: _memberMaxFuel,
// Lower-level pieces, exposed for callers who want just one quantity
// without the full derive() object.
combineComponents: _combine,
sloshMassFraction: _sloshMassFraction,
sloshCentroidFrac: _sloshCentroidFrac,
    onSnapshot,
    tick, // exposed so Phase 4 can override/replace this single function
    send,
    cmdSetGroupThrottle,
    cmdSetCenterThrottle,
    cmdSetAllThrottle,
    cmdRcs,
    cmdLegs,
    cmdSeparate,
    cmdSplitFairing,
    cmdReleasePayload,
    cmdEmergencyEject,
    cmdTakeControl,
    cmdWarp,
    cmdSetFuelMass,
    cmdSetGimbalRate,
    cmdRcsDuty,
    // exposed for debugging/inspection from the worker's devtools console
    get lastRawSnapshot() { return _lastRawSnapshot; },
    get lastMeasuredSnapshot() { return _lastMeasuredSnapshot; },
  };
})();
