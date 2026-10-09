# multi-step-project.md — Browser Param Tuner (leoInsertionV3)

**Rule:** Ek chat = ek step. Har step ke end pe `state.md` update/regenerate karo (usme next step ka exact "Attach" list hota hai).
**Main spec:** `prompt-web.md`. Baaki (`heuristic.md`, `PROMPT.md`, `tuner-config-v3.json`, `guidance-numerical.html`) = reference.
**Delivery:** files alag-alag (zip nahi). `js/*` aur `runner.js` kabhi mat badlo. Sirf `tuner/` naya.

---

## Step 0 — Recon + plan  ✅ (is chat me hua)
Files padhe, gaps pakde, ye plan + `state.md` banaya.
**Blockers cleared hone chahiye Step 1 se pehle:** state.md ka "Open questions" section.

---

## Step 1 — Skeleton + engine extract  ✅
- **Goal:** `tuner/leoV3-Param-S-idea.html` khule, sim engine load ho, koi tuner logic nahi.
- **Attach:** `guidance-numerical.html`, `state.md`, `prompt-web.md`, **`js/simJs/guidance/guidance.js`** (V3 section), `js/guideConfigDefaults.js`
- **Deliver:** main HTML shell (script tags `../js/...`, same SIM_FILES order, library-cache patch, `Derivation.setStackData` once), empty `tuner-config.js` (quanta, accuracy modes, weights, baseline), minimal log panel.
- **Done when:** page boot pe console clean, `Guidance.getGuideConfig('leoInsertionV3')` print ho.

## Step 2 — Utils: lattice snap + scoring  ✅
- **Deliver:** `tuner-utils.js` — `snapG/snapT/snapBias/snapLead/snapMeco`, `(G_index, Tn)` lattice, `A_eff`, `verifyApplied()` (getGuideConfig vs snapped), `score(metrics)`, hard-constraint checks.
- **Done when:** in-page self-tests pass (snap idempotent, collapse A→(G,T)→A_eff sahi, hierarchy test: orbit err > fuel > time).

## Step 3 — Per-tick hook + `runEval`  ✅
- **Deliver:** `tuner-hook.js` + `runEval(values, {stopAt})` async, `stopAt` ∈ `COAST_WAIT_ENTRY | CIRC_END | DEPLOY | FULL`. `__tickDump` hataya (overhead), sab metrics (prompt-web §5 list) hook se. Tick order = state.md "Locked decisions" ke hisaab se.
- **Done when:** ek eval chale, saare metrics fill, `runEval` pure async function (future worker-pool ready).

## Step 4 — Baseline + determinism + calibration  ✅ (baseline/determinism/speed done; E reference points pending)
- **Done:** baseline reproduced exactly (deploy 590.46, apo/peri 320.111/319.999, vrEnd 0.0460 engOff, margin 6.72, vrMin -0.380, maxQ 24.75, maxG 4.815, stageResidual 848.7, boosterFuel 52625), determinism bit-identical, ~6000 t/s phone, E@COAST_WAIT baseline = 0.172278.
- **Hook fixes made here:** stage body lookup (`findStage`), maxG = headless gLoad on bodies[0], vrEnd/marginS = engines-off values, stopAt label capture.
- **Pending (small):** run `Ref points E` button -> E for MECO 50000/55000 -> estimate E_min/E_max (write into state.md section 10 + config).

## Step 5 — INNER-2: circ lead search  (code delivered, real-sim run pending)
- **Attach:** `state.md`, `multi-step-project.md`, `prompt-web.md`, `tuner/` saari files, Ref points E log (if run).
- **Deliver:** `tuneLead()` in `tuner-core.js` using `stopAt:'CIRC_END'` — Phase 1 (no negative vr; ladder 50/20/10/5/2/1 ticks), Phase 2 (negative allowed, vrMin >= -2, vrEnd (engOff) >= 0 with buffer 0.02–0.05), stop margin 4–5 s. Tick-lattice steps, EvalCache. Output `{lead, leadTicks, marginS, vrEnd, vrMin, ok, evals, log[]}`. Add a "Tune lead (baseline)" button in html.
- **Done when:** baseline (A, bias, MECO 52612) pe lead search margin <= manual 6.72 s, vrEnd > 0, evals/wall reported.
- *(Order PROMPT.md ke correction se: lead pehle — INNER-1 har candidate pe isse call karega.)*

## Step 6 — INNER-1: (A, bias) joint search
- **Deliver:** `tuneAB()` — hard-lower check, push G down (1 gimbal), bias ladder (±0.5→0.1→0.05→0.01→…), extreme-bias → A relax + bias reset, E_max ke strictly neeche target, Fail-1/2/3 handling, truncated eval (COAST_WAIT entry).
- **Done when:** baseline MECO pe manual-equal ya better (A, bias) mile; eval count ~ low (target ≪ 900).

## Step 7 — Phase A: MECO outer loop
- **Deliver:** `findOptimalMeco()` — start 52612, step 3000–5000 → 1000 → 200 (→ final bracket/1 kg), warm start (previous + trend MECO↑ ⇒ bias↑, lead↓), residual ∈ [0, 50] kg.
- **Done when:** MECO converge, reference points (50000/55000) se sanity compare.

## Step 8 — Phase B: E-range sweep + ranking
- **Deliver:** `sweepE()` — N samples (mode se), har E pe tuneAB+tuneLead, score, rank ascending, adaptive refinement (Accurate mode).
- **Done when:** baseline score se equal/better best result.

## Step 9 — UI
- **Deliver:** `tuner-ui.js` — inputs (altitude, E range, environment, accuracy, Run/Stop), live progress (phase, MECO iter, E, evals, wall, t/s), ranked expandable blocks, Copy/Download JSON (applyGuideConfig format).
- **Done when:** end-to-end run UI se chale.

## Step 10 — Accuracy modes + final validation
- **Deliver:** Fast/Fine/Accurate step tables tuned, timing check (Fine ≈ 5–10 min), success criteria (prompt-web §12) 1–6 checklist, cleanup, worker-pool-ready abstraction note.
- **Done when:** saare 6 criteria tick; `state.md` final.

---

## Har step ke end pe (mandatory)
1. Files deliver (artifacts/files, zip nahi).
2. `state.md` regenerate: current step ✅, files + status, decisions, metrics numbers, **next step + exact attach list**, open questions.
3. Chat me sirf 2–3 line summary.
