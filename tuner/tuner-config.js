// ============================================================================
// tuner-config.js — constants only (no logic). Source of truth: prompt-web.md
// + tuner-config-v3.json. Values marked PROVISIONAL get calibrated in Step 4.
// ============================================================================
(function () {
  'use strict';

  const TunerConfig = {
    guideName: 'leoInsertionV3',
    durationCapS: 770,              // safety cap; early stop at payload clear
    simDt: 1 / 80,                  // CONFIG.DT (read from CONFIG at runtime too)

    // ---- Hardware quanta (least counts) ----
    quanta: {
      G: 0.01,                      // PUSH_MAX_GIMBAL_DEG, deg
      T: 0.000125,                  // PUSH_T_S, s (search on integer Tn)
      bias: 0.0001,                 // STAGE_BURN_AOA_BIAS_DEG, deg (4 decimals)
      lead: 0.0125,                 // CIRC_TRIGGER_LEAD_S, s = 1 tick (integer ticks)
      meco: 1,                      // MECO_TARGET_BOOSTER_FUEL_KG, kg (integer)
    },
    T0: 4.82,                       // anchor T for G_raw = A / T0^2

    // ---- Search bounds (PROVISIONAL, from tuner-config-v3.json) ----
    bounds: {
      A:    { lower: 9,      upper: 20 },
      bias: { lower: -2,     upper: 2.5 },
      lead: { lower: 0,      upper: 20 },
      meco: { lower: 0,      upper: 110000 },
    },

    // ---- Fixed (mission definition, not tunable) ----
    fixed: {
      margin: 0.001,            // STAGE_BURN_AOA_MARGIN_DEG — fixed, never tuned (decided)
      deorbitEnabled: false,    // done.DEORBIT_ENABLED
      targetAltKm: 320,         // default; UI overrides
    },

    // ---- Baseline (raw defaults; reproduces manual 590.46 s run) ----
    baselineRaw:     { G: 0.60, T: 4.82, bias: 0.59, lead: 5.53,  meco: 52612 },
    baselineSnapped: { A: 13.94, bias: 0.59, lead: 5.525,         meco: 52612 }, // success-criteria #6
    baselineResult: {
      deployTimeS: 590.46, apogeeKm: 320.111, perigeeKm: 319.999,
      vrEnd: 0.046, vrMin: -0.380, marginS: 6.73, maxQKPa: 24.75, maxG: 4.815,
    },
    // Warm-start reference points (trend: MECO up => bias up => lead down)
    // Each ref = a manually-tuned feasible point. `alt` = target altitude (km). `T` defaults to T0 if missing.
references: [
  { meco: 50000, G: 0.62, T: 4.82, bias: 0.78, lead: 5.65, alt: 320 },
  { meco: 52612, G: 0.60, T: 4.82, bias: 0.59, lead: 5.53, alt: 320 },
  { meco: 55000, G: 0.60, T: 4.82, bias: 1.16, lead: 4.46, alt: 320 },
  { meco: 0, G: 0.65, T: 4.82, bias: 0.59, lead: 7.82, alt: 2000 }, // manual 2000 km point (booster fully drained)
],

    // DEPRECATED (Step Δv 1/4): E is no longer the search signal. Search uses coastDeltaV
// (see limits.coastDeltaVbandMps). ecc weights in scoring.eccentricity are UNCHANGED —
// ecc is still scored, just not searched toward.
ecc: {
  sweepRange: [0.25, 0.35],   // DEPRECATED — reference only
  eMin: null, eMax: null,     // DEPRECATED
  manualBestE: 0.171,         // DEPRECATED — historical reference
},

    // ---- Hard limits ----
    limits: {
      maxQKPa: 31, maxG: 6.02,
      vrEndMinMps: 0,               // sign check only (vrEnd >= 0)
      vrMinHardFloorMps: -2,        // PROVISIONAL
      vrEndBufferMps: [0.02, 0.05], // heuristic buffer (not 0)
      marginTargetS: [3.5, 5.5],    // widened (Step 6): 1 tick ~ 1.4 s of margin, [4,5] fits no tick
      residualTargetKg: [100, 200],          // stage residual band, deorbit OFF (empirical: [0,50] empties the stage -> deploy +84 s)
      residualTargetDeorbitOnKg: [500, 600], // deorbit ON / suicide burn: fuel reserve (used when fixed.deorbitEnabled)
      residualPhaseAFrac: 0.5,               // Phase A (runTuner) aims into the UPPER part of the band: [lo+frac*w, hi] -> room for Phase B
        coastApoTolKm: 1, // apo at COAST_WAIT must be >= targetAlt - tol (else Fail2)
    coastDeltaVbandMps: [750, 850], // Step Δv 1/4 — soft target band, universal across altitudes
    coastDeltaVguardMps: [700, 900], // wide guard (informational only — NOT wired into checkHard, see tuner-utils note)
  },

    // ---- Scoring (lower = better) ----
    scoring: {
      failPenalty: 1e6,
      // Orbit (apo AND peri, each): tolerance is RELATIVE to target altitude — used as the REFERENCE SCALE, not a deadzone.
// tolFrac 0.001 = 0.1% of alt (0.32 km @320, 1 km @1000). Same penalty for the same RELATIVE error (0.64@320 == 2@1000).
// Penalty = pseudo-Huber on e = |err| / tol  (NO deadzone: only 0 error gives 0 penalty):
//   penalty = weight * k * (sqrt(1 + (e/k)^2) - 1)     // quadratic near 0, linear far
// @320 km: 0.05 km -> 3 | 0.15 -> 27 | 0.32 (tol) -> 104 | 0.5 -> 344 | 1 km -> 570 | 5 km -> 3650
orbit: { tolFrac: 0.001, weight: 250, k: 1 },
      eccentricity: { target: 0, tol: 0.0005, scale: 0.001, weight: 1500 },   // unchanged
      boosterFuelLeftKgWeight: 0.01,   // 15000 kg range = 150 pts
      timeToDeploySWeight: 0.1,        // 600 s = 60 pts; 100 s = 10 pts
    },

    // ---- MECO outer loop ----
    meco: { start: 52612, stepLadderKg: [4000, 1000, 200],
        gQuantumKg: 97.3,          // stage residual change per 0.01 G (real log: G .60 -> .59 = 849.4 -> 752.1)
        gBiasDegPerQ: 0.55,        // bias moves ~0.52-0.6 deg per G quantum (same direction as G)
        slopePrior: -0.05,         // kg residual per kg MECO when no 2 points yet (real curve: -0.08 .. -0.03)
        maxGDrops: 3,
probeStartKg: 20000,      // every run probes MECO at this value first (rough tune). If it fails → MECO fixed at fixedFallbackKg, no MECO search.
fixedFallbackKg: 0 },     // fallback MECO when probe fails (booster drained: only option for high orbits)

    // ---- Accuracy modes (first cut — tuned in Step 10) ----
    // Steps are multiples of quanta. G in gimbal quanta, T in Tn quanta,
    // lead in ticks, bias in deg.
    modes: {
      // candidates = how many (A,bias) candidates tuneAB verifies with tuneLead + FULL eval
      fast:     { gStep: 5, tStep: 5, biasStep: 0.05,  leadTicks: 8, eSamples: 5,  adaptive: false, candidates: 1, tPhaseSteps: [] },
      fine:     { gStep: 1, tStep: 2, biasStep: 0.01,  leadTicks: 3, eSamples: 8,  adaptive: false, candidates: 2, tPhaseSteps: [80, 40] },
      accurate: { gStep: 1, tStep: 1, biasStep: 0.001, leadTicks: 1, eSamples: 12, adaptive: true,  candidates: 3, tPhaseSteps: null /* null = whole T ladder */ },
    },

    // ---- Default environment (UI overrides in Step 9) ----
    env: {
      atmosphere: true, slosh: true, imu: false,
      wind: { enabled: false, speed: 0, directionDeg: 0 },
      boosterPct: 100, stagePct: 100,
    },
  };

  window.TunerConfig = TunerConfig;
})();
