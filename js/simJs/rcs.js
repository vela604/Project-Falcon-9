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
//    That duty cycle is realized with a DELTA-SIGMA (error-accumulation)
//    modulator rather than a naive period+threshold gate. A naive gate can
//    only turn the top pod on/off at whole-tick boundaries, so the ON-time
//    actually realized in any one period is quantized and slightly off from
//    the ideal target — leaving a small residual net force/torque "noise"
//    every period. The delta-sigma version measures that leftover error at
//    every period boundary and folds it into the NEXT period's target duty
//    (fire a little more or a little less to pay back what was under/over-
//    delivered). The error is never permanently lost — it's carried forward
//    and cancelled out — so the long-run average duty converges EXACTLY to
//    the ideal value, even though any single short period can still be
//    slightly off.
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

// PWM clock + delta-sigma error-accumulation state for the top-pod lateral
// duty cycle. `sigmaError` is the running, never-discarded ledger of
// (ideal duty − actually-applied duty) from every completed period; it gets
// folded into the NEXT period's gating threshold so the long-run average
// duty converges exactly to the ideal value instead of carrying a
// persistent quantization bias.
const pwmClock = {
  t: 0,               // elapsed time within the current period
  onTime: 0,           // accumulated ON-time within the current period (for measuring actual duty)
  sigmaError: 0,        // carried-forward duty error (delta-sigma accumulator)
  periodIdealDuty: 0,    // the TRUE ideal duty target for the period in progress
  periodTargetDuty: 0,    // the (error-adjusted) duty actually used to gate this period
  init: false,
};

function resetPWM() {
  pwmClock.t = 0;
  pwmClock.onTime = 0;
  pwmClock.sigmaError = 0;
  pwmClock.periodIdealDuty = 0;
  pwmClock.periodTargetDuty = 0;
  pwmClock.init = false;
}

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
//
// PHASE 2 DECISION (a) — recorded in PHASE2_PROMPT.md: only the pod LIST
// (which ids exist, where each one sits) is sourced from the registry
// (CONFIG.RCS_TYPE.frame.pods). The fire-logic below — the torque-
// cancellation math and delta-sigma PWM duty-cycling derived in the design
// notes above — stays tuned specifically to the 4-corner "cornerPods"
// geometry and its literal TL/TR/BL/BR ids. A future non-4-corner RCS
// `kind` needs its own dedicated fire-logic function; branching on `kind`
// (never on a type's `id`) is the sanctioned way to add one, per the hard
// rule in PHASE2_PROMPT.md.
function computeRCS(comH, dt) {
  const rcsType = CONFIG.RCS_TYPE;
  if (!rcsType || rcsType.kind !== 'cornerPods') {
    if (rcsType) console.warn(`computeRCS: RCS type "${rcsType.id}" (kind "${rcsType.kind}") has no matching fire-logic implementation yet \u2014 RCS disabled this tick.`);
    return zeroRCS();
  }

  const f = CONFIG.RCS_THRUST;
  const geo = rcsGeometry(comH);
  const period = CONFIG.RCS_PWM_PERIOD;
  const idealDuty = Math.min(1, geo.dBottom / geo.dTop);

  if (!pwmClock.init) {
    pwmClock.init = true;
    pwmClock.periodIdealDuty = idealDuty;
    pwmClock.periodTargetDuty = idealDuty;
  }

  // Gate this tick using the CURRENT period's (possibly error-adjusted)
  // target duty, and track how much ON-time actually gets realized.
  const topLateralOn = pwmClock.t < pwmClock.periodTargetDuty * period;
  if (topLateralOn) pwmClock.onTime += dt;

  pwmClock.t += dt;
  if (pwmClock.t >= period) {
    // Period complete — measure the quantization error against THIS
    // period's true ideal duty, and carry it into the accumulator.
    const actualDuty = pwmClock.onTime / period;
    pwmClock.sigmaError += pwmClock.periodIdealDuty - actualDuty;

    pwmClock.t -= period;
    pwmClock.onTime = 0;
    // Fresh ideal duty for the new period (geometry may have drifted a
    // little as fuel burns), gated through the accumulated correction.
    pwmClock.periodIdealDuty = idealDuty;
    pwmClock.periodTargetDuty = Math.min(1, Math.max(0, idealDuty + pwmClock.sigmaError));
  }

  // Pod list, top/bottom-ness, and fixed lateral push direction all derive
  // from the registry's pod metadata (id + corner: [xSign, 'top'|'bottom'])
  // instead of a hardcoded {TL,TR,BL,BR} literal. lateralSign is the
  // opposite of the pod's own mounting side: a LEFT-mounted pod (xSign -1)
  // ejects further outward-left, so its reaction pushes the vehicle RIGHT
  // (+1) — see the design notes above.
  const podDefs = rcsType.frame.pods;
  const pod = {}, isTop = {}, lateralSign = {};
  podDefs.forEach(p => {
    pod[p.id] = { Fx: 0, Fy: 0 };
    isTop[p.id] = p.corner[1] === 'top';
    lateralSign[p.id] = -p.corner[0];
  });

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

  // Positions, too, come from the registry's pod metadata rather than a
  // hardcoded {TL,TR,BL,BR} literal — a different cornerPods-kind type
  // (different X offset conventions aside) needs no changes here.
  const positions = {};
  podDefs.forEach(p => {
    positions[p.id] = { x: p.corner[0] * CONFIG.RCS_X_OFFSET, y: p.corner[1] === 'top' ? geo.yTop : geo.yBottom };
  });

  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  const firing = {};
  podDefs.forEach(p => { firing[p.id] = false; });
  Object.keys(pod).forEach(k => {
    const p = pod[k], pos = positions[k];
    Fx += p.Fx; Fy += p.Fy;
    const rx = pos.x, ry = pos.y - comH;
    torque += rx * p.Fy - ry * p.Fx;
    const mag = Math.hypot(p.Fx, p.Fy);
    if (mag > 0.01) { mdot += mag / CONFIG.RCS_VE; firing[k] = true; }
  });

  return { Fx, Fy, torque, mdot, firing, pod, dutyTop: idealDuty, topLateralOn, sigmaError: pwmClock.sigmaError };
}

function clearRCS() {
  Object.keys(rcsCmd).forEach(k => rcsCmd[k] = false);
}

