
---

CMA-ES Hybrid Tuning — Concept and Reasoning

Ek autonomous tuning pipeline jo leoInsertionV3 guidance constants ko optimize karti hai taaki Falcon 9 Block 5 stack 320 km circular LEO mission reliably fly kar sake. Documentation ka maqsad ye batana hai ki hum kya kar rahe hain, kyun aise kar rahe hain, aur kaunsi physics thinking is approach ke peeche hai — implementation details AI assistant ke faisle pe chhod diye gaye hain.

---

Core thinking — kyun hybrid, pure black-box kyun nahi

CMA-ES ek black-box optimizer hai. Tum use ek search space do, ek score function do, aur wo generations me converge kar leta hai. Agar hum seedha leoInsertionV3 ke saare tunables ko 6-dimensional space me daal dein, algorithm theoretically converge kar jayega — par mehnat bahut zyada lagegi. Kyunki tunables me kuch aise hain jo ek doosre se sate hue hain physics ke through, aur ek ko badalne se doosre ki "achhi range" shift ho jati hai.

Teen concrete couplings hain jo pure black-box me waste karte hain.

Pehla: PUSH_MAX_GIMBAL_DEG aur PUSH_T_S independent nahi hain. Ye dono milkar ek hi physical quantity banate hain — ascent gravity-turn kick ka total angle. Controller ek half-sine torque pulse deta hai jiski amplitude ek hai aur duration doosra, aur resultant rotation inn dono ka product hai (T² ke saath). Search space me sirf ek direction matter karti hai; dusri orthogonal direction waste hai. Black-box us waste direction ko explore karta rehta hai.

Doosra: CIRC_TRIGGER_LEAD_S ek 1-D problem hai jab ascent aur stage-burn profile fix ho. Har profile ke liye exactly ek lead time hota hai jo clean orbit deta hai — na zyada, na kam. Iske liye full CMA-ES chalana overkill hai, jabki ek simple monotone search kaafi hai.

Teesra: MECO target fuel jo hai, wo poore downstream system ko shift karta hai. Kyunki stage ka mass budget booster se aata hai, MECO ko badalne se stage burn ka optimum, circ burn ka optimum, sab shift ho jate hain. Early tune karna waste hai.

Hybrid ka matlab ye nahi ki hum CMA-ES ko replace kar rahe hain. Wo poori tarah se use hoga. Bas hum domain knowledge se search space ko structure kar rahe hain — ek time pe ek subspace, physically sensible order me — taaki jab finally multi-dimensional refinement ho, wo ek already-narrowed region me ho, cold start se nahi.

Result: same algorithm, kam evaluations, better convergence.

---

Structural changes jo pehle karni hain

Do constants ko guidance codebase se hatana hai, kyunki wo hybrid structure ke saath conflict karte hain.

Pehla, STAGE_BURN_LOCK_TILT_DEG. Insertion block me stage-burn controller ke do modes the — ek AoA-tracking PD jo early phase me chalta tha, aur ek fixed-tilt PD jo lock hone ke baad chalta tha. Fixed-tilt wala mode ab redundant hai kyunki STAGE_BURN_AOA_BIAS_DEG directly tilt-evolution rate control karta hai pure burn ke dauraan — smoothly, continuously, bina kisi mode switch ke. Dono rakhne se do control laws ek hi attitude pe ladte hain, aur mode transition ek edge case source hai. Isliye isko completely hata dena hai — guidance-blocks se, preset defaults se, important fields list se, aur description file se.

Doosra, MECO_APOGEE_KM. Ascent block pehle do MECO triggers support karta tha — ek apogee-based (jab predicted apogee target height cross kare), ek fuel-based (jab booster ka residual fuel target mass pe pahunche). Ye dono triggers aapas me fight karte hain. Hum fuel trigger use karenge, kyunki MECO_TARGET_BOOSTER_FUEL_KG hi wo quantity hai jise hum control karna chahte hain — target orbit altitude ko tune karna asal me booster fuel ko uncontrolled chhod deta hai, jo mission objective nahi tha. Isliye apogee-trigger branch ko hata dena hai aur fuel trigger ko default banan dena hai.

---

Tunables — final list

Paanch quantities tunable hain tuning ke liye. Inme se pehli ek derived hai, baaki chaar direct scalars hain.

Pehli, ascent_profile_constant. Ye ek derived scalar hai jo PUSH_MAX_GIMBAL_DEG aur PUSH_T_S dono ko represent karta hai. CMA-ES is ek scalar ko tune karega, aur orchestrator runtime pe do actual constants me convert karega. Iski physics aur collapse logic neeche alag se.

Doosri, STAGE_BURN_AOA_BIAS_DEG. Direct constant jo stage burn ke dauraan nose ke target AoA ko velocity vector se kitna offset rakhna hai ye batata hai. Iski hardware accuracy 0.0001 degree hai.

Teesri, STAGE_BURN_AOA_MARGIN_DEG. Direct constant jo fine control ke liye hai — kab bootstrap PD se standard PD pe handoff ho. Iski bhi hardware accuracy 0.0001 degree hai.

Chauthi, CIRC_TRIGGER_LEAD_S. Direct constant jo batata hai circularize burn apogee se kitne seconds pehle shuru ho. Hardware accuracy 0.01 second (ek tick).

Paanchvi, MECO_TARGET_BOOSTER_FUEL_KG. Direct constant jo MECO trigger karta hai jab booster ka residual tank fuel iss value pe pahunche. Hardware accuracy 1 kilogram.

Rounding ka concept important hai. Real hardware me gimbal encoder 0.01 degree ka resolution rakhta hai, command tick quantization 0.01 second, tank gauging 1 kilogram. Toh tuning ke dauraan jab bhi value submit karni ho, usko usi hardware least-count pe round karna chahiye — warna algorithm aisi values pe converge karega jo hardware physically command nahi kar sakta, aur sim me ek illusion create hoga.

---

Ascent profile collapse — do se ek

Ye ek important optimization hai jo pehli do tunables ko ek me collapse karti hai.

Physics intuition

PUSH phase me controller ek half-sine torque pulse deta hai — peak gimbal angle G, duration T seconds. Is pulse se total angular impulse generate hota hai jo integrate karke ek net rotation deta hai. Formula ye hai ki rotation proportional hai G times T² (2π se divide karke). Matlab ascent ke dauraan vehicle ka tilt profile seedha is ek rotation quantity ka function hai. Gravity turn iske through evolve hota hai.

Yani do constants (G aur T) asal me ek hi quantity describe kar rahe hain — total ascent kick. Isko hum ascent_profile_constant naam dete hain.

Collapse procedure

Jab CMA-ES ek scalar A propose karta hai, orchestrator do constants me convert karta hai. Conversion aise hoti hai ki pehle ek anchor time T0 (jo current PUSH_T_S hai) se ek raw gimbal G_raw nikalta hai. Use hardware pe round karta hai 0.01 degree pe. Us rounded G se ek naya time T_raw nikalta hai. Use 0.01 second pe round karta hai. Aur us final (G, T) pair se ek effective profile value A_eff compute karta hai.

Is A_eff value ko orchestrator CMA-ES ko wapas batata hai agle generation ke liye, na ki original A ko. Kyun — kyunki rounding ke baad simulator ne actually jo fly kiya wo A nahi tha, A_eff tha. Agar algorithm ko wahi A wapas diya jaye, wo same-lagti values ko repeatedly propose karta rahega jo rounding pe same point pe land karti hain. A_eff feedback se algorithm ko exact lattice ka pata chal jata hai aur wo effectively usi pe search karta hai.

Kyun ye useful hai

Is collapse se 2-D search space 1-D ban jata hai. CMA-ES ko ek scalar tune karna hai, do independent constants nahi. Search fast converge karta hai aur oscillations avoid hote hain.

---

Phase sequence — conceptual walkthrough

Phase 0 — Setup and anchors

Sabse pehle hum saare tunables ko unki current default values pe set karte hain (jo guidance code me already hain). Ye ek starting reference point hai — baseline. Har agle phase me hum ek-ek constant ko improve karte jayenge, baaki ko fix rakh ke.

MECO_TARGET_BOOSTER_FUEL_KG ka current default 52,612 kg hai. Isi se start karenge.

Phase 1, 2, 3 — Combined objective: reach target orbit altitude

Ye teen phases ek saath ek hi cheez achieve karne ke liye kaam karte hain — stage ko us point pe pahunchana jahan uska apogee target orbit height (320 km) tak pahunche, aur wo bhi aisi geometry ke saath jisme circularization ke liye reasonable margin ho.

Kyun teen separate phases, ek saath kyun nahi — kyunki inn teenon ka physics role alag hai aur ek ko fix rakhke doosre ko tune karna zyada clean hai.

Phase 1 me ascent profile constant tune karte hain. Ascent profile determine karta hai ki rocket gravity turn me kaise enter karega, aur kis tilt pe upper stage separation ke baad stage-burn shuru karega. Yeh tilt hi stage ka starting point hai.

Phase 2 me STAGE_BURN_AOA_BIAS_DEG tune karte hain. Ye decide karta hai ki wo initial tilt se aage stage kitni tezi se angle change karega burn ke dauraan. Badi value → slow change → gentle profile. Chhoti value → fast change → aggressive profile. Do failure modes yahan hain — agar bohot chhoti value rakhi (aggressive), stage apogee target tak pahunch hi nahi payega; agar bohot badi value rakhi (gentle), apogee reach ho jayega par eccentricity bohot zyada hogi, jisse circularization me problem aayegi. Phase 2 ka kaam iss optimal middle ko dhoondhna hai.

Phase 3 me STAGE_BURN_AOA_MARGIN_DEG tune karte hain. Ye fine adjustment hai — kab bootstrap damper se standard controller pe handoff ho. Chhoti changes me farak padta hai, isliye tight range me narrow tune.

Teenon phases ke end me humare paas ek ascent aur stage-burn profile hoti hai jo target orbit height pe apogee pahunchati hai with reasonable eccentricity.

Phase 4 — Circularize trigger lead (linear refinement)

Ab humare paas ek stage trajectory hai jo apogee pe pahunch rahi hai. CIRC_TRIGGER_LEAD_S decide karta hai ki circularize burn apogee se kitne seconds pehle start ho.

Yahan jo monotone behavior hai wo ye: zyada lead → burn apogee se zyada pehle shuru aur khatam → burn end pe apogee abhi bhi kaafi door. Kam lead → burn apogee ke kareeb shuru aur khatam → burn end apogee ke bahut nazdeek. Bohot kam lead → burn apogee cross kar jayega → radial velocity negative ho jayegi → fail.

Is monotone property ki wajah se ye linear problem hai — CMA-ES ki zaroorat nahi, simple search bhi kaam karti hai.

Target condition ye hai ki circularize burn jab fully spool out ho, us moment pe next apogee se pehle 4 seconds bachein. Zero seconds ideal hota theoretically, lekin wo failure ke bilkul edge pe hai — ek chhoti si simulation drift radial velocity ko negative kar degi. 4 second ka buffer rakhte hain, aur us buffer ke dauraan coast-rotate-2 aur coast-hold-2 phases chal jate hain jo already mission script ka hissa hain. Un phases me payload eject next apogee pe trigger hota hai. Isko safety margin ke roop me use kar rahe hain.

Ek aur hard condition hai yahan — circularize burn ke poore dauraan radial velocity kabhi bhi negative nahi honi chahiye. Zero acceptable hai, positive acceptable hai, negative nahi.

Phase 5 — MECO fuel target

Ab hum booster ke fuel budget ko tune karte hain.

MECO_TARGET_BOOSTER_FUEL_KG ye batata hai ki MECO ke time booster tank me kitna fuel bacha rehna chahiye. Agar ye value badi rakhein, booster jaldi cut karega (zyada fuel bacha ke), jisse upper stage ko zyada mass carry karna padega aur stage ka fuel kaam pe lagega. Agar chhoti value rakhein, booster zyada burn karega, upper stage ko kam mass carry karni padegi, stage ka fuel bachega.

Yani direction monotone hai: MECO fuel target badhao → stage residual kam hoga. Aur ulta.

Target: stage ka post-payload-eject residual fuel ek desired number ke aas paas hona chahiye. Agar suicide OFF hai to target 0-50 kg (bohot kam residual, spent stage ballistic). Agar suicide ON hai to ~400 kg (kyunki suicide burn ke liye fuel chahiye hoga). Ye numbers rough hain, experience se derived — exact calculation nahi, safety margin ki tarah hain.

Phase 5 iss direction ko scan karta hai, aur jab target pe pahunch jaye to uske aas paas refine karta hai. Ek point aayega jahan MECO fuel target itna bada ho jayega ki stage residual itna kam ho jayega ki mission fail hone lagega — us point se pehle back off karna hai.

Phase 6 — Multi-dimensional refinement

Phases 1-5 ne humein ek convergent region tak pahuncha diya. Ab hum us region ke andar poore chaar tunables ko ek saath refine karte hain — ascent profile, AoA bias, AoA margin, circ trigger lead. MECO fuel target ko constant rakh dete hain us Phase 5 ke result pe.

Iske liye CMA-ES ko 4-D space pe chalate hain. Par ye cold start se nahi hai — Phase 5 ka anchor already bahut acha hai, toh algorithm chhote volume me high-quality region explore karega. Kyunki ye anchors bohot tight hain, iterations jaldi converge karenge.

Convergence detect karna simple hai — jab score improvement plateau pe pahunche, stop. Exact threshold AI assistant decide karega.

---

Score function — kya optimize kar rahe hain

Har candidate ka evaluation ek single number return karta hai. Ye number essentially is tarah constructed hai.

Sabse pehle hard constraints check hote hain — agar max G threshold cross, max Q threshold cross, vehicle crashed, ya radial velocity circ burn me negative ho gaya — to score ek bahut bada penalty ban jata hai. Ye conditions aise hain jahan mission outright fail hai, koi soft scoring ka matlab nahi.

Agar hard constraints pass ho gaye, soft score compute hota hai. Isme priority order ye hai.

Sabse upar orbit accuracy — final orbit apogee aur perigee target 320 km se kitna match karte hain, plus eccentricity kitni low hai. Ye highest weight wala term hai.

Uske neeche booster fuel left — kitna fuel booster me bacha reh gaya mission ke end pe. Ye favourable hai, matlab zyada = better.

Sabse neeche time to deploy payload — kitne sim-seconds me payload release hua. Ye lowest weight hai, acceptable outcome hai koi bhi reasonable time.

Priority order ka matlab ye hai ki agar orbit error aur booster fuel left me trade-off ho, orbit error jeetegi. Aur agar booster fuel left aur time me trade-off ho, fuel jeetega. Score function iss hierarchy ko encode karti hai.

Exact weights aur tolerances AI assistant decide karega.

---

Kyun ye approach reliable hai

Poora hybrid structure iss baat pe based hai ki physics couplings pehle se samajh liye gaye hain. Har phase me hum ek specific quantity ko tune kar rahe hain jiska effect samajh me hai, aur baaki sabko fix rakh rahe hain. Isse search space har phase me chhota hai, aur CMA-ES ke liye optimize karna easy hai.

Jab final refinement (Phase 6) hoti hai, hum cold start nahi kar rahe — hum ek convergent region me start kar rahe hain jo phases 1-5 ne already locate kar liya hai. Isse 4-D search bohot small volume me ho jata hai, aur iterations jaldi converge karti hain. Yehi asli optimization hai — algorithm me nahi, search structure me.

---

Constants jo already discussed hain

Ye woh numbers hain jo discussion ke dauraan explicitly decide ho chuke hain — baaki tunables aur hyperparameters AI assistant ke faisle pe hain.

Circularize burn ke end pe next apogee se pehle chhodne wala safety buffer: 4 seconds.

Radial velocity circularize burn ke dauraan: kabhi bhi negative nahi.

Post-eject stage residual fuel target: suicide OFF ke case me 0-50 kg, suicide ON ke case me ~400 kg.

MECO fuel target ki least count: 1 kg.

Ascent profile me gimbal rounding: 0.01 degree.

Ascent profile me time rounding: 0.01 second.

Angle constants ki hardware accuracy: 0.0001 degree (bias aur margin dono).

---

Kya karna hai — big picture

Ek orchestrator likhna hai jo upar wale chaar phases ke sequence ko chalaye. Har phase ka apna objective, apna search space, apna stopping condition hai. Phases ke beech me orchestrator state carry karta hai — ek phase ka result agle phase ka input ban jata hai.

runSim() function ka interface simple hai — options leta hai, result deta hai, deterministic hai. Orchestrator iske upar build hota hai, ise touch nahi karta.

Files jo AI assistant ko chahiye: runner.js, run.js, aur ek config spec jo tunables ki list rakhta hai. Plus ye conceptual document. Sim ke 14 source files ki zaroorat nahi — runSim ka contract kaafi hai.

---

Config spec ek chhoti JSON file hai jo tuner ko batati hai ki kya tune karna hai, aur uske baare me kya context chahiye. Ye tuning system ki "settings file" hai — bilkul waise hi jaise b5-leo.json thi V2 ke liye, ab V3 ke liye equivalent chahiye.

Isme teen tarah ki information hoti hai.

Pehla, mission context. Kaunsi stack fly karni hai, kaunsi guide chalani hai, kitne sim-seconds. Saath me environment ka state — atmosphere chahiye ya nahi, slosh chahiye ya nahi, wind off hai ya on, IMU off hai ya on. Ye sab isliye config me hote hain ki tuning ke dauraan environment consistent rahe. Agar tum kabhi wind on rakho aur kabhi off, same constants ka result change hoga, aur tuner confuse ho jayega. Environment ek fixed backdrop hona chahiye jiske against constants tune hon.

Doosra, tunables ki list. Yahi asli content hai. Har tunable ke liye usko batana hota hai: uska full path kya hai (jo guidance ke config bag me existing key name hai, jaise ascent.PUSH_MAX_GIMBAL_DEG ya insertion.CIRC_TRIGGER_LEAD_S), uski lower bound aur upper bound kya hain (search space ki limits), aur ek initial value (jahan se search shuru ho). Ye tuner ko batata hai "iss constant ke andar iss range me idhar se start karke dekho."

Teesra, scoring criteria. Isme likha hota hai ki tune ka objective kya hai — kaunse metrics, unka target kya hai, unka tolerance kitna, aur relative weight kitna. Plus hard constraints jo outright fail declare karte hain (jaise max G ya max Q cross ho jaye). Ye config me isliye rakhte hain ki tum tune ke dauraan scoring objective change karke dekh sakte ho — code touch nahi karna padta, sirf config edit karo aur rerun.

Ek chhoti si chauthi cheez bhi hoti hai — CMA-ES ke apne hyperparameters (population size, initial sigma, max generations, tolerances). Ye technically tuner ki settings hain, tuning ka data nahi. Config me aksar ye bhi hote hain taaki tune ke settings ek jagah rahein.

Abhi ke case me, config spec V3 ke liye banana hai — V2 wale b5-leo.json se structure copy hoga, sirf paths V3 ke hisaab se honge (lowercase group names, nested keys jaise insertion.TARGET_ORBIT_ALT_KM root pe nahi). Aur usme sirf wahi paanch tunables honge jo humne decide kiye. Baaki constants config me mention honge hi nahi — wo guidance code ke defaults pe reh jayenge. Yani config spec "iss chhoti list ko vary karo, baaki sab jaisa hai waisa chodo" kehne ka tareeka hai.


---

Auto Constant Tuner — Kyun bana rahe hain

Ye section batata hai ki hum ye tuner kyun bana rahe hain, kaunsi problem solve kar rahe hain, aur iska long-term vision kya hai. Ye conceptual context hai — implementation ke details nahi.

---

Problem jo solve kar rahe hain

leoInsertionV3 guidance me ek bunch of tunable constants hain — ascent profile, stage burn behaviour, circularize timing, MECO trigger thresholds. Ye constants hand-tuned hain, ek specific mission ke liye — Falcon 9 Block 5 stack, 320 km LEO orbit. Tuning me kaafi trials lage, physics samajhna pada, aur ek balanced configuration nikal aayi jo reliably fly karti hai.

Ye kaam karta hai, par scale nahi karta. Kai jagah friction aati hai.

Agar user koi different stack banaye — different mass, different engine, different stage proportions — current constants uss naye stack ke liye optimal nahi honge. Kuch cases me kaam kar jayenge, kuch cases me fail. Aur us naye stack ke liye phir se hand-tuning karni padegi — dobara wo poori process, hours of trial and error, ek-ek constant ko manually badal ke dekhna, kya farak pad raha hai wo samajhna.

Same problem different target orbit altitudes ke saath — 200 km, 400 km, 500 km. Har altitude ke liye profile differently evolve karti hai, aur constants retune karne padenge.

Aur ek badi problem: agar hamare paas ek smart tuner hota, to hum user ke liye "kis stack pe kya fly kar sakte ho" jaisa feature bhi de sakte hain. Ya adaptive missions jahan stack badle to guidance khud adjust ho jaye. Ye vision manual tuning se possible nahi hai.

Kya bana rahe hain

Ek autonomous constant tuner. Iska kaam ye hai ki user ek mission spec de — stack kaunsi hai, target orbit kya hai, environment kya hai — aur tuner khud ek optimal constant set dhoondh nikaale jo uss mission ko reliably fly kar sake.

Isme koi human-in-the-loop nahi hai. Tuner autonomously trials chalaega, results ko score karega, aur converge karega ek aisi configuration pe jo objectives ko best meet karti hai. User ko kuch nahi karna — bas mission spec dena hai.

Ye ek offline tool hai. Ye real-time nahi chalta. User (ya developer) isko background me chalata hai jab ek naya stack ya mission profile banate hain, aur thodi der baad ek ready-to-use constant set milta hai. Wo constants phir guidance preset me daal diye jaate hain aur sim normally unse fly karti hai.

Toh tuner guidance ke saath runtime pe nahi juda. Wo guidance ke upar baitha hua ek "training rig" hai — training ke waqt kaam karta hai, aur training ke baad guidance wahi constants use karti hai jaise hum manually tuned values use karte aaye hain.

Kyun CMA-ES

Optimization ke liye bahut approaches hain — gradient descent, genetic algorithms, particle swarm, simulated annealing, ya brute-force grid search. Is problem ke liye CMA-ES specific kyun chuna.

Pehli baat — sim ek black box hai. Hum derivations nahi nikal sakte ki "agar PUSH_T_S ko 0.01 badha do to apogee 0.5 km upar jayegi." Physics itni nonlinear hai, aur guidance code itne interlocking decisions leti hai, ki analytical gradient possible nahi. Toh gradient-based methods out.

Doosri baat — sim deterministic hai. Same inputs, same outputs, bit-for-bit. Iska matlab hai humein stochastic optimization ki zaroorat nahi (jo noise average karne ke liye multiple runs karti hai). Ek run kaafi hai har candidate ko evaluate karne ke liye. Isse compute half ya third ho jata hai.

Teesri baat — sim expensive hai. Ek run me ~15-20 seconds lagte hain single core pe. Bohot zyada candidates evaluate nahi kar sakte. Isliye methods jo sample-inefficient hain (jaise genetic algorithms jinke large populations chahiye) unsuitable hain. CMA-ES sample-efficient hai — chhote populations ke saath kaam karta hai.

Chauthi baat — search space continuous hai, chhote dimension ka. Constants continuous real numbers hain, aur total around 5-6 dimensions. Ye CMA-ES ka sweet spot hai. High-dimensional space pe (hundreds of dimensions) ye struggle karta, par yahan perfect fit hai.

Paanchvi baat — CMA-ES self-adapting hai. Wo search ke dauraan covariance structure seekh leta hai — ye samajh jata hai ki kaunse dimensions correlated hain aur kaunse independent. Isse directions prefer karta hai jahan actually improvement hoti hai, aur waste directions ignore karta hai. Agar humein kuch coupling ke baare me pata nahi ho, CMA-ES khud pakad lega.

Ye combination — black-box, deterministic, expensive, low-dim continuous — CMA-ES ke liye textbook case hai.

Kyun hybrid

Pure CMA-ES poori 6-dim space pe chalaya ja sakta hai, aur kaam karega. Par mehnat zyada lagegi.

Kyun: kuch constants me physics couplings hain jo analytically known hain. Jinhe hum domain knowledge se collapse kar sakte hain, unhe waste karna galat hai. PUSH_MAX_GIMBAL_DEG aur PUSH_T_S ek physical quantity banate hain — total ascent kick angle — toh CMA-ES ko 2-D space me explore karne dena waste hai jab 1-D actually matter karti hai. Same tarah CIRC_TRIGGER_LEAD_S ek linear problem hai jab profile fix ho, toh uske liye full CMA-ES chalana overkill hai.

Hybrid approach me hum ye couplings pehle collapse karte hain, aur phir CMA-ES chhote effective spaces pe chalate hain. Ye CMA-ES ko replace nahi karta — wo final multi-dimensional refinement me poora use hota hai. Bas usko smart starting conditions de rahe hain, aur physically sensible phases me todo.

Iska matlab hai ki same results milte hain, kam evaluations me. Practically, hours bach jate hain.

Long-term vision

Ye tuner ek building block hai, apne aap me ek product nahi.

Aage iska use karke hum kar sakte hain:

Per-stack auto-tuning. Jab user fleet editor me ek nayi stack banaye, tuner background me chal jaye aur uske liye ek recommended preset tayyar kar de. User ko manually kuch tune nahi karna padega — sim khol ke fly karo, guidance preset already optimised hai.

Per-mission tuning. User jab mission spec choose kare — "is stack se 350 km orbit pe le jao" — tuner uss specific target ke liye optimized constants ready kar de. Har mission ka apna best profile mil sakta hai.

Regression testing. Jab bhi guidance code me koi change ho, tuner automatically verify kar sake ki purane missions abhi bhi reliably fly hote hain ya nahi. Agar kuch break hui, tuner usko catch karega.

Research aur experimentation. Agar hum koi naya controller idea explore karna chahein, uska effectiveness tuner se measure kar sakte hain — uski best achievable score vs existing guide ki best achievable score, apples-to-apples comparison.

Auto-tuning across vehicle families. Ek hi tuner different mass classes pe kaam karega — chhoti sounding rocket, medium satellite launcher, bade heavy-lift vehicles. Har ek ke liye separately hand-tune karna nahi padega.

Ye sab possible hai agar tuner mission-spec-driven hai, yani wo guidance constants ko mission requirements se linked rakhe, na ki hardcoded values ko.

Kyun ye worth hai

Sabse obvious reason — manual tuning hours leti hai. Ek stack ka faayda hai, par jab 10 stacks ya 20 mission profiles handle karne hain, tab ye unsustainable ho jaata hai. Automated tuner se process minutes me ho jata hai.

Doosra reason — manual tuning me bias hoti hai. Human tuner intuitively un constants pe focus karta hai jo wo samajhta hai, aur jo samajh se bahar hain unhe "default pe theek hai" maan leta hai. Automatic tuner poori search space explore karta hai, aur kabhi kabhi aise configurations nikaalta hai jo human soch ke bhi nahi mile.

Teesra reason — consistency. Manual tuning ka result reproducible nahi hota — ek developer kuch tune kare, doosra kuch, dono alag configurations pe pahunch sakte hain. Automated tuner deterministic hai — same spec do, same result milega. Ye debugging aur version control me bahut helpful hai.

Chautha reason — tuner ek measurement tool ki tarah bhi serve karta hai. Jab hum ek naya guidance algorithm likhein, uska best-achievable score tuner se pata kar sakte hain. Ye benchmarks provide karta hai ki naya algorithm actually purane se better hai ya nahi, ya sirf different hai.

Paanchva reason — tuner documentation bhi hai. Jo constants usne best nikale, unke bounds aur values batate hain ki is problem me kya range meaningful hai. Ye future tuning ke liye starting point hai.

Overall, tuner ek infrastructure piece hai — chahe aaj sirf ek mission ke liye use ho, apni existence ka justification ye hai ki platform me aane wali har mission aur stack automatically tuned ho sake. Isi liye ye worth building hai, chahe initial investment zyada lage.

---



