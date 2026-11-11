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

  leoInsertionV3: {
  // ---- ascent (pad → MECO) ----
  'ascent.INITIAL_COAST_S': 'Pre-launch hold before PUSH begins. Engines spool up to full thrust during this window; attitude controller stays in PRE_COAST and applies zero torque.',
  'ascent.PUSH_T_S': 'Duration of the PUSH phase — the initial eastward rotation. A half-sine torque profile of this length produces the target tilt delta.',
  'ascent.PUSH_MAX_GIMBAL_DEG': 'Peak gimbal deflection used to estimate the achievable tilt delta during PUSH. Larger value → larger computed delta → more aggressive rotation.',
  'ascent.PUSH_EAST_SIGN': 'Sign of the PUSH rotation. -1 tilts east (toward prograde). 1 tilts west (rarely used, mostly for testing).',
  'ascent.HOLD_PD_KP': 'Proportional gain on angle of attack in the HOLD and COASTnAoADAMP phases (tau = -I*(KP*aoa + KD*aoaRate)). Same PID law as the stage burn; larger value = stiffer AoA hold.',
  'ascent.HOLD_PD_KD': 'Derivative gain on the AoA rate in the HOLD and COASTnAoADAMP phases. Damps AoA oscillation; larger value = stronger damping.',
  'ascent.HOLD_PD_KI': 'Integral gain on AoA in HOLD and COASTnAoADAMP. Removes the PD static AoA offset that grows with dynamic pressure. Fixed constant (not tuned). Keep KI < KP·KD.',
  'ascent.GIMBAL_CMD_TAU_S': 'Time constant (s) of the low-pass filter on the commanded gimbal angle in HOLD / COASTnAoADAMP. Removes the 1-tick limit cycle at low airspeed; response is dt-independent. 0 = unfiltered (deadbeat) command.',
  'ascent.THROTTLE_FRAC': 'Nominal throttle fraction outside the max-Q bucket. 1.0 = full throttle.',
  'ascent.THROTTLE_ALT_LOW_KM': 'Lower edge of the max-Q throttle bucket (km AGL). Below this altitude, nominal throttle applies.',
  'ascent.THROTTLE_ALT_HIGH_KM': 'Upper edge of the max-Q throttle bucket. Above this altitude, nominal throttle resumes.',
  'ascent.THROTTLE_FRAC_LOW': 'Throttle fraction used inside the max-Q bucket (LOW .. HIGH km). Reduces thrust to limit peak aerodynamic load.',
  'ascent.MECO_TARGET_BOOSTER_FUEL_KG': 'Residual booster tank fuel (kg) wanted at the end of the shutdown spool-down. MECO fires when the projected fuel left after that spool burn reaches this value. Higher = earlier MECO and more fuel kept for boostback and landing; lower = longer ascent burn and less fuel left.',
  'ascent.GIMBAL_TARGET': 'Which engines participate in gimbal control during ascent. "center" = only the center engine (F9 legacy), "all" = every gimbal-capable engine.',
  
  // ---- separation (mission-level glue) ----
  'separation.SEPARATION_DURATION_S': 'Fixed duration (s) of the SEPARATED_AXIAL phase, counted from the phase entry (split detected). At the end of this window, the insertion block takes over — regardless of the axial gap.',
'separation.SPLIT_TIMEOUT_S': 'Maximum time (s) to wait for the split to physically appear after MECO. If the body count never grows, the mission aborts.',
'separation.LATERAL_TRIGGER_MARGIN_M': 'Margin (m) above the stage engine bell height before the booster lateral/negative-torque kick arms. Prevents firing while the bell still overlaps the interstage.',
'separation.BOOSTER_SEP_ANG_ACCEL_DEG_S2': 'Angular acceleration (deg/s2, signed) the pneumatic pushers impart to the discarded booster at separation. Fires once, when the stage engine bell has cleared the interstage. Negative = clockwise flip (nose toward the pad). Drives the booster angular velocity toward BOOSTER_SEP_TARGET_OMEGA_DEG_S, then shuts off.',
'separation.BOOSTER_SEP_TARGET_OMEGA_DEG_S': 'Angular velocity (deg/s, positive) the pusher torque drives the discarded booster to before turning off. Once |omega| reaches this, the pusher stops firing. Higher = faster flip-away; too high can overshoot and tumble the booster.',
  
  // ---- insertion (post-separation stage → payload deployed) ----
  'insertion.GIMBAL_TARGET': 'Which engines participate in gimbal control during the stage burn. "all" engages every gimbal-capable engine (single-nozzle MVac uses one, octaweb uses all).',
  'insertion.STAGE_BURN_CUTOFF_MARGIN_MPS': 'Extra Δv margin (m/s) added to the spool-loss prediction when computing the STAGE_BURN cutoff apogee. Positive = burn slightly longer, overshoot apogee. Zero = exact prediction.',
  'insertion.STAGE_BURN_AOA_KP': 'Proportional gain for the AoA-tracking PID controller. Larger = stronger restoring torque toward the target AoA.',
  'insertion.STAGE_BURN_AOA_KD': 'Derivative gain for the AoA-tracking PID controller. Damping on d(AoA)/dt (which includes the velocity-vector rotation term). For critical damping (without KI), set ≈ 2·√KP.',
  'insertion.STAGE_BURN_AOA_KI': 'Integral gain on the AoA error in STAGE_BURN. Removes the PD static offset so AoA holds the bias exactly. Fixed constant (not tuned). Keep KI < KP·KD.',
  'insertion.STAGE_BURN_AOA_BIAS_RATE_DEG_S': 'Rate limit (deg/s) of the AoA target: it starts at the AoA at STAGE_BURN entry and ramps straight to STAGE_BURN_AOA_BIAS_DEG at this rate. Fixed constant (not tuned).',
  'insertion.STAGE_BURN_AOA_BIAS_DEG': 'Non-zero target AoA offset (deg) during STAGE_BURN. Shifts the nose slightly off the velocity vector, giving thrust a small perpendicular component that changes the natural tilt-growth rate. Sign-sensitive; tune empirically.',
  'insertion.COAST_TARGET_TILT_DEG': 'Target inertial tilt (deg from local vertical) the stage holds during the circularization coast. -90 = nose retrograde (thrust along velocity).',
  'insertion.COAST_ROTATE_TOL_DEG': 'Attitude tolerance (deg) for ending a COAST_ROTATE phase. Within this band and with low ω, the rotation is considered complete.',
  'insertion.COAST_ROTATE_OMEGA_TOL': 'Angular-rate tolerance (rad/s) paired with COAST_ROTATE_TOL_DEG. Both must be satisfied for the rotation to end.',
  'insertion.COAST_ROTATE_TIMEOUT_S': 'Maximum time (s) allowed for any COAST_ROTATE phase. On timeout, the controller advances regardless.',
  'insertion.COAST_WAIT_BEFORE_APOGEE_S': 'Seconds before apogee at which COAST_WAIT ends and the second COAST_ROTATE begins. Larger = start aligning earlier.',
  'insertion.CIRC_TRIGGER_LEAD_S': 'Lead time (s) before the circularize burn start. Added on top of engine startup duration to allow spool-up before the trigger tick.',
  'insertion.CIRC_DECAY_FRAC': 'Fraction of the target orbital velocity within which the circularize throttle tapers. 0.05 = last 5% of velocity is burned at reduced throttle.',
  'insertion.CIRC_ATT_KP': 'Attitude-hold proportional gain used during coast and circularize. Tightens attitude to the coast target tilt.',
  'insertion.CIRC_ATT_KD': 'Attitude-hold derivative gain. Damps angular rate during holds.',
  'insertion.COAST_HOLD_ATT_KP': 'Proportional gain on inertial-attitude error during COAST_HOLD and COAST_HOLD_2 (the coast phases before CIRCULARIZE and payload deploy). Higher = tighter tracking of the live apside direction. Separate from CIRC_ATT_KP so the long coasts can be tuned independently of the short burns.',
  'insertion.COAST_HOLD_ATT_KD': 'Derivative gain (rate damping) on inertial-attitude error during the coast-hold phases. tau = KD/KP. Typical value >= KP gives a settled attitude in ~3*tau seconds (a few seconds at ~1 s tau).',
  'insertion.COAST_HOLD_ATT_KI': 'Integral gain on inertial-attitude error during the coast-hold phases. Eliminates the steady-state lag PD leaves when the target apside direction drifts (~0.066 deg/s in LEO). Integrator is armed fresh on each HOLD entry (no windup from the preceding ROTATE), gated to |err| < 0.5 deg, and clamped.',
  'insertion.COAST_BURN_MULTIPLIER': 'Safety multiplier applied to the computed ideal coast burn time. Larger = start aligning / planning earlier.',
  'insertion.TARGET_APSIDE1_ALT_KM': 'First of two target apsides (km ASL). The insertion block internally sorts them: apogee = max(apside1, apside2), perigee = min(apside1, apside2). Equal values → circular target. Different values → elliptical target (higher = apo, lower = peri).',
  'insertion.TARGET_APSIDE2_ALT_KM': 'Second of two target apsides (km ASL). See TARGET_APSIDE1_ALT_KM. Drives STAGE_BURN apogee cutoff, RCS_BOOST apogee trim, and the CIRCULARIZE / COAST_HOLD_2 target velocity (vis-viva at apogee of the resulting ellipse).',
  'insertion.PAYLOAD_CLEAR_DIST_M': 'Minimum separation distance (m) between stage and payload body for the payload to count as "cleared" and end the insertion block.',
  'insertion.PAYLOAD_CONFIRM_TIMEOUT_S': 'Fail-safe: if the payload never confirms as cleared, the insertion block ends after this many seconds regardless.',
  'insertion.COAST_HOLD_2_TRIM_TOL_MPS': 'Convergence tolerance (m/s) for the COAST_HOLD_2 axial deltaV trim. Once |gap - eject_kick| falls below this, axial RCS firing stops. Smaller = tighter final orbit, but more RCS chatter at the boundary.',
  'insertion.COAST_HOLD_2_TRIM_FAR_MPS': 'Error (m/s) at which the COAST_HOLD_2 axial trim uses full RCS duty. Duty scales as min(1, |dvError| / FAR). Smaller = more aggressive at small errors (faster convergence, overshoot risk).',
  
  // ---- fairing (mission-level glue) ----
  'fairing.HAS_FAIRING': 'Whether the stack carries a payload fairing. When false, fairing auto-open is skipped entirely.',
  'fairing.FAIRING_OPEN_ALT_KM': 'Altitude (km AGL) at which the fairing auto-splits. Runs phase-independently once the split is detected.',
  'fairing.FAIRING_OPEN_ENABLED': 'Master toggle for fairing auto-open. Set false to fly without fairing separation.',
  
  // ---- done dwell (mission-level glue) ----
  'done.SUICIDE_DELAY_AFTER_DEPLOY_S': 'Dwell time (s) between payload deploy and the start of the deorbit sequence. Counted from the deploy command tick. Long dwells (hundreds of seconds) park the stage in orbit before deorbit.',
  'done.CIRC_ATT_KP': 'Attitude-hold proportional gain used during the done dwell. Duplicate of insertion.CIRC_ATT_KP, held separately so the dwell can be tuned independently.',
  'done.CIRC_ATT_KD': 'Attitude-hold derivative gain during the done dwell. Duplicate of insertion.CIRC_ATT_KD.',
  'done.DEORBIT_ENABLED': 'Master toggle for the deorbit sequence. When false, mission ends at payload deploy and the suicide block is never dispatched.',
  'done.PAYLOAD_DEPLOY_OPEN_DELAY_S': 'Seconds between the payload deploy command (actual release + kick) and the open command that unfolds the satellite panels and dish. Visual animation only - no physics effect. Fires exactly once per mission.',
  
  // ---- suicide (generic retrograde-deorbit block) ----
  'suicide.SUICIDE_ROTATE_TOL_DEG': 'Attitude tolerance (deg) for the retrograde alignment at the start of the suicide block. Within this band and with low ω, the rotation completes.',
  'suicide.SUICIDE_ROTATE_OMEGA_TOL': 'Angular-rate tolerance (rad/s) paired with SUICIDE_ROTATE_TOL_DEG.',
  'suicide.SUICIDE_ROTATE_TIMEOUT_S': 'Maximum time (s) for the initial retrograde rotation. On timeout, the burn starts regardless.',
  'suicide.SUICIDE_ATT_KP': 'Proportional gain for attitude tracking during the burn and coast. Larger = tighter attitude hold against disturbances.',
  'suicide.SUICIDE_ATT_KD': 'Derivative gain for the same controller. Damps oscillation; too small causes wobble, too large causes sluggish response.',
  'suicide.SUICIDE_PREDICT_DT_S': 'Time step (s) for the leapfrog ballistic impact predictor. Smaller = more accurate but slower.',
  'suicide.SUICIDE_PREDICT_HORIZON_S': 'Maximum prediction horizon (s). If impact is not found within this window, the predictor returns null and the burn continues.',
  'suicide.SUICIDE_BURN_MAX_S': 'Safety cap on total burn duration (s). If the burn runs past this, it cuts off and coasts.',
  'suicide.SUICIDE_BURN_COARSE_MARGIN_DEG': 'Earth-fixed angular margin (deg) before the target resting-area meridian at which the burn cuts off. Larger = earlier cutoff, more coast, RCS trim has more work.',
  'suicide.SUICIDE_TRIM_TOL_DEG': 'Impact-angle convergence tolerance (deg) for the RCS trim. When |dLambda| falls below this, trim ends and the block is done.',
  'suicide.SUICIDE_TRIM_FAR_DEG': 'Impact-angle error (deg) at which the trim uses full duty. Errors smaller than this scale the duty proportionally.',
  'suicide.SUICIDE_TRIM_MIN_DUTY': 'Minimum RCS trim duty. Prevents the trim from chattering around the target when the error is tiny.',
  'suicide.SUICIDE_TRIM_MAX_S': 'Maximum duration (s) for the RCS trim after the burn. On timeout, trim ends regardless of convergence.',
},

  // landbackV1 — clone of leoInsertionV3 (Landback logic to be added)
  landbackV1: {
  // ---- mission (booster landing target) ----
  'mission.TARGET_LANDING_PAD': 'Id of the landing pad the booster returns to (an id from CONFIG.LANDING_PADS, e.g. LZ-1). Its Earth-fixed angle (launch-site angle + arcOffsetM / R) is handed to the RTLS block as the boostback / landing target.',
  // ---- rtls (booster return) ----
  'rtls.BOOSTBACK_ENGINES': 'Engines fired during BOOSTBACK_BURN, comma-separated. "C" = centre engine, numbers = outer-ring engine angleDeg (0 and 180 are the two extreme left/right engines of the octaweb). Default "C,0,180". The centre engine is the one that finishes the burn; the rest are shut off first.',
  'rtls.BOOSTBACK_APPARENT_OFFSET_M': 'Apparent target: boostback aims the (vacuum) impact point at target pad + this many metres along the ground (converted to an Earth angle internally). Positive = east of the pad (short of it), negative = west. The remaining gap is meant to be covered later by drag / grid-fin steering to save boostback fuel.',
  'rtls.BOOSTBACK_SIDE_CUT_M': 'The two outer boostback engines are shut off when the predicted impact is within this many metres (ground distance) of the apparent target; the centre engine then finishes the burn (default 20 km).',
  'rtls.BOOSTBACK_TAPER_M': 'Throttle fade of all burning engines: 100% while the impact error is above this many metres, then linearly down to the engine throttle floor as the error goes to 0 (default 150 km). 0 = no fade.',
  'rtls.PRE_ENTRY_ALIGN_ALT_KM': 'Altitude AGL (km) on descent at which PRE_ENTRY_STEER completes its predictive DRIFT alignment (target theta = air-relative retrograde at this altitude, computed via ballistic propagation from phase entry). Above this altitude, the booster coasts toward that target with a SMALL omega (lateral-only RCS, net-force zero, fuel-efficient long-coast approach — no bang-bang peak-and-cancel). Below, HOLD trims residual attitude until ENTRY_BURN_ALT_KM.',
  'rtls.LANDING_BURN_ALIGN_ALT_KM': 'Altitude AGL (km) at which POST_ENTRY_STEER stops steering: grid fin ramps smoothly back to 0 (at POST_ENTRY_GRIDFIN_RAMP_DEG_S rate, no oscillation) and the booster coasts to its natural aero equilibrium before landing-burn ignition. Above this altitude PES runs the normal v4 closed loop.',
  'rtls.LANDING_BURN_ENGINES': 'Engines fired at 100% during LANDING_BURN spool. Same token format as BOOSTBACK_ENGINES: "C" = centre engine, numbers = outer-ring angleDeg (e.g. "C,0,180" for centre + two extreme outers). Default "C" (real F9 final descent configuration).',
    'rtls.LANDING_BURN_V_TD': 'Minimum touchdown speed (m/s) for the adaptive V_TD law. Actual V_TD = clamp(sqrt(2*aMin*MARGIN), V_TD_MIN, V_TD_MAX), where aMin = (Fmin - weight)/M. Heavier booster at contact -> aMin small -> V_TD sits near floor. Lighter -> higher. Floor prevents stall (vehicle stopping above ground then rising). Set to 0.3 typical; if you see hop/UP in logs, raise.',  'rtls.LANDING_BURN_THR_LATE': 'Base descent throttle fraction at high altitude. Blends down to the Fmin fraction by h=8m (internal, not exposed) so contact fires near Fmin throttle, minimizing spool-down hop. 0.6 default; keep >= ~0.45 so descent does not stall before the blend region.',

  'rtls.LANDING_BURN_V_TD_MARGIN_M': 'Stopping-distance margin (m) the adaptive V_TD law reserves at Fmin decel: V_TD >= sqrt(2*aMin*MARGIN). Larger = more coasting buffer, vehicle approaches contact slower but takes longer. 0.2 m default.',
  'rtls.LANDING_BURN_V_TD_MAX': 'Upper cap (m/s) on the adaptive V_TD. Lightest vehicles (Fmin much above weight) could in principle demand very high touchdown speed; this cap keeps it sane and inside landing velocity limits. 1.5 m/s default.',  'rtls.LANDING_BURN_H_FLOOR_M': 'Denominator floor for aNeed = (v^2 - V_TD^2)/(2*max(h,H_FLOOR)). Prevents divide-by-zero near touchdown. 0.1 default.',
  'rtls.LANDING_BURN_H_OFFSET_M': 'Altitude offset added to hEff (m) before hEff is used in the descent law. Calibration knob if leg-tip geometry is off. 0 default.',
  'rtls.LANDING_BURN_H_CUT_M': 'Engine cut when hEff <= this (m). 0 default relies on the STALL condition firing first.',
  'rtls.LANDING_BURN_H_STALL_M': 'STALL cutoff altitude threshold (m). When leg-tip contact has cleared the ground and vertical speed is very low (|vy| < 0.15), engine cut fires. 0.5 default.',
  'rtls.LANDING_BURN_KN': 'LB_KN lateral cascade parameter.',
  'rtls.LANDING_BURN_REPLAN_S': 'LB_REPLAN_S lateral cascade parameter.',
  'rtls.LANDING_BURN_PROF_DT': 'LB_PROF_DT lateral cascade parameter.',
  'rtls.LANDING_BURN_FIN_SHARE': 'LB_FIN_SHARE lateral cascade parameter.',
  'rtls.LANDING_BURN_FIN_RATE': 'LB_FIN_RATE lateral cascade parameter.',
  'rtls.LANDING_BURN_FIN_CAP': 'LB_FIN_CAP lateral cascade parameter.',
  'rtls.LANDING_BURN_KZ': 'LB_KZ lateral cascade parameter.',
  'rtls.LANDING_BURN_KV': 'Lateral velocity-loop gain (1/s). Inner attitude loop bandwidth is ~1 rad/s; keep KV about 3x slower for stability.',
  'rtls.LANDING_BURN_VLIM': 'LB_VLIM lateral cascade parameter.',
  'rtls.LANDING_BURN_VH': 'Reference lateral speed cap near ground (1/s). Limits lateral velocity reference to (VH*h + 0.1) m/s. Lower = slower terminal lateral approach, tighter touchdown vx but longer transit.',
  'rtls.LANDING_BURN_ABRK': 'LB_ABRK lateral cascade parameter.',
  'rtls.LANDING_BURN_KTH': 'Attitude loop proportional gain (1/s^2). Higher = faster tilt response to attitude error, but risks gimbal saturation. Keep below ~1.5 for stable cascade.',
  'rtls.LANDING_BURN_KW': 'Attitude loop rate damping (1/s). Higher = more damping, less overshoot. Critical damping at KTH=1.0 needs KW~2.0; default 1.6 is slightly under-damped.',
  'rtls.LANDING_BURN_SLEW': 'LB_SLEW lateral cascade parameter.',
  'rtls.LANDING_BURN_CAP_MAX': 'LB_CAP_MAX lateral cascade parameter.',
  'rtls.LANDING_BURN_CAP_BASE': 'Tilt cap at h=0 (deg). Caps desired tilt near ground so vehicle does not over-tilt during final lateral corrections. Higher = more lateral authority near ground but risk of tip-over. 1.5 default; safe up to 12 degree tilt limit.',
  'rtls.LANDING_BURN_CAP_H': 'Tilt cap growth with height (deg/m). cap(h) = CAP_BASE + CAP_H*h, clamped at CAP_MAX. Higher = more aggressive lateral correction at altitude.',
  'rtls.LANDING_BURN_MCAP': 'LB_MCAP lateral cascade parameter.',
  'rtls.LANDING_BURN_GFLOOR': 'LB_GFLOOR lateral cascade parameter.',
  'rtls.LANDING_BURN_NOAUTH': 'LB_NOAUTH lateral cascade parameter.',
  'rtls.LANDING_BURN_H_BLEND': 'LB_H_BLEND lateral cascade parameter.',
  'rtls.LANDING_BURN_LEGS_ALT_M': 'Altitude AGL (m) at which LANDING_BURN commands legs deploy. Higher = more margin for full progress before contact; deploy rate is a leg-type property (legs-swingout-4 ships ~0.5/s, so ~2 s from 0 to 1). Set to 200 m for F9-class booster to guarantee legs at 1.0 before touchdown.',
  'rtls.LANDING_BURN_ALT_KM': 'Altitude AGL (km) at which POST_ENTRY_STEER hands off to the LANDING_BURN phase. Must be below LANDING_BURN_ALIGN_ALT_KM. This is the landing-burn ignition trigger.',
  'rtls.ENTRY_BURN_ALT_KM': 'Altitude AGL (km) at which PRE_ENTRY_STEER hands off to ENTRY_BURN. The phase must already be in HOLD (aligned, low ω) when this triggers.',
  'rtls.ENTRY_BURN_ENGINES': 'Engines lit for the entry burn at their LOWEST thrust (minMassFlowRate). "C" = centre engine, numbers = outer-ring engine angleDeg (0 and 180 = the two extreme left/right engines). Comma separated. Default "C,0,180" = centre + two extreme outer.',
  'rtls.ENTRY_BURN_GIMBAL_ENGINES': 'Engines that gimbal during the entry burn to cancel the environment torque (aero drag + gravity gradient) and hold attitude. Same token format as ENTRY_BURN_ENGINES; must be a subset. Start with "C" (centre only); watch console for "ENTRY_BURN gimbal SATURATED" and add more engines if it fires.',
  'rtls.ENTRY_BURN_CUTOFF_VELOCITY_MS': 'Entry burn cutoff: engines shut off (spool-down) when the Earth-relative speed (m/s, air-relative incl. Earth rotation) falls to this value. The phase ends once thrust has spooled down (mass flow < 1 kg/s).',
  'rtls.ENTRY_BURN_IMPACT_TARGET_M': 'Entry-burn impact target bias (m): aims the vacuum-predicted impact point this many metres EAST of the pad (negative = west, past the pad). The vacuum predictor ignores post-cutoff drag + fin/RCS drift, so biasing the burn target west pre-compensates it. -1480 m is the empirical value from v6 lateral-only dynamic POST_ENTRY: with the bias the vacuum error should land at ~0 after fins+RCS drift, giving a clean touchdown.',
  'rtls.POST_ENTRY_GRIDFIN_RAMP_DEG_S': 'POST_ENTRY_STEER: the grid-fin (F/B) control target is ramped from 0 to the maximum clockwise-torque tilt at this rate (deg/s) instead of a step, so the booster settles at its aero equilibrium without oscillating. The fin actuator clamps to the fin type maxControlDeg. Lower = smoother but slower.',
  'rtls.FLIP_ROTATE_TOL_DEG': 'Attitude tolerance (deg) for ending the FLIP phase. Within this band (and with |relative omega| < FLIP_OMEGA_TOL) the booster is considered settled and BOOSTBACK_BURN starts.',
  'rtls.FLIP_OMEGA_TOL': 'Angular-rate tolerance (rad/s) paired with FLIP_ROTATE_TOL_DEG. BOTH |angle error| and |relative omega| must satisfy their tolerances to end FLIP — ensures the body is actually at rest, not just passing through the target mid-swing.',
  'rtls.FLIP_TIMEOUT_S': 'Maximum time (s) for the FLIP phase. On timeout the controller advances to BOOSTBACK_BURN regardless (protection against a stuck / degenerate attitude state, e.g. target-null at near-zero tangential velocity).',
  'rtls.FLIP_PUSHER_ANG_ACCEL_DEG_S2': 'Pusher angular acceleration during FLIP ACCEL (deg/s2, signed; negative = clockwise, matching the fixed flip direction). Pusher + RCS both fire full in ACCEL; pusher cancels exactly at the brake switch.',
  'rtls.FLIP_PUSHER_MAX_OMEGA_DEG_S': 'Pusher hard cap (deg/s). The pusher stops by itself above this |omega|. Only a safety limit — normal brake switch cancels it before the cap.',
  'rtls.FLIP_BRAKE_HYST_DEG': 'Brake hysteresis band (deg). Once braking starts, mode stays BRAKE until the state is this far UNDER the switching curve. Undershoot is cheap, overshoot is not.',
  'rtls.FLIP_AERO_PROJECT': '1 = project aero table in time during the stopping rollout (slices at +8/+16/+24s to account for dynamic-pressure fall as the booster climbs). 0 = v2 frozen table (A/B test).',

  'ascent.INITIAL_COAST_S': 'Pre-launch hold before PUSH begins. Engines spool up to full thrust during this window; attitude controller stays in PRE_COAST and applies zero torque.',
  'ascent.PUSH_T_S': 'Duration of the PUSH phase — the initial eastward rotation. A half-sine torque profile of this length produces the target tilt delta.',
  'ascent.PUSH_MAX_GIMBAL_DEG': 'Peak gimbal deflection used to estimate the achievable tilt delta during PUSH. Larger value → larger computed delta → more aggressive rotation.',
  'ascent.PUSH_EAST_SIGN': 'Sign of the PUSH rotation. -1 tilts east (toward prograde). 1 tilts west (rarely used, mostly for testing).',
  'ascent.HOLD_PD_KP': 'Proportional gain on angle of attack in the HOLD and COASTnAoADAMP phases (tau = -I*(KP*aoa + KD*aoaRate)). Same PID law as the stage burn; larger value = stiffer AoA hold.',
  'ascent.HOLD_PD_KD': 'Derivative gain on the AoA rate in the HOLD and COASTnAoADAMP phases. Damps AoA oscillation; larger value = stronger damping.',
  'ascent.HOLD_PD_KI': 'Integral gain on AoA in HOLD and COASTnAoADAMP. Removes the PD static AoA offset that grows with dynamic pressure. Fixed constant (not tuned). Keep KI < KP·KD.',
  'ascent.GIMBAL_CMD_TAU_S': 'Time constant (s) of the low-pass filter on the commanded gimbal angle in HOLD / COASTnAoADAMP. Removes the 1-tick limit cycle at low airspeed; response is dt-independent. 0 = unfiltered (deadbeat) command.',
  'ascent.THROTTLE_FRAC': 'Nominal throttle fraction outside the max-Q bucket. 1.0 = full throttle.',
  'ascent.THROTTLE_ALT_LOW_KM': 'Lower edge of the max-Q throttle bucket (km AGL). Below this altitude, nominal throttle applies.',
  'ascent.THROTTLE_ALT_HIGH_KM': 'Upper edge of the max-Q throttle bucket. Above this altitude, nominal throttle resumes.',
  'ascent.THROTTLE_FRAC_LOW': 'Throttle fraction used inside the max-Q bucket (LOW .. HIGH km). Reduces thrust to limit peak aerodynamic load.',
  'ascent.MECO_TARGET_BOOSTER_FUEL_KG': 'Residual booster tank fuel (kg) wanted at the end of the shutdown spool-down. MECO fires when the projected fuel left after that spool burn reaches this value. Higher = earlier MECO and more fuel kept for boostback and landing; lower = longer ascent burn and less fuel left.',
  'ascent.GIMBAL_TARGET': 'Which engines participate in gimbal control during ascent. "center" = only the center engine (F9 legacy), "all" = every gimbal-capable engine.',
  
  // ---- separation (mission-level glue) ----
  'separation.SEPARATION_DURATION_S': 'Fixed duration (s) of the SEPARATED_AXIAL phase, counted from the phase entry (split detected). At the end of this window, the insertion block takes over — regardless of the axial gap.',
'separation.SPLIT_TIMEOUT_S': 'Maximum time (s) to wait for the split to physically appear after MECO. If the body count never grows, the mission aborts.',
'separation.LATERAL_TRIGGER_MARGIN_M': 'Margin (m) above the stage engine bell height before the booster lateral/negative-torque kick arms. Prevents firing while the bell still overlaps the interstage.',
'separation.BOOSTER_SEP_ANG_ACCEL_DEG_S2': 'Angular acceleration (deg/s2, signed) the pneumatic pushers impart to the discarded booster at separation. Fires once, when the stage engine bell has cleared the interstage. Negative = clockwise flip (nose toward the pad). Drives the booster angular velocity toward BOOSTER_SEP_TARGET_OMEGA_DEG_S, then shuts off.',
'separation.BOOSTER_SEP_TARGET_OMEGA_DEG_S': 'Angular velocity (deg/s, positive) the pusher torque drives the discarded booster to before turning off. Once |omega| reaches this, the pusher stops firing. Higher = faster flip-away; too high can overshoot and tumble the booster.',
  
  // ---- insertion (post-separation stage → payload deployed) ----
  'insertion.GIMBAL_TARGET': 'Which engines participate in gimbal control during the stage burn. "all" engages every gimbal-capable engine (single-nozzle MVac uses one, octaweb uses all).',
  'insertion.STAGE_BURN_CUTOFF_MARGIN_MPS': 'Extra Δv margin (m/s) added to the spool-loss prediction when computing the STAGE_BURN cutoff apogee. Positive = burn slightly longer, overshoot apogee. Zero = exact prediction.',
  'insertion.STAGE_BURN_AOA_KP': 'Proportional gain for the AoA-tracking PID controller. Larger = stronger restoring torque toward the target AoA.',
  'insertion.STAGE_BURN_AOA_KD': 'Derivative gain for the AoA-tracking PID controller. Damping on d(AoA)/dt (which includes the velocity-vector rotation term). For critical damping (without KI), set ≈ 2·√KP.',
  'insertion.STAGE_BURN_AOA_KI': 'Integral gain on the AoA error in STAGE_BURN. Removes the PD static offset so AoA holds the bias exactly. Fixed constant (not tuned). Keep KI < KP·KD.',
  'insertion.STAGE_BURN_AOA_BIAS_RATE_DEG_S': 'Rate limit (deg/s) of the AoA target: it starts at the AoA at STAGE_BURN entry and ramps straight to STAGE_BURN_AOA_BIAS_DEG at this rate. Fixed constant (not tuned).',
  'insertion.STAGE_BURN_AOA_BIAS_DEG': 'Non-zero target AoA offset (deg) during STAGE_BURN. Shifts the nose slightly off the velocity vector, giving thrust a small perpendicular component that changes the natural tilt-growth rate. Sign-sensitive; tune empirically.',
  'insertion.COAST_TARGET_TILT_DEG': 'Target inertial tilt (deg from local vertical) the stage holds during the circularization coast. -90 = nose retrograde (thrust along velocity).',
  'insertion.COAST_ROTATE_TOL_DEG': 'Attitude tolerance (deg) for ending a COAST_ROTATE phase. Within this band and with low ω, the rotation is considered complete.',
  'insertion.COAST_ROTATE_OMEGA_TOL': 'Angular-rate tolerance (rad/s) paired with COAST_ROTATE_TOL_DEG. Both must be satisfied for the rotation to end.',
  'insertion.COAST_ROTATE_TIMEOUT_S': 'Maximum time (s) allowed for any COAST_ROTATE phase. On timeout, the controller advances regardless.',
  'insertion.COAST_WAIT_BEFORE_APOGEE_S': 'Seconds before apogee at which COAST_WAIT ends and the second COAST_ROTATE begins. Larger = start aligning earlier.',
  'insertion.CIRC_TRIGGER_LEAD_S': 'Lead time (s) before the circularize burn start. Added on top of engine startup duration to allow spool-up before the trigger tick.',
  'insertion.CIRC_DECAY_FRAC': 'Fraction of the target orbital velocity within which the circularize throttle tapers. 0.05 = last 5% of velocity is burned at reduced throttle.',
  'insertion.CIRC_ATT_KP': 'Attitude-hold proportional gain used during coast and circularize. Tightens attitude to the coast target tilt.',
  'insertion.CIRC_ATT_KD': 'Attitude-hold derivative gain. Damps angular rate during holds.',
  'insertion.COAST_HOLD_ATT_KP': 'Proportional gain on inertial-attitude error during COAST_HOLD and COAST_HOLD_2 (the coast phases before CIRCULARIZE and payload deploy). Higher = tighter tracking of the live apside direction. Separate from CIRC_ATT_KP so the long coasts can be tuned independently of the short burns.',
  'insertion.COAST_HOLD_ATT_KD': 'Derivative gain (rate damping) on inertial-attitude error during the coast-hold phases. tau = KD/KP. Typical value >= KP gives a settled attitude in ~3*tau seconds (a few seconds at ~1 s tau).',
  'insertion.COAST_HOLD_ATT_KI': 'Integral gain on inertial-attitude error during the coast-hold phases. Eliminates the steady-state lag PD leaves when the target apside direction drifts (~0.066 deg/s in LEO). Integrator is armed fresh on each HOLD entry (no windup from the preceding ROTATE), gated to |err| < 0.5 deg, and clamped.',
  'insertion.COAST_BURN_MULTIPLIER': 'Safety multiplier applied to the computed ideal coast burn time. Larger = start aligning / planning earlier.',
  'insertion.TARGET_APSIDE1_ALT_KM': 'First of two target apsides (km ASL). The insertion block internally sorts them: apogee = max(apside1, apside2), perigee = min(apside1, apside2). Equal values → circular target. Different values → elliptical target (higher = apo, lower = peri).',
  'insertion.TARGET_APSIDE2_ALT_KM': 'Second of two target apsides (km ASL). See TARGET_APSIDE1_ALT_KM. Drives STAGE_BURN apogee cutoff, RCS_BOOST apogee trim, and the CIRCULARIZE / COAST_HOLD_2 target velocity (vis-viva at apogee of the resulting ellipse).',
  'insertion.PAYLOAD_CLEAR_DIST_M': 'Minimum separation distance (m) between stage and payload body for the payload to count as "cleared" and end the insertion block.',
  'insertion.PAYLOAD_CONFIRM_TIMEOUT_S': 'Fail-safe: if the payload never confirms as cleared, the insertion block ends after this many seconds regardless.',
  'insertion.COAST_HOLD_2_TRIM_TOL_MPS': 'Convergence tolerance (m/s) for the COAST_HOLD_2 axial deltaV trim. Once |gap - eject_kick| falls below this, axial RCS firing stops. Smaller = tighter final orbit, but more RCS chatter at the boundary.',
  'insertion.COAST_HOLD_2_TRIM_FAR_MPS': 'Error (m/s) at which the COAST_HOLD_2 axial trim uses full RCS duty. Duty scales as min(1, |dvError| / FAR). Smaller = more aggressive at small errors (faster convergence, overshoot risk).',
  
  // ---- fairing (mission-level glue) ----
  'fairing.HAS_FAIRING': 'Whether the stack carries a payload fairing. When false, fairing auto-open is skipped entirely.',
  'fairing.FAIRING_OPEN_ALT_KM': 'Altitude (km AGL) at which the fairing auto-splits. Runs phase-independently once the split is detected.',
  'fairing.FAIRING_OPEN_ENABLED': 'Master toggle for fairing auto-open. Set false to fly without fairing separation.',
  
  // ---- done dwell (mission-level glue) ----
  'done.SUICIDE_DELAY_AFTER_DEPLOY_S': 'Dwell time (s) between payload deploy and the start of the deorbit sequence. Counted from the deploy command tick. Long dwells (hundreds of seconds) park the stage in orbit before deorbit.',
  'done.CIRC_ATT_KP': 'Attitude-hold proportional gain used during the done dwell. Duplicate of insertion.CIRC_ATT_KP, held separately so the dwell can be tuned independently.',
  'done.CIRC_ATT_KD': 'Attitude-hold derivative gain during the done dwell. Duplicate of insertion.CIRC_ATT_KD.',
  'done.DEORBIT_ENABLED': 'Master toggle for the deorbit sequence. When false, mission ends at payload deploy and the suicide block is never dispatched.',
  'done.PAYLOAD_DEPLOY_OPEN_DELAY_S': 'Seconds between the payload deploy command (actual release + kick) and the open command that unfolds the satellite panels and dish. Visual animation only - no physics effect. Fires exactly once per mission.',
  
  // ---- suicide (generic retrograde-deorbit block) ----
  'suicide.SUICIDE_ROTATE_TOL_DEG': 'Attitude tolerance (deg) for the retrograde alignment at the start of the suicide block. Within this band and with low ω, the rotation completes.',
  'suicide.SUICIDE_ROTATE_OMEGA_TOL': 'Angular-rate tolerance (rad/s) paired with SUICIDE_ROTATE_TOL_DEG.',
  'suicide.SUICIDE_ROTATE_TIMEOUT_S': 'Maximum time (s) for the initial retrograde rotation. On timeout, the burn starts regardless.',
  'suicide.SUICIDE_ATT_KP': 'Proportional gain for attitude tracking during the burn and coast. Larger = tighter attitude hold against disturbances.',
  'suicide.SUICIDE_ATT_KD': 'Derivative gain for the same controller. Damps oscillation; too small causes wobble, too large causes sluggish response.',
  'suicide.SUICIDE_PREDICT_DT_S': 'Time step (s) for the leapfrog ballistic impact predictor. Smaller = more accurate but slower.',
  'suicide.SUICIDE_PREDICT_HORIZON_S': 'Maximum prediction horizon (s). If impact is not found within this window, the predictor returns null and the burn continues.',
  'suicide.SUICIDE_BURN_MAX_S': 'Safety cap on total burn duration (s). If the burn runs past this, it cuts off and coasts.',
  'suicide.SUICIDE_BURN_COARSE_MARGIN_DEG': 'Earth-fixed angular margin (deg) before the target resting-area meridian at which the burn cuts off. Larger = earlier cutoff, more coast, RCS trim has more work.',
  'suicide.SUICIDE_TRIM_TOL_DEG': 'Impact-angle convergence tolerance (deg) for the RCS trim. When |dLambda| falls below this, trim ends and the block is done.',
  'suicide.SUICIDE_TRIM_FAR_DEG': 'Impact-angle error (deg) at which the trim uses full duty. Errors smaller than this scale the duty proportionally.',
  'suicide.SUICIDE_TRIM_MIN_DUTY': 'Minimum RCS trim duty. Prevents the trim from chattering around the target when the error is tiny.',
  'suicide.SUICIDE_TRIM_MAX_S': 'Maximum duration (s) for the RCS trim after the burn. On timeout, trim ends regardless of convergence.',
  },
  
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
    'SUICIDE_TRIM_FAR_DEG':
      'Impact-angle error (deg) at which the trim uses full duty. Errors smaller than this scale the duty proportionally.',
    'SUICIDE_TRIM_MIN_DUTY':
      'Minimum RCS trim duty. Prevents the trim from chattering around the target when the error is tiny.',
    'SUICIDE_TRIM_MAX_S':
      'Maximum duration (s) for the RCS trim after the burn. On timeout, trim ends regardless of convergence.',
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