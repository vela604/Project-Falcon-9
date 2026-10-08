// ============================================================================
// headless/tuner/inner1.js — INNER-1: (G, T, bias) boundary tracer + E_max learning loop.
// Implements INNER1-DESIGN.md rev 3.
//
//   const { searchBoundary, loadLearned, saveLearned } = require('./inner1');
//   const r = await searchBoundary(ev, cfg, { meco: 52612 }, { learned, parallel: 6 });
//   r = { meco, best, ranked[], brackets{L,R}, eFinal{L,R}, learned, stats, anomalies[], notes[], log[], eMinTable[] }
//
// Search space: g index `cd` (0.01 deg, discrete), Tn (T = Tn*0.000125 s, continuous inside a G segment),
// bias tick bn (bias = bn*0.0001). A_eff = G*T^2 is REPORT/SORT ONLY (never fed back into a search).
// The ev receives A = G*T^2 built so that evaluator.collapseAscent maps it back to EXACTLY (cd, Tn)
// (checked on every probe through `effective`).
//
// Levels:
//   Level 0  ev.evaluateMany(.., {eval:'coastEnd', stride:1})  -> E, coastEndTToApoS, coastEndT   (~90 s / round of 6)
//   Level 1  inner2.tuneLead (full evals)                                                        (~11 min / point)
//
// Pipeline per MECO (b* is ALWAYS re-located; only the E_max bracket is reused, design sec. 15.3):
//   learning loop (per branch L/R):  E_t from bracket -> trace boundary at E_t -> INNER-2 on best-ranked candidate
//        -> ok: E_ok = max;  timing-bound / physics-bound(vr-hardfloor): E_fail = min;
//           window-skipped / no-valid-burn / lead-floor / vr-negative: INCONCLUSIVE (retry neighbouring ticks, never sets E_fail)
//   final:  E_final = E_ok*(1-safety) -> trace -> rank by Level-0 deploy proxy (coastEndT + coastEndTToApoS)
//        -> INNER-2 on top candidates (distinct (segment, branch)) -> rank by full score (then A_eff).
//
// Trace (per segment cd, branch, E_t):
//   sub-segments split at T = 4.820 (Tn = splitTn; side rule unverified, both searched independently, Q1)
//   -> smallest Tn whose E_min(T) <= E_t (and coastEndTToApoS >= tNeededS)   [k-section, 2-3 T points per step, approx E_min]
//   -> exactify (Tn-1 must be infeasible with an exact b*) -> bias crossing of E_t on the branch
//   -> ladder/secant k-section on the 1e-4 lattice, last +-2 ticks scan.
// ============================================================================
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { collapseAscent } = require('./evaluator');
const { tuneLead: defaultTuneLead } = require('./inner2');

const DT = 1 / 80;
const hasNum = x => typeof x === 'number' && Number.isFinite(x);
const uniq = a => Array.from(new Set(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const decimalsOf = q => { const s = String(q); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
function params(cfg, opts) {
  opts = opts || {};
  const g = (cfg.guided && cfg.guided.inner1) || {};
  const tA = cfg.tunables.find(t => t.id === 'ascent_profile_constant');
  const tB = cfg.tunables.find(t => t.id === 'stage_burn_aoa_bias');
  const pick = (k, d) => (opts[k] !== undefined ? opts[k] : (g[k] !== undefined ? g[k] : d));
  const em = Object.assign({ eOkInit: 0.171, upMult: 1.5, minRelGap: 0.03, maxIters: 6 }, g.eMaxGrowth || {}, opts.eMaxGrowth || {});
  const bq = tB.quantum;
  return {
    tA, gq: tA.gimbalQuantumDeg, tq: tA.pushTQuantumS, T0: tA.anchorPushT_s,
    splitTn: Math.round(tA.anchorPushT_s / tA.pushTQuantumS),
    bq, bDec: decimalsOf(bq), bnLo: Math.ceil(tB.lower / bq - 1e-9), bnHi: Math.floor(tB.upper / bq + 1e-9),
    biasSteps: pick('biasSteps', [0.5, 0.1, 0.05, 0.01, 0.001, 0.0001]),
    em, tNeededS: pick('tNeededS', 8), dAWindow: pick('dAWindow', 0.5), topK: pick('topK', 3), safety: pick('safety', 0.05),
    halfTicks: Math.round(pick('biasHalfWidth', 0.3) / bq),
    retryTicks: pick('retryTicks', 2), extraTries: pick('extraTries', 3), maxPasses: pick('maxPasses', 3),
    maxSegUp: pick('maxSegUp', 8), maxSegDown: pick('maxSegDown', 12),
    tolExactTicks: pick('tolExactTicks', 100), maxLocateRounds: pick('maxLocateRounds', 10),
    maxLevel0Evals: pick('maxLevel0Evals', 5000), leadFix: pick('leadFix', 5.525),
    par: Math.max(1, Math.floor(opts.parallel || 6))
  };
}

// ---------------------------------------------------------------------------
// Lattice geometry: (cd, Tn) <-> A ; segments ; sub-segments
// ---------------------------------------------------------------------------
function makeGeo(P) {
  const G = cd => Number((cd * P.gq).toFixed(6));
  const T = Tn => Number((Tn * P.tq).toFixed(7));
  const pointA = (cd, Tn) => G(cd) * T(Tn) * T(Tn);
  const inSeg = (cd, Tn) => { if (Tn < 1 || cd < 1) return false; const c = collapseAscent(P.tA, pointA(cd, Tn)); return c.cd === cd && c.Tn === Tn; };
  const segMemo = new Map();
  function segRange(cd) {
    if (segMemo.has(cd)) return segMemo.get(cd);
    let lo = Math.round(P.T0 * Math.sqrt((cd - 0.5) / cd) / P.tq), hi = Math.round(P.T0 * Math.sqrt((cd + 0.5) / cd) / P.tq);
    let guard = 0;
    while (!inSeg(cd, lo) && guard++ < 100) lo++;
    while (inSeg(cd, lo - 1) && guard++ < 200) lo--;
    while (!inSeg(cd, hi) && guard++ < 300) hi--;
    while (inSeg(cd, hi + 1) && guard++ < 400) hi++;
    if (guard >= 100 && !(inSeg(cd, lo) && inSeg(cd, hi))) throw new Error('inner1: cannot resolve T range of segment cd=' + cd);
    const r = { lo, hi }; segMemo.set(cd, r); return r;
  }
  function subs(cd) {
    const { lo, hi } = segRange(cd), out = [];
    const sp = P.splitTn;
    if (lo <= sp - 1) out.push({ cd, name: 'lowT', lo, hi: Math.min(hi, sp - 1) });
    if (hi >= sp) out.push({ cd, name: 'highT', lo: Math.max(lo, sp), hi });
    return out;
  }
  return { G, T, pointA, inSeg, segRange, subs };
}

// ---------------------------------------------------------------------------
// Warm start (design sec. 9 / 15): interpolate (G, bias, lead) between the manual reference MECOs
// ---------------------------------------------------------------------------
function warmStart(cfg, meco, P) {
  const refs = (((cfg.guided || {}).mecoOuter || {}).warmStart || []).filter(r => hasNum(r.meco)).sort((a, b) => a.meco - b.meco);
  const snapLead = x => Math.round(x / DT) * DT;
  if (!refs.length) return { cd: 60, G: 0.6, bias: 0.6, biasBn: Math.round(0.6 / P.bq), lead: P.leadFix, source: 'default' };
  let a = null, b = null;
  refs.forEach(r => { if (r.meco <= meco) a = r; });
  for (let i = refs.length - 1; i >= 0; i--) if (refs[i].meco >= meco) b = refs[i];
  const f = (a && b && a !== b) ? (meco - a.meco) / (b.meco - a.meco) : 0;
  const base = a || b, other = b || a;
  const lerp = k => (hasNum(base[k]) && hasNum(other[k]) && base !== other) ? base[k] + f * (other[k] - base[k]) : (hasNum(base[k]) ? base[k] : other[k]);
  let G = lerp('G'); if (!hasNum(G)) G = (refs.find(r => hasNum(r.G)) || { G: 0.6 }).G;
  const cd = Math.max(1, Math.round(G / P.gq));
  const bias = lerp('bias');
  return { cd, G: Number((cd * P.gq).toFixed(6)), bias, biasBn: clamp(Math.round(bias / P.bq), P.bnLo, P.bnHi), lead: snapLead(lerp('lead')),
    source: base === other ? 'ref ' + base.meco : 'interp ' + a.meco + '..' + b.meco };
}

// ---------------------------------------------------------------------------
// E_max learning store (per MECO, per branch). Persisted by the caller (learned-bounds.json).
//   learned = { version, signature, mecos: { "<meco>": { L:{oks:[], fails:[], inconclusive:[]}, R:{...} } } }
// E_ok   = largest E with INNER-2 success on this branch.  E_fail = smallest E with a CONCLUSIVE failure above E_ok.
// A new MECO is seeded from the nearest MECO's bracket; own evidence supersedes the seed (a seed is a hypothesis).
// ---------------------------------------------------------------------------
function signature(cfg) {
  const m = cfg.mission || {};
  return crypto.createHash('sha1').update(JSON.stringify({ stack: m.stackId, vehicle: m.vehicleId, guide: m.guide, alt: m.targetOrbitAltKm, fixed: cfg.fixed })).digest('hex').slice(0, 16);
}
function newLearned(cfg) { return { version: 1, signature: signature(cfg), mecos: {}, verifies: {} }; }
function loadLearned(file, cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.signature === signature(cfg) && j.mecos) { if (!j.verifies) j.verifies = {}; return j; }
    return newLearned(cfg);                       // other stack / margin / altitude: E_max NOT transferable
  } catch (e) { return newLearned(cfg); }
}
function saveLearned(file, learned) { const c = { version: learned.version, signature: learned.signature, mecos: learned.mecos }; fs.writeFileSync(file, JSON.stringify(c, null, 2)); }

function ownOf(learned, meco, branch) {
  const m = learned.mecos[meco]; return (m && m[branch]) || { oks: [], fails: [], inconclusive: [] };
}
function bracketCore(own, seed, em) {
  const okOwn = own.oks.length ? Math.max(...own.oks) : null;
  // the seed / baseline E_ok stays a floor unless an own failure at or below it contradicts it (a lower own success does NOT replace it)
  const seedOk = (seed.ok !== null && !own.fails.some(f => f <= seed.ok)) ? seed.ok : null;
  let eOk = okOwn, seeded = false;
  if (seedOk !== null && (eOk === null || seedOk > eOk)) { eOk = seedOk; seeded = true; }
  const contradicted = okOwn === null ? [] : own.fails.filter(f => f <= okOwn);
  const failsAbove = own.fails.filter(f => eOk === null || f > eOk);
  let eFail = failsAbove.length ? Math.min(...failsAbove) : null;
  if (eFail === null && seed.fail !== null && (eOk === null || seed.fail > eOk)) { eFail = seed.fail; seeded = true; }
  if (eOk === null && eFail === null) { eOk = em.eOkInit; seeded = true; }
  return { eOk, eFail, okOwn, seeded, contradicted, converged: eOk !== null && eFail !== null && eFail / eOk - 1 <= em.minRelGap };
}
function bracketOf(learned, meco, branch, P) {
  const has = (m, b) => { const e = learned.mecos[m] && learned.mecos[m][b]; return !!(e && (e.oks.length || e.fails.length)); };
  let seed = { ok: P.em.eOkInit, fail: null }, seedFrom = 'init';
  const others = Object.keys(learned.mecos).map(Number).filter(m => m !== meco && has(m, branch)).sort((a, b) => Math.abs(a - meco) - Math.abs(b - meco) || a - b);
  const otherBranch = branch === 'L' ? 'R' : 'L';
  if (others.length) {                                      // nearest MECO, same branch
    const b = bracketCore(ownOf(learned, others[0], branch), { ok: P.em.eOkInit, fail: null }, P.em); seed = { ok: b.eOk, fail: b.eFail }; seedFrom = 'meco ' + others[0];
  } else if (has(meco, otherBranch) && !ownOf(learned, meco, branch).fails.length) {   // same MECO, other branch: seed until this branch has its own fail evidence
    const b = bracketCore(ownOf(learned, meco, otherBranch), { ok: P.em.eOkInit, fail: null }, P.em); seed = { ok: b.eOk, fail: b.eFail }; seedFrom = 'branch ' + otherBranch;
  }
  return Object.assign(bracketCore(ownOf(learned, meco, branch), seed, P.em), { seedFrom });
}
function nextTarget(br, P) {
  const em = P.em;
  const t = br.eOk === null ? br.eFail / em.upMult : br.eFail === null ? br.eOk * em.upMult : Math.sqrt(br.eOk * br.eFail);
  return Math.min(t, 0.9);
}
function finalTarget(br, P) { return (br.eOk !== null ? br.eOk : br.eFail / P.em.upMult) * (1 - P.safety); }

// INNER-2 result -> evidence about E_max. Only timing-bound and vr-hardfloor failures count (STATE: lead confound rule).
function classifyOutcome(r) {
  if (r.status === 'converged' && r.detail === 'in-window') return { kind: 'ok', reason: 'in-window' };
  if (r.status === 'converged') return { kind: 'inconclusive', reason: r.detail };                 // window-skipped, lead-floor
  if (r.status === 'timing-bound') return { kind: 'fail', reason: 'timing-bound' };
  if (r.status === 'physics-bound' && r.detail === 'vr-hardfloor') return { kind: 'fail', reason: 'vr-hardfloor' };
  return { kind: 'inconclusive', reason: r.status + '/' + r.detail };                              // no-valid-burn, vr-negative (phase 1 only)
}
function applyOutcome(learned, meco, branch, E, out) {
  const m = learned.mecos[meco] || (learned.mecos[meco] = {});
  const e = m[branch] || (m[branch] = { oks: [], fails: [], inconclusive: [] });
  if (out.kind === 'ok') e.oks.push(E);
  else if (out.kind === 'fail') e.fails.push(E);
  else e.inconclusive.push({ E, reason: out.reason });
  return e;
}

// optional: emap.csv -> b* hints (MECO 52612 only; design sec. 15.2)
function emapHintsFromCsv(text, P) {
  const rows = text.trim().split(/\r?\n/).slice(1).map(l => l.split(',')).map(c => ({ aEff: +c[1], bias: +c[4], ecc: +c[5] })).filter(r => hasNum(r.aEff) && hasNum(r.ecc));
  const byA = new Map(); rows.forEach(r => { const k = r.aEff.toFixed(5); (byA.get(k) || byA.set(k, []).get(k)).push(r); });
  const out = [];
  byA.forEach(rs => {
    rs.sort((a, b) => a.bias - b.bias);
    let k = 0; rs.forEach((r, i) => { if (r.ecc < rs[k].ecc) k = i; });
    if (k > 0 && k < rs.length - 1) out.push({ cd: null, Tn: null, A_eff: rs[k].aEff, bn: Math.round(rs[k].bias / P.bq), emap: true });
  });
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function searchBoundary(ev, cfg, point, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const P = params(cfg, Object.assign({ parallel: ev.workers || undefined }, opts));
  const geo = makeGeo(P);
  const meco = point.meco;
  const learned = opts.learned || newLearned(cfg);
  const tune = opts.tuneLead || defaultTuneLead;
  const warm = warmStart(cfg, meco, P);
  const stats = { level0Evals: 0, level0Rounds: 0, level0Waves: 0, byPhase: {}, inner2Calls: 0, inner2Evals: 0, timingScreened: 0, retries: 0 };
  const log = [], anomalies = [], notes = [];
  const say = s => { log.push(s); if (opts.verbose) console.log('[inner1] ' + s); };
  const anomaly = (key, o) => { if (!anomalies.some(a => a.key === key)) { anomalies.push(Object.assign({ key }, o)); say('ANOMALY ' + key); } };
  notes.push('T=' + (P.splitTn * P.tq).toFixed(3) + ' side rule unverified (Q1): sub-segments lowT/highT searched independently');
  say('meco ' + meco + ' warm ' + JSON.stringify({ cd: warm.cd, bias: warm.bias, lead: warm.lead, src: warm.source }));

  let curPhase = 'init', curStage = '';
  // ---- Level 0 --------------------------------------------------------------
  const memo = new Map(), byPt = new Map();              // key -> rec ; "cd|Tn" -> Map(bn -> rec)
  const biasOf = bn => Number((bn * P.bq).toFixed(P.bDec));
  const keyOf = (cd, Tn, bn) => cd + '|' + Tn + '|' + bn;
  const timingSeen = new Set();
  const v = (rec, eT) => (!rec || rec.bad) ? Infinity : Math.max(Math.log(rec.E / eT), Math.log(P.tNeededS / rec.leadMax));
  const ok = (rec, eT) => v(rec, eT) <= 0;
  const noteTiming = (rec, eT) => { if (rec && !rec.bad && rec.E <= eT && rec.leadMax < P.tNeededS) { const k = keyOf(rec.cd, rec.Tn, rec.bn); if (!timingSeen.has(k)) { timingSeen.add(k); stats.timingScreened++; } } };

  async function probe(pts) {
    const need = []; const seen = new Set();
    pts.forEach(p => { const k = keyOf(p.cd, p.Tn, p.bn); if (!memo.has(k) && !seen.has(k)) { seen.add(k); need.push(p); } });
    if (need.length) {
      if (stats.level0Evals + need.length > P.maxLevel0Evals) throw new Error('inner1: maxLevel0Evals ' + P.maxLevel0Evals + ' exceeded');
      const list = need.map(p => ({ ascent_profile_constant: geo.pointA(p.cd, p.Tn), stage_burn_aoa_bias: biasOf(p.bn), meco_target_booster_fuel: meco, circ_trigger_lead: P.leadFix }));
      const rs = await ev.evaluateMany(list, { eval: 'coastEnd', stride: 1 });
      rs.forEach((r, i) => {
        const p = need[i], m = r.metrics || {}, e = r.effective || {};
        if (e.ascent_Tn !== undefined && (e.ascent_Tn !== p.Tn || Math.abs(e.ascent_G - geo.G(p.cd)) > 1e-9))
          throw new Error('inner1: lattice mismatch (asked cd=' + p.cd + ' Tn=' + p.Tn + ', evaluator used G=' + e.ascent_G + ' Tn=' + e.ascent_Tn + ')');
        const E = hasNum(m.coastEndEcc) ? m.coastEndEcc : null;
        const bad = !!r.hardFail || E === null || !hasNum(m.coastEndTToApoS);
        const rec = { cd: p.cd, Tn: p.Tn, bn: p.bn, bias: biasOf(p.bn), G: geo.G(p.cd), T: geo.T(p.Tn), A_eff: hasNum(e.A_eff) ? e.A_eff : geo.pointA(p.cd, p.Tn),
          E, leadMax: hasNum(m.coastEndTToApoS) ? m.coastEndTToApoS : null, coastEndT: hasNum(m.coastEndT) ? m.coastEndT : null,
          fuel: hasNum(m.stageFuelAtCoastEndKg) ? m.stageFuelAtCoastEndKg : null, bad, hardFail: !!r.hardFail };
        rec.proxyDeployS = (rec.coastEndT !== null && rec.leadMax !== null) ? rec.coastEndT + rec.leadMax : null;
        memo.set(keyOf(p.cd, p.Tn, p.bn), rec);
        const pk = p.cd + '|' + p.Tn; if (!byPt.has(pk)) byPt.set(pk, new Map()); byPt.get(pk).set(p.bn, rec);
        if (!r.cached) { stats.level0Evals++; const kk = curPhase + ':' + curStage; stats.byPhase[kk] = (stats.byPhase[kk] || 0) + 1; }
        if (m.coastEndExactTick === false) anomaly('inexact-coast-end@' + keyOf(p.cd, p.Tn, p.bn), { type: 'inexact-tick' });
      });
      stats.level0Rounds++; stats.level0Waves += Math.ceil(need.length / P.par);
    }
    return pts.map(p => memo.get(keyOf(p.cd, p.Tn, p.bn)));
  }
  const allRecs = (cd, Tn) => Array.from((byPt.get(cd + '|' + Tn) || new Map()).values()).sort((a, b) => a.bn - b.bn);
  const validRecs = (cd, Tn) => allRecs(cd, Tn).filter(r => !r.bad);

  // integer points helpers
  const inRange = bn => bn >= P.bnLo && bn <= P.bnHi;
  function spreadIncl(a, b, n) {
    a = Math.max(a, P.bnLo); b = Math.min(b, P.bnHi);
    if (b < a) return [];
    if (b - a + 1 <= n) { const o = []; for (let x = a; x <= b; x++) o.push(x); return o; }
    return uniq(Array.from({ length: n }, (_, i) => a + Math.round((b - a) * i / (n - 1))));
  }
  function spreadInner(a, b, n) {            // integers strictly between a and b
    if (b - a - 1 <= 0) return [];
    if (b - a - 1 <= n) { const o = []; for (let x = a + 1; x < b; x++) o.push(x); return o; }
    return uniq(Array.from({ length: n }, (_, i) => a + Math.round((b - a) * (i + 1) / (n + 1)))).filter(x => x > a && x < b);
  }

  // ---- b* location (min E over bias at fixed (cd, Tn)) ----------------------------------------
  // returns { bn, rec, eMin, monotone: null|'R'|'L', interior, tol }.  monotone 'R': E rises with bias over the whole range
  // (min at the lower bound; branch L absent). monotone 'L': min at upper bound (branch R absent).
  async function locate(cd, Tn, hint, tol) {
    let rounds = 0;
    for (; rounds <= P.maxLocateRounds; rounds++) {
      const arr = validRecs(cd, Tn);
      let pts = null;
      if (!arr.length) {
        if (rounds > 0) return { failed: true, rec: null, bn: hint.bn, eMin: Infinity, monotone: null, interior: false, tol };
        pts = spreadIncl(hint.bn - hint.half, hint.bn + hint.half, P.par);
      } else {
        let k = 0; arr.forEach((r, i) => { if (r.E < arr[k].E) k = i; });
        const x = arr[k], left = arr[k - 1], right = arr[k + 1];
        const span = Math.max(arr[arr.length - 1].bn - arr[0].bn, hint.half);
        if (!left && x.bn > P.bnLo) pts = spreadIncl(x.bn - 2 * span, x.bn - 1, P.par);
        else if (!left) return { bn: x.bn, rec: x, eMin: x.E, monotone: 'R', interior: false, tol };
        else if (!right && x.bn < P.bnHi) pts = spreadIncl(x.bn + 1, x.bn + 2 * span, P.par);
        else if (!right) return { bn: x.bn, rec: x, eMin: x.E, monotone: 'L', interior: false, tol };
        else if (right.bn - left.bn <= tol) return { bn: x.bn, rec: x, eMin: x.E, monotone: null, interior: true, tol };
        else pts = spreadInner(left.bn, right.bn, P.par);
        pts = pts.filter(bn => !memo.has(keyOf(cd, Tn, bn)));
        if (!pts.length) return { bn: x.bn, rec: x, eMin: x.E, monotone: null, interior: true, tol };    // lattice-resolution limit
      }
      await probe(pts.map(bn => ({ cd, Tn, bn })));
    }
    anomaly('locate-rounds@' + cd + '|' + Tn, { type: 'locate-rounds-exceeded', cd, Tn });
    const arr = validRecs(cd, Tn); let k = 0; arr.forEach((r, i) => { if (r.E < arr[k].E) k = i; });
    return arr.length ? { bn: arr[k].bn, rec: arr[k], eMin: arr[k].E, monotone: null, interior: false, tol } : { failed: true, rec: null, bn: hint.bn, eMin: Infinity, monotone: null, interior: false, tol };
  }

  const located = [];                                    // known b* points (interior minima) for hints
  const minMemo = new Map();                             // "cd|Tn" -> result (keeps the finest tol)
  const eMinTable = new Map();
  async function minAt(cd, Tn, hint, tol) {
    const k = cd + '|' + Tn, prev = minMemo.get(k);
    if (prev && prev.tol <= tol) return prev;
    const h = prev && prev.bn !== undefined && !prev.failed ? { bn: prev.bn, half: Math.max(500, Math.round(P.halfTicks / 4)) } : hint;
    curStage = tol === Infinity ? 'Tapprox' : 'exact';
    const r = await locate(cd, Tn, h, tol);
    minMemo.set(k, r);
    if (!r.failed && r.interior) {
      const i = located.findIndex(x => x.cd === cd && x.Tn === Tn);
      const e = { cd, Tn, A_eff: geo.pointA(cd, Tn), bn: r.bn };
      if (i >= 0) located[i] = e; else located.push(e);
    }
    if (!r.failed) eMinTable.set(k, { cd, Tn, A_eff: geo.pointA(cd, Tn), bias: r.rec.bias, eMin: r.eMin, leadMax: r.rec.leadMax, monotone: r.monotone, exact: tol <= P.tolExactTicks });
    return r;
  }
  const emapHints = (opts.emapHints && meco === 52612) ? opts.emapHints : [];
  function hintFor(cd, Tn) {
    const same = located.filter(x => x.cd === cd).sort((a, b) => Math.abs(a.Tn - Tn) - Math.abs(b.Tn - Tn) || a.Tn - b.Tn);
    const extrap = (a, b, xa, xb, x) => { if (!b || xa === xb) return a.bn; const s = (b.bn - a.bn) / (xb - xa); return clamp(Math.round(a.bn + s * (x - xa)), a.bn - 5000, a.bn + 5000); };
    if (same.length) return { bn: clamp(extrap(same[0], same[1], same[0].Tn, same[1] && same[1].Tn, Tn), P.bnLo, P.bnHi), half: Math.max(1000, Math.round(P.halfTicks / 2)), src: 'seg' };
    const A = geo.pointA(cd, Tn);
    const all = located.map(x => ({ bn: x.bn, A: x.A_eff, cd: x.cd, Tn: x.Tn })).concat(emapHints.map(x => ({ bn: x.bn, A: x.A_eff, cd: 0, Tn: 0 })))
      .sort((a, b) => Math.abs(a.A - A) - Math.abs(b.A - A) || a.cd - b.cd || a.Tn - b.Tn);
    if (all.length) return { bn: clamp(extrap(all[0], all[1], all[0].A, all[1] && all[1].A, A), P.bnLo, P.bnHi), half: P.halfTicks, src: 'cross' };
    return { bn: warm.biasBn, half: P.halfTicks, src: 'warm' };
  }

  // ---- smallest feasible Tn in a sub-segment --------------------------------------------------
  // opts.skipIfLoInfeasible: this sub-segment is only interesting when its FIRST tick is already feasible (the lower-T sub-segment of
  // the same segment has a feasible point, so any larger Tn here is dominated in A_eff; only a drop of E across T=4.820 can matter).
  async function findMinT(cd, sub, eT, fo) {
    fo = fo || {};
    const vals = new Map();
    const evalTn = async tns => {
      const todo = uniq(tns).filter(t => t >= sub.lo && t <= sub.hi && !vals.has(t)).sort((a, b) => a - b);
      const hints = todo.map(t => hintFor(cd, t));                         // computed BEFORE any await: deterministic
      const rs = await Promise.all(todo.map((t, i) => minAt(cd, t, hints[i], Infinity)));
      rs.forEach((r, i) => { vals.set(todo[i], r.failed ? Infinity : v(r.rec, eT)); if (!r.failed) noteTiming(r.rec, eT); });
    };
    if (fo.skipIfLoInfeasible) { await evalTn([sub.lo]); if (!(vals.get(sub.lo) <= 0)) return null; }
    await evalTn([sub.hi]);
    if (!(vals.get(sub.hi) <= 0)) return null;                              // segment/sub-segment has no boundary at E_t
    await evalTn([sub.lo]);
    let hi = sub.hi, lo = sub.lo;
    const refresh = () => {
      const tns = Array.from(vals.keys()).sort((a, b) => a - b);
      const feas = tns.filter(t => vals.get(t) <= 0); hi = Math.min(...feas);
      const infeas = tns.filter(t => vals.get(t) > 0 && t < hi); lo = infeas.length ? Math.max(...infeas) : null;
      const above = tns.filter(t => t > hi && vals.get(t) > 0);
      if (above.length) anomaly('T-nonmonotone@' + cd + '|' + sub.name + '|' + above[0], { type: 'T-nonmonotone', cd, sub: sub.name, feasibleTn: hi, infeasibleAbove: above[0] });
    };
    refresh();
    while (lo !== null && hi - lo > 1) {
      const w = hi - lo; let pts;
      if (w <= 3) pts = [];
      else {
        const vlo = vals.get(lo), vhi = vals.get(hi);                        // vlo > 0 >= vhi
        const f = Number.isFinite(vlo) ? clamp(vlo / (vlo - vhi), 0, 1) : 0.5;
        const c = lo + Math.round(w * f), d = Math.max(1, Math.round(w / 12));
        pts = [c - d, c + d];                                                // secant guess +- d: bracket shrinks even when the guess is poor
      }
      if (w <= 3) for (let t = lo + 1; t < hi; t++) pts.push(t);
      pts = uniq(pts.map(t => clamp(t, lo + 1, hi - 1))).filter(t => !vals.has(t));
      if (!pts.length) pts = [Math.floor((lo + hi) / 2)].filter(t => !vals.has(t));
      if (!pts.length) break;
      await evalTn(pts); refresh();
    }
    // exactify: approximate E_min overestimates, so `hi` is truly feasible; make sure hi-1 is truly infeasible
    let Ts = hi;
    let res = await minAt(cd, Ts, hintFor(cd, Ts), P.tolExactTicks);
    for (let i = 0; i < 8 && Ts > sub.lo; i++) {
      const r = await minAt(cd, Ts - 1, hintFor(cd, Ts - 1), P.tolExactTicks);
      if (!r.failed && v(r.rec, eT) <= 0) { Ts--; res = r; } else break;
    }
    if (v(res.rec, eT) > 0) {                                                 // cannot happen unless E_min is non-monotone in the tolerance band
      anomaly('exact-infeasible@' + cd + '|' + Ts, { type: 'exactify-mismatch', cd, Tn: Ts });
      return null;
    }
    return { Tn: Ts, res };
  }

  // ---- bias crossing of E_t on one branch -----------------------------------------------------
  async function crossing(cd, Tn, dir, bStarBn, eT) {
    curStage = 'cross';
    const lim = dir > 0 ? P.bnHi : P.bnLo, q = bn => dir * bn, unq = p => dir * p;
    const state = () => {
      const recs = allRecs(cd, Tn).filter(r => q(r.bn) >= q(bStarBn)).sort((a, b) => q(a.bn) - q(b.bn));
      const starRec = recs.find(r => r.bn === bStarBn);
if (!starRec || !ok(starRec, eT)) return { absent: 'b*-over-limit' };
      let lo = recs[0], hi = null;
      for (let i = 1; i < recs.length; i++) {
        const r = recs[i];
        if (hi === null) { if (ok(r, eT)) lo = r; else { hi = r; noteTiming(r, eT); } }
        else if (ok(r, eT)) anomaly('branch-nonmonotone@' + cd + '|' + Tn + '|' + r.bn, { type: 'branch-nonmonotone', cd, Tn, dir, okBeyond: r.bn, firstOver: hi.bn });
      }
      return { lo, hi };
    };
    let st = state(), rounds = 0;
    if (st.absent) return st;
    while (rounds++ < 40) {
      if (st.hi === null) {                                                   // expand outward
        if (st.lo.bn === lim) return { absent: 'no-crossing-before-bound' };
        const base = st.lo.bn === bStarBn ? [0.02, 0.05, 0.1, 0.25, 0.5, 1.0] : Array.from({ length: P.par }, (_, i) => (i + 1) * P.biasSteps[0]);
        const pts = uniq(base.map(o => clamp(st.lo.bn + dir * Math.round(o / P.bq), P.bnLo, P.bnHi))).filter(bn => !memo.has(keyOf(cd, Tn, bn)));
        if (!pts.length) return { absent: 'no-crossing-before-bound' };
        await probe(pts.map(bn => ({ cd, Tn, bn })));
      } else {
        const loP = q(st.lo.bn), hiP = q(st.hi.bn), w = hiP - loP;
        if (w <= 1) break;
        let ps;
        if (w - 1 <= P.par) ps = spreadInner(loP, hiP, P.par);
        else {
          const vlo = v(st.lo, eT), vhi = v(st.hi, eT);
          const f = Number.isFinite(vhi) ? clamp((0 - vlo) / (vhi - vlo), 0, 1) : 0.5;
          const c = loP + Math.round(w * f), d = Math.max(1, Math.round(w * 0.01));
          ps = [c - d, c, c + d];
          for (const s of P.biasSteps) {                                       // ladder: aligned multiples of the largest step giving 1..3 interior points
            const st_ = Math.max(1, Math.round(s / P.bq)), al = [];
            for (let bn = Math.ceil((dir > 0 ? st.lo.bn : st.hi.bn) / st_) * st_; bn < (dir > 0 ? st.hi.bn : st.lo.bn); bn += st_) { const p = q(bn); if (p > loP && p < hiP) al.push(p); if (al.length > 3) break; }
            if (al.length >= 1 && al.length <= 3) { ps = ps.concat(al); break; }
          }
          ps = uniq(ps.map(p => clamp(p, loP + 1, hiP - 1)));
          if (ps.length > P.par) ps = ps.slice(0, P.par);
        }
        const pts = ps.map(unq).filter(bn => inRange(bn) && !memo.has(keyOf(cd, Tn, bn)));
        if (!pts.length) break;
        await probe(pts.map(bn => ({ cd, Tn, bn })));
      }
      st = state();
      if (st.absent) return st;
    }
    // last mile: +-2 lattice ticks around the crossing, largest E <= E_t wins
    const lo = st.lo, loP = q(lo.bn);
    const near = []; for (let p = loP - 2; p <= loP + 2; p++) { const bn = unq(p); if (q(bn) >= q(bStarBn) && inRange(bn)) near.push(bn); }
    await probe(near.map(bn => ({ cd, Tn, bn })));
    const cands = near.map(bn => memo.get(keyOf(cd, Tn, bn))).filter(r => r && ok(r, eT));
    cands.forEach(r => { if (v(r, eT) <= 0 && r.leadMax !== null) noteTiming(r, eT); });
    let best = lo; cands.forEach(r => { if (r.E > best.E) best = r; });
    return { rec: best, lo, hi: st.hi };
  }

  // ---- trace ---------------------------------------------------------------------------------
  const mkCand = (rec, branch, sub, eT) => ({
    id: [meco, rec.cd, rec.Tn, rec.bn].join('/'), meco, cd: rec.cd, G: rec.G, Tn: rec.Tn, T: rec.T, bn: rec.bn, bias: rec.bias, branch, sub: sub.name,
    E: rec.E, leadMax: rec.leadMax, coastEndT: rec.coastEndT, proxyDeployS: rec.proxyDeployS, fuelAtCoastEnd: rec.fuel,
    A: geo.pointA(rec.cd, rec.Tn), A_eff: rec.A_eff, eTarget: eT, verify: null
  });
  const traceMemo = new Map();
  async function traceSegment(cd, branch, eT) {
    const k = branch + '|' + eT + '|' + cd;
    if (traceMemo.has(k)) return traceMemo.get(k);
    const out = { cd, feasible: false, cands: [], absent: [] };
    let lowFeasible = false;
    for (const sub of geo.subs(cd)) {
      const Ts = await findMinT(cd, sub, eT, { skipIfLoInfeasible: sub.name === 'highT' && lowFeasible });
      if (!Ts) continue;
      if (sub.name === 'lowT') lowFeasible = true;
      out.feasible = true;
      out.minA = Math.min(out.minA === undefined ? Infinity : out.minA, geo.pointA(cd, Ts.Tn));
      const res = Ts.res;
      if ((branch === 'L' && res.monotone === 'R') || (branch === 'R' && res.monotone === 'L')) { out.absent.push({ sub: sub.name, reason: 'monotone-' + res.monotone }); continue; }
      const c = await crossing(cd, Ts.Tn, branch === 'R' ? 1 : -1, res.bn, eT);
      if (c.absent) { out.absent.push({ sub: sub.name, reason: c.absent }); continue; }
      out.cands.push(mkCand(c.rec, branch, sub, eT));
    }
    traceMemo.set(k, out);
    say('trace cd=' + cd + ' ' + branch + ' eT=' + eT.toFixed(4) + ': ' + (out.cands.length ? out.cands.map(c => c.sub + ' Tn=' + c.Tn + ' b=' + c.bias + ' E=' + c.E.toFixed(4)).join(' | ') : (out.feasible ? 'no ' + branch + ' crossing (' + out.absent.map(a => a.reason).join(',') + ')' : 'infeasible')));
    return out;
  }
  async function traceAll(branch, eT) {
    const cands = []; const cd0 = warm.cd, segs = [];
    const run = async cd => { const r = await traceSegment(cd, branch, eT); segs.push(r); r.cands.forEach(c => cands.push(c)); return r; };
    const r0 = await run(cd0);
    if (r0.feasible) for (let cd = cd0 - 1, n = 0; cd >= 1 && n < P.maxSegDown; cd--, n++) { const r = await run(cd); if (!r.feasible) break; }
    for (let cd = cd0 + 1, n = 0; n < P.maxSegUp; cd++, n++) {
      const aBest = Math.min(Infinity, ...segs.filter(s => s.feasible).map(s => s.minA));   // lowest feasible A so far (candidate or not)
      if (geo.pointA(cd, geo.segRange(cd).lo) > aBest + P.dAWindow) break;
      await run(cd);
    }
    return { cands, segs };
  }
  // learning probes do not need the min-A point, only a candidate AT E_t: use the anchor tick (T = 4.820) of the warm segment
  async function traceAnchor(branch, eT) {
  const cd = warm.cd, r = geo.segRange(cd);
  const tryTns = [clamp(P.splitTn, r.lo, r.hi), r.lo, r.hi];
  for (const Tn of uniq(tryTns)) {
    const res = await minAt(cd, Tn, hintFor(cd, Tn), P.tolExactTicks);
    if (res.failed || v(res.rec, eT) > 0) continue;
    if ((branch === 'L' && res.monotone === 'R') || (branch === 'R' && res.monotone === 'L')) continue;
    const c = await crossing(cd, Tn, branch === 'R' ? 1 : -1, res.bn, eT);
    if (c.absent) continue;
    return [mkCand(c.rec, branch, { name: Tn >= P.splitTn ? 'highT' : 'lowT' }, eT)];
  }
  say('anchor ' + branch + ' E_t=' + eT.toFixed(4) + ' no crossing on any of ' + tryTns.join(',') + ' -> full trace');
  return (await traceAll(branch, eT)).cands;
}
  const rank = a => a.slice().sort((x, y) => ((x.proxyDeployS === null ? Infinity : x.proxyDeployS) - (y.proxyDeployS === null ? Infinity : y.proxyDeployS)) || (x.A_eff - y.A_eff) || (x.cd - y.cd) || (x.bn - y.bn));

  // ---- Level 1 -------------------------------------------------------------------------------
  const verifyMemo = new Map();
  const startLead = warm.lead;                           // history-independent start (idempotent across calls)
  let proxyOffsetN = 0, proxyOffsetSum = 0;
  async function verifyPoint(cand) {
  if (verifyMemo.has(cand.id)) return verifyMemo.get(cand.id);
  const cached = learned.verifies && learned.verifies[cand.id];
  if (cached) { verifyMemo.set(cand.id, cached); say('INNER-2 ' + cand.id + ' (cached)'); return cached; }
  const r = await tune(ev, cfg, { A: cand.A, bias: cand.bias, meco }, { startLead, parallel: P.par });
    stats.inner2Calls++; stats.inner2Evals += r.evals || 0;
    const m = r.metrics || {};
    if (hasNum(m.coastEndEcc) && Math.abs(m.coastEndEcc - cand.E) > 1e-9 * Math.max(1, Math.abs(cand.E)))
      throw new Error('inner1: Level-0 / Level-1 disagree at ' + cand.id + ': E0=' + cand.E + ' E1=' + m.coastEndEcc + ' (determinism broken, design sec. 11)');
    const out = classifyOutcome(r);
    if (out.kind === 'ok' && hasNum(m.timeToDeployS) && hasNum(cand.proxyDeployS)) { proxyOffsetN++; proxyOffsetSum += m.timeToDeployS - cand.proxyDeployS; }
      const res = { out, r };
  verifyMemo.set(cand.id, res);
  if (learned.verifies) learned.verifies[cand.id] = res;
  say('INNER-2 ' + cand.id + ' ' + cand.branch + ' E=' + cand.E.toFixed(4) + ' -> ' + r.status + '/' + r.detail + ' (' + out.kind + ')' + (hasNum(r.lead) ? ' lead ' + r.lead.toFixed(4) : ''));
  return res;
}
  // verify one candidate; inconclusive -> retry neighbouring bias ticks (toward b* first, then away while E <= E_t)
  async function verifyCandidate(cand, eT) {
    let { out, r } = await verifyPoint(cand);
    if (out.kind !== 'inconclusive') { cand.verify = { out, r }; return { cand, out, r }; }
    const dir = cand.branch === 'R' ? 1 : -1;
    const ticks = []; for (let k = 1; k <= P.retryTicks; k++) ticks.push(-dir * k);
    for (let k = 1; k <= P.retryTicks; k++) ticks.push(dir * k);
    const nb = ticks.map(d => cand.bn + d).filter(inRange);
    const recs = await probe(nb.map(bn => ({ cd: cand.cd, Tn: cand.Tn, bn })));
    for (const rec of recs) {
      if (!rec || !ok(rec, eT)) continue;
      stats.retries++;
      const c2 = Object.assign(mkCand(rec, cand.branch, { name: cand.sub }, eT), { retriedFrom: cand.id });
      const v2 = await verifyPoint(c2);
      if (v2.out.kind !== 'inconclusive') { c2.verify = v2; return { cand: c2, out: v2.out, r: v2.r }; }
    }
    cand.verify = { out, r };
    return { cand, out, r };
  }

  // ---- learning loop + final ----------------------------------------------------------------
  const branches = ['R', 'L'];                                            // baseline (G.60, b.59) is on R
  const branchAbsent = {};
  const eFinal = {};
  const learnedVerified = [];
  let lastFinalCands = [];
  const finalOk = [], finalFallback = [], finalFailed = [], triedIds = new Set();
  const brOf = b => bracketOf(learned, meco, b, P);
  for (let pass = 0; pass < P.maxPasses; pass++) {
    const before = {}; branches.forEach(b => { before[b] = brOf(b); });
    for (const branch of branches) {
      if (branchAbsent[branch]) continue;
      curPhase = 'learn-' + branch;
      for (let it = 0; it < P.em.maxIters; it++) {
        const br = brOf(branch);
        if (br.converged) break;
        const eT = nextTarget(br, P);
        say('learn ' + branch + ' it' + it + ' bracket [' + (br.eOk === null ? '-' : br.eOk.toFixed(4)) + ', ' + (br.eFail === null ? '-' : br.eFail.toFixed(4)) + '] -> E_t ' + eT.toFixed(4));
        const cands = await traceAnchor(branch, eT);
        if (!cands.length) { notes.push('branch ' + branch + ': no boundary candidate at E_t ' + eT.toFixed(4) + ' (learning stops)'); break; }
        let concl = false, saturated = false;
        for (const c of rank(cands).slice(0, 1 + P.extraTries)) {
          const x = await verifyCandidate(c, eT);
          applyOutcome(learned, meco, branch, x.cand.E, x.out);
          if (x.out.kind !== 'inconclusive') {
            learnedVerified.push({ id: x.cand.id, branch, E: x.cand.E, kind: x.out.kind, reason: x.out.reason });
            concl = true;
            // ok but not above the previous E_ok: the Level-0 timing screen (not INNER-2) limits E -> no further upward learning possible
            if (x.out.kind === 'ok' && br.eFail === null && br.eOk !== null && x.cand.E <= br.eOk * (1 + 1e-6)) saturated = true;
            break;
          }
        }
        if (saturated) { notes.push('branch ' + branch + ': E limited by the Level-0 timing screen (tNeededS) at ' + learnedVerified[learnedVerified.length - 1].E.toFixed(4) + '; upward learning stopped'); break; }
        if (!concl) { notes.push('branch ' + branch + ': learning stalled at E_t ' + eT.toFixed(4) + ' (all candidates inconclusive; E_max NOT lowered)'); break; }
      }
    }
    // final
    const finalCands = [];
    for (const branch of branches) {
      if (branchAbsent[branch]) continue;
      curPhase = 'final-' + branch;
      const br = brOf(branch); eFinal[branch] = finalTarget(br, P);
      const { cands } = await traceAll(branch, eFinal[branch]);
      if (!cands.length) { branchAbsent[branch] = true; notes.push('branch ' + branch + ': ABSENT (no crossing candidate at E_final ' + eFinal[branch].toFixed(4) + ')'); continue; }
      finalCands.push(...cands);
      if (br.contradicted.length) anomaly('contradicted-fail@' + branch + br.contradicted.join(','), { type: 'fail-below-verified-ok', branch, fails: br.contradicted, okOwn: br.okOwn });
    }
    lastFinalCands = finalCands;
    curPhase = 'retry';
    const perKey = new Map();
    rank(finalCands).forEach(c => { const k = c.cd + '|' + c.branch; if (!perKey.has(k)) perKey.set(k, c); });
    let tried = 0;
    for (const c of rank(Array.from(perKey.values()))) {
      if (finalOk.length >= P.topK || tried >= P.topK + P.extraTries) break;
      if (triedIds.has(c.id)) continue;
      triedIds.add(c.id);
      const x = await verifyCandidate(c, c.eTarget); tried++;
      applyOutcome(learned, meco, c.branch, x.cand.E, x.out);
      if (x.out.kind === 'ok') finalOk.push(x);
      else if (x.out.kind === 'inconclusive') finalFallback.push(x);
      else finalFailed.push({ id: x.cand.id, branch: x.cand.branch, E: x.cand.E, reason: x.out.reason });
    }
    // did the evidence from the final stage move the bracket enough to redo the loop?
    const moved = pass === 0 && branches.some(b => !branchAbsent[b] && eFinal[b] !== undefined && Math.abs(finalTarget(brOf(b), P) / eFinal[b] - 1) > 0.01);
    if (!moved || finalOk.length >= P.topK) break;
    say('bracket moved during final verification -> pass ' + (pass + 2));
  }

  // ---- result --------------------------------------------------------------------------------
  const calib = proxyOffsetN ? proxyOffsetSum / proxyOffsetN : null;
  const dress = x => {
    const m = x.r && x.r.metrics ? x.r.metrics : null;
    let score = null;
    if (m && typeof ev.score === 'function') { try { const s = ev.score(m, {}); score = hasNum(s) ? s : (s && hasNum(s.score) ? s.score : null); } catch (e) { score = null; } }
    return Object.assign({}, x.cand, {
      lead: x.r ? x.r.lead : null, leadTicks: x.r ? x.r.leadTicks : null, marginS: x.r ? x.r.achievedMarginS : null, windowReached: !!(x.r && x.r.windowReached),
      innerStatus: x.r ? x.r.status + '/' + x.r.detail : null, metrics: m, score,
      deployEstS: calib !== null && hasNum(x.cand.proxyDeployS) ? x.cand.proxyDeployS + calib : null, verify: undefined
    });
  };
  const sortFull = (a, b) => ((a.score === null ? Infinity : a.score) - (b.score === null ? Infinity : b.score)) || (a.A_eff - b.A_eff);
  const ranked = finalOk.map(dress).sort(sortFull);
  const fallback = finalFallback.map(dress).sort(sortFull);
  const eMinRows = Array.from(eMinTable.values()).sort((a, b) => a.cd - b.cd || a.Tn - b.Tn);
  let reason = null;
  if (!ranked.length) reason = fallback.length ? 'only window-skipped / inconclusive candidates (lead too coarse); see fallback' : 'no feasible verified point: see eMinTable and notes';
  stats.wallS = Math.round((Date.now() - t0) / 1000);
  return {
    meco, best: ranked[0] || null, ranked, fallback, reason, failed: finalFailed, candidates: lastFinalCands,
    brackets: { L: brOf('L'), R: brOf('R') }, eFinal, branchAbsent, learnedVerified, proxyOffsetS: calib,
    learned, stats, anomalies, notes, log, eMinTable: eMinRows, warm
  };
}

module.exports = {
  searchBoundary, loadLearned, saveLearned, newLearned, signature, emapHintsFromCsv,
  // pure pieces (tests)
  params, makeGeo, warmStart, bracketOf, nextTarget, finalTarget, classifyOutcome, applyOutcome
};
