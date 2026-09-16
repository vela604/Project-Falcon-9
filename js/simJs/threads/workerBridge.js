// ============================================================================
// workerBridge.js — main thread side of the physics worker.
// Owns the worker handle, sends commands, and maintains a read-only
// `state` mirror that rendering code reads from as if nothing changed.
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
        q.forEach(m => this.worker.postMessage(m));
        
        this.readyCallbacks.forEach(cb => { try { cb(); } catch (err) { console.error(err); } });
        this.readyCallbacks = [];
      }
    };
    this.worker.onerror = (err) => console.error('Physics worker error:', err);
  },
  
  // Normal send — queued until worker signals ready.
  send(msg) {
    if (!this.worker) return;
    if (!this.ready) {
      this.pendingMessages.push(msg);
      return;
    }
    this.worker.postMessage(msg);
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
  
  // Rebuild the follow-body dropdown whenever the body list changes
  // (separation, fairing split, payload release). Skipping when count
  // matches avoids running this 60×/s — the actual DOM rebuild only
  // happens on real changes.
  const newCount = state.bodies.length;
  if (newCount !== prevCount &&
    typeof refreshFollowBodySelect === 'function' &&
    document.getElementById('followBodySelect')) {
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
    window._renderWorker.postMessage(
      {
        type: 'state',
        data: {
          activeBodyIndex: snap.activeBodyIndex,
          simTime: snap.simTime,
          halted: snap.halted,
          trajectory: fwdTraj,
          lastForces: snap.lastForces,
          separationFlash: snap.separationFlash,
          lastPayloadRelease: snap.lastPayloadRelease, // ← add karo
          bodies: snap.bodies,
        },
      },
      transfers
    );
  }
}

// ---- Boot: send initial hydrate from main-thread localStorage ----
function hydrateWorkerFromLocalStorage() {
  const keys = {};
  _WORKER_HYDRATE_KEYS.forEach(k => { keys[k] = localStorage.getItem(k); });
  WorkerBridge.sendImmediate({ type: 'hydrate', keys });
}