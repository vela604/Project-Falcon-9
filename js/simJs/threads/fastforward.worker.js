// ============================================================================
// fastforward.worker.js — runs fast-forward on its own thread.
//
// Loads the full physics + guidance stack in one scope. No coupling to
// the physics worker or guidance worker — the FF is fully self-contained.
// Receives an initial state snapshot, runs N ticks, returns final state.
//
// Protocol:
//   IN  { type: 'run', storageKeys, fullState, guidanceState, stackData,
//          activeGuide, durationS, progressEveryTicks }
//   IN  { type: 'abort' }
//   OUT { type: 'progress', simTime, elapsedS }
//   OUT { type: 'done', fullState, guidanceState }
//   OUT { type: 'workerError', message, stack }
// ============================================================================

self.addEventListener('error', (e) => {
  self.postMessage({ type: 'workerError', message: e.message, stack: e.error && e.error.stack });
});
self.addEventListener('unhandledrejection', (e) => {
  self.postMessage({ type: 'workerError', message: String(e.reason && e.reason.message || e.reason) });
});

// ===== __consoleRelay — forward worker console to main thread =====
// FF worker console.log is invisible in main page console (separate
// thread). Relay every log line via postMessage so user on mobile can
// see diagnostics without chrome://inspect.
(function () {
  const _msgCount = { n: 0 };
  const _MAX_RELAY = 1200;
  function _relay(kind, args) {
    if (_msgCount.n >= _MAX_RELAY) return;
    _msgCount.n++;
    try {
      const line = Array.prototype.map.call(args, function (a) {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' ');
      self.postMessage({ type: 'ffLog', kind: kind, line: line });
    } catch (e) {}
  }
  const _origLog = console.log.bind(console);
  const _origWarn = console.warn.bind(console);
  const _origErr = console.error.bind(console);
  console.log = function () { _origLog.apply(null, arguments); _relay('log', arguments); };
  console.warn = function () { _origWarn.apply(null, arguments); _relay('warn', arguments); };
  console.error = function () { _origErr.apply(null, arguments); _relay('err', arguments); };
})();

// ---- localStorage shim BEFORE importScripts ----
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

let _booted = false;
let _abort = false;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'abort') { _abort = true; return; }
  if (msg.type !== 'run' || _booted) return;
  _booted = true;
  _abort = false;
  
  try {
    // ---- Hydrate localStorage ----
    for (const k in (msg.storageKeys || {})) {
      const v = msg.storageKeys[k];
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
    
    // ---- Load physics + guidance stack ----
    // Physics side loads first (defines state, buildPodEntries, etc.).
    // Guidance modules use IIFE scoping, so no namespace collisions with
    // physics.js's module-level helpers.
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
      '../core/stateBuffer.js',
      '../guidance/imu.js',
      '../guidance/derivation.js',
      '../guidance/guidercs.js',
      '../guidance/guidance-blocks.js',
      '../guidance/guidance.js'
    );
    
   // ---- Cache the component library ----
// getComponentType() is called 20-40× per tick via physicsStep and
// derivation.js. Without this cache, every call rebuilds the entire
// registry (seedComponentLibrary + localStorage + JSON.parse).
// This was THE bottleneck on the tester and it reappeared here.
(function() {
  var _cache = null;
  var _orig = loadComponentLibrary;
  loadComponentLibrary = function() {
    if (_cache) return _cache;
    _cache = _orig();
    return _cache;
  };
  if (typeof saveCustomComponentTypes === 'function') {
    var _origSave = saveCustomComponentTypes;
    saveCustomComponentTypes = function(types) {
      _origSave(types);
      _cache = null;
    };
  }
})();

// ---- Swap state ----
state.bodies = msg.fullState.bodies;
    state.activeBodyIndex = msg.fullState.activeBodyIndex;
    state.simTime = msg.fullState.simTime;
    state.halted = !!msg.fullState.halted;
    
    // ===== FF_DEBUG_BLOCK (auto-added) =====
    if (msg.tickDebug === false) {
      globalThis._ffTickDebug = false;
    } else if (msg.tickDebug) {
      globalThis._ffTickDebug = msg.tickDebug;
    } else {
      // Default ON — every 2000 ticks (25s). Override via
      // window.__ffTickDebug = { everyNTicks: N } or false.
      globalThis._ffTickDebug = { everyNTicks: 2000, from: 0, to: 9999 };
    }
    // __ffTickDebugDefaultApplied
    
    // [FF-INIT] — one-shot dump of received state. Compare with physics
    // worker state at pause. Any difference means state transfer loses
    // info (actuator spool, RCS, slosh, grid fins, legs progress) and is
    // the root cause of trajectory divergence.
    {  // [FF-INIT] always fires
      const _b0i = state.bodies.find(function(b) {
        return b.members && b.members[0] && b.members[0].stageRole === 'booster' && !b.payloadBody;
      });
      if (_b0i) {
        console.log('[FF-INIT]', JSON.stringify({
          t: state.simTime,
          rx: _b0i.rx, ry: _b0i.ry, vx: _b0i.vx, vy: _b0i.vy,
          theta: _b0i.theta, omega: _b0i.omega,
          fuel: _b0i.fuelMass || (_b0i.memberFuel && _b0i.memberFuel[0]),
          engines: _b0i.engines && _b0i.engines.map(function(e) {
            return { mf: e.massFlowRate, tgt: e.targetMassFlowRate, gimbal: e.gimbalDeg };
          }),
          legs: _b0i.legs,
          gridFins: _b0i.gridFins,
          slosh: _b0i.slosh
        }));
      }
    }
    
    // [FF-TICK] — periodic trajectory log
    if (typeof physicsStep === 'function' && !physicsStep._ffDebugWrapped) {
      const _origPhysicsStep = physicsStep;
      physicsStep = function(dt) {
        const result = _origPhysicsStep.call(this, dt);
        if (globalThis._ffTickDebug) {
          const dbg = globalThis._ffTickDebug;
          const t = state.simTime;
          if ((!dbg.from || t >= dbg.from) && (!dbg.to || t <= dbg.to)) {
            const nTick = Math.round(t / 0.0125);
            const every = dbg.everyNTicks || 400;
            if (nTick % every === 0) {
              const _bB = state.bodies.find(function(b) {
                return b.members && b.members[0] && b.members[0].stageRole === 'booster' && !b.payloadBody;
              });
              if (_bB) {
                console.log('[FF-TICK] t=' + t.toFixed(4) +
                  ' rx=' + _bB.rx.toFixed(6) + ' ry=' + _bB.ry.toFixed(6) +
                  ' vx=' + _bB.vx.toFixed(6) + ' vy=' + _bB.vy.toFixed(6) +
                  ' theta=' + _bB.theta.toFixed(6) + ' omega=' + _bB.omega.toFixed(6) +
                  ' fuel=' + (_bB.fuelMass || (_bB.memberFuel && _bB.memberFuel[0]) || 0).toFixed(2) +
                  ' legs=' + (_bB.legs ? _bB.legs.deployed + '/' + _bB.legs.progress.toFixed(2) : 'none') +
                  ' gf=' + (_bB.gridFins && _bB.gridFins.L ? _bB.gridFins.L.deploy + ',' + _bB.gridFins.L.control : 'none'));
              }
            }
          }
        }
        return result;
      };
      physicsStep._ffDebugWrapped = true;
    }
    // ===== end FF_DEBUG_BLOCK =====

    
    // ASDS pad sync — CONFIG.LANDING_PADS from physics capture. Without
    // this the FF worker runs with LZ-only defaults (config.js boot) and
    // diverges ~19m when runtime-deployed ASDS pads exist (Run A offset).
    // Deep-clone so FF worker mutations can't leak to capture payload.
    if (msg.fullState && Array.isArray(msg.fullState.configLandingPads)) {
      CONFIG.LANDING_PADS = msg.fullState.configLandingPads.map(function (pp) { return Object.assign({}, pp); });
      console.log('[FF] pads synced from capture:', CONFIG.LANDING_PADS.length);
    }
    
    // TEMP DIAG — capture state signature, sent to main thread for display
(function diagCaptureHash() {
  const b0 = state.bodies[0];
  if (!b0) return;
  const sig = 't=' + state.simTime.toFixed(6) +
              ' n=' + state.bodies.length +
              ' rx=' + b0.rx.toFixed(4) +
              ' ry=' + b0.ry.toFixed(4) +
              ' vx=' + b0.vx.toFixed(4) +
              ' vy=' + b0.vy.toFixed(4) +
              ' fuel=' + b0.fuelMass.toFixed(2);
  self.postMessage({ type: 'diagCapture', sig: sig });
})();
    
    // Per-body init: pwmClocks, pods (cache). Crashed / settled bodies
    // don't need pods — guidance never drives them and physicsStep
    // early-returns them, so skip the work.
    state.bodies.forEach(b => {
      if (!b.pwmClocks) b.pwmClocks = {};
      if (!b.pods && !b.crashed && !b.settled
          && typeof buildPodEntries === 'function') {
        b.pods = buildPodEntries(b);
      }
    });
    
    // ---- Apply environment state from main thread ----
// The physics worker receives wind / atmosphere / slosh / IMU toggles
// as separate post-boot messages; the FF worker gets none of those,
// so without this block it would run with fresh defaults (wind off,
// atmosphere on, slosh on, IMU off) and diverge from normal play.
if (msg.envState) {
  if (msg.envState.wind && typeof wind !== 'undefined') {
    wind.enabled = !!msg.envState.wind.enabled;
    wind.speed = Number.isFinite(msg.envState.wind.speed) ? msg.envState.wind.speed : 0;
    wind.directionDeg = Number.isFinite(msg.envState.wind.directionDeg) ? msg.envState.wind.directionDeg : 0;
  }
  if (typeof msg.envState.atmosphereEnabled === 'boolean' && typeof atmosphereEnabled !== 'undefined') {
    atmosphereEnabled = msg.envState.atmosphereEnabled;
  }
  if (typeof msg.envState.sloshEnabled === 'boolean' && typeof CONFIG !== 'undefined') {
    CONFIG.SLOSH_ENABLED = msg.envState.sloshEnabled;
  }
  if (typeof msg.envState.imuEnabled === 'boolean' && typeof Guidance !== 'undefined' && Guidance.setImuEnabled) {
    Guidance.setImuEnabled(msg.envState.imuEnabled);
  }
}

// ---- Init Derivation + Guidance ----
if (msg.stackData && typeof Derivation !== 'undefined') {
  Derivation.setStackData(msg.stackData);
}
if (typeof Guidance !== 'undefined') {
  Guidance.init(localDispatch);
  if (msg.guidanceState) Guidance.importGuideState(msg.guidanceState);
  // If 1x had no guide active, importGuideState sets _activeGuide to null
  // and the rest of this run would be physics-only — the guide would sit
  // idle and the FF would always "fail". Start the guide the main thread
  // requested. startGuide is idempotent when the active name already
  // matches, so a running 1x guide (whose state we just imported) is
  // left untouched and this call is a no-op — no risk of clobbering a
  // mid-mission state that was faithfully carried in.
  if (msg.activeGuide) {
    Guidance.startGuide(msg.activeGuide);
  }
}
// ===== FF_GUIDE_STATE_DIAG (temporary) =====
if (globalThis._ffTickDebug && msg.guidanceState) {
  try {
    var _gs = msg.guidanceState;
    console.log('[FF-GUIDE-STATE] top-level keys:', Object.keys(_gs).join(', '));
    // Search recursively for anything ASDS-related
    function _findASDS(obj, path, depth) {
      if (!obj || typeof obj !== 'object' || depth > 5) return;
      Object.keys(obj).forEach(function(k) {
        var v = obj[k];
        if (/asds|activeGuide|missionPhase|meco|sep|phase/i.test(k)) {
          var preview;
          try { preview = JSON.stringify(v); } catch (e) { preview = String(v); }
          if (preview && preview.length > 150) preview = preview.slice(0, 150) + '...';
          console.log('[FF-GUIDE-STATE] ' + path + '.' + k + ' = ' + preview);
        }
        if (v && typeof v === 'object' && depth < 5) {
          _findASDS(v, path + '.' + k, depth + 1);
        }
      });
    }
    _findASDS(_gs, 'gs', 0);
  } catch (e) {
    console.log('[FF-GUIDE-STATE] dump error:', e.message);
  }
}
// ===== end FF_GUIDE_STATE_DIAG =====
    
            // ---- Persistent snapshot wrapper (zero alloc per tick) ----
const dt = CONFIG.DT;
const maxTicks = Math.ceil(msg.durationS / dt);
self.__ffwDiag = {
  dt: dt,
  durationS: msg.durationS,
  maxTicks: maxTicks,
  startSimTime: state.simTime,
  expectedEnd: state.simTime + maxTicks * dt,
  startWallMs: performance.now(),
};
console.log('[ffw] boot: dt=' + dt + ' durationS=' + msg.durationS +
  ' maxTicks=' + maxTicks + ' startSim=' + state.simTime.toFixed(3) +
  ' expectedEnd=' + (state.simTime + maxTicks * dt).toFixed(3));
const progressEvery = Math.max(1, msg.progressEveryTicks || 80);
const bodiesEvery = Math.max(progressEvery, msg.bodiesEveryTicks || 80);
const startSimT = state.simTime;

// Real-sim tick order: physicsStep → snapshot@T+dt → guidance.
// Matches physics.worker.js's workerLoop exactly: the worker runs
// physics, snapshots the post-step state, main thread forwards to
// guidance, guidance computes commands, commands apply on the next
// physicsStep. Do NOT reorder — a 1-tick shift here propagates into
// every control loop downstream (RCS slew, cutoff timing, etc).
for (let i = 0; i < maxTicks; i++) {
  if (i === 0) {
  console.log('[FF-BOOT] t=' + state.simTime.toFixed(6) + ' bodies=' + state.bodies.length + ' body0.rx=' + state.bodies[0].rx.toFixed(6) + ' body0.ry=' + state.bodies[0].ry.toFixed(6));
}
  if (_abort) break;
  
  // 1. Legs
  try { updateLegs(dt); } catch (le) {
    self.postMessage({ type: 'workerError', message: 'updateLegs: ' + le.message, stack: le.stack });
  }
  
  // 2. Physics step @ T → @ T+dt. Uses commands mutated by the
  //    previous iteration's guidance tick.
  try { physicsStep(dt); }
  catch (pe) {
    self.postMessage({ type: 'workerError', message: 'physics: ' + pe.message, stack: pe.stack });
    break;
  }
  
  // 3. Refresh .pods on EVERY body — matches workerBridge.js's
  //    maybeForwardGuidanceSnapshot(), which adds fresh buildPodEntries(b)
  //    to every body on every tick before forwarding to guidance.
  //
  //    The boot-time per-body init only ran ONCE, so bodies created
  //    DURING FF (the discarded booster at MECO, fairing halves,
  //    released payload) never had pods set. Guidance's
  //    postSeparationAxialDuty / targetTorqueRcs read body.pods and
  //    silently returned null for these new bodies — no RCS fired,
  //    separation dynamics diverged from the real sim.
  if (typeof buildPodEntries === 'function') {
    for (let pi = 0; pi < state.bodies.length; pi++) {
      state.bodies[pi].pods = buildPodEntries(state.bodies[pi]);
    }
  }
  
  // 4. Fresh snapshot @ T+dt. New object every tick — Derivation
  //    caches per snapshot OBJECT via WeakMap; reusing one object
  //    would make every tick after the first return stale derives.
  const snap = {
    simTime: state.simTime,
    activeBodyIndex: state.activeBodyIndex,
    halted: !!state.halted,
    wind: (typeof wind !== 'undefined') ? {
      enabled: !!wind.enabled,
      speed: wind.speed || 0,
      directionDeg: wind.directionDeg || 0,
    } : { enabled: false, speed: 0, directionDeg: 0 },
    bodies: state.bodies,
  };
  
  // 5. Guidance tick on post-step state. Commands mutate state.bodies
//    targets; the NEXT iteration's physicsStep applies them.
try { Guidance.onSnapshot(snap); }
catch (ge) {
  self.postMessage({ type: 'workerError', message: 'guidance: ' + ge.message, stack: ge.stack });
}
  
  // Fast progress ping — simTime only. Tiny payload, cheap to
  // postMessage 80×/sim-minute.
  if (i % progressEvery === 0) {
  self.postMessage({
    type: 'progress',
    simTime: state.simTime,
    elapsedS: state.simTime - startSimT,
    bodies: state.bodies,
    activeBodyIndex: state.activeBodyIndex,
    halted: !!state.halted,
  });
}
  
  // Slower full-body ping — heavier structured clone, only fired
  // every 10 sim-sec so the total transfer cost over a long FF is
  // bounded.
  if (i % bodiesEvery === 0) {
    self.postMessage({
      type: 'progressBodies',
      simTime: state.simTime,
      bodies: state.bodies,
      activeBodyIndex: state.activeBodyIndex,
      halted: !!state.halted,
    });
    if (typeof Guidance !== 'undefined' && Guidance.getGuideStatus) {
      try {
        self.postMessage({ type: 'guideStatus', status: Guidance.getGuideStatus() });
      } catch (ge) {
        self.postMessage({ type: 'workerError', message: 'guideStatus: ' + ge.message, stack: ge.stack });
      }
    }
    // Yield so an incoming 'abort' can be processed.
    await new Promise(r => setTimeout(r, 0));
  }
  
  if (state.halted) break;
}
    
    self.__ffwDiag.actualEnd = state.simTime;
    self.__ffwDiag.actualTicks = typeof i !== 'undefined' ? i : -1;
    self.__ffwDiag.loopOvershoot = state.simTime - self.__ffwDiag.expectedEnd;
    self.__ffwDiag.wallMs = performance.now() - self.__ffwDiag.startWallMs;
    console.log('[ffw] done: actualEnd=' + state.simTime.toFixed(3) +
      ' overshootVsExpected=' + (state.simTime - self.__ffwDiag.expectedEnd).toFixed(3) + 's' +
      ' actualTicks=' + self.__ffwDiag.actualTicks +
      ' expectedTicks=' + self.__ffwDiag.maxTicks +
      ' wall=' + (self.__ffwDiag.wallMs / 1000).toFixed(2) + 's');

    // ---- Final export ----
self.postMessage({
  type: 'done',
  fullState: {
    bodies: state.bodies,
    activeBodyIndex: state.activeBodyIndex,
    simTime: state.simTime,
    halted: !!state.halted,
  },
    guidanceState: (typeof Guidance !== 'undefined' && Guidance.exportGuideState)
    ? Guidance.exportGuideState() : null,
});
  } catch (err) {
    self.postMessage({ type: 'workerError', message: String(err), stack: err && err.stack });
  }
};

// ---- Local dispatch (mirrors tester's) ----
function clampFlow(en, cmd) {
  if (!(cmd > 0)) return 0;
  const capped = Math.min(cmd, en.maxMassFlowRate || 0);
  return Math.max(capped, en.minMassFlowRate || 0);
}

function localDispatch(msg) {
  let b;
  if (Number.isInteger(msg.targetBodyIdx) && msg.targetBodyIdx >= 0 &&
      msg.targetBodyIdx < state.bodies.length) {
    b = state.bodies[msg.targetBodyIdx];
  } else {
    b = state.bodies[state.activeBodyIndex];
  }
  if (!b) return;
  switch (msg.type) {
    case 'setGimbalRate': {
      if (!b.engines) break;
      const onlyCenter = (msg.target === 'center');
      b.engines.filter(e => e.gimbal && (!onlyCenter || e.isCenter))
        .forEach(e => {
          const lim = e.gimbalRateDegS;
          e.targetGimbalRateDegS = Math.max(-lim, Math.min(lim, msg.degPerSec));
          e.targetGimbalAccelDegS2 = NaN;
        });
      break;
    }
    case 'setGimbalAccel': {
      // Guidance alpha command (deg/s^2), clamped per engine to its own accel limit.
      // Mirrors sim.js / physics.worker.js handler.
      if (!b.engines) break;
      const onlyCenter = (msg.target === 'center');
      b.engines.filter(e => e.gimbal && (!onlyCenter || e.isCenter))
        .forEach(e => {
          const lim = e.gimbalAccelDegS2;
          e.targetGimbalAccelDegS2 = Math.max(-lim, Math.min(lim, msg.degPerSec2));
        });
      break;
    }
    case 'setGimbal': {
      if (!b.engines) break;
      // Match physics.worker.js: a gimbal command unconditionally cancels
      // any pending separate/release sequence on this body — same human-
      // precedence rule, same call site.
      if (typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
      b.engines.filter(e => e.gimbal).forEach(e => {
        const lim = e.gimbalMaxDeg;
        e.targetGimbalDeg = Math.max(-lim, Math.min(lim, msg.deg));
        e.targetGimbalRateDegS = NaN;
        e.targetGimbalAccelDegS2 = NaN;
      });
      break;
    }
    case 'setAllThrottle': {
      if (!b.engines) break;
      // Match physics.worker.js: only NON-ZERO throttle commands cancel
      // pending sequences. Guidance's DONE/CIRCULARIZE phases fire
      // setAllThrottle(0) every tick as housekeeping; an unconditional
      // cancel would clobber an in-flight pendingRelease waiting for
      // engine spool-down, and the payload would never spawn.
      if (msg.value > 0 && typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
      b.engines.forEach(e => { e.targetMassFlowRate = clampFlow(e, msg.value); });
      break;
    }
    case 'setCenterThrottle': {
      if (!b.engines) break;
      if (msg.value > 0 && typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
      b.engines.filter(e => e.isCenter).forEach(e => {
        e.targetMassFlowRate = clampFlow(e, msg.value);
      });
      break;
    }
    case 'setGroupThrottle': {
      if (!b.engines) break;
      if (msg.value > 0 && typeof cancelPendingSequences === 'function') cancelPendingSequences(b);
      (msg.angles || []).forEach(a => {
        const en = b.engines.find(e => e.angleDeg === a);
        if (en) en.targetMassFlowRate = clampFlow(en, msg.value);
      });
      break;
    }
    case 'rcs': {
      if (!b.rcsCmd) b.rcsCmd = {};
      b.rcsCmd[msg.key] = !!msg.on;
      b.rcsDuty = null;
      break;
    }
    case 'rcsDuty': {
      // Match physics.worker.js: null/undefined duties = relinquish duty
      // control. Otherwise clamp every value to [0,1] — physics's
      // guarantee that a noisy duty payload can't drive a nozzle past
      // its physical envelope.
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
      if (!b.legs) b.legs = { deployed: false, progress: 0 };
      b.legs.deployed = !!msg.deployed;
      break;
    }
    case 'gridFinsDeploy': {
      if (!b || !b.gridFins) break;
      const gfType = (typeof bodyGridFinType === 'function') ? bodyGridFinType(b) : null;
      const maxDeploy = (gfType && gfType.typeConstants &&
          Number.isFinite(gfType.typeConstants.maxDeployDeg)) ?
        gfType.typeConstants.maxDeployDeg : 90;
      // Per-fin angle command: msg.angles = { L?, R?, FB? } in the SAME signed
      // convention as the fin state (0 = deployed; L/FB +maxDeploy and R
      // -maxDeploy = stowed; the opposite sign swings the fin toward the
      // nose). Missing keys leave that fin's target untouched.
      if (msg.angles && typeof msg.angles === 'object') {
        ['L', 'R', 'FB'].forEach(k => {
          const f = b.gridFins[k];
          const v = msg.angles[k];
          if (!f || !Number.isFinite(v)) return;
          f.targetDeploy = Math.max(-maxDeploy, Math.min(maxDeploy, v));
        });
        break;
      }
      ['L', 'R', 'FB'].forEach(k => {
        const f = b.gridFins[k];
        if (!f) return;
        if (msg.deployed) f.targetDeploy = 0;
        else f.targetDeploy = (k === 'R') ? -maxDeploy : maxDeploy;
      });
      break;
    }
    case 'gridFinsControl': {
      if (!b || !b.gridFins) break;
      // Match physics.worker.js: read the fin type's own control envelope
      // rather than hardcoding 90°. A different fin type declares its own
      // maxControlDeg on typeConstants.
      const gfType = (typeof bodyGridFinType === 'function') ? bodyGridFinType(b) : null;
      const maxCtrl = (gfType && gfType.typeConstants &&
          Number.isFinite(gfType.typeConstants.maxControlDeg)) ?
        gfType.typeConstants.maxControlDeg : 30;
      const f = b.gridFins.FB;
      if (f && Number.isFinite(msg.controlDeg)) {
        f.targetControl = Math.max(-maxCtrl, Math.min(maxCtrl, msg.controlDeg));
      }
      break;
    }
    case 'separate': {
      if (typeof requestSeparate === 'function') requestSeparate(b);
      break;
    }
    case 'splitFairing': {
      if (typeof splitFairingOnActiveBody === 'function') splitFairingOnActiveBody(b);
      break;
    }
    case 'releasePayload': {
      if (typeof requestReleasePayload === 'function') requestReleasePayload(msg, b);
      break;
    }
    case 'emergencyEject': {
      if (typeof emergencyEjectPayload === 'function') emergencyEjectPayload(b);
      break;
    }
    case 'takeControl': {
      if (typeof takeControlOfBody === 'function') takeControlOfBody(msg.idx);
      break;
    }
    case 'markIntentionalImpact': {
  if (b) b.intentionalImpact = true;
  break;
}
case 'pusherTorque': {
  b._sepTorqueAngAccel = Number.isFinite(msg.angAccel) ? msg.angAccel : 0;
  b._sepTorqueTargetOmega = Number.isFinite(msg.targetOmega) ? msg.targetOmega : null;
  break;
}
case 'openPayload': {
  if (!Number.isFinite(b.payloadOpenedAt)) {
    b.payloadOpenedAt = state.simTime;
  }
  break;
}
    default: break;
  }
}