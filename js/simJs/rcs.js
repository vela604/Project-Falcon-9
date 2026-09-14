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

// rcsCmd is a Proxy over the ACTIVE body's own rcsCmd object. Buttons write
// here → only affect the active body. Other bodies keep their own rcsCmd
// state (frozen commands, autopilot commands, etc).
const _RCS_KEYS = ['N','S','E','W','NE','NW','SE','SW','CW','ACW'];
function _blankRcsCmd() {
  const o = {};
  _RCS_KEYS.forEach(k => { o[k] = false; });
  return o;
}

function ensureRcsState(body) {
  if (!body) return;
  if (!body.rcsCmd) body.rcsCmd = _blankRcsCmd();
}

const rcsCmd = new Proxy({}, {
  get(_, k) {
    const b = state.bodies && state.bodies[state.activeBodyIndex];
    if (!b) return false;
    ensureRcsState(b);
    return b.rcsCmd[k];
  },
  set(_, k, v) {
    const b = state.bodies && state.bodies[state.activeBodyIndex];
    if (!b) return true;
    ensureRcsState(b);
    b.rcsCmd[k] = v;
    return true;
  },
});

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

function rcsGeometry(comH, body) {
  // Resolve from THIS body's own bottom member — mirrors how engines are
  // resolved per-body (buildEnginesForRecord(body.members[0])). Falls back
  // to CONFIG only when body/member info isn't available (legacy safety).
  const bottomMember = (body && body.members && body.members[0]) ? body.members[0] : null;
  const bodyHeight = (typeof _bodyHeightOf === 'function') ? _bodyHeightOf(body) : CONFIG.ROCKET_HEIGHT;
  const p = bottomMember && bottomMember.params;
  const topYRaw = (p && Number.isFinite(p.rcsTopY)) ? p.rcsTopY : CONFIG.RCS_TOP_Y;
  const bottomY = (p && Number.isFinite(p.rcsBottomY)) ? p.rcsBottomY : CONFIG.RCS_BOTTOM_Y;
  const yTop = Math.min(bodyHeight, topYRaw);       // safety clamp
  return {
    yTop, yBottom: bottomY,
    dTop: Math.max(0.01, yTop - comH),
    dBottom: Math.max(0.01, comH - bottomY),
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
function computeRCSForBody(body, comH, dt) {
  const bottomMember = (body && body.members && body.members[0]) ? body.members[0] : null;
  const rcsType = (bottomMember && typeof getComponentType === 'function')
    ? getComponentType(bottomMember.rcsTypeId)
    : CONFIG.RCS_TYPE;
  if (!rcsType || rcsType.kind !== 'cornerPods') return zeroRCS();
  if (!body) return zeroRCS();

  const p = bottomMember && bottomMember.params;
  const f = (p && Number.isFinite(p.rcsThrust)) ? p.rcsThrust : CONFIG.RCS_THRUST;
  const ve = (p && Number.isFinite(p.rcsVe)) ? p.rcsVe : CONFIG.RCS_VE;
  const xOffset = (p && Number.isFinite(p.rcsXOffset)) ? p.rcsXOffset : CONFIG.RCS_X_OFFSET;
  const period = (p && Number.isFinite(p.rcsPwmPeriod)) ? p.rcsPwmPeriod : CONFIG.RCS_PWM_PERIOD;

  // Per-body PWM clock.
  if (!body.pwmClock) {
    body.pwmClock = { t: 0, onTime: 0, sigmaError: 0, periodIdealDuty: 0, periodTargetDuty: 0, init: false };
  }
  const clock = body.pwmClock;

  const cmd = body.rcsCmd || {};
  const geo = rcsGeometry(comH, body);
  const idealDuty = Math.min(1, geo.dBottom / geo.dTop);

  if (!clock.init) {
    clock.init = true;
    clock.periodIdealDuty = idealDuty;
    clock.periodTargetDuty = idealDuty;
  }
  const topLateralOn = clock.t < clock.periodTargetDuty * period;
  if (topLateralOn) clock.onTime += dt;
  clock.t += dt;
  if (clock.t >= period) {
    const actualDuty = clock.onTime / period;
    clock.sigmaError += clock.periodIdealDuty - actualDuty;
    clock.t -= period;
    clock.onTime = 0;
    clock.periodIdealDuty = idealDuty;
    clock.periodTargetDuty = Math.min(1, Math.max(0, idealDuty + clock.sigmaError));
  }

  const podDefs = rcsType.frame.pods;
  const pod = {}, isTop = {}, lateralSign = {};
  podDefs.forEach(p => {
    pod[p.id] = { Fx: 0, Fy: 0 };
    isTop[p.id] = p.corner[1] === 'top';
    lateralSign[p.id] = -p.corner[0];
  });

  function fireLateral(k) {
    const on = isTop[k] ? topLateralOn : true;
    pod[k].Fx += on ? lateralSign[k] * f : 0;
  }
  function fireLateralFull(k) { pod[k].Fx += lateralSign[k] * f; }
  function fireVertical(k, sign) { pod[k].Fy += sign * f; }

  if (cmd.N) ['TL','TR','BL','BR'].forEach(k => fireVertical(k, +1));
  if (cmd.S) ['TL','TR','BL','BR'].forEach(k => fireVertical(k, -1));
  const wantRight = cmd.E || cmd.NE || cmd.SE;
  const wantLeft  = cmd.W || cmd.NW || cmd.SW;
  if (wantRight) ['TL','BL'].forEach(fireLateral);
  if (wantLeft)  ['TR','BR'].forEach(fireLateral);
  if (cmd.NE || cmd.NW) ['TL','TR'].forEach(k => fireVertical(k, +1));
  if (cmd.SE || cmd.SW) ['BL','BR'].forEach(k => fireVertical(k, -1));
  if (cmd.CW) {
    fireLateralFull('TL'); fireVertical('TL', +1);
    fireLateralFull('BR'); fireVertical('BR', -1);
    fireVertical('TR', -1); fireVertical('BL', +1);
  }
  if (cmd.ACW) {
    fireLateralFull('TR'); fireVertical('TR', +1);
    fireLateralFull('BL'); fireVertical('BL', -1);
    fireVertical('TL', -1); fireVertical('BR', +1);
  }

  const positions = {};
  podDefs.forEach(p => {
    positions[p.id] = { x: p.corner[0] * xOffset, y: p.corner[1] === 'top' ? geo.yTop : geo.yBottom };
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
    if (mag > 0.01) { mdot += mag / ve; firing[k] = true; }
  });

  return { Fx, Fy, torque, mdot, firing, pod, dutyTop: idealDuty };
}

// Backwards-compat shim.
function computeRCS(comH, dt) {
  const body = state.bodies && state.bodies[state.activeBodyIndex];
  return computeRCSForBody(body, comH, dt);
}

// resetPWM — now a no-op since PWM lives per body; left for compat.
function resetPWM() { /* per-body now */ }

function clearRCS() {
  Object.keys(rcsCmd).forEach(k => rcsCmd[k] = false);
}

