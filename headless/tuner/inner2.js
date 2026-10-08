// ============================================================================
// headless/tuner/inner2.js — INNER-2: circ trigger lead for a GIVEN (A, bias).
//
//   const { tuneLead } = require('./inner2');
//   const r = await tuneLead(ev, cfg, { A, bias, meco, lead /*optional start*/ }, opts);
//   r = { status: 'converged'|'timing-bound'|'physics-bound', detail, lead, leadTicks, metrics,
//         leadMaxS, capTicks, evals, rounds, phase, anomalies[], samples[], log[] }
//
// Subroutine of INNER-1 (INNER-1 calls it for every candidate (A, bias)); also usable standalone.
// Uses FULL evals (margin / vrMin / vrEnd exist only after the circ burn) with stride 1 so the
// coastEnd capture (-> lead_max) is tick-exact.
//
// Model (all in integer lead ticks, 1 tick = 1/80 s):
//   * lead_max = t_to_apogee at COAST_WAIT entry (metrics.coastEndTToApoS). A larger lead triggers the
//     burn at COAST_WAIT entry and changes nothing => cap = floor(lead_max/dt) - 1 (and cfg upper bound).
//   * signed margin sm = circEndMarginS, unwrapped: a burn that ends PAST apogee reports margin ~ period
//     - small; that is sm = margin - period (negative). sm rises with lead (burn ends earlier).
//   * class of a sample (floor = min allowed vrMin of the current phase):
//       target  sm in [accLo, accHi], payload cleared, vrMin >= floor (vrEnd >= 0 implied by the past-apogee check)
//       high    sm > accHi, vrMin >= floor          (lead can still be reduced; need not be cleared)
//       low     sm < accLo | vrMin < floor | vrEnd < 0 (burn ended past apogee; sm meaningless) |
//               in-window but not cleared                     (lead too small)
//       invalid burn never started / never ended    (no information; skipped, never bracketed on)
//   * Bracket [lo, hi] = [largest low below hi, smallest high]. Each round evaluates up to `parallel`
//     evenly spaced interior ticks in ONE evaluateMany (k-section; parallel=1 is plain bisection), so
//     the worker pool does the work. Final rounds scan every interior tick => tiny non-monotone
//     wiggles inside the bracket cannot hide a target.
//   * Phase 1: vrMin >= 0 required. If the bracket collapses on a vr-negative lo and
//     inner2.phase2AllowNegativeVr, Phase 2 re-classifies the SAME cached samples with
//     floor = hardFloor and continues. Phase 3 = stop as soon as a target sample exists.
//
// Status semantics:
//   converged     target hit (detail 'in-window'), or bracket collapsed with the window skipped by a jump
//                 (detail 'window-skipped': lead = smallest 'high' tick, margin slightly above accHi), or
//                 lead reached 0 with margin still high (detail 'lead-floor')
//   timing-bound  even lead at cap (~lead_max) is still on the LOW side: this (A, bias) has too little
//                 time to apogee at COAST_WAIT entry for a successful burn (E too high) - not fixable by lead
//   physics-bound the lo side of the collapsed bracket is vrMin < hardFloor (can't shorten margin further),
//                 or no sample ever produced a finished burn (detail 'no-valid-burn')
// NOTE on reading the spec: "timing-bound = lead at lead_max - eps AND margin still > target" is
// interpreted as "still not good enough at lead_max" (low side), because margin RISES with lead.
// ============================================================================
'use strict';

const DT = 1 / 80;
const hasNum = x => typeof x === 'number' && Number.isFinite(x);

function params(cfg, opts) {
  const g = (cfg.guided && cfg.guided.inner2) || {};
  const vc = (cfg.scoring && cfg.scoring.hardConstraints && cfg.scoring.hardConstraints.circMinRadialVelocityMps) || {};
  const tL = cfg.tunables.find(t => t.id === 'circ_trigger_lead') || {};
  const accept = (opts.marginAcceptS || g.marginAcceptS || [4, 5]);
  const steps = opts.leadSteps || g.leadSteps || [1, 0.5, 0.1, 0.05, 0.01];
  return {
    accLo: accept[0], accHi: accept[1],
    hardFloor: hasNum(opts.hardFloor) ? opts.hardFloor : (hasNum(vc.hardFloor) ? vc.hardFloor : -2),
    phase2: opts.phase2AllowNegativeVr !== undefined ? !!opts.phase2AllowNegativeVr : g.phase2AllowNegativeVr !== false,
    expandTicks: Math.max(1, Math.round(steps[0] / DT)),
    upperTicks: Math.floor((hasNum(tL.upper) ? tL.upper : 20) / DT),
    startLead: hasNum(opts.startLead) ? opts.startLead : 5.525,
    maxRounds: opts.maxRounds || 60, maxEvals: opts.maxEvals || 400,
    evalOpts: Object.assign({ stride: 1 }, opts.evalOpts || {}),
    wrapPeriodS: opts.wrapPeriodS
  };
}

// ---- classification (pure; exported for tests) -------------------------------
function signedMargin(m, wrapPeriodS) {
  const mg = m.circEndMarginS;
  const P = hasNum(wrapPeriodS) ? wrapPeriodS : (hasNum(m.coastEndPeriodS) ? m.coastEndPeriodS : 5400);
  return mg > 0.5 * P ? mg - P : mg;
}

function classify(m, P, floor) {
  if (!m.circBurnStarted) return { cls: 'invalid', cause: 'no-burn-start' };
  if (!m.circBurnEnded || !hasNum(m.circEndMarginS)) return { cls: 'invalid', cause: 'no-burn-end' };
  const sm = signedMargin(m, P.wrapPeriodS);
  const vrMin = hasNum(m.circMinVr) ? m.circMinVr : 0;
  if (vrMin < floor) return { cls: 'low', cause: floor <= P.hardFloor ? 'vr-hardfloor' : 'vr-negative', sm };
  // vrEnd < 0 => the burn ENDED while descending (past apogee): lead too small. The margin value of such a
  // failed burn (e.g. 947 s with payload never cleared) is physically meaningless, so it must never count as
  // 'high' (real run, A13.94/b0.59: leads 3.7-4.5 s gave sm ~950-1040 s, vrEnd<0, cleared=false).
  // (strict sign check with a tiny numerical tolerance; NO magnitude threshold: vrEnd tick-slope is scale dependent)
  if (hasNum(m.circVrAtEnd) && m.circVrAtEnd < -1e-10) return { cls: 'low', cause: 'past-apogee', sm };
  if (sm < P.accLo) return { cls: 'low', cause: 'margin-low', sm };
  if (sm <= P.accHi) {
    if (!m.payloadCleared) return { cls: 'low', cause: 'not-cleared', sm };
    return { cls: 'target', cause: 'in-window', sm };
  }
  return { cls: 'high', cause: 'margin-high', sm };
}

// ---- main --------------------------------------------------------------------
async function tuneLead(ev, cfg, point, opts) {
  opts = opts || {};
  const P = params(cfg, opts);
  const par = Math.max(1, Math.floor(opts.parallel || ev.workers || (cfg.evaluator && cfg.evaluator.parallelWorkers) || 4));
  const samples = new Map();       // tick -> { n, lead, m }
  const log = [], anomalies = [];
  let evals = 0, rounds = 0, leadMaxS = null, capTicks = P.upperTicks;
  const say = s => log.push(s);

  async function evalTicks(ns) {
    ns = Array.from(new Set(ns.map(n => Math.max(0, Math.min(capTicks, n))))).filter(n => !samples.has(n)).sort((a, b) => a - b);
    if (!ns.length) return 0;
    if (evals + ns.length > P.maxEvals) throw new Error('inner2: maxEvals ' + P.maxEvals + ' exceeded');
    const list = ns.map(n => ({
      ascent_profile_constant: point.A, stage_burn_aoa_bias: point.bias,
      meco_target_booster_fuel: point.meco, circ_trigger_lead: n * DT
    }));
    const rs = await ev.evaluateMany(list, P.evalOpts);
    rs.forEach((r, i) => {
      samples.set(ns[i], { n: ns[i], lead: ns[i] * DT, m: r.metrics });
      if (!r.cached) evals++;
    });
    rounds++;
    say('round ' + rounds + ': ' + ns.map(n => n + 't').join(' '));
    return ns.length;
  }

  // ---- first eval: also yields lead_max ----
  const n0 = Math.max(0, Math.min(P.upperTicks, Math.round(P.startLead / DT)));
  await evalTicks([n0]);
  const m0 = samples.get(n0).m;
  if (hasNum(m0.coastEndTToApoS)) {
    leadMaxS = m0.coastEndTToApoS;
    capTicks = Math.max(0, Math.min(P.upperTicks, Math.floor(leadMaxS / DT) - 1));
    say('lead_max (t_to_apogee at COAST_WAIT entry) = ' + leadMaxS.toFixed(3) + ' s -> cap ' + capTicks + ' ticks');
  } else say('WARNING: no coastEndTToApoS (coast end not reached?) - cap = config upper');
  if (n0 > capTicks) { say('start lead above cap: evaluating cap instead'); await evalTicks([capTicks]); }

  const result = (status, detail, n, extra) => {
    const s = samples.get(n);
    const fl = phase === 1 ? 0 : P.hardFloor;                  // classify samples with the FINAL phase's floor
    const sc = s ? classify(s.m, P, fl) : null;
    const achieved = sc && sc.sm !== undefined ? sc.sm : null;
    const windowReached = detail === 'in-window';
    let summary = status + '/' + detail + ': lead ' + (s ? s.lead.toFixed(4) : '--') + ' s';
    if (achieved !== null) summary += ', margin ' + achieved.toFixed(2) + ' s';
    if (!windowReached && status !== 'timing-bound' && achieved !== null)
      summary += ' -- margin window [' + P.accLo + ',' + P.accHi + '] NOT reachable at this (A, bias); smallest achievable margin = ' +
        achieved.toFixed(2) + ' s (INNER-1 must move (A, bias))';
    if (status === 'timing-bound') summary += ' -- lead at cap (' + (leadMaxS === null ? '?' : leadMaxS.toFixed(2)) + ' s t_to_apogee) still too small';
    return Object.assign({
      status, detail, lead: s ? s.lead : null, leadTicks: s ? n : null, metrics: s ? s.m : null,
      windowReached, achievedMarginS: achieved, summary,
      leadMaxS, capTicks, evals, rounds, anomalies, log,
      samples: Array.from(samples.values()).sort((a, b) => a.n - b.n).map(x => {
        const c = classify(x.m, P, fl);
        return { n: x.n, lead: x.lead, sm: c.sm === undefined ? null : c.sm, vrMin: x.m.circMinVr, vrEnd: x.m.circVrAtEnd, cleared: x.m.payloadCleared, cls: c.cls, cause: c.cause };
      })
    }, extra || {});
  };

  let expandUp = 0, expandDown = 0, phase = 1;

  while (true) {
    const floor = phase === 1 ? 0 : P.hardFloor;
    if (rounds > P.maxRounds) throw new Error('inner2: maxRounds exceeded');
    const sorted = Array.from(samples.values()).sort((a, b) => a.n - b.n)
      .map(s => Object.assign({ n: s.n }, classify(s.m, P, floor)));
    const targets = sorted.filter(s => s.cls === 'target');
    if (targets.length) { say('target hit at ' + targets[0].n + ' ticks (sm ' + targets[0].sm.toFixed(3) + ')'); return result('converged', 'in-window', targets[0].n, { phase }); }

    const hi = sorted.find(s => s.cls === 'high');
    const lows = sorted.filter(s => s.cls === 'low');
    const lo = hi ? lows.filter(s => s.n < hi.n).pop() : lows[lows.length - 1];
    if (hi) {                                   // non-monotone: a 'low' ABOVE the smallest 'high'
      const bad = lows.filter(s => s.n > hi.n);
      bad.forEach(b => { const key = hi.n + '<' + b.n; if (!anomalies.some(a => a.key === key)) { anomalies.push({ key, type: 'non-monotone', highTick: hi.n, lowTickAbove: b.n, cause: b.cause }); say('ANOMALY non-monotone: low@' + b.n + ' above high@' + hi.n); } });
    }

    if (!hi && !lo) {                           // nothing classifiable: acquisition scan over [0, cap]
      const pts = []; for (let i = 0; i < par; i++) pts.push(Math.round(capTicks * (i + 1) / par));
      pts.push(0);
      const added = await evalTicks(pts);
      if (!added) { say('no classifiable sample anywhere'); return result('physics-bound', 'no-valid-burn', n0, { phase }); }
      continue;
    }
    if (!hi) {                                  // only low: go UP
      if (lo.n >= capTicks) {
        if (phase === 1 && P.phase2 && lo.cause === 'vr-negative') { phase = 2; say('-> phase 2 (every phase-1 sample was vr-negative; allow down to ' + P.hardFloor + ')'); continue; }
        say('lead at cap still low (' + lo.cause + ') -> timing-bound');
        return result('timing-bound', lo.cause, lo.n, { phase });
      }
      const step = P.expandTicks * Math.pow(2, expandUp++);
      const pts = []; for (let j = 1; j <= par; j++) pts.push(Math.min(capTicks, lo.n + j * step));
      await evalTicks(pts);
      continue;
    }
    if (!lo) {                                  // only high: go DOWN
      if (hi.n <= 0) return result('converged', 'lead-floor', 0, { phase });
      const step = P.expandTicks * Math.pow(2, expandDown++);
      const pts = []; for (let j = 1; j <= par; j++) pts.push(Math.max(0, hi.n - j * step));
      if (!pts.some(n => !samples.has(n))) return result('converged', 'lead-floor', hi.n, { phase });
      await evalTicks(pts);
      continue;
    }
    // bracket [lo.n, hi.n]
    const interior = []; for (let n = lo.n + 1; n < hi.n; n++) if (!samples.has(n)) interior.push(n);
    if (interior.length === 0) {
      say('bracket collapsed [' + lo.n + ',' + hi.n + '] lo cause: ' + lo.cause);
      if (lo.cause === 'vr-negative' && phase === 1 && P.phase2) { phase = 2; say('-> phase 2 (negative vr allowed down to ' + P.hardFloor + ')'); continue; }
      if (lo.cause === 'vr-negative' || lo.cause === 'vr-hardfloor') return result('physics-bound', lo.cause, hi.n, { phase, lo: lo.n });
      if (hi.sm > P.accHi + 3) {                // a jump this large is suspicious (or a non-monotone region fooled the bracket)
        anomalies.push({ key: 'skip' + hi.n, type: 'large-skip', highTick: hi.n, sm: hi.sm, lowTick: lo.n, loCause: lo.cause });
        say('ANOMALY large skip: chosen high has sm ' + hi.sm.toFixed(2) + ' s (window ' + P.accLo + '-' + P.accHi + ') - check for non-monotone margin(lead)');
      }
      return result('converged', 'window-skipped', hi.n, { phase, lo: lo.n, loCause: lo.cause });
    }
    let pick;
    if (interior.length <= par) pick = interior;
    else { pick = []; for (let i = 1; i <= par; i++) pick.push(interior[Math.min(interior.length - 1, Math.floor(interior.length * i / (par + 1)))]); }
    await evalTicks(pick);
  }
}

module.exports = { tuneLead, classify, signedMargin, params, DT };
