// ============================================================================
// main.js — App bootstrap: wires every module together and runs the
// fixed-timestep animation loop.
// ============================================================================

const MERGE_COLORS = ['#ff8855', '#55ddff', '#aa88ff', '#88ff99', '#ffdd55', '#ff66cc', '#66ffcc'];

// PHASE 3 — IMU noise toggle. Off by default (matches imu.js's own
// `_enabled = false` default) — a plain state var since this only matters
// to the main<->guidance-worker relationship, unlike showGrid/sloshEnabled
// etc. which render.js also needs (see that file for why those live there
// instead of here).
let imuEnabled = false;
// ---------------------------------------------------------------------------
// Active stack — resolved once per page-load (the sim's CONFIG, ENGINES, and
// stack don't change mid-session; user must reload after changing the stack).
// Used by render.js, physics.js, massProps.js.
// ---------------------------------------------------------------------------
const SIM_STACK_MEMBERS = (typeof getActiveStackMembers === 'function') ?
  getActiveStackMembers() : [];


function groupColorOf(groupName) {
  const gi = mergeState.groups.findIndex(g => g.name === groupName);
  return MERGE_COLORS[gi % MERGE_COLORS.length];
}

function renderMergeDiagram() {
  const svg = document.getElementById('mergeSvg');
  const cx = 90,
    cy = 90,
    R = 65;
  let html = `<circle cx="${cx}" cy="${cy}" r="${R+14}" fill="none" stroke="#22344a" stroke-width="1"/>`;
  
  // Outer-ring dots: purely angle-driven (mergeState.groups comes from the
  // active layout's mergeTopology, per vehicle.js), so this already works
  // for any ring size/spacing with no changes.
  mergeState.groups.forEach((g) => {
    const color = groupColorOf(g.name);
    g.angles.forEach(a => {
      const rad = a * Math.PI / 180;
      const ex = cx + Math.cos(rad) * R;
      const ey = cy - Math.sin(rad) * R;
      const isSelected = selectedForMerge.includes(g.name);
      html += `<circle cx="${ex}" cy="${ey}" r="9" fill="${color}" stroke="${isSelected ? '#fff' : '#111'}" stroke-width="${isSelected?3:1}" class="engine-dot" data-angle="${a}" style="cursor:pointer;"/>`;
    });
  });
  
  // Center marker(s): drawn from whichever slot(s) the active layout marks
  // role:'center' — not assumed to exist or to be exactly one. A layout
  // with zero center-role slots (hypothetically, an all-outer ring) simply
  // draws no center marker; today's octaweb-merlin9 has exactly one ('C').
  const centerSlots = (CONFIG.ENGINE_LAYOUT ? CONFIG.ENGINE_LAYOUT.frame.slots : []).filter(s => s.role === 'center');
  if (centerSlots.length) {
    const label = centerSlots.length === 1 ? centerSlots[0].id : String(centerSlots.length);
    html += `<circle cx="${cx}" cy="${cy}" r="11" fill="#ffcc00" stroke="#222" stroke-width="1.5"/>`;
    html += `<text x="${cx}" y="${cy+3}" font-size="8" text-anchor="middle" fill="#222">${label}</text>`;
  }
  
  svg.innerHTML = html;
  svg.querySelectorAll('.engine-dot').forEach(dot => {
    dot.addEventListener('click', () => handleEngineDotClick(parseInt(dot.dataset.angle)));
  });
  
  // Group legend + count
  const legend = document.getElementById('mergeLegend');
  legend.innerHTML = mergeState.groups.map((g) =>
    `<div class="legend-row"><span class="legend-dot" style="background:${groupColorOf(g.name)}"></span>${g.name} (${g.angles.length} engines)</div>`
  ).join('');
}

// ---------------------------------------------------------------------------
// Peripheral engine sliders — one per outer-role slot the ACTIVE engine
// layout declares, split into a left rack and a right rack, regardless of
// merge state. When two or more engines share a merge group, their sliders
// are visually tagged with the group's color and moving any one of them
// drives the whole group (and updates every sibling slider to match),
// instead of collapsing them into a single slider. This keeps the control
// layout stable while merges only change *behavior*, not layout.
//
// PHASE 2: no longer a hardcoded 4+4 angle list. Left/right is derived from
// each slot's actual lateral (x) position at the active layout's radius —
// positive x -> right rack, negative x -> left rack. The two slots that sit
// exactly on the front/back axis (x==0, e.g. 90°/270° on an 8-ring) have no
// lateral side at all, so they're assigned by which half of the circle
// they're in (front half -> right, back half -> left) purely so every
// engine still gets a slider — this reproduces the octaweb-merlin9 4+4
// split exactly, and degrades gracefully to any other outer-engine count.
// ---------------------------------------------------------------------------
function sideOfOuterSlot(slot) {
  const x = slot.position(CONFIG.OCTA_RADIUS).x;
  const EPS = 1e-6;
  if (x > EPS) return 'right';
  if (x < -EPS) return 'left';
  return slot.angleDeg < 180 ? 'right' : 'left';
}

function outerSlotsBySide() {
  const layout = CONFIG.ENGINE_LAYOUT;
  const right = [],
    left = [];
  if (layout) {
    layout.frame.slots.filter(s => s.role === 'outer').forEach(s => {
      (sideOfOuterSlot(s) === 'right' ? right : left).push(s);
    });
  }
  right.sort((a, b) => a.angleDeg - b.angleDeg);
  left.sort((a, b) => a.angleDeg - b.angleDeg);
  return { right, left };
}

function renderOctaSliders() {
  const leftHost = document.getElementById('slidersLeft');
  const rightHost = document.getElementById('slidersRight');
  leftHost.innerHTML = '';
  rightHost.innerHTML = '';
  
  function buildSlider(angle, host) {
    const engine = getEngine(angle);
    const group = angleGroupOf(angle);
    const color = groupColorOf(group.name);
    // PHASE 1: engine state is mass flow rate (kg/s); the slider still
    // shows percent of this engine's own max flow.
    const maxFlow = engine.maxMassFlowRate || 1;
    const flow = (engine.targetMassFlowRate !== undefined ? engine.targetMassFlowRate : engine.massFlowRate) || 0;
    const startVal = Math.round((flow / maxFlow) * 100);
    
    const wrap = document.createElement('div');
    wrap.className = 'vslider-wrap';
    wrap.dataset.angle = angle;
    wrap.innerHTML = `
      <div class="vslider-label" style="color:${color}">${angle}&deg;</div>
      <input type="range" min="0" max="100" value="${startVal}" class="vslider" data-angle="${angle}" style="accent-color:${color}">
      <div class="vslider-value" id="val-eng-${angle}" style="color:${color}">${startVal}%</div>
    `;
    host.appendChild(wrap);
    wrap.querySelector('input').addEventListener('input', (e) => {
      applySliderToGroup(angle, parseFloat(e.target.value));
    });
  }
  
  const { right, left } = outerSlotsBySide();
  right.forEach(s => buildSlider(s.angleDeg, rightHost));
  left.forEach(s => buildSlider(s.angleDeg, leftHost));
}

// Moving ANY slider in a merged group drives the whole group and keeps every
// sibling slider's handle + readout in sync with it.
function applySliderToGroup(sourceAngle, rawValue) {
  const group = angleGroupOf(sourceAngle);
  const v = rawValue / 100;
  setGroupThrottle(group, v);
  group.angles.forEach(a => {
    const input = document.querySelector(`.vslider[data-angle="${a}"]`);
    const label = document.getElementById('val-eng-' + a);
    if (input) input.value = rawValue;
    if (label) label.textContent = Math.round(rawValue) + '%';
  });
}

function bindMergeControls() {
  document.getElementById('mergeModeSymmetric').addEventListener('click', () => {
    mergeState.mode = 'symmetric';
    document.getElementById('mergeModeSymmetric').classList.add('active');
    document.getElementById('mergeModeAsymmetric').classList.remove('active');
  });
  document.getElementById('mergeModeAsymmetric').addEventListener('click', () => {
    mergeState.mode = 'asymmetric';
    document.getElementById('mergeModeAsymmetric').classList.add('active');
    document.getElementById('mergeModeSymmetric').classList.remove('active');
  });
  document.getElementById('btnResetMerges').addEventListener('click', () => {
    resetMerges();
    selectedForMerge = [];
    renderMergeDiagram();
    renderOctaSliders();
  });
}

function bindCenterControls() {
  const thrustSlider = document.getElementById('centerThrustSlider');
  thrustSlider.addEventListener('input', (e) => {
    setCenterThrottle(parseFloat(e.target.value) / 100);
    document.getElementById('centerThrustValue').textContent = e.target.value + '%';
  });
  
  bindHoldControl(document.getElementById('gimbalCW'), (v) => {
    setCenterGimbalTarget(v * CONFIG.GIMBAL_MAX_DEG);
  }, { max: 1, rate: 1.2 });
  
  bindHoldControl(document.getElementById('gimbalACW'), (v) => {
    setCenterGimbalTarget(-v * CONFIG.GIMBAL_MAX_DEG);
  }, { max: 1, rate: 1.2 });
}

function bindRCSControls() {
  const map = {
    rcsN: 'N',
    rcsS: 'S',
    rcsE: 'E',
    rcsW: 'W',
    rcsNE: 'NE',
    rcsNW: 'NW',
    rcsSE: 'SE',
    rcsSW: 'SW',
    rcsCW: 'CW',
    rcsACW: 'ACW',
  };
  Object.entries(map).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) bindRCSButton(el, key);
  });
}

function bindMiscToggles() {
  const bind = (id, event, handler) => {
    const el = document.getElementById(id);
    if (!el) { console.warn('bindMiscToggles: no #' + id); return; }
    el.addEventListener(event, handler);
  };
  
  bind('toggleGrid', 'change', (e) => { showGrid = e.target.checked; });
  bind('toggleVectors', 'change', (e) => { showVectors = e.target.checked; });
  bind('toggleTrajectory', 'change', (e) => {
    showTrajectory = e.target.checked;
    WorkerBridge.send({ type: 'setTrajectoryEnabled', enabled: showTrajectory });
  });
  bind('toggleSlosh', 'change', (e) => {
    sloshEnabled = e.target.checked;
    WorkerBridge.send({ type: 'setSloshEnabled', enabled: sloshEnabled });
  });
  bind('toggleImu', 'change', (e) => {
    imuEnabled = e.target.checked;
    GuidanceBridge.send({ type: 'setImuEnabled', enabled: imuEnabled });
  });
  bind('toggleEarthFixed', 'change', (e) => {
    trajectoryMode = e.target.checked ? 'earthFixed' : 'inertial';
  });
  bind('toggleAtmosphere', 'change', (e) => {
    atmosphereEnabled = e.target.checked;
    WorkerBridge.send({ type: 'setAtmosphere', enabled: e.target.checked });
  });
  
  bind('btnSidePanel', 'click', () => togglePanel('sidePanel'));
  bind('btnWindPanel', 'click', () => togglePanel('windPanel'));
  bind('btnGraphPanel', 'click', () => togglePanel('graphPanel'));
  bind('btnMergePanel', 'click', () => togglePanel('mergePanel'));
  bind('btnGlossary', 'click', () => togglePanel('glossaryPanel'));
  
  const ltToggle = document.getElementById('leftToolbarToggle');
  const lt = document.getElementById('leftToolbar');
  if (ltToggle && lt) {
    ltToggle.addEventListener('click', () => {
      lt.classList.toggle('open');
      ltToggle.textContent = lt.classList.contains('open') ? '‹' : '›';
    });
  }
  
  document.querySelectorAll('.panel-close').forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => togglePanel(btn.dataset.target));
  });
}

// ---------------------------------------------------------------------------
// Fixed-timestep animation loop
// ---------------------------------------------------------------------------
let accumulator = 0;
let lastFrameTime = null;

function frame(ts) {
  if (lastFrameTime === null) lastFrameTime = ts;
  let frameDt = (ts - lastFrameTime) / 1000;
  lastFrameTime = ts;
  frameDt = Math.min(frameDt, 0.1);
  
  // Agar worker ne abhi state nahi bheji, render skip karo.
  if (!state.bodies || !state.bodies.length) {
    requestAnimationFrame(frame);
    return;
  }
  
  // ... baaki poora frame code ...
  
  
  
  
  drawFigurePanel();
  drawBasalView();
  drawGraphs();
  
  // Redraw the wind compass only when its panel is visible.
  const wp = document.getElementById('windPanel');
  if (wp && wp.style.display === 'block') drawWindCompass();
  
  updateTelemetry();
  updateStatusBar();
  updateFuelAvailability();
  
  // ---- Legs button — driven by the CURRENTLY-FOLLOWED body ----
// Show it only if the followed body actually declares deployable legs
// in its recovery type. Hides the button entirely when following a
// fairing half, a payload, or any body with hasRecovery:false — those
// have no leg hardware, so "Deploy Legs" would be a lie.
const legsBtn = getEl('btnLegs');
if (legsBtn) {
  const followIdx = (typeof _cameraTargetIndex === 'function')
    ? _cameraTargetIndex()
    : state.activeBodyIndex;
  const followBody = state.bodies[followIdx];
  const bottomMember = (followBody && followBody.members && followBody.members[0])
    ? followBody.members[0] : null;

  const recovery = (bottomMember && bottomMember.hasRecovery !== false
      && typeof getComponentType === 'function')
    ? getComponentType(bottomMember.recoveryTypeId)
    : null;
  const hasLegs = !!(recovery && recovery.capabilities && recovery.capabilities.deploysOnVehicle);

  if (!hasLegs) {
    // No legs on this body — hide the entire toolbar group (button + sep).
    const group = legsBtn.closest('.tb-group');
    if (group) group.style.display = 'none';
    else legsBtn.style.display = 'none';
  } else {
    const group = legsBtn.closest('.tb-group');
    if (group) group.style.display = '';
    else legsBtn.style.display = '';

    // Same safety gate as before, so it goes gray when deploy is illegal.
    const safety = legDeploySafety();
    const blocked = !legs.deployed && !safety.ok;
    legsBtn.disabled = blocked;
    legsBtn.title = blocked
      ? (safety.ascending ? 'Cannot deploy while ascending' : 'Cannot deploy — speed too high')
      : (legs.deployed ? 'Stow landing legs' : 'Deploy landing legs');
  }
}
  
  const sepBtn = getEl('btnSeparate');
  if (sepBtn) sepBtn.disabled = !canSeparateNow();
  
  const fairBtn = getEl('btnSplitFairing');
  if (fairBtn) fairBtn.disabled = !canSplitFairingNow();
  
  const plBtn = getEl('btnReleasePayload');
  if (plBtn) plBtn.disabled = !canReleasePayloadNow();
  
      const ejectBtn = getEl('btnEjectPayload');
  if (ejectBtn) {
    const active = state.bodies[state.activeBodyIndex];
    // Emergency eject ONLY makes sense while the fairing is still on —
    // its whole rationale is "save the SHIELDED payload". Once the fairing
    // has been split (or was never fitted), the payload is already exposed
    // and normal Release Payload is the correct command. Also disabled on
    // an emergency-ejected body itself: it IS the shielded unit, there's
    // nothing left to eject.
    const isEmergencyUnit = !!(active && active.emergencyEject);
    const hasFairing = !!(active && active.members &&
      active.members.some(m => m && m.stageRole === 'payloadSpace'));
    const canEject = !!(active && active.payloadId && !active.payloadReleased &&
      !active.crashed && hasFairing && !isEmergencyUnit);
    ejectBtn.disabled = !canEject;
    ejectBtn.title = canEject ?
      'Emergency eject — splits fairing and deploys cargo at high velocity' :
      (isEmergencyUnit ?
        'Already ejected as a shielded unit' :
        (active && active.payloadReleased ?
          'Payload already ejected' :
          (active && !hasFairing ?
            'No fairing to eject with — use Release Payload instead' :
            'No payload to eject')));
  }

  const tcBtn = getEl('btnTakeControl');
  if (tcBtn) tcBtn.disabled = !canTakeControlNow();
  
  requestAnimationFrame(frame);
}


function bootstrap() {
  // Worker ko pehle spawn karo aur hydrate karo.
  WorkerBridge.init();
  hydrateWorkerFromLocalStorage();
  
  // Worker ke pehle state snapshot aane ka wait karo, tab tak kuch
  // render mat karo — kyunki state.bodies khaali hoga aur ENGINES proxy
  // crash karega.
  WorkerBridge.onReady(() => {
    // ---- Spawn render worker ----
    const mainCanvas = document.getElementById('simCanvas');
    const offscreen = mainCanvas.transferControlToOffscreen();
    const initW = Math.max(1, mainCanvas.clientWidth || window.innerWidth);
    const initH = Math.max(1, mainCanvas.clientHeight || window.innerHeight);
    const renderWorker = new Worker('js/simJs/threads/render.worker.js');
    window._renderWorker = renderWorker;
    
    renderWorker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'workerError') {
        console.error('=== RENDER WORKER CRASH ===');
        console.error('  message:', msg.message);
        console.error('  stack:', msg.stack);
      } else if (msg.type === 'returnRenderHotBuffer') {
        // Optimization #1, Step 4: render worker handing back the hot-state
        // buffer we sent it, so workerBridge.js can reuse it next tick.
        if (typeof returnRenderHotBuffer === 'function') returnRenderHotBuffer(msg.buffer);
      }
      
    };
    // Sync worker's trajectory-enabled flag with the main thread's default.
    WorkerBridge.send({ type: 'setTrajectoryEnabled', enabled: showTrajectory });
    // Phase 2A: same sync for the slosh toggle's default.
    WorkerBridge.send({ type: 'setSloshEnabled', enabled: sloshEnabled });
    
    // ---- PHASE 3: spawn the guidance worker ----
    // Independent of the render-worker setup above/below — guidance boots
    // on its own schedule (see GuidanceBridge in workerBridge.js). Once
    // IT signals ready, hand both workers their MessageChannel port (see
    // connectGuidanceToPhysics) and sync the IMU toggle's default. Safe to
    // do this from inside WorkerBridge.onReady: physics is already up by
    // construction of being in this callback, so by the time GuidanceBridge
    // itself becomes ready, both sides genuinely exist.
    GuidanceBridge.init();
GuidanceBridge.onReady(() => {
  connectGuidanceToPhysics();
  GuidanceBridge.send({ type: 'setImuEnabled', enabled: imuEnabled });
  sendStackDataToGuidance();
});
    
    // hydrate FIRST — this is what triggers importScripts inside the worker.
    const hydrateKeys = {};
    [
      'rocketSim.fleet.v1', 'rocketSim.selectedId.v1',
      'rocketSim.stacks.v1', 'rocketSim.selectedStackId.v1',
      'rocketSim.families.v1', 'rocketSim.selectedFamilyId.v1',
      'rocketSim.componentLibrary.v1', 'rocketSim.payloads.v1',
      'rocketSim.payloadSplitDone.v1',
    ].forEach(k => { hydrateKeys[k] = localStorage.getItem(k); });
    renderWorker.postMessage({ type: 'hydrate', keys: hydrateKeys });
    
    // Send camera FIRST so it's already set when the init tick fires.
    renderWorker.postMessage({ type: 'camera', camera: { ...camera } });
    renderWorker.postMessage({
      type: 'toggles',
      showGrid,
      showVectors,
      showTrajectory,
      trajectoryMode,
      sloshEnabled,
    });
    
    renderWorker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        width: initW,
        height: initH,
      },
      [offscreen]
    );
    
    // Resize relay
    let _resizeDebounce = null;
window.addEventListener('resize', () => {
  if (_resizeDebounce) clearTimeout(_resizeDebounce);
  _resizeDebounce = setTimeout(() => {
    // Re-measure every time — initW/initH were captured once at
    // bootstrap and never update, so window resizes were sending the
    // original dimensions. The render worker only ever saw the initial
    // viewport size, and the backing canvas never matched the real
    // layout after any subsequent resize.
    const w = mainCanvas.clientWidth;
    const h = mainCanvas.clientHeight;
    if (!w || !h || w < 10 || h < 10) return;
    renderWorker.postMessage({ type: 'resize', width: w, height: h });
  }, 150);
});
    
    // Camera + toggle relay
    // OPTIMIZATION #6: this used to post BOTH 'camera' and 'toggles'
    // messages to the render worker on every single requestAnimationFrame
    // (~60/s) regardless of whether anything in them had actually changed.
    // Camera fields (follow/zoom/followBodyIndex/mode) only change on
    // discrete user input — button clicks, dropdown picks — never inside
    // an animation loop (confirmed: no rAF-driven zoom/follow interpolation
    // anywhere in controls.js/render.js), and the same is true of the 4
    // toggle checkboxes. So ~120 postMessage calls/sec were firing for
    // nothing. Now each message is only sent when at least one of its own
    // fields actually differs from what was last sent — plain primitive
    // comparisons, no allocation added. The render worker already treats
    // "no message this tick" as "nothing changed" (same pattern as
    // state.trajectory's null-means-unchanged contract), so skipping a send
    // when nothing moved is exactly correct, not just an approximation.
    let _lastSentCamera = {
      follow: camera.follow, zoom: camera.zoom,
      followBodyIndex: camera.followBodyIndex, mode: camera.mode,
    };
    let _lastSentToggles = { showGrid, showVectors, showTrajectory, trajectoryMode, sloshEnabled };

    const pushRenderContext = () => {
      if (camera.follow !== _lastSentCamera.follow ||
        camera.zoom !== _lastSentCamera.zoom ||
        camera.followBodyIndex !== _lastSentCamera.followBodyIndex ||
        camera.mode !== _lastSentCamera.mode) {
        renderWorker.postMessage({ type: 'camera', camera: { ...camera } });
        _lastSentCamera.follow = camera.follow;
        _lastSentCamera.zoom = camera.zoom;
        _lastSentCamera.followBodyIndex = camera.followBodyIndex;
        _lastSentCamera.mode = camera.mode;
      }

      if (showGrid !== _lastSentToggles.showGrid ||
        showVectors !== _lastSentToggles.showVectors ||
        showTrajectory !== _lastSentToggles.showTrajectory ||
        trajectoryMode !== _lastSentToggles.trajectoryMode ||
        sloshEnabled !== _lastSentToggles.sloshEnabled) {
        renderWorker.postMessage({
          type: 'toggles',
          showGrid,
          showVectors,
          showTrajectory,
          trajectoryMode,
          sloshEnabled,
        });
        _lastSentToggles.showGrid = showGrid;
        _lastSentToggles.showVectors = showVectors;
        _lastSentToggles.showTrajectory = showTrajectory;
        _lastSentToggles.trajectoryMode = trajectoryMode;
        _lastSentToggles.sloshEnabled = sloshEnabled;
      }

      requestAnimationFrame(pushRenderContext);
    };
    pushRenderContext();
    // ... baaki bootstrap content waisa hi
    initFigureCanvas();
    initBasalCanvas();
    initWindCompass();
    
    // Hide legs button if the active stack has no leg-deploy recovery.
    
    
    bindSimControls();
    bindLegsControl();
    bindCenterControls();
    bindRCSControls();
    bindMergeControls();
    bindCameraControls();
    refreshFollowBodySelect();
    bindWindPanel();
    bindQuickThrottle();
    bindFuelPanel();
    bindMiscToggles();
    
    buildGlossaryPanel();
    renderMergeDiagram();
    renderOctaSliders();
    updateStatusBar();
    
    requestAnimationFrame(frame);
  });
}

window.addEventListener('DOMContentLoaded', bootstrap);