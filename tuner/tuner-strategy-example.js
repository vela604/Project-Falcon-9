// ============================================================================
// tuner-strategy-example.js — TEMPLATE for a new tuner strategy.
//
// A strategy is one file that calls TunerCore.registerStrategy(name, spec).
// spec = { label, describe, runTuner(point, opts) }.
//
// Contract for runTuner(point, opts):
//   INPUT
//     point  = lattice point { Gi, Tn, bi, li, meco }
//     opts   = {
//       hook, env, targetAltKm,        // passed through to TunerHook
//       abortRef,                       // {aborted:bool}; check periodically
//       cache,                          // shared EvalCache (TunerUtils.EvalCache)
//       onLog(line), onProgress(q),     // progress sinks (UI wires these)
//       evalLog,                        // true (default) | false — wrap hook with makeEvalLogger
//       ...strategy-specific opts       // your strategy can define its own
//     }
//   OUTPUT  must be a "runResult":
//     {
//       ok: bool,                     // true only if a feasible candidate was found
//       status: string,               // free-form short reason
//       bestPoint,                    // lattice point (TunerUtils.key-able)
//       bestScore,                    // Number (lower = better)
//       bestMetrics,                  // the raw metrics object from runEval
//       bestResidualKg, bestDeployS,
//       bestSource,                   // 'phaseX[tag]' or similar, for display
//       evals, breakdown, wallMs,     // counters
//       log: string[],                // full log lines (UI shows last N)
//       leaderboard: Row[],           // TunerUtils.makeRow rows for every verified candidate
//       meco,                         // final MECO (for display)
//     }
//   RULES
//     - Never mutate opts.hook; wrap with makeEvalLogger when opts.evalLog !== false
//     - Never mutate the point argument; copy first (Object.assign({}, point, {...}))
//     - Cache all sim calls through opts.cache (TunerUtils.EvalCache keyed by lattice point + stopAt)
//     - Call opts.onLog(line) for any line you want in the UI log
//     - Check opts.abortRef.aborted periodically and return early with ok:false
//     - For node tests, opts.hook is a mock — do not touch globals or the DOM
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore;

  async function runTuner(point, opts) {
    opts = opts || {};
    const U = root.TunerUtils, Cfg = root.TunerConfig, t0 = performance.now();
    const lines = [];
    const say = (s) => { lines.push(s); if (opts.onLog) opts.onLog(s); };
    const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

    // wrap the hook so evals are logged (opt-out via opts.evalLog === false)
    const hookBase = opts.hook || root.TunerHook;
    const hook = (opts.evalLog === false) ? hookBase : T.makeEvalLogger((s) => say(s), hookBase)();
    const targetAltKm = opts.targetAltKm != null ? opts.targetAltKm : Cfg.fixed.targetAltKm;
    const cache = opts.cache || new U.EvalCache();

    // --- YOUR SEARCH HERE ----------------------------------------------------
    // Example: just run tuneRough at the start point and return.
    const rr = await T.tuneRough(point, { hook, env: opts.env, targetAltKm, abortRef: opts.abortRef, cache, mode: 'fast' });
    const m = rr.metrics;
    const row = m && rr.point ? U.makeRow('E', 'example', rr.point, m, { deltaV: rr.deltaV, targetAltKm }) : null;
    const res = {
      ok: !!rr.ok, status: rr.ok ? 'ok' : rr.reason,
      bestPoint: rr.point, bestScore: rr.score, bestMetrics: m,
      bestResidualKg: m ? m.stageResidualKg : NaN, bestDeployS: m ? m.deployTimeS : NaN,
      bestSource: rr.ok ? 'example' : null,
      evals: rr.evals, breakdown: rr.evalBreakdown,
      wallMs: performance.now() - t0, log: lines,
      leaderboard: row ? U.sortRows([row], 'score') : [],
      meco: rr.point ? rr.point.meco : null,
    };
    say('=== strategy[example] ' + (res.ok ? 'OK' : 'FAILED') + ': ' + res.status + ' | evals=' + res.evals + ' wall=' + (res.wallMs / 1000).toFixed(1) + 's');
    return res;
  }

  // register with a short label and a one-line description for the UI dropdown
  T.registerStrategy('example', {
    label: 'Example (template)',
    describe: 'placeholder strategy — copy this file to build a new one',
    runTuner,
  });
})();