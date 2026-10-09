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
  const b0 = P.b00 + P.cG * (G - 0.59) + P.c1 * d + P.c2 * d * d;
  const w1 = P.w0 * Math.exp((A - 13.36) / P.s);
  const u = bias - b0, au = Math.abs(u);
  const E = P.E1 * (1 - Math.exp(-Math.pow(au / w1, 2))) + P.E2 * (1 - Math.exp(-au / P.w2));
  const f1 = u < -0.0047 + 0.15 * (4.82 - T);               // F1 cliff, just left of the V minimum
  return { u, E, f1, b0 };
}
const VR = [[0, 0.3], [0.007, 14], [0.12, 73], [0.35, 131], [0.5, 211], [0.58, 277], [0.66, 373], [0.705, 443]];
function stageVr(E) {
  for (let i = 1; i < VR.length; i++) if (E <= VR[i][0]) { const [x0, y0] = VR[i - 1], [x1, y1] = VR[i]; return y0 + (y1 - y0) * (E - x0) / (x1 - x0); }
  return 443 + (E - 0.705) * 400;
}

function makeHook(model) {
  model = Object.assign({ trueEmax: 0.185, alwaysF1: false, f2Bias: Infinity }, model || {});
  const stats = { coast: 0, circ: 0, full: 0 };
  const circ = (p) => {
    const e = surf(p).E;
    let vrEnd = 0.046 + 0.0101 * (p.li - 442);
    if (e > model.trueEmax) vrEnd = -1;                       // downstream failure above the true E limit
    return { vrEnd, marginS: vrEnd / 0.00685, vrMin: Math.min(-0.38, vrEnd - 0.4) };
  };
  return {
    stats,
    async runEval(p, o) {
      const s = surf(p);
      const base = { endReason: null, crashed: false, ticks: 1, stopAt: o.stopAt };
      if (o.stopAt === 'COAST_WAIT_ENTRY') {
        stats.coast++;
        if (model.alwaysF1 || s.f1) return Object.assign(base, { endReason: 'STAGE_VR_NEG', stageVrNeg: true, eCoast: NaN, apoCoastKm: NaN, vrMinStageBurn: -0.01 });
        return Object.assign(base, { endReason: 'COAST_WAIT_ENTRY', stageVrNeg: false, eCoast: s.E,
          apoCoastKm: s.u > model.f2Bias ? 300 : 320, vrMinStageBurn: stageVr(s.E) });
      }
      const c = circ(p);
      if (o.stopAt === 'CIRC_END') { stats.circ++; return Object.assign(base, c, { endReason: 'CIRC_END' }); }
      stats.full++;
      return Object.assign(base, c, { endReason: 'CLEARED', payloadReleased: true, payloadCleared: true, maxQKPa: 24.7, maxG: 4.8,
        apogeeKm: 320.1, perigeeKm: 320.0, ecc: 1e-5, boosterFuelLeftKg: 52625, deployTimeS: 590 + (U.aEff(p) - 13.94) * 2 });
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
    const g57 = r.log.some((l) => /AB#\d+ G=0\.57 /.test(l)) && r.log.some((l) => /AB#\d+ G=0\.56 /.test(l));
    t('dirOf: crossing bisect gets past G=0.57 (real log stopped there)', g57); }
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
    t(mode + ': AB evals bounded (<130)', r.evalBreakdown.ab < 130, 'ab=' + r.evalBreakdown.ab);
    t(mode + ': no flipping', nFlip(r) === 0);
  }
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
  console.log(fails ? 'FAILS: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
