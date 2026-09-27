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
// ============================================================================
// Member viewer — scroll through every member of the ACTIVE stack. Each
// slide draws ONE member alone (its own artwork + its own specs), so a
// scroll from bottom to top walks the actual vehicle build the sim is
// flying. Dots below the canvas mark which member is currently shown.
//
// The heading above stays as the stack name (the container), and the
// label under the art shows the member's own name plus its stack
// position (e.g. "2/3 · Falcon 9 Upper Stage").
// ============================================================================
let _previewMembers = [];
let _previewIdx = 0;
let _previewStackName = '';

function _loadPreviewMembers() {
  const activeStk = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  const fleet = (typeof loadFleet === 'function') ? loadFleet() : [];
  if (!activeStk || !Array.isArray(activeStk.members) || !activeStk.members.length) {
    // No stack at all — fall back to whichever single record the fleet
    // considers the legacy default, so the panel isn't blank.
    const legacy = fleet.find(r => r.id === 'falcon9-default') || fleet[0];
    return { members: legacy ? [legacy] : [], stackName: legacy ? legacy.name : '—' };
  }
  const members = activeStk.members
    .map(id => fleet.find(r => r.id === id))
    .filter(Boolean);
  return { members, stackName: activeStk.name };
}

// Per-member hardware + derived spec bag. aboveMember is only used by the
// booster path (its interstage sizing depends on the stage stacked above
// it) — pass null for a standalone preview.
function _memberStatsFor(m, aboveMember) {
  if (!m) return null;
  const role = m.stageRole || 'rocket';
  const G0 = 9.80665;
  const P_sl = (typeof CONFIG !== 'undefined' && Number.isFinite(CONFIG.SEA_LEVEL_PRESSURE))
    ? CONFIG.SEA_LEVEL_PRESSURE : 101325;

  const out = {
    height: Number.isFinite(m.height) ? m.height : 0,
    width: Number.isFinite(m.width) ? m.width : 0,
    dryMass: 0,
    fuelMass: 0,
    engineCount: 0,
    perEngineThrust: 0,
      totalThrust: 0,
    ispSl: 0,
    ispVac: 0,
    veSl: 0,
    veVac: 0,
    rcsText: '—',
  };

  // ---- Dry mass + fuel capacity, per role ----
  if (role === 'booster' && typeof boosterDerivedMasses === 'function') {
    const d = boosterDerivedMasses(m, aboveMember || null);
    if (d) { out.dryMass = d.dryMass; out.fuelMass = d.fuelMass; }
  } else if (role === 'stage' && typeof stageDerivedMasses === 'function') {
    const d = stageDerivedMasses(m);
    if (d && !d.infeasible) { out.dryMass = d.dryMassNoPayload; out.fuelMass = d.fuelMass; }
  } else if (role === 'nose' && typeof computeNoseDryMass === 'function') {
    out.dryMass = computeNoseDryMass(m);
  } else if (role === 'payloadSpace' && typeof computePayloadSpaceDryMass === 'function') {
    out.dryMass = computePayloadSpaceDryMass(m);
  } else {
    out.dryMass = Number.isFinite(m.dryMass) ? m.dryMass : 0;
    out.fuelMass = Number.isFinite(m.fuelMassMax) ? m.fuelMassMax : 0;
  }

  // ---- Engine geometry ----
  let layout = null;
  if (m.engineTypeId && typeof getComponentType === 'function') {
    layout = getComponentType(m.engineTypeId);
    if (layout && layout.frame && Array.isArray(layout.frame.slots)) {
      out.engineCount = layout.frame.slots.length;
    }
  }

  // ---- Thrust + Isp from whichever thruster groups this member carries ----
  if (m.engineThrusters && layout && typeof engineThrusterGroups === 'function') {
    const groups = engineThrusterGroups(layout);
    let thrustSum = 0, thrustCount = 0;
let ispSlWeighted = 0, ispVacWeighted = 0, ispCount = 0;
let veSlWeighted = 0, veVacWeighted = 0;
Object.keys(m.engineThrusters).forEach(gk => {
  const g = m.engineThrusters[gk];
  const count = groups[gk] ? groups[gk].length : 0;
  if (!g || !count) return;
  const t = (typeof getComponentType === 'function') ? getComponentType(g.thrusterTypeId) : null;
  if (!t) return;
  const veVac = (t.parameterSchema.find(p => p.key === 'veVacuum') || {}).value;
  const penalty = (t.parameterSchema.find(p => p.key === 'atmosphericPenalty') || {}).value;
  if (!Number.isFinite(veVac) || !Number.isFinite(g.massFlowRate)) return;
  // Per-engine thrust uses VACUUM Ve — the build-time reference
  // number. Live in-sim thrust varies with altitude (physics.js
  // updates e.Ve per tick); the home page shows the upper bound.
  const perEngineF_vac = g.massFlowRate * veVac;
  thrustSum += perEngineF_vac * count;
  thrustCount += count;
  // Ve range: vac (upper) and SL (lower, from atmosphericPenalty).
  let veSl = veVac;
  if (Number.isFinite(penalty)) {
    veSl = Math.max(0, veVac - penalty * P_sl);
  }
  // Isp is just Ve / g0 — same range, scaled.
  const ispVac = veVac / G0;
  const ispSl = veSl / G0;
  ispSlWeighted += ispSl * count;
  ispVacWeighted += ispVac * count;
  veSlWeighted += veSl * count;
  veVacWeighted += veVac * count;
  ispCount += count;
});
out.totalThrust = thrustSum;
out.perEngineThrust = thrustCount > 0 ? thrustSum / thrustCount : 0;
out.ispSl = ispCount > 0 ? ispSlWeighted / ispCount : 0;
out.ispVac = ispCount > 0 ? ispVacWeighted / ispCount : 0;
out.veSl = ispCount > 0 ? veSlWeighted / ispCount : 0;
out.veVac = ispCount > 0 ? veVacWeighted / ispCount : 0;
  }

  // ---- RCS pods text ----
  if (m.rcsTypeId && typeof getComponentType === 'function') {
    const rt = getComponentType(m.rcsTypeId);
    if (rt && rt.frame && Array.isArray(rt.frame.pods)) {
      out.rcsText = rt.frame.pods.length + ' pods (2 nozzles each)';
    }
  }

  return out;
}

// Adapter — drawRocketArt / renderVehiclePreview read their opts names off
// a flat object, but a fleet record carries its per-engine geometry under
// `params`, and the payloadSpace's shape under the payloadSpaceType's own
// params bag. This flattens it, same shape previewVehicleFor in
// rockets-core.js builds.
function _previewVehicleFor(m) {
  const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ?
    getComponentType(m.engineTypeId) : null;
  const psType = (m.stageRole === 'payloadSpace' && m.payloadSpaceTypeId &&
    typeof getComponentType === 'function') ? getComponentType(m.payloadSpaceTypeId) : null;
  const psParams = m.params || {};
  return {
    height: m.height,
    width: m.width,
    rcsTopY: m.params ? m.params.rcsTopY : undefined,
    rcsBottomY: m.params ? m.params.rcsBottomY : undefined,
    recoveryTypeId: m.hasRecovery === false ? null : m.recoveryTypeId,
    rcsTypeId: m.rcsTypeId,
    stageRole: m.stageRole,
    noseCurveness: m.noseCurveness,
    bodyDesign: m.bodyDesign,
    payloadSpaceColor: (m.payloadSpace && m.payloadSpace.color) ? m.payloadSpace.color : undefined,
    stagePayload: (typeof buildStagePayload === 'function') ? buildStagePayload(m) : null,
    engineLayout,
    engineThrusters: m.engineThrusters,
    params: m.params,
    payloadKind: psType ? psType.kind : undefined,
    payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
    payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
    payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
    payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
    payloadColor: (m.stageRole === 'payloadSpace') ? (m.color || '#e9edf2') : undefined,
  };
}

function _renderPreviewMember() {
  const m = _previewMembers[_previewIdx];
  if (!m) return;
  const above = _previewMembers[_previewIdx + 1] || null;
  const stats = _memberStatsFor(m, above);

  // Heading = the stack's own name (container identity).
  document.getElementById('vehicleName').textContent = _previewStackName || m.name;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('specHeight',   (stats.height || 0).toFixed(1) + ' m');
  set('specWidth',    (stats.width  || 0).toFixed(1) + ' m');
  set('specDry',      fmtMass(stats.dryMass));
  set('specFuel',     fmtMass(stats.fuelMass));
  set('specEngines',  stats.engineCount > 0 ? String(stats.engineCount) : '—');
  set('specThrustEach',  stats.perEngineThrust > 0 ? fmtForce(stats.perEngineThrust) + ' (vac)' : '—');
  set('specThrustTotal', stats.totalThrust   > 0 ? fmtForce(stats.totalThrust) + ' (vac)' : '—');
  // Isp range: SL (lower) to Vac (upper). Whole numbers only. If a member
  // carries no engines (nose, fairing, bare stage), both are 0 → "—".
  // Isp range: SL (lower) to Vac (upper). Whole numbers only. If a member
// carries no engines (nose, fairing, bare stage), both are 0 → "—".
if (stats.ispVac > 0) {
  const slRounded = Math.round(stats.ispSl);
  const vacRounded = Math.round(stats.ispVac);
  // If SL and Vac round to the same number (small penalty), show once.
  set('specIsp', slRounded === vacRounded ? (vacRounded + ' s') :
    (slRounded + ' – ' + vacRounded + ' s'));
} else {
  set('specIsp', '—');
}
// Ve range — same SL → Vac span, in m/s. Approximate (~ prefix) since
// these are the build-time reference bounds; live in-sim Ve varies per
// tick with actual ambient pressure. Whole numbers for readability.
if (stats.veVac > 0) {
  const slRounded = Math.round(stats.veSl);
  const vacRounded = Math.round(stats.veVac);
  set('specVe', slRounded === vacRounded ? ('~' + vacRounded + ' m/s') :
    ('~' + slRounded + ' – ' + vacRounded + ' m/s'));
} else {
  set('specVe', '—');
}
set('specRcs', stats.rcsText);

  // Name label under art — member name plus stack position.
  const nameLabel = document.getElementById('stackName');
  if (nameLabel) {
    const pos = (_previewMembers.length > 1) ?
      ((_previewIdx + 1) + '/' + _previewMembers.length + ' · ') : '';
    nameLabel.textContent = pos + m.name;
    nameLabel.classList.toggle('is-active', true); // every member IS part of the flying stack
  }

  // Dots — one per member. Active-stack marker no longer applies (the
  // whole list IS the active stack); the elongated "current" dot just
  // indicates which member is on screen.
  const dotsEl = document.getElementById('stackDots');
  if (dotsEl) {
    if (_previewMembers.length <= 1) {
      dotsEl.innerHTML = '';
    } else {
      dotsEl.innerHTML = _previewMembers.map((mm, i) => {
        const cls = 'stack-dot' + (i === _previewIdx ? ' active' : '');
        const safeName = String(mm.name).replace(/"/g, '&quot;');
        return `<div class="${cls}" data-idx="${i}" title="${safeName}"></div>`;
      }).join('');
    }
  }

  // Draw just this one member.
  const canvas = document.getElementById('shipArt');
  if (canvas && typeof renderVehiclePreview === 'function') {
    renderVehiclePreview(canvas, _previewVehicleFor(m));
  }

  // Ticker — unchanged semantics: fleet size + the FLYING stack's bottom
  // engine stats (the numbers the sim actually flies with). Member
  // navigation doesn't affect it.
  const fleetSize = (typeof loadFleet === 'function') ? loadFleet().length : 1;
  const bottom = _previewMembers[0] || null;
  const tickerEl = document.getElementById('tickerText');
  if (tickerEl && bottom) {
    const bStats = _memberStatsFor(bottom, _previewMembers[1] || null);
    tickerEl.innerHTML =
      `<span class="accent">${fleetSize}</span> vehicle${fleetSize === 1 ? '' : 's'} in fleet &nbsp;·&nbsp; ` +
      `flying <span class="accent">${_previewStackName}</span> &nbsp;·&nbsp; ` +
      `${bStats.engineCount} engines &nbsp;·&nbsp; ${fmtForce(bStats.totalThrust)} total thrust (vac)`;
  }
}

function _cyclePreview(dir) {
  if (_previewMembers.length < 2) return;
  _previewIdx = (_previewIdx + dir + _previewMembers.length) % _previewMembers.length;
  _renderPreviewMember();
}

function _initStackViewer() {
  const loaded = _loadPreviewMembers();
  _previewMembers = loaded.members;
  _previewStackName = loaded.stackName;
  _previewIdx = 0; // start on the bottom member (the booster)

  _renderPreviewMember();

  const viewer = document.getElementById('stackViewer');
  if (!viewer) return;

  // Mouse wheel — one member per notch, page-scroll suppressed while
  // hovering the viewer.
  viewer.addEventListener('wheel', (e) => {
    if (_previewMembers.length < 2) return;
    e.preventDefault();
    _cyclePreview(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // Touch swipe (vertical drag).
  let touchY = 0, touchActive = false;
  viewer.addEventListener('touchstart', (e) => {
    if (_previewMembers.length < 2) return;
    touchY = e.touches[0].clientY;
    touchActive = true;
  }, { passive: true });
  viewer.addEventListener('touchend', (e) => {
    if (!touchActive) return;
    touchActive = false;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dy) > 30) _cyclePreview(dy < 0 ? 1 : -1);
  }, { passive: true });

  // Dot click.
  const dotsEl = document.getElementById('stackDots');
  if (dotsEl) {
    dotsEl.addEventListener('click', (e) => {
      const t = e.target.closest('.stack-dot');
      if (!t) return;
      const idx = parseInt(t.dataset.idx, 10);
      if (Number.isInteger(idx) && idx !== _previewIdx) {
        _previewIdx = idx;
        _renderPreviewMember();
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