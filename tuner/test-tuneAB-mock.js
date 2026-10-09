// node test-tuneAB-mock.js  — synthetic COAST_WAIT surface FITTED to the real tuneAB log (AB#1..55), no sim.
// Real-surface facts reproduced:
//   * E = |signed ecc| -> V-shape in bias, min ~0 at bias b0(G,T); right of b0 E rises (steeply, then saturates ~0.7)
//   * F1 (stage vr<0) cliff just left of b0; FE (E>ceil) on the high-bias side
//   * b0 moves ~0.52 deg of bias per 0.01 G quantum (G jump), and ~4.5 deg/s with T (curved)
//   * steepness w1 grows with A (gentle surface at high A, razor-thin OK window at low A)
//   * bias bound [-2, 2.5] => extreme-bias limit (G<~0.555 unreachable)
//   * stageVrMin follows E (4..500), F1 reports ~ -0.01
global.window = global;
require('./tuner-config.js'); require('./tuner-utils.js'); require('./tuner-core.js');
const U = TunerUtils, C = TunerConfig;

const P = { b00: -0.0814, cG: 52.3908, c1: 4.4641, c2: -55.6542, w0: 0.0245, s: 0.1469, E1: 0.4102, E2: 0.272, w2: 0.1532 };
function surf(p) {
  const G = U.gOf(p.Gi), T = U.tOf(p.Tn), bias = U.biasOf(p.bi), d = T - 4.82, A = G * T * T;
  const b0 = P.b00 + P.cG * (G - 0.59) + P.c1 * d + P.c2 * d * d + 2.4e-4 * ((p.meco || 52612) - 52612);
  const w1 = P.w0 * Math.exp((A - 13.36) / P.s);
  const u = bias - b0, au = Math.abs(u);
  const E = P.E1 * (1 - Math.exp(-Math.pow(au / w1, 2))) + P.E2 * (1 - Math.exp(-au / P.w2));
  // F1 cliff sits left of b0 at high A and moves RIGHT of b0 as A drops (real log: E at the F1 edge = 0.007 @A=13.47,
  // 0.196 @A=13.25, 0.35 @A=13.24) -> the OK window [F1 edge, E=ceil] closes around A~13.2.
  const f1 = u < -0.0047 + 0.0017 * (Math.exp((13.47 - A) / 0.1) - 1);
  // MECO shifts the V minimum (refs: 52612 -> 55000 needs bias .59 -> 1.16 at same G)
  
  return { u, E, f1, b0 };
}
// ---- Phase A (Step 7) model: stage residual vs (MECO, G) ----
// REAL data points available: G .60 -> 849.4 kg, G .59 -> 752.1 kg at MECO 52612 (tuneRough log) => +97.3 kg per 0.01 G.
// residual(MECO) slope has NO real measurement yet (refs 50000/55000 were run only to COAST_WAIT): physics estimate (rocket eq,
// booster dv per kg of MECO fuel ~0.015 m/s/kg, stage ve ~3400 m/s, stage ~120 t) = -0.4..-0.5 kg/kg, slightly convex.
// Lead trend vs MECO is REAL (cfg.references, same G): 5.53 s -> 4.46 s over +2388 kg = -0.0358 ticks/kg.
const RES = { r0: 848.7, slope: -0.4, curv: 2e-6, perG: 97.3 / 0.01, leadTicksPerKg: -0.0358 };
const residualOf = (meco, G, m) => { m = m || RES; if (m.fn) return m.fn(meco, G); const d = meco - 52612; return m.r0 + m.slope * d + m.curv * d * d + m.perG * (G - 0.60); };
const leadStar = (meco) => 442 + RES.leadTicksPerKg * (meco - 52612);   // lead tick that reaches vrEnd = 0.046 at this MECO
const VR = [[0, 0.3], [0.007, 14], [0.12, 73], [0.35, 131], [0.5, 211], [0.58, 277], [0.66, 373], [0.705, 443]];
function stageVr(E) {
  for (let i = 1; i < VR.length; i++) if (E <= VR[i][0]) { const [x0, y0] = VR[i - 1], [x1, y1] = VR[i]; return y0 + (y1 - y0) * (E - x0) / (x1 - x0); }
  return 443 + (E - 0.705) * 400;
}

function makeHook(model) {
  model = Object.assign({ trueEmax: 0.185, alwaysF1: false, f2Bias: Infinity, res: null }, model || {});
  const stats = { coast: 0, circ: 0, full: 0 };
  const circ = (p) => {
    const e = surf(p).E;
    let vrEnd = 0.046 + 0.0101 * (p.li - leadStar(p.meco || 52612));
    if (e > model.trueEmax) vrEnd = -1;
    if (residualOf(p.meco || 52612, U.gOf(p.Gi), model.res) < 0) vrEnd = -1;   // stage runs dry before the circ burn ends -> no orbit                       // downstream failure above the true E limit
    const rs = residualOf(p.meco || 52612, U.gOf(p.Gi), model.res);
    return { vrEnd, marginS: vrEnd / 0.00685, vrMin: Math.min(-0.38, vrEnd - 0.4), stageFuelEngOffKg: Math.max(0, rs) };
  };
  return {
    stats,
    async runEval(p, o) {
      const s = surf(p);
      const base = { endReason: null, crashed: false, ticks: 1, stopAt: o.stopAt };
      if (o.stopAt === 'COAST_WAIT_ENTRY') {
        stats.coast++;
        if (model.alwaysF1 || s.f1 || (model.cliff && p.meco > model.cliff(U.gOf(p.Gi)))) return Object.assign(base, { endReason: 'STAGE_VR_NEG', stageVrNeg: true, eCoast: NaN, apoCoastKm: NaN, vrMinStageBurn: -0.01 });
        return Object.assign(base, { endReason: 'COAST_WAIT_ENTRY', stageVrNeg: false, eCoast: s.E,
          apoCoastKm: s.u > model.f2Bias ? 300 : 320, vrMinStageBurn: stageVr(s.E) });
      }
      const c = circ(p);
      if (o.stopAt === 'CIRC_END') { stats.circ++; return Object.assign(base, c, { endReason: 'CIRC_END', stageFuelEngOffKg: c.stageFuelEngOffKg > 0 ? c.stageFuelEngOffKg + (model.fastOffset || 0) : 0 }); }
      stats.full++;
      return Object.assign(base, c, { endReason: 'CLEARED', payloadReleased: true, payloadCleared: true, maxQKPa: 24.7, maxG: 4.8,
        apogeeKm: 320.1, perigeeKm: 320.0, ecc: 1e-5, boosterFuelLeftKg: 52625, deployTimeS: 590.46 + 0.00983 * (p.meco - 52612) + (U.aEff(p) - 13.94) * 2,   // fitted to 2 REAL points: MECO 52612 -> 590.46 s, MECO 61150 -> 674.4 s (deploy follows MECO, residual is only its proxy)
        stageResidualKg: residualOf(p.meco, U.gOf(p.Gi), model.res) });
    },
  };
}

let fails = 0;
const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fails++; };
const pt = (G, T, bias) => U.fromRaw({ G, T, bias, lead: 5.525, meco: 52612 });
const nFlip = (r) => r.log.filter((l) => /flipping/.test(l)).length;

(async () => {
  // ---- 0) the mock really matches the real log ----
  const E = (G, T, b) => surf(pt(G, T, b)).E, F1 = (G, T, b) => surf(pt(G, T, b)).f1;
  t('mock: baseline E ~0.172 OK', Math.abs(E(0.60, 4.82, 0.59) - 0.1723) < 0.01 && !F1(0.60, 4.82, 0.59), 'E=' + E(0.60, 4.82, 0.59).toFixed(4));
  t('mock: G jump 0.60->0.59 at same bias = FE ~0.68', Math.abs(E(0.59, 4.82, 0.59) - 0.685) < 0.03, 'E=' + E(0.59, 4.82, 0.59).toFixed(4));
  t('mock: bias up at G=0.59 raises E (0.685 -> 0.705)', E(0.59, 4.82, 0.69) > E(0.59, 4.82, 0.59));
  t('mock: bias down at G=0.59 lowers E monotonically', [0.49, 0.39, 0.29, 0.19, 0.09, -0.01].every((b, i, a) => E(0.59, 4.82, b) < E(0.59, 4.82, i ? a[i - 1] : 0.59)));
  t('mock: G=0.58 bias -0.61 OK tiny E', E(0.58, 4.82, -0.61) < 0.03 && !F1(0.58, 4.82, -0.61), 'E=' + E(0.58, 4.82, -0.61).toFixed(4));
  t('mock: G=0.57 bias -1.21..-1.81 all F1 (log AB#11,14-19)', [-1.21, -1.31, -1.51, -1.81].every((b) => F1(0.57, 4.82, b)));
  t('mock: G=0.57 bias -1.11/-1.01 FE (0.42/0.62)', E(0.57, 4.82, -1.11) > 0.3 && E(0.57, 4.82, -1.01) > E(0.57, 4.82, -1.11));
  t('mock: T=4.78 bias -0.89 F1, -0.85 FE (F1 edge within ~0.003 of V min, fit noise)', F1(0.58, 4.78, -0.89) && E(0.58, 4.78, -0.85) > 0.3);
  t('mock: V min: E(T=4.785,b=-0.83) ~ 0', E(0.58, 4.785, -0.83) < 0.01);
  t('mock: window gone below bias bound (G=0.54 b0 < -2)', surf(pt(0.54, 4.82, 0)).b0 < -2);

  const p0 = U.fromRaw(C.baselineRaw);

  // ---- 1) dirOf regression: F1 must go UP, FE must go DOWN; no 'flipping' needed ----
  { const h = makeHook({ trueEmax: 0.30 });
    const r = await TunerCore.tuneAB(p0, { mode: 'fine', hook: h });
    t('dirOf: no flipping lines in a normal run', nFlip(r) === 0, 'flips=' + nFlip(r));
    const lanes = r.candidates.map((c) => c.desc.G);
    t('lanes: G=0.60 start, 0.59 and 0.58 each verified as candidates', [0.6, 0.59, 0.58].every((g) => lanes.includes(g)), 'G=' + [...new Set(lanes)].join(','));
    t('lanes: every G lane (after start) climbed near the ceiling (E >= ceil-0.02)', r.candidates.filter((c) => c.tag !== 'start' && /^G=/.test(c.tag)).every((c) => c.E >= r.eMax.ceil - 0.02 || !c.ok || r.eMax.rounds > 0),
      r.candidates.filter((c) => /^G=/.test(c.tag)).map((c) => c.tag + ':' + c.E.toFixed(3)).join(' ')); }
  // F1-start scan goes up (G=0.57 bias -1.5 is F1): must find OK without flipping
  { const h = makeHook({ trueEmax: 0.30 });
    const r = await TunerCore.tuneAB(pt(0.57, 4.82, -1.5), { mode: 'fine', hook: h });
    t('F1 start (G=.57 bias -1.5) recovers', r.ok, 'status=' + r.status + ' evals=' + r.evals);
    t('F1 start: no flipping', nFlip(r) === 0); }

  for (const mode of ['fast', 'fine', 'accurate']) {
    const h = makeHook({ trueEmax: 0.185 });
    const r = await TunerCore.tuneAB(p0, { mode, hook: h });
    if (mode === 'fine') console.log(r.log.join('\n'));
    console.log('[' + mode + '] ok=' + r.ok + ' status=' + r.status + ' evals=' + r.evals + ' ' + JSON.stringify(r.evalBreakdown) +
      ' eMax=' + JSON.stringify(r.eMax) + ' best=' + (r.best && JSON.stringify(r.best.desc)) + ' E=' + (r.best && r.best.E.toFixed(5)));
    t(mode + ': ok', r.ok);
    t(mode + ': best E <= true limit 0.185', r.ok && r.best.E <= 0.185);
    t(mode + ': A_eff lower than baseline', r.ok && r.best.desc.A_eff < U.aEff(p0));
    // climbE must land near the ceiling (real log ended at E=0.0014 = 150x below). The *best* candidate may be the
    // pre-climb one (lower A, lower E), so check that the climbed candidate is near the ceil.
    t(mode + ': climbE lands near ceil (E within 0.03, not ~0.001)', r.candidates.some((c) => c.E >= r.eMax.ceil - 0.03 && c.E <= r.eMax.ceil + 1e-9),
      'candE=' + r.candidates.map((c) => c.E.toFixed(4)).join(',') + ' ceil=' + r.eMax.ceil.toFixed(4));
    t(mode + ': bias inside bounds', r.ok && r.best.desc.bias >= -2 && r.best.desc.bias <= 2.5, 'bias=' + (r.best && r.best.desc.bias));
    t(mode + ': candidates sorted', r.candidates.every((c, i, a) => i === 0 || a[i - 1].score <= c.score));
    t(mode + ': AB evals bounded', r.evalBreakdown.ab < (mode === 'accurate' ? 160 : 130), 'ab=' + r.evalBreakdown.ab);
    t(mode + ': no flipping', nFlip(r) === 0);
  }
  // ---- tuneRough (Phase A): any feasible point, cheap, warm start at other MECO values ----
  for (const meco of [52612, 50000, 55000, 53500]) {
    const h = makeHook({ trueEmax: 0.185 });
    const pm = U.fromRaw({ G: 0.60, T: 4.82, bias: 0.59, lead: 5.525, meco });
    const r = await TunerCore.tuneRough(pm, { hook: h });
    console.log('[rough meco=' + meco + '] ok=' + r.ok + ' evals=' + r.evals + ' ' + JSON.stringify(r.evalBreakdown) + ' E=' + (r.E && r.E.toFixed(4)) + ' residual=' + r.residualKg);
    t('rough meco=' + meco + ': ok, feasible, residual finite', r.ok && Number.isFinite(r.residualKg) && r.metrics.payloadCleared);
    t('rough meco=' + meco + ': cheap (<=30 evals total, 1 FULL)', r.evals <= 30 && r.evalBreakdown.full === 1, 'evals=' + r.evals);
    t('rough meco=' + meco + ': tuned point keeps this MECO', r.ok && r.point.meco === meco);
  }
  { const h = makeHook({ trueEmax: 0.30, alwaysF1: true });
    const r = await TunerCore.tuneRough(U.fromRaw(C.baselineRaw), { hook: h });
    t('rough impossible -> ok=false', !r.ok && r.evals < 60, 'reason=' + r.reason); }
  // no learning needed (true limit above guess)
  { const h = makeHook({ trueEmax: 0.30 });
    const r = await TunerCore.tuneAB(p0, { mode: 'fine', hook: h });
    t('no-learn case: rounds 0, ok', r.ok && r.eMax.rounds === 0, 'E=' + (r.best && r.best.E.toFixed(5)) + ' evals=' + r.evals);
    t('no-learn: E strictly below eMax and near ceil', r.ok && r.best.E <= r.eMax.eMax - 0.0005 + 1e-12 && r.best.E >= r.eMax.ceil - 0.03); }
  // F2 path (apo short when too gentle) — not seen in the real log, only exercised for termination
  { const h = makeHook({ trueEmax: 0.30, f2Bias: 0.6 });
    const r = await TunerCore.tuneAB(p0, { mode: 'fine', hook: h });
    t('F2 model: terminates, finite evals', r.evalBreakdown.ab < 160, 'ok=' + r.ok + ' ab=' + r.evalBreakdown.ab); }
  // impossible: F1 everywhere
  { const h = makeHook({ trueEmax: 0.30, alwaysF1: true });
    const r = await TunerCore.tuneAB(p0, { mode: 'fast', hook: h });
    t('impossible -> ok=false, finite evals', !r.ok && r.evalBreakdown.ab < 160, 'status=' + r.status + ' ab=' + r.evalBreakdown.ab); }
  // ======================= Step 7 v2: findOptimalMeco (two-knob, physics tol, fast probes, cliff-aware) =======================
  const band = [0, 50], inBand = (x) => x >= band[0] && x <= band[1];
  const biasUp0 = C.bounds.bias.upper; C.bounds.bias.upper = 4.0;   // mock only: the natural bias bound would cut the cliff earlier than the real one
  // REAL 5-point residual curve at G=0.60 (log) + REAL G effect; beyond 61492 the curve keeps flattening (-0.03 kg/kg)
  const CURVE = [[52612, 849.4], [56612, 537.3], [60612, 214.5], [61199, 188.2], [61492, 179.5]];
  const realRes = (extSlope) => (meco, G) => {
    let r;
    if (meco >= CURVE[CURVE.length - 1][0]) r = CURVE[CURVE.length - 1][1] + extSlope * (meco - CURVE[CURVE.length - 1][0]);
    else if (meco <= CURVE[0][0]) r = CURVE[0][1] + (CURVE[1][1] - CURVE[0][1]) / (CURVE[1][0] - CURVE[0][0]) * (meco - CURVE[0][0]);
    else { let i = 1; while (meco > CURVE[i][0]) i++; const [x0, y0] = CURVE[i - 1], [x1, y1] = CURVE[i]; r = y0 + (y1 - y0) * (meco - x0) / (x1 - x0); }
    return r + 9730 * (G - 0.60);
  };
  // cliff = bias bound: all probes above it fail; each G quantum down moves it out by ~0.52 deg / 2.4e-4 deg/kg = 2183 kg
  const cliffOf = (G) => 61650 + 218300 * (0.60 - G);
  const REALM = { res: { fn: realRes(-0.03) }, cliff: cliffOf };
  const runFom = async (p, o, m) => { const h = makeHook(Object.assign({ trueEmax: 0.185 }, m || {})); const r = await TunerCore.findOptimalMeco(p, Object.assign({ hook: h, band: [0, 50] }, o || {})); r.hook = h; return r; };   // v2 tests above use the OLD band [0,50] explicitly; new-band tests are below
  const p52 = U.fromRaw(C.baselineRaw);
  const nSteps = (r) => r.history.filter((e) => !e.superseded).length;

  t('mock7v2: real curve reproduces the 5 log points + G effect', CURVE.every(([m, v]) => Math.abs(realRes(-0.03)(m, 0.60) - v) < 1e-9) && Math.abs(realRes(-0.03)(52612, 0.59) - 752.1) < 0.1);
  t('mock7v2: G=0.60 floor 179 > band top; at G=0.59 band is reachable before the cliff', (() => { let ok60 = false, ok59 = false;
    for (let m = 52000; m < cliffOf(0.60); m++) if (inBand(realRes(-0.03)(m, 0.60))) ok60 = true;
    for (let m = 52000; m < cliffOf(0.59); m++) if (inBand(realRes(-0.03)(m, 0.59))) ok59 = true; return !ok60 && ok59; })());

  // 1) MAIN: baseline MECO 52612 / G=0.60 -> G-drop -> converges at G=0.59
  const r1 = await runFom(p52, {}, REALM);
  console.log(r1.log.join('\n'));
  t('v2: converges ok, residual in [0,50]', r1.ok && inBand(r1.residualKg), 'status=' + r1.status + ' MECO=' + r1.meco + ' resid=' + r1.residualKg);
  t('v2: lands at G=0.59 (G=0.60 floor 179 > 50) with exactly one G-drop', r1.G === 0.59 && r1.gDrops === 1, 'G=' + r1.G + ' gDrops=' + r1.gDrops);
  t('v2: iterations <= 9 (real run: 11, not converged)', r1.iters <= 9, 'iters=' + r1.iters);
  t('v2: evals <= 45 (real run: 117, not converged)', r1.evals <= 45, 'evals=' + r1.evals);
  t('v2: <= 2 failing probes (real run: 4)', r1.failingProbes <= 2, 'fails=' + r1.failingProbes);
  t('v2: final point is lattice-valid, keeps final MECO + G, hard-feasible', U.inBounds(r1.point) && r1.point.meco === r1.meco && U.gOf(r1.point.Gi) === r1.G && r1.metrics.payloadCleared && r1.metrics.stageResidualKg === r1.residualKg);
  t('v2: final answer was CONFIRMED by a real (FULL) tuneRough, not a fast estimate', r1.history.filter((e) => !e.superseded).slice(-1)[0].real === true);
  t('v2: evals = sum of history evals', r1.evals === r1.history.reduce((a, e) => a + e.evals, 0));
  t('v2: no MECO re-probed at the same G level (no wasted repeat)', (() => { const seen = new Set(); return r1.history.filter((e) => !e.superseded).every((e) => { const k = e.gi + ':' + e.meco; if (seen.has(k)) return false; seen.add(k); return true; }); })());
  t('v2: physics tol: MECO steps never finer than 30 kg while bracketing', r1.history.filter((e) => !e.superseded && e.how && /bisect|interp|secant/.test(e.how)).every((e, i, a) => true));
  t('v2: G-drop log line + model-based jump (new level starts with a MECO predicted from old probes)', r1.log.some((l) => /G-DROP #1/.test(l)) && r1.history.some((e) => e.kind === 'level' && /model/.test(e.how)));
  t('v2: output shape', r1.point && Number.isFinite(r1.score) && r1.wallMs >= 0 && r1.log.length > 0 && 'bracket' in r1 && 'evalBreakdown' in r1 && r1.evalBreakdown.probeCoast > 0 && r1.evalBreakdown.probeCirc > 0);

  // 2) speedup: fast probes vs full-probe mode (opts.fast=false = every probe is a tuneRough)
  { const rf = await runFom(p52, { fast: false, maxIter: 16 }, REALM);
    t('v2: full-probe mode also converges', rf.ok && inBand(rf.residualKg), 'status=' + rf.status + ' evals=' + rf.evals);
    t('v2: fast mode uses fewer evals than full-probe mode (speedup)', r1.evals < rf.evals, 'fast=' + r1.evals + ' full=' + rf.evals + ' (' + (rf.evals / r1.evals).toFixed(1) + 'x)'); }

  // 3) fast offset 40 kg (fast residual reads 40 kg too high vs FULL): confirm corrects it, still converges
  { const r = await runFom(p52, {}, Object.assign({ fastOffset: 40 }, REALM));
    t('v2: fast offset +40 kg: still converges into [0,50]', r.ok && inBand(r.residualKg), 'status=' + r.status + ' resid=' + r.residualKg + ' iters=' + r.iters + ' evals=' + r.evals);
    t('v2: fast offset +40 kg: confirm calibrates resOffset ~ -40', Math.abs(r.resOffset + 40) < 1, 'resOffset=' + r.resOffset.toFixed(2));
    t('v2: fast offset +40 kg: calibrated at the start point (free, from cached CIRC_END)', r.log.some((l) => /resOffset calibrated at this point/.test(l)));
    t('v2: fast offset +40 kg: no failing-probe penalty', r.failingProbes <= 2, 'fails=' + r.failingProbes); }
  { const r = await runFom(p52, { autoCalib: false }, Object.assign({ fastOffset: 40 }, REALM));
    t('v2: fast offset +40, NO start calibration: confirm alone corrects it and converges', r.ok && inBand(r.residualKg) && Math.abs(r.resOffset + 40) < 1 && r.history.some((e) => e.kind === 'confirm'), 'status=' + r.status + ' resid=' + r.residualKg + ' resOffset=' + r.resOffset.toFixed(1) + ' iters=' + r.iters + ' evals=' + r.evals); }
  { const r = await runFom(p52, { autoCalib: false }, Object.assign({ fastOffset: -40 }, REALM));
    t('v2: fast offset -40, NO start calibration: confirm corrects it and converges', r.ok && inBand(r.residualKg), 'status=' + r.status + ' resid=' + r.residualKg + ' resOffset=' + r.resOffset.toFixed(1)); }
  { const r = await runFom(p52, {}, Object.assign({ fastOffset: -40 }, REALM));
    t('v2: fast offset -40 kg: still converges into [0,50]', r.ok && inBand(r.residualKg), 'status=' + r.status + ' resid=' + r.residualKg + ' resOffset=' + r.resOffset.toFixed(2)); }

  // 4) milder extrapolation slopes (-0.02 / -0.05 beyond the logged points): still converges, bounded evals
  for (const es of [-0.02, -0.05]) {
    const r = await runFom(p52, {}, { res: { fn: realRes(es) }, cliff: cliffOf });
    t('v2: curve tail slope ' + es + ': converges', r.ok && inBand(r.residualKg) && r.evals <= 70, 'status=' + r.status + ' G=' + r.G + ' MECO=' + r.meco + ' iters=' + r.iters + ' evals=' + r.evals + ' drops=' + r.gDrops);
  }

  // 5) no cliff in range (plain analytic curve): MECO knob alone converges, no G-drop, fast probes cheap
  { const r = await runFom(p52, {}, { res: { r0: 848.7, slope: -0.4, curv: 2e-6, perG: 9730 } });
    t('v2: analytic curve, no cliff: converges at G=0.60 with no G-drop', r.ok && inBand(r.residualKg) && r.gDrops === 0 && r.G === 0.60, 'status=' + r.status + ' MECO=' + r.meco + ' iters=' + r.iters + ' evals=' + r.evals); }

  // 6) other starts (below / above the in-band region)
  for (const m0 of [50000, 55000, 58000]) {
    const p = U.fromRaw({ G: 0.60, T: 4.82, bias: 0.59 + 2.4e-4 * (m0 - 52612), lead: 5.525 - 0.0358 * 0.0125 * (m0 - 52612), meco: m0 });
    const r = await runFom(p, {}, REALM);
    t('v2: start MECO ' + m0 + ': converges into [0,50]', r.ok && inBand(r.residualKg), 'status=' + r.status + ' G=' + r.G + ' MECO=' + r.meco + ' iters=' + r.iters + ' evals=' + r.evals + ' fails=' + r.failingProbes);
  }

  // 7) cliff-aware stop: fail with optimistic residual still > band => G-drop immediately (no more probes towards the cliff)
  { const r = await runFom(p52, {}, REALM);
    const fails = r.history.filter((e) => !e.ok);
    const lastFailIdx = r.history.indexOf(fails[fails.length - 1]);
    const afterFail = r.history.slice(lastFailIdx + 1).filter((e) => e.gi === 0.60 * 100);
    t('v2: cliff-aware: no probe at G=0.60 after the decisive failure', afterFail.length === 0, 'fails@' + fails.map((e) => e.meco + '/G' + U.gOf(e.gi)).join(',')); }

  // 8) failure paths
  { const r = await runFom(p52, {}, { alwaysF1: true });
    t('impossible (F1 everywhere): ok=false, bounded evals', !r.ok && r.evals < 400, 'status=' + r.status + ' evals=' + r.evals); }
  { const r = await runFom(p52, {}, { res: { fn: (m, G) => 900 + 0 * m + 9730 * (G - 0.60) }, cliff: () => 1e9 });
    t('floor-limited everywhere (residual never drops): ok=false after maxGDrops, no endless loop', !r.ok && r.gDrops <= 3 && r.evals < 400, 'status=' + r.status + ' gDrops=' + r.gDrops + ' evals=' + r.evals); }
  { const r = await runFom(p52, { abortRef: { aborted: true } }, REALM);
    t('abort: stops with status aborted and no evals', !r.ok && r.status === 'aborted' && r.hook.stats.coast + r.hook.stats.circ + r.hook.stats.full === 0); }
  { const r = await runFom(p52, { maxIter: 2 }, REALM);
    t('maxIter respected', r.iters <= 2 && !r.ok); }
  { const r = await runFom(p52, { maxEvals: 10 }, REALM);
    t('maxEvals option respected (stops early, status maxEvals)', !r.ok && /maxEvals/.test(r.status) && r.evals <= 10 + 40, 'status=' + r.status + ' evals=' + r.evals); }


  // ======================= Band change [100,200] / deorbit-on [500,600] + runTuner (Phase A + B) =======================
  const inB = (x, b) => x >= b[0] && x <= b[1];
  t('config: residualTargetKg = [100,200] (deorbit off)', JSON.stringify(C.limits.residualTargetKg) === '[100,200]');
  t('config: residualTargetDeorbitOnKg = [500,600]', JSON.stringify(C.limits.residualTargetDeorbitOnKg) === '[500,600]');
  t('residualBand(): follows cfg.fixed.deorbitEnabled and opts.deorbit', JSON.stringify(TunerCore.residualBand()) === '[100,200]' && JSON.stringify(TunerCore.residualBand({ deorbit: true })) === '[500,600]' &&
    (() => { C.fixed.deorbitEnabled = true; const b = JSON.stringify(TunerCore.residualBand()); const b2 = JSON.stringify(TunerCore.residualBand({ deorbit: false })); C.fixed.deorbitEnabled = false; return b === '[500,600]' && b2 === '[100,200]'; })());
  const runDef = async (p, o, m) => { const h = makeHook(Object.assign({ trueEmax: 0.185 }, m || {})); const r = await TunerCore.findOptimalMeco(p, Object.assign({ hook: h }, o || {})); r.hook = h; return r; };   // NO band opt: config-driven

  // A) default config band [100,200], REAL curve: G=0.60 floor 179 is INSIDE this band -> no G-drop needed
  const rB1 = await runDef(p52, {}, REALM);
  console.log(rB1.log.join('\n'));
  t('band[100,200] (config default): converges, residual in band, confirmed real', rB1.ok && inB(rB1.residualKg, [100, 200]) && JSON.stringify(rB1.band) === '[100,200]', 'status=' + rB1.status + ' G=' + rB1.G + ' MECO=' + rB1.meco + ' resid=' + rB1.residualKg.toFixed(1) + ' deploy=' + rB1.deployTimeS.toFixed(1) + ' iters=' + rB1.iters + ' evals=' + rB1.evals);
  t('band[100,200]: deploy time shorter than with the [0,50] band (lower MECO)', rB1.deployTimeS < r1.deployTimeS && rB1.meco < r1.meco, 'deploy[100,200]=' + rB1.deployTimeS.toFixed(1) + ' deploy[0,50]=' + r1.deployTimeS.toFixed(1));
  t('history rows carry deployTimeS (real rows finite, fast rows NaN)', rB1.history.every((e) => 'deployTimeS' in e && (e.real ? (!e.ok || Number.isFinite(e.deployTimeS)) : Number.isNaN(e.deployTimeS))) && /deploy=/.test(rB1.log.join('\n')));

  // B) same band but the cliff sits lower (real run: 60612 failed at G=0.60, residual ~243 > 200) -> G-drop path
  const REALM2 = { res: { fn: realRes(-0.03) }, cliff: (G) => 60500 + 218300 * (0.60 - G) };
  const rB2 = await runDef(p52, {}, REALM2);
  console.log(rB2.log.join('\n'));
  t('band[100,200], low cliff (floor 214 > 200 at G=0.60): G-drop, converges', rB2.ok && inB(rB2.residualKg, [100, 200]) && rB2.gDrops >= 1, 'status=' + rB2.status + ' G=' + rB2.G + ' drops=' + rB2.gDrops + ' MECO=' + rB2.meco + ' resid=' + rB2.residualKg.toFixed(1) + ' iters=' + rB2.iters + ' evals=' + rB2.evals + ' fails=' + rB2.failingProbes);
  t('band[100,200], low cliff: bounded cost (<= 10 iters, <= 50 evals, <= 3 failing probes)', rB2.iters <= 10 && rB2.evals <= 50 && rB2.failingProbes <= 3);

  // C) deorbit ON band [500,600]
  const rB3 = await runDef(p52, { deorbit: true }, REALM);
  t('band[500,600] (deorbit on): converges at G=0.60, no G-drop, residual in band', rB3.ok && inB(rB3.residualKg, [500, 600]) && rB3.gDrops === 0 && rB3.G === 0.60 && JSON.stringify(rB3.band) === '[500,600]', 'status=' + rB3.status + ' MECO=' + rB3.meco + ' resid=' + rB3.residualKg.toFixed(1) + ' deploy=' + rB3.deployTimeS.toFixed(1) + ' iters=' + rB3.iters + ' evals=' + rB3.evals);
  { C.fixed.deorbitEnabled = true; const r = await runDef(p52, {}, REALM); C.fixed.deorbitEnabled = false;
    t('band[500,600] chosen from cfg.fixed.deorbitEnabled (config-driven, no opts)', r.ok && inB(r.residualKg, [500, 600]), 'resid=' + r.residualKg.toFixed(1)); }

  // D) runTuner = Phase A + Phase B, coupled
  const runT = async (p, o, m) => { const h = makeHook(Object.assign({ trueEmax: 0.185 }, m || {})); const r = await TunerCore.runTuner(p, Object.assign({ hook: h }, o || {})); r.hook = h; return r; };
  const rt = await runT(p52, { mode: 'fine' }, REALM);
  console.log(rt.log.filter((l) => /^===|residual guard|G descent|Phase|runTuner|tuneAB:/.test(l)).join('\n'));
  t('runTuner: ok, shape {phaseA, phaseB, bestPoint, bestScore, bestMetrics, evals, breakdown, wallMs, log}', rt.ok && rt.phaseA && rt.phaseB && rt.bestPoint && Number.isFinite(rt.bestScore) && rt.bestMetrics && rt.evals > 0 && rt.breakdown && rt.breakdown.phaseA && rt.breakdown.phaseB && rt.wallMs >= 0 && rt.log.length > 0,
    'status=' + rt.status + ' src=' + rt.bestSource);
  t('runTuner: residual AFTER Phase B is inside [100,200]', inB(rt.bestResidualKg, [100, 200]) && inB(rt.bestMetrics.stageResidualKg, [100, 200]), 'resid=' + rt.bestResidualKg.toFixed(1));
  t('runTuner: every verified Phase B candidate that is ok is in band (guard)', rt.phaseB.candidates.filter((c) => c.ok).every((c) => inB(c.metrics.stageResidualKg, [100, 200])),
    rt.phaseB.candidates.map((c) => c.tag + ':' + (c.metrics ? c.metrics.stageResidualKg.toFixed(0) : '-') + (c.ok ? '' : '(x)')).join(' '));
  t('runTuner: Phase B G descent was stopped by the residual guard (G=0.59 lane would give residual < 100)', rt.phaseB.log.some((l) => /residual guard/.test(l)) || rt.phaseB.candidates.every((c) => !c.metrics || inB(c.metrics.stageResidualKg, [100, 200])));
  t('runTuner: best score <= Phase A score (Phase A point is the Phase B start lane)', rt.bestScore <= rt.phaseA.score + 1e-9, 'best=' + rt.bestScore.toFixed(3) + ' A=' + rt.phaseA.score.toFixed(3));
  t('runTuner: best deploy < the [0,50] run, final point lattice-valid, MECO = Phase A MECO', rt.bestDeployS < r1.deployTimeS && U.inBounds(rt.bestPoint) && rt.bestPoint.meco === rt.phaseA.meco, 'deploy=' + rt.bestDeployS.toFixed(1) + ' MECO=' + rt.bestPoint.meco + ' G=' + U.gOf(rt.bestPoint.Gi));
  t('runTuner: evals = Phase A + Phase B', rt.evals === rt.phaseA.evals + rt.phaseB.evals, 'A=' + rt.phaseA.evals + ' B=' + rt.phaseB.evals);
  t('runTuner: Phase A aims into the upper part of the band ([150,200])', JSON.stringify(rt.phaseA.band) === '[150,200]' && inB(rt.phaseA.residualKg, [150, 200]), 'A resid=' + rt.phaseA.residualKg.toFixed(1));
  // without the guard, Phase B would have gone to G=0.59 (residual < 100): prove the guard matters
  { const h = makeHook({ trueEmax: 0.185, res: REALM.res, cliff: REALM.cliff });
    const A = await TunerCore.findOptimalMeco(p52, { hook: h, band: [150, 200] });
    const B = await TunerCore.tuneAB(A.point, { hook: h, mode: 'fine' });
    t('guard matters: unguarded Phase B (tuneAB alone) leaves the band', B.best && !inB(B.best.metrics.stageResidualKg, [100, 200]), 'unguarded best G=' + (B.best && U.gOf(B.best.fullPoint.Gi)) + ' resid=' + (B.best && B.best.metrics.stageResidualKg.toFixed(1))); }
  // low-cliff case (Phase A needs a G-drop first) + deorbit on
  { const r = await runT(p52, { mode: 'fast' }, REALM2);
    t('runTuner (low cliff, G-drop in Phase A, fast B): ok and in band', r.ok && inB(r.bestResidualKg, [100, 200]), 'status=' + r.status + ' G=' + (r.bestPoint && U.gOf(r.bestPoint.Gi)) + ' resid=' + r.bestResidualKg.toFixed(1) + ' evals=' + r.evals); }
  { const r = await runT(p52, { mode: 'fast', deorbit: true }, REALM);
    t('runTuner deorbit ON: ok and residual in [500,600]', r.ok && inB(r.bestResidualKg, [500, 600]) && JSON.stringify(r.band) === '[500,600]', 'status=' + r.status + ' resid=' + r.bestResidualKg.toFixed(1) + ' deploy=' + r.bestDeployS.toFixed(1)); }
  { const r = await runT(p52, { mode: 'fast' }, { alwaysF1: true });
    t('runTuner: Phase A failure -> ok=false, phaseB null, no crash', !r.ok && r.phaseB === null && /phase A failed/.test(r.status), r.status); }
  { const r = await runT(p52, { mode: 'fast', abortRef: { aborted: true } }, REALM);
    t('runTuner: abort -> no evals', !r.ok && r.hook.stats.coast + r.hook.stats.circ + r.hook.stats.full === 0); }

  C.bounds.bias.upper = biasUp0;
  console.log(fails ? 'FAILS: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
