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
    pendingResult: null,    // { fullState, guidanceState }
    ffWorker: null,
    waitingForResume: false,
    pausedByDialog: false,
    graphAutoOpened: false,
    _pendingPhysicsState: null,
    _pendingGuidanceState: null,
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

  function onFullState(data) {
    const r = _state._pendingPhysicsState;
    _state._pendingPhysicsState = null;
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

    WorkerBridge.send({ type: 'pauseSim' });

// Wait for both workers to quiesce before capturing. Physics worker
// sends snapshots even while paused (same state repeatedly); those
// forwards trigger guidance ticks. 400 ms wall lets the queue drain
// and both workers settle on the same sim tick, so the pair we
// capture is matched. Without this, guidance state could be one
// tick behind physics, and the FF would start from a mismatched
// pair — different results across runs.
await new Promise(r => setTimeout(r, 400));

let physData = null, guideData = null;
try {
  physData = await requestPhysicsState();
  guideData = await requestGuidanceState();
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

    const stackData = (typeof _collectStackDataForGuidance === 'function')
      ? _collectStackDataForGuidance() : null;
    const guideSel = document.getElementById('guideSelect');
    const activeGuide = guideSel ? guideSel.value : null;

    const w = new Worker('js/simJs/threads/fastforward.worker.js');
    _state.ffWorker = w;
    const _baseSimTime = physData.simTime;

    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') {
  // Fast tick — simTime only.
  setProgress(m.simTime - _baseSimTime, durationS, m.simTime);
} else if (m.type === 'progressBodies') {
  // Full body update for panels.
  if (m.bodies && Array.isArray(m.bodies)) {
    state.bodies = m.bodies;
    state.simTime = m.simTime;
    state.activeBodyIndex = m.activeBodyIndex || 0;
    state.halted = !!m.halted;
  }
} else if (m.type === 'done') {
        _state.pendingResult = m;
        _state.running = false;
        try { w.terminate(); } catch (e) {}
        _state.ffWorker = null;
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
        durationS: durationS,
    // Two independent cadences, in ticks:
    //   progressEveryTicks — tiny simTime-only ping, drives the
    //                        progress bar + T+ clock smoothly
    //   bodiesEveryTicks   — full body list for panel updates,
    //                        heavier (structured clone), so slower
    progressEveryTicks: 80, // 1 sim-sec
    //bodiesEveryTicks: 800, // 10 sim-sec
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

    _state.holdingState = false;
    _state.waitingForResume = true;
    WorkerBridge.send({ type: 'resumeSim' });
  }

  function onSnapshotApplied() {
    if (!_state.waitingForResume) return;
    _state.waitingForResume = false;
    closeDialog();
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
    onSnapshotApplied,
    isHoldingState: () => _state.holdingState,
  };
})();