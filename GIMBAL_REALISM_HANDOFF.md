# GIMBAL REALISM — Handoff (is chat ka poora kaam, next chat ke liye)

Likha: 2026-10-18. Bhasha: Hinglish. Is file ko padhne ke baad naye chat ko user se kuch re-explain nahi karwana chahiye.

---

## STATUS (4th session) — PAGE PATH BHI PATCH HO GAYA (flag OFF default)

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
