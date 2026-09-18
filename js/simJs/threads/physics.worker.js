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
//
// OPTIMIZATION #1 (Step 2): the per-tick "hot" numeric fields (position,
// velocity, orientation, fuel, per-engine massFlowRate/currentF/gimbalDeg) no
// longer travel inside the cloned `data` object from serializeForMain().
// They're written into a Float64Array (see stateBuffer.js) and moved to the
// main thread via Transferable Objects — zero-copy, no structured clone.
// Everything else (flags, legs, rcsCmd, engine meta/ids) still goes through
// the existing cloned snapshot, unchanged.
// ============================================================================

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

// ---- PHASE 3: guidance worker's direct port ----
// Set once, when main thread transfers it via 'connectGuidance' (see
// self.onmessage below). From then on, anything the guidance worker posts
// down this port runs through the EXACT SAME dispatchCommand() a human UI
// message would — this worker has no way to tell the two apart, which is
// the isolation property Phase 3 wants (guidance can only affect physics
// through message types this worker already handles).
let guidancePort = null;

// ---- Optimization #2: dedicated trajectory worker (see trajectory.worker.js) ----
// The leapfrog integration used to run inline in workerLoop(), sharing this
// worker's 12 ms tick budget with the actual physics substeps. It's now
// computed on its own thread; this worker only fires a tiny request message
// and picks up the answer whenever it arrives (see trajectoryWorker.onmessage
// below, and the tick-loop section further down).
let trajectoryWorker = null;
let trajectoryWorkerReady = false;
let trajectoryRequestInFlight = false;

// ---- Hot-state double buffer (Optimization #1) ----
// Two buffers ping-pong between this worker and the main thread. The worker
// only ever writes into a buffer it currently owns (popped from
// `availableHotBuffers`); the main thread transfers each buffer straight
// back after decoding it (see workerBridge.js, Step 3).
let availableHotBuffers = [];
let hotBufferStarvedCount = 0;
let lastHotBufferWarnTime = 0;

// ---- PHASE 1: mass-flow command clamp ----
// Converts/clamps a commanded engine mass flow rate (kg/s) into this
// engine's valid range:
//  - 0 (or any non-positive/NaN command) is always "off" — the floor
//    below does NOT apply to zero, that's the intentional asymmetry.
//  - Anything above the engine's max is capped down. Infinity is used
//    deliberately by the quick MAX command (see setAllThrottle) and
//    caps cleanly to whatever this specific engine's max is.
//  - Anything else nonzero is floored at the combustion-stability
//    minimum (minMassFlowRate).
function clampMassFlowCommand(eng, cmd) {
  if (!(cmd > 0)) return 0;
  const capped = Math.min(cmd, eng.maxMassFlowRate || 0);
  return Math.max(capped, eng.minMassFlowRate || 0);
}

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
        '../core/stateBuffer.js'
      );

      bootstrapped = true;

      // ---- Optimization #2: spawn the dedicated trajectory worker ----
      // Forwarding the SAME hydrate keys this worker just used means
      // CONFIG resolves inside it exactly the way it does here and in
      // render_worker.js (same selected vehicle, same fleet) — no
      // divergent-CONFIG risk. Spawned once, reused for the whole session.
      trajectoryWorker = new Worker('trajectory.worker.js');
      trajectoryWorker.onmessage = (te) => {
        const tmsg = te.data;
        if (tmsg.type === 'ready') {
          trajectoryWorkerReady = true;
        } else if (tmsg.type === 'result') {
          trajectoryRequestInFlight = false;
          // Guard against a stale answer landing AFTER the trajectory
          // checkbox was turned off mid-flight — 'setTrajectoryEnabled'
          // already nulled state.trajectory/pendingTrajectoryTransfer in
          // that case, and we must not let this late message resurrect it.
          if (trajectoryEnabled) {
            state.trajectory = tmsg.data;
            pendingTrajectoryTransfer = tmsg.data;
          }
        } else if (tmsg.type === 'bootError' || tmsg.type === 'computeError') {
          trajectoryRequestInFlight = false;
          console.error('[physics_worker] trajectory worker ' + tmsg.type + ':', tmsg.message);
        }
      };
      trajectoryWorker.onerror = (err) => {
        // A crash here must not leave trajectoryRequestInFlight stuck true
        // forever (that would silently stop all future trajectory requests
        // since the gate below never sends another one while it's true).
        trajectoryRequestInFlight = false;
        console.error('[physics_worker] trajectory worker crashed:', err.message);
      };
      trajectoryWorker.postMessage({ type: 'hydrate', keys: msg.keys });

      globalThis.SIM_STACK_MEMBERS = getActiveStackMembers();

      resetState(0);

      // Seed the double buffer — allocate both up front, never inside the
      // tick loop.
      availableHotBuffers = [createHotStateBuffer(), createHotStateBuffer()];

      const snap = serializeForMain();

      // The very first snapshot needs its hot fields too (state.bodies[i].rx
      // etc. must not be undefined for the first render frame) — encode one
      // here the same way workerLoop() does, before workerLoop even starts.
      const bootHotBuf = availableHotBuffers.pop();
      encodeHotState(bootHotBuf, state.bodies);
      snap.hotBuffer = bootHotBuf.buffer;

      self.postMessage({ type: 'ready', data: snap }, [bootHotBuf.buffer]);

      setTimeout(workerLoop, 0);
    } catch (err) {
      console.error('  stack:', err && err.stack);
      // Post a synthetic error so main thread knows
      self.postMessage({ type: 'bootError', message: String(err), stack: err && err.stack });
    }
    return;
  }

  if (!bootstrapped) return; // ignore anything before hydration

  // ---- PHASE 3: guidance worker connects here once, right after its own
  // boot (see workerBridge.js). e.ports[0] is one end of a MessageChannel
  // whose other end guidance.worker.js already holds — from this point on
  // guidance posts commands straight down that port, and its onmessage
  // below routes them through the identical dispatchCommand() a human UI
  // message goes through. Handled here (outside dispatchCommand) because
  // it needs e.ports, which only exists on the original MessageEvent. ----
  if (msg.type === 'connectGuidance') {
    guidancePort = e.ports && e.ports[0];
    if (guidancePort) {
      guidancePort.onmessage = (ge) => dispatchCommand(ge.data);
    }
    return;
  }

  dispatchCommand(msg);
};

// ---- Phase 3 Extension, Plan B — body-targeted commands ----
// Returns the target body, or null if the command should be dropped.
// A null/undefined targetBodyIdx resolves to the active body — human-UI
// commands never set this field, so they're completely unaffected by
// this mechanism.
//
// Guidance (running on its own worker, routed through the SAME
// dispatchCommand as the human UI — see connectGuidance above) can set
// targetBodyIdx to reach a specific discarded/landed body — e.g. firing
// RCS on a booster that's no longer the active body — without needing
// takeControl first.
function resolveTargetBody(targetBodyIdx) {
  if (targetBodyIdx == null) return state.bodies[state.activeBodyIndex] || null;
  if (!Number.isInteger(targetBodyIdx)) return null;
  if (targetBodyIdx < 0 || targetBodyIdx >= state.bodies.length) return null;
  const b = state.bodies[targetBodyIdx];
if (!b) return null;
// A4 — settled bodies are NOT rejected: a nonzero rcsDuty command must
// be able to wake a landed/resting body via _bodyHasActiveInput.
if (b.crashed) return null;
return b;
}

// ---- Phase 2: normal dispatch ----
// Factored out of self.onmessage so the guidance port (above) and the
// main-thread port run every command through the identical switch — this
// worker cannot distinguish a human-issued command from a guidance-issued
// one, by construction, which is exactly the "guidance can only affect
// physics through message types the physics worker already handles"
// property Phase 3 needs.
function dispatchCommand(msg) {
  switch (msg.type) {
    case 'start':
      running = true;
      break;
    case 'stop':
      running = false;
      break;
    case 'pauseSim':
      paused = true;
      break;
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
    case 'setSloshEnabled': {
      // Phase 2A — diagnostic toggle from the main thread's UI checkbox.
      // applySloshStep() reads CONFIG.SLOSH_ENABLED fresh every tick, so
      // just flipping this is enough; when turned off, zero every body's
      // slosh state immediately rather than waiting for the next tick's
      // decay-to-zero branch, so the figure/telemetry don't show a frozen
      // nonzero offset for one extra frame.
      CONFIG.SLOSH_ENABLED = !!msg.enabled;
      if (!CONFIG.SLOSH_ENABLED) {
        state.bodies.forEach(b => { b.slosh = { offset: 0, velocity: 0 }; });
      }
      break;
    }
    case 'resumeSim':
      paused = false;
      break;
    case 'warp':
      warp = Math.max(0, msg.value || 1);
      break;
    case 'reset':
      resetState(msg.alt || 0);
      break;

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

    // PHASE 1: setGroupThrottle/setCenterThrottle/setAllThrottle now carry
    // a commanded mass flow rate (kg/s) in msg.value, not a 0..1 fraction —
    // converted from the UI's percent at the control layer (controls.js).
    // clampMassFlowCommand() below applies the same clamp to every engine
    // it touches, so it's the one place command-floor/ceiling logic lives.
    case 'setGroupThrottle': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
  if (!b.engines) break;
  msg.angles.forEach(a => {
    const eng = b.engines.find(en => en.angleDeg === a);
    if (eng) eng.targetMassFlowRate = clampMassFlowCommand(eng, msg.value);
  });
  break;
}
    case 'setCenterThrottle': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
  if (!b.engines) break;
  b.engines.filter(en => en.isCenter).forEach(en => {
    en.targetMassFlowRate = clampMassFlowCommand(en, msg.value);
  });
  break;
}
    case 'setAllThrottle': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
  if (!b.engines) break;
  b.engines.forEach(en => { en.targetMassFlowRate = clampMassFlowCommand(en, msg.value); });
  break;
}
    case 'setGimbal': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
  if (!b.engines) break;
  const lim = CONFIG.GIMBAL_MAX_DEG;
  const d = Math.max(-lim, Math.min(lim, msg.deg));
  // PHASE 3 human precedence: an angle command from the human UI (slider)
  // always wins over an in-progress guidance rate command — clear the
  // rate field back to NaN so applyActuatorRateLimitsForBody's rate
  // branch falls through to the angle-slew branch below on the very next
  // tick, using the targetGimbalDeg this sets.
  b.engines.filter(en => en.gimbal).forEach(en => {
    en.targetGimbalDeg = d;
    en.targetGimbalRateDegS = NaN;
  });
  break;
}
    // PHASE 3: rate, not angle — guidance commands how fast the gimbal
    // should move, physics integrates. See applyActuatorRateLimitsForBody
    // in physics.js for the integration + clamp-to-GIMBAL_MAX_DEG side.
    // Does NOT touch targetGimbalDeg (ignored while rate mode is active,
    // per the arbitration rule — ignoring it rather than writing to it
    // means setGimbal doesn't need to know rate mode exists to win back
    // control; it just always sets both fields itself, above).
    case 'setGimbalRate': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b || !b.engines) break;
  const lim = CONFIG.GIMBAL_RATE_DEG_S;
  const rate = Math.max(-lim, Math.min(lim, msg.degPerSec));
  b.engines.filter(en => en.gimbal).forEach(en => { en.targetGimbalRateDegS = rate; });
  break;
}
    case 'rcs': {
      const b = resolveTargetBody(msg.targetBodyIdx);
      if (!b) break;
      if (typeof ensureRcsState === 'function') ensureRcsState(b);
      if (b.rcsCmd) b.rcsCmd[msg.key] = !!msg.on;
      // PHASE 3 human precedence: a boolean RCS command from the human UI
      // always wins over an in-progress guidance duty command.
      b.rcsDuty = null;
      break;
    }
    // PHASE 3: full nozzle-level duty command. Overrides the boolean
    // rcsCmd mechanism for this body — computeRCSForBody (rcs.js) checks
    // rcsDuty first and only falls back to rcsCmd when it's null/absent.
    case 'rcsDuty': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  // A3 — restore round-2 Issue C: null/undefined duties payload means
  // "relinquish duty control, fall back to boolean rcsCmd path". An
  // explicit object (even one with only zero-valued nozzles) means
  // "still holding duty control". Without this, guidance can never
  // hand control back, and {} permanently locks out the boolean path.
  if (msg.duties == null) {
    b.rcsDuty = null;
    break;
  }
  const clampDuty = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const duties = {};
  const src = msg.duties || {};
  Object.keys(src).forEach(podId => {
    const d = src[podId] || {};
    duties[podId] = { lat: clampDuty(d.lat), up: clampDuty(d.up), dn: clampDuty(d.dn) };
  });
  b.rcsDuty = duties;
  break;
}
    case 'legs': {
      const b = resolveTargetBody(msg.targetBodyIdx);
      if (!b) break;
      if (!b.legs) b.legs = { deployed: false, progress: 0 };
      b.legs.deployed = !!msg.deployed;
      break;
    }
    case 'setFuelMass': {
      const b = resolveTargetBody(msg.targetBodyIdx);
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
  // Two-phase: this now commands engine shutdown and defers the
  // actual member slice until thrust has spooled down. The split
  // itself is triggered by _checkPendingSeparate() inside physicsStep.
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof requestSeparate === 'function') requestSeparate(b);
  break;
}
    case 'splitFairing': {
      const b = resolveTargetBody(msg.targetBodyIdx);
      if (!b) break;
      if (typeof splitFairingOnActiveBody === 'function') splitFairingOnActiveBody(b);
      break;
    }
    
    case 'releasePayload': {
  // Two-phase: command engine shutdown, defer actual release until
  // thrust spools to ~0 (or skip the wait if already coasting).
  // Emergency eject bypasses this — see emergencyEjectPayload.
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof requestReleasePayload === 'function') requestReleasePayload(msg, b);
  break;
}
    case 'emergencyEject': {
  const b = resolveTargetBody(msg.targetBodyIdx);
  if (!b) break;
  if (typeof emergencyEjectPayload === 'function') emergencyEjectPayload(b);
  break;
}
    case 'takeControl': {
      if (typeof takeControlOfBody === 'function') takeControlOfBody(msg.idx);
      break;
    }

    // ---- Optimization #1: main thread hands a decoded buffer back so we
    //      can reuse it next tick instead of allocating a new one. ----
    case 'returnHotBuffer': {
      if (msg.buffer) availableHotBuffers.push(new Float64Array(msg.buffer));
      break;
    }
  }
}

// ---- Snapshot serialization ----
// NOTE (Optimization #1, Step 2): rx, ry, vx, vy, theta, omega, fuelMass,
// and each engine's massFlowRate/currentF/gimbalDeg are DELIBERATELY left out
// below — they now travel every tick via the hot-state Float64Array
// (encodeHotState in stateBuffer.js), not through this cloned object.
//
// OPTIMIZATION #5 (object pooling): this function used to call .map() on
// state.bodies AND on every body's .engines array on every single tick
// (~500/s), allocating a brand-new object graph — outer bodies array, one
// object per body, one array + one object per engine — even though almost
// none of these fields change tick-to-tick (they only change on rare
// structural events: staging, fairing split, or a throttle/gimbal command).
// That's dozens of small short-lived allocations per second doing nothing
// but generating GC pressure.
//
// Fix: keep one persistent cache object per body/engine (_bodyCacheAt /
// _engineCacheAt below) and overwrite its fields in place each tick instead
// of allocating fresh ones. The cache arrays are only resized (never
// spliced) when the number of bodies/engines actually changes, which only
// happens on those same rare structural events. `self.postMessage` still
// structured-clones this object on its way to the main thread — reusing the
// object on the SENDING side is what removes the allocation, the receiver
// always gets an independent copy regardless.
const _snapCache = {
  separationFlash: null,
  lastPayloadRelease: null,
  activeBodyIndex: 0,
  simTime: 0,
  halted: false,
  lastForces: { firing: {}, pod: {} },
  bodies: [],
};
let _separationFlashCache = null;
let _lastPayloadReleaseCache = null;
const _emptyForceObj = {};

function _bodyCacheAt(i) {
  let c = _snapCache.bodies[i];
  if (!c) {
    c = { legs: null, engines: [] };
    _snapCache.bodies[i] = c;
  }
  return c;
}

function _engineCacheAt(bodyCache, j) {
  let c = bodyCache.engines[j];
  if (!c) {
    c = {};
    bodyCache.engines[j] = c;
  }
  return c;
}

function serializeForMain() {
  const out = _snapCache;
  
  if (separationFlash) {
    const f = _separationFlashCache || (_separationFlashCache = {});
    f.id = separationFlash.id;
    f.rx = separationFlash.rx;
    f.ry = separationFlash.ry;
    out.separationFlash = f;
  } else {
    out.separationFlash = null;
  }
  
  if (lastPayloadRelease) {
    const r = _lastPayloadReleaseCache || (_lastPayloadReleaseCache = {});
    r.id = lastPayloadRelease.id;
    r.rx = lastPayloadRelease.rx;
    r.ry = lastPayloadRelease.ry;
    r.ux = lastPayloadRelease.ux;
    r.uy = lastPayloadRelease.uy;
    out.lastPayloadRelease = r;
  } else {
    out.lastPayloadRelease = null;
  }
  
  out.activeBodyIndex = state.activeBodyIndex;
  out.simTime = state.simTime;
  out.halted = state.halted;
  
  const lf = out.lastForces;
  lf.mainFx = lastForces.mainFx || 0;
  lf.mainFy = lastForces.mainFy || 0;
  lf.mainTorque = lastForces.mainTorque || 0;
  lf.rcsFx = lastForces.rcsFx || 0;
  lf.rcsFy = lastForces.rcsFy || 0;
  lf.rcsTorque = lastForces.rcsTorque || 0;
  lf.dragTorque = lastForces.dragTorque || 0;
  lf.aoaDeg = lastForces.aoaDeg || 0;
  lf.dutyTop = lastForces.dutyTop || 0;
  lf.mdot = lastForces.mdot || 0;
  lf.firing = lastForces.firing || _emptyForceObj;
  lf.pod = lastForces.pod || _emptyForceObj;
  
  // Reused array: length only changes on staging/fairing-split/reset
  // (state.bodies is only ever pushed to or wholesale-replaced elsewhere,
  // never spliced mid-array), so this never reallocs on a normal tick.
  out.bodies.length = state.bodies.length;
  for (let i = 0; i < state.bodies.length; i++) {
    const b = state.bodies[i];
    const bc = _bodyCacheAt(i);
    
    bc.id = b.id;
    bc.members = b.members;
    bc.dryMass = b.dryMass;
    bc.crashed = b.crashed;
    bc.landed = b.landed;
    bc.settled = b.settled;
    bc.isActive = b.isActive;
    bc.isDiscarded = b.isDiscarded;
    bc.payloadId = b.payloadId;
    bc.payloadReleased = b.payloadReleased;
    
    if (b.legs) {
      if (!bc.legs) bc.legs = {};
      bc.legs.deployed = b.legs.deployed;
      bc.legs.progress = b.legs.progress;
    } else {
      bc.legs = null;
    }
    
    const srcEngines = b.engines || [];
    bc.engines.length = srcEngines.length;
    for (let j = 0; j < srcEngines.length; j++) {
      const en = srcEngines[j];
      const ec = _engineCacheAt(bc, j);
      ec.id = en.id;
      ec.angleDeg = en.angleDeg;
      ec.x = en.x;
      ec.isCenter = en.isCenter;
      ec.gimbal = en.gimbal;
      ec.Fmax = en.Fmax;
      ec.Fmin = en.Fmin;
      ec.Ve = en.Ve;
      // PHASE 1: mass-flow limits/target travel here (they only change on
      // the same rare structural events as everything else in this
      // clone); massFlowRate itself is hot-path and comes via the buffer.
      ec.maxMassFlowRate = en.maxMassFlowRate;
      ec.minMassFlowRate = en.minMassFlowRate;
      ec.targetMassFlowRate = en.targetMassFlowRate;
      ec.targetGimbalDeg = en.targetGimbalDeg;
      // Phase 3 — Issue 6 restoration: guidance's rate command needs to
      // round-trip back to the main-thread mirror and the guidance
      // snapshot, otherwise it appears to vanish every tick.
      ec.targetGimbalRateDegS = en.targetGimbalRateDegS;
    }
    
    bc.rcsCmd = b.rcsCmd;
    // Phase 3 — Issue 6 restoration: same reasoning as
    // targetGimbalRateDegS above.
    bc.rcsDuty = b.rcsDuty;
    bc.lastRcs = b.lastRcs;
    bc.payloadBody = b.payloadBody;
    bc.fairingHalf = b.fairingHalf;
    bc.height = b.height;
    bc.width = b.width;
    
    out.bodies[i] = bc;
  }
  
  return out;
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

  // Skip requesting the leapfrog compute entirely when no consumer wants
  // the trajectory (trajectory checkbox off) — `pendingTrajectoryTransfer`
  // is still sent as null on every snapshot when disabled (below), so the
  // render worker's cached copy clears the moment the toggle flips off.
  //
  // OPTIMIZATION #2: this no longer computes anything itself — it only
  // fires a tiny request at the dedicated trajectory worker (4 numbers)
  // and returns immediately. `trajectoryRequestInFlight` is a simple
  // backpressure guard so a slow/backed-up worker never gets a second
  // request queued on top of one it hasn't answered yet; the ~16 ms gate
  // then naturally re-fires next tick once it's free again. The actual
  // result is applied later in trajectoryWorker.onmessage above, whenever
  // it arrives — same hand-off into pendingTrajectoryTransfer as before,
  // just decoupled from this tick's timing.
  if (trajectoryEnabled && trajectoryWorkerReady && !trajectoryRequestInFlight &&
    performance.now() - lastTrajTime >= 16) {
    lastTrajTime = performance.now();
    const active = state.bodies[state.activeBodyIndex];
    if (active) {
      trajectoryRequestInFlight = true;
      trajectoryWorker.postMessage({
        type: 'compute',
        rx: active.rx, ry: active.ry, vx: active.vx, vy: active.vy,
        maxSamples: 500, maxTimeSec: 1200,
      });
    } else {
      state.trajectory = null;
      pendingTrajectoryTransfer = null;
    }
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

  // ---- Optimization #1: hot fields go out as a transferred Float64Array
  //      instead of being cloned inside `data`. ----
  let hotBuf = availableHotBuffers.pop();
  if (!hotBuf) {
    // Main thread hasn't returned a buffer yet (shouldn't normally happen —
    // it transfers one back synchronously on receipt). Allocate a one-off
    // fallback so this tick's render update still goes out; log it (rate-
    // limited) so a persistent pattern is visible instead of silently
    // eating an allocation every tick.
    hotBuf = createHotStateBuffer();
    hotBufferStarvedCount++;
    if (loopStart - lastHotBufferWarnTime > 5000) {
      lastHotBufferWarnTime = loopStart;
      console.warn('[physics_worker] hot buffer starved', hotBufferStarvedCount, 'times so far — main thread is not returning buffers promptly.');
    }
  }
  const encodeResult = encodeHotState(hotBuf, state.bodies);
  if (!encodeResult.ok) {
    console.warn('[physics_worker] hot state buffer capacity exceeded', encodeResult);
  }
  data.hotBuffer = hotBuf.buffer;
  transfers.push(hotBuf.buffer);

  self.postMessage({ type: 'state', data }, transfers);

  setTimeout(workerLoop, 2);
}
