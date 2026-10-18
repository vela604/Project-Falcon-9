# HANDOFF (8th session) — chhota version. Purana lamba handoff ab history hai.

Hinglish, mobile-friendly, jawab pehle. Token bachao: badi files `grep -n` + `sed -n a,bp` se padho, poori nahi.
Standing rule: sim-related patch dene se pehle user se short confirm lo. `workerBridge.js` / `fastforward.worker.js` overwrite mat karo, targeted edit karo (git merge risk).
Next chat ki pehli line: "HANDOFF_8th_session.md padho, section 3 (bias bug) se shuru karo."

## 1. DONE (main branch, commit 1107dd6; purana model git tag `pre-gimbal-accel` = b334b6b)
- Gimbal accel model hamesha ON. Flag `GIMBAL_ACCEL_ON` aur `HOLD_LAW` hat gaye. Hold law sirf `aoa_pd` (`HOLD_PD_KP/KD`, `GIMBAL_CMD_TAU_S=0.1`).
- `gimbalAccelDegS2` (200), `gimbalRateDegS`, `gimbalMaxDeg` ab thruster-type properties (componentLibrary.js merlin-1d + merlin-1d-vac). vehicle.js engine object mein copy. Test hook: `CONFIG.GIMBAL_ACCEL_OVERRIDE` (Infinity allowed).
- physics.js: ek actuator model (accel cmd > rate cmd > slider angle). Slider angle ka law `_gimbalAlphaCmdPhys` = guidance-blocks `_gimbalAlphaCmd` ki copy (dono sync rakhna).
- Command handlers per-engine clamp: sim.js, physics.worker.js, fastforward.worker.js, guidance-tester.html, guidance-numerical.html.
- guidance snapshot engines mein ab `gimbalMaxDeg/RateDegS/AccelDegS2/targetGimbalDeg` aate hain (physics.worker serializeForMain + workerBridge projection).
- Bench: worker-sim `traceRun` ab `accelDegS2` -> OVERRIDE; compare page = a-sweep, baseline pehli a, control = same a do baar.
- Verify ho chuka: bench control bit-identical; a=200 numbers purane "ON a=200" jaise (vt@coast 4852, tilt@MECO -33.9). Page: snapDbg gap/latency, Determinism x2, slider, tester pages OK. User ne tester mein fast sim se mission success bhi karwa liya (thoda tune karke).
- Handoff ke purane line numbers galat the: V3 preset guideConfigDefaults mein `leoInsertionV3` (~162-185) hai, 257-266 nahi.

## 2. Jo legacy bacha hai (jaan-bujh kar)
- `CONFIG.GIMBAL_MAX_DEG/RATE_DEG_S` sirf js/simJs/main.js 193/197 slider ke liye + guidance env mein 2 unused legacy keys (workerBridge.js, sim.js, guidance-*.html collectStackData). Baad mein slider engine se padhe, env keys hatao.
- `baselineRaw` (atlas-prism/lib/config.js:40) abhi purana OFF-tuned hai: retune ke baad update.
- Purane keys wale localStorage user presets `validateConstantsStrict` mein fail honge, re-save karna padega.
- Tag `4e2c2b7` pehle `pre-gimbal-accel` tha (galat commit); user se pucha nahi gaya ye kya tha.

## 3. ABHI KA FOCUS: STAGE_BURN bias ka asar nahi (investigate)
Symptom: tester mein `STAGE_BURN_AOA_BIAS_DEG` badalne par path par KOI effect nahi. STAGE_BURN mein AoA ~0.0096 deg (telemetry.js degrees mein hai) dikhta hai, 0.59 nahi.
Code (guidance-blocks.js ~995-1070): STAGE_BURN mein pehle BOOTSTRAP PD (bias NAHI) chalta hai jab tak `|aoaDeg| <= STAGE_BURN_AOA_MARGIN_DEG (0.001)`; sirf uske baad `_st.stageBurnAoaBootstrapped = true` aur biased law (`aoaErr = aoa - bias`) chalta hai.
Sabse mazboot hypothesis: AoA kabhi 0.001 deg ke neeche nahi jaata (steady ~0.0096 > 0.001) => bootstrap kabhi khatam nahi hota => bias branch kabhi chalti hi nahi. Isi liye bias ka asar zero.
Verify: `_st.stageBurnAoaBootstrapped` ko telemetry/log mein dikhao (ya ek tick par console.log). Dusri possibilities: tester ka patch/`validateConstantsStrict` bias key tak nahi pahunchata; tuner values vs getGuideConfig mismatch.
Fix options (user se confirm lo): margin badhao ya bootstrap ko time/rate se exit karo; PD steady offset ka kaaran dekho (torqueEnvironmental prediction mismatch). Phir bias ko dobara retune karo (purane tuned bias numbers shayad bootstrap-only path par tuned the).
Ascent mein bhi AoA ~0.01 deg se dheere dheere badhta hai (target 0, no bias): PD static error (residual torque / (I*kp)), q badhne par badhta hai. Refactor ne ascent badla nahi (bench numbers same). Optional: compare page mein AoA column jodo aur `pre-gimbal-accel` se compare karo.

## 4. PENDING (shayad aur bhi hai, user ko yaad nahi)
1. **Grid fins par same accel-limited actuator** (angular accel + rate + range, thruster-type jaisa component property). `_gimbalAlphaCmd` shared law reuse; physics.js ~329 pe grid fin type already gimbal range padhta hai.
2. **Retune** (G, T, bias, lead, meco) a=200, 320 km, bootstrap/tuner se; pehle section 3 fix karo. Bench mein abhi dono runs 1500 s par cap, COAST_ROTATE mein atak jaate hain (baseline a=inf ~1006 s, a=200 CIRCULARIZE@480 tak jaata hai par final orbit 404/194 km).
3. **RCS_BOOST duration (B7):** a=inf ~76 s vs a=200 ~18 s. Retune ke baad har point par dekho; 10x jhoole to apogee-error vs time plot.
4. Insertion sites (CIRCULARIZE, suicide, STAGE_BURN) par optional shared command-filter helper (default 0), slow phases (landing/hover) ke liye.
5. Root-cause chatter fix (self-consistent g_req) sirf zarurat par.
6. Bench metric "gimbal travel 0.3 s after throttle(0)"; `trajectory_worker.js` ON check.
7. Slider per-engine (main.js), env legacy keys safai.

## 5. Upload karwao
`guidance-blocks.js`, `telemetry.js` (+ jahan se AoA/phase state aati hai), `guidance-tester.html`, `worker-sim.js`, `guideConfigDefaults.js`; grid fins ke liye: grid fin component/type file, `physics.js` ke grid-fin hisse, `controls.js`.
