
---

PROMPT — tuner/leoV3-Param-S-idea.html (browser-based parameter tuner)

0. Context

Main SEHRAN, browser-based Falcon 9 Block 5 simulator. Multi-worker architecture — physics.worker.js, guidance.worker.js, render.worker.js. Guidance leoInsertionV3 (320 km circular LEO, Falcon 9 B5 stack) ko tune karna hai.

Ab tak ka safar: headless Node.js tuner bana tha (inner1.js, inner2.js — structural boundary tracing + bracket search). Kaam karta hai par 6x slow hai browser ke comparison (vm.createContext sandbox overhead). Code bhi over-engineered — ~900 evals per MECO iteration jahan manual flow sirf ~12-15 sims leta hai. Isliye plan badal diya: browser me tuner banao, guidance-numerical.html ke engine ko reuse karo.

Target: ek multi-file browser tool, guidance-numerical.html ke speed pe (4500 t/s single-thread), jo mera manual heuristic automate kare.

1. Kya banana hai — folder structure

Root me naya folder tuner/ banao. Multi-file rakhna hai, single file nahi (size aur maintainability).

Suggested structure (tujhe freedom hai — agar better lage to adjust kar):

```
tuner/
├── leoV3-Param-S-idea.html     ← main page (UI shell, engine script tags)
├── tuner-core.js                ← search algorithm (Phase A + Phase B)
├── tuner-hook.js                ← per-tick metrics collection
├── tuner-ui.js                  ← output blocks, progress, JSON export
├── tuner-config.js              ← accuracy modes, weights, quanta constants
└── (optional) tuner-utils.js    ← lattice snap, scoring, helpers
```

IMPORTANT: tuner/leoV3-Param-S-idea.html ke andar <script src="..."> paths relative se root tak jaate hain. Jaise:

```html
<script src="../js/componentLibrary.js"></script>
<script src="../js/simJs/guidance/guidance.js"></script>
<script src="tuner-core.js"></script>
<script src="tuner-ui.js"></script>
```

Sim engine files (js/*) reuse kar, copy mat kar. Sirf tuner-specific files tuner/ folder me rahenge.

2. Heuristic — jo automate karna hai

2.1 Core concept — A aur bias joint actor hain

· A = ascent profile constant (PUSH_MAX_GIMBAL_DEG × PUSH_T_S², gravity turn kick).
· bias = STAGE_BURN_AOA_BIAS_DEG (stage burn tilt evolution rate).

Ye alag tunables nahi. Jointly decide karte hain MECO pe state + stage burn trajectory + RCS boost ke baad ka eccentricity E = f(A, bias). 1D+1D me todkar solve nahi kar sakte.

Direction conventions:

· A high → rocket zyada tilt → kam radial velocity vr → zyada horizontal
· A low → rocket zyada vertical → zyada vr → kam horizontal
· bias low (~0) → tilt fast evolve → aggressive rotation
· bias high (~1+) → tilt slow evolve → gentle rotation
· Combined: low A + low bias = aggressive. High A + high bias = gentle.

2.2 Failure modes (signals)

Fail 1 — Aggressive overshoot: stage burn me apogee se pehle vr negative ho jaye. Hard fail.
→ Gentle direction: A thora badhao ya bias thora badhao.

Fail 2 — Gentle undershoot: apogee 320 km tak nahi pahunchi stage burn ke andar, ya ecc bahut high (E > E_max).
→ Aggressive direction: A thora ghatao ya bias thora ghatao.

Fail 3 — Hard lower: very low A + very fast bias, itna aggressive ki koi adjust kaam nahi karega. A relax karo, bias reset, retry.

2.3 Bearable eccentricity band

Range (E_min, E_max). Target = E_max ke paas, strictly neeche (knife edge pe nahi, numerical noise se fail risk). E COAST_ROTATE exit pe measure hota hai (COAST_WAIT ka pehla tick).

2.4 (A, bias) joint search

Priority: A minimum pe le jao (drag, time), phir bias fine tune.

Step A — Hard lower check: stage burn me vr negative? → gentle direction.

Step B — Push A down: A ko gimbal quanta (0.01 deg) steps me ghatate jao. Stop when:

· E E_max cross kare → A 1 step wapas
· vr negative ho → same
· A itni low ki koi bias E_max tak nahi pahuncha sakta → A relax

Step C — Bias fine tune: hybrid bisection ±0.5 → ±0.1 → ±0.05 → ±0.01 (progressive smaller). Stop when improvement ≤ current quantum.

Step D — Bias extreme (±2 / 2.5)? → A relax, bias reset, retry.

2.5 Circ lead search

Phase 1: lead ghatate jao, margin minimize bina vr negative jaane. Practically ~6-7s pe stuck hota hai.

Phase 2: negative vr allow, aur reduce karo. Stop when margin 4-5s pe.

· vrMin negative allowed, recovery expected.
· vrEnd (burn end) always positive, ~0.02-0.05 m/s buffer (bilkul 0 nahi).

2.6 MECO outer loop

Signal = post-deploy stage fuel residual. Target 0-50 kg (deorbit off).

· Residual > 50 → MECO badhao
· Residual < 0 / fail → MECO ghatao

Step: 3000-5000 → 1000 → 200. Loop 2-3 baar. Warm start from previous iteration's (A, bias, lead).

3. Hardware accuracy — ye critical hai, dhyan se padho

Sim bit-identical determinism rakhta hai, aur hardware ke har actuator ka least count (quantum) hai. Tuner ko kabhi bhi off-lattice value sim ko nahi bhejni. Har candidate pehle lattice-snap hoga, phir eval hoga.

3.1 Tunables ke quanta (least counts)

Tunable Quantum Notes
PUSH_MAX_GIMBAL_DEG 0.01 deg Hardware gimbal quantum
PUSH_T_S 0.000125 s Fine grid (T continuous hai, tick-quantized nahi — Step 3 tscan ne confirm kiya)
STAGE_BURN_AOA_BIAS_DEG 0.0001 deg 4 decimals hardware accuracy
STAGE_BURN_AOA_MARGIN_DEG 0.0001 deg Fixed, tunable nahi
CIRC_TRIGGER_LEAD_S 0.0125 s = 1 tick Integer tick (1/80 s sim DT)
MECO_TARGET_BOOSTER_FUEL_KG 1 kg Integer

3.2 Ascent collapse — (G, T) me search karo, A me nahi

A = G × T² ka collapse aisa hai:

1. G_raw = A / T0² → round to 0.01 deg → G
2. T_raw = sqrt(A / G) → round to 0.000125 s → T
3. A_eff = G × T²

Yani A_eff derived quantity hai. Search directly (G, T) space me karo, A me nahi. Kyun:

· A → (G, T) → A_eff ek sawtooth hai. Ek A step me T snap ho sakta hai (G jump aata hai har ~0.232 A pe).
· Same A_eff pe do alag (G, T) pairs possible — "redundant solutions" (Step 3 diag-a-collapse.js ne confirm kiya).
· Sim ko (G, T) milta hai, A_eff nahi. Do (G, T) jo same A_eff dete hain, physics me different behave karte hain.

Tuner ka A-coordinate matlab: search (G_index, Tn) me karo. G_index = round(G / 0.01), Tn = round(T / 0.000125). Ye integer lattice hai. A_eff = G × T² sirf reporting ke liye.

3.3 Lattice snap — har candidate pe

Har eval submit karne se pehle:

1. G quantize: G = round(G_raw / 0.01) × 0.01
2. T quantize: Tn = round(T_raw / 0.000125), T = Tn × 0.000125
3. bias quantize: bias = round(bias_raw / 0.0001) × 0.0001
4. lead quantize: leadTicks = round(lead_raw / 0.0125), lead = leadTicks × 0.0125
5. MECO quantize: meco = round(meco_raw) (integer kg)

Snapped values ko Guidance.applyGuideConfig() me bhejo. Sim ko sirf snapped values dikhni chahiye.

3.4 Verifying snap — tolerance

Jab sim eval ho jaaye, Guidance.getGuideConfig() se check karo ki applied values snapped values se match karti hain. Match nahi to error — matlab snap logic me bug hai.

3.5 Search steps ke liye implication

Accuracy modes ke step sizes quanta ke multiples hone chahiye:

· A step 0.01 deg (gimbal) — but actually G me 1 gimbal = 1 step
· T step 1 quanta = 0.000125 s
· bias step 0.0001 deg (hardware min), par practically coarser start
· lead step 1 tick = 0.0125 s

"Fast" mode me steps larger (multiples of quanta). "Accurate" mode me steps = 1 quanta. Isse budget control hota hai.

4. Two-phase flow

Phase A — Optimal MECO discovery:
MECO=52612 se start, upar wala full heuristic chalao (rough, minimum evals). Output = optimal MECO (residual ∈ [0, 50] and mission succeeds).

Phase B — E range sweep at optimal MECO:
Us MECO pe, user-given E range (UI input, e.g. 0.25-0.35) me N sample points. Har E pe (A, bias, lead) tune karo. Score calculate karo. Rank karo. Best E wala final pick.

Scoring:

· Apogee error (target 320 km, tol ±1 km, scale 1, weight 3000)
· Perigee error (same)
· Eccentricity (target 0, tol 0.0005, scale 0.001, weight 1500)
· Booster fuel left (maximize, weightPerKg 0.01)
· Time to deploy (minimize, weightPerS 0.0005)
· Hard constraints: maxQ ≤ 31 kPa, maxG ≤ 6.02, no crash, vrEnd ≥ 0, payload released.

5. Engine — guidance-numerical.html se kya lena hai

guidance-numerical.html me pura sim engine hai. Ye 1:1 reuse karo:

· SIM_FILES load order (script tags ../js/ se)
· state, physicsStep, Guidance.onSnapshot, localDispatch, buildSnapshot
· Derivation.setStackData handoff (page load pe ek baar)
· applyEnvironment, applyFueling
· resetState(0), Guidance.applyGuideConfig, Guidance.startGuide, Guidance.stopGuide

Critical invariants (guidance-numerical.html me comment me likhe hain, MAT TODO):

· Tick order: physicsStep(dt) → buildSnapshot() → Guidance.onSnapshot(snap). Ye 1-tick pipeline latency match karta hai real architecture.
· buildSnapshot() me b.pods = buildPodEntries(b) every tick MUST run (RCS guidance depend karta hai).
· Derivation.setStackData ek baar page load pe, guide start se pehle.

Metrics jo har eval se chahiye (per-tick hook chahiye, event-based nahi):

· E at COAST_ROTATE exit (COAST_WAIT entry tick) — critical
· vr min during stage burn — hard lower check
· vr min during circ burn, vrEnd (burn end)
· Time to apogee at circ burn end — margin
· Post-deploy stage residual fuel — MECO signal
· Final apogee/perigee/ecc at deploy
· Deploy time, booster fuel at separation
· maxQ, maxG, crash status

guidance-numerical.html me event-based capture hai. Per-tick hook insert karo — physicsStep ke baad ek __tunerHook(state) call jo ye metrics track kare. Tu decide kar — hook insert karna, ya existing __tickDump array se derive karna. Jo cleaner lage.

6. UI

6.1 Inputs (top panel)

· Target orbit altitude (km) — number, default 320
· E range — two number inputs, default 0.25 / 0.35
· Environment — wind, atmosphere on/off, slosh on/off, IMU noise, booster%, stage%
· Accuracy mode — Fast / Fine / Accurate (Section 7)
· Run button / Stop button

6.2 Output — rank-wise expandable blocks

Score ascending order (lower = better). Top pe "Best overall" prominently.

```
┌─────────────────────────────────────────────┐
│ #1  Score 128.4   E=0.298   deploy 587.2s   │ ← collapsed
│     A=13.87  bias=0.612  lead=5.4125        │
└─────────────────────────────────────────────┘
    ↓ expand
┌─────────────────────────────────────────────┐
│ #1  Score 128.4   E=0.298   deploy 587.2s   │
│  apogee 320.14   perigee 319.87   ecc 8.4e-6│
│  maxQ 24.8   maxG 4.81   residual 42 kg     │
│  vrEnd 0.031   vrMin -0.36   margin 4.6s    │
│  MECO 52850   G=0.61   T=4.82815   bias=0.612│
│  evals 14   wall 3.2 min                    │
│  [Copy JSON]  [Download JSON]               │
└─────────────────────────────────────────────┘
```

JSON format: { ascent: { PUSH_MAX_GIMBAL_DEG, PUSH_T_S }, insertion: { STAGE_BURN_AOA_BIAS_DEG, CIRC_TRIGGER_LEAD_S }, ascent: { MECO_TARGET_BOOSTER_FUEL_KG } } — jo Guidance.applyGuideConfig() accept karta hai.

6.3 Progress

Live status: current phase, MECO iteration, E value, evals done, wall time, t/s. Progress bar ya phase indicator.

7. Accuracy modes

· Fast: coarse. A/G step 5 gimbal (0.05), bias step 0.05, lead step 5-10 ticks, T step 5 quanta. E samples N=5. Target ~2-3 min, precision ±0.05 A, ±0.05 bias, ±0.05 lead.
· Fine: medium. G step 1-2 gimbal, bias step 0.01, lead step 2-4 ticks, T step 1-2 quanta. E samples N=8. Target ~5-8 min.
· Accurate: full lattice. G step 1 gimbal, bias step 0.001 (ya eventually 0.0001), lead step 1 tick, T step 1 quanta. E samples N=12 with adaptive refinement. Target ~15-25 min.

Exact steps tune kar — ballpark hai. Tu decide kar.

8. Freedom — tujhe poori azadi hai

· E samples adaptive — flat landscape ho to fewer, steep ho to more.
· Phase A / Phase B interleaving — sequential mera default hai, par agar better lage per-iteration E sweep, kar.
· Convergence criteria — tune kar.
· Metrics collection method — per-tick hook ya __tickDump derive.
· Code structure — modular rakh, but exact module boundaries tujhe decide.
· UI styling — guidance-numerical.html ka CSS reuse kar consistency ke liye.

Ek zaroori constraint: sim bit-identical determinism rakhni hai. Same input = same output.

9. Future note (abhi nahi karna, par jagah rakhna)

Abhi single-thread (4500 t/s). Future me multi-core worker pool chahiye — navigator.hardwareConcurrency workers, har ek me sim instance, eval jobs queue se. 8-16x speedup milega (Ryzen 9 32-thread pe 100k+ t/s). Abhi code structure aisa rakh ki runEval(values) async function single-thread me direct call ho, par later worker pool me convert karna easy ho. Iske liye abhi design decision mat lo — bas ek clean abstraction rakhna.

10. Rules / gotchas

1. runner.js, js/* mat badlo. Sirf tuner/ folder naya.
2. quiet: true equivalent — console spam avoid.
3. Deorbit always off (done.DEORBIT_ENABLED = false).
4. MECO fuel-triggered only.
5. Stage residual target 0-50 kg.
6. Circ lead = integer tick. A = (G, T) lattice. Bias = 0.0001 deg. MECO = 1 kg.
7. circVrAtEndMinMps.min = 0 — sirf sign check (vrEnd ≥ 0). Margin khud target hai.
8. stage_burn_aoa_margin fixed 0.001 — tunable nahi.

11. Files attached

· guidance-numerical.html — engine source
· tuner-config-v3.json — weights, quanta, bounds
· PROMPT.md — architecture reference
· HEURISTIC.md — agar alag ho (warna is prompt me hai)

12. Success criteria

1. tuner/leoV3-Param-S-idea.html browser me khule, sim chale, no build step.
2. Input panel se orbit altitude + E range + environment + accuracy mode set ho.
3. Phase A → Phase B flow chale, live progress dikhe.
4. Rank-wise expandable blocks, sab metrics + constants JSON + copy/download.
5. 320 km, E range 0.25-0.35, "Fine" mode me ~5-10 min me converge, output scores print.
6. Baseline (MECO=52612, A=13.94, bias=0.59, lead=5.525) se equal ya better score.

13. Freedom again

Agar koi design decision better lage, kar. Ambiguous lage to poochh le, assume mat kar. Manual heuristic faithfully automate karna hai, browser speed pe.

Pehle ek plan outline de — kaunse modules, engine kaise extract, hook kaise insert, search flow kaise likhega — phir code.

---

