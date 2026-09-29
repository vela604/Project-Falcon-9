// ============================================================================
// headless/runner.js — Node.js headless loader for the physics + guidance
// stack. Loads the same JS the browser sim uses into a vm sandbox, seeds
// localStorage with the fleet + stack registry, then runs a configurable
// number of physics ticks with the selected guide.
//
// Usage:
//   const { runSim } = require('./headless/runner');
//   const result = runSim({
//     stackId: 'stk_falcon9-b5',
//     guide: 'leoInsertionV2',
//     durationS: 1500,
//     environment: { atmosphere: true, slosh: true, imu: false, wind: {enabled:false} },
//     tunables: [{ path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: 0.16 }],
//     fueling: { boosterPct: 100, stagePct: 100 },
//   });
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const SIM_FILES = [
  'js/componentLibrary.js',
  'js/customDesign.js',
  'js/fleet.js',
  'js/config.js',
  'js/simJs/core/massProps.js',
  'js/simJs/core/environment.js',
  'js/simJs/core/vehicle.js',
  'js/simJs/core/rcs.js',
  'js/simJs/core/physics.js',
  'js/simJs/core/collision.js',
  'js/simJs/guidance/imu.js',
  'js/simJs/guidance/derivation.js',
  'js/simJs/guidance/guidercs.js',
  'js/simJs/guidance/guidance.js',
];

const SEED_FILES = [
  'js/componentLibrary.js',
  'js/customDesign.js',
  'js/fleet.js',
];

// ---------------------------------------------------------------------------
// localStorage shim
// ---------------------------------------------------------------------------
function makeMemoryStorage(initial) {
  const store = Object.assign(Object.create(null), initial || {});
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
    _dump: () => ({ ...store }),
  };
}

// ---------------------------------------------------------------------------
// Sandbox globals
// ---------------------------------------------------------------------------
function makeSandboxGlobals(localStorage, quiet) {
  const g = Object.create(null);
  const copy = globalThis;
  const keys = [
    'Math', 'JSON', 'Date', 'Number', 'Array', 'Object', 'String',
    'Boolean', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
    'Float32Array', 'Float64Array', 'Int32Array', 'Int16Array', 'Int8Array',
    'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray',
    'ArrayBuffer', 'DataView',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent',
  ];
  for (const k of keys) if (k in copy) g[k] = copy[k];
  g.console = quiet
    ? { log: () => {}, warn: () => {}, info: () => {}, error: console.error.bind(console) }
    : console;
  g.performance = performance;
  g.localStorage = localStorage;
  return g;
}

// ---------------------------------------------------------------------------
// Phase 1 — seed localStorage by loading fleet.js once in a throwaway ctx
// ---------------------------------------------------------------------------
function seedStorageFromRegistry(stackId, vehicleId) {
  const storage = makeMemoryStorage();
  const ctx = vm.createContext(makeSandboxGlobals(storage, true));
  const code = SEED_FILES
    .map(f => fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf8'))
    .join('\n;\n');
  vm.runInContext(code, ctx);
  const setup = `
    loadFleet();
    loadStacks();
    loadFamilies();
    loadPayloads();
    if (${JSON.stringify(stackId)}) setSelectedStackId(${JSON.stringify(stackId)});
    if (${JSON.stringify(vehicleId)}) setSelectedId(${JSON.stringify(vehicleId)});
  `;
  vm.runInContext(setup, ctx);
  return storage._dump();
}

// ---------------------------------------------------------------------------
// Bootstrap snippet — appended after all sim files, same script scope, so it
// closes over every top-level let/const/fn.
// ---------------------------------------------------------------------------
function bootstrapSnippet() {
  return `
globalThis.__sim = (function () {

  // ---- Snapshot builder (mirrors tester page) ----
  function buildSnapshot() {
    const bodies = state.bodies.map((b, i) => ({
      rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy, theta: b.theta, omega: b.omega,
      ax: b._lastAccelX || 0, ay: b._lastAccelY || 0,
      height: b.height, width: b.width, dryMass: b.dryMass,
      fuelMass: b.fuelMass,
      memberFuel: Array.isArray(b.memberFuel) ? b.memberFuel.slice() : [],
      crashed: !!b.crashed, landed: !!b.landed,
      isActive: i === state.activeBodyIndex,
      isDiscarded: !!b.isDiscarded, settled: !!b.settled,
      emergencyEject: !!b.emergencyEject,
      payloadId: b.payloadId || null,
      payloadReleased: !!b.payloadReleased,
      members: b.members || [],
      legs: b.legs ? { deployed: !!b.legs.deployed, progress: b.legs.progress || 0 } : null,
      slosh: b.slosh ? { offset: b.slosh.offset || 0, velocity: b.slosh.velocity || 0 } : null,
      gridFins: b.gridFins || null,
      engines: (b.engines || []).map(e => ({
        id: e.id, angleDeg: e.angleDeg, x: e.x, y: e.y,
        isCenter: e.isCenter, gimbal: e.gimbal, Ve: e.Ve,
        maxMassFlowRate: e.maxMassFlowRate,
        massFlowRate: e.massFlowRate, currentF: e.currentF,
        gimbalDeg: e.gimbalDeg,
        targetGimbalRateDegS: e.targetGimbalRateDegS,
        startupDurationS: e.startupDurationS,
        shutdownDurationS: e.shutdownDurationS,
      })),
      rcsCmd: b.rcsCmd || null,
      rcsDuty: b.rcsDuty || null,
      pods: (typeof buildPodEntries === 'function') ? buildPodEntries(b) : [],
    }));
    const windSnap = (typeof wind !== 'undefined') ? {
      enabled: !!wind.enabled, speed: wind.speed || 0, directionDeg: wind.directionDeg || 0,
    } : { enabled: false, speed: 0, directionDeg: 0 };
    return {
      simTime: state.simTime,
      activeBodyIndex: state.activeBodyIndex,
      halted: !!state.halted,
      wind: windSnap,
      bodies,
    };
  }

  // ---- Local dispatch (mirrors tester page) ----
  function clampFlow(en, cmd) {
    if (!(cmd > 0)) return 0;
    return Math.max(Math.min(cmd, en.maxMassFlowRate || 0), en.minMassFlowRate || 0);
  }
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
        b.engines.filter(en => en.gimbal).forEach(en => { en.targetGimbalRateDegS = rate; });
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
      case 'separate': { if (typeof requestSeparate === 'function') requestSeparate(b); break; }
      case 'splitFairing': { if (typeof splitFairingOnActiveBody === 'function') splitFairingOnActiveBody(b); break; }
      case 'releasePayload': { if (typeof requestReleasePayload === 'function') requestReleasePayload(msg, b); break; }
      case 'emergencyEject': { if (typeof emergencyEjectPayload === 'function') emergencyEjectPayload(b); break; }
      case 'takeControl': { if (typeof takeControlOfBody === 'function') takeControlOfBody(msg.idx); break; }
      default: break;
    }
  }

  // ---- Stack data for guidance ----
  function _stripFns(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'function' ? undefined : v)));
  }
  function collectStackData() {
    const members = (typeof getActiveStackMembers === 'function') ? getActiveStackMembers() : [];
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
      if (m.engineThrusters) Object.keys(m.engineThrusters).forEach(gk => {
        const g = m.engineThrusters[gk];
        if (g && g.thrusterTypeId) typeIds.add(g.thrusterTypeId);
      });
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
    const derived = (activeStk && activeStk.derived) ? activeStk.derived : null;
    let stackPayloadMass = 0;
    if (activeStk && activeStk.payloadId && typeof getPayload === 'function') {
      const pl = getPayload(activeStk.payloadId);
      if (pl && Number.isFinite(pl.mass)) stackPayloadMass = pl.mass;
    }
    return {
      members: members.map(_stripFns),
      types,
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
          ((CONFIG.REMOTE_AREA_WEST_START_DEG || 0) + (CONFIG.REMOTE_AREA_WEST_END_DEG || 0)) / 2,
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

  // ---- Wire up ----
  const members = (typeof getActiveStackMembers === 'function') ? getActiveStackMembers() : [];
  globalThis.SIM_STACK_MEMBERS = members;
  Derivation.setStackData(collectStackData());
  Guidance.init(localDispatch);

  // ---- Tracker (reset per run) ----
  let tracker = null;
  function resetTracker() {
    tracker = {
      maxG: 0,
      maxQKPa: 0,
      initialFuelKg: 0,
      initialBoosterFuelKg: 0,
      initialStageFuelKg: 0,
      ticksRun: 0,
    };
  }
  resetTracker();

  // ---- Tunable path → nested patch ----
  function setDeep(target, path, value) {
    const parts = path.split('.');
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  return {
    CONFIG: CONFIG,
    state: state,

    reset: (alt) => {
      resetState(alt || 0);
      separationFlash = null;
      lastPayloadRelease = null;
      // Rebuild the tracker from the fresh body state.
      resetTracker();
      const b = state.bodies[0];
      if (b) {
        tracker.initialFuelKg = b.fuelMass || 0;
        if (Array.isArray(b.memberFuel) && b.members) {
          b.members.forEach((m, i) => {
            const f = b.memberFuel[i] || 0;
            if (m.stageRole === 'booster') tracker.initialBoosterFuelKg = f;
            else if (m.stageRole === 'stage') tracker.initialStageFuelKg = f;
          });
        }
      }
    },

    setEnvironment: (env) => {
      if (!env) return;
      if (typeof env.atmosphere === 'boolean') atmosphereEnabled = env.atmosphere;
      if (typeof env.slosh === 'boolean') CONFIG.SLOSH_ENABLED = env.slosh;
      if (typeof env.imu === 'boolean') Guidance.setImuEnabled(env.imu);
      if (env.wind) {
        wind.enabled = !!env.wind.enabled;
        wind.speed = Number.isFinite(env.wind.speed) ? env.wind.speed : 0;
        wind.directionDeg = Number.isFinite(env.wind.directionDeg) ? env.wind.directionDeg : 0;
      }
    },

    applyTunables: (guideName, tunables) => {
  if (!tunables || !tunables.length) return true;
  const patch = {};
  tunables.forEach(t => setDeep(patch, t.path, t.value));
  return Guidance.applyGuideConfig(guideName, patch);
},

    setFueling: (boosterPct, stagePct) => {
      const b = state.bodies[0];
      if (!b || !Array.isArray(b.memberFuel) || !b.members) return;
      const cap = (m, above) => (typeof memberMaxFuel === 'function')
        ? memberMaxFuel(m, above) : 0;
      b.memberFuel = b.members.map((m, i) => {
        const c = cap(m, b.members[i + 1] || null);
        if (m.stageRole === 'booster') return c * ((boosterPct != null ? boosterPct : 100) / 100);
        if (m.stageRole === 'stage')   return c * ((stagePct   != null ? stagePct   : 100) / 100);
        return 0;
      });
      b.fuelMass = b.memberFuel.reduce((s, x) => s + x, 0);
      // Update tracker's baseline AFTER fueling is applied, so fuelUsedKg
      // reflects what we actually loaded.
      tracker.initialFuelKg = b.fuelMass || 0;
      tracker.initialBoosterFuelKg = b.memberFuel[0] || 0;
      const stageIdx = b.members.findIndex(m => m.stageRole === 'stage');
      tracker.initialStageFuelKg = stageIdx >= 0 ? (b.memberFuel[stageIdx] || 0) : 0;
    },

    startGuide: (name) => Guidance.startGuide(name),
    stopGuide: () => Guidance.stopGuide(),

    step: (n) => {
      const dt = CONFIG.DT;
      for (let i = 0; i < n; i++) {
        Guidance.onSnapshot(buildSnapshot());
        physicsStep(dt);
        tracker.ticksRun++;

        // Peak G (proper accel magnitude / g0)
        state.bodies.forEach(b => {
          const ax = b._lastAccelX || 0;
          const ay = b._lastAccelY || 0;
          const g = Math.hypot(ax, ay) / 9.80665;
          if (g > tracker.maxG) tracker.maxG = g;
        });

        // Peak dynamic pressure Q (approximate — same convention as
        // telemetry.js's live graph).
        const ab = state.bodies[state.activeBodyIndex];
        if (ab) {
          const r = Math.hypot(ab.rx, ab.ry);
          const alt = r - CONFIG.EARTH_RADIUS;
          const rho = (typeof airDensity === 'function') ? airDensity(Math.max(0, alt)) : 0;
          const sv = (typeof earthSurfaceVelocity === 'function') ? earthSurfaceVelocity(ab.rx, ab.ry) : { vx: 0, vy: 0 };
          const wv = (typeof windInertialVector === 'function') ? windInertialVector(ab.rx, ab.ry) : { wx: 0, wy: 0 };
          const relvx = ab.vx - (sv.vx + wv.wx);
          const relvy = ab.vy - (sv.vy + wv.wy);
          const speed = Math.hypot(relvx, relvy);
          const qKPa = (0.5 * rho * speed * speed) / 1000;
          if (qKPa > tracker.maxQKPa) tracker.maxQKPa = qKPa;
        }

        if (state.halted) return { halted: true, ticks: i + 1 };
      }
      return { halted: false, ticks: n };
    },

    getStatus: () => ({
      simTime: state.simTime,
      activeBodyIndex: state.activeBodyIndex,
      halted: !!state.halted,
      crashed: !!state.crashed,
      landed: !!state.landed,
      guideStatus: Guidance.getGuideStatus(),
      bodies: state.bodies.map(b => {
        const r = Math.hypot(b.rx, b.ry);
        return {
          id: b.id,
          rx: b.rx, ry: b.ry,
          vx: b.vx, vy: b.vy,
          theta: b.theta, omega: b.omega,
          altitudeKm: (r - CONFIG.EARTH_RADIUS) / 1000,
          fuelMass: b.fuelMass,
          memberFuel: Array.isArray(b.memberFuel) ? b.memberFuel.slice() : [],
          crashed: !!b.crashed,
          landed: !!b.landed,
          settled: !!b.settled,
          isActive: !!b.isActive,
          isDiscarded: !!b.isDiscarded,
          payloadReleased: !!b.payloadReleased,
          members: (b.members || []).map(m => m.stageRole),
        };
      }),
    }),

        getTracker: () => ({ ...tracker }),

    // Slot for extra-bootstrap code (e.g. the profiler) to attach data.
    // Reads a global that the extraCode appended after this bootstrap
    // may set — undefined when nothing was appended.
    get profile() { return globalThis.__profile || null; },
  };
})();
`;
}

// ---------------------------------------------------------------------------
// Load once per stack/vehicle combo, reuse across runs
// ---------------------------------------------------------------------------
const _instances = new Map();

function _loadInstance(stackId, vehicleId, quiet, extraCode) {
  const seedDump = seedStorageFromRegistry(stackId, vehicleId);
  const storage = makeMemoryStorage(seedDump);
  const ctx = vm.createContext(makeSandboxGlobals(storage, quiet));
  const code = SIM_FILES
    .map(f => fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf8'))
    .join('\n;\n') + '\n;\n' + bootstrapSnippet() +
    (extraCode ? '\n;\n' + extraCode : '');
  vm.runInContext(code, ctx);
  return ctx.__sim;
}

function _getInstance(stackId, vehicleId, quiet, extraCode) {
  const key = stackId + '::' + vehicleId + '::' + (quiet ? 'q' : 'v') +
    '::' + (extraCode ? 'X' : '-');
  let inst = _instances.get(key);
  if (!inst) {
    inst = _loadInstance(stackId, vehicleId, quiet, extraCode);
    _instances.set(key, inst);
  }
  return inst;
}

// ---------------------------------------------------------------------------
// Public entry — runs one sim, returns status + tracker
// ---------------------------------------------------------------------------
function runSim(options) {
  options = options || {};
  const stackId = options.stackId || 'stk_falcon9-b5';
  const vehicleId = options.vehicleId || 'falcon9-b5-booster';
  const guide = options.guide || 'leoInsertionV2';
  const durationS = Number.isFinite(options.durationS) ? options.durationS : 1500;
  const quiet = !!options.quiet;

  const sim = _getInstance(stackId, vehicleId, quiet, options.extraBootstrapCode);

  sim.reset(0);
  if (options.environment) sim.setEnvironment(options.environment);
  if (options.tunables && options.tunables.length) {
    sim.applyTunables(guide, options.tunables);
  }
  if (options.fueling) {
    sim.setFueling(options.fueling.boosterPct, options.fueling.stagePct);
  }

  const startOk = sim.startGuide(guide);
  const dt = sim.CONFIG.DT;
  const maxTicks = Math.ceil(durationS / dt);
  // Chunked execution so we can print progress from the Node side.
// A single 120k-tick call gives zero feedback for ~9 minutes and looks
// like a hang. 800 ticks = 10 sim-seconds per chunk.
const CHUNK_TICKS = 800;
let elapsed = 0;
const t0 = performance.now();
let halted = false;
const chunkTimes = [];
while (elapsed < maxTicks) {
  const n = Math.min(CHUNK_TICKS, maxTicks - elapsed);
  const ct0 = performance.now();
  const r = sim.step(n);
  const ct = performance.now() - ct0;
  elapsed += r.ticks;
  chunkTimes.push({ atSim: elapsed * dt, ms: ct });
  if (!quiet) {
  const ab = sim.state.bodies[sim.state.activeBodyIndex];
  const r = Math.hypot(ab.rx, ab.ry) || 1;
  const alt = r - sim.CONFIG.EARTH_RADIUS;
  const vr = (ab.vx * ab.rx + ab.vy * ab.ry) / r;
  const thrust = (ab.engines || []).reduce((s, e) => s + (e.currentF || 0), 0);
  const gs = (sim.getStatus().guideStatus || {}).phase || '';
  process.stdout.write('\r  t=' + (elapsed * dt).toFixed(1) + 's' +
    ' alt=' + alt.toFixed(1) + 'm vr=' + vr.toFixed(2) + 'm/s' +
    ' thr=' + (thrust/1e6).toFixed(2) + 'MN' +
    ' cr=' + (ab.crashed ? 'Y' : 'N') +
    ' ph=' + gs.padEnd(12) +
    '   ');
}
  if (r.halted) { halted = true; break; }
}
if (!quiet) process.stdout.write('\n');
const wallMs = performance.now() - t0;

// Capture status BEFORE stopGuide — getGuideStatus() only returns
// phase info while a guide is still active.
const status = sim.getStatus();
const tracker = sim.getTracker();
sim.stopGuide();
status.chunkTimes = chunkTimes;

  return {
  guideName: guide,
  durationS,
  startOk,
  ticksRun: elapsed,
  haltedByLoop: halted,
  wallMs,
  status,
  tracker,
  sim,   // exposed for headless/profile.js — reach into .profile and .state
};
}

module.exports = { runSim };