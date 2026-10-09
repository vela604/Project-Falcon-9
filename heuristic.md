
HEURISTIC.md

0. Ye kya hai

Ye mera (SEHRAN ka) manual tuning method hai — jo main simulator pe directly karta tha jab constants tune karta tha. Iss document ka maqsad ye hai ki iss method ko algorithm me implement kiya jaa sake. Pure black-box search (CMA-ES) ne fail kiya kyunki search space non-monotone hai (boundary flip karti hai), aur fail modes multiple hain — kis mode se fail hua, isse pata chalta hai kis direction me adjust karna hai. Ye reasoning hai, formula nahi.

1. Core concept — A aur bias joint actor hain

Sabse important part. Galat mental model se baaki kuch samajh me nahi aayega.

A = ascent profile constant. Nominally PUSH_MAX_GIMBAL_DEG × PUSH_T_S² — gravity turn kick. Practical me main PUSH_MAX_GIMBAL_DEG ko directly adjust karta tha, T fixed rakhke.

bias = STAGE_BURN_AOA_BIAS_DEG — stage burn me tilt evolution rate.

Ye do alag tunables nahi hain. Ye jointly decide karte hain:

· MECO pe rocket ka state (altitude, velocity components, tilt)
· Stage burn ke dauraan trajectory ka evolution
· RCS boost ke baad ka final orbit (specifically eccentricity E)

Matlab: E = f(A, bias) — 2D function hai. Isko 1D + 1D me todkar solve nahi kar sakte. "Ratio of A to bias" jaise abstractions bhi galat hain, kyunki boundary non-monotone hai.

Direction conventions (mental model)

· A high → rocket zyada tilt ho jata hai gravity turn me → kam radial velocity vr → zyada horizontal
· A low → rocket zyada vertical rehta hai → zyada vr → kam horizontal
· bias low (0 ke paas) → stage burn me tilt fast evolve hoti hai → aggressive rotation
· bias high (1+ ke paas) → stage burn me tilt slow evolve hoti hai → gentle rotation

Combined:

· Low A + low bias = very aggressive = overshoot
· High A + high bias = very gentle = undershoot

2. Failure modes aur unke signals

Fail mode 1: Aggressive overshoot (low A + fast bias)

Signal: Stage burn ke dauraan, target apogee pahunchne se PEHLE vr negative ho jaati hai. Matlab trajectory apogee cross kar chuki hai, but 320 km tak nahi pahunchi. Ye hard fail hai.

Reason: Bahut zyada radial velocity early on, ya stage burn tilt bahut fast badal raha hai. Trajectory short hai.

Direction (aggressive se gentle): A thora badhao ya bias thora badhao.

Fail mode 2: Gentle undershoot (high A + slow bias)

Signal 2a: Apogee target 320 km tak nahi pahunchti stage burn ke andar. Time nikal jata hai, still burning.

Signal 2b: Apogee pahunch gayi but eccentricity bahut high hai (E > E_max) — coast me elliptical orbit, circular nahi.

Reason: Profile bahut gentle hai. Ya toh time waste ho raha hai (2a) ya apogee pe velocity orbital velocity se bahut door hai (2b).

Direction (gentle se aggressive): A thora ghatao ya bias thora ghatao.

Fail mode 3: Hard lower (below even aggressive)

Signal: Very low A + very fast bias — profile itna aggressive hai ki koi bhi bias adjust kaam nahi karega. It's a corner of the search space jahan se nikalna hi padega.

Direction: A ko thora relax karo (badhao), bias reset karo, phir se convergence try karo.

3. The bearable eccentricity band

Ek range hai (E_min, E_max). Bahar dono taraf mission useful nahi hai.

· E > E_max → fail (coast rotate 2 recover nahi kar sakta, ya circ burn overshoot, ya payload orbit me error bahut zyada)
· E < E_min → technically possible but time waste. Rocket gentle profile pe chal raha hai, utni hi E ke liye zyada time de raha hai.

Target: E_max ke aas paas, but strictly below. Bilkul E_max pe nahi (knife edge, numerical noise se fail ka risk). Thoda below — but as close as possible.

Kyun E_max edge: E_max pe pahunchne ka matlab profile maximally aggressive hai jo safe hai. Isse time minimum, orbit accuracy just within tolerance, fuel efficiency maximum.

E_min/E_max exact values: Experience se pata hain. Rough order of magnitude design ke liye chahiye. Baseline ecc = 8.3e-6 (circular, deploy pe). Manual sweeps me upper end pe kaunsi E pe fail hua, us se E_max ka order pata chalta hai.

4. Joint (A, bias) search — full flow

Priority

A ko minimum pe le jao (drag aur time ke liye). Phir bias se fine tune karo.

Kyun A minimum:

· Low A = steeper climb = less time in atmosphere = less drag exposure = better fuel efficiency
· High A sirf high-altitude target orbits ke liye (jahan long burn time ki zaroorat ho)

Yahi mera primary preference hai — A reduce karna.

Order of operations

Step A — Hard lower check first

Stage burn me koi bhi point pe vr negative ho rahi hai (before apogee)? Agar haan:

· Profile too aggressive hai
· A thora badhao ya bias thora badhao (gentle direction)
· Ye check har iteration me karo — baseline pe, A reduce karne ke baad, bias adjust karne ke baad

Step B — Push A down

A ko ghatate jao, 0.01 deg (gimbal push quanta) ke steps me.

Har step pe ek full eval. Target: ecc ≤ E_max reh sake.

A ka lower limit kab pata chalta hai:

· Ecc E_max cross kar jaye → A 1 step wapas badhao
· Ya vr stage burn me negative jaane lage → same, A 1 step wapas badhao
· Ya A ki value itni low ho jaye ki koi bhi bias E_max tak nahi pahuncha sakta → A relax karo

Step C — Bias se fine tune karo

Jab A ki limit pata chal gayi, bias ko adjust karo — E_max boundary pe lane ke liye.

Direction depends on current side:

· Ecc E_max se upar hai → bias badhao (slower stage burn, less aggressive)
· Ecc E_min se neeche hai → bias ghatao (faster stage burn, more aggressive)

Step D — Bias extreme hit ho gaya?

· Agar bias -2 pe (aggressive extreme) aur abhi bhi E_max tak nahi pahuncha → A ko thora BADHAO, bias reset karo
· Agar bias 2.5 pe (gentle extreme) aur E_min se bhi neeche chala gaya → A ko thora GHATAO, bias reset karo

Ye "inappropriate ratio" ka corner hai — A ko relax karke bias se achievable banao.

Step sizes

A (via gimbal push): 0.01 deg quanta. Ye hardware ka least count hai.

Bias: Hybrid bisection — step size progressively smaller:

· ±0.5 (coarse sweep)
· ±0.1 (medium)
· ±0.05 (fine)
· ±0.01 (very fine)

Har step pe stop karo jab improvement ≤ current quantum.

Special case: Agar A ko bhi adjust karna pad raha hai (bias extreme pe), to A ka step bhi same ladder use karega (coarse 0.5, then 0.1, then 0.05, then 0.01). But A ka base quantum 0.01 deg hi hai.

5. Circ lead search — after (A, bias) are locked

Circ lead tab tune karo jab A aur bias already E_max boundary pe hain.

Phase 1: Minimize without negative vr

Lead ko ghatate jao. Har step pe:

· Full eval
· Next apogee ka time at circ burn end check karo
· vr during circ burn check karo

Target: circ burn ke end pe margin minimum ho, aur vr kabhi negative na jaaye.

Ye phase tab ruk jata hai jab 0.01 step pe bhi margin kam nahi hota — practically margin ~6-7s pe stuck ho jata hai.

Step sizes: Hybrid bisection same ladder — ±1 → ±0.5 → ±0.1 → ±0.05 → ±0.01.

Phase 2: Allow negative vr, keep reducing

Ab decide karte ho ki "vr negative jaana hi padega" — kyunki 4-5s margin ka target bina negative jaane realistic nahi hai.

Circ lead ko aur ghatao. Har step pe:

· Full eval
· vr minimum during circ burn record karo
· vrEnd (burn end pe vr) record karo
· Next apogee ka time at burn end check karo

Stop condition: Margin 4-5 sec pe pahunch jaye.

vrEnd constraint: Always positive, but close to 0. Bilkul zero nahi (knife edge). ~0.02-0.05 m/s ka buffer.

vrMin during burn: Negative allowed, but recovery expected. Historical data se: manual best me vrMin = -0.38, vrEnd = +0.046 — physically legitimate.

Why two phases

Agar Phase 1 me hi 4s target hit ho jaye, wo lucky case hai (~5% chance). Usually Phase 1 ~6-7s pe rukta hai. Uske baad Phase 2 me explicitly negative jaane dete hain.

Kyun negative allowed: 4s ka target physically ~6-7s achievable band ke neeche hai. Sirf transient negative vr ke through hi realistic hai.

6. MECO outer loop

MECO isolated tune nahi ho sakta. Kyun? Kyunki MECO badalne se:

· Booster ka burn duration badalta hai
· Separation pe stage ka velocity different hota hai
· Stage ki poori trajectory rebuild karni padti hai
· Matlab A, bias, circ lead — sab ko re-tune karna padta hai

Isliye MECO outer loop hai — iteration ke through converge hota hai.

Flow

1. Initial: MECO = baseline (52612)
2. Inner tuning: (A, bias) + circ lead converge karo (jaise upar)
3. Full mission: post-deploy stage fuel residual measure karo
4. Residual target check:
   · In range → exit outer loop
   · Not in range → MECO adjust karo, wapas step 2
5. Loop 2-3 baar chal sakta hai until residual target hit

Adjustment direction

Residual too high (stage me bahut fuel bacha) → MECO badhao.

· Booster jaldi cut karega → separation pe stage heavier → stage ko zyada burn karna padega → residual kam

Residual too low / negative / mission fail → MECO ghatao.

· Booster zyada burn karega → separation pe stage lighter → stage kam burn karega → residual badhega

Targets:

· Deorbit off → residual 0-50 kg
· Deorbit on → residual ~400 kg (suicide burn fuel ke liye)

Warm start between MECO iterations

Jab MECO badla, pichhle iteration ke A, bias, circ lead initial guess ki tarah use karo. Bilkul fresh search nahi — sirf local fine tune.

Typically pichhle iteration ke values ke around ±0.5 range me hi solution milega. Full sweep nahi chahiye.

MECO step size

Start with coarse: 5000-3000 kg steps.
Phir fine: 1000 kg, then 200 kg.

Stop jab residual target range ke andar ho — further MECO shift karne ki zaroorat nahi.

7. Complete end-to-end sequence

```
Initial state: MECO = 52612, A = 13.94 (baseline), bias = 0.59, lead = 5.525

Outer loop (MECO convergence):
  │
  ├── Inner: (A, bias) joint search
  │     │
  │     ├── Hard lower check (stage burn vr negative?)
  │     │     Haan → gentle direction adjust
  │     │
  │     ├── Reduce A (0.01 gimbal quanta) until E ~ E_max
  │     │     Back off one step if overshoot
  │     │
  │     ├── Bias hybrid bisection (±0.5, ±0.1, ±0.05, ±0.01)
  │     │     Until E within (E_min, E_max)
  │     │
  │     └── Bias extreme hit? → Adjust A, reset bias, retry
  │
  ├── Lock (A, bias)
  │
  ├── Circ lead search
  │     │
  │     ├── Phase 1: minimize without negative vr → stuck at ~6-7s
  │     │
  │     └── Phase 2: allow negative, reduce → stop at 4-5s margin
  │
  ├── Full mission run
  │     │
  │     └── Measure: post-deploy stage fuel residual
  │
  ├── Residual in target? 
  │     Haan → exit outer loop
  │     Nahi → MECO adjust
  │           (up if residual high, down if fail)
  │           Next iteration with current values as warm start
  │
  └── (Repeat outer until residual target met)

Fine tuning phase (final):
  - MECO locked
  - Local refinement of A, bias, lead
  - Score all combos, select best
  - Fresh process validation run
```

8. Signals to read from sim per eval

Algorithm ko har eval ke baad ye chahiye (hook metrics se available):

· Eccentricity at COAST_ROTATE end — primary signal for (A, bias) search
· vr minimum during stage burn — hard lower check
· vr minimum during circ burn — Phase 1 pass/fail
· vrEnd (burn end pe vr) — Phase 2 target
· Time to next apogee at circ burn end — margin measurement
· Post-deploy stage fuel residual — MECO adjustment signal
· Apogee / perigee at deploy — orbit constraint check
· Deploy time — secondary objective (minimize)
· Booster fuel left at separation — fuel efficiency metric
· Max Q, max G, crash status — hard constraints

9. What makes this work (implementation requirements)

· Determinism: Sim bit-identical hai — ye bisection aur hybrid adjustment ke liye essential hai. Bina determinism ke, phase 1 vs phase 2 ka comparison reliable nahi hoga.
· Partial evals: (A, bias) search me sirf COAST_ROTATE end tak chalana kaafi hai. Circ lead search me similarly sirf circ burn end tak. Isse compute bahut bachega.
· Checkpoint (optional): Circ lead scan me — COAST_ROTATE end pe state checkpoint lo, phir har lead value ke liye sirf last ~110s chalao. Eval count dekhke decide karna hai worth hai ya nahi.
· Signals from hook metrics: Sab upar wale signals hook-sandbox se aane chahiye. Nahi aate to hook me add karne padenge.

10. What NOT to do

· A aur bias ko independent treat nahi karna — ye joint actor hain
· E = 0 target nahi karna — search kabhi reach nahi karegi, aur need bhi nahi. Target E_max edge.
· Time ko alone optimize nahi karna — profile bahut aggressive ho jaata hai, orbit accuracy degrade hoti hai
· A ko extreme low pe push nahi karna — failure mode subtle hai (ecc upar jaata hai without apogee miss)
· MECO ko isolated tune nahi karna — poora downstream shift ho jaata hai
· vrEnd ko bilkul 0 nahi rakhna — knife edge hai, numerical noise pe fail

11. Free parameters (algorithm ko decide karne hain)

Ye cheezein empirically discover karni hain — heuristic ke through, values hard-coded nahi hain:

· Exact E_min, E_max values (order of magnitude ke saath start)
· A ka lower limit (kahan tk reduce karke ecc still achievable hai)
· Bias ka effective band (2.5 ka extreme sirf fallback hai, practical range narrower)
· Stop criteria tolerances (kitne percent improvement ke baad "converged" maane)
· MECO iteration ka convergence threshold
· Between MECO iterations, warm start ka radius (kitne wide range me search karna hai)

---

