// ============================================================================
// controls.js — All user-input handling: main thrust slider, center gimbal
// CW/ACW buttons, 4x4 octaweb vertical sliders, RCS 8-direction + rotation
// buttons, wind panel, merge-diagram interactions, panel toggles.
// ============================================================================

let simRunning = false;
let simPaused = false;

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
  group.angles.forEach(a => {
    const e = getEngine(a);
    if (e) e.targetThrottle = value;
  });
}

// PHASE 2: primary-engine throttle. "Primary" = whatever the active engine
// layout marks role:'center' (today always exactly one — the octaweb's core
// engine — but this filters rather than assumes a single match, so a future
// layout with more than one center-role slot works without changes here).
function setCenterThrottle(value) {
  ENGINES.filter(e => e.isCenter).forEach(e => { e.targetThrottle = value; });
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
    console.warn('setCenterGimbalTarget: active engine layout has no shared gimbal slider (per-engine gimbal UI not implemented yet) — ignoring.');
    return;
  }
  const clamped = Math.max(-CONFIG.GIMBAL_MAX_DEG, Math.min(CONFIG.GIMBAL_MAX_DEG, deg));
  ENGINES.filter(e => e.gimbal).forEach(e => { e.targetGimbalDeg = clamped; });
}

// ---------------------------------------------------------------------------
// RCS button bindings — each of the 8 directions + CW/ACW
// ---------------------------------------------------------------------------
function bindRCSButton(el, key) {
  function on(e) { e.preventDefault(); rcsCmd[key] = true; el.classList.add('active'); }
  function off() { rcsCmd[key] = false; el.classList.remove('active'); }
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
const camera = { follow: true, zoom: 25, followBodyIndex: 0 };

function bindCameraControls() {
  document.getElementById('btnFollow').addEventListener('click', () => {
    camera.follow = true;
    document.getElementById('btnFollow').classList.add('active');
    document.getElementById('btnFree').classList.remove('active');
  });
  document.getElementById('btnFree').addEventListener('click', () => {
    camera.follow = false;
    document.getElementById('btnFree').classList.add('active');
    document.getElementById('btnFollow').classList.remove('active');
  });
  const sel = document.getElementById('followBodySelect');
if (sel) {
  sel.addEventListener('change', (e) => {
    camera.followBodyIndex = parseInt(e.target.value, 10) || 0;
    camera.follow = true;
    document.getElementById('btnFollow').classList.add('active');
    document.getElementById('btnFree').classList.remove('active');
  });
}
  document.getElementById('btnZoomIn').addEventListener('click', () => { camera.zoom = Math.min(25, camera.zoom * 1.25); });
  document.getElementById('btnZoomOut').addEventListener('click', () => { camera.zoom = Math.max(0.08, camera.zoom / 1.25); });
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

// ---------------------------------------------------------------------------
// Start / Stop / Reset
// ---------------------------------------------------------------------------
function bindSimControls() {
  document.getElementById('btnStart').addEventListener('click', () => { simRunning = true; simPaused = false; updateStatusBar(); });
  document.getElementById('btnStop').addEventListener('click', () => { simRunning = false; updateStatusBar(); });
  document.getElementById('btnReset').addEventListener('click', () => {
    simRunning = false; simPaused = false;
    resetState(0); // start 500m up by default for now (no launch-pad phase yet)
    renderMergeDiagram(); renderOctaSliders();
    updateStatusBar();
  });
  const sepBtn = document.getElementById('btnSeparate');
if (sepBtn) sepBtn.addEventListener('click', () => {
  if (separateActiveBody()) {
    refreshFollowBodySelect();
    updateStatusBar();
  }
});
const tcBtn = document.getElementById('btnTakeControl');
if (tcBtn) tcBtn.addEventListener('click', () => {
  const idx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex))
    ? camera.followBodyIndex : state.activeBodyIndex;
  if (takeControlOfBody(idx)) {
    updateLegsButton();
    updateStatusBar();
    refreshFollowBodySelect();
  }
});

const fairBtn = document.getElementById('btnSplitFairing');
if (fairBtn) fairBtn.addEventListener('click', () => {
  if (splitFairingOnActiveBody()) {
    refreshFollowBodySelect();
    updateStatusBar();
  }
});
const plBtn = document.getElementById('btnReleasePayload');
if (plBtn) plBtn.addEventListener('click', () => {
  if (releasePayloadOnActiveBody()) {
    refreshFollowBodySelect();
    updateStatusBar();
  }
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
    legs.deployed = !legs.deployed;
    updateLegsButton();
  });
}

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

function canFuelNow() {
  if (state.crashed) return false;
  const r = Math.hypot(state.rx, state.ry);
  const alt = r - CONFIG.EARTH_RADIUS;
  const speed = Math.hypot(state.vx, state.vy);
  const enginesOff = ENGINES.every(e =>
    (e.targetThrottle || 0) < 0.001 && (e.throttle || 0) < 0.001);
  const nearPad = Math.abs(state.rx) < 30;
  return alt < 1.5 && speed < 0.5 && enginesOff && nearPad;
}

function _fmtKg(kg) {
  return (kg >= 1000) ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg';
}
function _fmtKN(n) {
  return (n / 1000).toFixed(0) + ' kN';
}

function syncThrottleUI() {
  ENGINES.filter(e => !e.isCenter).forEach(e => {
    const val = Math.round(((e.targetThrottle !== undefined ? e.targetThrottle : e.throttle) || 0) * 100);
    const input = document.querySelector(`.vslider[data-angle="${e.angleDeg}"]`);
    const label = document.getElementById('val-eng-' + e.angleDeg);
    if (input) input.value = val;
    if (label) label.textContent = val + '%';
  });
  const c = ENGINES.find(e => e.isCenter);
  if (c) {
    const val = Math.round(((c.targetThrottle !== undefined ? c.targetThrottle : c.throttle) || 0) * 100);
    const slider = document.getElementById('centerThrustSlider');
    const valEl = document.getElementById('centerThrustValue');
    if (slider) slider.value = val;
    if (valEl) valEl.textContent = val + '%';
  }
}

function bindQuickThrottle() {
  const full = document.getElementById('btnFullThrottle');
  const off  = document.getElementById('btnEngineOff');
  if (full) full.addEventListener('click', () => {
    ENGINES.forEach(e => { e.targetThrottle = 1; });
    syncThrottleUI();
  });
  if (off) off.addEventListener('click', () => {
    ENGINES.forEach(e => { e.targetThrottle = 0; });
    syncThrottleUI();
  });
}

function bindFuelPanel() {
  const btn = document.getElementById('btnFuelPanel');
  const slider = document.getElementById('fuelSlider');
  if (!btn || !slider) return;
  btn.addEventListener('click', () => {
    const panel = document.getElementById('fuelPanel');
    const opening = !panel || panel.style.display !== 'block';
    if (opening) {
      // Initialize slider to current fuel load on open.
      const pct = CONFIG.FUEL_MASS_MAX > 0
        ? Math.round((state.fuelMass / CONFIG.FUEL_MASS_MAX) * 100) : 0;
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
    state.fuelMass = (CONFIG.FUEL_MASS_MAX || 0) * (pct / 100);
    document.getElementById('fuelPercentLabel').textContent = Math.round(pct) + '%';
    updateFuelPanelReadouts();
  });
}

function updateFuelPanelReadouts() {
  const panel = document.getElementById('fuelPanel');
  if (!panel || panel.style.display !== 'block') return;
  const geom = currentGeometry();
  const maxThrust = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const g0 = (typeof G0 !== 'undefined') ? G0 : 9.80665;
  const weight = geom.M * g0;
  const twr = weight > 0 ? maxThrust / weight : 0;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('fuelReadMass', _fmtKg(state.fuelMass));
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

// Called every frame from main.js — shows/hides the Fueling toolbar button
// and closes the panel if the rocket is no longer at the pad.
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