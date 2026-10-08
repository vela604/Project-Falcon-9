// node tuner/test-inner2.js   — offline: INNER-2 against synthetic lead->metrics models (no sim needed).
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { tuneLead, classify } = require('./inner2');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'tuner-config-v3.json'), 'utf8'));
const DT = 1 / 80;
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } }

// Mock evaluator. model(leadS) -> partial metrics. Counts every uncached eval.
function mockEv(model, workers) {
  const seen = new Set(); const ev = { workers: workers === undefined ? 6 : workers, calls: 0, rounds: 0 };
  ev.evaluateMany = async list => { ev.rounds++; return list.map(v => {
    const k = Math.round(v.circ_trigger_lead / DT); const cached = seen.has(k); seen.add(k); if (!cached) ev.calls++;
    const lead = k * DT, p = model(lead);
    const m = Object.assign({ circBurnStarted: true, circBurnEnded: true, payloadCleared: true, coastEndTToApoS: 40, coastEndPeriodS: 5400,
      circMinVr: 0.5, circVrAtEnd: 0.5 }, p);
    return { metrics: m, effective: { lead }, cached };
  }); };
  return ev;
}
const pt = { A: 14, bias: 0.6, meco: 52612 };
const lin = (l0, slope) => lead => ({ circEndMarginS: slope * (lead - l0) });   // margin = 0 at l0

(async () => {
  console.log('inner2: classification');
  const P = { accLo: 4, accHi: 5, hardFloor: -2 };
  const M = o => Object.assign({ circBurnStarted: true, circBurnEnded: true, payloadCleared: true, circEndMarginS: 4.5, circMinVr: 0.3, circVrAtEnd: 0.1, coastEndPeriodS: 5400 }, o);
  await t('target / high / low / invalid', () => {
    assert.strictEqual(classify(M({}), P, 0).cls, 'target');
    assert.strictEqual(classify(M({ circEndMarginS: 9 }), P, 0).cls, 'high');
    assert.strictEqual(classify(M({ circEndMarginS: 3 }), P, 0).cls, 'low');
    assert.strictEqual(classify(M({ circVrAtEnd: -0.01 }), P, 0).cause, 'past-apogee');
    assert.strictEqual(classify(M({ circVrAtEnd: 0 }), P, 0).cls, 'target', 'vrEnd = 0 is not past apogee');
    assert.strictEqual(classify(M({ circVrAtEnd: -1e-12 }), P, 0).cls, 'target', 'numerical noise below tolerance');
    assert.strictEqual(classify(M({ circBurnEnded: false }), P, 0).cls, 'invalid');
    assert.strictEqual(classify(M({ circEndMarginS: 126, payloadCleared: false }), P, 0).cls, 'high', 'not-cleared with big margin = lead too large');
  });
  await t('margin wrap (burn ended past apogee, margin ~ period) is LOW, vr floor depends on phase', () => {
    assert.strictEqual(classify(M({ circEndMarginS: 4843 }), P, 0).cls, 'low');
    const v = M({ circMinVr: -1 });
    assert.strictEqual(classify(v, P, 0).cause, 'vr-negative');
    assert.notStrictEqual(classify(M({ circMinVr: -1, circEndMarginS: 9 }), P, -2).cls, 'low');
    assert.strictEqual(classify(M({ circMinVr: -3 }), P, -2).cause, 'vr-hardfloor');
  });

  console.log('inner2: search');
  await t('smooth, start on LOW side: converges into [4,5] window, few rounds with 6 workers', async () => {
    const ev = mockEv(lin(5.0, 8));                   // sm in [4,5] <=> lead in [5.5, 5.625]
    const r = await tuneLead(ev, cfg, pt, { startLead: 5.0 });
    assert.strictEqual(r.status, 'converged'); assert.strictEqual(r.detail, 'in-window');
    assert.ok(r.metrics.circEndMarginS >= 4 && r.metrics.circEndMarginS <= 5, String(r.metrics.circEndMarginS));
    assert.ok(r.rounds <= 8, 'rounds ' + r.rounds + ' evals ' + r.evals);
  });
  await t('start on HIGH side (lead 12): descends', async () => {
    const r = await tuneLead(mockEv(lin(5.0, 8)), cfg, pt, { startLead: 12 });
    assert.strictEqual(r.status, 'converged'); assert.ok(r.lead < 6);
  });
  await t('bisection mode (parallel 1) also converges, same answer class', async () => {
    const r = await tuneLead(mockEv(lin(5.0, 8), 1), cfg, pt, { startLead: 9, parallel: 1 });
    assert.strictEqual(r.status, 'converged'); assert.strictEqual(r.detail, 'in-window');
  });
  await t('steep jump skips the window: converged / window-skipped at the smallest "high" tick', async () => {
    const jump = lead => ({ circEndMarginS: lead < 6.0 ? 2 : 14 });
    const r = await tuneLead(mockEv(jump), cfg, pt, { startLead: 8 });
    assert.strictEqual(r.status, 'converged'); assert.strictEqual(r.detail, 'window-skipped');
    assert.ok(r.lead >= 6.0 && r.lead < 6.0 + 1.5 * DT, 'lead ' + r.lead);
    assert.ok(r.metrics.circEndMarginS > 5);
  });
  await t('timing-bound: even lead at cap (t_to_apogee) is too small', async () => {
    const r = await tuneLead(mockEv(() => ({ circEndMarginS: 1, coastEndTToApoS: 7 })), cfg, pt, { startLead: 5.525 });
    assert.strictEqual(r.status, 'timing-bound');
    assert.ok(r.lead <= 7 - DT + 1e-9, 'never exceeds lead_max: ' + r.lead); assert.ok(r.leadMaxS === 7);
  });
  await t('lead never searched above t_to_apogee at COAST_WAIT entry', async () => {
    const seen = []; const ev = mockEv(l => { seen.push(l); return { circEndMarginS: 1, coastEndTToApoS: 9 }; });
    await tuneLead(ev, cfg, pt, {}); assert.ok(Math.max(...seen) < 9);
  });
  await t('physics-bound: lowering lead hits vrMin < hardFloor before margin reaches window', async () => {
    const m = lead => ({ circEndMarginS: 8 * (lead - 5), circMinVr: lead >= 6.4 ? 0.4 : (lead >= 6.2 ? -1 : -9) });  // margin 9.6 at 6.2.. window at ~5.6 unreachable
    const r = await tuneLead(mockEv(m), cfg, pt, { startLead: 8 });
    assert.strictEqual(r.status, 'physics-bound', JSON.stringify([r.status, r.detail, r.lead]));
  });
  await t('phase 2: negative vr (within hardFloor) allowed => reaches window that phase 1 cannot', async () => {
    const m = lead => ({ circEndMarginS: 8 * (lead - 5), circMinVr: lead >= 5.8 ? 0.4 : -0.5 });   // window at lead ~5.5-5.6 has vr -0.5
    const r1 = await tuneLead(mockEv(m), cfg, pt, { startLead: 8, phase2AllowNegativeVr: false });
    assert.notStrictEqual(r1.detail, 'in-window');
    const r2 = await tuneLead(mockEv(m), cfg, pt, { startLead: 8 });
    assert.strictEqual(r2.detail, 'in-window'); assert.strictEqual(r2.phase, 2);
  });
  await t('over-long burn (margin wraps ~period, vr very negative) at start => goes UP and finds window', async () => {
    const m = lead => lead >= 14.4 ? { circEndMarginS: 8 * (lead - 14) } : { circEndMarginS: 5300 + lead, circMinVr: -30 };
    const r = await tuneLead(mockEv(m), cfg, pt, { startLead: 5.525 });
    assert.strictEqual(r.status, 'converged'); assert.ok(r.lead > 14);
  });
  await t('invalid start (burn never ends) => acquisition scan finds valid region', async () => {
    const m = lead => lead < 9 ? { circBurnEnded: false, circEndMarginS: null } : { circEndMarginS: 6 * (lead - 8.5) };
    const r = await tuneLead(mockEv(m), cfg, pt, { startLead: 5.525 });
    assert.strictEqual(r.status, 'converged', JSON.stringify([r.status, r.detail]));
  });
  await t('nothing ever finishes a burn => physics-bound / no-valid-burn (terminates)', async () => {
    const r = await tuneLead(mockEv(() => ({ circBurnEnded: false, circEndMarginS: null })), cfg, pt, {});
    assert.strictEqual(r.status, 'physics-bound'); assert.strictEqual(r.detail, 'no-valid-burn');
  });
  await t('non-monotone wiggle above the bracket is recorded as anomaly (not silently ignored)', async () => {
    const m = lead => ({ circEndMarginS: lead > 7.3 && lead < 7.5 ? 2 : 8 * (lead - 5) });
    const r = await tuneLead(mockEv(m), cfg, pt, { startLead: 12, parallel: 6 });
    assert.strictEqual(r.status, 'converged');
    // a low-looking wiggle at 7.3-7.5 can capture the bracket => chosen 'high' is far above the window: must be flagged
    if (r.detail === 'window-skipped') assert.ok(r.anomalies.some(x => x.type === 'large-skip' || x.type === 'non-monotone'), JSON.stringify(r.anomalies));
  });
  await t('REAL-RUN SHAPE: failed burns (vrEnd<0, uncleared, sm~1000) below the transition must not be bracket endpoints', async () => {
    // mode A (lead < 5.4): burn ends past apogee, margin ~1000 s, cleared=false   (as measured at A13.94/b0.59)
    // mode B (lead >= 5.4): success, sm = 8 + 115*(lead-5.4), vrMin/vrEnd rising with lead
    const real = start => lead => lead < 5.4
      ? { circEndMarginS: 900 + 30 * lead, circMinVr: -1.5, circVrAtEnd: -0.8, payloadCleared: false, coastEndPeriodS: 5400 }
      : { circEndMarginS: start + 115 * (lead - 5.4), circMinVr: -0.34 + 1.5 * (lead - 5.4), circVrAtEnd: 0.08 + 0.7 * (lead - 5.4), payloadCleared: lead < 9 };
    const r = await tuneLead(mockEv(real(8)), cfg, pt, { startLead: 5.525 });
    assert.notStrictEqual(r.status, 'physics-bound', r.summary);
    assert.strictEqual(r.status, 'converged'); assert.strictEqual(r.detail, 'window-skipped'); assert.strictEqual(r.windowReached, false);
    assert.ok(r.lead >= 5.4 && r.lead < 5.4 + 2 * DT, 'lands on the transition: ' + r.lead);
    assert.ok(r.achievedMarginS >= 8 && r.achievedMarginS < 10, String(r.achievedMarginS));
    assert.ok(/NOT reachable/.test(r.summary) && /8\./.test(r.summary), r.summary);
    assert.ok(r.samples.filter(s => s.n * DT < 5.4).every(s => s.cls === 'low'), 'failed-burn samples are low, not high');
    assert.ok(r.evals < 40, 'evals ' + r.evals);
  });
  await t('REAL-RUN SHAPE, window reachable (success mode starts at margin 3): target found', async () => {
    const m = lead => lead < 5.4 ? { circEndMarginS: 950, circMinVr: -2, circVrAtEnd: -1, payloadCleared: false }
      : { circEndMarginS: 3 + 115 * (lead - 5.4), circMinVr: 0.1, circVrAtEnd: 0.2, payloadCleared: true };
    const r = await tuneLead(mockEv(m), cfg, pt, { startLead: 5.525 });
    assert.strictEqual(r.detail, 'in-window'); assert.ok(r.windowReached && r.achievedMarginS >= 4 && r.achievedMarginS <= 5);
  });
  await t('RUN CASE: vrEnd positive but small (0.0279), margin 4.010, cleared => target (no magnitude threshold on vrEnd)', () => {
    const c = classify(M({ circEndMarginS: 4.010, circVrAtEnd: 0.0279, circMinVr: -0.2 }), P, -2);
    assert.strictEqual(c.cls, 'target'); assert.strictEqual(c.cause, 'in-window');
  });
  await t('window reachable only with tiny vrEnd (<0.04): found as in-window (old buffer would have skipped it)', async () => {
    const m = lead => lead < 5.4 ? { circEndMarginS: 950, circMinVr: -2, circVrAtEnd: -1, payloadCleared: false }
      : { circEndMarginS: 4.3 + 60 * (lead - 5.4625), circMinVr: -0.3, circVrAtEnd: 0.0279 + 0.0083 * (lead - 5.4625) / DT, payloadCleared: true };
    const r = await tuneLead(mockEv(m), cfg, pt, { startLead: 5.525 });
    assert.strictEqual(r.detail, 'in-window'); assert.ok(r.windowReached);
    assert.ok(r.metrics.circVrAtEnd < 0.04 + 0.0083 * 20, 'vrEnd stays small');
  });
  await t('uncleared with LARGE positive margin and vrEnd>0 (lead too large, deploy past duration cap) is still a valid HIGH', async () => {
    assert.strictEqual(classify(M({ circEndMarginS: 235, payloadCleared: false, circVrAtEnd: 1.7, circMinVr: 1.4 }), P, 0).cls, 'high');
    assert.strictEqual(classify(M({ circEndMarginS: 947, payloadCleared: false, circVrAtEnd: -1.39, circMinVr: -1.99 }), P, -2).cls, 'low');
  });
  await t('result is deterministic & cache-friendly: second call does zero new evals through a caching evaluator', async () => {
    const ev = mockEv(lin(5.0, 8));
    const a = await tuneLead(ev, cfg, pt, { startLead: 7 }); const calls = ev.calls;
    const b = await tuneLead(ev, cfg, pt, { startLead: 7 });
    assert.strictEqual(ev.calls, calls); assert.strictEqual(a.leadTicks, b.leadTicks);
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
