// ============================================================================
// physics.worker.js — physics on its own thread.
//
// CRITICAL ORDER: the worker does NOT load config.js/fleet.js at script
// start. It waits for a `hydrate` message from the main thread that
// populates a localStorage shim, and ONLY THEN runs importScripts. If we
// loaded config.js before hydration, it would read an empty localStorage
// and silently fall back to the DEFAULT vehicle — meaning the whole
// simulation would be running the wrong mass, wrong fuel capacity, wrong
// engine layout, for every session.
// ============================================================================

// Forward any uncaught error in this worker to the main thread, so it shows
// up in the regular DevTools console (worker consoles are hard to open on
// some browsers / dev setups).



self.addEventListener('error', (e) => {
  self.postMessage({
    type: 'workerError',
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    stack: e.error && e.error.stack,
  });
});

self.addEventListener('unhandledrejection', (e) => {
  self.postMessage({
    type: 'workerError',
    message: 'Unhandled rejection: ' + (e.reason && e.reason.message || e.reason),
    stack: e.reason && e.reason.stack,
  });
});

// ---- LocalStorage shim — MUST exist before the hydrate message arrives ----
if (typeof localStorage === 'undefined') {
  const _store = Object.create(null);
  globalThis.localStorage = {
    getItem: (k) => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
    clear: () => { for (const k in _store) delete _store[k]; },
    key: (i) => Object.keys(_store)[i] ?? null,
    get length() { return Object.keys(_store).length; },
  };
}

// ---- Loop state ----
let bootstrapped = false;
let running = false;
let paused = false;
let trajectoryEnabled = false;  
let warp = 1;
let accumulator = 0;
let lastTickTime = performance.now();
let lastTrajTime = 0;
let pendingTrajectoryTransfer = null;

// ---- Message handler ----
self.onmessage = (e) => {
  const msg = e.data;

  // ---- Phase 1: hydrate (must arrive BEFORE any other message) ----
 if (msg.type === 'hydrate' && !bootstrapped) {
  try {
      for (const k in msg.keys) {
      const v = msg.keys[k];
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
    
        
    importScripts(
      '../../componentLibrary.js',
      '../../customDesign.js',
      '../../fleet.js',
      '../../config.js',
      '../core/massProps.js',
      '../core/environment.js',
      '../core/vehicle.js',
      '../core/rcs.js',
      '../core/physics.js',
      '../core/collision.js',
      '../core/trajectoryMath.js'
    );
        
    bootstrapped = true;
    
    globalThis.SIM_STACK_MEMBERS = getActiveStackMembers();
        
    resetState(0);
        
    const snap = serializeForMain();
        
    self.postMessage({ type: 'ready', data: snap });
        
    setTimeout(workerLoop, 0);
  } catch (err) {
    console.error('  stack:', err && err.stack);
    // Post a synthetic error so main thread knows
    self.postMessage({ type: 'bootError', message: String(err), stack: err && err.stack });
  }
  return;
}

  if (!bootstrapped) return;   // ignore anything before hydration

  // ---- Phase 2: normal dispatch ----
  switch (msg.type) {
    case 'start': running = true; break;
    case 'stop':  running = false; break;
    case 'pauseSim':  paused = true;  break;
    case 'setTrajectoryEnabled': {
  trajectoryEnabled = !!msg.enabled;
  // If just turned off, clear any stale trajectory so the render worker
  // doesn't draw a frozen one from the last enabled frame.
  if (!trajectoryEnabled) {
    state.trajectory = null;
    pendingTrajectoryTransfer = null;
  }
  break;
}
    case 'resumeSim': paused = false; break;
    case 'warp':  warp = Math.max(0, msg.value || 1); break;
    case 'reset': resetState(msg.alt || 0); break;

    case 'spawnInOrbit': {
      resetState(msg.alt || 400000);
      const b = state.bodies[0];
      if (!b) break;
      const r0 = Math.hypot(b.rx, b.ry);
      const phi = Math.atan2(b.rx, b.ry);
      const vOrb = Math.sqrt(CONFIG.GM_EARTH / r0) * (msg.speedFactor || 1.0);
      b.vx = vOrb * Math.cos(phi);
      b.vy = -vOrb * Math.sin(phi);
      b.omega = 0;
      b.theta = -phi;
      state.halted = false;
      state.simTime = 0;
      break;
    }

    case 'setGroupThrottle': {
      const b = state.bodies[state.activeBodyIndex];
      if (!b || !b.engines) break;
      msg.angles.forEach(a => {
        const eng = b.engines.find(en => en.angleDeg === a);
        if (eng) eng.targetThrottle = msg.value;
      });
      break;
    }
    case 'setCenterThrottle': {
      const b = state.bodies[state.activeBodyIndex];
      if (!b || !b.engines) break;
      b.engines.filter(en => en.isCenter).forEach(en => { en.targetThrottle = msg.value; });
      break;
    }
    case 'setAllThrottle': {
      const b = state.bodies[state.activeBodyIndex];
      if (!b || !b.engines) break;
      b.engines.forEach(en => { en.targetThrottle = msg.value; });
      break;
    }
    case 'setGimbal': {
      const b = state.bodies[state.activeBodyIndex];
      if (!b || !b.engines) break;
      const lim = CONFIG.GIMBAL_MAX_DEG;
      const d = Math.max(-lim, Math.min(lim, msg.deg));
      b.engines.filter(en => en.gimbal).forEach(en => { en.targetGimbalDeg = d; });
      break;
    }
    case 'rcs': {
      const b = state.bodies[state.activeBodyIndex];
      if (!b) break;
      if (typeof ensureRcsState === 'function') ensureRcsState(b);
      if (b.rcsCmd) b.rcsCmd[msg.key] = !!msg.on;
      break;
    }
    case 'legs': {
      const b = state.bodies[state.activeBodyIndex];
      if (!b) break;
      if (!b.legs) b.legs = { deployed: false, progress: 0 };
      b.legs.deployed = !!msg.deployed;
      break;
    }
    case 'setFuelMass': {
      const b = state.bodies[state.activeBodyIndex];
      if (b) b.fuelMass = msg.value;
      break;
    }
    case 'setAtmosphere': {
  // Toggle global in the worker's own environment.js copy. Effects
  // are immediate: airDensity() returns 0 on the very next physics
  // step, zeroing drag + aero torque everywhere.
  atmosphereEnabled = !!msg.enabled;
  break;
}
    case 'setWind': {
  if (typeof msg.enabled === 'boolean') wind.enabled = msg.enabled;
  if (Number.isFinite(msg.speed)) wind.speed = msg.speed;
  if (Number.isFinite(msg.directionDeg)) wind.directionDeg = msg.directionDeg;
  break;
}
    case 'separate': {
      if (typeof separateActiveBody === 'function') separateActiveBody();
      break;
    }
    case 'splitFairing': {
      if (typeof splitFairingOnActiveBody === 'function') splitFairingOnActiveBody();
      break;
    }
    case 'releasePayload': {
      if (typeof releasePayloadOnActiveBody === 'function') releasePayloadOnActiveBody();
      break;
    }
    case 'takeControl': {
      if (typeof takeControlOfBody === 'function') takeControlOfBody(msg.idx);
      break;
    }
  }
};

// ---- Snapshot serialization ----
function serializeForMain() {
  return {
    separationFlash: separationFlash ? {
  id: separationFlash.id,
  rx: separationFlash.rx,
  ry: separationFlash.ry,
} : null,
lastPayloadRelease: lastPayloadRelease ? {
  id: lastPayloadRelease.id,
  rx: lastPayloadRelease.rx,
  ry: lastPayloadRelease.ry,
  ux: lastPayloadRelease.ux,
  uy: lastPayloadRelease.uy,
} : null,
    activeBodyIndex: state.activeBodyIndex,
    simTime: state.simTime,
    halted: state.halted,
    lastForces: {
      mainFx: lastForces.mainFx || 0,
      mainFy: lastForces.mainFy || 0,
      mainTorque: lastForces.mainTorque || 0,
      rcsFx: lastForces.rcsFx || 0,
      rcsFy: lastForces.rcsFy || 0,
      rcsTorque: lastForces.rcsTorque || 0,
      dragTorque: lastForces.dragTorque || 0,
      aoaDeg: lastForces.aoaDeg || 0,
      dutyTop: lastForces.dutyTop || 0,
      mdot: lastForces.mdot || 0,
      firing: lastForces.firing || {},
      pod: lastForces.pod || {},
    },
    bodies: state.bodies.map(b => ({
      id: b.id,
      members: b.members,
      rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy,
      theta: b.theta, omega: b.omega,
      dryMass: b.dryMass, fuelMass: b.fuelMass,
      crashed: b.crashed, landed: b.landed, settled: b.settled,
      isActive: b.isActive, isDiscarded: b.isDiscarded,
      payloadId: b.payloadId, payloadReleased: b.payloadReleased,
      legs: b.legs ? { deployed: b.legs.deployed, progress: b.legs.progress } : null,
      engines: (b.engines || []).map(en => ({
        id: en.id, angleDeg: en.angleDeg, x: en.x,
        isCenter: en.isCenter, gimbal: en.gimbal,
        Fmax: en.Fmax, Fmin: en.Fmin, Ve: en.Ve,
        throttle: en.throttle, targetThrottle: en.targetThrottle,
        gimbalDeg: en.gimbalDeg, targetGimbalDeg: en.targetGimbalDeg,
        currentF: en.currentF,
      })),
      rcsCmd: b.rcsCmd,
      lastRcs: b.lastRcs,
      payloadBody: b.payloadBody,
      fairingHalf: b.fairingHalf,
      height: b.height,
      width: b.width,
    })),
  };
}

// ---- Worker loop ----
function workerLoop() {
  const loopStart = performance.now();
  const dtReal = Math.min(0.1, (loopStart - lastTickTime) / 1000);
  lastTickTime = loopStart;
  
  // Legs animate on REAL elapsed time, independent of simRunning. Same
  // behaviour as the original main-thread loop — deploying or stowing the
  // legs must work while the sim is paused (e.g. pre-launch on the pad),
  // and its rate must not be multiplied by time-warp. Must run BEFORE the
  // physics step so the progress value used in contact checks is current.
  updateLegs(dtReal);
  // Expire the separation flash after 1 s wall time. By then the render
// worker's own 0.35 s visual has long since finished, so there's no
// reason to keep shipping it in every snapshot.
if (separationFlash && performance.now() - separationFlash.t0Real > 1000) {
  separationFlash = null;
}
if (lastPayloadRelease && performance.now() - lastPayloadRelease.t0Real > 2000) {
  lastPayloadRelease = null;
}
  
  if (running && !paused && !state.halted) {
  accumulator += dtReal * warp;
  while (accumulator >= CONFIG.DT &&
    performance.now() - loopStart < 12) {
    physicsStep(CONFIG.DT);
    accumulator -= CONFIG.DT;
    if (state.halted) { running = false; break; }
  }
} else {
  // When paused or stopped, don't let the accumulator grow — otherwise
  // a long pause followed by resume would trigger a burst of steps to
  // "catch up" to real time.
  accumulator = 0;
}

  // Skip the leapfrog compute entirely when no consumer wants the trajectory
// (trajectory checkbox off). The 500-sample integrator running at 60 Hz
// was ~0.3-0.5 ms of otherwise-idle CPU work. `pendingTrajectoryTransfer`
// is still sent as null on every snapshot when disabled, so the render
// worker's cached copy clears the moment the toggle flips off.
if (trajectoryEnabled && performance.now() - lastTrajTime >= 16) {
  lastTrajTime = performance.now();
  const active = state.bodies[state.activeBodyIndex];
  state.trajectory = active ? computePredictedTrajectory(active, 500, 1200) : null;
  pendingTrajectoryTransfer = state.trajectory;
}

  const data = serializeForMain();
  const transfers = [];
  if (pendingTrajectoryTransfer) {
    data.trajectory = pendingTrajectoryTransfer;
    if (pendingTrajectoryTransfer.pointsXy && pendingTrajectoryTransfer.pointsXy.buffer) {
      transfers.push(pendingTrajectoryTransfer.pointsXy.buffer);
    }
    if (pendingTrajectoryTransfer.pointsXyEarthFixed && pendingTrajectoryTransfer.pointsXyEarthFixed.buffer) {
      transfers.push(pendingTrajectoryTransfer.pointsXyEarthFixed.buffer);
    }
    pendingTrajectoryTransfer = null;
  } else {
    data.trajectory = null;
  }
  self.postMessage({ type: 'state', data }, transfers);

  setTimeout(workerLoop, 2);
}