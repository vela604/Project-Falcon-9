me: Pasted content is hand off, to batao aage kya karna hai mujhe
pasted content: # Handoff: Sereno Flux worker speed-up (Atlas Prism)

Is chat ke saare findings neeche hain. Agle chat mein ye text paste karna aur files dobara upload karna.

## 0. Goal aur rules
- Sereno Flux (ZETA, OPT-MECO, CONVO) ko tez karna.
- Sim logic ya results nahi badalne. Speed-up bit-identical hona chahiye. Check: Pro Alpha ka Determinism (x2) button.
- Main Hinglish mein baat karta hoon, Android pe test karta hoon. Chhote aur seedhe changes chahiye, files full replace ke liye.
- Koi bhi sim-related patch dene se pehle mujhse confirm karna.
- ops = `TunerEngine.tick` calls. `hook.js` ka `m.ticks` ops ke liye use nahi karna.

## 1. Kya delivered hai (patched copies, originals untouched)
- **lib/worker-sim.js (naya):**
  - `PROF_ON` aur `PROF_BENCH` flags hain. `PROF_ON=false` karne se saari instrumentation band.
  - `PROF_BENCH` har setupSA pe ~0.3 s ka micro-bench jodta hai, measurement ke baad false kar do.
  - `restoreSnap`, `captureSnap` aur `prepareRun` ke timers, probe ke coast/circ/full ke ms+ticks.
  - Naya `benchLoop` job.
  - Har job ke baad `{type:'prof'}` message jaata hai.
- **engine-fx.js (naya):** RESULT line ke neeche PROF lines (busy % breakdown, µs/tick, bench). **Ye real page pe abhi validate nahi hua.**
- **sereno-bench.html:** `engines/` folder mein rakhna (sereno-flux.html ke saath). QUICK (~4 min) aur DEEP (~8 min), report COPY button se.

## 2. Measurements (RMX3870, 8 cores, 4 GB, Android 16)
Dhyan do: UA mein `wv` tha, yaani page WebView mein khula, normal Chrome tab mein nahi.

**Real ZETA (pehle):** N=7, 7 workers, 759K ops, wall 1m57s, ~6.5K ops/s total, per-worker ~0.86-1.13K ops/s (W07 3.19K), util 84%.

**Lab page, fixed-work loops (µs/tick):**

| Workers | burn raw | coast raw | pure-JS ms/rep (run 1) |
|---|---|---|---|
| 1 | 208 | 147 | 340 |
| 2 | 268 | 157 | 346 |
| 4 | 473 | 263 | 545 |
| 7 | 839 | 458 | 692 |

- Total throughput ~13-15K ticks/s, jo 4 workers pe hi saturate ho jaata hai.
- Single thread 3.8-4.8K ticks/s (Pro Alpha jaisa).
- Second run mein sab ~20-28% slow tha (n=1 CPU test 340 → 413 ms). Phone garam tha, yaani thermal drift real hai.

**DEEP (real probes):**
- n=1: 2 probes, 309,680 ticks (~155K/probe), wall 87 s, **3547 ticks/s**.
- n=7: 7 probes, 914,708 ticks, wall **71 s**, total ~12.9K ticks/s, per-worker median 1847 [1726-4338] (n=1 ka x0.52).
- restore/capture/prepare ≈ **0%** of job time.
- Real probe µs/tick: coast 272 (n=1) / 537 (n=7), circ-eval 310/394, full 319/322.

## 3. Hypotheses ka status
| Hypothesis | Status |
|---|---|
| H1 device thread-scaling | **Partly confirmed.** Pure JS 7 threads pe ×2.1 slow, sim ×3.2-4.0 slow. Total 4 workers pe saturate. |
| H2 main thread busy | Busy-time inflate negligible (7 jobs). CPU-contention effect untested. |
| H3 hook.js yield | **Irrelevant:** ZETA hook.js use hi nahi karta. Yield MessageChannel hai, 4 ms clamp nahi. |
| H4 per-tick polling | **Disproved:** getGuideStatus 3-7 µs/call (~1-2%, noise level). `onSnapshot`/`getPhase()` patch low-value. |
| H5 load balance | ZETA N=7 mein 7 jobs aur 7 workers hain. Util 84% ≈ 1/1.21 (tail imbalance). Fix: N=2x ya job split. |
| H6 algorithmic | setupSA sirf ~2-8 s hai. Asli ticks coast mein hain (SA→CH ~56K-136K). |
| restore/capture/prepare | **Disproved:** ~2-3 ticks each, ~0% of job time. |
| imu.js `measure()` | Disabled hone pe identity (copy nahi). Config mein `imu:false`. |

**Meri galtiyan (taaki dobara na ho):**
- Maine shuru mein kaha tha ki hook.js jaisa sparse polling 4x dega, galat nikla.
- Probe loop ko sparse karna bit-identical nahi hota (COAST_HOLD detect tick khisakta hai).
- Sahi accessor `Guidance.getPhase()` hota, par uska fayda ~1-2% hi hai.

## 4. Sabse bada open lead
Real ZETA (N=7) ne 117 s lagaye aur ~1K ticks/s/worker mila. Lab DEEP (N=7) ne 71 s lagaye aur ~1.85K ticks/s/worker mila. **Real page lab se ~1.7-2x slow hai** same worker count pe. Possible wajah (koi confirm nahi):
1. **Main-thread/UI load:** `renderProgress` har 300 ms `innerHTML` rebuild karta hai aur har worker `emit('probe')` pe bhi chalta hai. Saath mein engine-fx timers aur MutationObservers. Device 4 workers pe hi saturated hai, to koi bhi extra busy thread workers ka cycle khata hai.
2. **Thermal:** real run lambi aur garam phone pe hui hogi.
3. **Params ka fark:** ZETA ke MECO/G/T/bias alag the.
4. **Lab ke andar bhi unexplained gap:** real probe coast 272 µs/tick vs bench coast+gs 174 µs/tick (n=1). Thermal ya real-state fark (booster body, collisions) ho sakta hai.

## 5. Agle chat ke experiments (value order mein)
1. **Cold/hot control:** bench mein end mein n=1 ka recheck jodna, aur ZETA ko phone thanda karke chalana. Thermal drift naapna.
2. **Real page pe worker sweep:** `sereno-flux.html` ke `doLock` mein ek line: `const n = +(new URLSearchParams(location.search).get('w')) || defaultWorkers()`. Phir `?w=3,4,5,7` pe wahi ZETA params chalao, RESULT + PROF lines note karo.
3. **UI overhead test:** `renderProgress` interval, worker `emit('probe')` aur engine-fx temporarily band karke same N pe compare.
4. **Chrome remote profile** (PC se `chrome://inspect`, USB debugging): worker thread ka Performance profile. GC share aur top self-time functions dekhna (physics: `stackMassProps`, `buildPodEntries`, `derivatives`, collision). Ye batayega ki allocation/GC asli culprit hai ya nahi.
5. **Balance patch:** N=2x workers ya job split (SA→CH aur tuneLead+FULL alag jobs). ZETA mein ~16% tak.
6. **Default workers:** `defaultWorkers()` abhi hc−1=7 deta hai. Data kehta hai ~4 pe throughput saturate hai (kam garmi). Sweep ke baad cap decide karna.
7. **Physics allocation cuts:** sirf profile ke baad, bit-identical, Pro Alpha Determinism (x2) + kuch points pe old/new metrics compare ke saath.

## 6. Code pointers
- `worker-sim.js`: `probeBiasCheckpoint` (SA→CH loop, tuneLead CPHook, FULL), `captureSnap`/`restoreSnap`, `_installOps`, `_installProf`, `_bench`, `_benchLoop`.
- `worker-pool.js`: `runEvalSA`, `_dispatch`.
- `bootstrap.js:150`: `makeEv` (OPT-MECO, SA-share).
- `sereno-flux.html`: `runZeta` ~1058, `ensureSA` ~380, CONVO ~1360, `renderProgress` ~1402, `doLock` ~255.
- `guidance.js`: `onSnapshot` 51-75, `getGuideStatus` 229.
- `hook.js`: sirf OPT-MECO (runEvalSA) aur Pro Alpha ke liye relevant.
- CONVO ek hi job chalata hai, to 1 worker busy rehta hai. Wo worker count se nahi, sirf per-tick speed se tez hoga.

## 7. Agle chat mein ye upload karna
`worker-sim.js` (naya), `engine-fx.js` (naya), `sereno-bench.html`, `worker-pool.js`, `hook.js`, `sereno-flux.html`, `bootstrap.js`, `guidance.js`, `physics.js`, `sim.js`, `primitives.js`. Aur is chat ke bench report ke numbers (upar section 2 mein hain).

claude: Handoff padh liya. Seedha plan, value order mein:
1. Pehle thermal control (10 min, sabse sasta)
Phone ko thanda karke wahi ZETA params dobara chalao. Real run 117 s vs lab 71 s ka gap thermal ho sakta hai. Agar thanda phone pe ~80 s aaye, to baaki sab experiments ki zaroorat kam ho jaayegi.
2. Real page pe worker sweep (sabse important)
sereno-flux.html ke doLock mein ye ek line badlo:
const n = +(new URLSearchParams(location.search).get('w')) || ((typeof TunerCore.defaultWorkers === 'function') ? TunerCore.defaultWorkers() : 4);
Phir ?w=3, ?w=4, ?w=5, ?w=7 pe wahi ZETA params chalao aur har run ki RESULT + PROF line note karo. Data kehta hai 4 workers pe throughput saturate hai, to shayad w=4 ya 5 wall time mein barabar ya behtar nikle, aur phone kam garam hoga.
3. UI overhead test
Same N pe compare karo: (a) normal, (b) setInterval(renderProgress, 300) band, (c) emit('probe') band, (d) engine-fx.js hata ke. Ye batayega ki main thread workers ka cycle kha raha hai ya nahi.
4. Balance patch (bit-identical, safe)
ZETA mein N = 7 aur workers = 7 hone se tail imbalance ~16-20% khaa raha hai. N ko workers ka multiple rakho (jaise N=8 ya 14 with 4 workers). Ye sirf input ka choice hai, code change nahi.
5. Default workers cap
Sweep ke baad defaultWorkers() ko Math.min(4, hc-1) jaisa cap karna (jo data se nikle).
6. Chrome remote profile
Sirf agar 1-5 ke baad bhi gap bacha ho. PC se chrome://inspect, worker ka Performance profile, GC share dekho.
7. Physics allocation cuts
Sabse last, sirf profile ke baad, aur tumhare rule ke mutabiq mujhse confirm kiye bina koi sim patch nahi dunga.
Mera suggestion: abhi steps 1 aur 2 karo. Dono mein koi sim logic nahi chhoona, sirf ek line aur ek URL param. Numbers yahan paste kar dena, phir agla step decide karenge.
Ek cheez bata du: engine-fx.js ki PROF lines abhi real page pe validate nahi hui hain. Pehle ?w=4 run mein dekh lena ki RESULT ke neeche PROF line aa rahi hai ya nahi. Agar nahi aayi to bata dena, main fix kar dunga.
Kya main sereno-flux.html mein woh ?w= wali line abhi patch karke full file de doon?

me: Dekho mujhe sirf mere phone ka concern nahi hai, in future main kabhi apne phone mein run thori karunga, main to high end devices mein run karunga jaise macbook, asus ka Ryzen 9 rtx 5050, 32 cores 16gb ram 84 mb cache memory, ya kisi laptop mein hi karunga, to mujhe bas performance badhana hai mujhe mere phone se matlab nahi hai, mujhe bas itna acurate aur optimised banana hai ki jab main un high end devices pe run karun to maximum speed mile

claude: Samajh gaya. Phone ke findings (thermal drift, 4-worker saturation, big/little cores) desktop pe lagbhag lagu nahi hote, isliye plan badal gaya.
Desktop pe asli bottlenecks
Job count hi parallelism ko cap karta hai. ZETA mein N=9 jobs hain, to 32-core machine pe bhi sirf 9 workers kaam karenge aur baaki idle rahenge. CONVO to ek hi job hai, yaani 1 worker. Yahi sabse bada lever hai.
Per-tick speed ab sabse zyada matter karti hai. Jab jobs kam hon aur cores zyada, to wall time = ek job ki length, aur wo sirf single-thread speed se tez hota hai. Isliye physics allocation/GC cuts (step 7) ab phone se kahin zyada kimti hain.
defaultWorkers() = hc−1 desktop pe risky hai. Ryzen 9 pe 32 threads ka matlab 16 physical cores + SMT hota hai, to 31 workers SMT pe oversubscribe honge. Memory bhi dekhni hai: 31 workers × har ek ka sim + snapshots, 16 GB mein tight ho sakta hai.
OPT-MECO mein main thread bottleneck ban sakta hai. Har saRun pe snapshot postMessage (structured clone) hota hai, aur 31 workers ke saath main thread dispatch + renderProgress pe choke ho sakta hai.
Naya order
Job split (ZETA/CONVO). SA→CH aur tuneLead+FULL ko alag jobs banao, to ek probe kai workers pe failega. Ye results bit-identical rakhta hai kyunki sirf scheduling badalti hai, par sim path chhoota hai, isliye tumhare confirm ke baad hi.
Chrome remote profile desktop pe. Ab PC pe seedha DevTools mein worker ka Performance profile le sakte ho, USB ki zaroorat nahi. GC share aur top self-time functions (stackMassProps, buildPodEntries, derivatives, collision) dekho.
Physics allocation cuts profile ke baad, bit-identical, Determinism (x2) check ke saath.
Worker sweep desktop pe: ?w=4,8,12,16,24,31. Dekho kahan throughput flatten hota hai, usi se defaultWorkers() cap hoga (shayad physical cores ke aaspaas).
Main-thread overhead test: 31 workers pe renderProgress/engine-fx band karke compare karo.
Snapshot clone cost: snapKB pehle hi bench mein hai. Agar KB × evals/s bada nikle, to snapshot ko compact karna padega.
Phone data se bas ek cheez kaam ki hai: restore/capture/prepare ~0% hain, to unko optimize mat karna.
Pehla kaam: sereno-bench.html ko apne laptop pe chalao (DEEP mode, workers max). Wo n=1,2,4,8,… ka scaling aur real probe µs/tick dega, aur usi se pata chalega ki physical cores ke baad scaling kahan tootti hai. Report yahan paste karo.
Job split ka design (probe ko kis jagah todna hai) main bana ke dikhaun? Wo sim ke paas ka change hai, isliye tumhara confirm chahiye.

me: Are nahi baba, N ko bhi badha diya jata hai wahan dekho to aise default bhi number of workers ke barabar hai aur in real bhi main unhein 100 rakhne wala hun wo to default values hai 9 par wo bhi override ho jata hai workers load hone ke baad number of worker ke equal ho jata hai, ye sab problem nahi hai bhai plan badalne ki jarurat nahi hai

claude: Sahi pakda, meri galti thi. zN ki default value pool.n hai aur tum N=100 chalaoge, to job count parallelism ko cap nahi karta. Job split wali baat wapas leta hoon, uski zaroorat nahi.
N=100 ka matlab hai ki sab workers lagatar busy rahenge aur bas aakhri round mein thoda tail imbalance bachega. 32 threads pe wo ~3 jobs per worker banta hai, to tail zyada se zyada ek job ka hoga, aur N ko workers ka multiple rakhne se wo bhi mit jaata hai. Yahan code change nahi chahiye.
Ab throughput-bound case hai, to asli levers ye hain:
Per-tick speed. Total throughput = workers × ticks/s per worker, to physics allocation/GC cuts ka fayda seedha multiply hoga. Isse pehle Chrome DevTools se worker ka profile lo, taaki pata chale GC aur top functions kya hain.
Worker count ka sweet spot. Ryzen 9 pe 32 threads matlab SMT hai, to ?w=8,16,24,31 sweep karo aur dekho throughput kahan flatten hota hai. 31 workers pe memory (16 GB) bhi dekhna.
Main thread. 31 workers ke saath renderProgress (300 ms innerHTML) aur engine-fx observers chhota sa overhead jod sakte hain. Same N pe on/off compare karo.
Pehla kaam wahi rahega: laptop pe sereno-bench.html DEEP chalao aur report paste karo. Usse pata chalega ki scaling physical cores pe tootti hai ya SMT pe.
Ek line doLock mein ?w= param ke liye chahiye, wo sim ko nahi chhooti. Bolo to full sereno-flux.html bana ke de doon.

me: Are yer tum smjho na, main test ke liye laptop use nahi kar skta wo bhai ka hai, mera jab poora complete work karne lagega tab unse keh skta hun karne ko, abhi mujhe phone pe full working bana ke final result wahan fir direct kaam ki kaam karunga koi test nahi aur ye sirf ek device nahi Ryzen 9 balki alag lag devices mein chalaunga in future to mujhe aisa chahiye ki kisi mein problem naa aaye, sab apna max utilization kar ske, abhi mere paas kisi browser hai to wahan se main performance wagerah bahut kuch dikha sakta hun jo tum chaho

claude: Theek hai, laptop test ki zaroorat nahi. Ek baat dhyan rakhne ki hai: phone ke worker-count numbers desktop pe lagu nahi hote, isliye worker count hardcode nahi karna. Wo har device pe khud decide hona chahiye. Per-tick speed, jo physics code ki baat hai, har device pe same faayda deti hai. To kaam do hisson mein bantta hai.
1. Worker count auto-tune (bit-identical, sirf scheduling)
Lock ke time pe ek chhota calibration chalta hai: n = 1, 2, 4, 8, ... workers pe ~0.3 s ka fixed-work loop (jaisa benchLoop pehle se karta hai).
Jab total ticks/s ka gain 10% se kam ho jaaye, wahin ruk jao aur wahi n use karo.
Isse phone pe ~4, Ryzen 9 pe jahan scaling tootegi wahan, aur MacBook pe uske hisaab se count apne aap aayega. Tumhe kuch test nahi karna padega.
Safety ke liye memory ka cap bhi lagega: deviceMemory aur calibration ke time ki worker heap dekhkar.
Tumhare 100 jobs ke saath ye sahi baithta hai, kyunki saare workers lagatar busy rahenge.
2. Per-tick speed (asli lever, phone pe profile ho sakta hai)
Chrome ka DevTools phone akele pe nahi chalta, isliye main worker ke andar timers wali instrumentation daalunga, bilkul PROF jaisi. Wo physics ke hot functions (stackMassProps, buildPodEntries, derivatives, computeDragAero, collision, getGuideStatus) ka time batayegi, aur heap growth se allocation/GC ka andaaza bhi.
Tum phone pe ek baar chalake report paste kar do, phir dekhenge ki kahan cuts karne hain.
Koi bhi physics cut bit-identical hoga, aur tumhare Determinism (x2) button se check hoga.
3. Main thread halka rakhna
Jab 31+ workers ho, to renderProgress ka 300 ms wala innerHTML rebuild aur engine-fx observers kaam chheen sakte hain. Inhe running ke time throttle karna safe hai, kyunki ye sirf UI hai.
Pehla step main abhi bana sakta hoon: auto-tune calibration, aur saath mein hot-function timers (telemetry only, sim results nahi badalte). Dono ek saath bana doon? Physics ke andar kuch nahi badalunga, isliye tumhara confirm sirf tab chahiye jab hum cuts tak pahunchenge.

me: Ye batao ki humare code mein koi aur improvement nahi ho skta kya? Yaa ab final enemy bas device issues hi hain? To mujhe sabr ho jayega ki main jitna kar skta tha code se utna kiya?

claude: Nahi, sirf device final enemy nahi hai. Code mein abhi bhi improvement ki gunjaish dikhti hai, par maine profile nahi kiya, isliye kitna milega main promise nahi kar sakta. Jo cheezein worker count, SA snapshot sharing aur polling ki thi, wo already theek hain. Ab bachi hui gunjaish per-tick physics mein hai, kyunki asli ticks coast mein jaate hain.
Mere shak (code padhke, measure nahi kiya):
Coast mein saari bodies step hoti hain. Booster, dono fairing halves aur payload poore coast (~1000+ s) tak RK4, slosh, ground-contact aur collision se guzarte hain, jabki result sirf stage/payload se aata hai. Tumhare numbers bhi isi taraf ishara karte hain: coast tick (147 µs) burn tick (208 µs) ka ~70% hai, jabki coast mein stage kuch kar hi nahi raha. Agar ye sach nikla to ye sabse bada lever hai. Result tab bhi same rahega jab tak bodies ke beech contact na ho, par ye sim ka change hai, isliye tumhare confirm ke baad hi.
Har tick ki allocation. buildSnapshot har body ke liye buildPodEntries banata hai, currentGeometry har tick stackMassProps chalata hai, aur applySloshStep mein bottomTankFillGeometry ek tick mein 3 baar call hota hai.
Hook ka per-tick kaam (OPT-MECO ke 400-1000 evals mein): gLoad, maxQ, hypot har tick. Isse bit-identical sasta banaya ja sakta hai.
Ek achhi khabar: handoff ka "unexplained gap" (real coast 272 vs bench 174 µs/tick) shayad gap hai hi nahi. Probe ka "coast" timer SA→CH tak ka hai, jisme stage burn ke bhaari ticks bhi aate hain, jabki bench sirf coast naapta hai.
Agla kadam (phone pe hi ho jaata hai): bench mein ek telemetry-only experiment, jisme extra bodies hata ke tick time naapa jaayega (ship nahi hoga). Isse seedha pata chalega ki shak #1 mein kitna fayda hai. Saath mein hot functions ke in-worker timers. Tum ek baar chalake report paste kar do, to hum jaan jaayenge ki code se aur kitna nikal sakta hai. Bana doon?

me: haan banao

claude: Do cheezein bana raha hoon: worker mein benchExp job (telemetry only, sim results nahi chhoota) aur bench page mein uska button.

edited 2 files worker-sim.js and sereno-bench.html and pending task mein kuch ye likha tha 
#1 [pending] Add benchExp job to worker-sim.js
#2 [pending] Add RUN EXP button to sereno-bench.html

aur fir limit exceeded