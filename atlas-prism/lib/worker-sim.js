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

// Alias window=self so sim files referencing window.* work in the worker.
// localStorage is already stubbed above; self.addEventListener exists in workers.
// window.document is deliberately NOT stubbed — files that need it will throw,
// and we can add a targeted stub if that specific access shows up.
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
      '../lib/hook.js',
      '../lib/registry.js',
      '../lib/primitives.js',
      '../engines/pro-alpha.js'
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
    } else if (type === 'probeWithLead') {
      // Full chain: tuneLead + FULL eval, returns score.
      const point = payload.point;
      const altKm = payload.altKm != null ? payload.altKm : 320;
      const cache = new TunerUtils.EvalCache();
      const lr = await TunerCore.tuneLead(point, {
        hook: TunerHook, cache, targetAltKm: altKm,
      });
      if (!lr.ok) {
        result = { ok: false, reason: 'lead_failed: ' + lr.reason, lead: lr.lead, margin: lr.marginS, evals: lr.evals };
      } else {
        const m = await TunerHook.runEval(lr.point, { stopAt: 'FULL', targetAltKm: altKm, quiet: true });
        const sc = TunerUtils.score(m, { targetAltKm: altKm });
        result = {
          ok: sc.ok, lead: lr.lead, margin: lr.marginS, vrEnd: lr.vrEnd,
          score: sc.score, reasons: sc.reasons, parts: sc.parts,
          metrics: {
            endReason: m.endReason, deployTimeS: m.deployTimeS,
            apogeeKm: m.apogeeKm, perigeeKm: m.perigeeKm, ecc: m.ecc,
            boosterFuelLeftKg: m.boosterFuelLeftKg, stageResidualKg: m.stageResidualKg,
            maxQKPa: m.maxQKPa, maxG: m.maxG,
            payloadCleared: m.payloadCleared, payloadReleased: m.payloadReleased,
            crashed: m.crashed,
          },
          evals: lr.evals + 1,
        };
      }
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