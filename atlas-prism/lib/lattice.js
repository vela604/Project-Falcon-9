// ============================================================================
// lattice.js — lattice snap, (G,T) collapse, applied-value verification,
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
  // metrics fields (filled by hook.js, Step 3):
  //   crashed, payloadReleased, payloadCleared, vrEnd, vrMin, maxQKPa, maxG,
  //   apogeeKm, perigeeKm, ecc, boosterFuelLeftKg, deployTimeS
  // NOTE (Step Δv 1/4): coastDeltaV is intentionally NOT a hard constraint.
// Real reference points: 320 km baseline Δv=599, 2000 km manual Δv=925. Both fall
// outside limits.coastDeltaVguardMps=[700,900]. Making it hard-fail would reject
// every known-good manual point. Guard values remain in config for informational
// use by search algorithms (tuneAB) — not scoring.
function checkHard(m) {
  const L = C().limits, reasons = [];
  let depth = 0;
  const add = (r, d) => { reasons.push(r); depth += d; };
  if (m.crashed) add('crashed', 100);
if (m.endReason === 'CAP') add('duration_cap_hit', 80); // run hit durationCapS before payload clear
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

  // ---- orbit error: relative tolerance + pseudo-Huber penalty ----------------
  const curAlt = (alt) => (alt != null ? alt : C().fixed.targetAltKm);
  const orbitTolKm = (alt) => C().scoring.orbit.tolFrac * curAlt(alt);
  function orbitPenalty(errKm, alt) {
  const O = C().scoring.orbit, tol = orbitTolKm(alt);
  const e = Math.abs(errKm) / tol;                                     // NO deadzone: tol is only the reference scale
  return O.weight * O.k * (Math.sqrt(1 + (e / O.k) * (e / O.k)) - 1);
}
  // raw accuracy (sorting): |apo - alt| + |peri - alt|
const orbitErrKm = (m, alt) => Math.abs(m.apogeeKm - curAlt(alt)) + Math.abs(m.perigeeKm - curAlt(alt));

// Suggested durationCapS for a target altitude: 770 s at 320 km (baseline + 30%), +50% per 320 km above.
// Rough headroom only — real deploy time scales sublinearly. UI auto-fills, user can override.
function suggestDurationCap(altKm) {
  const a = curAlt(altKm);
  const v = 770 * (1 + 0.5 * (a - 320) / 320);
  return Math.ceil(v / 10) * 10;
}

  // opts: { targetAltKm }. Returns { score, ok, reasons, parts }.
  function score(m, opts) {
    const S = C().scoring, L = C().limits;
    const alt = opts && opts.targetAltKm != null ? opts.targetAltKm : C().fixed.targetAltKm;
    const hard = checkHard(m);
    if (!hard.ok) {
      return { score: S.failPenalty + hard.depth * 1000, ok: false, reasons: hard.reasons, parts: null };
    }
    const parts = {
      apogee:  orbitPenalty(m.apogeeKm - alt, alt),
      perigee: orbitPenalty(m.perigeeKm - alt, alt),
      ecc:     deadzone(m.ecc, S.eccentricity.target, S.eccentricity.tol, S.eccentricity.scale, S.eccentricity.weight),
      fuel:    -S.boosterFuelLeftKgWeight * (m.boosterFuelLeftKg || 0),
      time:    S.timeToDeploySWeight * (m.deployTimeS || 0),
      vrSoft:  0.01 * Math.max(0, (0 - (Number.isFinite(m.vrMin) ? m.vrMin : 0))), // tie-breaker only
    };
    const total = parts.apogee + parts.perigee + parts.ecc + parts.fuel + parts.time + parts.vrSoft;
    return { score: total, ok: true, reasons: [], parts };
  }

  // ---- leaderboard rows -------------------------------------------------------
  // extra: { E, targetAltKm, reject (bool: e.g. residual guard), reasons[] }
  const SORT_KEYS = ['score', 'accuracy', 'fuel', 'time'];
  function makeRow(src, tag, point, metrics, extra) {
    extra = extra || {};
    const m = metrics || {};
    const alt = curAlt(extra.targetAltKm);
    const sc = score(m, { targetAltKm: alt });
    const fin = (x) => (Number.isFinite(x) ? x : NaN);
    const reasons = (sc.reasons || []).concat(extra.reasons || []);
    return {
      src, tag, ok: sc.ok && !extra.reject, point, desc: describe(point), score: sc.score, parts: sc.parts,
  deltaV: fin(m.coastDeltaV),
      apoKm: fin(m.apogeeKm), periKm: fin(m.perigeeKm),
      apoErrKm: fin(m.apogeeKm - alt), periErrKm: fin(m.perigeeKm - alt),
      orbitErrKm: Number.isFinite(m.apogeeKm) && Number.isFinite(m.perigeeKm) ? orbitErrKm(m, alt) : NaN,
          ecc: fin(m.ecc), fuelKg: fin(m.boosterFuelLeftKg), deployS: fin(m.deployTimeS),
    residualKg: fin(m.stageResidualKg), reasons,
    metrics: m, extra,   // kept so the UI can re-score when weights change (no re-run)
  };
}

  // Multi-sort; failed rows always last; input not mutated; stable.
  function sortRows(rows, sortKey) {
    const inf = (x, d) => (Number.isFinite(x) ? x : d);
    const cmp = {
      score:    (a, b) => inf(a.score, Infinity) - inf(b.score, Infinity),
      accuracy: (a, b) => (inf(a.orbitErrKm, Infinity) - inf(b.orbitErrKm, Infinity)) ||
                          (inf(a.ecc, Infinity) - inf(b.ecc, Infinity)) || (inf(a.score, Infinity) - inf(b.score, Infinity)),
      fuel:     (a, b) => inf(b.fuelKg, -Infinity) - inf(a.fuelKg, -Infinity),
      time:     (a, b) => inf(a.deployS, Infinity) - inf(b.deployS, Infinity),
    };
    const f = cmp[sortKey || 'score'] || cmp.score;
    return rows.map((r, i) => ({ r, i })).sort((x, y) => {
      if (x.r.ok !== y.r.ok) return x.r.ok ? -1 : 1;
      const c = f(x.r, y.r);
      return (Number.isNaN(c) ? 0 : c) || (x.i - y.i);
    }).map((x) => x.r);
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
  maxQKPa: 24.8, maxG: 4.8, apogeeKm: 320.0, perigeeKm: 320.0, ecc: 1e-5, boosterFuelLeftKg: 2000, deployTimeS: 590 };
    const s0 = score(good).score;
    const S = C().scoring;
    t('weights: tolFrac 0.001, weight 250, k 1, time 0.1/s, fuel 0.01/kg',
  S.orbit.tolFrac === 0.001 && S.orbit.weight === 250 && S.orbit.k === 1 && S.timeToDeploySWeight === 0.1 && S.boosterFuelLeftKgWeight === 0.01);
t('relative tol: 0.32 km @320, 1 km @1000, 0.3 km @300', Math.abs(orbitTolKm(320) - 0.32) < 1e-12 && Math.abs(orbitTolKm(1000) - 1) < 1e-12 && Math.abs(orbitTolKm(300) - 0.3) < 1e-12);
t('same relative error => same penalty (0.64@320 == 2@1000)', Math.abs(orbitPenalty(0.64, 320) - orbitPenalty(2, 1000)) < 1e-9);
t('no deadzone: 0 error -> 0, every err > 0 -> > 0', orbitPenalty(0, 320) === 0 && orbitPenalty(0.001, 320) > 0 && orbitPenalty(-0.001, 320) > 0);
t('0.15 km @320 ~ 27 pt (was 0 with the deadzone)', Math.abs(orbitPenalty(0.15, 320) - 27) < 2, orbitPenalty(0.15, 320).toFixed(2));
t('0.32 km @320 (tol) ~ 104 pt', Math.abs(orbitPenalty(0.32, 320) - 104) < 3, orbitPenalty(0.32, 320).toFixed(1));
t('1 km @320 ~ 570 pt', Math.abs(orbitPenalty(1, 320) - 570) < 15, orbitPenalty(1, 320).toFixed(1));
t('5 km @320 ~ 3650 pt', Math.abs(orbitPenalty(5, 320) - 3650) < 100, orbitPenalty(5, 320).toFixed(0));
t('monotone in |err|, sign-symmetric, no cliff', orbitPenalty(0.5, 320) > orbitPenalty(0.4, 320) && orbitPenalty(-0.5, 320) === orbitPenalty(0.5, 320));
    const orbitWorse = score(Object.assign({}, good, { apogeeKm: 321 })).score - s0;                 // 1 km apo error
    const fuelRange  = score(Object.assign({}, good, { boosterFuelLeftKg: 2000 - 15000 })).score - s0; // 15000 kg range
    const timeRange  = score(Object.assign({}, good, { deployTimeS: 590 + 600 })).score - s0;         // 600 s range
    const time100    = score(Object.assign({}, good, { deployTimeS: 690 })).score - s0;
    t('hierarchy: orbit(1 km) > fuel(15000 kg range) > time(600 s range)', orbitWorse > fuelRange && fuelRange > timeRange, orbitWorse.toFixed(1) + ' > ' + fuelRange.toFixed(1) + ' > ' + timeRange.toFixed(1));
    t('100 s = 10 pt, 600 s = 60 pt', Math.abs(time100 - 10) < 1e-6 && Math.abs(timeRange - 60) < 1e-6);
    const typ = score({ crashed: false, payloadReleased: true, payloadCleared: true, vrEnd: 0.03, vrMin: 0, maxQKPa: 24.8, maxG: 4.8,
      apogeeKm: 320, perigeeKm: 320, ecc: 1e-5, boosterFuelLeftKg: 60000, deployTimeS: 640 });
    t('typical score -536 (perfect orbit, 60000 fuel, 640 s)', typ.ok && Math.abs(typ.score + 536) < 0.01, typ.score.toFixed(3));
    t('score range realistic (-700..-400 for sane runs)', typ.score > -700 && typ.score < -400);
    t('zero error => orbit term 0 (no tolerance deadzone)', score(good).parts.apogee === 0 && score(good).parts.ecc === 0);
    
    // 9b. leaderboard rows + sort
    const mk = (o) => Object.assign({}, good, o);
    const P = (k) => Object.assign({}, bp, { meco: 52000 + k });
    const rowsIn = [
      makeRow('A', 'a', P(1), mk({ apogeeKm: 320.05, boosterFuelLeftKg: 52000, deployTimeS: 600 }), { E: 0.1 }),
      makeRow('B', 'b', P(2), mk({ apogeeKm: 320.30, boosterFuelLeftKg: 53000, deployTimeS: 640 }), { E: 0.15 }),
      makeRow('B', 'c', P(3), mk({ apogeeKm: 320.0, perigeeKm: 320.0, ecc: 1e-6, boosterFuelLeftKg: 51000, deployTimeS: 700 }), { E: 0.12 }),
      makeRow('B', 'x', P(4), mk({ crashed: true, boosterFuelLeftKg: 99999, deployTimeS: 1 }), { E: 0.2 }),
      makeRow('B', 'r', P(5), mk({ boosterFuelLeftKg: 99998, deployTimeS: 2 }), { E: 0.2, reject: true, reasons: ['residual_out_of_band'] }),
    ];
    const snap = JSON.stringify(rowsIn);
    const lastBad = (a) => !a[a.length - 1].ok && !a[a.length - 2].ok && a.slice(0, -2).every((r) => r.ok);
    const bySc = sortRows(rowsIn, 'score'), byAc = sortRows(rowsIn, 'accuracy'), byFu = sortRows(rowsIn, 'fuel'), byTi = sortRows(rowsIn, 'time');
    t('SORT_KEYS', JSON.stringify(SORT_KEYS) === '["score","accuracy","fuel","time"]');
    t('row fields', ['src','tag','ok','point','desc','score','parts','deltaV','apoKm','periKm','apoErrKm','periErrKm','orbitErrKm','ecc','fuelKg','deployS','residualKg','reasons'].every((k) => k in rowsIn[0]));
    t('row: reject flag -> not ok, reason kept', !rowsIn[4].ok && rowsIn[4].reasons.includes('residual_out_of_band') && !rowsIn[3].ok);
    t('sort: failed rows always last (all keys)', [bySc, byAc, byFu, byTi].every(lastBad));
    t('sort score ascending', bySc.slice(0, 3).every((r, i, a) => i === 0 || a[i - 1].score <= r.score));
    t('sort accuracy: orbitErr asc', byAc[0].tag === 'c' && byAc[1].tag === 'a' && byAc[2].tag === 'b');
    t('sort fuel descending', byFu[0].tag === 'b' && byFu[1].tag === 'a' && byFu[2].tag === 'c');
    t('sort time ascending', byTi[0].tag === 'a' && byTi[1].tag === 'b' && byTi[2].tag === 'c');
    t('sort: different winners per key', new Set([bySc[0].tag, byAc[0].tag, byFu[0].tag, byTi[0].tag]).size >= 3, [bySc[0].tag, byAc[0].tag, byFu[0].tag, byTi[0].tag].join(','));
    t('sort: input not mutated', JSON.stringify(rowsIn) === snap && bySc !== rowsIn);
    const crashed = score(Object.assign({}, good, { crashed: true }));
    t('hard fail >> any pass', !crashed.ok && crashed.score > 1e6 && crashed.score > s0 + 1e5);
    const noVr = score(Object.assign({}, good, { vrEnd: -0.01 }));
    t('vrEnd<0 hard fail', !noVr.ok && noVr.reasons.includes('vrEnd_negative'));
    const worse = score(Object.assign({}, good, { maxQKPa: 40 })), worser = score(Object.assign({}, good, { maxQKPa: 60 }));
    t('graded depth: deeper fail scores higher', worser.score > worse.score);
    t('vrMin -0.38 only soft (still ok)', score(Object.assign({}, good, { vrMin: -0.38 })).ok);

    // 9c. duration cap: suggestion + hit flag
t('suggestDurationCap: 770 @320, 1160 @640, 1590 @1000, 580 @160', suggestDurationCap(320) === 770 && suggestDurationCap(640) === 1160 && suggestDurationCap(1000) === 1590 && suggestDurationCap(160) === 580,
  [160, 320, 640, 1000, 2000].map((a) => a + ':' + suggestDurationCap(a)).join(' '));
const capHit = score(Object.assign({}, good, { endReason: 'CAP', payloadCleared: false, payloadReleased: false }));
t('duration cap hit -> hard fail with reason duration_cap_hit', !capHit.ok && capHit.reasons.includes('duration_cap_hit') && capHit.reasons.includes('payload_not_cleared'));

// 10. cache
const cache = new EvalCache(); cache.set(bp, 'FULL', { x: 1 });
t('cache hit/miss by stopAt', cache.get(bp, 'FULL') && !cache.get(bp, 'COAST_WAIT_ENTRY'));

// 11. Δv signal contract (Step Δv 1/4)
{
  const m = { crashed: false, payloadReleased: true, payloadCleared: true, vrEnd: 0.03, vrMin: -0.3,
    maxQKPa: 24.8, maxG: 4.8, apogeeKm: 320, perigeeKm: 320, ecc: 1e-5,
    boosterFuelLeftKg: 2000, deployTimeS: 590, coastDeltaV: 599 };
  t('Δv: 320 km baseline (599) not hard-failed', score(m).ok);
  t('Δv: 2000 km manual (925) not hard-failed', score(Object.assign({}, m, { coastDeltaV: 925 })).ok);
  t('Δv: NaN not hard-failed', score(Object.assign({}, m, { coastDeltaV: NaN })).ok);
  t('config: coastDeltaVbandMps = [600,700]', JSON.stringify(C().limits.coastDeltaVbandMps) === '[600,700]');
  t('config: coastDeltaVguardMps = [700,900]', JSON.stringify(C().limits.coastDeltaVguardMps) === '[700,900]');
  t('config: eMaxGuess / eDropOnFail / eSafetyMargin removed',
    C().ecc.eMaxGuess === undefined && C().ecc.eDropOnFail === undefined && C().limits.eSafetyMargin === undefined);
}


    return { ok: fails.length === 0, lines: out, fails };
  }

  root.TunerUtils = {
  gOf, tOf, biasOf, leadOf, snapG, snapT, snapBias, snapLead, snapMeco,
  collapseA, aEff, fromRaw, step, key, inBounds, toValues, describe,
  verifyApplied, EvalCache, checkHard, score, runSelfTests,
  orbitTolKm, orbitPenalty, orbitErrKm, makeRow, sortRows, SORT_KEYS, suggestDurationCap,
};
})();
