// ============================================================================
// rcs.js — 4-pod "advanced" RCS system.
//
// Pods: TL (top-left), TR (top-right), BL (bottom-left), BR (bottom-right).
// Each pod has THREE physical nozzles: an "up" nozzle and a "down" nozzle
// (both along the vertical/hull axis), and a single LATERAL nozzle whose
// exhaust direction is FIXED by mounting side — it always ejects further
// outward, away from the centerline (TL/BL eject further left -> reaction
// pushes the vehicle RIGHT; TR/BR eject further right -> reaction pushes the
// vehicle LEFT). At most 2 of a pod's 3 nozzles fire at once (one vertical +
// the lateral).
//
// DESIGN NOTES (derived and verified analytically — see conversation):
//
// 1) Pure vertical translation (Up/Down): ALL FOUR pods fire the relevant
//    vertical nozzle together (max available thrust, no lateral involved).
//    Because the two pairs are symmetric about x=0, torque cancels exactly
//    regardless of CoM height. No PWM needed.
//
// 2) Pure horizontal translation (Left/Right): only pods on the side whose
//    FIXED lateral nozzle produces the desired push can contribute (pushing
//    RIGHT needs the LEFT-mounted pods TL/BL; pushing LEFT needs the
//    RIGHT-mounted pods TR/BR). Those two pods are at different heights, and
//    the CoM normally sits below the geometric mid-height, so the TOP pod
//    has a LARGER moment arm than the BOTTOM pod. Firing both at equal force
//    would create unwanted torque. Fix: the bottom pod (smaller arm) fires
//    continuously at full force; the top pod (larger arm) fires at a
//    reduced AVERAGE force via PWM duty cycling, duty = d_bottom / d_top, so
//    F_top_avg * d_top == F_bottom * d_bottom -> zero net torque.
//
// 3) Diagonal translation (NE/NW/SE/SW): built from a vertical group (the 2
//    pods on the SAME vertical side as the target, e.g. both top pods for an
//    "up" component) and a lateral group (the 2 pods whose FIXED lateral
//    direction matches the target, e.g. the two LEFT-mounted pods for a
//    "right" push). Exactly one pod is in both groups and fires both of its
//    nozzles; one pod fires vertical only; one fires lateral only; the 4th
//    is idle. The lateral group still follows the same top-PWM/bottom-
//    continuous rule as rule (2) above (whichever of the two lateral-firing
//    pods happens to be a TOP pod gets duty-cycled).
//
// 4) Pure rotation (CW/ACW): rotation needs each pod's lateral push to point
//    tangentially to the spin. Because the lateral nozzle direction is FIXED
//    by mounting side, only TWO of the four pods can ever supply a lateral
//    push in the tangentially-correct direction for a given spin sense —
//    the other two pods can only help with their vertical nozzle. For CW:
//    TL and BR are the pods whose fixed lateral direction lines up with the
//    CW tangent, so they fire BOTH nozzles (diagonal); TR and BL can only
//    contribute their vertical nozzle. For ACW it's the mirror: TR and BL
//    fire both nozzles, TL and BR contribute vertical only. This was
//    verified analytically to cancel net force EXACTLY regardless of the
//    top/bottom moment-arm asymmetry, so no PWM correction is needed here.
// ============================================================================

const rcsCmd = {
  N: false, S: false, E: false, W: false,
  NE: false, NW: false, SE: false, SW: false,
  CW: false, ACW: false,
};

const pwmClock = { t: 0 };

function rcsGeometry(comH) {
  const yTop = CONFIG.ROCKET_HEIGHT - CONFIG.RCS_TOP_MARGIN;
  const yBottom = CONFIG.RCS_BOTTOM_MARGIN;
  return {
    yTop, yBottom,
    dTop: Math.max(0.01, yTop - comH),       // moment arm, top pods (usually larger)
    dBottom: Math.max(0.01, comH - yBottom), // moment arm, bottom pods (usually smaller)
  };
}

// Computes this tick's RCS force/torque/mass-flow from the current rcsCmd state.
// `pod[k]` in the returned object carries the ACTUAL signed (Fx, Fy) applied
// this tick (post-PWM-gating) so render.js can draw the correct nozzle(s).
function computeRCS(comH, dt) {
  const f = CONFIG.RCS_THRUST;
  const geo = rcsGeometry(comH);

  // Shared PWM clock for whichever lateral nozzle is on a TOP pod this tick.
  pwmClock.t += dt;
  if (pwmClock.t >= CONFIG.RCS_PWM_PERIOD) pwmClock.t -= CONFIG.RCS_PWM_PERIOD;
  const duty = Math.min(1, geo.dBottom / geo.dTop);
  const topLateralOn = pwmClock.t < duty * CONFIG.RCS_PWM_PERIOD;

  const pod = { TL: { Fx: 0, Fy: 0 }, TR: { Fx: 0, Fy: 0 }, BL: { Fx: 0, Fy: 0 }, BR: { Fx: 0, Fy: 0 } };
  const isTop = { TL: true, TR: true, BL: false, BR: false };
  const lateralSign = { TL: +1, BL: +1, TR: -1, BR: -1 }; // fixed by mounting side (inward-force convention)

  // Fire a pod's lateral nozzle at full force, but if that pod is a TOP pod,
  // gate it through the shared PWM duty cycle (see rule 2/3 above). Used for
  // pure/diagonal horizontal translation, where the two lateral-firing pods
  // are at DIFFERENT heights and need this correction.
  function fireLateral(k) {
    const on = isTop[k] ? topLateralOn : true;
    pod[k].Fx += on ? lateralSign[k] * f : 0;
  }
  // Rotation uses its own always-continuous lateral fire: the two pods
  // selected for a given spin sense (TL+BR for CW, TR+BL for ACW) already
  // cancel net force exactly regardless of top/bottom moment-arm asymmetry
  // (verified analytically), so gating one of them through PWM would BREAK
  // that cancellation rather than fix it — do not reuse fireLateral() here.
  function fireLateralFull(k) {
    pod[k].Fx += lateralSign[k] * f;
  }
  function fireVertical(k, sign) { // sign: +1 = upward force, -1 = downward force
    pod[k].Fy += sign * f;
  }

  // ---- Pure vertical (all 4 pods; symmetric, torque-free, no PWM) ----
  const pureN = rcsCmd.N, pureS = rcsCmd.S;
  if (pureN) ['TL', 'TR', 'BL', 'BR'].forEach(k => fireVertical(k, +1));
  if (pureS) ['TL', 'TR', 'BL', 'BR'].forEach(k => fireVertical(k, -1));

  // ---- Pure / diagonal horizontal (lateral group only) ----
  const wantRight = rcsCmd.E || rcsCmd.NE || rcsCmd.SE;
  const wantLeft = rcsCmd.W || rcsCmd.NW || rcsCmd.SW;
  if (wantRight) ['TL', 'BL'].forEach(fireLateral); // left-mounted pods push right
  if (wantLeft) ['TR', 'BR'].forEach(fireLateral);  // right-mounted pods push left

  // ---- Diagonal vertical component (only the 2 same-side pods, not all 4) ----
  if (rcsCmd.NE || rcsCmd.NW) ['TL', 'TR'].forEach(k => fireVertical(k, +1));
  if (rcsCmd.SE || rcsCmd.SW) ['BL', 'BR'].forEach(k => fireVertical(k, -1));

  // ---- Rotation: only the two pods whose fixed lateral direction matches
  // the tangential need can do both nozzles; the other two help vertically.
  if (rcsCmd.CW) {
    fireLateralFull('TL'); fireVertical('TL', +1);
    fireLateralFull('BR'); fireVertical('BR', -1);
    fireVertical('TR', -1);
    fireVertical('BL', +1);
  }
  if (rcsCmd.ACW) {
    fireLateralFull('TR'); fireVertical('TR', +1);
    fireLateralFull('BL'); fireVertical('BL', -1);
    fireVertical('TL', -1);
    fireVertical('BR', +1);
  }

  const positions = {
    TL: { x: -CONFIG.RCS_X_OFFSET, y: geo.yTop },
    TR: { x: CONFIG.RCS_X_OFFSET, y: geo.yTop },
    BL: { x: -CONFIG.RCS_X_OFFSET, y: geo.yBottom },
    BR: { x: CONFIG.RCS_X_OFFSET, y: geo.yBottom },
  };

  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  const firing = { TL: false, TR: false, BL: false, BR: false };
  Object.keys(pod).forEach(k => {
    const p = pod[k], pos = positions[k];
    Fx += p.Fx; Fy += p.Fy;
    const rx = pos.x, ry = pos.y - comH;
    torque += rx * p.Fy - ry * p.Fx;
    const mag = Math.hypot(p.Fx, p.Fy);
    if (mag > 0.01) { mdot += mag / CONFIG.RCS_VE; firing[k] = true; }
  });

  return { Fx, Fy, torque, mdot, firing, pod, dutyTop: duty, topLateralOn };
}

function clearRCS() {
  Object.keys(rcsCmd).forEach(k => rcsCmd[k] = false);
}

