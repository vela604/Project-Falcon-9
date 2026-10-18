## UPDATE (7th session) — SABSE PEHLE YE PADHO (6th-session section ke upar paste karo)

Likha: 2026-10-18 raat. Hinglish. Koi patch abhi apply NAHI hua; ye session sirf verify + audit + plan tha.

### A. Verify ho chuka
- Page par `GIMBAL_ACCEL_ON=true` ke saath overlay: `snap gap 1:100%`, `cmd latency 0:100%`. Matlab page path bench jaisa hai (g_N1 wala version ki zaroorat nahi).

### B. User ke decisions (7th session)
1. `a_max = 200 deg/s^2`, retune 320 km par.
2. **Flag hatao.** Accel model hamesha ON. Purana OFF model git tag `pre-gimbal-accel` mein rahega (user ko tag lagana hai).
3. `gimbalAccelDegS2`, `gimbalRateDegS`, `gimbalMaxDeg` **engine/thruster type ki property** (componentLibrary.js), global CONFIG nahi.
4. Guidance mein `HOLD_LAW` flag bhi hatao; `aoa_pd` hi ek law rahe.
5. RCS_BOOST duration ka B7 abhi hypothesis: retune ke baad har point ka duration dekho, 10x jhoole to apogee-error-vs-time plot add karo.
6. Mera suggestion (user ne confirm nahi kiya): human slider (angle-slew path) bhi accel-limited ho, ek hi actuator model.

### C. Grep se mila (g_all.txt) — kaam ki poori list

**Behaviour-preserving fact:** abhi `CONFIG.GIMBAL_MAX_DEG/RATE` booster ke `params` se aate hain (bridgePerfParams, fleet.js ~2722). Merlin-1d aur merlin-1d-vac dono 8 deg / 40 deg/s hain. Isliye per-engine refactor se numbers nahi badlenge (sirf a: 400 -> 200 jaan-bujh kar). Bonus: pehle separation ke baad stage (MVacD) ke engines bhi booster ke limits par chalte the; per-engine se wo bug theek.

**1. componentLibrary.js** (`THRUSTER_CHEMICAL_SCHEMA` ~390-410, values ~481, ~514): schema mein `{key:'gimbalAccelDegS2', label:'Gimbal angular accel', unit:'deg/s2', min:1}` jodo AUR `merlin-1d` + `merlin-1d-vac` dono ki values mein `gimbalAccelDegS2: 200`. `withFixedValues` extra/missing key par THROW karta hai, ek bhi chhoota to poora page crash.

**2. vehicle.js `buildEnginesForRecord`** (~22-120): thruster `t.parameterSchema` se `gimbalAccelDegS2`, `gimbalRateDegS`, `gimbalMaxDeg` padh kar engine object mein copy (jaise `minMassFlowRate`). Bench sweep ke liye test-only hook: `CONFIG.GIMBAL_ACCEL_OVERRIDE` (default undefined) agar finite ho to `gimbalAccelDegS2` ko override kare.

**3. physics.js `applyActuatorRateLimitsForBody`** (~862-905): `CONFIG.GIMBAL_ACCEL_ON` check hatao; `aMax=e.gimbalAccelDegS2, vMax=e.gimbalRateDegS, gLim=e.gimbalMaxDeg`. Teen branch (accel/rate cmd, slider angle) ek mein: slider angle ko `_gimbalAlphaCmd` jaise law se (physics.js mein copy rakho, comment: guidance-blocks wale ke saath match). `physics.js:105` rebuild-copy waisa hi.

**4. Command handlers — per-engine clamp (forEach ke andar `en.gimbalMaxDeg` etc.):**
- `atlas-prism/lib/sim.js` 86 (rate), 96 (accel), 105 (angle)
- `js/simJs/threads/physics.worker.js` 434, 458, 470
- `js/simJs/threads/fastforward.worker.js` 316, 327, 340
- **`guidance-numerical.html` (461-475) aur `guidance-tester.html` (491-505)**: inke apne `localDispatch` copy mein `setGimbalAccel` case HAI HI NAHI aur `collectStackData` mein GIMBAL_ACCEL env nahi. Physics ab hamesha accel mode mein hogi aur guidance alpha bhejegi, to in pages par gimbal HILEGA HI NAHI. Inhe sim.js ke handlers jaisa karna zaroori.

**5. Guidance tak limits:**
- `physics.worker.js serializeForMain` (~957-965 `ec.*`) aur `workerBridge.js` engine projection (~560): teeno naye fields jodo (constants, cold path theek).
- bench (`sim.js buildSnapshot`) aur FF worker seedha body objects use karte hain, wahan kuch nahi.
- `guidance-blocks.js`: `_gimbalAlphaCmd/_gimbalNextAngle/_gimbalCmdMsg` (27-66) env ki jagah engine fields; OFF branch (63) hatao; `g_N1` ternary (235) simplify; `MAX_ANG/MAX_RATE` sites: 415-439 (ascent), 1122-1128 (STAGE_BURN), 1611-1617 (CIRCULARIZE), 2364-2370 (suicide) -> `gimbals[0].gimbalMaxDeg/gimbalRateDegS`. Transition mein env fallback rakh sakte ho, baad mein hatao.
- `guidance-experiments.js` archive hai, ISKO MAT CHHEDO.
- `workerBridge.js` ~764-768, `sim.js` ~328-331, guidance-*.html env: `GIMBAL_ACCEL_*` env keys hatao.

**6. Flag/config safai:** `js/config.js` 34, 184, 185 (`GIMBAL_ACCEL_ON`, `GIMBAL_ACCEL_DEG_S2`, `params.gimbalAccelDegS2`). `CONFIG.GIMBAL_MAX_DEG` sirf `js/simJs/main.js` 193/197 (slider) ke liye bacha; baad mein engine se. Comments: `stateBuffer.js:59`, `vehicle.js:106,116`, `physics.worker.js:962-966`.

**7. Legacy HOLD law (ascent block):** `guidance-blocks.js` 90-107 defaults (`HOLD_K_DAMP, HOLD_MAX_AOA_DEG, HOLD_K_DQ, HOLD_Q_REF, HOLD_LAW, COAST_DAMP_GAIN, COAST_DAMP_K`), branches ~360-390, `cfg.HOLD_LAW` check ~426. `HOLD_MAX_AOA_DEG` code mein kahin padha hi nahi jaata. Ye dono hatane se pehle readers: `js/guideConfigDefaults.js` (V3 preset ~257-266; baaki 110-119/172-181/306-315 V2/legacy guides ke hain, chhedo mat), `js/guideConstantDescriptions.js` lowercase `ascent.*` entries 23-32 (V3). **Dhyan:** guideConfigDefaults ka V3 preset hi modal ka `_referenceConstants` hai: naye keys (`HOLD_PD_KP`, `HOLD_PD_KD`, `GIMBAL_CMD_TAU_S`) preset + descriptions mein jodo warna modal mein dikhenge nahi. Purane keys wale USER presets (localStorage) `validateConstantsStrict` mein fail honge: user ko re-save karna padega. Preset mein `MECO_TRIGGER_ON_FUEL` bhi hai jo block mein hai hi nahi (harmless).

**8. Bench:** `worker-sim.js traceRun` 626-652, 680-685: `accelOn` override hatao; `accelDegS2` -> `CONFIG.GIMBAL_ACCEL_OVERRIDE`, finally mein restore. `atlas-prism/tests/gimbal_accel_compare.html`: OFF/control-OFF runs hatao, baseline = pehli (a=inf) run, `accelOn` references (102, 188-189, 217-221, 237, 273, 298-300, 306). Control run ab "same a do baar" ho.

**9. Retune (asli maqsad):** a=200, `GIMBAL_CMD_TAU_S=0.1`, bootstrap/tuner se (G,T,bias,lead,meco). `baselineRaw` (atlas-prism/lib/config.js:40) purana OFF-tuned hai, retune ke baad update.

### D. Abhi UNSEEN files (inpar grep ka context chahiye)
Ye command chalao, output file bhejo:
`git --no-pager grep -nE "gimbalDeg|gimbalRate|targetGimbal|\.gimbal\b|gimbalCapable" -- js/simJs/guidance/derivation.js js/simJs/guidance/imu.js js/simJs/view js/rockets-core.js js/components.js atlas-prism/lib/hook.js atlas-prism/ui | cut -c1-200 > g2.txt`
- **imu.js (SABSE ZAROORI):** `measure()` engines ko whitelist se copy karta ho to IMU ON par `gimbalRateActDegS` + naye per-engine fields guidance tak nahi pahunchenge (abhi bhi, tab tak bug chhupa tha kyunki IMU default OFF).
- derivation.js: engine fields kaise padhta hai.
- render.js/telemetry.js: sirf `gimbalDeg` padhte honge (rocketArt.js aur controls.js check ho chuki, kuch nahi chahiye).
- `grep -il gimbal` ki baaki list (hook.js, lattice.js, atlas config.js, ui/host.js, pro-alpha etc.) shayad sirf `PUSH_MAX_GIMBAL_DEG` ki wajah se hai: noise.

### E. Verify order (patch ke baad)
1. Syntax: `node --check` har badli file. 2. Page load (withFixedValues crash na kare). 3. Compare page: a=200 run = pehle wale "ON a=200" jaisa (ascent identical expected). 4. Determinism x2 + control bit-identical. 5. Page: `snapDbg` overlay dobara + guidance-tester/numerical pages par gimbal hilta hai. 6. Phir retune.

Next chat ki pehli line: "GIMBAL_REALISM_HANDOFF.md padho, UPDATE (7th session) section C ke hisaab se patch banao; pehle D wala g2.txt dekho."

Upload karna: GIMBAL_REALISM_HANDOFF.md (updated), g2.txt, imu.js, derivation.js, plus badalne wali files (componentLibrary, vehicle, physics, physics.worker, fastforward.worker, workerBridge, guidance-blocks, config, sim, worker-sim, gimbal_accel_compare, guidance-numerical.html, guidance-tester.html, guideConfigDefaults, guideConstantDescriptions, main.js).


## UPDATE (6th session) — SABSE PEHLE YE PADHO (ye section 5th-session section ko bhi supersede karta hai jahan conflict ho)

Likha: 2026-10-18 (same din). Hinglish. Is section ko GIMBAL_REALISM_HANDOFF.md ke sabse upar paste karo.

### A. Is session mein files badli (outputs se repo mein copy karni hain)

1. `atlas-prism/lib/worker-sim.js` — `traceRun` ka patch-merge fix. Pehle sirf wahi keys patch hoti thi jo `TunerUtils.toValues()` ke `values` mein hon (ascent mein sirf PUSH_MAX_GIMBAL_DEG, PUSH_T_S, MECO_TARGET_BOOSTER_FUEL_KG) -> `HOLD_K_DAMP` "PATCH MISSING" aata tha. Ab keys `Guidance.getGuideConfig(TunerConfig.guideName)` ke asli config se validate hoti hain (`setLeoInsertionV3` section par Object.assign karta hai, to extra keys sim tak jaati hain). `_v3Config` runs ke beech persist karta hai, isliye extra patched keys `finally` mein purani value par restore hoti hain (`_patchRestore`). Typo wali key ab bhi PATCH MISSING dikhati hai.
2. `js/simJs/guidance/guidance-blocks.js` — ascent block mein:
   - Naye constants (defaultConstants): `HOLD_LAW` (ab default `"aoa_pd"`, purana `"legacy"`), `HOLD_PD_KP: 1.0`, `HOLD_PD_KD: 2.0`, `GIMBAL_CMD_TAU_S` (ab default `0.1`, `0` = purana deadbeat command).
   - `aoa_pd`: HOLD aur COASTnAoADAMP dono mein `tau_desired = -I_next * (HOLD_PD_KP * aoaRad + HOLD_PD_KD * omegaAoANext)`, `aoaRad = dNext.alphaDeg` (stage-burn wale PD jaisa, bina bias). `tau_dQ` hata hua. (~line 358-372)
   - Command shaping: ascent site (~line 418-440) par target gimbal low-pass: `gCmdFilt += (1 - exp(-dt/GIMBAL_CMD_TAU_S)) * (g_req_deg - gCmdFilt)`, seed = measured gimbal, sirf aoa_pd + (HOLD ya COASTnAoADAMP) mein; `R_req` aur `_gimbalCmdMsg` ko `g_cmd_deg` jaata hai. Baaki 3 sites (~1109, ~1598, ~2351: insertion/suicide) NAHI chhede.
   - Purana behaviour reproduce karne ke liye patch: `{"ascent":{"HOLD_LAW":"legacy","GIMBAL_CMD_TAU_S":0}}`.
3. `atlas-prism/tests/gimbal-accel-compare.html` — window stats mein 2 nayi lines: `chatter size` (steps >= 0.02°, unmein flips, rms dG/tick) aur `ascent attitude (tumble check)` (max|omega|, tilt range, tilt@30/60/100/end). Sirf stats, sim wahi.

Sab files `node --check` pass. Koi sim chalaya nahi gaya mere taraf se; sab natije user ke bench runs se hain.

IMPORTANT: defaults flip hone se OFF baseline badal gaya. Purana `baselineRaw` {G:0.60,T:4.82,bias:0.59,lead:5.53,meco:52612} ka "590.46 s DONE, circDv 696" result ab default se reproduce NAHI hoga (ab vt@coast ~4943 m/s, cap 1500 s). Wo result sirf legacy patch se milega.

### B. Natije / findings

**B1. HOLD_K_DAMP sweep (legacy law, patch ab sahi lagta tha), window 9-13 s, OFF rateCmd flips (321 samples):** K=0.5: 231, 1: 200, 2: 103, 4 (default): 44, 8: 64. Minimum K=4 ke paas; K=8 par finite-a runs ascent mein OFF ke kaafi paas rahe. Constants se chatter nahi gaya.

**B2. Code finding (user ki galatfehmi sahi ki):** ascent HOLD (legacy) mein omega term pehle se hai (`omegaAoANext = omega + P/r^2`, stage-burn wala hi). Asal farq: legacy `tau = -I*(alphaAoA + K_DAMP*omegaAoA)`: AoA angle ka term hai hi nahi (AoA ko hold karta hai) aur `alphaAoA` (AoA ki angular accel, `dNext.alphaAng` se) hai. Stage-burn: `tau = -I*(kp*aoa + kd*omegaAoA)`, kp=1, kd=2, accel term nahi. Ascent ka phase machine: COAST -> HOLD jab `dNow.alphaDeg >= 0`; HOLD -> COASTnAoADAMP jab `< 0` (wapas HOLD nahi); COASTnAoADAMP legacy mein sirf P (`-I*GAIN*alphaDeg/K^2`, D nahi).

**B3. aoa_pd akela chatter nahi hataya:** OFF window 9-13 s flips 231/232 (har tick), rms dG/tick 0.42° (legacy 0.18°). Mera pehla hypothesis (alpha-accel term ka algebraic loop) GALAT nikla. Par tumble nahi: ascent max|omega| 0.43 deg/s, tilt monotonic 0 -> -3.1 (30 s) -> -11.5 (60 s) -> -26.8 (100 s) -> -35.7 (MECO 134.7 s), legacy -35.1 deg.

**B4. Chatter ka hypothesis (consistent hai, PROVEN nahi):** guidance `dNext` ko stale `g_N1 = g_N + R_N*dt` par derive karti hai, jabki bench mein command usi tick apply hota hai (sim.js tick: physicsStep -> snapshot -> Guidance.onSnapshot). `omegaAoA` ke andar `P/r^2 ~ F*sin(g)/(M*u)` (thrust ka lateral hissa) hai, to `g_req` apne hi purane guess par depend karta hai. Deadbeat command `R=(g_req-g_N)/dt` ke saath loop gain `c ~ -kd*I/(M*L*u)`; `c < -1/3` par Nyquist par marginal -> rail (40 deg/s = 0.5 deg/tick) par limit cycle. `u` HOLD ke shuru (t~10 s) mein sabse kam, isliye wahin chatter. Python toy (parameters mere andaaze, asli vehicle ke nahi) ne yahi pattern dikhaya: u<=100 m/s par rail-to-rail, u>=200 par shant; dt 1/80 -> 1/400 par rms ~5x kam par flips phir bhi har tick. Zaroorat padne par validate: window 20-24 s (speed zyada, chatter kam hona chahiye).

**B5. Fix `GIMBAL_CMD_TAU_S = 0.1` (default ab):** per-tick gain ~dt/tau, response dt-independent (residual dt ke saath ghatta hai). Result (aoa_pd + tau 0.1): OFF window 9-13 s flips 1, rms dG/tick 0.013°, steps>=0.02°: 8; ON a=inf/800/400/200 sab ~1 flip, rms ~0.013°; peak |rate| ~5-11 deg/s (rail nahi); alpha saturation ~0%; ascent sab runs mein lagbhag same (tilt@MECO -33.9, vt@coast 4941-4944 for OFF/inf/800/400, 4852 for a=200). Matlab finite `a` ab ascent mein tuning ko disturb nahi karta.

**B6. STAGE_BURN check (window 150-160 s):** gimbal range +-0.004 deg, rms 0.0001 deg, 0 big steps — chatter nahi, par gimbal lagbhag idle hai, isliye "slow hota to chatter aata" test nahi hua. Insertion sites par filter abhi NAHI lagaya (burn/CIRCULARIZE bias/lead ke tuned numbers badal jaate). Jab landing/hover jaisi slow phases aayen ya chatter dikhe tab shared helper bana kar 4 sites par optional (default 0) lagana.

**B7. Open mamla (chatter nahi): RCS_BOOST duration jhool karti hai.** Code (`guidance-blocks.js` ~1221-1270): RCS_BOOST mein throttle 0 aur `cmdSetGimbalRate(0)` — gimbal chatter yahan ho hi nahi sakta (isliye 440-520 s window chatter ke liye bekaar). Phase tab khatam hoti hai jab apogee error ka sign badle (`crossed`). Duration: legacy baseline ~8 s, aoa_pd runs mein OFF/a=800/a=200 ~18-22 s, par a=inf aur a=400 ~76-82 s, phir COAST_ROTATE ~1005 s tak atka (a=inf COAST_HOLD@1029.7, a=400 COAST_HOLD@1245.1, DONE koi nahi). Ascent aur STAGE_BURN in runs mein identical, first deviation RCS_BOOST ke andar (~459 s, dtilt>0.1). Hypothesis (unverified): RCS push attitude par depend karta hai aur chhote tilt difference se apogee crossing late hoti hai (knife-edge).

### C. Decisions / user ke rules

- User ne decide kiya: hold law aoa_pd, gimbal accel ON, OFF model hata kar ON par hi retune. Chatter ko model ka hissa nahi rehne dena; limitation sirf DT (phone par 1/80, real space X 1/400) ho aur dt chhota karne par problem ghate.
- `config.js` mein `GIMBAL_ACCEL_ON` abhi bhi `false`. Page par true karne se pehle: (1) `snapDbg` gap=1 verify, (2) bench aur page mein same value, (3) NEW: bench mein guidance command usi tick apply hota hai (latency 0); page mein worker latency 1 tick ho sakti hai. Gap=1 aaye to `R_req = (g_req - g_N)/dt` ki jagah `g_N1` wala version (ya filter ke saath dobara verify) dekhna padega.
- Token bachao: badi files poori mat padho (`grep -n` + `sed -n a,bp`). GIT MERGE RISK (5th-session section F) ab bhi lagu: `workerBridge.js` aur `fastforward_worker.js` overwrite mat karo, pehle diff.

### D. Agle kadam (is order mein)

1. Teeno files repo mein copy (guidance-blocks.js, worker-sim.js, compare html), page hard-refresh. Check: OFF Determinism x2 + bit-identical (compare page mein "CONTROL bit-identical" aata hai).
2. **ON par retune shuru** (G, T, bias, lead, meco via bootstrap/tuner) `GIMBAL_ACCEL_ON=true` per-job, `a` ke liye suggestion 200 (sabse shant) ya user ka real actuator number. Har result mein RCS_BOOST duration dekho: agar points ke beech 10x badalti hai to B7 (apogee error vs time ka plot add karke) investigate karo.
3. Optional validate: window 20-24 s chatter; `GIMBAL_CMD_TAU_S` 0.05 / 0.2 compare; dt=1/400 par rms.
4. Insertion sites (~1109, ~1598, ~2351) par shared filter helper (default 0) — landing/slow phases ke liye.
5. Agar kabhi root-cause fix chahiye: self-consistent g_req (tau_target(g) ko g ke saath solve, secant 2-3 `deriveForState` calls/tick) — toy mein chatter hata deta hai, code mein invasive.
6. Purane items: page ON `snapDbg` gap=1, per-engine property refactor (`gimbalAccelDegS2`, `GIMBAL_RATE_DEG_S`, `GIMBAL_MAX_DEG`), grid fins, bench sweep metric "gimbal travel 0.3 s after throttle(0)", `trajectory_worker.js` flag ON check.

### E. Agle chat mein upload karwao

`GIMBAL_REALISM_HANDOFF.md` (updated), `guidance-blocks.js` (naya), `worker-sim.js` (naya), `sim.js`, `tests/gimbal-accel-compare.html` (naya), `config.js`. Zaroorat par: `lattice.js`, `bootstrap.js`, `physics.js` (~873-905 gimbal branch). Natije "Copy summary" se.

Next chat ki pehli line: "GIMBAL_REALISM_HANDOFF.md padho, UPDATE (6th session) section D step 2 (ON par retune) se shuru karo."

---

# GIMBAL REALISM — Handoff (is chat ka poora kaam, next chat ke liye)

Likha: 2026-10-18. Bhasha: Hinglish. Is file ko padhne ke baad naye chat ko user se kuch re-explain nahi karwana chahiye.

---

## UPDATE (5th session) — SABSE PEHLE YE PADHO (ye section neeche ke purane sections ko supersede karta hai jahan conflict ho)

Likha: 2026-10-18 (same din, 5th session). **Is session mein koi aur patch pending nahi hai; sab files user ko di ja chuki hain. Last step (HOLD_K_DAMP patch experiment) abhi CHALA NAHI hai** (user ke aakhri paste mein wahi purana run tha, bina patch ke).

### A. Is session mein kya badla (ya check hua)

**Bugs jo mile aur fix hue (ye sab flag-OFF mein numerics nahi badalte):**
1. `workerBridge.js` (~559-563): guidance snapshot ke engine projection mein `gimbalRateActDegS` aur `targetGimbalAccelDegS2` NAHI the. Guidance `|| 0` fallback se padhti hai, to page path mein flag ON par guidance ko actual rate hamesha 0 dikhti (chupchap galat). Dono fields projection mein jod diye.
2. `fastforward_worker.js` (`localDispatch`, ~314-345): `setGimbalAccel` case tha hi nahi (`default: break` se ignore). Case joda (sim.js wale handler jaisa, clamp `CONFIG.GIMBAL_ACCEL_DEG_S2`, field `degPerSec2`); `setGimbal`/`setGimbalRate` ab `targetGimbalAccelDegS2 = NaN` bhi karte hain.
3. `atlas-prism/lib/sim.js`: `setupStackData()` ke andar `collectStackData` local hai aur `Derivation.setStackData` sirf ek baar (load par) chalta hai. Bench mein per-run flag badalne ke liye module-level `_refreshStackData` hook banaya, `TunerEngine.refreshStackData()` export hua. (Pehli attempt scope galat thi, ab theek.)

**Static audit (sirf code padh kar, sim chalaya nahi):** saari uploaded files `node --check` OK. Hot buffer stride sirf `HOT_STATE_FLOATS_PER_ENGINE` constant se nikalta hai (stateBuffer.js), kahin hardcoded 3 nahi. `render_worker.js` `decodeHotState` use karta hai (safe). `guidance_worker.js` `stackData` ko seedha `Derivation.setStackData(msg.data)` ko deta hai. `fastForward.js` stackData `_collectStackDataForGuidance()` (workerBridge.js:619) se leta hai, jisme `GIMBAL_ACCEL_ON/DEG_S2` pehle se hain. `physics_worker.js` `serializeForMain` har tick cache overwrite karta hai (cold clone fields stale nahi). **Ye abhi bhi unverified:** `trajectory_worker.js` flag ON par; page realtime mein `snapDbg` gap=1.

**Teeno pipelines ka status (code level):** page (physics worker + guidance worker) OK; fast-forward OK; bench (atlas-prism) OK. User ne ON mode mein Determinism check kar liya (pass). Flag ab bhi `config.js` mein `GIMBAL_ACCEL_ON: false` default.

### B. Naya test harness (bench) — ye ab main diagnostic tool hai

- `atlas-prism/lib/worker-sim.js`: naya job **`traceRun`**. Payload: `{ raw | point | values, altKm, accelOn, accelDegS2, every (ticks, default 4), capS (1500), hiT0, hiT1 (is window mein har tick), patch (JSON, values mein deep-merge; missing keys `patchMissing` mein), env }`. Point priority: values > point > `TunerUtils.fromRaw(raw || TunerConfig.baselineRaw)`. CONFIG ko per-job set/restore karta hai, `TunerEngine.refreshStackData()` prepareRun se pehle aur restore ke baad. Return: `{ok, patchMissing, endReason, ticks, simTime, phases[], cols{t, cmdRate, rx, ry, alt, vx, vy, theta, omega, gimbal, gimbalRate, alpha, gimbalTgt, thrust, fuel}}`.
- `atlas-prism/tests/gimbal-accel-compare.html` (naya, koi external lib nahi, canvas charts): pool = `TunerCore.WorkerPool(n, {workerPath:'../lib/worker-sim.js'})`, jobs `pool.runJob('traceRun', ...)`; sirf `../lib/worker-pool.js` load karta hai. Chalata hai OFF + ON(a list, default inf/800/400/200) + OFF control. 11 panels (alt, vt, vr, tilt = theta - localVertical, gimbal, rate, alpha, OFF rate cmd, Δvt/Δtilt/Δalt vs OFF), summary table (coast-phase state, approx apo/peri/circΔv with mu box, peak gimbal/rate, alpha sat %), "first deviation vs OFF" onset (Δtilt>0.1°, Δvt>5 m/s, Δgimbal>0.05°), alpha-saturation windows, aur **hi-res window stats (default 9-13 s)**: gimbal-dir flips, alpha/rateCmd sign flips, max |dG/tick|, gimbal range. Input box **"values patch JSON (all runs)"** (e.g. `{"ascent":{"HOLD_K_DAMP":1}}`), jo sab runs par lagta hai; "PATCH MISSING keys" log mein bad dikhega.
- Baseline point `TunerConfig.baselineRaw = {G:0.60, T:4.82, bias:0.59, lead:5.53, meco:52612}` OFF mein 590.46 s run reproduce karta hai (hook: circ Δv@COAST 696.3). Page ka approx circΔv 696 us se match karta hai.
- Point lattice format (bootstrap.js): `{Gi: round(G*100), Tn: round(T/0.000125), bi: round(bias/0.0001), li: round(lead/0.0125), meco}`; `toValues`/`fromRaw` `lattice.js` mein hain (wo file kabhi upload nahi hui; `TunerUtils.toValues/fromRaw` export hain).

### C. Natije (baseline point, jo OFF ke liye tuned hai)

| run | end | t end | vt@coast | circΔv≈ | note |
|---|---|---|---|---|---|
| OFF (+control bit-identical) | DONE | 590.5 | 7026 | 696 | |
| ON a=inf | DONE | 645.4 | 7071 | 651 | structure OFF jaisa, par bit-identical nahi |
| ON a=800 | cap/fail | 1500 | 6084 | 1635 | |
| ON a=400 | cap/fail | 1500 | 5676 | 2043 | COAST_WAIT/ROTATE/HOLD/CIRCULARIZE sab 509.6 s par = circ lead cross (user ka purana symptom) |
| ON a=200 | cap/fail | 1500 | 5573 | 2147 | |

- Alpha saturation sirf ~1.1-1.4% samples, par teeno finite-a runs mein ascent mein t≈10.1-12 s ke beech saturation windows hain aur pehla trajectory deviation (Δtilt>0.1°) ASCENT mein hi 58-73 s par aata hai.
- `a=inf` ka mission end 55 s late (645 vs 590) **bug nahi**: `COAST_HOLD_2 -> DONE` apogee crossing (vr + -> <=0) ka wait karta hai (`guidance-blocks.js` ~1694-1710); final eccentricity thodi alag (320.3 vs 320.1) se crossing late aati hai.
- Sab ON runs (a=inf bhi) OFF se pehle gimbal deviation t=10.1 s par dikhate hain (>0.05°).

### D. **KEY FINDING: jitter OFF mein bhi hai (pre-existing limit cycle, ON ka bug nahi)**

Window 9-13 s (hi-res, 80 Hz):
- OFF: rateCmd sign flips **44**, max|rateCmd| = 40 (rate limit rail), gimbal range [-1.199, +0.499], max |dG/tick| 0.5°.
- ON a=inf: gimbal flips 38, alpha flips 46, range [-1.25, 0.499]. ON a=800: 96/106. a=400: 92/110. a=200: 112/121 (finite a mein flips badhte hain, per-tick step ghatta hai).
- Matlab ascent ke outer loop mein t≈10.1 s se ~11 Hz bang-bang limit cycle hai jo instant-gimbal ke saath chhup jaata tha (sim ke liye harmless, par real actuator mein 40 deg/s rail-to-rail unrealistic). Finite alpha use isi cycle ko badal deti hai -> butterfly effect, trajectory ASCENT mein hi diverge.
- **Kahan se shuru:** `guidance-blocks.js` ascent: PRE_COAST (INITIAL_COAST_S 4.9) -> PUSH (PUSH_T_S 4.82, ends ~9.72 s) -> COAST (tau_desired=0) -> **HOLD jab `dNow.alphaDeg >= 0` (~10.1 s)**. Phase transitions ~line 320-340, tau law ~line 354-372 (HOLD: `tau_accel = -I*alphaAoA`, `tau_damp = -HOLD_K_DAMP*I*omegaAoA`, `tau_dQ`), `g_req` solve ~392-417, `g_N1` (next-tick gimbal prediction) ~line 227 (ON mein `_gimbalNextAngle`). 4 call sites: ~417, ~1085-1102, ~1574-1591, ~2327-2344.
- **Offline node test** (`_gimbalAlphaCmd` akele, dt=0.0125, a=400): static steps aur slow sinusoid par koi chatter nahi, overshoot nahi; chatter tabhi jab target har tick alternate kare. Matlab alpha law shayad doshi nahi, `g_req` khud jitter karta hai (hypothesis, unverified).
- **Hypothesis (unverified):** HOLD law deadbeat-jaisa high-gain loop hai jisme one-tick delay + `g_N1` dependence hai -> limit cycle.

### E. Agle kadam (is order mein)

1. **Pending experiment (abhi chala nahi):** gimbal-accel-compare.html mein patch `{"ascent":{"HOLD_K_DAMP":1}}`, phir 2, 0.5. Window stats dekho (OFF aur ON dono ke flips kam hue?). Agar log mein **PATCH MISSING** aaye to HOLD_K_DAMP `values.ascent` mein nahi hai: pata karo ascent constants kahan se aate hain (`defaultConstants` guidance-blocks.js ~line 100; `TunerUtils.toValues`/`guideConfigDefaults.js`). `COAST_DAMP_GAIN`/`COAST_DAMP_K` bhi try kar sakte ho (COASTnAoADAMP phase).
2. Agar constants se limit cycle nahi jata: **ON-only `g_req` limiter/blend** 4 sites par (flag OFF = bit-identical), ya `g_N1`/delay model ka sahi hona dekho. Fix ke baad comparison dobara: goal = a=inf ≈ OFF aur finite a (200-800) stable, window flips kam.
3. a=inf mein bhi t=10.1 par Δgimbal>0.05° kyun (first-tick behaviour ON vs OFF: timing ya g_N1 ka farq?) samjho.
4. User ka plan: bugs/model sahi hone ke baad **OFF model hata do, ON par hi retune** (bootstrap/tuner, MECO/G/T/bias). Pehle "OFF tuned point par ON chalana" fair comparison nahi hai (knife-edge optimum).
5. Baaki purane items: OFF Determinism x2 + bit-identical (is session ke edits ke baad dobara), page ON `snapDbg` gap=1, per-engine property refactor (`gimbalAccelDegS2`, `GIMBAL_RATE_DEG_S`, `GIMBAL_MAX_DEG` ek saath), grid fins, bench sweep metric "gimbal travel 0.3 s after throttle(0)".

### F. Dhyan rakhne ki baatein

- **GIT MERGE RISK:** user ne `git pull` kiya jisme `js/simJs/threads/fastforward.worker.js` (+14/-1) aur `threads/workerBridge.js` (+3) remote se badle. Mere diye `fastforward_worker.js` aur `workerBridge.js` purane upload par based hain; **overwrite mat karo, pehle `diff`/git diff karke sirf mere edits (upar A.1, A.2) latest par apply karo.** Agar wo remote changes user ke apne push hain jisme mere patches pehle se hain, to dobara apply ki zaroorat nahi.
- Repo tree (user ne diya): main sim `js/simJs/{core,guidance,threads,view}`; bench `atlas-prism/{lib,tests,standard,engines,ui}`; configs `js/config.js`, `js/componentLibrary.js`, `js/fleet.js`. Upload hui files flat naam mein hain (`physics_worker.js` = `threads/physics.worker.js`, `guidance_worker.js` = `threads/guidance.worker.js`, `worker-sim.js` = `atlas-prism/lib/`).
- User Hinglish mein baat karta hai; **token bachao**: badi files poori mat padho, `grep -n` + `sed -n a,bp` se targeted lines. "Butterfly effect" ka user ko pata hai: chhoti cheez poore mission ko badal sakti hai, isliye final verdict tuned (retuned) results se, ek fixed point ke final Δv se nahi.
- Hot buffer / env wiring ki detail upar A mein hai; `GIMBAL_ACCEL_ON` kabhi bhi page mein TRUE karne se pehle (1) `snapDbg` gap=1, (2) bench aur page mein same value.

### G. Agle chat mein upload karwao

`GIMBAL_REALISM_HANDOFF.md` (ye file), `guidance-blocks.js`, `worker-sim.js`, `sim.js`, `tests/gimbal-accel-compare.html`, `config.js`. Experiment ke natije (window stats + summary table, "Copy summary" button se). Zaroorat padne par: `physics.js` (sirf ~873-905 gimbal branch), `workerBridge.js`, `fastforward_worker.js`, `lattice.js`, `componentLibrary.js` (per-engine refactor ke liye).

Next chat ki pehli line: "GIMBAL_REALISM_HANDOFF.md padho, UPDATE (5th session) ke section E step 1 se shuru karo."

---

## (PURANA) STATUS (4th session) — upar 5th session ka update supersede karta hai — PAGE PATH BHI PATCH HO GAYA (flag OFF default)

Ab tak patched (sab `GIMBAL_ACCEL_ON` ke peeche, default false): `config.js, physics.js, vehicle.js, sim.js, guidance.js, guidance-blocks.js, physics_worker.js, stateBuffer.js, workerBridge.js`.
- `workerBridge.js` (~762): guidance `env` mein `GIMBAL_ACCEL_ON`, `GIMBAL_ACCEL_DEG_S2` (page path ab bench jaisa).
- `stateBuffer.js`: hot buffer mein per-engine 4th float `gimbalRateActDegS` (`HOT_STATE_FLOATS_PER_ENGINE` 3 -> 4; encode `buf[eb+3]`, decode). **Check karna baaki:** koi aur file jo hot buffer ka layout hardcode karti ho (render/trajectory worker) ya stride ko 3 maan ti ho; maine sirf stateBuffer/workerBridge/physics_worker mein grep kiya.
- Page mein flag ON karne se pehle: (1) `snapDbg` gap histogram mein gap=1 dikhe (accel command persist karta hai, snapshots skip hon to overshoot), (2) config.js mein `GIMBAL_ACCEL_ON=true`, bench aur page dono mein same value.
- **Asli sim mein ab bhi test nahi hua.** Sirf node unit test + syntax check. Verification plan section 8 step 4 aur UPDATE section waala hi hai.

**FUTURE (user ne bola):** `a_max` ek **global term nahi hai, engine ki property hai.** Abhi test complete hone tak `CONFIG.GIMBAL_ACCEL_DEG_S2` (config.js `params.gimbalAccelDegS2`) hi rahega, kyunki per-engine refactor bada hai. **Baad mein:** `componentLibrary.js` ke thruster type mein `gimbalAccelDegS2` (jaise `gimbalRateDegS`, `gimbalMaxDeg`), `vehicle.js` mein engine object banate waqt copy (jaise `minMassFlowRate`), physics/guidance `CONFIG.GIMBAL_ACCEL_DEG_S2` ki jagah `e.gimbalAccelDegS2` padhe (physics ~873 branch, sim.js/physics_worker.js handlers ka clamp, `_gimbalAlphaCmd/_gimbalNextAngle` mein `gimbals[0]` se). Wahi refactor `GIMBAL_RATE_DEG_S` aur `GIMBAL_MAX_DEG` par bhi lagu hota hai (abhi global CONFIG hain), to teeno ek saath karna behtar. Next chat mein user aur files bhejega (componentLibrary.js, vehicle.js, fleet/stack waali files).

**Next chat ka order:** (1) is file + saari patched files upload; (2) user flag OFF verify (Determinism x2, bit-identical); (3) bench ON sweep (a_max 200/400/800/inf, control run, metrics: apogee, circ error, fuel, peak gimbal angle/rate, saturation ticks, overshoot, **gimbal travel 0.3 s after throttle(0)**); (4) page ON; (5) per-engine property refactor; (6) **grid fins** (hot buffer `stateBuffer.js` mein gridFin deploy/control floats pehle se hain, lines 16-18; slew `componentLibrary.js ~320-324`).

---

## AUDIT (3rd session) — real page vs bench, aur rate(0) ka sach

User ne blind trust bola tha aur kaha tha ki dobara dekh lena. Audit ke nateeje:

**1. `cmdSetGimbalRate(0)` kab jaata hai (verified, saare ~21 sites):** 20 sites `cmdSetAllThrottle(0)` ke saath hi hain = engine off / coast / DONE / SUICIDE_ROTATE+COAST / `stop()` / `END` (guidance-blocks.js 609, 1141, 1152, 1266, 1369, 1394, 1486, 1556, 1653, 1708, 1832, 2126, 2188, 2249, 2310, 2456; guidance.js 717, 785). Sirf **guidance-blocks.js:941** alag hai: spool-up wait (`!allFull`, engines abhi full throttle pe nahi). ON mode mein ye "stop" command gimbal ko `a_max` se brake karta hai (worst case `v^2/(2a)` = 2° at 40 deg/s, 400; typical bahut kam) aur tab engine thrust zero ya spool-down mein hota hai. Mera view: braking rakhna sahi hai (warna rate 40 se 0 ek tick mein jaata, jo wahi accel-limit violate karta jo hum add kar rahe hain). **User ka doubt valid tha, aur ye decision ab bhi user ka hai.** Agar user "safety stop = instant" chahe to option: `setGimbalRate` ke saath ek `hard:true` flag jo physics mein rate state ko seedha 0 kare. Sweep mein metric jodo: "gimbal travel in 0.3 s after each throttle(0)".

**2. Real page ka pipeline bench se alag hai (maine pehle sirf bench/sim.js dekha tha):**
- Guidance **alag worker** (`guidance_worker.js`) mein chalta hai; wahan `CONFIG` exist hi nahi karta. Guidance ka `env` `Derivation.setStackData(...)` se aata hai, jo main thread ka `workerBridge.js` `sendStackDataToGuidance()` banata hai (**upload nahi hua**). Bench mein ye kaam `sim.js collectStackData()` karta hai, wahan maine `GIMBAL_ACCEL_ON` aur `GIMBAL_ACCEL_DEG_S2` jode the. **Page mein ye keys nahi pahunchti**, to wahan guidance OFF hi rahegi.
- Real page mein human + guidance gimbal commands `physics_worker.js` ke `setGimbal`/`setGimbalRate` handlers se jaate hain (sim.js nahi). **Ab patch ho gaya:** `setGimbalAccel` handler, `setGimbal`/`setGimbalRate` accel command ko NaN karte hain, aur guidance snapshot ke engine clone mein `gimbalRateActDegS` + `targetGimbalAccelDegS2` add.
- Engine ka `gimbalDeg` snapshot mein **hot Float64Array (`stateBuffer.js`, encodeHotState)** se aata hai, **upload nahi hua**. Naye fields maine cold clone (har serialize pe copy hota hai, `targetGimbalRateDegS` jaise) mein daale hain. Ye kaafi hona chahiye, par guidance ko hot+cold merge kaise milta hai wo stateBuffer.js/workerBridge.js dekh ke confirm karna hai.
- Timing: guidance -> physics MessagePort se direct, aur sync ack ("physics paused, commands pehle aate hain, phir ack") ki wajah se command agle step mein apply hota hai, bench ke 1-tick pipeline jaisa. **Par** accel command persist karta hai (rate command ki tarah), to agar page mein guidance snapshots kabhi skip hon (`snapDbg` gap histogram mein gap != 1), alpha kai ticks tak lagta rahega aur overshoot karega. Bench mein har tick guidance chalti hai, to bench safe hai. Page ke liye `snapDbg` histogram dekhna hai (gap=1 normal).

**3. Abhi kya safe hai:** **Bench (worker-sim.js/sim.js) mein poora ON path end-to-end consistent hai.** **Page mein `GIMBAL_ACCEL_ON` TRUE mat karo** jab tak `workerBridge.js` (env keys) aur `stateBuffer.js` check nahi ho jate. Page mein flag ON hone par physics ON aur guidance OFF hogi: guidance purane deadbeat rate commands bhejegi aur accel-limited plant ringing karega.

**4. Files jo ab chahiye:** `workerBridge.js` (env keys), `stateBuffer.js` (hot buffer layout).

---

## UPDATE (2nd session) — PATCH APPLIED, flag OFF default

**Status:** physics + guidance patch likha ja chuka hai (6 files: `config.js, physics.js, vehicle.js, sim.js, guidance.js, guidance-blocks.js`). Sab naya code `CONFIG.GIMBAL_ACCEL_ON` (default **false**) ke peeche. **Asli sim mein abhi test nahi hua**, sirf node mein helper + plant ka closed-loop unit test (gap 1.0° overshoot 0.0375°, final err 0, python se match). Syntax `node --check` OK.

**User ne decide kiya (is session mein):**
- Interface = **`setGimbalAccel` (alpha command)**, guidance jahan gimbal rate solve karta tha wahan ab alpha solve karke bhejta hai (open decision 9.1 closed). Config.js se pata chala: DT = 1/80, gimbal limits `ACTIVE_VEHICLE_FOR_HARDWARE.params` se aate hain (`gimbalMaxDeg: 20, gimbalRateDegS: 40` us record mein; library ke 8°/40 alag hain).
- **Grid fins mein bhi yahi integrate karna hai, gimbal complete hone ke turant baad** (wahan bhi rotation hoti hai). `_gimbalAlphaCmd` helper joint-agnostic rakha hai. Grid fin physics pointers (verify karna baaki): `physics.js ~328` (fin type), `componentLibrary.js ~320-324` (`maxSlewDeployingDegS: 18`, `maxSlewControllingDegS: 40`).

**Kya badla (sab flag ke peeche):**
- `config.js`: `params.gimbalAccelDegS2: 400` (ASSUMPTION), `CONFIG.GIMBAL_ACCEL_ON=false`, `CONFIG.GIMBAL_ACCEL_DEG_S2`.
- `vehicle.js`: engine fields `gimbalRateActDegS: 0`, `targetGimbalAccelDegS2: NaN`.
- `physics.js` (~873): ON mode mein accel-state integration (rate pehle, angle baad; rate-command bhi accel limit se track hota hai, to `cmdSetGimbalRate(0)` ab brake karta hai instant stop nahi; mechanical stop pe v=0; slider path mein rate state continuous rakha). Rebuild copy (~105) mein `gimbalRateActDegS` add.
- `sim.js`: `setGimbalAccel` handler (clamp `±GIMBAL_ACCEL_DEG_S2`), `setGimbalRate` aur `setGimbal` accel command ko NaN karte hain ("last command wins / human wins"), env mein 2 naye keys.
- `guidance.js`: `cmdSetGimbalAccel` + export.
- `guidance-blocks.js`: top par `_gimbalAlphaCmd` (2-tick law + braking guard, vf=0), `_gimbalNextAngle`, `_gimbalCmdMsg`; 4 sites (ascent ~363, insertion ~1054, ~1543, suicide ~2296) ab `_gimbalCmdMsg(...)` bhejte hain (OFF mein bilkul purana `cmdSetGimbalRate`). Ascent ka `g_N1` (next-tick prediction) ON mein "current command unchanged rakhne par agle tick ka angle" use karta hai.

**Maine apni taraf se chune (user ko bata diya, confirm baaki):** `vf = 0`; `tau_r` (linear lag) abhi nahi, kyunki alpha seedha command ho raha hai; slider -> accel mode switch par rate = last step/dt; `a_max` default 400.

**Abhi baaki:**
1. **Verify OFF:** Determinism (x2) + purane files se bit-identical (control run ke saath). Note `vehicle.js` mein 2 naye engine fields OFF mein bhi hain (numerics nahi badalte, par agar koi engine-state hash/JSON compare hai to dhyan rakho).
2. **Verify ON:** `CONFIG.GIMBAL_ACCEL_ON = true` karke deterministic run-to-run, phir **sweep** (`a_max` 200/400/800/inf; benchPhase jaisa job, control run ke saath) aur ON vs OFF result delta (apogee, circ error, fuel, peak gimbal angle/rate, saturation ticks, overshoot per phase, sign flips).
3. **Check `physics_worker.js`** (upload nahi hua): physics.js ke comment ke mutabik human `setGimbal` wahan bhi handle hota hai. Agar wahan alag handler hai to usmein bhi `targetGimbalAccelDegS2 = NaN` reset jodna padega, warna ON mode mein human slider accel command ko override nahi karega.
4. Workers mein `CONFIG.GIMBAL_ACCEL_ON` kaise set hoga (config.js seedha edit, ya bench override) decide karna.
5. Phir **grid fins** pe same cheez.

---

## 0. TL;DR

- **Kaam:** sim mein gimbal ka **rate instantly nahi badalna chahiye**. Real actuator mein rate ko badalne ke liye angular acceleration (alpha) lagti hai aur wo limited hoti hai. Abhi sim mein rate ek tick mein seedha badal jaata hai. Ye sim ki drawback hai, user ise theek karna chahta hai.
- **Quantization (0.01° least count) ka idea DROP ho chuka hai.** Real rockets (hydraulic servo, Merlin) continuous move karte hain, stepper jaise nahi.
- **Decide ho chuka design:** physics mein `gimbalRateActDegS` naya state + accel limit (`a_max`) + optional first-order lag (`tau_r`), sab **flag ke peeche, default OFF**. Guidance mein user ka **2-tick Newtonian law + ek braking guard** (numerically verify ho chuka hai).
- **Patch ab apply ho chuka hai (flag OFF default), UPDATE section upar dekho.** Purane "abhi tak koi patch nahi" wali line ka matlab ab badal gaya hai.
- **Result badlenge by design** (ye bit-identical speed-up nahi hai). Isliye flag OFF hone par purana sim bit-identical rehna zaroori hai.

---

## 1. Pichla kaam (context, 1 minute mein)

- **prompt.md** pichle chat ka handoff hai (perf optimization: Sereno Flux ZETA / OPT-MECO / CONVO ko tez karna). Wahan ke rules: sim results nahi badalne (speed work ke liye), Determinism (x2) button se check, **sim-related patch se pehle user se confirm**, `ops = TunerEngine.tick` calls.
- Uske baad ke changes jo already files mein hain: `DORMANT_ON = true` (worker-sim.js ~274) aur UI throttle. Dono mil ke ZETA ~2m18 se ~1m39 (~28%) tez hua. User ne kaha "itna fast bhi sahi hai", aage isko mat chhedna.
- **getPhase experiment (FAIL, revert ho chuka):** `Guidance.onSnapshot` ka per-tick `getStatus()` ko `getPhase()` se sasta karne ki koshish. Bench mein stage/payload hash identical aaye, par no-gs loop mein guidance state/status alag aaya (kaaran pata nahi, control run nahi tha) aur speed fayda sirf ~1-3% tha (maine 5-7% bataya tha, galat). User ne kaha revert karo. **Dobara mat karna.**
- **Seekh (is naye kaam ke liye bhi lagu):** (a) koi bhi A-vs-B comparison test mein **control run** (same config do baar) zaroor rakho, warna run-order artifact aur asli farak alag nahi pata chalta. (b) fayda ka andaaza bata ke naya claim mat karo bina measure kiye. (c) Phone ke numbers desktop pe lagu nahi hote.

---

## 2. User ke standing rules

1. **Koi bhi sim-related patch dene se pehle user se confirm karo.** Is gimbal kaam ke liye user ne direction approve ki hai ("humein ye add karna hi hoga", "abhi git pe push hai, idhar badlav kar sakte hain"), par jab bhi naya interface ya naya decision aaye, short confirm lo.
2. Naye behaviour **flag ke peeche, default OFF**. Flag OFF = purana sim bit-identical (Pro Alpha ka **Determinism (x2)** button se verify).
3. Flag ON mein bhi sim deterministic hona chahiye (run-to-run same).
4. Reply style: Hinglish, mobile screen ke hisaab se chhote hisson mein, jawab pehle. User technical hai, 2nd-order control, Newtonian angular motion waghera samajhta hai.
5. User ne is chat mein 2 baar miscommunication jhela. **Sabse pehle terms define karo:** user gimbal ko **rate command** deta hai (`setGimbalRate`), position nahi. "Lag" word ambiguous tha; wo yahan **actuator ka rate ek jhatke mein nahi badal sakna** matlab hai (angular acceleration limit), angle ka lag nahi.

---

## 3. Sim abhi kaise kaam karta hai (code facts, line numbers uploaded files ke hisaab se)

**Guidance side (guidance-blocks.js):** next-tick state predict hota hai (`dNext = Derivation.deriveForState(...)`, ~186), us tick ke liye zaroori torque se `g_req_deg` nikalta hai, phir **4 jagah** same formula:
```js
const R_req = (g_req_deg - g_N) / dt;   // lines ~363 (ascent), ~1054 (insertion), ~1543, ~2296
```
Yaani "gimbal ko agle tick tak g_req pe pahuncha do" (1-tick deadbeat rate command). `g_N` = engine ka current `gimbalDeg`. Phir rate ko clamp karke `Guidance.cmdSetGimbalRate(degPerSec)` (guidance.js ~1048) bhejta hai.

**Command handler (sim.js:84-91):** `setGimbalRate` rate ko `±CONFIG.GIMBAL_RATE_DEG_S` pe clamp karta hai (global CONFIG, per-engine nahi) aur `en.targetGimbalRateDegS = rate` set karta hai. `setGimbal` (human slider) `targetGimbalRateDegS = NaN` kar deta hai ("human always wins").

**Physics (physics.js:862-886):**
```js
if (Number.isFinite(e.targetGimbalRateDegS)) {          // rate mode (guidance)
  e.gimbalDeg += e.targetGimbalRateDegS * dt;            // <- line 877, INSTANT rate
  e.gimbalDeg = clamp(e.gimbalDeg, ±CONFIG.GIMBAL_MAX_DEG);
} else { /* angle-slew path (human slider), alag, abhi mat chhedo */ }
```
**Dikkat:** rate ka koi dynamics nahi, `rate_actual` hota hi nahi.

**State save/restore:**
- Engine fields `vehicle.js:105` (`gimbalDeg: 0`), `:114` (`targetGimbalRateDegS: NaN`).
- `physics.js:98-108`: body rebuild mein engines ke kuch fields `old` se copy hote hain (`massFlowRate, targetMassFlowRate, gimbalDeg, targetGimbalDeg, currentF`). **Naya field yahan bhi add karna padega**, nahi to rebuild pe reset ho jayega. (`targetGimbalRateDegS` bhi yahan copy nahi hota; ye purani baat hai, mat badlo jab tak zaroori na ho.)
- `worker-sim.js:82-110` `captureSnap/restoreSnap`: bodies ko `deepClone` karte hain, to engine ke upar rakha naya field **apne aap** snapshot mein aa jayega (SA snapshot, sweep sab ke liye). Phir bhi test se confirm karna.

**Numbers:** DT = **1/80 s** (12.5 ms). `componentLibrary.js` mein Merlin (sea-level) aur MVacD dono: `gimbalMaxDeg: 8`, `gimbalRateDegS: 40`. **Dhyan:** physics/sim `CONFIG.GIMBAL_*` (global) use karte hain; library ke per-type values kahan CONFIG se judte hain ye abhi verify nahi hua. `config.js` abhi uploaded nahi hai (CONFIG isme define hota hai).

---

## 4. Reality research (web search se; Falcon 9 specific numbers NAHI mile)

- Merlin ka gimbal **hydraulic actuators** se hota hai; pressure engine ke turbopump se (RP-1 fluid, recycle hota hai). Source: https://www.wevolver.com/specs/merlin-engine-merlin-1d-falcon-9-falcon-heavy
- Traditionally spacecraft gimbal actuators hydraulic hi rahe hain. Source: https://machinery.mas.bg.ac.rs/handle/123456789/730
- Teen actuator types (hydraulic, electromechanical, electro-hydrostatic) ki dynamics similar: first-order bandwidth **> 30 rad/s** (≈ time constant ≤ 33 ms). Source: https://castjournals.cast.org.cn/joweb/ddyht/EN/1189585009322222590
- Ek upper-stage TVC ka min bandwidth **> 6 Hz** at 1° command. Source: https://www.newnonmun.com/article=10545380
- Servo models mein deadband, friction, hysteresis, compressibility hote hain. Source: MathWorks video (ch.mathworks.com, electro-hydraulic servo actuators).
- Actuator bandwidth stability ko affect karta hai (SLS analysis): https://ntrs.nasa.gov/api/citations/20190033320/downloads/20190033320.pdf
- Electromechanical actuators bhi closed-loop (brushless motor + resolver), stepper nahi: Moog white paper.
- **Ye sab search snippets se hai, poore papers nahi padhe.** **SpaceX/Falcon 9 ke gimbal ka alpha, bandwidth, resolution public nahi mila.**

**Isliye `a_max` hamara ASSUMPTION hai, sourced number nahi:** library ke 40°/s rate limit aur ~0.1 s mein 0 se 40°/s maan ke **a_max ≈ 400 °/s²** (plausible range 200-800). Real mein alpha constant nahi hota: chhote commands pe linear regime (bandwidth se tay), bade commands pe saturation (hydraulic supply/load pe depend). Isliye **sweep karna hai**, ek number pe bharosa nahi.

---

## 5. Decided design

### 5.1 Physics model (flag `GIMBAL_ACCEL_ON`, default `false`)
Naya engine state: `gimbalRateActDegS` (init 0, `vehicle.js` mein `gimbalDeg` ke paas).

Rate mode mein (physics.js:873-879 ki jagah, flag ON par):
```js
const vMax = CONFIG.GIMBAL_RATE_DEG_S;
const rCmd = clamp(e.targetGimbalRateDegS, -vMax, vMax);
let a = (rCmd - e.gimbalRateActDegS) / TAU_R;      // linear regime (TAU_R ~ 0.03 s; TAU_R->0 => pure slew limit)
a = clamp(a, -A_MAX, A_MAX);                        // saturation regime (A_MAX ~ 400 deg/s^2, SWEEP 200/400/800/inf)
e.gimbalRateActDegS += a * dt;                      // rate pehle (semi-implicit)
e.gimbalDeg += e.gimbalRateActDegS * dt;            // angle baad mein
e.gimbalDeg = clamp(e.gimbalDeg, ±CONFIG.GIMBAL_MAX_DEG);
if (angle mechanical stop pe hai aur rate bahar ki taraf) e.gimbalRateActDegS = 0;
```
`TAU_R = 0` (ya bahut chhota) rakhne par ye pure slew-limit hota hai (`a = clamp((rCmd - v)/dt, ±A_MAX)`); `dt < TAU_R` hone par explicit Euler theek hai (12.5 ms < 33 ms).
- Flag OFF: purana code (line 877) bilkul waisa hi.
- Human slider (angle-slew) path **unchanged**. Slider se rate mode mein switch hone par `gimbalRateActDegS` ko 0 ya last step/dt pe initialize karna decide karna hai (open, 9.3 dekho).
- Config params: `GIMBAL_ACCEL_ON`, `GIMBAL_ACCEL_DEG_S2` (a_max), `GIMBAL_TAU_S` (tau_r). `sim.js:317-318` jahan guidance env ko `GIMBAL_MAX_DEG`/`GIMBAL_RATE_DEG_S` mil rahe hain, wahan ye teeno bhi bhejo.

### 5.2 Guidance law (user ka design) — shared helper
4 jagah ka `R_req = (g_req_deg - g_N)/dt` ek helper se replace hoga. **Flag OFF par helper purana formula hi return kare (bit-identical).**

User ka idea: current rate `v` se **2 tick predictive Newtonian** transition, target `G` aur target pe final rate `vf` tak. Semi-implicit integration (`v1 = v0 + α0·dt; g1 = g0 + v1·dt; v2 = v1 + α1·dt; g2 = g1 + v2·dt`) maan kar, `g2 = G, v2 = vf` ke liye:
```
d  = G - g0
α0 = (d/dt - v0 - vf) / dt      // vf = 0 hone par: (d/dt - v0)/dt   [mera derivation, vf != 0 test nahi hua]
```
Sirf `α0` apply hota hai (receding horizon), har tick dobara compute. Phir **braking guard** (saturation mein zaroori, neeche 6 dekho):
```
vcap = 0.9 * sqrt(2 * A_MAX * |d|)
vnew = v0 + clamp(α0, ±A_MAX) * dt
if (|vnew| > vcap and vnew heads toward target) α0 = (sign(d)*vcap - v0) / dt
α = clamp(α0, ±A_MAX)
R_cmd = clamp(v0 + α*dt, ±vMax)       // physics ko rate command; v0 = e.gimbalRateActDegS
```
Is tarah interface `setGimbalRate` hi rehta hai (alpha seedha command karna zaroori nahi), aur physics ki accel limit sirf safety net bani rehti hai. User ke dimaag mein original idea alpha command ka tha; dono equivalent hain (`R_cmd = v + α·dt`). Interface choice open hai (9.1).

---

## 6. Numerical findings (python, open-loop, static target, `a_max=400`, dt=1/80)

Law: 2-tick deadbeat (vf=0), `α` clamp `±a_max`, rate limit 40°/s, semi-implicit.

- **Chhota gap (`≤ a_max·dt²`, yaani ~0.06° at 400; 0.03° at 200; 0.125° at 800):** 1-3 ticks mein settle, overshoot ~0, initial rate 10°/s ke saath bhi (0.05° gap: ~0.01°). User ki baat yahan 100% sahi: braking aur continuity khud aati hai.
- **Bade gap pe bina guard:** clamp lagne par α **+max pe atka rehta hai** (kyunki law ka gain ~1/dt², lagbhag infinite), phir seedha **−max pe flip** (bang-bang). Gap 1.0°: overshoot **0.56°**, settle 22 ticks. Gap 0.3°: overshoot 0.05°, settle 6 ticks.
- **dt chhota karne se overshoot ghatta nahi, badhta hai:** gap 1.0°: dt 1/80 → 0.56°, 1/400 → 0.82°, 1/1600 → 0.96° (≈ gap ke barabar, continuous limit). Alpha trace (gap 1°, dt 1/80): `400,400,400,400,400,−400,−400,...,0,400,...` (ringing).
- **Guard ke saath:** gap 1.0°: dt 1/80 → **0.04°**, dt 1/400 → **0.002°**; alpha trace `400,400,400,400,−353,−383,−400,−400,−304,240,0,0,...` (dheere brake, 0 pe settle). Chhote gap mein guard kabhi active nahi hota.
- **Limits:** ye static-target, open-loop test hai. Asli guidance mein `g_req` har tick vehicle ke state se badalta hai. Final verdict sirf asli sim se. Mera "sqrt braking law" wala reference discrete form mein chatter karta tha, wo comparison valid nahi hai (ignore karo).

Reproduce karne ka core (python):
```python
import math
def run(gap,a,dt,guard,v0=0.0,vmax=40.0,T=1.0):
    g=0.0;v=v0;G=gap;peak=0;n=int(T/dt)
    for k in range(n):
        d=G-g; al=(d/dt-v)/dt
        if guard:
            vcap=math.sqrt(2*a*abs(d))*0.9
            vnew=v+max(-a,min(a,al))*dt
            if abs(vnew)>vcap and (vnew*d>0): al=(math.copysign(vcap,d)-v)/dt
        al=max(-a,min(a,al))
        v=max(-vmax,min(vmax,v+al*dt)); g+=v*dt; peak=max(peak,g)
    return peak-G, g
```

---

## 7. Kaam kahan matter karega (user ka analysis, sahi hai)

- **Sinusoid profile** (PUSH, `tau_desired ~ sin`, rate 0 se continuous shuru): accel bahut chhoti (kuch °/s²), limit ke neeche, koi asar nahi.
- **Circularize burn:** stage target ke paas aligned, chhote corrections, rate changes chhote.
- **Asli risk:** **stage burn shuru ka bada rate jump.** Gimbal angle 1° se upar user ne kabhi nahi dekha, par **angle nahi, gap matter karta hai** (ek hi tick mein 1° gap ban sakta hai).
- Guidance har tick re-compute karti hai, to khud correct karti hai, par bina guard ke ringing aati hai (upar 6).

---

## 8. Implementation plan (is order mein)

1. **Config.js upload karwao** (DT, GIMBAL_RATE_DEG_S, GIMBAL_MAX_DEG kahan/kaise define hain) aur dekho `componentLibrary` ke per-engine `gimbalRateDegS`/`gimbalMaxDeg` physics tak kaise pahunchte hain (per-engine ya global CONFIG).
2. **Physics patch** (flag OFF): `vehicle.js` mein `gimbalRateActDegS: 0`; `physics.js:98-108` rebuild copy mein add; `physics.js:873-879` mein flag-ON branch; `sim.js:317` env mein 3 naye params.
3. **Guidance helper** `gimbalRateCmd(g_req, g_N, v_act, dt, env)` (guidance-blocks.js ke upar ya Derivation/primitives ke paas), 4 sites (~363, ~1054, ~1543, ~2296) pe call. `v_act` engine se `gimbalRateActDegS`. Flag OFF par purana formula.
4. **Verify (zaroori order):**
   a. Flag OFF: **Determinism (x2)** + purane files se **bit-identical** (control run ke saath).
   b. Flag ON: run-to-run deterministic.
   c. **Sweep:** `a_max ∈ {200, 400, 800, inf}`, `tau_r ∈ {0, 30 ms}`; metrics: apogee/circ error/fuel/final orbit, gimbal peak angle, peak |rate|, **saturation tick count**, overshoot per phase, ringing (sign flips).
   d. Comparison: flag ON vs flag OFF results ka delta table. Agar delta bahut chhota, to "sim robust" claim ban jaata hai.
5. **Re-tune:** ON mode mein MECO/G/T/bias dobara tune karne pad sakte hain (tuner already hai). Ye user ko batao, khud assume mat karo.
6. Guard ya `vf` choice sirf asli sim sweep ke baad finalize karo.

---

## 9. Open decisions (user se poochna)

1. ~~Interface~~ **CLOSED:** user ne `setGimbalAccel` (alpha command) chuna.
2. **`vf` (target pe final rate):** 0 ya `g_req` ke change rate se (moving target ke liye continuity)? Mera derivation `vf != 0` ke liye hai, par test nahi hua.
3. **Slider se rate mode switch par `gimbalRateActDegS` init:** 0 ya last step/dt?
4. **`a_max` default:** 400 (assumption) ya sweep ke baad kuch aur? Per-engine type mein rakhna hai (`gimbalAccelDegS2` library mein `gimbalRateDegS` ke saath) ya sirf CONFIG global?
5. Deadband/hysteresis aur latency (delay) abhi scope mein NAHI. Latency deadbeat law ko oscillate karwa sakti hai, isliye baad ke liye.

---

## 10. Pitfalls / dhyan rakhne ki baatein

- 4 guidance sites ek hi formula hain, ek chhoot gayi to ek phase purane (instant) assumption pe chalegi aur ON mode mein mismatch banega.
- `physics.js` rebuild copy list mein naya field na dalne se rate state bug banega jo sirf kuch scenarios mein dikhega.
- Flag OFF par **koi bhi extra computation guidance/physics ko bit-level par nahi badalna chahiye** (even `getPhase` ki tarah "equivalent" code path mat chhodo; getPhase isi wajah se revert hua tha, unverified equivalent path ka koi fayda nahi).
- Speed claims mat karo; naya code per-tick cost bhi badhata hai (helper sqrt/clamp), profile se check karna ho to alag se.
- `sereno-bench.html` mein koi naya test button jod rahe ho to ek **control run** (same mode do baar) zaroor rakho.
- Search/web numbers ke baare mein honest raho: Falcon-specific alpha public nahi hai.

---

## 11. Next chat mein ye upload karwao

`config.js` (zaroori), `physics.js`, `sim.js`, `vehicle.js`, `guidance.js`, `guidance-blocks.js`, `worker-sim.js`, `componentLibrary.js`, `sereno-bench.html`, `prompt.md`, aur ye file. (`sereno-flux.html` sirf agar tuned params ya UI se kuch dekhna ho.)

Next chat ki pehli line: "GIMBAL_REALISM_HANDOFF.md padho, section 8 step 1 se shuru karo, patch se pehle section 9 ke open decisions mujhse pooch lo."
