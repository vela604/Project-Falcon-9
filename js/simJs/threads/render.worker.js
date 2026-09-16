// ============================================================================
// render.worker.js — canvas rendering on its own thread.
// ============================================================================

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

if (typeof window === 'undefined') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    devicePixelRatio: 1,
  };
}

let bootstrapped = false;
let renderLoopStarted = false;
let camera = null;

self.onmessage = (e) => {
  const msg = e.data;

  
  if (msg.type === 'hydrate' && !bootstrapped) {
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
      '../core/trajectoryMath.js',
      '../view/rocketArt.js',
      '../view/predictedTrajectory.js',
      '../view/render.js'
    );

    initCanvas = function() {};
    resizeCanvas = function() {};

    bootstrapped = true;
    self.postMessage({ type: 'ready' });
    return;
  }

  if (!bootstrapped) return;

  switch (msg.type) {
   case 'init': {
  if (!msg.canvas) {
    console.error('[render.worker] no canvas in init');
    return;
  }
  canvas = msg.canvas;
  ctx = canvas.getContext('2d');
  canvas.width = msg.width;
  canvas.height = msg.height;
  
  if (!renderLoopStarted) {
    renderLoopStarted = true;
    let tickCount = 0;
    let lastCrashReport = 0;
const tick = () => {
  tickCount++;
  try {
    renderFrame();
  } catch (err) {
    // A single bad frame — e.g. the transient state right after a
    // canvas resize, before the next camera/state message lands —
    // must NOT kill the loop. Previously we set renderLoopStarted
    // = false and returned, which silently froze rendering forever
    // the next time anything crashed. Instead, skip this frame and
    // retry on the next rAF; the state usually self-corrects.
    //
    // Errors are throttled to 2 per second so a persistent crash
    // doesn't flood the main console, but the loop stays alive and
    // can recover when the underlying issue resolves.
    const now = performance.now();
    if (now - lastCrashReport > 500) {
      lastCrashReport = now;
      self.postMessage({
        type: 'workerError',
        message: '[frame ' + tickCount + '] ' + err.message,
        stack: err.stack,
      });
    }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
  else setTimeout(tick, 16);
};
    tick();
  }
  break;
}
    case 'resize': {
  if (!canvas) return;
  const w = Math.max(1, msg.width | 0);
  const h = Math.max(1, msg.height | 0);
  if (w === canvas.width && h === canvas.height) return; // no-op
  canvas.width = w;
  canvas.height = h;
  break;
}
    case 'state': {
  state.activeBodyIndex = msg.data.activeBodyIndex;
  state.simTime = msg.data.simTime;
  state.halted = msg.data.halted;
  // Trajectory is optional — null means "nothing new this tick, keep
  // the cache". But when the checkbox is off the worker deliberately
  // sends null AND clears its own copy; the render worker still shows
  // the last frame's cached one. Respect the toggle directly here so
  // hiding works instantly.
  if (msg.data.trajectory) state.trajectory = msg.data.trajectory;
  else if (!showTrajectory) state.trajectory = null; // ← ye add karo
  state.separationFlash = msg.data.separationFlash;
  state.lastPayloadRelease = msg.data.lastPayloadRelease;
  state.bodies = msg.data.bodies;
  break;
}
    case 'camera': {
      camera = msg.camera;
      break;
    }
    case 'toggles': {
  showGrid = msg.showGrid;
  showVectors = msg.showVectors;
  showTrajectory = msg.showTrajectory;
  trajectoryMode = msg.trajectoryMode;
  break;
}
    }
  };
