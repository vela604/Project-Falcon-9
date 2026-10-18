# GRID FIN ACCEL — PLAN + HANDOFF (9th session)

Hinglish, mobile-friendly, jawab pehle. Token bachao: badi files `grep -n` + `sed -n a,bp` se padho, poori nahi.
Standing rules: sim patch dene se pehle user se short confirm lo. `workerBridge.js` / `fastforward.worker.js` overwrite mat karo, sirf targeted edit.
Next chat ki pehli line: "GRIDFIN_ACCEL_PLAN.md padho, section 3 (design) ke decisions confirm karke section 4 se shuru karo."

## 1. Is session mein DONE (user ne verify karna hai / kar liya)
- STAGE_BURN: PD -> PID. Bias ab current AoA se seed hoke 0.5 deg/s se target tak ramp (zeroing/bootstrap hata). KP/KD = 4/4 default (guidance-blocks.js + guideConfigDefaults.js). Naye fixed constants (tunable nahi): `STAGE_BURN_AOA_KI=1.0`, `STAGE_BURN_AOA_BIAS_RATE_DEG_S=0.5`. Integrator: conditional (|err|<0.05 deg), clamp 0.005 rad*s, state `_st.sbAoaInt`, `_st.sbBiasEff`, flag `stageBurnAoaSeeded` (naam badla).
- `STAGE_BURN_AOA_MARGIN_DEG` poora hata diya (blocks, defaults, IMPORTANT list, descriptions, atlas lattice/config, pro-alpha/sereno-flux/sereno-bench). Bacha: `atlas-prism/tests/*.html` ki ~10 files abhi bhi margin key pass karti hain (harmless, baad mein saaf).
- Ascent HOLD (`aoa_pd`): integral add. `HOLD_PD_KI=0.3` fixed constant, state `_sub.aoaInt`, PUSH/COAST/PRE_COAST mein reset, gate 0.05 deg, clamp 0.005. HOLD_PD_KP/KD abhi 1/2 hi hain.
- Descriptions: `guideConstantDescriptions.js` mein KI/BIAS_RATE/HOLD_PD_KI add, PD->PID wording.
- PENDING user side: purane saved presets `OUTDATED SCHEMA` honge (strict validator). JSON mein margin line hatao; `insertion` mein KI=1, BIAS_RATE=0.5; `ascent` mein HOLD_PD_KI=0.3 jodo (ya full-backup import, lenient fill). STAGE_BURN + ascent verify aur phir retune (baselineRaw atlas config.js abhi purana).

## 2. Grid fin: abhi ka code (verified, file:line purane repo ke hisaab se)
- Fin type constants: `componentLibrary.js` ~303-322 `typeConstants`: `maxDeployDeg 90`, `maxControlDeg 30`, `maxSlewDeployingDegS 18`, `maxSlewControllingDegS 40`. `capabilities.controlSides ['F','B']`.
- State: `physics.js` ~190-202 `_makeBody`: `gridFins.{L,R,FB}` = `{deploy, control, targetDeploy, targetControl}` (deg). deploy 0 = deployed, L:+90 / R:-90 / FB:+90 = stowed. control sirf FB.
- Actuator: `physics.js` ~312-360 `updateGridFins(body, dt)`: sirf rate-limited linear slew (deploy 18 deg/s, control 40 deg/s), target envelope clamp symmetric +-max. Lock rule: `FB.deploy !== 0` => `targetControl = 0`. Call order: `applyActuatorRateLimitsForBody` (1981) phir `updateGridFins` (1982).
- Reusable law: `_gimbalAlphaCmdPhys(g_req, g_N, v, dt, aMax)` physics.js (gimbal actuator ke paas, accel cmd + vcap).
- Command handlers (dono mein same code): `physics.worker.js` ~522-560 aur `fastforward.worker.js` ~409-440: `gridFinsDeploy` (binary: `msg.deployed` -> sab fins target 0 ya +-maxDeploy), `gridFinsControl` (`msg.controlDeg` clamp +-maxControlDeg -> `FB.targetControl`). Dono sirf target set karte hain.
- Guidance builders: `guidance.js` 1021-1026 `cmdGridFinsDeploy(deployed)`, `cmdGridFinsControl(controlDeg)`. Koi guidance block abhi fins ko command nahi karta (sirf slider: controls.js ~315/320, button main.js).
- Snapshot: workerBridge.js 573 `gridFins: b.gridFins || null` (poora object). stateBuffer: L/R/FB.deploy + FB.control hot floats ([15..18]); targets/rates cold. Cold copy `physics.worker.js` ~909-928 sirf targetDeploy/targetControl copy karta hai.
- Exact-equality users (angle ko target par EXACT snap karna zaroori): `main.js` 365-378 (`deploy !== 0`, `FB.deploy === 0`), `controls.js` 291, physics lock rule.

## 3. Aero finding + DESIGN (user se confirm baaki jahan "CONFIRM")
**Aero check (done):** `physics.js` 1115-1300 (`bodyGridFinProfile`, `_gfAxes`, `computeGridFinAero`): har fin ka force sirf uske deploy/control angle se aata hai ("stowed/deployed/mid-slew/control poses ek hi model"). L/R ka deploy angle fin ko in-plane ghumata hai, to **L/R ka partial deploy asli force+torque banata hai** (face through-flow + cascade lift + edge drag, panel centre ke CP shift ke saath). Lee-side shielding L/R par hai. FB = F+B pair (z cancel, x,y double). => **aero model mein koi badlaav nahi chahiye**; L/R steering physically valid.
Side effects jo check karne hain: (a) `bodyGridFinProfile` cache (L/R/FB deploy, FBc equality) har tick rebuild hoga jab fin chal rahe ho: sirf perf, thik. (b) massProps live deploy se CoM shift hota hai (`massProps.js` ~437-470, cache ~597-607): verify cache key continuous deploy par stale na ho.

**Design:**
1. Actuator: `updateGridFins` mein ek generic helper `_gfSlewAccel(angle, rate, target, dt, aMax, vMax, lo, hi)` -> accel clamp, rate clamp, angle clamp (hit par rate 0), `_gimbalAlphaCmdPhys` ka law. Deploy (L, R, FB) aur control (FB) dono isi se. Rate states: `f.deployRate`, `f.controlRate` (guarded `|| 0`, FF/restore safe).
2. Rates: deploy rate cap **18 deg/s hi rahega** (user: reality). Control rate cap 40. Accel (typeConstants, naye): `maxControlAccelDegS2` = 200 **CONFIRM**, `maxDeployAccelDegS2` = 100 **CONFIRM**. Dono type property (thruster `gimbalAccelDegS2` jaisa). Test hook `CONFIG.GRIDFIN_ACCEL_OVERRIDE` (Infinity allowed => purane rate-only slew jaisa, regression check).
3. Target snap: |target-angle| < 1e-6 aur |rate| < 1e-3 => angle = target exactly, rate 0 (equality checks ke liye).
4. Per-fin deploy range tight: L [0,+maxDeploy], R [-maxDeploy,0], FB [0,+maxDeploy] (abhi symmetric +-). Purane commands ye hi values dete the, behaviour same. **CONFIRM**.
5. Command per-fin controllable (binary nahi): `gridFinsDeploy` message mein optional `angles: {L?, R?, FB?}` = deploy angle **magnitude** deg (0 = fully deployed, maxDeploy = stowed), sign worker lagata hai (L +, R -, FB +). Jo key na ho wo fin waise hi rahta hai. Purana `deployed: true/false` path chalta rahe (sab fin ek saath). Clamp 0..maxDeployDeg fin type se.
6. `guidance.js`: naya `cmdGridFinsDeployAngles(angles)` (type `gridFinsDeploy`, `angles`), purana `cmdGridFinsDeploy(deployed)` waisa hi. Export list (~1117) mein add.
7. Optional/baad mein: cold copy mein `deployRate/controlRate` copy (FF handoff continuity), controls.js per-fin L/R sliders, guidance block jo fins chalaye.

## 4. Edits ki list (user ke "haan" ke baad)
1. `componentLibrary.js` typeConstants: 2 accel constants (~line 322).
2. `physics.js`: `_makeBody` gridFins mein rate fields (optional, guarded), `updateGridFins` rewrite (deploy 3 fins + control FB), helper `_gfSlewAccel`, `CONFIG.GRIDFIN_ACCEL_OVERRIDE`.
3. `physics.worker.js` + `fastforward.worker.js`: `gridFinsDeploy` case mein `msg.angles` branch (targeted edit, baaki file same).
4. `guidance.js`: `cmdGridFinsDeployAngles` + export.
5. (optional) `physics.worker.js` cold copy ~920: 2 lines rate copy.

## 5. Verify
- `GRIDFIN_ACCEL_OVERRIDE = Infinity` par fin motion purane jaisa (18/40 deg/s linear).
- Default: control 0 -> 30 deg ~0.85 s; deploy 90 deg ~5.1 s; koi overshoot nahi; target par exact snap (button text "Deploy/Stow Grid Fins", ACW/CW enable/disable sahi).
- L/R partial deploy (e.g. L=45, R=45): force/torque smooth, CoM shift sahi, koi NaN nahi; fast-forward on/off par same trajectory (determinism x2).

## 6. Next chat mein user se ye files chahiye (poori nahi, ranges)
`componentLibrary.js` 266-335 (mila), `physics.js` (user ne upload kiya), `physics_worker.js`, `fastforward_worker.js`, `guidance.js` (upload hue), `massProps.js` 590-620 (cache key check). Naye edits ke liye `controls.js` 285-325 sirf optional slider ke liye.
