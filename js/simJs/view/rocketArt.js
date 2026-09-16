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
//              firing: { [podId]: boolean } (default none firing),
//              pod: { [podId]: {Fx,Fy} } (default none),
//              legsState: optional object to record per-leg foot positions
//                         into (the live sim passes its `legs` state here;
//                         a static preview omits it) }
//            `firing`/`pod` are keyed by whatever pod ids the active RCS
//            type declares (CONFIG.RCS_TYPE.frame.pods) — TL/TR/BL/BR for
//            the built-in 4-corner type, but this file never assumes those
//            literal names (see PHASE2_PROMPT.md Step E).
// ============================================================================

// ============================================================================
// Gradient cache — several gradients in this file are a pure function of a
// pixel width/radius (cylinder body shading, dish, interstage band): same
// coordinates, same fixed color stops, every time W is the same. They were
// being rebuilt from scratch every frame for every member of every body.
// Cached per-canvas-context (WeakMap, so it never leaks a dead canvas) and
// keyed by the rounded value that actually determines the gradient, so a
// cache hit is byte-identical to a fresh build — no visual change, just
// skips rebuilding it when nothing that affects it (i.e. zoom) has moved.
// Only used for gradients with fixed color stops; anything whose *colors*
// change frame-to-frame (flame/plume, throttle-driven effects) is left
// alone since caching those wouldn't help and risks staleness.
// ============================================================================
const _gradCache = new WeakMap(); // ctx -> Map("key:sig" -> CanvasGradient)
function cachedGradient(ctx, key, sig, build) {
  let bucket = _gradCache.get(ctx);
  if (!bucket) { bucket = new Map();
    _gradCache.set(ctx, bucket); }
  const fullKey = key + ':' + sig;
  let grad = bucket.get(fullKey);
  if (grad) return grad;
  // Safety net: continuous zoom sweeps through many rounded-width values
  // over a session. Bounded already (pixel widths are a small finite
  // range), but reset if it ever grows large so this never accumulates.
  if (bucket.size > 500) bucket.clear();
  grad = build();
  bucket.set(fullKey, grad);
  return grad;
}

// ============================================================================
// PS-A — Payload space (fairing) shape renderer.
//
// Draws ONLY the fairing silhouette — no body, no legs, no RCS, no engines.
// Standalone: not yet called from any fleet record path (that's PS-C/PS-D).
// Coordinate convention matches drawRocketArt exactly: origin at the
// member's own BASE (0,0), +Y down, nose tip at (0, -H).
//
// Two `kind`s, both driven entirely by formulas over opts (Rule 5 — no
// hardcoded fractions):
//
//   noseCapShape   — smooth ogive straight from base width to a rounded tip.
//
//   bulgedCapShape — base → frustum (straight taper, angle = frustumAngleDeg
//                    from horizontal) → straight cylinder (variable height)
//                    → ogive → rounded tip. Section heights:
//                      frustumH  = |bulgeR - capR| / tan(frustumAngleDeg)
//                      curveH    = curveRatio × bulgeR
//                      straightH = max(0, H - frustumH - curveH)
//                    If the two mandatory sections (frustum + ogive) alone
//                    exceed the available height H, both are scaled down
//                    proportionally so the shape still fits — the straight
//                    section is simply the first to vanish, exactly like
//                    "dummy value first" degrades gracefully rather than
//                    drawing something invalid.
//
// opts read:
//   payloadKind            'noseCapShape' | 'bulgedCapShape' (default noseCapShape)
//   payloadCapWidth        base diameter, meters (falls back to W×mpp)
//   payloadBulgeWidth      max bulge diameter, meters (bulged kind only;
//                          falls back to payloadCapWidth, i.e. no bulge)
//   payloadFrustumAngleDeg frustum angle from horizontal, degrees (default 45)
//   payloadCurveRatio      top-curve height / bulge radius (default 0.85)
//   payloadColor           '#rrggbb' fill (default '#e9edf2')
// ============================================================================
function drawPayloadSpaceShape(ctx, W, H, mpp, opts) {
  opts = opts || {};
  const kind = opts.payloadKind || 'noseCapShape';
  const color = opts.payloadColor || '#e9edf2';
  
  // Dimensions arrive in METERS (matching every other params-bag field in
  // this codebase) and get converted to px here via mpp — mirrors the
  // capW_px/bulgeW_px conversion already used by drawStageBody's inline
  // payload renderer. Falls back to the member's own W (already px) when a
  // specific field isn't supplied, so an incomplete opts bag still degrades
  // to a plain cone sized to the member's own bounding box instead of NaN.
  const capWidth_m = Number.isFinite(opts.payloadCapWidth) ? opts.payloadCapWidth : W * mpp;
  const capR = (capWidth_m / 2) / mpp; // px
  
  const isBulged = kind === 'bulgedCapShape';
  let bulgeR = capR; // no-bulge fallback for the gradient-width calc below
  
  const bodyPath = () => {
    ctx.beginPath();
    if (isBulged) {
      const bulgeWidth_m = Number.isFinite(opts.payloadBulgeWidth) ? opts.payloadBulgeWidth : capWidth_m;
      bulgeR = (bulgeWidth_m / 2) / mpp;
      const frustumAngleDeg = Number.isFinite(opts.payloadFrustumAngleDeg) ? opts.payloadFrustumAngleDeg : 45;
      const curveRatio = Number.isFinite(opts.payloadCurveRatio) ? opts.payloadCurveRatio : 0.85;
      
      // Formula-derived section heights — see header comment.
      const angleRad = Math.max(1, Math.min(89, frustumAngleDeg)) * Math.PI / 180;
      let frustumH = Math.abs(bulgeR - capR) / Math.tan(angleRad);
      let curveH = curveRatio * bulgeR;
      const mandatory = frustumH + curveH;
      if (mandatory > H && mandatory > 0) {
        const s = H / mandatory;
        frustumH *= s;
        curveH *= s;
      }
      const straightH = Math.max(0, H - frustumH - curveH);
      
      const baseY = 0;
      const frustumTopY = -frustumH;
      const straightTopY = frustumTopY - straightH;
      const tipY = -H;
      
      // Left side: base → frustum → straight → ogive → tip
      ctx.moveTo(-capR, baseY);
      ctx.lineTo(-bulgeR, frustumTopY);
      ctx.lineTo(-bulgeR, straightTopY);
      ctx.bezierCurveTo(
        -bulgeR * 0.98, straightTopY - curveH * 0.30,
        -bulgeR * 0.45, tipY + curveH * 0.15,
        0, tipY
      );
      // Right side: tip → ogive → straight → frustum → base
      ctx.bezierCurveTo(
        bulgeR * 0.45, tipY + curveH * 0.15,
        bulgeR * 0.98, straightTopY - curveH * 0.30,
        bulgeR, straightTopY
      );
      ctx.lineTo(bulgeR, frustumTopY);
      ctx.lineTo(capR, baseY);
    } else {
      // noseCapShape: smooth ogive straight from base width to a rounded tip.
      const tipY = -H;
      ctx.moveTo(-capR, 0);
      ctx.bezierCurveTo(
        -capR * 0.70, H * 0.30,
        -capR * 0.30, tipY + H * 0.20,
        0, tipY
      );
      ctx.bezierCurveTo(
        capR * 0.30, tipY + H * 0.20,
        capR * 0.70, H * 0.30,
        capR, 0
      );
    }
    ctx.closePath();
  };
  
  ctx.fillStyle = color;
  ctx.strokeStyle = '#8b93a0';
  ctx.lineWidth = 1.2;
  bodyPath();
  ctx.fill();
  ctx.stroke();
  
  // DSL overlay (clipped to fairing silhouette).
  const bodyDesign = opts.bodyDesign || { mode: 'solid', dslText: '' };
  if ((bodyDesign.mode || 'solid') === 'dsl' &&
    typeof parseAndValidateDesign === 'function' &&
    typeof drawCustomDesignOps === 'function') {
    const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
    if (parsed.ok && parsed.ops.length) {
      const widestW_px = Math.max(capR, bulgeR) * 2;
      ctx.save();
      bodyPath();
      ctx.clip();
      drawCustomDesignOps(ctx, widestW_px, H, parsed.ops);
      ctx.restore();
    }
  }
  
  if (typeof applyCylindricalOverlay === 'function') {
    const gradW = Math.max(capR, bulgeR) * 2;
    bodyPath();
    applyCylindricalOverlay(ctx, gradW);
  }
}


// Payload art — compact satellite with folded solar panels + small dish.
function drawPayloadArt(ctx, W, H) {
  // ---- Folded solar panels (thin, hugging the body sides) ----
  const panelW = W * 0.15;
  const panelH = H * 0.7;
  const panelY = -H * 0.85;
  [-1, 1].forEach(side => {
    const px = side > 0 ? W / 2 : -(W / 2 + panelW);
    const pg = ctx.createLinearGradient(px, 0, px + panelW, 0);
    pg.addColorStop(0, '#1a3050');
    pg.addColorStop(0.5, '#2c5a8a');
    pg.addColorStop(1, '#0a1520');
    ctx.fillStyle = pg;
    ctx.fillRect(px, panelY, panelW, panelH);
    ctx.strokeStyle = '#0a1520';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(px, panelY, panelW, panelH);
    // Horizontal grid lines (folded cells)
    ctx.strokeStyle = 'rgba(120,180,255,0.4)';
    ctx.lineWidth = 0.4;
    for (let i = 1; i < 5; i++) {
      const gy = panelY + (panelH * i / 5);
      ctx.beginPath();
      ctx.moveTo(px, gy);
      ctx.lineTo(px + panelW, gy);
      ctx.stroke();
    }
  });
  
  // ---- Main body ----
  const bg = cachedGradient(ctx, 'mainBody', Math.round(W), () => {
    const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
    g.addColorStop(0, '#4a4e54');
    g.addColorStop(0.5, '#c8d0d8');
    g.addColorStop(1, '#3a3d43');
    return g;
  });
  ctx.fillStyle = bg;
  ctx.fillRect(-W / 2, -H, W, H);
  ctx.strokeStyle = '#1c1e22';
  ctx.lineWidth = 1;
  ctx.strokeRect(-W / 2, -H, W, H);
  
  // Body seams
  ctx.strokeStyle = 'rgba(20,24,30,0.4)';
  ctx.lineWidth = 0.5;
  [-0.25, 0.25].forEach(f => {
    const y = -H * (0.5 + f);
    ctx.beginPath();
    ctx.moveTo(-W / 2, y);
    ctx.lineTo(W / 2, y);
    ctx.stroke();
  });
  
  // Small dish on top edge
  const dishR = W * 0.18;
  ctx.save();
  ctx.translate(0, -H);
  ctx.beginPath();
  ctx.arc(0, 0, dishR, Math.PI, 0, false);
  const dg = cachedGradient(ctx, 'topDish', Math.round(dishR), () => {
    const g = ctx.createRadialGradient(0, 0, dishR * 0.1, 0, 0, dishR);
    g.addColorStop(0, '#e8eef5');
    g.addColorStop(1, '#606870');
    return g;
  });
  ctx.fillStyle = dg;
  ctx.fill();
  ctx.strokeStyle = '#1c1e22';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
  
  // Nozzle at base
  const nzW = W * 0.35;
  const nzH = H * 0.08;
  ctx.fillStyle = '#1c1e22';
  ctx.beginPath();
  ctx.moveTo(-nzW / 2, 0);
  ctx.lineTo(-nzW / 2 * 0.6, nzH);
  ctx.lineTo(nzW / 2 * 0.6, nzH);
  ctx.lineTo(nzW / 2, 0);
  ctx.closePath();
  ctx.fill();
  
  // Small blinking beacon
  const blink = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
  ctx.fillStyle = `rgba(255,60,50,${blink})`;
  ctx.beginPath();
  ctx.arc(0, -H * 0.55, W * 0.05, 0, Math.PI * 2);
  ctx.fill();
}


function drawRocketArt(ctx, W, H, mpp, opts) {
  opts = opts || {};
  const legsProgress = opts.legsProgress || 0;
  const legsState = opts.legsState || null;
  
  // P4-D3: body appearance + nose shape + role flags.
  const noseCurveness = opts.noseCurveness || 0;
  const isBooster = opts.stageRole === 'booster';
  const isNose = opts.stageRole === 'nose';
  const isPayloadSpace = opts.stageRole === 'payloadSpace';
  
  const bodyDesign = opts.bodyDesign || { mode: 'solid', solidColor: '#e9edf2', dslText: '' };
  const designMode = bodyDesign.mode || 'solid';
  const solidFill = bodyDesign.solidColor || '#e9edf2';
  
  // ---- Payload space role: pure fairing shape, early exit. ----
  // PS-A: standalone shape renderer — no body/legs/RCS/engines for this
  // role. Not yet reachable from any fleet record (that wiring is PS-C/D);
  // this branch only fires when a caller explicitly passes
  // stageRole: 'payloadSpace', same pattern as the nose early-exit below.
  if (isPayloadSpace) {
    drawPayloadSpaceShape(ctx, W, H, mpp, opts);
    return;
  }
  
  // ---- Nose role: pure cone, early exit. ----
  if (isNose) {
    const c = Math.max(0, Math.min(1, noseCurveness));
    const ctrlx = -W / 4 + c * (-W / 4);
    const ctrly = -H / 2 + c * (-H / 2);
    
    const conePath = () => {
      ctx.beginPath();
      ctx.moveTo(-W / 2, 0);
      ctx.quadraticCurveTo(ctrlx, ctrly, 0, -H);
      ctx.quadraticCurveTo(-ctrlx, ctrly, W / 2, 0);
      ctx.closePath();
    };
    
    ctx.fillStyle = solidFill;
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    conePath();
    ctx.fill();
    ctx.stroke();
    
    if (typeof applyCylindricalOverlay === 'function') {
      conePath();
      applyCylindricalOverlay(ctx, W);
    }
    
    // DSL for nose (if allowed — currently nose role is solid only, but
    // keep the hook so future support is drop-in).
    if (designMode === 'dsl' && typeof parseAndValidateDesign === 'function' &&
      typeof drawCustomDesignOps === 'function') {
      const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
      if (parsed.ok && parsed.ops.length) {
        ctx.save();
        conePath();
        ctx.clip();
        drawCustomDesignOps(ctx, W, H, parsed.ops);
        conePath();
        if (typeof applyCylindricalOverlay === 'function') applyCylindricalOverlay(ctx, W);
        ctx.restore();
      }
    }
    return;
  }
  
  // ---- Legs setup ----
  const recoveryType = ('recoveryType' in opts) ?
    opts.recoveryType :
    ((typeof CONFIG !== 'undefined') ? CONFIG.RECOVERY_TYPE : null);
  const showLegs = !!(recoveryType && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle);
  const hingeGeometryFn = (recoveryType && recoveryType.frame && typeof recoveryType.frame.hingeGeometry === 'function') ?
    recoveryType.frame.hingeGeometry :
    null;
  if (showLegs && !hingeGeometryFn) {
    console.warn(`drawRocketArt: recovery type "${recoveryType.id}" declares deploysOnVehicle but has no frame.hingeGeometry() — legs skipped this frame.`);
  }
  const legGeo = hingeGeometryFn ? hingeGeometryFn(H) : null;
  const legCount = (recoveryType && recoveryType.frame && recoveryType.frame.legCount) || 4;
  if (showLegs && legGeo && legCount !== 4) {
    console.warn(`drawRocketArt: recovery type "${recoveryType.id}" has legCount ${legCount}, but leg artwork is still only implemented for the 4-leg illusion — drawing 4 legs anyway.`);
  }
  
  // ---- Engine bell (stage, standalone) + interstage (booster top) ----
  // Both sizes derive from the engine layout's total mass flow rate:
  //   bellHeight = 0.007 × totalMassFlowRate    (m, per nozzle)
  //   bellRadius = bellHeight / 2
  //   interstageHeight = bellHeight × 1.20      (bell + margin)
  //   interstageDiameter = booster width (fixed)
  //
  // For multi-nozzle layouts (octaweb), we draw one small bell per outer
  // engine + a slightly bigger centre bell — the visible cluster. For a
  // single-nozzle layout, one bell.
  const engineLayout = opts.engineLayout || null;
  const engineBell = (() => {
    if (!engineLayout || !engineLayout.frame || !engineLayout.frame.slots) return null;
    const totalFlow = (() => {
      const groups = (typeof engineThrusterGroups === 'function') ? engineThrusterGroups(engineLayout) : {};
      let sum = 0;
      Object.keys(groups).forEach(gk => {
        const g = opts.engineThrusters && opts.engineThrusters[gk];
        if (!g || !Number.isFinite(g.massFlowRate)) return;
        sum += g.massFlowRate * groups[gk].length;
      });
      return sum;
    })();
    if (totalFlow <= 0) return null;
    const nSlots = engineLayout.frame.slots.length;
    const perEngineFlow = totalFlow / nSlots;
    const h = 0.007 * perEngineFlow;
    return { h, r: h / 2, count: nSlots, slots: engineLayout.frame.slots };
  })();
  
  
  const p = legsProgress;
  const legHingeY = legGeo ? legGeo.hingeY : -H * 0.004;
  const legLength = legGeo ? legGeo.legLength : H * 0.27;
  const maxSweepRad = legGeo ? legGeo.maxSweepRad : (125 * Math.PI) / 180;
  const pistonMountY = legGeo ? legGeo.pistonMountY : -H * 0.08;
  const LEG_TIP_CURVENESS = 0.90;
  
  function drawLandingLeg(side, isBack) {
    const depthX = isBack ? 0.75 : 1.0;
    const depthY = isBack ? -H * 0.006 : 0;
    
    const j1x = side * (W * 0.49) * depthX;
    const j2x = side * (W * 0.05) * depthX;
    const jY = legHingeY + depthY;
    
    const pivotX = Math.sin(Math.PI / 4) * (j1x + j2x) / 1;
    const pivotY = jY;
    
    const currentSweep = side * p * maxSweepRad;
    const tipX = pivotX + legLength * Math.sin(currentSweep);
    const tipY = pivotY - legLength * Math.cos(currentSweep);
    
    const cutoutApexX = pivotX + (tipX - pivotX) * 0.07;
    const cutoutApexY = pivotY + (tipY - pivotY) * 0.07;
    
    const d1 = Math.hypot(tipX - j1x, tipY - jY) || 1;
    const u1x = (j1x - tipX) / d1,
      u1y = (jY - tipY) / d1;
    const d2 = Math.hypot(tipX - j2x, tipY - jY) || 1;
    const u2x = (j2x - tipX) / d2,
      u2y = (jY - tipY) / d2;
    const roundR = Math.min(legLength * LEG_TIP_CURVENESS, d1 * 0.85, d2 * 0.85);
    const p1x = tipX + u1x * roundR,
      p1y = tipY + u1y * roundR;
    const p2x = tipX + u2x * roundR,
      p2y = tipY + u2y * roundR;
    
    const tipApexX = 0.25 * p1x + 0.5 * tipX + 0.25 * p2x;
    const tipApexY = 0.25 * p1y + 0.5 * tipY + 0.25 * p2y;
    
    if (!isBack && legsState) {
      const legActualLength = Math.hypot(tipApexX - pivotX, tipApexY - pivotY);
      if (!legsState.actualLength) {
        legsState.actualLength = {};
        legsState.footX = {};
        legsState.footY = {};
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
      ctx.beginPath();
      ctx.moveTo(pmX, pmY);
      ctx.lineTo(tipApexX, tipApexY);
      ctx.stroke();
      
      ctx.strokeStyle = isBack ? '#171b22' : '#2c313a';
      ctx.lineWidth = Math.max(0.8, W * 0.018);
      ctx.beginPath();
      ctx.moveTo(pmX, pmY);
      ctx.lineTo(tipApexX, tipApexY);
      ctx.stroke();
      
      const rodStartFrac = 0.32;
      const rx1 = pmX + (tipApexX - pmX) * rodStartFrac;
      const ry1 = pmY + (tipApexY - pmY) * rodStartFrac;
      
      ctx.strokeStyle = isBack ? '#8a9099' : '#e6ecf2';
      ctx.lineWidth = Math.max(1, W * 0.022);
      ctx.beginPath();
      ctx.moveTo(rx1, ry1);
      ctx.lineTo(tipApexX, tipApexY);
      ctx.stroke();
      
      ctx.fillStyle = isBack ? '#0d1015' : '#1a1e24';
      ctx.beginPath();
      ctx.arc(rx1, ry1, W * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
    
    const legGrad = ctx.createLinearGradient(pivotX, jY, tipX, tipY);
    if (isBack) {
      legGrad.addColorStop(0, '#0f1114');
      legGrad.addColorStop(0.35, '#1a1d22');
      legGrad.addColorStop(0.7, '#08090b');
      legGrad.addColorStop(1, '#000000');
    } else {
      legGrad.addColorStop(0, '#1c1f24');
      legGrad.addColorStop(0.35, '#3a3f47');
      legGrad.addColorStop(0.7, '#14171b');
      legGrad.addColorStop(1, '#000000');
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
  
  // BACK legs
  if (showLegs) {
    drawLandingLeg(-1, true);
    drawLandingLeg(1, true);
  }
  
  // ---- Body ----
  // Three visual cases:
  //   - stage with payloadSpace: tank rectangle + payload shape (cone or bulged)
  //   - booster: flat-top rectangle + interstage lip
  //   - rocket/legacy: cylinder + nose curve
  if (opts.stageRole === 'stage' && opts.stagePayload) {
    drawStageBody();
  } else {
    const bodyPath = () => {
      ctx.beginPath();
      ctx.moveTo(-W / 2, 0);
      if (isBooster) {
        ctx.lineTo(-W / 2, -H);
        ctx.lineTo(W / 2, -H);
        ctx.lineTo(W / 2, 0);
      } else {
        const c = Math.max(0, Math.min(1, noseCurveness));
        const shoulderY = -H * 0.85;
        const ctrlA0x = -W * 0.25,
          ctrlA0y = shoulderY * 0.5 + (-H) * 0.5;
        const ctrlA1x = -W * 0.5,
          ctrlA1y = -H;
        const ctrlAx = ctrlA0x + c * (ctrlA1x - ctrlA0x);
        const ctrlAy = ctrlA0y + c * (ctrlA1y - ctrlA0y);
        ctx.lineTo(-W / 2, shoulderY);
        ctx.quadraticCurveTo(ctrlAx, ctrlAy, 0, -H);
        ctx.quadraticCurveTo(-ctrlAx, ctrlAy, W / 2, shoulderY);
        ctx.lineTo(W / 2, 0);
      }
      ctx.closePath();
    };
    
    ctx.fillStyle = solidFill;
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    bodyPath();
    ctx.fill();
    ctx.stroke();
    
    if (designMode !== 'dsl') {
      const shade = cachedGradient(ctx, 'cylShade', Math.round(W), () => {
        const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.14)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        g.addColorStop(1, 'rgba(0,0,0,0.20)');
        return g;
      });
      ctx.fillStyle = shade;
      bodyPath();
      ctx.fill();
    }
    
    if (designMode === 'dsl' && typeof parseAndValidateDesign === 'function' &&
      typeof drawCustomDesignOps === 'function' &&
      typeof applyCylindricalOverlay === 'function') {
      const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
      if (parsed.ok && parsed.ops.length) {
        ctx.save();
        bodyPath();
        ctx.clip();
        drawCustomDesignOps(ctx, W, H, parsed.ops);
        bodyPath();
        applyCylindricalOverlay(ctx, W);
        ctx.restore();
      } else {
        const shade = cachedGradient(ctx, 'cylShade', Math.round(W), () => {
          const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.14)');
          g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
          g.addColorStop(1, 'rgba(0,0,0,0.20)');
          return g;
        });
        ctx.fillStyle = shade;
        bodyPath();
        ctx.fill();
      }
    }
  }
  
  // ---- Stage body renderer: tank section + payload-space (nose) section ----
  function drawStageBody() {
    const payload = opts.stagePayload;
    const tankH_m = payload.tankHeight || 0;
    const capH_m = payload.capHeight || 0;
    const total_m = tankH_m + capH_m;
    // Scale so tank + payload exactly fill the member's visual height H,
    // even if the input dims don't quite sum to the record height.
    const tankH_px = total_m > 0 ? (tankH_m / total_m) * H : H * 0.75;
    const capH_px = H - tankH_px;
    
    // Widths in pixels; bulge can exceed W (fairing overhang).
    const capW_px = (payload.capWidth || 0) / mpp;
    const bulgeW_px = (payload.bulgeWidth || payload.capWidth || 0) / mpp;
    const payloadColor = payload.color || '#e9edf2';
    
    // ---- Tank section (rectangle, solidFill + cylinder gradient) ----
    const tankPath = () => {
      ctx.beginPath();
      ctx.rect(-W / 2, -tankH_px, W, tankH_px);
    };
    tankPath();
    ctx.fillStyle = solidFill;
    ctx.fill();
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    
    if (designMode !== 'dsl') {
      const g = cachedGradient(ctx, 'cylShade', Math.round(W), () => {
        const grad = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0.14)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        grad.addColorStop(1, 'rgba(0,0,0,0.20)');
        return grad;
      });
      ctx.fillStyle = g;
      tankPath();
      ctx.fill();
    } else if (typeof parseAndValidateDesign === 'function' &&
      typeof drawCustomDesignOps === 'function' &&
      typeof applyCylindricalOverlay === 'function') {
      const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
      if (parsed.ok && parsed.ops.length) {
        ctx.save();
        tankPath();
        ctx.clip();
        // DSL is relative to the tank section only (Y 0..1 = tank base..tank top).
        drawCustomDesignOps(ctx, W, tankH_px, parsed.ops);
        tankPath();
        applyCylindricalOverlay(ctx, W);
        ctx.restore();
      }
    }
    
    // ---- Payload space (the stage's nose) ----
    const payloadPath = () => {
      ctx.beginPath();
      const baseY = -tankH_px; // top of tank
      const tipY = -H; // payload tip
      const halfCapW = capW_px / 2;
      const halfBulgeW = bulgeW_px / 2;
      const isBulged = payload.kind === 'bulgedCapShape';
      
      if (isBulged) {
        // Four-section real fairing profile:
        //   base   → frustum (straight outward) → cylinder (bulge width held)
        //          → ogive (bezier to point)
        //
        // Frustum and cylinder heights are fractions of the total payload
        // height, and the ogive takes the rest. All fractions tuned to
        // match a typical real fairing silhouette.
        const frustumFrac = 0.22; // bottom 22% widens out
        const cylinderFrac = 0.28; // next 28% holds bulge width
        // Remaining 50% is the ogive.
        
        const frustumH = capH_px * frustumFrac;
        const cylinderH = capH_px * cylinderFrac;
        const ogiveH = capH_px - frustumH - cylinderH;
        
        const frustumTopY = baseY - frustumH;
        const cylinderTopY = frustumTopY - cylinderH;
        
        // Left side: base → frustum → cylinder → ogive → tip
        ctx.moveTo(-halfCapW, baseY);
        ctx.lineTo(-halfBulgeW, frustumTopY); // frustum (straight)
        ctx.lineTo(-halfBulgeW, cylinderTopY); // cylinder (straight vertical)
        ctx.bezierCurveTo(
          -halfBulgeW * 0.98, cylinderTopY - ogiveH * 0.30,
          -halfBulgeW * 0.45, tipY + ogiveH * 0.15,
          0, tipY
        );
        // Right side: tip → ogive → cylinder → frustum → base
        ctx.bezierCurveTo(
          halfBulgeW * 0.45, tipY + ogiveH * 0.15,
          halfBulgeW * 0.98, cylinderTopY - ogiveH * 0.30,
          halfBulgeW, cylinderTopY
        );
        ctx.lineTo(halfBulgeW, frustumTopY);
        ctx.lineTo(halfCapW, baseY);
      } else {
        // Simple nose cap: smooth ogive from base width to a point, no bulge,
        // no cylinder section.
        ctx.moveTo(-halfCapW, baseY);
        ctx.bezierCurveTo(
          -halfCapW * 0.70, baseY + capH_px * 0.30,
          -halfCapW * 0.30, tipY + capH_px * 0.20,
          0, tipY
        );
        ctx.bezierCurveTo(
          halfCapW * 0.30, tipY + capH_px * 0.20,
          halfCapW * 0.70, baseY + capH_px * 0.30,
          halfCapW, baseY
        );
      }
      ctx.closePath();
    };
    
    payloadPath();
    ctx.fillStyle = payloadColor;
    ctx.fill();
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    
    // Cylindrical gradient over the payload (widest width = bulge or cap).
    const gradW = Math.max(capW_px, bulgeW_px) || W;
    const pGrad = cachedGradient(ctx, 'cylShade', Math.round(gradW), () => {
      const g = ctx.createLinearGradient(-gradW / 2, 0, gradW / 2, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.14)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
      g.addColorStop(1, 'rgba(0,0,0,0.20)');
      return g;
    });
    ctx.fillStyle = pGrad;
    payloadPath();
    ctx.fill();
  }
  
  // ---- Booster interstage lip + fins, or checkerboard + fins ----
  const drawGridFins = (finY) => {
    const finLen = W * 0.22,
      finH = H * 0.05;
    [-1, 1].forEach(side => {
      ctx.save();
      ctx.translate(side * W / 2, finY);
      ctx.rotate(side * -0.12);
      ctx.fillStyle = '#1c1e22';
      ctx.strokeStyle = '#3a3d43';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.rect(0, -finH / 2, side * finLen, finH);
      ctx.fill();
      ctx.stroke();
      for (let i = 1; i <= 2; i++) {
        const gx = side * finLen * (i / 3);
        ctx.beginPath();
        ctx.moveTo(gx, -finH / 2);
        ctx.lineTo(gx, finH / 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(side * finLen, 0);
      ctx.stroke();
      ctx.restore();
    });
  };
  
  if (isBooster) {
    // ---- Interstage: black cylinder at the booster top. Sized to cover the
    // stage engine bell above it (bellHeight × 1.20) with a floor so it's
    // always visible even without a stage stacked. Diameter = booster width.
    // Replaces the old flat lip band.
    const defaultH = 0.06 * H; // 6% booster if no stage above
    const bellH_m = (opts.stageAboveBellHeight && opts.stageAboveBellHeight > 0) ?
      opts.stageAboveBellHeight : 0;
    const interstageH_target_m = Math.max(bellH_m * 1.20, defaultH * mpp);
    const interstageH_px = Math.min(H * 0.20, interstageH_target_m / mpp);
    
    // Black band filling the top of the booster, flush with the flat top edge.
    const isGrad = cachedGradient(ctx, 'interstage', Math.round(W), () => {
      const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
      g.addColorStop(0, '#0a0c10');
      g.addColorStop(0.5, '#2a2d33');
      g.addColorStop(1, '#0a0c10');
      return g;
    });
    ctx.fillStyle = isGrad;
    ctx.fillRect(-W / 2, -H, W, interstageH_px);
    
    // Bottom edge seam (where the interstage meets the booster tank).
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.60)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-W / 2, -H + interstageH_px);
    ctx.lineTo(W / 2, -H + interstageH_px);
    ctx.stroke();
    
    // Top edge highlight (very thin — reads as the upper rim).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-W / 2, -H + 0.5);
    ctx.lineTo(W / 2, -H + 0.5);
    ctx.stroke();
    
    // Grid fins just below the interstage.
    // Grid fins sit right at the interstage's bottom edge (where the
    // interstage meets the tank).
    drawGridFins(-H + interstageH_px);
    
  } else if (opts.stageRole !== 'stage') {
    // Rocket / legacy rocket: checkerboard stripe + grid fins near the
    // shoulder. Stage is skipped entirely — its payload space IS the
    // visual top.
    const stripeTop = -H * 0.80,
      stripeBottom = -H * 0.72;
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-W / 2, stripeTop, W, stripeBottom - stripeTop);
    const chk = W * 0.16,
      chkY = (stripeTop + stripeBottom) / 2 - chk / 2;
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(-chk, chkY, chk, chk);
    ctx.fillRect(0, chkY, chk, chk);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-chk, chkY, chk, chk / 2);
    ctx.fillRect(-chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    ctx.fillRect(0, chkY, chk, chk / 2);
    ctx.fillRect(chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    
    drawGridFins(-H * 0.845);
  }
  // stage role: no fins / no checkerboard — payload space is the visual top.
  // stage role: no fins / no checkerboard.
  else {
    const stripeTop = -H * 0.80,
      stripeBottom = -H * 0.72;
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-W / 2, stripeTop, W, stripeBottom - stripeTop);
    const chk = W * 0.16,
      chkY = (stripeTop + stripeBottom) / 2 - chk / 2;
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(-chk, chkY, chk, chk);
    ctx.fillRect(0, chkY, chk, chk);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-chk, chkY, chk, chk / 2);
    ctx.fillRect(-chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    ctx.fillRect(0, chkY, chk, chk / 2);
    ctx.fillRect(chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    
    if (opts.stageRole !== 'stage') {
      drawGridFins(-H * 0.845);
    }
  }
  
  // FRONT legs
  if (showLegs) {
    drawLandingLeg(-1, false);
    drawLandingLeg(1, false);
  }
  
  // ---- Stage engine bell (below body base) ----
  // Only drawn for stage role (and legacy rocket if applicable). Booster
  // has its own engine cluster handled by rocketArt if/when needed; stage
  // uses the single-nozzle or whatever its layout is.
  if (opts.stageRole === 'stage' && engineBell) {
    const bH = engineBell.h / mpp;
    const bR = engineBell.r / mpp;
    const gimbalRad = 0;
    // Single-nozzle: one big cone. Multi-nozzle: cluster (draw smaller).
    if (engineBell.count === 1) {
      ctx.save();
      ctx.translate(0, 0);
      ctx.rotate(gimbalRad);
      const g = ctx.createLinearGradient(0, 0, 0, bH);
      g.addColorStop(0, '#2a2d33');
      g.addColorStop(0.5, '#4a4e54');
      g.addColorStop(1, '#1c1e22');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-bR * 0.25, 0);
      ctx.lineTo(-bR, bH);
      ctx.lineTo(bR, bH);
      ctx.lineTo(bR * 0.25, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#0f1114';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Rim highlight
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-bR, bH);
      ctx.lineTo(bR, bH);
      ctx.stroke();
      ctx.restore();
    } else {
      // Cluster: draw one bell at each slot position, plus center
      engineBell.slots.forEach(slot => {
        const R_m = (opts.params && Number.isFinite(opts.params.octaRadius)) ? opts.params.octaRadius : 1.7;
        const pos = (typeof slot.position === 'function') ? slot.position(R_m) : { x: 0 };
        const cx = (pos.x || 0) / mpp;
        const isCenter = slot.role === 'center';
        const sH = isCenter ? bH * 1.15 : bH;
        const sR = isCenter ? bR * 1.15 : bR;
        ctx.save();
        ctx.translate(cx, 0);
        const g = ctx.createLinearGradient(0, 0, 0, sH);
        g.addColorStop(0, '#2a2d33');
        g.addColorStop(0.5, '#4a4e54');
        g.addColorStop(1, '#1c1e22');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-sR * 0.25, 0);
        ctx.lineTo(-sR, sH);
        ctx.lineTo(sR, sH);
        ctx.lineTo(sR * 0.25, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#0f1114';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.restore();
      });
    }
  }
  
  // ---- RCS pods ----
  const firing = opts.firing || {};
  const pod = opts.pod || {};
  const rcsTopMargin = opts.rcsTopMargin !== undefined ? opts.rcsTopMargin : ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_TOP_MARGIN : 0);
  const rcsBottomMargin = opts.rcsBottomMargin !== undefined ? opts.rcsBottomMargin : ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_BOTTOM_MARGIN : 0);
  
  const rcsType = ('rcsType' in opts) ?
    opts.rcsType :
    ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_TYPE : null);
  const podDefs = (rcsType && rcsType.kind === 'cornerPods' && rcsType.frame && rcsType.frame.pods) ? rcsType.frame.pods : [];
  if (rcsType && rcsType.kind !== 'cornerPods' && podDefs.length === 0) {
    console.warn(`drawRocketArt: RCS type "${rcsType.id}" (kind "${rcsType.kind}") has no matching pod artwork yet — RCS pods skipped this frame.`);
  }
  
  const corners = {},
    lateralDir = {};
  const memberH_m = H * mpp;
  const rawTopY = opts.rcsTopY !== undefined ? opts.rcsTopY :
    ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_TOP_Y : 0);
  const rawBottomY = opts.rcsBottomY !== undefined ? opts.rcsBottomY :
    ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_BOTTOM_Y : 0);
  // Clamp both offsets to the member's own height so an over-large value
  // can't place pods outside the member's silhouette (e.g. stage pods
  // climbing into the payload space above).
  const rcsTopY = Math.max(0, Math.min(rawTopY, memberH_m));
  const rcsBottomY = Math.max(0, Math.min(rawBottomY, memberH_m));
  
  podDefs.forEach(pd => {
    const xSign = pd.corner[0],
      isTop = pd.corner[1] === 'top';
    const yLocal = isTop ? rcsTopY : rcsBottomY;
    corners[pd.id] = [xSign * (W / 2), -(yLocal / mpp)];
    lateralDir[pd.id] = [xSign, 0];
  });
  
  
  const plumeLen = W * 0.6;
  const fEps = 1;
  
  function drawGasPuff(cx, cy, dir, seed) {
    const [dx, dy] = dir;
    const nx = -dy,
      ny = dx;
    const jitter = 1 + 0.10 * Math.sin(performance.now() * 0.05 + seed);
    const len = plumeLen * jitter;
    const tipX = cx + dx * len,
      tipY = cy + dy * len;
    const midX = cx + dx * len * 0.55,
      midY = cy + dy * len * 0.55;
    const spread = W * 0.05;
    
    const grad = ctx.createLinearGradient(cx, cy, tipX, tipY);
    grad.addColorStop(0, 'rgba(130,225,255,0.95)');
    grad.addColorStop(0.55, 'rgba(150,220,255,0.55)');
    grad.addColorStop(1, 'rgba(170,220,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - nx * spread, cy - ny * spread);
    ctx.quadraticCurveTo(midX - nx * spread * 0.7, midY - ny * spread * 0.7, tipX, tipY);
    ctx.quadraticCurveTo(midX + nx * spread * 0.7, midY + ny * spread * 0.7, cx + nx * spread, cy + ny * spread);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,35,50,0.55)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    
    ctx.fillStyle = 'rgba(190,235,255,0.35)';
    ctx.beginPath();
    ctx.arc(midX, midY, spread * 0.9 * jitter, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(200,240,255,0.22)';
    ctx.beginPath();
    ctx.arc(tipX, tipY, spread * 1.1 * jitter, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = 'rgba(230,250,255,0.9)';
    ctx.beginPath();
    ctx.arc(cx + dx * W * 0.03, cy + dy * W * 0.03, spread * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  
  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
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
// P4-D4: build the payload-space descriptor for a stage record. The payload
// space IS the stage's nose — either a simple cone (noseCapShape) or a
// bulged fairing (bulgedCapShape). Only applies to stageRole === 'stage'.
// ---------------------------------------------------------------------------
function buildStagePayload(rec) {
  if (!rec || rec.stageRole !== 'stage' || !rec.payloadSpace) return null;
  const ps = rec.payloadSpace;
  const ptype = (typeof getComponentType === 'function') ? getComponentType(ps.typeId) : null;
  return {
    kind: ptype ? ptype.kind : 'noseCapShape',
    tankHeight: (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) ? rec.fuel.tankHeight : 0,
    capHeight: (ps.params && Number.isFinite(ps.params.capHeight)) ? ps.params.capHeight : 0,
    capWidth: (ps.params && Number.isFinite(ps.params.capWidth)) ? ps.params.capWidth : 0,
    bulgeWidth: (ps.params && Number.isFinite(ps.params.bulgeWidth)) ? ps.params.bulgeWidth : null,
    color: ps.color || '#e9edf2',
  };
}

// ---------------------------------------------------------------------------
// Static vehicle preview — draws a vehicle at rest (legs stowed, no thrust,
// no RCS firing) onto any <canvas>, scaled to fill it at true aspect ratio.
// Used by the home page's "current vehicle" card and the fleet page's
// vehicle detail view, so both show the literal same artwork as the live
// simulator rather than a generic placeholder.
//
// `vehicle` is optional — an object with { height, width, rcsTopMargin,
// rcsBottomMargin, recoveryTypeId, rcsTypeId } (the last two new in Step G),
// e.g. a fleet record from fleet.js. Pass it explicitly when showing a
// specific record that may not be the currently-active one (the fleet
// page's editor) — when `recoveryTypeId`/`rcsTypeId` are present, THIS
// record's own hardware types are resolved and drawn (correct legs/pods
// for whatever's actually selected in the form), rather than whatever the
// globally-active CONFIG happens to be. Omit `vehicle` entirely to fall
// back to CONFIG outright (the home page always shows the active/selected
// vehicle, so CONFIG already IS the right vehicle there).
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
    height: CONFIG.ROCKET_HEIGHT,
    width: CONFIG.ROCKET_WIDTH,
    rcsTopMargin: CONFIG.RCS_TOP_MARGIN,
    rcsBottomMargin: CONFIG.RCS_BOTTOM_MARGIN,
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
  
  // STEP G: resolve THIS vehicle's own recovery/RCS types when it names
  // them, instead of always drawing whatever the globally-active CONFIG is.
  // getComponentType() comes from componentLibrary.js, which every page
  // that calls renderVehiclePreview() already loads before this file.
  // P4-B3: distinguish "caller didn't pass recoveryType" (use CONFIG as
  // fallback) from "caller explicitly passed null" (no recovery at all —
  // e.g. a booster with hasRecovery:false). `'recoveryType' in opts` is the
  // only way to tell the difference.
  // `v` carries a *type id*, not a resolved type object — resolve it here.
  // null id → null type → no hardware rendered (e.g. hasRecovery:false).
  const recoveryType = (v.recoveryTypeId && typeof getComponentType === 'function') ?
    getComponentType(v.recoveryTypeId) :
    null;
  const rcsType = (v.rcsTypeId && typeof getComponentType === 'function') ?
    getComponentType(v.rcsTypeId) :
    null;
  
  pctx.save();
  pctx.translate(baseX, baseY);
  drawRocketArt(pctx, W, H, mpp, {
    rcsTopY: v.rcsTopY,
    rcsBottomY: v.rcsBottomY,
    recoveryType,
    rcsType,
    stageRole: v.stageRole,
    noseCurveness: v.noseCurveness,
    bodyDesign: v.bodyDesign,
    payloadSpaceColor: v.payloadSpaceColor,
    stagePayload: v.stagePayload,
    payloadKind: v.payloadKind,
    payloadCapWidth: v.payloadCapWidth,
    payloadBulgeWidth: v.payloadBulgeWidth,
    payloadFrustumAngleDeg: v.payloadFrustumAngleDeg,
    payloadCurveRatio: v.payloadCurveRatio,
    payloadColor: v.payloadColor,
  });
  pctx.restore();
}


// ---------------------------------------------------------------------------
// Stack preview — draws all members (bottom→top) stacked vertically on a
// single canvas, at one shared scale. Used by home page ("current stack"
// card) and rocket detail views.
// ---------------------------------------------------------------------------
function renderStackPreview(canvas, memberIds, fleet) {
  if (!canvas) return;
  fleet = fleet || (typeof loadFleet === 'function' ? loadFleet() : []);
  const members = (memberIds || [])
    .map(id => fleet.find(r => r.id === id))
    .filter(Boolean);
  
  const pctx = canvas.getContext('2d');
  const cssW = canvas.clientWidth || canvas.width;
  if (!cssW) return;
  
  if (!members.length) {
    canvas.style.height = '160px';
    const dpr0 = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr0);
    canvas.height = Math.round(160 * dpr0);
    pctx.setTransform(dpr0, 0, 0, dpr0, 0, 0);
    pctx.clearRect(0, 0, cssW, 160);
    pctx.fillStyle = 'rgba(107,125,156,0.5)';
    pctx.font = '12px "JetBrains Mono", monospace';
    pctx.textAlign = 'center';
    pctx.fillText('(empty stack)', cssW / 2, 84);
    return;
  }
  
  const widest = Math.max(...members.map(m => m.width || 1));
  const totalH = members.reduce((s, m) => s + (m.height || 0), 0);
  
  const W_px = cssW * 0.50;
  const mpp = widest / W_px;
  const H_px_total = totalH / mpp;
  const vMarginFrac = 0.94;
  const cssH = H_px_total / vMarginFrac;
  canvas.style.height = cssH + 'px';
  
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, cssW, cssH);
  
  const baseX = cssW / 2;
  let baseY = (cssH + H_px_total) / 2;
  
  members.forEach((m, idx) => {
    const W = (m.width || 1) / mpp;
    const H = (m.height || 0) / mpp;
    const recoveryType = (m.hasRecovery === false) ? null :
      ((m.recoveryTypeId && typeof getComponentType === 'function') ?
        getComponentType(m.recoveryTypeId) : null);
    const rcsType = (m.rcsTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.rcsTypeId) : null;
    const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.engineTypeId) : null;
    
    // Bell height of the member directly above `m` (for booster/stage
    // interstage sizing) — same formula as boosterDerivedMasses()'s
    // interstage calc in fleet.js, duplicated here because that version
    // reads the global SIM_STACK_MEMBERS (only set inside the live sim);
    // this preview runs on the home/fleet pages where that global doesn't
    // exist, but we already have the ordered `members` array locally.
    let stageAboveBellHeight = 0;
    const above = members[idx + 1];
    if (above && above.engineTypeId && typeof getComponentType === 'function') {
      const layoutAbove = getComponentType(above.engineTypeId);
      if (layoutAbove && layoutAbove.frame && layoutAbove.frame.slots &&
        typeof engineThrusterGroups === 'function') {
        const gAbove = engineThrusterGroups(layoutAbove);
        let totalFlow = 0;
        Object.keys(gAbove).forEach(gk => {
          const g = above.engineThrusters && above.engineThrusters[gk];
          if (!g || !Number.isFinite(g.massFlowRate)) return;
          totalFlow += g.massFlowRate * gAbove[gk].length;
        });
        const perEngine = totalFlow / layoutAbove.frame.slots.length;
        stageAboveBellHeight = 0.007 * perEngine;
      }
    }
    
    pctx.save();
    pctx.translate(baseX, baseY);
    
    // PS-D2: payloadSpace shape needs its own opts (kind/capWidth/bulgeWidth/
    // frustumAngle/curveRatio/color). Those aren't computed in stack preview
    // otherwise — extract them from the member record here.
    const psType = (m.stageRole === 'payloadSpace' && m.payloadSpaceTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.payloadSpaceTypeId) : null;
    const psParams = m.params || {};
    const payloadOpts = (m.stageRole === 'payloadSpace') ? {
      payloadKind: psType ? psType.kind : undefined,
      payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
      payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
      payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
      payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
      payloadColor: m.color || '#e9edf2',
    } : {};
    
    drawRocketArt(pctx, W, H, mpp, {
      rcsTopY: m.params ? m.params.rcsTopY : undefined,
      rcsBottomY: m.params ? m.params.rcsBottomY : undefined,
      recoveryType,
      rcsType,
      stageRole: m.stageRole,
      noseCurveness: m.noseCurveness,
      bodyDesign: m.bodyDesign,
      payloadSpaceColor: (m.payloadSpace && m.payloadSpace.color) ? m.payloadSpace.color : undefined,
      stagePayload: (typeof buildStagePayload === 'function') ? buildStagePayload(m) : null,
      engineLayout: engineLayout,
      engineThrusters: m.engineThrusters,
      params: m.params,
      stageAboveBellHeight: stageAboveBellHeight,
      ...payloadOpts,
    });
    
    pctx.restore();
    baseY -= H;
  });
}