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
// Octaweb 5-slider control (4 default pair-groups + center)
// ---------------------------------------------------------------------------
function setGroupThrottle(group, value) {
  group.angles.forEach(a => {
    const e = getEngine(a);
    if (e) e.targetThrottle = value;
  });
}

function setCenterThrottle(value) {
  const c = ENGINES.find(e => e.isCenter);
  if (c) c.targetThrottle = value;
}

function setCenterGimbalTarget(deg) {
  const c = ENGINES.find(e => e.isCenter);
  if (c) c.targetGimbalDeg = Math.max(-CONFIG.GIMBAL_MAX_DEG, Math.min(CONFIG.GIMBAL_MAX_DEG, deg));
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
const camera = { follow: true, zoom: 25 };

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
  document.getElementById('btnZoomIn').addEventListener('click', () => { camera.zoom = Math.min(25, camera.zoom * 1.25); });
  document.getElementById('btnZoomOut').addEventListener('click', () => { camera.zoom = Math.max(0.08, camera.zoom / 1.25); });
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
  if (!btn) return;
  btn.addEventListener('click', () => {
    legs.deployed = !legs.deployed;
    updateLegsButton();
  });
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
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = 'status-dot';
  if (state.crashed) { dot.classList.add('crashed'); txt.textContent = 'CRASHED'; }
  else if (simPaused) { dot.classList.add('paused'); txt.textContent = 'PAUSED'; }
  else if (simRunning) { dot.classList.add('running'); txt.textContent = 'RUNNING'; }
  else { txt.textContent = 'STOPPED'; }

  const t = state.simTime;
  const mm = Math.floor(t / 60).toString().padStart(2, '0');
  const ss = (t % 60).toFixed(1).padStart(4, '0');
  document.getElementById('missionClock').textContent = `T+${mm}:${ss}`;
}
