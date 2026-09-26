// ============================================================================
// guideConfigDefaults.js — Code-resident default presets + important-field
// lists for every guidance with tunable constants.
//
// TWO PURPOSES:
//
//   1. GUIDE_DEFAULT_PRESETS — the baseline "code default" for each guide.
//      Frozen (never written to localStorage). Users can COPY these into
//      their own preset space, but can't edit or delete them. Anywhere the
//      UI shows a "Default preset" it's one of these objects.
//
//   2. GUIDE_IMPORTANT_FIELDS — the curated short list of constants per
//      guide that meaningfully change mission behaviour (target orbit,
//      gravity-turn timings, key tilts). The UI (sim panel, presets page,
//      tester) shows these at the TOP under an "Important" header, then
//      the rest of the schema below grouped by parent key. Path syntax
//      for nested values uses dot notation: 'ASCENT.PUSH_T_S'.
//
// The values here MUST mirror the live code defaults exactly at load time
// — a stale value here means a "Reset to default" in the UI would restore
// the wrong numbers. When a config constant changes in guidance.js, this
// file must be updated in the same commit.
// ============================================================================

const GUIDE_DEFAULT_STACK_ID   = 'stk_falcon9-default';
const GUIDE_DEFAULT_STACK_NAME = 'Falcon 9 Block 5';

// ---------------------------------------------------------------------------
// Default preset factory — stamps the shared metadata onto a constants bag.
// ---------------------------------------------------------------------------
function _mkDefault(guideName, name, description, constants, tags) {
  return {
    id: 'default:' + guideName,
    name,
    description,
    guideName,
    stackId: GUIDE_DEFAULT_STACK_ID,
    stackName: GUIDE_DEFAULT_STACK_NAME,
    tags: tags || [],
    constants,
    isDefault: true,
  };
}

// ---------------------------------------------------------------------------
// GUIDE_DEFAULT_PRESETS — one per tunable guide.
// Names + descriptions are the ones agreed in the design round.
// ---------------------------------------------------------------------------
const GUIDE_DEFAULT_PRESETS = {

  leoInsertionV2: _mkDefault(
    'leoInsertionV2',
    'F9 LEO — Baseline',
    'Full autonomous mission: ascent → MECO → separation → circularization → payload deploy → suicide-burn deorbit. Calibrated for the Falcon 9 Block 5 default stack.',
    {
      ASCENT: {
        INITIAL_COAST_S: 4.9,
        PUSH_T_S: 4.8,
        PUSH_MAX_GIMBAL_DEG: 1.45,
        PUSH_EAST_SIGN: -1,
        HOLD_K_DAMP: 4.0,
        HOLD_MAX_AOA_DEG: 8,
        HOLD_K_DQ: 0.005,
        HOLD_Q_REF: 1000,
        THROTTLE_FRAC: 1.0,
        THROTTLE_ALT_LOW_KM: 8,
        THROTTLE_ALT_HIGH_KM: 13,
        THROTTLE_FRAC_LOW: 0.7,
        COAST_DAMP_GAIN: 16,
        COAST_DAMP_K: 4.0,
      },
      MECO_APOGEE_KM: 150,
      AXIAL_SEP_TARGET_M: 10,
      SPLIT_TIMEOUT_S: 10,
      FAIRING_OPEN_ALT_KM: 80,
      FAIRING_OPEN_ENABLED: true,
      TARGET_ORBIT_ALT_KM: 320,
      STAGE_BURN_CUTOFF_MARGIN_MPS: 3.0,
      STAGE_BURN_LOCK_TILT_DEG: 85,
      COAST_TARGET_TILT_DEG: -90,
      COAST_ROTATE_TOL_DEG: 0.5,
      COAST_ROTATE_OMEGA_TOL: 0.02,
      COAST_ROTATE_TIMEOUT_S: 240,
      CIRC_TRIGGER_LEAD_S: 3.0,
  CIRC_DECAY_FRAC: 0.05,
      CIRC_ATT_KP: 0.5,
      CIRC_ATT_KD: 4.0,
      COAST_BURN_MULTIPLIER: 4.0,
      SUICIDE_DELAY_AFTER_DEPLOY_S: 60,
      SUICIDE_ROTATE_TOL_DEG: 1.0,
      SUICIDE_ROTATE_OMEGA_TOL: 0.02,
      SUICIDE_ROTATE_TIMEOUT_S: 120,
      SUICIDE_ATT_KP: 0.5,
      SUICIDE_ATT_KD: 4.0,
      SUICIDE_PREDICT_DT_S: 2,
      SUICIDE_PREDICT_HORIZON_S: 4000,
      SUICIDE_BURN_MAX_S: 600,
      SUICIDE_BURN_COARSE_MARGIN_DEG: 10,
      SUICIDE_TRIM_TOL_DEG: 0.005,
    },
    ['full-mission', 'pad-to-orbit', 'suicide-burn']
  ),

  leoInsertion: _mkDefault(
    'leoInsertion',
    'F9 LEO — v1 (Legacy)',
    'Original full-mission guide. Kept for reference — superseded by v2 but still flyable.',
    {
      ASCENT: {
        INITIAL_COAST_S: 4.9,
        PUSH_T_S: 4.8,
        PUSH_MAX_GIMBAL_DEG: 1.45,
        PUSH_EAST_SIGN: -1,
        HOLD_K_DAMP: 4.0,
        HOLD_MAX_AOA_DEG: 8,
        HOLD_K_DQ: 0.005,
        HOLD_Q_REF: 1000,
        THROTTLE_FRAC: 1.0,
        THROTTLE_ALT_LOW_KM: 8,
        THROTTLE_ALT_HIGH_KM: 13,
        THROTTLE_FRAC_LOW: 0.7,
        COAST_DAMP_GAIN: 16,
        COAST_DAMP_K: 4.0,
      },
      MECO_APOGEE_KM: 150,
      AXIAL_SEP_TARGET_M: 10,
      LATERAL_SEP_TARGET_M: 5,
      SPLIT_TIMEOUT_S: 10,
      FAIRING_OPEN_ALT_KM: 80,
      FAIRING_OPEN_ENABLED: true,
      TARGET_ORBIT_ALT_KM: 180,
      RCS_OMEGA_TARGET: 0,
      RCS_SETTLE_TOL: 1e-4,
      COAST_BURN_TRIGGER_FRAC: 1.0,
      COAST_TARGET_TILT_DEG: -90,
      COAST_ROTATE_TOL_DEG: 0.5,
      COAST_ROTATE_OMEGA_TOL: 0.02,
      COAST_ROTATE_TIMEOUT_S: 240,
      CIRC_VEL_TOL_MPS: 5,
      CIRC_DECAY_FRAC: 0.05,
      CIRC_ATT_KP: 0.5,
      CIRC_ATT_KD: 4.0,
      STAGE: { BURN_ALT_KM: 80, TARGET_VEL_MPS: 7800, CUTOFF_TOL_V: 5 },
      ANG_FOR_APOG_TILT_DEG: 10,
      ROTATE_TOL_DEG: 0.5,
      ROTATE_OMEGA_TOL: 0.02,
      ROTATE_TIMEOUT_S: 90,
      TARGET_APOGEE_MARGIN_KM: 10,
      STAGE_OMEGA_DAMP: 2.0,
    },
    ['full-mission', 'legacy', 'v1']
  ),

  ascentAoaHold: _mkDefault(
    'ascentAoaHold',
    'F9 Ascent — AoA Hold',
    'Full-ascent attitude controller: PUSH → COAST → HOLD → COASTnAoADAMP with analytic AoA derivatives. Two accurate wins documented.',
    {
      INITIAL_COAST_S: 11.3,
      PUSH_T_S: 10.3,
      PUSH_MAX_GIMBAL_DEG: 1.45,
      PUSH_EAST_SIGN: -1,
      HOLD_K_DAMP: 4.0,
      HOLD_MAX_AOA_DEG: 8,
      HOLD_K_DQ: 0.005,
      HOLD_Q_REF: 1000,
      THROTTLE_FRAC: 1.0,
      THROTTLE_ALT_LOW_KM: 8,
      THROTTLE_ALT_HIGH_KM: 13,
      THROTTLE_FRAC_LOW: 0.7,
      COAST_DAMP_GAIN: 16,
      COAST_DAMP_K: 4.0,
    },
    ['ascent-only', 'gravity-turn']
  ),

  ascentRR: _mkDefault(
    'ascentRR',
    'F9 Ascent — Rotate-Rest',
    'Rotate-rest cycle: periodic Q-scaled east tilt pulses on top of gimbalPredictive2 drag-cancel core.',
    {
      CYCLE_ROTATE_S: 10,
      CYCLE_REST_S: 5,
      ROTATE_T_MIN_S: 1.0,
      ROTATE_T_MAX_S: 10.0,
      ROTATE_T_SCALE: 1.0,
      DELTA_THETA_MAX_DEG: 5,
      DELTA_THETA_Q_SCALE: 29000,
      ROTATION_EAST_SIGN: -1,
      K_DAMP: 2.0,
      AOA_CHAIN_THRESHOLD_DEG: 0.5,
      PAUSE_ROTATE_KM: 8,
      RESUME_ROTATE_KM: 14,
      THR_ALT_LOW_KM: 10,
      THR_ALT_HIGH_KM: 14,
      THR_FRAC_LOW: 0.7,
      THR_FRAC_HIGH: 1.0,
    },
    ['ascent-only', 'rotate-rest']
  ),

  predictivePlus: _mkDefault(
    'predictivePlus',
    'F9 Attitude — PID Baseline',
    'Predictive feedforward + PID attitude controller. Reference implementation for the predictive-plus family.',
    {
      K_p: 3.0e5,
      K_d: 5.0e7,
      K_lead: 0.0,
      K_i: 0.5,
    },
    ['attitude', 'pid', 'reference']
  ),

  predictivePlusAoAPush: _mkDefault(
    'predictivePlusAoAPush',
    'F9 Attitude — Sweep + AoA Chase',
    'East-sweep prefix followed by AoA-chase. Single tunable: sweep duration.',
    { SWEEP_S: 10.0 },
    ['attitude', 'experimental']
  ),
};

// ---------------------------------------------------------------------------
// GUIDE_IMPORTANT_FIELDS — curated short list per guide. Path syntax uses
// dot notation for nested values. Order in the array = order in the UI.
//
// A field listed here is shown ONCE, in the "Important" section at the top
// of the config form. The remaining fields appear below, grouped by parent.
// Fields listed here that no longer exist in the code are silently skipped
// (with a one-time console.warn per guide). Guides not listed here (or
// listed with an empty array) show no "Important" section.
// ---------------------------------------------------------------------------
const GUIDE_IMPORTANT_FIELDS = {
  leoInsertionV2: [
  'TARGET_ORBIT_ALT_KM',
  'MECO_APOGEE_KM',
  'ASCENT.INITIAL_COAST_S',
  'ASCENT.PUSH_T_S',
  'ASCENT.PUSH_MAX_GIMBAL_DEG',
  // Max-Q throttle bucket — these four define where the rocket
  // throttles down through the peak dynamic pressure and back up:
  //   [LOW, HIGH) km → THROTTLE_FRAC_LOW;  outside → THROTTLE_FRAC.
  'ASCENT.THROTTLE_ALT_LOW_KM',
  'ASCENT.THROTTLE_ALT_HIGH_KM',
  'ASCENT.THROTTLE_FRAC_LOW',
  'ASCENT.THROTTLE_FRAC',
  'STAGE_BURN_LOCK_TILT_DEG',
  'STAGE_BURN_CUTOFF_MARGIN_MPS',
  'SUICIDE_DELAY_AFTER_DEPLOY_S',
],
  leoInsertion: [
    'TARGET_ORBIT_ALT_KM',
    'MECO_APOGEE_KM',
    'ASCENT.INITIAL_COAST_S',
    'ASCENT.PUSH_T_S',
    'ASCENT.PUSH_MAX_GIMBAL_DEG',
    'ANG_FOR_APOG_TILT_DEG',
    'COAST_TARGET_TILT_DEG',
    'COAST_BURN_TRIGGER_FRAC',
  ],
  ascentAoaHold: [
    'INITIAL_COAST_S',
    'PUSH_T_S',
    'PUSH_MAX_GIMBAL_DEG',
    'HOLD_K_DAMP',
    'HOLD_K_DQ',
    'THROTTLE_ALT_LOW_KM',
    'THROTTLE_ALT_HIGH_KM',
    'THROTTLE_FRAC_LOW',
  ],
  ascentRR: [
    'DELTA_THETA_MAX_DEG',
    'DELTA_THETA_Q_SCALE',
    'ROTATION_EAST_SIGN',
    'CYCLE_ROTATE_S',
    'CYCLE_REST_S',
    'K_DAMP',
  ],
  predictivePlus: [
    'K_p',
    'K_d',
    'K_lead',
    'K_i',
  ],
  predictivePlusAoAPush: [
    'SWEEP_S',
  ],
};

// ---------------------------------------------------------------------------
// Public accessors.
// ---------------------------------------------------------------------------
function getGuideDefaultPreset(guideName) {
  return GUIDE_DEFAULT_PRESETS[guideName] || null;
}

function getGuideImportantFields(guideName) {
  return GUIDE_IMPORTANT_FIELDS[guideName] || [];
}

// Deep clone — used so callers never mutate the code-resident objects.
function cloneDefaultPreset(guideName) {
  const p = GUIDE_DEFAULT_PRESETS[guideName];
  if (!p) return null;
  return JSON.parse(JSON.stringify(p));
}