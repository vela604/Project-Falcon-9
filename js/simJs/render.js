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

    // ============================================================================
  // === ADVANCED VOLUMETRIC GAS EXHAUST RENDERING (CRITICAL UPDATE) ===
  // Goal: Match the sprawling, sprawling, voluminous gassy plumes of image_0.png and image_1.png
  // DITCHES simple linear gradients.
  // Focuses on complex geometry paths (billowing gas clouds) and layered, blurred gradients.
  // ============================================================================

  // ---- Flame (drawn first, behind body) ----
  const totalThrust = ENGINES.reduce((s, e) => s + e.currentF, 0);
  const maxThrust = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const totalThrottle = maxThrust > 0 ? totalThrust / maxThrust : 0;

  if (totalThrottle > 0.05) { // Minimum threshold for effect
    const activeCount = ENGINES.filter(e => e.currentF > e.Fmax * 0.02).length;
    const spread = Math.min(1, activeCount / 5);
    
    // Core structure (retained from previous attempt, contained inside)
    const baseW = W * (0.8 + 0.3 * spread); 
    const flicker = 1 + 0.02 * Math.sin(performance.now() * 0.05) + 0.01 * Math.sin(performance.now() * 0.1);
    const flameLen = H * (0.3 + 1.2 * totalThrottle) * flicker;

    // Gimbal tilt calculations (retained)
    const centerEngine = ENGINES.find(e => e.isCenter);
    const centerFrac = totalThrust > 0 ? centerEngine.currentF / totalThrust : 0;
    const gimbalRad = (centerEngine.gimbalDeg * Math.PI / 180) * centerFrac;
    const tipShift = -1 * flameLen * Math.sin(gimbalRad);

    ctx.save();

    // --- Complex Gassy Volumetric Geometry Function ---
    // Instead of a simple shape, this defines turbulent, sprawling gas plumes.
    // It creates multiple billowing lobes expanding outwards from the main plume.
    function drawVolumetricPath(widthFactor, lengthFactor, tipShiftDisplacement, lobes) {
      const w = baseW * widthFactor;
      const l = flameLen * lengthFactor;
      const shift = tipShiftDisplacement;

      ctx.beginPath();
      // Start slightly inside the nozzle exit
      ctx.moveTo(-w / 2, 0);

      // Define billowing turbulent lobes expanding sideways and down.
      // This is not a blunt end, but a complex, sprawling gas plume.
      for (let i = 1; i <= lobes; i++) {
          const t = i / lobes;
          const lobe_w = w * (0.8 + 0.4 * t); // widening with length
          const lobe_y = l * (t);
          const lobe_x_displacement = shift * (t); // gimbal displacement is layered
          
          // Side lobes expanding laterally
          ctx.quadraticCurveTo(
              (-lobe_w / 2 + lobe_x_displacement) * (0.6 + 0.4 * Math.sin(t * 15 * flicker)), // turbulent offset
              lobe_y * (0.8 + 0.1 * Math.sin(t * 20 * flicker)), // turbulent depth
              -w / 2 * (1 - t), // return toward center
              lobe_y
          );
      }
      // Draw blunt end with some central plume structure
      ctx.quadraticCurveTo(shift, l * 1.05, w / 2 + shift * 0.95, l * 0.95);
      
      // Draw lobes on the other side
      for (let i = lobes; i >= 1; i--) {
          const t = i / lobes;
          const lobe_w = w * (0.8 + 0.4 * t);
          const lobe_y = l * (t);
          const lobe_x_displacement = shift * (t);
          
          ctx.quadraticCurveTo(
              (lobe_w / 2 + lobe_x_displacement) * (0.6 + 0.4 * Math.sin(t * 15 * flicker)), 
              lobe_y * (0.8 + 0.1 * Math.sin(t * 20 * flicker)),
              w / 2 * (1 - t), 
              lobe_y
          );
      }
      ctx.lineTo(w / 2, 0);
      ctx.closePath();
    }

    // --- Complex Volumetric Gas Layers (Layers 1-3) ---
    // Key change: High complexity gradients and varying blur create the gassy look.

    // Layer 1: Expansive, sprawling Outer Gassy Plume (Deep Orange/Red, widest)
    // High complexity path (more lobes) and higher blur. Engulfs everything.
    ctx.filter = 'blur(10px)'; // High blur for gas clouds
    drawVolumetricPath(1.5, 1.1, tipShift * 1.1, 15); // Large, massive, expansive path
    let g1 = ctx.createRadialGradient(0, 0, baseW, 0, flameLen, baseW * 3);
    g1.addColorStop(0, 'rgba(255, 90, 20, 0.45)'); 
    g1.addColorStop(0.5, 'rgba(255, 60, 10, 0.2)'); 
    g1.addColorStop(1, 'rgba(255, 40, 0, 0)');
    ctx.fillStyle = g1;
    ctx.fill();
    ctx.filter = 'none'; // reset filter for core layers

    // Layer 2: Contained Gassy Structure (Yellow/Orange, mid-width)
    // Mid complexity path, contained logic, medium blur.
    ctx.filter = 'blur(4px)'; 
    drawVolumetricPath(1.1, 1.0, tipShift * 1.0, 10);
    let g2 = ctx.createLinearGradient(0, 0, tipShift, flameLen * 1.0);
    g2.addColorStop(0, 'rgba(255, 200, 50, 1)'); // Yellow/Opaque structure
    g2.addColorStop(0.7, 'rgba(255, 140, 20, 0.9)'); 
    g2.addColorStop(1, 'rgba(255, 80, 0, 0)');
    ctx.fillStyle = g2;
    ctx.fill();
    ctx.filter = 'none';

    // Layer 3: Blinding White Gassy Hot Core (Shortest, sharpest)
    // Low complexity path, powerful logic, minimal blur.
    ctx.filter = 'blur(1px)';
    drawVolumetricPath(0.85, 0.94, tipShift * 0.94, 5); 
    let g3 = ctx.createLinearGradient(0, 0, tipShift, flameLen * 0.94);
    g3.addColorStop(0, 'rgba(255, 255, 255, 1)'); // Blinding white
    g3.addColorStop(0.85, 'rgba(255, 240, 200, 1)'); // White core stays opaque far down
    g3.addColorStop(1, 'rgba(255, 120, 50, 0)');
    ctx.fillStyle = g3;
    ctx.fill();
    ctx.filter = 'none';

    // Intense nozzle exit flare highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 1)';
    ctx.beginPath();
    ctx.ellipse(0, baseW * 0.1, baseW * 0.45, baseW * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }


  // ---- Body (realistic Falcon-9 colors: white hull, black interstage,
  // black grid fins/legs — no more transparent/neon schematic look) ----
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

  // subtle body-panel shading (slight left/right shadow, so it doesn't
  // read as a flat cut-out shape)
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

  // Interstage stripe (Falcon 9's black roll-reference band, just below the
  // nose taper) + a tiny 2-square checker mark for that unmistakable look.
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

  // Grid fins — small canted lattice fins just above the interstage, the
  // most recognizable Falcon 9 silhouette detail.
  const finY = -H * 0.845, finLen = W * 0.22, finH = H * 0.05;
  [-1, 1].forEach(side => {
    ctx.save();
    ctx.translate(side * W/2, finY);
    ctx.rotate(side * -0.12);
    ctx.fillStyle = '#1c1e22';
    ctx.strokeStyle = '#3a3d43';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.rect(0, -finH/2, side * finLen, finH); ctx.fill(); ctx.stroke();
    // lattice cross-hatching
    for (let i = 1; i <= 2; i++) {
      const gx = side * finLen * (i/3);
      ctx.beginPath(); ctx.moveTo(gx, -finH/2); ctx.lineTo(gx, finH/2); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(side*finLen, 0); ctx.stroke();
    ctx.restore();
  });

  // Folded landing-leg fairings near the base.
  const legY0 = -H * 0.02, legY1 = -H * 0.16, legOut = W * 0.10;
  [-1, 1].forEach(side => {
    ctx.fillStyle = '#1c1e22';
    ctx.strokeStyle = '#45484e';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(side * W/2, legY0);
    ctx.lineTo(side * (W/2 + legOut), legY0);
    ctx.lineTo(side * W/2, legY1);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  });

  // ---- RCS gas ejection — soft puffs, not a flat glow ----
  // Each pod has a FIXED-direction lateral nozzle (always ejects further
  // outward, away from the centerline — TL/BL eject left, TR/BR eject
  // right) plus a pair of vertical nozzles (up-facing and down-facing) that
  // CAN be selected either way depending on which force direction physics
  // requested this tick. We draw the lateral jet in its one fixed direction,
  // and the vertical jet in whichever direction matches the actual signed
  // Fy physics computed for that pod this tick — never a synthesized
  // "resultant" angled jet; a diagonal-firing pod is drawn as two separate
  // straight puffs, exactly like real fixed-direction RCS hardware.
  const firing = lastForces.firing || {};
  const pod = lastForces.pod || {};
  const corners = {
    TL: [-W/2, -(H - CONFIG.RCS_TOP_MARGIN/mpp)],
    TR: [ W/2, -(H - CONFIG.RCS_TOP_MARGIN/mpp)],
    BL: [-W/2, -(CONFIG.RCS_BOTTOM_MARGIN/mpp)],
    BR: [ W/2, -(CONFIG.RCS_BOTTOM_MARGIN/mpp)],
  };
  // Lateral nozzle: fixed by mounting side, always outward. Vertical nozzle
  // exhaust direction is the OPPOSITE of the force sign physics requested
  // (exhaust up -> force down, exhaust down -> force up), computed live.
  const lateralDir = { TL: [-1, 0], TR: [1, 0], BL: [-1, 0], BR: [1, 0] };
  const plumeLen = W * 0.6;
  const fEps = 1; // Newtons — ignore numerical noise
  function drawGasPuff(cx, cy, dir, seed) {
    const [dx, dy] = dir;
    const nx = -dy, ny = dx; // perpendicular, for spread
    const jitter = 1 + 0.10 * Math.sin(performance.now() * 0.05 + seed);
    const len = plumeLen * jitter;
    const tipX = cx + dx * len, tipY = cy + dy * len;
    const midX = cx + dx * len * 0.55, midY = cy + dy * len * 0.55;
    const spread = W * 0.05;

    // Soft tapered puff body, rounded off at the tip (quadratic curve)
    // rather than a hard triangle point, for a gas-cloud look.
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
    // Dark contrasting outline so the puff stays visible whether it's
    // drawn against the dark sky OR against the (now opaque, white) hull —
    // a plain light-blue fill alone can vanish against a white body.
    ctx.strokeStyle = 'rgba(10,35,50,0.55)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // A couple of small drifting puff blobs beyond the main cone, so it
    // reads as expanding gas rather than a flat painted wedge.
    ctx.fillStyle = 'rgba(190,235,255,0.35)';
    ctx.beginPath(); ctx.arc(midX, midY, spread*0.9*jitter, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(200,240,255,0.22)';
    ctx.beginPath(); ctx.arc(tipX, tipY, spread*1.1*jitter, 0, Math.PI*2); ctx.fill();

    // Bright nozzle-exit flare
    ctx.fillStyle = 'rgba(230,250,255,0.9)';
    ctx.beginPath(); ctx.arc(cx + dx*W*0.03, cy + dy*W*0.03, spread*0.6, 0, Math.PI*2); ctx.fill();
  }
  Object.keys(corners).forEach(k => {
    const [cx, cy] = corners[k];
    const p = pod[k] || { Fx: 0, Fy: 0 };
    // Lateral nozzle: fixed direction, full brightness whenever active this tick
    // (PWM gating already decided whether Fx is nonzero — no need to fade it).
    if (Math.abs(p.Fx) > fEps) drawGasPuff(cx, cy, lateralDir[k], k.charCodeAt(0));
    // Vertical nozzle: exhaust direction is opposite the commanded force sign.
    // Drawn slightly OUTSIDE the hull edge (not flush against it) — a jet
    // running exactly along the body's own outline blends into it and
    // reads as invisible, especially against the now-opaque white hull.
    if (Math.abs(p.Fy) > fEps) {
      const vDir = p.Fy > 0 ? [0, 1] : [0, -1]; // force+y(up) -> exhaust down; force-y(down) -> exhaust up
      const outX = cx + Math.sign(cx) * W * 0.05;
      drawGasPuff(outX, cy, vDir, k.charCodeAt(1) + 3);
    }
    ctx.fillStyle = firing[k] ? '#aef1ff' : '#2a2d33';
    ctx.beginPath(); ctx.arc(cx, cy, W*0.09, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,128,140,0.6)'; ctx.lineWidth = 0.7; ctx.stroke();
  });

  ctx.restore();
}

function renderFrame() {
  const r = Math.hypot(state.rx, state.ry);
  const altitude = altitudeFromR(r);
  drawSky(altitude);
  drawGrid();
  drawGroundLine();
  drawRocket();
}
