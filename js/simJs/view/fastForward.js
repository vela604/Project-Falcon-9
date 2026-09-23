// ============================================================================
// fastForward.js — main-thread fast-forward for the simulation page.
//
// Runs the sim forward on the MAIN THREAD with a matching guidance pass,
// without touching the physics worker. Steps:
//
//   1. Pause the physics worker, ask it for a full clone of its state.
//   2. Swap the main-thread `state` over to that clone.
//   3. Load guidance into main-thread scope and init with a local
//      dispatch that mutates `state` directly (no worker round-trip).
//   4. Run N = durationS / DT physics+guidance ticks with chunked yields
//      so the UI can update the progress bar.
//   5. On completion, show Revert / Continue buttons.
//        Revert   — do nothing to the worker; resume.
//        Continue — send replaceState to the worker; resume.
//
// Guidance modules (imu.js, derivation.js, guidercs.js, guidance.js) are
// loaded on the main thread via simulation.html script tags, purely for
// this feature. The guidance worker keeps its own separate copy.
// ============================================================================

const FastForward = (function () {
  'use strict';

  let _state = {
    open: false,
    running: false,
    // Set true from the moment Forward is pressed until Revert/Continue
    // closes the modal. While true, workerBridge.applyStateSnapshot()
    // skips incoming worker snapshots — the main thread owns `state`
    // for the duration of the FF run and the modal's user-choice wait.
    // Without this, the worker's paused-but-still-streaming snapshots
    // clobber state.bodies mid-loop, and FF mutations vanish.
    holdingState: false,
    cancel: false,
    durationS: 60,
    startSimTime: 0,
    savedBodies: null,
    savedSimTime: 0,
    savedActiveIdx: 0,
    savedHalted: false,
    ffBodies: null,
    ffSimTime: 0,
    ffActiveIdx: 0,
    ffHalted: false,
      onFullStateCb: null,
    guidanceActive: false,
    pendingRun: false,
  // Set true after the panel transitions to loading and the worker
  // has been told to resume. Cleared the moment the FIRST fresh worker
  // snapshot arrives (via onSnapshotApplied) — that's the signal the
  // teleport has fully loaded, and only then does the modal close.
  waitingForResume: false,
  // Set when openDialog() pauses the worker, so closeDialog() only
  // resumes if WE were the ones who paused. Never auto-resume a sim
  // that was already paused before the dialog opened.
  pausedByDialog: false,
    // Promise resolvers for the two state-capture round-trips.
    _pendingPhysicsState: null,
    _pendingGuidanceState: null,
    // True only if WE auto-opened the graph panel at FF start. On FF
    // close we close it back IF this flag is set — if the user had it
    // open before FF, leave it open.
    graphAutoOpened: false,
  };
  
  


  // ---------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function openDialog() {
  if (_state.open || _state.running) return;
  _state.open = true;
  _state.graphAutoOpened = false;
  showSection('input');
  $('ffDurationInput').value = '60';
  $('ffModal').style.display = 'block';
  
  // Apply the FF visual layering the moment the dialog opens — dim +
  // blur backdrop at z 9990, telemetry / panelDock raised above it
  // via body.ff-active CSS, dialog at z 9999. Panels stay crisp and
  // live-updating for the entire FF session, dialog or not.
  document.body.classList.add('ff-active');
  // Pause the sim while the dialog is up so the rocket doesn't keep
  // moving behind the modal. Only resume on close if WE paused it —
  // simPaused is the main-thread mirror of the worker's paused flag.
  if (typeof simPaused !== 'undefined' && !simPaused) {
    _state.pausedByDialog = true;
    WorkerBridge.send({ type: 'pauseSim' });
    simPaused = true;
    if (typeof updateStatusBar === 'function') updateStatusBar();
  } else {
    _state.pausedByDialog = false;
  }
}

  function closeDialog() {
  _state.open = false;
  $('ffModal').style.display = 'none';
  
  // Restore the visual layering — drop the FF-active class and hide
  // the backdrop so panels return to their normal stacking.
  document.body.classList.remove('ff-active');  
  // Close the graph panel back IF we auto-opened it. If the user had
  // it open before FF, leave it be.
  if (_state.graphAutoOpened) {
    _state.graphAutoOpened = false;
    const graphPanel = document.getElementById('graphPanel');
    if (graphPanel && graphPanel.style.display === 'block' &&
      typeof togglePanel === 'function') {
      togglePanel('graphPanel');
    }
  }
  
  // If we paused the sim when the dialog opened AND we're not mid-
  // teleport (waitingForResume handles that path itself), resume it.
  if (_state.pausedByDialog) {
    _state.pausedByDialog = false;
    WorkerBridge.send({ type: 'resumeSim' });
    if (typeof simPaused !== 'undefined') simPaused = false;
    if (typeof updateStatusBar === 'function') updateStatusBar();
  }
}

  function showSection(name) {
    ['input', 'progress', 'complete', 'loading'].forEach(s => {
      const el = $('ff' + s.charAt(0).toUpperCase() + s.slice(1) + 'Section');
      if (el) el.style.display = (s === name) ? '' : 'none';
    });
  }

  function setProgress(elapsedS, totalS) {
  const pct = Math.min(100, (elapsedS / totalS) * 100);
  $('ffProgressText').textContent =
    `Forwarding… ${elapsedS.toFixed(1)} / ${totalS.toFixed(1)}s`;
  $('ffProgressFill').style.width = pct.toFixed(1) + '%';
  // Live sim time readout in the dialog. The top bar's mission clock
  // also updates (frame() calls updateStatusBar at rAF rate), but
  // duplicating it here keeps the FF dialog self-explanatory.
  const t = state.simTime;
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = (t % 60).toFixed(1).padStart(4, '0');
  const el = $('ffSimTime');
  if (el) el.textContent = `T+${mm}:${ss}`;
}

  // ---------------------------------------------------------------------
  // Guidance local dispatch — mirrors tester's localDispatch. During FF,
  // guidance's send() routes here instead of to the physics worker.
  // ---------------------------------------------------------------------
  function clampFlowFF(en, cmd) {
    if (!(cmd > 0)) return 0;
    const capped = Math.min(cmd, en.maxMassFlowRate || 0);
    return Math.max(capped, en.minMassFlowRate || 0);
  }

  function localDispatch(msg) {
    const b = _state.ffBodies && _state.ffBodies[_state.ffActiveIdx];
    if (!b) return;
    switch (msg.type) {
      case 'setGimbalRate': {
        if (!b.engines) break;
        const lim = CONFIG.GIMBAL_RATE_DEG_S;
        const rate = Math.max(-lim, Math.min(lim, msg.degPerSec));
        b.engines.filter(e => e.gimbal).forEach(e => { e.targetGimbalRateDegS = rate; });
        break;
      }
      case 'setGimbal': {
        if (!b.engines) break;
        const lim = CONFIG.GIMBAL_MAX_DEG;
        const d = Math.max(-lim, Math.min(lim, msg.deg));
        b.engines.filter(e => e.gimbal).forEach(e => {
          e.targetGimbalDeg = d;
          e.targetGimbalRateDegS = NaN;
        });
        break;
      }
      case 'setAllThrottle': {
        if (!b.engines) break;
        b.engines.forEach(e => { e.targetMassFlowRate = clampFlowFF(e, msg.value); });
        break;
      }
      case 'setCenterThrottle': {
        if (!b.engines) break;
        b.engines.filter(e => e.isCenter).forEach(e => {
          e.targetMassFlowRate = clampFlowFF(e, msg.value);
        });
        break;
      }
      case 'rcsDuty': {
        if (msg.duties == null) b.rcsDuty = null;
        else b.rcsDuty = msg.duties;
        break;
      }
      case 'separate': {
        if (typeof requestSeparate === 'function') requestSeparate(b);
        break;
      }
      case 'splitFairing': {
        if (typeof splitFairingOnActiveBody === 'function') splitFairingOnActiveBody(b);
        break;
      }
      case 'releasePayload': {
        if (typeof requestReleasePayload === 'function') requestReleasePayload(msg, b);
        break;
      }
      case 'emergencyEject': {
        if (typeof emergencyEjectPayload === 'function') emergencyEjectPayload(b);
        break;
      }
      case 'takeControl': {
        if (typeof takeControlOfBody === 'function') takeControlOfBody(msg.idx);
        break;
      }
      case 'legs': {
        if (!b.legs) b.legs = { deployed: false, progress: 0 };
        b.legs.deployed = !!msg.deployed;
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------------
  // Build a snapshot for guidance, matching workerBridge.js's shape.
  // ---------------------------------------------------------------------
  function buildFFSnapshot() {
    const bodies = _state.ffBodies.map((b, i) => ({
      rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy, theta: b.theta, omega: b.omega,
      ax: b._lastAccelX || 0, ay: b._lastAccelY || 0,
      height: b.height, width: b.width, dryMass: b.dryMass, fuelMass: b.fuelMass,
      memberFuel: Array.isArray(b.memberFuel) ? b.memberFuel.slice() : [],
      crashed: !!b.crashed, landed: !!b.landed,
      isActive: i === _state.ffActiveIdx,
      isDiscarded: !!b.isDiscarded, settled: !!b.settled,
      emergencyEject: !!b.emergencyEject,
      payloadId: b.payloadId || null, payloadReleased: !!b.payloadReleased,
      members: b.members || [],
      legs: b.legs ? { deployed: !!b.legs.deployed, progress: b.legs.progress || 0 } : null,
      slosh: b.slosh ? { offset: b.slosh.offset || 0, velocity: b.slosh.velocity || 0 } : null,
      engines: (b.engines || []).map(e => ({
        id: e.id, angleDeg: e.angleDeg, x: e.x,
        isCenter: e.isCenter, gimbal: e.gimbal, Ve: e.Ve,
        maxMassFlowRate: e.maxMassFlowRate,
        massFlowRate: e.massFlowRate, currentF: e.currentF,
        gimbalDeg: e.gimbalDeg,
        targetGimbalRateDegS: e.targetGimbalRateDegS,
      })),
      rcsCmd: b.rcsCmd || null,
      rcsDuty: b.rcsDuty || null,
      pods: (typeof buildPodEntries === 'function') ? buildPodEntries(b) : [],
    }));
    const w = (typeof wind !== 'undefined' && wind) ? wind : null;
    return {
      simTime: _state.ffSimTime,
      activeBodyIndex: _state.ffActiveIdx,
      halted: _state.ffHalted,
      wind: { enabled: w ? !!w.enabled : false, speed: w ? (w.speed || 0) : 0, directionDeg: w ? (w.directionDeg || 0) : 0 },
      bodies,
    };
  }

  function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // ---------------------------------------------------------------------
  // Core FF loop.
  // ---------------------------------------------------------------------
  // Promise-based wrappers around the two capture round-trips.
function requestPhysicsState() {
  return new Promise(resolve => {
    _state._pendingPhysicsState = resolve;
    WorkerBridge.send({ type: 'captureFullState' });
  });
}
function requestGuidanceState() {
  return new Promise(resolve => {
    _state._pendingGuidanceState = resolve;
    GuidanceBridge.send({ type: 'captureGuidanceState' });
  });
}

// Called by workerBridge.js when the physics worker returns the clone.
function onFullState(data) {
  const r = _state._pendingPhysicsState;
  _state._pendingPhysicsState = null;
  if (r) r(data);
}
// Called by workerBridge.js when the guidance worker returns its state.
function onGuidanceState(data) {
  const r = _state._pendingGuidanceState;
  _state._pendingGuidanceState = null;
  if (r) r(data);
}

async function runForward(durationS) {
    _state.running = true;
    _state.holdingState = true; // block worker snapshots from now on
    _state.cancel = false;
    _state.durationS = durationS;
    showSection('progress');
    setProgress(0, durationS);
    
    // (Blur + backdrop are already applied by openDialog; nothing to do
// here for layering. Graph auto-open is separate — only fires when
// we actually start forwarding.)

// Auto-open the graph panel so the altitude / velocity / thrust / Q
// / slosh curves are visible during fast-forward. Remember whether
// we opened it, so closeDialog can restore the user's original
// layout if it was closed.
const graphPanel = document.getElementById('graphPanel');
if (graphPanel && graphPanel.style.display !== 'block') {
  if (typeof togglePanel === 'function') togglePanel('graphPanel');
  _state.graphAutoOpened = true;
} else {
  _state.graphAutoOpened = false;
}

  // ---- 1. Save current state (for Revert) ----
  _state.savedBodies = state.bodies;
  _state.savedSimTime = state.simTime;
  _state.savedActiveIdx = state.activeBodyIndex;
  _state.savedHalted = state.halted;

  // ---- 2. Pause the physics worker ----
  WorkerBridge.send({ type: 'pauseSim' });

  // ---- 3. Ask both workers for a full state clone ----
  let physData = null, guideData = null;
  try {
    [physData, guideData] = await Promise.all([
      requestPhysicsState(),
      requestGuidanceState(),
    ]);
  } catch (e) {
    console.error('[fastForward] capture failed', e);
    _state.running = false;
    _state.holdingState = false;
    showSection('input');
    return;
  }
  if (!physData || !Array.isArray(physData.bodies)) {
    console.error('[fastForward] physics state capture failed');
    _state.running = false;
    _state.holdingState = false;
    showSection('input');
    return;
  }

  // ---- 4. Swap main-thread state to the full clone ----
  _state.ffBodies = physData.bodies;
  _state.ffSimTime = physData.simTime;
  _state.ffActiveIdx = physData.activeBodyIndex;
  _state.ffHalted = !!physData.halted;
  _state.startSimTime = physData.simTime;

  state.bodies = _state.ffBodies;
  state.simTime = _state.ffSimTime;
  state.activeBodyIndex = _state.ffActiveIdx;
  state.halted = _state.ffHalted;

  // ---- 5. Init main-thread guidance + IMPORT the worker's state ----
  // No startGuide() call — that would run the guide's .start() hooks
  // and reset every phase/timer back to ASCENT. Instead we set the
  // active guide directly and load its saved phase state, so the
  // main-thread guide picks up from the exact tick the worker was on.
  _state.guidanceActive = false;
  try {
    if (typeof Guidance !== 'undefined'
        && typeof _collectStackDataForGuidance === 'function'
        && guideData && guideData.activeGuide) {
      Derivation.setStackData(_collectStackDataForGuidance());
      Guidance.init(localDispatch);
      Guidance.importGuideState(guideData);
      _state.guidanceActive = true;
    }
  } catch (e) {
    console.warn('[fastForward] guidance init failed — running physics only', e);
  }

  // ---- 6. Kick off the loop ----
  ffLoop();
}

  async function ffLoop() {
    const dt = CONFIG.DT;
    const maxTicks = Math.ceil(_state.durationS / dt);
    const CHUNK = 200;
    const t0 = performance.now();

    for (let i = 0; i < maxTicks; i++) {
      if (_state.cancel) break;

      // Build snapshot + step guidance BEFORE physicsStep, same order as
      // the sim worker pipeline (guidance reads pre-integration state).
      if (_state.guidanceActive && typeof Guidance !== 'undefined') {
        try { Guidance.onSnapshot(buildFFSnapshot()); }
        catch (e) { console.warn('[fastForward] guidance tick failed', e); _state.guidanceActive = false; }
      }

      try { physicsStep(dt); }
      catch (e) { console.error('[fastForward] physicsStep threw', e); break; }

      // Sync our FF refs from the (mutated-in-place) global state.
      _state.ffSimTime = state.simTime;
      _state.ffActiveIdx = state.activeBodyIndex;
      _state.ffHalted = !!state.halted;

      if (i % CHUNK === 0) {
        setProgress(state.simTime - _state.startSimTime, _state.durationS);
        await yieldToBrowser();
      }

      if (state.halted) break;
    }

    // Ensure the progress bar reaches 100 at the end.
    setProgress(_state.durationS, _state.durationS);

  // DO NOT call Guidance.stopGuide() here. Its .stop() hook sends
  // throttle-off / gimbal-0 / rcsDuty-null commands through
  // localDispatch, which mutate the FF bodies BEFORE onContinue
  // exports them — the engine ends up cut at the exact moment of
  // the teleport, and the mission silently tumbles from there.
  // Main-thread guidance is left dormant (no more onSnapshot calls),
  // which is fine: the next FF run re-imports and overwrites it.
  _state.running = false;
  showSection('complete');
  }

  // ---------------------------------------------------------------------
  // Actions after FF completes.
  // ---------------------------------------------------------------------
async function onRevert() {
  showSection('loading');
  await new Promise(r => setTimeout(r, 2000));
  
  // Restore main-thread state to the pre-FF snapshot.
  state.bodies = _state.savedBodies;
  state.simTime = _state.savedSimTime;
  state.activeBodyIndex = _state.savedActiveIdx;
  state.halted = _state.savedHalted;
  
  // Clear holding BEFORE resuming so the next worker snapshot lands.
  _state.holdingState = false;
  
  // Panel stays open showing "Simulation loading…" until the first
  // fresh snapshot arrives — see onSnapshotApplied(). That's what
  // makes the transition lag-free: the panel is the visual cover
  // while the worker replays its state, and it hides itself the
  // instant the state is actually back.
  _state.waitingForResume = true;
  WorkerBridge.send({ type: 'resumeSim' });
}

async function onContinue() {
    showSection('loading');
    await new Promise(r => setTimeout(r, 2000));
    
    // Export guidance state FIRST, before anything else can touch the
    // FF bodies. localDispatch writes through to state.bodies, so any
    // command we accidentally fire between here and the exports would
    // end up in the worker's copy.
    let exportedGuidance = null;
    try {
      if (_state.guidanceActive &&
        typeof Guidance !== 'undefined' &&
        Guidance.exportGuideState) {
        exportedGuidance = Guidance.exportGuideState();
      }
    } catch (e) {
      console.warn('[fastForward] guidance state export failed', e);
    }
    
    // Hand the final FF physics state to the physics worker.
    WorkerBridge.send({
      type: 'replaceState',
      bodies: state.bodies,
      simTime: state.simTime,
      activeBodyIndex: state.activeBodyIndex,
      halted: state.halted,
    });
    
    // Hand the final FF guidance state back to the guidance worker.
    // Both workers are idle — holdingState has blocked all snapshot
    // flow — so there's no race with a mid-flight tick. Messages are
    // processed in order, so by the time resumeSim fires on physics,
    // guidance worker has already loaded the state and is waiting for
    // the first snapshot.
    if (exportedGuidance) {
      GuidanceBridge.send({ type: 'replaceGuidanceState', data: exportedGuidance });
    }
    
  // Force the render worker's next snapshot to include a full body
  // clone. Without this, `prevCount === newCount` (both have the FF
  // result's 4 bodies) makes the bridge send hot-buffer-only, and the
  // render worker keeps its stale pre-FF body objects — canvas draws
  // the full stack while telemetry correctly shows 4 separate bodies.
  if (typeof forceRenderResync === 'function') forceRenderResync();
  
  // Clear holding BEFORE resuming — the worker's next snapshot will
  // carry the freshly-replaced bodies, and from that tick on the
  // standard mirror takes over again.
  _state.holdingState = false;
  
  // Same wait-for-fresh-snapshot trick as Revert — the panel hides
  // only after the worker has actually caught up.
  _state.waitingForResume = true;
  WorkerBridge.send({ type: 'resumeSim' });
  }

// Called by workerBridge.js immediately after applyStateSnapshot()
// finishes a full, non-held tick. If we're waiting for the teleport
// to settle, hide the modal here — this is the "state has actually
// loaded" signal.
function onSnapshotApplied() {
  if (!_state.waitingForResume) return;
  _state.waitingForResume = false;
  closeDialog();
}

  // ---------------------------------------------------------------------
  // Wiring.
  // ---------------------------------------------------------------------
  function bind() {
    const btn = document.getElementById('btnFastForward');
    if (btn) btn.addEventListener('click', openDialog);

    const cancelBtn = document.getElementById('ffCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);

      const forwardBtn = document.getElementById('ffForwardBtn');
  if (forwardBtn) forwardBtn.addEventListener('click', () => {
    const dur = parseFloat(document.getElementById('ffDurationInput').value);
    if (!Number.isFinite(dur) || dur <= 0) return;
    runForward(dur);
  });
  
  // "Continue from here" — visible during the FF progress phase. Click
  // sets the interrupt flag; the loop breaks at the next chunk
  // boundary and transitions to the complete section, where the
  // "Forward →" button then teleports to whatever state was reached.
  const continueBtn = document.getElementById('ffContinueBtn');
  if (continueBtn) continueBtn.addEventListener('click', () => {
    _state.cancel = true;
  });
  
  const revertBtn = document.getElementById('ffRevertBtn');
  if (revertBtn) revertBtn.addEventListener('click', onRevert);
  
  const applyBtn = document.getElementById('ffApplyBtn');
  if (applyBtn) applyBtn.addEventListener('click', onContinue);
  }

  return {
  bind,
  onFullState,
  onGuidanceState,
  onSnapshotApplied,
  isHoldingState: () => _state.holdingState,
};
})();