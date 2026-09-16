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

function populateVehicleCard() {
  const stack = (typeof getActiveStack === 'function') ? getActiveStack() : null;
  const members = (typeof getActiveStackMembers === 'function') ? getActiveStackMembers() : [];
  const agg = (typeof stackCombinedAggregates === 'function') ? stackCombinedAggregates(stack) : null;
  
  const engineCount = (CONFIG.ENGINE_LAYOUT && CONFIG.ENGINE_LAYOUT.frame && CONFIG.ENGINE_LAYOUT.frame.slots) ?
    CONFIG.ENGINE_LAYOUT.frame.slots.length : 9;
  const totalMaxThrust = (CONFIG.ENGINE_F_MAX || 0) * engineCount;
  
  document.getElementById('vehicleName').textContent = stack ? stack.name : CONFIG.ROCKET_NAME;
  document.getElementById('specHeight').textContent = (agg ? agg.height : CONFIG.ROCKET_HEIGHT) + ' m';
  document.getElementById('specWidth').textContent = (agg ? agg.width : CONFIG.ROCKET_WIDTH) + ' m';
  document.getElementById('specDry').textContent = fmtMass(agg ? agg.dryMass : CONFIG.DRY_MASS);
  document.getElementById('specFuel').textContent = fmtMass(agg ? agg.fuelMass : CONFIG.FUEL_MASS_MAX);
  document.getElementById('specEngines').textContent = engineCount + ' (bottom stage)';
  document.getElementById('specThrustEach').textContent = fmtForce(CONFIG.ENGINE_F_MAX) + ' max';
  document.getElementById('specThrustTotal').textContent = fmtForce(totalMaxThrust);
  document.getElementById('specVe').textContent = CONFIG.ENGINE_VE.toLocaleString() + ' m/s';
  document.getElementById('specRcs').textContent = '4 pods (2 nozzles each)';
  
  // Stack preview (uses renderStackPreview, moved into rocketArt.js).
  if (typeof renderStackPreview === 'function' && stack) {
    renderStackPreview(document.getElementById('shipArt'), stack.members);
  } else {
    renderVehiclePreview(document.getElementById('shipArt'));
  }
  
  const fleetSize = (typeof loadFleet === 'function') ? loadFleet().length : 1;
  const tickerEl = document.getElementById('tickerText');
  tickerEl.innerHTML =
    `<span class="accent">${fleetSize}</span> vehicle${fleetSize === 1 ? '' : 's'} in fleet &nbsp;·&nbsp; ` +
    `flying <span class="accent">${CONFIG.ROCKET_NAME}</span> &nbsp;·&nbsp; ` +
    `${engineCount} engines &nbsp;·&nbsp; ${fmtForce(totalMaxThrust)} total thrust`;
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
  populateVehicleCard();
  startClock();
});