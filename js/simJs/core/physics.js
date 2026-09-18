globalThis.DEBUG_PHYSICS = false;

// ============================================================================
// FRAME CONVENTIONS — read this before touching state fields
// ============================================================================
//
// The simulation state is stored in the INERTIAL frame: Earth-centered,
// non-rotating, +y toward the launch meridian at t=0. All position and
// velocity fields below are inertial unless explicitly suffixed otherwise.
//
//   state.rx, state.ry      INERTIAL position (m, Earth-centered)
//   state.vx, state.vy      INERTIAL velocity (m/s)
//   state.theta             INERTIAL body-axis angle (rad) — angle of the
//                           body's local "up" (+y_local) in the inertial
//                           frame
//   state.omega             INERTIAL angular velocity (rad/s)
//   state.dryMass, fuelMass MASS — frame-independent
//
// Common DERIVED quantities and their frames:
//
//   r = hypot(rx, ry)                    frame-independent (radial distance)
//   phi = atan2(rx, ry)                  INERTIAL angle
//   phi_ef = phi - ω_earth·t             EARTH-FIXED angle
//   localVertical = atan2(-rx, ry)       INERTIAL angle of local vertical
//   tilt = theta - localVertical         EARTH-RELATIVE attitude
//
//   Radial direction (rx/r, ry/r)        same in both frames
//   East direction   (ry/r, -rx/r)       same in both frames (points toward
//                                        increasing phi — the direction of
//                                        Earth's rotation)
//
//   v_radial     = v·(radial unit)       same in both frames
//   v_tangential = v·(east unit)         INERTIAL tangential velocity
//   v_tang_rel   = v_tangential - ω·r    EARTH-RELATIVE tangential velocity
//
//   omega_inertial                       state.omega
//   omega_earth_relative = omega + ω_e   angular velocity relative to the
//                                        rotating Earth frame
//
// When adding a new state field or telemetry readout, ALWAYS suffix the
// variable name with Inertial or Relative so the frame is unambiguous.
// ============================================================================


let separationFlash = null;
let separationFlashId = 0;


// Two-phase staging state. When the user requests a separation, the
// booster's engines are commanded to zero FIRST and the split is deferred
// until thrust has actually spooled down. Without this, the member slice
// and body spawn both landed on the same tick as the shutdown command
// while the booster was still firing at full throttle — the two bodies
// overlapped at the same position with thrust still active, producing an
// immediate collision. Real boosters throttle down and cut off before the
// separation bolts fire.
let pendingSeparate = null; // { bodyId, requestedAt } or null

// Same two-phase pattern for payload release: commanding the payload off
// while the engine is still firing would shoot it through the plume.
// Real upper stages do a SECO (Second Engine Cut-Off) before deploying.
// Emergency eject deliberately BYPASSES this — that path is a "save the
// cargo no matter what" flow and cannot afford a 1.2 s spool-down wait.
let pendingRelease = null; // { bodyId, requestedAt, emergency, kick } or null
// A2 CLEANUP: computeEngineParamsForRecord(rec) removed — verified zero
// callers anywhere in the codebase.

// H2a-2: rebuild the global ENGINES[] to match a body's CURRENT bottom
// member. Called after separation, so thrust/gimbal follow the new bottom.
function rebuildEnginesForBody(body) {
  if (!body || !body.members || !body.members.length) return;
  
  const prevBottom = body._lastBottomMember;
  const newBottom = body.members[0];
  
  const newEngines = (typeof buildEnginesForRecord === 'function') ?
    buildEnginesForRecord(newBottom) : [];
  
  // Preserve engine state when the bottom member is unchanged. Split
  // Fairing, Payload Release, Nose removal — any of those remove a TOP
  // member; the engines belong to the bottom member and their mass flow /
  // gimbal / currentF should carry across untouched. Without this, every
  // rebuild spawned fresh engines at massFlowRate = 0, which is why
  // clicking Split Fairing silently shut the engines down.
  //
  // Stage separation DOES change the bottom (the active body's new
  // bottom is the previous second member), so the check fails and fresh
  // engines are built — correct, because the upper stage's engines are
  // different hardware that needs its own ignition sequence.
  if (prevBottom === newBottom) {
    const oldById = {};
    (body.engines || []).forEach(e => { oldById[e.id] = e; });
    newEngines.forEach(e => {
      const old = oldById[e.id];
      if (old) {
        e.massFlowRate = old.massFlowRate;
        e.targetMassFlowRate = old.targetMassFlowRate;
        e.gimbalDeg = old.gimbalDeg;
        e.targetGimbalDeg = old.targetGimbalDeg;
        e.currentF = old.currentF;
      }
    });
  }
  
  body.engines = newEngines;
  body._lastBottomMember = newBottom;
}

function _makeBody() {
  return {
    id: 'body-' + Math.random().toString(36).slice(2, 6),
    members: [],
    rx: 0,
    ry: 0,
    vx: 0,
    vy: 0,
    theta: 0,
    omega: 0,
    dryMass: 0,
    fuelMass: 0,
    crashed: false,
    landed: false,
    settled: false,
    _wasGrounded: false,
    _groundedFrames: 0, // FIX: consecutive ticks in contact
    _restFrames: 0, // FIX: consecutive ticks near-zero KE while grounded
    isActive: false,
    isDiscarded: false,
    payloadId: null,
    payloadReleased: false,
    legs: { deployed: false, progress: 0 },
    engines: [],
    rcsCmd: (typeof _blankRcsCmd === 'function') ? _blankRcsCmd() : { N: false, S: false, E: false, W: false, NE: false, NW: false, SE: false, SW: false, CW: false, ACW: false },
    pwmClock: null,
  };
}



function _makeState() {
  const s = {
    bodies: [],
    activeBodyIndex: 0,
    simTime: 0,
    collisionPairs: [], // Step 2 (collision.js) broad-phase candidate pairs, refreshed every physicsStep
    collisionContacts: [], // Step 3 (collision.js) confirmed narrow-phase contacts, refreshed every physicsStep
  };
  const PROXY_KEYS = ['rx', 'ry', 'vx', 'vy', 'theta', 'omega', 'dryMass', 'fuelMass', 'crashed', 'landed'];
  PROXY_KEYS.forEach(k => {
    Object.defineProperty(s, k, {
      get() { const b = this.bodies[this.activeBodyIndex]; return b ? b[k] : undefined; },
      set(v) { const b = this.bodies[this.activeBodyIndex]; if (b) b[k] = v; },
      enumerable: true,
      configurable: true,
    });
  });
  return s;
}

let state = _makeState();

// Landing legs — `deployed` is the commanded target; `progress` (0 = fully
// stowed, 1 = fully deployed) is rate-limited toward it each tick, same
// pattern as throttle/gimbal, so the legs visibly swing open/closed over
// ~2s rather than snapping instantly. Whether they're actually deployed
// (progress >= LANDING_MIN_LEG_DEPLOY) is one of the conditions checked at
// ground contact to decide LANDED vs CRASHED.
// Per-body legs state. `legs` is a Proxy that always reads/writes the ACTIVE
// body's legs object — all existing `legs.deployed` / `legs.progress`
// accessors keep working without touching every call site.
const legs = new Proxy({}, {
  get(_, k) {
    const b = state.bodies[state.activeBodyIndex];
    if (!b) return undefined;
    if (!b.legs) b.legs = { deployed: false, progress: 0 };
    return b.legs[k];
  },
  set(_, k, v) {
    const b = state.bodies[state.activeBodyIndex];
    if (!b) return true;
    if (!b.legs) b.legs = { deployed: false, progress: 0 };
    b.legs[k] = v;
    return true;
  },
});

function resetLegs() { /* no-op — legs are per-body, initialized in _makeBody() */ }

function updateLegs(dt) {
  // Every body's legs animate toward its OWN deployed flag now — not just
  // the active one. This is manual-deploy infrastructure only (no
  // autonomous trigger here): once the user takes control of a discarded
  // body (takeControlOfBody()) and commands its legs, they need to actually
  // move. Keeping this per-body (rather than active-only) also leaves the
  // door open for a future autopilot/auto-land system to command a
  // non-active body's legs without needing further changes here.
  if (!state.bodies) return;
  state.bodies.forEach(b => {
    if (!b.legs) b.legs = { deployed: false, progress: 0 };
    const target = b.legs.deployed ? 1 : 0;
    const maxDelta = CONFIG.LEG_DEPLOY_RATE * dt;
    if (target > b.legs.progress) b.legs.progress = Math.min(target, b.legs.progress + maxDelta);
    else b.legs.progress = Math.max(target, b.legs.progress - maxDelta);
  });
}

// BUG #6 FIX: returns the real cargo mass still riding on this body — 0
// once releasePayloadOnActiveBody() has fired, or if this body never had
// a payload to begin with (e.g. a discarded booster). Centralised so
// currentGeometry() and separateActiveBody() agree on the same number.
function _bodyPayloadMass(body) {
  if (!body || !body.payloadId || body.payloadReleased) return 0;
  const pl = (typeof getPayload === 'function') ? getPayload(body.payloadId) : null;
  return (pl && Number.isFinite(pl.mass)) ? pl.mass : 0;
}

function totalMass() { return state.dryMass + state.fuelMass; }

function currentGeometry(body) {
  body = body || state.bodies[state.activeBodyIndex];
  const members = (body && body.members) ? body.members : [];
  const fuelMass = body ? body.fuelMass : 0;
  const legProgress = (body && body.isActive) ? legs.progress : 0;
  
  if (members.length && typeof stackMassProps === 'function') {
    const props = stackMassProps(members, fuelMass, legProgress, _bodyPayloadMass(body));
    return { M: props.totalMass, comH: props.comY, comW: props.comX || 0, I: props.moi };
  }
  // Fallback (empty members) — legacy single-body formula.
  const M = (body ? body.dryMass : 0) + fuelMass;
  const comH = computeCoM(fuelMass, M, CONFIG.ROCKET_HEIGHT);
  const I = momentOfInertia(M, CONFIG.ROCKET_HEIGHT, CONFIG.ROCKET_WIDTH);
  return { M, comH, comW: 0, I };
}

// currentGeometry() re-derives the whole mass stack (iterates every
// component) — physicsStep() already computes it fresh for each body every
// tick. Reading code (telemetry panel, figure panel, camera) that just wants
// "the geometry as of right now" for a body should call this instead of
// currentGeometry() directly, so it reuses that same-tick result rather than
// recomputing it from scratch again. Falls back to a fresh calc if a body
// hasn't gone through a physics tick yet (e.g. before sim start).
function geometryOf(body) {
  body = body || state.bodies[state.activeBodyIndex];
  if (body && body._geomCache) return body._geomCache;
  return currentGeometry(body);
}

// ---------------------------------------------------------------------------
// Rate-limited actuator application. Called once per tick from controls.js
// with the *desired* throttle/gimbal targets; this function moves the actual
// engine state toward the target no faster than its physical rate limit.
// ---------------------------------------------------------------------------
function applyActuatorRateLimitsForBody(body, dt) {
  if (!body || !body.engines) return;
  body.engines.forEach(e => {
    // PHASE 1: rate limit in mass-flow units — same physical rate as
    // before (a fraction of this engine's max flow per second), just no
    // longer restated as an abstract 0..1 throttle.
    // A3 FIX: Number.isFinite guard instead of `!== undefined` — a
    // thruster type declaring a non-finite rate (or any other garbage
    // value) used to propagate NaN through massFlowRate every tick after.
    const rateFrac = Number.isFinite(e.massFlowRateRateFrac) ? e.massFlowRateRateFrac : CONFIG.ENGINE_THRUST_RATE;
    const tgt = e.targetMassFlowRate !== undefined ? e.targetMassFlowRate : e.massFlowRate;
    
    // PART B (Option 3) — spool transients. Crossing through zero is a
    // real physical event (turbopump spin-down/spin-up), not just another
    // throttle move, so it gets its own (typically slower) rate over a
    // fixed duration, distinct from the normal mid-range slew above. A
    // move that neither starts at nor targets zero (adjusting throttle
    // while already firing) is unaffected and still uses rateFrac.
    // startupDurationS/shutdownDurationS are placeholders (not yet exposed
    // per-thruster-type in componentLibrary.js) — every engine currently
    // uses the same approximate real-launcher figures until that's wired
    // through.
    let maxDelta;
    if (tgt <= 0 && e.massFlowRate > 0) {
      const shutdownS = (Number.isFinite(e.shutdownDurationS) && e.shutdownDurationS > 0) ? e.shutdownDurationS : 1.2;
      maxDelta = (e.maxMassFlowRate || 0) / shutdownS * dt;
    } else if (tgt > 0 && e.massFlowRate <= 0) {
      const startupS = (Number.isFinite(e.startupDurationS) && e.startupDurationS > 0) ? e.startupDurationS : 2.0;
      maxDelta = (e.maxMassFlowRate || 0) / startupS * dt;
    } else {
      maxDelta = rateFrac * (e.maxMassFlowRate || 0) * dt;
    }
    
    if (tgt > e.massFlowRate) e.massFlowRate = Math.min(tgt, e.massFlowRate + maxDelta);
    else e.massFlowRate = Math.max(tgt, e.massFlowRate - maxDelta);
    e.massFlowRate = Math.max(0, Math.min(e.maxMassFlowRate || 0, e.massFlowRate));
    if (e.gimbal) {
      const mg = CONFIG.GIMBAL_RATE_DEG_S * dt;
      const gt = e.targetGimbalDeg !== undefined ? e.targetGimbalDeg : e.gimbalDeg;
      if (gt > e.gimbalDeg) e.gimbalDeg = Math.min(gt, e.gimbalDeg + mg);
      else e.gimbalDeg = Math.max(gt, e.gimbalDeg - mg);
      e.gimbalDeg = Math.max(-CONFIG.GIMBAL_MAX_DEG, Math.min(CONFIG.GIMBAL_MAX_DEG, e.gimbalDeg));
    }
  });
}

// Body-frame force/torque from all 9 main engines (gimbal already rate-limited).
function computeMainThrustForBody(body, comH) {
  if (!body || !body.engines) return zeroThrust();
  let Fx = 0,
    Fy = 0,
    torque = 0,
    mdot = 0;
  body.engines.forEach(e => {
    if (e.massFlowRate <= 0) { e.currentF = 0; return; }
    // PHASE 1: thrust = mass flow rate × exhaust velocity, directly —
    // this is the physically canonical relation; it was already true
    // before, just previously reached via a throttle-fraction detour.
    const F = e.massFlowRate * e.Ve;
    e.currentF = F;
    const gRad = (e.gimbal ? e.gimbalDeg : 0) * Math.PI / 180;
    const fx = F * Math.sin(gRad);
    const fy = F * Math.cos(gRad);
    Fx += fx;
    Fy += fy;
    torque += e.x * fy - (-comH) * fx;
    mdot += e.massFlowRate;
  });
  return { Fx, Fy, torque, mdot };
}
// A2 CLEANUP: computeMainThrust(comH) backwards-compat shim removed —
// verified zero callers; computeMainThrustForBody(body, comH) is the only
// call path in use.

// Empty-tank stand-ins for computeMainThrust()/computeRCS() — used once the
// propellant tank is dry, so a firing command with no fuel left produces
// literally nothing rather than "free" thrust.
function zeroThrust() { return { Fx: 0, Fy: 0, torque: 0, mdot: 0 }; }

function zeroRCS() { return { Fx: 0, Fy: 0, torque: 0, mdot: 0, firing: {}, pod: {} }; }

// ---------------------------------------------------------------------------
// Aerodynamic drag + angle-of-attack torque.
//
// The drag force magnitude (0.5·ρ·Cd·A·v_rel²) stays exactly anti-parallel
// to the RELATIVE velocity (vehicle velocity minus wind) — unchanged, still
// drives the translational Fdx/Fdy exactly as before.
//
// What was missing: that same drag force, resolved into the BODY frame, has
// a component perpendicular to the body's own long axis whenever the body
// axis and the relative-velocity direction don't line up — i.e. whenever
// angle of attack ≠ 0 (from wind, from a gravity turn, from tumbling, or
// just from a lean while still moving straight). That perpendicular
// ("normal") component acts at the CENTER OF PRESSURE, not the center of
// mass, so unless CP and COM coincide it produces a torque — the classic
// "weathercocking" effect. Ignoring it is not defensible for a realistic
// sim, so every body (active or discarded/staged/fairing/payload) gets it.
//
// Center of pressure is explicitly NOT a constant. It blends between two
// limits as a function of |sin(angle of attack)|:
//   - Near-zero AoA: dominated by the nose's potential-flow (Barrowman-
//     style) normal-force term — CP sits high, near the nose/shoulder
//     (AERO_CP_NOSE_FRAC × body height).
//   - Large AoA (approaching 90°): dominated by the body tube's viscous
//     cross-flow term (Allen–Perkins style) — CP sits at the body's
//     geometric centroid (AERO_CP_BODY_FRAC × body height).
// wCross = |sin(alpha)| sweeps 0→1 across that range, so CP genuinely
// moves with attitude-vs-velocity mismatch — including with wind disabled,
// since alpha only depends on body axis vs. relative-velocity direction.
//
// `extra.height` / `extra.comH` are supplied once per physics tick (fixed
// across the RK4 sub-stages), the same simplification already used for
// extra.I — comH/height don't change fast enough within one tick to matter,
// while velocity/theta (which drive alpha itself) ARE re-evaluated fresh at
// every RK4 sub-stage since they come from `s`.
// ---------------------------------------------------------------------------
const AERO_CP_NOSE_FRAC = 0.90; // fraction of a tapered member's OWN height, low-AoA (nose-term) CP
const AERO_CP_BODY_FRAC = 0.50; // fraction of a member's OWN height, high-AoA (cross-flow) CP / plain cylindrical centroid
// ---- Barrowman linear-regime constants (small AoA, potential flow) ----
// CNα is the slope of the normal-force coefficient vs angle of attack.
// Barrowman's key result: a smooth ogive/cone nose has CNα ≈ 2 (referenced
// to base area), and a smooth cylindrical body has CNα ≈ 0.
const AERO_CNALPHA_NOSE = 2.0;
// Ogive nose CP location, expressed as a fraction of the nose length from
// its base (this is the standard Barrowman value for an ogive profile).
const AERO_CP_NOSE_LINEAR_FRAC = 0.466;

// ---- Allen-Perkins crossflow constant (large AoA, viscous separated flow) ----
// Crossflow drag coefficient for a circular cylinder. This scales the
// sin²α crossflow force term: F = q · Cd_c · A_planform · sin²α.
const AERO_CD_CROSSFLOW = 1.2;


// ---------------------------------------------------------------------------
// Per-body aerodynamic reference geometry (per-member CP/area).
//
// A "body" (the active stack, a discarded booster, a released upper stage,
// a fairing half, a free payload...) may carry an internal `members` list
// (bottom→top stack records). Previously the ENTIRE body — no matter how
// many different members/widths it was actually made of — was treated as
// one aerodynamic surface: a single global CONFIG.ROCKET_WIDTH for area,
// and one blended CP for the whole body's height. That's wrong the moment
// a body's own geometry differs from the currently-active stack (a
// discarded booster is narrower/wider than the stage still riding on it,
// a released upper stage has its own width) — and it also means a
// mid-stack width change contributed NO torque at all, when physically it
// should (that's exactly the kind of CP/CoM mismatch that makes a real
// rocket want to weathercock).
//
// This computes, once per physics tick per body (fixed across the RK4
// sub-stages — same simplification already used for I/comH), each
// member's own frontal area and own local centroid (measured from the
// body's own base) — used below to DISTRIBUTE the net lateral ("normal")
// aerodynamic force across members and sum each member's own torque
// contribution, instead of one lumped CP for the whole body. A body with
// no member breakdown (a free-flying fairing half / released payload —
// pure lumped mass, no stack) falls back to the old single-surface model
// using that body's own height/width when available, else CONFIG's.
// ---------------------------------------------------------------------------
function bodyAeroProfile(body) {
  const mem = (body && body.members) ? body.members : [];
  if (!mem.length) {
    const w = (body && Number.isFinite(body.width)) ? body.width : (CONFIG.ROCKET_WIDTH || 3.9);
    const h = (body && Number.isFinite(body.height)) ? body.height : (CONFIG.ROCKET_HEIGHT || 45);
    return {
      refWidth: w,
      members: [{ width: w, height: h, area: Math.PI * (w / 2) ** 2, baseY: 0, isTapered: true }],
    };
  }
  let refWidth = 0;
  let yOffset = 0;
  const members = mem.map(m => {
    const H = Number.isFinite(m.height) ? m.height : 0;
    const W = Number.isFinite(m.width) ? m.width : 0;
    refWidth = Math.max(refWidth, W);
    // Tapered ("nose-shaped") members get the AoA-dependent nose-term ⇄
    // cross-flow CP blend, scoped to THEIR OWN height range; a plain
    // cylindrical member (most booster/stage tanks) just uses its own
    // geometric mid-height — there's no separate nose potential-flow term
    // to blend in for a mid-stack cylindrical segment.
    const isTapered = (m.stageRole === 'nose') || (m.stageRole === 'payloadSpace');
    const out = { width: W, height: H, area: Math.PI * (W / 2) ** 2, baseY: yOffset, isTapered };
    yOffset += H;
    return out;
  });
  return { refWidth: refWidth || (CONFIG.ROCKET_WIDTH || 3.9), members };
}

function computeDragAero(s, extra) {
  const cosT = Math.cos(s.theta),
    sinT = Math.sin(s.theta);
  
  // Atmosphere co-rotates with Earth (standard assumption up to ~100 km).
  // The true atmospheric inertial velocity is (ω × r) + user-wind. Without
  // this, a rocket at rest on the pad (moving at ω·R in inertial with the
  // rotating Earth) would see ~465 m/s of phantom headwind, generating a
  // huge drag force at launch — enough to knock it off the pad instantly.
  const w = windInertialVector(s.rx, s.ry);
  const sv = earthSurfaceVelocity(s.rx, s.ry);
  const relVx = s.vx - (w.wx + sv.vx);
  const relVy = s.vy - (w.wy + sv.vy);
  
  const speedRel = Math.hypot(relVx, relVy);
  const r = Math.hypot(s.rx, s.ry);
  const altitude = altitudeFromR(r);
  const rho = airDensity(altitude);
  
  const profile = (extra && extra.aero) ? extra.aero : bodyAeroProfile(null);
  const comH = (extra && Number.isFinite(extra.comH)) ? extra.comH : 0;
  
  // Angle of attack must be known BEFORE the area is computed — a body's
  // presented frontal area is NOT the fixed nose-on circle π(W/2)² except
  // exactly at zero AoA. Tilted (or broadside/tumbling) it presents its
  // much larger rectangular SIDE silhouette (W×H) instead, growing toward
  // that as |AoA| → 90°. Reusing the same |sin(AoA)| blend factor already
  // used for the CP location keeps both effects consistent with one
  // another (both driven by how "broadside-on" the body currently is).
  //
  // AOA_NOISE_DEADBAND: a body flying with its axis and velocity exactly
  // aligned (straight ascent, no RCS/gimbal/wind input) should show EXACTLY
  // zero drag torque forever. In practice velBodyX/speedRel carries tiny
  // RK4/floating-point roundoff (~1e-14). That's normally harmless, but a
  // lighter body with less margin between its CP and COM (e.g. an upper
  // stage right after the heavier, lower booster separates) can be
  // aerodynamically unstable enough to slowly amplify that roundoff into a
  // visible spurious torque over time. Clamping anything below this
  // threshold to exactly zero stops noise from ever seeding that feedback
  // loop, while any genuine disturbance (wind, RCS, gimbal, real AoA) is
  // many orders of magnitude above it and is completely unaffected.
  const AOA_NOISE_DEADBAND = 1e-8;
  let alphaDeg = 0,
    sinAlpha = 0,
    wCross = 0;
  if (speedRel > 1e-3) {
    const velBodyX = relVx * cosT + relVy * sinT; // perpendicular to nose axis
    const rawSinAlpha = Math.max(-1, Math.min(1, velBodyX / speedRel));
    sinAlpha = Math.abs(rawSinAlpha) < AOA_NOISE_DEADBAND ? 0 : rawSinAlpha;
    alphaDeg = Math.asin(sinAlpha) * 180 / Math.PI;
    wCross = Math.min(1, Math.abs(sinAlpha));
  }
  
  // Per-member presented area, now ATTITUDE-DEPENDENT (not the old fixed
  // nose-on circle): blends from the circular end-cap area (aAxial, at
  // AoA≈0) toward the rectangular side-profile area (aSide = W×H, at
  // AoA≈90°) using wCross. A tumbling/broadside body — or discarded
  // hardware falling sideways — now correctly shows far more drag area
  // than it would nose-first, instead of the old constant πr² regardless
  // of orientation.
  let totalAeff = 0;
  const memberAeff = profile.members.map(m => {
    const aAxial = m.area; // π(W/2)² — nose-on
    const aSide = m.width * m.height; // W×H — broadside silhouette
    const aEff = aAxial * (1 - wCross) + aSide * wCross;
    totalAeff += aEff;
    return aEff;
  });
  const effectiveArea = totalAeff || (Math.PI * (profile.refWidth / 2) ** 2);
  
  const dragMag = 0.5 * rho * CONFIG.DRAG_CD * effectiveArea * speedRel * speedRel;
  const Fdx = speedRel > 0 ? -dragMag * relVx / speedRel : 0;
  const Fdy = speedRel > 0 ? -dragMag * relVy / speedRel : 0;
  
  // ---- Physical normal force (Barrowman linear + Allen-Perkins crossflow) ----
  //
  // The aero torque that rotates the rocket comes from the NORMAL force
  // (perpendicular to the body axis), not from drag. Two additive
  // contributions from two established theoretical regimes:
  //
  //  1. Barrowman linear term (potential flow, small AoA):
  //       F_lin = q · CNα · S_ref · sinα
  //     Nonzero only for tapered members (nose, fairing) — Barrowman's
  //     central result is that a smooth cylindrical body contributes ≈ 0
  //     to the normal force in the linear regime. CP sits at 0.466 × nose
  //     length from the nose base (ogive profile).
  //
  //  2. Allen-Perkins crossflow term (viscous separated flow, large AoA):
  //       F_cross = q · Cd_c · A_planform · sin²α
  //     Every member contributes via its side silhouette area (W × H).
  //     Because this scales as sin²α it is negligible at small AoA and
  //     dominates as the body turns broadside. CP sits at the planform
  //     centroid (mid-height of the member).
  //
  // Net torque about CoM = Σ_i (comH − CP_i) · F_i. No blend factor, no
  // magic constant — both regimes coexist, each weighted by its own
  // natural sinα / sin²α scaling.
  let dragTorque = 0,
    Fnormal = 0;
  if (speedRel > 1e-3) {
    const q = 0.5 * rho * speedRel * speedRel;
    const S_ref = Math.PI * (profile.refWidth / 2) ** 2;
    const sinAbs = Math.abs(sinAlpha);
    
    profile.members.forEach(m => {
      // Barrowman linear term — tapered members only.
      if (m.isTapered) {
        const F_lin = -q * AERO_CNALPHA_NOSE * S_ref * sinAlpha;
        const cpY_lin = m.baseY + m.height * AERO_CP_NOSE_LINEAR_FRAC;
        dragTorque += (comH - cpY_lin) * F_lin;
        Fnormal += F_lin;
      }
      // Allen-Perkins crossflow term — every member.
      const A_plan = m.width * m.height;
      const F_cross = -q * AERO_CD_CROSSFLOW * A_plan * sinAbs * sinAlpha;
      const cpY_cross = m.baseY + m.height * AERO_CP_BODY_FRAC;
      dragTorque += (comH - cpY_cross) * F_cross;
      Fnormal += F_cross;
    });
  }
  
  return { Fdx, Fdy, dragTorque, alphaDeg, Fnormal };
}

// Sum of a body's member heights — used as the reference length for the
// AoA/CP model above, since a discarded/staged body's own height can differ
// from the active stack's (CONFIG.ROCKET_HEIGHT reflects the active stack).
function _bodyHeightOf(body) {
  return (body && body.members && body.members.length) ?
    body.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) :
    (CONFIG.ROCKET_HEIGHT || 45);
}

// Width of THIS body's own BASE (bottom member — the part actually touching
// the ground on contact) — used for the ground-contact footprint/toppling
// check. A discarded booster or a separated stage can be a different
// diameter than the currently-active stack, so this must NOT fall back to
// the global CONFIG.ROCKET_WIDTH (which only reflects the active stack) —
// doing so previously gave every body the ACTIVE stack's footprint radius
// regardless of its own real width, silently computing its tip-over
// threshold against the wrong geometry.
function _bodyWidthOf(body) {
  const bottom = (body && body.members && body.members[0]) ? body.members[0] : null;
  if (bottom && Number.isFinite(bottom.width)) return bottom.width;
  return (body && Number.isFinite(body.width)) ? body.width : (CONFIG.ROCKET_WIDTH || 3.9);
}

function derivatives(s, extra) {
  // Use the mass currentGeometry() already computed for this body this
  // tick — NOT s.dryMass + s.fuelMass. The dryMass/fuelMass pair is only
  // correct for bodies whose members are empty (payloads, fairings fall
  // through the fallback in currentGeometry); for a body with members, the
  // real mass lives in stackMassProps()'s output, and dryMass is a stale
  // cached scalar. Reading it here previously gave M = 0 for the ejected
  // payload body (which sets dryMass = 0 at spawn), producing a
  // division-by-zero → NaN velocity → the body vanished from the sim.
  // Using geom.M keeps the integrator and the mass model in lockstep by
  // construction — the two can't disagree, ever.
  const M = extra.M;
  const grav = gravityAccel(s.rx, s.ry);
  
  const cosT = Math.cos(s.theta),
    sinT = Math.sin(s.theta);
  const Fx_i = extra.Fx * cosT - extra.Fy * sinT;
  const Fy_i = extra.Fx * sinT + extra.Fy * cosT;
  
  const aero = computeDragAero(s, extra);
  
  const ax = grav.ax + (Fx_i + aero.Fdx) / M;
  const ay = grav.ay + (Fy_i + aero.Fdy) / M;
  const alpha = (extra.torque + aero.dragTorque) / extra.I;
  
  return { vx: s.vx, vy: s.vy, ax, ay, omega: s.omega, alpha };
}

function stepState(s0, k, dt) {
  return {
    rx: s0.rx + k.vx * dt,
    ry: s0.ry + k.vy * dt,
    vx: s0.vx + k.ax * dt,
    vy: s0.vy + k.ay * dt,
    theta: s0.theta + k.omega * dt,
    omega: s0.omega + k.alpha * dt,
    dryMass: s0.dryMass,
    fuelMass: s0.fuelMass,
  };
}

// Last-tick breakdown, kept for the telemetry panel.
let lastForces = { mainFx: 0, mainFy: 0, mainTorque: 0, rcsFx: 0, rcsFy: 0, rcsTorque: 0, mdot: 0, dragFx: 0, dragFy: 0, dragTorque: 0, aoaDeg: 0 };

// ---------------------------------------------------------------------------
// Rigid-body ground contact.
//
// OLD BEHAVIOR (removed): collision was checked against a single point —
// the body's tracked origin (rx,ry), which represents the BASE CENTER.
// A nose-tip pre-check existed too, but it ran BEFORE this tick's RK4
// integration, using STALE (start-of-tick) position/rotation — so if the
// body rotated fast enough within a single tick, the nose could swing from
// "clear of the ground" to "deep underground" within that one tick, and
// nothing caught it: the post-step check only looked at the origin, which
// can still be comfortably above ground while the nose is already buried.
// That's real tunneling, not a rounding error — a fast-tumbling booster's
// nose could end up permanently embedded in the terrain.
//
// NEW BEHAVIOR: every tick, AFTER integration, four points of the body's
// actual rotated silhouette are checked — base-left corner, base-right
// corner, base-center, and the nose tip — using this tick's FINAL
// position/rotation. Whichever one is penetrating deepest is treated as
// the contact point, and the WHOLE rigid body is pushed back along that
// point's own outward normal (not the origin's) so the point that's
// actually embedded ends up exactly on the surface. This is still a
// discrete approximation (a true cylinder's closest surface point can fall
// between these four samples), but it directly closes the nose/corner
// tunneling case, which is the one that matters physically.
// ---------------------------------------------------------------------------
function _rotatedPoint(body, localX, localY) {
  // local frame: +Y = up the stack (toward the nose), +X = right,
  // origin (0,0) = base center. MUST match the up/right basis used
  // everywhere else in this file (upX=-sinθ, upY=cosθ, rightX=cosθ,
  // rightY=sinθ — see e.g. line 721, 923-924, 986-987, 1053-1054) and in
  // render.js's worldToLocal(). A stray sign flip here previously made
  // this function compute the body's nose/corner points as if it were
  // rotated by -θ instead of θ — i.e. a left-right MIRROR of the actual
  // rendered rocket whenever it wasn't perfectly upright. Ground contact
  // was therefore being resolved against the wrong corner (and pushing/
  // spinning it toward a wrong equilibrium) as soon as the body tilted at
  // all, which is why it settled at an incorrect angle instead of
  // reaching its true resting orientation.
  const cosT = Math.cos(body.theta),
    sinT = Math.sin(body.theta);
  return {
    x: body.rx + localX * cosT - localY * sinT,
    y: body.ry + localX * sinT + localY * cosT,
  };
}

function resolveGroundContact(body, groundR, geom) {
  const half = _bodyWidthOf(body) / 2;
  const H = _bodyHeightOf(body);
  
  // ---- Upright shortcut: base essentially flat on the pad ----
  // A cylindrical base resting on a curved surface touches at the tangent
  // point. When the body is aligned with local vertical, that point is
  // exactly base-center, and every other base point sits ABOVE the sphere.
  // The 4-point "lowest altitude" selection would still pick base-center
  // (correctly), but only by ~1e-9 m — which is below float64 precision at
  // r ≈ R, so the comparison flips randomly between base / baseL / baseR
  // frame-to-frame. Each flip changes the lever arm and normal direction
  // discontinuously, producing fast jitter torque and slow drift. Below a
  // small tilt threshold, force the geometry to the physical answer: base
  // center, radial normal.
  const rBody = Math.hypot(body.rx, body.ry) || 1;
  const upX = body.rx / rBody,
    upY = body.ry / rBody;
  const bodyUpX = -Math.sin(body.theta),
    bodyUpY = Math.cos(body.theta);
  const cosTilt = Math.max(-1, Math.min(1, bodyUpX * upX + bodyUpY * upY));
  const tiltRad = Math.acos(cosTilt);
  
  if (tiltRad < 0.02) { // ~1.15° threshold
    const p = _rotatedPoint(body, 0, 0);
    const alt = Math.hypot(p.x, p.y) - groundR;
    if (alt > 0) return null;
    
    const cx = p.x,
      cy = p.y;
    const nx = upX,
      ny = upY;
    const tx = -ny,
      ty = nx;
    
    const offBaseX = cx - body.rx,
      offBaseY = cy - body.ry;
    const comH = geom ? (geom.comH || 0) : 0;
    const comW = geom ? (geom.comW || 0) : 0;
    const comWorld = _rotatedPoint(body, comW, comH);
    const offX = cx - comWorld.x,
      offY = cy - comWorld.y;
    const comOffX = comWorld.x - body.rx,
      comOffY = comWorld.y - body.ry;
    
    const vpx = body.vx + body.omega * (-offBaseY);
    const vpy = body.vy + body.omega * (offBaseX);
    const sv = earthSurfaceVelocity(cx, cy);
    const vr = (vpx - sv.vx) * nx + (vpy - sv.vy) * ny;
    const vt = (vpx - sv.vx) * tx + (vpy - sv.vy) * ty;
    
    return {
      nx,
      ny,
      tx,
      ty,
      offX,
      offY,
      comOffX,
      comOffY,
      vr,
      vt,
      depth: -alt,
      contactLabel: 'base',
    };
  }
  
  // ... (existing tilted-body code — 4-point selection, unchanged)
  
  const candidates = [
    { label: 'base', p: _rotatedPoint(body, 0, 0) },
    { label: 'baseL', p: _rotatedPoint(body, -half, 0) },
    { label: 'baseR', p: _rotatedPoint(body, half, 0) },
    { label: 'nose', p: _rotatedPoint(body, 0, H) },
  ];
  
  let contact = null,
    contactAlt = Infinity;
  candidates.forEach(c => {
    const r = Math.hypot(c.p.x, c.p.y);
    const alt = r - groundR;
    if (alt < contactAlt) { contactAlt = alt;
      contact = c; }
  });
  if (contactAlt > 0) return null;
  
  const cx = contact.p.x,
    cy = contact.p.y;
  const cr = Math.hypot(cx, cy) || 1;
  const nx = cx / cr,
    ny = cy / cr;
  const tx = -ny,
    ty = nx;
  
  // Base-relative — sirf velocity-at-contact formula ke liye.
  const offBaseX = cx - body.rx,
    offBaseY = cy - body.ry;
  
  // COM-relative — impulse lever arm (I is about COM).
  const comH = geom ? (geom.comH || 0) : 0;
  const comW = geom ? (geom.comW || 0) : 0;
  const comWorld = _rotatedPoint(body, comW, comH);
  const offX = cx - comWorld.x,
    offY = cy - comWorld.y;
  const comOffX = comWorld.x - body.rx,
    comOffY = comWorld.y - body.ry;
  
  const vpx = body.vx + body.omega * (-offBaseY);
  const vpy = body.vy + body.omega * (offBaseX);
  
  // Velocity of the ROTATING ground at this contact point — subtracting it
  // yields the surface-relative velocity, which is what impact/landing
  // criteria and friction must use. Pre-fix, an upright rocket sitting
  // still on the pad was measured as having ~465 m/s of "horizontal speed"
  // against the ground, so every launch was instantly tagged as a
  // high-lateral-velocity crash the moment a contact tick happened.
  const sv = earthSurfaceVelocity(cx, cy);
  const relvx = vpx - sv.vx;
  const relvy = vpy - sv.vy;
  const vr = relvx * nx + relvy * ny;
  const vt = relvx * tx + relvy * ty;
  
  return {
    nx,
    ny,
    tx,
    ty,
    offX,
    offY,
    comOffX,
    comOffY,
    vr,
    vt,
    depth: -contactAlt, // FIX: penetration depth (positive meters)
    contactLabel: contact.label,
  };
}

// Read-only version of resolveGroundContact's point sampling — returns just
// the altitude of whichever of the body's 4 points (base-center, base-left,
// base-right, nose) is lowest, without moving anything. Used to gate the
// continuous restoring/toppling torque below on whether ANY part of the
// body is actually near the ground — not just its origin/base-CENTER,
// which rises well clear of 0.5m as soon as the body tilts even a modest
// amount (only the trailing corner stays low during a tip). Gating on the
// origin alone was silently switching the driving torque off as soon as a
// body leaned over more than a few degrees, leaving nothing to keep a
// toppling body rotating — it would just sit there until whatever residual
// spin/bounce happened to decay to ~0, at whatever angle that left it,
// instead of actually continuing to fall the way gravity would drive it.
function _lowestPointAltitude(body, groundR) {
  const half = _bodyWidthOf(body) / 2;
  const H = _bodyHeightOf(body);
  const pts = [
    _rotatedPoint(body, 0, 0),
    _rotatedPoint(body, -half, 0),
    _rotatedPoint(body, half, 0),
    _rotatedPoint(body, 0, H),
  ];
  let minAlt = Infinity;
  pts.forEach(p => {
    const alt = Math.hypot(p.x, p.y) - groundR;
    if (alt < minAlt) minAlt = alt;
  });
  return minAlt;
}

// FIX: Sleep state ko todne ka ek hi clean signal — user ne is body pe
// kuch command kiya hai ya nahi. RCS button, engine throttle/gimbal target,
// legs deploy command — inme se kuch bhi active ho to body ko wake karo.
function _bodyHasActiveInput(body) {
  if (!body) return false;
  if (body.rcsCmd) {
    for (const k in body.rcsCmd)
      if (body.rcsCmd[k]) return true;
  }
  if (body.engines) {
    for (const e of body.engines) {
      if ((e.targetMassFlowRate || 0) > 0.001) return true;
      if (Math.abs(e.targetGimbalDeg || 0) > 0.01) return true;
    }
  }
  if (body.legs) {
    const target = body.legs.deployed ? 1 : 0;
    if (Math.abs((body.legs.progress || 0) - target) > 0.001) return true;
  }
  return false;
}


function physicsStep(dt) {
  // Two-phase staging: check whether a pending separation request is
  // ready to fire (booster thrust has spooled to ~0). Runs BEFORE the
  // body loop so a completed shutdown is split on the same tick the
  // check passes — the split itself then happens through the normal
  // per-body machinery below.
  _checkPendingSeparate();
_checkPendingRelease();
  
  if (!state.bodies.length) return;
  
  state.bodies.forEach((body, idx) => {
    // ---- FIX: Sleep early-out ----
    // Ek settled body ko tab tak koi physics nahi milti jab tak user
    // koi input na de. Isse gravity-vs-impulse ka per-tick residual
    // poora khatam ho jata hai — yahi asli "zameen mein rengna" ka
    // root cause tha.
    if (body.settled) {
      if (!_bodyHasActiveInput(body)) return;
      body.settled = false;
      body._restFrames = 0;
    }
    
    const isActive = (idx === state.activeBodyIndex);
    const geom = currentGeometry(body);
    body._geomCache = geom;
    
    applyActuatorRateLimitsForBody(body, dt);
    
    const hasFuel = body.fuelMass > 0 && !body.crashed;
    const main = hasFuel ? computeMainThrustForBody(body, geom.comH) : zeroThrust();
    const rcs = hasFuel ? computeRCSForBody(body, geom.comH, dt) : zeroRCS();
    body.lastRcs = { firing: rcs.firing || {}, pod: rcs.pod || {} };
    if (!hasFuel) body.engines.forEach(e => { e.currentF = 0; });
    
    const extra = {
  Fx: 0,
  Fy: 0,
  torque: 0,
  M: geom.M, // ← add — the SAME mass currentGeometry already
  //    derived this tick, so derivatives can never
  //    disagree with it (or divide by zero)
  I: geom.I,
  comH: geom.comH,
  height: _bodyHeightOf(body),
  aero: bodyAeroProfile(body),
};
    
    // ---- Continuous ground-tip torque (pre-integration, unchanged) ----
    const groundR0 = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
    const altB = _lowestPointAltitude(body, groundR0);
    if (altB <= 0.5) {
      const localVert = Math.atan2(-body.rx, body.ry);
      const alpha = body.theta - localVert;
      if (Math.abs(alpha) > 1e-6) {
        const gLocal = gravityAccel(body.rx, body.ry).g;
        const baseR = _bodyWidthOf(body) / 2;
        const legMult = (body.legs && body.legs.progress > 0.5) ? 1.7 : 1.0;
        const effBase = baseR * legMult;
        const comOffset = geom.comH * Math.sin(alpha);
        if (Math.abs(comOffset) < effBase) {
          extra.torque += -geom.M * gLocal * comOffset;
        } else {
          const dir = Math.sign(alpha);
          const excess = Math.abs(comOffset) - effBase;
          extra.torque += geom.M * gLocal * excess * dir;
        }
      }
      body.omega *= Math.pow(0.998, dt * 60);
    }
    
    let mdotTotal = main.mdot + rcs.mdot;
    
    if (isActive) {
      if (!hasFuel) ENGINES.forEach(e => { e.currentF = 0; });
      extra.Fx += main.Fx + rcs.Fx;
      extra.Fy += main.Fy + rcs.Fy;
      extra.torque += main.torque + rcs.torque;
      mdotTotal = main.mdot + rcs.mdot;
      
      const aeroTelemetry = computeDragAero(body, extra);
      lastForces = {
        mainFx: main.Fx,
        mainFy: main.Fy,
        mainTorque: main.torque,
        rcsFx: rcs.Fx,
        rcsFy: rcs.Fy,
        rcsTorque: rcs.torque,
        mdot: mdotTotal,
        firing: rcs.firing || {},
        pod: rcs.pod || {},
        dutyTop: rcs.dutyTop || 0,
        dragTorque: aeroTelemetry.dragTorque,
        aoaDeg: aeroTelemetry.alphaDeg,
      };
    }
    
    // ---- RK4 integration ----
    const s0 = body;
    const k1 = derivatives(s0, extra);
    const s1 = stepState(s0, k1, dt / 2);
    const k2 = derivatives(s1, extra);
    const s2 = stepState(s0, k2, dt / 2);
    const k3 = derivatives(s2, extra);
    const s3 = stepState(s0, k3, dt);
    const k4 = derivatives(s3, extra);
    
    body.rx += dt / 6 * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx);
    body.ry += dt / 6 * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy);
    body.vx += dt / 6 * (k1.ax + 2 * k2.ax + 2 * k3.ax + k4.ax);
    body.vy += dt / 6 * (k1.ay + 2 * k2.ay + 2 * k3.ay + k4.ay);
    body.theta += dt / 6 * (k1.omega + 2 * k2.omega + 2 * k3.omega + k4.omega);
    body.omega += dt / 6 * (k1.alpha + 2 * k2.alpha + 2 * k3.alpha + k4.alpha);
    
    body.fuelMass = Math.max(0, body.fuelMass - mdotTotal * dt);
    
    // ---- Ground contact resolution ----
    const groundR = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
    const contact = resolveGroundContact(body, groundR, geom);
    body._lastContact = contact;
    if (!contact) {
      body._groundedFrames = 0;
      body._restFrames = 0;
      body._wasGrounded = false;
    } else {
      body._groundedFrames++;
      
      // ---- FIX: Position correction with slop + partial (Baumgarte) ----
      // 100% correction every tick is itself a source of jitter — position
      // and velocity are solved in separate passes, so exact per-tick
      // correction fights the impulse response. Allow a small permanent
      // penetration (invisible: 2cm on a 45m rocket) and correct only a
      // fraction of the excess per tick.
      const PEN_SLOP = 0.02;
      const PEN_CORRECT_FRAC = 0.6;
      const excess = contact.depth - PEN_SLOP;
      if (excess > 0) {
        body.rx += contact.nx * excess * PEN_CORRECT_FRAC;
        body.ry += contact.ny * excess * PEN_CORRECT_FRAC;
      }
      
      const descentSpeed = -contact.vr;
      const hSpeed = Math.abs(contact.vt);
      
      const rNow = Math.hypot(body.rx, body.ry) || 1;
      const ux = body.rx / rNow,
        uy = body.ry / rNow;
      const bodyUpX = -Math.sin(body.theta),
        bodyUpY = Math.cos(body.theta);
      const tiltDeg = Math.acos(Math.max(-1, Math.min(1, bodyUpX * ux + bodyUpY * uy))) * 180 / Math.PI;
      
      const noseStrike = contact.contactLabel === 'nose';
      const wasGrounded = !!body._wasGrounded;
      body._wasGrounded = true;
      const freshImpact = !wasGrounded && (noseStrike || descentSpeed > 0.3 || hSpeed > 0.3);
      
      if (freshImpact) {
        const bottomMember = (body.members && body.members[0]) ? body.members[0] : null;
        const recovery = bottomMember ?
          (bottomMember.hasRecovery === false ? null :
            ((typeof getComponentType === 'function') ? getComponentType(bottomMember.recoveryTypeId) : null)) :
          CONFIG.RECOVERY_TYPE;
        const canLandOnLegs = !!(recovery && recovery.capabilities && recovery.capabilities.deploysOnVehicle);
        let landedOk = false;
        if (canLandOnLegs && !noseStrike) {
          const minDeploy = (recovery.frame && recovery.frame.landingMinDeploy !== undefined) ?
            recovery.frame.landingMinDeploy : CONFIG.LANDING_MIN_LEG_DEPLOY;
          const bodyLegsProgress = (body.legs && Number.isFinite(body.legs.progress)) ? body.legs.progress : 0;
          const legsReady = bodyLegsProgress >= minDeploy;
          const speedOk = descentSpeed <= CONFIG.LANDING_MAX_VSPEED && hSpeed <= CONFIG.LANDING_MAX_HSPEED;
          const tiltOk = tiltDeg <= CONFIG.LANDING_MAX_TILT_DEG;
          const rateOk = Math.abs(body.omega) <= CONFIG.LANDING_MAX_OMEGA;
          landedOk = legsReady && speedOk && tiltOk && rateOk;
        }
        
        const M = geom.M,
          I = Math.max(1e-6, geom.I);
        const rCrossN = contact.offX * contact.ny - contact.offY * contact.nx;
        const K = (1 / M) + (rCrossN * rCrossN) / I;
        const RESTITUTION = 0.35;
        const e = landedOk ? 0 : RESTITUTION;
        const targetVr = landedOk ? 0 : descentSpeed * e;
        const J = (targetVr - contact.vr) / K;
        
        const dOmega = (rCrossN * J) / I;
        body.vx += (J / M) * contact.nx + dOmega * contact.comOffY;
        body.vy += (J / M) * contact.ny - dOmega * contact.comOffX;
        body.omega += dOmega;
        
        if (landedOk) {
          body.landed = true;
        } else {
          body.crashed = true;
          const GROUND_FRICTION = 0.55;
          const SPIN_DAMPING = 0.6;
          
          // Friction must reduce the SURFACE-RELATIVE tangential velocity,
          // not the inertial one. contact.vt is already surface-relative
          // (see resolveGroundContact). Applying the delta to inertial
          // vx/vy is correct because the impulse is instantaneous — the
          // rotating frame's contribution is orthogonal to the impulse.
          const vtNow = contact.vt;
          const dvtRel = vtNow * GROUND_FRICTION - vtNow;
          body.vx += dvtRel * contact.tx;
          body.vy += dvtRel * contact.ty;
          body.omega *= SPIN_DAMPING;
        }
      } else {
        // SUSTAINED contact (already touching last tick) — zero-restitution
        // constraint, every tick, regardless of instantaneous point speed.
        // No bounce, no anti-topple kick: just remove the inward normal velocity
        // at whichever point is deepest right now, so the body can't sink in.
        if (contact.vr < 0) {
          const M = geom.M,
            I = Math.max(1e-6, geom.I);
          const rCrossN = contact.offX * contact.ny - contact.offY * contact.nx;
          const K = (1 / M) + (rCrossN * rCrossN) / I;
          const J = -contact.vr / K;
          body.vx += (J / M) * contact.nx;
          body.vy += (J / M) * contact.ny;
          body.omega += (rCrossN * J) / I;
        }
        
        // ---- Pad friction — damp surface-relative tangential velocity and spin ----
        // Normal impulse (above) only cancels the inward NORMAL component of the
        // surface-relative velocity. Any residual TANGENTIAL sliding and spin are
        // left untouched. On a real pad, tiny per-tick noise sources — RK4 sub-
        // steps not seeing the contact constraint, position-correction asymmetry,
        // the rotating-frame co-rotation term shifting under the body — inject
        // ~4e-4 m/s of tangential velocity every tick. Left undamped, that
        // accumulates: 80 ticks/s × 4e-4 = ~0.03 m/s² of spurious speed, ~1e-6
        // rad/s² of spin, and eventually a visible theta drift. Observed log
        // confirms exactly this rate.
        //
        // Real launch pads have high base friction (steel-on-concrete μ ≈ 0.5),
        // killing any residual sliding within milliseconds. Model that as
        // exponential decay of the surface-relative tangential velocity and the
        // body spin, active only while grounded. NOT a hack — this is the pad's
        // friction that the impulse-only model was missing.
        const PAD_FRICTION_RATE = 8.0; // 1/s — tangential velocity decay
        const PAD_SPIN_DAMP_RATE = 6.0; // 1/s — angular velocity decay
        
        const vtRel = contact.vt;
        if (Math.abs(vtRel) > 1e-9) {
          const factor = Math.exp(-PAD_FRICTION_RATE * dt);
          const dvt = vtRel * (factor - 1);
          body.vx += dvt * contact.tx;
          body.vy += dvt * contact.ty;
        }
        // Spin must damp toward the EARTH-FIXED equilibrium, not toward zero.
        // ---- Pad hold-down constraint ----
        // A real launch pad has physical clamps that prevent the rocket from
        // rotating relative to the ground while it's sitting on the pad. Without
        // them, the discrete contact impulse (applied at the base, offset from
        // the COM by comH) generates Δω ∝ comH·sin(tilt) each tick — a positive
        // feedback loop that slowly drifts ω away from the co-rotating value
        // (−ω_earth) and lets tilt grow. Confirmed in telemetry logs: pad tilt
        // grows 0→0.0001° in 1.4 s even with no thrust input, and continues
        // growing in flight once contact ends.
        //
        // The clamps hold ω at the co-rotating equilibrium. This is the physical
        // reality of every orbital launch pad — Falcon 9, SLS, Soyuz all use them.
        const PAD_OMEGA_STIFFNESS = 40.0; // 1/s — clamp stiffness
        body.omega += (-CONFIG.EARTH_OMEGA - body.omega) * PAD_OMEGA_STIFFNESS * dt;
        // A nose touching down is always fatal, even if it only becomes the
        // deepest point partway through an already-ongoing topple.
        if (noseStrike) body.crashed = true;
      }
      
      // ---- FIX: Rest stabilization + sleep ----
      // Sustained contact ke baad bhi agar body ke paas koi significant
      // kinetic energy nahi bachi, use kinematically at-rest treat karo —
      // strong damping, phir sleep. Isse alternating contact points ka
      // residual jitter aur uski creep dono khatam ho jati hain.
      const speed = Math.hypot(body.vx, body.vy);
      const spin = Math.abs(body.omega);
      
      const restSpeedThresh = body.crashed ? 0.4 : 0.10;
      const restSpinThresh = body.crashed ? 0.05 : 0.03;
      const sleepSpeedThresh = body.crashed ? 0.4 : 0.02;
      const sleepSpinThresh = body.crashed ? 0.05 : 0.005;
      
      if (body._groundedFrames > 8 && speed < restSpeedThresh && spin < restSpinThresh) {
        body._restFrames++;
        const damp = Math.pow(0.80, dt * 60); // aggressive but stable
        body.vx *= damp;
        body.vy *= damp;
        body.omega *= damp;
        
        if (body._restFrames > 10 && speed < sleepSpeedThresh && spin < sleepSpinThresh) {
          body.vx = 0;
          body.vy = 0;
          body.omega = 0;
          if (!body.crashed) body.landed = true;
          body.settled = true;
        }
      } else {
        body._restFrames = 0;
      }
      
      // ---- Flat-fall halt ----
      // Crash ke baad agar body ~2s continuous 85°+ tilt pe padi rahe, use
      // frozen treat karo — residual jitter nahi.
      //
      // CRITICAL: state.halted sirf tab set karo jab yeh CURRENTLY-CONTROLLED
      // body ho. Baaki sab (discarded booster, spent stages, fairing halves,
      // released payloads) eventually crash hote hain aur flat padte hain —
      // un par halt karne se poora mission usi second freeze ho jaata hai
      // jaise tum "Split Fairing" karte ho (fairing halves 5 m/s drift
      // karte hain, phir crash karti hain, phir 2s flat padti hain).
      if (body.crashed && !body.settled) {
        const tiltDeg = Math.abs(body.theta - Math.atan2(body.rx, body.ry)) * 180 / Math.PI;
        if (tiltDeg > 85) {
          body._fallenFrames = (body._fallenFrames || 0) + 1;
          if (body._fallenFrames * dt > 2.0) {
            body.vx = 0;
            body.vy = 0;
            body.omega = 0;
            body.settled = true;
            if (body.isActive) state.halted = true; // ← only the controlled body halts the sim
          }
        } else {
          body._fallenFrames = 0;
        }
      }
    }
    
    // ============================================================
    // TEMPORARY DEBUG — paste at END of physicsStep's forEach loop.
    // Enable via: window.DEBUG_PHYSICS = true  (browser console)
    // ============================================================
    if (globalThis.DEBUG_PHYSICS && isActive) {
      const _tick = Math.round(state.simTime / CONFIG.DT);
      const _logEvery = Math.round(0.2 / CONFIG.DT); // every 0.1 s
      if (_tick % _logEvery === 0) {
        // Recompute aero snapshot exactly as RK4 saw it this tick.
        const _aeroLog = computeDragAero(body, extra);
        
        const _r = Math.hypot(body.rx, body.ry);
        const _alt = _r - CONFIG.EARTH_RADIUS;
        const _localVert = Math.atan2(-body.rx, body.ry);
        const _tiltDeg = (body.theta - _localVert) * 180 / Math.PI;
        
        // Relative wind the code sees
        const _sv = earthSurfaceVelocity(body.rx, body.ry);
        const _wnd = windInertialVector(body.rx, body.ry);
        const _relVx = body.vx - (_sv.vx + _wnd.wx);
        const _relVy = body.vy - (_sv.vy + _wnd.wy);
        const _speedRel = Math.hypot(_relVx, _relVy);
        const _cT = Math.cos(body.theta),
          _sT = Math.sin(body.theta);
        const _velBodyX = _relVx * _cT + _relVy * _sT;
        const _sinAlpha = _speedRel > 1e-3 ? Math.max(-1, Math.min(1, _velBodyX / _speedRel)) : 0;
        const _aoaDeg = Math.asin(_sinAlpha) * 180 / Math.PI;
        
        // Torque breakdown (all in N·m)
        const _tMain = main.torque;
        const _tRcs = rcs.torque;
        const _tDrag = _aeroLog.dragTorque;
        const _tGround = extra.torque - _tMain - _tRcs; // tip-torque added before RK4
        const _tTotal = extra.torque + _tDrag;
        const _alphaAng = _tTotal / Math.max(1e-6, geom.I);
        
        const _engStr = (body.engines || []).map(e =>
          `${e.id}(mdot=${(e.massFlowRate||0).toFixed(2)},g=${(e.gimbalDeg||0).toFixed(3)},F=${Math.round(e.currentF||0)},x=${(e.x||0).toFixed(2)})`
        ).join(' ');
        
        const _rcsActive = Object.keys(body.rcsCmd || {}).filter(k => body.rcsCmd[k]).join(',') || '—';
        
        const _c = body._lastContact;
        const _cStr = _c ?
          `contact(${_c.contactLabel}) vr=${_c.vr.toFixed(4)} vt=${_c.vt.toFixed(4)} depth=${_c.depth.toFixed(5)}` :
          'no contact';
        
        console.log(
          `[t=${state.simTime.toFixed(2)}] alt=${_alt.toFixed(2)} tilt=${_tiltDeg.toFixed(5)}° ` +
          `θ=${body.theta.toFixed(6)} ω=${body.omega.toExponential(3)} α=${_alphaAng.toExponential(3)}\n` +
          `  vRel=${_speedRel.toExponential(3)} AoA=${_aoaDeg.toFixed(4)}°\n` +
          `  τ_main=${_tMain.toExponential(3)} τ_rcs=${_tRcs.toExponential(3)} τ_drag=${_tDrag.toExponential(3)} τ_ground=${_tGround.toExponential(3)} τ_total=${_tTotal.toExponential(3)}\n` +
          `  I=${geom.I.toExponential(3)} comH=${geom.comH.toFixed(3)}\n` +
          `  engines: ${_engStr}\n` +
          `  rcs_cmd: ${_rcsActive}\n` +
          `  ${_cStr}`
        );
      }
    }
    // ============================================================
    // END DEBUG
    // ============================================================
    
    
  });
  
  // ---- Body-vs-body collision (unchanged) ----
  state.collisionPairs = (typeof broadPhaseCollisionPairs === 'function') ?
    broadPhaseCollisionPairs() :
    [];
  state.collisionContacts = (typeof narrowPhaseCollisionContacts === 'function') ?
    narrowPhaseCollisionContacts(state.collisionPairs) :
    [];
  if (typeof resolveBodyContacts === 'function') {
    resolveBodyContacts(state.collisionContacts);
  }
  
  state.simTime += dt;
}


function resetState(initialAltitude) {
  resetMerges();
  clearRCS();
  resetLegs();
  
  const phi0 = CONFIG.LAUNCH_SITE_ANGLE_0 || 0;
  const r0 = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0) + initialAltitude;
  
  const members = (typeof SIM_STACK_MEMBERS !== 'undefined' && SIM_STACK_MEMBERS.length) ?
    SIM_STACK_MEMBERS : [];
  
  const body = _makeBody();
  body.members = [...members];
  
  // Launch site is on the ROTATING Earth. At t=0 it sits at (r·sin φ0, r·cos φ0).
  body.rx = r0 * Math.sin(phi0);
  body.ry = r0 * Math.cos(phi0);
  
  // Rocket at rest on the pad → in the INERTIAL frame it moves with the pad.
  const surfV = earthSurfaceVelocity(body.rx, body.ry);
  body.vx = surfV.vx;
  body.vy = surfV.vy;
  
  // Attitude = local vertical at launch site, so rocket starts upright.
  body.theta = -phi0;
  // A body rigidly attached to the rotating Earth (pad clamps, or resting
  // with friction) inherits the Earth's angular velocity. In our sign
  // convention, upright-at-launch-site means theta = -phi, so omega must
  // equal -EARTH_OMEGA at reset.
  //
  // Initializing omega = 0 made the body sit still in the inertial frame
  // while the local vertical rotated underneath it. The growing
  // |theta - localVert| fed the tip-torque model, which then drove a
  // ~0.005° harmonic oscillation and the visible torque/omega jitter.
  body.omega = -CONFIG.EARTH_OMEGA; // was: 0
  
  body.dryMass = CONFIG.DRY_MASS;
  body.fuelMass = CONFIG.FUEL_MASS_MAX * (CONFIG.DEFAULT_FUEL_FRACTION || 1.0);
  body.isActive = true;
  body.engines = (members.length && typeof buildEnginesForRecord === 'function') ?
    buildEnginesForRecord(members[0]) : [];
  body._lastBottomMember = members.length ? members[0] : null;
  const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  body.payloadId = (stk && stk.payloadId) ? stk.payloadId : null;
  
    state.bodies = [body];
  state.activeBodyIndex = 0;
  state.simTime = 0;
  state.halted = false;
  pendingSeparate = null; // clear any mid-flight separate request
pendingRelease = null; // and any pending payload release// clear any mid-flight separate request
  resetPWM();
  }

// ---------------------------------------------------------------------------
// Two-phase separate sequence.
//

// Two-phase payload release. Same shape as the separate-stage sequence:
// command engine shutdown, then wait for thrust to drop near zero before
// actually releasing the payload. Emergency eject bypasses this (see
// emergencyEjectPayload) — it calls releasePayloadOnActiveBody directly.
function requestReleasePayload(opts) {
  opts = opts || {};
  const active = state.bodies[state.activeBodyIndex];
  if (!active) return false;
  if (active.crashed) return false;
  if (active.payloadReleased) return false;
  if (!active.payloadId) return false;
  if (pendingRelease) return false;
  if (pendingSeparate) return false;  // don't interleave with a staging sequence

  // Fairing still on? Payload is shielded — user must split fairing first
  // (or use Emergency Eject, which auto-splits).
  if (active.members && active.members.some(m => m.stageRole === 'payloadSpace')) {
    return false;
  }

  // If engines are effectively off already (coast phase — the normal time
  // to deploy), release immediately with no wait.
  let totalThrust = 0, totalMax = 0;
  (active.engines || []).forEach(e => {
    totalThrust += e.currentF || 0;
    totalMax += e.Fmax || 0;
  });
  const thrustFrac = totalMax > 0 ? totalThrust / totalMax : 0;
  if (thrustFrac < 0.005) {
    return releasePayloadOnActiveBody({ emergency: false, kick: opts.kick || 3.0 });
  }

  // Command shutdown, then defer until thrust falls below threshold.
  (active.engines || []).forEach(e => {
    e.targetMassFlowRate = 0;
  });

  pendingRelease = {
    bodyId: active.id,
    requestedAt: state.simTime,
    emergency: false,
    kick: opts.kick || 3.0,
  };
  return true;
}

function _checkPendingRelease() {
  if (!pendingRelease) return;
  const active = state.bodies[state.activeBodyIndex];

  // Body changed since request (Take Control, reset, etc.) — abort.
  if (!active || active.id !== pendingRelease.bodyId) {
    pendingRelease = null;
    return;
  }

  let totalThrust = 0, totalMax = 0;
  (active.engines || []).forEach(e => {
    totalThrust += e.currentF || 0;
    totalMax += e.Fmax || 0;
  });
  const thrustFrac = totalMax > 0 ? totalThrust / totalMax : 0;
  const elapsed = state.simTime - pendingRelease.requestedAt;

  if (thrustFrac < 0.005 || elapsed > 5.0) {
    const opts = {
      emergency: pendingRelease.emergency,
      kick: pendingRelease.kick,
    };
    pendingRelease = null;
    releasePayloadOnActiveBody(opts);
  }
}

// requestSeparate(): the user-facing entry point. Commands the booster's
// engines to zero (target, not current — the rate limiter carries the
// actual massFlowRate down over the shutdown spool duration) and records
// a pending request. The active body keeps flying as one stack until
// shutdown completes.
//
// _checkPendingSeparate(): called every physics tick. When thrust is
// effectively gone (or a safety timeout fires) it calls performSeparate()
// to actually slice members and spawn the discarded body.
//
// performSeparate(): the physical split — everything separateActiveBody()
// used to do. Called either by _checkPendingSeparate() on a successful
// shutdown, or directly by requestSeparate() when there's nothing to
// spool down (no engines, or engines already off).
// ---------------------------------------------------------------------------
function requestSeparate() {
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members || active.members.length < 2) return false;
  if (active.crashed) return false;
  if (pendingSeparate) return false; // already in flight — ignore repeat clicks
  
  // Same guard as controls.js's canSeparateNow() — the bottom and the
  // member directly above it must both be separable roles. If the member
  // above the bottom is a fairing/nose, that bottom is the LAST upper
  // stage; splitting it would leave the fairing floating alone. Defensive
  // even if the button is disabled — a race condition or programmatic
  // call shouldn't be able to trigger this state.
  const SEPARABLE = { booster: 1, stage: 1 };
  const bottom = active.members[0];
  const above = active.members[1];
  if (!(bottom && above && SEPARABLE[bottom.stageRole] && SEPARABLE[above.stageRole])) {
    return false;
  }
  // If the body has no engines at all (edge case: unusual stack), there's
  // nothing to spool down — split immediately.
  if (!active.engines || !active.engines.length) {
    return performSeparate();
  }

  // Command shutdown on all booster engines.
  active.engines.forEach(e => {
    e.targetMassFlowRate = 0;
    e.targetGimbalDeg = 0;
  });

  pendingSeparate = {
    bodyId: active.id,
    requestedAt: state.simTime,
  };
  return true;
}

// Emergency payload eject — independent of the normal separation flow.
// Always available while the active body still has an attached payload:
// splits the fairing (if one is still on) and ejects the cargo with a
// large prograde kick, regardless of what stage the stack is on. Real
// launchers carry analogous systems (launch escape towers, emergency
// deploy modes) precisely because once the rocket is failing, the only
// thing worth saving is the payload.
// Emergency payload eject — independent of the normal separation flow.
// Always available while the active body still has an attached payload.
//
// Unlike the NORMAL payload release (which splits the fairing first so a
// bare satellite deploys), emergency eject keeps the fairing CLOSED around
// the cargo. Physical rationale: the fairing is the payload's reentry
// shield — if the rocket is failing and the payload is being saved, it
// will likely reenter on its own, and a bare satellite would burn up in
// the airstream. Real escape systems deliver the payload as a single
// shielded unit for exactly this reason.
function emergencyEjectPayload() {
  const active = state.bodies[state.activeBodyIndex];
  if (!active) return false;
  if (active.crashed) return false;
  if (active.payloadReleased) return false;
  if (!active.payloadId) return false;
  
  // Find the fairing member still sitting on the active stack, if any.
  const fairingIdx = (active.members || [])
    .findIndex(m => m.stageRole === 'payloadSpace');
  const fairingMember = fairingIdx >= 0 ? active.members[fairingIdx] : null;
  
  // World-space position of the fairing/payload BASE. Members stack
  // bottom→top, so sum heights below the fairing and offset along nose.
  const upX = -Math.sin(active.theta);
  const upY = Math.cos(active.theta);
  const belowH = fairingMember ?
    active.members.slice(0, fairingIdx)
    .reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) :
    active.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0);
  const baseRx = active.rx + belowH * upX;
  const baseRy = active.ry + belowH * upY;
  
  // Slice the fairing off the active body's member list (if present).
  if (fairingIdx >= 0) {
    active.members.splice(fairingIdx, 1);
  }
  
  // Prograde kick direction. Fallback to nose axis if the active body is
  // essentially at rest (edge case: emergency eject triggered on the pad).
  const speed = Math.hypot(active.vx, active.vy);
  const ux = speed > 0.01 ? active.vx / speed : upX;
  const uy = speed > 0.01 ? active.vy / speed : upY;
  
  // Same magnitude as a real jettison system — clearly faster than the
  // normal deploy kick (~3 m/s), but not absurd.
  const KICK = 30.0;
  const SPIN = 0.05; // gentle tumble; cargo is shielded, not tumbling free
  
  // Create the ejected body. It carries:
  //   - the fairing member (if still present), so its silhouette is a
  //     closed fairing over the payload — reentry drag protection
  //   - payloadId pointing at the cargo, so the renderer keeps drawing the
  //     payload inside the fairing and a future Release Payload command
  //     can still free the satellite once it's safe to deploy
  const body = _makeBody();
  body.id = 'ejected-' + active.payloadId;
  body.members = fairingMember ? [fairingMember] : [];
  body.rx = baseRx;
  body.ry = baseRy;
  body.vx = active.vx + KICK * ux; // ADDITIVE — inherits active velocity
  body.vy = active.vy + KICK * uy;
  body.theta = active.theta;
  body.omega = SPIN;
  body.dryMass = 0; // derived from members on next tick
  body.fuelMass = 0;
  body.isActive = false;
  body.isDiscarded = true;
  body.bornAt = state.simTime;
  body.collisionGracePeriod = 1.5;
  body.payloadId = active.payloadId;
  body.payloadReleased = false;
  body.emergencyEject = true;
  body.rcsCmd = (typeof _blankRcsCmd === 'function') ? _blankRcsCmd() : null;
  
  state.bodies.push(body);
  
  // The active body no longer carries cargo.
  active.payloadId = null;
  active.payloadReleased = true;
  
  // Rebuild the active body's engines if we removed its bottom member
  // (edge case: active stack was only [fairing]? Can't happen — fairing
  // is never at the bottom of a stack — so this only fires when there are
  // still members above. Rebuild is defensive.)
  if (typeof rebuildEnginesForBody === 'function') {
    rebuildEnginesForBody(active);
  }
  
  // Visual flash at the eject point.
  separationFlashId++;
  separationFlash = {
    id: separationFlashId,
    rx: baseRx,
    ry: baseRy,
    t0Real: performance.now(),
  };
  
  return true;
}
// Cancel any in-flight two-phase sequence. Called when the user issues a
// NEW thrust/gimbal command while a shutdown-and-split or shutdown-and-
// release sequence is pending. Without this, a MAX-throttle click during
// the 1.2 s spool-down window silently overrode the shutdown command, the
// thrust threshold never fell, the 5 s safety timeout eventually fired,
// and the split happened with engines at full throttle — reinstating the
// original "separation with engines firing" collision bug.
//
// The cancel is the physically correct outcome: a user re-commanding
// thrust is telling the sim "abort the sequence". Any input that would
// make the pending completion condition unreachable must clear the intent.
function cancelPendingSequences() {
  pendingSeparate = null;
  pendingRelease = null;
}
function _checkPendingSeparate() {
  if (!pendingSeparate) return;
  const active = state.bodies[state.activeBodyIndex];

  // Active body changed since the request (user did something else — took
  // control of another body, reset, etc.). Silently abort. The old body's
  // targets are already zeroed from requestSeparate(), so its engines
  // spool down on their own; the split simply doesn't happen.
  if (!active || active.id !== pendingSeparate.bodyId) {
    pendingSeparate = null;
    return;
  }

  let currentThrust = 0, maxThrust = 0;
  (active.engines || []).forEach(e => {
    currentThrust += e.currentF || 0;
    maxThrust += e.Fmax || 0;
  });
  const thrustFrac = maxThrust > 0 ? currentThrust / maxThrust : 0;
  const elapsed = state.simTime - pendingSeparate.requestedAt;

  // Split when thrust is effectively gone (<0.5% of max) OR after a
  // safety timeout. At full-thrust shutdown spool (~1.2 s to zero) the
  // thrust threshold fires well inside ~1.2 s; the 5 s timeout is a very
  // wide margin that should never fire in practice — it exists only so a
  // stuck engine state can't leave the split pending forever.
  if (thrustFrac < 0.005 || elapsed > 5.0) {
    pendingSeparate = null;
    performSeparate();
  }
}
 
 
// H2a-2: split the active body. Bottom member detaches as a new discarded
// body (same position/velocity, will free-fall in H2b); remaining members
// stay on the active body. Engines rebuild so thrust follows the new bottom.
//
// Renamed from separateActiveBody(): this is now the SECOND phase of the
// two-phase sequence. Call requestSeparate() (or _checkPendingSeparate())
// to trigger it; do not call this directly from user commands.
function performSeparate() {
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members || active.members.length < 2) return false;
  if (active.crashed) return false;
  
  const bottomMember = active.members[0];
  const remaining = active.members.slice(1);
  
  const activeMax = Math.max(1, memberMaxFuel(remaining[0]) || 0);
  const discMax = Math.max(1, memberMaxFuel(bottomMember) || 0);
  const sumMax = activeMax + discMax;
  const totalFuel = Number.isFinite(active.fuelMass) ? active.fuelMass : 0;
  const activeFuel = totalFuel * (activeMax / sumMax);
  const discFuel = Math.max(0, totalFuel - activeFuel);
  
  const activeProps = stackMassProps(remaining, activeFuel, legs.progress, _bodyPayloadMass(active));
  const discProps = stackMassProps([bottomMember], discFuel, 0);
  
  const discarded = _makeBody();
  discarded.id = 'discarded-' + bottomMember.id;
  discarded.members = [bottomMember];
  discarded.engines = (typeof buildEnginesForRecord === 'function') ?
    buildEnginesForRecord(bottomMember) : [];
  
  // PART B: buildEnginesForRecord() always returns fresh engines at rest
  // (massFlowRate 0) — starting the discarded booster there is exactly
  // the "instant cutoff" discontinuity this fixes. `active.engines` at
  // this point is still the OLD, pre-separation array, built from this
  // same bottomMember, so slot ids line up 1:1 with the newly built
  // discarded.engines. Copy across whatever thrust state the booster
  // actually had the instant before separation, then COMMAND shutdown
  // (target 0) rather than snapping the state itself to 0 — the shutdown
  // spool in applyActuatorRateLimitsForBody carries it down over ~1.2 s.
  // The booster was already commanded to zero and spooled down during
// the two-phase wait (see requestSeparate / _checkPendingSeparate), so
// the discarded body's engines simply start at rest — buildEnginesForRecord
// already returns them at massFlowRate 0. No state copy needed. This
// also handles the case where the split fired immediately because the
// engines were already off — same "start at rest" outcome.
discarded.engines.forEach(e => {
  e.targetMassFlowRate = 0;
  e.targetGimbalDeg = 0;
});
  
  discarded.rx = active.rx;
  discarded.ry = active.ry;
  discarded.vx = active.vx;
  discarded.vy = active.vy;
  discarded.theta = active.theta;
  discarded.omega = active.omega;
  discarded.dryMass = Number.isFinite(discProps.dryMass) ? discProps.dryMass : 0;
  discarded.fuelMass = discFuel;
  discarded.isActive = false;
  discarded.isDiscarded = true;
  discarded.isDiscarded = true;
  discarded.bornAt = state.simTime;
  discarded.collisionGracePeriod = 1.0; // ← ye add karo
  if (typeof ensureRcsState === 'function') ensureRcsState(discarded);
  discarded.payloadId = null; // ← add — booster detach hote hi payload chhod deta hai
  
  active.members = remaining;
  active.dryMass = Number.isFinite(activeProps.dryMass) ? activeProps.dryMass : 0;
  active.fuelMass = activeFuel;
  
  // Offset the stage upward along the body's own nose axis by the booster's
  // height, so the stage's BASE sits exactly where its base was before
  // separation. Camera follows active → appears to pan up; discarded booster
  // visually falls away in screen space.
  const upX = -Math.sin(active.theta);
  const upY = Math.cos(active.theta);
  const boosterHeight = Number.isFinite(bottomMember.height) ? bottomMember.height : 0;
  active.rx = active.rx + boosterHeight * upX;
  active.ry = active.ry + boosterHeight * upY;
  
  
  // Flash id increments on each new event — the render worker uses it to
  // detect "this is a NEW flash, start my local timer". Worker sends the
  // flash in every snapshot until expiry; render worker ignores snapshots
  // with the same id.
  separationFlashId++;
  separationFlash = {
    id: separationFlashId,
    rx: active.rx,
    ry: active.ry,
    t0Real: performance.now(), // worker-local real time, for worker expiry
  };
  
  state.bodies.push(discarded);
  rebuildEnginesForBody(active);
  return true;
}


// Take user control of any body (usually a discarded booster, so the user
// can fire its RCS / deploy its legs / land it). Resets actuators so the
// new active body starts with engines off, gimbals centered, RCS idle.
function takeControlOfBody(idx) {
  if (idx < 0 || idx >= state.bodies.length) return false;
  if (idx === state.activeBodyIndex) return false;
  
  // Clear actuator state on the OLD active body's engines. Only the
  // TARGETS are zeroed, not the current massFlowRate directly — the old
  // body keeps ticking through physicsStep() after losing control (it's
  // still falling/flying), so its existing rate limiter (with the
  // shutdown-spool duration, see applyActuatorRateLimitsForBody) carries
  // it down to zero smoothly instead of an instant cutoff.
  const old = state.bodies[state.activeBodyIndex];
  if (old && old.engines) {
    old.engines.forEach(e => {
      e.targetMassFlowRate = 0;
      e.targetGimbalDeg = 0;
    });
  }
  
  // Flip active flags.
  // Abort any in-flight separate request — the user has just moved control
// to a different body. The old body's targets were already zeroed by
// requestSeparate() if one was pending, so its engines still spool down
// cleanly on their own; the split itself simply never fires.
pendingSeparate = null;
pendingRelease = null;

// Flip active flags.
if (old) old.isActive = false;
state.activeBodyIndex = idx;
  const next = state.bodies[idx];
  next.isActive = true;
  
  // Rebuild ENGINES from the new body's bottom member.
  
  
  // Camera follows the new active by default.
  if (typeof camera !== 'undefined') {
    camera.followBodyIndex = idx;
    camera.follow = true;
  }
  return true;
}

// I-d1: split the payloadSpace member off the active body into two
// half-shell discarded bodies (clamshell). Removes the fairing from the
// active body's members; keeps payloadId untouched (payload releases
// later, in I-d2).
// A2 CLEANUP: lastFairingSplit removed — it was written on every split but
// never read anywhere in the codebase.

function splitFairingOnActiveBody() {
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members) return false;
  const psIdx = active.members.findIndex(m => m.stageRole === 'payloadSpace');
  if (psIdx < 0) return false;
  
  const psRec = active.members[psIdx];
  
  // World-space position of the fairing's BASE. Members stack bottom → top,
  // so sum the heights of every member below the fairing, offset upward
  // along the body's nose axis.
  const upX = -Math.sin(active.theta);
  const upY = Math.cos(active.theta);
  const belowH = active.members.slice(0, psIdx)
    .reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0);
  const baseRx = active.rx + belowH * upX;
  const baseRy = active.ry + belowH * upY;
  
  // Remove fairing from active body.
  active.members.splice(psIdx, 1);
  
  // Two half-shell bodies: left + right. Each carries just the fairing's
  // mass/2 for now; motion is a simple outward drift + slow tumble.
  const psMass = (typeof computePayloadSpaceDryMass === 'function') ? computePayloadSpaceDryMass(psRec) : 0;
  const halfMass = psMass / 2;
  
  const sideVecX = Math.cos(active.theta); // local +X (right)
  const sideVecY = Math.sin(active.theta); // m/s outward kick
  const spinSpeed = 0.4; // rad/s tumble
  
  const pushSpeed = 5; // m/s screen-horizontal outward
  
  [1, -1].forEach(side => {
    const half = _makeBody();
    half.id = 'fairing-' + side + '-' + Date.now().toString(36);
    half.members = [];
    half.rx = baseRx;
    half.ry = baseRy;
    // Screen-X always points right; this is more intuitive than world-frame
    // theta rotation for the "fairing petals out" moment.
    half.vx = active.vx + side * pushSpeed;
    half.vy = active.vy;
    half.theta = active.theta;
    half.omega = side * -0.2;
    half.dryMass = halfMass;
    half.fuelMass = 0;
    half.isActive = false;
    half.isDiscarded = true;
    half.bornAt = state.simTime;
    half.collisionGracePeriod = 1.0; // ← ye add karo (fairing halves already have 5 m/s kick)
    half.fairingHalf = { record: psRec, side };
    state.bodies.push(half);
  });
  
  // Rebuild ENGINES (bottom member may have changed if fairing was on top
  // — actually bottom unchanged here, but safe to call).
  rebuildEnginesForBody(active);
  
  return true;
}


// I-d2: release the payload from the active body. Prereq: fairing already
// split (no payloadSpace in members) AND the active stack has a payloadId.
// Payload becomes its own free body with a prograde kick + slight spin.
let lastPayloadRelease = null;
let lastPayloadReleaseId = 0;

function releasePayloadOnActiveBody(opts) {
  opts = opts || {};
  const emergency = !!opts.emergency;
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members) return false;
  if (active.members.some(m => m.stageRole === 'payloadSpace')) return false; // fairing still on
  if (active.payloadReleased) return false;
  
  if (!active.payloadId) return false;
  const pl = (typeof getPayload === 'function') ? getPayload(active.payloadId) : null;
  if (!pl) return false;
  
  // Spawn the payload ABOVE the rocket's tip with a small clear gap, so its
  // collision capsule begins at least one rocket-radius clear of the rocket's
  // capsule nose. Without this gap, the payload is born overlapping the
  // rocket's capsule; once the grace period expires, every tick's collision
  // resolution pushes it out a few cm, gravity + rocket acceleration pull it
  // back in, and the payload visibly "crawls" along the rocket surface
  // instead of separating cleanly. Real spring-based separation systems
  // physically push the payload clear before release for the same reason.
  const upX = -Math.sin(active.theta);
  const upY = Math.cos(active.theta);
  const totalH = active.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0);
  const clearGap = (CONFIG.ROCKET_WIDTH || 3.9) / 2;
  const payloadRx = active.rx + (totalH + clearGap) * upX;
  const payloadRy = active.ry + (totalH + clearGap) * upY;
  
  // Prograde kick. 0.5 m/s was far too weak: a thrusting rocket accelerates
  // at 10–20 m/s², which closes that gap in ~0.03 s. Bump to a spring-
  // separation-class value (real systems give 1–2 m/s; visually 3 m/s reads
  // cleanly even for a fast-launching stack).
  const speed = Math.hypot(active.vx, active.vy);
  const ux = speed > 0.01 ? active.vx / speed : upX;
  const uy = speed > 0.01 ? active.vy / speed : upY;
  const KICK = emergency ? (opts.kick || 20.0) : 3.0;
const SPIN = emergency ? 0.5 : 0.15;
  
  const body = _makeBody();
  body.id = 'payload-' + pl.id;
  body.members = [];
  body.rx = payloadRx;
  body.ry = payloadRy;
  body.vx = active.vx + KICK * ux;
  body.vy = active.vy + KICK * uy;
  body.theta = active.theta;
  body.omega = SPIN;
  body.dryMass = Number.isFinite(pl.mass) ? pl.mass : 0;
  body.fuelMass = 0;
  body.isActive = false;
  body.isDiscarded = true;
  body.bornAt = state.simTime;
  body.collisionGracePeriod = 1.5; // ← ye add karo
  body.payloadBody = { record: pl }; // render marker
  body.emergencyEject = emergency;   // render/cue can key off this later
  state.bodies.push(body);
  active.payloadReleased = true;
  active.payloadReleased = true;
  active.payloadId = null; // ← add
  
  lastPayloadReleaseId++;
  lastPayloadRelease = {
    id: lastPayloadReleaseId,
    rx: payloadRx,
    ry: payloadRy,
    ux,
    uy, // prograde unit vector for the arrow direction
    t0Real: performance.now(),
  };
  return true;
}