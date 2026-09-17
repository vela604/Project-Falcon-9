// ============================================================================
// stateBuffer.js — Optimization #1, Step 1.
//
// Fixed-layout Float64Array schema for the "hot" per-tick physics fields
// (position, velocity, orientation, fuel, per-engine throttle/thrust/gimbal).
// This buffer is moved between the physics worker and the main thread via
// the Transferable Objects mechanism (postMessage(buf, [buf.buffer])) — a
// zero-copy move, not a structured-clone deep copy.
//
// IMPORTANT — scope: this buffer only ever carries the fields that change
// EVERY physics tick. Everything else (crashed/landed flags, legs, rcsCmd,
// separation flash, trajectory, engine ids/Fmax/Fmin/Ve/isCenter/gimbal-
// capability) still travels on the existing object-clone snapshot path in
// physics_worker.js's serializeForMain(), just less often (Step 2/3). That
// existing snapshot is also what keeps this buffer's *structure* (body
// count, engine count per body, array order) in sync — decodeHotState()
// below assumes the target `bodies` array it's writing into already has the
// right shape, and only overwrites scalar values in place.
//
// physics.js itself is NOT touched by this optimization — it keeps
// computing on its normal body/engine objects exactly as before. Only the
// transport step changes.
// ============================================================================

// ---- Capacity (generous fixed upper bounds so the buffer never needs to
//      be resized mid-flight; resizing only happens on structural events
//      like separation, which are rare and already go through the slow
//      snapshot path anyway) ----
const HOT_STATE_MAX_BODIES = 10;
const HOT_STATE_MAX_ENGINES_PER_BODY = 16; // covers octaweb-merlin9 (1 center + up to ~9 outer) with headroom

// [0] rx
// [1] ry
// [2] vx
// [3] vy
// [4] theta
// [5] omega
// [6] fuelMass
// [7] engineCount   (how many of the engine slots below are actually valid)
// [8] legsProgress  (0..1 animation; 0 for bodies with no legs)
// [9] legsDeployed  (0 or 1; flag)
// [10 .. 10 + N*3)  per-engine: throttle, currentF, gimbalDeg
const HOT_STATE_BODY_HEADER_FLOATS = 10;
const HOT_STATE_FLOATS_PER_ENGINE = 3; // throttle, currentF, gimbalDeg
const HOT_STATE_BODY_STRIDE =
  HOT_STATE_BODY_HEADER_FLOATS + HOT_STATE_MAX_ENGINES_PER_BODY * HOT_STATE_FLOATS_PER_ENGINE;

// ---- Whole-buffer layout ----
// [0] bodyCount
// [1 .. 1 + MAX_BODIES * BODY_STRIDE) : bodies, each HOT_STATE_BODY_STRIDE floats
const HOT_STATE_HEADER_FLOATS = 1;
const HOT_STATE_TOTAL_FLOATS =
  HOT_STATE_HEADER_FLOATS + HOT_STATE_MAX_BODIES * HOT_STATE_BODY_STRIDE;

/**
 * Allocate a fresh hot-state buffer. Call this twice up front (double
 * buffer) — never allocate one of these inside the tick loop.
 */
function createHotStateBuffer() {
  return new Float64Array(HOT_STATE_TOTAL_FLOATS);
}

/**
 * Write the current hot fields of `bodies` into `buf` (mutates buf,
 * allocates nothing). Returns { ok, truncatedBodies, truncatedEngines } —
 * if either truncated flag is true, HOT_STATE_MAX_BODIES /
 * HOT_STATE_MAX_ENGINES_PER_BODY needs to be raised; the buffer still
 * writes as much as it can rather than throwing, so a bad flight doesn't
 * crash the worker.
 */
function encodeHotState(buf, bodies) {
  const bodyCount = bodies.length;
  const usedBodies = Math.min(bodyCount, HOT_STATE_MAX_BODIES);
  buf[0] = usedBodies;
  
  let truncatedBodies = bodyCount > HOT_STATE_MAX_BODIES;
  let truncatedEngines = false;
  
  for (let i = 0; i < usedBodies; i++) {
    const b = bodies[i];
    const base = HOT_STATE_HEADER_FLOATS + i * HOT_STATE_BODY_STRIDE;
    
    buf[base + 0] = b.rx;
    buf[base + 1] = b.ry;
    buf[base + 2] = b.vx;
    buf[base + 3] = b.vy;
    buf[base + 4] = b.theta;
    buf[base + 5] = b.omega;
    buf[base + 6] = b.fuelMass;
    buf[base + 8] = b.legs ? (b.legs.progress || 0) : 0;
    buf[base + 9] = (b.legs && b.legs.deployed) ? 1 : 0;
    
    const engines = b.engines || [];
    const usedEngines = Math.min(engines.length, HOT_STATE_MAX_ENGINES_PER_BODY);
    if (engines.length > HOT_STATE_MAX_ENGINES_PER_BODY) truncatedEngines = true;
    buf[base + 7] = usedEngines;
    
    const engBase = base + HOT_STATE_BODY_HEADER_FLOATS;
    for (let j = 0; j < usedEngines; j++) {
      const e = engines[j];
      const eb = engBase + j * HOT_STATE_FLOATS_PER_ENGINE;
      buf[eb + 0] = e.throttle;
      buf[eb + 1] = e.currentF;
      buf[eb + 2] = e.gimbalDeg;
    }
  }
  
  return { ok: !truncatedBodies && !truncatedEngines, truncatedBodies, truncatedEngines };
}

/**
 * Read `buf` back into an existing `bodies` array, mutating each body/engine
 * object IN PLACE (no new objects, no array replacement) — so any code
 * elsewhere holding a reference to state.bodies[i] or body.engines[j] keeps
 * working unchanged.
 *
 * Assumes `bodies` already has the correct length/shape (kept in sync by
 * the slower structural snapshot, not by this function) — if buf reports a
 * bodyCount that doesn't match bodies.length, the mismatched tail is simply
 * skipped rather than guessed at, and the caller can detect that from the
 * return value to trigger a structural resync.
 */
function decodeHotState(buf, bodies) {
  const bufBodyCount = buf[0];
  const n = Math.min(bufBodyCount, bodies.length, HOT_STATE_MAX_BODIES);
  
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    const base = HOT_STATE_HEADER_FLOATS + i * HOT_STATE_BODY_STRIDE;
    
    b.rx = buf[base + 0];
    b.ry = buf[base + 1];
    b.vx = buf[base + 2];
    b.vy = buf[base + 3];
    b.theta = buf[base + 4];
    b.omega = buf[base + 5];
    b.fuelMass = buf[base + 6];
    
    // Legs — recreate the {deployed, progress} object if this body
    // doesn't have one yet (fairing halves and payloads don't get a legs
    // object at creation time in the worker, so this can arrive as null
    // on the decode side until the first hot buffer touches it).
    if (!b.legs) b.legs = { deployed: false, progress: 0 };
    b.legs.progress = buf[base + 8];
    b.legs.deployed = buf[base + 9] > 0.5;
    
    const engines = b.engines || [];
    const usedEngines = Math.min(buf[base + 7], engines.length, HOT_STATE_MAX_ENGINES_PER_BODY);
    const engBase = base + HOT_STATE_BODY_HEADER_FLOATS;
    for (let j = 0; j < usedEngines; j++) {
      const e = engines[j];
      const eb = engBase + j * HOT_STATE_FLOATS_PER_ENGINE;
      e.throttle = buf[eb + 0];
      e.currentF = buf[eb + 1];
      e.gimbalDeg = buf[eb + 2];
    }
  }
  
  return { bodyCountMatches: bufBodyCount === bodies.length };
}