// registry.js — strategy registry + eval logger.
// Load order: AFTER lib/hook.js, BEFORE engines/*.js.
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

const STRATEGIES = Object.create(null);
  function registerStrategy(name, spec) {
    if (!name || typeof spec !== 'object' || typeof spec.runTuner !== 'function') {
      throw new Error('registerStrategy: need {name, spec.runTuner}');
    }
    STRATEGIES[name] = Object.assign({ name }, spec);
    return STRATEGIES[name];
  }
  function listStrategies() { return Object.keys(STRATEGIES); }
  function getStrategy(name) { return STRATEGIES[name] || null; }


    function makeEvalLogger(log, baseHook) {
      const H = baseHook || root.TunerHook;
      let n = 0;
      return function wrappedHook() {
        return {
          runEval: async (point, opts) => {
            n++;
            const id = n;
            const o = opts || {};
            const stopAt = o.stopAt || 'FULL';
            const pt = 'G=' + (point.Gi * 0.01).toFixed(2) + ' T=' + (point.Tn * 0.000125).toFixed(4) +
              ' b=' + (point.bi * 0.0001).toFixed(4) + ' l=' + point.li + 't m=' + point.meco;
            log('  ▶ eval #' + id + ' [' + stopAt + '] ' + pt);
            const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            try {
              const m = await H.runEval(point, o);
              const ms = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
              const parts = ['end=' + (m.endReason || '?'), 'wall=' + (ms / 1000).toFixed(1) + 's'];
              if (Number.isFinite(m.eCoast)) parts.push('E=' + m.eCoast.toFixed(4));
if (Number.isFinite(m.coastDeltaV)) parts.push('Δv=' + m.coastDeltaV.toFixed(1));
              if (Number.isFinite(m.apoCoastKm)) parts.push('apoC=' + m.apoCoastKm.toFixed(1));
              if (Number.isFinite(m.marginS)) parts.push('marg=' + m.marginS.toFixed(2));
              if (Number.isFinite(m.vrEnd)) parts.push('vrEnd=' + m.vrEnd.toFixed(4));
              if (Number.isFinite(m.stageResidualKg)) parts.push('resid=' + m.stageResidualKg.toFixed(1));
              if (Number.isFinite(m.deployTimeS)) parts.push('deploy=' + m.deployTimeS.toFixed(1));
              if (m.crashed) parts.push('CRASH');
              if (m.payloadCleared) parts.push('CLEARED');
              log('  ◀ eval #' + id + ' ' + parts.join(' '));
              return m;
            } catch (e) {
              log('  ✗ eval #' + id + ' ERROR: ' + ((e && e.message) || e));
              throw e;
            }
          }
        };
      };
    }

  Object.assign(T, {
    registerStrategy, listStrategies, getStrategy,
    STRATEGIES, makeEvalLogger,
  });
})();
