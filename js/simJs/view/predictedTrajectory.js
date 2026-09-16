// ============================================================================
// predictedTrajectory.js — Ideal two-body orbit overlay.
//
// Given the active body's current inertial state, computes the analytical
// conic (Keplerian) orbit that would result if ONLY Earth's gravity acted
// from this instant onward. Thrust, drag, RCS, wind, collisions — none of
// them are considered. This is a "what-if I stopped everything now" preview,
// not a substitute for the RK4 integrator that actually drives the sim.
//
// Purely a rendering aid. Nothing here feeds back into physics state.
// ============================================================================

// Compute sample points on the ideal orbit. Returns:
//   { points: [{x, y, r}], e, a, p, periapsis, apoapsis, omegaApo }
// or null if the orbit is degenerate (radial motion, zero angular momentum).
//
// `points` are in WORLD (inertial, Earth-centered) coordinates, in the same
// frame render.js's worldToScreen() consumes. Ordering is along the direction
// of motion.
// ============================================================================
// trajectoryMath.js — pure two-body (Keplerian) trajectory math. NO DOM, no
// canvas, no worldToScreen. Loaded by BOTH the main thread (for optional
// debug) and the physics worker (which precomputes the trajectory each tick
// and ships it in the state snapshot). Rendering lives in
// predictedTrajectory.js on the main thread.
// ============================================================================

// ============================================================================
// Rendering — dashed trajectory + impact marker, clipped to the region above
// Earth's surface. Uses the SAME worldToScreen() transform the round-earth
// camera pipeline provides, so the curve lines up perfectly with the planet.
// ============================================================================
// ============================================================================
// predictedTrajectory.js — draws the precomputed two-body prediction that
// the physics worker ships in its state snapshot. No math here — just
// projection to screen and canvas rendering.
// ============================================================================
function drawPredictedTrajectory() {
  if (!showTrajectory) return;

  // Guard 1 — trajectory may not exist yet on the first few frames after
  // the worker starts up (before its first 33 ms trajectory tick).
  const traj = state.trajectory;
if (!traj || !traj.count || traj.count < 2) return;

const earthFixed = (typeof trajectoryMode !== 'undefined' && trajectoryMode === 'earthFixed');
const ptsXy = (earthFixed && traj.pointsXyEarthFixed) ?
  traj.pointsXyEarthFixed :
  traj.pointsXy;
if (!ptsXy) return;
const count = traj.count;

  // ---- Camera projection — cached once for the whole pass ----
  const mpp = metersPerPixel();
  const cam = cameraWorldPosition();
  const halfW = canvas.width / 2, halfH = canvas.height / 2;

  let upX, upY, rightX, rightY;
  if (camera.mode === 'planet') {
    upX = 0;  upY = 1;
    rightX = 1; rightY = 0;
  } else {
    const camR = Math.hypot(cam.x, cam.y) || 1;
    upX = cam.x / camR;  upY = cam.y / camR;
    rightX = upY;         rightY = -upX;
  }

  const project = (wx, wy) => {
    const dx = wx - cam.x, dy = wy - cam.y;
    const localR = dx * rightX + dy * rightY;
    const localU = dx * upX    + dy * upY;
    return [halfW + localR / mpp, halfH - localU / mpp];
  };

  const earthR_px = CONFIG.EARTH_RADIUS / mpp;
  const lineW = 3 + 2 * Math.max(0, Math.min(1, (800 - earthR_px) / 800));
  const EarthR = CONFIG.EARTH_RADIUS;

  // ---- Trajectory curve ----
  ctx.save();
  ctx.strokeStyle = 'rgba(255,210,63,0.7)';
  ctx.lineWidth = lineW;
  ctx.setLineDash([lineW * 3, lineW * 3]);
  ctx.lineCap = 'round';

  // Translate the whole curve so its origin (where the rocket was when the
// trajectory was computed) aligns with where the rocket IS right now.
// Hides the up-to-16 ms staleness of the prediction, so the curve always
// starts at the rocket even at high speeds.
const _predBody = state.bodies[state.activeBodyIndex];
const dxShift = (_predBody ? _predBody.rx : traj.originX) - traj.originX;
const dyShift = (_predBody ? _predBody.ry : traj.originY) - traj.originY;



ctx.beginPath();
let penDown = false;
for (let i = 0; i < count; i++) {
  const [sx, sy] = project(ptsXy[i*2] + dxShift, ptsXy[i*2 + 1] + dyShift);
  if (!penDown) { ctx.moveTo(sx, sy); penDown = true; }
  else ctx.lineTo(sx, sy);
}
if (penDown) ctx.stroke();


  ctx.setLineDash([]);

  // ---- Impact marker ----
  const hasImpact = earthFixed ? traj.hasEfImpact : traj.impacted;
if (hasImpact) {
  let ix = earthFixed ? traj.impactXEf : traj.impactX;
  let iy = earthFixed ? traj.impactYEf : traj.impactY;
  // Same rigid translation as the curve.
  ix += dxShift;
  iy += dyShift;
  const ir = Math.hypot(ix, iy) || 1;
  const cx = ix * (EarthR / ir);
  const cy = iy * (EarthR / ir);
  const [sx, sy] = project(cx, cy);
  ctx.fillStyle = 'rgba(255,120,90,0.9)';
  ctx.strokeStyle = 'rgba(20,10,5,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(3, lineW * 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

  ctx.restore();
}