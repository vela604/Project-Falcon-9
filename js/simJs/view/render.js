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
  const totalH = (b.members && b.members.length) ?
    b.members.reduce((s, m) => s + (Number.isFinite(m.height) ? m.height : 0), 0) :
    (CONFIG.ROCKET_HEIGHT || 45);
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
  grad.addColorStop(0, `rgb(${c[0]*0.6},${c[1]*0.6},${c[2]*0.6})`);
  grad.addColorStop(1, `rgb(${c[0]},${c[1]},${c[2]})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  if (camera.mode === 'planet') return;
  
  // Pad is pinned to the rotating Earth — its inertial position moves with
  // Earth's rotation. Compute current site position, screen position, and
  // the surface-tangent orientation, then draw everything inside that frame.
  const site = launchSiteWorldPosition(state.simTime);
  const [sitePx, sitePy] = worldToScreen(site.x, site.y);
  if (sitePx < -800 || sitePx > canvas.width + 800 ||
    sitePy < -800 || sitePy > canvas.height + 800) return;
  
  ctx.save();
  ctx.translate(sitePx, sitePy);
  ctx.rotate(-(site.phi - cameraAngle()));
  
  const px0 = 0,
    py0 = 0; // pad ground-contact point is now local (0,0)
  const mpp = metersPerPixel();
  const m = (meters) => meters / mpp;
  
  // The rocket's base rests exactly at local y=0 (py0). The launch mount's
  // TOP surface is flush with that; everything else (apron, tower, tanks)
  // is referenced down from the mount's base so nothing floats or embeds.
  const mountHalfW = m(9),
    mountH = m(2.4);
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
      ctx.beginPath();
      ctx.moveTo(px0 + f * apronHalfW, aprY);
      ctx.lineTo(px0 + f * apronHalfW, aprY + m(2));
      ctx.stroke();
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
  const towerW = m(4.4),
    towerH = m(rocketH * 0.9);
  
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
    const y1 = aprY - towerH * (i / braceSteps),
      y2 = aprY - towerH * ((i + 1) / braceSteps);
    ctx.beginPath();
    ctx.moveTo(towerX - towerW / 2, y1);
    ctx.lineTo(towerX + towerW / 2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(towerX + towerW / 2, y1);
    ctx.lineTo(towerX - towerW / 2, y2);
    ctx.stroke();
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
    ctx.beginPath();
    ctx.moveTo(ax0, ay);
    ctx.lineTo(ax1, ay);
    ctx.stroke();
    ctx.fillStyle = '#2e3136';
    ctx.beginPath();
    ctx.arc(ax0, ay, m(0.9), 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ax1, ay, m(0.7), 0, Math.PI * 2);
    ctx.fill();
  });
  // Blinking hazard light at the tower top
  const blink = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
  ctx.fillStyle = `rgba(255,60,50,${0.5 + 0.5 * blink})`;
  ctx.beginPath();
  ctx.arc(towerX, aprY - towerH, Math.max(2, m(1.1)), 0, Math.PI * 2);
  ctx.fill();
  
  ctx.restore();
  
  // ---- Background ground-support tanks (flat side-elevation, not 3D) ----
  const tankX = px0 - apronHalfW * 0.72;
  [0, 1].forEach(i => {
    const tx = tankX - i * m(9);
    const tw = m(4.5),
      th = m(10);
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
  // ... (sab existing pad drawing unchanged) ...
  
  ctx.restore(); // close the pad transform
  
}

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
  // H1c: draw every body. Camera still follows the active body (via
  // worldToLocal() in the camera-center calculation), but each body's
  // geometry is drawn at its own position/orientation. Right now there is
  // exactly one body, so this is visually identical to before.
  state.bodies.forEach((body, idx) => {
    drawBodyRocket(body, idx === state.activeBodyIndex);
  });
}

// Planet-view rocket marker. A small triangle whose vertex points along
// the body's VELOCITY direction (in the inertial frame). Because screen-y
// is flipped (world +y → screen −y), the on-screen rotation angle is
// atan2(−vy, vx). Active body is cyan, discarded bodies are orange.
function drawBodyAsTriangle(body, isActive) {
  const [px, py] = worldToScreen(body.rx, body.ry);
  const speed = Math.hypot(body.vx, body.vy);
  
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

function drawBodyRocket(body, isActive) {
  if (camera.mode === 'planet') {
    drawBodyAsTriangle(body, isActive);
    return;
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
  
  // ---- Plume (active body only) ----
  // ---- Plume (any body whose engines are firing) ----
  {
    const bodyEngines = (body && body.engines) ? body.engines : [];
    const totalThrust = bodyEngines.reduce((s, e) => s + e.currentF, 0);
    const maxThrust = bodyEngines.reduce((s, e) => s + e.Fmax, 0);
    const totalThrottle = maxThrust > 0 ? totalThrust / maxThrust : 0;
    
    if (totalThrottle > 0.03) {
      const tNow = performance.now() * 0.01;
      const flameLen = H * (0.6 + 1.6 * totalThrottle);
      
      const centerEngine = bodyEngines.find(e => e.isCenter);
      
      
      const centerFrac = totalThrust > 0 ? centerEngine.currentF / totalThrust : 0;
      const gimbalRad = (centerEngine.gimbalDeg * Math.PI / 180) * centerFrac;
      const fullShift = -flameLen * Math.sin(gimbalRad);
      
      const activeCount = bodyEngines.filter(e => e.currentF > 1).length;
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
          const wob = Math.sin(f * 4.5 + tNow * 2.3 + seed) * w * 0.16 * grow +
            Math.sin(f * 9.5 + tNow * 3.8 + seed * 1.4) * w * 0.08 * grow;
          ctx.lineTo(-w / 2 - wob + layerShift * f, y);
        }
        const capW = endW,
          capX = layerShift,
          capY = l;
        ctx.quadraticCurveTo(capX - capW * 0.34, capY + capW * 0.15, capX, capY + capW * 0.22);
        ctx.quadraticCurveTo(capX + capW * 0.34, capY + capW * 0.15, endW / 2 + layerShift, l);
        for (let i = segments; i >= 0; i--) {
          const f = i / segments;
          const y = l * f;
          const w = startW + (endW - startW) * f;
          const grow = 0.15 + 1.1 * f * f;
          const wob = Math.sin(f * 4.5 + tNow * 2.3 + seed + 1.9) * w * 0.16 * grow +
            Math.sin(f * 9.5 + tNow * 3.8 + seed * 1.4 + 0.8) * w * 0.08 * grow;
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
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
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
      ctx.restore();
      
      ctx.globalCompositeOperation = 'lighter';
      const flare = ctx.createRadialGradient(0, W * 0.05, 0, fullShift * 0.05, W * 0.05, W * 0.9 * plumeScale);
      flare.addColorStop(0, 'rgba(255,255,255,0.9)');
      flare.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      flare.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = flare;
      ctx.beginPath();
      ctx.ellipse(0, W * 0.05, W * 0.42 * plumeScale, W * 0.2 * plumeScale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
          // ctx.restore;
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
    ctx.save();
    drawPayloadArt(ctx, plW_px, plH_px);
    ctx.restore();
    ctx.restore(); // closes the outer drawBodyRocket save
    
    return;
  }
  
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
      } : {};
      
      // Render-side: signal that this stage has a fairing sitting on top
// of it in the stack, so the drawer suppresses the stage's own nose.
const hasFairingAbove = !!(memberAbove && memberAbove.stageRole === 'payloadSpace');

ctx.save();
ctx.translate(0, -yOffsetPx);
drawRocketArt(ctx, mW, mH, mpp, {
      legsProgress: (isActive && idx === 0) ? legs.progress : 0,
      legsState: isActive ? legs : null,
      // A5 — tell the drawer which member of the body this is, so its
      // pod-id lookups match the `b<memberIdx>.<side><idx>` keys that
      // computeRCSForBody filled into body.lastRcs.
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
                 ctx.restore();
      yOffsetPx += mH;
      });
      }
      
      ctx.restore();
      }
      
      function drawGroundSteam(altitude) {
  const totalThrust = ENGINES.reduce((s, e) => s + e.currentF, 0);
  const maxThrust = ENGINES.reduce((s, e) => s + e.Fmax, 0);
  const throttle = maxThrust > 0 ? totalThrust / maxThrust : 0;
  if (throttle < 0.05 || altitude > 180) return;
  
  
  
  // Point on Earth's surface directly beneath the camera.
  const cam = cameraWorldPosition();
  const camR = Math.hypot(cam.x, cam.y) || 1;
  const groundX = cam.x * (CONFIG.EARTH_RADIUS / camR);
  const groundY = cam.y * (CONFIG.EARTH_RADIUS / camR);
  const [cx, groundPy] = worldToScreen(groundX, groundY);
  
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
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'none';
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
    drawGrid(); // ← ye line add karo
    drawPredictedTrajectory();
    drawRocket();
    return;
  }
  
  drawEarth();
  drawGrid();
  drawPredictedTrajectory();
  drawLaunchPad();
  drawGroundSteam(altitude);
  drawRocket();
  drawActiveBodyIndicator();
  drawSeparationFlash();
  drawPayloadReleaseCue();
}