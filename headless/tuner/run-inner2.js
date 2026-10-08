const path = require('path');
const { createEvaluator, loadConfig } = require('./evaluator');
const { tuneLead } = require('./inner2');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

(async () => {
  const cfg = loadConfig(path.join(__dirname, 'tuner-config-v3.json'));
  const A = parseFloat(arg('A', '13.94'));
  const bias = parseFloat(arg('bias', '0.59'));
  const meco = parseFloat(arg('meco', '52612'));
  const startLead = parseFloat(arg('lead', '5.525'));
  const workers = parseInt(arg('workers', '6'), 10);
  const ev = createEvaluator(cfg, { workers });
  console.log('INNER-2: A=' + A + ' bias=' + bias + ' meco=' + meco + ' startLead=' + startLead + ' workers=' + workers);
  const t0 = Date.now();
  const r = await tuneLead(ev, cfg, { A, bias, meco }, { startLead, parallel: workers });
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('\nresult:', JSON.stringify({
    status: r.status, detail: r.detail,
    lead: r.lead, leadTicks: r.leadTicks, leadMaxS: r.leadMaxS, capTicks: r.capTicks,
    phase: r.phase, evals: r.evals, rounds: r.rounds, wallS: Number(wall),
    windowReached: r.windowReached, achievedMarginS: r.achievedMarginS,
    anomalies: r.anomalies
  }, null, 2));
  console.log('\nSUMMARY:', r.summary);
  if (r.metrics) {
    console.log('metrics:', JSON.stringify({
      margin: r.metrics.circEndMarginS, vrMin: r.metrics.circMinVr, vrEnd: r.metrics.circVrAtEnd,
      cleared: r.metrics.payloadCleared, deployS: r.metrics.timeToDeployS,
      residual: r.metrics.stageResidualKg, E: r.metrics.coastEndEcc,
      apo: r.metrics.apogeeKm, peri: r.metrics.perigeeKm
    }, null, 2));
  }
  console.log('\nsamples:'); r.samples.forEach(s => console.log(' ', JSON.stringify(s)));
  console.log('\nlog:'); r.log.forEach(l => console.log(' ', l));
  await ev.close();
})().catch(e => { console.error(e); process.exit(1); });