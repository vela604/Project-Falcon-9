// ============================================================================
// computePredictedTrajectory — time-domain ballistic prediction.
//
// NOT the same as "the full Keplerian ellipse through current state".
// That approach samples the entire conic, which for a sub-orbital state
// is 99% buried inside Earth — visually a sub-pixel sliver.
//
// Instead, propagate the two-body motion forward in time with RK2 from the
// current state. The resulting point list is a finite arc that starts at
// the rocket, curves under gravity, and terminates at the first surface
// crossing. Always visible, no matter how eccentric the orbit is. Stops
// early on impact so it doesn't trace the whole ellipse underground.
//
// maxTimeSec is the wall of prediction. 1200 s (20 min) covers a typical
// sub-orbital flight; orbits with periods longer than that just show the
// first ~20 minutes of the path, which is what a mission console would
// show anyway.
// ============================================================================
function computePredictedTrajectory(body, maxSamples, maxTimeSec) {
  if (!body) return null;
  maxSamples = maxSamples || 400;
  maxTimeSec = maxTimeSec || 1200;
  
  // ---- Auto-extend the prediction window for bound orbits ----
  // A fixed 20 min window is far too short for LEO (period ~92 min) —
  // it only traces ~1/4 of the orbit. For any elliptical orbit, stretch
  // the window to ~1.2 × period so the full ellipse is visible. For
  // parabolic / hyperbolic (unbound) trajectories, keep the original
  // fixed window — the path is open and there's no period to speak of.
  {
    const mu = CONFIG.GM_EARTH;
    const r0 = Math.hypot(body.rx, body.ry);
    const v2 = body.vx * body.vx + body.vy * body.vy;
    const eps = v2 / 2 - mu / r0; // specific orbital energy
    if (eps < 0) {
      const a = -mu / (2 * eps);
      const periodSec = 2 * Math.PI * Math.sqrt(a * a * a / mu);
      maxTimeSec = Math.max(maxTimeSec, periodSec * 1.00);
    }
  }
  
  const mu = CONFIG.GM_EARTH;
  const EarthR = CONFIG.EARTH_RADIUS;
  const omegaE = CONFIG.EARTH_OMEGA;
  
  let rx = body.rx,
    ry = body.ry;
  let vx = body.vx,
    vy = body.vy;
  
  const dt = maxTimeSec / maxSamples;
  const points = [];
  let impacted = false;
  let impactPoint = null;
  
  // ---- Step 1: propagate the inertial trajectory ----
  for (let i = 0; i <= maxSamples; i++) {
    const r = Math.hypot(rx, ry);
    
    points.push({ x: rx, y: ry, r });
    
    if (r < EarthR && i > 0) {
      impacted = true;
      impactPoint = { x: rx, y: ry, r };
      break;
    }
    
    // RK2 (midpoint) — cheap and accurate enough for a visual preview.
    // ---- Leapfrog (velocity Verlet) — symplectic integrator ----
    // Unlike RK2, this has ZERO secular energy drift: a circular/elliptical
    // orbit computed with leapfrog closes on itself exactly, whereas RK2
    // accumulates a tiny energy error every step and the trajectory slowly
    // spirals in or out. That drift is what produced the visible spiral
    // when tracing a full orbit. Leapfrog is only a hair more expensive
    // (one extra gravity eval per step) and it's the standard choice for
    // orbital mechanics preview.
    //
    //   v_half = v + a(x) · dt/2
    //   x_new  = x + v_half · dt
    //   v_new  = v_half + a(x_new) · dt/2
    const r2 = r * r;
    const r3 = r2 * r;
    const ax0 = -mu * rx / r3;
    const ay0 = -mu * ry / r3;
    
    const vxHalf = vx + 0.5 * dt * ax0;
    const vyHalf = vy + 0.5 * dt * ay0;
    
    const rxNew = rx + dt * vxHalf;
    const ryNew = ry + dt * vyHalf;
    
    const rn2 = rxNew * rxNew + ryNew * ryNew;
    const rn3 = rn2 * Math.sqrt(rn2);
    const axNew = -mu * rxNew / rn3;
    const ayNew = -mu * ryNew / rn3;
    
    rx = rxNew;
    ry = ryNew;
    vx = vxHalf + 0.5 * dt * axNew;
    vy = vyHalf + 0.5 * dt * ayNew;
  }
  
  // ---- Step 2: Earth-fixed copy — rotate each inertial point by −ω·t ----
  // A point at inertial angle φ at time t is at Earth-fixed angle φ − ω·t.
  // With our (sinφ, cosφ) convention, that's the rotation
  //   x' = x·cos(ωt) − y·sin(ωt)
  //   y' = x·sin(ωt) + y·cos(ωt)
  // Radius is unchanged (rotation preserves distance from origin).
  const pointsEarthFixed = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const t = i * dt;
    const a = omegaE * t;
    const cA = Math.cos(a),
      sA = Math.sin(a);
    const p = points[i];
    pointsEarthFixed[i] = {
      x: p.x * cA - p.y * sA,
      y: p.x * sA + p.y * cA,
      r: p.r,
    };
  }
  
  // ---- Step 3: impact point Earth-fixed ----
  let impactPointEarthFixed = null;
  if (impactPoint) {
    const tImpact = (points.length - 1) * dt;
    const a = omegaE * tImpact;
    const cA = Math.cos(a),
      sA = Math.sin(a);
    impactPointEarthFixed = {
      x: impactPoint.x * cA - impactPoint.y * sA,
      y: impactPoint.x * sA + impactPoint.y * cA,
      r: impactPoint.r,
    };
  }
  
  // ---- Pack into transferable typed arrays ----
  // Sending 1000 plain {x,y,r} objects through postMessage's structured
  // clone every snapshot (≈30 Hz) means ~30k object allocations per second
  // and a full deep copy on the main thread. Interleaved Float32Arrays
  // instead: two buffers per snapshot, zero allocation (transferred, not
  // copied), and the receiver reads with a plain index.
  const N = points.length;
  const pointsXy = new Float32Array(N * 2);
  const pointsXyEarthFixed = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    pointsXy[i * 2] = points[i].x;
    pointsXy[i * 2 + 1] = points[i].y;
    pointsXyEarthFixed[i * 2] = pointsEarthFixed[i].x;
    pointsXyEarthFixed[i * 2 + 1] = pointsEarthFixed[i].y;
  }
  
  return {
    count: N,
    pointsXy,
    pointsXyEarthFixed,
    // Origin = active body's position at compute time. The render side uses
    // this to translate the entire curve so its first sample lines up with
    // the CURRENT body position each frame — without this, at 60 Hz the
    // trajectory visibly trails the rocket by up to one compute period.
    originX: body.rx,
    originY: body.ry,
    impacted,
    impactX: impactPoint ? impactPoint.x : 0,
    impactY: impactPoint ? impactPoint.y : 0,
    hasEfImpact: !!impactPointEarthFixed,
    impactXEf: impactPointEarthFixed ? impactPointEarthFixed.x : 0,
    impactYEf: impactPointEarthFixed ? impactPointEarthFixed.y : 0,
  };
  
  
}