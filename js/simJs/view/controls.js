// ============================================================================
// controls.js — All user-input handling: main thrust slider, center gimbal
// CW/ACW buttons, 4x4 octaweb vertical sliders, RCS 8-direction + rotation
// buttons, wind panel, merge-diagram interactions, panel toggles.
// ============================================================================

let simRunning = false;
let simPaused = false;
let timeWarp = 1; // physics-time multiplier (1 = real time)
// ---------------------------------------------------------------------------
// Touch/mouse "hold to increase, release to snap back to 0" helper.
// ---------------------------------------------------------------------------
function bindHoldControl(el, onChange, opts = {}) {
  const rate = opts.rate || 1.5; // units/sec while held
  const max = opts.max !== undefined ? opts.max : 1;
  const min = opts.min !== undefined ? opts.min : 0;
  let holding = false;
  let value = min;
  let rafId = null;
  
  function loop(ts, lastTs) {
    if (!holding) return;
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    value = Math.min(max, value + rate * dt);
    onChange(value);
    rafId = requestAnimationFrame((t) => loop(t, ts));
  }
  
  function start(e) {
    e.preventDefault();
    holding = true;
    rafId = requestAnimationFrame((t) => loop(t, null));
  }
  
  function end(e) {
    holding = false;
    if (rafId) cancelAnimationFrame(rafId);
    value = min;
    onChange(value);
  }
  
  el.addEventListener('touchstart', start, { passive: false });
  el.addEventListener('mousedown', start);
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => el.addEventListener(ev, end));
}

// ---------------------------------------------------------------------------
// Peripheral (outer-ring) throttle groups — already generic: a group is
// just a list of engine angles (see vehicle.js's defaultPairGroups(), which
// derives them from the active engine layout's mergeTopology), so this
// works unchanged for any ring size.
// ---------------------------------------------------------------------------
// PHASE 1: `value` here is still the UI's 0..1 fraction (the user's mental
// model doesn't change) — converted to a commanded mass flow rate (kg/s)
// using a representative engine from the group before it crosses the
// worker boundary. Every engine in one group shares a thruster type (a
// merge group is always drawn from one side's peripheral ring), so any
// member's maxMassFlowRate is the right conversion factor for the whole
// group.
function setGroupThrottle(group, value) {
  const rep = getEngine(group.angles[0]);
  const maxFlow = rep ? (rep.maxMassFlowRate || 0) : 0;
  WorkerBridge.send({ type: 'setGroupThrottle', angles: group.angles, value: value * maxFlow });
}

// PHASE 2: primary-engine throttle. "Primary" = whatever the active engine
// layout marks role:'center' (today always exactly one — the octaweb's core
// engine — but this filters rather than assumes a single match, so a future
// layout with more than one center-role slot works without changes here).
// PHASE 1: same fraction-to-mass-flow conversion as setGroupThrottle above.
function setCenterThrottle(value) {
  const rep = ENGINES.find(e => e.isCenter);
  const maxFlow = rep ? (rep.maxMassFlowRate || 0) : 0;
  WorkerBridge.send({ type: 'setCenterThrottle', value: value * maxFlow });
}

// PHASE 2: shared gimbal target. Every gimbal-capable engine the active
// layout declares (ENGINES.filter(e => e.gimbal) — NOT just the center one)
// moves together off one commanded angle. This is only valid when the
// layout opts into a single shared slider via
// CONFIG.ENGINE_LAYOUT.capabilities.sharedGimbalSlider; a layout with
// independently-steerable gimbal engines (sharedGimbalSlider:false) would
// need its own per-engine gimbal UI, which doesn't exist yet — so that case
// fails loudly here instead of silently moving the wrong engines.
function setCenterGimbalTarget(deg) {
  const layout = CONFIG.ENGINE_LAYOUT;
  if (!layout || !layout.capabilities || !layout.capabilities.sharedGimbalSlider) {
    console.warn('setCenterGimbalTarget: no shared gimbal slider.');
    return;
  }
  WorkerBridge.send({ type: 'setGimbal', deg });
}

// ---------------------------------------------------------------------------
// RCS button bindings — each of the 8 directions + CW/ACW
// ---------------------------------------------------------------------------
function bindRCSButton(el, key) {
  function on(e) { e.preventDefault();
    WorkerBridge.send({ type: 'rcs', key, on: true });
    el.classList.add('active'); }
  
  function off() { WorkerBridge.send({ type: 'rcs', key, on: false });
    el.classList.remove('active'); }
  el.addEventListener('touchstart', on, { passive: false });
  el.addEventListener('mousedown', on);
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => el.addEventListener(ev, off));
}

// ---------------------------------------------------------------------------
// Merge circle diagram (SVG octagon + center)
// ---------------------------------------------------------------------------
let selectedForMerge = [];

function angleGroupOf(angle) {
  return mergeState.groups.find(g => g.angles.includes(angle));
}

function handleEngineDotClick(angle) {
  const group = angleGroupOf(angle);
  if (!group) return;
  const idx = selectedForMerge.indexOf(group.name);
  if (idx >= 0) { selectedForMerge.splice(idx, 1); }
  else {
    selectedForMerge.push(group.name);
    if (selectedForMerge.length === 2) {
      mergeGroups(selectedForMerge[0], selectedForMerge[1]);
      selectedForMerge = [];
      renderMergeDiagram();
      renderOctaSliders();
      return;
    }
  }
  renderMergeDiagram();
}

// ---------------------------------------------------------------------------
// Panel visibility + pause-on-open behavior
// ---------------------------------------------------------------------------
function togglePanel(id) {
  const el = document.getElementById(id);
  const opening = el.style.display === 'none' || el.style.display === '';
  el.style.display = opening ? 'block' : 'none';
  
  // Recompute desired pause state from the ACTUAL DOM — not from a chain of
  // increments. Any panel marked data-pause-sim="true" that is currently
  // visible means physics should be paused. Sending the resulting state
  // (rather than "toggle") keeps main-thread and worker in lock-step even
  // if a panel is closed some other way (programmatically, page reload).
  const anyOpen = Array.from(document.querySelectorAll('[data-pause-sim="true"]'))
    .some(p => p.style.display === 'block');
  const wantPaused = anyOpen;
  
  if (wantPaused !== simPaused) {
    simPaused = wantPaused;
    WorkerBridge.send({ type: wantPaused ? 'pauseSim' : 'resumeSim' });
    updateStatusBar();
  }
}

// ---------------------------------------------------------------------------
// Wind panel
// ---------------------------------------------------------------------------
function bindWindPanel() {
  const enabledCb = document.getElementById('windEnabled');
  const speedInp = document.getElementById('windSpeed');
  const dirInp = document.getElementById('windDir');
  
  if (!enabledCb || !speedInp || !dirInp) {
    console.warn('bindWindPanel: one or more wind controls missing', { enabledCb: !!enabledCb, speedInp: !!speedInp, dirInp: !!dirInp });
    return;
  }
  
  enabledCb.addEventListener('change', (e) => {
    wind.enabled = e.target.checked;
    WorkerBridge.send({ type: 'setWind', enabled: wind.enabled });
  });
  
  speedInp.addEventListener('input', (e) => {
  wind.speed = parseFloat(e.target.value) || 0;
  // Show both units — sim physics runs in m/s, but km/h is the
  // familiar "wind speed" number most people have an intuition for.
  // 1 m/s = 3.6 km/h.
  const kmh = wind.speed * 3.6;
  document.getElementById('windSpeedLabel').textContent =
    wind.speed.toFixed(0) + ' m/s (' + kmh.toFixed(0) + ' km/h)';
  WorkerBridge.send({ type: 'setWind', speed: wind.speed });
});
  
  dirInp.addEventListener('input', (e) => {
    wind.directionDeg = parseFloat(e.target.value) || 0;
    document.getElementById('windDirLabel').textContent = wind.directionDeg.toFixed(0) + '°';
    WorkerBridge.send({ type: 'setWind', directionDeg: wind.directionDeg });
  });
}

// ---------------------------------------------------------------------------
// Camera controls
// ---------------------------------------------------------------------------
const camera = { follow: true, zoom: 25, followBodyIndex: 0, mode: 'local' };

function bindCameraControls() {
  document.getElementById('btnFollow').addEventListener('click', () => {
    camera.mode = 'local';
    camera.follow = true;
    document.getElementById('btnFollow').classList.add('active');
    document.getElementById('btnFree').classList.remove('active');
  });
  
  document.getElementById('btnFree').addEventListener('click', () => {
    camera.mode = 'planet';
    document.getElementById('btnFree').classList.add('active');
    document.getElementById('btnFollow').classList.remove('active');
  });
  
  const sel = document.getElementById('followBodySelect');
  if (sel) {
    sel.addEventListener('change', (e) => {
      camera.followBodyIndex = parseInt(e.target.value, 10) || 0;
      camera.follow = true;
      camera.mode = 'local'; // picking a specific body implies local-follow
      document.getElementById('btnFollow').classList.add('active');
      document.getElementById('btnFree').classList.remove('active');
    });
  }
  
  document.getElementById('btnZoomIn').addEventListener('click', () => {
    if (camera.mode === 'planet') return;
    camera.zoom = Math.min(25, camera.zoom * 1.25);
  });
  document.getElementById('btnZoomOut').addEventListener('click', () => {
    if (camera.mode === 'planet') return;
    camera.zoom = Math.max(0.08, camera.zoom / 1.25);
  });
}

// H3a: repopulate the follow-body dropdown when the body list changes
// (separation adds a body). Called from main.js on separation.
function refreshFollowBodySelect() {
  const sel = document.getElementById('followBodySelect');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = state.bodies.map((b, i) => {
    let label;
    if (b.isActive) label = 'Active';
    else if (b.payloadBody && b.payloadBody.record) label = 'Payload: ' + b.payloadBody.record.name;
    else if (b.fairingHalf && b.fairingHalf.record) label = 'Fairing ' + (b.fairingHalf.side > 0 ? 'R' : 'L');
    else if (b.members && b.members.length && b.members[0].name) label = b.members[0].name;
    else label = 'Body ' + i;
    return `<option value="${i}">${label}</option>`;
  }).join('');
  if (sel.querySelector(`option[value="${current}"]`)) sel.value = current;
  else sel.value = state.activeBodyIndex;
}

function bindLegsControl() {
  const btn = document.getElementById('btnLegs');
  if (!btn || btn.closest('.tb-group')?.style.display === 'none') return;
  btn.addEventListener('click', () => {
    if (!legs.deployed) {
      const safety = legDeploySafety();
      if (!safety.ok) {
        flashLegsWarning(safety.ascending ? 'Ascending &#9888;' : 'Too fast &#9888;');
        return;
      }
    }
    WorkerBridge.send({ type: 'legs', deployed: !legs.deployed });
    updateLegsButton();
  });
}



// ---------------------------------------------------------------------------
// Start / Stop / Reset
// ---------------------------------------------------------------------------


function bindSimControls() {
  document.getElementById('btnStart').addEventListener('click', () => {
    simRunning = true;
    simPaused = false;
    WorkerBridge.send({ type: 'start' });
    updateStatusBar();
  });
  
  document.getElementById('btnStop').addEventListener('click', () => {
    simRunning = false;
    WorkerBridge.send({ type: 'stop' });
    updateStatusBar();
  });
  
  document.getElementById('btnReset').addEventListener('click', () => {
    simRunning = false;
    simPaused = false;
    WorkerBridge.send({ type: 'reset', alt: 0 });
    renderMergeDiagram();
    renderOctaSliders();
    updateStatusBar();
  });
  
  // ---- Separate stage ----
  const sepBtn = document.getElementById('btnSeparate');
  if (sepBtn) sepBtn.addEventListener('click', () => {
    WorkerBridge.send({ type: 'separate' });
    refreshFollowBodySelect();
    updateStatusBar();
  });
  
  // ---- Take control of another body ----
const tcBtn = document.getElementById('btnTakeControl');
if (tcBtn) tcBtn.addEventListener('click', () => {
  const idx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex)) ?
    camera.followBodyIndex : state.activeBodyIndex;
  // If guidance is running, do NOT shut down the previous active body's
  // engines — guidance is flying it and would immediately re-fire next
  // tick anyway. The take-control is only a human FOCUS change, not a
  // pilot handover. Physics worker respects keepEnginesAlive.
  const guideRunning = document.body.classList.contains('guide-active');
  WorkerBridge.send({ type: 'takeControl', idx, keepEnginesAlive: guideRunning });
  if (typeof camera !== 'undefined') {
    camera.followBodyIndex = idx;
    camera.follow = true;
    camera.mode = 'local';
  }
  updateLegsButton();
  updateStatusBar();
  refreshFollowBodySelect();
});
  
  // ---- Split fairing ----
  const fairBtn = document.getElementById('btnSplitFairing');
  if (fairBtn) fairBtn.addEventListener('click', () => {
    WorkerBridge.send({ type: 'splitFairing' });
    refreshFollowBodySelect();
    updateStatusBar();
  });
  
  // ---- Release payload ----
  const plBtn = document.getElementById('btnReleasePayload');
  if (plBtn) plBtn.addEventListener('click', () => {
    WorkerBridge.send({ type: 'releasePayload' });
    refreshFollowBodySelect();
    updateStatusBar();
  });
  // Emergency eject — independent of stage separation and normal payload
// release. Always available while the active body carries an attached
// payload; splits the fairing and ejects the cargo at high velocity.
const ejectBtn = document.getElementById('btnEjectPayload');
if (ejectBtn) ejectBtn.addEventListener('click', () => {
  WorkerBridge.send({ type: 'emergencyEject' });
});
  
    // Fast Forward button — replaces the old time-warp group. Runs the
  // simulation forward on the main thread with a matching guidance
  // pass, then teleports the physics worker to the final state.
  if (typeof FastForward !== 'undefined') FastForward.bind();
  }

function bindTimeWarp() {
  document.querySelectorAll('.warp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      document.querySelectorAll('.warp-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const v = parseFloat(btn.dataset.warp) || 1;
      WorkerBridge.send({ type: 'warp', value: v });
    });
  });
}

// Guidance assumes a fixed physics tick cadence (dt = CONFIG.DT = 1/80).
// Warp > 1× can drop ticks on slower devices (the physics worker's 12 ms
// wall-clock budget clamps the number of substeps it can run per real
// frame), so guidance's predictions desync from reality and the control
// loop drifts. Lock warp to 1× whenever a guide is active. Called from
// onGuidanceStatus — the guidance worker already pushes a status ack on
// every start/stop, so this tracks run state automatically, including
// auto-stops on crash/halt.
function setWarpEnabled(enabled) {
  const btns = document.querySelectorAll('.warp-btn');
  btns.forEach(b => {
    b.disabled = !enabled;
    b.title = enabled ? '' : 'Guidance active — time warp locked to 1×';
  });
  if (!enabled) {
    const activeBtn = document.querySelector('.warp-btn.active');
    const currentVal = activeBtn ? (parseFloat(activeBtn.dataset.warp) || 1) : 1;
    if (currentVal !== 1) {
      document.querySelectorAll('.warp-btn').forEach(b => b.classList.remove('active'));
      const oneX = document.querySelector('.warp-btn[data-warp="1"]');
      if (oneX) oneX.classList.add('active');
      if (typeof WorkerBridge !== 'undefined') {
        WorkerBridge.send({ type: 'warp', value: 1 });
      }
    }
  }
}



function canSeparateNow() {
  if (_guideActive) return false;
  if (state.crashed) return false;
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members || active.members.length < 2) return false;
  
  // Both the bottom member AND the one directly above it must be a
  // separable role. If the second-from-bottom is a fairing (payloadSpace)
  // or a nose, the bottom is the FINAL upper stage — separating it would
  // leave the fairing drifting as a stack with no rocket attached. That's
  // exactly the case Split Fairing + Release Payload exist for.
  const SEPARABLE = { booster: 1, stage: 1 };
  const bottom = active.members[0];
  const above = active.members[1];
  return !!(bottom && above && SEPARABLE[bottom.stageRole] && SEPARABLE[above.stageRole]);
}

function canSplitFairingNow() {
  if (_guideActive) return false;
  if (state.crashed) return false;
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !Array.isArray(active.members)) return false;
  // Emergency-ejected bodies (fairing + payload flying as one shielded
  // unit) are the END of the ejection sequence — reopening the package
  // defeats its whole point. Explicit flag check covers the case where
  // the user Takes Control of the ejected body, which then becomes the
  // active body and would otherwise pass the fairing-present test below.
  if (active.emergencyEject) return false;
  // After a payload release (normal or emergency), splitting the fairing
  // is meaningless — there's no cargo left to expose.
  if (active.payloadReleased) return false;
  return active.members.some(m => m && m.stageRole === 'payloadSpace');
}

function canReleasePayloadNow() {
  if (_guideActive) return false;
  if (state.crashed) return false;
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !Array.isArray(active.members)) return false;
  // Emergency-ejected bodies never offer the normal "expose the payload"
  // release sequence — they ARE the delivered package.
  if (active.emergencyEject) return false;
  if (active.payloadReleased) return false;
  // Fairing must still be OFF the stack — release is only valid after
  // Split Fairing.
  if (active.members.some(m => m && m.stageRole === 'payloadSpace')) return false;
  // The active body must still actually carry a payloadId.
  if (!active.payloadId) return false;
  return true;
}

function canTakeControlNow() {
  const idx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex)) ?
    camera.followBodyIndex : state.activeBodyIndex;
  if (idx === state.activeBodyIndex) return false;
  const b = state.bodies[idx];
  if (!b) return false;
  // Any body can be taken control of — including free payloads, fairing
  // halves, ejected packages, and crashed stages. "Control" here just
  // means "become the active body so trajectory/telemetry/figure
  // panels switch to it". Bodies without engines / RCS / gimbals do
  // nothing when commanded, and crashed bodies reject all commands at
  // the physics layer (resolveTargetBody returns null) — the cockpit
  // becomes read-only for them.
  return true;
}

// ---------------------------------------------------------------------------
// Landing legs — simple deploy/stow toggle. Purely visual/control for now;
// not yet wired into any touchdown logic (that comes with the landing
// guidance phase later). The button label and pressed-state reflect the
// COMMANDED target immediately, while the legs themselves swing open/closed
// smoothly over ~2s (see physics.js updateLegs()).
// ---------------------------------------------------------------------------

// Legs can only be commanded to DEPLOY when the vehicle isn't climbing under
// power (still on/just off the pad during launch) and isn't moving faster
// than a safe deploy speed (e.g. during a fast reentry, before the entry/
// landing burn has slowed it down). Stowing is never restricted.
function legDeploySafety() {
  if (_guideActive) return { ok: false, ascending: false, tooFast: false };
  const r = Math.hypot(state.rx, state.ry);
  // A crashed body can't deploy or stow anything meaningful — its state
// is frozen by the halt system anyway. Treat as permanently blocked.
if (state.crashed) return { ok: false, ascending: false, tooFast: false };
  const ux = state.rx / r,
    uy = state.ry / r; // local "up" (radial) unit vector
  const vr = state.vx * ux + state.vy * uy; // + = ascending, - = descending
  
  // Ground-relative speed for the deploy-speed check: subtract Earth's
  // tangential rotation velocity at this position (~464 m/s at the
  // equator), same helper computeDragAero() already uses for atmosphere.
  // Without this, a rocket sitting still relative to the ground was being
  // measured at ~464 m/s inertial and instantly tripping "too fast".
  const sv = earthSurfaceVelocity(state.rx, state.ry);
  const relVx = state.vx - sv.vx;
  const relVy = state.vy - sv.vy;
  const speed = Math.hypot(relVx, relVy);
  
  const ascending = vr > 0.5; // small tolerance so sitting on the pad doesn't trip this
  const tooFast = speed > CONFIG.LEG_DEPLOY_MAX_SPEED;
  return { ok: !ascending && !tooFast, ascending, tooFast };
}

// Briefly flashes the legs button red with a reason instead of toggling it,
// then reverts to the normal deployed/stowed label.
function flashLegsWarning(text) {
  const btn = document.getElementById('btnLegs');
  if (!btn) return;
  clearTimeout(btn._legsWarnTimer);
  const prevBg = btn.dataset.prevBg !== undefined ? btn.dataset.prevBg : btn.style.background;
  btn.dataset.prevBg = prevBg;
  btn.innerHTML = `<span class="btn-ic">⚠️</span>${text}`;
  btn.style.background = '#5a1d1d';
  btn._legsWarnTimer = setTimeout(() => {
    btn.style.background = prevBg;
    updateLegsButton();
  }, 1300);
}

function updateLegsButton() {
  const btn = document.getElementById('btnLegs');
  if (!btn) return;
  if (legs.deployed) {
    btn.classList.add('active');
    btn.innerHTML = '<span class="btn-ic">🦿</span>Stow Legs';
  } else {
    btn.classList.remove('active');
    btn.innerHTML = '<span class="btn-ic">🦿</span>Deploy Legs';
  }
}

function updateStatusBar() {
  const dot = getEl('statusDot');
  const txt = getEl('statusText');
  dot.className = 'status-dot';
  if (state.crashed) { dot.classList.add('crashed');
    txt.textContent = 'CRASHED'; }
  else if (state.landed) { dot.classList.add('landed');
    txt.textContent = 'LANDED'; }
  else if (simPaused) { dot.classList.add('paused');
    txt.textContent = 'PAUSED'; }
  else if (simRunning) { dot.classList.add('running');
    txt.textContent = 'RUNNING'; }
  else { txt.textContent = 'STOPPED'; }
  
  const t = state.simTime;
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = (t % 60).toFixed(1).padStart(4, '0');
  getEl('missionClock').textContent = `T+${mm}:${ss}`;
}


// ---------------------------------------------------------------------------
// P4-C4: Fueling availability + panel + Full/Off quick throttle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Throttle UI sync — reads from the state mirror (updated by the worker
// snapshot ~60 fps). Pass an explicit value to override for optimistic UI
// (e.g. when MAX/OFF buttons are clicked).
// ---------------------------------------------------------------------------
function syncThrottleUI(overrideValue) {
  const b = state.bodies && state.bodies[state.activeBodyIndex];
  if (!b || !b.engines) return;
  
  // PHASE 1: engine state is a mass flow rate (kg/s) now, so the display
  // percent is that flow divided by this engine's own max flow — the UI's
  // "percent of max" meaning is unchanged, only the underlying unit is.
  b.engines.filter(e => !e.isCenter).forEach(e => {
    const maxFlow = e.maxMassFlowRate || 1;
    const flow = (e.targetMassFlowRate !== undefined ? e.targetMassFlowRate : e.massFlowRate) || 0;
    const val = (overrideValue !== undefined) ?
      Math.round(overrideValue * 100) :
      Math.round((flow / maxFlow) * 100);
    const input = document.querySelector(`.vslider[data-angle="${e.angleDeg}"]`);
    const label = document.getElementById('val-eng-' + e.angleDeg);
    if (input) input.value = val;
    if (label) label.textContent = val + '%';
  });
  
  const c = b.engines.find(e => e.isCenter);
  if (c) {
    const maxFlow = c.maxMassFlowRate || 1;
    const flow = (c.targetMassFlowRate !== undefined ? c.targetMassFlowRate : c.massFlowRate) || 0;
    const val = (overrideValue !== undefined) ?
      Math.round(overrideValue * 100) :
      Math.round((flow / maxFlow) * 100);
    const slider = document.getElementById('centerThrustSlider');
    const valEl = document.getElementById('centerThrustValue');
    if (slider) slider.value = val;
    if (valEl) valEl.textContent = val + '%';
  }
}

// ---------------------------------------------------------------------------
// Quick MAX / OFF throttle buttons.
// ---------------------------------------------------------------------------
function bindQuickThrottle() {
  const full = document.getElementById('btnFullThrottle');
  const off = document.getElementById('btnEngineOff');
  
  // PHASE 1: MAX sends Infinity rather than a single kg/s figure — engines
  // on this vehicle can be heterogeneous thruster types (different maxes),
  // and the worker's clampMassFlowCommand() resolves Infinity down to
  // each engine's own max cleanly. OFF's 0 needs no conversion at all.
  if (full) full.addEventListener('click', () => {
    WorkerBridge.send({ type: 'setAllThrottle', value: Infinity });
    syncThrottleUI(1);
  });
  if (off) off.addEventListener('click', () => {
    WorkerBridge.send({ type: 'setAllThrottle', value: 0 });
    syncThrottleUI(0);
  });
}

// ---------------------------------------------------------------------------
// Fueling availability + panel.
// ---------------------------------------------------------------------------

// Bottom member's tank capacity (kg). Engines only exist on the bottom
// member (buildEnginesForRecord is called on members[0] only), so only
// that tank is ever consumed during flight. All fueling UI — slider,
// percentage, mass readout — is relative to this, NOT to the whole
// stack, because refueling is a booster-tank operation and the stage's
// tank stays at whatever load it was built with.
function _activeBottomMemberMaxFuel() {
  const b = state.bodies && state.bodies[state.activeBodyIndex];
  if (!b || !b.members || !b.members.length) return 0;
  if (typeof memberMaxFuel === 'function') {
    return memberMaxFuel(b.members[0], b.members[1] || null);
  }
  return 0;
}

function canFuelNow() {
  if (state.crashed) return false;
  const r = Math.hypot(state.rx, state.ry);
  const alt = r - CONFIG.EARTH_RADIUS;
  
  // Surface-relative speed, NOT inertial. Inertial speed on the pad is
  // ~465 m/s (Earth's rotation) — comparing against 0.5 would never pass.
  const sv = (typeof earthSurfaceVelocity === 'function') ?
    earthSurfaceVelocity(state.rx, state.ry) : { vx: 0, vy: 0 };
  const speedRel = Math.hypot(state.vx - sv.vx, state.vy - sv.vy);
  
  const b = state.bodies && state.bodies[state.activeBodyIndex];
  const enginesOff = b && b.engines ?
    b.engines.every(e => (e.targetMassFlowRate || 0) < 0.001 && (e.massFlowRate || 0) < 0.001) :
    true;
  
  const nearPad = Math.abs(state.rx) < 30;
  return alt < 1.5 && speedRel < 0.5 && enginesOff && nearPad;
}

function _fmtKg(kg) {
  return (kg >= 1000) ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg';
}

function _fmtKN(n) {
  return (n / 1000).toFixed(0) + ' kN';
}

function bindFuelPanel() {
  const btn = document.getElementById('btnFuelPanel');
  const slider = document.getElementById('fuelSlider');
  if (!btn || !slider) return;
  
  btn.addEventListener('click', () => {
    const panel = document.getElementById('fuelPanel');
    const opening = !panel || panel.style.display !== 'block';
    if (opening) {
      const b = state.bodies && state.bodies[state.activeBodyIndex];
      // Slider and percentage are relative to the BOTTOM MEMBER's tank
      // capacity, not the whole stack — refueling only touches the
      // booster's own tank (engines only exist there).
      const bottomMax = _activeBottomMemberMaxFuel();
      const bottomFuel = (b && Array.isArray(b.memberFuel) && Number.isFinite(b.memberFuel[0])) ?
        b.memberFuel[0] :
        (b ? (b.fuelMass || 0) : 0);
      const pct = bottomMax > 0 ?
        Math.round((bottomFuel / bottomMax) * 100) :
        0;
      slider.value = pct;
      document.getElementById('fuelPercentLabel').textContent = pct + '%';
      if (panel) panel.style.display = 'block';
      btn.classList.add('active');
      updateFuelPanelReadouts();
    } else {
      if (panel) panel.style.display = 'none';
      btn.classList.remove('active');
    }
  });
  
  slider.addEventListener('input', (e) => {
    if (!canFuelNow()) return;
    const pct = parseFloat(e.target.value);
    const bottomMax = _activeBottomMemberMaxFuel();
    const val = bottomMax * (pct / 100);
    // setBottomFuel only writes memberFuel[0], leaving every stage tank
    // above the booster at its built load. Previously setFuelMass
    // distributed proportional to capacity, so both booster and stage
    // ended up at whatever percentage the slider showed.
    WorkerBridge.send({ type: 'setBottomFuel', value: val });
    document.getElementById('fuelPercentLabel').textContent = Math.round(pct) + '%';
    updateFuelPanelReadouts();
  });
}

function updateFuelPanelReadouts() {
  const panel = document.getElementById('fuelPanel');
  if (!panel || panel.style.display !== 'block') return;
  
  const b = state.bodies && state.bodies[state.activeBodyIndex];
  if (!b) return;
  
  const geom = (typeof geometryOf === 'function') ? geometryOf(b) : { M: 0 };
  const engines = b.engines || [];
  const maxThrust = engines.reduce((s, e) => s + e.Fmax, 0);
  const g0 = (typeof G0 !== 'undefined') ? G0 : 9.80665;
  const weight = geom.M * g0;
  const twr = weight > 0 ? maxThrust / weight : 0;
  
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
// Show the BOTTOM member's own tank — that's the only one that
// actually drains during flight, so it's the number the pilot cares
// about here. Total mass below still reflects the whole stack
// (including the stage's full tank), which is correct.
const bottomFuel = (Array.isArray(b.memberFuel) && Number.isFinite(b.memberFuel[0])) ?
  b.memberFuel[0] :
  (b.fuelMass || 0);
set('fuelReadMass', _fmtKg(bottomFuel));
set('fuelReadTotal', _fmtKg(geom.M));
set('fuelReadThrust', _fmtKN(maxThrust));
set('fuelReadWeight', _fmtKN(weight));
  
  const twrEl = document.getElementById('fuelReadTWR');
  if (twrEl) {
    twrEl.textContent = twr.toFixed(2);
    twrEl.style.color = twr < 1 ? 'var(--danger)' : (twr < 1.2 ? 'var(--yellow)' : 'var(--green)');
  }
  const warn = document.getElementById('fuelWarn');
  if (warn) warn.style.display = (twr < 1) ? 'block' : 'none';
}

function updateFuelAvailability() {
  const btn = getEl('btnFuelPanel');
  if (!btn) return;
  const can = canFuelNow();
  const visible = btn.style.display !== 'none';
  if (can && !visible) btn.style.display = '';
  else if (!can && visible) {
    btn.style.display = 'none';
    const panel = getEl('fuelPanel');
    if (panel && panel.style.display === 'block') panel.style.display = 'none';
    btn.classList.remove('active');
  }
  updateFuelPanelReadouts();
}


// ---------------------------------------------------------------------------
// Guidance-active lock.
//
// When a guide is running, the human UI must not touch anything that
// affects physics. Guidance has its own target-body tracking and would
// get into a tug-of-war with any human command; it also doesn't respect
// the "active body" concept (which the human Take Control manipulates),
// so letting the human change bodies would point guidance's commands at
// the wrong vehicle.
//
// Enabled: view-only controls, Start/Stop/Reset, Fast Forward,
//          follow / zoom / Take Control.
// Disabled: separation, fairing, legs, payload, wind/fuel/engines panels,
//           atmosphere/slosh/IMU toggles.
// Hidden: bottom pilot cluster (throttle sliders + RCS buttons + gimbal).
//
// The only way to regain control is the Abort Guidance button, which
// stops the guide cleanly.
// ---------------------------------------------------------------------------
let _guideActive = false;
function setGuidanceActive(active) {
  const next = !!active;
  if (next === _guideActive) return;
  _guideActive = next;
  document.body.classList.toggle('guide-active', _guideActive);
  
  // Sim-affecting buttons.
  const disables = [
    'btnLegs', 'btnSeparate', 'btnSplitFairing', 'btnReleasePayload',
    'btnEjectPayload', 'btnWindPanel', 'btnFuelPanel', 'btnMergePanel',
  ];
  disables.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = _guideActive;
  });
  
  // Physics-affecting toggles.
  ['toggleAtmosphere', 'toggleSlosh', 'toggleImu'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = _guideActive;
  });
  
  // Right-toolbar guidance controls: can't switch guide mid-mission,
  // can't double-start.
  const guideSel = document.getElementById('guideSelect');
  if (guideSel) guideSel.disabled = _guideActive;
  const guideStart = document.getElementById('btnGuideStart');
  if (guideStart) guideStart.disabled = _guideActive;
  
  // Abort button — visible only while a guide is running.
  const abortBtn = document.getElementById('btnGuideAbort');
  if (abortBtn) abortBtn.style.display = _guideActive ? '' : 'none';
}

// Abort — the ONLY way to release the human lock while a guide is
// running. Sends the guide a stop command; the sim itself keeps
// flying (physics runs regardless), only the autonomous controller
// is detached.
function abortGuidance() {
  if (typeof GuidanceBridge === 'undefined' || !GuidanceBridge.ready) return;
  GuidanceBridge.send({ type: 'guidanceCommand', action: 'stop' });
}

// Called by onGuidanceStatus every time the guidance worker pushes
// a status update, so the lock state always tracks the actual guide.
function _syncGuidanceLock(status) {
  const active = !!(status && status.active);
  setGuidanceActive(active);
}

// ============================================================================
// Right toolbar — guidance selection + start/stop.
// ============================================================================
function bindGuidanceToolbar() {
  const toolbar = document.getElementById('rightToolbar');
  const toggle = document.getElementById('rightToolbarToggle');
  const sel = document.getElementById('guideSelect');
  const startBtn = document.getElementById('btnGuideStart');
  const stopBtn = document.getElementById('btnGuideStop');
  
  if (!toolbar || !toggle || !sel || !startBtn || !stopBtn) {
    console.warn('bindGuidanceToolbar: some elements missing');
    return;
  }
  
  // Open by default so the user sees the new panel immediately.
  toolbar.classList.add('open');
  toggle.textContent = '›';
  
  toggle.addEventListener('click', () => {
    toolbar.classList.toggle('open');
    toggle.textContent = toolbar.classList.contains('open') ? '›' : '‹';
  });
  
  startBtn.addEventListener('click', () => {
    const name = sel.value;
    if (!name) { alert('Select a guidance first'); return; }
    if (typeof GuidanceBridge === 'undefined' || !GuidanceBridge.ready) {
      console.warn('[guidance toolbar] guidance worker not ready yet');
      return;
    }
    GuidanceBridge.send({ type: 'guidanceCommand', action: 'start', guideName: name });
  });
  
    stopBtn.addEventListener('click', () => {
    if (typeof GuidanceBridge === 'undefined') return;
    GuidanceBridge.send({ type: 'guidanceCommand', action: 'stop' });
  });
  
  // Abort Guidance — prominent top-bar button, visible only while
  // a guide is running.
  const abortBtn = document.getElementById('btnGuideAbort');
  if (abortBtn) abortBtn.addEventListener('click', abortGuidance);
  }

// ---------------------------------------------------------------------------
// Farewell sequence — driven by the CURRENT guidance phase, not by
// transition detection. This makes it robust against:
//   - fast-forward (phases can jump, transitions aren't observed)
//   - missed throttled status pushes
//   - the user landing in the middle of the sequence
//
// Message table (keyed by phase + trimDone):
//   DONE                              "GOING FOR FINAL BURN…"        (persistent)
//   SUICIDE_COAST, !trimDone          "JUST ADJUSTING MY FINAL DESTINATION…"
//   SUICIDE_COAST, trimDone           "GOOD BYE !"                    (8 s fade)
//   any other phase                   (hidden)
//
// We latch on the message KEY (not on phase-delta). When the key
// changes, we swap the display; when it doesn't, we leave it alone so
// the auto-hide timer isn't reset every status push.
//
// Every message shows the headline on one line, and "~ stage-name" on
// the next line.
// ---------------------------------------------------------------------------
let _farewellLastKey = '';
let _farewellHideTimer = null;

function _farewellEl() {
  let el = document.getElementById('farewellMsg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'farewellMsg';
    document.body.appendChild(el);
  }
  return el;
}

function _showFarewell(html, autoHideMs) {
  const el = _farewellEl();
  el.innerHTML = html;
  // Force reflow so the show transition re-fires if the element was
  // hidden milliseconds before.
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  if (_farewellHideTimer) { clearTimeout(_farewellHideTimer); _farewellHideTimer = null; }
  if (autoHideMs && autoHideMs > 0) {
    _farewellHideTimer = setTimeout(() => {
      el.classList.remove('show');
      _farewellHideTimer = null;
    }, autoHideMs);
  }
}

function _hideFarewell() {
  const el = document.getElementById('farewellMsg');
  if (!el) return;
  el.classList.remove('show');
  if (_farewellHideTimer) { clearTimeout(_farewellHideTimer); _farewellHideTimer = null; }
}

// Find the stage body's name, regardless of which body is active.
// Scans the body list for a non-crashed body whose bottom member is a
// 'stage' role; falls back to the active body's first member name;
// finally falls back to a generic string.
function _farewellStageName() {
  try {
    const bodies = (state && state.bodies) ? state.bodies : [];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || !Array.isArray(b.members) || !b.members.length) continue;
      const m0 = b.members[0];
      if (m0 && m0.stageRole === 'stage' && m0.name && !b.crashed) {
        return m0.name;
      }
    }
    const a = bodies[state.activeBodyIndex];
    if (a && Array.isArray(a.members) && a.members.length && a.members[0].name) {
      return a.members[0].name;
    }
  } catch (e) { /* fallthrough */ }
  return 'the stage';
}

function _esc(s) {
  return String(s).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// Build the message body: headline on top, "~ name" below on its own line.
function _farewellHtml(headline) {
  const name = _farewellStageName();
  return _esc(headline) + '<br>' +
    '<span class="fw-bracket">~</span>' +
    '<span class="fw-name">' + _esc(name) + '</span>';
}

function _driveFarewell(status) {
  // Guide not running — clear everything.
  if (!status || !status.active) {
    _hideFarewell();
    _farewellLastKey = '';
    return;
  }
  const curPhase = status.phase || '';
  const curTrimDone = !!status.suicideTrimDone;
  
  // Message table — one entry per guidance phase of the suicide sequence.
  // Every message auto-hides after 5 s. Phase transitions replace the
  // current message immediately (rather than waiting for the timer).
  //
  //   DONE            → "MISSION SUCCESSFUL"
  //   SUICIDE_ROTATE  → "JUST ADJUSTING FOR FINAL BURN…"
  //   SUICIDE_BURN    → "GOING FOR FINAL BURN…"
  //   SUICIDE_COAST   → "JUST ADJUSTING FINAL DESTINATION…" (or "GOOD BYE !"
  //                     if trim already converged on entry)
  //
  // Any other phase (ASCENT, MECO, STAGE_BURN, etc.) → key stays null →
  // element hidden.
  let key = null;
  let headline = null;
  const AUTO_HIDE_MS = 5000;
  
  if (curPhase === 'DONE') {
    key = 'DONE';
    headline = 'MISSION SUCCESSFUL';
  } else if (curPhase === 'SUICIDE_ROTATE') {
    key = 'ADJUST_BURN';
    headline = 'JUST ADJUSTING FOR FINAL BURN…';
  } else if (curPhase === 'SUICIDE_BURN') {
    key = 'FINAL_BURN';
    headline = 'GOING FOR FINAL BURN…';
  } else if (curPhase === 'SUICIDE_COAST') {
    if (curTrimDone) {
      key = 'BYE';
      headline = 'GOOD BYE !';
    } else {
      key = 'ADJUST_DEST';
      headline = 'JUST ADJUSTING FINAL DESTINATION…';
    }
  }
  
  if (key !== _farewellLastKey) {
    console.log('[farewell] key:', _farewellLastKey || '(none)', '→', key || '(none)',
      '| phase:', curPhase, '| trimDone:', curTrimDone);
    _farewellLastKey = key;
    if (headline) _showFarewell(_farewellHtml(headline), AUTO_HIDE_MS);
    else _hideFarewell();
  }
}

// Called by workerBridge.js whenever the guidance worker pushes a status
// update (or an immediate ack from a guidanceCommand). Updates the right
// toolbar's live readout.
function onGuidanceStatus(status) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  
  // Sync the guidance-active lock every time we hear from the worker.
  // Idempotent — the function bails if the state hasn't changed.
  _syncGuidanceLock(status);

  // Farewell sequence — driven by phase transitions. Fires the
  // "GOING FOR FINAL BURN" / "JUST ADJUSTING" / "GOOD BYE" messages
  // during the suicide-burn flow.
  _driveFarewell(status);

// TEMP DIAGNOSTIC — COAST_HOLD_2 attitude investigation.
if (status && status.phase === 'COAST_HOLD_2' && status.coast2TargetThetaDeg != null) {
  const now = performance.now();
  if (!window._c2DiagLast || now - window._c2DiagLast > 500) {
    window._c2DiagLast = now;
    const b = state.bodies[state.activeBodyIndex];
    if (b) {
      const thetaDeg = b.theta * 180 / Math.PI;
      const omegaDeg = b.omega * 180 / Math.PI;
      const errDeg = thetaDeg - status.coast2TargetThetaDeg;
      let rcsSummary = 'none';
      if (b.rcsDuty) {
        const pods = Object.keys(b.rcsDuty);
        if (pods.length) {
          rcsSummary = pods.map(p => {
            const d = b.rcsDuty[p];
            return p + ':' + (d.lat || 0).toFixed(2) + '/' + (d.up || 0).toFixed(2) + '/' + (d.dn || 0).toFixed(2);
          }).join(' ');
        }
      }
      console.log('[c2] θ_in=' + thetaDeg.toFixed(3) +
        ' tgt=' + status.coast2TargetThetaDeg.toFixed(3) +
        ' err=' + errDeg.toFixed(3) + '°' +
        ' ω=' + omegaDeg.toFixed(5) + '°/s' +
        ' settled=' + b.settled +
        ' crashed=' + b.crashed +
        ' RCS=' + rcsSummary);
    }
  }
}
  
  // Warp lock — guidance is active → force 1× and disable warp buttons.
  // Auto-syncs on every status ack (start, stop, and any auto-stop).
  setWarpEnabled(!(status && status.active));
  
  if (!status || !status.active) {
    set('guideStatusText', 'STOPPED');
    set('guideStatusTicks', '—');
    set('guideStatusTarget', '—');
    set('guideStatusAchieved', '—');
    set('guideStatusFires', '—');
    return;
  }
  set('guideStatusText', 'RUNNING');
set('guideStatusTicks', String(status.ticks || 0));
set('guideStatusTarget', Math.round(status.lastTarget || 0) + ' N·m');
set('guideStatusAchieved', Math.round(status.lastAchieved || 0) + ' N·m');
const fires = (status.lastFires || 0) + (status.lastSaturated ? ' · sat' : '');
set('guideStatusFires', fires);

// ascentAoaHold status
if (status.aoaDeg !== undefined) {
  const r2d = 180 / Math.PI;
 /* console.log(
  `[hold] ${status.phase} t=${status.elapsed.toFixed(1)}s alt=${status.altKm.toFixed(2)}km ` +
  `dQ=${status.dQ.toFixed(0)}Pa/s ` +
  `AoA=${status.aoaDeg.toFixed(3)}°→${status.aoaNextDeg.toFixed(3)}° ` +
  `ω_now=${status.omegaAoANow.toFixed(5)} ω_N1=${status.omegaAoANext.toFixed(5)} ` +
  `α_now=${status.alphaAoANow.toFixed(5)} α_N1=${status.alphaAoANext.toFixed(5)}`
);*/
}

// ascentRR status
if (status.tauDesired !== undefined && status.mode !== undefined && status.deltaDeg !== undefined) {
  const d2r = 180 / Math.PI;
  const r2d = 180 / Math.PI;
  console.log(
    `[rr] ${status.phase}·${status.mode}${status.paused?'·PAUSED':''} ` +
    `t=${status.elapsed.toFixed(2)}s alt=${status.altKm.toFixed(2)}km Q=${(status.Q/1000).toFixed(1)}kPa Δθ=${status.deltaDeg.toFixed(2)}°`
  );
  console.log(
    `     θ_in=${(status.thetaInertial*d2r).toFixed(3)}° θ_rel=${(status.thetaRel*d2r).toFixed(3)}° ` +
    `θ_tgt_rel=${(status.targetThetaRel*d2r).toFixed(3)}° θ_err=${(status.thetaErr*d2r).toFixed(4)}°`
  );
  console.log(
    `     ω_in=${(status.omegaInertial*d2r).toFixed(4)}°/s ω_rel=${(status.omegaRel*d2r).toFixed(4)}°/s`
  );
  console.log(
    `     τ_des=${status.tauDesired.toExponential(3)} τ_drag=${status.tauDrag.toExponential(3)} ` +
    `τ_tgt=${status.tauTarget.toExponential(3)}`
  );
  console.log(
    `     gimbal: N=${status.gRadN.toFixed(3)}° N+1=${status.gRadN1.toFixed(3)}° ` +
    `g_req=${status.gReqDeg.toFixed(3)}° R_req=${status.rReq.toFixed(2)}°/s R_cmd=${status.rCmd.toFixed(2)}°/s`
  );
  console.log(
    `     M=${status.mass.toFixed(0)}kg I=${status.inertia.toExponential(2)} thrustFlow=${status.throttleFlow !== null ? status.throttleFlow.toFixed(1) : '—'}`
  );
}

// gimbalPredictive2 status — main-thread console log
if (status.gReq !== undefined) {
  console.log(
    `[g2] t=${status.ticks}` +
    ` g_N=${status.gN.toFixed(3)}° → g_{N+1}=${status.gN1.toFixed(3)}°` +
    ` g_req=${status.gReq.toFixed(3)}°` +
    ` R_req=${status.RReq.toFixed(1)}°/s → R_cmd=${status.RCmd.toFixed(1)}°/s` +
    (status.saturated ? ' [SAT]' : '') +
    ` τ_drag(N+2)=${status.tauDrag2.toFixed(0)} N·m`
  );
}

// leoInsertionV2 post-circularize realign — main-thread log so no
// worker-console switching needed. Prints both pre- and post-burn
// targets so we can compare whether the second-apogee target differs
// from the first (which is the whole point of the realign).
if (status.coast2TargetThetaDeg !== null && status.coast2TargetThetaDeg !== undefined) {
  if (window._lastCoast2Log !== status.coast2TargetThetaDeg) {
    window._lastCoast2Log = status.coast2TargetThetaDeg;
    console.log('[c2] phase=' + status.phase +
      ' coastTarget=' + (status.coastTargetThetaDeg != null ?
        status.coastTargetThetaDeg.toFixed(2) + '°' : '—') +
      ' coast2Target=' + status.coast2TargetThetaDeg.toFixed(2) + '°' +
      ' rotateStart=' + (status.coast2RotateStartTiltDeg != null ?
        status.coast2RotateStartTiltDeg.toFixed(2) + '°' : '—'));
  }
}

// predictVerifier rolling stats — only present when that guide is active.
// Logged on the MAIN thread's console, so no worker-console switching.
if (status.nCompared !== undefined) {
    console.log(
      `[pv] n=${status.nCompared} skip=${status.nSkipped}` +
      ` | τ mean|err|=${status.meanAbsErrTq.toFixed(0)} N·m` +
      ` last pred=${status.lastTq.pred.toFixed(0)} act=${status.lastTq.act.toFixed(0)}` +
      ` | α mean|err|=${status.meanAbsErrAlphaDeg.toExponential(2)}°` +
      ` last pred=${status.lastAlpha.pred.toFixed(4)} act=${status.lastAlpha.act.toFixed(4)}` +
      ` | drag mean|err|=${status.meanAbsErrDragN.toFixed(0)} N` +
      ` | Q mean|err|=${status.meanAbsErrQPa.toFixed(1)} Pa`
    );
  }
  

}




// ============================================================================
// Guidance System modal — open/close, guidance dropdown, preset dropdown,
// constants form (important-on-top), Apply / Reset / Export / Paste / Save.
//
// Reads live config from the guidance worker via GuidanceBridge (promise
// helpers added in workerBridge.js), renders fields locally, and writes
// back on Apply. Presets come from guidancePresets.js (main thread only).
//
// State is intentionally session-scoped: the modal always re-fetches on
// open, so a page refresh naturally restores code defaults with no extra
// bookkeeping.
// ============================================================================
function bindGuidanceConfigModal() {
  const backdrop    = document.getElementById('gcmBackdrop');
  if (!backdrop) { console.warn('[gcm] modal backdrop not found — wiring skipped'); return; }

  const btnOpen     = document.getElementById('btnGuideConfig');
  const btnClose    = document.getElementById('gcmClose');
  const guideSel    = document.getElementById('gcmGuideSelect');
  const presetSel   = document.getElementById('gcmPresetSelect');
  const configNote  = document.getElementById('gcmConfigNote');
  const fieldsHost  = document.getElementById('gcmFieldsHost');
  const noConfigEl  = document.getElementById('gcmNoConfig');

  // sub-panels
  const pastePanel  = document.getElementById('gcmPastePanel');
  const pasteText   = document.getElementById('gcmPasteText');
  const pasteErr    = document.getElementById('gcmPasteError');
  const pasteConfirm= document.getElementById('gcmPasteConfirm');
  const pasteCancel = document.getElementById('gcmPasteCancel');

  const savePanel   = document.getElementById('gcmSavePanel');
  const saveName    = document.getElementById('gcmSaveName');
  const saveDesc    = document.getElementById('gcmSaveDesc');
  const saveTags    = document.getElementById('gcmSaveTags');
  const saveErr     = document.getElementById('gcmSaveError');
  const saveConfirm = document.getElementById('gcmSaveConfirm');
  const saveCancel  = document.getElementById('gcmSaveCancel');

  // footer actions
  const btnReset    = document.getElementById('gcmReset');
  const btnPaste    = document.getElementById('gcmPasteBtn');
  const btnExport   = document.getElementById('gcmExportBtn');
  const btnSave     = document.getElementById('gcmSaveBtn');
  const btnApply    = document.getElementById('gcmApply');

  // ----------------------------------------------------------------
  // Local state
  // ----------------------------------------------------------------
  let _activeGuide        = '';        // currently displayed guide
  let _referenceConstants = null;      // schema + Reset source (nested)
  let _currentValues      = null;      // mirror of field values (nested)
  let _renderToken        = 0;         // async guard for rapid guide switches

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // Bottom-center toast, self-created on first use.
  let _toastEl = null, _toastTimer = null;
  function toast(msg) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.id = 'gcmToast';
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => _toastEl.classList.remove('show'), 2800);
  }

  // Is the current guide active in the sim? (_guideActive is the same
  // module-scope flag controls.js already maintains via onGuidanceStatus.)
  function isGuideActive() {
    return typeof _guideActive !== 'undefined' && _guideActive;
  }

  // ----------------------------------------------------------------
  // Dropdowns
  // ----------------------------------------------------------------
  function populateGuideDropdown() {
    const all = (typeof Guidance !== 'undefined' && Guidance.listGuides)
      ? Guidance.listGuides()
      : [];
    const withCfg = (typeof Guidance !== 'undefined' && Guidance.listGuidesWithConfig)
      ? new Set(Guidance.listGuidesWithConfig())
      : new Set();
    guideSel.innerHTML = all.length
      ? all.map(g => {
          const suffix = withCfg.has(g) ? '' : ' — no tunable constants';
          return `<option value="${g}">${g}${suffix}</option>`;
        }).join('')
      : '<option value="">(no guides registered)</option>';
  }

  function populatePresetDropdown(guideName) {
    if (typeof getAllPresetsForGuide !== 'function') {
      presetSel.innerHTML = '<option value="">— presets module unavailable —</option>';
      presetSel.disabled = true;
      return;
    }
    const list = getAllPresetsForGuide(guideName);
    if (!list.length) {
      presetSel.innerHTML = '<option value="">— no presets —</option>';
      presetSel.disabled = true;
      return;
    }
    presetSel.disabled = false;
    presetSel.innerHTML = '<option value="">— select a preset —</option>' +
      list.map(p => {
        const tag = p.isDefault ? 'DEFAULT' : 'USER';
        const stack = p.stackName || '(no stack)';
        return `<option value="${p.id}">${p.name} · [${tag}] · ${stack}</option>`;
      }).join('');
    presetSel.value = '';
  }

  // ----------------------------------------------------------------
  // Field rendering
  // ----------------------------------------------------------------
  // A "leaf path" is a dotted key leading to a scalar in the reference.
  // Nested objects are rendered as their own collapsible section.
  function makeFieldRow(path, reference, values) {
    const refVal = getByPath(reference, path);
    const curVal = getByPath(values, path);
    const leafType = typeof refVal;

    const row = document.createElement('div');
    row.className = 'gcm-field-row';
    row.dataset.path = path;

    const lbl = document.createElement('label');
    lbl.textContent = path.split('.').pop();
    lbl.title = path;
    row.appendChild(lbl);

    let input;
    if (leafType === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!curVal;
      input.addEventListener('change', () => {
        setByPath(_currentValues, path, !!input.checked);
      });
    } else if (leafType === 'string') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = curVal != null ? String(curVal) : '';
      input.addEventListener('input', () => {
        setByPath(_currentValues, path, input.value);
      });
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = Number.isFinite(curVal) ? curVal : '';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) {
          setByPath(_currentValues, path, v);
          input.classList.remove('gcm-invalid');
        } else {
          input.classList.add('gcm-invalid');
        }
      });
    }
    input.dataset.path = path;
    row.appendChild(input);
    return row;
  }

  function renderFields(guideName, values, reference) {
    fieldsHost.innerHTML = '';
    _currentValues = clone(values);

    const important = (typeof getGuideImportantFields === 'function')
      ? getGuideImportantFields(guideName)
      : [];
    const importantSet = new Set(important);

    // ---- Important section (if any) ----
    if (important.length) {
      const section = document.createElement('div');
      section.className = 'gcm-section is-important';
      const header = document.createElement('div');
      header.className = 'gcm-section-header no-toggle';
      header.innerHTML = '<span>Important</span>';
      section.appendChild(header);
      const body = document.createElement('div');
      body.className = 'gcm-section-body';
      let any = false;
      important.forEach(path => {
        const refV = getByPath(reference, path);
        if (refV === undefined) {
          console.warn('[gcm] important field not in schema:', guideName, path);
          return;
        }
        any = true;
        body.appendChild(makeFieldRow(path, reference, values));
      });
      if (any) {
        section.appendChild(body);
        fieldsHost.appendChild(section);
      }
    }

    // ---- Remaining fields, grouped by top-level key ----
    const rootScalars = [];
    const objectGroups = [];
    for (const k in reference) {
      if (importantSet.has(k)) continue;
      const v = reference[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        objectGroups.push(k);
      } else {
        rootScalars.push(k);
      }
    }

    if (rootScalars.length) {
      const section = document.createElement('div');
      section.className = 'gcm-section';
      const header = document.createElement('div');
      header.className = 'gcm-section-header';
      header.innerHTML = '<span>Root</span><span class="gcm-section-chevron">▾</span>';
      header.addEventListener('click', () => {
        section.dataset.collapsed = (section.dataset.collapsed === '1') ? '0' : '1';
      });
      const body = document.createElement('div');
      body.className = 'gcm-section-body';
      rootScalars.forEach(k => body.appendChild(makeFieldRow(k, reference, values)));
      section.appendChild(header);
      section.appendChild(body);
      fieldsHost.appendChild(section);
    }

    objectGroups.forEach(gk => {
      const subRef = reference[gk];
      const section = document.createElement('div');
      section.className = 'gcm-section';
      const header = document.createElement('div');
      header.className = 'gcm-section-header';
      header.innerHTML = `<span>${gk}</span><span class="gcm-section-chevron">▾</span>`;
      header.addEventListener('click', () => {
        section.dataset.collapsed = (section.dataset.collapsed === '1') ? '0' : '1';
      });
      const body = document.createElement('div');
      body.className = 'gcm-section-body';

      for (const ck in subRef) {
        const childPath = gk + '.' + ck;
        if (importantSet.has(childPath)) continue;
        const cv = subRef[ck];
        if (cv !== null && typeof cv === 'object' && !Array.isArray(cv)) {
          // Depth-3 subgroup — inline header spanning the grid, then
          // its scalar children below it.
          const subHead = document.createElement('div');
          subHead.style.gridColumn = '1 / -1';
          subHead.style.fontSize = '10.5px';
          subHead.style.color = 'var(--dim)';
          subHead.style.letterSpacing = '0.6px';
          subHead.style.textTransform = 'uppercase';
          subHead.style.marginTop = '6px';
          subHead.textContent = ck;
          body.appendChild(subHead);
          for (const gck in cv) {
            const deepPath = childPath + '.' + gck;
            if (importantSet.has(deepPath)) continue;
            body.appendChild(makeFieldRow(deepPath, reference, values));
          }
        } else {
          body.appendChild(makeFieldRow(childPath, reference, values));
        }
      }
      section.appendChild(header);
      section.appendChild(body);
      fieldsHost.appendChild(section);
    });
  }

  // ----------------------------------------------------------------
  // Read / apply field values
  // ----------------------------------------------------------------
  // Read every rendered input back into a nested object shaped like
  // `_referenceConstants`. Returns { ok:false, path } on the first
  // invalid number entry.
  function readCurrentValues() {
    const out = clone(_referenceConstants);
    const inputs = fieldsHost.querySelectorAll('input[data-path]');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      const path = inp.dataset.path;
      const refVal = getByPath(_referenceConstants, path);
      if (typeof refVal === 'boolean') {
        setByPath(out, path, !!inp.checked);
      } else if (typeof refVal === 'string') {
        setByPath(out, path, String(inp.value));
      } else {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return { ok: false, path };
        setByPath(out, path, v);
      }
    }
    return { ok: true, values: out };
  }

  // Push a nested values bag into every rendered input.
  function applyValuesToFields(values) {
    _currentValues = clone(values);
    const inputs = fieldsHost.querySelectorAll('input[data-path]');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      const path = inp.dataset.path;
      const refVal = getByPath(_referenceConstants, path);
      const v = getByPath(values, path);
      inp.classList.remove('gcm-invalid');
      if (typeof refVal === 'boolean') inp.checked = !!v;
      else if (typeof refVal === 'string') inp.value = v != null ? String(v) : '';
      else inp.value = Number.isFinite(v) ? v : '';
    }
  }

  // ----------------------------------------------------------------
  // Load a guide into the modal
  // ----------------------------------------------------------------
  async function loadGuide(guideName) {
    _activeGuide = guideName;
    pastePanel.style.display = 'none';
    savePanel.style.display = 'none';
    pasteErr.style.display = 'none';
    saveErr.style.display = 'none';

    const token = ++_renderToken;

    if (typeof GuidanceBridge === 'undefined' || !GuidanceBridge.ready) {
      fieldsHost.innerHTML = '';
      noConfigEl.style.display = '';
      noConfigEl.textContent = 'Waiting for guidance worker…';
      configNote.textContent = '—';
      presetSel.innerHTML = '<option value="">—</option>';
      presetSel.disabled = true;
      return;
    }

    let liveConfig = null;
    try {
      liveConfig = await GuidanceBridge.requestGuideConfig(guideName);
    } catch (e) {
      console.error('[gcm] requestGuideConfig failed', e);
    }
    // Guard against a slower request resolving after a newer one started.
    if (token !== _renderToken) return;

    if (!liveConfig) {
      fieldsHost.innerHTML = '';
      noConfigEl.style.display = '';
      noConfigEl.textContent = 'This guidance has no tunable constants.';
      configNote.textContent = '—';
      presetSel.innerHTML = '<option value="">—</option>';
      presetSel.disabled = true;
      return;
    }

    const defPreset = (typeof getGuideDefaultPreset === 'function')
      ? getGuideDefaultPreset(guideName)
      : null;
    _referenceConstants = defPreset ? clone(defPreset.constants) : clone(liveConfig);

    populatePresetDropdown(guideName);
    noConfigEl.style.display = 'none';
    renderFields(guideName, liveConfig, _referenceConstants);

    configNote.textContent = isGuideActive()
      ? 'A guide is running. Edits apply on the next Start.'
      : 'Values apply on the next Start of the guide. Edits are session-only — a page refresh restores code defaults.';
  }

  // ----------------------------------------------------------------
  // Open / close
  // ----------------------------------------------------------------
  function openModal() {
    backdrop.style.display = 'flex';
    populateGuideDropdown();
    // Preserve the currently-selected sim guide if it exists in the list.
    const simSel = document.getElementById('guideSelect');
    const wanted = (simSel && simSel.value
      && guideSel.querySelector(`option[value="${simSel.value}"]`))
      ? simSel.value
      : (guideSel.options[0] ? guideSel.options[0].value : '');
    if (wanted) {
      guideSel.value = wanted;
      loadGuide(wanted);
    }
  }
  function closeModal() {
    backdrop.style.display = 'none';
  }

  // ----------------------------------------------------------------
  // Event wiring
  // ----------------------------------------------------------------
  if (btnOpen) btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.style.display === 'flex') closeModal();
  });

  // Modal's guide dropdown is the single source of truth for "which guide
// is active". Mirror it to the hidden #guideSelect so the toolbar's
// Start button, fastForward.js, and boot-time sync all see the same
// selection.
guideSel.addEventListener('change', () => {
  const hidden = document.getElementById('guideSelect');
  if (hidden && guideSel.value) hidden.value = guideSel.value;
  loadGuide(guideSel.value);
});

  // Preset selection — fills fields only, no auto-apply.
  presetSel.addEventListener('change', () => {
    const id = presetSel.value;
    if (!id) return;
    if (typeof getPresetById !== 'function' || typeof validateConstantsStrict !== 'function') return;
    const p = getPresetById(id);
    if (!p || !p.constants) return;
    const v = validateConstantsStrict(p.constants, _referenceConstants);
    if (!v.ok) {
      toast('Preset incompatible: ' + v.error);
      return;
    }
    applyValuesToFields(p.constants);
    toast('Loaded preset "' + p.name + '" (not applied yet)');
  });

  // Reset to code defaults
  btnReset.addEventListener('click', () => {
    if (!_referenceConstants) return;
    applyValuesToFields(_referenceConstants);
    toast('Fields reset to code defaults (not applied yet)');
  });

  // Export current field values as JSON
  btnExport.addEventListener('click', () => {
    const r = readCurrentValues();
    if (!r.ok) { toast('Invalid value at ' + r.path); return; }
    const json = JSON.stringify(r.values, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(
        () => toast('Copied constants JSON to clipboard'),
        () => toast('Clipboard write failed')
      );
    } else {
      const ta = document.createElement('textarea');
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied constants JSON'); }
      catch (e) { toast('Copy failed'); }
      document.body.removeChild(ta);
    }
  });

  // Paste JSON sub-panel
  btnPaste.addEventListener('click', () => {
    pastePanel.style.display = '';
    savePanel.style.display = 'none';
    pasteErr.style.display = 'none';
    pasteText.value = '';
    pasteText.focus();
  });
  pasteCancel.addEventListener('click', () => {
    pastePanel.style.display = 'none';
    pasteErr.style.display = 'none';
  });
  pasteConfirm.addEventListener('click', () => {
    if (!_referenceConstants) return;
    let parsed;
    try { parsed = JSON.parse(pasteText.value); }
    catch (e) {
      pasteErr.textContent = 'JSON parse error: ' + e.message;
      pasteErr.style.display = '';
      return;
    }
    const v = validateConstantsStrict(parsed, _referenceConstants);
    if (!v.ok) {
      pasteErr.textContent = 'Validation failed: ' + v.error;
      pasteErr.style.display = '';
      return;
    }
    pasteErr.style.display = 'none';
    applyValuesToFields(parsed);
    pastePanel.style.display = 'none';
    toast('Fields filled from pasted JSON (not applied yet)');
  });

  // Save as preset sub-panel
  btnSave.addEventListener('click', () => {
    savePanel.style.display = '';
    pastePanel.style.display = 'none';
    saveErr.style.display = 'none';
    saveName.value = '';
    saveDesc.value = '';
    saveTags.value = '';
    saveName.focus();
  });
  saveCancel.addEventListener('click', () => {
    savePanel.style.display = 'none';
    saveErr.style.display = 'none';
  });
  saveConfirm.addEventListener('click', () => {
    if (!_referenceConstants) return;
    const name = saveName.value.trim();
    if (!name) {
      saveErr.textContent = 'Name is required.';
      saveErr.style.display = '';
      return;
    }
    const r = readCurrentValues();
    if (!r.ok) {
      saveErr.textContent = 'Invalid value at ' + r.path;
      saveErr.style.display = '';
      return;
    }
    if (typeof addUserPreset !== 'function') {
      saveErr.textContent = 'Preset storage unavailable.';
      saveErr.style.display = '';
      return;
    }
    let stackId = '', stackName = '';
    if (typeof getActiveStack === 'function') {
      const stk = getActiveStack();
      if (stk) { stackId = stk.id; stackName = stk.name; }
    }
    const tags = saveTags.value.split(',').map(s => s.trim()).filter(Boolean);
    const rec = addUserPreset({
      name,
      description: saveDesc.value.trim(),
      guideName: _activeGuide,
      stackId,
      stackName,
      tags,
      constants: r.values,
    });
    if (!rec) {
      saveErr.textContent = 'Save failed. See console.';
      saveErr.style.display = '';
      return;
    }
    populatePresetDropdown(_activeGuide);
    savePanel.style.display = 'none';
    toast('Preset "' + rec.name + '" saved');
  });

  // Apply — writes to live config via worker bridge. Takes effect on the
  // next Start if the guide is currently running.
  btnApply.addEventListener('click', async () => {
    if (!_referenceConstants) return;
    const r = readCurrentValues();
    if (!r.ok) { toast('Invalid value at ' + r.path); return; }

    if (typeof GuidanceBridge === 'undefined' || !GuidanceBridge.ready) {
      toast('Guidance worker not ready.');
      return;
    }
    try {
      const ok = await GuidanceBridge.setGuideConfig(_activeGuide, r.values);
      if (!ok) { toast('Apply failed — see console.'); return; }
      toast(isGuideActive()
        ? 'Applied. Takes effect on next Start.'
        : 'Applied.');
    } catch (e) {
      console.error('[gcm] apply failed', e);
      toast('Apply failed: ' + e.message);
    }
  });
}


