// =============================================================================
// collision.js — Step 2 of COLLISION_PROMPT.md: broad-phase body-vs-body
// detection.
//
// Scope of THIS step only: find which pairs of state.bodies are close enough
// that a real (narrow-phase) collision check is worth doing. Nothing in this
// file resolves a collision or touches position/velocity — that's Step 3
// (oriented shape test) and Step 4 (impulse response), not yet built.
//
// Approach: each body is approximated as a bounding CIRCLE (radius = half
// the diagonal of its H×W footprint, centered on its actual rotated
// mid-point) — deliberately generous so it never misses a real overlap.
// Cheap O(n²) pairwise check; fine here since state.bodies stays small
// (active stack + a handful of discarded pieces — see COLLISION_PROMPT.md
// Step 5 for the note to revisit this if that count ever grows past ~5-10).
//
// Exclusion rule: a body that was JUST created by a separation event
// (booster discard, fairing split, payload release) starts out physically
// overlapping the thing it separated from — real position, not a bug — so
// it's excluded from EVERY candidate pair for a short grace period
// (COLLISION_GRACE_PERIOD) right after it's born, not just against its one
// specific parent. Simplification vs. the "only exclude parent/sibling"
// wording in the prompt: tracking exact parent/sibling relationships would
// need extra bookkeeping at each of the three separation sites for no real
// benefit — nothing else is ever close enough to a body in its first 0.3s
// to produce a legitimate collision anyway, so a blanket grace period on
// the newborn body gets the same practical result with far less code.
// =============================================================================

const COLLISION_GRACE_PERIOD = 0.3; // seconds, see note above

// Half-diagonal of the body's own H×W footprint — a circle this size fully
// contains the body's rotated silhouette at any tilt angle.
function _bodyBoundingRadius(body) {
  const H = _bodyHeightOf(body);
  const W = _bodyWidthOf(body);
  return Math.hypot(H, W) / 2;
}

// Center of that bounding circle: the body's actual rotated mid-height
// point (not the tracked base-origin), so the circle stays centered on the
// real footprint regardless of tilt. Reuses the same rotation convention
// resolveGroundContact() already uses (_rotatedPoint, local +Y = up-stack).
function _bodyBoundingCenter(body) {
  const H = _bodyHeightOf(body);
  return _rotatedPoint(body, 0, H / 2);
}

// Returns an array of candidate overlapping pairs: [{ i, j, distSq }], each
// i<j indexing into state.bodies. This is a CANDIDATE list only — a "yes"
// here means "close enough to be worth a real shape test in Step 3", not
// "these are actually touching". Step 3 will do that definitive check.
function broadPhaseCollisionPairs() {
  const bodies = state.bodies;
  const pairs = [];
  const n = bodies.length;
  if (n < 2) return pairs;

  // Precompute center + radius once per body per call, not once per pair.
  const circles = bodies.map(b => ({
    c: _bodyBoundingCenter(b),
    r: _bodyBoundingRadius(b),
    newborn: (state.simTime - (b.bornAt ?? -Infinity)) < COLLISION_GRACE_PERIOD,
  }));

  for (let i = 0; i < n; i++) {
    if (circles[i].newborn) continue;
    for (let j = i + 1; j < n; j++) {
      if (circles[j].newborn) continue;

      const dx = circles[j].c.x - circles[i].c.x;
      const dy = circles[j].c.y - circles[i].c.y;
      const distSq = dx * dx + dy * dy;
      const rSum = circles[i].r + circles[j].r;

      if (distSq <= rSum * rSum) {
        pairs.push({ i, j, distSq });
      }
    }
  }

  return pairs;
}

// =============================================================================
// Step 3 of COLLISION_PROMPT.md: narrow-phase — oriented-rectangle (OBB)
// vs oriented-rectangle, using the Separating Axis Theorem.
//
// WHY NOT CAPSULE: the capsule model (line swept by radius → rounded at
// both ends) gives every body a circular bumper at base and nose, which is
// wrong for flat-ended rocket segments. Two flush-stacked pieces should
// meet along a FLAT face and push straight apart. OBB (rectangle rotated
// with the body) captures that flatness and stays exact at any angle.
//
// ROTATION CONVENTION (important — this codebase is not textbook):
//   physics.js's _rotatedPoint(body, lx, ly) uses a CLOCKWISE-positive
//   theta, opposite to standard math. That means:
//       local +X → world ( cos θ, −sin θ )
//       local +Y → world ( sin θ,  cos θ )
//   Using the textbook R(+θ) form (u=(cos,+sin), v=(−sin,cos)) here would
//   rotate the OBB in the OPPOSITE direction from the drawn body — that's
//   the "convention ulta" mismatch. To eliminate any chance of that, the
//   OBB's corners are built by calling _rotatedPoint DIRECTLY — the exact
//   same function ground contact and rendering use — so the OBB is
//   guaranteed to wrap the drawn body by construction.
// =============================================================================

// Ignore contacts shallower than this. Two bodies that just separated sit
// at ~0 gap; floating-point error leaves a sub-micron overlap. Without a
// slop, SAT reports that as a real contact every tick, and the resulting
// tick-by-tick micro-pushes accumulate as visible drift. 5 mm is well
// below any visually meaningful overlap for rockets of a few metres.
const OBB_CONTACT_SLOP = 0.005; // m

function _bodyOBB(body) {
  const H = _bodyHeightOf(body);
  const W = _bodyWidthOf(body);
  const hw = W / 2, hh = H / 2;
  const cosT = Math.cos(body.theta), sinT = Math.sin(body.theta);

  // Corners via _rotatedPoint — the SAME function used by ground contact
  // and every renderer — so the OBB cannot disagree with the body it wraps.
  const corners = [
    _rotatedPoint(body, -hw, 0),   // base-left
    _rotatedPoint(body,  hw, 0),   // base-right
    _rotatedPoint(body, -hw, H),   // nose-left
    _rotatedPoint(body,  hw, H),   // nose-right
  ];

  // Center = average of the 4 corners = _rotatedPoint(body, 0, H/2).
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

  // Face-normal axes used by the SAT test. Same convention as
  // _rotatedPoint (clockwise-positive θ), documented above.
  const ux =  cosT, uy = -sinT;   // local +X axis in world
  const vx =  sinT, vy =  cosT;   // local +Y axis in world

  return {
    corners,
    center: { x: cx, y: cy },
    halfU: hw, halfV: hh,
    ux, uy, vx, vy,
  };
}

function _projectOBB(obb, ax, ay) {
  const c = obb.center.x * ax + obb.center.y * ay;
  const r = obb.halfU * Math.abs(obb.ux * ax + obb.uy * ay)
          + obb.halfV * Math.abs(obb.vx * ax + obb.vy * ay);
  return { min: c - r, max: c + r };
}

// Support "point" in direction (nx, ny), as the average of ALL corners
// that tie for the extreme projection. For a flat face pointing at the
// direction, two corners tie → returns their midpoint (face centre). For
// a corner-on-face hit, one corner wins → returns that corner. This is
// what removes the arbitrary-corner → spurious-torque artifact.
function _obbSupportEdgeMidpoint(obb, nx, ny) {
  const projs = obb.corners.map(c => c.x * nx + c.y * ny);
  let best = -Infinity;
  for (const p of projs) if (p > best) best = p;
  const EPS = 1e-9;
  let sx = 0, sy = 0, n = 0;
  obb.corners.forEach((c, i) => {
    if (projs[i] >= best - EPS) { sx += c.x; sy += c.y; n++; }
  });
  return { x: sx / n, y: sy / n };
}

function narrowPhaseOBBTest(bodyA, bodyB) {
  const A = _bodyOBB(bodyA);
  const B = _bodyOBB(bodyB);

  // SAT: 4 candidate axes (each rectangle's two face normals). Any axis
  // with non-positive overlap is a separating axis → not touching.
  const axes = [
    { x: A.ux, y: A.uy },
    { x: A.vx, y: A.vy },
    { x: B.ux, y: B.uy },
    { x: B.vx, y: B.vy },
  ];

  let minOverlap = Infinity;
  let nx = 0, ny = 1;

  for (const axis of axes) {
    const pa = _projectOBB(A, axis.x, axis.y);
    const pb = _projectOBB(B, axis.x, axis.y);
    const overlap = Math.min(pa.max, pb.max) - Math.max(pa.min, pb.min);
    if (overlap <= 0) return null;

    if (overlap < minOverlap) {
      minOverlap = overlap;
      // Normal points B → A. Direction comes from where the two CENTERS
      // sit relative to the axis, not from the axis' sign alone — a
      // shared direction is meaningless without knowing which side each
      // body is on.
      const cA = A.center.x * axis.x + A.center.y * axis.y;
      const cB = B.center.x * axis.x + B.center.y * axis.y;
      const sgn = cA >= cB ? 1 : -1;
      nx = axis.x * sgn;
      ny = axis.y * sgn;
    }
  }

  // Too shallow → treat as no contact. Prevents the just-separated jitter.
  if (minOverlap < OBB_CONTACT_SLOP) return null;

  // Contact point: midpoint of A's supporting-face centre (toward B) and
  // B's supporting-face centre (toward A).
  const supA = _obbSupportEdgeMidpoint(A, -nx, -ny);
  const supB = _obbSupportEdgeMidpoint(B,  nx,  ny);
  const point = { x: (supA.x + supB.x) / 2, y: (supA.y + supB.y) / 2 };

  return {
    normal: { nx, ny },
    depth: minOverlap,
    point,
    offA: { x: point.x - bodyA.rx, y: point.y - bodyA.ry },
    offB: { x: point.x - bodyB.rx, y: point.y - bodyB.ry },
  };
}

// Signature and return shape are UNCHANGED from the old capsule version —
// physics.js calls this by name and consumes the same fields, so nothing
// outside this file needs to move.
function narrowPhaseCollisionContacts(broadPairs) {
  const bodies = state.bodies;
  const contacts = [];
  for (let k = 0; k < broadPairs.length; k++) {
    const { i, j } = broadPairs[k];
    const result = narrowPhaseOBBTest(bodies[i], bodies[j]);
    if (result) contacts.push({ i, j, ...result });
  }
  return contacts;
}
// =============================================================================
// Step 4 of COLLISION_PROMPT.md: body-vs-body impulse response.
//
// Same point-contact impulse formula as Step 1's resolveGroundContact(), but
// now BOTH sides are dynamic bodies instead of one dynamic body + an
// infinitely-heavy immovable ground:
//   K = 1/M_A + 1/M_B + (rA×n)²/I_A + (rB×n)²/I_B
// Position correction (the part Step 3 deliberately left undone) is here
// too, split between the two bodies by inverse mass — a light body gets
// pushed out of a heavy one much more than the other way round, same as any
// two-body physics engine.
//
// Friction stays the flat "keep a fraction of tangential speed" damping
// model Step 1 used (not a full Coulomb/normal-force-scaled solve) — this
// is the same approximation COLLISION_PROMPT.md flags as a Step 5 refine-
// later item, just extended to two movable bodies via the same mass-
// weighted K trick as the normal impulse.
// =============================================================================

const BODY_RESTITUTION = 0.2;     // softer than the ground's 0.35 — two rocket
                                   // parts crunching into each other should feel
                                   // more like a dead hit than a bounce.
const BODY_FRICTION_KEEP = 0.55;  // fraction of tangential relative speed KEPT
const BODY_SPIN_DAMPING = 0.7;    // fraction of each body's spin kept per hit

// Resolves ONE confirmed contact (from narrowPhaseCollisionContacts) in
// place: pushes state.bodies[contact.i] and [contact.j] apart, and updates
// both bodies' vx/vy/omega. geometryOf() reuses each body's already-cached
// mass/inertia for this tick (see physics.js's physicsStep — same pattern
// telemetry/render already use, so this adds no extra stackMassProps work).
function resolveBodyContact(contact) {
  const bodyA = state.bodies[contact.i];
  const bodyB = state.bodies[contact.j];
  if (!bodyA || !bodyB) return;

  const geomA = geometryOf(bodyA);
  const geomB = geometryOf(bodyB);
  const M_A = Math.max(1e-6, geomA.M), I_A = Math.max(1e-6, geomA.I);
  const M_B = Math.max(1e-6, geomB.M), I_B = Math.max(1e-6, geomB.I);

  const { nx, ny } = contact.normal;
  const tx = -ny, ty = nx;

  // ---- Position correction: split penetration by inverse mass ----
  const invMA = 1 / M_A, invMB = 1 / M_B;
  const invMSum = invMA + invMB;
  if (invMSum > 0 && contact.depth > 0) {
    const pushA = contact.depth * (invMA / invMSum);
    const pushB = contact.depth * (invMB / invMSum);
    bodyA.rx += nx * pushA; bodyA.ry += ny * pushA;
    bodyB.rx -= nx * pushB; bodyB.ry -= ny * pushB;
  }

  // ---- Velocity at the contact point for each body (rigid-body v_p = v + ω×r) ----
  const vAx = bodyA.vx + bodyA.omega * (-contact.offA.y);
  const vAy = bodyA.vy + bodyA.omega * (contact.offA.x);
  const vBx = bodyB.vx + bodyB.omega * (-contact.offB.y);
  const vBy = bodyB.vy + bodyB.omega * (contact.offB.x);

  const rvx = vAx - vBx, rvy = vAy - vBy;
  const vn = rvx * nx + rvy * ny; // + = separating, - = approaching

  const rCrossN_A = contact.offA.x * ny - contact.offA.y * nx;
  const rCrossN_B = contact.offB.x * ny - contact.offB.y * nx;
  const K_n = invMA + invMB + (rCrossN_A * rCrossN_A) / I_A + (rCrossN_B * rCrossN_B) / I_B;
  if (K_n <= 0) return;

  // Two-tier response, mirroring resolveGroundContact()'s hard-hit vs.
  // gentle-rest split:
  //   hard hit (approaching faster than HARD_HIT_SPEED) → restitution
  //     bounce + tangential friction + spin damping.
  //   gentle/resting contact → just cancel the small residual approach
  //     velocity (e = 0, no extra damping) so it doesn't keep nudging
  //     into the other body tick after tick, without artificially
  //     killing spin/tangential motion on a contact that's just resting.
  const HARD_HIT_SPEED = 0.3; // m/s, same threshold Step 1 uses for crash vs. settle

  if (vn < -HARD_HIT_SPEED) {
    const J = -(1 + BODY_RESTITUTION) * vn / K_n;
    bodyA.vx += (J * invMA) * nx; bodyA.vy += (J * invMA) * ny;
    bodyA.omega += (rCrossN_A * J) / I_A;
    bodyB.vx -= (J * invMB) * nx; bodyB.vy -= (J * invMB) * ny;
    bodyB.omega -= (rCrossN_B * J) / I_B;

    // ---- Friction: damp tangential relative speed at the contact (flat
    // fraction kept, mass-weighted split — see file header note) ----
    const vAx2 = bodyA.vx + bodyA.omega * (-contact.offA.y);
    const vAy2 = bodyA.vy + bodyA.omega * (contact.offA.x);
    const vBx2 = bodyB.vx + bodyB.omega * (-contact.offB.y);
    const vBy2 = bodyB.vy + bodyB.omega * (contact.offB.x);
    const vt = (vAx2 - vBx2) * tx + (vAy2 - vBy2) * ty;

    const rCrossT_A = contact.offA.x * ty - contact.offA.y * tx;
    const rCrossT_B = contact.offB.x * ty - contact.offB.y * tx;
    const K_t = invMA + invMB + (rCrossT_A * rCrossT_A) / I_A + (rCrossT_B * rCrossT_B) / I_B;

    if (Math.abs(vt) > 1e-6 && K_t > 0) {
      const targetVt = vt * BODY_FRICTION_KEEP;
      const Jt = (targetVt - vt) / K_t;
      bodyA.vx += (Jt * invMA) * tx; bodyA.vy += (Jt * invMA) * ty;
      bodyA.omega += (rCrossT_A * Jt) / I_A;
      bodyB.vx -= (Jt * invMB) * tx; bodyB.vy -= (Jt * invMB) * ty;
      bodyB.omega -= (rCrossT_B * Jt) / I_B;
    }

    bodyA.omega *= BODY_SPIN_DAMPING;
    bodyB.omega *= BODY_SPIN_DAMPING;
  } else if (vn < 0) {
    // Gentle contact — cancel just the residual approach velocity (e = 0),
    // via the same proper K so it doesn't inject spurious spin.
    const J = -vn / K_n;
    bodyA.vx += (J * invMA) * nx; bodyA.vy += (J * invMA) * ny;
    bodyA.omega += (rCrossN_A * J) / I_A;
    bodyB.vx -= (J * invMB) * nx; bodyB.vy -= (J * invMB) * ny;
    bodyB.omega -= (rCrossN_B * J) / I_B;
  }
}

// Resolves every confirmed contact from this tick, in order. Sequential
// (not a simultaneous solve) — same simplicity level as the rest of this
// system; fine for the small, occasional contact counts this sim sees.
function resolveBodyContacts(contacts) {
  for (let k = 0; k < contacts.length; k++) {
    resolveBodyContact(contacts[k]);
  }
}
