// ============================================================================
// sim.js — sim engine glue, extracted 1:1 from guidance-numerical.html
// (library-cache patch, buildSnapshot, clampFlow/localDispatch, stack-data
// handoff). Logic is NOT changed; only wrapped so the page can call it, and
// environment/fueling now take a plain object instead of reading DOM inputs.
//
// Tick order (kept exactly as guidance-numerical.html's loop code):
//     physicsStep(dt) -> buildSnapshot() -> Guidance.onSnapshot(snap)
// buildSnapshot() MUST rebuild b.pods every tick (RCS guidance depends on it).
// Derivation.setStackData runs ONCE per page load, before any guide starts.
// ============================================================================
(function () {
  'use strict';

  // ---- Library cache (same pattern as guidance-numerical.html) -------------
  (function patchLibraryCache() {
    var _cache = null;
    var _origLoadCL = loadComponentLibrary;
    loadComponentLibrary = function () {
      if (_cache) return _cache;
      _cache = _origLoadCL();
      return _cache;
    };
    if (typeof saveCustomComponentTypes === 'function') {
      var _origSave = saveCustomComponentTypes;
      saveCustomComponentTypes = function (types) {
        _origSave(types); _cache = null;
      };
    }
  })();

  // ---- Snapshot builder (1:1) ----
  function buildSnapshot() {
    // Physics writes _lastAccelX/_lastAccelY; guidance's snapshot field is
    // `ax`/`ay`. Cheap loop — one assignment per body.
    const bodies = state.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
        b.ax = b._lastAccelX || 0;
  b.ay = b._lastAccelY || 0;
  // CRITICAL: guidance reads body.pods for every RCS command
  // (targetTorqueRcs, postSeparationAxialDuty). Physics never sets
  // pods on the live body — physics's own RCS path rebuilds pods
  // internally per tick. So the snapshot MUST build them, exactly
  // like runner.js's buildSnapshot does. Without this, every RCS
  // guidance command silently returns empty fires → COAST_ROTATE
  // and CIRCULARIZE never complete.
  if (typeof buildPodEntries === 'function') {
    b.pods = buildPodEntries(b);
  }
  }
    return {
      simTime: state.simTime,
      activeBodyIndex: state.activeBodyIndex,
      halted: !!state.halted,
      wind: (typeof wind !== 'undefined') ? {
        enabled: !!wind.enabled,
        speed: wind.speed || 0,
        directionDeg: wind.directionDeg || 0,
      } : { enabled: false, speed: 0, directionDeg: 0 },
      bodies: bodies,
    };
  }

  // ---- Local dispatch (1:1) ----
  function clampFlow(en, cmd) {
    if (!(cmd > 0)) return 0;
    return Math.max(Math.min(cmd, en.maxMassFlowRate || 0), en.minMassFlowRate || 0);
  }
  // Commands mutate state.bodies targets directly (via localDispatch).
// The NEXT physicsStep uses them — 1-tick pipeline latency matching
// real sim's physics worker + guidance worker architecture.
function localDispatch(msg) {
  let b;
  if (Number.isInteger(msg.targetBodyIdx) && msg.targetBodyIdx >= 0 &&
      msg.targetBodyIdx < state.bodies.length) {
    b = state.bodies[msg.targetBodyIdx];
  } else {
    b = state.bodies[state.activeBodyIndex];
  }
  if (!b) return;
  switch (msg.type) {
    case 'setGimbalRate': {
      if (!b.engines) break;
      const lim = CONFIG.GIMBAL_RATE_DEG_S;
      const rate = Math.max(-lim, Math.min(lim, msg.degPerSec));
      const onlyCenter = (msg.target === 'center');
      b.engines.filter(en => en.gimbal && (!onlyCenter || en.isCenter))
        .forEach(en => { en.targetGimbalRateDegS = rate; });
      break;
    }
    case 'setGimbal': {
      if (!b.engines) break;
      const lim = CONFIG.GIMBAL_MAX_DEG;
      const d = Math.max(-lim, Math.min(lim, msg.deg));
      b.engines.filter(en => en.gimbal).forEach(en => {
        en.targetGimbalDeg = d; en.targetGimbalRateDegS = NaN;
      });
      break;
    }
    case 'setAllThrottle': {
      if (!b.engines) break;
      b.engines.forEach(en => { en.targetMassFlowRate = clampFlow(en, msg.value); });
      break;
    }
    case 'setCenterThrottle': {
      if (!b.engines) break;
      b.engines.filter(en => en.isCenter).forEach(en => {
        en.targetMassFlowRate = clampFlow(en, msg.value);
      });
      break;
    }
    case 'setGroupThrottle': {
      if (!b.engines) break;
      (msg.angles || []).forEach(a => {
        const en = b.engines.find(e => e.angleDeg === a);
        if (en) en.targetMassFlowRate = clampFlow(en, msg.value);
      });
      break;
    }
    case 'rcs': {
      if (!b.rcsCmd) b.rcsCmd = {};
      b.rcsCmd[msg.key] = !!msg.on;
      b.rcsDuty = null;
      break;
    }
    case 'rcsDuty': {
      if (msg.duties == null) b.rcsDuty = null;
      else b.rcsDuty = msg.duties;
      break;
    }
    case 'legs': {
      if (!b.legs) b.legs = { deployed: false, progress: 0 };
      b.legs.deployed = !!msg.deployed;
      break;
    }
    case 'gridFinsDeploy': {
      if (!b || !b.gridFins) break;
      const gfType = (typeof bodyGridFinType === 'function') ? bodyGridFinType(b) : null;
      const maxDeploy = (gfType && gfType.typeConstants &&
          Number.isFinite(gfType.typeConstants.maxDeployDeg)) ?
        gfType.typeConstants.maxDeployDeg : 90;
      ['L', 'R', 'FB'].forEach(k => {
        const f = b.gridFins[k];
        if (!f) return;
        if (msg.deployed) f.targetDeploy = 0;
        else f.targetDeploy = (k === 'R') ? -maxDeploy : maxDeploy;
      });
      break;
    }
    case 'gridFinsControl': {
      if (!b || !b.gridFins) break;
      const f = b.gridFins.FB;
      if (f && Number.isFinite(msg.controlDeg)) {
        f.targetControl = Math.max(-90, Math.min(90, msg.controlDeg));
      }
      break;
    }
    case 'separate': { if (typeof requestSeparate === 'function') requestSeparate(b); break; }
    case 'splitFairing': { if (typeof splitFairingOnActiveBody === 'function') splitFairingOnActiveBody(b); break; }
    case 'releasePayload': { if (typeof requestReleasePayload === 'function') requestReleasePayload(msg, b); break; }
    case 'emergencyEject': { if (typeof emergencyEjectPayload === 'function') emergencyEjectPayload(b); break; }
    case 'takeControl': { if (typeof takeControlOfBody === 'function') takeControlOfBody(msg.idx); break; }
case 'markIntentionalImpact': { if (b) b.intentionalImpact = true; break; }
case 'pusherTorque': {
  b._sepTorqueAngAccel = Number.isFinite(msg.angAccel) ? msg.angAccel : 0;
  b._sepTorqueTargetOmega = Number.isFinite(msg.targetOmega) ? msg.targetOmega : null;
  break;
}
case 'openPayload': {
  if (!Number.isFinite(b.payloadOpenedAt)) {
    b.payloadOpenedAt = state.simTime;
  }
  break;
}
default: break;
  }
}



  // ---- Stack data handoff (1:1, now a callable function) ----
  function setupStackData() {
  const members = (typeof getActiveStackMembers === 'function')
    ? getActiveStackMembers() : [];
  window.SIM_STACK_MEMBERS = members;

  function _stripFns(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) =>
      (typeof v === 'function' ? undefined : v)));
  }

  function collectStackData() {
    const typeIds = new Set();
    members.forEach(m => {
      if (m.engineTypeId) typeIds.add(m.engineTypeId);
      if (m.recoveryTypeId && m.hasRecovery !== false) typeIds.add(m.recoveryTypeId);
      if (m.rcsTypeId) typeIds.add(m.rcsTypeId);
      if (m.bodyMetalTypeId) typeIds.add(m.bodyMetalTypeId);
      if (m.legsMetalTypeId) typeIds.add(m.legsMetalTypeId);
      if (m.payloadSpaceTypeId) typeIds.add(m.payloadSpaceTypeId);
      if (m.payloadSpaceMetalTypeId) typeIds.add(m.payloadSpaceMetalTypeId);
      if (m.fuel && m.fuel.typeId) typeIds.add(m.fuel.typeId);
      if (m.engineThrusters) {
        Object.keys(m.engineThrusters).forEach(gk => {
          const g = m.engineThrusters[gk];
          if (g && g.thrusterTypeId) typeIds.add(g.thrusterTypeId);
        });
      }
      if (m.rcsThruster && m.rcsThruster.thrusterTypeId) typeIds.add(m.rcsThruster.thrusterTypeId);
      if (m.payloadSpace && m.payloadSpace.typeId) typeIds.add(m.payloadSpace.typeId);
      if (m.payloadSpace && m.payloadSpace.metalTypeId) typeIds.add(m.payloadSpace.metalTypeId);
      if (m.chuteTypeId) typeIds.add(m.chuteTypeId);
      if (m.gridFinTypeId) typeIds.add(m.gridFinTypeId);
      if (m.gridFinMetalTypeId) typeIds.add(m.gridFinMetalTypeId);
    });

    const types = {};
    typeIds.forEach(id => {
      const t = (typeof getComponentType === 'function') ? getComponentType(id) : null;
      if (t) types[id] = _stripFns(t);
    });

    const activeStk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
    
    // Pre-resolve every per-member derived value that derivation.js needs
// but cannot reach: leg geometry + one-leg volume live inside a type's
// frame.hingeGeometry()/structuralVolume() FUNCTIONS (stripped on the
// structured clone into the guidance worker), and the grid-fin total
// mass lives in fleet.js's computeGridFinMass(). Shipping the resolved
// numbers once at handoff keeps guidance's mass model locked to physics
// without needing a second inlined reimplementation that could drift.
const memberDerived = {};
members.forEach(m => {
  if (!m || !m.id) return;
  const out = {};
  
  // Legs — resolve via the type's own functions, at THIS record's
  // own tank dimensions (matching massProps.js's tankH/tankW inputs).
  if (m.hasRecovery !== false && m.recoveryTypeId &&
    typeof getComponentType === 'function') {
    const rt = getComponentType(m.recoveryTypeId);
    if (rt && rt.capabilities && rt.capabilities.deploysOnVehicle &&
      rt.frame && typeof rt.frame.hingeGeometry === 'function' &&
      typeof rt.frame.structuralVolume === 'function') {
      const legH = (m.fuel && Number.isFinite(m.fuel.tankHeight)) ?
        m.fuel.tankHeight :
        (Number.isFinite(m.height) ? m.height : 0);
      const legW = (m.fuel && Number.isFinite(m.fuel.tankWidth)) ?
        m.fuel.tankWidth :
        (Number.isFinite(m.width) ? m.width : 0);
      const geo = rt.frame.hingeGeometry(legH);
      const oneLegVolume = rt.frame.structuralVolume(legH, legW);
      if (geo && Number.isFinite(geo.hingeY) &&
        Number.isFinite(geo.legLength) &&
        Number.isFinite(geo.maxSweepRad) &&
        Number.isFinite(oneLegVolume)) {
        out.legs = {
          hingeY: geo.hingeY,
          legLength: geo.legLength,
          maxSweepRad: geo.maxSweepRad,
          legCount: rt.frame.legCount || 4,
          oneLegVolume,
        };
      }
    }
  }
  
  // Grid fins — total mass from fleet.js's own computeGridFinMass.
  if (m.hasGridFins && typeof computeGridFinMass === 'function') {
    const gf = computeGridFinMass(m);
    if (gf && Number.isFinite(gf.totalMass) && Number.isFinite(gf.perFinMass)) {
      out.gridFins = {
        totalMass: gf.totalMass,
        perFinMass: gf.perFinMass,
        finCount: gf.finCount,
      };
    }
  }
  
  memberDerived[m.id] = out;
});


    const derived = (activeStk && activeStk.derived) ? activeStk.derived : null;

    let stackPayloadMass = 0;
    if (activeStk && activeStk.payloadId && typeof getPayload === 'function') {
      const pl = getPayload(activeStk.payloadId);
      if (pl && Number.isFinite(pl.mass)) stackPayloadMass = pl.mass;
    }

    return {
      members: members.map(_stripFns),
      types,
      memberDerived,
      stackPayloadMass,
      derived,
      env: {
        EARTH_RADIUS: CONFIG.EARTH_RADIUS,
        GM_EARTH: CONFIG.GM_EARTH,
        EARTH_OMEGA: CONFIG.EARTH_OMEGA,
        LAUNCH_SITE_ALTITUDE: CONFIG.LAUNCH_SITE_ALTITUDE,
        LAUNCH_SITE_ANGLE_0: CONFIG.LAUNCH_SITE_ANGLE_0,
        G0: (typeof G0 !== 'undefined') ? G0 : 9.80665,
        REMOTE_AREA_MID_WEST_DEG:
          ((CONFIG.REMOTE_AREA_WEST_START_DEG || 0) +
           (CONFIG.REMOTE_AREA_WEST_END_DEG || 0)) / 2,
        REMOTE_AREA_WEST_START_DEG: CONFIG.REMOTE_AREA_WEST_START_DEG || 0,
        REMOTE_AREA_WEST_END_DEG: CONFIG.REMOTE_AREA_WEST_END_DEG || 0,
        PAYLOAD_EJECT_KICK_MPS: CONFIG.PAYLOAD_EJECT_KICK_MPS,
        SEA_LEVEL_DENSITY: CONFIG.SEA_LEVEL_DENSITY,
        SCALE_HEIGHT: CONFIG.SCALE_HEIGHT,
        DRAG_CD: CONFIG.DRAG_CD,
        DT: CONFIG.DT,
        GIMBAL_MAX_DEG: CONFIG.GIMBAL_MAX_DEG,
        GIMBAL_RATE_DEG_S: CONFIG.GIMBAL_RATE_DEG_S,
      },
    };
  }

  Derivation.setStackData(collectStackData());
  console.log('[guidance-numerical] stack data sent to Derivation:',
    members.length, 'members,', Object.keys(collectStackData().types).length, 'types');
  }

  // ---- Environment / fueling (same logic as guidance-numerical.html,
  //      values come from a plain object instead of DOM inputs) -------------
  const DEFAULT_ENV = {
    atmosphere: true, slosh: true, imu: false,
    wind: { enabled: false, speed: 0, directionDeg: 0 },
    boosterPct: 100, stagePct: 100,
  };

  function applyEnvironment(env) {
    env = env || DEFAULT_ENV;
    const w = env.wind || DEFAULT_ENV.wind;
    if (typeof wind !== 'undefined') {
      wind.enabled = !!w.enabled;
      wind.speed = Number(w.speed) || 0;
      wind.directionDeg = Number(w.directionDeg) || 0;
    }
    if (typeof atmosphereEnabled !== 'undefined') {
      atmosphereEnabled = !!env.atmosphere;
    }
    if (typeof CONFIG !== 'undefined') {
      CONFIG.SLOSH_ENABLED = !!env.slosh;
    }
    try { Guidance.setImuEnabled(!!env.imu); } catch (e) {}
  }

  function applyFueling(env) {
    env = env || DEFAULT_ENV;
    const boosterPct = Number.isFinite(env.boosterPct) ? env.boosterPct : 100;
    const stagePct   = Number.isFinite(env.stagePct)   ? env.stagePct   : 100;
    const b = state.bodies[0];
    if (!b || !Array.isArray(b.memberFuel) || !b.members) return;
    const cap = (m, above) => (typeof memberMaxFuel === 'function')
      ? memberMaxFuel(m, above) : 0;
    b.memberFuel = b.members.map((m, i) => {
      const c = cap(m, b.members[i + 1] || null);
      if (m.stageRole === 'booster') return c * (boosterPct / 100);
      if (m.stageRole === 'stage')   return c * (stagePct / 100);
      return 0;
    });
    b.fuelMass = b.memberFuel.reduce((s, x) => s + x, 0);
  }

  // ---- Public API ----------------------------------------------------------
  let _inited = false;

  function init() {
    if (_inited) return;
    setupStackData();            // once per page load, before any guide start
    Guidance.init(localDispatch);
    _inited = true;
  }

  // Run-start sequence, identical order to guidance-numerical.html run():
  // applyGuideConfig -> resetState(0) -> env -> fueling -> stop -> start.
  // `values` must already be lattice-snapped (lattice does that, Step 2).
  function prepareRun(guideName, values, env) {
    if (!Guidance.applyGuideConfig(guideName, values)) {
      throw new Error('applyGuideConfig failed');
    }
    resetState(0);
    applyEnvironment(env);
    applyFueling(env);
    try { Guidance.stopGuide(); } catch (e) {}
    Guidance.startGuide(guideName);
  }

  // One tick, exact pipeline order. Returns the snapshot used by guidance.
  function tick(dt) {
    physicsStep(dt);
    const snap = buildSnapshot();
    Guidance.onSnapshot(snap);
    return snap;
  }

  // Smoke test (Step 1 "done when"): N ticks, report phase + speed. No metrics.
  function smokeTest(guideName, values, env, nTicks) {
    prepareRun(guideName, values, env);
    const dt = CONFIG.DT;
    const t0 = performance.now();
    let i = 0;
    for (; i < nTicks; i++) {
      if (state.halted) break;
      tick(dt);
    }
    const wallS = (performance.now() - t0) / 1000;
    const gs = (Guidance.getGuideStatus && Guidance.getGuideStatus()) || {};
    const out = {
      ticks: i, simTime: state.simTime, phase: gs.phase || '?',
      altKm: gs.altKm, wallS, ticksPerSecond: i / Math.max(wallS, 1e-9),
    };
    try { Guidance.stopGuide(); } catch (e) {}
    return out;
  }

  window.TunerEngine = {
    init, prepareRun, tick, smokeTest, buildSnapshot, localDispatch,
    applyEnvironment, applyFueling, DEFAULT_ENV,
  };
})();
