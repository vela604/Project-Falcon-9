// ============================================================================
// telemetry.js — Dashboard (compact notation + info glossary), the side
// "rocket figure" panel (force vectors / CoM / fuel), the basal (bottom)
// engine-status view, and rolling mini graphs.
// ============================================================================

const NOTATION_GLOSSARY = {
  // ---- Position / kinematics ----
  'x': 'Downrange arc distance from launch site, Earth-fixed (m). + east, − west. Bracketed value: angular offset in degrees. arc = R_earth · (φ_rocket_earth_fixed − φ_launch).',
  
  'h': 'Altitude above sea level (m). Frame-independent — radial distance minus Earth\'s radius.',
  
  'v': 'Speed — magnitude of the velocity vector (m/s). Format: relative (inertial). Earth-relative excludes the local surface rotation velocity (ω_earth · r).',
  
  'vr': 'Radial velocity (m/s) — component along local vertical. + = outward (away from Earth\'s center). Frame-independent: the radial direction is a geometric property of position, identical in inertial and Earth-fixed frames.',
  
  'vt': 'Tangential velocity (m/s) — component along the local East direction (sense of Earth\'s rotation). Format: relative (inertial). On the pad at rest: 0.00 (465.30) — the rocket moves with Earth in the inertial frame but is stationary in the Earth-fixed frame.',
  
  'θ': 'Attitude — body axis vs. local vertical (deg). Format: relative-to-local-vertical (inertial). 0° = upright; +ve tilts one way, −ve the other. On the pad, relative = 0.00 but inertial grows as Earth rotates (0.00 (−15.00) after one hour).',
  
  'ω': 'Angular velocity (deg/s). Format: relative-to-Earth (inertial). On the pad at rest: 0.000 (−0.004) — the −0.004 is Earth\'s rotation rate ω_earth.',
  
  // ---- Mass ----
  'm': 'Total vehicle mass (kg) — dry structure + propellant + any attached payload.',
  'mf': 'Remaining propellant mass (kg).',
  'hc': 'Height of stack center of mass above the base (m).',
  
  // ---- Forces / dynamics ----
  'Ft': 'Total main-engine thrust magnitude (N).',
  'γ': 'Center engine gimbal deflection angle (deg). + / − is the sign convention used by the shared gimbal slider.',
  'τ': 'Net torque about the center of mass (N·m). Sum of main-engine, RCS, and aerodynamic (angle-of-attack) contributions. Zero means attitude is not accelerating.',
  'α': 'Angle of attack (deg) — angle between the body axis and the relative wind (vehicle velocity minus the co-rotating atmosphere). Drives both drag and the aero torque.',
  'I': 'Stack moment of inertia about its center of mass (kg·m²). Shown in millions above 10⁶.',
  
  // ---- Environment ----
  'g': 'Local gravitational acceleration (m/s²). Falls with altitude (inverse-square).',
  'ρ': 'Local air density (kg/m³). Exponential model: ρ = ρ₀ · exp(−h / scaleHeight).',
  
  // ---- RCS ----
  'D↑': 'RCS top-pod lateral-nozzle PWM duty cycle (%). Fraction of each PWM period the top pod fires, to balance its larger moment arm against the bottom pod.',
  
  // ---- Status ----
  'TWR': 'Thrust-to-weight ratio at full throttle: (max thrust) / (current mass × g₀). Below 1 means the vehicle cannot lift off.',
  'B': 'Number of active bodies in the scene. Format: total (discarded) — discarded boosters, spent stages, released fairing halves and payloads each count as one.',
  'T+': 'Mission elapsed time, mm:ss.s.',
};

function buildGlossaryPanel() {
  const el = document.getElementById('glossaryList');
  el.innerHTML = Object.entries(NOTATION_GLOSSARY)
    .map(([k, v]) => `<div class="glossary-row"><span class="g-sym">${k}</span><span class="g-desc">${v}</span></div>`)
    .join('');
}

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }

// Every telemetry field is a fixed element in simulation.html's static
// markup (never removed/recreated), so document.getElementById() for the
// same id always returns the same node — safe to cache instead of doing a
// fresh DOM lookup ~20 times every single frame.
const _elCache = new Map();
function getEl(id) {
  let el = _elCache.get(id);
  if (el === undefined) {
    el = document.getElementById(id);
    _elCache.set(id, el);
  }
  return el;
}


  function updateTelemetry() {
  const r = Math.hypot(state.rx, state.ry);
  const altitude = altitudeFromR(r);   // frame-independent

  // ---- Frame-tagged kinematics ----
  // urx/ury = radial unit (same in both frames), uex/uey = east unit
  // (points toward increasing phi, i.e. Earth's rotation direction).
  const urx = state.rx / r, ury = state.ry / r;
  const uex = state.ry / r, uey = -state.rx / r;

  // Radial component — IDENTICAL in inertial and Earth-fixed frames (the
  // radial direction is a geometric property of position, not velocity).
  const vRadial = state.vx * urx + state.vy * ury;

  // Tangential — inertia and Earth-fixed differ. v_t_rel = v_t_inertial - ω·r.
  const vTangentialInertial = state.vx * uex + state.vy * uey;
  const vTangentialRelative = vTangentialInertial - CONFIG.EARTH_OMEGA * r;

  // Total speed. sqrt(vr² + vt²) in each frame.
  const speedInertial = Math.hypot(state.vx, state.vy);
  const speedRelative = Math.hypot(vRadial, vTangentialRelative);
  // Backwards-compat alias — legacy readers below still reference `speed`.
  // Semantically this is the inertial total, matching what the old code
  // displayed before the frame-split rename.
  const speed = speedInertial;
  // Attitude — theta is stored INERTIAL. Relative-to-local-vertical is
  // the conventional "tilt" a pilot cares about.
  const localVerticalAngle = Math.atan2(-state.rx, state.ry);
  const thetaInertial = state.theta * 180 / Math.PI;
  const thetaRelative = (state.theta - localVerticalAngle) * 180 / Math.PI;

  // Angular velocity — same duality.
  const omegaInertial = state.omega * 180 / Math.PI;
  const omegaRelative = (state.omega + CONFIG.EARTH_OMEGA) * 180 / Math.PI;

  // Downrange arc distance (Earth-fixed), with angular offset in brackets.
  const phiInertial = Math.atan2(state.rx, state.ry);
  const phiEarthFixed = phiInertial - CONFIG.EARTH_OMEGA * state.simTime;
  const arcDistance = CONFIG.EARTH_RADIUS * (phiEarthFixed - (CONFIG.LAUNCH_SITE_ANGLE_0 || 0));
  const arcAngleDeg = (arcDistance / CONFIG.EARTH_RADIUS) * 180 / Math.PI;

  const geom = geometryOf();
  const centerEngine = ENGINES.find(e => e.isCenter);
  const grav = gravityAccel(state.rx, state.ry);
  const rho = airDensity(Math.max(0, altitude));

  const set = (id, val) => { const e = getEl(id); if (e) e.textContent = val; };

  // ---- Display helper ----
  // For quantities whose value differs between frames, show
  //    <Earth-relative> (<inertial>)
  // Frame-independent quantities show a single value.
  const dual = (rel, inertial, digits) => `${fmt(rel, digits)} (${fmt(inertial, digits)})`;

  set('t-x',     `${fmt(arcDistance, 1)} m (${arcAngleDeg.toFixed(4)}°)`);
  set('t-h',     fmt(altitude, 1));                                  // frame-independent
  set('t-v',     dual(speedRelative, speedInertial, 2));             // rel (inertial)
  set('t-vr',    fmt(vRadial, 2));                                    // frame-independent
  set('t-vt',    dual(vTangentialRelative, vTangentialInertial, 2)); // rel (inertial)
  set('t-theta', dual(thetaRelative, thetaInertial, 2));             // rel-to-local (inertial)
  set('t-omega', dual(omegaRelative, omegaInertial, 3));             // rel-to-earth (inertial)

  set('t-m',      fmt(geom.M, 0));
  set('t-mf',     fmt(state.fuelMass, 0));
  set('t-Ft',     fmt(ENGINES.reduce((s,e)=>s+e.currentF,0), 0));
  set('t-gimbal', fmt(centerEngine.gimbalDeg, 1));
  set('t-torque', fmt(lastForces.mainTorque + lastForces.rcsTorque + (lastForces.dragTorque || 0), 0));
  set('t-aoa',    fmt(lastForces.aoaDeg || 0, 2));
  set('t-g',      fmt(grav.g, 3));
  set('t-rho',    fmt(rho, 4));
  set('t-duty',   Math.round((lastForces.dutyTop || 0) * 100) + '%');

  const total = state.bodies.length;
  const disc  = state.bodies.filter(b => b.isDiscarded).length;
  set('t-bodies', disc > 0 ? `${total} (${disc}d)` : `${total}`);
  set('t-com',    fmt(geom.comH, 2));
  set('t-moi',    geom.I >= 1e6 ? (geom.I / 1e6).toFixed(2) + 'M' : fmt(geom.I, 0));

  const maxThrustAll = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const g0v = (typeof G0 !== 'undefined') ? G0 : 9.80665;
  const twrLive = geom.M > 0 ? maxThrustAll / (geom.M * g0v) : 0;
  const twrEl = getEl('t-twr');
  if (twrEl) {
    twrEl.textContent = twrLive.toFixed(2);
    twrEl.style.color = twrLive < 1 ? 'var(--danger)' : (twrLive < 1.2 ? 'var(--yellow)' : '');
  }


  pushGraphSample(state.simTime, altitude, speed, ENGINES.reduce((s,e)=>s+e.currentF,0));

  const bodyListEl = getEl('t-bodyList');
if (bodyListEl) {
  const visible = state.bodies
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.members && b.members.length > 0);

  const rows = visible.map(({ b, i }) => {
    const r = Math.hypot(b.rx, b.ry);
    const alt = altitudeFromR(r) - (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
    const isAct = (i === state.activeBodyIndex);
    const cls = 'tele-body-block'
      + (isAct ? ' active' : '')
      + (b.crashed ? ' crashed' : '')
      + (b.isDiscarded ? ' discarded' : '');
    const tag = isAct ? 'A' : ('D' + i);

    // Pairwise: relative to the OTHER visible body.
    const other = visible.find(v => v.i !== i);
    let dx = 0, dy = 0, dvx = 0, dvy = 0, relLabel = '—';
    if (other) {
      dx = b.rx - other.b.rx;
      dy = b.ry - other.b.ry;
      dvx = b.vx - other.b.vx;
      dvy = b.vy - other.b.vy;
      relLabel = isAct ? ('vs D' + other.i) : ('vs A');
    }
    const dpStr = other ? `${dx.toFixed(1)}, ${dy.toFixed(1)}` : '—';
    const dvStr = other ? `${dvx.toFixed(2)}, ${dvy.toFixed(2)}` : '—';

    return `<div class="${cls}">
      <div class="tb-line"><span class="tb-label">${tag} pos</span><span class="tb-val">${alt.toFixed(0)}m</span></div>
      <div class="tb-line"><span class="tb-label">vx,vy</span><span class="tb-val">${b.vx.toFixed(1)}, ${b.vy.toFixed(1)}</span></div>
      <div class="tb-line"><span class="tb-label">Δpos ${relLabel}</span><span class="tb-val">${dpStr}</span></div>
      <div class="tb-line"><span class="tb-label">Δv ${relLabel}</span><span class="tb-val">${dvStr}</span></div>
    </div>`;
  });
  bodyListEl.innerHTML = rows.join('');
}
}

// ---------------------------------------------------------------------------
// Side "rocket figure" panel — full stack artwork, per-member CoM/CoP,
// per-member drag vectors, and the overall force/motion vectors.
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

// ---------------------------------------------------------------------------
// Aero snapshot for a body — the SAME relative-wind / angle-of-attack maths
// physics.js's computeDragAero() uses (see AERO_CP_NOSE_FRAC/AERO_CP_BODY_FRAC
// there), evaluated once against the body's CURRENT state rather than an
// RK4 sub-stage. This is a read-only snapshot for drawing — it never feeds
// back into the integrator.
// ---------------------------------------------------------------------------
function figAeroSnapshot(body) {
  const relDefault = { relVx: 0, relVy: 0, speedRel: 0, velBodyX: 0, sinAlpha: 0, wCross: 0 };
  if (!body) return relDefault;
  const w  = (typeof windInertialVector === 'function')  ? windInertialVector(body.rx, body.ry)  : { wx: 0, wy: 0 };
// Atmosphere co-rotates with Earth — subtract that too, same as
// computeDragAero() in physics.js, otherwise the panel shows a phantom
// 465 m/s headwind on a rocket that's actually sitting still relative
// to the air.
const sv = (typeof earthSurfaceVelocity === 'function') ? earthSurfaceVelocity(body.rx, body.ry) : { vx: 0, vy: 0 };
const relVx = body.vx - (w.wx + sv.vx), relVy = body.vy - (w.wy + sv.vy);
  const speedRel = Math.hypot(relVx, relVy);
  if (speedRel < 1e-3) return { ...relDefault, relVx, relVy, speedRel };
  const cosT = Math.cos(body.theta), sinT = Math.sin(body.theta);
  const velBodyX = relVx * cosT + relVy * sinT; // perpendicular to the nose axis
  const sinAlpha = Math.max(-1, Math.min(1, velBodyX / speedRel));
  const wCross = Math.min(1, Math.abs(sinAlpha));
  return { relVx, relVy, speedRel, velBodyX, sinAlpha, wCross };
}

// Proportional fuel split across members — identical rule to
// stackMassProps() in massProps.js (kept independent, read-only, so this
// panel can never accidentally perturb real mass/inertia state).
function figMemberFuelShares(members, totalFuelMass) {
  const maxFuels = members.map(m => (typeof memberMaxFuel === 'function') ? memberMaxFuel(m) : 0);
  const sumMax = maxFuels.reduce((s, x) => s + x, 0);
  return sumMax > 0 ? maxFuels.map(x => (totalFuelMass || 0) * (x / sumMax)) : maxFuels.map(() => 0);
}

// Bottom-up per-member breakdown: own local CoM (mass-weighted, via the same
// component decomposition massProps.js uses for real mass/inertia), own
// local center-of-pressure (same nose⇄body-tube blend computeDragAero()
// uses), own presented-area share of the total, and cumulative base height —
// everything needed to place a CoM dot / CoP dot / drag arrow correctly for
// every member of the stack.
function figMemberMechanics(members, body, aero) {
  const fuelShares = figMemberFuelShares(members, body ? body.fuelMass : 0);
  const nCross = (typeof AERO_CP_NOSE_FRAC !== 'undefined') ? AERO_CP_NOSE_FRAC : 0.9;
  const bCross = (typeof AERO_CP_BODY_FRAC !== 'undefined') ? AERO_CP_BODY_FRAC : 0.5;
  let baseY = 0;
  const out = members.map((m, i) => {
    const H = Number.isFinite(m.height) ? m.height : 0;
    const W = Number.isFinite(m.width) ? m.width : 0;
    const isTapered = (m.stageRole === 'nose') || (m.stageRole === 'payloadSpace');
    const legsProgress = (i === 0 && body && body.isActive) ? legs.progress : 0;

    let comX = 0, comY = H / 2;
    if (typeof memberComponents === 'function' && typeof combineComponents === 'function') {
      const comps = memberComponents(m, fuelShares[i] || 0, legsProgress);
      const combined = combineComponents(comps);
      if (Number.isFinite(combined.comX)) comX = combined.comX;
      if (Number.isFinite(combined.comY)) comY = combined.comY;
    }

    const localFrac = isTapered ? (nCross * (1 - aero.wCross) + bCross * aero.wCross) : bCross;
    const cpY = H * localFrac;

    const aAxial = Math.PI * (W / 2) ** 2;
    const aSide = W * H;
    const aEff = aAxial * (1 - aero.wCross) + aSide * aero.wCross;

    const rec = { member: m, index: i, H, W, baseY, comX, comY, cpY, aEff, isTapered };
    baseY += H;
    return rec;
  });
  const totalAeff = out.reduce((s, m) => s + m.aEff, 0) || 1;
  out.forEach(m => { m.areaShare = m.aEff / totalAeff; });
  return out;
}

function drawFigurePanel() {
  if (!figCtx) return;
  const w = figCanvas.width, h = figCanvas.height;
  figCtx.clearRect(0, 0, w, h);

  const body = state.bodies[state.activeBodyIndex];
  const members = (body && body.members) ? body.members : [];

  if (!members.length) {
    drawFigurePanelFallback(body, w, h);
    return;
  }

  // ---- Scale: fit the WHOLE stack (every member) into the panel ----
  const widest = Math.max(...members.map(m => Number.isFinite(m.width) ? m.width : 0), 0.1);
  const totalH_m = members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) || 1;
  const mppW = widest / (w * 0.30);
  const mppH = totalH_m / (h * 0.80);
  const mpp = Math.max(mppW, mppH); // meters per pixel — larger of the two keeps both dimensions on-canvas

  const baseX = w / 2, baseY = h * 0.94;
  const stackHalfW_px = (widest / mpp) / 2;

  // ---- Fuel gauge — whole-stack fraction, thin bar to the left of the stack ----
  const maxFuelTotal = members.reduce((s, m) => s + ((typeof memberMaxFuel === 'function') ? memberMaxFuel(m) : 0), 0);
  const fuelFrac = maxFuelTotal > 0 ? Math.max(0, Math.min(1, (body.fuelMass || 0) / maxFuelTotal)) : 0;
  const gaugeX = baseX - stackHalfW_px - 16;
  const gaugeH = totalH_m / mpp;
  figCtx.strokeStyle = 'rgba(255,255,255,0.25)';
  figCtx.lineWidth = 1;
  figCtx.strokeRect(gaugeX, baseY - gaugeH, 6, gaugeH);
  figCtx.fillStyle = 'rgba(255,140,40,0.55)';
  figCtx.fillRect(gaugeX, baseY - gaugeH * fuelFrac, 6, gaugeH * fuelFrac);
  figCtx.save();
  figCtx.fillStyle = '#6b7d9c';
  figCtx.font = '8px "JetBrains Mono", monospace';
  figCtx.fillText('FUEL', gaugeX - 2, baseY - gaugeH - 4);
  figCtx.restore();

  // ---- Payload, if still fitted inside its fairing — drawn BEFORE the
  // members loop so a fairing that's still on covers it, exactly like the
  // live sim canvas (see render.js's drawBodyRocket). IMPORTANT: a payload
  // riding inside its fairing gets NO CoM/CoP/drag arrow of its own here —
  // the fairing is the surface actually touching the airstream, not the
  // cargo shielded underneath it. It only becomes its own aerodynamic body
  // (with its own CoM/CoP/drag, drawn as any other body) once the fairing
  // splits and it's released — see releasePayloadOnActiveBody().
  if (body.payloadId && !body.payloadReleased) {
    const pl = (typeof getPayload === 'function') ? getPayload(body.payloadId) : null;
    if (pl) {
      let payloadBaseY_m = null, yy = 0;
      members.forEach(m => {
        if (m.stageRole === 'payloadSpace' && payloadBaseY_m === null) payloadBaseY_m = yy;
        yy += (m.height || 0);
      });
      if (payloadBaseY_m === null) payloadBaseY_m = yy;
      const plH = (pl.height || 1) / mpp, plW = (pl.width || 1) / mpp;
      figCtx.save();
      figCtx.translate(baseX, baseY - payloadBaseY_m / mpp);
      if (typeof drawPayloadArt === 'function') drawPayloadArt(figCtx, plW, plH);
      figCtx.fillStyle = 'rgba(150,220,255,0.85)';
      figCtx.font = '8px "JetBrains Mono", monospace';
      figCtx.textAlign = 'center';
      figCtx.fillText('shielded — no drag', 0, -plH - 4);
      figCtx.textAlign = 'left';
      figCtx.restore();
    }
  }

  // ---- Every member's real artwork, bottom → top (identical opts shape to
  // render.js's live stack draw, so the panel is the literal same vehicle) ----
  let yOffsetPx = 0;
  members.forEach((m, idx) => {
    const memberAbove = members[idx + 1] || null;
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
    const recType = (m.hasRecovery === false) ? null
      : ((m.recoveryTypeId && typeof getComponentType === 'function') ? getComponentType(m.recoveryTypeId) : null);
    const rcsT = (m.rcsTypeId && typeof getComponentType === 'function') ? getComponentType(m.rcsTypeId) : null;
    const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ? getComponentType(m.engineTypeId) : null;

    const psType = (m.stageRole === 'payloadSpace' && m.payloadSpaceTypeId && typeof getComponentType === 'function')
      ? getComponentType(m.payloadSpaceTypeId) : null;
    const psParams = m.params || {};
    const payloadOpts = (m.stageRole === 'payloadSpace') ? {
      payloadKind: psType ? psType.kind : undefined,
      payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
      payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
      payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
      payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
      payloadColor: m.color || '#e9edf2',
    } : {};

    figCtx.save();
    figCtx.translate(baseX, baseY - yOffsetPx);
    drawRocketArt(figCtx, mW, mH, mpp, {
      legsProgress: (idx === 0 && body.isActive) ? legs.progress : 0,
      legsState: null, // schematic — doesn't need to feed foot positions back anywhere
      firing: (body.lastRcs && body.lastRcs.firing) || {},
      pod: (body.lastRcs && body.lastRcs.pod) || {},
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
      ...payloadOpts,
    });
    figCtx.restore();
    yOffsetPx += mH;
  });

  // ---- Shared aero snapshot: ONE relative wind, ONE angle of attack for
  // the whole connected body — each member just gets its own share/point. ----
  const aero = figAeroSnapshot(body);
  const mech = figMemberMechanics(members, body, aero);

  // Overall stack CoM — the existing bright reference line, kept as-is.
  const geom = geometryOf(body);
  const comY_overall = baseY - (geom.comH || 0) / mpp;
  figCtx.strokeStyle = '#ff4466'; figCtx.lineWidth = 2;
  figCtx.beginPath();
  figCtx.moveTo(baseX - stackHalfW_px * 0.9, comY_overall);
  figCtx.lineTo(baseX + stackHalfW_px * 0.9, comY_overall);
  figCtx.stroke();
  figCtx.beginPath(); figCtx.arc(baseX, comY_overall, 4, 0, Math.PI * 2); figCtx.fillStyle = '#ff4466'; figCtx.fill();
  figCtx.fillStyle = '#ff8899'; figCtx.font = '10px monospace';
  figCtx.fillText('CoM (stack)', baseX + stackHalfW_px + 4, comY_overall + 3);

  // Windward side: the body-frame edge the relative wind is arriving FROM.
  // sideSign = -1 → flow arrives moving in the body's +X direction, which
  // means it originated on the -X (left) side — left is the windward
  // (pressure) face, and the opposite face of any tapered member (a
  // fairing, a nose) physically sees none of that flow. Each member's drag
  // arrow is drawn from that ONE windward point only — never centered, and
  // never doubled onto both sides of the same member.
  const sideSign = (aero.speedRel > 0.2 && Math.abs(aero.sinAlpha) > 0.02) ? -Math.sign(aero.velBodyX) : 0;
  const dragUnit = (aero.speedRel > 0.2)
    ? worldVectorToBodyUnit(-aero.relVx / aero.speedRel, -aero.relVy / aero.speedRel, body.theta)
    : null;

  mech.forEach(mm => {
    const globalComY_m = mm.baseY + mm.comY;
    const globalCpY_m  = mm.baseY + mm.cpY;
    const comPx = { x: baseX + mm.comX / mpp, y: baseY - globalComY_m / mpp };

    // CoP slides from the centerline (nose-on, wCross≈0) out toward
    // whichever edge actually faces the relative wind as the body presents
    // more of its broadside (wCross→1) — identical blend to
    // computeDragAero()'s per-member normal-force split in physics.js.
    const cpOffsetX_m = sideSign * (mm.W / 2) * aero.wCross;
    const cpPx = { x: baseX + (mm.comX + cpOffsetX_m) / mpp, y: baseY - globalCpY_m / mpp };

    // Per-member CoM dot.
    figCtx.beginPath(); figCtx.arc(comPx.x, comPx.y, 2.6, 0, Math.PI * 2);
    figCtx.fillStyle = 'rgba(255,170,120,0.9)'; figCtx.fill();
    figCtx.strokeStyle = 'rgba(0,0,0,0.4)'; figCtx.lineWidth = 0.8; figCtx.stroke();

    // Per-member CoP dot.
    figCtx.beginPath(); figCtx.arc(cpPx.x, cpPx.y, 2.6, 0, Math.PI * 2);
    figCtx.fillStyle = 'rgba(120,220,255,0.95)'; figCtx.fill();
    figCtx.strokeStyle = 'rgba(0,0,0,0.4)'; figCtx.lineWidth = 0.8; figCtx.stroke();

    // Drag vector, originating at THIS member's CoP — only when there's
    // real relative airflow, and only from the single windward point above.
    if (dragUnit && showVectors) {
      const len = 14 + 16 * mm.areaShare;
      const ex = cpPx.x + dragUnit.bx * len;
      const ey = cpPx.y - dragUnit.by * len;
      figCtx.strokeStyle = 'rgba(255,120,90,0.9)'; figCtx.lineWidth = 1.6;
      figCtx.beginPath(); figCtx.moveTo(cpPx.x, cpPx.y); figCtx.lineTo(ex, ey); figCtx.stroke();
      figCtx.beginPath(); figCtx.arc(ex, ey, 2.2, 0, Math.PI * 2); figCtx.fillStyle = 'rgba(255,120,90,0.9)'; figCtx.fill();
    }
  });

  // ---- Compact legend for the new per-member symbols ----
  figCtx.font = '8px "JetBrains Mono", monospace';
  [
    ['rgba(255,170,120,0.9)', 'CoM (member)'],
    ['rgba(120,220,255,0.95)', 'CoP (member)'],
    ['rgba(255,120,90,0.9)', 'Drag'],
  ].forEach(([color, label], i) => {
    const ly = 10 + i * 10;
    figCtx.fillStyle = color; figCtx.fillRect(4, ly - 6, 7, 7);
    figCtx.fillStyle = '#6b7d9c'; figCtx.fillText(label, 14, ly);
  });

  // ---- Overall force/motion unit vectors (v / main thrust F / g) — kept
  // exactly as before, anchored on the overall stack CoM / stack base. ----
  if (showVectors) {
    const vecLen = (totalH_m / mpp) * 0.32;
    const vUnit = worldVectorToBodyUnit(body.vx, body.vy, body.theta);
    if (vUnit) drawUnitVector(figCtx, baseX, comY_overall, vUnit.bx, vUnit.by, vecLen, '#ffdd55', 'v');

    const fUnit = unitOf(lastForces.mainFx, lastForces.mainFy);
    if (fUnit) drawUnitVector(figCtx, baseX, baseY, fUnit.bx, fUnit.by, vecLen, '#ffaa33', 'F');

    const rr = Math.hypot(body.rx, body.ry);
    const gWorld = rr > 0 ? { x: -body.rx / rr, y: -body.ry / rr } : { x: 0, y: -1 };
    const gUnit = worldVectorToBodyUnit(gWorld.x, gWorld.y, body.theta);
    if (gUnit) drawUnitVector(figCtx, baseX, comY_overall, gUnit.bx, gUnit.by, vecLen * 0.85, '#aabbff', 'g');
  }

  // ---- Gimbal indicator on the base (bottom engine) — unchanged ----
  const centerEngine = ENGINES.find(e => e.isCenter);
  if (centerEngine) {
    const centerFrac = centerEngine.Fmax > 0 ? centerEngine.currentF / centerEngine.Fmax : 0;
    if (centerFrac > 0.01) {
      figCtx.save();
      figCtx.translate(baseX, baseY);
      figCtx.rotate(centerEngine.gimbalDeg * Math.PI / 180);
      figCtx.fillStyle = 'rgba(255,180,80,0.8)';
      figCtx.beginPath(); figCtx.moveTo(-4, 0); figCtx.lineTo(4, 0); figCtx.lineTo(0, 18); figCtx.closePath(); figCtx.fill();
      figCtx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback for a body with no `members` breakdown — a free-flying released
// payload, a split fairing half, or (defensively) a legacy single-body
// state. Same CoM/CoP/drag treatment as one lumped member, so switching
// "Take Control" onto one of these never leaves the panel blank.
// ---------------------------------------------------------------------------
function drawFigurePanelFallback(body, w, h) {
  const fallbackRec = (body && body.payloadBody && body.payloadBody.record) || null;
  const H_m = Number.isFinite(body && body.height) ? body.height
    : (fallbackRec && Number.isFinite(fallbackRec.height)) ? fallbackRec.height
    : (CONFIG.ROCKET_HEIGHT || 45);
  const W_m = Number.isFinite(body && body.width) ? body.width
    : (fallbackRec && Number.isFinite(fallbackRec.width)) ? fallbackRec.width
    : (CONFIG.ROCKET_WIDTH || 3.9);

  const scale = (h * 0.75) / H_m;
  const baseX = w / 2, baseY = h * 0.9;
  const W = W_m * scale, H = H_m * scale;

  figCtx.fillStyle = 'rgba(13,20,36,0.5)';
  figCtx.strokeStyle = '#35d6ff';
  figCtx.lineWidth = 1.4;
  figCtx.beginPath();
  figCtx.moveTo(baseX - W / 2, baseY);
  figCtx.lineTo(baseX - W / 2, baseY - H * 0.85);
  figCtx.quadraticCurveTo(baseX - W / 2, baseY - H, baseX, baseY - H);
  figCtx.quadraticCurveTo(baseX + W / 2, baseY - H, baseX + W / 2, baseY - H * 0.85);
  figCtx.lineTo(baseX + W / 2, baseY);
  figCtx.closePath();
  figCtx.fill(); figCtx.stroke();

  if (!body) return;

  const comY = baseY - H * 0.5;
  const aero = figAeroSnapshot(body);
  const sideSign = (aero.speedRel > 0.2 && Math.abs(aero.sinAlpha) > 0.02) ? -Math.sign(aero.velBodyX) : 0;
  const bCross = (typeof AERO_CP_BODY_FRAC !== 'undefined') ? AERO_CP_BODY_FRAC : 0.5;
  const cpX = baseX + sideSign * (W / 2) * aero.wCross;
  const cpY = baseY - H * bCross;

  figCtx.strokeStyle = '#ff4466'; figCtx.lineWidth = 2;
  figCtx.beginPath(); figCtx.moveTo(baseX - W * 0.4, comY); figCtx.lineTo(baseX + W * 0.4, comY); figCtx.stroke();
  figCtx.beginPath(); figCtx.arc(baseX, comY, 4, 0, Math.PI * 2); figCtx.fillStyle = '#ff4466'; figCtx.fill();
  figCtx.fillStyle = '#ff8899'; figCtx.font = '10px monospace'; figCtx.fillText('CoM', baseX + W * 0.45, comY + 3);

  figCtx.beginPath(); figCtx.arc(cpX, cpY, 3, 0, Math.PI * 2);
  figCtx.fillStyle = 'rgba(120,220,255,0.95)'; figCtx.fill();
  figCtx.fillStyle = '#8fd8ff'; figCtx.font = '10px monospace'; figCtx.fillText('CoP', cpX + 6, cpY + 3);

  if (showVectors) {
    const vecLen = H * 0.32;
    const vUnit = worldVectorToBodyUnit(body.vx, body.vy, body.theta);
    if (vUnit) drawUnitVector(figCtx, baseX, comY, vUnit.bx, vUnit.by, vecLen, '#ffdd55', 'v');
    if (aero.speedRel > 0.2) {
      const dragUnit = worldVectorToBodyUnit(-aero.relVx / aero.speedRel, -aero.relVy / aero.speedRel, body.theta);
      if (dragUnit) drawUnitVector(figCtx, cpX, cpY, dragUnit.bx, dragUnit.by, vecLen * 0.7, 'rgba(255,120,90,0.9)', 'drag');
    }
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
