// ============================================================================
// home.js — Populates the mission-console home page from CONFIG (config.js).
// Once the Vehicle Fleet page exists, this will read the *selected* saved
// rocket instead of CONFIG directly — same idea as simulation.html.
// ============================================================================

function fmtMass(kg) {
  return kg >= 1000 ? (kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' t' : kg + ' kg';
}

function fmtForce(n) {
  return (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' kN';
}

// ============================================================================
// Stack viewer — scroll through every saved stack in the hangar panel.
// Wheel over the canvas (or swipe on mobile, or tap the dots) cycles
// through all stacks. The active stack gets a green marker dot; the
// currently-viewed one gets an elongated ember dot.
// ============================================================================
let _previewStacks = [];
let _previewIdx = 0;

function _loadPreviewStacks() {
  const stacks = (typeof loadStacks === 'function') ? loadStacks() : [];
  if (stacks.length) {
    return stacks.map(s => ({
      id: s.id,
      name: s.name,
      members: Array.isArray(s.members) ? s.members.slice() : [],
      isImplicit: false,
    }));
  }
  // Fallback: no explicit stacks exist yet — show the sim's implicit
  // 1-member legacy stack so the viewer still has something to render.
  const active = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  if (!active) return [];
  return [{
    id: active.id,
    name: active.name,
    members: Array.isArray(active.members) ? active.members.slice() : [],
    isImplicit: true,
  }];
}

// Aggregate for an ARBITRARY member list — mirrors stackCombinedAggregates()
// but doesn't assume the active stack (that function reads
// getActiveStackMembers() internally, which is always the active stack).
function _aggregateForMembers(members) {
  let dryMass = 0, fuelMass = 0, height = 0, width = 0;
  members.forEach((m, i) => {
    height += Number.isFinite(m.height) ? m.height : 0;
    const w = Number.isFinite(m.width) ? m.width : 0;
    if (w > width) width = w;
    if (m.stageRole === 'booster') {
      const d = (typeof boosterDerivedMasses === 'function') ? boosterDerivedMasses(m, members[i + 1] || null) : null;
      if (d) { dryMass += d.dryMass; fuelMass += d.fuelMass; }
    } else if (m.stageRole === 'stage') {
      const d = (typeof stageDerivedMasses === 'function') ? stageDerivedMasses(m) : null;
      if (d && !d.infeasible) { dryMass += d.dryMassNoPayload; fuelMass += d.fuelMass; }
    } else if (m.stageRole === 'nose') {
      dryMass += (typeof computeNoseDryMass === 'function') ? computeNoseDryMass(m) : 0;
    } else if (m.stageRole === 'payloadSpace') {
      dryMass += (typeof computePayloadSpaceDryMass === 'function') ? computePayloadSpaceDryMass(m) : 0;
    } else {
      dryMass += Number.isFinite(m.dryMass) ? m.dryMass : 0;
      fuelMass += Number.isFinite(m.fuelMassMax) ? m.fuelMassMax : 0;
    }
  });
  return { height, width, dryMass, fuelMass };
}

// Engine stats read from the BOTTOM member of the given list (the booster
// doing the launch — same convention stackCombinedAggregates uses).
function _engineStatsFor(members) {
  const bottom = members[0] || null;
  if (!bottom) return { engineCount: 9, perEngineThrust: 0, ve: 0, rcsText: '—' };
  const engineType = (bottom.engineTypeId && typeof getComponentType === 'function')
    ? getComponentType(bottom.engineTypeId) : null;
  const engineCount = (engineType && engineType.frame && Array.isArray(engineType.frame.slots))
    ? engineType.frame.slots.length : 9;
  const perEngineThrust = (bottom.params && Number.isFinite(bottom.params.engineFMax))
    ? bottom.params.engineFMax : 0;
  const ve = (bottom.params && Number.isFinite(bottom.params.engineVe))
    ? bottom.params.engineVe : 0;
  
  let rcsText = '4 pods (2 nozzles each)';
  if (bottom.rcsTypeId && typeof getComponentType === 'function') {
    const rt = getComponentType(bottom.rcsTypeId);
    if (rt && rt.frame && Array.isArray(rt.frame.pods)) {
      rcsText = rt.frame.pods.length + ' pods (2 nozzles each)';
    }
  }
  return { engineCount, perEngineThrust, ve, rcsText };
}

function _renderPreviewStack() {
  const stk = _previewStacks[_previewIdx];
  if (!stk) return;
  const fleet = (typeof loadFleet === 'function') ? loadFleet() : [];
  const members = stk.members.map(id => fleet.find(r => r.id === id)).filter(Boolean);
  const agg = _aggregateForMembers(members);
  const { engineCount, perEngineThrust, ve, rcsText } = _engineStatsFor(members);
  const totalMaxThrust = perEngineThrust * engineCount;
  
  document.getElementById('vehicleName').textContent = stk.name;
  document.getElementById('specHeight').textContent = agg.height.toFixed(1) + ' m';
  document.getElementById('specWidth').textContent = agg.width.toFixed(1) + ' m';
  document.getElementById('specDry').textContent = fmtMass(agg.dryMass);
  document.getElementById('specFuel').textContent = fmtMass(agg.fuelMass);
  document.getElementById('specEngines').textContent = engineCount + ' (bottom stage)';
  document.getElementById('specThrustEach').textContent = fmtForce(perEngineThrust) + ' max';
  document.getElementById('specThrustTotal').textContent = fmtForce(totalMaxThrust);
  document.getElementById('specVe').textContent = ve.toLocaleString() + ' m/s';
  document.getElementById('specRcs').textContent = rcsText;
  
  if (typeof renderStackPreview === 'function' && stk.members.length) {
    renderStackPreview(document.getElementById('shipArt'), stk.members);
  } else if (typeof renderVehiclePreview === 'function') {
    renderVehiclePreview(document.getElementById('shipArt'));
  }
  
  // Name label + dots
  const nameLabel = document.getElementById('stackName');
  const activeId = (typeof getSelectedStackId === 'function') ? getSelectedStackId() : null;
  if (nameLabel) {
    nameLabel.textContent = stk.name;
    nameLabel.classList.toggle('is-active', stk.id === activeId);
  }
  const dotsEl = document.getElementById('stackDots');
  if (dotsEl) {
    if (_previewStacks.length <= 1) {
      dotsEl.innerHTML = '';
    } else {
      dotsEl.innerHTML = _previewStacks.map((s, i) => {
        const cls = 'stack-dot'
          + (i === _previewIdx ? ' active' : '')
          + (s.id === activeId ? ' is-active-stack' : '');
        const safeName = String(s.name).replace(/"/g, '&quot;');
        return `<div class="${cls}" data-idx="${i}" title="${safeName}"></div>`;
      }).join('');
    }
  }
  
  // Ticker — shows the ACTIVE stack (unchanged by preview navigation)
  const fleetSize = (typeof loadFleet === 'function') ? loadFleet().length : 1;
  const tickerEl = document.getElementById('tickerText');
  if (tickerEl) {
    tickerEl.innerHTML =
      `<span class="accent">${fleetSize}</span> vehicle${fleetSize === 1 ? '' : 's'} in fleet &nbsp;·&nbsp; ` +
      `flying <span class="accent">${CONFIG.ROCKET_NAME}</span> &nbsp;·&nbsp; ` +
      `${engineCount} engines &nbsp;·&nbsp; ${fmtForce(totalMaxThrust)} total thrust`;
  }
}

function _cyclePreview(dir) {
  if (_previewStacks.length < 2) return;
  _previewIdx = (_previewIdx + dir + _previewStacks.length) % _previewStacks.length;
  _renderPreviewStack();
}

function _initStackViewer() {
  _previewStacks = _loadPreviewStacks();
  // Start on the active stack if it's in the list; otherwise first
  const activeId = (typeof getSelectedStackId === 'function') ? getSelectedStackId() : null;
  const found = _previewStacks.findIndex(s => s.id === activeId);
  _previewIdx = found >= 0 ? found : 0;
  
  _renderPreviewStack();
  
  const viewer = document.getElementById('stackViewer');
  if (!viewer) return;
  
  // Mouse wheel — prevent page scroll while hovering the viewer
  viewer.addEventListener('wheel', (e) => {
    if (_previewStacks.length < 2) return;
    e.preventDefault();
    _cyclePreview(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  
  // Touch swipe (vertical drag)
  let touchY = 0, touchActive = false;
  viewer.addEventListener('touchstart', (e) => {
    if (_previewStacks.length < 2) return;
    touchY = e.touches[0].clientY;
    touchActive = true;
  }, { passive: true });
  viewer.addEventListener('touchend', (e) => {
    if (!touchActive) return;
    touchActive = false;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dy) > 30) _cyclePreview(dy < 0 ? 1 : -1);
  }, { passive: true });
  
  // Dot click
  const dotsEl = document.getElementById('stackDots');
  if (dotsEl) {
    dotsEl.addEventListener('click', (e) => {
      const t = e.target.closest('.stack-dot');
      if (!t) return;
      const idx = parseInt(t.dataset.idx, 10);
      if (Number.isInteger(idx) && idx !== _previewIdx) {
        _previewIdx = idx;
        _renderPreviewStack();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Mission clock — wall-clock elapsed since the page loaded, in the same
// "T+" spirit as the simulator's mission clock (this one just runs freely).
// ---------------------------------------------------------------------------
function startClock() {
  const start = performance.now();
  const el = document.getElementById('clock');
  
  function tick() {
    const s = Math.floor((performance.now() - start) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    el.textContent = `T ${hh}:${mm}:${ss}`;
    requestAnimationFrame(() => setTimeout(tick, 1000));
  }
  tick();
}

window.addEventListener('DOMContentLoaded', () => {
  _initStackViewer();
  startClock();
});