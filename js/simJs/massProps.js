// ============================================================================
// massProps.js — Component-based mass properties for the sim stack (P4-C3a).
//
// Every member (booster/stage/nose/legacy-rocket) is decomposed into its
// physical COMPONENTS: body shell, engines, landing legs, payload space,
// fuel. Each component carries { mass, comX, comY, iOwn } in the member's
// LOCAL frame (base = 0, +Y = up toward nose).
//
// The sim combines:
//   - Within a member → member-level { M, comX, comY, I } via combineComponents
//   - Across members → stack-level, offsetting each member's comY by its
//     cumulative height from the bottom
//
// Symmetry simplification: X components of symmetric sub-parts (left/right
// legs, ring of engines) cancel in the total COM, but they're STILL computed
// per-part so MOI includes their true (x² + y²) distance from the total COM.
//
// Live/variable quantities (no if-branches, per user's directive):
//   - Legs: each leg's midpoint moves with deployment progress. Recomputed
//     every call.
//   - Fuel: stack fuel is distributed proportionally to each member's max
//     tank capacity; each member's fuel column height scales with its share.
// ============================================================================

// Thin-wall cylindrical shell, transverse MOI about own COM (rotation in
// the pitch plane → axis perpendicular to member's long axis).
//   I = (1/2) m r² + (1/12) m h²
function _thinCylinderI(m, r, h) {
  return 0.5 * m * r * r + (1 / 12) * m * h * h;
}

// Solid cone about transverse axis through own COM (used for nose).
//   I ≈ (3/20) m r² + (3/80) m h²
function _coneTransverseI(m, r, h) {
  return (3 / 20) * m * r * r + (3 / 80) * m * h * h;
}

// Thin rod of length L about its own COM, perpendicular to length.
function _rodI(m, L) {
  return (1 / 12) * m * L * L;
}

// ---------------------------------------------------------------------------
// Maximum fuel a single member can carry (kg). Used for proportional
// distribution of the stack's total fuel.
// ---------------------------------------------------------------------------
function memberMaxFuel(rec, aboveMember) {
  if (!rec) return 0;
  const role = rec.stageRole || 'rocket';
  if (role === 'nose' || role === 'payloadSpace') return 0;
  if (role === 'booster') {
    const d = (typeof boosterDerivedMasses === 'function') ? boosterDerivedMasses(rec, aboveMember) : null;
    return (d && Number.isFinite(d.fuelMass)) ? d.fuelMass : 0;
  }
  if (role === 'stage') {
    const d = (typeof stageDerivedMasses === 'function') ? stageDerivedMasses(rec) : null;
    return (d && !d.infeasible && Number.isFinite(d.fuelMass)) ? d.fuelMass : 0;
  }
  return Number.isFinite(rec.fuelMassMax) ? rec.fuelMassMax : 0;
}

// ---------------------------------------------------------------------------
// Per-member component decomposition. Returns an array of
//   { label, mass, comX, comY, iOwn }
// in the member's LOCAL frame (base = 0, +Y up).
//
// legsProgress is applied ONLY to the bottom member (see stackMassProps) —
// upper members' legs are cosmetically stowed.
// ---------------------------------------------------------------------------
function memberComponents(rec, memberFuelMass, legsProgress, aboveMember) {
  const out = [];
  if (!rec) return out;
  const role = rec.stageRole || 'rocket';
  const H = Number.isFinite(rec.height) ? rec.height : 0;
  const W = Number.isFinite(rec.width) ? rec.width : 0;
  const r = W / 2;

  // ---- Nose: single cone component ----
  if (role === 'nose') {
    const mass = (typeof computeNoseDryMass === 'function') ? computeNoseDryMass(rec) : 0;
    out.push({
      label: 'nose',
      mass,
      comX: 0,
      comY: H / 2,     // cone centroid is 1/4 up from base, but keep H/2 as a simple placeholder
      iOwn: _coneTransverseI(mass, r, H),
    });
    return out;
  }

  // ---- Payload space (standalone fairing member): structural shell only,
  // no engines/legs/fuel — same shape as the nose branch above. Previously
  // missing entirely, so a standalone payloadSpace member silently flew at
  // 0 kg (fell into the generic body-mass branch below, which reads
  // rec.dryMass — a field payloadSpace records never set). ----
  if (role === 'payloadSpace') {
    const mass = (typeof computePayloadSpaceDryMass === 'function') ? computePayloadSpaceDryMass(rec) : 0;
    out.push({
      label: 'payloadSpace',
      mass,
      comX: 0,
      comY: H / 2,     // simple placeholder, same convention as nose
      iOwn: _thinCylinderI(mass, r, H),
    });
    return out;
  }

  // ---- Body (cylindrical shell/tank) ----
  let bodyMass = 0, bodyH = H;
  if (role === 'booster') {
    const d = boosterDerivedMasses(rec, aboveMember);
    bodyMass = d ? d.bodyMass : 0;
    if (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) bodyH = rec.fuel.tankHeight;
    // BUG #4 FIX: the interstage (black cylinder at the booster's top,
    // sized off whatever's actually stacked above it) was computed by
    // fleet.js and folded into the Fleet-page dry-mass display, but never
    // turned into an actual physics component here — so the simulator's
    // real flying mass/MOI silently omitted it, while the Fleet page's
    // number included it. Push it as its own component so both agree.
    if (d && Number.isFinite(d.interstageMass) && d.interstageMass > 0) {
      const interH = Number.isFinite(d.interstageHeight) ? d.interstageHeight : 0;
      out.push({
        label: 'interstage',
        mass: d.interstageMass,
        comX: 0,
        comY: bodyH - interH / 2,   // sits at the very top of the body
        iOwn: _thinCylinderI(d.interstageMass, r, interH),
      });
    }
  } else if (role === 'stage') {
    const d = stageDerivedMasses(rec);
    bodyMass = d ? d.bodyMass : 0;
    if (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) bodyH = rec.fuel.tankHeight;
  } else {
    // legacy rocket — one lumped dry body
    bodyMass = Number.isFinite(rec.dryMass) ? rec.dryMass : 0;
  }
  out.push({
    label: 'body',
    mass: bodyMass,
    comX: 0,
    comY: bodyH / 2,                       // cylinder centroid at mid-height
    iOwn: _thinCylinderI(bodyMass, r, bodyH),
  });

  // ---- Engines (per-engine positions aggregated, so future asymmetric
  // layouts just work) ----
  if (typeof getComponentType === 'function') {
    const engineType = getComponentType(rec.engineTypeId);
    if (engineType && engineType.frame && Array.isArray(engineType.frame.slots)) {
      const groups = (typeof engineThrusterGroups === 'function')
        ? engineThrusterGroups(engineType) : {};
      const R = (rec.params && Number.isFinite(rec.params.octaRadius)) ?
  rec.params.octaRadius :
  CONFIG.OCTA_RADIUS; // fallback

      let totalM = 0, sumX = 0, sumY = 0;
      Object.keys(groups).forEach(gk => {
        const g = rec.engineThrusters && rec.engineThrusters[gk];
        if (!g) return;
        const t = getComponentType(g.thrusterTypeId);
        if (!t) return;
        const veEntry = t.parameterSchema.find(p => p.key === 've');
        if (!veEntry || !Number.isFinite(g.massFlowRate)) return;
        const thrustPer = g.massFlowRate * veEntry.value;
        const massPer = (typeof engineMassFromThrust === 'function')
          ? engineMassFromThrust(t, thrustPer) : NaN;
        if (!Number.isFinite(massPer)) return;
        groups[gk].forEach(slot => {
          const pos = (typeof slot.position === 'function') ? slot.position(R) : { x: 0 };
          totalM += massPer;
          sumX += massPer * (pos.x || 0);
          sumY += massPer * 0; // engines sit at base (y=0)
        });
      });
      if (totalM > 0) {
        out.push({
          label: 'engines',
          mass: totalM,
          comX: sumX / totalM,
          comY: sumY / totalM,
          iOwn: 0,   // small objects; own MOI negligible for now
        });
      }
    }
  }

  // ---- Landing legs (LIVE: recomputed from legsProgress every call) ----
  if (rec.hasRecovery !== false && typeof getComponentType === 'function') {
    const recoveryType = getComponentType(rec.recoveryTypeId);
    const canDeploy = recoveryType
      && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle
      && recoveryType.frame && typeof recoveryType.frame.hingeGeometry === 'function'
      && typeof recoveryType.frame.structuralVolume === 'function';
    if (canDeploy) {
      const legCount = recoveryType.frame.legCount || 4;
      const legGeo = recoveryType.frame.hingeGeometry(H);

      // Hinge distance from base (canvas: y=0 base, y=-H nose; convert sign).
      const hingeLocalY = -legGeo.hingeY;
      const sweep = legsProgress * legGeo.maxSweepRad;

      // Tip distance from base, computed LIVE from current deployment.
      const tipLocalY = hingeLocalY + legGeo.legLength * Math.cos(sweep);
      // Leg midpoint = leg's COM (per user's simplification).
      const midLocalY = (hingeLocalY + tipLocalY) / 2;

      // Leg X position: visible legs at ±W/2, back legs at ±0.375W (matches
      // rocketArt's 0.75 depth factor). Symmetric → total X cancels, but
      // each leg contributes to MOI via (x² + y²).
      const sideXFront = W / 2;
      const sideXBack  = W * 0.375;

      const bodyMetal = getComponentType(rec.bodyMetalTypeId);
      const bodyDensity = (bodyMetal && bodyMetal.parameterSchema.find(p => p.key === 'density'))
        ? bodyMetal.parameterSchema.find(p => p.key === 'density').value : 1;
      const oneLegMass = recoveryType.frame.structuralVolume(H, W) * bodyDensity;
      const legMassOne = oneLegMass; // per leg

      // 4 legs (2 front, 2 back) — symmetric X pairs.
      const legXs = [-sideXFront, sideXFront, -sideXBack, sideXBack];
      const legMassTotal = legMassOne * legCount;
      // Total legs as one combined component at (sumMassX, sumMassY) — X
      // cancels to 0, Y is same for all 4 (midpoint), so we can drop in as
      // a single component with iOwn = 0 and let the (dx² + dy²) term carry
      // the distance to the member's COM.
      // But to preserve per-leg MOI, iterate here instead:
      legXs.forEach((lx, i) => {
        out.push({
          label: 'leg' + (i + 1),
          mass: legMassOne,
          comX: lx,
          comY: midLocalY,
          iOwn: _rodI(legMassOne, legGeo.legLength),
        });
      });
    }
  }

  // ---- Payload space (stage only) ----
  if (role === 'stage' && typeof stageDerivedMasses === 'function') {
    const d = stageDerivedMasses(rec);
    if (d && !d.infeasible && d.payloadContainerMass > 0) {
      // Payload space sits at the TOP of the stage (above the fuel tank).
      const capH = (rec.payloadSpace && rec.payloadSpace.params && Number.isFinite(rec.payloadSpace.params.capHeight))
        ? rec.payloadSpace.params.capHeight : 0;
      const payloadCOM = H - capH / 2;
      out.push({
        label: 'payloadSpace',
        mass: d.payloadContainerMass,
        comX: 0,
        comY: payloadCOM,
        iOwn: _thinCylinderI(d.payloadContainerMass, r, capH || H * 0.1),
      });
    }
  }

  // ---- Fuel (variable mass, fills bottom portion of the tank) ----
  if (memberFuelMass > 0) {
    const maxFuel = memberMaxFuel(rec);
    const fillFrac = maxFuel > 0 ? Math.min(1, memberFuelMass / maxFuel) : 0;
    const fuelColumnH = fillFrac * bodyH;
    out.push({
      label: 'fuel',
      mass: memberFuelMass,
      comX: 0,
      comY: fuelColumnH / 2,     // column centroid from base
      iOwn: _thinCylinderI(memberFuelMass, r, fuelColumnH),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// combineComponents: aggregate a flat list of components into a single
// { totalMass, comX, comY, moi } using the general parallel-axis theorem:
//   I_total = Σ ( I_own_i + m_i * ((x_i - X)² + (y_i - Y)²) )
// ---------------------------------------------------------------------------
function combineComponents(components) {
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

  return { totalMass: M, comX, comY, moi: I };
}

// ---------------------------------------------------------------------------
// Stack-level: combine all members bottom→top, offsetting comY by each
// member's cumulative height. fuelMassTotal is the STACK's total fuel at
// this instant; it's distributed proportionally to each member's max tank
// capacity (so fuel burn affects all tanks in proportion — matches the
// "single combined body" abstraction, and avoids needing per-member fuel).
//
// legsProgress applies only to members[0] (the bottom member — the only one
// whose legs are driven by the sim's leg control in P4-C2b-1).
// ---------------------------------------------------------------------------
function stackMassProps(members, fuelMassTotal, legsProgress, payloadMass) {
  members = members || [];

  // Single pass instead of map+reduce+map — same numbers, fewer array
  // allocations/traversals (this runs every physics substep).
  const maxFuels = new Array(members.length);
  let sumMax = 0;
  for (let i = 0; i < members.length; i++) {
    const mf = memberMaxFuel(members[i], members[i + 1] || null);
    maxFuels[i] = mf;
    sumMax += mf;
  }
  const fuelTotal = fuelMassTotal || 0;

  const all = [];
  let yOffset = 0;
  let payloadSpaceComY = null;
  members.forEach((m, i) => {
    const progress = (i === 0) ? (legsProgress || 0) : 0;
    const memberFuel = sumMax > 0 ? fuelTotal * (maxFuels[i] / sumMax) : 0;
    const comps = memberComponents(m, memberFuel, progress, members[i + 1] || null);
    comps.forEach(c => {
      // comps are freshly built by memberComponents() every call and never
      // shared/cached elsewhere, so mutating in place (instead of spreading
      // into a new object) is safe and skips one allocation per component.
      c.comY += yOffset;
      all.push(c);
    });
    if (m && m.stageRole === 'payloadSpace' && Number.isFinite(m.height)) {
      payloadSpaceComY = yOffset + m.height / 2;
    }
    yOffset += Number.isFinite(m.height) ? m.height : 0;
  });

  // Real assigned cargo mass — the caller (physics.js's _bodyPayloadMass())
  // already resolves this to a plain number (0 once released / if this body
  // never carried one). Previously this function's signature had no slot
  // for it at all, so the value physics.js was already passing in got
  // silently dropped and telemetry's total mass never included cargo.
  const cargoMass = Number.isFinite(payloadMass) ? payloadMass : 0;
  if (cargoMass > 0) {
    const comY = payloadSpaceComY !== null ? payloadSpaceComY : yOffset;
    all.push({ label: 'payloadCargo', mass: cargoMass, comX: 0, comY, iOwn: 0 });
  }

  const combined = combineComponents(all);
  const dryMass = Math.max(0, combined.totalMass - (fuelMassTotal || 0));
  return {
    totalMass: combined.totalMass,
    dryMass,
    fuelMass: fuelMassTotal || 0,
    payloadMass: cargoMass,
    comX: combined.comX,
    comY: combined.comY,     // distance from stack base to COM
    moi: combined.moi,       // about stack COM
    stackHeight: yOffset,
    components: all,         // debugging aid
  };
}