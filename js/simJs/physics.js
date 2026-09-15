// ============================================================================
// physics.js — Rigid-body state, RK4 integration, force/torque composition.
//
// State is (rx, ry, vx, vy, theta, omega):
//   rx, ry   — position, EARTH-CENTERED inertial frame (meters)
//   vx, vy   — velocity, same frame
//   theta    — vehicle attitude, INERTIAL frame angle (radians)
//   omega    — angular velocity (rad/s)
// Attitude is intentionally kept in a fixed inertial frame rather than
// "relative to local vertical" — the rotational dynamics (torque/inertia)
// don't care about position, and local-vertical is only needed for display
// and for deciding "which way is up" when converting to the local flat
// rendering frame. This keeps the rotational math completely standard.
// ============================================================================

// H1a: state now holds an array of bodies. Right now there's exactly one
// body (the whole stack). The getters/setters below proxy the OLD flat
// names (state.rx, state.fuelMass, etc.) to the ACTIVE body, so every
// existing reader/writer in physics.js / controls.js / render.js /
// telemetry.js keeps working unchanged. H1b/H2 will grow to multiple
// bodies without touching those files.

// H2a-2: derive per-engine values from a specific record's engineThrusters.
// Used when the active body's bottom member changes after separation.


// H4: separation flash. When separateActiveBody() runs, store the world
// position and a timestamp; render.js draws an expanding ring for ~0.35s.
let separationFlash = null;


function computeEngineParamsForRecord(rec) {
  const layout = (typeof getComponentType === 'function') ? getComponentType(rec.engineTypeId) : null;
  if (!layout || !layout.frame) return null;
  const groups = engineThrusterGroups(layout);
  let totalThrust = 0, totalEngines = 0, sumFlow = 0, sumFlowVe = 0;
  Object.keys(groups).forEach(gk => {
    const g = rec.engineThrusters && rec.engineThrusters[gk];
    if (!g) return;
    const t = getComponentType(g.thrusterTypeId);
    if (!t) return;
    const ve = t.parameterSchema.find(p => p.key === 've').value;
    const count = groups[gk].length;
    totalThrust += g.massFlowRate * ve * count;
    totalEngines += count;
    sumFlow += g.massFlowRate * count;
    sumFlowVe += g.massFlowRate * ve * count;
  });
  return {
    layout,
    engineFMax: totalEngines > 0 ? totalThrust / totalEngines : 0,
    engineVe: sumFlow > 0 ? sumFlowVe / sumFlow : 0,
    octaRadius: (rec.params && Number.isFinite(rec.params.octaRadius)) ? rec.params.octaRadius : CONFIG.OCTA_RADIUS,
  };
}

// H2a-2: rebuild the global ENGINES[] to match a body's CURRENT bottom
// member. Called after separation, so thrust/gimbal follow the new bottom.
function rebuildEnginesForBody(body) {
  if (!body || !body.members || !body.members.length) return;
  body.engines = (typeof buildEnginesForRecord === 'function') ?
    buildEnginesForRecord(body.members[0]) : [];
}

function _makeBody() {
  return {
    id: 'body-' + Math.random().toString(36).slice(2, 6),
    members: [],
    rx: 0, ry: 0, vx: 0, vy: 0,
    theta: 0, omega: 0,
    dryMass: 0,
    fuelMass: 0,
    crashed: false,
    landed: false,
    settled: false,
    _wasGrounded: false,
    _groundedFrames: 0,   // FIX: consecutive ticks in contact
    _restFrames: 0,       // FIX: consecutive ticks near-zero KE while grounded
    isActive: false,
    isDiscarded: false,
    payloadId: null,
    payloadReleased: false,
    legs: { deployed: false, progress: 0 },
    engines: [],
    rcsCmd: (typeof _blankRcsCmd === 'function') ? _blankRcsCmd() : { N:false,S:false,E:false,W:false,NE:false,NW:false,SE:false,SW:false,CW:false,ACW:false },
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
  const PROXY_KEYS = ['rx','ry','vx','vy','theta','omega','dryMass','fuelMass','crashed','landed'];
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
    const maxDelta = CONFIG.ENGINE_THRUST_RATE * dt;
    const tgt = e.targetThrottle !== undefined ? e.targetThrottle : e.throttle;
    if (tgt > e.throttle) e.throttle = Math.min(tgt, e.throttle + maxDelta);
    else e.throttle = Math.max(tgt, e.throttle - maxDelta);
    e.throttle = Math.max(0, Math.min(1, e.throttle));
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
  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  body.engines.forEach(e => {
    if (e.throttle <= 0) { e.currentF = 0; return; }
    const F = e.Fmin + e.throttle * (e.Fmax - e.Fmin);
    e.currentF = F;
    const gRad = (e.gimbal ? e.gimbalDeg : 0) * Math.PI / 180;
    const fx = F * Math.sin(gRad);
    const fy = F * Math.cos(gRad);
    Fx += fx; Fy += fy;
    torque += e.x * fy - (-comH) * fx;
    mdot += F / e.Ve;
  });
  return { Fx, Fy, torque, mdot };
}
// Backwards-compat shim: any leftover caller using the old name routes to
// the active body's engine array.
function computeMainThrust(comH) {
  const body = state.bodies && state.bodies[state.activeBodyIndex];
  return computeMainThrustForBody(body, comH);
}

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
  const cosT = Math.cos(s.theta), sinT = Math.sin(s.theta);
  const w = windInertialVector(s.rx, s.ry);
  const relVx = s.vx - w.wx, relVy = s.vy - w.wy;
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
  let alphaDeg = 0, sinAlpha = 0, wCross = 0;
  if (speedRel > 1e-3) {
    const velBodyX = relVx * cosT + relVy * sinT;   // perpendicular to nose axis
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
    const aAxial = m.area;                    // π(W/2)² — nose-on
    const aSide = m.width * m.height;         // W×H — broadside silhouette
    const aEff = aAxial * (1 - wCross) + aSide * wCross;
    totalAeff += aEff;
    return aEff;
  });
  const effectiveArea = totalAeff || (Math.PI * (profile.refWidth / 2) ** 2);

  const dragMag = 0.5 * rho * CONFIG.DRAG_CD * effectiveArea * speedRel * speedRel;
  const Fdx = speedRel > 0 ? -dragMag * relVx / speedRel : 0;
  const Fdy = speedRel > 0 ? -dragMag * relVy / speedRel : 0;

  let dragTorque = 0, Fnormal = 0;
  if (speedRel > 1e-3) {
    // Total drag force is anti-parallel to relative velocity in BOTH
    // frames (rotation preserves anti-parallel relationship), so its
    // body-frame lateral ("normal") component shares the same ratio.
    Fnormal = -dragMag * sinAlpha;

    // Distribute the net normal force across members proportional to each
    // member's OWN (attitude-dependent) presented area, and apply each
    // share at that member's OWN local centroid (absolute Y from the
    // body's base) — summed to get the net torque. This is the
    // "connected stack" case: every body (even one, e.g. a single
    // released stage) contributes its own real drag+torque at its own
    // CP, exactly like a separate free body would, and when several
    // members ARE connected their individual contributions simply sum —
    // no separate code path needed for "connected" vs "separated", since
    // a separated body is just a body with fewer members in this list.
    const totalArea = totalAeff || 1;
    profile.members.forEach((m, i) => {
      const share = memberAeff[i] / totalArea;
      const localFrac = m.isTapered
        ? AERO_CP_NOSE_FRAC * (1 - wCross) + AERO_CP_BODY_FRAC * wCross
        : AERO_CP_BODY_FRAC;
      const cpY = m.baseY + m.height * localFrac;
      const FnormalShare = Fnormal * share;
      // Torque of a lateral force FnormalShare applied at (0, cpY) about
      // the COM at (0, comH): torque = rx*Fy - ry*Fx, with rx=0,
      // ry=(cpY-comH), Fy=0, Fx=FnormalShare → torque = -(cpY-comH)*F.
      dragTorque += (comH - cpY) * FnormalShare;
    });
  }

  return { Fdx, Fdy, dragTorque, alphaDeg, Fnormal };
}

// Sum of a body's member heights — used as the reference length for the
// AoA/CP model above, since a discarded/staged body's own height can differ
// from the active stack's (CONFIG.ROCKET_HEIGHT reflects the active stack).
function _bodyHeightOf(body) {
  return (body && body.members && body.members.length)
    ? body.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0)
    : (CONFIG.ROCKET_HEIGHT || 45);
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
  const M = s.dryMass + s.fuelMass;
  const grav = gravityAccel(s.rx, s.ry);

  const cosT = Math.cos(s.theta), sinT = Math.sin(s.theta);
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
    rx: s0.rx + k.vx * dt, ry: s0.ry + k.vy * dt,
    vx: s0.vx + k.ax * dt, vy: s0.vy + k.ay * dt,
    theta: s0.theta + k.omega * dt, omega: s0.omega + k.alpha * dt,
    dryMass: s0.dryMass, fuelMass: s0.fuelMass,
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
  const cosT = Math.cos(body.theta), sinT = Math.sin(body.theta);
  return {
    x: body.rx + localX * cosT - localY * sinT,
    y: body.ry + localX * sinT + localY * cosT,
  };
}

function resolveGroundContact(body, groundR, geom) {
  const half = _bodyWidthOf(body) / 2;
  const H = _bodyHeightOf(body);

  const candidates = [
    { label: 'base',  p: _rotatedPoint(body, 0, 0) },
    { label: 'baseL', p: _rotatedPoint(body, -half, 0) },
    { label: 'baseR', p: _rotatedPoint(body, half, 0) },
    { label: 'nose',  p: _rotatedPoint(body, 0, H) },
  ];

  let contact = null, contactAlt = Infinity;
  candidates.forEach(c => {
    const r = Math.hypot(c.p.x, c.p.y);
    const alt = r - groundR;
    if (alt < contactAlt) { contactAlt = alt; contact = c; }
  });
  if (contactAlt > 0) return null;

  const cx = contact.p.x, cy = contact.p.y;
  const cr = Math.hypot(cx, cy) || 1;
  const nx = cx / cr, ny = cy / cr;
  const tx = -ny, ty = nx;

  // Base-relative — sirf velocity-at-contact formula ke liye.
  const offBaseX = cx - body.rx, offBaseY = cy - body.ry;

  // COM-relative — impulse lever arm (I is about COM).
  const comH = geom ? (geom.comH || 0) : 0;
  const comW = geom ? (geom.comW || 0) : 0;
  const comWorld = _rotatedPoint(body, comW, comH);
  const offX = cx - comWorld.x, offY = cy - comWorld.y;
  const comOffX = comWorld.x - body.rx, comOffY = comWorld.y - body.ry;

  const vpx = body.vx + body.omega * (-offBaseY);
  const vpy = body.vy + body.omega * (offBaseX);
  const vr = vpx * nx + vpy * ny;
  const vt = vpx * tx + vpy * ty;

  return {
    nx, ny, tx, ty,
    offX, offY,
    comOffX, comOffY,
    vr, vt,
    depth: -contactAlt,      // FIX: penetration depth (positive meters)
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
    for (const k in body.rcsCmd) if (body.rcsCmd[k]) return true;
  }
  if (body.engines) {
    for (const e of body.engines) {
      if ((e.targetThrottle || 0) > 0.001) return true;
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
    const rcs  = hasFuel ? computeRCSForBody(body, geom.comH, dt) : zeroRCS();
    body.lastRcs = { firing: rcs.firing || {}, pod: rcs.pod || {} };
    if (!hasFuel) body.engines.forEach(e => { e.currentF = 0; });

    const extra = {
      Fx: 0, Fy: 0, torque: 0,
      I: geom.I,
      comH: geom.comH,
      height: _bodyHeightOf(body),
      aero: bodyAeroProfile(body),
    };

    // ---- Continuous ground-tip torque (pre-integration, unchanged) ----
    const groundR0 = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
    const altB = _lowestPointAltitude(body, groundR0);
    if (altB <= 0.5) {
      const localVert = Math.atan2(body.rx, body.ry);
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
        mainFx: main.Fx, mainFy: main.Fy, mainTorque: main.torque,
        rcsFx: rcs.Fx, rcsFy: rcs.Fy, rcsTorque: rcs.torque,
        mdot: mdotTotal, firing: rcs.firing || {}, pod: rcs.pod || {},
        dutyTop: rcs.dutyTop || 0,
        dragTorque: aeroTelemetry.dragTorque, aoaDeg: aeroTelemetry.alphaDeg,
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

    body.rx    += dt / 6 * (k1.vx    + 2 * k2.vx    + 2 * k3.vx    + k4.vx);
    body.ry    += dt / 6 * (k1.vy    + 2 * k2.vy    + 2 * k3.vy    + k4.vy);
    body.vx    += dt / 6 * (k1.ax    + 2 * k2.ax    + 2 * k3.ax    + k4.ax);
    body.vy    += dt / 6 * (k1.ay    + 2 * k2.ay    + 2 * k3.ay    + k4.ay);
    body.theta += dt / 6 * (k1.omega + 2 * k2.omega + 2 * k3.omega + k4.omega);
    body.omega += dt / 6 * (k1.alpha + 2 * k2.alpha + 2 * k3.alpha + k4.alpha);

    body.fuelMass = Math.max(0, body.fuelMass - mdotTotal * dt);

    // ---- Ground contact resolution ----
    const groundR = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
    const contact = resolveGroundContact(body, groundR, geom);

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
      const ux = body.rx / rNow, uy = body.ry / rNow;
      const bodyUpX = -Math.sin(body.theta), bodyUpY = Math.cos(body.theta);
      const tiltDeg = Math.acos(Math.max(-1, Math.min(1, bodyUpX * ux + bodyUpY * uy))) * 180 / Math.PI;

      const noseStrike = contact.contactLabel === 'nose';
      const wasGrounded = !!body._wasGrounded;
      body._wasGrounded = true;
      const freshImpact = !wasGrounded && (noseStrike || descentSpeed > 0.3 || hSpeed > 0.3);

      if (freshImpact) {
        const bottomMember = (body.members && body.members[0]) ? body.members[0] : null;
        const recovery = bottomMember
          ? (bottomMember.hasRecovery === false ? null
             : ((typeof getComponentType === 'function') ? getComponentType(bottomMember.recoveryTypeId) : null))
          : CONFIG.RECOVERY_TYPE;
        const canLandOnLegs = !!(recovery && recovery.capabilities && recovery.capabilities.deploysOnVehicle);
        let landedOk = false;
        if (canLandOnLegs && !noseStrike) {
          const minDeploy = (recovery.frame && recovery.frame.landingMinDeploy !== undefined)
            ? recovery.frame.landingMinDeploy : CONFIG.LANDING_MIN_LEG_DEPLOY;
          const bodyLegsProgress = (body.legs && Number.isFinite(body.legs.progress)) ? body.legs.progress : 0;
          const legsReady = bodyLegsProgress >= minDeploy;
          const speedOk = descentSpeed <= CONFIG.LANDING_MAX_VSPEED && hSpeed <= CONFIG.LANDING_MAX_HSPEED;
          const tiltOk  = tiltDeg <= CONFIG.LANDING_MAX_TILT_DEG;
          const rateOk  = Math.abs(body.omega) <= CONFIG.LANDING_MAX_OMEGA;
          landedOk = legsReady && speedOk && tiltOk && rateOk;
        }

        const M = geom.M, I = Math.max(1e-6, geom.I);
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
          const vtNow = body.vx * contact.tx + body.vy * contact.ty;
          const dvt = vtNow * GROUND_FRICTION - vtNow;
          body.vx += dvt * contact.tx;
          body.vy += dvt * contact.ty;
          body.omega *= SPIN_DAMPING;
        }
      } else {
        // Sustained contact — non-bouncing constraint.
        if (contact.vr < 0) {
          const M = geom.M, I = Math.max(1e-6, geom.I);
          const rCrossN = contact.offX * contact.ny - contact.offY * contact.nx;
          const K = (1 / M) + (rCrossN * rCrossN) / I;
          const J = -contact.vr / K;

          const dOmega = (rCrossN * J) / I;
          body.vx += (J / M) * contact.nx + dOmega * contact.comOffY;
          body.vy += (J / M) * contact.ny - dOmega * contact.comOffX;
          body.omega += dOmega;
        }
        if (noseStrike) body.crashed = true;
      }

      // ---- FIX: Rest stabilization + sleep ----
      // Sustained contact ke baad bhi agar body ke paas koi significant
      // kinetic energy nahi bachi, use kinematically at-rest treat karo —
      // strong damping, phir sleep. Isse alternating contact points ka
      // residual jitter aur uski creep dono khatam ho jati hain.
      const speed = Math.hypot(body.vx, body.vy);
      const spin  = Math.abs(body.omega);

      const restSpeedThresh = body.crashed ? 0.4  : 0.10;
      const restSpinThresh  = body.crashed ? 0.05 : 0.03;
      const sleepSpeedThresh = body.crashed ? 0.4  : 0.02;
      const sleepSpinThresh  = body.crashed ? 0.05 : 0.005;

      if (body._groundedFrames > 8 && speed < restSpeedThresh && spin < restSpinThresh) {
        body._restFrames++;
        const damp = Math.pow(0.80, dt * 60); // aggressive but stable
        body.vx *= damp;
        body.vy *= damp;
        body.omega *= damp;

        if (body._restFrames > 10 && speed < sleepSpeedThresh && spin < sleepSpinThresh) {
          body.vx = 0; body.vy = 0; body.omega = 0;
          if (!body.crashed) body.landed = true;
          body.settled = true;
        }
      } else {
        body._restFrames = 0;
      }

// ---- NEW: flat-fall halt ----
// Crash ke baad agar body ~2s continuous 85°+ tilt pe padi rahe
// (matlab "gir gayi"), use freeze karke sim halt kar do — residual
// torque/omega churn ka koi fayda nahi, bas rengna band ho jata hai.
if (body.crashed && !body.settled) {
  const tiltDeg = Math.abs(body.theta - Math.atan2(body.rx, body.ry)) * 180 / Math.PI;
  if (tiltDeg > 85) {
    body._fallenFrames = (body._fallenFrames || 0) + 1;
    if (body._fallenFrames * dt > 0.5) {
      body.vx = 0; body.vy = 0; body.omega = 0;
      body.settled = true;
      state.halted = true;
    }
  } else {
    body._fallenFrames = 0;
  }
}
    }
  });

  // ---- Body-vs-body collision (unchanged) ----
  state.collisionPairs = (typeof broadPhaseCollisionPairs === 'function')
    ? broadPhaseCollisionPairs()
    : [];
  state.collisionContacts = (typeof narrowPhaseCollisionContacts === 'function')
    ? narrowPhaseCollisionContacts(state.collisionPairs)
    : [];
  if (typeof resolveBodyContacts === 'function') {
    resolveBodyContacts(state.collisionContacts);
  }

  state.simTime += dt;
}


function resetState(initialAltitude) {
  resetMerges();
  clearRCS();
  resetLegs();
  const r0 = CONFIG.EARTH_RADIUS + (CONFIG.LAUNCH_SITE_ALTITUDE || 0) + initialAltitude;
  
  const members = (typeof SIM_STACK_MEMBERS !== 'undefined' && SIM_STACK_MEMBERS.length) ?
    SIM_STACK_MEMBERS : [];
  
  const body = _makeBody();
  body.members = [...members];
  body.rx = 0;
  body.ry = r0;
  body.dryMass = CONFIG.DRY_MASS;
  body.fuelMass = CONFIG.FUEL_MASS_MAX * (CONFIG.DEFAULT_FUEL_FRACTION || 1.0);
  body.isActive = true;
  body.engines = (members.length && typeof buildEnginesForRecord === 'function') ?
    buildEnginesForRecord(members[0]) : [];
  
  const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  body.payloadId = (stk && stk.payloadId) ? stk.payloadId : null;
  
  state.bodies = [body];
  state.activeBodyIndex = 0;
  state.simTime = 0;
  resetPWM();
}


// H2a-2: split the active body. Bottom member detaches as a new discarded
// body (same position/velocity, will free-fall in H2b); remaining members
// stay on the active body. Engines rebuild so thrust follows the new bottom.
function separateActiveBody() {
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members || active.members.length < 2) return false;
  if (active.crashed) return false;

  const bottomMember = active.members[0];
  const remaining = active.members.slice(1);

  const activeMax = Math.max(1, memberMaxFuel(remaining[0]) || 0);
  const discMax   = Math.max(1, memberMaxFuel(bottomMember) || 0);
  const sumMax    = activeMax + discMax;
  const totalFuel = Number.isFinite(active.fuelMass) ? active.fuelMass : 0;
  const activeFuel = totalFuel * (activeMax / sumMax);
  const discFuel   = Math.max(0, totalFuel - activeFuel);

  const activeProps = stackMassProps(remaining, activeFuel, legs.progress, _bodyPayloadMass(active));
  const discProps   = stackMassProps([bottomMember], discFuel, 0);

  const discarded = _makeBody();
  discarded.id = 'discarded-' + bottomMember.id;
  discarded.members = [bottomMember];
  discarded.engines = (typeof buildEnginesForRecord === 'function') ?
  buildEnginesForRecord(bottomMember) : [];
  discarded.rx = active.rx; discarded.ry = active.ry;
  discarded.vx = active.vx; discarded.vy = active.vy;
  discarded.theta = active.theta; discarded.omega = active.omega;
  discarded.dryMass  = Number.isFinite(discProps.dryMass)  ? discProps.dryMass  : 0;
  discarded.fuelMass = discFuel;
  discarded.isActive = false;
  discarded.isDiscarded = true;
  discarded.isDiscarded = true;
  discarded.bornAt = state.simTime; // Step 2 (collision.js) grace-period exclusion
  if (typeof ensureRcsState === 'function') ensureRcsState(discarded);
  discarded.payloadId = null;      // ← add — booster detach hote hi payload chhod deta hai

  active.members  = remaining;
  active.dryMass  = Number.isFinite(activeProps.dryMass) ? activeProps.dryMass : 0;
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
  
  
  separationFlash = {
  rx: active.rx, ry: active.ry,
  t0: performance.now(),
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

  // Clear actuator state on the OLD active body's engines.
  

  // Flip active flags.
  const old = state.bodies[state.activeBodyIndex];
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
let lastFairingSplit = null;   // { rx, ry, theta, t0 } for visual flash

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

  const sideVecX = Math.cos(active.theta);   // local +X (right)
  const sideVecY = Math.sin(active.theta);                      // m/s outward kick
  const spinSpeed = 0.4;                      // rad/s tumble

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
  half.bornAt = state.simTime; // Step 2 (collision.js) grace-period exclusion
  half.fairingHalf = { record: psRec, side };
  state.bodies.push(half);
});

  // Rebuild ENGINES (bottom member may have changed if fairing was on top
  // — actually bottom unchanged here, but safe to call).
  rebuildEnginesForBody(active);

  lastFairingSplit = { rx: baseRx, ry: baseRy, t0: performance.now() };
  return true;
}


// I-d2: release the payload from the active body. Prereq: fairing already
// split (no payloadSpace in members) AND the active stack has a payloadId.
// Payload becomes its own free body with a prograde kick + slight spin.
let lastPayloadRelease = null;

function releasePayloadOnActiveBody() {
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members) return false;
  if (active.members.some(m => m.stageRole === 'payloadSpace')) return false;   // fairing still on
  if (active.payloadReleased) return false;

  if (!active.payloadId) return false;
const pl = (typeof getPayload === 'function') ? getPayload(active.payloadId) : null;
if (!pl) return false;

  // World-space position of the payload = top of active body.
  const upX = -Math.sin(active.theta);
  const upY = Math.cos(active.theta);
  const totalH = active.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0);
  const payloadRx = active.rx + totalH * upX;
  const payloadRy = active.ry + totalH * upY;

  // Prograde kick = along velocity direction, magnitude fixed 0.5 m/s.
  const speed = Math.hypot(active.vx, active.vy);
  const ux = speed > 0.01 ? active.vx / speed : upX;
  const uy = speed > 0.01 ? active.vy / speed : upY;
  const KICK = 0.5;
  const SPIN = 0.15;

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
  body.bornAt = state.simTime; // Step 2 (collision.js) grace-period exclusion
  body.payloadBody = { record: pl };   // render marker

  state.bodies.push(body);
  active.payloadReleased = true;
  active.payloadReleased = true;
  active.payloadId = null;   // ← add

  lastPayloadRelease = { rx: payloadRx, ry: payloadRy, ux, uy, t0: performance.now() };
  return true;
}