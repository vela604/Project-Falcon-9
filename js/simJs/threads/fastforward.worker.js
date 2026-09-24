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
}
    
    // ---- Persistent snapshot wrapper (zero alloc per tick) ----
    const snap = {
      simTime: 0,
      activeBodyIndex: 0,
      halted: false,
      wind: { enabled: false, speed: 0, directionDeg: 0 },
      bodies: state.bodies,
    };
    
    const dt = CONFIG.DT;
const maxTicks = Math.ceil(msg.durationS / dt);
const progressEvery = Math.max(1, msg.progressEveryTicks || 80);
const bodiesEvery = Math.max(progressEvery, msg.bodiesEveryTicks || 800);
const yieldEvery = bodiesEvery;
const startSimT = state.simTime;
    
    for (let i = 0; i < maxTicks; i++) {
      if (_abort) break;
      
      // Refresh snapshot in-place.
      snap.simTime = state.simTime;
      snap.activeBodyIndex = state.activeBodyIndex;
      snap.halted = !!state.halted;
      snap.bodies = state.bodies;
      if (typeof wind !== 'undefined') {
        snap.wind.enabled = !!wind.enabled;
        snap.wind.speed = wind.speed || 0;
        snap.wind.directionDeg = wind.directionDeg || 0;
      }
      
      // Guidance reads pre-step state, then physics mutates.
      // Same order as the sim pipeline (physics.worker forwards
      // snapshot to guidance, then physicsStep runs).
      try { Guidance.onSnapshot(snap); }
      catch (ge) {
        self.postMessage({ type: 'workerError', message: 'guidance: ' + ge.message, stack: ge.stack });
      }
      
      try { physicsStep(dt); }
      catch (pe) {
        self.postMessage({ type: 'workerError', message: 'physics: ' + pe.message, stack: pe.stack });
        break;
      }
      
      // Fast progress ping — simTime only. Tiny payload, cheap to
// postMessage 80×/sim-minute. Keeps the progress bar and mission
// clock advancing smoothly instead of jumping 50 seconds at once.
if (i % progressEvery === 0) {
  self.postMessage({
    type: 'progress',
    simTime: state.simTime,
    elapsedS: state.simTime - startSimT,
  });
}

// Slower full-body ping — heavier structured clone, only fired
// every 10 sim-sec so the total transfer cost over a long FF is
// bounded. Panels redraw on this cadence.
if (i % bodiesEvery === 0) {
  self.postMessage({
    type: 'progressBodies',
    simTime: state.simTime,
    bodies: state.bodies,
    activeBodyIndex: state.activeBodyIndex,
    halted: !!state.halted,
  });
  // Yield so an incoming 'abort' can be processed.
  await new Promise(r => setTimeout(r, 0));
}
      
      if (state.halted) break;
    }
    
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
  const b = state.bodies[state.activeBodyIndex];
  if (!b) return;
  switch (msg.type) {
    case 'setGimbalRate': {
      if (!b.engines) break;
      const lim = CONFIG.GIMBAL_RATE_DEG_S;
      const rate = Math.max(-lim, Math.min(lim, msg.degPerSec));
      b.engines.filter(e => e.gimbal).forEach(e => { e.targetGimbalRateDegS = rate; });
      break;
    }
    case 'setGimbal': {
      if (!b.engines) break;
      const lim = CONFIG.GIMBAL_MAX_DEG;
      const d = Math.max(-lim, Math.min(lim, msg.deg));
      b.engines.filter(e => e.gimbal).forEach(e => {
        e.targetGimbalDeg = d;
        e.targetGimbalRateDegS = NaN;
      });
      break;
    }
    case 'setAllThrottle': {
      if (!b.engines) break;
      b.engines.forEach(e => { e.targetMassFlowRate = clampFlow(e, msg.value); });
      break;
    }
    case 'setCenterThrottle': {
      if (!b.engines) break;
      b.engines.filter(e => e.isCenter).forEach(e => {
        e.targetMassFlowRate = clampFlow(e, msg.value);
      });
      break;
    }
    case 'setGroupThrottle': {
      if (!b.engines) break;
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
      if (msg.duties == null) b.rcsDuty = null;
      else b.rcsDuty = msg.duties;
      break;
    }
    case 'legs': {
      if (!b.legs) b.legs = { deployed: false, progress: 0 };
      b.legs.deployed = !!msg.deployed;
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
    default: break;
  }
}