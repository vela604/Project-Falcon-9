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
  'hc': 'Height of stack center of mass above the base (m)',
  'I': 'Stack moment of inertia about its center of mass (kg·m²)',
  'g':  'Local gravitational acceleration (m/s²)',
  'ρ':  'Local air density (kg/m³)',
  'D↑': 'RCS top-pod lateral-nozzle PWM duty cycle (%) — how much of each PWM period the top pod fires, to balance its larger moment arm against the bottom pod',
  'TWR': 'Thrust-to-weight ratio — max thrust / (current mass × g₀). Below 1 means no liftoff.',
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
  set('t-duty', Math.round((lastForces.dutyTop || 0) * 100) + '%');
  set('t-com', fmt(geom.comH, 2));
  set('t-moi', geom.I >= 1e6 ? (geom.I / 1e6).toFixed(2) + 'M' : fmt(geom.I, 0));
  
  const maxThrustAll = ENGINES.reduce((s, e) => s + e.Fmax, 0);
const g0v = (typeof G0 !== 'undefined') ? G0 : 9.80665;
const twrLive = geom.M > 0 ? maxThrustAll / (geom.M * g0v) : 0;
const twrEl = document.getElementById('t-twr');
if (twrEl) {
  twrEl.textContent = twrLive.toFixed(2);
  twrEl.style.color = twrLive < 1 ? 'var(--danger)' : (twrLive < 1.2 ? 'var(--yellow)' : '');
}
  
  pushGraphSample(state.simTime, altitude, speed, ENGINES.reduce((s,e)=>s+e.currentF,0));
}

// ---------------------------------------------------------------------------
// Side "rocket figure" panel — force vectors, CoM marker, fuel bar
// ---------------------------------------------------------------------------
let figCanvas, figCtx;

// World-frame vector -> normalized BODY-frame direction (rotates by -theta so
// the arrow shows correctly relative to the vehicle's nose, even though the
// figure panel always draws the airframe upright).
function worldVectorToBodyUnit(wx, wy, theta) {
  const mag = Math.hypot(wx, wy);
  if (mag < 1e-6) return null;
  const ux = wx / mag, uy = wy / mag;
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  return { bx: ux * cosT + uy * sinT, by: -ux * sinT + uy * cosT };
}

// Already-body-frame vector -> normalized direction (no rotation needed).
function unitOf(bx, by) {
  const mag = Math.hypot(bx, by);
  if (mag < 1e-6) return null;
  return { bx: bx / mag, by: by / mag };
}

// Draws a fixed-length unit-direction arrow. (bx, by) is in BODY frame
// (+y = toward the nose); canvas y is flipped to match.
function drawUnitVector(ctx2, x0, y0, bx, by, len, color, label) {
  const ex = x0 + bx * len, ey = y0 - by * len;
  ctx2.strokeStyle = color; ctx2.fillStyle = color; ctx2.lineWidth = 2;
  ctx2.beginPath(); ctx2.moveTo(x0, y0); ctx2.lineTo(ex, ey); ctx2.stroke();
  ctx2.beginPath(); ctx2.arc(ex, ey, 3, 0, Math.PI * 2); ctx2.fill();
  ctx2.font = '10px "JetBrains Mono", monospace';
  ctx2.fillText(label, ex + 4, ey + 3);
}

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
  figCtx.fillStyle = 'rgba(13,20,36,0.5)';
  figCtx.strokeStyle = '#35d6ff';
  figCtx.lineWidth = 1.4;
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

  // Force/motion UNIT vectors — direction only, fixed length. This panel is
  // the only place vectors are shown (the live sim canvas stays clean); the
  // "Vectors" toolbar toggle controls visibility here.
  if (showVectors) {
    const vecLen = H * 0.32;
    const vUnit = worldVectorToBodyUnit(state.vx, state.vy, state.theta);
    if (vUnit) drawUnitVector(figCtx, baseX, comY, vUnit.bx, vUnit.by, vecLen, '#ffdd55', 'v');

    // Main-thrust force is already computed in body frame — no rotation needed.
    const fUnit = unitOf(lastForces.mainFx, lastForces.mainFy);
    if (fUnit) drawUnitVector(figCtx, baseX, baseY, fUnit.bx, fUnit.by, vecLen, '#ffaa33', 'F');

    const r = Math.hypot(state.rx, state.ry);
    const gWorld = r > 0 ? { x: -state.rx / r, y: -state.ry / r } : { x: 0, y: -1 };
    const gUnit = worldVectorToBodyUnit(gWorld.x, gWorld.y, state.theta);
    if (gUnit) drawUnitVector(figCtx, baseX, comY, gUnit.bx, gUnit.by, vecLen * 0.85, '#aabbff', 'g');
  }

  // RCS gas-ejection glow — lights up here (not on the live sim rocket) when firing.
  const firing = lastForces.firing || {};
  const podCorners = {
  TL: [baseX - W / 2, baseY - CONFIG.RCS_TOP_Y * scale],
  TR: [baseX + W / 2, baseY - CONFIG.RCS_TOP_Y * scale],
  BL: [baseX - W / 2, baseY - CONFIG.RCS_BOTTOM_Y * scale],
  BR: [baseX + W / 2, baseY - CONFIG.RCS_BOTTOM_Y * scale],
};
  Object.keys(podCorners).forEach(k => {
    const [cx, cy] = podCorners[k];
    if (firing[k]) {
      const glow = figCtx.createRadialGradient(cx, cy, 0, cx, cy, 12);
      glow.addColorStop(0, 'rgba(120,220,255,0.9)');
      glow.addColorStop(1, 'rgba(120,220,255,0)');
      figCtx.fillStyle = glow;
      figCtx.beginPath(); figCtx.arc(cx, cy, 12, 0, Math.PI*2); figCtx.fill();
    }
    figCtx.fillStyle = firing[k] ? '#aef1ff' : '#22344a';
    figCtx.beginPath(); figCtx.arc(cx, cy, 3.5, 0, Math.PI*2); figCtx.fill();
  });

  // Gimbal indicator on center-engine flame stub — driven by actual
  // delivered thrust, so it disappears the instant the tank runs dry.
  const centerEngine = ENGINES.find(e => e.isCenter);
  const centerFrac = centerEngine.Fmax > 0 ? centerEngine.currentF / centerEngine.Fmax : 0;
  if (centerFrac > 0.01) {
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

  basalCtx.fillStyle = 'rgba(13,20,36,0.4)';
  basalCtx.strokeStyle = '#35d6ff';
  basalCtx.lineWidth = 1.4;
  basalCtx.beginPath(); basalCtx.arc(cx, cy, R*1.35, 0, Math.PI*2); basalCtx.fill(); basalCtx.stroke();

  ENGINES.forEach(e => {
    let ex, ey;
    if (e.isCenter) { ex = cx; ey = cy; }
    else {
      const rad = e.angleDeg * Math.PI/180;
      ex = cx + Math.cos(rad) * R;
      ey = cy - Math.sin(rad) * R;
    }
    // Driven by actual delivered thrust (currentF/Fmax), not the throttle
    // *setting* — so an engine reads dark/off the instant fuel runs out,
    // even if its slider is still held up.
    const frac = e.Fmax > 0 ? e.currentF / e.Fmax : 0;
    const opacity = 0.15 + 0.85 * frac;
    basalCtx.fillStyle = `rgba(255,${140 + 80*frac},${40+40*frac},${opacity})`;
    basalCtx.beginPath(); basalCtx.arc(ex, ey, e.isCenter ? 10 : 7, 0, Math.PI*2); basalCtx.fill();
    basalCtx.strokeStyle = 'rgba(219,230,245,0.35)'; basalCtx.stroke();

    if (frac > 0.02) {
      basalCtx.fillStyle = '#dbe6f5';
      basalCtx.font = '8px monospace';
      basalCtx.textAlign = 'center';
      basalCtx.fillText(Math.round(frac*100)+'%', ex, ey + 18);
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
