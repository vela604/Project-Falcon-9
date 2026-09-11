// ============================================================================
// rocketArt.js — Shared vehicle artwork: airframe, checkerboard/stripe,
// grid fins, 4 landing legs, and the 4 RCS pods. This is the exact same
// drawing code the live flight simulator uses for the vehicle body (pulled
// out of render.js's drawRocket()), so a static preview elsewhere (home
// page "current vehicle" card, fleet page vehicle detail) renders as the
// literal same rocket, not a lookalike.
//
// Deliberately excludes the main-engine plume (that needs live ENGINES
// throttle/gimbal state from the running sim) — a static preview is drawn
// "idle" (no flame), which is exactly what an idle pad rocket looks like.
//
// Coordinate convention: origin at the vehicle's BASE (0,0), +Y is DOWN,
// nose is in -Y, spanning from y=0 (base) to y=-H (nose tip), width W
// centered on x=0 — matching render.js's drawRocket() local frame exactly,
// so callers only need a translate/rotate to place it; no separate math.
//
// ctx      - a 2D canvas context, already translated/rotated into place
// W, H     - vehicle width/height IN PIXELS at whatever scale the caller wants
// mpp      - meters-per-pixel at that scale (only used for the RCS pod
//            margins, which are specified in real meters in CONFIG)
// opts     - { legsProgress: 0..1 (default 0, stowed),
//              firing: {TL,TR,BL,BR} booleans (default none firing),
//              pod: {TL,TR,BL,BR}: {Fx,Fy} (default none),
//              legsState: optional object to record per-leg foot positions
//                         into (the live sim passes its `legs` state here;
//                         a static preview omits it) }
// ============================================================================
function drawRocketArt(ctx, W, H, mpp, opts) {
  opts = opts || {};
  const legsProgress = opts.legsProgress || 0;
  const legsState = opts.legsState || null;

  // ============================================================================
  // LEGS SETUP — 4 legs via shared helper
  // ============================================================================
  const p = legsProgress;
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

    if (!isBack && legsState) {
      const legActualLength = Math.hypot(tipApexX - pivotX, tipApexY - pivotY);
      if (!legsState.actualLength) {
        legsState.actualLength = {}; legsState.footX = {}; legsState.footY = {};
      }
      legsState.actualLength[side] = legActualLength;
      legsState.footX[side] = tipApexX;
      legsState.footY[side] = tipApexY;
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
  const firing = opts.firing || {};
  const pod = opts.pod || {};
  // RCS pod margins: explicit opts win (used by renderVehiclePreview() when
  // showing a specific fleet record), otherwise fall back to the globally
  // active CONFIG (used by the live simulator's own draw call).
  const rcsTopMargin = opts.rcsTopMargin !== undefined ? opts.rcsTopMargin : CONFIG.RCS_TOP_MARGIN;
  const rcsBottomMargin = opts.rcsBottomMargin !== undefined ? opts.rcsBottomMargin : CONFIG.RCS_BOTTOM_MARGIN;
  const corners = {
    TL: [-W/2, -(H - rcsTopMargin/mpp)],
    TR: [ W/2, -(H - rcsTopMargin/mpp)],
    BL: [-W/2, -(rcsBottomMargin/mpp)],
    BR: [ W/2, -(rcsBottomMargin/mpp)],
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

}

// ---------------------------------------------------------------------------
// Static vehicle preview — draws a vehicle at rest (legs stowed, no thrust,
// no RCS firing) onto any <canvas>, scaled to fill it at true aspect ratio.
// Used by the home page's "current vehicle" card and the fleet page's
// vehicle detail view, so both show the literal same artwork as the live
// simulator rather than a generic placeholder.
//
// `vehicle` is optional — an object with { height, width, rcsTopMargin,
// rcsBottomMargin } (real meters), e.g. a raw fleet record from fleet.js.
// Pass it explicitly when showing a specific record that may not be the
// currently-active one (the fleet page's editor). Omit it to fall back to
// the globally active CONFIG (the home page always shows the active/
// selected vehicle, so CONFIG already IS the right vehicle there).
//
// Sizing: the canvas's CSS WIDTH is the one fixed thing (set by the page's
// layout/CSS) — the rocket's width is always exactly 60% of it. Height then
// follows from the vehicle's true (undistorted) real-world height:width
// ratio, so the canvas HEIGHT is computed here and applied to the element,
// rather than being a fixed value — a short stubby vehicle gets a short
// canvas, a tall slender one gets a tall canvas, proportions untouched.
//
// Renders at the display's full devicePixelRatio — this is a cheap one-shot
// draw (not an animation loop), so there's no performance reason to render
// it any lower-res and let it look soft on high-DPI screens.
// ---------------------------------------------------------------------------
function renderVehiclePreview(canvas, vehicle) {
  if (!canvas) return;
  const v = vehicle || {
    height: CONFIG.ROCKET_HEIGHT, width: CONFIG.ROCKET_WIDTH,
    rcsTopMargin: CONFIG.RCS_TOP_MARGIN, rcsBottomMargin: CONFIG.RCS_BOTTOM_MARGIN,
  };
  const cssW = canvas.clientWidth || canvas.width;
  if (!cssW) return;

  // Rocket width = 60% of canvas width, fixed. Height follows from the
  // real height:width ratio at that same scale (mpp) — true proportion,
  // never stretched/squashed.
  const W = cssW * 0.50;
  const mpp = v.width / W;
  const H = v.height / mpp;

  // Small margin above/below the rocket; canvas height sized to fit exactly.
  const vMarginFrac = 0.94;
  const cssH = H / vMarginFrac;
  canvas.style.height = cssH + 'px';

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const pctx = canvas.getContext('2d');
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, cssW, cssH);

  const baseX = cssW / 2;
  const baseY = (cssH - H) / 2 + H; // top margin == bottom margin

  pctx.save();
  pctx.translate(baseX, baseY);
  drawRocketArt(pctx, W, H, mpp, { rcsTopMargin: v.rcsTopMargin, rcsBottomMargin: v.rcsBottomMargin });
  pctx.restore();
}
