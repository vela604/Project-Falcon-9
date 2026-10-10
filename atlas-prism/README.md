# atlas-prism — Param Tuner

Browser-based autotuner for `leoInsertionV3` (and future guidances). No
build step, singleton sim, bit-identical determinism. Reads the sim's
`js/*` files but never writes to them.

## Layout

```
atlas-prism/
├── index.html              main UI shell (script order matters)
├── lib/
│   ├── config.js           constants, quanta, bounds, weights
│   ├── sim.js              sim bootstrap (init, prepareRun, tick)
│   ├── lattice.js          snap, collapse, score, verify
│   ├── hook.js             per-tick metrics + runEval
│   ├── registry.js         strategy registry + eval logger
│   └── primitives.js       search algorithm building blocks
├── engines/
│   └── _template.js        copy this to add a new engine
├── ui/
│   └── host.js             inputs, progress, leaderboard
└── tests/
    └── mock.js             node test — must pass before commit
```

## Script load order (index.html)

MUST be exactly:
```
lib/config.js → lib/sim.js → lib/lattice.js → lib/hook.js → lib/registry.js → lib/primitives.js
→ engines/*.js (any number, in any order)
→ ui/host.js
```

`lib/registry.js` defines `TunerCore.registerStrategy`; `lib/primitives.js` defines the search algorithms (tuneLead, tuneAB, tuneRough, findOptimalMeco); engines register into
it; `ui/host.js` calls `TunerCore.listStrategies()` at mount. Reversing any
pair breaks registration.

## Engine contract

An engine is one file that calls:
```js
TunerCore.registerStrategy('proAlpha', {
  label: 'Pro-Alpha Engine',
  describe: 'MECO → A/bias → lead',
  runTuner(point, opts) { /* returns §Result shape */ },
});
```

**Result shape** (see `ARCHITECTURE.md` §2.7):
```js
{
  ok, status, bestPoint, bestScore, bestMetrics,
  bestResidualKg, bestDeployS, bestSource,
  evals, breakdown, wallMs, log[], leaderboard[], meco,
}
```

`opts` shape:
```js
{
  hook,             // optional — mock for tests
  env, targetAltKm, // sim environment
  abortRef,         // { aborted: bool }
  cache,            // shared EvalCache
  onLog(line), onProgress(q),
  evalLog,          // true (default) | false
  mode,             // 'fast'|'fine'|'accurate'
  ...engine-specific opts
}
```

## Metrics contract

`TunerHook.runEval(point, { stopAt })` returns a flat object. **All scalar** —
no objects, no arrays. Determinism check relies on `Object.is`.

Key fields: `endReason, ticks, simTimeEnd, wallMs, coastDeltaV, eCoast,
apoCoastKm, periCoastKm, vrMin, vrEnd, marginS, deployTimeS, mecoTimeS,
boosterFuelLeftKg, stageResidualKg, apogeeKm, perigeeKm, ecc, maxQKPa,
maxG, payloadReleased, payloadCleared, crashed`.

See `lib/hook.js` for the full list and semantics.

## Adding a new engine — recipe

1. `cp engines/_template.js engines/pro-beta.js`
2. Change `registerStrategy('example', ...)` → `registerStrategy('proBeta', ...)`
3. Implement `runTuner(point, opts)`. Compose from `TunerCore` primitives
   (`tuneLead`, `tuneAB`, `tuneRough`, `findOptimalMeco`) or roll your own.
4. Add `<script src="engines/pro-beta.js"></script>` to `index.html`
   between `engines/*.js` and `ui/host.js`.
5. Nothing else — dropdown populates automatically.

Test: `node tests/mock.js` should still pass. Browser: dropdown shows
"Pro-Beta" alongside the built-in.

## Node test

```bash
cd atlas-prism/tests
node mock.js
```

Prints `PASS`/`FAIL` per assertion, exits 0 on ALL PASS. The mock uses
`global.window = global` and `require()` on `lib/*.js` — no DOM, no sim.
Integration tests (findOptimalMeco, runTuner) are shape-only on the mock
because the synthetic Δv surface doesn't match the real sim exactly; the
individual algorithm tests (tuneAB, tuneRough, tuneLead) run with full
assertions.

Real-sim convergence is verified in the browser, not in the mock.

## State

`state.md` in this directory is the latest snapshot of:
- what step we're on
- known bugs / pending items
- recent changes log
- attach list for the next chat

Update it at the end of every work session.