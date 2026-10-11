// worker-sim.js — sim instance running in a Web Worker.
//
// Loads the same sim files as the main page (importScripts), then exposes
// a job interface via postMessage. Currently the only job type is 'runEval'.
//
// IMPORTANT: Web Workers have no localStorage. fleet.js / componentLibrary.js
// both read from it at load time. We stub localStorage with an in-memory
// store and hydrate it from the main thread BEFORE the sim files load.
//
// Load order inside the worker matches atlas-prism/index.html exactly.

// ---- 1. Provide a fake localStorage before anything else loads ----
self.localStorage = (function() {
  const _data = Object.create(null);
  return {
    getItem(k) { return k in _data ? _data[k] : null; },
    setItem(k, v) { _data[k] = String(v); },
    removeItem(k) { delete _data[k]; },
    clear() { Object.keys(_data).forEach(k => delete _data[k]); },
    get length() { return Object.keys(_data).length; },
    key(i) { return Object.keys(_data)[i] || null; },
    _raw() { return _data; },
    _populate(obj) { Object.keys(obj || {}).forEach(k => { if (obj[k] != null) _data[k] = String(obj[k]); }); }
  };
})();

// Some sim files may reference window; alias to self so nothing crashes.
self.window = self;

// ---- 2. Job state ----
let _loaded = false;
let _bootError = null;

function _loadSim() {
  if (_loaded) return;
  try {
    importScripts(
      '../../js/componentLibrary.js',
      '../../js/customDesign.js',
      '../../js/fleet.js',
      '../../js/config.js',
      '../../js/simJs/core/massProps.js',
      '../../js/simJs/core/environment.js',
      '../../js/simJs/core/vehicle.js',
      '../../js/simJs/core/rcs.js',
      '../../js/simJs/core/physics.js',
      '../../js/simJs/core/collision.js',
      '../../js/simJs/guidance/imu.js',
      '../../js/simJs/guidance/derivation.js',
      '../../js/simJs/guidance/guidercs.js',
      '../../js/simJs/guidance/guidance-blocks.js',
      '../../js/simJs/guidance/guidance.js',
      '../../js/guideConfigDefaults.js',
      '../lib/config.js',
      '../lib/sim.js',
      '../lib/lattice.js',
      '../lib/hook.js'
    );
    if (typeof TunerEngine === 'undefined') throw new Error('TunerEngine not loaded');
    TunerEngine.init();
    _loaded = true;
  } catch (e) {
    _bootError = (e && e.message) || String(e);
    throw e;
  }
}

// ---- 3. Message handler ----
self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type, payload } = msg;
  
  if (type === 'hydrate') {
    self.localStorage._populate(payload && payload.keys);
    try {
      _loadSim();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'ready', error: _bootError });
    }
    return;
  }
  
  if (!_loaded) {
    self.postMessage({ id, ok: false, error: 'sim not loaded (hydrate first)' });
    return;
  }
  
  try {
    let result;
    if (type === 'runEval') {
      result = await TunerHook.runEval(payload.point, payload.opts || {});
    } else if (type === 'runEvalValues') {
      result = await TunerHook.runEvalValues(payload.values, payload.opts || {});
    } else if (type === 'ping') {
      result = { pong: true, hasTunerEngine: typeof TunerEngine !== 'undefined' };
    } else {
      throw new Error('unknown job type: ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};