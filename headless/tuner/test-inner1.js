// node tuner/test-inner1.js   — offline: INNER-1 against a synthetic sim (no real sim needed).
// The synthetic world implements the evaluator contract used by inner1/inner2 (evaluateMany with a lattice cache, `effective`,
// `cached`, coastEnd + full evals) on top of the REAL evaluator.collapseAscent, so the (G, Tn) lattice mapping is the real one.
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { collapseAscent } = require('./evaluator');
const I1 = require('./inner1');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'tuner-config-v3.json'), 'utf8'));
const tA = cfg.tunables.find(t => t.id === 'ascent_profile_constant');
const DT = 1 / 80, TQ = tA.pushTQuantumS, SPLIT = Math.round(tA.anchorPushT_s / TQ);
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); } }
const clone = o => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------
// Synthetic world.  u = G*T^2 + gOff(cd) [G jumps are real discontinuities] + step (T >= 4.820) + MECO shift
//   b*(u) = 0.5 + 1.3 (u - 14.2)  (optionally outside the bias range below `monoBelow` => monotone, one branch only)
//   E(b) = Emin(u) + (b < b* ? 0.15 : 0.5) (b - b*)^2      Emin(u) = 0.002 exp(5.75 (14.5 - u))   (V shape, steep wall)
//   leadMax(E) = 60 (1 - E / leadK)  (t_to_apogee at COAST_WAIT entry)
//   Level 1: success needs lead >= l0 = 5.4 + 0.5 E, margin = m0 + 60 (lead - l0); below l0 the burn ends past apogee.
//   E > emaxPhys => physics failure (vr dips below the hard floor for all leads that finish)   [truth E_max]
// ---------------------------------------------------------------------------------------------
function makeWorld(o) {
  const W = Object.assign({ emaxPhys: 0.25, leadK: 0.6, step: 0.05, monoBelow: -Infinity, monoB: -2.3, confound: null }, o || {});
  const gOff = cd => (((cd * 37) % 7) - 3) * 0.02;
  const u = (cd, Tn, meco) => cd * 0.01 * (Tn * TQ) * (Tn * TQ) + gOff(cd) + (Tn >= SPLIT ? W.step : 0) + (meco - 52612) * 1e-4;
  const bStar = uu => (uu < W.monoBelow ? W.monoB : 0.5 + 1.3 * (uu - 14.2));
  const Emin = uu => 0.002 * Math.exp(5.75 * (Math.max(uu, -50) < 14.5 ? 14.5 - uu : 0));
  const E = (cd, Tn, bn, meco) => { const uu = u(cd, Tn, meco), bs = bStar(uu), b = bn * 1e-4; return Emin(uu) + (b < bs ? 0.15 : 0.5) * (b - bs) * (b - bs); };
  const leadMax = e => Math.max(0, 60 * (1 - e / W.leadK));
  const eMinLat = (cd, Tn, meco) => {                     // lattice minimum over the bias range
    const bs = bStar(u(cd, Tn, meco)), lo = -20000, hi = 25000;
    const c = Math.max(lo, Math.min(hi, Math.round(bs / 1e-4))); let best = null;
    for (let bn = c - 2; bn <= c + 2; bn++) { if (bn < lo || bn > hi) continue; const e = E(cd, Tn, bn, meco); if (!best || e < best.E) best = { E: e, bn }; }
    return best;
  };
  const counts = { level0: 0, full: 0, byMeco: {}, fullCalls: [] };
  const seen = new Set();
  const world = { W, u, E, eMinLat, leadMax, counts, bStar, gOff };
  world.ev = {
    workers: 6,
    score: m => ({ score: m.timeToDeployS * 0.0005 }),
    evaluateMany: async (list, opts) => {
      const coast = opts && opts.eval === 'coastEnd';
      return list.map(v => {
        const c = collapseAscent(tA, v.ascent_profile_constant);
        const bn = Math.round(v.stage_burn_aoa_bias / 1e-4), n = Math.round(v.circ_trigger_lead / DT), meco = v.meco_target_booster_fuel;
        const key = (coast ? 'C' : 'F') + [c.cd, c.Tn, bn, meco, coast ? 0 : n].join('|');
        const cached = seen.has(key); seen.add(key);
        const e = E(c.cd, c.Tn, bn, meco), lm = leadMax(e), cet = 520 + 30 * e + 4 * (bn * 1e-4 - 0.6);
        const effective = { ascent_G: c.G, ascent_T: c.T, ascent_Tn: c.Tn, A_eff: c.A_eff, bias: bn * 1e-4, lead: n * DT };
        const m = { evalKind: coast ? 'coastEnd' : 'full', coastEndEcc: e, coastEndTToApoS: lm, coastEndT: cet, coastEndPeriodS: 5400, coastEndExactTick: true, stageFuelAtCoastEndKg: 1200 };
        if (coast) { if (!cached) { counts.level0++; counts.byMeco[meco] = (counts.byMeco[meco] || 0) + 1; } return { metrics: m, effective, cached, hardFail: false }; }
        if (!cached) { counts.full++; counts.fullCalls.push({ cd: c.cd, Tn: c.Tn, bn, meco, E: e, leadMax: lm, lead: n * DT }); }
        const lead = n * DT, l0 = 5.4 + 0.5 * e, physFail = e > W.emaxPhys;
        const m0 = (W.confound && W.confound(e, c.cd)) ? 8 : 3;
        let p;
        if (lead < l0) p = { circEndMarginS: 900 + 30 * lead, circMinVr: -1.5, circVrAtEnd: -0.8, payloadCleared: false };
        else if (physFail) p = { circEndMarginS: 8 + 60 * (lead - l0), circMinVr: lead < l0 + 0.5 ? -5 : 0.3, circVrAtEnd: 0.2, payloadCleared: true };
        else p = { circEndMarginS: m0 + 60 * (lead - l0), circMinVr: 0.3, circVrAtEnd: 0.2, payloadCleared: true };
        Object.assign(m, { circBurnStarted: true, circBurnEnded: true, timeToDeployS: cet + lm + 12 + 0.1 * lead }, p);
        return { metrics: m, effective, cached, hardFail: false };
      });
    }
  };
  return world;
}

// brute-force truth helpers (lattice)
const geoOf = () => I1.makeGeo(I1.params(cfg, {}));
function okAt(world, cd, Tn, bn, meco, eT, tNeeded) { const e = world.E(cd, Tn, bn, meco); return e <= eT && world.leadMax(e) >= tNeeded; }
function truthMinTn(world, cd, sub, meco, eT, tNeeded) {
  for (let Tn = sub.lo; Tn <= sub.hi; Tn++) { const m = world.eMinLat(cd, Tn, meco); if (m.E <= eT && world.leadMax(m.E) >= tNeeded) return Tn; }
  return null;
}
const tNeeded = cfg.guided.inner1.tNeededS;

(async () => {
  const geo = geoOf(), P0 = I1.params(cfg, {});

  console.log('inner1: lattice geometry');
  await t('segments: T range matches the collapse map, contains 4.820, round-trips through collapseAscent', () => {
    for (let cd = 56; cd <= 64; cd++) {
      const r = geo.segRange(cd);
      assert.ok(r.lo <= SPLIT && SPLIT <= r.hi, 'segment ' + cd + ' contains Tn(4.820)');
      assert.ok(geo.inSeg(cd, r.lo) && geo.inSeg(cd, r.hi) && !geo.inSeg(cd, r.lo - 1) && !geo.inSeg(cd, r.hi + 1));
      [r.lo, r.lo + 1, SPLIT, r.hi - 1, r.hi].forEach(Tn => { const c = collapseAscent(tA, geo.pointA(cd, Tn)); assert.strictEqual(c.cd, cd); assert.strictEqual(c.Tn, Tn); });
      const s = geo.subs(cd); assert.strictEqual(s.length, 2); assert.strictEqual(s[0].hi, SPLIT - 1); assert.strictEqual(s[1].lo, SPLIT);
    }
    const r60 = geo.segRange(60); assert.ok(Math.abs(r60.lo * TQ - 4.7995) < 0.001 && Math.abs(r60.hi * TQ - 4.8405) < 0.001, 'G.60 T range ' + r60.lo * TQ + '..' + r60.hi * TQ);
    // G jump: A_eff continuous, (G, T) not (STATE: A -> (G,T) collapse map)
    const a = geo.pointA(60, geo.segRange(60).hi), b = geo.pointA(61, geo.segRange(61).lo);
    assert.ok(Math.abs(a - b) < 1e-3, 'same A_eff across the jump: ' + a + ' vs ' + b);
  });
  await t('warm start: refs exact, interpolation between refs, 55000 now carries G 0.60', () => {
    const w = I1.warmStart(cfg, 52612, P0); assert.strictEqual(w.cd, 60); assert.strictEqual(w.bias, 0.59); assert.ok(Math.abs(w.lead - 5.525) < 1e-9);
    const w5 = I1.warmStart(cfg, 55000, P0); assert.strictEqual(w5.cd, 60); assert.strictEqual(w5.bias, 1.16);
    const w1 = I1.warmStart(cfg, 51000, P0); assert.ok(w1.bias < 0.78 && w1.bias > 0.59 && w1.cd === 61, JSON.stringify(w1));
    assert.ok(cfg.guided.mecoOuter.warmStart.every(r => typeof r.G === 'number'));
  });

  console.log('inner1: E_max bracket logic');
  await t('initial bracket, upward probe, geometric bisection, convergence', () => {
    const L = I1.newLearned(cfg); let b = I1.bracketOf(L, 1, 'R', P0);
    assert.strictEqual(b.eOk, 0.171); assert.strictEqual(b.eFail, null); assert.ok(Math.abs(I1.nextTarget(b, P0) - 0.2565) < 1e-12);
    I1.applyOutcome(L, 1, 'R', 0.2565, { kind: 'fail' }); b = I1.bracketOf(L, 1, 'R', P0);
    assert.ok(Math.abs(I1.nextTarget(b, P0) - Math.sqrt(0.171 * 0.2565)) < 1e-12);
    I1.applyOutcome(L, 1, 'R', 0.25, { kind: 'ok' }); I1.applyOutcome(L, 1, 'R', 0.2565 / 1.0, { kind: 'fail' });
    b = I1.bracketOf(L, 1, 'R', P0); assert.strictEqual(b.eOk, 0.25); assert.strictEqual(b.eFail, 0.2565); assert.ok(b.converged);
    assert.ok(Math.abs(I1.finalTarget(b, P0) - 0.25 * 0.95) < 1e-12);
  });
  await t('INNER-2 outcome mapping: only timing-bound / vr-hardfloor are failures', () => {
    const c = I1.classifyOutcome;
    assert.strictEqual(c({ status: 'converged', detail: 'in-window' }).kind, 'ok');
    assert.strictEqual(c({ status: 'converged', detail: 'window-skipped' }).kind, 'inconclusive');
    assert.strictEqual(c({ status: 'converged', detail: 'lead-floor' }).kind, 'inconclusive');
    assert.strictEqual(c({ status: 'timing-bound', detail: 'past-apogee' }).kind, 'fail');
    assert.strictEqual(c({ status: 'physics-bound', detail: 'vr-hardfloor' }).kind, 'fail');
    assert.strictEqual(c({ status: 'physics-bound', detail: 'no-valid-burn' }).kind, 'inconclusive');
    assert.strictEqual(c({ status: 'physics-bound', detail: 'vr-negative' }).kind, 'inconclusive');
  });
  await t('a fail BELOW a verified ok is contradictory evidence: ignored (E_max not lowered), flagged', () => {
    const L = I1.newLearned(cfg); I1.applyOutcome(L, 1, 'R', 0.22, { kind: 'ok' }); I1.applyOutcome(L, 1, 'R', 0.19, { kind: 'fail' });
    const b = I1.bracketOf(L, 1, 'R', P0); assert.strictEqual(b.eOk, 0.22); assert.strictEqual(b.eFail, null); assert.deepStrictEqual(b.contradicted, [0.19]);
  });
  await t('seed from nearest MECO; own failure below the unverified seed discards it (probe downward)', () => {
    const L = I1.newLearned(cfg); I1.applyOutcome(L, 52612, 'R', 0.245, { kind: 'ok' }); I1.applyOutcome(L, 52612, 'R', 0.25, { kind: 'fail' });
    let b = I1.bracketOf(L, 53000, 'R', P0); assert.strictEqual(b.eOk, 0.245); assert.strictEqual(b.eFail, 0.25); assert.ok(b.seeded && b.converged);
    I1.applyOutcome(L, 53000, 'R', 0.2, { kind: 'fail' }); b = I1.bracketOf(L, 53000, 'R', P0);
    assert.strictEqual(b.eOk, null); assert.strictEqual(b.eFail, 0.2); assert.ok(Math.abs(I1.nextTarget(b, P0) - 0.2 / 1.5) < 1e-12);
  });

  console.log('inner1: boundary search on the synthetic world (V shape, G jumps, T=4.820 step, both branches)');
  let base = null;
  await t('full run: min-T boundary per (segment, sub-segment) is EXACT, bias crossings exact on both branches, E_max learned', async () => {
    const w = makeWorld({ emaxPhys: 0.25 });
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) });
    base = { w, r };
    assert.ok(r.best, 'no result: ' + r.reason + ' ' + JSON.stringify(r.notes));
    assert.ok(r.candidates.some(c => c.branch === 'R') && r.candidates.some(c => c.branch === 'L'), 'both branches traced');
    // exactness of every Level-0 candidate against brute force truth
    let nT = 0;
    r.candidates.forEach(c => {
      const sub = geo.subs(c.cd).find(s => s.name === c.sub);
      assert.strictEqual(c.Tn, truthMinTn(w, c.cd, sub, 52612, c.eTarget, tNeeded), 'min Tn cd=' + c.cd + ' ' + c.sub + ' ' + c.branch);
      const dir = c.branch === 'R' ? 1 : -1;
      assert.ok(okAt(w, c.cd, c.Tn, c.bn, 52612, c.eTarget, tNeeded), 'candidate itself feasible');
      assert.ok(!okAt(w, c.cd, c.Tn, c.bn + dir, 52612, c.eTarget, tNeeded), 'next tick outward infeasible (' + c.branch + ')');
      assert.ok(Math.abs(c.A_eff - geo.pointA(c.cd, c.Tn)) < 1e-9); nT++;
    });
    assert.ok(nT >= 4, 'candidates ' + nT);
    // E_max learning: truth physics E_max = 0.25
    ['L', 'R'].forEach(b => { const br = r.brackets[b]; assert.ok(br.eOk <= 0.25 && br.eFail > 0.25 && br.converged, b + ' ' + JSON.stringify(br)); assert.ok(Math.abs(r.eFinal[b] - br.eOk * 0.95) < 1e-12); });
    r.ranked.forEach(c => { assert.ok(c.windowReached && c.E <= r.eFinal[c.branch] * (1 + 1e-9), 'final E below E_final'); });
    for (let i = 1; i < r.ranked.length; i++) assert.ok(r.ranked[i - 1].score <= r.ranked[i].score, 'ranked by score');
    assert.ok(r.ranked.length >= 1 && r.ranked.length <= 3);
    assert.ok(Math.abs(r.proxyOffsetS - 12.5) < 1, 'deploy proxy offset calibrated: ' + r.proxyOffsetS);
  });
  await t('eval counts under budget (Level-0 evals, rounds, INNER-2 calls)', () => {
    const { r } = base;
    console.log('       level0Evals=' + r.stats.level0Evals + ' waves=' + r.stats.level0Waves + ' inner2Calls=' + r.stats.inner2Calls + ' inner2Evals=' + r.stats.inner2Evals +
      ' (~' + Math.round(r.stats.level0Waves * 90 / 60) + ' min L0 wall @90s/round + ' + Math.round(r.stats.inner2Calls * 11) + ' min INNER-2)');
    console.log('       by phase: ' + JSON.stringify(r.stats.byPhase) + ' segments traced: ' + Array.from(new Set(r.candidates.map(c => c.cd))).join(','));
    assert.ok(r.stats.level0Evals <= 1500, 'level0 evals ' + r.stats.level0Evals);
    assert.ok(r.stats.inner2Calls <= 24, 'inner2 calls ' + r.stats.inner2Calls);
    assert.strictEqual(r.stats.level0Evals, base.w.counts.level0);
  });
  await t('T=4.820 hard step: highT sub-segment starts at Tn=4.820/q when the whole lowT sub-segment is infeasible', async () => {
    const w = makeWorld({ emaxPhys: 0.25, step: 0.25 });
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) });
    const hit = r.candidates.filter(c => c.sub === 'highT' && c.Tn === SPLIT);
    assert.ok(hit.length, 'no candidate at the step tick: ' + r.candidates.map(c => c.cd + c.sub + c.Tn).join(' '));
    assert.ok(hit.some(c => truthMinTn(w, c.cd, geo.subs(c.cd)[0], 52612, c.eTarget, tNeeded) === null), 'a segment whose whole lowT sub-segment is infeasible starts at the step tick');
    hit.forEach(c => assert.strictEqual(truthMinTn(w, c.cd, geo.subs(c.cd)[1], 52612, c.eTarget, tNeeded), SPLIT));
  });
  await t('G jump: segments are searched independently (each has its own min-T; A_eff window respected)', () => {
    const { r } = base;
    const cds = Array.from(new Set(r.candidates.map(c => c.cd))).sort((a, b) => a - b);
    assert.ok(cds.length >= 2, 'segments ' + cds);
    const aMin = Math.min(...r.candidates.map(c => c.A_eff));
    r.candidates.forEach(c => assert.ok(geo.pointA(c.cd, geo.segRange(c.cd).lo) <= aMin + cfg.guided.inner1.dAWindow + 0.3, 'segment outside the dA window: ' + c.cd));
    // two segments with (nearly) the same A_eff at the jump but different T, as in diag-gjump
    const a = geo.pointA(60, geo.segRange(60).hi), b = geo.pointA(61, geo.segRange(61).lo);
    assert.ok(Math.abs(a - b) < 1e-3 && geo.segRange(60).hi !== geo.segRange(61).lo);
  });
  await t('monotone region (no interior b*): only branch R exists there, L absent, no wandering', async () => {
    const w = makeWorld({ emaxPhys: 0.25, monoBelow: 14.0, monoB: -2.3 });
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) });
    assert.ok(r.best, r.reason);
    const mono = r.candidates.filter(c => w.u(c.cd, c.Tn, 52612) < 14.0);
    assert.ok(mono.length && mono.every(c => c.branch === 'R'), 'monotone-region candidates are R only: ' + mono.map(c => c.branch).join(','));
    assert.ok(r.candidates.some(c => c.branch === 'L'), 'L exists where b* is interior');
    r.candidates.forEach(c => { const dir = c.branch === 'R' ? 1 : -1; assert.ok(okAt(w, c.cd, c.Tn, c.bn, 52612, c.eTarget, tNeeded) && !okAt(w, c.cd, c.Tn, c.bn + dir, 52612, c.eTarget, tNeeded)); });
    r.candidates.forEach(c => assert.ok(c.bn >= -20000 && c.bn <= 25000));
  });

  console.log('inner1: lead-confounded failures, timing screen');
  await t('window-skipped (lead-confounded) at high E must NOT lower E_max (no E_fail, bracket stays, final uses E_ok*(1-safety))', async () => {
    const w = makeWorld({ emaxPhys: 0.5, confound: e => e > 0.2 });
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) });
    const L = r.learned.mecos[52612];
    ['R', 'L'].forEach(b => {
      assert.strictEqual(L[b].fails.length, 0, b + ' fails ' + L[b].fails); assert.ok(L[b].inconclusive.length > 0, b + ' inconclusive recorded');
      assert.strictEqual(r.brackets[b].eFail, null); assert.strictEqual(r.brackets[b].eOk, 0.171);
      assert.ok(Math.abs(r.eFinal[b] - 0.171 * 0.95) < 1e-12);
    });
    assert.ok(r.notes.some(n => /stalled/.test(n) && /NOT lowered/.test(n)));
    assert.ok(r.best && r.best.E <= 0.171 * 0.95 + 1e-9 && r.best.windowReached, 'final answer sits below the confounded region');
  });
  await t('window-skipped retries neighbouring ticks (never counted as E_fail)', async () => {
    const w = makeWorld({ emaxPhys: 0.5, confound: e => e > 0.2 });
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) });
    assert.ok(r.stats.retries > 0);
  });
  await t('timing pre-screen: coastEndTToApoS < tNeededS never reaches INNER-2; E limited by the screen, no false E_fail', async () => {
    const w = makeWorld({ emaxPhys: 0.9, leadK: 0.3 });                     // leadMax = 60 (1 - E/0.3): = 8 s at E = 0.26
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) });
    assert.ok(w.counts.fullCalls.length > 0);
    w.counts.fullCalls.forEach(c => assert.ok(c.leadMax >= tNeeded, 'INNER-2 was called at leadMax ' + c.leadMax));
    assert.ok(r.stats.timingScreened > 0, 'timing screen used');
    ['R', 'L'].forEach(b => { assert.strictEqual(r.learned.mecos[52612][b].fails.length, 0); assert.ok(r.brackets[b].eOk <= 0.2601 && r.brackets[b].eOk > 0.2, b + ' ' + r.brackets[b].eOk); });
    assert.ok(r.notes.some(n => /timing screen/.test(n)));
    assert.ok(r.best && r.best.leadMax >= tNeeded);
  });
  await t('INNER-2 timing-bound IS a conclusive failure (tNeeded too optimistic: screen off => E_fail set)', async () => {
    const w = makeWorld({ emaxPhys: 0.9, leadK: 0.3 });
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg), tNeededS: 3 });   // screen at 3 s, but burn needs ~5.9 s
    const L = r.learned.mecos[52612];
    assert.ok(L.R.fails.length > 0, 'timing-bound recorded');
    // truth: burn needs lead >= l0 = 5.4 + 0.5 E and cap = floor(leadMax/dt)-1 => timing-bound above E ~ 0.2723
    assert.ok(r.brackets.R.eOk <= 0.2725 && r.brackets.R.eFail > 0.2723, JSON.stringify(r.brackets.R));
  });

  console.log('inner1: MECO warm start, cache idempotence');
  await t('warm start across MECO: bracket reused (fewer INNER-2 calls), b* re-located (Level-0 evals at the new MECO)', async () => {
    const w = makeWorld({ emaxPhys: 0.25 });
    const learned = I1.newLearned(cfg);
    const r1 = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned });
    const l0before = w.counts.level0;
    const r2 = await I1.searchBoundary(w.ev, cfg, { meco: 53000 }, { learned });
    const wc = makeWorld({ emaxPhys: 0.25 });
    const rc = await I1.searchBoundary(wc.ev, cfg, { meco: 53000 }, { learned: I1.newLearned(cfg) });
    console.log('       inner2Calls: first MECO ' + r1.stats.inner2Calls + ', warm MECO ' + r2.stats.inner2Calls + ', cold same MECO ' + rc.stats.inner2Calls);
    const learnIters = s => s.byPhase['learn-R:exact'] || 0;
assert.ok(learnIters(r2.stats) <= learnIters(rc.stats), 'warm bracket saves learning iterations');
    assert.ok(w.counts.level0 - l0before > 0 && (w.counts.byMeco[53000] || 0) > 0, 'Level-0 probes at the new MECO (b* not reused)');
    assert.ok(r2.best && r2.best.meco === 53000);
    assert.ok(r2.stats.inner2Calls <= rc.stats.inner2Calls, 'warm start no more INNER-2 calls than cold');
  });
  await t('idempotence: second identical call does 0 new Level-0 and 0 new INNER-2 evals, same answer', async () => {
    const w = makeWorld({ emaxPhys: 0.25 });
    const L0 = I1.newLearned(cfg);
    const a = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: clone(L0) });
    const c0 = { l0: w.counts.level0, f: w.counts.full };
    const b = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: clone(L0) });
    assert.strictEqual(w.counts.level0, c0.l0, 'new level-0 evals'); assert.strictEqual(w.counts.full, c0.f, 'new full evals');
    assert.strictEqual(b.stats.level0Evals, 0); assert.strictEqual(b.stats.inner2Evals, 0);
    assert.strictEqual(a.best.id, b.best.id); assert.deepStrictEqual(a.ranked.map(x => x.id), b.ranked.map(x => x.id));
    assert.deepStrictEqual(a.brackets.R, b.brackets.R);
  });
  await t('idempotence with the UPDATED learned store: converged bracket => no learning iterations, still 0 new INNER-2 evals', async () => {
    const w = makeWorld({ emaxPhys: 0.25 });
    const learned = I1.newLearned(cfg);
    await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned });
    const f0 = w.counts.full;
    const b = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned });
    assert.strictEqual(w.counts.full, f0); assert.ok(!b.log.some(l => /^learn/.test(l)));
  });
  await t('learned-bounds persistence: signature mismatch (other margin / stack) is NOT reused', () => {
    const f = path.join(__dirname, 'learned-test.json'), L = I1.newLearned(cfg); I1.applyOutcome(L, 52612, 'R', 0.2, { kind: 'ok' }); I1.saveLearned(f, L);
    assert.strictEqual(I1.loadLearned(f, cfg).mecos[52612].R.oks[0], 0.2);
    const cfg2 = clone(cfg); cfg2.fixed.find(x => /MARGIN/.test(x.path)).value = 0.0001;
    assert.deepStrictEqual(I1.loadLearned(f, cfg2).mecos, {});
  });
  await t('Level-0 / Level-1 disagreement is a hard error (determinism check)', async () => {
    const w = makeWorld({ emaxPhys: 0.25 }); const orig = w.ev.evaluateMany;
    w.ev.evaluateMany = async (l, o) => { const rs = await orig(l, o); if (!(o && o.eval === 'coastEnd')) rs.forEach(r => { r.metrics.coastEndEcc *= 1.001; }); return rs; };
    await assert.rejects(() => I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg) }), /disagree/);
  });
  await t('no feasible point at all: reports E_min table, no silent expansion', async () => {
    const w = makeWorld({ emaxPhys: 0.25 }); w.W.leadK = 0.6;
    const r = await I1.searchBoundary(w.ev, cfg, { meco: 52612 }, { learned: I1.newLearned(cfg), tNeededS: 59 });   // leadMax >= 59 s only at E ~ 0.01
    assert.ok(Array.isArray(r.eMinTable) && r.eMinTable.length > 0);
    assert.ok(r.best === null ? /no feasible|inconclusive/.test(r.reason) : r.best.E <= 0.011);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
