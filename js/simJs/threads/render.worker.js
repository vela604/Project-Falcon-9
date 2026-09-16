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
        const tick = () => {
          tickCount++;
          
          try {
            renderFrame();
          } catch (err) {
            console.error('[render] CRASH:', err.message, err.stack);
            self.postMessage({ type: 'workerError', message: err.message, stack: err.stack });
            renderLoopStarted = false;
            return;
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
          else setTimeout(tick, 16);
        };
        tick();
      }
      break;
    }
    case 'resize': {
      if (canvas) { canvas.width = msg.width; canvas.height = msg.height; }
      break;
    }
    case 'state': {
      state.activeBodyIndex = msg.data.activeBodyIndex;
      state.simTime = msg.data.simTime;
      state.halted = msg.data.halted;
      if (msg.data.trajectory) state.trajectory = msg.data.trajectory;
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