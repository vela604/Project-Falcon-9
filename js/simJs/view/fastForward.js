// ============================================================================
// fastForward.js — main-thread controller for the FF worker.
//
// Previously FF ran physics+guidance on the main thread. That worked but
// blocked rendering and left the FF loop fighting for CPU with panels.
// Now it's a fully separate worker (fastforward.worker.js) that loads
// the same physics+guidance stack, runs the batch, and returns the final
// state. Main thread only:
//   1. captures pre-FF state from both workers,
//   2. spawns the FF worker with that state,
//   3. displays progress from FF worker postMessages,
//   4. on complete, hands the FF result to the physics+guidance workers.
// ============================================================================

const FastForward = (function () {
  'use strict';

    let _state = {
    open: false,
    running: false,
    holdingState: false,
    cancel: false,
    durationS: 60,
    pendingResult: null,
    ffWorker: null,
    waitingForResume: false,
    pausedByDialog: false,
    graphAutoOpened: false,
    _pendingPhysicsState: null,
    _pendingGuidanceState: null,
    _pendingAck: null,
    _pendingPauseCapture: null,
  };

  const $ = (id) => document.getElementById(id);

  function openDialog() {
    if (_state.open || _state.running) return;
    _state.open = true;
    _state.graphAutoOpened = false;
    showSection('input');
    $('ffDurationInput').value = '60';
    $('ffModal').style.display = 'block';
    document.body.classList.add('ff-active');
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
    document.body.classList.remove('ff-active');
    if (_state.graphAutoOpened) {
      _state.graphAutoOpened = false;
      const gp = document.getElementById('graphPanel');
      if (gp && gp.style.display === 'block' && typeof togglePanel === 'function') {
        togglePanel('graphPanel');
      }
    }
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

  function setProgress(elapsedS, totalS, simTime) {
    const pct = Math.min(100, (elapsedS / totalS) * 100);
    $('ffProgressText').textContent = `Forwarding… ${elapsedS.toFixed(1)} / ${totalS.toFixed(1)}s`;
    $('ffProgressFill').style.width = pct.toFixed(1) + '%';
    if (Number.isFinite(simTime)) {
      const mm = Math.floor(simTime / 60).toString().padStart(2, '0');
      const ss = (simTime % 60).toFixed(1).padStart(4, '0');
      const el = $('ffSimTime');
      if (el) el.textContent = `T+${mm}:${ss}`;
    }
  }


  function requestGuidanceState() {
    return new Promise(resolve => {
      _state._pendingGuidanceState = resolve;
      GuidanceBridge.send({ type: 'captureGuidanceState' });
    });
  }

  function onFullState(data) {
    const r = _state._pendingPhysicsState;
    _state._pendingPhysicsState = null;
    if (r) r(data);
  }
  
  function onPausedState(data) {
  const r = _state._pendingPauseCapture;
  _state._pendingPauseCapture = null;
  if (r) r(data);
}
  
  function onGuidanceState(data) {
    const r = _state._pendingGuidanceState;
    _state._pendingGuidanceState = null;
    if (r) r(data);
  }

  function buildStorageKeys() {
    const keys = {};
    ['rocketSim.fleet.v1','rocketSim.selectedId.v1',
     'rocketSim.stacks.v1','rocketSim.selectedStackId.v1',
     'rocketSim.families.v1','rocketSim.selectedFamilyId.v1',
     'rocketSim.componentLibrary.v1','rocketSim.payloads.v1',
     'rocketSim.payloadSplitDone.v1'].forEach(k => { keys[k] = localStorage.getItem(k); });
    return keys;
  }

  async function runForward(durationS) {
    _state.running = true;
    _state.holdingState = true;
    _state.cancel = false;
    _state.durationS = durationS;
    _state.pendingResult = null;
    showSection('progress');
    setProgress(0, durationS, NaN);

    document.body.classList.add('ff-active');
    const graphPanel = document.getElementById('graphPanel');
    if (graphPanel && graphPanel.style.display !== 'block') {
      if (typeof togglePanel === 'function') togglePanel('graphPanel');
      _state.graphAutoOpened = true;
    } else {
      _state.graphAutoOpened = false;
    }

    // Atomic pause + capture. Physics worker sets paused=true AND clones
// its state in the same message handler, so the captured state is
// exactly "last tick before pause" — no wall-clock race, no extra
// steps draining while we wait. Fixes the non-determinism where
// identical constants produced different FF results across attempts.
WorkerBridge.send({ type: 'pauseAndCapture' });
const physDataPromise = new Promise(r => { _state._pendingPauseCapture = r; });
const guideDataPromise = requestGuidanceState();

let physData = null, guideData = null;
try {
  physData = await physDataPromise;
  guideData = await guideDataPromise;
} catch (e) {
  console.error('[fastForward] state capture failed', e);
  _state.running = false;
  _state.holdingState = false;
  showSection('input');
  return;
}
    if (!physData || !Array.isArray(physData.bodies)) {
      console.error('[fastForward] invalid physics state');
      _state.running = false;
      _state.holdingState = false;
      showSection('input');
      return;
    }

    const stackData = (typeof _collectStackDataForGuidance === 'function') ?
  _collectStackDataForGuidance() : null;
const guideSel = document.getElementById('guideSelect');
const activeGuide = guideSel ? guideSel.value : null;

// Environment state — physics worker receives these as separate
// setWind / setAtmosphere / setSloshEnabled messages; the FF worker
// does not, so without passing them here it would run with defaults
// (wind off, atmosphere on, slosh on, IMU off) regardless of what
// the user actually set. That mismatch is what causes FF to drift
// from normal play.
const envState = {
  wind: {
    enabled: !!(typeof wind !== 'undefined' && wind.enabled),
    speed: (typeof wind !== 'undefined' && Number.isFinite(wind.speed)) ? wind.speed : 0,
    directionDeg: (typeof wind !== 'undefined' && Number.isFinite(wind.directionDeg)) ? wind.directionDeg : 0,
  },
  atmosphereEnabled: !!(typeof atmosphereEnabled !== 'undefined' && atmosphereEnabled),
  sloshEnabled: !!(typeof sloshEnabled !== 'undefined' && sloshEnabled),
  imuEnabled: !!(typeof imuEnabled !== 'undefined' && imuEnabled),
};

const w = new Worker('js/simJs/threads/fastforward.worker.js');
    _state.ffWorker = w;
    const _baseSimTime = physData.simTime;

            w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'diagCapture') {
  const el = document.getElementById('status');
  if (el) el.textContent = 'CAPTURE: ' + m.sig;
  return;
}
            if (m.type === 'progress') {
        setProgress(m.simTime - _baseSimTime, durationS, m.simTime);
        // Update main-thread state so the recorder (and any other reader)
        // sees the fresh simTime + bodies every 1 sim-second, not every 10.
        if (m.bodies && Array.isArray(m.bodies)) {
          const _prevLen = state.bodies ? state.bodies.length : 0;
          state.bodies = m.bodies;
          state.simTime = m.simTime;
          state.activeBodyIndex = m.activeBodyIndex || 0;
          state.halted = !!m.halted;
          if (m.bodies.length !== _prevLen &&
            typeof refreshFollowBodySelect === 'function') {
            refreshFollowBodySelect();
          }
        } else {
          state.simTime = m.simTime;
        }
      } else if (m.type === 'guideStatus') {
  // Live phase-log update from the FF worker. Forward straight to
  // onGuidanceStatus so the mission-phase panel updates during FF
  // instead of freezing and jumping at the end.
  if (typeof onGuidanceStatus === 'function' && m.status) {
    try { onGuidanceStatus(m.status); } catch (e) { console.error('[ff] onGuidanceStatus', e); }
  }
} else if (m.type === 'progressBodies') {
  // Full body update for panels.
  if (m.bodies && Array.isArray(m.bodies)) {
    const _prevLen = state.bodies ? state.bodies.length : 0;
    state.bodies = m.bodies;
    state.simTime = m.simTime;
    state.activeBodyIndex = m.activeBodyIndex || 0;
    state.halted = !!m.halted;
    // Refresh the follow-body dropdown when body count changed
    // mid-FF (separation, fairing split, payload release). FF
    // bypasses workerBridge's snapshot path, so its own
    // count-change heuristic never fires during the run.
    if (m.bodies.length !== _prevLen &&
      typeof refreshFollowBodySelect === 'function') {
      refreshFollowBodySelect();
    }
  }
} else if (m.type === 'done') {
  _state.pendingResult = m;
  _state.running = false;
  // TEMP: auto-download per-tick dump on FF completion
  if (m.tickDumpJson) {
    const blob = new Blob([m.tickDumpJson], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ff-dump.json';
    a.click();
    console.log('[FF] auto-downloaded ff-dump.json (' + (blob.size/1024/1024).toFixed(1) + ' MB)');
  }
  try { w.terminate(); } catch (e) {}
  _state.ffWorker = null;
  
  // Apply the FINAL FF state to main-thread state so the
  // "complete" screen's telemetry matches the actual final tick.
  // Without this, state.bodies is still whatever the last
  // progressBodies message carried — up to bodiesEveryTicks
  // (10 sim-sec) behind — and the telemetry visibly jumps forward
  // the moment Forward is clicked. Display-only: holdingState is
  // still true, so any in-flight physics snapshots are dropped,
  // and on Continue this state is what replaceState already
  // delivers, so nothing double-applies.
  if (m.fullState && Array.isArray(m.fullState.bodies)) {
    const _prevLen = state.bodies ? state.bodies.length : 0;
    state.bodies = m.fullState.bodies;
    state.simTime = m.fullState.simTime;
    state.activeBodyIndex = m.fullState.activeBodyIndex || 0;
    state.halted = !!m.fullState.halted;
    if (m.fullState.bodies.length !== _prevLen &&
      typeof refreshFollowBodySelect === 'function') {
      refreshFollowBodySelect();
    }
  }
  
  // Ensure the bar shows 100% even if the last progress message
  // landed a bit short.
  setProgress(m.fullState.simTime - _baseSimTime, durationS, m.fullState.simTime);
  showSection('complete');
} else if (m.type === 'workerError') {
        console.error('[ff worker]', m.message, m.stack);
        try { w.terminate(); } catch (e) {}
        _state.ffWorker = null;
        _state.running = false;
        _state.holdingState = false;
        showSection('input');
      }
    };

        w.postMessage({
      type: 'run',
      storageKeys: buildStorageKeys(),
      fullState: {
        bodies: physData.bodies,
        activeBodyIndex: physData.activeBodyIndex,
        simTime: physData.simTime,
        halted: !!physData.halted,
      },
      guidanceState: guideData,
      stackData: stackData,
      activeGuide: activeGuide,
      envState: envState,
      durationS: durationS,
      progressEveryTicks: 80, // simTime-only ping, every 1 sim-sec
      bodiesEveryTicks: 80, // FULL body snapshot, every 1 sim-sec
    });
  }

  function onCancel() {
    if (_state.ffWorker) {
      _state.ffWorker.postMessage({ type: 'abort' });
    }
    _state.cancel = true;
  }

  async function onRevert() {
    showSection('loading');
    await new Promise(r => setTimeout(r, 2000));

    if (_state.ffWorker) {
      try { _state.ffWorker.terminate(); } catch (e) {}
      _state.ffWorker = null;
    }
    _state.pendingResult = null;

    _state.holdingState = false;
    _state.waitingForResume = true;
    WorkerBridge.send({ type: 'resumeSim' });
  }

  async function onContinue() {
  if (!_state.pendingResult) {
    console.warn('[fastForward] no pending result');
    return onRevert();
  }
  showSection('loading');
  await new Promise(r => setTimeout(r, 2000));
  
  const result = _state.pendingResult;
  _state.pendingResult = null;
  
  // Set up the ack-promise BEFORE sending replaceState, so the ack
  // can't arrive and be dropped before we're listening.
  const ackPromise = new Promise(r => { _state._pendingAck = r; });
  
  WorkerBridge.send({
    type: 'replaceState',
    bodies: result.fullState.bodies,
    simTime: result.fullState.simTime,
    activeBodyIndex: result.fullState.activeBodyIndex,
    halted: result.fullState.halted,
  });
  
  if (result.guidanceState && typeof GuidanceBridge !== 'undefined') {
    GuidanceBridge.send({ type: 'replaceGuidanceState', data: result.guidanceState });
  }
  
  if (typeof forceRenderResync === 'function') forceRenderResync();
  
  // Wait for physics to acknowledge replaceState BEFORE setting
  // holdingState = false. This guarantees:
  //   - Any snapshots already queued in main's message queue (from
  //     before physics processed replaceState) are dropped while
  //     holdingState is still true — no stale pre-FF state leaks
  //     through to guidance.
  //   - The first snapshot after the ack reflects the FF state (it
  //     was sent after physics's replaceState handler ran).
  //
  // Without this, holdingState went false immediately and physics's
  // next (still pre-replaceState) snapshot was applied + forwarded
  // to guidance — one stale tick that corrupted _prevVr2, lastApogeeKm,
  // and phase timers in the guide's state, causing phase-machine
  // misbehaviour on the next real snapshot.
  //
  // 2 s timeout so a lost ack can't hang the dialog forever.
  await Promise.race([
    ackPromise,
    new Promise(r => setTimeout(r, 2000)),
  ]);
  _state._pendingAck = null;
  
  _state.holdingState = false;
  _state.waitingForResume = true;
  WorkerBridge.send({ type: 'resumeSim' });
}

function onReplaceStateAck() {
  const r = _state._pendingAck;
  _state._pendingAck = null;
  if (r) r();
}

  function onSnapshotApplied() {
  if (!_state.waitingForResume) return;
  _state.waitingForResume = false;
  closeDialog();
  // Force dropdown rebuild after FF. Physics's next snapshot may carry
  // the same body count as pre-FF (5 → 5), so workerBridge's count-
  // change heuristic won't trigger and the dropdown stays stale
  // (only "Active"). Rebuild from the current state.bodies instead.
  if (typeof refreshFollowBodySelect === 'function') {
    refreshFollowBodySelect();
  }
}

  function bind() {
    const btn = document.getElementById('btnFastForward');
    if (btn) btn.addEventListener('click', openDialog);

    const cancelBtn = document.getElementById('ffCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      if (_state.running) return onCancel();
      closeDialog();
    });

    const forwardBtn = document.getElementById('ffForwardBtn');
    if (forwardBtn) forwardBtn.addEventListener('click', () => {
      const dur = parseFloat(document.getElementById('ffDurationInput').value);
      if (!Number.isFinite(dur) || dur <= 0) return;
      runForward(dur);
    });

    const continueBtn = document.getElementById('ffContinueBtn');
    if (continueBtn) continueBtn.addEventListener('click', () => {
      if (!_state.running) return;
      if (_state.ffWorker) _state.ffWorker.postMessage({ type: 'abort' });
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
  onPausedState,
  onSnapshotApplied,
  onReplaceStateAck,
  isHoldingState: () => _state.holdingState,
};
})();