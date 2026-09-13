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

// Umbilical tower retract animation: 0 = upright/latched against the
// vehicle, 1 = fully swung back. Driven off real elapsed time (like the
// hazard-light blink below) so it animates smoothly regardless of sim
// speed/pause state, and tracks liftoff directly off current altitude so
// it needs no reset hook — it just eases back down on its own once the
// vehicle settles back near the pad.
let towerTilt = 0;
let towerTiltLastT = null;

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
// Launch/landing site — a proper pad: ground apron, a raised launch mount
// with hold-down clamps and a flame duct, and an umbilical/strongback
// tower with lattice bracing and swing arms. Everything is built from flat
// rectangles/lines/arcs in true 2D side elevation — no ellipse-foreshortening
// or perspective tricks anywhere. Sized in real meters (scaled off the
// rocket's own height/width) via metersPerPixel() so it scales correctly
// at any zoom level. The rocket rests with its base exactly on the mount's
// top surface (local y = 0).
// ---------------------------------------------------------------------------
function drawLaunchPad() {
  const [px0, py0] = localToScreen(0, 0);
  if (py0 < -500 || py0 > canvas.height + 500) return; // off-screen, skip entirely

  const mpp = metersPerPixel();
  const m = (meters) => meters / mpp;

  // The rocket's base rests exactly at local y=0 (py0). The launch mount's
  // TOP surface is flush with that; everything else (apron, tower, tanks)
  // is referenced down from the mount's base so nothing floats or embeds.
  const mountHalfW = m(9), mountH = m(2.4);
  const aprY = py0 + mountH; // apron top surface, flush with the mount's base

  // ---- Ground apron ----
  const apronHalfW = m(50);
  ctx.fillStyle = '#585d64';
  ctx.fillRect(px0 - apronHalfW, aprY, apronHalfW * 2, m(2));
  ctx.strokeStyle = '#3f4349';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(px0 - apronHalfW, aprY, apronHalfW * 2, m(2));
  // A few flat expansion-joint seams for a bit of surface detail
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  [-0.7, -0.35, 0.35, 0.7].forEach(f => {
    if (Math.abs(f * apronHalfW) > m(6)) {
      ctx.beginPath(); ctx.moveTo(px0 + f * apronHalfW, aprY); ctx.lineTo(px0 + f * apronHalfW, aprY + m(2)); ctx.stroke();
    }
  });

  // ---- Launch mount / pedestal with hold-down clamps ----
  // Top surface flush with py0 (where the rocket's base actually sits),
  // extending down to meet the apron.
  ctx.fillStyle = '#4a4e54';
  ctx.fillRect(px0 - mountHalfW, py0, mountHalfW * 2, mountH);
  ctx.strokeStyle = '#2e3136';
  ctx.lineWidth = 1;
  ctx.strokeRect(px0 - mountHalfW, py0, mountHalfW * 2, mountH);
  // Diagonal support ribs on the mount face
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  for (let i = -1; i <= 1; i += 2) {
    ctx.beginPath();
    ctx.moveTo(px0 + i * mountHalfW * 0.15, py0);
    ctx.lineTo(px0 + i * mountHalfW * 0.85, aprY);
    ctx.stroke();
  }
  // Hold-down clamp blocks right at the top edge, clasping the rocket's base
  ctx.fillStyle = '#26282c';
  [-0.62, -0.22, 0.22, 0.62].forEach(f => {
    ctx.fillRect(px0 + f * mountHalfW * 2 - m(0.5), py0 - m(0.9), m(1), m(1.1));
  });

  // Flame duct — a dark slot venting exhaust down through the mount + apron.
  ctx.fillStyle = '#141518';
  ctx.fillRect(px0 - m(3.2), py0, m(6.4), mountH + m(9));
  ctx.strokeStyle = '#0a0b0d';
  ctx.lineWidth = 1;
  ctx.strokeRect(px0 - m(3.2), py0, m(6.4), mountH + m(9));

  // ---- Umbilical / strongback tower (base on the apron surface) ----
  // Stands close to the vehicle, like a real strongback/FSS. At liftoff it
  // swings back and away from the rocket on a hinge at its base — see the
  // rotation applied below — rather than just standing there.
  const rocketH = CONFIG.ROCKET_HEIGHT;
  const towerOffsetFrac = 0.25;
  const towerX = px0 + apronHalfW * towerOffsetFrac;
  const towerW = m(4.4), towerH = m(rocketH * 0.9);

  // Update the retract animation off real elapsed time. "Liftoff" is simply
  // "clear of the mount" — a couple meters of altitude — so the swing-back
  // starts right as the vehicle leaves the pad.
  const nowT = performance.now();
  const dtReal = towerTiltLastT === null ? 0 : Math.min(0.25, (nowT - towerTiltLastT) / 1000);
  towerTiltLastT = nowT;
  const r_ = Math.hypot(state.rx, state.ry);
  const liftedOff = altitudeFromR(r_) > 2;
  const tiltTarget = liftedOff ? 1 : 0;
  const tiltRate = 0.7; // ~1.4s to fully swing back
  if (tiltTarget > towerTilt) towerTilt = Math.min(tiltTarget, towerTilt + tiltRate * dtReal);
  else towerTilt = Math.max(tiltTarget, towerTilt - tiltRate * dtReal);

  // Hinge at the tower's base; rotate the whole structure about it. The
  // tower sits to the +x side of the vehicle, so a positive rotation here
  // swings its top further away (outward), same sense as a strongback
  // retracting clear of the stack.
  const maxTiltRad = 12 * Math.PI / 180; // "a little", not a full topple
  const tiltAngle = towerTilt * maxTiltRad;
  ctx.save();
  ctx.translate(towerX, aprY);
  ctx.rotate(tiltAngle);
  ctx.translate(-towerX, -aprY);

  ctx.fillStyle = '#3a3e44';
  ctx.fillRect(towerX - towerW / 2, aprY - towerH, towerW, towerH);
  ctx.strokeStyle = '#5a5f66';
  ctx.lineWidth = 1;
  ctx.strokeRect(towerX - towerW / 2, aprY - towerH, towerW, towerH);
  // Lattice cross-bracing up the tower
  const braceSteps = 9;
  for (let i = 0; i < braceSteps; i++) {
    const y1 = aprY - towerH * (i / braceSteps), y2 = aprY - towerH * ((i + 1) / braceSteps);
    ctx.beginPath(); ctx.moveTo(towerX - towerW / 2, y1); ctx.lineTo(towerX + towerW / 2, y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(towerX + towerW / 2, y1); ctx.lineTo(towerX - towerW / 2, y2); ctx.stroke();
  }
  // Two swing arms reaching toward the vehicle: a lower fueling umbilical
  // and a higher strongback/clamp arm, each with a hinge block at both ends.
  // Length reaches to just short of the rocket's own radius so the tip sits
  // right at the vehicle skin (not floating in space) when upright.
  const rocketHalfW = m(CONFIG.ROCKET_WIDTH / 2);
  const armLen = (towerX - towerW / 2) - (px0 + rocketHalfW + m(1.5));
  [{ frac: 0.12, len: armLen }, { frac: 0.46, len: armLen }].forEach(arm => {
    const ay = aprY - towerH * arm.frac;
    const ax0 = towerX - towerW / 2;
    const ax1 = ax0 - arm.len;
    ctx.strokeStyle = '#4a4e54';
    ctx.lineWidth = Math.max(1.5, m(0.6));
    ctx.beginPath(); ctx.moveTo(ax0, ay); ctx.lineTo(ax1, ay); ctx.stroke();
    ctx.fillStyle = '#2e3136';
    ctx.beginPath(); ctx.arc(ax0, ay, m(0.9), 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ax1, ay, m(0.7), 0, Math.PI * 2); ctx.fill();
  });
  // Blinking hazard light at the tower top
  const blink = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
  ctx.fillStyle = `rgba(255,60,50,${0.5 + 0.5 * blink})`;
  ctx.beginPath(); ctx.arc(towerX, aprY - towerH, Math.max(2, m(1.1)), 0, Math.PI * 2); ctx.fill();

  ctx.restore();

  // ---- Background ground-support tanks (flat side-elevation, not 3D) ----
  const tankX = px0 - apronHalfW * 0.72;
  [0, 1].forEach(i => {
    const tx = tankX - i * m(9);
    const tw = m(4.5), th = m(10);
    ctx.fillStyle = '#4a4e54';
    ctx.fillRect(tx - tw / 2, aprY - th, tw, th);
    ctx.strokeStyle = '#2e3136';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx - tw / 2, aprY - th, tw, th);
    // Flat domed cap — a legitimate side-elevation feature of a cylindrical
    // tank, not a perspective effect
    ctx.beginPath();
    ctx.arc(tx, aprY - th, tw / 2, Math.PI, 0);
    ctx.fill();
    ctx.stroke();
  });
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

  // ---- Airframe, legs, RCS pods (shared with the static vehicle previews
  // on the home page and fleet page — see rocketArt.js) ----
  // ---- Stack: draw every member from bottom→top, at one scale, with the
// stack's bottom at (0,0). Plume is drawn above (once) from ENGINES (which
// come from the bottom member). ----
const stackMembers = (typeof SIM_STACK_MEMBERS !== 'undefined' && SIM_STACK_MEMBERS.length) ?
  SIM_STACK_MEMBERS :
  [];

if (stackMembers.length) {
  let yOffsetPx = 0;
  stackMembers.forEach((m, idx) => {
    const memberAbove = stackMembers[idx + 1] || null;
    let stageAboveBellHeight = 0;
    if (memberAbove && memberAbove.engineTypeId && typeof getComponentType === 'function') {
      const layoutAbove = getComponentType(memberAbove.engineTypeId);
      if (layoutAbove && layoutAbove.frame && layoutAbove.frame.slots) {
        const groups = (typeof engineThrusterGroups === 'function') ? engineThrusterGroups(layoutAbove) : {};
        let totalFlow = 0;
        Object.keys(groups).forEach(gk => {
          const g = memberAbove.engineThrusters && memberAbove.engineThrusters[gk];
          if (!g || !Number.isFinite(g.massFlowRate)) return;
          totalFlow += g.massFlowRate * groups[gk].length;
        });
        const perEngine = totalFlow / layoutAbove.frame.slots.length;
        stageAboveBellHeight = 0.007 * perEngine;
      }
    }
    
    const mH = (m.height || 0) / mpp;
    const mW = (m.width || 1) / mpp;
    const recType = (m.hasRecovery === false) ? null :
      ((m.recoveryTypeId && typeof getComponentType === 'function') ?
        getComponentType(m.recoveryTypeId) : null);
    const rcsT = (m.rcsTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.rcsTypeId) : null;
    const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.engineTypeId) : null;
    
    ctx.save();
    ctx.translate(0, -yOffsetPx);
    drawRocketArt(ctx, mW, mH, mpp, {
      legsProgress: (idx === 0) ? legs.progress : 0,
      legsState: legs,
      firing: lastForces.firing || {},
      pod: lastForces.pod || {},
      rcsTopY: m.params ? m.params.rcsTopY : undefined,
      rcsBottomY: m.params ? m.params.rcsBottomY : undefined,
      recoveryType: recType,
      rcsType: rcsT,
      stageRole: m.stageRole,
      noseCurveness: m.noseCurveness,
      bodyDesign: m.bodyDesign,
      payloadSpaceColor: (m.payloadSpace && m.payloadSpace.color) ? m.payloadSpace.color : undefined,
      stagePayload: (typeof buildStagePayload === 'function') ? buildStagePayload(m) : null,
      engineLayout: engineLayout,
      engineThrusters: m.engineThrusters,
      params: m.params,
      stageAboveBellHeight: stageAboveBellHeight,
    });
    ctx.restore();
    yOffsetPx += mH;
  });
} else {
  // Fallback: single-body (should not normally hit).
  const fb = (typeof ACTIVE_VEHICLE_FOR_HARDWARE !== 'undefined') ? ACTIVE_VEHICLE_FOR_HARDWARE : null;
  const fbEngineLayout = (fb && fb.engineTypeId && typeof getComponentType === 'function') ?
    getComponentType(fb.engineTypeId) : null;
  drawRocketArt(ctx, W, H, mpp, {
    legsProgress: legs.progress,
    legsState: legs,
    firing: lastForces.firing || {},
    pod: lastForces.pod || {},
    rcsTopY: CONFIG.RCS_TOP_Y,
    rcsBottomY: CONFIG.RCS_BOTTOM_Y,
    recoveryType: CONFIG.RECOVERY_TYPE,
    rcsType: CONFIG.RCS_TYPE,
    stageRole: fb ? fb.stageRole : 'rocket',
    noseCurveness: fb ? fb.noseCurveness : 0,
    bodyDesign: fb ? fb.bodyDesign : undefined,
    payloadSpaceColor: (fb && fb.payloadSpace && fb.payloadSpace.color) ? fb.payloadSpace.color : undefined,
    stagePayload: (fb && typeof buildStagePayload === 'function') ? buildStagePayload(fb) : null,
    engineLayout: fbEngineLayout,
    engineThrusters: fb ? fb.engineThrusters : null,
    params: fb ? fb.params : null,
    stageAboveBellHeight: 0,
  });
}
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
