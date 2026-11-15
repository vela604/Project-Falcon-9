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

// Event schema version — bump WHEN NEW EVENTS ARE ADDED to guidance.
// Does NOT invalidate existing records (events are metadata, not physics).
// Old records still load; they simply lack the newer event types.
//
// IMPORTANT: MISSION_PHYSICS_STAMP must NOT be bumped for event-only
// changes. Bumping it invalidates ALL existing records. Only bump when
// trajectory/timing-affecting physics actually changes (mass props,
// control laws, atmosphere model, etc.).
const MISSION_EVENT_SCHEMA_VERSION = 2;
function currentPhysicsVersion() { return MISSION_PHYSICS_STAMP; }
function currentEventSchemaVersion() { return MISSION_EVENT_SCHEMA_VERSION; }

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
function missionStateHash(body, simTime, bodyIdx) {
  if (!body) return '';
  const idx = Number.isInteger(bodyIdx) ? bodyIdx : 0;
  const t = (simTime !== undefined) ? simTime :
            (typeof state !== 'undefined' ? state.simTime : 0);
  const parts = [
    'idx:' + idx,
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
  // Physics-affecting environment state — same stack/preset/guide/constants
  // with different wind or atmosphere toggles is a GENUINELY different
  // flight, so it must produce a different comboKey. Without this, one
  // comboKey could mean "wind-off run" yesterday and "wind-on run" today,
  // and the record silently mispredicts.
  const envState = {
    wind: (typeof wind !== 'undefined' && wind) ? {
      enabled: !!wind.enabled,
      speed: Number.isFinite(wind.speed) ? Math.round(wind.speed * 100) / 100 : 0,
      directionDeg: Number.isFinite(wind.directionDeg) ? Math.round(wind.directionDeg * 10) / 10 : 0,
    } : { enabled: false, speed: 0, directionDeg: 0 },
    atmosphere: (typeof atmosphereEnabled !== 'undefined') ? !!atmosphereEnabled : true,
    slosh: (typeof sloshEnabled !== 'undefined') ? !!sloshEnabled : true,
    imu: (typeof imuEnabled !== 'undefined') ? !!imuEnabled : false,
  };
  const parts = [
    stackId || '',
    presetId || '',
    guideName || '',
    _missionHashStr(configJSON),
    _missionHashStr(JSON.stringify(envState)),
  ];
  return _missionHashStr(parts.join('|'));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const MISSION_RECORDS_KEY = 'rocketSim.missionRecords.v1';
let _missionRecordsCache = null;


// Records with partial=true AND success=true are internally inconsistent.
// Created when tester2 mutated a captured success record to add partial
// flag (marking "not full-END") without clearing success. For payload-
// mission envelope, success implies complete → normalize to partial=false.
function _normalizePartialSuccessConflict(records) {
  let fixed = 0;
  records.forEach(r => {
    if (r && r.partial === true && r.success === true) {
      r.partial = false;
      if (!r._debug) r._debug = {};
      r._debug._normalizedPartialConflict = true;
      fixed++;
    }
  });
  if (fixed > 0) {
    console.log('[missionRecords] normalized ' + fixed + ' record(s): partial+success -> partial=false');
  }
  return fixed;
}

function loadMissionRecords() {
  if (_missionRecordsCache) {
    if (!_missionRecordsCache.__normalized) {
      const _fixed = _normalizePartialSuccessConflict(_missionRecordsCache);
      try { Object.defineProperty(_missionRecordsCache, '__normalized', { value: true, enumerable: false, configurable: true }); } catch (e) { _missionRecordsCache.__normalized = true; }
      if (_fixed > 0) {
        try { localStorage.setItem(MISSION_RECORDS_KEY, JSON.stringify(_missionRecordsCache)); } catch (e) {}
      }
    }
    return _missionRecordsCache;
  }
  try {
    const raw = localStorage.getItem(MISSION_RECORDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const _fixed = _normalizePartialSuccessConflict(parsed);
        _missionRecordsCache = parsed;
        try { Object.defineProperty(parsed, '__normalized', { value: true, enumerable: false, configurable: true }); } catch (e) { parsed.__normalized = true; }
        if (_fixed > 0) {
          try { localStorage.setItem(MISSION_RECORDS_KEY, JSON.stringify(parsed)); } catch (e) {}
        }
        return parsed;
      }
    }
  } catch (e) { /* fall through */ }
  _missionRecordsCache = [];
  try { Object.defineProperty(_missionRecordsCache, '__normalized', { value: true, enumerable: false, configurable: true }); } catch (e) { _missionRecordsCache.__normalized = true; }
  return [];
}

function saveMissionRecords(records) {
  // Defense-in-depth at storage boundary. Multiple callers exist:
  //   - saveMissionRecordWithPolicy (has guards)
  //   - upsertUserMissionRecord (has guards, after recent fix)
  //   - tester2's partial-on-stop (bypasses both, calls here directly)
  // Without a guard here, tester2's partial save overwrites the
  // success record written moments earlier in the same session.
  //
  // Read current storage, walk the incoming array, replace any
  // dangerous transition (partial-over-complete, failed-over-success)
  // with the existing record. Preserves the good record's data.
  let current = [];
  try {
    const raw = localStorage.getItem(MISSION_RECORDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) current = parsed;
    }
  } catch (e) { current = []; }
  const currentByKey = new Map();
  current.forEach(r => { if (r && r.comboKey) currentByKey.set(r.comboKey, r); });

  const filtered = [];
  let blocked = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || !r.comboKey) { filtered.push(r); continue; }
    const existing = currentByKey.get(r.comboKey);
    if (existing) {
      if (r.partial && !existing.partial) {
        console.warn('[missionRecords] saveMissionRecords BLOCKED: partial cannot overwrite complete', r.comboKey);
        filtered.push(existing);
        blocked++;
        continue;
      }
      if (r.success === false && existing.success === true) {
        console.warn('[missionRecords] saveMissionRecords BLOCKED: failed cannot overwrite success', r.comboKey);
        filtered.push(existing);
        blocked++;
        continue;
      }
    }
    filtered.push(r);
  }

  try {
    localStorage.setItem(MISSION_RECORDS_KEY, JSON.stringify(filtered));
    _missionRecordsCache = null;
    if (blocked > 0) {
      console.log('[missionRecords] saveMissionRecords: ' + blocked + ' dangerous transition(s) blocked');
    }
    return true;
  } catch (e) {
    console.error('[missionRecords] save failed', e);
    return false;
  }
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
  // Physics version is the ONLY staleness signal. Adding new events
  // (MISSION_EVENT_SCHEMA_VERSION bump) does NOT invalidate records —
  // old records still load fine, just missing the newer event types.
  return record.physicsVersion !== currentPhysicsVersion();
}

function upsertUserMissionRecord(record) {
  const records = loadMissionRecords();
  const idx = records.findIndex(r => r.comboKey === record.comboKey);
  if (idx >= 0) {
    const existing = records[idx];
    // Defense-in-depth: policy-enforcing callers (saveMissionRecordWithPolicy)
    // already filter these cases, but a direct caller (e.g. tester2 partial-
    // on-stop, external scripts) can bypass. Prevent data loss here too.
    const _incomingPartial  = !!record.partial;
    const _existingPartial  = !!existing.partial;
    const _incomingFailed   = record.success === false;
    const _existingSuccess  = existing.success === true;
    if (_incomingPartial && !_existingPartial) {
      console.warn('[missionRecords] upsert SKIPPED: partial cannot overwrite complete', record.comboKey);
      return { action: 'skipped', reason: 'partial cannot overwrite complete' };
    }
    if (_incomingFailed && _existingSuccess) {
      console.warn('[missionRecords] upsert SKIPPED: failed cannot overwrite success', record.comboKey);
      return { action: 'skipped', reason: 'failed cannot overwrite success' };
    }
    records[idx] = record;
  } else {
    records.push(record);
  }
  saveMissionRecords(records);
  const _statusLabel = record.success === true ? 'success' :
                     record.success === false ? 'failed' :
                     'partial';
  const _inferredNote = (record._debug && record._debug.inferredSuccess === true) ? ' (inferred)' : '';
  console.log('[missionRecords] saved:', record.comboKey, '(' + _statusLabel + ')' + _inferredNote);
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

function startGuideSession(stackId, guideName, presetId, presetName) {
  window.__guideSession = {
    stackId: stackId,
    guideName: guideName,
    presetId: presetId || '',
    presetName: presetName || '',
    comboKey: null,
    comboKeyPromise: null,
    startHash: null,
    startT: null,
  };
  // Reset auto-save / phase-tracking flags at each guide start so a new
  // guide sequence is clean.
  window.__autoSavedForSession = false;
  window.__prevGuidePhase = null;
  window.__prevRunResult = null;
  // Phase 1 — comboKey now includes presetId. Same guide+stack but
  // different preset → different comboKey → separate record slots.
  // Records then group correctly in the "Recorded Data" panel by preset.
  window.__guideSession.comboKeyPromise = computeComboKey(stackId, presetId || '', guideName)
    .then(function (k) {
      if (window.__guideSession) window.__guideSession.comboKey = k;
      console.log('[missionRecords] comboKeyPromise resolved:', k, '(', stackId, presetId || '(no preset)', guideName, ')');
      return k;
    })
    .catch(function (e) {
      // Defensive — capture's await-catch was silently swallowing this
      // rejection, leaving session.comboKey null and producing
      // 'comboKey not ready' error with no diagnostic trail.
      console.warn('[missionRecords] comboKeyPromise REJECTED:', e && e.message ? e.message : e);
      console.warn('[missionRecords] comboKeyPromise reject stack:', e && e.stack ? e.stack : '(none)');
      return null;
    });
  console.log('[missionRecords] session started:', stackId, guideName,
              presetId ? ('· preset ' + (presetName || presetId)) : '· no preset');
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
    // Decision #5: partial must NOT overwrite complete.
    // Edge case: partial=true+success=true (tester2 mutation quirk) is
    // effectively complete. Treat as complete to prevent quirk records
    // overwriting cleaner complete records.
    const _incomingEffectiveComplete = !record.partial || (record.partial === true && record.success === true);
    const _existingEffectiveComplete = !existing.partial || (existing.partial === true && existing.success === true);
    if (!_incomingEffectiveComplete && _existingEffectiveComplete) {
      console.log('[missionRecords] savePolicy SKIPPED: complete exists (partial incoming)', record.comboKey);
      return { action: 'skipped', reason: 'complete record already exists' };
    }
    // All other cases: overwrite (complete→complete, partial→partial, complete→partial)
  }
  
  upsertUserMissionRecord(record);
  return { action: 'saved' };
}

// Phase 1 — record lookup helpers for the preset panel.
// A preset's records are all records whose metadata.presetId matches.
// Grouped by env so the panel can show "1 env" (common) or "N envs"
// (rare multi-env tuning sessions) cleanly.
function getMissionRecordsForPreset(presetId) {
  if (!presetId) return [];
  return loadMissionRecords().filter(function(r){
    return r && r.metadata && r.metadata.presetId === presetId;
  });
}

function getRecordsGroupedByEnvForPreset(presetId) {
  const recs = getMissionRecordsForPreset(presetId);
  const groups = {};
  recs.forEach(function(r){
    const env = (r.metadata && r.metadata.env) || {};
    const key = JSON.stringify(env);
    if (!groups[key]) groups[key] = { env: env, records: [] };
    groups[key].records.push(r);
  });
  return Object.values(groups);
}


// ---------------------------------------------------------------------------
// One-time backfill — records captured before the preset-binding fix have
// metadata.presetId = '' (empty). Without presetId they can't be filtered
// by the "Recorded Data" panel (which matches on exact preset ID).
//
// Assigns such records to the baseline default of their guideName
// (default:<guide>), the most likely preset at capture time. Idempotent
// — runs once per browser session. Tags records with _presetInferred:true.
window.captureCurrentMissionRecord = async function () {
  if (typeof state === 'undefined' || !state.bodies) {
    return { error: 'no state' };
  }
  const activeIdx = state.activeBodyIndex || 0;
  const body = state.bodies[activeIdx];
  if (!body) return { error: 'no active body' };

  // Prefer the worker-pushed cached status (set by controls.js's
  // onGuidanceStatus). Fall back to a LIVE Guidance.getGuideStatus() call
  // when the cache is missing or stale — needed on:
  //   1. Single-thread pages (guidance-tester2.html) where no worker
  //      pushes status, so __lastGuideStatus never gets set.
  //   2. Fresh page loads before the first worker tick has arrived.
  //   3. Force-captured captures where the caller triggered capture
  //      without a full status pipeline running.
  // Zero side effects: only reads, does not cache the live result back
  // into __lastGuideStatus (worker push should own that field).
  let gs = (typeof window !== 'undefined' && window.__lastGuideStatus) || null;
  if (!gs || !gs.active) {
    try {
      if (typeof Guidance !== 'undefined' && typeof Guidance.getGuideStatus === 'function') {
        const _live = Guidance.getGuideStatus();
        if (_live && _live.active) gs = _live;
      }
    } catch (e) {
      // Guidance lookup failed — fall through with gs as-is (null).
    }
  }
  if (!gs) gs = {};
  if (!gs.active) return { error: 'no active guide' };

  const session = window.__guideSession;
  if (!session) {
    console.warn('[missionRecords] capture failed: session is null', {
      gsActive: gs.active, gsPhase: gs.phase, simTime: state.simTime,
    });
    return { error: 'guide session not initialized' };
  }
  // Entry-point diagnostic — small, cheap, tells us comboKey presence
  // and promise presence in one line. Left in permanently (one line).
  console.log('[missionRecords] capture entry:',
    'comboKey=' + (session.comboKey || 'null'),
    'hasPromise=' + !!session.comboKeyPromise,
    'stackId=' + session.stackId,
    'guideName=' + session.guideName);
  
  // comboKey — wait for async if still pending
  if (!session.comboKey && session.comboKeyPromise) {
    try { await session.comboKeyPromise; } catch (e) {}
  }
  if (!session.comboKey) {
    // Rich diagnostic — what state was the session in when we gave up?
    // Helps distinguish (a) promise still pending, (b) promise rejected,
    // (c) session was force-replaced without comboKeyPromise set.
    const _dbg = {
      hasComboKey: !!session.comboKey,
      hasComboKeyPromise: !!session.comboKeyPromise,
      promiseType: session.comboKeyPromise ? typeof session.comboKeyPromise : 'null',
      hasStackId: !!session.stackId,
      hasGuideName: !!session.guideName,
      sessionKeys: Object.keys(session).join(','),
      gsActive: gs.active,
      gsPhase: gs.phase,
    };
    console.warn('[missionRecords] capture failed at comboKey gate:', _dbg);
    return { error: 'comboKey not ready — try again in 1s', _debug_comboKey: _dbg };
  }

  const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  if (!stk) return { error: 'no active stack' };

  const isPartial = !gs.runResult || gs.runResult === 'in-progress';
  
  // Fallback success inference — if guide hit a terminal phase but runResult
  // is stale (agent's state machine can lag DONE by the payload-clear
  // distance threshold, up to 120s), infer success from terminal events.
  // Prevents blocking the user when the guide actually finished successfully.
  let inferredSuccess = null;
  let inferredAt = null;     // 'DONE' | 'END' — which phase triggered inference
  let inferredMode = null;   // 'payload_deployed' | 'touchdown' | 'impact'
  if (isPartial && (gs.phase === 'DONE' || gs.phase === 'END')) {
    const _evts = gs.events || [];
    const _hasPayloadSuccess = _evts.some(e => e.name === 'PAYLOAD_RELEASE' || e.name === 'PAYLOAD_OPEN');
    const _hasLandingSuccess = _evts.some(e => e.name === 'TOUCHDOWN_COMPLETE' || e.name === 'LANDED');
    const _hasFailure = _evts.some(e => e.name === 'IMPACT' || e.name === 'CRASH' || e.name === 'FAILED');
    if (_hasFailure) { inferredSuccess = false; inferredMode = 'impact'; }
    else if (_hasPayloadSuccess) { inferredSuccess = true; inferredMode = 'payload_deployed'; }
    else if (_hasLandingSuccess) { inferredSuccess = true; inferredMode = 'touchdown'; }
    if (inferredSuccess !== null) inferredAt = gs.phase;
  }
  const _effPartial = inferredSuccess !== null ? false : isPartial;
  const _effSuccess = inferredSuccess !== null ? inferredSuccess : (isPartial ? null : (gs.runResult === 'success'));
  
  // Only phases with BOTH startT and endT set (fully completed)
  const phases = Object.entries(gs.phaseLog || {})
    .filter(([_, e]) => typeof e.startT === 'number' && typeof e.endT === 'number')
    .map(([name, e]) => ({
      name,
      startT: e.startT,
      endT: e.endT,
      durationS: e.endT - e.startT,
      // Schema v2: per-member fuel consumption during this phase.
      // Array of { memberId, role, fuelUsed } for members that drained
      // >1g during the phase. Empty for pre-v2 phaseLog entries.
      fuelDelta: Array.isArray(e.fuelDelta) ? e.fuelDelta.slice() : [],
    }));
  
  const events = (gs.events || []).slice();
  
  return {
    schemaVersion: 3,
    physicsVersion: currentPhysicsVersion(),
    eventSchemaVersion: MISSION_EVENT_SCHEMA_VERSION,
    comboKey: session.comboKey,
    partial: _effPartial,
    captureT: state.simTime,
    currentPhase: gs.phase || null,
    metadata: {
      stackId: stk.id,
      stackName: stk.name,
      presetId: session.presetId || '',
      presetName: session.presetName || '',
      guideName: session.guideName,
      recordedAt: new Date().toISOString(),
      recordedBy: 'manual',
      durationS: state.simTime,
      // Phase 1 — env snapshot for panel grouping. Without this, "which env
      // produced this record" is only recoverable via the one-way comboKey
      // hash. With it, the panel groups records by exact env cleanly.
      env: (function(){
        try {
          return {
            wind: (typeof wind !== 'undefined' && wind) ? {
              enabled: !!wind.enabled,
              speed: Number.isFinite(wind.speed) ? Math.round(wind.speed*100)/100 : 0,
              directionDeg: Number.isFinite(wind.directionDeg) ? Math.round(wind.directionDeg*10)/10 : 0,
            } : { enabled: false, speed: 0, directionDeg: 0 },
            atmosphere: (typeof atmosphereEnabled !== 'undefined') ? !!atmosphereEnabled : true,
            slosh: (typeof sloshEnabled !== 'undefined') ? !!sloshEnabled : true,
            imu: (typeof imuEnabled !== 'undefined') ? !!imuEnabled : false,
          };
        } catch (e) { return null; }
      })(),
    },
    initialStateHash: session.startHash || missionStateHash(body, state.simTime, state.activeBodyIndex),
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
    // Schema v2: per-body peak telemetry (MAX_Q, MAX_G). Array of
    // { bodyIdx, bodyTag, peakQ_kPa, peakQ_t, peakG, peakG_t }.
    // Empty for pre-v2 captures (agent didn't ship peaks yet).
    // Schema v2 + client-side peakTemp_K enrichment. Physics peaks
    // array has {bodyIdx, bodyTag, peakQ_*, peakG_*}. We add peakTemp_K
    // per body from telemetry.js's per-member thermal tracker
    // (_bodyTempWeighted, which aggregates members and returns max
    // peak across them). Skip gracefully when function/state unavailable
    // (e.g. tester2 without telemetry.js loaded).
    peaks: Array.isArray(gs.peaks) ? gs.peaks.slice() : [],
    success: _effSuccess,
    // Phase 1 — derived quick-access times. Saves preset-card / panel
    // from re-scanning the events array to show MECO / Booster Land /
    // Payload Deploy on the spec strip. Null when event absent (e.g.
    // LEO missions never fire TOUCHDOWN_COMPLETE, so boosterLandS=null).
    mecoS: (function(){
      const _e = (events.find(function(x){ return x.name === 'MECO'; }) || {}).t;
      return Number.isFinite(_e) ? _e : null;
    })(),
    boosterLandS: (function(){
      const _e = (events.find(function(x){ return x.name === 'TOUCHDOWN_COMPLETE'; }) || {}).t;
      return Number.isFinite(_e) ? _e : null;
    })(),
    payloadDeployS: (function(){
      const _e = (events.find(function(x){ return x.name === 'PAYLOAD_RELEASE'; }) || {}).t;
      return Number.isFinite(_e) ? _e : null;
    })(),
    _debug: {
      runResult: gs.runResult,
      gsPhase: gs.phase,
      gsActive: gs.active,
      inferredSuccess: inferredSuccess !== null ? inferredSuccess : 'no-inference',
      inferredAt: inferredAt,
      inferredMode: inferredMode,
      // Mission scope — 'DONE' means payload deployed and mission is
      // considered complete at this user's operating envelope; 'END'
      // means full suicide-burn + impact sequence ran. Future readers
      // use this to know whether phase list is truncated vs full.
      missionScope: inferredAt,
      // Capture-time counters — record's phase count vs full END-list.
      phaseCountAtCapture: phases.length,
      eventsCountAtCapture: events.length,
      peaksCountAtCapture: Array.isArray(gs.peaks) ? gs.peaks.length : 0,
    },
    successCriteria: {},
    finalMetrics: _effPartial ? null : {},
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
  globalThis.getMissionRecordsForPreset = getMissionRecordsForPreset;
  globalThis.getRecordsGroupedByEnvForPreset = getRecordsGroupedByEnvForPreset;
}
