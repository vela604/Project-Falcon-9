// headless/tuner/diag-a-collapse.js — A -> (G, T, A_eff) collapse map. Pure computation, no sim.
//   node tuner/diag-a-collapse.js [--lo 13.5] [--hi 14.5] [--step 0.001]
'use strict';
const path = require('path');
const { collapseAscent, loadConfig } = require('./evaluator');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : Number(process.argv[i + 1]); };
const lo = arg('lo', 13.5), hi = arg('hi', 14.5), step = arg('step', 0.001);
const cfg = loadConfig(path.join(__dirname, 'tuner-config-v3.json'));
const tA = cfg.tunables.find(t => t.id === 'ascent_profile_constant');
const TQ = tA.pushTQuantumS, T0 = tA.anchorPushT_s;
const N = Math.round((hi - lo) / step);
const pts = [];
for (let i = 0; i <= N; i++) { const A = Number((lo + i * step).toFixed(6)); const c = collapseAscent(tA, A); pts.push({ A, G: c.G, T: c.T, Tn: c.Tn, Aeff: c.A_eff, cd: c.cd }); }
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (x, d) => Number(x).toFixed(d);

console.log('A range [' + lo + ',' + hi + '] step ' + step + ' (' + pts.length + ' pts); T quantum ' + TQ + ' s, anchor T0 ' + T0 + ', G quantum ' + tA.gimbalQuantumDeg);

// 1. G jumps (T resets) and Tn transitions
const gj = [], tj = [];
for (let i = 1; i < pts.length; i++) {
  if (pts[i].G !== pts[i - 1].G) gj.push(i);
  if (pts[i].Tn !== pts[i - 1].Tn) tj.push(i);
}
console.log('\n1) G-quantum jumps (T snaps back when G steps 0.01): ' + gj.length);
gj.forEach(i => console.log('   A=' + f(pts[i].A, 3) + '  G ' + pts[i - 1].G + ' -> ' + pts[i].G + '   T ' + f(pts[i - 1].T, 6) + ' -> ' + f(pts[i].T, 6) + '   A_eff ' + f(pts[i - 1].Aeff, 5) + ' -> ' + f(pts[i].Aeff, 5)));
console.log('   Tn transitions on this grid: ' + tj.length + ' of ' + (pts.length - 1) + ' steps (' + f(100 * tj.length / (pts.length - 1), 1) + '% of 0.001-steps change Tn)');
console.log('   first 12 transitions:'); tj.slice(0, 12).forEach(i => console.log('   A=' + f(pts[i].A, 3) + '  Tn ' + pts[i].Tn + '  T ' + f(pts[i].T, 6) + '  A_eff ' + f(pts[i].Aeff, 5)));

// 2. density
const distinct = new Set(pts.map(p => p.Tn)).size, tr = pts[pts.length - 1].T - pts[0].T;
console.log('\n2) distinct Tn values: ' + distinct + ' over ' + pts.length + ' pts;  T from ' + f(pts[0].T, 6) + ' to ' + f(pts[pts.length - 1].T, 6));
const slope = 1 / (2 * 0.60 * 4.82);
console.log('   analytic dT/dA = 1/(2 G T) ~ ' + f(slope, 4) + ' s per unit A  => ' + f(slope * 0.001 / TQ, 2) + ' T-quanta per 0.001 of A, ' + f(slope * TQ, 6) + ' A per T-quantum is ' + f(TQ / slope, 6));

// 3. T quanta crossed per nominal A step
console.log('\n3) T-quanta crossed per nominal A step (|dTn| and number of G-jumps inside), all windows on the grid');
console.log('   step    #win    |dTn| min / median / max     windows containing a G-jump    A_eff change min/median/max');
[0.01, 0.05, 0.1, 0.2].forEach(s => {
  const k = Math.round(s / step), d = [], ae = []; let gjw = 0;
  for (let i = 0; i + k < pts.length; i++) { d.push(Math.abs(pts[i + k].Tn - pts[i].Tn)); ae.push(pts[i + k].Aeff - pts[i].Aeff); if (pts[i + k].G !== pts[i].G) gjw++; }
  console.log('   ' + String(s).padEnd(7) + String(d.length).padEnd(8) + (Math.min(...d) + ' / ' + med(d) + ' / ' + Math.max(...d)).padEnd(28) + (gjw + ' (' + f(100 * gjw / d.length, 0) + '%)').padEnd(31) + f(Math.min(...ae), 4) + ' / ' + f(med(ae), 4) + ' / ' + f(Math.max(...ae), 4));
});

// 4. A_eff monotonicity near baseline, plus A_eff vs A deviation overall
const fine = [];
for (let A = 13.9; A <= 14.0000001; A += 0.0001) { const A4 = Number(A.toFixed(5)); fine.push(Object.assign({ A: A4 }, collapseAscent(tA, A4))); }
let dec = 0, worst = 0;
for (let i = 1; i < fine.length; i++) { const d = fine[i].A_eff - fine[i - 1].A_eff; if (d < 0) { dec++; worst = Math.min(worst, d); } }
console.log('\n4) A_eff monotonicity on [13.9, 14.0] step 0.0001 (' + fine.length + ' pts): decreases ' + dec + ', worst drop ' + worst.toExponential(2));
let decAll = 0, maxDev = 0; for (let i = 1; i < pts.length; i++) { if (pts[i].Aeff < pts[i - 1].Aeff) decAll++; }
pts.forEach(p => { maxDev = Math.max(maxDev, Math.abs(p.Aeff - p.A)); });
console.log('   whole range (step ' + step + '): A_eff decreases ' + decAll + ' times;  max |A_eff - A| = ' + maxDev.toExponential(2));
console.log('\nBaseline neighbourhood (T = 4.820 hard transition):');
[13.9390, 13.93944, 13.9400, 13.9405, 13.9410, 13.9420, 13.9500].forEach(A => { const c = collapseAscent(tA, A); console.log('   A=' + f(A, 5) + '  G ' + c.G + '  Tn ' + c.Tn + '  T ' + f(c.T, 6) + '  ' + (c.T > 4.82 + 1e-9 ? 'T>4.820' : c.T < 4.82 - 1e-9 ? 'T<4.820' : 'T=4.820')); });
const idx820 = pts.find(p => p.T > 4.82 + 1e-9 && p.G === 0.6);
if (idx820) console.log('   smallest grid A with G=0.60 and T>4.820: A=' + f(idx820.A, 3));
const tAt = (G) => Math.sqrt(13.93944 / G);
console.log('   G=0.60 gives T=4.82 at A=' + f(0.6 * 4.82 * 4.82, 5) + ' (A at T=4.820 exactly);  T=4.820 is reachable only at A ~ G*T^2 for each G: ' +
  [0.58, 0.59, 0.60, 0.61, 0.62].map(G => 'G' + G + ':A=' + f(G * 4.82 * 4.82, 4)).join('  '));
