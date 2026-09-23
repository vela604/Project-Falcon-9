// ============================================================================
// derivation.js — Self-contained mass-property + aero + kinematics
// derivation module for the guidance worker.
//
// Runs inside guidance.worker.js (importScripts). Does NOT import
// componentLibrary.js, fleet.js, config.js, massProps.js, physics.js —
// none of those exist in this scope. Everything it derives comes from:
//   1. The one-time stack data main thread sends via setStackData()
//   2. The live snapshot the physics worker ships every tick
//   3. Its own reimplementation of the physics formulas
//
// Nothing here talks to `Guidance` or `GuideRCS`. It exposes a plain
// `Derivation` object that other modules call into.
// ============================================================================

const Derivation = (function () {
  
  // --- Stack data (boot handoff from main thread) ---
  let _stackData = null;
  
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
  // Constants — same values physics uses internally.
  // ============================================================
  const _SLOSH_LAMBDA1 = 1.841;
  const _INTERSTAGE_DENSITY = 1600;
  const _BODY_SHELL_FACTOR_NOSE = 0.0165;
  
  // Barrowman + Allen-Perkins (computeDragAero in physics.js).
  const _AERO_CP_NOSE_FRAC = 0.90;
  const _AERO_CP_BODY_FRAC = 0.50;
  const _AERO_CP_NOSE_LINEAR_FRAC = 0.466;
  const _AERO_CNALPHA_NOSE = 2.0;
  const _AERO_CD_CROSSFLOW = 1.2;
  
  // ============================================================
  // Small helpers
  // ============================================================
  function _envNum(key, fallback) {
    const e = getEnv();
    return (e && Number.isFinite(e[key])) ? e[key] : fallback;
  }
  function _cylI(m, r, h) { return 0.5 * m * r * r + (1 / 12) * m * h * h; }
  function _coneI(m, r, h) { return (3 / 20) * m * r * r + (3 / 80) * m * h * h; }
  function _rodI(m, L) { return (1 / 12) * m * L * L; }
  
  function typeParam(type, key) {
    if (!type || !Array.isArray(type.parameterSchema)) return undefined;
    const e = type.parameterSchema.find(p => p.key === key);
    return e ? e.value : undefined;
  }
  
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
  
  // ============================================================
  // Per-member sub-component builders
  // ============================================================
  function _memberMaxFuel(rec, aboveRec) {
    if (!rec) return 0;
    const role = rec.stageRole || 'rocket';
    if (role === 'nose' || role === 'payloadSpace') return 0;
    if (role === 'booster' || role === 'stage') {
      const t = rec.fuel;
      if (!t) return 0;
      const fuelType = getTypeById(t.typeId);
      if (!fuelType) return 0;
      const density = typeParam(fuelType, 'propellantDensity');
      if (!Number.isFinite(density)) return 0;
      const tankH = Number.isFinite(t.tankHeight) ? t.tankHeight : 0;
      const tankW = Number.isFinite(t.tankWidth) ? t.tankWidth : 0;
      return Math.PI * (tankW / 2) ** 2 * tankH * density;
    }
    return Number.isFinite(rec.fuelMassMax) ? rec.fuelMassMax : 0;
  }
  
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
      const ve = typeParam(t, 've');
      const twr = typeParam(t, 'twr');
      if (!Number.isFinite(ve) || !Number.isFinite(g.massFlowRate)) return;
      const thrustPer = g.massFlowRate * ve;
      const massPer = (Number.isFinite(twr) && twr > 0) ? thrustPer / (twr * G0) : 0;
      const posX = (slot.angleDeg === null || slot.angleDeg === undefined)
        ? 0 : R * Math.cos(slot.angleDeg * Math.PI / 180);
      totalMass += massPer;
      sumXmass += massPer * posX;
    });
    if (totalMass > 0) {
      out.push({ label: 'engines', mass: totalMass, comX: sumXmass / totalMass, comY: 0, iOwn: 0 });
    }
    return out;
  }
  
  function _legComponents(rec, legsProgress) {
    const out = [];
    if (rec.hasRecovery === false) return out;
    const recoveryType = getTypeById(rec.recoveryTypeId);
    if (!recoveryType || recoveryType.kind !== 'legsOnVehicle') return out;
    if (!recoveryType.capabilities || !recoveryType.capabilities.deploysOnVehicle) return out;
    
    const H = Number.isFinite(rec.height) ? rec.height : 0;
    const W = Number.isFinite(rec.width) ? rec.width : 0;
    const bodyH_forLegs = (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) ? rec.fuel.tankHeight : H;
    
    const hingeY = -bodyH_forLegs * 0.004;
    const legLength = bodyH_forLegs * 0.27;
    const maxSweepRad = 125 * Math.PI / 180;
    const hingeLocalY = -hingeY;
    const sweep = (legsProgress || 0) * maxSweepRad;
    const tipLocalY = hingeLocalY + legLength * Math.cos(sweep);
    const midLocalY = (hingeLocalY + tipLocalY) / 2;
    
    const avgThickness = 0.065 * W;
    const avgDepth = 0.04 * W;
    const oneLegVolume = legLength * avgThickness * avgDepth;
    const legsMetal = getTypeById(rec.legsMetalTypeId) || getTypeById(rec.bodyMetalTypeId);
    const density = legsMetal ? (typeParam(legsMetal, 'density') || 0) : 0;
    const legMass = oneLegVolume * density;
    
    const legXs = [-W / 2, W / 2, -W * 0.375, W * 0.375];
    for (let i = 0; i < legXs.length; i++) {
      out.push({
        label: 'leg' + i, mass: legMass, comX: legXs[i], comY: midLocalY,
        iOwn: _rodI(legMass, legLength),
      });
    }
    return out;
  }
  
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
  
  function _memberComponents(rec, aboveRec, memberFuelMass, legsProgress, sloshOffset) {
    const role = rec.stageRole || 'rocket';
    const H = Number.isFinite(rec.height) ? rec.height : 0;
    const W = Number.isFinite(rec.width) ? rec.width : 0;
    const r = W / 2;
    const out = [];
    
    if (role === 'nose') {
      const metal = getTypeById(rec.bodyMetalTypeId);
      const density = metal ? (typeParam(metal, 'density') || 0) : 0;
      const coneVol = (1 / 3) * Math.PI * r * r * H;
      const mass = coneVol * _BODY_SHELL_FACTOR_NOSE * density;
      out.push({ label: 'nose', mass, comX: 0, comY: H / 4, iOwn: _coneI(mass, r, H) });
      return out;
    }
    if (role === 'payloadSpace') {
      const metal = getTypeById(rec.payloadSpaceMetalTypeId);
      const density = metal ? (typeParam(metal, 'density') || 0) : 0;
      const p = rec.params || {};
      const capH = p.capHeight || 0;
      const capW = p.capWidth || 0;
      const bulgeW = p.bulgeWidth || capW;
      const rBulge = bulgeW / 2;
      const coneH = capH * 0.4, cylH = capH * 0.6;
      const coneSlant = Math.sqrt(rBulge * rBulge + coneH * coneH);
      const lateralArea = Math.PI * rBulge * coneSlant + 2 * Math.PI * rBulge * cylH;
      const shellFrac = Number.isFinite(rec.bodyShellFactor) ? rec.bodyShellFactor : 0.0026;
      const vol = lateralArea * rBulge * shellFrac;
      const mass = vol * density;
      out.push({ label: 'payloadSpace', mass, comX: 0, comY: H / 2, iOwn: _cylI(mass, capW / 2, H) });
      return out;
    }
    
    let bodyMass = 0, bodyH = H, interstageMass = 0, interstageH = 0;
    if (role === 'booster' || role === 'stage') {
      const t = rec.fuel || {};
      const tankH = Number.isFinite(t.tankHeight) ? t.tankHeight : H;
      const tankW = Number.isFinite(t.tankWidth) ? t.tankWidth : W;
      const metalType = getTypeById(rec.bodyMetalTypeId);
      const metalDensity = metalType ? (typeParam(metalType, 'density') || 0) : 0;
      const shellF = Number.isFinite(rec.bodyShellFactor)
        ? rec.bodyShellFactor : (role === 'booster' ? 0.01797 : 0.0147);
      const tankVol = Math.PI * (tankW / 2) ** 2 * tankH;
      bodyMass = tankVol * shellF * metalDensity;
      bodyH = tankH;
      if (role === 'booster') {
  // Prefer the frozen value from stack-level derived (sent at boot
  // in stackData). Falls back to the live compute for stacks that
  // predate freezing — keeps guidance's numbers bit-identical to
  // physics in the common case, and correct-but-legacy otherwise.
  const sd = getStackData();
  const frozen = (sd && sd.derived && sd.derived.interstage) ?
    sd.derived.interstage[rec.id] : null;
  if (frozen && Number.isFinite(frozen.height) && Number.isFinite(frozen.mass)) {
    interstageH = frozen.height;
    interstageMass = frozen.mass;
  } else {
    const bellH = _stageAboveBellHeight(aboveRec);
    const ish = Math.max(bellH * 1.20, 0.06 * tankH);
    const r_b = tankW / 2;
    const shellThk = shellF * r_b;
    interstageMass = 2 * Math.PI * r_b * shellThk * ish * _INTERSTAGE_DENSITY;
    interstageH = ish;
  }
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
  
  function _stackMassProps(bodySnapshot, payloadMass) {
  const members = (bodySnapshot && bodySnapshot.members) || [];
  if (!members.length) return null;
  const fuelTotal = bodySnapshot.fuelMass || 0;
  const memberFuelArr = Array.isArray(bodySnapshot.memberFuel) ? bodySnapshot.memberFuel : null;
  const usePerMember = memberFuelArr && memberFuelArr.length === members.length;
  const legsProgress = bodySnapshot.legs ? (bodySnapshot.legs.progress || 0) : 0;
  const sloshOffset = bodySnapshot.slosh ? (bodySnapshot.slosh.offset || 0) : 0;
    
    const maxFuels = members.map((m, i) => _memberMaxFuel(m, members[i + 1] || null));
    const sumMax = maxFuels.reduce((s, x) => s + x, 0);
    
    const all = [];
    let yOffset = 0;
    let payloadSpaceComY = null;
    let payloadSpaceIdx = -1;
    members.forEach((m, i) => {
      const memberFuel = usePerMember ?
        Math.max(0, memberFuelArr[i] || 0) :
        (sumMax > 0 ? fuelTotal * (maxFuels[i] / sumMax) : 0);
        const memberLegs = (i === 0) ? legsProgress : 0;
      const memberSlosh = (i === 0) ? sloshOffset : 0;
      const comps = _memberComponents(m, members[i + 1] || null, memberFuel, memberLegs, memberSlosh);
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
      M: combined.M, comX: combined.comX, comY: combined.comY, I: combined.I,
      stackHeight: yOffset,
      dryMass: Math.max(0, combined.M - fuelTotal),
      fuelMass: fuelTotal,
      payloadMass: cargo,
      components: all,
    };
  }
  
  function _soloBodyMassProps(body) {
    const M = (Number.isFinite(body.dryMass) ? body.dryMass : 0)
            + (Number.isFinite(body.fuelMass) ? body.fuelMass : 0);
    const H = _bodyHeightOf(body);
    const W = _bodyWidthOf(body);
    const I = M * (H * H + W * W) / 12;
    const comH = H * 0.5;
    return {
      M, comX: 0, comY: comH, I,
      stackHeight: H,
      dryMass: Number.isFinite(body.dryMass) ? body.dryMass : 0,
      fuelMass: Number.isFinite(body.fuelMass) ? body.fuelMass : 0,
      payloadMass: 0,
      components: [{ label: 'solo', mass: M, comX: 0, comY: comH, iOwn: I }],
    };
  }
  
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
  
  function _memberAero(member, refWidth, rho, speedRel, sinAlpha) {
    const H = Number.isFinite(member.height) ? member.height : 0;
    const W = Number.isFinite(member.width) ? member.width : 0;
    const isTapered = (member.stageRole === 'nose') || (member.stageRole === 'payloadSpace');
    const wCross = Math.min(1, Math.abs(sinAlpha));
    const aAxial = Math.PI * (W / 2) ** 2;
    const aSide = W * H;
    const aEff = aAxial * (1 - wCross) + aSide * wCross;
    const cd = _envNum('DRAG_CD', 0.6);
    const drag = (rho > 0 && speedRel > 1e-3)
      ? 0.5 * rho * cd * aEff * speedRel * speedRel : 0;
    const cpBodyFrac = isTapered
      ? (_AERO_CP_NOSE_FRAC * (1 - wCross) + _AERO_CP_BODY_FRAC * wCross)
      : _AERO_CP_BODY_FRAC;
    const copY_body = H * cpBodyFrac;
    const copY_linear = isTapered ? H * _AERO_CP_NOSE_LINEAR_FRAC : null;
    const q = 0.5 * rho * speedRel * speedRel;
    const S_ref = Math.PI * (refWidth / 2) ** 2;
    const sinAbs = Math.abs(sinAlpha);
    const F_lin = isTapered ? (-q * _AERO_CNALPHA_NOSE * S_ref * sinAlpha) : 0;
    const F_cross = -q * _AERO_CD_CROSSFLOW * aSide * sinAbs * sinAlpha;
    return {
      isTapered, wCross,
      presentedArea: aEff, aAxial, aSide, drag,
      copY_body, copY_linear,
      Fnormal_linear: F_lin,
      Fnormal_crossflow: F_cross,
    };
  }
  
  // ============================================================
  // derive() — the master function. One body per call.
  // ============================================================
  function derive(snapshot, bodyIdx, payloadMass) {
    if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
    const idx = Number.isInteger(bodyIdx) ? bodyIdx : (snapshot.activeBodyIndex || 0);
    const body = snapshot.bodies[idx];
    if (!body) return null;
    const env = getEnv();
    if (!env) return null;
    
    const hasMembers = Array.isArray(body.members) && body.members.length > 0;
    const members = body.members || [];
    
    const rx = body.rx, ry = body.ry, vx = body.vx, vy = body.vy;
    const theta = body.theta, omega = body.omega;
    
    const r = Math.hypot(rx, ry);
    const altitudeASL = r - env.EARTH_RADIUS;
    const altitudeAGL = altitudeASL - (env.LAUNCH_SITE_ALTITUDE || 0);
    
    const gMag = env.GM_EARTH / (r * r);
    const gVecX = r > 0 ? -gMag * rx / r : 0;
    const gVecY = r > 0 ? -gMag * ry / r : 0;
    
    const rho = altitudeASL < 0
      ? env.SEA_LEVEL_DENSITY
      : env.SEA_LEVEL_DENSITY * Math.exp(-altitudeASL / env.SCALE_HEIGHT);
    
    const w = _windInertial(rx, ry, snapshot.wind);
    const omegaE = env.EARTH_OMEGA || 0;
    const svx = omegaE * ry, svy = -omegaE * rx;
    const relVx = vx - (w.wx + svx);
    const relVy = vy - (w.wy + svy);
    const speedRel = Math.hypot(relVx, relVy);
    const Q = 0.5 * rho * speedRel * speedRel;
    
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const velBodyX = speedRel > 1e-6 ? (relVx * cosT + relVy * sinT) : 0;
    const sinAlpha = speedRel > 1e-6 ? Math.max(-1, Math.min(1, velBodyX / speedRel)) : 0;
    const alphaDeg = Math.asin(sinAlpha) * 180 / Math.PI;
    
    let axialArea = 0;
    members.forEach(m => {
      const W = m.width || 0;
      axialArea += Math.PI * (W / 2) ** 2;
    });
    if (axialArea <= 0 && body.width) axialArea = Math.PI * (body.width / 2) ** 2;
    const dragCd = env.DRAG_CD || 0.6;
    const dragMag = (rho > 0 && speedRel > 1e-3)
      ? 0.5 * rho * dragCd * axialArea * speedRel * speedRel : 0;
    const dragVecX = speedRel > 1e-6 ? -dragMag * relVx / speedRel : 0;
    const dragVecY = speedRel > 1e-6 ? -dragMag * relVy / speedRel : 0;
    
    let thrustTotal = 0, mdotTotal = 0, thrustBodyX = 0, thrustBodyY = 0;
    (body.engines || []).forEach(e => {
      if (!(e.massFlowRate > 0)) return;
      const F = e.massFlowRate * e.Ve;
      thrustTotal += F;
      mdotTotal += e.massFlowRate;
      const gRad = (e.gimbal ? (e.gimbalDeg || 0) : 0) * Math.PI / 180;
      thrustBodyX += F * Math.sin(gRad);
      thrustBodyY += F * Math.cos(gRad);
    });
    
// Payload cargo is physically present whenever the body still carries
// an attached payload — the fairing's presence is irrelevant. Once the
// fairing splits and the satellite is exposed but still bolted on, the
// satellite is still part of the stage's mass. Only a released payload
// is gone. (Previously this required the fairing to still be a member,
// so fairing split made the payload silently vanish from guidance's
// mass model while physics kept including it — a 2× I mismatch that
// halved every attitude response during ANG_FOR_APOGEE and
// TARGET_APOGEE.)
const payloadMassInput = 12000; // TEMP: hardcoded, remove after test
const massProps = hasMembers ?
  _stackMassProps(body, payloadMassInput) :
  _soloBodyMassProps(body);
    
    let refWidth = 0;
    members.forEach(m => {
      const W = Number.isFinite(m.width) ? m.width : 0;
      if (W > refWidth) refWidth = W;
    });
    if (refWidth <= 0 && body.width) refWidth = body.width;
    
    let memberBreakdown;
    if (hasMembers) {
      let cumY = 0;
      memberBreakdown = members.map((m, i) => {
        const H = Number.isFinite(m.height) ? m.height : 0;
        const W = Number.isFinite(m.width) ? m.width : 0;
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
          index: i, id: m.id, role: m.stageRole || 'rocket',
          H, W, baseY: cumY,
          mass: memberMass,
          comX: comLocalX, comY: comLocalY, comY_stack: cumY + comLocalY,
          copY: aero.copY_body, copY_stack: cumY + aero.copY_body,
          copY_linear: aero.copY_linear,
          copY_linear_stack: aero.copY_linear !== null ? cumY + aero.copY_linear : null,
          presentedArea: aero.presentedArea,
          aAxial: aero.aAxial, aSide: aero.aSide, drag: aero.drag,
          Fnormal_linear: aero.Fnormal_linear,
          Fnormal_crossflow: aero.Fnormal_crossflow,
          isTapered: aero.isTapered,
        };
        cumY += H;
        return entry;
      });
    } else {
      const soloW = _bodyWidthOf(body);
      const soloH = _bodyHeightOf(body);
      const soloAero = _memberAero(
        { stageRole: null, width: soloW, height: soloH },
        refWidth || soloW, rho, speedRel, sinAlpha
      );
      const soloComY = soloH * 0.5;
      memberBreakdown = [{
        index: 0, id: body.id || '(solo)', role: '(solo)',
        H: soloH, W: soloW, baseY: 0,
        mass: massProps.M,
        comX: 0, comY: soloComY, comY_stack: soloComY,
        copY: soloAero.copY_body, copY_stack: soloAero.copY_body,
        copY_linear: soloAero.copY_linear, copY_linear_stack: soloAero.copY_linear,
        presentedArea: soloAero.presentedArea,
        aAxial: soloAero.aAxial, aSide: soloAero.aSide, drag: soloAero.drag,
        Fnormal_linear: soloAero.Fnormal_linear,
        Fnormal_crossflow: soloAero.Fnormal_crossflow,
        isTapered: soloAero.isTapered,
      }];
    }
    
    const comY_t = massProps.comY;
    const comX_t = massProps.comX;
    
    let torqueEngine = 0;
    (body.engines || []).forEach(e => {
      if (!(e.massFlowRate > 0)) return;
      const F = e.massFlowRate * e.Ve;
      const gRad = (e.gimbal ? (e.gimbalDeg || 0) : 0) * Math.PI / 180;
      const fx = F * Math.sin(gRad);
      const fy = F * Math.cos(gRad);
      torqueEngine += (e.x - comX_t) * fy + comY_t * fx;
    });
    
    let torqueDrag = 0;
    memberBreakdown.forEach(m => {
      if (m.Fnormal_linear !== 0 && m.copY_linear_stack !== null) {
        torqueDrag += (comY_t - m.copY_linear_stack) * m.Fnormal_linear;
      }
      if (m.Fnormal_crossflow !== 0) {
        torqueDrag += (comY_t - m.copY_stack) * m.Fnormal_crossflow;
      }
    });
    
    const torqueRcs = 0;
    const torqueTotal = torqueEngine + torqueDrag + torqueRcs;
    const _I = massProps.I > 0 ? massProps.I : 0;
    const alphaEngine = _I > 0 ? torqueEngine / _I : 0;
    const alphaDrag   = _I > 0 ? torqueDrag   / _I : 0;
    const alphaRcs    = _I > 0 ? torqueRcs    / _I : 0;
    const alphaAng    = _I > 0 ? torqueTotal  / _I : 0;
    
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
      torqueEngine, torqueDrag, torqueRcs, torqueTotal,
      alphaEngine, alphaDrag, alphaRcs, alphaAng,
      memberBreakdown,
      hasMembers,
    };
  }
  
  function deriveAllBodies(snapshot, perBodyPayloadMass) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return [];
  return snapshot.bodies.map((_, i) => {
    const pm = Array.isArray(perBodyPayloadMass) ? perBodyPayloadMass[i] : undefined;
    try { return derive(snapshot, i, pm); }
    catch (e) { return null; }
  });
}

// ------------------------------------------------------------------
// deriveForState(snapshot, idx, overrideBody)
//
// Runs derive() against a VIRTUAL body — same as snapshot.bodies[idx]
// but with the given fields overridden. Used by predictive guidance to
// ask "what would the state look like one tick from now?" without
// touching the real snapshot or the physics worker.
//
// Only the overridden fields change. members / pods / engines / env /
// wind all come from the original snapshot — so the derived COM, CoP,
// A_eff, drag torque, and every other output reflect the OVERRIDDEN
// kinematics and slosh, exactly as physics would compute them if the
// body were in that state.
// ------------------------------------------------------------------
function deriveForState(snapshot, idx, overrideBody, gimbalOverrideDeg) {
  if (!snapshot || !snapshot.bodies || !snapshot.bodies[idx]) return null;
  const origBody = snapshot.bodies[idx];
  const virtualBody = Object.assign({}, origBody, overrideBody);
  // Optional gimbal override: apply the given angle to every gimbal-
  // capable engine on the body. Used by gimbal-based predictive
  // guidance to answer "what does S_{N+k} look like if gimbal is X?"
  // without mutating the real snapshot.
  if (Number.isFinite(gimbalOverrideDeg) && Array.isArray(origBody.engines)) {
    virtualBody.engines = origBody.engines.map(e => {
      if (e.gimbal) return Object.assign({}, e, { gimbalDeg: gimbalOverrideDeg });
      return e;
    });
  }
  const virtualSnap = Object.assign({}, snapshot, {
    bodies: snapshot.bodies.slice(),
  });
  virtualSnap.bodies[idx] = virtualBody;
  return derive(virtualSnap, idx);
}
  
  return {
    // Stack data
    setStackData, getStackData, getMemberRecord, getTypeById, getEnv, getStackPayloadMass,
    // Derivation
    // Derivation
derive, deriveAllBodies, deriveForState,
    // Lower-level helpers (exposed for debugging and per-fragment use)
    typeParam, combineComponents: _combine, memberMaxFuel: _memberMaxFuel,
    sloshMassFraction: _sloshMassFraction,
    sloshCentroidFrac: _sloshCentroidFrac,
  };
})();