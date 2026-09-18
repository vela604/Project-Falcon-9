// ============================================================================
// guidance.worker.js — Phase 3: guidance's own thread.
//
// Deliberately minimal import graph — this is the actual enforcement of
// "guidance cannot see physics internals", not a convention. See the
// importScripts list below: config.js, fleet.js, componentLibrary.js,
// physics.js, stateBuffer.js are never listed, so getComponentType()/
// CONFIG/state simply don't exist in this scope. A future guidance.js
// that accidentally references any of them throws a ReferenceError on the
// very first tick, immediately and loudly, rather than silently working
// because someone left an import in "just in case".
// ============================================================================

self.addEventListener('error', (e) => {
  self.postMessage({
    type: 'workerError',
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    stack: e.error && e.error.stack,
  });
});

self.addEventListener('unhandledrejection', (e) => {
  self.postMessage({
    type: 'workerError',
    message: 'Unhandled rejection: ' + (e.reason && e.reason.message || e.reason),
    stack: e.reason && e.reason.stack,
  });
});

let bootstrapped = false;

// The physics MessagePort — set once, when main thread transfers it (see
// 'connectPhysicsPort' below). Guidance.send() calls post straight down
// this port to the physics worker's dispatchCommand(); main thread is not
// in that path at all once this is wired.
let physicsPort = null;

self.onmessage = (e) => {
  const msg = e.data;
  
  // ---- Boot: hydrate + importScripts, same pattern as the other three
  // workers (physics/render/trajectory), for consistency — even though
  // guidance genuinely needs none of the localStorage-sourced keys those
  // other workers hydrate with. Keeping the same handshake shape means
  // main thread's worker-boot code doesn't need a special case for this
  // one worker. ----
  if (msg.type === 'hydrate' && !bootstrapped) {
    try {
      // Deliberately minimal — see file header. workerShims.js is the
      // localStorage stub (unused by imu.js/guidance.js today, but kept
      // for parity with physics/render workers and in case Phase 4 needs
      // it); imu.js and guidance.js are the only real content.
      importScripts(
        'workerShims.js',
        '../guidance/imu.js',
        '../guidance/guidance.js'
      );
      bootstrapped = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'bootError', message: String(err), stack: err && err.stack });
    }
    return;
  }
  
  if (!bootstrapped) return; // ignore anything before hydration
  
  switch (msg.type) {
    // Main thread hands over one end of a MessageChannel whose other end
    // it already gave to the physics worker (see workerBridge.js). From
    // this point on, Guidance.send() reaches physics directly — main
    // thread does not mediate guidance's outbound commands, only inbound
    // snapshots/toggle (see spec's message-flow diagram).
    case 'connectPhysicsPort': {
      physicsPort = e.ports && e.ports[0];
      if (physicsPort && typeof Guidance !== 'undefined') {
        Guidance.init((cmd) => physicsPort.postMessage(cmd));
      }
      break;
    }
    
    // Forwarded copy of the physics snapshot (structured clone — mutating
    // it affects only this worker's copy, physics is untouched by
    // construction). measure()'s identity-vs-noise branch happens inside
    // Guidance.onSnapshot -> imu.js's global measure().
    case 'snapshot': {
      if (typeof Guidance !== 'undefined') Guidance.onSnapshot(msg.data);
      break;
    }
    
    // The only message main thread sends besides snapshots — the IMU
    // toggle. Physics worker and render worker never see this at all.
    case 'setImuEnabled': {
      if (typeof Guidance !== 'undefined') Guidance.setImuEnabled(!!msg.enabled);
      break;
    }
  }
};
