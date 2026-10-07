# tuner/IDEAS.md — New ideas from the user, not yet in the code

## Idea 1: Ascent + bias are jointly one actor

Not two tunables. Jointly define post-RCS-boost eccentricity. Must be
searched as a 2D surface, not as two separate 1D scans.

## Idea 2: Eccentricity range, not target

Bearable range (E_min, E_max). Operation target is near E_max (fastest
profile without exceeding bearable). Below E_min = time waste. Above
E_max = mission fail.

## Idea 3: Non-monotone boundary shape

Outer region (E > E_max): high A ↔ low bias (fast rotation).
Inner region (E < E_max): high A ↔ high bias (slow rotation).
Boundary flips. Must handle this in the search algorithm.

## Idea 4: Eccentricity measured at COAST_ROTATE end

Last tick before COAST_WAIT. Predictable, single point.

## Idea 5: vr must go negative for 4s target

Confirmed empirically. 4s is unachievable with strict vrEnd >= 0.
Manual best already has vrMin -0.38. Practical margin is 6-7s.
The config's circVrAtEndMinMps=0.04 is currently enforcing this.

## Idea 6: Time weight down, orbit error weight up

User realised time is easy to reduce by making the profile gentle, but
that trades against orbit accuracy. So orbit accuracy is what really
matters.

## Idea 7: Remove stage_burn_aoa_margin from tunables

Lock at 0.0001 (its hardware accuracy). Not interesting for tuning.

## Idea 8: stage_burn_aoa_bias to 4 decimal places

Finer granularity for the joint (A, bias) search.

## Idea 9: Checkpoint reuse for circ lead scan

Eccentricity at COAST_ROTATE end is unaffected by circ lead. So a
checkpoint at COAST_ROTATE entry (or SEPARATED_AXIAL entry) can be
reused across many circ lead values, saving ~400s per eval (590s full
→ ~110s checkpoint-based). 40x speedup potential.

User's specific phrasing: "let the sim reach COAST_ROTATE end at a
given (A, bias); from that state, run multiple circ lead values without
re-running from t=0".

## Idea 10: Guided search beats blind CMA-ES

The user has physics knowledge that CMA-ES cannot see. Specifically:
  - Priority: minimise A first, then adjust bias
  - Boundary-awareness: target the E_max edge, not the band centre
  - Hybrid bisection step sizes (±0.5, ±0.1, ±0.05, ±0.01 for bias;
    ±1, ±0.5, ±0.1, ±0.05, ±0.01 for circ lead)
  - When bias hits extreme, change A instead

Question: keep CMA-ES with priors injected, or build guided search
directly?

## Idea 11: MECO outer loop driven by residual fuel

Not "tune MECO as a tunable". MECO is a mission parameter. The
post-deploy residual fuel is the signal: if residual too high, MECO up;
if mission fails, MECO down. Repeat until residual hits target.

## Idea 12: The manual flow to automate

  1. Start with MECO baseline.
  2. Inner: (A, bias) search for bearable eccentricity near E_max.
  3. Fix (A, bias), tune circ lead with two-phase strategy.
  4. Full mission check → post-deploy residual fuel.
  5. Adjust MECO → repeat 1-4.
  6. When residual hits target → fine tune + score for best combo.

Step sizes: A ±0.01 (gimbal push). Bias hybrid bisection. Circ lead
hybrid bisection.

## Idea 13: Stop rule for circ lead tuning

Phase 1: minimise margin without negative vr → stuck at ~6-7s.
Phase 2: allow negative vr → keep reducing.
Phase 3: stop when margin = 4-5s.

## Idea 14: Two MECO reference points exist already

MECO 50000 and MECO 55000 manually tuned. Use as warm-start points
and to validate the guided search against human results.

  | Constant           | MECO=50000 | MECO=55000 |
  |--------------------|------------|------------|
  | PUSH_MAX_GIMBAL    | 0.62       | (n/a)      |
  | CIRC_TRIGGER_LEAD  | 5.65       | 4.46       |
  | STAGE_BURN_AOA_BIAS| 0.78       | 1.16       |

## Idea 15: Circuit lead trade-off

Large circ lead = burn starts earlier = margin high at burn end = safe
but slower deploy. Small circ lead = burn starts late = margin small
= fast but risky (vr goes negative, potential fail).

The band between feasible and infeasible is where the optimum sits.