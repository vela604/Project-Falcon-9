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

let state = {
  rx: 0, ry: 0,
  vx: 0, vy: 0,
  theta: 0, omega: 0,
  dryMass: CONFIG.DRY_MASS,
  fuelMass: CONFIG.FUEL_MASS_MAX,
  crashed: false,
  simTime: 0,
};

// Landing legs — purely visual/control state for now (Phase-1 scope has no
// landing/touchdown logic yet). `deployed` is the commanded target;
// `progress` (0 = fully stowed, 1 = fully deployed) is rate-limited toward
// it each tick, same pattern as throttle/gimbal, so the legs visibly swing
// open/closed over ~2s rather than snapping instantly.
let legs = { deployed: false, progress: 0 };

function resetLegs() { legs = { deployed: false, progress: 0 }; }

function updateLegs(dt) {
  const target = legs.deployed ? 1 : 0;
  const maxDelta = CONFIG.LEG_DEPLOY_RATE * dt;
  if (target > legs.progress) legs.progress = Math.min(target, legs.progress + maxDelta);
  else legs.progress = Math.max(target, legs.progress - maxDelta);
}

function totalMass() { return state.dryMass + state.fuelMass; }

function currentGeometry() {
  const M = totalMass();
  const comH = computeCoM(state.fuelMass, M, CONFIG.ROCKET_HEIGHT);
  const I = momentOfInertia(M, CONFIG.ROCKET_HEIGHT, CONFIG.ROCKET_WIDTH);
  return { M, comH, I };
}

// ---------------------------------------------------------------------------
// Rate-limited actuator application. Called once per tick from controls.js
// with the *desired* throttle/gimbal targets; this function moves the actual
// engine state toward the target no faster than its physical rate limit.
// ---------------------------------------------------------------------------
function applyActuatorRateLimits(dt) {
  ENGINES.forEach(e => {
    // Throttle: max change = ENGINE_THRUST_RATE (fraction of Fmax) per second
    const maxDelta = CONFIG.ENGINE_THRUST_RATE * dt;
    const target = e.targetThrottle !== undefined ? e.targetThrottle : e.throttle;
    if (target > e.throttle) e.throttle = Math.min(target, e.throttle + maxDelta);
    else e.throttle = Math.max(target, e.throttle - maxDelta);
    e.throttle = Math.max(0, Math.min(1, e.throttle));

    if (e.gimbal) {
      const maxGDelta = CONFIG.GIMBAL_RATE_DEG_S * dt;
      const gTarget = e.targetGimbalDeg !== undefined ? e.targetGimbalDeg : e.gimbalDeg;
      if (gTarget > e.gimbalDeg) e.gimbalDeg = Math.min(gTarget, e.gimbalDeg + maxGDelta);
      else e.gimbalDeg = Math.max(gTarget, e.gimbalDeg - maxGDelta);
      e.gimbalDeg = Math.max(-CONFIG.GIMBAL_MAX_DEG, Math.min(CONFIG.GIMBAL_MAX_DEG, e.gimbalDeg));
    }
  });
}

// Body-frame force/torque from all 9 main engines (gimbal already rate-limited).
function computeMainThrust(comH) {
  let Fx = 0, Fy = 0, torque = 0, mdot = 0;
  ENGINES.forEach(e => {
    if (e.throttle <= 0) { e.currentF = 0; return; }
    const F = e.Fmin + e.throttle * (e.Fmax - e.Fmin);
    e.currentF = F;
    const gRad = (e.gimbal ? e.gimbalDeg : 0) * Math.PI / 180;
    const fx = F * Math.sin(gRad);
    const fy = F * Math.cos(gRad);
    Fx += fx; Fy += fy;
    // Lever arm from CoM (0, comH) to engine mount (e.x, 0): (e.x, -comH)
    torque += e.x * fy - (-comH) * fx;
    mdot += F / e.Ve;
  });
  return { Fx, Fy, torque, mdot };
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
  if (state.crashed) return;

  applyActuatorRateLimits(dt);

  const geom = currentGeometry();
  const hasFuel = state.fuelMass > 0;
  const main = hasFuel ? computeMainThrust(geom.comH) : zeroThrust();
  const rcs = hasFuel ? computeRCS(geom.comH, dt) : zeroRCS();
  if (!hasFuel) ENGINES.forEach(e => { e.currentF = 0; });

  const extra = {
    Fx: main.Fx + rcs.Fx,
    Fy: main.Fy + rcs.Fy,
    torque: main.torque + rcs.torque,
    I: geom.I,
  };
  const mdotTotal = main.mdot + rcs.mdot;

  lastForces = {
    mainFx: main.Fx, mainFy: main.Fy, mainTorque: main.torque,
    rcsFx: rcs.Fx, rcsFy: rcs.Fy, rcsTorque: rcs.torque,
    mdot: mdotTotal, firing: rcs.firing || {}, pod: rcs.pod || {},
    dutyTop: rcs.dutyTop || 0,
  };

  const s0 = state;
  const k1 = derivatives(s0, extra);
  const s1 = stepState(s0, k1, dt / 2);
  const k2 = derivatives(s1, extra);
  const s2 = stepState(s0, k2, dt / 2);
  const k3 = derivatives(s2, extra);
  const s3 = stepState(s0, k3, dt);
  const k4 = derivatives(s3, extra);

  state.rx += dt / 6 * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx);
  state.ry += dt / 6 * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy);
  state.vx += dt / 6 * (k1.ax + 2 * k2.ax + 2 * k3.ax + k4.ax);
  state.vy += dt / 6 * (k1.ay + 2 * k2.ay + 2 * k3.ay + k4.ay);
  state.theta += dt / 6 * (k1.omega + 2 * k2.omega + 2 * k3.omega + k4.omega);
  state.omega += dt / 6 * (k1.alpha + 2 * k2.alpha + 2 * k3.alpha + k4.alpha);

  state.fuelMass = Math.max(0, state.fuelMass - mdotTotal * dt);
  state.simTime += dt;

  const r = Math.hypot(state.rx, state.ry);
  if (altitudeFromR(r) <= 0) {
    // Radial (vertical) velocity: negative = descending. The rocket now
    // starts resting exactly at altitude 0 on the pad, so this must only
    // flag a genuine hard impact (real downward speed at ground contact) —
    // not the rocket simply sitting there, which would otherwise trip a
    // false "crashed" on the very first tick after pressing Start.
    const vr = (state.rx * state.vx + state.ry * state.vy) / r;
    if (vr < -0.5) {
      state.crashed = true;
    } else {
      // Resting/settling on the pad — clamp gently to the deck instead of
      // letting it drift a hair below ground each tick.
      const ux = state.rx / r, uy = state.ry / r;
      state.rx = CONFIG.EARTH_RADIUS * ux;
      state.ry = CONFIG.EARTH_RADIUS * uy;
      if (vr < 0) {
        state.vx -= vr * ux;
        state.vy -= vr * uy;
      }
    }
  }
}

function resetState(initialAltitude) {
  buildEngineLayout();
  resetMerges();
  clearRCS();
  resetLegs();
  const r0 = CONFIG.EARTH_RADIUS + initialAltitude;
  state = {
    rx: 0, ry: r0,
    vx: 0, vy: 0,
    theta: 0, omega: 0,
    dryMass: CONFIG.DRY_MASS,
    fuelMass: CONFIG.FUEL_MASS_MAX,
    crashed: false,
    simTime: 0,
  };
  resetPWM();
}
