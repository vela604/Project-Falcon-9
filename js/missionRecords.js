// ============================================================================
// missionRecords.js — Mission record storage + comboKey/hash helpers.
//
// Record schema v1 (from coordination with physics/guidance agent):
//   { schemaVersion, physicsVersion, comboKey,
//     metadata: { stackId, stackName, presetId, presetName, guideName,
//                 recordedAt, recordedBy, durationS },
//     initialStateHash, initialStateSnapshot,
//     phases: [{ name, startT, endT, durationS }],
//     events: [{ name, t }],
//     success, successCriteria, finalMetrics }
//
// Loaded AFTER fleet.js, BEFORE config.js. Safe: no dependencies on state
// or CONFIG at parse time.
// ============================================================================

// Physics version stamp — bump on ANY core physics change (physics.js,
// massProps.js, environment.js, vehicle.js, rcs.js, collision.js).
// Records stamped with mismatched version are ignored (predictions hidden).
// Cheap, safe. Bump manually.
const MISSION_PHYSICS_STAMP = '2024-11-15-1';
function currentPhysicsVersion() { return MISSION_PHYSICS_STAMP; }

// FNV-1a 32-bit hash → base36. Deterministic, no crypto.
function _missionHashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Body + time hash for bit-exact replay comparison. Includes body.id and
// state.simTime per agent's B1/B2 additions. Applied at first tick
// (t = CONFIG.DT) to gate prediction trust.
function missionStateHash(body, simTime) {
  if (!body) return '';
  const t = (simTime !== undefined) ? simTime :
            (typeof state !== 'undefined' ? state.simTime : 0);
  const parts = [
    String(body.id || ''),
    t.toFixed(6),
    Number(body.rx || 0).toFixed(6),
    Number(body.ry || 0).toFixed(6),
    Number(body.vx || 0).toFixed(6),
    Number(body.vy || 0).toFixed(6),
    Number(body.theta || 0).toFixed(8),
    Number(body.omega || 0).toFixed(8),
    Number((body.memberFuel && body.memberFuel[0]) || 0).toFixed(2),
  ];
  (body.engines || []).forEach(e => {
    parts.push(
      String(e.id || ''),
      Number(e.massFlowRate || 0).toFixed(4),
      Number(e.gimbalDeg || 0).toFixed(6)
    );
  });
  return _missionHashStr(parts.join('|'));
}

// comboKey = hash(stackId | presetId | guideName | hash(effectiveConfig))
// Uses live effective constants (post-compat-fill) via GuidanceBridge,
// per agent's A1 tweak. Two presets with same effective constants will
// collide — that's correct behaviour (same run profile = same predictions).
async function computeComboKey(stackId, presetId, guideName) {
  let configJSON = '{}';
  try {
    if (typeof GuidanceBridge !== 'undefined' && GuidanceBridge.ready) {
      const cfg = await GuidanceBridge.requestGuideConfig(guideName);
      if (cfg) configJSON = JSON.stringify(cfg);
    }
  } catch (e) {
    console.warn('[missionRecords] config fetch failed — using empty hash', e);
  }
  const parts = [
    stackId || '',
    presetId || '',
    guideName || '',
    _missionHashStr(configJSON),
  ];
  return _missionHashStr(parts.join('|'));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const MISSION_RECORDS_KEY = 'rocketSim.missionRecords.v1';
let _missionRecordsCache = null;

function loadMissionRecords() {
  if (_missionRecordsCache) return _missionRecordsCache;
  try {
    const raw = localStorage.getItem(MISSION_RECORDS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) { _missionRecordsCache = p; return p; }
    }
  } catch (e) { /* fall through */ }
  _missionRecordsCache = [];
  return [];
}

function saveMissionRecords(records) {
  localStorage.setItem(MISSION_RECORDS_KEY, JSON.stringify(records));
  _missionRecordsCache = null;
}

// Lookup: user records take priority over defaults. Stale records (physics
// mismatch) return null — caller treats as "no record", hides predictions.
function getMissionRecord(comboKey) {
  if (!comboKey) return null;
  // User records take priority over defaults
  const user = loadMissionRecords().find(r => r.comboKey === comboKey);
  if (user && !isRecordStale(user)) {
    // Partial: optimistic — comboKey match is enough. Only physicsVersion
    // staleness disqualifies (already checked above).
    // Complete: same — hash gate applied at CALLER level (Round 3 UI)
    // only if record.complete + initial hash mismatch. This function
    // returns the record regardless; caller decides trust level.
    return user;
  }
  if (typeof DEFAULT_MISSION_RECORDS !== 'undefined' && Array.isArray(DEFAULT_MISSION_RECORDS)) {
    const def = DEFAULT_MISSION_RECORDS.find(r => r.comboKey === comboKey);
    if (def && !isRecordStale(def)) return def;
  }
  return null;
}

function isRecordStale(record) {
  if (!record) return true;
  return record.physicsVersion !== currentPhysicsVersion();
}

function upsertUserMissionRecord(record) {
  const records = loadMissionRecords();
  const idx = records.findIndex(r => r.comboKey === record.comboKey);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  saveMissionRecords(records);
  console.log('[missionRecords] saved:', record.comboKey,
              '(' + (record.success ? 'success' : 'failed') + ')');
}

function deleteUserMissionRecord(comboKey) {
  const filtered = loadMissionRecords().filter(r => r.comboKey !== comboKey);
  saveMissionRecords(filtered);
}

// ---------------------------------------------------------------------------
// Capture helper — build a record from current guide status
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Guide session tracking — captures comboKey + startHash once at guide start
// ---------------------------------------------------------------------------
window.__guideSession = null;

function startGuideSession(stackId, guideName) {
  window.__guideSession = {
    stackId: stackId,
    guideName: guideName,
    comboKey: null,
    comboKeyPromise: null,
    startHash: null,
    startT: null,
  };
  window.__guideSession.comboKeyPromise = computeComboKey(stackId, '', guideName)
    .then(function (k) {
      if (window.__guideSession) window.__guideSession.comboKey = k;
      return k;
    });
  console.log('[missionRecords] session started:', stackId, guideName);
}

function endGuideSession() {
  window.__guideSession = null;
  console.log('[missionRecords] session ended');
}

// ---------------------------------------------------------------------------
// Save policy — partial vs complete handling
//   - Complete overrides partial (upgrade)
//   - Complete overrides complete (latest wins)
//   - Partial overrides partial (latest wins)  
//   - Partial does NOT override complete (skip — better data preserved)
// ---------------------------------------------------------------------------
function saveMissionRecordWithPolicy(record) {
  if (!record || !record.comboKey) return { action: 'skipped', reason: 'no comboKey' };
  const records = loadMissionRecords();
  const existing = records.find(function (r) { return r.comboKey === record.comboKey; });
  
  if (existing) {
    if (record.partial && !existing.partial) {
      return { action: 'skipped', reason: 'complete record already exists' };
    }
    // All other cases: overwrite (complete→complete, partial→partial, complete→partial)
  }
  
  upsertUserMissionRecord(record);
  return { action: 'saved' };
}

window.captureCurrentMissionRecord = async function () {
  if (typeof state === 'undefined' || !state.bodies) {
    return { error: 'no state' };
  }
  const activeIdx = state.activeBodyIndex || 0;
  const body = state.bodies[activeIdx];
  if (!body) return { error: 'no active body' };

  const gs = (typeof window !== 'undefined' && window.__lastGuideStatus) || {};
  if (!gs.active) return { error: 'no active guide' };

  const session = window.__guideSession;
  if (!session) return { error: 'guide session not initialized' };
  
  // comboKey — wait for async if still pending
  if (!session.comboKey && session.comboKeyPromise) {
    try { await session.comboKeyPromise; } catch (e) {}
  }
  if (!session.comboKey) return { error: 'comboKey not ready — try again in 1s' };

  const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  if (!stk) return { error: 'no active stack' };

  const isPartial = !gs.runResult || gs.runResult === 'in-progress';
  
  // Only phases with BOTH startT and endT set (fully completed)
  const phases = Object.entries(gs.phaseLog || {})
    .filter(([_, e]) => typeof e.startT === 'number' && typeof e.endT === 'number')
    .map(([name, e]) => ({
      name,
      startT: e.startT,
      endT: e.endT,
      durationS: e.endT - e.startT,
    }));
  
  const events = (gs.events || []).slice();
  
  return {
    schemaVersion: 1,
    physicsVersion: currentPhysicsVersion(),
    comboKey: session.comboKey,
    partial: isPartial,
    captureT: state.simTime,
    currentPhase: gs.phase || null,
    metadata: {
      stackId: stk.id,
      stackName: stk.name,
      presetId: '',
      presetName: '',
      guideName: session.guideName,
      recordedAt: new Date().toISOString(),
      recordedBy: 'manual',
      durationS: state.simTime,
    },
    initialStateHash: session.startHash || missionStateHash(body, state.simTime),
    initialStateSnapshot: session.startSnapshot || {
      t: state.simTime,
      bodyId: body.id,
      rx: body.rx, ry: body.ry,
      vx: body.vx, vy: body.vy,
      theta: body.theta, omega: body.omega,
      fuel: (body.memberFuel && body.memberFuel[0]) || 0,
      engines: (body.engines || []).map(function (e) {
        return { id: e.id, mf: e.massFlowRate, gimbal: e.gimbalDeg };
      }),
    },
    phases: phases,
    events: events,
    success: isPartial ? null : (gs.runResult === 'success'),
    successCriteria: {},
    finalMetrics: isPartial ? null : {},
  };
};;

// Public API alias so future code doesn't need 'window.'
if (typeof globalThis !== 'undefined') {
  globalThis.missionStateHash = missionStateHash;
  globalThis.startGuideSession = startGuideSession;
  globalThis.endGuideSession = endGuideSession;
  globalThis.saveMissionRecordWithPolicy = saveMissionRecordWithPolicy;
  globalThis.computeComboKey = computeComboKey;
  globalThis.getMissionRecord = getMissionRecord;
  globalThis.loadMissionRecords = loadMissionRecords;
  globalThis.upsertUserMissionRecord = upsertUserMissionRecord;
  globalThis.deleteUserMissionRecord = deleteUserMissionRecord;
  globalThis.currentPhysicsVersion = currentPhysicsVersion;
  globalThis.isRecordStale = isRecordStale;
}
