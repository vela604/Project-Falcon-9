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

// ---------------------------------------------------------------------------
// Launch/landing site — kept deliberately minimal: just a thin flat
// rectangle sitting on top of the ground. No slope, no perspective, no
// extra structures — a pure flat 2D shape, nothing trying to fake depth.
// ---------------------------------------------------------------------------
function drawLaunchPad() {
  const [px0, py0] = localToScreen(0, 0);
  if (py0 < -150 || py0 > canvas.height + 150) return; // off-screen, skip entirely

  const mpp = metersPerPixel();
  const padHalfW = 34 / mpp;
  const padH = 3 / mpp;

  ctx.fillStyle = '#5a5f66';
  ctx.fillRect(px0 - padHalfW, py0 - padH, padHalfW * 2, padH);
  ctx.strokeStyle = '#3f4349';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px0 - padHalfW, py0 - padH, padHalfW * 2, padH);
}

function drawRocket() {
  const loc = worldToLocal();
  const [px, py] = localToScreen(loc.x, loc.y);
  const visualTheta = state.theta - localVerticalAngle();

  const mpp = metersPerPixel();
  const H = CONFIG.ROCKET_HEIGHT / mpp;
  const W = CONFIG.ROCKET_WIDTH / mpp;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-visualTheta);

  // ============================================================================
  // ENGINE PLUME
  // ============================================================================
  const totalThrust = ENGINES.reduce((s, e) => s + e.currentF, 0);
  const maxThrust = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const totalThrottle = maxThrust > 0 ? totalThrust / maxThrust : 0;

  if (totalThrottle > 0.03) {
    const tNow = performance.now() * 0.01;
    const flameLen = H * (0.6 + 1.6 * totalThrottle);

    const centerEngine = ENGINES.find(e => e.isCenter);
    const centerFrac = totalThrust > 0 ? centerEngine.currentF / totalThrust : 0;
    const gimbalRad = (centerEngine.gimbalDeg * Math.PI / 180) * centerFrac;
    const fullShift = -flameLen * Math.sin(gimbalRad);

    const activeCount = ENGINES.filter(e => e.currentF > 1).length;
    const plumeScale = Math.min(1.0, 0.30 + 0.70 * Math.max(0, activeCount - 1) / 8);

    function gasConePath(startW, endW, lenFrac, seed, segments, layerShift) {
      const l = flameLen * lenFrac;
      ctx.beginPath();
      ctx.moveTo(-startW / 2, 0);
      for (let i = 1; i <= segments; i++) {
        const f = i / segments;
        const y = l * f;
        const w = startW + (endW - startW) * f;
        const grow = 0.15 + 1.1 * f * f;
        const wob = Math.sin(f * 4.5 + tNow * 2.3 + seed) * w * 0.16 * grow
                  + Math.sin(f * 9.5 + tNow * 3.8 + seed * 1.4) * w * 0.08 * grow;
        ctx.lineTo(-w / 2 - wob + layerShift * f, y);
      }
      const capW = endW, capX = layerShift, capY = l;
      ctx.quadraticCurveTo(capX - capW * 0.34, capY + capW * 0.15, capX, capY + capW * 0.22);
      ctx.quadraticCurveTo(capX + capW * 0.34, capY + capW * 0.15, endW / 2 + layerShift, l);
      for (let i = segments; i >= 0; i--) {
        const f = i / segments;
        const y = l * f;
        const w = startW + (endW - startW) * f;
        const grow = 0.15 + 1.1 * f * f;
        const wob = Math.sin(f * 4.5 + tNow * 2.3 + seed + 1.9) * w * 0.16 * grow
                  + Math.sin(f * 9.5 + tNow * 3.8 + seed * 1.4 + 0.8) * w * 0.08 * grow;
        ctx.lineTo(w / 2 + wob + layerShift * f, y);
      }
      ctx.closePath();
    }

    ctx.save();
    ctx.filter = 'blur(11px)';
    gasConePath(W * 1.0 * plumeScale, W * 2.7 * plumeScale, 1.0, 0, 14, fullShift * 1.0);
    const g1 = ctx.createLinearGradient(0, 0, fullShift * 1.0, flameLen * 1.0);
    g1.addColorStop(0, 'rgba(255,170,80,0.55)');
    g1.addColorStop(0.55, 'rgba(255,110,40,0.4)');
    g1.addColorStop(1, 'rgba(255,70,20,0)');
    ctx.fillStyle = g1;
    ctx.fill();
    ctx.filter = 'none';

    ctx.filter = 'blur(7px)';
    for (let i = 0; i < 5; i++) {
      const f = 0.35 + 0.6 * (i / 4);
      const y = flameLen * f;
      const w = (W * 1.0 * plumeScale + (W * 2.7 * plumeScale - W * 1.0 * plumeScale) * f);
      const side = i % 2 === 0 ? 1 : -1;
      const drift = Math.sin(tNow * 1.6 + i * 2.1) * w * 0.18;
      const bx = side * (w * 0.42 + drift) + fullShift * f;
      const by = y + Math.cos(tNow * 1.3 + i) * w * 0.08;
      const r = w * (0.2 + 0.08 * Math.sin(i * 1.9 + tNow));
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, r);
      bg.addColorStop(0, 'rgba(255,140,60,0.35)');
      bg.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.filter = 'none';

    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(5px)';
    const shift92 = fullShift * 0.92;
    gasConePath(W * 0.78 * plumeScale, W * 1.9 * plumeScale, 0.92, 2.1, 11, shift92);
    const g2 = ctx.createLinearGradient(0, 0, shift92, flameLen * 0.92);
    g2.addColorStop(0, 'rgba(255,225,140,0.9)');
    g2.addColorStop(0.5, 'rgba(255,150,55,0.55)');
    g2.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g2;
    ctx.fill();
    ctx.filter = 'none';

    ctx.filter = 'blur(2px)';
    const shift68 = fullShift * 0.68;
    gasConePath(W * 0.58 * plumeScale, W * 1.05 * plumeScale, 0.68, 4.4, 9, shift68);
    const coreHot = 0.55 + 0.45 * totalThrottle;
    const g3 = ctx.createLinearGradient(0, 0, shift68, flameLen * 0.68);
    g3.addColorStop(0, `rgba(${Math.round(255 - coreHot*15)},252,255,1)`);
    g3.addColorStop(0.55, 'rgba(255,240,215,0.85)');
    g3.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g3;
    ctx.fill();
    ctx.filter = 'none';

    ctx.filter = 'blur(5px)';
    const shift22 = fullShift * 0.22;
    gasConePath(W * 0.42 * plumeScale, W * 0.55 * plumeScale, 0.22, 6.7, 6, shift22);
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.fill();
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';

    ctx.globalCompositeOperation = 'lighter';
    const flare = ctx.createRadialGradient(0, W * 0.05, 0, fullShift * 0.05, W * 0.05, W * 0.9 * plumeScale);
    flare.addColorStop(0, 'rgba(255,255,255,0.9)');
    flare.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    flare.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = flare;
    ctx.beginPath(); ctx.ellipse(0, W * 0.05, W * 0.50 * plumeScale, W * 0.2 * plumeScale, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // ============================================================================
  // LEGS SETUP — 4 legs via shared helper
  // ============================================================================
  const p = legs.progress;
  const legHingeY = -H * 0.004;
  const legLength = H * 0.27;
  const maxSweepRad = (125 * Math.PI) / 180;
  const pistonMountY = -H * 0.08;
  const LEG_TIP_CURVENESS = 0.90;

  function drawLandingLeg(side, isBack) {
    const depthX = isBack ? 0.75 : 1.0;
    const depthY = isBack ? -H * 0.006 : 0;

    const j1x = side * (W * 0.49) * depthX;
    const j2x = side * (W * 0.05) * depthX;
    const jY  = legHingeY + depthY;

    const pivotX = Math.sin(Math.PI / 4) * (j1x + j2x) / 1;
    const pivotY = jY;

    const currentSweep = side * p * maxSweepRad;
    const tipX = pivotX + legLength * Math.sin(currentSweep);
    const tipY = pivotY - legLength * Math.cos(currentSweep);

    const cutoutApexX = pivotX + (tipX - pivotX) * 0.07;
    const cutoutApexY = pivotY + (tipY - pivotY) * 0.07;

    const d1 = Math.hypot(tipX - j1x, tipY - jY) || 1;
    const u1x = (j1x - tipX) / d1, u1y = (jY - tipY) / d1;
    const d2 = Math.hypot(tipX - j2x, tipY - jY) || 1;
    const u2x = (j2x - tipX) / d2, u2y = (jY - tipY) / d2;
    const roundR = Math.min(legLength * LEG_TIP_CURVENESS, d1 * 0.85, d2 * 0.85);
    const p1x = tipX + u1x * roundR, p1y = tipY + u1y * roundR;
    const p2x = tipX + u2x * roundR, p2y = tipY + u2y * roundR;

    const tipApexX = 0.25 * p1x + 0.5 * tipX + 0.25 * p2x;
    const tipApexY = 0.25 * p1y + 0.5 * tipY + 0.25 * p2y;

    if (!isBack) {
      const legActualLength = Math.hypot(tipApexX - pivotX, tipApexY - pivotY);
      if (!legs.actualLength) {
        legs.actualLength = {}; legs.footX = {}; legs.footY = {};
      }
      legs.actualLength[side] = legActualLength;
      legs.footX[side] = tipApexX;
      legs.footY[side] = tipApexY;
    }

    if (p > 0.02) {
      const pmX = pivotX;
      const pmY = pistonMountY + depthY;

      ctx.strokeStyle = isBack ? '#050608' : '#0a0c0f';
      ctx.lineWidth = Math.max(1.5, W * 0.040);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(pmX, pmY); ctx.lineTo(tipApexX, tipApexY); ctx.stroke();

      ctx.strokeStyle = isBack ? '#171b22' : '#2c313a';
      ctx.lineWidth = Math.max(0.8, W * 0.018);
      ctx.beginPath(); ctx.moveTo(pmX, pmY); ctx.lineTo(tipApexX, tipApexY); ctx.stroke();

      const rodStartFrac = 0.32;
      const rx1 = pmX + (tipApexX - pmX) * rodStartFrac;
      const ry1 = pmY + (tipApexY - pmY) * rodStartFrac;

      ctx.strokeStyle = isBack ? '#8a9099' : '#e6ecf2';
      ctx.lineWidth = Math.max(1, W * 0.022);
      ctx.beginPath(); ctx.moveTo(rx1, ry1); ctx.lineTo(tipApexX, tipApexY); ctx.stroke();

      ctx.fillStyle = isBack ? '#0d1015' : '#1a1e24';
      ctx.beginPath(); ctx.arc(rx1, ry1, W * 0.025, 0, Math.PI * 2); ctx.fill();
    }

    const legGrad = ctx.createLinearGradient(pivotX, jY, tipX, tipY);
    if (isBack) {
      legGrad.addColorStop(0,    '#0f1114');
      legGrad.addColorStop(0.35, '#1a1d22');
      legGrad.addColorStop(0.7,  '#08090b');
      legGrad.addColorStop(1,    '#000000');
    } else {
      legGrad.addColorStop(0,    '#1c1f24');
      legGrad.addColorStop(0.35, '#3a3f47');
      legGrad.addColorStop(0.7,  '#14171b');
      legGrad.addColorStop(1,    '#000000');
    }

    ctx.fillStyle = legGrad;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(p1x, p1y);
    ctx.quadraticCurveTo(tipX, tipY, p2x, p2y);
    ctx.lineTo(j2x, jY);
    ctx.lineTo(cutoutApexX, cutoutApexY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(tipApexX, tipApexY);
    ctx.lineTo(cutoutApexX, cutoutApexY);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1.2, W * 0.018);
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(cutoutApexX, cutoutApexY);
    ctx.lineTo(j2x, jY);
    ctx.stroke();

    ctx.strokeStyle = isBack ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(p1x, p1y);
    ctx.stroke();
  }

  // BACK legs (behind body)
  drawLandingLeg(-1, true);
  drawLandingLeg( 1, true);

  // ---- Body ----
  ctx.fillStyle = '#e9edf2';
  ctx.strokeStyle = '#8b93a0';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-W/2, 0);
  ctx.lineTo(-W/2, -H*0.85);
  ctx.quadraticCurveTo(-W/2, -H, 0, -H);
  ctx.quadraticCurveTo(W/2, -H, W/2, -H*0.85);
  ctx.lineTo(W/2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  let shade = ctx.createLinearGradient(-W/2, 0, W/2, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.14)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0.10)');
  shade.addColorStop(1, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(-W/2, 0);
  ctx.lineTo(-W/2, -H*0.85);
  ctx.quadraticCurveTo(-W/2, -H, 0, -H);
  ctx.quadraticCurveTo(W/2, -H, W/2, -H*0.85);
  ctx.lineTo(W/2, 0);
  ctx.closePath();
  ctx.fill();

  const stripeTop = -H * 0.80, stripeBottom = -H * 0.72;
  ctx.fillStyle = '#14161a';
  ctx.fillRect(-W/2, stripeTop, W, stripeBottom - stripeTop);
  const chk = W * 0.16, chkY = (stripeTop + stripeBottom) / 2 - chk/2;
  ctx.fillStyle = '#e9edf2';
  ctx.fillRect(-chk, chkY, chk, chk);
  ctx.fillRect(0, chkY, chk, chk);
  ctx.fillStyle = '#14161a';
  ctx.fillRect(-chk, chkY, chk, chk/2);
  ctx.fillRect(-chk/2, chkY+chk/2, chk/2, chk/2);
  ctx.fillRect(0, chkY, chk, chk/2);
  ctx.fillRect(chk/2, chkY+chk/2, chk/2, chk/2);

  const finY = -H * 0.845, finLen = W * 0.22, finH = H * 0.05;
  [-1, 1].forEach(side => {
    ctx.save();
    ctx.translate(side * W/2, finY);
    ctx.rotate(side * -0.12);
    ctx.fillStyle = '#1c1e22';
    ctx.strokeStyle = '#3a3d43';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.rect(0, -finH/2, side * finLen, finH); ctx.fill(); ctx.stroke();
    for (let i = 1; i <= 2; i++) {
      const gx = side * finLen * (i/3);
      ctx.beginPath(); ctx.moveTo(gx, -finH/2); ctx.lineTo(gx, finH/2); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(side*finLen, 0); ctx.stroke();
    ctx.restore();
  });

  // FRONT legs (on top of body)
  drawLandingLeg(-1, false);
  drawLandingLeg( 1, false);

  // ============================================================================
  // RCS — rounded-rectangle pods + gas puffs
  // ============================================================================
  const firing = lastForces.firing || {};
  const pod = lastForces.pod || {};
  const corners = {
    TL: [-W/2, -(H - CONFIG.RCS_TOP_MARGIN/mpp)],
    TR: [ W/2, -(H - CONFIG.RCS_TOP_MARGIN/mpp)],
    BL: [-W/2, -(CONFIG.RCS_BOTTOM_MARGIN/mpp)],
    BR: [ W/2, -(CONFIG.RCS_BOTTOM_MARGIN/mpp)],
  };
  const lateralDir = { TL: [-1, 0], TR: [1, 0], BL: [-1, 0], BR: [1, 0] };
  const plumeLen = W * 0.6;
  const fEps = 1;

  function drawGasPuff(cx, cy, dir, seed) {
    const [dx, dy] = dir;
    const nx = -dy, ny = dx;
    const jitter = 1 + 0.10 * Math.sin(performance.now() * 0.05 + seed);
    const len = plumeLen * jitter;
    const tipX = cx + dx * len, tipY = cy + dy * len;
    const midX = cx + dx * len * 0.55, midY = cy + dy * len * 0.55;
    const spread = W * 0.05;

    const grad = ctx.createLinearGradient(cx, cy, tipX, tipY);
    grad.addColorStop(0, 'rgba(130,225,255,0.95)');
    grad.addColorStop(0.55, 'rgba(150,220,255,0.55)');
    grad.addColorStop(1, 'rgba(170,220,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - nx*spread, cy - ny*spread);
    ctx.quadraticCurveTo(midX - nx*spread*0.7, midY - ny*spread*0.7, tipX, tipY);
    ctx.quadraticCurveTo(midX + nx*spread*0.7, midY + ny*spread*0.7, cx + nx*spread, cy + ny*spread);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,35,50,0.55)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.fillStyle = 'rgba(190,235,255,0.35)';
    ctx.beginPath(); ctx.arc(midX, midY, spread*0.9*jitter, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(200,240,255,0.22)';
    ctx.beginPath(); ctx.arc(tipX, tipY, spread*1.1*jitter, 0, Math.PI*2); ctx.fill();

    ctx.fillStyle = 'rgba(230,250,255,0.9)';
    ctx.beginPath(); ctx.arc(cx + dx*W*0.03, cy + dy*W*0.03, spread*0.6, 0, Math.PI*2); ctx.fill();
  }

  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  Object.keys(corners).forEach(k => {
    const [cxRaw, cy] = corners[k];
    const pp = pod[k] || { Fx: 0, Fy: 0 };

    const podW = W * 0.05;
    const podH = W * 0.10;
    const podR = W * 0.03;

    const sideSign = Math.sign(cxRaw);
    const podX = cxRaw + sideSign * podW * 0.5 - podW / 2;
    const podY = cy - podH / 2;

    if (Math.abs(pp.Fx) > fEps) drawGasPuff(cxRaw, cy, lateralDir[k], k.charCodeAt(0));
    if (Math.abs(pp.Fy) > fEps) {
      const vDir = pp.Fy > 0 ? [0, 1] : [0, -1];
      const outX = cxRaw + sideSign * podW * 0.6;
      drawGasPuff(outX, cy, vDir, k.charCodeAt(1) + 3);
    }

    ctx.save();

    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 0.5;

    ctx.fillStyle = firing[k] ? '#aef1ff' : '#2a2d33';
    roundRectPath(podX, podY, podW, podH, podR);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = 'rgba(20,24,30,0.85)';
    ctx.lineWidth = 0.9;
    ctx.stroke();

    const hlX = sideSign > 0 ? podX + podW * 0.72 : podX + podW * 0.12;
    const hlGrad = ctx.createLinearGradient(hlX, 0, hlX + podW * 0.15, 0);
    hlGrad.addColorStop(0, 'rgba(255,255,255,0.0)');
    hlGrad.addColorStop(0.5, firing[k] ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.25)');
    hlGrad.addColorStop(1, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = hlGrad;
    roundRectPath(podX + podW * 0.55, podY + podH * 0.15, podW * 0.35, podH * 0.7, podR * 0.6);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.7;
    const slotX = sideSign > 0 ? podX + podW * 0.35 : podX + podW * 0.65;
    for (let i = 0; i < 2; i++) {
      const sy = podY + podH * (0.30 + i * 0.40);
      ctx.beginPath();
      ctx.moveTo(slotX - podW * 0.12, sy);
      ctx.lineTo(slotX + podW * 0.12, sy);
      ctx.stroke();
    }

    ctx.restore();
  });

  ctx.restore();
}

function drawGroundSteam(altitude) {
  const totalThrust = ENGINES.reduce((s, e) => s + e.currentF, 0);
  const maxThrust = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const throttle = maxThrust > 0 ? totalThrust / maxThrust : 0;
  if (throttle < 0.05 || altitude > 180) return;

  const [cx, groundPy] = localToScreen(worldToLocal().x, 0);
  if (groundPy < -200 || groundPy > canvas.height + 400) return;

  const fade = 1 - Math.min(1, altitude / 180); // full strength at the pad, gone by ~180m
  const mpp = metersPerPixel();
  const spread = (140 / mpp) * (0.6 + 0.4 * throttle) * fade;
  const t = performance.now() * 0.0012;

  ctx.save();
  ctx.filter = 'blur(16px)';
  const blobs = 8;
  for (let i = 0; i < blobs; i++) {
    const f = i / (blobs - 1);
    const bx = cx + (f - 0.5) * spread * 1.9 + Math.sin(t + i * 1.3) * spread * 0.05;
    const by = groundPy - Math.abs(Math.sin(f * Math.PI)) * spread * 0.22 + Math.cos(t * 0.8 + i) * spread * 0.03;
    const r = spread * (0.22 + 0.09 * Math.sin(i * 1.7 + t));
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    g.addColorStop(0, `rgba(255,255,255,${0.85 * fade})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.filter = 'none';
  ctx.restore();
}

function renderFrame() {
  const r = Math.hypot(state.rx, state.ry);
  const altitude = altitudeFromR(r);
  drawSky(altitude);
  drawGrid();
  drawGroundLine();
  drawLaunchPad();
  drawGroundSteam(altitude);
  drawRocket();
}
