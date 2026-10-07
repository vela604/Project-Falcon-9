# tuner/STATE.md — Step 6 infra DONE (offline); E-map RUN pending (needs real sim)

## Decision
CMA-ES hata diya. Guided search (see PROMPT.md v2). Last-mile polish = lattice pattern-search.

## Step 6 changes (this chat)
- hook-sandbox.js: bug fix. New `M.coastEnd` captured on COAST_ROTATE -> next phase (COAST_WAIT) transition
  (poll tracks prevPh). Fields: apo/peri/e/vr, stageFuelKg, t, fromPhase/toPhase, `exactTick` (false => transition
  caught late because stride>1). New stop point `stopAt: 'coastRotateEnd'`. `M.coast` (entry) kept for comparison.
- evaluator.js: `eval: 'coastEnd'` (evalKind 'coastEnd', stopAt coastRotateEnd); metrics coastEndApoKm/PeriKm/Ecc/Vr,
  stageFuelAtCoastEndKg, coastEndT, coastEndToPhase, coastEndExactTick; scoreMetrics short-circuit for coastEnd
  (pre-coast hard fails only, score = coastEndEcc, no crash on missing full-mission fields);
  `opts.stride` override (strideOf); cache key = context(stride) + evalKind + stride + lattice.
  Full evals also record coastEnd (so entry vs exit comparable in one run).
- emap.js (new): 8x11 grid (A 13.2-15.0, bias 0.4-1.4), MECO 52612, lead 5.525, eval {eval:'coastEnd', stride:1}.
  Prints ecc(1e-6) + log10 heatmaps, writes emap.json / emap.csv. `--e-max X` => per-A crossings (log-interp, reports
  all crossings per row = handles non-monotone band). `--from emap.json --e-max X` re-extracts with ZERO evals.
- verify-coastend.js (new): baseline full eval (raw defaults, stride 1), prints entry vs exit ecc; exit 1 if identical.
- test-evaluator.js: +4 tests (coastEnd exact tick, entry!=exit time, short-circuit/pool finalize, cache key). 31/31 pass offline.
- Finding (stub): default stride 4 catches the transition up to 3 ticks late (25.05 vs 25.0125) => stride 1 mandatory for E.

## NOT done (no real sim in this workspace; js/ tree absent)
- Baseline verify: run `node tuner/verify-coastend.js`. Expect exit ecc != entry ecc, exactTick=true.
- E-map run: `node tuner/emap.js --workers 6` (88 evals, ~5-8 min). Then pick E_max from heatmap.
- E_max: TBD — need user input (order of magnitude). First run is without E_max by design.
- Validation of E_max candidates via full evals (MECO 50000/55000 refs) after E_max chosen.

## Open / next
- Step 4: checkpoint feasibility (measure WALL speedup first). Deferred; decide after Step 7 eval counts.
- Step 7: INNER-1 boundary tracer uses emap output (per-A crossings) as warm start.
- Note: hard-flagged cells (maxQ/maxG) still report ecc; the mapper does not drop them.
