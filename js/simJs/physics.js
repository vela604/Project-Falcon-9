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
    members: [],       // array of stack-member record objects (bottom → top)
    rx: 0, ry: 0, vx: 0, vy: 0,
    theta: 0, omega: 0,
    dryMass: 0,
    fuelMass: 0,
    crashed: false,
    landed: false,
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
  // Only the active body's legs animate. Discarded bodies' legs are frozen
  // at whatever state they were in when the body was detached.
  const b = state.bodies[state.activeBodyIndex];
  if (!b) return;
  if (!b.legs) b.legs = { deployed: false, progress: 0 };
  const target = b.legs.deployed ? 1 : 0;
  const maxDelta = CONFIG.LEG_DEPLOY_RATE * dt;
  if (target > b.legs.progress) b.legs.progress = Math.min(target, b.legs.progress + maxDelta);
  else b.legs.progress = Math.max(target, b.legs.progress - maxDelta);
}

function totalMass() { return state.dryMass + state.fuelMass; }

function currentGeometry(body) {
  body = body || state.bodies[state.activeBodyIndex];
  const members = (body && body.members) ? body.members : [];
  const fuelMass = body ? body.fuelMass : 0;
  const legProgress = (body && body.isActive) ? legs.progress : 0;
  
  if (members.length && typeof stackMassProps === 'function') {
    const props = stackMassProps(members, fuelMass, legProgress);
    return { M: props.totalMass, comH: props.comY, I: props.moi };
  }
  // Fallback (empty members) — legacy single-body formula.
  const M = (body ? body.dryMass : 0) + fuelMass;
  const comH = computeCoM(fuelMass, M, CONFIG.ROCKET_HEIGHT);
  const I = momentOfInertia(M, CONFIG.ROCKET_HEIGHT, CONFIG.ROCKET_WIDTH);
  return { M, comH, I };
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

function derivatives(s, extra) {
  const M = s.dryMass + s.fuelMass;
  const r = Math.hypot(s.rx, s.ry);
  const grav = gravityAccel(s.rx, s.ry);

  const cosT = Math.cos(s.theta), sinT = Math.sin(s.theta);
  const Fx_i = extra.Fx * cosT - extra.Fy * sinT;
  const Fy_i = extra.Fx * sinT + extra.Fy * cosT;

  const w = windInertialVector(s.rx, s.ry);
  const relVx = s.vx - w.wx, relVy = s.vy - w.wy;
  const speedRel = Math.hypot(relVx, relVy);
  const altitude = altitudeFromR(r);
  const rho = airDensity(altitude);
  const A = Math.PI * (CONFIG.ROCKET_WIDTH / 2) ** 2;
  const dragMag = 0.5 * rho * CONFIG.DRAG_CD * A * speedRel * speedRel;
  const Fdx = speedRel > 0 ? -dragMag * relVx / speedRel : 0;
  const Fdy = speedRel > 0 ? -dragMag * relVy / speedRel : 0;

  const ax = grav.ax + (Fx_i + Fdx) / M;
  const ay = grav.ay + (Fy_i + Fdy) / M;
  const alpha = extra.torque / extra.I;

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
let lastForces = { mainFx: 0, mainFy: 0, mainTorque: 0, rcsFx: 0, rcsFy: 0, rcsTorque: 0, mdot: 0, dragFx: 0, dragFy: 0 };

function physicsStep(dt) {
  if (!state.bodies.length) return;

  // Actuators affect only the active body's engines.
 

  state.bodies.forEach((body, idx) => {
  if (body.crashed) return;
  const isActive = (idx === state.activeBodyIndex);
  const geom = currentGeometry(body);

  applyActuatorRateLimitsForBody(body, dt);

  const hasFuel = body.fuelMass > 0;
  const main = hasFuel ? computeMainThrustForBody(body, geom.comH) : zeroThrust();
  const rcs = hasFuel ? computeRCSForBody(body, geom.comH, dt) : zeroRCS();
  body.lastRcs = { firing: rcs.firing || {}, pod: rcs.pod || {} };
  if (!hasFuel) body.engines.forEach(e => { e.currentF = 0; });

  // lastForces only updated for the active body (used by telemetry/UI).
  if (isActive) {
    lastForces = {
      mainFx: main.Fx, mainFy: main.Fy, mainTorque: main.torque,
      rcsFx: rcs.Fx, rcsFy: rcs.Fy, rcsTorque: rcs.torque,
      mdot: main.mdot + rcs.mdot, firing: rcs.firing || {}, pod: rcs.pod || {},
      dutyTop: rcs.dutyTop || 0,
    };
  }

  const extra = {
  Fx: 0,
  Fy: 0,
  torque: 0,
  I: geom.I,
};
  
// ---- Ground contact ----
// Two things happen when the base is on the ground:
//   1) Nose-tip collision: if the nose reaches ground level, crash.
//   2) Edge-pivot torque: gravity acts at the COM, contact at the
//      lower base corner. Net torque about base-centre:
//        τ = m·g·( h_com·sin α  −  sgn(α)·R·cos α )
//      Small α → restoring (rocket wobbles back to vertical).
//      Large α → toppling (once tan|α| > R / h_com).
const rB = Math.hypot(body.rx, body.ry);
const altB = altitudeFromR(rB) - (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
if (altB <= 0.5 && !body.crashed) {
  const localVert = Math.atan2(body.rx, body.ry);
  const alpha = body.theta - localVert;
  
  // (1) Nose-tip ground collision — crash + freeze rotation.
  const stackH = (body.members && body.members.length) ?
    body.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) :
    (CONFIG.ROCKET_HEIGHT || 45);
  const upX = -Math.sin(body.theta);
  const upY = Math.cos(body.theta);
  const noseAlt = Math.hypot(body.rx + stackH * upX, body.ry + stackH * upY) -
    CONFIG.EARTH_RADIUS - (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
  if (noseAlt <= 0) {
    body.crashed = true;
    body.omega = 0;
    return;
  }
  
  // (2) Edge-pivot restoring / toppling torque about base centre.
  const sgn = Math.sign(alpha);
  if (sgn !== 0) {
    const gLocal = gravityAccel(body.rx, body.ry).g;
    const baseR = (CONFIG.ROCKET_WIDTH || 3.9) / 2;
    const legMult = (body.legs && body.legs.progress > 0.5) ? 1.7 : 1.0;
    const effBase = baseR * legMult;
    const netTorque = geom.M * gLocal *
      (geom.comH * Math.sin(alpha) - sgn * effBase * Math.cos(alpha));
    extra.torque += netTorque;
  }
  
  // Very light ground friction — kills numerical drift; the actual
  // oscillation damping comes from the restoring torque's sign flip.
  body.omega *= Math.pow(0.998, dt * 60);
}
  
  let mdotTotal = main.mdot + rcs.mdot;
  

    if (isActive) {
      const hasFuel = body.fuelMass > 0;
      const main = hasFuel ? computeMainThrust(geom.comH) : zeroThrust();
      const rcs  = hasFuel ? computeRCS(geom.comH, dt)   : zeroRCS();
      if (!hasFuel) ENGINES.forEach(e => { e.currentF = 0; });

      // Add (not assign) so the ground-tipping torque added above is not
// wiped out.
extra.Fx += main.Fx + rcs.Fx;
extra.Fy += main.Fy + rcs.Fy;
extra.torque += main.torque + rcs.torque;
mdotTotal = main.mdot + rcs.mdot;

      lastForces = {
        mainFx: main.Fx, mainFy: main.Fy, mainTorque: main.torque,
        rcsFx: rcs.Fx, rcsFy: rcs.Fy, rcsTorque: rcs.torque,
        mdot: mdotTotal, firing: rcs.firing || {}, pod: rcs.pod || {},
        dutyTop: rcs.dutyTop || 0,
      };
    }

    // RK4 integration on THIS body.
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

    // Ground contact check — per body.
    const r = Math.hypot(body.rx, body.ry);
    if (altitudeFromR(r) <= (CONFIG.LAUNCH_SITE_ALTITUDE || 0)) {
      const ux = body.rx / r, uy = body.ry / r;
      const vr = body.vx * ux + body.vy * uy;
      const vTangX = body.vx - vr * ux, vTangY = body.vy - vr * uy;
      const hSpeed = Math.hypot(vTangX, vTangY);
      const descentSpeed = -vr;

      const bodyUpX = -Math.sin(body.theta), bodyUpY = Math.cos(body.theta);
      const tiltDeg = Math.acos(Math.max(-1, Math.min(1, bodyUpX * ux + bodyUpY * uy))) * 180 / Math.PI;

      if (descentSpeed > 0.3 || hSpeed > 0.3) {
        const recovery = CONFIG.RECOVERY_TYPE;
        const canLandOnLegs = !!(recovery && recovery.capabilities && recovery.capabilities.deploysOnVehicle);
        let landedOk = false;
        if (canLandOnLegs && isActive) {
          const minDeploy = (recovery.frame && recovery.frame.landingMinDeploy !== undefined)
            ? recovery.frame.landingMinDeploy : CONFIG.LANDING_MIN_LEG_DEPLOY;
          const legsReady = legs.progress >= minDeploy;
          const speedOk = descentSpeed <= CONFIG.LANDING_MAX_VSPEED && hSpeed <= CONFIG.LANDING_MAX_HSPEED;
          const tiltOk  = tiltDeg <= CONFIG.LANDING_MAX_TILT_DEG;
          const rateOk  = Math.abs(body.omega) <= CONFIG.LANDING_MAX_OMEGA;
          landedOk = legsReady && speedOk && tiltOk && rateOk;
        }
        if (landedOk) body.landed = true;
        else body.crashed = true;
      }

      if (!body.crashed) {
        body.rx = CONFIG.EARTH_RADIUS * ux;
        body.ry = CONFIG.EARTH_RADIUS * uy;
        if (vr < 0) { body.vx -= vr * ux; body.vy -= vr * uy; }
      }
    }
  });

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

  const activeProps = stackMassProps(remaining, activeFuel, legs.progress);
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
  body.payloadBody = { record: pl };   // render marker

  state.bodies.push(body);
  active.payloadReleased = true;
  active.payloadReleased = true;
  active.payloadId = null;   // ← add

  lastPayloadRelease = { rx: payloadRx, ry: payloadRy, ux, uy, t0: performance.now() };
  return true;
}