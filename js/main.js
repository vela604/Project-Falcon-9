// ============================================================================
// main.js — App bootstrap: wires every module together and runs the
// fixed-timestep animation loop.
// ============================================================================

function renderMergeDiagram() {
  const svg = document.getElementById('mergeSvg');
  const cx = 90, cy = 90, R = 65;
  const colors = ['#ff8855', '#55ddff', '#aa88ff', '#88ff99', '#ffdd55', '#ff66cc', '#66ffcc'];
  let html = `<circle cx="${cx}" cy="${cy}" r="${R+14}" fill="none" stroke="#22344a" stroke-width="1"/>`;

  mergeState.groups.forEach((g, gi) => {
    const color = colors[gi % colors.length];
    g.angles.forEach(a => {
      const rad = a * Math.PI / 180;
      const ex = cx + Math.cos(rad) * R;
      const ey = cy - Math.sin(rad) * R;
      const isSelected = selectedForMerge.includes(g.name);
      html += `<circle cx="${ex}" cy="${ey}" r="9" fill="${color}" stroke="${isSelected ? '#fff' : '#111'}" stroke-width="${isSelected?3:1}" class="engine-dot" data-angle="${a}" style="cursor:pointer;"/>`;
    });
  });
  // Center engine
  html += `<circle cx="${cx}" cy="${cy}" r="11" fill="#ffcc00" stroke="#222" stroke-width="1.5"/>`;
  html += `<text x="${cx}" y="${cy+3}" font-size="8" text-anchor="middle" fill="#222">C</text>`;

  svg.innerHTML = html;
  svg.querySelectorAll('.engine-dot').forEach(dot => {
    dot.addEventListener('click', () => handleEngineDotClick(parseInt(dot.dataset.angle)));
  });

  // Group legend + count
  const legend = document.getElementById('mergeLegend');
  legend.innerHTML = mergeState.groups.map((g, gi) =>
    `<div class="legend-row"><span class="legend-dot" style="background:${colors[gi % colors.length]}"></span>${g.name} (${g.angles.length} engines)</div>`
  ).join('');
}

function renderOctaSliders() {
  const leftHost = document.getElementById('slidersLeft');
  const rightHost = document.getElementById('slidersRight');
  leftHost.innerHTML = ''; rightHost.innerHTML = '';

  const groups = mergeState.groups;
  const half = Math.ceil(groups.length / 2);
  groups.forEach((g, i) => {
    const host = i < half ? leftHost : rightHost;
    const wrap = document.createElement('div');
    wrap.className = 'vslider-wrap';
    wrap.innerHTML = `
      <div class="vslider-label">${g.name}</div>
      <input type="range" min="0" max="100" value="0" class="vslider" data-group="${g.name}">
      <div class="vslider-value" id="val-${g.name}">0%</div>
    `;
    host.appendChild(wrap);
    wrap.querySelector('input').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value) / 100;
      setGroupThrottle(g, v);
      document.getElementById('val-' + g.name).textContent = Math.round(v*100) + '%';
    });
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
    const c = ENGINES.find(e => e.isCenter);
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
  resetState(500); // Phase-1 default: start airborne at 500m, no launch-pad phase yet

  initCanvas();
  initFigureCanvas();
  initBasalCanvas();

  bindSimControls();
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
