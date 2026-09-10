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
  ctx.fillRect(px0 - padHalfW, py0, padHalfW * 2, padH);
  ctx.strokeStyle = '#3f4349';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px0 - padHalfW, py0, padHalfW * 2, padH);
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
  // === REALISTIC ENGINE PLUME — matched to hot-fire test photography ===
  // Real exhaust plumes are a CONE that widens as it leaves the nozzle (not a
  // constant tube or a taper-to-a-point): a small blinding-hot throat right at
  // the nozzle, expanding into a broad, billowing, turbulent gas cloud. The
  // bright layers use additive ('lighter') blending so their light visibly
  // bleeds/glows into the surrounding smoke, matching the photos.
  // ============================================================================

  // ---- Flame (drawn first, behind body) ----
  const totalThrust = ENGINES.reduce((s, e) => s + e.currentF, 0);
  const maxThrust = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const totalThrottle = maxThrust > 0 ? totalThrust / maxThrust : 0;

  if (totalThrottle > 0.03) {
    const tNow = performance.now() * 0.01;
    const flameLen = H * (0.6 + 1.6 * totalThrottle);

    const centerEngine = ENGINES.find(e => e.isCenter);
    const centerFrac = totalThrust > 0 ? centerEngine.currentF / totalThrust : 0;
    const gimbalRad = (centerEngine.gimbalDeg * Math.PI / 180) * centerFrac;
    // Full-length shift for the entire flame (tip displacement)
    const fullShift = -flameLen * Math.sin(gimbalRad);

    // ---- Plume base width scales with how many engines are lit. ----
    // Falcon 9 octaweb: 1 center + 8 outer. A single Merlin nozzle is only
    // about 25–30% of the rocket's diameter, so:
    //   1 engine firing  -> thin single-nozzle jet (~0.30 × W)
    //   9 engines firing -> full-octaweb wall of fire (~1.00 × W)
    // Everything in between scales linearly. This makes the plume grow to
    // fill the base only when the whole cluster is really burning.
    const activeCount = ENGINES.filter(e => e.currentF > 1).length;
    const plumeScale = Math.min(1.0, 0.30 + 0.70 * Math.max(0, activeCount - 1) / 8);

    // Expanding, billowing, turbulent cone — width GROWS from startW at the
    // nozzle to endW at the tail. Edge wobble amplitude grows with distance
    // too, so it stays tight near the nozzle and gets progressively more
    // turbulent/cloud-like further out, just like the reference plumes.
    // The wobble phase runs on real time, so the gas visibly churns.
    // Takes 'layerShift' so each layer bends proportionally to its own length.
    function gasConePath(startW, endW, lenFrac, seed, segments, layerShift) {
      const l = flameLen * lenFrac;
      ctx.beginPath();
      ctx.moveTo(-startW / 2, 0);
      for (let i = 1; i <= segments; i++) {
        const f = i / segments;
        const y = l * f;
        const w = startW + (endW - startW) * f;
        const grow = 0.15 + 1.1 * f * f; // near-nozzle stays tight, tail billows
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

    // Layer 1 — outer smoke envelope: widest, softest, ordinary blending so
    // it reads as smoke (not extra light) at the very edge of the plume.
    // Starts at the engine cluster's real footprint (scaled by plumeScale),
    // then continues to widen as the gas expands.
    ctx.filter = 'blur(11px)';
    gasConePath(W * 1.0 * plumeScale, W * 2.7 * plumeScale, 1.0, 0, 14, fullShift * 1.0);
    const g1 = ctx.createLinearGradient(0, 0, fullShift * 1.0, flameLen * 1.0);
    g1.addColorStop(0, 'rgba(255,170,80,0.55)');
    g1.addColorStop(0.55, 'rgba(255,110,40,0.4)');
    g1.addColorStop(1, 'rgba(255,70,20,0)');
    ctx.fillStyle = g1;
    ctx.fill();
    ctx.filter = 'none';

    // A few drifting billow blobs along the outer edge — cauliflower-cloud
    // texture, animated so they roll outward over time.
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

    // Layer 2 — mid glow, additive so its light bleeds into the smoke above.
    // Also scaled by plumeScale to match the actual firing footprint.
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

    // Layer 3 — bright core, additive, hotter/whiter the harder it's throttled.
    // This is the layer viewers notice most, so it matters most that its
    // width matches the actual number of engines producing it.
    ctx.filter = 'blur(2px)';
    const shift68 = fullShift * 0.68;
    gasConePath(W * 0.58 * plumeScale, W * 1.05 * plumeScale, 0.68, 4.4, 9, shift68);
    const coreHot = 0.55 + 0.45 * totalThrottle; // more blue-white at high throttle
    const g3 = ctx.createLinearGradient(0, 0, shift68, flameLen * 0.68);
    g3.addColorStop(0, `rgba(${Math.round(255 - coreHot*15)},252,255,1)`);
    g3.addColorStop(0.55, 'rgba(255,240,215,0.85)');
    g3.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g3;
    ctx.fill();
    ctx.filter = 'none';

    // Layer 4 — blinding throat region right at the nozzle exits. Real
    // engines are individual small throats; when only one fires this reads
    // as a single tight bright dot, when nine fire it reads as a bright band.
    ctx.filter = 'blur(5px)';
    const shift22 = fullShift * 0.22;
    gasConePath(W * 0.42 * plumeScale, W * 0.55 * plumeScale, 0.22, 6.7, 6, shift22);
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.fill();
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';

    // Nozzle-exit hot spot — a wide additive flare across the cluster
    // footprint (was a small central dot). Width also scales with plumeScale
    // so a single-engine burn shows a compact glint, not a wide band.
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

    // ---- Landing legs — Falcon 9 exact stowed fairing & deployment geometry ----
  const legHingeY = -H * 0.02;     // Base hinge near engines
  const legLen = H * 0.28;         // Leg extends 28% up the body
  const p = legs.progress;         // 0 = stowed, 1 = fully deployed

  // Angle: 0 deg = folded straight UP along hull, 138 deg = deployed DOWN & OUT
  const deployAngleRad = (p * 138) * Math.PI / 180;

  [-1, 1].forEach(side => {
    // Hinge anchor point on the outer edge of the rocket hull
    const hx = side * (W / 2);
    const hy = legHingeY;

    // Direction vector along leg length
    const legDx = side * Math.sin(deployAngleRad);
    const legDy = -Math.cos(deployAngleRad); // -1 points UP, +1 points DOWN

    // Perpendicular vector for panel width/thickness
    const px = -legDy * side;
    const py = legDx * side;

    // Key points along the leg length
    const tx = hx + legDx * legLen;                  // Top cap / Foot tip
    const ty = hy + legDy * legLen;
    const midDist = legLen * 0.72;                   // Widest point of triangular panel
    const mx = hx + legDx * midDist;
    const my = hy + legDy * midDist;

    const wBase = W * 0.05;
    const wMax = W * 0.24;
    const wTip = W * 0.08;

    // 1. Hydraulic Telescoping Strut (Hidden when stowed, appears when deploying)
    if (p > 0.05) {
      const strutMountY = -H * 0.18;
      const strutMx = side * (W / 2);
      const strutMy = strutMountY;

      // Outer dark cylinder
      ctx.strokeStyle = '#23272e';
      ctx.lineWidth = Math.max(1, W * 0.035);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(strutMx, strutMy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // Inner silver extendable piston
      ctx.strokeStyle = '#d0d6dc';
      ctx.lineWidth = Math.max(1, W * 0.02);
      ctx.beginPath();
      ctx.moveTo(strutMx + (tx - strutMx) * 0.35, strutMy + (ty - strutMy) * 0.35);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    // 2. Main Carbon-Composite Triangular Leg Fairing (Solid panel like diagram)
    ctx.fillStyle = '#d6dbe2';  // Light metallic gray panel
    ctx.strokeStyle = '#5a626d';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(hx + px * wBase, hy + py * wBase);             // Base outer
    ctx.lineTo(mx + px * wMax, my + py * wMax);             // Outer bulge
    ctx.lineTo(tx + px * wTip, ty + py * wTip);             // Tip outer
    ctx.lineTo(tx - px * wTip, ty - py * wTip);             // Tip inner
    ctx.lineTo(mx - px * (wMax * 0.15), my - py * (wMax * 0.15)); // Inner edge along hull
    ctx.lineTo(hx - px * wBase, hy - py * wBase);             // Base inner
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 3. Bevel Shading / 3D Bevel Overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(mx + px * wMax, my + py * wMax);
    ctx.lineTo(tx, ty);
    ctx.closePath();
    ctx.fill();

    // 4. Top Circular Joint Cap (Reference photo me top par jo dark round cap hai)
    ctx.fillStyle = '#22252b';
    ctx.beginPath();
    ctx.arc(tx, ty, W * 0.07, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#8a929e';
    ctx.beginPath();
    ctx.arc(tx, ty, W * 0.03, 0, Math.PI * 2);
    ctx.fill();

    // 5. Bottom Hinge Pin
    ctx.fillStyle = '#22252b';
    ctx.beginPath();
    ctx.arc(hx, hy, W * 0.045, 0, Math.PI * 2);
    ctx.fill();
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
