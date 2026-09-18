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
//    NOTE: the "top pod has the larger arm" assumption holds when the CoM
//    sits below geometric mid-height (typical for a full rocket). With a
//    high CoM (heavy upper stage, near-empty booster), the BOTTOM arm can
//    be longer instead — the code below handles both cases by detecting
//    which arm is longer at runtime and gating that pod.

// ============================================================================

// rcsCmd is a Proxy over the ACTIVE body's own rcsCmd object. Buttons write
// here → only affect the active body. Other bodies keep their own rcsCmd
// state (frozen commands, autopilot commands, etc).
const _RCS_KEYS = ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'CW', 'ACW'];

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
  t: 0, // elapsed time within the current period
  onTime: 0, // accumulated ON-time within the current period (for measuring actual duty)
  sigmaError: 0, // carried-forward duty error (delta-sigma accumulator)
  periodIdealDuty: 0, // the TRUE ideal duty target for the period in progress
  periodTargetDuty: 0, // the (error-adjusted) duty actually used to gate this period
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

// ---------------------------------------------------------------------------
// Phase 3 Extension (Plan A1) — pod identity + per-body pod list for the
// guidance snapshot. Every member with a valid RCS type contributes its
// own pods, each with a body-unique id (`b<memberIdx>.<side><idxWithinSide>`).
// idxWithinSide is scoped to (memberIdx, side) — memberIdx is already baked
// into the id prefix, so a top-member pod and a bottom-member pod on the
// same side both get idx 1 independently (matches the spec's own
// b0.L1/b1.L1 example). Does NOT change how RCS force is actually computed
// yet — computeRCSForBody still resolves only body.members[0] until Plan
// A2's kind-dispatch refactor lands. This is purely the identity/geometry
// layer the rest of the extension builds on.
// ---------------------------------------------------------------------------
function buildPodId(memberIdx, side, idxWithinSide) {
  return `b${memberIdx}.${side}${idxWithinSide}`;
}

function buildPodEntries(body) {
  if (!body || !body.members || !body.members.length) return [];
  // Reuses physics.js's own per-member stacking computation rather than
  // re-deriving cumulative base height independently.
  const aeroProfile = (typeof bodyAeroProfile === 'function') ? bodyAeroProfile(body) : null;
  const entries = [];
  body.members.forEach((member, memberIdx) => {
    const rcsType = (typeof getComponentType === 'function') ?
      getComponentType(member.rcsTypeId) : null;
    if (!rcsType || !rcsType.frame || !rcsType.frame.pods) return;
    const p = member.params || {};
    const xOffset = Number.isFinite(p.rcsXOffset) ? p.rcsXOffset : CONFIG.RCS_X_OFFSET;
    const topY = Number.isFinite(p.rcsTopY) ? p.rcsTopY : CONFIG.RCS_TOP_Y;
    const bottomY = Number.isFinite(p.rcsBottomY) ? p.rcsBottomY : CONFIG.RCS_BOTTOM_Y;
    const baseHeight = (aeroProfile && aeroProfile.members[memberIdx]) ?
      aeroProfile.members[memberIdx].baseY : 0;
    
    // Group this member's own pod defs by side, then sort each side's
    // pods by descending local Y (topmost = idx 1).
    const bySide = { L: [], R: [] };
    rcsType.frame.pods.forEach(podDef => {
      const side = podDef.corner[0] < 0 ? 'L' : 'R';
      const localY = podDef.corner[1] === 'top' ? topY : bottomY;
      bySide[side].push({ podDef, localY });
    });
    ['L', 'R'].forEach(side => {
      bySide[side]
        .sort((a, b2) => b2.localY - a.localY) // descending local Y = topmost first
        .forEach((entry, i) => {
          const idxWithinSide = i + 1;
          entries.push({
            podId: buildPodId(memberIdx, side, idxWithinSide),
            memberIdx,
            side,
            offsetFromStackBase: baseHeight + entry.localY,
            kind: rcsType.kind,
            memberLocalX: entry.podDef.corner[0] * xOffset,
            memberLocalY: entry.localY,
            rcsTypeId: member.rcsTypeId,
          });
        });
    });
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Phase 3 Extension (Plan A2) — kind-dispatch refactor.
//
// Below this point, computeRCSForBody() no longer resolves a single
// rcsType off body.members[0] and runs one fixed fire-logic block. It
// asks buildPodEntries() for EVERY member's pods, groups them by member,
// and for each member looks up that member's own rcsType.kind in
// RCS_FIRE_LOGIC — the ONLY place `kind` is ever branched on, per the
// hard rule from PHASE2_PROMPT.md (a new non-4-corner kind gets its own
// fire-logic function added to this table, never a new `if` elsewhere).
//
// fireCornerPods(body, member, entries, ctx) is exactly the OLD
// computeRCSForBody's fire logic (design notes 1-4 at the top of this
// file all still apply verbatim), generalized from "the pods live at
// fixed TL/TR/BL/BR ids on body.members[0]" to "the pods live at
// whatever ids buildPodEntries assigned, on THIS member, at THIS
// member's own height in the stack". The torque-cancellation math,
// the delta-sigma PWM, the CW/ACW diagonal-nozzle logic — all identical;
// only the pod identities and the per-member geometry lookup changed.
//
// DEFAULT-FALLBACK CHANGE FROM PRE-A2: the old code fell back to
// CONFIG.RCS_TYPE whenever body.members[0] was missing or had no
// resolvable rcsTypeId. That fallback is GONE — a member with no
// resolvable RCS type now contributes exactly zero pods (via
// buildPodEntries, which already skips it) and exactly zero force,
// full stop. This matches the multi-member model's own logic ("a member
// without RCS installed doesn't fire RCS") rather than silently
// borrowing some other vehicle's default hardware. Every member built
// through fleet.js's normal construction path already carries a real
// rcsTypeId (or an explicit null for roles that shouldn't have one — see
// fleet.js's PS-B2 guard), so this only changes behavior for a
// degenerate hand-built body with no members / no rcsTypeId anywhere,
// which previously fired phantom RCS off a vehicle-wide default it had
// no actual hardware for.
// ---------------------------------------------------------------------------

// Fires ONE member's 4-corner ("cornerPods") RCS pods for this tick.
// entries: this member's own slice of buildPodEntries()'s output (exactly
// the pods belonging to this memberIdx — NOT the whole body's pod list).
// ctx: { comH, comW, dt, cmd, rcsDuty }
//   cmd — the boolean rcsCmd table, or null if this member shouldn't
//         respond to it (see computeRCSForBody: only the BOTTOM member
//         ever responds to the human boolean path — success criterion 6's
//         stated default choice, called out here since this is the one
//         place that default lives).
//   rcsDuty — body.rcsDuty (guidance's raw per-pod duty command), or null.
// Returns { Fx, Fy, torque, mdot, firing, pod, dutyTop } for THIS member
// only; computeRCSForBody sums these across members.
function fireCornerPods(body, member, entries, ctx) {
  if (!entries || !entries.length) return null;
  const { comH, comW, dt, cmd, rcsDuty } = ctx;
  
  const p = member && member.params;
  const f = (p && Number.isFinite(p.rcsThrust)) ? p.rcsThrust : CONFIG.RCS_THRUST;
  const ve = (p && Number.isFinite(p.rcsVe)) ? p.rcsVe : CONFIG.RCS_VE;
  const period = (p && Number.isFinite(p.rcsPwmPeriod)) ? p.rcsPwmPeriod : CONFIG.RCS_PWM_PERIOD;
  
  // Per-member PWM clock (see the pwmClocks comment on _makeBody in
  // physics.js). memberIdx is the same for every entry in this group.
  const memberIdx = entries[0].memberIdx;
  if (!body.pwmClocks) body.pwmClocks = {};
  if (!body.pwmClocks[memberIdx]) {
    body.pwmClocks[memberIdx] = { t: 0, onTime: 0, sigmaError: 0, periodIdealDuty: 0, periodTargetDuty: 0, init: false };
  }
  const clock = body.pwmClocks[memberIdx];
  
  // This member's own top/bottom pod heights, in STACK frame (same frame
  // comH is measured in) — buildPodEntries already did the
  // member-base-offset + local-Y addition for us (offsetFromStackBase).
  // yTopRaw/yBottomStack derived as max/min across whatever pods this
  // member actually has, rather than assuming a fixed L/R pairing —
  // robust even if a cornerPods member somehow has fewer than 4 pods.
  const ys = entries.map(e => e.offsetFromStackBase);
  const yTopRaw = Math.max.apply(null, ys);
  const yBottomStack = Math.min.apply(null, ys);
  // Same safety clamp the old single-member code applied (topY clamped to
  // the WHOLE body's height, not just this member's) — kept identical
  // rather than "fixed" to a per-member bound, so a bottom-member (the
  // common case, and the one the A2 verification pass checks byte-for-
  // byte) sees EXACTLY the same yTop it always did.
  const bodyHeight = (typeof _bodyHeightOf === 'function') ? _bodyHeightOf(body) : CONFIG.ROCKET_HEIGHT;
  const yTop = Math.min(bodyHeight, yTopRaw);
  const yBottom = yBottomStack;
  const dTop = Math.max(0.01, yTop - comH);
  const dBottom = Math.max(0.01, comH - yBottom);
  
  // Which pod has the LONGER moment arm? That's the one producing more
  // torque for the same lateral force, so IT gets PWM'd down to match the
  // shorter-arm pod's effective average. The original design hardcoded
  // "top is longer" — true only when the CoM sits below geometric
  // mid-height. With a high CoM (heavy upper stage, near-empty booster)
  // the bottom arm can be longer instead — detected at runtime, per
  // member (each member's own dTop/dBottom relative to the SAME body-wide
  // comH), exactly as before.
  const topIsLonger = dTop >= dBottom;
  const idealDuty = topIsLonger ?
    Math.min(1, dBottom / dTop) // top is long-arm, PWM top
    :
    Math.min(1, dTop / dBottom); // bottom is long-arm, PWM bottom
  
  if (!clock.init) {
    clock.init = true;
    clock.periodIdealDuty = idealDuty;
    clock.periodTargetDuty = idealDuty;
  }
  const longArmLateralOn = clock.t < clock.periodTargetDuty * period;
  if (longArmLateralOn) clock.onTime += dt;
  clock.t += dt;
  if (clock.t >= period) {
    const actualDuty = clock.onTime / period;
    clock.sigmaError += clock.periodIdealDuty - actualDuty;
    clock.t -= period;
    clock.onTime = 0;
    clock.periodIdealDuty = idealDuty;
    clock.periodTargetDuty = Math.min(1, Math.max(0, idealDuty + clock.sigmaError));
  }
  
  // Per-pod lookup tables, keyed by this member's actual pod ids (b0.L1,
  // b0.R2, ...) instead of the old literal TL/TR/BL/BR.
  const pod = {}, isTop = {}, lateralSign = {};
  let topL = null, topR = null, bottomL = null, bottomR = null;
  entries.forEach(e => {
    pod[e.podId] = { Fx: 0, Fy: 0 };
    const top = e.offsetFromStackBase === yTopRaw;
    isTop[e.podId] = top;
    lateralSign[e.podId] = (e.side === 'L') ? +1 : -1;
    if (e.side === 'L') { if (top) topL = e.podId; else bottomL = e.podId; }
    else { if (top) topR = e.podId; else bottomR = e.podId; }
  });
  
  // Gate whichever pod currently has the LONGER moment arm (see topIsLonger
  // above). The other pod fires continuously at full force. This preserves
  // the original zero-net-torque invariant under any CoM position.
  function fireLateral(k) {
    if (!k) return;
    const isLongArm = topIsLonger ? isTop[k] : !isTop[k];
    const on = isLongArm ? longArmLateralOn : true;
    pod[k].Fx += on ? lateralSign[k] * f : 0;
  }
  
  function fireLateralFull(k) { if (k) pod[k].Fx += lateralSign[k] * f; }
  
  function fireVertical(k, sign) { if (k) pod[k].Fy += sign * f; }
  
  // PHASE 3 — Interface Fix, Issue 5: raw nozzle interface. Guidance
  // commands the exact duty it wants on each pod; the long-arm
  // torque-cancellation gate that the human boolean path (fireLateral /
  // fireLateralFull, above) uses does NOT apply here. That gate exists
  // to make a symmetric human "fire both toward this side" command
  // produce zero net torque — a convenience for a binary input. Guidance
  // has a continuous per-pod interface instead: if it wants balanced
  // lateral firing, it computes the compensating duties itself and sends
  // those. Physics applies exactly what it is given, full stop.
  function fireLateralDuty(k, commandedDuty) {
    if (commandedDuty <= 0) return;
    pod[k].Fx += lateralSign[k] * commandedDuty * f;
  }
  
  function fireVerticalDuty(k, sign, commandedDuty) {
    if (commandedDuty <= 0) return;
    pod[k].Fy += sign * commandedDuty * f;
  }
  
  if (rcsDuty) {
    // PHASE 3: explicit per-pod, per-nozzle duty command (guidance). Keyed
    // by this member's own pod ids — a duty payload with no entry for a
    // given podId simply leaves that pod idle.
    entries.forEach(e => {
      const d = rcsDuty[e.podId];
      if (!d) return;
      fireLateralDuty(e.podId, d.lat || 0);
      fireVerticalDuty(e.podId, +1, d.up || 0);
      fireVerticalDuty(e.podId, -1, d.dn || 0);
    });
  } else if (cmd) {
    // Boolean human path — ONLY reaches here for the bottom member (see
    // computeRCSForBody: cmd is passed as null for every other member).
    if (cmd.N) [topL, topR, bottomL, bottomR].forEach(k => fireVertical(k, +1));
    if (cmd.S) [topL, topR, bottomL, bottomR].forEach(k => fireVertical(k, -1));
    const wantRight = cmd.E || cmd.NE || cmd.SE;
    const wantLeft = cmd.W || cmd.NW || cmd.SW;
    if (wantRight) [topL, bottomL].forEach(fireLateral);
    if (wantLeft) [topR, bottomR].forEach(fireLateral);
    if (cmd.NE || cmd.NW) [topL, topR].forEach(k => fireVertical(k, +1));
    if (cmd.SE || cmd.SW) [bottomL, bottomR].forEach(k => fireVertical(k, -1));
    if (cmd.CW) {
      fireLateralFull(topL);
      fireVertical(topL, +1);
      fireLateralFull(bottomR);
      fireVertical(bottomR, -1);
      fireVertical(topR, -1);
      fireVertical(bottomL, +1);
    }
    if (cmd.ACW) {
      fireLateralFull(topR);
      fireVertical(topR, +1);
      fireLateralFull(bottomL);
      fireVertical(bottomL, -1);
      fireVertical(topL, -1);
      fireVertical(bottomR, +1);
    }
  }
  // Neither rcsDuty nor cmd applies to this member (e.g. an upper member
  // with no duty command outstanding and, per the default above, not
  // wired to the boolean path) — every pod stays at {Fx:0, Fy:0}, exactly
  // as if this member had no RCS commanded at all this tick.
  
  const positions = {};
  entries.forEach(e => {
    positions[e.podId] = { x: e.memberLocalX, y: e.offsetFromStackBase };
  });
  
  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  const firing = {};
  const appliedDuty = {};
  entries.forEach(e => { firing[e.podId] = false; appliedDuty[e.podId] = 0; });
  Object.keys(pod).forEach(k => {
    const pp = pod[k], pos = positions[k];
    Fx += pp.Fx;
    Fy += pp.Fy;
    appliedDuty[k] = f > 0 ? Math.abs(pp.Fx) / f : 0;
    
    // Pivot = the vehicle's ACTUAL current CoM (comW/comH) — same
    // convention every member's pods use, matching
    // computeMainThrustForBody's convention. comW is 0 whenever slosh is
    // off or inactive, so this is a no-op everywhere except while slosh
    // has shifted the lateral CoM away from the centerline.
    const rx = pos.x - (comW || 0), ry = pos.y - comH;
    torque += rx * pp.Fy - ry * pp.Fx;
    const mag = Math.hypot(pp.Fx, pp.Fy);
    if (mag > 0.01) { mdot += mag / ve; firing[k] = true; }
  });
  
  // Source-agnostic: the human boolean path's gate shows up here as a
  // reduced applied fraction on whichever pod it damped; guidance's raw
  // duty path shows up as exactly what it commanded. This member's own
  // top-pod average — computeRCSForBody surfaces the BOTTOM member's
  // value as the body-level dutyTop (matching what it always meant:
  // "how hard is the primary/human-controlled pod set working").
  const dutyTop = 0.5 * ((appliedDuty[topL] || 0) + (appliedDuty[topR] || 0));
  
  return { Fx, Fy, torque, mdot, firing, pod, dutyTop };
}

// Dispatch table: the ONLY place RCS `kind` is ever branched on. A future
// non-4-corner kind gets its own fire-logic function added here — never a
// new `if (rcsType.kind === ...)` anywhere else in this file or in
// computeRCSForBody below.
const RCS_FIRE_LOGIC = { cornerPods: fireCornerPods };

// Computes this tick's TOTAL RCS force/torque/mass-flow for a body,
// summed across EVERY member that carries a valid, dispatchable RCS
// type — not just body.members[0]. `pod`/`firing` in the returned object
// are keyed by the pod ids buildPodEntries() assigned (b0.L1, b1.R2, …),
// merged across all members that fired this tick.
function computeRCSForBody(body, comH, comW, dt) {
  if (!body) return zeroRCS();
  const podEntries = (typeof buildPodEntries === 'function') ? buildPodEntries(body) : [];
  if (!podEntries.length) return zeroRCS();
  
  const byMember = {};
  podEntries.forEach(e => {
    (byMember[e.memberIdx] = byMember[e.memberIdx] || []).push(e);
  });
  
  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  const firing = {}, pod = {};
  let dutyTop = 0;
  
  Object.keys(byMember).forEach(key => {
    const memberIdx = Number(key);
    const member = body.members && body.members[memberIdx];
    if (!member) return;
    const rcsType = (typeof getComponentType === 'function') ? getComponentType(member.rcsTypeId) : null;
    const fireFn = rcsType ? RCS_FIRE_LOGIC[rcsType.kind] : null;
    if (typeof fireFn !== 'function') return; // unknown/unregistered kind — skip, no branching here
    
    const isBottom = memberIdx === 0;
    const result = fireFn(body, member, byMember[memberIdx], {
      comH, comW, dt,
      // Success criterion 6's stated default: the human boolean path only
      // ever fires the BOTTOM member's pods. Every other member only
      // responds to an explicit guidance rcsDuty command.
      cmd: (isBottom && !body.rcsDuty) ? (body.rcsCmd || {}) : null,
      rcsDuty: body.rcsDuty || null,
    });
    if (!result) return;
    
    Fx += result.Fx;
    Fy += result.Fy;
    torque += result.torque;
    mdot += result.mdot;
    Object.assign(firing, result.firing);
    Object.assign(pod, result.pod);
    if (isBottom) dutyTop = result.dutyTop;
  });
  
  return { Fx, Fy, torque, mdot, firing, pod, dutyTop };
}

// Backwards-compat shim.
function computeRCS(comH, dt) {
  const body = state.bodies && state.bodies[state.activeBodyIndex];
  const geom = (typeof geometryOf === 'function') ? geometryOf(body) : null;
  return computeRCSForBody(body, comH, geom ? geom.comW : 0, dt);
}

// resetPWM — now a no-op since PWM lives per body (per-member, since
// Plan A2); left for compat.
function resetPWM() { /* per-body/per-member now */ }

function clearRCS() {
  Object.keys(rcsCmd).forEach(k => rcsCmd[k] = false);
  // PHASE 3: rcsDuty lives directly on the body (not behind the rcsCmd
  // proxy), so clear it the same direct way.
  const b = state.bodies && state.bodies[state.activeBodyIndex];
  if (b) b.rcsDuty = null;
}
