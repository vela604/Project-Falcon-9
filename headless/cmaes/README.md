
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

