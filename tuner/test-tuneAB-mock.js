// node test-tuneAB-mock.js  — synthetic E model, no sim.
global.window = global;
require('./tuner-config.js'); require('./tuner-utils.js'); require('./tuner-core.js');
const U = TunerUtils, C = TunerConfig;

function makeHook(model) {
  const stats = { coast: 0, circ: 0, full: 0 };
  const gent = (p) => (U.aEff(p) - 13.0) * 0.5 + U.biasOf(p.bi) * 0.6;
  const E = (p) => 0.172 - 0.08 * (gent(p) - 0.824);
  const circ = (p) => {
    const e = E(p);
    let vrEnd = 0.046 + 0.0101 * (p.li - 442);
    if (e > model.trueEmax) vrEnd = -1;
    return { vrEnd, marginS: vrEnd / 0.00685, vrMin: Math.min(-0.38, vrEnd - 0.4) };
  };
  return {
    stats,
    async runEval(p, o) {
      const g = gent(p), e = E(p);
      const base = { endReason: null, crashed: false, ticks: 1, stopAt: o.stopAt };
      if (o.stopAt === 'COAST_WAIT_ENTRY') {
        stats.coast++;
        if (g < model.f1) return Object.assign(base, { endReason: 'STAGE_VR_NEG', stageVrNeg: true, eCoast: NaN, apoCoastKm: NaN, vrMinStageBurn: -1 });
        return Object.assign(base, { endReason: 'COAST_WAIT_ENTRY', stageVrNeg: false, eCoast: e, apoCoastKm: g > model.f2 ? 300 : 320, vrMinStageBurn: 100 });
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

(async () => {
  const p0 = U.fromRaw(C.baselineRaw);
  for (const mode of ['fast', 'fine', 'accurate']) {
    const h = makeHook({ trueEmax: 0.185, f1: 0.2, f2: 4 });
    const r = await TunerCore.tuneAB(p0, { mode, hook: h });
    if (mode === 'fine') console.log(r.log.join('\n'));
    console.log('[' + mode + '] ok=' + r.ok + ' status=' + r.status + ' evals=' + r.evals + ' ' + JSON.stringify(r.evalBreakdown) +
      ' eMax=' + JSON.stringify(r.eMax) + ' best=' + (r.best && JSON.stringify(r.best.desc)) + ' E=' + (r.best && r.best.E.toFixed(5)));
    t(mode + ': ok', r.ok);
    t(mode + ': learned eMax below true limit', r.ok && r.best.E <= 0.185 && r.eMax.rounds >= 1);
    t(mode + ': A_eff lower than baseline', r.ok && r.best.desc.A_eff < U.aEff(p0));
    t(mode + ': candidates sorted', r.candidates.every((c, i, a) => i === 0 || a[i - 1].score <= c.score));
    t(mode + ': COAST evals bounded (<160)', r.evalBreakdown.ab < 160, 'ab=' + r.evalBreakdown.ab);
  }
  // no learning needed (true limit above guess)
  { const h = makeHook({ trueEmax: 0.30, f1: 0.2, f2: 4 });
    const r = await TunerCore.tuneAB(p0, { mode: 'fine', hook: h });
    t('no-learn case: rounds 0, ok', r.ok && r.eMax.rounds === 0, 'E=' + (r.best && r.best.E.toFixed(5)) + ' evals=' + r.evals);
    t('E strictly below eMax', r.ok && r.best.E <= r.eMax.eMax - 0.0005 + 1e-12); }
  // start in F1 (too aggressive): low A, low bias
  { const h = makeHook({ trueEmax: 0.30, f1: 0.2, f2: 4 });
    const p = U.fromRaw({ G: 0.45, T: 4.82, bias: -0.5, lead: 5.525, meco: 52612 });
    const r = await TunerCore.tuneAB(p, { mode: 'fine', hook: h });
    t('F1 start recovers', r.ok, 'status=' + r.status + ' evals=' + r.evals); }
  // impossible: F1 everywhere
  { const h = makeHook({ trueEmax: 0.30, f1: 99, f2: 4 });
    const r = await TunerCore.tuneAB(p0, { mode: 'fast', hook: h });
    t('impossible -> ok=false, finite evals', !r.ok && r.evalBreakdown.ab < 160, 'status=' + r.status + ' ab=' + r.evalBreakdown.ab); }
  console.log(fails ? 'FAILS: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
