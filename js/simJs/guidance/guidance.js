// ============================================================================
// guidance.js — Phase 3 scaffold. Runs inside guidance.worker.js, imported
// AFTER imu.js (so measure()/setEnabled() below are already global in this
// worker's scope — importScripts shares one global, not modules).
//
// PHASE 3: no control law. This file's job in this phase is the
// INTERFACE — receiving snapshots, applying (or not) IMU error, and giving
// Phase 4 a single place (Guidance.tick) to drop a real algorithm into,
// plus a full set of command-builder helpers so that drop-in doesn't also
// have to invent the wire format.
//
// Isolation note: this file must never reference `state`, `CONFIG`,
// `getComponentType`, or anything else from the physics side. It can't —
// none of those scripts are in this worker's importScripts list (see
// guidance.worker.js) — so a stray reference here throws a ReferenceError
// immediately rather than silently reaching into physics. That's the
// enforcement mechanism the spec asks for; nothing in this file "helps"
// enforce it, the worker boundary does.
// ============================================================================

const Guidance = (function () {
  let _physicsSend = null; // (msg) => void, wired by guidance.worker.js once the physics MessagePort connects
  let _lastRawSnapshot = null; // most recent snapshot exactly as received (pre-IMU)
  let _lastMeasuredSnapshot = null; // what tick()/the future control law actually sees
  
  function init(physicsSendFn) {
    _physicsSend = physicsSendFn;
  }
  
  // ---- IMU wiring. setEnabled()/measure() are globals from imu.js. ----
  function setImuEnabled(enabled) {
    setEnabled(enabled); // imu.js global
  }
  
  // Called by guidance.worker.js on every 'snapshot' message from main
  // thread. Applies (or, per imu.js's own identity contract, doesn't
  // apply) IMU error, stores both copies, and hands off to tick().
  function onSnapshot(rawSnapshot) {
    _lastRawSnapshot = rawSnapshot;
    _lastMeasuredSnapshot = measure(rawSnapshot); // imu.js global; identity when disabled
    tick(_lastMeasuredSnapshot);
  }
  
  // PHASE 4 HOOK. Called once per snapshot with the (possibly IMU-errored)
  // state. Empty in Phase 3 — no control law yet. A real implementation
  // reads `snapshot.bodies[snapshot.activeBodyIndex]` and calls the
  // send() helpers below; it should NOT reach for _lastRawSnapshot (that
  // would defeat the entire point of routing through IMU).
  function tick(snapshot) {
    // no-op — Phase 4
  }
  
  // ---- Outbound: send a command to the physics worker. ----
  function send(msg) {
    if (!_physicsSend) {
      console.warn('[guidance] send() called before physics port connected:', msg);
      return;
    }
    _physicsSend(msg);
  }
  
  // ---- Command builders — one per message type in the interface
  // contract (IMU_PROMPT_md.txt, "Command messages"). These only shape
  // the message; clamping/validation is the physics worker's job (same
  // as for human UI commands — guidance is not a trusted client, it goes
  // through the identical clamp path clampMassFlowCommand() etc. use).
  // Every one of these is usable directly from this worker's devtools
  // console for manual testing, e.g.:
  //   Guidance.send(Guidance.cmdSetAllThrottle(Infinity))
  // ----
  
  // A. Existing messages, reused verbatim.
  function cmdSetGroupThrottle(angles, kgPerSec) { return { type: 'setGroupThrottle', angles, value: kgPerSec }; }
  function cmdSetCenterThrottle(kgPerSec) { return { type: 'setCenterThrottle', value: kgPerSec }; }
  function cmdSetAllThrottle(kgPerSec) { return { type: 'setAllThrottle', value: kgPerSec }; }
  function cmdRcs(key, on) { return { type: 'rcs', key, on: !!on }; }
  function cmdLegs(deployed) { return { type: 'legs', deployed: !!deployed }; }
  function cmdSeparate() { return { type: 'separate' }; }
  function cmdSplitFairing() { return { type: 'splitFairing' }; }
  function cmdReleasePayload() { return { type: 'releasePayload' }; }
  function cmdEmergencyEject() { return { type: 'emergencyEject' }; }
  function cmdTakeControl(idx) { return { type: 'takeControl', idx }; }
  function cmdWarp(value) { return { type: 'warp', value }; } // available but discouraged, see spec "Out of scope"
  function cmdSetFuelMass(value) { return { type: 'setFuelMass', value }; } // allowed but discouraged (pad-only, enforced worker-side)
  
  // B. New in Phase 3 — rate-not-angle gimbal, per-nozzle RCS duty.
  function cmdSetGimbalRate(degPerSec) { return { type: 'setGimbalRate', degPerSec }; }
  // duties: { TL:{lat,up,dn}, TR:{...}, BL:{...}, BR:{...} }, any subset of
  // nozzles/pods. Issue C (round 2): passes `duties` through AS-IS — this
  // is deliberate, not an oversight. Call cmdRcsDuty(null) (or with no
  // argument) to relinquish RCS duty control back to the boolean rcsCmd
  // path; physics_worker.js's 'rcsDuty' handler treats a null/undefined
  // duties payload as "release", not "hold at all-zero". Sending
  // cmdRcsDuty({}) or all-zero nozzle objects is NOT the same thing — that
  // still latches duty control, just at zero force.
  function cmdRcsDuty(duties) { return { type: 'rcsDuty', duties }; }
  
  return {
    init,
    setImuEnabled,
    onSnapshot,
    tick, // exposed so Phase 4 can override/replace this single function
    send,
    cmdSetGroupThrottle,
    cmdSetCenterThrottle,
    cmdSetAllThrottle,
    cmdRcs,
    cmdLegs,
    cmdSeparate,
    cmdSplitFairing,
    cmdReleasePayload,
    cmdEmergencyEject,
    cmdTakeControl,
    cmdWarp,
    cmdSetFuelMass,
    cmdSetGimbalRate,
    cmdRcsDuty,
    // exposed for debugging/inspection from the worker's devtools console
    get lastRawSnapshot() { return _lastRawSnapshot; },
    get lastMeasuredSnapshot() { return _lastMeasuredSnapshot; },
  };
})();
