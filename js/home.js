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
  const engineCount = 9; // center + 8 octaweb, fixed for this vehicle class
  const totalMaxThrust = CONFIG.ENGINE_F_MAX * engineCount;

  document.getElementById('vehicleName').textContent = CONFIG.ROCKET_NAME;
  document.getElementById('specHeight').textContent = CONFIG.ROCKET_HEIGHT + ' m';
  document.getElementById('specWidth').textContent = CONFIG.ROCKET_WIDTH + ' m';
  document.getElementById('specDry').textContent = fmtMass(CONFIG.DRY_MASS);
  document.getElementById('specFuel').textContent = fmtMass(CONFIG.FUEL_MASS_MAX);
  document.getElementById('specEngines').textContent = engineCount + ' (octaweb + center)';
  document.getElementById('specThrustEach').textContent = fmtForce(CONFIG.ENGINE_F_MAX) + ' max';
  document.getElementById('specThrustTotal').textContent = fmtForce(totalMaxThrust);
  document.getElementById('specVe').textContent = CONFIG.ENGINE_VE.toLocaleString() + ' m/s';
  document.getElementById('specRcs').textContent = '4 pods (2 nozzles each)';

  const tickerEl = document.getElementById('tickerText');
  tickerEl.innerHTML =
    `<span class="accent">1</span> vehicle in fleet &nbsp;·&nbsp; ` +
    `<span class="accent">${CONFIG.ROCKET_NAME}</span> &nbsp;·&nbsp; ` +
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

// ---------------------------------------------------------------------------
// Vehicle Fleet module isn't built yet — show a toast instead of a dead link.
// ---------------------------------------------------------------------------
function bindFleetLink() {
  const link = document.getElementById('fleetLink');
  const toast = document.getElementById('toast');
  let hideTimer = null;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    toast.textContent = 'Vehicle Fleet is still being built — the simulator is ready to fly in the meantime.';
    toast.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  populateVehicleCard();
  startClock();
  bindFleetLink();
});
