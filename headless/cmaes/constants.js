// ============================================================================
// constants.js — All tunable-free magic numbers for the CMA-ES hybrid tuner.
// Edit this file, not the orchestrator.
// ============================================================================

module.exports = {
  
  // ---------------- Mission target ----------------
  TARGET_ORBIT_ALT_KM: 320,
  
  // ---------------- Stage fuel residual targets ----------------
  // Residual stage fuel (kg) AFTER payload has been ejected, i.e.
  // what's left in the upper-stage tank once the mission ends.
  STAGE_FUEL_TARGET_SUICIDE_OFF_KG: 25, // mid of [0, 50]
  STAGE_FUEL_TARGET_SUICIDE_ON_KG: 400,
  STAGE_FUEL_TOLERANCE_KG: 25,
  
  // ---------------- Circularize end condition ----------------
  // At circ-burn spool-out, we want the next apogee to be this many
  // seconds away. This absorbs coast-rotate-2 + coast-hold-2 so that
  // payload eject fires right at the following apogee.
  CIRC_BURN_END_LEAD_TO_APOGEE_S: 4.0,
  // During the entire circ burn, radial velocity must never drop below
  // this. 0 = must stay ≥ 0 strictly.
  V_RADIAL_MIN_MPS: 0,
  
  // ---------------- Hard constraints (fail → penalty) ----------------
  MAX_G_FORCE: 6.0,
  MAX_DYNAMIC_PRESSURE_KPA: 60,
  
  // ---------------- Hardware least-count (rounding) ----------------
  GIMBAL_ROUND_DEG: 0.01,
  TIME_ROUND_S: 0.01,
  MECO_FUEL_ROUND_KG: 1,
  AOA_BIAS_ROUND_DEG: 0.1, // search-level rounding
  AOA_MARGIN_ROUND_DEG: 0.001, // search-level rounding
  
  // ---------------- CMA-ES ----------------
  CMAES_POP_SIZE: 16,
  CMAES_SIGMA0: 0.25,
  CMAES_MAX_GEN_PER_PHASE: 100,
  CMAES_STOP_TOLX: 1e-4,
  CMAES_STOP_TOLFUN: 1e-4,
  
  // ---------------- Phase 6 convergence ----------------
  // Relative score improvement (fraction) below which we consider the
  // phase converged. 0.05 = 5%.
  PHASE6_PLATEAU_THRESHOLD: 0.05,
  
  // ---------------- Initial anchors (from V3 code defaults) ----------------
  INITIAL_PUSH_T_S: 4.82,
  INITIAL_PUSH_MAX_GIMBAL_DEG: 0.60,
  INITIAL_AOA_BIAS_DEG: 0.59,
  INITIAL_AOA_MARGIN_DEG: 0.001,
  INITIAL_CIRC_LEAD_S: 5.53,
  INITIAL_MECO_FUEL_TARGET_KG: 52612,
  
  // ---------------- Score weights ----------------
  // Applied AFTER hard constraints pass.
  SCORE_SUCCESS_BONUS: 100000,
  SCORE_ORBIT_ERROR_WEIGHT: 100.0,
  SCORE_BOOSTER_FUEL_LEFT_WEIGHT: 0.05,
  SCORE_TIME_TO_DEPLOY_WEIGHT: 0.02,
  
  // ---------------- Penalty ----------------
  HARD_CONSTRAINT_PENALTY: -1e9,
  
};