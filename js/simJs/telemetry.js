// ============================================================================
// telemetry.js — Dashboard (compact notation + info glossary), the side
// "rocket figure" panel (force vectors / CoM / fuel), the basal (bottom)
// engine-status view, and rolling mini graphs.
// ============================================================================

const NOTATION_GLOSSARY = {
  'h':  'Altitude above sea level (m)',
  'v':  'Speed, magnitude of velocity vector (m/s)',
  'vx': 'Horizontal velocity component (m/s)',
  'vy': 'Vertical velocity component (m/s)',
  'θ':  'Vehicle attitude relative to local vertical (deg)',
  'ω':  'Angular velocity (deg/s)',
  'm':  'Total vehicle mass (kg)',
  'mf': 'Remaining propellant mass (kg)',
  'Ft': 'Total main-engine thrust (N)',
  'γ':  'Center engine gimbal angle (deg)',
  'τ':  'Net torque about center of mass (N·m)',
  'g':  'Local gravitational acceleration (m/s²)',
  'ρ':  'Local air density (kg/m³)',
  'T+': 'Mission elapsed time (mm:ss.s)',
};

function buildGlossaryPanel() {
  const el = document.getElementById('glossaryList');
  el.innerHTML = Object.entries(NOTATION_GLOSSARY)
    .map(([k, v]) => `<div class="glossary-row"><span class="g-sym">${k}</span><span class="g-desc">${v}</span></div>`)
    .join('');
}

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }

function updateTelemetry() {
  const r = Math.hypot(state.rx, state.ry);
  const altitude = altitudeFromR(r);
  const speed = Math.hypot(state.vx, state.vy);
  const geom = currentGeometry();
  const visualTheta = (state.theta - localVerticalAngle()) * 180 / Math.PI;
  const centerEngine = ENGINES.find(e => e.isCenter);
  const grav = gravityAccel(state.rx, state.ry);
  const rho = airDensity(Math.max(0, altitude));

  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('t-h', fmt(altitude, 1));
  set('t-v', fmt(speed, 2));
  set('t-vx', fmt(state.vx, 2));
  set('t-vy', fmt(state.vy, 2));
  set('t-theta', fmt(visualTheta, 2));
  set('t-omega', fmt(state.omega * 180/Math.PI, 3));
  set('t-m', fmt(geom.M, 0));
  set('t-mf', fmt(state.fuelMass, 0));
  set('t-Ft', fmt(ENGINES.reduce((s,e)=>s+e.currentF,0), 0));
  set('t-gimbal', fmt(centerEngine.gimbalDeg, 1));
  set('t-torque', fmt(lastForces.mainTorque + lastForces.rcsTorque, 0));
  set('t-g', fmt(grav.g, 3));
  set('t-rho', fmt(rho, 4));

  pushGraphSample(state.simTime, altitude, speed, ENGINES.reduce((s,e)=>s+e.currentF,0));
}

// ---------------------------------------------------------------------------
// Side "rocket figure" panel — force vectors, CoM marker, fuel bar
// ---------------------------------------------------------------------------
let figCanvas, figCtx;

function initFigureCanvas() {
  figCanvas = document.getElementById('figureCanvas');
  figCtx = figCanvas.getContext('2d');
}

function drawFigurePanel() {
  if (!figCtx) return;
  const w = figCanvas.width, h = figCanvas.height;
  figCtx.clearRect(0, 0, w, h);

  const geom = currentGeometry();
  const scale = (h * 0.75) / CONFIG.ROCKET_HEIGHT;
  const baseX = w / 2, baseY = h * 0.9;

  // Body outline (always upright here — this panel is a schematic, not the live attitude)
  const W = CONFIG.ROCKET_WIDTH * scale;
  const H = CONFIG.ROCKET_HEIGHT * scale;
  figCtx.fillStyle = '#e4e9f2';
  figCtx.strokeStyle = '#8fa0b8';
  figCtx.lineWidth = 1.5;
  figCtx.beginPath();
  figCtx.moveTo(baseX - W/2, baseY);
  figCtx.lineTo(baseX - W/2, baseY - H*0.85);
  figCtx.quadraticCurveTo(baseX - W/2, baseY - H, baseX, baseY - H);
  figCtx.quadraticCurveTo(baseX + W/2, baseY - H, baseX + W/2, baseY - H*0.85);
  figCtx.lineTo(baseX + W/2, baseY);
  figCtx.closePath();
  figCtx.fill(); figCtx.stroke();

  // Fuel level (fill fraction from base)
  const fuelFrac = state.fuelMass / CONFIG.FUEL_MASS_MAX;
  figCtx.fillStyle = 'rgba(255,140,40,0.35)';
  figCtx.fillRect(baseX - W/2 + 2, baseY - H*0.55*fuelFrac, W - 4, H*0.55*fuelFrac);

  // CoM marker
  const comY = baseY - geom.comH * scale;
  figCtx.strokeStyle = '#ff4466';
  figCtx.lineWidth = 2;
  figCtx.beginPath(); figCtx.moveTo(baseX - W*0.4, comY); figCtx.lineTo(baseX + W*0.4, comY); figCtx.stroke();
  figCtx.beginPath(); figCtx.arc(baseX, comY, 4, 0, Math.PI*2); figCtx.fillStyle = '#ff4466'; figCtx.fill();
  figCtx.fillStyle = '#ff8899'; figCtx.font = '10px monospace';
  figCtx.fillText('CoM', baseX + W*0.45, comY + 3);

  // Force vectors: thrust (orange, up from base) and gravity (white, down from CoM)
  const thrustMag = ENGINES.reduce((s,e)=>s+e.currentF, 0);
  const thrustLen = Math.min(H*0.6, (thrustMag / (CONFIG.ENGINE_F_MAX*9)) * H*0.6);
  if (thrustLen > 2) {
    figCtx.strokeStyle = '#ffaa33'; figCtx.lineWidth = 3;
    figCtx.beginPath(); figCtx.moveTo(baseX, baseY); figCtx.lineTo(baseX, baseY - thrustLen); figCtx.stroke();
  }
  const gravLen = H*0.3;
  figCtx.strokeStyle = '#aabbff'; figCtx.lineWidth = 2;
  figCtx.beginPath(); figCtx.moveTo(baseX, comY); figCtx.lineTo(baseX, comY + gravLen); figCtx.stroke();
  figCtx.fillStyle = '#aabbff'; figCtx.fillText('Fg', baseX + 5, comY + gravLen);

  // Gimbal indicator on center-engine flame stub
  const centerEngine = ENGINES.find(e => e.isCenter);
  if (centerEngine.throttle > 0.01) {
    figCtx.save();
    figCtx.translate(baseX, baseY);
    figCtx.rotate(centerEngine.gimbalDeg * Math.PI/180);
    figCtx.fillStyle = 'rgba(255,180,80,0.8)';
    figCtx.beginPath(); figCtx.moveTo(-4,0); figCtx.lineTo(4,0); figCtx.lineTo(0,18); figCtx.closePath(); figCtx.fill();
    figCtx.restore();
  }
}

// ---------------------------------------------------------------------------
// Basal (bottom) view — 9-engine ignition status
// ---------------------------------------------------------------------------
let basalCanvas, basalCtx;
function initBasalCanvas() {
  basalCanvas = document.getElementById('basalCanvas');
  basalCtx = basalCanvas.getContext('2d');
}

function drawBasalView() {
  if (!basalCtx) return;
  const w = basalCanvas.width, h = basalCanvas.height;
  basalCtx.clearRect(0, 0, w, h);
  const cx = w/2, cy = h/2, R = Math.min(w,h)*0.38;

  basalCtx.strokeStyle = '#3a4a5a';
  basalCtx.beginPath(); basalCtx.arc(cx, cy, R*1.35, 0, Math.PI*2); basalCtx.stroke();

  ENGINES.forEach(e => {
    let ex, ey;
    if (e.isCenter) { ex = cx; ey = cy; }
    else {
      const rad = e.angleDeg * Math.PI/180;
      ex = cx + Math.cos(rad) * R;
      ey = cy - Math.sin(rad) * R;
    }
    const opacity = 0.15 + 0.85 * e.throttle;
    basalCtx.fillStyle = `rgba(255,${140 + 80*e.throttle},${40+40*e.throttle},${opacity})`;
    basalCtx.beginPath(); basalCtx.arc(ex, ey, e.isCenter ? 10 : 7, 0, Math.PI*2); basalCtx.fill();
    basalCtx.strokeStyle = 'rgba(255,255,255,0.25)'; basalCtx.stroke();

    if (e.throttle > 0.02) {
      basalCtx.fillStyle = '#fff';
      basalCtx.font = '8px monospace';
      basalCtx.textAlign = 'center';
      basalCtx.fillText(Math.round(e.throttle*100)+'%', ex, ey + 18);
    }
  });
  basalCtx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// Rolling mini graphs (altitude, velocity, thrust vs time)
// ---------------------------------------------------------------------------
const graphHistory = { t: [], alt: [], vel: [], thrust: [] };
const GRAPH_WINDOW = 60; // seconds of history kept

function pushGraphSample(t, alt, vel, thrust) {
  graphHistory.t.push(t); graphHistory.alt.push(alt); graphHistory.vel.push(vel); graphHistory.thrust.push(thrust);
  while (graphHistory.t.length && t - graphHistory.t[0] > GRAPH_WINDOW) {
    graphHistory.t.shift(); graphHistory.alt.shift(); graphHistory.vel.shift(); graphHistory.thrust.shift();
  }
}

function drawMiniChart(canvasEl, data, color, label) {
  const ctx2 = canvasEl.getContext('2d');
  const w = canvasEl.width, h = canvasEl.height;
  ctx2.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data);
  const range = (max - min) || 1;
  ctx2.strokeStyle = color; ctx2.lineWidth = 1.5;
  ctx2.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
  });
  ctx2.stroke();
  ctx2.fillStyle = color; ctx2.font = '9px monospace';
  ctx2.fillText(`${label}: ${fmt(data[data.length-1], 1)}`, 3, 10);
}

function drawGraphs() {
  const altC = document.getElementById('graphAlt');
  const velC = document.getElementById('graphVel');
  const thrC = document.getElementById('graphThrust');
  if (altC) drawMiniChart(altC, graphHistory.alt, '#55ddff', 'alt');
  if (velC) drawMiniChart(velC, graphHistory.vel, '#ffdd55', 'v');
  if (thrC) drawMiniChart(thrC, graphHistory.thrust, '#ff8855', 'F');
}
