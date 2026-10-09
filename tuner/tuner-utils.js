// ============================================================================
// tuner-utils.js — lattice snap, (G,T) collapse, applied-value verification,
// scoring. Pure functions (no sim access) except verifyApplied(), which takes
// the cfg object returned by Guidance.getGuideConfig().
//
// A lattice POINT is integers only:  { Gi, Tn, bi, li, meco }
//   Gi   = G / 0.01          (gimbal quanta)
//   Tn   = T / 0.000125      (fine-grid T)
//   bi   = bias / 0.0001
//   li   = lead / 0.0125     (sim ticks)
//   meco = kg (integer)
// A = G*T^2 is DERIVED (A_eff), for reporting only. Search runs on (Gi, Tn).
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const C = () => root.TunerConfig;

  const clean = (x, dp) => Number(x.toFixed(dp));

  // ---- index <-> value ------------------------------------------------------
  const gOf    = (Gi) => clean(Gi * C().quanta.G, 2);
  const tOf    = (Tn) => clean(Tn * C().quanta.T, 6);
  const biasOf = (bi) => clean(bi * C().quanta.bias, 4);
  const leadOf = (li) => clean(li * C().quanta.lead, 4);

  // ---- raw -> lattice (every candidate goes through here) -------------------
  const snapG    = (g) => Math.round(g / C().quanta.G);
  const snapT    = (t) => Math.round(t / C().quanta.T);
  const snapBias = (b) => Math.round(Math.round(b * 1e6) / (C().quanta.bias * 1e6));
  const snapLead = (l) => Math.round(l / C().quanta.lead);
  const snapMeco = (m) => Math.round(m);

  // A -> (G, T) collapse (prompt-web 3.2). Anchor T0 for G_raw.
  function collapseA(A) {
    const q = C().quanta, T0 = C().T0;
    const Gi = Math.round((A / (T0 * T0)) / q.G);
    const G = gOf(Gi);
    const Tn = Math.round(Math.sqrt(A / G) / q.T);
    return { Gi, Tn };
  }
  const aEff = (p) => gOf(p.Gi) * Math.pow(tOf(p.Tn), 2);

  // raw = { A | (G,T), bias, lead, meco } -> lattice point
  function fromRaw(raw) {
    let Gi, Tn;
    if (raw.A != null && raw.G == null) ({ Gi, Tn } = collapseA(raw.A));
    else { Gi = snapG(raw.G); Tn = snapT(raw.T != null ? raw.T : C().T0); }
    return { Gi, Tn, bi: snapBias(raw.bias), li: snapLead(raw.lead), meco: snapMeco(raw.meco) };
  }

  // relative move on the lattice (pure). d = { dGi, dTn, dbi, dli, dmeco }
  function step(p, d) {
    return {
      Gi: p.Gi + (d.dGi || 0), Tn: p.Tn + (d.dTn || 0),
      bi: p.bi + (d.dbi || 0), li: p.li + (d.dli || 0),
      meco: p.meco + (d.dmeco || 0),
    };
  }

  const key = (p) => p.Gi + '|' + p.Tn + '|' + p.bi + '|' + p.li + '|' + p.meco;

  function inBounds(p) {
    const b = C().bounds, A = aEff(p), bias = biasOf(p.bi), lead = leadOf(p.li);
    return A >= b.A.lower && A <= b.A.upper &&
      bias >= b.bias.lower && bias <= b.bias.upper &&
      lead >= b.lead.lower && lead <= b.lead.upper &&
      p.meco >= b.meco.lower && p.meco <= b.meco.upper;
  }

  // lattice point -> the full config object for Guidance.applyGuideConfig.
  // Always the COMPLETE tunable + fixed set (_v3Config persists between runs).
  function toValues(p, opts) {
    opts = opts || {};
    const f = C().fixed;
    return {
      ascent: {
        PUSH_MAX_GIMBAL_DEG: gOf(p.Gi),
        PUSH_T_S: tOf(p.Tn),
        MECO_TARGET_BOOSTER_FUEL_KG: p.meco,
      },
      insertion: {
        TARGET_ORBIT_ALT_KM: opts.targetAltKm != null ? opts.targetAltKm : f.targetAltKm,
        STAGE_BURN_AOA_BIAS_DEG: biasOf(p.bi),
        STAGE_BURN_AOA_MARGIN_DEG: f.margin,
        CIRC_TRIGGER_LEAD_S: leadOf(p.li),
      },
      done: { DEORBIT_ENABLED: f.deorbitEnabled },
    };
  }

  // Readable summary for logs / result blocks.
  function describe(p) {
    return {
      G: gOf(p.Gi), T: tOf(p.Tn), A_eff: Number(aEff(p).toFixed(5)),
      bias: biasOf(p.bi), lead: leadOf(p.li), leadTicks: p.li, meco: p.meco,
    };
  }

  // Check that the sim really holds the snapped values (prompt-web 3.4).
  // cfg = Guidance.getGuideConfig(guideName). Exact match expected.
  function verifyApplied(p, cfg, opts) {
    const want = toValues(p, opts), bad = [];
    const chk = (path, w, g) => {
      if (!(typeof g === 'number' && Math.abs(g - w) <= 1e-9)) bad.push({ path, want: w, got: g });
    };
    Object.keys(want).forEach((sec) => Object.keys(want[sec]).forEach((k) => {
      const w = want[sec][k], g = cfg && cfg[sec] ? cfg[sec][k] : undefined;
      if (typeof w === 'boolean') { if (g !== w) bad.push({ path: sec + '.' + k, want: w, got: g }); }
      else chk(sec + '.' + k, w, g);
    }));
    return { ok: bad.length === 0, mismatches: bad };
  }

  // ---- eval cache (lattice-point keyed) -------------------------------------
  // stopAt is part of the key: a truncated eval is not a full eval.
  class EvalCache {
    constructor() { this.m = new Map(); this.hits = 0; this.misses = 0; }
    get(p, stopAt) {
      const v = this.m.get(key(p) + '#' + stopAt);
      if (v) this.hits++; else this.misses++;
      return v;
    }
    set(p, stopAt, result) { this.m.set(key(p) + '#' + stopAt, result); }
    clear() { this.m.clear(); this.hits = this.misses = 0; }
  }

  // ---- hard constraints + score ---------------------------------------------
  // metrics fields (filled by tuner-hook.js, Step 3):
  //   crashed, payloadReleased, payloadCleared, vrEnd, vrMin, maxQKPa, maxG,
  //   apogeeKm, perigeeKm, ecc, boosterFuelLeftKg, deployTimeS
  function checkHard(m) {
    const L = C().limits, reasons = [];
    let depth = 0;
    const add = (r, d) => { reasons.push(r); depth += d; };
    if (m.crashed) add('crashed', 100);
    if (!m.payloadReleased || !m.payloadCleared) add('payload_not_cleared', 50);
    if (![m.apogeeKm, m.perigeeKm, m.ecc].every(Number.isFinite)) add('no_final_orbit', 50);
    if (Number.isFinite(m.vrEnd) && m.vrEnd < L.vrEndMinMps) add('vrEnd_negative', 10 + (L.vrEndMinMps - m.vrEnd));
    if (Number.isFinite(m.vrMin) && m.vrMin < L.vrMinHardFloorMps) add('vrMin_below_floor', 10 + (L.vrMinHardFloorMps - m.vrMin));
    if (Number.isFinite(m.maxQKPa) && m.maxQKPa > L.maxQKPa) add('maxQ', 100 * (m.maxQKPa / L.maxQKPa - 1));
    if (Number.isFinite(m.maxG) && m.maxG > L.maxG) add('maxG', 100 * (m.maxG / L.maxG - 1));
    return { ok: reasons.length === 0, reasons, depth };
  }

  const deadzone = (x, target, tol, scale, w) =>
    w * Math.max(0, Math.abs(x - target) - tol) / scale;

  // opts: { targetAltKm }. Returns { score, ok, reasons, parts }.
  function score(m, opts) {
    const S = C().scoring, L = C().limits;
    const alt = opts && opts.targetAltKm != null ? opts.targetAltKm : C().fixed.targetAltKm;
    const hard = checkHard(m);
    if (!hard.ok) {
      return { score: S.failPenalty + hard.depth * 1000, ok: false, reasons: hard.reasons, parts: null };
    }
    const parts = {
      apogee:  deadzone(m.apogeeKm,  alt, S.apogeeErrKm.tol,  S.apogeeErrKm.scale,  S.apogeeErrKm.weight),
      perigee: deadzone(m.perigeeKm, alt, S.perigeeErrKm.tol, S.perigeeErrKm.scale, S.perigeeErrKm.weight),
      ecc:     deadzone(m.ecc, S.eccentricity.target, S.eccentricity.tol, S.eccentricity.scale, S.eccentricity.weight),
      fuel:    -S.boosterFuelLeftKgWeight * (m.boosterFuelLeftKg || 0),
      time:    S.timeToDeploySWeight * (m.deployTimeS || 0),
      vrSoft:  0.01 * Math.max(0, (0 - (Number.isFinite(m.vrMin) ? m.vrMin : 0))), // tie-breaker only
    };
    const total = parts.apogee + parts.perigee + parts.ecc + parts.fuel + parts.time + parts.vrSoft;
    return { score: total, ok: true, reasons: [], parts };
  }

  // ---- self-tests (run in browser via button, and in node) -------------------
  function runSelfTests() {
    const out = [], fails = [];
    const t = (name, cond, info) => { out.push((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fails.push(name); };

    // 1. baseline raw -> lattice
    const bp = fromRaw(C().baselineRaw);
    t('baseline snap G=0.60', gOf(bp.Gi) === 0.6);
    t('baseline snap T=4.82', tOf(bp.Tn) === 4.82);
    t('baseline snap bias=0.59', biasOf(bp.bi) === 0.59);
    t('baseline snap lead=5.525 (442 ticks)', leadOf(bp.li) === 5.525 && bp.li === 442);
    t('baseline A_eff ~13.94', Math.abs(aEff(bp) - 13.94) < 1e-3, 'A_eff=' + aEff(bp).toFixed(5));

    // 2. idempotence: snapping an already-snapped value changes nothing
    let idem = true;
    for (let i = 0; i < 2000; i++) {
      const raw = { G: 0.3 + Math.random() * 0.7, T: 4.0 + Math.random() * 2, bias: -2 + Math.random() * 4.5,
                    lead: Math.random() * 20, meco: 20000 + Math.random() * 90000 };
      const p = fromRaw(raw), v = toValues(p);
      const p2 = fromRaw({ G: v.ascent.PUSH_MAX_GIMBAL_DEG, T: v.ascent.PUSH_T_S,
        bias: v.insertion.STAGE_BURN_AOA_BIAS_DEG, lead: v.insertion.CIRC_TRIGGER_LEAD_S,
        meco: v.ascent.MECO_TARGET_BOOSTER_FUEL_KG });
      if (key(p) !== key(p2)) { idem = false; break; }
    }
    t('snap idempotent (2000 random)', idem);

    // 3. every emitted value is exactly on its lattice
    let onLat = true;
    for (let i = 0; i < 2000; i++) {
      const p = fromRaw({ G: 0.3 + Math.random(), T: 4 + Math.random() * 2, bias: -2 + Math.random() * 4.5,
                          lead: Math.random() * 20, meco: 20000 + Math.random() * 90000 });
      const v = toValues(p);
      const q = C().quanta;
      const chk = (x, qq) => Math.abs(x / qq - Math.round(x / qq)) < 1e-6;
      if (!(chk(v.ascent.PUSH_MAX_GIMBAL_DEG, q.G) && chk(v.ascent.PUSH_T_S, q.T) &&
            chk(v.insertion.STAGE_BURN_AOA_BIAS_DEG, q.bias) && chk(v.insertion.CIRC_TRIGGER_LEAD_S, q.lead) &&
            Number.isInteger(v.ascent.MECO_TARGET_BOOSTER_FUEL_KG))) { onLat = false; break; }
    }
    t('emitted values on lattice (2000 random)', onLat);

    // 4. A collapse: A -> (G,T) -> A_eff close to A, sawtooth step ~ T^2*0.01
    const c1 = collapseA(13.93944);
    t('collapse A=13.93944 -> G=0.60, T=4.82', gOf(c1.Gi) === 0.6 && tOf(c1.Tn) === 4.82);
    let maxErr = 0;
    for (let A = 10; A <= 19; A += 0.037) {
      const c = collapseA(A); const e = Math.abs(aEff(c) - A); if (e > maxErr) maxErr = e;
    }
    t('collapse |A_eff - A| small (<0.12)', maxErr < 0.12, 'max=' + maxErr.toFixed(4));
    const stepA = aEff(step(bp, { dGi: 1 })) - aEff(bp);
    t('1 gimbal step ~ 0.232 in A', Math.abs(stepA - 0.2323) < 0.01, 'dA=' + stepA.toFixed(4));

    // 5. redundant (G,T) pairs exist (same A_eff band, different physics)
    const a = fromRaw({ G: 0.60, T: 4.82, bias: 0.59, lead: 5.5, meco: 52612 });
    const b = step(a, { dGi: -1, dTn: Math.round((Math.sqrt(aEff(a) / gOf(a.Gi - 1)) - tOf(a.Tn)) / C().quanta.T) });
    t('redundant pair: different key, A_eff within 1 Tn quantum', key(a) !== key(b) &&
      Math.abs(aEff(a) - aEff(b)) < 2 * 2 * tOf(a.Tn) * C().quanta.T + 1e-9, 'dA=' + (aEff(b) - aEff(a)).toExponential(2));

    // 6. verifyApplied
    const cfgOk = JSON.parse(JSON.stringify(toValues(bp)));
    t('verifyApplied ok', verifyApplied(bp, cfgOk).ok);
    const cfgBad = JSON.parse(JSON.stringify(cfgOk)); cfgBad.insertion.CIRC_TRIGGER_LEAD_S = 5.53;
    const vb = verifyApplied(bp, cfgBad);
    t('verifyApplied catches off-lattice lead', !vb.ok && vb.mismatches[0].path === 'insertion.CIRC_TRIGGER_LEAD_S');

    // 7. toValues carries the whole fixed set
    const v = toValues(bp, { targetAltKm: 320 });
    t('toValues has margin 0.001 + deorbit false', v.insertion.STAGE_BURN_AOA_MARGIN_DEG === 0.001 &&
      v.done.DEORBIT_ENABLED === false && v.insertion.TARGET_ORBIT_ALT_KM === 320);

    // 8. bounds
    t('baseline in bounds', inBounds(bp));
    t('bias -3 out of bounds', !inBounds(step(bp, { dbi: Math.round((-3 - 0.59) / C().quanta.bias) })));

    // 9. scoring: hierarchy orbit > fuel > time, fail > any pass
    const good = { crashed: false, payloadReleased: true, payloadCleared: true, vrEnd: 0.03, vrMin: -0.3,
      maxQKPa: 24.8, maxG: 4.8, apogeeKm: 320.1, perigeeKm: 320.0, ecc: 1e-5, boosterFuelLeftKg: 2000, deployTimeS: 590 };
    const s0 = score(good).score;
    const orbitWorse = score(Object.assign({}, good, { apogeeKm: 320 + 1 + 0.05 })).score - s0;   // 0.05 km beyond tol
    const fuelWorse  = score(Object.assign({}, good, { boosterFuelLeftKg: 2000 - 5000 })).score - s0; // 5000 kg less
    const fuel10     = score(Object.assign({}, good, { boosterFuelLeftKg: 1990 })).score - s0;     // 10 kg less
    const timeWorse  = score(Object.assign({}, good, { deployTimeS: 690 })).score - s0;           // +100 s
    t('hierarchy: orbit(0.05 km over tol) > fuel(5000 kg)', orbitWorse > fuelWorse, orbitWorse.toFixed(2) + ' > ' + fuelWorse.toFixed(2));
    t('hierarchy: fuel(10 kg) > time(100 s)', fuel10 > timeWorse, fuel10.toFixed(3) + ' > ' + timeWorse.toFixed(3));
    t('inside tolerance => orbit term 0', score(good).parts.apogee === 0 && score(good).parts.ecc === 0);
    const crashed = score(Object.assign({}, good, { crashed: true }));
    t('hard fail >> any pass', !crashed.ok && crashed.score > 1e6 && crashed.score > s0 + 1e5);
    const noVr = score(Object.assign({}, good, { vrEnd: -0.01 }));
    t('vrEnd<0 hard fail', !noVr.ok && noVr.reasons.includes('vrEnd_negative'));
    const worse = score(Object.assign({}, good, { maxQKPa: 40 })), worser = score(Object.assign({}, good, { maxQKPa: 60 }));
    t('graded depth: deeper fail scores higher', worser.score > worse.score);
    t('vrMin -0.38 only soft (still ok)', score(Object.assign({}, good, { vrMin: -0.38 })).ok);

    // 10. cache
    const cache = new EvalCache(); cache.set(bp, 'FULL', { x: 1 });
    t('cache hit/miss by stopAt', cache.get(bp, 'FULL') && !cache.get(bp, 'COAST_WAIT_ENTRY'));

    return { ok: fails.length === 0, lines: out, fails };
  }

  root.TunerUtils = {
    gOf, tOf, biasOf, leadOf, snapG, snapT, snapBias, snapLead, snapMeco,
    collapseA, aEff, fromRaw, step, key, inBounds, toValues, describe,
    verifyApplied, EvalCache, checkHard, score, runSelfTests,
  };
})();
