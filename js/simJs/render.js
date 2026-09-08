// ============================================================================
// render.js — Canvas rendering.
//
// Physics state lives in the Earth-centered inertial frame (rx, ry). For
// display (and for all altitudes reachable in this phase — sub-orbital,
// near-surface) we render in a LOCAL FLAT TANGENT-PLANE frame anchored at
// the launch meridian:
//   x_local = rx                      (valid while rx << EARTH_RADIUS)
//   y_local = ry - EARTH_RADIUS       (altitude)
// The curvature drop over this range (d²/2R) is sub-meter for tens of km,
// so this approximation is visually exact at the scales this phase uses.
// The rocket's on-screen tilt is its inertial theta minus the local-vertical
// angle, so attitude reads correctly even as rx grows.
// ============================================================================

let canvas, ctx;
let showGrid = true;
let showVectors = true;

function initCanvas() {
  canvas = document.getElementById('simCanvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}

function localVerticalAngle() {
  return Math.atan2(state.rx, state.ry); // angle of position vector from local "north" (ry axis)
}

function worldToLocal() {
  return { x: state.rx, y: state.ry - CONFIG.EARTH_RADIUS };
}

// meters -> pixels, and local(x,y) -> screen(px,py)
let cameraCenter = { x: 0, y: 500 }; // local-frame meters

function metersPerPixel() {
  return 1 / (0.4 * camera.zoom);
}

function localToScreen(x, y) {
  const mpp = metersPerPixel();
  const cx = camera.follow ? worldToLocal().x : cameraCenter.x;
  const cy = camera.follow ? worldToLocal().y : cameraCenter.y;
  const px = canvas.width / 2 + (x - cx) / mpp;
  const py = canvas.height / 2 - (y - cy) / mpp;
  return [px, py];
}

function drawSky(altitude) {
  const rho = airDensity(Math.max(0, altitude));
  const densityFrac = Math.min(1, rho / CONFIG.SEA_LEVEL_DENSITY); // 1 = sea level, 0 = vacuum
  // Interpolate: dense (blue sky) -> thin (deep space black), with a violet transition band.
  const skyBlue = [30, 60, 110];
  const midViolet = [25, 15, 50];
  const spaceBlack = [3, 4, 10];
  let c;
  if (densityFrac > 0.5) {
    const t = (densityFrac - 0.5) * 2;
    c = lerpColor(midViolet, skyBlue, t);
  } else {
    const t = densityFrac * 2;
    c = lerpColor(spaceBlack, midViolet, t);
  }
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, `rgb(${c[0]*0.6},${c[1]*0.6},${c[2]*0.6})`);
  grad.addColorStop(1, `rgb(${c[0]},${c[1]},${c[2]})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function lerpColor(a, b, t) {
  return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t];
}

function drawGrid() {
  if (!showGrid) return;
  const mpp = metersPerPixel();
  const spacingMeters = niceGridSpacing(mpp * 100);
  const cx = camera.follow ? worldToLocal().x : cameraCenter.x;
  const cy = camera.follow ? worldToLocal().y : cameraCenter.y;

  ctx.strokeStyle = 'rgba(120,180,255,0.12)';
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(150,200,255,0.35)';

  const left = cx - canvas.width/2*mpp, right = cx + canvas.width/2*mpp;
  const bottom = cy - canvas.height/2*mpp, top = cy + canvas.height/2*mpp;

  const startX = Math.floor(left / spacingMeters) * spacingMeters;
  for (let gx = startX; gx <= right; gx += spacingMeters) {
    const [px] = localToScreen(gx, 0);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, canvas.height); ctx.stroke();
    ctx.fillText(gx.toFixed(0)+'m', px+3, 12);
  }
  const startY = Math.floor(bottom / spacingMeters) * spacingMeters;
  for (let gy = startY; gy <= top; gy += spacingMeters) {
    const [, py] = localToScreen(0, gy);
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(canvas.width, py); ctx.stroke();
    ctx.fillText(gy.toFixed(0)+'m', 3, py-3);
  }
}

function niceGridSpacing(target) {
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * pow;
}

function drawGroundLine() {
  const [, py] = localToScreen(0, 0);
  if (py < canvas.height && py > -50) {
    ctx.fillStyle = '#0d2b12';
    ctx.fillRect(0, py, canvas.width, canvas.height - py);
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(canvas.width, py); ctx.stroke();
  }
}

function drawRocket() {
  const loc = worldToLocal();
  const [px, py] = localToScreen(loc.x, loc.y);
  const visualTheta = state.theta - localVerticalAngle();

  const mpp = metersPerPixel();
  const H = CONFIG.ROCKET_HEIGHT / mpp;
  const W = CONFIG.ROCKET_WIDTH / mpp;
  const geom = currentGeometry();

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-visualTheta);

  // ---- Flame (drawn first, behind body, based on center + outer throttle) ----
  const totalThrottle = ENGINES.reduce((s, e) => s + e.throttle, 0) / ENGINES.length;
  if (totalThrottle > 0.01) {
    const flameLen = H * (0.3 + 0.9 * totalThrottle);
    const grad = ctx.createLinearGradient(0, 0, 0, flameLen);
    grad.addColorStop(0, `rgba(255,240,180,${0.9})`);
    grad.addColorStop(0.4, `rgba(255,140,40,${0.7})`);
    grad.addColorStop(1, `rgba(255,60,20,0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-W*0.28, 0);
    ctx.lineTo(W*0.28, 0);
    ctx.lineTo(W*0.10, flameLen);
    ctx.lineTo(-W*0.10, flameLen);
    ctx.closePath();
    ctx.fill();
  }

  // ---- Body (clean, minimal) ----
  ctx.fillStyle = '#d8dee8';
  ctx.strokeStyle = '#8fa0b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-W/2, 0);
  ctx.lineTo(-W/2, -H*0.85);
  ctx.quadraticCurveTo(-W/2, -H, 0, -H);
  ctx.quadraticCurveTo(W/2, -H, W/2, -H*0.85);
  ctx.lineTo(W/2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // grid-fin style stripe near top for visual interest
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath(); ctx.moveTo(-W/2, -H*0.72); ctx.lineTo(W/2, -H*0.72); ctx.stroke();

  // ---- RCS glow (corners), lights up when firing this tick ----
  const firing = lastForces.firing || {};
  const rcsR = W * 0.12;
  const corners = {
    TL: [-W/2, -(H - CONFIG.RCS_TOP_MARGIN/mpp)],
    TR: [ W/2, -(H - CONFIG.RCS_TOP_MARGIN/mpp)],
    BL: [-W/2, -(CONFIG.RCS_BOTTOM_MARGIN/mpp)],
    BR: [ W/2, -(CONFIG.RCS_BOTTOM_MARGIN/mpp)],
  };
  Object.keys(corners).forEach(k => {
    const [cx, cy] = corners[k];
    if (firing[k]) {
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, rcsR*3);
      glow.addColorStop(0, 'rgba(120,220,255,0.9)');
      glow.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, rcsR*3, 0, Math.PI*2); ctx.fill();
    }
    ctx.fillStyle = firing[k] ? '#aef1ff' : '#3a4a5a';
    ctx.beginPath(); ctx.arc(cx, cy, rcsR, 0, Math.PI*2); ctx.fill();
  });

  ctx.restore();

  // ---- Vectors (velocity, thrust) toggleable ----
  if (showVectors) {
    drawVectorFrom(px, py, state.vx, state.vy, '#ffdd55', 'V');
  }
}

function drawVectorFrom(px, py, vx, vy, color, label) {
  const scale = 3;
  const speed = Math.hypot(vx, vy);
  if (speed < 0.05) return;
  // rotate world vector into screen space (screen y is inverted)
  const ex = px + vx * scale;
  const ey = py - vy * scale;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI*2); ctx.fill();
}

function renderFrame() {
  const r = Math.hypot(state.rx, state.ry);
  const altitude = altitudeFromR(r);
  drawSky(altitude);
  drawGrid();
  drawGroundLine();
  drawRocket();
}
