// ============================================================================
// rcs.js — 4-pod "advanced" RCS system.
//
// Pods: TL (top-left), TR (top-right), BL (bottom-left), BR (bottom-right).
// Each pod carries independent nozzles and can contribute a horizontal (±X)
// and/or vertical (±Y) thrust component simultaneously (diagonal firing).
//
// DESIGN NOTES (derived and verified analytically — see conversation):
//
// 1) Pure vertical translation (Up/Down): the two pods on the SAME side
//    (both top, or both bottom) fire together at equal, continuous force.
//    Because both pods sit at the same height, their moment arms about the
//    CoM are equal but opposite in sign (±x), so torque cancels exactly
//    regardless of where the CoM currently is. No PWM needed.
//
// 2) Pure horizontal translation (Left/Right): the two pods on the SAME side
//    (both left, or both right) fire together — and that side is chosen by
//    real RCS convention: pushing RIGHT fires the LEFT-side pods (their
//    nozzles eject further left/outward, reaction pushes the vehicle right);
//    pushing LEFT fires the RIGHT-side pods (mirror case). Those two pods
//    are NOT at the same height, though. The CoM is normally well below the
//    geometric mid-height (fuel is concentrated low), so the TOP pod has a
//    LARGER moment arm than the BOTTOM pod. Firing both at equal force would
//    create unwanted torque. Fix: the bottom pod (smaller arm) fires
//    continuously at full force; the top pod (larger arm) fires at a
//    reduced AVERAGE force via PWM duty cycling, with duty = d_bottom /
//    d_top, so that F_top_avg * d_top == F_bottom * d_bottom -> zero net
//    torque.
//
// 3) Diagonal translation (NE/NW/SE/SW): superposition of the relevant
//    vertical + horizontal commands above. One pod ends up firing both of
//    its nozzles simultaneously; the other two each fire one nozzle.
//
// 4) Pure rotation (CW/ACW): all 4 pods fire BOTH nozzles simultaneously in
//    a "windmill" pattern (each pod pushes tangentially to the rotation).
//    This configuration was verified to cancel net force EXACTLY regardless
//    of the top/bottom moment-arm asymmetry (the ± sign pattern alone
//    guarantees cancellation), so no PWM correction is required for
//    rotation commands — only for the pure horizontal-translation case above.
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
function computeRCS(comH, dt) {
  const f = CONFIG.RCS_THRUST;
  const geo = rcsGeometry(comH);

  // PWM duty cycle for the top pods' HORIZONTAL nozzle only (see note #2 above).
  pwmClock.t += dt;
  if (pwmClock.t >= CONFIG.RCS_PWM_PERIOD) pwmClock.t -= CONFIG.RCS_PWM_PERIOD;
  const duty = Math.min(1, geo.dBottom / geo.dTop);
  const topHorizOn = pwmClock.t < duty * CONFIG.RCS_PWM_PERIOD;

  const pod = { TL: { Fx: 0, Fy: 0 }, TR: { Fx: 0, Fy: 0 }, BL: { Fx: 0, Fy: 0 }, BR: { Fx: 0, Fy: 0 } };
  let firing = { TL: false, TR: false, BL: false, BR: false };

  function fireVert(dir) {
    if (dir === 'N') { pod.TL.Fy += f; pod.TR.Fy += f; firing.TL = firing.TR = true; }
    else              { pod.BL.Fy -= f; pod.BR.Fy -= f; firing.BL = firing.BR = true; }
  }
  function fireHoriz(dir) {
    const topF = topHorizOn ? f : 0;
    // Real RCS convention: pushing the vehicle RIGHT means the LEFT-side pods
    // fire (their nozzles eject further left/outward, away from the hull —
    // reaction pushes the vehicle right). Pushing LEFT is the mirror case:
    // the RIGHT-side pods fire, ejecting further right/outward.
    if (dir === 'E') { pod.TL.Fx += topF; pod.BL.Fx += f; if (topHorizOn) firing.TL = true; firing.BL = true; }
    else              { pod.TR.Fx -= topF; pod.BR.Fx -= f; if (topHorizOn) firing.TR = true; firing.BR = true; }
  }
  function fireRotation(cw) {
    const s = cw ? 1 : -1;
    pod.TL.Fx += s * f; pod.TL.Fy += s * f;
    pod.TR.Fx += s * f; pod.TR.Fy -= s * f;
    pod.BR.Fx -= s * f; pod.BR.Fy -= s * f;
    pod.BL.Fx -= s * f; pod.BL.Fy += s * f;
    firing.TL = firing.TR = firing.BR = firing.BL = true;
  }

  if (rcsCmd.CW) fireRotation(true);
  if (rcsCmd.ACW) fireRotation(false);
  if (rcsCmd.N || rcsCmd.NE || rcsCmd.NW) fireVert('N');
  if (rcsCmd.S || rcsCmd.SE || rcsCmd.SW) fireVert('S');
  if (rcsCmd.E || rcsCmd.NE || rcsCmd.SE) fireHoriz('E');
  if (rcsCmd.W || rcsCmd.NW || rcsCmd.SW) fireHoriz('W');

  const positions = {
    TL: { x: -CONFIG.RCS_X_OFFSET, y: geo.yTop },
    TR: { x: CONFIG.RCS_X_OFFSET, y: geo.yTop },
    BL: { x: -CONFIG.RCS_X_OFFSET, y: geo.yBottom },
    BR: { x: CONFIG.RCS_X_OFFSET, y: geo.yBottom },
  };

  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  Object.keys(pod).forEach(k => {
    const p = pod[k], pos = positions[k];
    Fx += p.Fx; Fy += p.Fy;
    const rx = pos.x, ry = pos.y - comH;
    torque += rx * p.Fy - ry * p.Fx;
    const mag = Math.hypot(p.Fx, p.Fy);
    if (mag > 0) mdot += mag / CONFIG.RCS_VE;
  });

  return { Fx, Fy, torque, mdot, firing, pod };
}

function clearRCS() {
  Object.keys(rcsCmd).forEach(k => rcsCmd[k] = false);
}
