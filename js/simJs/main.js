// ============================================================================
// main.js — App bootstrap: wires every module together and runs the
// fixed-timestep animation loop.
// ============================================================================

const MERGE_COLORS = ['#ff8855', '#55ddff', '#aa88ff', '#88ff99', '#ffdd55', '#ff66cc', '#66ffcc'];

function groupColorOf(groupName) {
  const gi = mergeState.groups.findIndex(g => g.name === groupName);
  return MERGE_COLORS[gi % MERGE_COLORS.length];
}

function renderMergeDiagram() {
  const svg = document.getElementById('mergeSvg');
  const cx = 90, cy = 90, R = 65;
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
  const right = [], left = [];
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
  leftHost.innerHTML = ''; rightHost.innerHTML = '';

  function buildSlider(angle, host) {
    const engine = getEngine(angle);
    const group = angleGroupOf(angle);
    const color = groupColorOf(group.name);
    const startVal = Math.round((engine.targetThrottle !== undefined ? engine.targetThrottle : engine.throttle) * 100);

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
    resetMerges(); selectedForMerge = [];
    renderMergeDiagram(); renderOctaSliders();
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
    rcsN: 'N', rcsS: 'S', rcsE: 'E', rcsW: 'W',
    rcsNE: 'NE', rcsNW: 'NW', rcsSE: 'SE', rcsSW: 'SW',
    rcsCW: 'CW', rcsACW: 'ACW',
  };
  Object.entries(map).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) bindRCSButton(el, key);
  });
}

function bindMiscToggles() {
  document.getElementById('toggleGrid').addEventListener('change', (e) => { showGrid = e.target.checked; });
  document.getElementById('toggleVectors').addEventListener('change', (e) => { showVectors = e.target.checked; });

  document.getElementById('btnSidePanel').addEventListener('click', () => togglePanel('sidePanel'));
  document.getElementById('btnWindPanel').addEventListener('click', () => togglePanel('windPanel'));
  document.getElementById('btnGraphPanel').addEventListener('click', () => togglePanel('graphPanel'));
  document.getElementById('btnMergePanel').addEventListener('click', () => togglePanel('mergePanel'));
  document.getElementById('btnGlossary').addEventListener('click', () => togglePanel('glossaryPanel'));

  document.querySelectorAll('.panel-close').forEach(btn => {
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
  frameDt = Math.min(frameDt, 0.1); // clamp huge gaps (tab switch etc.)

  if (simRunning && !simPaused && !state.crashed) {
    accumulator += frameDt;
    while (accumulator >= CONFIG.DT) {
      physicsStep(CONFIG.DT);
      accumulator -= CONFIG.DT;
    }
  }

  // Landing legs are ground-support-equipment style controls (like deploying
  // them while parked on the pad before launch) — they animate on real
  // elapsed time regardless of whether the simulation itself is running or
  // paused, unlike the physics state above.
  updateLegs(frameDt);

  renderFrame();
  drawFigurePanel();
  drawBasalView();
  drawGraphs();
  updateTelemetry();
  updateStatusBar();

  requestAnimationFrame(frame);
}

function bootstrap() {
  buildEngineLayout();
  resetState(0); // Start on the pad — rocket's base resting on the elevated landing/launch site deck

  initCanvas();
  initFigureCanvas();
  initBasalCanvas();

  bindSimControls();
  bindLegsControl();
  bindCenterControls();
  bindRCSControls();
  bindMergeControls();
  bindCameraControls();
  bindWindPanel();
  bindMiscToggles();

  buildGlossaryPanel();
  renderMergeDiagram();
  renderOctaSliders();
  updateStatusBar();

  requestAnimationFrame(frame);
}

window.addEventListener('DOMContentLoaded', bootstrap);
