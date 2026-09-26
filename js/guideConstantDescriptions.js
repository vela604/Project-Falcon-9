// ============================================================================
// guideConstantDescriptions.js — Human-readable description for every
// tunable constant in every guidance config.
//
// Keyed by guide name, then by the same dotted path the constants UI
// and presets system use (e.g. 'ASCENT.PUSH_T_S'). Rendered on the
// presets page as a reference section, and surfaced as hover tooltips
// on the input fields in the sim's Guidance System modal.
//
// Not consumed by any worker or by guidance logic — pure documentation.
// When a new constant is added to a guide's config, add its description
// here in the same commit.
// ============================================================================

const GUIDE_CONSTANT_DESCRIPTIONS = {

  // ===========================================================
  // leoInsertionV2 — full autonomous mission to LEO + suicide burn
  // ===========================================================
  leoInsertionV2: {
    // --- ascent sub-machine ---
    'ASCENT.INITIAL_COAST_S':
      'Seconds of straight climb before the PUSH pulse fires. Longer = more vertical attitude before the gravity-turn kick begins.',
    'ASCENT.PUSH_T_S':
      'Duration of the PUSH sine pulse, seconds. The pulse kicks the nose east; T is the full cycle width.',
    'ASCENT.PUSH_MAX_GIMBAL_DEG':
      'Peak gimbal deflection during PUSH, degrees. Sets the amplitude of the east-tilt kick — the gravity turn grows from this single pulse.',
    'ASCENT.PUSH_EAST_SIGN':
      'Sign of the east tilt (-1 for this sim\'s body-axis convention). Flip to +1 if the rocket tilts the wrong way.',
    'ASCENT.HOLD_K_DAMP':
      'Rate-damping gain in the HOLD phase. Higher = AoA oscillation dies faster, but the gimbal works harder.',
    'ASCENT.HOLD_MAX_AOA_DEG':
      'Safety cap — HOLD reverts to COASTnAoADAMP if |AoA| exceeds this.',
    'ASCENT.HOLD_K_DQ':
      'Gain of the post-Max-Q east nudge (dynamic-pressure trend term). Never flips west; larger = stronger push back to the gravity-turn profile.',
    'ASCENT.HOLD_Q_REF':
      'Sigmoid scale, Pa/s, for the dQ-driven east nudge. Lower = the nudge saturates at smaller dQ (more aggressive).',
    'ASCENT.THROTTLE_FRAC':
      'Base throttle fraction outside the Max-Q bucket. 1.0 = full.',
    'ASCENT.THROTTLE_ALT_LOW_KM':
      'Max-Q throttle bucket — low edge, km AGL. At or above this altitude the throttle drops to THROTTLE_FRAC_LOW.',
    'ASCENT.THROTTLE_ALT_HIGH_KM':
      'Max-Q throttle bucket — high edge, km AGL. At or above this altitude the throttle returns to THROTTLE_FRAC.',
    'ASCENT.THROTTLE_FRAC_LOW':
      'Throttle fraction inside the Max-Q bucket. 0.7 = 70% (reduces aerodynamic stress at peak Q).',
    'ASCENT.COAST_DAMP_GAIN':
      'COASTnAoADAMP position gain. Higher = more aggressive AoA reduction during COAST and COASTnAoADAMP phases.',
    'ASCENT.COAST_DAMP_K':
      'COASTnAoADAMP divisor. Effective per-radian gain scales as GAIN / K².',

    // --- hand-off ---
    'MECO_APOGEE_KM':
      'Osculating apogee (km ASL) at which engines cut and stage separation is commanded. Trigger is on apogee, not altitude or time.',

    // --- separation ---
    'AXIAL_SEP_TARGET_M':
      'Axial gap (metres) between the two bodies before the stage is allowed to ignite. Ensures the booster is far enough back that thrust doesn\'t push the stage into it.',
    'SPLIT_TIMEOUT_S':
      'Safety timeout — if the split is not detected within this many seconds after the separation command, the phase machine advances anyway.',

    // --- fairing ---
    'FAIRING_OPEN_ALT_KM':
      'Altitude AGL (km) at which the fairing splits — once the vehicle is out of the dense atmosphere.',
    'FAIRING_OPEN_ENABLED':
      'Boolean. When false, the fairing stays on and no split command is ever sent.',

    // --- target orbit ---
    'TARGET_ORBIT_ALT_KM':
      'Mission target circular-orbit altitude, km ASL. Sets STAGE_BURN cutoff, RCS_BOOST trim target, CIRCULARIZE V_orb target, and everything downstream.',

    // --- stage burn ---
    'STAGE_BURN_CUTOFF_MARGIN_MPS':
      'Cutoff fires this many m/s (Δv) early, deliberately leaving a gap for RCS_BOOST to close in fine steps. Coarse main engine + fine RCS trim.',
    'STAGE_BURN_LOCK_TILT_DEG':
      'Tilt from local vertical (deg) at which the burn attitude lock engages. Below this the nose rides the velocity vector; above, it holds a fixed tilt so thrust stays mostly tangential.',

    // --- coast + circularize ---
    'COAST_TARGET_TILT_DEG':
      'Coast hold target — tilt from local vertical. -90° means nose-horizontal, prograde at apogee.',
    'COAST_ROTATE_TOL_DEG':
      'Attitude-slew exit tolerance, degrees. Tighter = more thruster use, slower hand-off.',
    'COAST_ROTATE_OMEGA_TOL':
      'Attitude-slew exit rate tolerance, rad/s. Ensures the body is settled, not just briefly aligned.',
    'COAST_ROTATE_TIMEOUT_S':
      'Maximum time the attitude slew may take before forcing hand-off.',
    'CIRC_TRIGGER_LEAD_S':
      'Extra lead time beyond the engine startup duration — the circularize burn fires this many seconds before the ideal window opens.',
    'CIRC_DECAY_FRAC':
      'Throttle-decay window as a fraction of V_orbital. Inside this window the throttle ramps down so cutoff doesn\'t overshoot.',
    'CIRC_ATT_KP':
      'PD hold — proportional gain on attitude error during circularize and coast hold.',
    'CIRC_ATT_KD':
      'PD hold — rate-damping gain during circularize and coast hold.',
    'COAST_BURN_MULTIPLIER':
      'Multiplier on ideal T_burn to set the coast-phase burn window. 4× accounts for gravity losses on a horizontal burn near LEO.',

    // --- suicide burn ---
    'SUICIDE_DELAY_AFTER_DEPLOY_S':
      'Dwell time (seconds) after payload release before the suicide-burn sequence begins. Gives the payload separation clearance.',
    'SUICIDE_ROTATE_TOL_DEG':
      'Retrograde-slew exit tolerance, degrees.',
    'SUICIDE_ROTATE_OMEGA_TOL':
      'Retrograde-slew exit rate tolerance, rad/s.',
    'SUICIDE_ROTATE_TIMEOUT_S':
      'Maximum time the retrograde slew may take before the burn fires anyway.',
    'SUICIDE_ATT_KP':
      'Attitude PD — proportional gain, used by the retrograde slew and coast hold.',
    'SUICIDE_ATT_KD':
      'Attitude PD — rate-damping gain.',
    'SUICIDE_PREDICT_DT_S':
      'Leapfrog step size (seconds) for the impact-point prediction. Smaller = more accurate but slower.',
    'SUICIDE_PREDICT_HORIZON_S':
      'How far forward the impact predictor propagates. Must exceed the ballistic flight time from deorbit to impact (~44 min for a 320 km orbit).',
    'SUICIDE_BURN_MAX_S':
      'Hard cap on the retrograde burn duration. Safety against a pathological cutoff condition that never fires.',
    'SUICIDE_BURN_COARSE_MARGIN_DEG':
      'Main engine cuts when the predicted impact is this many degrees east of the target. RCS trim closes the remaining gap at ~100× finer resolution.',
    'SUICIDE_TRIM_TOL_DEG':
      'RCS trim tolerance, degrees. Once impact prediction is within this band of the resting-area midpoint, trim latches off — prevents a bang-bang limit cycle.',
  },

  // ===========================================================
  // leoInsertion — the original full-mission guide (legacy)
  // ===========================================================
  leoInsertion: {
    'ASCENT.INITIAL_COAST_S':
      'Seconds of straight climb before the PUSH pulse fires.',
    'ASCENT.PUSH_T_S':
      'Duration of the PUSH sine pulse, seconds.',
    'ASCENT.PUSH_MAX_GIMBAL_DEG':
      'Peak gimbal deflection during PUSH, degrees.',
    'ASCENT.PUSH_EAST_SIGN':
      'Sign of the east tilt (-1 for this sim\'s body-axis convention).',
    'ASCENT.HOLD_K_DAMP':
      'Rate-damping gain in the HOLD phase.',
    'ASCENT.HOLD_MAX_AOA_DEG':
      'Safety cap on |AoA| during HOLD.',
    'ASCENT.HOLD_K_DQ':
      'Gain of the post-Max-Q east nudge.',
    'ASCENT.HOLD_Q_REF':
      'Sigmoid scale for the dQ-driven east nudge, Pa/s.',
    'ASCENT.THROTTLE_FRAC':
      'Base throttle fraction outside the Max-Q bucket.',
    'ASCENT.THROTTLE_ALT_LOW_KM':
      'Max-Q throttle bucket — low edge, km AGL.',
    'ASCENT.THROTTLE_ALT_HIGH_KM':
      'Max-Q throttle bucket — high edge, km AGL.',
    'ASCENT.THROTTLE_FRAC_LOW':
      'Throttle fraction inside the Max-Q bucket.',
    'ASCENT.COAST_DAMP_GAIN':
      'COASTnAoADAMP position gain.',
    'ASCENT.COAST_DAMP_K':
      'COASTnAoADAMP divisor.',
    'MECO_APOGEE_KM':
      'Osculating apogee (km ASL) at which engines cut and separation is commanded.',
    'AXIAL_SEP_TARGET_M':
      'Axial gap (metres) between the two bodies before the stage ignites.',
    'LATERAL_SEP_TARGET_M':
      'Lateral gap (metres) between the two bodies — legacy two-phase separation target, unused in the current flow.',
    'SPLIT_TIMEOUT_S':
      'Safety timeout for the split-detection phase, seconds.',
    'FAIRING_OPEN_ALT_KM':
      'Altitude AGL (km) at which the fairing splits.',
    'FAIRING_OPEN_ENABLED':
      'Boolean. When false, the fairing stays on.',
    'TARGET_ORBIT_ALT_KM':
      'Mission target circular-orbit altitude, km ASL.',
    'RCS_OMEGA_TARGET':
      'Residual angular rate target after the post-separation settle phase, rad/s.',
    'RCS_SETTLE_TOL':
      'Convergence tolerance for the settle phase, rad/s.',
    'COAST_BURN_TRIGGER_FRAC':
      'Fraction of ideal T_burn at which the coast-phase burn fires.',
    'COAST_TARGET_TILT_DEG':
      'Coast hold target — tilt from local vertical.',
    'COAST_ROTATE_TOL_DEG':
      'Attitude-slew exit tolerance, degrees.',
    'COAST_ROTATE_OMEGA_TOL':
      'Attitude-slew exit rate tolerance, rad/s.',
    'COAST_ROTATE_TIMEOUT_S':
      'Maximum time the attitude slew may take.',
    'CIRC_VEL_TOL_MPS':
      'Velocity cutoff tolerance for circularization, m/s.',
    'CIRC_DECAY_FRAC':
      'Throttle-decay window as a fraction of V_orbital.',
    'CIRC_ATT_KP':
      'PD hold — proportional gain on attitude error.',
    'CIRC_ATT_KD':
      'PD hold — rate-damping gain.',
    'STAGE.BURN_ALT_KM':
      'Altitude (km) at which the stage burn starts.',
    'STAGE.TARGET_VEL_MPS':
      'Target velocity for the stage phase, m/s.',
    'STAGE.CUTOFF_TOL_V':
      'Cutoff velocity tolerance for the stage phase, m/s.',
    'ANG_FOR_APOG_TILT_DEG':
      'Steep climb tilt target used by the post-MECO rotate phase, degrees from local vertical.',
    'ROTATE_TOL_DEG':
      'Rotate-phase attitude exit tolerance, degrees.',
    'ROTATE_OMEGA_TOL':
      'Rotate-phase rate exit tolerance, rad/s.',
    'ROTATE_TIMEOUT_S':
      'Maximum time the steep-climb rotate phase may take.',
    'TARGET_APOGEE_MARGIN_KM':
      'Soft-approach margin near the target apogee, km. Inside this margin the stage throttles down for a controlled cutoff.',
    'STAGE_OMEGA_DAMP':
      'Inertial rate damper gain during the stage phase, 1/s.',
  },

  // ===========================================================
  // ascentAoaHold — full-ascent AoA controller
  // ===========================================================
  ascentAoaHold: {
    'INITIAL_COAST_S':
      'Seconds of straight climb before the PUSH pulse fires. Longer = more vertical attitude before the gravity-turn kick begins.',
    'PUSH_T_S':
      'Duration of the PUSH sine pulse, seconds. The pulse kicks the nose east.',
    'PUSH_MAX_GIMBAL_DEG':
      'Peak gimbal deflection during PUSH, degrees. Sets the amplitude of the initial east-tilt kick.',
    'PUSH_EAST_SIGN':
      'Sign of the east tilt (-1 for this sim\'s body-axis convention). Flip to +1 if the rocket tilts the wrong way.',
    'HOLD_K_DAMP':
      'Rate-damping gain in the HOLD phase. Higher = AoA oscillation dies faster, but the gimbal works harder.',
    'HOLD_MAX_AOA_DEG':
      'Safety cap — HOLD reverts to COASTnAoADAMP if |AoA| exceeds this.',
    'HOLD_K_DQ':
      'Gain of the post-Max-Q east nudge (dynamic-pressure trend term).',
    'HOLD_Q_REF':
      'Sigmoid scale, Pa/s, for the dQ-driven east nudge.',
    'THROTTLE_FRAC':
      'Base throttle fraction outside the Max-Q bucket.',
    'THROTTLE_ALT_LOW_KM':
      'Max-Q throttle bucket — low edge, km AGL.',
    'THROTTLE_ALT_HIGH_KM':
      'Max-Q throttle bucket — high edge, km AGL.',
    'THROTTLE_FRAC_LOW':
      'Throttle fraction inside the Max-Q bucket.',
    'COAST_DAMP_GAIN':
      'COASTnAoADAMP position gain.',
    'COAST_DAMP_K':
      'COASTnAoADAMP divisor.',
  },

  // ===========================================================
  // ascentRR — rotate-rest ascent controller
  // ===========================================================
  ascentRR: {
    'CYCLE_ROTATE_S':
      'Default rotate phase duration, seconds. Overridden by the dynamic T for each rotation (see ROTATE_T_SCALE).',
    'CYCLE_REST_S':
      'Duration of the rest phase between rotations, seconds.',
    'ROTATE_T_MIN_S':
      'Lower clamp on the dynamic rotate-phase duration, seconds.',
    'ROTATE_T_MAX_S':
      'Upper clamp on the dynamic rotate-phase duration, seconds.',
    'ROTATE_T_SCALE':
      'Seconds per degree of rotation target. T = clamp(|Δθ| × this, MIN, MAX).',
    'DELTA_THETA_MAX_DEG':
      'Rotation amplitude at Q → 0 (near the pad), degrees. The actual Δθ = MAX × exp(−Q / Q_SCALE).',
    'DELTA_THETA_Q_SCALE':
      'E-folding dynamic pressure, Pa. Higher = Δθ stays larger deeper into ascent.',
    'ROTATION_EAST_SIGN':
      'Sign of east rotation direction (-1 for this sim\'s body-axis convention).',
    'K_DAMP':
      'Rest-phase rate damper, 1/s. τ = −K_DAMP · I · ω_rel; higher = ω dies faster.',
    'AOA_CHAIN_THRESHOLD_DEG':
      'Rotate phase chains immediately (skipping rest) if |AoA| is still above this on exit.',
    'PAUSE_ROTATE_KM':
      'Altitude AGL (km) at which rotations pause for Max-Q.',
    'RESUME_ROTATE_KM':
      'Altitude AGL (km) at which rotations resume after the Max-Q pause.',
    'THR_ALT_LOW_KM':
      'Max-Q throttle bucket — low edge, km AGL.',
    'THR_ALT_HIGH_KM':
      'Max-Q throttle bucket — high edge, km AGL.',
    'THR_FRAC_LOW':
      'Throttle fraction inside the Max-Q bucket.',
    'THR_FRAC_HIGH':
      'Throttle fraction outside the Max-Q bucket. 1.0 = full.',
  },

  // ===========================================================
  // predictivePlus — predictive feedforward + PID attitude
  // ===========================================================
  predictivePlus: {
    'K_p':
      'Proportional gain on attitude error. Higher = faster correction, but risks overshoot.',
    'K_d':
      'Rate-damping gain. Higher = more aggressive damping of angular rate.',
    'K_lead':
      'Phase-lead gain on the derivative of predicted drag torque. 0 disables (default — needs noise-tolerant derivative to be useful).',
    'K_i':
      'Integral gain on accumulated torque deficit. Absorbs slow biases.',
  },

  // ===========================================================
  // predictivePlusAoAPush — east sweep then AoA-chase
  // ===========================================================
  predictivePlusAoAPush: {
    'SWEEP_S':
      'Duration of the east-sweep prefix, seconds. After this, control hands off to the AoA-chase phase.',
  },
};