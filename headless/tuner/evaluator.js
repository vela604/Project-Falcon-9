// ============================================================================
// headless/tuner/evaluator.js — the core of the tuner.
//
//   const { createEvaluator, loadConfig } = require('./evaluator');
//   const ev = createEvaluator(loadConfig('tuner/tuner-config-v3.json'), { workers: 8 });
//   const r  = await ev.evaluate({ ascent_profile_constant: 13.94, ... });
//   const rs = await ev.evaluateMany([v1, v2, ...]);     // parallel, cached
//   const r0 = ev.evaluateSync(values, { snap:false, ascent_G:0.60, ascent_T:4.82 }); // in-process
//   await ev.close();
//
// One evaluation = one runSim() on a lattice-snapped tunable set. Returns
//   { score, hardFail, depth, failures[], metrics, effective, lattice, evalKind,
//     wallMs, cached }
// `metrics` is always returned so phase code can build its own objective.
//
// Values object keys = tunable ids from the config. Missing ids default to
// the config's `initial`. Everything submitted to the sim is rounded to the
// hardware least count (PROMPT.md); time constants are stored as INTEGER TICKS
// (n/80 s). Ascent collapse (A -> G,T,A_eff) is done here; callers must feed
// `effective.A_eff` (NOT the A they proposed) back to CMA-ES.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const TICKS_PER_S = 80;                       // sim DT = 1/80 s (verified at run time)
const DEFAULT_WORKERS = 8;
const HOOK_CODE = fs.readFileSync(path.join(__dirname, 'hook-sandbox.js'), 'utf8');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(p) {
  // The config is plain JSON even if the file is named .js (as uploaded).
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stableHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function decimalsOf(q) {
  const s = String(q);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function tunableById(cfg, id) {
  const t = cfg.tunables.find(x => x.id === id);
  if (!t) throw new Error('config has no tunable "' + id + '"');
  return t;
}

// ---------------------------------------------------------------------------
// Lattice snapping + ascent collapse
// ---------------------------------------------------------------------------
// Direct tunable -> { n, value } where n is the integer lattice index.
function snapDirect(t, x) {
  if (!Number.isFinite(x)) throw new Error(t.id + ': non-finite value ' + x);
  const q = t.quantum;
  if (t.unit === 's') {                        // time: integer ticks
    const stepTicks = Math.max(1, Math.round(q * TICKS_PER_S));
    const n = Math.round(x * TICKS_PER_S / stepTicks);
    return { n, value: (n * stepTicks) / TICKS_PER_S };
  }
  const n = Math.round(x / q);
  return { n, value: Number((n * q).toFixed(decimalsOf(q))) };
}

// Ascent collapse (PROMPT "Ascent collapse (2 -> 1)"):
//   G_raw = A/T0^2 -> round 0.01 deg -> T_raw = sqrt(A/G) -> round to 1 tick -> A_eff = G*T^2
function collapseAscent(t, A) {
  const T0 = t.anchorPushT_s;
  const gq = t.gimbalQuantumDeg;
  const cd = Math.max(1, Math.round((A / (T0 * T0)) / gq));
  const G = Number((cd * gq).toFixed(decimalsOf(gq)));
  const Tticks = Math.max(1, Math.round(Math.sqrt(A / G) * TICKS_PER_S));
  const T = Tticks / TICKS_PER_S;
  return { cd, Tticks, G, T, A_eff: G * T * T };
}

// Returns everything needed to fly + cache a candidate.
//   opts.snap === false : submit raw numbers (baseline reproduction).
//       ascent: use opts.ascent_G / opts.ascent_T if given, else A -> (A/T0^2, T0)
function snapValues(cfg, values, opts) {
  values = values || {};
  opts = opts || {};
  const raw = opts.snap === false;
  const val = id => (values[id] !== undefined ? values[id] : tunableById(cfg, id).initial);

  const tA = tunableById(cfg, 'ascent_profile_constant');
  const tB = tunableById(cfg, 'stage_burn_aoa_bias');
  const tM = tunableById(cfg, 'stage_burn_aoa_margin');
  const tL = tunableById(cfg, 'circ_trigger_lead');
  const tF = tunableById(cfg, 'meco_target_booster_fuel');

  const eff = {};
  const lat = {};
  const sim = {};   // path -> value actually submitted

  // --- ascent ---
  const A = val(tA.id);
  if (raw) {
    const G = opts.ascent_G !== undefined ? opts.ascent_G : A / (tA.anchorPushT_s * tA.anchorPushT_s);
    const T = opts.ascent_T !== undefined ? opts.ascent_T : tA.anchorPushT_s;
    eff.ascent_G = G; eff.ascent_T = T; eff.A_eff = G * T * T;
    lat.ascent = ['raw', G, T];
    sim['ascent.PUSH_MAX_GIMBAL_DEG'] = G;
    sim['ascent.PUSH_T_S'] = T;
  } else {
    const c = collapseAscent(tA, A);
    eff.ascent_G = c.G; eff.ascent_T = c.T; eff.ascent_Tticks = c.Tticks; eff.A_eff = c.A_eff;
    lat.ascent = [c.cd, c.Tticks];
    sim['ascent.PUSH_MAX_GIMBAL_DEG'] = c.G;
    sim['ascent.PUSH_T_S'] = c.T;
  }
  // --- direct ones ---
  [[tB, 'bias'], [tM, 'margin'], [tL, 'lead'], [tF, 'meco']].forEach(([t, key]) => {
    const x = val(t.id);
    if (raw) {
      eff[key] = x; lat[key] = ['raw', x];
      sim[t.path] = x;
    } else {
      const s = snapDirect(t, x);
      eff[key] = s.value; lat[key] = s.n;
      sim[t.path] = s.value;
    }
  });
  eff.circ_trigger_lead = eff.lead;
  return { effective: eff, lattice: lat, simValues: sim, raw };
}

// ---------------------------------------------------------------------------
// Evaluation context (mission + env + fixed) -> hash used in cache keys
// ---------------------------------------------------------------------------
function targetAltOf(cfg, opts) {
  return Number.isFinite(opts && opts.targetAltKm) ? opts.targetAltKm : cfg.mission.targetOrbitAltKm;
}

function buildTunablePayload(cfg, snapped, targetAltKm) {
  const out = [];
  (cfg.fixed || []).forEach(f => {
    let v = f.value;
    if (f.path === 'insertion.TARGET_ORBIT_ALT_KM') v = targetAltKm;   // --target-alt override
    out.push({ path: f.path, value: v });
  });
  Object.keys(snapped.simValues).forEach(p => out.push({ path: p, value: snapped.simValues[p] }));
  return out;
}

function contextHash(cfg, opts) {
  return stableHash({
    mission: cfg.mission, fixed: cfg.fixed, hook: stableHash(HOOK_CODE),
    targetAltKm: targetAltOf(cfg, opts), stride: cfg.evaluator && cfg.evaluator.stride
  });
}

// ---------------------------------------------------------------------------
// Metrics extraction (hook output + tracker -> flat metrics)
// ---------------------------------------------------------------------------
function fin(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }

function extractMetrics(result, evalKind) {
  const h = result.hook;
  if (!h) throw new Error('runSim returned no hook metrics (extraBootstrapCode not active?)');
  if (Math.abs(h.dt - 1 / TICKS_PER_S) > 1e-12) {
    throw new Error('sim DT is ' + h.dt + ', evaluator lattice assumes 1/' + TICKS_PER_S);
  }
  const st = result.status;
  const tr = result.tracker;
  const c = h.circ;

  // Orbit used for scoring: payload body after clear > stage at deploy cmd > stage after clear.
  let orbit = null, orbitSource = null;
  if (h.cleared && h.cleared.payloadOrbit && h.cleared.payloadOrbit.bound) { orbit = h.cleared.payloadOrbit; orbitSource = 'payload@cleared'; }
  else if (h.deploy && h.deploy.bound) { orbit = h.deploy; orbitSource = 'stage@deploy'; }
  else if (h.cleared && h.cleared.stageOrbit && h.cleared.stageOrbit.bound) { orbit = h.cleared.stageOrbit; orbitSource = 'stage@cleared'; }

  const stage = st.bodies && st.bodies[0];
  const m = {
    evalKind,
    // orbit
    apogeeKm: orbit ? fin(orbit.apoKm) : null,
    perigeeKm: orbit ? fin(orbit.periKm) : null,
    ecc: orbit ? fin(orbit.e) : null,
    orbitSource,
    stageDeployApoKm: h.deploy ? fin(h.deploy.apoKm) : null,
    stageDeployPeriKm: h.deploy ? fin(h.deploy.periKm) : null,
    guideApoKmAtDeploy: h.deploy ? fin(h.deploy.guideApoKm) : null,
    guidePeriKmAtDeploy: h.deploy ? fin(h.deploy.guidePeriKm) : null,
    // coast-entry proxy orbit (truncated eval)
    coastApoKm: h.coast ? fin(h.coast.apoKm) : null,
    coastPeriKm: h.coast ? fin(h.coast.periKm) : null,
    coastEcc: h.coast ? fin(h.coast.e) : null,
    stageFuelAtCoastKg: h.coast ? fin(h.coast.stageFuelKg) : null,
    // circ burn
    circBurnStarted: c.burnStartT !== null,
    circBurnEnded: c.burnEndT !== null,
    circMinVr: fin(c.vrBurnMin),
    circPhaseMinVr: fin(c.vrPhaseMin),
    circVrAtEnd: fin(c.vrAtEnd),                      // vr when the burn ended (recovery check)
    circVrMinT: fin(c.vrMinT),
    circEndMarginS: fin(c.tToApoAtEndS),              // time to apogee of post-burn orbit
    circEndMarginPreApoS: fin(c.tToPreBurnApoAtEndS), // alt definition (pre-burn apogee direction)
    circBurnS: (c.burnStartT !== null && c.burnEndT !== null) ? c.burnEndT - c.burnStartT : null,
    // fuel / timing
    boosterFuelLeftKg: h.split ? fin(h.split.boosterFuelKg) : null,
    stageFuelAtSplitKg: h.split ? fin(h.split.stageFuelKg) : null,
    stageResidualKg: h.cleared ? fin(h.cleared.stageFuelKg) : null,
    timeToDeployS: h.deploy ? fin(h.deploy.cmdT) : null,
    mecoT: fin(h.mecoT),
    // limits
    maxG: fin(h.maxGLoad), maxGT: fin(h.maxGLoadT), maxAccelRawG: fin(h.maxAccelRawG),
    maxQKPa: fin(tr.maxQKPa),
    stageMaxAltKm: fin(h.stageMaxAltKm),
    stageCrashed: !!h.stageCrashed || !!(stage && stage.crashed),
    anyCrashed: !!h.anyCrashed,
    payloadCleared: !!h.cleared,
    // run info
    simEndT: fin(h.simT),
    stopReason: h.stopReason || (result.stoppedEarly ? 'stopped' : 'duration_cap'),
    deadReason: h.deadReason || null,
    phaseT: h.phaseT,
    ticksRun: result.ticksRun
  };
  return m;
}

// ---------------------------------------------------------------------------
// Scoring (lower = better). Pure function of metrics -> unit-testable.
// ---------------------------------------------------------------------------
function softTermPenalty(term, x, targetOverride) {
  if (term.mode === 'deadzoneAbs') {
    const target = targetOverride !== undefined ? targetOverride : term.target;
    const err = Math.max(0, Math.abs(x - target) - (term.tolerance || 0)) / (term.scale || 1);
    return term.weight * err;
  }
  throw new Error('unknown soft-term mode ' + term.mode);
}

function constraintEnforced(hc) {
  if (!hc) return false;
  if (hc.enabled === false) return false;
  if (hc.calibrate === true) return false;     // placeholder limit, not yet calibrated (Step 3)
  return Number.isFinite(hc.limit);
}

function scoreMetrics(m, cfg, opts) {
  opts = opts || {};
  const sc = cfg.scoring;
  const hc = sc.hardConstraints;
  const target = targetAltOf(cfg, opts);
  const failPenalty = sc.failPenalty;
  const truncated = m.evalKind === 'truncated';
  const failures = [];
  let depth = 0;
  const add = (id, d) => { failures.push({ id, depth: d }); depth += d; };

  // orbit used for graded depth in every failure (always gives CMA a slope)
  const oApo = truncated ? m.coastApoKm : m.apogeeKm;
  const oPeri = truncated ? m.coastPeriKm : m.perigeeKm;
  const orbitDeficit = (oApo !== null && oPeri !== null)
    ? Math.min(1e4, Math.abs(oApo - target) + (truncated ? 0 : Math.abs(oPeri - target)))
    : 1e4;

  if (m.stageCrashed) add('crashed', 5000 + 10 * Math.max(0, target - (m.stageMaxAltKm || 0)));
  if (constraintEnforced(hc.maxQKPa) && m.maxQKPa !== null && m.maxQKPa > hc.maxQKPa.limit) {
    add('maxQ', 1000 * (m.maxQKPa - hc.maxQKPa.limit));
  }
  if (constraintEnforced(hc.maxG) && m.maxG !== null && m.maxG > hc.maxG.limit) {
    add('maxG', 1000 * (m.maxG - hc.maxG.limit));
  }
  if (m.deadReason) add('mission_ended_abnormally', 3000);

  if (truncated) {
    if (m.coastApoKm === null) add('no_coast_orbit', 3000);
  } else {
    // vr may dip below 0 and recover (physics); only a dip below hardFloor is a hard fail.
    // Dips between hardFloor and `min` get a small soft penalty (see below).
    const vc = hc.circMinRadialVelocityMps || {};
    const vrSoft = Number.isFinite(vc.min) ? vc.min : 0;
    const vrHard = Number.isFinite(vc.hardFloor) ? vc.hardFloor : vrSoft;
    if (!m.circBurnStarted) add('circ_never_burned', 3000);
    else if (m.circMinVr !== null && m.circMinVr < vrHard) add('circ_vr_too_negative', 100 * (vrHard - m.circMinVr));
    if (hc.payloadMustBeReleasedAndCleared !== false && !m.payloadCleared) add('payload_not_cleared', 2000);
    if (m.apogeeKm === null || m.perigeeKm === null) add('no_final_orbit', 3000);
  }

  if (failures.length) {
    const d = depth + orbitDeficit;
    return { score: failPenalty + d, hardFail: true, depth: d, failures, soft: null };
  }

  // ---- soft score ----
  const soft = {};
  let pos = 0, neg = 0;
  const capEach = failPenalty * 0.1;
  const terms = truncated ? truncatedTerms(sc) : sc.softTerms;
  terms.forEach(term => {
    let p = 0;
    switch (term.id) {
      case 'apogeeErrKm':       p = softTermPenalty(term, truncated ? m.coastApoKm : m.apogeeKm, target); break;
      case 'perigeeErrKm':      p = softTermPenalty(term, truncated ? m.coastPeriKm : m.perigeeKm, target); break;
      case 'eccentricity':      p = softTermPenalty(term, truncated ? m.coastEcc : m.ecc); break;
      case 'boosterFuelLeftKg': p = -(term.weightPerKg || 0) * (m.boosterFuelLeftKg || 0); break;
      case 'timeToDeployS':     p = truncated ? 0 : (term.weightPerS || 0) * (m.timeToDeployS || 0); break;
      default: throw new Error('unknown soft term ' + term.id);
    }
    p = Math.min(p, capEach);
    soft[term.id] = p;
    if (p >= 0) pos += p; else neg += p;
  });
  // vr-dip tie-breaker (full evals only): accuracy impact is already in the orbit terms.
  if (!truncated && m.circMinVr !== null) {
    const vc = hc.circMinRadialVelocityMps || {};
    const vrSoft = Number.isFinite(vc.min) ? vc.min : 0;
    const p = Math.min((vc.softWeightPerMps || 0) * Math.max(0, vrSoft - m.circMinVr), capEach);
    soft.circVrDip = p; pos += p;
  }
  return { score: pos + neg, hardFail: false, depth: 0, failures: [], soft };
}

// Truncated (stop at COAST_ROTATE) is a PROXY: at coast entry the orbit is
// intentionally eccentric (circ burn comes later), so only apogee is scored at
// full weight; ecc / perigee are weak guides. Phase code may ignore this and
// build its own objective from `metrics`. Optional override: config.scoring.truncatedTerms.
function truncatedTerms(sc) {
  if (Array.isArray(sc.truncatedTerms)) return sc.truncatedTerms;
  const find = id => sc.softTerms.find(t => t.id === id);
  const out = [];
  const a = find('apogeeErrKm'); if (a) out.push(a);
  const e = find('eccentricity');
  if (e) out.push(Object.assign({}, e, { weight: e.weight * 0.02 }));
  return out;
}

// ---------------------------------------------------------------------------
// One evaluation, in this process (also what each worker runs)
// ---------------------------------------------------------------------------
function evalCore(cfg, values, opts) {
  const { runSim } = require('../runner');
  opts = opts || {};
  const evalKind = opts.eval === 'truncated' ? 'truncated' : 'full';
  const targetAltKm = targetAltOf(cfg, opts);
  const snapped = snapValues(cfg, values, opts);
  const stopAt = evalKind === 'truncated' ? 'coastRotate' : 'payloadCleared';
  const ms = cfg.mission;
  const durationS = Number.isFinite(opts.durationCapS) ? opts.durationCapS : ms.durationCapS;

  const result = runSim({
    stackId: ms.stackId,
    vehicleId: ms.vehicleId,
    guide: ms.guide,
    durationS,
    environment: ms.environment,
    fueling: ms.fueling,
    quiet: true,
    tunables: buildTunablePayload(cfg, snapped, targetAltKm),
    resetGuideConfig: true,                     // never leak the previous eval's constants
    extraBootstrapCode: HOOK_CODE,
    hookOptions: {
      stopAt,
      stride: (cfg.evaluator && cfg.evaluator.stride) || 4,
      flowThreshKgS: 1
    }
  });
  const metrics = extractMetrics(result, evalKind);
  metrics.wallMs = result.wallMs;
  return { metrics, effective: snapped.effective, lattice: snapped.lattice, wallMs: result.wallMs };
}

function finalize(cfg, core, opts, cached) {
  const s = scoreMetrics(core.metrics, cfg, opts);
  return {
    score: s.score, hardFail: s.hardFail, depth: s.depth, failures: s.failures, soft: s.soft,
    metrics: core.metrics, effective: core.effective, lattice: core.lattice,
    evalKind: core.metrics.evalKind, wallMs: core.wallMs, cached: !!cached
  };
}

// ---------------------------------------------------------------------------
// Worker pool (worker_threads; each worker loads the sim once, then reuses it)
// ---------------------------------------------------------------------------
class EvalPool {
  constructor(cfg, n) {
    this.cfg = cfg;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    for (let i = 0; i < n; i++) this._spawn();
  }
  _spawn() {
    const w = new Worker(path.join(__dirname, 'eval-worker.js'), { workerData: { cfg: this.cfg } });
    w.on('message', msg => {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      w._busyId = null;
      if (p) { if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.core); }
      this.idle.push(w);
      this._pump();
    });
    w.on('error', err => {
      const p = w._busyId != null ? this.pending.get(w._busyId) : null;
      if (p) { this.pending.delete(w._busyId); p.reject(err); }
      this.workers = this.workers.filter(x => x !== w);
      if (!this.closed) this._spawn();           // replace a dead worker
    });
    this.workers.push(w);
    this.idle.push(w);
  }
  run(values, opts) {
    return new Promise((resolve, reject) => {
      this.queue.push({ values, opts, resolve, reject });
      this._pump();
    });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      const id = this.nextId++;
      w._busyId = id;
      this.pending.set(id, { resolve: job.resolve, reject: job.reject });
      w.postMessage({ id, values: job.values, opts: job.opts });
    }
  }
  async close() {
    this.closed = true;
    await Promise.all(this.workers.map(w => w.terminate()));
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
function resolveWorkers(cfg, o) {
  if (Number.isInteger(o.workers) && o.workers >= 0) return o.workers;
  const env = parseInt(process.env.TUNER_WORKERS, 10);
  if (Number.isInteger(env) && env >= 0) return env;
  const c = cfg.cma && cfg.cma.parallelWorkers;
  if (Number.isInteger(c) && c >= 0) return c;
  return DEFAULT_WORKERS;                        // "auto" = 8 for now; override via option/env for cloud
}

function createEvaluator(cfg, o) {
  o = o || {};
  const nWorkers = resolveWorkers(cfg, o);
  let pool = null;
  const cache = new Map();                       // lattice-point cache (core results; score recomputed)
  const stats = { hits: 0, misses: 0 };

  function key(values, opts) {
    const sn = snapValues(cfg, values, opts);
    const k = contextHash(cfg, opts) + '|' + (opts && opts.eval === 'truncated' ? 'T' : 'F') +
      '|' + JSON.stringify(sn.lattice) + '|' + (opts && opts.durationCapS || '');
    return k;
  }
  function getPool() { if (!pool) pool = new EvalPool(cfg, nWorkers); return pool; }

  function evaluateSync(values, opts) {
    opts = opts || {};
    const k = key(values, opts);
    let core = cache.get(k), cached = true;
    if (!core) { stats.misses++; core = evalCore(cfg, values, opts); cache.set(k, core); cached = false; }
    else stats.hits++;
    return finalize(cfg, core, opts, cached);
  }

  async function evaluateMany(list, opts) {
    opts = opts || {};
    const keys = list.map(v => key(v, opts));
    const todo = new Map();                      // key -> index of first occurrence
    keys.forEach((k, i) => { if (!cache.has(k) && !todo.has(k)) todo.set(k, i); });
    stats.hits += keys.length - todo.size;
    stats.misses += todo.size;
    if (todo.size) {
      const entries = Array.from(todo.entries());
      const runOne = nWorkers > 0
        ? ([k, i]) => getPool().run(list[i], opts).then(core => cache.set(k, core))
        : ([k, i]) => Promise.resolve().then(() => cache.set(k, evalCore(cfg, list[i], opts)));
      await Promise.all(entries.map(runOne));
    }
    const seen = new Set(todo.keys());
    return keys.map(k => {
      const first = seen.delete(k);              // first occurrence of a freshly-run key = not cached
      return finalize(cfg, cache.get(k), opts, !first);
    });
  }

  async function evaluate(values, opts) { return (await evaluateMany([values], opts))[0]; }

  return {
    evaluate, evaluateMany, evaluateSync,
    snap: (values, opts) => snapValues(cfg, values, opts),
    score: (metrics, opts) => scoreMetrics(metrics, cfg, opts),
    cacheStats: () => ({ size: cache.size, hits: stats.hits, misses: stats.misses }),
    exportCache: () => Array.from(cache.entries()),
    importCache: entries => entries.forEach(([k, v]) => cache.set(k, v)),
    workers: nWorkers,
    close: async () => { if (pool) { await pool.close(); pool = null; } }
  };
}

module.exports = {
  createEvaluator, loadConfig, evalCore, snapValues, snapDirect, collapseAscent,
  scoreMetrics, extractMetrics, buildTunablePayload, HOOK_CODE, TICKS_PER_S, DEFAULT_WORKERS
};
