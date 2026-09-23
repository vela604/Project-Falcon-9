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
// Phase 2B.1 — bottom-tank fill geometry (radius, current fill height,
// fill fraction), used by physics.js's slosh natural-frequency derivation.
// Deliberately reproduces the SAME R / fillFrac / column-height math the
// fuel branch of memberComponents() uses below, from the SAME inputs
// (rec.fuel.tankHeight, memberMaxFuel, the member's proportional fuel
// share) — so the frequency model and the CoM-shift model can never see
// two different fill levels for the same tank.
//
// Returns null when there's nothing meaningful to slosh: no bottom member,
// a nose/payloadSpace bottom (shouldn't happen — bodyHasBottomFuelTank()
// already filters these — but defensive), zero tank radius, zero tank
// height, or zero tank capacity (maxFuel divide-by-zero guard). Callers
// fall back to the CONFIG constant in that case.
// ---------------------------------------------------------------------------
function bottomTankFillGeometry(body) {
  if (!body || !body.members || !body.members.length) return null;
  const rec = body.members[0];
  const role = rec.stageRole || 'rocket';
  if (role === 'nose' || role === 'payloadSpace') return null;
  
  // Tank radius: use the actual tank width (fuel.tankWidth) when present
  // — the same source boosterDerivedMasses/stageDerivedMasses in fleet.js
  // already use — falling back to the outer mold line (rec.width) only
  // for legacy/malformed records with no fuel block. A slim tank inside
  // a wider shroud must slosh at the tank's own radius, not the shroud's.
  const tankW = (rec.fuel && Number.isFinite(rec.fuel.tankWidth)) ?
    rec.fuel.tankWidth : (Number.isFinite(rec.width) ? rec.width : 0);
  const R = tankW / 2;
  if (!(R > 0)) return null;
  
  let bodyH = Number.isFinite(rec.height) ? rec.height : 0;
  if (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) bodyH = rec.fuel.tankHeight;
  if (!(bodyH > 0)) return null;
  
  const maxFuel = memberMaxFuel(rec, body.members[1] || null);
  if (!(maxFuel > 0)) return null;
  
  // Reproduce stackMassProps' proportional-by-capacity fuel split for
  // just this (bottom) member, from the body's current total fuelMass.
  let sumMax = 0;
  for (let i = 0; i < body.members.length; i++) {
    sumMax += memberMaxFuel(body.members[i], body.members[i + 1] || null);
  }
  const memberFuel = sumMax > 0 ? (body.fuelMass || 0) * (maxFuel / sumMax) : 0;
  const fillFrac = Math.min(1, Math.max(0, memberFuel / maxFuel));
  const h = fillFrac * bodyH;
  
  return { R, h, fillFrac, bodyH };
}

// ---------------------------------------------------------------------------
// Phase 2B.2 — slosh mass fraction from fill ratio h/R. Abramson / NASA
// SP-106, first antisymmetric mode:
//
//   m1 / mL = tanh(λ1 · h/R) / (λ1 · h/R)
//
// Shallow fill (h/R → 0): fraction → 1 — a shallow liquid column moves
// almost entirely with the surface wave.
// Deep fill (h/R large): fraction → 0 — only a thin layer near the free
// surface participates in the first mode; the bulk liquid below is
// effectively decoupled from it.
//
// Replaces 2A's fixed CONFIG.SLOSH_MASS_FRACTION (0.27), which stays as
// the fallback for degenerate inputs (h/R ≤ 0 or non-finite — e.g. an
// empty tank, or a member with no resolvable radius).
// ---------------------------------------------------------------------------
function sloshMassFraction(hOverR) {
  const fallback = (typeof CONFIG !== 'undefined' && Number.isFinite(CONFIG.SLOSH_MASS_FRACTION)) ?
    CONFIG.SLOSH_MASS_FRACTION : 0.27;
  if (!Number.isFinite(hOverR) || hOverR <= 0) return fallback;
  
  const lambda1 = (typeof CONFIG !== 'undefined' && Number.isFinite(CONFIG.SLOSH_LAMBDA1)) ?
    CONFIG.SLOSH_LAMBDA1 : 1.841;
  const x = lambda1 * hOverR;
  // tanh(x)/x → 1 as x → 0; guard the division directly rather than lean
  // on tanh(x) ≈ x cancelling cleanly in floating point at tiny x.
  const frac = (x < 1e-6) ? 1 : Math.tanh(x) / x;
  // Mathematically bounded to (0, 1] already — clamp only guards against
  // a NaN/Infinity slipping through from a garbage hOverR upstream.
  return Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : fallback;
}

// ---------------------------------------------------------------------------
// Phase 2B.3 — mode-1 slosh mass centroid height, as a FRACTION of the
// current fill height h (0.5 .. 1.0), measured from the tank base same as
// everything else here. Abramson / NASA SP-106 closed form:
//
//   h1/h = 1 - [cosh(λ1·h/R) - 1] / [λ1·(h/R)·sinh(λ1·h/R)]
//
// Deep fill (h/R large): bracket term → 0, so h1/h → 1 — the sloshing
// mode is a free-surface wave, so nearly all of the moving mass sits right
// at the free surface (near the TOP of the column, not its bulk h/2
// centroid). This is the standard deep-tank slosh result (same reasoning
// as ocean surface waves: motion decays with depth below the surface).
// Shallow fill (h/R → 0): bracket term → 1/2, so h1/h → 1/2 — a thin
// liquid layer moves together, and its effective centroid falls back
// toward the column's own bulk mid-height.
//
// Only ever applied to the small slosh-mass fraction (see
// sloshMassFraction() above) in memberComponents()'s fuel branch below —
// the much larger BULK fuel mass stays at the plain column centroid h/2,
// exactly as before this step.
// ---------------------------------------------------------------------------
function sloshMassCentroidFrac(hOverR) {
  if (!Number.isFinite(hOverR) || hOverR <= 0) return 0.5;
  const lambda1 = (typeof CONFIG !== 'undefined' && Number.isFinite(CONFIG.SLOSH_LAMBDA1)) ?
    CONFIG.SLOSH_LAMBDA1 : 1.841;
  const x = lambda1 * hOverR;
  // Series limit (→ 1/2) rather than evaluating cosh(x)-1 directly at tiny
  // x, where it loses precision to floating-point cancellation (cosh(x)
  // rounds to exactly 1.0 for x below ~1e-8 in double precision).
  if (x < 1e-3) return 0.5;
  // cosh/sinh don't overflow until x ≈ 709, and the bracket term is
  // already negligible (≈1/x) well before then — 1/x < 1e-6 by x ≈ 1e6,
  // but a generous, cheap cutoff avoids computing huge cosh/sinh values
  // for no visible change in the result.
  if (x > 30) return 1;
  const frac = 1 - (Math.cosh(x) - 1) / (x * Math.sinh(x));
  // Bounded to [0.5, 1] by construction — clamp only guards a stray
  // NaN/Infinity from slipping through from a garbage hOverR upstream.
  return Number.isFinite(frac) ? Math.min(1, Math.max(0.5, frac)) : 0.5;
}

// ---------------------------------------------------------------------------
// Per-member component decomposition. Returns an array of
//   { label, mass, comX, comY, iOwn }
// in the member's LOCAL frame (base = 0, +Y up).
//
// legsProgress is applied ONLY to the bottom member (see stackMassProps) —
// upper members' legs are cosmetically stowed.
// ---------------------------------------------------------------------------
function memberComponents(rec, memberFuelMass, legsProgress, aboveMember, sloshOffset, frozenInterstage) {
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
      comY: H / 4, // true solid-cone centroid: 1/4 of height up from the base
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
      comY: H / 2, // simple placeholder, same convention as nose
      iOwn: _thinCylinderI(mass, r, H),
    });
    return out;
  }
  
  // ---- Body (cylindrical shell/tank) ----
  let bodyMass = 0,
    bodyH = H;
  if (role === 'booster') {
  const d = boosterDerivedMasses(rec, aboveMember, frozenInterstage);
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
        comY: bodyH - interH / 2, // sits at the very top of the body
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
    comY: bodyH / 2, // cylinder centroid at mid-height
    iOwn: _thinCylinderI(bodyMass, r, bodyH),
  });
  
  // ---- Engines (per-engine positions aggregated, so future asymmetric
  // layouts just work) ----
  if (typeof getComponentType === 'function') {
    const engineType = getComponentType(rec.engineTypeId);
    if (engineType && engineType.frame && Array.isArray(engineType.frame.slots)) {
      const groups = (typeof engineThrusterGroups === 'function') ?
        engineThrusterGroups(engineType) : {};
      const R = (rec.params && Number.isFinite(rec.params.octaRadius)) ?
        rec.params.octaRadius :
        CONFIG.OCTA_RADIUS; // fallback
      
      let totalM = 0,
        sumX = 0,
        sumY = 0;
      Object.keys(groups).forEach(gk => {
        const g = rec.engineThrusters && rec.engineThrusters[gk];
        if (!g) return;
        const t = getComponentType(g.thrusterTypeId);
        if (!t) return;
        const veEntry = t.parameterSchema.find(p => p.key === 've');
        if (!veEntry || !Number.isFinite(g.massFlowRate)) return;
        const thrustPer = g.massFlowRate * veEntry.value;
        const massPer = (typeof engineMassFromThrust === 'function') ?
          engineMassFromThrust(t, thrustPer) : NaN;
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
          iOwn: 0, // small objects; own MOI negligible for now
        });
      }
    }
  }
  
  // ---- Landing legs (LIVE: recomputed from legsProgress every call) ----
  if (rec.hasRecovery !== false && typeof getComponentType === 'function') {
    const recoveryType = getComponentType(rec.recoveryTypeId);
    const canDeploy = recoveryType &&
      recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle &&
      recoveryType.frame && typeof recoveryType.frame.hingeGeometry === 'function' &&
      typeof recoveryType.frame.structuralVolume === 'function';
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
      const sideXBack = W * 0.375;
      
      // Legs use their OWN metal now (rec.legsMetalTypeId) — real F9
// legs are carbon-fibre composite over aluminium honeycomb, not
// the al-li airframe. Fall back to body metal if legsMetalTypeId
// isn't set (legacy record), preserving pre-fix behavior exactly.
const legsMetal = getComponentType(rec.legsMetalTypeId) ||
  getComponentType(rec.bodyMetalTypeId);
const legDensity = (legsMetal && legsMetal.parameterSchema.find(p => p.key === 'density')) ?
  legsMetal.parameterSchema.find(p => p.key === 'density').value : 1;
const oneLegMass = recoveryType.frame.structuralVolume(H, W) * legDensity;
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
      const capH = (rec.payloadSpace && rec.payloadSpace.params && Number.isFinite(rec.payloadSpace.params.capHeight)) ?
        rec.payloadSpace.params.capHeight : 0;
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
    // Tank radius for the fuel column itself: fuel.tankWidth when
    // present (same source fleet.js's boosterDerivedMasses/
    // stageDerivedMasses already use), falling back to the outer mold
    // line (the shared `r` above) only for legacy/malformed records
    // with no fuel block. Scoped locally — the body shell, nose, legs,
    // engine, and payload-space branches above genuinely want the mold
    // line `r` and must not be affected by this.
    const tankR = (rec.fuel && Number.isFinite(rec.fuel.tankWidth)) ?
      rec.fuel.tankWidth / 2 : r;

    // Phase 2A / 2B.2 — sloshOffset is only ever passed for the BOTTOM
    // member (see stackMassProps); every other member gets undefined
    // here, matching "only the bottom tank matters" in prompt_2phase.md
    // §2A. Gated on CONFIG.SLOSH_ENABLED too (not just the instantaneous
    // offset) so this collapses back to the original single lumped-at-h/2
    // component whenever slosh is off — "slosh disabled → bit-identical
    // to pre-Phase-2 baseline" (2A.6) still holds exactly.
    const isBottomSloshMember = Number.isFinite(sloshOffset) &&
      (typeof CONFIG === 'undefined' || CONFIG.SLOSH_ENABLED);
    const hOverR = tankR > 0 ? fuelColumnH / tankR : 0;
    const sloshFrac = isBottomSloshMember ? sloshMassFraction(hOverR) : 0;

    // Phase 2B.3 — split the fuel into a BULK sub-mass (plain column
    // centroid h/2, never shifts laterally) and a SLOSH sub-mass (the
    // sloshMassFraction() share of memberFuelMass, sitting at the mode-1
    // liquid centroid height from sloshMassCentroidFrac() — near the free
    // surface for a deep tank, sinking toward the column mid-height for a
    // shallow one — and the ONLY part that ever shifts laterally, by the
    // full sloshOffset). 2A/2B.2 instead lumped 100% of the fuel mass at
    // h/2 and shifted the WHOLE thing sideways by sloshMassFraction() ×
    // offset — same net first moment (mass × fraction × offset either
    // way), but with no distinct location for the part that's actually
    // doing the sloshing. Splitting keeps the vertical CoM/MOI honest:
    // only a slice of the propellant participates in the sloshing mode,
    // so only that slice sits at the sloshing mode's own centroid height,
    // and it moves by its own real displacement (the oscillator's
    // sloshOffset state), not a fraction of it.
    if (sloshFrac > 1e-6 && sloshFrac < 1) {
      const sloshMass = memberFuelMass * sloshFrac;
      const bulkMass = memberFuelMass - sloshMass;
      const sloshComY = sloshMassCentroidFrac(hOverR) * fuelColumnH;

      out.push({
        label: 'fuel-bulk',
        mass: bulkMass,
        comX: 0,
        comY: fuelColumnH / 2, // column centroid from base
        iOwn: _thinCylinderI(bulkMass, tankR, fuelColumnH),
      });
      out.push({
        label: 'fuel-slosh',
        mass: sloshMass,
        comX: sloshOffset,
        comY: sloshComY,
        // Own-axis inertia is secondary here — the parallel-axis term
        // from sitting off the member's combined comX/comY dominates for
        // a small mass fraction. Reuses the full column height as the
        // characteristic dimension rather than fabricating a separate
        // "slosh layer thickness", same placeholder-precision approach
        // the rest of this file uses (see structuralVolume comments in
        // componentLibrary.js).
        iOwn: _thinCylinderI(sloshMass, tankR, fuelColumnH),
      });
    } else {
      out.push({
        label: 'fuel',
        mass: memberFuelMass,
        comX: 0,
        comY: fuelColumnH / 2, // column centroid from base
        iOwn: _thinCylinderI(memberFuelMass, tankR, fuelColumnH),
      });
    }
  }
  
  return out;
}

// ---------------------------------------------------------------------------
// combineComponents: aggregate a flat list of components into a single
// { totalMass, comX, comY, moi } using the general parallel-axis theorem:
//   I_total = Σ ( I_own_i + m_i * ((x_i - X)² + (y_i - Y)²) )
// ---------------------------------------------------------------------------
function combineComponents(components) {
  let M = 0,
    sumX = 0,
    sumY = 0;
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
// memberFuels (optional): array parallel to `members[]`, each entry the
// CURRENT fuel mass in that member's tank (kg). When provided, tank
// levels come from here instead of a proportional-by-capacity split of
// fuelMassTotal. Caller passes this after the per-member fuel refactor
// so each tank drains independently — engines burn their own tank only.
function stackMassProps(members, fuelMassTotal, legsProgress, payloadMass, sloshOffset, memberFuels) {
  members = members || [];
  const usePerMember = Array.isArray(memberFuels) && memberFuels.length === members.length;
  
  // Look up the active stack's frozen derived values so booster interstage
  // mass/height don't drift when the stack detaches during flight. The
  // physics worker has getActiveStack() (from fleet.js) available.
  const _stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  const frozenInterstageMap = (_stk && _stk.derived && _stk.derived.interstage) ?
    _stk.derived.interstage : {};
  
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
      const memberFuel = usePerMember ?
        Math.max(0, memberFuels[i] || 0) :
        (sumMax > 0 ? fuelTotal * (maxFuels[i] / sumMax) : 0);
        // Only boosters have a stack-derived interstage; other member types
        // ignore this field (memberComponents only reads it on the booster path).
        const frozenInterstage = frozenInterstageMap[m.id] || null;
        // Phase 2A: only the BOTTOM member (i === 0) ever gets a nonzero slosh
        // offset passed through — see prompt_2phase.md §2A "only the bottom
        // tank matters".
        const comps = memberComponents(m, memberFuel, progress, members[i + 1] || null, i === 0 ? sloshOffset : undefined, frozenInterstage);    comps.forEach(c => {
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
    comY: combined.comY, // distance from stack base to COM
    moi: combined.moi, // about stack COM
    stackHeight: yOffset,
    components: all, // debugging aid
  };
}