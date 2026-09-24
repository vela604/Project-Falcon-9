// ============================================================================
// telemetry.js — Dashboard (compact notation + info glossary), the side
// "rocket figure" panel (force vectors / CoM / fuel), the basal (bottom)
// engine-status view, and rolling mini graphs.
// ============================================================================

const NOTATION_GLOSSARY = {
  // ---- Position / kinematics ----
  'x': 'Downrange arc distance from launch site, Earth-fixed (m). + east, − west. Bracketed value: angular offset in degrees. arc = R_earth · (φ_rocket_earth_fixed − φ_launch).',
  
  'h': 'Altitude above sea level (m). Frame-independent — radial distance minus Earth\'s radius.',

'ha': 'Apogee altitude (km, ASL) — the highest point of the current osculating two-body orbit. Computed from the instantaneous inertial state (r, vr, vt_inertial). Shows "∞" on escape trajectories (parabolic or hyperbolic). Not the same as CONFIG.TARGET_ORBIT_ALT_KM unless the orbit happens to be circular.',

'hp': 'Perigee altitude (km, ASL) — the lowest point of the current osculating two-body orbit. Always defined for any bound or unbound conic. During a circular orbit ha ≈ hp; during a coast ellipse they diverge as expected.',

'va': 'Velocity at apogee (m/s) — the speed the body will have when it reaches apogee, from angular momentum conservation: vr = 0 there, so |v| = |h| / r_a. Zero on escape trajectories (apogee undefined).',

  'v': 'Speed — magnitude of the velocity vector (m/s). Format: relative (inertial). Earth-relative excludes the local surface rotation velocity (ω_earth · r).',
  
  'vr': 'Radial velocity (m/s) — component along local vertical. + = outward (away from Earth\'s center). Frame-independent: the radial direction is a geometric property of position, identical in inertial and Earth-fixed frames.',
  
  'vt': 'Tangential velocity (m/s) — component along the local East direction (sense of Earth\'s rotation). Format: relative (inertial). On the pad at rest: 0.00 (465.30) — the rocket moves with Earth in the inertial frame but is stationary in the Earth-fixed frame.',
  
  'θ': 'Attitude — body axis vs. local vertical (deg). Format: relative-to-local-vertical (inertial). 0° = upright; +ve tilts one way, −ve the other. On the pad, relative = 0.00 but inertial grows as Earth rotates (0.00 (−15.00) after one hour).',
  
  'ω': 'Angular velocity (deg/s). Format: relative-to-Earth (inertial). On the pad at rest: 0.000 (−0.004) — the −0.004 is Earth\'s rotation rate ω_earth.',
  
  // ---- Mass ----
  'm': 'Total vehicle mass (kg) — dry structure + propellant + any attached payload.',
  'mf': 'Remaining propellant mass (kg).',
  'hc': 'Height of stack center of mass above the base (m).',
  'slosh': 'Lateral offset of the bottom tank\'s fuel-slosh oscillator from tank centerline (cm). 0 when the Fuel slosh toggle is off or the body has no fuel in its bottom tank. Shifts the stack\'s lateral CoM, which is what makes it fight the gimbal. The values in parentheses are the current natural frequency \u03c9_n (rad/s, derived from tank radius and fill level) and damping ratio \u03b6 (derived from the same geometry plus propellant viscosity, via Abramson\'s boundary-layer model); both show "\u2014" when slosh is off or the body has no bottom tank to measure from.',
  
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
  'D↑': 'RCS top-pod lateral duty (%). Average of the two top pods\' actually applied lateral-nozzle duty this tick — source-agnostic (human boolean commands and guidance raw-duty commands both end up here, and the human path\'s torque-balancing gate shows up as a reduced fraction on whichever pod it damped). 0 = no top-pod lateral firing, 1 = both top pods at full.',
  
  // ---- Status ----
  'TWR': 'Thrust-to-weight ratio at full throttle: (max thrust) / (current mass × g₀). Below 1 means the vehicle cannot lift off.',
  'B': 'Number of active bodies in the scene. Format: total (discarded) — discarded boosters, spent stages, released fairing halves and payloads each count as one.',
  'T+': 'Mission elapsed time, mm:ss.s.',
};

// Time from current 2-body state to the next apogee (seconds). Exact
// via Kepler's equation. Used by the direction HUD's burn countdown —
// same math the guidance worker runs, inlined here because telemetry
// runs on the main thread and has no access to guidance's internals.
function _timeToApogeeKepler(r, vr, vt, GM) {
  if (!(r > 0)) return Infinity;
  const E = 0.5 * (vr * vr + vt * vt) - GM / r;
  if (E >= 0) return Infinity;
  const a = -GM / (2 * E);
  const h = r * vt;
  const eSq = 1 + 2 * E * h * h / (GM * GM);
  const e = Math.sqrt(Math.max(0, eSq));
  if (e < 1e-9) return Math.PI * Math.sqrt(a * a * a / GM);
  const cosE = (1 - r / a) / e;
  const sinE = (r * vr) / (e * Math.sqrt(GM * a));
  let E_an = Math.atan2(sinE, cosE);
  if (E_an < 0) E_an += 2 * Math.PI;
  const M = E_an - e * Math.sin(E_an);
  const n = Math.sqrt(GM / (a * a * a));
  if (M < Math.PI) return (Math.PI - M) / n;
  return (3 * Math.PI - M) / n;
}

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
  const altitude = altitudeFromR(r); // frame-independent
  
  // ---- Frame-tagged kinematics ----
  // urx/ury = radial unit (same in both frames), uex/uey = east unit
  // (points toward increasing phi, i.e. Earth's rotation direction).
  const urx = state.rx / r,
    ury = state.ry / r;
  const uex = state.ry / r,
    uey = -state.rx / r;
  
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
  
  set('t-x', `${fmt(arcDistance, 1)} m (${arcAngleDeg.toFixed(4)}°)`);
set('t-h', fmt(altitude, 1)); // frame-independent

// ---- Osculating orbital elements (two-body, from current inertial state) ----
//   E = ½(vr² + vt_inertial²) − GM/r        specific energy
//   h = r · vt_inertial                     specific angular momentum
//   p = h² / GM                             semi-latus rectum
//   e = √(1 + 2·E·h²/GM²)                   eccentricity
//   r_p = p / (1 + e)                       always defined
//   r_a = p / (1 − e)   if e < 1            apogee (undefined if escape)
//   v_apo = |h| / r_a                       velocity at apogee (vr = 0 there)
// Thrust is NOT subtracted — same convention as guidance's plan block,
// so the numbers here match what the mission guide reads.
{
  const GM = CONFIG.GM_EARTH;
  const R_e = CONFIG.EARTH_RADIUS;
  const h_orb = r * vTangentialInertial;
  const p_orb = GM > 0 ? (h_orb * h_orb) / GM : 0;
  const E_orb = 0.5 * (vRadial * vRadial + vTangentialInertial * vTangentialInertial) - GM / r;
  const eSq = 1 + 2 * E_orb * h_orb * h_orb / (GM * GM);
  const e = Math.sqrt(Math.max(0, eSq));
  const r_p = p_orb / (1 + e);
  const r_a = (e < 1 && e >= 0) ? p_orb / (1 - e) : Infinity;
  const altP = (r_p - R_e) / 1000;
  const altA = Number.isFinite(r_a) ? (r_a - R_e) / 1000 : Infinity;
  const vApo = (Number.isFinite(r_a) && r_a > 0) ? Math.abs(h_orb) / r_a : 0;
  
  set('t-apogee', Number.isFinite(altA) ? fmt(altA, 1) + ' km' : '∞ (escape)');
  set('t-perigee', fmt(altP, 1) + ' km');
  set('t-vapo', fmt(vApo, 0) + ' m/s');
}

set('t-v', dual(speedRelative, speedInertial, 2)); // rel (inertial)
set('t-vr', fmt(vRadial, 2)); // frame-independent
  set('t-vt', dual(vTangentialRelative, vTangentialInertial, 2)); // rel (inertial)
  set('t-theta', dual(thetaRelative, thetaInertial, 2)); // rel-to-local (inertial)
  set('t-omega', dual(omegaRelative, omegaInertial, 3)); // rel-to-earth (inertial)
  
  set('t-m', fmt(geom.M, 0));
  set('t-mf', fmt(state.fuelMass, 0));
  set('t-Ft', fmt(ENGINES.reduce((s, e) => s + e.currentF, 0), 0));
  
  set('t-gimbal', centerEngine ? fmt(centerEngine.gimbalDeg, 1) : '—');  set('t-torque', fmt(lastForces.mainTorque + lastForces.rcsTorque + (lastForces.dragTorque || 0), 0));
  set('t-aoa', fmt(lastForces.aoaDeg || 0, 2));
  set('t-g', fmt(grav.g, 3));
  set('t-rho', fmt(rho, 4));
  set('t-duty', Math.round((lastForces.dutyTop || 0) * 100) + '%');
  
  const total = state.bodies.length;
  const disc = state.bodies.filter(b => b.isDiscarded).length;
  set('t-bodies', disc > 0 ? `${total} (${disc}d)` : `${total}`);
  set('t-com', fmt(geom.comH, 2));
  // Phase 2A — lateral slosh offset (cm, signed) of the bottom tank's slosh
  // mass. 0.00 when slosh is off/disabled or the body has no bottom tank.
  // Phase 2B.1 — also show the derived natural frequency ω_n (rad/s)
  // alongside it, so the fill-level/thrust-dependent value is visible
  // rather than only inferrable from offset behaviour.
  // Phase 2B.3 — and the derived boundary-layer damping ratio ζ, same
  // "—" fallback pattern as ω when slosh is off / no bottom tank.
  const _sloshBody = state.bodies[state.activeBodyIndex];
  // telemetry.js
const _sloshOffsetCm = fmt((_sloshBody && _sloshBody.slosh ? _sloshBody.slosh.offset : 0) * 100, 3);
  const _sloshOmega = (_sloshBody && _sloshBody.slosh && Number.isFinite(_sloshBody.slosh.omega))
    ? _sloshBody.slosh.omega.toFixed(2)
    : '—';
  const _sloshZeta = (_sloshBody && _sloshBody.slosh && Number.isFinite(_sloshBody.slosh.zeta))
    ? _sloshBody.slosh.zeta.toFixed(3)
    : '—';
  set('t-slosh', `${_sloshOffsetCm} cm (ω=${_sloshOmega}, ζ=${_sloshZeta})`);
  set('t-moi', geom.I >= 1e6 ? (geom.I / 1e6).toFixed(2) + 'M' : fmt(geom.I, 0));
  
  const maxThrustAll = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const g0v = (typeof G0 !== 'undefined') ? G0 : 9.80665;
  const twrLive = geom.M > 0 ? maxThrustAll / (geom.M * g0v) : 0;
  const twrEl = getEl('t-twr');
  if (twrEl) {
    twrEl.textContent = twrLive.toFixed(2);
    twrEl.style.color = twrLive < 1 ? 'var(--danger)' : (twrLive < 1.2 ? 'var(--yellow)' : '');
  }
  
  
    const _graphSloshBody = state.bodies[state.activeBodyIndex];
  const _sloshCmForGraph = (_graphSloshBody && _graphSloshBody.slosh ? (_graphSloshBody.slosh.offset || 0) * 100 : 0);
  
  // Dynamic pressure Q = ½·ρ·v_rel², using the SAME relative-velocity
  // convention physics.js's computeDragAero uses (co-rotating atmosphere
  // + user wind), so the graph matches what the rocket actually feels.
  // Shown in kPa — peak for F9-class is ~30-40 kPa, so Pa would be
  // awkwardly large on a mini-graph axis.
  const _qW = (typeof windInertialVector === 'function') ? windInertialVector(state.rx, state.ry) : { wx: 0, wy: 0 };
  const _qSv = (typeof earthSurfaceVelocity === 'function') ? earthSurfaceVelocity(state.rx, state.ry) : { vx: 0, vy: 0 };
  const _qRelVx = state.vx - (_qW.wx + _qSv.vx);
  const _qRelVy = state.vy - (_qW.wy + _qSv.vy);
  const _qSpeedRel = Math.hypot(_qRelVx, _qRelVy);
  const _qPa = 0.5 * rho * _qSpeedRel * _qSpeedRel;
  const _qKPa = Number.isFinite(_qPa) ? (_qPa / 1000) : 0;
  
  pushGraphSample(state.simTime, altitude, speed, ENGINES.reduce((s, e) => s + e.currentF, 0), _qKPa, _sloshCmForGraph);
  
  const bodyListEl = getEl('t-bodyList');
  if (bodyListEl) {
    // Show every body that has physical state worth reporting — including
// released payloads and split fairing halves. Previously only bodies with
// `members` (stack-based ones) were listed, so once a payload separated
// it vanished from telemetry even though it kept its own pos/velocity.
const visible = state.bodies
  .map((b, i) => ({ b, i }))
  .filter(({ b }) => (b.members && b.members.length > 0) || b.payloadBody || b.fairingHalf);
    
    const rows = visible.map(({ b, i }) => {
      const r = Math.hypot(b.rx, b.ry);
      const alt = altitudeFromR(r) - (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
      const isAct = (i === state.activeBodyIndex);
const isFollowed = (i === _cameraTargetIndex());
const cls = 'tele-body-block' +
  (isAct ? ' active' : '') +
  (isFollowed && !isAct ? ' followed' : '') +
  (b.crashed ? ' crashed' : '') +
  (b.isDiscarded ? ' discarded' : '');

// Short tag so the tiny row label tells you at a glance which body
// this is: A=active, P=payload, F=fairing, B=booster/stage, D=discarded.
let tag;
if (isAct) tag = 'A';
else if (b.payloadBody) tag = 'P';
else if (b.fairingHalf) tag = 'F';
else if (b.members && b.members.length) tag = 'B' + i;
else tag = 'D' + i;
      
        // Every non-active body shows Δpos / Δv relative to the ACTIVE
  // body — not "first visible other body", which was arbitrary and
  // gave different frames depending on body order in state.bodies.
  // The active body itself shows "—" for these rows (it can't be
  // relative to itself).
  const activeBody = state.bodies[state.activeBodyIndex];
  let dpStr = '—', dvStr = '—';
  if (!isAct && activeBody) {
    const dx = b.rx - activeBody.rx;
    const dy = b.ry - activeBody.ry;
    const dvx = b.vx - activeBody.vx;
    const dvy = b.vy - activeBody.vy;
    dpStr = `${dx.toFixed(1)}, ${dy.toFixed(1)}`;
    dvStr = `${dvx.toFixed(2)}, ${dvy.toFixed(2)}`;
  }
  const relTag = isAct ? '' : ' vs A';
  
  return `<div class="${cls}">
  <div class="tb-line"><span class="tb-label">${tag} pos</span><span class="tb-val">${alt.toFixed(0)}m</span></div>
  <div class="tb-line"><span class="tb-label">vx,vy</span><span class="tb-val">${b.vx.toFixed(1)}, ${b.vy.toFixed(1)}</span></div>
  <div class="tb-line"><span class="tb-label">Δpos${relTag}</span><span class="tb-val">${dpStr}</span></div>
  <div class="tb-line"><span class="tb-label">Δv${relTag}</span><span class="tb-val">${dvStr}</span></div>
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
  const ux = wx / mag,
    uy = wy / mag;
  const cosT = Math.cos(theta),
    sinT = Math.sin(theta);
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
  const ex = x0 + bx * len,
    ey = y0 - by * len;
  ctx2.strokeStyle = color;
  ctx2.fillStyle = color;
  ctx2.lineWidth = 2;
  ctx2.beginPath();
  ctx2.moveTo(x0, y0);
  ctx2.lineTo(ex, ey);
  ctx2.stroke();
  ctx2.beginPath();
  ctx2.arc(ex, ey, 3, 0, Math.PI * 2);
  ctx2.fill();
  ctx2.font = '10px "JetBrains Mono", monospace';
  ctx2.fillText(label, ex + 4, ey + 3);
}

function initFigureCanvas() {
  figCanvas = document.getElementById('figureCanvas');
  figCtx = figCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = figCanvas.clientWidth || figCanvas.width;
  const cssH = figCanvas.clientHeight || figCanvas.height;
  figCanvas.width = Math.round(cssW * dpr);
  figCanvas.height = Math.round(cssH * dpr);
  figCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  const w = (typeof windInertialVector === 'function') ? windInertialVector(body.rx, body.ry) : { wx: 0, wy: 0 };
  // Atmosphere co-rotates with Earth — subtract that too, same as
  // computeDragAero() in physics.js, otherwise the panel shows a phantom
  // 465 m/s headwind on a rocket that's actually sitting still relative
  // to the air.
  const sv = (typeof earthSurfaceVelocity === 'function') ? earthSurfaceVelocity(body.rx, body.ry) : { vx: 0, vy: 0 };
  const relVx = body.vx - (w.wx + sv.vx),
    relVy = body.vy - (w.wy + sv.vy);
  const speedRel = Math.hypot(relVx, relVy);
  if (speedRel < 1e-3) return { ...relDefault, relVx, relVy, speedRel };
  const cosT = Math.cos(body.theta),
    sinT = Math.sin(body.theta);
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
    
    let comX = 0,
      comY = H / 2;
    if (typeof memberComponents === 'function' && typeof combineComponents === 'function') {
      // Phase 2A: only the bottom member (i === 0) ever carries a nonzero
      // slosh offset — same "bottom tank only" rule as stackMassProps() in
      // massProps.js. This is what makes the existing per-member CoM dot
      // below visibly swing side to side when slosh is active.
      const sloshOffset = (i === 0 && body && body.slosh) ? body.slosh.offset : undefined;
      const comps = memberComponents(m, fuelShares[i] || 0, legsProgress, null, sloshOffset);
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

// Pick the velocity vector to display in the figure panel based on the
// SAME checkbox that controls trajectory frame. When 'earthFixed' is
// active, show Earth-relative velocity (inertial minus co-rotation),
// otherwise inertial. Keeps the panel consistent with whatever frame
// the trajectory overlay is currently showing.
function _figureVelocityVector(body) {
  if (!body) return { vx: 0, vy: 0 };
  const earthFixed = (typeof trajectoryMode !== 'undefined' && trajectoryMode === 'earthFixed');
  if (!earthFixed) return { vx: body.vx, vy: body.vy };
  const w = (typeof CONFIG !== 'undefined' && Number.isFinite(CONFIG.EARTH_OMEGA)) ? CONFIG.EARTH_OMEGA : 0;
  // Earth surface (co-rotating) velocity at this inertial position:
  //   v_surface = (ω·ry, −ω·rx)
  const svx = w * body.ry;
  const svy = -w * body.rx;
  return { vx: body.vx - svx, vy: body.vy - svy };
}

function drawFigurePanel() {
  if (!figCanvas || !figCtx) return;
  // Re-derive the CSS↔buffer scale EVERY frame. The canvas backing buffer
  // is DPR-scaled (2×, 3× on retina); layout code below is written in CSS
  // pixels, so the ctx transform must map CSS → buffer. Reading clientWidth
  // vs width each frame also self-heals if the browser zoom, DPR, or layout
  // changed since init — a fix that isn't needed on desktop but does bite
  // on mobile emulators and window drags.
  const cssW = figCanvas.clientWidth || 260;
  const cssH = figCanvas.clientHeight || 220;
  const bufW = figCanvas.width;
  const bufH = figCanvas.height;
  const scaleX = bufW / cssW;
  const scaleY = bufH / cssH;
  
  figCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  
  // w, h now in CSS pixels — same units the layout math was originally
  // written for.
  const w = cssW;
  const h = cssH;
  figCtx.clearRect(0, 0, w, h);
  
  const followIdx = (typeof _cameraTargetIndex === 'function') ?
    _cameraTargetIndex() :
    state.activeBodyIndex;
  const body = state.bodies[followIdx];
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
  
  const baseX = w / 2,
    baseY = h * 0.94;
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
      let payloadBaseY_m = null,
        yy = 0;
      members.forEach(m => {
        if (m.stageRole === 'payloadSpace' && payloadBaseY_m === null) payloadBaseY_m = yy;
        yy += (m.height || 0);
      });
      if (payloadBaseY_m === null) payloadBaseY_m = yy;
      const plH = (pl.height || 1) / mpp,
        plW = (pl.width || 1) / mpp;
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
  
 // Every member drawn with the SAME real artwork the main flight canvas
// uses (drawRocketArt, loaded via rocketArt.js). This is why the panel
// now reads as the literal same vehicle instead of a schematic — legs,
// RCS pods, engine bells, checkerboard, everything.
//
// Each member is drawn in its own translate frame (base at local 0,
// +Y up-stack in member's own coordinates — matches drawRocketArt's
// convention), then the panel's cumulative height offset is applied so
// the stack builds up from the bottom.
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
  
  const recType = (m.hasRecovery === false) ? null :
    ((m.recoveryTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.recoveryTypeId) : null);
  const rcsT = (m.rcsTypeId && typeof getComponentType === 'function') ?
    getComponentType(m.rcsTypeId) : null;
  const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ?
    getComponentType(m.engineTypeId) : null;
  
  // PS-D2 fairing options, same as render.js.
  const psType = (m.stageRole === 'payloadSpace' && m.payloadSpaceTypeId && typeof getComponentType === 'function') ?
    getComponentType(m.payloadSpaceTypeId) : null;
  const psParams = m.params || {};
  const payloadOpts = (m.stageRole === 'payloadSpace') ? {
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
      legsState: null,
      // A5 — same as render.js: pod-id lookups need the member's own idx.
      memberIdx: idx,
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
  // The DOT's x position now reflects geom.comW too (Phase 2A: nonzero
  // only when slosh has shifted the stack's true lateral CoM — previously
  // always 0, so this is a no-op everywhere else).
  const geom = geometryOf(body);
  const comY_overall = baseY - (geom.comH || 0) / mpp;
  const comX_overall = baseX + (geom.comW || 0) / mpp;
  figCtx.strokeStyle = '#ff4466';
  figCtx.lineWidth = 2;
  figCtx.beginPath();
  figCtx.moveTo(baseX - stackHalfW_px * 0.9, comY_overall);
  figCtx.lineTo(baseX + stackHalfW_px * 0.9, comY_overall);
  figCtx.stroke();
  figCtx.beginPath();
  figCtx.arc(comX_overall, comY_overall, 4, 0, Math.PI * 2);
  figCtx.fillStyle = '#ff4466';
  figCtx.fill();
  figCtx.fillStyle = '#ff8899';
  figCtx.font = '10px monospace';
  figCtx.fillText('CoM (stack)', baseX + stackHalfW_px + 4, comY_overall + 3);
  
  // Windward side: the body-frame edge the relative wind is arriving FROM.
  // sideSign = -1 → flow arrives moving in the body's +X direction, which
  // means it originated on the -X (left) side — left is the windward
  // (pressure) face, and the opposite face of any tapered member (a
  // fairing, a nose) physically sees none of that flow. Each member's drag
  // arrow is drawn from that ONE windward point only — never centered, and
  // never doubled onto both sides of the same member.
  const sideSign = (aero.speedRel > 0.2 && Math.abs(aero.sinAlpha) > 0.02) ? -Math.sign(aero.velBodyX) : 0;
  const dragUnit = (aero.speedRel > 0.2) ?
    worldVectorToBodyUnit(-aero.relVx / aero.speedRel, -aero.relVy / aero.speedRel, body.theta) :
    null;
  
  mech.forEach(mm => {
    const globalComY_m = mm.baseY + mm.comY;
    const globalCpY_m = mm.baseY + mm.cpY;
    const comPx = { x: baseX + mm.comX / mpp, y: baseY - globalComY_m / mpp };
    
    // CoP slides from the centerline (nose-on, wCross≈0) out toward
    // whichever edge actually faces the relative wind as the body presents
    // more of its broadside (wCross→1) — identical blend to
    // computeDragAero()'s per-member normal-force split in physics.js.
    const cpOffsetX_m = sideSign * (mm.W / 2) * aero.wCross;
    const cpPx = { x: baseX + (mm.comX + cpOffsetX_m) / mpp, y: baseY - globalCpY_m / mpp };
    
    // Per-member CoM dot.
    figCtx.beginPath();
    figCtx.arc(comPx.x, comPx.y, 2.6, 0, Math.PI * 2);
    figCtx.fillStyle = 'rgba(255,170,120,0.9)';
    figCtx.fill();
    figCtx.strokeStyle = 'rgba(0,0,0,0.4)';
    figCtx.lineWidth = 0.8;
    figCtx.stroke();
    
    // Per-member CoP dot.
    figCtx.beginPath();
    figCtx.arc(cpPx.x, cpPx.y, 2.6, 0, Math.PI * 2);
    figCtx.fillStyle = 'rgba(120,220,255,0.95)';
    figCtx.fill();
    figCtx.strokeStyle = 'rgba(0,0,0,0.4)';
    figCtx.lineWidth = 0.8;
    figCtx.stroke();
    
    // Drag vector, originating at THIS member's CoP — only when there's
    // real relative airflow, and only from the single windward point above.
    if (dragUnit && showVectors) {
      const len = 14 + 16 * mm.areaShare;
      const ex = cpPx.x + dragUnit.bx * len;
      const ey = cpPx.y - dragUnit.by * len;
      figCtx.strokeStyle = 'rgba(255,120,90,0.9)';
      figCtx.lineWidth = 1.6;
      figCtx.beginPath();
      figCtx.moveTo(cpPx.x, cpPx.y);
      figCtx.lineTo(ex, ey);
      figCtx.stroke();
      figCtx.beginPath();
      figCtx.arc(ex, ey, 2.2, 0, Math.PI * 2);
      figCtx.fillStyle = 'rgba(255,120,90,0.9)';
      figCtx.fill();
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
    figCtx.fillStyle = color;
    figCtx.fillRect(4, ly - 6, 7, 7);
    figCtx.fillStyle = '#6b7d9c';
    figCtx.fillText(label, 14, ly);
  });
  
  // ---- Overall force/motion unit vectors (v / main thrust F / g) — kept
  // exactly as before, anchored on the overall stack CoM / stack base. ----
  if (showVectors) {
  const vecLen = (totalH_m / mpp) * 0.32;
  const vv = _figureVelocityVector(body);
  const vUnit = worldVectorToBodyUnit(vv.vx, vv.vy, body.theta);
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
      figCtx.beginPath();
      figCtx.moveTo(-4, 0);
      figCtx.lineTo(4, 0);
      figCtx.lineTo(0, 18);
      figCtx.closePath();
      figCtx.fill();
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
  // Body's physical extents come from whichever record it carries:
  // released payload → payloadBody.record, split fairing half →
  // fairingHalf.record, otherwise the body's own h/w or CONFIG defaults.
  const fallbackRec =
    (body && body.payloadBody && body.payloadBody.record) ||
    (body && body.fairingHalf && body.fairingHalf.record) ||
    null;

  const H_m = Number.isFinite(body && body.height) ? body.height :
    (fallbackRec && Number.isFinite(fallbackRec.height)) ? fallbackRec.height :
    (CONFIG.ROCKET_HEIGHT || 45);
  const W_m = Number.isFinite(body && body.width) ? body.width :
    (fallbackRec && Number.isFinite(fallbackRec.width)) ? fallbackRec.width :
    (CONFIG.ROCKET_WIDTH || 3.9);

  const scale = (h * 0.75) / H_m;      // px per meter
  const baseX = w / 2, baseY = h * 0.9;
  const W = W_m * scale, H = H_m * scale;

  // ---- Artwork ----
  if (body && body.payloadBody && body.payloadBody.record) {
    // Released payload — draw its own satellite artwork.
    figCtx.save();
    figCtx.translate(baseX, baseY);
    drawPayloadArt(figCtx, W, H);
    figCtx.restore();
  } else if (body && body.fairingHalf && body.fairingHalf.record) {
    // Fairing half — draw the fairing silhouette clipped to one lateral
    // half (same convention as render.js: +1 = right, -1 = left).
    const rec = body.fairingHalf.record;
    const side = body.fairingHalf.side;
    const psType = (rec.payloadSpaceTypeId && typeof getComponentType === 'function')
      ? getComponentType(rec.payloadSpaceTypeId) : null;
    const psParams = rec.params || {};

    figCtx.save();
    figCtx.translate(baseX, baseY);

    figCtx.beginPath();
    if (side > 0) figCtx.rect(0, -H * 2, W * 2, H * 4);
    else          figCtx.rect(-W * 2, -H * 2, W * 2, H * 4);
    figCtx.clip();

    drawRocketArt(figCtx, W, H, 1 / scale, {
      stageRole: 'payloadSpace',
      payloadKind: psType ? psType.kind : undefined,
      payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
      payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
      payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
      payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
      payloadColor: rec.color || '#e9edf2',
    });
    figCtx.restore();
  }
  // else: no members, no payload record, no fairing record — nothing to draw.

  if (!body) return;

  // ---- CoM / CoP / drag overlay ----
  const comY = baseY - H * 0.5;
  const aero = figAeroSnapshot(body);
  const sideSign = (aero.speedRel > 0.2 && Math.abs(aero.sinAlpha) > 0.02) ? -Math.sign(aero.velBodyX) : 0;
  const bCross = (typeof AERO_CP_BODY_FRAC !== 'undefined') ? AERO_CP_BODY_FRAC : 0.5;
  const cpX = baseX + sideSign * (W / 2) * aero.wCross;
  const cpY = baseY - H * bCross;

  figCtx.strokeStyle = '#ff4466';
  figCtx.lineWidth = 2;
  figCtx.beginPath();
  figCtx.moveTo(baseX - W * 0.4, comY);
  figCtx.lineTo(baseX + W * 0.4, comY);
  figCtx.stroke();
  figCtx.beginPath();
  figCtx.arc(baseX, comY, 4, 0, Math.PI * 2);
  figCtx.fillStyle = '#ff4466';
  figCtx.fill();
  figCtx.fillStyle = '#ff8899';
  figCtx.font = '10px monospace';
  figCtx.fillText('CoM', baseX + W * 0.45, comY + 3);

  figCtx.beginPath();
  figCtx.arc(cpX, cpY, 3, 0, Math.PI * 2);
  figCtx.fillStyle = 'rgba(120,220,255,0.95)';
  figCtx.fill();
  figCtx.fillStyle = '#8fd8ff';
  figCtx.font = '10px monospace';
  figCtx.fillText('CoP', cpX + 6, cpY + 3);

  if (showVectors) {
  const vecLen = H * 0.32;
  const vv = _figureVelocityVector(body);
  const vUnit = worldVectorToBodyUnit(vv.vx, vv.vy, body.theta);
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
  
  // Render the canvas at devicePixelRatio so it stays sharp on retina /
  // high-DPI screens. The canvas's CSS size is controlled by stylesheet;
  // the BACKING buffer is scaled up by DPR, and the context transform is
  // set so all drawing code can keep using CSS-pixel coordinates.
  const dpr = window.devicePixelRatio || 1;
  const cssW = basalCanvas.clientWidth || basalCanvas.width;
  const cssH = basalCanvas.clientHeight || basalCanvas.height;
  basalCanvas.width = Math.round(cssW * dpr);
  basalCanvas.height = Math.round(cssH * dpr);
  basalCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawBasalView() {
  if (!basalCtx) return;
  // Work in CSS pixels — the DPR transform set in initBasalCanvas() makes
  // this map to the full-resolution backing buffer automatically.
  const dpr = window.devicePixelRatio || 1;
  const w = basalCanvas.width / dpr;
  const h = basalCanvas.height / dpr;
  
  basalCtx.clearRect(0, 0, w, h);
  const cx = w / 2,
    cy = h / 2,
    R = Math.min(w, h) * 0.34;
  
  // Basal view = engines of the CURRENTLY-FOLLOWED body, not always the
  // active one. When you pick a payload / fairing half in the follow
  // dropdown, that body has no engines — show a placeholder rather than
  // drawing the stack's engines (which belong to a different body).
  const followIdx = (typeof _cameraTargetIndex === 'function')
    ? _cameraTargetIndex()
    : state.activeBodyIndex;
  const followBody = state.bodies[followIdx];
  const bodyEngines = (followBody && followBody.engines) ? followBody.engines : [];
  
  if (!bodyEngines.length) {
    // Placeholder — no engine cluster to show for this body.
    basalCtx.fillStyle = 'rgba(13,20,36,0.4)';
    basalCtx.strokeStyle = 'rgba(255,255,255,0.25)';
    basalCtx.lineWidth = 1.5;
    basalCtx.beginPath();
    basalCtx.arc(cx, cy, R * 1.40, 0, Math.PI * 2);
    basalCtx.fill();
    basalCtx.stroke();
    
    basalCtx.fillStyle = 'rgba(150,170,200,0.65)';
    basalCtx.font = '12px "JetBrains Mono", monospace';
    basalCtx.textAlign = 'center';
    basalCtx.textBaseline = 'middle';
    basalCtx.fillText('(no engines)', cx, cy);
    basalCtx.textAlign = 'left';
    basalCtx.textBaseline = 'alphabetic';
    return;
  }
  
  // Outer frame ring — solid white (was cyan).
  basalCtx.fillStyle = 'rgba(13,20,36,0.4)';
  basalCtx.strokeStyle = '#ffffff';
  basalCtx.lineWidth = 2.5;
  basalCtx.beginPath();
  basalCtx.arc(cx, cy, R * 1.40, 0, Math.PI * 2);
  basalCtx.fill();
  basalCtx.stroke();
  
  bodyEngines.forEach(e => {
    let ex, ey;
    if (e.isCenter) { ex = cx;
      ey = cy; }
    else {
      const rad = e.angleDeg * Math.PI / 180;
      let radDisfrac = 0.95;
      ex = cx + Math.cos(rad) * R * radDisfrac;
      ey = cy - Math.sin(rad) * R * radDisfrac;
    }
    
    // Driven by ACTUAL delivered thrust (currentF / Fmax), not the
    // throttle setting — a fuel-starved engine correctly reads off even
    // if its slider is still held up.
    const frac = e.Fmax > 0 ? e.currentF / e.Fmax : 0;
    const radius = e.isCenter ? 22 : 20;
    
    // Fill: faint disc at idle → solid white at full throttle. Alpha
    // ramps smoothly so mid-throttle reads as a soft grey, full throttle
    // as a bright white dot.
    const alpha = 0.10 + 0.90 * frac;
    basalCtx.fillStyle = `rgba(255,255,255,${alpha})`;
    basalCtx.beginPath();
    basalCtx.arc(ex, ey, radius, 0, Math.PI * 2);
    basalCtx.fill();
    
    // White outline so idle discs still read as defined shapes.
    basalCtx.strokeStyle = '#ffffff';
    basalCtx.lineWidth = 1.5;
    basalCtx.stroke();
    
    // Throttle % under the disc, only when there's meaningful thrust.
    if (frac > 0.02) {
      basalCtx.fillStyle = '#ffffff';
      basalCtx.font = '8px "JetBrains Mono", monospace';
      basalCtx.textAlign = 'center';
      //basalCtx.fillText(Math.round(frac*100)+'%', ex, ey + radius + 10);
    }
  });
  basalCtx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// Rolling mini graphs (altitude, velocity, thrust vs time)
// ---------------------------------------------------------------------------
const graphHistory = { t: [], alt: [], vel: [], thrust: [], q: [], slosh: [] };
const GRAPH_WINDOW = 60; // seconds of history kept

function pushGraphSample(t, alt, vel, thrust, q, slosh) {
  graphHistory.t.push(t);
  graphHistory.alt.push(alt);
  graphHistory.vel.push(vel);
  graphHistory.thrust.push(thrust);
  graphHistory.q.push(q);
  graphHistory.slosh.push(slosh);
  while (graphHistory.t.length && t - graphHistory.t[0] > GRAPH_WINDOW) {
    graphHistory.t.shift();
    graphHistory.alt.shift();
    graphHistory.vel.shift();
    graphHistory.thrust.shift();
    graphHistory.q.shift();
    graphHistory.slosh.shift();
  }
}

function drawMiniChart(canvasEl, data, color, label) {
  const ctx2 = canvasEl.getContext('2d');
  const w = canvasEl.width,
    h = canvasEl.height;
  ctx2.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const min = Math.min(...data),
    max = Math.max(...data);
  const range = (max - min) || 1;
  ctx2.strokeStyle = color;
  ctx2.lineWidth = 1.5;
  ctx2.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    if (i === 0) ctx2.moveTo(x, y);
    else ctx2.lineTo(x, y);
  });
  ctx2.stroke();
  ctx2.fillStyle = color;
  ctx2.font = '9px monospace';
  ctx2.fillText(`${label}: ${fmt(data[data.length-1], 1)}`, 3, 10);
}

function drawGraphs() {
  const altC = document.getElementById('graphAlt');
  const velC = document.getElementById('graphVel');
  const thrC = document.getElementById('graphThrust');
  const qC = document.getElementById('graphQ');
  const slC = document.getElementById('graphSlosh');
  if (altC) drawMiniChart(altC, graphHistory.alt, '#55ddff', 'alt');
  if (velC) drawMiniChart(velC, graphHistory.vel, '#ffdd55', 'v');
  if (thrC) drawMiniChart(thrC, graphHistory.thrust, '#ff8855', 'F');
  if (qC) drawMiniChart(qC, graphHistory.q, '#ff5fa8', 'Q kPa');
  if (slC) drawMiniChart(slC, graphHistory.slosh, '#a78bfa', 'slosh');
}


// ---------------------------------------------------------------------------
// Wind compass — small circular indicator showing the current wind vector
// direction and magnitude. Uses the same local tangent-frame convention as
// environment.js: 0° = East (right), 90° = Up/outward (top), 180° = West,
// 270° = Down/inward.
// ---------------------------------------------------------------------------
let windCompassCanvas = null;
let windCompassCtx = null;

function initWindCompass() {
  windCompassCanvas = document.getElementById('windCompass');
  if (!windCompassCanvas) return;
  windCompassCtx = windCompassCanvas.getContext('2d');
  
  // DPR scaling so it stays sharp on retina/high-DPI screens. All drawing
  // below works in CSS-pixel coordinates; the setTransform maps them.
  const dpr = window.devicePixelRatio || 1;
  const cssW = windCompassCanvas.clientWidth || 130;
  const cssH = windCompassCanvas.clientHeight || 130;
  windCompassCanvas.width = Math.round(cssW * dpr);
  windCompassCanvas.height = Math.round(cssH * dpr);
  windCompassCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawWindCompass() {
  if (!windCompassCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = windCompassCanvas.width / dpr;
  const h = windCompassCanvas.height / dpr;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.38;
  
  const c = windCompassCtx;
  c.clearRect(0, 0, w, h);
  
  // Backing disc
  c.fillStyle = 'rgba(13,20,36,0.6)';
  c.beginPath();
  c.arc(cx, cy, R + 8, 0, Math.PI * 2);
  c.fill();
  
  // Outer ring
  c.strokeStyle = 'rgba(255,255,255,0.30)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();
  
  // Tick marks every 30° — longer at the four cardinals
  c.strokeStyle = 'rgba(255,255,255,0.22)';
  c.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const ang = i * 30 * Math.PI / 180;
    const dx = Math.sin(ang),
      dy = -Math.cos(ang);
    const isCardinal = (i % 3 === 0);
    const len = isCardinal ? 8 : 5;
    c.beginPath();
    c.moveTo(cx + dx * (R - len), cy + dy * (R - len));
    c.lineTo(cx + dx * R, cy + dy * R);
    c.stroke();
  }
  
  // Cardinal labels in the local tangent frame:
  //   E (right, +x)  = direction of increasing φ = Earth's rotation
  //   W (left, -x)   = opposite
  //   U (top, -y)    = outward from Earth's centre
  //   D (bottom,+y)  = inward toward Earth's centre
  c.fillStyle = 'rgba(150,200,255,0.85)';
  c.font = 'bold 11px "JetBrains Mono", monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('U', cx, cy - R + 12);
  c.fillText('D', cx, cy + R - 12);
  c.fillText('E', cx + R - 12, cy);
  c.fillText('W', cx - R + 12, cy);
  
  if (wind.enabled && wind.speed > 0) {
    // wind.directionDeg: 0 = East, 90 = Up/outward.
    // Canvas convention: +x = right = East; -y = up = U.
    const ang = wind.directionDeg * Math.PI / 180;
    const dx = Math.cos(ang);
    const dy = -Math.sin(ang); // canvas y is inverted vs "Up"
    
    const arrowLen = R * 0.72;
    const tipX = cx + dx * arrowLen;
    const tipY = cy + dy * arrowLen;
    const tailX = cx - dx * arrowLen * 0.25;
    const tailY = cy - dy * arrowLen * 0.25;
    
    // Shaft
    c.strokeStyle = '#ff5f7e';
    c.lineWidth = 2.5;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(tailX, tailY);
    c.lineTo(tipX, tipY);
    c.stroke();
    
    // Arrowhead — two points behind the tip, rotated ±0.4 rad from the
    // reverse direction. angCanvas is atan2 in canvas coords (y down).
    const angCanvas = Math.atan2(dy, dx);
    const headLen = 9;
    const spread = 0.42;
    const h1x = tipX + headLen * Math.cos(angCanvas + Math.PI - spread);
    const h1y = tipY + headLen * Math.sin(angCanvas + Math.PI - spread);
    const h2x = tipX + headLen * Math.cos(angCanvas + Math.PI + spread);
    const h2y = tipY + headLen * Math.sin(angCanvas + Math.PI + spread);
    c.fillStyle = '#ff5f7e';
    c.beginPath();
    c.moveTo(tipX, tipY);
    c.lineTo(h1x, h1y);
    c.lineTo(h2x, h2y);
    c.closePath();
    c.fill();
    
    // Centre dot (marker for "no direction" reference point)
    c.beginPath();
    c.arc(cx, cy, 2.5, 0, Math.PI * 2);
    c.fill();
  } else {
    // Wind off — dim centre dot only
    c.fillStyle = 'rgba(107,125,156,0.5)';
    c.beginPath();
    c.arc(cx, cy, 3, 0, Math.PI * 2);
    c.fill();
  }
}

// ============================================================================
// Direction / wind HUD — top-center overlay.
//
// Shows the NET apparent wind relative to the GROUND (earth-fixed
// atmosphere), not the rocket:
//
//   atmosphere at altitude r   : ω·r        (east, in local frame)
//   earth surface at R_earth   : ω·R_earth  (east, in local frame)
//   net co-rotation excess     : ω·(r − R_earth) = ω · altitude
//
//   USER wind adds its own local east/up components on top.
//
//   NET = co-rotation excess + user wind
//
// Rocket velocity is NOT involved. What the arrow shows is "how fast is
// the air at this altitude moving eastward compared to the ground" —
// small at low altitude (2.9 m/s at 40 km), significant up high
// (14.6 m/s at 200 km, 29 m/s at 400 km).
// ============================================================================
let _dirHudCtx = null;

function drawDirectionHUD() {
  const canvas = document.getElementById('directionCanvas');
  if (!canvas) return;
  const hud = document.getElementById('directionHUD');
  if (!hud) return;
  
  const isPlanet = (typeof camera !== 'undefined' && camera.mode === 'planet');
  hud.style.display = isPlanet ? 'none' : '';
  if (isPlanet) return;
  
  if (!_dirHudCtx) _dirHudCtx = canvas.getContext('2d');
  const ctx = _dirHudCtx;
  
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 170;
  const cssH = canvas.clientHeight || 106;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
const w = cssW, h = cssH;
ctx.clearRect(0, 0, w, h);

// --- Compute net wind (ground-relative) ---
const followIdx = (typeof _cameraTargetIndex === 'function')
  ? _cameraTargetIndex() : state.activeBodyIndex;
const b = state.bodies ? state.bodies[followIdx] : null;

// --- Altitude gate for HUD repurposing ---
// Past the Karman line the "wind" compass has no physical meaning —
// there's no atmosphere to steer against. Two behaviours kick in:
//   * Within the last 10 s of the coast, the compass is replaced
//     by a big seconds-to-apogee countdown (burn trigger is at
//     startup + 2 s, so 10 s is a comfortable "get ready" window).
//   * Otherwise the wind arrows are suppressed; only the E/W/U/D
//     axes remain, so the HUD still shows orientation.
let _hudAltKm = 0;
if (b) {
  const _r = Math.hypot(b.rx, b.ry);
  _hudAltKm = (_r - CONFIG.EARTH_RADIUS) / 1000;
}
const _hudPastKarman = _hudAltKm > 100;

// --- Countdown takeover ---
if (b && _hudPastKarman) {
  const _r = Math.hypot(b.rx, b.ry);
  const _ux = b.rx / _r, _uy = b.ry / _r;
  const _ex = b.ry / _r, _ey = -b.rx / _r;
  const _vr = b.vx * _ux + b.vy * _uy;
  const _vt = b.vx * _ex + b.vy * _ey;
  const _tRem = _timeToApogeeKepler(_r, _vr, _vt, CONFIG.GM_EARTH);
  const _thrustOn = (b.engines || []).some(e => (e.massFlowRate || 0) > 5);
  if (Number.isFinite(_tRem) && _tRem > 0 && _tRem <= 10 && !_thrustOn) {
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = 'rgba(53,214,255,1)';
    ctx.font = 'bold 46px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.ceil(_tRem).toString(), cx, cy - 8);
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,210,63,0.95)';
    ctx.fillText('SECONDS TO APOGEE', cx, cy + 32);
    return;
  }
}
  
  let coRotE = 0;              // co-rotation excess (east)
  let userE = 0, userU = 0, userMag = 0;
  let netE = 0, netU = 0, netMag = 0, netDirDeg = 0;
  
  if (b) {
    const r = Math.hypot(b.rx, b.ry);
    if (r > 1) {
      const urx = b.rx / r, ury = b.ry / r;
      const eax = b.ry / r, eay = -b.rx / r;
      
      // Co-rotation excess at this altitude
      const altASL = r - CONFIG.EARTH_RADIUS;
      coRotE = CONFIG.EARTH_OMEGA * altASL;
      
      // User wind in local frame
      const wInert = (typeof windInertialVector === 'function')
        ? windInertialVector(b.rx, b.ry) : { wx: 0, wy: 0 };
      userE = wInert.wx * eax + wInert.wy * eay;
      userU = wInert.wx * urx + wInert.wy * ury;
      userMag = Math.hypot(userE, userU);
      
      netE = coRotE + userE;
      netU = userU;
      netMag = Math.hypot(netE, netU);
      netDirDeg = netMag > 0.01 ? Math.atan2(netU, netE) * 180 / Math.PI : 0;
    }
  }
  
  // --- Compass frame ---
  const cx = w / 2;
  const cy = h * 0.36;
  const R = Math.min(w, h * 1.2) * 0.22;
  
  ctx.strokeStyle = 'rgba(150,200,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - R - 8, cy); ctx.lineTo(cx + R + 8, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - R - 4); ctx.lineTo(cx, cy + R + 4);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.moveTo(cx - R - 8, cy - 3); ctx.lineTo(cx - R - 8, cy + 3);
  ctx.moveTo(cx + R + 8, cy - 3); ctx.lineTo(cx + R + 8, cy + 3);
  ctx.moveTo(cx - 3, cy - R - 4); ctx.lineTo(cx + 3, cy - R - 4);
  ctx.moveTo(cx - 3, cy + R + 4); ctx.lineTo(cx + 3, cy + R + 4);
  ctx.stroke();
  
  ctx.fillStyle = 'rgba(150,200,255,0.75)';
  ctx.font = 'bold 10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('W', cx - R - 16, cy);
  ctx.fillText('E', cx + R + 16, cy);
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.fillText('U', cx, cy - R - 11);
  ctx.fillText('D', cx, cy + R + 12);
  
  // --- User wind arrow (dotted, only if user wind on AND not past Karman) ---
// Past ~100 km the "wind" has no physical effect on the vehicle —
// there's effectively no atmosphere. Suppress the arrow so the HUD
// stops implying a force that isn't there. The compass axes still
// draw below, so orientation info is not lost.
if (!_hudPastKarman && wind.enabled && wind.speed > 0 && userMag > 0.1) {
    const nE = userE / userMag, nU = userU / userMag;
    const uLen = R * 0.65;
    ctx.strokeStyle = 'rgba(255,210,120,0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + nE * uLen, cy - nU * uLen);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  
 // --- Net wind arrow (suppressed past Karman) ---
if (!_hudPastKarman && netMag > 0.05) {
    // Auto-scale so a small co-rot-only wind still reads visibly.
    // Full arrow length for anything ≥ 5 m/s, linear below that.
    const scale = Math.min(1, Math.max(0.15, netMag / 5));
    const arrowLen = R * (0.35 + 0.65 * scale);
    const nE = netE / netMag, nU = netU / netMag;
    const tipX = cx + nE * arrowLen;
    const tipY = cy - nU * arrowLen;
    
    ctx.strokeStyle = '#ff5f7e';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    
    const ang = Math.atan2(-nU, nE);
    const headLen = 8;
    const spread = 0.5;
    ctx.fillStyle = '#ff5f7e';
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - headLen * Math.cos(ang - spread), tipY - headLen * Math.sin(ang - spread));
    ctx.lineTo(tipX - headLen * Math.cos(ang + spread), tipY - headLen * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fill();
  }
  
  // Center dot
  ctx.fillStyle = 'rgba(200,220,255,0.75)';
  ctx.beginPath();
  ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
  ctx.fill();
  
  // --- Readouts ---
  // Past Karman, wind has no physical meaning for the vehicle, so the
  // numeric readouts are suppressed too. Only shown below 100 km.
  if (!_hudPastKarman) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    
    const netTxt = `NET  ${netMag.toFixed(1)} m/s  ·  ${(netMag * 3.6).toFixed(0)} km/h  ·  ${Math.round(netDirDeg)}°`;
    ctx.fillStyle = netMag > 0.05 ? 'rgba(255,150,180,0.95)' : 'rgba(150,160,180,0.55)';
    ctx.font = '9.5px "JetBrains Mono", monospace';
    ctx.fillText(netTxt, cx, cy + R + 12);
    
    const subTxt = `CO-ROT ${coRotE.toFixed(1)}  +  USER ${userMag.toFixed(1)}`;
    ctx.fillStyle = (userMag > 0.1) ? 'rgba(255,210,120,0.85)' : 'rgba(150,170,200,0.7)';
    ctx.font = '8.5px "JetBrains Mono", monospace';
    ctx.fillText(subTxt, cx, cy + R + 25);
  }
  }