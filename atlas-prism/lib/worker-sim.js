// worker-sim.js — sim instance running in a Web Worker.
//
// Loads the same sim files as the main page (importScripts), then exposes
// a job interface via postMessage. Currently the only job type is 'runEval'.
//
// IMPORTANT: Web Workers have no localStorage. fleet.js / componentLibrary.js
// both read from it at load time. We stub localStorage with an in-memory
// store and hydrate it from the main thread BEFORE the sim files load.
//
// Load order inside the worker matches atlas-prism/index.html exactly.

// ---- 1. Provide a fake localStorage before anything else loads ----
self.localStorage = (function() {
  const _data = Object.create(null);
  return {
    getItem(k) { return k in _data ? _data[k] : null; },
    setItem(k, v) { _data[k] = String(v); },
    removeItem(k) { delete _data[k]; },
    clear() { Object.keys(_data).forEach(k => delete _data[k]); },
    get length() { return Object.keys(_data).length; },
    key(i) { return Object.keys(_data)[i] || null; },
    _raw() { return _data; },
    _populate(obj) { Object.keys(obj || {}).forEach(k => { if (obj[k] != null) _data[k] = String(obj[k]); }); }
  };
})();

// Alias window=self so sim files referencing window.* work in the worker.
// localStorage is already stubbed above; self.addEventListener exists in workers.
// window.document is deliberately NOT stubbed — files that need it will throw,
// and we can add a targeted stub if that specific access shows up.
self.window = self;

// Worker tag for live progress messages
const _workerTag = 'w' + Math.random().toString(36).slice(2, 6);
function emit(phase, detail) {
  try { self.postMessage({ type: 'progress', tag: _workerTag, phase, detail, ts: Date.now() }); } catch (e) {}
}

// ---- 2. Job state ----
let _loaded = false;
let _bootError = null;

function _loadSim() {
  if (_loaded) return;
  try {
    importScripts(
      '../../js/componentLibrary.js',
      '../../js/customDesign.js',
      '../../js/fleet.js',
      '../../js/config.js',
      '../../js/simJs/core/massProps.js',
      '../../js/simJs/core/environment.js',
      '../../js/simJs/core/vehicle.js',
      '../../js/simJs/core/rcs.js',
      '../../js/simJs/core/physics.js',
      '../../js/simJs/core/collision.js',
      '../../js/simJs/guidance/imu.js',
      '../../js/simJs/guidance/derivation.js',
      '../../js/simJs/guidance/guidercs.js',
      '../../js/simJs/guidance/guidance-blocks.js',
      '../../js/simJs/guidance/guidance.js',
      '../../js/guideConfigDefaults.js',
      '../lib/config.js',
      '../lib/sim.js',
      '../lib/lattice.js',
      '../lib/hook.js',
      '../lib/registry.js',
      '../lib/primitives.js',
      '../engines/pro-alpha.js'
    );
    if (typeof TunerEngine === 'undefined') throw new Error('TunerEngine not loaded');
    TunerEngine.init();
    _loaded = true;
  } catch (e) {
    _bootError = (e && e.message) || String(e);
    throw e;
  }
}

// ---- 3. Message handler ----
// ---------------- snapshot / restore (mirrors checkpoint-bias.html) ----------------
function deepClone(x, memo) {
  memo = memo || new WeakMap();
  if (x === null || typeof x !== 'object') return x;
  if (memo.has(x)) return memo.get(x);
  if (Array.isArray(x)) { const a = []; memo.set(x, a); for (let i = 0; i < x.length; i++) a[i] = deepClone(x[i], memo); return a; }
  const o = {}; memo.set(x, o); for (const k of Object.keys(x)) o[k] = deepClone(x[k], memo); return o;
}

let _saSnapshot = null;

function captureSA() {
  const st = {};
  Object.keys(self.state).forEach(k => { if (k === 'bodies') return; try { st[k] = deepClone(self.state[k]); } catch (e) { st[k] = null; } });
  return {
    bodies: deepClone(self.state.bodies),
    stateKeysSnapshot: st,
    simTime: self.state.simTime,
    activeBodyIndex: self.state.activeBodyIndex,
    guidanceState: self.Guidance.exportGuideState(),
  };
}

function restoreSA(snap, newBias) {
  Object.keys(snap.stateKeysSnapshot).forEach(k => {
    try { self.state[k] = deepClone(snap.stateKeysSnapshot[k]); } catch (e) {}
  });
  self.state.simTime = snap.simTime;
  self.state.activeBodyIndex = snap.activeBodyIndex;
  const sb = snap.bodies;
  while (self.state.bodies.length > sb.length) self.state.bodies.pop();
  while (self.state.bodies.length < sb.length) self.state.bodies.push({});
  for (let i = 0; i < sb.length; i++) {
    const src = sb[i], dst = self.state.bodies[i];
    Object.keys(dst).forEach(k => { delete dst[k]; });
    Object.keys(src).forEach(k => { dst[k] = deepClone(src[k]); });
  }
  const ab = self.state.bodies[self.state.activeBodyIndex];
  if (ab) ['rx','ry','vx','vy','theta','omega','dryMass','fuelMass'].forEach(k => {
    try { self.state[k] = ab[k]; } catch (e) {}
  });
  for (const b of self.state.bodies) {
    if (!b || !b.members || !b.members.length) continue;
    if (b._lastBottomMember && b._lastBottomMember.id) {
      const m = b.members.find(mm => mm && mm.id === b._lastBottomMember.id);
      if (m) b._lastBottomMember = m;
    }
  }
  const g = deepClone(snap.guidanceState);
  if (newBias !== undefined && newBias !== null) {
    if (g.guideConfigs && g.guideConfigs.leoInsertionV3 && g.guideConfigs.leoInsertionV3.insertion) {
      g.guideConfigs.leoInsertionV3.insertion.STAGE_BURN_AOA_BIAS_DEG = newBias;
    }
    if (g.v3InsertionBlock && g.v3InsertionBlock.constants) {
      g.v3InsertionBlock.constants.STAGE_BURN_AOA_BIAS_DEG = newBias;
    }
  }
  self.Guidance.importGuideState(g);
}

async function tickUntil(predicate, maxTicks) {
  for (let i = 0; i < maxTicks; i++) {
    if (self.state.halted) return false;
    self.TunerEngine.tick(self.CONFIG.DT);
    if (predicate()) return true;
  }
  return false;
}

function currentPhase() {
  const gs = self.Guidance.getGuideStatus();
  return gs && gs.phase;
}

// ---------------- message handler ----------------
self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type, payload } = msg;
  
  if (type === 'hydrate') {
    self.localStorage._populate(payload && payload.keys);
    try {
      _loadSim();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'ready', error: _bootError });
    }
    return;
  }
  
  if (!_loaded) {
    self.postMessage({ id, ok: false, error: 'sim not loaded (hydrate first)' });
    return;
  }
  
  try {
    let result;
    if (type === 'runEval') {
      result = await TunerHook.runEval(payload.point, payload.opts || {});
    } else if (type === 'runEvalValues') {
      result = await TunerHook.runEvalValues(payload.values, payload.opts || {});
    } else if (type === 'probeWithLead') {
      // Full chain: tuneLead + FULL eval, returns score.
      const point = payload.point;
      const altKm = payload.altKm != null ? payload.altKm : 320;
      const cache = new TunerUtils.EvalCache();
      const lr = await TunerCore.tuneLead(point, {
        hook: TunerHook, cache, targetAltKm: altKm,
      });
      if (!lr.ok) {
        result = { ok: false, reason: 'lead_failed: ' + lr.reason, lead: lr.lead, margin: lr.marginS, evals: lr.evals };
      } else {
        const m = await TunerHook.runEval(lr.point, { stopAt: 'FULL', targetAltKm: altKm, quiet: true });
        const sc = TunerUtils.score(m, { targetAltKm: altKm });
        result = {
          ok: sc.ok, lead: lr.lead, margin: lr.marginS, vrEnd: lr.vrEnd,
          score: sc.score, reasons: sc.reasons, parts: sc.parts,
          metrics: {
            endReason: m.endReason, deployTimeS: m.deployTimeS,
            apogeeKm: m.apogeeKm, perigeeKm: m.perigeeKm, ecc: m.ecc,
            boosterFuelLeftKg: m.boosterFuelLeftKg, stageResidualKg: m.stageResidualKg,
            maxQKPa: m.maxQKPa, maxG: m.maxG,
            payloadCleared: m.payloadCleared, payloadReleased: m.payloadReleased,
            crashed: m.crashed,
          },
          evals: lr.evals + 1,
        };
      }
    } else if (type === 'setupSA') {
      // Run G/T/MECO point until SEPARATED_AXIAL entry, save snapshot in worker.
      const values = payload.values;
      emit('setupSA', 'start');
      self.TunerEngine.prepareRun(self.TunerConfig.guideName, values, payload.env || self.TunerConfig.env);
      const maxTicks = Math.ceil(300 / self.CONFIG.DT);
      const reached = await tickUntil(() => currentPhase() === 'SEPARATED_AXIAL', maxTicks);
      if (!reached) {
        emit('setupSA', 'fail phase=' + currentPhase());
        result = { ok: false, reason: 'SA not reached, phase=' + currentPhase() };
      } else {
        _saSnapshot = captureSA();
        emit('setupSA', 'done t=' + _saSnapshot.simTime.toFixed(2));
        result = { ok: true, simTime: _saSnapshot.simTime };
      }
    } else if (type === 'probeBiasCheckpoint') {
      // Restore SA snapshot, set bias, run to CW → CH, then tuneLead + FULL.
      if (!_saSnapshot) { result = { ok: false, reason: 'no SA snapshot — call setupSA first' }; }
      else {
        const newBias = payload.bias;
        const altKm = payload.altKm != null ? payload.altKm : 320;
        const tag = 'b=' + newBias.toFixed(3);
        emit('probe', tag + ' restore+runToCH');
        restoreSA(_saSnapshot, newBias);
        // Run from SA to CH entry
        const maxTicks = Math.ceil(800 / self.CONFIG.DT);
        const reached = await tickUntil(() => currentPhase() === 'COAST_HOLD', maxTicks);
        if (!reached) {
          emit('probe', tag + ' CH_FAIL phase=' + currentPhase());
          result = { ok: false, reason: 'CH not reached after restore, phase=' + currentPhase() };
        } else {
          emit('probe', tag + ' reached CH, tuneLead');
          // Build a point at CH — tuneLead only needs Gi,Tn,bi,li,meco for lattice key; the actual sim state is already restored.
          const Q = self.TunerConfig.quanta;
          const c = self.Guidance.getGuideConfig('leoInsertionV3');
          const point = {
            Gi: Math.round(c.ascent.PUSH_MAX_GIMBAL_DEG / Q.G),
            Tn: Math.round(c.ascent.PUSH_T_S / Q.T),
            bi: Math.round(c.insertion.STAGE_BURN_AOA_BIAS_DEG / Q.bias),
            li: Math.round(c.insertion.CIRC_TRIGGER_LEAD_S / Q.lead),
            meco: c.ascent.MECO_TARGET_BOOSTER_FUEL_KG,
          };
          // tuneLead with a checkpoint-based hook: each CIRC_END eval restores SA, sets bias + new lead, runs to CH + CIRC_END.
          const cache = new self.TunerUtils.EvalCache();
          let _evalN = 0;
          const CPHook = {
            runEval: async (p2, o) => {
              _evalN++;
              const lead = p2.li * Q.lead;
              emit('probe', tag + ' eval#' + _evalN + ' lead=' + lead.toFixed(4));
              restoreSA(_saSnapshot, newBias);
              // Override lead in guidance config
              const g = self.Guidance.getGuideConfig('leoInsertionV3');
              g.insertion.CIRC_TRIGGER_LEAD_S = lead;
              self.Guidance.applyGuideConfig('leoInsertionV3', g);
              // Run to CIRC_END (through CH, CIRCULARIZE)
              const reached2 = await tickUntil(() => currentPhase() === 'COAST_ROTATE_2' || self.state.halted, maxTicks);
              if (!reached2) return { endReason: 'CAP', crashed: self.state.crashed, vrEnd: NaN, marginS: NaN, vrMin: NaN };
              // Extract vrEnd/margin from stage body
              const stb = (function() {
                for (const b of self.state.bodies) {
                  if (b && !b.payloadBody && !b.fairingHalf && b.members && b.members[0] && b.members[0].stageRole === 'stage') return b;
                }
                return null;
              })();
              if (!stb) return { endReason: 'NO_STAGE', crashed: false, vrEnd: NaN, marginS: NaN, vrMin: NaN };
              const r = Math.hypot(stb.rx, stb.ry);
              const vr = (stb.vx * stb.rx + stb.vy * stb.ry) / r;
              const vt = (stb.vx * stb.ry - stb.vy * stb.rx) / r;
              const E = 0.5 * (vr * vr + vt * vt) - self.CONFIG.GM_EARTH / r;
              let per = 0;
              if (E < 0) { const a = -self.CONFIG.GM_EARTH / (2 * E); per = 2 * Math.PI * Math.sqrt(a*a*a / self.CONFIG.GM_EARTH); }
              // time to apogee via Kepler — skip exact, use vrEnd sign as primary signal
              let tApo = Infinity;
              if (E < 0) {
                const a = -self.CONFIG.GM_EARTH / (2 * E);
                const h = r * vt;
                const eSq = 1 + 2 * E * h * h / (self.CONFIG.GM_EARTH * self.CONFIG.GM_EARTH);
                const e = Math.sqrt(Math.max(0, eSq));
                if (e < 1e-9) tApo = Math.PI * Math.sqrt(a*a*a / self.CONFIG.GM_EARTH);
                else {
                  const cosE = (1 - r / a) / e;
                  const sinE = (r * vr) / (e * Math.sqrt(self.CONFIG.GM_EARTH * a));
                  let Ean = Math.atan2(sinE, cosE);
                  if (Ean < 0) Ean += 2 * Math.PI;
                  const M = Ean - e * Math.sin(Ean);
                  const n = Math.sqrt(self.CONFIG.GM_EARTH / (a*a*a));
                  tApo = M < Math.PI ? (Math.PI - M) / n : (3 * Math.PI - M) / n;
                }
              }
              const marginS = vr < 0 ? (tApo - per) : tApo;
              return {
                endReason: self.state.crashed ? 'CRASHED' : 'CIRC_END',
                crashed: self.state.crashed,
                vrEnd: vr, marginS, vrMin: -1,
              };
            }
          };
          const lr = await self.TunerCore.tuneLead(point, { hook: CPHook, cache, targetAltKm: altKm });
          emit('probe', tag + ' tuneLead done ok=' + lr.ok + ' lead=' + (lr.lead || 'n/a'));
          if (!lr.ok) {
            result = { ok: false, reason: 'lead_failed: ' + lr.reason, lead: lr.lead, margin: lr.marginS, evals: lr.evals };
          } else {
            emit('probe', tag + ' FULL eval');
            // Run FULL eval from SA with bias + best lead
            restoreSA(_saSnapshot, newBias);
            const gFull = self.Guidance.getGuideConfig('leoInsertionV3');
            gFull.insertion.CIRC_TRIGGER_LEAD_S = lr.lead;
            self.Guidance.applyGuideConfig('leoInsertionV3', gFull);
            const reached3 = await tickUntil(() => self.state.halted || self.Guidance.getGuideStatus().payloadCleared, maxTicks);
            // Actually tickUntil returns when predicate true; for FULL we stop at payloadCleared
            const gsEnd = self.Guidance.getGuideStatus();
            const m = {
              endReason: gsEnd.payloadCleared ? 'CLEARED' : 'CAP',
              crashed: self.state.crashed,
              payloadReleased: !!gsEnd.payloadCleared,
              payloadCleared: !!gsEnd.payloadCleared,
              deployTimeS: gsEnd.deployCommandSimTime,
            };
            const sc = self.TunerUtils.score(m, { targetAltKm: altKm });
            emit('probe', tag + ' FULL score=' + (sc.score != null ? sc.score.toFixed(2) : '?') + ' cleared=' + m.payloadCleared);
            result = {
              ok: sc.ok, lead: lr.lead, margin: lr.marginS, vrEnd: lr.vrEnd,
              score: sc.score, reasons: sc.reasons,
              metrics: m,
              evals: lr.evals + 1,
            };
          }
        }
      }
    } else if (type === 'ping') {
      result = { pong: true, hasTunerEngine: typeof TunerEngine !== 'undefined' };
    } else {
      throw new Error('unknown job type: ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};