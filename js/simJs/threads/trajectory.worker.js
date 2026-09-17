// ============================================================================
// trajectory.worker.js — dedicated thread for the predicted-trajectory
// leapfrog integration (Optimization #2).
//
// WHY THIS EXISTS: computePredictedTrajectory() (500-sample leapfrog,
// ~0.3-0.5 ms) used to run INSIDE physics_worker.js's own tick loop, sharing
// its 12 ms-per-tick budget with the actual physics substeps. Under high
// time-warp — where physicsStep() already runs many substeps to catch up —
// that shared budget got tight, and the trajectory compute could shave time
// off the physics steps themselves (or vice versa: dtReal/loop timing gets
// noisy). Moving it here means it runs on its own CPU core/thread and can
// never block or get blocked by the physics tick.
//
// SCOPE — deliberately tiny: computePredictedTrajectory (see
// trajectoryMath.js) only ever reads CONFIG.GM_EARTH / EARTH_RADIUS /
// EARTH_OMEGA and the 4 numbers body.rx/ry/vx/vy. Nothing else — no
// `state`, no ENGINES, no mass props, no collision/rcs logic. So this
// worker only needs the same config-resolution chain physics_worker.js
// and render_worker.js already load (componentLibrary → customDesign →
// fleet → config, so CONFIG reflects the actual selected vehicle exactly
// like it does everywhere else) plus trajectoryMath.js itself. It does NOT
// import physics.js, collision.js, vehicle.js, rcs.js, massProps.js,
// environment.js, or stateBuffer.js — none of that is reachable from
// computePredictedTrajectory, and importing it would just be dead weight
// on this worker's boot.
//
// PROTOCOL (all messages are tiny — no bodies/engines objects ever cross
// this boundary):
//   in  { type:'hydrate', keys }              — same keys physics_worker.js
//                                                 uses, forwarded verbatim
//                                                 so CONFIG resolves
//                                                 identically on both.
//   out { type:'ready' }                      — importScripts done.
//   in  { type:'compute', rx, ry, vx, vy,
//          maxSamples, maxTimeSec }           — one request per ~16 ms
//                                                 tick, only while the
//                                                 trajectory checkbox is on.
//   out { type:'result', data }               — data is exactly the object
//                                                 computePredictedTrajectory
//                                                 already returns; its two
//                                                 Float32Arrays are sent as
//                                                 Transferable Objects
//                                                 (zero-copy), same as the
//                                                 old inline path did.
//   out { type:'bootError'|'computeError',
//          message, stack }                   — surfaced so a failure here
//                                                 doesn't just silently
//                                                 stop the trajectory
//                                                 overlay with no trace.
// ============================================================================

if (typeof localStorage === 'undefined') {
  const _store = Object.create(null);
  globalThis.localStorage = {
    getItem: (k) => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
    clear: () => { for (const k in _store) delete _store[k]; },
    key: (i) => Object.keys(_store)[i] ?? null,
    get length() { return Object.keys(_store).length; },
  };
}

let bootstrapped = false;

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'hydrate' && !bootstrapped) {
    try {
      for (const k in msg.keys) {
        const v = msg.keys[k];
        if (v === null || v === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }

      importScripts(
        '../../componentLibrary.js',
        '../../customDesign.js',
        '../../fleet.js',
        '../../config.js',
        '../core/trajectoryMath.js'
      );

      bootstrapped = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'bootError', message: String(err), stack: err && err.stack });
    }
    return;
  }

  if (!bootstrapped) return; // ignore anything before hydration, same guard as the other two workers

  if (msg.type === 'compute') {
    try {
      // Plain object, not a real body — computePredictedTrajectory only
      // ever touches these 4 fields (checked in trajectoryMath.js).
      const body = { rx: msg.rx, ry: msg.ry, vx: msg.vx, vy: msg.vy };
      const result = computePredictedTrajectory(body, msg.maxSamples || 500, msg.maxTimeSec || 1200);

      const transfers = [];
      if (result) {
        if (result.pointsXy && result.pointsXy.buffer) transfers.push(result.pointsXy.buffer);
        if (result.pointsXyEarthFixed && result.pointsXyEarthFixed.buffer) transfers.push(result.pointsXyEarthFixed.buffer);
      }
      self.postMessage({ type: 'result', data: result }, transfers);
    } catch (err) {
      self.postMessage({ type: 'computeError', message: String(err), stack: err && err.stack });
    }
  }
};
