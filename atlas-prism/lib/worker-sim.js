// worker-sim.js — sim instance in a Web Worker.
// Handles: hydrate, runEval, runEvalValues, setupSA, probeBiasCheckpoint, ping.
// Emits progress events so the pool can show per-worker live state.

// ---- localStorage stub ----
self.localStorage = (function () {
  const _data = Object.create(null);
  return {
    getItem(k) { return k in _data ? _data[k] : null; },
    setItem(k, v) { _data[k] = String(v); },
    removeItem(k) { delete _data[k]; },
    clear() { Object.keys(_data).forEach(k => delete _data[k]); },
    get length() { return Object.keys(_data).length; },
    key(i) { return Object.keys(_data)[i] || null; },
    _populate(obj) { Object.keys(obj || {}).forEach(k => { if (obj[k] != null) _data[k] = String(obj[k]); }); }
  };
})();
self.window = self;

// ---- progress emit ----
const _workerTag = 'w' + Math.random().toString(36).slice(2, 6);
let _jobSeq = 0;
function emit(phase, detail) {
  try { self.postMessage({ type: 'progress', tag: _workerTag, phase, detail, ts: Date.now() }); } catch (e) {}
}
function emitCount(detail) {
  // Post a message keyed by seq so user can see per-eval counts live
  self.postMessage({ type: 'progress', tag: _workerTag, phase: 'eval', detail, ts: Date.now(), seq: ++_jobSeq });
}

// ---- sim load ----
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

// ---- snapshot helpers ----
function deepClone(x, memo) {
  memo = memo || new WeakMap();
  if (x === null || typeof x !== 'object') return x;
  if (memo.has(x)) return memo.get(x);
  if (Array.isArray(x)) { const a = []; memo.set(x, a); for (let i = 0; i < x.length; i++) a[i] = deepClone(x[i], memo); return a; }
  const o = {}; memo.set(x, o); for (const k of Object.keys(x)) o[k] = deepClone(x[k], memo); return o;
}

let _saSnapshot = null;

function captureSnap() {
  const st = {};
  Object.keys(state).forEach(k => { if (k === 'bodies') return; try { st[k] = deepClone(state[k]); } catch (e) { st[k] = null; } });
  return {
    bodies: deepClone(state.bodies),
    stateKeysSnapshot: st,
    simTime: state.simTime,
    activeBodyIndex: state.activeBodyIndex,
    guidanceState: Guidance.exportGuideState(),
  };
}

function restoreSnap(snap, biasOverride, leadOverride) {
  Object.keys(snap.stateKeysSnapshot).forEach(k => {
    try { state[k] = deepClone(snap.stateKeysSnapshot[k]); } catch (e) {}
  });
  state.simTime = snap.simTime;
  state.activeBodyIndex = snap.activeBodyIndex;
  const sb = snap.bodies;
  while (state.bodies.length > sb.length) state.bodies.pop();
  while (state.bodies.length < sb.length) state.bodies.push({});
  for (let i = 0; i < sb.length; i++) {
    const src = sb[i], dst = state.bodies[i];
    Object.keys(dst).forEach(k => { delete dst[k]; });
    Object.keys(src).forEach(k => { dst[k] = deepClone(src[k]); });
  }
  const ab = state.bodies[state.activeBodyIndex];
  if (ab) ['rx','ry','vx','vy','theta','omega','dryMass','fuelMass'].forEach(k => {
    try { state[k] = ab[k]; } catch (e) {}
  });
  for (const b of state.bodies) {
    if (!b || !b.members || !b.members.length) continue;
    if (b._lastBottomMember && b._lastBottomMember.id) {
      const m = b.members.find(mm => mm && mm.id === b._lastBottomMember.id);
      if (m) b._lastBottomMember = m;
    }
  }
  const g = deepClone(snap.guidanceState);
  if (biasOverride != null && g.guideConfigs && g.guideConfigs.leoInsertionV3 && g.guideConfigs.leoInsertionV3.insertion) {
    g.guideConfigs.leoInsertionV3.insertion.STAGE_BURN_AOA_BIAS_DEG = biasOverride;
  }
  if (leadOverride != null && g.guideConfigs && g.guideConfigs.leoInsertionV3 && g.guideConfigs.leoInsertionV3.insertion) {
    g.guideConfigs.leoInsertionV3.insertion.CIRC_TRIGGER_LEAD_S = leadOverride;
  }
  if (g.v3InsertionBlock && g.v3InsertionBlock.constants) {
    if (biasOverride != null) g.v3InsertionBlock.constants.STAGE_BURN_AOA_BIAS_DEG = biasOverride;
    if (leadOverride != null) {
      g.v3InsertionBlock.constants.CIRC_TRIGGER_LEAD_S = leadOverride;
      if (g.v3InsertionBlock.st) delete g.v3InsertionBlock.st._circLeadCached;
    }
  }
  Guidance.importGuideState(g);
}

function phaseNow() {
  const gs = Guidance.getGuideStatus();
  return gs && gs.phase;
}

async function tickUntilCleared(maxS) {
  const maxTicks = Math.ceil(maxS / CONFIG.DT);
  for (let i = 0; i < maxTicks; i++) {
    if (state.halted) return { ok: false, reason: 'halted', simTime: state.simTime, gs: Guidance.getGuideStatus() };
    TunerEngine.tick(CONFIG.DT);
    const gs = Guidance.getGuideStatus();
    if (gs && gs.payloadCleared) return { ok: true, simTime: state.simTime, gs };
  }
  return { ok: false, reason: 'cap', simTime: state.simTime, gs: Guidance.getGuideStatus() };
}

async function tickUntilPhase(targetPhases, maxS) {
  const maxTicks = Math.ceil(maxS / CONFIG.DT);
  for (let i = 0; i < maxTicks; i++) {
    if (state.halted) return false;
    TunerEngine.tick(CONFIG.DT);
    const ph = phaseNow();
    if (targetPhases.indexOf(ph) >= 0) return true;
  }
  return false;
}

function findStageBody() {
  for (const b of state.bodies) {
    if (b && !b.payloadBody && !b.fairingHalf && b.members && b.members[0] && b.members[0].stageRole === 'stage') return b;
  }
  return null;
}

function extractCircMetrics() {
  const stb = findStageBody();
  if (!stb) return { vrEnd: NaN, marginS: NaN, vrMin: NaN };
  const r = Math.hypot(stb.rx, stb.ry);
  const vr = (stb.vx * stb.rx + stb.vy * stb.ry) / r;
  const vt = (stb.vx * stb.ry - stb.vy * stb.rx) / r;
  const GM = CONFIG.GM_EARTH;
  const E = 0.5 * (vr * vr + vt * vt) - GM / r;
  let per = 0, tApo = Infinity;
  if (E < 0) {
    const a = -GM / (2 * E);
    per = 2 * Math.PI * Math.sqrt(a * a * a / GM);
    const h = r * vt;
    const eSq = 1 + 2 * E * h * h / (GM * GM);
    const e = Math.sqrt(Math.max(0, eSq));
    if (e < 1e-9) tApo = Math.PI * Math.sqrt(a * a * a / GM);
    else {
      const cosE = (1 - r / a) / e;
      const sinE = (r * vr) / (e * Math.sqrt(GM * a));
      let Ean = Math.atan2(sinE, cosE);
      if (Ean < 0) Ean += 2 * Math.PI;
      const M = Ean - e * Math.sin(Ean);
      const n = Math.sqrt(GM / (a * a * a));
      tApo = M < Math.PI ? (Math.PI - M) / n : (3 * Math.PI - M) / n;
    }
  }
  const marginS = vr < 0 ? (tApo - per) : tApo;
  return { vrEnd: vr, marginS, vrMin: -1, tApo, per };
}

// ---- message handler ----
self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type, payload } = msg;

  if (type === 'hydrate') {
    self.localStorage._populate(payload && payload.keys);
    try {
      _loadSim();
      self.postMessage({ type: 'ready', tag: _workerTag });
    } catch (err) {
      self.postMessage({ type: 'ready', error: _bootError, tag: _workerTag });
    }
    return;
  }
  if (!_loaded) {
    self.postMessage({ id, ok: false, error: 'sim not loaded' });
    return;
  }

  try {
    let result;

    if (type === 'runEval') {
      result = await TunerHook.runEval(payload.point, payload.opts || {});
    } else if (type === 'runEvalValues') {
      result = await TunerHook.runEvalValues(payload.values, payload.opts || {});
    } else if (type === 'setupSA') {
      emit('setupSA', 'running ascent');
      TunerEngine.prepareRun(TunerConfig.guideName, payload.values, payload.env || TunerConfig.env);
      const ok = await tickUntilPhase(['SEPARATED_AXIAL'], 300);
      if (!ok) {
        emit('setupSA', 'FAIL ' + phaseNow());
        result = { ok: false, reason: 'SA not reached: ' + phaseNow() };
      } else {
        _saSnapshot = captureSnap();
        emit('setupSA', 'saved at t=' + _saSnapshot.simTime.toFixed(2));
        result = { ok: true, simTime: _saSnapshot.simTime };
      }
    } else if (type === 'probeBiasCheckpoint') {
      if (!_saSnapshot) { result = { ok: false, reason: 'no SA snapshot' }; }
      else {
        const newBias = payload.bias;
        const altKm = payload.altKm != null ? payload.altKm : 320;
        const Q = TunerConfig.quanta;
        const tag = 'b=' + newBias.toFixed(3);

        // ---- 1. Restore SA + bias, run to COAST_HOLD ----
        emit('probe', tag + ' restore+runToCH');
        restoreSnap(_saSnapshot, newBias, null);
        const okCH = await tickUntilPhase(['COAST_HOLD'], 800);
        if (!okCH) {
          emit('probe', tag + ' CH_FAIL ' + phaseNow());
          result = { ok: false, reason: 'CH not reached: ' + phaseNow() };
        } else {
          // ---- 2. Capture local CH snapshot ----
          const chSnap = captureSnap();
          emit('probe', tag + ' CH captured t=' + chSnap.simTime.toFixed(2) + ', tuneLead');

          // ---- 3. tuneLead with CH-based hook ----
          const cache = new TunerUtils.EvalCache();
          let evalN = 0;
          const CPHook = {
            runEval: async (p2, o) => {
              evalN++;
              const lead = p2.li * Q.lead;
              emit('probe', tag + ' eval#' + evalN + ' lead=' + lead.toFixed(4));
              restoreSnap(chSnap, newBias, lead);
              const ok = await tickUntilPhase(['COAST_ROTATE_2'], 300);
              if (!ok) {
                return { endReason: state.halted ? 'HALTED' : 'CAP', crashed: !!state.crashed, vrEnd: NaN, marginS: NaN, vrMin: NaN };
              }
              const m = extractCircMetrics();
              return { endReason: 'CIRC_END', crashed: !!state.crashed, vrEnd: m.vrEnd, marginS: m.marginS, vrMin: m.vrMin };
            }
          };
          // Lattice point (needed for cache key only)
          const cfg = Guidance.getGuideConfig('leoInsertionV3');
          const point = {
            Gi: Math.round(cfg.ascent.PUSH_MAX_GIMBAL_DEG / Q.G),
            Tn: Math.round(cfg.ascent.PUSH_T_S / Q.T),
            bi: Math.round(cfg.insertion.STAGE_BURN_AOA_BIAS_DEG / Q.bias),
            li: Math.round(cfg.insertion.CIRC_TRIGGER_LEAD_S / Q.lead),
            meco: cfg.ascent.MECO_TARGET_BOOSTER_FUEL_KG,
          };
          const lr = await TunerCore.tuneLead(point, { hook: CPHook, cache, targetAltKm: altKm });
          emit('probe', tag + ' tuneLead ok=' + lr.ok + ' lead=' + (Number.isFinite(lr.lead) ? lr.lead.toFixed(4) : 'n/a') + ' evals=' + lr.evals);

          if (!lr.ok) {
            result = { ok: false, reason: 'lead_failed: ' + lr.reason, lead: lr.lead, margin: lr.marginS, evals: lr.evals };
          } else {
            // ---- 4. FULL eval from CH with best lead ----
            // Tick until payload PHYSICALLY clears (gs.payloadCleared === true).
            // 'DONE' phase fires at deploy COMMAND, not at payload clear — the payload
            // physically clears ~10-30 s later. Stopping at DONE left gsEnd.payloadCleared
            // false → false "duration_cap_hit + payload_not_cleared" hard-fail.
            emit('probe', tag + ' FULL lead=' + lr.lead.toFixed(4));
            restoreSnap(chSnap, newBias, lr.lead);
            let okFull = false;
            const _capTicksFull = Math.ceil(300 / CONFIG.DT);
            for (let _i = 0; _i < _capTicksFull; _i++) {
              if (state.halted) break;
              TunerEngine.tick(CONFIG.DT);
              const _gs = Guidance.getGuideStatus();
              if (_gs && _gs.payloadCleared) { okFull = true; break; }
            }
            const gsEnd = Guidance.getGuideStatus();
            const stb = findStageBody();
            const m = {
              endReason: gsEnd.payloadCleared ? 'CLEARED' : 'CAP',
              crashed: !!state.crashed,
              payloadReleased: !!gsEnd.payloadCleared,
              payloadCleared: !!gsEnd.payloadCleared,
              deployTimeS: gsEnd.deployCommandSimTime,
              apogeeKm: NaN, perigeeKm: NaN, ecc: NaN,
              boosterFuelLeftKg: NaN, stageResidualKg: stb ? stb.fuelMass : NaN,
              maxQKPa: NaN, maxG: NaN,
            };
            const pb = state.bodies.find(x => x && x.payloadBody);
            if (pb) {
              const o = TunerHook.orbitOf(pb, CONFIG.GM_EARTH, CONFIG.EARTH_RADIUS);
              m.apogeeKm = o.apoKm; m.perigeeKm = o.periKm; m.ecc = o.ecc;
            }
            const sc = TunerUtils.score(m, { targetAltKm: altKm });
            emit('probe', tag + ' FULL score=' + (sc.score != null ? sc.score.toFixed(2) : '?') + ' cleared=' + m.payloadCleared);
            result = {
              ok: sc.ok, lead: lr.lead, margin: lr.marginS, vrEnd: lr.vrEnd,
              score: sc.score, reasons: sc.reasons, metrics: m,
              evals: lr.evals + 1,
              capHit: !okFull,
              capReason: okFull ? null : 'cap',
              simEnd: state.simTime,
            };
          }
        }
      }
    } else if (type === 'ping') {
      result = { pong: true, tag: _workerTag, hasTunerEngine: typeof TunerEngine !== 'undefined' };
    } else {
      throw new Error('unknown job type: ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
