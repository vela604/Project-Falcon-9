// ============================================================================
// tuner-hook.js — per-tick metrics + runEval (Step 3)
//
// runEval(point, opts)        lattice point -> snapped values -> sim -> metrics
// runEvalValues(values, opts) same, but raw values (used for the off-lattice
//                             baseline: lead 5.53 is NOT on the 0.0125 grid)
//
// Both are ASYNC and pure with respect to the caller: everything the search
// needs comes back in the returned metrics object, nothing is read from
// globals afterwards. That is the contract a future worker pool will use
// (one sim instance per worker, jobs = runEval(point, opts)).
//
// Tick pipeline (engine invariant): physicsStep -> buildSnapshot -> onSnapshot
// (TunerEngine.tick). The hook observes the state AFTER the guidance tick.
//
// stopAt:
//   'COAST_WAIT_ENTRY'  first tick phase == COAST_WAIT   (E, (A,bias) search)
//   'CIRC_END'          circ burn finished + engines off  (lead search)
//   'DEPLOY'            payload release command tick
//   'FULL'              payloadCleared (default; scoring / MECO residual)
// Any stopAt also ends on crash / halt / durationCap.
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const G0 = 9.80665;

  // Same math as guidance-blocks.js _timeToApogee (kept 1:1 for margin).
  function timeToApogee(r, vr, vt, GM) {
    if (!(r > 0)) return Infinity;
    const E = 0.5 * (vr * vr + vt * vt) - GM / r;
    if (E >= 0) return Infinity;
    const a = -GM / (2 * E);
    const h = r * vt;
    const eSq = 1 + (2 * E * h * h) / (GM * GM);
    const e = Math.sqrt(Math.max(0, eSq));
    if (e < 1e-9) return Math.PI * Math.sqrt((a * a * a) / GM);
    const cosE = (1 - r / a) / e;
    const sinE = (r * vr) / (e * Math.sqrt(GM * a));
    let Ean = Math.atan2(sinE, cosE);
    if (Ean < 0) Ean += 2 * Math.PI;
    const M = Ean - e * Math.sin(Ean);
    const n = Math.sqrt(GM / (a * a * a));
    if (M < Math.PI) return (Math.PI - M) / n;
    return (3 * Math.PI - M) / n;
  }

  // Osculating two-body elements of a body (same formulas as the page's
  // captureState / final-orbit block). ecc = e from E and h.
  function orbitOf(b, GM, Re) {
    const r = Math.hypot(b.rx, b.ry) || 1;
    const vr = (b.vx * b.rx + b.vy * b.ry) / r;
    const vt = (b.vx * b.ry - b.vy * b.rx) / r;
    const eps = 0.5 * (vr * vr + vt * vt) - GM / r;
    const h = r * vt;
    const e = Math.sqrt(Math.max(0, 1 + 2 * eps * h * h / (GM * GM)));
    let apoKm = Infinity, periKm = Infinity, periodS = Infinity;
    if (eps < 0) {
      const a = -GM / (2 * eps);
      periodS = 2 * Math.PI * Math.sqrt((a * a * a) / GM);
      apoKm = (a * (1 + e) - Re) / 1000;
      periKm = (a * (1 - e) - Re) / 1000;
    } else if (eps > 0) {
      const p = h * h / GM;
      periKm = (p / (1 + e) - Re) / 1000;
    }
    return { r, vr, vt, ecc: e, apoKm, periKm, periodS, altKm: (r - Re) / 1000,
             tToApo: timeToApogee(r, vr, vt, GM) };
  }

  // Time to apogee as a SIGNED margin. timeToApogee() always returns the time to
  // the NEXT apogee, so once the burn ends past apogee (vr < 0) it wraps to ~1
  // period (thousands of s). Signed: vr >= 0 -> +tToApo; vr < 0 -> -(time since
  // apogee) = tToApo - period. Monotone and ~linear in circ lead across apogee.
  function signedMargin(o) {
    if (!(o.vr < 0)) return o.tToApo;
    return Number.isFinite(o.periodS) ? (o.tToApo - o.periodS) : -Infinity;
  }

  function findBooster(bodies) {
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b && !b.payloadBody && !b.fairingHalf && b.members && b.members[0] &&
          b.members[0].stageRole === 'booster') return b;
    }
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b && !b.isActive && !b.payloadBody && !b.fairingHalf) return b;
    }
    return null;
  }

  // G-load, 1:1 from headless hook-sandbox.js gLoad(): vector sum of engine
  // thrust (with gimbal) + drag, divided by (dryMass + fuelMass) * g0.
  // Tracked on state.bodies[0] (the stage) for the WHOLE run, every tick.
  function gLoad(b, Re) {
    const m = (b.dryMass || 0) + (b.fuelMass || 0);
    if (!(m > 0)) return 0;
    const engs = b.engines || [];
    let Fa = 0, Fl = 0;
    for (let i = 0; i < engs.length; i++) {
      const en = engs[i];
      const f = en.currentF || 0;
      if (!f) continue;
      const g = (en.gimbalDeg || 0) * Math.PI / 180;
      Fa += f * Math.cos(g);
      Fl += f * Math.sin(g);
    }
    const ux = -Math.sin(b.theta), uy = Math.cos(b.theta);
    let fx = Fa * ux + Fl * (-uy);
    let fy = Fa * uy + Fl * ux;
    if (typeof airDensity === 'function' && Number.isFinite(CONFIG.DRAG_CD) && b.width > 0) {
      const r = Math.sqrt(b.rx * b.rx + b.ry * b.ry), alt = r - Re;
      const rho = airDensity(Math.max(0, alt));
      if (rho > 0) {
        const sv = earthSurfaceVelocity(b.rx, b.ry);
        const wv = windInertialVector(b.rx, b.ry);
        const rvx = b.vx - (sv.vx + wv.wx), rvy = b.vy - (sv.vy + wv.wy);
        const sp = Math.sqrt(rvx * rvx + rvy * rvy);
        if (sp > 0) {
          const area = Math.PI * (b.width / 2) * (b.width / 2);
          const D = 0.5 * rho * sp * sp * CONFIG.DRAG_CD * area;
          fx -= D * rvx / sp;
          fy -= D * rvy / sp;
        }
      }
    }
    return Math.sqrt(fx * fx + fy * fy) / (m * G0);
  }

  // Stage body (2nd stage), looked up explicitly -- NOT via activeBodyIndex,
  // which points at the payload once it is released/cleared (fuelMass = 0).
  // Same idea as findBooster: split-off body whose members[0] is the stage.
  function findStage(bodies) {
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b && !b.payloadBody && !b.fairingHalf && b.members && b.members[0] &&
          b.members[0].stageRole === 'stage') return b;
    }
    // fallback: any non-payload body that has a stage member but no booster member
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || b.payloadBody || b.fairingHalf || !b.members) continue;
      let hasStage = false, hasBooster = false;
      for (let k = 0; k < b.members.length; k++) {
        const r = b.members[k] && b.members[k].stageRole;
        if (r === 'stage') hasStage = true; else if (r === 'booster') hasBooster = true;
      }
      if (hasStage && !hasBooster) return b;
    }
    const b0 = bodies[0];
    if (b0 && !b0.payloadBody && !b0.fairingHalf && b0.members && b0.members.length &&
        !b0.members.some((x) => x && x.stageRole === 'booster')) return b0;
    return null;
  }

  // Yield without setTimeout's 4 ms nested clamp.
  const _mc = (typeof MessageChannel !== 'undefined') ? new MessageChannel() : null;
  let _mcRes = null;
  if (_mc) _mc.port1.onmessage = () => { const r = _mcRes; _mcRes = null; if (r) r(); };
  function yieldNow() {
    if (_mc) return new Promise((res) => { _mcRes = res; _mc.port2.postMessage(0); });
    return new Promise((res) => setTimeout(res, 0));
  }

  const stats = { evals: 0, ticks: 0, wallMs: 0 };
  let busy = false;

  async function runEvalValues(values, opts) {
    if (busy) throw new Error('runEval re-entered: the sim is a singleton (one eval at a time)');
    busy = true;
    opts = opts || {};
    const Cfg = root.TunerConfig;
    const stopAt = opts.stopAt || 'FULL';
    const env = opts.env || Cfg.env;
    const capS = opts.durationCapS || Cfg.durationCapS;
    const quiet = opts.quiet !== false;
    const abortOnStageVrNeg = opts.abortOnStageVrNeg != null
      ? !!opts.abortOnStageVrNeg : (stopAt === 'COAST_WAIT_ENTRY');
    const abortRef = opts.abortRef || null;
    const origLog = console.log;
    if (quiet) console.log = function () {};

    const m = {
      stopAt, endReason: null, ticks: 0, simTimeEnd: NaN, wallMs: 0,
      crashed: false, payloadReleased: false, payloadCleared: false,
      // ---- (A, bias) signals ----
      vrMinStageBurn: Infinity, stageVrNeg: false, stageVrNegAltKm: NaN, stageVrNegT: NaN,
      eCoast: NaN, apoCoastKm: NaN, periCoastKm: NaN, tToApoCoastS: NaN,
      altCoastKm: NaN, vrCoast: NaN, vtCoast: NaN, coastEntryT: NaN,
      // ---- circ burn signals ----
      vrMin: Infinity,
      vrEnd: NaN, marginS: NaN,                            // engines-off tick; marginS is SIGNED (<0 = ended past apogee). Manual 0.046 / 6.73 s
      marginRawS: NaN, periodEndS: NaN,                    // engOff: wrapped time-to-next-apogee, orbit period (diagnostic)
      vrEndAch: NaN, marginAch: NaN,                       // at circAchieved tick (diagnostic only)
      circStartT: NaN, circAchievedT: NaN, circEngOffT: NaN,
      // ---- mission outputs ----
      deployTimeS: NaN, mecoTimeS: NaN, boosterFuelLeftKg: NaN, stageResidualKg: NaN,
      stageFuelAtDeployKg: NaN,
      apogeeKm: NaN, perigeeKm: NaN, ecc: NaN,
      // ---- hard-constraint trackers ----
      maxQKPa: 0, maxG: 0,                      // maxG = headless gLoad on bodies[0], whole run
      maxGPhase: null, maxGT: NaN, maxGPre: 0,   // where the peak happened / peak before COAST_WAIT
      maxGAccel: 0,                              // diagnostic: |_lastAccel|/g0 on active body
    };

    const t0 = performance.now();
    try {
      root.TunerEngine.prepareRun(Cfg.guideName, values, env);
      if (opts.verifyPoint) {
        const v = root.TunerUtils.verifyApplied(opts.verifyPoint,
          Guidance.getGuideConfig(Cfg.guideName), { targetAltKm: opts.targetAltKm });
        if (!v.ok) throw new Error('snap verify failed: ' + JSON.stringify(v.mismatches));
      }

      const dt = CONFIG.DT, GM = CONFIG.GM_EARTH, Re = CONFIG.EARTH_RADIUS;
      const maxTicks = Math.ceil(capS / dt);
      const haveQ = typeof airDensity === 'function';
      const haveWind = typeof windInertialVector === 'function';
      const haveSurf = typeof earthSurfaceVelocity === 'function';
      const haveGeom = typeof geometryOf === 'function';

      let lastPhase = null;
      let coastWaitSeen = false, mecoSeen = false, splitSeen = false;
      let circWindow = false, circAchSeen = false, engOffSeen = false;
      let deploySeen = false, vrMinCirc = Infinity;
      let lastYield = performance.now();
      let ended = false;
      const end = (reason) => { m.endReason = reason; ended = true; };

      let i = 0;
      for (; i < maxTicks; i++) {
        if (state.halted) { end('HALTED'); break; }
        if (abortRef && abortRef.aborted) { end('ABORTED'); break; }

        root.TunerEngine.tick(dt);

        if (state.crashed) { m.crashed = true; end('CRASHED'); i++; break; }

        {
          const b0 = state.bodies[0];
          if (b0) {
            const gL = gLoad(b0, Re);
            if (gL > m.maxG) { m.maxG = gL; m.maxGPhase = lastPhase; m.maxGT = state.simTime; }
            if (!coastWaitSeen && gL > m.maxGPre) m.maxGPre = gL;
          }
        }
        const b = state.bodies[state.activeBodyIndex];
        if (!b) continue;
        const rx = b.rx, ry = b.ry;
        const r = Math.sqrt(rx * rx + ry * ry) || 1;
        const vr = (b.vx * rx + b.vy * ry) / r;
        const altM = r - Re;

        // ---- maxQ (only where air matters) / maxG (active body) ----
        if (haveQ && altM < 100000) {
          const wv = haveWind ? windInertialVector(rx, ry) : { wx: 0, wy: 0 };
          const sv = haveSurf ? earthSurfaceVelocity(rx, ry) : { vx: 0, vy: 0 };
          const relVx = b.vx - (wv.wx + sv.vx), relVy = b.vy - (wv.wy + sv.vy);
          const rho = airDensity(Math.max(0, altM));
          const q = 0.5 * rho * (relVx * relVx + relVy * relVy);
          if (q > m.maxQKPa) m.maxQKPa = q;           // Pa for now, /1000 at the end
        }
        // diagnostic only (active body, physics accel)
        const gA = Math.hypot(b._lastAccelX || 0, b._lastAccelY || 0) / G0;
        if (gA > m.maxGAccel) m.maxGAccel = gA;

        // ---- phase polling (sparse in ASCENT / COAST_WAIT, every tick else) ----
        let gs = null;
        if (!((lastPhase === 'ASCENT' || lastPhase === 'COAST_WAIT') && (i & 15) !== 0)) {
          gs = Guidance.getGuideStatus();
        }
        if (gs) {
          const ph = gs.phase;
          if (ph !== lastPhase) {
            if (ph === 'COAST_WAIT' && !coastWaitSeen) {
              coastWaitSeen = true;
              const o = orbitOf(b, GM, Re);
              m.eCoast = o.ecc; m.apoCoastKm = o.apoKm; m.periCoastKm = o.periKm;
              m.tToApoCoastS = o.tToApo; m.altCoastKm = o.altKm; m.vrCoast = o.vr; m.vtCoast = o.vt;
              m.coastEntryT = state.simTime;
              if (stopAt === 'COAST_WAIT_ENTRY') { end('COAST_WAIT_ENTRY'); i++; break; }
            }
            if (ph === 'CIRCULARIZE' && !circWindow && !circAchSeen) {
              circWindow = true; m.circStartT = state.simTime;
            }
            lastPhase = ph;
          }
          if (!mecoSeen && gs.mecoTriggered) { mecoSeen = true; m.mecoTimeS = state.simTime; }
          if (!splitSeen && gs.splitDetected) {
            splitSeen = true;
            const bo = findBooster(state.bodies);
            if (bo) m.boosterFuelLeftKg = bo.fuelMass;
          }
          if (gs.circAchieved && !circAchSeen) {
            circAchSeen = true;
            const o = orbitOf(b, GM, Re);
            m.vrEndAch = o.vr; m.marginAch = o.tToApo; m.circAchievedT = state.simTime;  // raw, diagnostic
          }
          if (!deploySeen && gs.deployCommandSimTime != null) {
            deploySeen = true;
            m.deployTimeS = gs.deployCommandSimTime;
            { const st = findStage(state.bodies); m.stageFuelAtDeployKg = st ? st.fuelMass : NaN; }
            if (stopAt === 'DEPLOY') { end('DEPLOY'); i++; break; }
          }
          if (gs.payloadCleared) {
            m.payloadCleared = true;
            { const st = findStage(state.bodies); m.stageResidualKg = st ? st.fuelMass : NaN; }
            end('CLEARED'); i++; break;
          }
        }

        // ---- per-tick signals gated on the (possibly stale) phase ----
        if (lastPhase === 'STAGE_BURN') {
          if (vr < m.vrMinStageBurn) m.vrMinStageBurn = vr;
          if (vr < 0 && !m.stageVrNeg) {
            m.stageVrNeg = true; m.stageVrNegAltKm = (altM) / 1000; m.stageVrNegT = state.simTime;
            if (abortOnStageVrNeg) { end('STAGE_VR_NEG'); i++; break; }
          }
        }
        if (circWindow) {
          if (vr < vrMinCirc) vrMinCirc = vr;
          if (circAchSeen && !engOffSeen) {
            let mdot = 0;
            const en = b.engines;
            if (en) for (let k = 0; k < en.length; k++) mdot += en[k].massFlowRate || 0;
            if (mdot <= 1e-9) {
              engOffSeen = true; circWindow = false;
              const o = orbitOf(b, GM, Re);
              m.vrEnd = o.vr; m.marginS = signedMargin(o); m.marginRawS = o.tToApo; m.periodEndS = o.periodS; m.circEngOffT = state.simTime;
              if (stopAt === 'CIRC_END') { end('CIRC_END'); i++; break; }
            }
          }
        }

        // ---- cooperative yield (time-sliced, no per-chunk clamp) ----
        if ((i & 255) === 255) {
          const now = performance.now();
          if (now - lastYield > 40) {
            if (opts.onProgress) opts.onProgress({ simTime: state.simTime, ticks: i, phase: lastPhase });
            await yieldNow();
            lastYield = performance.now();
          }
        }
      }
      if (!ended) end('CAP');
      m.ticks = i;
      m.simTimeEnd = state.simTime;
      m.vrMin = vrMinCirc;
      m.maxQKPa = m.maxQKPa / 1000;
      m.crashed = m.crashed || !!state.crashed;

      // payload present? final orbit = payload body (mission-graded orbit)
      const pb = state.bodies.find((x) => x && x.payloadBody);
      m.payloadReleased = !!pb;
      if (pb) {
        const o = orbitOf(pb, GM, Re);
        m.apogeeKm = o.apoKm; m.perigeeKm = o.periKm; m.ecc = o.ecc;
      }
      try { Guidance.stopGuide(); } catch (e) {}
    } finally {
      console.log = origLog;
      m.wallMs = performance.now() - t0;
      stats.evals++; stats.ticks += m.ticks; stats.wallMs += m.wallMs;
      busy = false;
    }
    m.ticksPerSecond = m.ticks / Math.max(m.wallMs / 1000, 1e-9);
    return m;
  }

  // Lattice-point entry: snap -> values -> verify applied -> run.
  function runEval(point, opts) {
    opts = Object.assign({}, opts);
    const alt = opts.targetAltKm != null ? opts.targetAltKm : root.TunerConfig.fixed.targetAltKm;
    opts.targetAltKm = alt;
    opts.verifyPoint = point;
    return runEvalValues(root.TunerUtils.toValues(point, { targetAltKm: alt }), opts);
  }

  root.TunerHook = { runEval, runEvalValues, orbitOf, timeToApogee, stats };
})();
