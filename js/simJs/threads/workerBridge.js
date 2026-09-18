// ============================================================================
// workerBridge.js — main thread side of the physics worker.
// Owns the worker handle, sends commands, and maintains a read-only
// `state` mirror that rendering code reads from as if nothing changed.
//
// OPTIMIZATION #1 (Step 3): the physics worker now sends the per-tick "hot"
// numeric fields (rx, ry, vx, vy, theta, omega, fuelMass, and each engine's
// massFlowRate/currentF/gimbalDeg) as a transferred Float64Array (`hotBuffer`)
// instead of inside the cloned `data.bodies` objects. This file decodes
// that buffer into state.bodies right after assigning the fresh "cold"
// bodies from the clone, then transfers the (now empty) buffer straight
// back to the worker so it can reuse it next tick — see stateBuffer.js for
// the layout and encode/decode helpers.
// ============================================================================

const WorkerBridge = {
  worker: null,
  ready: false,
  readyCallbacks: [],
  pendingMessages: [],
  
  init() {
    this.worker = new Worker('js/simJs/threads/physics.worker.js');
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'state') {
        applyStateSnapshot(msg.data);
      } else if (msg.type === 'bootError') {
        console.error('[bridge] PHYSICS WORKER BOOT FAILED:', msg.message);
        console.error('[bridge] stack:', msg.stack);
      } else if (msg.type === 'ready') {
        if (msg.data) applyStateSnapshot(msg.data);
        this.ready = true;
        
        const q = this.pendingMessages;
        this.pendingMessages = [];
        q.forEach(m => this.worker.postMessage(m.msg, m.transfer || []));
        
        this.readyCallbacks.forEach(cb => { try { cb(); } catch (err) { console.error(err); } });
        this.readyCallbacks = [];
      }
    };
    this.worker.onerror = (err) => console.error('Physics worker error:', err);
  },
  
  // Normal send — queued until worker signals ready. `transfer` (optional)
  // matches postMessage's transfer-list argument — needed for the one-time
  // 'connectGuidance' port handoff (see workerBridge.js's
  // connectGuidanceToPhysics). Pre-existing callers all omit it, which is
  // equivalent to their previous no-transfer behavior.
  send(msg, transfer) {
    if (!this.worker) return;
    if (!this.ready) {
      this.pendingMessages.push({ msg, transfer });
      return;
    }
    this.worker.postMessage(msg, transfer || []);
  },
  
  // Bootstrap-only send — goes straight to the worker, bypassing the queue.
  // Used for the hydrate message itself: if hydrate went through send(), it
  // would sit in pendingMessages forever (worker can't signal ready until
  // it receives hydrate) — a deadlock.
  sendImmediate(msg) {
    if (this.worker) this.worker.postMessage(msg);
  },
  
  onReady(cb) {
    if (this.ready) cb();
    else this.readyCallbacks.push(cb);
  },
};

// ---- Optimization #1, Step 4: this hop's OWN double buffer, separate from
//      the one physics_worker.js<->this file use. Encoded fresh from
//      state.bodies (already fully decoded above) and sent to the render
//      worker on every non-structural tick; the render worker hands each
//      buffer straight back (see returnRenderHotBuffer below), same
//      ping-pong pattern as Step 2/3. ----
let renderHotBuffers = [createHotStateBuffer(), createHotStateBuffer()];

function returnRenderHotBuffer(buffer) {
  if (!buffer) return;
  if (renderHotBuffers.length >= 4) return; // cap — drop extras, GC will reclaim
  renderHotBuffers.push(new Float64Array(buffer));
}

// The render worker needs its OWN first-ever full clone before it can
// accept hot-buffer-only updates (it has nothing yet to decode into). This
// is tracked separately from prevCount/newCount below, because those are
// main thread's own body-count bookkeeping, which can already be non-zero
// by the time window._renderWorker first exists (the 'ready' snapshot is
// applied before the render worker is even created in main.js) — so
// newCount===prevCount can be true on the render worker's very first
// message, which would wrongly send it a hot-only buffer it can't use yet.
let renderWorkerHasBodies = false;

// ---- localStorage keys the worker needs for its own loaders ----
const _WORKER_HYDRATE_KEYS = [
  'rocketSim.fleet.v1',
  'rocketSim.selectedId.v1',
  'rocketSim.stacks.v1',
  'rocketSim.selectedStackId.v1',
  'rocketSim.families.v1',
  'rocketSim.selectedFamilyId.v1',
  'rocketSim.componentLibrary.v1',
  'rocketSim.payloads.v1',
  'rocketSim.payloadSplitDone.v1',
];

// ---- state mirror (mutated in place; physics.js's _makeState() proxies
//      on main thread read through to this via state.bodies[...]) ----
function applyStateSnapshot(snap) {
  const prevCount = state.bodies ? state.bodies.length : 0;
  
  state.activeBodyIndex = snap.activeBodyIndex;
  state.simTime = snap.simTime;
  state.halted = snap.halted;
  if (snap.lastForces) lastForces = snap.lastForces;
  state.bodies = snap.bodies;

  // ---- Optimization #1: fill in the hot numeric fields the buffer carries
  //      (they're absent from snap.bodies — see physics_worker.js's
  //      serializeForMain, which deliberately omits them). Must happen
  //      BEFORE anything below reads body.rx/vx/theta/etc — render,
  //      telemetry, the follow-body refresh, and the render-worker forward
  //      all rely on these being populated already.
  if (snap.hotBuffer) {
    const hotArr = new Float64Array(snap.hotBuffer);
    const decodeResult = decodeHotState(hotArr, state.bodies);
    if (!decodeResult.bodyCountMatches) {
      // The buffer's body count and state.bodies.length disagree — this
      // means a structural event (separation/fairing split/payload
      // release) landed on the SAME tick as this snapshot. Not a bug: the
      // next tick's cold snapshot + buffer will already agree again, since
      // both come from the same worker-side state right after the event.
      // Logged (rate-limited) purely so a *persistent* mismatch is visible.
      console.warn('[workerBridge] hot buffer body count mismatch this tick (expected during separation/staging events)', decodeResult);
    }
    // Hand the buffer straight back so the worker can reuse it next tick
    // instead of allocating a new one.
    if (WorkerBridge.worker) {
      WorkerBridge.worker.postMessage({ type: 'returnHotBuffer', buffer: hotArr.buffer }, [hotArr.buffer]);
    }
  }
  
  // Rebuild the follow-body dropdown whenever the body list changes
  // (separation, fairing split, payload release). Skipping when count
  // matches avoids running this 60×/s — the actual DOM rebuild only
  // happens on real changes.
  const newCount = state.bodies.length;
if (newCount !== prevCount &&
  typeof refreshFollowBodySelect === 'function' &&
  document.getElementById('followBodySelect')) {
  
  // If a body was added this tick carrying the emergencyEject flag,
  // switch the camera to it. The user pressed Emergency Eject precisely
  // to save the payload — leaving the camera on the now-fairing-less
  // active body would make the ejected unit look like it "vanished".
  // Same logic would apply to any future "auto-track the important
  // thing" event; today only emergency eject sets this flag.
  let autoFollowIdx = -1;
  for (let i = prevCount; i < newCount; i++) {
    const b = state.bodies[i];
    if (b && b.emergencyEject) { autoFollowIdx = i; break; }
  }
  if (autoFollowIdx >= 0 && typeof camera !== 'undefined') {
    camera.followBodyIndex = autoFollowIdx;
    camera.follow = true;
    camera.mode = 'local';
  }
  
  refreshFollowBodySelect();
}
  
  
  if (window._renderWorker) {
    const transfers = [];
    let fwdTraj = null;
    if (snap.trajectory) {
      fwdTraj = snap.trajectory;
      if (fwdTraj.pointsXy && fwdTraj.pointsXy.buffer) {
        transfers.push(fwdTraj.pointsXy.buffer);
      }
      if (fwdTraj.pointsXyEarthFixed && fwdTraj.pointsXyEarthFixed.buffer) {
        transfers.push(fwdTraj.pointsXyEarthFixed.buffer);
      }
    }

    const payload = {
      activeBodyIndex: snap.activeBodyIndex,
      simTime: snap.simTime,
      halted: snap.halted,
      trajectory: fwdTraj,
      lastForces: snap.lastForces,
      separationFlash: snap.separationFlash,
      lastPayloadRelease: snap.lastPayloadRelease, // ← add karo
    };

    // ---- Optimization #1, Step 4 ----
    // `newCount !== prevCount` (computed above) means a structural event
    // happened THIS tick (separation/fairing-split/payload-release) or this
    // is the very first snapshot ever — the render worker needs the new
    // object shapes/ids/engine lists, so send the full clone, same as
    // before this optimization. That's rare.
    //
    // Every other tick (the common case): only the hot numeric fields
    // changed, and the render worker already has the same body objects
    // from last time — send just a transferred buffer, it decodes in place.
    if (newCount !== prevCount || !renderWorkerHasBodies) {
      payload.bodies = state.bodies;
      renderWorkerHasBodies = true;
    } else {
      let renderHotBuf = renderHotBuffers.pop();
      if (!renderHotBuf) {
        // Render worker hasn't returned a buffer yet — same rare fallback
        // as physics_worker.js's pool, not an error.
        renderHotBuf = createHotStateBuffer();
      }
      encodeHotState(renderHotBuf, state.bodies);
payload.hotBuffer = renderHotBuf.buffer;
transfers.push(renderHotBuf.buffer);

// RCS puff fix: rcsCmd/lastRcs isn't part of the hot buffer schema,
// so send it separately every tick (cheap — small objects, not a
// full body/engine clone) so the render worker's puff logic sees
// live RCS state instead of whatever was frozen at last full sync.
payload.rcsSync = state.bodies.map(b => ({ rcsCmd: b.rcsCmd, lastRcs: b.lastRcs }));
    }

    window._renderWorker.postMessage({ type: 'state', data: payload }, transfers);
  }
  
  // PHASE 3 — throttled to ~20 Hz internally; safe to call every tick.
  maybeForwardGuidanceSnapshot();
}

// ---- Boot: send initial hydrate from main-thread localStorage ----
function hydrateWorkerFromLocalStorage() {
  const keys = {};
  _WORKER_HYDRATE_KEYS.forEach(k => { keys[k] = localStorage.getItem(k); });
  WorkerBridge.sendImmediate({ type: 'hydrate', keys });
}

// ============================================================================
// PHASE 3 — GuidanceBridge: main-thread side of the guidance worker.
// Deliberately a near-duplicate of WorkerBridge's ready-queue pattern above
// (not a refactor to share code with it) — the two workers' lifecycles are
// independent by design: guidance can boot, hydrate, and go 'ready' on its
// own schedule regardless of where physics is in its own boot, and nothing
// here should make that appear coupled.
// ============================================================================
const GuidanceBridge = {
  worker: null,
  ready: false,
  readyCallbacks: [],
  pendingMessages: [],
  
  init() {
    this.worker = new Worker('js/simJs/threads/guidance.worker.js');
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'bootError') {
        console.error('[bridge] GUIDANCE WORKER BOOT FAILED:', msg.message);
        console.error('[bridge] stack:', msg.stack);
      } else if (msg.type === 'workerError') {
        console.error('[bridge] guidance worker runtime error:', msg.message, msg.stack);
      } else if (msg.type === 'ready') {
        this.ready = true;
        const q = this.pendingMessages;
        this.pendingMessages = [];
        q.forEach(m => this.worker.postMessage(m.msg, m.transfer || []));
        this.readyCallbacks.forEach(cb => { try { cb(); } catch (err) { console.error(err); } });
        this.readyCallbacks = [];
      }
    };
    this.worker.onerror = (err) => console.error('Guidance worker error:', err);
    this.worker.postMessage({ type: 'hydrate' });
  },
  
  // Normal send — queued until worker signals ready. `transfer` (optional)
  // matches postMessage's own transfer-list argument, for the one-time
  // 'connectPhysicsPort' port handoff (see main.js).
  send(msg, transfer) {
    if (!this.worker) return;
    if (!this.ready) {
      this.pendingMessages.push({ msg, transfer });
      return;
    }
    this.worker.postMessage(msg, transfer || []);
  },
  
  onReady(cb) {
    if (this.ready) cb();
    else this.readyCallbacks.push(cb);
  },
};

// ---- Snapshot forwarding: throttled to ~20 Hz by wall clock. Called from
// applyStateSnapshot() below, which runs at full physics-tick rate — this
// function is what actually gates it down. Deliberately NOT reusing the
// render worker's hot-buffer machinery: guidance's snapshot needs to be a
// plain structured-clone object (imu.js's measure() reads/returns plain
// objects), not a Float64Array layout. Per-body projection is fuller than
// "trimmed" now implies (see Issue 1 below) — kept the same delivery
// mechanism, just a richer payload per tick.
let _lastGuidanceSnapshotAt = 0;
const GUIDANCE_SNAPSHOT_INTERVAL_MS = 50; // ~20 Hz

function maybeForwardGuidanceSnapshot() {
  if (!GuidanceBridge.ready) return;
  const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (now - _lastGuidanceSnapshotAt < GUIDANCE_SNAPSHOT_INTERVAL_MS) return;
  _lastGuidanceSnapshotAt = now;
  
  // isActive below reflects state.activeBodyIndex — the physics worker's
  // single source of truth — NOT the body's own `isActive` field. Derived
  // on purpose: the two are always equal in the current code, and if they
  // ever diverge, the index is authoritative. See Issue D in the Phase 3
  // fixes round-2 prompt.
  const bodies = state.bodies.map((b, i) => ({
    rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy, theta: b.theta, omega: b.omega,
    fuelMass: b.fuelMass,
    crashed: !!b.crashed,
    landed: !!b.landed,
    isActive: i === state.activeBodyIndex,
    isDiscarded: !!b.isDiscarded,
    settled: !!b.settled,
    payloadId: b.payloadId || null,
    payloadReleased: !!b.payloadReleased,
    members: b.members || [],
    legs: b.legs ? { deployed: !!b.legs.deployed, progress: b.legs.progress || 0 } : null,
    // NOTE for Phase 4: minMassFlowRate, massFlowRateRateFrac, and
    // (optionally) Fmax/Fmin are NOT included here yet. They are not
    // needed for Phase 3's "can guidance construct a valid command"
    // contract, but Phase 4's control-law implementation will need them
    // (see Issue E in the Phase 3 fixes round-2 prompt). Extend this
    // projection when Phase 4 lands.
    engines: (b.engines || []).map(e => ({
      id: e.id,
      angleDeg: e.angleDeg,
      x: e.x,
      isCenter: e.isCenter,
      gimbal: e.gimbal,
      Ve: e.Ve,
      maxMassFlowRate: e.maxMassFlowRate,
      massFlowRate: e.massFlowRate,
      currentF: e.currentF,
      gimbalDeg: e.gimbalDeg,
      targetGimbalRateDegS: e.targetGimbalRateDegS,
    })),
    rcsCmd: b.rcsCmd || null,
    rcsDuty: b.rcsDuty || null,
    // Phase 3 Extension (Plan A1) — every pod of every member, flat list.
    // See rcs.js's buildPodEntries(). Purely additive to the snapshot;
    // does not change anything about how RCS is actually fired yet.
    pods: (typeof buildPodEntries === 'function') ? buildPodEntries(b) : [],
  }));
  GuidanceBridge.send({
    type: 'snapshot',
    data: {
      simTime: state.simTime,
      activeBodyIndex: state.activeBodyIndex,
      // Issue A (round 2) — was missing entirely. Without this, guidance
      // has no signal that the physics tick loop has frozen (crash halt)
      // and would keep computing/sending commands into a worker that's
      // no longer advancing.
      halted: !!state.halted,
      bodies,
    },
  });
}

// ---- One-time handoff: give physics and guidance the two ends of a single
// MessageChannel so guidance can post commands straight to physics without
// main thread relaying every one (see physics_worker.js's 'connectGuidance'
// and guidance.worker.js's 'connectPhysicsPort' handlers). Called once both
// workers have signalled ready — see main.js.
function connectGuidanceToPhysics() {
  const channel = new MessageChannel();
  WorkerBridge.send({ type: 'connectGuidance' }, [channel.port1]);
  GuidanceBridge.send({ type: 'connectPhysicsPort' }, [channel.port2]);
}
