// ============================================================================
// headless/tuner/hook-sandbox.js
//
// This file is NOT require()d. evaluator.js reads it as TEXT and passes it to
// runSim() as `extraBootstrapCode`, so it executes INSIDE the sim's vm context,
// appended after the bootstrap (same script scope: CONFIG, Guidance, state,
// airDensity, earthSurfaceVelocity ... are all visible).
//
// Contract with runner.js (see step()):
//   globalThis.__tickHook(state, tracker)  - called once per physics tick
//   globalThis.__stopWhen(state, tracker)  - truthy => runner stops early
//   globalThis.__hookReset()               - called by runSim before each run
//   globalThis.__hookMetrics()             - returns plain-JSON metrics
//   globalThis.__hookOpts                  - set by runSim(hookOptions) per run
//
// hookOptions:
//   stopAt        'payloadCleared' | 'coastRotate' | null   (default null)
//   stride        guidance-status polling stride in ticks   (default 4)
//   flowThreshKgS engines-off threshold for circ burn       (default 1)
//   doneGraceS    stop this long after DONE phase if payload never cleared (30)
//
// Everything is deterministic and uses only sim state, so metrics are
// bit-reproducible. Guidance.getGuideStatus() is polled (not every tick) to
// keep overhead low; inside / just before the CIRCULARIZE window it is polled
// every tick so burn start / end are tick-exact.
// ============================================================================
(function () {
  var TWO_PI = 2 * Math.PI;
  var G0 = 9.80665;
  var MU = CONFIG.GM_EARTH;
  var RE = CONFIG.EARTH_RADIUS;

  var M = null;

  function freshMetrics() {
    return {
      dt: CONFIG.DT,
      ticks: 0,
      simT: 0,
      curPhase: null,
      phaseT: {},                 // phase name -> first sim time seen
      deadReason: null,           // set if mission ended abnormally
      stopReason: null,

      maxGLoad: 0, maxGLoadT: null,        // own G-load (thrust+drag)/(m*g0), body 0
      maxAccelRawG: 0,                     // sim's _lastAccel (diagnostic only)
      rawPeak: null, ownPeak: null,        // details at the tick of the max raw / own G (mass, thrust, implied mass)
      gSeries: [],                         // [t, ownG, rawG, altKm] once per sim-second (G sanity check)
      stageMaxAltKm: 0,
      stageCrashed: false,
      anyCrashed: false,

      split: null,                // {t, boosterFuelKg, stageFuelKg}
      mecoT: null,
      coast: null,                // orbit + fuel at COAST_ROTATE entry
      circ: {
        entered: null,
        burnStartT: null, burnEndT: null,
        vrBurnMin: null, vrMinT: null, vrAtEnd: null, vrPhaseMin: null,
        tToApoAtEndS: null,       // time to apogee of the POST-burn orbit
        tToPreBurnApoAtEndS: null,// time until vehicle reaches the PRE-burn apogee direction
        endApoKm: null, endPeriKm: null, endE: null,
        preApoDirX: null, preApoDirY: null
      },
      deploy: null,               // orbit of stage at deploy command
      cleared: null,              // {t, stageFuelKg, stageOrbit, payloadOrbit}
      guideLeadS: null
    };
  }

  // ---- Orbital elements from inertial state (2-D) --------------------------
  function elements(rx, ry, vx, vy) {
    var r = Math.sqrt(rx * rx + ry * ry);
    var v2 = vx * vx + vy * vy;
    var rv = rx * vx + ry * vy;
    var h = rx * vy - ry * vx;
    var hAbs = Math.abs(h);
    var vr = rv / r;
    var eps = v2 / 2 - MU / r;
    var k = v2 - MU / r;
    var ex = (k * rx - rv * vx) / MU;
    var ey = (k * ry - rv * vy) / MU;
    var e = Math.sqrt(ex * ex + ey * ey);
    var out = {
      r: r, vr: vr, h: h, e: e, ex: ex, ey: ey,
      bound: eps < 0,
      apoKm: null, periKm: null, a: null, tToApo: null, period: null,
      altKm: (r - RE) / 1000
    };
    if (!(eps < 0)) return out;
    var a = -MU / (2 * eps);
    out.a = a;
    out.apoKm = (a * (1 + e) - RE) / 1000;
    out.periKm = (a * (1 - e) - RE) / 1000;
    // True anomaly: e sin(nu) = vr*h/mu ; e cos(nu) = h^2/(mu r) - 1
    var nu = Math.atan2(vr * hAbs / MU, hAbs * hAbs / (MU * r) - 1);
    var E = 2 * Math.atan2(Math.sqrt(Math.max(0, 1 - e)) * Math.sin(nu / 2),
                           Math.sqrt(1 + e) * Math.cos(nu / 2));
    var Mn = E - e * Math.sin(E);
    var n = Math.sqrt(MU / (a * a * a));
    var dM = Math.PI - Mn;
    dM = ((dM % TWO_PI) + TWO_PI) % TWO_PI;
    out.tToApo = dM / n;
    out.period = TWO_PI / n;
    return out;
  }

  function bodyElements(b) { return elements(b.rx, b.ry, b.vx, b.vy); }

  function pubOrbit(el) {
    return { apoKm: el.apoKm, periKm: el.periKm, e: el.e, vr: el.vr, altKm: el.altKm, bound: el.bound };
  }

  // ---- G-load (non-gravitational accel / g0) --------------------------------
  // runner's tracker.maxG is known-bad, so compute our own for body 0:
  //   thrust vector (sum of currentF, resolved with gimbal) + drag vector.
  // Drag uses frontal area pi*(width/2)^2 and CONFIG.DRAG_CD (approximation;
  // thrust dominates). Verified in Step 3 against liftoff / MECO expectations.
  function gLoad(b, st) {
    var m = (b.dryMass || 0) + (b.fuelMass || 0);
    if (!(m > 0)) return 0;
    var engs = b.engines || [];
    var Fa = 0, Fl = 0;
    for (var i = 0; i < engs.length; i++) {
      var en = engs[i];
      var f = en.currentF || 0;
      if (!f) continue;
      var g = (en.gimbalDeg || 0) * Math.PI / 180;
      Fa += f * Math.cos(g);
      Fl += f * Math.sin(g);
    }
    var ux = -Math.sin(b.theta), uy = Math.cos(b.theta);
    var fx = Fa * ux + Fl * (-uy);
    var fy = Fa * uy + Fl * ux;
    if (typeof airDensity === 'function' && Number.isFinite(CONFIG.DRAG_CD) && b.width > 0) {
      var r = Math.sqrt(b.rx * b.rx + b.ry * b.ry);
      var alt = r - RE;
      var rho = airDensity(Math.max(0, alt));
      if (rho > 0) {
        var sv = (typeof earthSurfaceVelocity === 'function') ? earthSurfaceVelocity(b.rx, b.ry) : { vx: 0, vy: 0 };
        var wv = (typeof windInertialVector === 'function') ? windInertialVector(b.rx, b.ry) : { wx: 0, wy: 0 };
        var rvx = b.vx - (sv.vx + wv.wx), rvy = b.vy - (sv.vy + wv.wy);
        var sp = Math.sqrt(rvx * rvx + rvy * rvy);
        if (sp > 0) {
          var area = Math.PI * (b.width / 2) * (b.width / 2);
          var D = 0.5 * rho * sp * sp * CONFIG.DRAG_CD * area;
          fx -= D * rvx / sp;
          fy -= D * rvy / sp;
        }
      }
    }
    return Math.sqrt(fx * fx + fy * fy) / (m * G0);
  }

  function peakInfo(b, gl, raw, t) {
    var engs = b.engines || [], F = 0;
    for (var i = 0; i < engs.length; i++) F += engs[i].currentF || 0;
    var m = (b.dryMass || 0) + (b.fuelMass || 0);
    var rc = false;
    if (b.rcsCmd) for (var k in b.rcsCmd) if (b.rcsCmd[k]) { rc = true; break; }
    return { t: t, own: gl, raw: raw, thrustN: F, massKg: m, dryKg: b.dryMass, fuelKg: b.fuelMass,
             impliedMassKg: raw > 0.05 ? F / (raw * G0) : null, flowKgS: totalFlow(b), rcsCmdActive: rc || !!b.rcsDuty };
  }

  function totalFlow(b) {
    var engs = b.engines || [];
    var s = 0;
    for (var i = 0; i < engs.length; i++) s += engs[i].massFlowRate || 0;
    return s;
  }

  function isBooster(b) {
    var mem = b && b.members;
    if (!mem) return false;
    for (var i = 0; i < mem.length; i++) if (mem[i] && mem[i].stageRole === 'booster') return true;
    return false;
  }

  function findPayloadBody(bodies) {
    for (var i = 1; i < bodies.length; i++) if (bodies[i] && bodies[i].payloadBody) return bodies[i];
    return null;
  }

  function opts() { return globalThis.__hookOpts || {}; }

  // ---- Guidance status processing --------------------------------------------
  function onPhaseEnter(ph, b0, simT) {
    if (M.phaseT[ph] === undefined) M.phaseT[ph] = simT;
    if (ph === 'COAST_ROTATE' && !M.coast) {
      var el = bodyElements(b0);
      var o = pubOrbit(el);
      o.t = simT; o.stageFuelKg = b0.fuelMass;
      M.coast = o;
    }
    if (ph === 'CIRCULARIZE' && M.circ.entered === null) M.circ.entered = simT;
  }

  function poll(st, b0) {
    var s = Guidance.getGuideStatus();
    var simT = st.simTime;
    var ph = s && s.phase;
    if (ph && ph !== M.curPhase) {
      M.curPhase = ph;
      onPhaseEnter(ph, b0, simT);
      if (ph === '?') M.deadReason = 'guide_ended_abnormally';
    }
    if (s) {
      if (M.mecoT === null && s.mecoTriggered) M.mecoT = simT;
      if (Number.isFinite(s.circTriggerLeadS)) M.guideLeadS = s.circTriggerLeadS;
      if (M.deploy === null && Number.isFinite(s.deployCommandSimTime)) {
        var el = bodyElements(b0);
        var d = pubOrbit(el);
        d.cmdT = s.deployCommandSimTime;
        d.stageFuelKg = b0.fuelMass;
        d.guideApoKm = Number.isFinite(s.apogeeKm) ? s.apogeeKm : null;
        d.guidePeriKm = Number.isFinite(s.perigeeKm) ? s.perigeeKm : null;
        M.deploy = d;
      }
      if (M.cleared === null && s.payloadCleared) {
        var so = bodyElements(b0);
        var pb = findPayloadBody(st.bodies);
        M.cleared = {
          t: simT,
          stageFuelKg: b0.fuelMass,
          stageOrbit: pubOrbit(so),
          payloadOrbit: pb ? pubOrbit(bodyElements(pb)) : null
        };
      }
    }
  }

  // ---- Circularize-burn tracking (tick-exact) ---------------------------------
  function circTracking() {
    return M.curPhase === 'CIRCULARIZE' || (M.circ.burnStartT !== null && M.circ.burnEndT === null);
  }

  function trackCirc(st, b0) {
    var c = M.circ;
    var thr = Number.isFinite(opts().flowThreshKgS) ? opts().flowThreshKgS : 1;
    var flow = totalFlow(b0);
    var el = bodyElements(b0);
    if (M.curPhase === 'CIRCULARIZE') {
      if (c.vrPhaseMin === null || el.vr < c.vrPhaseMin) c.vrPhaseMin = el.vr;
    }
    if (c.burnStartT === null) {
      if (M.curPhase === 'CIRCULARIZE' && flow > thr) {
        c.burnStartT = st.simTime;
        var e = el.e;
        if (e > 1e-9) { c.preApoDirX = -el.ex / e; c.preApoDirY = -el.ey / e; }
        c.vrBurnMin = el.vr; c.vrMinT = st.simTime;
      }
      return;
    }
    if (c.burnEndT !== null) return;
    if (el.vr < c.vrBurnMin) { c.vrBurnMin = el.vr; c.vrMinT = st.simTime; }
    if (flow < thr) {
      c.burnEndT = st.simTime;
      c.vrAtEnd = el.vr;
      c.tToApoAtEndS = el.tToApo;
      c.endApoKm = el.apoKm; c.endPeriKm = el.periKm; c.endE = el.e;
      if (c.preApoDirX !== null) {
        // angle (in direction of motion) from current position to the PRE-burn apogee direction
        var rx = b0.rx / el.r, ry = b0.ry / el.r;
        var cross = rx * c.preApoDirY - ry * c.preApoDirX;
        var dot = rx * c.preApoDirX + ry * c.preApoDirY;
        var ang = Math.atan2(cross, dot);
        if (el.h < 0) ang = -ang;
        var rate = Math.abs(el.h) / (el.r * el.r);
        c.tToPreBurnApoAtEndS = ang / rate;   // >0: apogee still ahead; <0: already passed
      }
    }
  }

  // ---- Hook entry points -------------------------------------------------------
  globalThis.__hookReset = function () { M = freshMetrics(); };
  globalThis.__hookReset();

  globalThis.__tickHook = function (st, tracker) {
    if (!M) globalThis.__hookReset();
    M.ticks++;
    var simT = st.simTime;
    M.simT = simT;
    var bodies = st.bodies;
    var b0 = bodies[0];
    if (!b0) return;
    var o = opts();

    // G-load, altitude, crash (body 0 = the stack / the stage)
    var gl = gLoad(b0, st);
    var ax = b0._lastAccelX || 0, ay = b0._lastAccelY || 0;
    var raw = Math.sqrt(ax * ax + ay * ay) / G0;
    if (gl > M.maxGLoad) { M.maxGLoad = gl; M.maxGLoadT = simT; M.ownPeak = peakInfo(b0, gl, raw, simT); }
    if (raw > M.maxAccelRawG) { M.maxAccelRawG = raw; M.rawPeak = peakInfo(b0, gl, raw, simT); }
    if ((M.ticks % 80) === 1) M.gSeries.push([simT, gl, raw, (Math.sqrt(b0.rx * b0.rx + b0.ry * b0.ry) - RE) / 1000]);
    var altKm = (Math.sqrt(b0.rx * b0.rx + b0.ry * b0.ry) - RE) / 1000;
    if (altKm > M.stageMaxAltKm) M.stageMaxAltKm = altKm;
    if (b0.crashed) M.stageCrashed = true;
    if (!M.anyCrashed) {
      for (var i = 0; i < bodies.length; i++) if (bodies[i] && bodies[i].crashed) { M.anyCrashed = true; break; }
    }

    // Stage separation: record booster fuel at the split tick (== MECO fuel).
    if (M.split === null && bodies.length > 1) {
      var bo = null;
      for (var j = 1; j < bodies.length; j++) if (isBooster(bodies[j])) { bo = bodies[j]; break; }
      if (!bo) bo = bodies[1];
      M.split = { t: simT, boosterFuelKg: bo.fuelMass, stageFuelKg: b0.fuelMass };
    }

    // Guidance status: stride-polled, tick-exact around circ burn.
    var stride = Number.isFinite(o.stride) && o.stride >= 1 ? o.stride : 4;
    if (circTracking() || (M.ticks % stride) === 0) poll(st, b0);
    if (circTracking()) trackCirc(st, b0);
  };

  globalThis.__stopWhen = function (st, tracker) {
    if (!M) return false;
    var o = opts();
    if (M.stageCrashed) { M.stopReason = 'crashed'; return true; }
    if (M.deadReason) { M.stopReason = M.deadReason; return true; }
    if (o.stopAt === 'coastRotate' && M.coast) { M.stopReason = 'coastRotate'; return true; }
    if (M.cleared) {
      // Full evals stop once the payload is cleared. A circ burn that is
      // still spooling down is irrelevant here (burn ended long before deploy).
      if (o.stopAt === 'payloadCleared') { M.stopReason = 'payloadCleared'; return true; }
    }
    if (M.phaseT.DONE !== undefined) {
      var grace = Number.isFinite(o.doneGraceS) ? o.doneGraceS : 30;
      if (st.simTime - M.phaseT.DONE > grace) { M.stopReason = 'done_grace'; return true; }
    }
    return false;
  };

  globalThis.__hookMetrics = function () {
    return JSON.parse(JSON.stringify(M));
  };
})();
