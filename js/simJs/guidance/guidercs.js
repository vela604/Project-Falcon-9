// ============================================================================
// guidercs.js — RCS torque control. Given a target torque, produce a
// per-pod, per-nozzle duty table that (greedily) achieves it.
//
// Runs inside guidance.worker.js. Uses Derivation for comX/comY/F_max.
// Never talks to physics directly — returns a plain object the caller can
// wrap as `cmdRcsDuty(...)` and send.
// ============================================================================

const GuideRCS = (function () {
  
  // ============================================================
  // targetTorqueRcs(snapshot, targetTorque, [bodyIdx])
  //
  // Returns:
  //   {
  //     fires: [ {podId, nozzle, duty, torque, Fmax, thrust}, ... ],
  //     duties: { [podId]: {up, dn, lat} },   // ready for cmdRcsDuty
  //     targetTorque,                          // echoed back
  //     torqueAchieved,                        // sign follows target
  //     saturated,                             // true if we couldn't hit target
  //   }
  //
  // Algorithm:
  //   1. Derive current comX/comY via Derivation (slosh-shifted CoM included).
  //   2. For every pod, compute its 3 nozzle torques:
  //        τ = rx·Fy − ry·Fx
  //      with rx = offsetX − comX, ry = offsetY − comY.
  //      Fire directions (body frame):
  //        fire up  → exhaust up   → Fy = −Fmax
  //        fire dn  → exhaust down → Fy = +Fmax
  //        fire lat → exhaust out  → left pod: Fx = +Fmax, right: Fx = −Fmax
  //   3. Sign-align (multiply all τ by sign(targetTorque)) so
  //      "helping" fires are positive, then filter out negatives.
  //   4. Sort descending by aligned τ (this IS the correct sort — NOT by
  //      Fmax or offsetY, since slosh-induced comX shifts the ranking).
  //   5. Greedy fill: full-fire top entries until remaining < top τ, then
  //      duty-cycle the last one. If list exhausts before target reached,
  //      report saturated.
  //
  // Notes:
  //   - Pods fire at most one vertical (up XOR dn) + one lateral per tick,
  //     because up/dn torques are always opposite in sign for a given pod
  //     (rx≠0), so only one survives the filter.
  //   - targetTorque ≈ 0 → returns empty duties; caller should send
  //     cmdRcsDuty(null) to relinquish, not cmdRcsDuty({}).
  //   - Caller should re-invoke every tick while holding a nonzero target;
  //     ranking shifts with CoM and pod availability.
  // ============================================================
  function targetTorqueRcs(snapshot, targetTorque, bodyIdx, customCom) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
  if (!Number.isFinite(targetTorque)) return null;
  
  const idx = Number.isInteger(bodyIdx) ? bodyIdx : (snapshot.activeBodyIndex || 0);
  const body = snapshot.bodies[idx];
  if (!body) return null;
  
  const d = Derivation.derive(snapshot, idx);
  if (!d || !d.massProps) return null;
  // customCom override lets callers target a specific (e.g. predicted
  // next-tick) COM rather than the current-tick one. Falls back to the
  // current-tick COM if not provided.
  const comX = (customCom && Number.isFinite(customCom.comX)) ?
    customCom.comX : d.massProps.comX;
  const comY = (customCom && Number.isFinite(customCom.comY)) ?
    customCom.comY : d.massProps.comY;
    
    const pods = body.pods || [];
    const members = body.members || [];
    const fires = [];
    
    pods.forEach(pod => {
      const member = members[pod.memberIdx];
      if (!member) return;
      const rcsThruster = member.rcsThruster;
      if (!rcsThruster) return;
      const thrusterType = Derivation.getTypeById(rcsThruster.thrusterTypeId);
      if (!thrusterType) return;
      const ve = Derivation.typeParam(thrusterType, 've');
      const mdot = rcsThruster.massFlowRate;
      if (!Number.isFinite(ve) || !Number.isFinite(mdot)) return;
      const Fmax = mdot * ve;
      if (!(Fmax > 0)) return;
      
      const offsetX = pod.memberLocalX;
      const offsetY = pod.offsetFromStackBase;
      const rx = offsetX - comX;
      const ry = offsetY - comY;
      const latSign = pod.side === 'L' ? +1 : -1;
      
      // τ = rx · Fy − ry · Fx
//
// Physics convention (rcs.js):
//   duty.up → fireVerticalDuty(+1) → Fy = +Fmax  (force UP, toward nose)
//   duty.dn → fireVerticalDuty(−1) → Fy = −Fmax  (force DOWN)
//   duty.lat → fireLateralDuty     → Fx = latSign · Fmax
//
// So τ_up = rx · (+F), τ_dn = rx · (−F), τ_lat = −ry · latSign · F.
// (Previously tauUp/tauDn had inverted signs — selected "up" fires
// were producing opposite-direction torque in reality, which made
// vertical fires help the disturbance instead of cancelling it.)
const tauUp = rx * (+Fmax);
const tauDn = rx * (-Fmax);
const tauLat = -ry * (latSign * Fmax);
      
      fires.push({ podId: pod.podId, nozzle: 'up',  tau: tauUp,  Fmax });
      fires.push({ podId: pod.podId, nozzle: 'dn',  tau: tauDn,  Fmax });
      fires.push({ podId: pod.podId, nozzle: 'lat', tau: tauLat, Fmax });
    });
    
    if (fires.length === 0) {
      return {
        fires: [], duties: {}, targetTorque,
        torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9,
      };
    }
    
    const sign = targetTorque >= 0 ? 1 : -1;
    const aligned = fires
      .map(f => ({ ...f, alignedTau: sign * f.tau }))
      .filter(f => f.alignedTau > 1e-9)
      .sort((a, b) => b.alignedTau - a.alignedTau);
    
    let remaining = Math.abs(targetTorque);
    const fireList = [];
    const duties = {};
    const accum = (podId, nozzle, duty) => {
      if (!duties[podId]) duties[podId] = { up: 0, dn: 0, lat: 0 };
      duties[podId][nozzle] += duty;
    };
    
    for (const f of aligned) {
      if (remaining <= 1e-9) break;
      const duty = Math.min(1, remaining / f.alignedTau);
      const achieved = duty * f.alignedTau;
      remaining -= achieved;
      fireList.push({
        podId: f.podId,
        nozzle: f.nozzle,
        duty,
        torque: sign * achieved,
        Fmax: f.Fmax,
        thrust: duty * f.Fmax,
      });
      accum(f.podId, f.nozzle, duty);
    }
    
    // Clamp (shouldn't exceed 1 given the greedy walk, but safety).
    Object.keys(duties).forEach(podId => {
      ['up', 'dn', 'lat'].forEach(n => {
        if (duties[podId][n] > 1) duties[podId][n] = 1;
      });
    });
    
    const saturated = remaining > 1e-6;
    const torqueAchieved = sign * (Math.abs(targetTorque) - remaining);
    
    return {
      fires: fireList,
      duties,
      targetTorque,
      torqueAchieved,
      saturated,
    };
  }
  
  // ============================================================
// targetTorqueRcsNoNetForce — same 4-pod interface as targetTorqueRcs,
// but guarantees ZERO net linear force (Fnet_x = Fnet_y = 0) for
// every torque demand. Uses only two balanced patterns:
//
//   Vertical pair (4 fires, opposite Y forces):
//     TL.dn + TR.up + BL.dn + BR.up    (τ > 0)
//     TL.up + TR.dn + BL.up + BR.dn    (τ < 0)
//     Net Y-force = 0, τ = 4·xO·F·duty
//
//   Lateral pair (2 fires, opposite X forces):
//     TR.lat + BL.lat                  (τ > 0)
//     TL.lat + BR.lat                  (τ < 0)
//     Net X-force = 0, τ = (yTop − yBot)·F·duty
//
// Priority: laterals fire first (larger moment arm ~40 m vs ~2 m for
// verticals), so most demands are met with laterals alone. Only when
// |τ| > τ_L_max do verticals engage, and then laterals stay at 1.
//
// Cases:
//   |τ| ≥ τ_V_max + τ_L_max  →  saturate, both at 1
//   |τ| ≤ τ_L_max            →  verticals 0, laterals partial
//   otherwise                →  laterals 1, verticals partial
//
// Returns same shape as targetTorqueRcs so callers are interchangeable.
// Assumes one member (typically member 0) carries all 4 pods.
// ============================================================
function targetTorqueRcsNoNetForce(snapshot, targetTorque, bodyIdx, customCom) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
  if (!Number.isFinite(targetTorque)) return null;
  
  const idx = Number.isInteger(bodyIdx) ? bodyIdx : (snapshot.activeBodyIndex || 0);
  const body = snapshot.bodies[idx];
  if (!body) return null;
  
  const d = Derivation.derive(snapshot, idx);
  if (!d || !d.massProps) return null;
  const comX = (customCom && Number.isFinite(customCom.comX)) ? customCom.comX : d.massProps.comX;
  const comY = (customCom && Number.isFinite(customCom.comY)) ? customCom.comY : d.massProps.comY;
  
  const pods = body.pods || [];
  const members = body.members || [];
  if (pods.length < 4) {
    // Not a 4-pod arrangement — no zero-net-force pattern available.
    return { fires: [], duties: {}, targetTorque, torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9 };
  }
  
  // Sort each side's pods by memberLocalY descending (topmost first).
  const bySide = { L: [], R: [] };
  pods.forEach(p => {
    if (p.side === 'L' || p.side === 'R') bySide[p.side].push(p);
  });
  bySide.L.sort((a, b) => (b.memberLocalY || 0) - (a.memberLocalY || 0));
  bySide.R.sort((a, b) => (b.memberLocalY || 0) - (a.memberLocalY || 0));
  if (!bySide.L.length || !bySide.R.length) {
    return { fires: [], duties: {}, targetTorque, torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9 };
  }
  const topL = bySide.L[0];
  const botL = bySide.L[bySide.L.length - 1];
  const topR = bySide.R[0];
  const botR = bySide.R[bySide.R.length - 1];
  
  // Per-nozzle thrust from the shared rcsThruster on any of these pods.
  const refMember = members[topL.memberIdx];
  if (!refMember || !refMember.rcsThruster) {
    return { fires: [], duties: {}, targetTorque, torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9 };
  }
  const refType = Derivation.getTypeById(refMember.rcsThruster.thrusterTypeId);
  if (!refType) {
    return { fires: [], duties: {}, targetTorque, torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9 };
  }
  const ve = Derivation.typeParam(refType, 've');
  const mdot = refMember.rcsThruster.massFlowRate;
  if (!Number.isFinite(ve) || !Number.isFinite(mdot)) {
    return { fires: [], duties: {}, targetTorque, torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9 };
  }
  const F = mdot * ve;
  if (!(F > 0)) {
    return { fires: [], duties: {}, targetTorque, torqueAchieved: 0, saturated: Math.abs(targetTorque) > 1e-9 };
  }
  
  // Moment arms.
  const xO = Math.abs(topL.memberLocalX || 0); // pod lateral offset
  const yTop = topL.offsetFromStackBase || 0;
  const yBot = botL.offsetFromStackBase || 0;
  const tauV_max = 4 * xO * F;                   // all 4 verticals, duty 1
  const tauL_max = Math.max(0, (yTop - yBot) * F); // both laterals, duty 1
  const tauAll_max = tauV_max + tauL_max;
  
  const absTau = Math.abs(targetTorque);
  const sign = targetTorque >= 0 ? 1 : -1;
  
  // Priority: laterals first.
  let dV = 0, dL = 0;
  if (absTau >= tauAll_max) {
    dV = 1; dL = 1;
  } else if (absTau <= tauL_max) {
    dV = 0;
    dL = tauL_max > 0 ? absTau / tauL_max : 0;
  } else {
    dL = 1;
    dV = tauV_max > 0 ? (absTau - tauL_max) / tauV_max : 0;
  }
  
  const duties = {};
  const fires = [];
  const addFire = (pod, nozzle, duty, tauMag) => {
    if (!pod || duty <= 1e-9) return;
    if (!duties[pod.podId]) duties[pod.podId] = { up: 0, dn: 0, lat: 0 };
    duties[pod.podId][nozzle] += duty;
    fires.push({
      podId: pod.podId, nozzle, duty,
      torque: sign * tauMag,
      Fmax: F, thrust: duty * F,
    });
  };
  
  if (sign > 0) {
    // Verticals: TL.dn, TR.up, BL.dn, BR.up
    if (dV > 0) {
      addFire(topL, 'dn', dV, (xO + comX) * F);
      addFire(topR, 'up', dV, (xO - comX) * F);
      addFire(botL, 'dn', dV, (xO + comX) * F);
      addFire(botR, 'up', dV, (xO - comX) * F);
    }
    // Laterals: TR.lat, BL.lat
    if (dL > 0) {
      addFire(topR, 'lat', dL, (yTop - comY) * F);
      addFire(botL, 'lat', dL, (comY - yBot) * F);
    }
  } else {
    // Verticals: TL.up, TR.dn, BL.up, BR.dn
    if (dV > 0) {
      addFire(topL, 'up', dV, (xO + comX) * F);
      addFire(topR, 'dn', dV, (xO - comX) * F);
      addFire(botL, 'up', dV, (xO + comX) * F);
      addFire(botR, 'dn', dV, (xO - comX) * F);
    }
    // Laterals: TL.lat, BR.lat
    if (dL > 0) {
      addFire(topL, 'lat', dL, (yTop - comY) * F);
      addFire(botR, 'lat', dL, (comY - yBot) * F);
    }
  }
  
  // Clamp duties (greedy walk should already keep them ≤ 1, safety net).
  Object.keys(duties).forEach(podId => {
    ['up', 'dn', 'lat'].forEach(n => {
      if (duties[podId][n] > 1) duties[podId][n] = 1;
    });
  });
  
  const torqueAchieved = sign * (dV * tauV_max + dL * tauL_max);
  const saturated = absTau > tauAll_max;
  
  return { fires, duties, targetTorque, torqueAchieved, saturated };
}
  
  
  // ============================================================
// Separation-phase duties — Stage (A.0) mission support.
//
// Pod-id layout (see buildPodEntries in rcs.js): `b<memberIdx>.<side><n>`
// — e.g. `b0.L1` is member 0, left side, topmost pod. Each pod's duty
// table has { up, dn, lat } in 0..1. From rcs.js:
//   duty.up  → Fy = +Fmax  (force toward body nose)
//   duty.dn  → Fy = −Fmax  (force toward body tail)
//   duty.lat → Fx = lateralSign × Fmax (L pods → +X, R pods → −X)
//
// Only one nozzle per axis fires per pod per tick; caller is
// responsible for not overlapping axial and lateral phases.
// ============================================================

// Pre-separation axial duty — one body still, about to be split into
// two at member index `boundaryIdx`. Lower members [0, boundaryIdx)
// become the discarded booster; upper members [boundaryIdx, end) are
// the retained stack. Fires ONLY the lower group's `dn` nozzles —
// pushes the future booster downward (away from the future stage),
// so the moment of physical split finds them already moving apart.
//
// Returns a duty table for the parent body's pods, or null if the
// body has no pods / no matching members.
function preSeparationDuty(snapshot, parentIdx, boundaryIdx) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
  const body = snapshot.bodies[parentIdx];
  if (!body || !Array.isArray(body.pods)) return null;
  const duties = {};
  body.pods.forEach(pod => {
    if (pod.memberIdx < boundaryIdx) {
      // Lower group — future booster: force tailward (away from stage).
      duties[pod.podId] = { up: 0, dn: 1, lat: 0 };
    } else {
      // Upper group — future stage: force noseward (away from booster).
      duties[pod.podId] = { up: 1, dn: 0, lat: 0 };
    }
  });
  return Object.keys(duties).length ? duties : null;
}

// Post-separation axial duty — a single body (typically the discarded
// booster) fires ALL pods in a fixed direction. `direction` is
// 'dn' (body-tailward) or 'up' (body-noseward).
function postSeparationAxialDuty(snapshot, bodyIdx, direction) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
  const body = snapshot.bodies[bodyIdx];
  if (!body || !Array.isArray(body.pods)) return null;
  if (direction !== 'dn' && direction !== 'up') return null;
  const duties = {};
  body.pods.forEach(pod => {
    duties[pod.podId] = direction === 'dn' ?
      { up: 0, dn: 1, lat: 0 } :
      { up: 1, dn: 0, lat: 0 };
  });
  return Object.keys(duties).length ? duties : null;
}

// Post-separation lateral duty — fires ONLY the pods on one side's
// lateral nozzles. `side` is 'L' or 'R'. Per rcs.js:
//   side 'L' → Fx = +Fmax (force toward body +X)
//   side 'R' → Fx = −Fmax (force toward body −X)
function postSeparationLateralDuty(snapshot, bodyIdx, side) {
  if (!snapshot || !Array.isArray(snapshot.bodies)) return null;
  const body = snapshot.bodies[bodyIdx];
  if (!body || !Array.isArray(body.pods)) return null;
  if (side !== 'L' && side !== 'R') return null;
  const duties = {};
  body.pods.forEach(pod => {
    if (pod.side === side) duties[pod.podId] = { up: 0, dn: 0, lat: 1 };
  });
  return Object.keys(duties).length ? duties : null;
}
  
  
  return {
  targetTorqueRcs,
  targetTorqueRcsNoNetForce,
  preSeparationDuty,
  postSeparationAxialDuty,
  postSeparationLateralDuty,
};
})();