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
let showTrajectory = false;
// Phase 2A — fuel slosh. Mirrors CONFIG.SLOSH_ENABLED on the physics
// worker (see main.js's toggleSlosh binding); kept here alongside the
// other display toggles purely so the UI checkbox has a main-thread state
// to read back. The actual on/off effect lives entirely in the worker —
// when off, body.slosh.offset/velocity decay to 0 and nothing renders.
let sloshEnabled = true;
let trajectoryMode = 'inertial'; // 'inertial' | 'earthFixed'
// Umbilical tower retract animation: 0 = upright/latched against the
// vehicle, 1 = fully swung back. Driven off real elapsed time (like the
// hazard-light blink below) so it animates smoothly regardless of sim
// speed/pause state, and tracks liftoff directly off current altitude so
// it needs no reset hook — it just eases back down on its own once the
// vehicle settles back near the pad.
let towerTilt = 0;
let towerTiltLastT = null;
// Separation-flash local timing. We track the last-seen flash id and the
// wall-clock instant we first saw it, so the visual runs for a fixed 0.35 s
// REGARDLESS of time-warp (sim time could pass 40× faster than wall time,
// which would compress the whole effect into one frame).
let _lastFlashId = -1;
let _flashLocalStart = 0;
let _lastPayloadCueId = -1;
let _payloadCueLocalStart = 0;

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
  const b = state.bodies[_cameraTargetIndex()];
  if (!b) return 0;
  return Math.atan2(b.rx, b.ry);
}

// worldToLocal() is called many times per frame (once per point converted
// in localToScreen — grid lines, rocket outline, flame, stars, vectors...).
// Its result only changes once per physics/render tick, and computing it
// involves a full mass-stack pass (currentGeometry -> stackMassProps), so
// it's cached here and only recomputed when the underlying state actually
// moves on. invalidateWorldToLocalCache() is called once at the top of
// renderFrame() to clear it for the new frame.




// meters -> pixels, and local(x,y) -> screen(px,py)
// ---------------------------------------------------------------------------
// Camera (round Earth, R1) — camera is centered on the active body's COM
// in the inertial frame. "Up" on screen is the LOCAL RADIAL direction
// (Earth center → camera). This means:
//   - On the pad, up = ground-normal — same look as the old flat model.
//   - As the rocket climbs and moves downrange, "up" rotates with it.
//   - Zoomed out far enough, Earth's curvature becomes visible.
// Every drawing pass supplies WORLD (inertial) coordinates to
// worldToScreen(); nothing uses a "flat tangent-plane" any more.
// ---------------------------------------------------------------------------

let cameraCenter = { x: 0, y: CONFIG.EARTH_RADIUS }; // free-cam world position

// Which body is the camera currently pointed at? Prefers the user's
// explicit followBodyIndex (dropdown selection) over the active body —
// so choosing "Payload" or "Fairing R" in the toolbar dropdown actually
// moves the camera to that body, not just relabels the option.
// ---------------------------------------------------------------------------
// Which body is the camera / side panels pointed at?
// Prefers the user's explicit dropdown selection (camera.followBodyIndex)
// over the currently-controlled body, so picking "Payload" or "Fairing R"
// in the toolbar actually moves camera, figure panel, and basal view to
// that body — not just relabels the option.
// ---------------------------------------------------------------------------
function _cameraTargetIndex() {
  const idx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex)) ?
    camera.followBodyIndex : 0;
  if (state.bodies && state.bodies[idx]) return idx;
  return state.activeBodyIndex;
}
function cameraWorldPosition() {
  if (camera.mode === 'planet') {
    return { x: 0, y: 0 }; // Earth's center is the planet-view camera anchor
  }
  
  if (!camera.follow) return { x: cameraCenter.x, y: cameraCenter.y };
  const b = state.bodies[_cameraTargetIndex()];
  if (!b) return { x: 0, y: CONFIG.EARTH_RADIUS };
  
  // Camera anchor = a FIXED fraction of the rocket's geometric height above
  // its base (0.5 = mid-height). Earlier this used the physical center of
  // mass, which shifted every time mass moved inside the stack — fuel burn,
  // staging, legs deploying (their COM swings ~9m as they unfold), payload
  // release. At high zoom those shifts showed up as the ground sliding a
  // few pixels during what should look like a still shot.
  //
  // Anchor-on-geometry keeps the visual frame steady across every mass-
  // distribution change. The anchor is still in the body's LOCAL frame, so
  // it rotates with the rocket during tumbles and gravity turns.
  // Solo bodies (payloads, fairing halves, ejected packages) have no
// members — use their own stored height instead of falling back to
// the active stack's 45 m. Without this, a payload's camera anchor
// sat 22.5 m from its actual position instead of 4 m, and any spin
// sent the body revolving around screen-center at 5.6× the correct
// radius. Same preference order as physics.js's _bodyHeightOf.
const totalH = (b.members && b.members.length) ?
  b.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) :
  (Number.isFinite(b.height) && b.height > 0 ? b.height : (CONFIG.ROCKET_HEIGHT || 45));
const anchorH = totalH * 0.5;
  
  const cT = Math.cos(b.theta),
    sT = Math.sin(b.theta);
  // local (0, anchorH) rotated into world — same convention as physics.js's
  // _rotatedPoint() (local +Y = up-stack, world up = (-sinθ, +cosθ)).
  return {
    x: b.rx - anchorH * sT,
    y: b.ry + anchorH * cT,
  };
}

function cameraAngle() {
  const ref = cameraVerticalReference();
  return Math.atan2(ref.x, ref.y);
}

// ---------------------------------------------------------------------------
// VISUAL BUG FIX: ground/horizon bobbing during a fast tumble (e.g. a
// spinning crash).
//
// cameraWorldPosition()'s anchor is DELIBERATELY pinned to a fixed spot
// along the rocket's own long axis (see its comment) — that's what fixed
// the earlier bug where the ground slid as the COM shifted during fuel
// burn. But being pinned to the body's LOCAL axis means it also rotates
// WITH the body's theta. During slow/normal attitude changes that's
// imperceptible. During a fast tumble, that anchor sweeps a circle around
// the body's actual position at the spin rate — and worldToScreen()/
// cameraAngle() were both deriving the screen's "up" direction (and the
// launch pad's rotation) from THAT swinging point's own angle relative to
// Earth's center. The result: the whole screen basis wobbled at the spin
// rate, which reads as the ground/horizon bobbing up and down even though
// the camera's real altitude barely changed.
//
// Fix: "up" must come from a point that only TRANSLATES with the body,
// never rotates with it — the body's own rx/ry. Framing/panning still use
// the real anchor via cameraWorldPosition() (unchanged, dx/dy in
// worldToScreen below), so the original fuel-burn/COM-shift fix is
// untouched; only the ORIENTATION reference changes.
function cameraVerticalReference() {
  if (camera.mode === 'planet') return { x: 0, y: 0 };
  if (!camera.follow) return cameraWorldPosition();
  const b = state.bodies[_cameraTargetIndex()];
return b ? { x: b.rx, y: b.ry } : cameraWorldPosition();
}

function worldToScreen(wx, wy) {
  const mpp = metersPerPixel();
  const cam = cameraWorldPosition();
  
  let upX, upY, rightX, rightY;
  if (camera.mode === 'planet') {
    // Whole-Earth view: camera sits at Earth's center (0,0), so the
    // radial "up" derived from camera position is degenerate. Use a
    // FIXED inertial orientation instead: world +y = screen up.
    // Consequence: the planet appears stationary and the rocket's
    // world position (which rotates with Earth at the surface) will
    // visibly drift around the disc — same way an external observer
    // would see it.
    upX = 0;
    upY = 1;
    rightX = 1;
    rightY = 0;
  } else {
    // Local view: up = direction from Earth's center to a STABLE
    // reference point (see cameraVerticalReference() above) — NOT the
    // rotating camera anchor. This is what gives the flat-ground look
    // and correct attitude rotation, without wobbling during a fast
    // tumble.
    const ref = cameraVerticalReference();
    const refR = Math.hypot(ref.x, ref.y) || 1;
    upX = ref.x / refR;
    upY = ref.y / refR;
    rightX = upY;
    rightY = -upX;
  }
  
  const dx = wx - cam.x,
    dy = wy - cam.y;
  const localR = dx * rightX + dy * rightY;
  const localU = dx * upX + dy * upY;
  
  return [
    canvas.width / 2 + localR / mpp,
    canvas.height / 2 - localU / mpp,
  ];
}

function metersPerPixel() {
  if (camera.mode === 'planet') {
    // Auto-fit Earth to ~40% of the smaller viewport dimension, so the
    // whole planet is always visible regardless of canvas size.
    const fitR = Math.min(canvas.width, canvas.height) * 0.40;
    return CONFIG.EARTH_RADIUS / fitR;
  }
  return 1 / (0.4 * camera.zoom);
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
  let top = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], bot = [c[0], c[1], c[2]];
  if (typeof SimLighting !== 'undefined' && SimLighting.enabled()) {
    const sc = SimLighting.skyColors(c, densityFrac); top = sc.top; bot = sc.bot;
  }
  grad.addColorStop(0, `rgb(${top[0]},${top[1]},${top[2]})`);
  grad.addColorStop(1, `rgb(${bot[0]},${bot[1]},${bot[2]})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (typeof SimLighting !== 'undefined') SimLighting.drawBackdrop(ctx, canvas, altitude);
}

function lerpColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function drawGrid() {
  if (!showGrid) return;
  const mpp = metersPerPixel();
  
  // In planet mode, use a radial grid (concentric altitude circles +
  // angular spokes) instead of the flat-view horizontal/vertical lines —
  // the flat model's "horizontal line" formula breaks down when the
  // camera is at Earth's center (camR = 0).
  if (camera.mode === 'planet') {
    drawPlanetGrid(mpp);
    return;
  }
  
  
  // ---- Clip: hide everything inside Earth's silhouette ----
  // Without this, both the altitude rings and the downrange lines run all
  // the way through the planet's interior, and the earth-colored disc
  // doesn't hide them (grid is drawn on top of the earth). Screen-space
  // clip-outside-circle with the even-odd fill rule: outer rect minus
  // Earth disc = only the visible sky region gets painted.
  const [ecx, ecy] = worldToScreen(0, 0);
  const eRpx = CONFIG.EARTH_RADIUS / mpp;
  
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.arc(ecx, ecy, eRpx, 0, Math.PI * 2, true); // reverse winding = hole
  ctx.clip('evenodd');
  
  const spacingMeters = niceGridSpacing(mpp * 100);
  const cam = cameraWorldPosition();
  const camR = Math.hypot(cam.x, cam.y) || 1;
  const camAlt = camR - CONFIG.EARTH_RADIUS - (CONFIG.LAUNCH_SITE_ALTITUDE || 0);
  
  ctx.strokeStyle = 'rgba(120,180,255,0.22)';
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(150,200,255,0.55)';
  
  const halfW = canvas.width / 2;
  const halfH = canvas.height / 2;
  
  // ---- Altitude rings (horizontal lines) ----
  const baseAlt = Math.floor(camAlt / spacingMeters) * spacingMeters;
  const altRange = canvas.height * mpp;
  for (let alt = baseAlt - altRange; alt <= camAlt + altRange; alt += spacingMeters) {
    const localU = alt - camAlt;
    const py = halfH - localU / mpp;
    if (py < -10 || py > canvas.height + 10) continue;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(canvas.width, py);
    ctx.stroke();
    
    // Label default sits ABOVE the line. For the topmost visible line, that
    // would push the text off the canvas top (text baseline at y < 10 goes
    // out of bounds). Flip to below when we're within 15 px of the top.
    const labelY = (py < 15) ? (py + 12) : (py - 3);
    ctx.fillText(alt.toFixed(0) + 'm', 3, labelY);
  }
  
  // ---- Downrange lines (vertical lines) ----
  const spacingAngle = spacingMeters / CONFIG.EARTH_RADIUS;
  const camPhi = Math.atan2(cam.x, cam.y);
  const angleRange = (canvas.width * mpp) / CONFIG.EARTH_RADIUS;
  
  // Launch site's inertial angle at this instant.
  const launchPhi = (CONFIG.LAUNCH_SITE_ANGLE_0 || 0) + CONFIG.EARTH_OMEGA * state.simTime;
  
  // Snap grid lines to EARTH-FIXED angular positions — anchored on the
  // launch site, not on the inertial frame. Without this offset the grid
  // is inertial-fixed while the labels are Earth-fixed, so as Earth
  // rotates the "0m" label visibly slides across the static grid lines
  // and the whole thing jitters. Adding launchPhi before and after the
  // floor() shifts the snap lattice so it rotates with the ground.
  const relPhi = camPhi - launchPhi;
  const basePhi = Math.floor(relPhi / spacingAngle) * spacingAngle + launchPhi;
  
  for (let dphi = -angleRange; dphi <= angleRange; dphi += spacingAngle) {
    const phi = basePhi + dphi;
    const wx = camR * Math.sin(phi);
    const wy = camR * Math.cos(phi);
    const [px] = worldToScreen(wx, wy);
    if (px < -10 || px > canvas.width + 10) continue;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
    
    // Downrange distance from launch site, along Earth's surface. Sign
    // preserved (+ east of pad, − west). Auto-units: m below 1 km, km above.
    const arcDist = (phi - launchPhi) * CONFIG.EARTH_RADIUS;
    const absDist = Math.abs(arcDist);
    const label = absDist < 1000 ?
      arcDist.toFixed(0) + 'm' :
      (arcDist / 1000).toFixed(1) + 'km';
    
    // Label sits near the bottom of the vertical line, tinted slightly
    // dimmer than the altitude labels so the two families stay distinct.
    // Labels sit ABOVE the ground line — the ground-line y is where Earth
    // begins on screen, and everything below it is inside the clipped-out
    // disc. Anchor labels 8px above it so they land in the visible sky.
    const groundX = cam.x * (CONFIG.EARTH_RADIUS / camR);
    const groundY = cam.y * (CONFIG.EARTH_RADIUS / camR);
    const [, groundPy] = worldToScreen(groundX, groundY);
    
    ctx.fillStyle = 'rgba(150,200,255,0.55)';
    ctx.fillText(label, px + 3, groundPy - 8);
  }
  
  // restore altitude-label fill color for the next frame's altitude loop
  ctx.fillStyle = 'rgba(150,200,255,0.55)';
  
  ctx.restore();
}

function drawPlanetGrid(mpp) {
  const [ecx, ecy] = worldToScreen(0, 0);
  const Rpx = CONFIG.EARTH_RADIUS / mpp;
  if (!Number.isFinite(Rpx) || Rpx <= 0) return;
  
  ctx.save();
  
  // Clip out the Earth disc so grid lines don't draw on top of the planet.
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.arc(ecx, ecy, Rpx, 0, Math.PI * 2, true);
  ctx.clip('evenodd');
  
  ctx.strokeStyle = 'rgba(120,180,255,0.28)';
  ctx.lineWidth = 2;
  ctx.font = '12px monospace';
  
  const rMaxPx = Math.hypot(canvas.width, canvas.height) / 2;
  
  
  // ---- Concentric altitude rings ----
  // Fixed, meaningful altitude steps rather than the local view's
  // zoom-dependent spacing — planet view spans thousands of km per pixel,
  // so "nice" values tied to pixel size would either be one giant ring or
  // dozens of sub-pixel ones. These cover LEO → MEO → GEO.
  const altSteps_m = [
    500e3, 1000e3, 2000e3, 5000e3,
    10000e3, 20000e3, 35786e3, // last one = GEO altitude
  ];
  
  altSteps_m.forEach(h => {
    const rPx = (CONFIG.EARTH_RADIUS + h) / mpp;
    if (rPx < Rpx + 4) return; // too close to surface to draw cleanly
    if (rPx > rMaxPx * 1.3) return; // off-canvas
    ctx.beginPath();
    ctx.arc(ecx, ecy, rPx, 0, Math.PI * 2);
    ctx.stroke();
    
    // Label at the top of the ring. Highlight GEO distinctly.
    const label = (h / 1000).toFixed(0) + ' km';
    const isGeo = Math.abs(h - 35786e3) < 100;
    ctx.fillStyle = isGeo ?
      'rgba(255,210,63,0.75)' :
      'rgba(150,200,255,0.55)';
    ctx.fillText(label + (isGeo ? ' GEO' : ''), ecx + 4, ecy - rPx - 3);
  });
  
  // ---- Radial spokes ----
  // Anchored to the launch site's current inertial angle so one spoke
  // always passes through the pad. As Earth rotates, the whole spoke
  // fan rotates with it (pad stays on a spoke).
  const spokeCount = 12;
  const spokeStep = (Math.PI * 2) / spokeCount;
  const launchPhi = (CONFIG.LAUNCH_SITE_ANGLE_0 || 0) + CONFIG.EARTH_OMEGA * state.simTime;
  const spokeRm = rMaxPx * 1.5 * mpp; // extend well past corners in world meters
  
  ctx.strokeStyle = 'rgba(120,180,255,0.20)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < spokeCount; i++) {
    const phi = launchPhi + i * spokeStep;
    const wx = spokeRm * Math.sin(phi);
    const wy = spokeRm * Math.cos(phi);
    const [px, py] = worldToScreen(wx, wy);
    ctx.beginPath();
    ctx.moveTo(ecx, ecy);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
  
  // Highlight the spoke that passes through the pad.
  const padX = spokeRm * Math.sin(launchPhi);
  const padY = spokeRm * Math.cos(launchPhi);
  const [padPx, padPy] = worldToScreen(padX, padY);
  ctx.strokeStyle = 'rgba(53,214,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ecx, ecy);
  ctx.lineTo(padPx, padPy);
  ctx.stroke();
  
  ctx.restore();
}

function niceGridSpacing(target) {
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * pow;
}

function drawEarth() {
  const mpp = metersPerPixel();
  const [cx, cy] = worldToScreen(0, 0);
  const Rpx = CONFIG.EARTH_RADIUS / mpp;
  if (Rpx < 0.5) return;
  
  // Solid surface only — no outline, no glow. Earth is a closed figure;
  // its edge is just the boundary of the filled circle.
  ctx.fillStyle = '#0d2b12';
  ctx.beginPath();
  ctx.arc(cx, cy, Rpx, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Remote area (final resting zone) — earth-fixed arc drawn on the surface
// west of the launch site. A memorial, not a hazard marker.
//
// Rotates with Earth automatically: earth-fixed angles are converted to
// inertial by adding ω_e·t, same convention as launchSiteWorldPosition().
//
// Visible in both camera modes:
//   - Planet mode (camera at Earth centre): arc appears as a curved band
//     on the disc, label + quote float just outside it.
//   - Local mode (camera near surface): near-side segments of the arc
//     are drawn; far-side segments are culled by the horizon test.
//     Label + quote suppressed (midpoint is almost always on the far
//     side during a local pass).
//
// Called after drawEarth() so the arc sits on top of the planet fill,
// but before trajectory / pad / rocket so those always draw over it.
// ---------------------------------------------------------------------------
function drawRemoteArea() {
  const R = CONFIG.EARTH_RADIUS;
  const phi0 = CONFIG.LAUNCH_SITE_ANGLE_0 || 0;
  const omegaE = CONFIG.EARTH_OMEGA;
  const t = state.simTime;
  
  const westStartRad = (CONFIG.REMOTE_AREA_WEST_START_DEG || 120) * Math.PI / 180;
  const westEndRad   = (CONFIG.REMOTE_AREA_WEST_END_DEG   || 180) * Math.PI / 180;
  
  // Inertial angles: earth-fixed angle + ω·t.
  const phiStart = phi0 - westStartRad + omegaE * t;
  const phiEnd   = phi0 - westEndRad   + omegaE * t;
  
  // Sample the arc densely. 64 samples over 60° gives ~1° steps, smooth
  // at any zoom level.
  const N = 64;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const phi = phiStart + f * (phiEnd - phiStart);
    pts.push({ x: R * Math.sin(phi), y: R * Math.cos(phi) });
  }
  
  // Horizon occlusion test — in local mode, a surface point is only
  // visible from the camera if it's on the near side of Earth. Planet
  // mode has the camera at Earth's centre, so every point is visible.
  const cam = cameraWorldPosition();
  const camR = Math.hypot(cam.x, cam.y);
  const rSquared = R * R;
  const visible = pts.map(p => {
    if (camera.mode === 'planet') return true;
    if (camR <= R + 1) return true;
    return (p.x * cam.x + p.y * cam.y) >= rSquared;
  });
  
  const screenPts = pts.map(p => worldToScreen(p.x, p.y));
  
  // Split into contiguous visible segments — the arc can break into two
  // pieces as Earth's horizon sweeps across it.
  const segs = [];
  let cur = null;
  for (let i = 0; i <= N; i++) {
    if (visible[i]) {
      if (!cur) { cur = []; segs.push(cur); }
      cur.push(screenPts[i]);
    } else {
      cur = null;
    }
  }
  if (!segs.length) return;
  
  // ---- Palette — planet view: soft violet/pink (unchanged).
  //                 local view: blue, to match ocean / match user preference.
  const _isPlanetView = camera.mode === 'planet';
  const CORE  = _isPlanetView ? '#9a8ae8' : '#55b0ff';
  const GLOW  = _isPlanetView ? 'rgba(124, 111, 214, 0.20)' : 'rgba(50, 120, 255, 0.25)';
  const CAP   = _isPlanetView ? '#b8aaf0' : '#80c0ff';
  const LABEL = _isPlanetView ? '#d4c9ff' : '#c0e0ff';
  const QUOTE = _isPlanetView ? '#a898e8' : '#a0d0ff';
  
  ctx.save();
  
  // ---- Soft glow band under the core stroke ----
  ctx.strokeStyle = GLOW;
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  segs.forEach(seg => {
    ctx.beginPath();
    seg.forEach(([x, y], i) => { i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  });
  
  // ---- Core stroke ----
  ctx.strokeStyle = CORE;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  segs.forEach(seg => {
    ctx.beginPath();
    seg.forEach(([x, y], i) => { i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  });
  
  // ---- Cap ticks at arc endpoints (only when that endpoint is visible) ----
  [[0, R], [N, R]].forEach(([i]) => {
    if (!visible[i]) return;
    const p = pts[i];
    // Extrapolate 20 km radially outward from the surface.
    const ox = p.x * (R + 20000) / R;
    const oy = p.y * (R + 20000) / R;
    const [px0, py0] = worldToScreen(p.x, p.y);
    const [px1, py1] = worldToScreen(ox, oy);
    ctx.strokeStyle = CAP;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.stroke();
  });
  
  // ---- Label + quote — planet mode only ----
  // In local mode the arc midpoint is almost always on the far side of
  // Earth, so drawing text there would either be invisible or land in
  // the wrong place. Restrict to planet mode.
  if (camera.mode === 'planet') {
    const midIdx = Math.round(N / 2);
    const mp = pts[midIdx];
    // Offset radially outward 40 px so the text floats just off the disc.
    const [sx, sy] = worldToScreen(mp.x, mp.y);
    const nx = mp.x / R, ny = mp.y / R;
    const labelX = sx + nx * 40;
    const labelY = sy - ny * 40;
    
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Label
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.fillStyle = LABEL;
    ctx.fillText(CONFIG.REMOTE_AREA_LABEL || 'FINIS ITINERIS', labelX, labelY);
    
    // Quote
    ctx.font = 'italic 10px "JetBrains Mono", monospace';
    ctx.fillStyle = QUOTE;
    ctx.fillText(CONFIG.REMOTE_AREA_QUOTE || '', labelX, labelY + 16);
    
    if (CONFIG.REMOTE_AREA_QUOTE_AUTHOR) {
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = _isPlanetView ? 'rgba(168, 152, 232, 0.75)' : 'rgba(160, 208, 255, 0.75)';
      ctx.fillText('— ' + CONFIG.REMOTE_AREA_QUOTE_AUTHOR, labelX, labelY + 30);
    }
  }
  
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Ocean zone — earth-fixed arc EAST of launch, drawn as a filled swath
// on the surface. Marks fairing splashdown stretch (future ASDS site).
// Same earth-fixed convention as drawRemoteArea(): the arc rotates with
// Earth automatically via the ω_e·t term.
// ---------------------------------------------------------------------------
function drawOceanArea() {
  const R = CONFIG.EARTH_RADIUS;
  const phi0 = CONFIG.LAUNCH_SITE_ANGLE_0 || 0;
  const omegaE = CONFIG.EARTH_OMEGA;
  const t = state.simTime;
  
  const eastStartRad = (CONFIG.OCEAN_ZONE_EAST_START_DEG || 2) * Math.PI / 180;
  const eastEndRad   = (CONFIG.OCEAN_ZONE_EAST_END_DEG   || 60) * Math.PI / 180;
  
  const phiStart = phi0 + eastStartRad + omegaE * t;
  const phiEnd   = phi0 + eastEndRad   + omegaE * t;
  
  const BAND_DEPTH_M = 80000;
  const rOuter = R + BAND_DEPTH_M;
  
  const N = 64;
  const innerPts = [], outerPts = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const phi = phiStart + f * (phiEnd - phiStart);
    const s = Math.sin(phi), c = Math.cos(phi);
    innerPts.push({ x: R * s,      y: R * c      });
    outerPts.push({ x: rOuter * s, y: rOuter * c });
  }
  
  const cam = cameraWorldPosition();
  const camR = Math.hypot(cam.x, cam.y);
  const rSquared = R * R;
  const visible = innerPts.map(p => {
    if (camera.mode === 'planet') return true;
    if (camR <= R + 1) return true;
    return (p.x * cam.x + p.y * cam.y) >= rSquared;
  });
  
  const innerScreen = innerPts.map(p => worldToScreen(p.x, p.y));
  const outerScreen = outerPts.map(p => worldToScreen(p.x, p.y));
  
  const segs = [];
  let cur = null;
  for (let i = 0; i <= N; i++) {
    if (visible[i]) {
      if (!cur) { cur = { i0: i, i1: i }; segs.push(cur); }
      else cur.i1 = i;
    } else {
      cur = null;
    }
  }
  if (!segs.length) return;
  
  const FILL_TOP    = 'rgba(60, 140, 255, 0.35)';
  const FILL_BOTTOM = 'rgba(20, 70, 180, 0.15)';
  const EDGE        = 'rgba(80, 160, 255, 0.90)';
  const CAP         = 'rgba(80, 160, 255, 0.60)';
  
  ctx.save();
  
  segs.forEach(seg => {
    const { i0, i1 } = seg;
    if (i1 <= i0) return;
    
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const [x, y] = outerScreen[i];
      if (i === i0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = i1; i >= i0; i--) {
      const [x, y] = innerScreen[i];
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    const midIdx = Math.floor((i0 + i1) / 2);
    const [mx, myOut] = outerScreen[midIdx];
    const [, myIn] = innerScreen[midIdx];
    const grad = ctx.createLinearGradient(mx, myOut, mx, myIn);
    grad.addColorStop(0, FILL_TOP);
    grad.addColorStop(1, FILL_BOTTOM);
    ctx.fillStyle = grad;
    ctx.fill();
    
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const [x, y] = outerScreen[i];
      if (i === i0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  
    // ---- Endpoint ticks at the ocean-zone boundaries (only when visible) ----
  [[0, innerPts[0], outerPts[0]],
   [N, innerPts[N], outerPts[N]]].forEach(([i, pIn, pOut]) => {
    if (!visible[i]) return;
    // Extend the tick slightly past the band edges so it reads as a
    // bounded zone rather than a rectangle.
    const rLow = R - 30000, rHigh = R + BAND_DEPTH_M + 30000;
    const sx = pIn.x / R, sy = pIn.y / R;
    const [px0, py0] = worldToScreen(sx * rLow,  sy * rLow);
    const [px1, py1] = worldToScreen(sx * rHigh, sy * rHigh);
    ctx.strokeStyle = CAP;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.stroke();
  });
  
  // ---- Label — planet mode only ----
  // In local mode the arc midpoint is almost always on the far side of
  // Earth, so drawing text there would either be invisible or land in
  // the wrong place.
  if (camera.mode === 'planet') {
    const midIdx = Math.round(N / 2);
    const mp = outerPts[midIdx];
    const [sx, sy] = worldToScreen(mp.x, mp.y);
    const nx = mp.x / rOuter, ny = mp.y / rOuter;
    const labelX = sx + nx * 20;
    const labelY = sy - ny * 20;
    
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(120, 190, 255, 0.95)';
    ctx.fillText('Ocean', labelX, labelY);
  }
  
  ctx.restore();
}
// ===== LAUNCHPAD BEGIN ======================================================
// Launch site (LC-39A / SLC-40 style), true 2D side CUTAWAY, all in metres.
//
// ORIENTATION: in the local camera view SCREEN-RIGHT = EAST (worldToScreen's
// right = (upY,-upX) = direction of increasing phi = Earth's rotation). Flights
// go east, so everything tall and heavy (strongback/TEL, FSS tower, water
// tower, LOX tanks) stands WEST (left, behind the vehicle) and only low
// ground-support equipment sits EAST. The strongback retracts WEST, away from
// the pitch-over direction.
//
// Datum: rocket base = local (0,0) = surface level (unchanged: physics/ground
// FX depend on it). The pad is drawn as a cutaway through the flame trench:
// concrete hardstand, launch table with flame hole, trench with a V-shaped
// flame deflector (apex ~3 m under the base, close to GROUND_FX plume clip).
// Static geometry is built once into Path2D layers (cached by vehicle size)
// and replayed with one transform, so per-frame cost is a few dozen strokes.
// Lit by SimLighting (pseudo-body at the pad) -> follows sun/moon/ambient.
// ============================================================================
const _PAD = { geo: null, key: '', body: null, glow: null, glowRed: null, fireK: 0, fireT: 0, fireStamp: -1e9 };

class _PadPath {            // Path2D stand-in for engines without Path2D in workers
  constructor() { this.o = []; }
  moveTo(x, y) { this.o.push(0, x, y); }
  lineTo(x, y) { this.o.push(1, x, y); }
  rect(x, y, w, h) { this.o.push(2, x, y, w, h); }
  arc(x, y, r, a0, a1) { this.o.push(3, x, y, r, a0, a1); }
  quadraticCurveTo(a, b, x, y) { this.o.push(4, a, b, x, y); }
  closePath() { this.o.push(5); }
}
function _padNewPath() { return (typeof Path2D !== 'undefined') ? new Path2D() : new _PadPath(); }
function _padReplay(c, p) {
  const o = p.o; c.beginPath();
  for (let i = 0; i < o.length;) {
    switch (o[i]) {
      case 0: c.moveTo(o[i + 1], o[i + 2]); i += 3; break;
      case 1: c.lineTo(o[i + 1], o[i + 2]); i += 3; break;
      case 2: c.rect(o[i + 1], o[i + 2], o[i + 3], o[i + 4]); i += 5; break;
      case 3: c.arc(o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5]); i += 6; break;
      case 4: c.quadraticCurveTo(o[i + 1], o[i + 2], o[i + 3], o[i + 4]); i += 5; break;
      default: c.closePath(); i += 1;
    }
  }
}
function _padStroke(c, p) { if (p instanceof _PadPath) { _padReplay(c, p); c.stroke(); } else c.stroke(p); }
function _padFill(c, p) { if (p instanceof _PadPath) { _padReplay(c, p); c.fill(); } else c.fill(p); }

// Base (full daylight) material colours.
const _PAD_MATS = {
  conc: [160, 156, 149], concDk: [112, 109, 105], concLn: [74, 72, 70],
  steel: [112, 119, 128], steelDk: [58, 63, 70], steelLt: [172, 180, 189],
  white: [232, 234, 236], whiteDk: [182, 188, 194], red: [196, 44, 38],
  void: [9, 10, 12], refr: [132, 92, 68], scorch: [34, 32, 32], glass: [40, 56, 70],
};

// One colour set per frame (cheap: ~16 strings). far = hazier back layer.
function _padPalette(Lt, far) {
  let B = 1, warm = 0, night = 0;
  if (Lt) {
    const sunFace = Lt.lit * (0.55 + 0.45 * Math.min(1, Math.max(0, Lt.ly * 1.4 + 0.1)));
    B = Math.min(1.12, Math.max(0.16, 0.12 + Lt.amb * 0.75 + 0.68 * sunFace + 0.5 * Lt.moon));
    warm = Lt.tint || 0;
    night = Math.min(1, Math.max(0, (0.6 - Lt.lit) / 0.5));
  }
  const haze = far ? 0.14 : 0;
  const pal = { B, night, warm };
  for (const k in _PAD_MATS) {
    const c = _PAD_MATS[k];
    let r = c[0] * B * (1 + 0.14 * warm), g = c[1] * B * (1 + 0.02 * warm), b = c[2] * B * (1 - 0.26 * warm);
    if (haze) { r += (150 * B - r) * haze; g += (165 * B - g) * haze; b += (185 * B - b) * haze; }
    pal[k] = 'rgb(' + (r > 255 ? 255 : r | 0) + ',' + (g > 255 ? 255 : g | 0) + ',' + (b > 255 ? 255 : b | 0) + ')';
  }
  return pal;
}

function _padBuild(H, W, slabHalf) {
  const w2 = W / 2, TAU = Math.PI * 2;
  const back = [], mid = [], front = [], sb = [];
  const lights = [];                       // {x,y,r,k:'f'|'r'} (strongback ones are added at draw time)
  const add = (arr, p, mat, kind, w, lod) => arr.push({ p, mat, k: kind, w: w || 0, lod: lod || 0 });
  const P = () => _padNewPath();
  const L = (p, x1, y1, x2, y2) => { p.moveTo(x1, -y1); p.lineTo(x2, -y2); };
  const R = (p, x, y, w, h) => p.rect(x, -(y + h), w, h);            // y = bottom edge
  const poly = (p, ...q) => { p.moveTo(q[0], -q[1]); for (let i = 2; i < q.length; i += 2) p.lineTo(q[i], -q[i + 1]); p.closePath(); };
  const disc = (p, x, y, r) => { p.moveTo(x + r, -y); p.arc(x, -y, r, 0, TAU); p.closePath(); };

  // rectangular lattice between chords x0..x1 (cross = X bracing, else zig-zag)
  function lattice(pDiag, pRung, x0, x1, y0, y1, bay, cross) {
    const n = Math.max(1, Math.round((y1 - y0) / bay)), dy = (y1 - y0) / n;
    for (let i = 0; i < n; i++) {
      const a = y0 + i * dy, b = a + dy;
      if (cross || i % 2 === 0) L(pDiag, x0, a, x1, b);
      if (cross || i % 2 === 1) L(pDiag, x1, a, x0, b);
    }
    for (let i = 0; i <= n; i++) L(pRung, x0, y0 + i * dy, x1, y0 + i * dy);
  }
  // tapered mast (triangular-lattice look in side view)
  function mast(arr, xc, y0, y1, wB, wT, bay, matChord, matLat, wc, wl) {
    const n = Math.max(2, Math.round((y1 - y0) / bay)), pc = P(), pl = P();
    L(pc, xc - wB / 2, y0, xc - wT / 2, y1); L(pc, xc + wB / 2, y0, xc + wT / 2, y1);
    for (let i = 0; i < n; i++) {
      const ya = y0 + (y1 - y0) * i / n, yb = y0 + (y1 - y0) * (i + 1) / n;
      const ha = (wB + (wT - wB) * i / n) / 2, hb = (wB + (wT - wB) * (i + 1) / n) / 2;
      if (i % 2 === 0) L(pl, xc - ha, ya, xc + hb, yb); else L(pl, xc + ha, ya, xc - hb, yb);
      L(pl, xc - ha, ya, xc + ha, ya);
    }
    add(arr, pl, matLat, 's', wl, 3); add(arr, pc, matChord, 's', wc, 0);
  }

  // ---------------------------------------------------------------- BACK (far)
  // West: vertical LOX + RP-1 storage, water-suppression tower. East: sphere + tank.
  {
    const fill = P(), ln = P(), legs = P();
    // vertical LOX tank (x=-58)
    let xc = -58; R(fill, xc - 3.8, 4, 7.6, 22); fill.moveTo(xc - 3.8, -26); fill.arc(xc, -26, 3.8, Math.PI, TAU); fill.closePath();
    for (const dx of [-3, -1, 1, 3]) L(legs, xc + dx, 4, xc + dx * 1.15, 0);
    for (const y of [9, 15, 21]) L(ln, xc - 3.8, y, xc + 3.8, y);
    // RP-1 tank (x=-67)
    xc = -67; R(fill, xc - 3, 3, 6, 12); fill.moveTo(xc - 3, -15); fill.arc(xc, -15, 3, Math.PI, TAU); fill.closePath();
    for (const dx of [-2.2, 2.2]) L(legs, xc + dx, 3, xc + dx * 1.2, 0);
    L(ln, xc - 3, 9, xc + 3, 9);
    // East: LOX sphere on legs (x=+62) and vertical tank (x=+73)
    disc(fill, 62, 9.2, 5.6); for (const dx of [-4.2, -1.4, 1.4, 4.2]) L(legs, 62 + dx, 5, 62 + dx * 1.1, 0);
    L(ln, 56.4, 9.2, 67.6, 9.2);
    xc = 73; R(fill, xc - 2.8, 3, 5.6, 17); fill.moveTo(xc - 2.8, -20); fill.arc(xc, -20, 2.8, Math.PI, TAU); fill.closePath();
    for (const dx of [-2, 2]) L(legs, xc + dx, 3, xc + dx * 1.2, 0);
    add(back, fill, 'white', 'f'); add(back, ln, 'whiteDk', 's', 0.18, 3); add(back, legs, 'steelDk', 's', 0.3, 0);
    // water suppression tower (x=-84): tank on a braced lattice, big feed pipe to the pad
    const wt = -84, tank = P(), lat = P(), rung = P(), pipe = P(), stripe = P();
    R(tank, wt - 5.2, 40, 10.4, 11); tank.moveTo(wt - 5.2, -51); tank.arc(wt, -51, 5.2, Math.PI, TAU); tank.closePath();
    R(stripe, wt - 5.2, 44, 10.4, 1.6);
    L(lat, wt - 4.4, 0, wt - 3.4, 40); L(lat, wt + 4.4, 0, wt + 3.4, 40); L(lat, wt - 5.2, 0, wt - 4.0, 40); L(lat, wt + 5.2, 0, wt + 4.0, 40);
    for (let i = 0; i < 6; i++) { const a = i * 6.67, b = a + 6.67; L(rung, wt - 4.4 + 0.15 * i, a, wt + 4.4 - 0.15 * i, a); L(rung, wt - 4.4 + 0.15 * i, a, wt + 4.4 - 0.15 * (i + 1), b); L(rung, wt + 4.4 - 0.15 * i, a, wt - 4.4 + 0.15 * (i + 1), b); }
    L(pipe, wt, 40, wt, 1.1); L(pipe, wt, 1.1, -10, 1.1);
    add(back, lat, 'steel', 's', 0.45, 0); add(back, rung, 'steel', 's', 0.18, 3);
    add(back, pipe, 'whiteDk', 's', 0.9, 0); add(back, tank, 'white', 'f'); add(back, stripe, 'red', 'f');
  }
  // East bunker / equipment building (x 27..43)
  {
    const bd = P(), roof = P(), win = P(), ant = P();
    R(bd, 27, 0, 16, 5); R(roof, 26.5, 5, 17, 0.55);
    for (let i = 0; i < 5; i++) R(win, 29 + i * 2.7, 2.6, 1.6, 1.1);
    R(win, 40.2, 0, 1.5, 2.5);
    L(ant, 31, 5.5, 31, 12); L(ant, 28.8, 9.5, 33.2, 9.5); ant.moveTo(38, -5.5); ant.lineTo(38, -7.2);
    add(mid, bd, 'whiteDk', 'f'); add(mid, roof, 'steelDk', 'f'); add(mid, win, 'glass', 'f', 0, 3); add(mid, ant, 'steelDk', 's', 0.14, 3);
  }

  // ------------------------------------------------------- MID: hardstand + trench
  {
    const slab = P(), pave = P(), joints = P(), lifts = P();
    R(slab, -slabHalf, -14, slabHalf * 2, 14);
    R(pave, -slabHalf, -1.2, slabHalf * 2, 1.2);
    for (const x of [-37.5, -25, -12.5, 12.5, 25, 37.5]) L(joints, x, 0, x, -14);
    for (const y of [-4.5, -8.5, -11.5]) L(lifts, -slabHalf, y, slabHalf, y);
    add(mid, slab, 'concDk', 'f'); add(mid, pave, 'conc', 'f');
    add(mid, joints, 'concLn', 's', 0.1, 3); add(mid, lifts, 'concLn', 's', 0.08, 3);
    // trench void (flame hole + chamber)
    const v = P(); poly(v, -3.2, 0, 3.2, 0, 3.2, -2.4, 9, -2.4, 9, -13, -9, -13, -9, -2.4, -3.2, -2.4);
    add(mid, v, 'void', 'f');
    const wall = P(), brick = P(); R(wall, -9, -13, 1.4, 10.6); R(wall, 7.6, -13, 1.4, 10.6);
    for (let y = -3.3; y > -13; y -= 0.9) { L(brick, -9, y, -7.6, y); L(brick, 7.6, y, 9, y); }
    add(mid, wall, 'refr', 'f'); add(mid, brick, 'scorch', 's', 0.06, 1.5);
    // V deflector (steel, scorched apex, water-cooled ribs)
    const dfl = P(), tip = P(), rib = P(), edge = P(), fl = P();
    poly(dfl, 0, -3, 8.6, -12.2, -8.6, -12.2); poly(tip, 0, -3, 2.7, -5.7, -2.7, -5.7);
    for (const x of [-6, -3, 3, 6]) L(rib, x, -3 + (-12.2 + 3) * Math.abs(x) / 8.6, x, -13);
    L(edge, 0, -3, -8.6, -12.2); R(fl, -9, -13.8, 18, 0.8);
    add(mid, dfl, 'steelDk', 'f'); add(mid, tip, 'scorch', 'f'); add(mid, rib, 'steel', 's', 0.2, 3);
    add(mid, edge, 'steelLt', 's', 0.16, 3); add(mid, fl, 'concDk', 'f');
    // launch table (two blocks around the flame hole) with X bracing + clamps
    const tb = P(), top = P(), br = P(), lin = P(), clamp = P(), bolt = P();
    R(tb, -8, -2.4, 4.8, 2.4); R(tb, 3.2, -2.4, 4.8, 2.4);
    R(top, -8, -0.45, 4.8, 0.45); R(top, 3.2, -0.45, 4.8, 0.45);
    for (const x0 of [-8, 3.2]) { L(br, x0, -2.4, x0 + 2.4, -0.45); L(br, x0 + 2.4, -2.4, x0, -0.45); L(br, x0 + 2.4, -2.4, x0 + 4.8, -0.45); L(br, x0 + 4.8, -2.4, x0 + 2.4, -0.45); }
    L(lin, -3.2, 0, -3.2, -2.4); L(lin, 3.2, 0, 3.2, -2.4);
    R(clamp, -(w2 + 0.95), 0, 0.95, 1.05); R(clamp, w2, 0, 0.95, 1.05);
    L(bolt, -(w2 + 0.5), 0.2, -(w2 + 0.5), 0.85); L(bolt, w2 + 0.5, 0.2, w2 + 0.5, 0.85);
    add(mid, tb, 'steel', 'f'); add(mid, top, 'steelLt', 'f'); add(mid, br, 'steelDk', 's', 0.14, 3);
    add(mid, lin, 'refr', 's', 0.35, 0); add(mid, clamp, 'steelDk', 'f'); add(mid, bolt, 'steelLt', 's', 0.12, 3);
    // TEL carriage (west) + pipe rack & cable tray (east) + floodlight poles
    const car = P(), wh = P(), rail = P();
    R(car, -27, 0, 19, 1.1); R(car, -27, 1.1, 3.2, 0.8);
    for (const x of [-25.5, -22, -18.5, -15, -11.5]) disc(wh, x, 0.45, 0.5);
    L(rail, -27, 0.02, -8, 0.02);
    add(mid, car, 'steel', 'f'); add(mid, wh, 'steelDk', 'f', 0, 3);
    const post = P(), beam = P(), pipes = P();
    for (let x = 11; x <= 49; x += 6) R(post, x - 0.14, 0, 0.28, 1.7);
    R(beam, 8.5, 1.65, 41, 0.28);
    L(pipes, 8.5, 2.35, 49.5, 2.35); L(pipes, 8.5, 2.9, 49.5, 2.9);
    add(mid, post, 'steelDk', 'f', 0, 3); add(mid, beam, 'steelDk', 'f'); add(mid, pipes, 'white', 's', 0.4, 3);
    for (const [x, h] of [[-19, 24], [19, 24], [40, 17]]) {
      const pole = P(), head = P(); L(pole, x, 0, x, h); R(head, x - 1.1, h, 2.2, 0.7);
      add(mid, pole, 'steelDk', 's', 0.38, 0); add(mid, head, 'steelLt', 'f');
      lights.push({ x, y: h + 0.35, r: 11, k: 'f', beam: Math.min(24, h * 1.3) });
    }
  }

  // ---------------------------------------------------- STRONGBACK (tilts about its base)
  const sx = -(w2 + 3.0), hS = H * 0.74, swd = 1.3;
  {
    const chord = P(), diag = P(), rung = P(), arm = P(), clamp = P(), plat = P(), tray = P();
    L(chord, sx - swd, 0, sx - swd, hS); L(chord, sx + swd, 0, sx + swd, hS);
    lattice(diag, rung, sx - swd, sx + swd, 0, hS, 3.2, false);
    for (const f of [0.2, 0.46, 0.7]) { const y = hS * f; L(arm, sx + swd, y, -w2 + 0.05, y); R(clamp, -w2 - 0.45, y - 0.45, 0.6, 0.9); }
    R(plat, sx - swd - 0.9, hS, swd * 2 + 1.8, 0.45); L(plat, sx - swd - 0.9, hS + 0.45, sx - swd - 0.9, hS + 1.6);
    L(tray, sx - swd - 0.3, 0, sx - swd - 0.3, hS);
    add(sb, rung, 'steel', 's', 0.14, 3); add(sb, diag, 'steel', 's', 0.18, 2);
    add(sb, chord, 'whiteDk', 's', 0.5, 0); add(sb, tray, 'steelDk', 's', 0.22, 2);
    add(sb, arm, 'steelDk', 's', 0.36, 0); add(sb, clamp, 'steelDk', 'f'); add(sb, plat, 'steelDk', 'f');
  }

  // --------------------------------------------------------------- FRONT: FSS tower + masts
  const fx = -34, fh = H * 1.12, fw = 4.2, mastTop = fh + 22;
  {
    const ch = P(), dg = P(), rg = P(), plat = P(), elev = P(), crane = P(), ladder = P();
    L(ch, fx - fw, 0, fx - fw, fh); L(ch, fx + fw, 0, fx + fw, fh);
    lattice(dg, rg, fx - fw, fx + fw, 0, fh, 6, true);
    for (let y = 12; y < fh; y += 12) { R(plat, fx - fw - 1.2, y, fw * 2 + 2.4, 0.4); }
    R(elev, fx + fw - 1.6, 0, 1.2, fh - 3);
    for (let y = 1; y < fh - 3; y += 1.3) L(ladder, fx - fw + 0.6, y, fx - fw + 1.6, y);
    R(crane, fx - 12, fh + 1.2, 18, 0.7); L(crane, fx - 12, fh + 1.2, fx - 6, fh - 1.0); L(crane, fx - 6, fh - 1.0, fx + 3, fh + 1.2);
    add(front, dg, 'steel', 's', 0.2, 2); add(front, rg, 'steel', 's', 0.16, 3);
    add(front, ch, 'steelLt', 's', 0.6, 0); add(front, ladder, 'steelDk', 's', 0.1, 3);
    add(front, elev, 'steel', 'f', 0, 3); add(front, plat, 'steelDk', 'f', 0, 1.5); add(front, crane, 'steelDk', 'f');
    // red/white obstruction banding on the top 24 m + roof + whip mast
    const bandR = P(), bandW = P(), mastP = P();
    const y0 = fh - 24;
    for (let i = 0; i < 4; i++) { const arr = (i % 2 === 0) ? bandR : bandW; R(arr, fx - fw - 0.3, y0 + i * 6, 0.6, 6); R(arr, fx + fw - 0.3, y0 + i * 6, 0.6, 6); }
    L(mastP, fx, fh, fx, mastTop);
    add(front, bandR, 'red', 'f'); add(front, bandW, 'white', 'f'); add(front, mastP, 'steelLt', 's', 0.3, 0);
    lights.push({ x: fx, y: mastTop, r: 7, k: 'r' }, { x: fx - fw, y: fh * 0.5, r: 4.5, k: 'r' }, { x: fx - fw, y: fh, r: 5, k: 'r' });
  }
  const mastsX = [-47, 47], mh = Math.max(H * 1.45, 55);
  {
    for (const mx of mastsX) {
      mast(front, mx, 0, mh, 2.4, 0.5, 4.5, 'steelLt', 'steel', 0.34, 0.14);
      const sp = P(); L(sp, mx, mh, mx, mh + 7); add(front, sp, 'steelLt', 's', 0.2, 0);
      lights.push({ x: mx, y: mh + 7, r: 5, k: 'r' });
    }
    // catenary wires: each outer mast tip -> FSS whip tip (sagging), plus mast-to-mast
    const wire = P(), tipE = mh + 7;
    const cat = (x1, y1, x2, y2) => { const sag = Math.abs(x2 - x1) * 0.035; wire.moveTo(x1, -y1); wire.quadraticCurveTo((x1 + x2) / 2, -((y1 + y2) / 2 - 2 * sag), x2, -y2); };
    cat(mastsX[0], tipE, fx, mastTop); cat(fx, mastTop, mastsX[1], tipE);
    add(front, wire, 'steelDk', 's', 0.1, 2);
  }
  return { back, mid, front, sb, lights, sx, hS, swd, fx, fh, mastTop, mastsX, mh, w2, slabHalf };
}

function _padDraw(c, layers, pal, mpp) {
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.lod && mpp > l.lod) continue;
    if (l.k === 'f') { c.fillStyle = pal[l.mat]; _padFill(c, l.p); }
    else { c.strokeStyle = pal[l.mat]; c.lineWidth = Math.max(l.w, mpp * 0.9); _padStroke(c, l.p); }
  }
}

function _padSprite(rgb) {
  const S = 64;
  const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(S, S)
    : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: S, height: S }) : null);
  if (!cv) return null;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(' + rgb + ',1)'); gr.addColorStop(0.25, 'rgba(' + rgb + ',0.55)');
  gr.addColorStop(1, 'rgba(' + rgb + ',0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return cv;
}

function drawLaunchPad() {
  if (camera.mode === 'planet') return;

  // Pad is pinned to the rotating Earth: current inertial position -> screen,
  // then everything is drawn in the pad's own frame (x = EAST, y = up).
  const site = launchSiteWorldPosition(state.simTime);
  const [sitePx, sitePy] = worldToScreen(site.x, site.y);
  const mpp = metersPerPixel();
  const reach = 200 / mpp;                                  // bounding circle (rotation-safe)
  if (sitePx + reach < 0 || sitePx - reach > canvas.width ||
    sitePy + reach < 0 || sitePy - reach > canvas.height) return;

  const H = Math.max(30, CONFIG.ROCKET_HEIGHT || 45), W = Math.max(2, CONFIG.ROCKET_WIDTH || 3.7);
  const slabHalf = (typeof GROUND_FX !== 'undefined' && GROUND_FX.PAD_HALF_W_M) || 50;
  const key = H.toFixed(1) + '|' + W.toFixed(2) + '|' + slabHalf;
  if (_PAD.key !== key) { _PAD.geo = _padBuild(H, W, slabHalf); _PAD.key = key; }
  const g = _PAD.geo;

  // Strongback retracts WEST (away from the downrange / pitch-over side) at liftoff.
  const nowT = performance.now();
  const dtReal = towerTiltLastT === null ? 0 : Math.min(0.25, (nowT - towerTiltLastT) / 1000);
  towerTiltLastT = nowT;
  const r_ = Math.hypot(state.rx, state.ry);
  const tiltTarget = altitudeFromR(r_) > 2 ? 1 : 0;
  const tiltRate = 0.45;
  if (tiltTarget > towerTilt) towerTilt = Math.min(tiltTarget, towerTilt + tiltRate * dtReal);
  else towerTilt = Math.max(tiltTarget, towerTilt - tiltRate * dtReal);
  const e = towerTilt * towerTilt * (3 - 2 * towerTilt);        // eased
  // trench glow follows the jet landing on the deflector (smoothed; holds while paused)
  const fTgt = Math.abs(state.simTime - _PAD.fireStamp) < 0.35 ? _PAD.fireT : 0;
  _PAD.fireK += (fTgt - _PAD.fireK) * Math.min(1, dtReal * (fTgt > _PAD.fireK ? 8 : 2.5));
  const tiltA = e * 14 * Math.PI / 180;

  // Lighting at the pad (pseudo-body: body frame x = east, y = up).
  let Lt = null;
  if (typeof SimLighting !== 'undefined' && SimLighting.rocketLight) {
    const pb = _PAD.body || (_PAD.body = { rx: 0, ry: 0, theta: 0 });
    pb.rx = site.x; pb.ry = site.y; pb.theta = -site.phi;
    Lt = SimLighting.rocketLight(pb);
  }
  const pal = _padPalette(Lt, false), palFar = _padPalette(Lt, true);

  ctx.save();
  ctx.translate(sitePx, sitePy);
  ctx.rotate(-(site.phi - cameraAngle()));
  ctx.scale(1 / mpp, 1 / mpp);                                  // 1 unit = 1 metre from here on
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';

  _padDraw(ctx, g.back, palFar, mpp);
  _padDraw(ctx, g.mid, pal, mpp);

  // Trench heat: the deflector and chamber glow while the jet is on them (emitter sets fireT).
  if (_PAD.fireK > 0.01) {
    const k = Math.min(1, _PAD.fireK) * (0.93 + 0.07 * Math.sin(nowT * 0.031));
    ctx.save();
    ctx.beginPath();                                                      // clip to the flame hole + chamber
    ctx.moveTo(-3.2, 0); ctx.lineTo(3.2, 0); ctx.lineTo(3.2, 2.4); ctx.lineTo(9, 2.4); ctx.lineTo(9, 13);
    ctx.lineTo(-9, 13); ctx.lineTo(-9, 2.4); ctx.lineTo(-3.2, 2.4); ctx.closePath(); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const rg = ctx.createRadialGradient(0, 3.2, 0, 0, 3.2, 17);
    rg.addColorStop(0, 'rgba(255,200,110,' + (0.80 * k).toFixed(3) + ')');
    rg.addColorStop(0.45, 'rgba(255,120,40,' + (0.38 * k).toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(255,70,10,0)');
    ctx.fillStyle = rg; ctx.fillRect(-10, -1, 20, 15);
    ctx.strokeStyle = 'rgba(255,215,140,' + (0.85 * k).toFixed(3) + ')';   // white-hot wedge faces
    ctx.lineWidth = Math.max(0.35, mpp * 1.2); ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-8.6, 12.2); ctx.lineTo(0, 3); ctx.lineTo(8.6, 12.2); ctx.stroke();
    ctx.restore();
    ctx.save();                                                           // light pooled on the table / hardstand
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(0, -0.4); ctx.scale(1, 0.12);
    const pg = ctx.createRadialGradient(0, 0, 0, 0, 0, 24);
    pg.addColorStop(0, 'rgba(255,170,80,' + (0.55 * k).toFixed(3) + ')'); pg.addColorStop(1, 'rgba(255,110,30,0)');
    ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // soot / scorch on the hardstand around the mount (centre-weighted)
  {
    const sg = ctx.createLinearGradient(-26, 0, 26, 0);
    sg.addColorStop(0, 'rgba(20,18,16,0)'); sg.addColorStop(0.36, 'rgba(20,18,16,0.30)');
    sg.addColorStop(0.5, 'rgba(14,12,12,0.55)'); sg.addColorStop(0.64, 'rgba(20,18,16,0.30)');
    sg.addColorStop(1, 'rgba(20,18,16,0)');
    ctx.fillStyle = sg; ctx.fillRect(-26, -1.2, 52, 1.2);
  }

  // TEL hydraulic erector cylinder: fixed foot on the carriage, head follows the strongback
  {
    const a = tiltA, y = g.hS * 0.3, dx = -0.9;
    const hx = g.sx + (dx * Math.cos(a) - y * Math.sin(a)), hy = dx * Math.sin(a) + y * Math.cos(a);
    const fx0 = -15, fy0 = 1.9, mxp = fx0 + (hx - fx0) * 0.58, myp = fy0 + (hy - fy0) * 0.58;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = pal.steelLt; ctx.lineWidth = Math.max(0.55, mpp * 1.2);
    ctx.beginPath(); ctx.moveTo(fx0, -fy0); ctx.lineTo(mxp, -myp); ctx.stroke();
    ctx.strokeStyle = pal.white; ctx.lineWidth = Math.max(0.28, mpp * 0.9);
    ctx.beginPath(); ctx.moveTo(mxp, -myp); ctx.lineTo(hx, -hy); ctx.stroke();
  }

  // strongback / TEL arm: hinge at its base, leans WEST (counter-clockwise on screen)
  ctx.save();
  ctx.translate(g.sx, 0); ctx.rotate(-tiltA); ctx.translate(-g.sx, 0);
  _padDraw(ctx, g.sb, pal, mpp);
  ctx.restore();

  _padDraw(ctx, g.front, pal, mpp);

  // ---- night lights: floodlight beams + glows + blinking beacons ----
  if (pal.night > 0.02) {
    const n = pal.night;
    if (!_PAD.glow) { _PAD.glow = _padSprite('255,226,170'); _PAD.glowRed = _padSprite('255,60,45'); }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const Lg of g.lights) {
      if (Lg.k !== 'f' || !Lg.beam) continue;
      const bg = ctx.createLinearGradient(0, -Lg.y, 0, 0);
      bg.addColorStop(0, 'rgba(255,230,170,' + (0.16 * n).toFixed(3) + ')'); bg.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = bg; ctx.beginPath();
      ctx.moveTo(Lg.x - 0.5, -Lg.y); ctx.lineTo(Lg.x + 0.5, -Lg.y); ctx.lineTo(Lg.x + Lg.beam, 0); ctx.lineTo(Lg.x - Lg.beam, 0); ctx.closePath(); ctx.fill();
    }
    const blink = 0.55 + 0.45 * Math.sin(nowT * 0.004);
    for (const Lg of g.lights) {
      const sp = Lg.k === 'f' ? _PAD.glow : _PAD.glowRed; if (!sp) continue;
      const rr = Math.max(Lg.r, mpp * 5);
      ctx.globalAlpha = Math.min(1, n * (Lg.k === 'f' ? 0.9 : 0.5 + 0.5 * blink));
      ctx.drawImage(sp, Lg.x - rr, -Lg.y - rr, rr * 2, rr * 2);
    }
    // strongback top lamp rides the tilt
    const ty = g.hS + 1.2, tx = g.sx + (-Math.sin(tiltA) * ty), tyy = Math.cos(tiltA) * ty;
    if (_PAD.glow) { ctx.globalAlpha = Math.min(1, n * 0.9); const rr = Math.max(7, mpp * 5); ctx.drawImage(_PAD.glow, tx - rr, -tyy - rr, rr * 2, rr * 2); }
    ctx.restore();
  } else {
    // daytime: beacons still pulse as small red dots
    const blink = 0.5 + 0.5 * Math.sin(nowT * 0.004);
    ctx.fillStyle = 'rgba(255,60,50,' + (0.45 + 0.5 * blink).toFixed(2) + ')';
    for (const Lg of g.lights) {
      if (Lg.k !== 'r') continue;
      ctx.beginPath(); ctx.arc(Lg.x, -Lg.y, Math.max(0.6, mpp * 1.6), 0, Math.PI * 2); ctx.fill();
    }
  }

  ctx.restore();
}
// ===== LAUNCHPAD END ========================================================

// H3b: when following a discarded body, draw a small arrow pointing
// toward the active body if it's off-screen — so the user doesn't lose
// track of it while watching the booster fall.
function drawActiveBodyIndicator() {
  const activeIdx = state.activeBodyIndex;
  const followingIdx = (typeof camera !== 'undefined' && Number.isFinite(camera.followBodyIndex)) ?
    camera.followBodyIndex : activeIdx;
  if (activeIdx === followingIdx) return; // no arrow needed if following active
  
  const active = state.bodies[activeIdx];
  if (!active) return;
  
  const mpp = metersPerPixel();
  const [px, py] = worldToScreen(active.rx, active.ry);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  
  const margin = 60;
  const onScreen = px > margin && px < canvas.width - margin &&
    py > margin && py < canvas.height - margin;
  if (onScreen) return;
  
  // Clamp to canvas edge.
  const dx = px - cx,
    dy = py - cy;
  const ang = Math.atan2(dy, dx);
  const rx = canvas.width / 2 - margin;
  const ry = canvas.height / 2 - margin;
  const scale = Math.min(rx / Math.abs(Math.cos(ang) || 1e-6), ry / Math.abs(Math.sin(ang) || 1e-6));
  const ax = cx + Math.cos(ang) * scale;
  const ay = cy + Math.sin(ang) * scale;
  
  // Arrow.
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(ang);
  ctx.fillStyle = 'rgba(255,210,63,0.9)';
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-8, -10);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-8, 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#0a0c10';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Label under arrow.
  ctx.rotate(-ang);
  ctx.fillStyle = 'rgba(255,210,63,0.9)';
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ACTIVE', 0, 28);
  ctx.restore();
}


function drawPayloadReleaseCue() {
  // Data comes from the worker via state.lastPayloadRelease — NOT a local
  // variable. Physics worker sends { id, rx, ry, ux, uy }; the id changes
  // every release event so we can detect "new cue, reset timer".
  const p = state.lastPayloadRelease;
  if (!p) return;
  
  // Local wall-clock timer, keyed on the id. Worker and render worker have
  // separate performance.now() clocks, so we cannot use a timestamp
  // computed worker-side. Instead: first frame we see a new id → record
  // local time, then count 1.2 real seconds from there.
  if (p.id !== _lastPayloadCueId) {
    _lastPayloadCueId = p.id;
    _payloadCueLocalStart = performance.now();
  }
  
  const age = (performance.now() - _payloadCueLocalStart) / 1000;
  if (age > 1.2) return;
  
  const mpp = metersPerPixel();
  const [px, py] = worldToScreen(p.rx, p.ry);
  
  const f = age / 1.2;
  const alpha = 1 - f;
  
  ctx.save();
  
  // Expanding ring.
  const ringR = 4 + f * 18;
  ctx.beginPath();
  ctx.arc(px, py, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(140,230,255,${alpha * 0.85})`;
  ctx.lineWidth = 2 * alpha + 0.5;
  ctx.stroke();
  
  // Prograde arrow from release point, in the world-frame kick direction.
  // Screen y is flipped, so the arrow's endpoint uses -uy.
  const arrowLen = 20 + f * 10;
  const ax = px + p.ux * arrowLen;
  const ay = py - p.uy * arrowLen;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(ax, ay);
  ctx.strokeStyle = `rgba(140,230,255,${alpha * 0.7})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  
  const ang = Math.atan2(ay - py, ax - px);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - 6 * Math.cos(ang - 0.4), ay - 6 * Math.sin(ang - 0.4));
  ctx.lineTo(ax - 6 * Math.cos(ang + 0.4), ay - 6 * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fillStyle = `rgba(140,230,255,${alpha * 0.8})`;
  ctx.fill();
  
  ctx.restore();
}

// H4: draw the separation flash — an expanding ring at the split point.
function drawSeparationFlash() {
  const f = state.separationFlash;
  if (!f) return;
  
  // New flash id → reset the local wall-clock timer.
  if (f.id !== _lastFlashId) {
    _lastFlashId = f.id;
    _flashLocalStart = performance.now();
  }
  
  const age = (performance.now() - _flashLocalStart) / 1000;
  if (age > 0.35) return;
  
  const mpp = metersPerPixel();
  const [px, py] = worldToScreen(f.rx, f.ry);
  
  const frac = age / 0.35; // 0 → 1 over the flash lifetime
  const radius = 2 + frac * 30; // screen pixels
  const alpha = (1 - frac) * 0.85;
  
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,220,120,${alpha})`;
  ctx.lineWidth = 3 * (1 - frac) + 1;
  ctx.stroke();
  
  // Inner bright dot fading out.
  ctx.beginPath();
  ctx.arc(px, py, Math.max(1, 6 * (1 - frac)), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.fill();
  ctx.restore();
}

function drawRocket() {
  // Step RCS puff particles once per frame (independent of whether pods
  // are still firing — particles that already exist should keep drifting).
  _stepAllGasPools();
  // Clear pools when the STRUCTURE changes — either the active body index
  // or the body count. Pre-separation particles live in the old body's
  // local frame; after a split they'd be drawn at the wrong place.
  const gen = state.activeBodyIndex + ':' + (state.bodies ? state.bodies.length : 0);
  _resetGasPoolsIfBodyChanged(gen);
  state.bodies.forEach((body, idx) => {
    drawBodyRocket(body, idx === state.activeBodyIndex, idx);
  });
}


// Planet-view rocket marker. A small triangle whose vertex points along
// the body's VELOCITY direction (in the inertial frame). Because screen-y
// is flipped (world +y → screen −y), the on-screen rotation angle is
// atan2(−vy, vx). Active body is cyan, discarded bodies are orange.
function drawBodyAsTriangle(body, isActive) {
  const [px, py] = worldToScreen(body.rx, body.ry);
  const speed = Math.hypot(body.vx, body.vy);
  if (typeof SimLighting !== 'undefined') SimLighting.drawLocator(ctx, px, py, isActive, body);
  
  // Vertex points along the body's own nose axis (attitude θ), NOT its
  // velocity. In the inertial world frame the nose direction is
  // (-sin θ, cos θ); screen y is flipped, so the on-screen angle is
  // atan2(-cos θ, -sin θ).
  const screenAngle = Math.atan2(-Math.cos(body.theta), -Math.sin(body.theta));
  
  const size = isActive ? 10 : 7;
  
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(screenAngle);
  
  ctx.beginPath();
  ctx.moveTo(size, 0); // vertex along velocity
  ctx.lineTo(-size * 0.55, -size * 0.55);
  ctx.lineTo(-size * 0.25, 0);
  ctx.lineTo(-size * 0.55, size * 0.55);
  ctx.closePath();
  
  ctx.fillStyle = isActive ? '#35d6ff' : '#ff9248';
  ctx.strokeStyle = '#0a0c10';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  
  ctx.restore();
}

// Pusher puff local-timer — same pattern as separationFlash and
// payloadReleaseCue: the worker ships an id + capture-time; we key off
// the id and use a local performance.now() origin so clocks don't need
// to be shared across workers.
let _puffLastId = -1;
let _puffLocalStart = 0;

// ============================================================================
// GROUND INTERACTION — plume impingement + launch blast cloud
//
//  1. The exhaust plume is clipped against the surface plane (pad apron when
//     over the pad, Earth surface elsewhere) so it never renders "inside" the
//     ground. See the clip + sheet blocks in drawBodyRocket.
//  2. When the plume touches the surface it fans out sideways as a flame
//     sheet (flame-deflector / ground-impingement look).
//  3. Steam / smoke / soot / dust is simulated as Earth-fixed particles
//     (arc-length s along the surface from the pad, height y, both in metres)
//     so the cloud stays behind on the pad as the rocket climbs away.
// ============================================================================
const GROUND_FX = {
  PAD_HALF_W_M: 50,       // matches apronHalfW in drawLaunchPad
  PAD_DEPTH_M: 2.4,       // apron top below the rocket-base datum (= mountH)
  MAX_PARTICLES: 1600,
  TRAIL_MAX_ALT_M: 2500,  // exhaust vapour trail fades out above this
};

// Flame trench under the launch table (keep in sync with _padBuild): flame hole
// in the table, chamber below it, V deflector with its apex under the nozzles.
// The plume is clipped to  open air  U  trench void  -  deflector wedge, so it
// really goes down the hole, splits on the wedge and flows down both slopes.
const PAD_TRENCH = {
  HOLE_HALF_W: 3.2, TABLE_H: 2.4, CH_HALF_W: 9, CH_DEPTH: 13,
  APEX_Y: -3.0, WEDGE_HALF_W: 8.6, WEDGE_FOOT_Y: -12.2,
  ACTIVE_HALF_W: 4.5,                      // |sE| below which the jet lands on the deflector
  SLOPE_RAD: Math.atan2(9.2, 8.6), SLOPE_LEN: Math.hypot(8.6, 9.2),
};

// Builds the clip path in the BODY frame (origin = hull base; ground tangent gt,
// ground normal gu, both in canvas px). sE = body offset east of the pad centre,
// altBase = hull-base height over the pad surface (both metres).
function _padTrenchClipPath(c, gtx, gty, gux, guy, sE, altBase, mpp) {
  const T = (X, Y) => { const a = (X - sE) / mpp, b = (Y - altBase) / mpp; return [a * gtx + b * gux, a * gty + b * guy]; };
  const poly = (pts, sign) => {
    const P = pts.map(q => T(q[0], q[1]));
    let A = 0;
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; A += a[0] * b[1] - b[0] * a[1]; }
    if (A * sign < 0) P.reverse();
    c.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length; i++) c.lineTo(P[i][0], P[i][1]);
    c.closePath();
  };
  const t = PAD_TRENCH, G = 4e4 * mpp, h = t.HOLE_HALF_W, w = t.CH_HALF_W;
  c.beginPath();
  poly([[-G, 0], [G, 0], [G, G], [-G, G]], 1);                                       // open air above the pad top
  poly([[-h, 0], [h, 0], [h, -t.TABLE_H], [w, -t.TABLE_H], [w, -t.CH_DEPTH],        // flame hole + chamber
        [-w, -t.CH_DEPTH], [-w, -t.TABLE_H], [-h, -t.TABLE_H]], 1);
  poly([[0, t.APEX_Y], [t.WEDGE_HALF_W, t.WEDGE_FOOT_Y], [-t.WEDGE_HALF_W, t.WEDGE_FOOT_Y]], -1);   // deflector (solid)
}

function _gfxWrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Where is the surface beneath this body, and is it the launch pad?
function _groundSurfaceInfo(body) {
  const R = CONFIG.EARTH_RADIUS;
  const altBase = Math.hypot(body.rx, body.ry) - R;
  const phiB = Math.atan2(body.rx, body.ry);
  let sE = 0, onPad = false;
  if (typeof launchSiteWorldPosition === 'function') {
    const site = launchSiteWorldPosition(state.simTime);
    sE = R * _gfxWrap(phiB - site.phi);
    onPad = Math.abs(sE) < GROUND_FX.PAD_HALF_W_M;
  }
  return { altBase, sE, onPad };
}

function _isSingleNozzleBody(body) {
  if (!(body.members && body.members[0] && body.members[0].engineTypeId &&
      typeof getComponentType === 'function')) return false;
  const lay = getComponentType(body.members[0].engineTypeId);
  return !!(lay && lay.frame && Array.isArray(lay.frame.slots) && lay.frame.slots.length === 1);
}

// ---- Soft, lumpy puff sprites (pre-rendered, tinted per material) ----------
const _gfx = { parts: [], lastSim: null, last: new WeakMap(), acc: new WeakMap(), sprites: null };

function _gfxMakeCanvas(S) {
  let c = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { c = new OffscreenCanvas(S, S); } catch (e) { c = null; }
  }
  if (!c && typeof document !== 'undefined' && document.createElement) {
    c = document.createElement('canvas');
    c.width = S; c.height = S;
  }
  return c;
}

function _gfxBuildSprite(light, shade, seed, additive) {
  const S = 128;
  const c = _gfxMakeCanvas(S);
  if (!c) return null;
  const g = c.getContext('2d');
  let rs = seed >>> 0;
  const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
  const rgb = (a, al) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;
  g.clearRect(0, 0, S, S);
  const lumps = additive ? 3 : 11;
  for (let i = 0; i < lumps; i++) {
    const ang = rnd() * Math.PI * 2;
    const d = (additive ? 0.08 : 0.25) * S * Math.sqrt(rnd());
    const x = S / 2 + Math.cos(ang) * d;
    const y = S / 2 + Math.sin(ang) * d * 0.8;
    const r = S * (additive ? 0.36 : (0.17 + rnd() * 0.15));
    const gr = g.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.05, x, y, r);
    gr.addColorStop(0, rgb(light, additive ? 0.9 : 0.72));
    gr.addColorStop(0.6, rgb(additive ? light : shade, additive ? 0.35 : 0.40));
    gr.addColorStop(1, rgb(shade, 0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // soft round mask so no lump ever touches the sprite edge
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  m.addColorStop(0, 'rgba(0,0,0,1)');
  m.addColorStop(0.55, 'rgba(0,0,0,0.9)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  return c;
}

function _gfxSprites() {
  if (_gfx.sprites) return _gfx.sprites;
  _gfx.sprites = {
    steam: _gfxBuildSprite([250, 250, 252], [176, 184, 198], 11, false),
    smoke: _gfxBuildSprite([172, 172, 174], [88, 88, 94], 23, false),
    soot:  _gfxBuildSprite([96, 90, 88], [30, 28, 28], 37, false),
    dust:  _gfxBuildSprite([216, 192, 150], [128, 104, 76], 51, false),
    glow:  _gfxBuildSprite([255, 190, 100], [255, 100, 30], 77, true),
  };
  return _gfx.sprites;
}

// ---- Particle system -------------------------------------------------------
function _gfxSpawn(p) {
  const arr = _gfx.parts;
  if (arr.length >= GROUND_FX.MAX_PARTICLES) arr.splice(0, arr.length - GROUND_FX.MAX_PARTICLES + 1);
  arr.push(p);
}

function _gfxTake(body, key, amount) {
  let o = _gfx.acc.get(body);
  if (!o) { o = {}; _gfx.acc.set(body, o); }
  o[key] = (o[key] || 0) + amount;
  const n = Math.min(40, Math.floor(o[key]));
  o[key] = Math.min(1, o[key] - n);
  return n;
}

function _gfxPickKind(onPad, r) {
  if (onPad) return r < 0.58 ? 'steam' : (r < 0.86 ? 'smoke' : 'soot');
  return r < 0.78 ? 'dust' : (r < 0.93 ? 'smoke' : 'steam');
}

function _gfxStep(dt) {
  const arr = _gfx.parts;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    p.age += dt;
    if (p.age >= p.life) continue;
    p.vs *= Math.exp(-p.drag * dt);
    p.vy = p.vy * Math.exp(-p.vdrag * dt) + p.buoy * dt;
    p.s += p.vs * dt;
    p.y += p.vy * dt;
    p.r += p.gr * dt;
    p.gr *= Math.exp(-0.22 * dt);
    const floor = p.ground ? p.r * 0.4 : 0;
    if (p.y < floor) { p.y = floor; if (p.vy < 0) p.vy = 0; }
    p.glow *= Math.exp(-dt / 0.9);
    arr[w++] = p;
  }
  arr.length = w;
}

function _gfxEmitBody(body, dt) {
  if (!body || !Number.isFinite(body.rx) || !Number.isFinite(body.ry)) return;
  const eng = body.engines || [];
  let fSum = 0, fMax = 0, active = 0, gs = 0, gc = 0, mxF = 0;
  for (const e of eng) {
    fSum += e.currentF; fMax += e.Fmax; if (e.Fmax > mxF) mxF = e.Fmax;
    if (e.currentF > 1) active++;
    if (e.gimbal && e.currentF > 0.01) { gs += e.gimbalDeg || 0; gc++; }
  }
  const thr = fMax > 0 ? fSum / fMax : 0;
  if (thr < 0.05) { _gfx.last.delete(body); return; }

  const gi = _groundSurfaceInfo(body);
  const single = _isSingleNozzleBody(body);
  const Wm0 = CONFIG.ROCKET_WIDTH, Hm = CONFIG.ROCKET_HEIGHT;
  const F = single ? 0.55 : Math.min(1, 0.30 + 0.70 * Math.max(0, active - 1) / 8);
  const lenMul = single ? 0.30 : 1.0, widMul = single ? 1.3 : 1.0;
  const flameLenM = _plumeLengthM(body, fSum, mxF, single, thr);
  const Wm = Wm0 * F * widMul;
  const bellM = (body.members && body.members.length && typeof getEngineBellExitY_m === 'function')
    ? getEngineBellExitY_m(body.members[0]) : 0;
  const th = body.theta - Math.atan2(-body.rx, body.ry);
  const g = (gc ? gs / gc : 0) * Math.PI / 180;
  const psi = th - g, cosPsi = Math.cos(psi);
  const tr = gi.onPad && Math.abs(gi.sE) < PAD_TRENCH.ACTIVE_HALF_W;          // jet lands on the deflector
  const surfAlt = tr ? -Math.max(-PAD_TRENCH.APEX_Y, bellM + 0.4) : 0;
  const hN = gi.altBase - bellM * cosPsi - surfAlt;           // nozzle-exit height over surface (m)
  const Lhit = cosPsi > 0.05 ? Math.max(0, hN) / cosPsi : Infinity;
  const contact = Math.max(0, Math.min(1, 1 - Lhit / flameLenM));
  const dustReach = Math.max(120, flameLenM * 3);
  const kd = cosPsi > 0.05 ? Math.max(0, Math.min(1, 1 - Math.max(0, hN) / dustReach)) : 0;
  const sI = gi.sE + (bellM + Math.min(Lhit, flameLenM)) * Math.sin(psi);   // impact point along surface
  const sc = thr * F;
  const rnd = Math.random;
  if (tr) { _PAD.fireT = contact * Math.min(1, thr * 1.1); _PAD.fireStamp = state.simTime; }   // drives trench glow

  if (kd > 0.02) {
    // Fast, low, spreading blast cloud (the "ground surge").
    let n = _gfxTake(body, 'lat', 60 * sc * Math.pow(kd, 1.2) * dt);
    for (let i = 0; i < n; i++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const r0 = Wm0 * (0.8 + rnd()) * (0.7 + 0.5 * F);
      const sp = (28 + rnd() * 52) * (0.45 + 0.75 * kd) * (0.6 + 0.4 * thr);
      _gfxSpawn({
        k: _gfxPickKind(gi.onPad, rnd()),
        s: tr ? sI + side * (Wm * 0.5 + 2.2 + rnd() * 2.5) : sI + side * rnd() * Wm * 0.5, y: r0 * 0.45,
        vs: side * sp * (tr ? 0.62 : 1) + Math.sin(psi) * 8, vy: 1 + rnd() * 5 + (tr ? 5 + rnd() * 9 : 0),
        r: r0, gr: 5 + rnd() * 5, drag: 0.28 + rnd() * 0.14, vdrag: 0.6, buoy: 0.6 + rnd() * 0.8,
        age: 0, life: 12 + rnd() * 12, a0: 0.28 + rnd() * 0.24,
        glow: 0.6 + 0.4 * contact, front: rnd() < 0.3, ground: true,
      });
    }
    // Hot buoyant column that rises off the pad and is left behind by the climb.
    n = _gfxTake(body, 'up', 28 * sc * Math.pow(kd, 1.1) * dt);
    for (let i = 0; i < n; i++) {
      const r0 = Wm0 * (1.1 + rnd());
      const q = rnd();
      _gfxSpawn({
        k: gi.onPad ? (q < 0.45 ? 'steam' : (q < 0.75 ? 'smoke' : 'soot')) : (q < 0.6 ? 'dust' : 'smoke'),
        s: sI + (rnd() - 0.5) * Wm * 0.8, y: r0 * 0.6,
        vs: (rnd() - 0.5) * 14, vy: (9 + rnd() * 24) * (0.5 + 0.7 * kd),
        r: r0, gr: 2.5 + rnd() * 3, drag: 0.4, vdrag: 0.2, buoy: 1.1,
        age: 0, life: 18 + rnd() * 14, a0: 0.26 + rnd() * 0.12,
        glow: 0.5 * contact, front: rnd() < 0.3, ground: true,
      });
    }
  }

  // Exhaust vapour trail along the climb (spacing-based so a fast rocket leaves no gaps).
  const nozAlt = gi.altBase - bellM * cosPsi;
  if (nozAlt > 3 && nozAlt < GROUND_FX.TRAIL_MAX_ALT_M) {
    const cur = { s: gi.sE, y: nozAlt };
    const prev = _gfx.last.get(body);
    if (!prev) { _gfx.last.set(body, cur); }
    else {
      const ds = cur.s - prev.s, dy = cur.y - prev.y;
      const spacing = Math.max(Wm * 0.45, 0.8);   // dense, so no visible round blobs
      const n = Math.min(20, Math.floor(Math.hypot(ds, dy) / spacing));
      const fade = Math.pow(1 - nozAlt / GROUND_FX.TRAIL_MAX_ALT_M, 0.6);
      for (let i = 0; i < n; i++) {
        const f = (i + 1) / n;
        _gfxSpawn({
          k: rnd() < 0.8 ? 'steam' : 'smoke',
          s: prev.s + ds * f + (rnd() - 0.5) * Wm * 0.4, y: prev.y + dy * f,
          vs: (rnd() - 0.5) * 1.5, vy: (rnd() - 0.5) * 1.5,
          r: Math.max(Wm, Wm0 * 0.35) * (0.45 + rnd() * 0.35), gr: 0.5 + rnd() * 0.5, drag: 0.5, vdrag: 0.4, buoy: 0,
          age: 0, life: 8 + rnd() * 6, a0: (0.08 + rnd() * 0.07) * fade,
          glow: 0.10, front: rnd() < 0.2, ground: false,
        });
      }
      if (n > 0) _gfx.last.set(body, cur);
    }
  } else {
    _gfx.last.delete(body);
  }
}

function _gfxUpdate() {
  if (!state || !state.bodies) return;
  const t = state.simTime;
  if (_gfx.lastSim === null) { _gfx.lastSim = t; return; }
  if (!(t >= _gfx.lastSim)) {            // sim restarted / rewound
    _gfx.parts.length = 0;
    _gfx.lastSim = t;
    return;
  }
  let dt = t - _gfx.lastSim;
  _gfx.lastSim = t;
  if (dt <= 0 || dt > 5) return;         // paused, or a big time jump
  dt = Math.min(dt, 0.25);
  _gfxStep(dt);
  state.bodies.forEach(b => _gfxEmitBody(b, dt));
}

// Draw the Earth-fixed cloud. 'back' pass runs before the rocket (and steps the
// simulation), 'front' pass draws the ~30% of particles that billow in front.
function drawGroundFx(pass) {
  if (camera.mode === 'planet') return;
  if (pass === 'back') _gfxUpdate();
  const parts = _gfx.parts;
  if (!parts.length) return;
  const sp = _gfxSprites();
  const R = CONFIG.EARTH_RADIUS;
  const site = launchSiteWorldPosition(state.simTime);
  const mpp = metersPerPixel();
  const camAng = cameraAngle();
  const cw = canvas.width, ch = canvas.height;
  const wantFront = pass === 'front';

  ctx.save();
  ctx.filter = 'none';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!!p.front !== wantFront) continue;
    const img = sp[p.k];
    if (!img) continue;
    const rp = p.r / mpp;
    if (rp < 0.6 || rp > 2500) continue;
    const phi = site.phi + p.s / R;
    const rr = R + p.y;
    const [sx, sy] = worldToScreen(rr * Math.sin(phi), rr * Math.cos(phi));
    if (sx < -rp * 2 || sx > cw + rp * 2 || sy < -rp * 2 || sy > ch + rp * 2) continue;
    const life = p.age / p.life;
    const fade = Math.min(1, p.age / 0.35) * Math.pow(1 - life, 1.35);
    const alpha = p.a0 * fade * (wantFront ? 0.8 : 1);
    if (alpha < 0.004) continue;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-(phi - camAng));                 // keep flattening aligned with the ground
    if (p.ground) ctx.scale(1, 0.8);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -rp, -rp, rp * 2, rp * 2);
    if (p.glow > 0.05 && sp.glow) {              // young cloud is lit orange by the flame
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.6, p.glow * 0.55 * fade * 2);
      ctx.drawImage(sp.glow, -rp * 0.85, -rp * 0.85, rp * 1.7, rp * 1.7);
    }
    ctx.restore();
  }
  ctx.restore();
}

// ============================================================================
// REALISTIC PLUME RENDERER (v2)
//
// Composed in a fixed-size offscreen buffer (x across the plume, y along the
// axis) and stretched onto the main canvas, so cost is independent of zoom.
//   * Pressure-dependent shape: exit vs ambient pressure decides pinch (sea
//     level), near-matched with shock diamonds, or ballooning (altitude).
//   * Cluster engines: every nozzle emits its OWN narrow jet (bright core,
//     orange sheath, shock diamonds); the jets merge into the common plume a
//     few exit-diameters downstream. The merged body is translucent, not a
//     solid white wedge, so the dark sky/ground reads through it.
//   * Flowing turbulence: tileable fBm noise stretched along the axis and
//     scrolled outward at three speeds breaks the plume into streaks and
//     ragged wisps, increasingly towards the tail. A faint soot tint
//     dissolves the tail like real kerosene exhaust.
// Returns false if offscreen canvases are unavailable (caller falls back).
// ============================================================================
const _PLX = { BW: 320, BH: 640, ok: null, buf: null, bctx: null, tcv: null, tctx: null, noise: null };

function _plMakeCanvas(w, h) {
  let c = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { c = new OffscreenCanvas(w, h); } catch (e) { c = null; }
  }
  if (!c && typeof document !== 'undefined' && document.createElement) {
    c = document.createElement('canvas');
    c.width = w; c.height = h;
  }
  return c;
}

function _plInit() {
  if (_PLX.ok !== null) return _PLX.ok;
  try {
    const buf = _plMakeCanvas(_PLX.BW, _PLX.BH);
    const tcv = _plMakeCanvas(_PLX.BW, _PLX.BH);
    const nz = _plMakeCanvas(256, 256);
    if (!buf || !tcv || !nz) { _PLX.ok = false; return false; }
    const nctx = nz.getContext('2d');
    const id = nctx.createImageData(256, 256);
    const oct = [[8, 0.46], [16, 0.28], [32, 0.16], [64, 0.10]];
    let rs = 1234567;
    const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
    const lat = oct.map(([n]) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; });
    const sm = t => t * t * (3 - 2 * t);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        let v = 0;
        for (let o = 0; o < oct.length; o++) {
          const n = oct[o][0];
          const fx = x / 256 * n, fy = y / 256 * n;
          let x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = sm(fx - x0), ty = sm(fy - y0);
          const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
          x0 %= n; y0 %= n;
          const a = lat[o];
          const top = a[y0 * n + x0] * (1 - tx) + a[y0 * n + x1] * tx;
          const bot = a[y1 * n + x0] * (1 - tx) + a[y1 * n + x1] * tx;
          v += (top * (1 - ty) + bot * ty) * oct[o][1];
        }
        const u = Math.max(0, Math.min(1, (v - 0.32) / 0.38));
        const al = 0.14 + 0.86 * (u * u * (3 - 2 * u));      // high contrast: real gaps in the flame
        const p = (y * 256 + x) * 4;
        id.data[p] = id.data[p + 1] = id.data[p + 2] = 255;
        id.data[p + 3] = Math.round(al * 255);
      }
    }
    nctx.putImageData(id, 0, 0);
    _PLX.buf = buf; _PLX.bctx = buf.getContext('2d');
    _PLX.tcv = tcv; _PLX.tctx = tcv.getContext('2d');
    _PLX.noise = nz;
    _PLX.ok = true;
  } catch (e) {
    _PLX.ok = false;
  }
  return _PLX.ok;
}

// o: { L, re, alt, ram, t, thr, single, active, jets:[{x,r,lvl}] }   (lengths in screen px)
function _drawPlumeFx(c, o) {
  if (!_plInit()) return false;
  const BW = _PLX.BW, BH = _PLX.BH, b = _PLX.bctx, T = _PLX.tctx, nz = _PLX.noise;
  const L = o.L, t = o.t, ram = o.ram || 0;
  const jets = (!o.single && o.jets && o.jets.length > 1) ? o.jets.filter(j => j.lvl > 0.05) : null;
  const hasJets = !!(jets && jets.length);
  let re = o.re;
  let rj = 0;
  if (hasJets) {
  re = 0;
  jets.forEach(j => { re = Math.max(re, Math.abs(j.x) + j.r * 1.35); rj = Math.max(rj, j.r); });
}
// engine ka asli bahar ka edge (block ke BAHAR, taaki hw() ko dikhe)
let reEng = 0;
if (hasJets) jets.forEach(j => { reEng = Math.max(reEng, Math.abs(j.x) + j.r); });
const s0 = (hasJets && re > 0) ? Math.min(1, (reEng / re) * 0.97) : 1;   // start width as fraction of re
  if (!(L > 2) || !(re > 0.3)) return true;
  // sq = sqrt(thrust-equivalent engine count): one engine = 1, nine = 3.
  // thrEff = how hard the ACTIVE engines are driven. o.thr is the fraction of the
  // WHOLE cluster's thrust, so a single engine at full power would read 0.11 and
  // render dim; the plume's own brightness must follow the engines that are lit.
  const nEq = Math.max(0.05, o.nEq || 1), sq = Math.sqrt(nEq);
  let thrEff = o.thr;
  if (hasJets) { let sl = 0; jets.forEach(j => { sl += j.lvl; }); thrEff = Math.min(1, sl / jets.length); }

  // ---- pressure ratio -> plume shape ----
  const pa = (typeof airPressure === 'function') ? airPressure(Math.max(0, o.alt)) : 0;
  const pe = o.single ? 1500 : 65000;
  let k;
  if (pa >= pe) k = -0.15 * Math.min(1, pa / pe - 1);
  else k = Math.min(5, 0.22 * (Math.sqrt(pe / Math.max(pa, 1e-3)) - 1));
  const gb = 0.55 + 0.55 * k;
  // Jet-based plumes spread by an absolute amount (set by the nozzle, a little
  // more for a bigger merged cluster) rather than a multiple of the cluster span.
  const gAbs = (0.9 + 0.55 * k) * 1.35 * rj * (1 + 0.25 * (sq - 1)) + re * 0.45 * Math.max(0, k);
  const diaVis = o.single ? 0 : Math.max(0, 1 - Math.abs(k) / 0.7) * (0.4 + 0.6 * thrEff);
  const cell = Math.max(0.04, Math.min(0.3, ((hasJets ? rj : re) * 2.6 * (1 + 0.3 * Math.abs(k))) / L));
  const smooth = (a, bb, x) => { const u = Math.max(0, Math.min(1, (x - a) / (bb - a))); return u * u * (3 - 2 * u); };

  const hw = (v) => {
    // Spread: near sea level (k<=0) the plume stays a nearly straight column and only
    // opens up slowly further down (Falcon-9 look); in thin air (k>0) it flares fast.
    const fastG = 1 - Math.exp(-3.2 * v);
    const colM = Math.max(0, Math.min(1, 1 - k * 2));           // 1 = sea-level column
    const grw = fastG + (Math.pow(v, 1.6) * 0.9 - fastG) * colM;
    let h = hasJets ? 1 + (gAbs / re) * grw : 1 + gb * grw;
    if (o.single) h *= 1 - 0.55 * smooth(0.45, 1, v);
    else if (k > 1) h *= 1 - 0.35 * smooth(0.5, 1, v) * Math.min(1, (k - 1) / 2);
    // merged cluster plume: tail narrows as it dissipates (no wide uniform blob)
    if (hasJets) h *= 1 - 0.30 * smooth(0.45, 1, v);
    if (!hasJets) h *= 1 - 0.07 * diaVis * Math.cos(6.2832 * v / cell) * Math.exp(-v * 2.2);
    h *= 1 + ram * v;
    h *= s0 + (1 - s0) * smooth(0, 0.25, v);   // nozzle pe engine width, 25% tak khulta hai
    return re * h;
  };
  const N = 40, prof = new Array(N + 1);
  let wmax = 0;
  for (let i = 0; i <= N; i++) { prof[i] = hw(i / N); if (prof[i] > wmax) wmax = prof[i]; }
  const HALO = 1.28;
  wmax *= HALO * 1.12;
  const kx = (BW / 2) / wmax;

  // ---- palette: [pos, r, g, b, a] ----
  const P = o.single ? {
    halo: [[0, 110, 150, 255, 0.34], [0.5, 70, 105, 255, 0.15], [1, 50, 70, 220, 0]],
    body: [[0, 190, 225, 255, 0.70], [0.3, 125, 178, 255, 0.50], [0.7, 85, 125, 255, 0.20], [1, 60, 90, 230, 0]],
    inner: [[0, 235, 248, 255, 0.85], [0.5, 185, 225, 255, 0.42], [1, 140, 190, 255, 0]],
    core: [[0, 255, 255, 255, 0.95], [0.6, 230, 245, 255, 0.6], [1, 190, 225, 255, 0]],
    jcore: [[0, 255, 255, 255, 0.95], [0.6, 230, 245, 255, 0.6], [1, 190, 225, 255, 0]],
    jet: [[0, 235, 245, 255, 0.8], [0.4, 150, 195, 255, 0.45], [1, 100, 150, 255, 0]],
    smoke: null, spot: '235,245,255',
  } : {
    halo: [[0, 255, 150, 70, 0.20], [0.5, 255, 100, 40, 0.09], [1, 210, 60, 25, 0]],
    body: [[0, 255, 238, 180, 0.88], [0.16, 255, 205, 108, 0.76], [0.40, 248, 136, 52, 0.46], [0.70, 205, 84, 32, 0.20], [1, 150, 60, 30, 0]],
    inner: [[0, 255, 236, 170, 0.85], [0.55, 255, 205, 115, 0.58], [1, 255, 165, 75, 0]],
    core: [[0, 255, 238, 185, 0.78], [0.6, 255, 220, 150, 0.55], [1, 255, 200, 120, 0]],
    jcore: [[0, 255, 244, 208, 0.80], [0.6, 255, 232, 180, 0.45], [1, 255, 215, 150, 0]],
    jet: [[0, 255, 228, 160, 0.80], [0.4, 255, 178, 84, 0.45], [1, 255, 130, 50, 0]],
    smoke: [[0, 70, 52, 42, 0], [0.5, 70, 52, 42, 0.05], [0.8, 84, 68, 60, 0.13], [1, 96, 82, 74, 0]],
    spot: '255,236,196',
  };
  const S2 = (arr, m) => arr.map(s => [s[0], 'rgba(' + s[1] + ',' + s[2] + ',' + s[3] + ',' + (s[4] * (m == null ? 1 : m)).toFixed(3) + ')']);
  // ramp the first stop up from a faint value so the merged body fades in
  // downstream of the individual jets instead of starting as a solid wall
  const topRamp = (arr) => {
    const f = arr[0];
    return [[0, f[1], f[2], f[3], 0], [0.03, f[1], f[2], f[3], f[4]]].concat(arr.slice(1));
  };
  const ramped = (arr, p) => {
    if (!hasJets || p <= 0.001) return topRamp(arr);
    const f = arr[0];
    const out = [[0, f[1], f[2], f[3], f[4] * 0.10], [Math.min(0.95, p), f[1], f[2], f[3], f[4]]];
    for (let i = 1; i < arr.length; i++) if (arr[i][0] > p) out.push(arr[i]);
    return out;
  };
  const vm = hasJets ? Math.max(0.02, Math.min(0.3, 3.6 * rj / L)) : 0;
  const haloBoost = 1 + Math.min(1, Math.max(0, k) / 3) * 0.6;

  const sway = (v) => Math.sin(v * 3.1 - t * 1.3) * re * 0.22 * v * (0.3 + 2.5 * ram) * kx;
  const profAt = (v) => {
    const idx = Math.max(0, Math.min(N, v * N));
    const i0 = Math.floor(idx), i1 = Math.min(N, i0 + 1);
    return prof[i0] + (prof[i1] - prof[i0]) * (idx - i0);
  };

  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.globalAlpha = 1;
  b.clearRect(0, 0, BW, BH);

  // generic tapered strip: cx0 = centre offset (buffer px), hwFn(v) = half-width (screen px)
  function strip(cx0, hwFn, lenFrac, stops, alpha, seed, comp, wobK, swayOn) {
    const segs = 36, wob = (1 + ram * 1.5) * wobK;
    const L1 = [], R1 = [];
    for (let i = 0; i <= segs; i++) {
      const f = i / segs, v = f * lenFrac;
      let w = hwFn(v) * kx;
      const e = Math.max(0, (f - 0.78) / 0.22);
      w *= Math.sqrt(Math.max(0, 1 - e * e));
      const grow = (0.12 + 0.7 * v * v) * wob;   // lateral ragged-edge amount (lower = calmer sides)
      const wl = (Math.sin(v * 4.2 - t * 1.1 + seed * 0.7) * 0.15 + Math.sin(v * 9 - t * 2.3 + seed) * 0.17 + Math.sin(v * 19 - t * 3.8 + seed * 1.4) * 0.09 +
                  Math.sin(v * 37 - t * 6.1 + seed * 2.1) * 0.05) * w * grow;
      const wr = (Math.sin(v * 4.2 - t * 1.1 + seed * 0.7 + 2.6) * 0.15 + Math.sin(v * 9 - t * 2.3 + seed + 1.9) * 0.17 + Math.sin(v * 19 - t * 3.8 + seed * 1.4 + 0.8) * 0.09 +
                  Math.sin(v * 37 - t * 6.1 + seed * 2.1 + 2.4) * 0.05) * w * grow;
      const cx = BW / 2 + cx0 + (swayOn ? sway(v) : 0), y = v * BH;
      L1.push([cx - w - wl, y]); R1.push([cx + w + wr, y]);
    }
    b.beginPath();
    b.moveTo(L1[0][0], L1[0][1]);
    for (let i = 1; i <= segs; i++) b.lineTo(L1[i][0], L1[i][1]);
    for (let i = segs; i >= 0; i--) b.lineTo(R1[i][0], R1[i][1]);
    b.closePath();
    const g = b.createLinearGradient(0, 0, 0, lenFrac * BH);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    b.globalCompositeOperation = comp || 'source-over';
    b.globalAlpha = alpha;
    b.fillStyle = g;
    b.fill();
    b.globalAlpha = 1;
    b.globalCompositeOperation = 'source-over';
  }
  // Wide outer layers (halo/smoke, scale>1) start at the engine-exit width and flare out
  // over the first part of the plume, so no wider-than-engine outline sits at the nozzle.
  const envHW = (scale) => (v) => profAt(v) * (scale > 1 ? (1 + (scale - 1) * smooth(0, 0.3, v)) : scale);
  
  strip(0, envHW(HALO), 1.0, S2(topRamp(P.halo)), Math.min(1, haloBoost), 0.0, 'source-over', 1, true);
  if (P.smoke) strip(0, envHW(1.12), 1.0, S2(topRamp(P.smoke)), 1, 5.0, 'source-over', 1.3, true);
  strip(0, envHW(1.0), 0.92, S2(ramped(P.body, vm / 0.92)), 1, 2.1, 'source-over', 1, true);
  // Altitude physics: in thin air the plume is large, diffuse and less luminous, and the
  // hot inner structure is short. altShrink shortens inner/core, lumAlt dims overall brightness.
  const altShrink = 1 - 0.35 * Math.min(1, Math.max(0, k) / 3);
  const lumAlt = 0.80 + 0.20 * Math.pow(Math.min(1, pa / 101325), 0.35);
  // Feathered layer: several nested, low-alpha strips so there is no hard edge/band.
  const soft = (sc, len, arr, alpha, seed) => {
    const scs = [1, 0.8, 0.6, 0.42];
    scs.forEach((m, i) => {
      strip(0, envHW(sc * m), len * (1 - 0.06 * i), S2(ramped(arr, vm / len)), alpha * 0.34, seed + i * 0.9, 'source-over', 1, true);
    });
  };
  const innerLen = Math.min(0.75, 0.58 * (1 + 0.25 * (sq - 1))) * altShrink;
  soft(0.72, innerLen, P.inner, 1, 4.4);

  // merged hot core (more engines = denser, so it reaches further); drawn before
  // the mask so it carries the same flowing texture as the rest of the plume
  if (hasJets && sq > 1.4) {
    const coreLen = Math.min(0.6, 0.30 * (1 + 0.25 * (sq - 1))) * altShrink;
    soft(0.34, coreLen, P.core, Math.min(0.78, 0.42 + 0.14 * sq), 6.7);
  }

  // ---- flowing turbulence mask ----
  T.setTransform(1, 0, 0, 1, 0, 0);
  T.globalCompositeOperation = 'source-over';
  T.globalAlpha = 1;
  T.clearRect(0, 0, BW, BH);
  T.globalCompositeOperation = 'lighter';
  const drawNoise = (sx, sy, speed, alpha, xo) => {
    const tw = 256 * sx, th = 256 * sy;
    const oy = (((t * speed) % th) + th) % th;
    T.globalAlpha = alpha;
    for (let yy = oy - th; yy < BH; yy += th)
      for (let xx = xo - tw; xx < BW; xx += tw) T.drawImage(nz, xx, yy, tw, th);
  };
  drawNoise(1.9, 2.8, 16, 0.30, 63);     // coarse lobes
  drawNoise(1.1, 1.9, 26, 0.36, 0);
  drawNoise(0.60, 1.1, 46, 0.28, 97);
  drawNoise(0.30, 0.8, 80, 0.18, 41);    // fine flicker
  const S = 0.84 + 0.12 * Math.min(1, ram);   // stronger ragged/streaky tail
  const stopsV = [0, 0.08, 0.18, 0.3, 0.5, 1];
  T.globalAlpha = 1;
  T.globalCompositeOperation = 'destination-in';
  let g = T.createLinearGradient(0, 0, 0, BH);
  stopsV.forEach(v => g.addColorStop(v, 'rgba(255,255,255,' + (S * smooth(0.0, 0.5, v)).toFixed(3) + ')'));
  T.fillStyle = g; T.fillRect(0, 0, BW, BH);
  T.globalCompositeOperation = 'lighter';
  g = T.createLinearGradient(0, 0, 0, BH);
  stopsV.forEach(v => g.addColorStop(v, 'rgba(255,255,255,' + (1 - S * smooth(0.0, 0.5, v)).toFixed(3) + ')'));
  T.fillStyle = g; T.fillRect(0, 0, BW, BH);
  T.globalCompositeOperation = 'source-over';

  b.globalCompositeOperation = 'destination-in';
  b.globalAlpha = 1;
  b.drawImage(_PLX.tcv, 0, 0);
  b.globalCompositeOperation = 'source-over';

  // ---- solid hot features drawn after the mask ----
  const blob = (x, y, rx, ry, rgb, a) => {
    b.save();
    b.translate(x, y); b.scale(rx, ry);
    const rg = b.createRadialGradient(0, 0, 0, 0, 0, 1);
    rg.addColorStop(0, 'rgba(' + rgb + ',' + a.toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(' + rgb + ',0)');
    b.fillStyle = rg;
    b.beginPath(); b.arc(0, 0, 1, 0, Math.PI * 2); b.fill();
    b.restore();
  };

  if (hasJets) {
    // one narrow jet per nozzle: orange sheath + hot core + shock diamonds
    // jets overlap in side view and are additive, so scale each one down as the
    // cluster grows or the sum saturates to a flat white blob
    const jetGain = 1 / Math.sqrt(Math.max(1, jets.length * 0.55));
    jets.forEach((j, idx) => {
      const flick = (0.88 + 0.12 * Math.sin(t * 9 + idx * 2.1)) * jetGain;
      // jets merge sooner at altitude (plumes expand and collide) and the centre jet,
      // shielded by the ring, merges soonest
      const centreK = (Math.abs(j.x) < j.r * 0.5) ? 0.7 : 1;
      const lenJ = Math.max(0.05, Math.min(0.6, 30 * j.r / L * centreK / (1 + 0.3 * Math.max(0, k))));
      const hwJ = (v) => j.r * (1 + (0.9 + 0.4 * Math.max(0, k)) * (1 - Math.exp(-v * L / (5 * j.r))));
      const cx0 = j.x * kx;
      strip(cx0, hwJ, lenJ, S2(P.jet), 0.9 * j.lvl * flick, idx * 1.7 + 3, 'lighter', 0.6, false);
      strip(cx0, (v) => hwJ(v) * 0.42, lenJ * 0.62, S2(P.jcore), 0.95 * j.lvl * flick, idx * 2.3 + 1, 'lighter', 0.4, false);
      b.globalCompositeOperation = 'lighter';
      if (diaVis > 0.03) {
        const cj = Math.max(0.03, Math.min(0.2, j.r * 2.6 / L));
        for (let i = 0; i < 4; i++) {
          const v = cj * (i + 0.7);
          if (v > lenJ * 0.9) break;
          blob(BW / 2 + cx0, v * BH, hwJ(v) * kx * 0.5 * (1 - 0.12 * i), cj * BH * 0.30, P.spot, 0.6 * diaVis * Math.pow(0.75, i) * j.lvl * Math.min(1, jetGain * 1.6));
        }
      }
      blob(BW / 2 + cx0, BH * 0.016, j.r * kx * 1.0, BH * 0.016, P.spot, 0.45 * j.lvl * jetGain);
      b.globalCompositeOperation = 'source-over';
    });
  } else {
    soft(0.26, 0.30 * altShrink, P.core, 1, 6.7);
    b.globalCompositeOperation = 'lighter';
    if (diaVis > 0.03) {
      for (let i = 0; i < 6; i++) {
        const v = cell * (i + 0.6);
        if (v > 0.85) break;
        blob(BW / 2 + sway(v), v * BH, profAt(v) * kx * 0.42 * (1 - 0.1 * i), cell * BH * 0.30, P.spot, 0.55 * diaVis * Math.pow(0.78, i));
      }
    }
    blob(BW / 2, BH * 0.035, re * kx * 1.1, BH * 0.035, P.spot, 0.8);
    b.globalCompositeOperation = 'source-over';
  }

  // Final soft fade-in right at the nozzle exit: whatever layers start there, the plume
  // never begins with a hard horizontal edge - it eases in over the first few percent.
  {
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'destination-in';
    const tg = b.createLinearGradient(0, 0, 0, BH * 0.001);
    tg.addColorStop(0, 'rgba(0,0,0,0.85)');
    tg.addColorStop(0.5, 'rgba(0,0,0,0.95)');
    tg.addColorStop(1, 'rgba(0,0,0,1)');   // gradient is clamped: opaque for everything below 3%
    b.fillStyle = tg;
    b.fillRect(0, 0, BW, BH);              // destination-in clears outside the fill, so cover the whole buffer
    b.restore();
  }

  // Soften the crisp side edges right under the nozzles: the turbulence mask is ~0 there,
  // so the polygon edges would otherwise stay razor sharp. Cross-fade the top part of the
  // plume into a blurred copy of itself, fully blurred at the nozzle, sharp again by ~16%.
  try {
    const HB = Math.round(BH * 0.16);
    T.setTransform(1, 0, 0, 1, 0, 0);
    T.globalAlpha = 1;
    T.globalCompositeOperation = 'source-over';
    T.clearRect(0, 0, BW, BH);
    T.filter = 'blur(4px)';
    T.drawImage(_PLX.buf, 0, 0, BW, HB, 0, 0, BW, HB);
    T.filter = 'none';
    const mg = T.createLinearGradient(0, 0, 0, HB);
    mg.addColorStop(0, 'rgba(0,0,0,1)');
    mg.addColorStop(0.5, 'rgba(0,0,0,0.6)');
    mg.addColorStop(1, 'rgba(0,0,0,0)');
    T.globalCompositeOperation = 'destination-in';
    T.fillStyle = mg;
    T.fillRect(0, 0, BW, HB);              // T only holds the top strip, so clearing the rest is fine
    const bg2 = b.createLinearGradient(0, 0, 0, HB);
    bg2.addColorStop(0, 'rgba(0,0,0,1)');
    bg2.addColorStop(0.5, 'rgb0a(0,0,0,0.6)');
    bg2.addColorStop(1, 'rgba(0,0,0,0)');
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'destination-out';
    b.fillStyle = bg2;
    b.fillRect(0, 0, BW, HB);              // destination-out only touches the filled strip
    b.globalCompositeOperation = 'source-over';
    b.globalAlpha = 1;
    b.drawImage(_PLX.tcv, 0, 0, BW, HB, 0, 0, BW, HB);
    b.restore();
  } catch (e) { // blur filter unsupported: leave the edges as they are 
  } 

  // ---- composite to the main canvas ----
  const a = Math.min(1, 0.55 + 0.45 * thrEff) * lumAlt * (1 + 0.04 * Math.sin(t * 13) * Math.sin(t * 4.1) + (Math.random() - 0.5) * 0.06);
  c.save();
  c.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
  c.globalAlpha = a;
  c.drawImage(_PLX.buf, 0, 0, BW, BH, -wmax, 0, 2 * wmax, L);
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.08 * a;                                   // light bloom
  c.drawImage(_PLX.buf, 0, 0, BW, BH, -wmax * 1.05, -L * 0.01, 2 * wmax * 1.05, L * 1.03);
  // wide soft glow: a bright exhaust lights the air around it
  const glowRGB = o.single ? '120,160,255' : '255,160,80';
  c.translate(0, L * 0.42);
  c.scale(Math.max(wmax * 1.35, re * 3.2), L * 0.30);
  const gg = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  const ga = (0.05 * (0.6 + 0.4 * Math.min(1, sq / 2)) * a).toFixed(3);
  gg.addColorStop(0, 'rgba(' + glowRGB + ',' + ga + ')');
  gg.addColorStop(1, 'rgba(' + glowRGB + ',0)');
  c.globalAlpha = 1;
  c.fillStyle = gg;
  c.beginPath(); c.arc(0, 0, 1, 0, 6.2832); c.fill();
  c.restore();
  return true;
}

// Plume length in metres. A jet's visible length scales with the nozzle exit
// diameter, and a cluster's merged plume grows roughly with sqrt(total thrust),
// so one Merlin gives a short slender flame and nine give a long one -
// instead of tying the length to the rocket's height. Single vacuum nozzles
// keep the old height-based look.
function _plumeLengthM(body, totalThrust, maxSingleF, single, thr) {
  const Hm = CONFIG.ROCKET_HEIGHT;
  if (single) return Hm * (0.6 + 1.6 * thr) * 0.30;
  let dm = 0;
  try {
    if (body.members && body.members[0] && typeof getEngineBellDims_m === 'function')
      dm = getEngineBellDims_m(body.members[0]).d;
  } catch (e) { dm = 0; }
  if (!(dm > 0) || !(maxSingleF > 0)) return Hm * (0.6 + 1.6 * thr);
  return Math.max(3 * dm, 30 * dm * Math.sqrt(Math.max(0, totalThrust / maxSingleF)));
}

function drawBodyRocket(body, isActive, bodyIdx) {
  globalThis._ROCKET_LIGHT = (typeof SimLighting !== 'undefined' && camera.mode !== 'planet') ? SimLighting.rocketLight(body) : null;
  try { _drawBodyRocketInner(body, isActive, bodyIdx); }
  finally { globalThis._ROCKET_LIGHT = null; }
}

function _drawBodyRocketInner(body, isActive, bodyIdx) {
  if (camera.mode === 'planet') {
    drawBodyAsTriangle(body, isActive);
    return;
  }
  
  // Pusher-puff progress for THIS body (0..1), or -1 when no active puff
  // targets it. Computed here once so each member draw call can decide
  // whether to render its own rim burst.
  let puffProgress = -1;
  if (state.pusherPuff && state.pusherPuff.bodyIdx === bodyIdx) {
    const p = state.pusherPuff;
    if (p.id !== _puffLastId) {
      _puffLastId = p.id;
      _puffLocalStart = performance.now();
    }
    const age = (performance.now() - _puffLocalStart) / 1000;
    const DURATION = 1.0;
    puffProgress = age / DURATION;
    if (puffProgress >= 1) puffProgress = -1;
  }
  
  const mpp = metersPerPixel();
  const [px, py] = worldToScreen(body.rx, body.ry);
  const visualTheta = body.theta - Math.atan2(-body.rx, body.ry);
  
  
  const H = CONFIG.ROCKET_HEIGHT / mpp;
  const W = CONFIG.ROCKET_WIDTH / mpp;
  
// Off-screen cull: discarded/staged bodies (boosters, spent stages) keep
// existing physically and get fully rendered every frame even long after
// they've fallen far outside the visible viewport. Skip the whole draw
// (flame + full gradient-heavy art) for anything nowhere near the canvas.
// Margin is generous (6x the rocket's own footprint — bumped from 3x to
// accommodate a fairing's parachute canopy, which can extend 20+ m above
// the body itself) so nothing that's even partially visible ever gets
// clipped.
const cullMargin = Math.max(H, W) * 6;
  if (px < -cullMargin || px > canvas.width + cullMargin ||
    py < -cullMargin || py > canvas.height + cullMargin) {
    return;
  }
  
  ctx.save();
ctx.translate(px, py);
ctx.rotate(-visualTheta);

// Bell exit-plane offset (px). Flame must emerge from the nozzle's exit,
// not the rocket's base — the bell extends below the base by this much.
// Reads rocketArt.js's shared helper so the anchor is guaranteed to sit
// exactly at the bell's flat bottom.
let bellExitY_px = 0;
if (body.members && body.members.length && typeof getEngineBellExitY_m === 'function') {
  bellExitY_px = getEngineBellExitY_m(body.members[0]) / mpp;
}

// ---- Plume (active body only) ----
  // ---- Plume (any body whose engines are firing) ----
  {
    const bodyEngines = (body && body.engines) ? body.engines : [];
    const totalThrust = bodyEngines.reduce((s, e) => s + e.currentF, 0);
    const maxThrust = bodyEngines.reduce((s, e) => s + e.Fmax, 0);
    const totalThrottle = maxThrust > 0 ? totalThrust / maxThrust : 0;
    
    if (totalThrottle > 0.03) {
  // Wrap the WHOLE plume. The rotation axis must match the BELL's:
  // the bell hinges at its gimbal bearing (hull base, y=0) and its
  // exit plane swings with the gimbal. So the flame pivot has to be
  // that same hull-base point, with a translate to the (rotated)
  // exit plane applied AFTERWARD. Order is critical — rotate first
  // about the hull base, then slide down the rotated axis to the
  // nozzle exit. Reversing the order (which the earlier version did)
  // made the flame rotate about the exit plane instead, so its
  // origin no longer coincided with the bell's true swing path.
  ctx.save();
  
  // ---- Ground clip: the exhaust must never be drawn below the surface ----
  // Surface = pad apron (deflector level) when over the pad, Earth otherwise.
  // Built in the body frame, so it survives the gimbal rotate/translate below.
  let _gHBasePx = null;   // hull-base height above the surface (px); null = no ground nearby
  let _trMode = false;    // jet is landing on the flame deflector (pad trench)
  if (camera.mode !== 'planet') {
    const _gi = _groundSurfaceInfo(body);
    if (_gi.altBase < 400) {
      const _bellM = bellExitY_px * mpp;
      _trMode = _gi.onPad && Math.abs(_gi.sE) < PAD_TRENCH.ACTIVE_HALF_W;
      const _surfAlt = _trMode ? -Math.max(-PAD_TRENCH.APEX_Y, _bellM + 0.4) : 0;
      _gHBasePx = (_gi.altBase - _surfAlt) / mpp;
      const gux = Math.sin(visualTheta), guy = -Math.cos(visualTheta);   // ground normal (up)
      const gtx = Math.cos(visualTheta), gty = Math.sin(visualTheta);    // ground tangent
      if (_gi.onPad) {
        // pad: open air + flame hole/trench - deflector wedge (real geometry)
        _padTrenchClipPath(ctx, gtx, gty, gux, guy, _gi.sE, _gi.altBase, mpp);
      } else {
        const gcx = -_gHBasePx * gux, gcy = -_gHBasePx * guy;            // point on the ground line
        const GB = 40000;
        ctx.beginPath();
        ctx.moveTo(gcx - gtx * GB, gcy - gty * GB);
        ctx.lineTo(gcx + gtx * GB, gcy + gty * GB);
        ctx.lineTo(gcx + gtx * GB + gux * GB, gcy + gty * GB + guy * GB);
        ctx.lineTo(gcx - gtx * GB + gux * GB, gcy - gty * GB + guy * GB);
        ctx.closePath();
      }
      ctx.clip();
    }
  }

  // Rotate the whole flame with the gimbal angle. The bell already
  // rotates (drawOneBell applies the same ctx.rotate(gimbalRad)), so
  // the flame now pivots about the same nozzle-exit anchor and tilts
  // naturally instead of staying vertical with a horizontally-shifted
  // tip. Angle is the thrust-weighted average across every gimbal
  // engine that's actually firing — correct for the single-gimbal
  // legacy layout (only the centre contributes) and for the
  // all-gimbal Block 5 layout (all nine at the same angle).
  let _gSum = 0, _gCount = 0;
  bodyEngines.forEach(e => {
    if (e.gimbal && e.currentF > 0.01) {
      _gSum += e.gimbalDeg || 0;
      _gCount++;
    }
  });
  const avgGimbalDeg = _gCount > 0 ? _gSum / _gCount : 0;
const gimbalRad = avgGimbalDeg * Math.PI / 180;
if (gimbalRad !== 0) ctx.rotate(gimbalRad);
// After rotation, drop from the hull-base pivot to the (now
// rotated) bell-exit plane. bellExitY_px is canvas-y (positive
// down), so this lands the flame's local origin exactly at the
// swung nozzle exit.
ctx.translate(0, bellExitY_px);

// Flame palette — vacuum engines (single-nozzle MVac) get a
  // blue-violet plume that's WIDE and SHORT; sea-level clusters get
  // the classic orange-white-hot plume that's narrow and long. The
  // wide blue look matches a real vacuum bell's hugely-expanded
  // exhaust in near-vacuum — narrow & long would visually read as a
  // sea-level engine, which is wrong for the upper stage.
  const isSingleNozzle = !!(
    body.members && body.members[0] && body.members[0].engineTypeId &&
    typeof getComponentType === 'function' &&
    (() => {
      const lay = getComponentType(body.members[0].engineTypeId);
      return lay && lay.frame && Array.isArray(lay.frame.slots) && lay.frame.slots.length === 1;
    })()
  );
  const PAL = isSingleNozzle ? {
    g1_hi: 'rgba(140,180,255,0.60)',
    g1_mid: 'rgba(70,130,255,0.40)',
    g1_lo: 'rgba(40,80,220,0)',
    puff_hi: 'rgba(130,180,255,0.42)',
    puff_lo: 'rgba(70,120,255,0)',
    g2_hi: 'rgba(180,225,255,0.95)',
    g2_mid: 'rgba(120,180,255,0.60)',
    g2_lo: 'rgba(70,130,255,0)',
    g3_hi: 'rgba(245,252,255,1)',
    g3_mid: 'rgba(200,235,255,0.88)',
    g3_lo: 'rgba(150,200,255,0)',
    core: 'rgba(240,250,255,0.98)',
    flare_hi: 'rgba(220,240,255,0.9)',
    flare_mid: 'rgba(180,215,255,0.35)',
    flare_lo: 'rgba(140,190,255,0)',
  } : {
    g1_hi: 'rgba(255,170,80,0.55)',
    g1_mid: 'rgba(255,110,40,0.4)',
    g1_lo: 'rgba(255,70,20,0)',
    puff_hi: 'rgba(255,140,60,0.35)',
    puff_lo: 'rgba(255,90,30,0)',
    g2_hi: 'rgba(255,225,140,0.9)',
    g2_mid: 'rgba(255,150,55,0.55)',
    g2_lo: 'rgba(255,90,20,0)',
    g3_hi: 'rgba(255,252,255,1)',
    g3_mid: 'rgba(255,240,215,0.85)',
    g3_lo: 'rgba(255,190,120,0)',
    core: 'rgba(255,255,255,0.98)',
    flare_hi: 'rgba(255,255,255,0.9)',
    flare_mid: 'rgba(255,255,255,0.35)',
    flare_lo: 'rgba(255,255,255,0)',
  };
  // Length and width multipliers. Vacuum plume is shorter and wider
  // — real MVac flame doesn't punch as far as a Merlin's, it spreads
  // radially once it clears the massive nozzle exit.
  const lenMul = isSingleNozzle ? 0.30 : 1.0;
const widthMul = isSingleNozzle ? 1.30 : 1.0;
// Trail taper — vacuum plumes narrow as they dissipate, they don't
// balloon outward like SL cluster plumes. 1.0 = full SL spread,
// 0.55 = about half-width trail. Booster cluster keeps 1.0.
const trailMul = isSingleNozzle ? 0.40 : 1.0;
  
  const tNow = performance.now() * 0.01;
  // ---- Counter-flow (rocket moving engine-first, e.g. a landing burn) ----
  // When the vehicle travels in the direction its exhaust points, the air
  // rushes up the plume from the tip towards the nozzle. That shortens the
  // plume, makes it billow wider, and shakes it with turbulence; the effect
  // grows with dynamic pressure and is partly resisted by high throttle.
  let ram = 0;
  if (typeof airDensity === 'function' && Number.isFinite(body.vx) && Number.isFinite(body.vy)) {
    const _rr = Math.hypot(body.rx, body.ry) || 1;
    const _vUp = (body.vx * body.rx + body.vy * body.ry) / _rr;
    const _vT = (body.vx * body.ry - body.vy * body.rx) / _rr -
                (CONFIG.EARTH_OMEGA || 0) * _rr;              // relative to the rotating air
    const _psiA = visualTheta - gimbalRad;
    const _vAx = _vT * Math.sin(_psiA) - _vUp * Math.cos(_psiA); // speed along the exhaust direction
    if (_vAx > 0) {
      const _rho = airDensity(_rr - CONFIG.EARTH_RADIUS);
      const _q = 0.5 * _rho * _vAx * _vAx;
      ram = Math.max(0, Math.min(0.9, (_q / (_q + 8000)) * (1.2 - 0.6 * totalThrottle)));
    }
  }
  const tTurb = tNow * (1 + 1.2 * ram);
  const maxSingleF = bodyEngines.reduce((m, e) => Math.max(m, e.Fmax || 0), 0);
  const flameLen = (_plumeLengthM(body, totalThrust, maxSingleF, isSingleNozzle, totalThrottle) / mpp) * (1 - 0.5 * ram);
  
  // fullShift used to horizontally offset the flame tip to fake a
// gimbal lean — no longer needed now that the outer ctx.rotate
// above genuinely tilts the whole plume. Kept declared (value 0)
// because the gasConePath calls and the linear gradients below
// still reference it as an endpoint / layer-shift argument.
const fullShift = 0;
  
  const activeCount = bodyEngines.filter(e => e.currentF > 1).length;
  const plumeScale = isSingleNozzle ?
    0.55 :
    Math.min(1.0, 0.30 + 0.70 * Math.max(0, activeCount - 1) / 8);
  
  function gasConePath(startW, endW, lenFrac, seed, segments, layerShift) {
    const l = flameLen * lenFrac;
    ctx.beginPath();
    ctx.moveTo(-startW / 2, 0);
    for (let i = 1; i <= segments; i++) {
      const f = i / segments;
      const y = l * f;
      const w = startW + (endW * (1 + 1.0 * ram) - startW) * f;
      const grow = 0.15 + 1.1 * f * f;
      const wob = Math.sin(f * 4.5 + tTurb * 2.3 + seed) * w * 0.16 * grow +
        Math.sin(f * 9.5 + tTurb * 3.8 + seed * 1.4) * w * 0.08 * grow +
        Math.sin(f * 15 + tTurb * 2.9 + seed * 2.3) * w * 0.12 * ram * grow;
      ctx.lineTo(-w / 2 - wob + layerShift * f, y);
    }
    const capW = endW,
  capX = layerShift,
  capY = l;
if (isSingleNozzle) {
  // Vacuum tip — low rounded point, no outward bulge.
  ctx.quadraticCurveTo(capX, capY + capW * 0.10, endW / 2 + layerShift, l);
} else {
  ctx.quadraticCurveTo(capX - capW * 0.34, capY + capW * 0.15, capX, capY + capW * 0.22);
  ctx.quadraticCurveTo(capX + capW * 0.34, capY + capW * 0.15, endW / 2 + layerShift, l);
}
    for (let i = segments; i >= 0; i--) {
      const f = i / segments;
      const y = l * f;
      const w = startW + (endW * (1 + 1.0 * ram) - startW) * f;
      const grow = 0.15 + 1.1 * f * f;
      const wob = Math.sin(f * 4.5 + tTurb * 2.3 + seed + 1.9) * w * 0.16 * grow +
        Math.sin(f * 9.5 + tTurb * 3.8 + seed * 1.4 + 0.8) * w * 0.08 * grow +
        Math.sin(f * 15 + tTurb * 2.9 + seed * 2.3) * w * 0.12 * ram * grow;
      ctx.lineTo(w / 2 + wob + layerShift * f, y);
    }
    ctx.closePath();
  }
  
  // New renderer (pressure-dependent shape + flowing turbulence). The old
  // layered-blur cone below stays as a fallback if offscreen canvases fail.
  // Per-nozzle jet layout, mirroring how rocketArt.js places the bells
  // (ring radius clamped to fit the hull; x = R·cos(angle)).
  let _jets = null;
  try {
    const _m0 = body.members && body.members[0];
    if (!isSingleNozzle && _m0 && _m0.engineTypeId && typeof getComponentType === 'function' &&
        typeof getEngineBellDims_m === 'function') {
      const _lay = getComponentType(_m0.engineTypeId);
      const _slots = _lay && _lay.frame && _lay.frame.slots;
      const _dims = getEngineBellDims_m(_m0);
      if (_slots && _slots.length > 1 && _dims.d > 0) {
        const _sR = _dims.d / 2;
        const _hullHalf = CONFIG.ROCKET_WIDTH / 2;
        const _Rm = (_m0.params && Number.isFinite(_m0.params.octaRadius)) ? _m0.params.octaRadius : 1.7;
        const _Rvis = Math.min(_Rm, Math.max(_sR + 0.01, _hullHalf - _sR - 0.03));
        _jets = _slots.map(sl => {
          const xm = (typeof sl.position === 'function') ? (sl.position(_Rvis).x || 0) : 0;
          const e = bodyEngines.find(en => en.angleDeg === sl.angleDeg);
          const lvl = e ? (e.Fmax > 0 ? e.currentF / e.Fmax : 0) : totalThrottle;
          return { x: xm / mpp, r: _sR / mpp, lvl: lvl };
        });
      }
    }
  } catch (err) { _jets = null; }
  const _plumeOk = _drawPlumeFx(ctx, {
    L: flameLen * (1 + 0.03 * Math.sin(tTurb * 3.1) + 0.02 * Math.sin(tTurb * 7.3 + 1)),
    re: W * plumeScale * widthMul / 2,
    alt: Math.hypot(body.rx, body.ry) - CONFIG.EARTH_RADIUS,
    ram: ram, t: tTurb, thr: totalThrottle,
    single: isSingleNozzle, active: activeCount, jets: _jets,
    nEq: maxSingleF > 0 ? totalThrust / maxSingleF : 1,
  });
  if (!_plumeOk) {
  ctx.save();
  ctx.filter = 'blur(11px)';
  gasConePath(W * 1.0 * plumeScale * widthMul, W * 2.7 * plumeScale * widthMul * trailMul, 1.0, 0, 14, fullShift * 1.0);
  const g1 = ctx.createLinearGradient(0, 0, fullShift * 1.0, flameLen * 1.0);
  g1.addColorStop(0, PAL.g1_hi);
  g1.addColorStop(0.55, PAL.g1_mid);
  g1.addColorStop(1, PAL.g1_lo);
  ctx.fillStyle = g1;
  ctx.fill();
  ctx.filter = 'none';
  
  ctx.filter = 'blur(7px)';
  for (let i = 0; i < 5; i++) {
    const f = 0.35 + 0.6 * (i / 4);
    const y = flameLen * f;
    const w = (W * 1.0 * plumeScale * widthMul + (W * 2.7 * plumeScale * widthMul * trailMul - W * 1.0 * plumeScale * widthMul) * f);
    const side = i % 2 === 0 ? 1 : -1;
    const drift = Math.sin(tNow * 1.6 + i * 2.1) * w * 0.18 * (1 + 2.5 * ram);
    const bx = side * (w * 0.42 + drift) + fullShift * f;
    const by = y + Math.cos(tNow * 1.3 + i) * w * 0.08 - ram * w * 0.45 * f;
    const r = w * (0.2 + 0.08 * Math.sin(i * 1.9 + tNow)) * (1 + 0.8 * ram);
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    bg.addColorStop(0, PAL.puff_hi);
    bg.addColorStop(1, PAL.puff_lo);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'none';
  
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(5px)';
  const shift92 = fullShift * 0.92;
  gasConePath(W * 0.78 * plumeScale * widthMul, W * 1.9 * plumeScale * widthMul * trailMul, 0.92, 2.1, 11, shift92);
  const g2 = ctx.createLinearGradient(0, 0, shift92, flameLen * 0.92);
  g2.addColorStop(0, PAL.g2_hi);
  g2.addColorStop(0.5, PAL.g2_mid);
  g2.addColorStop(1, PAL.g2_lo);
  ctx.fillStyle = g2;
  ctx.fill();
  ctx.filter = 'none';
  
  ctx.filter = 'blur(2px)';
  const shift68 = fullShift * 0.68;
  gasConePath(W * 0.58 * plumeScale * widthMul, W * 1.05 * plumeScale * widthMul * trailMul, 0.68, 4.4, 9, shift68);
  const g3 = ctx.createLinearGradient(0, 0, shift68, flameLen * 0.68);
  g3.addColorStop(0, PAL.g3_hi);
  g3.addColorStop(0.55, PAL.g3_mid);
  g3.addColorStop(1, PAL.g3_lo);
  ctx.fillStyle = g3;
  ctx.fill();
  ctx.filter = 'none';
  
  ctx.filter = 'blur(5px)';
  const shift22 = fullShift * 0.22;
  gasConePath(W * 0.42 * plumeScale * widthMul, W * 0.55 * plumeScale * widthMul * trailMul, 0.22, 6.7, 6, shift22);
  ctx.fillStyle = PAL.core;
  ctx.fill();
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  
  ctx.globalCompositeOperation = 'lighter';
  const flare = ctx.createRadialGradient(0, W * 0.05, 0, fullShift * 0.05, W * 0.05, W * 0.9 * plumeScale);
  flare.addColorStop(0, PAL.flare_hi);
  flare.addColorStop(0.5, PAL.flare_mid);
  flare.addColorStop(1, PAL.flare_lo);
    ctx.fillStyle = flare;
  ctx.beginPath();
  ctx.ellipse(0, W * 0.05, W * 0.42 * plumeScale * widthMul, W * 0.2 * plumeScale * widthMul, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  }
  // ---- Ground impingement: plume hits the surface and fans out sideways ----
  // Drawn in the flame frame (origin = nozzle exit, +y along the plume axis).
  // In that frame the ground is a line tilted by psi, so after
  // translate(impact) + rotate(psi) the ground is local y=0 and "up" is -y.
  if (_gHBasePx !== null) {
    const psi = visualTheta - gimbalRad;
    const cosPsi = Math.cos(psi);
    const hO = _gHBasePx - bellExitY_px * cosPsi;          // nozzle-exit height over surface (px)
    const Lhit = cosPsi > 0.05 ? Math.max(0, hO) / cosPsi : Infinity;
    const contact = Math.max(0, Math.min(1, 1 - Lhit / flameLen));
    if (contact > 0.01) {
      const ix = hO >= 0 ? 0 : -hO * Math.sin(psi);
      const iy = hO >= 0 ? Lhit : hO * Math.cos(psi);
      const baseW = W * plumeScale * widthMul;
      const widthHere = baseW * (1.0 + 1.7 * trailMul * Math.min(1, Lhit / flameLen));
      const Ls = baseW * (2.4 + 7.0 * contact) * (0.7 + 0.5 * totalThrottle);
      const LsE = _trMode ? Math.min(Ls, PAD_TRENCH.SLOPE_LEN / mpp) : Ls;   // sheet runs down the wedge slope
      const th = LsE * (0.10 + 0.10 * contact);

      const sheet = (side, len, thick, seed) => {
        const segs = 12;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -thick * (_trMode ? 0.3 : 1));          // thin at the apex so it never pokes above the table
        for (let i = 1; i <= segs; i++) {
          const f = i / segs;
          const env = Math.pow(1 - f, 0.55);
          const wob = 1 + 0.22 * Math.sin(f * 9 + tNow * 3.1 + seed) +
                          0.12 * Math.sin(f * 17 + tNow * 5.3 + seed * 1.7);
          ctx.lineTo(side * len * f, -thick * env * wob);
        }
        ctx.lineTo(side * len, 0);
        ctx.closePath();
      };
      const fillSheet = (side, len, thick, seed, hi, mid, lo, blur) => {
        const g = ctx.createLinearGradient(0, 0, side * len, 0);
        g.addColorStop(0, hi); g.addColorStop(0.45, mid); g.addColorStop(1, lo);
        ctx.filter = 'blur(' + blur + 'px)';
        sheet(side, len, thick, seed);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.filter = 'none';
      };

      ctx.save();
      ctx.translate(ix, iy);
      ctx.rotate(psi);
      ctx.globalAlpha = Math.min(1, contact * 2.2);

      // warm light pooled on the surface around the impact
      ctx.globalCompositeOperation = 'lighter';
      if (!_trMode) {
      ctx.save();
      ctx.scale(1, 0.16);
      const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, Ls * 1.3);
      pool.addColorStop(0, PAL.g1_hi);
      pool.addColorStop(1, PAL.g1_lo);
      ctx.fillStyle = pool;
      ctx.beginPath(); ctx.arc(0, 0, Ls * 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      }

      for (const side of [-1, 1]) {
        const seed = side > 0 ? 1.3 : 4.1;
        ctx.save();
        if (_trMode) ctx.rotate(side * PAD_TRENCH.SLOPE_RAD);          // follow the V deflector downwards
        ctx.globalCompositeOperation = 'source-over';
        fillSheet(side, LsE * 1.25, th * 1.6, seed + 9, PAL.g1_hi, PAL.g1_mid, PAL.g1_lo, 14);   // hazy outer
        ctx.globalCompositeOperation = 'lighter';
        fillSheet(side, LsE, th, seed, PAL.g2_hi, PAL.g2_mid, PAL.g2_lo, 8);                    // body
        fillSheet(side, LsE * 0.62, th * 0.5, seed + 3, PAL.g3_hi, PAL.g3_mid, PAL.g3_lo, 4);   // hot core
        ctx.restore();
      }

      // bright stagnation spot where the plume lands
      ctx.save();
      ctx.scale(1, 0.45);
      const hot = ctx.createRadialGradient(0, 0, 0, 0, 0, widthHere * 0.9);
      hot.addColorStop(0, PAL.flare_hi);
      hot.addColorStop(0.5, PAL.flare_mid);
      hot.addColorStop(1, PAL.flare_lo);
      ctx.fillStyle = hot;
      ctx.beginPath(); ctx.arc(0, 0, widthHere * 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
  }
  // Balanced restore for the outer ctx.save()+translate(0, bellExitY_px)
  // at the top of this block. Without it, every flame frame leaked one
  // save entry and one translate onto the canvas state stack.
  ctx.restore();
  }
  }
    
    // ---- Fairing parachute ----
    // MUST be drawn BEFORE the fairing-half / payload-body early returns
    // below — those branches exit the function, so a chute-draw placed at
    // the bottom would never execute for a fairing half or ejected package
    // (exactly the bug: physics deployed the canopy correctly, but nothing
    // rendered because the fairing-half branch returned before reaching
    // the draw call).
    if (body.chute && body.chute.typeId && body.chute.progress > 0) {
      const chuteType = (typeof getComponentType === 'function') ? getComponentType(body.chute.typeId) : null;
      if (chuteType) {
        const sm = (body && body.members) ? body.members : [];
        const bodyVisualH_px = sm.length ?
          sm.reduce((s, m) => s + (m.height || 0) / mpp, 0) :
          (body.height ? body.height / mpp : 0);
        drawChuteArt(ctx, -bodyVisualH_px, mpp, chuteType, body.chute.progress);
      }
    }
    
    // ---- Stack body draw (identical to before) ----
    const stackMembers = (body && body.members && body.members.length) ?
      body.members :
      ((typeof SIM_STACK_MEMBERS !== 'undefined' && SIM_STACK_MEMBERS.length) ? SIM_STACK_MEMBERS : []);

  // Continuous lighting: one global light field for the whole connected body.
  let stackMaxW_px = 0;
  let stackTotalH_px = 0;
  stackMembers.forEach(m => {
    const mW = (m.width || 1) / mpp;
    if (mW > stackMaxW_px) stackMaxW_px = mW;
    const mH = (m.height || 0) / mpp;
    const ov = (m.stageRole === 'payloadSpace' && Number.isFinite(m.stageOverlapM)) ? m.stageOverlapM / mpp : 0;
    stackTotalH_px += mH - ov;
  });
      
  // ↓↓↓ ye pura block add karo ↓↓↓
  // Payload drawn BEFORE members (background) — so fairing, drawn after,
  // covers it until fairing splits.
  if (body.payloadId && !body.payloadReleased) {
    const pl = (typeof getPayload === 'function') ? getPayload(body.payloadId) : null;
    if (pl) {
      let payloadBaseY = null,
        yy = 0;
      stackMembers.forEach(m => {
        if (m.stageRole === 'payloadSpace' && payloadBaseY === null) payloadBaseY = yy;
        yy += (m.height || 0) / mpp;
      });
      if (payloadBaseY === null) payloadBaseY = yy;
      const plH = (pl.height || 1) / mpp;
      const plW = (pl.width || 1) / mpp;
      ctx.save();
      ctx.translate(0, -payloadBaseY);
      drawPayloadArt(ctx, plW, plH);
      ctx.restore();
    }
  }
  // ↑↑↑ ye pura block add karo ↑↑↑
  // I-d1: fairing half-shell — draw the payloadSpace silhouette but
  // rendered as if sliced in half (approximate: draw the shape then
  // clip away one lateral side).
  if (body.fairingHalf) {
    const rec = body.fairingHalf.record;
    const side = body.fairingHalf.side;
    const psType = (rec.payloadSpaceTypeId && typeof getComponentType === 'function') ?
      getComponentType(rec.payloadSpaceTypeId) : null;
    const psParams = rec.params || {};
    // Fairing's OWN dims — not the stack's. Previously used CONFIG.ROCKET_*
    // so the half-shell was drawn at full-rocket height.
    const fairW_m = Number.isFinite(psParams.capWidth) ? psParams.capWidth : 3;
    const fairH_m = Number.isFinite(psParams.capHeight) ? psParams.capHeight : 3;
    const fairW_px = fairW_m / mpp;
    const fairH_px = fairH_m / mpp;
    
    // Clip to one lateral half (side=+1 → right half; side=-1 → left half).
    ctx.save();
    ctx.beginPath();
    if (side > 0) ctx.rect(0, -fairH_px * 2, fairW_px * 2, fairH_px * 4);
    else ctx.rect(-fairW_px * 2, -fairH_px * 2, fairW_px * 2, fairH_px * 4);
    ctx.clip();
    
    drawRocketArt(ctx, fairW_px, fairH_px, mpp, {
      stageRole: 'payloadSpace',
      payloadKind: psType ? psType.kind : undefined,
      payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
      payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
      payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
      payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
      payloadColor: rec.color || '#e9edf2',
    });
    ctx.restore();
    ctx.restore(); // closes the outer drawBodyRocket save
    return;
  }
  
 // I-d2: payload body — simple rectangle (height × width from its record).
if (body.payloadBody) {
  const pl = body.payloadBody.record;
  const plH_m = Number.isFinite(pl.height) ? pl.height : 1;
  const plW_m = Number.isFinite(pl.width) ? pl.width : 1;
  const plH_px = plH_m / mpp;
  const plW_px = plW_m / mpp;
  // Open progress — driven by the physics-side payloadOpenedAt marker,
  // which guidance fires once PAYLOAD_DEPLOY_OPEN_DELAY_S after deploy.
  // Render worker's state.simTime is the last snapshot's time; the
  // delta gives us a smooth 0→1 unfolding animation.
  let openProgress = 0;
  if (Number.isFinite(body.payloadOpenedAt) && state.simTime > body.payloadOpenedAt) {
    const dur = (typeof CONFIG !== 'undefined' && Number.isFinite(CONFIG.PAYLOAD_OPEN_DURATION_S)) ?
      CONFIG.PAYLOAD_OPEN_DURATION_S : 2.5;
    openProgress = Math.min(1, (state.simTime - body.payloadOpenedAt) / dur);
  }
  ctx.save();
  drawPayloadArt(ctx, plW_px, plH_px, openProgress);
  ctx.restore();
  ctx.restore();
  
  return;
}
  
  if (stackMembers.length) {
  let yOffsetPx = 0;
  stackMembers.forEach((m, idx) => {
      // `memberAbove` is still needed downstream by hasFairingAbove
      // (suppresses the stage's own nose when a fairing sits above it).
      const memberAbove = stackMembers[idx + 1] || null;
      // `stageAboveBellHeight` is no longer passed to drawRocketArt
      // (interstage is its own member now), but kept declared in case
      // any future caller still reads it.
      let stageAboveBellHeight = 0;
      
      const mH = (m.height || 0) / mpp;
      const mW = (m.width || 1) / mpp;
      const recType = (m.hasRecovery === false) ? null :
        ((m.recoveryTypeId && typeof getComponentType === 'function') ?
          getComponentType(m.recoveryTypeId) : null);
      const rcsT = (m.rcsTypeId && typeof getComponentType === 'function') ?
        getComponentType(m.rcsTypeId) : null;
      const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ?
        getComponentType(m.engineTypeId) : null;
      
      // PS-D2: payloadSpace fairing shape opts.
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
  }: {};
  
  // Grid fins — the live state lives on the BODY (one state per body,
  // all four fins share it — L/R deploy together, F/B deploy together
  // and control together). m.isActive (from body index) decides
  // whether this member receives the live state or just renders
  // stowed.
  const gfType = (m.hasGridFins && m.gridFinTypeId && typeof getComponentType === 'function') ?
    getComponentType(m.gridFinTypeId) : null;
  
  // Render-side: signal that this stage has a fairing sitting on top
// of it in the stack, so the drawer suppresses the stage's own nose.
const hasFairingAbove = !!(memberAbove && memberAbove.stageRole === 'payloadSpace');

      ctx.save();
// Fairing's physical base sits `stageOverlapM` below the stage hull
// top — that overlap is where the fairing wraps the stage. Reduce
// the fairing's draw position by that much so the two members
// interlock instead of the fairing hovering above the stage.
const overlapPx = (m.stageRole === 'payloadSpace' && Number.isFinite(m.stageOverlapM)) ?
  m.stageOverlapM / mpp : 0;
const placeY = yOffsetPx - overlapPx;
ctx.translate(0, -placeY);
// Only the TOP member of the stack draws the pusher puff — the
// pushers live at the interstage, which is the last member in the
// booster's members array after separation.
const isTopMember = (idx === stackMembers.length - 1);
const puffForThisMember = (isTopMember && puffProgress >= 0) ?
  puffProgress : -1;
drawRocketArt(ctx, mW, mH, mpp, {
      legsProgress: (isActive && idx === 0) ? legs.progress : 0,
      stackMaxW_px: stackMaxW_px,
      stackTotalH_px: stackTotalH_px,
      memberOffsetY_px: placeY,
      legsState: isActive ? legs : null,
      // A5 — tell the drawer which member of the body this is, so its
      // pod-id lookups match the `b<memberIdx>.<side><idx>` keys that
      // computeRCSForBody filled into body.lastRcs.
      memberIdx: idx,
      // Which body this member belongs to — needed so the RCS particle
      // pool is keyed per (body, member), not per member alone. Without
      // this, the stage's member 0 and the booster's member 0 share the
      // same pool after separation, and their particles draw in the
      // wrong body's local frame.
      bodyIdx: bodyIdx,
      firing: (body.lastRcs && body.lastRcs.firing) || {},
  pod: (body.lastRcs && body.lastRcs.pod) || {},
  rcsMode: (body.lastRcs && body.lastRcs.mode) || {},
  rcsRising: (body.lastRcs && body.lastRcs.rising) || {},
  
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
                  // (interstage is its own member now — nothing extra to pass)
        // Bell hidden when this member has a member below in the stack —
        // see drawRocketArt's guard for the reasoning (MVac bell sits
        // inside the booster's interstage, not visible side-on).
        hasMemberBelow: idx > 0,
    gridFinType: gfType,
    gridFinParams: m.gridFinParams || null,
    gridFinState: body.gridFins || null,
      gridFinColor: m.gridFinColor || '#8a9198',
    locked: m.locked === true,
    // Live engine array — only the bottom member carries engines
    // (buildEnginesForRecord is called on members[0] only). Passed so
    // the bell draw can rotate each nozzle by its current gimbalDeg.
    // Static previews and upper members get null → bells drawn at 0°.
      liveEngines: (idx === 0) ? body.engines : null,
    pusherPuffProgress: puffForThisMember,
    ...payloadOpts,
  });
  ctx.restore();
           
                yOffsetPx = placeY + mH;
     });
     }
      
      ctx.restore();
      }
      

function renderFrame() {
  if (!state.bodies || !state.bodies.length) return;
  const b = state.bodies[state.activeBodyIndex];
  if (!b || !Number.isFinite(b.rx) || !Number.isFinite(b.ry)) return;
  if (!camera) return;
  
  const r = Math.hypot(state.rx, state.ry);
  const altitude = altitudeFromR(r);
  
  drawSky(altitude);
  
  if (camera.mode === 'planet') {
  drawEarth();
  if (typeof SimLighting !== 'undefined') SimLighting.shadeEarth(ctx, canvas);
  drawGrid();
  drawOceanArea();
  drawRemoteArea();
  drawPredictedTrajectory();
  drawRocket();
  return;
}

drawEarth();
  if (typeof SimLighting !== 'undefined') SimLighting.shadeEarth(ctx, canvas);
  drawGrid();
drawOceanArea();
drawRemoteArea();
drawPredictedTrajectory();
drawLaunchPad();
drawGroundFx('back');
    drawRocket();
    drawGroundFx('front');
  drawActiveBodyIndicator();
  drawSeparationFlash();
  drawPayloadReleaseCue();
  }