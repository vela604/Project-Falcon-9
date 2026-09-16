// ============================================================================
// controls.js — All user-input handling: main thrust slider, center gimbal
// CW/ACW buttons, 4x4 octaweb vertical sliders, RCS 8-direction + rotation
// buttons, wind panel, merge-diagram interactions, panel toggles.
// ============================================================================

let simRunning = false;
let simPaused = false;
let timeWarp = 1;   // physics-time multiplier (1 = real time)
// ---------------------------------------------------------------------------
// Touch/mouse "hold to increase, release to snap back to 0" helper.
// ---------------------------------------------------------------------------
function bindHoldControl(el, onChange, opts = {}) {
  const rate = opts.rate || 1.5;      // units/sec while held
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
function setGroupThrottle(group, value) {
  WorkerBridge.send({ type: 'setGroupThrottle', angles: group.angles, value });
}

// PHASE 2: primary-engine throttle. "Primary" = whatever the active engine
// layout marks role:'center' (today always exactly one — the octaweb's core
// engine — but this filters rather than assumes a single match, so a future
// layout with more than one center-role slot works without changes here).
function setCenterThrottle(value) {
  WorkerBridge.send({ type: 'setCenterThrottle', value });
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
  function on(e) { e.preventDefault(); WorkerBridge.send({ type: 'rcs', key, on: true }); el.classList.add('active'); }
  function off() { WorkerBridge.send({ type: 'rcs', key, on: false }); el.classList.remove('active'); }
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
  if (opening && el.dataset.pauseSim === 'true') {
    simPaused = true;
    updateStatusBar();
  } else if (!opening) {
    // Only auto-resume if no other pausing panel is open
    const anyOpen = Array.from(document.querySelectorAll('[data-pause-sim="true"]'))
      .some(p => p.style.display === 'block');
    if (!anyOpen) { simPaused = false; updateStatusBar(); }
  }
}

// ---------------------------------------------------------------------------
// Wind panel
// ---------------------------------------------------------------------------
function bindWindPanel() {
  document.getElementById('windEnabled').addEventListener('change', (e) => {
    wind.enabled = e.target.checked;
  });
  document.getElementById('windSpeed').addEventListener('input', (e) => {
    wind.speed = parseFloat(e.target.value) || 0;
    document.getElementById('windSpeedLabel').textContent = wind.speed.toFixed(0) + ' m/s';
  });
  document.getElementById('windDir').addEventListener('input', (e) => {
    wind.directionDeg = parseFloat(e.target.value) || 0;
    document.getElementById('windDirLabel').textContent = wind.directionDeg.toFixed(0) + '°';
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
    const label = b.isActive ? 'Active' : ('Discarded ' + i);
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
        flashLegsWarning(safety.ascending ? 'Ascending — can\'t deploy' : 'Too fast — can\'t deploy');
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
    simRunning = true; simPaused = false;
    WorkerBridge.send({ type: 'start' });
    updateStatusBar();
  });

  document.getElementById('btnStop').addEventListener('click', () => {
    simRunning = false;
    WorkerBridge.send({ type: 'stop' });
    updateStatusBar();
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    simRunning = false; simPaused = false;
    WorkerBridge.send({ type: 'reset', alt: 0 });
    renderMergeDiagram(); renderOctaSliders();
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
    const idx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex))
      ? camera.followBodyIndex : state.activeBodyIndex;
    WorkerBridge.send({ type: 'takeControl', idx });
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

  bindTimeWarp();
}

function bindTimeWarp() {
  document.querySelectorAll('.warp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.warp-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const v = parseFloat(btn.dataset.warp) || 1;
      WorkerBridge.send({ type: 'warp', value: v });
    });
  });
}

  

function canSeparateNow() {
  if (state.crashed) return false;
  const active = state.bodies[state.activeBodyIndex];
  return !!(active && active.members && active.members.length >= 2);
}

function canSplitFairingNow() {
  if (state.crashed) return false;
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members) return false;
  return active.members.some(m => m.stageRole === 'payloadSpace');
}

function canReleasePayloadNow() {
  if (state.crashed) return false;
  const active = state.bodies[state.activeBodyIndex];
  if (!active || !active.members) return false;
  if (active.payloadReleased) return false;
  if (active.members.some(m => m.stageRole === 'payloadSpace')) return false;
  const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  return !!(stk && stk.payloadId);
}

function canTakeControlNow() {
  const idx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex))
    ? camera.followBodyIndex : state.activeBodyIndex;
  if (idx === state.activeBodyIndex) return false;
  const b = state.bodies[idx];
  if (!b) return false;
  // Only bodies with members (stack-based) can be actively controlled.
  // Free payload pieces have no engines to fire.
  return !!(b.members && b.members.length);
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
  const r = Math.hypot(state.rx, state.ry);
  const ux = state.rx / r, uy = state.ry / r; // local "up" (radial) unit vector
  const vr = state.vx * ux + state.vy * uy;   // + = ascending, - = descending
  const speed = Math.hypot(state.vx, state.vy);
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
  if (state.crashed) { dot.classList.add('crashed'); txt.textContent = 'CRASHED'; }
  else if (state.landed) { dot.classList.add('landed'); txt.textContent = 'LANDED'; }
  else if (simPaused) { dot.classList.add('paused'); txt.textContent = 'PAUSED'; }
  else if (simRunning) { dot.classList.add('running'); txt.textContent = 'RUNNING'; }
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

  b.engines.filter(e => !e.isCenter).forEach(e => {
    const val = (overrideValue !== undefined)
      ? Math.round(overrideValue * 100)
      : Math.round(((e.targetThrottle !== undefined ? e.targetThrottle : e.throttle) || 0) * 100);
    const input = document.querySelector(`.vslider[data-angle="${e.angleDeg}"]`);
    const label = document.getElementById('val-eng-' + e.angleDeg);
    if (input) input.value = val;
    if (label) label.textContent = val + '%';
  });

  const c = b.engines.find(e => e.isCenter);
  if (c) {
    const val = (overrideValue !== undefined)
      ? Math.round(overrideValue * 100)
      : Math.round(((c.targetThrottle !== undefined ? c.targetThrottle : c.throttle) || 0) * 100);
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
  const off  = document.getElementById('btnEngineOff');

  if (full) full.addEventListener('click', () => {
    WorkerBridge.send({ type: 'setAllThrottle', value: 1 });
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
function canFuelNow() {
  if (state.crashed) return false;
  const r = Math.hypot(state.rx, state.ry);
  const alt = r - CONFIG.EARTH_RADIUS;
  
  // Surface-relative speed, NOT inertial. Inertial speed on the pad is
  // ~465 m/s (Earth's rotation) — comparing against 0.5 would never pass.
  const sv = (typeof earthSurfaceVelocity === 'function') ?
    earthSurfaceVelocity(state.rx, state.ry) :
    { vx: 0, vy: 0 };
  const speedRel = Math.hypot(state.vx - sv.vx, state.vy - sv.vy);
  
  const b = state.bodies && state.bodies[state.activeBodyIndex];
  const enginesOff = b && b.engines ?
    b.engines.every(e => (e.targetThrottle || 0) < 0.001 && (e.throttle || 0) < 0.001) :
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
      const fuelMass = b ? (b.fuelMass || 0) : 0;
      const pct = CONFIG.FUEL_MASS_MAX > 0
        ? Math.round((fuelMass / CONFIG.FUEL_MASS_MAX) * 100) : 0;
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
    const val = (CONFIG.FUEL_MASS_MAX || 0) * (pct / 100);
    WorkerBridge.send({ type: 'setFuelMass', value: val });
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
  set('fuelReadMass', _fmtKg(b.fuelMass || 0));
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